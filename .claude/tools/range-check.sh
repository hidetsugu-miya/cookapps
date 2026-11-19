#!/usr/bin/env bash
# マージ済みの版の止めない指摘（Medium・Low）だけを直した差分の範囲確認（.claude/rules/review.md）。ブランチの合格のあとに指摘を直すことはしない（#1012）。release-verifier を起動せずに、決まった処理で確かめて HEAD の合格記録を書く（#932）。
# 使い方: range-check.sh {合格したコミット} {指摘の一覧のファイル}（通常は range-check.sh origin/main {一覧}）
# 一覧のファイルは 1 行 1 件で、各行に直した指摘の `path` か `path:line` を含む（行の残りは自由。例: `[L-1] ts/slack.ts:120 空の返事を描かない`）。
# 指摘の修正に伴うテスト・説明のファイルは、元の指摘の ID を付けた行として一覧に書いてよい（例: `[L-1] e2e/specs/inbox.e2e.ts 指摘 L-1 の修正に伴うテスト`）。指摘と関係のない変更を書いてはいけない。
# 確かめる順: 作業ツリーがクリーン、合格したコミットが合格記録を持つか origin/main の祖先か同じ（main のコミットは main に入るときゲートを通っている。マージ済みの版の指摘だけを直す PR は `range-check.sh origin/main {一覧}` で通す）、そのコミットが HEAD の祖先で HEAD と異なる、HEAD の CI と E2E の記録が合格、
# 合格したコミットから HEAD までの変更のパスがすべて一覧のパスのどれかに一致する。すべて通れば record-review.sh で HEAD の合格記録を書く。
# 記録は main の checkout の .claude/reviews/{SHA} に書かれる。どのチェックアウトから呼んでもよく、呼んだ場所の HEAD を見る。
# 終了コード: 0 は合格（記録を書いた）、1 は止めた（理由を標準エラーに出す）、2 は使い方の誤り。
set -uo pipefail
tools="$(cd "$(dirname "$0")" && pwd)"

[ "$#" -eq 2 ] || { echo "使い方: range-check.sh {合格したコミット} {指摘の一覧のファイル}" >&2; exit 2; }
list="$2"
[ -f "$list" ] || { echo "指摘の一覧のファイルがありません: $list" >&2; exit 2; }
top=$(git rev-parse --show-toplevel) || exit 2
main="$(git rev-parse --path-format=absolute --git-common-dir)/.." || exit 2
passed=$(git rev-parse --verify -q "$1^{commit}") || { echo "合格したコミットを解決できません: $1" >&2; exit 2; }
head=$(git rev-parse HEAD) || exit 2

stop() {
  echo "範囲確認で止めました: $1" >&2
  exit 1
}

[ -z "$(git status --porcelain)" ] || stop "コミットしていない変更があります。HEAD と作業ツリーが一致しません"
[ -f "$main/.claude/reviews/$passed" ] || git merge-base --is-ancestor "$passed" origin/main 2>/dev/null || stop "${passed:0:7} の合格記録がなく、origin/main の祖先でもありません。合格したコミットを渡してください"
[ "$passed" != "$head" ] || stop "合格したコミットと HEAD が同じです。範囲確認は合格のあとに直したコミットに対して行います"
git merge-base --is-ancestor "$passed" "$head" || stop "${passed:0:7} は HEAD の祖先ではありません"
ci=$("$tools/check-ci.sh" 2>&1) || stop "$ci"
e2e=$("$tools/check-e2e.sh" 2>&1) || stop "$e2e"

# 変更のパスが一覧の行のどれかに、パスの区切りで現れるか（`foo/a.ts` は `foo/a.ts:12` に一致し、`xfoo/a.ts` と `foo/a.tsx` には一致しない）
listed() {
  P="$1" awk '
    function inpath(c) { return c != "" && index("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-", c) > 0 }
    function wordc(c) { return c != "" && index("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_", c) > 0 }
    BEGIN { p = ENVIRON["P"]; n = length(p) }
    {
      start = 1
      while ((i = index(substr($0, start), p)) > 0) {
        pos = start + i - 1
        b = (pos == 1) ? "" : substr($0, pos - 1, 1)
        a = substr($0, pos + n, 1)
        a2 = substr($0, pos + n + 1, 1)
        if (!inpath(b) && (a == "" || !inpath(a) || (a == "." && !wordc(a2)))) { found = 1; exit }
        start = pos + 1
      }
    }
    END { exit !found }
  ' "$list"
}

outside=""
while IFS= read -r -d '' path; do
  listed "$path" || outside+="  $path"$'\n'
done < <(git diff --name-only --no-renames -z "$passed" HEAD)
[ -z "$outside" ] || stop "${passed:0:7} から HEAD までに、一覧の指摘のパスの外の変更があります。この差分は 1 回目の流れでレビューしてください:"$'\n'"${outside%$'\n'}"

CLAUDE_PROJECT_DIR="$top" "$tools/../hooks/record-review.sh" <<EOF || stop "合格記録を書けませんでした"
判定: 合格（range-check.sh）
範囲: ${passed:0:7}..${head:0:7}
CI: $ci
E2E: $e2e
一覧:
$(cat "$list")
EOF
