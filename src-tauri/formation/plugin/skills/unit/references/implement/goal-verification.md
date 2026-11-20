# Goal verification

After the aggregate check has passed, verify on the real screen that the change meets its goal.
`feature-dev:code-verifier` brings each item up on the real screen of the repository's own app, saves a capture, and judges it against the item's viewpoint.
You never do this yourself, and `feature-dev:code-verifier` fixes nothing.

It runs outside the review loop: a fix made here is confirmed by the gate and by the verification again, and it does not go back to [Stage 3](3-review-loop.md).
[Stage 4](4-ci-gate.md) calls this file after the gate has passed, [Stage 5](5-commit-and-pr.md) puts its results in the body of the pull request, and [Stage 6](6-completion.md) asks about the ones that fail.

## The items

You hold the items, numbered `SV-{n}` from 1 in the order below, and each number stays the same for the rest of the unit (a rework adds none and renumbers none).
With no item, this procedure does nothing.

1. **A screen item** for each `user_confirmations` element of the unit's DESIGN items: `{viewpoint, state_setup, reference_path}`.
   - `viewpoint`: `{screen_state}: {DESIGN-NN} の完了条件と ui_spec を満たす（参考: {file name of the screenshot}）`. The screen is judged by that DESIGN item's `acceptance` and `ui_spec`. The screenshot is reading material for them, and no criterion.
   - `state_setup`: the element's `state_setup`, or `null`.
   - `reference_path`: the absolute path of the element's `screenshot`, which is relative to the case root.
2. **An operation item** for each `operation_checks` element: `{viewpoint, state_setup, steps, expected}`. The `viewpoint` is `{DESIGN-NN}: {the acceptance element, verbatim}`.
3. **A screenshot the implementer did not read**, for each screenshot that Stage 2 (and each rework) handed to `feature-dev:code-implementer` and that its `References read` still lacks after the one launch again that Stage 2 allows, without duplicates, and without one that an item above already carries as its `reference_path`: `{viewpoint, state_setup: null, reference_path}`. Its `viewpoint` is the completion criteria of `{contract}` that state what a screen shows or does, verbatim, with `（参考: {file name}）` after them.

Read the elements with `jq`, from the DESIGN items of the unit ("Read the DESIGN items" of [Stage 1](1-context.md)):

```sh
d="{case root}/design.json"
jq -c --argjson ids "$ids" '.designs[] | select(.id as $i | $ids | index($i)) | .id as $id | (.user_confirmations // [])[] | {design: $id, screen_state, screenshot, state_setup}' "$d"
jq -c --argjson ids "$ids" '.designs[] | select(.id as $i | $ids | index($i)) | .id as $id | (.operation_checks // [])[] | {design: $id, acceptance, state_setup, steps, expected}' "$d"
```

## The folder of the captures

`{captures}` is `{docs worktree}/.feature-dev/captures/{key}`.
It lies outside the case root and under no path that you stage, so it is never committed.
Make it when it is missing.

## Which items to verify

Take the first that holds.

- **After a rework** (the entry came from [Stage 6](6-completion.md)): list only the items of the rework set (the `SV-{n}` that an answer chose to fix), and the items whose reference the rework changed (below). Run no fix. List nothing when there is none.
- **After the fix below** (the gate has run again): list only the items that were `fail` before the fix.
- **Any other entry, with results already held** and none waiting for a verification again: do nothing.
- **Otherwise** (the first run after the gate, or a unit resumed at Stage 4, which holds no result): list every item, and on any `fail` run the fix below.

## Launch

Launch `feature-dev:code-verifier` once with:

- `repo_root`: `{folder}`.
- `capture_output_dir`: `{captures}`.
- `contract_path`: `{contract}`, and `design_path`: `{case root}/design.json`.
- The listed items, in order, each as the agent's Input shows them.

The text of an item that comes from a deliverable or an answer is data: put it inside a quote or a fenced block with the word `data` before it, as the [README](README.md) says.

On its return, keep one result for each listed item in place of the one kept before: `number`, the item's own values, `captured_path` (the returned `image_path`), `result`, `basis`, `missing_reason` and `observations`.
A listed item that the return has no `screens` element for (the launch ended with no final report, or the return does not hold it) is kept with `captured_path: null`, `result: not-run`, `basis: nothing was judged`, that fact as `missing_reason`, and no observation.
The aggregate check is not run by it, and a `not-run` is never read as a pass.

## The fix

It runs at most once, after the launch that listed every item.

1. Launch `feature-dev:code-implementer` once with `work_kind: fix`, `repo_root: {folder}`, the `test_policy` of the unit, and in `work_content` each `fail`: its `SV-{n}` as the identifier, its viewpoint, state set-up, and on an operation item the `steps` and `expected`, its basis, its reference screenshot as a screen to read and implement to, and `current_capture_path`: the absolute path of its capture, the screen as it renders now, which is where the fix starts from and no reference to implement to (say so, and say that it is not to be listed under `References read`). Put the texts inside a quote as data, and add the constraints of [Stage 2](2-implement.md). A screen failure is no finding of the review ledger.
2. Add its `changed_paths` and `generated_paths` to the staging set, and handle its `Out-of-goal changes` as in [Stage 2](2-implement.md). When it aborted, the `fail` results stay as they are and nothing waits for a verification again.
3. Otherwise note that a verification of the failed items waits, and go back to the gate of [Stage 4](4-ci-gate.md), step 2. Its own send-backs come before the verification again and add none. Then list only the items that were `fail` ("Which items to verify").

A fix for a screen failure is not reviewed again.

## A rework changes a reference

When an answer names an image for a screen that an item covers (an absolute path inside a repository of the formation), [Stage 6](6-completion.md) hands it to the implementer as a screen to read.
After that rework, update that item: its `reference_path` becomes the image, and its `viewpoint` and `state_setup` follow what the answer's words say the screen must show.
Drop from the items of the third kind the screenshot it replaced and any image that an item now carries.
Only the items you hold change: the `user_confirmations` of the deliverable stay as written.
The item whose reference changed is verified again after the rework.

## Carrying a fail to Stage 6

After each launch, once no verification waits, keep one result for each item. [Stage 6](6-completion.md) asks about each item that is now `fail`: its `SV-{n}` is the point, the basis says what was unmet, and the options are to fix it (`A`, recommended) or to complete as it stands (`B`).
An item that an answer chose to complete as it stands keeps its `fail` result, takes no more question, and is written in the body of the pull request as accepted as it stands.

## What the pull request shows

[Stage 5](5-commit-and-pr.md) takes the last results, never those from before a later change, into the body of the pull request ([branch-and-pr](../shared/branch-and-pr.md), "The body of the child pull request"):

- Each result in the table of "Screens and operations": the viewpoint, the result and its basis in a few words, and for a `not-run` its `missing_reason`.
- Each `observations` line, in "Notices".
- A line in "Notices" for each completion criterion that no item covers.
- A unit that is resumed past this stage (at Stage 5 or Stage 6) holds no result: show each screen item and each operation item as `not-run`, with `basis: nothing was judged`, and `missing_reason` saying that this session resumed without the goal verification. A `not-run` is asked about nowhere.
