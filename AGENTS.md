# つなぎAI

つなぎAI (tsunagiai) is a personal desktop client for Gmail.
It also shows Google Calendar, Todoist, Slack and Orca, and it has a local MCP server.
It is built with Tauri v2 and Rust.

This file is the developer guide.
User-facing text is in `README.md` and `docs/`.

## Scope

- The only user is the owner.
- Only Gmail accounts are supported.
- Other mail providers (generic IMAP, Outlook and so on) are out of scope.
- Calendar, Todoist, Slack and Orca are integrations around the mail client.
- The app updates itself on macOS (Apple Silicon) only.
- Notion is a planned integration.

## Requirements

The full text of each requirement is in `requirements/`, one file per area, under a heading `## {ID} {name}`.
Read a requirement's section before you change its behavior, and change the section in the same pull request.
A new requirement gets a section there and an entry here.

| Area | File | Requirements |
|------|------|--------------|
| Mail | `requirements/mail.md` | M-1 List, M-2 Read, M-3 Delete, M-4 Archive, M-5 Multiple accounts, M-6 Mark read, M-7 Auto sync, M-8 AI summary, M-9 New mail popup (retired), M-10 Reply field, M-11 New mail |
| Calendar | `requirements/calendar.md` | C-1 View, C-2 Event detail, C-3 First day of the week, C-4 Calendars to show, C-5 Create an event, C-6 Claude pane on the calendar screen, C-7 Edit and delete an event |
| Tasks | `requirements/tasks.md` | T-1 Todoist, T-2 Nest and unnest tasks, T-3 Comments, T-4 Labels, T-5 Count by due moment, T-6 Move a subtask from the detail, T-7 Claude pane on the Todo screen, T-8 Manage projects |
| Slack | `requirements/slack.md` | S-1 Paste a mail into Slack, S-2 Summarize a Slack message into a Todo, S-3 Edit the Todo summary prompt, S-4 Proofread the text to paste into Slack with Claude, S-5 Slack list, S-6 Slack thread, S-7 Ask Claude about the thread, S-8 Slack list: unread and read, S-9 Keep a channel off the Slack list, S-10 Emoji in Slack text, S-11 Blocks and attachments in the thread, S-12 Slack styles in the thread, S-13 Watch threads and the header of the Slack list, S-14 Unread replies in the Slack list, S-15 Mark a Slack channel read, S-16 Update the Slack list by Socket Mode events, S-17 New Slack message popup (retired), S-18 Revise the Todo draft with Claude, S-19 Slack side menu, S-20 Slack channel history, S-21 Post to a Slack channel, S-22 Reactions in Slack messages, S-23 Post to Slack by a request to Claude, S-24 Ask Claude on the Slack screen, S-25 Add and take off a reaction, S-26 Custom emoji in reactions as images, S-27 Claude mode and manual mode of the Slack compose screen |
| Claude | `requirements/claude.md` | A-1 Claude integration, A-2 Claude model and effort, A-4 Claude connection, A-32 Skills tab, A-36 Claude Code pane |
| App | `requirements/app.md` | A-3 Settings tabs, A-5 Side menu by screen, A-20 Fonts by screen, A-23 No title bar, A-28 The app's log and the failure cards, A-35 Footer with the unread count |
| Orca | `requirements/orca.md` | A-6 Orca, A-7 Orca session history (retired), A-8 Orca terminal and project list, A-9 Hand to Orca, A-10 Attach a file in Orca, A-11 Answer a question in the Orca history (retired), A-12 Orca terminal stream, A-13 Ghostty settings in the Orca terminal, A-14 Terminal colors, A-15 Terminal appearance, A-16 Start from the plus of the Orca work pane, A-17 Split panes in the Orca work pane, A-18 Orca files and editor, A-19 Search the Orca list, A-21 Colors in the Orca editor, A-22 Download an Orca file, A-24 Orca file diff, A-25 Switch the branch from the Orca file pane, A-26 Rich Markdown view, A-27 Git history in the Orca file pane, A-29 Scratchpad in the Orca work pane, A-30 Scratchpad on an SSH host (retired), A-31 Open an Orca HTML file in the browser, A-33 This machine and a saved environment in one list, A-34 Go to a definition in the Orca editor, A-37 Orchestration on the development screen, A-38 Add a project to Orca, A-39 Git changes in the Orca file pane, A-40 Peek at a session of the Orca list in a modal, A-41 Develop a feature with feature-dev in a formation, A-42 Preview an Orca HTML file in the editor, A-43 Database in the Orca file pane, A-44 Git writes on the files of the Orca file pane |
| Database | `requirements/database.md` | D-1 Database screen and connections, D-2 Connection to MySQL and the test of a connection, D-3 Open a connection, and the databases and tables under it, D-4 Records of a table, D-5 Structure of a table, D-6 SQL, D-7 Terminal pane on the database screen, D-8 Claude Code prepares a connection, D-9 Tabs of the database screen, D-10 Add, rewrite and delete the records of a table in the grid |
| Updates | `requirements/updates.md` | U-1 Auto update, U-2 Update settings and version |

