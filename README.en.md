# Peer Vault Sync

[日本語](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | **English**

Sync a whole Obsidian vault between your own devices: notes, attachments, and the `.obsidian` folder (themes, plugins, settings, workspace). Devices talk to each other directly over WebRTC when they are online together. A small relay that you run on Cloudflare Workers handles signalling, holds end-to-end encrypted "mailbox" bundles for devices that are offline, and has an admin dashboard.

```
  Obsidian plugin (device A) <======= WebRTC data channel =======> Obsidian plugin (device B)
        |   \                                                         /   |
        |    \__ HTTPS / WebSocket (signalling, mailbox) __ relay ___/    |
        |                         Cloudflare Worker                        |
        |              D1 (peers, settings)   R2 (encrypted mailbox)       |
        +--------------- STUN/TURN: Cloudflare Realtime (optional) --------+
```

- `plugin/`: the Obsidian plugin (`peer-vault-sync`).
- `relay/`: the Worker (Durable Object rooms, D1, R2), the admin dashboard in `relay/web/`, and the UI strings in `relay/locales/`.
- `docs/protocol.md`: the contract between the plugin and the relay.

## Features

- 1:1 sync of the whole vault, including hidden folders such as `.obsidian`, on desktop and mobile.
- End-to-end encryption. The relay never sees note content, file paths or keys.
- Works when devices are never online at the same time, through the encrypted mailbox.
- Per-file history: view versions, compare them with the current file, restore any version, and restore deleted files.
- Ignore rules in gitignore format (`.syncignore`).
- A self-hosted relay with a dashboard to approve, revoke and label devices, change settings, read the audit log and add UI languages.
- UI in English and Traditional Chinese; more languages can be added from the dashboard.

## How it works

1. **Changes become revisions.** The plugin watches the vault and scans hidden folders. Each change is recorded as a revision (path, SHA-256 of the content, device, sequence number, parents) in IndexedDB on the device. The content is stored once per hash.
2. **Devices exchange what the other is missing.** When two devices are online, they open a WebRTC data channel and compare version vectors. Each side sends only the revisions and content the other lacks.
3. **Concurrent edits are merged.** If both sides changed the same Markdown file, the plugin runs a three-way merge. If the edits overlap, or the file is not text, the newest version wins. The other version stays in history, so nothing is lost.
4. **Offline devices get mail.** If a known device is offline, the plugin encrypts the missing revisions and content into a bundle and uploads it to the relay. The device downloads and applies it the next time it opens. The relay deletes a bundle once every device has acknowledged it, or after 30 days.
5. **The relay only connects devices.** It forwards encrypted signalling messages, stores encrypted bundles until they are delivered, and keeps the device list and audit log in D1. Sensitive columns are encrypted with a key that only the Worker holds.

## Install the plugin

- **From Community plugins** (after the plugin is listed): Settings > Community plugins > Browse, search for "Peer Vault Sync", then install and enable it.
- **Manually:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/eliaya/obsidian-p2p-sync/releases/latest), put them in `<vault>/.obsidian/plugins/peer-vault-sync/`, then enable "Peer Vault Sync" under Settings > Community plugins.

Requires Obsidian 1.8.7 or newer. Back up your vault before you sync it for the first time.

## Deploy the relay

Each person or team needs their own relay. Choose one of the two methods.

### Option A: one-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eliaya/obsidian-p2p-sync/tree/main/relay)

1. **Generate the two secrets** on your computer (Node.js is needed only for this step):
   ```sh
   node -e "const c=require('crypto'),t=c.randomBytes(32).toString('base64url');console.log('admin token:',t);console.log('ADMIN_TOKEN_HASH:',c.createHash('sha256').update(t).digest('hex'));console.log('DB_ENC_KEY:',c.randomBytes(32).toString('base64'))"
   ```
   Save the **admin token** and **`DB_ENC_KEY`** in a password manager. You sign in to the dashboard with the admin token. If `DB_ENC_KEY` is lost, the encrypted database columns can never be read again.
