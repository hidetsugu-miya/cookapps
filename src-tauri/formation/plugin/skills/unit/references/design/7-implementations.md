# Stage 7: Implementations

Derive `implementations[]` of `case.json` from the approved design.
Each implementation is the work of one stage of one repository: the DESIGN items of that repository that depend on no other item of the same stage.
The leader launches one child for each implementation, in the order of the array ([case-json](../shared/case-json.md), "The order of the units").

Only this stage writes the elements of `implementations[]`. Run it while `stages.design` is not yet `完了`: the redo of a reopened design takes its record from `stages.design.reopen`, and completing the design clears it.

Start only when `{records}/approved.json` holds the hash of the `design.json` on disk ([6-approval](6-approval.md), "Approved"). A different hash means the approval has expired: go back to stage 6.

## Steps

### 1. Register the repositories

Every repository a DESIGN item names, and every repository of `implementation_order`, must be in `repos[]` of `case.json`.
For each one that is not, run the `repo-add` recipe of [case-json](../shared/case-json.md), with `{name with owner}` from `gh repo view --json nameWithOwner --jq .nameWithOwner` run in its `{repo root}`, and an empty string when it fails.

### 2. Check what the derivation needs

```sh
jq -nr --slurpfile design "{case root}/design.json" --slurpfile case "{case root}/case.json" -f "{jq dir}/impl-precheck.jq"
```

```jq impl-precheck
$design[0] as $d | $case[0] as $c
| ($c.repos | map(.name)) as $names
| (if ($d.implementation_order | length) == 0 then "implementation_order is empty" else empty end),
  ($d.implementation_order[] | select(. as $r | $names | index($r) == null) | "implementation_order: \(.) is not a repository of case.json"),
  ($d.designs[] | select(.repository == null or (.repository as $r | $d.implementation_order | index($r) == null)) | "\(.id): its repository is not in implementation_order")
```

A line printed is a fault of the design. Delete `{records}/approved.json`, run [4-authoring](4-authoring.md) with the kind `revision` and the lines as the request, then [5-review](5-review.md) ("The pass that stage 6 sends back") and [6-approval](6-approval.md) again, and come back here.

### 3. Derive the implementations

The program reads the design, the copy of the design that was taken when the design was reopened (`records/design-base.json`, absent otherwise), and `case.json`. It writes the new `case.json` and a report. It writes nothing before the check passes.

```sh
c="{case root}/case.json"; b="{case root}/records/design-base.json"; [ -f "$b" ] || b=/dev/null
jq -n --slurpfile design "{case root}/design.json" --slurpfile base "$b" --slurpfile case "$c" -f "{jq dir}/impl-generate.jq" > "{scratch}/generated.json" \
  && jq .case "{scratch}/generated.json" > "$c.new" && v="$(jq -r -f "{jq dir}/case-check.jq" "$c.new")" && [ -z "$v" ] && mv "$c.new" "$c" || { echo "REFUSED: $v"; rm -f "$c.new"; }
jq .report "{scratch}/generated.json"
```

