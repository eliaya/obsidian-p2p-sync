import { describe, expect, test } from 'vitest';
import { BASE, dec, del, enc, expectSame, node, pair, put, snapshot, sync, tick } from './sync.testkit';

describe('SyncEngine', () => {
	test('one-way add, modify, delete, rename', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, 'n.md', 'hello');
		await put(a, 'img.bin', new Uint8Array([1, 2, 3]));
		expect((await sync(a, b)).res.every((r) => r.status === 'fulfilled')).toBe(true);
		await expectSame(a, b);
		expect(dec(b.vault.files.get('n.md'))).toBe('hello');

		await put(a, 'n.md', 'hello world');
		await sync(a, b);
		await expectSame(a, b);
		expect(dec(b.vault.files.get('n.md'))).toBe('hello world');

		await del(a, 'img.bin');
		await sync(a, b);
		await expectSame(a, b);
		expect(b.vault.files.has('img.bin')).toBe(false);

		const d = a.vault.files.get('n.md')!;
		a.vault.files.delete('n.md');
		a.vault.files.set('m.md', d);
		await a.eng.recordLocal('m.md', d, 900_000, 'n.md');
		await sync(a, b);
		await expectSame(a, b);
		expect([...b.vault.files.keys()]).toEqual(['m.md']);
		expect((await b.store.heads('m.md'))[0]!.renamedFrom).toBe('n.md');
		expect(b.conflicts).toEqual([]);
	});

	test('ignored path: revisions are kept but the local file is neither overwritten nor recorded', async () => {
		const a = node('A');
		const b = node('B');
		Object.assign(b.vault, { ignores: (p: string) => p === 'secret.md' });
		b.vault.files.set('secret.md', enc('mine'));
		await put(a, 'secret.md', 'theirs');
		await put(a, 'shared.md', 'ok');
		await sync(a, b);
		expect(dec(b.vault.files.get('secret.md'))).toBe('mine');
		expect(dec(b.vault.files.get('shared.md'))).toBe('ok');
		expect((await b.store.heads('secret.md')).map((h) => h.deviceId)).toEqual(['A']);
	});

	test('recordLocal with unchanged content makes no revision', async () => {
		const a = node('A');
		await put(a, 'x.md', 'same');
		await put(a, 'x.md', 'same');
		expect(await a.store.vector()).toEqual({ A: 1 });
	});

	test('both sides change different files', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, 'a.md', 'from a');
		await put(b, 'b.md', 'from b');
		await sync(a, b);
		await expectSame(a, b);
		expect(Object.keys(snapshot(a))).toEqual(['a.md', 'b.md']);
	});

	test('same .md, different paragraphs: three-way merge keeps both edits', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, 'n.md', BASE);
		await sync(a, b);
		await put(a, 'n.md', BASE.replace('apples', 'green apples'));
		await put(b, 'n.md', BASE.replace('plums', 'ripe plums'));
		await sync(a, b);
		await expectSame(a, b);
		const text = dec(a.vault.files.get('n.md'))!;
		expect(text).toContain('green apples');
		expect(text).toContain('ripe plums');
		expect(a.conflicts[0]?.kind).toBe('merge');
	});

	test('same .md, same sentence edited both ways: no merge, newer wins, loser in history', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, 'n.md', BASE);
		await sync(a, b);
		await put(b, 'n.md', BASE.replace('talks about pears', 'mentions quinces'), 5000);
		await put(a, 'n.md', BASE.replace('talks about pears', 'is about figs'), 6000);
		await sync(a, b);
		await expectSame(a, b);
		expect(dec(b.vault.files.get('n.md'))).toBe(BASE.replace('talks about pears', 'is about figs'));
		for (const n of [a, b]) {
			expect(n.conflicts[0]).toMatchObject({ path: 'n.md', kind: 'pick', winner: { id: 'A:2' } });
			const loser = (await n.store.history('n.md')).find((r) => r.id === 'B:1')!;
			expect(dec(await n.store.getBlob(loser.blobHash!))).toContain('mentions quinces');
		}
	});

	test('same binary file: newer wins, loser stays in history', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, 'f.bin', new Uint8Array([0]));
		await sync(a, b);
		await put(b, 'f.bin', new Uint8Array([4, 5, 6]), 5000);
		await put(a, 'f.bin', new Uint8Array([1, 2, 3]), 6000);
		await sync(a, b);
		await expectSame(a, b);
		expect([...b.vault.files.get('f.bin')!]).toEqual([1, 2, 3]);
		for (const n of [a, b]) {
			const loser = (await n.store.history('f.bin')).find((r) => r.id === 'B:1')!;
			expect([...(await n.store.getBlob(loser.blobHash!))!]).toEqual([4, 5, 6]);
			expect(n.conflicts[0]).toMatchObject({ path: 'f.bin', kind: 'pick', winner: { id: 'A:2' } });
		}
	});

	test('delete on one side, modify on the other: modification wins', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, 'n.md', BASE);
		await sync(a, b);
		await del(a, 'n.md');
		await put(b, 'n.md', BASE + 'more\n');
		await sync(a, b);
		await expectSame(a, b);
		expect(dec(a.vault.files.get('n.md'))).toBe(BASE + 'more\n');
	});

	test.each([
		['text', 'n.md', BASE.replace('apples', 'red apples'), BASE.replace('pears', 'soft pears')],
		['binary', 'f.bin', new Uint8Array([7]), new Uint8Array([8])],
	])('both sides resolve the same %s conflict independently, then converge without looping', async (_k, path, va, vb) => {
		const a = node('A');
		const b = node('B');
		await put(a, path, BASE);
		await sync(a, b);
		await put(a, path, va);
		await put(b, path, vb);
		// Each learns the other's edit through the mailbox and resolves on its own.
		const ba = await b.eng.exportBundle(await a.store.vector());
		const ab = await a.eng.exportBundle(await b.store.vector());
		await a.eng.importBundle(ba);
		await b.eng.importBundle(ab);
		expect(a.conflicts).toHaveLength(1);
		expect(b.conflicts).toHaveLength(1);
		expect(snapshot(a)).toEqual(snapshot(b));

		await sync(a, b);
		await expectSame(a, b);
		const vv = await a.store.vector();
		expect(vv).toEqual({ A: 3, B: 2 }); // base + edit + own merge each; no merge of the two merges
		await sync(a, b);
		await expectSame(a, b);
		expect(await a.store.vector()).toEqual(vv);
		expect(a.conflicts).toHaveLength(1);
		expect(b.conflicts).toHaveLength(1);
	});

	test('channel cut mid-sync: reconnect converges without resending what arrived', async () => {
		const a = node('A');
		const b = node('B');
		for (const p of ['1.md', '2.md', '3.md', '4.md']) await put(a, p, `content of ${p}`);
		const first = await sync(a, b, 8);
		expect(first.res.every((r) => r.status === 'rejected')).toBe(true);
		const got = first.sent[0]!.flatMap((m) => (m.t === 'blob' ? [m.hash] : []));
		expect(got.length).toBeGreaterThan(0);
		expect(got.length).toBeLessThan(4);
		expect(b.vault.files.size).toBe(got.length); // what arrived is applied, nothing written empty

		const second = await sync(a, b);
		expect(second.res.every((r) => r.status === 'fulfilled')).toBe(true);
		const again = second.sent[0]!.flatMap((m) => (m.t === 'blob' ? [m.hash] : []));
		expect(again.filter((h) => got.includes(h))).toEqual([]);
		expect(second.sent[0]!.flatMap((m) => (m.t === 'revs' ? m.revs : []))).toEqual([]);
		await expectSame(a, b);
	});

	test('revision without its content does not touch the vault', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, 'n.md', 'v1');
		await sync(a, b);
		await put(a, 'n.md', 'v2');
		await del(a, 'n.md');
		const bundle = await a.eng.exportBundle(await b.store.vector());
		await b.eng.importBundle({ revs: bundle.revs.slice(0, 1), blobs: [] });
		expect(dec(b.vault.files.get('n.md'))).toBe('v1');
		await b.eng.importBundle(bundle);
		expect(b.vault.files.has('n.md')).toBe(false);
	});

	test('importing the same bundle twice creates nothing new', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, 'n.md', BASE);
		await sync(a, b);
		await put(a, 'n.md', BASE.replace('apples', 'red apples'));
		await put(a, 'x.bin', new Uint8Array([9]));
		await put(b, 'n.md', BASE.replace('plums', 'blue plums')); // forces a merge on import
		const bundle = await a.eng.exportBundle(await b.store.vector());
		await b.eng.importBundle(bundle);
		const vv = await b.store.vector();
		const snap = snapshot(b);
		await b.eng.importBundle(structuredClone(bundle));
		expect(await b.store.vector()).toEqual(vv);
		expect(snapshot(b)).toEqual(snap);
		expect(b.conflicts).toHaveLength(1);
	});

	test('bundle with a gap is not half-applied', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, '1.md', 'one');
		await put(a, '2.md', 'two');
		const bundle = await a.eng.exportBundle({});
		expect(await b.eng.importBundle({ revs: bundle.revs.slice(1), blobs: bundle.blobs })).toEqual({ gaps: 1 });
		expect(await b.store.vector()).toEqual({}); // A:2 without A:1 would make the vector lie
		await b.eng.importBundle(bundle);
		await expectSame(a, b);
	});

	test.each([
		[['AB', 'BC', 'AC']],
		[['AC', 'BC', 'AB']],
		[['BC', 'AB', 'AC']],
	])('three nodes converge in order %j', async (order) => {
		const n = { A: node('A'), B: node('B'), C: node('C') };
		await put(n.A, 'n.md', BASE);
		await put(n.A, 'f.bin', new Uint8Array([0]));
		await sync(n.A, n.B);
		await sync(n.B, n.C);
		await put(n.A, 'n.md', BASE.replace('apples', 'red apples'));
		await put(n.B, 'n.md', BASE.replace('pears', 'soft pears'));
		await put(n.C, 'n.md', BASE.replace('plums', 'blue plums'));
		await put(n.A, 'f.bin', new Uint8Array([1]), 7000);
		await put(n.C, 'f.bin', new Uint8Array([3]), 8000);
		await put(n.B, 'own-b.md', 'b');
		const pass = async () => {
			for (const [x, y] of order) await sync(n[x as 'A'], n[y as 'A']);
		};
		await pass();
		await pass();
		await expectSame(n.A, n.B, n.C);
		const vv = await n.A.store.vector();
		await pass();
		await expectSame(n.A, n.B, n.C);
		expect(await n.A.store.vector()).toEqual(vv);
		const text = dec(n.A.vault.files.get('n.md'))!;
		expect(text).toContain('red apples');
		expect(text).toContain('soft pears');
		expect(text).toContain('blue plums');
		expect([...n.B.vault.files.get('f.bin')!]).toEqual([3]);
	});

	test('unrecorded local change in the vault is recorded and merged, not overwritten', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, 'n.md', BASE);
		await sync(a, b);
		b.vault.files.set('n.md', enc(BASE.replace('plums', 'secret plums'))); // scanner has not reported it
		await put(a, 'n.md', BASE.replace('apples', 'red apples'));
		await sync(a, b);
		await expectSame(a, b);
		const text = dec(b.vault.files.get('n.md'))!;
		expect(text).toContain('secret plums');
		expect(text).toContain('red apples');
		expect((await b.store.history('n.md')).some((r) => r.deviceId === 'B' && !r.parents.includes('A:2'))).toBe(true);
	});
	test('connect again on an open channel syncs a later change', async () => {
		const a = node('A');
		const b = node('B');
		const ch = pair();
		await Promise.all([a.eng.connect(ch.a), b.eng.connect(ch.b)]);
		await put(a, 'n.md', 'later');
		await a.eng.connect(ch.a);
		await tick();
		expect(dec(b.vault.files.get('n.md'))).toBe('later');
		await expectSame(a, b);
	});

	test('connect during a running round adds one more round', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, '1.md', 'one');
		const ch = pair();
		const first = Promise.all([a.eng.connect(ch.a), b.eng.connect(ch.b)]);
		await put(a, '2.md', 'two');
		const second = a.eng.connect(ch.a);
		await first;
		await second;
		await tick();
		expect(dec(b.vault.files.get('2.md'))).toBe('two');
		await expectSame(a, b);
	});

	test('connect on a closed channel rejects', async () => {
		const a = node('A');
		const b = node('B');
		await put(a, '1.md', 'one');
		const ch = pair(1);
		await Promise.allSettled([a.eng.connect(ch.a), b.eng.connect(ch.b)]);
		await expect(a.eng.connect(ch.a)).rejects.toThrow('channel closed');
	});
});
