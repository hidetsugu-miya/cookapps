#!/usr/bin/env bash
# 静的検査と unit（版の一致、tsc の ts と e2e、Biome、cargo fmt、clippy、cargo test、bindings の差分）を回し、結果を main の checkout の .claude/ci/{HEAD の SHA} に JSON で書く（.claude/rules/review.md、check-ci.sh が読む。pre-git.sh、post-checks.sh と release-verifier は check-ci.sh を呼ぶ）。
# 各検査の出力は .claude/ci/{HEAD の SHA}.log に残す（同じ HEAD で再実行すると上書き）。検査は最初の失敗で止まる。
# 使い方: run-ci.sh [checkout のパス]（省略時はカレント）。終了コードは検査の結果。
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

mkdir -p "$main/.claude/ci" || exit 2
log="$main/.claude/ci/$sha.log"
gates="$main/.claude/ci/$sha.$$.gates"
: >"$log" && : >"$gates" || exit 2
trap 'rm -f "$gates"' EXIT

# node_modules は追跡されないので、後から git worktree add した worktree には無い。無ければ npm ci する。
if [ ! -d node_modules ]; then
  echo "=== npm ci" >>"$log"
  mise exec -- npm ci >>"$log" 2>&1 || { tail -n 40 "$log" >&2; exit 2; }
fi

failed=""
# gate <名前> <コマンド...>: 最初の失敗以降は走らせない。名前、秒数、合否を $gates に 1 行の JSON で足す。
gate() {
  local name=$1 start=$SECONDS rc; shift
  [ -z "$failed" ] || return 0
  echo "=== $name" >>"$log"
  "$@" >>"$log" 2>&1
  rc=$?
  jq -nc --arg name "$name" --argjson seconds $((SECONDS - start)) --argjson passed "$([ "$rc" -eq 0 ] && echo true || echo false)" \
    '{name: $name, seconds: $seconds, passed: $passed}' >>"$gates"
  [ "$rc" -eq 0 ] || failed=$name
}

gate "ソースの版が固定値" scripts/check-version.sh
gate "tsc (ts)" mise exec -- npm run build:ts
gate "tsc (e2e)" mise exec -- npm run e2e:check
gate "Biome lint" mise exec -- npm run lint
gate "cargo fmt --check" bash -c 'cd src-tauri && mise exec -- cargo fmt --check'
# 検査は 1 回しか走らないので、差分ビルド用のデータは要らない（CARGO_INCREMENTAL=0）。
gate "cargo clippy" bash -c 'cd src-tauri && CARGO_INCREMENTAL=0 mise exec -- cargo clippy --all-targets --all-features -- -D warnings'
gate "cargo test --all-features" bash -c 'cd src-tauri && CARGO_INCREMENTAL=0 mise exec -- cargo test --all-features'
# cargo test は Rust の構造体の型（ts/bindings/）を書く。コミットと違うものは古い。
gate "bindings の差分" bash -c 'out=$(git status --porcelain -- ts/bindings) && [ -z "$out" ] || { echo "$out"; exit 1; }'

clean=true
{ dirty || [ "$(git rev-parse HEAD)" != "$sha" ]; } && clean=false
passed=false
[ -z "$failed" ] && passed=true

jq -n --arg sha "$sha" --arg version "$version" --argjson clean "$clean" --argjson passed "$passed" \
  --arg failed "$failed" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --slurpfile gates "$gates" \
  '{sha: $sha, version: $version, clean: $clean, passed: $passed, failed_gate: (if $failed == "" then null else $failed end), gates: $gates, finished_at: $at}' \
  > "$main/.claude/ci/$sha.$$.tmp" && mv "$main/.claude/ci/$sha.$$.tmp" "$main/.claude/ci/$sha" || exit 2

[ -n "$failed" ] && { echo "ゲート失敗: $failed" >&2; tail -n 40 "$log" >&2; }
$clean || echo "警告: 実行中に作業ツリーが汚れたか HEAD が動きました（clean:false で記録）" >&2
echo "CI: ${sha:0:7} v$version passed=$passed clean=$clean"
echo "ログ: $log"
[ -z "$failed" ]
