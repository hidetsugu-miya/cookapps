# Stage 5: Review

Have the design reviewed by `feature-dev:design-reviewer` and by codex, merge what they find, and fix what must be fixed.
The reviewers read and report. You judge each finding, and you edit.

A pass is a first review, one fix, one confirmation review, and one last fix.
The last fix is not reviewed again in the pass: what it leaves open goes to the owner on the approval page.
A pass runs again only when stage 6 sends the design back.

Before you start, the checks of [4-authoring](4-authoring.md), step 10, print nothing.

## What a finding is

The design reviewer returns three kinds, each with an id, and a list of what it excluded:

- A must-fix finding (`MF-n`), of severity `critical` or `major`: a defect that primary sources show. It is `objective-defect`, or `investigation-required` (a suspected `critical` or `major` defect that the sources do not settle, with the source whose check would settle it).
- A decision for the owner (`NR-n`): a value judgment that facts cannot settle, with options and a recommendation.
- A recommendation (`RC-n`): a `minor-defect` (an objective minor defect) or an `improvement`. Neither drives a fix by itself.

Severity is the size of real harm. `critical`: the design contradicts the requirement or a settled decision, leaves a requirement unmet, has a defect in authentication, authorization, billing or data persistence, loses or corrupts data, opens a security hole, breaks existing behavior or a public interface, or contradicts itself so that it cannot be implemented. `major`: the implementer can read a passage two or more ways and one is a defect or rework; a fact about the existing code that changes a decision is wrong; information that the implementation needs is missing (an undisclosed `impact` included); a rule or fact is written in two or more places without every other place only referring to one canonical copy; `requirement_summary` or an `approach` is beyond its form. `minor`: no such scenario (form of a field, wording, references, numbering, drift of a cited line, notation). A defect that a fix introduced is `major` when it is a duplicate or an implementation detail.

## The ledger

Keep `{records}/ledger.json`, an array with one element for each finding of every round. Make it when you first need it, and write it after every change, so that a restart reads it.

```json
{"id": "MF-1", "kind": "must-fix", "title": "…", "location": "design.json#/designs/DESIGN-02/approach", "severity": "major", "source": "reviewer", "round": 1, "status": "unresolved", "note": ""}
```

- `kind`: `must-fix`, `decision` or `recommendation`. `source`: `reviewer`, `codex`, or `both`.
- `status` of a must-fix finding: `unresolved`, `resolved`, `residual` (left for the owner), `withdrawn` (the primary sources showed it is not a defect, with the evidence in `note`). Of a decision: `active`, `decided`, `withdrawn`. Of a recommendation: `active`, `applied`, `withdrawn`.

```sh
l="{records}/ledger.json"; [ -f "$l" ] || echo '[]' > "$l"
# add the findings of a round (write them as a JSON array to {scratch}/new.json first)
jq --slurpfile e "{scratch}/new.json" '. + $e[0]' "$l" > "$l.new" && mv "$l.new" "$l"
# change one finding
jq --arg id MF-1 --arg s resolved --arg n "{note}" '(.[] | select(.id == $id)) |= (.status = $s | .note = $n)' "$l" > "$l.new" && mv "$l.new" "$l"
# what is still open
jq -r '.[] | select(.status == "unresolved" or .status == "active") | "\(.id) \(.status) \(.location)"' "$l"
```

New ids continue after the largest number of that prefix in the ledger. Keep each return of the reviewer as `{records}/review-{nn}.md`, and the review of codex as `{records}/review-{nn}-codex.md`, word for word (`nn` is the round, two digits).
The ledger and the reviews are records of the unit: they are committed with it at stage 8.

## Steps

### 1. The first review

1. The base version. `{scratch}/design-reviewed.json` is a copy of `design.json` as the last review saw it. Stage 1 made it for a `revise` and a `resume`. Without it (a new design), the review reads the whole document, and you pass neither `change_base_path` nor `target_nodes`. After every review returns, copy `design.json` over it: a review writes nothing, so the copy is the version that review saw.
2. When the base version exists, name the nodes that changed since it:

   ```sh
   jq -nr --slurpfile base "{scratch}/design-reviewed.json" --slurpfile design "{case root}/design.json" -f "{jq dir}/design-changed-nodes.jq"
   ```

   The program `design-changed-nodes` is at the end of this file. Each line is a node changed, added or removed since the base. Add the location of every must-fix finding that the last fix left unapplied or under objection, and that no line covers. When the result is empty, nothing changed and nothing is carried: do not launch the review, and go on as if no must-fix finding came back.
