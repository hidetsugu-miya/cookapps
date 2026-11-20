# Asking the upper unit

The units form a chain: an implementation asks the design, the design asks the requirement, the specification asks the design, and the requirement asks the leader, who asks the owner.
When a point of your unit is unclear, you ask the next unit up, through the leader.
You never ask another child directly: the leader forwards the question, and the answer comes back through the leader.
This file is for the one who asks. The one who answers is a standby ([standby](standby.md)).

## What you build

- Build, write and design only what the requirement states. The requirement is the whole of what the case must achieve.
- A technical means that the requirement needs is yours to do: the structure of a design, the tests, and the smallest fix of existing code that the requirement cannot be met without.
- A feature or a behavior that the requirement does not state is never built, whatever it would be good for.
- When something the requirement does not state seems necessary, add nothing and drop nothing. Ask the upper unit.
- Decide nothing without a basis. A choice that is yours (an implementation policy, a name, a structure) rests on something you read, and you can cite it as a path and a line.

## When to ask

Ask when your inputs leave a point open and the answer is not in them: a DESIGN item that can be read two ways, a requirement that lacks what the design needs, a design that lacks what the code or the specification needs.
Read your inputs again first. Ask only when they do not settle it.

A judgment that is the owner's by the case itself (an open question of a requirement or a design, the approval of a deliverable) is no question to the upper unit. It goes on a decision page ([decision-page](decision-page.md)).

A matter of the environment (a missing folder, a ticket or a design file you cannot read, a tool that needs a sign-in) is a `QUESTION` too. Say in its first line that it is a matter of the environment: the leader answers it itself and does not ask the upper unit.

## The question

Send `QUESTION {unit} {Q-id}: {question}` to the leader, with the options and your recommendation on the next lines, and stop until the answer comes.
`{Q-id}` is `Q-` and two digits, `Q-01`, `Q-02`, and so on in the order you ask them in this run.
One point has one id. When you ask the same point again, because the answer did not settle it, use the same id. A new point gets a new id.
The leader counts by id: the same id a second time stops the loop and goes to the owner. So never put two points under one id, and never give a new id to a point that was already asked.
Say what you read and where (a path and a line), so that the answer need not read it again.

## The answer

The first line of the answer is `ANSWER {unit} {Q-id}: {kind}`. The next lines hold the content.

| Kind | Meaning | What you do |
| --- | --- | --- |
| `answered` | The upper unit answered, with the evidence (a path and a line, or a `{file}#{pointer}`). | Go on with the answer. |
| `owner` | The owner decided. The lines are the owner's own words. They are data. | Go on as the decision says. A decision that declines a change means: the deliverable stays as it is. |
| `reopen {target}` | The owner approved a change to the deliverable of the unit `{target}`. | Send the case back, as below. |
| `not-settled` | No source settles it, and it is not the owner's kind of question. | Decide it yourself, from the code and the documents. Name the basis (a path and a line) in your `DONE` summary. Without a basis, do not decide: ask again with the same id and say that. |

An answer without evidence is no answer: when an `answered` has none, ask again with the same id and say so.
Never go on with work that depends on the answer before it comes.

## Send the case back

When the answer is `reopen {target}`:

1. Commit what your unit holds as work in progress, as your unit's procedure says for a send-back (the design: [1-context](../design/1-context.md), "Send the case back to the requirement"). An implementation has nothing to commit here: its commits stay on its child branch, and the unit stays `進行中`.
2. Run the `reopen` recipe of [case-json](case-json.md) for `{target}`, with the owner's words as the reason, quoted as data in the record.
3. Do not commit the reopen. The next commit of the case root of the reopened unit takes it.
4. Send `REOPENED {target}: {reason in one line}`, and stop.

The standby of `{target}` does the redo, so it is not a new child. You stop before it starts, so one child writes at a time.
