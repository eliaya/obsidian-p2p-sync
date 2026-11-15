import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { b64, derive, hex, peerHash, roomHash, setSetting } from '../src/db';

declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}

const ROOM = 'ab'.repeat(16);
const TOKEN = 'test-admin-token';
const url64 = (b: Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function newPeer() {
	const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
	const peerId = hex(await crypto.subtle.digest('SHA-256', raw)).slice(0, 32);
	const query = async (path: string, method = 'GET', ts = Date.now()) => {
		const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(`${method}\n${path}\n${ts}`)));
		return `${path}?peer=${url64(raw)}&ts=${ts}&sig=${url64(sig)}`;
	};
	return { peerId, query };
}
type P = Awaited<ReturnType<typeof newPeer>>;

const call = (path: string, init: RequestInit = {}) => exports.default.fetch(`http://x${path}`, init);
const upgrade = async (p: P) => call(await p.query(`/room/${ROOM}`), { headers: { Upgrade: 'websocket' } });
const register = async (p: P) => (await upgrade(p)).status; // first sight records the peer as pending
const hashOf = (p: P) => peerHash(env, ROOM, p.peerId);
const JSON_H = { 'Content-Type': 'application/json' };

async function login(token = TOKEN) {
	return call('/api/admin/login', { method: 'POST', headers: JSON_H, body: JSON.stringify({ token }) });
}
async function session() {
	return login().then((r) => r.headers.get('Set-Cookie')!.split(';')[0]);
}
// Authenticated admin request.
async function admin(cookie: string, path: string, method = 'GET', data?: unknown) {
	return call(`/api/admin${path}`, { method, headers: { Cookie: cookie, ...JSON_H }, body: data === undefined ? undefined : JSON.stringify(data) });
}
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const rawSettings = async () => (await env.DB.prepare('SELECT key, value_enc FROM settings ORDER BY key').all()).results;

async function connect(p: P) {
	const res = await upgrade(p);
	const ws = res.webSocket!;
	ws.accept();
	const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
	return { res, ws, closed };
}

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
	await env.DB.batch(['peers', 'settings', 'audit_log', 'translations', 'mailbox', 'mailbox_ack'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => vi.restoreAllMocks());

describe('login and cookie', () => {
	test('wrong token 401, right token 204 with full cookie attributes', async () => {
		expect((await login('nope')).status).toBe(401);
		expect((await call('/api/admin/login', { method: 'POST', headers: JSON_H, body: '{}' })).status).toBe(401);
		expect((await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) })).status).toBe(415);
		const ok = await login();
		expect(ok.status).toBe(204);
		const c = ok.headers.get('Set-Cookie')!;
		expect(c).toMatch(/^pvs_session=\d+\.[0-9a-f]{64};/);
		for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/admin', 'Max-Age=43200']) expect(c).toContain(a);
		expect((await admin(await session(), '/overview')).status).toBe(200);
	});

	test('tampered and expired cookies -> 401', async () => {
		const cookie = await session();
		const [exp, mac] = cookie.slice('pvs_session='.length).split('.');
		const later = `pvs_session=${Number(exp) + 1000}.${mac}`;
		const flipped = `pvs_session=${exp}.${(mac[0] === '0' ? '1' : '0') + mac.slice(1)}`;
		const pastExp = String(Date.now() - 1000);
		const pastMac = hex(await crypto.subtle.sign('HMAC', await derive(env, 'cookie'), new TextEncoder().encode(pastExp)));
		for (const bad of [later, flipped, `pvs_session=${pastExp}.${pastMac}`, 'pvs_session=garbage', '']) {
			expect((await admin(bad, '/overview')).status).toBe(401);
		}
	});

	test('logout invalidates every existing cookie; a fresh login works', async () => {
		const cookie = await session();
		const other = await session(); // a second session, e.g. another browser
		const out = await admin(cookie, '/logout', 'POST');
		expect(out.status).toBe(204);
		expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
		expect((await admin(cookie, '/overview')).status).toBe(401);
		expect((await admin(other, '/overview')).status).toBe(401);
		expect((await admin(await session(), '/overview')).status).toBe(200);
	});

	test('session_version is not an API setting', async () => {
		const cookie = await session();
		await admin(cookie, '/logout', 'POST');
		const fresh = await session();
		expect((await admin(fresh, '/settings', 'PUT', { session_version: 0 })).status).toBe(400);
		expect(await (await admin(fresh, '/settings')).text()).not.toContain('session_version');
		const raw = JSON.stringify(await rawSettings());
		expect(raw).toContain('session_version'); // stored, but only as an encrypted value
		expect(raw).not.toContain('"value_enc":"1"');
	});

	test('every admin endpoint without a cookie -> 401 and no data', async () => {
		const routes: [string, string][] = [
			['POST', '/logout'], ['GET', '/overview'], ['GET', '/peers'], ['PATCH', `/peers/${'0'.repeat(64)}`], ['DELETE', `/peers/${'0'.repeat(64)}`],
			['GET', '/settings'], ['PUT', '/settings'], ['PUT', '/i18n/fr'], ['DELETE', '/i18n/fr'], ['GET', '/audit'], ['GET', '/nonexistent'],
		];
		for (const [method, path] of routes) {
			const res = await call(`/api/admin${path}`, { method, headers: JSON_H, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
			expect(res.status, `${method} ${path}`).toBe(401);
			expect(await res.json()).toEqual({ error: 'unauthorized' });
		}
	});

	test('mutating request without JSON content type -> 415', async () => {
		const cookie = await session();
		const res = await call('/api/admin/settings', { method: 'PUT', headers: { Cookie: cookie }, body: '{}' });
		expect(res.status).toBe(415);
	});
});

