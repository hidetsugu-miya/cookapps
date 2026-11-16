#!/usr/bin/env bash
# Posts the release to X (Twitter) from the night run of ship (issue #754). The logic is x-post.py; this only runs it with `python3 -I`.
# Usage: x-post.sh auth              by the owner, in front of the Mac Studio: Client ID and Client Secret from the secret item, consent in the browser (the URL is printed too), the refresh token into the keychain
#        x-post.sh check [file]      checks the text (file, or stdin): weighted length 280 or less (twitter-text v3), no word of public-words, exactly one URL that is the Releases page of this repository, no @
#                                    exit 0 for a pass; exit 1 with one reason per line on stderr
#        x-post.sh send file tag     tag is v0.{minor}.{patch}, the last version of the text. Refuses (exit 1, before any network) a tag that is not newer than the one in .claude/x-posted of the main checkout,
#                                    and a night run (NIGHTLY_DEADLINE_EPOCH set) when that file is missing. Then check, refresh the access token, write the new refresh token back to the keychain, and post;
#                                    prints the URL of the post, and writes tag into .claude/x-posted (through a temporary file and mv)
#                                    exit 1 for a refused tag or a failed check; exit 2 for a failure of the settings, of the secret item, of the keychain, of a token or of the post, or when the post was made and .claude/x-posted could not be written (HTTP status and error kind only on stderr)
#                                    exit 3 when the post got no answer: it may have been made, so tag is written into .claude/x-posted, and the post is not sent again; check X
# Wrong arguments: usage on stderr, exit 64.
# Client ID and Client Secret are only in the secret item, which `op` reads with a service account (read only is enough). The refresh token, which X replaces at every use, is only in the keychain (service jp.mysis.tsunagiai.x).
# The secret item, the vault and where the service account token is kept are in .claude/x-post.json of the main checkout (gitignored); exit 2 without it, before any network.
# A secret (service account token, client secret, refresh token, access token, authorization code) is never printed, logged or put in an argument (publishing.md).
# This posts for real, with a charge per post: only the night run of ship calls `send`, and a session never does (issue #753).
# The first post, while .claude/x-posted is missing, is sent by the owner by hand in a terminal: x-post.sh send file tag.
set -euo pipefail

exec python3 -I "$(dirname "$0")/x-post.py" "$@"
