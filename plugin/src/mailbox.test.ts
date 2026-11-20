import { describe, expect, test } from 'vitest';
import { decrypt, deriveKeys, encrypt, fromBase64Url, generateIdentity, generateVaultKey, sha256Hex } from './crypto';
import { Mailbox, SEGMENT_BYTES } from './mailbox';
import { type Http, type LinkState, RelayClient, RelayError, unpack } from './peer';
import { dec, MemStore, node, put, sync } from './sync.testkit';

const ROOM = '0123456789abcdef0123456789abcdef';

/** In-memory relay following relay/src/mailbox.ts, reached through `http`. */
class FakeRelay {
	status = new Map<string, 'active' | 'pending' | 'revoked'>();
	bundles: { id: string; sender: string; createdAt: number; data: Uint8Array }[] = [];
	acks = new Map<string, Set<string>>();
	puts: { sender: string; data: Uint8Array }[] = [];
	ignoreAcks = false;
	private n = 0;

	private async verify(url: URL, method: string): Promise<string | null> {
		const { peer, ts, sig } = Object.fromEntries(url.searchParams);
		if (!peer || !ts || !sig) return null;
		try {
			const raw = fromBase64Url(peer);
			const key = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
			const ok = await crypto.subtle.verify(
				{ name: 'ECDSA', hash: 'SHA-256' },
				key,
				fromBase64Url(sig) as BufferSource,
				new TextEncoder().encode(`${method}\n${url.pathname}\n${ts}`),
			);
			return ok ? (await sha256Hex(raw)).slice(0, 32) : null;
		} catch {
			return null;
		}
	}

	http: Http = async (req) => {
		const res = (status: number, json: unknown = null, bytes: Uint8Array = new Uint8Array(0)) => ({ status, json, arrayBuffer: bytes.slice().buffer });
		const url = new URL(req.url);
		const me = await this.verify(url, req.method);
		if (!me) return res(401, { error: 'unauthorized' });
		const st = this.status.get(me) ?? 'pending';
		this.status.set(me, st);
		if (st !== 'active') return res(403, { error: st });
		const [, kind, , sub] = url.pathname.split('/');
		const active = [...this.status].filter(([, s]) => s === 'active').map(([p]) => p);
		if (kind === 'room' && sub === 'peers') return res(200, { peers: active.map((peerId) => ({ peerId, online: false })) });
		if (kind !== 'mailbox') return res(404);
		if (!sub && req.method === 'PUT') {
			const data = new Uint8Array(req.body!);
			const id = `b${++this.n}`;
			this.bundles.push({ id, sender: me, createdAt: this.n, data });
			this.puts.push({ sender: me, data });
			return res(200, { id });
		}
		if (!sub && req.method === 'GET') {
			const list = this.bundles.filter((b) => b.sender !== me && !this.acks.get(b.id)?.has(me));
			return res(200, { bundles: list.map((b) => ({ id: b.id, size: b.data.length, createdAt: b.createdAt })) });
		}
		const b = this.bundles.find((x) => x.id === sub);
		if (req.method === 'DELETE') {
			if (b && b.sender !== me && !this.ignoreAcks) {
				const acks = this.acks.get(b.id) ?? new Set();
				acks.add(me);
				this.acks.set(b.id, acks);
				if (active.every((p) => p === b.sender || acks.has(p))) this.bundles = this.bundles.filter((x) => x !== b);
			}
			return res(204);
		}
		return b ? res(200, null, b.data) : res(404);
	};

	/** Simulates expiry: the relay drops a bundle nobody fetched in time. */
	expire(id: string) {
		this.bundles = this.bundles.filter((b) => b.id !== id);
	}
}

async function setup() {
	const relay = new FakeRelay();
	const { mailboxKey } = await deriveKeys(generateVaultKey());
	const device = async (store = new MemStore()) => {
		const id = await generateIdentity();
		relay.status.set(id.peerId, 'active');
		const n = node(id.peerId, store);
		const client = new RelayClient({
			baseUrl: 'https://relay.test',
			roomId: ROOM,
			publicKey: id.publicKey,
			privateKey: id.keyPair.privateKey,
			http: relay.http,
			WebSocket: null as never,
		});
		const links = new Map<string, LinkState>();
		const bad: string[] = [];
		const box = new Mailbox({ relay: client, store: n.store, engine: n.eng, mailboxKey, selfId: id.peerId, links: () => links, onBadBundle: (b) => bad.push(b) });
		return { ...n, peerId: id.peerId, client, links, bad, box };
	};
	/** Kinds of the payloads a device uploaded, decrypted with the room key. */
	const kinds = async (sender: string) =>
		Promise.all(relay.puts.filter((p) => p.sender === sender).map(async (p) => unpack<{ kind: string }>(await decrypt(mailboxKey, p.data)).header.kind));
	return { relay, mailboxKey, device, kinds };
}

const files = (n: { vault: { files: Map<string, Uint8Array> } }) => Object.fromEntries([...n.vault.files].map(([p, d]) => [p, dec(d)]));

