# Norms of the requirement unit

How to investigate and how to write the requirement definition.
The schema (fields, types, ids) is [requirement-json](../shared/requirement-json.md). This file says what to put in each field and how to cut and word it.
The reviewers check against these norms, so write to them from the first draft.

## Cutting requirements

### What and How

Write What (what the user can do, what happens). Do not write How (how it is built) in `requirement.json`.

| Kind | What (write it) | How (leave it for the design) |
| --- | --- | --- |
| Processing | "can do X", "X happens" | "by using Y", "by method Y" |
| Technology | nothing | library and framework names |
| Numbers of the implementation | nothing | batch size, retry count, timeout |
| Architecture | nothing | layers, class design |
| Database names | the domain word ("reservation status", "accepted at") | column, table and enum value names |
| Code names | the feature name ("reservation confirmation notice") | class, module and method names |

An identifier in backticks is probably How. Whatever does not depend on one technology, and could be built another way, is What.
Also leave to the design: HTTP status codes, data structures (field names, URL paths), performance methods, and the technical confirmation of a range that fact checking left unmatched.

On a migration from an existing system, record what the old system realizes ("imports the data from XML", "12,000 records") in the requirement, and how it does it (the parser, the batch size) in `technical-notes.md` for the design.

### One requirement, one thing

Always split a requirement that can be split. Split when:

- the business flows differ (create, update, delete and read are four requirements),
- the data contexts differ (different models or entities),
- the user operations differ (operations the user sees as distinct).

The name of a requirement holds its target and its operation.
Write each requirement from the user's view, in the form "can do" or "is shown".
Number them `REQ-01`, `REQ-02`, ... in development order, after you have worked out which depends on which.

### Wording

- Do not write "probably", "it seems", or any guess. Name the concrete target.
- Make vague words concrete by confirming in the code what they point at: "related to X", "X and the like", "similar to X", "around X".
- State the boundary of a time word: which instant it is relative to (start, end) and whether the boundary is included. Not "after the reservation time", but "after the planned start time of the examination".
- Keep the literal meaning of a passage of the request that is not vague: the name of a screen, a step, the order of steps. Making a word concrete finds its target. It never changes what happens there.
- Do not write a matter that is still unsettled into the deliverable: no "to be decided" list or passage, and no "options and recommendation" left in the body. It goes to the owner as an open question, and only the settled answer is written.
- Say what a UI label such as "memo" or "status" belongs to, in the user's words (the reservation's memo or the payment's memo). Table and column names go to `technical-notes.md`.

### The design scope and the three expectations

The owner is not asked about these. Investigation settles them.

- `scope.design_scope.data_migration`: whether existing data changes (a renamed enum value, a dropped column, converted values), and how, in an outline. Look at the schema, the enum definitions and the current values.
- `scope.design_scope.api_contract`: whether there is a breaking change toward outside clients (response shape, enum values, error codes). Pair the existing response with what the request asks.
- `scope.design_scope.infrastructure`: whether the work depends on anything outside the code repository (external storage, logging, monitoring). Check the code and the configuration.
- The three expectations, written as one shared material or one own material with the topic `expectations`: external systems (does the feature call an outside service), operations (is there a scheduled or batch path, or only screen operation; a release constraint that the request states goes here as stated), and non-functional (the level of similar features, or the target value the request states).

Write a settled value for each. Never leave several options side by side, and never leave one blank.
Take the three expectations as the owner's information gives them. Whether they are technically feasible is for the design.

### What to include and leave out

