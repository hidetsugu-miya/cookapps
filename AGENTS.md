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
| Calendar | `requirements/calendar.md` | C-1 View, C-2 Event detail, C-3 First day of the week, C-4 Calendars to show |
| Tasks | `requirements/tasks.md` | T-1 Todoist, T-2 Nest and unnest tasks, T-3 Comments, T-4 Labels, T-5 Count by due moment, T-6 Move a subtask from the detail, T-7 Claude pane on the Todo screen |
| Slack | `requirements/slack.md` | S-1 Paste a mail into Slack, S-2 Summarize a Slack message into a Todo, S-3 Edit the Todo summary prompt, S-4 Proofread the text to paste into Slack with Claude, S-5 Slack list, S-6 Slack thread, S-7 Ask Claude about the thread, S-8 Slack list: unread and read, S-9 Keep a channel off the Slack list, S-10 Emoji in Slack text, S-11 Blocks and attachments in the thread, S-12 Slack styles in the thread, S-13 Watch threads and the header of the Slack list, S-14 Unread replies in the Slack list, S-15 Mark a Slack channel read, S-16 Update the Slack list by Socket Mode events, S-17 New Slack message popup, S-18 Revise the Todo draft with Claude, S-19 Slack side menu, S-20 Slack channel history, S-21 Post to a Slack channel, S-22 Reactions in Slack messages, S-23 Post to Slack by a request to Claude, S-24 Ask Claude on the Slack screen, S-25 Add and take off a reaction, S-26 Custom emoji in reactions as images |
| Claude | `requirements/claude.md` | A-1 Claude integration, A-2 Claude model and effort, A-4 Claude connection |
| App | `requirements/app.md` | A-3 Settings tabs, A-5 Side menu by screen, A-20 Fonts by screen, A-23 No title bar, A-28 The app's log |
| Orca | `requirements/orca.md` | A-6 Orca, A-7 Orca session history (retired), A-8 Orca terminal and project list, A-9 Hand to Orca, A-10 Attach a file in Orca, A-11 Answer a question in the Orca history (retired), A-12 Orca terminal stream, A-13 Ghostty settings in the Orca terminal, A-14 Terminal colors, A-15 Terminal appearance, A-16 Start from the plus of the Orca work pane, A-17 Split panes in the Orca work pane, A-18 Orca files and editor, A-19 Search the Orca list, A-21 Colors in the Orca editor, A-22 Download an Orca file, A-24 Orca file diff, A-25 Switch the branch from the Orca file pane, A-26 Rich Markdown view, A-27 Git history in the Orca file pane, A-29 Scratchpad in the Orca work pane, A-30 Scratchpad on an SSH host, A-31 Open an Orca HTML file in the browser |
| Updates | `requirements/updates.md` | U-1 Auto update, U-2 Update settings and version |

### Out of scope

- Saving drafts of mail (a mail is written and sent in one go)
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

The constraints of one integration or one requirement are in `requirements/constraints.md`, under a heading for each area: Mail, Slack, Settings files, Orca, Claude and skills, the app's log and fonts, Notion and Updates.
Read an area's section there before you change a behavior it covers, and when a change makes a constraint different, change the section in the same pull request.

## Stack and layout

```text
ts/            TypeScript, compiled by tsc to src/js/ (gitignored). No framework, no bundler
ts/bindings/   Rust struct types written by ts-rs (generated, committed)
src/           index.html, CSS, vendored libraries (src/vendor/)
src-tauri/     Rust backend (Tauri v2); src/bin/cookapps-mcp.rs is the MCP server
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
  Each service has its own module: `gmail.rs` (with `gmail/held.rs`, the opened threads held in memory for a reopen, M-2), `calendar.rs`, `todoist.rs`, `notion.rs` (Notion's MCP server: the OAuth connection and the tokens), `slack.rs` (with `slack_markdown.rs`, which turns Markdown into Slack's mrkdwn, S-6 and S-21, `slack_mrkdwn.rs`, which reads Slack's mrkdwn as the structure the thread draws, S-12, `slack_blocks.rs`, which reads a message's blocks and attachments, S-11, `slack_emoji.rs`, the table of Slack emoji names that the `emojis` crate lacks, and `slack/socket.rs`, the Socket Mode connection, S-16), `claude.rs` (with `claude_auth.rs`, how `claude -p` is signed in, A-4), `orca.rs` (with `orca_link.rs` and `orca_e2ee.rs` for the connection to Orca's runtime, `orca_handoff.rs` for the prompt of A-9, `orca_attach.rs` for the files of A-10, and `orca_stream.rs` for the stream of A-12, `orca_panes.rs` for the split panes of A-17, `orca_files.rs` for the file pane and the editor of A-18, the download of A-22, the reading of the diff of A-24, the reading and the switch of the branches of a worktree, and the commits of a worktree, the files of a commit and the diff of one of them (A-27), `orca_preview.rs` for the HTTP server on `127.0.0.1` that serves the files of a worktree to the default browser, and the open of an HTML file in it, A-31, `orca_diff.rs` for the comparison of A-24, `orca_language.rs` for the language of an open file, A-21), `ssh_scratch.rs` (the scratchpad of an SSH host, through the `ssh` command, A-30), `fonts.rs` (the fonts by screen, A-20), `app_log.rs` (the app's log, A-28), `skills.rs` (the skills of the Claude calls, saved as `SKILL.md` files in `claude-plugin/` of the config directory), `ghostty.rs` (Ghostty's settings for the Orca terminals, A-13), `orca_theme.rs` (the colors of the Orca terminals, A-14, with the table `orca_themes.json`).
  The modules shared by the services are `accounts.rs` (the list of accounts in `accounts.json`, and the atomic write of a settings file), `auth.rs` (the OAuth login, the tokens and the keychain), `mail_address.rs` (splits a From or To header into a name and an address), `mail_send.rs` (builds the message of a new mail or a reply and sends it with `users.messages.send`, the command `send_mail`), `images.rs` (the images in HTML mail, with `images/macos.rs`, which fetches an external image with NSURLSession) with `image_senders.rs` (the senders whose external images are shown without asking), `disk_cache.rs` (the kept copies of the last mail list, calendar weeks and Todo that the screen draws first at startup), `markdown_patch.rs` (puts an edit of the rich Markdown editor into the original text by lines, A-26) and `update.rs` (the self-update and its settings, U-1 and U-2).
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
npx tsc --noEmit -p .claude/skills/readme-product/shots/tsconfig.json   # tsc (the spec of the README photos)
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
cd src-tauri && cargo test --all-features    # also writes the ts-rs types to ts/bindings/
npm run e2e:build   # build the app for E2E (feature e2e)
npm run e2e         # WebdriverIO
scripts/check-version.sh   # the source version is the fixed one: 0.0.0 in Cargo.toml and Cargo.lock, none in tauri.conf.json
```

`.claude/tools/run-ci.sh` runs the static checks and unit tests above (all but the E2E two) on a clean working tree and writes a record for HEAD, and `.claude/tools/run-e2e.sh` does the same for E2E, and runs `run-ci.sh` beside its wdio run after `e2e:build` when HEAD has no passing CI record.
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
