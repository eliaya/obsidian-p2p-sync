// Encrypted mailbox for peers that are not connected.
import { decrypt, encrypt } from './crypto';
import { type LinkState, pack, type RelayClient, unpack } from './peer';
import type { SyncEngine } from './sync';
import type { Revision, Store, VersionVector } from './types';

/** Plaintext limit of one upload; a single larger content goes alone in its own upload. */
export const SEGMENT_BYTES = 8 << 20;
// shortcut: content over 90 MB is never mailed (Cloudflare Free caps a request at 100 MB); it still syncs P2P. Upgrade with chunked uploads if that matters.
export const MAX_BLOB = 90 << 20;
// shortcut: an unanswered request is re-sent after the relay's default bundle TTL (30 days), not on a smarter signal.
const REQUEST_TTL = 30 * 24 * 3600 * 1000;

const CURSOR = 'mailbox:cursor'; // everything up to this vector has been mailed (or reached every peer)
const REQUEST = 'mailbox:request'; // our unanswered request: { id, at }
const INIT = 'mailbox:init';

interface DataHeader {
	v: 1;
	kind: 'data';
	revs: Revision[];
	blobs: { hash: string; len: number }[];
	/** The vector the export started from: a receiver behind it on any device has missed something. */
	since: VersionVector;
	/** Id of the request this answers. */
	reply?: string;
	/** Last segment of an answer. */
	last?: boolean;
}
interface RequestHeader {
	v: 1;
	kind: 'request';
	id: string;
	vv: VersionVector;
}

export type MailboxRelay = Pick<RelayClient, 'peers' | 'putBundle' | 'listBundles' | 'getBundle' | 'ackBundle'>;

export interface MailboxOptions {
	relay: MailboxRelay;
	store: Store;
	engine: SyncEngine;
	mailboxKey: CryptoKey;
	selfId: string;
	/** Peers with an open link right now (PeerManager.links). Without it every peer counts as offline. */
	links?: () => ReadonlyMap<string, LinkState>;
	/** A bundle that did not decrypt or parse; it has been acknowledged so it is not retried. */
	onBadBundle?: (id: string, error: unknown) => void;
	/** A revision whose content is over MAX_BLOB was mailed without its content. */
	onSkipped?: (rev: Revision) => void;
}

