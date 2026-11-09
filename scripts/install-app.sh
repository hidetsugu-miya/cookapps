#!/usr/bin/env bash
# cookapps を .app にビルドして Apple Development 証明書で署名し、/Applications に置く。
# 使い方: scripts/install-app.sh [--no-install]   （--no-install はビルドと署名の確認まで）
# 版は手元の最新のタグから取る（git fetch --tags で新しくできる）。
# 署名の ID は環境変数 APPLE_SIGNING_IDENTITY で渡す。無ければ keychain の最初の Apple Development 証明書を使う。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning | awk '/"Apple Development/ { print $2; exit }')
  if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
    echo "Apple Development 証明書が見つかりません。APPLE_SIGNING_IDENTITY を指定してください。" >&2
    exit 1
  fi
fi
export APPLE_SIGNING_IDENTITY

# ソースの版は固定の 0.0.0 で、版はタグだけが持つ。最新のタグの版を渡して、入れたアプリがすぐ更新を出さないようにする（タグが無ければ 0.0.0 のまま）。
# git リポジトリの外（ソースの zip など）では、タグが無いときと同じく版なしでビルドする。
version=$(git tag --list 'v0.*' --sort=-v:refname 2>/dev/null | head -n 1 || true)
if [ -n "$version" ]; then
  npx tauri build --bundles app --config "{\"version\":\"${version#v}\"}"
else
  npx tauri build --bundles app
fi

app="$root/src-tauri/target/release/bundle/macos/cookapps.app"
codesign --verify --deep --strict "$app"
info=$(codesign -dvv "$app" 2>&1)
echo "$info" | grep -E '^(Authority|TeamIdentifier)='
if ! echo "$info" | grep -q '^Authority=Apple Development' || echo "$info" | grep -q '^TeamIdentifier=not set'; then
  echo "Team ID 付きの Apple Development 署名になっていません。" >&2
  exit 1
fi

if [ "${1:-}" = "--no-install" ]; then
  echo "ビルド済み: $app"
  exit 0
fi

dest=/Applications/cookapps.app
if pgrep -x cookapps >/dev/null; then
  echo "cookapps が起動中です。終了してからやり直してください。" >&2
  exit 1
fi
# 古い版は削除せずゴミ箱へ移す。
if [ -e "$dest" ]; then
  mv "$dest" "$HOME/.Trash/cookapps-$(date +%Y%m%d%H%M%S).app"
fi
ditto "$app" "$dest"
echo "インストールしました: $dest"
