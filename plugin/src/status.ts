// Sync status shown in the ribbon, status bar and status window, plus notice coalescing and event debouncing.
import { type App, Modal, Setting } from 'obsidian';
import type { LinkState, RelayState } from './peer';
import { RelayError } from './peer';
import type { Conflict } from './sync';

type T = (key: string, vars?: Record<string, string | number>) => string;

export type Phase = 'unconfigured' | 'starting' | 'running' | 'stopped';

export interface StatusError {
	at: number;
	key: string;
	vars?: Record<string, string | number>;
}

export interface Status {
	phase: Phase;
	relay: RelayState;
	/** False when the platform has no RTCPeerConnection: only the mailbox syncs. */
	webrtc: boolean;
	peerId: string | null;
	peers: Map<string, LinkState>;
	lastSync: number | null;
	scanning: boolean;
	mailbox: { busy: number; lastReceive: number | null; lastPush: number | null; error: StatusError | null };
	errors: StatusError[];
}

const MAX_ERRORS = 10;

export const initialStatus = (phase: Phase = 'stopped'): Status => ({
	phase,
	relay: 'idle',
	webrtc: true,
	peerId: null,
	peers: new Map(),
	lastSync: null,
	scanning: false,
	mailbox: { busy: 0, lastReceive: null, lastPush: null, error: null },
	errors: [],
});

export class StatusStore {
	s: Status = initialStatus();
	private listeners = new Set<() => void>();

	update(fn: (s: Status) => void): void {
		fn(this.s);
		for (const l of this.listeners) l();
	}

	reset(phase: Phase): void {
		this.update((s) => Object.assign(s, initialStatus(phase)));
	}

	error(key: string, vars?: Record<string, string | number>): StatusError {
		const e = { at: Date.now(), key, ...(vars ? { vars } : {}) };
		this.update((s) => {
			// The same error again (e.g. "pending" every minute) only refreshes its time.
			const top = s.errors[0];
			if (top && top.key === key && JSON.stringify(top.vars) === JSON.stringify(e.vars)) s.errors.shift();
			s.errors.unshift(e);
			s.errors.length = Math.min(s.errors.length, MAX_ERRORS);
		});
		return e;
	}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
}

/** An error as an i18n key: relay refusals by code, anything else as a generic message. */
export function errorOf(e: unknown, fallbackKey: string): { key: string; vars?: Record<string, string> } {
	if (e instanceof RelayError) return { key: `status.relay.${e.code}`, vars: { status: String(e.status) } };
	return { key: fallbackKey, vars: { message: e instanceof Error ? e.message : String(e) } };
}

export type Overall = 'syncing' | 'synced' | 'offline' | 'attention';

const ATTENTION: RelayState[] = ['pending', 'revoked', 'unauthorized', 'room_full', 'too_many_pending', 'quota'];

export function overall(s: Status): Overall {
	if (s.phase === 'unconfigured' || ATTENTION.includes(s.relay)) return 'attention';
	if (s.phase === 'starting' || s.scanning || s.mailbox.busy > 0 || [...s.peers.values()].some((p) => p !== 'synced')) return 'syncing';
	// Without WebRTC the relay socket is never opened; the mailbox reaching the relay counts as online.
	const online = s.webrtc ? s.relay === 'online' : s.mailbox.error === null && s.mailbox.lastReceive !== null;
	return online ? 'synced' : 'offline';
}

export const OVERALL_ICON: Record<Overall, string> = {
	syncing: 'refresh-cw',
	synced: 'check-circle',
	offline: 'wifi-off',
	attention: 'alert-triangle',
};

/** The one-line relay state: the relay socket when WebRTC runs, otherwise the mailbox's last result. */
export function relayKey(s: Status): string {
	if (s.phase === 'unconfigured') return 'status.relay.unconfigured';
	if (s.phase === 'stopped') return 'status.relay.idle';
	if (!s.webrtc) {
		if (s.mailbox.error?.key.startsWith('status.relay.')) return s.mailbox.error.key;
		if (s.mailbox.error) return 'status.relay.offline';
		return s.mailbox.lastReceive ? 'status.relay.online' : 'status.relay.connecting';
	}
	return `status.relay.${s.relay}`;
}

/** Groups a peerId in fours for comparing by eye, as the relay dashboard shows it. */
export const groupFingerprint = (peerId: string) => (peerId.match(/.{1,4}/g) ?? []).join(' ');
export const shortId = (peerId: string) => groupFingerprint(peerId.slice(0, 8));

/** Lines of one notice for a batch of conflicts. */
export function conflictLines(t: T, conflicts: Conflict[], selfId: string): string[] {
	const lines = [t(conflicts.length === 1 ? 'notice.conflict.one' : 'notice.conflict.many', { count: conflicts.length })];
	const SHOWN = 5;
	for (const c of conflicts.slice(0, SHOWN)) {
		const how =
			c.kind === 'merge'
				? t('notice.conflict.merged')
				: c.winner?.deviceId === selfId
					? t('notice.conflict.keptSelf')
					: t('notice.conflict.keptOther', { device: shortId(c.winner?.deviceId ?? '') });
		lines.push(`${c.path}: ${how}`);
	}
	if (conflicts.length > SHOWN) lines.push(t('notice.conflict.more', { count: conflicts.length - SHOWN }));
	lines.push(t('notice.conflict.history'));
	return lines;
}

