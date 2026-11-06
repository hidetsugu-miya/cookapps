#!/usr/bin/env bash
# 使い方: new-worktree.sh ブランチ名 [ディレクトリ名]（例: new-worktree.sh feat/C-2）
# origin/main から新しいブランチを切って main の checkout の .claude/worktrees/{ディレクトリ名} に worktree を作り、
# .worktreeinclude のファイルとディレクトリをコピーし（main の checkout から同じ位置へ）、npm ci で node_modules を用意する（.claude/rules/worktree.md）。
# ディレクトリ名の省略時はブランチ名の / を - にしたもの。作った worktree のパスを最後の行に出す。どの checkout から呼んでもよい。
set -euo pipefail
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "使い方: new-worktree.sh ブランチ名 [ディレクトリ名]" >&2; exit 2; }
branch=$1
name=${2:-${branch//\//-}}
main=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
dest="$main/.claude/worktrees/$name"

[ -e "$dest" ] && { echo "$dest はすでにあります" >&2; exit 2; }
git -C "$main" fetch origin main
git -C "$main" worktree add -b "$branch" "$dest" origin/main

# 追跡されていないファイルは worktree に出てこないので、main の checkout のものをコピーする。
while IFS= read -r entry; do
  case "$entry" in '' | '#'*) continue ;; esac
  path=${entry%/}
  if [ -e "$main/$path" ]; then
    mkdir -p "$(dirname "$dest/$path")"
    cp -R "$main/$path" "$(dirname "$dest/$path")/"
  else
    echo "警告: $path が main の checkout にありません（コピーしません）" >&2
  fi
done < "$main/.worktreeinclude"

# mise.toml をコピーしたあとに実行する（Node の版は mise が決める）。
(cd "$dest" && mise exec -- npm ci --silent)
echo "$dest"
