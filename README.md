# Peer Vault Sync

**日本語** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [English](README.en.md)

自分のデバイス間で Obsidian の Vault 全体（ノート、添付ファイル、`.obsidian` フォルダー内のテーマ、プラグイン、設定、ワークスペース）を同期します。デバイス同士が同時にオンラインであれば、WebRTC で直接通信します。Cloudflare Workers 上で運用する小規模なリレーが、シグナリング、オフラインのデバイス向けにエンドツーエンドで暗号化された「メールボックス」バンドルの保管、および管理ダッシュボードを担います。

```
  Obsidian plugin (device A) <======= WebRTC data channel =======> Obsidian plugin (device B)
        |   \                                                         /   |
        |    \__ HTTPS / WebSocket (signalling, mailbox) __ relay ___/    |
        |                         Cloudflare Worker                        |
        |              D1 (peers, settings)   R2 (encrypted mailbox)       |
        +--------------- STUN/TURN: Cloudflare Realtime (optional) --------+
```

- `plugin/`: Obsidian プラグイン（`peer-vault-sync`）。
- `relay/`: Worker（Durable Object のルーム、D1、R2）、`relay/web/` にある管理ダッシュボード、および `relay/locales/` にある UI 文字列。

## 機能

- デスクトップとモバイルで、`.obsidian` などの隠しフォルダーを含む Vault 全体を 1 対 1 で同期します。
- エンドツーエンド暗号化。リレーはノートの内容、ファイルパス、鍵を一切見ることができません。
- 暗号化されたメールボックスにより、デバイス同士が同時にオンラインにならなくても動作します。
- ファイルごとの履歴: バージョンの表示、現在のファイルとの比較、任意のバージョンの復元、削除したファイルの復元に対応します。
- gitignore 形式の無視ルール（`.syncignore`）。
- 自己ホスト型のリレーとダッシュボード。デバイスの承認、失効、ラベル付け、設定の変更、監査ログの閲覧、UI 言語の追加ができます。
- UI は英語と繁體中文に対応しています。ダッシュボードから言語を追加できます。

## 仕組み

1. **変更はリビジョンになります。** プラグインは Vault を監視し、隠しフォルダーもスキャンします。変更はそれぞれリビジョン（パス、内容の SHA-256、デバイス、シーケンス番号、親）として、デバイス上の IndexedDB に記録されます。内容はハッシュごとに 1 回だけ保存されます。
2. **デバイスは相手に足りないものを交換します。** 2 台のデバイスがオンラインになると、WebRTC データチャネルを開き、バージョンベクターを比較します。各デバイスは、相手に足りないリビジョンと内容だけを送ります。
3. **同時編集はマージされます。** 双方が同じ Markdown ファイルを変更した場合、プラグインは 3-way マージを実行します。編集が重なる場合、またはファイルがテキストでない場合は、最新のバージョンが優先されます。もう一方のバージョンは履歴に残るため、失われるものはありません。
4. **オフラインのデバイスにはメールが届きます。** 既知のデバイスがオフラインの場合、プラグインは足りないリビジョンと内容を暗号化してバンドルにまとめ、リレーにアップロードします。デバイスは次に起動したときにそれをダウンロードして適用します。リレーは、すべてのデバイスが受領を確認した時点、または 30 日後にバンドルを削除します。
5. **リレーはデバイスを接続するだけです。** 暗号化されたシグナリングメッセージを転送し、暗号化されたバンドルを配信されるまで保管し、デバイス一覧と監査ログを D1 に保持します。機密性の高いカラムは、Worker だけが持つ鍵で暗号化されます。

## プラグインのインストール

