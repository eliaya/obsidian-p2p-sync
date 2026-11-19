import { expect, test } from 'vitest';
import { VaultScanner, type ScanAdapter } from './scan';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b);

class MemAdapter {
	files = new Map<string, { data: Uint8Array; mtime: number }>();
	dirs = new Set<string>();
	reads: string[] = [];
	mkdirs: string[] = [];
	writes: { path: string; mtime?: number }[] = [];
	failRead = new Set<string>();
	onList?: () => Promise<void>;
	put(path: string, s: string, mtime = 1) {
		this.files.set(path, { data: enc(s), mtime });
	}
	async list(dir: string) {
		await this.onList?.();
		const d = dir === '/' ? '' : dir;
		const inDir = (p: string) => p.startsWith(d ? d + '/' : '') && !p.slice(d ? d.length + 1 : 0).includes('/');
		const folders = new Set<string>();
		for (const p of [...this.files.keys(), ...this.dirs]) {
			const rest = p.slice(d ? d.length + 1 : 0);
			if (p.startsWith(d ? d + '/' : '') && rest.includes('/')) folders.add((d ? d + '/' : '') + rest.split('/')[0]);
		}
		for (const p of this.dirs) if (inDir(p)) folders.add(p);
		return { files: [...this.files.keys()].filter(inDir), folders: [...folders] };
	}
	async stat(path: string) {
		const f = this.files.get(path);
		return f ? { type: 'file' as const, ctime: 0, mtime: f.mtime, size: f.data.byteLength } : null;
	}
	async readBinary(path: string) {
		if (this.failRead.has(path)) throw new Error('locked');
		this.reads.push(path);
		const f = this.files.get(path)!;
		return f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer;
	}
	async writeBinary(path: string, data: ArrayBuffer, o?: { mtime?: number }) {
		this.writes.push({ path, mtime: o?.mtime });
		this.files.set(path, { data: new Uint8Array(data), mtime: o?.mtime ?? 99 });
	}
	async remove(path: string) {
		this.files.delete(path);
	}
	async rmdir(path: string) {
		this.dirs.delete(path);
	}
	async mkdir(path: string) {
		this.mkdirs.push(path);
		this.dirs.add(path);
	}
	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path);
	}
}

function setup(a = new MemAdapter(), meta: Map<string, unknown> = new Map()) {
	const calls: [string, string | null, number, string | undefined][] = [];
	const engine = {
		recordLocal: async (p: string, d: Uint8Array | null, m: number, r?: string) => {
			calls.push([p, d && dec(d), m, r]);
		},
	};
	const sets: number[] = [];
	const store = {
		getMeta: async <T>(k: string) => meta.get(k) as T | undefined,
		setMeta: async (k: string, v: unknown) => {
			sets.push(1);
			meta.set(k, JSON.parse(JSON.stringify(v)));
		},
	};
	const s = new VaultScanner(a as unknown as ScanAdapter, engine, store);
	return { a, s, calls, meta, sets, engine, store };
}
const paths = (c: unknown[][]) => c.map((x) => x[0]).sort();

test('first scan reports everything incl. dot folders, skips .git at any depth', async () => {
	const { a, s, calls, sets } = setup();
	a.put('a.md', 'a');
	a.put('d/b.md', 'b');
	a.put('.obsidian/plugins/x/main.js', 'x');
	a.put('.git/HEAD', 'h');
	a.put('d/.git/config', 'c');
	expect(await s.scanAll()).toBe(3);
	expect(paths(calls)).toEqual(['.obsidian/plugins/x/main.js', 'a.md', 'd/b.md']);
	expect(sets.length).toBe(1);
});

test('unchanged second scan reads nothing', async () => {
	const { a, s, calls } = setup();
	a.put('a.md', 'a');
	await s.scanAll();
	a.reads.length = 0;
	calls.length = 0;
	expect(await s.scanAll()).toBe(0);
	expect(a.reads).toEqual([]);
	expect(calls).toEqual([]);
});

