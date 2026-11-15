// WebRTC transport and relay client. Platform objects (WebSocket, RTCPeerConnection, HTTP) are injected
// so this runs unchanged on Electron, the iOS WebView and in Node tests. Wire formats: docs/protocol.md.
import { decrypt, encrypt, fromBase64Url, signRequest, toBase64Url } from './crypto';
import type { SyncEngine } from './sync';
import type { Channel, SyncMsg } from './types';

// ---------- binary packing (shared with mailbox.ts) ----------

const te = new TextEncoder();
const td = new TextDecoder();

/** `u32 BE header length || UTF-8 JSON header || body`. */
export function pack(header: unknown, body: Uint8Array[] = []): Uint8Array {
	const h = te.encode(JSON.stringify(header));
	const out = new Uint8Array(4 + h.length + body.reduce((n, b) => n + b.length, 0));
	new DataView(out.buffer).setUint32(0, h.length);
	out.set(h, 4);
	let o = 4 + h.length;
	for (const b of body) {
		out.set(b, o);
		o += b.length;
	}
	return out;
}

/** Throws on malformed input. */
export function unpack<T>(bytes: Uint8Array): { header: T; body: Uint8Array } {
	if (bytes.length < 4) throw new Error('short frame');
	const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
	if (4 + n > bytes.length) throw new Error('bad header length');
	return { header: JSON.parse(td.decode(bytes.subarray(4, 4 + n))) as T, body: bytes.subarray(4 + n) };
}

// ---------- data channel framing ----------

export const MAX_FRAME = 15_360;

/** One SyncMsg as one byte string: a blob's data goes in the body, everything else in the header. */
export function encodeMsg(m: SyncMsg): Uint8Array {
	return m.t === 'blob' ? pack({ t: 'blob', hash: m.hash }, [m.data]) : pack(m);
}

export function decodeMsg(bytes: Uint8Array): SyncMsg {
	const { header, body } = unpack<SyncMsg>(bytes);
	if (header.t === 'blob') return { t: 'blob', hash: header.hash, data: body.slice() };
	return header;
}

/** Frames of at most MAX_FRAME bytes: `flag byte (1 = more follow, 0 = last) || payload`. Views, no copy. */
export function toFrames(bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
	const step = MAX_FRAME - 1;
	const frames: Uint8Array<ArrayBuffer>[] = [];
	for (let o = 0; o === 0 || o < bytes.length; o += step) {
		const part = bytes.subarray(o, o + step);
		const f = new Uint8Array(1 + part.length);
		f[0] = o + step < bytes.length ? 1 : 0;
		f.set(part, 1);
		frames.push(f);
	}
	return frames;
}

/** Reassembles frames from an ordered channel; returns a complete message or null while more are due. */
export class Reassembler {
	private parts: Uint8Array[] = [];
	push(frame: Uint8Array): Uint8Array | null {
		if (!frame.length) throw new Error('empty frame');
		this.parts.push(frame.subarray(1));
		if (frame[0] === 1) return null;
		const parts = this.parts;
		this.parts = [];
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let o = 0;
		for (const p of parts) {
			out.set(p, o);
			o += p.length;
		}
		return out;
	}
}

export type DataChannelLike = Pick<
	RTCDataChannel,
	'send' | 'close' | 'readyState' | 'bufferedAmount' | 'bufferedAmountLowThreshold' | 'binaryType' | 'onopen' | 'onclose' | 'onmessage' | 'addEventListener' | 'removeEventListener'
>;

/** Pauses above HIGH_WATER until the channel drains to LOW_WATER, so a 100 MB blob never sits in the buffer at once. */
export const HIGH_WATER = 1 << 20;
export const LOW_WATER = 256 << 10;

/** A `Channel` over an RTCDataChannel: framing, reassembly and backpressure. */
export class DataChannelPipe implements Channel {
	onmessage: ((msg: SyncMsg) => void) | null = null;
	onclose: (() => void) | null = null;
	private sending: Promise<void> = Promise.resolve();
	private rx = new Reassembler();
	private closed = false;

