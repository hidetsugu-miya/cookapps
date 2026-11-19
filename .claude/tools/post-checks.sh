#!/usr/bin/env bash
# HEAD の e2e と review の合格を、GitHub の commit status で送る（.claude/rules/issues.md）。main の ruleset がこの 2 つを必須にしている。
# 手元の CI の記録があるときだけ送るので、合格記録を書けるのは release-verifier と range-check.sh だけで、この役割は変わらない。指摘の中身は送らない。
# CI・review は、HEAD の記録か、origin/main から HEAD までがリリース作業だけ（Release PR）であることで満たす（#931）。
# e2e は、機能の PR では回さないので記録を見ず、「Release PR で回す」という説明つきで success を送る。release/next のときだけ、E2E の記録を求める（check-release-e2e.sh）。
# ruleset は head のブランチで分けられないので、e2e を必須のまま残して、Release PR のマージを止める手段にする（#1023）。
# HEAD を push してから呼ぶ。どのチェックアウトからでもよく、呼んだ場所の HEAD を見る。
set -uo pipefail
main="$(git rev-parse --path-format=absolute --git-common-dir)/.." || exit 2
git diff --quiet HEAD || { echo "コミットしていない変更があります" >&2; exit 1; }
sha=$(git rev-parse HEAD) || exit 2
branch=$(git symbolic-ref -q --short HEAD || true)

# origin/main から HEAD までがリリース作業だけか（Release PR）。要るときに 1 回だけ fetch して調べる。
ro=""
offending=""
fetched=""
fetch_main() {
  [ -n "$fetched" ] || { git fetch -q origin main || exit 2; fetched=yes; }
}
release_only() {
  if [ -z "$ro" ]; then
    fetch_main
    if offending=$("$main/.claude/tools/release-only-diff.sh" origin/main HEAD 2>&1); then ro=yes; else ro=no; fi
  fi
  [ "$ro" = yes ]
}

ci_out=$("$main/.claude/tools/check-ci.sh" 2>&1); ci=$?
if [ "$ci" -ne 0 ]; then
  release_only || {
    echo "$ci_out" >&2
    echo "HEAD ${sha:0:7} に CI の記録がなく、origin/main からの差分もリリース作業だけではありません（下が外れたパス）" >&2
    echo "$offending" >&2
    exit 1
  }
fi

if [ ! -f "$main/.claude/reviews/$sha" ]; then
  release_only || {
    echo "HEAD ${sha:0:7} に合格記録がなく、origin/main からの差分もリリース作業だけではありません（下が外れたパス）" >&2
    echo "$offending" >&2
    exit 1
  }
fi

# E2E: Release PR だけ記録を求める。ほかのブランチは見ない。
e2e_desc="E2E runs at the Release PR"
if [ "$branch" = "release/next" ]; then
  fetch_main
  e2e_out=$("$main/.claude/tools/check-release-e2e.sh" 2>&1) || {
    echo "$e2e_out" >&2
    exit 1
  }
  e2e_desc="passed on this machine"
fi

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || exit 2
gh api -X POST "repos/$repo/statuses/$sha" -f state=success -f context="e2e" -f description="$e2e_desc" >/dev/null || exit 1
gh api -X POST "repos/$repo/statuses/$sha" -f state=success -f context="review" -f description="passed on this machine" >/dev/null || exit 1
echo "送信しました: ${sha:0:7} e2e review"
