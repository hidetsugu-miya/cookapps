#!/usr/bin/env bash
# A fresh worktree has no node_modules; `npx tauri` needs them.
. "$(cd "$(dirname "$0")" && pwd)/hook-log.sh"
hook_log_begin
cd "${CLAUDE_PROJECT_DIR:?}" || exit 0
[ -d node_modules ] || npm ci --silent >&2 || echo "npm ci に失敗しました" >&2
exit 0
