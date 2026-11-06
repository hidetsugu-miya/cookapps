#!/bin/sh
# The hand-over between the runs of milestone-dev: one fixed Discussion (Ideas, titled 自走の引き継ぎ), one comment per run (issues.md).
# Usage: handover.sh ensure          prints the Discussion's URL; creates the Discussion when it does not exist yet
#        handover.sh read            ensure, then prints the last hand-over and the owner's replies since the run that wrote it started
#        handover.sh write <file>    posts the file as a hand-over comment and prints the comment's URL
#        handover.sh format          reads the JSON of a Discussion (the query of `read`) from stdin and prints what `read` prints; no network
# The runs write with the owner's account, so a comment is told by its mark `<!-- handover run-start=... -->`, which `write` puts on the first line.
# A comment without the mark is the owner's, and the next run reads it first and takes it as an instruction.
# HANDOVER_RUN_START (ISO time in UTC; nightly.sh sets it) is the start of the run; a reply written after it is left to the next run, which has not read it yet.
# HANDOVER_DRY_RUN=1 makes `write` print the comment and touch nothing.
# The repository is public: write no personal information in a comment (publishing.md).
set -u
title="自走の引き継ぎ"
mark='<!-- handover'

usage() {
  echo "使い方: handover.sh ensure | read | write <file> | format" >&2
  exit 2
}

repo_parts() {
  nwo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || return 1
  owner="${nwo%/*}"
  name="${nwo#*/}"
}

# find the Discussion: sets did (node id), durl and dnum, or leaves them empty
find_discussion() {
  repo_parts || return 1
  q='query($o:String!,$n:String!,$cursor:String){repository(owner:$o,name:$n){discussions(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id number url title category{name}}}}}'
  found="$(gh api graphql --paginate -f query="$q" -f o="$owner" -f n="$name" \
    --jq ".data.repository.discussions.nodes[] | select(.title == \"$title\" and .category.name == \"Ideas\") | [.id, .number, .url] | @tsv" | head -n 1)" || return 1
  did="$(printf '%s' "$found" | cut -f1)"
  dnum="$(printf '%s' "$found" | cut -f2)"
  durl="$(printf '%s' "$found" | cut -f3)"
}

create_discussion() {
  q='query($o:String!,$n:String!){repository(owner:$o,name:$n){id discussionCategories(first:25){nodes{id name}}}}'
  info="$(gh api graphql -f query="$q" -f o="$owner" -f n="$name")" || return 1
  rid="$(printf '%s' "$info" | jq -r '.data.repository.id')"
  cid="$(printf '%s' "$info" | jq -r '.data.repository.discussionCategories.nodes[] | select(.name == "Ideas") | .id')"
  [ -n "$rid" ] && [ -n "$cid" ] || {
    echo "リポジトリか Ideas カテゴリが見つかりません" >&2
    return 1
  }
  bodyfile="$(mktemp)"
  cat > "$bodyfile" <<'BODY'
## この記録の目的

`milestone-dev` の定期実行（毎日 01:00 / 09:00 / 13:00）が、次の回に引き継ぐことを書く場所です。
各回の終わりに 1 コメントが付きます。
コメントの先頭の印（`<!-- handover ... -->`）で、自走の回のコメントと見分けます。

## オーナーの返信

印のないコメントや返信は、オーナーのものとして、次の回が最初に読み、指示として扱います。
質問が書かれていたら、ここに答えを書いてください。

## 書かれること

- 着手中の issue と、その branch・worktree・段階
- この回の判断と理由（並び、リリース、待たせた理由）
- オーナーへの質問
- 次の回が最初にやること

個人情報は書きません（公開リポジトリです）。

Created by Claude Code
BODY
  m='mutation($r:ID!,$c:ID!,$t:String!,$b:String!){createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){discussion{id number url}}}'
  out="$(gh api graphql -f query="$m" -f r="$rid" -f c="$cid" -f t="$title" -F b=@"$bodyfile" --jq '.data.createDiscussion.discussion | [.id, .number, .url] | @tsv')"
  rc=$?
  rm -f "$bodyfile"
  [ "$rc" -eq 0 ] || return 1
  did="$(printf '%s' "$out" | cut -f1)"
  dnum="$(printf '%s' "$out" | cut -f2)"
  durl="$(printf '%s' "$out" | cut -f3)"
}

ensure() {
  find_discussion || return 1
  [ -n "$did" ] || create_discussion || return 1
}

# stdin: the Discussion with its comments (and their replies); stdout: the text of `read`
format() {
  jq -r --arg mark "$mark" '
    .data.repository.discussion as $d
    | ([$d.comments.nodes[] | ., (.replies.nodes // [])[]] | map(del(.replies)) | sort_by(.createdAt)) as $all
    | ($all | map(select(.body | contains($mark)))) as $marked
    | ($marked | last) as $last
    | (if $last == null then "" else ((($last.body | capture("<!-- handover run-start=(?<t>[^ ]+) -->")? | .t) // $last.createdAt)) end) as $cutoff
    | ($all | map(select((.body | contains($mark) | not) and .createdAt > $cutoff))) as $replies
    | "discussion: \($d.url)",
      (if $last == null then "last handover: none yet" else "last handover: \($last.url) (run started \($cutoff))\n---\n\($last.body)\n---" end),
      "owner replies since: \($replies | length)",
      ($replies[] | "\n[\(.createdAt) \(.author.login // "unknown")] \(.url)\n\(.body)")
  '
}

cmd="${1:-}"
case "$cmd" in
  ensure)
    [ $# -eq 1 ] || usage
    ensure || exit 1
    echo "$durl"
    ;;
  read)
    [ $# -eq 1 ] || usage
    ensure || exit 1
    q='query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){discussion(number:$num){url comments(last:100){nodes{url body createdAt author{login} replies(first:50){nodes{url body createdAt author{login}}}}}}}}'
    gh api graphql -f query="$q" -f o="$owner" -f n="$name" -F num="$dnum" | format
    ;;
  write)
    [ $# -eq 2 ] || usage
    [ -r "$2" ] || {
      echo "読めません: $2" >&2
      exit 2
    }
    start="${HANDOVER_RUN_START:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
    bodyfile="$(mktemp)"
    trap 'rm -f "$bodyfile"' EXIT
    {
      echo "${mark} run-start=${start} -->"
      grep -v -F "$mark" "$2"
    } > "$bodyfile"
    if [ -n "${HANDOVER_DRY_RUN:-}" ]; then
      cat "$bodyfile"
      exit 0
    fi
    ensure || exit 1
    m='mutation($id:ID!,$b:String!){addDiscussionComment(input:{discussionId:$id,body:$b}){comment{url}}}'
    gh api graphql -f query="$m" -f id="$did" -F b=@"$bodyfile" --jq '.data.addDiscussionComment.comment.url'
    ;;
  format)
    [ $# -eq 1 ] || usage
    format
    ;;
  *) usage ;;
esac
