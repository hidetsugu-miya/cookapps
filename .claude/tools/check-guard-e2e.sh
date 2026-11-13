#!/usr/bin/env bash
# guard-e2e.sh の自己確認: PreToolUse の入力を流し、止める（exit 2）・通す（exit 0）を確かめる。
# 検出語は guard-e2e.sh 自身と同じく、このファイルが検査に掛からないよう分けて書いている。
set -uo pipefail
# Check the guard-e2e.sh of this script's own checkout, so that a branch's change to it is tested before the merge (pre-git.sh runs this on a push that touches it)
guard="$(cd "$(dirname "$0")/../hooks" && pwd)/guard-e2e.sh"
T="window.__TAU""RI__"
fail=0
# The hook writes its run to logs/ (hook-log.sh); a test run writes to a temporary directory instead.
COOKAPPS_HOOK_LOG_DIR=$(mktemp -d) || exit 2
export COOKAPPS_HOOK_LOG_DIR
trap 'rm -rf "$COOKAPPS_HOOK_LOG_DIR"' EXIT

# check <期待する終了コード> <名前> <tool_name> <tool_input の JSON>
check() {
  local want=$1 name=$2 got
  jq -n --arg t "$3" --argjson i "$4" '{tool_name: $t, tool_input: $i}' | "$guard" >/dev/null 2>&1
  got=$?
  [ "$got" -eq "$want" ] && echo "ok   $name" || { echo "FAIL $name (期待 ${want}、結果 ${got})"; fail=1; }
}
# check_log <期待するログの増え方（行数）> <名前> <tool_name> <tool_input の JSON>: 流した入力が logs/ に何行足すか（関係のない入力は 0 行、関係のある入力は 1 行）
check_log() {
  local want=$1 name=$2 before after
  before=$(cat "$COOKAPPS_HOOK_LOG_DIR"/hooks-*.log 2>/dev/null | wc -l)
  jq -n --arg t "$3" --argjson i "$4" '{tool_name: $t, tool_input: $i}' | "$guard" >/dev/null 2>&1
  after=$(cat "$COOKAPPS_HOOK_LOG_DIR"/hooks-*.log 2>/dev/null | wc -l)
  [ $((after - before)) -eq "$want" ] && echo "ok   $name" || { echo "FAIL $name (期待 ${want} 行、結果 $((after - before)) 行)"; fail=1; }
}
bash_in() { jq -n --arg c "$1" '{command: $c}'; }
file_in() { jq -n --arg p "$1" --arg c "$2" '{file_path: $p, content: $c, new_string: $c}'; }

# 止める
check 2 "記録に Write" Write "$(file_in /repo/.claude/e2e/abc 'x')"
check 2 "記録にリダイレクト" Bash "$(bash_in 'echo {} > .claude/e2e/abc')"
check 2 "記録を rm" Bash "$(bash_in 'rm -f /repo/.claude/e2e/abc')"
check 2 "記録へ cp" Bash "$(bash_in 'cp /tmp/x .claude/e2e/abc')"
check 2 "run-e2e.sh と連結した記録の書き込み" Bash "$(bash_in '.claude/tools/run-e2e.sh; echo {} > .claude/e2e/abc')"
check 2 "CI の記録に Write" Write "$(file_in /repo/.claude/ci/abc 'x')"
check 2 "CI の記録にリダイレクト" Bash "$(bash_in 'echo {} > .claude/ci/abc')"
check 2 "CI の記録を rm" Bash "$(bash_in 'rm -f /repo/.claude/ci/abc')"
check 2 "E2E の記録を run-ci.sh で書く" Bash "$(bash_in '.claude/tools/run-ci.sh && echo {} > .claude/e2e/abc')"
check 2 "CI の記録を run-e2e.sh で書く" Bash "$(bash_in '.claude/tools/run-e2e.sh && echo {} > .claude/ci/abc')"
check 2 "src/ に差し替え" Edit "$(file_in /repo/src/main.js "$T = { core: {} };")"
check 2 "src/ に __e2e" Write "$(file_in /repo/src/x.js 'window.__e2e_mocks__ = {};')"
check 2 "src/ に @wdio" Write "$(file_in /repo/src/x.js 'import "@wdio/globals";')"
check 2 "ts/ に差し替え" Edit "$(file_in /repo/ts/ipc.ts "$T = { core: {} };")"
check 2 "ts/ に __e2e" Write "$(file_in /repo/ts/x.ts 'window.__e2e_mocks__ = {};')"
check 2 "ts/bindings に @wdio" Write "$(file_in /repo/ts/bindings/X.ts 'import "@wdio/globals";')"
check 2 "scratchpad にモックを Write" Write "$(file_in /tmp/claude/mock.js "$T.core = { invoke() {} };")"
check 2 "/tmp にモックを heredoc" Bash "$(bash_in "cat > /tmp/mock.js <<'EOF'"$'\n'"$T = {};"$'\nEOF')"

