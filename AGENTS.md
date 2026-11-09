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
| Tasks | `requirements/tasks.md` | T-1 Todoist, T-2 Nest and unnest tasks, T-3 Comments, T-4 Labels, T-5 Count by due moment, T-6 Move a subtask from the detail |
| Slack | `requirements/slack.md` | S-1 Paste a mail into Slack, S-2 Summarize a Slack message into a Todo, S-3 Edit the Todo summary prompt, S-4 Proofread the text to paste into Slack with Claude, S-5 Slack list, S-6 Slack thread, S-7 Ask Claude about the thread, S-8 Slack list: unread and read, S-9 Keep a channel off the Slack list, S-10 Emoji in Slack text, S-11 Blocks and attachments in the thread, S-12 Slack styles in the thread, S-13 Watch threads and the header of the Slack list, S-14 Unread replies in the Slack list, S-15 Mark one Slack row read, S-16 Update the Slack list by Socket Mode events |
| Integration | `requirements/integration.md` | A-1 Claude integration, A-2 Claude model and effort, A-4 Claude connection, A-3 Settings tabs, A-5 Side menu by screen, A-6 Orca, A-7 Orca session history, A-8 Orca terminal and project list, A-9 Hand to Orca, A-10 Attach an image in Orca, A-11 Answer a question in the Orca history, A-12 Orca terminal stream, A-13 Ghostty settings in the Orca terminal, A-14 Terminal colors, A-15 Terminal appearance, A-16 Start from the plus of the Orca work pane, A-17 Split panes in the Orca work pane, A-18 Orca files and editor, A-19 Search the Orca list, A-20 Fonts by screen, A-21 Colors in the Orca editor |
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
- Updates use `tauri-plugin-updater`. Pushing the annotated tag `v{version}`, or merging the Release PR (which makes that tag, `release.yml`), starts the `release` job, which makes `cookapps.app.tar.gz`, its `.sig` and `latest.json` (`scripts/make-latest-json.sh`) and puts them in a GitHub Release.
  The app reads `releases/latest/download/latest.json` (`plugins.updater.endpoints` in `tauri.conf.json`) and verifies the download with the public key `plugins.updater.pubkey`.
  `bundle.createUpdaterArtifacts` is not in `tauri.conf.json`; the `release` job passes it with `--config`, so a local build needs no signing key.
  The version is the tag's alone (at the owner's instruction, 2026-11-09; Discussion #293): `version` in `src-tauri/Cargo.toml` and `Cargo.lock` is fixed at `0.0.0` and `tauri.conf.json` has none, and the `release` job passes the version of the tag with `--config` too, which Info.plist, `app.package_info()` (U-2) and the updater's comparison take. A build without it (`tauri dev`, E2E) reports `0.0.0`, and `scripts/install-app.sh` passes the latest tag.
