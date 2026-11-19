// Every notice the plugin shows goes through notify(), so this device's preference applies to all of them.
import { Notice } from 'obsidian';

export type NotifyMode = 'show' | 'autohide' | 'off';
export interface NotifyPrefs {
	mode: NotifyMode;
	seconds: number;
}

export const NOTIFY_SECONDS_MIN = 1;
export const NOTIFY_SECONDS_MAX = 60;
/** Obsidian's own Notice default is 4 s. */
export const DEFAULT_NOTIFY: NotifyPrefs = { mode: 'show', seconds: 4 };

let prefs: NotifyPrefs = DEFAULT_NOTIFY;

/** Read back from local storage, which may hold anything. */
export function normalizeNotifyPrefs(raw: unknown): NotifyPrefs {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof NotifyPrefs, unknown>>;
	const s = Number(r.seconds);
	return {
		mode: r.mode === 'autohide' || r.mode === 'off' ? r.mode : 'show',
		seconds: Number.isInteger(s) && s >= NOTIFY_SECONDS_MIN && s <= NOTIFY_SECONDS_MAX ? s : DEFAULT_NOTIFY.seconds,
	};
}

export function setNotifyPrefs(p: NotifyPrefs): void {
	prefs = p;
}

export function notify(message: string | DocumentFragment, duration?: number): void {
	if (prefs.mode === 'off') return;
	new Notice(message, prefs.mode === 'autohide' ? prefs.seconds * 1000 : duration);
}
