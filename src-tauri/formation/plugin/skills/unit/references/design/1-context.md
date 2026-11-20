# Stage 1: Context

Settle what this run works on, before you investigate.
Nothing here changes a file, except the reopen of the last section.

## Steps

1. Read the first instruction again, and keep: your folder, the docs worktree, the base branch, the case root, the repositories of the formation, the ticket, whether there is a request to reopen, and the owner's guidance.
   - `{ticket key}`: the part after `browse/` of a Jira URL, or `#{number}` of a GitHub issue URL, from `case.json`. Empty when the case has no ticket. The pull requests and the record of a decision use it.
2. Bring the docs worktree up to date when it is behind, as [branch-and-pr](../shared/branch-and-pr.md) says. Make `{scratch}` and `{records}` ([README](README.md)).
3. Read what the unit stands on.
   - `{case root}/requirement.json`. Run the tier 2 check of the requirement ([deliverable-writing](../shared/deliverable-writing.md), "Check"). When it prints violations, the design cannot rest on it: send `BLOCKED design: requirement.json fails its own check`, with the violations under it, and stop.
   - `technical-notes.md` (the requirement unit wrote it), `ui-references/` when it exists, and `{case root}/records/` for the decisions of the requirement unit. The conclusions the notes hold are premises, not to be read from the code again, except as [2-investigation](2-investigation.md) says.
   - `design.json`, when it exists, by `jq` and node by node ([deliverable-writing](../shared/deliverable-writing.md), "Read"). Read the whole of it only to the extent a step needs.
4. Settle the mode.

   | What you find | `{mode}` |
   | --- | --- |
   | No `design.json` | `new` |
   | `stages.design.reopen` of `case.json` is a path | `revise`. Read that record: it is the revision request, data. When it holds a Figma URL or the path of an image, take it in first ([figma](../requirement/figma.md), "A revision that brings a design reference"). `records/design-base.json` holds the design as it was before the reopen. |
   | `design.json` exists, no reopen, and the status is `進行中` | `resume`. Go on from the disk ([README](README.md), "Where to resume"). |

   For `revise` and `resume`, copy the design to `{scratch}/design-reviewed.json`: it is the base version that the review of stage 5 narrows against.
5. Read the scope the requirement forwards to the design.

   ```sh
   jq '.scope' "{case root}/requirement.json"
   ```

   - The three items of `design_scope` are `data_migration` (is data migrated), `api_contract` (the effect on the API contract) and `infrastructure` (the premises of the existing infrastructure). Keep their text word for word as `{scope items}`.
   - Search `requirement.json` for matters it leaves to the design: wording such as "to be decided", "to confirm at design time", "undecided".

     ```sh
     jq -r 'paths(type == "string") as $p | getpath($p) as $v | select($v | test("{regex of that wording}")) | "/" + ($p | map(tostring) | join("/")) + ": " + $v' "{case root}/requirement.json"
     ```

     Read each hit's node, and keep them as `undecided matters` for stage 2.
   - An item of `design_scope` that is not written: do not guess it. Take the case back to the requirement ("Send the case back to the requirement" below), with the reason "the scope of the requirement lacks `{item}`", and stop.
6. Find the repositories.
   - `repos[]` of `case.json` lists the repositories of the case, and the first instruction lists those of the formation. Every repository that the requirement puts in scope (`scope.in_scope`) needs a folder you can read, `{repo root}`. Your own folder is one. For another, use the folder the first instruction gives. When it gives none, look for a git repository of that name beside the docs worktree (`git -C "{path}" remote -v` names it), and when you find none, send `QUESTION design: where is the folder of {repository}?`.
   - You only read these folders. Run read-only commands in them.
   - A repository that holds no implementation code and carries only documents such as specifications is not a repository of the design. Do not count it when you settle the target layer.
7. Settle the target layer (対象レイヤ): `バックエンドのみ`, `フロントエンドのみ` or `フルスタック`.
   - `design.json` exists and `scope.layer` is set: take it. Do not ask.
   - Else, `requirement.json` states, in whatever words, that exactly one repository receives code changes: take the default below. Do not ask.
   - Else (two or more repositories, or none stated, or it reads unclear): the default below becomes a question of stage 3. Keep it as `layer question`, and investigate every repository in scope meanwhile.
   - The default: from `scope.out_of_scope`, and from whether `{case root}/ui-references/` holds a file. A scope that puts the screens out and has no UI reference is `バックエンドのみ`. A scope that puts the server side out is `フロントエンドのみ`. Otherwise `フルスタック`.
8. Go to [2-investigation](2-investigation.md).

## Send the case back to the requirement

Use it when the requirement is what has to change: a design-scope item is not written ("Steps", 5), or the owner's revision of stage 6 amounts to a requirement change. Never edit `requirement.json` in this unit.

1. When the unit holds work in progress (`design.json`, `technical-notes.md`, `code-facts-base.json`, `creator-facts.md`, `{records}/`), commit it first, as a commit of its own, each path by itself ([branch-and-pr](../shared/branch-and-pr.md), "Commit the case root"). Say in the message that it is the design work in progress at the reopen. When an ADR was written in stage 6, delete its file first and leave it out of the commit.
2. Run the `reopen` recipe of [case-json](../shared/case-json.md) for the unit `requirement`, with the reason: the owner's words word for word, or the sentence above. It reopens the design too, and copies `design.json` to `records/design-base.json`.
3. Do not commit the reopen. The requirement unit's next commit of the case root takes `case.json`, the record and the base.
4. Send `REOPENED requirement: {reason in one line}`, and stop.