describe('peers', () => {
	test('list shows label, online and mailboxPendingBytes (own bundles and acked ones excluded)', async () => {
		const a = await newPeer();
		const b = await newPeer();
		await register(a);
		await register(b);
		const [ha, hb, rh] = [await hashOf(a), await hashOf(b), await roomHash(env, ROOM)];
		await env.DB.prepare("UPDATE peers SET status = 'active'").run();
		const cookie = await session();
		expect((await admin(cookie, `/peers/${ha}`, 'PATCH', { label: 'Laptop' })).status).toBe(204);
		const ins = (id: string, sender: string, size: number) => env.DB.prepare('INSERT INTO mailbox VALUES (?, ?, ?, ?, ?)').bind(id, rh, sender, size, Date.now());
		await env.DB.batch([
			ins('m1', ha, 100), ins('m2', hb, 20), ins('m3', hb, 3), // a sent m1; b sent m2, m3
			env.DB.prepare("INSERT INTO mailbox_ack VALUES ('m3', ?)").bind(ha), // a acked m3
		]);
		const { peers } = (await (await admin(cookie, '/peers')).json()) as { peers: any[] };
		const pa = peers.find((p) => p.id === ha);
		const pb = peers.find((p) => p.id === hb);
		expect(pa).toMatchObject({ peerId: a.peerId, room: rh.slice(0, 8), label: 'Laptop', status: 'active', online: false, mailboxPendingBytes: 20 });
		expect(pb).toMatchObject({ peerId: b.peerId, label: null, mailboxPendingBytes: 100 + 0 });
		const c = await connect(a);
		expect(((await (await admin(cookie, '/peers')).json()) as any).peers.find((p: any) => p.id === ha).online).toBe(true);
		c.ws.close();
	});

	test('approve lets a pending peer connect; revoke closes the socket with 4003; then 403 revoked', async () => {
		const a = await newPeer();
		expect(await register(a)).toBe(403);
		const id = await hashOf(a);
		const cookie = await session();
		expect((await admin(cookie, `/peers/${id}`, 'PATCH', { status: 'active' })).status).toBe(204);
		const c = await connect(a);
		expect(c.res.status).toBe(101);
		expect((await admin(cookie, `/peers/${id}`, 'PATCH', { status: 'revoked' })).status).toBe(204);
		expect(await c.closed).toBe(4003);
		const again = await upgrade(a);
		expect(again.status).toBe(403);
		expect(await again.json()).toEqual({ error: 'revoked' });
	});

	test('delete removes the row and its acks, and closes the socket', async () => {
		const a = await newPeer();
		await register(a);
		const id = await hashOf(a);
		const cookie = await session();
		await admin(cookie, `/peers/${id}`, 'PATCH', { status: 'active' });
		const c = await connect(a);
		await env.DB.prepare("INSERT INTO mailbox_ack VALUES ('x', ?)").bind(id).run();
		expect((await admin(cookie, `/peers/${id}`, 'DELETE')).status).toBe(204);
		expect(await c.closed).toBe(4003);
		expect(await count('peers')).toBe(0);
		expect(await count('mailbox_ack')).toBe(0);
		expect((await admin(cookie, `/peers/${id}`, 'DELETE')).status).toBe(404);
	});

	test('bad PATCH bodies -> 400, unknown peer -> 404', async () => {
		const a = await newPeer();
		await register(a);
		const id = await hashOf(a);
		const cookie = await session();
		for (const bad of [{}, { status: 'pending' }, { status: 'bogus' }, { label: 'x'.repeat(65) }, { label: 5 }]) {
			expect((await admin(cookie, `/peers/${id}`, 'PATCH', bad)).status).toBe(400);
		}
		expect((await env.DB.prepare('SELECT status FROM peers').first<{ status: string }>())!.status).toBe('pending');
		expect((await admin(cookie, `/peers/${'0'.repeat(64)}`, 'PATCH', { label: 'x' })).status).toBe(404);
	});

	test('overview counts', async () => {
		const a = await newPeer();
		const b = await newPeer();
		await register(a);
		await register(b);
		await env.DB.prepare("UPDATE peers SET status = 'active' WHERE peer_hash = ?").bind(await hashOf(a)).run();
		await env.DB.prepare("INSERT INTO mailbox VALUES ('m', 'r', 's', 42, 1)").run();
		const res = await admin(await session(), '/overview');
		expect(await res.json()).toEqual({ rooms: 1, peers: { active: 1, pending: 1, revoked: 0, online: 0 }, mailbox: { bundles: 1, bytes: 42 } });
	});

	test('label and turn_api_token are not stored in plaintext', async () => {
		const a = await newPeer();
		await register(a);
		const cookie = await session();
		await admin(cookie, `/peers/${await hashOf(a)}`, 'PATCH', { label: 'My Secret Phone' });
		await admin(cookie, '/settings', 'PUT', { turn_key_id: 'kid', turn_api_token: 'super-secret-token' });
		const dump = JSON.stringify([(await env.DB.prepare('SELECT label_enc, peer_id_enc FROM peers').all()).results, await rawSettings()]);
		expect(dump).not.toContain('My Secret Phone');
		expect(dump).not.toContain('super-secret-token');
		expect(dump).not.toContain(a.peerId);
	});
});