	constructor(private dc: DataChannelLike) {
		dc.binaryType = 'arraybuffer';
		dc.bufferedAmountLowThreshold = LOW_WATER;
		dc.onmessage = (ev) => {
			try {
				const whole = this.rx.push(new Uint8Array(ev.data as ArrayBuffer));
				if (whole) this.onmessage?.(decodeMsg(whole));
			} catch {
				this.dc.close(); // a malformed frame means the stream is out of step; start over
			}
		};
		dc.onclose = () => this.close();
	}

	private close() {
		if (this.closed) return;
		this.closed = true;
		this.onclose?.();
	}

	/** Frames of one message are never interleaved with another's. */
	send(msg: SyncMsg): Promise<void> {
		const p = this.sending.then(async () => {
			for (const f of toFrames(encodeMsg(msg))) {
				if (this.dc.bufferedAmount > HIGH_WATER) await this.drained();
				if (this.dc.readyState !== 'open') throw new Error('channel closed');
				this.dc.send(f);
			}
		});
		this.sending = p.catch(() => undefined);
		return p;
	}

	private drained(): Promise<void> {
		return new Promise((resolve, reject) => {
			const done = () => {
				this.dc.removeEventListener('bufferedamountlow', done);
				this.dc.removeEventListener('close', gone);
				resolve();
			};
			const gone = () => {
				this.dc.removeEventListener('bufferedamountlow', done);
				reject(new Error('channel closed'));
			};
			this.dc.addEventListener('bufferedamountlow', done);
			this.dc.addEventListener('close', gone, { once: true });
		});
	}
}

// ---------- relay client ----------

export interface HttpRequest {
	url: string;
	method: string;
	body?: ArrayBuffer;
	headers?: Record<string, string>;
}
/** Shaped like Obsidian's `requestUrl` called with `throw: false`: non-2xx resolves. */
export type Http = (req: HttpRequest) => Promise<{ status: number; arrayBuffer: ArrayBuffer; json: unknown }>;

export type WebSocketLike = Pick<WebSocket, 'send' | 'close' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'>;
export type WebSocketCtor = new (url: string) => WebSocketLike;

export type RelayErrorCode = 'unauthorized' | 'pending' | 'revoked' | 'room_full' | 'too_many_pending' | 'quota' | 'http';

/** A refusal the UI can show: `code` tells "waiting for approval" from "revoked" and so on. */
export class RelayError extends Error {
	constructor(
		readonly code: RelayErrorCode,
		readonly status: number,
		/** The relay's `error` string, when it sent one. */
		readonly detail?: string,
	) {
		super(`relay: ${code} (${status})`);
	}
}

export interface RelayOptions {
	/** https://… of the relay Worker. */
	baseUrl: string;
	roomId: string;
	/** Raw P-256 public key, base64url (generateIdentity().publicKey). */
	publicKey: string;
	privateKey: CryptoKey;
	http: Http;
	WebSocket: WebSocketCtor;
	now?: () => number;
}

export class RelayClient {
	constructor(private o: RelayOptions) {}

	private async url(method: string, pathname: string, ws = false): Promise<string> {
		const ts = (this.o.now ?? Date.now)();
		const sig = await signRequest(this.o.privateKey, method, pathname, ts);
		const base = ws ? this.o.baseUrl.replace(/^http/, 'ws') : this.o.baseUrl;
		const q = new URLSearchParams({ peer: this.o.publicKey, ts: String(ts), sig });
		return `${base.replace(/\/$/, '')}${pathname}?${q}`;
	}

	private async req(method: string, pathname: string, body?: Uint8Array) {
		const res = await this.o.http({
			url: await this.url(method, pathname),
			method,
			...(body ? { body: body.slice().buffer, headers: { 'Content-Type': 'application/octet-stream' } } : {}),
		});
		if (res.status >= 200 && res.status < 300) return res;
		let error: unknown;
		try {
			error = (res.json as { error?: unknown } | null)?.error;
		} catch {
			// body was not JSON
		}
		const code: RelayErrorCode =
			res.status === 401
				? 'unauthorized'
				: res.status === 413
					? 'quota'
					: (res.status === 403 || res.status === 429) && typeof error === 'string' && ['pending', 'revoked', 'room_full', 'too_many_pending'].includes(error)
						? (error as RelayErrorCode)
						: 'http';
		throw new RelayError(code, res.status, typeof error === 'string' ? error : undefined);
	}

