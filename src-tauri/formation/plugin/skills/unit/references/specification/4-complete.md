# Stage 4: Complete

Commit the specification, add the references from the code, archive the case root, mark the aggregate pull requests ready, and report.
Do the steps in order and without stopping to ask. The only stops are the ones named below.
[branch-and-pr](../shared/branch-and-pr.md) is the canonical text of the commits of the case root and of the aggregate pull requests.

## 1. The files to commit

The files are the ones Stage 2 and Stage 3 wrote. Check that the list is complete:

```sh
git -C "{folder}" diff --name-only HEAD
git -C "{folder}" ls-files --others --exclude-standard
```

When `{folder}` is the docs repository, paths under the case root may show up: this step is about the specification only. The case root is archived in step 7.

## 2. The diagrams

Nothing is rendered: a Mermaid block stays in its Markdown file as it is written.
Check each block with `rg`: it is closed, and its first line names a type that GitHub draws (`sequenceDiagram`, `stateDiagram-v2`, `flowchart` or `graph`).
Fix a block that is not, in the file, and polish nothing in it.

## 3. Commit and push the specification

Stage the files by name, and commit them in the repository's convention with a message that says what the specification adds or updates and why it is written now. Never `git add .` or `git add -A`.

```sh
git -C "{folder}" add -- {path} {path} ...
git -C "{folder}" commit -m "{message}"
git -C "{folder}" push -u origin "{base branch}"
```

A hook or a gate of the repository that stops the commit or the push is a finding: fix what it names. When the push is rejected because the base branch moved, run `git -C "{folder}" pull --rebase origin "{base branch}"` and push again. Never force push.
Stage nothing of the case root here. When a commit or a push cannot be made, send `BLOCKED` with the reason and stop.

## 4. References from the code to the specification

List the repositories of the implementations:

```sh
jq -r '[.implementations[].repo] | unique[]' "{case root}/case.json"
```

When it prints nothing, skip this step.
You have a folder for `{my repo}` (`{folder}`) and for the docs repository (`{docs worktree}`). For any other repository you need its folder on `{base branch}`: send one `QUESTION specification {Q-id}:` (a matter of the environment) that names the repositories and asks for the absolute path of a folder of each that is on `{base branch}`, with the answer `none` for one that has no such folder. A repository answered `none` is recorded as `対象外（フォルダなし）`.

For each target, check the folder: it is on `{base branch}` (`git -C "{t}" branch --show-current`), it is clean, and `git -C "{t}" pull --ff-only origin "{base branch}"` succeeds. A target that fails a check is recorded as `失敗` with the message, and left out of the rest of this step.

Launch one `feature-dev:code-implementer` for each remaining target, all in one message (they work in different trees), with `work_kind: initial`, `repo_root: {t}`, `test_policy: direct`, and this `work_content`:

- Purpose: add comments that refer to the specification files to the places in `{t}` that the specification names (entry points, class and hook names).
- Constraints: follow the form of such a reference that the conventions of `{t}` or of `{spec repo}` (`AGENTS.md`, `CLAUDE.md`, `.claude/rules/`) set, or that existing references in `{t}` already use, and point at those sources instead of copying them. Change nothing when none of them sets a form, or when the specification names no place in `{t}`. Change comments only, with no change of behavior; regenerate a generated file only when the repository's own tooling requires it for a comment.
- What to read: the absolute path of every specification file.

Handle each return:

- `implementation-blocked`, or any other abort, with no change: record `対象外` with the reason (no convention, no place), or `失敗` with the abort reason when it is a real failure.
- `implementation-completed`: launch `feature-dev:ci-verifier` with `repo_root: {t}`, one for each such target, in one message. When it passed (`passed` with `tree_mutated: false`, or `undefined`), stage exactly the target's `changed_paths` and `generated_paths` by name, commit them (a message that says the code is linked to the specification), and push `{base branch}`. Record `付与済み` with the number of paths, or `失敗` with the reason when a commit or a push is refused. When it did not pass, commit nothing, and record `失敗` with `log_path` and `failure_summary`.

