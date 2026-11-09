# The Claude Code harness

## Where things are

### Look in `.claude/` for what guards a change

Hooks are in `.claude/hooks/`, which is tracked, and they are wired in `.claude/settings.local.json`, which is not; worktrees use the main checkout's settings, so the hooks that run are the main checkout's.
`guard-public.sh` stops forbidden public words, `post-edit.sh` checks an edited file for forbidden public words (`guard-public.sh file`), runs rustfmt on an edited `src-tauri/**/*.rs`, and runs `tsc --noEmit` on the project (`ts` or `e2e`) of an edited `.ts` file under `ts/` or `e2e/`, or `wdio.conf.ts` (skipped when `node_modules` has no `tsc`), `guard-e2e.sh` (the CI and E2E records) and `guard-review.sh` protect the records, and `pre-git.sh` checks the records of CI, E2E and review before a push (`run-ci.sh` and `run-e2e.sh` write the first two). `session-start.sh` runs `npm ci` when `node_modules` is missing, and `post-gh.sh` tells the session to go on with `issue-plan` after `gh issue create` and the removal of `needs:owner`, and after `gh pr merge` runs `plan-release.py release` and, when it succeeds, tells the session to tag a release that is due and to prepare the Release PR (`issues.md`).
`.claude/skills/` holds `discussion-judge` (decide the open Discussions and turn the decisions into issues), `improvement-proposal` (file refactoring and harness improvements, and UI/UX ones in a session, as issues or Discussions), `issue-plan` (an issue, its place in the order, and the milestone of a feature), `milestone-dev` (implement the issues in the order of the plan, up to 10 points a night, on one branch with one pull request, and prepare the Release PR) and `readme-product` (the README as a product page, and its photos).
`.claude/agents/` holds the reviewers (`code-reviewer`, `performance-reviewer`, `security-reviewer`), `release-verifier`, `release-planner`, `discussion-judge` (decides one Discussion), and the three scouts of `improvement-proposal`, `ux-scout`, `refactor-scout` and `harness-scout`.
The nightly runs (`issues.md`) are `.claude/tools/nightly.sh improvement-proposal` at 22:00, `.claude/tools/nightly.sh discussion-judge` at 23:00 and `.claude/tools/nightly.sh milestone-dev` at 00:30, each with its own lock (`.claude/nightly/{skill}.lock`) and log (`.claude/nightly/{skill}-{date}.log`, deleted after 30 days).
Around a run it uses five more tools. `nightly-limit.sh` answers whether a run may start a new issue (`issue {n} --taken {numbers}`: the 10 points of a night, the unit rule of a point:8 issue or of the `solo` parts of one, the deadline), a judgment or a proposal candidate, `handover.sh` reads and writes the hand-over Discussion, `discussions.sh` lists the Discussions to decide, comments on them with the mark `<!-- ai -->`, writes the waiting comment and closes them, `dependabot-issues.sh` makes an issue for each open Dependabot pull request that has none (`issues.md`; `DEPENDABOT_ISSUES_DRY_RUN=1` prints without making), and `use-worktree.sh` takes the one worktree for a branch and gives it back (`worktree.md`).
`plan-release.py` prints `next --mine` (`start` is the queue in the order of the plan, and `stop` says when nothing may start), `release` (what waits for the owner's merge, the Release PR, the version it writes in `CHANGELOG.md`, `urgent`, and `tag_due`, the tag to put on the merge commit of a merged Release PR) and `close` (closes the milestones whose issues are all released).
`plan-release.py apply` leaves out the closed and the fixed issues of a plan, and saves the plan it accepted, as `.claude/plan.json` of the main checkout (gitignored, written through a temporary file), which `next` reads.
`clean-target.sh` keeps `src-tauri/target` from growing with the old output of cookapps itself.
It runs every day at 21:00 and needs no argument.
In the main checkout and in every worktree, it deletes what has nothing modified in the last 24 hours, or nothing newer than the `src-tauri/Cargo.toml` of that checkout, and nothing while cargo or rustc runs: the entries of `incremental/` in each profile, and the entries of cookapps itself (`cookapps-*`, `cookapps_lib-*`, `libcookapps_lib-*`, `cookapps_mcp-*`) in `deps/`, `build/` and `.fingerprint/`.
The second condition removes the output built before the last change of `Cargo.toml` without waiting 24 hours, because the version is fixed at `0.0.0` and `Cargo.toml` changes only with the dependencies or features, which change the hash of cookapps's own output, and nothing uses the old one again.
The output of dependency crates stays.
It also deletes the files of `.claude/ci/` and `.claude/e2e/` (the records and logs of `run-ci.sh` and `run-e2e.sh`) in the main checkout that are older than 30 days; `check-ci.sh` and `check-e2e.sh` read only the record of HEAD.
It prints the size of each target before and after, and appends it to `.claude/nightly/clean-target-{date}.log` (deleted after 30 days).
The launchd plists are `~/Library/LaunchAgents/jp.mysis.cookapps.improvement-proposal.plist`, `jp.mysis.cookapps.discussion-judge.plist`, `jp.mysis.cookapps.milestone-dev.plist` and `jp.mysis.cookapps.clean-target.plist` (21:00, running `clean-target.sh`), outside the repository. After a change to a plist, `launchctl bootout gui/$(id -u)/{label}` and `launchctl bootstrap gui/$(id -u) {plist}` load it again.
A gate that stops a command is a finding about the change, not an obstacle to route around.

```text
Good: pre-git.sh refuses the push -> read its message, and fix what it names
Bad:  pre-git.sh refuses the push -> write the record by hand
```

### Build graphify only in the main checkout, after the merge

`graphify-out/` is gitignored, so a graph built in a worktree is lost with it, and a branch's graph does not describe main.

```text
Good: merge -> fast-forward the main checkout -> update the graph there
Bad:  build the graph in a worktree and delete the worktree
```

### Write the agents and the rules in their own language

`.claude/rules/` is written in English. `.claude/agents/`, `.claude/hooks/`, `.claude/rules/`, `.claude/skills/` and `.claude/tools/` are tracked and edited on a worktree branch, and the rest of `.claude/`, with the two gitignored rules and `.claude/hooks/public-words`, is edited in the main checkout (`worktree.md`).
The hooks and the gates run the main checkout's copy of `.claude/hooks/` and `.claude/tools/`, so a change to either takes effect after the merge and the fast-forward of the main checkout.

```text
Good: change .claude/rules/review.md on the branch, and .claude/rules/machines.md in the main checkout
Bad:  change .claude/rules/machines.md in the worktree
```
