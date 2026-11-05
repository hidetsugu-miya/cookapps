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
`run-e2e.sh [checkout path]` runs `e2e:build` and `e2e`, then writes JSON (sha, version, clean, passed, tests, script_timeouts, finished_at) to `.claude/e2e/{HEAD SHA}` in the main checkout, and the full output to `.claude/e2e/{HEAD SHA}.log`.
`script_timeouts` counts the WebDriver commands whose result never came back. A passing run can hide them behind webdriver's retry, so read this count and the log before saying anything about E2E speed or stability.
`pre-git.sh` and release-verifier use this record, through `.claude/tools/check-e2e.sh`, to confirm that E2E passed for HEAD.
`guard-e2e.sh` blocks every write to the record except a direct call of `run-e2e.sh`. Never write it by hand.

```sh
.claude/tools/run-e2e.sh   # in the main checkout
"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/run-e2e.sh"   # in a worktree, which has no .claude/tools/
```

### Let runs overlap, because each app takes its own port

One run starts three apps, one per capability, and `onPrepare` in `wdio.conf.ts` gives each app a free WebDriver port.
Each checkout has its own E2E binary and `e2e/dist`.
So runs from several worktrees can overlap, and there is no need to wait for another session.
Do not set a fixed port: the service waits for any WebDriver server on its port, so a second run on the same port drives the first run's app and reports on the wrong code.

```text
Good: two sessions run run-e2e.sh at the same time, each in its own worktree
Bad:  set embeddedPort to the fixed value 4445 in wdio.conf.ts
```

### Split the specs among the three apps in `wdio.conf.ts`, and do not pass `--spec`

The capabilities name their specs, and a spec named nowhere runs in the last app, so a new spec needs no change there.
`--spec` overrides the specs of the capabilities, so the same spec runs in several apps and the passing count grows.

```text
Good: add e2e/specs/foo.e2e.ts and let it run in the last app
Bad:  wdio run wdio.conf.ts --spec e2e/specs/inbox.e2e.ts, which runs inbox in more than one app
```