export class Mailbox {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private o: MailboxOptions) {}

	private run<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.queue.then(fn);
		this.queue = p.catch(() => undefined);
		return p;
	}

	/** Call once at startup: a new device asks for the whole vault, then the mailbox is read. */
	start(): Promise<void> {
		return this.run(async () => {
			if (!(await this.o.store.getMeta(INIT))) {
				await this.request();
				await this.o.store.setMeta(INIT, true);
			}
			await this.receiveNow();
		});
	}

	/** Downloads, applies and acknowledges every pending bundle, oldest first. Call periodically. */
	receive(): Promise<void> {
		return this.run(() => this.receiveNow());
	}

	/**
	 * Call after local changes and after a sync round completes. Mails what is new since the cursor
	 * when any active peer is not linked; when every peer is linked and synced, just moves the cursor.
	 */
	push(): Promise<void> {
		return this.run(async () => {
			const others = (await this.o.relay.peers()).map((p) => p.peerId).filter((p) => p !== this.o.selfId);
			const links = this.o.links?.() ?? new Map<string, LinkState>();
			const vv = await this.o.store.vector();
			if (others.some((p) => !['syncing', 'synced'].includes(links.get(p) ?? ''))) {
				await this.upload((await this.cursor()) ?? {}, vv);
			} else if (others.every((p) => links.get(p) === 'synced')) {
				await this.o.store.setMeta(CURSOR, vv);
			}
		});
	}

	private async cursor() {
		return this.o.store.getMeta<VersionVector>(CURSOR);
	}

	private async request() {
		const pending = await this.o.store.getMeta<{ id: string; at: number }>(REQUEST);
		if (pending && Date.now() - pending.at < REQUEST_TTL) return; // one unanswered request at a time
		const id = crypto.randomUUID();
		await this.put(pack({ v: 1, kind: 'request', id, vv: await this.o.store.vector() } satisfies RequestHeader));
		await this.o.store.setMeta(REQUEST, { id, at: Date.now() });
	}

	private async put(plain: Uint8Array) {
		await this.o.relay.putBundle(await encrypt(this.o.mailboxKey, plain));
	}

	/**
	 * Streams revisions held since `since` (up to `upto`) as segments of at most SEGMENT_BYTES:
	 * only one segment's content is in memory at a time. Without `reply` the cursor follows each upload.
	 */
	private async upload(since: VersionVector, upto: VersionVector, reply?: string) {
		const revs = (await this.o.store.revisionsSince(since)).filter((r) => r.seq <= (upto[r.deviceId] ?? 0));
		if (!revs.length && !reply) return;
		let seg: Revision[] = [];
		let blobs: { hash: string; data: Uint8Array }[] = [];
		let bytes = 0;
		const sent = new Set<string>();
		// Each segment's `since` covers the segments before it, so losing any one of them is detectable.
		const segSince: VersionVector = { ...since };
		const flush = async (last: boolean) => {
			const header: DataHeader = { v: 1, kind: 'data', since: { ...segSince }, revs: seg, blobs: blobs.map((b) => ({ hash: b.hash, len: b.data.length })) };
			if (reply) Object.assign(header, { reply, last });
			await this.put(pack(header, blobs.map((b) => b.data)));
			for (const r of seg) segSince[r.deviceId] = Math.max(segSince[r.deviceId] ?? 0, r.seq);
			if (!reply) {
				// revisionsSince is ordered and gap-free from the cursor, so each upload extends it.
				const cur = (await this.cursor()) ?? {};
				for (const r of seg) cur[r.deviceId] = Math.max(cur[r.deviceId] ?? 0, r.seq);
				await this.o.store.setMeta(CURSOR, cur);
			}
			seg = [];
			blobs = [];
			bytes = 0;
		};
		for (const r of revs) {
			let data: Uint8Array | undefined;
			if (r.blobHash && !sent.has(r.blobHash)) {
				data = await this.o.store.getBlob(r.blobHash); // undefined when pruned: the revision still goes
				if (data && data.length > MAX_BLOB) {
					this.o.onSkipped?.(r);
					data = undefined;
				}
			}
			const size = JSON.stringify(r).length + (data?.length ?? 0);
			if (seg.length && bytes + size > SEGMENT_BYTES) await flush(false);
			seg.push(r);
			if (data && r.blobHash) {
				blobs.push({ hash: r.blobHash, data });
				sent.add(r.blobHash);
			}
			bytes += size;
		}
		await flush(true);
	}

	private async receiveNow() {
		const list = [...(await this.o.relay.listBundles())].sort((a, b) => a.createdAt - b.createdAt);
		let gaps = 0;
		for (const { id } of list) {
			const sealed = await this.o.relay.getBundle(id); // a network error stops here and retries next time
			let msg: { header: DataHeader | RequestHeader; body: Uint8Array };
			try {
				msg = parse(await decrypt(this.o.mailboxKey, sealed));
			} catch (e) {
				await this.o.relay.ackBundle(id);
				this.o.onBadBundle?.(id, e);
				continue;
			}
			const h = msg.header;
			if (h.kind === 'request') {
				// shortcut: every device that sees a request answers it, so the room gets duplicates; harmless (idempotent), costs quota.
				await this.upload(h.vv, await this.o.store.vector(), h.id);
			} else {
				let o = 0;
				const blobs = h.blobs.map((b) => ({ hash: b.hash, data: msg.body.slice(o, (o += b.len)) }));
				gaps += (await this.o.engine.importBundle({ revs: h.revs, blobs })).gaps;
				const held = await this.o.store.vector();
				if (Object.entries(h.since).some(([d, n]) => (held[d] ?? 0) < n)) gaps++;
				await this.advanceCursor(h.revs);
				const pending = await this.o.store.getMeta<{ id: string }>(REQUEST);
				if (h.reply && h.last && pending?.id === h.reply) await this.o.store.setMeta(REQUEST, null);
			}
			await this.o.relay.ackBundle(id);
		}
		// A bundle we needed expired or is missing (seq gap, or we are behind a sender's cursor): ask for it.
		if (gaps) await this.request();
	}

	/** Revisions that arrived by mail reached every peer the same way, so we need not mail them again. */
	private async advanceCursor(revs: Revision[]) {
		const cur = (await this.cursor()) ?? {};
		const held = await this.o.store.vector();
		let changed = false;
		for (const r of [...revs].sort((a, b) => a.seq - b.seq)) {
			if (r.seq === (cur[r.deviceId] ?? 0) + 1 && r.seq <= (held[r.deviceId] ?? 0)) {
				cur[r.deviceId] = r.seq;
				changed = true;
			}
		}
		if (changed) await this.o.store.setMeta(CURSOR, cur);
	}
}

/** Throws on anything that is not a well-formed payload. */
function parse(plain: Uint8Array): { header: DataHeader | RequestHeader; body: Uint8Array } {
	const { header, body } = unpack<DataHeader | RequestHeader>(plain);
	if (header?.v !== 1) throw new Error('unknown payload version');
	if (header.kind === 'request') {
		if (typeof header.id !== 'string' || typeof header.vv !== 'object' || !header.vv) throw new Error('bad request');
	} else if (header.kind === 'data') {
		if (!Array.isArray(header.revs) || !Array.isArray(header.blobs) || typeof header.since !== 'object' || !header.since) throw new Error('bad data');
		if (header.blobs.reduce((n, b) => n + b.len, 0) !== body.length) throw new Error('blob lengths do not match');
	} else throw new Error('unknown payload kind');
	return { header, body };
}
