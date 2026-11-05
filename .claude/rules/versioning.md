# Versioning rules

## Commits

### Put one logical change in a commit, with the subject `{prefix}: {summary}`

The prefix is one of `feat`, `fix`, `docs`, `refactor`, `test` and `chore`, so the history can be read by kind.

```text
Good: fix: keep the scroll position of the list
Bad:  update stuff
```

## Tags and version numbers

### Give each release an annotated tag `v0.{minor}.{patch}`, on the merge commit of the Release PR

Only a pushed tag starts the release (`testing.md`), so a merge with no tag is not a release.
When to release is decided in `issues.md`.
Tag only after the merge, so that the tag never points at a commit main does not have.
Make the tag in the same command as the push: `pre-git.sh` runs before the command, so a stopped push leaves no tag behind.
Do not use the major version yet; keep it fixed at 0.
The owner decides when to treat the project as 1.0.

```sh
git fetch origin main && git tag -a v0.5.0 -m v0.5.0 origin/main && git push origin v0.5.0   # the Release PR raised version to 0.5.0
```

### Never move a published tag

Moving a published tag makes it disagree with what people already fetched.
To correct a release, raise the next patch version and push that.

```text
Good: v0.5.0 has a bug, so push a fix that raises the version to v0.5.1
Bad:  delete v0.5.0 and tag the fixing commit v0.5.0 again
```

### Raise the minor version for a feature and the patch version for a fix only

Count features by requirement ID (M-n, C-n, T-n, S-n, A-n, U-n).
This lets the number tell the size of a change.

```text
Good: M-5 was added, so v0.4.2 becomes v0.5.0
Good: a display bug was fixed, so v0.5.0 becomes v0.5.1
Bad:  only a fix, but v0.5.0 becomes v0.6.0
```

## What the tagged commit contains

### Match `version` to the tag

Make `version` in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` the same number as the tag.
Let `Cargo.lock` follow.
If the version the app reports and the tag differ, you cannot tell which code is running.

```toml
[package]
version = "0.5.0"  # same as tag v0.5.0
```

### When you add a feature, update `docs/features.md` too

This keeps the public description and the implementation from drifting apart.

```markdown
# Features

- Archive a thread
```

### Write the commit's version in the body of the commit message

This lets the history show which commit is which release.

```text
feat: archive a thread (M-4)

(reason for the change)
This commit is v0.4.0.
```

## Record

### Add each version to the top of `CHANGELOG.md`, in the commit that raises the version

A list of tags alone does not show what went into each version.
The newest comes first, so the latest changes are the first thing read, and the file is tracked, so the tag and its entry cannot drift apart (at the owner's instruction, 2026-11-04).
The file is public: keep personal information and work methods (review flow, hooks, skills, where keys are kept) out of it, and put them in `.claude/rules/` (`publishing.md`).

```markdown
# Changelog

## v0.5.0

M-5 multiple accounts

## v0.4.0

M-4 archive
```
