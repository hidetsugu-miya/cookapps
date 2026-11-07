#!/usr/bin/env bash
# PreToolUse(Bash): commit/tag は公開禁止語の検査、push はさらにレビューの合格記録と全検査を確かめる。
set -uo pipefail
root="${CLAUDE_PROJECT_DIR:?}"
cmd=$(jq -r '.tool_input.command // empty')
g='git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+'
grep -q -E "${g}(commit|tag|push)|git-commit-run[[:space:]]+commit" <<< "$cmd" || exit 0

guard="$(cd "$(dirname "$0")" && pwd)/guard-public.sh"
cd "$root" || exit 0

# gate <名前> <コマンド...>: 失敗したら名前と出力末尾 40 行を出して exit 2。
gate() {
  local name=$1 out; shift
  out=$("$@" 2>&1) || { echo "ゲート失敗: $name"$'\n'"$(tail -n 40 <<< "$out")" >&2; exit 2; }
}

grep -q -E "${g}(commit|tag)|git-commit-run[[:space:]]+commit" <<< "$cmd" \
  && gate "公開禁止語(コマンド文)" bash -c '"$0" text <<< "$1"' "$guard" "$cmd"
gate "公開禁止語(ツリー)" "$guard" tree

if grep -q -E "${g}push" <<< "$cmd"; then
  range='@{u}..HEAD'
  git rev-parse -q --verify '@{u}' >/dev/null 2>&1 || range='origin/main..HEAD'
  git rev-parse -q --verify "${range%..*}" >/dev/null 2>&1 \
    && gate "公開禁止語(コミットメッセージ $range)" "$guard" log "$range"
  # The gates below check the working tree, so it must equal the commits being pushed.
  git diff --quiet HEAD || { echo "push 前の検査: コミットしていない変更があります。検査はコミットの中身と一致しません" >&2; git diff --stat HEAD >&2; exit 2; }
  # New commits need run-e2e.sh's passing record for HEAD and release-verifier's pass record (.claude/rules/review.md).
  # The pass record may be on an earlier commit of the range when only the release work (version, README, docs) comes after it.
  if ! git rev-parse -q --verify "${range%..*}" >/dev/null 2>&1 || [ -n "$(git rev-list -n 1 "$range")" ]; then
    main="$(git rev-parse --path-format=absolute --git-common-dir)/.."
    gate "E2E" "$main/.claude/tools/check-e2e.sh"
    if [ ! -f "$main/.claude/reviews/$(git rev-parse HEAD)" ]; then
      base=""
      for c in $(git rev-list "$range" 2>/dev/null); do
        [ -f "$main/.claude/reviews/$c" ] && { base=$c; break; }
      done
      # The range base is already on the remote, so it passed this gate: release work on top of it (a Release PR) needs no record of its own.
      [ -n "$base" ] || base="${range%..*}"
      offending=""
      if [ -n "$base" ]; then
        offending=$("$main/.claude/tools/release-only-diff.sh" "$base" HEAD 2>&1) && offending="ok"
      fi
      if [ "$offending" != ok ]; then
        msg="ゲート失敗: レビュー"$'\n'"HEAD $(git rev-parse --short HEAD) の合格記録がありません。.claude/rules/review.md の手順で $range をレビューしてください"
        [ -n "$offending" ] && msg+=$'\n'"${base:0:7} から HEAD までに、リリース作業の外の変更があります:"$'\n'"$offending"
        echo "$msg" >&2
        exit 2
      fi
    fi
  fi
  gate "バージョン一致" scripts/check-version.sh
  gate "tsc (ts)" npm run build:ts
  gate "tsc (e2e)" npm run e2e:check
  gate "Biome lint" npm run lint
  cd src-tauri || exit 0
  gate "cargo fmt --check" mise exec -- cargo fmt --check
  gate "cargo clippy" mise exec -- cargo clippy --all-targets --all-features -- -D warnings
  gate "cargo test --all-features" mise exec -- cargo test --all-features
  # cargo test writes the types of the Rust structs (ts/bindings/); a copy that differs from the commit is out of date.
  gate "bindings の差分" bash -c 'out=$(git status --porcelain ../ts/bindings) && [ -z "$out" ] || { echo "$out"; exit 1; }'
fi
exit 0
