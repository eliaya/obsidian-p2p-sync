# Research notes (2026-11-15)

Findings that shape M3 (peer), M4 (scan) and M7 (deploy). "Unverified" means the source did not say; test on a device.

## Hidden-file scanning (from obsidian-livesync, MIT; design only)

- Vault events do not reliably cover `.obsidian`; LiveSync scans with `vault.adapter.list` recursively, every 60 s and on `visibilitychange` / focus.
- Change key is `mtime-size`; mtimes are compared after truncating to 2 s. We hash content when the key changes, so truncation is not needed for correctness.
- Self-write loop: after writing a file, remember `path-mtime-size` and skip the next scan hit for it.
- Default ignores there: `node_modules`, `.git`, the plugin's own folder.
- After plugin / theme files change they offer a reload; there is no public Obsidian API to reload the app or a plugin (LiveSync uses private APIs). We only show a notice.

## Obsidian API (obsidian.d.ts)

- `adapter.writeBinary(path, data, { mtime })` can set mtime. `adapter.stat` returns `{ type, ctime, mtime, size }`.
- `vault.configDir` is usually `.obsidian` but must not be hard-coded.
- `app.loadLocalStorage` / `saveLocalStorage` are per vault (since 1.8.7).
- `requestUrl` has no CORS limits and takes / returns `ArrayBuffer`; use it for mailbox HTTP on mobile.
- `addStatusBarItem` is not supported on mobile.
- Review rules: no `innerHTML`, no Node APIs, no default hotkeys, disclose network use.
- Unverified on mobile: `RTCPeerConnection`, `WebSocket`, `indexedDB`, hidden-file events.

## WebRTC data channel (from LiveSync)

- Their standard payload is 15,360 bytes; fallbacks 2,048 / 1,024 / 800 for paths that drop larger messages. We start at 15 KB.
- They found no need for user-facing keepalive / reconnect settings; reconnect on resume instead.

## Cloudflare (developers.cloudflare.com)

- Workers Free: 10 ms CPU per HTTP request, 50 subrequests, 50 D1 queries per invocation (`batch` counts once).
- DO WebSocket: 20 incoming messages bill as 1 request; hibernation attachments max 16,384 bytes; max 10 tags per socket.
- D1 row / BLOB limit 2 MB. R2 `put` of a stream needs a known length.
- TURN: `POST https://rtc.live.cloudflare.com/v1/turn/keys/$KEY_ID/credentials/generate-ice-servers`, `Authorization: Bearer $TOKEN`, body `{"ttl":86400}`, 201 with `iceServers`.
- `wrangler secret put` reads stdin; `secret bulk` takes a JSON / .env file. Both deploy a new version immediately.
- `cf` CLI is beta (2026-09-28); keep Wrangler for a project that has `wrangler.jsonc`.
- Unverified: whether R2 needs a payment method on the account; whether Wrangler auto-loads `.env` (pass `--env-file`).
