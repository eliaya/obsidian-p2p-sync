// Start / stop order of a Session with a minimal fake vault, relay and Component.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => {
	// Just enough of Component: registered cleanups run on unload, like Obsidian's.
	class Component {
		private cleanups: (() => void)[] = [];
		load() {
			this.onload();
		}
		unload() {
			for (const f of this.cleanups.splice(0)) f();
			this.onunload();
		}
		onload() {}
		onunload() {}
		register(f: () => void) {
			this.cleanups.push(f);
		}
		registerEvent(ref: { off: () => void }) {
			this.cleanups.push(() => ref.off());
		}
		registerInterval(id: number) {
			this.cleanups.push(() => clearInterval(id));
			return id;
		}
		registerDomEvent(el: EventTarget, type: string, cb: EventListener) {
			el.addEventListener(type, cb);
			this.cleanups.push(() => el.removeEventListener(type, cb));
		}
	}
	const C = class {};
	return { Component, Plugin: Component, Modal: C, Notice: C, PluginSettingTab: C, Setting: C, FuzzySuggestModal: C, TFile: C, Platform: {} };
});

import type { SessionEnv } from '../main';
// '../main' would resolve to the bundled main.js next to it.
const MAIN = '../main.ts';
const { Session } = (await import(/* @vite-ignore */ MAIN)) as typeof import('../main');
import { generateVaultKey } from './crypto';
import { StatusStore } from './status';

const enc = (s: string) => new TextEncoder().encode(s);

class FakeVault {
	files = new Map<string, Uint8Array>();
	handlers = new Map<string, Set<unknown>>();
	configDir = '.obsidian';
	adapter = {
		list: async (dir: string) => {
			const d = dir === '/' ? '' : `${dir}/`;
			const files: string[] = [];
			const folders = new Set<string>();
			for (const p of this.files.keys()) {
				if (!p.startsWith(d)) continue;
				const rest = p.slice(d.length);
				if (rest.includes('/')) folders.add(d + rest.split('/')[0]);
				else files.push(p);
			}
			return { files, folders: [...folders] };
		},
		stat: async (p: string) => {
			const f = this.files.get(p);
			return f ? { type: 'file' as const, ctime: 1, mtime: 1, size: f.length } : null;
		},
		exists: async (p: string) => this.files.has(p),
		readBinary: async (p: string) => this.files.get(p)!.slice().buffer,
		writeBinary: async (p: string, d: ArrayBuffer) => void this.files.set(p, new Uint8Array(d)),
		remove: async (p: string) => void this.files.delete(p),
		mkdir: async () => undefined,
		rmdir: async () => undefined,
	};
	on(name: string, cb: unknown) {
		const set = this.handlers.get(name) ?? new Set();
		this.handlers.set(name, set);
		set.add(cb);
		return { off: () => set.delete(cb) };
	}
	handlerCount() {
		return [...this.handlers.values()].reduce((n, s) => n + s.size, 0);
	}
}

class FakeWS {
	static all: FakeWS[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage = null;
	onclose = null;
	onerror = null;
	constructor(public url: string) {
		FakeWS.all.push(this);
		real.setTimeout(() => this.onopen?.(), 0); // after PeerManager wired its handlers
	}
	send() {}
	close() {
		this.closed = true;
	}
}

class FakeRTC {}

/** Live timers, so a test can check that stopping left none behind. */
const live = new Set<unknown>();
const real = { setTimeout, clearTimeout, setInterval, clearInterval };

beforeEach(() => {
	live.clear();
	FakeWS.all = [];
	vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) => {
		const id = real.setTimeout(() => {
			live.delete(id);
			fn();
		}, ms);
		live.add(id);
		return id;
	});
	vi.stubGlobal('clearTimeout', (id: ReturnType<typeof setTimeout>) => (live.delete(id), real.clearTimeout(id)));
	vi.stubGlobal('setInterval', (fn: () => void, ms?: number) => {
		const id = real.setInterval(fn, ms);
		live.add(id);
		return id;
	});
	vi.stubGlobal('clearInterval', (id: ReturnType<typeof setInterval>) => (live.delete(id), real.clearInterval(id)));
	vi.stubGlobal('window', globalThis);
	vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
});
afterEach(async () => {
	// A PeerManager stopped mid-connect may still open (and at once close) one socket: let it land in this test.
	await new Promise((r) => real.setTimeout(r, 20));
	vi.unstubAllGlobals();
});

let n = 0;
function env(relayStatus: number, extra: Partial<SessionEnv> = {}) {
	const vault = new FakeVault();
	vault.files.set('a.md', enc('hello'));
	vault.files.set('.obsidian/app.json', enc('{}'));
	const calls: string[] = [];
	const status = new StatusStore();
	const vaultKey = generateVaultKey();
	const e: SessionEnv = {
		app: { vault } as never,
		settings: () => ({ relayUrl: 'http://localhost:8787', vaultKey, retentionDays: 30 }),
		dbPrefix: `pvs-test-${n++}`,
		http: async (r) => {
			calls.push(`${r.method} ${new URL(r.url).pathname}`);
			const ok = relayStatus === 200;
			const path = new URL(r.url).pathname;
			const json = !ok ? { error: 'pending' } : path.endsWith('/peers') ? { peers: [] } : r.method === 'PUT' ? { id: 'b1' } : { bundles: [] };
			return { status: relayStatus, arrayBuffer: new ArrayBuffer(0), json };
		},
		WebSocket: FakeWS as never,
		RTCPeerConnection: FakeRTC as never,
		status,
		onConflict: () => undefined,
		onWrite: () => undefined,
		...extra,
	};
	return { e, vault, calls, status };
}

