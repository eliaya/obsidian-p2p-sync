import { createHash } from 'node:crypto';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations(path.resolve('migrations'));

export default defineConfig({
	// web/ is a separate package with its own tests.
	test: { include: ['test/**/*.test.ts'] },
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: migrations,
					// 32 bytes of 0x01, base64
					DB_ENC_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
					// SHA-256 hex of the admin token used in test/admin.test.ts
					ADMIN_TOKEN_HASH: createHash('sha256').update('test-admin-token').digest('hex'),
				},
			},
		}),
	],
});
