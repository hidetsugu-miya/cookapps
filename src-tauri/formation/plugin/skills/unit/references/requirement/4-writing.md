# Stage 4: writing

Write `requirement.json` from the request, the notes of stage 2 and the settled decisions, and leave it complete.
You get here in `{mode}` `new` from stage 1, 2 or 3, and in `modify` from stages 5 and 6, and from a revision.
Read [norms](norms.md) before you write, and [deliverable-writing](../shared/deliverable-writing.md) for the recipes.

The routes into this stage:

- First authoring (`{mode}` `new`): the whole file.
- A hold resume whose questions are all settled, or a stage 3 that settled the questions: the decisions go in `settled_decisions`.
- A fix of stage 5 (the must-fix findings that are not located in `technical-notes.md`, and the minor-defect recommendations that go with them): change only the affected nodes.
- A revision from stage 6 (the owner's revision request, and the decisions that its answers settled): change only the affected nodes.
- A reopen (the record of stage 1): the owner's words in it are a revision request. `{mode}` is `modify`.

Do not stop in the middle. Finish every step, then say how you ended (step 6).

## What you write from

- The notes (`technical-notes.md`): read only. Do not write it here. For a fact the notes lack, confirm the source yourself (below).
- `settled_decisions` and the revision request.
- The request (`{scratch}/request.md`).

You may confirm a fact of the code or of a specification that the drafting, a finding or a decision needs. Do not run a per-perspective investigation, and do not write the notes.
For this, collect the facts yourself with `rg` and `Read`, or with `feature-dev:code-explore` for independent questions, and `Read` what it returns. Append every reusable fact you confirmed to `creator-facts.md` ([norms](norms.md), "Reusing confirmed facts"). Open each cited file and check that the cited lines say what the sentence claims, and cover every citation of an item you correct.

## Step 1: the reading of what is given

Branch on `{mode}`:

- `modify`: read the nodes the change touches, and the nodes the blast radius of [norms](norms.md) ("When you change what is written") reaches. Update only those.
- `new`: the normal flow, from step 2.

## Step 2: split the requirements

When the notes have a section "UI reference", enumerate the UI elements of the design (search fields, filters, columns, buttons, status displays) and classify each one with no exception, as [norms](norms.md) ("The screens and the screen flow") says.
Split the requirements as [norms](norms.md) ("Cutting requirements") says, work out which depends on which, and number them by development order.

## Step 3: the unknowns

Settle each from the notes, `settled_decisions` and the request:

- A codebase or specification fact that these lack, a fix needs included: confirm the source yourself (above).
- An entry marked `investigate-before-deciding`: confirm the sources the same way, and take the option that the sources support. It is not a user decision and gets no number. When the sources cannot settle it, it stays unsettled.
- An entry marked `confirm-feasibility`: confirm whether the code allows what the business side asked. When it does, the request is the decision. Number it with the next `UD-NN`, with the business side's answer as its reason, and rewrite any statement of `requirement.json` that conflicts with it. A request that answers the subject of a provisional user decision revises that decision under its own `UD-NN` instead. It stays unsettled when the sources show the code does not allow it, or cannot settle whether it does, and when a conflicting statement rests on a user decision that is not provisional. The question's `background` then says what you found.
- When the notes have a "UI reference" section: a step of the request whose screens the flow cannot realize as worded, with no user decision that states the departure, stays unsettled, and so does a transition still `unresolved`.
- The matters that are for the design ([norms](norms.md), "What and How") are not handled here.

Then branch:

- At least one item is unsettled: put each on the open-question list, do not run steps 4 and 5, and go to [stage 3](3-open-questions.md). When stage 3 returns its decisions, come back here in `modify` mode with them. An item that stage 3 left to investigation comes back marked `investigate-before-deciding`.
- None is unsettled: go on.

## Step 4: write the deliverable

1. Write the texts first, in files. Polish every Japanese prose text that goes into the deliverable with the `feature-dev:prose-polisher` agent in one run, each text as its own section headed by its path in the document (`/requirements/REQ-02/summary`), and ask for the body only. Write each section's final draft as it is ([decision-page](../shared/decision-page.md), step 4, and [deliverable-writing](../shared/deliverable-writing.md)).
   Do not polish `screen_flow[].request_step.quote` and `screen_flow[].path[].op`: they are word-for-word texts, written as they are.
2. Create the file once, when `{mode}` is `new`, from the empty file of [requirement-json](../shared/requirement-json.md), as [deliverable-writing](../shared/deliverable-writing.md) says. In `modify`, change only the affected nodes, and the nodes that the blast radius reaches, copies of a rule or fact included.
3. Write the fields by [norms](norms.md) ("Writing the fields"):
   - The three items of `scope.design_scope`: the settled values recorded in the notes. When `settled_decisions` has a decision for an item, take it instead. Never leave several options side by side, and never leave one blank.
   - Each `confirm-feasibility` entry that step 3 settled: a user decision, and the request reflected in the requirements and in `scope`.
   - Each `settled_decisions` entry marked `provisional`: a user decision with `provisional: true`.
   - A message from the owner that says the business side confirmed a provisional user decision: the revision of "Ids" in [norms](norms.md).
   - `screens` and `screen_flow` when the notes have a "UI reference" section, with each `normal` row's `verdict`.
   - `applies_to` of each shared material, and `related_appendices` of each requirement that uses an appendix. These lists are the only place of each link.
4. Run the check after each change as [deliverable-writing](../shared/deliverable-writing.md) says. A line of `REFUSED:` wrote nothing: fix the filter and run it again.

In `modify` mode, also:

- Resolve every must-fix finding that was given to you in the same run. A must-fix that you decide not to apply is an objection (step 6), never an item left untouched.
- A recommendation of the kind minor-defect is applied or left with a one-line reason. It takes no objection, and leaving it does not by itself change how this run ends.
- Close a finding of the kind investigation-required as its fix note says: confirm the source it names, and either fix it, or keep the primary-source grounds that show it is not a defect. Either closes it.
- A defect of a recurring pattern: fix every hit of the pattern, not only the spots named ([norms](norms.md), last paragraph).
- Do not change the text at the places of the excluded list, nor settle the options of a question that waits for the owner (a needs-decision item of stage 5).
- Do not write the history of a fix into the deliverable.

## Step 5: check the deliverable

1. Search the texts for stray markup that an AI leaves behind: a closing tag with no opener (`content`, `invoke`, `parameter`) or a control token. Remove what you find, with the recipes.

   ```sh
   jq -r 'paths(type == "string") as $p | getpath($p) as $v | select($v | test("</?(content|invoke|parameter)>")) | "/" + ($p | map(tostring) | join("/")) + ": " + $v' "{case root}/requirement.json"
   ```

2. Run the whole check of [deliverable-writing](../shared/deliverable-writing.md), "Check". It must print nothing. Resolve every line.

## Step 6: how the run ended

Settle it as one of these, and go where it says:

- **completed**: no item is unsettled, and every requested item is applied. In `new` mode the file is created with every item written. In `modify` mode every must-fix is applied or taken as an objection. Keep a short fix summary for stage 5 (below). Go on as the route says:
  - from stages 1 to 3, or a first authoring: to [stage 5](5-review.md), step 1,
  - from the fix of stage 5: back to stage 5, step 2,
  - from a revision of stage 6: to stage 5, step 3.
- **open-questions**: step 3 left items unsettled. You are already in stage 3.
- **objection**: you applied everything except one or more must-fix findings, and you hold primary-source evidence against them (below). Keep each as an objection, and go on as for **completed**: the objection is handled by stage 5.
- **fix-not-applied**: you could not complete the work, because an inspection item lacks evidence you can record. Say so to the leader with `BLOCKED requirement: {the unapplied finding ids, the reason, the uncovered range}`, and stop. Do not go on as a partial success. When you can raise an objection, use **objection** instead.

### An objection

A must-fix finding is not applied only when: it contradicts a source, its premise does not exist, applying it would create another objective defect, or applying it would settle the options of a question that waits for the owner.
An objection carries primary-source evidence: the path and line, and the quoted passage. "The fix is hard" or "I cannot read the intent" is not one: apply the finding then.
Apply every other requested item first. An objection never stops the other work. Closing an investigation-required finding as "not a defect" is not an objection.
Keep the ids the reviewer gave. You never number a finding.

### The fix summary

Keep, for the next reviewer, in your context, for each must-fix finding:

- its id and a short summary of the finding,
- the fix location (`requirement.json#{pointer}`),
- the summary of the text before the fix, in one line (`git diff` has the full text),
- how to verify the fix, as a pointer: the reviewer reads the node itself, so do not repeat the new wording,
- the search for the same pattern: the keywords, the hits, and what you did,
- for a fix that changes a relation (`<`, `<=`, `=`, `>`, `>=`): the dependent-rule search and the result of judging them again,
- for a fix about numeric ranges, order, containment or choices: the cases you checked and the result of each,
- the blast-radius check: which related nodes you looked at and which you changed (for copies made into one canonical copy: the canonical node and the nodes the copies were deleted from),
- for a finding closed as not a defect: the source you checked, as `{path}:{lines}`.

For each minor-defect recommendation: its id, its location, and either where you applied it or, in one line, why you did not.
For each objection: the finding id, a summary, the category (contradicts a source, premise does not exist, would create another defect, would settle a waiting question), and the evidence.

Do not write the new wording into the summary, and do not shorten it to "fixed".
