import { expect, test } from 'vitest';
import { decrypt, deriveKeys, encrypt, fromBase64Url, generateIdentity, generateVaultKey, sha256Hex, signRequest, toBase64Url } from './crypto';

const data = new TextEncoder().encode('hello vault');

test('encrypt/decrypt round trip, format nonce||ct+tag', async () => {
	const { mailboxKey } = await deriveKeys(generateVaultKey());
	const ct = await encrypt(mailboxKey, data);
	expect(ct.length).toBe(12 + data.length + 16);
	expect(await decrypt(mailboxKey, ct)).toEqual(data);
});

test('tampered ciphertext and wrong key throw', async () => {
	const a = await deriveKeys(generateVaultKey());
	const b = await deriveKeys(generateVaultKey());
	const ct = await encrypt(a.mailboxKey, data);
	const bad = ct.slice();
	bad[20] = (bad[20] ?? 0) ^ 1;
	await expect(decrypt(a.mailboxKey, bad)).rejects.toThrow();
	await expect(decrypt(b.mailboxKey, ct)).rejects.toThrow();
});

test('deriveKeys is deterministic per vaultKey', async () => {
	const vk = generateVaultKey();
	const a = await deriveKeys(vk);
	const b = await deriveKeys(vk);
	expect(a.roomId).toMatch(/^[0-9a-f]{32}$/);
	expect(a.roomId).toBe(b.roomId);
	expect(await decrypt(b.signalKey, await encrypt(a.signalKey, data))).toEqual(data);
	expect((await deriveKeys(generateVaultKey())).roomId).not.toBe(a.roomId);
});

test('signalKey and mailboxKey differ', async () => {
	const k = await deriveKeys(generateVaultKey());
	await expect(decrypt(k.signalKey, await encrypt(k.mailboxKey, data))).rejects.toThrow();
});

test('base64url round trip and vault key length', () => {
	const vk = generateVaultKey();
	expect(fromBase64Url(vk).length).toBe(32);
	expect(vk).toMatch(/^[A-Za-z0-9_-]+$/);
	const b = new Uint8Array([251, 255, 0, 1]);
	expect(fromBase64Url(toBase64Url(b))).toEqual(b);
});

test('sha256Hex known vector', async () => {
	expect(await sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('identity and signRequest', async () => {
	const id = await generateIdentity();
	expect(id.keyPair.privateKey.extractable).toBe(false);
	const raw = fromBase64Url(id.publicKey);
	expect(raw.length).toBe(65);
	expect(id.peerId).toBe((await sha256Hex(raw)).slice(0, 32));
	const sig = await signRequest(id.keyPair.privateKey, 'GET', '/room/abc', 1000);
	const verify = (ts: number) =>
		crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, id.keyPair.publicKey, fromBase64Url(sig) as BufferSource, new TextEncoder().encode(`GET\n/room/abc\n${ts}`));
	expect(fromBase64Url(sig).length).toBe(64);
	expect(await verify(1000)).toBe(true);
	expect(await verify(1001)).toBe(false);
});
