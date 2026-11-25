# Peer Vault Sync

**日本語** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [English](README.en.md)

自分のデバイス間で Obsidian の Vault 全体（ノート、添付ファイル、`.obsidian` 内のテーマ・プラグイン・設定）を同期します。デバイス同士が同時にオンラインなら WebRTC で直接通信し、そうでなければ Cloudflare Workers 上の自己ホスト型リレーに置いた、エンドツーエンド暗号化済みの「メールボックス」バンドルで受け渡します。

- `plugin/`: Obsidian プラグイン（`peer-vault-sync`）。
- `relay/`: Worker（Durable Object、D1、R2）、管理ダッシュボード（`relay/web/`）、UI 文字列（`relay/locales/`）。

## 機能

- デスクトップとモバイルで、隠しフォルダーを含む Vault 全体を同期。
- エンドツーエンド暗号化。リレーはノートの内容、ファイルパス、鍵を見られません。
- Markdown の同時編集は 3-way マージ。重なる編集やテキスト以外のファイルは最新版が優先され、もう一方は履歴に残ります。
- ファイルごとの履歴（比較、復元、削除したファイルの復元）。
- gitignore 形式の無視ルール（`.syncignore`）。
- ダッシュボードでデバイスの承認・失効、設定変更、監査ログの閲覧、UI 言語の追加。

## プラグインのインストール

- **コミュニティプラグインから**（掲載後）: 設定 > コミュニティプラグイン > 閲覧 で「Peer Vault Sync」を検索。
- **手動:** [最新リリース](https://github.com/eliaya/obsidian-p2p-sync/releases/latest)の `main.js`、`manifest.json`、`styles.css` を `<vault>/.obsidian/plugins/peer-vault-sync/` に置き、有効にします。

Obsidian 1.8.7 以降が必要です。初回同期の前に Vault をバックアップしてください。

## リレーのデプロイ

### オプション A: ワンクリック

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eliaya/obsidian-p2p-sync/tree/main/relay)

1. シークレットを生成します（Node.js が必要）:
   ```sh
   node -e "const c=require('crypto'),t=c.randomBytes(32).toString('base64url');console.log('admin token:',t);console.log('ADMIN_TOKEN_HASH:',c.createHash('sha256').update(t).digest('hex'));console.log('DB_ENC_KEY:',c.randomBytes(32).toString('base64'))"
   ```
   **admin token** と **`DB_ENC_KEY`** はパスワードマネージャーに保存してください。`DB_ENC_KEY` を紛失すると、暗号化されたデータベースのカラムは二度と読めません。
2. ボタンをクリックし、Cloudflare にサインインして GitHub/GitLab を連携します。
3. `DB_ENC_KEY` と `ADMIN_TOKEN_HASH` を貼り付けてデプロイします（admin token そのものは貼らない）。
4. Worker の URL を開き、admin token でサインインします。

以降、新しいリポジトリへのプッシュで自動再デプロイされます。ビルドログで D1 マイグレーションの権限エラーが出たら、Workers Builds の API トークンに「D1 Edit」を付与するか、`npx wrangler d1 migrations apply DB --remote` を一度実行して再試行してください。

### オプション B: ローカルから

Node.js 22.12 以降とこのリポジトリのクローンが必要です。

1. Cloudflare で API トークンを作成します（Workers Scripts、D1、Workers R2 Storage の Edit 権限）。
2. `cp relay/.env.example relay/.env` で `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を設定します（git 管理外）。
3. セットアップとデプロイ:
   ```sh
   cd relay
   npm install
   npm run setup          # D1・R2・シークレットを作成。--dry-run で確認のみ
   npm run deploy:local   # build, typecheck, test, migrate, deploy, check /health
   ```
   **admin token は一度だけ表示されます。** 置き換えるには `npm run setup -- --rotate-admin-token`。

## 初回の利用

1. ダッシュボードにサインインします。厳しいネットワーク向けに TURN 認証情報（Cloudflare Realtime）を Settings で追加できます（任意）。
2. 最初のデバイスで、プラグイン設定にリレーの URL を入力し、"Create vault key" を選択します。
3. ダッシュボードで `pending` のデバイスを `active` にします。
4. 最初のデバイスで "Show setup code" を選び、もう一方のデバイスの "Join an existing vault" に貼り付け（またはリンク・QR コード）、ダッシュボードで承認します。

コマンド: "Sync now"、"Show sync status"、"View file history"、"Restore a deleted file"。

## セキュリティモデル

- **暗号化されるもの:** ノートの内容、ファイルパス、WebRTC シグナリング。Vault キーはデバイスから出ません。
- **リレーが見られるもの:** ルームのハッシュ、デバイスの公開鍵と IP、接続時刻、バンドルのサイズと時刻、ダッシュボードで入力したラベルと設定。
- **Vault キーがアクセスキーです。** セットアップコード・QR・リンクはパスワードと同様に扱ってください。デバイスを `revoked` にしてもキーは失効しないため、紛失時は新しい Vault キーで全デバイスを再ペアリングしてください。
- メールボックスバンドルは、全デバイスが取得するか有効期限（デフォルト 30 日）まで R2 に保管されます。admin token はハッシュのみ保存されます。

## ネットワーク使用に関する開示

プラグインは同期を設定した後、次の接続先にのみ通信します。

1. 設定したリレー（お使いの Cloudflare Worker）: シグナリング、メールボックス、UI 言語、接続テスト。
2. お使いのほかのデバイス: WebRTC による直接接続。
3. Cloudflare STUN（`stun.cloudflare.com`）: 直接経路の探索。
4. Cloudflare TURN: ダッシュボードで有効にした場合のみ。

テレメトリーやアナリティクスはありません。プラグインにアカウントや支払いは不要ですが、リレーにはご自身の Cloudflare アカウントが必要です。

## ローカル開発

`relay/`、`relay/web/`、`plugin/` でそれぞれ `npm install`（Node.js 22.12 以降）。

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

**リリース:** `manifest.json`、`versions.json`、`plugin/package.json` のバージョンを更新し、同じタグ（例: `0.2.1`、`v` なし）をプッシュすると GitHub Actions が公開します。

## 既知の制限

- iOS ではバックグラウンド同期不可。`RTCPeerConnection` の対応は実機未確認で、非対応ならメールボックス経由のみになります。
- 非対応: `.git` リポジトリ、ヘッドレスデバイス、選択的同期、複数ユーザーのリアルタイム共同編集、複数の管理者、Vault キーの自動ローテーション。

## ライセンス

GPL-3.0-only（[LICENSE](LICENSE)）。ダッシュボードは [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)（MIT）がベースです。`relay/web/NOTICE.md` を参照。
