CREATE TABLE peers (
	peer_hash TEXT PRIMARY KEY,
	room_hash TEXT NOT NULL,
	peer_id_enc TEXT NOT NULL,
	label_enc TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
	online INTEGER NOT NULL DEFAULT 0,
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL
);
CREATE INDEX peers_room ON peers (room_hash, status);

CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value_enc TEXT NOT NULL
);

CREATE TABLE audit_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	room_hash TEXT,
	peer_hash TEXT,
	event TEXT NOT NULL,
	bytes INTEGER
);
CREATE INDEX audit_ts ON audit_log (ts);

CREATE TABLE mailbox (
	id TEXT PRIMARY KEY,
	room_hash TEXT NOT NULL,
	sender_hash TEXT NOT NULL,
	size INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX mailbox_room ON mailbox (room_hash, created_at);

CREATE TABLE mailbox_ack (
	bundle_id TEXT NOT NULL,
	peer_hash TEXT NOT NULL,
	PRIMARY KEY (bundle_id, peer_hash)
);
