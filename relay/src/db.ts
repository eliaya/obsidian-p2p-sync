export type PeerStatus = 'pending' | 'active' | 'revoked';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

// One HKDF per purpose; DB_ENC_KEY is high-entropy, so a single extract/expand is enough.
// Add a purpose by adding a case to `Purpose` and calling derive(). 'cookie' signs the admin session.
type Purpose = 'enc' | 'mac' | 'cookie';
// Cached per isolate; the key includes DB_ENC_KEY so a changed secret (tests) never reuses a stale key.
const keys = new Map<string, Promise<CryptoKey>>();
export const derive = (env: Env, purpose: Purpose) => {
	const id = `${env.DB_ENC_KEY}/${purpose}`;
	if (!keys.has(id)) keys.set(id, deriveKey(env, purpose));
	return keys.get(id)!;
};
const deriveKey = async (env: Env, purpose: Purpose) => {
	const root = await crypto.subtle.importKey('raw', unb64(env.DB_ENC_KEY), 'HKDF', false, ['deriveKey']);
	const params = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: enc.encode(`pvs/db/${purpose}`) };
	return crypto.subtle.deriveKey(
		params,
		root,
		purpose === 'enc' ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256' },
		false,
		purpose === 'enc' ? ['encrypt', 'decrypt'] : ['sign', 'verify'],
	);
};

// Column encryption. Output is base64(nonce || ciphertext+tag).
export async function encrypt(env: Env, text: string): Promise<string> {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await derive(env, 'enc'), enc.encode(text)));
	return b64(new Uint8Array([...nonce, ...ct]));
}

export async function decrypt(env: Env, value: string): Promise<string> {
	const raw = unb64(value);
	return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await derive(env, 'enc'), raw.slice(12)));
}

export async function hmac(env: Env, text: string): Promise<string> {
	return hex(await crypto.subtle.sign('HMAC', await derive(env, 'mac'), enc.encode(text)));
}

// Domain-separated lookup hashes. peer_hash includes the room: one device may sit in several rooms.
export const roomHash = (env: Env, roomId: string) => hmac(env, `room\n${roomId}`);
export const peerHash = (env: Env, roomId: string, peerId: string) => hmac(env, `peer\n${roomId}\n${peerId}`);

// ---- settings ----

const DEFAULTS = {
	require_approval: true,
	max_peers_per_room: 8,
	mailbox_ttl_days: 30,
	mailbox_quota_bytes: 1073741824,
	audit_ttl_days: 90,
} as Record<string, unknown>;

export async function getSettings(env: Env): Promise<Record<string, unknown>> {
	const { results } = await env.DB.prepare('SELECT key, value_enc FROM settings').all<{ key: string; value_enc: string }>();
	const out = { ...DEFAULTS };
	for (const r of results) out[r.key] = JSON.parse(await decrypt(env, r.value_enc));
	return out;
}

export async function setSetting(env: Env, key: string, value: unknown) {
	await env.DB.prepare('INSERT INTO settings (key, value_enc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc')
		.bind(key, await encrypt(env, JSON.stringify(value)))
		.run();
}

// Admin session version (encrypted like any setting, but not in RULES, so the API cannot touch it).
export async function getSessionVersion(env: Env): Promise<number> {
	const row = await env.DB.prepare("SELECT value_enc FROM settings WHERE key = 'session_version'").first<{ value_enc: string }>();
	return row ? JSON.parse(await decrypt(env, row.value_enc)) : 0;
}
export async function bumpSessionVersion(env: Env) {
	await setSetting(env, 'session_version', (await getSessionVersion(env)) + 1);
}

export async function deleteSetting(env: Env, key: string) {
	await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

const MB = 1024 * 1024;
const int = (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const str = (v: unknown) => typeof v === 'string' && v.length <= 256;
const RULES: Record<string, (v: unknown) => boolean> = {
	require_approval: (v) => typeof v === 'boolean',
	max_peers_per_room: int(2, 32),
	mailbox_ttl_days: int(1, 365),
	mailbox_quota_bytes: int(MB, 10 * 1024 * MB),
	audit_ttl_days: int(1, 3650),
	turn_key_id: str,
	turn_api_token: str,
};

// True when every key is known and every value is in range (null clears the key).
export const validSettings = (body: Record<string, unknown>) => Object.entries(body).every(([k, v]) => Object.hasOwn(RULES, k) && (v === null || RULES[k](v)));

// ---- peers ----

const MAX_PENDING = 50;

// Returns the peer's status; first sight inserts it as pending/active per `require_approval`.
export async function registerPeer(env: Env, roomId: string, peerId: string): Promise<PeerStatus | 'too_many_pending'> {
	const ph = await peerHash(env, roomId, peerId);
	const row = await env.DB.prepare('SELECT status FROM peers WHERE peer_hash = ?').bind(ph).first<{ status: PeerStatus }>();
	if (row) return row.status;
	const status: PeerStatus = (await getSettings(env)).require_approval ? 'pending' : 'active';
	if (status === 'pending') {
		const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM peers WHERE status = 'pending'").first<{ n: number }>())!;
		if (n >= MAX_PENDING) return 'too_many_pending';
	}
	const now = Date.now();
	await env.DB.prepare('INSERT OR IGNORE INTO peers (peer_hash, room_hash, peer_id_enc, status, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(ph, await roomHash(env, roomId), await encrypt(env, peerId), status, now, now)
		.run();
	return status;
}

export async function setOnline(env: Env, peerHash: string, online: boolean) {
	await env.DB.prepare('UPDATE peers SET online = ?, last_seen = ? WHERE peer_hash = ?').bind(online ? 1 : 0, Date.now(), peerHash).run();
}

export async function listActivePeers(env: Env, roomId: string): Promise<{ peerId: string; online: boolean }[]> {
	const { results } = await env.DB.prepare("SELECT peer_id_enc, online FROM peers WHERE room_hash = ? AND status = 'active'")
		.bind(await roomHash(env, roomId))
		.all<{ peer_id_enc: string; online: number }>();
	return Promise.all(results.map(async (r) => ({ peerId: await decrypt(env, r.peer_id_enc), online: r.online === 1 })));
}

// ---- audit: never an IP, never a payload ----

// `detail` is only ever a setting key or a locale code, never a value.
export async function audit(env: Env, event: string, roomHash: string | null, peerHash: string | null, bytes: number | null = null, detail: string | null = null) {
	await env.DB.prepare('INSERT INTO audit_log (ts, room_hash, peer_hash, event, bytes, detail) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(Date.now(), roomHash, peerHash, event, bytes, detail)
		.run();
}
