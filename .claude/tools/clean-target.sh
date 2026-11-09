#!/bin/sh
# Deletes the old build output of cookapps itself from src-tauri/target of the main checkout and of every worktree; launchd runs it every day at 21:00 (harness.md).
# Usage: clean-target.sh  (no arguments; it prints the size of each target before and after)
# In each profile (target/debug, target/release, ...) it deletes what has nothing modified in the last 24 hours, or nothing newer than the src-tauri/Cargo.toml of its checkout (the output built before the last change of Cargo.toml, which is now a change of the dependencies or features: the version is fixed at 0.0.0, so a release does not touch the file; no build uses that output again), and nothing while cargo or rustc runs:
# every entry directly under incremental/, and the entries of cookapps itself (cookapps-*, cookapps_lib-*, libcookapps_lib-*, cookapps_mcp-*) directly under deps/, build/ and .fingerprint/.
# The output of dependency crates stays, because a change of the dependencies of cookapps changes the hash of the output of cookapps itself, and the output of the crates that did not change is still used.
# It also deletes the records and logs of run-ci.sh and run-e2e.sh (.claude/ci/ and .claude/e2e/ of the main checkout) that are older than 30 days; check-ci.sh and check-e2e.sh read only the record of HEAD.
# It deletes the hook logs, logs/hooks-{date}.log of the main checkout (hook-log.sh), that are older than 30 days.
# It appends to .claude/nightly/clean-target-{date}.log in the main checkout (logs older than 30 days are deleted).
set -u
if [ $# -ne 0 ]; then
  echo "使い方: clean-target.sh" >&2
  exit 2
fi
here="$(cd "$(dirname "$0")" && pwd)"
main="$(cd "$here" && git rev-parse --path-format=absolute --git-common-dir)/.."
cd "$main" || exit 1
mkdir -p .claude/nightly
log="$(pwd -P)/.claude/nightly/clean-target-$(date +%Y-%m-%d).log"
find .claude/nightly -name 'clean-target-*.log' -mtime +30 -delete
[ -d logs ] && find logs -maxdepth 1 -name 'hooks-*.log' -mtime +30 -delete

# True when nothing in $1 (the entry itself or, for a directory, anything inside it) was modified in the last 24 hours,
# or is newer than the file $2 (the Cargo.toml of the checkout; a missing file does not count).
# A directory's own mtime does not change when cargo overwrites a file inside it, so the newest file decides.
is_stale() {
  [ -z "$(find "$1" -mmin -1440 -print 2>/dev/null | head -n 1)" ] && return 0
  [ -f "$2" ] && [ -z "$(find "$1" -newer "$2" -print 2>/dev/null | head -n 1)" ]
}

# Deletes the old output inside one target directory ($1) of the checkout whose Cargo.toml is $2.
clean_one() {
  for profile in "$1"/*/; do
    [ -d "$profile" ] || continue
    for sub in incremental deps build .fingerprint; do
      [ -d "${profile}${sub}" ] || continue
      for entry in "${profile}${sub}"/*; do
        [ -e "$entry" ] || continue
        if [ "$sub" != incremental ]; then
          case "${entry##*/}" in
            cookapps-* | cookapps_lib-* | libcookapps_lib-* | cookapps_mcp-*) ;;
            *) continue ;;
          esac
        fi
        is_stale "$entry" "$2" && rm -rf "$entry"
      done
    done
  done
}

run() {
  echo "開始: $(date '+%Y-%m-%d %H:%M:%S')"
  for dir in .claude/ci .claude/e2e; do
    [ -d "$dir" ] || continue
    n="$(find "$dir" -maxdepth 1 -type f -mtime +30 -print -delete | wc -l | tr -d ' ')"
    echo "${dir}: 30 日を超えた記録とログを ${n} 件消しました"
  done
  # A build in progress may be about to use an old file, so nothing is deleted while cargo or rustc runs; the next day's run cleans.
  if pgrep -x cargo >/dev/null || pgrep -x rustc >/dev/null; then
    echo "スキップ: cargo か rustc が動いています"
    return 0
  fi
  git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do
    target="$wt/src-tauri/target"
    [ -d "$target" ] || continue
    before="$(du -sh "$target" | cut -f1)"
    clean_one "$target" "$wt/src-tauri/Cargo.toml"
    after="$(du -sh "$target" | cut -f1)"
    echo "${target}: ${before} -> ${after}"
  done
  echo "終了: $(date '+%Y-%m-%d %H:%M:%S')"
}

run 2>&1 | tee -a "$log"
