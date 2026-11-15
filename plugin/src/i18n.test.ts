import { expect, test } from 'vitest';
import en from '../../locales/plugin/en.json';
import zhTW from '../../locales/plugin/zh-TW.json';
import { I18n, interpolate, pickLocale, readCache, refreshServerLocales, type ServerCache } from './i18n';

test('en and zh-TW have exactly the same keys, none empty', () => {
	expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
	for (const d of [en, zhTW]) for (const v of Object.values(d)) expect(v.trim()).not.toBe('');
});

test('lookup, substitution and fallback to en', () => {
	const i = new I18n();
	expect(i.t('command.syncNow')).toBe('Sync now');
	i.locale = 'zh-TW';
	expect(i.t('command.syncNow')).toBe('立即同步');
	expect(i.t('notice.conflict.many', { count: 3 })).toBe('同步處理了 3 個衝突：');
	i.locale = 'fr'; // not available: en
	expect(i.t('command.syncNow')).toBe('Sync now');
	expect(i.t('no.such.key')).toBe('no.such.key');
	expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
});

test('server languages and overrides; values are plain strings only', () => {
	const i = new I18n(readCache({ locales: { fr: { name: 'Français', updatedAt: 1, plugin: { 'command.syncNow': 'Synchroniser', bad: 5 } }, en: { name: 'English', updatedAt: 1, plugin: { 'status.never': 'Not yet' } } } }));
	i.locale = 'fr';
	expect(i.t('command.syncNow')).toBe('Synchroniser');
	expect(i.t('status.never')).toBe('Not yet'); // missing in fr: server en override, then built-in en
	expect(i.t('bad')).toBe('bad');
	expect(i.available().map((l) => l.code)).toEqual(['en', 'zh-TW', 'fr']);
	expect(readCache({ locales: { 'BAD CODE': { plugin: {} } } }).locales).toEqual({});
	expect(readCache('junk')).toEqual({ locales: {} });
});

test('refreshServerLocales fetches new or changed languages, keeps the cache when offline', async () => {
	const calls: string[] = [];
	const server: Record<string, unknown> = {
		'/api/i18n': { locales: [{ code: 'fr', name: 'Français', updatedAt: 2 }, { code: 'de', name: 'Deutsch', updatedAt: 1 }, { code: '<x>', name: 'x', updatedAt: 1 }] },
		'/api/i18n/fr': { name: 'Français', plugin: { k: 'v2' } },
		'/api/i18n/de': { name: 'Deutsch', plugin: { k: 'de' } },
	};
	const get = async (p: string) => (calls.push(p), server[p] ?? null);
	const old: ServerCache = { locales: { de: { name: 'Deutsch', updatedAt: 1, plugin: { k: 'cached' } }, it: { name: 'Italiano', updatedAt: 1, plugin: {} } } };
	const next = await refreshServerLocales(get, old);
	expect(calls).toEqual(['/api/i18n', '/api/i18n/fr']); // de unchanged, invalid code skipped
	expect(next.locales.fr?.plugin).toEqual({ k: 'v2' });
	expect(next.locales.de?.plugin).toEqual({ k: 'cached' });
	expect(next.locales.it).toBeUndefined(); // no longer on the server
	expect(await refreshServerLocales(async () => null, old)).toBe(old);
});

test('pickLocale: explicit choice, then Obsidian language, then its base, then en', () => {
	const av = ['en', 'zh-TW', 'fr'];
	expect(pickLocale('fr', 'zh-TW', av)).toBe('fr');
	expect(pickLocale('', 'zh-TW', av)).toBe('zh-TW');
	expect(pickLocale('', 'fr-CA', av)).toBe('fr');
	expect(pickLocale('', 'zh', av)).toBe('en');
	expect(pickLocale('gone', 'ja', av)).toBe('en');
});