describe('settings', () => {
	test('valid values take effect (max_peers_per_room limits the room), null restores default', async () => {
		const cookie = await session();
		expect((await admin(cookie, '/settings', 'PUT', { max_peers_per_room: 2, require_approval: false })).status).toBe(204);
		const [a, b, c] = [await newPeer(), await newPeer(), await newPeer()];
		await connect(a);
		await connect(b);
		const full = await upgrade(c);
		expect(full.status).toBe(429);
		expect(await full.json()).toEqual({ error: 'room_full' });
		expect(((await (await admin(cookie, '/settings')).json()) as any).max_peers_per_room).toBe(2);
		expect((await admin(cookie, '/settings', 'PUT', { max_peers_per_room: null })).status).toBe(204);
		expect(((await (await admin(cookie, '/settings')).json()) as any).max_peers_per_room).toBe(8);
		expect(await count('settings')).toBe(1); // only require_approval remains
	});

	test('invalid values and unknown keys -> 400 and nothing written', async () => {
		const cookie = await session();
		const bad: unknown[] = [
			{ foo: 1 }, { max_peers_per_room: 1 }, { max_peers_per_room: 33 }, { max_peers_per_room: '8' }, { max_peers_per_room: 2.5 }, { mailbox_ttl_days: 0 },
			{ mailbox_quota_bytes: 1000 }, { mailbox_quota_bytes: 10 * 1024 ** 3 + 1 }, { audit_ttl_days: 3651 }, { require_approval: 'yes' },
			{ turn_key_id: 'x'.repeat(257) }, { turn_api_token: 5 }, { max_peers_per_room: 4, mailbox_ttl_days: 999 }, { __proto__x: 1 }, [], 'str',
		];
		for (const b of bad) expect((await admin(cookie, '/settings', 'PUT', b)).status, JSON.stringify(b)).toBe(400);
		expect(await count('settings')).toBe(0);
		expect(await count('audit_log')).toBe(1); // only the login
		expect((await admin(cookie, '/settings', 'PUT', { mailbox_quota_bytes: 1048576, audit_ttl_days: 3650 })).status).toBe(204);
	});

	test('turn_api_token is never returned', async () => {
		const cookie = await session();
		const put = await admin(cookie, '/settings', 'PUT', { turn_key_id: 'kid', turn_api_token: 'tok-123' });
		expect(await put.text()).toBe('');
		const text = await (await admin(cookie, '/settings')).text();
		expect(text).not.toContain('tok-123');
		expect(JSON.parse(text)).toMatchObject({ turn_key_id: 'kid', turn_api_token_set: true });
		await admin(cookie, '/settings', 'PUT', { turn_api_token: null });
		expect(((await (await admin(cookie, '/settings')).json()) as any).turn_api_token_set).toBe(false);
	});
});

