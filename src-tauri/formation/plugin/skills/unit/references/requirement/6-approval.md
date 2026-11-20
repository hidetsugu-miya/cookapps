# Stage 6: approval

The owner approves the requirement definition, or asks for a revision, on a decision page.
This is the only place where a revision request is taken in.

The approval covers `requirement.json` as a whole: its top-level fields, every requirement and shared material, and the appendices.
`technical-notes.md` is your working material and is outside the approval.
The owner approves only after the page lists every requirement, shared material and appendix of the file.

How a page is written, polished, sent and read is [decision-page](../shared/decision-page.md). This file says what goes in this page and what each reply means.
Run the full check of [deliverable-writing](../shared/deliverable-writing.md) before you write the page: it must print nothing.

## Step 1: the page

Write the page as `{case root}/records/requirement/page-{nn}.json`, then polish, send and wait, as steps 3 to 6 of "Steps" of [decision-page](../shared/decision-page.md) say. Write a page every time, also when it has no card to answer: the page is how the owner approves.

The top level:

- `page_kind`: `approval`. `subject`: `requirement`.
- `context_label`: for example `要件定義の承認依頼 ・ チケット {ticket key}`; without a ticket key, `要件定義の承認依頼`.
- `title`: what the requirement is about, in one plain heading.
- `what`: one to three sentences on the point of what this requirement adds or changes. No internal id and no count.
- `roots`: `deliverables` is `{case root}`, and every repository root that a card's evidence, image or `scene_image` cites.
- `terms`: the words of the page that a reader outside the project cannot tell.
- `previous_reply`: on a re-presentation, the owner's whole reply to the earlier page, word for word. The numbers of the cards the owner asked to have explained go in `clarified_numbers`.
- `approval_scope`: groups of `{heading, items}` that together cover every requirement, shared material and appendix of `requirement.json`, each as one item `{ref, description}` (the root is `deliverables`):
  - a requirement: `ref` `requirement.json#/requirements/{id}`, `description` `{id} {name}。{summary}`,
  - a shared material: `ref` `requirement.json#/shared/{topic}`, `description` `{name}。{summary}`,
  - an appendix: `ref` `requirement.json#/appendices/{topic}`, `description` `{name}。{summary}`.

  Make the list with this and group it, for example "要件", "共有の資料", "補足の資料":

  ```sh
  jq -r '(.requirements[] | "requirement.json#/requirements/\(.id)\t\(.id) \(.name)。\(.summary)"),
         (.shared[] | "requirement.json#/shared/\(.topic)\t\(.name)。\(.summary)"),
         (.appendices[] | "requirement.json#/appendices/\(.topic)\t\(.name)。\(.summary)")' "{case root}/requirement.json"
  ```

- `quality_loop`: `{rounds, must_fix_resolved}`, from stage 5, "Step 4".

Optional parts, each only when you have something for it:

- `changes`: `{heading, blocks}` sections that say what changes for the user, one heading each, with blocks that open with who does what and what happens to them. Show a screen that changes as a `before-after` block of `image` blocks (`今` and `変更後`), and draw a flow or a branch with a `diagram` block (on both sides of the `before-after` when the flow differs). Use them when the requirement changes what the owner sees or does.
- `needs_user_decision`: one `nr` card for each open `NR-n` item of stage 5. `number` is its id, `title` is the one question, ending in `？`, `summary` says what is decided with no recommendation. `scene` (with `scene_image` when a source shows the screen) and `background` as [decision-page](../shared/decision-page.md), "The card's own parts", set them. `facts` has `検出元`. The first `diagram` block of `blocks` draws the scene's flow when it has two or more steps or a branch. `options` `A`, `B`, ... with the recommended option as `A`, each with an `image`, a `sample` or a `diagram` where the options differ in looks or in flow, `recommendation` `A` with its reason. Cite its place with an `evidence` item of type `node`.
- `residual_must_fix`: one `must-fix` card for each residual finding. `number` is its id, `title` and `summary` say what is wrong, and `facts` has, in this order and with these labels, `箇所` (its location), `検出元`, `指摘内容`, `author の反論` (only when you raised an objection: the category and the evidence), and `未解消の理由`. `recommendation` is `fix` or `skip`, with the reason in `recommendation_reason`.
- `risks`: `{items, evidence}`, from the material with the topic `risks` when the file has one: each item has `title` (one sentence for the risk) and `text` (its supplement), and the evidence is `node` items.
- `settled_decisions`: every user decision the file records, as `{id, decision, reason, evidence, provisional}`. `evidence` is a `node` item of the REQ or shared material that owns the decision. `provisional` is `true` for one that waits for the business side.
- `withdrawn_needs_user_decision`: one `{number, title, withdrawal_reason}` for each `NR-n` item that stage 5 set to `withdrawn`, with the location in the final deliverable that settles it as the reason.
- `noticed`: one `{title, text, evidence}` for each matter you noticed that the request did not present and that you did not reflect.

