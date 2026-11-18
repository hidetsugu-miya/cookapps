#!/usr/bin/env bash
# range-check.sh の自己確認: 一時ディレクトリの git リポジトリ（main の checkout と worktree）と、その中の一時の記録ディレクトリで、通す（exit 0 と合格記録）・止める（exit 1 と記録なし）・使い方の誤り（exit 2）を確かめる（#932）。
# 本物の記録（.claude/reviews/、.claude/ci/、.claude/e2e/）には触れない。この script 自身の checkout の range-check.sh と record-review.sh を検査する（pre-git.sh は、これらに触れる push でこれを走らせる）。
set -uo pipefail
tools="$(cd "$(dirname "$0")" && pwd)"
fail=0

tmp=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.test GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.test
# 本物の main の checkout の記録を読み書きしないよう、record-review.sh が使う変数は range-check.sh が自分で決める
unset CLAUDE_PROJECT_DIR

main="$tmp/main"
git init -q "$main" || exit 2
git -C "$main" checkout -q -b main
mkdir -p "$main/src-tauri" "$main/.claude/tools" "$main/.claude/hooks" "$main/ts"
printf '[package]\nname = "x"\nversion = "0.0.0"\n' > "$main/src-tauri/Cargo.toml"
cp "$tools/range-check.sh" "$tools/check-ci.sh" "$tools/check-e2e.sh" "$main/.claude/tools/"
cp "$tools/../hooks/record-review.sh" "$main/.claude/hooks/"
echo one > "$main/ts/a.ts"
echo one > "$main/ts/b.ts"
git -C "$main" add -A
git -C "$main" commit -q -m init
git -C "$main" worktree add -q -b work "$tmp/work" main 2>/dev/null || exit 2
work="$tmp/work"
rc="$main/.claude/tools/range-check.sh"
mkdir -p "$main/.claude/ci" "$main/.claude/e2e" "$main/.claude/reviews"

# commit <ファイル>...: 渡したファイルを書き換えてコミットし、新しい HEAD に CI と E2E の合格記録を書く
commit() {
  local f sha
  for f in "$@"; do echo "$RANDOM" >> "$work/$f"; done
  git -C "$work" add -A
  git -C "$work" commit -q -m "change $*"
  sha=$(git -C "$work" rev-parse HEAD)
  jq -n --arg sha "$sha" '{sha: $sha, clean: true, passed: true, version: "0.0.0"}' > "$main/.claude/ci/$sha"
  jq -n --arg sha "$sha" '{sha: $sha, clean: true, passed: true, version: "0.0.0", tests: {passed: 1, total: 1}}' > "$main/.claude/e2e/$sha"
}
# pass_record <コミット>: そのコミットに合格記録を置く（release-verifier が書いたものの代わり）
pass_record() { echo pass > "$main/.claude/reviews/$(git -C "$work" rev-parse "$1")"; }
# reset_to <コミット>: worktree をそのコミットに戻し、それより後の記録を捨てる
reset_to() { git -C "$work" reset -q --hard "$1"; git -C "$work" clean -q -fd; }

# run <期待する終了コード> <名前> <合格したコミット> <一覧の内容> [標準エラーに出る文]
run() {
  local want=$1 name=$2 passed=$3 err got head
  printf '%s\n' "$4" > "$tmp/list.txt"
  head=$(git -C "$work" rev-parse HEAD)
  rm -f "$main/.claude/reviews/$head"
  err=$(cd "$work" && "$rc" "$passed" "$tmp/list.txt" 2>&1 >/dev/null)
  got=$?
  if [ "$got" -ne "$want" ]; then echo "FAIL $name (期待 ${want}、結果 ${got}: $err)"; fail=1
  elif [ "$want" -eq 0 ] && [ ! -s "$main/.claude/reviews/$head" ]; then echo "FAIL $name (合格記録が書かれていない)"; fail=1
  elif [ "$want" -ne 0 ] && [ -e "$main/.claude/reviews/$head" ]; then echo "FAIL $name (止めたのに合格記録が書かれた)"; fail=1
  elif [ -n "${5:-}" ] && ! grep -q -F -- "$5" <<< "$err"; then echo "FAIL $name (文がない: $5、出力: $err)"; fail=1
  else echo "ok   $name"; fi
}

base=$(git -C "$work" rev-parse HEAD)
pass_record "$base"

# 通す
commit ts/a.ts
run 0 "一覧のパスだけを変えた差分" "$base" "[L-1] ts/a.ts:12 空の返事を描かない"
run 0 "行番号の無いパスと、文の終わりの点" "$base" "ts/a.ts を直した。"
run 0 "一覧に余分な行があっても通る" "$base" $'[L-1] ts/a.ts:3 x\n[L-2] ts/c.ts:9 y'
commit ts/b.ts
run 0 "2 つのコミットで 2 つのパス" "$base" $'ts/a.ts:3\nts/b.ts'
run 0 "短い SHA でも渡せる" "$(git -C "$work" rev-parse --short "$base")" $'ts/a.ts:3\nts/b.ts'

