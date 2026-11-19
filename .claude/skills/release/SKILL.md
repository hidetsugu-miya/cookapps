---
name: release
description: Prepares the つなぎAI Release PR (opens or updates `release/next` with the CHANGELOG and features entries, the photos and the body), merges it in the night run, and sees a merged Release PR through (the tag, the release run, the comments on the issues, the mark). Use on 「Release PR を作って」「Release PR を更新して」「リリースを見届けて」, when `post-gh.sh` tells a session to do so after `gh pr merge`, and from steps 2 and 8 of `ship`.
---

# release

Two procedures. Procedure A prepares the Release PR when changes wait for the release. Procedure B sees the release of a merged Release PR through.
The rules of both are in "Rules" at the end of this file.
An agent prepares the Release PR (A) and sees it through after the merge (B). The night run merges the Release PR it prepared, in the same run (the last item of A); in a session the owner merges it (at the owner's instruction, 2026-11-19).
Tools are at `"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/"`.

## Steps

### A. Prepare the Release PR

In a `ship` run, read the output of `plan-release.py release` that `post-gh.sh` printed after the run's `gh pr merge`; run the command yourself when the run merged nothing, or the hook said that it failed. In a session, always run `plan-release.py release` first, because an output printed earlier may be stale (the owner may have merged a Release PR since). If `changes` is empty, there is nothing to prepare: stop. In the night run, then look for an open issue filed for a Release PR E2E failure, which carries the label `e2e:release` (`gh issue list --state open --label e2e:release --json number,title`): when one exists, prepare nothing and run no E2E, because main does not hold its fix yet; write in the hand-over that the release waits for that issue, and stop. A session is not bound by this: the owner may ask for a retry. Otherwise take the worktree for `release/next` (`use-worktree.sh release/next`; on exit 3 another session has `release/next` checked out and is preparing the Release PR, so touch nothing, say so, in a `ship` run in the hand-over, and stop) and do "Keep one Release PR open while changes wait" in "Rules" at the end of this file:

- Take in main (`git merge origin/main`), write the entries of `CHANGELOG.md`, under the heading `## v{version}` (`version` of `release`, checked against `requirements/` for the digit; "Take the digit from the requirement IDs"), and of `docs/features.md`. Change no version line of the source: it is fixed (`versioning.md`). Read `README.md` against the changes that go out with `readme-product`, and fix it in `release/next` only when a photo or a claim is out of date. Change only `README.md` and `docs/` there: do not change the spec of the photos (`.claude/skills/readme-product/shots/`), because it is not release-only. When a photo cannot be taken because the spec does not fit the screen, file an issue with `issue-plan` (`readme-product`), take no photo of that screen, and name it in the body as a screen that could not be photographed. Commit the result.
- Run `run-e2e.sh` once on the committed HEAD of `release/next`, before the push ("Run E2E once, when the Release PR is prepared" in "Rules" at the end of this file; at the owner's instruction, 2026-11-19; #1023). It needs a clean tree, runs `run-ci.sh` beside wdio when HEAD has no CI record, and writes the E2E record that `pre-git.sh` and `post-checks.sh` ask of `release/next`. Run it in the main checkout's copy (`e2e.md`), in the background, and write the body of the Release PR (the changes, the digit and why, `README.md`) while it runs; wait for it before the push and before `gh pr create` or `gh pr edit`. The photo URLs need the pushed SHA, so they come after the push (the next items). When it passes, push, and run `post-checks.sh`. When it fails, push nothing and merge nothing, and do not give the worktree back (its commits are not on the remote, so `--park` refuses it), and read the failed specs in `.claude/e2e/{HEAD SHA}.log` of the main checkout. Then, first, run each failed spec alone with `run-e2e.sh --only {spec name}`:
  - A spec that passes alone is not yet a chance failure: find how it failed (the log, `script_timeouts`). When no code needs a fix, run `run-e2e.sh` in full once more on the same HEAD (it finds the CI record and does not run CI again); when it passes, the record is written and the procedure goes on with the push.
  - A spec that fails alone, or a full run that fails again, is a defect of main:
    - in a session, tell the owner which specs failed, fix them in a `fix/{summary}` branch of a worktree of its own through the feature flow (`run-e2e.sh --only {spec name}` until each passes, `review.md`, its own pull request, merged), and prepare the Release PR again from the first item of this procedure;
    - in the night run, file an issue for each failed spec through `issue-plan` (a bug, with the spec name and the log lines of the failure as the reproduction, `issues.md`; no `needs:owner`), titled `E2E: {spec 名} が Release PR で落ちる` and labeled `e2e:release` besides `bug` and its point label (create the label first with `gh label create e2e:release --force`, because `gh issue create --label` fails on a missing label). Look first for an open one of that spec (`gh issue list --state open --label e2e:release --json number,title`, and match the spec name in the titles it returns), and when one names the same spec, comment the new log lines on it and file nothing. Write the issue in the hand-over, and merge no Release PR that night. The next run prepares no Release PR while such an issue is open (the start of this procedure): it implements the issue in the order of the plan, and prepares the Release PR when it has merged. When `plan-release.py next` says `stop` (a unit waits), nothing starts and the release waits for the owner: the hand-over says so.
  - In a session, when E2E passes on the Release PR (the first run or the full rerun) while an open `e2e:release` issue names specs that now pass, comment the HEAD SHA of the passing record and why the failure was judged a chance one, and close the issue, so that the night run does not keep holding the release.
- Open the pull request (`gh pr create`, title `release: v{version}`), or update the open one (`gh pr edit`). Give the worktree back with `use-worktree.sh --park` from inside it when the Release PR is ready (in the night run, after its merge), so that the next preparer can take `release/next`. The body lists the changes (the issues, with their points), the digit and why, and whether `README.md` needed anything. It holds no decision to release.
- Show the screens that the changes touch: put the photo of each such screen, `docs/assets/readme/{name}.png` at the pushed HEAD of `release/next`, in the body or in a comment of the Release PR, linked by the raw URL of that HEAD's SHA ("Keep one Release PR open while changes wait" in "Rules" at the end of this file). Take no photo here: the first item of this procedure retook, inside the commit, those that were out of date, and the others already show the screen. A screen that could not be photographed has no photo in the Release PR: name it, as the first item says. Name a touched screen, and what changed in it, when no photo shows the change, and say so when the changes touch no screen.
- When `urgent` is true in a session, send a push notification as soon as the Release PR is ready (the PushNotification tool of Claude Code; load it with ToolSearch if it is deferred): that the Release PR is urgent, why (the issue that makes it so), and its URL. Do not merge it. The night run sends none: it merges the Release PR itself (next item).
- In the night run, a unit (a `point:8` issue, or `solo` parts) in the run's pull request is the only change of its Release PR, because it starts only when nothing waits and with nothing outside the unit. A session has no such rule.
- In the night run, merge the Release PR as soon as its E2E has passed, it is pushed and `post-checks.sh` has sent its statuses: `gh pr merge {number} --merge`, and fast-forward the main checkout (`worktree.md`). Right after the merge `tag_due` is printed, which is normal: do not tag by hand. Run `git fetch origin main`, wait for the `release` run with `watch-ci.sh {tag_due.commit}` (it waits for the run to appear), and when it ends run `plan-release.py release` to get `follow_up`, then close, comment on the issues and mark the Release PR. Then do Procedure B in the same run, without waiting for the next one ("Keep one Release PR open while changes wait, and merge it in the night run" in "Rules" at the end of this file). A session stops after the previous items: the owner merges it.

### B. See the merged Release PR through

The merge of the Release PR has started the release by itself: `release.yml` tags the merge commit and builds ("After the Release PR is merged" in "Rules" at the end of this file). Right after a merge made by this run, use the output that the hook of `post-gh.sh` printed, and run `plan-release.py release` yourself once, when the `release` run has ended and you need `follow_up`; otherwise run it now. `follow_up` (the tag exists, the Release PR has no mark) and `tag_due` (no tag) say what is left.

- `tag_due` is printed: the tag does not exist yet. Look at `gh run list --workflow release.yml --event pull_request --branch release/next --limit 5` first. A run in progress is the workflow tagging: wait for it. A run that failed in the `tag` job is a finding about the Release PR: write the cause in the hand-over (a `ship` run) or tell the owner (a session), and leave it to the owner. When this run has just merged the Release PR, a run that is not in the list yet is not a missing run: do not tag by hand, and wait with `watch-ci.sh {tag_due.commit}`. Make the annotated tag on `tag_due.commit` and push it in the same command (`versioning.md`) only when no run of the merge exists; then run `plan-release.py release` again, which prints `follow_up`.
- Run `git fetch origin main`, then watch the release job of the merge (or of the tag you pushed) with `watch-ci.sh {follow_up.commit}` (`{tag_due.commit}` for a tag made by hand) until it ends (`review.md`). If it fails, find the cause with `--log-failed`: retry a failure of the runner or the network with `gh run rerun {run ID} --failed`, and for any other cause, in a `ship` run write it in the hand-over and leave the release to the owner, and in a session fix it with the next patch version (`review.md`) ("After the Release PR is merged" in "Rules" at the end of this file). `watch-ci.sh` waits up to 2 minutes for the run of the merge to appear, so a night run that has just merged calls it at once.
- Run `plan-release.py close`.
- Comment the version on each issue listed in the body of the Release PR (`gh pr view {follow_up.pr} --json body`), once the release job has succeeded, and then comment `<!-- released {follow_up.tag} -->` on the Release PR (`gh pr comment {follow_up.pr}`), which closes `follow_up`.

The tag comes first because what waits is counted from the last tag.
When neither `follow_up` nor `tag_due` is printed, nothing is left from a merge.

## Rules

### Keep one Release PR open while changes wait, and merge it in the night run, or let the owner merge it in a session

The agents prepare the Release PR, and the merge tags and releases it by itself (`release.yml`; at the owner's instruction, 2026-11-09; #303). The night run merges the Release PR that it prepared, with the account the run uses, which is the owner's, so the `tag` job of `release.yml` accepts the merge, and it sees the release through in the same run (at the owner's instruction, 2026-11-19; it replaces "no schedule and no agent merges it" of 2026-11-09; Discussion #293, for the night run). In a session the owner merges it, as before.
`plan-release.py release` says what waits (`changes`: merged and not released, a change that is only documentation, `.claude/agents/`, `.claude/rules/` or `.claude/skills/` not counted), whether the Release PR exists, and the version it writes (the first heading of `CHANGELOG.md`; the source holds no version, `versioning.md`).
The 00:30 run looks at it after it has merged its own pull request, or, when it merged nothing, at step 8 of `ship`, and a session does when the owner asks:
- Changes wait and there is no Release PR: open it from the branch `release/next`, with a commit that writes the entries of `CHANGELOG.md` under the heading `## v{version}` and of `docs/features.md` (`versioning.md`).
- Changes wait and the Release PR is open: bring its branch up to date with main, correct the heading `## v{version}` of `CHANGELOG.md` (the digit may have changed), write the entries of the new changes in `CHANGELOG.md` and `docs/features.md`, and update the body.
- Nothing waits: nothing to do.

Its title is `release: v{version}`, and its body holds the changes, the digit and why, and whether `README.md` needed anything. Whoever merges decides when, so the body holds no decision to wait or to release.
The Release PR shows the screens that its changes touch, as photos in its body or in a comment, so that the owner sees the result before the merge (at the owner's instruction, 2026-11-13). The photos are the ones `readme-product` takes from the mocked E2E build with made-up data, the files of `docs/assets/readme/` at the pushed HEAD of `release/next` (the preparer retakes, inside the commit, only those out of date), linked by the raw URL of the commit that holds them (`https://raw.githubusercontent.com/{owner}/{repo}/{commit SHA}/docs/assets/readme/{name}.png`), never a photo of the real app, because the repository is public (`publishing.md`). A screen that the changes touch, where no photo shows the change (a settings tab, a dialog, a part that no photo has), is named in the body with what changed in it. A Release PR whose changes touch no screen has no photo, and its body says so.
The preparer runs `run-e2e.sh` once on the HEAD of `release/next`, pushes it and runs `post-checks.sh` before it ends, so that the owner, or the night run, can merge at once. The review and CI records are not asked of a diff that is release-only (README, CHANGELOG and `docs/`; `testing.md`, `review.md`; at the owner's instruction, 2026-11-18; #931), but the E2E record always is: `pre-git.sh` refuses the push of `release/next` without it, and `post-checks.sh` sends the status `e2e` of this PR only with it ("Run E2E once, when the Release PR is prepared" below).
When `urgent` is true (a waiting change or the Release PR has `urgency:high`, or a waiting bug has `importance:high`), the preparer in a session sends a push notification (Claude Code's PushNotification) as soon as the Release PR is ready, saying that it is urgent and giving its URL (at the owner's instruction, 2026-11-09; Discussion #293). It does not merge the Release PR. The night run sends none, because it merges and releases the Release PR in the same run (at the owner's instruction, 2026-11-19).
The night run merges the Release PR when Procedure A has pushed it and `post-checks.sh` has sent its statuses, whether or not its own pull request merged in that run (a run that came from step 5 of `ship` with changes waiting merges it too): `gh pr merge {number} --merge`, then the main checkout is fast-forwarded and Procedure B follows. When the merge is refused (the ruleset, a missing status), or the release fails for a cause other than the runner or the network, the run writes the cause in the hand-over and leaves it to the owner, who merges or fixes it in a session.
In the night run, a unit (a `point:8` issue, or the `solo` parts of one parent) is a Release PR of its own: its parts start only when nothing waits, and nothing new starts, the rest of the unit included, until its Release PR is merged (`plan-release.py next` says `stop`; the night run merges it itself, so that this holds only when the merge was refused or the run ended before it). A session of the owner does not keep a unit apart (at the owner's instruction, 2026-11-10; "Run `ship` once a day at 00:30" in the "Rules" of `.claude/skills/ship/SKILL.md`).
Merged Release PRs are the release history.

```text
変更: #21 Slack の書式を表示する  point:3  (closes #12)
版:   minor（要件 ID S-12 が増えた）
README: 直すところなし
```

```text
Good: the 00:30 run merges its pull request, `release` lists 2 changes and no Release PR -> it opens release/next, pushes, runs `post-checks.sh`, merges it and sees the release through
Good: the 00:30 run merged its pull request, and Procedure A pushed the Release PR -> `gh pr merge --merge` -> the main checkout is fast-forwarded -> Procedure B watches the release run in the same run
Good: the 00:30 run merged nothing, and `release` lists a change that waits -> it prepares the Release PR, merges it and sees it through
Good: in a session a waiting bug has importance:high -> the Release PR is ready -> a push notification says it is urgent, and the owner merges
Bad:  a session merges the Release PR itself because the change is urgent
Bad:  the 00:30 run sends a push notification that the Release PR is urgent and leaves it open for the owner
Bad:  the body of the Release PR says "wait" or "release now" (there is no such decision to write)
```

### Run E2E once, when the Release PR is prepared, and merge only a Release PR whose E2E passed

E2E is not run for a feature's pull request (`e2e.md`, `review.md`). The preparer runs `run-e2e.sh` once on the committed HEAD of `release/next`, which has taken in main and holds the entries of `CHANGELOG.md` and `docs/`, so that the run covers main as it will be released (at the owner's instruction, 2026-11-19; #1023: GitHub's runner took about 13 minutes for a run and some specs failed only there, so E2E stays local and once per release; measured in #1021). Its record is a condition of the Release PR: `pre-git.sh` refuses the push of `release/next` without it (`check-release-e2e.sh`: the record of HEAD, or the newest record of `origin/main..HEAD` with only release work after it), and `post-checks.sh` sends the status `e2e` of that PR, which the ruleset requires, only with it.
When E2E fails, each failed spec is run alone first (`run-e2e.sh --only {spec name}`); a spec that passes alone is read for how it failed, and when no code needs a fix `run-e2e.sh` runs once more in full on the same HEAD (a failure that does not reproduce files no issue, `issues.md`). When a spec fails alone, or the full run fails again, the Release PR is neither pushed nor merged. A session fixes the spec in a `fix/` pull request and prepares the Release PR again. The night run files a bug issue titled `E2E: {spec 名} が Release PR で落ちる` and labeled `e2e:release`, with the failed spec and the log lines (it comments on an open `e2e:release` issue of the same spec instead of filing another), writes it in the hand-over, and merges no Release PR that night. It prepares none, and runs no E2E, while such an issue is open, so that a failure that stays does not file a new issue every night (a session is not bound by this, and closes the issue when E2E passes there).
A change that lands in `release/next` after the run (a taken-in main, or a file outside README, CHANGELOG and `docs/`) is not release-only, so the push asks for the run again.

```text
Good: the Release PR is prepared -> commit -> run-e2e.sh once -> passes -> push -> post-checks.sh
Good: run-e2e.sh fails in `inbox` in the night run, and `--only inbox` fails too -> an issue `E2E: inbox が Release PR で落ちる` labeled `e2e:release` with the log lines, the hand-over says it, no Release PR is merged
Good: run-e2e.sh fails in `inbox`, `--only inbox` passes, the log shows a timeout and no code needs a fix -> run-e2e.sh once more in full passes -> push
Good: the night run finds an open `e2e:release` issue at step 8 -> no Release PR and no E2E, the hand-over says that the release waits for it
Good: run-e2e.sh fails in a session -> a fix/ pull request fixes the spec -> merged -> the Release PR is prepared again and E2E runs again
Bad:  push release/next and merge it with no E2E record
Bad:  merge a Release PR whose E2E failed, because the failed spec looks like a flake
Bad:  the night run files a second issue for the same spec every night, or prepares the Release PR again while its issue is open
Bad:  run E2E on the feature's branch to have it done before the Release PR
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
1. The Release PR is merged (by the night run right after the preparer's push, or by the owner in a session), after the preparer has done these in `release/next`: take in main, and write `CHANGELOG.md` (its first heading `## v{version}` is the version, which the workflow reads at the merge and `tag_due` too) and `docs/features.md`. No version line of the source changes: it is fixed (`versioning.md`; at the owner's instruction, 2026-11-09; Discussion #293).
   Read `README.md` against the changes that go out, with `readme-product`: fix a photo or a claim they make out of date in `release/next`, and write in the body that nothing needed it otherwise (at the owner's instruction, 2026-11-07). `README.md` and `docs/` keep the diff release-only.
   Commit, and run `run-e2e.sh` once on the HEAD of `release/next` ("Run E2E once, when the Release PR is prepared" below). The release-only diff stands for the review and CI records (`testing.md`; #931), and not for the E2E record. Push, and run `post-checks.sh`.
   Show in the body or in a comment the photos of the screens that the changes touch, from the pushed HEAD ("Keep one Release PR open while changes wait"; at the owner's instruction, 2026-11-13).
2. The agent that merged it (the 00:30 run), or else the next agent to act (the 00:30 run, or a session), runs `plan-release.py release`.
   - `follow_up` is printed (the tag exists, and the Release PR it names has no mark yet): the workflow has tagged, and nobody has seen the release through. Watch the `release` run of the merge to the end (`git fetch origin main`, then `watch-ci.sh {follow_up.commit}`; `review.md`), then do 3 and 4. No `follow_up` and no `tag_due`: nothing left from a merge.
   - `tag_due` is printed: the tag does not exist yet. Look at the runs first (`gh run list --workflow release.yml --event pull_request --branch release/next --limit 5`). A run in progress is the workflow tagging: wait for it, and watch it (`watch-ci.sh {tag_due.commit}`). When the 00:30 run has just merged the Release PR, the run may not be listed yet: do not tag by hand, and wait with `watch-ci.sh {tag_due.commit}`, which waits for the run to appear.
     A run that failed in the `tag` job is a finding about the Release PR (a version that is not the heading, a source version that is not fixed, a commit that is not on main): write the cause in the hand-over and tell the owner; do not tag by hand over a failed check. A failure of the runner or the network is retried like the one below.
     Where no run of the merge exists (the workflow was off, or the run was lost), make the annotated tag by hand on the commit `tag_due` names and push it (`versioning.md`); the push starts the `release` run, and the workflow tags nothing that already has a tag.
   - A run that failed in the `release` job after the tag was pushed: find the cause with `--log-failed`. A failure of the runner or the network (nothing in the commit) is retried with `gh run rerun {run ID} --failed`; the rerun builds the tag that is already on the merge commit. Any other cause is fixed with the next patch version (`review.md`), and a published tag is never moved (`versioning.md`); a night run writes the cause in the hand-over and leaves it to the owner (at the owner's instruction, 2026-11-19: the night run that merged the Release PR sees it through in the same run, and a failure that is not the runner or the network is left to the owner).
3. It runs `plan-release.py close`, which closes the parents whose sub-issues are all closed and released.
4. It comments the version on each issue listed in the body of the Release PR, once the `release` run has succeeded, and then marks the Release PR with a comment whose first line is `<!-- released v{version} -->` (`follow_up` of `plan-release.py release` stays open until the mark is there, because the workflow tags at the merge and no agent is there to see it; at the owner's instruction, 2026-11-09; #303). A tag made by hand is followed up the same way.
The tag comes first because what waits is counted from the last tag (`plan-release.py release`).

```text
Good: the 00:30 run (or the owner) merges -> the workflow tags v0.33.0 and releases -> the run sees `follow_up`, watch-ci.sh succeeds -> close -> "v0.33.0 で対応しました" on each issue -> the mark on the Release PR
Good: tag_due is printed and no run of the merge exists -> tag it by hand on the commit it names, push, and watch
Bad:  comment on the issues before the release run has succeeded
Bad:  comment on the issues and leave no mark, so that the next run comments on them again
Bad:  tag origin/main by hand after another pull request has merged on top of the Release PR (the tag goes on the commit that tag_due names)
Bad:  tag by hand at once when tag_due is printed, while the run of the merge is still going (it tags in a minute)
```
