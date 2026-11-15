import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { IdbStore } from './store';
import type { Revision } from './types';

let n = 0;
const open = () => IdbStore.open(`db${n++}`);
const rev = (deviceId: string, seq: number, path: string, parents: string[] = [], mtime = seq, blobHash: string | null = null): Revision => ({
	id: `${deviceId}:${seq}`, path, blobHash, size: 0, mtime, deviceId, seq, parents, deleted: blobHash === null,
});
const ids = (r: Revision[]) => r.map((x) => x.id);

test('vector and getRevision', async () => {
	const s = await open();
	expect(await s.vector()).toEqual({});
	for (const r of [rev('a', 1, 'x'), rev('a', 2, 'x', ['a:1']), rev('b', 1, 'y'), rev('c', 1, 'z'), rev('c', 5, 'z')]) await s.putRevision(r);
	expect(await s.vector()).toEqual({ a: 2, b: 1, c: 5 });
	expect((await s.getRevision('a:2'))?.parents).toEqual(['a:1']);
	expect(await s.getRevision('nope')).toBeUndefined();
	expect((await s.paths()).sort()).toEqual(['x', 'y', 'z']);
});

test('revisionsSince, including unknown devices', async () => {
	const s = await open();
	for (const r of [rev('a', 1, 'x'), rev('a', 2, 'x'), rev('a', 3, 'x'), rev('b', 1, 'y'), rev('b', 2, 'y')]) await s.putRevision(r);
	expect(ids(await s.revisionsSince({ a: 1 }))).toEqual(['a:2', 'a:3', 'b:1', 'b:2']);
	expect(ids(await s.revisionsSince({ a: 3, b: 1 }))).toEqual(['b:2']);
	expect(ids(await s.revisionsSince({ a: 3, b: 2 }))).toEqual([]);
	expect(ids(await s.revisionsSince({}))).toHaveLength(5);
});

test('heads: chain has one, fork has two', async () => {
	const s = await open();
	await s.putRevision(rev('a', 1, 'p'));
	await s.putRevision(rev('a', 2, 'p', ['a:1']));
	expect(ids(await s.heads('p'))).toEqual(['a:2']);
	await s.putRevision(rev('b', 1, 'p', ['a:1']));
	expect(ids(await s.heads('p')).sort()).toEqual(['a:2', 'b:1']);
	await s.putRevision(rev('a', 3, 'p', ['a:2', 'b:1']));
	expect(ids(await s.heads('p'))).toEqual(['a:3']);
	expect(await s.heads('none')).toEqual([]);
});

test('history is newest first', async () => {
	const s = await open();
	await s.putRevision(rev('a', 1, 'p', [], 10));
	await s.putRevision(rev('a', 2, 'p', ['a:1'], 30));
	await s.putRevision(rev('b', 1, 'p', ['a:1'], 20));
	await s.putRevision(rev('c', 1, 'other', [], 99));
	expect(ids(await s.history('p'))).toEqual(['a:2', 'b:1', 'a:1']);
});

test('blobs and meta', async () => {
	const s = await open();
	expect(await s.hasBlob('h')).toBe(false);
	await s.putBlob('h', new Uint8Array([1, 2, 3]));
	expect(await s.hasBlob('h')).toBe(true);
	expect(await s.getBlob('h')).toEqual(new Uint8Array([1, 2, 3]));
	expect(await s.getBlob('x')).toBeUndefined();
	await s.setMeta('k', { a: 1 });
	expect(await s.getMeta('k')).toEqual({ a: 1 });
	expect(await s.getMeta('nope')).toBeUndefined();
});

test('prune drops only unreferenced blobs, never revisions', async () => {
	const s = await open();
	// p: a:1(h1) -> a:2(h2) -> a:3(h3, head); all old
	await s.putRevision(rev('a', 1, 'p', [], 1, 'h1'));
	await s.putRevision(rev('a', 2, 'p', ['a:1'], 2, 'h2'));
	await s.putRevision(rev('a', 3, 'p', ['a:2'], 3, 'h3'));
	// q: a:4(h4, recent non-head) -> a:5(h5, head)
	await s.putRevision(rev('a', 4, 'q', [], 100, 'h4'));
	await s.putRevision(rev('a', 5, 'q', ['a:4'], 101, 'h5'));
	// r: old non-head r1 shares h6 with its head r2
	await s.putRevision(rev('b', 1, 'r', [], 1, 'h6'));
	await s.putRevision(rev('b', 2, 'r', ['b:1'], 2, 'h6'));
	for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'orphan']) await s.putBlob(h, new Uint8Array([1]));
	await s.prune(50);
	expect(ids(await s.history('p'))).toEqual(['a:3', 'a:2', 'a:1']);
	expect(ids(await s.history('q'))).toEqual(['a:5', 'a:4']);
	expect(await s.vector()).toEqual({ a: 5, b: 2 });
	for (const h of ['h3', 'h4', 'h5', 'h6']) expect(await s.hasBlob(h)).toBe(true);
	for (const h of ['h1', 'h2', 'orphan']) expect(await s.hasBlob(h)).toBe(false);
});

test('data survives close and reopen', async () => {
	const s = await IdbStore.open('persist');
	await s.putRevision(rev('a', 1, 'p'));
	await s.putBlob('h', new Uint8Array([9]));
	await s.setMeta('k', 1);
	s.close();
	const t = await IdbStore.open('persist');
	expect(await t.vector()).toEqual({ a: 1 });
	expect(await t.getBlob('h')).toEqual(new Uint8Array([9]));
	expect(await t.getMeta('k')).toBe(1);
});
