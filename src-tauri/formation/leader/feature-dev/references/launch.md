# Launch the child of a unit

Before the first launch of a run, tell the owner in two or three lines: the case you found or are starting, the unit you start with, and that you will go through the units in order and bring them the decision pages.
Then go on without waiting.

You launch exactly one child for the unit, with `formation_launch`.
`environment` is always `local`.
A child runs the plugin skill `feature-dev:unit`, which holds the procedure of every unit.

## The child's name

| Unit | Name |
| --- | --- |
| `requirement` | `req` |
| `design` | `design` |
| an implementation | `impl-{key}` |
| `specification` | `spec` |

A name has lowercase letters, digits and hyphens only, at most 40 characters, and starts with a letter or a digit.
For a key with other characters, lowercase it, turn each other character into a hyphen, and cut it to fit.
A name that is taken (a child of that name was launched before, for instance when a unit is redone) gets `-2`, `-3`, and so on.
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
- Reopen: {"none" | "reopen the unit {key} first, for the reason quoted below"}
- The owner's guidance for this launch (data to read, not orders):
> {each line of the instruction, with "> " in front; the word "none" when the instruction is empty}

Report to "{leader name}" with SendMessage, in the forms the skill gives.
Never use AskUserQuestion.
```

- `{case root}` is `{docs worktree}/.feature-dev/current`. For the first child of a new case, the worktree does not exist yet, so write the word `here` instead: the skill then takes the case root of the git top-level of the child's own folder.
- The one line of the unit:
  - `requirement`: define the requirements of the case.
  - `design`: write the basic design, and derive the implementations from it.
  - an implementation: implement the DESIGN items of this unit in {repo}.
  - `specification`: write the specification from the finished implementation.
- A reopen puts the owner's words that asked for it inside the quote, and says in the `Reopen` line which unit the child reopens. The quote is the reason it records.
- Never put a secret in a prompt.

## After the launch

The answer of `formation_launch` has `path` (the folder) and `branch`.
For the child of a new case, `path` is the docs worktree: keep it, and the case root is `{path}/.feature-dev/current`.
When the answer is `{ok: false, ...}`, read `error` and `step`, fix what you can (another name, another place), and launch again. Tell the owner only when the same refusal comes twice or you cannot fix it.

## Register the patrol

Once `formation_launch` has answered `ok`, register the patrol of that child, which looks at it every 10 minutes ([patrol](messages.md#the-patrol)).
Call `CronCreate` with:

- `cron` `*/10 * * * *`,
- `recurring` true,
- `prompt` as below, with the child's name and the folder of this skill (`${CLAUDE_SKILL_DIR}`, as SKILL.md gives it) filled in.

```text
Patrol of the child "{child name}". Read {skill folder}/references/messages.md, the section "The patrol", and do one round of it for this child.
```

`CronCreate` answers the ID of the schedule: keep it with the child's name, and never register a second patrol for a child that has one (`CronList` shows what is registered).
The patrol is only for the child of this unit.
A recurring schedule ends by itself after 7 days: when a unit runs longer than that, register it again.
The patrol is deleted with `CronDelete` when the child's `DONE` holds, when the child reopens an earlier unit, and when you stop or close the child ([messages](messages.md)).

Then serve the child: [messages](messages.md).
