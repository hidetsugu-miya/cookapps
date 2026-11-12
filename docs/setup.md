---
title: セットアップと起動
---

# セットアップと起動

## 必要なもの

- Rust（stable）
- Node.js
- Windows では、Tauri の前提条件（Microsoft C++ Build Tools と WebView2）
- Gmail API と Google Calendar API を有効にした Google Cloud プロジェクト

## セットアップ

1. Google Cloud で Gmail API と Google Calendar API を有効にし、OAuth 同意画面を設定します。
2. 種類「デスクトップアプリ」の OAuth クライアントを作り、JSON をダウンロードします。
3. JSON を `client_secret.json` という名前で、Tauri の `app_config_dir` に置きます。
   - macOS では `~/Library/Application Support/jp.mysis.cookapps/client_secret.json` です。
   - Windows では `%APPDATA%\jp.mysis.cookapps\client_secret.json`（`C:\Users\{ユーザー名}\AppData\Roaming\jp.mysis.cookapps\client_secret.json`）です。
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
2 つ目以降のアカウントは、設定画面の「Google」タブにある「アカウントを追加」から同じ手順で追加します。
リフレッシュトークンはアカウントごとに OS の資格情報の保管場所（macOS ではキーチェーン、Windows では資格情報マネージャー）へ保存されるので、次回からはログインが要りません。
アカウントの一覧（メールアドレスのみ）は、`app_config_dir` の `accounts.json` に保存されます。
「画像を表示」を押した送信者の一覧（メールアドレスのみ）は、同じ場所の `image_senders.json` に保存されます。覚えた送信者を外す画面はないので、外すにはアプリを終了してから、このファイルからそのアドレスを消してください。
Todoist に接続している場合は、取得したタスクとプロジェクトとラベルが、同じ場所の `todoist-cache.json` に保存されます（接続できないときの表示に使い、接続を解除すると消えます）。
表示した週の予定は、場所や説明などの詳細を含めて、同じ場所の `calendar-cache.json` に保存されます（起動直後の表示に使い、アカウントを削除すると消えます）。
週の始まりの曜日は、同じ場所の `calendar-settings.json` に保存されます。
表示するカレンダーの選択は、同じ場所の `calendar-selection.json` に保存されます（アカウントを削除すると、そのアカウントの分が消えます）。
Claude のモデルと effort は、用途ごとに、同じ場所の `claude-settings.json` に保存されます。
Claude Code の接続方式（サブスクリプションか API キーか）は、同じ場所の `claude-auth.json` に保存されます。API キーは OS の資格情報の保管場所に保存し、画面には出しません。
Todo の要約プロンプトを編集すると、編集した指示が同じ場所の `todo-prompt.json` に保存されます（デフォルトに戻すと消えます）。

## アプリとして入れる

`tauri dev` なしで起動できるように、アプリとして入れます。

### macOS の場合

`/Applications` に `cookapps.app` として入れます。
キーチェーンに Apple Development 証明書（Apple ID で作れる無料のもので足ります）が入っている前提です。

```sh
npm install
scripts/install-app.sh
```

スクリプトは `npx tauri build --bundles app` で `.app` を作り（手元の最新のタグがあれば、その版を `--config` で渡します）、署名を確かめてから `/Applications/cookapps.app` に置きます。
cookapps が起動中のときは、終了してからやり直します。
古い版はゴミ箱へ移します。
署名の証明書は、キーチェーンの最初の Apple Development 証明書を使います。
別の証明書を使うときは、環境変数 `APPLE_SIGNING_IDENTITY` に証明書の名前かハッシュを渡します。
`--no-install` を付けると、ビルドと署名の確認だけをして `/Applications` には置きません。

Developer ID での署名と公証はしていません。
自分のマシンで作った `.app` を、そのマシンで使う想定です。
`client_secret.json`、`accounts.json`、キーチェーンの保存先は `tauri dev` と同じなので、設定やログインはそのまま使えます。

### Windows の場合

NSIS のインストーラーを作り、実行して入れます。

ソースの版は固定の `0.0.0` で、版はタグだけが持ちます。
最新のタグの版を `--config` で渡します（次は `v0.55.2` の例です）。

```sh
npm ci
npx tauri build --bundles nsis --config '{"version":"0.55.2"}'
```

インストーラーは `src-tauri/target/release/bundle/nsis/` に `cookapps_{バージョン}_x64-setup.exe` として出ます。
コード署名はしていないので、実行すると Windows の SmartScreen が警告を出すことがあります。
`client_secret.json` は、セットアップの手順の場所（`%APPDATA%\jp.mysis.cookapps\`）に置きます。
