# Peer Vault Sync

[日本語](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | **English**

Sync a whole Obsidian vault between your own devices: notes, attachments, and the `.obsidian` folder (themes, plugins, settings). Devices talk directly over WebRTC when they are online together; otherwise they hand off end-to-end encrypted "mailbox" bundles through a self-hosted relay on Cloudflare Workers.

- `plugin/`: the Obsidian plugin (`peer-vault-sync`).
- `relay/`: the Worker (Durable Object, D1, R2), the admin dashboard (`relay/web/`) and the UI strings (`relay/locales/`).

## Features

- Syncs the whole vault, including hidden folders, on desktop and mobile.
- End-to-end encryption. The relay never sees note content, file paths or keys.
- Concurrent edits to Markdown are three-way merged. Overlapping edits and non-text files take the newest version, and the other stays in history.
- Per-file history (compare, restore, restore deleted files).
- Ignore rules in gitignore format (`.syncignore`).
- A dashboard to approve and revoke devices, change settings, read the audit log and add UI languages.

## Install the plugin

- **From Community plugins** (once listed): Settings > Community plugins > Browse, search for "Peer Vault Sync".
- **Manually:** put `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/eliaya/obsidian-p2p-sync/releases/latest) in `<vault>/.obsidian/plugins/peer-vault-sync/`, then enable it.

Requires Obsidian 1.8.7 or newer. Back up your vault before the first sync.

## Deploy the relay

### Option A: one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eliaya/obsidian-p2p-sync/tree/main/relay)

1. Generate the secrets (needs Node.js):
   ```sh
   node -e "const c=require('crypto'),t=c.randomBytes(32).toString('base64url');console.log('admin token:',t);console.log('ADMIN_TOKEN_HASH:',c.createHash('sha256').update(t).digest('hex'));console.log('DB_ENC_KEY:',c.randomBytes(32).toString('base64'))"
   ```
   Save the **admin token** and **`DB_ENC_KEY`** in a password manager. If `DB_ENC_KEY` is lost, the encrypted database columns can never be read again.
2. Click the button, sign in to Cloudflare and connect GitHub/GitLab.
3. Paste `DB_ENC_KEY` and `ADMIN_TOKEN_HASH` (not the admin token itself) and deploy.
4. Open the Worker URL and sign in with the admin token.

Later pushes to the new repository redeploy automatically. If the build log shows a D1 migration permission error, give the Workers Builds API token "D1 Edit", or run `npx wrangler d1 migrations apply DB --remote` once and retry.

### Option B: from your computer

Needs Node.js 22.12 or newer and a clone of this repository.

1. Create a Cloudflare API token with Edit permission for Workers Scripts, D1 and Workers R2 Storage.
2. Run `cp relay/.env.example relay/.env` and set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (git-ignored).
3. Set up and deploy:
   ```sh
   cd relay
   npm install
   npm run setup          # creates D1, R2 and secrets; --dry-run only lists them
   npm run deploy:local   # build, typecheck, test, migrate, deploy, check /health
   ```
   **The admin token is printed once.** Replace it with `npm run setup -- --rotate-admin-token`.

## First use

1. Sign in to the dashboard. Under Settings you can add TURN credentials (Cloudflare Realtime) for strict networks (optional).
2. On the first device, enter the relay URL in the plugin settings and select "Create vault key".
3. In the dashboard, set the `pending` device to `active`.
4. On the first device select "Show setup code", paste it under "Join an existing vault" on the other device (or use the link or QR code), then approve it in the dashboard.

Commands: Sync now, Show sync status, View file history, Restore a deleted file.

## Security model

- **Encrypted:** note content, file paths and WebRTC signalling. The vault key never leaves your devices.
- **Visible to the relay:** room hash, device public keys and IPs, connection times, bundle sizes and times, and the labels and settings you enter in the dashboard.
- **The vault key is the access key.** Treat the setup code, QR code and link like a password. Revoking a device does not revoke the key, so if a device is lost, generate a new vault key and pair every device again.
- Mailbox bundles stay in R2 until every device has fetched them or they expire (default 30 days). Only the SHA-256 hash of the admin token is stored.

## Network use disclosure

After sync is configured, the plugin connects only to:

1. Your relay (your own Cloudflare Worker): signalling, mailbox, UI languages, connection test.
2. Your other devices, directly over WebRTC.
3. Cloudflare STUN (`stun.cloudflare.com`), to find a direct route.
4. Cloudflare TURN, only if you enable it in the dashboard.

There is no telemetry or analytics. The plugin needs no account or payment; the relay needs your own Cloudflare account.

## Local development

Run `npm install` in `relay/`, `relay/web/` and `plugin/` (Node.js 22.12 or newer).

```sh
# relay
cd relay
printf 'DB_ENC_KEY=%s\nADMIN_TOKEN_HASH=%s\n' "$(openssl rand -base64 32)" "$(printf 'dev-token' | shasum -a 256 | cut -d' ' -f1)" > .dev.vars
npm run db:migrate:local
npm run dev            # http://localhost:8787, sign in with "dev-token"
npm test && npm run typecheck

# dashboard
cd relay/web && npm run build   # writes ../public

# plugin
cd plugin
npm run build          # produces main.js
npm test && npm run e2e
```

**Release:** update the version in `manifest.json`, `versions.json` and `plugin/package.json`, then push a matching tag (for example `0.2.1`, no `v`). GitHub Actions publishes it.

## Known limitations

- iOS cannot sync in the background. `RTCPeerConnection` support is not yet confirmed on a real device; without it, that device syncs through the mailbox only.
- Not supported: a `.git` repository, headless devices, selective sync, live multi-user collaboration, multiple admins, automatic vault key rotation.

## License

GPL-3.0-only ([LICENSE](LICENSE)). The dashboard is based on [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) (MIT); see `relay/web/NOTICE.md`.
