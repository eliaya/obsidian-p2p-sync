// File history: the revision list, a line diff against the current file, restore, and a picker for deleted files.
import DiffMatchPatch from 'diff-match-patch';
import { type App, FuzzySuggestModal, Modal, Notice, Setting } from 'obsidian';
import { confirmDialog } from './settings';
import { shortId } from './status';
import type { Revision, Store } from './types';

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface HistoryRow {
	rev: Revision;
	/** Made by this device. */
	self: boolean;
	/** Short fingerprint of the author. */
	device: string;
	/** Content is held, so it can be shown and restored. False when expired by retention or never received. */
	available: boolean;
}

/** Every revision of `path`, newest first. */
export async function loadHistory(store: Pick<Store, 'history' | 'hasBlob'>, path: string, selfId: string): Promise<HistoryRow[]> {
	const revs = [...(await store.history(path))].sort(
		(a, b) => b.mtime - a.mtime || (a.deviceId === b.deviceId ? b.seq - a.seq : a.deviceId < b.deviceId ? 1 : -1),
	);
	const rows: HistoryRow[] = [];
	for (const rev of revs)
		rows.push({
			rev,
			self: rev.deviceId === selfId,
			device: shortId(rev.deviceId),
			available: !!rev.blobHash && (await store.hasBlob(rev.blobHash)),
		});
	return rows;
}

export type DiffPart = { op: 'same' | 'add' | 'del'; lines: string[] } | { op: 'skip'; count: number };

const splitLines = (s: string) => {
	const lines = s.split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
};

/** Line diff from `a` to `b`; unchanged runs keep `context` lines on each side and collapse the rest. */
export function diffLines(a: string, b: string, context = 3): DiffPart[] {
	const dmp = new DiffMatchPatch();
	const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
	const diffs = dmp.diff_main(chars1, chars2, false);
	dmp.diff_charsToLines_(diffs, lineArray);
	const out: DiffPart[] = [];
	diffs.forEach(([op, text], i) => {
		const lines = splitLines(text);
		if (op !== 0) return void out.push({ op: op === 1 ? 'add' : 'del', lines });
		const head = i === 0 ? 0 : context;
		const tail = i === diffs.length - 1 ? 0 : context;
		if (lines.length <= head + tail + 1) return void out.push({ op: 'same', lines });
		if (head) out.push({ op: 'same', lines: lines.slice(0, head) });
		out.push({ op: 'skip', count: lines.length - head - tail });
		if (tail) out.push({ op: 'same', lines: lines.slice(-tail) });
	});
	return out;
}

/** UTF-8 text without NUL, else null (treated as binary). */
export function asText(b: Uint8Array): string | null {
	try {
		const s = new TextDecoder('utf-8', { fatal: true }).decode(b);
		return s.includes('\0') ? null : s;
	} catch {
		return null;
	}
}

export type Comparison =
	| { kind: 'same' }
	| { kind: 'gone' }
	| { kind: 'text'; parts: DiffPart[] }
	| { kind: 'binary'; oldSize: number; newSize: number; sameHash: boolean };

