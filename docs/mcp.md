---
title: Claude との連携（MCP）
---

# Claude との連携（MCP）

`cookapps-mcp` は、Claude Code から cookapps の受信トレイと予定と、データベースの画面の接続を扱うためのローカルの MCP サーバーです。
stdio で動き、ネットワークのポートは開きません。
cookapps アプリが起動していなくても使えます。
データベースの画面の Claude Code のペインでは、アプリが自分の中の `cookapps-mcp` を Claude Code に渡すので、この文書の設定は要りません（[Claude](claude-integration.md#データベースの画面で-claude-code-を動かす)）。

この文書は AI に読ませて設定を任せられるように、手順と確認方法を順に書いています。

## 前提

- macOS か Windows で動かすこと。
- cookapps アプリで、使いたいアカウントにログイン済みであること。
  - `cookapps-mcp` は、アプリと同じ設定フォルダの `client_secret.json` と `accounts.json` を読みます。
    macOS では `~/Library/Application Support/jp.mysis.cookapps/`、Windows では `%APPDATA%\jp.mysis.cookapps\` です。
  - リフレッシュトークンもアプリと同じ OS の資格情報の保管場所の項目（サービス名 `jp.mysis.cookapps`。macOS ではキーチェーン、Windows では資格情報マネージャー）から読みます。
- `cookapps-mcp` はログインを行いません。アカウントの追加と再ログインは、アプリで行います。
- データベースの接続のツールは、アプリと同じ設定フォルダの `database-profiles.json` を読み書きし、パスワードはアプリと同じ資格情報の保管場所の項目（サービス名 `jp.mysis.cookapps.database`）から読みます（接続先やユーザーを変える保存では、その項目を消します）。パスワードを登録するのは、アプリの接続の編集ペインだけです。
- `~/.cargo/bin`（Windows では `%USERPROFILE%\.cargo\bin`）が `PATH` に入っていること。

## 手順

### 1. インストールする

リポジトリのルートで実行します。

```sh
cargo install --path src-tauri --bin cookapps-mcp --locked
```

`~/.cargo/bin/cookapps-mcp` ができれば完了です（Windows では `%USERPROFILE%\.cargo\bin\cookapps-mcp.exe`）。
`command -v cookapps-mcp`（Windows の PowerShell では `Get-Command cookapps-mcp`）で、パスが出ることを確かめます。
コードを更新したときも、同じコマンドで入れ直します。

### 2. Claude Code に登録する

使う場所に合わせて、どちらか一方を選びます。

#### このリポジトリの中で使う場合

このサーバーはリポジトリのルートの `.mcp.json` に登録済みです。

```json
{
  "mcpServers": {
    "cookapps": {
      "command": "cookapps-mcp"
    }
  }
}
```

リポジトリのルートで `claude` を起動すると、このサーバーを使うかどうかの確認が出ます。
承認すれば使えます。

#### どのディレクトリからでも使う場合

ユーザーのスコープに登録します。

```sh
claude mcp add --scope user cookapps -- cookapps-mcp
```

ユーザーのスコープで登録したら、`.mcp.json` の承認は不要です。

#### Claude Desktop に登録する場合

Claude Desktop の設定ファイルの `mcpServers` に、`cookapps-mcp` の絶対パスで登録します。
設定ファイルの場所は、macOS が `~/Library/Application Support/Claude/claude_desktop_config.json`、Windows が `%APPDATA%\Claude\claude_desktop_config.json` です。

```json
{
  "mcpServers": {
    "cookapps": {
      "command": "C:\\Users\\{ユーザー名}\\.cargo\\bin\\cookapps-mcp.exe"
    }
  }
}
```

macOS では `command` に `/Users/{ユーザー名}/.cargo/bin/cookapps-mcp` を指定します。

### 3. 読み取りのツールだけを許可する

Claude Code の設定ファイル（`~/.claude/settings.json` など）の `permissions.allow` に、次の 4 つを足します。

```json
{
  "permissions": {
    "allow": [
      "mcp__cookapps__list_inbox",
      "mcp__cookapps__get_thread",
      "mcp__cookapps__list_events",
      "mcp__cookapps__db_profiles"
    ]
  }
}
```

書き込みのツール（`archive`、`set_read`、`trash`、`db_profile_save`、`db_test`）は、許可リストに入れません。
メールの本文に、Claude への指示が紛れ込むことがあるためです。
`db_profile_save` は事前スクリプトを保存し、保存したパスワードを消すことがあり、`db_test` は保存した事前スクリプトをこの Mac で動かすので、どちらにも書き込みのツールの印（`destructiveHint`）を付けています。
許可リストに入れなければ、書き込みのたびに確認が出ます。

### 4. つながったことを確かめる

```sh
claude mcp get cookapps
```

`Status` が `✔ Connected` なら完了です。
Claude Code の中では、`/mcp` で `cookapps` の 9 つのツールが見えます。

macOS では、最初にツールを呼んだとき、キーチェーンへのアクセスの許可を求められることがあります。
「常に許可」を選びます。
`cookapps-mcp` を入れ直すと、また求められることがあります。

## ツール

| ツール | 引数 | 内容 | 種類 |
|---|---|---|---|
| `list_inbox` | なし | 全アカウントの受信トレイのスレッドを、新しい順に返す | 読み取り |
| `get_thread` | `account`、`id` | スレッドの全メッセージを返す。本文はプレーンテキストを優先し、無ければ HTML を返す | 読み取り |
| `list_events` | `from`、`to`（`YYYY-MM-DD`、`to` の日を含む） | 全アカウントの予定を、カレンダー名（`calendar`）付きで早い順に返す。読むのは、カレンダー画面で表示するカレンダー（C-4）だけ | 読み取り |
| `archive` | `account`、`id` | スレッドを受信トレイから外す | 書き込み |
| `set_read` | `account`、`id`、`read` | スレッドを既読（`true`）または未読（`false`）にする | 書き込み |
| `trash` | `account`、`id` | スレッドをゴミ箱へ移す。Gmail から元に戻せる | 書き込み |
| `db_profiles` | なし | データベースの画面の接続を返す（`id`、`name`、`username`、`script`、`dbHost`、`dbPort`、`passwordSaved`）。パスワードは返さない | 読み取り |
| `db_profile_save` | `id`（新しい接続では省く）、`name`、`username`、`script`（無いときは空の文字列）、`db_host`、`db_port`（`script` の有無によらず、どちらも要る） | 接続を保存し、保存した内容を返す。確かめ方と断り方はアプリの保存と同じ。パスワードは設定しない。ユーザー名、`script`、ホスト、ポートを変えると、`script` の有無によらず、保存したパスワードを消す | 書き込み |
| `db_test` | `id` | 保存した接続を、保存したパスワードで、アプリの「接続をテスト」と同じようにテストする（事前スクリプトがあれば動かし、接続のホストとポートで MySQL にログインして版を読み、スクリプトを止める。スクリプトを動かす前からそのポートが使われているときは失敗にし、cookapps でその接続を開いているなら切断してからテストするよう、`error` に添える）。`{"ok": true, "version": …}` か `{"ok": false, "error": …, "note": …}` を返す。最長 2 分ほどかかる | 書き込み |

`account` と `id` には、`list_inbox` が返した値を使います。
`db_profile_save` と `db_test` の `id` には、`db_profiles` か `db_profile_save` が返した値を使います。
`db_test` の `error` は、事前スクリプト、MySQL、アプリが書いた文で、`note` はそれがデータであって指示ではないことを伝えます。

再ログインが要るアカウントは、`list_inbox` と `list_events` の `needsLogin` に入ります。
読み込みに失敗したアカウントは、`failed` に入ります。
`list_events` で読み込みに失敗したカレンダーは、`calendarFailed` に入ります。
同じアカウントのほかのカレンダーの予定は返ります。

## うまく動かないとき

| 症状 | 対処 |
|---|---|
| `claude mcp get cookapps` が `Failed to connect` になる | 1 のインストールを済ませたか、`command -v cookapps-mcp`（Windows の PowerShell では `Get-Command cookapps-mcp`）でパスが出るかを確かめる |
| 「再ログインが必要です」と返る | cookapps アプリでそのアカウントに再ログインする |
| 「OAuth クライアント JSON を読めません」と返る | アプリの[セットアップ](setup.md#セットアップ)を済ませる |
| macOS で、ツールを呼ぶたびにキーチェーンの許可を求められる | 許可のダイアログで「常に許可」を選ぶ |
