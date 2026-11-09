#!/usr/bin/env bash
# ソースの版が固定値のままであることを確かめる。
# 版を持つのはタグだけで、release job がタグから取って tauri build --config で入れる（.claude/rules/versioning.md）。
# Cargo.toml と Cargo.lock は 0.0.0、tauri.conf.json には version が無い。
# 使い方: scripts/check-version.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/src-tauri"

fixed=0.0.0
# [package] セクション内の最初の version だけを読む。
cargo_toml=$(awk '/^\[/ { in_pkg = ($0 == "[package]") } in_pkg && /^version[[:space:]]*=/ { print; exit }' Cargo.toml | sed -E 's/^[^"]*"([^"]*)".*/\1/')
# tauri.conf.json は version の値を読む。キーが無ければ空。
tauri_conf=$(python3 -c 'import json; print(json.load(open("tauri.conf.json")).get("version", ""))')
# Cargo.lock は name = "cookapps" の直後の version を読む。
cargo_lock=$(awk '$0 == "name = \"cookapps\"" { getline; print; exit }' Cargo.lock | sed -E 's/^[^"]*"([^"]*)".*/\1/')

status=0
[ "$cargo_toml" = "$fixed" ] || status=1
[ -z "$tauri_conf" ] || status=1
[ "$cargo_lock" = "$fixed" ] || status=1

if [ "$status" -ne 0 ]; then
  echo "ソースの版が固定値ではありません（Cargo.toml と Cargo.lock は $fixed、tauri.conf.json は version なし）:" >&2
  printf '  Cargo.toml=%s\n  tauri.conf.json=%s\n  Cargo.lock=%s\n' "$cargo_toml" "${tauri_conf:-（なし）}" "$cargo_lock" >&2
  exit 1
fi
echo "ソースの版は固定値: $fixed"
