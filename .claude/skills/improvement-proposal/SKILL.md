---
name: improvement-proposal
description: Looks for improvements to cookapps (refactoring of ts/ and src-tauri/, and the harness: hooks, skills, tools, agents; UI/UX only in a session) and files them as issues, or as a Discussion when it is unsure; it implements nothing. Use on /improvement-proposal. Invoking it is the owner's instruction to file proposals, not to implement them.
---

# improvement-proposal

One run files at most 3 issues (`.claude/rules/issues.md`, "Let the proposal agent file issues, and decide what it may decide itself").
The owner starts it in a session, or through the job the owner registered, which runs `.claude/tools/nightly.sh improvement-proposal` at 00:00 only; nothing else starts it.
A run from that job has no one to answer: never wait on the owner, and end with the result of step 11.
`NIGHTLY_DEADLINE_EPOCH` is set in such a run (02:30), and in no session. The limit below applies only when it is set; the script `nightly-limit.sh` knows it.
Never implement, push or open a pull request, and never remove `needs:owner` from an issue.

Tools are at `"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/"`.

## Scope

- In the job: refactoring of `ts/` and `src-tauri/` (`refactor-scout`) and the harness (`harness-scout`): `.claude/hooks/` and the hook settings of `settings.local.json` (never its permissions), `.claude/skills/` with the `.claude/tools/` they run, and `.claude/agents/`.
- In a session, `ux-scout` also runs. UI and UX are a product decision, so they are never filed by the job.
- Out of scope: new features and requirements, `docs/` and the README, versions and releases, personal settings files, launchd.
- A refactoring never changes behavior: `requirements/`, the E2E expectations and the `cargo test` expectations stay as they are.
- `.claude/rules/` changes only to fix a statement that a change in scope made wrong. An improvement of a rule itself is not a candidate.

## Steps

