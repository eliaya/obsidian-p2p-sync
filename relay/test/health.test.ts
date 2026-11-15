import { exports } from 'cloudflare:workers';
import { expect, test } from 'vitest';

test('GET /health returns 200 {"ok":true}', async () => {
	const res = await exports.default.fetch('http://example.com/health');
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ ok: true });
});