test('modified by mtime or size reports only that file; deletion reports null', async () => {
	const { a, s, calls } = setup();
	a.put('a.md', 'a');
	a.put('b.md', 'b');
	a.put('c.md', 'c');
	await s.scanAll();
	calls.length = 0;
	a.put('a.md', 'a', 2); // mtime
	a.put('b.md', 'bb', 1); // size
	expect(await s.scanAll()).toBe(2);
	expect(paths(calls)).toEqual(['a.md', 'b.md']);
	calls.length = 0;
	a.files.delete('c.md');
	expect(await s.scanAll()).toBe(1);
	expect(calls[0]!.slice(0, 2)).toEqual(['c.md', null]);
});

test('VaultIO write/remove are not reported by the next scan', async () => {
	const { a, s, calls } = setup();
	a.put('keep.md', 'k');
	await s.scanAll();
	calls.length = 0;
	await s.write('new.md', enc('n'), 5);
	await s.remove('keep.md');
	expect(await s.scanAll()).toBe(0);
	expect(calls).toEqual([]);
	expect(await s.read('keep.md')).toBeNull();
	expect(dec((await s.read('new.md'))!)).toBe('n');
	await s.remove('keep.md'); // missing: no error
});

test('write creates nested folders and passes mtime', async () => {
	const { a, s } = setup();
	await s.write('x/y/z.md', enc('z'), 1234);
	expect(a.mkdirs).toEqual(['x', 'x/y']);
	expect(a.writes).toEqual([{ path: 'x/y/z.md', mtime: 1234 }]);
});

test('.syncignore: files and folders are skipped, the rule file itself always syncs', async () => {
	const { a, s, calls } = setup();
	a.put('.syncignore', '*.tmp\nfoo/\n.syncignore\n');
	a.put('a.md', 'a');
	a.put('x.tmp', 'x');
	a.put('foo/b.md', 'b');
	a.put('sub/foo/c.md', 'c');
	a.put('.git/HEAD', 'h');
	await s.scanAll();
	expect(paths(calls)).toEqual(['.syncignore', 'a.md']);
	expect(await s.onFileEvent('x.tmp')).toBe(0);
	expect(s.ignores('foo/b.md')).toBe(true);
	expect(s.ignores('.syncignore')).toBe(false);
});

test('.syncignore: newly ignored files are dropped without a delete; un-ignoring tracks them again', async () => {
	const { a, s, calls, meta } = setup();
	a.put('keep.md', 'k');
	a.put('foo/b.md', 'b');
	await s.scanAll();
	calls.length = 0;
	a.put('.syncignore', 'foo/\n', 2);
	expect(await s.scanAll()).toBe(1);
	expect(calls.map((c) => [c[0], c[1]])).toEqual([['.syncignore', 'foo/\n']]);
	expect(Object.keys(meta.get('scan-cache') as object).sort()).toEqual(['.syncignore', 'keep.md']);
	calls.length = 0;
	a.put('.syncignore', '', 3);
	await s.scanAll();
	expect(paths(calls)).toEqual(['.syncignore', 'foo/b.md']);
});

test('.syncignore: a remote write of the rule file applies at once', async () => {
	const { s } = setup();
	await s.write('.syncignore', enc('*.log\n'), 1);
	expect(s.ignores('a.log')).toBe(true);
	await s.remove('.syncignore');
	expect(s.ignores('a.log')).toBe(false);
});

test('rename into or out of an ignored path', async () => {
	const { a, s, calls } = setup();
	a.put('.syncignore', '*.tmp\n');
	a.put('n.md', 'n');
	await s.scanAll();
	calls.length = 0;
	a.files.set('n.tmp', a.files.get('n.md')!);
	a.files.delete('n.md');
	await s.onRename('n.md', 'n.tmp');
	expect(calls.map((c) => [c[0], c[1], c[3]])).toEqual([['n.md', null, undefined]]);
	calls.length = 0;
	a.files.set('m.md', a.files.get('n.tmp')!);
	a.files.delete('n.tmp');
	await s.onRename('n.tmp', 'm.md');
	expect(calls.map((c) => [c[0], c[1], c[3]])).toEqual([['m.md', 'n', undefined]]);
});

