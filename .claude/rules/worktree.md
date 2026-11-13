# Rules for working in the one worktree

## How to split the work

### Work in one worktree, one piece of work at a time

There is one worktree, `.claude/worktrees/work`, and the owner's sessions and the nightly jobs all use it (at the owner's instruction, 2026-11-09; Discussion #293). Nothing works in parallel.
The worktree is never deleted: each piece of work switches it to a branch cut from `origin/main`, so the clone of `src-tauri/target` is made once and its build output is reused.
A piece of work that finds the worktree in use does not touch it: a session waits or tells the owner, and a nightly run writes it in the hand-over and goes on to what needs no worktree.

```text
Good: a session needs the worktree, `use-worktree.sh` exits 3 because a night branch holds commits that are not pushed -> the session tells the owner
Bad:  a second worktree for the same repository, so that two pieces of work run at once
```

### Add features and fix bugs on a branch of that worktree

Name the branch `feat/{requirement ID}` or `fix/{summary}`, or `docs/{summary}` for documentation only. The night run's branch is `night/{YYYY-MM-DD}`, and it holds the commits of several issues. `improvement-proposal` works on `proposal/{date and time}`, which it does not push, and the Release PR is `release/next`.
Every branch reaches main through a pull request (`issues.md`).

### Take the worktree with `use-worktree.sh`, and give it back with `--park`

`.claude/tools/use-worktree.sh {branch}` makes the worktree when it is missing and, when it exists, switches it to the branch (cut from `origin/main`; a branch that already exists is switched to, and brought up to date with `origin/main` when it is merged).
The worktree is free when its tree is clean and its HEAD is in some remote branch (a pushed branch that is not merged yet does not keep it), so no change and no commit can be lost by switching. Otherwise it is in use: the script says why on stderr and exits 3, and changes nothing. When the worktree is already on the branch asked for, the script only prints its path (the work goes on).
When it makes the worktree, it copies the files and directories of `.worktreeinclude` from the main checkout to the same places, clones the main checkout's `src-tauri/target` into the worktree (`cp -cpR`, an APFS clone that keeps the modification times; the `incremental/` of each profile is deleted from the copy), and runs `npm ci`.
At every use it copies the private files again (the main checkout's are the originals), and runs `npm ci` when `package-lock.json` changed between the old HEAD and the new one.
Where cloning is not possible (a volume that is not APFS), `cp` falls back to a plain copy (`man cp`); when the copy itself fails (a full disk, for example), the script deletes the half-made copy, warns on stderr, and the worktree starts from an empty target.
`use-worktree.sh --park` gives the worktree back after the pull request has merged: when it is free, it detaches the worktree at `origin/main` and deletes the old branch; otherwise it exits 3.
Call it by the main checkout's path, from any checkout.

```sh
main="$(git rev-parse --path-format=absolute --git-common-dir)/.."
"$main/.claude/tools/use-worktree.sh" feat/C-2   # Good: the branch, the private files and node_modules in one command; prints the path
"$main/.claude/tools/use-worktree.sh" --park     # Good: after the merge, so the next piece of work finds it free
git worktree add -b feat/C-2 .claude/worktrees/feat-C-2 origin/main   # Bad: a second worktree, with no private files and no node_modules
```

### Merge the pull request from the worktree, and keep the main checkout free of work

The merge happens on GitHub, so no session has to return to the main checkout.
After a merge, fast-forward the main checkout, because its tools and hooks are what the worktree runs, and then park the worktree.

```sh
gh pr merge --merge
git -C "$main" merge --ff-only origin/main
"$main/.claude/tools/use-worktree.sh" --park
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

### Leave the worktree in place, and read the real disk use from `df`

The worktree's `src-tauri/target` is a clone of the main checkout's, so it shares disk blocks with it until a file is rewritten, and `du` counts the shared part in both.
Read the real use from the fall of free space in `df`, not from `du`.
`run-ci.sh` runs clippy and the tests with `CARGO_INCREMENTAL=0`, so the checks before a push leave no data for incremental builds, and `clean-target.sh` deletes the old output of cookapps itself (`harness.md`).
Remove a worktree of an older layout (one named after its branch) with `git worktree remove`, without `--force`, so that a worktree with uncommitted files is refused; the one worktree itself stays.

```text
Good: git worktree remove .claude/worktrees/feat-C-2 once its branch is merged, after the work has moved to `work`
Bad:  rm -rf .claude/worktrees/work while a night run is using it
```

## Versions and tags

### On a worktree branch, do not write a version

The source holds no version (`versioning.md`: `0.0.0` in `Cargo.toml` and `Cargo.lock`, none in `tauri.conf.json`), and `scripts/check-version.sh` fails when a branch changes it (at the owner's instruction, 2026-11-09; Discussion #293).
Only the Release PR writes `docs/features.md` and `CHANGELOG.md`, with the heading of the new version (`issues.md`). The tag is made on its merge commit (`versioning.md`).
If the branch of a night and the Release PR each wrote them, the same lines would conflict at every merge.

```text
Good: commit only the implementation on night/2026-11-10 and merge its pull request; the Release PR writes `## v0.8.0` in CHANGELOG.md
Bad:  change the version in Cargo.toml inside feat/C-1
```

## Private files

### Edit the private files only in the main checkout

`mise.toml`, `.claude/hooks/public-words`, `.claude/rules/machines.md`, `.claude/rules/google-cloud.md` and `src-tauri/.cargo/` in the worktree are copies made with `.worktreeinclude` (when it was created, and again at each `use-worktree.sh`), and git does not track them. The rest of `.claude/rules/` is tracked: change it on the branch like the code.
A fix made in the worktree does not return to main, and is lost at the next copy.
`settings.local.json` in the worktree is also taken from the main checkout, and so are the hooks it wires.

```text
Good: change .claude/rules/machines.md in the main checkout
Bad:  change the worktree's copy of machines.md and then take the worktree for the next branch
```

## Checking on a real machine

### When you run more than one development app at once, do not add or remove accounts

The identifier is the same, so every app shares `accounts.json` and the keychain.

```text
Good: in one app, check only the list and the sync
Bad:  in one app, log in with a new account
```
