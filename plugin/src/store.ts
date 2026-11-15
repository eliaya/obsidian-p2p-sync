import type { Revision, Store, VersionVector } from './types';

const REVS = 'revisions';
const BLOBS = 'blobs';
const META = 'meta';
const VV = '\0vector'; // reserved meta key, not reachable by sane getMeta callers

const req = <T>(r: IDBRequest<T>) =>
	new Promise<T>((res, rej) => {
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
const done = (tx: IDBTransaction) =>
	new Promise<void>((res, rej) => {
		tx.oncomplete = () => res();
		tx.onerror = tx.onabort = () => rej(tx.error);
	});

export class IdbStore implements Store {
	private constructor(private db: IDBDatabase) {}

	static async open(name: string): Promise<IdbStore> {
		const r = indexedDB.open(name, 1);
		r.onupgradeneeded = () => {
			const db = r.result;
			const revs = db.createObjectStore(REVS, { keyPath: 'id' });
			revs.createIndex('byPath', 'path');
			revs.createIndex('byDevSeq', ['deviceId', 'seq']);
			revs.createIndex('byParent', 'parents', { multiEntry: true });
			revs.createIndex('byBlob', 'blobHash'); // null blobHash is not a valid key, so deletions are skipped
			db.createObjectStore(BLOBS);
			db.createObjectStore(META);
		};
		return new IdbStore(await req(r));
	}

	close(): void {
		this.db.close();
	}

	private os(name: string, mode: IDBTransactionMode = 'readonly') {
		return this.db.transaction(name, mode).objectStore(name);
	}

	async putRevision(rev: Revision): Promise<void> {
		const t = this.db.transaction([REVS, META], 'readwrite');
		const finished = done(t);
		t.objectStore(REVS).put(rev);
		// Persisted separately so prune can never make it regress.
		const meta = t.objectStore(META);
		const vv: VersionVector = (await req(meta.get(VV))) ?? {};
		if ((vv[rev.deviceId] ?? 0) < rev.seq) {
			vv[rev.deviceId] = rev.seq;
			meta.put(vv, VV);
		}
		await finished;
	}

	getRevision(id: string): Promise<Revision | undefined> {
		return req(this.os(REVS).get(id));
	}

	async vector(): Promise<VersionVector> {
		return (await req(this.os(META).get(VV))) ?? {};
	}

	async revisionsSince(vv: VersionVector): Promise<Revision[]> {
		const idx = this.os(REVS).index('byDevSeq');
		const out: Revision[] = [];
		let c = await req(idx.openKeyCursor(null, 'next'));
		while (c) {
			const dev = (c.key as [string, number])[0];
			const range = IDBKeyRange.bound([dev, vv[dev] ?? 0], [dev, Infinity], true, false);
			out.push(...(await req(idx.getAll(range))));
			c = await req(idx.openKeyCursor(IDBKeyRange.lowerBound([dev, Infinity], true), 'next'));
		}
		return out;
	}

	async heads(path: string): Promise<Revision[]> {
		const revs: Revision[] = await req(this.os(REVS).index('byPath').getAll(path));
		const named = new Set(revs.flatMap((r) => r.parents));
		return revs.filter((r) => !named.has(r.id));
	}

	async history(path: string): Promise<Revision[]> {
		const revs: Revision[] = await req(this.os(REVS).index('byPath').getAll(path));
		return revs.sort((a, b) => b.mtime - a.mtime || (a.deviceId < b.deviceId ? 1 : a.deviceId > b.deviceId ? -1 : b.seq - a.seq));
	}

	async paths(): Promise<string[]> {
		const idx = this.os(REVS).index('byPath');
		return req(idx.openKeyCursor(null, 'nextunique')).then(async (c) => {
			const out: string[] = [];
			while (c) {
				out.push(c.key as string);
				c = await req(idx.openKeyCursor(IDBKeyRange.lowerBound(c.key, true), 'nextunique'));
			}
			return out;
		});
	}

	async putBlob(hash: string, data: Uint8Array): Promise<void> {
		const blobs = this.os(BLOBS, 'readwrite');
		blobs.put(data, hash);
		await done(blobs.transaction);
	}

	async getBlob(hash: string): Promise<Uint8Array | undefined> {
		return req(this.os(BLOBS).get(hash));
	}

	async hasBlob(hash: string): Promise<boolean> {
		return (await req(this.os(BLOBS).count(hash))) > 0;
	}

	getMeta<T>(key: string): Promise<T | undefined> {
		return req(this.os(META).get(key));
	}

	async setMeta(key: string, value: unknown): Promise<void> {
		const meta = this.os(META, 'readwrite');
		meta.put(value, key);
		await done(meta.transaction);
	}

	async prune(before: number): Promise<void> {
		const t = this.db.transaction([REVS, BLOBS], 'readwrite');
		const revisions = t.objectStore(REVS);
		const blobs = t.objectStore(BLOBS);
		const finished = done(t);
		const byParent = revisions.index('byParent');
		const byBlob = revisions.index('byBlob');
		for (const h of await req(blobs.getAllKeys())) {
			let keep = false;
			for (const r of (await req(byBlob.getAll(h))) as Revision[]) {
				// Keep when a recent revision or a head (named as parent by no one) uses it.
				if (r.mtime >= before || (await req(byParent.count(r.id))) === 0) {
					keep = true;
					break;
				}
			}
			if (!keep) blobs.delete(h);
		}
		await finished;
	}
}
