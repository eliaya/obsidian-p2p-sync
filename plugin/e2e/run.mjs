// End-to-end run in a real headless Chromium, driven over CDP with Node's built-in WebSocket/fetch.
//
//   npm run e2e                 build the test page, start `wrangler dev` on 8787 unless one is already
//                               listening, launch Chromium, run every scenario, print the results JSON.
// Env: PVS_CHROME   Chromium/Chrome executable (default: newest Playwright Chromium in the cache)
//      PVS_RELAY    relay origin (default http://localhost:8787)
//      PVS_ADMIN    admin token (default dev-admin-token, the one in relay/.dev.vars)
//      PVS_OUT      results file (default <tmp>/pvs-e2e-results.json)
//      PVS_ONLY     comma-separated scenario names to run (s1_pending and m_p2p_connect always run)
// Exit code 0 only when every scenario that ran passed. The relay-restart scenario needs the relay
// started by this script; it is skipped when one was already running.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const RELAY_DIR = join(HERE, '../../relay');
const RELAY = process.env.PVS_RELAY ?? 'http://localhost:8787';
const ADMIN = process.env.PVS_ADMIN ?? 'dev-admin-token';
const OUT = process.env.PVS_OUT ?? join(tmpdir(), 'pvs-e2e-results.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---------- browser ----------

function findChrome() {
	if (process.env.PVS_CHROME) return process.env.PVS_CHROME;
	const roots = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')];
	const rel = [
		'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
		'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
		'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
		'chrome-linux64/chrome',
		'chrome-linux/chrome',
	];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		const dirs = readdirSync(root)
			.filter((d) => /^chromium-\d+$/.test(d))
			.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
		for (const d of dirs) for (const r of rel) if (existsSync(join(root, d, r))) return join(root, d, r);
	}
	throw new Error('No Chromium found. Set PVS_CHROME to a Chrome/Chromium executable (e.g. a Playwright Chromium).');
}

async function launch() {
	const exe = findChrome();
	const dir = mkdtempSync(join(tmpdir(), 'pvs-e2e-chrome-'));
	// No WebRTC flags: headless Chromium gathers (mDNS-obfuscated) host candidates on its own.
	// No spare renderer, so a newly opened page's renderer is a new process the frozen-peer case can find.
	// Mock keychain / basic password store: never touch the OS keychain (on macOS a real-keychain read of
	// "Chromium Safe Storage" from this differently signed binary pops a login-password dialog).
	const args = ['--use-mock-keychain', '--password-store=basic', '--disable-features=SpareRendererForSitePerProcess', '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'];
	const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
	const url = await new Promise((res, rej) => {
		let buf = '';
		const t = setTimeout(() => rej(new Error('Chromium did not start')), 20_000);
		proc.stderr.on('data', (d) => {
			buf += d;
			const m = buf.match(/DevTools listening on (ws:\S+)/);
			if (m) clearTimeout(t), res(m[1]);
		});
		proc.on('exit', (c) => rej(new Error(`Chromium exited ${c}`)));
	});
	log('chromium', exe);
	const ws = new WebSocket(url);
	await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
	let n = 0;
	const pending = new Map();
	ws.onmessage = (e) => {
		const m = JSON.parse(e.data);
		const p = pending.get(m.id);
		if (!p) return;
		pending.delete(m.id);
		if (m.error) p.rej(new Error(`${m.error.message} ${m.error.data ?? ''}`));
		else p.res(m.result);
	};
	const send = (method, params = {}, sessionId) =>
		new Promise((res, rej) => {
			pending.set(++n, { res, rej });
			ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	const close = async () => {
		ws.close();
		proc.kill();
		await new Promise((r) => (proc.exitCode !== null ? r() : proc.on('exit', r)));
		rmSync(dir, { recursive: true, force: true });
	};
	return { send, close, pid: proc.pid };
}

// ---------- relay ----------

const healthy = () =>
	fetch(`${RELAY}/health`)
		.then((r) => r.ok)
		.catch(() => false);

async function startRelay() {
	const p = spawn('npx', ['wrangler', 'dev', '--port', '8787'], { cwd: RELAY_DIR, stdio: 'ignore', detached: true });
	for (let i = 0; i < 120 && !(await healthy()); i++) await sleep(500);
	if (!(await healthy())) throw new Error('wrangler dev did not come up');
	return p;
}
async function stopRelay(p) {
	try {
		process.kill(-p.pid, 'SIGTERM');
	} catch {
		// already gone
	}
	for (let i = 0; i < 40 && (await healthy()); i++) await sleep(250);
}

// ---------- tabs ----------

function tabs(cdp) {
	const open = async (url) => {
		const { targetId } = await cdp.send('Target.createTarget', { url });
		const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
		return { targetId, sessionId };
	};
	/** Runs `fn(...args)` in the page; resolves to its (awaited, JSON) result. */
	const ev = async (tab, fn, ...args) => {
		const r = await cdp.send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }, tab.sessionId);
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	};
	const until = async (tab, fn, timeout = 20_000, what = String(fn), ...args) => {
		const t0 = Date.now();
		for (;;) {
			try {
				const v = await ev(tab, fn, ...args);
				if (v) return v;
			} catch (e) {
				if (Date.now() - t0 > timeout) throw e;
			}
			if (Date.now() - t0 > timeout) throw new Error(`timeout (${timeout} ms): ${what}`);
			await sleep(100);
		}
	};
	const close = (tab) => cdp.send('Target.closeTarget', { targetId: tab.targetId });
	return { open, ev, until, close };
}

