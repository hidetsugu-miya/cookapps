#!/usr/bin/env bash
# 使い方: release-only-diff.sh A B
# A..B の差分がリリース作業だけ（README、CHANGELOG、docs）なら exit 0。そうでなければ、外れたパスを標準エラーに出して exit 1。
# pre-git.sh と post-checks.sh が、記録のあるコミット（または範囲の基点、origin/main）から HEAD までがリリース作業だけかを確かめるのに使う（.claude/rules/review.md）。check-release-e2e.sh も、E2E の記録のあるコミットから HEAD までに使う。
# リリース作業だけなら、HEAD にレビューの合格記録も CI（run-ci.sh）の記録も求めない（#931）。release/next の E2E の記録は、基点への退避をせず、記録のあるコミットからだけこの確認で通る（#1023）。
# カレントのリポジトリで動く。
set -uo pipefail
[ $# -eq 2 ] || { echo "使い方: release-only-diff.sh A B" >&2; exit 2; }
a=$1
b=$2

bad=()
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    README.md | CHANGELOG.md | docs/*) ;;
    *) bad+=("$path") ;;
  esac
done < <(git diff --name-only --no-renames "$a" "$b")

[ ${#bad[@]} -eq 0 ] && exit 0
printf '%s\n' "${bad[@]}" >&2
exit 1
