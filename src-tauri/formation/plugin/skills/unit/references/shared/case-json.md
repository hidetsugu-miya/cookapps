# case.json

`{case root}/case.json` holds where the case stands: its meta, the repositories, the status of every unit, and the implementations.
It is the one record the leader reads to decide the next unit, so it must always be true and valid.
There is no command for it here. You change it with `jq` and a check, as this file says, and nothing else writes it.

## The shape

```json
{
  "ticket": "https://example.atlassian.net/browse/PROJ-123",
  "base_branch": "feature/PROJ-123",
  "documents": {"requirement": "requirement.json", "design": "design.json"},
  "repos": [
    {"name": "shop-api", "name_with_owner": "example-org/shop-api", "docs": true, "pull_request": 12},
    {"name": "shop-front", "name_with_owner": "example-org/shop-front", "docs": false, "pull_request": null}
  ],
  "stages": {
    "requirement": {"status": "完了", "reopen": null},
    "design": {"status": "完了", "reopen": null},
    "specification": {"status": "未着手", "reopen": null, "repo": null}
  },
  "implementations": [
    {"key": "shop-api-1", "repo": "shop-api", "kind": "前提改修", "status": "完了", "design_ids": ["DESIGN-05", "DESIGN-06"], "reopen": null, "child": {"branch": "feature/PROJ-123-01", "pull_request": 14, "merged": true}},
    {"key": "shop-api-2", "repo": "shop-api", "kind": "機能", "status": "未着手", "design_ids": ["DESIGN-08"], "reopen": null, "child": null},
    {"key": "shop-front", "repo": "shop-front", "kind": "機能", "status": "進行中", "design_ids": ["DESIGN-07"], "reopen": "records/reopen-shop-front-20261102-150405.md", "child": {"branch": "feature/PROJ-123-02", "pull_request": null, "merged": false}}
  ]
}
```

| Field | Content |
| --- | --- |
| `ticket` | The ticket URL, or an empty string. |
| `base_branch` | The case's base branch. A valid git branch name. |
| `documents` | Paths of the two deliverables, relative to the case root. Always `requirement.json` and `design.json`. |
| `repos[]` | The repositories of the case. At least one. `name` is the repository's directory name, `name_with_owner` is `{owner}/{repo}` (an empty string when it is not known), `docs` is `true` on exactly one element (the docs repository, which holds the case root), `pull_request` is the number of the aggregate pull request of that repository, or `null`. |
| `stages` | The status of the requirement, the design and the specification. `reopen` is the path (relative to the case root) of the record that reopened the stage, or `null`. `specification.repo` is the name of the repository the specification is written in, or `null` for the docs repository. |
| `implementations[]` | One element for each implementation. `key` is its name for commands and its folder `records/{key}/`. `repo` is its repository. `kind` is `機能` when any of its DESIGN items is a feature, else `前提改修`. `design_ids` are its DESIGN items. `child` is its child branch, or `null` (below). |

`implementations[].child` has three keys, all present when it is not `null`: `branch` (the child branch), `pull_request` (the number of the child pull request, or `null`), `merged` (`true` once the child is merged into the base branch).

The keys `release`, `release_prs`, `merged_pull_requests` and `released` are not used here. If a file has them, leave them as they are.

## Statuses

A stage (requirement, design, specification) and an implementation are each `未着手`, `進行中` or `完了`.
An implementation is `進行中` from its start to its merge, and `完了` once its child is merged.

| Change | When |
| --- | --- |
| `未着手` to `進行中` | You start the unit. |
| `進行中` to `完了` | The unit's completion criteria are met, as its procedure says. Setting `完了` clears the unit's `reopen`. |
| anything to `未着手` | Only by a reopen. |

## The order of the units

The line is: `requirement`, `design`, the implementations in the array order of `implementations[]`, `specification`.
The next unit is the first one that is not `完了`.
You do not decide the order. The design procedure writes `implementations[]` in it.

## How to change it

Every change is one run of this frame. `{options}` and `{filter}` come from the recipes below.
It writes a new file, checks it with the program `case-check.jq`, and replaces `case.json` only when the check prints nothing.
A line starting with `REFUSED:` means nothing was written: read the violations, fix the filter, and run it again.

```sh
c="{case root}/case.json"
jq {options} '{filter}' "$c" > "$c.new" && v="$(jq -r -f "{jq dir}/case-check.jq" "$c.new")" && [ -z "$v" ] && mv "$c.new" "$c" || { echo "REFUSED: $v"; rm -f "$c.new"; }
```

Check a file as it stands with `jq -r -f "{jq dir}/case-check.jq" "{case root}/case.json"`: no output means it is valid.

Always write `{case root}` as an absolute path. Your own folder may be another repository than the docs repository.
Only one unit works at a time, but write each change as one atomic replace, as above.