- **コミュニティプラグインから**（プラグインが掲載された後）: 設定 > コミュニティプラグイン > 閲覧 で「Peer Vault Sync」を検索し、インストールして有効にします。
- **手動で:** [最新リリース](https://github.com/eliaya/obsidian-p2p-sync/releases/latest)から `main.js`、`manifest.json`、`styles.css` をダウンロードし、`<vault>/.obsidian/plugins/peer-vault-sync/` に置きます。その後、設定 > コミュニティプラグインで「Peer Vault Sync」を有効にします。

Obsidian 1.8.7 以降が必要です。初めて同期する前に、Vault をバックアップしてください。

## リレーのデプロイ

個人またはチームごとに、専用のリレーが必要です。次の 2 つの方法のいずれかを選んでください。

### オプション A: ワンクリックデプロイ

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eliaya/obsidian-p2p-sync/tree/main/relay)

1. お使いのコンピューターで**2 つのシークレットを生成します**（Node.js が必要なのはこの手順だけです）:
   ```sh
   node -e "const c=require('crypto'),t=c.randomBytes(32).toString('base64url');console.log('admin token:',t);console.log('ADMIN_TOKEN_HASH:',c.createHash('sha256').update(t).digest('hex'));console.log('DB_ENC_KEY:',c.randomBytes(32).toString('base64'))"
   ```
   **admin token** と **`DB_ENC_KEY`** は、パスワードマネージャーに保存してください。ダッシュボードへのサインインには admin token を使います。`DB_ENC_KEY` を紛失すると、暗号化されたデータベースのカラムは二度と読み取れなくなります。
2. **ボタンをクリック**して、Cloudflare にサインインします。求められたら GitHub または GitLab のアカウントを連携します。Cloudflare は `relay/` フォルダーを、お使いのアカウント内の新しいリポジトリにコピーします。
3. **名前を確認します。** Worker 名、D1 データベース名、R2 バケット名は、そのままでも変更しても構いません。
4. **シークレットを入力します。** 手順 1 で生成した `DB_ENC_KEY` と `ADMIN_TOKEN_HASH` を貼り付けます。admin token そのものは貼り付けないでください。
5. **デプロイします。** Cloudflare が D1 データベース、R2 バケット、Durable Object を作成し、ビルドとデプロイを行います。
   - ビルドコマンド `npm run build`: ダッシュボードをインストールし、`public/` にビルドします。
   - デプロイコマンド `npm run deploy`: 新しいデータベースに D1 マイグレーションを適用してから、`wrangler deploy` を実行します。
6. **Worker の URL**（`https://<worker-name>.<your-subdomain>.workers.dev`）を開き、admin token でサインインします。

新しいリポジトリに以降プッシュすると、Worker は自動的に再デプロイされます（Workers Builds）。

オプション B との違い: ボタンでは R2 のライフサイクルルールは作成されません。このルールはあくまで保険です。期限切れのバンドルは、毎日の cron ジョブがすでに削除しています。それでも追加したい場合は、`npx wrangler r2 bucket lifecycle add <bucket> expire-mailbox-45d --expire-days 45` を一度実行してください。

D1 マイグレーションの手順でビルドログに権限エラーが表示された場合は、Workers Builds の API トークンに「D1 Edit」権限を付与するか（Worker > Settings > Build）、お使いのコンピューターから `npx wrangler d1 migrations apply DB --remote` を一度実行してから、ビルドを再試行してください。

### オプション B: お使いのコンピューターからデプロイ

Node.js 22.12 以降と、このリポジトリのクローンが必要です。

1. **API トークンを作成します。** Cloudflare dashboard > My Profile > API Tokens > Create Token > Custom token。次の権限を追加し、トークンの対象をお使いのアカウントに限定します。
   - Account > Workers Scripts > Edit
   - Account > D1 > Edit
   - Account > Workers R2 Storage > Edit
