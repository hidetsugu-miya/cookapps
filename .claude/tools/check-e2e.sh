#!/usr/bin/env bash
# このチェックアウトの HEAD に、合格した E2E の記録があるかを確かめる（pre-git.sh と release-verifier が使う）。
# 記録は run-e2e.sh が main の checkout に書く。どのチェックアウトから呼んでもよく、呼んだ場所の HEAD を見る。
# 合格なら「{短い SHA} {version} {通過数}/{総数} 件 通過」を出して exit 0。そうでなければ理由を標準エラーに出して exit 1。
set -uo pipefail
main="$(git rev-parse --path-format=absolute --git-common-dir)/.." || exit 2
sha=$(git rev-parse HEAD) || exit 2
short=$(git rev-parse --short HEAD)
# Cargo.toml の [package] の version 行だけを読む（依存の version は読まない）。
version=$(git show HEAD:src-tauri/Cargo.toml | awk '/^\[/{p=($0=="[package]")} p && /^version[ \t]*=/{gsub(/^version[ \t]*=[ \t]*"|".*$/, ""); print; exit}')
rec="$main/.claude/e2e/$sha"

fail() {
  echo "HEAD $short の E2E の記録が無いか、不合格です。.claude/tools/run-e2e.sh で E2E を回してください" >&2
  echo "理由: $1" >&2
  exit 1
}

[ -f "$rec" ] || fail "記録がありません"
if ! jq -e --arg sha "$sha" --arg v "$version" \
  '.sha == $sha and .clean == true and .passed == true and .version == $v' "$rec" >/dev/null 2>&1; then
  fail "$(jq -c '{sha: .sha[0:7], version, clean, passed}' "$rec" 2>/dev/null || echo '記録を読めません') （期待する version は $version）"
fi
jq -r --arg short "$short" '"\($short) \(.version) \(.tests.passed)/\(.tests.total) 件 通過"' "$rec"
