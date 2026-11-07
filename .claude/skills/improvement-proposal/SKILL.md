---
name: improvement-proposal
description: Looks for UI/UX and internal refactoring improvements to cookapps and files them as issues for the owner to accept or decline; it implements nothing. Use on /improvement-proposal. Invoking it is the owner's instruction to file proposals, not to implement them.
---

# improvement-proposal

One run files at most 3 proposals, as issues. The owner decides each one (`.claude/rules/issues.md`, "Let the proposal agent file issues, and let only the owner accept them").
The owner starts it in a session; nothing else starts it.
Never remove `needs:owner`, implement, push or open a pull request.

Tools are at `"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/"`.

## Steps

1. **Check the open proposals.** Run `gh issue list --state open --label proposal --label needs:owner --json number,title`. With 5 or more, file nothing: report the count and stop.
2. **Make a worktree** with `new-worktree.sh proposal/{YYYY-MM-DD-HHMMSS}` (`worktree.md`), and work in the path it prints. Temporary specs and `cargo test` run there, so the main checkout stays clean (`run-e2e.sh` refuses a dirty tree at 05:00).
3. **Collect what is already known.** The number and title of every open issue (`gh issue list --state open --limit 200`) and of every closed issue with the `proposal` label (`gh issue list --state closed --label proposal --limit 200`). This is the list "of existing issues and closed proposals" for the scouts.
4. **Take photos for the UI evidence**, only when a screen is the evidence. Write a temporary spec with made-up data, the way `readme-product` does (`.claude/skills/readme-product/shots/`), run it with `npm run e2e:build` and `npm run e2e`, and delete the spec. Do not commit it. The photos stay in the scratchpad.
5. **Launch `ux-scout` and `refactor-scout` in one message.** Each prompt carries: the absolute worktree path, the list of step 3, the photo paths for `ux-scout`, and the limit of 5 candidates.
6. **Verify every candidate yourself.**
   - Drop a candidate that has the same purpose as an item of the step 3 list.
   - Open each `path:line` of the evidence and confirm it says what the candidate says. Drop what does not hold.
   - A candidate that is a bug follows "File a bug only after reproducing it" (`issues.md`); if it does not reproduce, drop it.
   - Keep at most 3, the ones that serve the owner most. Stop at 3 even if more hold.
7. **File each kept candidate** by the steps of `issue-plan` (it also orders them). Labels:
   - `proposal` and `needs:owner`, always
   - one `point:*` (`point:1`, `point:2`, `point:3`, `point:5` or `point:8`), with the reason as a one-line comment
   - `adds:requirement` when it will add a requirement ID, `documentation` when it changes only documentation, `.claude/agents/`, `.claude/rules/` or `.claude/skills/`

   The body is plain Japanese. It starts with `提案エージェントによる提案。採用なら needs:owner を外し、不採用なら wontfix で閉じる。`, then the problem, the evidence, and the proposed direction. When there is a choice of layout, give two options. If a photo cannot be attached to the issue, write that it was taken and what it showed. Keep personal information out (`publishing.md`).

   A proposal that changes a screen carries a mockup, because the owner cannot choose from the text alone (at the owner's instruction, 2026-11-07). Before filing it, publish an Artifact that draws each option in the app's colors and shapes (`src/style.css`), with made-up data: start with `Artifact` `action: "quickstart"`, `intent: "other"`, then write the page and publish it. One Artifact per proposal. Put its URL in the body, under the options, as `モック: {URL}`. If the publish fails, file the proposal anyway and write in the body that there is no mockup and why.
8. **Remove the worktree and the branch**, without pushing: `git worktree remove` without `--force`, then `git branch -D proposal/{YYYY-MM-DD-HHMMSS}`.
9. **Report** the issues filed with their mockup URLs (or why one is missing), the candidates dropped and why, and the number of unanswered proposals now.

## Not here

- Accepting a proposal: the owner removes `needs:owner`, and `milestone-dev` implements it.
- Declining one: the owner closes it with `wontfix`.
