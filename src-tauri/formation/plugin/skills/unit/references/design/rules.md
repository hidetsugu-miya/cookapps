# The rules of the design

What the basic design holds, where each piece goes, and what it must not hold.
Read it before stage 2 (what to investigate) and before stage 4 (what to write), and again when you fix a finding.
The fields and their types are in [design-json](../shared/design-json.md). This file says what to put in them.

The design is a policy document for the people who implement it.
It states what is done, where, and why, at the level of policy and design judgment.
It never states how a method works inside.

## Where each piece goes

Put each piece of content in exactly one of four places.

```text
A piece of content
  governs the whole design ------------------------------> a document-level field
  binds an implementation, a requirement or a later decision
      one DESIGN item only ------------------------------> that item's fields (extra_materials too)
      several items share one source of truth -----------> a shared material (shared[])
  binds nothing directly --------------------------------> an appendix (appendices[])
```

- Document level: `requirement_summary`, `purposes`, `scope`, `implementation_order`, `structural_improvements`.
- A DESIGN item: its `requirements`, `depends_on`, `purpose`, `approach`, `ui_spec`, `scope`, `acceptance`, `test_policy`, `user_confirmations`, `operation_checks`, `formal_verification`, `key_decisions`, `decisions` and its own materials.
- A shared material: data model (`data-model`), common components (`components`), technology-stack dependencies (`tech-stack`), deploy and operations impact (`deployment`), risk analysis that spans items (`risk-analysis`), and every other material that several items rely on as one source of truth.
- An appendix: aggregations and cross-checks (`change-summary`, category `集計`), the inbound scan trace (`inbound-impact`, category `調査証跡`), and other material that binds nothing.

Rules of placement:

- A material only one item uses goes in that item's own fields or its `extra_materials`, never in `shared`. A shared material that ends up applying to one item is folded into that item and deleted.
- There is no fourth place such as "undetermined". `shared` is not a dump for what you cannot place.
- A final judgment that binds the implementation is never only in an appendix. Put the conclusion in the owning item or shared material, and keep only its grounds in the appendix.
- A `topic` is lowercase kebab-case. Do not add an element with no content. A conditional material that does not apply to an item is a row of that item's `inapplicable_materials` with its reason, so that an omitted investigation is told apart from "does not apply".
- A field that is omittable (`ui_spec`, and the `body` of a shared material that owns a decision) is `null` when it does not apply. An array with no entry is `[]`. Neither is written as "none".
- Units and their progress live in `case.json`. The design holds up to the dependency graph, the order of repositories and each item's completion criteria and test policy. It holds no link to a ticket or a pull request.
- A DESIGN item does not hold which implementation carries it. That is derived into `case.json` ([7-implementations](7-implementations.md)).

## What the design must not hold

- No implementation logic: branches, loops, SQL, algorithms inside a method.
- No implementation detail: class diagrams, step-by-step work, diffs against existing code, application rules, a library's behavior. Record that a component exists and what it is responsible for. Do not assert a file format or a class structure that the investigation did not back with several implementations of the same kind. Where it did not, write that the form of the implementation is left to the implementation stage.
- No transcription of investigation evidence. A code shape found in the notes (call shapes, method chains, API names) is the ground of a fact, not text for the design. Where a decision needs code evidence (a `path:line`, an existing class or method name), write it only in that item's `key_decisions` or in the `reason` of the `decisions[]` element it grounds, as the conclusion with at most one short reference. The detail stays in `technical-notes.md`.
- Exempt from the two bans above: the values of a `ui_spec` (dimensions, colors, wording, display conditions), and what a `formal_verification` element states.
- No duplicate: a rule or fact is written once, and every other place refers to it by identifier or doc path. A field holds what no other field holds (no dependency written in `approach` instead of `depends_on`, no decision left as prose in `key_decisions` instead of `decisions`).
- No requirement that `requirement.json` lacks, and no addition by guesswork. A matter you find necessary and the requirement lacks goes to the owner as an open question ([3-open-questions](3-open-questions.md)), not into the design.
- No vague wording that the requirement and the code can make concrete ("works together properly", "manages").
- No two adopted options left standing in parallel, and no counter-example or configuration example that does not work by itself.

