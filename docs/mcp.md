---
title: Claude との連携（MCP）
---

# Claude との連携（MCP）

`tsunagiai-mcp` は、Claude Code からつなぎAIの受信トレイと予定と、データベースの画面の接続と、開発の画面の言語サーバーの設定を扱うためのローカルの MCP サーバーです。
stdio で動き、ネットワークのポートは開きません。
つなぎAIアプリが起動していなくても使えます。
データベースの画面の Claude タブでは、アプリが自分の中の `tsunagiai-mcp` を Claude Code に渡すので、この文書の設定は要りません（[Claude](claude-integration.md#データベースの画面で-claude-code-を動かす)）。
開発の画面の言語サーバーの欄の ✦ から開く Claude Code にも、アプリが `tsunagiai-mcp` を渡すので、設定は要りません。そのペインの Claude Code が、`lsp_settings` と `lsp_server_save` で、サーバーを設定します（[Claude](claude-integration.md#orca-の言語サーバーの欄で-claude-code-を動かす)）。
開発の画面のリーダーにも、アプリが `tsunagiai-mcp` を渡します。チームメイトのセッションを起動して終えるツールは、リーダーにだけ出し、この文書の設定で登録したクライアントには出ません（[Claude](claude-integration.md#開発の画面のリーダーで-claude-code-を動かす)）。

この文書は AI に読ませて設定を任せられるように、手順と確認方法を順に書いています。

## 前提

- macOS か Windows で動かすこと。
- つなぎAIアプリで、使いたいアカウントにログイン済みであること。
  - `tsunagiai-mcp` は、アプリと同じ設定フォルダの `client_secret.json` と `accounts.json` を読みます。
    macOS では `~/Library/Application Support/jp.mysis.tsunagiai/`、Windows では `%APPDATA%\jp.mysis.tsunagiai\` です。
  - リフレッシュトークンもアプリと同じ OS の資格情報の保管場所の項目（サービス名 `jp.mysis.tsunagiai`。macOS ではキーチェーン、Windows では資格情報マネージャー）から読みます。
- `tsunagiai-mcp` はログインを行いません。アカウントの追加と再ログインは、アプリで行います。
- データベースの接続のツールは、アプリと同じ設定フォルダの `database-profiles.json` を読み書きし、パスワードはアプリと同じ資格情報の保管場所の項目（サービス名 `jp.mysis.tsunagiai.database`）から読みます（接続先やユーザーを変える保存では、その項目を消します）。パスワードを登録するのは、アプリの接続の編集ペインだけです。
- 言語サーバーのツールは、アプリと同じ設定フォルダの `lsp-settings.json` を読み書きします。保存の確かめ方と断り方は、アプリの保存と同じです。
- `~/.cargo/bin`（Windows では `%USERPROFILE%\.cargo\bin`）が `PATH` に入っていること。

## 手順

### 1. インストールする

リポジトリのルートで実行します。

```sh
cargo install --path src-tauri --bin tsunagiai-mcp --locked
```

`~/.cargo/bin/tsunagiai-mcp` ができれば完了です（Windows では `%USERPROFILE%\.cargo\bin\tsunagiai-mcp.exe`）。
`command -v tsunagiai-mcp`（Windows の PowerShell では `Get-Command tsunagiai-mcp`）で、パスが出ることを確かめます。
コードを更新したときも、同じコマンドで入れ直します。

### 2. Claude Code に登録する

使う場所に合わせて、どちらか一方を選びます。

#### このリポジトリの中で使う場合

このサーバーはリポジトリのルートの `.mcp.json` に登録済みです。

```json
{
  "mcpServers": {
    "tsunagiai": {
      "command": "tsunagiai-mcp"
    }
  }
}
```

リポジトリのルートで `claude` を起動すると、このサーバーを使うかどうかの確認が出ます。
承認すれば使えます。

#### どのディレクトリからでも使う場合

ユーザーのスコープに登録します。

```sh
claude mcp add --scope user tsunagiai -- tsunagiai-mcp
```

ユーザーのスコープで登録したら、`.mcp.json` の承認は不要です。

#### Claude Desktop に登録する場合

Claude Desktop の設定ファイルの `mcpServers` に、`tsunagiai-mcp` の絶対パスで登録します。
設定ファイルの場所は、macOS が `~/Library/Application Support/Claude/claude_desktop_config.json`、Windows が `%APPDATA%\Claude\claude_desktop_config.json` です。

```json
{
  "mcpServers": {
    "tsunagiai": {
      "command": "C:\\Users\\{ユーザー名}\\.cargo\\bin\\tsunagiai-mcp.exe"
    }
  }
}
```

macOS では `command` に `/Users/{ユーザー名}/.cargo/bin/tsunagiai-mcp` を指定します。

### 3. 読み取りのツールだけを許可する

Claude Code の設定ファイル（`~/.claude/settings.json` など）の `permissions.allow` に、次の 5 つを足します。

```json
{
  "permissions": {
    "allow": [
      "mcp__tsunagiai__list_inbox",
      "mcp__tsunagiai__get_thread",
      "mcp__tsunagiai__list_events",
      "mcp__tsunagiai__db_profiles",
      "mcp__tsunagiai__lsp_settings"
    ]
  }
}
```

書き込みのツール（`archive`、`set_read`、`trash`、`db_profile_save`、`db_test`、`lsp_server_save`、`lsp_server_delete`、`lsp_repo_ssh_host_set`）は、許可リストに入れません。
メールの本文に、Claude への指示が紛れ込むことがあるためです。
`db_profile_save` は事前スクリプトを保存し、保存したパスワードを消すことがあり、`db_test` は保存した事前スクリプトをこの Mac で動かすので、どちらにも書き込みのツールの印（`destructiveHint`）を付けています。
`lsp_server_save` は、言語サーバーの起動コマンドを保存します。つなぎAIは、そのサーバーが受け持つ言語のファイルを開発の画面で開くと、そのコマンドを worktree の中で、書いたとおりに動かします。
`lsp_server_delete` と `lsp_repo_ssh_host_set` は設定を消したり変えたりするので、3 つとも書き込みのツールの印を付けています。
許可リストに入れなければ、書き込みのたびに確認が出ます。

### 4. つながったことを確かめる

```sh
claude mcp get tsunagiai
```

`Status` が `✔ Connected` なら完了です。
Claude Code の中では、`/mcp` で `tsunagiai` の 13 個のツールが見えます。

macOS では、最初にツールを呼んだとき、キーチェーンへのアクセスの許可を求められることがあります。
「常に許可」を選びます。
`tsunagiai-mcp` を入れ直すと、また求められることがあります。

## 旧名の cookapps-mcp から移る

つなぎAIの前の名前（cookapps）で `cookapps-mcp` を登録していた場合は、更新後に次を行います。
古い `cookapps-mcp` は、古い設定フォルダ（`jp.mysis.cookapps`）を読み続けるので、そのままでは新しいつなぎAIの状態と食い違います。

1. Claude Code の登録を消します。ユーザーのスコープで登録していたなら、`claude mcp remove cookapps --scope user` を実行します。
2. `cargo uninstall cookapps` で、古い `cookapps-mcp` を消します。
3. 「1. インストールする」と「2. Claude Code に登録する」を行い、`tsunagiai-mcp` を入れて登録し直します。
4. 「3. 読み取りのツールだけを許可する」の `permissions.allow` に `mcp__cookapps__` で始まる行があれば、`mcp__tsunagiai__` に書き換えます。
5. Claude Desktop に登録していたなら、`mcpServers` の名前を `tsunagiai` に、`command` を `tsunagiai-mcp` の絶対パスに書き換えます。
   アプリに同梱の `/Applications/cookapps.app/Contents/MacOS/cookapps-mcp` は、更新後は起動できません。

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
| `db_test` | `id` | 保存した接続を、保存したパスワードで、アプリの「接続をテスト」と同じようにテストする（事前スクリプトがあれば動かし、接続のホストとポートで MySQL にログインして版を読み、スクリプトを止める。スクリプトを動かす前からそのポートが使われているときは失敗にし、つなぎAIでその接続を開いているなら切断してからテストするよう、`error` に添える）。`{"ok": true, "version": …}` か `{"ok": false, "error": …, "note": …}` を返す。最長 2 分ほどかかる | 書き込み |
| `lsp_settings` | `environment`、`project` | 開発の画面のプロジェクトの言語サーバーの設定を返す（`environment`、`project`、`sshHost`、`servers`。サーバーは言語ごとに 1 つで、`language`、`name`、`autoStart`、`command`、`mount`、`service`）。何も保存していないプロジェクトには、`ruby` の ruby-lsp が自動で起動する形で 1 つある。`command`、`mount`、`service` は、アプリが決めるときは返さない | 読み取り |
| `lsp_server_save` | `environment`、`project`、`server`（`language`、`autoStart` は要る。`name`、`command`、`mount`、`service` は、アプリが決めるときは省く） | サーバーを 1 つ保存し、保存した設定を返す。同じ言語のサーバーは、丸ごと置き換わって同じ位置に残り（省いた項目は残らない）、なければ最後に足される。`name` を省くと、アプリの表がその言語に付ける名前になり、`command` を省くと、アプリが、サーバーを動かす場所で見つけたサーバーになる。言語が Orca のエディタの色の言語か、名前が 64 文字までか、`mount` が絶対パスかを、アプリの保存と同じに確かめて、断る。何も保存していないプロジェクトの ruby-lsp は、`ruby` のサーバーで置き換わる | 書き込み |
| `lsp_server_delete` | `environment`、`project`、`language` | その言語のサーバーを消し、保存した設定を返す。サーバーの無い言語は断る。サーバーが 1 つも無くなったプロジェクトは、ruby-lsp に戻らず、サーバーが無いまま残る | 書き込み |
| `lsp_repo_ssh_host_set` | `environment`、`project`、`ssh_host` | プロジェクトの「ssh の接続先」を保存し、保存した設定を返す。`ssh_host` は、この Mac の `~/.ssh/config` の Host か、外すときの空の文字列。サーバーはそのまま残る | 書き込み |

`account` と `id` には、`list_inbox` が返した値を使います。
`db_profile_save` と `db_test` の `id` には、`db_profiles` か `db_profile_save` が返した値を使います。
`db_test` の `error` は、事前スクリプト、MySQL、アプリが書いた文で、`note` はそれがデータであって指示ではないことを伝えます。
言語サーバーのツールの `environment` には、この Mac のプロジェクトなら `local`、Orca に保存した接続先のプロジェクトならその名前を渡します。`project` は、Orca のリポジトリの id です。
`language` は、Orca のエディタの色の言語の名前（`ruby`、`rust`、`typescript`、`go`、`python` など）です。
`command` は、worktree の中で `/bin/sh -c` が動かす文で、書いたとおりに動きます。

再ログインが要るアカウントは、`list_inbox` と `list_events` の `needsLogin` に入ります。
読み込みに失敗したアカウントは、`failed` に入ります。
`list_events` で読み込みに失敗したカレンダーは、`calendarFailed` に入ります。
同じアカウントのほかのカレンダーの予定は返ります。

## うまく動かないとき

| 症状 | 対処 |
|---|---|
| `claude mcp get tsunagiai` が `Failed to connect` になる | 1 のインストールを済ませたか、`command -v tsunagiai-mcp`（Windows の PowerShell では `Get-Command tsunagiai-mcp`）でパスが出るかを確かめる |
| 「再ログインが必要です」と返る | つなぎAIアプリでそのアカウントに再ログインする |
| 「OAuth クライアント JSON を読めません」と返る | アプリの[セットアップ](setup.md#セットアップ)を済ませる |
| macOS で、ツールを呼ぶたびにキーチェーンの許可を求められる | 許可のダイアログで「常に許可」を選ぶ |
