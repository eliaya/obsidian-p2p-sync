import { expect, test, vi } from 'vitest';
vi.mock('obsidian', () => ({ Modal: class {}, FuzzySuggestModal: class {}, Notice: class {}, PluginSettingTab: class {}, Setting: class {} }));
import { asText, compare, diffLines, formatBytes, loadHistory } from './history';
import { MemStore } from './sync.testkit';
import type { Revision } from './types';

const SELF = 'aaaa1111bbbb2222cccc3333dddd4444';
const OTHER = 'ffff0000eeee1111dddd2222cccc3333';
const r = (deviceId: string, seq: number, mtime: number, extra: Partial<Revision> = {}): Revision => ({
	id: `${deviceId}:${seq}`,
	path: 'n.md',
	blobHash: `h${deviceId[0]}${seq}`,
	size: 10,
	mtime,
	deviceId,
	seq,
	parents: [],
	deleted: false,
	...extra,
});

test('history rows: newest first, this device, expired content, deletion and rename', async () => {
	const s = new MemStore();
	await s.putRevision(r(SELF, 1, 100, { renamedFrom: 'old.md' }));
	await s.putRevision(r(OTHER, 1, 300));
	await s.putRevision(r(SELF, 2, 200, { blobHash: null, deleted: true, size: 0 }));
	await s.putRevision(r(OTHER, 2, 300)); // same mtime: higher seq first
	await s.putRevision(r(OTHER, 9, 50, { path: 'other.md' }));
	await s.putBlob(`h${OTHER[0]}1`, new Uint8Array([1]));
	await s.putBlob(`h${OTHER[0]}2`, new Uint8Array([2]));
	const rows = await loadHistory(s, 'n.md', SELF);
	expect(rows.map((x) => x.rev.id)).toEqual([`${OTHER}:2`, `${OTHER}:1`, `${SELF}:2`, `${SELF}:1`]);
	expect(rows.map((x) => x.self)).toEqual([false, false, true, true]);
	expect(rows[0]!.device).toBe('ffff 0000');
	expect(rows.map((x) => x.available)).toEqual([true, true, false, false]); // deletion has no content; SELF:1 was pruned
	expect(rows[2]!.rev.deleted).toBe(true);
	expect(rows[3]!.rev.renamedFrom).toBe('old.md');
});

test('line diff with collapsed context', () => {
	const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
	const b = a.replace('line 10\n', 'line ten\n');
	expect(diffLines(a, b, 2)).toEqual([
		{ op: 'skip', count: 8 },
		{ op: 'same', lines: ['line 8', 'line 9'] },
		{ op: 'del', lines: ['line 10'] },
		{ op: 'add', lines: ['line ten'] },
		{ op: 'same', lines: ['line 11', 'line 12'] },
		{ op: 'skip', count: 7 },
	]);
	expect(diffLines('x\n', 'x\ny\n')).toEqual([
		{ op: 'same', lines: ['x'] },
		{ op: 'add', lines: ['y'] },
	]);
});

test('compare: same, gone, text, binary', () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	expect(compare(enc('a'), 'h1', enc('a'), 'h1')).toEqual({ kind: 'same' });
	expect(compare(enc('a'), 'h1', null, null)).toEqual({ kind: 'gone' });
	expect(compare(enc('a\n'), 'h1', enc('b\n'), 'h2')).toEqual({ kind: 'text', parts: [{ op: 'del', lines: ['a'] }, { op: 'add', lines: ['b'] }] });
	const bin = new Uint8Array([0xff, 0xfe, 0]);
	expect(compare(bin, 'h1', enc('abcd'), 'h2')).toEqual({ kind: 'binary', oldSize: 3, newSize: 4, sameHash: false });
	expect(asText(new Uint8Array([0x61, 0]))).toBeNull();
	expect(formatBytes(512)).toBe('512 B');
	expect(formatBytes(1536)).toBe('1.5 KB');
	expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
});
