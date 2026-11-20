# Decision pages

A decision page is how you ask the owner for a judgment or an approval: the open questions of a requirement or a design, the approval of a deliverable, and the acceptance of an implementation.
The owner reads one page that carries what they need, answers on it, and the reply comes back to you as text.
You write the page as one JSON file. The leader hands it to the app, and the app draws it. You do not draw it yourself, and you do not ask in plain messages what a page should ask.

The unit's procedure says when to present a page and which items it holds.
This file says how: the steps, the JSON, the rules of the text, and how the reply is read.

A page presents the items the procedure passes you. It decides nothing, and it never writes to a deliverable, an evidence file or a repository.
The page settles nothing by itself: the owner's answer reaches you only as the reply text.

## Steps

1. **Settle the items.** They are the questions or findings the procedure passes you. Do not change an item's number, options or recommendation, do not add one, and do not merge two. The one exception is a refused duplicate number (step 6). The recommended option of a question is the first, `A`.
2. **Read the latest state.** Facts about a deliverable come from its state on disk now, read with `jq` ([deliverable-writing](deliverable-writing.md)). State nothing that the deliverables, the items and the cited files do not state.
3. **Write the page JSON** to `{case root}/records/{unit}/page-{nn}.json`, with `nn` two digits, one more than the last page of the unit (`01` for the first). Make the folder if needed. The page is a record of the unit: it stays, and it is committed with the unit's other records ([branch-and-pr](branch-and-pr.md)). Pages are not committed before they are answered.
4. **Polish the text.** Launch the `feature-dev:prose-polisher` agent with every Japanese text the page shows as `sections` (one section for each text, headed by its place in the page), `body_only` `true`, and as `materials` the deliverable files and the items the texts rest on. Write each returned draft into the page as it stands, line by line. The leader's page tool refuses a Japanese line that is not in the final draft of a recorded polishing run, so polish first, then write the page from the drafts, and do not edit a line by hand afterwards. Do not polish what the page copies or quotes: a path, a `root`, `ref`, a `source`, the lines of a `diff`, `previous_reply`, the identifiers (`number`, `clarified_numbers`, `cards`), the label of every fact, the value of the facts the contract fixes (`分類`, `影響範囲`, `重要度`, `検出元`, `箇所`), and the `label` and `fix` of the options of a `review-decision` card, which are the reviewer's own words. The texts inside a Mermaid diagram are polished.
5. **Send** `PAGE {absolute path}` to the leader, and stop.
6. **When `PAGE-REFUSED {absolute path}` comes**, its lines are the violations. Fix the page. When a line was refused as unpolished, polish the Japanese of the page again, those lines included, in one run of yomiyasu (step 4). Then send `PAGE` again. When a violation names a `ref` that it cannot resolve, name that element by its index in the array (`requirement.json#/requirements/2`) instead of its `id`. A diagram that the check refuses for its syntax is fixed in its `mermaid` text, and an image that is not there, or is too large, is replaced by a file that is.
   When a violation is a number that two cards share (`同じ番号のカードがもう一枚あります`), two items of different rounds have met on one page (for example the `MF-1` still open from an earlier round and an `MF-1` of a later one). Add the mark of the round in which it was raised to the number of each later card, `{number}-r{round}` (`MF-1-r2`; `r2` when no round is known), so that every number on the page is unique. Change nothing else of the card, and do not merge the two cards. Then send `PAGE` again.
7. **When `REPLY` comes**, read it as "Reading the reply" below.

## The page

The file is one JSON object. Keys that are not listed here are refused. Every text field that is given is a non-empty string, and `null` counts as absent. Write no placeholder for an empty value (`該当なし`, `なし`): leave the field out.
A `path` is relative to the folder of its `root`, with `/`. A `ref` is `{file}#{pointer}` of a node of `requirement.json` or `design.json` (`requirement.json#/requirements/REQ-03`), and every reference into those two files is a `ref`; a `path` names any other file. A `source` is a string that cites `path:line` places, or `{file}#{pointer}` places of the deliverables, several separated by `、`, each optionally followed by a short note in `（）`.

### Top level

