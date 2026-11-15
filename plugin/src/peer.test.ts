import { afterEach, describe, expect, test, vi } from 'vitest';
import { deriveKeys, fromBase64Url, generateIdentity, generateVaultKey, sha256Hex } from './crypto';
import {
	CONNECT_TIMEOUT,
	DISCONNECT_GRACE,
	type DataChannelLike,
	DataChannelPipe,
	decodeMsg,
	encodeMsg,
	HIGH_WATER,
	LINK_CHECK,
	type LinkState,
	MAX_FRAME,
	type PeerConnectionCtor,
	PeerManager,
	Reassembler,
	RelayClient,
	openSignal,
	sealSignal,
	type Signal,
	toFrames,
	type WebSocketCtor,
} from './peer';
import { dec, expectSame, node, put } from './sync.testkit';
import type { Revision, SyncMsg } from './types';

const rev: Revision = { id: 'a:1', path: 'x/ü.md', blobHash: 'ab'.repeat(32), size: 3, mtime: 5, deviceId: 'a', seq: 1, parents: [], deleted: false, renamedFrom: 'y.md' };

describe('framing', () => {
	const big = new Uint8Array(100_000).map((_, i) => i % 251);
	const msgs: SyncMsg[] = [
		{ t: 'vv', vv: { a: 3, b: 1 } },
		{ t: 'revs', revs: [rev, { ...rev, id: 'a:2', seq: 2, blobHash: null, deleted: true }] },
		{ t: 'want', hashes: ['00', 'ff'] },
		{ t: 'blob', hash: 'h', data: new Uint8Array([1, 2, 3]) },
		{ t: 'blob', hash: 'empty', data: new Uint8Array(0) },
		{ t: 'blob', hash: 'big', data: big },
		{ t: 'done' },
	];

	test.each(msgs.map((m) => [m.t, m]))('%s round-trips through frames', (_t, m) => {
		const frames = toFrames(encodeMsg(m));
		const rx = new Reassembler();
		const out = frames.map((f) => rx.push(f));
		expect(out.slice(0, -1).every((x) => x === null)).toBe(true);
		expect(decodeMsg(out[out.length - 1]!)).toEqual(m);
	});

	test('a large message is split into frames of at most MAX_FRAME bytes', () => {
		const frames = toFrames(encodeMsg({ t: 'blob', hash: 'big', data: big }));
		expect(frames.length).toBe(Math.ceil((big.length + 4 + JSON.stringify({ t: 'blob', hash: 'big' }).length) / (MAX_FRAME - 1)));
		for (const f of frames) expect(f.length).toBeLessThanOrEqual(MAX_FRAME);
	});

	test('several messages back to back reassemble in order', () => {
		const rx = new Reassembler();
		const got = msgs.flatMap((m) => toFrames(encodeMsg(m))).flatMap((f) => {
			const w = rx.push(f);
			return w ? [decodeMsg(w)] : [];
		});
		expect(got).toEqual(msgs);
	});
});

/** A data channel whose two ends deliver to each other; `auto` false holds frames until drain(). */
class FakeDC extends EventTarget {
	readyState: RTCDataChannelState = 'connecting';
	bufferedAmount = 0;
	bufferedAmountLowThreshold = 0;
	binaryType: BinaryType = 'blob';
	onopen: ((ev: Event) => void) | null = null;
	onclose: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	peer: FakeDC | null = null;
	queue: Uint8Array[] = [];
	frames = 0;
	constructor(public auto = true) {
		super();
	}
	send(d: Uint8Array) {
		if (this.readyState !== 'open') throw new Error('InvalidStateError');
		this.frames++;
		this.queue.push(d.slice());
		this.bufferedAmount += d.length;
		if (this.auto) queueMicrotask(() => this.drain());
	}
	drain() {
		const q = this.queue.splice(0);
		for (const d of q) this.peer?.onmessage?.({ data: d.buffer } as MessageEvent);
		const before = this.bufferedAmount;
		this.bufferedAmount = 0;
		if (q.length && before > this.bufferedAmountLowThreshold) this.dispatchEvent(new Event('bufferedamountlow'));
	}
	open() {
		this.readyState = 'open';
		this.onopen?.(new Event('open'));
	}
	close() {
		if (this.readyState === 'closed') return;
		this.readyState = 'closed';
		this.dispatchEvent(new Event('close'));
		this.onclose?.(new Event('close'));
		this.peer?.close();
	}
	static pair(auto = true): [FakeDC, FakeDC] {
		const a = new FakeDC(auto);
		const b = new FakeDC(auto);
		a.peer = b;
		b.peer = a;
		return [a, b];
	}
}
const asDC = (d: FakeDC) => d as unknown as DataChannelLike;

