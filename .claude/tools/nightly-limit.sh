#!/bin/sh
# Tells a nightly run whether it may start something new (issues.md). The run stops itself with this; nothing kills the process.
# Usage: nightly-limit.sh issue|judgment|proposal, or nightly-limit.sh release {tag}
# issue:   may a new issue be started? No once the run's deadline has passed.
# release {tag}: may the release of this version be started? No once the deadline has passed. No when the run has already released a tag of another minor (v0.53.0 then v0.53.1 is yes, v0.53.0 then v0.54.0 is no). There is no release window (issues.md).
# judgment: may a new judgment of discussion-judge be started? No once the deadline (50 minutes after the wait for improvement-proposal ends; 23:50 when there is no wait) has passed.
# proposal: may a new candidate of improvement-proposal be started? No once the deadline (23:00) has passed.
# Exit 0: yes. Exit 1: no (stdout says why). Exit 2: wrong usage.
# nightly.sh sets NIGHTLY_DEADLINE_EPOCH for the runs it starts, and NIGHTLY_START_EPOCH (the start of the run) for milestone-dev. A session of the owner has none, so it is never limited (the owner's instruction to release counts).
# Checking by hand: NIGHTLY_NOW_EPOCH replaces the current time, NIGHTLY_DEADLINE_EPOCH and NIGHTLY_START_EPOCH may be set by hand, and NIGHTLY_TAGS_LIST (lines of "{tag} {created epoch}") replaces the tags read from git.
set -u
kind="${1:-}"
case "$kind" in
  issue | judgment | proposal) ;;
  release)
    case "${2:-}" in
      v[0-9]*.[0-9]*.[0-9]*) ;;
      *)
        echo "使い方: nightly-limit.sh release v{major}.{minor}.{patch}" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "使い方: nightly-limit.sh issue|judgment|proposal、または nightly-limit.sh release {tag}" >&2
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
if [ "$kind" = release ] && [ -n "${NIGHTLY_START_EPOCH:-}" ]; then
  if [ -n "${NIGHTLY_TAGS_LIST+x}" ]; then
    tags="$NIGHTLY_TAGS_LIST"
  else
    tags="$(git for-each-ref --format='%(refname:short) %(creatordate:unix)' 'refs/tags/v*')"
  fi
  minor="${2#v}"
  minor="${minor%.*}"
  other="$(printf '%s\n' "$tags" | awk -v start="$NIGHTLY_START_EPOCH" -v minor="$minor" '$2 + 0 >= start { v = $1; sub(/^v/, "", v); split(v, p, "."); if (p[1] "." p[2] != minor) { print $1; exit } }')"
  if [ -n "$other" ]; then
    echo "no: この回は ${other} をリリースしたので、別のマイナーの ${2} は次の回に回します"
    exit 1
  fi
fi
echo "yes: 締め切りは $(date -r "$NIGHTLY_DEADLINE_EPOCH" '+%H:%M') です"
