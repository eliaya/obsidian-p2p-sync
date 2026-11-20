#!/usr/bin/env node
// One-time, re-runnable setup: D1, R2 (+ lifecycle), Worker secrets. See README "Deploy".
// Usage: node scripts/setup.mjs [--yes] [--dry-run] [--rotate-admin-token] [--self-test]
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = join(ROOT, 'wrangler.jsonc')
// The real database id stays out of git: wrangler.jsonc keeps the placeholder, this git-ignored copy has the id.
const LOCAL_CONFIG = join(ROOT, 'wrangler.local.jsonc')
const LIFECYCLE_RULE = 'expire-mailbox-45d'
const EXPIRE_DAYS = 45
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000'
const args = new Set(process.argv.slice(2))

// --- wrangler.jsonc helpers -------------------------------------------------

// Replaces the one database_id value and drops the placeholder comment; everything else is kept byte for byte.
export function patchDatabaseId(text, id) {
	const re = /("database_id"\s*:\s*)"[^"]*"/g
	assert.equal((text.match(re) ?? []).length, 1, 'expected exactly one "database_id" in wrangler.jsonc')
	return text.replace(re, `$1"${id}"`).replace(/^[ \t]*\/\/[ \t]*Placeholder:.*\r?\n/m, '')
}

// shortcut: handles // and /* */ comments but not trailing commas; fine for this file, extend if the config grows them.
export function parseJsonc(text) {
	let out = ''
	for (let i = 0; i < text.length; i++) {
		const c = text[i]
		if (c === '"') {
			let j = i + 1
			while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1
			out += text.slice(i, j + 1)
			i = j
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++
			out += '\n'
		} else if (c === '/' && text[i + 1] === '*') {
			i = text.indexOf('*/', i + 2) + 1
		} else out += c
	}
	return JSON.parse(out)
}

function selfTest() {
	const orig = readFileSync(CONFIG, 'utf8')
	const id = '11111111-2222-3333-4444-555555555555'
	const next = patchDatabaseId(orig, id)
	const a = parseJsonc(orig)
	const b = parseJsonc(next)
	assert.equal(b.d1_databases[0].database_id, id)
	a.d1_databases[0].database_id = id
	assert.deepEqual(b, a, 'only database_id may change')
	const comments = (t) => t.split('\n').filter((l) => l.trim().startsWith('//') && !l.includes('Placeholder:'))
	assert.deepEqual(comments(next), comments(orig), 'other comments must survive')
	assert.ok(!next.includes('Placeholder:'), 'placeholder comment removed')
	assert.equal(patchDatabaseId(next, id), next, 'idempotent')
	const origLines = orig.split('\n')
	const changed = next.split('\n').filter((l) => !origLines.includes(l))
	assert.equal(changed.length, 1, 'exactly one line differs')
	console.log('self-test ok (real wrangler.jsonc not modified)')
}

// --- environment ------------------------------------------------------------

function loadEnv() {
	const env = {}
	const file = join(ROOT, '.env')
	if (existsSync(file)) {
		for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
			const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
			if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
		}
	}
	for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) if (process.env[k]) env[k] = process.env[k]
	return env
}

const NO_CREDS = `Missing CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID.

1. Copy relay/.env.example to relay/.env and fill in both values (relay/.env is git-ignored).
2. CLOUDFLARE_ACCOUNT_ID: Cloudflare dashboard > Workers & Pages > right sidebar "Account ID".
3. CLOUDFLARE_API_TOKEN: dashboard > My Profile > API Tokens > Create Token > Create Custom Token, with
   Account > Workers Scripts > Edit
   Account > D1 > Edit
   Account > Workers R2 Storage > Edit
   Scoped to your account only. (See relay/.env.example and the README.)
Then run: npm run setup`

// --- wrangler runner (never puts secret values on the command line) -----------

