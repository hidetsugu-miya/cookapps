# Stage 2: Investigation

Investigate the code, the conventions and the earlier decisions that the design stands on.
Write what you find in `technical-notes.md`, settle what facts settle, and keep a list of what they do not settle.
You write no `design.json` here, and you ask the owner nothing.

Read [rules](rules.md) first: its sections say what each perspective looks for.

## How to investigate

- Investigate every perspective yourself, read only, in the repositories (`{repo root}`) and the deliverables. Do not hand a whole perspective to another agent.
- Send questions about code facts to `feature-dev:code-explore`: where a file or a symbol lives, its callers, similar implementations, what given lines hold. Launch one for each question that does not depend on another's answer, all in one message. Collect a fact yourself with `rg` and `Read` only when it depends on an earlier answer or is one lookup. Give it the question, the repository root and the range, and nothing else. It judges nothing.
- `Read` every `path:line` that `code-explore` returns before you use it. Run a count it returns again, with the pattern and the range it states, and write the command with the claim.
- Bind every claim you adopt to a `{path}:{line}` that you confirmed by reading: open the file and check that the cited lines hold what the sentence says. The line number printed by a search is not a ground. For a range, check both ends. For a claim about `requirement.json` or `design.json`, use `{file}#{doc path}`. Confirm that an existing symbol exists before you cite it.
- Do not adopt a claim that contradicts a primary source. When a claim contradicts a conclusion that the requirement stage recorded in `technical-notes.md`, adopt neither: read the contradicted place again at the cited location, and record the conclusion that holds with its `path:line`.
- A range you could not scan goes on the list of unscanned ranges, with the perspective it affects and the reason.
- Do not read the same file twice in this stage. Keep what you read.

### Reusing confirmed facts

`code-facts-base.json`, beside `technical-notes.md`, maps the absolute root of each repository to `{"commits": [...], "unclean_paths": [...]}`. The requirement unit wrote it. `creator-facts.md` beside it holds one entry per fact (`{root}` `{path}:{line}` `{commit}`, then the excerpt line).
You may take a cited `path:line` without reading it again when:

- it is from `technical-notes.md`, its path is not in that repository's `unclean_paths`, and `git -C {root} diff --quiet {commit} -- {path}` exits 0 for every commit of that repository's `commits`;
- it is from `creator-facts.md`, and `git -C {root} diff --quiet {entry commit} -- {path}` exits 0.

On any other result, read that file again.
A fact is reusable only when `git -C {root} ls-files --error-unmatch -- {path}` succeeded and `git -C {root} status --porcelain -- {path}` printed nothing when you confirmed it.
When you write the notes (below), append `git -C {root} rev-parse HEAD` to the `commits` of each repository you investigated, and the repository-relative path of every fact of this write that is not reusable to its `unclean_paths`, each once. Never remove or rewrite an element.

## Steps

### 1. Read the inputs

- `requirement.json`: by `jq` ([deliverable-writing](../shared/deliverable-writing.md), "Read"), the nodes this stage needs. Not the whole file.
- `design.json`, when it exists: its nodes, one by one. Read its `structural_improvements` ledger: the proposals already rejected or held, and their reasons, are decided and are not filed again. Write them in the notes ("Settled earlier").
- `{docs worktree}/docs/adr/`, when it exists: take every record whose frontmatter says `status: Accepted` as a constraint and a premise. Note its path and the constraint it puts on the design.
- The notes the requirement stage wrote, and the UI reference (`ui-references/`, read as images with `Read`).

### 2. Find the conventions

Conventions are canonical. An existing pattern in the code is one instance of applying them, and a pattern that breaks them may have stuck.