| Key | Content |
| --- | --- |
| `schema_version` | `1` |
| `page_kind` | `open-questions`, `approval` or `code-review`. |
| `subject` | `requirement` or `design` for `open-questions` and `approval`; `code` for `code-review`. |
| `context_label` | Required. One line over the title naming the kind of confirmation and the ticket, for example `要件定義の承認依頼 ・ チケット PROJ-101`. |
| `title` | Required. What the page is about, in one plain heading. |
| `what` | Required on `approval` and `code-review`, absent on `open-questions`. One to three sentences: the point of what this requirement, design or change adds or changes, not a restatement of `title`. No internal identifiers and no counts. |
| `roots` | Required. An object that maps a root name to an absolute folder, which must be inside a repository of the formation or one of its worktrees (the case root is). The case root is `deliverables`. Name a repository root after the repository, and add one for each repository an evidence item or an image cites. A screenshot or a capture of a `screen-verification` card that lies under none of those roots gets a root of its own, named `screenshots` or `captures`. The captures of the goal verification are in `{docs worktree}/.feature-dev/captures/{unit key}` (outside the case root, and never committed), which is the root `captures`. |
| `terms` | Optional. An array of `{word, description}`. The page shows `description` as a tooltip on `word` in the body text. List only the words the page uses whose meaning a reader outside the project cannot tell. |
| `previous_reply` | Optional. The reply text of the owner to an earlier page of the same items, verbatim. It is never shown. The page starts from its answers (on a lettered card, a `補足` returns only with `その他`). |
| `clarified_numbers` | Optional. An array of the `number`s of the cards whose items the owner asked to have explained more clearly. The page restores no answer into those cards, so that the request's own words never return as an answer. |
| `hold` | Optional, only on `open-questions` with `subject` `requirement`. `true` adds the fixed choice `ビジネス側に確認する` to every `question` card. `false` is the same as absent. |

By page kind:

- `open-questions`: `questions`, an array of one or more `question` cards.
- `approval`:
  - `approval_scope` (required): an array of `{heading, items}` groups. An item is `{root, ref, description}` for a node of the deliverable, or `{root, path, description, extras}` for another file, where `extras` is an optional array of more paths of the same root, shown under the item and covered by its description. Give `ref` or `path`, never both. `root` is optional and defaults to `deliverables`; the item of an ADR file, which lives in a repository, names that repository's root. A group holds at least one item. Together the groups cover every requirement (or design) item, shared material and appendix, each as one `ref` item whose node holds its own extra materials. Group them by the deliverable's classes: requirements, shared materials and appendices (for `design`: design items, shared materials, appendices and the ADR).
    - The description of a REQ or DESIGN item is `{ID} {name}。{summary}`, with its 「。」 dropped when the item's `summary` is `null`. That of a shared material names the DESIGN items it applies to (`design`) or what it is; that of an appendix names its kind (`集計`, `調査証跡`, `検算`); that of the ADR lists each recorded decision with the criteria it met.
    - On `design`, put the DESIGN items in a group of their own that holds nothing else. The page shows that group as the section 設計項目, one row for each item, and adds the section 実装順序 from the `implementation_order` of `design.json` itself: write no such group and no such section.
  - `quality_loop` (required): `{rounds, fix_cycles, must_fix_resolved}`, all integers: the review rounds that ran, the fix runs among them, and the must-fix findings they fixed. `fix_cycles` is required on `design` and a violation on `requirement`.
  - Optional:
    - `changes` (change sections, below).
    - `needs_user_decision` (`nr` cards), `residual_must_fix` (`must-fix` cards), `structural_proposals` (`structural-proposal` cards, `design` only) and `adr` (one `adr` card, `design` only).
    - `risks`: `{items, evidence}`, from the deliverable's risk material. `items` is an array of at least one `{title, text}`: `title` is one sentence for the risk and is required (each `### 既知の制限` statement of `design.json` is one, wherever it sits), `text` is its supplement and is optional. `evidence` is an optional array of evidence items. An array of blocks is refused.
    - `settled_decisions`: an array of `{id, decision, reason, evidence, provisional}` for the `UD-NN` decisions the deliverable records. `id`, `decision` and `reason` are required. `evidence` is an array of evidence items. `provisional` is `true` (`requirement` only) for a decision that waits for the business side; the page lists those apart.
    - `withdrawn_needs_user_decision`: an array of `{number, title, withdrawal_reason}`, one for each decision item the review withdrew because the final deliverable already settles it.
    - `noticed`: an array of `{title, text, evidence}`, one for each matter you noticed outside the request and did not reflect. `title` and `text` are required, `evidence` is optional. The page shows them under 目標外の事柄 with the sentence that only what the owner names is fixed. It has no answer form.
- `code-review`:
  - `residual_must_fix` (`review-must-fix` cards), `unmet_criteria` (`unmet-criterion` cards) and `needs_user_decision` (`review-decision` cards).
  - `screen_verifications`: `screen-verification` cards, one for each screen-verification result of the unit, in the order the unit holds them. They need no answer. The page opens the failed and not-run ones, and folds the passed ones.
  - `policy_deviations`: blocks. Where the implementation departed from the contract of the unit, with the reason, and the facts found after the contract was written that the owner should know.
  - `notices`: an array of one-line texts, the facts about this review that the owner should know (below, "The state of the checks").
  - `noticed`: as on `approval`.
  - `pr`: `{url, note}`. `url` is `null` with a `note` that says why when no pull request exists.
  - Write no `changes` and no `git-diff` evidence on it: the change is read in the pull request, whose body holds what the page leaves out ([branch-and-pr](branch-and-pr.md), "The body of the child pull request"). The input still accepts `changes`, so that a page recorded earlier reads.

