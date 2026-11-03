# cookapps

cookapps is a personal desktop client for Gmail.
It also shows Google Calendar, Todoist and Slack, and it has a local MCP server.
It is built with Tauri v2 and Rust.

This file is the developer guide.
User-facing text is in `README.md` and `docs/`.

## Scope

- The only user is the owner.
- Only Gmail accounts are supported.
- Other mail providers (generic IMAP, Outlook and so on) are out of scope.
- Calendar, Todoist and Slack are integrations around the mail client.
- The app updates itself on macOS (Apple Silicon) only.
- Notion is a planned integration.

## Requirements

### Mail

| ID | Feature | What it does |
|----|---------|--------------|
| M-1 | List | Show the threads in the inbox, split into unread and read, each sorted newest first |
| M-2 | Read | Open a thread and show its body |
| M-3 | Delete | Move a thread to the trash |
| M-4 | Archive | Remove the `INBOX` label from a thread |
| M-5 | Multiple accounts | Show the inboxes of several Gmail accounts together |
| M-6 | Mark read | Mark a thread read or unread with the checkbox in the list |
| M-7 | Auto sync | Sync the inbox with Gmail about every 10 seconds |
| M-8 | AI summary | In the mail detail, an icon summarizes the thread with the Claude Code CLI (`claude -p`, the model and effort of A-2 with sonnet and medium as the default, no tools, no MCP, no settings) and shows a short list of points, in Japanese, on a card under the subject. Only pressing the icon sends the subject and, of each message, the sender, the date and the text (newest first, up to 10,000 characters, the oldest dropped first). The summary is kept in memory per thread (and its latest message), never saved, and shown again without sending when the card is closed and reopened. The icon is shown only while Claude can be used (logged in, or an API key that is not refused, A-4) |

### Calendar

| ID | Feature | What it does |
|----|---------|--------------|
| C-1 | View | Show the events of Google Calendar (read-only) |
| C-2 | Event detail | Press an event of the week (timed or all-day) and a popover beside it shows the color dot, the title, the time, a "Meet に参加" button with the URL and a copy button (only for a `https://meet.google.com/` link, from `hangoutLink`), the place, the description (HTML turned into text, links kept), the number of invited people (rooms left out) with how many accepted, the calendar and account, and the user's own answer. Nothing is fetched on a press: the detail comes with the week and is kept with it in `calendar-cache.json` (no name or address of an attendee is fetched). Another event switches it, the same one, ✕, Escape, a click elsewhere, a scroll, a resize, a week change or a screen change closes it, and a background redraw of the week keeps it open on the same event |
| C-3 | First day of the week | The settings screen has a "カレンダー" tab where the first day of the week is chosen from Sunday to Saturday (the default is Sunday). It is saved in `calendar-settings.json` in the app config directory and the calendar draws its weeks from that day |

### Tasks

