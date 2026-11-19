#!/usr/bin/env bash
# node_modules を package-lock.json に揃える。揃っていれば何もしない（#1017）。
# 使い方: ensure-deps.sh [checkout のパス]（省略時はカレント）。
# node_modules が無いとき、または node_modules/.tsunagiai-lock-sha256 の値が今の package-lock.json の sha256 と違う（印が無い場合を含む）ときだけ、mise exec -- npm ci を走らせ、成功したら印を書く。
#   印の値は npm ci の前に読んだ package-lock.json のハッシュ（途中で lock が変わっても、入れた lock の印になる）。
#   npm ci が失敗したら印は書かず、その終了コードで終わる。
#   package-lock.json が無い checkout では何もしない。
# 呼び出し元: session-start.sh、run-ci.sh、run-e2e.sh、use-worktree.sh。出力の扱いは呼び出し元が決める。
set -euo pipefail
cd "${1:-.}"
[ -f package-lock.json ] || exit 0
mark=node_modules/.tsunagiai-lock-sha256
want=$(shasum -a 256 package-lock.json | cut -d' ' -f1)
[ -d node_modules ] && [ "$(cat "$mark" 2>/dev/null || true)" = "$want" ] && exit 0
rm -f "$mark"
mise exec -- npm ci --silent
echo "$want" >"$mark"
