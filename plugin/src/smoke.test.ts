import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';

test('crypto.subtle is available', async () => {
	const d = await crypto.subtle.digest('SHA-256', new Uint8Array([1]));
	expect(d.byteLength).toBe(32);
});

test('fake-indexeddb is available', () => {
	expect(typeof indexedDB.open).toBe('function');
});
