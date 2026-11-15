import type { DataAdapter } from 'obsidian';
import type { Store, VaultIO } from './types';
import type { SyncEngine } from './sync';

export type ScanAdapter = Pick<DataAdapter, 'list' | 'stat' | 'readBinary' | 'writeBinary' | 'remove' | 'mkdir' | 'exists'>;

const CACHE_KEY = 'scan-cache';
type Cache = Record<string, { mtime: number; size: number }>;

const ignored = (path: string) => path.split('/').includes('.git');

/** Reports disk changes to the engine and applies the engine's writes to disk. */
export class VaultScanner implements VaultIO {
	private cache?: Cache;
	private running?: Promise<number>;

	constructor(
		private adapter: ScanAdapter,
		private engine: Pick<SyncEngine, 'recordLocal'>,
		private store: Pick<Store, 'getMeta' | 'setMeta'>,
	) {}

	private async load(): Promise<Cache> {
		return (this.cache ??= (await this.store.getMeta<Cache>(CACHE_KEY)) ?? {});
	}

	private async save(): Promise<void> {
		await this.store.setMeta(CACHE_KEY, await this.load());
	}

	async read(path: string): Promise<Uint8Array | null> {
		if (!(await this.adapter.exists(path))) return null;
		return new Uint8Array(await this.adapter.readBinary(path));
	}

	async write(path: string, data: Uint8Array, mtime: number): Promise<void> {
		const parts = path.split('/').slice(0, -1);
		for (let i = 1; i <= parts.length; i++) {
			const dir = parts.slice(0, i).join('/');
			if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
		}
		const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
		await this.adapter.writeBinary(path, buf, { mtime });
		// Cache what the disk reports, since the filesystem may round mtime.
		const st = await this.adapter.stat(path);
		(await this.load())[path] = { mtime: st?.mtime ?? mtime, size: st?.size ?? data.byteLength };
		await this.save();
	}

	async remove(path: string): Promise<void> {
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
		delete (await this.load())[path];
		await this.save();
	}

	/** Lists every file under the vault root, including dot-folders; throws if any folder cannot be listed. */
	private async listAll(dir = '/'): Promise<string[]> {
		const { files, folders } = await this.adapter.list(dir);
		const out = files.filter((f) => !ignored(f));
		for (const d of folders) if (!ignored(d)) out.push(...(await this.listAll(d)));
		return out;
	}

	/** Records `path` if it differs from the cache. Returns whether a change was reported. */
	private async check(path: string, cache: Cache): Promise<boolean> {
		const st = await this.adapter.stat(path);
		if (!st || st.type !== 'file') return false;
		const c = cache[path];
		if (c && c.mtime === st.mtime && c.size === st.size) return false;
		let data: Uint8Array;
		try {
			// shortcut: whole file in memory, stream/chunk if large attachments become a problem
			data = new Uint8Array(await this.adapter.readBinary(path));
		} catch {
			return false; // locked or unreadable: keep old cache so it is retried
		}
		await this.engine.recordLocal(path, data, st.mtime);
		cache[path] = { mtime: st.mtime, size: st.size };
		return true;
	}

	/** Full scan; concurrent calls share the running scan. Resolves to the number of changes reported. */
	scanAll(): Promise<number> {
		return (this.running ??= this.doScan().finally(() => (this.running = undefined)));
	}

	private async doScan(): Promise<number> {
		const cache = await this.load();
		const seen = new Set(await this.listAll());
		let n = 0;
		for (const path of seen) if (await this.check(path, cache)) n++;
		for (const path of Object.keys(cache)) {
			if (seen.has(path)) continue;
			await this.engine.recordLocal(path, null, Date.now());
			delete cache[path];
			n++;
		}
		if (n) await this.save();
		return n;
	}

	/** A vault event fired for `path`: check only that path. */
	async onFileEvent(path: string): Promise<number> {
		if (ignored(path)) return 0;
		const cache = await this.load();
		let n = 0;
		if (await this.adapter.exists(path)) {
			if (await this.check(path, cache)) n = 1;
		} else if (cache[path]) {
			await this.engine.recordLocal(path, null, Date.now());
			delete cache[path];
			n = 1;
		}
		if (n) await this.save();
		return n;
	}

	async onRename(oldPath: string, newPath: string): Promise<void> {
		if (ignored(newPath)) {
			await this.onFileEvent(oldPath);
			return;
		}
		const st = await this.adapter.stat(newPath);
		if (!st || st.type !== 'file') return;
		let data: Uint8Array;
		try {
			data = new Uint8Array(await this.adapter.readBinary(newPath));
		} catch {
			return; // next scan sees the new path as new and the old as deleted
		}
		const cache = await this.load();
		await this.engine.recordLocal(newPath, data, st.mtime, oldPath);
		delete cache[oldPath];
		cache[newPath] = { mtime: st.mtime, size: st.size };
		await this.save();
	}
}
