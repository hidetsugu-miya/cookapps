<p align="center">
  <img src="src-tauri/icons/icon.png" alt="cookapps" width="96" />
</p>

<h1 align="center">cookapps</h1>

<p align="center">
  <strong>届いた連絡を、その場で Claude の仕事に。</strong><br />
  Gmail、カレンダー、Todo、Slack と Claude のセッションを、1 つのウィンドウに。
</p>

<p align="center">
  <a href="https://github.com/hidetsugu-miya/cookapps/releases/latest"><img src="https://img.shields.io/github/v/release/hidetsugu-miya/cookapps?color=1e7b52&label=release" alt="最新の版" /></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-1e7b52" alt="macOS Apple Silicon" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1e7b52" alt="MIT ライセンス" /></a>
  <img src="https://img.shields.io/badge/built%20with-Tauri%20%2B%20Rust-1e7b52" alt="Tauri と Rust で作成" />
</p>

<h3 align="center">
  <a href="#インストール">インストール</a> ・ <a href="docs/features.md">機能</a> ・ <a href="#ドキュメント">ドキュメント</a>
</h3>

<p align="center">
  <img src="docs/assets/readme/handoff.png" alt="メールを開いたまま、右のペインで Claude に調査と修正を頼んでいる画面" width="960" />
</p>

## メールから、そのまま仕事を頼む

メール、Slack のスレッド、Todo を開いたまま、横のペインに指示を書きます。
書いた指示はそのまま、元の内容は Claude が要約して添えて、Orca の新しいセッションを起動します。
渡す先の worktree は、既存のものから選ぶか、作成元とブランチを選んで新しく作れます。

## 動いている Claude を、ここで見守る

対応が要るセッションは件数で、作業中はアイコンの点滅で分かります。
右のペインはセッションのターミナルで、そのまま打ち込めます。
渡した直後は、メールや Todo の横の「Orca に渡す」ペインに、そのセッションのターミナルが出ます。
[Orca](docs/orca.md) で動くセッションを、ウィンドウを切り替えずに扱えます。

<p align="center">
  <img src="docs/assets/readme/orca.png" alt="検索欄とプロジェクトの一覧、開いたプロジェクトのセッションと、タブが並ぶ画面" width="960" />
</p>

## 連絡と予定を、1 つの画面で

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>受信トレイ</strong><br />
      複数の Gmail アカウントを 1 つの一覧に。アーカイブもゴミ箱もワンクリックで。<br /><br />
      <img src="docs/assets/readme/inbox.png" alt="2 つのアカウントのメールが並ぶ受信トレイ" />
    </td>
    <td width="50%" valign="top">
      <strong>カレンダー</strong><br />
      全アカウントの予定を 1 つの週表示に。Meet にもすぐ入れます。<br /><br />
      <img src="docs/assets/readme/calendar.png" alt="週表示のカレンダーと予定の詳細" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Todo</strong><br />
      Todoist のタスクを、期限が来たものから順に。メールからも、右のペインの Claude に頼んでも作れます。<br /><br />
      <img src="docs/assets/readme/todo.png" alt="今日のタスクの一覧と、右の Claude のペイン" />
    </td>
    <td width="50%" valign="top">
      <strong>Slack</strong><br />
      チャンネルをサイドメニューに並べ、未読はチャンネルごとにまとめて「既読に設定」で片づけます。履歴の表示と投稿もできます。<br /><br />
      <img src="docs/assets/readme/slack.png" alt="サイドメニューにワークスペースとチャンネルが並び、未読がチャンネルごとにまとまった Slack の画面" />
    </td>
  </tr>
</table>

## データは、あなたのマシンに

- cookapps にサーバーはありません。Gmail や Slack とは、あなたのマシンが直接話します。
- ログインの情報は OS のキーチェーンに保存します。
- Claude に内容を送るのは、あなたがボタンを押したときだけです。
- ソースコードはすべて公開しています。

詳しくは[プライバシーポリシー](docs/privacy/index.md)をご覧ください。

## インストール

macOS（Apple Silicon）のターミナルで実行します。

```sh
curl -fsSL https://github.com/hidetsugu-miya/cookapps/releases/latest/download/cookapps.app.tar.gz | tar xz -C /Applications
```

Apple の公証を受けていないので、ブラウザでダウンロードしたものは macOS に止められます。

最初に Google Cloud で OAuth クライアントを作り、`client_secret.json` を置きます（[手順](docs/setup.md#セットアップ)）。
以後の更新は、アプリの中のボタンから行えます。

## 対応しているもの

| | |
|---|---|
| OS | macOS（Apple Silicon） |
| メール | Gmail のみ。送信と返信はできません |
| Claude の機能 | [Claude Code](docs/claude-integration.md) と [Orca](docs/orca.md) が必要です。なくても、メール、カレンダー、Todo、Slack は使えます |
| 連携 | Google Calendar（閲覧のみ）、Todoist、Slack |

## ドキュメント

| | |
|---|---|
| [機能の一覧](docs/features.md) | できることのすべて |
| [セットアップと起動](docs/setup.md) | OAuth クライアントの作り方、ソースからの起動 |
| [Slack](docs/slack.md) | ワークスペースの追加、未読とチャンネルの履歴、投稿、要約 |
| [Orca](docs/orca.md) | セッションの一覧、ターミナル、Claude への渡し方 |
| [Claude](docs/claude-integration.md) | 要約、接続方式、モデルの選び方 |
| [MCP サーバー](docs/mcp.md) | Claude Code から受信トレイと予定を扱う |

## ライセンス

[MIT](LICENSE)

役に立ったら、スターをもらえると励みになります。
