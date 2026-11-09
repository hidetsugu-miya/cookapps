# Sourced by the hooks that settings.local.json wires (#260): `. "$(cd "$(dirname "$0")" && pwd)/hook-log.sh"; hook_log_begin`.
# At exit it appends to logs/hooks-{YYYY-MM-DD}.log of the main checkout (git's common dir, so a worktree does not make its own) one line per run:
#   {start time}<TAB>hook={name}<TAB>duration_ms={n}<TAB>exit={code}
# and one line per gate that hook_log_gate was told about:
#   {start time}<TAB>hook={name}<TAB>gate={gate name}<TAB>duration_ms={n}<TAB>exit={code}
# It writes only these names, times and codes: never a command, a path, a file's content or a hook input (publishing.md).
# It reads no stdin, prints nothing, and never changes the hook's exit code, so a log that cannot be written changes nothing.
# COOKAPPS_HOOK_LOG_DIR replaces the directory; the self-tests of the hooks set it to a temporary one.

# Milliseconds since the epoch (macOS ships bash 3.2, which has no EPOCHREALTIME).
hook_log_now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local t=${EPOCHREALTIME/[.,]/}
    echo $((t / 1000))
  else
    perl -MTime::HiRes=time -e 'printf "%d\n", time() * 1000' 2>/dev/null </dev/null || echo $(($(date +%s) * 1000))
  fi
}

# hook_log_begin: call once, at the top of the hook. The name is the hook's file name.
hook_log_begin() {
  _HL_NAME=${0##*/}
  _HL_START=$(hook_log_now)
  _HL_GATES=""
  trap hook_log_end EXIT
}

# hook_log_gate <name> <start ms> <exit code>: records one gate that began at <start ms> and has just ended.
hook_log_gate() {
  local ms=$(($(hook_log_now) - $2))
  _HL_GATES+=$(printf '\n%s\thook=%s\tgate=%s\tduration_ms=%s\texit=%s' "$(hook_log_stamp "${_HL_START:-0}")" "${_HL_NAME:-}" "$1" "$ms" "$3")
}

hook_log_stamp() {
  date -r $(($1 / 1000)) '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null </dev/null || echo "$(($1 / 1000))"
}

# The EXIT trap: $? at its start is the hook's exit code, and the trap leaves it as it is.
hook_log_end() {
  local rc=$?
  {
    local ms dir stamp
    ms=$(($(hook_log_now) - ${_HL_START:-0}))
    dir=${COOKAPPS_HOOK_LOG_DIR:-}
    if [ -z "$dir" ]; then
      dir=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir </dev/null) && dir="$dir/../logs"
    fi
    if [ -n "$dir" ] && mkdir -p "$dir"; then
      stamp=$(hook_log_stamp "${_HL_START:-0}")
      printf '%s\thook=%s\tduration_ms=%s\texit=%s%s\n' "$stamp" "${_HL_NAME:-}" "$ms" "$rc" "${_HL_GATES:-}" >> "$dir/hooks-$(date +%Y-%m-%d).log"
    fi
  } 2>/dev/null
  return "$rc"
}
