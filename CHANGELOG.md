# Changelog

The newest version comes first.
The project was named cookup until v0.14.6.

## v0.49.1

A URL in an Orca terminal opens in the default browser on ⌘+click (#147). Only http and https URLs open; a click without ⌘ still selects text. The URL shows while the pointer is over it.

The due moments of Todo are now computed in one place, with no change on the screen (#141).

## v0.49.0

A-15 the Orca terminals can keep the light or the dark appearance (#128). The "ターミナルの配色" card of the Orca tab has a new "外観" row: "システムに合わせる" (the default, as before), "ライト" or "ダーク". With "ライト" or "ダーク" the terminals draw that appearance's theme whatever the system's appearance is.

An image can be attached again in an Orca terminal and in the "Orca に渡す" pane, by pasting or dropping it (#135).

## v0.48.0

A-14 the colors of the Orca terminals are chosen in the settings (#109). The new "ターミナルの配色" card of the Orca tab has a light and a dark row, each with a theme of Orca's built-in themes and its swatch, and the terminals follow the system's appearance. The first choice is taken from the themes picked in the Orca on this Mac. The chosen theme comes before the colors imported from Ghostty.

The Orca screen:

- The project list puts the projects at work first, each part newest first (#98).
- A tab no longer loses its terminal when Orca drops Claude's state for a moment (#103).
- A terminal of a saved server shown in cookapps and in Orca at once is no longer drawn broken (#106). A key typed in cookapps gives the pane's size to Orca again, and the size Orca sends is drawn.
- The "合わせる" and "固定" switch is gone; a terminal always fits the pane (#115).

A plain-text mail body no longer draws a full-width space as a dotted box (#114).

## v0.47.0

S-16 the Slack list follows Socket Mode events (#96). In the new "リアルタイム更新" card of the Slack tab of the settings, register an App-Level Token (`xapp-`, scope `connections:write`) for a workspace; it is kept in the keychain. The app then stays connected to Slack, and a message posted, replied, changed or deleted in a channel reaches the list and the badge within about a second. While every workspace is connected, the whole list is read again every 5 minutes instead of every 2. `docs/slack.md` has how to make the token.

## v0.46.1

A Todo's description longer than 10 lines is folded at the 10th line in the detail (#93). The last line fades out, and "… 続きを表示（残り n 行）" under it shows the whole text; "折りたたむ" folds it again. Pressing the text still starts editing.

## v0.46.0

A-13 the terminals of the Orca screen take their font, colors and keys from Ghostty's config (#90). The new Orca tab of the settings has "取り込む", which reads Ghostty's config files once: `font-family`, `font-size`, `font-thicken`, the colors and `palette`, `theme` (also `light:…,dark:…`, following the system's appearance) and the `keybind` entries that send a text. The entries it could not take are listed with the reason. Shift+Enter in a terminal now sends a newline that Claude Code takes without sending.

## v0.45.0

A-12 every tab of the Orca screen is the session's terminal, typed into directly (#89). For a saved server, the list and the terminals are drawn from what Orca streams, with colors and no rereads by the clock. The keys go only to the terminal they were typed in. "合わせる" gives the pane's size to Orca and "固定" keeps Orca's size with a horizontal scroll; the switch is at the bottom of the left pane. This machine's Orca cannot stream to the app, because its WebSocket takes only a paired device, so its terminals stay mirrored. "新規" at the top of the left pane picks a worktree and starts Claude in a terminal.

The history and the composer are no longer on the Orca screen. The history, the answers to Claude's questions and further instructions stay in the "Orca に渡す" pane of a mail, a Slack thread and a Todo. A-10 (images in the Orca composer) and the skill list of the composer are removed with it.

## v0.44.1

The Orca history no longer shows the tags that Claude Code puts around a long paste (#58). The pasted text and the rest of the message stay.

## v0.44.0

M-9 new mail found by the auto sync shows as a card at the bottom right of the window (#61). It has the sender and the subject, and trash, archive and "詳細を開く", which opens the thread even from another screen. At most 3 cards show, and each goes after 10 seconds unless the pointer is on it. The load at startup shows none, and no OS notification is used.

A session started with "起動する" on the Orca screen now opens in its tab once it appears in the list, and the next text goes to it with "送る" instead of starting another session (#74).

The Orca history shows a turn that starts with a skill name as `/{name} {args}` (#56).

## v0.43.0

A-11 a question of Claude in the Orca history can be answered there (#57). Pick the choices in its box and press "回答を送る"; nothing is sent before that, and the button waits until every question has a pick. The keys go to the session's terminal one at a time, each after the screen shows the question's form, so a key never lands in another dialog. When the screen does not match, nothing more is sent and the box says to go on in the terminal. It was checked with Claude Code 2.1.318 on this machine; a saved environment uses the same route and is not checked yet.

## v0.42.1

The Orca screen no longer opens terminals of its own (#78). "ターミナルを開く" of the plus menu, its dialog and the app's PTY are gone, because they were slow over SSH and the cause was not found. The plain terminals of Orca still show as tabs, and the SSH hosts stay in the list.

## v0.42.0

A-10 the message field of the Orca screen takes images, by a drop and by a paste (#55). They show as thumbnails above the field, and each can be taken off. On send, each image goes to `.orca/drops/` of the destination worktree, and its path goes in the text, so Claude reads it. PNG, JPEG, GIF and WebP up to 20 MiB; an SSH workspace takes none. Old files in `.orca/drops/` are not removed, as in Orca itself. Written against Orca 1.4.248. This machine's Orca was tried; a saved server was not tried, and neither was a real drag or paste on the screen.

## v0.41.2

The message field of the Orca screen no longer shows a placeholder (#53). Typing `/` still opens the skill list.

The skill list of the Orca screen no longer offers a skill that Claude Code does not let the user choose (`user-invocable: false` in its `SKILL.md`) (#54).

The README is a product page with screen photos, and the how-to moved to `docs/` (#67). The development rules are public (#69).

## v0.41.1

The history of an Orca session reads as a conversation (#52). It has a tinted ground and the agent's messages are white cards; the heading of a run of tools is small plain text that says only how many times tools ran, or that they are running.

The count on the Orca icon of the side menu is now the sessions that need you (#47): the ones that wait for input, and the ones that finished or stopped while the app ran, until you open them. A session that works is no longer counted; while one works the icon is yellow and fades slowly (#48).

The README starts with what the app is for and who it suits (#45).

## v0.41.0

A-9 the content of a mail, a Slack thread or a Todo goes to Orca from a pane beside it (#33). The pane shows the destinations (a new session in a chosen worktree, or a running session) and a card of what goes, which can be opened to read the exact text or removed. Nothing is sent until the instruction is written and the button pressed. After that the pane shows the session's history and takes more instructions, beside the mail, the thread or the Todo, and the Orca screen folds the handed content into one line too.

## v0.40.0

A-8 the Orca screen has terminals and a project list (#42). The left pane lists the projects and the SSH hosts, newest first, each with the state icon Orca uses and its number of sessions, and a bell switches to the working sessions, which show the tool an agent is running. The right pane switches the sessions of a project with tabs, which can be closed. `+` starts Claude or opens a terminal in a worktree of this machine or on an SSH host: a real PTY, so full-screen programs work, and the shells end with the app. A plain terminal of Orca is only mirrored, with no colors, because Orca does not stream its bytes over its socket. The label of the target moved to the bottom of the left pane. Written against Orca 1.4.248.

## v0.39.2

A Slack thread opened from the list opens at its newest message, and stays there while its images load (#32). Opening the same thread again keeps its position.

## v0.39.1

A session whose Orca tab was closed while Claude kept running can be posted to again (#39). A question the agent asks is shown in the history unfolded, with its choices and the answer (#40). A Markdown table in the history, a Todo description or a Todo comment has ruled cells (#36).

## v0.39.0

A-7 the Orca screen is now two panes (#31). A row of the list opens the history of its session on the right, with the box to post to it. The list's width can be dragged, each row shows the latest prompt, the state, the branch and the time, and "running" is now 作業中. Tool calls fold into one line that opens on a press. `+` switches the right pane to a new session, and its target is chosen from a menu with a filter. Only Claude sessions are listed, and the choice of agent is gone (A-6). A saved Orca server is read over an end-to-end encrypted WebSocket using Orca's pairing, with new updates as they come; this machine's Orca is read every 3 seconds. Written against Orca 1.4.248. Reading from a saved server was tested against known vectors and a local stand-in, not yet against a real server.

## v0.38.1

The skill list of the Orca screen opens with a saved server as the target (#28). The CLI refuses to read the skills of another machine, so the list is that of the machine the app runs on, and it needs Orca running there. A failed read is tried again at most once a minute.

## v0.38.0

A-6 a new Orca screen lists the agents running in Orca as waiting for input, running and done, and posts to them through the `orca` CLI: a further instruction to a selected session, or a new agent in a chosen worktree (#25). No conversation is kept. For a Claude destination, `/` at the start of the text opens a list of the installed skills. The target is this machine or a saved Orca server, kept in `orca-settings.json`. A saved Orca server was not tried.

## v0.37.0

S-15 a check beside a row of the Slack list reads the row without opening its thread (#22). A channel has one read position, so the older rows of the channel are read too and the newer ones stay unread.

## v0.36.0

The rows of the Slack list draw the blocks, attachments and styles of a message, so a bot's post reads as it does in the thread (#16); images are not fetched there. S-14 a thread with unread replies is listed in the unread section, with "未読の返信 N 件" opening and closing its replies under the row, and its replies count in the badge. Up to 20 threads are checked in one read with `conversations.replies`. Slack has no public API to write a thread's read position, so what was read here is kept in `slack-thread-seen.json` (IDs and timestamps only) and does not clear the thread in Slack. A real Slack workspace was not tried.

## v0.35.1

The due popover no longer loses what was typed (#15): a click elsewhere, or pressing "追加" on the Slack card, confirms the text as Enter does, and Escape still cancels it. A picked day uses the time typed in the field (`15:00`, `15時`, `15時30分`, with 午前 or 午後, alone or after a date, 今日, 明日 or 明後日). A click elsewhere does not clear a repeating task's due date.

## v0.35.0

S-13 the Slack list has the sections "未読" and "ウォッチ", and the read section is gone (#13): a message that is not watched leaves the list once it is read. A bookmark button keeps a thread until it is let go, with "新しい返信 N 件" on new replies; `slack-watched.json` holds IDs and timestamps only, and up to 20 threads are checked in one read. The Slack list and the inbox list have a fixed header with "すべて既読にする": pressed twice in Slack, where the read position cannot go back, and once in the inbox, for the unread threads in the list, with "元に戻す". A real Slack workspace was not tried.

## v0.34.0

The Claude pane of the Slack thread is no longer for proofreading only (#11): it helps with summaries, answers and reply drafts too, and works with an empty reply. It now also sends the thread's messages, with the text and links of their blocks and attachments, up to 10,000 characters, only when send is pressed; the privacy policy says so. A proposal has a copy button, send is an arrow icon, the key hints are gone on both sides, and the lines above the reply field and the request field stay level (S-6, S-7). The compose and prompt screens are unchanged, except that a proposal from an empty text no longer shows a blank removed line. A real thread was not tried.

## v0.33.0

S-12 the Slack thread draws Slack's own styles (#12): bold, italic, strike, inline code, code blocks and `>` quotes, in a message's text and in the mrkdwn texts of its blocks and attachments. A tag stays text, URLs stay links except inside a code, and a line starting with `>>>` stays text. The list and what is sent to Claude are unchanged. The contents of an attached `.md` file are not shown. A real Slack message was not tried.

## v0.32.0

S-11 the Slack thread draws the blocks and attachments of a message (#10): headers, sections, fields, context, dividers, attachment color bars, titles and fields. A button with a URL opens in the default browser, one without shows its name only, and select menus are left out. Images are fetched only when "画像を表示" is pressed on a message, from any public https server, with no Slack token, so that server sees the user's IP address. The list and what is sent to Claude are unchanged. A real Slack message was not tried.

## v0.31.1

The inbox list lost its heading and its manual reload button, and the Slack list its heading and its unread count (the count stays on the Slack button). A failed inbox load is now tried again by itself, after 60 seconds and then twice as long each time up to 5 minutes, and a login that ends while the list is not on screen reloads it at the next sync round. The update button moved out of the side menu into a popup at the bottom right (#9), with the same action as a button in the update tab of settings; "あとで" closes it for that version until the app quits, and a toast stacks above it. The popup was not tried with a real update.

## v0.31.0

S-10 the Slack list and thread show the standard emoji of `:tada:`-style codes (the crate `emojis`, then a table of Slack's names generated from iamcal/emoji-data, MIT, in `slack_emoji.rs`, with skin tones). A workspace's own emoji stay as `:name:`, and codes in URLs, links, mentions, code and right after an ASCII letter or digit are not converted. S-1 and S-2 are unchanged. A real Slack message was not tried.

## v0.30.0

S-8 the Slack list split by `last_read` (`conversations.info`, confirmed on channels with the owner's real tokens) into at most 20 unread (10 first, the rest behind a button) and 5 read, a badge on the Slack button (`20+` above 20), opening a row marks it read on Slack (`conversations.mark`, optional `channels:write` and `groups:write`, which Slack makes include channel management), and the list is now read on every screen while the window is visible. S-9 a channel kept off the list (`slack-hidden.json`, IDs only; a hover icon on the row, undo, and a card in the Slack settings tab), because Slack's mute cannot be read (`users.prefs.get` answers `missing_scope`, `needed=read`, a legacy scope no new app can have). The real hover look of the hide icon, a real `conversations.mark` and the real read with these tokens in the app were not tried.

## v0.29.0

S-5 a Slack screen with the latest 20 messages of the joined channels of all workspaces (no DMs, no read state; at most 40 channels read per workspace per read, kept in memory), S-6 its thread detail with attached image thumbnails and a reply, S-7 proofreading the reply with Claude (`claude_proofread_reply`, a fifth purpose `slackReply`, default Sonnet and high, with selects in the pane), A-5 the side menu shows a function's accounts under its icon by screen (Google under the calendar on mail and calendar, workspaces under Slack), and Slack user icons (`slack-edge.com`, `secure.gravatar.com`, through `fetch_images`). New optional scopes `users:read` and `files:read`; the token is sent for images only to `files.slack.com`. A real Slack workspace, a real token and whether `conversations.history` holds thread replies were not tried.

## v0.28.1

no change to the app.

## v0.28.0

T-4 labels in the Todo detail (chips, a picker, and creating one with `todoist_create_label`; the Sync API's `labels` are read and kept in the cache), T-5 the Todo button and the Dock badge count a task once its due moment has come, 00:00 for no time (the Dock is checked by a Rust task every 15 seconds against `upcoming`, so it follows the clock with the window hidden), and a checkbox on the parent chip of a subtask's detail. The real Dock timing, a real `POST /labels` and the first real focus of the picker field were not tried: WebDriver's click leaves the focus on the + button, so E2E does not check it on opening.

## v0.27.0

T-3 comments in the Todo detail: read (Markdown, with a file card that opens in the browser), add, and attach one file to a comment (`todoist_comments`, `todoist_upload` over raw IPC and multipart, `todoist_add_comment`; reqwest gets its `multipart` feature, which brings `mime_guess` and `unicase`). The sanitizer of descriptions and comments also drops label, for, class, data-*, svg and math. A real Todoist comment, a real upload and the real file panel were not tried.

## v0.26.1

the due date of a Todo reads zero-padded `11月30日` (`2027年04月01日` when it is not this year; today and the due field of the popover are unchanged), and the due column is 92px at least so that a date with a time keeps the columns in line.

## v0.26.0

S-2 the Slack summary reads the whole thread (`conversations.replies`, up to 20 pages): a thread over 10,000 characters keeps the first, the linked and the latest messages and has its middle summarised in up to 5 chunks with a 180-second budget, and the card says how many messages it leaves out and when the linked message was cut; body lines after the first are indented so a message cannot forge a heading. A real Slack thread and a real model were not tried.

## v0.25.0

A-4 the Claude calls can sign in with an Anthropic API key as well as the subscription (`claude -p` stays and gets the key in its environment; the key is in the keychain under `jp.mysis.cookapps.claude`, the method in `claude-auth.json`; only the row's radio switches, and switching to the key runs `claude auth logout`), the Claude tab split into three cards (connection, model and effort, prompt), the effort selects colored by value, a change of model switching to the documented effort (Haiku medium, Sonnet high, Opus medium), and Fable no longer offered. A real key and a real logout were not tried.

## v0.24.0

T-2 (see above) and A-3 settings in six tabs with the heading and the tabs fixed at the top (Google first; the update tab has a red dot too), A-2 per purpose (`claude-settings.json` holds the model and effort of the Slack summary, the mail summary, the prompt conversation and the proofreading; an old one-pair file is the start value of all four), and S-3 opened from a Claude icon in the Todo list heading, with the conversation's model and effort under the request field

## v0.23.0

T-2 in the Todo list, drag a row's grip onto another task's row to make it that task's subtask (`todoist_move_under`), and take a subtask out of its parent with the "親タスクから外す" row button or by dropping it on its own project (`todoist_move` with the same project ID; Todoist's documentation says the task becomes the last root task, but this was not tried against the real API with the same project). E2E ends the slide animations before a drag, because they do not run in the hidden window. This commit was not pushed by itself, so no `v0.23.0` tag or release exists; T-2 was released in v0.24.0

## v0.22.0

S-4 "Slack に貼る" became a screen of its own instead of a popover: the whole post is edited in a field (the note was removed), the destination is a chip that opens the picker and none is chosen by itself, "メールに戻る" returns to the mail detail with the draft kept per mail, and a right pane proofreads with Claude (`claude_proofread_slack`; a width from a third to a half, set with a divider); the conversation code moved to `ts/claude-chat.ts`, shared with S-3

## v0.21.1

a Slack Bot User OAuth Token (`xoxb-`) is refused when it is registered, and one already stored shows the same message in settings instead of "接続済み"

## v0.21.0

A-2 the Claude model and effort chosen in the Claude settings card (`claude-settings.json`; default sonnet and medium, used by the Slack summary, the mail summary and the prompt conversation; high and above get a 300-second limit, and waiting for a Claude slot is limited to 60 seconds), the instructions sent to the model written in Japanese (a saved `todo-prompt.json` stays as it was), and in the prompt conversation a multi-line field that grows upward to 6 lines (Enter is a line break, Cmd+Enter sends) and a two-press clear

## v0.20.3

the Todo detail's three-dot menu (copy the task link, copy the description, delete with two presses), no manual reload, the Todoist connection and unlink moved to a "Todoist" settings card (`todoist_connected`), the description can be selected without starting the editor (a press edits after 250ms) and has a copy icon on hover, and completed tasks are fetched until a load has reached Todoist (`doneStale`)

## v0.20.2

removed the "この送信者の画像を自動で表示しない" link and `forget_image_sender` (a remembered sender stays remembered; images still need Gmail's authentication)

## v0.20.1

the app icon changed from the blue envelope to green tiles (three squares and a circle on the accent green; `icon.svg` is the source, `npx tauri icon` makes the `.icns` and `.ico`, and `icon.png` is the 1024px image taken from the `.icns`, because the generator's `icon.png` is 512px)

## v0.20.0

C-2 the detail of a calendar event in a popover beside it (time, Meet join button and URL with copy, location, description, attendee count, calendar, own answer; fetched with the week and kept in `calendar-cache.json`) and C-3 the first day of the week chosen from Sunday to Saturday in a "カレンダー" settings card (`calendar-settings.json`); `linkify` no longer links `tauri.localhost`

## v0.19.0

S-3 edit the Todo summary prompt (a screen opened from the Claude card in settings or from the summary card, a fixed part and an editable body saved in `todo-prompt.json`, and a conversation with Claude that proposes line diffs); on the S-2 card the due chip opens the calendar popover and the project starts as Claude's recommendation, tagged 推奨; the Slack input is enclosed in a random boundary

## v0.18.1

while a task is being created, a spinner on all four paths (the add field, a placeholder row for a subtask, the Slack card, the mail row and thread button); a subtask detail shows its direct parent above the name and opens it; the due field of a detail clears with an × shown on hover (two presses for a repeating task); also the fixes that followed v0.18.0 (HTML mail to text keeps rows and cells apart, minor findings of the AI summary review)

## v0.18.0

M-8 AI summary in the mail detail (an icon sends the thread's subject and text, newest first up to 10,000 characters, to `claude -p` with no tools and no settings; the points are drawn as text on a card under the subject and kept in memory only, per thread and latest message)

## v0.17.1

the update check runs every 5 minutes instead of every 6 hours (skipped while the window is hidden, and run on return when the last check is older; a version whose background replacement failed is not downloaded again automatically)

## v0.17.0

S-2 shows the Claude summary on a card before the Todoist task is created (name, description, due date and project can be edited; "Add" creates it, "Discard" creates nothing; `todoist_summarize_slack` and `todoist_add_from_slack` are separate commands), and the summary prompt asks for a short bullet list of the key points and Japanese writing rules

## v0.16.4

a red dot on the settings button while a newer version is out (its tooltip names the version), next to the existing update button

## v0.16.3

the due field of a Todo shows a one-off due date as `2026-11-02 12:00` (built from the date and time; a repeating task keeps Todoist's text)

## v0.16.2

the Dock badge shows the inbox unread count plus the Todo count of overdue and today open tasks (the sum of the two sidebar counts; a failed Todo count fetch keeps the last count)

## v0.16.1

adding Google accounts moved from the side menu's + button to a "Google" card at the top of settings (each account with a status label and its unread count), and the bottom of the side menu ordered as accounts, Claude, settings (last)

## v0.16.0

U-2 update settings and the running version (an "Update" card in settings with the version, the status, "check now" and a manual/auto switch saved in `update-settings.json`; auto replaces the app in the background and the sidebar button then only restarts it; the default is auto)

## v0.15.0

U-1 auto update (tauri-plugin-updater; checks `latest.json` of GitHub Releases at start and every 6 hours, and the update button in the side menu replaces the app and restarts it; macOS on Apple Silicon only; the CI `release` job puts the signed `.app.tar.gz`, its `.sig` and `latest.json` in the Release)

## v0.14.8

the Claude avatar in the side menu sits just above settings, and the gap above the menu is smaller (its tooltip stays hidden while the popup is open)

## v0.14.7

renamed the app and project to cookapps (identifier jp.mysis.cookapps, cookapps-mcp, GitHub hidetsugu-miya/cookapps; every account needs a new login), moved the developer guide to AGENTS.md. The v0.14.7 tag CI did not run: GitHub starts no workflow when more than 3 tags are pushed at once.

## v0.14.6

animation for the Todo open/close toggle (from the tag message; no entry was written in the old file).

## v0.14.5

nesting of Todo projects and subtasks, a right pane for the detail (from the tag message; no entry was written in the old file)

## v0.14.4

in the calendar, events the owner answered "maybe" to are struck through and unanswered events are drawn with inverted colors (the `declined` of the event type became `response` (`ResponseStatus`); `declined` of MCP `list_events` stays)

## v0.14.3

fix for the Windows CI clippy (the argument of the E2E setup renamed `_app`)

## v0.14.2

E2E (WebdriverIO on real WKWebView and WebView2, commands mocked in e2e/fixtures.js), the frontend as TypeScript (`ts/` -> tsc -> `src/js`) in per-screen modules, Rust types in `ts/bindings/` by ts-rs, Biome lint, CI split into static, test, e2e and installer layers (failed in the Windows CI clippy; noticed after the push, fixed in v0.14.3)

## v0.14.1

confirmation before disconnecting Slack, a right pane when permission is missing (shows only the scopes the token lacks), `im:history` and `mpim:history` for DM and group DM added to the permission check and the guidance, missing_scope shows the names of the missing scopes

## v0.14.0

S-2 summarize a Slack message with Claude and add it to Todo (settings became one card per integration with the explanation moved to a ? hint; the Claude account is shown in the side menu)

## v0.13.6

unified the screen colors to mint green (colors are variables in `:root` of `src/style.css`; accent `#1e7b52`; priority, error, account and event colors and the inside of the mail body iframe are unchanged), fix for code frames disappearing when the mouse is over a description

## v0.13.5

the description in a Todo detail is shown in full as Markdown (marked and DOMPurify placed in `src/vendor/`), and pressing it edits it with "Cancel" and "Save" (leaving the field does not save)

## v0.13.4

at start and when the calendar opens, show the previous inbox, events and Todo first from JSON in the settings folder (`inbox-cache.json`, `calendar-cache.json`, `todoist-cache.json`), then redraw after the fetch

## v0.13.3

events side by side in the calendar show no time, and long titles are cut at 20 characters with "…" (the tooltip has the full text)

## v0.13.2

fix for the Windows CI clippy (an empty Session off macOS as a braced struct)

## v0.13.1

on macOS, external images behind "show images" are fetched with NSURLSession (the host's bot protection rejected reqwest), threads newest first (the latest is opened at the top), a lower detail toolbar (failed in the Windows CI clippy; noticed after the push, fixed in v0.13.2)

## v0.13.0

Windows support (Credential Manager, the config folder of `cookup-mcp`, Ctrl+Z, windows-latest in CI and the nsis installer artifact, OS-neutral wording; not checked on a real Windows machine)

## v0.12.1

show 2 hours before now at the top when the calendar opens (changed from 3 hours in v0.8.1)

## v0.12.0

choose the Slack destination when pasting (recent destinations, channel search, links), multiple workspaces (the registration of destinations was removed from settings)

## v0.11.0

S-1 paste a mail into Slack (register the Slack token and paste destinations on the settings screen)

## v0.10.22

plain-text mail bodies in a monospace font (HackGen Console NF, 13px; ui-monospace if missing)

## v0.10.21

calendar events in title-then-time order, title only for events under 45 minutes, no background color on today's column

## v0.10.20

Todo operations (move, complete, delete, name, description, priority, due date picked on the calendar) are applied to the screen first and sent to Todoist in the background (on failure refetch and restore; a refetch during a write is neither sent nor drawn)

## v0.10.19

drag the grab icon at the left end of a Todo row and drop it on a project in the left pane to move it (own implementation with pointer events; HTML5 drag and drop is not used because it collides with Tauri's file drop)

## v0.10.18

"Edit" (name in place), "Due" and "Project" buttons on Todo list row hover (the same popovers and menus as the detail chips)

## v0.10.17

in the Todo "Today" view, a task added with no date gets today as its due date (Quick Add, then an update with `due_string: today`)

## v0.10.16

undo the last trash or archive with Cmd+Z and the "Undo" notice (`untrash` / `unarchive`)

## v0.10.15

pick a day from a month calendar in the due-date chip of a Todo detail (repeating tasks have only the text field)

## v0.10.14

the mail detail screen is closer to Gmail (subject above the body, header with avatar, sender, recipients and date, no frame around the body, old messages folded into one line, a background color on the detail toolbar)

## v0.10.13

Todoist switched to Sync API incremental sync; the Todo count and the Todo screen refresh every 10 seconds and when the window is focused again

## v0.10.12

events of `list_events` get the calendar name (`calendar`), and of the same event seen in several accounts the one with a title is kept (calendars shared for free/busy only had empty titles such as "Block")

## v0.10.11

the hover buttons of a list row are archive, trash, Todo in that order

## v0.10.10

turn URLs in plain-text mail bodies into links (they open in the default browser)

## v0.10.9

wider side menu; the inbox button shows the unread count and the Todo button shows today's open count (fetched at start and every 5 minutes, also outside the Todo screen)

## v0.10.8

fix for body links not opening on the real machine (WKWebView) (sandbox gets allow-top-navigation-by-user-activation, and Rust `on_navigation` stops the navigation and sends it to the browser; the click interception of v0.10.6 and v0.10.7 had not worked in WebKit)

## v0.10.7

minor fixes to body links (show the destination URL at the lower left; relative links, area, mailto, empty href)

## v0.10.6

open links in the mail body in the default browser (`open_link`, http and https only)

## v0.10.5

fixes for minor review findings (the field of a row restored after a failure; the conditions, clearing, date re-attachment and in-memory holding of the cache saving)

## v0.10.4

when Todoist cannot be reached (for example scheduled maintenance), show the previous content saved in `todoist-cache.json` in the settings folder, with a notice

## v0.10.3

fix for all-day events showing `[object Object]0` in the calendar (overwritten by a same-named function in Todo)

## v0.10.2

split the inbox list into unread and read, with read under a "Read" heading

## v0.10.1

mark read when a mail is opened, fit the body frame to the body, show embedded images and a "show images" button (remembered per sender), fix for a flaky test in CI

## v0.10.0

T-1 Todoist (Todo screen, make a Todo from a mail)

## v0.9.0

A-1 Claude integration (MCP server `cookup-mcp`)

## v0.8.10

own tooltip for icon-only buttons (read from `aria-label`)

## v0.8.9

`.app` build and placement in `/Applications` (`scripts/install-app.sh`)

## v0.8.8

account removal (from the popup; revoke the Google permission, delete from keychain, accounts.json and cache)

## v0.8.7

removed the limit where one failed calendar hid all of an account's events

## v0.8.6

unread count in the Dock badge (Rust `set_badge`; 0 clears it)

## v0.8.5

account info popup from the side menu avatar (email address, status and re-login, unread count)

## v0.8.4

placeholder app icon

## v0.8.3

parallel calendar fetches and an in-memory cache of weeks and the calendar list

## v0.8.2

the Medium and Low items of the audit (retry on rate limits, token expiry during a fetch, replace-write of accounts.json, ID validation, pinning the Rust version, CI permissions, a test of the keychain name)

## v0.8.1

show 3 hours before now at the top when the calendar opens

## v0.8.0

C-1 calendar

## v0.7.3

log failures to standard error, and delete the migration from a single account (the tag commit still has version 0.7.2; it was noticed after the push, so the tag was not redone)

## v0.7.2

set a CSP and load no external images and the like

## v0.7.1

fix for one account's failure hiding the whole list

## v0.7.0

M-7 auto sync

## v0.6.6

fix for removed rows coming back after consecutive operations

## v0.6.5

fix for the row trash button that could not be pressed

## v0.6.4

archive and trash remove the row at once and run in the background

## v0.6.3

the hover check mark changed from mark-read to archive

## v0.6.2

mark-read and trash buttons on row hover

## v0.6.1

unread dot and checkbox shown only on hover

## v0.6.0

M-6 mark read

## v0.5.0

M-5 multiple accounts

## v0.4.4

wider window and a one-step smaller font

## v0.4.3

fix for the list looking empty after an archive

## v0.4.2

garbled text fix

## v0.4.1

layout fix

## v0.4.0

M-4 archive

## v0.3.0

M-3 delete

## v0.2.0

M-2 read

## v0.1.0

authentication and M-1 list (with README and LICENSE)
