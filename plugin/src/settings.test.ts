import { expect, test, vi } from 'vitest';
vi.mock('obsidian', () => ({ Modal: class {}, Notice: class {}, PluginSettingTab: class {}, Setting: class {} }));
import { generateVaultKey } from './crypto';
import { decodeSetupCode, encodeSetupCode, normalizeRelayUrl, normalizeSettings, parseSetup } from './settings';

const key = generateVaultKey();

test('setup code round trip', () => {
	const s = { relayUrl: 'https://relay.example.com/base', vaultKey: key };
	const code = encodeSetupCode(s);
	expect(code.startsWith('obsidian://peer-vault-sync?')).toBe(true);
	expect(decodeSetupCode(code)).toEqual(s);
	expect(decodeSetupCode(`  ${encodeSetupCode({ relayUrl: 'http://localhost:8787', vaultKey: key })}\n`)).toEqual({ relayUrl: 'http://localhost:8787', vaultKey: key });
});

test('setup code rejects bad input', () => {
	expect(decodeSetupCode('not a url')).toBe('setup.error.format');
	expect(decodeSetupCode(`https://x/?relay=https://r&key=${key}`)).toBe('setup.error.format');
	expect(decodeSetupCode(`obsidian://open?relay=https://r&key=${key}`)).toBe('setup.error.format');
	expect(decodeSetupCode(`obsidian://peer-vault-sync?key=${key}`)).toBe('setup.error.missing');
	expect(decodeSetupCode('obsidian://peer-vault-sync?relay=https%3A%2F%2Fr')).toBe('setup.error.missing');
	expect(decodeSetupCode(encodeSetupCode({ relayUrl: 'http://relay.example.com', vaultKey: key }))).toBe('setup.error.relay');
	expect(decodeSetupCode(encodeSetupCode({ relayUrl: 'https://r', vaultKey: 'short' }))).toBe('setup.error.key');
	expect(decodeSetupCode(encodeSetupCode({ relayUrl: 'https://r', vaultKey: key.slice(0, 42) + '!' }))).toBe('setup.error.key');
	expect(parseSetup('javascript:alert(1)', key)).toBe('setup.error.relay');
});

test('relay URL: https, or http for localhost only', () => {
	expect(normalizeRelayUrl('https://r.example.com/')).toBe('https://r.example.com');
	expect(normalizeRelayUrl('http://localhost:8787')).toBe('http://localhost:8787');
	expect(normalizeRelayUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
	expect(normalizeRelayUrl('http://[::1]:8787')).toBe('http://[::1]:8787');
	expect(normalizeRelayUrl('http://example.com')).toBeNull();
	expect(normalizeRelayUrl('http://localhost.evil.com')).toBeNull();
	expect(normalizeRelayUrl('https://u:p@r.example.com')).toBeNull();
	expect(normalizeRelayUrl('https://r.example.com/?x=1')).toBeNull();
	expect(normalizeRelayUrl('ws://r.example.com')).toBeNull();
	expect(normalizeRelayUrl('')).toBeNull();
});

test('normalizeSettings keeps only well-typed values', () => {
	expect(normalizeSettings(null)).toEqual({ relayUrl: '', vaultKey: '', retentionDays: 90 });
	expect(normalizeSettings({ relayUrl: 'https://r', vaultKey: key, retentionDays: 30 })).toEqual({ relayUrl: 'https://r', vaultKey: key, retentionDays: 30 });
	expect(normalizeSettings({ relayUrl: 5, vaultKey: 'x', retentionDays: 0 })).toEqual({ relayUrl: '', vaultKey: '', retentionDays: 90 });
	expect(normalizeSettings({ retentionDays: 1.5 }).retentionDays).toBe(90);
});
