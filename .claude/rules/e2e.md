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

A spec that must wait out an app timer (the Orca list's clock, the terminal mirror, the read of the connections of the database screen, the read of the children by the flow pane, the read of the language servers' settings) puts `timers({ orcaClock, orcaMirror, databaseProfiles, formationFlow, lspSettings })` in the fixtures of `boot`, in milliseconds, and waits the shortened period times 1.2.
`fixtures.js` sets `window.__e2e_timers__` from it, which only the E2E build has, and `periodMs` (`ts/e2e-timers.ts`) reads it, so the periods of the app never change.

```ts
await boot({ inbox: inbox(), ...timers({ orcaMirror: 1000 }) });
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

## Capabilities and events

### Run the E2E app with the production capability, and add only WebDriver's permissions

`src-tauri/tauri.e2e.conf.json` lists the capability `default` (`src-tauri/capabilities/default.json`, the one the production app has) and a second capability `e2e` that holds only `wdio:default` and `wdio-webdriver:default`.
Never add another permission to `e2e`, and never give the E2E app a capability of its own in place of `default`, such as `core:default`: a permission that only E2E has makes a spec pass on a call that the production app refuses.
At the owner's instruction, 2026-11-19; #1068. Production lacked `core:event`, so every `listen` of the screens was refused there, while E2E ran with `core:default` and passed (#1066). From v0.88.1 (#731) to v0.90.0 the screen bridge, the Slack Socket Mode updates, the language server status and the output of the database script never reached the screens in production.

```text
Good: a screen starts to use `window.__TAURI__.window` -> the permission goes into capabilities/default.json -> E2E, which has `default`, fails until it does
Bad:  add "core:default" to the `e2e` capability so that a new call stops being refused in E2E
```

### Do not take an event that E2E sends for proof that the app's own event arrives

`emitEvent` of `e2e/support.ts` makes the page call `event.emit`, so the page sends the event to itself and Rust is not on the way.
A spec that uses it checks how the screen reacts to an event, and nothing about whether the event reaches the screen from `app.emit` of Rust (the permission, the event name, the target window).
When a change adds or changes a feature that receives such an event, check once on the production path that the event arrives: through the socket, the Socket Mode task or the process that emits it, in the app a build makes (`tauri dev` or a release build, not the E2E build).
In a session that cannot start the app, state in the pull request that this was not checked and what to check, and leave it to the owner (`issues.md`, "File a bug only after reproducing it").

```text
Good: the screen bridge asks the screen to read a field -> a spec with emitEvent checks the redraw, and `screen_read` through the socket is run once in the app built for the owner
Bad:  a feature of `app.emit` is called checked because its spec calls emitEvent
```

## Do not touch the real thing

### Cut E2E runs off from the owner's environment

`src-tauri/tauri.e2e.conf.json` sets the identifier to `jp.mysis.tsunagiai.e2e` and the window to `visible: false`.
A build with the `e2e` feature replaces keyring with an in-memory mock, and on macOS it does not take the Dock or the focus.
This keeps the everyday つなぎAI settings folder, keychain and screen out of it.

```sh
npm run e2e:build
npm run e2e
```

## Running and recording

### Run E2E once, when the Release PR is prepared, not for a feature's pull request

A feature's pull request runs `run-ci.sh` and the review, and no `run-e2e.sh`. `run-e2e.sh` runs once, on the branch `release/next`, after it has taken in main and written `CHANGELOG.md`, before the push (`.claude/skills/release/SKILL.md`). The result is a condition of the Release PR's merge: `pre-git.sh` refuses the push of `release/next` without that record, and `post-checks.sh` sends the status `e2e` of that PR only with it (`check-release-e2e.sh`). For every other branch `post-checks.sh` sends `e2e` as `success` with the description "E2E runs at the Release PR", because the ruleset of main requires `e2e` and cannot tell the branches apart (`issues.md`).
At the owner's instruction, 2026-11-19; #1023. GitHub's runner took about 13 minutes for one run, and some specs failed only on the runner, so the run is local, and once for the Release PR (measured in #1021).
When a feature changes or adds a spec in `e2e/specs/`, run that spec with `run-e2e.sh --only {spec name}` until it passes before the pull request: it writes no record and is no gate, but a new spec must not wait for the Release PR to run for the first time.

```text
Good: a feature's pull request -> run-ci.sh and the review -> merge; the Release PR is prepared -> run-e2e.sh once -> push -> post-checks.sh
Good: a feature adds e2e/specs/foo.e2e.ts -> run-e2e.sh --only foo until it passes -> run-ci.sh and the review
Bad:  run-e2e.sh on every feature branch
Bad:  push release/next with no E2E record of its own
```

### Run E2E with `.claude/tools/run-e2e.sh`, and keep a record per HEAD

Run it when the working tree is clean (after a commit).
`run-e2e.sh [checkout path]` runs `e2e:build` and `e2e` (and, beside `e2e`, `run-ci.sh` when HEAD has no passing CI record; see below), then writes JSON (sha, version, clean, passed, tests, script_timeouts, finished_at) to `.claude/e2e/{HEAD SHA}` in the main checkout, and the full output to `.claude/e2e/{HEAD SHA}.log`.
`script_timeouts` counts the WebDriver commands whose result never came back. A passing run can hide them behind webdriver's retry, so read this count and the log before saying anything about E2E speed or stability.
`pre-git.sh` and `post-checks.sh` use this record, through `.claude/tools/check-release-e2e.sh` (which calls `check-e2e.sh` for HEAD), to confirm that E2E passed for the Release PR's HEAD: the record of HEAD, or the newest record of `origin/main..HEAD` with only release work (README, CHANGELOG, `docs/`) after it. Only `release/next` is asked for it. release-verifier does not read it. The record of the static checks and unit tests has the same shape in `.claude/ci/{HEAD SHA}` (`run-ci.sh`, `check-ci.sh`; `testing.md`).
`guard-e2e.sh` blocks every write to either record except a direct call of its own command (`run-e2e.sh`, `run-ci.sh`). Never write them by hand.
After `e2e:build`, `run-e2e.sh` starts `run-ci.sh` of its own checkout in the background (under `nice -n 10`, so that wdio keeps the cores), if `check-ci.sh` finds no passing, clean CI record for HEAD, and runs `e2e` beside it (#420). cargo is used only up to `e2e:build`, and wdio runs the built binary, so the two do not wait for each other's `target/debug` lock, and `cargo test` and clippy never write `target/debug/tsunagiai` (no integration test builds it). The CI record is `run-ci.sh`'s as before, and the record of E2E is the result of E2E alone (`passed`, `tests`, `script_timeouts`); the exit code of `run-e2e.sh` is non-zero when either failed, and the output of `run-ci.sh` is printed after the E2E lines. `--only` runs no CI.

```sh
.claude/tools/run-e2e.sh   # in the main checkout
"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/run-e2e.sh"   # in a worktree: the main checkout's copy, which the gates use
```

### Let runs overlap, because each app takes its own port

One run starts six apps, one per capability, and `onPrepare` in `wdio.conf.ts` gives each app a free WebDriver port.
Each checkout has its own E2E binary and `e2e/dist`.
So runs from the main checkout and from any worktree can overlap, and there is no need to wait for the other.
Do not set a fixed port: the service waits for any WebDriver server on its port, so a second run on the same port drives the first run's app and reports on the wrong code.

```text
Good: two worktrees (two sessions) run run-e2e.sh at the same time
Bad:  set embeddedPort to the fixed value 4445 in wdio.conf.ts
```

### Split the specs among the six apps in `wdio.conf.ts`, and do not pass `--spec`

The capabilities name their specs, and a spec named nowhere runs in the last app, so a new spec needs no change there.
`--spec` overrides the specs of the capabilities, so the same spec runs in several apps and the passing count grows.

```text
Good: add e2e/specs/foo.e2e.ts and let it run in the last app
Bad:  wdio run wdio.conf.ts --spec e2e/specs/inbox.e2e.ts, which runs inbox in more than one app
```

### Keep every app under 180 seconds: even out the split first, and add an app when that is not enough

After a full run, sum the seconds of each app from its log (the lines `[webkit … #{app}-{n}] N passing ({time})` in `.claude/e2e/{HEAD SHA}.log`).
When an app takes more than 180 seconds, move specs among the apps in `namedSpecs` so that the sums come close, and write the new seconds in the comment of `wdio.conf.ts` (at the owner's instruction, 2026-11-18; #930).
When the seconds of all the specs divided by the number of apps are still over 180, add one capability, measure the next full run, and keep it only when wdio got shorter.
No app is shorter than its longest spec: split such a spec by its parts instead ("Keep one `e2e/specs/{screen}.e2e.ts` per screen").
The slowest app sets the length of every run, and the Release PR waits for E2E: on 2026-11-18 the last app held ten specs and took 345 of wdio's 351 seconds, while the other four ended in 128 to 161.
An app costs about 1 GB of memory (measured on 2026-11-18: five apps took about 5 GB of the 64 GB), so the cost of one more is the competition for the cores, which only a run shows.

```text
Good: an app takes 205 seconds and the five sum to 850 -> move specs so that each is near 170
Good: the five sum to 1,000 seconds -> add a sixth capability, and keep it only if wdio got shorter
Bad:  add a capability without measuring, or leave an app at 300 seconds because the run passed
```

### Run one failed spec alone with `run-e2e.sh --only`, the one exception to "do not pass `--spec`"

`run-e2e.sh --only {spec name}` (for example `--only inbox`) runs `e2e/specs/{name}.e2e.ts` in one app, builds first (`e2e:build`), and writes no record: it works on a dirty tree, and its output goes to `.claude/e2e/only-{name}.log` (at the owner's instruction, 2026-11-12; #485).
It sets `E2E_ONLY`, which `wdio.conf.ts` reads to cut the capabilities down to one that names that spec. The specs are not passed with `--spec`, so the spec does not run in several apps.
Use it to run a spec that a feature changed or added, and a spec that failed in the Release PR's `run-e2e.sh`: first to tell a chance failure from a defect (a spec that passes alone is read for how it failed, and the full run is repeated once on the same HEAD when no code needs a fix), then until it passes; for a defect at the Release PR, the fix goes through its own `fix/` pull request and `run-e2e.sh` runs again when the Release PR is prepared again (`.claude/skills/release/SKILL.md`). It is not a record, and `pre-git.sh` does not accept it.

```sh
.claude/tools/run-e2e.sh --only todo-prompt   # one app, one spec, no record
```

```text
Good: run-e2e.sh fails in inbox at the Release PR -> a fix/ pull request -> run-e2e.sh --only inbox until it passes -> merge -> prepare the Release PR again and run run-e2e.sh once
Bad:  wdio run wdio.conf.ts --spec e2e/specs/inbox.e2e.ts, which runs inbox in more than one app
Bad:  take a pass of --only for the E2E record
```
