#!/usr/bin/env bash
# HEAD の e2e と review の合格を、GitHub の commit status で送る（.claude/rules/issues.md）。main の ruleset がこの 2 つを必須にしている。
# 手元の CI と E2E の記録があるときだけ送るので、合格記録を書ける release-verifier の役割は変わらない。指摘の中身は送らない。
# review は、HEAD の合格記録か、origin/main から HEAD までがリリース作業だけ（Release PR）であることで満たす。CI と E2E の記録は、Release PR の HEAD にも要る。
# HEAD を push してから呼ぶ。どのチェックアウトからでもよく、呼んだ場所の HEAD を見る。
set -uo pipefail
main="$(git rev-parse --path-format=absolute --git-common-dir)/.." || exit 2
git diff --quiet HEAD || { echo "コミットしていない変更があります" >&2; exit 1; }
sha=$(git rev-parse HEAD) || exit 2

"$main/.claude/tools/check-ci.sh" || exit 1
"$main/.claude/tools/check-e2e.sh" || exit 1

if [ ! -f "$main/.claude/reviews/$sha" ]; then
  git fetch -q origin main || exit 2
  "$main/.claude/tools/release-only-diff.sh" origin/main HEAD || {
    echo "HEAD ${sha:0:7} に合格記録がなく、origin/main からの差分もリリース作業だけではありません（上が外れたパス）" >&2
    exit 1
  }
fi

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || exit 2
for context in e2e review; do
  gh api -X POST "repos/$repo/statuses/$sha" -f state=success -f context="$context" -f description="passed on this machine" >/dev/null || exit 1
done
echo "送信しました: ${sha:0:7} e2e review"
