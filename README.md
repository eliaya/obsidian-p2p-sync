# Peer Vault Sync

Sync an Obsidian vault between your own devices. Devices talk to each other directly over WebRTC when they are online together. A small relay you run on Cloudflare Workers handles signalling, holds encrypted "mailbox" bundles for devices that are offline, and has an admin dashboard.

```
  Obsidian plugin (device A) <======= WebRTC data channel =======> Obsidian plugin (device B)
        |   \                                                         /   |
        |    \__ HTTPS / WebSocket (signalling, mailbox) __ relay ___/    |
        |                         Cloudflare Worker                        |
        |              D1 (peers, settings)   R2 (encrypted mailbox)       |
        +--------------- STUN/TURN: Cloudflare Realtime (optional) --------+
```

- `plugin/` - the Obsidian plugin (`peer-vault-sync`).
- `relay/` - the Worker (Durable Object rooms, D1, R2) and `relay/web/`, the admin dashboard (built into `relay/public/`).
- `docs/protocol.md` - the contract between the two. `locales/` - UI strings (`en`, `zh-TW`).

## Security model

- **What is end-to-end encrypted.** Everything derived from the vault key stays on the devices: note content and file paths in mailbox bundles, and the WebRTC signalling messages (SDP/ICE). The relay never receives the vault key or any key derived from it.
- **What the relay can see.** Which room (a hash derived from the vault key) a device joins, each device's public key and IP address as seen by Cloudflare, when it connects, the size and time of mailbox bundles, and the device labels and settings you enter in the dashboard. It cannot read note content or paths.
- **Ciphertext is stored.** Mailbox bundles are kept in R2 as ciphertext until every device has fetched them or they expire (default 30 days, a setting in the dashboard). R2 also deletes any object 45 days after creation as a backstop.
- **The vault key is the access key.** Anyone who has it can derive the room, decrypt bundles and join as a device. Share it only through the QR code / setup link in the plugin, and treat the setup link like a password.
- **Disabling a device is not revoking a key.** Setting a device to `revoked` in the dashboard stops it from using the relay. It still holds the vault key and can sync directly with any device that lets it in. If a device is lost, create a new vault key and re-pair every device.
- **`DB_ENC_KEY` loss is unrecoverable.** The relay encrypts sensitive database columns with a key derived from this Worker secret. If it is lost or overwritten, those columns can never be decrypted and the relay must be reset. Vault data on your devices is unaffected. The setup script never overwrites it.
- **Admin token.** Shown once by `npm run setup`. The Worker stores only its SHA-256. Lose it and you re-run setup with `--rotate-admin-token`.

## Network use disclosure

The plugin makes network connections only when sync is configured, and only to:

1. **The relay server you configure** (your own Cloudflare Worker): HTTPS requests and a WebSocket for signalling, mailbox upload/download, and the connection test (`GET /health`).
2. **Other devices of yours**, directly over WebRTC.
3. **Cloudflare STUN/TURN** (`rtc.live.cloudflare.com`, credentials obtained from your relay), only if you enable TURN in the dashboard, to connect through restrictive networks.

There is no telemetry, analytics, or any other third-party request. Nothing is sent before you enter a relay URL and vault key.

## Requirements

- Node.js 22.12 or newer (developed on 26.12). Needed for `relay`, `relay/web` and `plugin`.
- A Cloudflare account with Workers, D1 and R2 enabled. R2 may require a payment method on the account (not verified; check in the dashboard).
- Obsidian 1.8.7 or newer (`minAppVersion` in `plugin/manifest.json`).

## Local development

Install dependencies once in each package (`npm install` in `relay/`, `relay/web/`, `plugin/`).

**relay**
```sh
cd relay
printf 'DB_ENC_KEY=%s\nADMIN_TOKEN_HASH=%s\n' "$(openssl rand -base64 32)" "$(printf 'dev-token' | shasum -a 256 | cut -d' ' -f1)" > .dev.vars   # git-ignored
npm run db:migrate:local
npm run dev            # http://localhost:8787, log in to the dashboard with "dev-token"
npm test && npm run typecheck
```

**relay/web** (dashboard)
```sh
cd relay/web
npm run dev            # Vite dev server
npm run build          # writes ../public, which the Worker serves as static assets
```

**plugin**
```sh
cd plugin
npm run build          # produces main.js
# install into a vault:
mkdir -p "<vault>/.obsidian/plugins/peer-vault-sync"
cp main.js manifest.json styles.css "<vault>/.obsidian/plugins/peer-vault-sync/"
```
Then enable "Peer Vault Sync" under Settings > Community plugins. `npm run dev` rebuilds on change, `npm test` runs the tests.

## Deploy to Cloudflare

1. **Create an API token.** Cloudflare dashboard > My Profile > API Tokens > Create Token > Create Custom Token. Add exactly these permissions, and limit it to your account:
   - Account > Workers Scripts > Edit
   - Account > D1 > Edit
   - Account > Workers R2 Storage > Edit
