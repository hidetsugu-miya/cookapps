#!/usr/bin/env bash
# review-verifier だけが呼ぶ（guard-review.sh が強制する）。stdin の判定を HEAD の合格記録として残し、pre-git.sh が push 前に見る。
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
git diff --quiet HEAD || { echo "コミットしていない変更があります。レビューした中身と HEAD が一致しません" >&2; exit 1; }
dir="$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/reviews"
mkdir -p "$dir"
sha=$(git rev-parse HEAD)
cat > "$dir/$sha"
echo "合格を記録しました: $sha"