### Out of scope

- Saving drafts of mail (a mail is written and sent in one go)
- Any other feature of a full-featured mail client

## Technical constraints

- Gmail and Google Calendar are accessed with OAuth 2.0, using the desktop-app flow: loopback redirect with PKCE.
- The Gmail scope is `gmail.modify`.
  - It is enough to trash and archive.
  - A permanent delete (one that skips the trash) needs `https://mail.google.com/`.
- The Calendar scopes are `calendar.readonly` (read) and `calendar.events.owned` (create, change and delete an event on a calendar the account owns).
  - `calendar.events` is not taken, because it also reaches the calendars that other people shared with the account.
- The refresh token is stored locally so the user does not log in at every start.
- Tokens go in the OS keychain (macOS Keychain, Windows Credential Manager), never in a plain file.
- The list of accounts (email addresses only) is saved in `accounts.json` in the app config directory.
- The name the app shows is つなぎAI (the window title, the name in Finder and the Dock, which `LSHasLocalizedDisplayName` in `src-tauri/Info.plist` reads from `src-tauri/macos/ja.lproj/InfoPlist.strings` (`bundle.macOS.files` puts it in the app; `CFBundleDisplayName` stays `tsunagiai`, because Finder shows the file name when the two differ), the texts of the screens, #764). The internal name stays `tsunagiai`: `productName`, `tsunagiai.app`, the crate, `tsunagiai-mcp`, the config folder and the keychain.
- The identifier is `jp.mysis.tsunagiai`. The config directory and the keychain services of the old identifier `jp.mysis.cookapps` are moved to the new ones by the app (`requirements/constraints.md`, "Settings files").
- If the OAuth consent screen is "External" and in "Testing", refresh tokens expire after 7 days.
  - Use an "Internal" consent screen, or publish an "External" one.

The constraints of one integration or one requirement are in `requirements/constraints.md`, under a heading for each area: Mail, Calendar, Slack, Settings files, Orca, Claude and skills, the app's log and fonts, Notion and Updates.
Read an area's section there before you change a behavior it covers, and when a change makes a constraint different, change the section in the same pull request.

## Stack and layout

```text
ts/            TypeScript, compiled by tsc to src/js/ (gitignored). No framework, no bundler
ts/bindings/   Rust struct types written by ts-rs (generated, committed)
src/           index.html, CSS, vendored libraries (src/vendor/) and the JetBrains file icons (src/vendor/jetbrains-icons/)
src-tauri/     Rust backend (Tauri v2); src/bin/tsunagiai-mcp.rs is the MCP server
src-tauri/formation/  the leader's skill and the children's plugin of A-41, embedded in the binary by build.rs
e2e/           WebdriverIO specs, fixtures and mocks
scripts/       check-version.sh, install-app.sh, make-latest-json.sh, build-milkdown.mjs and milkdown-entry.js (bundle src/vendor/milkdown.js)
docs/          public documentation (GitHub Pages)
requirements/  the requirements, one file per area, and constraints.md (the technical constraints of each integration)
tmp/           scratch files, gitignored except .keep
```

- The frontend is plain TypeScript, HTML and CSS.
  `ts/` is split into one module per screen.
  The screens show no help text: no placeholder or line of text that explains what to type or what a button does (at the owner's instruction, 2026-11-08). The rule is in `.claude/rules/frontend.md`.
- The backend is Rust.
  The modules are in the library crate (`src-tauri/src/lib.rs`), and `main.rs` only calls `tsunagiai_lib::run()`.
  Each service has its own module:
  - `gmail.rs`, with `gmail/held.rs` (the opened threads held in memory for a reopen, M-2)
  - `calendar.rs` (Google Calendar, and the check of the candidates of free time of `calendar_show_slots`, C-6), `todoist.rs` (Todoist)
  - `notion.rs`: Notion's MCP server (the OAuth connection and the tokens)
  - `slack.rs`, with `slack_markdown.rs` (Markdown to Slack's mrkdwn, S-6 and S-21), `slack_mrkdwn.rs` (Slack's mrkdwn read as the structure the thread draws, S-12), `slack_blocks.rs` (a message's blocks and attachments, S-11), `slack_emoji.rs` (the Slack emoji names that the `emojis` crate lacks) and `slack/socket.rs` (the Socket Mode connection, S-16)
  - `claude.rs`, with `claude_auth.rs` (how `claude -p` is signed in, A-4) and `claude_code.rs` (the shared part of the Claude Code panes, A-36: the pseudo terminal opened with `portable-pty`, and the folder `claude-code/` with its launch script and `mcp.json` for `tsunagiai-mcp` (the calendar pane alone starts in the `auto` permission mode, with `start-auto.sh` and `mcp-calendar.json`, #1074), and the first instruction a screen gives a pane, passed after a `--`, #976)
  - `screen_bridge.rs` (A-36, #731): the Unix socket `screen-bridge.sock` of the config directory through which `tsunagiai-mcp` reads and writes the fields a screen holds (`screen_read`, `screen_write`), asks a screen to post (`slack_compose_post`) and tells the app that something changed, with `ts/screen-bridge.ts` where a screen registers its target (the Slack compose screen, S-4, is the first)
  - `skills.rs`: the skills of the Claude calls, saved as `SKILL.md` files in `claude-plugin/` of the config directory
  - `formation.rs` (A-37): the orchestration: the folder `formations/{name}/` of each formation with its `formation.json` and `children.json`, and the tools `formation_plan`, `formation_launch` and `formation_close` of `tsunagiai-mcp` behind `--formation`, which start and end the children in Orca. A formation belongs to one PC, and its children are launched there only (`local`). `formation_claude.md` is the `CLAUDE.md` of the orchestrator
  - `formation_page.rs` (A-41): the decision pages: checks the input contract of a page, holds its paths inside the repositories of the PC and their worktrees, resolves its evidence, and records it in `formations/{name}/pages.json`
  - `formation_reply.rs` (A-41): the reply of a decision page, pasted into the leader's terminal
  - `yomiyasu_gate.rs` (A-41): the yomiyasu gate of `formation_page`, which reads the records in `YOMIYASU_STATE_DIR`
  - `formation_assets.rs` (A-41): the files of `src-tauri/formation/` that `build.rs` embeds: the leader's skill `feature-dev` and the children's plugin (`formation-plugin/` of the config folder)
  - `formation_server.rs` (#890): the server mode of `tsunagiai-mcp` (`--serve`) on the PC of a saved environment, and `Client`, the app's connection to it
  - `formation_remote.rs` (#891, #893): the app's side: puts `tsunagiai-mcp` in `remote/` of that PC from the GitHub Release, starts it, pins its key and version in `formation-remote.json` and connects to it. The app's secret key is in the keychain, service `jp.mysis.tsunagiai.formation`
  - `orca.rs` (A-6), with `orca_link.rs` and `orca_e2ee.rs` (the connection to Orca's runtime), `orca_handoff.rs` (A-9), `orca_attach.rs` (A-10), `orca_stream.rs` (A-12), `orca_panes.rs` (A-17), `orca_files.rs` (the file pane and the editor, A-18, the download, A-22, the diff, A-24, the branches and the commits of a worktree, A-27), `orca_diff.rs` (A-24), `orca_language.rs` (A-21), `orca_icon.rs` (the icon of a file in the file pane, #965), `orca_preview.rs` (the HTTP server on `127.0.0.1` that serves the files of a worktree to the default browser, A-31) and `orca_browse.rs` (the folders of a saved environment's server, for the picking dialog of A-38)
  - `ghostty.rs` (Ghostty's settings for the Orca terminals, A-13), `orca_theme.rs` (the colors of the Orca terminals, A-14, with the table `orca_themes.json`)
  - `ssh.rs` (this Mac's `ssh` command and the run of a process with a time limit, for `lsp.rs`, and the Host names of `~/.ssh/config` for the select of the ssh Host, #959)
  - `lsp.rs` (A-34): how a language server is started for a worktree, and the settings of each repository (its servers, one for each language: language, name, command) in `lsp-settings.json`, and the first instruction of the Claude Code pane that sets them up (`lsp_claude_prompt`, #976), with `lsp/detect.rs` (the table of the languages and their servers, and the finding of what a worktree has, #974, and the title and the icon of each language for the cards of the screen, #975), `lsp/server.rs` (the language server processes that stay, one for each worktree and language), `lsp/protocol.rs` (the LSP frame, messages and answers as pure functions), `lsp/container.rs`, `lsp/outside.rs` (#699), `lsp/view.rs` (#700) and `lsp/watch.rs`
  - `database.rs` (the connection profiles of the database screen, #625), with `database/script.rs` (the script that opens the way to a connection before MySQL is logged in to, #718), `database/mysql.rs` (the MySQL session, D-2), `database/session.rs` (the sessions that stay open, and the databases and tables, D-3), `database/records.rs` (a page of the records of a table, D-4), `database/structure.rs` (the columns, engine and character set of a table, D-5) and `database/sql.rs` (the SQL of a query tab, D-6)
  - `fonts.rs` (the fonts by screen, A-20), `side_menu.rs` (the order and the on and off of the six screens of the side menu, saved in `side-menu.json`, #676), `app_log.rs` (the app's log, A-28)

  The modules shared by the services:
  - `accounts.rs`: the list of accounts in `accounts.json`, and the atomic write of a settings file
  - `auth.rs` (the OAuth login and the tokens), `keychain.rs` (the OS keychain, which every module reads, writes and deletes its secrets through; it moves the items of the old identifier on their first read, #750), `identity.rs` (the identifier, the config folder and the move of the old one, #750)
  - `mail_address.rs` (splits a From or To header into a name and an address, and works out who a reply goes to, M-10), `mail_send.rs` (builds the message of a new mail or a reply and sends it, the command `send_mail`)
  - `images.rs` (the images in HTML mail, with `images/macos.rs`, which fetches an external image with NSURLSession) with `image_senders.rs` (the senders whose external images are shown without asking)
  - `disk_cache.rs` (the kept copies of the last calendar weeks that the screen draws first at startup; the mail list is no longer kept, #739)
  - `markdown_patch.rs` (puts an edit of the rich Markdown editor into the original text by lines, A-26; the mail of M-10 and the Slack posts of S-6 and S-21 also use it)
  - `update.rs` (the self-update and its settings, U-1 and U-2)
- Internal functions take the config directory (`&Path`), not an `AppHandle`, so `tsunagiai-mcp` can share them.
- The Rust version is pinned in `rust-toolchain.toml` and in the CI workflows (`release.yml` and `rust-cache.yml`, by the ref of `dtolnay/rust-toolchain`). Keep them equal.
- `.cargo/config.toml` sets `MACOSX_DEPLOYMENT_TARGET` to the value `tauri build` takes from `bundle.macOS.minimumSystemVersion` (default 10.13), so `tauri dev`, clippy and `cargo test` share the dependency builds of the E2E and release builds instead of rebuilding them. Keep the two equal.

## Run

Install the Rust version in `rust-toolchain.toml`.
Install a Node.js that WebdriverIO 10 accepts, which E2E needs: 22.23.4 or later of 22, 24.22.1 or later of 24, or 26.12.1 or later.

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

`tsunagiai-mcp` reads the same `client_secret.json`, `accounts.json` and keychain entries as the app, and it never logs in.
Install it with `cargo install --path src-tauri --bin tsunagiai-mcp --locked`.
The setup is in `docs/mcp.md`.
The tools are `list_inbox`, `get_thread`, `list_events` and `db_profiles` (read), `archive`, `set_read` and `trash` (write), `db_profile_save` and `db_test` (the connections of the database screen: save one with its script, and try it, D-8), and `lsp_settings` (read), `lsp_server_save`, `lsp_server_delete` and `lsp_repo_ssh_host_set` (write; the language servers of a project of the Orca screen, A-34, #960), and `screen_read` (read) and `screen_write` (write; the fields a screen holds, through the app's socket, A-36, #731) and `slack_compose_post` (write; no argument, it asks the Slack compose screen to post its things to do, S-23, #734), and `calendar_show_slots` (read; it only draws candidates of free time as red frames on the week of the calendar screen, through the target `calendar-slots` of the app's socket, and saves nothing, C-6, #1063), and `list_calendars` (read) and `calendar_set_shown`, `calendar_create_event`, `calendar_update_event` and `calendar_delete_event` (write; what the calendar screen does, with the functions of the app, and then `changed` `calendar` (`calendar-shown` for `calendar_set_shown`) to the app, so that it reads the week again, C-6, C-7, #1073; `list_events` also gives the detail of each event and its guests; an event that would invite a new guest is not sent: the tool writes the target `calendar-form` of the app's socket, which opens the form of the calendar screen with the values, and the owner saves it), and `todoist_projects` and `todoist_tasks` (read) and `todoist_add_task` (write; Todoist, with the token of the app's keychain entry, and it tells the Todo screen to read its list again, T-7, #732).
Started with the arguments `--formation {name}` (the `mcp.json` of the orchestrator of that formation, A-37), it offers `formation_environments`, `formation_worktrees`, `formation_files`, `formation_read` and `formation_git` (they only read: the repositories of each environment, the worktrees of one, the entries of a folder, a file's text, and the git state and branches, #848), `formation_page` (`formation_page.rs`: a decision page that a child wrote, checked and recorded in `formations/{name}/pages.json`, A-41), `formation_plan`, `formation_launch` and `formation_close` (`formation.rs`: the children of that formation and their record `formations/{name}/children.json`, which these tools alone write, besides the names of closed children that the app takes out of it through `--serve`; they take only `local`, the PC the orchestrator runs on, as a child's environment, because SendMessage reaches only that PC, #860) and, of the tools above, only the reads (`list_inbox`, `get_thread`, `list_events` and `db_profiles`), because the orchestrator runs in auto mode and a write would run with no question; no other client is offered the formation tools, because `formation_launch` starts a Claude Code in auto mode.
Started with `--calendar` (the `mcp-calendar.json` of the calendar pane of A-36, which runs in the `auto` permission mode, C-6, #1074), it offers `list_events`, `list_calendars`, `calendar_set_shown`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event` and `calendar_show_slots` only (`CALENDAR_TOOLS`), because a write of any other tool would run with no question to the owner; it cannot be given with `--formation`.
Started with `--formation-start {name}` (and `--project {repo}`, once for each project of the formation, none at all is fine: they are its first instruction, all in `local`, passed as `claude [prompt]`, so nothing is typed into its terminal afterwards, #882) instead, it serves nothing: it writes the files of that formation's orchestrator (`CLAUDE.md`, `mcp.json` that names this `tsunagiai-mcp` with `--formation {name}`, the launch script, an empty `.claude/settings.json` and the leader's skill `.claude/skills/feature-dev/`, written as the app writes them for its own pane) in `formations/{name}/` of this machine's config folder, and starts Claude Code there in place of itself, so an orchestrator can run on the machine of its children (#858); a failure is a line on stderr and a non-zero exit.
Started with `--serve --bind {host}` (and `--client-key {key}`, the app's public key, which the app gives when it puts the program on the PC), it serves the records of the formations to the app (the children of `children.json`, the decision pages of `pages.json`, with its evidence resolved there the page of one child and the time it was recorded at, and the mark that its reply was sent, A-41): it makes its key pair in `remote/` of this machine's config folder, pins the app's key, starts the daemon (`--serve-run`) unless one of this version already runs and returns at once, printing one line, `TSUNAGIAI-SERVE {public key} {version}` or, for a failure, `TSUNAGIAI-SERVE-ERROR {reason}` (non-zero exit); `--serve-stop` ends the daemon (`TSUNAGIAI-SERVE-STOPPED`). It listens on `{host}:47823` only and serves no MCP (A-37, `requirements/constraints.md`, "Orca").

## Tests

There are three layers: static, unit and E2E, and no check is repeated in two layers.
Static checks cover format, lint, types, the Rust-TS type match and the fixed source version, unit tests (cargo test) cover pure Rust logic, and E2E (WebdriverIO in the real WKWebView, commands mocked) covers screen behavior.
The table of the layers and the rules that follow from it are in `.claude/rules/testing.md`, and how E2E runs is in `.claude/rules/e2e.md`.

```sh
npm run lint        # Biome (lint only)
npm run build:ts    # tsc (ts)
npm run e2e:check   # tsc (e2e)
npx tsc --noEmit -p .claude/skills/readme-product/shots/tsconfig.json   # tsc (the spec of the README photos)
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
cd src-tauri && cargo test --all-features    # also writes the ts-rs types to ts/bindings/
npm run e2e:build   # build the app for E2E (feature e2e)
npm run e2e         # WebdriverIO
scripts/check-version.sh   # the source version is the fixed one: 0.0.0 in Cargo.toml and Cargo.lock, none in tauri.conf.json
```

`.claude/tools/run-ci.sh` runs the static checks and unit tests above (all but the E2E two) on a clean working tree and writes a record for HEAD, and `.claude/tools/run-e2e.sh` does the same for E2E.
A feature's pull request runs `run-ci.sh` and the review, and no `run-e2e.sh`; E2E runs once, when the Release PR (`release/next`) is prepared (at the owner's instruction, 2026-11-19; #1023).
Before a push, `pre-git.sh` checks that the CI record exists for HEAD, unless only release work (`README.md`, `CHANGELOG.md`, `docs/`) follows a commit that has it, and, for `release/next` only, that the E2E record exists for HEAD or for a commit with only release work after it (`.claude/rules/testing.md`, `.claude/rules/review.md`, `.claude/rules/e2e.md`).

## CI

The release is `.github/workflows/release.yml`, and only a pushed tag `v*` and the merge of the Release PR (a closed pull request from `release/next` into main, merged by the repository's owner: the owner in a session, or the night run, which merges with the owner's account) start it (at the owner's instruction, 2026-11-09; #303, and 2026-11-19 for the night run); the merge is tagged and released in the run that it starts, and the agent that merged it (the night run) or the next agent to act watches that run through (`.claude/skills/release/SKILL.md`).
Static, unit and E2E checks run on the developer's machine, not in GitHub Actions (`.claude/rules/testing.md`): the static and unit checks before each push, and E2E once for the Release PR (GitHub's runner took about 13 minutes for a run, and some specs failed only there; #1021, #1023). So a pull request runs no check of this repository: closing one starts `release.yml`, which does nothing unless it is the merged Release PR.
A push to main that changes the dependencies, the Rust version or `docs/` runs two workflows, and neither checks anything: `rust-cache.yml` builds the Rust dependencies of the release to fill the cache that `release` restores (at the owner's instruction, 2026-11-08; #248), and `pages.yml` builds `docs/` with Jekyll and deploys it to GitHub Pages.

| Job | Environment | What it does |
|-----|-------------|--------------|
| `tag` | ubuntu-latest | on a pushed tag `v*`, and on a pull request from `release/next` of this repository that was merged into main (any other closed pull request and every fork ends here), reads the tag (the pushed one, or the first `## v{version}` heading of `CHANGELOG.md` at the merge commit), checks that the source version is still the fixed one, that the tag has the form `v0.{minor}.{patch}` and is that heading, and that the commit is on main, then for a merge pushes the annotated tag on the merge commit with `GITHUB_TOKEN` (`contents: write`, and `actions: read` to list the runs). A tag that already has a run of a push (made by hand) is not tagged again and the merge run builds nothing; a tag already on the merge commit with no such run is the job's own from an earlier attempt, and the build goes on. A tag pushed with `GITHUB_TOKEN` starts no workflow, so the next job follows in the same run |
| `release` | macos-latest | needs `tag`; restores the Rust cache (`Swatinem/rust-cache`, `shared-key: release`, `prefix-key: v1-rust`, never saves), then builds the app with the version of the tag (`--config`) and puts the signed `.app`, its updater files and `latest.json` in a GitHub Release. The secrets are `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| `cache` (`rust-cache.yml`) | macos-latest | on a push to main that changes `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `rust-toolchain.toml`, `.cargo/config.toml` (part of the cache key) or one of the two workflow files, on a schedule (Monday and Thursday 18:17 UTC) and by hand, restores the cache with the same toolchain, toolchain clean-up and `rust-cache` settings as `release`; unless that is an exact hit it runs `npx tauri build --no-bundle` and saves the cache. It holds no secret |
| `build` and `deploy` (`pages.yml`) | ubuntu-24.04 | on a push to main that changes `docs/`, builds it with `actions/jekyll-build-pages` and deploys it with `actions/deploy-pages`. It needs the Pages source set to "GitHub Actions" (`build_type: workflow`) |

A tag run or a merge run reads only the caches of its own ref and of the default branch, and a tag's own cache cannot be read by the next tag, so the cache is made on main and `release` only restores it.
GitHub evicts a cache that no run has used for 7 days, so `rust-cache.yml` also runs on a schedule; it restores the cache for real (not `lookup-only`), because GitHub's documentation does not say that a lookup counts as use.
The cache is restored into the signed release, so when a dependency or action that ran on main is found compromised and reverted, delete the caches of main (`gh cache delete --all`) and raise `prefix-key` in both workflows, because a restored cache would carry its output into the build.

## Known limitations

- The access token expiry is not tracked. On a 401, the token is refreshed and the request is retried (also in the middle of `threads.get`).
- On a rate limit (429 or 403 `rateLimitExceeded`), interactive operations retry up to 2 times (they follow `Retry-After`, capped at 30 seconds).
  Auto sync does not retry. It backs off per account (`SyncState`).
- There is no coverage tool.
- CI releases macOS only. Windows is not built or released, and it has not been checked on a real Windows machine.

## Open questions

- Whether delete should stay "move to the trash" or also offer a permanent delete.
- Which calendar views are needed (week view with a selected-calendars filter is implemented; day, month and an event list are open).
- Whether the list should cover only the inbox, or also labels and search.
- Offline behavior (the last fetched inbox, events and tasks are shown from the config folder; whether operations should work offline is open).

## References

- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- OAuth 2.0 refresh token expiry: https://developers.google.com/identity/protocols/oauth2
