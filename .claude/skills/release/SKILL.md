---
name: release
description: Prepares the つなぎAI Release PR (opens or updates `release/next` with the CHANGELOG and features entries, the photos and the body) and sees a merged Release PR through (the tag, the release run, the comments on the issues, the mark). Use on 「Release PR を作って」「Release PR を更新して」「リリースを見届けて」「リリースして」, when `post-gh.sh` tells a session to do so after `gh pr merge`, and from steps 2 and 8 of `ship`.
---

# release

Two procedures. Procedure A prepares the Release PR when changes wait for the release. Procedure B sees the release of a merged Release PR through.
The rules of both are in "Rules" at the end of this file.
The owner merges the Release PR; an agent prepares it (A) and sees it through after the merge (B).
Tools are at `"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/"`.

## Steps

### A. Prepare the Release PR

Read the output of `plan-release.py release` that `post-gh.sh` printed after the last `gh pr merge`; run the command yourself only when nothing was merged in this session or run, or the hook said that it failed. If `changes` is empty, there is nothing to prepare: stop. Otherwise take the worktree for `release/next` (`use-worktree.sh release/next`; on exit 3, say so, in a `ship` run in the hand-over, and stop) and do "Keep one Release PR open while changes wait" in "Rules" at the end of this file:

- Take in main (`git merge origin/main`), write the entries of `CHANGELOG.md`, under the heading `## v{version}` (`version` of `release`, checked against `requirements/` for the digit; "Take the digit from the requirement IDs"), and of `docs/features.md`. Change no version line of the source: it is fixed (`versioning.md`). Read `README.md` against the changes that go out with `readme-product`, and fix it in `release/next` only when a photo or a claim is out of date. Change only `README.md` and `docs/` there: do not change the spec of the photos (`.claude/skills/readme-product/shots/`), because it is not release-only. When a photo cannot be taken because the spec does not fit the screen, file an issue with `issue-plan` (`readme-product`), take no photo of that screen, and name it in the body as a screen that could not be photographed.
- Run neither `run-ci.sh` nor `run-e2e.sh` on the HEAD of `release/next`: its diff is release-only, and `pre-git.sh` and `post-checks.sh` ask no CI, E2E or pass record for it (`testing.md`). Push, and run `post-checks.sh`.
- Open the pull request (`gh pr create`, title `release: v{version}`), or update the open one (`gh pr edit`). The body lists the changes (the issues, with their points), the digit and why, and whether `README.md` needed anything. It holds no decision to release.
- Show the screens that the changes touch: put the photo of each such screen, `docs/assets/readme/{name}.png` at the pushed HEAD of `release/next`, in the body or in a comment of the Release PR, linked by the raw URL of that HEAD's SHA ("Keep one Release PR open while changes wait" in "Rules" at the end of this file). Take no photo here: the first item of this procedure retook, inside the commit, those that were out of date, and the others already show the screen. A screen that could not be photographed has no photo in the Release PR: name it, as the first item says. Name a touched screen, and what changed in it, when no photo shows the change, and say so when the changes touch no screen.
- When `urgent` is true, send a push notification as soon as the Release PR is ready (the PushNotification tool of Claude Code; load it with ToolSearch if it is deferred): that the Release PR is urgent, why (the issue that makes it so), and its URL. Do not merge it.
- In the night run, a unit (a `point:8` issue, or `solo` parts) in the run's pull request is the only change of its Release PR, because it starts only when nothing waits and with nothing outside the unit. A session has no such rule.

### B. See the merged Release PR through

The merge of the Release PR has started the release by itself: `release.yml` tags the merge commit and builds ("After the owner merges the Release PR" in "Rules" at the end of this file). Run `plan-release.py release`. `follow_up` (the tag exists, the Release PR has no mark) and `tag_due` (no tag) say what is left.

