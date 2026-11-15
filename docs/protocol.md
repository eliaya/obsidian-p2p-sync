# Protocol

The contract between `plugin/` and `relay/`. Change this file first, then the code.

## Keys (plugin only; the relay never sees any of them)

| Name | How | Use |
|---|---|---|
| `vaultKey` | 32 random bytes, shared by QR / setup string (base64url) | root secret |
| `roomId` | HKDF-SHA256(vaultKey, salt = empty, info = `pvs/room`), 16 bytes, hex | names the room on the relay |
| `signalKey` | HKDF, info = `pvs/signal`, AES-256-GCM | encrypts SDP / ICE |
| `mailboxKey` | HKDF, info = `pvs/mailbox`, AES-256-GCM | encrypts mailbox bundles |
| identity | ECDSA P-256 key pair per device | signs relay requests |

- `peerId` = first 32 hex chars of SHA-256(raw public key, 65 bytes). It is also the `deviceId` in revisions.
- AES-GCM output is `nonce (12 random bytes) || ciphertext+tag`.

## Peer authentication

Every peer request to the relay carries three query parameters:

| Param | Value |
|---|---|
| `peer` | raw public key, base64url |
| `ts` | Unix time in ms |
| `sig` | base64url ECDSA-P256-SHA256 signature (WebCrypto raw `r||s`) over the UTF-8 string `METHOD\nPATHNAME\nTS` |

The relay rejects a request when the signature is invalid or `|now - ts| > 5 min` (401).
A peer seen for the first time is recorded as `pending` when the `require_approval` setting is on (default), otherwise `active`.

| Status | Response |
|---|---|
| 401 | `{"error":"unauthorized"}` |
| 403 | `{"error":"pending"}` or `{"error":"revoked"}` |
| 429 | `{"error":"room_full"}`, or `{"error":"too_many_pending"}` when 50 peers already await approval |
| 404 | `roomId` is not 32 lowercase hex chars |

## Health

`GET /health` returns 200 `{"ok":true}` with no authentication. The plugin's "test connection" and the deploy script use it.

## Signalling

`GET /room/:roomId` with `Upgrade: websocket`.

Relay to client (JSON text frames):

| Message | When |
|---|---|
| `{"t":"peers","peers":[peerId,...]}` | sent to a peer right after it joins: who else is connected |
| `{"t":"join","peer":peerId}` | someone else joined |
| `{"t":"leave","peer":peerId}` | someone else left |
| `{"t":"signal","from":peerId,"data":string}` | forwarded from another peer |

Client to relay: `{"to":peerId,"data":string}`. `data` is base64 of `signalKey`-encrypted bytes; the relay forwards it to `to` only and never inspects it. Frames over 16 KB are dropped and the socket is closed with code 1009.

`GET /room/:roomId/peers` (no upgrade) returns `{"peers":[{"peerId":string,"online":boolean}]}` for the room's `active` peers.

## Mailbox

| Request | Result |
|---|---|
| `PUT /mailbox/:roomId` body = encrypted bundle, `Content-Length` required | `{"id":string}`; 413 when the room is over quota |
| `GET /mailbox/:roomId` | `{"bundles":[{"id","size","createdAt"}]}`: bundles this peer has not acknowledged and did not send |
| `GET /mailbox/:roomId/:id` | the encrypted bytes |
| `DELETE /mailbox/:roomId/:id` | acknowledge; the relay deletes the bundle once every other `active` peer of the room has acknowledged |

## Data channel framing

One ordered, reliable RTCDataChannel labelled `sync` per pair of peers. The peer whose `peerId` sorts lower creates the `RTCPeerConnection`, the channel and the offer; the other only answers.

Signalling `data` is base64url(`signalKey`-AES-GCM(JSON)) with JSON `{"from","to","ts","sid","kind":"offer"|"answer"|"ice","sdp"?,"candidate"?}`. A receiver drops it unless it decrypts, `from` equals the relay's `from`, `to` is itself and `|now - ts| <= 5 min`. `sid` names the initiator's attempt; answers and candidates for another `sid` are ignored. ICE is trickled; a peer sends its candidates only after its offer / answer. Signals whose frame would exceed 16 KB are not sent.

Each `SyncMsg` (see `plugin/src/types.ts`) is packed as

```
u32 BE n || n bytes UTF-8 JSON header || body
```

