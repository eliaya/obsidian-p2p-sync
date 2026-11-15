import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { b64, hex, peerHash, setSetting } from '../src/db';

declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}

const ROOM = 'ab'.repeat(16);
const url64 = (b: Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const get = (path: string) => exports.default.fetch(`http://x${path}`);

async function connect(p: P, room = ROOM) {
	const res = await exports.default.fetch(`http://x${await p.query(`/room/${room}`)}`, { headers: { Upgrade: 'websocket' } });
	const ws = res.webSocket!;
	ws.accept();
	const msgs: any[] = [];
	ws.addEventListener('message', (e) => {
		msgs.push(JSON.parse(e.data as string));
	});
	const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => {
			r(e.code);
		}));
	return { res, ws, msgs, closed };
}
const upgrade = async (p: P, room = ROOM) => exports.default.fetch(`http://x${await p.query(`/room/${room}`)}`, { headers: { Upgrade: 'websocket' } });
const setStatus = (p: P, s: string) => env.DB.prepare("UPDATE peers SET status = ?").bind(s).run(); // only one peer per test uses this

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
	await env.DB.batch([env.DB.prepare('DELETE FROM peers'), env.DB.prepare('DELETE FROM settings'), env.DB.prepare('DELETE FROM audit_log')]);
});

describe('auth', () => {
	test('missing, bad and stale signatures -> 401', async () => {
		const a = await newPeer();
		const b = await newPeer();
		expect((await get(`/room/${ROOM}/peers`)).status).toBe(401);
		const q = await a.query(`/room/${ROOM}/peers`);
		const forged = q.replace(/sig=.*/, 'sig=' + (await b.query(`/room/${ROOM}/peers`)).split('sig=')[1]);
		const bad = await get(forged);
		expect(bad.status).toBe(401);
		expect(await bad.json()).toEqual({ error: 'unauthorized' });
		const stale = await get(await a.query(`/room/${ROOM}/peers`, Date.now() - 6 * 60_000));
		expect(stale.status).toBe(401);
		// signature over a different path must not verify
		const other = (await a.query('/room/other/peers')).replace('/room/other/peers', `/room/${ROOM}/peers`);
		expect((await get(other)).status).toBe(401);
	});
});

describe('abuse checks', () => {
	test('malformed roomId -> 404 and nothing written', async () => {
		const a = await newPeer();
		for (const bad of ['short', 'AB'.repeat(16), 'zz'.repeat(16)]) {
			expect((await get(await a.query(`/room/${bad}/peers`))).status).toBe(404);
			expect((await get(await a.query(`/mailbox/${bad}`))).status).toBe(404);
		}
		expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM peers').first<{ n: number }>())!.n).toBe(0);
	});

	test('50 pending peers -> the next new peer gets 429', async () => {
		for (let i = 0; i < 50; i++) await get(await (await newPeer()).query(`/room/${ROOM}/peers`));
		const res = await get(await (await newPeer()).query(`/room/${ROOM}/peers`));
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: 'too_many_pending' });
		expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM peers').first<{ n: number }>())!.n).toBe(50);
	});
});

describe('approval', () => {
	test('pending -> 403, active -> connects, revoked -> 403', async () => {
		const a = await newPeer();
		const res = await upgrade(a);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'pending' });
		const rows = await env.DB.prepare('SELECT status FROM peers').all<{ status: string }>();
		expect(rows.results.map((r) => r.status)).toEqual(['pending']);

		await setStatus(a, 'active');
		const c = await connect(a);
		expect(c.res.status).toBe(101);
		c.ws.close();

		await setStatus(a, 'revoked');
		const r = await upgrade(a);
		expect(r.status).toBe(403);
		expect(await r.json()).toEqual({ error: 'revoked' });
	});

	test('require_approval=false registers active', async () => {
		await setSetting(env, 'require_approval', false);
		const a = await newPeer();
		expect((await get(await a.query(`/room/${ROOM}/peers`))).status).toBe(200);
		expect((await env.DB.prepare('SELECT status FROM peers').first<{ status: string }>())!.status).toBe('active');
	});
});

