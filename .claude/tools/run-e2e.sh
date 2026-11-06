#!/usr/bin/env bash
# E2E を回し、結果を main の checkout の .claude/e2e/{HEAD の SHA} に JSON で書く（.claude/rules/review.md、check-e2e.sh が読む。pre-git.sh と release-verifier は check-e2e.sh を呼ぶ）。
# ビルドと E2E の出力は .claude/e2e/{HEAD の SHA}.log に残す（同じ HEAD で再実行すると上書き）。後から回数や失敗を検証するため。
# 使い方: run-e2e.sh [checkout のパス]（省略時はカレント）。終了コードは E2E の結果。
# 作業ツリーが汚れていれば、記録を書かずに exit 2 で止まる（記録は HEAD のコミットの中身についてだけ言うため）。
# node_modules が無ければ、先に npm ci する（ログに入る）。
set -uo pipefail
cd "${1:-.}" || exit 2
root=$(git rev-parse --show-toplevel) && cd "$root" || exit 2
main="$(git rev-parse --path-format=absolute --git-common-dir)/.."
dirty() { [ -n "$(git status --porcelain)" ]; }

dirty && { echo "作業ツリーが汚れています。コミットしてから実行してください（記録は書きません）" >&2; git status --short >&2; exit 2; }
sha=$(git rev-parse HEAD)
version=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -n 1)

mkdir -p "$main/.claude/e2e" || exit 2
log="$main/.claude/e2e/$sha.log"
# node_modules は追跡されないので、後から git worktree add した worktree には無い。無ければ npm ci する。
{ [ -d node_modules ] || mise exec -- npm ci; } >"$log" 2>&1 \
  && mise exec -- npm run e2e:build >>"$log" 2>&1 && mise exec -- npm run e2e >>"$log" 2>&1
code=$?

clean=true
{ dirty || [ "$(git rev-parse HEAD)" != "$sha" ]; } && clean=false
# wdio の spec reporter が spec ファイルごとに出す「N passing」「M failing」を合計する。
text=$(sed $'s/\033\\[[0-9;]*m//g' "$log")
sum() { grep -o -E "[0-9]+ $1" <<< "$text" | awk '{n += $1} END {print n + 0}'; }
passed_n=$(sum passing)
total_n=$((passed_n + $(sum failing)))
# WebDriver のコマンドの結果が返らなかった回数。テストが通っても、再試行で隠れる。
timeouts=$(grep -c 'Script execution timed out' <<< "$text")
passed=false
[ "$code" -eq 0 ] && passed=true

jq -n --arg sha "$sha" --arg version "$version" --argjson clean "$clean" --argjson passed "$passed" \
  --argjson ok "$passed_n" --argjson total "$total_n" --argjson timeouts "$timeouts" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{sha: $sha, version: $version, clean: $clean, passed: $passed, tests: {passed: $ok, total: $total}, script_timeouts: $timeouts, finished_at: $at}' \
  > "$main/.claude/e2e/$sha.$$.tmp" && mv "$main/.claude/e2e/$sha.$$.tmp" "$main/.claude/e2e/$sha" || exit 2

[ "$code" -ne 0 ] && tail -n 40 "$log" >&2
$clean || echo "警告: 実行中に作業ツリーが汚れたか HEAD が動きました（clean:false で記録）" >&2
echo "E2E: ${sha:0:7} v$version $passed_n/$total_n passed=$passed clean=$clean script_timeouts=$timeouts"
echo "ログ: $log"
exit "$code"