describe('DataChannelPipe', () => {
	test('backpressure: pauses above the high-water mark, resumes on bufferedamountlow, keeps order', async () => {
		const [x, y] = FakeDC.pair(false);
		x.readyState = y.readyState = 'open';
		const tx = new DataChannelPipe(asDC(x));
		const rx = new DataChannelPipe(asDC(y));
		const got: SyncMsg[] = [];
		rx.onmessage = (m) => got.push(m);
		const data = new Uint8Array(5 << 20).map((_, i) => i & 0xff);
		let firstDone = false;
		const first = tx.send({ t: 'blob', hash: 'h', data }).then(() => (firstDone = true));
		const second = tx.send({ t: 'done' });
		await new Promise((r) => setTimeout(r, 10));
		expect(firstDone).toBe(false);
		expect(x.bufferedAmount).toBeGreaterThan(HIGH_WATER);
		expect(x.bufferedAmount).toBeLessThanOrEqual(HIGH_WATER + MAX_FRAME); // never the whole 5 MB
		let rounds = 0;
		while (!firstDone && rounds++ < 100) {
			x.drain();
			await new Promise((r) => setTimeout(r, 0));
		}
		await first;
		await second;
		x.drain();
		expect(rounds).toBeGreaterThan(3);
		expect(got.map((m) => m.t)).toEqual(['blob', 'done']);
		expect(got[0]).toEqual({ t: 'blob', hash: 'h', data });
	});

	test('send fails once the channel is closed, and onclose fires', async () => {
		const [x] = FakeDC.pair();
		x.readyState = 'open';
		const pipe = new DataChannelPipe(asDC(x));
		const closed = vi.fn();
		pipe.onclose = closed;
		x.close();
		expect(closed).toHaveBeenCalledOnce();
		await expect(pipe.send({ t: 'done' })).rejects.toThrow('channel closed');
	});
});

describe('signalling', () => {
	const sig = (over: Partial<Signal> = {}): Signal => ({ from: 'aa', to: 'bb', ts: Date.now(), sid: 's', kind: 'offer', sdp: 'v=0', ...over });

	test('round-trips and hides the content', async () => {
		const { signalKey } = await deriveKeys(generateVaultKey());
		const data = await sealSignal(signalKey, sig());
		expect(data).not.toContain('v=0');
		expect(await openSignal(signalKey, data, 'aa', 'bb')).toMatchObject({ kind: 'offer', sdp: 'v=0' });
	});

	test('wrong sender, wrong recipient, tampering, stale or wrong key are dropped', async () => {
		const { signalKey } = await deriveKeys(generateVaultKey());
		const other = (await deriveKeys(generateVaultKey())).signalKey;
		const data = await sealSignal(signalKey, sig());
		expect(await openSignal(signalKey, data, 'cc', 'bb')).toBeNull(); // relay claims another sender
		expect(await openSignal(signalKey, data, 'aa', 'cc')).toBeNull(); // forwarded to someone else
		const raw = fromBase64Url(data);
		raw[raw.length - 1]! ^= 1;
		const { toBase64Url } = await import('./crypto');
		expect(await openSignal(signalKey, toBase64Url(raw), 'aa', 'bb')).toBeNull();
		expect(await openSignal(signalKey, await sealSignal(signalKey, sig({ ts: Date.now() - 10 * 60_000 })), 'aa', 'bb')).toBeNull();
		expect(await openSignal(other, data, 'aa', 'bb')).toBeNull();
		expect(await openSignal(signalKey, 'not base64 at all!', 'aa', 'bb')).toBeNull();
	});
});

// ---------- connection manager over a fake relay room and fake peer connections ----------