A change section is `{heading, blocks}`: what changes, in one plain heading, and blocks that open with the scene the change shows up in (who does what and what happens to them).

The page counts its cards, groups and answers itself, and adds the fixed sentences, the section headings, the rows `調べてから決めて` and `その他`, the tag 「聞きたいこと」 on a card that asks, and, on a requirement `open-questions` page, the check 「仮置き（ビジネス側の確認待ち）」 under the choices. The JSON carries none of them.

### The state of the checks (`notices`)

On `code-review`, `notices` holds one line for each of these that applies:

- The aggregate check: its command and `passed`, or that the repository defines none. The coverage figure, when stage 4 kept one.
- Each `environment_fixes` entry of the aggregate check: what the agent repaired so that it could run.
- Any other fact about the review that the procedure hands you, such as the staging set being restored from the working tree.

State only what you ran. A check that failed is not a notice: it is handled by the stage that ran it.

### Cards

| Key | Content |
| --- | --- |
| `kind` | Required, and it must be the kind of the array the card is in. `question` (`open-questions`); `nr`, `must-fix`, `structural-proposal`, `adr` (`approval`); `review-must-fix`, `review-decision`, `unmet-criterion`, `screen-verification` (`code-review`). |
| `number` | Required. The id of the item (`UD-NN`, `NR-N`, `MF-N`, `SI-N`, `AD-1`, a review finding id, `SV-N` for a screen-verification item, `FV-N` for a formal-verification result). A `question` with none is `論点{n}`, numbered in the order passed. It is shown on the card and echoed in the reply. |
| `title` | The card's header. On `question`, `nr` and `review-decision`, it is the one question the card asks, a sentence that ends in `？`, in the words of what the owner decides. |
| `summary` | Required. What is decided, in one or two sentences, with no recommendation. The page does not show it on `question`, `nr` and `review-decision`. |
| `occurrence` | Required on `review-decision` and on `nr` with `subject` `design`, otherwise a violation. `{conditions, likelihood, basis, impact, detectability}`, all required (below). |
| `scene` | The concrete scene the decision plays out in (below). Required on `question`, `nr` and `review-decision`, and on every other card whose outcome changes what someone experiences. |
| `scene_image` | Optional, only on `question`, `nr` and `review-decision`. `{root, path, caption}`, validated like an `image` block: the screenshot or the UI reference image of the screen the scene is about, shown right under the scene. |
| `background` | Optional. The gap or premise the decision needs, in one or two plain sentences (below). |
| `facts` | Optional. An array of `{label, value, ref, path, root}` with the labels of "Facts by kind", in that order. `ref` names the one deliverable node the value cites; `path` the one other file (never both); `root` (with either) defaults to `deliverables`. With either set, the page shows the content of that node or file in a fold under the value. |
| `blocks` | Optional. Blocks shown after the facts. |
| `options` | Required on `question`, `nr` and `review-decision`, absent elsewhere. An array of one or more `{key, label, detail, fix, unmet, image, sample, diagram}` (below). |
| `conditions` | Optional; required when an option has `unmet`; only with `options`. An array of `{id, text}`: every condition the decision requires the options to meet, with the id the record gives it (`KO-03`). |
| `choice_details` | Optional. An object that maps a fixed-choice key to its trade-offs. |
| `recommendation` | Required on every kind but `unmet-criterion` and `screen-verification`, which refuse it. `A` on `question`, `nr` and `review-decision`, and a fixed-choice key on the other kinds. |
| `recommendation_reason` | Required with `recommendation`. Why, in words the card itself shows, so that it reads without opening anything. |
| `evidence` | Optional. An array of evidence items. |
| `cards` | Only on `unmet-criterion`, optional. An array of the `number`s of every finding that causes the unmet criterion, whether or not that finding has a card on the page. The page decides from it whether the card is shown. |
| `viewpoint`, `state_setup`, `result`, `basis`, `reference_image`, `captured_image`, `missing_reason`, `steps`, `expected` | Only on `screen-verification` (below). |

The recommendation of each kind comes from the item or the record it cites, or follows a fixed rule. You choose none of them:

