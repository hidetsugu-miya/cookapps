#!/usr/bin/env bash
# Usage: shots.sh   (from the root of a worktree, with node_modules installed)
# Takes the README's screen photos with made-up data and writes them to docs/assets/readme/.
# The spec is copied into e2e/specs only for the run. The E2E binary it leaves has a taller window; run-e2e.sh builds its own.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ -f wdio.conf.ts ] && [ -d e2e/specs ] || { echo "run this from the root of a worktree" >&2; exit 2; }
[ -d node_modules ] || { echo "node_modules is missing: run npm ci" >&2; exit 2; }
spec=e2e/specs/readme-shots.e2e.ts
raw="$(mktemp -d)"
trap 'rm -f "$spec"; rm -rf "$raw"' EXIT
cp "$here/readme-shots.e2e.ts" "$spec"
mise exec -- npm run build:ts
mise exec -- node e2e/assemble.mjs
mise exec -- npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json --config "$here/tauri.shots.conf.json"
sed "s|__ROOT__|$PWD|g" "$here/wdio.shots.conf.ts" > "$raw/wdio.shots.conf.ts"
SHOT_OUT="$raw" mise exec -- npx wdio run "$raw/wdio.shots.conf.ts"
mkdir -p docs/assets/readme
for f in "$raw"/*.png; do
  # The window is 32 px taller than the page draws, so keep the top 900 rows. sips -c crops around the center and is no use here.
  python3 -I "$here/crop.py" "$f" "docs/assets/readme/$(basename "$f")" 900
done
ls -l docs/assets/readme