class FakeRoom {
	sockets = new Map<string, FakeWS>();
	frames: string[] = [];
	blocked = new Set<string>(); // "a|b" pairs whose signals are dropped, so they never link
	block(a: string, b: string) {
		this.blocked.add(`${a}|${b}`).add(`${b}|${a}`);
	}
	ctor(): WebSocketCtor {
		const room = this;
		return class extends FakeWS {
			constructor(url: string) {
				super(room, url);
			}
		} as unknown as WebSocketCtor;
	}
	broadcast(except: string, msg: object) {
		for (const [p, s] of this.sockets) if (p !== except) s.deliver(msg);
	}
	kick(p: string) {
		this.sockets.get(p)?.close();
	}
}

class FakeWS {
	onopen: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onclose: ((ev: CloseEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	peerId = '';
	closed = false;
	constructor(
		private room: FakeRoom,
		url: string,
	) {
		const raw = fromBase64Url(new URL(url).searchParams.get('peer')!);
		void sha256Hex(raw).then((h) => {
			this.peerId = h.slice(0, 32);
			const others = [...room.sockets.keys()];
			room.sockets.set(this.peerId, this);
			this.onopen?.(new Event('open'));
			this.deliver({ t: 'peers', peers: others });
			room.broadcast(this.peerId, { t: 'join', peer: this.peerId });
		});
	}
	deliver(msg: object) {
		if (!this.closed) setTimeout(() => !this.closed && this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent), 0);
	}
	send(text: string) {
		this.room.frames.push(text);
		const m = JSON.parse(text) as { to: string; data: string };
		if (this.room.blocked.has(`${this.peerId}|${m.to}`)) return;
		this.room.sockets.get(m.to)?.deliver({ t: 'signal', from: this.peerId, data: m.data });
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.room.sockets.delete(this.peerId);
		this.room.broadcast(this.peerId, { t: 'leave', peer: this.peerId });
		this.onclose?.({} as CloseEvent);
	}
}

/** Peer connections that "connect" once the initiator applies the answer. */
class FakePC {
	static byId = new Map<string, FakePC>();
	id = Math.random().toString(36).slice(2);
	connectionState: RTCPeerConnectionState = 'new';
	onicecandidate: ((ev: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
	ondatachannel: ((ev: { channel: FakeDC }) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	dc: FakeDC | null = null;
	offered = false;
	candidates: RTCIceCandidateInit[] = [];
	remote: FakePC | null = null;
	createdAt = Date.now();
	closedAt: number | null = null;
	constructor(
		public owner: string,
		public log: FakePC[],
		public config: RTCConfiguration,
	) {
		FakePC.byId.set(this.id, this);
		log.push(this);
	}
	createDataChannel() {
		this.dc = new FakeDC();
		return this.dc;
	}
	async createOffer() {
		this.offered = true;
		return { type: 'offer' as const, sdp: `fake:${this.id}` };
	}
	async createAnswer() {
		return { type: 'answer' as const, sdp: `fake:${this.id}` };
	}
	async setLocalDescription() {
		setTimeout(() => this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: `cand-${this.id}`, sdpMid: '0' }) } }), 0);
	}
	async setRemoteDescription(d: RTCSessionDescriptionInit) {
		this.remote = FakePC.byId.get(d.sdp!.slice(5)) ?? null;
		if (d.type !== 'answer' || !this.remote || !this.dc) return;
		const theirs = new FakeDC();
		this.dc.peer = theirs;
		theirs.peer = this.dc;
		const remote = this.remote;
		setTimeout(() => {
			this.connectionState = remote.connectionState = 'connected';
			remote.ondatachannel?.({ channel: theirs });
			this.dc!.open();
			theirs.open();
		}, 0);
	}
	async addIceCandidate(c: RTCIceCandidateInit) {
		this.candidates.push(c);
	}
	close() {
		this.connectionState = 'closed';
		this.closedAt ??= Date.now();
		this.dc?.close();
	}
}

