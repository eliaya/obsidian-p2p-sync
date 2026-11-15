// Tiny i18n: flat key -> string tables, `{name}` substitution, fallback to en. Strings are plain text only.
import en from '../../locales/plugin/en.json';
import zhTW from '../../locales/plugin/zh-TW.json';

export type Dict = Record<string, string>;
export const BUILTIN: Record<string, Dict> = { en, 'zh-TW': zhTW };

/** Languages stored on the relay, as last fetched (kept in local storage so they work offline). */
export interface ServerCache {
	locales: Record<string, { name: string; updatedAt: number; plugin: Dict }>;
}

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function interpolate(s: string, vars?: Record<string, string | number>): string {
	return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Keeps only string values: whatever the relay sends is data, never markup or code. */
function strings(x: unknown): Dict {
	const out: Dict = {};
	if (x && typeof x === 'object' && !Array.isArray(x))
		for (const [k, v] of Object.entries(x)) if (typeof v === 'string') out[k] = v;
	return out;
}

export class I18n {
	locale = 'en';
	constructor(public server: ServerCache = { locales: {} }) {}

	t = (key: string, vars?: Record<string, string | number>): string => {
		const s = this.server.locales[this.locale]?.plugin[key] ?? BUILTIN[this.locale]?.[key] ?? this.server.locales.en?.plugin[key] ?? BUILTIN.en?.[key] ?? key;
		return interpolate(s, vars);
	};

	/** Built-in languages first, then the relay's, by code. */
	available(): { code: string; name: string }[] {
		const out = new Map<string, string>();
		for (const [code, d] of Object.entries(BUILTIN)) out.set(code, d['language.name'] ?? code);
		for (const [code, l] of Object.entries(this.server.locales)) if (!out.has(code)) out.set(code, l.name || code);
		return [...out].map(([code, name]) => ({ code, name }));
	}
}

/** `chosen` (a code, or '' for "follow Obsidian"), resolved against what is available; en as last resort. */
export function pickLocale(chosen: string, obsidianLang: string, available: string[]): string {
	const lower = available.map((c) => c.toLowerCase());
	for (const want of [chosen, obsidianLang]) {
		if (!want) continue;
		const i = lower.indexOf(want.toLowerCase());
		if (i >= 0) return available[i]!;
	}
	const base = obsidianLang.toLowerCase().split('-')[0];
	const j = lower.indexOf(base ?? '');
	return j >= 0 ? available[j]! : 'en';
}

/** Validates a cache read back from local storage (it may be from an older version or tampered with). */
export function readCache(x: unknown): ServerCache {
	const out: ServerCache = { locales: {} };
	const locales = (x as ServerCache | null)?.locales;
	if (locales && typeof locales === 'object')
		for (const [code, l] of Object.entries(locales))
			if (LOCALE_RE.test(code) && l && typeof l === 'object')
				out.locales[code] = { name: typeof l.name === 'string' ? l.name.slice(0, 64) : code, updatedAt: Number(l.updatedAt) || 0, plugin: strings(l.plugin) };
	return out;
}

/**
 * Refreshes `cache` from the relay: GET /api/i18n, then GET /api/i18n/:locale for each language that is new
 * or changed. Languages no longer listed are dropped. `getJson` resolves to null on any failure; if the list
 * cannot be fetched the cache is returned unchanged.
 */
export async function refreshServerLocales(getJson: (path: string) => Promise<unknown>, cache: ServerCache): Promise<ServerCache> {
	const list = (await getJson('/api/i18n')) as { locales?: unknown } | null;
	if (!list || !Array.isArray(list.locales)) return cache;
	const out: ServerCache = { locales: {} };
	for (const l of list.locales as { code?: unknown; name?: unknown; updatedAt?: unknown }[]) {
		if (typeof l?.code !== 'string' || !LOCALE_RE.test(l.code)) continue;
		const updatedAt = Number(l.updatedAt) || 0;
		const old = cache.locales[l.code];
		if (old && old.updatedAt === updatedAt) {
			out.locales[l.code] = old;
			continue;
		}
		const data = (await getJson(`/api/i18n/${encodeURIComponent(l.code)}`)) as { name?: unknown; plugin?: unknown } | null;
		if (!data) {
			if (old) out.locales[l.code] = old;
			continue;
		}
		const name = typeof data.name === 'string' ? data.name : typeof l.name === 'string' ? l.name : l.code;
		out.locales[l.code] = { name: name.slice(0, 64), updatedAt, plugin: strings(data.plugin) };
	}
	return out;
}
