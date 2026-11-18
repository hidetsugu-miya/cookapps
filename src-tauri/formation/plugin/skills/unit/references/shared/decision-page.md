# Decision pages

A decision page is how you ask the owner for a judgment or an approval: the open questions of a requirement or a design, the approval of a deliverable, and the acceptance of an implementation.
The owner reads one page that carries what they need, answers on it, and the reply comes back to you as text.
You write the page as one JSON file. The leader hands it to the app, and the app draws it. You do not draw it yourself, and you do not ask in plain messages what a page should ask.

The unit's procedure says when to present a page and which items it holds.
This file says how.

## Steps

1. **Settle the items.** They are the questions or findings the procedure passes you. Do not change an item's number, options or recommendation, do not add one, and do not merge two. The recommended option of a question is the first, `A`.
2. **Read the latest state.** Facts about a deliverable come from its state on disk now, read with `jq` ([deliverable-writing](deliverable-writing.md)). State nothing that the deliverables, the items and the cited files do not state.
3. **Write the page JSON** to `{case root}/records/{unit}/page-{nn}.json`, with `nn` two digits, one more than the last page of the unit (`01` for the first). Make the folder if needed. The page is a record of the unit: it stays, and it is committed with the unit's other records ([branch-and-pr](branch-and-pr.md)). Pages are not committed before they are answered.
4. **Polish the text.** Launch the `feature-dev:prose-polisher` agent with every Japanese text the page shows as `sections` (one section for each text, headed by its place in the page), `body_only` `true`, and as `materials` the deliverable files and the items the texts rest on. Write each returned draft into the page as it stands, line by line. The leader's page tool refuses a Japanese line that is not in the final draft of a recorded polishing run, so polish first, then write the page from the drafts, and do not edit a line by hand afterwards. Do not polish the texts that the page copies from a source (a path, a quoted line of code).
5. **Send** `PAGE {absolute path}` to the leader, and stop.
6. **When `PAGE-REFUSED {path}` comes**, its lines are the violations. Fix the page. When a line was refused as unpolished, run step 4 again for those lines only. Then send `PAGE` again. When a violation names a `ref` that it cannot resolve, name that element by its index in the array (`requirement.json#/requirements/2`) instead of its `id`.
7. **When `REPLY` comes**, read it as "Reading the reply" below.

## The page

The file is one JSON object. Keys that are not listed here are refused.

### Top level

| Key | Content |
| --- | --- |
| `schema_version` | `1` |
| `page_kind` | `open-questions`, `approval` or `code-review`. |
| `subject` | `requirement` or `design` for `open-questions` and `approval`; `code` for `code-review`. |
| `context_label` | One line over the title naming the kind of confirmation and the ticket, for example `要件定義の承認依頼 ・ チケット PROJ-101`. |
| `title` | What the page is about, in one plain heading. |
| `what` | Required on `approval` and `code-review`, absent on `open-questions`. One to three sentences: the point of what this requirement, design or change adds or changes. No internal identifiers and no counts. |
| `roots` | An object that maps a root name to an absolute folder. The case root is `deliverables`. Name a repository root after the repository, and add one for each repository an evidence item cites. |
| `previous_reply` | Optional. The reply text of the owner to an earlier page of the same items, verbatim. The page starts from its answers. |

By page kind:

- `open-questions`: `questions`, an array of one or more `question` cards.
- `approval`:
  - `approval_scope` (required): an array of `{heading, items}` groups. An item is `{root, ref, description}` for a node of the deliverable, or `{root, path, description}` for another file. `root` is optional and defaults to `deliverables`. Together the groups cover every requirement (or design) item, shared material and appendix, each as one `ref` item. The description of a REQ or DESIGN item is `{ID} {name}。{summary}`. On `design`, put the DESIGN items in a group of their own that holds nothing else.
  - `quality_loop` (required): `{rounds, must_fix_resolved}`, both integers: the review rounds that ran, and the must-fix findings they fixed.
  - Optional: `changes` (change sections, below), `needs_user_decision` (`nr` cards), `residual_must_fix` (`must-fix` cards), `structural_proposals` (`structural-proposal` cards, design only), `adr` (one `adr` card, design only), `risks` (`{items, evidence}`, where `items` is an array of `{title, text}`: one sentence for the risk, and its supplement, and `evidence` is an optional array of evidence items), `settled_decisions` (an array of `{id, decision, reason, evidence, provisional}` for the `UD-NN` decisions the deliverable records; `provisional` is `true` for one that waits for the business side).
- `code-review`: optional `changes`, `residual_must_fix` (`review-must-fix` cards), `unmet_criteria` (`unmet-criterion` cards), `needs_user_decision` (`review-decision` cards), and `pr` (`{url, note}`: `url` is `null` with a `note` that says why when no pull request exists).

