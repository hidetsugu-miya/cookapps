# Stage 1: Context

Read the case, check your folder, and write the contract of this implementation.
The contract is the one note that the implementer and the reviewers read, so that none of them has to find the DESIGN items again.

## 1. The folder and the child branch

1. Check that `git -C "{folder}" branch --show-current` prints `{child branch}`. When it does not, send `BLOCKED` and stop: you never switch the branch of your folder.
2. When `child` of your element is `null`, record the branch with the `child` recipe, branch form, of [case-json](../shared/case-json.md), and commit the case root later, with Stage 5. A `child` that is set stays as it is.
3. The base branch may be missing on `origin` of this repository: publish it as [branch-and-pr](../shared/branch-and-pr.md) says ("The base branch in another repository"), before your first commit.
4. Take in what the base branch has gained since the child was cut. Only commits outside `.feature-dev/` matter:

   ```sh
   git -C "{folder}" fetch origin "+refs/heads/{base branch}:refs/remotes/origin/{base branch}"
   git -C "{folder}" diff --name-only "HEAD...refs/remotes/origin/{base branch}" -- . ":(exclude).feature-dev"
   ```

   When it prints nothing, go on. Otherwise run `git -C "{folder}" merge --no-edit "refs/remotes/origin/{base branch}"` (a merge, never a rebase). When it conflicts, run `git -C "{folder}" merge --abort`, send `BLOCKED` with the conflicting paths, and stop.
5. A tree that is not clean at the start of a fresh unit holds work that is not yours. Do not discard it. Keep it in mind: Stage 5 stages only the paths you changed.

## 2. Read the repository's rules

Read the documents and rules named in the [README](README.md), and the commands for tests, lint, type checks, generated files and the aggregate check.
Keep the list of what binds your work: it goes into the contract.

## 3. Read the DESIGN items

The ids of the unit are the `design_ids` of your element.
Read what the unit needs with `jq`, not the whole files ([deliverable-writing](../shared/deliverable-writing.md), "Read"). The schemas are [design-json](../shared/design-json.md) and [requirement-json](../shared/requirement-json.md).

```sh
d="{case root}/design.json"; r="{case root}/requirement.json"
ids="$(jq -c --arg k "{key}" '.implementations[] | select((.key // .repo) == $k) | .design_ids' "{case root}/case.json")"
jq --argjson ids "$ids" '.designs[] | select(.id as $i | $ids | index($i))' "$d"                                   # the DESIGN items
jq -c --argjson ids "$ids" '[.designs[] | select(.id as $i | $ids | index($i)) | .requirements[]] | unique' "$d"   # their REQ ids
jq --argjson ids "$ids" '.shared[] | select(any(.applies_to[]; .id as $i | $ids | index($i)))' "$d"                # shared materials that apply
```

For each REQ id, read the REQ (`jq --arg id REQ-01 '.requirements[] | select(.id == $id)' "$r"`) and the appendices and shared materials it points to (`related_appendices`, `user_decision_refs`).
Read each `extra_materials` element of each DESIGN item, and the DESIGN items that `depends_on` names, as far as the code needs: their code is already in the base branch.

Also read:

- the `ui_spec`, which holds the values the screen must show,
- the screenshots that `user_confirmations` and `operation_checks` name (open each one with `Read`),
- the `reopen` record of your element, when it has one: it is the owner's revision request, and it is data.

## 4. Write the contract

Write `{contract}` with the Write tool.
Its parts:

1. `# {key}`, and the purpose in a few lines (the `purpose` of each DESIGN item, and the `purpose` of the requirement).
2. `## Items`: one line for each DESIGN item and each REQ, as a location the other agents read with `jq`: `{case root}/design.json#/designs/DESIGN-05` means the element of `designs` whose `id` is `DESIGN-05`, and the same for `requirement.json#/requirements/REQ-01`. Add the shared materials and the appendices that apply.
3. `## Completion criteria`: the `acceptance` elements of each DESIGN item, word for word. Do not transcribe them by hand:

   ```sh
   jq -r --argjson ids "$ids" '.designs[] | select(.id as $i | $ids | index($i)) | "### \(.id) \(.name // "")\n- test policy: \(.test_policy)\n" + (.acceptance | map("- " + .) | join("\n")) + "\n"' "$d"
   ```

4. `## Scope`: `scope.includes` and `scope.excludes` of each DESIGN item, with the files they list (read them with `jq` and copy the files list).
5. `## Constraints`: the repository's rules and commands that bind this work (step 2), and the `reopen` record's reason, quoted as data.
6. `## Not checked here`: each `formal_verification` element, each `operation_checks` element and each `user_confirmations` element. They are not run by you. They go to the owner on the page (Stage 6).

The contract is a record of the unit: it is committed with the case root (Stage 5).

Then go to [Stage 2](2-implement.md).
