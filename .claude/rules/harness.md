# The Claude Code harness

## Where things are

### Look in `.claude/` for what guards a change

Hooks are in `.claude/hooks/`, which is tracked, and they are wired in `.claude/settings.local.json`, which is not; worktrees use the main checkout's settings, so the hooks that run are the main checkout's.
`guard-public.sh` stops forbidden public words, `post-edit.sh` runs rustfmt and `node --check` after an edit, `guard-e2e.sh` and `guard-review.sh` protect the records, and `pre-git.sh` runs the checks before a push. `session-start.sh` runs `npm ci` when `node_modules` is missing, and `post-gh.sh` keeps the milestones in step after `gh issue create`, the removal of `needs:owner` and `gh pr merge`.
`.claude/skills/` holds `discussion-judge` (decide the open Discussions and turn the decisions into issues), `improvement-proposal` (file refactoring and harness improvements, and UI/UX ones in a session, as issues or Discussions), `issue-plan` (an issue and its planned tag), `milestone-dev` (implement the first milestone) and `readme-product` (the README as a product page, and its photos).
`.claude/agents/` holds the reviewers (`code-reviewer`, `performance-reviewer`, `security-reviewer`), `release-verifier`, `release-planner`, `discussion-judge` (decides one Discussion), and the three scouts of `improvement-proposal`, `ux-scout`, `refactor-scout` and `harness-scout`.
The nightly runs (`issues.md`) are `.claude/tools/nightly.sh improvement-proposal` at 22:00, `.claude/tools/nightly.sh discussion-judge` at 23:00 and `.claude/tools/nightly.sh milestone-dev` at 00:30, each with its own lock (`.claude/nightly/{skill}.lock`) and log (`.claude/nightly/{skill}-{date}.log`, deleted after 30 days).
Around a run it uses three more tools. `nightly-limit.sh` answers whether a run may start a new issue, a judgment or a proposal candidate, or the release of a given tag (`release {tag}`, which also refuses another minor than the run has already released), `handover.sh` reads and writes the hand-over Discussion, and `discussions.sh` lists the Discussions to decide, comments on them with the mark `<!-- ai -->`, writes the waiting comment and closes them.
`plan-release.py` also prints `release-facts` (the release table's R0 to R3 and the figures of R4) and `next --mine` (the issues another session holds are left out).
`clean-target.sh` keeps `src-tauri/target` from growing with every version bump.
It runs every day at 21:00 and needs no argument.
In the main checkout and in every worktree, it deletes what has nothing modified in the last 24 hours, and nothing while cargo or rustc runs: the entries of `incremental/` in each profile, and the entries of cookapps itself (`cookapps-*`, `cookapps_lib-*`, `libcookapps_lib-*`, `cookapps_mcp-*`) in `deps/`, `build/` and `.fingerprint/`.
The output of dependency crates stays.
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
