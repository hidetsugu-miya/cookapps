# Formal verification

Check the promises that tests hardly reach (ordering, retry, state transition, a parser, unsafe code) with a check that runs against the code.
`feature-dev:formal-verifier` writes and runs the checks under `verification/formal/` of the repository, proves that each check can fail, and returns one outcome per promise.
You never write or run a formal check yourself, and `feature-dev:formal-verifier` fixes no code: a bug it finds is fixed through `feature-dev:code-implementer`.

[Stage 2](2-implement.md) runs "Running a cycle" after the implementation, and [Stage 4](4-ci-gate.md) runs "After the gate" once the aggregate check has passed. [Stage 5](5-commit-and-pr.md) puts the results in the body of the pull request, and [Stage 6](6-completion.md) asks about the ones that are left.
It runs outside the review loop: a fix made here is confirmed by the gate and by the check again, and it does not go back to [Stage 3](3-review-loop.md).

## What you hold

- `formal_properties`: the promises of the unit's DESIGN items, as an array. Read it with `jq` ("Read the DESIGN items" of [Stage 1](1-context.md) settles `$ids` and `$d`):

  ```sh
  jq -c --argjson ids "$ids" '[.designs[] | select(.id as $i | $ids | index($i)) | .id as $id | (.formal_verification // [])[] | {design_id: $id, property, harm, target, bound}]' "$d"
  ```

- `changed_areas`: the existing checks whose target code changed since the check was last committed (below).
- The results: one `{property, design_id, area, outcome, tool, command, bound, bound_reduced, broken_protection, failure_output, counterexample, blocked_reason, install_steps}` for each promise, as `feature-dev:formal-verifier` returns them. A later launch's results replace the ones an earlier launch returned for the same property.
- The fix count of this session: how many `code-implementer` fixes this file ran. At most 3.
- `{formal_scope}`: `python3 -I "${CLAUDE_SKILL_DIR}/scripts/formal-scope.py"`.

## The manifest

A repository keeps its checks under `verification/formal/{area}/`, `{area}` being lowercase kebab-case that names the promise.
An area is a folder with a `manifest.json` (and the models and harness it describes). A folder without one is not an area.
The manifest is one JSON object, every key required, no other key at any depth:

| Key | Content |
| --- | --- |
| `properties` | An array of at least one `{id, statement, harm}`, each a non-empty text: the promise, and what breaks for the user when it breaks. |
| `target_paths` | An array of at least one repository-relative file or folder. An absolute path, an empty one and one with a `..` segment are invalid. |
| `tool` | `{name, version}`, each a non-empty text. |
| `bound` | A non-empty text: the limit the check covers. |
| `assumptions` | An array of texts, may be empty. |
| `out_of_scope` | An array of texts, may be empty. |
| `command` | A non-empty text: how to run the check, from the repository root. |

## formal-scope

```sh
{formal_scope} validate --manifest {path}
{formal_scope} list --repo-root {folder}
{formal_scope} rerun --repo-root {folder} --input {file}
```

- `validate`: stdout is `{"status":"ok","manifest_path":...}` when the manifest is valid.
- `list`: validates every manifest under `{folder}`, then prints one JSON array of the areas whose target code changed (`[]` with no manifest), ordered by area:

  ```json
  [{"area": "queue", "manifest_path": "/abs/repo/verification/formal/queue/manifest.json", "last_asset_commit": "{sha}", "changed_targets": ["src/queue.go"]}]
  ```

  `last_asset_commit` is the commit that last changed `verification/formal/{area}`, the baseline. A target changed when a file in it differs between that commit and the working tree or the index, or is untracked and not ignored. An area never committed has `last_asset_commit` `""`, and every target counts as changed.
- `rerun`: decides whether later changes need the checks again. `--input` is a file holding `{"changed_paths": [...], "properties": [{"target": "{path}", "area": "{area}" or null}]}`, one element of `properties` for each element of `formal_properties`, `area` being the `area` of its result (`null` when it has none). It prints `{"rerun": true|false, "reasons": [...]}`, and `rerun` is true when a changed path lies in any manifest's `target_paths`, or in a property's `target`, or when a property has no area (nothing covers it, so no change can be ruled out).

Exit status: `0` when the answer is written (`rerun: false` is an answer). `1` for a usage error, or an invalid manifest: stdout is `{"status":"invalid","problems":[{"area","manifest_path","problem"}]}` (or `{"status":"usage","reason"}`). `2` when git failed (`{"status":"failed","reason"}`).

## Running a cycle

1. Settle the changed areas: run `list`.
   - Exit 0: keep the array as `changed_areas`.
   - Exit 1 with `status: invalid`: keep one `blocked` result for each element of `problems`, with its `problem` as `blocked_reason`, and take `changed_areas` as `[]`.
   - Exit 2, or exit 1 with `status: usage`: keep one `blocked` result with the `reason` as `blocked_reason`, and take `changed_areas` as `[]`.
