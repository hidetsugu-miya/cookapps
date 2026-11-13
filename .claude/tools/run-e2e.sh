#!/usr/bin/env bash
# E2E を回し、結果を main の checkout の .claude/e2e/{HEAD の SHA} に JSON で書く（.claude/rules/review.md、check-e2e.sh が読む。pre-git.sh と release-verifier は check-e2e.sh を呼ぶ）。
# ビルドと E2E の出力は .claude/e2e/{HEAD の SHA}.log に残す（同じ HEAD で再実行すると上書き）。後から回数や失敗を検証するため。
# e2e:build が終わったら、HEAD に合格した CI の記録（check-ci.sh）が無いときだけ、wdio の実行と同時に run-ci.sh を回す（記録は run-ci.sh が今までどおり書く。#420）。
#   cargo が target/debug のロックを取るのは e2e:build までで、wdio は cargo を回さないので、取り合わない。CI の失敗でも終了コードは 0 にならない（E2E の記録の passed は E2E だけの結果）。
# 使い方: run-e2e.sh [checkout のパス]（省略時はカレント）。終了コードは E2E の結果、E2E が通ったときは同時に回した CI の結果。
#        run-e2e.sh --only {spec の名前} [checkout のパス]  e2e/specs/{名前}.e2e.ts を 1 つのアプリだけで流す。落ちた spec を直るまで回すための入口（.claude/rules/e2e.md）。
#          記録は書かず（作業ツリーが汚れていてもよい）、出力は only-{名前}.log に残す。記録の代わりにはならないので、通ったら引数なしで 1 回回す。
# 作業ツリーが汚れていれば、記録を書かずに exit 2 で止まる（記録は HEAD のコミットの中身についてだけ言うため）。
# node_modules が無ければ、先に npm ci する（ログに入る）。
set -uo pipefail
only=""
if [ "${1:-}" = "--only" ]; then
  [ $# -ge 2 ] || { echo "使い方: run-e2e.sh --only {spec の名前} [checkout のパス]" >&2; exit 2; }
  only="$2"
  [[ $only =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "spec の名前は inbox のような名前で指定してください: $only" >&2; exit 2; }
  shift 2
fi
cd "${1:-.}" || exit 2
root=$(git rev-parse --show-toplevel) && cd "$root" || exit 2
main="$(git rev-parse --path-format=absolute --git-common-dir)/.."
here=$(cd "$(dirname "$0")" && pwd)
dirty() { [ -n "$(git status --porcelain)" ]; }

if [ -n "$only" ]; then
  [ -f "e2e/specs/$only.e2e.ts" ] || { echo "e2e/specs/$only.e2e.ts がありません" >&2; exit 2; }
  mkdir -p "$main/.claude/e2e" || exit 2
  log="$main/.claude/e2e/only-$only.log"
  { [ -d node_modules ] || mise exec -- npm ci; } >"$log" 2>&1 \
    && mise exec -- npm run e2e:build >>"$log" 2>&1 && E2E_ONLY="$only" mise exec -- npm run e2e >>"$log" 2>&1
  code=$?
  [ "$code" -ne 0 ] && tail -n 40 "$log" >&2
  echo "E2E(--only $only): exit=${code}（記録は書きません）"
  echo "ログ: $log"
  exit "$code"
fi

dirty && { echo "作業ツリーが汚れています。コミットしてから実行してください（記録は書きません）" >&2; git status --short >&2; exit 2; }
sha=$(git rev-parse HEAD)
version=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -n 1)

mkdir -p "$main/.claude/e2e" || exit 2
log="$main/.claude/e2e/$sha.log"
# node_modules は追跡されないので、後から git worktree add した worktree には無い。無ければ npm ci する。
{ [ -d node_modules ] || mise exec -- npm ci; } >"$log" 2>&1 \
  && mise exec -- npm run e2e:build >>"$log" 2>&1
code=$?
# e2e:build の後は、wdio がアプリを動かすだけで cargo を使わないので、CI（cargo clippy と cargo test）を同時に回せる。
ci_pid="" ci_code=0 ci_out=""
if [ "$code" -eq 0 ]; then
  if "$here/check-ci.sh" >/dev/null 2>&1; then
    echo "CI: HEAD ${sha:0:7} の合格した記録があるので、回しません"
  else
    ci_out=$(mktemp) || exit 2
    nice -n 10 "$here/run-ci.sh" "$root" >"$ci_out" 2>&1 &
    ci_pid=$!
  fi
  mise exec -- npm run e2e >>"$log" 2>&1
  code=$?
fi
if [ -n "$ci_pid" ]; then
  wait "$ci_pid"
  ci_code=$?
  cat "$ci_out"
  rm -f "$ci_out"
fi

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
[ "$code" -eq 0 ] && code=$ci_code
exit "$code"
