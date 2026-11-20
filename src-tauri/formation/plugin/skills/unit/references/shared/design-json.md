# design.json

`{case root}/design.json` is the basic design: the plan of the change as DESIGN items, which the implementations are derived from.
This file is its schema: the fields, types, ids and what the check enforces.
What to write in each field is the design procedure's business.
How to read, change and check the file is in [deliverable-writing](deliverable-writing.md).
The types (md, text, enum, bool, `null`, omittable) and the id forms are those of [requirement-json](requirement-json.md); `DESIGN-NN` and `SI-NN` follow the same two-digit rule as `REQ-NN`.

## The document

| Field | Type | Content |
| --- | --- | --- |
| `schema_version` | `1` | Always 1. |
| `kind` | `"design"` | The kind. |
| `requirement_summary` | md | A summary of the requirements. |
| `purposes` | array of `{name, description}` | The design's purposes, both texts. |
| `scope` | object | Four enums: `layer` (`バックエンドのみ` / `フロントエンドのみ` / `フルスタック`), `data_migration` (`要` / `不要` / `該当なし`), `api_contract` (`あり（破壊的）` / `あり（後方互換的な追加）` / `なし`), `infrastructure` (`既存範囲内` / `新規導入あり`). |
| `implementation_order` | array of text | The names of the repositories the DESIGN items target, the backend first. A DESIGN item depends only on DESIGN items of its own repository or of one earlier in this array. |
| `designs` | array of DESIGN, keyed by `id` | One element for each DESIGN item, in id order. |
| `structural_improvements` | array of ledger row, keyed by `id` | The structural improvements proposed. |
| `shared` | array of shared material, keyed by `topic` | Design materials that bind several DESIGN items. |
| `appendices` | array of appendix, keyed by `topic` | As in the requirement, but `category` is `集計`, `調査証跡` or `検算`. |

An empty file to start from:

```json
{"schema_version": 1, "kind": "design", "requirement_summary": null, "purposes": [],
 "scope": {"layer": null, "data_migration": null, "api_contract": null, "infrastructure": null},
 "implementation_order": [], "designs": [], "structural_improvements": [], "shared": [], "appendices": []}
```

### DESIGN item (`designs[]`)

```json
{"id": "DESIGN-01", "name": null, "kind": null, "repository": null, "requirements": [], "depends_on": [],
 "purpose": null, "approach": null, "ui_spec": null, "scope": {"includes": null, "excludes": null},
 "acceptance": [], "test_policy": null, "user_confirmations": [], "key_decisions": null, "decisions": [],
 "extra_materials": [], "inapplicable_materials": []}
```

| Field | Type | Content |
| --- | --- | --- |
| `id` | `DESIGN-NN` | The DESIGN item. Ids run `DESIGN-01`, ... in array order. |
| `name` | text | The name. |
| `kind` | enum | `機能` or `前提改修` (a change that other DESIGN items need, with no requirement of its own). |
| `repository` | text | Exactly one repository name. |
| `release` | positive integer, optional | The release the item reaches production in. Stage 7 of the design unit cuts the stages of a repository by it: an item is in a later stage than every item of the same repository of an earlier release. It does not order one repository against another. When one DESIGN item writes it, every one does, and the values run from 1 without a gap. A DESIGN item depends on none of a later release. |
| `requirements` | array of `REQ-NN` | The REQs this item realizes. The only place the trace from a REQ to a DESIGN is stored. Empty for a `前提改修`. |
| `depends_on` | array of `{id, reason}` | The DESIGN items this one depends on. `reason` is text. |
| `purpose`, `approach` | md | The purpose, and the approach. |
| `ui_spec` | md, omittable | The UI specification, for an item with a UI only. |
| `scope` | `{includes, excludes}` | Both md: what is in, with the files and paths (every file that several items touch is listed in each of them); what is out, with why. |
| `acceptance` | array of md | The completion conditions, one verifiable outcome for each element. At least one. What a screen shows (items, wording, values) is read from `ui_spec`, and not repeated here. |
| `test_policy` | enum | `tdd` or `direct`. |
| `user_confirmations` | array of `{screen_state, screenshot, state_setup}` | The screen states the owner confirms against a screenshot (`screenshot` is a path relative to the case root). `state_setup` is text or `null` when the screen shows the state on opening. Empty for an item with no `ui_spec`. |
| `operation_checks` | array, optional | `{acceptance, state_setup, steps, expected}`: operations performed on the real screen to confirm an `acceptance` element that involves a screen operation. `acceptance` equals one element of this item's `acceptance`; `steps` is an array of text. |
| `formal_verification` | array, optional | `{property, harm, target, bound}` (all text): promises that are checked formally after the implementation by `feature-dev:formal-verifier` (`target` is a repository-relative file or folder of the item's repository, which becomes the `target_paths` of the check's manifest; `bound` is the limit the check covers, in the words of the domain). |
| `key_decisions` | md | The reasoning: rationale, rejected alternatives, trade-offs. |
| `decisions` | array of decision | The options and recommendations of this item. |
| `extra_materials`, `inapplicable_materials` | as in the requirement | Materials of this item alone, and related materials that do not apply. |

