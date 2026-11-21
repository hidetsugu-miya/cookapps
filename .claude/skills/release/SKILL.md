---
name: release
description: Prepares the つなぎAI Release PR (opens or updates `release/next` with the CHANGELOG and features entries, the photos and the body), merges it once its checks have passed, and sees the release through (the tag, the release run, the comments on the issues, the mark). Use on 「Release PR を作って」「Release PR を更新して」「リリースを見届けて」, when `post-gh.sh` tells a session to do so after `gh pr merge`, and from step 7 of `implement`.
---

# release

Two procedures. Procedure A prepares the Release PR when changes wait for the release, and merges it. Procedure B sees the release of a merged Release PR through, and the session that merged it goes on to it at once.
The rules of both are in "Rules" at the end of this file.
The session that prepares the Release PR (A) merges it, and sees the release through (B); it does not wait for the owner to merge (at the owner's instruction, 2026-11-21). Only a session prepares it (at the owner's instruction, 2026-11-21; #1179: the night run, which merged it itself, is removed).
Tools are at `"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/"`.

## Steps

### A. Prepare the Release PR

In an `implement` run, read the output of `plan-release.py release` that `post-gh.sh` printed after the run's last `gh pr merge` (its own pull request, or the fix of the left review Lows that follows it, step 6 of `implement`); run the command yourself when the hook said that it failed. Otherwise always run `plan-release.py release` first, because an output printed earlier may be stale (the owner may have merged a Release PR since). If `changes` is empty, there is nothing to prepare: stop. Otherwise take the worktree for `release/next` (`use-worktree.sh release/next`; on exit 3 another session has `release/next` checked out and is preparing the Release PR, so touch nothing, tell the owner, and stop) and do "Keep one Release PR open while changes wait" in "Rules" at the end of this file:

- Take in main (`git merge origin/main`), write the entries of `CHANGELOG.md`, under the heading `## v{version}` (`version` of `release`, checked against `requirements/` for the digit; "Take the digit from the requirement IDs"), and of `docs/features.md`. Change no version line of the source: it is fixed (`versioning.md`). Read `README.md` against the changes that go out with `readme-product`, and fix it in `release/next` only when a photo or a claim is out of date. Change only `README.md` and `docs/` there: do not change the spec of the photos (`.claude/skills/readme-product/shots/`), because it is not release-only. When a photo cannot be taken because the spec does not fit the screen, file an issue with `issue-plan` (`readme-product`), take no photo of that screen, and name it in the body as a screen that could not be photographed. Commit the result.
- Run neither `run-ci.sh` nor `run-e2e.sh` on the HEAD of `release/next`: its diff is release-only, and `pre-git.sh` and `post-checks.sh` ask no CI, E2E or pass record for it (`testing.md`). Push, and run `post-checks.sh`.
- Open the pull request (`gh pr create`, title `release: v{version}`), or update the open one (`gh pr edit`). The body lists the changes (the issues, with their points), the digit and why, and whether `README.md` needed anything. It holds no decision to release.
- Show the screens that the changes touch: put the photo of each such screen, `docs/assets/readme/{name}.png` at the pushed HEAD of `release/next`, in the body or in a comment of the Release PR, linked by the raw URL of that HEAD's SHA ("Keep one Release PR open while changes wait" in "Rules" at the end of this file). Take no photo here: the first item of this procedure retook, inside the commit, those that were out of date, and the others already show the screen. A screen that could not be photographed has no photo in the Release PR: name it, as the first item says. Name a touched screen, and what changed in it, when no photo shows the change, and say so when the changes touch no screen.
- Merge it in this session, as soon as `post-checks.sh` has sent its statuses and the previous items are done, whether or not `urgent` is true ("Keep one Release PR open while changes wait, and merge it in the session that prepared it" in "Rules" at the end of this file; at the owner's instruction, 2026-11-21): `gh pr merge {number} --merge`, then `git fetch origin main` and `git -C "$main" merge --ff-only origin/main`, then `use-worktree.sh --park` from inside the worktree of `release/next`, so that the next preparer can take it (`worktree.md`). Do not wait for the owner, and send no notification.
  - When the merge is refused (a status that the ruleset requires is missing, the branch does not contain main, anything else), merge by no other means (no `--admin`, no bypass of the ruleset): tell the owner the reason, and stop with the Release PR open.
- Go on to Procedure B at once.

### B. See the merged Release PR through

The merge of the Release PR has started the release by itself: `release.yml` tags the merge commit and builds ("After the Release PR is merged" in "Rules" at the end of this file). The session that merged it in Procedure A goes on here without a pause; any other agent comes here from `follow_up` or `tag_due`. Run `plan-release.py release` now (an output that `post-gh.sh` printed earlier may be stale). `follow_up` (the tag exists, the Release PR has no mark) and `tag_due` (no tag) say what is left.

- `tag_due` is printed: the tag does not exist yet. Look at `gh run list --workflow release.yml --event pull_request --branch release/next --limit 5` first. A run in progress is the workflow tagging: wait for it. A run that failed in the `tag` job is a finding about the Release PR: tell the owner, and leave it to the owner. Right after a merge, a run that is not in the list yet is not a missing run: do not tag by hand, and wait with `watch-ci.sh {tag_due.commit}`. Make the annotated tag on `tag_due.commit` and push it in the same command (`versioning.md`) only when no run of the merge exists; then run `plan-release.py release` again, which prints `follow_up`.
- Run `git fetch origin main`, then watch the release job of the merge (or of the tag you pushed) with `watch-ci.sh {follow_up.commit}` (`{tag_due.commit}` for a tag made by hand) until it ends (`review.md`). If it fails, find the cause with `--log-failed`: retry a failure of the runner or the network with `gh run rerun {run ID} --failed`, and for any other cause tell the owner the cause and fix it with the next patch version (`review.md`) ("After the Release PR is merged" in "Rules" at the end of this file). `watch-ci.sh` waits up to 2 minutes for the run of the merge to appear, so it may be called right after a merge.
- Run `plan-release.py close`.
- Comment the version on each issue listed in the body of the Release PR (`gh pr view {follow_up.pr} --json body`), once the release job has succeeded, and then comment `<!-- released {follow_up.tag} -->` on the Release PR (`gh pr comment {follow_up.pr}`), which closes `follow_up`.

The tag comes first because what waits is counted from the last tag.
When neither `follow_up` nor `tag_due` is printed, nothing is left from a merge.

## Rules

### Keep one Release PR open while changes wait, and merge it in the session that prepared it

The agents prepare the Release PR, and the merge tags and releases it by itself (`release.yml`; at the owner's instruction, 2026-11-09; #303). The session that prepared it merges it as soon as its checks have passed, and sees the release through; it does not wait for the owner (at the owner's instruction, 2026-11-21). No schedule merges it (at the owner's instruction, 2026-11-21; #1179: the night run of `ship`, which merged it with the owner's account from 2026-11-19, is removed).
The `tag` job of `release.yml` goes on only for a merge by the repository's owner (`merged_by.login`), and the `gh` of a session runs under the owner's account, so the merge of a session starts the release as the owner's own merge does. `release.yml` stays as it is.
`plan-release.py release` says what waits (`changes`: merged and not released, a change that is only documentation, `.claude/agents/`, `.claude/rules/` or `.claude/skills/` not counted), whether the Release PR exists, and the version it writes (the first heading of `CHANGELOG.md`; the source holds no version, `versioning.md`).
An `implement` run looks at it after it has merged its own pull request and the fix of the left review Lows (step 7 of `implement`), and a session does when the owner asks:
- Changes wait and there is no Release PR: open it from the branch `release/next`, with a commit that writes the entries of `CHANGELOG.md` under the heading `## v{version}` and of `docs/features.md` (`versioning.md`).
- Changes wait and the Release PR is open: bring its branch up to date with main, correct the heading `## v{version}` of `CHANGELOG.md` (the digit may have changed), write the entries of the new changes in `CHANGELOG.md` and `docs/features.md`, and update the body.
- Nothing waits: nothing to do.

Its title is `release: v{version}`, and its body holds the changes, the digit and why, and whether `README.md` needed anything. The session merges it as soon as it is ready, so the body holds no decision to wait or to release.
The Release PR shows the screens that its changes touch, as photos in its body or in a comment, so that the owner sees the result of the changes (at the owner's instruction, 2026-11-13). The photos are the ones `readme-product` takes from the mocked E2E build with made-up data, the files of `docs/assets/readme/` at the pushed HEAD of `release/next` (the preparer retakes, inside the commit, only those out of date), linked by the raw URL of the commit that holds them (`https://raw.githubusercontent.com/{owner}/{repo}/{commit SHA}/docs/assets/readme/{name}.png`), never a photo of the real app, because the repository is public (`publishing.md`). A screen that the changes touch, where no photo shows the change (a settings tab, a dialog, a part that no photo has), is named in the body with what changed in it. A Release PR whose changes touch no screen has no photo, and its body says so.
The preparer pushes `release/next` and runs `post-checks.sh` before it merges. It runs neither `run-ci.sh` nor `run-e2e.sh` on a diff that is release-only (README, CHANGELOG and `docs/`): the push and `post-checks.sh` ask no record for it (`testing.md`, `review.md`; at the owner's instruction, 2026-11-18; #931).
`urgent` of `plan-release.py release` changes nothing here: the preparer merges every Release PR as soon as it is ready, and sends no notification (at the owner's instruction, 2026-11-21; it replaces the push notification of an urgent Release PR, of 2026-11-09; Discussion #293).
When the merge is refused, or the `release` run fails for a cause other than the runner or the network, the session tells the owner the reason and does not work around it.
Merged Release PRs are the release history.

```text
変更: #21 Slack の書式を表示する  point:3  (closes #12)
版:   minor（要件 ID S-12 が増えた）
README: 直すところなし
```

```text
Good: an `implement` run merged its pull request, and `release` lists 2 changes and no Release PR -> it opens release/next, pushes, runs `post-checks.sh`, merges it, and sees the release through
Good: the owner asks for the Release PR in a session, and `release` lists a change that waits -> it prepares the Release PR, merges it and sees the release through
Good: a waiting bug has importance:high -> the Release PR is merged like any other, with no notification
Good: the merge is refused because a status is missing -> the session tells the owner the reason and stops, with the Release PR open
Bad:  the session ends with the Release PR ready and waits for the owner to merge it
Bad:  the merge is refused, and the session retries with `--admin`
Bad:  the body of the Release PR says "wait" or "release now" (there is no such decision to write)
```

### Take the digit from the requirement IDs

Raise the minor when `requirements/` has a requirement ID that the last tag does not, and the patch otherwise (`versioning.md`).
`plan-release.py release` prints `version` from the `adds:requirement` labels of the waiting changes: check it against `requirements/` before it goes in the Release PR, and correct the label when they disagree.
The `enhancement` label does not decide it: #9 was an enhancement and went out as v0.31.1.

```text
Good: S-12 is new since v0.32.0 -> v0.33.0
Bad:  the issue says enhancement -> minor
```

### After the Release PR is merged, the workflow tags and releases it, and an agent sees it through

The merge of a pull request from `release/next` starts `release.yml`: its `tag` job reads the first `## v{version}` heading of `CHANGELOG.md` at the merge commit, checks the version as for a pushed tag, and pushes the annotated tag on the merge commit, and its `release` job builds and publishes in the same run (at the owner's instruction, 2026-11-09; #303). No agent tags by hand when it works.
1. The preparer merges the Release PR (with the owner's account; at the owner's instruction, 2026-11-21), after it has done these in `release/next`: take in main, and write `CHANGELOG.md` (its first heading `## v{version}` is the version, which the workflow reads at the merge and `tag_due` too) and `docs/features.md`. No version line of the source changes: it is fixed (`versioning.md`; at the owner's instruction, 2026-11-09; Discussion #293).
   Read `README.md` against the changes that go out, with `readme-product`: fix a photo or a claim they make out of date in `release/next`, and write in the body that nothing needed it otherwise (at the owner's instruction, 2026-11-07). `README.md` and `docs/` keep the diff release-only.
   Run neither `run-ci.sh` nor `run-e2e.sh` on the HEAD of `release/next`: the release-only diff stands for the review, CI and E2E records alike (`testing.md`; #931). Push, and run `post-checks.sh`.
   Show in the body or in a comment the photos of the screens that the changes touch, from the pushed HEAD ("Keep one Release PR open while changes wait"; at the owner's instruction, 2026-11-13).
2. The session that merged the Release PR goes on at once, and an agent that finds a merge nobody saw through (the next one to act) does the same: it runs `plan-release.py release`.
   - `follow_up` is printed (the tag exists, and the Release PR it names has no mark yet): the workflow has tagged, and nobody has seen the release through. Watch the `release` run of the merge to the end (`git fetch origin main`, then `watch-ci.sh {follow_up.commit}`; `review.md`), then do 3 and 4. No `follow_up` and no `tag_due`: nothing left from a merge.
   - `tag_due` is printed: the tag does not exist yet. Look at the runs first (`gh run list --workflow release.yml --event pull_request --branch release/next --limit 5`). A run in progress is the workflow tagging: wait for it, and watch it (`watch-ci.sh {tag_due.commit}`). Right after the merge, the run may not be listed yet: do not tag by hand, and wait with `watch-ci.sh {tag_due.commit}`, which waits for the run to appear.
     A run that failed in the `tag` job is a finding about the Release PR (a version that is not the heading, a source version that is not fixed, a commit that is not on main): tell the owner; do not tag by hand over a failed check. A failure of the runner or the network is retried like the one below.
     Where no run of the merge exists (the workflow was off, or the run was lost), make the annotated tag by hand on the commit `tag_due` names and push it (`versioning.md`); the push starts the `release` run, and the workflow tags nothing that already has a tag.
   - A run that failed in the `release` job after the tag was pushed: find the cause with `--log-failed`. A failure of the runner or the network (nothing in the commit) is retried with `gh run rerun {run ID} --failed`; the rerun builds the tag that is already on the merge commit. Any other cause is told to the owner and fixed with the next patch version (`review.md`), and a published tag is never moved (`versioning.md`).
3. It runs `plan-release.py close`, which closes the parents whose sub-issues are all closed and released.
4. It comments the version on each issue listed in the body of the Release PR, once the `release` run has succeeded, and then marks the Release PR with a comment whose first line is `<!-- released v{version} -->` (`follow_up` of `plan-release.py release` stays open until the mark is there, because the workflow tags at the merge and no agent is there to see it; at the owner's instruction, 2026-11-09; #303). A tag made by hand is followed up the same way.
The tag comes first because what waits is counted from the last tag (`plan-release.py release`).

```text
Good: the session merges -> the workflow tags v0.33.0 and releases -> the run sees `follow_up`, watch-ci.sh succeeds -> close -> "v0.33.0 で対応しました" on each issue -> the mark on the Release PR
Good: tag_due is printed and no run of the merge exists -> tag it by hand on the commit it names, push, and watch
Bad:  comment on the issues before the release run has succeeded
Bad:  comment on the issues and leave no mark, so that the next run comments on them again
Bad:  tag origin/main by hand after another pull request has merged on top of the Release PR (the tag goes on the commit that tag_due names)
Bad:  tag by hand at once when tag_due is printed, while the run of the merge is still going (it tags in a minute)
```