- `question`, `nr` and `review-decision`: `A`, the option the item recommends, and its reason. Put the recommended option first as `A`, and letter the rest `B`, `C` in the order passed. A fixed-choice key is never the recommendation on these kinds.
- `must-fix`: the `fix` or `skip` recorded on the item, with its reason. `review-must-fix`: the `fix` or `accept` recorded, with its reason.
- `structural-proposal`: `approve`, with a reason drawn from the proposal's 想定リスク and 改善方針. `adr`: `keep`, with a reason that names the criteria the ADR met.

The fixed choices of the other kinds: `must-fix` has `fix` and `skip`; `structural-proposal` has `approve`, `reject` and `hold`; `adr` has `keep` and `decline`; `review-must-fix` has `fix` and `accept`. `unmet-criterion` and `screen-verification` have no answer.
The page adds the fixed rows `調べてから決めて` (`investigate`) and `その他` (`other`) to a `question`, `ビジネス側に確認する` (`hold`, between them) when the page sets `hold`, `その他` to an `nr`, and `今回は対応しない` (`defer`) and `その他` to a `review-decision`.

#### Options

An option is `{key, label, detail, fix, unmet, image, sample, diagram}`:

- `key` is `A`, `B`, `C` in order. `label` is the option's name, in the words of what the owner decides, not implementation words.
- `detail` is optional: what happens when the option is chosen, then what it gives up or risks, both from the item. Leave it out when the item states neither.
- `fix` is optional and only on `review-decision`: the one fix the option's answer hands to the implementation. An option without `fix` is the answer that keeps the current behavior, an option like any other.
- `unmet` is optional: an array of `{id, reason}`, one for each condition of the card's `conditions` that the option fails, with what the option does against what the condition demands.
- `image` is optional: `{root, path, caption}`, validated like an `image` block. A screenshot or a UI reference image that shows how this option looks, adopted or not.
- `sample` is optional: `{text, font_size, font_weight, color}`. The text the page draws in this option's style. `text` is required, `font_size` an integer of px from 1 to 200, `font_weight` an integer from 100 to 900 in steps of 100, `color` is optional (`#rgb` or `#rrggbb`).
- `diagram` is optional: `{mermaid}`, validated like a `diagram` block. How things go after this option is chosen.

#### Occurrence

`occurrence` says when the matter arises and how much it matters. Take each part from the finding when it carries it. Otherwise settle it from the cited sources and the deliverable, and say so in `basis`.

- `conditions`: an array of one or more texts, the conditions that must all hold for the matter to arise, one text each.
- `likelihood`: `frequent`, `occasional` or `rare`.
- `basis`: the ground of `likelihood`. It opens with `実測: ` (what you ran or read) or `推測: ` (what you assume, and from what).
- `impact`: what happens to the user or the data when it arises.
- `detectability`: how it would be noticed, or that nothing notices it.

On a `review-decision` card, take them from the finding's trigger, impact and verification. On an `nr` of a design page, from the decision's trigger conditions, its likelihood and its `impact`.

#### The `screen-verification` card

It presents the verification of one screen state or one operation against its viewpoint, and the result with its basis. The owner reads it and answers nothing on it, so it carries no fact, no recommendation and no answer. `number` is the item's `SV-{n}`; `title` names the screen and its state, or the operation, in a few words; `summary` says in one sentence what was checked.

- `viewpoint` (required): the item's viewpoint as given, word for word, except that a link to a screenshot is reduced to its link text.
- `state_setup` (optional): the item's state setup, rewritten in plain words without changing the data, the response or the operation it names. Absent when the item has none.
- `result` (required): `pass`, `fail` or `not-run`, as given.
- `basis` (required): the basis as given, rewritten in plain words without changing what matched or differed.
- `reference_image` (optional): `{root, path, caption}`, the item's reference screenshot. `captured_image` (optional): the capture; a `not-run` card has none.
- `missing_reason` (required when `result` is `not-run`, otherwise absent): why it was not run, as given.
- `steps` (optional, only on an operation item): an array of one or more texts, the operations in order. `expected` (required with `steps`, otherwise absent): what must appear after the last step.

A card without `steps` carries `reference_image`, `captured_image`, or both.

### Facts by kind

Facts, with these labels, in this order:

- `nr`: `分類` (`design` only: `a: 設計側で確定不能` or `b: 設計側は確定済み・認識承認をお願いしたい`), `影響範囲` (`design` only), `検出元`.
- `must-fix`: `箇所`, `検出元`, `指摘内容`, `author の反論` (`requirement` only), `未解消の理由`.
- `structural-proposal`: `検出観点`, `エビデンス`, `想定リスク`, `改善方針`, `振る舞い保存方針`, `段階的移行の要否`, `重要度`.
- `adr`: `題名`, `記録した決定`.
- `review-must-fix`: `検出元`, `未解消の理由`, `既存の記録`.
- `unmet-criterion`: `根拠値`, `充足しない理由`.
- `review-decision`: `重要度`, `検出元`, `既存の記録`.

