CREATE TABLE translations (
	locale TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	data TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