test('remove drops folders it left empty, but not a top-level dot folder', async () => {
	const { a, s } = setup();
	await s.write('a/b/c.md', enc('c'), 1);
	await s.write('a/keep/k.md', enc('k'), 1);
	await s.write('.x/y.md', enc('y'), 1);
	await s.remove('a/b/c.md');
	expect(await a.exists('a/b')).toBe(false);
	expect(await a.exists('a')).toBe(true); // still holds a/keep
	await s.remove('a/keep/k.md');
	expect(await a.exists('a/keep')).toBe(false);
	expect(await a.exists('a')).toBe(false);
	await s.remove('.x/y.md');
	expect(await a.exists('.x')).toBe(true);
});

test('restart with same Store does not reread', async () => {
	const { a, s, meta } = setup();
	a.put('a.md', 'a');
	await s.scanAll();
	const { s: s2, calls } = setup(a, meta);
	a.reads.length = 0;
	expect(await s2.scanAll()).toBe(0);
	expect(a.reads).toEqual([]);
	expect(calls).toEqual([]);
});

test('read failure: not reported as deleted, others proceed, retried next scan', async () => {
	const { a, s, calls } = setup();
	a.put('a.md', 'a');
	a.put('b.md', 'b');
	a.failRead.add('a.md');
	expect(await s.scanAll()).toBe(1);
	expect(paths(calls)).toEqual(['b.md']);
	a.failRead.clear();
	expect(await s.scanAll()).toBe(1);
	expect(paths(calls)).toEqual(['a.md', 'b.md']);
	// failing after being cached must not look like a deletion either
	a.put('a.md', 'aa', 2);
	a.failRead.add('a.md');
	calls.length = 0;
	expect(await s.scanAll()).toBe(0);
	expect(calls).toEqual([]);
});

test('concurrent scanAll does not re-enter', async () => {
	const { a, s, calls } = setup();
	a.put('a.md', 'a');
	let listing = 0;
	let max = 0;
	a.onList = async () => {
		max = Math.max(max, ++listing);
		await new Promise((r) => setTimeout(r, 5));
		listing--;
	};
	const [x, y] = await Promise.all([s.scanAll(), s.scanAll()]);
	expect(max).toBe(1);
	expect([x, y]).toEqual([1, 1]);
	expect(calls).toHaveLength(1);
});

test('onFileEvent checks a single path', async () => {
	const { a, s, calls } = setup();
	a.put('a.md', 'a');
	a.put('b.md', 'b');
	await s.scanAll();
	calls.length = 0;
	a.reads.length = 0;
	a.put('a.md', 'aa', 2);
	expect(await s.onFileEvent('a.md')).toBe(1);
	expect(await s.onFileEvent('b.md')).toBe(0);
	a.files.delete('b.md');
	expect(await s.onFileEvent('b.md')).toBe(1);
	expect(calls.map((c) => c.slice(0, 2))).toEqual([['a.md', 'aa'], ['b.md', null]]);
	expect(a.reads).toEqual(['a.md']);
});

test('onRename reports renamedFrom and no null for old path', async () => {
	const { a, s, calls } = setup();
	a.put('old.md', 'o');
	await s.scanAll();
	calls.length = 0;
	a.files.set('new.md', a.files.get('old.md')!);
	a.files.delete('old.md');
	await s.onRename('old.md', 'new.md');
	expect(calls.map((c) => [c[0], c[1], c[3]])).toEqual([['new.md', 'o', 'old.md']]);
	expect(await s.scanAll()).toBe(0);
});
