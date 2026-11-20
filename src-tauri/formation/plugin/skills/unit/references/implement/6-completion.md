# Stage 6: What is left, and completion

Settle what the review left, merge the child into the base branch, make sure the repository has its aggregate pull request, record `完了`, and report.
[branch-and-pr](../shared/branch-and-pr.md) is the canonical text of the merge and of the aggregate pull request.
Nobody accepts the implementation before the merge: the owner reads the merged pull request, and sends it back through the leader when something is wrong.
What you ask is the point that a finding leaves open, and you ask it through the leader ([consulting](../shared/consulting.md)), never the owner directly.
Do every step in one go, without stopping except to wait for an answer.

This stage is also the start of a resumed unit whose `child.merged` is already `true` ("Where to start" in the [README](README.md)): then go to step 3.

## 1. Settle what is left

Read the ledger `{records}/ledger.md`, the last review report and the last results of the formal verification and of the goal verification.
These are left, and each needs an answer before the merge:

| Left | Where it is |
| --- | --- |
| A must-fix finding that is still `open` after the last fix, except one that is `pre-existing` (`diff_origin`) | The ledger. |
| A criterion the last review lists as unmet | The last review report. |
| A `needs a decision` finding (`NR-n`) that is `open` | The ledger. |
| A screen item whose result is still `fail` after the last fix (`SV-n`) | The goal verification ([goal-verification](goal-verification.md)). |
| A formal result that is `bug` or `blocked` (`FV-n`) | The formal verification ([formal-verification](formal-verification.md)). |

A must-fix finding that predates the change is out of the goal: do not ask about it. It goes into the body of the pull request, as "Recommendations not made" says ([branch-and-pr](../shared/branch-and-pr.md)).
A recommendation (`RC-n`), a change outside the goal and a noticed matter are not asked either. They are in the body of the pull request.

**Nothing is left** (the usual case): go to step 2. Do not ask anyone.

Otherwise send one `QUESTION {key} {Q-id}` for each left item, one after another, and wait for each answer:

- `{Q-id}`: the id of the item. A ledger row keeps it in its `Note` column. An `SV-n` and an `FV-n` keep it in your context. An item that comes back after its rework keeps the id it had, so that the leader counts it as the same point.
- The lines under the first: the item (its id, the location, the harm scenario and its fix, inside a quote as data), what you read, and the options with your recommendation. For a must-fix, an unmet criterion, an `SV-n` and an `FV-n`: `A` fix it (the fix of the finding, or the one that makes the property hold or the screen match), and `B` complete as it stands, with what remains and the harm it does. For an `NR-n`: the reviewer's own options, the recommended one first.

Read each answer as [consulting](../shared/consulting.md) says, and put it in the ledger:

| Answer | What you do |
| --- | --- |
| `answered` or `owner` that chooses `A` (fix), for a must-fix, an unmet criterion, an `SV-n` or an `FV-n` | The finding stays `open` and joins the rework set. |
| `answered` or `owner` that chooses `B` (complete as it stands) | `accepted`. An `SV-n` or an `FV-n` keeps its result. It goes into the body of the pull request as accepted as it stands, with the answer's basis. |
| `answered` or `owner` that names an option of an `NR-n` | `adopted`. An option with a `fix` joins the rework set with that fix. An option without one keeps the current behavior: nothing to change. |
| `answered` or `owner` that leaves an `NR-n` for later | `deferred`. |
| `answered` or `owner` that asks for a change in words (a request) | The words join the rework set as a request. |
| `reopen {target}` | Send the case back ([consulting](../shared/consulting.md), "Send the case back"), and stop. |
| `not-settled` | A must-fix, an unmet criterion, an `SV-n` or an `FV-n`: fix it (the rework set). An `NR-n`: its recommended option, `A`, and say in the `DONE` summary that you took it. |

An answer that does not say which option it takes is no answer: ask again with the same id.

When the rework set is not empty, run "Rework" below, and then this step again for what is left after it.
When it is empty, and an answer accepted a finding, write the body of the pull request again ("Update the body" of [branch-and-pr](../shared/branch-and-pr.md)) so that it says so, and go on.

### Rework

