#!/usr/bin/env node
// Build web, typecheck, test, apply remote D1 migrations, deploy, check /health.
// Usage: node scripts/deploy.mjs [--dry-run] [--url https://...]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dry = argv.includes('--dry-run')
const urlArg = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : undefined
if (argv.includes('--url') && !/^https:\/\//.test(urlArg ?? '')) die('--url needs an https:// URL')

function die(msg) {
	console.error('\n' + msg)
	process.exit(1)
}

// Same .env rules as setup.mjs; Wrangler would also read relay/.env itself, this just keeps both paths identical.
function loadEnv() {
	const env = {}
	const file = join(ROOT, '.env')
	if (existsSync(file)) {
		for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
			const m = line.match(/^\s*(CLOUDFLARE_[A-Z_]+)\s*=\s*(.*?)\s*$/)
			if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
		}
	}
	return env
}
const env = { ...loadEnv(), ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }

// stdout is echoed and also returned (needed to read the deployed URL).
function step(title, cmd, cmdArgs) {
	console.log(`\n==> ${title}`)
	const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
	process.stdout.write(r.stdout ?? '')
	if (r.status !== 0) die(`Step failed: ${title} (exit ${r.status ?? r.error}). Nothing after it was run.`)
	return r.stdout ?? ''
}

// wrangler.jsonc in git keeps a placeholder id; setup stores the real one in the git-ignored wrangler.local.jsonc.
// Rebuild that copy from the current wrangler.jsonc so later config edits are deployed too.
const LOCAL = join(ROOT, 'wrangler.local.jsonc')
const ID_RE = /("database_id"\s*:\s*)"([^"]*)"/
const dbId = existsSync(LOCAL) ? readFileSync(LOCAL, 'utf8').match(ID_RE)?.[2] : undefined
const realId = dbId && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(dbId) ? dbId : undefined
if (!realId && !dry) die('No database id in wrangler.local.jsonc. Run `npm run setup` first.')
if (!realId) console.log('Note: no real database id yet; --dry-run continues because it contacts nothing.')
const base = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')
if (realId) writeFileSync(LOCAL, base.replace(ID_RE, `$1"${realId}"`).replace(/^[ \t]*\/\/[ \t]*Placeholder:.*\r?\n/m, ''))
const CONFIG_ARGS = realId ? ['--config', 'wrangler.local.jsonc'] : []
if (!dry && (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID)) die('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID missing (relay/.env). See relay/.env.example.')

step('Build web UI (relay/web -> relay/public)', 'npm', ['run', 'build:web'])
step('Typecheck', 'npm', ['run', 'typecheck'])
step('Tests', 'npm', ['test'])

if (dry) {
	step('wrangler deploy --dry-run', 'npx', ['--no-install', 'wrangler', 'deploy', '--dry-run', ...CONFIG_ARGS])
	console.log('\nDry run finished: no migrations applied, nothing deployed.')
	process.exit(0)
}

step('Apply remote D1 migrations', 'npx', ['--no-install', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', ...CONFIG_ARGS])
const out = step('Deploy', 'npx', ['--no-install', 'wrangler', 'deploy', ...CONFIG_ARGS])

const url = (urlArg ?? out.match(/https:\/\/[^\s/]+\.workers\.dev/)?.[0] ?? '').replace(/\/$/, '')
if (!url) die('Deployed, but no workers.dev URL found in the output (custom route or workers.dev disabled?). Re-run the check with: npm run deploy:local -- --url https://YOUR-HOST (this redeploys) or curl <url>/health yourself.')

console.log(`\n==> Health check ${url}/health`)
let status = 'no response'
for (let i = 0; i < 6; i++) {
	try {
		const res = await fetch(url + '/health', { signal: AbortSignal.timeout(10_000) })
		status = String(res.status)
		if (res.status === 200) {
			console.log('200 OK. Deployed: ' + url)
			process.exit(0)
		}
	} catch (e) {
		status = String(e.cause?.code ?? e.message)
	}
	await new Promise((r) => setTimeout(r, 3000)) // a new workers.dev hostname can take a moment to resolve
}
die(`Health check failed (last result: ${status}). The Worker is deployed but /health did not return 200.`)