1. Enumerate the paths of the files the design will create or change, relative to the repository root: the layers it affects (controllers, services, models, migrations, screens, components), the files that do not exist yet included. Match them lexically: a directory plus an extension that matches a convention's glob is enough. Do not narrow on the premise of a name that is not settled, because naming is what the conventions judge. For an existing design, add the files of each item's `scope.includes`.
2. In each target repository, find the documents that hold conventions: `AGENTS.md`, `CLAUDE.md`, `.claude/rules/`, `CONTRIBUTING*`, and the guideline documents of `docs/`. A rule file whose front matter limits it to path globs applies when a candidate path matches. A document with no such limit applies to all.
3. `Read` the ones that apply. When a repository has a `.claude/rules/` folder and none applies, the enumeration of paths was too coarse: widen it. A repository with no rule documents has no conventions: skip the cross-check for it.
4. Keep them for the cross-check of step 4.

### 3. Investigate each perspective

Take these eight perspectives one at a time. For each, apply the sections of [rules](rules.md) named, on the targets named.

| Perspective | What to find | Sections of [rules](rules.md) |
| --- | --- | --- |
| Requirement traceability | How each requirement breaks into items. The repositories in scope. Where the consumer code of a related API couples with the target. The UI reference of each screen. | Traceability and scope; UI specifications |
| Design granularity | The units a change splits into, the kinds of item, the endpoints, jobs and migrations, the operation flows of the screens, the contracts and where they are recorded, the dependencies and the need for staged releases. | Granularity; Dependencies; Staged releases |
| Structure | What is already in `design.json` (a revision), the placement of each piece of content, the notation used in the existing deliverables. | Where each piece goes; The fields |
| Layer separation | The branch points of the design: where a constraint is held, the form of a deliverable, the data-model approach, the granularity of a job. For each, the grounds and the alternatives. | Branch points and decisions |
| Existing code | The components, interfaces and data the design may reuse or extend. The patterns for each layer. The implementations of the same kind (for the form of a deliverable). The behavior of other repositories that a decision rests on. Whether a standard library, a platform feature or an installed dependency covers a need. | Existing code and conventions |
| Inbound impact | Every referrer of what the design modifies, with how it refers and the blast radius. The scan has no hit for a target: record the patterns. | Inbound impact |
| Data model | The existing tables, columns and constraints, the conventions for constraints, write paths to candidate columns, whether data must be migrated. | Data model |
| Risk and restructure | Jobs and their decisions, shared-resource contention, personal data in logs and observation paths, the unavailable inputs of a branch, promises to check formally, candidates for structural improvement. | Branch points and decisions; Promises to verify formally; Structural improvements |

For the inbound scan, there is no graph tool for you: list the symbols, files and endpoints of the candidate paths, and search each one in every form (definition, import, call, string reference, test, configuration) with `code-explore` and `rg`.

For each perspective keep the facts with their evidence, and the range you could not scan.

### 4. Check across perspectives

When two perspectives disagree, read the cited ranges again, keep the conclusion that the primary sources support, and drop the other.
Then cross-check the implementation patterns that the existing-code perspective collected against the text of the conventions from step 2: which passage applies, whether the existing code conforms, and the fact of any contradiction. Record the result in the existing-code perspective of the notes. A new design that still follows an existing pattern that contradicts the conventions needs its grounds in that item's `key_decisions` (stage 4).

### 5. Settle what facts settle

Apply "Fact or value" of [rules](rules.md) to each branch you found.

- A fact-settled branch is settled: record the adopted option with its evidence (`path:line`) in the notes. A branch that one of the filing conditions or granularity criteria of [rules](rules.md) settles without condition is fact-settled. Where two perspectives read the applicability of a rule differently, decide from the text of the rule and record the decision and its grounds. A branch whose recommendation would contradict such a rule is never put on the list.
- Settle every matter of `undecided matters` (stage 1) that the investigation can settle. Put the rest on the list.
- Take the three `{scope items}` as premises of everything you record.

### 6. List the open questions and the alternatives

**The open-question list.** It holds only the fact-decidable matters that the investigation could not settle. Do not number the entries. A value judgment is not here: one that would shift the skeleton of the design (the split into items, the data model, the API contract, the layer responsibility) is carried by the alternatives below, and one that does not is written by stage 4 as a `decisions` element, which the reviewers file for the owner when they must.

