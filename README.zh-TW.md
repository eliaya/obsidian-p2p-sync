# Peer Vault Sync

[日本語](README.md) | **繁體中文** | [简体中文](README.zh-CN.md) | [English](README.en.md)

在你自己的裝置之間同步整個 Obsidian Vault：筆記、附件，以及 `.obsidian` 資料夾（主題、外掛、設定、工作區）。裝置同時在線時，會透過 WebRTC 直接互相連線。你自行架設在 Cloudflare Workers 上的小型中繼伺服器負責訊號交換，為離線的裝置保存端對端加密的「信箱」資料包，並提供管理介面。

```
  Obsidian plugin (device A) <======= WebRTC data channel =======> Obsidian plugin (device B)
        |   \                                                         /   |
        |    \__ HTTPS / WebSocket (signalling, mailbox) __ relay ___/    |
        |                         Cloudflare Worker                        |
        |              D1 (peers, settings)   R2 (encrypted mailbox)       |
        +--------------- STUN/TURN: Cloudflare Realtime (optional) --------+
```

- `plugin/`：Obsidian 外掛（`peer-vault-sync`）。
- `relay/`：Worker（Durable Object 房間、D1、R2）、位於 `relay/web/` 的管理介面，以及位於 `relay/locales/` 的介面字串。
- `docs/protocol.md`：外掛與中繼伺服器之間的通訊規範。

## 功能

- 在桌面與行動裝置上，以 1:1 方式同步整個 Vault，包括 `.obsidian` 等隱藏資料夾。
- 端對端加密。中繼伺服器看不到筆記內容、檔案路徑或金鑰。
- 即使裝置從不同時在線，也能透過加密信箱完成同步。
- 逐檔案的歷史：檢視各版本、與目前的檔案比較、還原任一版本，並可還原已刪除的檔案。
- gitignore 格式的忽略規則（`.syncignore`）。
- 自行架設的中繼伺服器，其管理介面可用來核准、停用與命名裝置、變更設定、查看稽核記錄，以及新增介面語言。
- 介面提供英文與繁體中文；其他語言可從管理介面新增。

## 運作方式

1. **變更會成為修訂版本。** 外掛會監看 Vault 並掃描隱藏資料夾。每次變更都會記錄為一筆修訂版本（路徑、內容的 SHA-256、裝置、序號、父版本），存放在裝置上的 IndexedDB。相同雜湊值的內容只會儲存一份。
2. **裝置互相交換對方缺少的內容。** 兩台裝置同時在線時，會開啟 WebRTC 資料通道並比對版本向量。雙方只會傳送對方所缺少的修訂版本與內容。
3. **同時發生的編輯會被合併。** 若兩邊都修改了同一個 Markdown 檔案，外掛會進行三方合併。若修改的內容重疊，或檔案不是文字檔，則以最新的版本為準。另一個版本會保留在歷史中，因此不會遺失任何內容。
4. **離線的裝置會收到信件。** 若已知的裝置處於離線狀態，外掛會將缺少的修訂版本與內容加密成資料包，上傳到中繼伺服器。該裝置下次開啟時會下載並套用。當所有裝置都確認收到後，或滿 30 天後，中繼伺服器會刪除該資料包。
5. **中繼伺服器只負責連接裝置。** 它轉送加密的訊號交換訊息，在資料包送達之前保存加密的資料包，並在 D1 中保存裝置清單與稽核記錄。敏感欄位會以只有 Worker 持有的金鑰加密。

## 安裝外掛

