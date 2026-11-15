// Shared test helpers: in-memory store and vault, a cuttable channel pair, node and sync helpers.
import { expect } from 'vitest';
import type { Channel, Revision, Store, SyncMsg, VaultIO, VersionVector } from './types';
import { type Conflict, SyncEngine } from './sync';

export class MemStore implements Store {
	revs = new Map<string, Revision>();
	blobs = new Map<string, Uint8Array>();
	meta = new Map<string, unknown>();
	async putRevision(r: Revision) {
		this.revs.set(r.id, structuredClone(r));
	}
	async getRevision(id: string) {
		const r = this.revs.get(id);
		return r && structuredClone(r);
	}
	async vector() {
		const vv: VersionVector = {};
		for (const r of this.revs.values()) vv[r.deviceId] = Math.max(vv[r.deviceId] ?? 0, r.seq);
		return vv;
	}
	async revisionsSince(vv: VersionVector) {
		return [...this.revs.values()]
			.filter((r) => r.seq > (vv[r.deviceId] ?? 0))
			.sort((x, y) => (x.deviceId < y.deviceId ? -1 : x.deviceId > y.deviceId ? 1 : x.seq - y.seq))
			.map((r) => structuredClone(r));
	}
	async heads(path: string) {
		const rs = [...this.revs.values()].filter((r) => r.path === path);
		const named = new Set(rs.flatMap((r) => r.parents));
		return rs.filter((r) => !named.has(r.id)).map((r) => structuredClone(r));
	}
	async history(path: string) {
		return [...this.revs.values()].filter((r) => r.path === path).sort((x, y) => y.mtime - x.mtime);
	}
	async paths() {
		return [...new Set([...this.revs.values()].map((r) => r.path))];
	}
	async putBlob(h: string, d: Uint8Array) {
		this.blobs.set(h, d.slice());
	}
	async getBlob(h: string) {
		return this.blobs.get(h)?.slice();
	}
	async hasBlob(h: string) {
		return this.blobs.has(h);
	}
	async getMeta<T>(k: string) {
		return structuredClone(this.meta.get(k)) as T | undefined;
	}
	async setMeta(k: string, v: unknown) {
		this.meta.set(k, structuredClone(v));
	}
	async prune() {}
}

export class MemVault implements VaultIO {
	files = new Map<string, Uint8Array>();
	async read(p: string) {
		return this.files.get(p)?.slice() ?? null;
	}
	async write(p: string, d: Uint8Array) {
		this.files.set(p, d.slice());
	}
	async remove(p: string) {
		this.files.delete(p);
	}
}

/** Two connected channel ends. After `limit` messages in total the link drops and both ends see onclose. */
export function pair(limit = Infinity) {
	let count = 0;
	let closed = false;
	const sent: SyncMsg[][] = [[], []];
	const close = () => {
		if (closed) return;
		closed = true;
		for (const e of ends) e.onclose?.();
	};
	const end = (i: 0 | 1): Channel => ({
		onmessage: null,
		onclose: null,
		async send(msg) {
			if (closed) return;
			if (++count > limit) return close();
			sent[i]!.push(msg);
			const copy = structuredClone(msg);
			queueMicrotask(() => {
				if (!closed) ends[1 - i]!.onmessage?.(copy);
			});
		},
	});
	const ends = [end(0), end(1)] as const;
	return { a: ends[0], b: ends[1], sent };
}

export const enc = (s: string) => new TextEncoder().encode(s);
export const dec = (d: Uint8Array | undefined | null) => (d ? new TextDecoder().decode(d) : undefined);
export const tick = () => new Promise((r) => setTimeout(r, 0));

export function node(id: string, store: Store = new MemStore()) {
	const vault = new MemVault();
	const eng = new SyncEngine(store, vault, id);
	const conflicts: Conflict[] = [];
	const written: string[] = [];
	eng.onConflict = (c) => conflicts.push(c);
	eng.onWrite = (p) => written.push(p);
	return { id, store, vault, eng, conflicts, written };
}
export type Node = ReturnType<typeof node>;

let clock = 1000;
export async function put(n: Node, path: string, data: string | Uint8Array, mtime = ++clock) {
	const d = typeof data === 'string' ? enc(data) : data;
	n.vault.files.set(path, d);
	await n.eng.recordLocal(path, d, mtime);
}
export async function del(n: Node, path: string) {
	n.vault.files.delete(path);
	await n.eng.recordLocal(path, null, ++clock);
}

export async function sync(x: Node, y: Node, limit = Infinity) {
	const ch = pair(limit);
	const res = await Promise.allSettled([x.eng.connect(ch.a), y.eng.connect(ch.b)]);
	await tick();
	return { ...ch, res };
}

export function snapshot(n: Node) {
	return Object.fromEntries([...n.vault.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, d]) => [p, [...d]]));
}
export async function expectSame(...ns: Node[]) {
	for (const n of ns.slice(1)) {
		expect(snapshot(n)).toEqual(snapshot(ns[0]!));
		expect(await n.store.vector()).toEqual(await ns[0]!.store.vector());
	}
}

export const BASE = 'Alpha paragraph talks about apples.\n\nBeta paragraph talks about pears.\n\nGamma paragraph talks about plums.\n';