- `tag_due` is printed: the tag does not exist yet. Look at `gh run list --workflow release.yml --event pull_request --branch release/next --limit 5` first. A run in progress is the workflow tagging: wait for it. A run that failed in the `tag` job is a finding about the Release PR: write the cause in the hand-over (a `ship` run) or tell the owner (a session), and leave it to the owner. Make the annotated tag on `tag_due.commit` and push it in the same command (`versioning.md`) only when no run of the merge exists; then run `plan-release.py release` again, which prints `follow_up`.
- Run `git fetch origin main`, then watch the release job of the merge (or of the tag you pushed) with `watch-ci.sh {follow_up.commit}` (`{tag_due.commit}` for a tag made by hand) until it ends (`review.md`). If it fails, find the cause with `--log-failed`: retry a failure of the runner or the network with `gh run rerun {run ID} --failed`, and for any other cause write it in the hand-over (a `ship` run) or tell the owner (a session), and leave the release to the owner ("After the owner merges the Release PR" in "Rules" at the end of this file).
- Run `plan-release.py close`.
- Comment the version on each issue listed in the body of the Release PR (`gh pr view {follow_up.pr} --json body`), once the release job has succeeded, and then comment `<!-- released {follow_up.tag} -->` on the Release PR (`gh pr comment {follow_up.pr}`), which closes `follow_up`.

The tag comes first because what waits is counted from the last tag.
When neither `follow_up` nor `tag_due` is printed, nothing is left from a merge.

## Rules

### Keep one Release PR open while changes wait, and let the owner merge it

