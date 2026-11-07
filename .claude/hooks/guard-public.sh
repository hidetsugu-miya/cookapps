#!/usr/bin/env bash
# 公開してはいけない語（置き換え元のメールアプリ名を含む）を検出する。AGENTS.md を含む gitignore されていない全ファイルが対象。マッチした行の本文は出さず、path:line と語だけを出す。
# 使い方: guard-public.sh file <path> | tree | text | log <range>   （マッチがあれば exit 1）
# 語の一覧は、この hook 自身が公開できない語を含むため追跡せず、同じ場所の public-words（gitignore、1 行 1 パターン）から読む。無い・空のときは止める（exit 1）。
set -uo pipefail

words="$(cd "$(dirname "$0")" && pwd)/public-words"
PATTERNS=()
if [ -f "$words" ]; then
  while IFS= read -r line || [ -n "$line" ]; do [ -n "$line" ] && PATTERNS+=("$line"); done < "$words"
fi
[ "${#PATTERNS[@]}" -gt 0 ] || { echo "公開禁止語の一覧 $words がありません（または空です）。検査できないので止めます。メインのチェックアウトから複写してください" >&2; exit 1; }

root="$(cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" && pwd -P)"
cd "$root"
status=0

# stdin を語ごとに走査し、ラベル:行番号 と語を出す。
scan_stream() {
  local label=$1 buf p lines
  buf=$(cat)
  for p in "${PATTERNS[@]}"; do
    lines=$(printf '%s\n' "$buf" | grep -n -i -E -e "$p" | cut -d: -f1) || true
    for n in $lines; do echo "$label:$n: 公開禁止語 /$p/ に一致" >&2; status=1; done
  done
}

case "${1:-}" in
  file)
    f=${2:?path}
    [ -f "$f" ] || exit 0
    abs="$(cd "$(dirname "$f")" && pwd -P)/$(basename "$f")"
    case "$abs" in "$root"/*) ;; *) exit 0 ;; esac
    rel=${abs#"$root"/}
    git check-ignore -q -- "$rel" && exit 0
    grep -I -q . -- "$rel" 2>/dev/null || exit 0
    scan_stream "$rel" < "$rel"
    ;;
  tree)
    for p in "${PATTERNS[@]}"; do
      out=$(git grep -I -n -i -E --untracked -e "$p" -- . | cut -d: -f1,2) || true
      [ -n "$out" ] && { while IFS= read -r l; do echo "$l: 公開禁止語 /$p/ に一致" >&2; done <<< "$out"; status=1; }
    done
    ;;
  text) scan_stream "stdin" ;;
  log) git log --format=%B "${2:?range}" | scan_stream "commit-message" ;;
  *) echo "usage: $0 file <path>|tree|text|log <range>" >&2; exit 64 ;;
esac
exit $status
