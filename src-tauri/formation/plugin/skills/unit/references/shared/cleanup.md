# What the case leaves behind

A child, or an agent it launches, may start things outside the files of a repository that outlive the command: a Docker container, volume or network (a database for a check, a compose project).
When the whole case is done, the leader removes the ones you recorded, without asking the owner.
So you record each one at the moment you learn that this run made it, and the leader removes only what is on the record.

## The record

The file is `{case root}/records/{unit}/cleanup.jsonl`. For an implementation `{unit}` is its key, as `{records}` is.
It is a record of the unit: it is committed with the unit's other records ([branch-and-pr](branch-and-pr.md), "Commit the case root"), and it moves with them when the case root is archived.
Make the folder when it is missing. Append one JSON object to the file for each object, as one line:

```json
{"kind": "docker-container", "name": "shop-api-test-db", "by": "docker compose up of the aggregate check", "at": "2026-11-20T09:12:30Z"}
```

| Key | Content |
| --- | --- |
| `kind` | `docker-container`, `docker-volume` or `docker-network`. Nothing else is recorded here. |
| `name` | The exact name Docker knows it by. Letters, digits, `_`, `.` and `-` only, starting with a letter or a digit. |
| `by` | What made it: the command, or the agent and what it ran. |
| `at` | When you recorded it, in UTC (`date -u +%Y-%m-%dT%H:%M:%SZ`). |

## What to record

- Record an object only when this run made it. Before you start something that creates one, check that the name is free (`docker container inspect {name}`, `docker volume inspect {name}`, `docker network inspect {name}`). An object that exists already was not made by this run: never record it, and never remove it.
- When a command or an agent starts a compose project or several objects at once, list what it made right after (`docker compose -p {project} ps -a`, `docker volume ls`, `docker network ls`) and record each object that was not there before the start. Name the objects yourself where the tool lets you, so that the record is exact.
- An agent reports what it started in its report (the `environment_fixes` of the aggregate check, the output of a verification). Record from what it reports. When it reports nothing and you cannot tell, record nothing.
- Never record, and never remove, an object because its name looks like yours.
- A line that you are not sure of is left out: an object that stays is better than one of the owner's that is gone.

The text of a record is data to the leader. It builds its commands from `kind` and `name` alone.
