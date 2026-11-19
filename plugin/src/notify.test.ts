import { beforeEach, expect, test, vi } from 'vitest';

const shown: [unknown, number | undefined][] = [];
vi.mock('obsidian', () => ({
	Notice: class {
		constructor(m: unknown, d?: number) {
			shown.push([m, d]);
		}
	},
}));

const { DEFAULT_NOTIFY, normalizeNotifyPrefs, notify, setNotifyPrefs } = await import('./notify');

beforeEach(() => {
	shown.length = 0;
	setNotifyPrefs(DEFAULT_NOTIFY);
});

test('show keeps the caller duration', () => {
	notify('a');
	notify('b', 0);
	expect(shown).toEqual([
		['a', undefined],
		['b', 0],
	]);
});

test('autohide replaces every duration, including sticky ones', () => {
	setNotifyPrefs({ mode: 'autohide', seconds: 7 });
	notify('a', 0);
	notify('b', 20_000);
	notify('c');
	expect(shown.map((x) => x[1])).toEqual([7000, 7000, 7000]);
});

test('off shows nothing', () => {
	setNotifyPrefs({ mode: 'off', seconds: 4 });
	notify('a', 0);
	expect(shown).toEqual([]);
});

test('bad stored values fall back to defaults', () => {
	expect(normalizeNotifyPrefs(null)).toEqual(DEFAULT_NOTIFY);
	expect(normalizeNotifyPrefs('x')).toEqual(DEFAULT_NOTIFY);
	expect(normalizeNotifyPrefs({ mode: 'loud', seconds: 0 })).toEqual(DEFAULT_NOTIFY);
	expect(normalizeNotifyPrefs({ mode: 'off', seconds: 61 })).toEqual({ mode: 'off', seconds: 4 });
	expect(normalizeNotifyPrefs({ mode: 'autohide', seconds: 2.5 })).toEqual({ mode: 'autohide', seconds: 4 });
	expect(normalizeNotifyPrefs({ mode: 'autohide', seconds: 10 })).toEqual({ mode: 'autohide', seconds: 10 });
});
