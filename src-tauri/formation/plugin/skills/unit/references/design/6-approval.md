# Stage 6: Approval

Record the decisions worth an architecture decision record, put the design to the owner on one approval page, and read the answer.
The approval of this stage lasts until the design changes: a revision that goes back to [4-authoring](4-authoring.md) ends it, and so does a failure of stage 7 on the design side.

The owner's approval and every decision of the owner come only through the page. The page is always written, even when it would hold no card to answer, because the verdict line of the owner is what approves.

## Steps

### 1. The ADR

Run the determination of [adr](adr.md). It leaves `{ADR path}`: the file it wrote, or empty when it found nothing to record or when the owner declined the record earlier in this run (then do not scan, and leave `{ADR path}` empty).

### 2. Write the page

Write an `approval` page ([decision-page](../shared/decision-page.md), "The page"). Read the latest state of the design from the disk with `jq`.

- Top level: `schema_version` 1, `page_kind` `approval`, `subject` `design`, `context_label` (for example `基本設計の承認依頼 ・ チケット {ticket key}`; leave the ticket out when there is none), `title`, `what` (the point of what this design adds or changes, in one to three sentences, with no internal identifiers and no counts), `roots` (`deliverables` is `{case root}`; one root for each repository and for the docs repository when an evidence item cites it), and `previous_reply` on a page that presents again (the owner's last reply, word for word).
- `approval_scope`: groups of `{heading, items}`. Together the groups cover every DESIGN item, shared material and appendix, each as one item `{root, ref, description}`, with `ref` the node (`design.json#/designs/DESIGN-02`, `design.json#/shared/data-model`, `design.json#/appendices/inbound-impact`). Put the DESIGN items in a group of their own that holds nothing else. The description of a DESIGN item is `{id} {name}。{summary}`. Name a node by its index in the array (`design.json#/designs/1`) when a refusal says an id cannot be resolved.
- `quality_loop`: `{rounds, must_fix_resolved}`, two integers: the review rounds run and the must-fix findings they fixed (the summary of stage 5).
- `changes`: the change sections, `{heading, blocks}`: what the design changes, in one plain heading, and blocks that open with who does what and what happens to them. Include the architecture diagram of [diagram](diagram.md) here, as a `diagram` block, and a `before-after` or `table` block for a change that is easier to see that way.
- `needs_user_decision`: one `nr` card for each `active` decision of stage 5.
  - `number` `NR-n`, `title` (the one question the card asks, a sentence that ends in `？`, in plain words, never a technical term alone), `summary`, `background`, and `facts`: `分類` (`a: 設計側で確定不能` when the recommendation was not narrowed to one option, `b: 設計側は確定済み・認識承認をお願いしたい` when it was narrowed and its impact reaches other items, other repositories, operations, migration or data integrity) and `影響範囲` (the categories of `impact`, the widest first).
  - `options` `A`, `B`, … in the words of what the owner decides, the recommended one as `A`, `recommendation` `A`, `recommendation_reason`, `evidence`.
- `residual_must_fix`: one `must-fix` card for each residual must-fix finding. `number` `MF-n`, `title`, `summary`, `facts`: `箇所` (the node, in words), `指摘内容` (the finding of the reviewer, and the objection of the fix with its grounds when there is one: both positions), `未解消の理由`. `recommendation` is `fix` or `skip` (the one you recorded in stage 5), with `recommendation_reason`.
- `structural_proposals`: one `structural-proposal` card for each row of `structural_improvements` whose status is `発議中`. `number` `SI-n`, `facts`: `検出観点`, `エビデンス`, `想定リスク`, `改善方針`, `振る舞い保存方針`, `段階的移行の要否`, `重要度`. `recommendation` is `approve`, `reject` or `hold`, with `recommendation_reason`.
- `adr`: one `adr` card when `{ADR path}` is not empty. `number` `AD-1`, `title`, `summary`, `facts`: `題名`, `記録した決定`. `recommendation` `keep`, with `recommendation_reason` (the criteria the decisions met). Cite the file with an `excerpt` evidence item (the root of the docs repository).
- `risks`, optional: `{items, evidence}`, with `items` the risks of the `risk-analysis` material, one `{title, text}` each (one sentence for the risk, and its supplement). Leave it out when the design has no such material.
- Leave out `settled_decisions`: the design keeps the decisions of the owner in `key_decisions` and in `{records}/settled-decisions.json`, not as numbered user decisions.

Write the text of every card in plain Japanese, as [decision-page](../shared/decision-page.md), "Writing the text", says. A fact that could change the answer goes where the card always shows it, in `background` or the question, and never only in `blocks` or `evidence`.

Polish, write `{records}/page-{nn}.json`, and send `PAGE`, as [decision-page](../shared/decision-page.md) says. Then stop.

### 3. Read the reply

When `REPLY` comes, read it as [decision-page](../shared/decision-page.md), "Reading the reply", says. A reply that asks for a clearer explanation is handled as that file says: a new page with the same items and the owner's reply as `previous_reply`.

First apply these two answers, which do not change the design:

- `今回は対応しない` on a residual must-fix finding is compatible with approval. Keep its id as declined by the owner's decision, and list it in your `DONE` summary.
- `不要` on the ADR card ("AD-1 is not needed") is not a revision request. Delete the ADR file, empty `{ADR path}`, and remember that the owner declined it, for the rest of this run.

Then take the first condition that matches.

| The reply | Do |
| --- | --- |
| It approves one or more structural proposals | Run [4-authoring](4-authoring.md) with the kind `structural`, passing the approved ids, the rejected and held ones with their reasons, and the matters the reply names. When the reply also carries a revision request, make it in the same run (kind `revision`). Then run the pass of [5-review](5-review.md) ("The pass that stage 6 sends back"), and present again from step 1. |
| It asks for a substantive fix of the approach, the structure or the content (`fix` on a residual finding, the revise verdict line, or text outside the layout asking for it) | Keep the request. When it amounts to a requirement change (adding requirements, or changing existing ones), go to "Send the case back to the requirement" of [1-context](1-context.md), after you delete the ADR file and empty `{ADR path}`. Otherwise run [4-authoring](4-authoring.md) with the kind `revision`, with the request as it is and the matters it names (the investigation of a new fact is the authoring's own: do not go back to stage 2). Then run the pass of [5-review](5-review.md), and present again from step 1. |
| It settles the design as it stands: the approve verdict line, with or without answers to decisions, `今回は対応しない` on residual findings, or only rejections and holds of proposals | "Approved" below. |

Always delete `{records}/approved.json` when a revision goes back to stage 4.

### Approved

1. When there is nothing to reflect (no choice on a decision, no answer on a residual finding, no disposition of a proposal), skip the next two bullets.
2. Run [4-authoring](4-authoring.md) with the kind `decisions` once, with the owner's decisions and the reasons of the rejected and held proposals. When it returns `fix-not-applied`, send `BLOCKED design: the owner's decisions could not be reflected`, with the unapplied items, and stop. Mark the decisions `decided` in the ledger (set the status), and the declined residual findings stay `residual`.
3. Launch `feature-dev:design-reviewer` once as the confirmation review of [5-review](5-review.md), step 5, narrowed as "The pass that stage 6 sends back" says. Merge as step 2 of that file. When a must-fix finding is `unresolved` other than a residual finding that the owner declined, run the last fix of step 4 of that file once on it (the declined ones stay residual, not fixed again), and present again from step 1 of this file.
4. Once no must-fix finding is left, the design approval is established. Record it:

   ```sh
   echo "{\"design_sha256\": \"$(shasum -a 256 "{case root}/design.json" | cut -d' ' -f1)\", \"page\": \"{page file name}\"}" > "{records}/approved.json"
   ```

   Go to [7-implementations](7-implementations.md) without returning to the leader.

When the design changes after this (a failure of stage 7 on the design side, or a revision), delete `approved.json`: the approval has expired, and stage 6 runs again in full.
