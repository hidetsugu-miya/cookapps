#!/bin/sh
# Runs milestone-dev headlessly from the main checkout; launchd starts it every day at 01:00 (issues.md).
# Usage: nightly-milestone-dev.sh  (no arguments; the exit code is claude's)
# Keeps one run at a time with a lock directory, writes .claude/nightly/{date}.log, and shows a macOS notification at the end.
set -u
main="$(cd "$(dirname "$0")" && git rev-parse --path-format=absolute --git-common-dir)/.."
cd "$main" || exit 1
mkdir -p .claude/nightly
if ! mkdir .claude/nightly/lock 2>/dev/null; then
  echo "夜間の milestone-dev はすでに動いています（.claude/nightly/lock）。今回は何もしません" >&2
  exit 0
fi
trap 'rmdir .claude/nightly/lock' EXIT
log="$(pwd -P)/.claude/nightly/$(date +%Y-%m-%d).log"
echo "開始: $(date '+%Y-%m-%d %H:%M:%S')" >> "$log"
claude -p "/milestone-dev" --permission-mode auto </dev/null >> "$log" 2>&1
code=$?
echo "終了コード: $code" >> "$log"
echo "終了: $(date '+%Y-%m-%d %H:%M:%S')" >> "$log"
if [ "$code" -eq 0 ]; then
  msg="成功しました。ログ: $log"
else
  msg="失敗しました（終了コード $code）。ログ: $log"
fi
osascript -e "display notification \"$msg\" with title \"cookapps 夜間 milestone-dev\"" >/dev/null 2>&1 || true
exit "$code"
