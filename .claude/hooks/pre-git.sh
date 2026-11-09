#!/usr/bin/env bash
# PreToolUse(Bash): commit/tag は公開禁止語の検査、push はさらに CI・E2E・レビューの合格記録を確かめる（CI と E2E の検査そのものは走らせない。CI は run-ci.sh、E2E は run-e2e.sh が回す）。
# push の範囲が guard-e2e.sh か plan-release*.py、この hook に触れるときだけ、その自己テストをこの checkout の写しで走らせる。
# 検査する checkout は hook 入力の cwd（git に -C があればその場所）の checkout で、CLAUDE_PROJECT_DIR ではない（#310）。記録の置き場所だけは --git-common-dir の main の checkout。
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/hook-log.sh"
hook_log_begin
input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<< "$input")
cwd=$(jq -r '.cwd // empty' <<< "$input")
g='git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+'
grep -q -E "${g}(commit|tag|push)|git-commit-run[[:space:]]+commit" <<< "$cmd" || exit 0

guard="$(cd "$(dirname "$0")" && pwd)/guard-public.sh"
[ -n "$cwd" ] || cwd="${CLAUDE_PROJECT_DIR:-$PWD}"
if [[ $cmd =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+)[[:space:]]+(commit|tag|push) ]]; then
  dir=${BASH_REMATCH[1]//[\"\']/}
  case "$dir" in /*) cwd=$dir ;; *) cwd="$cwd/$dir" ;; esac
fi
top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) \
  || top=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$top" || exit 0

# gate <名前> <コマンド...>: 失敗したら名前と出力末尾 40 行を出して exit 2。名前と所要時間はログに残す（hook-log.sh）。
gate() {
  local name=$1 out rc t; shift
  t=$(hook_log_now)
  out=$("$@" 2>&1); rc=$?
  hook_log_gate "$name" "$t" "$rc"
  [ "$rc" -eq 0 ] || { echo "ゲート失敗: $name"$'\n'"$(tail -n 40 <<< "$out")" >&2; exit 2; }
}

grep -q -E "${g}(commit|tag)|git-commit-run[[:space:]]+commit" <<< "$cmd" \
  && gate "公開禁止語(コマンド文)" bash -c '"$0" text <<< "$1"' "$guard" "$cmd"
gate "公開禁止語(ツリー)" "$guard" tree

if grep -q -E "${g}push" <<< "$cmd"; then
  range='@{u}..HEAD'
  git rev-parse -q --verify '@{u}' >/dev/null 2>&1 || range='origin/main..HEAD'
  git rev-parse -q --verify "${range%..*}" >/dev/null 2>&1 \
    && gate "公開禁止語(コミットメッセージ $range)" "$guard" log "$range"
  # The records are of HEAD's commit, so the working tree must equal the commits being pushed.
  git diff --quiet HEAD || { echo "push 前の検査: コミットしていない変更があります。検査はコミットの中身と一致しません" >&2; git diff --stat HEAD >&2; exit 2; }
  # The self-tests of a hook and of a tool run on this checkout's own copy, and only when the range touches what they test (#255).
  # With no base to compare, they run.
  if git rev-parse -q --verify "${range%..*}" >/dev/null 2>&1; then
    changed=$(git diff --name-only "${range%..*}" HEAD)
  else
    changed=$(git ls-files)
  fi
  grep -q -E '^\.claude/(hooks/(guard-e2e|hook-log)\.sh|tools/check-guard-e2e\.sh)$' <<< "$changed" \
    && gate "guard-e2e.sh の自己テスト" "$top/.claude/tools/check-guard-e2e.sh"
  grep -q -E '^\.claude/(hooks/(pre-git|hook-log)\.sh|tools/check-pre-git\.sh)$' <<< "$changed" \
    && gate "pre-git.sh の自己テスト" "$top/.claude/tools/check-pre-git.sh"
  grep -q -E '^\.claude/tools/plan-release[^/]*\.py$|^\.claude/(tools/(nightly-limit|use-worktree)\.sh|hooks/post-gh\.sh)$' <<< "$changed" \
    && gate "plan-release.py の自己テスト" python3 -I "$top/.claude/tools/plan-release-test.py"
  # New commits need run-ci.sh's and run-e2e.sh's passing records for HEAD and release-verifier's pass record (.claude/rules/review.md).
  # The CI and E2E records are needed on a release-only HEAD too: the records are per HEAD.
  # A push with no new commit (a tag on a commit already on the remote) needs none of them.
  # Only release-verifier's pass record may be on an earlier commit of the range when only the release work (README, CHANGELOG, docs) comes after it.
  if ! git rev-parse -q --verify "${range%..*}" >/dev/null 2>&1 || [ -n "$(git rev-list -n 1 "$range")" ]; then
    main="$(git rev-parse --path-format=absolute --git-common-dir)/.."
    gate "CI" "$main/.claude/tools/check-ci.sh"
    gate "E2E" "$main/.claude/tools/check-e2e.sh"
    if [ ! -f "$main/.claude/reviews/$(git rev-parse HEAD)" ]; then
      base=""
      for c in $(git rev-list "$range" 2>/dev/null); do
        [ -f "$main/.claude/reviews/$c" ] && { base=$c; break; }
      done
      # The range base is already on the remote, so it passed this gate: release work on top of it (a Release PR) needs no record of its own.
      [ -n "$base" ] || base="${range%..*}"
      offending=""
      if [ -n "$base" ]; then
        offending=$("$main/.claude/tools/release-only-diff.sh" "$base" HEAD 2>&1) && offending="ok"
      fi
      if [ "$offending" != ok ]; then
        msg="ゲート失敗: レビュー"$'\n'"HEAD $(git rev-parse --short HEAD) の合格記録がありません。.claude/rules/review.md の手順で $range をレビューしてください"
        [ -n "$offending" ] && msg+=$'\n'"${base:0:7} から HEAD までに、リリース作業の外の変更があります:"$'\n'"$offending"
        echo "$msg" >&2
        exit 2
      fi
    fi
  fi
fi
exit 0