```jq impl-generate
def relof: (.release // 1);
def keyof: (.key // .repo);
def idnum: .[7:] | tonumber;
def sortids: sort_by(idnum);

# The stage of each DESIGN of one repository: {id: stage}.
def stages($ds):
  ($ds | map({key: .id, value: 1}) | from_entries) as $init
  | reduce range(0; ($ds | length) + 1) as $_ ($init;
      . as $s
      | reduce $ds[] as $x (.;
          .[$x.id] = ([1,
              ($x.depends_on[]? | select(.id as $i | $ds | any(.id == $i)) | $s[.id] + 1),
              ($ds[] | select(relof < ($x | relof)) | $s[.id] + 1)] | max)));

# One element for each stage of each repository, in implementation_order.
def plan($d):
  [$d.implementation_order[] as $repo
   | [$d.designs[] | select(.repository == $repo)] as $ds
   | select(($ds | length) > 0)
   | stages($ds) as $st
   | ($st | [.[]] | max) as $n
   | range(1; $n + 1) as $i
   | [$ds[] | select($st[.id] == $i)] as $g
   | {repo: $repo,
      key: (if $n == 1 then $repo else "\($repo)-\($i)" end),
      design_ids: ($g | map(.id) | sortids),
      kind: (if any($g[]; .kind == "機能") then "機能" else "前提改修" end)}];

# The DESIGNs a redone design reaches: the ones added, removed or changed, the ones a changed shared
# material names, and the DESIGNs of the same repository that depend on any of them (in either file).
def changed($b; $d):
  if $b == null then [] else
    ($b.designs | map({key: .id, value: .}) | from_entries) as $x
    | ($d.designs | map({key: .id, value: .}) | from_entries) as $y
    | [(($x | keys) + ($y | keys)) | unique[] | select($x[.] != $y[.])] as $own
    | (($b.shared // []) | map({key: .topic, value: .}) | from_entries) as $sx
    | (($d.shared // []) | map({key: .topic, value: .}) | from_entries) as $sy
    | [(($sx | keys) + ($sy | keys)) | unique[] | select($sx[.] != $sy[.])] as $topics
    | [($b.shared[]?, $d.shared[]?) | select(.topic as $t | $topics | index($t) != null) | .applies_to[]?.id] as $viashared
    | [$b.designs[]?, $d.designs[]?] as $all
    | ($all | map({key: .id, value: .repository}) | from_entries) as $repo
    | reduce range(0; ($all | length) + 1) as $_ (($own + $viashared) | unique;
        . as $seed
        | ($seed + [$all[] | . as $x
                    | select(any($x.depends_on[]?; (.id as $i | $seed | index($i) != null) and $repo[.id] == $x.repository))
                    | $x.id]) | unique)
  end;

# One plan element and the entry it comes from: {s, how, from}.
def assign($P; $E):
  ($P | map(.repo + "|" + .key)) as $pk
  | [$E | to_entries[] | select((.value.repo + "|" + (.value | keyof)) as $k | $pk | index($k) == null) | .key] as $free
  | reduce $P[] as $s ({res: [], taken: [], donors: []};
      . as $st
      | ([$E | to_entries[] | select(.value.repo == $s.repo and (.value | keyof) == $s.key) | .key] | first) as $m
      | ([$free[] | . as $i | $E[$i] as $e
          | select(($st.taken | index($i)) == null and $e.repo == $s.repo and ($e.design_ids | sortids) == $s.design_ids)
          | $i] | first) as $r
      | ([$free[] | . as $i | $E[$i] as $e
          | select($e.repo == $s.repo and $e.status == "完了" and ($e.design_ids | length) > 0
              and ($s.design_ids | all(. as $x | $e.design_ids | index($x) != null))
              and ([$P[] | select(.repo == $s.repo and (.design_ids | any(. as $x | $e.design_ids | index($x) != null)))] | length) >= 2)
          | $i] | first) as $sp
      | if $m != null then .res += [{s: $s, how: "match", from: $m}] | .taken += [$m]
        elif $r != null then .res += [{s: $s, how: "rename", from: $r}] | .taken += [$r]
        elif $sp != null then .res += [{s: $s, how: "split", from: $sp}] | .donors += [$sp]
        else .res += [{s: $s, how: "new", from: null}] end)
  | . + {free: $free};

# The new implementations[] and what happened to each entry.
def generate($d; $b; $c; $rec):
  plan($d) as $P
  | changed($b; $d) as $ch
  | $c.implementations as $E
  | assign($P; $E) as $a
  | ($a.res | map(
      . as $r | $r.s as $s
      | (if $r.from == null then null else $E[$r.from] end) as $e
      | if $r.how == "new" then
          {as: "created", entry: {key: $s.key, repo: $s.repo, kind: $s.kind, status: "未着手", design_ids: $s.design_ids, reopen: null, child: null}}
        else
          (if $r.how == "split"
           then {key: $s.key, repo: $s.repo, kind: $s.kind, status: $e.status, design_ids: $s.design_ids, reopen: $e.reopen, child: null}
           else $e + {key: ($e | keyof)} end) as $old
          | (if $r.how == "split" then $s.design_ids else (($e.design_ids // []) + $s.design_ids) end) as $held
          | if $old.status == "完了" and ($held | any(. as $x | $ch | index($x) != null)) then
              {as: "reopened",
               entry: ($old + {key: $s.key, kind: $s.kind, design_ids: $s.design_ids, status: "未着手", reopen: $rec,
                               child: (if $old.child != null and $old.child.merged == true then null else ($old.child // null) end)})}
            else
              {as: (if $r.how == "split" or ($old.design_ids | sortids) != $s.design_ids or $old.kind != $s.kind or $old.key != $s.key then "updated" else "unchanged" end),
               entry: ($old + {key: $s.key, kind: $s.kind, design_ids: $s.design_ids, child: ($old.child // null)})}
            end
        end)) as $kept
  | ([$a.free[] | select((. as $i | ($a.taken | index($i)) == null and ($a.donors | index($i)) == null))] | map($E[.])) as $left
  | ($left | map(
      if .status | IN("未着手", "進行中") then {as: "removed", entry: .}
      else {as: "orphaned", entry: (. + {design_ids: []}), former: .status} end)) as $gone
  | ($a.donors | unique | map($E[.]) | map({as: "removed", entry: ., former: .status})) as $donated
  | (($gone + $donated) | map(select(.entry.child != null and .entry.child.merged == false)
        | {key: (.entry | keyof), repo: .entry.repo, branch: .entry.child.branch, pull_request: .entry.child.pull_request, former_status: (.former // .entry.status)})) as $unmerged
  | ($kept + ($gone | map(select(.as == "orphaned")))) as $all
  | ($P | map(.repo) | reduce .[] as $r ([]; if index($r) then . else . + [$r] end)) as $order
  | (($all | map(.entry.repo)) | reduce .[] as $r ($order; if index($r) then . else . + [$r] end)) as $repos
  | ([$repos[] as $r | $all[] | select(.entry.repo == $r)]) as $sorted
  | {case: ($c | .implementations = ($sorted | map(.entry))),
     report: {
       created: ($sorted | map(select(.as == "created") | {key: .entry.key, repo: .entry.repo, status: .entry.status})),
       updated: ($sorted | map(select(.as == "updated") | {key: .entry.key, repo: .entry.repo, status: .entry.status})),
       unchanged: ($sorted | map(select(.as == "unchanged") | {key: .entry.key, repo: .entry.repo, status: .entry.status})),
       reopened: ($sorted | map(select(.as == "reopened") | {key: .entry.key, repo: .entry.repo, status: .entry.status})),
       orphaned: ($sorted | map(select(.as == "orphaned") | {key: .entry.key, repo: .entry.repo, status: .entry.status})),
       removed: (($gone + $donated) | map(select(.as == "removed") | {key: (.entry | keyof), repo: .entry.repo, status: .entry.status})),
       unmerged_children: $unmerged}};

generate($design[0]; $base[0]; $case[0]; $case[0].stages.design.reopen)
```