| ID | Feature | What it does |
|----|---------|--------------|
| T-1 | Todoist | Work with Todoist tasks in per-project and today lists and a detail view (description, subtasks, and a three-dot menu to copy the task link or the description, or delete it; the description can also be copied by selecting its text, which does not start editing, or with an icon shown on hover), and create a task from a mail. Authentication is a personal API token, and the settings screen shows the connection and unlinks it |
| T-2 | Nest and unnest tasks | In the task list (a project's list and the flat "today" list), drag the grip at the left end of a row (pointer events) onto another task's row to make the dragged task, with its own subtasks, the last subtask of that task (`todoist_move_under`, which sends `parent_id` to `POST /tasks/{id}/move`). The row under the pointer is marked while it can take the drop; the task itself, a task below it and its current parent cannot. The parent opens so the moved row shows. A subtask is made a top-level task again with the "親タスクから外す" button of its row, or by dropping it on the project it is in in the side list (`todoist_move` with its current project ID, which Todoist makes the last top-level task of that project). The screen changes first and a failure is undone by the reload, as for the other task changes; the depth limit is not checked on the screen, Todoist's error is shown |

### Slack

| ID | Feature | What it does |
|----|---------|--------------|
| S-1 | Paste a mail into Slack | From the mail detail, the "Slack に貼る" button opens a screen of its own (not a popover) with the text to post in an edit field. The field starts as the subject, sender, date and body of the latest message (the body cut at 3,000 characters), and what is posted, under your own name, is the text in the field as the user edited it (`*` stays bold; blank or past 10,000 characters is refused). There is no separate note. The destination is chosen on the screen with a chip that opens the picker (the workspace, recent destinations, joined channels with a search, or a channel or thread link); none is chosen by itself, and "貼る" is enabled only with a destination and a non-blank text. "元の内容に戻す" (pressed twice) puts the starting text back. A post closes the screen, discards the draft and returns to the mail detail with a notice; a failure shows the error and keeps the text. "メールに戻る" returns to the mail detail (nothing is fetched again, the scroll position is restored), and the draft (text, destination and conversation of S-4) is kept in memory for one mail at a time, keyed by the thread and its latest message, so reopening the same mail finds it and another mail starts anew. You can have several workspaces. Authentication is a User OAuth Token per workspace (scopes `chat:write`, `channels:read`, `groups:read`); a Bot User OAuth Token (`xoxb-`) is refused when it is registered, and one already stored shows the same message in settings |
| S-2 | Summarize a Slack message into a Todo | Paste the URL of a Slack message into the Todo add field. cookapps fetches the whole thread of the message (`conversations.replies`, 200 messages a page, at most 20 pages, for a link to a reply as well as to the first message; a blank message is skipped except the linked one, a message a later page repeats is read once, a message's lines after the first are indented by two spaces so that nothing in a text can pass as a heading or a sender, and a later page that cannot be read ends the read there; a linked message past the page cap is read on its own, and the replies the cap or that failure left unread count as omitted, at least one unless only the linked reply was left, which was read on its own and counted by the thread's reply count), summarizes it with the Claude Code CLI (`claude -p`, the model and effort of A-2 with sonnet and medium as the default, no tools, no MCP, no settings), and shows the result on a card above the list. A thread whose lines, with their headings, fit 10,000 characters is sent whole in one call. A thread of one message that does not fit with its heading is that message alone, cut to 10,000 characters with its heading and the note below. A longer thread is split: the first message (2,000 characters at most; none when the thread's own message was blank) and the linked message (4,000 characters at most) and the latest replies (whole messages from the newest back, 3,000 characters; a single newer message over that is cut to it) go as they are, and the rest is grouped, from the newest back and at message boundaries, into chunks of at most 10,000 characters (at most 5, the ones nearest the end of the thread; a message over that is cut to it), each summarised by its own `claude -p` call (one at a time, the newest chunk first, with the same model and effort, a fixed Japanese instruction rather than the editable body of S-3, and the key points as the answer, as for M-8). The points reach the final call, at most 3,000 characters and never so many that the input passes 10,000, under "[途中の N 件の要点]" between the first message and the linked one (at the very start when the first message sent is one of the latest replies, so that it never comes between them; what a chunk leaves of its share of the characters goes to the chunks after it); the sections are headed "[スレッドの最初のメッセージ]", "[対象のメッセージ]" (what the task is about) and "[最新の返信]" (the present state), and "[スレッドの返信]" in a thread sent whole (its replies after the linked message show the present state too). When replies were left unread (the end of the thread was not read), the last message sent is followed by one fixed indented line ("（これより新しい返信は読めていません）"), so that the last message read is not taken for the end of the thread (if the line would pass 10,000 characters, that message is cut by the excess first). Every message that is cut, whichever part it is (first, linked, latest or a chunk's), is followed by one fixed indented line ("（このメッセージは長いため、ここで切っています。続きは読めていません）") in the text sent to Claude, and the whole stays within 10,000 characters. The chunk calls together have a time budget of 180 seconds, and only one chunk call runs at a time over all summaries (a slot of the two `claude -p` slots is left for M-8, S-3 and S-4): the wait for that one slot is part of the budget and a chunk that cannot get it before less than 30 seconds of the budget are left fails; no chunk starts with less than 30 seconds of the budget left, and the chunk running is cut off at it (a call never runs longer than the time limit of one call, A-2). The wait for a `claude -p` slot inside a call (60 seconds) is not part of the budget, so a chunk may end up to 60 seconds after it. A chunk that fails or is cut off is logged (never its text), stops the chunks still to run (a stalled network or a refused login would fail them all), and the summary goes on to the final call. The messages of a chunk that failed or did not run count as omitted; a failure of the final call is an error. `omitted` of the summary (the unread replies, the chunks left out and the failed ones; set by Rust only, never read from the model's answer) shows on the card as "N 件のメッセージは要約に含まれていません" when above 0, and is not sent on to `todoist_add_from_slack`. When the linked message is cut (at 4,000 characters in a split thread, or to fit a thread of one message), `targetCut` of the summary (set by Rust only, never read from the model's answer, and not sent on to `todoist_add_from_slack` either) shows on the card as "対象のメッセージは長いため、先頭だけを要約しました". The ID and name of every Todoist project (from the last sync) go to Claude with the thread, and it names the one that fits best (only an ID in that list is kept). The card holds the task name, a description (a short bullet list of the key points), a due date and the project (Claude's recommendation at first, tagged "推奨" on the chip and on its row in the project menu, else the current one), and all of them can be edited: the due chip opens the same popover as a task's detail (a text field for Todoist's natural language, and a month to pick a day from, which keeps the time), and nothing is saved by it; the source workspace is shown, and the message link, which cannot be edited, is put at the end of the description. Nothing is created until the user presses "Add" on the card, which adds the Todoist task; "Discard" closes the card and creates nothing. The Slack token also needs `channels:history`, `groups:history`, `im:history` and `mpim:history` (the last two for DM and group DM links). The Claude connection (A-4: the account of the subscription, or the API key) is shown in the side menu and in settings |
| S-3 | Edit the Todo summary prompt | The prompt of S-2 has a fixed part (the instruction to treat the message as untrusted data, how the message is enclosed, how the thread's headings and indented lines are read, today's date and the project list, and, after the body, the instruction not to choose the project or the due date because the message asks; it cannot be edited) and a body (how to write the name, description, due date and project, and the Japanese writing rules). The body is shown and edited on its own screen, opened from the Claude icon in the heading of the Todo list (shown in a list only, not in a task's detail or the token form; its label and tooltip are "Todo の要約プロンプトを確認・編集"), from the "Todo の要約プロンプト" row of the Claude tab in settings (shown whether or not Claude can be used) or from the "プロンプトを編集" link on the summary card, and "戻る" returns to where it was opened. While the screen is open, the side menu still points at the settings. Saving writes it to `todo-prompt.json` in the app config directory (saving the default body removes the file; an empty body or one over 10,000 characters is refused), and the next summary uses it. "デフォルトに戻す" removes the file. In a conversation with Claude (`claude -p`, the model and effort of the prompt conversation of A-2 with sonnet and medium as the default, no tools, no MCP, no settings) the user asks for a change; the reply is a short Japanese message and, when the body changes, a line diff with "適用" and "却下". The request is typed in a field that starts one line high and grows with its text up to 6 lines (then it scrolls), the pane's bottom staying put, with the model and effort selects of the prompt conversation (the same values as the Claude tab of settings, short texts such as "Sonnet" and "medium", no frame, right-aligned) under it, loaded when the screen opens so a way in from Todo shows them too (the Slack compose screen of S-4 has none); Enter is a line break, and Cmd+Enter (Ctrl+Enter off macOS) or the send button sends, with a hint saying so; a request of several lines keeps its line breaks in the conversation. A "クリア" button at the right end of the conversation header, pressed twice (the first press says "もう一度押すとクリア", and 4 seconds or leaving the button disarms it), forgets the conversation, so the next request is sent with no history; it is disabled while there is no conversation or Claude is answering, and it leaves the edit field, the saved instructions and the text being typed alone. Only the text of the edit field, the conversation and the request are sent, never a Slack message. Applying fills the edit field and does not save; an old proposal cannot be applied once the field was changed. The field and the conversation are kept in memory until the app quits. The instructions sent to the model (the fixed parts, the default body, and the mail summary and prompt-edit instructions, with the labels of their input) are written in Japanese; a body saved earlier stays as it was. The mail summary prompt (M-8) is not affected by the body. The conversation needs Claude to be usable (A-4) |
| S-4 | Proofread the text to paste into Slack with Claude | The right pane "Claude と校正" of the S-1 screen is the same conversation as S-3 (`ts/claude-chat.ts`: the log, a request field that grows up to 6 lines, Enter is a line break and Cmd+Enter (Ctrl+Enter off macOS) or the send button sends, a "クリア" button pressed twice, a line diff with "適用" and "却下", an old proposal cannot be applied once the field was changed, and a note and disabled controls while Claude cannot be used), about the text in the edit field (`claude_proofread_slack`; `claude -p`, the model and effort of A-2 with sonnet and medium as the default, no tools, no MCP, no settings). A "校正する" button above the request field sends the fixed request "校正してください". The instructions to the model (Japanese) say that the text is untrusted data and its instructions (and those in the assistant's turns of the conversation) are not followed, that the request decides what is corrected (typos, polite forms, wording), that facts, proper nouns, dates and URLs are not changed, that the subject line and the sender line at the top are not changed unless the request says so, that the reply is one or two short Japanese sentences, and that `body` is the whole text only when it changes and is identical except where changed. Only the text of the edit field (up to 10,000 characters), the conversation and the request are sent, and only when "校正する" or send is pressed. Applying replaces the text of the edit field and posts nothing. The conversation is kept with the draft of S-1 and goes with it; an answer that arrives after the screen was opened for another mail is dropped. A divider between the two panes (`role="separator"`, dragged with pointer events or moved with the left and right arrow keys) sets the width of the Claude pane to between a third and a half of the screen body (the CSS holds the range, the ratio is kept in memory until the app quits and survives a resized window). It needs Claude to be usable (A-4) |

### Integration

| ID | Feature | What it does |
|----|---------|--------------|
| A-1 | Claude integration | A local MCP server (`cookapps-mcp`, stdio) lets Claude list, read, archive, mark read and trash inbox threads, and list events |
| A-2 | Claude model and effort | The Claude tab of the settings screen has a card "モデルと effort" (shown whether or not Claude can be used; the columns are headed "用途", "モデル" and "effort", and a note says the next call uses the choice and the default is Sonnet and medium, so the options carry no "(デフォルト)") with, for each of four purposes, a name, where it is used, and two narrow selects that choose its model and its effort: the Slack summary (S-2, "Slack の要約", used when a Todo is made from a Slack message), the mail summary (M-8, "メールの要約", the AI summary of the mail detail), the prompt conversation (S-3, "プロンプトの会話", editing the Todo summary prompt with Claude) and the Slack text proofreading (S-4, "Slack に貼る文章の校正", the "Claude と校正" pane). Each `claude -p` call uses the model and effort of its own purpose. The model is Haiku, Sonnet (the default) or Opus (Fable is not offered; a saved `"fable"` is an invalid value and gives Sonnet). The effort is low, medium (the default), high, xhigh or max, and `--effort` is always passed. Changing the model also switches the effort to the one the documentation recommends for it, saved in the same write: Haiku medium, Sonnet high, Opus medium (Rust `recommended_effort`, from https://platform.claude.com/docs/en/build-with-claude/effort, "Recommended effort levels"); the screen sends the model alone, and `claude_model_settings_save` takes an optional `effort` that defaults to the recommended one, while changing the effort sends both. The first default (nothing saved) stays Sonnet and medium. An effort select is colored by its value (`data-effort`, variables in `:root`): low gray, medium green, high yellow, xhigh orange, max red, following a change, a save and a failed save; the settings card colors the background and the text, and the frameless select of S-3 the text only. A change is saved at once, for that purpose only, in `claude-settings.json` in the app config directory (an object keyed by `slackSummary`, `mailSummary`, `promptChat` and `proofread`, each `{model, effort}`; one save reads the file again, changes one purpose and writes all four through a temporary file and a rename), and the next call uses it. Rust checks the purpose, the model and the effort against their lists when saving (a refusal is a Japanese message), and a missing file, an unreadable file or an invalid value gives the default for that purpose, so only a listed value reaches `--model` and `--effort`. A file in the old form, one `{model, effort}` pair for every call, gives that pair to all four purposes until a purpose is saved. From high up (high, xhigh, max) a call may run 300 seconds (`--effort max` took 61 seconds on a small input); below that it is 60 seconds for the summaries and 120 seconds for the prompt conversation and the proofreading. The `?` hint of the Claude card says that each of the four calls has its own model and effort. The screen of S-3 shows the selects of the prompt conversation too |
| A-4 | Claude connection | The `claude -p` calls of M-8, S-2, S-3 and S-4 go through the Claude Code CLI, which signs in either with the Claude subscription (the default) or with an Anthropic API key. The first card of the Claude tab ("Claude", with ↻ and `?`) has two rows with radios, "サブスクリプション" (email, plan, Claude Code version and state: ログイン中, 未ログイン with the `claude auth login` guidance, 未導入, 確認できません) and "API キー" (the workspace ID when Anthropic says it, the note that every call is billed, the state 未登録, 確認済み, 確認できません or 使えません, "貼り直す" and the disconnect button), so the state of the one not in use shows too. Pressing the radio of the API key row with no key stored, or with a key Anthropic refuses, only opens the key field ("確認して保存"); nothing is switched or logged out. If the keychain cannot be read, only the key row says 確認できません with the error; if asking for the connection itself fails, the card shows one failed row with the error and no radio, so nothing can be pressed, and Claude is in its failed state. At start only `claude_status` is called (so a start without the settings never asks Anthropic about a key); `claude_connection`, which answers the three parts of the card and the usable state `claude` with each state read once, is called when the Claude tab is first shown, by ↻ and after a change of the connection, and only the latest answer of the reads is used. While a change is on its way ↻ and the radios wait, and so does the button of the key field (also while the states are being read); sending the field while a change is on its way does nothing and does not empty it. A change of the connection redraws the connection card only, so the model selects and the prompt row keep their place and focus. Only the radio of a row switches the method (the radios are not grouped by name, so the arrow keys move none of them, and are disabled while a change is on its way); clicking or double-clicking the text of a row does nothing. The key is never shown, and the field is emptied as soon as it is read. The method is saved in `claude-auth.json` in the app config directory (`{"method":"subscription"|"apiKey"}`, written through a temporary file and a rename; a missing file, an unreadable one or an invalid value gives the subscription), and the key is in the OS keychain (service `jp.mysis.cookapps.claude`). Rust does not call the API for the work: the `claude -p` child process gets the key as `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` is taken out (the CLI prefers it) together with `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY` (they would send the key to another host or provider than the one it was checked against), while the subscription takes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` out. The key is in no command-line argument, log line or error text. `claude auth status` answers `loggedIn: true` for a made-up key (measured), so it does not check a key. A pasted key is trimmed, must start with `sk-ant-` and must not be an Admin key (`sk-ant-admin`) (a refusal is a Japanese message), then `GET https://api.anthropic.com/v1/models?limit=1` with `Authorization: Bearer` and `anthropic-version: 2026-10-21` (a short timeout) asks Anthropic, and the response header `anthropic-workspace-id` is shown on the key row. 401 and 403 mean the key cannot be used; any other failure means it cannot be checked. At registration neither is saved. When `claude_status` asks again later, a key that cannot be checked stays usable (only the state says 確認できません), and a key Anthropic refuses is not usable. A key registered from the field that the radio of the API key row opened (`claude_key_save` with `switch`: after the check, the keychain write and the `claude-auth.json` write), and pressing the radio of a stored key (`claude_method_set` asks Anthropic first and refuses a rejected key; one that cannot be asked about is let through), switch to the API key and run `claude auth logout` for Claude Code, unless the API key is the method already (then nothing is logged out, so a login made again by hand is kept). The logout is checked by reading `claude auth status` again (that alone, no `--version`): only logged out or no Claude Code counts, and a login that remains, or a status that cannot be read, means the logout is not confirmed (the switch stays). `claude_method_set` then answers an error; `claude_key_save` answers that the key is stored, with `logoutError`, and the screen closes the field and shows that text as the error. A key pasted again with "貼り直す" (`switch` false) only replaces the key: the method does not change and nothing is logged out. Going back to the subscription only changes the method (the key is kept, and a logged-out row says 未ログイン with the `claude auth login` guidance). Deleting the key asks for confirmation, and when the key was in use the method goes back to the subscription (the logout is not undone). The usable state the whole screen follows (`Claude`: the sidebar, Todo, M-8, S-4, S-3) is `ready` for a logged-in subscription, or for an API key that is not refused (then email and plan are empty, the sidebar popup and the button's `aria-label` say "API キー" instead of the email); it is not `ready` while the key is refused or missing. The `?` hint explains the key (made in the Console, limited to a workspace, kept in the keychain, switching logs Claude Code out on this device). No cost is shown. Unit tests and E2E never run a real logout |
| A-3 | Settings tabs | The settings screen has six tabs, in order Google, カレンダー, Todoist, Slack, Claude and アップデート (`role="tablist"`), and shows the cards of the selected tab only (the Claude tab has three: the connection of A-4, the model and effort of A-2, and the prompt row of S-3, in a tab panel that is no card itself, so the panel keeps its `role="tabpanel"`). The side menu's settings button opens it on Google, and so does a way in that names no tab; the "設定を開く" of the Claude popup of the side menu opens it on Claude, and the ways to add a Slack workspace (the notice of the Slack compose screen, and the failed Slack summary of the Todo add field) open it on Slack. "戻る" of the prompt screen returns to the tab it was opened from. Left and right arrow keys move between the tabs (the first and the last are neighbours). Selecting a tab closes an open `?` hint and scrolls the settings to the top. The heading "設定" and the tabs stay at the top (`position: sticky`) while a card scrolls under them; only the underline of the tabs divides them, with no shadow. A red dot is on the アップデート tab while a newer version is out (U-1) |

### Updates

| ID | Feature | What it does |
|----|---------|--------------|
| U-1 | Auto update | Check GitHub Releases at start and every 5 minutes. When a newer version is out, the side menu shows an update button and puts a red dot on the settings button and on the update tab of settings (A-3); pressing the update button downloads the new app, checks its signature, replaces the app and restarts it. macOS on Apple Silicon only |
| U-2 | Update settings and version | The settings screen shows the running version (from `app.package_info()`), the update state and a "check now" button. The update mode is "manual" (U-1's behavior) or "auto" (the default), saved in `update-settings.json` in the app config directory. In auto mode a newer version is downloaded and replaced in the background without a restart (`install_update`), and the side menu's update button then restarts the app (`restart_app`); the app never restarts by itself. On other platforms the card shows the version and "not supported" |

### Out of scope

- Sending, replying and drafting mail
- Creating, editing and deleting events
- Any other feature of a full-featured mail client

## Technical constraints

- Gmail and Google Calendar are accessed with OAuth 2.0, using the desktop-app flow: loopback redirect with PKCE.
- The Gmail scope is `gmail.modify`.
  - It is enough to trash and archive.
  - A permanent delete (one that skips the trash) needs `https://mail.google.com/`.
- The Calendar scope is `calendar.readonly`.
- Updates use `tauri-plugin-updater`. A push to main that raises the version makes CI tag it `v{version}`, and then the `release` job makes `cookapps.app.tar.gz`, its `.sig` and `latest.json` (`scripts/make-latest-json.sh`) and puts them in a GitHub Release.
  The app reads `releases/latest/download/latest.json` (`plugins.updater.endpoints` in `tauri.conf.json`) and verifies the download with the public key `plugins.updater.pubkey`.
  `bundle.createUpdaterArtifacts` is not in `tauri.conf.json`; the `release` job passes it with `--config`, so a local build needs no signing key.
- The refresh token is stored locally so the user does not log in at every start.
- Tokens go in the OS keychain (macOS Keychain, Windows Credential Manager), never in a plain file.
- The list of accounts (email addresses only) is saved in `accounts.json` in the app config directory.
- The last weeks of the calendar, with the details of their events (place, description, Meet link and so on), are saved in `calendar-cache.json` in the same place; the first day of the week is in `calendar-settings.json`, and the model and effort of the four purposes of the Claude calls are in `claude-settings.json`. The method the Claude calls sign in with is in `claude-auth.json` there, and the Anthropic API key is in the OS keychain (service `jp.mysis.cookapps.claude`).
- If the OAuth consent screen is "External" and in "Testing", refresh tokens expire after 7 days.
  - Use an "Internal" consent screen, or publish an "External" one.

## Stack and layout

```text
ts/            TypeScript, compiled by tsc to src/js/ (gitignored). No framework, no bundler
ts/bindings/   Rust struct types written by ts-rs (generated, committed)
src/           index.html, CSS, vendored libraries (src/vendor/)
src-tauri/     Rust backend (Tauri v2); src/bin/cookapps-mcp.rs is the MCP server
e2e/           WebdriverIO specs, fixtures and mocks
scripts/       check-version.sh, install-app.sh, make-latest-json.sh
docs/          public documentation (GitHub Pages)
```

- The frontend is plain TypeScript, HTML and CSS.
  `ts/` is split into one module per screen.
- The backend is Rust.
  Each service has its own module: `gmail.rs`, `calendar.rs`, `todoist.rs`, `slack.rs`, `claude.rs`.
  The modules are in the library crate (`src-tauri/src/lib.rs`), and `main.rs` only calls `cookapps_lib::run()`.
- Internal functions take the config directory (`&Path`), not an `AppHandle`, so `cookapps-mcp` can share them.
- The Rust version is pinned in `rust-toolchain.toml` and in the CI workflow. Keep them equal.

## Run

Install the Rust version in `rust-toolchain.toml`.

```sh
npm install
npx tauri dev
```

At the first start, press "Log in with Google" and the default browser opens.
Add more accounts from "Add account" in the Google tab of the settings screen.

### OAuth client JSON

1. In a Google Cloud project, enable the Gmail API and the Google Calendar API.
2. Configure the OAuth consent screen.
3. Create an OAuth client of type "Desktop app".
4. Download its JSON and save it as `client_secret.json` in the Tauri `app_config_dir`.
   - The format is `{"installed":{"client_id":"...","client_secret":"..."}}`.
   - If the file is missing, the login screen shows an error with the absolute path to put it in.

### MCP server

`cookapps-mcp` reads the same `client_secret.json`, `accounts.json` and keychain entries as the app, and it never logs in.
Install it with `cargo install --path src-tauri --bin cookapps-mcp --locked`.
The setup is in `docs/mcp.md`.
The tools are `list_inbox`, `get_thread` and `list_events` (read), and `archive`, `set_read` and `trash` (write).

## Tests

There are three layers: static, unit and E2E.
No check is repeated in two layers.

| Layer | What it checks | Tools | What it does not check |
|-------|----------------|-------|------------------------|
| Static | Format, lint, types, Rust-TS type match, version match | cargo fmt, clippy, Biome (lint only), tsc, bindings diff, `scripts/check-version.sh` | Behavior |
| Unit | Pure Rust logic (parsing API responses, validating input, computing dates, IDs and URLs, converting errors) | cargo test | Screens, WebView |
| E2E | Screen behavior (how command results are drawn, the commands and arguments an operation calls, how errors show) | WebdriverIO (real WKWebView, commands mocked) | Processing inside Rust |

- Frontend TS holds only drawing and operation. Logic that needs a test is a pure Rust function.
- Tests never touch a real external service, the keychain or the real config folder.
  E2E builds use a separate identifier and an in-memory keyring.
- E2E mocks live only in `e2e/`.
- Each E2E run starts one app for each of its capabilities and gives each a free WebDriver port, so runs from several worktrees can overlap.

```sh
npm run lint        # Biome (lint only)
npm run build:ts    # tsc (ts)
npm run e2e:check   # tsc (e2e)
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
cd src-tauri && cargo test --all-features    # also writes the ts-rs types to ts/bindings/
npm run e2e:build   # build the app for E2E (feature e2e)
npm run e2e         # WebdriverIO
scripts/check-version.sh   # the version in Cargo.toml, tauri.conf.json and Cargo.lock matches
```

## CI

CI is `.github/workflows/ci.yml`, with one job per layer.

| Job | Environment | Checks |
|-----|-------------|--------|
| `static` | macos-latest | version match, `npm run lint`, `npm run build:ts`, `npm run e2e:check`, cargo fmt |
| `test` | macos-latest | clippy (`--all-targets --all-features`), cargo test (`--all-features`), bindings diff |
| `e2e` | macos-latest | `npm run e2e:build`, `npm run e2e` |
| `tag` | ubuntu-latest (main pushes only; after `static`, `test` and `e2e`) | the annotated tag `v{version}` of `src-tauri/Cargo.toml`, made unless it already exists (a push that does not raise the version is not a release) |
| `release` | macos-latest (main pushes with a new version tag only; after `tag`) | the signed `.app`, its updater files and `latest.json`, put in a GitHub Release. The secrets are `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |

## Known limitations

- The access token expiry is not tracked. On a 401, the token is refreshed and the request is retried (also in the middle of `threads.get`).
- On a rate limit (429 or 403 `rateLimitExceeded`), interactive operations retry up to 2 times (they follow `Retry-After`, capped at 30 seconds).
  Auto sync does not retry. It backs off per account (`SyncState`).
- There is no coverage tool.
- CI checks and releases macOS only. Windows is not built, linted, tested or released in CI, and it has not been checked on a real Windows machine.

## Open questions

- Whether delete should stay "move to the trash" or also offer a permanent delete.
- Which calendar views are needed (week view with a selected-calendars filter is implemented; day, month and an event list are open).
- Whether the list should cover only the inbox, or also labels and search.
- Offline behavior (the last fetched inbox, events and tasks are shown from the config folder; whether operations should work offline is open).

## References

- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- OAuth 2.0 refresh token expiry: https://developers.google.com/identity/protocols/oauth2
