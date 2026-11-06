#!/bin/sh
# Runs a skill headlessly from the main checkout; launchd starts milestone-dev every day at 01:00, 09:00 and 13:00 and improvement-proposal every day at 22:00 (issues.md).
# Usage: nightly.sh milestone-dev|improvement-proposal  (the exit code is claude's)
# Keeps one run per skill with a lock directory, writes .claude/nightly/{skill}-{date}.log (logs older than 30 days are deleted), runs proposal-reminder.sh after claude, and shows a macOS notification at the end.
# At the start it sends the Pushover messages that waited for 09:00 (notify.sh flush), and on a failure or a skipped run it sends one (notify.sh send); the skill itself sends the summary of its run.
# For milestone-dev it sets HANDOVER_RUN_START (handover.sh) and NIGHTLY_DEADLINE_EPOCH, the end of the 3 hours of the run, which the skill checks with nightly-limit.sh before it starts a new issue or a release. Nothing kills the process at the deadline.
set -u
if [ $# -ne 1 ]; then
  echo "使い方: nightly.sh milestone-dev|improvement-proposal" >&2
  exit 2
fi
case "$1" in
  milestone-dev | improvement-proposal) skill="$1" ;;
  *)
    echo "使い方: nightly.sh milestone-dev|improvement-proposal" >&2
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
push() {
  "$here/notify.sh" send "$1" "$2" >> "$log" 2>&1 || echo "notify.sh send が失敗しました" >> "$log"
}
# A lock left by a run that died without its trap (power loss, SIGKILL) is taken over when its PID is gone or now runs another command.
lock=".claude/nightly/${skill}.lock"
if ! mkdir "$lock" 2>/dev/null; then
  if ps -p "$(cat "$lock/pid" 2>/dev/null)" -o command= 2>/dev/null | grep -qF "nightly.sh ${skill}"; then
    echo "スキップ: $(date '+%Y-%m-%d %H:%M:%S') 前の実行がまだ動いています（${lock}）" >> "$log"
    notify "前の実行がまだ動いているので、今回は何もしません。ログ: ${log}"
    push "cookapps 夜間 ${skill}" "前の実行がまだ動いているので、今回は何もしませんでした。"
    exit 0
  fi
  rm -rf "$lock"
  mkdir "$lock" || exit 1
fi
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT
find .claude/nightly -name '*.log' -mtime +30 -delete
echo "開始: $(date '+%Y-%m-%d %H:%M:%S')" >> "$log"
"$here/notify.sh" flush >> "$log" 2>&1 || echo "notify.sh flush が失敗しました" >> "$log"
if [ "$skill" = milestone-dev ]; then
  export HANDOVER_RUN_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  export NIGHTLY_DEADLINE_EPOCH=$(($(date +%s) + 3 * 3600))
fi
claude -p "/${skill}" --permission-mode auto </dev/null >> "$log" 2>&1
code=$?
echo "終了コード: ${code}" >> "$log"
if ! "$here/proposal-reminder.sh" >> "$log" 2>&1; then
  echo "proposal-reminder.sh が失敗しました（CLAUDE.local.md は変えていません）" >> "$log"
fi
echo "終了: $(date '+%Y-%m-%d %H:%M:%S')" >> "$log"
if [ "$code" -eq 0 ]; then
  msg="成功しました。ログ: ${log}"
else
  msg="失敗しました（終了コード ${code}）。ログ: ${log}"
  push "cookapps 夜間 ${skill} 失敗" "終了コード ${code}。ログ: ${log}"
fi
notify "$msg"
exit "$code"
