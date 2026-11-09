---
name: readme-product
description: Keeps the cookapps README a product page, with screen photos taken from made-up data, and the how-to in docs/. Use on 「README を直して」「README の見栄え」「README の写真を撮り直して」, when a change makes a photo or a claim in the README out of date, and at every release (issues.md).
---

# readme-product

The README sells the product; `docs/` explains how to use it (at the owner's instruction, 2026-11-05: "これだと単に説明").
The README is public: follow `.claude/rules/publishing.md`.

## What goes where

| Place | Holds |
|-------|-------|
| `README.md` | What the product gives, the photos, how to install it, what it supports, links to the docs |
| `docs/features.md` | Every feature (`versioning.md`) |
| `docs/setup.md`, `slack.md`, `orca.md`, `claude-integration.md`, `mcp.md` | How to set up and use each part |

Do not name a page `docs/claude.md`: on this file system it is `CLAUDE.md`, and Claude Code loads it as instructions (seen on 2026-11-05).

## The shape of the README

Taken from the READMEs of Orca, Spacedrive, Cap, Inbox Zero, Hoppscotch and AppFlowy, read on 2026-11-05. Read two or three of them again from `raw.githubusercontent.com` before a large rewrite: they change.

1. Centered: the icon, the name, one line of what the reader gets, the badges, the links to install and read more.
2. The largest photo, showing the one thing no other app does.
3. Each value as a heading that says what the reader gets, one to three short sentences, and a photo. Smaller things go in a two-column table of photos.
4. What happens to the reader's data.
5. Install: one command. What it supports, stated plainly, including what it cannot do.
6. A table of the docs, the license.

```text
Good: ## メールから、そのまま仕事を頼む
Bad:  ## Orca に渡す機能
Bad:  a list of every setting, or the steps to add a Slack workspace
```

Every claim must be true of the code and `docs/privacy/index.md`. Check each one you write or change.

## Photos

`docs/assets/readme/`, from the mocked E2E build, so no real data can appear.

```sh
# from the root of a worktree with node_modules installed
"$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/skills/readme-product/shots/shots.sh"
```

The data and the steps are in `shots/readme-shots.e2e.ts`. A screen that changed may need its steps or data changed there. The result is the same bytes for the same screens, except for what depends on the date.

Data rules, because the photos are public:
- No real person, company, address or product. Domains are `example.com` and `example.org`; people are made-up Japanese names; the work is a made-up web service.
- Natural Japanese, with no test strings such as "First unread".
- Screens look used: full lists, no errors, no development text.

Read every photo with `Read` before committing it. Add a new photo only if the README shows it.

## Steps

1. Create the issue with `issue-plan`, label it `documentation`, and work from a `docs/{summary}` worktree (`worktree.md`).
2. Take the photos if a screen changed, and rewrite what the request asks.
3. Check that every local link and image in the README exists.
4. Commit, `run-ci.sh`, `run-e2e.sh`, push, `gh pr create` with `Closes #{n}`, `post-checks.sh`, `gh pr merge --merge`, fast-forward the main checkout. Only `README.md` and `docs/` in the diff is release-only, so no reviewers run (`review.md`). Anything else in the diff goes through `review.md`.
5. Report what changed, what was not checked (the page as GitHub draws it, unless it was looked at), and the URL.

At a release (step 1 of "Release by merging the Release PR" in `issues.md`), read the README against the changes that go out. When one makes a photo or a claim out of date, do steps 2 and 3 in `release/next`, and let the Release PR carry them instead of steps 1 and 4. When none does, change nothing, and say so in the Release PR body.
