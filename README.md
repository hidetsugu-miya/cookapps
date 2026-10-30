# cookup

Gmail 専用の、個人向けデスクトップクライアントです。
Tauri v2 と Rust で作っています。

## 機能

- 複数の Gmail アカウントを追加し、全アカウントの受信トレイを 1 つの一覧で表示する（未読を上、既読を下に分け、それぞれ新しい順）
- スレッドを開いて本文を表示する（日本語の文字コードと HTML メールに対応。メールに埋め込まれた画像は表示する。外部の画像は既定では読み込まず、メッセージの「画像を表示」を押したときだけ取得し、その送信者のアドレスを覚えて、以後はその送信者のメッセージの画像を自動で表示する。覚えた送信者は「この送信者の画像を自動で表示しない」で外せる。自動で取得するのは、Gmail が付けた認証結果（Authentication-Results）が DMARC 合格、または From のドメインと一致する DKIM 署名の合格のメッセージだけで、そうでないメッセージは覚えた送信者でも「画像を表示」を押すまで取得しない。未読のスレッドを開くと既読になる。本文のリンクを押すと、既定のブラウザで開く。複数のメッセージがあるスレッドでは、新しい順に並べ、最新のメッセージだけを一番上で開き、古いものは 1 行に畳んで、押すと開く）
- スレッドをアーカイブする・ゴミ箱へ移動する（詳細画面のボタン、または一覧の行にマウスを乗せると出るボタン）。直前の 1 件は Cmd+Z（Windows では Ctrl+Z）かお知らせの「元に戻す」で戻せる
- 一覧のチェックボックスで、スレッドを既読・未読にする（未読の行には水色の点が付く）
- サイドメニューのアカウントのアイコンから、そのアカウントを cookup から削除する（Google 側のアクセス権も取り消す。Gmail のメールは消えない）
- 約 10 秒ごとに受信トレイを Gmail と同期し、新着や他の端末での既読化・アーカイブを自動で反映する
- 未読のスレッドの件数を、サイドメニューの受信トレイのボタンに表示する（0 件のときは消える。macOS では Dock のアイコンのバッジにも表示する）
- 全アカウントの Google Calendar の予定を、1 つの週表示にまとめて表示する（閲覧のみ。サイドメニューのカレンダーのアイコンで開く）
- Todoist のタスクを、プロジェクト別と「今日」の一覧で表示し、完了・追加・編集（説明とサブタスクを含む）する。説明は Markdown で表示し、押すと編集して「保存」で登録する。「今日」で追加した、日付の無いタスクは期限が今日になる。期限は月のカレンダーから選べる。一覧の行にマウスを乗せると、詳細を開かずに名前・期限・プロジェクトを変えられ、行の左端をドラッグして左のプロジェクトへ移すこともできる。受信トレイのスレッドから「Todo にする」でタスクを作る。Todoist に接続できないときは、前回取得した内容を表示する（Todoist の個人 API トークンを使う。サイドメニューの Todo のアイコンで開き、今日の未完了の件数をそのアイコンに表示する）
- メールを Slack に貼る（詳細画面の「Slack に貼る」で、スレッドの最新のメッセージの件名・差出人・日時・本文を、貼るときに選んだチャンネルかスレッドに投稿する。宛先は、最近使った先、参加しているチャンネルの検索、Slack のリンクから選ぶ。ひとことを添えられる。複数のワークスペースを持て、トークンはサイドメニューの設定で追加する）
- 起動したときとカレンダーを開いたときは、前回取得した受信トレイ・予定・Todo を設定フォルダから先に表示し、取得が終わったら最新の内容に描き直す
- Claude Code から、受信トレイの一覧・閲覧・アーカイブ・既読化・ゴミ箱への移動と、予定の一覧を扱う（ローカルの MCP サーバー `cookup-mcp`。設定は [docs/mcp.md](docs/mcp.md)）

## 必要なもの

- Rust（stable）
- Node.js
- Windows では、Tauri の前提条件（Microsoft C++ Build Tools と WebView2）
- Gmail API と Google Calendar API を有効にした Google Cloud プロジェクト

