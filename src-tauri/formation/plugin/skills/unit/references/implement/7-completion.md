# Stage 7: Completion

Merge the child into the base branch, make sure the repository has its aggregate pull request, record `完了`, and report.
[branch-and-pr](../shared/branch-and-pr.md) is the canonical text of the merge and of the aggregate pull request.
Do every step in one go, without stopping to ask.

This stage is also the start of a resumed unit whose `child.merged` is already `true` ("Where to start" in the [README](README.md)): then skip step 1 and go to step 2.

## 1. Merge the child

1. Run the `rev-list` of "The child branch and the child pull request" in [branch-and-pr](../shared/branch-and-pr.md). When it prints nothing, the child holds no commit that the base branch lacks: there is nothing to merge, so go to step 2.
2. Check that the folder is clean and pushed (`git -C "{folder}" status --porcelain` prints nothing, and `git -C "{folder}" rev-list --count "origin/{child branch}..HEAD"` prints `0`). When it is not, the work would be lost: send `BLOCKED` and stop.
3. Merge as that file says, "After the owner's acceptance":

   ```sh
   cd "{folder}" && gh pr merge {number} --merge
   git -C "{folder}" fetch origin "+refs/heads/{base branch}:refs/remotes/origin/{base branch}"
   git -C "{folder}" push origin --delete "{child branch}"
   ```

   Merge with a merge commit, never squash or rebase, and never `--delete-branch`.
   When `child.pull_request` is `null` and the child holds commits (the pull request could not be opened), or `gh` cannot run, send `BLOCKED {key}: the child cannot be merged` with the reason, and stop. The unit stays `受入待ち`.
   When the merge is refused (a conflict, a rule of the repository), read the message. A conflict that a plain merge of the base branch into the child settles: do it in `{folder}`, push, and merge again. Anything else is a `BLOCKED` with the message.

## 2. Bring the docs worktree up to date

When this repository is the docs repository, run `git -C "{docs worktree}" pull --ff-only origin "{base branch}"` before the next case-root change, so that the merge is in it. When it is refused, send `BLOCKED` and stop.

## 3. Record the merge and `完了`

With the recipes of [case-json](../shared/case-json.md):

1. `child`, merged form (the unit is still `受入待ち`).
2. `status`, to `完了`. Do not move the next unit.

## 4. The aggregate pull request

Create the aggregate pull request of this repository when it has none, as "The aggregate pull request" of [branch-and-pr](../shared/branch-and-pr.md) says: it is a draft from the base branch to the default branch, and the procedure is safe to run again.
Do it in `{folder}` or in a folder of the repository that is up to date with `origin` (the merge is on `origin`, which is what the procedure reads). Record its number with the `pr` recipe.

## 5. Reopen the design (approval with a redesign only)

When the owner approved with a redesign (Stage 6), run the `reopen` recipe for `design`, with the owner's words and the finding ids the redesign starts from as the reason, quoted as data in the record.
The implementations stay as they are: the design unit decides what the redesign reaches.

## 6. Commit the case root and report

1. Commit the case root in the docs worktree: `case.json`, `records/{key}`, and the reopen record when step 5 wrote one. The message says that the implementation is complete (and that the design is reopened, when it is).
2. Send `DONE {key}: {summary}` as the [README](README.md) says, and stop.
   - After step 5, send `REOPENED design: {reason}` instead, saying in its first lines that `{key}` is `完了` and merged. The leader goes back to the design.
