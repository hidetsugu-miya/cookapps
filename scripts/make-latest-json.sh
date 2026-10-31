#!/usr/bin/env bash
# 自動アップデートが読む latest.json を標準出力に書く（macOS Apple Silicon の分だけ）。
# 使い方: scripts/make-latest-json.sh v0.15.0 path/to/cookapps.app.tar.gz.sig owner/repo
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "使い方: $0 <tag> <sig ファイル> <owner/repo>" >&2
  exit 1
fi

python3 - "$1" "$2" "$3" <<'PY'
import datetime
import json
import sys

tag, sig_file, repo = sys.argv[1:]
print(json.dumps({
    "version": tag.removeprefix("v"),
    "notes": f"cookapps {tag}",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        "darwin-aarch64": {
            # .sig は署名を base64 にした 1 行のテキスト。そのまま渡す。
            "signature": open(sig_file).read().strip(),
            "url": f"https://github.com/{repo}/releases/download/{tag}/cookapps.app.tar.gz",
        },
    },
}, indent=2))
PY