The header is the message as JSON, except `blob`, whose header is `{"t":"blob","hash"}` and whose body is the content. Other messages have an empty body. The packed bytes are cut into frames of at most 15,360 bytes: `flag (1 byte: 1 = more frames follow, 0 = last) || payload`. Frames of one message are never interleaved with another's. A malformed frame closes the channel. The sender pauses while `bufferedAmount` > 1 MiB and resumes on `bufferedamountlow` (threshold 256 KiB).

Before creating each `RTCPeerConnection` a peer calls `POST /turn/:roomId` and uses the returned `iceServers`, cached for 23 h. On 404 `turn_disabled` it uses its configured STUN servers (default `stun:stun.cloudflare.com:3478`) and asks again after an hour; on any other failure it uses them without caching.

Whenever a round on one link gives a peer new revisions (or it makes new ones), it starts a round on each of its other open links, so peers that cannot link directly still converge through a common one. A link counts as synced only once a round on it, started by either end, has moved nothing.

## Mailbox payload

Every bundle is `mailboxKey`-AES-GCM over the same packing as above (`u32 BE n || JSON header || body`). The relay cannot tell the two kinds apart.

| Kind | Header | Body |
|---|---|---|
| data | `{"v":1,"kind":"data","since":VersionVector,"revs":[Revision],"blobs":[{"hash","len"}],"reply"?:id,"last"?:bool}` | the contents listed in `blobs`, concatenated in that order |
| request | `{"v":1,"kind":"request","id":string,"vv":VersionVector}` | empty |

- One upload holds at most 8 MiB of plaintext; a single content over 8 MiB goes alone. Content over 90 MiB is not mailed (its revision is); it still syncs P2P. A revision whose content was pruned is sent without it.
- `revs` are in (deviceId, seq) order. A receiver applies data in `createdAt` order with the same rules as P2P; revisions behind a seq gap are not stored.
- `since` is the vector this segment continues from: the sender's cursor (or the answered request's `vv`) plus the earlier segments of the same export. A receiver whose vector, after applying the bundle, is below `since` on any device has missed a bundle and sends a request, as it does for a seq gap.
- A sender keeps a cursor (version vector). It mails what is newer than the cursor when any `active` peer has no open link to it, and moves the cursor to its vector when every `active` peer is linked and synced. Revisions that arrived by mail also advance it.
- `request` asks for everything newer than `vv`. A new device sends one on first start, and any device sends one when a data bundle had gaps. At most one is open at a time; it closes when data with `reply` = its `id` and `last` = true arrives, and is re-sent after 30 days unanswered. Every device that reads a request answers it with data (`reply`, last segment `last: true`, possibly empty).
- A bundle that does not decrypt or parse is acknowledged and reported to the user, never retried.

## Relay storage (D1)

Lookup columns hold HMAC-SHA256 hex (key derived from `DB_ENC_KEY`), never the raw id: `room_hash` = HMAC(`room\n{roomId}`), `peer_hash` = HMAC(`peer\n{roomId}\n{peerId}`), so one device in two rooms is two rows. `*_enc` columns hold base64 of AES-256-GCM `nonce || ciphertext+tag` under a key derived from `DB_ENC_KEY`.

| Table | Columns |
|---|---|
| `peers` | `peer_hash` PK, `room_hash`, `peer_id_enc`, `label_enc`, `status` (`pending`/`active`/`revoked`), `online`, `first_seen`, `last_seen` |
| `settings` | `key` PK, `value_enc` |
| `audit_log` | `id` PK, `ts`, `room_hash`, `peer_hash`, `event`, `bytes`, `detail` (setting key or locale code only, never a value) |
| `mailbox` | `id` PK, `room_hash`, `sender_hash`, `size`, `created_at` |
| `mailbox_ack` | `bundle_id`, `peer_hash`, PK (both) |

Settings and defaults: `require_approval` = true, `max_peers_per_room` = 8, `mailbox_ttl_days` = 30, `mailbox_quota_bytes` = 1073741824, `audit_ttl_days` = 90, `turn_key_id`, `turn_api_token` (unset).

Audit events: `join`, `leave`, `mailbox_put`, `mailbox_ack`, `turn`, `admin_login`, `peer_approve`, `peer_revoke`, `peer_delete`, `setting_change`, `i18n_change`. No IP address and no payload is ever logged.

