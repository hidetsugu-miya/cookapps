# cookup

Gmail 専用の、個人向けデスクトップクライアントです。
Tauri v2 と Rust で作っています。

## 機能

- 受信トレイのスレッドを新しい順に一覧する
- スレッドを開いて本文を表示する
- スレッドをゴミ箱へ移動する
- スレッドをアーカイブする
- 一覧のチェックボックスで、スレッドを既読・未読にする
- 一覧の行にマウスを乗せると出るボタンで、スレッドをアーカイブする・ゴミ箱へ移動する
- 複数の Gmail アカウントを追加し、全アカウントの受信トレイを 1 つの一覧にまとめて表示する

今後、次の機能を追加する予定です。

- Google Calendar の予定を表示する

## 必要なもの

- Rust（stable）
- Node.js
- Gmail API を有効にした Google Cloud プロジェクト

## セットアップ

1. Google Cloud で Gmail API を有効にし、OAuth 同意画面を設定します。
2. 種類「デスクトップアプリ」の OAuth クライアントを作り、JSON をダウンロードします。
3. JSON を `client_secret.json` という名前で、Tauri の `app_config_dir` に置きます。
   - macOS では `~/Library/Application Support/jp.mysis.cookup/client_secret.json` です。
   - ファイルが無いと、ログイン時に配置先の絶対パス付きでエラーが出ます。

要求するスコープは `gmail.modify` です。
同意画面が「外部」かつ「テスト」のままだと、リフレッシュトークンは 7 日で失効します。

## 起動

```sh
npm install
npx tauri dev
```

初回は「Google でログイン」を押すと、既定のブラウザが開きます。
2 つ目以降のアカウントは、サイドメニュー下部の「アカウントを追加」から同じ手順で追加します。
リフレッシュトークンはアカウントごとに OS のキーチェーンへ保存されるので、次回からはログインが要りません。
アカウントの一覧（メールアドレスのみ）は、`app_config_dir` の `accounts.json` に保存されます。

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
