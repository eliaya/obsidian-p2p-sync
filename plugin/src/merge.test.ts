import { describe, expect, test } from 'vitest';
import { mergeText, pickWinner } from './merge';

describe('mergeText', () => {
	const base = 'First paragraph about apples.\n\nSecond paragraph about pears.\n\nThird paragraph about plums.\n';

	test('keeps edits from both sides in different places', () => {
		const a = base.replace('apples', 'green apples');
		const b = base.replace('plums', 'ripe plums');
		const m = mergeText(base, a, b);
		expect(m).toContain('green apples');
		expect(m).toContain('ripe plums');
		expect(m).toContain('pears');
	});

	test('identical edits do not duplicate', () => {
		const a = base.replace('pears', 'big pears');
		expect(mergeText(base, a, a)).toBe(a);
	});

	test('one side unchanged gives the other side', () => {
		const b = base + 'Fourth.\n';
		expect(mergeText(base, base, b)).toBe(b);
		expect(mergeText(base, b, base)).toBe(b);
	});
});

describe('mergeText failure', () => {
	const base = 'First paragraph about apples.\n\nSecond paragraph about pears.\n\nThird paragraph about plums.\n';
	const cases: [string, string][] = [
		[base.replace('apples', 'green apples'), base.replace('plums', 'ripe plums')],
		[base.replace('about pears', 'on quinces'), base.replace('about pears', 'regarding figs')],
		[base.replace('pears', 'pearls'), base.replace('Second paragraph about pears.\n\n', '')],
		['', base + 'tail'],
		['x', 'y'],
	];

	test('overlapping edits give null instead of dropping a side', () => {
		const [a, b] = cases[1]!;
		expect(mergeText(base, a, b)).toBeNull();
		expect(mergeText(base, b, a)).toBeNull();
	});

	test.each(cases)('swapping a and b gives the same result (%#)', (a, b) => {
		expect(mergeText(base, b, a)).toBe(mergeText(base, a, b));
	});

	test('a successful merge contains every change from both sides', () => {
		const [a, b] = cases[0]!;
		const m = mergeText(base, a, b)!;
		expect(m).toBe(base.replace('apples', 'green apples').replace('plums', 'ripe plums'));
	});
});

describe('pickWinner', () => {
	const r = (id: string, deviceId: string, mtime: number) => ({ id, deviceId, mtime });

	test('newest mtime wins', () => {
		expect(pickWinner([r('a:1', 'a', 1), r('b:1', 'b', 2)]).id).toBe('b:1');
	});

	test('mtime tie broken by deviceId, independent of input order', () => {
		const x = r('a:1', 'a', 5);
		const y = r('b:1', 'b', 5);
		expect(pickWinner([x, y]).id).toBe('a:1');
		expect(pickWinner([y, x]).id).toBe('a:1');
	});

	test('throws on empty input', () => {
		expect(() => pickWinner([])).toThrow();
	});
});
