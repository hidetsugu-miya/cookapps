# Stage 5: Commit and child pull request

Commit the code on the child branch, push it, open the child pull request, and commit the case root.
[branch-and-pr](../shared/branch-and-pr.md) is the canonical text of the pull request and the case-root commit: this file only orders them.

## 1. Commit the code

Skip this step when the paths of the staging set are already committed (the gate of Stage 4 ran on a commit).

1. Check the folder: `git -C "{folder}" status --porcelain` shows the paths of the staging set (the `changed_paths` and `generated_paths` of every launch of the implementer) and nothing that you do not know. A path that is not in the staging set and not in the work that was there before you came (Stage 1, step 5) is a stray file of the change: ask `feature-dev:code-implementer` to settle it, as in Stage 4, "tree_mutated". Sensitive files (credentials, `.env`, keys) never go into a commit: leave them out and say so in the summary.
2. Stage each path of the staging set by name:

   ```sh
   git -C "{folder}" add -- {path} {path} ...
   ```

   Never `git add .`, `git add -A` or a directory.
3. Commit in the repository's own convention: read its contribution document and `git -C "{folder}" log -n 10 --format=%s`. The message says why the change is made (the purpose of the unit), not only what it does. One commit holds one logical change: when the unit holds several, make a commit for each.

```sh
git -C "{folder}" commit -m "{message}"
```

A hook of the repository that stops the commit is a finding: fix what it names and commit again. Never use `--no-verify`.

## 2. Push the child branch

```sh
git -C "{folder}" push -u origin "{child branch}"
```

A repository gate that stops the push (a record or a check that must exist for the commit) is a finding: run what its message names, then push again.
When the push is rejected because the remote branch moved, take it in with `git -C "{folder}" fetch origin "{child branch}"` and `git -C "{folder}" merge --no-edit "origin/{child branch}"`, and push again; on a conflict, `git -C "{folder}" merge --abort` and send `BLOCKED`.
Never force push.

## 3. Open the child pull request

Follow "The child branch and the child pull request" of [branch-and-pr](../shared/branch-and-pr.md), step 3:

- Fetch the base branch and run the `rev-list` of that file. When it prints nothing, open no pull request: the child holds no commit that the base branch lacks. Remember that for the page (`pr.note`).
- Otherwise write the title and the body: the title is `[{ticket key}][{key}] {summary}` as that file says (no assignee, a summary of at most 50 characters). The body is the one that "The body of the child pull request" of [branch-and-pr](../shared/branch-and-pr.md) defines: the owner reads the change there and not on the decision page of Stage 6, so every section is written now. Write them in the language of the repository's recent pull requests (`gh pr list --state all --limit 5`); polish a Japanese title and body with `feature-dev:prose-polisher` before they are written, and use its final draft as it is.
- Write the body to a scratch file outside the repository, then run `gh pr create` in one call as that file shows.
- Record the pull request number with the `child` recipe, number form, of [case-json](../shared/case-json.md).
- When `gh` cannot run, skip this step, remember it for the page (`pr.note`: no pull request, and why), and go on. Stage 7 needs `gh`.

A pull request that exists already (`gh pr list --head "{child branch}" --state open --json number,url`) is the one to use: record its number, open no second, and write its body again as that file says ("Update the body"), because the review rounds, the check and the ledger have moved since the body was written (a rework of Stage 6 comes back here).

## 4. Commit the case root

Commit what changed in the case root, in the docs worktree, as "Commit the case root" of [branch-and-pr](../shared/branch-and-pr.md) says: `case.json`, and `records/{key}` (the contract, the review reports, the ledger).
Do the commit whether or not a pull request exists, so that `case.json` is recorded before the owner's review.
The commit message names what is recorded: the wait for the owner's acceptance, the review records and the pull request number.

Then go to [Stage 6](6-acceptance.md).
