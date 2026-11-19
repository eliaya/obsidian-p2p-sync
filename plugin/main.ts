import { type App, Component, Platform, Plugin, TFile, getLanguage, requestUrl, setIcon } from 'obsidian';
import { deriveKeys, generateIdentity, generateVaultKey, sha256Hex } from './src/crypto';
import { DeletedFileModal, HistoryModal } from './src/history';
import { BUILTIN, I18n, pickLocale, readCache, refreshServerLocales } from './src/i18n';
import { Mailbox } from './src/mailbox';
import { type NotifyPrefs, normalizeNotifyPrefs, notify, setNotifyPrefs } from './src/notify';
import { type Http, type PeerConnectionCtor, PeerManager, RelayClient, type WebSocketCtor } from './src/peer';
import { VaultScanner } from './src/scan';
import {
	type Settings,
	type Setup,
	SETUP_ACTION,
	SyncSettingTab,
	confirmDialog,
	normalizeRelayUrl,
	normalizeSettings,
	isVaultKey,
	parseSetup,
} from './src/settings';
import { Coalescer, KeyedDebouncer, OVERALL_ICON, StatusModal, StatusStore, conflictLines, errorOf, overall } from './src/status';
import { IdbStore } from './src/store';
import { type Conflict, SyncEngine } from './src/sync';

const TICK_MS = 60_000;
const DEBOUNCE_MS = 500;
const DAY_MS = 24 * 3600 * 1000;
const IDENTITY = 'plugin:identity';
const LAST_PRUNE = 'plugin:lastPrune';
// Local storage (per vault, per device): never synced.
const LS_DB_ID = 'peer-vault-sync:db-id';
const LS_LOCALE = 'peer-vault-sync:locale';
const LS_I18N = 'peer-vault-sync:i18n-cache';
const LS_NOTIFY = 'peer-vault-sync:notify';

interface Identity {
	privateKey: CryptoKey;
	publicKey: string;
	peerId: string;
}

export interface SessionEnv {
	app: App;
	settings: () => Settings;
	/** IndexedDB is shared by every vault of the app: this prefix is unique per vault. */
	dbPrefix: string;
	http: Http;
	WebSocket: WebSocketCtor;
	RTCPeerConnection?: PeerConnectionCtor;
	status: StatusStore;
	onConflict: (c: Conflict) => void;
	onWrite: (path: string, deleted: boolean) => void;
}

/**
 * One running sync: store, engine, scanner, peers and mailbox for the current relay and vault key.
 * Its events, intervals and DOM listeners are registered on itself, so unloading it removes them all.
 */
export class Session extends Component {
	store: IdbStore | null = null;
	engine: SyncEngine | null = null;
	scanner: VaultScanner | null = null;
	peers: PeerManager | null = null;
	mailbox: Mailbox | null = null;
	relay: RelayClient | null = null;
	peerId = '';
	private closed = false;
	private mailboxStarted = false;
	private debounce = new KeyedDebouncer(DEBOUNCE_MS);
	private changes = new Coalescer<null>(1000, () => this.propagate());
	private pushes = new Coalescer<null>(2000, () => void this.mail('push'));

	constructor(private env: SessionEnv) {
		super();
	}