# 通す
check 0 "記録を cat" Bash "$(bash_in 'cat .claude/e2e/abc')"
check 0 "記録を jq で読む" Bash "$(bash_in 'jq .passed /repo/.claude/e2e/abc')"
check 0 "run-e2e.sh を単独で呼ぶ" Bash "$(bash_in '.claude/tools/run-e2e.sh .claude/worktrees/x')"
check 0 "CI の記録を cat" Bash "$(bash_in 'cat .claude/ci/abc')"
check 0 "CI の記録を jq で読む" Bash "$(bash_in 'jq .passed /repo/.claude/ci/abc')"
check 0 "run-ci.sh を単独で呼ぶ" Bash "$(bash_in '.claude/tools/run-ci.sh .claude/worktrees/x')"
check 0 "e2e/ にモックを Write" Write "$(file_in /repo/e2e/fixtures.js "$T.core = { invoke() {} };")"
check 0 "worktree の e2e/ にモックを Write" Edit "$(file_in /repo/.claude/worktrees/w/e2e/fixtures.js "$T.core = {};")"
check 0 "ts/ の読むだけの Edit" Edit "$(file_in /repo/ts/ipc.ts "const { invoke } = $T.core;")"
check 0 "src-tauri/src/ の Rust" Write "$(file_in /repo/src-tauri/src/lib.rs 'let e2e = "__e2e";')"
check 0 "無関係な Bash" Bash "$(bash_in 'git status')"

# 関係のない入力は、止めもせず、ログも書かない。関係のある入力は、通しても止めても 1 行書く
check 0 "無関係な Edit" Edit "$(file_in /repo/README.md 'hello')"
check_log 0 "無関係な Bash はログを書かない" Bash "$(bash_in 'git status')"
check_log 0 "無関係な Edit はログを書かない" Edit "$(file_in /repo/README.md 'hello')"
check_log 0 "対象の語を含まない Write はログを書かない" Write "$(file_in /repo/src-tauri/src/lib.rs 'let a = 1;')"
check_log 1 "E2E の記録を読む Bash はログを書く" Bash "$(bash_in 'cat .claude/e2e/abc')"
check_log 1 "CI の記録を読む Bash はログを書く" Bash "$(bash_in 'cat .claude/ci/abc')"
check_log 1 "止める入力もログを書く" Bash "$(bash_in 'echo {} > .claude/e2e/abc')"
check_log 1 "差し替えの語を含む入力はログを書く" Write "$(file_in /repo/e2e/fixtures.js "$T.core = {};")"
check_log 1 "@wdio の語を含む入力はログを書く" Write "$(file_in /repo/e2e/x.ts 'import "@wdio/globals";')"
check_log 1 "JSON のエスケープを含む入力は検査まで進む" Bash "$(bash_in $'echo a\x01b')"
exit $fail
