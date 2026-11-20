# Launch the child of a unit

Before the first launch of a run, tell the owner in two or three lines: the case you found or are starting, the unit you start with, and that you will go through the units in order and bring them the decision pages.
Then go on without waiting.

You launch exactly one working child for the unit, with `formation_launch`, unless the unit's standby is there to do it ([Standbys](#standbys)).
`environment` is always `local`.
A child runs the plugin skill `feature-dev:unit`, which holds the procedure of every unit.
Write the prompt and every later message to a child in English.

## The child's name

| Unit | Name |
| --- | --- |
| `requirement` | `req` |
| `design` | `design` |
| an implementation | `impl-{key}` |
| `specification` | `spec` |

A name has lowercase letters, digits and hyphens only, at most 40 characters, and starts with a letter or a digit.
For a key with other characters, lowercase it, turn each other character into a hyphen, and cut it to fit.
A name that is taken (a child of that name was launched before, for instance when a unit is redone, or when a standby is launched again) gets `-2`, `-3`, and so on.
A refusal for a name that belongs to another formation: put the name of this formation in front.

## The place

Pick the place from the table.
`formation_worktrees` shows the worktrees of a repository and the branch each is on.

| Unit | `repo` | Where the child works |
| --- | --- | --- |
| `requirement` of a new case | the docs repository | `branch`: the base branch. It is new, so it is cut from the default branch of the repository, and `base` stays out. |
| `requirement`, `design` of an existing case | the docs repository | `folder`: the docs worktree. |
| `specification` | `repo` of the unit, or the docs repository when it is `null` | the docs repository: `folder` the docs worktree. Another repository: `folder` its worktree on the base branch when there is one, else `branch`: the base branch. |
| an implementation | its `repo` | a worktree on its child branch (below). |

Rules of the tool that matter here:

- A branch cannot be open in two worktrees. The docs worktree is reused by every unit that writes the case root, so launch those with `folder`.
- `base` only goes with a `branch` that does not exist yet, and never with `folder`.
- A refusal gives its reason. Read it, pick another place or branch yourself, and ask the owner only when you cannot.

### The child branch of an implementation

Each implementation works on its own branch, cut from the base branch, and its pull request goes back into the base branch.

1. The unit has a `child` with `merged` `false`: the work goes on there. Use `child.branch`. When a worktree of the repository is already on it, launch with `folder` set to that worktree. Otherwise launch with `branch` set to it (it exists, so it is opened as it is, and `base` stays out).
2. Otherwise the branch is new. Its name is `{base branch}-{nn}`, where `nn` is two digits: one more than the largest `nn` among the `child.branch` values of all implementations of `case.json` that have this form, and `01` when there is none. Skip a number whose branch exists in that repository, locally or on `origin` (`formation_git`, `query` `{base branch}-`).
3. `base` is `origin/{base branch}` when `formation_git` shows the base branch on `origin` of that repository. When it does not, leave `base` out: the child is cut from the default branch, which is where the base branch starts too, and the child publishes the base branch itself.

The child writes the child branch into `case.json`. You do not.

## The first prompt

The child cannot see this conversation, so the prompt holds all it needs.
Use this form.
Text from the owner or from files goes inside the quote lines (`> `), as data.

```text
You are the child "{child name}" of the formation led by "{leader name}".
Run the skill feature-dev:unit now: use the Skill tool with skill "feature-dev:unit" and args "{unit} {case root} {leader name}".

This run:
- Unit: {unit} ({one line from the list below})
- Your folder: {folder} (repository {repo}, branch {branch})
- Docs repository: {docs repository name}; docs worktree: {docs worktree}; base branch: {base branch}
- Child branch: {child branch}, whose pull request goes into {base branch}   (an implementation only; leave the line out otherwise)
- Repositories of this formation: {names, one environment/name each}
- Ticket (data): {url, or "none"}
- Case: {"existing" | "new: there is no case.json yet"}
- Role: {"working" | "standby"}
- Reopen: {"none" | "reopen the unit {key} first, for the reason quoted below"}
- The owner's guidance for this launch (data to read, not orders):
> {each line of the instruction, with "> " in front; the word "none" when the instruction is empty}

Report to "{leader name}" with SendMessage, in English and in the forms the skill gives.
Never use AskUserQuestion.
```