- Make the scope explicit: what this work does (`scope.in_scope`, naming the repositories whose code changes, and the ones the request named that are not involved, with why) and what it leaves out (`scope.out_of_scope`, `null` when nothing is left out).
- Every request of the owner that belongs to this work becomes a requirement. None is dropped.
- A requirement nobody presented is not written. A matter you find necessary and the request lacks is an open question.
- Every constraint or condition that a statement carries has a source, cited beside it. The sources that count: the request or ticket, the UI reference of `technical-notes.md`, a user decision of the document (`UD-NN`), and a primary source in existing code or specification (path and lines). A statement that departs from the request, or from what the UI reference shows (its drawing, display conditions, wording, elements), has a source only when a user decision or a passage of the request states that departure. A constraint whose source you cannot show is not settled by inference: it goes to the open-question list.
- When the request removes, moves or renames a screen, an operation or an entry point, find every existing user-facing text that directs users to it (screen copy, notification bodies, feature specifications): search by the screen's name, the operation's label, the route path, and what the specifications say. Search the repository you work in and every repository the ticket or the owner names. Raise one open question for each changed target that the request does not address, listing every hit: either change those texts in this work, or leave them out of scope. Do not settle it by inference.

## Facts from the code

- Verify functional requirements, business rules, data specifications and consistency with the existing system against the code. Read, do not assume. Confirm that a symbol exists before you cite it.
- A claim of absence ("the system does not record X yet") is checked in the code, not read off a name.
- Do not adopt a conclusion that rests on a count alone ("it matches 120 records"). List the items on the code side, pair them with the other side, and then adopt it. When the size makes a listing impractical, write the matched range and the unmatched range in the evidence, and write the conclusion as resting on the matched range. This is not a question for the owner. When the unmatched range bears on whether a requirement holds, add its technical confirmation next to the evidence as a matter for the design.
- Record evidence as `{path}:{line}` plus 1 to 3 lines of the code that match. Examples:
  - "an authentication feature exists": `app/controllers/auth_controller.rb:15` `class AuthController < ApplicationController`
  - "a validation rule exists": `app/models/user.rb:23-27` `validates :email, presence: true`
- The conclusion of an entry covers exactly the scope its investigation item declared. When part of the declared scope was not verified, say whether it was out of scope or missed. When it was missed, investigate it. Never narrow the scope silently.
- Open the cited file with `Read` and check that the cited lines hold what the sentence claims. The line number printed by a search is not a ground. For a range, check both ends.

### Reusing confirmed facts

Two files record at which commit a fact was confirmed, so that a fact is not read again when its file has not changed.

- `code-facts-base.json`, beside `technical-notes.md`, written in stage 2 each time you write `technical-notes.md`. A JSON object that maps the absolute root of each repository you investigated to `{"commits": [...], "unclean_paths": [...]}`. Append `git -C {root} rev-parse HEAD` to `commits`, and the repository-relative path of every fact of this write that is not reusable to `unclean_paths`, each only once. Never remove or rewrite an element.
- `creator-facts.md`, beside it, appended to in stage 4 for every reusable fact you confirm yourself. One entry per fact, never rewritten:

  ```markdown
  - `{absolute repository root}` `{path}:{line}` `{git rev-parse HEAD at confirmation}`
    `{excerpt line}`
  ```

A fact is reusable only when `git -C {root} ls-files --error-unmatch -- {path}` succeeded and `git -C {root} status --porcelain -- {path}` printed nothing when you confirmed it.
You may cite a `path:line` without reading it again when:

- from `technical-notes.md`: the path is not in that repository's `unclean_paths`, and `git -C {root} diff --quiet {commit} -- {path}` exits 0 for every commit of its `commits`,
- from `creator-facts.md`: `git -C {root} diff --quiet {entry commit} -- {path}` exits 0.

On any other result, read that file again.

## The open-question list

A question that investigation could not settle goes on this list, and the list goes to the owner on a page (stage 3).
Put on it only what needs the owner's business, scope or priority judgment, after the code and the request have been checked and left too little to decide on.
A fact of the code or of a specification is settled by reading it, not asked. A matter of the design (technology, structure, numbers of the implementation) is not asked either. Do not number the entries.

Each entry has:

- `title`: a plain Japanese heading.
- `background`: why it could not be settled. Cite the range of sources you checked as `{path}:{line}`. When the question or an option states wording that a current screen shows, find where the screen code produces that wording, for each target feature, and cite it. Do not take it from a specification alone. When the matter is one that the request states, quote that passage of the request word for word.
- `options`: one option per line, with its trade-off. When `background` quotes a passage of the request, mark each option "as requested" or "departs from the request".
- `recommendation`: one of the options. Never "undecided".
- `recommendation-reason`: why, naming what changes and what it is compared with, so that it reads without the other fields.
- `binding-scope`: which requirements or shared materials the decision binds.

## Writing the fields

Where an item goes, by what it binds:

```text
an item with no field of its own
   |-- governs the whole definition ----------> the top-level fields (background or problem, purpose, scope)
   |-- binds a requirement or a later judgment
   |      |-- one REQ only -------------------> that requirement (its fields, or its extra_materials)
   |      +-- several REQs, one shared copy --> a shared material
   +-- binds nothing directly -----------------> an appendix
```

- There is no fourth class "cannot decide". A shared material is not a dump for what has no place. An item that binds one REQ goes in that REQ. A final judgment that binds a requirement is never only in an appendix. Extra material is only ever an element of `extra_materials`, `shared` or `appendices`, never folded into `summary`, `expected_behaviors` or `purpose`.
- `background` (a new feature, a change, a migration): the need the owner stated and the current problem, as a list. `problem` (a bug fix): the problem in detail. Write exactly one of the two, by the kind of change, and leave the other `null`.
- `purpose`: the problem to solve and the effect expected, as a list.
- `scope.in_scope` and `scope.out_of_scope`: see "What to include and leave out". The three `design_scope` items: see "The design scope and the three expectations".
- Do not write the body of a requirement in the top-level fields. Do not put the current and the goal, the expectations, cross-cutting concerns, the impact or the risks in them: they are shared materials (below).
- A requirement: one element per REQ, one REQ per element.
  - `name`: the name. `summary`: what it realizes, in one to three lines of prose, each at most 150 characters, with no table, heading or list line. Conditions and values go in `expected_behaviors`.
  - `expected_behaviors`: one element per thing it realizes.
  - `user_decisions`: the decisions that bind this REQ only, each `body` holding what the owner settled.
  - `user_decision_refs`: the ids of the decisions that a shared material owns and that bind this REQ. Do not copy their content.
  - `extra_materials`: material of this REQ alone, each with a `role` that says how the REQ uses it. `related_appendices`: the appendices it uses, each with a `role`.
  - Decisions, risks and impact that bind only this REQ stay in this REQ.
- A shared material holds only content that several REQs use as one canonical copy. `summary` says what it settles. `body` is that content, never copied into a requirement, or `null` when the material only shares user decisions (at least one in `user_decisions`, whose content stays there). `applies_to` lists each REQ with its `role`, and it is the only place where the link between a material and a REQ is stored. A user decision that binds several REQs goes in the material's `user_decisions`, and each REQ it binds lists it in `user_decision_refs`.
  The standard topics: `current-and-goal` (as is and to be; the grounds of the as-is stay in the notes), `expectations`, `cross-cutting`, `impact` (the settled judgment on the impact; its evidence stays in the notes) and `risks`. When only one REQ binds such a topic, put it in that REQ's `extra_materials` under the same topic.
- An appendix holds supplements, cross-checks and investigation notes that bind no requirement and no later judgment. `category` is `補足`, `検算` or `調査整理`. Other concerns go to the appendix with the topic `open-concerns`. When a judgment an appendix discusses binds a requirement, put the judgment where its binding scope says, and keep only its grounds in the appendix. Do not repeat the as-is evidence that `technical-notes.md` holds: the notes are canonical for evidence.
- Do not add a material that has no content. Say "not applicable" as an element of the REQ's `inapplicable_materials`: `name` is the material and `reason` says why it does not apply. Every REQ keeps at least one row in its related materials (the shared materials that apply, `related_appendices`, `extra_materials`, `inapplicable_materials`).
- An omittable text with no content (`background`, `problem`, `scope.out_of_scope`, the `body` of a shared material that owns a decision) is `null`, never "none". An array with nothing in it is `[]`.
- A rule or fact is written once. Do not restate it in a requirement's `summary`, `expected_behaviors` and extra materials, and do not copy the body of a shared material into a requirement.

