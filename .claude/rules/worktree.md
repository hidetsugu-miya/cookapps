# Rules for working in a worktree of your own

## How to split the work

### Work in a worktree of your own, one for each branch

Every piece of work has its own worktree, `.claude/worktrees/{the branch name with / written as -}`: a session of the owner, the Release PR, each on its own branch (at the owner's instruction, 2026-11-19; #1006. It replaces the one worktree `.claude/worktrees/work` that they used in turn, of 2026-11-09; Discussion #293).
Several sessions therefore develop at the same time, each in its own worktree and with its own pull request, and the Release PR (`release/next`) carries what they merged.
The worktree is made by `use-worktree.sh` when the work starts and deleted by `use-worktree.sh --park` when it ends, so a branch that is done leaves nothing behind.
A piece of work that finds its branch in use does not touch it: a session tells the owner or the other session.
A branch is in use when its worktree is on another branch (the path is the same once `/` is written as `-`), or when another worktree has the branch checked out. `release/next` is one such branch: the session that gets there first prepares the Release PR, and a later one leaves it alone.

```text
Good: two sessions work on `feat/C-2` and `fix/list-scroll`, each in its own worktree, and each opens its own pull request
Good: a session needs `release/next`, `use-worktree.sh` exits 3 because another session has it checked out -> the session leaves the Release PR to that one
Bad:  a shared worktree that the pieces of work switch between, so that one waits for another
```

### One session develops one piece at a time, never in parallel

A single AI session develops one piece at a time: one worktree, one branch. It never fans out into parallel development of its own (a second piece started in another worktree or on another branch and driven from the same session at once), even when the pieces touch no common file (at the owner's instruction, 2026-11-19).
Running the steps of one piece together is not this: the default flow still runs `run-ci.sh` beside wdio and starts E2E together with the reviewers (`review.md`). That is one piece, not parallel development.
The limit is on parallelism inside one session. Separate sessions are a different matter: each has a worktree of its own and runs in parallel with the others (#1006), and a session that meets another at work on shared files or rules coordinates with it (a message to the other session) rather than driving both itself.
A session that wants a second piece started finishes or parks the first, or leaves it to another session.

```text
Good: a session implements one branch, reviews it, merges it, then starts the next
Bad:  one session drives two branches in two worktrees at once
Good: a session finds another session already working, and tells it before changing shared rules
```

### Add features and fix bugs on a branch of its own worktree

Name the branch `feat/{requirement ID}` or `fix/{summary}`, or `docs/{summary}` for documentation only. A branch that an `implement` run takes holds the commits of several issues. `improvement-proposal` works on `proposal/{date and time}`, which it does not push, and the Release PR is `release/next`.
Every branch reaches main through a pull request (`issues.md`).

### Take a worktree with `use-worktree.sh`, and give it back with `--park`

`.claude/tools/use-worktree.sh {branch}` prints the path of the worktree of that branch, `.claude/worktrees/{branch with / written as -}` of the main checkout, and makes it when it is missing.
When the worktree is there and on that branch, the script copies the private files again (the main checkout's are the originals) and prints the path (the work goes on).
When the path is there but on another branch or detached, or when another worktree (the main checkout included) has the branch checked out, the branch is in use: the script says why on stderr and exits 3, and changes nothing.
Otherwise it makes the worktree: the branch that exists locally is used (and brought up to date with `origin/main` when it is merged), else `origin/{branch}` is tracked, else a new branch is cut from `origin/main`.
When it makes the worktree, it copies the files and directories of `.worktreeinclude` from the main checkout to the same places, clones the main checkout's `src-tauri/target` into the worktree (`cp -cpR`, an APFS clone that keeps the modification times; the `incremental/` of each profile is deleted from the copy), and runs `ensure-deps.sh`, which runs `npm ci` (the main checkout's `node_modules` is not copied: it can differ from `package-lock.json` after a fast-forward, until `session-start.sh`, `run-ci.sh` or `run-e2e.sh` runs `ensure-deps.sh` there, which reinstalls when the lock's hash differs from the mark in `node_modules`, under a lock in the git directory of the checkout, so that two runs do not write the same `node_modules`).
Where cloning is not possible (a volume that is not APFS), `cp` falls back to a plain copy (`man cp`); when the copy itself fails (a full disk, for example), the script deletes the half-made copy, warns on stderr, and the worktree starts from an empty target.
`use-worktree.sh --park`, run inside a worktree under `.claude/worktrees/`, gives it back after the pull request has merged. A worktree is free when its tree is clean and its HEAD is in some remote branch (a pushed branch that is not merged yet does not keep it), so no change and no commit can be lost by removing it. When it is free, the script removes the worktree with `git worktree remove` (never `--force`; the ignored files, `node_modules` and `target` among them, go with it), deletes the branch when `origin/main` has it, deletes the claims of that worktree (`.claude/claims/`, below), and prints the path of the main checkout. Otherwise it says why on stderr and exits 3, and removes nothing. It exits 3 too when it is run anywhere else (the main checkout, or a worktree outside `.claude/worktrees/`).
Call it by the main checkout's path, from any checkout; `--park` acts on the worktree it is run in, and the shell must leave that directory afterwards.

```sh
main="$(git rev-parse --path-format=absolute --git-common-dir)/.."
"$main/.claude/tools/use-worktree.sh" feat/C-2   # Good: the branch, the private files and node_modules in one command; prints the path
"$main/.claude/tools/use-worktree.sh" --park     # Good: after the merge, from inside the worktree; prints the main checkout
git worktree add -b feat/C-2 .claude/worktrees/feat-C-2 origin/main   # Bad: no private files, no node_modules, and no target clone
```

### Claim an issue before you start it, so that two sessions do not start the same one

An issue is started by the session that has claimed it: `plan-release.py claim --worktree {path of your worktree} {n}...`, run after the worktree is taken (`implement` step 3).
A claim is the directory `.claude/claims/{n}/` of the main checkout, with the path of the owner's worktree in `owner`. It is made whole and renamed into place, and the claimants take turns under an exclusive `flock` of `.claude/claims/`, so only one session can make it, also when the claim is stale.
`claim` refuses an issue that another worktree, which still exists, has claimed (stderr `#{n} claimed by {path}`, exit 3), and the session takes the next issue instead. A claim whose worktree is gone (its directory removed, which `git worktree list` marks `prunable`, included) is stale and is taken over.
`plan-release.py next` leaves a claimed issue out of `start` and lists it in `claimed`, unless it is in `--mine` (the issues of this run). `use-worktree.sh --park` deletes the claims of its worktree, and nothing else does.

```text
Good: session A claims #41 and session B claims #41 a second later -> B is refused, and takes #42
Bad:  start the issue that `next` lists in `claimed`
```

### Merge the pull request from the worktree, and keep the main checkout free of work

The merge happens on GitHub, so no session has to return to the main checkout.
After a merge, fast-forward the main checkout, because its tools and hooks are what the worktree runs, and then park the worktree.

```sh
gh pr merge --merge
git -C "$main" merge --ff-only origin/main
"$main/.claude/tools/use-worktree.sh" --park   # from inside the worktree
```

### Take in main on the branch before merging it

When main has moved since the branch started, run `git fetch origin main && git merge origin/main` in the worktree, then E2E and the review there.
The ruleset refuses a pull request whose branch does not contain main, so a combined failure is found before the merge.

```text
Good: another branch was merged -> git merge origin/main in the worktree -> run-e2e.sh (its run-ci.sh beside wdio) and the reviewers together -> release-verifier -> push -> post-checks.sh -> merge
Bad:  merge first, and find on main that the two branches break each other
```

## Tools

### Call `.claude/tools/` by the main checkout's path from the worktree

`.claude/hooks/` and `.claude/tools/` are tracked, so the worktree has the branch's copy of both.
The hooks (wired in the main checkout's `settings.local.json`) and the gates run the main checkout's copy, so a change to either takes effect after the merge and the fast-forward.
Run them from the worktree, so that they act on the worktree's HEAD.

```sh
main="$(git rev-parse --path-format=absolute --git-common-dir)/.."
"$main/.claude/tools/watch-ci.sh"
```

### Read the real disk use from `df`, and remove a worktree only without `--force`

The worktree's `src-tauri/target` is a clone of the main checkout's, so it shares disk blocks with it until a file is rewritten, and `du` counts the shared part in both.
Read the real use from the fall of free space in `df`, not from `du`.
`run-ci.sh` runs clippy and the tests with `CARGO_INCREMENTAL=0`, so the checks before a push leave no data for incremental builds, and `clean-target.sh` deletes the old output of the app itself (`harness.md`).
Every worktree has such a clone, so a worktree that is no longer needed is removed by `use-worktree.sh --park`. When `--park` cannot reach one (its branch is gone, say), remove it with `git worktree remove`, without `--force`, so that a worktree with uncommitted files is refused.

```text
Good: use-worktree.sh --park once the pull request has merged, so that the clone of `target` is freed
Bad:  rm -rf .claude/worktrees/feat-C-2 while another session works there
```

## Versions and tags

### On a worktree branch, do not write a version

The source holds no version (`versioning.md`: `0.0.0` in `Cargo.toml` and `Cargo.lock`, none in `tauri.conf.json`), and `scripts/check-version.sh` fails when a branch changes it (at the owner's instruction, 2026-11-09; Discussion #293).
Only the Release PR writes `docs/features.md` and `CHANGELOG.md`, with the heading of the new version (`.claude/skills/release/SKILL.md`). The tag is made on its merge commit (`versioning.md`).
If a feature's branch and the Release PR each wrote them, the same lines would conflict at every merge.

```text
Good: commit only the implementation on fix/list-scroll and merge its pull request; the Release PR writes `## v0.8.0` in CHANGELOG.md
Bad:  change the version in Cargo.toml inside feat/C-1
```

## Private files

### Edit the private files only in the main checkout

`mise.toml`, `.claude/hooks/public-words`, `.claude/rules/machines.md`, `.claude/rules/google-cloud.md` and `src-tauri/.cargo/` in the worktree are copies made with `.worktreeinclude` (when it was made, and again at each `use-worktree.sh` of its branch), and git does not track them. The rest of `.claude/rules/` is tracked: change it on the branch like the code.
A fix made in the worktree does not return to main, and is lost at the next copy.
`settings.local.json` in the worktree is also taken from the main checkout, and so are the hooks it wires.

```text
Good: change .claude/rules/machines.md in the main checkout
Bad:  change the worktree's copy of machines.md and then park the worktree
```

## Checking on a real machine

### When you run more than one development app at once, do not add or remove accounts

The identifier is the same, so every app shares `accounts.json` and the keychain.

```text
Good: in one app, check only the list and the sync
Bad:  in one app, log in with a new account
```
