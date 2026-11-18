# The architecture decision record

An ADR (architecture decision record) keeps one architectural decision of the design where the next case can find it: what was decided, between which options, and why.
This stage decides which decisions of the design are recorded, and writes the record.
It is written in the docs repository, in `docs/adr/`, and committed at stage 8, in a commit before the commit of the case root.
The owner sees it on the approval page as the card `AD-1` and keeps or declines it ([6-approval](6-approval.md)).

You never edit a record that already exists. To change a decision, a new record is written and the old one is set `Superseded` by the owner. The one exception is a `Proposed` record that this run wrote and has not committed: overwrite that file instead of writing another.
You never promote a status. Every record you write is `Proposed`.
You write nothing outside `docs/adr/`. You write no record for a decision that another record already holds.

## Step 1: Whether to scan

Take the first that applies.

- The owner declined the record earlier in this run: do not scan. Write nothing, and leave `{ADR path}` empty.
- This run has not scanned yet: scan.
- Stage 4 changed a node since the last scan (use the program `design-changed-nodes` of [5-review](5-review.md) against the version the scan read): scan, and the result replaces the last one.
- Otherwise the last result stands.

## Step 2: Scan

Read in full: `design.json` (node by node with `jq`), `requirement.json`, `technical-notes.md`, and each record under `{docs worktree}/docs/adr/` (the folder may not exist). A record that this run wrote is not an existing record: leave it out.

List the candidates across the whole of every target, not only the `decisions[]` of the design: a decision stated in an item's body, in a shared material or in the notes is a candidate too. You wrote the design, so never leave a decision out because you believe it follows the existing pattern: list it, and let it fall only through the exclusion below, with the location of the existing pattern as its evidence.

- Architecture impact: layer structure, boundaries, responsibility placement, data flow. Only a decision that changes the existing structure or places a new structural premise. A statement that the existing structure, features or authentication will not change is a scope statement, not a candidate.
- Technology selection: a library, middleware, protocol or data store adopted or changed.
- Design pattern: a deviation from, or a replacement of, a pattern the existing implementation adopted.

For each candidate:

1. Drop it when an existing record already holds the same decision.
2. Settle each criterion and each exclusion from the targets, with its evidence location: `{file}:{line range}`, or `design.json#{doc path}` for a node.

   Criteria, each true only when evidence shows it:
   - A, alternatives: two or more alternatives were actually compared. The evidence is a `decisions[]` element, or the reasons for rejecting alternatives in `key_decisions`.
   - B, binds beyond the case: the decision binds a shared package or module, a database schema (tables, constraints, the meaning of a column), an API contract exposed outside or across repositories, a convention that other features must follow, or it replaces the decision of an existing record.
   - C, costly to reverse: reverting needs a data migration or backfill, breaks the compatibility of an API or contract, switches infrastructure, runtime platform or operations, or introduces a new library, middleware or data store.

   Exclusions, each applying only when evidence shows it:
   - It only follows an existing implementation pattern or an existing record as it is.
   - It is a local choice inside one screen or one endpoint, and touches no shared module, schema or external contract.
   - It is a decision about behavior (what the system does toward users or other systems) with no structural choice. That belongs to the specification.

3. A candidate is recorded only when A holds, B or C holds, and no exclusion applies. Apply this as written. Add no decision and remove none by discretion.

The scan is `complete` when every target was read in full, and `partial` when a read failed: write the unread range and the reason in your `DONE` summary, and settle the candidates from what you read, never counting the unread range as holding none.

## Step 3: Write the record

- No candidate remains: write nothing. When `{ADR path}` is not empty, delete that file and empty it.
- One or more remain: write one record that holds all of them.

1. The path: when `{ADR path}` is not empty (a record this run wrote), take it. Otherwise `{docs worktree}/docs/adr/{YYYYMMDDHHMMSS}-{slug}.md`, with the time from `TZ=Asia/Tokyo date +%Y%m%d%H%M%S` and the slug in kebab-case from the title. Make `docs/adr/` when it does not exist.
2. The body. Use the template below (the MADR form, which records the comparison of the options). One decision is one record, except here: every decision of this stage that passed the formula goes in one record, with `検討した選択肢`, `決定` and `影響` written once for each decision, each set under a heading that names the decision.
3. Write it in Japanese, and polish it with `feature-dev:prose-polisher` before you write it: the final draft is the file.

```markdown
---
status: Proposed
---

# ADR-{NUMBER}: {短いタイトル}

## ステータス

提案中

## コンテキストと課題

{解決すべき課題や状況を 2〜3 文で書く。}

## 検討した選択肢

* {選択肢 1}
* {選択肢 2}

## 決定

選択した選択肢: **{選択肢 X}**

理由: {この選択肢を選んだ根拠}

## 影響

### 良い点

* {…}

### 悪い点

* {…}

## 選択肢の詳細

### {選択肢 1}

{説明}

**Pros:**
- {…}

**Cons:**
- {…}

## 関連情報

* 関連 ADR: {ADR-XXXX}
* 参考資料: {…}
```

`{NUMBER}` follows the numbering the existing records use (the highest number plus one), or `1` when there is none.

How to write each section:

- The title is a short noun phrase that shows at a glance what was decided ("メインデータベースとして PostgreSQL を採用", never "データベースについて").
- The context holds facts only, in value-neutral words, with numbers, periods and counts where they exist. It holds no opinion and no conclusion: "最悪で限界だ" becomes what is going wrong, in numbers. It includes the organizational and business background, not only the technical constraints.
- The decision is in the active voice, as "我々は〜する". It says what was chosen and what was not, and the rejected options with the reason of each.
- The consequences hold the good, the bad and the neutral points, all of them. A record with positive points only hides the risks.
- Related information: write no path under the case root (`.feature-dev/current`, or its absolute path) anywhere in the body, this section included, because the case root is archived at the end of the case under a name that is settled only then, so a path always breaks. Name a basic design or a requirement by the case key (`{ticket key}`) and the identifiers (`DESIGN-02`, `REQ-03`, the key of a shared material). Without a ticket key, write the identifiers alone. When no such document exists, leave the reference out.
- Keep it to one or two pages.

Before you write, check the record against this list: each section meets its principle; no path under the case root; the options considered are listed, each with its pros and cons; the reasons for rejecting options are stated; the record is not a giant record (five pages or more), not written after the fact, has no opinion in the context and no positive-only consequences; the status is `Proposed`.

Keep the path as `{ADR path}`, with, for each decision, the criteria it met (A, and B or C). The approval page's `AD-1` card takes its title and the recorded decisions from here.
