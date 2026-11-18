# The next unit

A case is a fixed line of units:

1. `requirement`
2. `design`
3. the implementations, in the array order of `implementations[]` of `case.json`
4. `specification`

The next unit is the first one in that line whose status is not `完了`.
The statuses are `未着手`, `進行中`, `完了`, and, for an implementation only, `受入待ち` (its review has converged and it waits for the owner's acceptance).
A unit that is `進行中` or `受入待ち` is resumed: its child starts again and goes on from the record.

You only read `case.json`. The child writes it.

## Read it

With a new case there is no `case.json` yet, and the next unit is `requirement`.
Otherwise read `{case root}/case.json` (`formation_read`, or `jq` over Bash) and run:

```sh
jq -c '
  [ {unit: "requirement", status: .stages.requirement.status, repo: null, reopen: .stages.requirement.reopen, child: null},
    {unit: "design", status: .stages.design.status, repo: null, reopen: .stages.design.reopen, child: null},
    (.implementations[] | {unit: (.key // .repo), status, repo, reopen, child: (.child // null)}),
    {unit: "specification", status: .stages.specification.status, repo: .stages.specification.repo, reopen: .stages.specification.reopen, child: null}
  ] | map(select(.status != "完了")) | .[0] // "all-complete"' "{case root}/case.json"
```

The answer is the next unit (`unit` is its key, `repo` its repository, `reopen` the record that reopened it, `child` the child branch of an implementation), or the word `all-complete`.
Do not read the file for anything the answer already tells. If the file fails to parse, tell the owner and stop.

Where each unit works:

| Unit | Repository | Folder |
| --- | --- | --- |
| `requirement`, `design` | the docs repository | the docs worktree |
| `specification` | `repo` of the unit, the docs repository when it is `null` | a worktree on the base branch |
| an implementation | its `repo` | a worktree on its child branch |

The details of the places are in [launch](launch.md).

## Use the instruction

Sort `{instruction}` into one of these.

- Empty, or nothing that points back to an earlier unit: **continue**. The unit is the one you read above. Pass a non-empty `{instruction}` to its child as guidance, quoted ([launch](launch.md)).
- It points to new design work while the requirement stays valid: **reopen design**. The unit is `design`.
- It points to revisiting something already done (the requirement, the design, or one implementation): **reopen that unit**. Take the unit from the instruction, and ask the owner only when it cannot be told from it.

For a reopen, you still write nothing yourself.
Launch the child of the unit named, and tell it in the first prompt to reopen the unit first, with the owner's words as the reason ([launch](launch.md)).
A reopened unit is the first one not `完了`, and the units after it keep their statuses and resume when it is complete again.
The child of a reopened design also decides what happens to the implementations the redone design reaches.

## When every unit is complete

The answer is `all-complete`.
Report to the owner, in Japanese:

- that the whole case is complete,
- what was made and where: the base branch, the aggregate pull request of each repository (`repos[].pull_request` and `name_with_owner` of `case.json`; the URL is `https://github.com/{name_with_owner}/pull/{number}`), and the specification,
- what is left for the owner, such as marking a pull request ready or merging it.

Stop there. Do not close the children: their screens and worktrees stay until the owner closes them.