	/** Open store, build engine and scanner, scan once, then start peers and mailbox. */
	async begin(): Promise<void> {
		const { env } = this;
		const s = env.settings();
		const baseUrl = normalizeRelayUrl(s.relayUrl);
		if (!baseUrl || !isVaultKey(s.vaultKey)) throw new Error('not configured');
		env.status.reset('starting');
		env.status.update((st) => (st.webrtc = !!env.RTCPeerConnection));
		const { roomId, signalKey, mailboxKey } = await deriveKeys(s.vaultKey);
		// One database per vault and room: a new vault key starts with a fresh history, identity and mailbox cursor.
		const store = await IdbStore.open(`${env.dbPrefix}-${roomId}`);
		if (this.closed) return store.close();
		this.store = store;
		let id = await store.getMeta<Identity>(IDENTITY);
		if (!id) {
			const g = await generateIdentity();
			id = { privateKey: g.keyPair.privateKey, publicKey: g.publicKey, peerId: g.peerId };
			await store.setMeta(IDENTITY, id);
		}
		if (this.closed) return;
		const selfId = id.peerId;
		this.peerId = selfId;
		env.status.update((st) => (st.peerId = selfId));

		let engine: SyncEngine | null = null;
		const scanner = new VaultScanner(env.app.vault.adapter, { recordLocal: (...a) => engine!.recordLocal(...a) }, store);
		engine = new SyncEngine(store, scanner, selfId);
		engine.onConflict = env.onConflict;
		engine.onWrite = env.onWrite;
		this.engine = engine;
		this.scanner = scanner;

		await this.scan();
		if (this.closed) return;

		const relay = new RelayClient({ baseUrl, roomId, publicKey: id.publicKey, privateKey: id.privateKey, http: env.http, WebSocket: env.WebSocket });
		this.relay = relay;
		if (env.RTCPeerConnection)
			this.peers = new PeerManager({
				relay,
				signalKey,
				selfId,
				engine,
				RTCPeerConnection: env.RTCPeerConnection,
				onState: (r) => !this.closed && env.status.update((st) => (st.relay = r)),
				onPeer: (p, ls) => {
					if (this.closed) return;
					env.status.update((st) => {
						if (ls === 'gone') st.peers.delete(p);
						else st.peers.set(p, ls);
						if (ls === 'synced') st.lastSync = Date.now();
					});
					if (ls === 'synced' || ls === 'gone') this.pushes.push(null);
				},
			});
		this.mailbox = new Mailbox({
			relay,
			store,
			engine,
			mailboxKey,
			selfId,
			links: () => this.peers?.links() ?? new Map(),
			onBadBundle: (bid) => env.status.error('error.badBundle', { id: bid }),
			onSkipped: (r) => env.status.error('error.tooLargeForMailbox', { path: r.path }),
		});

		const { vault } = env.app;
		const file = (path: string) => this.debounce.schedule(path, () => void this.guard(scanner.onFileEvent(path), 'error.event'));
		this.registerEvent(vault.on('create', (f) => file(f.path)));
		this.registerEvent(vault.on('modify', (f) => file(f.path)));
		this.registerEvent(vault.on('delete', (f) => file(f.path)));
		this.registerEvent(
			vault.on('rename', (f, oldPath) => this.debounce.schedule(f.path, () => void this.guard(scanner.onRename(oldPath, f.path).then(() => 1), 'error.event'))),
		);
		this.registerInterval(window.setInterval(() => void this.tick(), TICK_MS));
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') void this.resume();
		});

		env.status.update((st) => (st.phase = 'running'));
		this.peers?.start();
		await this.mail('start');
	}

	onunload(): void {
		this.closed = true;
		this.debounce.cancel();
		this.changes.cancel();
		this.pushes.cancel();
		this.peers?.stop();
		this.store?.close();
	}

	/** A scanner result: count > 0 means local changes to propagate. Errors are recorded, never thrown. */
	private async guard(p: Promise<number>, key: string): Promise<void> {
		try {
			if ((await p) > 0) this.changes.push(null);
		} catch (e) {
			if (this.closed) return;
			console.warn('peer-vault-sync:', e);
			const { key: k, vars } = errorOf(e, key);
			this.env.status.error(k, vars);
		}
	}

	private async scan(): Promise<void> {
		if (!this.scanner || this.closed) return;
		this.env.status.update((st) => (st.scanning = true));
		// A folder that cannot be listed rejects the whole scan; the next tick tries again.
		await this.guard(this.scanner.scanAll(), 'error.scan');
		if (!this.closed) this.env.status.update((st) => (st.scanning = false));
	}

	private propagate(): void {
		this.peers?.syncNow();
		void this.mail('push');
	}

	private async mail(op: 'start' | 'receive' | 'push'): Promise<void> {
		const box = this.mailbox;
		if (!box || this.closed) return;
		const { status } = this.env;
		status.update((st) => st.mailbox.busy++);
		try {
			if (op === 'push') await box.push();
			else if (op === 'start' || !this.mailboxStarted) await box.start();
			else await box.receive();
			if (op !== 'push') this.mailboxStarted = true;
			if (this.closed) return;
			status.update((st) => {
				st.mailbox.error = null;
				if (op === 'push') st.mailbox.lastPush = Date.now();
				else st.mailbox.lastReceive = Date.now();
				if (!this.peers) st.lastSync = Date.now();
			});
		} catch (e) {
			if (this.closed) return;
			const { key, vars } = errorOf(e, 'error.mailbox');
			const err = status.error(key, vars);
			status.update((st) => (st.mailbox.error = err));
		} finally {
			if (!this.closed) status.update((st) => st.mailbox.busy--);
		}
	}

	private async tick(): Promise<void> {
		await this.scan();
		await this.mail('receive');
		await this.pruneDaily();
	}

	private async pruneDaily(): Promise<void> {
		const { store, engine } = this;
		if (!store || !engine || this.closed) return;
		try {
			const now = Date.now();
			if (now - ((await store.getMeta<number>(LAST_PRUNE)) ?? 0) < DAY_MS) return;
			await engine.prune(now - this.env.settings().retentionDays * DAY_MS);
			await store.setMeta(LAST_PRUNE, now);
		} catch (e) {
			if (!this.closed) this.env.status.error('error.prune', errorOf(e, 'error.prune').vars);
		}
	}

	/** Back in the foreground: rescan, read mail, and reconnect at once instead of waiting out the backoff. */
	async resume(): Promise<void> {
		if (this.closed) return;
		if (this.peers && this.env.status.s.relay !== 'online') {
			this.peers.stop();
			this.peers.start();
		}
		await this.scan();
		await this.mail('receive');
	}

	async syncNow(): Promise<void> {
		await this.scan();
		this.peers?.syncNow();
		await this.mail('receive');
		await this.mail('push');
	}

	/** Paths with history whose file does not exist now. */
	async deletedPaths(): Promise<string[]> {
		if (!this.store) return [];
		const out: string[] = [];
		for (const p of await this.store.paths()) if (!(await this.env.app.vault.adapter.exists(p))) out.push(p);
		return out.sort();
	}

	/** Writes old content back; recorded as a new revision on top of the current one. */
	async restore(path: string, data: Uint8Array): Promise<void> {
		if (!this.scanner || !this.engine) throw new Error('not running');
		const now = Date.now();
		await this.scanner.write(path, data, now);
		await this.engine.recordLocal(path, data, now);
		this.changes.push(null);
	}
}