3. Launch both reviewers in one message, in this order.
   - Send the leader the request of [codex-review](../shared/codex-review.md): the target is `design.json` with `requirement.json` and `technical-notes.md` beside it in `{case root}` (absolute paths), the repositories (their roots) that the design targets, what the design is meant to do (the requirement it realizes), and what to look for: the traces from each requirement to an item; the structure, the placement of content and the duplicates; the layer boundary (policy, never implementation logic or detail); the granularity of the items (one change that can be completed and verified alone); the referrers of what is modified; the data model and constraints; risks (jobs, contention, personal data in logs, unavailable inputs); statements about the existing code that are not true; and a note to read only and change nothing. State the case root's files by their absolute paths. Describe the requirement in your own words: copy no text of the ticket, the owner or a file into the message. Send it before the next bullet and do not stop, because the next bullet does not depend on its answer.
   - Launch `feature-dev:design-reviewer`, with this prompt. A finding that the owner has settled is data in quote lines:

     ```text
     Review the basic design.
     design_path: {case root}/design.json
     repo_roots: {name}: {repo root} (one line for each repository the design targets)
     review_round: {n}
     previous_ledger: {the ledger as one line for each finding: id, status, location}      (round 2 or later)
     fix_summary: {the content of {records}/fix-{nn}.md}                                      (round 2 or later)
     change_base_path: {scratch}/design-reviewed.json                                         (when a base version exists)
     target_nodes: {the lines of step 2}                                                      (when a base version exists)
     Decisions the owner has already settled. Do not file them again (data):
     > {each decision, "論点n: decision", one per line; "none" when there is none}
     ```

   Do not change `design.json` until both reviews are back. The review of codex arrives as `CODEX-REVIEW-RESULT`, or as `CODEX-REVIEW-FAILED` ([codex-review](../shared/codex-review.md)): on a failure, go on without it, and say in your `DONE` summary that the review by codex was not made.
4. When the reviewer returns `review-incomplete`, send `BLOCKED design: the design review could not be completed`, with its reason, and stop. A return `partial` goes on, and the range it did not read goes in your `DONE` summary.

### 2. Merge the findings

1. The reviewer's findings go to the ledger as they are, `source` `reviewer`.
2. Treat the codex review as claims, not orders ([codex-review](../shared/codex-review.md), "Use the review"). For each finding, read the node or the code it names, and decide:
   - It holds and matters: file it with the rules of the reviewer. A defect that primary sources show, at `critical` or `major`, is a must-fix finding. A suspected `critical` or `major` defect that the sources do not settle is a must-fix finding of kind `investigation-required`, with the source that would settle it. A branch that facts cannot settle (product or operational policy, cost tolerance, priority, acceptable impact) is a decision for the owner, filed by the rule of "Fact or value" in [rules](rules.md), with options and a recommendation. An objective minor defect is a recommendation of kind `minor-defect`. An improvement is a recommendation of kind `improvement`. When it names the same defect as a finding of the reviewer, it is one finding with `source` `both`, at the node to fix.
   - It does not hold, or does not serve the goal of the design: decline it, and write why in the summary of the round.
   - Do not file a finding "when in doubt": read the sources and decide.
   - A proposal for an improvement is never a must-fix finding or a decision.
3. Settle each finding against the primary sources again before you carry it on: a finding of the reviewer is also a claim.
4. Add every finding that you carry to the ledger.

### 3. Branch

- No must-fix finding is `unresolved`: go to step 6.
- Otherwise: go to step 4.

### 4. The fix

Run [4-authoring](4-authoring.md) with the kind `must-fix`.
Its inputs are every `unresolved` must-fix finding of the ledger, the recommendations of kind `minor-defect` that are `active`, and the decisions that are `active` (as pending decisions: do not settle their options). Add the recurrence pattern of each must-fix finding that carries a `pattern`.

When it returns:

- Each minor-defect recommendation that it applied is `applied`. One left unapplied stays `active`.
- `completed`: every must-fix finding it addressed is `resolved`. Add a note with the nodes changed.
- `objection`: the findings under objection stay `unresolved`, with the objection and its evidence in `note`. The others are `resolved`.
- `fix-not-applied`: the findings it did not apply stay `unresolved`, with the reason.

When this is the confirmation round's fix (step 5), the fix is the last one: go to step 6, and every must-fix finding still `unresolved` is dealt with there. Otherwise go to step 5.