2. **Click the button** and sign in to Cloudflare. Connect your GitHub or GitLab account when asked. Cloudflare copies the `relay/` folder into a new repository in your account.
3. **Review the names.** You can keep or change the Worker name, the D1 database name and the R2 bucket name.
4. **Enter the secrets.** Paste `DB_ENC_KEY` and `ADMIN_TOKEN_HASH` from step 1. Do not paste the admin token itself.
5. **Deploy.** Cloudflare creates the D1 database, the R2 bucket and the Durable Object, then builds and deploys:
   - Build command `npm run build`: installs and builds the dashboard into `public/`.
   - Deploy command `npm run deploy`: applies the D1 migrations to the new database, then runs `wrangler deploy`.
6. **Open the Worker URL** (`https://<worker-name>.<your-subdomain>.workers.dev`) and sign in with the admin token.

Later pushes to the new repository redeploy the Worker automatically (Workers Builds).

Differences from Option B: the button does not create the R2 lifecycle rule. That rule is only a backstop: the daily cron job already deletes expired bundles. To add it anyway, run `npx wrangler r2 bucket lifecycle add <bucket> expire-mailbox-45d --expire-days 45` once.

If the build log shows a permission error during the D1 migration step, give the Workers Builds API token the "D1 Edit" permission (Worker > Settings > Build), or run `npx wrangler d1 migrations apply DB --remote` once from your computer, then retry the build.

### Option B: deploy from your computer

Needs Node.js 22.12 or newer and a clone of this repository.

1. **Create an API token.** Cloudflare dashboard > My Profile > API Tokens > Create Token > Custom token. Add these permissions, and limit the token to your account:
   - Account > Workers Scripts > Edit
   - Account > D1 > Edit
   - Account > Workers R2 Storage > Edit
2. **Fill `relay/.env`.** Run `cp relay/.env.example relay/.env`, then set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The file is git-ignored. Never commit it or paste it anywhere.
3. **One-time setup** (safe to repeat):
   ```sh
   cd relay
   npm install
   npm run setup -- --dry-run   # lists what it would do, changes nothing
   npm run setup                # asks for confirmation; --yes skips it
   ```
   It creates the D1 database and the R2 bucket (or reuses them), writes the D1 id into `wrangler.jsonc`, adds the 45-day R2 lifecycle rule, and sets the Worker secrets `DB_ENC_KEY` (never overwritten if it exists) and `ADMIN_TOKEN_HASH`. **It prints the admin token once: save it in a password manager.** `--rotate-admin-token` replaces it.
4. **Deploy:**
   ```sh
   npm run deploy:local              # build, typecheck, test, migrate, deploy, check /health
   npm run deploy:local -- --dry-run # everything except the migrations and the real deploy
   ```
   If the Worker URL cannot be read from the output, add `--url https://<your-worker>.workers.dev`.

## First use

1. **Sign in to the dashboard** at the Worker URL with the admin token. Under Settings you can add TURN credentials (a Cloudflare Realtime TURN key id and API token) to connect through strict networks. TURN is optional.
2. **Set up the first device.** In the plugin settings, enter the relay URL and select "Test connection". Then, under "This is the first device", select "Create vault key".
3. **Approve it.** New devices appear as `pending` in the dashboard. Set the device to `active`.
4. **Add other devices.** On the first device, select "Show setup code". On the other device, install the plugin, paste the code under "Join an existing vault" (or open the setup link or scan the QR code), then approve the new device in the dashboard.

Commands (command palette): Sync now, Show sync status, View file history, Restore a deleted file. You can also right-click a file and choose "View file history".

## Settings worth knowing

- **Ignore rules.** Put gitignore-style patterns in `.syncignore` at the vault root, or edit them under Settings > Peer Vault Sync > Ignore rules. The file itself always syncs, so every device uses the same rules. `.git/` is always ignored.
  ```
  .DS_Store
  .trash/
  *.tmp
  ```
  - A file that starts matching a rule stops syncing. Nothing is deleted: copies already on other devices stay where they are.
  - Changes that other devices made to an ignored file are kept in history but not written to disk. If you remove the rule later, they are written at the next sync. A local copy that differs is merged with them by the usual conflict rules.
  - As in git, a file inside an ignored folder cannot be re-included with `!`.
