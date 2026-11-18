# Glossary

The words every unit uses.

## The people and sessions

- **Owner**: the person who asks for the feature and accepts the result. They answer decision pages.
- **Leader**: the Claude Code session that runs the case, launches one child for each unit, and relays your messages and the owner's replies. You reach it with SendMessage.
- **Child**: you. A Claude Code session that runs one unit.

## The case

- **Case**: the work of one feature, from its requirement to its specification. A repository has one case in progress at a time.
- **Case root** `{case root}`: the folder `.feature-dev/current` of the docs repository on the base branch. It holds `case.json`, `requirement.json`, `design.json`, and `records/`.
- **Docs repository**: the repository that holds the case root. It is the one repository of `repos[]` with `docs` `true`.
- **Docs worktree**: the folder of the docs repository that is on the base branch. The case root lives in it.
- **Base branch** `{base branch}`: the case's branch. Requirement, design and specification commit to it.
- **Records** `{case root}/records/`: `records/{unit}/` holds the decision pages and the review records of a unit, `records/reopen-{unit}-{time}.md` the records of a reopen, and `records/design-base.json` the design as it was when it was reopened.

## The units

A **unit** is one step of the case. A unit is named by its **key**: `requirement`, `design`, `specification`, or the key of an implementation.
The units run in this order: `requirement`, `design`, the implementations in the array order of `implementations[]`, `specification`.
The first one that is not `完了` is the next to work.

- **requirement**: writes `requirement.json`, what the case must achieve, and has the owner approve it.
- **design**: writes `design.json`, the basic design as DESIGN items, has the owner approve it, and derives the implementations from it.
- **implementation**: implements the DESIGN items of one stage of one repository on a child branch, and has the owner accept it. A repository's DESIGN items fall into stages by `depends_on`: the items of one stage do not depend on each other and are implemented together.
- **specification**: writes the specification from the finished implementation.

Statuses are `未着手` (not started), `進行中` (in progress), `受入待ち` (an implementation whose review has converged and that waits for the owner's acceptance), and `完了` (complete).

## The deliverables

- **REQ** (`REQ-NN`): one requirement of `requirement.json`.
- **UD** (`UD-NN`): a user decision, a decision the owner took on a requirement, stored once at its owner (a REQ, or a shared material when it binds several REQs).
- **DESIGN item** (`DESIGN-NN`): one item of the design of `design.json`, in one repository. It is `機能` when it realizes REQs, and `前提改修` when it is a change that other items need and that has no REQ of its own.
- **SI** (`SI-NN`): a structural improvement proposed in the design's ledger.
- **Design baseline**: `design.json` as the owner approved it. The implementations follow it.

## Changing the design baseline

When an implementation finds that it does not match `design.json`, or that `design.json` lacks something, decide which kind of change it is.

- **Major change (大転換)**: the change reaches any of these: the order of the repositories (`implementation_order`), the trace from REQ to DESIGN item, another implementation (one that is complete, or an earlier stage of the same repository), a data model or an API contract that several DESIGN items depend on, the requirement level, or a method, a behavior or a completion condition that a DESIGN item defines. Do not edit `design.json` inside the implementation. Reopen the design (and the requirement, when it reaches the REQs), as [case-json](case-json.md) says. When it is not clear, treat it as major.
- **Minor change (小変更)**: a local adjustment that matches none of the above and stays inside one DESIGN item: a name, a type or a granularity, a mistake in a description, or a detail the item leaves open. It is not written into `design.json`, and the specification records it as it stands in the code.
- To redo an implementation with no change to the design at all, reopen the implementation by its key. This is not a major change.

What the implementation decides itself, within the baseline (private method names, the structure of a test, the choice of a test double), is the **implementation policy**. It is not a design change.