const settle = () => new Promise((r) => real.setTimeout(r, 20));

test('incomplete settings: nothing starts', async () => {
	const { e, vault, calls } = env(200, { settings: () => ({ relayUrl: '', vaultKey: '', retentionDays: 30 }) });
	const s = new Session(e);
	s.load();
	await expect(s.begin()).rejects.toThrow('not configured');
	expect(s.store).toBeNull();
	expect(vault.handlerCount()).toBe(0);
	expect(calls).toEqual([]);
	expect(live.size).toBe(0);
});

test('start order: store, scan, then relay; stop leaves no timers, listeners or sockets', async () => {
	const { e, vault, calls, status } = env(200);
	const s = new Session(e);
	s.load();
	await s.begin();
	await settle();
	// First scan recorded the vault, hidden files included, before anything went to the relay.
	expect((await s.store!.paths()).sort()).toEqual(['.obsidian/app.json', 'a.md']);
	expect(calls[0]).toMatch(/^GET \/room\/[0-9a-f]{32}\/peers$/);
	expect(calls).toContain(`PUT /mailbox/${calls[0]!.split('/')[2]}`); // first start asks for the vault
	expect(FakeWS.all).toHaveLength(1);
	expect(status.s.relay).toBe('online');
	expect(status.s.phase).toBe('running');
	expect(status.s.peerId).toMatch(/^[0-9a-f]{32}$/);
	expect(vault.handlerCount()).toBe(4);

	s.unload();
	expect(vault.handlerCount()).toBe(0);
	expect(FakeWS.all[0]!.closed).toBe(true);
	expect(live.size).toBe(0);
	await expect(s.store!.paths()).rejects.toThrow(); // database closed
});

test('identity is created once per database and reused', async () => {
	const { e } = env(200);
	const a = new Session(e);
	a.load();
	await a.begin();
	const id = a.peerId;
	a.unload();
	const b = new Session(e);
	b.load();
	await b.begin();
	expect(b.peerId).toBe(id);
	b.unload();
});

test('pending device: status says so, retry timer is cleared on stop', async () => {
	const { e, status } = env(403);
	const s = new Session(e);
	s.load();
	await s.begin();
	await settle();
	expect(status.s.relay).toBe('pending');
	expect(status.s.mailbox.error?.key).toBe('status.relay.pending');
	expect(FakeWS.all).toHaveLength(0);
	expect(live.size).toBeGreaterThan(0); // PeerManager backoff + our interval
	s.unload();
	expect(live.size).toBe(0);
});

test('without RTCPeerConnection: mailbox only', async () => {
	const { e, status } = env(200, { RTCPeerConnection: undefined });
	const s = new Session(e);
	s.load();
	await s.begin();
	await settle();
	expect(s.peers).toBeNull();
	expect(status.s.webrtc).toBe(false);
	expect(FakeWS.all).toHaveLength(0);
	expect(status.s.mailbox.lastReceive).not.toBeNull();
	s.unload();
	expect(live.size).toBe(0);
});

test('stopped while starting: the late start does nothing', async () => {
	const { e, vault, calls } = env(200);
	const s = new Session(e);
	s.load();
	const p = s.begin();
	s.unload();
	await p;
	await settle();
	expect(vault.handlerCount()).toBe(0);
	expect(calls).toEqual([]);
	expect(live.size).toBe(0);
});

test('a scan that throws is recorded and does not stop the session', async () => {
	const { e, vault, status } = env(200);
	const list = vault.adapter.list;
	vault.adapter.list = async () => {
		throw new Error('EACCES');
	};
	const s = new Session(e);
	s.load();
	await s.begin();
	expect(status.s.errors[0]).toMatchObject({ key: 'error.scan', vars: { message: 'EACCES' } });
	expect(status.s.phase).toBe('running');
	vault.adapter.list = list;
	await s.syncNow();
	expect((await s.store!.paths()).length).toBe(2);
	s.unload();
});

test('restore writes old content as a new revision', async () => {
	const { e, vault } = env(200);
	const s = new Session(e);
	s.load();
	await s.begin();
	vault.files.set('a.md', enc('changed'));
	await s.syncNow();
	const [latest, first] = (await s.store!.history('a.md')).sort((x, y) => y.seq - x.seq);
	await s.restore('a.md', (await s.store!.getBlob(first!.blobHash!))!);
	expect(new TextDecoder().decode(vault.files.get('a.md'))).toBe('hello');
	const h = (await s.store!.history('a.md')).sort((x, y) => y.seq - x.seq);
	expect(h).toHaveLength(3);
	expect(h[0]!.parents).toEqual([latest!.id]);
	expect(h[0]!.blobHash).toBe(first!.blobHash);
	vault.files.delete('a.md');
	await s.syncNow();
	expect(await s.deletedPaths()).toEqual(['a.md']);
	s.unload();
});
