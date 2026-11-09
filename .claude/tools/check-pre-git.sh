#!/usr/bin/env bash
# pre-git.sh の自己確認: 一時ディレクトリの git リポジトリ（リモート、main の checkout、worktree）に hook 入力を流し、止める（exit 2）・通す（exit 0）を確かめる（#310）。
# 本物のリモート、キーチェーン、記録は使わない。この script 自身の checkout の pre-git.sh を検査する（pre-git.sh は、自身に触れる push でこれを走らせる）。
set -uo pipefail
tools="$(cd "$(dirname "$0")" && pwd)"
hook="$tools/../hooks/pre-git.sh"
fail=0

tmp=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp"' EXIT
export COOKAPPS_HOOK_LOG_DIR="$tmp/hook-logs"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.test GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.test

git init -q --bare "$tmp/remote.git" || exit 2
git clone -q "$tmp/remote.git" "$tmp/main" 2>/dev/null || exit 2
main="$tmp/main"
mkdir -p "$main/src-tauri" "$main/.claude/tools"
printf '[package]\nname = "x"\nversion = "0.0.0"\n' > "$main/src-tauri/Cargo.toml"
cp "$tools/check-ci.sh" "$tools/check-e2e.sh" "$tools/release-only-diff.sh" "$main/.claude/tools/"
git -C "$main" checkout -q -b main
git -C "$main" add -A
git -C "$main" commit -q -m init
git -C "$main" push -q origin main 2>/dev/null || exit 2
git -C "$main" worktree add -q -b work "$tmp/work" origin/main 2>/dev/null || exit 2
work="$tmp/work"
echo change > "$work/change.txt"
git -C "$work" add change.txt
git -C "$work" commit -q -m "change"
sha=$(git -C "$work" rev-parse HEAD)

# check <期待する終了コード> <名前> <hook 入力の cwd> <コマンド> [CLAUDE_PROJECT_DIR]
check() {
  local want=$1 name=$2 got
  jq -n --arg cwd "$3" --arg c "$4" '{cwd: $cwd, tool_input: {command: $c}}' \
    | CLAUDE_PROJECT_DIR="${5:-$main}" "$hook" >/dev/null 2>&1
  got=$?
  [ "$got" -eq "$want" ] && echo "ok   $name" || { echo "FAIL $name (期待 ${want}、結果 ${got})"; fail=1; }
}

# 止める: 記録の無い worktree の HEAD は、main で起動しても止まる
check 2 "main で起動し worktree で push（記録なし）" "$work" "git push -u origin HEAD"
check 2 "main で起動し main から git -C で worktree を push（記録なし）" "$main" "git -C $work push -u origin HEAD"
check 2 "main で起動し main から git -C で相対の worktree を push（記録なし）" "$tmp" "git -C work push -u origin HEAD"

# 通す: 記録がそろった worktree と、新しいコミットの無い main
mkdir -p "$main/.claude/ci" "$main/.claude/e2e" "$main/.claude/reviews"
jq -n --arg sha "$sha" '{sha: $sha, clean: true, passed: true, version: "0.0.0"}' > "$main/.claude/ci/$sha"
jq -n --arg sha "$sha" '{sha: $sha, clean: true, passed: true, version: "0.0.0", tests: {passed: 1, total: 1}}' > "$main/.claude/e2e/$sha"
check 2 "main で起動し worktree で push（合格記録なし）" "$work" "git push -u origin HEAD"
: > "$main/.claude/reviews/$sha"
check 0 "main で起動し worktree で push（記録あり）" "$work" "git push -u origin HEAD"
echo dirty > "$work/dirty.txt"
git -C "$work" add dirty.txt
check 2 "main で起動し worktree で push（記録あり、未コミットの変更あり）" "$work" "git push -u origin HEAD"
git -C "$work" reset -q dirty.txt
rm "$work/dirty.txt"
check 0 "main の checkout から push（新しいコミットなし）" "$main" "git push origin main"
check 0 "無関係なコマンド" "$work" "git status"

# main の checkout の HEAD に記録が無ければ、従来どおり止まる
git -C "$main" commit -q --allow-empty -m "empty"
check 2 "main の checkout で push（記録なし）" "$main" "git push origin main"
exit $fail
