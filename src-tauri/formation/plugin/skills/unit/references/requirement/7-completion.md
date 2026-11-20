# Stage 7: completion

The owner approved the requirement definition. Record it, commit it, push it, and tell the leader.

## Step 1: the status

Set the unit to `完了` with the `status` recipe of [case-json](../shared/case-json.md), with `--arg u requirement --arg s 完了`. It also clears `reopen` of the unit.

Check the result:

```sh
jq -r -f "{jq dir}/case-check.jq" "{case root}/case.json"
jq -r '.stages.requirement.status' "{case root}/case.json"
```

The first prints nothing, and the second prints `完了`.

## Step 2: the commit

Commit what this unit wrote, in the docs worktree, each path by itself ([branch-and-pr](../shared/branch-and-pr.md), "Commit the case root"). Never `git add .` or `git add -A`.

1. The first case-root commit of the case also puts this entry in `.gitattributes` at the root of the docs repository, so that the deliverables are tracked but not expanded in pull request diffs. Add it only when no line of the file starts with `.feature-dev/**`, and stage the file:

   ```text
   # Deliverables of feature-dev: tracked, and collapsed in pull request diffs by default
   .feature-dev/** linguist-generated=true
   ```

2. Stage the paths that exist:

   ```sh
   w="{docs worktree}"; r=".feature-dev/current"
   for p in case.json requirement.json technical-notes.md code-facts-base.json creator-facts.md ui-references records/requirement records/design-base.json; do
     [ -e "$w/$r/$p" ] && git -C "$w" add -- "$r/$p"
   done
   for f in "$w/$r"/records/reopen-requirement-*.md; do [ -e "$f" ] && git -C "$w" add -- "$r/records/$(basename "$f")"; done
   git -C "$w" status --short -- "$r"
   ```

   The last command shows what is staged. Nothing of the unit may stay unstaged.
3. Commit with the repository's own convention for the message, and say why: that the requirement of the case is defined and approved, with what it defines in one line. Push:

   ```sh
   git -C "{docs worktree}" push -u origin "{base branch}"
   ```

   When the push is rejected because the branch moved, run `git -C "{docs worktree}" pull --rebase origin "{base branch}"` and push again. Never force push.

## Step 3: tell the leader

Check once more that nothing of the unit is left uncommitted: `git -C "{docs worktree}" status --short -- ".feature-dev/current"` prints no line for the paths above.

Send the leader one message, in Japanese, and stop:

```text
DONE requirement: {one or two lines on what the requirement defines, and how many requirements it has}
```

When these apply, add them to the first line's text, short:

- the user decisions that the approval settled (`UD-NN` and the decision), when the owner's reply to the approval page recorded some,
- the must-fix findings the owner declined ("declined by the owner's decision"), by id and title,
- the provisional user decisions that still wait for the business side,
- the matters you noticed that the request did not present, one line each.

The unit ends here. The leader launches the next unit's child.
