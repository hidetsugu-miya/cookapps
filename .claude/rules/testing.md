# Testing rules

## Layers

### Split checks into static, unit and E2E, and never check the same thing in two layers

| Layer | What it checks | Tools | What it does not check |
|-------|----------------|-------|------------------------|
| Static | Format, lint, types, Rust-TS type match, fixed source version | cargo fmt, clippy, Biome (lint only), tsc, bindings diff, `scripts/check-version.sh` | Behavior |
| Unit | Pure Rust logic (parsing API responses, validating input, computing dates, IDs and URLs, converting errors) | cargo test | Screens, WebView |
| E2E | Screen behavior (how command results are drawn, the commands and arguments an operation calls, how errors show) | WebdriverIO (real WKWebView, commands mocked) | Processing inside Rust |

When layers overlap, the same failure shows up twice and nobody knows where to fix it.
Unit tests own everything behind the E2E mock, and E2E owns everything in front of it.

```text
Good: put date computation in a Rust function and check it with cargo test
Good: check that pressing a list row calls archive with E2E
Bad:  check the result of a date computation from the text on the screen in E2E
```

### Put only drawing and operation in the frontend TS, and turn logic you want to test into a pure Rust function

We have no unit-test tool for TS. If logic that needs a test lives in TS, move it to Rust and check it with cargo test.
Testing pure TS would need one more tool and one more layer, and it would blur the line with E2E.

```text
Good: the deadline decision is a Rust function, and TS only draws the result
Bad:  write the deadline decision in TS and add a unit-test tool
```

### Let types own the shape at the Rust-TS boundary, and do not test it

For return structs, ts-rs writes the types to `ts/bindings/`, and tsc checks how TS uses them. The bindings diff before a push fails if the committed types are stale.
A test of the shape itself would duplicate the types and add a place to fix every time a struct changes.

```rust
// Good: the shape is the struct's; nothing tests it
#[derive(Serialize, TS)]
#[ts(export, export_to = crate::BINDINGS)]
struct Item { id: String }
```

### Do not write tests that touch a real external service, the keychain or the settings folder

Unit tests use pure functions and a local `TcpListener` (`rust.md`), and E2E uses command mocks and a separate identifier (`e2e.md`). That is enough.
If a test touches the owner's account or tokens, every run changes real data.

```text
Good: use the JSON of a Gmail response as the input to parse
Bad:  call the real Gmail API from a test
```

## Before a push and CI

### Run every check on this machine before a push, and run no check in GitHub Actions

`.github/workflows/release.yml` runs only on a pushed tag `v*`, and its one job, `release`, checks that the source version is still the fixed one, that the tag has the form `v0.{minor}.{patch}` and that the commit is on main, and builds the app with the version of the tag, and puts the signed `.app`, its updater files and `latest.json` in a GitHub Release (U-1).
A pull request runs no workflow of ours, and a push to main that changes the dependencies, the Rust version or `docs/` runs none that checks anything (at the owner's instruction, 2026-11-04: the same checks already ran before the push, and running them again cost time).
The two workflows of such a push are `rust-cache.yml`, which only builds the Rust dependencies to fill the cache that `release` restores (at the owner's instruction, 2026-11-08; #248), and `pages.yml`, which builds `docs/` and deploys it to GitHub Pages.
Before a push, `.claude/tools/run-ci.sh` runs the version check (the source version is the fixed value), tsc (`ts` and `e2e`), Biome, cargo fmt, clippy, cargo test and the bindings diff, and writes a record for HEAD to `.claude/ci/{HEAD SHA}` in the main checkout. It runs on a clean working tree only, and only it can write the record (`guard-e2e.sh`).
`pre-git.sh` runs none of these checks. If there are new commits, it checks the CI record, the E2E record (`e2e.md`) and the review pass record (`review.md`) for HEAD, through `check-ci.sh`, `check-e2e.sh` and the pass file; a push with no new commit (a tag on a commit already on the remote) needs none of them. The record is needed on a Release PR's HEAD too, because the records are per HEAD.
`post-checks.sh` checks the same records and then sends the E2E and review results to GitHub as the statuses `e2e` and `review`, which the ruleset on main requires (`issues.md`); no workflow runs for them.
These checks run only on macOS; nothing checks Windows.

```text
Good: commit -> run-ci.sh -> run-e2e.sh -> review -> push (pre-git.sh checks the records) -> post-checks.sh -> merge
Bad:  add a static, test or e2e job to the workflow
Bad:  write a CI record by hand, or run the checks inside pre-git.sh again
```
