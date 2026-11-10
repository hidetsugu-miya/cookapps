---
name: issue-dev
description: Implements the open cookapps issues in the order of the plan, up to 10 points a night, one after another on one branch with one pull request, and prepares the Release PR for the owner to merge. Use on /issue-dev and 「次を進めて」. Invoking it is the owner's instruction to start those issues.
---

# issue-dev

One run takes the issues in the order of the plan until their points reach 10, does them one after another in the one worktree on one branch, and merges one pull request that closes them all. It never releases: it prepares the Release PR, and the owner merges it (`.claude/rules/issues.md`).
The owner starts it, either in a session or through the job the owner registered, which runs `.claude/tools/nightly.sh issue-dev` at 00:30 only; nothing else starts it.
A run from that job has no one to answer: never wait on the owner, and end with the hand-over and report of step 8.
`NIGHTLY_DEADLINE_EPOCH` is set in such a run, and in no session. The limits below (the deadline, the 10 points, the unit rule of a `point:8` issue and the `solo` parts) apply only when it is set; `nightly-limit.sh` and `plan-release.py next` know them. A session has none of them: the issues the owner names may be of any units, in one pull request and one Release PR (`issues.md`).

Tools are at `"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/"`.

## Steps

1. **Read the hand-over.** Run `handover.sh read`.
   - The owner's replies (the comments without the mark whose author is the owner) come first. Take them as instructions: answer their questions in the work, and do what they say before anything else.
   - Note the issues the last hand-over lists as in hand, and the branch that holds them. They are this run's own: continue them, and pass their numbers as `--mine` in step 4.
   - The first run has no hand-over; go on.
2. **Do what the owner's merge left.** The merge of the Release PR has started the release by itself: `release.yml` tags the merge commit and builds (`issues.md`, "After the owner merges the Release PR"). Run `plan-release.py release`. `follow_up` (the tag exists, the Release PR has no mark) and `tag_due` (no tag) say what is left.
   - `tag_due` is printed: the tag does not exist yet. Look at `gh run list --workflow release.yml --event pull_request --branch release/next --limit 5` first. A run in progress is the workflow tagging: wait for it. A run that failed in the `tag` job is a finding about the Release PR: write the cause in the hand-over and leave it to the owner. Make the annotated tag on `tag_due.commit` and push it in the same command (`versioning.md`) only when no run of the merge exists; then run `plan-release.py release` again, which prints `follow_up`.
   - Run `git fetch origin main`, then watch the release job of the merge (or of the tag you pushed) with `watch-ci.sh {follow_up.commit}` (`{tag_due.commit}` for a tag made by hand) until it ends (`review.md`). If it fails, find the cause with `--log-failed`: retry a failure of the runner or the network with `gh run rerun {run ID} --failed`, and for any other cause write it in the hand-over and leave the release to the owner (`issues.md`, "After the owner merges the Release PR").
   - Run `plan-release.py close`.
   - Comment the version on each issue listed in the body of the Release PR (`gh pr view {follow_up.pr} --json body`), once the release job has succeeded, and then comment `<!-- released {follow_up.tag} -->` on the Release PR (`gh pr comment {follow_up.pr}`), which closes `follow_up`.
   The tag comes first because what waits is counted from the last tag.
3. **Reorder.** First run `dependabot-issues.sh`: it makes an issue for each open Dependabot pull request that has none (`issues.md`), and prints the issue numbers. If it fails, write its output in the hand-over (step 8) and go on with the reorder. Then do `issue-plan` as "To only reorder" (`plan-release.py unsplit --mine {numbers}`, step 3 for each issue it prints, then snapshot, `release-planner` with `mode: order`, apply). This splits and places the issues made outside a session too. Launch `release-planner` here once, at the start of the run: `apply` saves the plan it accepts as `.claude/plan.json` of the main checkout, and step 4 reads it.
4. **Pick the work.** Run `plan-release.py next --mine {numbers}`. `start` is the queue in the order of the plan, `in_progress` the issues of the hand-over that are still open, and `held`, `needs_owner`, `blocked` and `waits_for_release` are issues left out.
   - `stop` is set (the night run only): a `point:8` change, or a part of one (label `solo`), waits for the owner's merge. Start nothing; go to step 7.
   - `start` and `in_progress` are empty: report `held`, `needs_owner` with what each needs decided, `blocked` with its blockers and `waits_for_release`, and go to step 7.
   - Otherwise report those lists as skipped, and go on. `held` is an issue an open pull request closes that the hand-over does not list as yours: someone else's work, leave it alone.
