#!/bin/sh
# Tells a nightly run whether it may start something new (issues.md). The run stops itself with this; nothing kills the process.
# Usage: nightly-limit.sh issue|release|judgment
# issue:   may a new issue be started? No once the run's deadline has passed.
# release: may a release be started? No once the deadline has passed. There is no release window (issues.md).
# judgment: may a new judgment of discussion-judge be started? No once the deadline (00:50) has passed.
# Exit 0: yes. Exit 1: no (stdout says why). Exit 2: wrong usage.
# nightly.sh sets NIGHTLY_DEADLINE_EPOCH for the runs it starts. A session of the owner has none, so it is never limited (the owner's instruction to release counts).
# Checking by hand: NIGHTLY_NOW_EPOCH replaces the current time, and NIGHTLY_DEADLINE_EPOCH may be set by hand.
set -u
case "${1:-}" in
  issue | release | judgment) ;;
  *)
    echo "使い方: nightly-limit.sh issue|release|judgment" >&2
    exit 2
    ;;
esac
if [ -z "${NIGHTLY_DEADLINE_EPOCH:-}" ]; then
  echo "yes: 夜間の実行ではないので、制限はありません"
  exit 0
fi
now="${NIGHTLY_NOW_EPOCH:-$(date +%s)}"
if [ "$now" -ge "$NIGHTLY_DEADLINE_EPOCH" ]; then
  echo "no: この回の締め切り（$(date -r "$NIGHTLY_DEADLINE_EPOCH" '+%H:%M')）を過ぎました"
  exit 1
fi
echo "yes: 締め切りは $(date -r "$NIGHTLY_DEADLINE_EPOCH" '+%H:%M') です"