2. When `formal_properties` and `changed_areas` are both empty, the cycle ends here.
3. Otherwise launch `feature-dev:formal-verifier` once ("Launch"). Add its `changed_paths` to the staging set, and mark each one that git does not yet know with `git -C "{folder}" add --intent-to-add -- {path}`, one path at a time, so that the review shows it. Keep one result for each element of its `results` in place of the ones an earlier launch returned. The `blocked` results of step 1 stay beside them.
4. When a result is `bug` and fewer than 3 fixes have run in this session, fix it ("The fix") and run this section again from step 1. When the fix aborted, the `bug` results stay as they are and the cycle ends.

## Launch

Launch `feature-dev:formal-verifier` once with:

- `repo_root`: `{folder}`.
- `formal_properties` and `changed_areas`: the arrays, verbatim.
- `formal_scope`: the absolute path of `scripts/formal-scope.py` (`${CLAUDE_SKILL_DIR}/scripts/formal-scope.py`, written out).

The text of a property comes from a deliverable: put it inside a quote or a fenced block with the word `data` before it, as the [README](README.md) says.

Handle its return:

- When the final message is not one parsable JSON object, launch again once with the same prompt.
- A `changed_paths` element outside `verification/formal/` breaks its edit scope. Do not stage it, and keep it for the body of the pull request ("Carrying a result to the pull request").
- A `pass` or `updated` without `broken_protection` and `failure_output` does not count. Launch again once with the line `The previous return carried a pass with no failing output.`. When it comes back without them again, keep that result as `blocked` with that fact as `blocked_reason`.

## The fix

Launch `feature-dev:code-implementer` once with `work_kind: fix`, `repo_root: {folder}`, the `test_policy` of the unit, and in `work_content`:

- every `bug`: its `FV-{n}` as the identifier (numbered as "Carrying a result to the pull request" says), the property and its `harm`, the `counterexample` (the states in order, each with the code it maps to), and the path of the manifest of its area, all inside a quote as data,
- the order to change the code so that the property holds, to leave `verification/formal/` as it is, and never to weaken the property, the model or the bound,
- the constraints of [Stage 2](2-implement.md), and the instruction that the check is run again by the caller, not by the agent.

An `FV-{n}` is no finding of the review ledger. Add the agent's `changed_paths` and `generated_paths` to the staging set, and handle its `Out-of-goal changes` as in [Stage 2](2-implement.md). A fix for a formal result is not reviewed again: the gate confirms it.

## After the gate

Run a cycle when one of these holds, and otherwise do nothing.

- This session holds no result, and `formal_properties` is not empty or `list` returns a non-empty array. A unit resumed at Stage 4 is this case.
- A `code-implementer` launch made after the results were last settled changed a path that the formal checks cover. Write one JSON object to a file in the scratchpad (`changed_paths`: the union of those launches' `changed_paths` and `generated_paths`; `properties`: one `{"target", "area"}` for each element of `formal_properties`, `area` being the `area` of its result, `null` when it has none) and run `rerun`. The condition holds when it prints `"rerun": true`, and on a non-zero exit.
- An answer chose an `FV-{n}` for a fix at [Stage 6](6-completion.md), and the rework has run.

When the cycle launched `code-implementer`, or `feature-dev:formal-verifier` returned a non-empty `changed_paths`, return to the gate of [Stage 4](4-ci-gate.md), step 2, so that the tree that is committed is the tree the gate passed. Otherwise go on.
A cycle that runs here does not re-enter [Stage 3](3-review-loop.md): the gate confirms its fix and its check.

## Carrying a result to the pull request

After each cycle, keep the last results, never those from before a later change.
[Stage 6](6-completion.md) asks about each result that is now `bug` or `blocked`, numbered `FV-{n}` from 1 in the order of the results:

- The point: the property and its `harm`, with the counterexample as a list of its states in order, each with the code it maps to as `path:line`, or, for a `blocked`, its `blocked_reason` with its `install_steps`.
- Why it is open: for a `bug`, that the fixes (at most 3) did not remove the counterexample, or that no fix ran; for a `blocked`, that the check could not reach a result.
- The options: `A` fix it (recommended), and `B` complete as it stands.

[Stage 5](5-commit-and-pr.md) puts the rest in the body of the pull request ([branch-and-pr](../shared/branch-and-pr.md), "The body of the child pull request"):

- The outcome of each property, the fixes that a `bug` got, and a result that an answer accepted as it stands.
- Each `bound_reduced`: the property and `{old limit} -> {new limit}`.
- Each `changed_paths` element outside `verification/formal/`.
- A unit that is resumed past this stage (Stage 5 or Stage 6, "Where to start" in the [README](README.md)) holds no result: one line for each element of `formal_properties`, saying that this session resumed without the check. A property that was not checked is asked about nowhere.