# 止める: 一覧の外のパス
run 1 "一覧に無いパスがある" "$base" "ts/a.ts:3" "ts/b.ts"
run 1 "一覧が空" "$base" "" "ts/a.ts"
run 1 "パスの前に文字が付いた別のパス" "$base" $'xts/a.ts:3\nts/b.ts' "ts/a.ts"
run 1 "パスの後に文字が付いた別のパス" "$base" $'ts/a.tsx:3\nts/b.ts' "ts/a.ts"
run 1 "パスの後に拡張子が付いた別のパス" "$base" $'ts/a.ts.bak:3\nts/b.ts' "ts/a.ts"
run 1 "ディレクトリだけでは一致しない" "$base" "ts/" "ts/a.ts"
reset_to "$base"

# 止める: CI か E2E の記録が無い、合格していない
commit ts/a.ts
head=$(git -C "$work" rev-parse HEAD)
mv "$main/.claude/ci/$head" "$tmp/ci.keep"
run 1 "HEAD の CI の記録がない" "$base" "ts/a.ts" "CI の記録"
mv "$tmp/ci.keep" "$main/.claude/ci/$head"
mv "$main/.claude/e2e/$head" "$tmp/e2e.keep"
run 1 "HEAD の E2E の記録がない" "$base" "ts/a.ts" "E2E の記録"
jq -n --arg sha "$head" '{sha: $sha, clean: true, passed: false, version: "0.0.0", tests: {passed: 0, total: 1}}' > "$main/.claude/e2e/$head"
run 1 "HEAD の E2E の記録が不合格" "$base" "ts/a.ts" "E2E の記録"
mv "$tmp/e2e.keep" "$main/.claude/e2e/$head"
run 0 "記録を戻すと通る" "$base" "ts/a.ts"

# 止める: 合格したコミットの問題
reset_to "$base"
commit ts/a.ts
rm -f "$main/.claude/reviews/$base"
run 1 "合格したコミットに合格記録がない" "$base" "ts/a.ts" "合格記録がなく"
# origin/main 上のコミット（main に入るときゲートを通っている）は、記録がなくても合格したコミットとして通る
git -C "$work" update-ref refs/remotes/origin/main "$base"
run 0 "合格したコミットが origin/main 上にある（記録なし）" "$base" "ts/a.ts"
h1=$(git -C "$work" rev-parse HEAD)
rm -f "$main/.claude/reviews/$h1"
commit ts/b.ts
run 1 "記録がなく origin/main の祖先でもないコミット" "$h1" $'ts/a.ts\nts/b.ts' "origin/main の祖先でもありません"
reset_to "$h1"
git -C "$work" update-ref -d refs/remotes/origin/main
pass_record "$base"
pass_record HEAD
err=$(cd "$work" && printf 'ts/a.ts\n' > "$tmp/list.txt" && "$rc" HEAD "$tmp/list.txt" 2>&1 >/dev/null); got=$?
if [ "$got" -eq 1 ] && grep -q -F "同じです" <<< "$err"; then echo "ok   合格したコミットが HEAD と同じ"; else echo "FAIL 合格したコミットが HEAD と同じ (結果 ${got}: $err)"; fail=1; fi
git -C "$work" checkout -q -b side "$base"
echo side >> "$work/ts/a.ts"
git -C "$work" add -A
git -C "$work" commit -q -m side
side=$(git -C "$work" rev-parse HEAD)
pass_record "$side"
git -C "$work" checkout -q work
run 1 "合格したコミットが HEAD の祖先でない" "$side" "ts/a.ts" "祖先ではありません"
run 2 "合格したコミットを解決できない" "no-such-commit" "ts/a.ts" "解決できません"

# 止める: 作業ツリーが汚れている
echo dirty > "$work/ts/dirty.ts"
run 1 "追跡していないファイルがある" "$base" "ts/a.ts" "コミットしていない変更"
rm "$work/ts/dirty.ts"
echo dirty >> "$work/ts/a.ts"
run 1 "追跡しているファイルに未コミットの変更がある" "$base" "ts/a.ts" "コミットしていない変更"
git -C "$work" checkout -q -- ts/a.ts

# 使い方の誤り
(cd "$work" && "$rc" >/dev/null 2>&1); got=$?
[ "$got" -eq 2 ] && echo "ok   引数なし" || { echo "FAIL 引数なし (期待 2、結果 ${got})"; fail=1; }
(cd "$work" && "$rc" "$base" "$tmp/none.txt" >/dev/null 2>&1); got=$?
[ "$got" -eq 2 ] && echo "ok   一覧のファイルがない" || { echo "FAIL 一覧のファイルがない (期待 2、結果 ${got})"; fail=1; }
exit $fail
