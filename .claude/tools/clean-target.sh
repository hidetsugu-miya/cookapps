#!/bin/sh
# Deletes the old build output of cookapps itself from src-tauri/target of the main checkout and of every worktree; launchd runs it every day at 21:00 (harness.md).
# Usage: clean-target.sh  (no arguments; it prints the size of each target before and after)
# In each profile (target/debug, target/release, ...) it deletes what has not been modified for more than 1 day:
# every entry directly under incremental/, and the entries of cookapps itself (cookapps-*, cookapps_lib-*, libcookapps_lib-*, cookapps_mcp-*) directly under deps/, build/ and .fingerprint/.
# The output of dependency crates stays, because a version bump does not make more of it.
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

# Deletes the old output inside one target directory ($1).
clean_one() {
  for profile in "$1"/*/; do
    [ -d "$profile" ] || continue
    [ -d "${profile}incremental" ] &&
      find "${profile}incremental" -mindepth 1 -maxdepth 1 -mtime +1 -exec rm -rf {} +
    for sub in deps build .fingerprint; do
      [ -d "${profile}${sub}" ] || continue
      find "${profile}${sub}" -mindepth 1 -maxdepth 1 \
        \( -name 'cookapps-*' -o -name 'cookapps_lib-*' -o -name 'libcookapps_lib-*' -o -name 'cookapps_mcp-*' \) \
        -mtime +1 -exec rm -rf {} +
    done
  done
}

run() {
  echo "開始: $(date '+%Y-%m-%d %H:%M:%S')"
  git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do
    target="$wt/src-tauri/target"
    [ -d "$target" ] || continue
    before="$(du -sh "$target" | cut -f1)"
    clean_one "$target"
    after="$(du -sh "$target" | cut -f1)"
    echo "${target}: ${before} -> ${after}"
  done
  echo "終了: $(date '+%Y-%m-%d %H:%M:%S')"
}

run 2>&1 | tee -a "$log"