The owner releases, by merging the Release PR: no schedule and no agent merges it (at the owner's instruction, 2026-11-09; Discussion #293). The agents prepare it, the owner merges it, and the merge tags and releases it by itself (`release.yml`; at the owner's instruction, 2026-11-09; #303).
`plan-release.py release` says what waits (`changes`: merged and not released, a change that is only documentation, `.claude/agents/`, `.claude/rules/` or `.claude/skills/` not counted), whether the Release PR exists, and the version it writes (the first heading of `CHANGELOG.md`; the source holds no version, `versioning.md`).
The 00:30 run looks at it after it has merged its own pull request, and a session does when the owner asks:
- Changes wait and there is no Release PR: open it from the branch `release/next`, with a commit that writes the entries of `CHANGELOG.md` under the heading `## v{version}` and of `docs/features.md` (`versioning.md`).
- Changes wait and the Release PR is open: bring its branch up to date with main, correct the heading `## v{version}` of `CHANGELOG.md` (the digit may have changed), write the entries of the new changes in `CHANGELOG.md` and `docs/features.md`, and update the body.
- Nothing waits: nothing to do.

Its title is `release: v{version}`, and its body holds the changes, the digit and why, and whether `README.md` needed anything. The owner decides when to merge, so the body holds no decision to wait or to release.
The Release PR shows the screens that its changes touch, as photos in its body or in a comment, so that the owner sees the result before the merge (at the owner's instruction, 2026-11-13). The photos are the ones `readme-product` takes from the mocked E2E build with made-up data, the files of `docs/assets/readme/` at the pushed HEAD of `release/next` (the preparer retakes, inside the commit, only those out of date), linked by the raw URL of the commit that holds them (`https://raw.githubusercontent.com/{owner}/{repo}/{commit SHA}/docs/assets/readme/{name}.png`), never a photo of the real app, because the repository is public (`publishing.md`). A screen that the changes touch, where no photo shows the change (a settings tab, a dialog, a part that no photo has), is named in the body with what changed in it. A Release PR whose changes touch no screen has no photo, and its body says so.
The preparer pushes `release/next` and runs `post-checks.sh` before it ends, so that the owner can merge at once. It runs neither `run-ci.sh` nor `run-e2e.sh` on a diff that is release-only (README, CHANGELOG and `docs/`): the push and `post-checks.sh` ask no record for it (`testing.md`, `review.md`; at the owner's instruction, 2026-11-18; #931).
When `urgent` is true (a waiting change or the Release PR has `urgency:high`, or a waiting bug has `importance:high`), the preparer sends a push notification (Claude Code's PushNotification) as soon as the Release PR is ready, saying that it is urgent and giving its URL (at the owner's instruction, 2026-11-09; Discussion #293). It does not merge the Release PR.
In the night run, a unit (a `point:8` issue, or the `solo` parts of one parent) is a Release PR of its own: its parts start only when nothing waits, and nothing new starts, the rest of the unit included, until the owner has merged its Release PR (`plan-release.py next` says `stop`). A session of the owner does not keep a unit apart (at the owner's instruction, 2026-11-10; "Run `ship` once a day at 00:30" in the "Rules" of `.claude/skills/ship/SKILL.md`).
Merged Release PRs are the release history.

```text
変更: #21 Slack の書式を表示する  point:3  (closes #12)
版:   minor（要件 ID S-12 が増えた）
README: 直すところなし
```

```text
Good: the 00:30 run merges its pull request, `release` lists 2 changes and no Release PR -> it opens release/next, pushes, runs `post-checks.sh`, and stops
Good: a waiting bug has importance:high -> the Release PR is ready -> a push notification says it is urgent, and the owner merges
Bad:  the run merges the Release PR itself because the change is urgent
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

### After the owner merges the Release PR, the workflow tags and releases it, and the next run sees it through

The merge of a pull request from `release/next` starts `release.yml`: its `tag` job reads the first `## v{version}` heading of `CHANGELOG.md` at the merge commit, checks the version as for a pushed tag, and pushes the annotated tag on the merge commit, and its `release` job builds and publishes in the same run (at the owner's instruction, 2026-11-09; #303). No agent tags by hand when it works.
1. The owner merges the Release PR, after the preparer has done these in `release/next`: take in main, and write `CHANGELOG.md` (its first heading `## v{version}` is the version, which the workflow reads at the merge and `tag_due` too) and `docs/features.md`. No version line of the source changes: it is fixed (`versioning.md`; at the owner's instruction, 2026-11-09; Discussion #293).
   Read `README.md` against the changes that go out, with `readme-product`: fix a photo or a claim they make out of date in `release/next`, and write in the body that nothing needed it otherwise (at the owner's instruction, 2026-11-07). `README.md` and `docs/` keep the diff release-only.
   Run neither `run-ci.sh` nor `run-e2e.sh` on the HEAD of `release/next`: the release-only diff stands for the review, CI and E2E records alike (`testing.md`; #931). Push, and run `post-checks.sh`.
   Show in the body or in a comment the photos of the screens that the changes touch, from the pushed HEAD ("Keep one Release PR open while changes wait"; at the owner's instruction, 2026-11-13).
2. The next agent to act (the 00:30 run, or a session) runs `plan-release.py release`.
   - `follow_up` is printed (the tag exists, and the Release PR it names has no mark yet): the workflow has tagged, and nobody has seen the release through. Watch the `release` run of the merge to the end (`git fetch origin main`, then `watch-ci.sh {follow_up.commit}`; `review.md`), then do 3 and 4. No `follow_up` and no `tag_due`: nothing left from a merge.
   - `tag_due` is printed: the tag does not exist yet. Look at the runs first (`gh run list --workflow release.yml --event pull_request --branch release/next --limit 5`). A run in progress is the workflow tagging: wait for it, and watch it (`watch-ci.sh {tag_due.commit}`).
     A run that failed in the `tag` job is a finding about the Release PR (a version that is not the heading, a source version that is not fixed, a commit that is not on main): write the cause in the hand-over and tell the owner; do not tag by hand over a failed check. A failure of the runner or the network is retried like the one below.
     Where no run of the merge exists (the workflow was off, or the run was lost), make the annotated tag by hand on the commit `tag_due` names and push it (`versioning.md`); the push starts the `release` run, and the workflow tags nothing that already has a tag.
   - A run that failed in the `release` job after the tag was pushed: find the cause with `--log-failed`. A failure of the runner or the network (nothing in the commit) is retried with `gh run rerun {run ID} --failed`; the rerun builds the tag that is already on the merge commit. Any other cause is fixed with the next patch version (`review.md`), and a published tag is never moved (`versioning.md`); a night run writes the cause in the hand-over and leaves it to the owner.
3. It runs `plan-release.py close`, which closes the parents whose sub-issues are all closed and released.
4. It comments the version on each issue listed in the body of the Release PR, once the `release` run has succeeded, and then marks the Release PR with a comment whose first line is `<!-- released v{version} -->` (`follow_up` of `plan-release.py release` stays open until the mark is there, because the workflow tags at the merge and no agent is there to see it; at the owner's instruction, 2026-11-09; #303). A tag made by hand is followed up the same way.
The tag comes first because what waits is counted from the last tag (`plan-release.py release`).

```text
Good: the owner merges -> the workflow tags v0.33.0 and releases -> the 00:30 run sees `follow_up`, watch-ci.sh succeeds -> close -> "v0.33.0 で対応しました" on each issue -> the mark on the Release PR
Good: tag_due is printed and no run of the merge exists -> tag it by hand on the commit it names, push, and watch
Bad:  comment on the issues before the release run has succeeded
Bad:  comment on the issues and leave no mark, so that the next run comments on them again
Bad:  tag origin/main by hand after another pull request has merged on top of the Release PR (the tag goes on the commit that tag_due names)
Bad:  tag by hand at once when tag_due is printed, while the run of the merge is still going (it tags in a minute)
```
