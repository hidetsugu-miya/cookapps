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

### Calendar

| ID | Feature | What it does |
|----|---------|--------------|
| C-1 | View | Show the events of Google Calendar (read-only) |

### Tasks

| ID | Feature | What it does |
|----|---------|--------------|
| T-1 | Todoist | Work with Todoist tasks in per-project and today lists and a detail view (description and subtasks), and create a task from a mail. Authentication is a personal API token |

### Slack

| ID | Feature | What it does |
|----|---------|--------------|
| S-1 | Paste a mail into Slack | From the mail detail, post the note, subject, sender and body under your own name to a destination chosen at paste time (recent destinations, joined channels, or a channel or thread link). You can have several workspaces. Authentication is a User OAuth Token per workspace (scopes `chat:write`, `channels:read`, `groups:read`) |
| S-2 | Summarize a Slack message into a Todo | Paste the URL of a Slack message into the Todo add field. cookapps fetches the message, summarizes it with the Claude Code CLI (`claude -p`, haiku, no tools, no MCP, no settings), and adds it as a Todoist task in the current project. The Slack token also needs `channels:history`, `groups:history`, `im:history` and `mpim:history` (the last two for DM and group DM links). The Claude account (`claude auth status`) is shown in the side menu and in settings |

### Integration

| ID | Feature | What it does |
|----|---------|--------------|
| A-1 | Claude integration | A local MCP server (`cookapps-mcp`, stdio) lets Claude list, read, archive, mark read and trash inbox threads, and list events |

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
- The refresh token is stored locally so the user does not log in at every start.
- Tokens go in the OS keychain (macOS Keychain, Windows Credential Manager), never in a plain file.
- The list of accounts (email addresses only) is saved in `accounts.json` in the app config directory.
- If the OAuth consent screen is "External" and in "Testing", refresh tokens expire after 7 days.
  - Use an "Internal" consent screen, or publish an "External" one.

## Stack and layout

```text
ts/            TypeScript, compiled by tsc to src/js/ (gitignored). No framework, no bundler
ts/bindings/   Rust struct types written by ts-rs (generated, committed)
src/           index.html, CSS, vendored libraries (src/vendor/)
src-tauri/     Rust backend (Tauri v2); src/bin/cookapps-mcp.rs is the MCP server
e2e/           WebdriverIO specs, fixtures and mocks
scripts/       check-version.sh, install-app.sh
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
Add more accounts from "Add account" at the bottom of the side menu.

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
| E2E | Screen behavior (how command results are drawn, the commands and arguments an operation calls, how errors show) | WebdriverIO (real WKWebView and WebView2, commands mocked) | Processing inside Rust |

- Frontend TS holds only drawing and operation. Logic that needs a test is a pure Rust function.
- Tests never touch a real external service, the keychain or the real config folder.
  E2E builds use a separate identifier and an in-memory keyring.
- E2E mocks live only in `e2e/`.

```sh
npm run lint        # Biome (lint only)
npm run build:ts    # tsc (ts)
npm run e2e:check   # tsc (e2e)
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
cd src-tauri && cargo test --all-features    # also writes the ts-rs types to ts/bindings/
npm run e2e:build   # build the app for E2E (feature e2e)
npm run e2e         # WebdriverIO
scripts/check-version.sh [tag]   # the version in Cargo.toml, tauri.conf.json and Cargo.lock matches the tag
```

## CI

CI is `.github/workflows/ci.yml`, with one job per layer.

| Job | Environment | Checks |
|-----|-------------|--------|
| `static` | macos-latest | version match, `npm run lint`, `npm run build:ts`, `npm run e2e:check`, cargo fmt |
| `test` | macos-latest, windows-latest | clippy (`--all-targets --all-features`), cargo test (`--all-features`), bindings diff (macOS only) |
| `e2e` | macos-latest, windows-latest | `npm run e2e:build`, `npm run e2e` |
| `installer` | windows-latest (tags only) | the nsis installer artifact |

## Known limitations

- The access token expiry is not tracked. On a 401, the token is refreshed and the request is retried (also in the middle of `threads.get`).
- On a rate limit (429 or 403 `rateLimitExceeded`), interactive operations retry up to 2 times (they follow `Retry-After`, capped at 30 seconds).
  Auto sync does not retry. It backs off per account (`SyncState`).
- The app icon is a placeholder envelope (`src-tauri/icons/icon.svg`).
- There is no coverage tool.
- Windows support is built and tested in CI, but it has not been checked on a real Windows machine.

## Open questions

- Whether delete should stay "move to the trash" or also offer a permanent delete.
- Which calendar views are needed (week view with a selected-calendars filter is implemented; day, month and an event list are open).
- Whether the list should cover only the inbox, or also labels and search.
- Offline behavior (the last fetched inbox, events and tasks are shown from the config folder; whether operations should work offline is open).

## References

- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- OAuth 2.0 refresh token expiry: https://developers.google.com/identity/protocols/oauth2