`検出元` is the review that filed the finding: its round and its perspective, as the report of the reviewer names them (`第1回・correctness`), several joined with `、`. `重要度` is the severity as the report writes it. Copy both as they are. Leave `検出元` out when the finding has none.
`既存の記録` appears only when the finding rests on an existing document (an ADR, a specification, a convention) or you read one to judge it. Name the document, and the range you confirmed in its original text, including whether it covers other places that share the cause.
When a `箇所` or `既存の記録` value names one node of `requirement.json` or `design.json`, set that fact's `ref` to it; when it names one other file, set `path`, with `root` when the file is not under `deliverables`.
An `unmet-criterion` card's 充足しない理由 names each `review-decision` item that causes the unmet criterion. It gives a level (`発生頻度`) only when the item has one, and never fills one in by guess.

### Blocks

Each block is an object with a `type`:

- `paragraph`: `text`.
- `heading`: `text`, a heading for the blocks after it.
- `list`: `items`, an array of texts.
- `callout`: `text`, a highlighted note.
- `table`: `header` (array of texts, optional) and `rows` (array of rows; a cell is a text, or `{text, changed: true}` to mark what changes).
- `before-after`: `before` and `after` (arrays of blocks), with `before_caption` (default `今`) and `after_caption` (default `変更後`).
- `image`: `root`, `path`, `caption`. A screenshot of the current screen or of the adopted after-state, or a UI reference image. How an option that is not adopted would look goes in that option's `image`.
- `folded`: `summary` and `blocks`, a group the owner opens.
- `diagram`: `mermaid` and `caption` (optional). Its first line names the type: `flowchart` (or `graph`), `sequenceDiagram` or `stateDiagram` (or `stateDiagram-v2`). The check reads that first word and the syntax, and a syntax error is refused with the diagram's JSON path.
- `evidence`: `items`, evidence items, shown folded.

A `list` has at least one item, a `table` at least one row, and an `evidence` block at least one item. Blocks nest at most 6 deep.
A text field is plain Japanese. `**...**` is the only inline markup.

### Evidence items

Each item is an object with a `type`:

- `excerpt`: `root`, `path`, `start` (1 or more), `end` (default `start`, at most 400 lines after `start`), `highlight` (line numbers inside the range, default every line), `note`. Cite the smallest range that grounds a statement.
- `diff`: `summary` (one line above the diff), `name` (what the lines are), `before` and `after` (arrays of short lines), `before_source` and `after_source` (sources), `note`.
- `current`: `note` (required: where the after-state is decided, for example `変更後は基本設計で決めます`) and `excerpts` (an array of `excerpt` items).
- `git-diff`: `summary`, `root` (a git repository), `path`, `base` (a revision), `head` (required: a revision, or `null` for the working tree), `note`. A diff with no change is refused. A `code-review` page carries none: the pull request shows the diff.
- `node`: `root`, `ref`, `note`. A node of `requirement.json` or `design.json` (a file that ends in `.json`), as `{file}#{pointer}`, for example `requirement.json#/requirements/REQ-03` or `design.json#/designs/DESIGN-02`. Cite the deliverables with this, never with `excerpt`.

A cited file or range that does not exist is refused. A page holds at most 200 evidence items.
Cite as evidence only the lines or the nodes that ground a statement of the page, each the smallest that does.

Not part of the page: a count of cards, a glossary, and any key not listed above.

## Writing the text

These rules govern every text of the page except the ones the polishing step leaves as they are (step 4 of "Steps").

### Wording

