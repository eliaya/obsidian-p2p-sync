// WebCrypto only (runs on iOS). Parameters per docs/protocol.md.
const enc = new TextEncoder();
const subtle = crypto.subtle;

export function toBase64Url(b: Uint8Array): string {
	let s = '';
	for (const x of b) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
	const p = s.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const hex = (b: ArrayBuffer | Uint8Array) =>
	[...new Uint8Array(b instanceof Uint8Array ? b : b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export function generateVaultKey(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function deriveKeys(vaultKey: string): Promise<{ roomId: string; signalKey: CryptoKey; mailboxKey: CryptoKey }> {
	const root = await subtle.importKey('raw', fromBase64Url(vaultKey) as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
	const p = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) });
	const aes = (info: string) => subtle.deriveKey(p(info), root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
	return {
		roomId: hex(await subtle.deriveBits(p('pvs/room'), root, 128)),
		signalKey: await aes('pvs/signal'),
		mailboxKey: await aes('pvs/mailbox'),
	};
}

export async function encrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data as BufferSource));
	const out = new Uint8Array(12 + ct.length);
	out.set(nonce);
	out.set(ct, 12);
	return out;
}

export async function decrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12)));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
	return hex(await subtle.digest('SHA-256', data as BufferSource));
}

export async function generateIdentity(): Promise<{ keyPair: CryptoKeyPair; publicKey: string; peerId: string }> {
	// Extractable pair, then re-import the private half as non-extractable; the public key is always exportable.
	const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);
	const privateKey = await subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
	const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
	return {
		keyPair: { privateKey, publicKey: pair.publicKey },
		publicKey: toBase64Url(raw),
		peerId: (await sha256Hex(raw)).slice(0, 32),
	};
}

export async function signRequest(privateKey: CryptoKey, method: string, pathname: string, ts: number): Promise<string> {
	const msg = enc.encode(`${method}\n${pathname}\n${ts}`);
	return toBase64Url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, msg)));
}