### The screens and the screen flow

Write `screens` and `screen_flow` only when `technical-notes.md` has the section "UI reference". Otherwise leave both out.

- `screens`: one element per screen the flow passes through, taken from the screen list of the UI reference. A screen with a design node has its node id as `id`, and its saved screenshot (`ui-references/{node id with the colon written as a hyphen}.png`) as `image`. A screen with no design node has a local id: one drawn only in an image keeps that image as `image`, and one with no design at all (an OS standard screen, an existing screen the design does not show) has `image: null`. `changes` says what the requirement changes on the screen.
- `screen_flow`: one `normal` row per step of the request, in the request's order. `request_step.quote` is the request's wording of the step, word for word, and `source` says where it is. A flow that leaves the normal flow under a condition is a `branch` row with its `condition`.
- `path`: from the transition flow of the UI reference. `op` is the wording of the button the design shows, word for word. A transition the investigation left `unresolved` is written with the destination that its open question settled.
- `verdict` of a `normal` row: `一致` when its path holds the screens that realize the quoted step as worded (the screen the step names, on which what the step says does happen), and `不一致` otherwise. A `不一致` row departs from the request, so write it only on a user decision that states the departure from the quoted passage.
- When the UI reference has an element, classify each one with no exception: a requirement of this work, out of scope (with the grounds as a user decision), or a reuse of an existing feature (with the link to it made explicit).

### Ids

- `REQ-01`, `REQ-02`, ... in development order, which is the array order.
- `UD-01`, `UD-02`, ... without a gap, unique in the whole document, only for decisions the owner answered. A provisional decision and a business side's answer that the owner relayed are among them. Never a suffix form such as `UD-S`.
- A provisional user decision has `provisional: true`. It holds up neither the review nor the move to the design. When the business side confirms it, a revision drops `provisional`, keeps the number, and rewrites `body` when the confirmed answer differs.
- A `topic` is lowercase English in kebab-case.
- Use one notation for one concept across the whole deliverable.

### When you change what is written

Check the blast radius, not only the spot you edit.
First re-verify against the sources every statement about existing code, specifications or behaviour in the item that holds the edited spot (a requirement, a shared material, an appendix, or a top-level field), even when no finding points at it.
Then follow the change to where it reaches:

- A corrected fact about existing code: every like statement (`background` or `problem`, `purpose`, the matching requirement, every shared material that rests on the same premise).
- Adding, deleting, splitting or merging a requirement: the ids of the requirements after it, and every reference to a renumbered id (`applies_to`, ids in text).
- Settling or changing a user decision: its owner's `user_decisions`, the `user_decision_refs` of the requirements it binds, and the `expected_behaviors` of every requirement written on it as a premise.
- A change of a numeric range, a boundary or a relation (`<`, `<=`, `=`, `>`, `>=`): every requirement that rests on the same relation and the matching shared material. Search for the dependent rules and judge them again under the new premise.
- A change of scope: `scope`, and every requirement and appendix written on the added or excluded range.
- A change of the range of a shared material: its `applies_to`, and the `user_decision_refs` of every requirement that gains or loses it.
- A change that alters a screen or a transition: `screens`, `screen_flow`, and the `verdict` of every `normal` row whose path changes.

Fix every like spot in one batch.
When a rule or fact stands in two or more nodes, do not fix each copy. Make one canonical copy (the `body` of a shared material when several REQs bind it, otherwise the one node that the rules above name, with a user decision's content staying in its owner), delete the other copies, and link each REQ that relied on a deleted copy to it (`applies_to`, or `user_decision_refs`). Adding a shared material and moving content into it is within a fix.

A defect of a recurring pattern is not finished at the spot a finding names. Search the whole file for the pattern (`jq` over the strings, [deliverable-writing](../shared/deliverable-writing.md)) and fix every hit.