2. **`relay/.env` に記入します。** `cp relay/.env.example relay/.env` を実行し、`CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を設定します。このファイルは git で無視されます。コミットしたり、どこかに貼り付けたりしないでください。
3. **初回セットアップ**（繰り返し実行しても安全です）:
   ```sh
   cd relay
   npm install
   npm run setup -- --dry-run   # lists what it would do, changes nothing
   npm run setup                # asks for confirmation; --yes skips it
   ```
   D1 データベースと R2 バケットを作成（または再利用）し、D1 の id を `wrangler.jsonc` に書き込み、45 日の R2 ライフサイクルルールを追加し、Worker のシークレット `DB_ENC_KEY`（すでに存在する場合は上書きされません）と `ADMIN_TOKEN_HASH` を設定します。**admin token は一度だけ表示されます。パスワードマネージャーに保存してください。** `--rotate-admin-token` を指定すると、これを置き換えます。
4. **デプロイ:**
   ```sh
   npm run deploy:local              # build, typecheck, test, migrate, deploy, check /health
   npm run deploy:local -- --dry-run # everything except the migrations and the real deploy
   ```
   出力から Worker の URL を読み取れない場合は、`--url https://<your-worker>.workers.dev` を追加してください。

## 初回の利用

1. **ダッシュボードにサインインします。** Worker の URL を開き、admin token でサインインします。Settings では、厳しいネットワーク経由で接続するための TURN 認証情報（Cloudflare Realtime の TURN キー id と API トークン）を追加できます。TURN は任意です。
2. **最初のデバイスをセットアップします。** プラグインの設定でリレーの URL を入力し、"Test connection"（接続テスト）を選択します。次に、"This is the first device" の下で "Create vault key"（Vault キーの作成）を選択します。
3. **承認します。** 新しいデバイスは、ダッシュボードに `pending` として表示されます。そのデバイスを `active` に設定します。
4. **ほかのデバイスを追加します。** 最初のデバイスで "Show setup code" を選択します。もう一方のデバイスにプラグインをインストールし、"Join an existing vault" の下にそのコードを貼り付けます（セットアップリンクを開くか、QR コードをスキャンしても構いません）。その後、新しいデバイスをダッシュボードで承認します。

コマンド（コマンドパレット）: "Sync now"、"Show sync status"、"View file history"、"Restore a deleted file"。ファイルを右クリックして "View file history" を選ぶこともできます。

## 知っておきたい設定

- **無視ルール。** gitignore 形式のパターンを、Vault のルートにある `.syncignore` に記述するか、設定 > Peer Vault Sync > Ignore rules で編集します。このファイル自体は常に同期されるため、すべてのデバイスが同じルールを使います。`.git/` は常に無視されます。
  ```
  .DS_Store
  .trash/
  *.tmp
  ```
  - ルールに一致するようになったファイルは、同期されなくなります。何も削除されません。ほかのデバイスにすでにあるコピーは、そのまま残ります。
  - 無視されているファイルに対してほかのデバイスが行った変更は、履歴には保持されますが、ディスクには書き込まれません。後でルールを削除すると、次の同期で書き込まれます。内容が異なるローカルのコピーは、通常の競合ルールに従ってそれらとマージされます。
  - git と同様に、無視されたフォルダー内のファイルを `!` で再度含めることはできません。
- **通知。** 表示する、N 秒後に自動で非表示にする、または表示しないを選べます。この設定はこのデバイスにのみ適用され、このプラグインの通知にのみ影響します。同期エラーは、常にステータスビューに記録されます。
- **Keep history for (days)。** 古いバージョンの内容は、この日数が経過すると削除されます（デフォルトは 90 日）。各ファイルの現在のバージョンは常に保持されます。

## セキュリティモデル

