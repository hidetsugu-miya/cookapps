# Rules for working in parallel with worktrees

## How to split the work

### Add features and fix bugs on a worktree branch

Name the branch `feat/{requirement ID}` or `fix/{summary}`, or `docs/{summary}` for documentation only.
Every branch reaches main through a pull request (`issues.md`), so several sessions can work and merge at once.

### Make a worktree with `new-worktree.sh`

`.claude/tools/new-worktree.sh {branch}` makes the branch from `origin/main`, puts the worktree in `.claude/worktrees/{branch with / as -}`, copies the files and directories of `.worktreeinclude` from the main checkout to the same places, and runs `npm ci`.
A worktree made by hand has no `node_modules` and none of the private files (`run-e2e.sh` runs `npm ci` itself when `node_modules` is missing, but nothing copies the private files).
Call it by the main checkout's path, from any checkout.

```sh
main="$(git rev-parse --path-format=absolute --git-common-dir)/.."
"$main/.claude/tools/new-worktree.sh" feat/C-2   # Good: branch, copied files and node_modules in one command
git worktree add -b feat/C-2 .claude/worktrees/feat-C-2 origin/main   # Bad: no copied files, no node_modules
```

### Merge the pull request from the worktree, and keep the main checkout free of work

The merge happens on GitHub, so no session has to return to the main checkout, and none waits for another there.
After a merge, fast-forward the main checkout, because its tools and hooks are what every worktree runs.

```sh
gh pr merge --merge
git -C "$main" merge --ff-only origin/main
```

### Take in main on the branch before merging it

When main has moved since the branch started, run `git fetch origin main && git merge origin/main` in the worktree, then E2E and the review there.
The ruleset refuses a pull request whose branch does not contain main, so a combined failure is found before the merge.

```text
Good: another branch was merged -> git merge origin/main in the worktree -> run-e2e.sh -> review -> push -> post-checks.sh -> merge
Bad:  merge first, and find on main that the two branches break each other
```

### Tell the other cookapps sessions what you touch, and agree the order before a merge

Several Claude Code sessions work in this repository at once (at the owner's instruction, 2026-11-07: work with the other agents so that nothing conflicts).
When you start, find the other cookapps sessions with `ListAgents` and send each, with `SendMessage`, your issue, branch and the files you will touch.
When two sessions touch the same file, agree which merges first before going on; the later one takes in main and goes through review again, as above.
Tell them again before a merge to main, and before you touch the main checkout (its fast-forward, or a file git does not track there).
When a session tells you its plan, answer whether it overlaps yours.
A session that has ended cannot be told: check its branch and worktree with `git worktree list` and `gh pr list` instead.

```text
Good: tell the other session "I touch issues.md lines 214 and 241, and merge first" -> it takes in main after the merge
Bad:  edit the untracked skills in the main checkout while another session is making them tracked, and tell no one
```

## Tools

### Call `.claude/tools/` by the main checkout's path from a worktree

`.claude/hooks/` exists only in the main checkout, and `.worktreeinclude` does not copy it.
`.claude/tools/` is tracked, so a worktree has the branch's copy, but the hooks and the gates run the main checkout's, and a worktree runs the same ones.
Run them from the worktree, so that they act on the worktree's HEAD.

```sh
main="$(git rev-parse --path-format=absolute --git-common-dir)/.."
"$main/.claude/tools/watch-ci.sh"
```

### Remove a worktree once its branch is merged and pushed

Each worktree holds about 6 GB of build output.
Remove it with `git worktree remove`, without `--force`, so that a worktree with uncommitted files is refused.
Leave a locked worktree alone: a session is using it.

```text
Good: after the push (and the release, for a version), git worktree remove .claude/worktrees/feat-C-2 && git branch -d feat/C-2
Bad:  rm -rf .claude/worktrees/feat-A-3 while its session is running E2E
```

## Versions and tags

### On a worktree branch, do not raise the version

Only the Release PR updates `version` in `Cargo.toml`, `tauri.conf.json` and `Cargo.lock`, `docs/features.md`, and `CHANGELOG.md` (`issues.md`). The tag is made on its merge commit (`versioning.md`).
If parallel branches each raise them, the same lines conflict at every merge.

```text
Good: commit only the implementation on feat/C-1 and merge its pull request; the Release PR raises to 0.8.0
Bad:  raise to 0.8.0 inside feat/C-1
```

## Private files

### Edit the private files only in the main checkout

`mise.toml`, `.claude/rules/machines.md`, `.claude/rules/google-cloud.md` and `src-tauri/.cargo/` in a worktree are copies made with `.worktreeinclude` when the worktree was created, and git does not track them. The rest of `.claude/rules/` is tracked: change it on the branch like the code.
A fix made in a worktree does not return to main, and is lost when the worktree is deleted.
Hooks and `settings.local.json` in a worktree are also taken from the main checkout.

```text
Good: change .claude/rules/machines.md in the main checkout
Bad:  change the worktree's copy of machines.md and then delete the worktree
```

## Checking on a real machine

### When you run the apps of several worktrees at once, do not add or remove accounts

The identifier is the same, so every app shares `accounts.json` and the keychain.

```text
Good: in one app, check only the list and the sync
Bad:  in one app, log in with a new account
```
