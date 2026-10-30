---
title: Claude との連携（MCP）
---

# Claude との連携（MCP）

`cookup-mcp` は、Claude Code から cookup の受信トレイと予定を扱うためのローカルの MCP サーバーです。
stdio で動き、ネットワークのポートは開きません。
cookup アプリが起動していなくても使えます。

この文書は AI に読ませて設定を任せられるように、手順と確認方法を順に書いています。

## 前提

- macOS か Windows で動かすこと。
- cookup アプリで、使いたいアカウントにログイン済みであること。
  - `cookup-mcp` は、アプリと同じ設定フォルダの `client_secret.json` と `accounts.json` を読みます。
    macOS では `~/Library/Application Support/jp.mysis.cookup/`、Windows では `%APPDATA%\jp.mysis.cookup\` です。
  - リフレッシュトークンもアプリと同じ OS の資格情報の保管場所の項目（サービス名 `jp.mysis.cookup`。macOS ではキーチェーン、Windows では資格情報マネージャー）から読みます。
- `cookup-mcp` はログインを行いません。アカウントの追加と再ログインは、アプリで行います。
- `~/.cargo/bin`（Windows では `%USERPROFILE%\.cargo\bin`）が `PATH` に入っていること。

## 手順

### 1. インストールする

リポジトリのルートで実行します。

```sh
cargo install --path src-tauri --bin cookup-mcp --locked
```

`~/.cargo/bin/cookup-mcp` ができれば完了です（Windows では `%USERPROFILE%\.cargo\bin\cookup-mcp.exe`）。
`command -v cookup-mcp`（Windows の PowerShell では `Get-Command cookup-mcp`）で、パスが出ることを確かめます。
コードを更新したときも、同じコマンドで入れ直します。

### 2. Claude Code に登録する

使う場所に合わせて、どちらか一方を選びます。

#### このリポジトリの中で使う場合

このサーバーはリポジトリのルートの `.mcp.json` に登録済みです。

```json
{
  "mcpServers": {
    "cookup": {
      "command": "cookup-mcp"
    }
  }
}
```

リポジトリのルートで `claude` を起動すると、このサーバーを使うかどうかの確認が出ます。
承認すれば使えます。

#### どのディレクトリからでも使う場合

ユーザーのスコープに登録します。

```sh
claude mcp add --scope user cookup -- cookup-mcp
```

ユーザーのスコープで登録したら、`.mcp.json` の承認は不要です。

#### Claude Desktop に登録する場合

Claude Desktop の設定ファイルの `mcpServers` に、`cookup-mcp` の絶対パスで登録します。
設定ファイルの場所は、macOS が `~/Library/Application Support/Claude/claude_desktop_config.json`、Windows が `%APPDATA%\Claude\claude_desktop_config.json` です。

```json
{
  "mcpServers": {
    "cookup": {
      "command": "C:\\Users\\{ユーザー名}\\.cargo\\bin\\cookup-mcp.exe"
    }
  }
}
```

macOS では `command` に `/Users/{ユーザー名}/.cargo/bin/cookup-mcp` を指定します。

### 3. 読み取りのツールだけを許可する

Claude Code の設定ファイル（`~/.claude/settings.json` など）の `permissions.allow` に、次の 3 つを足します。

```json
{
  "permissions": {
    "allow": [
      "mcp__cookup__list_inbox",
      "mcp__cookup__get_thread",
      "mcp__cookup__list_events"
    ]
  }
}
```

書き込みのツール（`archive`、`set_read`、`trash`）は、許可リストに入れません。
メールの本文に、Claude への指示が紛れ込むことがあるためです。
許可リストに入れなければ、書き込みのたびに確認が出ます。

### 4. つながったことを確かめる

```sh
claude mcp get cookup
```

`Status` が `✔ Connected` なら完了です。
Claude Code の中では、`/mcp` で `cookup` の 6 つのツールが見えます。

macOS では、最初にツールを呼んだとき、キーチェーンへのアクセスの許可を求められることがあります。
「常に許可」を選びます。
`cookup-mcp` を入れ直すと、また求められることがあります。

## ツール

| ツール | 引数 | 内容 | 種類 |
|---|---|---|---|
| `list_inbox` | なし | 全アカウントの受信トレイのスレッドを、新しい順に返す | 読み取り |
| `get_thread` | `account`、`id` | スレッドの全メッセージを返す。本文はプレーンテキストを優先し、無ければ HTML を返す | 読み取り |
| `list_events` | `from`、`to`（`YYYY-MM-DD`、`to` の日を含む） | 全アカウントの予定を、カレンダー名（`calendar`）付きで早い順に返す | 読み取り |
| `archive` | `account`、`id` | スレッドを受信トレイから外す | 書き込み |
| `set_read` | `account`、`id`、`read` | スレッドを既読（`true`）または未読（`false`）にする | 書き込み |
| `trash` | `account`、`id` | スレッドをゴミ箱へ移す。Gmail から元に戻せる | 書き込み |

`account` と `id` には、`list_inbox` が返した値を使います。

再ログインが要るアカウントは、`list_inbox` と `list_events` の `needsLogin` に入ります。
読み込みに失敗したアカウントは、`failed` に入ります。
`list_events` で読み込みに失敗したカレンダーは、`calendarFailed` に入ります。
同じアカウントのほかのカレンダーの予定は返ります。

## うまく動かないとき

| 症状 | 対処 |
|---|---|
| `claude mcp get cookup` が `Failed to connect` になる | 1 のインストールを済ませたか、`command -v cookup-mcp` でパスが出るかを確かめる |
| 「再ログインが必要です」と返る | cookup アプリでそのアカウントに再ログインする |
| 「OAuth クライアント JSON を読めません」と返る | アプリの [README](https://github.com/hidetsugu-miya/cookup#セットアップ) のセットアップを済ませる |
| macOS で、ツールを呼ぶたびにキーチェーンの許可を求められる | 許可のダイアログで「常に許可」を選ぶ |
