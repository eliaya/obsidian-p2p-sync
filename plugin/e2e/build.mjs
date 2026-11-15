// Bundles the browser E2E harness into relay/public/e2e/, served same-origin by `wrangler dev`.
import esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const out = new URL('../../relay/public/e2e/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
await esbuild.build({
	entryPoints: [new URL('main.ts', import.meta.url).pathname],
	bundle: true,
	format: 'iife',
	target: 'es2021',
	sourcemap: 'inline',
	outfile: `${out}e2e.js`,
	logLevel: 'info',
});
copyFileSync(new URL('index.html', import.meta.url), `${out}index.html`);
