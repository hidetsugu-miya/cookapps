#!/usr/bin/env bash
# このチェックアウトの HEAD に、合格した CI（静的検査と unit）の記録があるかを確かめる（pre-git.sh、post-checks.sh と release-verifier が使う）。
# 記録は run-ci.sh が main の checkout に書く。どのチェックアウトから呼んでもよく、呼んだ場所の HEAD を見る。
# 合格なら「{短い SHA} {version} CI 通過」を出して exit 0。そうでなければ理由を標準エラーに出して exit 1。
set -uo pipefail
main="$(git rev-parse --path-format=absolute --git-common-dir)/.." || exit 2
sha=$(git rev-parse HEAD) || exit 2
short=$(git rev-parse --short HEAD)
# Cargo.toml の [package] の version 行だけを読む（依存の version は読まない）。
version=$(git show HEAD:src-tauri/Cargo.toml | awk '/^\[/{p=($0=="[package]")} p && /^version[ \t]*=/{gsub(/^version[ \t]*=[ \t]*"|".*$/, ""); print; exit}')
rec="$main/.claude/ci/$sha"

fail() {
  echo "HEAD $short の CI の記録が無いか、不合格です。.claude/tools/run-ci.sh で静的検査と unit を回してください" >&2
  echo "理由: $1" >&2
  exit 1
}

[ -f "$rec" ] || fail "記録がありません"
if ! jq -e --arg sha "$sha" --arg v "$version" \
  '.sha == $sha and .clean == true and .passed == true and .version == $v' "$rec" >/dev/null 2>&1; then
  fail "$(jq -c '{sha: .sha[0:7], version, clean, passed, failed_gate}' "$rec" 2>/dev/null || echo '記録を読めません') （期待する version は ${version}）"
fi
echo "$short $version CI 通過"