let SECRET_TOKEN = ''
const scrub = (s) => (SECRET_TOKEN.length >= 8 ? s.split(SECRET_TOKEN).join('***') : s)
const ANSI = /\x1b\[[0-9;]*m/g

function wrangler(wargs, { input = '' } = {}, env) {
	const r = spawnSync('npx', ['--no-install', 'wrangler', ...wargs], {
		cwd: ROOT,
		input,
		encoding: 'utf8',
		env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0', WRANGLER_SEND_METRICS: 'false' },
	})
	const out = scrub((r.stdout ?? '').replace(ANSI, ''))
	const err = scrub((r.stderr ?? '').replace(ANSI, '') + (r.error ? String(r.error) : ''))
	return { ok: r.status === 0, out, err }
}

// --- main -------------------------------------------------------------------

async function main() {
	if (args.has('--self-test')) return selfTest()
	const dry = args.has('--dry-run')
	const rotate = args.has('--rotate-admin-token')
	const env = loadEnv()
	if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
		console.error(NO_CREDS)
		process.exit(1)
	}
	SECRET_TOKEN = env.CLOUDFLARE_API_TOKEN
	const cfg = parseJsonc(readFileSync(CONFIG, 'utf8'))
	const db = cfg.d1_databases[0].database_name
	const bucket = cfg.r2_buckets[0].bucket_name
	const worker = cfg.name

	const plan = [
		`D1: use database "${db}" if it exists, else create it; write its id into wrangler.local.jsonc (git-ignored)`,
		`R2: use bucket "${bucket}" if it exists, else create it`,
		`R2: lifecycle rule "${LIFECYCLE_RULE}" (delete objects ${EXPIRE_DAYS} days after creation) unless already present`,
		`Secret DB_ENC_KEY on Worker "${worker}": generate 32 random bytes (base64) ONLY if not already set; never overwritten`,
		rotate
			? `Secret ADMIN_TOKEN_HASH: generate a NEW admin token and overwrite the stored hash (--rotate-admin-token)`
			: `Secret ADMIN_TOKEN_HASH: generate an admin token and store its SHA-256 hex, only if not already set`,
		`Setting a secret on a Worker that does not exist yet creates an empty placeholder Worker "${worker}" (no code is deployed)`,
	]
	console.log('Planned actions (account ' + env.CLOUDFLARE_ACCOUNT_ID + '):')
	plan.forEach((p, i) => console.log(`  ${i + 1}. ${p}`))
	if (dry) return console.log('\n--dry-run: nothing executed.')
	if (!args.has('--yes')) {
		if (!process.stdin.isTTY) return fail('Not a terminal; pass --yes to confirm.', [])
		const rl = createInterface({ input: process.stdin, output: process.stdout })
		const a = await rl.question('\nProceed? [y/N] ')
		rl.close()
		if (!/^y(es)?$/i.test(a.trim())) return console.log('Aborted. Nothing changed.')
	}

	const done = []
	const run = (label, wargs, opts) => {
		const r = wrangler(wargs, opts, env)
		if (!r.ok) fail(`${label} failed:\n${(r.err || r.out).trim()}`, done)
		return r
	}

	// 1. D1
	const findDb = () => {
		const r = run('d1 list', ['d1', 'list', '--json'])
		const m = r.out.match(/\[[\s\S]*\]/)
		if (!m) fail('d1 list: could not find JSON in output:\n' + r.out, done)
		return JSON.parse(m[0]).find((d) => d.name === db)
	}
	let found = findDb()
	if (!found) {
		run('d1 create', ['d1', 'create', db])
		done.push(`D1 database "${db}" created`)
		found = findDb()
	} else done.push(`D1 database "${db}" already exists`)
	const dbId = found?.uuid ?? found?.id
	if (!dbId) fail('D1 database not found after creation (is the listing missing a uuid field?).', done)
	const patched = patchDatabaseId(readFileSync(CONFIG, 'utf8'), dbId)
	const changed = !existsSync(LOCAL_CONFIG) || readFileSync(LOCAL_CONFIG, 'utf8') !== patched
	if (changed) writeFileSync(LOCAL_CONFIG, patched)
	done.push(`wrangler.local.jsonc ${changed ? 'written' : 'already correct'}`)
	console.log(done.at(-2) + '; ' + done.at(-1))

	// 2. R2
	const buckets = run('r2 bucket list', ['r2', 'bucket', 'list']).out
	if (!new RegExp(`^\\s*name:\\s+${bucket}\\s*$`, 'm').test(buckets)) {
		run('r2 bucket create', ['r2', 'bucket', 'create', bucket])
		done.push(`R2 bucket "${bucket}" created`)
	} else done.push(`R2 bucket "${bucket}" already exists`)
	console.log(done.at(-1))
	const rules = run('r2 bucket lifecycle list', ['r2', 'bucket', 'lifecycle', 'list', bucket]).out
	if (!new RegExp(`^\\s*name:\\s+${LIFECYCLE_RULE}\\s*$`, 'm').test(rules)) {
		run('r2 bucket lifecycle add', ['r2', 'bucket', 'lifecycle', 'add', bucket, LIFECYCLE_RULE, '--expire-days', String(EXPIRE_DAYS), '--force'])
		done.push(`lifecycle rule "${LIFECYCLE_RULE}" added`)
	} else done.push(`lifecycle rule "${LIFECYCLE_RULE}" already present`)
	console.log(done.at(-1))

	// 3. Secrets. Any failure to list them stops here: we never write blind, so DB_ENC_KEY cannot be overwritten by mistake.
	const n0 = done.length
	const ls = wrangler(['secret', 'list', '--format', 'json'], {}, env)
	let existing = []
	if (ls.ok) {
		const m = ls.out.match(/\[[\s\S]*\]/)
		if (!m) fail('secret list: could not find JSON in output:\n' + ls.out, done)
		existing = JSON.parse(m[0]).map((s) => s.name)
	} else if (!/not found/i.test(ls.err + ls.out)) {
		fail('secret list failed:\n' + (ls.err || ls.out).trim(), done)
	} // else: Worker not found yet, so no secrets exist
	const toSet = {}
	let adminToken = ''
	if (existing.includes('DB_ENC_KEY')) done.push('secret DB_ENC_KEY already set; left untouched')
	else toSet.DB_ENC_KEY = randomBytes(32).toString('base64')
	if (existing.includes('ADMIN_TOKEN_HASH') && !rotate) done.push('secret ADMIN_TOKEN_HASH already set; left untouched')
	else {
		adminToken = randomBytes(32).toString('base64url')
		toSet.ADMIN_TOKEN_HASH = createHash('sha256').update(adminToken).digest('hex')
	}
	if (Object.keys(toSet).length) {
		run('secret bulk', ['secret', 'bulk'], { input: JSON.stringify(toSet) }) // values go through stdin only
		done.push(`secrets set: ${Object.keys(toSet).join(', ')}`)
	}
	console.log(done.slice(n0).join('\n'))

	if (adminToken) {
		console.log(`\n==== ADMIN TOKEN (shown once; not stored anywhere) ====\n${adminToken}\n======================================================\nSave it in your password manager now. You need it to log in to the dashboard.`)
	}
	console.log('\nSetup finished. Next: npm run deploy:local')
}

function fail(msg, done) {
	console.error('\n' + msg)
	console.error('\nCompleted before the failure:' + (done.length ? '\n  - ' + done.join('\n  - ') : ' nothing'))
	console.error('Re-running setup is safe: existing resources are reused and existing secrets are never overwritten.')
	process.exit(1)
}

main()
