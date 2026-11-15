import { audit, getSettings, peerHash, roomHash } from './db';

type Row = { id: string; sender_hash: string; size: number; created_at: number };

// The caller (index.ts) has already verified the signature and that the peer is active.
export async function handleMailbox(req: Request, env: Env, roomId: string, peerId: string, id?: string): Promise<Response> {
	const rh = await roomHash(env, roomId);
	const ph = await peerHash(env, roomId, peerId);

	if (!id) {
		if (req.method === 'GET') {
			const { results } = await env.DB.prepare(
				'SELECT id, size, created_at FROM mailbox WHERE room_hash = ? AND sender_hash != ? AND id NOT IN (SELECT bundle_id FROM mailbox_ack WHERE peer_hash = ?) ORDER BY created_at',
			)
				.bind(rh, ph, ph)
				.all<Row>();
			return Response.json({ bundles: results.map((r) => ({ id: r.id, size: r.size, createdAt: r.created_at })) });
		}
		if (req.method !== 'PUT') return new Response('Not found', { status: 404 });

		const size = Number(req.headers.get('Content-Length'));
		if (!req.headers.get('Content-Length') || !Number.isInteger(size) || size < 0) return new Response('Length required', { status: 411 });
		const used = (await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM mailbox WHERE room_hash = ?').bind(rh).first<{ n: number }>())!.n;
		if (used + size > Number((await getSettings(env)).mailbox_quota_bytes)) return Response.json({ error: 'quota' }, { status: 413 });
		const newId = crypto.randomUUID();
		const obj = (await env.MAILBOX.put(`${rh}/${newId}`, req.body))!; // null only with an onlyIf option
		await env.DB.prepare('INSERT INTO mailbox (id, room_hash, sender_hash, size, created_at) VALUES (?, ?, ?, ?, ?)')
			.bind(newId, rh, ph, obj.size, Date.now())
			.run();
		await audit(env, 'mailbox_put', rh, ph, obj.size);
		return Response.json({ id: newId });
	}

	const row = await env.DB.prepare('SELECT sender_hash FROM mailbox WHERE id = ? AND room_hash = ?').bind(id, rh).first<Row>();
	if (req.method === 'DELETE' && !row) return new Response(null, { status: 204 }); // already gone: acknowledging again is fine
	if (!row) return new Response('Not found', { status: 404 });

	if (req.method === 'GET') {
		const obj = await env.MAILBOX.get(`${rh}/${id}`);
		return obj ? new Response(obj.body, { headers: { 'Content-Type': 'application/octet-stream' } }) : new Response('Not found', { status: 404 });
	}
	if (req.method !== 'DELETE') return new Response('Not found', { status: 404 });

	// The sender never acknowledges; with no other active peer the bundle stays for a later one.
	if (row.sender_hash !== ph) {
		const [, pending] = await env.DB.batch<{ n: number }>([
			env.DB.prepare('INSERT OR IGNORE INTO mailbox_ack (bundle_id, peer_hash) VALUES (?, ?)').bind(id, ph),
			env.DB.prepare(
				"SELECT COUNT(*) AS n FROM peers WHERE room_hash = ? AND status = 'active' AND peer_hash != ? AND peer_hash NOT IN (SELECT peer_hash FROM mailbox_ack WHERE bundle_id = ?)",
			).bind(rh, row.sender_hash, id),
		]);
		await audit(env, 'mailbox_ack', rh, ph);
		if (pending.results[0].n === 0) {
			await env.MAILBOX.delete(`${rh}/${id}`);
			await env.DB.batch([env.DB.prepare('DELETE FROM mailbox_ack WHERE bundle_id = ?').bind(id), env.DB.prepare('DELETE FROM mailbox WHERE id = ?').bind(id)]);
		}
	}
	return new Response(null, { status: 204 });
}