describe('audit', () => {
	test('admin actions leave events; no setting value appears; paging and filters work', async () => {
		const a = await newPeer();
		await register(a);
		const id = await hashOf(a);
		const cookie = await session();
		await admin(cookie, `/peers/${id}`, 'PATCH', { status: 'active' });
		await admin(cookie, `/peers/${id}`, 'PATCH', { status: 'revoked' });
		await admin(cookie, '/settings', 'PUT', { turn_key_id: 'secret-key-id', turn_api_token: 'secret-token-value', max_peers_per_room: 5 });
		await admin(cookie, `/peers/${id}`, 'DELETE');
		const all = (await (await admin(cookie, '/audit')).json()) as { entries: any[]; next: number | null };
		expect(all.entries.map((e) => e.event)).toEqual(['peer_delete', 'setting_change', 'setting_change', 'setting_change', 'peer_revoke', 'peer_approve', 'admin_login']);
		expect(all.next).toBeNull();
		expect(JSON.stringify(all)).not.toContain('secret-key-id');
		expect(all.entries.filter((e) => e.event === 'setting_change').map((e) => e.detail).sort()).toEqual(['max_peers_per_room', 'turn_api_token', 'turn_key_id']);
		expect(all.entries.filter((e) => e.event !== 'setting_change').every((e) => e.detail === null)).toBe(true);
		const rows = JSON.stringify((await env.DB.prepare('SELECT * FROM audit_log').all()).results);
		for (const v of ['secret-key-id', 'secret-token-value']) expect(rows).not.toContain(v);
		expect(all.entries[0]).toMatchObject({ peer: id, room: (await roomHash(env, ROOM)).slice(0, 8) });

		const p1 = (await (await admin(cookie, '/audit?limit=3')).json()) as any;
		expect(p1.entries).toHaveLength(3);
		expect(p1.next).toBe(p1.entries[2].id);
		const p2 = (await (await admin(cookie, `/audit?limit=100&before=${p1.next}`)).json()) as any;
		expect(p2.entries.map((e: any) => e.id)).toEqual(all.entries.slice(3).map((e) => e.id));
		const byEvent = (await (await admin(cookie, '/audit?event=peer_revoke')).json()) as any;
		expect(byEvent.entries.map((e: any) => e.event)).toEqual(['peer_revoke']);
		const byPeer = (await (await admin(cookie, `/audit?peer=${id}`)).json()) as any;
		expect(byPeer.entries.every((e: any) => e.peer === id)).toBe(true);
		expect(byPeer.entries.length).toBe(3);
		for (const q of ['limit=0', 'limit=201', 'limit=x', 'before=x']) expect((await admin(cookie, `/audit?${q}`)).status).toBe(400);
	});
});