- **エンドツーエンドで暗号化されるもの。** Vault キーから導出されるものはすべてデバイス上にとどまります。具体的には、メールボックスバンドル内のノートの内容とファイルパス、および WebRTC のシグナリングメッセージ（SDP/ICE）です。リレーは Vault キーも、そこから導出された鍵も受け取りません。
- **リレーが見られるもの。** デバイスが参加するルーム（Vault キーから導出されたハッシュ）、各デバイスの公開鍵と Cloudflare から見える IP アドレス、接続した時刻、メールボックスバンドルのサイズと時刻、およびダッシュボードに入力したデバイスのラベルと設定です。ノートの内容やパスは読み取れません。
- **暗号文が保存されます。** メールボックスバンドルは、すべてのデバイスが取得するか、有効期限（デフォルトは 30 日。ダッシュボードで設定）が切れるまで、暗号文として R2 に保管されます。
- **Vault キーがアクセスキーです。** Vault キーを持つ人は誰でも、バンドルを復号し、デバイスとして参加できます。共有はセットアップコード、QR コード、またはセットアップリンクのみを通して行い、これらはパスワードと同様に扱ってください。
- **デバイスを失効させても、キーは失効しません。** `revoked` に設定されたデバイスは、リレーを使えなくなりますが、Vault キーは保持したままです。デバイスを紛失した場合は、新しい Vault キーを生成し、すべてのデバイスを再度ペアリングしてください。
- **`DB_ENC_KEY` の紛失は元に戻せません。** 暗号化されたデータベースのカラムは二度と読み取れなくなり、リレーをリセットする必要があります。お使いのデバイス上の Vault のデータには影響しません。
- **Admin token。** Worker が保存するのは、その SHA-256 ハッシュだけです。

## ネットワーク使用に関する開示

プラグインは、同期を設定した後にのみ、次の接続先に対してのみネットワーク接続を行います。

1. **設定したリレーサーバー**（お使いの Cloudflare Worker）: HTTPS リクエストと、シグナリング、メールボックスのアップロードとダウンロード、UI 言語、接続テストのための WebSocket。
2. **お使いのほかのデバイス**: WebRTC による直接接続。
3. **Cloudflare STUN**（`stun.cloudflare.com`）: デバイス間の直接経路を見つけるため。
4. **Cloudflare TURN**: ダッシュボードで TURN を有効にした場合のみ。厳しいネットワークを経由して、暗号化されたトラフィックを中継するために使います。サーバーと認証情報は、お使いのリレーから取得されます。

テレメトリー、アナリティクス、その他のサードパーティへのリクエストはありません。リレーの URL と Vault キーを入力するまでは、何も送信されません。プラグインの利用にアカウントや支払いは不要です。リレーには、ご自身の Cloudflare アカウントが必要です。

## ローカル開発

各パッケージで依存関係を一度インストールします（`relay/`、`relay/web/`、`plugin/` でそれぞれ `npm install`）。Node.js 22.12 以降。

**relay**
```sh
cd relay
printf 'DB_ENC_KEY=%s\nADMIN_TOKEN_HASH=%s\n' "$(openssl rand -base64 32)" "$(printf 'dev-token' | shasum -a 256 | cut -d' ' -f1)" > .dev.vars   # git-ignored
npm run db:migrate:local
npm run dev            # http://localhost:8787, sign in to the dashboard with "dev-token"
npm test && npm run typecheck
```

**relay/web**（ダッシュボード）
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

**リリース:** `manifest.json`、`versions.json`、`plugin/package.json` のバージョンを更新してコミットし、そのバージョンと同じタグ（例: `0.2.1`。`v` は付けません）をプッシュします。GitHub Actions がテスト、ビルド、リリースの公開を行います。

## 既知の制限

- iOS ではバックグラウンドでの同期はできません。デバイスは Obsidian がフォアグラウンドにある間に同期します。メールボックスにより、もう一方のデバイスが同時にオンラインである必要はありません。
- iOS 版 Obsidian での `RTCPeerConnection` のサポートは、実機ではまだ確認されていません。サポートされていない場合、そのデバイスはメールボックス経由でのみ同期することになります。
- 既存の 2 つの Vault を初めて統合するとき、パスが同じで内容が異なり、共通の履歴がないファイルは、競合ルールによって解決されます。古い方の内容は履歴に移されます。
- 履歴にはローカルストレージを使用します。保持設定で、その量を制御します。
- サポートされないもの: 実際の `.git` リポジトリ、常時稼働のヘッドレスデバイス、デバイスごとの選択的同期、複数ユーザーによるリアルタイム共同編集、複数の管理者、Vault キーの自動ローテーション。

## ライセンス

GPL-3.0-only。[LICENSE](LICENSE) を参照してください。

ダッシュボードは [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)（MIT）をベースにしています。`relay/web/NOTICE.md` を参照してください。
