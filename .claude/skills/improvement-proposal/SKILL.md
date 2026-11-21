---
name: improvement-proposal
description: Looks for improvements to つなぎAI (refactoring of ts/ and src-tauri/, and the harness: hooks, skills, tools, agents; UI/UX too) and files the ones the AI may decide as issues and puts the ones the owner must decide to the owner in the session; it implements nothing. Use on /improvement-proposal. Invoking it is the owner's instruction to file proposals, not to implement them.
---

# improvement-proposal

One run files at most 3 issues ("Let the proposal agent file issues in a session, and decide what it may decide itself" in "Rules" at the end of this file).
The owner starts it in a session; no job runs it (the job at 22:00 is retired, "Rules" at the end of this file).
Never implement, push or open a pull request.

Tools are at `"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/"`.

## Scope

- Refactoring of `ts/` and `src-tauri/` (`refactor-scout`) and the harness (`harness-scout`): `.claude/hooks/` and the hook settings of `settings.local.json` (never its permissions), `.claude/skills/` with the `.claude/tools/` they run, and `.claude/agents/`.
- `ux-scout` also runs. UI and UX are a product decision, so its candidates go to the owner.
- Out of scope: new features and requirements, `docs/` and the README, versions and releases, personal settings files, launchd.
- A refactoring never changes behavior: `requirements/`, the E2E expectations and the `cargo test` expectations stay as they are.
- `.claude/rules/` changes only to fix a statement that a change in scope made wrong. An improvement of a rule itself is not a candidate.

## Steps

1. **Settle the limit.** A run keeps at most 3 candidates (step 7). No count of open proposals limits it: a candidate for the owner is not filed until the owner has decided it (steps 8 and 10).
2. **Take the worktree** with `use-worktree.sh proposal/{YYYY-MM-DD-HHMMSS}` (`worktree.md`), and work in the path it prints. Temporary specs and `cargo test` run there, so the main checkout stays clean (`run-ci.sh` and `run-e2e.sh` refuse a dirty tree). On exit 3 the worktree cannot be taken: give the scouts the main checkout to read, and drop every candidate that needs a reproduction, because nothing may be run there.
3. **Collect what is already known.** The number and title of every open issue (`gh issue list --state open --limit 200`) and of every closed issue with the `proposal` label (`gh issue list --state closed --label proposal --limit 200`), and of every Ideas Discussion of the owner, open and closed. The Discussions are only material for checking that a candidate has not the same purpose.
   ```sh
   nwo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"; owner="${nwo%/*}"; name="${nwo#*/}"
   gh api graphql --paginate -f query='query($o:String!,$n:String!,$endCursor:String){repository(owner:$o,name:$n){discussions(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{number title category{name} author{login}}}}}' -f o="$owner" -f n="$name" | jq -s -r --arg owner "$owner" '.[].data.repository.discussions.nodes[] | select(.category.name == "Ideas" and .author.login == $owner) | "#\(.number) \(.title)"'
   ```
   Together these are the list "of existing issues, closed proposals and Discussions" for the scouts.
4. **Take photos for the UI evidence**, only when a screen is the evidence. Write a temporary spec with made-up data, the way `readme-product` does (`.claude/skills/readme-product/shots/`), run it with `npm run e2e:build` and `npm run e2e`, and delete the spec. Do not commit it. The photos stay in the scratchpad.
5. **Launch the scouts in one message:** `refactor-scout`, `harness-scout` and `ux-scout`.
   Each prompt carries the absolute worktree path, the list of step 3 and the limit of 5 candidates. `harness-scout` also gets the absolute path of `logs/` (the hook logs) in the main checkout (the logs are not in the worktree). `ux-scout` also gets the photo paths.
6. **Verify every candidate yourself.**
   - Drop a candidate that has the same purpose as an item of the step 3 list (an issue, a closed proposal, or a Discussion, open or closed).
   - Open each `path:line` of the evidence and confirm it says what the candidate says. Drop what does not hold. For a log passage, read it again and confirm that the event happened at least twice.
   - A candidate that is a bug follows "File a bug only after reproducing it" (`issues.md`); if it does not reproduce, drop it.
   - Drop a candidate out of scope, and a refactoring that would change behavior.