A change section is `{heading, blocks}`: what changes, in one plain heading, and blocks that open with who does what and what happens to them.

### Cards

| Key | Content |
| --- | --- |
| `kind` | `question` (`open-questions`); `nr`, `must-fix`, `structural-proposal`, `adr` (`approval`); `review-must-fix`, `review-decision`, `unmet-criterion` (`code-review`). |
| `number` | The id of the item (`UD-NN`, `NR-N`, `MF-N`, `SI-N`, `AD-1`, a review finding id). A `question` with none is `論点{n}`, numbered in the order passed. It is shown on the card and echoed in the reply. |
| `title` | The card's header. On `question`, `nr` and `review-decision`, it is the one question the card asks, a sentence that ends in `？`, in the words of what the owner decides. |
| `summary` | What is decided, in one or two sentences, with no recommendation. The page does not show it on `question`, `nr` and `review-decision`, but it is required. |
| `background` | Optional. The gap or premise the decision needs, in one or two plain sentences. |
| `facts` | Optional. An array of `{label, value}` (below). |
| `blocks` | Optional. Blocks shown after the facts. |
| `options` | Required on `question`, `nr` and `review-decision`, absent elsewhere. An array of `{key, label, detail}`: `key` is `A`, `B`, `C` in order, `label` the option's name, `detail` optional (what happens when it is chosen, then what it gives up or risks). One or more options. |
| `recommendation` | Required on every kind but `unmet-criterion`. `A` on `question`, `nr` and `review-decision`, and a fixed-choice key on the other kinds (below). |
| `recommendation_reason` | Required with `recommendation`. Why, in words the card itself shows, so that it reads without opening anything. |
| `evidence` | Optional. An array of evidence items. |

The fixed choices of the other kinds: `must-fix` has `fix` and `skip`; `structural-proposal` has `approve`, `reject` and `hold`; `adr` has `keep` and `decline`; `review-must-fix` has `fix` and `accept`. `unmet-criterion` has no answer.
The page adds the fixed rows `調べてから決めて` (`investigate`) and `その他` (`other`) to a `question`, `その他` to an `nr`, and `今回は対応しない` (`defer`) and `その他` to a `review-decision`.

Facts, with these labels, in this order:

- `nr`: `分類` (design only: `a: 設計側で確定不能` or `b: 設計側は確定済み・認識承認をお願いしたい`), `影響範囲` (design only).
- `must-fix`: `箇所`, `指摘内容`, `author の反論` (requirement only), `未解消の理由`.
- `structural-proposal`: `検出観点`, `エビデンス`, `想定リスク`, `改善方針`, `振る舞い保存方針`, `段階的移行の要否`, `重要度`.
- `adr`: `題名`, `記録した決定`.
- `review-must-fix`: `未解消の理由`.
- `unmet-criterion`: `根拠値`, `充足しない理由`.
- `review-decision`: `重要度`.

### Blocks

Each block is an object with a `type`:

- `paragraph`: `text`.
- `heading`: `text`, a heading for the blocks after it.
- `list`: `items`, an array of texts.
- `callout`: `text`, a highlighted note.
- `table`: `header` (array of texts, optional) and `rows` (array of rows; a cell is a text, or `{text, changed: true}` to mark what changes).
- `before-after`: `before` and `after` (arrays of blocks), with `before_caption` (default `今`) and `after_caption` (default `変更後`).
- `folded`: `summary` and `blocks`, a group the owner opens.
- `diagram`: `mermaid` and `caption` (optional). Its first line names the type: `flowchart` (or `graph`), `sequenceDiagram` or `stateDiagram` (or `stateDiagram-v2`). A syntax error is refused.
- `evidence`: `items`, evidence items, shown folded.

A text field is plain Japanese. `**...**` is the only inline markup.

### Evidence items

Each item is an object with a `type`:

- `excerpt`: `root`, `path`, `start`, `end` (default `start`), `highlight` (line numbers, default every line), `note`. Cite the smallest range that grounds a statement.
- `diff`: `summary`, `name`, `before` and `after` (arrays of short lines), `note`.
- `git-diff`: `summary`, `root` (a git repository), `path`, `base` (a revision), `head` (a revision, or `null` for the working tree), `note`. On a `code-review` page, show changed code with this, never with lines you copied.
- `node`: `root`, `ref`, `note`. A node of `requirement.json` or `design.json`, as `{file}#{pointer}`, for example `requirement.json#/requirements/REQ-03` or `design.json#/designs/DESIGN-02`. Cite the deliverables with this, never with `excerpt`.

A `path` is relative to the folder of its `root`, with `/`. A cited file or range that does not exist is refused.

Not part of the page: images, screenshots, samples, a count of cards, a glossary, and any key not listed above.

## Writing the text