- **Notices.** Show, hide automatically after N seconds, or do not show. This setting applies only to this device and only to this plugin's notices. Sync errors are always recorded in the status view.
- **Keep history for (days).** Old version content is deleted after this many days (default 90). The current version of every file is always kept.

## Security model

- **What is end-to-end encrypted.** Everything derived from the vault key stays on the devices: note content and file paths in mailbox bundles, and the WebRTC signalling messages (SDP/ICE). The relay never receives the vault key or any key derived from it.
- **What the relay can see.** Which room (a hash derived from the vault key) a device joins, each device's public key and IP address as seen by Cloudflare, when it connects, the size and time of mailbox bundles, and the device labels and settings you enter in the dashboard. It cannot read note content or paths.
- **Ciphertext is stored.** Mailbox bundles are kept in R2 as ciphertext until every device has fetched them or they expire (default 30 days, set in the dashboard).
- **The vault key is the access key.** Anyone who has it can decrypt bundles and join as a device. Share it only through the setup code, QR code or setup link, and treat these like a password.
- **Revoking a device does not revoke the key.** A device set to `revoked` can no longer use the relay, but it still holds the vault key. If a device is lost, generate a new vault key and pair every device again.
- **Losing `DB_ENC_KEY` cannot be undone.** The encrypted database columns can never be read again, and the relay must be reset. Vault data on your devices is not affected.
- **Admin token.** The Worker stores only its SHA-256 hash.

## Network use disclosure

The plugin makes network connections only after sync is configured, and only to:

1. **The relay server you configure** (your own Cloudflare Worker): HTTPS requests and a WebSocket for signalling, mailbox upload and download, UI languages and the connection test.
2. **Your other devices**, directly over WebRTC.
3. **Cloudflare STUN** (`stun.cloudflare.com`), to find a direct route between devices.
4. **Cloudflare TURN**, only if you enable TURN in the dashboard, to relay encrypted traffic through strict networks. The servers and credentials come from your relay.

There is no telemetry, analytics or other third-party request. Nothing is sent before you enter a relay URL and a vault key. No account or payment is needed to use the plugin; you need your own Cloudflare account for the relay.

## Local development

Install the dependencies once in each package (`npm install` in `relay/`, `relay/web/` and `plugin/`). Node.js 22.12 or newer.

**relay**
```sh
cd relay
printf 'DB_ENC_KEY=%s\nADMIN_TOKEN_HASH=%s\n' "$(openssl rand -base64 32)" "$(printf 'dev-token' | shasum -a 256 | cut -d' ' -f1)" > .dev.vars   # git-ignored
npm run db:migrate:local
npm run dev            # http://localhost:8787, sign in to the dashboard with "dev-token"
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
mkdir -p "<vault>/.obsidian/plugins/peer-vault-sync"
cp main.js ../manifest.json styles.css "<vault>/.obsidian/plugins/peer-vault-sync/"
npm test               # unit tests
npm run e2e            # end-to-end tests in headless Chromium against a local relay
```

**Release:** update the version in `manifest.json`, `versions.json` and `plugin/package.json`, commit, then push a tag that equals the version (for example `0.2.1`, without `v`). GitHub Actions tests, builds and publishes the release.

## Known limitations

- iOS cannot sync in the background. Devices sync while Obsidian is in the foreground; the mailbox means the other device need not be online at the same time.
- Support for `RTCPeerConnection` in Obsidian on iOS is not yet confirmed on a real device. Without it, that device would sync through the mailbox only.
- When you first combine two existing vaults, a file with the same path, different content and no common history is resolved by the conflict rules. The older content goes to history.
- History uses local storage; the retention setting controls how much.
- Not supported: a real `.git` repository, a headless always-on device, per-device selective sync, live multi-user collaboration, multiple admins, automatic vault key rotation.

## License

GPL-3.0-only. See [LICENSE](LICENSE).

The dashboard is based on [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) (MIT); see `relay/web/NOTICE.md`.