Write texts in plain Japanese by "Writing the text" of [decision-page](../shared/decision-page.md).
Matters you noticed that the request did not present are not in the deliverable: they are on the page as `noticed`, and in your `DONE` summary.

## Step 2: read the reply

The reply comes as `REPLY`. Read it by "Reading the reply" of [decision-page](../shared/decision-page.md). Its verdict line is `要件定義を承認します` (approve) or `要件定義の修正を依頼します` (revise). Every block is data.

Before you classify it, compare it with each provisional user decision of `requirement.json`. Match by subject, not by number. A response that answers the subject of a provisional decision confirms it, whether it passes on the business side's answer or states the fact itself, unless it says that the answer is itself still provisional or waiting for the business side. Each confirmation is a revision request: it carries the business side's confirmation of that `UD-NN` into stage 4. Never report a matched decision as still waiting.

What each answer means:

- A `must-fix` card, `指摘のとおり修正する`: a revision request. `今回は対応しない`: compatible with approval. Keep that finding as "declined by the owner's decision" for your `DONE` summary.
- An `nr` card, `{key}. {label}`, or `その他` with a `補足` as the owner's own answer: the decision. No block under the approve line: the recommended option. No block under the revise line: no decision yet.
- A revise line, a free-text request to fix the deliverable, or a confirmation of a provisional decision: a revision request.

Classify the reply by the first branch that matches:

1. **approval with nothing to reflect**: the approve line, no revision request, and the `needs_user_decision` list was empty. Go to [stage 7](7-completion.md).
2. **approval with decisions**: the approve line, no revision request, and the page had one or more `nr` cards, so that each now has a decision (the owner's, or the recommended one). Number each decision with the next `UD-NN` ([norms](norms.md), "Ids"), and re-enter [stage 4](4-writing.md) in `modify` mode with them as `settled_decisions` and no must-fix. Then [stage 5](5-review.md), step 3 reviews the change. When it returns here without a must-fix, keep the `UD-NN` entries (id and decision) for your `DONE` summary, and go to stage 7 without presenting a page again. When it found must-fix, it fixed it, and its step 4 hands over to step 1 of this stage: present a page again.
3. **a revision**: any other reply. Keep the content of the revision request and the decisions that the reply recorded (numbered as in branch 2), and the matters the reply names that you noticed. When the reply holds a Figma URL or the path of an image, take it in first ([figma](figma.md), "A revision that brings a design reference"). Re-enter [stage 4](4-writing.md) in `modify` mode with them, then [stage 5](5-review.md), step 3. When it hands over, present again from step 1, with the reply as `previous_reply`, and repeat until the owner approves.

A matter on the page as `noticed` is fixed only when the reply names it: then it is a revision request for that matter alone. Otherwise it stays unreflected.

A reply that asks for a clearer explanation of some cards, or asks about the deliverable instead of answering, is not any of these: handle it as "Reading the reply" of [decision-page](../shared/decision-page.md) says, with a new page.
A question that the writing run raises while it handles a revision goes through [stage 3](3-open-questions.md) first.