describe('Mailbox', () => {
	test('B offline while A changes: B receives, acknowledges, bundle is deleted', async () => {
		const { relay, device } = await setup();
		const a = await device();
		const b = await device();
		await put(a, 'n.md', 'hello');
		await a.box.push();
		expect(relay.bundles).toHaveLength(1);
		await b.box.receive();
		expect(files(b)).toEqual({ 'n.md': 'hello' });
		expect(await b.store.vector()).toEqual(await a.store.vector());
		expect(relay.bundles).toHaveLength(0);
	});

	test('nothing is mailed when every peer is linked; cursor moves once all are synced', async () => {
		const { relay, device } = await setup();
		const a = await device();
		const b = await device();
		await put(a, 'old.md', 'history');
		await sync(a, b); // over P2P
		a.links.set(b.peerId, 'syncing');
		await a.box.push();
		expect(relay.puts).toHaveLength(0);
		a.links.set(b.peerId, 'synced');
		await a.box.push();
		expect(relay.puts).toHaveLength(0);
		a.links.clear(); // B goes away; only what is new since then is mailed
		await put(a, 'new.md', 'fresh');
		await a.box.push();
		await b.box.receive();
		expect(files(b)).toEqual({ 'old.md': 'history', 'new.md': 'fresh' });
		expect(relay.puts).toHaveLength(1); // the history was not mailed
	});

	test('fresh C gets the whole vault through a request; A and C are never online together', async () => {
		const { relay, device, kinds } = await setup();
		const a = await device();
		await put(a, 'one.md', '1');
		await put(a, 'two.bin', new Uint8Array([2, 2]));
		await a.box.start(); // A's own first start: its request has nobody to answer yet
		const c = await device();
		await c.box.start(); // C online alone: asks (and answers A's request, with nothing)
		expect((await kinds(c.peerId)).filter((k) => k === 'request')).toHaveLength(1);
		await a.box.receive(); // A online alone: answers
		await c.box.receive(); // C again alone: applies
		expect(files(c)).toEqual(files(a));
		expect(await c.store.vector()).toEqual(await a.store.vector());
		expect(await c.store.getMeta('mailbox:request')).toBeNull();
		expect(relay.bundles.filter((x) => x.sender === a.peerId)).toHaveLength(0); // answer acknowledged by C
	});

	test('a middle bundle expired: receiver asks, gets it, converges; only one open request', async () => {
		const { relay, device, kinds } = await setup();
		const a = await device();
		const b = await device();
		for (const v of ['v1', 'v2', 'v3']) {
			await put(a, `${v}.md`, v);
			await a.box.push();
		}
		relay.expire(relay.bundles[1]!.id);
		await b.box.receive();
		expect(files(b)).toEqual({ 'v1.md': 'v1' }); // v3 sits behind the gap and is not applied
		expect(await kinds(b.peerId)).toEqual(['request']);

		await put(a, 'v4.md', 'v4');
		await a.box.push();
		relay.expire(relay.bundles[relay.bundles.length - 1]!.id); // and an unrelated gap shows up before A answers
		await put(a, 'v5.md', 'v5');
		await a.box.push();
		await b.box.receive();
		expect(await kinds(b.peerId)).toEqual(['request']); // not sent again while one is open

		await a.box.receive();
		await b.box.receive();
		expect(files(b)).toEqual(files(a));
		expect(await b.store.vector()).toEqual(await a.store.vector());
		expect(await b.store.getMeta('mailbox:request')).toBeNull();
	});

	test('a lost bundle with no seq gap after it is still noticed through `since`', async () => {
		const { relay, device, kinds } = await setup();
		const a = await device();
		const b = await device();
		const c = await device();
		await put(a, 'a.md', 'from a');
		await a.box.push(); // bundle 1: A:1
		await sync(a, b);
		await put(b, 'b.md', 'from b');
		await sync(a, b);
		await a.box.push(); // bundle 2: only B:1, since {A:1}
		relay.expire(relay.bundles.find((x) => x.sender === a.peerId)!.id);
		await c.box.receive();
		expect(files(c)).toEqual({ 'b.md': 'from b' }); // nothing in bundle 2 is out of sequence for C
		expect(await kinds(c.peerId)).toEqual(['request']); // but C is behind its `since` on A
		await a.box.receive();
		await c.box.receive();
		expect(files(c)).toEqual(files(a));
		expect(await c.store.vector()).toEqual(await a.store.vector());
	});

	test('the same bundle applied twice creates nothing new', async () => {
		const { relay, device } = await setup();
		const a = await device();
		const b = await device();
		await put(a, 'n.md', 'x');
		await a.box.push();
		relay.ignoreAcks = true;
		await b.box.receive();
		const vv = await b.store.vector();
		const puts = relay.puts.length;
		await b.box.receive();
		expect(await b.store.vector()).toEqual(vv);
		expect(relay.puts.length).toBe(puts);
		expect(b.conflicts).toEqual([]);
	});

	test('bad bundles are acknowledged and reported, not retried', async () => {
		const { relay, device, mailboxKey } = await setup();
		const a = await device();
		const b = await device();
		const garbage = crypto.getRandomValues(new Uint8Array(64));
		const wrongShape = await encrypt(mailboxKey, new TextEncoder().encode('not a payload'));
		relay.bundles.push({ id: 'g1', sender: a.peerId, createdAt: 0, data: garbage }, { id: 'g2', sender: a.peerId, createdAt: 0, data: wrongShape });
		await put(a, 'n.md', 'ok');
		await a.box.push();
		await b.box.receive();
		expect(b.bad.sort()).toEqual(['g1', 'g2']);
		expect(files(b)).toEqual({ 'n.md': 'ok' });
		await b.box.receive();
		expect(b.bad).toHaveLength(2);
	});

	test('a large export is cut into segments and never holds much content at once', async () => {
		const { relay, device } = await setup();
		const store = new MemStore();
		let fetched = 0;
		let worst = 0;
		const getBlob = store.getBlob.bind(store);
		store.getBlob = async (h) => {
			const d = await getBlob(h);
			fetched += d?.length ?? 0;
			const uploaded = relay.puts.reduce((n, p) => n + p.data.length, 0);
			worst = Math.max(worst, fetched - uploaded);
			return d;
		};
		const a = await device(store);
		const b = await device();
		const MB = 1 << 20;
		for (let i = 0; i < 8; i++) await put(a, `f${i}.bin`, new Uint8Array(3 * MB).fill(i));
		await put(a, 'big.bin', new Uint8Array(9 * MB).fill(99));
		fetched = 0;
		await a.box.push();
		const sizes = relay.puts.map((p) => p.data.length);
		expect(sizes.length).toBeGreaterThanOrEqual(4); // 33 MB of content
		for (const s of sizes) expect(s <= SEGMENT_BYTES + 64 * 1024 || s > 9 * MB).toBe(true);
		expect(sizes.filter((s) => s > SEGMENT_BYTES)).toHaveLength(1); // only the 9 MB file, alone
		// Content fetched but not yet uploaded stays below one segment plus one blob, not the 33 MB total.
		expect(worst).toBeLessThanOrEqual(SEGMENT_BYTES + 9 * MB);
		expect(worst).toBeLessThan(fetched / 2);
		await b.box.receive();
		expect(await b.store.vector()).toEqual(await a.store.vector());
		expect([...b.vault.files.get('big.bin')!.subarray(0, 3)]).toEqual([99, 99, 99]);
	});

	test('uploads carry neither file names nor file contents in the clear', async () => {
		const { relay, device } = await setup();
		const a = await device();
		const b = await device();
		const name = 'secret-diary-name.md';
		const body = 'the plaintext content nobody should see';
		await put(a, name, body);
		await a.box.push();
		await b.box.start(); // request too
		await a.box.receive(); // answer too
		expect(relay.puts.length).toBeGreaterThanOrEqual(3);
		const has = (hay: Uint8Array, needle: Uint8Array) => {
			outer: for (let i = 0; i + needle.length <= hay.length; i++) {
				for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
				return true;
			}
			return false;
		};
		const enc = new TextEncoder();
		for (const p of relay.puts) {
			expect(has(p.data, enc.encode(name))).toBe(false);
			expect(has(p.data, enc.encode(body))).toBe(false);
		}
	});
});

