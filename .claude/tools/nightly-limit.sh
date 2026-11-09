#!/bin/sh
# Tells a run whether it may start something new (issues.md). The run stops itself with this; nothing kills the process.
# Usage: nightly-limit.sh issue {n} [--taken {a,b,...}], or nightly-limit.sh judgment|proposal
# issue {n}: may issue #n be started, when the issues {a,b,...} are already in hand in this run?
#   No when the point:8 rule says so (a point:8 issue is a Release PR of its own: it starts only as the first issue of a run, and nothing starts after it). Exit 3.
#   In a night run (NIGHTLY_DEADLINE_EPOCH is set) also no once the deadline has passed (exit 1), and no when the points of the issues in hand and of #n add up to more than 10 (exit 3; a smaller issue may still fit).
# judgment: may a new judgment of discussion-judge be started? No once the deadline (50 minutes after the wait for improvement-proposal ends; 23:50 when there is no wait) has passed.
# proposal: may a new candidate of improvement-proposal be started? No once the deadline (23:00) has passed.
# Exit 0: yes. Exit 1: no, the deadline has passed (stdout says why). Exit 3: no, #n does not fit the points (stdout says why). Exit 2: wrong usage, or an issue without a point label.
# nightly.sh sets NIGHTLY_DEADLINE_EPOCH for the runs it starts. A session of the owner has none, so it is never limited in time or in points.
# The points of an issue are its `point:*` label, read with gh. Checking by hand: NIGHTLY_NOW_EPOCH replaces the current time, NIGHTLY_DEADLINE_EPOCH may be set by hand,
# and NIGHTLY_POINTS_LIST (lines of "{issue number} {points}") replaces the labels read with gh.
set -u
MAX_POINTS=10
usage() {
  echo "使い方: nightly-limit.sh issue {n} [--taken {a,b,...}]、または nightly-limit.sh judgment|proposal" >&2
  exit 2
}
kind="${1:-}"
case "$kind" in
  judgment | proposal) [ $# -eq 1 ] || usage ;;
  issue)
    n="${2:-}"
    case "$n" in '' | *[!0-9]*) usage ;; esac
    taken=""
    case "${3:-}" in
      '') [ $# -eq 2 ] || usage ;;
      --taken) [ $# -eq 4 ] || usage; taken="$4" ;;
      *) usage ;;
    esac
    ;;
  *) usage ;;
esac

# points_of {n}: the number of the point:* label of the issue, or nothing
points_of() {
  if [ -n "${NIGHTLY_POINTS_LIST+x}" ]; then
    printf '%s\n' "$NIGHTLY_POINTS_LIST" | awk -v n="$1" '$1 == n { print $2; exit }'
  else
    gh issue view "$1" --json labels --jq '[.labels[].name | select(startswith("point:")) | ltrimstr("point:")][0] // empty' 2>/dev/null
  fi
}

if [ "$kind" = issue ]; then
  mine="$(points_of "$n")"
  if [ -z "$mine" ]; then
    echo "no: #${n} に point:* のラベルがありません" >&2
    exit 2
  fi
  sum=0
  solo_taken=""
  for t in $(printf '%s' "$taken" | tr ',' ' '); do
    p="$(points_of "$t")"
    if [ -z "$p" ]; then
      echo "no: #${t} に point:* のラベルがありません" >&2
      exit 2
    fi
    sum=$((sum + p))
    [ "$p" -eq 8 ] && solo_taken="$t"
  done
  if [ -n "$solo_taken" ]; then
    echo "no: #${solo_taken}（point:8）はこの回の唯一の issue です。そのあとに issue は始めません"
    exit 3
  fi
  if [ "$mine" -eq 8 ] && [ -n "$taken" ]; then
    echo "no: #${n} は point:8 で、単独で Release PR になります。この回にはすでに issue があるので、始めません"
    exit 3
  fi
fi

if [ -z "${NIGHTLY_DEADLINE_EPOCH:-}" ]; then
  echo "yes: 夜間の実行ではないので、制限はありません"
  exit 0
fi
now="${NIGHTLY_NOW_EPOCH:-$(date +%s)}"
if [ "$now" -ge "$NIGHTLY_DEADLINE_EPOCH" ]; then
  echo "no: この回の締め切り（$(date -r "$NIGHTLY_DEADLINE_EPOCH" '+%H:%M')）を過ぎました"
  exit 1
fi
if [ "$kind" = issue ] && [ $((sum + mine)) -gt "$MAX_POINTS" ]; then
  echo "no: 手元の ${sum} ポイントに #${n} の ${mine} ポイントを足すと、1 回の上限 ${MAX_POINTS} ポイントを超えます"
  exit 3
fi
if [ "$kind" = issue ]; then
  echo "yes: 手元は $((sum + mine)) ポイント（上限 ${MAX_POINTS}）、締め切りは $(date -r "$NIGHTLY_DEADLINE_EPOCH" '+%H:%M') です"
else
  echo "yes: 締め切りは $(date -r "$NIGHTLY_DEADLINE_EPOCH" '+%H:%M') です"
fi
