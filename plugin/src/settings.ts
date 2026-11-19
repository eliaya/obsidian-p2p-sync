// Shared settings (data.json, synced to every device), the setup code, and the settings tab.
import { type App, Modal, Notice, PluginSettingTab, Setting, type Plugin } from 'obsidian';
import qrcode from 'qrcode-generator';
import { fromBase64Url } from './crypto';
import { IGNORE_FILE } from './scan';
import { type Status, type StatusStore, groupFingerprint, statusFragment } from './status';

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface Settings {
	relayUrl: string;
	vaultKey: string;
	retentionDays: number;
}

export const DEFAULT_SETTINGS: Settings = { relayUrl: '', vaultKey: '', retentionDays: 90 };
export const RETENTION_MIN = 1;
export const RETENTION_MAX = 3650;
/** obsidian://<action>?relay=…&key=… */
export const SETUP_ACTION = 'peer-vault-sync';

/** data.json arrives from other devices too: take only well-typed fields. */
export function normalizeSettings(raw: unknown): Settings {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
	const days = Number(r.retentionDays);
	return {
		relayUrl: typeof r.relayUrl === 'string' ? r.relayUrl : DEFAULT_SETTINGS.relayUrl,
		vaultKey: typeof r.vaultKey === 'string' && isVaultKey(r.vaultKey) ? r.vaultKey : DEFAULT_SETTINGS.vaultKey,
		retentionDays: Number.isInteger(days) && days >= RETENTION_MIN && days <= RETENTION_MAX ? days : DEFAULT_SETTINGS.retentionDays,
	};
}

/** 32 bytes, base64url without padding. */
export function isVaultKey(s: string): boolean {
	if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return false;
	try {
		return fromBase64Url(s).length === 32;
	} catch {
		return false;
	}
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** The relay's base URL without a trailing slash, or null: https only, plain http for localhost. */
export function normalizeRelayUrl(s: string): string | null {
	let u: URL;
	try {
		u = new URL(s.trim());
	} catch {
		return null;
	}
	const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname));
	if (!ok || u.username || u.password || u.search || u.hash) return null;
	return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export interface Setup {
	relayUrl: string;
	vaultKey: string;
}

export type SetupError = 'setup.error.format' | 'setup.error.missing' | 'setup.error.relay' | 'setup.error.key';

export function encodeSetupCode(s: Setup): string {
	return `obsidian://${SETUP_ACTION}?${new URLSearchParams({ relay: s.relayUrl, key: s.vaultKey })}`;
}

/** Validates the fields of a setup link (from a pasted code or from the obsidian:// handler). */
export function parseSetup(relay: string | undefined, key: string | undefined): Setup | SetupError {
	if (!relay || !key) return 'setup.error.missing';
	const relayUrl = normalizeRelayUrl(relay);
	if (!relayUrl) return 'setup.error.relay';
	if (!isVaultKey(key)) return 'setup.error.key';
	return { relayUrl, vaultKey: key };
}

export function decodeSetupCode(code: string): Setup | SetupError {
	let u: URL;
	try {
		u = new URL(code.trim());
	} catch {
		return 'setup.error.format';
	}
	if (u.protocol !== 'obsidian:' || u.hostname !== SETUP_ACTION) return 'setup.error.format';
	return parseSetup(u.searchParams.get('relay') ?? undefined, u.searchParams.get('key') ?? undefined);
}

// ---------- modals ----------

export interface ConfirmOptions {
	title: string;
	body: string[];
	confirm: string;
	cancel: string;
	/** Style the confirm button as dangerous. */
	danger?: boolean;
}

/** Resolves true only when the user presses the confirm button. */
export function confirmDialog(app: App, o: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		let result = false;
		const m = new Modal(app);
		m.setTitle(o.title);
		m.modalEl.addClass('pvs-modal');
		for (const p of o.body) m.contentEl.createEl('p', { text: p });
		new Setting(m.contentEl)
			.addButton((b) => b.setButtonText(o.cancel).onClick(() => m.close()))
			.addButton((b) => {
				b.setButtonText(o.confirm).onClick(() => {
					result = true;
					m.close();
				});
				if (o.danger) b.setWarning();
				else b.setCta();
			});
		m.onClose = () => resolve(result);
		m.open();
	});
}

async function copy(t: T, text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice(t('notice.copied'));
	} catch {
		new Notice(t('notice.copyFailed'));
	}
}

