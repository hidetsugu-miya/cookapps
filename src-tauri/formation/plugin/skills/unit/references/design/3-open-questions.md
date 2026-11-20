# Stage 3: Open questions

Ask the owner what only the owner can settle, on one decision page, and keep the answers.
Skip this stage when the list of stage 2 is empty and there is no `layer question` (stage 1): go to [4-authoring](4-authoring.md) with no settled decisions.

You write the page as [decision-page](../shared/decision-page.md) says. This file says which questions go on it, and what you do with the answers.

## Steps

### 1. Sort the questions

Take every entry of the open-question list of stage 2, and the `layer question` of stage 1. Route each by its kind.

| Question | Route |
| --- | --- |
| `decision_kind` is `value`, and no prototype settled it | On the page. |
| `execution_probe` is not `null` and the prototype of stage 2 returned `adopted` or `no-difference` (**compared**) | Not on the page. The decision is the `adopted_option` of an `adopted`, and the `recommendation` of a `no-difference`. Its reason is the return's `reason` and `result_path`. Stage 4 writes the decision as a settled premise. |
| `execution_probe` is not `null` and the prototype returned `inconclusive` | On the page, whatever its kind. `background` states the observation, what the prototype ran and what stopped it (its `reason` and `result_path`). |
| `fact`, and `background` says the needed information lies outside every source you can reach | On the page. |
| The `layer question` | On the page, with the three layers as its options. The default of stage 1 is `A`. |
| Any other `fact` | Not on the page. Stage 4 settles it directly from its `recommendation` and its reason, and writes the grounds in `key_decisions`. Keep it in `settled decisions` as an instruction to confirm there. |

Number the questions of the page `論点1`, `論点2`, and so on, in the order they stand on the page.
The numbers of the pages of the requirement unit (`UD-NN`) are not used here, so that the two never collide.

When no question is left for the page, skip to step 4 with the entries that stage 4 settles.

### 2. Write the page

Write an `open-questions` page ([decision-page](../shared/decision-page.md), "The page"):

- Top level: `schema_version` 1, `page_kind` `open-questions`, `subject` `design`, `context_label` (the kind of confirmation and the ticket, for example `基本設計の確認事項 ・ チケット {ticket key}`; leave the ticket out when there is none), `title`, and `roots`: `deliverables` is `{case root}`, and one root for each repository an evidence item, an image or a `scene_image` cites (its name and `{repo root}`). The UI reference images are under `ui-references/` of `{case root}`. There is no `what`, and no `hold`: the business side's answer is a matter of the requirement only.
- `terms`: the words of the page that a reader outside the project cannot tell, each with its description.
- `previous_reply` and `clarified_numbers`: only on a page that asks again for questions the owner left unanswered or asked to have explained (step 3).
- `questions`: one `question` card for each, from the entry:
  - `number`: `論点{n}`.
  - `title`: the one question the card asks, a sentence that ends in `？`, in the words of what the owner decides, not in implementation words.
  - `summary`: what is decided, in one or two sentences, with no recommendation.
  - `scene`: the concrete situation the decision plays out in and what it determines there, and, right after it, why the question arises: what the design leaves undecided and what the owner would otherwise not see. Say when the entry came from the investigation or a review and not from the ticket or the request. State whether the owner's own operations can reach the situation, as far as the sources settle it. Put here any fact that could change the answer (a risk, an effect that cannot be undone, a departure from the request or from the UI reference), because the card always shows it.
  - `scene_image`: the screenshot or the UI reference image of the screen the scene is on, when a source shows it.
  - `background`: the gap or premise the decision needs, in one or two plain sentences: what you investigated and why it did not settle the matter. For a question with an `execution_probe`, put here the observation that separates the options, what the prototype ran and what stopped it, with its `reason` and `result_path`.
  - `blocks`: when the scene has two or more steps or a branch, the first `diagram` block draws its flow as a `flowchart LR`: the steps every option shares in blue, and one subgraph for each option's flow, green where it resolves the matter and red where it leaves it, as [decision-page](../shared/decision-page.md), "Diagrams", sets. Where the matter is the wording or the look of a screen, `image` blocks of the current screen go here too.
  - `options`: `A`, `B` and `C` in order, each with `label` (in the words of what the owner decides) and `detail` (what happens when it is chosen, then what it gives up or risks). The recommendation is always `A`: order the options so that the recommended one is first. When options differ in how something looks, give each an `image` or a `sample`, and when the flow after a choice differs and the scene diagram does not already draw it, a `diagram` ([decision-page](../shared/decision-page.md), "Looks: images and samples").
  - `conditions` and `unmet`: when an option fails a condition the decision requires (a requirement or a k.o. criterion of `requirement.json`), set the card's `conditions` to every such condition, each as `{id, text}` with the id the record gives it, and the option's `unmet` to each one it fails, with the reason.
  - `recommendation` `A`, and `recommendation_reason`: why, in words the card shows by itself.
  - `evidence`: `node` items for the nodes of `requirement.json` or `design.json`, `excerpt` items for the smallest range of code that grounds a statement (`root`, `path`, `start`, `end`). When a question is about the wording of a current screen, an `excerpt` of the place where the screen produces that wording.

  ```json
  {
    "kind": "question",
    "number": "論点1",
    "title": "…するか？",
    "summary": "…",
    "scene": "…",
    "background": "…",
    "blocks": [{"type": "diagram", "mermaid": "flowchart LR\n  …"}],
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
- No block: unanswered. Present again those numbers only, as a new page (step 2, with the owner's whole reply as `previous_reply`), and read that reply the same way. A reply that asks for a clearer explanation leaves the question unanswered too: the new page explains it better (a `diagram`, a concrete case in `scene`), and its `clarified_numbers` holds the numbers of those cards ([decision-page](../shared/decision-page.md), "Reading the reply").

An answer that amounts to a change of the requirement (it adds or changes what `requirement.json` says) is not settled here: take the case back to the requirement ([1-context](1-context.md), "Send the case back to the requirement") with the owner's words as the reason.

### 4. Keep the settled decisions

Write `{records}/settled-decisions.json`, an array with one element for each question, including the ones stage 4 settles:

```json
[
  {"number": "論点1", "title": "…", "decision": "A. …", "reason": "…", "by": "owner"},
  {"number": null, "title": "…", "decision": "the recommendation of stage 2", "reason": "…", "by": "investigation"},
  {"number": null, "title": "…", "decision": "B. …", "reason": "…", "by": "prototype", "result_path": "…/prototypes/{slug}/result.md"},
  {"number": "論点3", "title": "…", "decision": "to confirm in stage 4", "reason": "…", "by": "owner-asked-to-investigate"}
]
```

`by` is `owner` for a decision of the owner (the reason is the owner's `補足` or the option's trade-off), `investigation` for a fact settled by stage 2, `prototype` for a question that a prototype of stage 2 settled (the reason is its `reason`), and `owner-asked-to-investigate` for `調べてから決めて`. Cite the page in the reason for an owner's decision: its file name and the number.
Keep the same array in your context as `settled decisions`.
The decisions of the owner are settled premises of the design: stage 4 reflects each one, and never puts it to the owner again.

Then go to [4-authoring](4-authoring.md).
