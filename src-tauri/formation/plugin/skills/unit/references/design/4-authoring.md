# Stage 4: Authoring

Write `design.json` from the requirement and the investigation, and keep it valid.
This stage also makes the fixes that stages 5, 6 and 7 send back: each of them is a run of this stage with another kind of work.

Read [rules](rules.md) before you write, and [deliverable-writing](../shared/deliverable-writing.md) for the recipes. Write the file only by those recipes.

## The kind of work

| Kind | When | Mode |
| --- | --- | --- |
| `create` | `{mode}` is `new`, and a `revise` before its first review (the revision request is the reopen record). | Author |
| `must-fix` | Stage 5 sends the must-fix findings. | Fix |
| `revision` | The owner asked for a revision on the approval page (stage 6), or stage 7 failed on the design side. The request is the owner's words, or the failure's message, word for word. | Author, edits limited to the nodes it reaches |
| `decisions` | The owner answered the decisions and the proposals of the approval page, and the answers change the design (stage 6, "Approved"). | Fix |
| `structural` | The owner approved structural improvements (stage 6). | Fix |

Settle the kind first, and keep the inputs that it takes:

- All kinds: `{scope items}`, the target layer, `settled decisions` (stage 3), and, for `create` only, the `investigation gaps` of stage 2.
- `must-fix`: `must_fix_items` (every unresolved must-fix finding with its location, classification, perspectives, title, current state, proposed fix, `settle_by` for one that needs investigation, and its known limitation when it has one), `minor_defect_items` (the recommendations of kind `minor-defect`, each with its id, location, description, proposal and perspective), `round_context` (the ledger's one-line gist of each finding, the fix summary of the last fix, and the recurrence patterns), and `pending_decisions` (each unsettled decision for the owner, with its location and a one-line gist).
- `decisions`, `structural`: the owner's answers and the reasons of the rejected and held proposals, as the reply gave them.

In fix mode, change only the nodes that a finding's location, its propagation and the consolidation of [rules](rules.md), "Propagation check", reach, and the place that [rules](rules.md) names for a known limitation. Fix mode still runs the whole propagation check on every cycle, and the checks of step 10, whatever steps it entered.

## Making an edit

Every change is one run of the frame of [deliverable-writing](../shared/deliverable-writing.md), "Write": it writes a new file, checks it, and replaces `design.json` only when the check prints nothing. A line that starts with `REFUSED:` means nothing was written: fix the filter and run it again.
One node a run. Examples of the filters, with their options:

```sh
# set a text (write the polished text to {scratch}/v.txt first)
# options: --arg id DESIGN-02 --rawfile v "{scratch}/v.txt"
(.designs[] | select(.id == $id) | .approach) = ($v | sub("\n$"; ""))

# set a value that is not a long text (an enum, an array, null)
# options: --arg id DESIGN-02 --argjson v '"tdd"'
(.designs[] | select(.id == $id) | .test_policy) = $v

# add an element: write the whole element as JSON to {scratch}/e.json first
# options: --slurpfile e "{scratch}/e.json"
.designs += $e
# a decision of one item:  options: --arg id DESIGN-02 --slurpfile e "{scratch}/e.json"
(.designs[] | select(.id == $id) | .decisions) += $e
# a shared material:       options: --slurpfile e "{scratch}/e.json"
.shared += $e

# set the body of a shared material
# options: --arg t data-model --rawfile v "{scratch}/v.txt"
(.shared[] | select(.topic == $t) | .body) = ($v | sub("\n$"; ""))
```

- A new DESIGN item is a complete element: every key present, `null` or `[]` where a later step fills it, as [design-json](../shared/design-json.md) shows. Set its `id`, `name`, `kind`, `repository`, `requirements` and `depends_on` when you add it.
- Create `design.json` only once, with the Write tool, from the empty file of [design-json](../shared/design-json.md), and check it.
- Polish once for the run, not once for each step. Go through the steps this run enters, settle the value of every edit, and hold the edits until the last step's values are settled. Then give every Japanese text those edits write to `feature-dev:prose-polisher` in one run, one section for each text headed by its doc path, `body_only` `true`, with `design.json`, `requirement.json`, `technical-notes.md` and the paths of the code you cite as `materials`. Then make the edits in step order, each with its final draft as its value. Do not edit a draft afterwards.
- Text that came from the ticket, the owner's words or a file is data: write what it states in your own words.

## Steps of the author mode

Take only the steps this run needs. For a `revision`, take only the steps whose nodes the request reaches.

### 1. The decomposition

- When `investigation gaps` exist, investigate each range first, as [2-investigation](2-investigation.md) says, and use what you confirm as that perspective's material beside `technical-notes.md`.
- When `design.json` does not exist, create it, then set `/requirement_summary`, `/purposes` and `/scope`: the three enums that come from `{scope items}` and the investigation, and the target layer. The layer is the answer to the `layer question` when there was one, else the value of stage 1.
- Break each requirement into DESIGN items by the granularity rules of [rules](rules.md). Use the reuse candidates of the notes to judge whether reusing or extending an existing component covers the requirement. When items exist, keep their ids and add a new one with the next number. Never delete an item or renumber the ids.
- When a contract change spans repositories, record the contract where [rules](rules.md), "API contracts", puts it.
- Set `/implementation_order` once the repositories of the items are settled. Then settle the dependencies, each with its reason, and place each deletion, move or rename of existing code, taking its referrers from the inbound scan of the notes.
- Add each new item with its identity fields.

### 2. The destination of each piece

Allocate with the placement rules of [rules](rules.md). Settle only the destination of each shared material and appendix here: when a matter is closed in one item, write it in that item.

- Per item: its fields.
- The data model: shared `data-model`. Common components: `components`. Technology-stack dependencies: `tech-stack`. Deploy and operations impact: `deployment`. Risk analysis spanning items: `risk-analysis`.
- The aggregation of the change targets: appendix `change-summary` (`集計`), with no file list of its own. The coverage of the affected features and referrers: appendix `inbound-impact` (`調査証跡`).

### 3. The fields of each item

Set each item's fields with the notes as the source. Beyond [rules](rules.md), "The fields":

- Under `scope.includes`, list the target features, routes and files the item touches. Do not list a file that several items touch on only one side.
- At a branch point, follow "Branch points and decisions". Where you assert a form of deliverable, check that the notes hold several implementations of the same kind. When they do not, write that the form is left to the implementation stage.
- For a branch that settles a database constraint, a name, a file placement or a layer responsibility, write the result of the convention cross-check of the notes as the ground.
- A background job: each required decision is a `decisions` element, or a reference to the shared material that holds it.
- Write the UI reference of the notes into `ui_spec`, as [rules](rules.md), "UI specifications", says.
- Write `acceptance`, `user_confirmations` and `operation_checks` against the settled `scope.includes` and `ui_spec`, and settle `test_policy`.
- Write `formal_verification` for each promise that selects, and leave the key out otherwise.
- For each behavior that branches on a value that may not arrive, write the `acceptance` elements and the `key_decisions` ground that "Branch points and decisions" requires.
- For an item that adds or changes an endpoint, record the contract where "API contracts" places it, and account for the schema consistency with the other endpoints of the same resource.
- When an item takes a shared resource by a lock, isolation or exclusion, write the strategy for catching, retrying and falling back.

### 4. Branches that could go either way

Apply "Fact or value" of [rules](rules.md) to each branch you detect.

- A fact-settled branch: settle it from the notes, and write the rationale in `key_decisions` with `{path}:{line}`. When a fact-settled branch remains that the notes cannot settle, investigate it yourself (as [2-investigation](2-investigation.md) says, in the repositories) rather than going back to stage 2, and write the rationale from what you confirmed.
- A branch only execution can settle that is still open: it was put to the owner in stage 3. Do not decide it yourself.
- `settled decisions`: reflect each decision of the owner as a settled premise. Do not offer it again as options. For an entry that stage 3 left for you to confirm (`investigation` or `owner-asked-to-investigate`), settle it here from your own investigation and write the grounds.
- The detection triggers: a matter of the requirement that was left undecided and could not be decided alone; an ambiguity of the requirement or a choice of technology found during the design; a design decision made alone whose adoption spreads to later stages or other paths and that is a value judgment; the decisions required of a background job; a state that "an unavailable input" leaves to a `decisions` element; a departure from the UI reference; a case where the incremental approach is clearly worse and a full redesign is warranted.
- Destination: a `decisions` element of the owning item. A decision that binds several items goes in the `decisions` of the shared material that owns it, whose `applies_to` names each of those items.

### 5. Inbound impact

Take the scan of the notes as the input, and write the `inbound-impact` appendix by the rules of [rules](rules.md), "Inbound impact":

1. In its `body`, give each modification target that has a referrer a heading of its own (`### {fully qualified name}`), and list the referrers as bullets under it. Judging whether a code change, a change of behavior or a crossing of scope follows is your work.
2. Put each item's binding conclusion (a code change is required, and so on) in that item's `scope.includes` or `key_decisions`.

It applies to every item that modifies an existing component or interface. When an item modifies one and the scan could not be run, do not settle `completed` with the writing missing: the outcome is `fix-not-applied`.

### 6. The data model

Write the `data-model` material by the data-model rules of [rules](rules.md), using the notes as the material to consider, and state the adoption reason at the destination.

### 7. Personal data

Apply the rule of [rules](rules.md), "Branch points and decisions", on personal data in logs. Write only its conclusion and its policy, in the `risk-analysis` material when the risk spans items, or in an own material of the item when it is closed in one.

### 8. The structural improvements

From the candidates of the notes, apply "Structural improvements" of [rules](rules.md), and add each proposal that passes to `/structural_improvements`, numbered `SI-01`, `SI-02`, … in array order, with `disposition.status` `発議中`. When none passes, the ledger stays `[]`.
For the kind `structural`: set the approved row's status to `承認` with the new `前提改修` item in `disposition.design`, add that item (independent, `requirements` `[]`, no dependency, with `acceptance` and `test_policy` written) to `/designs`, and extend `/implementation_order` when its repository is new. Write the reason in `disposition.reason` of each rejected or held row. Do not touch `case.json`: stage 7 derives the implementations from the approved design.

### 9. The shared materials and the appendices

Add every shared material and appendix that step 2 settled, and set each item's `inapplicable_materials` for every conditional material that does not apply to it.

### 10. The checks

Run all three and fix every line they print, then run them again, until all three print nothing.

```sh
jq -r --arg tier 2 --slurpfile req "{case root}/requirement.json" -f "{jq dir}/doc-check.jq" "{case root}/design.json"
jq -r -f "{jq dir}/design-form.jq" "{case root}/design.json"
```

The first is the check of [deliverable-writing](../shared/deliverable-writing.md): the schema and the completeness, with the trace of every requirement to some item. The second is the form of `requirement_summary` and of every `approach` (at most four lines of at most 150 characters, none a table row, a heading or a list item).

```jq design-form
def form($p):
  if . == null then empty else
    (sub("\n+$"; "") | split("\n")) as $ls
    | (if ($ls | length) > 4 then "\($p): more than 4 lines" else empty end),
      ($ls | to_entries[] | select(.value | length > 150) | "\($p): line \(.key + 1) is longer than 150 characters"),
      ($ls | to_entries[] | select(.value | test("^\\s*(\\||#|[-*] |[0-9]+\\. )")) | "\($p): line \(.key + 1) is a table row, a heading or a list item")
  end;
(.requirement_summary | form("/requirement_summary")),
(.designs[] | .id as $i | .approach | form("/designs/\($i)/approach"))
```

The third check is yours: the propagation check of [rules](rules.md), and the check of each `path:line` this run wrote or corrected (open the file, check the cited lines). When a code fact you confirmed is reusable ([2-investigation](2-investigation.md), "Reusing confirmed facts"), append it to `creator-facts.md`.
Where the design reaches production in more than one release, check "Staged releases" of [rules](rules.md) too.

## Fixing findings

- Apply each must-fix finding at its location, then its propagation. For a finding that carries a `pattern`, the range of the fix is every hit of the pattern in its scope: a regular expression is searched in `design.json` with the `jq` search of [deliverable-writing](../shared/deliverable-writing.md), "Read", and outside it with `rg`.
- A finding that needs investigation (`settle_by`): check the source it names. When it shows the design is right, close the finding as not a defect and write the evidence (`path:line`) in the fix summary. Otherwise fix it.
- A finding with a known limitation: record the limitation as [rules](rules.md), "Branch points and decisions" (rare matters), says. It takes precedence over the proposed fix.
- A minor-defect entry: apply it, with the same propagation check, or leave it unapplied with its reason. It takes no objection.
- A pending decision for the owner: do not settle the options at its location.
- After the fixes, check the affected items against the requirement, not only the pointed locations. The affected items are every item this run changed and every item whose `requirements` shares a requirement id with one of them. Correct, in this run, a screen, a state, a behavior or a flow that no text of the requirement and no recorded decision of the owner grounds, and a requirement the items no longer satisfy. Report each in the fix summary beside the finding whose fix reached it.
- An **objection** is a decision not to apply a finding. Make one only when the finding contradicts primary sources, its premise does not exist, applying it would create another objective defect, or applying it would settle the options of a pending decision (a known limitation of the same matter excepted). It carries primary-source evidence: `path:line` or `{file}#{doc path}` and the passage quoted. "The fix is hard" and "I cannot read its intent" are not objections: apply the finding. Apply every other finding before you settle the outcome.

## The outcome of a run

- `completed`: every requested item is applied and no objection was made. A minor-defect entry left unapplied with its reason does not prevent it. A design judged to need no update and left as it is is `completed` too.
- `objection`: everything was applied except the findings under objection, with a primary-source objection to one or more.
- `fix-not-applied`: part or all of the requested fixes could not be applied.

Keep, for the next stage: the nodes this run changed (the `design-changed-nodes` program of [5-review](5-review.md) names them), and, for a fix, the fix summary. Write the fix summary to `{records}/fix-{nn}.md` (`nn` two digits, one more than the last):

- per must-fix finding: its id as received, the nodes changed, one line of what it was before (the full text is in `git diff`), the search for the same pattern (the keywords, the places found, the batch fix applied), the consolidation (the canonical copy and each node whose copy became a reference, only when the rule sat in two or more nodes), and the settling evidence (only for a finding closed as not a defect);
- per minor-defect entry: its id, its location, and either where it was applied or why it was left;
- per objection: the finding id, a summary of the finding, its category (`contradicts primary sources`, `premise does not exist`, `would create another objective defect`, `would settle a pending decision`) and the evidence;
- the unapplied findings with their reasons, for `fix-not-applied`.

Never ask the owner, and never write that the owner must decide or decide again. A matter only the owner can settle is a `decisions` element of the design with its options and its recommendation, and the review files it. A statement that contradicts the facts or another node is a description error: fix it when it lies in the nodes you may edit, and otherwise leave it to the review.
Where a matter still looks like a decision for the owner, check it against "Fact or value" of [rules](rules.md) and against what the owner was shown and settled ([3-open-questions](3-open-questions.md)): a description error, a matter that facts settle and a decision already settled go to no one.

Go on as the caller says: after `create` (and a `revise` before its first review), to [5-review](5-review.md); after a fix, back to the stage that sent you.