References inside the design:

- Point at deliverable content by identifier (`REQ-03`, `DESIGN-02`, a `topic`), or by doc path (`/designs/DESIGN-02/decisions/0`) where a node below an item must be named. Never by line number.
- A `path:line` is only for code evidence, relative to the repository root, never absolute.
- A reference to an id or topic that the deliverables do not define, and a cited line that no longer holds what the sentence claims, are defects.
- Abbreviations: write `REQ`, `DESIGN`, `UD`, `NR`, `MF`, `RC` and `SI` only in the id form (`REQ-03`, `SI-01`) or as the heading of a column of ids. Never `UD`, `MF`, `NR`, `RC` or `SI` alone in a sentence.

## The fields

Every field that stage 4 requires ([design-json](../shared/design-json.md), "What the check enforces") is written. A text field that does not apply to its subject still says why. Write this much in each:

- `requirement_summary`: the main requirements in two to four lines.
- `purposes`: one element per purpose of the design, with its explanation.
- `scope`: the four settled enums. The target layer is settled in [1-context](1-context.md), the others from `requirement.json`'s `scope.design_scope` and the investigation.
- `implementation_order`: every repository the DESIGN items target, in the order they are implemented, the backend before the frontend. An item depends only on items of its own repository or of an earlier one.
- DESIGN `name`, `kind`, `repository`: the name; `機能` for a change derived from a requirement, `前提改修` for a change other items need or an independent structural improvement; exactly one repository.
- `requirements`: the REQ ids the item realizes. It is the only stored trace from a requirement to a design item. Several requirements on one item and one requirement on several items are both written as they are. `[]` for a `前提改修`.
- `depends_on`: each item this one depends on, with the reason. An item that needs a `前提改修` derived from it lists it. An independent `前提改修` has no dependency to record.
- `release`: only when the code reaches production in more than one release (below). Then it is written on every item.
- `purpose`: why the item is needed (its requirement, or its place as a `前提改修`), in one or two lines.
- `approach`: how it solves the problem, in two to four lines of policy: follows an existing pattern or a new one, the level of abstraction, where what is added or changed. No method signature, no class diagram, no API contract. At most four lines, each at most 150 characters, none a table row, heading or list item. The same limit holds for `requirement_summary`. The check is `design-form` ([4-authoring](4-authoring.md)).
- `ui_spec`: only for an item with a UI, transcribed from the UI reference of `technical-notes.md` (below). `null` otherwise.
- `scope.includes`, `scope.excludes`: the features, routes and files the item touches, and what is out with the reason. A file that several items touch is listed in each of them. `scope.includes` is the only stored list of the files a change touches.
- `acceptance`: one verifiable outcome per element, stating how a feature or behavior of `scope.includes` is verified as a behavior (an action, a response, a rejection). A file entry is covered by the element that verifies the behavior it carries, with no element per file. An element that says only that a deliverable exists is not acceptance. Each element can be verified from this item's deliverables and those of the items it depends on. An item with `ui_spec` has an element that refers to it for display items, wording, conditions and values, without repeating them.
- `test_policy`: `tdd` or `direct`, from `approach`, `scope`, `key_decisions` and the precedent in the repository.
- `user_confirmations`: one element per screen and state whose completion criteria and `ui_spec` are verified from a capture: `screen_state`, `screenshot` (a path relative to the case root, reading material and not a criterion), and `state_setup` (the data or response the app must receive and the operations to reach the state, `null` for the state the screen shows on opening). Every screenshot the `ui_spec` lists appears in at least one element. A dimension the screen must match is a value in `ui_spec`. `[]` for an item with no `ui_spec`.
- `operation_checks`: one element per `acceptance` element that involves an operation on a screen: `acceptance` (that element, verbatim), `state_setup`, `steps` (the operations in order, written now so that the verification infers nothing at run time) and `expected`. Leave the key out when no element involves one.
- `formal_verification`: one element per promise that [Promises to verify formally](#promises-to-verify-formally) selects. Leave the key out when none qualifies.
- `key_decisions`: the grounds of the adopted approach, the rejected alternatives and the trade-offs, each conclusion with at most one short reference. It is never "nothing special" on an item with a branch point.
- `decisions[]`: one element per branch with options and a recommendation ([Branch points](#branch-points-and-decisions)).
- Related materials of an item: every shared material whose `applies_to` names it, its `extra_materials` (`name`, `role`, `body`), and an `inapplicable_materials` row for every conditional material that does not apply.
- A shared material: `applies_to` names each item it binds with its role there (the only stored copy of the link). `body` is the one canonical copy of the content, without implementation detail, or `null` when the material only shares decisions. `decisions` holds the decisions that bind several items.
- An appendix: `category` is `集計`, `調査証跡` or `検算`. In the inbound scan trace, list every referrer of each modification target as `path:line` with how it refers and its blast radius (code change needed, behavior change, scope crossing), and write "no reference" for a target with no hit.
- `structural_improvements[]`: one row per filed proposal ([Structural improvements](#structural-improvements)).

## Traceability and scope

- Decompose each requirement into DESIGN items. A requirement may become several items. Number them `DESIGN-01`, `DESIGN-02`, and so on in array order.
- Every repository the scope puts in scope has at least one item. An item names one repository. When a change spans repositories, split it per repository. A repository that holds no implementation code and only receives specification updates gets no item.
- Before you judge a related API out of scope ("another purpose", "outside the requirement"), read the code of its consumer, in the frontend too even when it is another repository: filter conditions and parameters may couple the two APIs. When they couple, the API is in scope.
- State "includes" and "excludes" in every item. Record out-of-scope matters with their reasons.

### UI specifications

Transcribe the UI reference of `technical-notes.md` ("UI reference") into the `ui_spec` of the item whose change delivers it. When several items change one screen, each transcribes what it delivers, and its `user_confirmations` hold the states it delivers. Per target screen write: the node id of the design file and the screenshot path under `ui-references/`; the display items, their wording, and the display conditions and variations; dimensions, colors (hex) and fonts.
Where an item departs from the UI reference, or settles a discrepancy inside the reference toward one side, it is a value judgment ([Branch points](#branch-points-and-decisions)), unless a decision of the owner or a passage of the request already states the departure: then write the adopted value and cite that decision or passage.

## Granularity

A DESIGN item is one change that can be completed and verified on its own. File counts and line counts do not enter the judgment.

- Completed on its own: with this item and the items it depends on applied, and no other, the product holds no half-delivered, lost or duplicated behavior.
- Verified on its own: its `acceptance` holds from the deliverables of this item and of the items it depends on.

Put two changes in separate items when each meets both conditions, and record any order between them in `depends_on`. Keep them in one item when separating them leaves either side failing a condition. These fail: a component, hook, API call, formatting function or type without its consumer; part of the display items of one view; adding a behavior at its new place apart from removing it at the old one; moving part of the operations on one object and leaving the rest.

One responsibility is not scattered over several items, and one item does not hold several responsibilities. A shared rule or contract is kept in one shared material that each item refers to, and an item that restates it in its own words is a duplicate.

Backend:

- A REST API: one item per endpoint (HTTP method and path). No exception, not even for endpoints that share a presenter. Put the shared rules and contracts in a shared material, and name each item in its `applies_to`.
- Batch processing: one item per job or task. A migration: one item per independently executable unit.
- Routing and settings are part of the endpoint's item. Extending an existing endpoint's auth scope or adding a field is a change of that endpoint, not a new item. Settings and master management of an admin screen are an admin-screen item, not an API endpoint item.

Frontend:

- A screen is a page, route or tab template, and it is not a unit in itself: apply the unit rule to the changes. One screen's changes may span several items, and one item may change several screens.
- Never bundle edits across repositories, across actors, or across operation flows. An operation flow is the set of screens a user of one actor moves between, through in-app transitions, to finish one task. Take its members from the screen-transition flow of the UI reference, else from the navigation in the existing code. Screens of one actor that no in-app transition connects are separate flows. This bound outranks the unit rule: a move across it becomes an adding item and a removing item that depends on it.
- A new modal or dialog goes with the behavior it serves, and is an item of its own only when a requirement names the modal itself as a deliverable.
- Handwritten changes to a package shared across screens, to common components, and a new component, hook or modal that several items need, are a `前提改修` item (below).
- Importing another repository's contract into this repository's copy and generated types is not an item when running the project's own generation command finishes it with no handwritten code. Put it in `scope.includes` of the consuming item. When several consuming items in the repository need the same import, put it in exactly one of them and make the others depend on it.

`前提改修`:

- One that meets both conditions of the unit rule is an item of its own, and the items that need a derived one depend on it.
- A derived one that fails either condition goes in the `scope.includes` of an item that derives it. When several items derive it, put it in exactly one and make the others depend on that item.
- An independent one comes only from an approved structural improvement ([below](#structural-improvements)).

### API contracts

An item that adds or changes an endpoint records the request and response contract (fields, types, requiredness, HTTP statuses) at the level of policy, in the providing side's feature item. A contract that several repositories rely on is not an item of its own, because the backend is implemented first. The consuming item depends on the providing item, with the reason in `depends_on`.
Where the contract is the source of truth depends on the project. Judge from the existing code, the references of the implementation and the CI and task definitions whether it generates a contract artifact from a schema definition (OpenAPI generation and the like).

- With a generation base: the generated artifact is the source of truth. The providing item's `scope.includes` holds the schema definition and the regeneration. A shared material holds only where the contract is and the design judgments about it, and restates no field, type, requiredness, status or error code.
- Without one: write the contract in an own material of the item (`extra_materials`, topic `api-contract`) when it is closed in that item, otherwise in a shared material.
- Never write it in `approach`, which only refers to the material.

`scope.api_contract` is a backward-compatible addition only when an existing endpoint gains an optional request parameter or a response field. Every other change is not: a new endpoint, a new required parameter, a changed type or requiredness, a deleted or renamed field, changed enum values, statuses or error codes. Judge from the kinds of change the contract records, not from the label or the size.

### Dependencies

- Collect the dependencies between components that the investigation found, the preconditions between items (authentication before the rest, a `前提改修` before a feature) and the dependencies between data models.
- Record each dependency and its reason in the depending item's `depends_on`. The implementations are derived from this graph ([7-implementations](7-implementations.md)): the items of one repository that do not depend on each other fall in one stage and are implemented together.
- For each existing symbol or file an item deletes, moves or renames (its specification and generated types included), take its referrers from the inbound scan. Within one release, an item cannot depend on an item of a repository that is later in `implementation_order`. When a referrer sits in a later repository, put the deletion in a later release, or leave it to a later case when the design reaches production in one release.

### Staged releases

Applies when the code reaches production in more than one release: an item that must be in production before another (a prerequisite before its feature, a providing repository before its consumer), or a release constraint that the requirement's operations expectation states. A feature-flagged rollout whose code ships in one release is not staged: write its flag switch in the `deployment` material only.

- Write `release` (from 1) on every item, or on none when the design reaches production in one release.
- A `前提改修` that a feature needs in production first is in an earlier release than the feature. A `機能` item goes in the last release its dependencies allow.
- Write in the `deployment` material only what `release` cannot hold: why the releases are split, and how each release reaches production beyond its merge (a flag switch, a migration run). A `depends_on` reason refers to the release there.
- Whether to split the releases, and how, is settled first by [fact or value](#fact-or-value). A value answer is a `decisions` element of `deployment`, and the `release` fields follow it.
- This flow orders the implementations by `implementation_order` and stage ([7-implementations](7-implementations.md)). A release changes the stage inside a repository, but it cannot put one repository's later release before another repository's earlier one. When the design needs that, say so in a `decisions` element of `deployment` and tell the leader in your `DONE` summary.

## Branch points and decisions

A branch point is a place where the design chooses between ways: where a DB constraint is held, the form of a deliverable, the data-model approach, the granularity of a job.

- Never skip a branch point with "not applicable", "reuse the existing" or "nothing special". Leave at least one line of grounds, the alternatives and the trade-offs. An item with a branch point has `key_decisions`.
- When an unknown comes up while you write, write it as a `decisions` element (options and a recommendation) and finish the design. Do not stop.
- Every `decisions` element has `impact`: every matching category of `単一 DESIGN 内` (the adoption completes inside the item), `複数 DESIGN 横断` (it reaches other items of the design, shared premises, naming or dependencies), `他リポジトリ波及` (it needs changes in another repository) and `運用・移行・データ整合性影響あり` (it migrates data, changes an operation or touches existing users), with the widest first: `運用・移行・データ整合性影響あり` or `他リポジトリ波及` when either matches, else `複数 DESIGN 横断`, else `単一 DESIGN 内`. Leaving it out is a major defect.
- `recommended` is the key of the option you recommend (`A` is the first option). The reviewers file the decision for the owner, or not, from it.
- An unavailable input: for a behavior that branches on a value obtained at run time over the network or asynchronously (a response a screen fetches, the answer of an external service, a setting loaded after the screen is shown), the value has arrived, has not arrived yet, or failed to arrive. State as `acceptance` elements of the owning item what the user or the caller gets while it has not arrived and when obtaining it failed, one element per state. Taking the branch of one of the value's own cases in such a state (reading "not known yet" as `false`, as an empty list, as the default) is a behavior to state like any other. Where neither the requirement nor the UI reference settles a state, it is a branch point: a `decisions` element whose options name what the user can do (wait with the operation blocked, go on under a stated default, see the failure and retry). A statement that the value has already arrived holds only where the cited code makes the branch wait for it. A prefetch, a cache or an earlier fetch does not make it hold: ground it in `key_decisions` with the `path:line` that makes the branch wait. Listing a state in `scope.excludes` does not state its behavior.
- A background job (periodic, polling, batch) states as `decisions` its granularity (batch unit or entity unit), parallelism (concurrency and queue limit), scalability (volume per partition and the concerns) and its extraction policy (full scan or targets only). When a shared material already holds one of them for several items, the item refers to it. A default of "reuse the existing job" still checks that the precedent fits this case's scale and granularity, and leaves the grounds.
- Shared-resource contention: when an item takes a shared resource (a row, a cache key, an external resource) by a lock, an isolation level or mutual exclusion, investigate every other path (job, batch, another API, another service) that takes it, and tabulate for each its hold time, whether it does external I/O while holding, and its behavior on a wait timeout. The table is evidence for `technical-notes.md`. The design, in the owning item or in the `risk-analysis` material, states the conclusion and, where there is a risk of leaks on long holds, of I/O while holding, or of timeouts, the policy for catching, retrying and falling back.
- Personal data in logs: when an item introduces a free-text field or a personal-data candidate (medical information, name, email address, address, free memo), or changes how an existing field is exposed, analyze all of: (a) access and exception logs through the application logger, (b) structured access logs that emit request parameters and response bodies by themselves, (c) the fields sent to an error-tracking service, (d) direct embedding in audit and business logs, (e) how complete the mask and exclusion settings on those paths are. The per-path analysis stays in `technical-notes.md`. The design states only the conclusion and the policy, under the heading `### ログ・観測経路への PII 露出` of the `risk-analysis` material (or of an own material of the item when the risk is closed in it). Write nothing for an item that introduces no candidate.
- Rare matters: a value-judgment matter whose likelihood is rare and unmeasured, whose recommendation is narrowed to one option and whose harm can be repaired afterwards is not put to the owner. Write the default handling and the limitation under the heading `### 既知の制限` of the `risk-analysis` material (or of an own material of the owning item). A matter recorded there is not filed again. When the harm cannot be repaired afterwards, it stays a decision for the owner.
- Root-policy redesign: when the incremental approach (following existing patterns, adding columns, extending existing components) is clearly worse on performance, maintenance cost or technical debt, and a full redesign on another architecture is sound, state it as a `decisions` element (the incremental plan against the redesign) with a recommendation, the trade-offs and the impact. Never drop it because "it works". A redesign usually reaches `運用・移行・データ整合性影響あり` and `複数 DESIGN 横断`.

### Fact or value

For each branch, ask what decides it.

- Fact-settled: a primary source decides it (an existing convention, an implementation, a reference path, a data volume, a measurement, an official specification). Index necessity, column types and NULL constraints, N+1 avoidance and consistency with existing patterns are of this kind. Settle it yourself, and write the rationale in `key_decisions` with one `path:line`. A fact-settled branch with no rationale written, or left as a set of options, is a defect: settle it by investigating it yourself, never by asking the owner. When you cannot tell whether the sources can settle it, treat it as fact-settled and investigate more.
- Value judgment: facts do not settle it even after an exhaustive investigation. It depends on product or operational policy, cost tolerance, priority or acceptable user impact (migration timing, accepting incompatibility for existing users, the size of a staged release). It is a `decisions` element, and the reviewers file it for the owner by this rule: a recommendation that is not narrowed to one option is always filed; a narrowed one is filed when its impact reaches other items, other repositories, operations, migration or data integrity, and is not filed when its impact is only `単一 DESIGN 内`.
- A branch that adopts a UI differing from the UI reference, or settles a discrepancy inside it toward one side, is a value judgment and is always filed, whatever the impact, unless a decision of the owner or a passage of the request states the departure.
- When one branch has both kinds (facts narrow it to two options, and policy picks one), settle the fact part by investigation and keep only the value part as the branch.
- A rejection that rests on the requirement ("this option contradicts REQ-02") cites the requirement item and the source that requirement statement cites (the request, a user decision, the UI reference, or a fact of the existing code). A rejection whose requirement cites no source is not settled by inference: it is fact-settled without evidence. Close it by recording the source, or by judging the branch again without that requirement.
- Not for the owner, whatever the wording: cross-document references (drifted lines, ids that do not exist, wording of terms), consistency with a rule already stated, and maintenance matters where any of several rewrites resolves it. Those are defects, which you fix.

## Branches only execution can settle

A branch qualifies when, after the investigation, two or more ways of building the same behavior remain, and one sentence names the observation that separates them (speed, behavior, timing, or what a library does). Appearance, wording, screen operation, the reading of a requirement and what policy decides do not qualify.

Do not decide such a branch by reading alone, and do not run an experiment in the product code. Write its observation as the `execution_probe` of the open question ([2-investigation](2-investigation.md), steps 6 and 7), and `feature-dev:design-prototyper` runs a minimal version of each option in a disposable worktree and returns a verdict (`adopted`, `no-difference` or `inconclusive`) with its evidence under `prototypes/{slug}/` of the case root. A branch that the comparison settles (`adopted` or `no-difference`) is settled without asking the owner, and its `key_decisions` cites the `result.md` of the prototype. A branch that stays `inconclusive` is put to the owner as an open question ([3-open-questions](3-open-questions.md)), with what was run in `background`.

## Promises to verify formally

An item carries a `formal_verification` element for a promise when both hold: breaking it harms the user, and tests hardly reach it (concurrency, retry, state transition, a parser, unsafe code).
Each element states `property` (the promise), `harm` (what breaks for the user), `target` (the code that holds the promise, which must be inside that item's scope) and `bound` (the limit the check is assumed to cover).
The element only selects what is to be checked. The check runs after the implementation.

## Data model

- Guarantee uniqueness and integrity with database constraints wherever it is technically possible, and do not rely on validation in the application alone. When a constraint is infeasible, write the reason and the alternative in the design. Use NULL only for "absent" or "not set". A domain state that carries a meaning ("either", "all") gets an explicit value, and an existing master value or enum member is reused when one fits.
- For a change that adds or changes a constraint (unique, not null, foreign key, check), cross-check it against the project's own data-model conventions each time (the model passages of `AGENTS.md`, `CLAUDE.md`, `.claude/rules/`, `docs/` guidelines). When you apply them, reflect them in the design. When you do not, write "the reason the convention does not apply" there. "Not applicable" alone is forbidden.
- An item that adds a column to a table that already holds rows covers the initial values of the existing data, in a data migration item. Adding the foreign key of a `belongs_to` association often needs existing records attached.
- Before a new table, consider whether columns on an existing table can do the job, and state the adoption reason at the destination. When the state maps one to one onto a row of an existing table, state both ways as options of one `decisions` element, and write the constraints of the column approach (logical deletion, unique constraints, a generated column, the range a constraint covers) as option trade-offs. When a new table has no clearly superior ground, recommend the columns.
- Before a new column on a table that already holds rows, check whether an existing column can carry the meaning: list every write path to the candidate column and settle from the assigning expression at `path:line` what each stores. State the adoption reason as "the existing column does not satisfy it" with the write paths as grounds, or "the existing column satisfies it, so nothing is added".
- The data model goes in the `data-model` shared material: tables, columns, types, constraints, the meaning of NULL, and the item that owns each migration.

## Inbound impact

- Enumerate every referrer of the symbols, files and endpoints that an item modifies, into the `inbound-impact` appendix. Also: when a modification changes where a response field comes from or how it is computed, add that field name as a starting point and enumerate every path that returns it (the path that revises the logic and the path that assembles the value, such as a presenter, serializer or view, need not coincide). For a model or a table, enumerate its associations (`has_many`, `has_one`, `belongs_to`, `through:`) and follow them to the places that read through them. Check whether those associations carry a logical-deletion scope. When they do not, record that the value is still read after logical deletion.
- Scan more than controllers, services and models: jobs, scheduled tasks, seed files, API schema definitions and tests too.
- For each reference, record `path:line`, how it refers, and the blast radius (a code change is needed, a behavior changes, the scope is crossed). A modification target with no hit is not listed among the referrers: write it as a case with no result, with the search patterns used. Never omit it silently.
- A referrer that needs a change is in the `scope.includes` of some item, and a file that several items touch is listed in each. The binding conclusions per item (a code change is required, and so on) go in that item or in a shared material, not only in the appendix.
- API schema consistency: take into account the schema of the other endpoints of the same resource. When the existing schema and the implementation differ, reflect it in the design. When a change touches the output fields or the request parameters of a presenter, controller or model, enumerate the updates to the schema definitions of the API documentation (`properties` and `required`) among the impacts. Do not duplicate the contract's content here ([API contracts](#api-contracts)).

## Existing code and conventions

- Follow the project's conventions where its references (rules, skills, convention documents) define patterns or naming. Where they do not, inherit the patterns of the existing code. The conventions are canonical: an existing pattern is one instance of applying them, and a pattern that violates them may have stuck.
- For a decision about naming, file placement or layer responsibility, cross-check the conventions first and the existing pattern second. When a new design still follows an existing pattern that contradicts the conventions, write the grounds in that item's `key_decisions`. Name new components with paths and class names that follow the placement the conventions prescribe.
- At every layer, first consider whether an existing component can cover the need, and create a new one only after judging reuse impossible. Do not miss the case an extension of an existing endpoint's scope covers.
- Before you specify a new external dependency, check in order whether the language's standard library, a feature of the platform (a database constraint, a framework built-in) or an already installed dependency covers it. When a new one is still needed, write the grounds in the `tech-stack` material.
- When a component of the existing code is a reuse candidate for an element of a screen in the UI reference, open the screenshot that shows the element. Read the component together with every style that reaches it (its own, the parent layout, the global and reset stylesheets). For each element record, with `path:line`, whether the component as it is renders what the screenshot and the recorded values show (alignment, width, wrapping and truncation with long strings, spacing, colors, fonts), and name each gap. Settle here whether a reused component needs a change. How to change it is left to the implementation.
- When you concretely describe the form of a deliverable of a component (template, builder, service, job class), investigate several implementations of the same kind and adopt the dominant pattern. Where the precedents split, or the pattern cannot be asserted, write that the form is left to the implementation stage.
- A decision (especially one for the owner) that depends on how another repository behaves (the frontend, another backend, another service: its data interpretation, UI conventions, input and output contracts) rests on a premise investigated now, not deferred to the implementation. Before you file a decision as "cannot be told apart" or "cannot be judged", check that the other repository's existing behavior or operation has not already resolved it. Leave the result as a short reference in that item's `key_decisions`.
- Write a statement about existing code, a path, a line or a count only after you confirmed it in the artifact. Open the cited file and check that the cited lines hold what the sentence claims: the line number printed by a search is not a ground. For a range, check both ends. When a claim rests on a count of hits, run the command again, check the count, and write the command beside the claim.

## Structural improvements

The ledger `structural_improvements` records requirement-independent structural refactoring (code smells, technical debt) that the code investigation found next to the region the design touches.

- Altitude: only the design altitude (file and module splits, responsibility placement, layer violations, god classes, cyclic dependencies, excessive coupling). Never an in-method smell: those are for the code review after the implementation.
- Detection viewpoints (`viewpoint`): `神クラス`, `モジュール間重複`, `レイヤ違反`, `循環依存`, `過度な密結合`.
- File only a proposal that meets all of: (a) design altitude; (b) it is next to the region the current requirement or an item touches (never an inventory of the whole code base); (c) it has concrete evidence, one `path:line` per element, with the grounds of the structural problem, and no large number of low-importance findings; (d) it is not already rejected or held in the existing ledger, unless the conditions changed (new structural grounds).
- Minimum criteria of a refactoring: behavior preservation is the premise (inputs, outputs and side effects stay equivalent); migration can be staged (not a bulk rewrite); the impact stays inside the four settled scope items. When it exceeds them, it is a decision for the owner.
- A new row is `発議中`. The owner decides on the approval page ([6-approval](6-approval.md)). An approved row is `承認`, and its `disposition.design` names the independent `前提改修` item it became (added to `designs[]` as a complete element with `requirements` `[]`, with `acceptance` and `test_policy` written, and `implementation_order` extended when its repository is new). A rejected or held row records the reason, which keeps it from being filed again unless the conditions change.
- A proposal that matches a viewpoint goes through this ledger. Other room for improvement in the design is a recommendation of the review, not a row.

## Writing the Japanese text

The texts of the deliverable are Japanese.
Polish them as [deliverable-writing](../shared/deliverable-writing.md) says, all the texts of one step in one run.

- Say the point first, one point to a sentence, and name who acts. Use the literal word, not a metaphor.
- Call one thing by one name through the whole file (a table, a column, a class, a design item). Do not let two spellings stand for one concept.
- Do not leave stray markup or machine-like filler in a text.
- A Markdown field is GitHub-flavored Markdown. Use ATX headings (`#`, one space, the text) and `1.` for ordered lists, and keep a heading short.

## Propagation check

On a correction, confirm the blast radius beyond the corrected node.

1. First re-verify every statement about existing code, existing specifications or existing behavior that the item holding the corrected node makes, against primary sources, even when no finding names it.
2. Then check these nodes, where they exist, by reading them with `jq`:
   - Document level: `requirement_summary`, `purposes`, `scope`, `implementation_order`, `structural_improvements`.
   - The item: `approach`, `ui_spec`, `scope.includes`, `acceptance`, `test_policy`, `user_confirmations`, `decisions[].impact`, its related materials.
   - A shared material: `applies_to` and the body (data model, common components, risk analysis).
   - An appendix: the aggregates derived from `scope.includes`, and the list of referrers of the inbound scan.
3. By kind of correction:
   - A fact about an existing specification (a class, a parameter) is corrected in every node that cites it: the summary, the item, every shared material that rests on the same premise. Two nodes that cite the same fact as grounds must not disagree.
   - A dependency added or removed: `depends_on` of the item, `implementation_order` when it crosses repositories, and every `approach` and `scope.includes` that describes the order.
   - A file added or removed from the impact: `scope.includes` and `acceptance` of the item and every aggregate derived from them.
   - A data type, a column name or a constant settled: every place that uses the same identifier, the data model included.
   - An item added: the requirements it takes over, the `depends_on` of the items that use it, the `applies_to` of the shared materials, and `implementation_order` when its repository is new or a repository loses its last item.
   - A shared material whose range changed: its `applies_to` and the `inapplicable_materials` of every item it stops or starts applying to.
   - Responsibility moved: every node on both sides that describes who owns it.
4. Correct what you find in the same round, in one batch.
5. When the corrected rule or fact is written in two or more nodes, correcting each copy does not finish the fix. Make one canonical copy where the placement rules put it (a shared material when several items rely on it, else the one item that owns it) and replace each other copy with a reference to it. Moving the canonical copy into a shared material, deleting a statement and putting a reference in its place, and the `applies_to` and `inapplicable_materials` edits they need are part of the fix.
6. For every `path:line` of the corrected item, run the check of [Existing code and conventions](#existing-code-and-conventions): the last bullet.
