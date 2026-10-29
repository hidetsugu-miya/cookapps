#!/usr/bin/env bash
# cookup を .app にビルドして Apple Development 証明書で署名し、/Applications に置く。
# 使い方: scripts/install-app.sh [--no-install]   （--no-install はビルドと署名の確認まで）
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

npx tauri build --bundles app

app="$root/src-tauri/target/release/bundle/macos/cookup.app"
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

dest=/Applications/cookup.app
if pgrep -x cookup >/dev/null; then
  echo "cookup が起動中です。終了してからやり直してください。" >&2
  exit 1
fi
# 古い版は削除せずゴミ箱へ移す。
if [ -e "$dest" ]; then
  mv "$dest" "$HOME/.Trash/cookup-$(date +%Y%m%d%H%M%S).app"
fi
ditto "$app" "$dest"
echo "インストールしました: $dest"