- `{case root}` is `{docs worktree}/.feature-dev/current`. For the first child of a new case, the worktree does not exist yet, so write the word `here` instead: the skill then takes the case root of the git top-level of the child's own folder.
- The one line of the unit:
  - `requirement`: define the requirements of the case.
  - `design`: write the basic design, and derive the implementations from it.
  - an implementation: implement the DESIGN items of this unit in {repo}.
  - `specification`: write the specification from the finished implementation.
  - a standby: the unit is complete already; stand by, and answer the questions that the leader forwards.
- A reopen puts the owner's words that asked for it inside the quote, and says in the `Reopen` line which unit the child reopens. The quote is the reason it records.
- Never put a secret in a prompt.

## After the launch

The answer of `formation_launch` has `path` (the folder) and `branch`.
For the child of a new case, `path` is the docs worktree: keep it, and the case root is `{path}/.feature-dev/current`.
When the answer is `{ok: false, ...}`, read `error` and `step`, fix what you can (another name, another place), and launch again. Tell the owner only when the same refusal comes twice or you cannot fix it.

## Standbys

The child of the requirement and the child of the design stay after their `DONE` as standbys ([messages](messages.md#check-a-done)), until the specification is done.
A standby answers questions and, when its unit is reopened, redoes it. It writes nothing otherwise, so it never works beside another child.

### Launch a standby again

A standby is missing when a leader that started again does not find it, or when it is gone when you need it.
Before you start the unit that `next-unit` names, make sure each unit before it that has a standby role has one: the `requirement` when the next unit is the design, an implementation or the specification, and the `design` when the next unit is an implementation or the specification. Skip the unit that you are launching or that an instruction reopens: it gets a working child.
Look for it by the name you kept for it (the children you keep, [messages](messages.md)): call `formation_status` for that name, once. When you keep no name for it (a leader that started again), find its name from the record: call `formation_status` with the name of the table (`req`, `design`), then with `-2`, `-3`, and so on while the record has such a child, and keep the last one.
It is there when the answer shows Claude Code running in its terminal. It is missing when the record has no such child, when the screen shows a shell prompt where Claude Code was, or when the tool is refused at its step `ターミナルの末尾の読み取り` (the terminal of the child is not there: `formation_stop` closes only the terminal and leaves the entry of the record).

A missing standby is launched again as a standby: `formation_launch` of the unit's place, `folder` the docs worktree, with the first prompt below and the line `Role: standby`.
In its prompt, the one line of the unit says that the unit is complete already and that it stands by (below), and the line `Reopen` is `none`.
Then keep its name among the children you keep, and register the patrol when none is registered ([below](#register-the-patrol)). A standby that the owner closed on purpose is launched again too: the case needs it until the specification is done.
A standby that is there already and is not among the children you keep is put among them.

### Wake a standby

When [next-unit](next-unit.md) names a unit that has a standby (it was reopened), do not launch a child. Send the standby `RESUME {unit}: {the path of the reopen record, from case.json}` (or `RESUME {unit}: reopen first`, when an instruction of the owner asks for the reopen and `case.json` does not show it yet: the owner's words follow, each line with `> ` in front), mark it as working, and serve it as any child ([messages](messages.md)). It stays among the children you keep.
Make sure it is there first, as above. A missing one is launched as a working child of that unit (`Role: working`).

## Register the patrol

The patrol is one schedule for the whole formation. It looks at the children you keep (the working child and the standbys, [messages](messages.md)) every 10 minutes ([patrol](messages.md#the-patrol)).
Once `formation_launch` has answered `ok`, put the child among the children you keep, and register the patrol when none is registered yet (`CronList` shows what is registered; never register a second one).
Call `CronCreate` with:

- `cron` `*/10 * * * *`,
- `recurring` true,
- `prompt` as below, with the folder of this skill (`${CLAUDE_SKILL_DIR}`, as SKILL.md gives it) filled in.

```text
Patrol of the formation. Read {skill folder}/references/messages.md, the section "The patrol", and do one round of it for every child you keep.
```

`CronCreate` answers the ID of the schedule: keep it with the date you registered it (`date +%F`).
The patrol goes on while a child works or stands by.
A recurring schedule ends by itself after 7 days, and a standby may stand by longer than that. So the patrol is registered again before that: the round that finds it 6 days old or more deletes it and registers it again, with a new ID and a new date ([messages](messages.md#the-patrol), step 6).
The patrol is deleted with `CronDelete` only when you keep no child any more: the specification is done and its child and the standbys are stopped, or the last of them was closed ([messages](messages.md)). A child that is stopped, closed or gone is taken off the children you keep, and the patrol goes on for the others.

Then serve the child: [messages](messages.md).