- Rewrite the items into plain Japanese without changing what they mean: keep every number, condition, negation and scope. Keep the ids (`REQ-NN`, `UD-NN`, `DESIGN-NN`).
- Write one point to a sentence, in です・ます. Name who acts where the actor matters. Do not state a positive as a double negative (`〜しないわけではない`), and split a long modifying clause into a sentence of its own.
- Open each `scene`, `background` and paragraph with its point, one topic to a paragraph. Write three or more parallel items as a `list`.
- Use literal words. No metaphor or idiom, and none of this workflow's inner words (skill, subagent, Phase, JSON field names). Say what happened, or what the owner decides.
- Call one thing by one name across the page. When `terms` explains a word, use that word every time. Prefer the common Japanese word to a katakana or English loan word.
- A title or heading states the point (`宛名をペットごとに付けるか`), not a category (`宛名について`).
- On a card that asks (`question`, `nr`, `review-decision`), `title` is the one question the card asks, a sentence that ends in `？`: `自動電話での呼び出しも、今回作りますか？`. The page opens it with the tag 「聞きたいこと」. On `question` and `nr`, `title` and each option's `label` use the words of what the owner decides, not implementation words such as `回収` or `失効`: `ごくまれな障害で残った与信のために、仕組みを作りますか？`
- Use the verb, not a noun of the action (`確認する`, not `確認を実施する`).
- Keep one marker of real uncertainty, and drop stacked hedges (`場合によっては〜の可能性も考えられる` becomes `〜の可能性がある`). Never drop an uncertainty the item states.
- Name what a pointer word points at, and write amounts and dates: no `この部分`, `関連箇所`, `早めに`.
- Put a condition before the action it governs: `〜の場合は、〜する`.
- Write no count of the page's own cards or change sections in `title`, `what` or any other text (`（3 件）`, `論点が 3 件あります`). The page counts them, and a count written by hand can disagree with it.
- Give a group of blocks inside a card a `heading` block that states its point, never a paragraph that opens with a bold label (`**候補 A が除外された理由:** …`). `**…**` stays for emphasis inside a sentence.
- In the texts shown without term explanations (`title`, `summary`, an option's `label` and a change section's `heading`), use no word listed in `terms`: use a plain word, or follow it with a short plain gloss in `（）`.
- Place no glossary on the page. A word that needs an explanation goes in `terms`.
- Leave out what the decision does not need, such as how the investigation went or a restatement of `summary`.
- Notation: never use alone `UD`, `MF`, `NR`, `SI` or `RC`. Write the full form (User Decision `確定済みユーザー判断`, MustFix `必須修正`, NeedsUserDecision `ユーザー判断事項`, Structure Improvement `構造改善発議`, Recommendation `参考指摘`), or the id with its prefix and number (`UD-03`, `MF-1`). Expand `REQ` (Requirement `要件`) and `DESIGN` (Design `設計項目`) at their first occurrence or in the heading, when they stand without a number.

### The card's own parts

- `summary` states only what is decided, in one or two sentences, with no recommendation: the page shows the recommendation once, on the recommended choice's row in 「あなたの回答」.
- `background` states only the gap or premise the decision needs, in one or two plain sentences: `チケットは「予約・受付済み・案内済みの 3 つに制限」と書いていますが、今の連携病院は 6 つのステータスを使っています。` It carries no commit hash, past ticket number, repository name, code identifier, file path, search command, hit count, or working note such as `Figma に描かれていません`. Put each such fact in the `note` of the evidence item that grounds it, so that it stays on the page. When no evidence item can ground it (a ticket number, a search hit count), put it in a `paragraph` block inside a `folded` block of the card's `blocks`.
- `scene` is a concrete business situation and what this decision determines in it, as a plain sentence: `ペットクルー連携の病院で、診察を終えた予約を「会計待ち」にしようとしたとき、そのステータスを選べるかどうかが決まります。` Write it for every card that asks and for every other card whose outcome changes what someone experiences. State when the situation occurs and whether the owner's own operations can reach it, as far as the sources settle it. Example names are allowed, and the behavior they show comes from the sources. Open a change section's blocks with who does what and what happens to them.
- On a card that asks, `scene` also says why the question arises, right after the situation: what the change does that leaves this matter undecided, and what the owner would otherwise not see: `カードの登録場所を「その他の設定」画面に移すため、この案内文は、カードを登録できなくなる「患者様情報」画面を指したままになります。` Name the screen, message or document the matter sits in, in the owner's terms. When the item or its evidence shows that the matter is in neither the ticket nor the request (a review or the investigation found it), say so in the same place and name what found it: `チケットにはない論点で、レビューが今回の変更の影響として見つけました。`
- Put a fact that could change the answer (a risk, an effect that cannot be undone, a departure from what was asked) where the card always shows it: on a card that asks, in `scene`, as a sentence after the situation; on any other card, in `background`. Never put it only in `blocks`, `evidence` or a `folded` block, all of which the owner opens on purpose.
- `recommendation_reason` reads from what the card shows, without opening a fold: the page puts it on the recommended choice's row, apart from whatever the card folds. Where the reason rests on a change or a comparison, state in it what is changed and what it is compared with or aligned to. Name each screen, message or document in the words the card's shown text uses: `追加の画面の取得中と失敗時の表示を、一覧の画面と同じにすれば、利用者は取得中と失敗を見分けられます。` Take the words it lacks from the same item, and add no ground the item does not state.
- An option's `detail` and a `choice_details` entry say what happens when it is chosen, then what it gives up or risks, both from the item.
- When an option fails a condition the decision requires (a k.o. criterion, a requirement, a must-have), set the card's `conditions` to every such condition and the option's `unmet` to each one it fails, with the reason. Take the condition text and the reason from the item or the record it cites. List neither the conditions that every option meets nor the comparison axes in `background` or `blocks`: the page shows the conditions in the evidence, and the axes go in a `folded` block or as an `excerpt` of the record, except an axis the `recommendation_reason` names.

