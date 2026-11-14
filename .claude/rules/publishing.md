# Rules for public and private material

## What is public

### Write public-facing text in `README.md`, `docs/`, `AGENTS.md`, `requirements/` and `CHANGELOG.md`

The repository is public, and the license is MIT (`LICENSE`).
Users read only these places, so do not scatter user-facing text elsewhere.
`README.md` and `docs/` are for users. `AGENTS.md` is the developer guide: what the app is, the list of requirements, the stack, how to run and test it. `requirements/` holds the full text of the requirements, and the technical constraints of each integration (`requirements/constraints.md`). `CHANGELOG.md` is what went into each version, newest first. `.claude/rules/` is public too, but it is written for whoever develops the app.

```text
Good: add the description of a feature to docs/features.md
Bad:  write the description of a feature only in a commit message
```

## What is private

### Write personal information only in the gitignored rules

Personal information means things like organization names, GCP project names, personal email addresses, host names, and where keys and certificates are kept.
`.claude/rules/` is public, except `machines.md` and `google-cloud.md`, which are gitignored because they hold this (at the owner's instruction, 2026-11-05).
`.claude/hooks/` is tracked and so public too, and the list of words that must not be published is itself such a thing: it is the gitignored `.claude/hooks/public-words`, one pattern per line, which `guard-public.sh` reads and without which it stops.
Never write a personal value (a host name, a personal path, an address) in a hook: read it from that file or from the environment.
Check a rule for it before you commit the rule.
Once something enters a public repository and its history, removing it takes a history rewrite.

```text
Good: write "GCP project name: example-project" in .claude/rules/google-cloud.md
Bad:  write "runs on the GCP project example-project" in README.md or AGENTS.md
```

### Do not commit gitignored files

The targets are `CLAUDE.local.md`, `AGENTS.local.md` (retired, and still ignored so that an old worktree's copy cannot be committed), `mise.toml`, `.claude/` (except `agents/`, `hooks/`, `rules/`, `skills/` and `tools/`), `.claude/hooks/public-words`, `.claude/rules/machines.md`, `.claude/rules/google-cloud.md`, `src-tauri/.cargo/`, `logs/` and what is in `tmp/` (except `tmp/.keep`).
They hold a personal environment, or scratch files of the work in `tmp/`, and there is no point in publishing them.

```sh
git check-ignore -q mise.toml && echo ignored  # Good: prints "ignored"
```

### Do not write the name of the mail app this replaces

Do not write it in any repository file, commit message or tag message.
Naming it would openly declare this a substitute for a specific product.

```text
Good: feat: archive a thread (M-4)
Bad:  feat: archive a thread the same way as <product>
```

### Do not show secrets on screen or in logs

The targets are the client secret, refresh tokens and access tokens.
Handle them through the clipboard or the keychain, and never run a command that prints a value.
If one stays in a conversation or a log, it has to be rotated.

```sh
# Good: write without printing the value
pbpaste | jq -R '{secret: .}' > example.json
# Bad: the value stays in the output
cat example.json
```