	/** Active peers of the room. Also the cheapest way to learn our own status before opening the socket. */
	async peers(): Promise<{ peerId: string; online: boolean }[]> {
		return ((await this.req('GET', `/room/${this.o.roomId}/peers`)).json as { peers: { peerId: string; online: boolean }[] }).peers;
	}

	/** TURN credentials (valid 24 h) for this room, or null when the relay has TURN switched off. */
	async iceServers(): Promise<RTCIceServer[] | null> {
		try {
			const res = await this.req('POST', `/turn/${this.o.roomId}`);
			const ice = (res.json as { iceServers?: unknown } | null)?.iceServers;
			if (!Array.isArray(ice)) throw new RelayError('http', res.status);
			return ice as RTCIceServer[];
		} catch (e) {
			if (e instanceof RelayError && e.status === 404 && e.detail === 'turn_disabled') return null;
			throw e;
		}
	}

	async openRoom(): Promise<WebSocketLike> {
		return new this.o.WebSocket(await this.url('GET', `/room/${this.o.roomId}`, true));
	}

	async putBundle(data: Uint8Array): Promise<string> {
		return ((await this.req('PUT', `/mailbox/${this.o.roomId}`, data)).json as { id: string }).id;
	}

	async listBundles(): Promise<{ id: string; size: number; createdAt: number }[]> {
		return ((await this.req('GET', `/mailbox/${this.o.roomId}`)).json as { bundles: { id: string; size: number; createdAt: number }[] }).bundles;
	}

	async getBundle(id: string): Promise<Uint8Array> {
		return new Uint8Array((await this.req('GET', `/mailbox/${this.o.roomId}/${id}`)).arrayBuffer);
	}

	async ackBundle(id: string): Promise<void> {
		await this.req('DELETE', `/mailbox/${this.o.roomId}/${id}`);
	}
}

// ---------- signalling ----------

export interface Signal {
	from: string;
	to: string;
	ts: number;
	/** The initiator's attempt id; answers and candidates for another attempt are ignored. */
	sid: string;
	kind: 'offer' | 'answer' | 'ice';
	sdp?: string;
	candidate?: RTCIceCandidateInit;
}

const SIGNAL_MAX_AGE = 5 * 60 * 1000;

export async function sealSignal(key: CryptoKey, s: Signal): Promise<string> {
	return toBase64Url(await encrypt(key, te.encode(JSON.stringify(s))));
}

/**
 * Null unless it decrypts and names the relay's `from` as sender and us as recipient, within 5 minutes:
 * the relay can neither forge, alter, redirect nor (beyond that window) replay a signal.
 */
export async function openSignal(key: CryptoKey, data: string, from: string, self: string, now = Date.now()): Promise<Signal | null> {
	try {
		const s = JSON.parse(td.decode(await decrypt(key, fromBase64Url(data)))) as Signal;
		if (s.from !== from || s.to !== self || !(Math.abs(now - s.ts) <= SIGNAL_MAX_AGE)) return null;
		return s;
	} catch {
		return null;
	}
}

// ---------- connection manager ----------

type PeerConnectionLike = Pick<
	RTCPeerConnection,
	| 'createDataChannel'
	| 'createOffer'
	| 'createAnswer'
	| 'setLocalDescription'
	| 'setRemoteDescription'
	| 'addIceCandidate'
	| 'close'
	| 'connectionState'
	| 'onicecandidate'
	| 'ondatachannel'
	| 'onconnectionstatechange'
>;
export type PeerConnectionCtor = new (config: RTCConfiguration) => PeerConnectionLike;

export type LinkState = 'connecting' | 'syncing' | 'synced';
export type RelayState = 'idle' | 'connecting' | 'online' | 'offline' | RelayErrorCode;

export interface PeerManagerOptions {
	relay: RelayClient;
	signalKey: CryptoKey;
	selfId: string;
	engine: SyncEngine;
	RTCPeerConnection: PeerConnectionCtor;
	iceServers?: RTCIceServer[];
	/** Relay connection state, for the status UI. */
	onState?: (s: RelayState) => void;
	/** A peer's link changed; 'gone' when it was dropped. */
	onPeer?: (peerId: string, s: LinkState | 'gone') => void;
}

