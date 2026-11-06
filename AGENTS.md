# cookapps

cookapps is a personal desktop client for Gmail.
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
| Mail | `requirements/mail.md` | M-1 List, M-2 Read, M-3 Delete, M-4 Archive, M-5 Multiple accounts, M-6 Mark read, M-7 Auto sync, M-8 AI summary, M-9 New mail popup |
| Calendar | `requirements/calendar.md` | C-1 View, C-2 Event detail, C-3 First day of the week |
| Tasks | `requirements/tasks.md` | T-1 Todoist, T-2 Nest and unnest tasks, T-3 Comments, T-4 Labels, T-5 Count by due moment |
| Slack | `requirements/slack.md` | S-1 Paste a mail into Slack, S-2 Summarize a Slack message into a Todo, S-3 Edit the Todo summary prompt, S-4 Proofread the text to paste into Slack with Claude, S-5 Slack list, S-6 Slack thread, S-7 Ask Claude about the thread, S-8 Slack list: unread and read, S-9 Keep a channel off the Slack list, S-10 Emoji in Slack text, S-11 Blocks and attachments in the thread, S-12 Slack styles in the thread, S-13 Watch threads and the header of the Slack list, S-14 Unread replies in the Slack list, S-15 Mark one Slack row read, S-16 Update the Slack list by Socket Mode events |
| Integration | `requirements/integration.md` | A-1 Claude integration, A-2 Claude model and effort, A-4 Claude connection, A-3 Settings tabs, A-5 Side menu by screen, A-6 Orca, A-7 Orca session history, A-8 Orca terminal and project list, A-9 Hand to Orca, A-10 Attach an image in Orca (retired), A-11 Answer a question in the Orca history, A-12 Orca terminal stream, A-13 Ghostty settings in the Orca terminal, A-14 Terminal colors |
| Updates | `requirements/updates.md` | U-1 Auto update, U-2 Update settings and version |

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
- A Slack workspace may also have an App-Level Token (`xapp-`, scope `connections:write`, S-16), kept in the OS keychain (service `jp.mysis.cookapps.slack-app`, user name the workspace's `team_id`) and never shown or logged. With it the app keeps a WebSocket open to Slack's Socket Mode (`apps.connections.open`, then the `wss` address of slack.com it answers) for as long as the app runs, and reads the channels whose message events arrive; the list is still read on a timer (every 5 minutes while every workspace is connected, else every 2 minutes).
- Updates use `tauri-plugin-updater`. Pushing the annotated tag `v{version}` starts the `release` job, which makes `cookapps.app.tar.gz`, its `.sig` and `latest.json` (`scripts/make-latest-json.sh`) and puts them in a GitHub Release.
  The app reads `releases/latest/download/latest.json` (`plugins.updater.endpoints` in `tauri.conf.json`) and verifies the download with the public key `plugins.updater.pubkey`.
  `bundle.createUpdaterArtifacts` is not in `tauri.conf.json`; the `release` job passes it with `--config`, so a local build needs no signing key.
- The refresh token is stored locally so the user does not log in at every start.
- Tokens go in the OS keychain (macOS Keychain, Windows Credential Manager), never in a plain file.
- The list of accounts (email addresses only) is saved in `accounts.json` in the app config directory.
- The last weeks of the calendar, with the details of their events (place, description, Meet link and so on), are saved in `calendar-cache.json` in the same place; the first day of the week is in `calendar-settings.json`, the model and effort of the five purposes of the Claude calls are in `claude-settings.json`, and the Orca to talk to (this machine or a saved environment) is in `orca-settings.json`. The method the Claude calls sign in with is in `claude-auth.json` there, and the Anthropic API key is in the OS keychain (service `jp.mysis.cookapps.claude`).
- The history of an Orca session (A-7) is read from Orca's own files, `orca-runtime.json` (this machine, over its unix socket, polled every 3 seconds) and `orca-environments.json` (a paired server, over a WebSocket with end-to-end encryption), in Orca's settings folder; they are read at each connect and never written, and no token or key from them is kept, logged or shown. It was written against Orca 1.4.248 and an Orca update can change it.
- The SSH hosts come from `ssh.listEditableTargets` of Orca's runtime (the socket of A-7), which is not a public interface.
- The Orca screen's list and terminals of a saved environment (A-12) are streamed over its WebSocket with `session.tabs.subscribeAll`, `terminal.subscribe`, `terminal.updateViewport`, `terminal.unsubscribe` and `terminal.send` of Orca's runtime, which are not a public interface. They were checked on Orca 1.4.249, and an Orca update can change them. This machine's Orca cannot stream to this app (its unix socket refuses streaming methods, and its WebSocket takes only a paired device's token), so a terminal of this machine is only mirrored, by reading its screen every second: no colors, and full-screen programs are approximate.
- An answer to a question of Claude in the Orca history (A-11) is typed into the session's terminal, one key at a time (digits and Tab only), with `orca terminal send` after a read of the screen by `orca terminal read --screen` that shows what the key is for (this machine and a saved environment, by the CLI). It was written against Claude Code 2.1.318 and Orca 1.4.249; the screens it waits for are Claude Code's wording, and an update can change them (then nothing is typed).
- Ghostty's settings for the Orca terminals (A-13) are read from Ghostty's config files (`~/.config/ghostty/` and `~/Library/Application Support/com.mitchellh.ghostty/`, `config.ghostty` and `config`) and theme files only when the owner presses the import button, and are never written. What the terminals take from them is saved in `ghostty-settings.json` in the app config directory, with the entries imported and left. The places and the format follow Orca 1.4.250's own Ghostty import and Ghostty 1.4.0, and an update of either can change them.
- The colors of the Orca terminals (A-14) are the built-in themes of Orca 1.4.250, a table that the app holds (`src-tauri/src/orca_themes.json`, taken from Orca's `app.asar`), and the theme chosen for the light and for the dark appearance is saved in `terminal-theme.json` in the app config directory. The first time the settings of the Orca on this Mac can be read, they give the choice: `terminalThemeLight` and `terminalThemeDark` of the `settings` row in `profiles/local-default/profile-state.db` (SQLite) in Orca's settings folder, which is not a public interface and was read on Orca 1.4.250. That file is opened read-only with `rusqlite` and never written, and its content is not kept or logged. An Orca update can change it (then the defaults are used).
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
requirements/  the requirements, one file per area
```

- The frontend is plain TypeScript, HTML and CSS.
  `ts/` is split into one module per screen.
- The backend is Rust.
  Each service has its own module: `gmail.rs`, `calendar.rs`, `todoist.rs`, `slack.rs`, `claude.rs`, `orca.rs` (with `orca_chat.rs` and `orca_e2ee.rs` for the session history, `orca_handoff.rs` for the prompt of A-9 and its folding in the history, `orca_answer.rs` for the answers of A-11, and `orca_stream.rs` for the stream of A-12), `ghostty.rs` (Ghostty's settings for the Orca terminals, A-13), `orca_theme.rs` (the colors of the Orca terminals, A-14, with the table `orca_themes.json`).
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

CI is `.github/workflows/release.yml`, and only a pushed tag `v*` starts it.
Static, unit and E2E checks run on the developer's machine before a push, not in GitHub Actions, so a push to main or a pull request runs no workflow of this repository (GitHub Pages still builds `docs/` on a push to main).
A change reaches main through a pull request, and the machine that ran the checks sends their results as the commit statuses `e2e` and `review`.
A release is the merge of the pull request that raises the version, followed by its tag.

| Job | Environment | What it does |
|-----|-------------|--------------|
| `release` | macos-latest | checks that the tag is the version of its commit and that the commit is on main, then puts the signed `.app`, its updater files and `latest.json` in a GitHub Release. The secrets are `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |

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