Each entry has:

- `title`: one plain line.
- `decision_kind`: `fact`.
- `background`: the range of primary sources you checked as `{path}:{line}` (`{file}#{doc path}` for a node of `requirement.json` or `design.json`), and why it did not settle the matter. Where the ground is whether a contract artifact (a generated API document and the like) differs, the range covers the generation input (the schema definition) and a precedent of the same shape. State whether the information that is needed lies outside every source you can reach (production data volume, an external contract).
- `options`: one option per line, with its trade-off, one to three lines each. Keep only the options that differ on the axis that decides.
- `recommendation`: one of the options. Never "undecided": when the investigation cannot narrow it, recommend what the evidence at hand favors. Before you write it, run at least one check that could overturn the premise it rests on. A check that can only confirm is not a check. When the check overturns the premise, rewrite `background` and `recommendation`.
- `recommendation_reason`: why, citing the trade-offs and the evidence, and, where it rests on a change or a comparison, naming what is changed and what it is compared with, so that it reads without the other fields.
- `binding_scope`: every applicable category of the four of `impact` ([rules](rules.md), "Branch points and decisions"), the widest first.
- `execution_probe`: the one sentence of the observation that separates the options when the matter is a branch only execution can settle ([rules](rules.md)), else `null`.

**The alternatives to the straightforward plan** (the skeleton alternatives). Settle them for the four axes: the split into items, the data model, the API contract and the layer responsibility. Judge every axis, including those no open matter touched. Write exactly these five entries, in this order (the labels are literals):

```markdown
- **Baseline**: {the straightforward approach in one line: extend the existing code where it exists}
- **Split into items**: alternative exists - {one line: what the alternative decides differently on this axis}
  - Baseline: {one line: what the baseline gains and gives up on this axis} (`{path}:{line}`)
  - Alternative: {one line: what the alternative gains and gives up on this axis} (`{path}:{line}`)
  - Execution comparison: {one sentence: the observation that separates the two; only when the axis is a branch only execution can settle}
- **Data model**: no alternative - {one line: why none exists} (`{path}:{line}`)
- **API contract**: ...
- **Layer responsibility**: ...
```

- The baseline is the approach the investigation points to with no alternative weighed: extending the existing components on every axis, or, where nothing exists to extend, what the established conventions dictate.
- "Alternative exists": a realistic alternative exists on the axis. Give at most one, the one that differs most from the baseline. Under it, give both trade-offs, one line each, each citing the primary source it rests on. When a trade-off turns on information outside every source you can reach (data volume, an external contract), name that information in place of the citation.
- "No alternative": none exists. The reason cites the primary source that forces the baseline: a convention, an accepted ADR, a filing condition of [rules](rules.md), or the requirement.
- A realistic alternative meets all of these: it satisfies every requirement without adding a requirement, a screen or a behavior; it contradicts no binding convention, accepted ADR or filing condition; it differs from the baseline in the decision the axis makes, not only in naming.
- On a revision, the baseline is the approach already adopted in `design.json`. An alternative that `design.json` records as rejected is not entered again, unless this run found primary-source evidence that overturns the recorded reason. Cite that evidence in the entry.
- Every axis has one of the two marks. An axis with a missing entry or citation, an "alternative exists" without both trade-off lines, or an empty execution-comparison line is incomplete: put it on the list of unscanned ranges with the axis as the affected perspective and the missing piece as the reason.

**Turn the alternatives into questions.** For each "alternative exists" axis add one entry to the open-question list:

