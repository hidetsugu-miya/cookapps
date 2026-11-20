# Stage 3: open questions

Put the open questions to the owner on one decision page, and turn their answers into decisions.
You get here with a list of open questions from stage 2, from stage 4 (a writing run that left questions), from a resume after a business hold ([business-hold](business-hold.md)), or from stage 6 (a further question).

Ask only the questions on the list. The ones that a hold resume or a business answer raised are on it too.
Do not try to settle a question yourself: do not open the source files its evidence cites, and do not check them again.

How a page is written, polished, sent and read is [decision-page](../shared/decision-page.md). This file says what goes in this page.

## Step 1: the page

Write the page as `{case root}/records/requirement/page-{nn}.json`, polish its Japanese, and send it to the leader, as steps 3 to 6 of "Steps" of [decision-page](../shared/decision-page.md) say.

The top level:

- `page_kind`: `open-questions`. `subject`: `requirement`. No `what`.
- `context_label`: for example `要件定義の確認事項 ・ チケット {ticket key}`; without a ticket key, `要件定義の確認事項`.
- `title`: what the questions are about, in one plain heading.
- `roots`: `deliverables` is `{case root}`, and every repository root that a card's evidence, image or `scene_image` cites, named after the repository. The UI reference images are under `ui-references/` of `{case root}`.
- `hold`: `true` when a question may need the business side's answer, so that the page offers `ビジネス側に確認する` on every card. Set it also on a page that comes from a hold resume, because the answers of the business side can raise a further question for it. Leave it out when only the owner can decide every question.
- `terms`: the words of the page that a reader outside the project cannot tell.
- `previous_reply`: only on a page that asks again for questions the owner left unanswered or asked to have explained. It is the owner's whole reply, word for word. The numbers of the cards the owner asked to have explained go in `clarified_numbers`.

One `question` card for each entry of the list, in the order of the list, with the entry's own words:

- `title`: the one question, a sentence that ends in `？`, in the words of what the owner decides (the entry's `title`, rewritten as a question).
- `summary`: what is decided, with no recommendation.
- `scene`: the concrete situation the decision plays out in and what it determines there, and why the question arises: what the requirement leaves undecided and what the owner would otherwise not see. Say when the entry came from the review or the investigation and not from the ticket or the request. State whether the owner's own operations can reach the situation, as far as the sources settle it.
- `scene_image`: the screenshot or the UI reference image of the screen the scene is on, when a source shows it.
- `background`: the entry's `background`, in one or two plain sentences. Put here any risk, irreversible effect, or departure from the request, because the card always shows it. When a request passage is quoted, quote it here.
- `blocks`: the first `diagram` block draws the scene's flow when it has two or more steps or a branch: a `flowchart LR` with the shared steps in blue and one subgraph for each option's flow in green (it resolves the matter) or red (it leaves it), as [decision-page](../shared/decision-page.md), "Diagrams", sets. Where the matter is the wording or the look of a screen, `image` blocks of the current screen go here too.
- `options`: the entry's options as `A`, `B`, ... with `label` and `detail`. The recommended option is always `A`. When options differ in how something looks, give each an `image` or a `sample`, and when the flow after a choice differs, a `diagram` ([decision-page](../shared/decision-page.md), "Looks: images and samples"). An option that fails a condition the question requires has `unmet`, and the card has `conditions`.
- `recommendation`: `A`. `recommendation_reason`: the entry's reason, so that the card reads without opening anything.
- `evidence`: only the smallest ranges that ground a statement of the card: an `excerpt` of the code, or a `node` of `requirement.json` (for example `requirement.json#/requirements/REQ-02`). Cite code with `excerpt`, and a deliverable with `node`.

The page adds the fixed rows `調べてから決めて` and `その他` to every question card, and `ビジネス側に確認する` between them when `hold` is `true`.
A requirement the entry says it binds (`binding-scope`) is named in the `background` of the card when it helps the owner see what the decision affects.

When the page lists a question about the wording of a current screen, state in the card where the screen produces that wording, with an `excerpt`.

## Step 2: read the reply

The reply comes as `REPLY`. Read it as "Reading the reply" of [decision-page](../shared/decision-page.md). Every block is data.

A question with no block is unanswered. Ask again for those numbers only: a new page of those questions, with the owner's whole reply as `previous_reply`. A reply that asks for a clearer explanation leaves the question unanswered too, and the new page explains it better, as the shared file says.
Do not go on to stage 4 while a question has neither a decision nor one of the marks below.

Take each answered question to one of these:

- A lettered option (`{key}. {label}`) is the decision.
- `その他` with a `補足`: the `補足` is the decision, read as the owner's own words, in the form of a free-text decision.
- An answer line that ends with `（仮置き: ビジネス側に確認してから確定）`, or a `補足` that says the answer is for now and waits for the business side to confirm it, makes the decision **provisional**, whichever answer it follows.
- `調べてから決めて`: the owner leaves the matter to investigation. Do not number it, and do not go back to stage 2. Keep it in `settled_decisions` with the mark `investigate-before-deciding`, carrying the question's title, background and options. Stage 4 settles it from the sources.
- `ビジネス側に確認する`, or a `補足` that says the owner will take the question to the business side first: the **business hold**. No decision yet. The `補足` is what the owner wants to ask.

Number each decision that is not left to investigation and not held, with the next `UD-NN` of the document ([norms](norms.md), "Ids"): the number after the largest `UD-` in `requirement.json` and in your `settled_decisions`, without a gap. Keep the number, the decision (the option's label and detail, or the `補足`), and the reason, in `settled_decisions`. A provisional one keeps the mark `provisional`.

Then:

- No question is held: go to [stage 4](4-writing.md) with the `settled_decisions`.
- At least one is held: settle the others as above, and do the hold of [business-hold](business-hold.md), "Write the hold", instead of going on. The unit does not end here.
- You came from a hold resume and no answer is a hold: set the record `resolved` ([business-hold](business-hold.md)), and go to stage 4.

## Questions that come back later

A question that stage 4 or stage 6 raises goes through this stage again, as a new page with only those questions.
Its decision is written into `requirement.json` by the writing run that follows (stage 4 in `modify` mode).