/** The selected version against the current file (null when it does not exist now). */
export function compare(sel: Uint8Array, selHash: string, cur: Uint8Array | null, curHash: string | null): Comparison {
	if (!cur) return { kind: 'gone' };
	if (selHash === curHash) return { kind: 'same' };
	const a = asText(sel);
	const b = asText(cur);
	if (a !== null && b !== null) return { kind: 'text', parts: diffLines(a, b) };
	return { kind: 'binary', oldSize: sel.length, newSize: cur.length, sameHash: false };
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// ---------- UI ----------

export interface HistoryHost {
	app: App;
	t: T;
	store: Pick<Store, 'history' | 'hasBlob' | 'getBlob'>;
	selfId: string;
	/** Current content of `path`, or null when it does not exist. */
	read(path: string): Promise<Uint8Array | null>;
	sha256(data: Uint8Array): Promise<string>;
	/** Writes `data` to `path` as a new local revision. */
	restore(path: string, data: Uint8Array): Promise<void>;
}

export class HistoryModal extends Modal {
	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private selected: string | null = null;

	constructor(
		private host: HistoryHost,
		private path: string,
	) {
		super(host.app);
	}

	onOpen(): void {
		this.setTitle(this.host.t('history.title', { path: this.path }));
		this.modalEl.addClass('pvs-modal', 'pvs-history');
		this.listEl = this.contentEl.createDiv({ cls: 'pvs-history-list' });
		this.detailEl = this.contentEl.createDiv({ cls: 'pvs-history-detail' });
		this.load().catch((e) => this.failed(e));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** The store went away (sync restarted or stopped) or a read failed. */
	private failed(e: unknown): void {
		this.detailEl.empty();
		this.detailEl.createDiv({ cls: 'pvs-error', text: this.host.t('history.loadFailed', { message: e instanceof Error ? e.message : String(e) }) });
	}

	private async load(): Promise<void> {
		const { t } = this.host;
		const rows = await loadHistory(this.host.store, this.path, this.host.selfId);
		this.listEl.empty();
		if (!rows.length) this.listEl.createDiv({ cls: 'pvs-muted', text: t('history.empty') });
		for (const row of rows) {
			const r = row.rev;
			const item = this.listEl.createEl('button', { cls: 'pvs-history-row' });
			item.toggleClass('is-selected', r.id === this.selected);
			item.createDiv({ cls: 'pvs-history-time', text: new Date(r.mtime).toLocaleString() });
			const meta = item.createDiv({ cls: 'pvs-history-meta' });
			meta.createSpan({ text: row.self ? t('history.thisDevice') : row.device });
			if (!r.deleted) meta.createSpan({ text: formatBytes(r.size) });
			if (r.deleted) meta.createSpan({ cls: 'pvs-badge', text: t('history.deleted') });
			if (r.renamedFrom) meta.createSpan({ cls: 'pvs-badge', text: t('history.renamedFrom', { path: r.renamedFrom }) });
			if (!r.deleted && !row.available) meta.createSpan({ cls: 'pvs-badge mod-warning', text: t('history.expired') });
			item.addEventListener('click', () => {
				this.selected = r.id;
				for (const b of Array.from(this.listEl.children)) b.removeClass('is-selected');
				item.addClass('is-selected');
				this.show(row).catch((e) => this.failed(e));
			});
		}
	}

	private async show(row: HistoryRow): Promise<void> {
		const { t } = this.host;
		const el = this.detailEl;
		el.empty();
		const r = row.rev;
		if (r.deleted) return void el.createDiv({ cls: 'pvs-muted', text: t('history.detail.deleted') });
		const data = row.available && r.blobHash ? await this.host.store.getBlob(r.blobHash) : undefined;
		if (!data || !r.blobHash) return void el.createDiv({ cls: 'pvs-muted', text: t('history.detail.expired') });
		const cur = await this.host.read(this.path);
		const c = compare(data, r.blobHash, cur, cur ? await this.host.sha256(cur) : null);
		if (this.selected !== r.id) return; // another row was picked meanwhile
		renderComparison(t, el, c);
		if (c.kind !== 'same')
			new Setting(el).addButton((b) =>
				b
					.setButtonText(t('history.restore'))
					.setCta()
					.onClick(async () => {
						const ok = await confirmDialog(this.app, {
							title: t('history.restore.title'),
							body: [t('history.restore.body', { path: this.path, time: new Date(r.mtime).toLocaleString() })],
							confirm: t('history.restore'),
							cancel: t('common.cancel'),
						});
						if (!ok) return;
						try {
							await this.host.restore(this.path, data);
							new Notice(t('history.restore.done', { path: this.path }));
							this.selected = null;
							el.empty();
							await this.load();
						} catch (e) {
							new Notice(t('history.restore.failed', { message: e instanceof Error ? e.message : String(e) }));
						}
					}),
			);
	}
}

function renderComparison(t: T, el: HTMLElement, c: Comparison): void {
	if (c.kind === 'same') return void el.createDiv({ cls: 'pvs-muted', text: t('history.diff.same') });
	if (c.kind === 'gone') return void el.createDiv({ cls: 'pvs-muted', text: t('history.diff.gone') });
	if (c.kind === 'binary') {
		el.createDiv({ text: t('history.diff.binary') });
		el.createDiv({ cls: 'pvs-muted', text: t('history.diff.sizes', { old: formatBytes(c.oldSize), new: formatBytes(c.newSize) }) });
		el.createDiv({ cls: 'pvs-muted', text: t(c.sameHash ? 'history.diff.hashSame' : 'history.diff.hashDiffers') });
		return;
	}
	el.createDiv({ cls: 'pvs-muted', text: t('history.diff.legend') });
	const pre = el.createDiv({ cls: 'pvs-diff' });
	for (const p of c.parts) {
		if (p.op === 'skip') {
			pre.createDiv({ cls: 'pvs-diff-skip', text: t('history.diff.skipped', { count: p.count }) });
			continue;
		}
		const mark = p.op === 'add' ? '+ ' : p.op === 'del' ? '- ' : '  ';
		for (const line of p.lines) pre.createDiv({ cls: `pvs-diff-line pvs-diff-${p.op}`, text: mark + line });
	}
}

/** Picks one of the paths that have history but no file now, then opens its history. */
export class DeletedFileModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		t: T,
		private paths: string[],
		private choose: (path: string) => void,
	) {
		super(app);
		this.setPlaceholder(t('deleted.placeholder'));
		this.emptyStateText = t('deleted.empty');
	}

	getItems(): string[] {
		return this.paths;
	}

	getItemText(p: string): string {
		return p;
	}

	onChooseItem(p: string): void {
		this.choose(p);
	}
}
