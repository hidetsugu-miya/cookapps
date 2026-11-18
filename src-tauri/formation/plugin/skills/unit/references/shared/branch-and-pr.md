# Branches and pull requests

## The model

- The case has one **base branch** (`base_branch` of `case.json`), the same name in every repository of the case. It is cut from the default branch of the repository.
- Requirement, design and specification commit straight to the base branch, in the repository they belong to, and push it. They have no branch or pull request of their own.
- Each implementation works on its own **child branch**, `{base branch}-{nn}`, cut from the base branch. It opens a **child pull request** into the base branch. After the owner accepts it, the child pull request is merged into the base branch with a merge commit.
- Each repository has one **aggregate pull request**, from the base branch to the default branch. It is a draft until the specification is done, and then it is marked ready. The owner merges it.
- The leader launches you in the right folder on the right branch (your first instruction says which). You never switch your folder's branch, and never open the same branch in two folders.
- Every pull request is left without an assignee. The title's summary is one line of at most 50 characters that says what the change does: do not line up endpoint paths or HTTP methods, and do not copy the unit's name or a requirement sentence as it stands. Polish a Japanese title and body with the `feature-dev:prose-polisher` agent.
- When `gh` cannot run (not installed, not logged in), skip the pull request operation, say so in your `DONE` summary, and go on. Only the merge of a child needs it: if it cannot run, send `BLOCKED`.

## The case root and the docs worktree

The case root is `.feature-dev/current` in the docs worktree, which is the folder of the docs repository on the base branch.
Every edit of the case root and every commit of it happens there, whichever repository your own folder is in.
Address it by absolute path, and use `git -C "{docs worktree}"`.

Before you start a unit that follows a merge into the base branch of the docs repository (or any time `git -C "{docs worktree}" status` says it is behind), bring the worktree up to date:

```sh
git -C "{docs worktree}" pull --ff-only origin "{base branch}"
```

When this is refused, send `BLOCKED`. Do not merge or rebase by guess.

### Commit the case root

Stage only the paths you changed, one by one: `.feature-dev/current/case.json`, the deliverable you wrote (`requirement.json`, `design.json`), the notes of the investigation (`technical-notes.md`, `code-facts-base.json`, `creator-facts.md`), the reopen records you wrote (`records/reopen-*.md` and `records/design-base.json`), and your unit's records (`records/{unit}/`). A path that you removed (`records/design-base.json` after the design redo used it) is staged the same way, by its path, and its removal goes in the commit. Never `git add .` or `git add -A`.

```sh
git -C "{docs worktree}" add -- ".feature-dev/current/case.json" ".feature-dev/current/records/{unit}"
git -C "{docs worktree}" commit -m "{message}"
git -C "{docs worktree}" push -u origin "{base branch}"
```

- Write the message in the repository's own convention (read its contribution document or its recent `git log`), and say why the change is made, not only what.
- When the push is rejected because the branch moved, run `git -C "{docs worktree}" pull --rebase origin "{base branch}"` and push again. Never force push.
- A decision page JSON is a record of the unit, committed with the unit's next commit after it was answered. Do not commit a page that has not been answered.

### `.gitattributes`

The requirement unit puts this entry in `.gitattributes` at the root of the docs repository, once, so that the deliverables are tracked but not expanded in pull request diffs. It adds it only when no line starts with `.feature-dev/**`, and commits it with its first case-root commit.

```text
# Deliverables of feature-dev: tracked, and collapsed in pull request diffs by default
.feature-dev/** linguist-generated=true
```

## The base branch in another repository

The first implementation of a repository may find that the base branch does not exist on `origin` there.
Your folder was then cut from the default branch, and the child branch starts at the same commit the base branch would start from.
Publish the base branch from it, before your first commit:

```sh
git -C "{folder}" ls-remote --exit-code --heads origin "{base branch}"
```

Exit code 0 means it exists, and there is nothing to do. When it exits non-zero:

```sh
git -C "{folder}" push origin "$(git -C "{folder}" rev-parse HEAD):refs/heads/{base branch}"
```

