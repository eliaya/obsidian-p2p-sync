import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext, type D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import worker from '../src/index';
import { b64, hex, peerHash, roomHash, setSetting } from '../src/db';

declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}

const ROOM = 'ab'.repeat(16);
const ROOM2 = 'cd'.repeat(16);
const url64 = (b: Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function newPeer() {
	const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
	const peerId = hex(await crypto.subtle.digest('SHA-256', raw)).slice(0, 32);
	const query = async (path: string, ts = Date.now(), method = 'GET') => {
		const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(`${method}\n${path}\n${ts}`)));
		return `${path}?peer=${url64(raw)}&ts=${ts}&sig=${url64(sig)}`;
	};
	return { peerId, query };
}
type P = Awaited<ReturnType<typeof newPeer>>;

const call = async (p: P, method: string, path: string, body?: BodyInit | Uint8Array, headers: Record<string, string> = {}) =>
	exports.default.fetch(`http://x${await p.query(path, Date.now(), method)}`, { method, body: body as BodyInit, headers });
const put = (p: P, bytes: Uint8Array, room = ROOM) => call(p, 'PUT', `/mailbox/${room}`, bytes, { 'Content-Length': String(bytes.length) });
const list = async (p: P, room = ROOM) => ((await (await call(p, 'GET', `/mailbox/${room}`)).json()) as { bundles: { id: string; size: number }[] }).bundles;
const r2Keys = async () => (await env.MAILBOX.list()).objects.map((o) => o.key);
const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
const peers = async (n: number) => Promise.all(Array.from({ length: n }, newPeer));

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
	await env.DB.batch(['peers', 'settings', 'audit_log', 'mailbox', 'mailbox_ack'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
	await env.MAILBOX.delete(await r2Keys());
	await setSetting(env, 'require_approval', false);
});

describe('mailbox', () => {
	test('unsigned -> 401, pending -> 403', async () => {
		expect((await exports.default.fetch(`http://x/mailbox/${ROOM}`)).status).toBe(401);
		await setSetting(env, 'require_approval', true);
		const [a] = await peers(1);
		const res = await call(a, 'GET', `/mailbox/${ROOM}`);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'pending' });
	});

	test('upload, list, download identical bytes, ack empties list', async () => {
		const [a, b] = await peers(2);
		await call(b, 'GET', `/mailbox/${ROOM}`); // register b as active
		const bytes = crypto.getRandomValues(new Uint8Array(1000));
		const { id } = (await (await put(a, bytes)).json()) as { id: string };
		expect(await list(a)).toEqual([]);
		expect((await list(b)).map((x) => [x.id, x.size])).toEqual([[id, 1000]]);
		const dl = await call(b, 'GET', `/mailbox/${ROOM}/${id}`);
		expect(new Uint8Array(await dl.arrayBuffer())).toEqual(bytes);
		expect((await call(b, 'DELETE', `/mailbox/${ROOM}/${id}`)).status).toBe(204);
		expect(await list(b)).toEqual([]);
		expect(await r2Keys()).toEqual([]);
		const ev = await env.DB.prepare('SELECT event, bytes FROM audit_log WHERE event LIKE ? ORDER BY id').bind('mailbox%').all();
		expect(ev.results).toEqual([
			{ event: 'mailbox_put', bytes: 1000 },
			{ event: 'mailbox_ack', bytes: null },
		]);
	});

	test('three peers: deleted only after both others ack; repeat ack is fine', async () => {
		const [a, b, c] = await peers(3);
		await call(b, 'GET', `/mailbox/${ROOM}`);
		await call(c, 'GET', `/mailbox/${ROOM}`);
		const { id } = (await (await put(a, new Uint8Array([1, 2, 3]))).json()) as { id: string };
		expect((await call(b, 'DELETE', `/mailbox/${ROOM}/${id}`)).status).toBe(204);
		expect((await call(b, 'DELETE', `/mailbox/${ROOM}/${id}`)).status).toBe(204);
		expect(await r2Keys()).toHaveLength(1);
		expect(await count('mailbox')).toBe(1);
		expect((await list(c)).length).toBe(1);
		await call(c, 'DELETE', `/mailbox/${ROOM}/${id}`);
		expect(await r2Keys()).toEqual([]);
		expect(await count('mailbox')).toBe(0);
		expect(await count('mailbox_ack')).toBe(0);
		expect((await call(c, 'DELETE', `/mailbox/${ROOM}/${id}`)).status).toBe(204);
	});

	test('sole active peer: bundle is kept', async () => {
		const [a] = await peers(1);
		const { id } = (await (await put(a, new Uint8Array([9]))).json()) as { id: string };
		await call(a, 'DELETE', `/mailbox/${ROOM}/${id}`);
		expect(await r2Keys()).toHaveLength(1);
		expect(await count('mailbox')).toBe(1);
	});

	test('over quota -> 413, nothing stored', async () => {
		await setSetting(env, 'mailbox_quota_bytes', 10);
		const [a] = await peers(1);
		expect((await put(a, new Uint8Array(6))).status).toBe(200);
		const res = await put(a, new Uint8Array(6));
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: 'quota' });
		expect(await r2Keys()).toHaveLength(1);
	});

	test('missing Content-Length -> 411', async () => {
		const [a] = await peers(1);
		const body = new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array([1])), c.close()) });
		const res = await call(a, 'PUT', `/mailbox/${ROOM}`, body);
		expect(res.status).toBe(411);
		expect(await r2Keys()).toEqual([]);
	});

	test('bundle of another room -> 404', async () => {
		const [a, b] = await peers(2);
		const { id } = (await (await put(a, new Uint8Array([1]))).json()) as { id: string };
		await call(b, 'GET', `/mailbox/${ROOM2}`);
		expect((await call(b, 'GET', `/mailbox/${ROOM2}/${id}`)).status).toBe(404);
	});

	test('DB holds neither roomId nor peerId', async () => {
		const [a] = await peers(1);
		await put(a, new Uint8Array([1]));
		const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM mailbox').all()).results);
		expect(dump).not.toContain(ROOM);
		expect(dump).not.toContain(a.peerId);
		expect(dump).toContain(await roomHash(env, ROOM));
		expect(dump).toContain(await peerHash(env, ROOM, a.peerId));
	});
});

describe('cleanup', () => {
	test('scheduled removes expired bundles and audit rows only', async () => {
		const [a] = await peers(1);
		const old = ((await (await put(a, new Uint8Array([1]))).json()) as { id: string }).id;
		const fresh = ((await (await put(a, new Uint8Array([2]))).json()) as { id: string }).id;
		const DAY = 86_400_000;
		await env.DB.batch([
			env.DB.prepare('UPDATE mailbox SET created_at = ? WHERE id = ?').bind(Date.now() - 31 * DAY, old),
			env.DB.prepare('INSERT INTO audit_log (ts, event) VALUES (?, ?)').bind(Date.now() - 91 * DAY, 'join'),
		]);
		const auditBefore = await count('audit_log');

		const ctx = createExecutionContext();
		await worker.scheduled!(createScheduledController(), env, ctx);
		await waitOnExecutionContext(ctx);

		const rest = (await env.DB.prepare('SELECT id FROM mailbox').all<{ id: string }>()).results.map((r) => r.id);
		expect(rest).toEqual([fresh]);
		expect(await r2Keys()).toHaveLength(1);
		expect(await count('audit_log')).toBe(auditBefore - 1);
	});
});
