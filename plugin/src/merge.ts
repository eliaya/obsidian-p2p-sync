import DiffMatchPatch from 'diff-match-patch';

/**
 * Three-way merge of a and b against base, or null when it cannot be done cleanly.
 * Applies base->b onto a and base->a onto b and accepts only when every hunk applies both ways
 * and both give the same text. So the result, including whether it fails, does not depend on
 * argument order, and overlapping edits fail instead of losing one side's hunks.
 */
export function mergeText(base: string, a: string, b: string): string | null {
	if (a === b || base === b) return a;
	if (base === a) return b;
	const ab = applyEdits(base, b, a);
	return ab !== null && ab === applyEdits(base, a, b) ? ab : null;
}

/** Applies the base->from edits onto `onto`; null if any hunk does not apply. */
function applyEdits(base: string, from: string, onto: string): string | null {
	const dmp = new DiffMatchPatch();
	const [text, ok] = dmp.patch_apply(dmp.patch_make(base, from), onto);
	return ok.every(Boolean) ? text : null;
}

/** Winner when contents cannot be merged: newest mtime, then smallest deviceId, then smallest id. */
export function pickWinner<T extends { mtime: number; deviceId: string; id: string }>(revs: T[]): T {
	const sorted = [...revs].sort(
		(x, y) => y.mtime - x.mtime || cmp(x.deviceId, y.deviceId) || cmp(x.id, y.id),
	);
	if (!sorted[0]) throw new Error('pickWinner: no revisions');
	return sorted[0];
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