interface Link {
	sid: string;
	pc: PeerConnectionLike;
	pipe: DataChannelPipe | null;
	state: LinkState;
	/** Our ICE candidates held until the offer/answer that precedes them has been sent. */
	outbox: RTCIceCandidateInit[] | null;
	dc: DataChannelLike | null;
	/** When the link was created, and since when its connection has been 'disconnected'. */
	since: number;
	disconnectedAt: number | null;
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const TURN_REUSE = 23 * 3600 * 1000; // credentials live 24 h; refresh an hour early
const TURN_RECHECK = 3600 * 1000; // with TURN off, ask again hourly in case an admin turns it on

const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 60_000;
// Links are also checked on a timer: a locally closed connection fires no event (WebRTC spec), and a
// connection that never gets a candidate pair stays 'new' forever instead of failing.
export const LINK_CHECK = 5000;
// Measured in Chromium: the data channel opens 20-80 ms after the offer on one host. ICE over STUN/TURN on
// real networks usually takes seconds, so 20 s is a wide margin; a link that never connects is retried with backoff.
export const CONNECT_TIMEOUT = 20_000;
// Chromium turns 'disconnected' into 'failed' ~10 s later by itself (measured); this is a backstop for engines that do not.
export const DISCONNECT_GRACE = 30_000;

export class PeerManager {
	private links_ = new Map<string, Link>();
	private present = new Set<string>(); // peers the relay says are in the room
	private ws: WebSocketLike | null = null;
	private running = false;
	private backoff = BACKOFF_MIN;
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private signals: Promise<void> = Promise.resolve();
	private starting = new Set<string>(); // initiations waiting for ICE servers
	private ice: { servers: RTCIceServer[]; until: number } | null = null;
	private iceFetch: Promise<RTCIceServer[]> | null = null;
	private relinkDelay = new Map<string, number>(); // per-peer backoff for rebuilding a lost link

	/** Takes over engine.onRevisions and engine.onSession (any handler already set there is still called). */
	constructor(private o: PeerManagerOptions) {
		const { engine } = o;
		const prevRevs = engine.onRevisions;
		engine.onRevisions = (from) => {
			prevRevs?.(from);
			// Forward: every other open link gets a round, so peers that cannot reach each other still converge.
			for (const [p, l] of this.links_) if (l.pipe && l.pipe !== from) this.syncLink(p, l);
		};
		const prevSession = engine.onSession;
		engine.onSession = (ch, state) => {
			prevSession?.(ch, state);
			for (const [p, l] of this.links_) {
				if (l.pipe !== ch || l.state === state) continue;
				l.state = state;
				this.o.onPeer?.(p, state);
			}
		};
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		void this.connectRelay();
		this.later(LINK_CHECK, () => this.checkLinks());
	}

	stop(): void {
		this.running = false;
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
		const ws = this.ws;
		this.ws = null;
		ws?.close();
		for (const p of [...this.links_.keys()]) this.drop(p);
		this.present.clear();
		this.o.onState?.('idle');
	}

	/** Current links, for the mailbox (who is reachable right now) and the UI. */
	links(): ReadonlyMap<string, LinkState> {
		// A closed connection is not a link even before checkLinks notices: the mailbox must not count on it.
		return new Map([...this.links_].filter(([, l]) => l.pc.connectionState !== 'closed' && l.pc.connectionState !== 'failed').map(([p, l]) => [p, l.state]));
	}

	/** Starts a new sync round on every open link, e.g. after a local change. */
	syncNow(): void {
		for (const [p, l] of this.links_) if (l.pipe) this.syncLink(p, l);
	}

	private later(ms: number, fn: () => void) {
		const t = setTimeout(() => {
			this.timers.delete(t);
			if (this.running) fn();
		}, ms);
		this.timers.add(t);
	}

	private retryRelay() {
		this.later(this.backoff, () => void this.connectRelay());
		this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
	}