## Worker secrets

| Name | Value |
|---|---|
| `DB_ENC_KEY` | 32 random bytes, base64. HKDF derives the column key, the HMAC key and the session-cookie key from it |
| `ADMIN_TOKEN_HASH` | SHA-256 hex of the admin token generated at setup |

## TURN

`POST /turn/:roomId` (peer-signed, `active` only) returns `{"iceServers":[...]}` obtained from Cloudflare Realtime with the stored `turn_key_id` / `turn_api_token` (TTL 86400 s). 404 `{"error":"turn_disabled"}` when either is unset. Audit event `turn`.

## Admin API

The admin token is 32 random bytes (base64url) generated at setup; the Worker only holds its SHA-256 (`ADMIN_TOKEN_HASH`).

Session: `POST /api/admin/login` with `{"token":string}` answers 204 and sets `pvs_session` (`HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=43200`), value `expiryMs.hmac`, where the HMAC (key derived from `DB_ENC_KEY`) covers `expiryMs.sessionVersion`. `sessionVersion` is a counter kept encrypted in `settings` (`session_version`, not an API setting); logout increments it, so every cookie issued before is rejected at once. Wrong token: 401. Every other `/api/admin/*` route answers 401 without a valid cookie. Mutating routes require `Content-Type: application/json`.

| Route | Body / query | Result |
|---|---|---|
| `POST /api/admin/logout` | | 204, cookie cleared, all existing sessions invalidated |
| `GET /api/admin/overview` | | `{"rooms":n,"peers":{"active":n,"pending":n,"revoked":n,"online":n},"mailbox":{"bundles":n,"bytes":n}}` |
| `GET /api/admin/peers` | | `{"peers":[{"id","peerId","room","label","status","online","firstSeen","lastSeen","mailboxPendingBytes"}]}`; `id` is `peer_hash`, `room` is the first 8 chars of `room_hash` |
| `PATCH /api/admin/peers/:id` | `{"status"?: "active"\|"revoked", "label"?: string (max 64)}` | 204; `revoked` also closes the peer's live socket (code 4003). Audit `peer_approve` / `peer_revoke` |
| `DELETE /api/admin/peers/:id` | | 204; removes the row and its acks, closes its socket. Audit `peer_delete` |
| `GET /api/admin/settings` | | all settings; `turn_api_token` is never returned, only `"turn_api_token_set":boolean` |
| `PUT /api/admin/settings` | any subset of the settings; unknown keys or out-of-range values: 400 | 204. Audit `setting_change`, one row per key, `detail` = key name (no values logged) |
| `GET /api/admin/audit` | `before` (id), `event`, `peer` (peer_hash), `limit` (max 200, default 50) | `{"entries":[{"id","ts","room","peer","event","bytes","detail"}],"next":id\|null}`, newest first |

Setting ranges: `max_peers_per_room` 2..32, `mailbox_ttl_days` 1..365, `mailbox_quota_bytes` 1 MB..10 GB, `audit_ttl_days` 1..3650, `require_approval` boolean, `turn_key_id` / `turn_api_token` string up to 256 chars or `null` to clear.

## i18n

Built-in languages are `en` (source) and `zh-TW`, shipped as JSON in `locales/admin/*.json` and `locales/plugin/*.json` and bundled into the dashboard and the plugin. Further languages, and overrides of built-in strings, are added in the dashboard and stored in D1 table `translations` (`locale` PK, `name`, `data` JSON text, `updated_at`). UI strings are public, so this table is not encrypted.

| Route | Auth | Result |
|---|---|---|
| `GET /api/i18n` | none | `{"locales":[{"code","name","updatedAt"}]}`: languages stored on the relay |
| `GET /api/i18n/:locale` | none | `{"name":string,"admin":{key:string},"plugin":{key:string}}`; 404 when not stored. `Cache-Control: public, max-age=300` |
| `PUT /api/admin/i18n/:locale` | admin | body `{"name":string (max 64),"admin":{...},"plugin":{...}}`, flat string-to-string maps, whole body max 512 KB; 204. Audit `i18n_change` |
| `DELETE /api/admin/i18n/:locale` | admin | 204. Audit `i18n_change` |

`locale` matches `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`. Keys missing from a language fall back to `en`. The dashboard and the plugin load `GET /api/i18n` at start and offer the stored languages next to the built-in ones.
