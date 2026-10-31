#!/usr/bin/env bash
# Cargo.toml / tauri.conf.json / Cargo.lock のバージョン（と、引数のタグ名）が一致することを確かめる。
# 使い方: scripts/check-version.sh [v0.4.2]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/src-tauri"

# [package] セクション内の最初の version だけを読む。
cargo_toml=$(awk '/^\[/ { in_pkg = ($0 == "[package]") } in_pkg && /^version[[:space:]]*=/ { print; exit }' Cargo.toml | sed -E 's/^[^"]*"([^"]*)".*/\1/')
tauri_conf=$(python3 -c 'import json; print(json.load(open("tauri.conf.json"))["version"])')
# Cargo.lock は name = "cookapps" の直後の version を読む。
cargo_lock=$(awk '$0 == "name = \"cookapps\"" { getline; print; exit }' Cargo.lock | sed -E 's/^[^"]*"([^"]*)".*/\1/')

versions=("Cargo.toml=$cargo_toml" "tauri.conf.json=$tauri_conf" "Cargo.lock=$cargo_lock")
if [ $# -ge 1 ]; then
  versions+=("tag($1)=${1#v}")
fi

expected=${cargo_toml}
status=0
for entry in "${versions[@]}"; do
  value=${entry#*=}
  if [ -z "$value" ] || [ "$value" != "$expected" ]; then
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "バージョンが一致しません:" >&2
  printf '  %s\n' "${versions[@]}" >&2
  exit 1
fi
echo "バージョン一致: $expected"