/** The QR code as SVG elements (no markup strings). Fixed black on white: scanners need the contrast. */
export function renderQr(parent: HTMLElement, text: string): void {
	const qr = qrcode(0, 'M');
	qr.addData(text);
	qr.make();
	const n = qr.getModuleCount();
	const q = 4; // quiet zone
	let d = '';
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
	const svg = parent.createSvg('svg', { cls: 'pvs-qr', attr: { viewBox: `0 0 ${n + 2 * q} ${n + 2 * q}`, role: 'img' } });
	svg.createSvg('rect', { attr: { width: n + 2 * q, height: n + 2 * q, fill: '#fff' } });
	svg.createSvg('path', { attr: { d, fill: '#000' } });
}

class SetupCodeModal extends Modal {
	constructor(
		app: App,
		private t: T,
		private code: string,
		private relayUrl: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { t } = this;
		this.setTitle(t('setup.show.title'));
		this.modalEl.addClass('pvs-modal');
		const el = this.contentEl;
		el.createEl('p', { cls: 'pvs-warning', text: t('setup.warning') });
		el.createEl('p', { text: t('setup.show.relay', { relay: this.relayUrl }) });
		new Setting(el).addButton((b) =>
			b
				.setButtonText(t('setup.show.reveal'))
				.setWarning()
				.onClick(() => {
					b.buttonEl.closest('.setting-item')?.remove();
					this.reveal();
				}),
		);
	}