	private async connectRelay() {
		this.o.onState?.('connecting');
		let ws: WebSocketLike;
		try {
			// A browser WebSocket hides the HTTP status of a refused upgrade; this request exposes it.
			await this.o.relay.peers();
			ws = await this.o.relay.openRoom();
		} catch (e) {
			if (!this.running) return;
			this.o.onState?.(e instanceof RelayError ? e.code : 'offline');
			// revoked / unauthorized will not fix themselves, but a retry is cheap and recovers from clock skew.
			this.retryRelay();
			return;
		}
		if (!this.running) return ws.close();
		this.ws = ws;
		ws.onopen = () => {
			this.backoff = BACKOFF_MIN;
			this.o.onState?.('online');
		};
		ws.onmessage = (ev) => {
			let m: { t?: string; peers?: string[]; peer?: string; from?: string; data?: string };
			try {
				m = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (m.t === 'peers') for (const p of m.peers ?? []) this.seen(p);
			else if (m.t === 'join' && m.peer) this.seen(m.peer);
			else if (m.t === 'leave' && m.peer) {
				this.present.delete(m.peer);
				this.drop(m.peer);
			} else if (m.t === 'signal' && m.from && m.data) {
				const { from, data } = m;
				this.signals = this.signals.then(() => this.onSignal(from, data)).catch(() => undefined);
			}
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			this.present.clear();
			// Open data channels do not need the relay; only new links do.
			if (this.running) {
				this.o.onState?.('offline');
				this.retryRelay();
			}
		};
	}

	private seen(p: string) {
		if (p === this.o.selfId) return;
		this.present.add(p);
		if (this.o.selfId < p && !this.links_.has(p) && !this.starting.has(p)) {
			this.starting.add(p);
			void this.initiate(p)
				.catch(() => this.drop(p))
				.finally(() => this.starting.delete(p));
		}
	}

	private send(s: Omit<Signal, 'from' | 'ts'>) {
		const ws = this.ws;
		if (!ws) return;
		void sealSignal(this.o.signalKey, { ...s, from: this.o.selfId, ts: Date.now() }).then((data) => {
			// The relay closes the socket on frames over 16 KB; drop the signal instead.
			const frame = JSON.stringify({ to: s.to, data });
			if (frame.length <= 16 * 1024) ws.send(frame);
		});
	}

	/** TURN from the relay when it has it, cached until shortly before expiry; the configured STUN otherwise. */
	private iceServers(): Promise<RTCIceServer[]> {
		const fallback = this.o.iceServers ?? DEFAULT_ICE;
		if (this.ice && Date.now() < this.ice.until) return Promise.resolve(this.ice.servers);
		this.iceFetch ??= this.o.relay
			.iceServers()
			.then(
				(turn) => {
					this.ice = turn ? { servers: turn, until: Date.now() + TURN_REUSE } : { servers: fallback, until: Date.now() + TURN_RECHECK };
					return this.ice.servers;
				},
				() => fallback, // not cached: the next link asks again
			)
			.finally(() => (this.iceFetch = null));
		return this.iceFetch;
	}

	private newLink(p: string, sid: string, iceServers: RTCIceServer[]): Link {
		const pc = new this.o.RTCPeerConnection({ iceServers });
		const link: Link = { sid, pc, pipe: null, state: 'connecting', outbox: [], dc: null, since: Date.now(), disconnectedAt: null };
		pc.onicecandidate = (ev) => {
			if (!ev.candidate) return;
			const c = ev.candidate.toJSON();
			if (link.outbox) link.outbox.push(c);
			else this.send({ to: p, sid, kind: 'ice', candidate: c });
		};
		pc.onconnectionstatechange = () => {
			if (this.links_.get(p) !== link) return;
			const s = pc.connectionState;
			link.disconnectedAt = s === 'disconnected' ? (link.disconnectedAt ?? Date.now()) : null;
			if (s === 'failed' || s === 'closed') this.lost(p, link);
		};
		this.links_.set(p, link);
		this.o.onPeer?.(p, 'connecting');
		return link;
	}

	private flush(p: string, link: Link) {
		const queued = link.outbox ?? [];
		link.outbox = null;
		for (const c of queued) this.send({ to: p, sid: link.sid, kind: 'ice', candidate: c });
	}

	private wire(p: string, link: Link, dc: DataChannelLike) {
		link.dc = dc;
		const open = () => {
			if (this.links_.get(p) !== link) return dc.close();
			this.relinkDelay.delete(p);
			link.pipe = new DataChannelPipe(dc);
			// Often the first sign of a dead link, before (or instead of) a connection state change.
			dc.addEventListener('close', () => this.lost(p, link));
			this.syncLink(p, link);
		};
		if (dc.readyState === 'open') open();
		else dc.onopen = open;
	}

	/** 'synced' comes from engine.onSession, whichever side ran the round. */
	private syncLink(p: string, link: Link) {
		if (link.state !== 'syncing') {
			link.state = 'syncing';
			this.o.onPeer?.(p, 'syncing');
		}
		this.o.engine.connect(link.pipe!).catch(() => undefined); // closing is reported through drop()
	}

	private async initiate(p: string) {
		const ice = await this.iceServers();
		if (!this.running || this.links_.has(p)) return;
		const link = this.newLink(p, toBase64Url(crypto.getRandomValues(new Uint8Array(9))), ice);
		this.wire(p, link, link.pc.createDataChannel('sync', { ordered: true }));
		const offer = await link.pc.createOffer();
		await link.pc.setLocalDescription(offer);
		this.send({ to: p, sid: link.sid, kind: 'offer', sdp: offer.sdp ?? '' });
		this.flush(p, link);
	}

	private async onSignal(from: string, data: string) {
		const s = await openSignal(this.o.signalKey, data, from, this.o.selfId);
		if (!s) return;
		if (s.kind === 'offer') {
			if (!(from < this.o.selfId)) return; // only the smaller peerId offers
			const ice = await this.iceServers();
			this.drop(from);
			this.present.add(from);
			const link = this.newLink(from, s.sid, ice);
			link.pc.ondatachannel = (ev) => this.wire(from, link, ev.channel);
			try {
				await link.pc.setRemoteDescription({ type: 'offer', sdp: s.sdp ?? '' });
				const answer = await link.pc.createAnswer();
				await link.pc.setLocalDescription(answer);
				this.send({ to: from, sid: s.sid, kind: 'answer', sdp: answer.sdp ?? '' });
				this.flush(from, link);
			} catch {
				this.drop(from);
			}
			return;
		}
		const link = this.links_.get(from);
		if (!link || link.sid !== s.sid) return;
		try {
			if (s.kind === 'answer' && this.o.selfId < from) await link.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp ?? '' });
			else if (s.kind === 'ice' && s.candidate) await link.pc.addIceCandidate(s.candidate);
		} catch {
			// a bad candidate is not fatal; a bad answer ends in connectionState 'failed'
		}
	}

