#!/usr/bin/env bash
# PreToolUse: E2E の記録（.claude/e2e/）を run-e2e.sh 以外が、CI の記録（.claude/ci/）を run-ci.sh 以外が書くのと、E2E（e2e/）の外にモックを作るのを止める。
# 検出語は、このファイル自身が検査に掛からないよう、わざと分けて書いている。
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/hook-log.sh"
input=$(cat)
tauri='__TAURI'
# 生の入力を grep 1 回で絞る: 下の検査が見る語（記録の場所 .claude/e2e と .claude/ci、Tauri、__e2e、@wdio、モックの語）のどれも無い呼び出しは、jq も起こさず、ログも書かずに通す。
# 最後の \u と \/ は、JSON のエスケープで語が隠れた入力を絞りから漏らさないため（その入力は下の検査まで進む）。語の中の文字で JSON が逃がせるのは、\uXXXX（どの文字も）と \/（記録の場所の / だけ）の 2 つである。
grep -q -E "\\.claude/(e2e|ci)|${tauri}|__e2e|@wdio|mock[I]PC|\\\\[u/]" <<< "$input" || exit 0
hook_log_begin
path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<< "$input")
cmd=$(jq -r '.tool_input.command // empty' <<< "$input")
# 書き込む中身: Bash のコマンド、Write の content、Edit・MultiEdit の new_string、NotebookEdit の new_source。
text=$(jq -r '[.tool_input.command, .tool_input.content, .tool_input.new_string, .tool_input.new_source, (.tool_input.edits[]?.new_string)] | map(select(. != null)) | join("\n")' <<< "$input")

tauri_g="${tauri}(_INTERNALS)?__"
# window の Tauri を差し替える・モックする書き方。読むだけの `const { invoke } = window.<tauri>.core` は含めない。
replace="${tauri_g}(\\.[A-Za-z_.]+)?[[:space:]]*(\\?\\?|\\|\\||&&)?=[^=]|(defineProperty|assign)\\([^)]*${tauri}|mock[I]PC"
write_cmd='>|tee |[[:space:]](cp|mv|install)[[:space:]]|writeFile|write_text|open\('

block() { echo "$1" >&2; exit 2; }
mock_msg="画面の確認は E2E（e2e/）で行います。モックは e2e/fixtures.js と e2e/support.ts に置き、使い捨てのモックは作りません"

# 1. E2E の記録（.claude/e2e/）と CI の記録（.claude/ci/）: それぞれ run-e2e.sh、run-ci.sh を単独で呼ぶコマンド以外は書けない。
chain='[;&|<>`$]'
for pair in "e2e:run-e2e" "ci:run-ci"; do
  kind=${pair%%:*}
  rec_msg="記録(.claude/$kind/)は .claude/tools/${pair#*:}.sh だけが書けます（単独のコマンドとして呼んでください）"
  case "$path" in */.claude/$kind|*/.claude/$kind/*) block "$rec_msg" ;; esac
  rec_path="\\.claude/$kind"'([/[:space:]"'"'"']|$)'
  run_alone="${pair#*:}\\.sh"
  if [[ $cmd =~ $rec_path ]] && ! { [[ $cmd =~ $run_alone ]] && ! [[ $cmd =~ $chain ]]; }; then
    redirect="(>|tee[[:space:]]+(-a[[:space:]]+)?)[[:space:]]*[^[:space:]]*\\.claude/$kind"
    verbs="(^|[^[:alnum:]_-])(rm|mv|cp|touch|mkdir|ln|truncate|install|dd|rsync|chmod|sed[[:space:]]+-i|perl[[:space:]]+-pi)([[:space:]]|\$)[^;&|]*\\.claude/$kind"
    grep -q -E "$redirect|$verbs" <<< "$cmd" && block "$rec_msg"
  fi
done

# 2. src/ の下（src-tauri/ は除く）と ts/ の下（bindings を含む）には、モックも @wdio も書かない。
if [[ ( $path == */src/* && $path != */src-tauri/* ) || $path == */ts/* ]]; then
  grep -q -E "${replace}|__e2e|@wdio" <<< "$text" && block "src/ と ts/ に E2E のモックや @wdio は書けません。$mock_msg"
fi

# 3. e2e/ の外にも、window の Tauri を差し替えるファイルは書かない（/tmp や scratchpad の使い捨てを含む）。
if ! [[ $path == e2e/* || $path == */e2e/* ]] && grep -q -E "$replace" <<< "$text"; then
  if [ -n "$path" ]; then
    block "e2e/ の外に window の Tauri を差し替えるファイルは書けません。$mock_msg"
  elif [[ $cmd != *e2e/* ]] && grep -q -E "$write_cmd" <<< "$cmd"; then
    block "e2e/ の外に window の Tauri を差し替えるファイルは書けません。$mock_msg"
  fi
fi
exit 0
