# Peer Vault Sync

[日本語](README.md) | **繁體中文** | [简体中文](README.zh-CN.md) | [English](README.en.md)

在你自己的裝置之間同步整個 Obsidian Vault：筆記、附件，以及 `.obsidian` 資料夾（主題、外掛、設定）。裝置同時在線時透過 WebRTC 直接連線；否則透過你自行架設在 Cloudflare Workers 上的中繼伺服器，以端對端加密的「信箱」資料包交接。

- `plugin/`：Obsidian 外掛（`peer-vault-sync`）。
- `relay/`：Worker（Durable Object、D1、R2）、管理介面（`relay/web/`）與介面字串（`relay/locales/`）。

## 功能

- 在桌面與行動裝置上同步整個 Vault，包括隱藏資料夾。
- 端對端加密。中繼伺服器看不到筆記內容、檔案路徑或金鑰。
- Markdown 的同時編輯會進行三方合併。內容重疊的編輯與非文字檔以最新版本為準，另一版本保留在歷史中。
- 逐檔案的歷史（比較、還原、還原已刪除的檔案）。
- gitignore 格式的忽略規則（`.syncignore`）。
- 管理介面可核准與停用裝置、變更設定、查看稽核記錄，以及新增介面語言。

## 安裝外掛

- **從社群外掛安裝**（上架之後）：設定 > 社群外掛程式 > 瀏覽，搜尋「Peer Vault Sync」。
- **手動安裝：** 將[最新版本](https://github.com/eliaya/obsidian-p2p-sync/releases/latest)的 `main.js`、`manifest.json` 與 `styles.css` 放進 `<vault>/.obsidian/plugins/peer-vault-sync/`，再啟用外掛。

需要 Obsidian 1.8.7 或更新版本。首次同步之前，請先備份 Vault。

## 部署中繼伺服器

### 方式 A：一鍵部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eliaya/obsidian-p2p-sync/tree/main/relay)

1. 產生密鑰（需要 Node.js）：
   ```sh
   node -e "const c=require('crypto'),t=c.randomBytes(32).toString('base64url');console.log('admin token:',t);console.log('ADMIN_TOKEN_HASH:',c.createHash('sha256').update(t).digest('hex'));console.log('DB_ENC_KEY:',c.randomBytes(32).toString('base64'))"
   ```
   請將**管理員權杖（admin token）**與 **`DB_ENC_KEY`** 存放在密碼管理工具中。若遺失 `DB_ENC_KEY`，加密的資料庫欄位將永遠無法再讀取。
2. 點選按鈕，登入 Cloudflare 並連結 GitHub/GitLab。
3. 貼上 `DB_ENC_KEY` 與 `ADMIN_TOKEN_HASH`（不是管理員權杖本身）後部署。
4. 開啟 Worker 網址，以管理員權杖登入。

之後推送到新儲存庫會自動重新部署。若建置記錄在 D1 遷移步驟顯示權限錯誤，請授予 Workers Builds API 權杖「D1 Edit」權限，或先執行一次 `npx wrangler d1 migrations apply DB --remote` 再重試。

### 方式 B：從你的電腦部署

需要 Node.js 22.12 或更新版本，以及本儲存庫的複本。

1. 建立 Cloudflare API 權杖，授予 Workers Scripts、D1、Workers R2 Storage 的 Edit 權限。
2. 執行 `cp relay/.env.example relay/.env`，設定 `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`（已被 git 忽略）。
3. 設定並部署：
   ```sh
   cd relay
   npm install
   npm run setup          # 建立 D1、R2 與密鑰；--dry-run 只列出內容
   npm run deploy:local   # build, typecheck, test, migrate, deploy, check /health
   ```
   **管理員權杖只會顯示一次。** 要替換請執行 `npm run setup -- --rotate-admin-token`。

## 初次使用

1. 登入管理介面。在「設定」中可加入 TURN 憑證（Cloudflare Realtime），以便在嚴格的網路環境中連線（選用）。
2. 在第一台裝置的外掛設定中輸入中繼伺服器網址，選擇「產生 Vault 金鑰」。
3. 在管理介面將 `pending` 的裝置設為 `active`。
4. 在第一台裝置選擇「顯示設定碼」，貼到另一台裝置的「加入既有的 Vault」（或使用連結、QR 碼），再到管理介面核准。

指令：立即同步、顯示同步狀態、檢視檔案歷史、還原已刪除的檔案。

## 安全模型

- **加密的內容：** 筆記內容、檔案路徑與 WebRTC 訊號交換。Vault 金鑰不會離開你的裝置。
- **中繼伺服器看得到：** 房間雜湊值、裝置公開金鑰與 IP、連線時間、資料包的大小與時間，以及你在管理介面輸入的名稱與設定。
- **Vault 金鑰就是存取金鑰。** 請將設定碼、QR 碼與連結視同密碼。停用裝置不會撤銷金鑰，裝置遺失時請產生新的 Vault 金鑰並重新配對所有裝置。
- 信箱資料包會保存在 R2，直到所有裝置都取回或過期（預設 30 天）。管理員權杖只儲存 SHA-256 雜湊值。

## 網路使用聲明

設定好同步之後，外掛只會連線至：

1. 你的中繼伺服器（你自己的 Cloudflare Worker）：訊號交換、信箱、介面語言、連線測試。
2. 你的其他裝置，直接透過 WebRTC 連線。
3. Cloudflare STUN（`stun.cloudflare.com`），用來尋找直接路徑。
4. Cloudflare TURN，僅在你於管理介面啟用時使用。

不含遙測或分析。使用外掛不需要帳號或付款；中繼伺服器需要你自己的 Cloudflare 帳號。

## 本機開發

在 `relay/`、`relay/web/` 與 `plugin/` 中各執行 `npm install`（Node.js 22.12 或更新版本）。

```sh
# relay
cd relay
printf 'DB_ENC_KEY=%s\nADMIN_TOKEN_HASH=%s\n' "$(openssl rand -base64 32)" "$(printf 'dev-token' | shasum -a 256 | cut -d' ' -f1)" > .dev.vars
npm run db:migrate:local
npm run dev            # http://localhost:8787，以 "dev-token" 登入
npm test && npm run typecheck

# 管理介面
cd relay/web && npm run build   # 輸出到 ../public

# plugin
cd plugin
npm run build          # 產生 main.js
npm test && npm run e2e
```

**發行：** 更新 `manifest.json`、`versions.json` 與 `plugin/package.json` 的版本，推送相同的標籤（例如 `0.2.1`，不加 `v`），GitHub Actions 會發行。

## 已知限制

- iOS 無法在背景同步。iOS 上對 `RTCPeerConnection` 的支援尚未在實機確認，若不支援，該裝置只能透過信箱同步。
- 不支援：`.git` 儲存庫、無介面的常駐裝置、選擇性同步、即時多人協作、多位管理員、自動更換 Vault 金鑰。

## 授權

GPL-3.0-only（[LICENSE](LICENSE)）。管理介面以 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)（MIT）為基礎；請參閱 `relay/web/NOTICE.md`。
