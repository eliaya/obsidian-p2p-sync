// Shared contracts between store, sync, merge, peer and mailbox. See docs/protocol.md.

/** One change to one file. id is `${deviceId}:${seq}`. */
export interface Revision {
	id: string;
	path: string;
	/** SHA-256 hex of the content; null when deleted. */
	blobHash: string | null;
	size: number;
	mtime: number;
	/** Author's peerId. */
	deviceId: string;
	/** Author's own counter, starting at 1, no gaps. */
	seq: number;
	/** Ids of the revisions of this path that this one replaces. */
	parents: string[];
	deleted: boolean;
	renamedFrom?: string;
}

/** deviceId -> highest seq held from that device. */
export type VersionVector = Record<string, number>;

export interface Store {
	putRevision(rev: Revision): Promise<void>;
	getRevision(id: string): Promise<Revision | undefined>;
	vector(): Promise<VersionVector>;
	/** Every revision the holder of `vv` is missing, ordered by (deviceId, seq). */
	revisionsSince(vv: VersionVector): Promise<Revision[]>;
	/** Revisions of `path` that no other revision names as a parent. */
	heads(path: string): Promise<Revision[]>;
	/** All revisions of `path`, newest first. */
	history(path: string): Promise<Revision[]>;
	/** Every path that has at least one revision. */
	paths(): Promise<string[]>;
	putBlob(hash: string, data: Uint8Array): Promise<void>;
	getBlob(hash: string): Promise<Uint8Array | undefined>;
	hasBlob(hash: string): Promise<boolean>;
	getMeta<T>(key: string): Promise<T | undefined>;
	setMeta(key: string, value: unknown): Promise<void>;
	/**
	 * Expire history content older than `before` (ms). Revisions are never deleted: seq numbers must
	 * stay gap-free for sync. Only blobs are dropped, and only those referenced by no head and by no
	 * revision with mtime >= `before`.
	 */
	prune(before: number): Promise<void>;
}

/** The vault as the sync engine sees it. Paths are vault-relative, '/'-separated. */
export interface VaultIO {
	read(path: string): Promise<Uint8Array | null>;
	write(path: string, data: Uint8Array, mtime: number): Promise<void>;
	remove(path: string): Promise<void>;
}

export type SyncMsg =
	| { t: 'vv'; vv: VersionVector }
	| { t: 'revs'; revs: Revision[] }
	| { t: 'want'; hashes: string[] }
	| { t: 'blob'; hash: string; data: Uint8Array }
	| { t: 'done' };

/** An ordered, reliable message pipe to one peer. Framing and chunking live below this. */
export interface Channel {
	send(msg: SyncMsg): Promise<void>;
	onmessage: ((msg: SyncMsg) => void) | null;
	onclose: (() => void) | null;
}

/** What goes into the encrypted mailbox for peers that are offline. */
export interface Bundle {
	revs: Revision[];
	blobs: { hash: string; data: Uint8Array }[];
}
