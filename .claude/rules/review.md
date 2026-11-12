# Rules for the review before a push

## Roles

### Reviewers find, release-verifier decides, and `pre-git.sh` gates

Reviewers (security, performance, code) find and rate findings, and edit nothing.
release-verifier decides whether a finding is real and whether it stops the release, checks the CI and E2E records with `check-ci.sh` and `check-e2e.sh`, and alone writes the pass record.
It reads the code for blocking findings, and for a Low only when its text suggests the definition of blocking. Other Lows pass through as report-only, and whoever fixes one confirms it then.
`pre-git.sh` is the mechanical gate: it checks the CI, E2E and pass records of HEAD, runs none of the checks itself, and never judges a finding.
Without this split, the reviewers and the verifier both checked whether a finding was fixed, and the verifier read the code for every Low.

```text
Good: a reviewer reports a finding -> release-verifier reads the code and rates it -> pre-git.sh checks the record
Bad:  the reviewer and release-verifier both check in round 2 that the same finding is fixed
```

## Flow

### Run CI first, then start E2E and the reviewers together, and launch release-verifier when both are back

Run `.claude/tools/run-ci.sh` (static checks and unit tests; it stops at the first failing check) on the HEAD to be reviewed, and fix a failure first.
CI goes first, so that a fix for a type, lint, clippy or unit test failure lands before anyone reads the code.
When CI passes, start `.claude/tools/run-e2e.sh` (in the background; `e2e.md`) and the reviewers in the same message, and launch `release-verifier` only when both have come back (at the owner's instruction, 2026-11-12; #485. It replaces "E2E passes before the reviewers start", under which the reviewers waited for E2E).
`release-verifier` checks the CI and E2E records of HEAD, so it fails on a HEAD whose E2E failed. The first round launches it all the same, to rate the reviewers' findings and to return the failure.
A failed E2E is handled as a blocking finding of the first round: find the cause (`run-e2e.sh --only {spec}` runs the failed spec alone, `e2e.md`), fix it, and put the fix into the diff of the second round with the other blocking fixes.

```text
Good: commit -> run-ci.sh passes -> run-e2e.sh (background) and the reviewers together -> release-verifier
Good: E2E fails in the first round -> release-verifier fails it -> fix with the blocking findings -> run-ci.sh -> run-e2e.sh and code-reviewer together -> release-verifier
Bad:  commit -> reviewers -> run-ci.sh fails -> fix -> the reviewers read the old code
Bad:  launch release-verifier while run-e2e.sh is still running
```

### In the first round, review the whole range to be pushed, with only the reviewers that are needed

The range is `@{u}..HEAD`, or `origin/main..HEAD` when there is no upstream. The pull request of a night run holds the commits of several issues (up to 10 points), and it is reviewed once, as one range (at the owner's instruction, 2026-11-09; Discussion #293).
Always launch performance-reviewer and code-reviewer.
Launch security-reviewer only when the diff touches any of the following.
- Authentication, tokens, the keychain
- Communication leaving the app (destinations, deciding which URLs to fetch)
- CSP, the iframe sandbox, showing the mail body
- Adding a Tauri command, and validating values received from outside

Launch the chosen reviewers in parallel in a single message, and pass their replies as they are to release-verifier.
`pre-git.sh` stops a push with no pass record for HEAD, unless only release work follows a pass record in the range or the base of the range (see "Release-only commits").
After the pass, the branch goes to main through its pull request (`issues.md`).
At the owner's instruction (2026-10-29). Running the security review every time produced too many reviews.

```text
Good: the diff is only screen wording -> two reviewers, performance and code -> release-verifier
Bad:  the diff is only screen wording -> three reviews
```

### In the second and third rounds, review only the fixed diff, with only the reviewers that are needed

The range runs from the HEAD reviewed in the previous round to the new HEAD (`{previous HEAD}..HEAD`). The fix may hold non-blocking fixes too ("Fix blocking findings inside the review…" below); the reviewers read the whole diff of the fix.
Always launch code-reviewer.
Launch performance-reviewer only when it has an open blocking finding.
Launch security-reviewer only when it has an open blocking finding, or when the fixing diff touches any of the conditions of the first round.
Run `run-ci.sh` on the new HEAD first, then `run-e2e.sh` and these reviewers together, as in the first round.
Pass the reviewers the list of blocking findings still open, so that they do not report them again. They look only for new blocking findings that the fixing diff created.
Whether an open finding is fixed is confirmed only by release-verifier, which gets the open blocking findings and the replies of this round.
When the whole range was reviewed again, fine-grained findings that had not appeared before came up new every time, and the review never ended.

```text
Good: second round -> range a1b2c3d..HEAD, code-reviewer and the one reviewer that had a High, with the list of first-round High findings attached
Bad:  second round -> review the range origin/main..HEAD from scratch
Bad:  second round -> relaunch all three reviewers to check that their findings are fixed
```

### After three rounds with a blocking finding left, redesign instead of patching

A third failure means the design is the problem, not the next line to fix (at the owner's instruction, 2026-11-03).
Stop fixing finding by finding, and do this without asking the owner:
1. Gather every finding of every round, blocking and not, and name what they have in common.
2. Redesign what they touch against the goal the owner asked for, keeping that goal as it is.
3. Implement it, and start a new cycle from the first round, with the whole range to be pushed.

After two redesigns, if the third cycle also ends its third round with a blocking finding left, stop and tell the owner what does not converge. This is the only reason to stop a review for the owner.

```text
Good: third round fails -> all findings together -> redesign -> first round on the whole range
Bad:  third round fails -> ask the owner whether to run a fourth round
Bad:  third round fails -> fix the one finding left and run a fourth round
```

### Leave product decisions to the owner, and everything else to the agents

The owner gives the requirements and accepts the result.
Design, implementation, the handling of findings and the review flow are decided by the agents, without asking.
A force push or a history rewrite still needs asking first.

## Severity

### Rate a finding by what the user loses, and let release-verifier correct the rating

The reviewers rate by the definitions in `.claude/agents/`. A code review High needs real harm in ordinary use: data lost or broken, a feature that does not work, or a requirement not met in ordinary use.
A rare input with little harm, or existing behavior this push does not make worse, is Low.
release-verifier rates again, by those definitions, each finding it read, and its rating decides whether the finding blocks. It never needs the owner for this. It gives the reason with `path:line`.
On 2026-11-03 a third round stopped for a High that was rare, small in harm and already in main, because the definition had only the kind of finding and not its harm.

```text
Good: a message over 10,000 characters is cut with no note, as main already does -> Low, fixed after the pass
Bad:  the same finding -> High, because any spec gap is High
```

## What to fix

### Fix blocking findings inside the review, and non-blocking findings with them or after the pass

The blocking ones are security Critical and High, performance High, and code review High.
When the first round fails, fix the blocking findings and, in the same fix, the non-blocking findings (Medium and Low) that serve the goal of the change, and send the fix to the next round (at the owner's instruction, 2026-11-12; #485. It replaces the instruction of 2026-10-29, "do not fix non-blocking findings during the review", which cost a second pass of the same files after the verdict).
The second-round reviewers get the whole diff of that fix, the non-blocking fixes included.
When the first round passes, nothing is sent back: after release-verifier passes, and before the push, fix the non-blocking findings that serve the goal of the change. Do not ask the owner.
A non-blocking finding that first appears in the second round or later is fixed after the pass, so that the next round's range does not grow.
Decline a finding that does not serve the goal, and state it with the reason in the completion report: nothing outside the owner's goal is done (at the owner's instruction, 2026-11-03).
When a finding has several ways to fix it, choose the recommended one and state it in the completion report.

```text
Good: High and Low found in round 1 -> fix both in one commit -> round 2 reads the whole fix -> pass -> push
Good: round 1 passes with a Low -> fix Low after the pass -> range check -> push
Good: round 2 finds a new Low -> pass -> fix Low -> range check -> push
Bad:  round 1 fails with a High and a Low, and the Low is left for after the pass
Bad:  pass -> push with Low left, and ask the owner whether to fix it
```

### Send the fixes for non-blocking findings through the next round when the round failed, and through the range check when it passed

A fix made after a pass is not sent through the reviewers.
Launch only release-verifier, and pass it the range (from the passed HEAD to the new HEAD) and the list of fixed findings.
release-verifier checks that the diff is only fixes for the findings on the list, and writes the pass record for the new HEAD. It does not review the content of the findings.
If a change not on the list is mixed in, it fails, and that diff goes through the first-round flow.
Put the fixes in the same pull request.
A pull request where the owner asked only for fixes to non-blocking findings (such as findings on an already merged version) also passes with only the range check. The range is `origin/main..HEAD`.
A fix made inside a failed round is not this: it is part of the blocking fix, and the second round reads it.
At the owner's instruction (2026-10-29). Running a review for every small fix produced too many reviews.
The check of the pass record (`pre-git.sh`) stays. The writer stays limited to release-verifier, so that the range check alone can let a change through.

```text
Good: after a1b2c3d passed, fix Low -> pass release-verifier a1b2c3d..HEAD and the list of findings -> pass record -> push
Bad:  after a pass, fix Low and run the performance and code reviews again
Bad:  add a new feature to a Low fix and push with only the range check
```

### Keep fixes to the minimum at the finding's location

Do not rebuild things the findings do not mention, and do not make improvements on the side.
A rebuilt diff produces new findings in the second round.

## CI and E2E records

### Run CI before the reviewers and E2E before release-verifier, on every HEAD

Run `.claude/tools/run-ci.sh` on a HEAD before you hand it to the reviewers, and `.claude/tools/run-e2e.sh` before you hand it to release-verifier; E2E may run while the reviewers read (`testing.md`, `e2e.md`).
release-verifier and `pre-git.sh` call `.claude/tools/check-ci.sh` and `.claude/tools/check-e2e.sh`, which require a passing, clean record for HEAD (`.claude/ci/{HEAD SHA}`, `.claude/e2e/{HEAD SHA}`) with the version of that commit. Without either, release-verifier fails.
Reviewers cannot confirm screen behavior by reading the diff, and `pre-git.sh` runs none of the checks, so a push is stopped when the record of HEAD is missing.

```text
Good: commit -> run-ci.sh -> run-e2e.sh and the reviewers together -> fix High -> run-ci.sh -> run-e2e.sh and the second-round review together -> release-verifier -> pass
Bad:  launch release-verifier without running CI or E2E
Bad:  run CI only after the reviewers, and fix its failure under them
```

### Rerun CI and E2E every time a commit is added

A commit that fixes a non-blocking finding (Medium or Low) is also a new HEAD, so rerun `run-ci.sh` and `run-e2e.sh` before handing it to release-verifier.
The records are per HEAD SHA, and the previous HEAD's record cannot be used for the new HEAD.

```text
Good: pass -> fix Low and commit -> run-ci.sh -> run-e2e.sh -> release-verifier (range check) -> push
Bad:  after a Low fix, push with the previous HEAD's CI or E2E record
```

## Release-only commits

### Let a release-only commit keep the pass

The commits of the Release PR make a new HEAD (at the owner's instruction, 2026-11-09; Discussion #293: the source holds no version, so no version line is exempt). They need CI and E2E on that HEAD (the records are per HEAD, so the exemption below covers only the review pass record), and no release-verifier launch (an Opus launch for a mechanical check).
`pre-git.sh` takes the newest commit of the push range that has a pass record, or else the base of the range, which already passed this gate when it reached the remote, and runs `.claude/tools/release-only-diff.sh {that commit} HEAD`. `post-checks.sh` does the same from `origin/main`. The diff counts as release-only when it holds only:
- `README.md`, `CHANGELOG.md` and anything under `docs/`

Any other path, or a deleted or missing side, is offending, and the push stops with the paths listed.
A feature branch that takes in a moved main is not release-only, and it goes through the first round.
Only release-verifier still writes pass records.

```text
Good: release/next writes CHANGELOG -> run-ci.sh -> run-e2e.sh -> push (the diff is release-only)
Bad:  a feature branch merges main with other commits in -> push without a review
Bad:  release/next writes CHANGELOG -> push without run-ci.sh
```

## Scope of a version

### Do not add features to a version that has entered review

Move a feature requested during the review to the next version.
When the owner decides to put it in that version, first tell them that the version's review restarts from the first round.
In v0.10.1, features kept being added during the review, and the range to read and the findings grew.

## Pass record

### Only release-verifier writes the pass record

The record is `.claude/reviews/{HEAD SHA}` in the main checkout, and `.claude/hooks/record-review.sh` writes it.
`guard-review.sh` stops anyone other than release-verifier from touching these two.

```text
Good: release-verifier calls record-review.sh
Bad:  the main agent creates a file in .claude/reviews/
```

## After the push

### After pushing a version tag or finding a merged Release PR, watch the release through to the end before you report completion

Confirm that the `release` run of the tag succeeded and that the GitHub Release has its files. The merge of the Release PR starts that run itself (`release.yml`; at the owner's instruction, 2026-11-09; #303), so the agent that finds the merge watches it too.
If it failed, find the cause with `--log-failed` and act as `issues.md` says ("After the owner merges the Release PR": rerun a failure of the runner or the network with `gh run rerun {run ID} --failed`, fix any other cause with the next patch version), and report that result too.
The merge of any other pull request starts no release, so there is nothing to watch (the workflows of a push to main, `rust-cache.yml` and `pages.yml`, may still run).

```sh
.claude/tools/watch-ci.sh             # waits for the release run of HEAD (a tagged commit) to appear and to end; on failure prints the cause log and exits non-zero
.claude/tools/watch-ci.sh {commit}    # the same for a given commit: after a merge of the Release PR, `git fetch origin main` and pass `follow_up.commit` (or `tag_due.commit`) of `plan-release.py release`, because HEAD is not its merge commit
.claude/tools/watch-ci.sh {run ID}    # waits for one run only
```

```text
Good: push the tag -> confirm that the release succeeded -> report completion
Bad:  push the tag -> report completion right away
```
