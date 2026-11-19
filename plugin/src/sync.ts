import type { Bundle, Channel, Revision, Store, SyncMsg, VaultIO, VersionVector } from './types';
import { mergeText, pickWinner } from './merge';

export interface Conflict {
	path: string;
	/** The concurrent heads that were resolved. */
	heads: Revision[];
	/** 'merge' = three-way text merge; 'pick' = one head's content was taken as is. */
	kind: 'merge' | 'pick';
	/** The head whose content was taken ('pick'), or null ('merge'). */
	winner: Revision | null;
	/** The merge revision written for this resolution. */
	result: Revision;
}

interface Session {
	round: { started: boolean; sent: number; recv: number };
	/** connect() was called during a round: run another one after it. */
	again: boolean;
	closed: boolean;
	waiters: { resolve: () => void; reject: (e: unknown) => void }[];
	start: () => Promise<void>;
	fail: (e: unknown) => void;
}

/** What the vault holds for a path as far as this engine knows, and which revisions that reflects. */
interface VaultState {
	hash: string | null;
	revs: string[];
}

const DIRTY = 'sync:dirty'; // paths with revisions not yet resolved into the vault
const MISSING = 'sync:missing'; // hash -> newest mtime of a held revision that references it, for content not held
const vaultKey = (path: string) => `sync:vault:${path}`;