## セットアップ

1. Google Cloud で Gmail API と Google Calendar API を有効にし、OAuth 同意画面を設定します。
2. 種類「デスクトップアプリ」の OAuth クライアントを作り、JSON をダウンロードします。
3. JSON を `client_secret.json` という名前で、Tauri の `app_config_dir` に置きます。
   - macOS では `~/Library/Application Support/jp.mysis.cookup/client_secret.json` です。
   - Windows では `%APPDATA%\jp.mysis.cookup\client_secret.json`（`C:\Users\{ユーザー名}\AppData\Roaming\jp.mysis.cookup\client_secret.json`）です。
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
リフレッシュトークンはアカウントごとに OS の資格情報の保管場所（macOS ではキーチェーン、Windows では資格情報マネージャー）へ保存されるので、次回からはログインが要りません。
アカウントの一覧（メールアドレスのみ）は、`app_config_dir` の `accounts.json` に保存されます。
「画像を表示」を押した送信者の一覧（メールアドレスのみ）は、同じ場所の `image_senders.json` に保存されます。
Todoist に接続している場合は、取得したタスクとプロジェクトが、同じ場所の `todoist-cache.json` に保存されます（接続できないときの表示に使い、接続を解除すると消えます）。

## Slack に貼る

ワークスペースごとに、社内向けの Slack アプリを作ります。
User Token Scopes に `chat:write`・`channels:read`・`groups:read` を付けてワークスペースにインストールし、発行された User OAuth Token（`xoxp-` で始まる）を、サイドメニュー下部の設定にある Slack の欄へ貼り付けます。
トークンは Slack に確かめてから、OS の資格情報の保管場所（macOS ではキーチェーン、Windows では資格情報マネージャー）に保存します。
ワークスペースはいくつでも追加でき、同じワークスペースのトークンを貼り直すと置き換わります。
ワークスペースの一覧は、`app_config_dir` の `slack-workspaces.json` に保存されます。
貼る先は、メールの詳細画面の「Slack に貼る」で、次のどれかから選びます。

- 最近使った先（貼れた宛先を新しい順に 8 件まで。`slack-recent.json` に保存されます）
- 選んだワークスペースで、トークンのユーザーが参加しているチャンネルの検索（一覧はアプリを閉じるまで覚え、10 分たつか「更新」を押すと取り直します）
- Slack のリンク。メッセージのリンク（`https://{ワークスペース}.slack.com/archives/{チャンネル ID}/p{数字}`）ならそのスレッドへの返信、チャンネルのリンク（`…/archives/{チャンネル ID}`）ならチャンネルへの新しい投稿になります。リンクのワークスペースは、そのホストから追加済みのものを探します（追加していなければ貼れません）

投稿するのは、「貼る」を押したときだけです。
トークンのユーザーが参加していないチャンネルには投稿できません。ダイレクトメッセージへの投稿もできません。

## アプリとして入れる

`tauri dev` なしで起動できるように、アプリとして入れます。

### macOS の場合

`/Applications` に `cookup.app` として入れます。
キーチェーンに Apple Development 証明書（Apple ID で作れる無料のもので足ります）が入っている前提です。

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

### Windows の場合

NSIS のインストーラーを作り、実行して入れます。

```sh
npm ci
npx tauri build --bundles nsis
```

インストーラーは `src-tauri/target/release/bundle/nsis/` に `cookup_{バージョン}_x64-setup.exe` として出ます。
GitHub Actions の CI（windows-latest）も、タグ（`v*`）の push のたびに同じインストーラーを作り、成果物 `cookup-windows-installer` として残します。
コード署名はしていないので、実行すると Windows の SmartScreen が警告を出すことがあります。
`client_secret.json` は、セットアップの手順の場所（`%APPDATA%\jp.mysis.cookup\`）に置きます。

## Claude との連携

Claude Code から受信トレイと予定を扱う MCP サーバー `cookup-mcp` があります。
設定の手順は [docs/mcp.md](docs/mcp.md) にあります。

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