export default class PeerVaultSync extends Plugin {
	settings: Settings = normalizeSettings(null);
	i18n = new I18n();
	t = this.i18n.t;
	status = new StatusStore();
	session: Session | null = null;
	private ribbon: HTMLElement | null = null;
	private statusBar: HTMLElement | null = null;
	private restartTimer: number | null = null;
	private conflicts = new Coalescer<Conflict>(3000, (cs) => this.showConflicts(cs));
	private configWrites = new Coalescer<string>(3000, (ps) => notify(this.t('notice.configChanged', { count: ps.length }), 0));

	async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		this.i18n.server = readCache(this.app.loadLocalStorage(LS_I18N));
		setNotifyPrefs(this.notifyPrefs());
		this.applyLocale();
		const { t } = this;

		this.addSettingTab(new SyncSettingTab(this.app, this));
		this.addCommand({ id: 'sync-now', name: t('command.syncNow'), callback: () => this.syncNow() });
		this.addCommand({ id: 'show-status', name: t('command.showStatus'), callback: () => this.openStatus() });
		this.addCommand({
			id: 'file-history',
			name: t('command.fileHistory'),
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f) return false;
				if (!checking) this.openHistory(f.path);
				return true;
			},
		});
		this.addCommand({ id: 'restore-deleted', name: t('command.restoreDeleted'), callback: () => void this.openDeleted() });

		this.ribbon = this.addRibbonIcon(OVERALL_ICON.attention, t('ribbon.title'), () => this.openStatus());
		if (!Platform.isMobile) {
			this.statusBar = this.addStatusBarItem();
			this.statusBar.addClass('mod-clickable', 'pvs-statusbar');
			this.registerDomEvent(this.statusBar, 'click', () => this.openStatus());
		}
		this.register(this.status.subscribe(() => this.renderIndicator()));
		this.renderIndicator();

		this.registerObsidianProtocolHandler(SETUP_ACTION, (p) => {
			const r = parseSetup(p.relay, p.key);
			if (typeof r === 'string') notify(this.t(r));
			else void this.confirmJoin(r);
		});
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile)) return;
				menu.addItem((i) =>
					i
						.setTitle(this.t('command.fileHistory'))
						.setIcon('history')
						.onClick(() => this.openHistory(file.path)),
				);
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			this.restart();
			if (this.status.s.phase === 'unconfigured') notify(this.t('notice.notConfigured'));
			void this.refreshLanguages();
		});
	}

	onunload(): void {
		// The session is a child component and unloads with the plugin.
		if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
		this.conflicts.cancel();
		this.configWrites.cancel();
	}

	async onExternalSettingsChange(): Promise<void> {
		const next = normalizeSettings(await this.loadData());
		const changed = next.relayUrl !== this.settings.relayUrl || next.vaultKey !== this.settings.vaultKey;
		Object.assign(this.settings, next);
		if (changed) this.restart();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Stops the running session, if any, and starts a new one when relay and key are set. */
	restart(): void {
		if (this.session) this.removeChild(this.session);
		this.session = null;
		const s = this.settings;
		if (!normalizeRelayUrl(s.relayUrl) || !isVaultKey(s.vaultKey)) return this.status.reset('unconfigured');
		const session = new Session({
			app: this.app,
			settings: () => this.settings,
			dbPrefix: `pvs-${this.dbId()}`,
			http: (r) => requestUrl({ ...r, throw: false }),
			WebSocket: window.WebSocket,
			RTCPeerConnection: (window as { RTCPeerConnection?: PeerConnectionCtor }).RTCPeerConnection,
			status: this.status,
			onConflict: (c) => this.conflicts.push(c),
			onWrite: (path) => this.onWrite(path),
		});
		this.session = session;
		this.addChild(session);
		session.begin().catch((e) => {
			if (this.session !== session) return;
			console.error('peer-vault-sync: start failed', e);
			this.status.update((st) => (st.phase = 'stopped'));
			const { key, vars } = errorOf(e, 'error.start');
			this.status.error(key, vars);
			notify(this.t(key, vars));
		});
	}

	requestRestart(): void {
		if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
		this.restartTimer = window.setTimeout(() => {
			this.restartTimer = null;
			this.restart();
		}, 1500);
	}

	private dbId(): string {
		let id = this.app.loadLocalStorage(LS_DB_ID) as unknown;
		if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) {
			id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
			this.app.saveLocalStorage(LS_DB_ID, id);
		}
		return id as string;
	}

	private onWrite(path: string): void {
		const dir = this.app.vault.configDir;
		if (!path.startsWith(`${dir}/`)) return;
		// Our own data.json came from another device: reload it now rather than wait for Obsidian to notice.
		if (path === `${this.manifest.dir ?? `${dir}/plugins/${this.manifest.id}`}/data.json`) return void this.onExternalSettingsChange();
		this.configWrites.push(path);
	}

	private showConflicts(cs: Conflict[]): void {
		const f = createFragment();
		for (const line of conflictLines(this.t, cs, this.session?.peerId ?? '')) f.createDiv({ text: line });
		notify(f, 20_000);
	}

	private renderIndicator(): void {
		const o = overall(this.status.s);
		const label = `${this.t('ribbon.title')}: ${this.t(`status.overall.${o}`)}`;
		if (this.ribbon) {
			setIcon(this.ribbon, OVERALL_ICON[o]);
			this.ribbon.setAttr('aria-label', label);
		}
		if (this.statusBar) {
			this.statusBar.empty();
			setIcon(this.statusBar.createSpan({ cls: 'pvs-statusbar-icon' }), OVERALL_ICON[o]);
			this.statusBar.createSpan({ text: this.t(`status.overall.${o}`) });
			this.statusBar.setAttr('aria-label', label);
		}
	}

	private openStatus(): void {
		new StatusModal({
			app: this.app,
			status: this.status,
			t: this.t,
			syncNow: () => this.syncNow(),
			pendingBundles: async () => {
				try {
					return (await this.session?.relay?.listBundles())?.length ?? null;
				} catch {
					return null;
				}
			},
		}).open();
	}

	rescan(): void {
		void this.session?.syncNow();
	}

	private syncNow(): void {
		if (!this.session) return void notify(this.t('notice.notConfigured'));
		notify(this.t('notice.syncStarted'));
		void this.session.syncNow();
	}

	private running(): Session | null {
		const s = this.session;
		if (s?.store && s.scanner) return s;
		notify(this.t('notice.notRunning'));
		return null;
	}

	openHistory(path: string): void {
		const s = this.running();
		if (!s?.store || !s.scanner) return;
		const scanner = s.scanner;
		new HistoryModal(
			{
				app: this.app,
				t: this.t,
				store: s.store,
				selfId: s.peerId,
				read: (p) => scanner.read(p),
				sha256: sha256Hex,
				restore: (p, d) => s.restore(p, d),
			},
			path,
		).open();
	}

	private async openDeleted(): Promise<void> {
		const s = this.running();
		if (!s) return;
		new DeletedFileModal(this.app, this.t, await s.deletedPaths(), (p) => this.openHistory(p)).open();
	}

	// ---------- pairing ----------

	async testRelay(url: string): Promise<boolean> {
		const base = normalizeRelayUrl(url);
		if (!base) return false;
		try {
			const res = await requestUrl({ url: `${base}/health`, throw: false });
			return res.status === 200 && (res.json as { ok?: unknown } | null)?.ok === true;
		} catch {
			return false;
		}
	}

	/** First device, or replacing the key: the latter cuts every other device off, so it asks first. */
	async createVault(): Promise<void> {
		const { t } = this;
		if (this.settings.vaultKey) {
			const ok = await confirmDialog(this.app, {
				title: t('settings.pair.rekey.confirm.title'),
				body: [t('settings.pair.rekey.confirm.body1'), t('settings.pair.rekey.confirm.body2')],
				confirm: t('settings.pair.rekey.button'),
				cancel: t('common.cancel'),
				danger: true,
			});
			if (!ok) return;
		}
		this.settings.vaultKey = generateVaultKey();
		await this.saveSettings();
		this.restart();
		notify(t('notice.vaultCreated'));
	}

	/** From a pasted code or an obsidian:// link: never applied without the user's confirmation. */
	async confirmJoin(setup: Setup): Promise<void> {
		const { t } = this;
		if (setup.vaultKey === this.settings.vaultKey && setup.relayUrl === normalizeRelayUrl(this.settings.relayUrl))
			return void notify(t('setup.alreadyPaired'));
		const body = [t('setup.confirm.relay', { relay: setup.relayUrl }), t('setup.confirm.vault', { vault: this.app.vault.getName() })];
		if (this.settings.vaultKey && this.settings.vaultKey !== setup.vaultKey) body.push(t('setup.confirm.replaceKey'));
		const files = this.app.vault.getFiles().length;
		if (files) body.push(t('setup.confirm.merge', { count: files }));
		body.push(t('setup.warning'));
		const ok = await confirmDialog(this.app, { title: t('setup.confirm.title'), body, confirm: t('setup.confirm.button'), cancel: t('common.cancel') });
		if (!ok) return;
		this.settings.relayUrl = setup.relayUrl;
		this.settings.vaultKey = setup.vaultKey;
		await this.saveSettings();
		this.restart();
		notify(t('setup.joined'));
	}

	// ---------- notices ----------

	notifyPrefs(): NotifyPrefs {
		return normalizeNotifyPrefs(this.app.loadLocalStorage(LS_NOTIFY));
	}

	setNotifyPrefs(p: NotifyPrefs): void {
		this.app.saveLocalStorage(LS_NOTIFY, p);
		setNotifyPrefs(p);
	}

	// ---------- language ----------

	localeChoice(): string {
		const v = this.app.loadLocalStorage(LS_LOCALE) as unknown;
		return typeof v === 'string' ? v : '';
	}

	setLocaleChoice(code: string): void {
		this.app.saveLocalStorage(LS_LOCALE, code || null);
		this.applyLocale();
		this.renderIndicator();
		notify(this.t('settings.language.changed'));
	}

	languages(): { code: string; name: string }[] {
		return this.i18n.available();
	}

	obsidianLanguageName(): string {
		const lang = getLanguage();
		return this.i18n.available().find((l) => l.code.toLowerCase() === lang.toLowerCase())?.name ?? lang;
	}

	private applyLocale(): void {
		this.i18n.locale = pickLocale(
			this.localeChoice(),
			getLanguage(),
			this.i18n.available().map((l) => l.code),
		);
	}

	/** Languages stored on the relay; returns how many, or null when the relay could not be reached. */
	async refreshLanguages(): Promise<number | null> {
		const base = normalizeRelayUrl(this.settings.relayUrl);
		if (!base) return null;
		let reached = false;
		const getJson = async (path: string) => {
			try {
				const res = await requestUrl({ url: base + path, throw: false });
				if (res.status !== 200) return null;
				reached = true;
				return res.json as unknown;
			} catch {
				return null;
			}
		};
		const next = await refreshServerLocales(getJson, this.i18n.server);
		if (!reached) return null;
		this.i18n.server = next;
		this.app.saveLocalStorage(LS_I18N, next);
		this.applyLocale();
		this.renderIndicator();
		return Object.keys(next.locales).filter((c) => !(c in BUILTIN)).length;
	}
}