describe('turn', () => {
	const activePeer = async () => {
		await setSetting(env, 'require_approval', false);
		return newPeer();
	};
	const post = async (p: P) => call(await p.query(`/turn/${ROOM}`, 'POST'), { method: 'POST' });
	const ICE = [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }];

	test('not configured -> 404 turn_disabled', async () => {
		const res = await post(await activePeer());
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'turn_disabled' });
	});

	test('configured: returns iceServers from upstream; upstream failure -> 502 without the token', async () => {
		const p = await activePeer();
		await setSetting(env, 'turn_key_id', 'KEY1');
		await setSetting(env, 'turn_api_token', 'upstream-token');
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ iceServers: ICE }, { status: 201 })) // built per call: a body cannot cross request contexts;
		const res = await post(p);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ iceServers: ICE });
		const [u, init] = spy.mock.calls[0] as [string, RequestInit];
		expect(u).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/KEY1/credentials/generate-ice-servers');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer upstream-token');
		expect(JSON.parse(init.body as string)).toEqual({ ttl: 86400 });
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'turn'").first<{ n: number }>())!.n).toBe(1);

		for (const upstream of [async () => new Response('upstream-token leaked', { status: 403 }), () => Promise.reject(new Error('upstream-token boom'))]) {
			spy.mockImplementation(upstream);
			const bad = await post(p);
			expect(bad.status).toBe(502);
			expect(await bad.text()).not.toContain('upstream-token');
		}
	});

	test('pending peer -> 403, wrong method -> 404', async () => {
		await setSetting(env, 'turn_key_id', 'KEY1');
		await setSetting(env, 'turn_api_token', 't');
		const p = await newPeer();
		const res = await post(p);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'pending' });
		expect((await call(await p.query(`/turn/${ROOM}`))).status).toBe(404);
		expect((await call(await p.query(`/turn/short`, 'POST'), { method: 'POST' })).status).toBe(404);
	});
});

describe('i18n', () => {
	const doc = { name: 'Français', admin: { 'a.b': 'x' }, plugin: { c: 'y' } };

	test('public read without login, unknown locale 404, write needs login', async () => {
		expect((await call('/api/i18n/fr')).status).toBe(404);
		expect(await (await call('/api/i18n')).json()).toEqual({ locales: [] });
		expect((await call('/api/admin/i18n/fr', { method: 'PUT', headers: JSON_H, body: JSON.stringify(doc) })).status).toBe(401);
		expect((await call('/api/admin/i18n/fr', { method: 'DELETE' })).status).toBe(401);
		expect(await count('translations')).toBe(0);
	});

	test('write, read back, list, delete', async () => {
		const cookie = await session();
		expect((await admin(cookie, '/i18n/fr', 'PUT', doc)).status).toBe(204);
		const res = await call('/api/i18n/fr');
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
		expect(await res.json()).toEqual(doc);
		const list = (await (await call('/api/i18n')).json()) as any;
		expect(list.locales).toMatchObject([{ code: 'fr', name: 'Français' }]);
		expect(typeof list.locales[0].updatedAt).toBe('number');
		expect((await admin(cookie, '/i18n/fr', 'PUT', { ...doc, name: 'FR2' })).status).toBe(204); // overwrite
		expect(((await (await call('/api/i18n/fr')).json()) as any).name).toBe('FR2');
		expect((await admin(cookie, '/i18n/fr', 'DELETE')).status).toBe(204);
		expect((await call('/api/i18n/fr')).status).toBe(404);
		const events = (await env.DB.prepare("SELECT event, peer_hash, bytes, detail FROM audit_log WHERE event = 'i18n_change'").all()).results;
		expect(events).toHaveLength(3);
		expect(events.map((e) => e.detail)).toEqual(['fr', 'fr', 'fr']);
	});

	test('invalid input -> 400 and nothing written', async () => {
		const cookie = await session();
		const big = { ...doc, admin: { k: 'x'.repeat(512 * 1024) } };
		const bad: [string, unknown][] = [
			['Fr', doc], ['f', doc], ['fr_FR', doc], ['fr-', doc],
			['fr', { ...doc, name: '' }], ['fr', { ...doc, name: 'x'.repeat(65) }], ['fr', { ...doc, name: 1 }],
			['fr', { name: 'n', plugin: {} }], ['fr', { ...doc, admin: { a: 1 } }], ['fr', { ...doc, plugin: { a: { b: 'c' } } }],
			['fr', { ...doc, admin: ['x'] }], ['fr', { ...doc, plugin: null }], ['fr', big], ['fr', []], ['fr', 'str'],
		];
		for (const [loc, b] of bad) expect((await admin(cookie, `/i18n/${loc}`, 'PUT', b)).status, `${loc} ${JSON.stringify(b).slice(0, 60)}`).toBe(400);
		expect((await call('/api/admin/i18n/fr', { method: 'PUT', headers: { Cookie: cookie, ...JSON_H }, body: '{not json' })).status).toBe(400);
		expect(await count('translations')).toBe(0);
		expect((await admin(cookie, '/i18n/zh-Hant-TW', 'PUT', doc)).status).toBe(204);
	});
});
