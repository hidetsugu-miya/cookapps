#!/bin/sh
# Writes the unanswered proposals (open issues with proposal and needs:owner) into CLAUDE.local.md of the main checkout, so that the next session tells the owner (issues.md).
# Usage: proposal-reminder.sh  (no arguments)
# Rewrites only the section between the two marker lines below; nothing outside it changes. With no unanswered proposal the section is removed.
# Exits 1 and leaves the file as it is when gh fails or the markers are broken.
set -u
start='<!-- proposal-reminder:start -->'
end='<!-- proposal-reminder:end -->'
main="$(cd "$(dirname "$0")" && git rev-parse --path-format=absolute --git-common-dir)/.."
cd "$main" || exit 1
file="$(pwd -P)/CLAUDE.local.md"
list="$(gh issue list --state open --label proposal --label needs:owner --limit 100 --json number,title,createdAt --jq '.[] | "- #\(.number) \(.title)（\(.createdAt[0:10])）"')" || {
  echo "gh issue list が失敗しました" >&2
  exit 1
}
tmp="${file}.tmp.$$"
sec="${file}.sec.$$"
trap 'rm -f "$tmp" "$sec"' EXIT
if [ -n "$list" ]; then
  n="$(printf '%s\n' "$list" | wc -l | tr -d ' ')"
  {
    echo "$start"
    echo "## 未回答の提案（${n} 件）"
    echo
    echo "オーナーと話すメインのセッションだけが知らせる（サブエージェントは知らせない）。"
    echo "最初の返答の前に \`.claude/tools/proposal-reminder.sh\` を実行してこの節を最新にし、\`gh issue list --state open --label proposal --label needs:owner\` に残る提案だけを、件数と一覧で知らせる。オーナーが答えるまで、毎回のセッションで知らせる。"
    echo "下の一覧は ${n} 件（更新の時点）。"
    echo "採用はオーナーが needs:owner を外すこと、不採用は wontfix で閉じること。"
    echo
    printf '%s\n' "$list"
    echo
    echo "更新: $(date '+%Y-%m-%d %H:%M')"
    echo "$end"
  } > "$sec"
  del=0
else
  [ -f "$file" ] || exit 0
  : > "$sec"
  del=1
fi
[ -f "$file" ] || : > "$file"
awk -v s="$start" -v e="$end" -v secfile="$sec" -v del="$del" '
  BEGIN { while ((getline l < secfile) > 0) sec = sec l "\n" }
  skip { if ($0 == e) skip = 0; next }
  $0 == "" { if (pend) print ""; pend = 1; next }
  $0 == s {
    if (found) bad = 1
    found = 1
    skip = 1
    if (del) pend = 0
    else if (pend) { print ""; pend = 0 }
    printf "%s", sec
    next
  }
  { if (pend) { print ""; pend = 0 } print }
  END {
    if (pend) print ""
    if (!found && !del) { if (NR > 0) print ""; printf "%s", sec }
    if (skip || bad) exit 1
  }
' "$file" > "$tmp" || {
  echo "CLAUDE.local.md の proposal-reminder の印が壊れています（変えていません）" >&2
  exit 1
}
mv "$tmp" "$file"