const TURN: RTCIceServer[] = [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }];
const STUN: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** `turn` picks what POST /turn answers: off (404 turn_disabled), ok (200), upstream (502 turn_upstream). */
async function roomSetup(turn: 'off' | 'ok' | 'upstream' = 'off') {
	const room = new FakeRoom();
	const turnCalls: string[] = [];
	const { roomId, signalKey } = await deriveKeys(generateVaultKey());
	const pcs: FakePC[] = [];
	const peer = async (label: string) => {
		const id = await generateIdentity();
		const n = node(id.peerId);
		const relay = new RelayClient({
			baseUrl: 'https://relay.test',
			roomId,
			publicKey: id.publicKey,
			privateKey: id.keyPair.privateKey,
			http: async (req) => {
				const r = (status: number, json: unknown) => ({ status, json, arrayBuffer: new ArrayBuffer(0) });
				if (!new URL(req.url).pathname.startsWith('/turn/')) return r(200, { peers: [] });
				turnCalls.push(label);
				if (req.method !== 'POST') return r(404, null);
				return turn === 'ok' ? r(200, { iceServers: TURN }) : turn === 'off' ? r(404, { error: 'turn_disabled' }) : r(502, { error: 'turn_upstream' });
			},
			WebSocket: room.ctor(),
		});
		const events: [string, LinkState | 'gone'][] = [];
		const RTC = class extends FakePC {
			constructor(config: RTCConfiguration) {
				super(label, pcs, config);
			}
		} as unknown as PeerConnectionCtor;
		const mgr = new PeerManager({ relay, signalKey, selfId: id.peerId, engine: n.eng, RTCPeerConnection: RTC, onPeer: (p, s) => events.push([p, s]) });
		return { ...n, label, peerId: id.peerId, mgr, events };
	};
	return { room, pcs, peer, turnCalls };
}

type P = Awaited<ReturnType<Awaited<ReturnType<typeof roomSetup>>['peer']>>;
const settle = () => new Promise((r) => setTimeout(r, 20));
const allSynced = (ps: P[], pairs: [P, P][]) => {
	for (const [x, y] of pairs) {
		expect(x.mgr.links().get(y.peerId)).toBe('synced');
		expect(y.mgr.links().get(x.peerId)).toBe('synced');
	}
	void ps;
};

