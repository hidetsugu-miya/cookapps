# The Claude Code harness

## Where things are

### Look in `.claude/` for what guards a change

Hooks are configured in `.claude/settings.local.json`, and worktrees use the main checkout's.
`guard-public.sh` stops forbidden public words, `post-edit.sh` runs rustfmt and `node --check` after an edit, `guard-e2e.sh` and `guard-review.sh` protect the records, and `pre-git.sh` runs the checks before a push. `session-start.sh` runs `npm ci` when `node_modules` is missing, and `post-gh.sh` keeps the milestones in step after `gh issue create`, the removal of `needs:owner` and `gh pr merge`.
`.claude/skills/` holds `improvement-proposal` (file UI/UX and refactoring proposals as issues), `issue-plan` (an issue and its planned tag), `milestone-dev` (implement the first milestone) and `readme-product` (the README as a product page, and its photos).
`.claude/agents/` holds the reviewers (`code-reviewer`, `performance-reviewer`, `security-reviewer`), `release-verifier`, `release-planner`, and the two scouts of `improvement-proposal`, `ux-scout` and `refactor-scout`.
The nightly runs (`issues.md`) are `.claude/tools/nightly.sh {skill}`: `milestone-dev` at 01:00 and `improvement-proposal` at 22:00, each with its own lock (`.claude/nightly/{skill}.lock`) and log (`.claude/nightly/{skill}-{date}.log`, deleted after 30 days).
After each run it calls `.claude/tools/proposal-reminder.sh`, which writes the unanswered proposals between the `proposal-reminder` markers of `CLAUDE.local.md` in the main checkout.
Around a run it uses three more tools. `notify.sh` sends the Pushover messages (only from 09:00 to 20:00; the rest wait in `.claude/nightly/pushover-queue`), `nightly-limit.sh` answers whether a run may start a new issue or a release, and `handover.sh` reads and writes the hand-over Discussion.
`plan-release.py` also prints `release-facts` (the release table's R0 to R3 and the figures of R4) and `next --mine` (the issues another session holds are left out).
The launchd plists are `~/Library/LaunchAgents/jp.mysis.cookapps.milestone-dev.plist`, `jp.mysis.cookapps.improvement-proposal.plist` and `jp.mysis.cookapps.notify-flush.plist` (`notify.sh flush` at 09:00, so that the night's queued messages go out), outside the repository. After a change to a plist, `launchctl bootout gui/$(id -u)/{label}` and `launchctl bootstrap gui/$(id -u) {plist}` load it again.
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

`.claude/rules/` is written in English. `.claude/agents/`, `.claude/rules/` and `.claude/tools/` are tracked and edited on a worktree branch, and the rest of `.claude/`, with the two gitignored rules, is edited in the main checkout (`worktree.md`).
The hooks and the gates run the main checkout's copy of `.claude/tools/`, so a change to it takes effect after the merge and the fast-forward of the main checkout.

```text
Good: change .claude/rules/review.md on the branch, and .claude/rules/machines.md in the main checkout
Bad:  change .claude/rules/machines.md in the worktree
```
