#!/usr/bin/env bash
# 使い方: release-only-diff.sh A B
# A..B の差分がリリース作業だけ（README、CHANGELOG、docs）なら exit 0。そうでなければ、外れたパスを標準エラーに出して exit 1。
# pre-git.sh が、合格記録のあるコミットから HEAD までがリリース作業だけかを確かめるのに使う（.claude/rules/review.md）。
# 免除するのはレビューの合格記録だけ。CI（run-ci.sh）と E2E の記録は、どの HEAD にも要るので Release PR の HEAD にも要る。
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
