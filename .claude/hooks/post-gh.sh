#!/usr/bin/env bash
# PostToolUse(Bash): issue の作成のあとは issue-plan の手順 1〜4 の続行を、gh pr merge のあとは plan-release.py release の結果と Release PR の用意とマージ、リリースの見届けの続行を、セッションに伝える。常に exit 0。
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/hook-log.sh"
cmd=$(jq -r '.tool_input.command // empty')
[ -n "$cmd" ] || exit 0

# 引用符の中身を除き、gh が行頭か ; & | ( の後に来るときだけ、実行したコマンドとみなす。
bare=$(perl -0777 -pe 's/"(?:\\.|[^"\\])*"/""/gs; s/\x27[^\x27]*\x27/\x27\x27/gs' <<< "$cmd")
ran() { grep -q -E "(^|[;&|(])[[:space:]]*gh[[:space:]]+$1([[:space:]]|\$)" <<< "$bare"; }

plan=0
ran 'issue[[:space:]]+create' && plan=1
merge=0
ran 'pr[[:space:]]+merge' && merge=1
[ "$plan" -eq 1 ] || [ "$merge" -eq 1 ] || exit 0
hook_log_begin

msgs=()
if [ "$plan" -eq 1 ]; then
  msgs+=("issue を作成しました。issue-plan スキルの手順 1〜4（作者の確認、書く・ラベル、分割、報告）を続けてください（まだ始めていなければ、ここから始めてください）。issue の並べ替えはしません。取りかかる issue はオーナーが implement で指定します。")
fi
if [ "$merge" -eq 1 ]; then
  main="$(git -C "${CLAUDE_PROJECT_DIR:?}" rev-parse --path-format=absolute --git-common-dir)/.."
  out=$("$main/.claude/tools/plan-release.py" release 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    msgs+=("gh pr merge のあとに plan-release.py release を実行しました:"$'\n'"$out")
    msgs+=("Release PR のマージはタグ打ちとリリースを release.yml が自分で行います。follow_up があれば、release の run を見届けて issue にコメントするのが先です。tag_due があれば、run を見てから、run が無いときだけ手でタグを打ちます（release スキル（.claude/skills/release/SKILL.md）の手順 B）。リリースを待つ変更があれば、このセッションが Release PR を用意し、チェックを送ったらそのままマージして、リリースを見届けます（release スキルの手順 A と B。なければ作り、あれば本文を更新します。オーナーのマージは待ちません）。マージが拒まれたとき、release の run がランナーやネットワーク以外の原因で失敗したときは、オーナーに理由を伝えます。")
  else
    msgs+=("gh pr merge のあとに plan-release.py release を実行しましたが、失敗しました（exit ${rc}）:"$'\n'"$out")
  fi
fi

[ "${#msgs[@]}" -gt 0 ] || exit 0
ctx=$(printf '%s\n' "${msgs[@]}")
jq -n --arg c "$ctx" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $c}}'
exit 0
