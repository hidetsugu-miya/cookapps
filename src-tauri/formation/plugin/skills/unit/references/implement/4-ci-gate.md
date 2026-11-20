# Stage 4: CI gate

Record that the implementation waits for the owner's acceptance, and run the repository's aggregate check once on the change.
You never run the aggregate check yourself: `feature-dev:ci-verifier` does, and you branch on its verdict.

## 1. Record the wait for acceptance

Set the unit to `受入待ち` with the `status` recipe of [case-json](../shared/case-json.md).
It stays `受入待ち` through the gate, the pull request and the owner's reply, even when the gate sends you back to the code.

## 2. Where the gate runs

The gate runs on the working tree as it is, before the commit.
When the repository's rules say otherwise, they win: a check command that refuses a tree that is not clean, or that writes a record for the commit it ran on, needs a committed tree.
Then make the commit of [Stage 5](5-commit-and-pr.md), step 1, now (do not push), and run the gate on it.
A fix that the gate sends back becomes one more commit on the child branch. Never amend, and never rewrite history.

## 3. Run it

Launch `feature-dev:ci-verifier` once with `repo_root: {folder}`.
Pass `command` when the repository's documents name the command and it is not the one the agent would find. When the repository names more than one check that must pass before a push (for example a static check and an end-to-end run), launch it once for each, one after another, with its `command`.

The verdict, and what you do:

| Return | What you do |
| --- | --- |
| `status: passed`, `tree_mutated: false` | Go to [Stage 5](5-commit-and-pr.md). |
| `status: passed`, `tree_mutated: true` | The check changed tracked files (a formatter, a generator). Do this once: launch `feature-dev:code-implementer` with `work_kind: initial`, whose only purpose is to settle each path in `mutated_paths`, either adopted into `changed_paths` or reverted, without implementing the unit again. Add the adopted paths to the staging set. Then run the gate again. A second mutation is a `BLOCKED` with the paths. |
| `status: failed`, `failure_kind: none` (a failure of the code) | Fix it, below. |
| `status: failed`, `failure_kind: environment` or `timeout` | The agent has already repaired and run again as far as it may. Send `BLOCKED` with `log_path`, `failure_summary` and `environment_fixes`, and stop. |
| `status: undefined` | The repository defines no aggregate check. Go on, and say it as a line of `notices` of the page ([decision-page](../shared/decision-page.md), "The state of the checks"; Stage 6) and in the summary. |

## 4. Fix a failure

Launch `feature-dev:code-implementer` with `work_kind: fix`, `repo_root: {folder}`, the `test_policy` of the unit, and in `work_content`: the purpose, the constraints of Stage 2, and the `failure_summary` and the `log_path` inside a quote as data, with the order to fix the cause in the code or the tests and not to weaken a check.
Add its `changed_paths` and `generated_paths` to the staging set, then run the gate again from step 3.
A fix for a failed check is not reviewed again.
After three fixes, send `BLOCKED` with `log_path` and `failure_summary`, and stop. The unit stays `受入待ち`, and the next launch starts again here ("Where to start" in the [README](README.md)).

Keep from the last run: its `command`, `status`, each `environment_fixes` entry of any run, and, when a coverage figure was printed, `coverage_line_percent`.
They go to the page, as the lines of `notices` that Stage 6 writes.

Then go to [Stage 5](5-commit-and-pr.md).
