import { derive, getSessionVersion, hex, unb64 } from './db';

const MAX_SKEW_MS = 5 * 60 * 1000;

// Returns the peerId when the request carries a valid signature, otherwise null (caller answers 401).
export async function verifyPeer(request: Request): Promise<string | null> {
	const url = new URL(request.url);
	const { peer, ts, sig } = Object.fromEntries(url.searchParams);
	if (!peer || !ts || !sig) return null;
	const t = Number(ts);
	if (!Number.isFinite(t) || Math.abs(Date.now() - t) > MAX_SKEW_MS) return null;
	try {
		const raw = unb64(peer);
		const key = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
		const ok = await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			key,
			unb64(sig),
			new TextEncoder().encode(`${request.method}\n${url.pathname}\n${ts}`),
		);
		if (!ok) return null;
		return hex(await crypto.subtle.digest('SHA-256', raw)).slice(0, 32);
	} catch {
		return null;
	}
}

// ---- admin session: stateless cookie `expiryMs.hmac` ----

const COOKIE = 'pvs_session';
const SESSION_MS = 43_200_000;
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const cookieKey = (env: Env) => derive(env, 'cookie');

// token is 256-bit random, so a plain SHA-256 comparison is enough (no key stretching).
export async function checkAdminToken(env: Env, token: unknown): Promise<boolean> {
	if (typeof token !== 'string') return false;
	const want = unhex(env.ADMIN_TOKEN_HASH);
	const got = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
	return want.length === got.length && got.reduce((d, b, i) => d | (b ^ want[i]), 0) === 0; // constant time
}

export async function sessionCookie(env: Env): Promise<string> {
	const exp = String(Date.now() + SESSION_MS);
	const mac = hex(await crypto.subtle.sign('HMAC', await cookieKey(env), new TextEncoder().encode(`${exp}.${await getSessionVersion(env)}`)));
	return `${COOKIE}=${exp}.${mac}; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=${SESSION_MS / 1000}`;
}

export const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=0`;

export async function hasSession(req: Request, env: Env): Promise<boolean> {
	const raw = req.headers.get('Cookie')?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
	const m = raw?.match(/^(\d{1,16})\.([0-9a-f]{64})$/);
	if (!m || Number(m[1]) <= Date.now()) return false;
	return crypto.subtle.verify('HMAC', await cookieKey(env), unhex(m[2]), new TextEncoder().encode(`${m[1]}.${await getSessionVersion(env)}`));
}