1. **Check the limits.** Run `gh issue list --state open --label proposal --label needs:owner --json number,title`: with 5 or more, file no `needs:owner` issue (only a session's `ux-scout` makes them). Count the open Ideas Discussions of the owner, the hand-over Discussion excluded:
   ```sh
   nwo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"; owner="${nwo%/*}"; name="${nwo#*/}"
   gh api graphql --paginate -f query='query($o:String!,$n:String!,$endCursor:String){repository(owner:$o,name:$n){discussions(first:100,after:$endCursor,states:OPEN){nodes{title category{name} author{login}}}}}' -f o="$owner" -f n="$name" | jq -s --arg owner "$owner" '[.[].data.repository.discussions.nodes[] | select(.category.name == "Ideas" and .author.login == $owner and .title != "自走の引き継ぎ")] | length'
   ```
   With 5 or more, make no new Discussion. When neither kind may be made, the run can still file issues the AI decides itself.
2. **Make a worktree** with `new-worktree.sh proposal/{YYYY-MM-DD-HHMMSS}` (`worktree.md`), and work in the path it prints. Temporary specs and `cargo test` run there, so the main checkout stays clean (`run-e2e.sh` refuses a dirty tree at 05:00).
3. **Collect what is already known.** The number and title of every open issue (`gh issue list --state open --limit 200`) and of every closed issue with the `proposal` label (`gh issue list --state closed --label proposal --limit 200`). This is the list "of existing issues and closed proposals" for the scouts.
4. **Take photos for the UI evidence**, in a session and only when a screen is the evidence. Write a temporary spec with made-up data, the way `readme-product` does (`.claude/skills/readme-product/shots/`), run it with `npm run e2e:build` and `npm run e2e`, and delete the spec. Do not commit it. The photos stay in the scratchpad.
5. **Launch the scouts in one message.** In the job: `refactor-scout` and `harness-scout`. In a session: those two and `ux-scout`.
   Each prompt carries the absolute worktree path, the list of step 3 and the limit of 5 candidates. `harness-scout` also gets the absolute path of `.claude/nightly/` in the main checkout (the logs are not in the worktree). `ux-scout` also gets the photo paths.
6. **Verify every candidate yourself.**
   - Drop a candidate that has the same purpose as an item of the step 3 list.
   - Open each `path:line` of the evidence and confirm it says what the candidate says. Drop what does not hold. For a log or hand-over passage, read it again and confirm that the event happened at least twice.
   - A candidate that is a bug follows "File a bug only after reproducing it" (`issues.md`); if it does not reproduce, drop it.
   - Drop a candidate out of scope, and a refactoring that would change behavior.
7. **Sort the kept candidates.** In the job, a candidate that comes from `ux-scout` does not exist. For the others:
   - **Discussion:** the candidate matches any of these (Discussion #160, second version): it changes what the owner sees or uses into a form `requirements/` does not describe; it changes or removes a rule marked "at the owner's instruction"; it loosens what stops a change (hooks, `pre-git.sh`, the guards, the severity of the review, the release table); or two or more options remain that primary sources and a prototype cannot settle.
   - **Issue decided by the AI:** every other candidate (a bug fix, a refactoring that keeps behavior, a statement that no longer matches the code or the requirements, a change that strengthens a gate). Say in the body why it fits here, with the evidence.
   - **Issue for the owner:** a candidate of `ux-scout`, as always.

   Keep at most 3 issues in all, the ones that serve the owner most. Stop at 3 even if more hold. A Discussion counts as none of the 3; make at most as many as step 1 allows (up to 5 open at once).
8. **Start no new candidate after the limit.** Before each new issue or Discussion, run `nightly-limit.sh proposal`: on exit 1, make no more, and list the rest in step 11 as left for the next run. A candidate already begun is finished.
9. **File each candidate.**
   - **Issue decided by the AI:** by the steps of `issue-plan` (it also orders it), with the labels `proposal` and one `point:*` (with the reason as a one-line comment), and no `needs:owner`. Add `documentation` when it changes only documentation, `.claude/agents/`, `.claude/rules/` or `.claude/skills/`, and `adds:requirement` never. The body is plain Japanese: the problem, the evidence, the direction, and a section `## AI が決めたこと` that says what the AI decided and why it may decide it without the owner.
   - **Discussion:** in Ideas, in the form of Discussion #108 (`issues.md`, "Record a design or layout discussion"): what the record is for, the background, what was investigated, the options and the recommendation. The first line of the body is `<!-- ai -->`. Create it as `handover.sh` does (`createDiscussion` with the repository id and the id of the Ideas category, `-F b=@{file}` for the body). `discussion-judge` decides it at 03:00 once `discussions.sh list` picks it up (the owner commented, or its mark is 3 days old). Give each option that changes nothing a clear name, and mark the recommended one. Name the matching condition of step 7 in the body.
   - **Issue for the owner** (session only): the labels `proposal` and `needs:owner`, one `point:*`, `adds:requirement` when it will add a requirement ID. The body is plain Japanese. It starts with `提案エージェントによる提案。採用なら needs:owner を外し、不採用なら wontfix で閉じる。`, then the problem, the evidence, and the proposed direction. When there is a choice of layout, give two options. If a photo cannot be attached, write that it was taken and what it showed.
   - A proposal that changes a screen carries a mockup, because the owner cannot choose from the text alone (at the owner's instruction, 2026-11-07). Before filing it, publish an Artifact that draws each option in the app's colors and shapes (`src/style.css`), with made-up data: start with `Artifact` `action: "quickstart"`, `intent: "other"`, then write the page and publish it. One Artifact per proposal. Put its URL in the body, under the options, as `モック: {URL}`. If the publish fails, file the proposal anyway and write in the body that there is no mockup and why.
   - Keep personal information out of every body (`publishing.md`).
10. **Remove the worktree and the branch**, without pushing: `git worktree remove` without `--force`, then `git branch -D proposal/{YYYY-MM-DD-HHMMSS}`.
11. **Report the result on the hand-over Discussion.** Write to a file in the scratchpad, and post it with `handover.sh note {file}`: it puts `<!-- ai -->` on the first line and no hand-over mark, so the 05:00 run reads it neither as a hand-over nor as a reply of the owner. Write: the issues filed (with the reason each was left to the AI), the Discussions made (with the condition they matched), the candidates dropped and why, what was left for the next run (the limit, the cap of 3, a scout's failure), and the number of unanswered proposals and open Discussions now. No personal information. Then report the same to the session or the log, with the mockup URLs (or why one is missing).

## Stop

- Both caps are reached: 3 issues in the run, and 5 open Discussions, with nothing else to file.
- The run's limit: `nightly-limit.sh proposal` says no. The process is never killed; the run finishes steps 10 and 11.

## Not here

- Accepting an issue for the owner: the owner removes `needs:owner`, and `milestone-dev` implements it.
- Declining a proposal: the owner closes it with `wontfix`.
- Deciding a Discussion: `discussion-judge` does, at 03:00.