/** Collects items for `delay` ms after the first one, then hands them over in one call. */
export class Coalescer<I> {
	private items: I[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	constructor(
		private delay: number,
		private flush: (items: I[]) => void,
	) {}

	push(item: I): void {
		this.items.push(item);
		this.timer ??= setTimeout(() => {
			this.timer = null;
			this.flush(this.items.splice(0));
		}, this.delay);
	}

	cancel(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.items = [];
	}
}

/**
 * Per-key debounce: runs a key's action `delay` ms after its last event. The first action of a burst is
 * kept, so a rename followed by a modify of the new path still runs as a rename.
 */
export class KeyedDebouncer {
	private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; fn: () => void }>();
	constructor(private delay: number) {}

	schedule(key: string, fn: () => void): void {
		const old = this.pending.get(key);
		if (old) clearTimeout(old.timer);
		const keep = old?.fn ?? fn;
		const timer = setTimeout(() => {
			this.pending.delete(key);
			keep();
		}, this.delay);
		this.pending.set(key, { timer, fn: keep });
	}

	cancel(): void {
		for (const p of this.pending.values()) clearTimeout(p.timer);
		this.pending.clear();
	}
}

const time = (t: T, ms: number | null) => (ms ? new Date(ms).toLocaleString() : t('status.never'));
const errText = (t: T, e: StatusError) => `${new Date(e.at).toLocaleTimeString()} ${t(e.key, e.vars)}`;

export interface StatusHost {
	app: App;
	status: StatusStore;
	t: T;
	syncNow(): void;
	/** Bundles waiting on the relay for this device, or null when unknown. */
	pendingBundles(): Promise<number | null>;
}

export class StatusModal extends Modal {
	private off: (() => void) | null = null;
	private waiting: number | null = null;

	constructor(private host: StatusHost) {
		super(host.app);
	}

	onOpen(): void {
		this.setTitle(this.host.t('status.title'));
		this.modalEl.addClass('pvs-modal');
		this.off = this.host.status.subscribe(() => this.render());
		this.render();
		void this.host.pendingBundles().then((n) => {
			this.waiting = n;
			this.render();
		});
	}

	onClose(): void {
		this.off?.();
		this.contentEl.empty();
	}

	private render(): void {
		const { t } = this.host;
		const s = this.host.status.s;
		const el = this.contentEl;
		el.empty();
		const o = overall(s);
		new Setting(el).setName(t('status.overall')).setDesc(t(`status.overall.${o}`));
		new Setting(el).setName(t('status.relay')).setDesc(statusFragment(t, s));
		if (!s.webrtc) new Setting(el).setName(t('status.webrtc')).setDesc(t('status.webrtc.unavailable'));
		new Setting(el).setName(t('status.lastSync')).setDesc(time(t, s.lastSync));

		new Setting(el).setName(t('status.peers')).setHeading();
		if (!s.peers.size) el.createDiv({ cls: 'pvs-muted', text: t('status.peers.none') });
		for (const [p, st] of s.peers) new Setting(el).setName(shortId(p)).setDesc(t(`status.link.${st}`));

		new Setting(el).setName(t('status.mailbox')).setHeading();
		const m = s.mailbox;
		new Setting(el).setName(t('status.mailbox.lastReceive')).setDesc(time(t, m.lastReceive));
		new Setting(el).setName(t('status.mailbox.lastPush')).setDesc(time(t, m.lastPush));
		new Setting(el)
			.setName(t('status.mailbox.waiting'))
			.setDesc(m.busy ? t('status.mailbox.busy') : this.waiting === null ? t('status.unknown') : String(this.waiting));
		if (m.error) new Setting(el).setName(t('status.mailbox.error')).setDesc(errText(t, m.error));

		new Setting(el).setName(t('status.errors')).setHeading();
		if (!s.errors.length) el.createDiv({ cls: 'pvs-muted', text: t('status.errors.none') });
		else {
			const list = el.createEl('ul', { cls: 'pvs-errors' });
			for (const e of s.errors) list.createEl('li', { text: errText(t, e) });
		}

		new Setting(el).addButton((b) =>
			b
				.setButtonText(t('command.syncNow'))
				.setCta()
				.onClick(() => this.host.syncNow()),
		);
	}
}

/** The relay state as text, with the fingerprint and the approval steps while pending. */
export function statusFragment(t: T, s: Status): DocumentFragment {
	const f = createFragment();
	const key = relayKey(s);
	f.createDiv({ text: t(key, { status: '' }) });
	const hint = `${key}.hint`;
	if (t(hint) !== hint) f.createDiv({ cls: 'pvs-muted', text: t(hint) });
	if (key === 'status.relay.pending' && s.peerId) f.createDiv({ cls: 'pvs-fingerprint', text: groupFingerprint(s.peerId) });
	return f;
}