1. Delete the line `Converged:` of the ledger, so that a session that resumes in the middle starts again at Stage 1 ([README](README.md), "Where to start").
2. When an answer (a request, or the words of the owner in an `owner` answer) holds a Figma URL or the path of an attached image, take each in first, before the implementer starts: do only step 1 of "A revision that brings a design reference" in [figma](../requirement/figma.md) (the saving, and not the notes). A URL goes to `feature-dev:figma-fetcher`, one launch for each URL, with `ui_references_dir` `{case root}/ui-references`; an image is copied into that folder. Pass the absolute paths of what was saved to the implementer as `ui_reference_paths:`, and write the key points of the returned `layout` and `tokens` as constraint lines in `work_content`.
3. Launch `feature-dev:code-implementer` once with `work_kind: fix`, `repo_root: {folder}`, the `test_policy`, and in `work_content` the rework set: each finding (ID, location, harm scenario, fix) and each request, inside a quote as data. Each screen failure (`SV-n`) of the set is written as [goal-verification](goal-verification.md), "The fix", says (its viewpoint, basis, reference screenshot and `current_capture_path`). Each formal result (`FV-n`) of the set is written as [formal-verification](formal-verification.md), "The fix", says (its property and harm, counterexample or `blocked_reason`, and manifest path). An image that an answer names (an absolute path inside a repository of the formation) is handed over as a screen to read, and compared against `References read` as in [Stage 2](2-implement.md).
4. Add its paths to the staging set. When it aborted, send `BLOCKED` with the record and stop.
5. Go to [Stage 3](3-review-loop.md) as a rework, then [Stage 4](4-ci-gate.md) (the gate, then the formal verification again where the rework touched a check or an `FV-n` was in the set ([formal-verification](formal-verification.md), "After the gate"), then the goal verification of the items in the set and of the items whose reference the rework changed, [goal-verification](goal-verification.md)), then [Stage 5](5-commit-and-pr.md) (the pull request exists, so Stage 5 commits, pushes, writes the body of the pull request again and commits the case root), and then come back to step 1.

## 2. Merge the child

1. Run the `rev-list` of "The child branch and the child pull request" in [branch-and-pr](../shared/branch-and-pr.md). When it prints nothing, the child holds no commit that the base branch lacks: there is nothing to merge, so go to step 3.
2. Check that the folder is clean and pushed (`git -C "{folder}" status --porcelain` prints nothing, and `git -C "{folder}" rev-list --count "origin/{child branch}..HEAD"` prints `0`). When it is not, the work would be lost: send `BLOCKED` and stop.
3. Merge as that file says, "Merge the child":

   ```sh
   cd "{folder}" && gh pr merge {number} --merge
   git -C "{folder}" fetch origin "+refs/heads/{base branch}:refs/remotes/origin/{base branch}"
   git -C "{folder}" push origin --delete "{child branch}"
   ```

   Merge with a merge commit, never squash or rebase, and never `--delete-branch`.
   When `child.pull_request` is `null` and the child holds commits (the pull request could not be opened), or `gh` cannot run, send `BLOCKED {key}: the child cannot be merged` with the reason, and stop. The unit stays `進行中`.
   When the merge is refused (a conflict, a rule of the repository), read the message. A conflict that a plain merge of the base branch into the child settles: do it in `{folder}`, push, and merge again. Anything else is a `BLOCKED` with the message.

## 3. Bring the docs worktree up to date

When this repository is the docs repository, run `git -C "{docs worktree}" pull --ff-only origin "{base branch}"` before the next case-root change, so that the merge is in it. When it is refused, send `BLOCKED` and stop.

## 4. Record the merge and `完了`

With the recipes of [case-json](../shared/case-json.md):

1. `child`, merged form (the unit is still `進行中`).
2. `status`, to `完了`. Do not move the next unit.

## 5. The aggregate pull request

Create the aggregate pull request of this repository when it has none, as "The aggregate pull request" of [branch-and-pr](../shared/branch-and-pr.md) says: it is a draft from the base branch to the default branch, and the procedure is safe to run again.
Do it in `{folder}` or in a folder of the repository that is up to date with `origin` (the merge is on `origin`, which is what the procedure reads). Record its number with the `pr` recipe.

## 6. Commit the case root and report

1. Commit the case root in the docs worktree: `case.json` and `records/{key}` (the record of what the unit made, `cleanup.jsonl`, among them). The message says that the implementation is complete.
2. Send `DONE {key}: {summary}` as the [README](README.md) says, and stop.