After this step, discard the changes of every target recorded `失敗` after its implementer ran, so that the target is as its base branch holds it: `git -C "{t}" restore --staged --worktree -- {the paths it reported}`, and add those paths to the record. Nothing else in the tree is touched.
A failure here stops nothing: record it and go on.

## 5. Scan for references to the case root

The archive moves the case root, so no file may point at `.feature-dev/current`.
In `{docs worktree}`, and in `{folder}` when it is another repository:

```sh
git -C "{docs worktree}" grep -n -F '.feature-dev/current' -- ':!.feature-dev/current' ':!.feature-dev/archives'
git -C "{folder}" grep -n -F '.feature-dev/current' -- ':!.feature-dev/current' ':!.feature-dev/archives'
```

When a scan finds a hit, move nothing: send `BLOCKED specification: files refer to the case root` with the paths and lines, and stop. The unit stays as it is.

## 6. Aggregate pull requests

1. For each `repos[]` element whose `pull_request` is `null`, apply "The aggregate pull request" of [branch-and-pr](../shared/branch-and-pr.md). Use a folder of that repository (`{folder}`, the docs worktree, or one the leader gave you). A repository you have no folder for stays as it is, and its absence goes in the report. The case-root change is committed with the archive in step 8.
2. Capture the ones to mark ready, now, while `case.json` still exists:

   ```sh
   jq -c '[.repos[] | select(.pull_request != null) | {name, name_with_owner, pull_request}]' "{case root}/case.json"
   ```

   When the result is an empty array, step 9 has nothing to do.

## 7. Record `完了` and archive the case root

1. Set the unit to `完了` with the `status` recipe of [case-json](../shared/case-json.md). The leader reads `case.json` of the archive to check it.
2. Check that the docs worktree is on the base branch: `git -C "{docs worktree}" branch --show-current`. When it is not, send `BLOCKED` and stop.
3. Move the case root with `git mv` into the archive. The folder is named `{YYYYMMDD-HHMM}_{base branch with each / replaced by -}`. Run this as one command, and keep the printed path as `{archive dir}`:

   ```sh
   archive_dir="{docs worktree}/.feature-dev/archives/$(date +%Y%m%d-%H%M)_$(printf '%s' '{base branch}' | tr '/' '-')" && mkdir -p "{docs worktree}/.feature-dev/archives" && git -C "{docs worktree}" mv "{case root}" "$archive_dir" && printf '%s\n' "$archive_dir"
   ```

   Nothing is deleted: the whole case root moves.

## 8. Commit the archive

`git mv` has staged the move. Check that `git -C "{docs worktree}" status --porcelain` shows only paths under `.feature-dev/`, and nothing else is staged. Then commit with a message that says that the case's deliverables are archived, and push:

```sh
git -C "{docs worktree}" commit -m "{message}"
git -C "{docs worktree}" push -u origin "{base branch}"
```

When the commit or the push cannot be made, send `BLOCKED` with the reason and the fact that the case root is moved to `{archive dir}` and not committed, and stop without step 9. When the repository's rules require a check before a push, run it as they say (`feature-dev:ci-verifier` with the command).

## 9. Mark the aggregate pull requests ready

For each element captured in step 6, in order:

1. When `name_with_owner` is empty, read it with `gh repo view --json nameWithOwner --jq .nameWithOwner` in a folder of that repository. When you have none, record `失敗` (no `name_with_owner`) and go on.
2. Read its state: `gh pr view {pull_request} -R {name_with_owner} --json state,isDraft`.
3. Only when it is open and a draft, run `gh pr ready {pull_request} -R {name_with_owner}`. An open one that is not a draft, and a closed or merged one, are `対象外`.

A failure of one command is recorded as `失敗` with the error, and the next repository goes on.
The URL of a pull request is `https://github.com/{name_with_owner}/pull/{number}`.

## 10. Report

Send `DONE specification: {summary}` and stop, with the summary the [README](README.md) describes, in English. It ends with the note that the aggregate pull requests were not merged and that the owner merges them after the review, and, for each, its URL.
