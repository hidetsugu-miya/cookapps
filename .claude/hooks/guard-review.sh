#!/usr/bin/env bash
# PreToolUse: 合格記録（.claude/reviews/ と record-review.sh）に直接触れられるのは release-verifier だけにする。GitHub の commit status を直接書くコマンドも止める（送るのは記録を読む post-checks.sh だけ）。
# 例外: 合格のあとに止めない指摘を直した差分の範囲確認は .claude/tools/range-check.sh が行い、通れば自分で record-review.sh を呼んで記録を書く（#932）。
# そのコマンドの文は record-review も .claude/reviews も含まないのでここで止まらない。主エージェントが record-review.sh を呼ぶことや .claude/reviews/ に書くことは止まる。
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/hook-log.sh"
input=$(cat)
jq -r '.tool_input.command // .tool_input.file_path // .tool_input.notebook_path // empty' <<< "$input" | grep -q -E 'record-review|\.claude/reviews|/statuses/' || exit 0
hook_log_begin
case "$(jq -r '.agent_type // empty' <<< "$input")" in release-verifier) exit 0 ;; esac
echo "合格記録は release-verifier と range-check.sh だけが書けます。.claude/rules/review.md の手順でレビューを受けてください" >&2
exit 2
