#!/usr/bin/env bash
# 使い方: new-worktree.sh ブランチ名 [ディレクトリ名]（例: new-worktree.sh feat/C-2）
# origin/main から新しいブランチを切って main の checkout の .claude/worktrees/{ディレクトリ名} に worktree を作り、
# .worktreeinclude のファイルとディレクトリをコピーし（main の checkout から同じ位置へ）、
# main の checkout の src-tauri/target を APFS の clone で写し（差分ビルド用の incremental/ は消す。コピーに失敗したら警告を出して空から始める）、npm ci で node_modules を用意する（.claude/rules/worktree.md）。
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

# 依存クレートのビルド結果は場所によらず使えるので、main の checkout の target を clone で写して最初のビルドを速くする。
# 更新時刻は保つ（clean-target.sh が Cargo.toml との新旧で古い版の結果を消す）。APFS でない場所では cp が普通のコピーに切り替える。コピーに失敗したとき（ディスクが一杯など）は、作りかけを消して空から始める。
if [ -d "$main/src-tauri/target" ]; then
  if cp -cpR "$main/src-tauri/target" "$dest/src-tauri/target"; then
    rm -rf "$dest"/src-tauri/target/*/incremental
  else
    rm -rf "$dest/src-tauri/target"
    echo "警告: src-tauri/target をコピーできませんでした（空からビルドします）" >&2
  fi
fi

# mise.toml をコピーしたあとに実行する（Node の版は mise が決める）。
(cd "$dest" && mise exec -- npm ci --silent)
echo "$dest"
