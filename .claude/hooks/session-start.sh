#!/usr/bin/env bash
# A fresh worktree has no node_modules, and the main checkout's can be older than package-lock.json; `npx tauri` needs them.
. "$(cd "$(dirname "$0")" && pwd)/hook-log.sh"
hook_log_begin
cd "${CLAUDE_PROJECT_DIR:?}" || exit 0
"$(cd "$(dirname "$0")/../tools" && pwd)/ensure-deps.sh" . >&2 || echo "npm ci に失敗しました" >&2
exit 0
