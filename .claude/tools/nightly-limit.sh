#!/bin/sh
# Tells a run whether it may start something new (issues.md). The run stops itself with this; nothing kills the process.
# Usage: nightly-limit.sh issue {n} [--taken {a,b,...}], or nightly-limit.sh judgment|proposal
# issue {n}: may issue #n be started, when the issues {a,b,...} are already in hand in this run?
#   No when the unit rule says so. Exit 3. A unit is a Release PR of its own: one point:8 issue, or all the `solo` parts (the label `issue-plan` gives the parts of a point:8 issue it split) of one milestone.
#   The parts of one unit start together in a night; an issue that is not in the unit, and a part of another unit, do not start with it, before it or after it.
#   In a night run (NIGHTLY_DEADLINE_EPOCH is set) also no once the deadline has passed (exit 1), and no when the points of the issues in hand and of #n add up to more than 10 (exit 3; a smaller issue may still fit).
# judgment: may a new judgment of discussion-judge be started? No once the deadline (50 minutes after the wait for improvement-proposal ends; 23:50 when there is no wait) has passed.
# proposal: may a new candidate of improvement-proposal be started? No once the deadline (23:00) has passed.
# Exit 0: yes. Exit 1: no, the deadline has passed (stdout says why). Exit 3: no, #n does not fit the points (stdout says why). Exit 2: wrong usage, or an issue without a point label.
# nightly.sh sets NIGHTLY_DEADLINE_EPOCH for the runs it starts. A session of the owner has none, so it is never limited in time or in points.
# The points of an issue are its `point:*` label, read with gh. Checking by hand: NIGHTLY_NOW_EPOCH replaces the current time, NIGHTLY_DEADLINE_EPOCH may be set by hand,
# and NIGHTLY_POINTS_LIST (lines of "{issue number} {points} [{unit}]"; unit is `i{n}` for a point:8 issue, `m:{milestone}` for a `solo` part, and absent for any other issue) replaces the labels read with gh.
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

# info_of {n}: "{points} {unit}" of the issue, or nothing without a point:* label. The unit is `-` for an issue outside a solo unit,
# `i{n}` for a point:8 issue, and `m:{milestone title}` for a `solo` part (`i{n}` when it has no milestone). Keep it equal to `solo()` of plan-release.py.
info_of() {
  if [ -n "${NIGHTLY_POINTS_LIST+x}" ]; then
    printf '%s\n' "$NIGHTLY_POINTS_LIST" | awk -v n="$1" '$1 == n { u = $0; sub(/^[^ ]+ +[^ ]+ */, "", u); print $2, (u == "" ? "-" : u); exit }'
  else
    gh issue view "$1" --json labels,milestone --jq '(.labels | map(.name)) as $l
      | ([$l[] | select(startswith("point:")) | ltrimstr("point:")][0] // empty) as $p
      | (if ($l | index("point:8")) then "i'"$1"'" elif ($l | index("solo")) then (if .milestone then "m:" + .milestone.title else "i'"$1"'" end) else "-" end) as $u
      | "\($p) \($u)"' 2>/dev/null
  fi
}

if [ "$kind" = issue ]; then
  mine_info="$(info_of "$n")"
  if [ -z "$mine_info" ]; then
    echo "no: #${n} に point:* のラベルがありません" >&2
    exit 2
  fi
  mine="${mine_info%% *}"
  mine_unit="${mine_info#* }"
  sum=0
  unit_taken=""
  other_taken=""
  for t in $(printf '%s' "$taken" | tr ',' ' '); do
    info="$(info_of "$t")"
    if [ -z "$info" ]; then
      echo "no: #${t} に point:* のラベルがありません" >&2
      exit 2
    fi
    sum=$((sum + ${info%% *}))
    t_unit="${info#* }"
    if [ "$t_unit" != "-" ]; then
      unit_taken="$t"
    fi
    # an issue that is not in the unit of #n (outside any unit, or in another one)
    if [ "$t_unit" != "$mine_unit" ] || [ "$mine_unit" = "-" ]; then
      other_taken="$t"
    fi
  done
  if [ "$mine_unit" = "-" ] && [ -n "$unit_taken" ]; then
    echo "no: #${unit_taken}（単独の単位: point:8 か solo の部品）がこの回にあります。単位でない #${n} は一緒に始めません"
    exit 3
  fi
  if [ "$mine_unit" != "-" ] && [ -n "$other_taken" ]; then
    echo "no: #${n} は単独の単位（point:8 か solo の部品）で、単独で Release PR になります。この回にはすでにその単位でない #${other_taken} があるので、始めません"
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