### decision (`decisions[]` of a DESIGN item or a shared material)

```json
{"subject": null, "recommended": null, "reason": null, "options": [{"label": null, "description": null}], "impact": []}
```

- `recommended` is the key of an option: `A` for the first option, `B` for the second, and so on. The key is the option's position, and is not stored on the option.
- `options` has 2 to 26 elements. `label` is text, `description` is md (its traits, or why it is not adopted).
- `impact` lists every matching category of `単一 DESIGN 内`, `複数 DESIGN 横断`, `他リポジトリ波及`, `運用・移行・データ整合性影響あり`, with the widest first: `運用・移行・データ整合性影響あり` or `他リポジトリ波及` when either is listed, else `複数 DESIGN 横断`, else `単一 DESIGN 内`. At least one, none twice.

### ledger row (`structural_improvements[]`)

`id` (`SI-NN`, running in array order), `problem`, `viewpoint` (`神クラス` / `モジュール間重複` / `レイヤ違反` / `循環依存` / `過度な密結合`), `evidence` (array of text, one `path:line` for each element, at least one), `risk`, `policy`, `behavior_preservation`, `phased_migration` (`要` / `不要`), `severity` (`高` / `中` / `低`), and `disposition` = `{status, design, reason}`.
`status` is `発議中`, `承認`, `却下` or `保留`.
With `承認`, `design` is the independent `前提改修` DESIGN item it became (it has no REQ); with any other status it is `null`.
`reason` is required with `却下` and `保留`.

### shared material (`shared[]`)

`{"topic": "...", "name": null, "summary": null, "applies_to": [], "body": null, "decisions": []}`.
`applies_to` is an array of `{id, role}` with `id` a `DESIGN-NN`, and it is the only place where the link between a material and a DESIGN item is stored.
`body` is the one canonical copy of the content, and may be `null` when the material owns at least one decision.

## What the check enforces

Tier 1 is the schema, and it blocks a write. Tier 2 never blocks a write; the unit must reach zero tier-2 violations before it asks the owner to approve and before it is complete.

Tier 1: every key present and none unknown, the types, the enums, the id forms; unique ids (`designs`, `structural_improvements`, `depends_on` within an item) and unique topics (`shared` and `appendices` together; own materials within their item).

Tier 2:

- the required texts are written, and no text holds a placeholder `{{...}}`: `requirement_summary`; at least one purpose with both texts; each DESIGN item's `name`, `repository`, `purpose`, `approach`, `scope.includes`, `scope.excludes`, `key_decisions` and each `depends_on` reason; each decision's `subject`, `reason`, and each option's `label` and `description`; each ledger row's `problem`, `risk`, `policy`, `behavior_preservation` and at least one written `evidence` element; materials and appendices as in the requirement,
- the four `scope` enums, each item's `kind` and `test_policy`, and each ledger row's enums are set,
- there is at least one DESIGN item; DESIGN ids and SI ids run in order,
- `implementation_order` is not empty once a DESIGN item exists, and it holds exactly the repositories that DESIGN items name,
- each item's `acceptance` has at least one written element; an item with a written `ui_spec` has at least one `user_confirmations` element, and an item without one has none,
- each `operation_checks` element's `acceptance` equals an element of the item's `acceptance`, and its `steps` and `expected` are written; each `formal_verification` element is fully written,
- `requirement.json` of the same folder passes its own check; each `requirements` element exists there and is not repeated; every REQ of it is in some DESIGN item's `requirements`,
- a `機能` item has at least one REQ, and a `前提改修` has none,
- each `depends_on` names another existing DESIGN item; there is no cycle; no item depends on one of a later release; within one release, no item depends on one of a repository later in `implementation_order`,
- the related materials of each item have at least one row (the shared materials that apply, `extra_materials`, `inapplicable_materials`),
- each decision has 2 to 26 options, a `recommended` key that names one of them, and a valid `impact`,
- a ledger row with `承認` names an existing `前提改修` item that has no REQ, and any other status has `design` `null`; `却下` and `保留` have a reason,
- a shared material applies to at least two existing DESIGN items.