	private reveal(): void {
		const { t } = this;
		const el = this.contentEl;
		el.createEl('p', { text: t('setup.show.scan') });
		renderQr(el.createDiv({ cls: 'pvs-qr-wrap' }), this.code);
		el.createEl('code', { cls: 'pvs-code', text: this.code });
		new Setting(el).addButton((b) => b.setButtonText(t('setup.show.copy')).setCta().onClick(() => copy(t, this.code)));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ---------- settings tab ----------

export interface SettingsHost extends Plugin {
	settings: Settings;
	status: StatusStore;
	t: T;
	saveSettings(): Promise<void>;
	/** Restarts sync after relay or key changed; debounced. */
	requestRestart(): void;
	testRelay(url: string): Promise<boolean>;
	/** Asks, then applies a setup from a code or a link. */
	confirmJoin(setup: Setup): Promise<void>;
	createVault(): Promise<void>;
	localeChoice(): string;
	setLocaleChoice(code: string): void;
	languages(): { code: string; name: string }[];
	refreshLanguages(): Promise<number | null>;
	obsidianLanguageName(): string;
	/** Rescans and syncs if sync is running; otherwise does nothing. */
	rescan(): void;
}

export class SyncSettingTab extends PluginSettingTab {
	private off: (() => void) | null = null;

	constructor(
		app: App,
		private host: SettingsHost,
	) {
		super(app, host);
	}

	hide(): void {
		this.off?.();
		this.off = null;
		super.hide();
	}

	display(): void {
		const { host } = this;
		const { t, settings } = host;
		const el = this.containerEl;
		el.empty();
		this.off?.();

		// Relay
		new Setting(el).setName(t('settings.relay.heading')).setHeading();
		const relayError = createDiv({ cls: 'pvs-error' });
		const showRelayError = (v: string) => relayError.setText(v && !normalizeRelayUrl(v) ? t('settings.relay.invalid') : '');
		new Setting(el)
			.setName(t('settings.relay.name'))
			.setDesc(t('settings.relay.desc'))
			.addText((x) =>
				x
					.setPlaceholder('https://relay.example.com')
					.setValue(settings.relayUrl)
					.onChange(async (v) => {
						showRelayError(v);
						settings.relayUrl = v.trim();
						await host.saveSettings();
						host.requestRestart();
					}),
			)
			.addButton((b) =>
				b.setButtonText(t('settings.relay.test')).onClick(async () => {
					const ok = await host.testRelay(settings.relayUrl);
					new Notice(t(ok ? 'settings.relay.test.ok' : 'settings.relay.test.fail'));
				}),
			);
		el.appendChild(relayError);
		showRelayError(settings.relayUrl);

		// Pairing
		new Setting(el).setName(t('settings.pair.heading')).setHeading();
		const hasKey = !!settings.vaultKey;
		new Setting(el).setName(t('settings.pair.key')).setDesc(t(hasKey ? 'settings.pair.key.set' : 'settings.pair.key.unset'));

		if (!hasKey)
			new Setting(el)
				.setName(t('settings.pair.first.name'))
				.setDesc(t('settings.pair.first.desc'))
				.addButton((b) => b.setButtonText(t('settings.pair.first.button')).setCta().onClick(() => host.createVault().then(() => this.display())));

		let code = '';
		new Setting(el)
			.setName(t('settings.pair.join.name'))
			.setDesc(t(hasKey ? 'settings.pair.join.descReplace' : 'settings.pair.join.desc'))
			.addText((x) => x.setPlaceholder(`obsidian://${SETUP_ACTION}?…`).onChange((v) => (code = v)))
			.addButton((b) =>
				b.setButtonText(t('settings.pair.join.button')).onClick(async () => {
					const r = decodeSetupCode(code);
					if (typeof r === 'string') return void new Notice(t(r));
					await host.confirmJoin(r);
					this.display();
				}),
			);

		if (hasKey) {
			const relay = normalizeRelayUrl(settings.relayUrl);
			new Setting(el)
				.setName(t('settings.pair.share.name'))
				.setDesc(t(relay ? 'settings.pair.share.desc' : 'settings.pair.share.needRelay'))
				.addButton((b) =>
					b
						.setButtonText(t('settings.pair.share.button'))
						.setDisabled(!relay)
						.onClick(() => relay && new SetupCodeModal(this.app, t, encodeSetupCode({ relayUrl: relay, vaultKey: settings.vaultKey }), relay).open()),
				);
			new Setting(el)
				.setName(t('settings.pair.rekey.name'))
				.setDesc(t('settings.pair.rekey.desc'))
				.addButton((b) => b.setButtonText(t('settings.pair.rekey.button')).setWarning().onClick(() => host.createVault().then(() => this.display())));
		}

		// This device
		new Setting(el).setName(t('settings.device.heading')).setHeading();
		const fp = new Setting(el).setName(t('settings.device.fingerprint'));
		const statusSetting = new Setting(el).setName(t('settings.status.name'));
		const renderStatus = (s: Status) => {
			fp.setDesc(s.peerId ? groupFingerprint(s.peerId) : t('settings.device.fingerprint.none'));
			fp.controlEl.empty();
			if (s.peerId) {
				const id = s.peerId;
				fp.addButton((b) => b.setButtonText(t('settings.device.copy')).onClick(() => copy(t, id)));
			}
			statusSetting.setDesc(statusFragment(t, s));
		};
		renderStatus(host.status.s);
		this.off = host.status.subscribe(() => renderStatus(host.status.s));

		// History
		new Setting(el).setName(t('settings.history.heading')).setHeading();
		const daysError = createDiv({ cls: 'pvs-error' });
		new Setting(el)
			.setName(t('settings.history.days'))
			.setDesc(t('settings.history.days.desc'))
			.addText((x) => {
				x.inputEl.type = 'number';
				x.inputEl.min = String(RETENTION_MIN);
				x.inputEl.max = String(RETENTION_MAX);
				x.setValue(String(settings.retentionDays)).onChange(async (v) => {
					const n = Number(v);
					const ok = Number.isInteger(n) && n >= RETENTION_MIN && n <= RETENTION_MAX;
					daysError.setText(ok ? '' : t('settings.history.days.invalid', { min: RETENTION_MIN, max: RETENTION_MAX }));
					if (!ok) return;
					settings.retentionDays = n;
					await host.saveSettings();
				});
			});
		el.appendChild(daysError);

		// Ignore rules
		new Setting(el).setName(t('settings.ignore.heading')).setHeading();
		new Setting(el).setName(t('settings.ignore.name')).setDesc(t('settings.ignore.desc'));
		const adapter = this.app.vault.adapter;
		const rules = el.createEl('textarea', { cls: 'pvs-ignore', attr: { rows: 8, spellcheck: 'false', placeholder: '.DS_Store\n.trash/\n*.tmp' } });
		rules.disabled = true;
		void (async () => {
			try {
				if (await adapter.exists(IGNORE_FILE)) rules.value = await adapter.read(IGNORE_FILE);
				rules.disabled = false;
			} catch (e) {
				new Notice(t('settings.ignore.failed', { message: String(e) }));
			}
		})();
		new Setting(el).addButton((b) =>
			b.setButtonText(t('settings.ignore.save')).onClick(async () => {
				if (rules.disabled) return;
				try {
					await adapter.write(IGNORE_FILE, rules.value);
					new Notice(t('settings.ignore.saved'));
					host.rescan();
				} catch (e) {
					new Notice(t('settings.ignore.failed', { message: String(e) }));
				}
			}),
		);

		// Language
		new Setting(el).setName(t('settings.language.heading')).setHeading();
		new Setting(el)
			.setName(t('settings.language.name'))
			.setDesc(t('settings.language.desc'))
			.addDropdown((d) => {
				d.addOption('', t('settings.language.auto', { name: host.obsidianLanguageName() }));
				for (const l of host.languages()) d.addOption(l.code, l.name);
				d.setValue(host.localeChoice()).onChange((v) => {
					host.setLocaleChoice(v);
					this.display();
				});
			})
			.addButton((b) =>
				b.setButtonText(t('settings.language.refresh')).onClick(async () => {
					const n = await host.refreshLanguages();
					new Notice(n === null ? t('settings.language.refresh.fail') : t('settings.language.refresh.ok', { count: n }));
					this.display();
				}),
			);
	}
}
