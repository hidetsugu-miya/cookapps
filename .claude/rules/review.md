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

### Run CI and E2E on HEAD before launching the reviewers, and fix any failure first

Run `.claude/tools/run-ci.sh` (static checks and unit tests; it stops at the first failing check) and then `.claude/tools/run-e2e.sh` on the HEAD to be reviewed (`e2e.md`), and launch the reviewers only after both pass.
CI goes first, so that a fix for a type, lint, clippy or unit test failure lands before E2E runs on the code.
A fix for a CI or E2E failure changes the code the reviewers read, so their read goes stale (4 of the last 30 E2E runs failed, each fixed by a commit minutes later).
An E2E run takes about a minute (measured median 58 seconds), which is cheaper than an Opus reviewer launch.

```text
Good: commit -> run-ci.sh passes -> run-e2e.sh passes -> reviewers -> release-verifier
Bad:  commit -> reviewers -> run-ci.sh fails -> fix -> the reviewers read the old code
```

### In the first round, review the whole range to be pushed, with only the reviewers that are needed

The range is `@{u}..HEAD`, or `origin/main..HEAD` when there is no upstream.
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

The range runs from the HEAD reviewed in the previous round to the new HEAD (`{previous HEAD}..HEAD`), and E2E has passed on the new HEAD.
Always launch code-reviewer.
Launch performance-reviewer only when it has an open blocking finding.
Launch security-reviewer only when it has an open blocking finding, or when the fixing diff touches any of the conditions of the first round.
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

### Fix blocking findings inside the review, and non-blocking findings after the pass

The blocking ones are security Critical and High, performance High, and code review High.
Fix the blocking findings and send them to the next round.
Do not fix non-blocking findings (Medium and Low) during the review. This keeps the next round's range from growing.
After release-verifier passes, and before the push, fix the non-blocking findings that serve the goal of the change. Do not ask the owner.
Decline one that does not serve the goal, and state it with the reason in the completion report: nothing outside the owner's goal is done (at the owner's instruction, 2026-11-03).
When a finding has several ways to fix it, choose the recommended one and state it in the completion report.
At the owner's instruction (2026-10-29). The earlier rule "report Medium and Low after the push, and the owner decides whether to fix them" was dropped.

```text
Good: High and Low found -> fix High and run round 2 -> pass -> fix Low -> range check -> push
Bad:  High and Low found -> fix both and run round 2
Bad:  pass -> push with Low left, and ask the owner whether to fix it
```

### Do not send fixes for non-blocking findings through review

After fixing non-blocking findings, do not launch the reviewers.
Launch only release-verifier, and pass it the range (from the passed HEAD to the new HEAD) and the list of fixed findings.
release-verifier checks that the diff is only fixes for the findings on the list, and writes the pass record for the new HEAD. It does not review the content of the findings.
If a change not on the list is mixed in, it fails, and that diff goes through the first-round flow.
Put the fixes in the same pull request.
A pull request where the owner asked only for fixes to non-blocking findings (such as findings on an already merged version) also passes with only the range check. The range is `origin/main..HEAD`.
At the owner's instruction (2026-10-29). Running a review for every small fix produced too many reviews.
The check of the pass record (`pre-git.sh`) stays. The writer stays limited to release-verifier, so that the range check alone can let a change through.

```text
Good: after a1b2c3d passed, fix Low -> pass release-verifier a1b2c3d..HEAD and the list of findings -> pass record -> push
Bad:  after fixing Low, run the performance and code reviews again
Bad:  add a new feature to a Low fix and push with only the range check
```

### Keep fixes to the minimum at the finding's location

Do not rebuild things the findings do not mention, and do not make improvements on the side.
A rebuilt diff produces new findings in the second round.

## CI and E2E records

### Run CI and E2E on every HEAD before handing it to the reviewers or release-verifier

Run `.claude/tools/run-ci.sh` and `.claude/tools/run-e2e.sh` on a HEAD before you hand it to the reviewers or to release-verifier (`testing.md`, `e2e.md`).
release-verifier and `pre-git.sh` call `.claude/tools/check-ci.sh` and `.claude/tools/check-e2e.sh`, which require a passing, clean record for HEAD (`.claude/ci/{HEAD SHA}`, `.claude/e2e/{HEAD SHA}`) with the version of that commit. Without either, release-verifier fails.
Reviewers cannot confirm screen behavior by reading the diff, and `pre-git.sh` runs none of the checks, so a push is stopped when the record of HEAD is missing.

```text
Good: commit -> run-ci.sh -> run-e2e.sh -> reviewers -> fix High -> run-ci.sh -> run-e2e.sh -> second-round review -> release-verifier -> pass
Bad:  launch release-verifier without running CI or E2E
Bad:  run CI or E2E only after the reviewers, and fix its failure under them
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

The commits of the Release PR make a new HEAD. They need CI and E2E on that HEAD (the version lines change what cargo and tsc check, so the exemption below covers only the review pass record), and no release-verifier launch (an Opus launch for a mechanical check).
`pre-git.sh` takes the newest commit of the push range that has a pass record, or else the base of the range, which already passed this gate when it reached the remote, and runs `.claude/tools/release-only-diff.sh {that commit} HEAD`. `post-checks.sh` does the same from `origin/main`. The diff counts as release-only when it holds only:
- `README.md`, `CHANGELOG.md` and anything under `docs/`
- `src-tauri/Cargo.toml`, with only the `version` line of `[package]` changed (a dependency's version must not)
- `src-tauri/Cargo.lock`, with only the `version` line right after `name = "cookapps"` changed
- `src-tauri/tauri.conf.json`, with only the top-level `version` changed

Any other path, or a deleted or missing side, is offending, and the push stops with the paths listed.
A feature branch that takes in a moved main is not release-only, and it goes through the first round.
Only release-verifier still writes pass records.

```text
Good: release/next raises the version and writes CHANGELOG -> run-ci.sh -> run-e2e.sh -> push (the diff is release-only)
Bad:  a feature branch merges main with other commits in -> push without a review
Bad:  release/next raises the version -> push without run-ci.sh
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

### After pushing a version tag, watch the release through to the end before you report completion

Confirm that the `release` run of the tag succeeded and that the GitHub Release has its files.
If it failed, find the cause with `--log-failed`, fix it with the next patch version, and report that result too.
A merge with no tag starts no release, so there is nothing to watch (the workflows of a push to main, `rust-cache.yml` and `pages.yml`, may still run).

```sh
.claude/tools/watch-ci.sh             # waits for the release run of HEAD to appear and to end; on failure prints the cause log and exits non-zero
.claude/tools/watch-ci.sh {run ID}    # waits for one run only
```

```text
Good: push the tag -> confirm that the release succeeded -> report completion
Bad:  push the tag -> report completion right away
```
