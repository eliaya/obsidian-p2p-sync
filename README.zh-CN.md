# Peer Vault Sync

[日本語](README.md) | [繁體中文](README.zh-TW.md) | **简体中文** | [English](README.en.md)

在您自己的多台设备之间同步整个 Obsidian 笔记库（vault）：笔记、附件以及 `.obsidian` 文件夹（主题、插件、设置、工作区）。设备同时在线时，通过 WebRTC 直接互相通信。您在 Cloudflare Workers 上运行的小型中继服务（relay）负责信令交换，为离线设备保存端到端加密的“邮箱”（mailbox）数据包，并提供管理面板。

```
  Obsidian plugin (device A) <======= WebRTC data channel =======> Obsidian plugin (device B)
        |   \                                                         /   |
        |    \__ HTTPS / WebSocket (signalling, mailbox) __ relay ___/    |
        |                         Cloudflare Worker                        |
        |              D1 (peers, settings)   R2 (encrypted mailbox)       |
        +--------------- STUN/TURN: Cloudflare Realtime (optional) --------+
```

- `plugin/`：Obsidian 插件（`peer-vault-sync`）。
- `relay/`：Worker（Durable Object 房间、D1、R2）、位于 `relay/web/` 的管理面板，以及位于 `relay/locales/` 的界面文本。
- `docs/protocol.md`：插件与中继服务之间的约定。

## 功能

- 在桌面端和移动端对整个笔记库进行 1:1 同步，包括 `.obsidian` 等隐藏文件夹。
- 端到端加密。中继服务不会接触笔记内容、文件路径或密钥。
- 即使设备从不同时在线，也能通过加密邮箱完成同步。
- 单个文件的历史记录：查看各版本，与当前文件比较，恢复任意版本，并恢复已删除的文件。
- 使用 gitignore 格式的忽略规则（`.syncignore`）。
- 自托管的中继服务，其管理面板可用于批准、撤销和标记设备，更改设置，查看审计日志，以及添加界面语言。
- 界面提供英文和繁体中文；可通过管理面板添加更多语言。

## 工作原理

1. **更改会成为修订。** 插件监视笔记库并扫描隐藏文件夹。每次更改都会作为一条修订（路径、内容的 SHA-256、设备、序列号、父修订）记录在设备上的 IndexedDB 中。相同哈希的内容只存储一份。
2. **设备交换对方缺少的内容。** 两台设备同时在线时，会打开 WebRTC 数据通道并比较版本向量。双方只发送对方缺少的修订和内容。
3. **并发编辑会被合并。** 如果双方都修改了同一个 Markdown 文件，插件会执行三方合并。如果编辑内容有重叠，或者文件不是文本，则以最新版本为准。另一个版本仍保留在历史记录中，因此不会丢失任何内容。
4. **离线设备会收到“邮件”。** 如果某台已知设备处于离线状态，插件会将缺少的修订和内容加密打包，并上传到中继服务。该设备下次打开时会下载并应用这个数据包。当所有设备都确认收到某个数据包后，或者 30 天后，中继服务会删除该数据包。
5. **中继服务只负责连接设备。** 它转发加密的信令消息，在数据包送达之前存储加密的数据包，并在 D1 中保存设备列表和审计日志。敏感列使用只有 Worker 持有的密钥进行加密。

## 安装插件