### Looks: images and samples

- When options differ in how something looks (on a screen, in a message, in a printed document), give every option a visual, so that the owner compares the looks, not descriptions of them.
  - Give an option an `image` where a screenshot or a UI reference image shows its look: the current screen for an option that keeps today's look, the UI reference for an option that follows the design. A case keeps its UI reference images under `ui-references/` of the case root, and the screenshots of the screens of the design under the paths of its `user_confirmations`.
  - Give it a `sample` where the difference lies in the text's size, weight or colour and the deliverables or the cited code state those values. Take every value from a cited source, and `text` from the text actually shown. A value the cited code leaves unset is the one it inherits, or the browser default where nothing above it sets one, and the evidence's `note` says which.
  - When no source lets an option be shown, say so in the card's `background` in plain words, naming the option: `選択肢 B の画面はまだデザインがありません。`
- On a card that asks whose scene is on a screen, give `scene_image` the screenshot or the UI reference image of that screen, so that the owner sees which screen the question is about. The page shows it right under `scene`, always. It is not an option's look (that is the option's `image`). Take it from the same sources as an option's `image`, and leave it out where no source shows the screen.

### Before and after

- Show a before/after comparison as the before side, an arrow, then the after side: two separate tables or screens (a `before-after` block), never one table with before and after columns. Screens are compared as `今` and `変更後`.
- Show only the current screen and the adopted after-state there. How the other options would look goes in those options.
- Write a `diff` only where a deliverable or an item states the after-state, and cite it in `after_source`. Where nothing states it yet (an implementation that the design or the implementation will settle), show the current lines as `current` evidence, and say in its `note` which stage decides the after-state.

### Diagrams

- Draw as a `diagram` a change or a behavior that has two or more steps or a branch, and a decision that involves several actors, screens, APIs or outside systems: a `flowchart` for steps and branches, a `sequenceDiagram` when the point is who exchanges what with whom, and a `stateDiagram` when the point is how a state moves. Put in it only what the deliverables, the items or the evidence state. Write its node text under the rules above, with no code identifier or file path.
- When the flow differs between now and after the change, put a `diagram` on both sides of the `before-after` block.
- When the flow after a choice differs by option, give every option a `diagram`, unless the card's scene diagram already draws each option's flow.
- On a card that asks whose scene has two or more steps or a branch, keep `scene` as text and make the first `diagram` block of `blocks` the scene's flow: a `flowchart LR` with one `subgraph` for the steps that every option shares and one for each option's flow, splitting at the step where the flows actually part. Color it with `classDef` on the nodes and `style` on the subgraphs by outcome, and mark no recommendation in it:

  | Part | Color | Nodes | Subgraph |
  | --- | --- | --- | --- |
  | The shared steps | blue | `fill:#e8eefb,stroke:#2f5bd3,color:#1b2a4a` | `fill:#f6f8fd,stroke:#2f5bd3` |
  | The flow that resolves the matter | green | `fill:#e8f3ec,stroke:#2e7d4f,color:#17402a` | `fill:#f4faf6,stroke:#2e7d4f` |
  | The flow that leaves the matter | red | `fill:#fbeaea,stroke:#c0392b,color:#5c1a14` | `fill:#fdf6f5,stroke:#c0392b` |

  ```text
  flowchart LR
    subgraph S[共通の手順]
      a[予約を受け付ける] --> b[診察が終わる]
    end
    subgraph OA[案 A の流れ]
      c[会計待ちにできる]
    end
    subgraph OB[案 B の流れ]
      d[会計待ちにできない]
    end
    b --> c
    b --> d
    classDef shared fill:#e8eefb,stroke:#2f5bd3,color:#1b2a4a
    classDef resolves fill:#e8f3ec,stroke:#2e7d4f,color:#17402a
    classDef leaves fill:#fbeaea,stroke:#c0392b,color:#5c1a14
    class a,b shared
    class c resolves
    class d leaves
    style S fill:#f6f8fd,stroke:#2f5bd3
    style OA fill:#f4faf6,stroke:#2e7d4f
    style OB fill:#fdf6f5,stroke:#c0392b
  ```

- On an `nr` card of a `design` page whose processing has two or more steps, the first `diagram` block instead draws the whole process as a `flowchart LR`: the normal steps in the blue above, the place where the problem occurs in the red, and the failures the design already handles in the green, so that the three read apart. Each option's flow goes in that option's `diagram`.
- In a node or edge label, put a part in `（）` on a line of its own with `<br/>`: `デジタル診察券を持っているか<br/>（オプション契約の病院だけ）`.

