// Browser end-to-end harness: the plugin's sync core (IdbStore, SyncEngine, VaultScanner, RelayClient,
// PeerManager, Mailbox) wired as plugin/main.ts `Session` does, against a local relay, with real
// RTCPeerConnection / WebSocket / IndexedDB / WebCrypto. Obsidian's vault is replaced by an in-memory
// adapter persisted to its own IndexedDB database, requestUrl by fetch.
//
// Build: `npm run e2e:build` (writes relay/public/e2e/), run `npx wrangler dev --port 8787` in relay/,
// open http://localhost:8787/e2e/ (control page, window.e2e) — it opens devices as iframes; a device can
// also be its own tab: /e2e/?device=A&key=<vaultKey>. Results: the JSON in #results (also localStorage).
import { decrypt, deriveKeys, fromBase64Url, generateIdentity, generateVaultKey, sha256Hex } from '../src/crypto';
import { Mailbox } from '../src/mailbox';
import { type Http, PeerManager, RelayClient, unpack } from '../src/peer';
import { type ScanAdapter, VaultScanner } from '../src/scan';
import { IdbStore } from '../src/store';
import { type Conflict, SyncEngine } from '../src/sync';

const te = new TextEncoder();
const td = new TextDecoder();
const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = location.origin;

// ---------- shared ----------

const http: Http = async (r) => {
	const res = await fetch(r.url, { method: r.method, body: r.body, headers: r.headers });
	const buf = await res.arrayBuffer();
	let json: unknown = null;
	try {
		json = JSON.parse(td.decode(buf));
	} catch {
		// not JSON
	}
	return { status: res.status, arrayBuffer: buf, json };
};

