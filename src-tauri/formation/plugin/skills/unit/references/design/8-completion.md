# Stage 8: Completion

Set the status, commit and push, open the aggregate pull request of the docs repository, and tell the leader.

## Steps

### 1. Check where you stand

- `{records}/approved.json` holds the hash of the `design.json` on disk. When it does not, the approval has expired: go back to stage 6.
- `case.json` is valid, and its `implementations[]` is what stage 7 wrote:

  ```sh
  jq -r -f "{jq dir}/case-check.jq" "{case root}/case.json"
  jq -r --arg tier 2 --slurpfile req "{case root}/requirement.json" -f "{jq dir}/doc-check.jq" "{case root}/design.json"
  ```

  Both print nothing.

### 2. The status

Set the unit `design` to `完了` with the `status` recipe of [case-json](../shared/case-json.md). It clears the `reopen` of the design.

### 3. Commit the ADR

When `{ADR path}` is not empty, commit it first, as a commit of its own, before the case root ([branch-and-pr](../shared/branch-and-pr.md), "Commit the case root", for the way to commit):

```sh
git -C "{docs worktree}" add -- "{ADR path relative to the worktree}"
git -C "{docs worktree}" commit -m "{message}"
git -C "{docs worktree}" push -u origin "{base branch}"
```

Write the message in the repository's own convention (read its contribution document or its recent `git log`), and say why: the background of the decision that the record keeps, and that the record adds an ADR. Stage the one file by its path, never a folder.

### 4. Commit the case root

Stage each path that exists and that this unit changed, one by one, and commit them together ([branch-and-pr](../shared/branch-and-pr.md)):

- `.feature-dev/current/case.json`, `design.json`, `technical-notes.md`, `code-facts-base.json`, `creator-facts.md`;
- `.feature-dev/current/prototypes` (the evidence of the comparisons of stage 2, when there are any);
- `.feature-dev/current/records/design` (the pages that were answered, `ledger.json`, the reviews, the fix summaries, `settled-decisions.json`, `approved.json`);
- the reopen records that are new or changed (`records/reopen-*.md`; find them with `git -C "{docs worktree}" status --porcelain -- .feature-dev/current/records`); the removal of `records/design-base.json` is already staged by stage 7.

```sh
git -C "{docs worktree}" add -- "{one path}"      # once for each path
git -C "{docs worktree}" commit -m "{message}"
git -C "{docs worktree}" push -u origin "{base branch}"
```

Write the message in the repository's own convention, say why the change is made (the basic design of the case, its approval, and the derived implementations), and not only what. A page that was not answered is not committed. When the push is rejected because the branch moved, run `git pull --rebase origin "{base branch}"` and push again. Never force push.
When a commit or the push fails in a way you cannot fix, send `BLOCKED design: {reason}`, with what you tried, and stop.

### 5. The aggregate pull request of the docs repository

Open it as [branch-and-pr](../shared/branch-and-pr.md), "The aggregate pull request", says, for the docs repository: the base branch into the default branch, as a draft.
It is safe to run again: skip it when the repository's `pull_request` is already a number, and when the base branch has no commit that the default branch lacks. Record the number with the `pr` recipe, and commit the case root once more (the message says that it records the number of the aggregate pull request), and push.
When `gh` cannot run, skip this step and say so in your `DONE` summary.

### 6. Tell the leader

Make sure everything of the unit is pushed: `git -C "{docs worktree}" status --porcelain -- .feature-dev` shows nothing of this unit, and `git -C "{docs worktree}" log origin/{base branch}..HEAD` shows nothing.
Then send `DONE`, and stay as a standby ([standby](../shared/standby.md)):

```text
DONE design: {summary}
```

Write the summary in English, short, with what the leader and the owner need:

- What was designed: the number of DESIGN items, their repositories, and the layer.
- The implementations of `case.json`, in the order the leader launches them: key, repository and kind of each. Say which ones went back to `未着手` because the redone design reached them (`reopened`), which stay as orphans because no DESIGN item holds them (`orphaned`), and which were dropped (`removed`).
- Each child branch of an implementation that was dropped or orphaned and was not merged (`unmerged_children`): its branch, its pull request number, the status it had. Say that its code is not in the base branch, that you merged, deleted and closed nothing, and that the owner decides what to do with each.
- The owner's `今回は対応しない` on residual must-fix findings: the id and a one-line gist of each.
- What you could not do or show: the ranges of the investigation that stayed unscanned, an architecture decision scan that was `partial`, a diagram that was not shown, a pull request that was not made because `gh` could not run, and a design whose releases cannot be put in the order that "Staged releases" of [rules](rules.md) describes.
- The ADR: its title and file, or that none was written, or that the owner declined it.
- The aggregate pull request of the docs repository: its URL, or why none was made.
- The matters you noticed outside the request that you did not reflect, one line each. Say that the owner may name one to have it fixed.
