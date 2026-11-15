import { handleAdmin, handleI18n, handleTurn } from './admin';
import { verifyPeer } from './auth';
import { cleanup } from './cron';
import { handleMailbox } from './mailbox';
import { getSettings, listActivePeers, peerHash, registerPeer, roomHash } from './db';

export { Room } from './room';

const err = (error: string, status: number) => Response.json({ error }, { status });

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === '/health') return Response.json({ ok: true });

		if (url.pathname === '/api/i18n' || url.pathname.startsWith('/api/i18n/')) return handleI18n(req, env);
		if (url.pathname.startsWith('/api/admin/')) return handleAdmin(req, env);

		const m = url.pathname.match(/^\/(room|mailbox|turn)\/([^/]+)(?:\/([^/]+))?$/);
		if (!m || !/^[0-9a-f]{32}$/.test(m[2])) return new Response('Not found', { status: 404 });
		const [, kind, roomId, sub] = m;
		if (kind === 'room' && (req.method !== 'GET' || (sub && sub !== 'peers'))) return new Response('Not found', { status: 404 });
		if (kind === 'turn' && (req.method !== 'POST' || sub)) return new Response('Not found', { status: 404 });
		const peersPath = sub === 'peers';
		const upgrade = req.headers.get('Upgrade') === 'websocket';
		if (kind === 'room' && !peersPath && !upgrade) return new Response('Expected websocket', { status: 426 });

		const peerId = await verifyPeer(req);
		if (!peerId) return err('unauthorized', 401);
		const status = await registerPeer(env, roomId, peerId);
		if (status === 'too_many_pending') return err(status, 429);
		if (status !== 'active') return err(status, 403);

		if (kind === 'turn') return handleTurn(env, roomId, peerId);
		if (kind === 'mailbox') return handleMailbox(req, env, roomId, peerId, sub);
		if (peersPath) return Response.json({ peers: await listActivePeers(env, roomId) });

		const rh = await roomHash(env, roomId);
		const headers = new Headers(req.headers);
		headers.set('x-peer-id', peerId);
		headers.set('x-peer-hash', await peerHash(env, roomId, peerId));
		headers.set('x-room-hash', rh);
		headers.set('x-max-peers', String((await getSettings(env)).max_peers_per_room));
		return env.ROOM.get(env.ROOM.idFromName(rh)).fetch(new Request(req, { headers }));
	},
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(cleanup(env));
	},
} satisfies ExportedHandler<Env>;
