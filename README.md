# cookup

Gmail 専用の、個人向けデスクトップクライアントです。
Tauri v2 と Rust で作っています。

## 機能

- 受信トレイのスレッドを新しい順に一覧する

今後、次の機能を追加する予定です。

- スレッドを開いて本文を表示する
- スレッドをゴミ箱へ移動する
- スレッドをアーカイブする
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
リフレッシュトークンは OS のキーチェーンに保存されるので、次回からはログインが要りません。

## テスト

```sh
cd src-tauri && cargo test
```

## ライセンス

[MIT](LICENSE)