// ---------- scenarios ----------

async function main() {
	execFileSync('node', [join(HERE, 'build.mjs')], { stdio: 'inherit' });
	let relayProc = null;
	if (!(await healthy())) {
		log('starting wrangler dev on 8787');
		relayProc = await startRelay();
	} else log('using the relay already on 8787 (relay-restart scenario will be skipped)');

	const cdp = await launch();
	cleanup = async () => {
		await cdp.close().catch(() => undefined);
		if (relayProc) await stopRelay(relayProc);
	};
	const { open, ev, until, close } = tabs(cdp);
	const results = {};
	const record = (name, pass, data = {}) => {
		results[name] = { pass, ...data };
		log(pass === true ? 'PASS' : pass === false ? 'FAIL' : 'SKIP', name, JSON.stringify(data));
	};
	const only = process.env.PVS_ONLY?.split(',');
	const scenario = async (name, fn) => {
		if (only && !['s1_pending', 'm_p2p_connect', ...only].includes(name)) return;
		try {
			await fn();
		} catch (e) {
			record(name, false, { error: String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ') });
		}
	};

	const ctl = await open(`${RELAY}/e2e/`);
	await until(ctl, () => !!window.e2e);
	const admin = (fn, ...a) => ev(ctl, fn, ...a);
	await admin(async (t) => {
		await e2e.admin.login(t);
		await e2e.admin.settings({ require_approval: true });
	}, ADMIN);
	const key = await admin(() => e2e.newKey());
	const url = (name) => `${RELAY}/e2e/?device=${name}&key=${key}`;
	const dev = {};
	const openDev = async (name) => {
		dev[name] = await open(url(name));
		await until(dev[name], () => !!window.dev, 20_000, `dev ${name}`);
		return dev[name];
	};
	const closeDev = async (name) => {
		await close(dev[name]);
		delete dev[name];
	};
	const bundles = () => admin(() => e2e.admin.bundles());
	const dataPuts = (t) => ev(t, () => dev.meter.puts.data ?? 0);
	const linkOf = (t, other) => ev(t, (p) => dev.st.peers[p] ?? null, other);
	const id = {};
	const bothSynced = async (a, b, timeout = 20_000) => {
		await until(dev[a], (p) => dev.st.peers[p] === 'synced', timeout, `${a} synced with ${b}`, id[b]);
		await until(dev[b], (p) => dev.st.peers[p] === 'synced', timeout, `${b} synced with ${a}`, id[a]);
	};
	const fileHash = (t, p) => ev(t, (p) => dev.hash(p), p);
	const digest = (t) =>
		ev(t, async () => {
			const rows = [];
			for (const p of dev.paths()) rows.push(`${p}:${await dev.hash(p)}`);
			const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rows.join('\n'))));
			return { n: rows.length, d: Array.from(d.slice(0, 8), (x) => x.toString(16).padStart(2, '0')).join('') };
		});

	// 1. pending -> approved, no reload
	await scenario('s1_pending', async () => {
		const A = await openDev('A');
		const B = await openDev('B');
		await until(A, () => dev.st.relay === 'pending');
		await until(B, () => dev.st.relay === 'pending');
		id.A = await ev(A, () => dev.st.peerId);
		id.B = await ev(B, () => dev.st.peerId);
		const t0 = Date.now();
		for (const p of [id.A, id.B]) await admin((p) => e2e.admin.setStatus(p, 'active'), p);
		await until(A, () => dev.st.relay === 'online', 70_000);
		const tA = Date.now() - t0;
		await until(B, () => dev.st.relay === 'online', 70_000);
		const tB = Date.now() - t0;
		record('s1_pending', true, { onlineAfterApprovalMs: { A: tA, B: tB } });
	});

	// P2P link and connection time; then the mailbox start that Session's next tick would do, settled.
	await scenario('m_p2p_connect', async () => {
		await bothSynced('A', 'B', 30_000);
		const t = await ev(dev.A, (p) => {
			const e = dev.st.linkEvents.filter((x) => x.p === p);
			const c = e.find((x) => x.ls === 'connecting');
			const s = e.find((x) => x.ls === 'syncing' && x.t > c.t);
			const d = e.find((x) => x.ls === 'synced' && x.t > c.t);
			return { toDataChannelMs: Math.round(s.t - c.t), toFirstSyncedMs: Math.round(d.t - c.t) };
		}, id.B);
		record('m_p2p_connect', true, { ...t, initiator: id.A < id.B ? 'A' : 'B' });
		for (const n of ['A', 'B']) await ev(dev[n], () => dev.mail('start'));
		for (let i = 0; i < 2; i++) for (const n of ['A', 'B']) await ev(dev[n], () => dev.mail('receive'));
		await sleep(2500);
	});

	// 2. P2P: A writes, B gets it, nothing mailed
	await scenario('s2_p2p', async () => {
		const puts0 = await dataPuts(dev.A);
		const b0 = await bundles();
		const recv0 = await ev(dev.B, () => dev.meter.dcRecv);
		const files = await ev(dev.A, async () => {
			const out = {};
			for (let i = 0; i < 5; i++) {
				const p = `p2p/${i}.md`;
				await dev.write(p, `# file ${i}\n${crypto.randomUUID()}\n`);
				out[p] = await dev.hash(p);
			}
			return out;
		});
		const t0 = Date.now();
		await until(dev.B, async (f) => { for (const [p, h] of Object.entries(f)) if ((await dev.hash(p)) !== h) return false; return true; }, 20_000, 'B has files', files);
		const ms = Date.now() - t0;
		await bothSynced('A', 'B');
		await sleep(2500); // the push after 'synced' runs on a 2 s coalescer
		const puts1 = await dataPuts(dev.A);
		const b1 = await bundles();
		const recv = (await ev(dev.B, () => dev.meter.dcRecv)) - recv0;
		record('s2_p2p', puts1 === puts0 && b1 === b0 && recv > 0, { files: 5, arrivedAfterMs: ms, aDataPuts: puts1 - puts0, relayBundlesDelta: b1 - b0, bDataChannelBytes: recv, links: 'synced/synced' });
	});

	// 3. signalling frame sizes
	await scenario('s3_signal_size', async () => {
		const m = {};
		for (const n of ['A', 'B']) for (const [k, v] of Object.entries(await ev(dev[n], () => dev.meter.signal))) m[k] = Math.max(m[k] ?? 0, v.max);
		const max = Math.max(...Object.values(m));
		record('s3_signal_size', !!m.ice && !!m.offer && !!m.answer && max < 16384, { maxFrameBytes: m, limit: 16384, minMarginBytes: 16384 - max });
	});

	// 4. 30 MB over P2P with backpressure
	await scenario('s4_large_file', async () => {
		const h = await ev(dev.A, async () => {
			const d = (window.big = new Uint8Array(30 << 20));
			for (let o = 0; o < d.length; o += 65536) crypto.getRandomValues(d.subarray(o, o + 65536));
			return crypto.subtle.digest('SHA-256', d).then((b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join(''));
		});
		await sleep(300);
		for (const n of ['A', 'B']) await ev(dev[n], () => dev.resetMeter());
		const puts0 = await dataPuts(dev.A);
		const t0 = Date.now();
		await ev(dev.A, () => dev.write('big.bin', window.big));
		// Responsiveness: how long a trivial script waits for each page's event loop during the transfer.
		const rtt = { A: 0, B: 0 };
		for (;;) {
			for (const n of ['A', 'B']) {
				const r0 = Date.now();
				await ev(dev[n], () => 1);
				rtt[n] = Math.max(rtt[n], Date.now() - r0);
			}
			if (await ev(dev.B, () => dev.paths().includes('big.bin'))) break;
			if (Date.now() - t0 > 120_000) throw new Error('timeout: B big.bin');
			await sleep(100);
		}
		const ms = Date.now() - t0;
		const hb = await fileHash(dev.B, 'big.bin');
		const a = await ev(dev.A, () => dev.meter);
		await bothSynced('A', 'B', 30_000);
		record('s4_large_file', hb === h && (await dataPuts(dev.A)) === puts0, {
			bytes: 30 << 20,
			writeToArrivalMs: ms,
			hashMatch: hb === h,
			senderMaxBufferedAmount: a.maxBuffered,
			maxScriptWaitDuringTransferMs: rtt,
			mailed: (await dataPuts(dev.A)) - puts0,
		});
	});

	// 1,000 small files over P2P
	await scenario('m_1000_files_p2p', async () => {
		const t0 = Date.now();
		await ev(dev.A, async () => {
			const files = [];
			for (let i = 0; i < 1000; i++) {
				const b = crypto.getRandomValues(new Uint8Array(768));
				files.push([`bulk/${String(i).padStart(4, '0')}.txt`, btoa(String.fromCharCode(...b)).slice(0, 1024)]);
			}
			await dev.writeMany(files);
		});
		const t1 = Date.now();
		await until(dev.B, () => dev.paths().filter((p) => p.startsWith('bulk/')).length === 1000, 120_000, 'B 1000 files');
		const t2 = Date.now();
		await bothSynced('A', 'B', 30_000);
		const [da, db] = [await digest(dev.A), await digest(dev.B)];
		record('m_1000_files_p2p', da.d === db.d, { writeAndScanMs: t1 - t0, scanToAllArrivedMs: t2 - t1, totalMs: t2 - t0, vaultsIdentical: da.d === db.d, files: da.n });
	});

	// 5. B modifies, deletes, renames -> A follows
	await scenario('s5_modify_delete_rename', async () => {
		const puts0 = await dataPuts(dev.B);
		await ev(dev.B, async () => {
			await dev.write('p2p/0.md', 'modified by B');
			await dev.remove('p2p/1.md');
			await dev.rename('p2p/2.md', 'moved/two.md');
		});
		await until(dev.A, () => dev.text('p2p/0.md') === 'modified by B' && dev.text('p2p/1.md') === null && dev.text('p2p/2.md') === null && dev.text('moved/two.md')?.startsWith('# file 2'));
		const from = await ev(dev.A, async () => (await dev.history('moved/two.md'))[0]?.renamedFrom);
		await bothSynced('A', 'B');
		record('s5_modify_delete_rename', from === 'p2p/2.md' && (await dataPuts(dev.B)) === puts0, { renamedFrom: from, mailed: (await dataPuts(dev.B)) - puts0 });
	});

	// 6. conflicts made while cut off from each other, resolved over P2P on reconnect
	await scenario('s6_conflict', async () => {
		const BASE = 'Alpha paragraph talks about apples.\n\nBeta paragraph talks about pears.\n\nGamma paragraph talks about plums.\n';
		await ev(dev.A, async (b) => { await dev.write('c/merge.md', b); await dev.write('c/pick.md', b); }, BASE);
		await until(dev.B, (b) => dev.text('c/merge.md') === b && dev.text('c/pick.md') === b, 20_000, 'B base', BASE);
		await bothSynced('A', 'B');
		for (const n of ['A', 'B']) await ev(dev[n], () => dev.goOffline());
		await ev(dev.A, async (b) => { await dev.write('c/merge.md', b.replace('apples', 'APPLES by A')); await dev.write('c/pick.md', b.replace('pears', 'pears A')); }, BASE);
		await ev(dev.B, async (b) => { await dev.write('c/merge.md', b.replace('plums', 'PLUMS by B')); await dev.write('c/pick.md', b.replace('pears', 'pears B')); }, BASE);
		await sleep(1500);
		const puts0 = (await dataPuts(dev.A)) + (await dataPuts(dev.B));
		for (const n of ['A', 'B']) await ev(dev[n], () => dev.goOnline());
		await bothSynced('A', 'B', 30_000);
		const view = () => ({ m: dev.text('c/merge.md'), p: dev.text('c/pick.md'), c: dev.st.conflicts.map((c) => c.kind) });
		const [a, b] = [await ev(dev.A, view), await ev(dev.B, view)];
		const hist = await ev(dev.A, async () => {
			const out = [];
			for (const r of await dev.history('c/pick.md')) { const d = r.blobHash && (await dev.store.getBlob(r.blobHash)); out.push(d ? new TextDecoder().decode(d).match(/pears[^.]*/)[0] : null); }
			return out;
		});
		const merged = a.m.includes('APPLES by A') && a.m.includes('PLUMS by B');
		const winner = a.p.match(/pears[^.]*/)[0];
		const loser = winner === 'pears A' ? 'pears B' : 'pears A';
		const mailed = (await dataPuts(dev.A)) + (await dataPuts(dev.B)) - puts0;
		record('s6_conflict', merged && a.m === b.m && a.p === b.p && hist.includes(loser) && mailed === 0, { merged, sameOnBoth: a.m === b.m && a.p === b.p, winner, loserInHistory: hist.includes(loser), conflictsA: a.c, conflictsB: b.c, mailed });
	});

	// 9. reload: same identity, same revisions, nothing re-sent
	await scenario('s9_persistence', async () => {
		const before = { id: id.B, vv: JSON.stringify(await ev(dev.B, () => dev.vector())), d: await digest(dev.B) };
		const aSent0 = await ev(dev.A, () => dev.meter.dcSent);
		await cdp.send('Page.reload', {}, dev.B.sessionId);
		await sleep(500);
		await until(dev.B, () => !!window.dev, 20_000);
		await bothSynced('A', 'B', 30_000);
		await sleep(1000);
		const after = { id: await ev(dev.B, () => dev.st.peerId), reused: await ev(dev.B, () => dev.reusedIdentity), vv: JSON.stringify(await ev(dev.B, () => dev.vector())), d: await digest(dev.B) };
		const recv = await ev(dev.B, () => dev.meter.dcRecv);
		const aSent = (await ev(dev.A, () => dev.meter.dcSent)) - aSent0;
		record('s9_persistence', after.id === before.id && after.reused && after.vv === before.vv && after.d.d === before.d.d && recv < 64 * 1024, { samePeerId: after.id === before.id, identityReadFromIdb: after.reused, sameVector: after.vv === before.vv, sameVault: after.d.d === before.d.d, files: after.d.n, bDcBytesAfterReload: recv, aDcBytesSent: aSent });
	});

	// 11. link loss: local close on each side, then the peer's tab closing
	const relink = async (name, closer) => {
		const other = closer === 'A' ? 'B' : 'A';
		const pcs0 = await ev(dev[other], () => dev.pcs.length);
		const t0 = Date.now();
		await ev(dev[closer], () => dev.pcs.findLast((p) => p.connectionState === 'connected').close());
		let rebuilt = false;
		let err = null;
		try {
			await until(dev[other], (n) => dev.pcs.length > n && dev.pcs.at(-1).connectionState === 'connected', 30_000, 'new pc', pcs0);
			await bothSynced('A', 'B', 30_000);
			rebuilt = true;
		} catch (e) {
			err = String(e).slice(0, 120);
		}
		const ms = Date.now() - t0;
		const p = `relink/${name}.md`;
		await ev(dev[closer], (p) => dev.write(p, p), p);
		const arrived = await until(dev[other], (p) => dev.text(p) === p, 15_000, 'arrived', p).then(() => true, () => false);
		const state = { [closer]: await linkOf(dev[closer], id[other]), [other]: await linkOf(dev[other], id[closer]) };
		const logs = err ? { [closer]: await ev(dev[closer], () => dev.st.log.slice(-8)), [other]: await ev(dev[other], () => dev.st.log.slice(-8)) } : undefined;
		return { rebuilt, rebuildMs: rebuilt ? ms : null, arrived, state, err, logs };
	};
	const initiator = () => (id.A < id.B ? 'A' : 'B');
	const answerer = () => (id.A < id.B ? 'B' : 'A');
	await scenario('s11a_close_initiator', async () => {
		const r = await relink('a', initiator());
		record('s11a_close_initiator', r.rebuilt && r.arrived, { closer: `${initiator()} (initiator)`, ...r });
	});
	await scenario('s11b_close_answerer', async () => {
		await bothSynced('A', 'B', 30_000).catch(() => undefined);
		const r = await relink('b', answerer());
		record('s11b_close_answerer', r.rebuilt && r.arrived, { closer: `${answerer()} (answerer)`, ...r });
	});
	await scenario('s11c_peer_tab_closed', async () => {
		// Recover from a failed s11a/b by re-joining, so this case is tested on its own.
		for (const n of ['A', 'B']) await ev(dev[n], () => (dev.goOffline(), dev.goOnline()));
		await bothSynced('A', 'B', 30_000);
		const puts0 = await dataPuts(dev.A);
		const t0 = Date.now();
		await closeDev('B');
		await until(dev.A, (p) => !(p in dev.st.peers), 30_000, 'A drops B', id.B);
		const goneMs = Date.now() - t0;
		await ev(dev.A, () => dev.write('relink/c.md', 'while B is closed'));
		await sleep(4000);
		const mailed = (await dataPuts(dev.A)) - puts0;
		await openDev('B');
		await until(dev.B, () => dev.text('relink/c.md') === 'while B is closed', 20_000);
		await bothSynced('A', 'B', 30_000);
		record('s11c_peer_tab_closed', mailed >= 1, { aDroppedLinkAfterMs: goneMs, mailedWhileClosed: mailed, bGotItAfterReopen: true });
	});

	// 11d. the peer stops responding with its data channel open (process suspended, as iOS does in the
	// background): a device on another origin gets its own renderer process, which is SIGSTOPped.
	await scenario('s11d_peer_frozen', async () => {
		const renderers = () =>
			execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,args='], { encoding: 'utf8' })
				.split('\n')
				.map((l) => l.trim().split(/\s+/))
				.filter((f) => Number(f[1]) === cdp.pid && f.some((a) => a === '--type=renderer'))
				.map((f) => Number(f[0]));
		const r0 = new Set(renderers());
		const F = (dev.F = await open(`${RELAY.replace('localhost', '127.0.0.1')}/e2e/?device=F&key=${key}`));
		await until(F, () => !!window.dev, 20_000);
		await sleep(500);
		const pids = renderers().filter((p) => !r0.has(p));
		if (pids.length !== 1) return record('s11d_peer_frozen', false, { error: `expected one new renderer, got ${pids}` });
		await until(F, () => dev.st.relay === 'pending' || dev.st.relay === 'online', 20_000);
		id.F = await ev(F, () => dev.st.peerId);
		await admin((p) => e2e.admin.setStatus(p, 'active'), id.F);
		await bothSynced('A', 'F', 70_000);
		const puts0 = await dataPuts(dev.A);
		const t0 = Date.now();
		const tA0 = await ev(dev.A, () => performance.now());
		process.kill(pids[0], 'SIGSTOP');
		const frozen = await Promise.race([ev(F, () => 1).then(() => false), sleep(2000).then(() => true)]);
		if (!frozen) {
			process.kill(pids[0], 'SIGCONT');
			return record('s11d_peer_frozen', false, { error: 'the stopped process was not F' });
		}
		let dropped = null;
		try {
			await until(dev.A, (p) => !(p in dev.st.peers), 90_000, 'A drops frozen F', id.F);
			dropped = Date.now() - t0;
		} catch {
			// not detected within 90 s
		}
		const events = await ev(dev.A, (t) => dev.st.log.filter((l) => / pc |peer /.test(l)).slice(-8), tA0);
		await ev(dev.A, () => dev.write('frozen/a.md', 'while F is frozen'));
		await sleep(4000);
		const mailed = (await dataPuts(dev.A)) - puts0;
		process.kill(pids[0], 'SIGCONT');
		const t1 = Date.now();
		const back = await until(F, () => dev.text('frozen/a.md') === 'while F is frozen', 90_000).then(() => Date.now() - t1, () => null);
		const relinked = await bothSynced('A', 'F', 90_000).then(() => true, () => false);
		record('s11d_peer_frozen', dropped !== null && mailed >= 1 && back !== null && relinked, { aDroppedFrozenPeerAfterMs: dropped, aEvents: events, mailedWhileFrozen: mailed, fCaughtUpAfterResumeMs: back, relinked });
		await closeDev('F');
		// F is done; as an active peer it would hold every later bundle on the relay unacknowledged.
		await admin((p) => e2e.admin.setStatus(p, 'revoked'), id.F);
	});

	// 10. relay restart while linked
	await scenario('s10_relay_restart', async () => {
		if (!relayProc) return record('s10_relay_restart', null, { skipped: 'relay not started by this script' });
		await bothSynced('A', 'B', 30_000);
		await stopRelay(relayProc);
		await until(dev.A, () => dev.st.relay !== 'online', 15_000);
		await ev(dev.A, () => dev.write('restart/during.md', 'relay is down'));
		const during = await until(dev.B, () => dev.text('restart/during.md') === 'relay is down', 15_000).then(() => true, () => false);
		const linkDuring = await linkOf(dev.A, id.B);
		relayProc = await startRelay();
		const t0 = Date.now();
		await until(dev.A, () => dev.st.relay === 'online', 70_000);
		await until(dev.B, () => dev.st.relay === 'online', 70_000);
		const back = Date.now() - t0;
		// A new link needs signalling through the restarted relay.
		await ev(dev.B, () => (dev.goOffline(), dev.goOnline()));
		await bothSynced('A', 'B', 30_000);
		await ev(dev.A, () => dev.write('restart/after.md', 'relay is back'));
		await until(dev.B, () => dev.text('restart/after.md') === 'relay is back', 15_000);
		record('s10_relay_restart', during, { p2pDuringOutage: during, linkStateDuringOutage: linkDuring, bothOnlineAfterRestartMs: back, newLinkAfterRestart: true });
	});

	// 7. offline mailbox, never both open
	await scenario('s7_offline_mailbox', async () => {
		await bothSynced('A', 'B', 30_000);
		await sleep(2500);
		await closeDev('B');
		await until(dev.A, (p) => !(p in dev.st.peers), 30_000, 'A drops B', id.B);
		const b0 = await bundles();
		const puts0 = await dataPuts(dev.A);
		await ev(dev.A, () => dev.write('mail/offline.md', 'written while B is closed'));
		await until(dev.A, (n) => (dev.meter.puts.data ?? 0) > n, 15_000, 'A mailed', puts0);
		const b1 = await bundles();
		await closeDev('A');
		const t0 = Date.now();
		await openDev('B');
		await until(dev.B, () => dev.text('mail/offline.md') === 'written while B is closed', 20_000);
		const ms = Date.now() - t0;
		await sleep(500);
		const b2 = await bundles();
		record('s7_offline_mailbox', b1 === b0 + 1 && b2 === b0, { bundlesBefore: b0, afterAWrite: b1, afterBAck: b2, bOpenToFileMs: ms });
	});

	// 8. a new device catches up with nobody else online
	await scenario('s8_catchup', async () => {
		const ref = await digest(dev.B);
		await closeDev('B');
		await admin(() => e2e.admin.settings({ require_approval: false }));
		const C = await openDev('C');
		await until(C, () => dev.st.mailbox.started, 20_000);
		const req = await ev(C, () => dev.meter.puts.request ?? 0);
		await closeDev('C');
		const A = await openDev('A');
		await until(A, () => dev.st.mailbox.started, 20_000);
		await until(A, () => dev.st.mailbox.busy === 0, 60_000);
		await sleep(1000);
		await closeDev('A');
		const t0 = Date.now();
		const C2 = await openDev('C');
		await until(C2, (n) => dev.paths().length === n, 120_000, 'C full vault', ref.n);
		await until(C2, () => dev.st.mailbox.busy === 0, 60_000);
		const got = await digest(C2);
		const open = await ev(C2, () => dev.store.getMeta('mailbox:request'));
		await admin(() => e2e.admin.settings({ require_approval: true }));
		record('s8_catchup', got.d === ref.d && req === 1 && !open, { requestsSent: req, files: got.n, identical: got.d === ref.d, cOpenToFullVaultMs: Date.now() - t0, requestClosed: !open });
		await closeDev('C');
	});

	// 12. revoke B: B stops, A is unaffected
	await scenario('s12_revoke', async () => {
		await openDev('A');
		await openDev('B');
		await bothSynced('A', 'B', 30_000);
		const t0 = Date.now();
		await admin((p) => e2e.admin.setStatus(p, 'revoked'), id.B);
		await until(dev.B, () => dev.st.relay === 'revoked', 20_000);
		const ms = Date.now() - t0;
		await until(dev.A, (p) => !(p in dev.st.peers), 20_000, 'A drops B', id.B);
		await ev(dev.A, () => dev.write('revoke/a.md', 'A after revoke'));
		await ev(dev.B, () => dev.write('revoke/b.md', 'B after revoke'));
		const aPush = await ev(dev.A, () => dev.box.push().then(() => 'ok', (e) => String(e)));
		const bPush = await ev(dev.B, () => dev.box.push().then(() => 'ok', (e) => String(e)));
		await sleep(4000);
		const leakedToB = await ev(dev.B, () => dev.text('revoke/a.md'));
		const leakedToA = await ev(dev.A, () => dev.text('revoke/b.md'));
		const aRelay = await ev(dev.A, () => dev.st.relay);
		const bLinks = await ev(dev.B, () => Object.keys(dev.st.peers).length);
		record('s12_revoke', aPush === 'ok' && bPush.includes('revoked') && !leakedToA && !leakedToB && aRelay === 'online', { bRevokedAfterMs: ms, aPush, bPush, aRelay, bOpenLinks: bLinks, leakedToA: !!leakedToA, leakedToB: !!leakedToB });
	});

	writeFileSync(OUT, JSON.stringify(results, null, 1));
	console.log(JSON.stringify(results, null, 1));
	log('results written to', OUT);
	const ran = Object.values(results).filter((r) => r.pass !== null);
	process.exitCode = ran.every((r) => r.pass === true) ? 0 : 1;
}

let cleanup = async () => {};
main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 2;
	})
	.finally(() => cleanup());