export async function sha256Hex(data: Uint8Array): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
	return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export class SyncEngine {
	/** A path was written to or removed from the vault. */
	onWrite: ((path: string, deleted: boolean) => void) | null = null;
	/** Concurrent heads of a path were resolved. */
	onConflict: ((c: Conflict) => void) | null = null;
	/**
	 * The store gained revisions: received on `from`, or made locally / from a bundle (`from` null).
	 * Used by the transport to forward them to its other links.
	 */
	onRevisions: ((from: Channel | null) => void) | null = null;
	/** A round started on `ch` ('syncing'), or a round on `ch` moved nothing, so both ends now agree ('synced'). */
	onSession: ((ch: Channel, state: 'syncing' | 'synced') => void) | null = null;

	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private store: Store,
		private vault: VaultIO,
		private deviceId: string,
	) {}

	/** Every store/vault mutation goes through here so scanner calls and sync messages never interleave. */
	private run<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.queue.then(fn);
		this.queue = p.catch(() => undefined);
		return p;
	}

	recordLocal(path: string, data: Uint8Array | null, mtime: number, renamedFrom?: string): Promise<void> {
		return this.run(() =>
			this.tracked(null, async () => {
				await this.record(path, data, mtime, renamedFrom);
				if (renamedFrom) await this.record(renamedFrom, null, mtime);
			}),
		);
	}

	/** Runs `fn` and reports through onRevisions when the store gained revisions meanwhile. */
	private async tracked<T>(from: Channel | null, fn: () => Promise<T>): Promise<T> {
		const total = async () => Object.values(await this.store.vector()).reduce((n, x) => n + x, 0);
		const before = await total();
		const out = await fn();
		if ((await total()) !== before) this.onRevisions?.(from);
		return out;
	}

	/**
	 * Syncs with one peer over `ch`. Resolves when a full round moved nothing in either
	 * direction (both sides then hold the same revisions); rejects if the channel closes first.
	 * Whatever arrived before a close is kept and applied.
	 *
	 * The channel stays attached after that: the peer can open new rounds, and calling connect(ch)
	 * again on the same channel starts a new round (e.g. after a local change) without re-wiring it.
	 */
	connect(ch: Channel): Promise<void> {
		const s = this.sessions.get(ch) ?? this.attach(ch);
		if (s.closed) return Promise.reject(new Error('channel closed'));
		const p = new Promise<void>((resolve, reject) => s.waiters.push({ resolve, reject }));
		this.run(async () => {
			if (s.round.started) s.again = true; // mid-round: run one more round once this one ends
			else await s.start();
		}).catch((e) => s.fail(e));
		return p;
	}

	private sessions = new WeakMap<Channel, Session>();

	private attach(ch: Channel): Session {
		const s: Session = {
			round: { started: false, sent: 0, recv: 0 },
			again: false,
			closed: false,
			waiters: [],
			start: async () => {
				// One round: vv -> revs -> want -> blobs -> done, in that order from each side.
				s.round = { started: true, sent: 0, recv: 0 };
				this.onSession?.(ch, 'syncing');
				await ch.send({ t: 'vv', vv: await this.store.vector() });
			},
			fail: (e) => {
				for (const w of s.waiters.splice(0)) w.reject(e);
			},
		};
		const handle = async (m: SyncMsg) => {
			switch (m.t) {
				case 'vv': {
					if (!s.round.started) await s.start(); // the peer opened a round
					const revs = await this.store.revisionsSince(m.vv);
					s.round.sent = revs.length;
					await ch.send({ t: 'revs', revs });
					break;
				}
				case 'revs':
					s.round.recv = m.revs.length;
					await this.tracked(ch, () => this.ingest(m.revs));
					await ch.send({ t: 'want', hashes: Object.keys(await this.missing()) });
					break;
				case 'want':
					for (const hash of m.hashes) {
						const data = await this.store.getBlob(hash);
						if (data) await ch.send({ t: 'blob', hash, data });
					}
					await ch.send({ t: 'done' });
					break;
				case 'blob':
					await this.acceptBlob(m.hash, m.data);
					break;
				case 'done': {
					// The peer's done follows its blobs and its want, which we already answered: round over.
					const before = (await this.store.vector())[this.deviceId] ?? 0;
					await this.tracked(ch, () => this.resolvePending());
					const created = ((await this.store.vector())[this.deviceId] ?? 0) !== before;
					const moved = s.round.sent > 0 || s.round.recv > 0 || created || s.again;
					s.round = { started: false, sent: 0, recv: 0 };
					s.again = false;
					// Both sides see the same sent/recv counts, so they agree on another round; a side that
					// only created revisions (or was asked to sync again) restarts alone and the peer answers its vv.
					if (moved) await s.start();
					else {
						this.onSession?.(ch, 'synced');
						for (const w of s.waiters.splice(0)) w.resolve();
					}
					break;
				}
			}
		};
		ch.onmessage = (m) => {
			this.run(() => handle(m)).catch((e) => s.fail(e));
		};
		ch.onclose = () => {
			s.closed = true;
			this.run(() => this.tracked(ch, () => this.resolvePending())).then(
				() => s.fail(new Error('channel closed')),
				(e) => s.fail(e),
			);
		};
		this.sessions.set(ch, s);
		return s;
	}

	async exportBundle(since: VersionVector): Promise<Bundle> {
		const revs = await this.store.revisionsSince(since);
		const blobs: Bundle['blobs'] = [];
		const seen = new Set<string>();
		for (const r of revs) {
			if (!r.blobHash || seen.has(r.blobHash)) continue;
			seen.add(r.blobHash);
			const data = await this.store.getBlob(r.blobHash);
			if (data) blobs.push({ hash: r.blobHash, data });
		}
		return { revs, blobs };
	}

	/** Applies a bundle. `gaps` counts revisions skipped because earlier ones from their device are missing. */
	importBundle(b: Bundle): Promise<{ gaps: number }> {
		return this.run(() =>
			this.tracked(null, async () => {
				for (const { hash, data } of b.blobs) await this.acceptBlob(hash, data);
				const gaps = await this.ingest(b.revs);
				await this.resolvePending();
				return { gaps };
			}),
		);
	}

	/**
	 * Expires history older than `before` (ms): store.prune, then stops wanting content that pruning
	 * would drop anyway, so content expired everywhere is not asked for forever.
	 * Content still needed for an unresolved head stays wanted.
	 */
	prune(before: number): Promise<void> {
		return this.run(async () => {
			await this.store.prune(before);
			const needed = new Set<string>();
			for (const path of (await this.store.getMeta<string[]>(DIRTY)) ?? [])
				for (const h of await this.store.heads(path)) if (h.blobHash) needed.add(h.blobHash);
			const missing = await this.missing();
			for (const [hash, mtime] of Object.entries(missing)) if (mtime < before && !needed.has(hash)) delete missing[hash];
			await this.store.setMeta(MISSING, missing);
		});
	}

	// ---- internals (callers hold the queue) ----

	private async missing(): Promise<Record<string, number>> {
		return (await this.store.getMeta<Record<string, number>>(MISSING)) ?? {};
	}

	private async record(path: string, data: Uint8Array | null, mtime: number, renamedFrom?: string): Promise<void> {
		const hash = data ? await sha256Hex(data) : null;
		const known = await this.store.getMeta<VaultState>(vaultKey(path));
		if ((known?.hash ?? null) === hash) return;
		if (data && hash) await this.store.putBlob(hash, data);
		const seq = ((await this.store.vector())[this.deviceId] ?? 0) + 1;
		const rev: Revision = {
			id: `${this.deviceId}:${seq}`,
			path,
			blobHash: hash,
			size: data?.byteLength ?? 0,
			mtime,
			deviceId: this.deviceId,
			seq,
			// What the vault reflected, not store.heads(): remote heads received but not yet applied
			// must stay concurrent with this change instead of being silently superseded.
			parents: known?.revs ?? [],
			deleted: !data,
			...(renamedFrom ? { renamedFrom } : {}),
		};
		await this.store.putRevision(rev);
		await this.store.setMeta(vaultKey(path), { hash, revs: [rev.id] } satisfies VaultState);
	}

	/** Stores the revisions that extend our vector; returns how many were skipped for a gap. */
	private async ingest(revs: Revision[]): Promise<number> {
		const vv = await this.store.vector();
		const dirty = new Set((await this.store.getMeta<string[]>(DIRTY)) ?? []);
		const missing = await this.missing();
		const sorted = [...revs].sort((x, y) => cmp(x.deviceId, y.deviceId) || x.seq - y.seq);
		let gaps = 0;
		for (const rev of sorted) {
			if (rev.id !== `${rev.deviceId}:${rev.seq}`) continue;
			// Already held (dedupe), or a gap: accepting it would make vector() claim revisions we lack.
			if (rev.seq !== (vv[rev.deviceId] ?? 0) + 1) {
				if (rev.seq > (vv[rev.deviceId] ?? 0)) gaps++;
				continue;
			}
			await this.store.putRevision(rev);
			vv[rev.deviceId] = rev.seq;
			dirty.add(rev.path);
			if (rev.blobHash && !(await this.store.hasBlob(rev.blobHash)))
				missing[rev.blobHash] = Math.max(missing[rev.blobHash] ?? 0, rev.mtime);
		}
		await this.store.setMeta(DIRTY, [...dirty]);
		await this.store.setMeta(MISSING, missing);
		return gaps;
	}

	private async acceptBlob(hash: string, data: Uint8Array): Promise<void> {
		if ((await sha256Hex(data)) !== hash) return; // corrupt or forged: drop, it stays wanted
		await this.store.putBlob(hash, data);
		const missing = await this.missing();
		if (hash in missing) {
			delete missing[hash];
			await this.store.setMeta(MISSING, missing);
		}
	}

	private async resolvePending(): Promise<void> {
		const dirty = (await this.store.getMeta<string[]>(DIRTY)) ?? [];
		const left: string[] = [];
		for (const path of dirty) if (!(await this.resolve(path))) left.push(path);
		await this.store.setMeta(DIRTY, left);
	}

	/** Brings the vault in line with the heads of `path`. Returns false when content is still missing. */
	private async resolve(path: string): Promise<boolean> {
		if (this.vault.ignores?.(path)) return true;
		let heads = await this.store.heads(path);
		if (!heads.length) return true;
		for (const h of heads) if (h.blobHash && !(await this.store.hasBlob(h.blobHash))) return false;

		// Never overwrite a change the scanner has not reported yet: record it first, then merge it in.
		const cur = await this.vault.read(path);
		const curHash = cur ? await sha256Hex(cur) : null;
		const known = await this.store.getMeta<VaultState>(vaultKey(path));
		if (curHash !== (known?.hash ?? null)) {
			await this.record(path, cur, Date.now());
			heads = await this.store.heads(path);
		}
		heads.sort((x, y) => cmp(x.id, y.id));

		let target = heads[0]!;
		if (new Set(heads.map((h) => h.blobHash)).size > 1) {
			target = await this.mergeHeads(path, heads);
			heads = await this.store.heads(path);
		}

		if (target.blobHash !== curHash) {
			if (target.blobHash) {
				const data = await this.store.getBlob(target.blobHash);
				if (!data) return false;
				await this.vault.write(path, data, target.mtime);
			} else {
				await this.vault.remove(path);
			}
			this.onWrite?.(path, !target.blobHash);
		}
		await this.store.setMeta(vaultKey(path), {
			hash: target.blobHash,
			revs: heads.map((h) => h.id).sort(),
		} satisfies VaultState);
		return true;
	}

	/** Heads differ in content: writes a merge revision whose parents are all heads. Pure function of the heads. */
	private async mergeHeads(path: string, heads: Revision[]): Promise<Revision> {
		const live = heads.filter((h) => !h.deleted);
		// One representative per distinct content, in id order (heads are sorted).
		const reps = live.filter((h, i) => live.findIndex((x) => x.blobHash === h.blobHash) === i);
		let kind: Conflict['kind'] = 'pick';
		let winner: Revision = reps.length === 1 ? reps[0]! : pickWinner(reps); // modification beats deletion
		let data: Uint8Array | null = null;
		let mtime = winner.mtime;

		if (reps.length > 1 && path.endsWith('.md')) {
			const base = await this.commonAncestor(live);
			const texts = base?.blobHash ? await this.texts([base, ...reps]) : null;
			if (texts) {
				const [baseText, first, ...rest] = texts as [string, string, ...string[]];
				let merged: string | null = first;
				for (const t of rest) if (merged !== null) merged = mergeText(baseText, merged, t);
				// null: edits overlap, fall back to picking a winner; the loser stays in history.
				if (merged !== null) {
					data = new TextEncoder().encode(merged);
					kind = 'merge';
					mtime = Math.max(...reps.map((r) => r.mtime));
				}
			}
		}

		let hash = winner.blobHash!;
		if (data) {
			hash = await sha256Hex(data);
			await this.store.putBlob(hash, data);
		} else {
			data = (await this.store.getBlob(hash)) ?? null;
		}
		const seq = ((await this.store.vector())[this.deviceId] ?? 0) + 1;
		const result: Revision = {
			id: `${this.deviceId}:${seq}`,
			path,
			blobHash: hash,
			size: data?.byteLength ?? 0,
			mtime,
			deviceId: this.deviceId,
			seq,
			parents: heads.map((h) => h.id),
			deleted: false,
		};
		await this.store.putRevision(result);
		this.onConflict?.({ path, heads, kind, winner: kind === 'pick' ? winner : null, result });
		return result;
	}

	/** Decodes each revision's blob as UTF-8; null if any is missing or not text. */
	private async texts(revs: Revision[]): Promise<string[] | null> {
		const dec = new TextDecoder('utf-8', { fatal: true });
		const out: string[] = [];
		for (const r of revs) {
			const data = r.blobHash ? await this.store.getBlob(r.blobHash) : undefined;
			if (!data) return null;
			try {
				out.push(dec.decode(data));
			} catch {
				return null;
			}
		}
		return out;
	}

	/** The common ancestor with the largest history (so no other common ancestor descends from it); ties by id. */
	private async commonAncestor(revs: Revision[]): Promise<Revision | null> {
		const sets = await Promise.all(revs.map((r) => this.ancestors(r)));
		let best: { rev: Revision; size: number } | null = null;
		for (const [id, rev] of sets[0] ?? []) {
			if (!sets.every((s) => s.has(id))) continue;
			const size = (await this.ancestors(rev)).size;
			if (!best || size > best.size || (size === best.size && id > best.rev.id)) best = { rev, size };
		}
		return best?.rev ?? null;
	}

	// shortcut: walks the whole parent graph per call, fine for per-file histories of hundreds; memoise when histories get long.
	private async ancestors(rev: Revision): Promise<Map<string, Revision>> {
		const out = new Map<string, Revision>([[rev.id, rev]]);
		const todo = [...rev.parents];
		while (todo.length) {
			const id = todo.pop()!;
			if (out.has(id)) continue;
			const r = await this.store.getRevision(id);
			if (!r) continue; // not received yet, or pruned
			out.set(id, r);
			todo.push(...r.parents);
		}
		return out;
	}
}
