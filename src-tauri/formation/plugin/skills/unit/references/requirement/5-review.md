# Stage 5: review

Have the deliverable reviewed, and fix what the review finds, before the owner sees it.
Only must-fix findings drive this stage.

The reviewer is the `feature-dev:requirement-reviewer` agent. It reads the deliverable, edits nothing, and returns findings numbered `MF-n` (must fix), `NR-n` (needs the owner's decision) and `RC-n` (recommendation).
Treat what it returns as claims to check against the deliverable and the sources, not as orders.

## How many reviews run

- One review for each pass: the first review, or in its place the confirmation review after a revision (step 3).
- The fix of step 2 is the last of its pass. It is not reviewed again here. The pass ends when its review finds no must-fix, or when the fix has been made.

## What you keep

- The review rounds that ran (a count), and the findings with a status each:
  - `MF-n`: `open`, `resolved`, or `residual` (not resolved by the last fix).
  - `NR-n`: `open`, `decided` (the owner decided it), or `withdrawn` (its premise no longer holds).
  - `RC-n`: `open`, `applied`, or `withdrawn`.
- The raw report of every round. Write each one, word for word, to `{case root}/records/requirement/review-{nn}.md` (`nn` two digits, one more than the last), as soon as it returns. These records are committed with the unit.
- The base version: a copy of `requirement.json` as the last review saw it, at `{scratch}/base.json`. Take it right after each review returns, whatever its result: `cp "{case root}/requirement.json" "{scratch}/base.json"`. A reopen already took one in stage 1.
- Ids are the reviewer's. You never number a finding. A finding that is the same one as before keeps its id.

## Step 1: the first review

1. Settle the range. When there is no base version, the reviewer reads all of `requirement.json` and `technical-notes.md`: give it neither `change_base_path` nor `target_nodes`.
   When there is one (a reopened requirement), pass `change_base_path` as `{scratch}/base.json`, and `target_nodes` as:

   - the nodes that changed since the base version:

     ```sh
     jq -nr --slurpfile a "{scratch}/base.json" --slurpfile b "{case root}/requirement.json" '
       def keyed($d; $k; $key): [($d[$k] // [])[] | {key: .[$key], value: .}] | from_entries;
       def changed($k; $key):
         keyed($a[0]; $k; $key) as $x | keyed($b[0]; $k; $key) as $y
         | ((($x | keys) + ($y | keys)) | unique[]) as $n
         | if ($x | has($n)) and ($y | has($n)) then (if $x[$n] != $y[$n] then "/\($k)/\($n)" else empty end)
           elif ($y | has($n)) then "/\($k)/\($n)"
           else "/\($k)" end;
       [ (["background","problem","purpose","scope","screens","screen_flow"][] as $k | select($a[0][$k] != $b[0][$k]) | "/\($k)"),
         changed("requirements"; "id"), changed("shared"; "topic"), changed("appendices"; "topic") ] | unique[]'
     ```

     An element that was removed is listed as its array (`/requirements`), the place a missing item would be filed.
   - `technical-notes.md`, when this run of stage 2 wrote it (or the fix of step 2 did, for a later review).

   When the range is empty (nothing changed since the base version), launch no review and go to step 4 as for a result with no must-fix.
2. Launch `feature-dev:requirement-reviewer` with:
   - `requirement_path`: the absolute path of `requirement.json`,
   - `original_request`: `{scratch}/request.md`,
   - `repo_roots`: the repositories the requirement concerns,
   - `review_round`: 1,
   - `change_base_path` and `target_nodes` when step 1 set them.
3. Save the raw report as the review record, and take the new base version.
4. Settle the result. A report with `status: review-incomplete` ends the pass: send `BLOCKED requirement: the review could not run: {its reason}` and stop. A report with `status: partial` is run once more over the range it says it did not read, and its findings are merged. When that run is also partial, send the same `BLOCKED` with what stayed unread.
5. Ask codex for a second review, in this first pass only, as [codex-review](../shared/codex-review.md) says. The target is `requirement.json` and `technical-notes.md` of the case root, the request (`{scratch}/request.md`), and the look-for list: a request that is not reflected, a requirement that nobody asked for, a contradiction between requirements, a vague statement, a fact about the code that the code does not hold. Use its findings as that file says: check each against the deliverable and the sources. A finding that holds and meets the severity of the reviewer's report becomes a `MF-n`, one that holds with less severity an `RC-n`, and one that needs the owner's business judgment an `NR-n`, each numbered after the reviewer's largest number of that kind. When no review comes, go on and say so in your summary.
6. Update the findings you keep from the report (and codex). Then branch on the count of `MF-n`:
   - none: go to step 4.
   - one or more: go to step 2.

## Step 2: the fix

Make the fix once for the findings you have. It is the last fix of this pass.

1. Split the must-fix findings by where their `location` is:
   - in `technical-notes.md`: fix them as the section "Fix the notes" below says,
   - in `requirement.json`: fix them with [stage 4](4-writing.md), in `modify` mode. Give it these findings, the minor-defect recommendations located in `requirement.json`, and the open `NR-n` items as the questions that wait for the owner, so that it does not settle their options.

   Run each side that has at least one finding, one after the other. Split the `RC-n` of the kind minor-defect the same way, and give a side its share only when that side runs for at least one must-fix. A share whose side does not run stays `open`.
2. When a run ends, update the statuses:
   - every must-fix it was given and applied (or closed as not a defect): `resolved`,
   - an objection, or a must-fix that could not be applied: `residual`, with the reason, and, for an objection, the objection itself (stage 4, "An objection"),
   - every minor-defect it applied: `applied`. One it did not apply stays `open`, and does not by itself make a finding `residual`.
3. Keep the fix summary of stage 4 for the next review.
4. When stage 4 ended with open questions, it went through [stage 3](3-open-questions.md) already: handle the result it gives, then go on.
5. Go to step 4.

### Fix the notes

For each must-fix and each minor-defect recommendation whose `location` is `technical-notes.md`:

1. Read the section the `location` names and the sources the finding and that section cite. Settle the correct fact with `Read` or a narrow `rg`. For a finding of the kind investigation-required, confirm what its text says to confirm.
2. Then, by the result:
   - the defect is confirmed: rewrite the entry in the form of its section ([notes-template](notes-template.md)), and bind the corrected conclusion to a `{path}:{line range}` you confirmed in step 1.
   - not a defect (only for investigation-required): leave the section as it is, and keep the source you checked as the grounds. This closes the finding.
   - the sources cannot settle the correct fact, or contradict the finding: leave the section as it is, and keep the finding id and the reason. A must-fix of this kind is `residual`. A minor-defect of this kind stays `open` with a one-line reason.
3. For each section you rewrote, search the other sections of the notes (`rg`) and `requirement.json` (the `jq` search of [deliverable-writing](../shared/deliverable-writing.md)) for passages that rest on the fact you corrected. Fix those in the notes. For `requirement.json`, give them to [stage 4](4-writing.md) as findings to fix in the same run. Note every location you looked at, changed or not.
4. Record `code-facts-base.json` ([norms](norms.md), "Reusing confirmed facts") for the writes you made.

## Step 3: the confirmation review

This step runs when [stage 6](6-approval.md) sent a revision back through stage 4. It replaces step 1.
The writing run that reflected the owner's response is the driving run for the range below.

1. Before it, update the statuses that the owner's response produced: each `NR-n` that the response decided is `decided`.
2. Settle the range as in step 1: the nodes changed since the base version, plus `technical-notes.md` when it was written since. Include the fixes of the last step 2, since that fix was not reviewed in its own pass. When the range is empty, launch no review and take the branch "no must-fix" below.
3. Launch `feature-dev:requirement-reviewer` with the same arguments as step 1, and also:
   - `review_round`: the number after the last round that ran,
   - `previous_ledger`: your findings with their ids, locations and statuses,
   - `fix_summary`: the fix summary of the writing run that reflected the response, and of the fix of the last step 2,
   - `change_base_path` and `target_nodes` as settled.
   Ask for no codex review in this step.
4. Save the raw report, take the new base version, and update your findings. Handle `review-incomplete` and `partial` as in step 1.
5. Branch on the count of new or unresolved `MF-n`:
   - none: if stage 6 sent you here from its route "approval with decisions", return to stage 6 without step 4, and complete from there. Otherwise go to step 4.
   - one or more: go to step 2. Step 4 then hands over to stage 6 as usual.

## Step 4: collate and hand over to the approval

1. Check each `open` `NR-n` and `RC-n` against the final deliverables: does the state its `location` and `current` describe still hold (for an `NR-n`, also its options and recommendation)? Read only the node its location names. Cover every one, whether or not the fix ran.
   When the final deliverables already settle or reject the recommendation or an option of an `NR-n`, already reflect an `RC-n`, or the passage at its location was deleted or merged, its premise no longer holds: its status is `withdrawn`, with the location of the passage you found. Otherwise nothing changes.
   Do this yourself. Do not launch the reviewer for it.
2. Keep for [stage 6](6-approval.md):
   - the counts: the rounds that ran, and the number of must-fix findings that are `resolved`,
   - the `residual` must-fix findings, each with its id, title, location, the finding (`current` and `evidence` from the report), the reason it was not resolved, your `recommendation` (`fix` or `skip`) with its reason, and the objection when you raised one,
   - the `open` `NR-n` items, each with its location, `current`, options and recommendation. They are the decisions that wait for the owner.
   A `withdrawn` item is not shown to the owner.
3. Go to [stage 6](6-approval.md).

Do not Read the whole deliverable to decide the range of a review or to decide that "nothing changed materially". The jq of step 1 decides it.
