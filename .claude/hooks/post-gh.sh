#!/usr/bin/env bash
# PostToolUse(Bash): issue の作成と needs:owner の解消のあとは issue-plan の続行を、gh pr merge のあとは plan-release.py sync の結果とリリースの判定の続行を、セッションに伝える。常に exit 0。
set -uo pipefail
cmd=$(jq -r '.tool_input.command // empty')
[ -n "$cmd" ] || exit 0

# 引用符の中身を除き、gh が行頭か ; & | ( の後に来るときだけ、実行したコマンドとみなす。
bare=$(perl -0777 -pe 's/"(?:\\.|[^"\\])*"/""/gs; s/\x27[^\x27]*\x27/\x27\x27/gs' <<< "$cmd")
ran() { grep -q -E "(^|[;&|(])[[:space:]]*gh[[:space:]]+$1([[:space:]]|\$)" <<< "$bare"; }

msgs=()
if ran 'issue[[:space:]]+create' \
  || { ran 'issue[[:space:]]+edit' && grep -q -E -e '--remove-label[ =][^|;&]*needs:owner' <<< "$cmd"; }; then
  msgs+=("issue を作成した、または needs:owner を外しました。issue-plan スキルの手順を続けてください（まだ始めていなければ、ここから始めてください）。")
fi
if ran 'pr[[:space:]]+merge'; then
  main="$(git -C "${CLAUDE_PROJECT_DIR:?}" rev-parse --path-format=absolute --git-common-dir)/.."
  out=$("$main/.claude/tools/plan-release.py" sync 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    msgs+=("gh pr merge のあとに plan-release.py sync を実行しました。issue ごとの予定 tag:"$'\n'"$out")
    msgs+=("次はリリースの判定です。plan-release.py release-facts を実行し、rule が R4 なら release-planner を mode: release で起動して、結果を Release PR の本文に書いてください（issues.md の R0 から R4）。")
  else
    msgs+=("gh pr merge のあとに plan-release.py sync を実行しましたが、失敗しました（exit ${rc}）:"$'\n'"$out")
  fi
fi

[ "${#msgs[@]}" -gt 0 ] || exit 0
ctx=$(printf '%s\n' "${msgs[@]}")
jq -n --arg c "$ctx" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $c}}'
exit 0