### Create a new case

Only the requirement unit does this, when `case.json` does not exist yet.
`{name with owner}` is the output of `gh repo view --json nameWithOwner --jq .nameWithOwner` run in the docs worktree (an empty string when it fails).

```sh
c="{case root}/case.json"; mkdir -p "{case root}"
jq -n --arg base "{base branch}" --arg ticket "{ticket or empty}" --arg repo "{docs repository name}" --arg nwo "{name with owner}" '{
  ticket: $ticket, base_branch: $base,
  documents: {requirement: "requirement.json", design: "design.json"},
  repos: [{name: $repo, name_with_owner: $nwo, docs: true, pull_request: null}],
  stages: {requirement: {status: "進行中", reopen: null}, design: {status: "未着手", reopen: null}, specification: {status: "未着手", reopen: null, repo: null}},
  implementations: []
}' > "$c.new" && v="$(jq -r -f "{jq dir}/case-check.jq" "$c.new")" && [ -z "$v" ] && mv "$c.new" "$c" || { echo "REFUSED: $v"; rm -f "$c.new"; }
```

### status

Options: `--arg u "{unit key}" --arg s "{status}"`.
It sets the status of a stage or an implementation, and clears `reopen` when the status is `完了`.

```jq
def set: .status = $s | if $s == "完了" then .reopen = null else . end;
if ($u == "requirement" or $u == "design" or $u == "specification") then .stages[$u] |= set
else .implementations |= map(if (.key // .repo) == $u then set else . end) end
```

### meta

Options: `--arg ticket "{ticket}" --arg base "{base branch}"`. Leave out the filter line of a field you do not change.

```jq
.ticket = $ticket | .base_branch = $base
```

### repo-add

Adds a repository, once. `docs` is `false` and `pull_request` is `null`.
Options: `--arg name "{repo name}" --arg nwo "{name with owner}"`.

```jq
if any(.repos[]; .name == $name) then . else .repos += [{name: $name, name_with_owner: $nwo, docs: false, pull_request: null}] end
```

### pr

Records the number of the aggregate pull request of a repository.
Options: `--arg name "{repo name}" --argjson n {number}`.

```jq
.repos |= map(if .name == $name then .pull_request = $n else . end)
```

### set-repo

Sets the repository the specification is written in. An empty `{repo}` means the docs repository.
Options: `--arg r "{repo name or empty}"`.

```jq
.stages.specification.repo = (if $r == "" then null else $r end)
```

### child

Records one fact of the child branch of an implementation.
Options: `--arg u "{key}"` and one of the three following pairs.
The unit must be an implementation. Do not record a different branch for an implementation that already has one: its child lives as long as the implementation does.

- The branch (set it when you start on it): `--arg b "{child branch}"`

  ```jq
  .implementations |= map(if (.key // .repo) == $u then .child = (.child // {branch: $b, pull_request: null, merged: false}) else . end)
  ```

- The pull request number: `--argjson n {number}`

  ```jq
  .implementations |= map(if (.key // .repo) == $u and .child != null then .child.pull_request = $n else . end)
  ```

- The merge: no extra option. The implementation must be `進行中` or `完了` already.

  ```jq
  .implementations |= map(if (.key // .repo) == $u and .child != null then .child.merged = true else . end)
  ```

### reopen

Sets a unit back to `未着手` and records why, so that the unit's procedure starts again from the reason.
The leader names the unit in your first instruction, with the owner's words as the reason.

