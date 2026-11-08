#!/bin/sh
# The other Claude Code sessions that work in this repository, as destinations for SendMessage (worktree.md, "Tell the other cookapps sessions").
# Usage: cookapps-sessions.sh
# Prints one line for each session: `uds:/tmp/cc-socks/{pid}.sock`, a tab, and the session's working folder. Prints nothing and exits 0 when there is none.
# A session is kept when its working folder shares this repository's common git directory, so a worktree outside the main checkout counts and a session of another repository does not.
# The session that runs this script is left out: it is the first ancestor of the script whose pid has a socket.
# `/tmp/cc-socks/{pid}.sock` and the `uds:` destination are an internal form of Claude Code, not a published specification, and an update can change them.
# The working folder is read with `lsof -a -p {pid} -d cwd -Fn`.
# It was checked on Claude Code 2.1.319 on macOS.
set -u
socks=/tmp/cc-socks
[ -d "$socks" ] || exit 0

here="$(cd "$(dirname "$0")" && pwd)" || exit 1
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)" || exit 1

me=""
pid=$$
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  if [ -S "$socks/$pid.sock" ]; then
    me="$pid"
    break
  fi
  pid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
done

for sock in "$socks"/*.sock; do
  [ -S "$sock" ] || continue
  pid="$(basename "$sock" .sock)"
  [ "$pid" = "$me" ] && continue
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [ -n "$cwd" ] || continue
  other="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || continue
  [ "$other" = "$common" ] || continue
  printf 'uds:%s\t%s\n' "$sock" "$cwd"
done
