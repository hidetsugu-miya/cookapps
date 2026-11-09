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
The owner releases by merging the Release PR, and the next agent to act tags the merge commit (`issues.md`).
Tag only after the merge, so that the tag never points at a commit main does not have, and tag the commit that `tag_due` of `plan-release.py release` names, because another pull request may have merged on top of the Release PR before the tag.
Make the tag in the same command as the push: `pre-git.sh` runs before the command, so a stopped push (a missing record, a forbidden word) leaves no tag behind.
Do not use the major version yet; keep it fixed at 0.
The owner decides when to treat the project as 1.0.

```sh
git fetch origin main && git tag -a v0.5.0 -m v0.5.0 {commit of tag_due} && git push origin v0.5.0   # the Release PR wrote `## v0.5.0` at the top of CHANGELOG.md
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

### Keep the version in the tag alone, and fix it in the source

The version of a release is its tag, and nothing else holds it (at the owner's instruction, 2026-11-09; Discussion #293).
`version` in `src-tauri/Cargo.toml` and `Cargo.lock` is fixed at `0.0.0`, and `src-tauri/tauri.conf.json` has no `version`; `scripts/check-version.sh` fails when any of the three differs, so a branch that raises one fails the static check.
The `release` job takes the version from the tag and gives it to `tauri build` with `--config` (`release.yml`): Info.plist, `package_info()` (the version of the settings screen) and the updater's comparison all take it from there, so the app reports the version of its tag.
A build of a branch or of `tauri dev` reports `0.0.0`, and a build by hand passes the latest tag the same way (`scripts/install-app.sh`).
The Release PR therefore changes no version line, and its first heading in `CHANGELOG.md` (`## v{version}`) is where the version is written down before the tag exists: `plan-release.py release` reads it from the merge commit to find the tag that is due.

```toml
[package]
version = "0.0.0"  # fixed; the tag v0.5.0 gives the build its version
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

### Add each version to the top of `CHANGELOG.md`, in the commit of the Release PR

A list of tags alone does not show what went into each version.
The newest comes first, so the latest changes are the first thing read, and the file is tracked, so the tag and its entry cannot drift apart (at the owner's instruction, 2026-11-04).
The heading must be exactly `## v{version}` (the Release PR writes the version of the coming tag there, and `plan-release.py release` takes the tag from the first such heading of the merge commit).
The file is for the users of the app: keep personal information and work methods (review flow, hooks, skills) out of it. Work methods go in `.claude/rules/`, and personal information in the gitignored rules (`publishing.md`).

```markdown
# Changelog

## v0.5.0

M-5 multiple accounts

## v0.4.0

M-4 archive
```