- The refresh token is stored locally so the user does not log in at every start.
- Tokens go in the OS keychain (macOS Keychain, Windows Credential Manager), never in a plain file.
- The list of accounts (email addresses only) is saved in `accounts.json` in the app config directory.
- The last weeks of the calendar, with the details of their events (place, description, Meet link and so on), are saved in `calendar-cache.json` in the same place; the first day of the week is in `calendar-settings.json`, the model and effort of the five purposes of the Claude calls are in `claude-settings.json`, and the Orca to talk to (this machine or a saved environment) is in `orca-settings.json`. The method the Claude calls sign in with is in `claude-auth.json` there, and the Anthropic API key is in the OS keychain (service `jp.mysis.cookapps.claude`).
- The history of an Orca session (A-7) is read from Orca's own files, `orca-runtime.json` (this machine, over its unix socket, polled every 3 seconds) and `orca-environments.json` (a paired server, over a WebSocket with end-to-end encryption), in Orca's settings folder; they are read at each connect and never written, and no token or key from them is kept, logged or shown. It was written against Orca 1.4.248 and an Orca update can change it.
- The SSH hosts come from `ssh.listEditableTargets` of Orca's runtime (the socket of A-7), which is not a public interface.
- An image pasted or dropped on an Orca terminal or in the pane of A-9 (A-10) is put in `.orca/drops/` of the worktree through `files.stat`, `files.writeBase64Chunk`, `files.commitUpload` and `files.delete` of Orca's runtime (this machine's unix socket, a paired server's WebSocket), which are not a public interface. It was written against Orca 1.4.248, and an Orca update can change it. The image is held in memory only, and the window's own file drop is off (`dragDropEnabled` false) so that the page gets the dropped files.
- A plain terminal started from the plus of the Orca work pane (A-16) is made by Orca's CLI, `orca terminal create --worktree path:<path> --json` (`--environment=<name>` for a saved environment), run once, in a worktree of the list read just before, with an argument list and a timeout; its reply `result.terminal.handle` names the terminal. It was checked on Orca 1.4.250 (its help and its CLI source), and an Orca update can change it.
- How the Orca work pane is split into panes (A-17) is saved for each project of each target in `orca-panes.json` in the app config directory: a tree of panes and splits that holds only tab ids (`claude:{pane key}`, `orca:{handle}`, `file:{n}` for a file open in the editor of A-18) and project keys of Orca, mended against the tabs Orca lists at each read, never holding what a terminal printed or was typed.
- The files of a worktree on the Orca screen (A-18) are read and saved through `files.readDir`, `files.read`, `files.writeIfUnchanged` and `git.checkIgnored` of Orca's runtime (this machine's unix socket, a paired server's WebSocket, the connection of A-10), which are not a public interface. They were read in the `app.asar` of Orca 1.4.253 and tried on this machine's Orca (a saved environment was not tried), and an Orca update can change them. A file is written only when the disk still holds the text that was read, by Orca's own signature of it, so a file changed elsewhere is never overwritten; only text of at most 384 KiB that is UTF-8 and has one kind of line end is opened. The text of a file is held in memory only and is in no log or file of the app. The time of the automatic save is in `editor-settings.json` in the app config directory.
- The editor of A-18 colors a file by its language (A-21) with highlight.js, vendored in `src/vendor/` and loading nothing from outside. The language is decided in Rust from the file name, the extension and the first line, with tables taken from Orca 1.4.254's `app.asar` (`editor-language-detect.js` and `monaco-language-associations.json`), which are not a public interface; an Orca update can change them.
- The font (the family and the size) of each screen and of the editor (A-20) is in `font-settings.json` in the app config directory; the family names to choose from are read from this Mac's fonts with CoreText (`CTFontManagerCopyAvailableFontFamilyNames`, through the `objc2-core-text` crate) at each start and kept in no file, and no font is loaded from outside.
- The Orca screen's list and terminals of a saved environment (A-12) are streamed over its WebSocket with `session.tabs.subscribeAll`, `terminal.subscribe`, `terminal.updateViewport`, `terminal.unsubscribe` and `terminal.send` of Orca's runtime, which are not a public interface. They were checked on Orca 1.4.249, and an Orca update can change them. This machine's Orca cannot stream to this app (its unix socket refuses streaming methods, and its WebSocket takes only a paired device's token), so a terminal of this machine is only mirrored, by reading its screen every second: no colors, and full-screen programs are approximate.
- A program in an Orca terminal can write the clipboard with OSC 52 (A-12): the page decodes the request and calls `navigator.clipboard.writeText` (no Tauri command, no file; a refused write leaves the text held in memory for the next copy event), only for a request the terminal prints live (not a snapshot or a mirror frame), for the target `c` or none, with base64 of at most 128 KiB; a read (`?`) is never answered. The limits follow Orca 1.4.250's `osc52-clipboard.js`.
- An answer to a question of Claude in the Orca history (A-11) is typed into the session's terminal, one key at a time (digits and Tab only), with `orca terminal send` after a read of the screen by `orca terminal read --screen` that shows what the key is for (this machine and a saved environment, by the CLI). It was written against Claude Code 2.1.318 and Orca 1.4.249; the screens it waits for are Claude Code's wording, and an update can change them (then nothing is typed).
- Ghostty's settings for the Orca terminals (A-13) are read from Ghostty's config files (`~/.config/ghostty/` and `~/Library/Application Support/com.mitchellh.ghostty/`, `config.ghostty` and `config`) and theme files only when the owner presses the import button, and are never written. What the terminals take from them is saved in `ghostty-settings.json` in the app config directory, with the entries imported and left. The places and the format follow Orca 1.4.250's own Ghostty import and Ghostty 1.4.0, and an update of either can change them.
- The colors of the Orca terminals (A-14) are the built-in themes of Orca 1.4.250, a table that the app holds (`src-tauri/src/orca_themes.json`, taken from Orca's `app.asar`), and the theme chosen for the light and for the dark appearance, with which of them the terminals draw (the system's appearance, or always the light or the dark one, A-15), is saved in `terminal-theme.json` in the app config directory. The first time the settings of the Orca on this Mac can be read, they give the choice: `terminalThemeLight` and `terminalThemeDark` of the `settings` row in `profiles/local-default/profile-state.db` (SQLite) in Orca's settings folder, which is not a public interface and was read on Orca 1.4.250. That file is opened read-only with `rusqlite` and never written, and its content is not kept or logged. An Orca update can change it (then the defaults are used).
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
tmp/           scratch files, gitignored except .keep
```

- The frontend is plain TypeScript, HTML and CSS.
  `ts/` is split into one module per screen.
  The screens show no help text: no placeholder or line of text that explains what to type or what a button does (at the owner's instruction, 2026-11-08). The rule is in `.claude/rules/frontend.md`.
- The backend is Rust.
  Each service has its own module: `gmail.rs`, `calendar.rs`, `todoist.rs`, `slack.rs`, `claude.rs`, `orca.rs` (with `orca_chat.rs` and `orca_e2ee.rs` for the session history, `orca_handoff.rs` for the prompt of A-9 and its folding in the history, `orca_attach.rs` for the images of A-10, `orca_answer.rs` for the answers of A-11, and `orca_stream.rs` for the stream of A-12, `orca_panes.rs` for the split panes of A-17, `orca_files.rs` for the file pane and the editor of A-18, `orca_language.rs` for the language of an open file, A-21), `fonts.rs` (the fonts by screen, A-20), `ghostty.rs` (Ghostty's settings for the Orca terminals, A-13), `orca_theme.rs` (the colors of the Orca terminals, A-14, with the table `orca_themes.json`).
  The modules are in the library crate (`src-tauri/src/lib.rs`), and `main.rs` only calls `cookapps_lib::run()`.
- Internal functions take the config directory (`&Path`), not an `AppHandle`, so `cookapps-mcp` can share them.
- The Rust version is pinned in `rust-toolchain.toml` and in the CI workflows (`release.yml` and `rust-cache.yml`, by the ref of `dtolnay/rust-toolchain`). Keep them equal.
- `.cargo/config.toml` sets `MACOSX_DEPLOYMENT_TARGET` to the value `tauri build` takes from `bundle.macOS.minimumSystemVersion` (default 10.13), so `tauri dev`, clippy and `cargo test` share the dependency builds of the E2E and release builds instead of rebuilding them. Keep the two equal.

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
| Static | Format, lint, types, Rust-TS type match, fixed source version | cargo fmt, clippy, Biome (lint only), tsc, bindings diff, `scripts/check-version.sh` | Behavior |
| Unit | Pure Rust logic (parsing API responses, validating input, computing dates, IDs and URLs, converting errors) | cargo test | Screens, WebView |
| E2E | Screen behavior (how command results are drawn, the commands and arguments an operation calls, how errors show) | WebdriverIO (real WKWebView, commands mocked) | Processing inside Rust |

- Frontend TS holds only drawing and operation. Logic that needs a test is a pure Rust function.
- Tests never touch a real external service, the keychain or the real config folder.
  E2E builds use a separate identifier and an in-memory keyring.
- E2E mocks live only in `e2e/`.
- Each E2E run starts one app for each of its capabilities and gives each a free WebDriver port, so runs from the main checkout and from the worktree can overlap.

```sh
npm run lint        # Biome (lint only)
npm run build:ts    # tsc (ts)
npm run e2e:check   # tsc (e2e)
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
cd src-tauri && cargo test --all-features    # also writes the ts-rs types to ts/bindings/
npm run e2e:build   # build the app for E2E (feature e2e)
npm run e2e         # WebdriverIO
scripts/check-version.sh   # the source version is the fixed one: 0.0.0 in Cargo.toml and Cargo.lock, none in tauri.conf.json
```

`.claude/tools/run-ci.sh` runs the static checks and unit tests above (all but the E2E two) on a clean working tree and writes a record for HEAD, and `.claude/tools/run-e2e.sh` does the same for E2E.
Before a push, `pre-git.sh` only checks that both records exist for HEAD.

## CI

The release is `.github/workflows/release.yml`, and only a pushed tag `v*` and the owner's merge of the Release PR (a closed pull request from `release/next` into main, merged by the repository's owner) start it (at the owner's instruction, 2026-11-09; #303).
Static, unit and E2E checks run on the developer's machine before a push (`run-ci.sh` and `run-e2e.sh`, with a record for each HEAD that `pre-git.sh` checks), not in GitHub Actions, so a pull request runs no check of this repository: closing one starts `release.yml`, which does nothing unless it is the merged Release PR.
A push to main that changes the dependencies, the Rust version or `docs/` runs two workflows, and neither checks anything: `rust-cache.yml` builds the Rust dependencies of the release to fill the cache that `release` restores (at the owner's instruction, 2026-11-08; #248), and `pages.yml` builds `docs/` with Jekyll and deploys it to GitHub Pages.
A change reaches main through a pull request, and the machine that ran the checks sends their results as the commit statuses `e2e` and `review`.
A release is the owner's merge of the Release PR, the pull request that writes the new version at the top of `CHANGELOG.md` (an agent prepares it, `.claude/rules/issues.md`), which `release.yml` tags and releases at once, in the run that the merge starts; the next agent to act watches that run through (an agent tags by hand only when the workflow did not, `.claude/rules/issues.md`).

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
