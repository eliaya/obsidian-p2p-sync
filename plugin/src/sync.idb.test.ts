import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import { IdbStore } from './store';
import { BASE, dec, del, expectSame, node, put, snapshot, sync } from './sync.testkit';

let dbs = 0;
const idbNode = async (id: string) => node(id, await IdbStore.open(`sync-idb-${dbs++}`));

describe('SyncEngine on IdbStore', () => {
	test('add, modify, delete converge', async () => {
		const a = await idbNode('A');
		const b = await idbNode('B');
		await put(a, 'n.md', 'one');
		await put(b, 'img.bin', new Uint8Array([1, 2]));
		await sync(a, b);
		await expectSame(a, b);
		await put(b, 'n.md', 'two');
		await del(a, 'img.bin');
		await sync(a, b);
		await expectSame(a, b);
		expect(snapshot(a)).toEqual({ 'n.md': [...new TextEncoder().encode('two')] });
	});

	test('three-way merge of the same .md', async () => {
		const a = await idbNode('A');
		const b = await idbNode('B');
		await put(a, 'n.md', BASE);
		await sync(a, b);
		await put(a, 'n.md', BASE.replace('apples', 'green apples'));
		await put(b, 'n.md', BASE.replace('plums', 'ripe plums'));
		await sync(a, b);
		await expectSame(a, b);
		expect(dec(a.vault.files.get('n.md'))).toBe(BASE.replace('apples', 'green apples').replace('plums', 'ripe plums'));
		expect(a.conflicts[0]?.kind).toBe('merge');
	});

	test('cut mid-sync, then reconnect converges', async () => {
		const a = await idbNode('A');
		const b = await idbNode('B');
		for (const p of ['1.md', '2.md', '3.md', '4.md']) await put(a, p, `content of ${p}`);
		const first = await sync(a, b, 8);
		expect(first.res.every((r) => r.status === 'rejected')).toBe(true);
		const got = first.sent[0]!.flatMap((m) => (m.t === 'blob' ? [m.hash] : []));
		expect(got.length).toBeGreaterThan(0);
		expect(got.length).toBeLessThan(4);
		const second = await sync(a, b);
		expect(second.res.every((r) => r.status === 'fulfilled')).toBe(true);
		const again = second.sent[0]!.flatMap((m) => (m.t === 'blob' ? [m.hash] : []));
		expect(again.filter((h) => got.includes(h))).toEqual([]);
		await expectSame(a, b);
	});

	test('prune on A, then sync with B and a fresh C: no revision lost, latest content applied', async () => {
		const a = await idbNode('A');
		const b = await idbNode('B');
		await put(a, 'f.md', 'v1', 1000);
		await put(a, 'f.md', 'v2', 2000);
		await put(a, 'f.md', 'v3', 3000);
		await sync(a, b);
		await a.eng.prune(3000);
		const old = (await a.store.history('f.md')).filter((r) => r.mtime < 3000);
		expect(old).toHaveLength(2);
		for (const r of old) expect(await a.store.hasBlob(r.blobHash!)).toBe(false);
		await put(a, 'f.md', 'v4', 4000);

		const c = await idbNode('C');
		const ab = await sync(a, b);
		const ac = await sync(a, c);
		expect([...ab.res, ...ac.res].every((r) => r.status === 'fulfilled')).toBe(true);
		await expectSame(a, b, c);
		expect(dec(c.vault.files.get('f.md'))).toBe('v4');
		expect(await c.store.vector()).toEqual({ A: 4 });
		expect((await c.store.history('f.md')).map((r) => r.id).sort()).toEqual(['A:1', 'A:2', 'A:3', 'A:4']);

		// C still wants the pruned content; it does not block anything, it is just asked for again.
		const missing = (await c.store.getMeta<Record<string, number>>('sync:missing')) ?? {};
		expect(Object.keys(missing).sort()).toEqual(old.map((r) => r.blobHash!).sort());
		const again = await sync(a, c);
		expect(again.res.every((r) => r.status === 'fulfilled')).toBe(true);
		expect(again.sent[1]!.filter((m) => m.t === 'want').map((m) => m.t === 'want' && m.hashes.length)).toEqual([2]);
		expect(Object.keys((await c.store.getMeta<Record<string, number>>('sync:missing'))!)).toHaveLength(2);
		// Once the whole room has expired that history, nobody asks for it any more.
		await b.eng.prune(3000);
		await c.eng.prune(3000);
		expect(await c.store.getMeta('sync:missing')).toEqual({});
		const wants = [...(await sync(a, c)).sent[1]!, ...(await sync(b, c)).sent[1]!].flatMap((m) => (m.t === 'want' ? m.hashes : []));
		expect(wants).toEqual([]);
		await expectSame(a, b, c);
		expect(dec(c.vault.files.get('f.md'))).toBe('v4');
	});
	test('content pruned on A but still on B reaches C through B', async () => {
		const a = await idbNode('A');
		const b = await idbNode('B');
		const c = await idbNode('C');
		await put(a, 'f.md', 'v1', 1000);
		await put(a, 'f.md', 'v2', 2000);
		await sync(a, b);
		await a.eng.prune(2000);
		await sync(a, c);
		expect(Object.keys((await c.store.getMeta<Record<string, number>>('sync:missing'))!)).toHaveLength(1);
		await sync(b, c);
		expect(await c.store.getMeta('sync:missing')).toEqual({});
		const v1 = (await c.store.history('f.md')).find((r) => r.id === 'A:1')!;
		expect(dec(await c.store.getBlob(v1.blobHash!))).toBe('v1');
	});
});
