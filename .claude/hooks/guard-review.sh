#!/usr/bin/env bash
# PreToolUse: 合格記録（.claude/reviews/ と record-review.sh）に触れられるのは release-verifier だけにする。GitHub の commit status を直接書くコマンドも止める（送るのは記録を読む post-checks.sh だけ）。
set -uo pipefail
input=$(cat)
jq -r '.tool_input.command // .tool_input.file_path // .tool_input.notebook_path // empty' <<< "$input" | grep -q -E 'record-review|\.claude/reviews|/statuses/' || exit 0
case "$(jq -r '.agent_type // empty' <<< "$input")" in release-verifier) exit 0 ;; esac
echo "合格記録は release-verifier だけが書けます。.claude/rules/review.md の手順でレビューを受けてください" >&2
exit 2
