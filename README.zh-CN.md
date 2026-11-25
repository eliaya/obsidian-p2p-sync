# Peer Vault Sync

[日本語](README.md) | [繁體中文](README.zh-TW.md) | **简体中文** | [English](README.en.md)

在您自己的多台设备之间同步整个 Obsidian 笔记库（vault）：笔记、附件以及 `.obsidian` 文件夹（主题、插件、设置）。设备同时在线时通过 WebRTC 直接通信；否则通过您自托管在 Cloudflare Workers 上的中继服务，以端到端加密的“邮箱”数据包交接。

- `plugin/`：Obsidian 插件（`peer-vault-sync`）。
- `relay/`：Worker（Durable Object、D1、R2）、管理面板（`relay/web/`）和界面文本（`relay/locales/`）。

## 功能

- 在桌面端和移动端同步整个笔记库，包括隐藏文件夹。
- 端到端加密。中继服务不会接触笔记内容、文件路径或密钥。
- Markdown 的并发编辑会进行三方合并。内容重叠的编辑和非文本文件以最新版本为准，另一个版本保留在历史记录中。
- 单个文件的历史记录（比较、恢复、恢复已删除的文件）。
- 使用 gitignore 格式的忽略规则（`.syncignore`）。
- 管理面板可批准和撤销设备、更改设置、查看审计日志以及添加界面语言。

## 安装插件

- **通过 Community plugins（第三方插件）**（上架之后）：Settings > Community plugins > Browse，搜索 "Peer Vault Sync"。
- **手动安装：** 将[最新发布版本](https://github.com/eliaya/obsidian-p2p-sync/releases/latest)中的 `main.js`、`manifest.json` 和 `styles.css` 放入 `<vault>/.obsidian/plugins/peer-vault-sync/`，然后启用插件。

需要 Obsidian 1.8.7 或更高版本。首次同步之前，请先备份您的笔记库。

## 部署中继服务

### 方式 A：一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eliaya/obsidian-p2p-sync/tree/main/relay)

1. 生成密钥（需要 Node.js）：
   ```sh
   node -e "const c=require('crypto'),t=c.randomBytes(32).toString('base64url');console.log('admin token:',t);console.log('ADMIN_TOKEN_HASH:',c.createHash('sha256').update(t).digest('hex'));console.log('DB_ENC_KEY:',c.randomBytes(32).toString('base64'))"
   ```
   请将 **admin token** 和 **`DB_ENC_KEY`** 保存到密码管理器中。如果 `DB_ENC_KEY` 丢失，加密的数据库列将永远无法再被读取。
2. 点击按钮，登录 Cloudflare 并连接 GitHub/GitLab。
3. 粘贴 `DB_ENC_KEY` 和 `ADMIN_TOKEN_HASH`（不是 admin token 本身）后部署。
4. 打开 Worker 网址，使用 admin token 登录。

之后向新仓库推送会自动重新部署。如果构建日志在 D1 迁移步骤中显示权限错误，请为 Workers Builds 的 API 令牌授予 "D1 Edit" 权限，或者先运行一次 `npx wrangler d1 migrations apply DB --remote` 再重试。

### 方式 B：从您的计算机部署

需要 Node.js 22.12 或更高版本，以及本仓库的克隆。

1. 创建 Cloudflare API 令牌，授予 Workers Scripts、D1、Workers R2 Storage 的 Edit 权限。
2. 运行 `cp relay/.env.example relay/.env`，设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`（已被 git 忽略）。
3. 设置并部署：
   ```sh
   cd relay
   npm install
   npm run setup          # 创建 D1、R2 和密钥；--dry-run 只列出内容
   npm run deploy:local   # build, typecheck, test, migrate, deploy, check /health
   ```
   **admin token 只会输出一次。** 要替换请运行 `npm run setup -- --rotate-admin-token`。

## 首次使用

1. 登录管理面板。在 Settings 下可添加 TURN 凭据（Cloudflare Realtime），以便通过严格限制的网络进行连接（可选）。
2. 在第一台设备的插件设置中输入中继服务网址，选择 "Create vault key"（创建笔记库密钥）。
3. 在管理面板中将 `pending` 的设备设置为 `active`。
4. 在第一台设备上选择 "Show setup code"（显示设置码），粘贴到另一台设备的 "Join an existing vault" 下（或使用链接、二维码），然后在管理面板中批准。

命令：Sync now、Show sync status、View file history、Restore a deleted file。

## 安全模型

- **加密的内容：** 笔记内容、文件路径和 WebRTC 信令。笔记库密钥不会离开您的设备。
- **中继服务能看到：** 房间哈希、设备公钥和 IP、连接时间、数据包的大小和时间，以及您在管理面板中输入的标签和设置。
- **笔记库密钥就是访问密钥。** 请将设置码、二维码和链接视同密码。撤销设备并不会撤销密钥，设备丢失时请生成新的笔记库密钥并重新配对所有设备。
- 邮箱数据包保存在 R2 中，直到所有设备都已获取或过期（默认 30 天）。Admin token 只存储 SHA-256 哈希。

## 网络使用声明

同步配置完成之后，插件只会连接到：

1. 您的中继服务（您自己的 Cloudflare Worker）：信令、邮箱、界面语言、连接测试。
2. 您的其他设备，通过 WebRTC 直接连接。
3. Cloudflare STUN（`stun.cloudflare.com`），用于寻找直连路径。
4. Cloudflare TURN，仅在您于管理面板中启用时使用。

没有遥测或分析。使用本插件无需账号或付费；中继服务需要您自己的 Cloudflare 账号。

## 本地开发

在 `relay/`、`relay/web/` 和 `plugin/` 中各运行 `npm install`（Node.js 22.12 或更高版本）。

```sh
# relay
cd relay
printf 'DB_ENC_KEY=%s\nADMIN_TOKEN_HASH=%s\n' "$(openssl rand -base64 32)" "$(printf 'dev-token' | shasum -a 256 | cut -d' ' -f1)" > .dev.vars
npm run db:migrate:local
npm run dev            # http://localhost:8787，使用 "dev-token" 登录
npm test && npm run typecheck

# 管理面板
cd relay/web && npm run build   # 输出到 ../public

# plugin
cd plugin
npm run build          # 生成 main.js
npm test && npm run e2e
```

**发布：** 更新 `manifest.json`、`versions.json` 和 `plugin/package.json` 中的版本号，推送相同的标签（例如 `0.2.1`，不带 `v`），GitHub Actions 会发布。

## 已知限制

- iOS 无法在后台同步。iOS 上对 `RTCPeerConnection` 的支持尚未在真机上确认，若不支持，该设备只能通过邮箱同步。
- 不支持：`.git` 仓库、无界面的常开设备、选择性同步、多用户实时协作、多个管理员、笔记库密钥的自动轮换。

## 许可证

GPL-3.0-only（[LICENSE](LICENSE)）。管理面板基于 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)（MIT）；参见 `relay/web/NOTICE.md`。
