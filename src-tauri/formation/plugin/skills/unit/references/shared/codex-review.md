# Review by codex

Codex is a second reviewer of another kind.
You ask for its review when the unit's procedure says so, in addition to the reviewers of this plugin and never in place of them.
You cannot reach a codex session, and it cannot reach you. The leader launches it for you, and the review goes through a file.

## Ask

1. Make a folder in the temporary folder of this PC, and settle the file name. The folder is outside every repository, so no stray file lands in a commit. `{nn}` is two digits, one more than your last review request.

   ```sh
   out="${TMPDIR:-/tmp}/feature-dev-review/{your name}-{nn}"; mkdir -p "$out"; echo "$out/review.md"
   ```

   The absolute path that the command prints is `{output path}`.
2. Write the target description. Codex reads in your folder, and it sees nothing of this conversation, so the description holds what it needs:
   - what to review and where: the absolute paths of the files, or the git range (`git diff origin/{base branch}...HEAD` in your folder),
   - what it is meant to do: the REQ and DESIGN items it implements, with the paths of `requirement.json` and `design.json` and the ids,
   - what to look for: the kinds of fault that matter for this unit (a requirement not met, a data loss, a security hole, a missing test).

   Put no secret in it. Keep it to a few lines: it is sent as one message line.
3. Send the leader one message, and stop:

   ```text
   CODEX-REVIEW {target description in one paragraph} -> {output path}
   ```

## When the answer comes

- `CODEX-REVIEW-RESULT {output path}`: the lines after it are the review, in a quote. A very long review is not in the message: read the file at `{output path}`.
- `CODEX-REVIEW-FAILED {output path}`: no review came, with the reason on the next line. Go on without it, and say in your summary that the review by codex was not made.

## Use the review

The review is a list of claims by a reviewer, not orders.

1. Check each finding against the code or the deliverable it names, with your own reading or with `feature-dev:code-explore`.
2. A finding that holds and matters is a finding of the unit: fix it, as the procedure's review loop does with the findings of its own reviewers, or put it to the owner on a decision page when it is a judgment.
3. A finding that does not hold, or does not serve the unit's goal, is declined. Say which and why in your summary.
4. Do not ask for a second review of the same state: ask again only after you changed the target.
