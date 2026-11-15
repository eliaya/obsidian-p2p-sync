import { getSettings } from './db';

const DAY = 86_400_000;

// shortcut: one run removes at most 1000 expired bundles (R2 delete limit); the rest goes next day.
export async function cleanup(env: Env) {
	const s = await getSettings(env);
	const now = Date.now();
	const { results } = await env.DB.prepare('SELECT id, room_hash FROM mailbox WHERE created_at < ? LIMIT 1000')
		.bind(now - Number(s.mailbox_ttl_days) * DAY)
		.all<{ id: string; room_hash: string }>();
	if (results.length) await env.MAILBOX.delete(results.map((r) => `${r.room_hash}/${r.id}`));
	const ids = JSON.stringify(results.map((r) => r.id));
	await env.DB.batch([
		env.DB.prepare('DELETE FROM mailbox_ack WHERE bundle_id IN (SELECT value FROM json_each(?))').bind(ids),
		env.DB.prepare('DELETE FROM mailbox WHERE id IN (SELECT value FROM json_each(?))').bind(ids),
		env.DB.prepare('DELETE FROM audit_log WHERE ts < ?').bind(now - Number(s.audit_ttl_days) * DAY),
	]);
}
