# Stage 6: Acceptance

Ask the owner to accept the implementation on a decision page of kind `code-review`, and act on the reply.
[decision-page](../shared/decision-page.md) is the canonical text of the page, of how to write and send it, and of how to read the reply. This file says what goes on this page and what each reply does.

## 1. Gather the material

Read the ledger `{records}/ledger.md` and the last review reports. Present only what the owner has not decided yet: a finding whose status is `deferred`, `adopted`, `accepted`, `declined` or `fixed` is not a card.
The page does not explain the change. The owner reads that in the child pull request, whose body Stage 5 wrote with every section it needs ("The body of the child pull request" in [branch-and-pr](../shared/branch-and-pr.md)): the page shows the pull request, what asks for an answer, the results of the verification of the screens, and the state of the checks.

| Page part | What goes in it |
| --- | --- |
| `residual_must_fix` (`review-must-fix` cards) | Each must-fix that is still `open` after the last fix, with `検出元`, `未解消の理由` (what the fix could not do, from the agent's `Interruption record`, or that the finding predates the change) and, when it rests on an existing document, `既存の記録`. Recommendation `fix` or `accept`, with the reason. Each screen-verification result that is still `fail` after the last fix (`SV-n`, [goal-verification](goal-verification.md), "Carrying a fail to the page"), and each result of a formal verification that is unsettled (`bug` or `blocked`, numbered `FV-n`), is one such card too. |
| `unmet_criteria` (`unmet-criterion` cards) | Each criterion the last review lists as unmet that is still unmet, with the numbers of the findings that cause it in `cards`. |
| `needs_user_decision` (`review-decision` cards) | Each `NR-n` that is `open`, with its `scene`, its `occurrence`, its options (the reviewer's own words, the recommended one first as `A`, each with the `fix` that choosing it hands to the implementation, when it changes the code), and the facts `重要度`, `検出元` and `既存の記録`. |
| `screen_verifications` (`screen-verification` cards) | Each result of the goal verification that the unit holds ([goal-verification](goal-verification.md), "What the page shows"), `SV-n` in the order the unit holds them, with its viewpoint, `state_setup`, `steps` and `expected` of an operation item, result, basis, `missing_reason` of a `not-run`, and its images: `reference_image` (the item's reference screenshot) and `captured_image` (the capture; a `not-run` has none). A unit that was resumed past Stage 4 shows each item as `not-run`. A unit with no item has none. |
| `policy_deviations` | Blocks: each place where the code departs from `{contract}` (a minor change of the design baseline rule of the [glossary](../shared/glossary.md)), with its reason, and each fact found after the contract was written that the owner should know. |
| `notices` | The state of the checks, as "The state of the checks" of [decision-page](../shared/decision-page.md) says: the aggregate check and the coverage figure, each `environment_fixes` entry, and the other facts about the review that you hold. Add one line for each completion criterion that no screen item covers ([goal-verification](goal-verification.md), "What the page shows"). |
| `noticed` | Each open `RC-n` (title `RC-n`), each out-of-goal change that stayed (Stage 2; title `OG-n`), with its reason, and each `observations` line of the goal verification (title `SV-n-o{m}`). |
| `pr` | `{url, note}`: the url of the child pull request, or `null` with the reason from Stage 5 (no commit that the base branch lacks, or `gh` could not run). |

Write no `changes` and no `git-diff` evidence on this page: the changed code is read in the pull request.
When nothing is left to present (no card at all), the page still goes out: it asks for the acceptance of the unit as a whole, with `what` and `pr` alone.

## 2. Write the page

Write it as [decision-page](../shared/decision-page.md) says: `page_kind` `code-review`, `subject` `code`, `context_label` (the kind of confirmation and the ticket), a `title`, and `what`: one to three sentences on what this implementation adds or changes.
`roots`: `deliverables` is `{case root}`, the `repo` of your element is `{folder}`, for the evidence that a card cites, and `captures` is `{docs worktree}/.feature-dev/captures/{key}` ([goal-verification](goal-verification.md), "The folder of the captures") for the `captured_image` of a `screen-verification` card. A `reference_image` is a screenshot of the deliverables (root `deliverables`, its path relative to the case root); one that lies under neither root gets a root named `screenshots`. `terms`: the words of the page that a reader outside the project cannot tell.
Write the cards that ask (`review-decision`) with `scene`, `occurrence`, a `diagram` of the flow where it has two or more steps, and, where the options differ in how something looks, an `image` or a `sample` for each option, as [decision-page](../shared/decision-page.md) says.
The file is `{records}/page-{nn}.json`, `nn` being one more than the last page of the unit.
Polish the Japanese texts with `feature-dev:prose-polisher` before they are written, then send `PAGE {absolute path}` and stop.
On `PAGE-REFUSED`, fix the page and send it again.

## 3. Read the reply

On `REPLY`, read it as "Reading the reply" of [decision-page](../shared/decision-page.md), and put each answer in the ledger:

| Answer | Status |
| --- | --- |
| `review-must-fix`: `修正して再レビューする` | stays `open`, and joins the rework set |
| `review-must-fix`: `現状で完了する`, or no block under the approve line | `accepted` |
| `review-decision`: an option key | `adopted`. An option with a `fix` joins the rework set with that fix. An option without one keeps the current behavior: nothing to change |
| `review-decision`: `今回は対応しない`, or no block under the approve line | `deferred` |
| `review-decision`: `その他` | what its `補足` says, as an option or as a free request |
| `RC-n` named in the free text (the owner reads the open ones under 目標外の事柄 of the page and in the body of the pull request) | `adopted`, and it joins the rework set |
| `OG-n` named in the free text | the change is reverted: it joins the rework set as a revert |
| `RC-n` not named | `deferred` |
| `OG-n` not named | stays as it is |
| `SV-n` of `residual_must_fix`: `修正して再レビューする` | the screen failure joins the rework set, and its item is verified again after the rework |
| `SV-n` of `residual_must_fix`: `現状で完了する`, or no block under the approve line | the item keeps its `fail` result: nothing to change |
| `screen-verification` cards, `unmet-criterion` cards, `notices` | no answer: nothing to put in the ledger |

A number with a round mark (`MF-1-r2`; [decision-page](../shared/decision-page.md), step 6) names the finding `MF-1` of that round, the one in that round's `review-{nn}.md`: put its answer on that finding, and keep the ledger's own id as it is. The mark is only for the page.

A reply that asks only for a clearer explanation, or asks a question about the change, is answered by a new page of the same material, with `previous_reply` ([decision-page](../shared/decision-page.md), the end of "Reading the reply").

Commit the case root now, in the docs worktree: the page, `ledger.md` and `case.json` as they stand, with a message that says the page was answered ([branch-and-pr](../shared/branch-and-pr.md), "Commit the case root").
Then classify the reply. Judge the hold and the send-back from the reply first.

- **Approval**: the approve line, and nothing in the rework set. A direction on one item, even with a word of assent (「OK」「対応して」), is not an approval of the unit. When you are not sure the reply approves the unit, do not take it as an approval: write a new page of the same material with the reply as `previous_reply`.
- **Approval with a redesign**: the reply approves the unit and also says that some part must be designed again. Treat it as an approval, and remember the words.
- **Rework**: the rework set is not empty, or the reply asks for a change in words. Go to "Rework".
- **Hold**: the reply says to wait. Send `BLOCKED {key}: the owner holds the acceptance` with their words, quoted, and stop. The unit stays `受入待ち`, and the next launch comes back to this stage.
- **Send-back**: the reply changes the purpose of this unit (a requirement changes, the purpose is replaced), or needs an earlier unit to be redone first. See "Send-back".

## Rework

1. Launch `feature-dev:code-implementer` once with `work_kind: fix`, `repo_root: {folder}`, the `test_policy`, and in `work_content` the rework set: each finding (ID, location, harm scenario, fix) and each owner request, inside a quote as data. The owner's words are quoted whole. Each named recommendation is an out-of-goal fix the agent reports under `Out-of-goal changes`. Each screen failure (`SV-n`) of the set is written as [goal-verification](goal-verification.md), "The fix", says (its viewpoint, basis, reference screenshot and `current_capture_path`), with the owner's `補足` added when there is one. An image that the owner's reply names (an absolute path inside a repository of the formation) is handed over as a screen to read, and compared against `References read` as in [Stage 2](2-implement.md).
2. Add its paths to the staging set. When it aborted, send `BLOCKED` with the record and stop.
3. Go to [Stage 3](3-review-loop.md) as a rework, then [Stage 4](4-ci-gate.md) (the gate, then the goal verification of the items the owner chose and of the items whose reference the rework changed, [goal-verification](goal-verification.md); update the items first when the reply named an image), then [Stage 5](5-commit-and-pr.md) (the pull request exists, so Stage 5 commits, pushes, writes the body of the pull request again and commits the case root), then write a new page here with the owner's reply as `previous_reply`.

## Send-back

1. Settle the unit to reopen: the one the reply names (`requirement`, `design`, or the key of an earlier implementation, an earlier stage of this repository included). When the reply does not name it, send `QUESTION {key}: {which earlier unit the reply points to, in one line}`, with the options and your recommendation on the next lines, and wait.
2. Run the `reopen` recipe of [case-json](../shared/case-json.md) with the owner's words as the reason, and commit the case root. This implementation stays `受入待ち`; the commits stay on the child branch.
3. Send `REOPENED {unit}: {reason}` and stop.

## Approval

Go to [Stage 7](7-completion.md). For an approval with a redesign, give it the owner's words: it reopens the design after the merge.