2. **Fill `relay/.env`.** `cp relay/.env.example relay/.env`, then set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Workers & Pages > Account ID). The file is git-ignored.
3. **One-time setup** (safe to repeat):
   ```sh
   cd relay
   npm run setup -- --dry-run   # lists what it would do, touches nothing
   npm run setup                # asks for confirmation; --yes skips it
   ```
   It creates the D1 database and the R2 bucket (reusing them if they exist), writes the D1 id into `wrangler.jsonc`, adds an R2 rule that deletes objects after 45 days, and sets the Worker secrets `DB_ENC_KEY` (skipped if it already exists) and `ADMIN_TOKEN_HASH`. **Copy the admin token it prints into a password manager; it is shown once.** `--rotate-admin-token` replaces it.
4. **Deploy:** `npm run deploy` builds the dashboard, runs typecheck and tests, applies the D1 migrations to the remote database, deploys, and checks `/health`. `npm run deploy -- --dry-run` runs everything except the migrations and the real deploy. If the URL cannot be read from the output, pass `--url https://your-worker.example.workers.dev`.
5. **First login.** Open the Worker URL, enter the admin token. In Settings you can optionally add TURN credentials (a Cloudflare Realtime TURN key id and API token).
6. **Set up the first device.** In the plugin settings enter the relay URL and generate a vault key; the plugin shows a QR code and setup link.
7. **Add other devices.** Open the setup link (or scan the QR code) on the other device. With "require approval" on (default) the new device shows as `pending` in the dashboard; set it to `active` to let it sync.

## Ignore rules

Put gitignore-style patterns in `.syncignore` at the vault root, or edit them under Settings > Peer Vault Sync > Ignore rules. The file itself always syncs, so every device uses the same rules. `.git/` is always ignored.

```
.DS_Store
.trash/
*.tmp
```

- A file that starts matching a rule stops syncing. Nothing is deleted: copies already on other devices stay where they are.
- Changes other devices made to an ignored file are kept in history but not written to disk. If you remove the rule later, they are written at the next sync; a local copy that differs is merged with them by the usual conflict rules.
- As in git, a file inside an ignored folder cannot be re-included with `!`.

## Known limitations

- iOS cannot sync in the background; devices sync while Obsidian is in the foreground. The mailbox means the other device need not be online at the same time.
- Whether Obsidian on iOS supports `RTCPeerConnection` is not yet confirmed on a real device. If it does not, that device would have to sync through the mailbox only.
- When you first merge two existing vaults, a file with the same path and different content and no common history is resolved by the conflict rules; the older content goes to history.
- History increases local storage use; the retention setting controls it.
- An open room can be used to consume TURN bandwidth. Keep "require approval" on.
- Not supported: a real `.git` repository or push to GitHub/GitLab/Gitea, a headless always-on peer, per-device selective sync, live multi-user collaboration, multiple admins or roles, automatic vault key rotation.
- The relay creates an empty placeholder Worker when `setup` sets the first secrets; `deploy` then replaces it. The scripts were written against Wrangler 4.162.0 and have not been run against a real account yet.

## License

License: TBD.

The dashboard is based on [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) (MIT); see `relay/web/NOTICE.md`.

---

## 繁體中文快速開始

1. 需要 Node.js 22.12 以上、Cloudflare 帳號、Obsidian 1.8.7 以上。
2. Cloudflare 後台建立自訂 API Token，只給你的帳號這三項權限：Account > Workers Scripts > Edit、Account > D1 > Edit、Account > Workers R2 Storage > Edit。
3. `cp relay/.env.example relay/.env`，填入 `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`。
4. `cd relay`，先 `npm run setup -- --dry-run` 看動作清單，再 `npm run setup`。把畫面上顯示的管理員 Token 存進密碼管理器（只顯示一次）。`DB_ENC_KEY` 已存在時不會被覆寫；它遺失就無法解密資料庫的加密欄位。
5. `npm run deploy`，完成後會檢查 `/health`。
6. 開啟 Worker 網址，用管理員 Token 登入後台。
7. 把 `plugin/` 建置後的 `main.js`、`manifest.json`、`styles.css` 複製到 Vault 的 `.obsidian/plugins/peer-vault-sync/`，在 Obsidian 啟用外掛，填入中繼伺服器網址並產生 Vault 金鑰（會顯示 QR Code 與設定連結）。
8. 在其他裝置開啟設定連結；新裝置在後台顯示為 `pending`，改為 `active` 後才會同步。
9. 不想同步的檔案：在 Vault 根目錄的 `.syncignore` 寫入 gitignore 格式的規則，或在外掛設定的「忽略規則」編輯。此檔案本身一律同步，所有裝置共用同一套規則；符合規則的檔案停止同步，但不會從其他裝置刪除。
10. 注意：Vault 金鑰等同存取權；在後台停用裝置不會讓它失去金鑰，裝置遺失時要更換金鑰並重新配對全部裝置。