7. **Sort the kept candidates.**
   - **Candidate for the owner:** the candidate matches any of these (Discussion #160, second version), or it comes from `ux-scout`: it changes what the owner sees or uses into a form `requirements/` does not describe; it changes or removes a rule marked "at the owner's instruction"; it loosens what stops a change (hooks, `pre-git.sh`, `run-ci.sh`, the guards, the severity of the review, the rule of who merges the Release PR); or two or more options remain that primary sources and a prototype cannot settle.
   - **Issue decided by the AI:** every other candidate (a bug fix, a refactoring that keeps behavior, a statement that no longer matches the code or the requirements, a change that strengthens a gate). Say in the body why it fits here, with the evidence.

   Keep at most 3 candidates in all, the ones that serve the owner most. Stop at 3 even if more hold.
8. **File each candidate.**
   - **Issue decided by the AI:** by steps 1 to 4 of `issue-plan` (it is implemented when the owner names it to `implement`), with the labels `proposal` and one `point:*` (with the reason as a one-line comment). Add `documentation` when it changes only documentation, `.claude/agents/`, `.claude/rules/` or `.claude/skills/`, and `adds:requirement` never. The body is plain Japanese: the problem, the evidence, the direction, the plan (the files to touch, and the order), and a section `## AI が決めたこと` that says what the AI decided and why it may decide it without the owner. Follow the scope of the gate of `issue-plan` step 2 (`issues.md`, "Make an issue only once…"; decided by the agent, 2026-11-21, at the owner's leave; #1207): a refactoring of `ts/` or `src-tauri/` also gets a prototype, an Artifact of the verification result that the AI accepts in the owner's place, with its URL in the body as `プロトタイプ: {URL}`; a bug whose correct behavior a requirement already states, and a change of `.claude/` or the tools only, get no prototype.
   - **Candidate for the owner:** file no issue. Put it to the owner in the session, in step 10, and file it only when the owner has decided it (at the owner's instruction, 2026-11-19; #1035). Prepare for the owner the problem, the evidence, the matching condition of step 7, the options with the recommended one marked, and the proposed direction. Give each option that changes nothing a clear name. When there is a choice of layout, give two options. If a photo cannot be attached, write that it was taken and what it showed. Once the owner has decided, and has accepted the prototype of the decided option (the mockup for a screen, an Artifact of the verification result otherwise), with the code verified and the plan set (`issue-plan` step 2), file it by steps 1 to 4 of `issue-plan` with the labels `proposal` and one `point:*` (with the reason as a one-line comment), and `adds:requirement` when it will add a requirement ID. The body is plain Japanese: the problem, the evidence, the options, the decision, the plan and the URL of the prototype. When the owner declines it, file nothing.
   - A candidate for the owner that changes a screen carries a mockup, because the owner cannot choose from the text alone (at the owner's instruction, 2026-11-07). Before putting it to the owner, publish an Artifact that draws each option in the app's colors and shapes (`src/style.css`), with made-up data: start with `Artifact` `action: "quickstart"`, `intent: "other"`, then write the page and publish it. One Artifact per candidate. Give the owner its URL, and put it in the issue body, under the options, as `モック: {URL}` when the issue is filed. If the publish fails, put the candidate anyway and say that there is no mockup and why.
   - Keep personal information out of every body (`publishing.md`).
9. **Give the worktree back**, without pushing: delete the temporary specs and anything else the run made, then `use-worktree.sh --park` from inside the worktree (it removes the worktree and also deletes the empty branch). It exits 3 when the tree is not clean: clean it, and say so in step 10 if it still does.
10. **Report to the session.** Write: the issues filed (with the reason each was left to the AI), the candidates for the owner, put to the owner here (with the condition each matched, its options, the recommended one and the mockup URL, or why one is missing), the candidates dropped and why, and what was left (the cap of 3, a scout's failure). When the owner decides a candidate in the session, file it as step 8 says. No personal information in an issue.

## Stop

- The cap is reached: 3 candidates in the run, with nothing else to keep.

## Not here

- Deciding a candidate for the owner: the owner does it in the session, and the run files only what was decided (step 8). A candidate the owner declines is not filed.

## Rules

### Let the proposal agent file issues in a session, and decide what it may decide itself

`improvement-proposal` looks for improvements and files them as issues. The owner runs it in a session; no job runs it any more. The job at 22:00 (`nightly.sh improvement-proposal`) is retired (at the owner's instruction, 2026-11-12; #485).
It uses `refactor-scout` and `harness-scout`. Its scope is refactoring of `ts/` and `src-tauri/` that keeps behavior (`requirements/`, the E2E expectations and the `cargo test` expectations stay as they are), and the harness: hooks (not the permissions of `settings.local.json`), skills with the tools they run, and agents. UI and UX, new features and requirements, `docs/` and the README, versions and releases, personal settings and launchd are out of scope. `.claude/rules/` changes only to fix a statement that a change in scope made wrong.
`ux-scout` runs only in a session, because UI and UX are a product decision.
It only creates issues. It never implements or opens a pull request.
The agents make no Discussion and read none to decide anything (at the owner's instruction, 2026-11-09); `improvement-proposal` reads the owner's older Ideas Discussions only to check that a proposal does not have the same purpose.
The run reports to the session that started it.
Give every proposal `proposal`, because its author is the owner's own account and cannot tell it from an issue the owner wrote.
A candidate that `ux-scout` found goes to the owner: it is put to the owner in the session, with the problem, the evidence and the options, and filed as an issue only after the owner has decided it (at the owner's instruction, 2026-11-19; #1035: it replaces the issue with a label for the owner that was made when the proposal was filed, of 2026-11-09, which replaced a Discussion as the place to decide).
A candidate that the AI may decide (a bug fix, a refactoring that keeps behavior, a statement that no longer matches the code or the requirements, a change that strengthens a gate) is an issue through `issue-plan`, and its body has a section `AI が決めたこと` that gives the reason. `implement` implements it like any issue, once the owner names it.
A candidate that matches any of these goes to the owner as well, in the session, with the options and the evidence, and the recommended option marked:
- It changes what the owner sees or uses into a form `requirements/` does not describe.
- It changes or removes a rule marked "at the owner's instruction".
- It loosens what stops a change (hooks, `pre-git.sh`, `run-ci.sh`, the guards, the severity of the review, the rule of who merges the Release PR).
- Two or more options remain that primary sources and a prototype cannot settle.

Keep at most 3 candidates in a run.
Do not file or put to the owner a proposal with the same purpose as a closed proposal, an open issue, or an open or closed Discussion.
The owner accepts a candidate by deciding it in the session, and the run files it as an ordinary issue for `implement`. The owner declines it by saying so, and nothing is filed.

```text
Good: #140 was filed as a proposal and closed with wontfix -> a later run does not propose the same thing again
Good: a hook's message names a command that no longer exists -> the run files an issue with "AI が決めたこと", and `implement` fixes it once the owner names it
Good: a proposal would lower the severity that stops a push -> the run puts it to the owner in the session with the options, and files it as an issue with `proposal` and the decision once the owner has decided
Bad:  a run files a UI change as an issue before the owner has decided it
Bad:  a proposal is filed without proposal, and the closed proposals that step 3 collects miss it
```
