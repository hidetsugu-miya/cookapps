#!/usr/bin/env bash
# 使い方: use-worktree.sh ブランチ名（例: use-worktree.sh feat/C-2）| use-worktree.sh --park
# worktree は main の checkout の .claude/worktrees/work の 1 つだけで、昼のセッションも夜間も同じものを使う（.claude/rules/worktree.md）。
# 作業のたびに、空いている worktree に origin/main から切ったブランチを切り替えて使い回す。worktree は消さない。
# ブランチ名: 空いていれば切り替えて、worktree のパスを最後の行に出す。ブランチがすでにあれば、そのブランチに切り替える（origin/main に追いついていれば進める）。
#   worktree がそのブランチにいるなら、何もせずパスを出す（続きの作業）。
# 空いている = 作業ツリーがきれいで、HEAD がどれかのリモートブランチに含まれる（origin/main か、push 済みのブランチ。失う変更もコミットもない）。そうでなければ使用中として、理由を stderr に出して exit 3。
# --park: 作業が終わって worktree を空きに戻す。空いているときだけ、origin/main に detach して、マージ済みの前のブランチを消す（push 済みでマージ前のブランチは残す）。そうでなければ exit 3。
# worktree がなければ作る: .worktreeinclude のコピー、main の checkout の src-tauri/target の APFS の clone（差分ビルド用の incremental/ は消す。失敗したら警告を出して空から始める）、npm ci。
# 切り替えのたびに .worktreeinclude をコピーし直し（main の checkout のものが正）、package-lock.json が変わっていれば npm ci をする。どの checkout から呼んでもよい。
set -euo pipefail
usage() { echo "使い方: use-worktree.sh ブランチ名 | use-worktree.sh --park" >&2; exit 2; }
[ $# -eq 1 ] || usage
arg=$1
main=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
dest="$main/.claude/worktrees/work"

copy_private() {
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
}

busy() { echo "使用中: ${1}（${dest}）" >&2; exit 3; }

# 空いているか: きれいで、HEAD がどれかのリモートブランチに含まれる（push 済みのコミットは、切り替えても失わない）。
check_idle() {
  cur=$(git -C "$dest" branch --show-current)
  where=${cur:-detached}
  [ -z "$(git -C "$dest" status --porcelain)" ] || busy "ブランチ ${where} に未コミットの変更があります"
  [ -n "$(git -C "$dest" branch -r --contains HEAD)" ] || busy "ブランチ ${where} に push していないコミットがあります"
}

git -C "$main" fetch origin main

if [ "$arg" = "--park" ]; then
  [ -d "$dest" ] || { echo "$dest がありません" >&2; exit 3; }
  check_idle
  git -C "$dest" switch --detach origin/main --quiet
  [ -z "$cur" ] || git -C "$dest" branch -d "$cur" >/dev/null 2>&1 || true
  echo "$dest"
  exit 0
fi

branch=$arg
git -C "$main" fetch origin "$branch" 2>/dev/null || true

if [ ! -d "$dest" ]; then
  git -C "$main" worktree add --detach "$dest" origin/main
  copy_private
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
  [ ! -f "$dest/package-lock.json" ] || (cd "$dest" && mise exec -- npm ci --silent)
else
  [ "$(git -C "$dest" branch --show-current)" = "$branch" ] && { copy_private; echo "$dest"; exit 0; }
  check_idle
fi

before=$(git -C "$dest" rev-parse HEAD)
old=$(git -C "$dest" branch --show-current)
if git -C "$dest" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$dest" switch --quiet "$branch"
elif git -C "$dest" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git -C "$dest" switch --quiet -c "$branch" --track "origin/$branch"
else
  git -C "$dest" switch --quiet -c "$branch" --no-track origin/main
fi
# すでにあるブランチがマージ済みなら origin/main まで進める。
if git -C "$dest" merge-base --is-ancestor HEAD origin/main; then
  git -C "$dest" merge --ff-only --quiet origin/main
fi
[ -z "$old" ] || [ "$old" = "$branch" ] || git -C "$dest" branch -d "$old" >/dev/null 2>&1 || true
copy_private
if ! git -C "$dest" diff --quiet "$before" HEAD -- package-lock.json; then
  (cd "$dest" && mise exec -- npm ci --silent)
fi
echo "$dest"
