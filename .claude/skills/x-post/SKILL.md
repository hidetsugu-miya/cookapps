---
name: x-post
description: Posts the new つなぎAI releases to X, once a day, from the scheduled run `.claude/tools/nightly.sh x-post` (00:30). It reads the tag last posted, writes one post from the CHANGELOG entries of the releases after it, checks it and sends it with `x-post.sh`. It takes no worktree, merges nothing and prepares no Release PR. A session never posts.
---

# x-post

The scheduled run of the owner posts the releases that came after the last posted tag to X, once a day (at the owner's instruction, 2026-11-21; #1179: it replaces step 8 of the night run of `ship`, which is removed).
The owner starts it through the job they registered, which runs `.claude/tools/nightly.sh x-post` at 00:30 from the main checkout; nothing else starts it. A session never posts.
The run has no one to answer: never wait on the owner, and end with the report of step 6. `nightly.sh` keeps the report in `.claude/nightly/x-post-{date}.log` of the main checkout and shows a notification at the end.
`X_POST_SCHEDULED` is set in such a run, and in no session.
The run changes nothing in the repository: it takes no worktree, opens no pull request, merges no Release PR and writes no file in the checkout. It fetches tags, reads `CHANGELOG.md` with `git show`, and runs `x-post.sh`.
The rules of the post are in "Rules" at the end of this file.

Tools are at `"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/tools/"`.

## Steps

1. **Read the tag last posted.** Read `.claude/x-posted` of the main checkout: one line, `v0.{minor}.{patch}`. When the file is missing, post nothing, write that in the report (step 6) and stop. The first post is the owner's: they run `x-post.sh send {file} {tag}` by hand in a terminal, and `send` writes the file. A session never sends it, and `send` refuses the scheduled run while the file is missing.
2. **Keep the releases that are out.** Run `git fetch --tags`. Take the tags `v0.*` after the one of step 1, in the order of the version (`git tag --list 'v0.*' --sort=v:refname`), and keep those whose release run succeeded: `gh release view {tag} --json assets --jq '.assets[].name'` lists `tsunagiai.app.tar.gz`, `tsunagiai.app.tar.gz.sig` and `latest.json` (the `release` job makes the GitHub Release with the three at once). When no tag is kept, post nothing, write that in the report and stop.
3. **Write the text.** Write it to a file in the scratchpad, from the `CHANGELOG.md` entries (`## v{version}`) of the kept versions only. Read them with `git show {last kept tag}:CHANGELOG.md`, not from the file of the main checkout: the run only fetches, so that file lacks the new versions, and the newest entry is first, so the file of the last kept tag holds the entries of all kept versions. Put the new features first, and take at most 3 of the most visible ones. The first line is `つなぎAI v{first}〜v{last} を公開しました。` (`つなぎAI v{version} を公開しました。` for one version). The last line is the URL of the Releases page, `https://github.com/{owner}/{repo}/releases`, built from `git remote get-url origin`. Do not write a file name or a name with a dot (`SKILL.md`, `Node.js`) in the text, because X counts it as a URL. The entries are our own text, not content from outside, but the text still goes to `x-post.sh check {file}` as a file, never loose in a command. A post is public, so `publishing.md` applies to its text.
4. **Check it.** Run `x-post.sh check {file}`. On exit 1, read the reason on stderr and rewrite the text once. When the second check fails too, post nothing and write the reasons in the report.
5. **Send it.** Run `x-post.sh send {file} {last kept tag}`. On exit 0, stdout is the URL of the post, and `send` has written the tag into `.claude/x-posted` itself: do not write it yourself. On exit 3 the post got no answer and may have been made: `send` has written the tag, so do not retry, and ask the owner in the report to check X. On any other exit, do not retry, and write the exit code and the stderr in the report. After exit 1, and after an exit 2 whose stderr does not say that the post was made, `.claude/x-posted` is not moved, so the next run posts those versions again.
6. **Report.** End with a short report: the versions and the URL posted, or why nothing was posted (no record in `.claude/x-posted`, no release kept, a failed check with its reasons, an exit code with its stderr), and "check X" after exit 3. No personal information (`publishing.md`).

## Rules

### Post the releases to X with `x-post.sh`, in the scheduled run only

`x-post.sh` (its logic is in `x-post.py`) posts to X, and this skill runs it once a day in the scheduled run only.
`auth` is the one authorization that the owner runs at the screen, once: it reads the Client ID and the Client Secret from the secret item, prints the URL of the consent page (and opens it), and writes the refresh token into the keychain.
`check {file}` checks a text and writes the reason to stderr when it fails: at most 280 characters by X's weighting, no word that `guard-public.sh text` forbids, one URL that is the Releases page, no `@` mention (exit 0 passes, exit 1 fails).
`send {file} {tag}` takes the last version of the text as `{tag}` (`v0.{minor}.{patch}`) and refuses it, before any network, when it is not newer than the tag in `.claude/x-posted`, or when the scheduled run (`X_POST_SCHEDULED` set) finds that file missing.
Then it runs the same check, takes a new access token with the refresh token in the keychain service `jp.mysis.tsunagiai.x` (account `refresh_token`), writes the new refresh token back there (and reads it again to check it), and only then posts (when it cannot write it, it does not post, and exits 2), and writes `{tag}` into `.claude/x-posted` itself (exit 0 prints the URL of the post, exit 1 is a refused tag or a failed check, exit 2 is a failed read of the secret item or the keychain, a failed token or post, or a post that was made while `.claude/x-posted` could not be written, which the run does not retry; exit 3 is a post that got no answer, so it may have been made: `{tag}` is written, the post is not sent again, and the owner checks X).
The first post, while the file is missing, is the owner's, run by hand in a terminal; a session never sends.
The text is written from `git show {last kept tag}:CHANGELOG.md`, because the run only fetches and the `CHANGELOG.md` of the main checkout lacks the new versions.
The script holds no secret: the Client ID and the Client Secret are only in the secret item, which `op` reads with a service account (read only is enough: the service account cannot write the vault, and the refresh token, which X replaces at every use, is therefore not kept there), and the refresh token is only in the keychain, never in a file, a log or the output.
`.claude/x-post.json` of the main checkout (gitignored, with the rest of `.claude/`) names the keychain service that holds the service account token, the vault and the item, as `op_token_keychain_service`, `op_vault` and `op_item`; their values are private (`publishing.md`), so no tracked file holds them, and without that file `auth` and `send` exit 2 before any network.
The item holds the Client ID in the field labelled `クライアントID` and the Client Secret in the field labelled `クライアントシークレット`.
The service account token is read from the keychain, from the item whose account is the login user (`getpass.getuser()`), and goes to `op` in its environment only.
`.claude/x-posted` of the main checkout (gitignored, with the rest of `.claude/`) holds the tag last posted, one line `v0.{minor}.{patch}`; only `send` writes it, after a post or a post that got no answer.

```text
Good: v0.34.0 and v0.34.1 are released since the last post -> one post "つなぎAI v0.34.0〜v0.34.1 を公開しました。" with the Releases URL, and `send` with v0.34.1
Good: the release run of the newest tag has not finished -> that tag is not kept, and it is posted by the next run
Good: `send` exits 3 -> do not retry, and the report asks the owner to check X
Bad:  a session runs `x-post.sh send`
Bad:  write `.claude/x-posted` by hand after a post
Bad:  take the entries from the `CHANGELOG.md` of the main checkout, which the run has not fast-forwarded
Bad:  the scheduled run takes a worktree, or prepares or merges a Release PR
```