describe('signalling', () => {
	beforeEach(() => setSetting(env, 'require_approval', false));

	test('peers / join / signal / leave', async () => {
		const [a, b, c] = await Promise.all([newPeer(), newPeer(), newPeer()]);
		const A = await connect(a);
		await sleep(50);
		expect(A.msgs).toEqual([{ t: 'peers', peers: [] }]);
		const B = await connect(b);
		await sleep(50);
		expect(B.msgs[0]).toEqual({ t: 'peers', peers: [a.peerId] });
		expect(A.msgs[1]).toEqual({ t: 'join', peer: b.peerId });
		const C = await connect(c);
		await sleep(50);

		A.ws.send(JSON.stringify({ to: b.peerId, data: 'hello' }));
		await sleep(50);
		expect(B.msgs.at(-1)).toEqual({ t: 'signal', from: a.peerId, data: 'hello' });
		expect(C.msgs.some((m) => m.t === 'signal')).toBe(false);
		expect(A.msgs.some((m) => m.t === 'signal')).toBe(false);

		A.ws.close(1000);
		await sleep(100);
		expect(B.msgs.at(-1)).toEqual({ t: 'leave', peer: a.peerId });
		B.ws.close();
		C.ws.close();
	});

	test('frame over 16 KB closes with 1009', async () => {
		const a = await newPeer();
		const A = await connect(a);
		A.ws.send(JSON.stringify({ to: 'x', data: 'a'.repeat(16 * 1024) }));
		expect(await A.closed).toBe(1009);
		await sleep(100);
		const ev = await env.DB.prepare("SELECT event FROM audit_log WHERE peer_hash = ? ORDER BY id").bind(await peerHash(env, ROOM, a.peerId)).all<{ event: string }>();
		expect(ev.results.map((e) => e.event)).toEqual(["join", "leave"]);
	});

	test('room full -> 429', async () => {
		await setSetting(env, 'max_peers_per_room', 2);
		const [a, b, c] = await Promise.all([newPeer(), newPeer(), newPeer()]);
		const A = await connect(a);
		const B = await connect(b);
		const res = await upgrade(c);
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: 'room_full' });
		A.ws.close();
		B.ws.close();
	});

	test('same peer reconnecting replaces the old socket', async () => {
		const [a, b] = await Promise.all([newPeer(), newPeer()]);
		const A1 = await connect(a);
		const B = await connect(b);
		const A2 = await connect(a);
		expect(await A1.closed).toBe(4000);
		await sleep(100);
		expect(B.msgs.filter((m) => m.t === 'leave')).toEqual([]);
		expect(A2.msgs[0]).toEqual({ t: 'peers', peers: [b.peerId] });
		const row = await env.DB.prepare('SELECT online FROM peers WHERE room_hash IS NOT NULL ORDER BY first_seen').all<{ online: number }>();
		expect(row.results.every((r) => r.online === 1)).toBe(true);
		A2.ws.close();
		B.ws.close();
	});

	test('GET /peers lists active peers with online state', async () => {
		const [a, b] = await Promise.all([newPeer(), newPeer()]);
		const A = await connect(a);
		await sleep(50);
		await get(await b.query(`/room/${ROOM}/peers`)); // registers b (active), offline
		const res = await get(await b.query(`/room/${ROOM}/peers`));
		const { peers } = (await res.json()) as { peers: { peerId: string; online: boolean }[] };
		expect(peers.sort((x, y) => x.peerId.localeCompare(y.peerId))).toEqual(
			[
				{ peerId: a.peerId, online: true },
				{ peerId: b.peerId, online: false },
			].sort((x, y) => x.peerId.localeCompare(y.peerId)),
		);
		A.ws.close();
		await sleep(100);
		const after = (await (await get(await b.query(`/room/${ROOM}/peers`))).json()) as { peers: { online: boolean }[] };
		expect(after.peers.every((p) => !p.online)).toBe(true);
		const events = await env.DB.prepare("SELECT event FROM audit_log WHERE peer_hash = ? ORDER BY id").bind(await peerHash(env, ROOM, a.peerId)).all<{ event: string }>();
		expect(events.results.map((e) => e.event)).toEqual(['join', 'leave']);
	});
});

describe('storage', () => {
	test('no raw ids in peers, settings encrypted', async () => {
		await setSetting(env, 'require_approval', false);
		const a = await newPeer();
		const A = await connect(a);
		await sleep(50);
		A.ws.close();
		const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM peers').all()).results) + JSON.stringify((await env.DB.prepare('SELECT * FROM audit_log').all()).results);
		expect(dump).not.toContain(a.peerId);
		expect(dump).not.toContain(ROOM);
		const s = await env.DB.prepare("SELECT value_enc FROM settings WHERE key = 'require_approval'").first<{ value_enc: string }>();
		expect(s!.value_enc).not.toContain('false');
		expect(atob(s!.value_enc).length).toBeGreaterThan(12 + 16);
	});
});
