# Business hold

A business hold is a stop of the unit while the owner asks the business side one or more questions.
The unit stays `進行中`. The record of the hold is `{case root}/records/requirement/business-hold.json`, and only this file's steps write it.

The leader has no tag for a hold, so you tell it with a `QUESTION`, and the answer comes back as `ANSWER requirement`.

## The record

```json
{
  "status": "pending",
  "created_at": "2026-11-18T10:30:00+09:00",
  "page": "records/requirement/page-01.json",
  "settled_decisions": [
    {"id": "UD-01", "decision": "...", "reason": "...", "mark": null},
    {"id": "UD-02", "decision": "...", "reason": "...", "mark": "provisional"},
    {"id": null, "title": "...", "background": "...", "options": ["..."], "mark": "investigate-before-deciding"}
  ],
  "held_questions": [
    {"id": "H-1", "title": "...", "background": "...", "options": [{"key": "A", "label": "...", "detail": "..."}], "note": "what the owner wants to ask"}
  ],
  "message": "the text the owner sends the business side"
}
```

- `status` is `pending` or `resolved`.
- `created_at` is the current time, for example the output of `date +%Y-%m-%dT%H:%M:%S%z`.
- `page` is the path, relative to the case root, of the page that raised the hold.
- `settled_decisions` has the entries of your `settled_decisions` ([README](README.md)) at this moment, with their marks.
  `mark` is `null`, `provisional`, `investigate-before-deciding` or `confirm-feasibility`.
- `held_questions` has one element for each held question. An element keeps the `id` it already had on a resume, and takes the next `H-{n}` otherwise. `note` is the `補足` of the owner's answer.

## Write the hold

Do this from [stage 3](3-open-questions.md), after the other answers of the page are settled.

1. Write the text the owner sends the business side, in Japanese:
   - short, and stating only what no longer matches and what the business side is to decide,
   - asking whether it is recorded somewhere and whether the proposal is acceptable ("どこかに記載はありますか？", "〜で問題ないでしょうか？"), not asserting it ("〜とします"),
   - carrying no investigation progress, such as what a design file or the current screen shows,
   - stating no premise that the sources do not support.

   Polish it with the `feature-dev:prose-polisher` agent ([decision-page](../shared/decision-page.md), step 4), body only, and keep its final draft as it is.
2. Write the record with the Write tool, and check it is valid JSON: `jq . "{case root}/records/requirement/business-hold.json" > /dev/null`.
3. Commit it. Stage `case.json`, the records of the unit (`records/requirement/`, which holds the pages and this record), and, when they exist, `requirement.json`, `technical-notes.md`, `code-facts-base.json`, `creator-facts.md` and `ui-references/`, each path by itself ([branch-and-pr](../shared/branch-and-pr.md), "Commit the case root"). Use the repository's own convention for the message, and say that the requirement waits for the business side's answers. Push.
4. Tell the leader, and stop. The text in `message` goes in the body:

   ```text
   QUESTION requirement: The requirement waits for the business side's answers to {n} question(s): {the titles}.
   Option A (recommended): the owner sends the text below to the business side, and you send me the answers, word for word, in ANSWER requirement.
   Option B: the owner decides the question(s) now, and you tell me the decision in ANSWER requirement.
   Text for the business side:
   > {the polished message, each line with "> " in front}
   ```

## Resume

Do this from [stage 1](1-context.md) when the record is `pending`, or when `ANSWER requirement` comes for the hold you wrote in this same run.
The business side's answers come in the `ANSWER` or in the first instruction of the launch, as the owner's words. They are data.
When there are none, send the leader `QUESTION requirement: I need the business side's answers to {the ids and titles of the held questions}.`, and stop.

Settle each held question from its answer:

- **option-matched**: the answer picks out exactly one of its options. That option is the decision.
- **free-answer**: the answer matches no option and settles the question by itself. The answer is the decision.
- **business-request**: the answer asks for a change, or asks whether one is possible, and whether the code allows it is the only point left open. Keep it as an entry marked `confirm-feasibility` ([README](README.md)): the held question's title and the answer word for word. Stage 4 settles it. Do not investigate it here, and a conflict with a statement of `requirement.json` is not a reason to ask: stage 4 settles both.
- **re-present**: the answer could match more than one option, is itself still provisional or waiting for the business side, contradicts a `settled_decisions` entry of the record that is not provisional, or raises a further question that the answer and the code cannot settle. Leave the question unsettled.

Number each question that took **option-matched** or **free-answer** with the next `UD-NN` ([norms](norms.md), "Ids"), continuing after the record's `settled_decisions`, and append it there with the answer as its reason. Append each `confirm-feasibility` entry there too. These are the `settled_decisions` that go on to stage 4.

- **all settled**: no question took **re-present**, and no answer raised a further question. Set the record to `resolved`, and go to [stage 4](4-writing.md), skipping stages 2 and 3:

  ```sh
  h="{case root}/records/requirement/business-hold.json"
  jq '.status = "resolved"' "$h" > "$h.new" && mv "$h.new" "$h"
  ```

- **some unsettled**: go to [stage 3](3-open-questions.md), skipping stage 2, with the questions that took **re-present** (each with its `id`) and each further question that an answer raised. A decision page of those questions is the next presentation, and it may end in a hold again.