- `title`: names the decision of the axis. `options`: two lines, the baseline and the alternative, each with its trade-off line. `background`: the "alternative exists" line and every citation the trade-off lines carry. Name any information that a trade-off marks as outside every source. `execution_probe`: the axis's execution-comparison sentence, `null` without one.
- When the two trade-off lines narrow it to one option on the primary sources they cite: `decision_kind` is `fact`, `recommendation` is that option, and `recommendation_reason` names the trade-off line that decides it, with its citation. Run the overturning check on that ground. When the check overturns it, derive the recommendation again from what the check found.
- Otherwise (the decider lies outside every source you can reach, the options are evenly matched, or the decider is product or operational policy): `decision_kind` is `value`, `recommendation` is the option the evidence at hand favors (never "undecided"), and `recommendation_reason` states that ground and why the trade-off lines cannot narrow it further.

### 7. Compare what only execution can settle

Launch `feature-dev:design-prototyper` once for each open question whose `execution_probe` is not `null`, for the questions that do not depend on each other all in one message. A question whose observation concerns speed runs alone, after the others have returned, so that parallel runs do not disturb its measurement.
Give each launch these values:

- `observation`: the `execution_probe` sentence.
- `options`: the question's `options`, each with its label and one line on what it does.
- `baseline`: the baseline option of the skeleton alternatives for a `value` question, and the `recommendation` for a `fact` one.
- `repo_root`: the repository the branch's code lives in.
- `case_root`: `{case root}`.
- `slug`: a lowercase kebab-case name of the branch, with no `{case root}/prototypes/{slug}/result.md` yet.

The prototyper runs a minimal version of each option in a disposable worktree, changes no product code and no repository, and writes its evidence under `{case root}/prototypes/{slug}/`.
It returns one JSON object: `status`, `verdict` (`adopted`, `no-difference` or `inconclusive`), `adopted_option`, `reason` and `result_path`.

Handle each return:

- When the final message is not one parsable JSON object, take the verdict from `{case root}/prototypes/{slug}/result.md` when it states one. Otherwise launch once more with the same values.
- On `invalid-input`, correct the values as `reason` says and launch once more. When it comes back again, treat the branch as `inconclusive`.
- `Read` `result_path` before you rely on the verdict. An `adopted` or a `no-difference` whose `result.md` shows no observed result for each option is `inconclusive`.
- Keep the verdict and `adopted_option` with the question for [3-open-questions](3-open-questions.md), and add the `reason` and the `result_path` to its `background`. In stage 3 the verdicts `adopted` and `no-difference` settle the question (it is `compared`), and `inconclusive` leaves it for the owner.

Where a question has no `execution_probe`, nothing runs. Run nothing else, and never run an experiment in the product code yourself.

### 8. Write the notes

Write what you found to `{case root}/technical-notes.md`: create the file when it does not exist, and otherwise add one section and leave the rest as it is. Write it in English, like the rest of the file.
Add `code-facts-base.json` as described above.

```markdown
## Design investigation

### {perspective}

{{The facts and their evidence for each of the eight perspectives, one subsection each, with `path:line` for every claim. For the existing-code perspective, include the result of the convention cross-check. For the inbound-impact perspective, the scan trace.}}

### Settled earlier

{{The proposals of the ledger that were rejected or held and why. The accepted ADRs and the constraint each puts on the design. "none" when there is none.}}

### Settled by the investigation

{{Each branch the facts settled: the adopted option and its evidence.}}

### Overview of the existing components

{{The existing endpoints, services and screens the design touches.}}

### Skeleton alternatives

{{The five entries.}}

### Open questions

{{The list. "none" when it is empty.}}

### Unscanned ranges

{{The range, the perspective it affects and the reason, one entry each. "none" when there is none.}}
```

Replace a section of an earlier run of this stage in place.
Keep the shell commands of the counts next to their claims.

### 9. The outcome

The outcome is one of two.

- `completed`: no unscanned range remains. Keep the open-question list and the alternatives.
- `incomplete`: an unscanned range remains. Keep the list and the alternatives as far as the investigation reached, and the unscanned ranges. Do not stop. Go on with `completed`'s next step, hand the ranges to stage 4 as `investigation gaps` (it investigates each range itself before an affected perspective is used), and say the ranges in your `DONE` summary.

Then go to [3-open-questions](3-open-questions.md).