	/** The link died while the peer may still be in the room: drop it; the initiator builds a new one. */
	private lost(p: string, link: Link) {
		if (this.links_.get(p) !== link) return;
		this.drop(p);
		if (!(this.o.selfId < p)) return; // the other side offers again
		const ms = this.relinkDelay.get(p) ?? BACKOFF_MIN;
		this.relinkDelay.set(p, Math.min(ms * 2, BACKOFF_MAX));
		this.later(ms, () => this.present.has(p) && this.seen(p));
	}

	/** Catches what no event reports: a locally closed connection, one that never connects, a lasting 'disconnected'. */
	private checkLinks() {
		const now = Date.now();
		for (const [p, l] of [...this.links_]) {
			const s = l.pc.connectionState;
			if (
				s === 'closed' ||
				s === 'failed' ||
				l.dc?.readyState === 'closed' ||
				(!l.pipe && now - l.since > CONNECT_TIMEOUT) ||
				(l.disconnectedAt !== null && now - l.disconnectedAt > DISCONNECT_GRACE)
			)
				this.lost(p, l);
		}
		this.later(LINK_CHECK, () => this.checkLinks());
	}

	private drop(p: string) {
		const link = this.links_.get(p);
		if (!link) return;
		this.links_.delete(p);
		link.pc.close();
		this.o.onPeer?.(p, 'gone');
	}
}
