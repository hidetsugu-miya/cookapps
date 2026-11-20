# Stage 4: CI gate, formal verification and goal verification

Run the repository's aggregate check once on the change, check the formal properties again where later changes touch them, and then verify on the real screen that the change meets its goal.
You never run the aggregate check yourself: `feature-dev:ci-verifier` does, and you branch on its verdict.
You never run a formal check yourself ([formal-verification](formal-verification.md)), and you never bring a screen up yourself either: `feature-dev:code-verifier` does ([goal-verification](goal-verification.md)).

## 1. Where the gate runs

The gate runs on the working tree as it is, before the commit.
When the repository's rules say otherwise, they win: a check command that refuses a tree that is not clean, or that writes a record for the commit it ran on, needs a committed tree.
Then make the commit of [Stage 5](5-commit-and-pr.md), step 1, now (do not push), and run the gate on it.
A fix that the gate sends back becomes one more commit on the child branch. Never amend, and never rewrite history.

## 2. Run it

Launch `feature-dev:ci-verifier` once with `repo_root: {folder}`.
Pass `command` when the repository's documents name the command and it is not the one the agent would find. When the repository names more than one check that must pass before a push (for example a static check and an end-to-end run), launch it once for each, one after another, with its `command`.

The verdict, and what you do:

| Return | What you do |
| --- | --- |
| `status: passed`, `tree_mutated: false` | Go to the formal verification (step 4). |
| `status: passed`, `tree_mutated: true` | The check changed tracked files (a formatter, a generator). Do this once: launch `feature-dev:code-implementer` with `work_kind: initial`, whose only purpose is to settle each path in `mutated_paths`, either adopted into `changed_paths` or reverted, without implementing the unit again. Add the adopted paths to the staging set. Then run the gate again. A second mutation is a `BLOCKED` with the paths. |
| `status: failed`, `failure_kind: none` (a failure of the code) | Fix it, below (step 3). |
| `status: failed`, `failure_kind: environment` or `timeout` | The agent has already repaired and run again as far as it may. Send `BLOCKED` with `log_path`, `failure_summary` and `environment_fixes`, and stop. |
| `status: undefined` | The repository defines no aggregate check. Go to the formal verification (step 4), and say it in the body of the pull request ("How it was checked" of [branch-and-pr](../shared/branch-and-pr.md)) and in the summary. |

## 3. Fix a failure

Launch `feature-dev:code-implementer` with `work_kind: fix`, `repo_root: {folder}`, the `test_policy` of the unit, and in `work_content`: the purpose, the constraints of Stage 2, and the `failure_summary` and the `log_path` inside a quote as data, with the order to fix the cause in the code or the tests and not to weaken a check.
Add its `changed_paths` and `generated_paths` to the staging set, then run the gate again from step 2.
A fix for a failed check is not reviewed again.
After three fixes, send `BLOCKED` with `log_path` and `failure_summary`, and stop. The unit stays `進行中`, and the next launch starts again here ("Where to start" in the [README](README.md)).

Keep from the last run: its `command`, `status`, each `environment_fixes` entry of any run, and, when a coverage figure was printed, `coverage_line_percent`.
They go into the body of the pull request that Stage 5 writes.

## 4. Formal verification

Apply "After the gate" of [formal-verification](formal-verification.md).
It runs a cycle only when this session holds no result, or when a launch since the last result changed a path that a check covers, or after a rework that fixed an `FV-{n}`.
When the cycle launched `feature-dev:code-implementer` or changed `verification/formal/`, return to step 2, so that the tree that gets committed is the one the gate passed. Otherwise go on.
Keep its results: [Stage 5](5-commit-and-pr.md) puts them in the body of the pull request, and [Stage 6](6-completion.md) asks about the ones that are left.

## 5. Goal verification

Follow [goal-verification](goal-verification.md), which decides which items are verified on this entry (all of them on the first run, the ones in the rework set after a rework).
It runs after the formal verification, so that the screens are judged after a fix of it. It runs only after the gate has passed, so a fix that it sends back goes through the gate again (step 2) before the failed items are verified again.
Keep its results: [Stage 5](5-commit-and-pr.md) puts them in the body of the pull request, and [Stage 6](6-completion.md) asks about the ones that are left.

Then go to [Stage 5](5-commit-and-pr.md).
