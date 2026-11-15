import { afterEach, expect, test, vi } from 'vitest';
vi.mock('obsidian', () => ({ Modal: class {}, Setting: class {} }));
import { I18n } from './i18n';
import { RelayError } from './peer';
import { Coalescer, KeyedDebouncer, StatusStore, conflictLines, errorOf, groupFingerprint, overall, relayKey, shortId } from './status';
import type { Conflict } from './sync';
import type { Revision } from './types';

afterEach(() => vi.useRealTimers());

const ID = '0123456789abcdef0123456789abcdef';

test('fingerprint in groups of four', () => {
	expect(groupFingerprint(ID)).toBe('0123 4567 89ab cdef 0123 4567 89ab cdef');
	expect(shortId(ID)).toBe('0123 4567');
	expect(groupFingerprint('')).toBe('');
});

const rev = (deviceId: string, path = 'a.md'): Revision => ({ id: `${deviceId}:1`, path, blobHash: 'h', size: 1, mtime: 1, deviceId, seq: 1, parents: [], deleted: false });
const conflict = (path: string, kind: 'merge' | 'pick', winner?: string): Conflict => ({ path, heads: [], kind, winner: winner ? rev(winner, path) : null, result: rev('self', path) });

test('conflicts become one notice', () => {
	const { t } = new I18n();
	expect(conflictLines(t, [conflict('a.md', 'merge')], 'self')).toEqual([
		'Sync resolved a conflict:',
		'a.md: edits from both sides were merged',
		'The other version is kept in the file history (View file history).',
	]);
	const many = [conflict('a.md', 'pick', 'self'), conflict('b.png', 'pick', ID), ...['c', 'd', 'e', 'f', 'g'].map((p) => conflict(`${p}.md`, 'merge'))];
	const lines = conflictLines(t, many, 'self');
	expect(lines[0]).toBe('Sync resolved 7 conflicts:');
	expect(lines[1]).toBe('a.md: kept the version from this device');
	expect(lines[2]).toBe('b.png: kept the version from device 0123 4567');
	expect(lines).toContain('…and 2 more');
	expect(lines).toHaveLength(1 + 5 + 1 + 1);
});

test('Coalescer: many pushes, one flush; cancel drops them', () => {
	vi.useFakeTimers();
	const flushed: number[][] = [];
	const c = new Coalescer<number>(1000, (xs) => flushed.push(xs));
	c.push(1);
	vi.advanceTimersByTime(500);
	c.push(2);
	c.push(3);
	vi.advanceTimersByTime(500);
	expect(flushed).toEqual([[1, 2, 3]]);
	c.push(4);
	c.cancel();
	vi.advanceTimersByTime(5000);
	expect(flushed).toEqual([[1, 2, 3]]);
});

test('KeyedDebouncer: one run per key per burst, first action kept', () => {
	vi.useFakeTimers();
	const runs: string[] = [];
	const d = new KeyedDebouncer(500);
	d.schedule('a', () => runs.push('rename a'));
	for (let i = 0; i < 5; i++) {
		vi.advanceTimersByTime(100);
		d.schedule('a', () => runs.push('modify a'));
	}
	d.schedule('b', () => runs.push('modify b'));
	vi.advanceTimersByTime(499);
	expect(runs).toEqual([]);
	vi.advanceTimersByTime(1);
	expect(runs.sort()).toEqual(['modify b', 'rename a']);
	d.schedule('c', () => runs.push('c'));
	d.cancel();
	vi.advanceTimersByTime(1000);
	expect(runs).toHaveLength(2);
});

test('overall state and relay text', () => {
	const st = new StatusStore();
	st.reset('unconfigured');
	expect(overall(st.s)).toBe('attention');
	expect(relayKey(st.s)).toBe('status.relay.unconfigured');
	st.reset('running');
	st.update((s) => (s.relay = 'pending'));
	expect(overall(st.s)).toBe('attention');
	expect(relayKey(st.s)).toBe('status.relay.pending');
	st.update((s) => (s.relay = 'online'));
	expect(overall(st.s)).toBe('synced');
	st.update((s) => s.peers.set(ID, 'syncing'));
	expect(overall(st.s)).toBe('syncing');
	st.update((s) => ((s.relay = 'offline'), s.peers.clear()));
	expect(overall(st.s)).toBe('offline');
	// Without WebRTC the mailbox result decides.
	st.update((s) => ((s.webrtc = false), (s.mailbox.lastReceive = 1)));
	expect(overall(st.s)).toBe('synced');
	st.update((s) => (s.mailbox.error = { at: 1, key: 'status.relay.revoked' }));
	expect(relayKey(st.s)).toBe('status.relay.revoked');
	expect(errorOf(new RelayError('room_full', 429), 'x').key).toBe('status.relay.room_full');
	expect(errorOf(new Error('boom'), 'error.scan')).toEqual({ key: 'error.scan', vars: { message: 'boom' } });
});

test('errors are capped', () => {
	const st = new StatusStore();
	for (let i = 0; i < 15; i++) st.error('error.scan', { message: String(i) });
	expect(st.s.errors).toHaveLength(10);
	expect(st.s.errors[0]?.vars?.message).toBe('14');
});

test('the same error repeated keeps one entry', () => {
	const st = new StatusStore();
	st.error('status.relay.pending');
	st.error('status.relay.pending');
	st.error('error.scan', { message: 'a' });
	st.error('error.scan', { message: 'b' });
	expect(st.s.errors.map((e) => e.vars?.message ?? e.key)).toEqual(['b', 'a', 'status.relay.pending']);
});
