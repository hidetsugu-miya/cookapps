---
name: milestone-dev
description: Implements the issues of the first open cookapps milestone, one pull request at a time through to main, and releases when the release table says so. Use on /milestone-dev and 「次のマイルストーンを進めて」「次を進めて」. Invoking it is the owner's instruction to start those issues.
---

# milestone-dev

One run covers one milestone. The owner starts it, either in a session or through the job the owner registered, which runs `.claude/tools/nightly.sh milestone-dev` at 05:00 only; nothing else starts it (`.claude/rules/issues.md`).
A run from that job has no one to answer: never wait on the owner, and end with the hand-over and report of step 7.
`NIGHTLY_DEADLINE_EPOCH` is set in such a run, and in no session. The limits below apply only when it is set; the script `nightly-limit.sh` knows them.

Tools are at `"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/"`.

## Steps

1. **Read the hand-over.** Run `handover.sh read`.
   - The owner's replies (the comments without the mark whose author is the owner) come first. Take them as instructions: answer their questions in the work, and do what they say before anything else.
   - Note the issues the last hand-over lists as in hand (with their branch, worktree and stage). They are this run's own: continue them, and pass their numbers as `--mine` in step 3.
   - The first run has no hand-over; go on.
2. **Reorder.** Do `issue-plan` from its step 4 (snapshot, `release-planner` with `mode: order`, apply). This places the issues made outside a session too.
3. **Pick the work.** Run `plan-release.py next --mine {numbers}`.
   - `milestone` is null: say that nothing is planned, and go to step 7.
   - `start` and `in_progress` are empty: report `held`, `needs_owner` with what each needs decided and `blocked` with its blockers, and go to step 7.
   - Otherwise report `held`, `needs_owner` and `blocked` as skipped, and go on. `held` is an issue another session of the owner may hold (an open pull request, or a worktree named `issue-{n}`) that the hand-over does not list as yours: leave it alone and go to the next one.
   - Before starting, run `ListAgents` and `git worktree list`, and ask each other cookapps session what it is working on. Skip an issue another session has, and tell the others which issues this run takes.
4. **Release first if an 8-point issue is next.** When an issue of `start` is `point:8` and `waiting` is not empty, release what is waiting first (step 6), and run step 3 again. `issues.md` requires this before merging an 8-point change.
5. **Implement the issues of `in_progress`, then `start`, in parallel where they do not overlap** (at the owner's instruction, 2026-11-07; #154). Issues that touch none of the same files or requirement sections, and that do not block one another, each run 5.1 to 5.5 at the same time in their own worktree; launch their `code-implementer`s, and later their reviewers, in one message. Issues that overlap, or one with an open blocker in the set, wait for the merge of the one before them and start from the new main. Before each new issue run `nightly-limit.sh issue`: on exit 1, start nothing new, leave the issues in hand as they are (committed in their worktrees), and go to step 7.
   Merges stay one at a time (5.6), in the order of `in_progress`, then `start`, among the issues ready to merge; an issue that stopped (5.2, the limit, or a redesign under `review.md`) does not hold the others. A branch that merges after another has merged takes in main, reruns `run-e2e.sh` and goes through the first round of `review.md` again on `origin/main..HEAD` (`worktree.md`: a branch that takes in a moved main is reviewed there, so that two changes that break each other are found before the merge). When a `point:8` issue is in the set, release what is waiting before its merge (step 4), and release it (step 6) before the next merge of the set, so that it is a version of its own.
   1. Read the issue, and the requirement section it changes. Check the author first (`issues.md`).
   2. A product decision turned up that the issue does not settle: add `needs:owner` with the question through `issue-plan`, and go on to the next issue. A layout-first issue needs its layout approved by the owner, so it is also a product decision until that is on the issue.
   3. Make the worktree and its branch from `origin/main` with `new-worktree.sh` (`worktree.md`): `feat/{requirement ID}`, `fix/{summary}` or `docs/{summary}`; put `issue-{n}` in the name of a branch that has no requirement ID, so that other runs and sessions see whose it is. It also copies `.worktreeinclude` and runs `npm ci`; work in the path it prints. Following `worktree.md`, tell the other cookapps sessions the branch and the files it touches.
   4. Implement with `code-implementer`, and change the requirement section in the same pull request.
   5. Follow `review.md` as it stands: commit, `run-e2e.sh`, reviewers, `release-verifier`, fixes. Run `nightly-limit.sh issue` before the review begins; on exit 1, stop here as above.
   6. Following `worktree.md`, tell the other cookapps sessions before the merge. Follow `issues.md`: push, `gh pr create` with `Closes #{n}`, `post-checks.sh`, `gh pr merge --merge`, fast-forward the main checkout. The hook runs `sync` after the merge.
   7. Remove the worktree when `worktree.md` says so.
   8. **Decide the release.** After each merge, run `plan-release.py release-facts`. When its `rule` is R0 to R3 the `decision` stands; when it is R4, launch `release-planner` with `mode: release` and that output, and take its decision. Write the rule, the decision and the reason in the Release PR body. The table alone decides: a finished milestone is not a reason to release.
6. **Release when the decision says so**, by the steps of "Release by merging the Release PR" in `issues.md`, including the check of `README.md` with `readme-product` and `plan-release.py close {tag}`, and the reorder of step 2.
   In a run from the job, run `nightly-limit.sh release` first: on exit 1 (the run's 3 hours are over) do not release; the Release PR waits for the next run, and the hand-over says so. There is no release window: the 05:00 run releases (at the owner's instruction, 2026-11-07). A release the owner ordered in a session has no such limit.
7. **Hand over and report.** Write the hand-over to a file in the scratchpad, and post it with `handover.sh write {file}`. Write: the issues in hand with their branch, worktree and stage; this run's decisions with the reasons (the order, the release, why something waited); the questions to the owner; and what the next run does first. No personal information (`publishing.md`).
   Then report what merged, what is released, what is waiting and why, what was skipped, and the next milestone from `plan-release.py next`.

## Stop

- `review.md` is the only route to stop a review for the owner.
- A force push or a history rewrite: ask first.
- A new product decision: step 5.2, not a stop of the whole run.
- The run's limit: `nightly-limit.sh` says no. The process is never killed; the run finishes step 7.

Do not widen the run: a request that arrives during it becomes an issue through `issue-plan`.