## Reading the reply

The reply is text that the page assembled from the owner's answers, in page order, one block for each answered card, with one blank line between blocks:

```text
{verdict line}

修正してほしいこと
{the owner's own request for a revision}

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

  The owner chooses it in the box 「あなたの判定」 of the page, and the page cannot be sent without it. The page does not derive it from the answers, but it does not let the Approve line go with a revision choice (`fix` on `must-fix` and on `review-must-fix`), so a reply with a `fix` has the Revise line.
- The block `修正してほしいこと` comes only right after the Revise line, and only when the owner wrote something in the box that opens with the Revise choice. It has no card number. Its text is the owner's own request for a revision, which is read in the same way as a request to fix that the owner wrote outside the layout (Verdict, below).
- A card block has the card's `number` and `title` as they are. A number with a round mark (`MF-1-r2`, step 6) names the item `MF-1` of that round: read the answer for that item, not for the earlier card of the same number. Its answer line is `{key}. {label}` for a lettered option, or the reply text of a fixed choice: `調べてから決めて`, `ビジネス側に確認する`, `その他`, `指摘のとおり修正する`, `今回は対応しない`, `承認`, `却下`, `保留`, `残す`, `不要`, `修正して再レビューする`, `現状で完了する`. A card with free text only has no answer line. The `補足` line is the owner's free text, when there is any.
- On a requirement `open-questions` page, an answer line ends with `（仮置き: ビジネス側に確認してから確定）` while the owner has checked 「仮置き（ビジネス側の確認待ち）」 of the card. Read the line without that ending as usual: the decision is provisional, put in place for now, and the business side has yet to confirm it. The answers `調べてから決めて` and `ビジネス側に確認する` never carry it.
- A card with no block is unanswered.

Read each block by its card:

- **question**: `{key}. {label}` is the decision. `調べてから決めて` means: investigate, then decide. `ビジネス側に確認する` means: no decision yet, the owner takes the question to the business side before deciding, and the `補足`, when there is one, is what the owner wants to ask. `その他` with a `補足` is the owner's own answer, read as a free-text decision. No block means unanswered: present again those numbers only, as a new page.
- **nr**: `{key}. {label}`, or `その他` with a `補足`, is the decision. Unanswered means the recommended option, under an approve verdict.
- **must-fix**: `指摘のとおり修正する` is a revision request. `今回は対応しない` is compatible with approval, and you keep it as declined by the owner's decision.
- **structural-proposal**: `承認`, `却下` or `保留`, with the `補足` as the reason for `却下` and `保留`. Unanswered means the recommended choice.
- **adr**: `残す` keeps the record. `不要` means it is not needed. Unanswered keeps it.
- **review-must-fix**: `修正して再レビューする` chooses a fix. `現状で完了する` agrees to complete as it is. Unanswered means `現状で完了する`, under an approve verdict.
- **review-decision**: `{key}. {label}` names the option under that key. An option with a `fix` is adopted, and its `fix` is what the implementation is given. An option without `fix` keeps the current behavior. `今回は対応しない` defers it. `その他` takes the disposition its `補足` states; when the `補足` states none, ask the owner. Unanswered is undecided.
- **unmet-criterion**, **screen-verification** and the part 目標外の事柄 (`noticed`): they have no answer. A noticed matter is fixed only when the owner names it in the reply.
- **Verdict**: the approve line approves the deliverable or the change. The revise line, or a request to fix it that the owner wrote outside the layout, is a revision request: its content is the revision choices and that text (the block `修正してほしいこと` is that text, and it may be the whole content when no card has a revision choice). A hold, a redesign or a send-back is read from that text. An approve line with no block and no other text is a blanket approval. A matter you noticed goes to the one who fixes only when the owner names it.
- A `補足` with no answer line, on a kind not named above, is free text you read with the unit's own criterion.
- A reply that does not follow the layout is read as free text in the same way.

A reply that asks for a clearer or different explanation of some items instead of answering them (`分からない`, `もっと分かりやすく`, `図で説明して`) leaves those items unanswered.
Write a new page for those items, with the same items unchanged, and the explanation made clearer: explain what the owner found unclear, draw what they asked to see (a `diagram`, a concrete case in `scene`), and write the numbers of those items, as the page shows them, into `clarified_numbers`. Pass the owner's reply whole as `previous_reply`. Do not explain the items in a plain message instead.
A question about the change or the deliverables themselves is not such a request: answer it in the `background` of a new page that carries the same items, with the owner's reply whole as `previous_reply`. A request for a different deliverable is a request of its own, outside the page: the page keeps waiting.

When the owner's reply leads to a revision, make it, present the changed items again on a new page with `previous_reply`, and go on until the owner approves.
