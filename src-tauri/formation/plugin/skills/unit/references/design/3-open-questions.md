# Stage 3: Open questions

Ask the owner what only the owner can settle, on one decision page, and keep the answers.
Skip this stage when the list of stage 2 is empty and there is no `layer question` (stage 1): go to [4-authoring](4-authoring.md) with no settled decisions.

You write the page as [decision-page](../shared/decision-page.md) says. This file says which questions go on it, and what you do with the answers.

## Steps

### 1. Sort the questions

Take every entry of the open-question list of stage 2, and the `layer question` of stage 1. Route each by its kind.

| Question | Route |
| --- | --- |
| `decision_kind` is `value` | On the page. |
| `execution_probe` is not `null` (a branch only execution can settle) | On the page, whatever its kind. This flow runs no experiment: `background` states what you investigated, what the sources leave open, and the observation that would separate the options, and says that the observation was not run. |
| `fact`, and `background` says the needed information lies outside every source you can reach | On the page. |
| The `layer question` | On the page, with the three layers as its options. The default of stage 1 is `A`. |
| Any other `fact` | Not on the page. Stage 4 settles it directly from its `recommendation` and its reason, and writes the grounds in `key_decisions`. Keep it in `settled decisions` as an instruction to confirm there. |

Number the questions of the page `論点1`, `論点2`, and so on, in the order they stand on the page.
The numbers of the pages of the requirement unit (`UD-NN`) are not used here, so that the two never collide.

When no question is left for the page, skip to step 4 with the entries that stage 4 settles.

### 2. Write the page

Write an `open-questions` page ([decision-page](../shared/decision-page.md), "The page"):

- Top level: `schema_version` 1, `page_kind` `open-questions`, `subject` `design`, `context_label` (the kind of confirmation and the ticket, for example `基本設計の確認事項 ・ チケット {ticket key}`; leave the ticket out when there is none), `title`, and `roots`: `deliverables` is `{case root}`, and one root for each repository an evidence item cites (its name and `{repo root}`).
- `questions`: one `question` card for each, from the entry:
  - `number`: `論点{n}`.
  - `title`: the one question the card asks, a sentence that ends in `？`, in the words of what the owner decides, not in implementation words.
  - `summary`: what is decided, in one or two sentences, with no recommendation.
  - `background`: the gap or premise the decision needs, in one or two plain sentences: what you investigated and why it did not settle the matter. Put here any fact that could change the answer. For a question with an `execution_probe`, put the observation here.
  - `options`: `A`, `B` and `C` in order, each with `label` (in the words of what the owner decides) and `detail` (what happens when it is chosen, then what it gives up or risks). The recommendation is always `A`: order the options so that the recommended one is first.
  - `recommendation` `A`, and `recommendation_reason`: why, in words the card shows by itself.
  - `evidence`: `node` items for the nodes of `requirement.json` or `design.json`, `excerpt` items for the smallest range of code that grounds a statement (`root`, `path`, `start`, `end`). A `diagram` block in `blocks` when the question concerns a flow of two or more steps, a branch, or several actors.

  ```json
  {
    "kind": "question",
    "number": "論点1",
    "title": "…するか？",
    "summary": "…",
    "background": "…",
    "options": [
      {"key": "A", "label": "…", "detail": "…"},
      {"key": "B", "label": "…", "detail": "…"}
    ],
    "recommendation": "A",
    "recommendation_reason": "…",
    "evidence": [
      {"type": "excerpt", "root": "shop-api", "path": "app/models/order.rb", "start": 10, "end": 18}
    ]
  }
  ```

- Write one point to a sentence, and name who acts. Do not paraphrase an item in a way that changes its meaning: keep every number, condition, negation and scope.

Then polish, write the file to `{records}/page-{nn}.json`, and send `PAGE`, as [decision-page](../shared/decision-page.md) says, and stop.

### 3. Read the reply

When `REPLY` comes, read it as [decision-page](../shared/decision-page.md), "Reading the reply", says.
For each question:

- `{key}. {label}`: that option is the decision.
- `調べてから決めて`: the owner wants it investigated before the decision. Do not return to stage 2. Keep it as an instruction for stage 4 to confirm directly and settle there from your own investigation, and say so in `key_decisions`.
- `その他` with a `補足`: the `補足` is the owner's own answer, a free-text decision. Take it word for word.
- No block: unanswered. Present again those numbers only, as a new page (step 2, with the owner's reply as `previous_reply`), and read that reply the same way. A reply that asks for a clearer explanation is handled as [decision-page](../shared/decision-page.md) says.

An answer that amounts to a change of the requirement (it adds or changes what `requirement.json` says) is not settled here: take the case back to the requirement ([1-context](1-context.md), "Send the case back to the requirement") with the owner's words as the reason.

### 4. Keep the settled decisions

Write `{records}/settled-decisions.json`, an array with one element for each question, including the ones stage 4 settles:

```json
[
  {"number": "論点1", "title": "…", "decision": "A. …", "reason": "…", "by": "owner"},
  {"number": null, "title": "…", "decision": "the recommendation of stage 2", "reason": "…", "by": "investigation"},
  {"number": "論点3", "title": "…", "decision": "to confirm in stage 4", "reason": "…", "by": "owner-asked-to-investigate"}
]
```

`by` is `owner` for a decision of the owner (the reason is the owner's `補足` or the option's trade-off), `investigation` for a fact settled by stage 2, and `owner-asked-to-investigate` for `調べてから決めて`. Cite the page in the reason for an owner's decision: its file name and the number.
Keep the same array in your context as `settled decisions`.
The decisions of the owner are settled premises of the design: stage 4 reflects each one, and never puts it to the owner again.

Then go to [4-authoring](4-authoring.md).
