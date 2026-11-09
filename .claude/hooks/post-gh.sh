#!/usr/bin/env bash
# PostToolUse(Bash): issue の作成と needs:owner の解消のあとは issue-plan の続行を、gh pr merge のあとは plan-release.py release の結果と Release PR の用意の続行を、セッションに伝える。常に exit 0。
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
  out=$("$main/.claude/tools/plan-release.py" release 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    msgs+=("gh pr merge のあとに plan-release.py release を実行しました:"$'\n'"$out")
    msgs+=("tag_due があれば、タグを打つのが先です（issues.md の Release の手順 3）。リリースを待つ変更があれば、Release PR を用意します（なければ作り、あれば本文を更新します。マージするのはオーナーです）。")
  else
    msgs+=("gh pr merge のあとに plan-release.py release を実行しましたが、失敗しました（exit ${rc}）:"$'\n'"$out")
  fi
fi

[ "${#msgs[@]}" -gt 0 ] || exit 0
ctx=$(printf '%s\n' "${msgs[@]}")
jq -n --arg c "$ctx" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $c}}'
exit 0
