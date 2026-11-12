---
name: improvement-proposal
description: Looks for improvements to cookapps (refactoring of ts/ and src-tauri/, and the harness: hooks, skills, tools, agents; UI/UX too) and files them as issues, with `needs:owner` when the owner must decide; it implements nothing. Use on /improvement-proposal. Invoking it is the owner's instruction to file proposals, not to implement them.
---

# improvement-proposal

One run files at most 3 issues (`.claude/rules/issues.md`, "Let the proposal agent file issues, and decide what it may decide itself").
The owner starts it in a session; no job runs it (the job at 22:00 is retired, `.claude/rules/issues.md`). The night run of `ship` files one improvement of its own with a step of its own (`ship` step 3) and does not run this skill.
Never implement, push or open a pull request, and never remove `needs:owner` from an issue.

Tools are at `"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/"`.

## Scope

- Refactoring of `ts/` and `src-tauri/` (`refactor-scout`) and the harness (`harness-scout`): `.claude/hooks/` and the hook settings of `settings.local.json` (never its permissions), `.claude/skills/` with the `.claude/tools/` they run, and `.claude/agents/`.
- `ux-scout` also runs. UI and UX are a product decision, so its candidates go to the owner.
- Out of scope: new features and requirements, `docs/` and the README, versions and releases, personal settings files, launchd.
- A refactoring never changes behavior: `requirements/`, the E2E expectations and the `cargo test` expectations stay as they are.
- `.claude/rules/` changes only to fix a statement that a change in scope made wrong. An improvement of a rule itself is not a candidate.

## Steps

1. **Check the limits.** Run `gh issue list --state open --label proposal --label needs:owner --json number,title`: with 5 or more, file no `needs:owner` issue. When it may not be made, the run can still file issues the AI decides itself.
2. **Take the worktree** with `use-worktree.sh proposal/{YYYY-MM-DD-HHMMSS}` (`worktree.md`), and work in the path it prints. Temporary specs and `cargo test` run there, so the main checkout stays clean (`run-ci.sh` and `run-e2e.sh` refuse a dirty tree). On exit 3 the worktree is in use by a session's work: give the scouts the main checkout to read, and drop every candidate that needs a reproduction, because nothing may be run there.
3. **Collect what is already known.** The number and title of every open issue (`gh issue list --state open --limit 200`) and of every closed issue with the `proposal` label (`gh issue list --state closed --label proposal --limit 200`), and of every Ideas Discussion of the owner, open and closed, the hand-over Discussion excluded. The Discussions are only material for checking that a candidate has not the same purpose.
   ```sh
   nwo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"; owner="${nwo%/*}"; name="${nwo#*/}"
   gh api graphql --paginate -f query='query($o:String!,$n:String!,$endCursor:String){repository(owner:$o,name:$n){discussions(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{number title category{name} author{login}}}}}' -f o="$owner" -f n="$name" | jq -s -r --arg owner "$owner" '.[].data.repository.discussions.nodes[] | select(.category.name == "Ideas" and .author.login == $owner and .title != "自走の引き継ぎ") | "#\(.number) \(.title)"'
   ```
   Together these are the list "of existing issues, closed proposals and Discussions" for the scouts.
4. **Take photos for the UI evidence**, only when a screen is the evidence. Write a temporary spec with made-up data, the way `readme-product` does (`.claude/skills/readme-product/shots/`), run it with `npm run e2e:build` and `npm run e2e`, and delete the spec. Do not commit it. The photos stay in the scratchpad.
5. **Launch the scouts in one message:** `refactor-scout`, `harness-scout` and `ux-scout`.
   Each prompt carries the absolute worktree path, the list of step 3 and the limit of 5 candidates. `harness-scout` also gets the absolute path of `.claude/nightly/` in the main checkout (the logs are not in the worktree). `ux-scout` also gets the photo paths.
6. **Verify every candidate yourself.**
   - Drop a candidate that has the same purpose as an item of the step 3 list (an issue, a closed proposal, or a Discussion, open or closed).
   - Open each `path:line` of the evidence and confirm it says what the candidate says. Drop what does not hold. For a log or hand-over passage, read it again and confirm that the event happened at least twice.
   - A candidate that is a bug follows "File a bug only after reproducing it" (`issues.md`); if it does not reproduce, drop it.
   - Drop a candidate out of scope, and a refactoring that would change behavior.
7. **Sort the kept candidates.**
   - **Issue for the owner:** the candidate matches any of these (Discussion #160, second version), or it comes from `ux-scout`: it changes what the owner sees or uses into a form `requirements/` does not describe; it changes or removes a rule marked "at the owner's instruction"; it loosens what stops a change (hooks, `pre-git.sh`, `run-ci.sh`, the guards, the severity of the review, the rule that the owner merges the Release PR); or two or more options remain that primary sources and a prototype cannot settle.
   - **Issue decided by the AI:** every other candidate (a bug fix, a refactoring that keeps behavior, a statement that no longer matches the code or the requirements, a change that strengthens a gate). Say in the body why it fits here, with the evidence.

   Keep at most 3 issues in all, the ones that serve the owner most. Stop at 3 even if more hold. An issue for the owner is made only while step 1 allows it.
8. **File each candidate.**
   - **Issue decided by the AI:** by the steps of `issue-plan` (it also orders it), with the labels `proposal` and one `point:*` (with the reason as a one-line comment), and no `needs:owner`. Add `documentation` when it changes only documentation, `.claude/agents/`, `.claude/rules/` or `.claude/skills/`, and `adds:requirement` never. The body is plain Japanese: the problem, the evidence, the direction, and a section `## AI が決めたこと` that says what the AI decided and why it may decide it without the owner.
   - **Issue for the owner:** the labels `proposal` and `needs:owner`, one `point:*`, `adds:requirement` when it will add a requirement ID. The body is plain Japanese. It starts with `提案エージェントによる提案。採用なら needs:owner を外し、不採用なら wontfix で閉じる。`, then the problem, the evidence, the matching condition of step 7, the options with the recommended one marked, and the proposed direction. Give each option that changes nothing a clear name. When there is a choice of layout, give two options. If a photo cannot be attached, write that it was taken and what it showed.
   - A proposal that changes a screen carries a mockup, because the owner cannot choose from the text alone (at the owner's instruction, 2026-11-07). Before filing it, publish an Artifact that draws each option in the app's colors and shapes (`src/style.css`), with made-up data: start with `Artifact` `action: "quickstart"`, `intent: "other"`, then write the page and publish it. One Artifact per proposal. Put its URL in the body, under the options, as `モック: {URL}`. If the publish fails, file the proposal anyway and write in the body that there is no mockup and why.
   - Keep personal information out of every body (`publishing.md`).
9. **Give the worktree back**, without pushing: delete the temporary specs and anything else the run made, then `use-worktree.sh --park` (it also deletes the empty branch). It exits 3 when the tree is not clean: clean it, and say so in step 10 if it still does.
10. **Report to the session.** Write: the issues filed (with the reason each was left to the AI), the issues for the owner (with the condition they matched), the candidates dropped and why, what was left (the cap of 3, a scout's failure), and the number of unanswered proposals now, with the mockup URLs (or why one is missing). No personal information. Post nothing to the hand-over Discussion.

## Stop

- Both caps are reached: 3 issues in the run, and 5 open proposals with `needs:owner`, with nothing else to file.

## Not here

- Accepting an issue for the owner: the owner removes `needs:owner`, and `ship` implements it.
- Declining a proposal: the owner closes it with `wontfix`.
