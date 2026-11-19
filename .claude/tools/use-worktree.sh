#!/usr/bin/env bash
# 使い方: use-worktree.sh ブランチ名（例: use-worktree.sh feat/C-2）| use-worktree.sh --park
# worktree はブランチごとに 1 つ: main の checkout の .claude/worktrees/{ブランチ名の / を - に置き換えたもの} に作る。session ごと（ブランチごと）に専用で、終わったら --park で消す（.claude/rules/worktree.md）。
# ブランチ名: worktree のパスを最後の行に出す。
#   そのパスがあって、そのブランチにいるなら、private files をコピーし直してパスを出す（続きの作業）。
#   そのパスがあって別のブランチか detached なら、使用中として理由を stderr に出して exit 3。
#   そのブランチが別の worktree（main の checkout を含む）で checkout 済みなら、使用中として exit 3（release/next も同じ。後から来た側は手を出さない）。
#   それ以外は worktree を作る。ブランチがローカルにあればそれを（origin/main にマージ済みなら origin/main まで進める）、origin/{ブランチ} があればそれを追跡して、どちらもなければ origin/main から新しく切る。
#   作ったあとに、.worktreeinclude のコピー（main の checkout のものが正）、main の checkout の src-tauri/target の APFS の clone（差分ビルド用の incremental/ は消す。失敗したら警告を出して空から始める）、ensure-deps.sh（npm ci）をする。
# --park: 今いるディレクトリの worktree（.claude/worktrees/ の下のリンクされた worktree）を消す。空いているときだけ消し、そうでなければ exit 3。
#   空いている = 作業ツリーがきれいで、HEAD がどれかのリモートブランチに含まれる（origin/main か、push 済みのブランチ。失う変更もコミットもない）。
#   消すのは worktree（git worktree remove。--force は使わない。ignored なファイルは一緒に消える）、origin/main にマージ済みのそのブランチ（push 済みでマージ前のブランチは残す）、持ち主がこの worktree の issue の claim（plan-release.py claim）。最後の行に main の checkout のパスを出す。
# どの checkout から呼んでもよい。
set -euo pipefail
usage() { echo "使い方: use-worktree.sh ブランチ名 | use-worktree.sh --park" >&2; exit 2; }
[ $# -eq 1 ] || usage
arg=$1
main=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd -P)

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

busy() { echo "使用中: ${1}（${2}）" >&2; exit 3; }

# 空いているか: きれいで、HEAD がどれかのリモートブランチに含まれる（push 済みのコミットは、消しても失わない）。
check_idle() {
  cur=$(git -C "$1" branch --show-current)
  where=${cur:-detached}
  [ -z "$(git -C "$1" status --porcelain)" ] || busy "ブランチ ${where} に未コミットの変更があります" "$1"
  [ -n "$(git -C "$1" branch -r --contains HEAD)" ] || busy "ブランチ ${where} に push していないコミットがあります" "$1"
}

git -C "$main" fetch origin main

if [ "$arg" = "--park" ]; then
  top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "対象外: git の作業ツリーではありません" >&2; exit 3; }
  top=$(cd "$top" && pwd -P)
  case "$top" in "$main/.claude/worktrees/"*) ;; *) echo "対象外: $top は $main/.claude/worktrees/ の下の worktree ではありません" >&2; exit 3 ;; esac
  [ "$(cd "$(git -C "$top" rev-parse --path-format=absolute --git-dir)" && pwd -P)" != "$(cd "$(git -C "$top" rev-parse --path-format=absolute --git-common-dir)" && pwd -P)" ] \
    || { echo "対象外: $top はリンクされた worktree ではありません" >&2; exit 3; }
  check_idle "$top"
  git -C "$main" worktree remove "$top"
  if [ -n "$cur" ] && git -C "$main" merge-base --is-ancestor "$cur" origin/main; then
    git -C "$main" branch -D "$cur" >/dev/null
  fi
  for claim in "$main"/.claude/claims/*/; do
    [ -f "${claim}owner" ] && [ "$(cat "${claim}owner")" = "$top" ] && rm -rf "$claim"
  done
  echo "$main"
  exit 0
fi

branch=$arg
dest="$main/.claude/worktrees/${branch//\//-}"
git -C "$main" fetch origin "$branch" 2>/dev/null || true

if [ -d "$dest" ]; then
  now=$(git -C "$dest" branch --show-current)
  [ "$now" = "$branch" ] && { copy_private; echo "$dest"; exit 0; }
  busy "別のブランチ ${now:-detached} がいます（ブランチ ${branch} の worktree のパス）" "$dest"
fi

# 消えたディレクトリの worktree の登録は、ブランチを checkout 済みに見せ続けるので、先に外す。
git -C "$main" worktree prune
holder=$(git -C "$main" worktree list --porcelain | awk -v ref="refs/heads/$branch" '/^worktree /{p=substr($0,10)} $0=="branch " ref{print p; exit}')
[ -z "$holder" ] || busy "ブランチ ${branch} は別の worktree で checkout 済みです" "$holder"

if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$main" worktree add --quiet "$dest" "$branch"
  # すでにあるブランチがマージ済みなら origin/main まで進める。
  if git -C "$dest" merge-base --is-ancestor HEAD origin/main; then
    git -C "$dest" merge --ff-only --quiet origin/main
  fi
elif git -C "$main" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git -C "$main" worktree add --quiet -b "$branch" --track "$dest" "origin/$branch"
else
  git -C "$main" worktree add --quiet -b "$branch" --no-track "$dest" origin/main
fi
copy_private
# 依存クレートのビルド結果は場所によらず使えるので、main の checkout の target を clone で写して最初のビルドを速くする。
# 更新時刻は保つ（clean-target.sh が Cargo.toml との新旧で、依存の変更の前の結果を消す）。APFS でない場所では cp が普通のコピーに切り替える。コピーに失敗したとき（ディスクが一杯など）は、作りかけを消して空から始める。
if [ -d "$main/src-tauri/target" ]; then
  if cp -cpR "$main/src-tauri/target" "$dest/src-tauri/target"; then
    rm -rf "$dest"/src-tauri/target/*/incremental
  else
    rm -rf "$dest/src-tauri/target"
    echo "警告: src-tauri/target をコピーできませんでした（空からビルドします）" >&2
  fi
fi
# node_modules は写さず、ensure-deps.sh で入れる（main の checkout の node_modules は誰も入れ直さないので、package-lock.json と違う版のことがある）。
# mise.toml をコピーしたあとに実行する（Node の版は mise が決める）。
"$(cd "$(dirname "$0")" && pwd)/ensure-deps.sh" "$dest"
echo "$dest"
