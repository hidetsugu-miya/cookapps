#!/bin/sh
# Runs the ship skill headlessly from the main checkout; launchd starts it every day at 00:30 (issues.md).
# Usage: nightly.sh ship  (the exit code is claude's)
# Keeps one run with a lock directory, writes .claude/nightly/ship-{date}.log (logs older than 30 days are deleted), and shows a macOS notification at the end.
# The skill gets NIGHTLY_DEADLINE_EPOCH, the end of its 3 hours (03:30 for the job), which it checks with nightly-limit.sh before it starts something new (nothing kills the process at the deadline; nightly-limit.sh also holds a run to 10 points), and HANDOVER_RUN_START (handover.sh).
set -u
if [ $# -ne 1 ]; then
  echo "使い方: nightly.sh ship" >&2
  exit 2
fi
case "$1" in
  ship) skill="$1" ;;
  *)
    echo "使い方: nightly.sh ship" >&2
    exit 2
    ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
main="$(cd "$here" && git rev-parse --path-format=absolute --git-common-dir)/.."
cd "$main" || exit 1
mkdir -p .claude/nightly
log="$(pwd -P)/.claude/nightly/${skill}-$(date +%Y-%m-%d).log"
notify() {
  osascript -e "display notification \"$1\" with title \"cookapps 夜間 ${skill}\"" >/dev/null 2>&1 || true
}
# A lock left by a run that died without its trap (power loss, SIGKILL) is taken over when its PID is gone or now runs another command.
lock=".claude/nightly/${skill}.lock"
if ! mkdir "$lock" 2>/dev/null; then
  if ps -p "$(cat "$lock/pid" 2>/dev/null)" -o command= 2>/dev/null | grep -qF "nightly.sh ${skill}"; then
    echo "スキップ: $(date '+%Y-%m-%d %H:%M:%S') 前の実行がまだ動いています（${lock}）" >> "$log"
    notify "前の実行がまだ動いているので、今回は何もしません。ログ: ${log}"
    exit 0
  fi
  rm -rf "$lock"
  mkdir "$lock" || exit 1
fi
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT
find .claude/nightly -name '*.log' -mtime +30 -delete
echo "開始: $(date '+%Y-%m-%d %H:%M:%S')" >> "$log"
export HANDOVER_RUN_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export NIGHTLY_DEADLINE_EPOCH=$(($(date +%s) + 3 * 3600))
claude -p "/${skill}" --permission-mode auto </dev/null >> "$log" 2>&1
code=$?
echo "終了コード: ${code}" >> "$log"
echo "終了: $(date '+%Y-%m-%d %H:%M:%S')" >> "$log"
if [ "$code" -eq 0 ]; then
  msg="成功しました。ログ: ${log}"
else
  msg="失敗しました（終了コード ${code}）。ログ: ${log}"
fi
notify "$msg"
exit "$code"
