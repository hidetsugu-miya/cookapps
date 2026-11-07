#!/bin/sh
# Runs a skill headlessly from the main checkout; launchd starts discussion-judge every day at 00:00 and milestone-dev every day at 01:00 (issues.md).
# Usage: nightly.sh discussion-judge|milestone-dev  (the exit code is claude's)
# Keeps one run per skill with a lock directory, writes .claude/nightly/{skill}-{date}.log (logs older than 30 days are deleted), and shows a macOS notification at the end.
# Both set NIGHTLY_DEADLINE_EPOCH, which the skill checks with nightly-limit.sh before it starts something new; nothing kills the process at the deadline.
# milestone-dev: the end of its 3 hours, and HANDOVER_RUN_START (handover.sh). It first waits for the lock of discussion-judge to go (at most 30 minutes), so that the issues made there are placed in the same night.
# discussion-judge: 50 minutes after the start, 00:50 for the job.
set -u
if [ $# -ne 1 ]; then
  echo "使い方: nightly.sh discussion-judge|milestone-dev" >&2
  exit 2
fi
case "$1" in
  discussion-judge | milestone-dev) skill="$1" ;;
  *)
    echo "使い方: nightly.sh discussion-judge|milestone-dev" >&2
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
if [ "$skill" = milestone-dev ]; then
  waited=0
  judge_lock=".claude/nightly/discussion-judge.lock"
  while [ -d "$judge_lock" ] && ps -p "$(cat "$judge_lock/pid" 2>/dev/null)" -o command= 2>/dev/null | grep -qF "nightly.sh discussion-judge"; do
    if [ "$waited" -ge 1800 ]; then
      echo "待機を打ち切り: $(date '+%Y-%m-%d %H:%M:%S') discussion-judge が 30 分たっても終わらないので、先へ進みます" >> "$log"
      break
    fi
    [ "$waited" -eq 0 ] && echo "待機: $(date '+%Y-%m-%d %H:%M:%S') discussion-judge の実行が終わるのを待ちます" >> "$log"
    sleep 10
    waited=$((waited + 10))
  done
  export HANDOVER_RUN_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  export NIGHTLY_DEADLINE_EPOCH=$(($(date +%s) + 3 * 3600))
else
  export NIGHTLY_DEADLINE_EPOCH=$(($(date +%s) + 50 * 60))
fi
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
