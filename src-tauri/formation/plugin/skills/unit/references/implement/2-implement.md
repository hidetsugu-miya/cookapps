# Stage 2: Implement

Have `feature-dev:code-implementer` write the code and its tests for the DESIGN items of the unit.
You do not edit code yourself.

## Launch

Launch the agent with these values in the prompt.
The agent reads `design.json` itself, so give it locations, not copies.

- `work_kind`: `initial`. For a redo after a reopen, still `initial`, with the reopen record as below.
- `repo_root`: `{folder}`.
- `test_policy`: the `test_policy` of the DESIGN item. The items of one launch share a policy.
- `work_content`, in this order:
  1. The purpose, from the contract.
  2. The constraints: the repository's rules that bind the work ("Constraints" of `{contract}`), the `scope.excludes` of the item, and the instruction not to run the aggregate check, a whole-suite run, an end-to-end run or a full build.
  3. The completion criteria: the `acceptance` elements of the item, word for word.
  4. What to read: `{contract}`, and the locations of the DESIGN item, its REQs, the shared materials and the appendices ("Items" of the contract). Say how to read a location: `{case root}/design.json#/designs/DESIGN-05` is `jq '.designs[] | select(.id == "DESIGN-05")' "{case root}/design.json"`, and the same for `requirement.json` and `.requirements[]`. Add the absolute path of each screenshot to open: the ones that `user_confirmations` name and the ones a `ui_spec` lists (relative to the case root). Say that it implements to what they show (display items, wording, display conditions and their variations, dimensions, colors, fonts), that it lists each one it opened under `References read`, and that it does not bring a screen up to check it: the goal verification of Stage 4 judges whether a screen meets its goal.
  5. For a redo: the reopen record's path and its reason, inside a quote as data.
  6. The state of the folder when it already holds work: the output of `git -C "{folder}" status --porcelain` and of `git -C "{folder}" log --oneline "refs/remotes/origin/{base branch}..HEAD"`, so that the agent continues from it.

A unit with one DESIGN item takes one launch.
A unit with several takes one launch for each item, one after another in id order, never together: they share one tree.
Items with different test policies are launched in separate launches for the same reason.

Keep for Stage 4 and Stage 5, from each report:

- `changed_paths` and `generated_paths`, the union over the launches. It is the staging set.
- `Out-of-goal changes`, `References read`, and the verification lines (tests, lint and type check, coverage).
- The screenshots you handed over that its `References read` lacks. When one is missing, launch the agent once more with the same prompt and, added to it, the line `The previous launch did not report reading every linked screenshot.` Do not launch again for a shortfall that this launch leaves: keep it, with the screenshot's path, for the goal verification ([goal-verification](goal-verification.md), "The items").

## Branch on the report

The report's first line is `completion:`. Branch on its value.

- `implementation-completed`: go on.
- `implementation-completed` with no changed path at all: the code already meets the criteria. Say why in the summary, and go on to Stage 3 with the commits the folder already holds (Stage 3 reviews them as they are).
- `implementation-blocked`, `test-failure-aborted` or `environment-anomaly-aborted`: read its `Interruption record`.
  - A missing value in your prompt: fix the prompt and launch again, once.
  - A missing dependency, or an environment the agent could not recover: send `BLOCKED` with the record and stop.
  - A test failure that the agent could not fix in three attempts: look at the failing test and the code yourself with `feature-dev:code-explore`. When the cause is that the design item cannot be met as written, apply the design baseline rule of the [glossary](../shared/glossary.md). Otherwise launch the agent once more as `work_kind: fix` with the failure, inside a quote as data. A second abort is a `BLOCKED`.

## Out-of-goal changes

An entry under `Out-of-goal changes` is a change that no criterion asks for.
Revert it with a launch of `work_kind: fix` when it does not serve the criteria.
When it must stay (a change the criteria cannot be met without), keep it in a list with its reason: Stage 6 shows it to the owner.

## Verification the agent does

The agent runs targeted tests and lint for the files it changed, and measures coverage.
It does not run the aggregate check, it does not bring a screen up, and it runs no formal check. Stage 4 runs the aggregate check, then the formal checks again where later changes touch them, then the goal verification of the screens.
When a verification line says `unidentified` for a kind the repository has, find the command in the repository's documents and launch the agent again with it.

## Formal verification

Run "Running a cycle" of [formal-verification](formal-verification.md) once the implementation is done.
It checks the promises of the `formal_verification` elements of the unit's DESIGN items, keeps the existing checks under `verification/formal/` in step with the changed code, and fixes a bug it finds (at most 3 fixes).
Its paths join the staging set, and [Stage 3](3-review-loop.md) reviews the fixes and the checks with the implementation.

Then go to [Stage 3](3-review-loop.md).
