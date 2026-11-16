#!/usr/bin/env bash
# Posts the release to X (Twitter) from the night run of ship (issue #754). The logic is x-post.py; this only runs it with `python3 -I`.
# Usage: x-post.sh auth              by the owner, in front of the Mac Studio: Client ID and Client Secret from the clipboard, consent in the browser, the three values into the keychain (service jp.mysis.tsunagiai.x)
#        x-post.sh check [file]      checks the text (file, or stdin): weighted length 280 or less (twitter-text v3), no word of public-words, exactly one URL that is the Releases page of this repository, no @
#                                    exit 0 for a pass; exit 1 with one reason per line on stderr
#        x-post.sh send [file]       check, then refresh the access token, write the new refresh token back to the keychain, and post; prints the URL of the post
#                                    exit 1 for a failed check; exit 2 for a failure of the keychain, of a token or of the post (HTTP status and error kind only on stderr)
# Wrong arguments: usage on stderr, exit 64.
# A secret (client secret, refresh token, access token, authorization code) is never printed, logged or put in an argument (publishing.md).
# This posts for real, with a charge per post: only the night run of ship calls `send`, and a session never does (issue #753).
set -euo pipefail

exec python3 -I "$(dirname "$0")/x-post.py" "$@"
