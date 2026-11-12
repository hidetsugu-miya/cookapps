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

# check_gate <ゲート名> <名前> <hook 入力の cwd> <コマンド> [stderr に出る文]: exit 2 で止まり、ゲートの行がログに残り、文があればそれが stderr に出ることを確かめる
check_gate() {
  local gate=$1 name=$2 got err
  rm -rf "$tmp/hook-logs"
  err=$(jq -n --arg cwd "$3" --arg c "$4" '{cwd: $cwd, tool_input: {command: $c}}' \
    | CLAUDE_PROJECT_DIR="$main" "$hook" 2>&1 >/dev/null)
  got=$?
  if [ "$got" -ne 2 ]; then echo "FAIL $name (期待 2、結果 ${got})"; fail=1
  elif ! cat "$tmp"/hook-logs/hooks-*.log 2>/dev/null | grep -q -F "gate=$gate"$'\t'; then echo "FAIL $name (ログにゲート $gate の行がない)"; fail=1
  elif [ -n "${5:-}" ] && ! grep -q -F "$5" <<< "$err"; then echo "FAIL $name (文がない: $5)"; fail=1
  else echo "ok   $name"; fi
}

# 止める: 記録の無い worktree の HEAD は、main で起動しても止まる
check 2 "main で起動し worktree で push（記録なし）" "$work" "git push -u origin HEAD"
check 2 "main で起動し main から git -C で worktree を push（記録なし）" "$main" "git -C $work push -u origin HEAD"
check 2 "main で起動し main から git -C で相対の worktree を push（記録なし）" "$tmp" "git -C work push -u origin HEAD"
check 2 "main で起動し cd で worktree に移って push（記録なし）" "$main" "cd $work && git push -u origin HEAD"
check 2 "main で起動し cd の相対パスで worktree に移って push（記録なし）" "$tmp" "cd work; git push -u origin HEAD"

# 通す: 記録がそろった worktree と、新しいコミットの無い main
mkdir -p "$main/.claude/ci" "$main/.claude/e2e" "$main/.claude/reviews"
jq -n --arg sha "$sha" '{sha: $sha, clean: true, passed: true, version: "0.0.0"}' > "$main/.claude/ci/$sha"
jq -n --arg sha "$sha" '{sha: $sha, clean: true, passed: true, version: "0.0.0", tests: {passed: 1, total: 1}}' > "$main/.claude/e2e/$sha"
check_gate "レビュー" "main で起動し worktree で push（合格記録なし、ゲートの行が残る）" "$work" "git push -u origin HEAD"
: > "$main/.claude/reviews/$sha"
# check_logged_pass <ゲート名> <名前> <hook 入力の cwd> <コマンド>: exit 0 で通り、ゲートの行が exit=0 でログに残ることを確かめる
check_logged_pass() {
  local gate=$1 name=$2 got
  rm -rf "$tmp/hook-logs"
  jq -n --arg cwd "$3" --arg c "$4" '{cwd: $cwd, tool_input: {command: $c}}' \
    | CLAUDE_PROJECT_DIR="$main" "$hook" >/dev/null 2>&1
  got=$?
  if [ "$got" -ne 0 ]; then echo "FAIL $name (期待 0、結果 ${got})"; fail=1
  elif ! cat "$tmp"/hook-logs/hooks-*.log 2>/dev/null | grep -q -E "gate=$gate"$'\t'"duration_ms=[0-9]+"$'\t'"exit=0"; then echo "FAIL $name (ログにゲート $gate の exit=0 の行がない)"; fail=1
  else echo "ok   $name"; fi
}
check_logged_pass "レビュー" "main で起動し worktree で push（記録あり、ゲートの行が exit=0 で残る）" "$work" "git push -u origin HEAD"
echo dirty > "$work/dirty.txt"
git -C "$work" add dirty.txt
check 2 "main で起動し worktree で push（記録あり、未コミットの変更あり）" "$work" "git push -u origin HEAD"
check_gate "作業ツリー" "未コミットの変更ありで push（ゲートの行が残る）" "$work" "git push -u origin HEAD" "コミットしていない変更があります"
check_gate "作業ツリー" "未コミットの変更ありで commit と push（別のコマンドにする文が出る）" "$work" "git commit -m x && git push -u origin HEAD" "commit と push を別のコマンドにしてください"
err=$(jq -n --arg cwd "$work" --arg c "git tag -a v0.0.1 -m v0.0.1 && git push origin v0.0.1" '{cwd: $cwd, tool_input: {command: $c}}' \
  | CLAUDE_PROJECT_DIR="$main" "$hook" 2>&1 >/dev/null)
got=$?
if [ "$got" -ne 2 ]; then echo "FAIL 未コミットの変更ありで tag と push（期待 2、結果 ${got})"; fail=1
elif grep -q -F "別のコマンドにしてください" <<< "$err"; then echo "FAIL 未コミットの変更ありで tag と push（tag に別のコマンドを求める文が出た）"; fail=1
else echo "ok   未コミットの変更ありで tag と push（別のコマンドにする文は出ない）"; fi
git -C "$work" reset -q dirty.txt
rm "$work/dirty.txt"

# リリース作業だけの新しいコミット: 合格記録がなくても通り、レビューのゲートの行が exit=0 で残る
echo "## v0.0.1" > "$work/CHANGELOG.md"
git -C "$work" add CHANGELOG.md
git -C "$work" commit -q -m "release"
rsha=$(git -C "$work" rev-parse HEAD)
jq -n --arg sha "$rsha" '{sha: $sha, clean: true, passed: true, version: "0.0.0"}' > "$main/.claude/ci/$rsha"
jq -n --arg sha "$rsha" '{sha: $sha, clean: true, passed: true, version: "0.0.0", tests: {passed: 1, total: 1}}' > "$main/.claude/e2e/$rsha"
check_logged_pass "レビュー" "リリース作業だけの新しいコミットで push（合格記録なし、ゲートの行が exit=0 で残る）" "$work" "git push -u origin HEAD"check 0 "main の checkout から push（新しいコミットなし）" "$main" "git push origin main"
check 0 "無関係なコマンド" "$work" "git status"

# main の checkout の HEAD に記録が無ければ、従来どおり止まる
git -C "$main" commit -q --allow-empty -m "empty"
check 2 "main の checkout で push（記録なし）" "$main" "git push origin main"
exit $fail