A line starting with `REFUSED:` means `case.json` was left as it was, and the lines are what `case-check` found (a duplicate key, for example when the second stage of `api` and a repository named `api-1` with one stage both come to `api-1`). It is a fault of the design, or of the names of the repositories, that you cannot fix with a recipe: send `BLOCKED design: the implementations could not be derived`, with the lines and what you tried, and stop.
The leader and the owner settle it (rename a repository, or change the number of stages).

### 4. What the program did

It rebuilds `implementations[]` from the stages of the approved design, and keeps what the work already did.

- **Stages.** In each repository, in the order of `implementation_order`, a DESIGN item is in the stage after the latest stage of the items of the same repository that it depends on, and, when the items write `release`, after every item of an earlier release. The items of one stage do not depend on each other, and are implemented together. A repository with one stage has one implementation, keyed by the repository's name. One with `n` stages has `n`, keyed `{repo}-1` to `{repo}-{n}`. An implementation's `kind` is `機能` when any item of its stage is `機能`, else `前提改修`. Its `design_ids` run in id order.
- **Releases.** A release changes the stages inside a repository only. This flow has one aggregate pull request for each repository and runs the units in the order of `implementations[]`, with the implementations of one repository next to each other ([case-json](../shared/case-json.md)). It cannot run one repository's later release before another repository's earlier one: the check "Staged releases" of [rules](rules.md) covers that.
- **Matching the entries that exist.** An existing entry is the stage of its repository with the same key.
  - No such entry, but an entry of the repository that no stage keys holds exactly the DESIGN items of the stage (the number of stages changed): it is the same work under another key. It takes the stage's key and keeps its status.
  - No such entry either, but an entry that no stage keys is `完了`, has DESIGN items in two or more stages of the repository, and every item of this stage is one it held (the finished work was divided): the stage takes its status and `reopen`, with its own `design_ids` and `kind`, and a `child` of `null`. The entry it came from is dropped (`removed`).
  - Otherwise the stage is new: `未着手`, listed under `created`.
- **Redone work.** When `records/design-base.json` exists (the design was reopened), the program names the DESIGN items that the redo reaches: the items added, removed or changed, the items of a shared material that changed, and the items of the same repository that depend on any of them. An implementation that is `完了` and held or now holds one of them goes back to `未着手`, with `reopen` set to the record of the design's reopen, so that its child reads the same revision request. An unmerged `child` stays (the redo goes on there), and a merged one is cleared (the redo starts a new child). An implementation that is `未着手` or `進行中` is not reset. Without the base, nothing is reopened.
- **Entries no stage has any more.** One that is `未着手` or `進行中` is dropped (`removed`). One that is `完了` stays after the other implementations of its repository, with empty `design_ids`, because its code is already on the base branch (`orphaned`). An orphan holds no DESIGN item, so the `reopen` recipe of [case-json](../shared/case-json.md) refuses it: there is nothing to redo.
- **Children.** Every entry that is dropped or kept as an orphan, and whose child was not merged, is in `unmerged_children`, with the status it had before. Its branch exists and its code is not in the base branch. This stage merges, deletes and closes nothing.

The report is one JSON object: `created`, `updated`, `unchanged`, `reopened`, `orphaned`, `removed`, and `unmerged_children`.
Each element of the first six is `{key, repo, status}`. An element of `unmerged_children` is `{key, repo, branch, pull_request, former_status}`.

### 5. Take away the base

When `records/design-base.json` exists, the redo has used it. Remove it:

```sh
git -C "{docs worktree}" rm -q -f --ignore-unmatch -- ".feature-dev/current/records/design-base.json"; rm -f "{case root}/records/design-base.json"
```

Keep the report for [8-completion](8-completion.md): `reopened`, `orphaned`, `removed` and `unmerged_children`.
Then go on to [8-completion](8-completion.md).