1. The unit must exist. An implementation that holds no DESIGN (`design_ids` is empty) cannot be reopened.
2. Make the record name: `records/reopen-{unit}-{YYYYmmdd-HHMMSS}.md` (`date +%Y%m%d-%H%M%S`). It must not exist yet.
3. Collect the records the unit still holds. A unit that has `reopen` set has not redone the earlier reopen yet: read that file. Reopening `requirement` also reopens `design`, so read the design's `reopen` file too.
4. Write the record with the Write tool: a heading `# Reopen {unit}`, the reason (the owner's words, verbatim), and, when there are earlier records, a section `## まだ処理されていない先の理由` with each earlier record's body under `### {its path}`.
5. For `requirement` and `design`, keep the design as it was: when `design.json` exists and `records/design-base.json` does not, run `cp "{case root}/design.json" "{case root}/records/design-base.json"`. The design procedure compares the redone design with it. Never overwrite an existing base.
6. Run the frame with options `--arg u "{unit}" --arg rec "records/reopen-{unit}-{timestamp}.md"`:

   ```jq
   def reopen: .status = "未着手" | .reopen = $rec;
   (if $u == "requirement" then .stages.requirement |= reopen | .stages.design |= reopen
    elif $u == "design" then .stages.design |= reopen
    elif $u == "specification" then .stages.specification |= reopen
    else .implementations |= map(if (.key // .repo) == $u then (reopen | if .child != null and .child.merged == true then .child = null else . end) else . end) end)
   | if $u != "specification" and .stages.specification.status == "完了" then .stages.specification.status = "未着手" else . end
   ```

What it does: the other units keep their statuses. A reopened implementation keeps an unmerged child (the redo goes on there) and loses a merged one (the redo starts a new child). A `完了` specification goes back to `未着手`, because what it wrote no longer holds.
The record and `case.json` are committed with the unit's next case-root commit ([branch-and-pr](branch-and-pr.md)).

### The implementations

Only the design procedure writes the elements of `implementations[]` (it derives them from `design.json`).
An element has `key`, `repo`, `kind`, `status`, `design_ids`, `reopen` and `child`, as in the shape above.
`key` is the repository's name when its DESIGN items fall in one stage, and `{repo}-{n}` (`n` from 1) for the n-th stage when they fall in several.
The elements of one repository stand next to each other, in rising stage. The check refuses anything else.

## What the check enforces

`case-check.jq` prints one line for each violation:

- the keys that must be there (`base_branch`, `documents`, `repos`, `stages`, `implementations`, and the keys of each element), and the types of the values,
- a valid branch name for `base_branch` and for each `child.branch`, which must differ from `base_branch` and from every other child branch,
- exactly one `repos` element with `docs` `true`, and unique repository names without a path separator,
- the allowed statuses above, and `child.merged` `true` only for an implementation that is `進行中` or `完了`,
- `implementations[].repo` is a repository of `repos`, but not `requirement`, `design` or `specification`; each `key` is unique, is not one of those three words, and is the repository's name or starts with it and a hyphen; `design_ids` are distinct `DESIGN-NN`,
- `stages.specification.repo` is `null` or a repository of `repos`,
- every `reopen` is `null` or a relative path that stays inside the case root.

```jq case-check
def missing($keys): . as $o | $keys[] | . as $k | select($o | has($k) | not);
def badbranch: type != "string" or . == "" or startswith("-") or startswith("/") or endswith("/") or endswith(".") or endswith(".lock") or contains("..") or contains("//") or contains("@{") or test("[\\s~^:?*\\[\\\\]") or test("[\\x00-\\x1f\\x7f]");
def badrel: type != "string" or . == "" or startswith("/") or contains("..");
def posint: type == "number" and . >= 1 and . == floor;
def inl($l): . as $v | ($l | index($v)) != null;
def reserved: ["requirement", "design", "specification"];
def repo_check($i):
  if type != "object" then "repos[\($i)] must be an object" else
    (missing(["name", "name_with_owner", "docs", "pull_request"]) | "repos[\($i)]: missing key \(.)"),
    (if has("name") and (.name | type != "string" or (test("^[A-Za-z0-9._-]+$") | not) or . == "." or . == "..") then "repos[\($i)].name must be one repository name without path separators" else empty end),
    (if has("docs") and (.docs | type) != "boolean" then "repos[\($i)].docs must be true or false" else empty end),
    (if has("pull_request") and .pull_request != null and (.pull_request | posint | not) then "repos[\($i)].pull_request must be null or a positive integer" else empty end)
  end;
def stage_check($k; $names):
  if type != "object" then "stages.\($k) must be an object" else
    (missing(["status", "reopen"]) | "stages.\($k): missing key \(.)"),
    (if has("status") and ((.status | inl(["未着手", "進行中", "完了"])) | not) then "stages.\($k).status must be 未着手, 進行中 or 完了" else empty end),
    (if has("reopen") and .reopen != null and (.reopen | badrel) then "stages.\($k).reopen must be null or a relative path inside the case root" else empty end),
    (if $k == "specification" then
       (if has("repo") | not then "stages.specification: missing key repo"
        elif .repo != null and ((.repo | inl($names)) | not) then "stages.specification.repo must be null or a repos name" else empty end)
     else empty end)
  end;
def impl_check($i; $names; $base):
  if type != "object" then "implementations[\($i)] must be an object" else
    (missing(["repo", "kind", "status", "design_ids", "reopen"]) | "implementations[\($i)]: missing key \(.)"),
    (if has("repo") and ((.repo | inl($names)) | not) then "implementations[\($i)].repo is not a repos name" else empty end),
    (if has("repo") and (.repo | inl(reserved)) then "implementations[\($i)].repo must not be requirement, design or specification" else empty end),
    (if has("kind") and ((.kind | inl(["機能", "前提改修"])) | not) then "implementations[\($i)].kind must be 機能 or 前提改修" else empty end),
    (if has("status") and ((.status | inl(["未着手", "進行中", "完了"])) | not) then "implementations[\($i)].status must be 未着手, 進行中 or 完了" else empty end),
    (if has("design_ids") and ((.design_ids | type) != "array" or (.design_ids | any(type != "string" or (test("^DESIGN-[0-9]+$") | not))) or ((.design_ids | length) != (.design_ids | unique | length))) then "implementations[\($i)].design_ids must be an array of distinct DESIGN-NN" else empty end),
    (if has("reopen") and .reopen != null and (.reopen | badrel) then "implementations[\($i)].reopen must be null or a relative path inside the case root" else empty end),
    (if has("key") and (.key | type != "string" or inl(reserved)) then "implementations[\($i)].key must be a string other than requirement, design and specification"
     elif has("key") and has("repo") and (.key != .repo) and ((.repo as $r | .key | startswith($r + "-")) | not) then "implementations[\($i)].key must be the repo name or start with the repo name and a hyphen" else empty end),
    (if has("child") and .child != null then
       (if (.child | type) != "object" then "implementations[\($i)].child must be null or an object"
        else (.child | missing(["branch", "pull_request", "merged"]) | "implementations[\($i)].child: missing key \(.)"),
             (if (.child | has("branch")) and ((.child.branch | badbranch) or .child.branch == $base) then "implementations[\($i)].child.branch must be a valid branch name other than base_branch" else empty end),
             (if (.child | has("pull_request")) and .child.pull_request != null and (.child.pull_request | posint | not) then "implementations[\($i)].child.pull_request must be null or a positive integer" else empty end),
             (if (.child | has("merged")) and ((.child.merged | type) != "boolean") then "implementations[\($i)].child.merged must be true or false" else empty end),
             (if .child.merged == true and ((.status | inl(["進行中", "完了"])) | not) then "implementations[\($i)].child.merged is true only for 進行中 or 完了" else empty end)
        end)
     else empty end)
  end;
. as $c
| if ($c | type) != "object" then "case.json is not an object" else
  ([$c.repos // [] | .[]? | select(type == "object") | .name]) as $names
  | [
      ($c | missing(["base_branch", "documents", "repos", "stages", "implementations"]) | "missing key \(.)"),
      (if ($c | has("base_branch")) and ($c.base_branch | badbranch) then "base_branch is not a valid branch name" else empty end),
      (if ($c | has("ticket")) and ($c.ticket | type) != "string" then "ticket must be a string" else empty end),
      (if $c | has("documents") then
         (if ($c.documents | type) != "object" then "documents must be an object"
          else ($c.documents | missing(["requirement", "design"]) | "documents: missing key \(.)"),
               (["requirement", "design"][] | . as $k | select(($c.documents | has($k)) and ($c.documents[$k] | badrel)) | "documents.\($k) must be a relative path inside the case root") end)
       else empty end),
      (if $c | has("repos") then
         (if ($c.repos | type) != "array" or ($c.repos | length) == 0 then "repos must be a non-empty array"
          else
            ($c.repos | to_entries[] | .key as $i | .value | repo_check($i)),
            (if ([$c.repos[] | select(type == "object" and .docs == true)] | length) != 1 then "exactly one repos element must have docs true" else empty end),
            (if ($names | length) != ($names | unique | length) then "repos: duplicate name" else empty end)
          end)
       else empty end),
      (if $c | has("stages") then
         (if ($c.stages | type) != "object" then "stages must be an object"
          else ($c.stages | missing(["requirement", "design", "specification"]) | "stages: missing key \(.)"),
               (["requirement", "design", "specification"][] | . as $k | select($c.stages | has($k)) | $c.stages[$k] | stage_check($k; $names)) end)
       else empty end),
      (if $c | has("implementations") then
         (if ($c.implementations | type) != "array" then "implementations must be an array"
          else
            ($c.implementations | to_entries[] | .key as $i | .value | impl_check($i; $names; $c.base_branch)),
            (([$c.implementations[] | select(type == "object") | (.key // .repo)] | map(select(. != null))) as $keys
             | if ($keys | length) != ($keys | unique | length) then "implementations: duplicate key" else empty end),
            (([$c.implementations[] | select(type == "object") | .child | select(. != null and type == "object") | .branch] | map(select(. != null))) as $bs
             | if ($bs | length) != ($bs | unique | length) then "implementations: duplicate child branch" else empty end),
            (([$c.implementations[] | select(type == "object") | .repo]) as $rs
             | [$rs | to_entries[] | select(.key > 0 and .value != $rs[.key - 1]) | .value] as $starts
             | if ($starts | length) != ($starts | unique | length) or (($starts | index($rs[0])) != null) then "implementations: the implementations of one repository must be next to each other" else empty end)
          end)
       else empty end)
    ] | .[]
  end
```
