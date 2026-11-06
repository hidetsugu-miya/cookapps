#!/bin/bash
# Sends a Pushover notification to the owner, only between 09:00 and 20:00 (issues.md).
# Usage: notify.sh send <title> <message> [url]
#        notify.sh flush
# send:  inside the window it sends at once (the queued messages join it, as one message); outside it, the message goes to the queue.
# flush: inside the window it sends the queued messages as one message and empties the queue; outside it, or with an empty queue, it does nothing.
# The window is 09:00 up to, not including, 20:00 of the local time. The queue is .claude/nightly/pushover-queue of the main checkout (ignored by git).
# The token and the user key are read from the keychain (service jp.mysis.cookapps.pushover-token and jp.mysis.cookapps.pushover-user, account cookapps)
# and reach curl through its standard input, so they appear in no argument, log or output.
# Checking by hand, with nothing sent:
#   NOTIFY_DRY_RUN=1   the keychain and the network are not touched; it prints what it would send. The queue is still appended to, but never emptied.
#   NOTIFY_NOW=HH:MM   the time of day to judge by
#   NOTIFY_QUEUE=path  another queue file
# Prints one line, result: sent | queued | flushed | empty. Exit 1: the keychain or Pushover refused (the queue is kept); exit 2: wrong usage.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
main="$(cd "$here" && git rev-parse --path-format=absolute --git-common-dir)/.."
queue="${NOTIFY_QUEUE:-$(cd "$main" && pwd -P)/.claude/nightly/pushover-queue}"
dry="${NOTIFY_DRY_RUN:-}"
limit=1024

usage() {
  echo "使い方: notify.sh send <title> <message> [url] | notify.sh flush" >&2
  exit 2
}

in_window() {
  hm="${NOTIFY_NOW:-$(date +%H:%M)}"
  case "$hm" in
    [0-2][0-9]:[0-5][0-9]) ;;
    *)
      echo "NOTIFY_NOW は HH:MM で書いてください: ${hm}" >&2
      exit 2
      ;;
  esac
  h="${hm%:*}"
  m="${hm#*:}"
  mins=$((${h#0} * 60 + ${m#0}))
  [ "$mins" -ge 540 ] && [ "$mins" -lt 1200 ]
}

# curl config strings: escape the backslash and the double quote, and write a newline as \n
cfg() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'
}

# deliver <title> <message> <url>
deliver() {
  title="$1"
  message="$2"
  url="$3"
  if [ "${#message}" -gt "$limit" ]; then
    message="${message:0:$((limit - 1))}…"
  fi
  if [ -n "$dry" ]; then
    echo "would send: title=${title}"
    printf '%s\n' "$message"
    [ -z "$url" ] || echo "url=${url}"
    return 0
  fi
  token="$(security find-generic-password -s jp.mysis.cookapps.pushover-token -a cookapps -w 2>/dev/null)" || {
    echo "keychain に jp.mysis.cookapps.pushover-token がありません" >&2
    return 1
  }
  user="$(security find-generic-password -s jp.mysis.cookapps.pushover-user -a cookapps -w 2>/dev/null)" || {
    echo "keychain に jp.mysis.cookapps.pushover-user がありません" >&2
    return 1
  }
  {
    echo 'url = "https://api.pushover.net/1/messages.json"'
    echo "data-urlencode = \"token=$(cfg "$token")\""
    echo "data-urlencode = \"user=$(cfg "$user")\""
    echo "data-urlencode = \"title=$(cfg "$title")\""
    echo "data-urlencode = \"message=$(cfg "$message")\""
    [ -z "$url" ] || echo "data-urlencode = \"url=$(cfg "$url")\""
  } | curl -sS -f -o /dev/null -K - || {
    echo "Pushover への送信に失敗しました" >&2
    return 1
  }
}

# send_queue: the queued lines as one message; the queue is emptied after it was delivered
send_queue() {
  n="$(wc -l < "$queue" | tr -d ' ')"
  deliver "cookapps（${n} 件）" "$(cat "$queue")" "" || return 1
  [ -n "$dry" ] || : > "$queue"
}

cmd="${1:-}"
case "$cmd" in
  send)
    [ $# -ge 3 ] && [ $# -le 4 ] || usage
    title="$2"
    message="$3"
    url="${4:-}"
    mkdir -p "$(dirname "$queue")"
    if in_window; then
      if [ -s "$queue" ]; then
        # the queued lines and this one go as one message
        n=$(($(wc -l < "$queue" | tr -d ' ') + 1))
        body="$(cat "$queue")
$(date '+%H:%M') ${title}: ${message}"
        deliver "cookapps（${n} 件）" "$body" "$url" || exit 1
        [ -n "$dry" ] || : > "$queue"
      else
        deliver "$title" "$message" "$url" || exit 1
      fi
      echo "result: sent"
    else
      printf '%s\n' "$(date '+%m-%d %H:%M') ${title}: $(printf '%s' "$message" | tr '\n' ' ')${url:+ $url}" >> "$queue"
      echo "result: queued"
    fi
    ;;
  flush)
    [ $# -eq 1 ] || usage
    if in_window && [ -s "$queue" ]; then
      send_queue "" || exit 1
      echo "result: flushed"
    else
      echo "result: empty"
    fi
    ;;
  *) usage ;;
esac