5. **Take the worktree.** The branch is the one the hand-over lists, or `night/{YYYY-MM-DD}`. Run `use-worktree.sh {branch}` and work in the path it prints (`worktree.md`). On exit 3 the worktree is in use by work that is not this run's (a session's branch with uncommitted changes, or with commits not pushed): touch nothing, write what it said in the hand-over, and go to step 8.
6. **Implement, one issue after another.** The issues of `in_progress` come first, and their points count as taken. For each issue of `start` in order, run `nightly-limit.sh issue {n} --taken {the numbers taken so far in this run}`:
   - exit 0: take it, and add it to the taken.
   - exit 3: it does not fit the 10 points (or, in the night run, the unit rule: a `point:8` issue and the `solo` parts of one milestone are a unit, which starts only with its own parts); try the next issue of `start`.
   - exit 1: the run's 3 hours are over; start nothing new, and go on to 6.4 with what is taken. The deadline stops new issues only: the branch in hand is finished.
   1. Read the issue, and the requirement section it changes. Check the author first (`issues.md`).
      An issue made by `dependabot-issues.sh` (its body starts with `<!-- dependabot #N -->`) is implemented on the run's branch: never check out the Dependabot branch, and redo the same update by the steps in the issue. After the merge (6.5), close the original pull request with `gh pr close {N} --comment "..."` naming the pull request that closes the issue. If the original pull request is already closed (Dependabot closes its own when it is superseded or the dependency is up to date), implement nothing: close the issue as not planned, with a comment that gives the reason.
   2. A product decision turned up that the issue does not settle: add `needs:owner` with the question through `issue-plan`, drop the issue's unpushed commits (`git reset --hard {the commit before its first one}` only when it is the last issue of the branch; otherwise `git revert` its commits, so that the commits of the other issues stay), take it out of the taken, and go on to the next issue. A layout-first issue needs its layout approved by the owner, so it is also a product decision until that is on the issue.
   3. Implement with `code-implementer`, and change the requirement section in the same branch. Commit the issue (`{prefix}: {summary} (#{n})`), then run `run-ci.sh` in the background (`run_in_background`) and wait for its exit, so that a static or unit failure is found before the next issue. Fix a failure before going on.
   4. When nothing more is taken, run `run-e2e.sh` in the background the same way. Then follow `review.md` as it stands, once, on the range `origin/main..HEAD` of the whole branch: reviewers, `release-verifier`, fixes. If the process of `review.md` ends with an issue that cannot pass (the redesign limit), undo that issue's commits only with `git revert` (also on a branch that is not pushed: later issues' commits and the review fixes must stay), hand it over with the finding, and review the rest again.
   5. Push, `gh pr create` with one `Closes #{n}` line for each issue, `post-checks.sh`, `gh pr merge --merge`, and fast-forward the main checkout (`worktree.md`, `issues.md`). The hook then runs `plan-release.py release`.
7. **Prepare the Release PR.** Read the output of `plan-release.py release` that the hook printed after the merge of 6.5; run the command yourself only when this run merged nothing (it came here from step 4) or the hook said that it failed. If `changes` is empty, go to step 8. Otherwise take the worktree for `release/next` (`use-worktree.sh release/next`; on exit 3, say so in the hand-over and go to step 8) and do "Keep one Release PR open while changes wait" in `issues.md`:
   - Take in main (`git merge origin/main`), write the entries of `CHANGELOG.md`, under the heading `## v{version}` (`version` of `release`, checked against `requirements/` for the digit; "Take the digit from the requirement IDs"), and of `docs/features.md`. Change no version line of the source: it is fixed (`versioning.md`). Read `README.md` against the changes that go out with `readme-product`, and fix it in `release/next` only when a photo or a claim is out of date.
   - Run `run-ci.sh` and then `run-e2e.sh` on the HEAD of `release/next` (in the background, as in 6.3), push, and run `post-checks.sh`.
   - Open the pull request (`gh pr create`, title `release: v{version}`), or update the open one (`gh pr edit`). The body lists the changes (the issues, with their points), the digit and why, and whether `README.md` needed anything. It holds no decision to release.
   - When `urgent` is true, send a push notification as soon as the Release PR is ready (the PushNotification tool of Claude Code; load it with ToolSearch if it is deferred): that the Release PR is urgent, why (the issue that makes it so), and its URL. Do not merge it.
   - In the night run, a unit (a `point:8` issue, or `solo` parts) in the run's pull request (step 6) is the only change of its Release PR, because it starts only when nothing waits and with nothing outside the unit. A session has no such rule.
8. **Hand over and report.** Give the worktree back with `use-worktree.sh --park` (it exits 3 when the worktree still holds unpushed work, which the hand-over then lists). Write the hand-over to a file in the scratchpad, and post it with `handover.sh write {file}`. Write: the issues in hand with their branch and stage; this run's decisions with the reasons (the order, why something waited or was dropped); the state of the Release PR (made, updated, urgent, or nothing to prepare) and of a tag that was due; the questions to the owner; and what the next run does first. No personal information (`publishing.md`).
   Then report what merged, what waits for the owner's merge, what was skipped and why, and the next issues from `plan-release.py next`.

## Stop

- `review.md` is the only route to stop a review for the owner.
- A force push or a history rewrite of a pushed branch: ask first. Dropping the unpushed commits of this run's own branch (6.2) is not a rewrite of history that anyone has.
- A new product decision: step 6.2, not a stop of the whole run.
- The run's limit: `nightly-limit.sh` says no. The process is never killed; the run finishes steps 6.4 to 8.

Do not widen the run: a request that arrives during it becomes an issue through `issue-plan`.
