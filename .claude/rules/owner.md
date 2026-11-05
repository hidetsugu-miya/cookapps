# Working with the owner

## What the owner decides

### Carry an instruction through to the end without asking

The owner gives the requirements for the product and accepts the result, and reads the conclusion (instructed on 2026-10-29 and 2026-11-03).
Implementation, verification and the recommended action, including commit, tag and push, are done without asking. Nothing outside the owner's goal is done.
Still ask in advance before a force push or a history rewrite.

```text
Good: instruction -> implement, review, merge, report the conclusion
Bad:  stop after the review to ask whether to push
```

### Run the options before proposing one

When a feature or a design has two or more options, run each one and compare the results before proposing one.
Do not propose from a guess or from reading alone, and state what was run and what it showed (at the owner's instruction, 2026-11-04: a choice between two ways of updating a screen was proposed from reading, before either had been run live).

```text
Good: run a small prototype of both reads against the real service -> propose the one that worked, with the result
Bad:  propose the simpler read because the other "has not been verified"
```

### Add a library without asking, only when it is extensible, widely starred and active

A library stays in the app and in the supply chain, so these three are the minimum conditions (at the owner's instruction, 2026-11-05: no more asking first).
Check them from the primary source before adding it, and give the figures in the completion report.

```text
Good: xterm.js has addons, 21k stars and a commit last week -> add it and report the figures
Bad:  add a library because the task is easier with it, without checking its activity
```

### Keep E2E on this machine, on the real WKWebView

The owner chose WebdriverIO, run on this machine with no window on screen, and without the keychain or the real settings folder (2026-10-31; `e2e.md` has how). If it stops working, switch to Playwright and tell the owner.

```text
Good: a run that cannot start -> find the cause, or move to Playwright and report it
Bad:  a run that cannot start -> check the screen in Chrome with a mock
```