describe('PeerManager', () => {
	test('smaller peerId offers; engines converge; later changes reuse the link; leave cleans up', async () => {
		const { room, pcs, peer } = await roomSetup();
		const x = await peer('x');
		const y = await peer('y');
		const [lo, hi] = x.peerId < y.peerId ? [x, y] : [y, x];
		await put(x, 'from-x.md', 'x');
		await put(y, 'from-y.md', 'y');
		hi.mgr.start(); // the larger one is first in the room, so it hears of the other through 'join'
		await new Promise((r) => setTimeout(r, 5));
		lo.mgr.start();
		await vi.waitFor(() => {
			expect(lo.mgr.links().get(hi.peerId)).toBe('synced');
			expect(hi.mgr.links().get(lo.peerId)).toBe('synced');
		});
		await new Promise((r) => setTimeout(r, 5));
		expect(pcs.filter((p) => p.offered).map((p) => p.owner)).toEqual([lo.label]);
		expect(pcs).toHaveLength(2);
		await expectSame(x, y);
		expect(Object.keys(Object.fromEntries(x.vault.files)).sort()).toEqual(['from-x.md', 'from-y.md']);
		// Candidates were relayed and applied on both sides.
		expect(pcs.every((p) => p.candidates.length > 0)).toBe(true);
		// The relay only ever saw ciphertext.
		expect(room.frames.length).toBeGreaterThan(0);
		for (const f of room.frames) expect(f).not.toContain('fake:');

		await put(x, 'later.md', 'later');
		x.mgr.syncNow();
		await vi.waitFor(() => expect(dec(y.vault.files.get('later.md'))).toBe('later'));
		await vi.waitFor(() => expect(x.mgr.links().get(y.peerId)).toBe('synced'));
		expect(pcs).toHaveLength(2); // same connection
		await new Promise((r) => setTimeout(r, 5));
		await expectSame(x, y);

		room.kick(hi.peerId);
		await vi.waitFor(() => expect(lo.mgr.links().size).toBe(0));
		expect(lo.events[lo.events.length - 1]).toEqual([hi.peerId, 'gone']);
		expect(pcs.find((p) => p.owner === lo.label)!.connectionState).toBe('closed');
		lo.mgr.stop();
		hi.mgr.stop();
	});

	test('the larger peerId never offers, whichever side joined first', async () => {
		const { room, pcs, peer } = await roomSetup();
		const x = await peer('x');
		const y = await peer('y');
		const [lo, hi] = x.peerId < y.peerId ? [x, y] : [y, x];
		lo.mgr.start();
		await new Promise((r) => setTimeout(r, 5));
		hi.mgr.start();
		await vi.waitFor(() => expect(hi.mgr.links().get(lo.peerId)).toBe('synced'));
		expect(pcs.filter((p) => p.offered).every((p) => p.owner === lo.label)).toBe(true);
		expect(room.sockets.size).toBe(2);
		lo.mgr.stop();
		hi.mgr.stop();
	});
	test('forwards over A between B and C, which cannot link; no syncNow needed', async () => {
		const { room, peer } = await roomSetup();
		const a = await peer('a');
		const b = await peer('b');
		const c = await peer('c');
		room.block(b.peerId, c.peerId);
		for (const n of [a, b, c]) n.mgr.start();
		await vi.waitFor(() => allSynced([a, b, c], [[a, b], [a, c]]));
		expect([undefined, 'connecting']).toContain(b.mgr.links().get(c.peerId)); // never opens

		await put(b, 'from-b.md', 'hello c');
		await vi.waitFor(() => expect(dec(c.vault.files.get('from-b.md'))).toBe('hello c'));
		await vi.waitFor(() => allSynced([a, b, c], [[a, b], [a, c]]));
		await expectSame(a, b, c);
		// B ran the round; A's link to B still went through syncing back to synced.
		expect(a.events.filter(([p, s]) => p === b.peerId && s === 'syncing').length).toBeGreaterThanOrEqual(2);
		for (const n of [a, b, c]) n.mgr.stop();
	});

	test('three linked peers settle after a change instead of triggering each other forever', async () => {
		const { peer } = await roomSetup();
		const a = await peer('a');
		const b = await peer('b');
		const c = await peer('c');
		for (const n of [a, b, c]) n.mgr.start();
		const pairs: [P, P][] = [[a, b], [a, c], [b, c]];
		await vi.waitFor(() => allSynced([a, b, c], pairs));
		await put(b, 'n.md', 'one');
		await put(c, 'n.md', 'two'); // concurrent edit: merges happen too
		await vi.waitFor(() => {
			allSynced([a, b, c], pairs);
			expect(a.vault.files.has('n.md')).toBe(true);
		});
		await settle();
		const count = () => [a, b, c].reduce((n, x) => n + x.events.length, 0);
		const before = count();
		const vv = await a.store.vector();
		await settle();
		await settle();
		expect(count()).toBe(before);
		expect(await a.store.vector()).toEqual(vv);
		await expectSame(a, b, c);
		allSynced([a, b, c], pairs);
		for (const n of [a, b, c]) n.mgr.stop();
	});
});

