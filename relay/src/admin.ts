import { checkAdminToken, clearCookie, hasSession, sessionCookie } from './auth';
import { audit, bumpSessionVersion, decrypt, deleteSetting, encrypt, getSettings, peerHash, roomHash, setSetting, validSettings } from './db';

const err = (error: string, status: number) => Response.json({ error }, { status });
const noContent = (headers?: HeadersInit) => new Response(null, { status: 204, headers });
const body = async (req: Request): Promise<Record<string, unknown> | null> => {
	const b = await req.json().catch(() => null);
	return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
};

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// GET /api/i18n and /api/i18n/:locale: public, the strings are not secret.
export async function handleI18n(req: Request, env: Env): Promise<Response> {
	const path = new URL(req.url).pathname;
	if (req.method !== 'GET') return err('not_found', 404);
	if (path === '/api/i18n') {
		const { results } = await env.DB.prepare('SELECT locale, name, updated_at FROM translations ORDER BY locale').all<{ locale: string; name: string; updated_at: number }>();
		return Response.json({ locales: results.map((r) => ({ code: r.locale, name: r.name, updatedAt: r.updated_at })) });
	}
	const locale = path.slice('/api/i18n/'.length);
	const row = LOCALE.test(locale) ? await env.DB.prepare('SELECT name, data FROM translations WHERE locale = ?').bind(locale).first<{ name: string; data: string }>() : null;
	if (!row) return err('not_found', 404);
	return Response.json({ name: row.name, ...JSON.parse(row.data) }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}

export async function handleAdmin(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname.slice('/api/admin'.length);
	const mutating = req.method !== 'GET' && req.method !== 'HEAD';
	const json = req.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json';

	if (path === '/login' && req.method === 'POST') {
		if (!json) return err('unsupported_media_type', 415);
		if (!(await checkAdminToken(env, (await body(req))?.token))) return err('unauthorized', 401);
		await audit(env, 'admin_login', null, null);
		return noContent({ 'Set-Cookie': await sessionCookie(env) });
	}
	if (!(await hasSession(req, env))) return err('unauthorized', 401);
	if (mutating && !json) return err('unsupported_media_type', 415);

	if (path === '/logout' && req.method === 'POST') {
		await bumpSessionVersion(env); // invalidates every cookie issued so far
		return noContent({ 'Set-Cookie': clearCookie });
	}

	if (path === '/overview' && req.method === 'GET') {
		const [p, m] = await env.DB.batch<Record<string, number>>([
			env.DB.prepare(
				"SELECT COUNT(DISTINCT room_hash) AS rooms, COUNT(CASE WHEN status = 'active' THEN 1 END) AS active, COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending, COUNT(CASE WHEN status = 'revoked' THEN 1 END) AS revoked, COALESCE(SUM(online), 0) AS online FROM peers",
			),
			env.DB.prepare('SELECT COUNT(*) AS bundles, COALESCE(SUM(size), 0) AS bytes FROM mailbox'),
		]);
		const { rooms, ...peers } = p.results[0];
		return Response.json({ rooms, peers, mailbox: m.results[0] });
	}

	if (path === '/peers' && req.method === 'GET') {
		const { results } = await env.DB.prepare(
			`SELECT p.peer_hash, p.room_hash, p.peer_id_enc, p.label_enc, p.status, p.online, p.first_seen, p.last_seen,
				(SELECT COALESCE(SUM(m.size), 0) FROM mailbox m WHERE m.room_hash = p.room_hash AND m.sender_hash != p.peer_hash
					AND NOT EXISTS (SELECT 1 FROM mailbox_ack a WHERE a.bundle_id = m.id AND a.peer_hash = p.peer_hash)) AS pending_bytes
			FROM peers p ORDER BY p.first_seen`,
		).all<{ peer_hash: string; room_hash: string; peer_id_enc: string; label_enc: string | null; status: string; online: number; first_seen: number; last_seen: number; pending_bytes: number }>();
		const peers = await Promise.all(
			results.map(async (r) => ({
				id: r.peer_hash,
				peerId: await decrypt(env, r.peer_id_enc),
				room: r.room_hash.slice(0, 8),
				label: r.label_enc === null ? null : await decrypt(env, r.label_enc),
				status: r.status,
				online: r.online === 1,
				firstSeen: r.first_seen,
				lastSeen: r.last_seen,
				mailboxPendingBytes: r.pending_bytes,
			})),
		);
		return Response.json({ peers });
	}

	const pm = path.match(/^\/peers\/([0-9a-f]{64})$/);
	if (pm && (req.method === 'PATCH' || req.method === 'DELETE')) {
		const id = pm[1];
		const row = await env.DB.prepare('SELECT room_hash FROM peers WHERE peer_hash = ?').bind(id).first<{ room_hash: string }>();
		if (!row) return err('not_found', 404);
		const room = env.ROOM.get(env.ROOM.idFromName(row.room_hash));
		if (req.method === 'DELETE') {
			await env.DB.batch([env.DB.prepare('DELETE FROM mailbox_ack WHERE peer_hash = ?').bind(id), env.DB.prepare('DELETE FROM peers WHERE peer_hash = ?').bind(id)]);
			await room.kick(id);
			await audit(env, 'peer_delete', row.room_hash, id);
			return noContent();
		}
		const b = await body(req);
		const { status, label } = b ?? {};
		if (!b || (status === undefined && label === undefined)) return err('bad_request', 400);
		if ((status !== undefined && status !== 'active' && status !== 'revoked') || (label !== undefined && (typeof label !== 'string' || label.length > 64))) return err('bad_request', 400);
		if (status !== undefined) await env.DB.prepare('UPDATE peers SET status = ? WHERE peer_hash = ?').bind(status, id).run();
		if (label !== undefined) await env.DB.prepare('UPDATE peers SET label_enc = ? WHERE peer_hash = ?').bind(await encrypt(env, label as string), id).run();
		if (status === 'revoked') await room.kick(id);
		if (status !== undefined) await audit(env, status === 'active' ? 'peer_approve' : 'peer_revoke', row.room_hash, id);
		return noContent();
	}

	const im = path.match(/^\/i18n\/([^/]+)$/);
	if (im && req.method === 'PUT') {
		const text = await req.text();
		let b: Record<string, unknown> | null = null;
		try {
			b = JSON.parse(text);
		} catch {}
		const flat = (m: unknown) => !!m && typeof m === 'object' && !Array.isArray(m) && Object.values(m).every((v) => typeof v === 'string');
		if (!LOCALE.test(im[1]) || new TextEncoder().encode(text).length > 512 * 1024 || !b || typeof b !== 'object' || Array.isArray(b)) return err('bad_request', 400);
		if (typeof b.name !== 'string' || b.name.length < 1 || b.name.length > 64 || !flat(b.admin) || !flat(b.plugin)) return err('bad_request', 400);
		await env.DB.prepare('INSERT INTO translations (locale, name, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(locale) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at')
			.bind(im[1], b.name, JSON.stringify({ admin: b.admin, plugin: b.plugin }), Date.now())
			.run();
		await audit(env, 'i18n_change', null, null, null, im[1]);
		return noContent();
	}
	if (im && req.method === 'DELETE') {
		if (!LOCALE.test(im[1])) return err('not_found', 404);
		await env.DB.prepare('DELETE FROM translations WHERE locale = ?').bind(im[1]).run();
		await audit(env, 'i18n_change', null, null, null, im[1]);
		return noContent();
	}

	if (path === '/settings' && req.method === 'GET') {
		const { turn_api_token, session_version: _, ...rest } = await getSettings(env);
		return Response.json({ ...rest, turn_api_token_set: typeof turn_api_token === 'string' });
	}
	if (path === '/settings' && req.method === 'PUT') {
		const b = await body(req);
		if (!b || !validSettings(b)) return err('bad_request', 400);
		for (const [k, v] of Object.entries(b)) {
			if (v === null) await deleteSetting(env, k);
			else await setSetting(env, k, v);
			await audit(env, 'setting_change', null, null, null, k);
		}
		return noContent();
	}

	if (path === '/audit' && req.method === 'GET') {
		const q = url.searchParams;
		const limit = q.has('limit') ? Number(q.get('limit')) : 50;
		const before = q.has('before') ? Number(q.get('before')) : null;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (before !== null && !Number.isInteger(before))) return err('bad_request', 400);
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (before !== null) (where.push('id < ?'), args.push(before));
		if (q.has('event')) (where.push('event = ?'), args.push(q.get('event')!));
		if (q.has('peer')) (where.push('peer_hash = ?'), args.push(q.get('peer')!));
		const { results } = await env.DB.prepare(
			`SELECT id, ts, room_hash, peer_hash, event, bytes, detail FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
		)
			.bind(...args, limit + 1)
			.all<{ id: number; ts: number; room_hash: string | null; peer_hash: string | null; event: string; bytes: number | null; detail: string | null }>();
		const page = results.slice(0, limit);
		return Response.json({
			entries: page.map((r) => ({ id: r.id, ts: r.ts, room: r.room_hash?.slice(0, 8) ?? null, peer: r.peer_hash, event: r.event, bytes: r.bytes, detail: r.detail })),
			next: results.length > limit ? page[page.length - 1].id : null,
		});
	}

	return err('not_found', 404);
}

// POST /turn/:roomId; the caller (index.ts) has already verified the signature and that the peer is active.
export async function handleTurn(env: Env, roomId: string, peerId: string): Promise<Response> {
	const s = await getSettings(env);
	if (typeof s.turn_key_id !== 'string' || typeof s.turn_api_token !== 'string') return err('turn_disabled', 404);
	let ice: unknown;
	try {
		const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(s.turn_key_id)}/credentials/generate-ice-servers`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${s.turn_api_token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ttl: 86400 }),
			signal: AbortSignal.timeout(5000),
		});
		if (res.status === 201) ice = ((await res.json()) as { iceServers?: unknown }).iceServers;
	} catch {}
	if (!Array.isArray(ice)) return err('turn_upstream', 502);
	await audit(env, 'turn', await roomHash(env, roomId), await peerHash(env, roomId, peerId));
	return Response.json({ iceServers: ice });
}