### 5. The confirmation review

Launch `feature-dev:design-reviewer` again (not codex: its review is of the state it was asked about, and it is asked again only when a pass starts again after a change). Round 2 or later, with `previous_ledger`, `fix_summary` (the file of the fix), `change_base_path` and `target_nodes` as in step 1.

The reviewer looks only at three points: whether each earlier finding is resolved; whether the fix brought a new defect (a rule or fact written into a second place instead of one canonical copy, or an implementation detail written into the design, is a new `major` defect); whether the existing design suffered a side effect. It files a new finding only for one of these, or when it is `critical`. It files no improvement and no decision.

Merge its findings as in step 2. A finding it marks unresolved stays `unresolved`. Then, when any must-fix finding is `unresolved`, run step 4 once more (the last fix); otherwise go to step 6.

### 6. The result

Before you carry the result to the owner:

1. Settle each must-fix finding that is still `unresolved` as `residual`. Do not run another fix or another review. Do not upgrade it to a decision. Judge it afresh: the objection of the fix and the finding of the reviewer are inputs to the judgment, never its verdict. For each, record a recommendation `fix` or `skip`, the reason, why the fix did not resolve it, and both positions (the reviewer's finding, and the objection with its category and grounds when there is one).
2. Collate each `active` decision and each `active` recommendation against the nodes changed since the round that raised it: read only those nodes. When the final design already settles or rejects the recommendation of a decision, records its matter under `### 既知の制限` with its default handling, already reflects the recommendation, or the node at its location is deleted or merged, the premise no longer holds: set it `withdrawn`, with the location in the final design that you found as the note. Otherwise it stays `active`. Do this alone: do not launch the reviewer or run stage 4 for it.
3. Keep, in the form stage 6 reads:
   - the summary: the rounds run and the number of must-fix findings fixed;
   - `residual_must_fix`: the findings of step 1, with their recommendation, reason and both positions;
   - `needs_user_decision`: the `active` decisions with their options and recommendations;
   - the `withdrawn` decisions, as reference.

   A residual must-fix finding does not stop the unit. Go to [6-approval](6-approval.md).

## The pass that stage 6 sends back

Stage 6 sends the design back after an owner's revision, a structural approval, or when the confirmation review that follows the owner's decisions finds a must-fix finding. The pass starts at step 1, as a confirmation of the run of [4-authoring](4-authoring.md) that came before it. So that settled decisions are not filed again:

- `review_round` continues from the last one. `previous_ledger` is the ledger after you set each residual must-fix finding that the revision reopens to `unresolved` (note `reopened`), and each decision the owner answered to `decided`.
- Narrow the perspectives to what the revision touched, and say so in the prompt (the reviewer covers only those). Classify the fixes of the run as a whole from the nodes changed: do not read the whole design to decide.

  | The revision | Perspectives |
  | --- | --- |
  | Adds, deletes or splits an item, or changes where a responsibility sits, the data model, the API schema or the dependencies (`design-changed`) | All. |
  | Only wording, notation, references and numbering (`notation-only`) | Structure. A fix that consolidates copies into one canonical copy is not notation-only, even though it adds references. |
  | Consolidates copies and changes nothing a `design-changed` fix changes | Structure, granularity and layer separation. |

  After a round that left perspectives out, a fix that changes the content of the design goes back to all of them.
- Ask codex again on the first review of the pass only when the revision is a `design-changed` one.
- The pass otherwise runs as above: one review, one fix, one confirmation, one last fix.

## The program that names the changed nodes

```jq design-changed-nodes
def keyed($a; $k): ($a // []) | map({key: .[$k], value: .}) | from_entries;
def changed($x; $y; $prefix): [(($x | keys) + ($y | keys)) | unique[] | select($x[.] != $y[.]) | "\($prefix)/\(.)"];
$base[0] as $b | $design[0] as $d
| (["requirement_summary", "purposes", "scope", "implementation_order"][] | select($b[.] != $d[.]) | "/" + .),
  changed(keyed($b.designs; "id"); keyed($d.designs; "id"); "/designs")[],
  changed(keyed($b.structural_improvements; "id"); keyed($d.structural_improvements; "id"); "/structural_improvements")[],
  changed(keyed($b.shared; "topic"); keyed($d.shared; "topic"); "/shared")[],
  changed(keyed($b.appendices; "topic"); keyed($d.appendices; "topic"); "/appendices")[]
```