- **通过 Community plugins（第三方插件）**（插件上架之后）：Settings > Community plugins > Browse，搜索 "Peer Vault Sync"，然后安装并启用。
- **手动安装：** 从[最新发布版本](https://github.com/eliaya/obsidian-p2p-sync/releases/latest)下载 `main.js`、`manifest.json` 和 `styles.css`，放入 `<vault>/.obsidian/plugins/peer-vault-sync/`，然后在 Settings > Community plugins 下启用 "Peer Vault Sync"。

需要 Obsidian 1.8.7 或更高版本。首次同步之前，请先备份您的笔记库。

## 部署中继服务

每个人或每个团队都需要自己的中继服务。请在以下两种方式中任选其一。

### 方式 A：一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eliaya/obsidian-p2p-sync/tree/main/relay)

1. **在您的计算机上生成两个密钥**（仅此步骤需要 Node.js）：
   ```sh
   node -e "const c=require('crypto'),t=c.randomBytes(32).toString('base64url');console.log('admin token:',t);console.log('ADMIN_TOKEN_HASH:',c.createHash('sha256').update(t).digest('hex'));console.log('DB_ENC_KEY:',c.randomBytes(32).toString('base64'))"
   ```
   请将 **admin token** 和 **`DB_ENC_KEY`** 保存到密码管理器中。您使用 admin token 登录管理面板。如果 `DB_ENC_KEY` 丢失，加密的数据库列将永远无法再被读取。
2. **点击按钮**并登录 Cloudflare。出现提示时，请连接您的 GitHub 或 GitLab 账号。Cloudflare 会把 `relay/` 文件夹复制到您账号下的一个新仓库中。
3. **检查名称。** 您可以保留或更改 Worker 名称、D1 数据库名称和 R2 存储桶名称。
4. **输入密钥。** 粘贴第 1 步中的 `DB_ENC_KEY` 和 `ADMIN_TOKEN_HASH`。不要粘贴 admin token 本身。
5. **部署。** Cloudflare 会创建 D1 数据库、R2 存储桶和 Durable Object，然后构建并部署：
   - 构建命令 `npm run build`：安装依赖并将管理面板构建到 `public/` 中。
   - 部署命令 `npm run deploy`：先对新数据库应用 D1 迁移，再运行 `wrangler deploy`。
6. **打开 Worker 网址**（`https://<worker-name>.<your-subdomain>.workers.dev`），并使用 admin token 登录。

之后向新仓库推送的提交会自动重新部署 Worker（Workers Builds）。

与方式 B 的差异：该按钮不会创建 R2 生命周期规则。这条规则只是一道兜底措施：每天的 cron 任务已经会删除过期的数据包。如果仍想添加，请运行一次 `npx wrangler r2 bucket lifecycle add <bucket> expire-mailbox-45d --expire-days 45`。

如果构建日志在 D1 迁移步骤中显示权限错误，请为 Workers Builds 的 API 令牌授予 "D1 Edit" 权限（Worker > Settings > Build），或者在您的计算机上运行一次 `npx wrangler d1 migrations apply DB --remote`，然后重试构建。

### 方式 B：从您的计算机部署

需要 Node.js 22.12 或更高版本，以及本仓库的克隆。

1. **创建 API 令牌。** Cloudflare dashboard > My Profile > API Tokens > Create Token > Custom token。添加以下权限，并将该令牌限定在您的账号范围内：
   - Account > Workers Scripts > Edit
   - Account > D1 > Edit
   - Account > Workers R2 Storage > Edit
2. **填写 `relay/.env`。** 运行 `cp relay/.env.example relay/.env`，然后设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。该文件已被 git 忽略。切勿提交它，也不要将其粘贴到任何地方。
3. **一次性设置**（可安全地重复运行）：
   ```sh
   cd relay
   npm install
   npm run setup -- --dry-run   # lists what it would do, changes nothing
   npm run setup                # asks for confirmation; --yes skips it
   ```
   它会创建 D1 数据库和 R2 存储桶（或复用已有的），将 D1 的 id 写入 `wrangler.jsonc`，添加 45 天的 R2 生命周期规则，并设置 Worker 密钥 `DB_ENC_KEY`（若已存在则绝不覆盖）和 `ADMIN_TOKEN_HASH`。**它只会输出一次 admin token：请将其保存到密码管理器中。** `--rotate-admin-token` 会替换它。
4. **部署：**
   ```sh
   npm run deploy:local              # build, typecheck, test, migrate, deploy, check /health
   npm run deploy:local -- --dry-run # everything except the migrations and the real deploy
   ```
   如果无法从输出中读取 Worker 网址，请添加 `--url https://<your-worker>.workers.dev`。

## 首次使用

1. **登录管理面板**：在 Worker 网址使用 admin token 登录。在 Settings 下，您可以添加 TURN 凭据（Cloudflare Realtime TURN 的密钥 id 和 API 令牌），以便通过严格限制的网络进行连接。TURN 是可选的。
2. **设置第一台设备。** 在插件设置中输入中继服务网址，然后选择 "Test connection"（测试连接）。接着在 "This is the first device" 下选择 "Create vault key"（创建笔记库密钥）。
3. **批准设备。** 新设备在管理面板中显示为 `pending`。将该设备设置为 `active`。
4. **添加其他设备。** 在第一台设备上选择 "Show setup code"（显示设置码）。在另一台设备上安装插件，将该设置码粘贴到 "Join an existing vault" 下（或者打开设置链接，或扫描二维码），然后在管理面板中批准这台新设备。

命令（命令面板）：Sync now、Show sync status、View file history、Restore a deleted file。您也可以右键单击文件并选择 "View file history"（查看文件历史记录）。

## 值得了解的设置

- **忽略规则。** 将 gitignore 风格的模式写入笔记库根目录下的 `.syncignore`，或在 Settings > Peer Vault Sync > Ignore rules 下编辑。该文件本身始终会同步，因此所有设备使用相同的规则。`.git/` 始终被忽略。
  ```
  .DS_Store
  .trash/
  *.tmp
  ```
  - 一个文件开始匹配某条规则后，将不再同步。不会删除任何内容：其他设备上已有的副本保持原样。
  - 其他设备对已忽略文件所做的更改会保留在历史记录中，但不会写入磁盘。如果您之后移除该规则，这些更改会在下一次同步时写入。内容不同的本地副本会按常规冲突规则与它们合并。
  - 与 git 相同，位于被忽略文件夹内的文件无法用 `!` 重新纳入。
- **通知。** 可选择显示、在 N 秒后自动隐藏，或不显示。此设置仅适用于本设备，且仅适用于本插件的通知。同步错误始终会记录在状态视图中。
- **Keep history for (days)。** 旧版本的内容会在这个天数之后被删除（默认 90 天）。每个文件的当前版本始终会保留。

## 安全模型

- **哪些内容经过端到端加密。** 所有由笔记库密钥派生的内容都只保留在设备上：邮箱数据包中的笔记内容和文件路径，以及 WebRTC 信令消息（SDP/ICE）。中继服务永远不会收到笔记库密钥或任何由它派生的密钥。
- **中继服务能看到什么。** 设备加入了哪个房间（由笔记库密钥派生的哈希）、Cloudflare 所见的各设备公钥和 IP 地址、设备连接的时间、邮箱数据包的大小和时间，以及您在管理面板中输入的设备标签和设置。它无法读取笔记内容或路径。
- **存储的是密文。** 邮箱数据包以密文形式保存在 R2 中，直到所有设备都已获取，或者数据包过期（默认 30 天，可在管理面板中设置）。
- **笔记库密钥就是访问密钥。** 任何持有它的人都可以解密数据包并以设备身份加入。只能通过设置码、二维码或设置链接共享它，并像对待密码一样对待这些内容。
- **撤销设备并不会撤销密钥。** 被设置为 `revoked` 的设备不能再使用中继服务，但它仍然持有笔记库密钥。如果设备丢失，请生成新的笔记库密钥并重新配对所有设备。
- **丢失 `DB_ENC_KEY` 无法挽回。** 加密的数据库列将永远无法再被读取，并且必须重置中继服务。您设备上的笔记库数据不受影响。
- **Admin token。** Worker 只存储其 SHA-256 哈希。

## 网络使用声明

插件只会在同步配置完成之后建立网络连接，并且只连接到：

1. **您配置的中继服务器**（您自己的 Cloudflare Worker）：用于信令的 HTTPS 请求和 WebSocket、邮箱上传和下载、界面语言以及连接测试。
2. **您的其他设备**，通过 WebRTC 直接连接。
3. **Cloudflare STUN**（`stun.cloudflare.com`），用于寻找设备之间的直连路径。
4. **Cloudflare TURN**，仅在您于管理面板中启用 TURN 时使用，用于通过严格限制的网络中转加密流量。服务器和凭据来自您的中继服务。

没有遥测、分析或其他第三方请求。在您输入中继服务网址和笔记库密钥之前，不会发送任何内容。使用本插件无需账号或付费；中继服务需要您自己的 Cloudflare 账号。

## 本地开发

在每个包中各安装一次依赖（在 `relay/`、`relay/web/` 和 `plugin/` 中运行 `npm install`）。需要 Node.js 22.12 或更高版本。

**relay**
```sh
cd relay
printf 'DB_ENC_KEY=%s\nADMIN_TOKEN_HASH=%s\n' "$(openssl rand -base64 32)" "$(printf 'dev-token' | shasum -a 256 | cut -d' ' -f1)" > .dev.vars   # git-ignored
npm run db:migrate:local
npm run dev            # http://localhost:8787, sign in to the dashboard with "dev-token"
npm test && npm run typecheck
```

**relay/web**（管理面板）
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

**发布：** 更新 `manifest.json`、`versions.json` 和 `plugin/package.json` 中的版本号，提交，然后推送一个与版本号相同的标签（例如 `0.2.1`，不带 `v`）。GitHub Actions 会测试、构建并发布该版本。

## 已知限制

- iOS 无法在后台同步。设备在 Obsidian 处于前台时进行同步；有了邮箱，另一台设备无需同时在线。
- Obsidian 在 iOS 上对 `RTCPeerConnection` 的支持尚未在真机上得到确认。若不支持，该设备将只能通过邮箱同步。
- 首次合并两个已有的笔记库时，路径相同、内容不同且没有共同历史的文件，将按冲突规则处理。较旧的内容会进入历史记录。
- 历史记录使用本地存储；保留设置决定其占用多少。
- 不支持：真正的 `.git` 仓库、无界面的常开设备、按设备选择性同步、多用户实时协作、多个管理员、笔记库密钥的自动轮换。

## 许可证

GPL-3.0-only。参见 [LICENSE](LICENSE)。

管理面板基于 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)（MIT）；参见 `relay/web/NOTICE.md`。