## The child branch and the child pull request

An implementation does these in its own folder (the child worktree the leader opened for it):

1. Check `git -C "{folder}" branch --show-current` is the child branch of your first instruction, and record it: the `child` recipe, branch form, in [case-json](case-json.md). An implementation that already has a child continues on it.
2. Commit the code on the child branch, as the implementation procedure says. Push it: `git -C "{folder}" push -u origin "{child branch}"`.
3. Open the child pull request into the base branch, once the owner can review it:

   ```sh
   git -C "{folder}" fetch origin "+refs/heads/{base branch}:refs/remotes/origin/{base branch}"
   git -C "{folder}" rev-list "refs/remotes/origin/{base branch}..HEAD"
   ```

   When the second command prints nothing, the child holds no commit that the base branch lacks: there is no pull request and nothing to merge, so say that on the review page (`pr.note`). Otherwise write the body to a scratch file, and run, in one call:

   ```sh
   cd "{folder}" && gh pr create --base "{base branch}" --head "{child branch}" --title "[{ticket key}][{unit}] {summary}" --body-file "{scratch file}"
   ```

   Leave `[{ticket key}]` out when the case has no ticket key (the part after `browse/` of a Jira URL, or `#{number}` of a GitHub issue). The body says what the unit does and why. The command prints the URL: its last number is the pull request number, which you record with the `child` recipe, number form.
4. Commit the case root (the pull request number, the status) with the docs worktree commit above.

### After the owner's acceptance

Merge the child into the base branch with a merge commit (never squash or rebase), then bring the remote branch list and the base branch in this clone up to date, so that the next implementation of the repository starts from the merged base:

```sh
cd "{folder}" && gh pr merge {number} --merge
git -C "{folder}" fetch origin "+refs/heads/{base branch}:refs/remotes/origin/{base branch}"
git -C "{folder}" push origin --delete "{child branch}"
```

The local child branch and its folder stay: the owner closes them. Do not use `--delete-branch`, because the branch is checked out in your folder.
When this repository is the docs repository, first run `git -C "{docs worktree}" pull --ff-only origin "{base branch}"`, so that the pull meets no uncommitted `case.json`; when it is refused, send `BLOCKED`. Then record the merge with the `child` recipe, merged form (the status must already be `受入待ち` or `完了`).

## The aggregate pull request

One for each repository: the base branch into the default branch, as a draft. The design unit creates the one of the docs repository when it completes, because the base branch there holds the case root from the requirement on. The implementation unit creates the one of its own repository after its first child is merged into the base branch, when the repository has none. Do it when your procedure says so; it is safe to run again.

1. The repository is in `repos` of `case.json` (the `repo-add` recipe adds it, with its `name_with_owner`). Skip when its `pull_request` is already a number.
2. Find the default branch, and check the base branch has commits that it lacks. All in one call, in a folder of that repository:

   ```sh
   cd "{folder}" && default="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)" && git fetch origin && git rev-list --count "origin/$default..origin/{base branch}"
   ```

   When the count is `0`, the base branch has nothing yet: create nothing.
3. An open pull request from the base branch may exist already: `cd "{folder}" && gh pr list --head "{base branch}" --state open --json number,url`. If it does, record its number (the `pr` recipe) and stop.
4. Otherwise create the draft. The title is `{summary} # {ticket key}`, or the summary alone without a ticket key, and at most 64 characters in all. The summary and the body come from the `purpose` of `requirement.json` (`jq -r .purpose`), with its `background` or `problem`:

   ```sh
   cd "{folder}" && gh pr create --draft --base "$default" --head "{base branch}" --title "{title}" --body-file "{scratch file}"
   ```

5. Record the number with the `pr` recipe, and commit the case root.

The specification unit marks every aggregate pull request ready when it completes: for each `repos[]` element whose `pull_request` is a number, read `gh pr view {number} -R {name_with_owner} --json state,isDraft`, and only when it is open and a draft, run `gh pr ready {number} -R {name_with_owner}`. A failure on one repository goes in the summary, and the others go on.
