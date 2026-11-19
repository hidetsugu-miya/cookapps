#!/usr/bin/env bash
# Release PR（release/next）の E2E の条件を確かめる（pre-git.sh と post-checks.sh が使う。.claude/rules/e2e.md、#1023）。
# E2E は機能の PR では回さず、Release PR の準備のときに run-e2e.sh を 1 回回す。その記録を、release/next の push とマージの条件にする。
# 次のどちらかなら通す: (1) HEAD に合格した E2E の記録がある（check-e2e.sh）、(2) origin/main..HEAD の中で合格した E2E の記録（sha 一致、clean、passed）を持つ最新のコミットから HEAD までが、リリース作業だけ（release-only-diff.sh）。
# 範囲の基点（origin/main）への退避はしない。origin/main は E2E を通っていないため。
# 記録は run-e2e.sh が main の checkout に書く。どのチェックアウトから呼んでもよく、呼んだ場所の HEAD を見る。呼ぶ側が先に origin/main を最新にしておく。
# 通れば理由を 1 行出して exit 0。そうでなければ理由を標準エラーに出して exit 1。
set -uo pipefail
tools="$(cd "$(dirname "$0")" && pwd)"
main="$(git rev-parse --path-format=absolute --git-common-dir)/.." || exit 2
short=$(git rev-parse --short HEAD) || exit 2

if out=$("$tools/check-e2e.sh" 2>&1); then
  echo "$out"
  exit 0
fi

if git rev-parse -q --verify origin/main >/dev/null 2>&1; then
  for c in $(git rev-list origin/main..HEAD 2>/dev/null); do
    jq -e --arg sha "$c" '.sha == $sha and .clean == true and .passed == true' "$main/.claude/e2e/$c" >/dev/null 2>&1 || continue
    if offending=$("$tools/release-only-diff.sh" "$c" HEAD 2>&1); then
      echo "$(git rev-parse --short "$c") の E2E の記録があり、HEAD $short までがリリース作業だけ"
      exit 0
    fi
    # 最新の記録のあるコミットから HEAD までに、リリース作業の外の変更がある
    echo "HEAD $short に E2E の記録がありません。E2E の記録のある最新のコミット $(git rev-parse --short "$c") から HEAD までに、リリース作業の外の変更があります:" >&2
    echo "$offending" >&2
    echo "Release PR の準備で .claude/tools/run-e2e.sh を回してください（.claude/skills/release/SKILL.md）" >&2
    exit 1
  done
fi

echo "HEAD $short に E2E の記録がなく、origin/main から HEAD までに E2E の記録のあるコミットもありません" >&2
echo "Release PR の準備で .claude/tools/run-e2e.sh を回してください（.claude/skills/release/SKILL.md）" >&2
exit 1
