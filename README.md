# cookup

Gmail 専用の、個人向けデスクトップクライアントです。
Tauri v2 と Rust で作っています。

## 機能

- 複数の Gmail アカウントを追加し、全アカウントの受信トレイを新しい順に 1 つの一覧で表示する
- スレッドを開いて本文を表示する（日本語の文字コードと HTML メールに対応。外部の画像などは読み込まない）
- スレッドをアーカイブする・ゴミ箱へ移動する（詳細画面のボタン、または一覧の行にマウスを乗せると出るボタン）
- 一覧のチェックボックスで、スレッドを既読・未読にする（未読の行には水色の点が付く）
- サイドメニューのアカウントのアイコンから、そのアカウントを cookup から削除する（Google 側のアクセス権も取り消す。Gmail のメールは消えない）
- 約 10 秒ごとに受信トレイを Gmail と同期し、新着や他の端末での既読化・アーカイブを自動で反映する
- 未読のスレッドの件数を、macOS の Dock のアイコンにバッジで表示する（0 件のときは消える）
- 全アカウントの Google Calendar の予定を、1 つの週表示にまとめて表示する（閲覧のみ。サイドメニューのカレンダーのアイコンで開く）

## 必要なもの

- Rust（stable）
- Node.js
- Gmail API と Google Calendar API を有効にした Google Cloud プロジェクト

## セットアップ

1. Google Cloud で Gmail API と Google Calendar API を有効にし、OAuth 同意画面を設定します。
2. 種類「デスクトップアプリ」の OAuth クライアントを作り、JSON をダウンロードします。
3. JSON を `client_secret.json` という名前で、Tauri の `app_config_dir` に置きます。
   - macOS では `~/Library/Application Support/jp.mysis.cookup/client_secret.json` です。
   - ファイルが無いと、ログイン時に配置先の絶対パス付きでエラーが出ます。

要求するスコープは `gmail.modify` と `calendar.readonly` です。
カレンダーのスコープが付く前にログインしたアカウントは、カレンダーを開くと「再ログイン」が表示されるので、押して許可し直します。
同意画面が「外部」かつ「テスト」のままだと、リフレッシュトークンは 7 日で失効します。
組織の外のアカウントも使う場合は、同意画面を「外部」「本番環境」にします。
Google の審査を受けていないと、ログイン時に「Google はこのアプリを確認していません」と表示されます。
本番環境にするには、ホームページとプライバシーポリシーの URL が必要です（このリポジトリでは `docs/` を GitHub Pages で公開しています）。

## 起動

```sh
npm install
npx tauri dev
```

初回は「Google でログイン」を押すと、既定のブラウザが開きます。
2 つ目以降のアカウントは、サイドメニュー下部の「アカウントを追加」から同じ手順で追加します。
リフレッシュトークンはアカウントごとに OS のキーチェーンへ保存されるので、次回からはログインが要りません。
アカウントの一覧（メールアドレスのみ）は、`app_config_dir` の `accounts.json` に保存されます。

## アプリとして入れる

`/Applications` に `cookup.app` として入れると、`tauri dev` なしで起動できます。
macOS で、キーチェーンに Apple Development 証明書（Apple ID で作れる無料のもので足ります）が入っている前提です。

```sh
npm install
scripts/install-app.sh
```

スクリプトは `npx tauri build --bundles app` で `.app` を作り、署名を確かめてから `/Applications/cookup.app` に置きます。
cookup が起動中のときは、終了してからやり直します。
古い版はゴミ箱へ移します。
署名の証明書は、キーチェーンの最初の Apple Development 証明書を使います。
別の証明書を使うときは、環境変数 `APPLE_SIGNING_IDENTITY` に証明書の名前かハッシュを渡します。
`--no-install` を付けると、ビルドと署名の確認だけをして `/Applications` には置きません。

Developer ID での署名と公証はしていません。
自分のマシンで作った `.app` を、そのマシンで使う想定です。
`client_secret.json`、`accounts.json`、キーチェーンの保存先は `tauri dev` と同じなので、設定やログインはそのまま使えます。

## テスト

```sh
cd src-tauri && cargo test
```

CI（`.github/workflows/ci.yml`）と同じチェックは、次のコマンドでローカルでも流せます。

```sh
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cd ..
scripts/check-version.sh        # タグ名を渡すと、そのタグとも照合します（例: scripts/check-version.sh v0.4.2）
```

## ライセンス

[MIT](LICENSE)
