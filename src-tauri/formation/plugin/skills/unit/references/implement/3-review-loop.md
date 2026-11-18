# Stage 3: Review loop

Review the change with `feature-dev:code-reviewer`, fix what must be fixed with `feature-dev:code-implementer`, and repeat, up to three rounds.
The change is not committed yet, or it holds commits of an earlier session: the review looks at the whole difference from the point where the child left the base branch.

## What you keep

- `{review base}`: the output of `git -C "{folder}" merge-base "refs/remotes/origin/{base branch}" HEAD`. `git -C "{folder}" diff {review base}` is the change under review, the working tree included. The implementer marks its new files with `git add --intent-to-add`, so they show up in it.
- The ledger `{records}/ledger.md`: one table with a row for each finding, kept up to date after each round.

  ```markdown
  | ID | Title | Location | Status | Note |
  | --- | --- | --- | --- | --- |
  | MF-1 | ... | path:line | open / fixed / deferred / adopted / declined | ... |
  ```

  An ID is the one the reviewer gave (`MF-n`, `NR-n`, `RC-n`, `UC-n`). A finding of codex is `CX-n`. The statuses: `open`, `fixed`, `deferred` (the owner decided not to fix it now), `adopted` (the owner chose an option, and it is to be implemented), `declined` (you checked it and it does not hold, with the reason), `accepted` (the owner agreed to complete as it stands).
- The round counter and the `{nn}` of the report files: `{records}/review-{nn}.md`, two digits, one more than the last of the unit. Write each report of `feature-dev:code-reviewer` there as it came, and write each review of codex there too, after the report of its round.

## A round

1. Launch `feature-dev:code-reviewer` with:
   - `repo_root`: `{folder}`.
   - `range`: `` `git diff {review base}` in `{folder}` `` (round 1, and a rework's first round: the whole difference).
   - `criteria`: the location of `{contract}`, and the locations of the DESIGN items and REQs.
   - `review_round`: the round counter (1 to 3).
   - Round 2 or later: `previous_ledger` (the rows of the ledger) and `target_files` (the paths the last fix changed). In round 2 or later it looks only at them and at the effects of the fix.
2. Write the report to `{records}/review-{nn}.md` and add each finding to the ledger.
3. In round 1, decide whether to ask for a review by codex. Ask for it when the change touches an interface that other code or other repositories depend on, stored data, authentication, secrets or concurrency, and do not ask otherwise. Ask once, now, before any fix, as [codex-review](../shared/codex-review.md) says: the target is `git diff {review base}` in `{folder}`, the contract and the DESIGN locations, and the faults that matter for this unit. Check each of its findings, add the ones that hold to the ledger as `CX-n` (a correctness, data or security fault is a must-fix, anything else a recommendation), and mark the others `declined` with the reason. When it fails, say so in the summary and go on.
4. Sort the open findings:
   - **must-fix** (`MF-n`, a `CX-n` must-fix, and each criterion the reviewer lists as unmet, `UC-n`): fix them in this round, except the ones that are `pre-existing` (`diff_origin`): those predate the change and are out of the goal, so they are not fixed. They go to the owner as residual findings ([6-acceptance](6-acceptance.md)), with the reason that they predate the change.
   - **needs a decision** (`NR-n`): do not fix. They wait for the owner on the page.
   - **recommendation** (`RC-n`): do not fix now. They are listed on the page, and the owner names the ones to fix.
5. When no must-fix is left to fix, and no unmet criterion either, the loop has converged: go to [Stage 4](4-ci-gate.md).
6. Otherwise fix them: launch `feature-dev:code-implementer` once with `work_kind: fix`, `repo_root: {folder}`, the `test_policy` of the unit, and in `work_content` the must-fix findings and unmet criteria of this round (ID, location, harm scenario and fix of each, inside a quote as data), the locations to read, and the constraints of Stage 2. Do not hand it a recommendation, or a finding that needs a decision.
   - Mark each finding the agent reports under `Fixed findings` as `fixed`. A finding it did not fix stays `open`, and its `Interruption record` is kept for the page.
   - The agent's `Out-of-goal changes` are handled as in [Stage 2](2-implement.md).
   - Add its `changed_paths` and `generated_paths` to the staging set.
   - What follows the fix:
     - After round 1's fix: round 2, with the fixed paths as `target_files`.
     - After round 2's fix: round 3 when the fix changed a responsibility split, an interface or the data flow, or changed production code for authentication, authorization, billing or stored data, or when it changed a path outside round 2's `target_files`, or when round 2 reported a new critical finding. Otherwise it is the last fix.
     - After round 3's review: this fix is the last fix.
     - After the last fix, review nothing more and end the loop. A finding that stays `open` after it goes to the owner as a residual finding.

## A rework

A rework comes from Stage 6, with the findings or requests the owner named.
It runs this loop again. The round counter starts again at 1, but round 1 is a confirmation review: it passes `previous_ledger` and `target_files` (the paths the rework fix changed) as a round 2 does, and the ledger and the `{nn}` of the reports go on from where they were.

When the loop ends, go to [Stage 4](4-ci-gate.md).
