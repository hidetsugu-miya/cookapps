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
- Calendar, Todoist, Slack, Orca and Jira are integrations around the mail client.
- Jira means Jira Cloud (`https://{name}.atlassian.net`) only; the self-hosted Jira is out of scope.
- The app updates itself on macOS (Apple Silicon) only.
- Notion is a planned integration.

## Requirements

The full text of each requirement is in `requirements/`, one file per area, under a heading `## {ID} {name}`.
Read a requirement's section before you change its behavior, and change the section in the same pull request.
A new requirement gets a section there and an entry here.

| Area | File | Requirements |
|------|------|--------------|
| Mail | `requirements/mail.md` | M-1 List, M-2 Read, M-3 Delete, M-4 Archive, M-5 Multiple accounts, M-6 Mark read, M-7 Auto sync, M-8 AI summary, M-9 New mail popup (retired), M-10 Reply field, M-11 New mail, M-12 Attach files |
| Calendar | `requirements/calendar.md` | C-1 View, C-2 Event detail, C-3 First day of the week, C-4 Calendars to show, C-5 Create an event, C-6 Claude pane on the calendar screen, C-7 Edit and delete an event |
| Tasks | `requirements/tasks.md` | T-1 Todoist, T-2 Nest and unnest tasks, T-3 Comments, T-4 Labels, T-5 Count by due moment, T-6 Move a subtask from the detail, T-7 Claude pane on the Todo screen, T-8 Manage projects |
| Slack | `requirements/slack.md` | S-1 Paste a mail into Slack, S-2 Summarize a Slack message into a Todo, S-3 Edit the Todo summary prompt, S-4 Proofread the text to paste into Slack with Claude, S-5 Slack list, S-6 Slack thread, S-7 Ask Claude about the thread, S-8 Slack list: unread and read, S-9 Keep a channel off the Slack list, S-10 Emoji in Slack text, S-11 Blocks and attachments in the thread, S-12 Slack styles in the thread, S-13 Watch threads and the header of the Slack list, S-14 Unread replies in the Slack list, S-15 Mark a Slack channel read, S-16 Update the Slack list by Socket Mode events, S-17 New Slack message popup (retired), S-18 Revise the Todo draft with Claude, S-19 Slack side menu, S-20 Slack channel history, S-21 Post to a Slack channel, S-22 Reactions in Slack messages, S-23 Post to Slack by a request to Claude, S-24 Ask Claude on the Slack screen, S-25 Add and take off a reaction, S-26 Custom emoji in reactions as images, S-27 Claude mode and manual mode of the Slack compose screen |
| Notion | `requirements/notion.md` | N-1 Notion accounts |
| Jira | `requirements/jira.md` | J-1 Jira connection |
| Claude | `requirements/claude.md` | A-1 Claude integration, A-2 Claude model and effort, A-4 Claude connection, A-32 Skills tab, A-36 Claude Code pane |
| App | `requirements/app.md` | A-3 Settings tabs, A-5 Side menu by screen, A-20 Fonts by screen, A-23 No title bar, A-28 The app's log and the failure cards, A-35 Footer with the unread count |
| Orca | `requirements/orca.md` | A-6 Orca, A-7 Orca session history (retired), A-8 Orca terminal and project list, A-9 Hand to Orca, A-10 Attach a file in Orca, A-11 Answer a question in the Orca history (retired), A-12 Orca terminal stream, A-13 Ghostty settings in the Orca terminal, A-14 Terminal colors, A-15 Terminal appearance, A-16 Start from the plus of the Orca work pane, A-17 Split panes in the Orca work pane, A-18 Orca files and editor, A-19 Search the Orca list, A-21 Colors in the Orca editor, A-22 Download an Orca file, A-24 Orca file diff, A-25 Switch the branch from the Orca file pane, A-26 Rich Markdown view, A-27 Git history in the Orca file pane, A-29 Scratchpad in the Orca work pane, A-30 Scratchpad on an SSH host (retired), A-31 Open an Orca HTML file in the browser, A-33 This machine and a saved environment in one list, A-34 Go to a definition in the Orca editor, A-37 Orchestration on the development screen, A-38 Add a project to Orca, A-39 Git changes in the Orca file pane, A-40 Peek at a session of the Orca list in a modal, A-41 Develop a feature with feature-dev in a formation, A-42 Preview an Orca HTML file in the editor, A-43 Database in the Orca file pane, A-44 Git writes on the files of the Orca file pane, A-45 Open an HTML preview in a project's tab from Claude Code |
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

The constraints of one integration or one requirement are in `requirements/constraints.md`, under a heading for each area: Mail, Calendar, Slack, Settings files, Orca, Claude and skills, the app's log and fonts, Notion, Jira and Updates.
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
  Each service has its own module, and the list of the modules is in `src-tauri/AGENTS.md`.
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
The tools, and the arguments that start it for one use with fewer tools or for another job (`--formation`, `--calendar`, `--slack-compose`, `--todo-draft`, `--preview`, `--formation-start`, `--formation-message`, `--preview-plugin`, `--serve`), are in `src-tauri/AGENTS.md`.

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
Before a push, `pre-git.sh` checks that both records exist for HEAD, unless only release work (`README.md`, `CHANGELOG.md`, `docs/`) follows a commit that has them (`.claude/rules/testing.md`, `.claude/rules/review.md`).

## CI

The release is `.github/workflows/release.yml`, and only a pushed tag `v*` and the merge of the Release PR (a closed pull request from `release/next` into main, merged by the session that prepared it, with the repository's owner's account) start it (at the owner's instruction, 2026-11-09; #303); the merge is tagged and released in the run that it starts, and the session that merged it watches that run through (`.claude/skills/release/SKILL.md`, Procedure B).
Static, unit and E2E checks run on the developer's machine before a push, not in GitHub Actions (`.claude/rules/testing.md`), so a pull request runs no check of this repository: closing one starts `release.yml`, which does nothing unless it is the merged Release PR.
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