- Rewrite the items into plain Japanese without changing what they mean: keep every number, condition, negation and scope. Keep the ids (`REQ-NN`, `UD-NN`, `DESIGN-NN`).
- Write one point to a sentence, in です・ます. Say who acts. Do not state a positive as a double negative.
- Open each paragraph with its point, one topic to a paragraph. Write three or more parallel items as a `list`.
- Use literal words. No metaphor, and none of this workflow's inner words (skill, subagent, Phase, JSON field names). Say what happened, or what the owner decides.
- Call one thing by one name across the page. Prefer the common Japanese word to a loan word.
- A title or heading states the point (`宛名をペットごとに付けるか`), not a category (`宛名について`).
- On `question` and `nr`, `title` and each option's `label` use the words of what the owner decides, not implementation words.
- Use the verb, not a noun of the action (`確認する`, not `確認を実施する`).
- Put a condition before the action it governs. Name what a pointer word points at, and write amounts and dates: no `この部分`, `早めに`.
- Keep one marker of real uncertainty, and drop stacked hedges. Never drop an uncertainty the item states.
- Write no count of the page's own cards in any text. The page counts them itself.
- Put a fact that could change the answer (a risk, an effect that cannot be undone, a departure from what was asked) where the card always shows it: in `background`, or in the question itself. Never only in `blocks`, `evidence` or a `folded` block.
- Leave out what the decision does not need, such as how the investigation went.
- Draw as a `diagram` a change or behavior that has two or more steps or a branch, or involves several actors, screens or systems. Write the node text under the same rules.

## Reading the reply

The reply is text that the page assembled from the owner's answers, in page order, one block for each answered card, with one blank line between blocks:

```text
{verdict line}

{number} {title}
{answer line}
補足: {free text}
```

- The verdict line is only on `approval` and `code-review` pages:

  | Page | Approve | Revise |
  | --- | --- | --- |
  | `approval`, `requirement` | 要件定義を承認します | 要件定義の修正を依頼します |
  | `approval`, `design` | 基本設計を承認します | 基本設計の修正を依頼します |
  | `code-review` | この変更を承認します | 修正を依頼します |

  The page derives it from the answers: the Revise line while a revision choice is chosen (`fix` on `must-fix` and on `review-must-fix`), the Approve line otherwise.
- A card block has the card's `number` and `title` as they are. Its answer line is `{key}. {label}` for a lettered option, or the reply text of a fixed choice: `調べてから決めて`, `その他`, `指摘のとおり修正する`, `今回は対応しない`, `承認`, `却下`, `保留`, `残す`, `不要`, `修正して再レビューする`, `現状で完了する`. A card with free text only has no answer line. The `補足` line is the owner's free text, when there is any.
- A card with no block is unanswered.

Read each block by its card:

- **question**: `{key}. {label}` is the decision. `調べてから決めて` means: investigate, then decide. `その他` with a `補足` is the owner's own answer, read as a free-text decision. No block means unanswered: present again those numbers only, as a new page.
- **nr**: `{key}. {label}`, or `その他` with a `補足`, is the decision. Unanswered means the recommended option, under an approve verdict.
- **must-fix**: `指摘のとおり修正する` is a revision request. `今回は対応しない` is compatible with approval, and you keep it as declined by the owner's decision.
- **structural-proposal**: `承認`, `却下` or `保留`, with the `補足` as the reason for `却下` and `保留`. Unanswered means the recommended choice.
- **adr**: `残す` keeps the record. `不要` means it is not needed. Unanswered keeps it.
- **review-must-fix**: `修正して再レビューする` chooses a fix. `現状で完了する` agrees to complete as it is. Unanswered means `現状で完了する`, under an approve verdict.
- **review-decision**: `{key}. {label}` names the option under that key. `今回は対応しない` defers it. `その他` takes the disposition its `補足` states; when the `補足` states none, ask the owner. Unanswered is undecided.
- **Verdict**: the approve line approves the deliverable or the change. The revise line, or a request to fix it that the owner wrote outside the layout, is a revision request: its content is the revision choices and that text. A hold, a redesign or a send-back is read from that text. An approve line with no block and no other text is a blanket approval.
- A `補足` with no answer line, on a kind not named above, is free text you read with the unit's own criterion.
- A reply that does not follow the layout is read as free text in the same way.

A reply that asks for a clearer or different explanation of some items instead of answering them (`分からない`, `もっと分かりやすく`, `図で説明して`) leaves those items unanswered.
Write a new page for those items, with the explanation made clearer (a `diagram`, a concrete case in `background`), and pass the owner's reply whole as `previous_reply`. Do not explain the items in a plain message instead.
A question about the change or the deliverables themselves is not such a request: answer it in the `background` of a new page that carries the same items, with the owner's reply whole as `previous_reply`.

When the owner's reply leads to a revision, make it, present the changed items again on a new page with `previous_reply`, and go on until the owner approves.
