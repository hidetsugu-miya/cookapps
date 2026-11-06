#!/bin/sh
# Runs milestone-dev headlessly from the main checkout; launchd starts it every day at 01:00 (issues.md).
# Usage: nightly-milestone-dev.sh  (no arguments; the exit code is claude's)
# Keeps one run at a time with a lock directory, writes .claude/nightly/{date}.log (logs older than 30 days are deleted), and shows a macOS notification at the end.
set -u
main="$(cd "$(dirname "$0")" && git rev-parse --path-format=absolute --git-common-dir)/.."
cd "$main" || exit 1
mkdir -p .claude/nightly
log="$(pwd -P)/.claude/nightly/$(date +%Y-%m-%d).log"
notify() {
  osascript -e "display notification \"$1\" with title \"cookapps 夜間 milestone-dev\"" >/dev/null 2>&1 || true
}
# A lock left by a run that died without its trap (power loss, SIGKILL) is taken over when its PID is gone or now runs another command.
lock=.claude/nightly/lock
if ! mkdir "$lock" 2>/dev/null; then
  if ps -p "$(cat "$lock/pid" 2>/dev/null)" -o command= 2>/dev/null | grep -q nightly-milestone-dev; then
    echo "スキップ: $(date '+%Y-%m-%d %H:%M:%S') 前の実行がまだ動いています（${lock}）" >> "$log"
    notify "前の実行がまだ動いているので、今回は何もしません。ログ: $log"
    exit 0
  fi
  rm -rf "$lock"
  mkdir "$lock" || exit 1
fi
echo $$ > "$lock/pid"
trap 'rm -rf .claude/nightly/lock' EXIT
find .claude/nightly -name '*.log' -mtime +30 -delete
echo "開始: $(date '+%Y-%m-%d %H:%M:%S')" >> "$log"
claude -p "/milestone-dev" --permission-mode auto </dev/null >> "$log" 2>&1
code=$?
echo "終了コード: $code" >> "$log"
echo "終了: $(date '+%Y-%m-%d %H:%M:%S')" >> "$log"
if [ "$code" -eq 0 ]; then
  msg="成功しました。ログ: $log"
else
  msg="失敗しました（終了コード ${code}）。ログ: $log"
fi
notify "$msg"
exit "$code"