describe('RelayClient errors', () => {
	test('pending, revoked and unauthorized are told apart', async () => {
		const { relay, device } = await setup();
		const a = await device();
		relay.status.set(a.peerId, 'pending');
		await expect(a.client.peers()).rejects.toMatchObject({ code: 'pending', status: 403 });
		relay.status.set(a.peerId, 'revoked');
		await expect(a.client.peers()).rejects.toMatchObject({ code: 'revoked' });
		const other = await generateIdentity();
		const forged = new RelayClient({
			baseUrl: 'https://relay.test',
			roomId: ROOM,
			publicKey: other.publicKey,
			privateKey: (await generateIdentity()).keyPair.privateKey, // signs with a key that is not `peer`
			http: relay.http,
			WebSocket: null as never,
		});
		const err = await forged.peers().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RelayError);
		expect(err).toMatchObject({ code: 'unauthorized', status: 401 });
	});

	test('429 room_full and 413 quota map to codes', async () => {
		const id = await generateIdentity();
		let next = { status: 429, json: { error: 'room_full' } as unknown };
		const http: Http = async () => ({ ...next, arrayBuffer: new ArrayBuffer(0) });
		const c = new RelayClient({ baseUrl: 'https://r', roomId: ROOM, publicKey: id.publicKey, privateKey: id.keyPair.privateKey, http, WebSocket: null as never });
		await expect(c.peers()).rejects.toMatchObject({ code: 'room_full' });
		next = { status: 413, json: { error: 'quota' } };
		await expect(c.putBundle(new Uint8Array(1))).rejects.toMatchObject({ code: 'quota' });
		next = { status: 500, json: null };
		await expect(c.listBundles()).rejects.toMatchObject({ code: 'http' });
	});
});
