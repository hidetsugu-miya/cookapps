# Stage 1: Context

Settle where the specification goes, and put the folder on the base branch.

## 1. Read the case

```sh
jq -c '{base_branch, stages: .stages, repos: [.repos[] | {name, name_with_owner, docs, pull_request}], implementations: [.implementations[] | {key, repo, status}]}' "{case root}/case.json"
```

The units before yours are `完了`, or the skill has already stopped you.
Read the `reopen` record when `stages.specification.reopen` is not `null`.

## 2. Which repository is yours

Find the `repos[]` element that your folder belongs to: the element whose `name_with_owner` equals `gh repo view --json nameWithOwner --jq .nameWithOwner` run in `{folder}`, or, when that fails, the one whose `name` equals the last part of `git -C "{folder}" remote get-url origin` without `.git`.
Call it `{my repo}`.

## 3. Where the specification goes

Apply [conventions](conventions.md), "Where the specification goes", step 1, to `{my repo}`: the statement in its `AGENTS.md` or `CLAUDE.md`, or the form its `docs/` already uses, or `docs/specs`.
It settles `{spec repo}`, and which of the three criteria applies.

- `{spec repo}` is `{my repo}`: go on to step 4.
- The statement points at another repository `{name}`:
  1. Add it with the `repo-add` recipe of [case-json](../shared/case-json.md) when `repos[]` lacks it. Its `name_with_owner` is the output of `gh repo view --json nameWithOwner --jq .nameWithOwner` in a folder of it when you have one, and the empty string otherwise.
  2. Record it with the `set-repo` recipe.
  3. Commit the case root in the docs worktree ([branch-and-pr](../shared/branch-and-pr.md), "Commit the case root"), with a message that says where the specification is written and why.
  4. Send `BLOCKED specification: the specification belongs in {name}; case.json now names it. Launch the specification unit again in a worktree of {name} on {base branch}.` and stop. The leader launches the unit there.

## 4. The folder

Check that `git -C "{folder}" branch --show-current` prints `{base branch}`. When it does not, send `BLOCKED` and stop: you never switch the branch of your folder.
When `{spec repo}` is not the docs repository and the base branch is not on `origin` there, publish it first ([branch-and-pr](../shared/branch-and-pr.md), "The base branch in another repository").
Bring the folder and the docs worktree up to date:

```sh
git -C "{folder}" pull --ff-only origin "{base branch}"
git -C "{docs worktree}" pull --ff-only origin "{base branch}"
```

When a pull is refused, send `BLOCKED` with the message. Do not merge or rebase by guess.
The folder must be clean (`git -C "{folder}" status --porcelain` prints nothing) before you write: a stray change in it is not yours to commit, so stop with `BLOCKED` when you cannot tell where it comes from.

## 5. `{specRoot}`

Settle `{specRoot}` as [conventions](conventions.md), "Where the specification goes", step 1, says, and as an absolute path in `{folder}`.
Under the form `docs/{feature}/`, `{specRoot}` is the directory that holds the feature directories for now, and Stage 2 settles the feature directory.

Then go to [Stage 2](2-write.md).