describe('PeerManager link loss', () => {
	afterEach(() => vi.useRealTimers());

	async function linked() {
		const r = await roomSetup();
		const x = await r.peer('x');
		const y = await r.peer('y');
		const [lo, hi] = x.peerId < y.peerId ? [x, y] : [y, x];
		lo.mgr.start();
		hi.mgr.start();
		await vi.waitFor(() => allSynced([lo, hi], [[lo, hi]]));
		const pc = r.pcs.find((p) => p.offered)!; // the initiator's (lo's) connection
		return { ...r, lo, hi, pc, other: pc.remote! };
	}
	// Linked again over a new connection pair, and a change still gets through.
	async function relinked(t: Awaited<ReturnType<typeof linked>>) {
		const { lo, hi, pcs } = t;
		await vi.waitFor(
			() => {
				expect(pcs.length).toBeGreaterThanOrEqual(4);
				allSynced([lo, hi], [[lo, hi]]);
			},
			{ timeout: 3000 },
		);
		await put(hi, 'after.md', 'after');
		hi.mgr.syncNow();
		await vi.waitFor(() => expect(dec(lo.vault.files.get('after.md'))).toBe('after'));
		expect(t.room.sockets.size).toBe(2); // nobody left or rejoined the room
		lo.mgr.stop();
		hi.mgr.stop();
	}

	test('data channel closes before the connection state changes: both drop, the initiator relinks', async () => {
		const t = await linked();
		t.pc.dc!.close(); // closes both ends, as an SCTP abort does
		for (const pc of [t.pc, t.other]) {
			pc.connectionState = 'failed'; // ICE gives up afterwards
			pc.onconnectionstatechange?.();
		}
		expect(t.lo.mgr.links().has(t.hi.peerId)).toBe(false);
		expect(t.hi.mgr.links().has(t.lo.peerId)).toBe(false);
		await relinked(t);
	});

	test.each(['initiator', 'answerer'] as const)('the %s closes its connection locally (no events there): found by the link check, rebuilt', async (side) => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const t = await linked();
		const [closer, closerPc, closerDc, otherDc] = side === 'initiator' ? [t.lo, t.pc, t.pc.dc!, t.pc.dc!.peer!] : [t.hi, t.other, t.pc.dc!.peer!, t.pc.dc!];
		// RTCPeerConnection.close(): state changes, but no connectionstatechange and no channel close event locally.
		closerPc.connectionState = 'closed';
		closerDc.readyState = 'closed';
		otherDc.close(); // the far end sees the channel go
		const peer = closer === t.lo ? t.hi.peerId : t.lo.peerId;
		expect(closer.mgr.links().has(peer)).toBe(false); // the mailbox never counts on a dead link
		await vi.advanceTimersByTimeAsync(LINK_CHECK + 1000);
		await relinked(t);
	});

	test('a connection stuck in disconnected is given up after DISCONNECT_GRACE and rebuilt', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const t = await linked();
		for (const pc of [t.pc, t.other]) {
			pc.connectionState = 'disconnected'; // and it never moves on to 'failed'
			pc.onconnectionstatechange?.();
		}
		await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE - LINK_CHECK);
		expect(t.pcs).toHaveLength(2); // still waiting for ICE to recover
		await vi.advanceTimersByTimeAsync(2 * LINK_CHECK + 1000);
		await relinked(t);
	});

	test('a link that never connects is closed after CONNECT_TIMEOUT and retried with growing delay', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { room, pcs, peer } = await roomSetup();
		const x = await peer('x');
		const y = await peer('y');
		const [lo, hi] = x.peerId < y.peerId ? [x, y] : [y, x];
		room.block(lo.peerId, hi.peerId); // no answer ever arrives
		lo.mgr.start();
		hi.mgr.start();
		await vi.waitFor(() => expect(lo.mgr.links().get(hi.peerId)).toBe('connecting'));
		const mine = () => pcs.filter((p) => p.owner === lo.label);
		await vi.advanceTimersByTimeAsync(3 * (CONNECT_TIMEOUT + LINK_CHECK) + 7000);
		const [a, b, c, d] = mine();
		expect(lo.events).toContainEqual([hi.peerId, 'gone']);
		for (const pc of [a!, b!, c!]) {
			const life = pc.closedAt! - pc.createdAt;
			expect(life).toBeGreaterThan(CONNECT_TIMEOUT);
			expect(life).toBeLessThanOrEqual(CONNECT_TIMEOUT + LINK_CHECK);
		}
		// Retry delays double: 1 s, 2 s, 4 s.
		expect([b!.createdAt - a!.closedAt!, c!.createdAt - b!.closedAt!, d!.createdAt - c!.closedAt!]).toEqual([1000, 2000, 4000]);
		lo.mgr.stop();
		hi.mgr.stop();
	});
});

describe('PeerManager ICE servers', () => {
	test.each([
		['off', STUN],
		['ok', TURN],
		['upstream', STUN],
	] as const)('TURN %s: both ends get the right servers and still connect', async (mode, want) => {
		const { pcs, peer, turnCalls } = await roomSetup(mode);
		const a = await peer('a');
		const b = await peer('b');
		const c = await peer('c');
		for (const n of [a, b, c]) n.mgr.start();
		await vi.waitFor(() => allSynced([a, b, c], [[a, b], [a, c], [b, c]]));
		expect(pcs).toHaveLength(6);
		for (const pc of pcs) expect(pc.config.iceServers).toEqual(want);
		// Each peer has two links; a cached answer means one request each (failures are retried).
		for (const l of ['a', 'b', 'c']) {
			const n = turnCalls.filter((x) => x === l).length;
			if (mode === 'upstream') expect(n).toBeGreaterThanOrEqual(1);
			else expect(n).toBe(1);
		}
		for (const n of [a, b, c]) n.mgr.stop();
	});
});
