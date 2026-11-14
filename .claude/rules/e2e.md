---
paths:
  - "e2e/**/*"
  - "wdio.conf.ts"
  - "src-tauri/tauri.e2e.conf.json"
---

# E2E rules

## Specs

### Keep one `e2e/specs/{screen}.e2e.ts` per screen

A spec checks how a screen behaves. One `it` checks one operation and its result (what is drawn, and the arguments of the commands called).
It does not check the processing inside Rust (`testing.md`).
With one spec per screen, the spec for the screen you are fixing is easy to find.
A screen whose spec runs much longer than the others is split by its parts, each part a spec named `{screen}-{part}.e2e.ts`, so that the parts run in different apps (#613): the Orca screen is `orca.e2e.ts` and `orca-files.e2e.ts` (the file pane and the editor, A-18 and the requirements built on it).
What the specs of one screen share is in `e2e/{screen}-support.ts` (`e2e/orca-support.ts`), which builds on `support.ts`; a helper that one spec uses stays in that spec.

```ts
// Good: the call and the screen, per operation
const archive = await mock("archive", true);
await row.$(".archive-row").click();
expect(await waitForCalls(archive)).toEqual([{ account, id: "t1" }]);
```

### Use `boot()` to start, `mock()` for commands, `callsOf()` for calls

`boot(fixtures)` puts the values for the commands answered at startup into `e2e-fixtures` in `sessionStorage` and reloads the page.
`mock(command, value)` changes that command's answer and clears its call record. A reload clears both, so call `mock` after `boot`.
The app calls some commands while it starts, before a spec can `mock` them.

```ts
await boot({ inbox: inbox() });
const trash = await mock("trash", true);
```

### Shorten a timer the spec waits for with `timers()`, and wait its period times 1.2

A spec that must wait out an app timer (the Orca list's clock, the terminal mirror, the new mail popup) puts `timers({ orcaClock, orcaMirror, arrival })` in the fixtures of `boot`, in milliseconds, and waits the shortened period times 1.2.
`fixtures.js` sets `window.__e2e_timers__` from it, which only the E2E build has, and `periodMs` (`ts/e2e-timers.ts`) reads it, so the periods of the app never change.

```ts
await boot({ inbox: inbox(), ...timers({ arrival: 1000 }) });
await browser.pause(1200);
```

## Mocks

### Put mocks only in `e2e/fixtures.js` and `e2e/support.ts`

`fixtures.js` wraps `window.__TAURI__.core.invoke` and returns the answers. `support.ts` holds `boot`, `mock`, `callsOf` and the typed fixture data.
If mocks are scattered, nobody can tell which are alive, and the gap from the real thing is hidden.
Do not write mocks or `@wdio` in `src/`, and do not make throwaway mocks (`guard-e2e.sh` blocks them).

```text
Good: put the answer for a new command in the base answers of fixtures.js, or in a spec's mock()
Bad:  write an HTML file in the scratchpad that replaces window.__TAURI__, and open it in Chrome
```

### Make unmocked commands fail

When the app calls an unknown command, `fixtures.js` rejects it, and `wdio.conf.ts` names it in the failed test.
This keeps a missing mock from turning into traffic to the real Gmail or the keychain.

```text
Good: when you add a command, add its answer to fixtures.js or to a spec's mock()
Bad:  swallow the failed command with try/catch to make the test pass
```

### Write fixture values with ts-rs types, and use example values only

The fixtures in `support.ts` carry the types in `ts/bindings/`, so tsc (`npm run e2e:check`) fails when a struct changes shape.
Use only example.com addresses and invented names. The repository is public, and a real value would stay in the history.

```ts
export const thread = (id: string, subject: string): ThreadItem => ({ id, account: "me@example.com", subject /* … */ });
```

## Do not touch the real thing

### Cut E2E runs off from the owner's environment

`src-tauri/tauri.e2e.conf.json` sets the identifier to `jp.mysis.cookapps.e2e` and the window to `visible: false`.
A build with the `e2e` feature replaces keyring with an in-memory mock, and on macOS it does not take the Dock or the focus.
This keeps the everyday cookapps settings folder, keychain and screen out of it.

```sh
npm run e2e:build
npm run e2e
```

## Running and recording

### Run E2E with `.claude/tools/run-e2e.sh`, and keep a record per HEAD

Run it when the working tree is clean (after a commit).
`run-e2e.sh [checkout path]` runs `e2e:build` and `e2e` (and, beside `e2e`, `run-ci.sh` when HEAD has no passing CI record; see below), then writes JSON (sha, version, clean, passed, tests, script_timeouts, finished_at) to `.claude/e2e/{HEAD SHA}` in the main checkout, and the full output to `.claude/e2e/{HEAD SHA}.log`.
`script_timeouts` counts the WebDriver commands whose result never came back. A passing run can hide them behind webdriver's retry, so read this count and the log before saying anything about E2E speed or stability.
`pre-git.sh`, `post-checks.sh` and release-verifier use this record, through `.claude/tools/check-e2e.sh`, to confirm that E2E passed for HEAD. The record of the static checks and unit tests has the same shape in `.claude/ci/{HEAD SHA}` (`run-ci.sh`, `check-ci.sh`; `testing.md`).
`guard-e2e.sh` blocks every write to either record except a direct call of its own command (`run-e2e.sh`, `run-ci.sh`). Never write them by hand.
After `e2e:build`, `run-e2e.sh` starts `run-ci.sh` of its own checkout in the background (under `nice -n 10`, so that wdio keeps the cores), if `check-ci.sh` finds no passing, clean CI record for HEAD, and runs `e2e` beside it (#420). cargo is used only up to `e2e:build`, and wdio runs the built binary, so the two do not wait for each other's `target/debug` lock, and `cargo test` and clippy never write `target/debug/cookapps` (no integration test builds it). The CI record is `run-ci.sh`'s as before, and the record of E2E is the result of E2E alone (`passed`, `tests`, `script_timeouts`); the exit code of `run-e2e.sh` is non-zero when either failed, and the output of `run-ci.sh` is printed after the E2E lines. `--only` runs no CI.

```sh
.claude/tools/run-e2e.sh   # in the main checkout
"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/run-e2e.sh"   # in a worktree: the main checkout's copy, which the gates use
```

### Let runs overlap, because each app takes its own port

One run starts five apps, one per capability, and `onPrepare` in `wdio.conf.ts` gives each app a free WebDriver port.
Each checkout has its own E2E binary and `e2e/dist`.
So runs from the main checkout and from the worktree can overlap, and there is no need to wait for the other.
Do not set a fixed port: the service waits for any WebDriver server on its port, so a second run on the same port drives the first run's app and reports on the wrong code.

```text
Good: the main checkout and the worktree run run-e2e.sh at the same time
Bad:  set embeddedPort to the fixed value 4445 in wdio.conf.ts
```

### Split the specs among the five apps in `wdio.conf.ts`, and do not pass `--spec`

The capabilities name their specs, and a spec named nowhere runs in the last app, so a new spec needs no change there.
`--spec` overrides the specs of the capabilities, so the same spec runs in several apps and the passing count grows.

```text
Good: add e2e/specs/foo.e2e.ts and let it run in the last app
Bad:  wdio run wdio.conf.ts --spec e2e/specs/inbox.e2e.ts, which runs inbox in more than one app
```

### Run one failed spec alone with `run-e2e.sh --only`, the one exception to "do not pass `--spec`"

`run-e2e.sh --only {spec name}` (for example `--only inbox`) runs `e2e/specs/{name}.e2e.ts` in one app, builds first (`e2e:build`), and writes no record: it works on a dirty tree, and its output goes to `.claude/e2e/only-{name}.log` (at the owner's instruction, 2026-11-12; #485).
It sets `E2E_ONLY`, which `wdio.conf.ts` reads to cut the capabilities down to one that names that spec. The specs are not passed with `--spec`, so the spec does not run in several apps.
Use it to run a spec that failed in `run-e2e.sh` until it passes, then run `run-e2e.sh` once for the record. It is not a record, and `pre-git.sh` and release-verifier do not accept it.

```sh
.claude/tools/run-e2e.sh --only todo-prompt   # one app, one spec, no record
```

```text
Good: run-e2e.sh fails in inbox -> fix -> run-e2e.sh --only inbox until it passes -> run-e2e.sh once
Bad:  wdio run wdio.conf.ts --spec e2e/specs/inbox.e2e.ts, which runs inbox in more than one app
Bad:  take a pass of --only for the E2E record
```