function idbOpen(name: string): Promise<IDBDatabase> {
	return new Promise((res, rej) => {
		const r = indexedDB.open(name, 1);
		r.onupgradeneeded = () => r.result.createObjectStore('files');
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
}
const idbDone = (tx: IDBTransaction) =>
	new Promise<void>((res, rej) => {
		tx.oncomplete = () => res();
		tx.onerror = tx.onabort = () => rej(tx.error);
	});

// ---------- device mode ----------

type File = { data: Uint8Array; mtime: number };

/** The vault: a flat map persisted write-through to IndexedDB, shaped like Obsidian's DataAdapter. */
class MemAdapter implements ScanAdapter {
	files = new Map<string, File>();
	constructor(private db: IDBDatabase) {}
	async load() {
		const tx = this.db.transaction('files');
		const os = tx.objectStore('files');
		const keys = await new Promise<IDBValidKey[]>((r) => (os.getAllKeys().onsuccess = (e) => r((e.target as IDBRequest).result)));
		const vals = await new Promise<File[]>((r) => (os.getAll().onsuccess = (e) => r((e.target as IDBRequest).result)));
		keys.forEach((k, i) => this.files.set(k as string, vals[i]!));
	}
	private async persist(path: string, f: File | null) {
		const tx = this.db.transaction('files', 'readwrite');
		if (f) tx.objectStore('files').put(f, path);
		else tx.objectStore('files').delete(path);
		await idbDone(tx);
	}
	async set(path: string, data: Uint8Array, mtime?: number) {
		const prev = this.files.get(path)?.mtime ?? 0;
		const f = { data: data.slice(), mtime: Math.max(mtime ?? Date.now(), prev + 1) };
		this.files.set(path, f);
		await this.persist(path, f);
	}
	async list(_dir: string) {
		return { files: [...this.files.keys()], folders: [] };
	}
	async stat(path: string) {
		const f = this.files.get(path);
		return f ? { type: 'file' as const, ctime: f.mtime, mtime: f.mtime, size: f.data.length } : null;
	}
	async readBinary(path: string) {
		const f = this.files.get(path);
		if (!f) throw new Error('ENOENT ' + path);
		return f.data.slice().buffer;
	}
	async writeBinary(path: string, data: ArrayBuffer, opts?: { mtime?: number }) {
		await this.set(path, new Uint8Array(data), opts?.mtime);
	}
	async remove(path: string) {
		this.files.delete(path);
		await this.persist(path, null);
	}
	async mkdir() {}
	async rmdir() {}
	async exists(path: string) {
		return this.files.has(path);
	}
}

interface Meter {
	signal: Record<string, { max: number; n: number }>;
	dcSent: number;
	dcRecv: number;
	maxBuffered: number;
	maxLag: number;
	/** Mailbox uploads by payload kind (decrypted here, in the page that holds the key). */
	puts: Record<string, number>;
}

async function device(name: string, vaultKey: string) {
	$('title').textContent = `device ${name}`;
	const tickMs = Number(new URLSearchParams(location.search).get('tick') ?? 60_000);
	const { roomId, signalKey, mailboxKey } = await deriveKeys(vaultKey);
	const meter: Meter = { signal: {}, dcSent: 0, dcRecv: 0, maxBuffered: 0, maxLag: 0, puts: {} };
	const st = {
		name,
		roomId,
		peerId: '',
		phase: 'starting',
		relay: 'idle' as string,
		peers: {} as Record<string, string>,
		mailbox: { busy: 0, started: false, lastPush: 0, lastReceive: 0, error: null as string | null },
		errors: [] as string[],
		conflicts: [] as { path: string; kind: string; winner: string | null }[],
		log: [] as string[],
		/** Every link state change with its time (ms, performance.now). */
		linkEvents: [] as { p: string; ls: string; t: number }[],
	};
	const log = (s: string) => {
		st.log.push(`${new Date().toISOString().slice(11, 23)} ${s}`);
		if (st.log.length > 60) st.log.shift();
	};

	// Event-loop lag: a blocked page shows as a large gap between 50 ms ticks.
	let last = performance.now();
	setInterval(() => {
		const now = performance.now();
		meter.maxLag = Math.max(meter.maxLag, now - last - 50);
		last = now;
	}, 50);

	// Instrumented platform objects: same behaviour, plus measurements.
	const origSend = RTCDataChannel.prototype.send;
	RTCDataChannel.prototype.send = function (this: RTCDataChannel, d: ArrayBufferView) {
		origSend.call(this, d as never);
		meter.dcSent += d.byteLength;
		meter.maxBuffered = Math.max(meter.maxBuffered, this.bufferedAmount);
	} as RTCDataChannel['send'];
	const pcs: RTCPeerConnection[] = [];
	const countRecv = (dc: RTCDataChannel) => dc.addEventListener('message', (e) => (meter.dcRecv += (e.data as ArrayBuffer).byteLength));
	class PC extends RTCPeerConnection {
		constructor(c: RTCConfiguration) {
			super(c);
			pcs.push(this);
			this.addEventListener('datachannel', (e) => countRecv(e.channel));
			this.addEventListener('connectionstatechange', () => log(`pc ${this.connectionState}`));
		}
		override createDataChannel(label: string, init?: RTCDataChannelInit) {
			const dc = super.createDataChannel(label, init);
			countRecv(dc);
			return dc;
		}
	}
	class WS extends WebSocket {
		constructor(url: string) {
			super(url);
			this.addEventListener('close', (e) => log(`ws close ${e.code}`));
		}
		override send(d: string) {
			super.send(d);
			const bytes = te.encode(d).length;
			void (async () => {
				const { data } = JSON.parse(d) as { data: string };
				const kind = (JSON.parse(td.decode(await decrypt(signalKey, fromBase64Url(data)))) as { kind: string }).kind;
				const m = (meter.signal[kind] ??= { max: 0, n: 0 });
				m.max = Math.max(m.max, bytes);
				m.n++;
			})();
		}
	}

	const store = await IdbStore.open(`e2e-${name}-${roomId}`);
	const adapter = new MemAdapter(await idbOpen(`e2e-vault-${name}-${roomId}`));
	await adapter.load();
	type Identity = { privateKey: CryptoKey; publicKey: string; peerId: string };
	let id = await store.getMeta<Identity>('plugin:identity');
	const reusedIdentity = !!id;
	if (!id) {
		const g = await generateIdentity();
		id = { privateKey: g.keyPair.privateKey, publicKey: g.publicKey, peerId: g.peerId };
		await store.setMeta('plugin:identity', id);
	}
	st.peerId = id.peerId;

	let engine: SyncEngine | null = null;
	const scanner = new VaultScanner(adapter, { recordLocal: (...a) => engine!.recordLocal(...a) }, store);
	engine = new SyncEngine(store, scanner, id.peerId);
	engine.onConflict = (c: Conflict) => st.conflicts.push({ path: c.path, kind: c.kind, winner: c.winner?.id ?? null });
	await scanner.scanAll();

	const relay = new RelayClient({ baseUrl: BASE, roomId, publicKey: id.publicKey, privateKey: id.privateKey, http, WebSocket: WS });
	const putBundle = relay.putBundle.bind(relay);
	relay.putBundle = async (data: Uint8Array) => {
		const kind = unpack<{ kind: string }>(await decrypt(mailboxKey, data)).header.kind;
		meter.puts[kind] = (meter.puts[kind] ?? 0) + 1;
		return putBundle(data);
	};
	let offline = false; // simulated network loss: no relay, no mailbox
	let started = false;
	const coalesce = (ms: number, fn: () => void) => {
		let t: ReturnType<typeof setTimeout> | null = null;
		return () => (t ??= setTimeout(() => ((t = null), fn()), ms));
	};
	const mail = async (op: 'start' | 'receive' | 'push') => {
		if (offline) return;
		st.mailbox.busy++;
		try {
			if (op === 'push') await box.push();
			else if (op === 'start' || !started) await box.start();
			else await box.receive();
			if (op !== 'push') started = st.mailbox.started = true;
			st.mailbox.error = null;
			if (op === 'push') st.mailbox.lastPush = Date.now();
			else st.mailbox.lastReceive = Date.now();
		} catch (e) {
			st.mailbox.error = String(e);
			log(`mail ${op}: ${e}`);
		} finally {
			st.mailbox.busy--;
		}
	};
	const pushes = coalesce(2000, () => void mail('push'));
	const peers = new PeerManager({
		relay,
		signalKey,
		selfId: id.peerId,
		engine,
		RTCPeerConnection: PC,
		onState: (r) => {
			if (st.relay !== r) log(`relay ${r}`);
			st.relay = r;
		},
		onPeer: (p, ls) => {
			log(`peer ${p.slice(0, 6)} ${ls}`);
			st.linkEvents.push({ p, ls, t: performance.now() });
			if (ls === 'gone') delete st.peers[p];
			else st.peers[p] = ls;
			if (ls === 'synced' || ls === 'gone') pushes();
		},
	});
	const box = new Mailbox({
		relay,
		store,
		engine,
		mailboxKey,
		selfId: id.peerId,
		links: () => peers.links(),
		onBadBundle: (b) => st.errors.push(`bad bundle ${b}`),
		onSkipped: (r) => st.errors.push(`too large ${r.path}`),
	});
	const propagate = coalesce(1000, () => {
		peers.syncNow();
		void mail('push');
	});
	const changed = (n: number) => n > 0 && propagate();

	st.phase = 'running';
	peers.start();
	void mail('start');
	setInterval(() => void (scanner.scanAll().then(changed), mail('receive')), tickMs);
	setInterval(() => ($('state').textContent = JSON.stringify({ ...st, meter, vault: adapter.files.size }, null, 1)), 500);

	const dev = {
		st,
		meter,
		pcs,
		reusedIdentity,
		store,
		relay,
		peers,
		box,
		engine,
		/** Local edit, as Obsidian's modify/create event would report it. */
		async write(path: string, content: string | Uint8Array) {
			await adapter.set(path, typeof content === 'string' ? te.encode(content) : content);
			changed(await scanner.onFileEvent(path));
		},
		/** Many files, then one scan (as a bulk copy into the vault and the next scan would). */
		async writeMany(files: [string, string | Uint8Array][]) {
			for (const [p, c] of files) await adapter.set(p, typeof c === 'string' ? te.encode(c) : c);
			changed(await scanner.scanAll());
		},
		async remove(path: string) {
			await adapter.remove(path);
			changed(await scanner.onFileEvent(path));
		},
		async rename(from: string, to: string) {
			const f = adapter.files.get(from)!;
			await adapter.remove(from);
			await adapter.set(to, f.data, f.mtime);
			await scanner.onRename(from, to);
			changed(1);
		},
		text(path: string) {
			const f = adapter.files.get(path);
			return f ? td.decode(f.data) : null;
		},
		async hash(path: string) {
			const f = adapter.files.get(path);
			return f ? sha256Hex(f.data) : null;
		},
		paths: () => [...adapter.files.keys()].sort(),
		vector: () => store.vector(),
		history: (path: string) => store.history(path),
		mail,
		/** Simulated network loss: relay socket and data channels gone, mailbox not reachable. */
		goOffline() {
			offline = true;
			peers.stop();
		},
		goOnline() {
			offline = false;
			peers.start();
			void mail('receive');
		},
		resetMeter() {
			Object.assign(meter, { signal: {}, dcSent: 0, dcRecv: 0, maxBuffered: 0, maxLag: 0, puts: {} });
		},
	};
	(window as unknown as { dev: typeof dev }).dev = dev;
	log(`started, identity ${reusedIdentity ? 'reused' : 'new'}`);
}

// ---------- control mode ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dev = any; // a device iframe's window.dev

function control() {
	const results: Record<string, unknown> = JSON.parse(localStorage.getItem('pvs-e2e-results') ?? '{}');
	const show = () => {
		$('results').textContent = JSON.stringify(results, null, 1);
		localStorage.setItem('pvs-e2e-results', JSON.stringify(results));
	};
	show();
	const J = { 'Content-Type': 'application/json' };
	const admin = {
		async login(token = 'dev-admin-token') {
			const r = await fetch('/api/admin/login', { method: 'POST', headers: J, body: JSON.stringify({ token }) });
			if (r.status !== 204) throw new Error(`login ${r.status}`);
		},
		async get(path: string) {
			return (await fetch(`/api/admin${path}`)).json();
		},
		async send(path: string, method: string, body: unknown) {
			const r = await fetch(`/api/admin${path}`, { method, headers: J, body: JSON.stringify(body) });
			if (!r.ok) throw new Error(`${method} ${path} ${r.status}`);
		},
		async peers(): Promise<{ id: string; peerId: string; status: string; online: boolean }[]> {
			return (await this.get('/peers')).peers;
		},
		async setStatus(peerId: string, status: 'active' | 'revoked') {
			const p = (await this.peers()).find((x) => x.peerId === peerId);
			if (!p) throw new Error(`unknown peer ${peerId}`);
			await this.send(`/peers/${p.id}`, 'PATCH', { status });
		},
		settings: (s: Record<string, unknown>) => admin.send('/settings', 'PUT', s),
		async bundles(): Promise<number> {
			return (await this.get('/overview')).mailbox.bundles;
		},
	};
	const frames = new Map<string, HTMLIFrameElement>();
	const e2e = {
		admin,
		results,
		key: localStorage.getItem('pvs-e2e-key') ?? '',
		newKey() {
			this.key = generateVaultKey();
			localStorage.setItem('pvs-e2e-key', this.key);
			return this.key;
		},
		record(name: string, pass: boolean, data: Record<string, unknown> = {}) {
			results[name] = { pass, ...data, at: new Date().toISOString() };
			show();
			return results[name];
		},
		clear() {
			for (const k of Object.keys(results)) delete results[k];
			show();
		},
		deviceUrl(name: string, extra = '') {
			return `${location.pathname}?device=${encodeURIComponent(name)}&key=${this.key}${extra}`;
		},
		/** A device in an iframe; resolves to its window.dev. */
		async spawn(name: string, extra = ''): Promise<Dev> {
			this.kill(name);
			const f = document.createElement('iframe');
			f.src = this.deviceUrl(name, extra);
			$('frames').append(f);
			frames.set(name, f);
			return this.dev(name);
		},
		async dev(name: string, timeout = 15_000): Promise<Dev> {
			return this.until(() => (frames.get(name)?.contentWindow as { dev?: Dev } | null)?.dev, timeout, `dev ${name}`);
		},
		/** Like closing the device's tab: its page, sockets and peer connections go away. */
		kill(name: string) {
			frames.get(name)?.remove();
			frames.delete(name);
		},
		async reload(name: string): Promise<Dev> {
			frames.get(name)!.contentWindow!.location.reload();
			await sleep(200);
			return this.dev(name);
		},
		async until<T>(fn: () => T | Promise<T>, timeout = 15_000, what = 'condition'): Promise<NonNullable<T>> {
			const t0 = performance.now();
			for (;;) {
				try {
					const v = await fn();
					if (v) return v as NonNullable<T>;
				} catch {
					// not yet
				}
				if (performance.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
				await sleep(50);
			}
		},
		sleep,
		sha256: (d: Uint8Array) => sha256Hex(d),
		te,
	};
	(window as unknown as { e2e: typeof e2e }).e2e = e2e;
}

const q = new URLSearchParams(location.search);
const name = q.get('device');
if (name) device(name, q.get('key') ?? '').catch((e) => ($('state').textContent = `start failed: ${e?.stack ?? e}`));
else control();
