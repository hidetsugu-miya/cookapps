#!/bin/sh
# Waits for a release run of GitHub Actions and exits non-zero if it failed, printing the failed log.
# Usage: watch-ci.sh [run ID | commit]  (default: the release run of HEAD)
# Pass the commit explicitly after a merge: HEAD is the merge commit of the Release PR only when nothing else has been merged or fetched since. Take it from `plan-release.py release` (`follow_up.commit`, or `tag_due.commit`) after `git fetch origin main`.
# The run of a tag is found by the tagged commit (a push run). The run of a merged Release PR (a pull_request run on release/next) has the head of release/next as its commit, which is the second parent of the merge commit.
# Every closed pull request makes a pull_request run whose jobs are skipped, so a pull_request run counts only when its `tag` job was not skipped.
# Workflows other than release.yml (Pages, Rust cache) are not waited for. A run may take a while to appear after the push.
set -u
arg="${1:-HEAD}"
case "$arg" in
  *[!0-9]*)
    sha=$(git rev-parse "$arg")
    id=""
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      id=$(gh run list --workflow release.yml --event push --commit "$sha" --json databaseId --jq '.[0].databaseId // empty')
      if [ -z "$id" ] && parent=$(git rev-parse -q --verify "$sha^2"); then
        for cand in $(gh run list --workflow release.yml --event pull_request --branch release/next --commit "$parent" --json databaseId --jq '.[].databaseId'); do
          if [ "$(gh run view "$cand" --json jobs --jq '[.jobs[] | select(.name == "tag" and .conclusion != "skipped")] | length')" != "0" ]; then
            id=$cand
            break
          fi
        done
      fi
      [ -n "$id" ] && break
      sleep 10
    done
    [ -n "$id" ] || { echo "release の run が見つかりません: ${arg}（タグを push していないか、Release PR のマージ前か、2 分待っても現れません）" >&2; exit 1; }
    ;;
  *) id="$arg" ;;
esac
# `gh run watch` can fail while the run is still going, so only the finished run's conclusion decides.
until [ "$(gh run view "$id" --json status --jq .status 2>/dev/null)" = "completed" ]; do sleep 20; done
name=$(gh run view "$id" --json name,headBranch --jq '"\(.name) \(.headBranch)"')
if [ "$(gh run view "$id" --json conclusion --jq .conclusion)" = "success" ]; then
  echo "成功: $name ($id)"
  exit 0
fi
echo "失敗: $name ($id)"
gh run view "$id" --log-failed
exit 1
