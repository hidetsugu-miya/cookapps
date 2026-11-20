# requirement.json

`{case root}/requirement.json` is the requirement definition, and the source of truth for what the case must achieve.
This file is its schema: the fields, their types, the ids, and what the check enforces.
What to write in each field is the requirement procedure's business.
How to read, change and check the file is in [deliverable-writing](deliverable-writing.md).

## Types

- **md**: a GitHub-flavored Markdown string, or `null` while it is not written.
- **text**: a plain string, or `null` while it is not written.
- **enum**: one of the listed values, or `null` while it is not set.
- **bool**: `true` or `false`. A field with a bool type is optional: absent reads as `false`.
- Every key of every object is present. A key with no value yet holds `null` (a text, an md, an enum, a nullable object) or `[]` (an array). A key the schema does not define is refused. An array is never `null`. An element of an array of md or text is a string, never `null`.
- `null` in an md or text field means "not written", except for the fields marked **omittable**, where `null` means the section is left out and is a valid final value.
- Ids: `REQ-NN`, `UD-NN` have two digits from `01`, and three or more digits from `100` without a leading zero. A `topic` is lowercase kebab-case starting with a letter (`[a-z][a-z0-9]*(-[a-z0-9]+)*`). A screen id is a Figma node id (`37521:12057`) or a topic.

## The document

| Field | Type | Content |
| --- | --- | --- |
| `schema_version` | `1` | Always 1. |
| `kind` | `"requirement"` | The kind. |
| `background` | md, omittable | The background, for a new feature. Exactly one of `background` and `problem` is written, by the kind of change. |
| `problem` | md, omittable | The problem, for a bug fix. |
| `purpose` | md | The purpose. |
| `scope` | object | `in_scope` (md: the target, with the repositories the change touches, and the requested ones that are not involved, with why), `out_of_scope` (md, omittable), `design_scope` (object of md: `data_migration`, `api_contract`, `infrastructure`, the three items forwarded to the design). |
| `screens` | array, optional | The screens of the flow. Absent or empty when the requirement has no screen design. |
| `screen_flow` | array, optional | The requirement's flow, one row at a time. Absent or empty when there is none. |
| `requirements` | array of requirement, keyed by `id` | One element for each REQ, in development order. |
| `shared` | array of shared material, keyed by `topic` | Materials that several REQs share. |
| `appendices` | array of appendix, keyed by `topic` | Supplementary materials. |

An empty file to start from (the two optional arrays are left out):

```json
{"schema_version": 1, "kind": "requirement", "background": null, "problem": null, "purpose": null,
 "scope": {"in_scope": null, "out_of_scope": null, "design_scope": {"data_migration": null, "api_contract": null, "infrastructure": null}},
 "requirements": [], "shared": [], "appendices": []}
```

### requirement (`requirements[]`)

```json
{"id": "REQ-01", "name": null, "summary": null, "expected_behaviors": [], "user_decisions": [], "user_decision_refs": [], "related_appendices": [], "extra_materials": [], "inapplicable_materials": []}
```

| Field | Type | Content |
| --- | --- | --- |
| `id` | `REQ-NN` | The REQ. REQ ids run `REQ-01`, `REQ-02`, ... in array order. |
| `name` | text | The name. |
| `summary` | text | One to three lines. |
| `expected_behaviors` | array of md | The expected behavior, one element for each bullet. At least one. |
| `user_decisions` | array of user decision, keyed by `id` | The decisions this REQ alone owns. |
| `user_decision_refs` | array of `UD-NN` | The decisions owned by a shared material that bind this REQ. |
| `related_appendices` | array of `{topic, role}` | Appendices that apply. `topic` names an element of `appendices`, `role` (text) says what the appendix is for here. |
| `extra_materials` | array of own material, keyed by `topic` | Materials of this REQ alone. |
| `inapplicable_materials` | array of `{name, reason}` | Related materials that do not apply, with why. |

### user decision (`user_decisions[]` of a REQ or a shared material)

`{"id": "UD-01", "title": null, "body": null}`, and `provisional` (bool, optional) that is `true` while the decided content is put in place for now and waits for the business side to confirm it.

A decision is stored once, at its owner: a REQ owns the decision that binds it alone. A decision that binds several REQs belongs to a shared material, and each REQ it binds lists it in `user_decision_refs`.
UD numbers run `UD-01`, `UD-02`, ... over the whole document without gaps.

### own material (`extra_materials[]`)

`{"topic": "...", "name": null, "role": null, "body": null}`. `role` is the material's place in the related materials of its REQ.

### shared material (`shared[]`)

```json
{"topic": "...", "name": null, "summary": null, "applies_to": [], "body": null, "user_decisions": []}
```

`applies_to` is an array of `{id, role}`: `id` is a `REQ-NN`, `role` (text) is the material's place in that REQ. It is the only place where the link between a material and a REQ is stored.
`body` is the one canonical copy of the content, and is `null` only when the material owns at least one user decision.

### appendix (`appendices[]`)

`{"topic": "...", "name": null, "category": null, "summary": null, "body": null}`.
`category` is `補足`, `検算` or `調査整理`.
An appendix holds no final judgment that binds the requirements or the implementation.

### screens and the screen flow (optional)

A screen: `id` (screen id), `name`, `device`, `status` (`新規` / `変更` / `既存`), `image` (the path of its picture under `ui-references/`, relative to the case root, or `null`; the picture of a Figma screen is `ui-references/{node id with the colon written as a hyphen}.png`), `req_ids` (array of `REQ-NN`), `changes` (md or `null`).
A flow row: `kind` (`normal` or `branch`), `title`, `request_step` (`{quote, source}` for a `normal` row, `null` for a `branch` row), `condition` (md, for a `branch` row), `path` (array of `{screen, op, condition, handoff}`), `verdict` (`一致` / `不一致` for a `normal` row, `null` for a `branch` row).
`path[].screen` is a `screens[].id`, or `null` where the destination is not settled; `handoff` is optional.

## What the check enforces

Tier 1 is the schema: it blocks a write.
Tier 2 is completeness and cross references: it never blocks a write, so the file can be written item by item. The unit must reach zero tier-2 violations before it asks the owner to approve and before it is complete.

Tier 1:

- every key present and none unknown, the types above, the enums and the id forms,
- ids unique where they address: `id` within each keyed array, `UD-NN` over the whole document, `topic` over `shared` and `appendices` together, own materials' `topic` within their item,
- every `screen_flow[].path[].screen` that is not `null` is the `id` of a screen.

Tier 2:

- exactly one of `background` and `problem` is written, and an omittable text is `null` or really written, never blank,
- `purpose`, `scope.in_scope` and the three `design_scope` items are written,
- there is at least one REQ, and REQ ids run in order; UD ids run without gaps,
- each REQ has `name`, `summary` and at least one written `expected_behaviors` element, and every text of its decisions, own materials and `inapplicable_materials` is written,
- each `user_decision_refs` element is defined, not repeated, owned by a shared material (a decision a REQ owns is that REQ's alone), and that material applies to the REQ; each decision a shared material owns is listed by at least one REQ,
- a `UD-NN` cited in the prose of a REQ is owned by that REQ or in its `user_decision_refs`,
- each `related_appendices` topic names an appendix,
- the related materials of each REQ have at least one row (the shared materials that apply, `related_appendices`, `extra_materials`, `inapplicable_materials`),
- a shared material applies to at least two existing REQs, and its `body` is written, or is `null` when it owns a decision,
- an appendix has `name`, `summary`, `body` and a `category`,
- no text holds a template placeholder `{{...}}`.