- **從社群外掛安裝**（外掛上架之後）：設定 > 社群外掛程式 > 瀏覽，搜尋「Peer Vault Sync」，然後安裝並啟用。
- **手動安裝：** 從[最新版本](https://github.com/eliaya/obsidian-p2p-sync/releases/latest)下載 `main.js`、`manifest.json` 與 `styles.css`，放進 `<vault>/.obsidian/plugins/peer-vault-sync/`，再到設定 > 社群外掛程式中啟用「Peer Vault Sync」。

需要 Obsidian 1.8.7 或更新版本。首次同步 Vault 之前，請先備份。

## 部署中繼伺服器

每個人或每個團隊都需要自己的中繼伺服器。請從兩種方式中擇一。

### 方式 A：一鍵部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eliaya/obsidian-p2p-sync/tree/main/relay)

1. **在你的電腦上產生兩組密鑰**（只有這一步需要 Node.js）：
   ```sh
   node -e "const c=require('crypto'),t=c.randomBytes(32).toString('base64url');console.log('admin token:',t);console.log('ADMIN_TOKEN_HASH:',c.createHash('sha256').update(t).digest('hex'));console.log('DB_ENC_KEY:',c.randomBytes(32).toString('base64'))"
   ```
   請將**管理員權杖（admin token）**與 **`DB_ENC_KEY`** 存放在密碼管理工具中。你要以管理員權杖登入管理介面。若遺失 `DB_ENC_KEY`，加密的資料庫欄位將永遠無法再讀取。
2. **點選按鈕**並登入 Cloudflare。出現提示時，連結你的 GitHub 或 GitLab 帳號。Cloudflare 會將 `relay/` 資料夾複製到你帳號下的新儲存庫。
3. **檢查名稱。** 你可以保留或變更 Worker 名稱、D1 資料庫名稱與 R2 儲存貯體名稱。
4. **輸入密鑰。** 貼上第 1 步產生的 `DB_ENC_KEY` 與 `ADMIN_TOKEN_HASH`。請勿貼上管理員權杖本身。
5. **部署。** Cloudflare 會建立 D1 資料庫、R2 儲存貯體與 Durable Object，然後進行建置與部署：
   - 建置指令 `npm run build`：安裝相依套件，並將管理介面建置到 `public/`。
   - 部署指令 `npm run deploy`：對新資料庫套用 D1 遷移，然後執行 `wrangler deploy`。
6. **開啟 Worker 網址**（`https://<worker-name>.<your-subdomain>.workers.dev`），並以管理員權杖登入。

之後每次推送到新儲存庫，都會自動重新部署 Worker（Workers Builds）。

與方式 B 的差異：按鈕不會建立 R2 的生命週期規則。該規則只是後備機制：每日的 cron 排程作業已會刪除過期的資料包。若仍想加入，請執行一次 `npx wrangler r2 bucket lifecycle add <bucket> expire-mailbox-45d --expire-days 45`。

若建置記錄在 D1 遷移步驟顯示權限錯誤，請授予 Workers Builds API 權杖「D1 Edit」權限（Worker > Settings > Build），或先在你的電腦上執行一次 `npx wrangler d1 migrations apply DB --remote`，再重新建置。

### 方式 B：從你的電腦部署

需要 Node.js 22.12 或更新版本，以及本儲存庫的複本。

1. **建立 API 權杖。** Cloudflare dashboard > My Profile > API Tokens > Create Token > Custom token。加入下列權限，並將權杖限制在你的帳號範圍內：
   - Account > Workers Scripts > Edit
   - Account > D1 > Edit
   - Account > Workers R2 Storage > Edit
2. **填寫 `relay/.env`。** 執行 `cp relay/.env.example relay/.env`，然後設定 `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`。此檔案已被 git 忽略。切勿提交它，也不要將內容貼到任何地方。
3. **一次性設定**（可安全地重複執行）：
   ```sh
   cd relay
   npm install
   npm run setup -- --dry-run   # lists what it would do, changes nothing
   npm run setup                # asks for confirmation; --yes skips it
   ```
   它會建立 D1 資料庫與 R2 儲存貯體（或沿用既有的），將 D1 的 id 寫入 `wrangler.jsonc`，加入 45 天的 R2 生命週期規則，並設定 Worker 密鑰 `DB_ENC_KEY`（若已存在則絕不覆寫）與 `ADMIN_TOKEN_HASH`。**它只會顯示一次管理員權杖：請存放在密碼管理工具中。** `--rotate-admin-token` 可將其替換。
4. **部署：**
   ```sh
   npm run deploy:local              # build, typecheck, test, migrate, deploy, check /health
   npm run deploy:local -- --dry-run # everything except the migrations and the real deploy
   ```
   若無法從輸出中取得 Worker 網址，請加上 `--url https://<your-worker>.workers.dev`。

## 初次使用

1. **登入管理介面**：在 Worker 網址以管理員權杖登入。在「設定」中，你可以加入 TURN 憑證（Cloudflare Realtime 的「TURN 金鑰 ID」與「TURN API 權杖」），以便在嚴格的網路環境中連線。TURN 為選用。
2. **設定第一台裝置。** 在外掛設定中輸入中繼伺服器網址，並選擇「測試連線」。接著在「這是第一台裝置」之下，選擇「產生 Vault 金鑰」。
3. **核准裝置。** 新裝置在管理介面中會顯示為 `pending`。將該裝置設為 `active`。
4. **加入其他裝置。** 在第一台裝置上選擇「顯示設定碼」。在另一台裝置上安裝外掛，將設定碼貼到「加入既有的 Vault」之下（或開啟設定連結，或掃描 QR 碼），然後在管理介面中核准這台新裝置。

指令（指令面板）：立即同步、顯示同步狀態、檢視檔案歷史、還原已刪除的檔案。你也可以在檔案上按右鍵，選擇「檢視檔案歷史」。

## 值得了解的設定

- **忽略規則。** 將 gitignore 格式的規則放在 Vault 根目錄的 `.syncignore`，或在設定 > Peer Vault Sync > 忽略規則中編輯。此檔案本身一律會同步，因此每台裝置都使用相同的規則。`.git/` 一律會被忽略。
  ```
  .DS_Store
  .trash/
  *.tmp
  ```
  - 開始符合規則的檔案會停止同步。不會刪除任何內容：其他裝置上已有的副本會保留原狀。
  - 其他裝置對被忽略檔案所做的變更會保留在歷史中，但不會寫入磁碟。若你之後移除該規則，這些變更會在下次同步時寫入。內容不同的本機副本，會依一般的衝突規則與它們合併。
  - 與 git 相同，被忽略資料夾內的檔案無法以 `!` 重新納入。
- **通知。** 可選擇「顯示」、「自動隱藏」（N 秒後隱藏）或「不顯示」。此設定只套用於這台裝置，且只影響本外掛的通知。同步錯誤一律會記錄在狀態視窗中。
- **歷史保留天數。** 舊版本的內容會在經過這個天數後刪除（預設 90 天）。每個檔案的目前版本一律保留。

## 安全模型

- **端對端加密的範圍。** 所有由 Vault 金鑰衍生的內容都只留在裝置上：信箱資料包中的筆記內容與檔案路徑，以及 WebRTC 訊號交換訊息（SDP/ICE）。中繼伺服器絕不會收到 Vault 金鑰或任何由它衍生的金鑰。
- **中繼伺服器看得到的資訊。** 裝置加入了哪個房間（由 Vault 金鑰衍生的雜湊值）、每台裝置的公開金鑰，以及 Cloudflare 所見的 IP 位址、連線時間、信箱資料包的大小與時間，還有你在管理介面中輸入的裝置名稱與設定。它無法讀取筆記內容或路徑。
- **儲存的是密文。** 信箱資料包會以密文形式保存在 R2，直到所有裝置都已取回，或資料包過期為止（預設 30 天，可在管理介面中設定）。
- **Vault 金鑰就是存取金鑰。** 任何持有它的人都能解密資料包並以裝置身分加入。請只透過設定碼、QR 碼或設定連結分享，並將這些內容視同密碼。
- **停用裝置不會撤銷金鑰。** 被設為 `revoked` 的裝置雖然無法再使用中繼伺服器，但仍持有 Vault 金鑰。若裝置遺失，請產生新的 Vault 金鑰，並重新配對每一台裝置。
- **遺失 `DB_ENC_KEY` 無法挽回。** 加密的資料庫欄位將永遠無法再讀取，且中繼伺服器必須重設。你裝置上的 Vault 資料不受影響。
- **管理員權杖。** Worker 只儲存它的 SHA-256 雜湊值。

## 網路使用聲明

外掛只有在設定好同步之後才會建立網路連線，且只連線至：

1. **你所設定的中繼伺服器**（你自己的 Cloudflare Worker）：用於訊號交換的 HTTPS 請求與 WebSocket、信箱的上傳與下載、介面語言，以及連線測試。
2. **你的其他裝置**，直接透過 WebRTC 連線。
3. **Cloudflare STUN**（`stun.cloudflare.com`），用來尋找裝置之間的直接路徑。
4. **Cloudflare TURN**，僅在你於管理介面啟用 TURN 時使用，在嚴格的網路環境中轉送加密流量。伺服器與憑證由你的中繼伺服器提供。

不含遙測、分析或其他第三方請求。在你輸入中繼伺服器網址與 Vault 金鑰之前，不會傳送任何內容。使用此外掛不需要帳號或付款；中繼伺服器則需要你自己的 Cloudflare 帳號。

## 本機開發

在每個套件中各安裝一次相依套件（在 `relay/`、`relay/web/` 與 `plugin/` 中執行 `npm install`）。Node.js 22.12 或更新版本。

**relay**
```sh
cd relay
printf 'DB_ENC_KEY=%s\nADMIN_TOKEN_HASH=%s\n' "$(openssl rand -base64 32)" "$(printf 'dev-token' | shasum -a 256 | cut -d' ' -f1)" > .dev.vars   # git-ignored
npm run db:migrate:local
npm run dev            # http://localhost:8787, sign in to the dashboard with "dev-token"
npm test && npm run typecheck
```

**relay/web**（管理介面）
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

**發行：** 更新 `manifest.json`、`versions.json` 與 `plugin/package.json` 中的版本，提交後，推送與版本相同的標籤（例如 `0.2.1`，不加 `v`）。GitHub Actions 會測試、建置並發行。

## 已知限制

- iOS 無法在背景同步。裝置會在 Obsidian 位於前景時同步；有了信箱，另一台裝置就不必同時在線。
- 在 iOS 版 Obsidian 中對 `RTCPeerConnection` 的支援，尚未在實機上確認。若不支援，該裝置將只能透過信箱同步。
- 首次合併兩個既有的 Vault 時，路徑相同、內容不同且沒有共同歷史的檔案，會依衝突規則處理。較舊的內容會進入歷史。
- 歷史使用本機儲存空間；保留設定可控制其用量。
- 不支援：真正的 `.git` 儲存庫、無介面且常駐的裝置、依裝置的選擇性同步、即時多人協作、多位管理員、自動更換 Vault 金鑰。

## 授權

GPL-3.0-only。詳見 [LICENSE](LICENSE)。

管理介面以 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)（MIT）為基礎；請參閱 `relay/web/NOTICE.md`。
