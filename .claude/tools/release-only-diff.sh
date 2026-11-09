#!/usr/bin/env bash
# 使い方: release-only-diff.sh A B
# A..B の差分がリリース作業だけ（版の更新、README、CHANGELOG、docs）なら exit 0。そうでなければ、外れたパスを標準エラーに出して exit 1。
# pre-git.sh が、合格記録のあるコミットから HEAD までが版の更新だけかを確かめるのに使う（.claude/rules/review.md）。
# 免除するのはレビューの合格記録だけ。版の行が変わると cargo と tsc の結果も変わるので、CI（run-ci.sh）と E2E の記録は Release PR の HEAD にも要る。
# カレントのリポジトリで動く。
set -uo pipefail
[ $# -eq 2 ] || { echo "使い方: release-only-diff.sh A B" >&2; exit 2; }
a=$1
b=$2

# Cargo.toml: [package] の version 行だけを除く。依存の version 行は除かない。
strip_toml() { awk '/^\[/{p=($0=="[package]")} p && /^version[ \t]*=/{next} {print}'; }
# Cargo.lock: name = "cookapps" の直後の version 行だけを除く。
strip_lock() { awk 'f && /^version = /{f=0; next} {f=($0 == "name = \"cookapps\"")} {print}'; }
# tauri.conf.json: 最上位の version だけを除く。
strip_conf() { jq -S 'del(.version)'; }

# same <パス> <除去コマンド>: 両側にあり、除去後に等しければ 0。
same() {
  git cat-file -e "$a:$1" 2>/dev/null && git cat-file -e "$b:$1" 2>/dev/null || return 1
  local x y
  x=$(git show "$a:$1" | "$2") && y=$(git show "$b:$1" | "$2") || return 1
  [ "$x" = "$y" ]
}

bad=()
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    README.md | CHANGELOG.md | docs/*) ;;
    src-tauri/Cargo.toml) same "$path" strip_toml || bad+=("$path") ;;
    src-tauri/Cargo.lock) same "$path" strip_lock || bad+=("$path") ;;
    src-tauri/tauri.conf.json) same "$path" strip_conf || bad+=("$path") ;;
    *) bad+=("$path") ;;
  esac
done < <(git diff --name-only --no-renames "$a" "$b")

[ ${#bad[@]} -eq 0 ] && exit 0
printf '%s\n' "${bad[@]}" >&2
exit 1
