# Stage 6: Acceptance

Ask the owner to accept the implementation on a decision page of kind `code-review`, and act on the reply.
[decision-page](../shared/decision-page.md) is the canonical text of the page, of how to write and send it, and of how to read the reply. This file says what goes on this page and what each reply does.

## 1. Gather the material

Read the ledger `{records}/ledger.md` and the last review reports. Present only what the owner has not decided yet: a finding whose status is `deferred`, `adopted`, `accepted`, `declined` or `fixed` is not a card.

| Page part | What goes in it |
| --- | --- |
| `residual_must_fix` (`review-must-fix` cards) | Each must-fix that is still `open` after the last fix, with `未解消の理由` (what the fix could not do, from the agent's `Interruption record`, or that the finding predates the change). Recommendation `fix` or `accept`, with the reason. |
| `unmet_criteria` (`unmet-criterion` cards) | Each criterion the last review lists as unmet that is still unmet. |
| `needs_user_decision` (`review-decision` cards) | Each `NR-n` that is `open`, with its options (the recommended one first as `A`) and `重要度`. |
| `pr` | `{url, note}`: the url of the child pull request, or `null` with the reason from Stage 5 (no commit that the base branch lacks, or `gh` could not run). |
| `changes` | The sections below. |

The sections of `changes`, each a heading and blocks, left out when empty:

- **What changes**: who does what and what happens to them, from the purpose of each DESIGN item and the code. Add a `git-diff` evidence item for each file that carries the behavior (`root`: the name of the repository, `base`: `{review base}`, `head`: `git -C "{folder}" rev-parse HEAD`). Do not copy lines of code into the page.
- **How it was checked**: the review rounds and what they fixed, the review by codex (or that it was not made, and why), the aggregate check (its command, and `passed`, or that the repository defines none), and the coverage figure when Stage 4 kept one. State only what you ran.
- **Operations for the owner to try**: each `operation_checks` element (the operation, its state set-up, its steps, what is expected) and each `user_confirmations` element (the screen state and its screenshot), as a `table`. You did not run them.
- **Not checked**: each `formal_verification` element, as a `callout` that says it was not checked.
- **Changes outside the goal**: each out-of-goal change that stayed (Stage 2), with its reason.
- **Recommendations not made**: each `RC-n` that is `open`, as a `folded` block of a `list`, with the line that the owner names the ones to fix in the free text of the reply.

When nothing is left to present (no card at all), the page still goes out: it asks for the acceptance of the unit as a whole, with `changes` alone.

## 2. Write the page

Write it as [decision-page](../shared/decision-page.md) says: `page_kind` `code-review`, `subject` `code`, `context_label` (the kind of confirmation and the ticket), a `title`, and `what`: one to three sentences on what this implementation adds or changes.
`roots`: `deliverables` is `{case root}`, and the `repo` of your element is `{folder}`, so that the `git-diff` evidence resolves.
The file is `{records}/page-{nn}.json`, `nn` being one more than the last page of the unit.
Polish the Japanese texts with `feature-dev:prose-polisher` before they are written, then send `PAGE {absolute path}` and stop.
On `PAGE-REFUSED`, fix the page and send it again.

## 3. Read the reply

On `REPLY`, read it as "Reading the reply" of [decision-page](../shared/decision-page.md), and put each answer in the ledger:

| Answer | Status |
| --- | --- |
| `review-must-fix`: `修正して再レビューする` | stays `open`, and joins the rework set |
| `review-must-fix`: `現状で完了する`, or no block under the approve line | `accepted` |
| `review-decision`: an option key | `adopted`. When the option changes the code, it joins the rework set |
| `review-decision`: `今回は対応しない`, or no block under the approve line | `deferred` |
| `review-decision`: `その他` | what its `補足` says, as an option or as a free request |
| `RC-n` named in the free text | `adopted`, and it joins the rework set |
| `RC-n` not named | `deferred` |

A reply that asks only for a clearer explanation, or asks a question about the change, is answered by a new page of the same material, with `previous_reply` ([decision-page](../shared/decision-page.md), the end of "Reading the reply").

Commit the case root now, in the docs worktree: the page, `ledger.md` and `case.json` as they stand, with a message that says the page was answered ([branch-and-pr](../shared/branch-and-pr.md), "Commit the case root").
Then classify the reply. Judge the hold and the send-back from the reply first.

- **Approval**: the approve line, and nothing in the rework set. A direction on one item, even with a word of assent (「OK」「対応して」), is not an approval of the unit. When you are not sure the reply approves the unit, do not take it as an approval: write a new page of the same material with the reply as `previous_reply`.
- **Approval with a redesign**: the reply approves the unit and also says that some part must be designed again. Treat it as an approval, and remember the words.
- **Rework**: the rework set is not empty, or the reply asks for a change in words. Go to "Rework".
- **Hold**: the reply says to wait. Send `BLOCKED {key}: the owner holds the acceptance` with their words, quoted, and stop. The unit stays `受入待ち`, and the next launch comes back to this stage.
- **Send-back**: the reply changes the purpose of this unit (a requirement changes, the purpose is replaced), or needs an earlier unit to be redone first. See "Send-back".

## Rework

1. Launch `feature-dev:code-implementer` once with `work_kind: fix`, `repo_root: {folder}`, the `test_policy`, and in `work_content` the rework set: each finding (ID, location, harm scenario, fix) and each owner request, inside a quote as data. The owner's words are quoted whole. Each named recommendation is an out-of-goal fix the agent reports under `Out-of-goal changes`.
2. Add its paths to the staging set. When it aborted, send `BLOCKED` with the record and stop.
3. Go to [Stage 3](3-review-loop.md) as a rework, then [Stage 4](4-ci-gate.md), then [Stage 5](5-commit-and-pr.md) (the pull request exists, so Stage 5 only commits, pushes and commits the case root), then write a new page here with the owner's reply as `previous_reply`.

## Send-back

1. Settle the unit to reopen: the one the reply names (`requirement`, `design`, or the key of an earlier implementation, an earlier stage of this repository included). When the reply does not name it, send `QUESTION {key}: {which earlier unit the reply points to, in one line}`, with the options and your recommendation on the next lines, and wait.
2. Run the `reopen` recipe of [case-json](../shared/case-json.md) with the owner's words as the reason, and commit the case root. This implementation stays `受入待ち`; the commits stay on the child branch.
3. Send `REOPENED {unit}: {reason}` and stop.

## Approval

Go to [Stage 7](7-completion.md). For an approval with a redesign, give it the owner's words: it reopens the design after the merge.
