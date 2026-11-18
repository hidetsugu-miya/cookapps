# Specification conventions

The rules for where a specification goes, how it is written, which template it follows, and how it is checked.
This file is the one source: Stage 1, Stage 2 and Stage 3 apply it, and nothing else overrides it.

## Where the specification goes

### Step 1: The placement root

Settle `{specRoot}`, the directory the specifications are placed in (no trailing slash).
Take the first of these that decides, and do not look at the later ones:

1. **The repository's own statement.** When its `AGENTS.md` or `CLAUDE.md` says where specifications go, follow it. It may point at another repository's directory (for example, all feature specifications are gathered in a sibling repository's `docs/features/`, and no `docs/specs/` is kept here). Then `{spec repo}` is that repository, and `{specRoot}` is the path relative to its root.
2. **The form `docs/` already uses.** Under the repository's `docs/`, look at the existing specifications. If they are gathered under `docs/specs/`, `{specRoot}` is `docs/specs`. If each feature has its own directory (an `index.md` or more directly under `docs/{feature}/`), the form is `docs/{feature}/`, and `{specRoot}` is the feature directory that matches this case's feature, which Stage 2 settles after it has read the deliverables.
3. **The default**: `docs/specs`.

Everything below is relative to `{specRoot}`.

### Steps 2 to 5: The files

These steps are applied in Stage 2, after the deliverables are read, once for each domain the case spans.

2. List the existing `.md` specifications under `{specRoot}`. Under the form `docs/{feature}/`, list across the feature directories of the domains that may be related.
3. Read the overview of each (from the top to about line 50) and judge whether it relates to this feature. It does when it handles the same domain: it shares a table (model), a controller, the main group of services, or a foundation such as a notification channel. Do not judge on "the core of the feature is the same" alone.
4. Count: the related existing specifications, plus one for the specification you add.
5. Decide the place:
   - **Case A: the count is 1** (no related specification). Create a new file directly under `{specRoot}`, named in kebab-case after the feature's content (`{specRoot}/xxx.md`).
   - **Case B: the count is 2 or more.** Always weigh subdirectory hierarchization. Choose one of these by their criteria, and keep the choice and its grounds for the report:
     - **standalone**: a separate file next to the existing one. Only when the feature leaves the natural scope of the existing specification.
     - **merge**: extend the existing specification and cross-reference from the others. When the existing scope can be extended, the relation is principal and subordinate (a principal API with its derived APIs), or one file can hold it with cross-references.
     - **subdir-index**: restructure `{specRoot}/{domain}.md` into the main specification plus an index of related specifications, and store the related ones under `{specRoot}/{domain}/xxx.md`. When a core specification of the domain exists (what the others commonly presuppose), the parent file keeps it and adds an index at its end (hybrid). When none exists, the parent file holds only the scope of the domain and a table of contents (pure index).

## What to write

- The feature's **What** (what it can do) and **Why** (the business reason).
- User flows. Use a Mermaid sequence diagram when several actors are involved: the request and response between actors, with the detail in the body.
- State transitions of persisted business state, as a concise Mermaid state diagram: states and transitions only, with conditions and names of jobs and services in the body. A temporary switch of a screen (a selection mode, an open or closed panel) is not a state transition: explain it in the body.
- Entry-point file paths (controller, application service).
- Related specifications: those of the same repository, and those of a sibling repository, written as `{repository name}: {path from its root}` and not as a URL.

## What not to write

Omit a section that does not apply. Leave the following to their canonical source:

- Validation details (type, range, normalization): the code defines them.
- Tables of request parameters, and the JSON of requests and responses: the code and the API schema define them.
- Data models (tables, columns, indexes, associations): the schema and the models.
- File paths other than the entry points.
- How: SQL idioms and implementation steps. Magic numbers such as an upper limit of 200: keep the What and Why, and leave the value to the code.
- Error-case details (status codes, error codes).
- Code fragments.
- History and change logs. Integrate feedback as if the specification had been defined so from the start.
- URLs of external services, issue keys and pull request numbers. They expire; the git history keeps the implementation history.
- Figma URLs, file ids and node ids. Write only the Figma file name (for example `**Figma**: 予約・問診`), and write the UI specification itself (wording, display format) in the body.

## Template

The structure is [template.md](template.md). It is a guideline: omit the sections that do not apply.
The specification is in Japanese, as the template is, unless the repository's existing specifications are in another language: then write in theirs.
The text is plain GitHub-flavored Markdown. Mermaid blocks stay as fenced `mermaid` blocks in the file: GitHub draws them, and no image is made.

## Check perspectives

Stage 3 checks the written specification against these, and nothing else is a defect.

- **terminology-inconsistency**: several notations for one concept (for example 「ユーザー」 and 「利用者」, 「削除」 and 「除去」, or column and class names written two ways).
- **factual-error**: a description that contradicts the design, the requirement or the code, or names an endpoint, a data item or a screen that does not exist.
- **granularity-violation**: something of "What not to write" is mixed in, or a description is too coarse to be a specification (「適切に処理する」).
- **separation-violation**: several independent specifications mixed into one item, or one specification scattered in several places.
- **missing-content**: an item of "What to write" is missing, or something settled in `design.json` or `requirement.json` is not reflected. The absence of something of "What not to write" is not missing content.
- **template-noncompliance**: structure, heading levels or numbering that depart from the template.
- **cross-reference-inconsistency**: a broken link, a reference to a REQ, DESIGN item or UD that does not exist, an entry-point path or a related-specification reference that does not exist, or a divergence from the design.
- **ambiguous-expression**: a wording such as 「〜関連」「〜等」 that the code or the design can make concrete.
- **file-structure-choice**: under Case B, the chosen option contradicts the criteria the options state.

Do not raise as defects: a suggestion to improve the wording, to cut redundancy or to say a thing another way; and a document form (the table format, the section structure, the level of detail of a table of related code) that most or all of the existing specifications adopt. A factual error, a broken reference and terminology drift are defects even then.
