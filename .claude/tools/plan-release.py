#!/usr/bin/env python3
"""Keeps one GitHub milestone per planned tag (the milestone title is the tag; a closed milestone is released).

Usage:
  plan-release.py snapshot
  plan-release.py apply <plan.json> [--dry-run]
  plan-release.py sync [--dry-run]
  plan-release.py close <tag>
  plan-release.py next [--mine <issue numbers>]
  plan-release.py release-facts [--now <ISO time>]

Talks to GitHub only through `gh`, so it runs from any checkout. Exit 2: the plan or the state is refused (stderr says why).
"""
import argparse
import datetime
import json
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field

MAX_COUNTED = 3
TMP_PREFIX = "plan-tmp-"


class PlanError(Exception):
    """A refusal with every problem listed; the exit code is 2."""

    def __init__(self, problems):
        super().__init__("\n".join(problems))
        self.problems = problems


class GhError(Exception):
    pass


@dataclass
class Issue:
    number: int
    id: int
    title: str
    body: str
    labels: list
    milestone: str | None
    milestone_number: int | None
    created_at: str
    closed_at: str | None
    state: str
    state_reason: str | None = None  # "completed" or "not_planned" for a closed issue
    blocked_by: list = field(default_factory=list)  # numbers of the open blockers


# ---- pure: versions and labels ----


def parse_version(s):
    m = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", s or "")
    return tuple(int(x) for x in m.groups()) if m else None


def format_version(t):
    return "v%d.%d.%d" % t


def highest_tag(names):
    versions = [v for v in map(parse_version, names) if v]
    return format_version(max(versions)) if versions else None


def base_tag(names, milestones):
    """The highest released tag; a tag whose milestone is still open is not released until `close` closes it."""
    unreleased = {m["title"] for m in milestones if m["state"] == "open"}
    return highest_tag([n for n in names if n not in unreleased])


def bump(version, minor):
    major, mi, pa = version
    return (major, mi + 1, 0) if minor else (major, mi, pa + 1)


def has(issue, label):
    return label in issue.labels


QUICK_SIZES = ("size:xs", "size:s", "size:m")


def quick_bug(issue):
    """A bug of size xs, s or m goes to the front of the queue; a bug of size l or xl does not."""
    return has(issue, "bug") and any(has(issue, size) for size in QUICK_SIZES)


def solo(issue):
    """A size:xl change is a version of its own."""
    return has(issue, "size:xl")


def urgent(issue):
    return has(issue, "urgency:high")


def importance(issue):
    return "high" if has(issue, "importance:high") else "low" if has(issue, "importance:low") else "normal"


def pin_version(issue):
    """The version the owner pinned the issue to (its milestone), or None. A pin without a version milestone means nothing."""
    return parse_version(issue.milestone) if has(issue, "release:pin") else None


def counted(issue):
    return not has(issue, "documentation")


def eligible_title(title):
    return parse_version(title) is not None or (title.startswith(TMP_PREFIX) and len(title) > len(TMP_PREFIX))


def missing_size(issues):
    return [i for i in issues if i.state == "open" and not any(label.startswith("size:") for label in i.labels)]


def parse_stream(text):
    """`gh api --paginate` prints one JSON document per page; flatten the arrays."""
    decoder = json.JSONDecoder()
    out = []
    pos = 0
    while True:
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text):
            return out
        obj, pos = decoder.raw_decode(text, pos)
        if isinstance(obj, list):
            out.extend(obj)
        else:
            out.append(obj)


# ---- pure: queue and allocation ----


def existing_order(free):
    """The urgent issues first, then the quick bugs, then the rest, each in the order of the previous plan.
    An urgent issue or a quick bug that waits for free issues takes them (and theirs, through the chain) with it, each before the issue that waits for it."""

    def key(i):
        v = parse_version(i.milestone)
        return (0, v, i.created_at, i.number) if v else (1, (), i.created_at, i.number)

    ordered = sorted(free, key=key)
    rank = {i.number: k for k, i in enumerate(ordered)}
    by_number = {i.number: i for i in ordered}
    lead = []
    taken = set()

    def take(i):
        if i.number in taken:
            return
        taken.add(i.number)
        for b in sorted((b for b in i.blocked_by if b in by_number), key=rank.get):
            take(by_number[b])
        lead.append(i)

    for front in (urgent, quick_bug):
        for i in ordered:
            if front(i):
                take(i)
    return lead + [i for i in ordered if i.number not in taken]


def derive_groups(ordered):
    """Groups of a previous plan: consecutive issues that share a version milestone, so that a sync keeps them together.
    A size:xl issue ends a run, a pinned issue is never in a run (it has its own slot), and a run over the cap is left to the allocation."""
    groups = []
    run = []

    def flush():
        if len(run) > 1 and sum(1 for i in run if counted(i)) <= MAX_COUNTED:
            groups.append([i.number for i in run])
        run.clear()

    for i in ordered:
        alone = solo(i) or pin_version(i) is not None
        if alone or parse_version(i.milestone) is None or (run and run[-1].milestone != i.milestone):
            flush()
        if not alone and parse_version(i.milestone) is not None:
            run.append(i)
    flush()
    return groups


def is_waiting(i):
    """A merged change not released yet: closed as completed. An issue closed as not planned (wontfix) is no change."""
    return i.state == "closed" and i.state_reason == "completed"


def split_issues(issues, pr_closing):
    """-> waiting, in progress, the rest. Issues closed as completed are the waiting ones."""
    waiting = sorted((i for i in issues if is_waiting(i)), key=lambda i: (i.closed_at or "", i.number))
    open_ = [i for i in issues if i.state == "open"]
    in_progress = sorted((i for i in open_ if i.number in pr_closing), key=lambda i: (i.created_at, i.number))
    rest = [i for i in open_ if i.number not in pr_closing]
    return waiting, in_progress, rest


def allocate(queue, groups, base):
    """Walks the queue and returns [{"version", "issues": [numbers]}].
    The issues pinned to one version (release:pin) share one slot of that version, placed where the first of them stands; nothing else joins it, and an xl one needs no slot of its own.
    A pinned version that earlier slots have reached already is refused: the pin is never moved."""
    pos = {i.number: k for k, i in enumerate(queue)}
    group_len = {}
    for g in groups:
        positions = sorted(pos[n] for n in g if n in pos)
        if positions:
            group_len[positions[0]] = len(positions)
    pins = {}
    for i in queue:
        v = pin_version(i)
        if v:
            pins.setdefault(v, []).append(i)
    placed = set()

    slots = []
    cur = []

    def close():
        nonlocal cur
        if cur:
            slots.append(cur)
            cur = []

    def count(issues):
        return sum(1 for i in issues if counted(i))

    k = 0
    while k < len(queue):
        v = pin_version(queue[k])
        if v:
            k += 1
            if v not in placed:
                placed.add(v)
                close()
                slots.append(pins[v])
            continue
        n = group_len.get(k, 1)
        unit = queue[k : k + n]
        k += n
        if n == 1 and solo(unit[0]):
            close()
            slots.append(unit)
            continue
        if n > 1 and count(cur) + count(unit) > MAX_COUNTED:
            close()
        cur = cur + unit
        if any(urgent(i) for i in unit) or count(cur) >= MAX_COUNTED:
            close()
    close()

    def slot_pin(slot):
        return next((pin_version(i) for i in slot if pin_version(i)), None)

    merged = []
    carry = []
    for idx, slot in enumerate(slots):
        slot = carry + slot
        if idx < len(slots) - 1 and not any(counted(i) for i in slot) and not slot_pin(slot):
            carry = slot
            continue
        carry = []
        merged.append(slot)

    out = []
    version = parse_version(base) or (0, 0, 0)
    for slot in merged:
        pinned = slot_pin(slot)
        if pinned:
            if pinned <= version:
                held = ", ".join(f"#{i.number}" for i in slot if pin_version(i))
                raise PlanError(
                    [f"{format_version(pinned)} is pinned ({held}) but the slots before it already reach {format_version(version)}"]
                )
            version = pinned
        else:
            version = bump(version, any(has(i, "adds:requirement") for i in slot))
        out.append({"version": format_version(version), "issues": [i.number for i in slot]})
    return out


# ---- pure: validation of a plan ----


def _int(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return None


def validate_plan(plan, free, fixed, states):
    """-> list of problems. `states` maps an issue number to "open" or "closed"."""
    if not isinstance(plan, dict):
        return ["plan: not a JSON object"]
    order = plan.get("order")
    if not isinstance(order, list) or any(_int(n) is None for n in order):
        return ["plan.order: must be a list of issue numbers"]
    order = [_int(n) for n in order]
    groups = plan.get("groups", [])
    blocked_by = plan.get("blocked_by", {})
    if not isinstance(groups, list) or any(not isinstance(g, list) or any(_int(n) is None for n in g) for g in groups):
        return ["plan.groups: must be a list of lists of issue numbers"]
    if not isinstance(blocked_by, dict) or any(
        _int(k) is None or not isinstance(v, list) or any(_int(b) is None for b in v) for k, v in blocked_by.items()
    ):
        return ["plan.blocked_by: must map an issue number to a list of issue numbers"]
    groups = [[_int(n) for n in g] for g in groups]
    blocked_by = {_int(k): [_int(b) for b in v] for k, v in blocked_by.items()}

    problems = []
    free_by = {i.number: i for i in free}
    fixed_nums = {i.number for i in fixed}

    for n, c in sorted(Counter(order).items()):
        if c > 1:
            problems.append(f"order: #{n} appears twice")
    for n in sorted(set(free_by) - set(order)):
        problems.append(f"order: #{n} is missing")
    for n in sorted(set(order) - set(free_by)):
        why = "is fixed (not planned by the planner)" if n in fixed_nums else "is not an open issue of the owner"
        problems.append(f"order: #{n} {why}")

    position = {n: k for k, n in enumerate(order)}
    seen = set()
    for g in groups:
        label = "group " + str(g)
        if any(n not in free_by for n in g):
            problems.append(f"{label}: holds an issue that is not in order")
            continue
        if len(set(g)) != len(g) or seen & set(g):
            problems.append(f"{label}: an issue is in two groups or twice in one")
            continue
        seen |= set(g)
        ps = sorted(position[n] for n in g if n in position)
        if ps != list(range(ps[0], ps[0] + len(ps))):
            problems.append(f"{label}: members are not adjacent in order")
        if any(pin_version(free_by[n]) for n in g):
            problems.append(f"{label}: holds an issue with release:pin (pinned issues share their version without a group)")
        if len(g) > 1 and any(solo(free_by[n]) for n in g):
            problems.append(f"{label}: holds a size:xl issue with another issue")
        if sum(1 for n in g if counted(free_by[n])) > MAX_COUNTED:
            problems.append(f"{label}: holds more than {MAX_COUNTED} counted issues")

    # The issues pinned to one version share the slot where the first of them stands (allocate).
    first_pin = {}
    for n in order:
        v = pin_version(free_by[n]) if n in free_by else None
        if v and v not in first_pin:
            first_pin[v] = position[n]

    for n, blockers in sorted(blocked_by.items()):
        if n not in free_by:
            problems.append(f"blocked_by: #{n} is not an issue to plan")
            continue
        pinned = pin_version(free_by[n])
        for b in blockers:
            if (
                pinned
                and b in free_by
                and position.get(b, -1) > first_pin[pinned]
                and pin_version(free_by[b]) != pinned
            ):
                problems.append(
                    f"blocked_by: #{n} is pinned to {format_version(pinned)} and goes out with the first pinned issue, but #{b}, which blocks it, is placed after that"
                )
            state = states.get(b)
            if state is None:
                problems.append(f"blocked_by: #{n} names #{b}, which is unknown")
            elif state == "open" and b in free_by and position.get(b, -1) >= position.get(n, -1):
                problems.append(f"blocked_by: #{b} blocks #{n} but is not placed earlier in order")
            elif state == "open" and b not in free_by and b not in fixed_nums:
                problems.append(f"blocked_by: #{n} names #{b}, which is open but not planned")

    # An urgent issue comes before every other issue, then a quick bug (a bug of size xs, s or m) comes before every other issue but the urgent ones.
    # The issues that block it, or an earlier issue of its kind, may stand before it.
    def front(member, allowed, message):
        needed = set()
        for k, n in enumerate(order):
            if n not in free_by or not member(free_by[n]):
                continue
            todo = [n]
            while todo:
                for b in blocked_by.get(todo.pop(), []):
                    if b not in needed and b in free_by:
                        needed.add(b)
                        todo.append(b)
            late = next((m for m in order[:k] if m in free_by and not allowed(free_by[m]) and m not in needed), None)
            if late is not None:
                problems.append(message(n, late))

    front(urgent, urgent, lambda n, late: f"order: #{n} has urgency:high but is placed after #{late}")
    front(
        quick_bug,
        lambda i: quick_bug(i) or urgent(i),
        lambda n, late: f"order: #{n} is a bug of size xs, s or m but is placed after #{late}",
    )

    # cycle
    color = {}

    def visit(n, path):
        if color.get(n) == 2:
            return None
        if color.get(n) == 1:
            return path[path.index(n) :] + [n]
        color[n] = 1
        for b in blocked_by.get(n, []):
            found = visit(b, path + [n])
            if found:
                return found
        color[n] = 2
        return None

    for n in sorted(blocked_by):
        found = visit(n, [])
        if found:
            problems.append("blocked_by: cycle " + " -> ".join(f"#{x}" for x in found))
            break
    return problems


def diff_relations(free_numbers, current, wanted):
    """-> (add, remove) as (blocked, blocker) pairs, for the free issues only."""
    add, remove = [], []
    for n in sorted(free_numbers):
        want = set(wanted.get(n, []))
        have = set(current.get(n, []))
        add += [(n, b) for b in sorted(want - have)]
        remove += [(n, b) for b in sorted(have - want)]
    return add, remove


# ---- pure: milestone writes ----


def plan_writes(slots, milestones, issue_ms):
    """-> (ops, errors). Ops, in order:
    ("create", slot index, title), ("rename", milestone number, title),
    ("set", issue number, milestone number | ("new", slot index)), ("delete", milestone number).
    Replaying them never asks GitHub for a title another milestone holds.
    """
    by_number = {m["number"]: m for m in milestones}
    elig = {n for n, m in by_number.items() if m["state"] == "open" and eligible_title(m["title"])}
    closed_titles = {m["title"]: n for n, m in by_number.items() if m["state"] != "open"}

    errors = [
        f"{s['version']} is held by the closed milestone #{closed_titles[s['version']]}"
        for s in slots
        if s["version"] in closed_titles
    ]
    if errors:
        return [], errors

    # Reuse: the open milestone that already holds most of the members; else one that already has the title.
    claim = {}
    claimed = set()
    for i, s in enumerate(slots):
        counts = Counter(issue_ms.get(n) for n in s["issues"])
        cands = sorted(
            (-c, 0 if by_number[k]["title"] == s["version"] else 1, k)
            for k, c in counts.items()
            if k in elig and k not in claimed
        )
        if cands:
            claim[i] = cands[0][2]
            claimed.add(cands[0][2])
    for i, s in enumerate(slots):
        if i in claim:
            continue
        same = sorted(k for k in elig - claimed if by_number[k]["title"] == s["version"])
        if same:
            claim[i] = same[0]
            claimed.add(same[0])

    cur_title = {n: m["title"] for n, m in by_number.items()}
    held = {m["title"]: n for n, m in by_number.items()}
    pending = {}
    for i, s in enumerate(slots):
        if i not in claim:
            pending[("new", i)] = s["version"]
        elif cur_title[claim[i]] != s["version"]:
            pending[claim[i]] = s["version"]

    def order_key(k):
        return (1, k[1]) if isinstance(k, tuple) else (0, k)

    ops = []
    while pending:
        ready = sorted((k for k, t in pending.items() if t not in held), key=order_key)
        if ready:
            k = ready[0]
            t = pending.pop(k)
            if isinstance(k, tuple):
                ops.append(("create", k[1], t))
                held[t] = k
            else:
                del held[cur_title[k]]
                ops.append(("rename", k, t))
                cur_title[k] = t
                held[t] = k
            continue
        # Stuck: free a title through a temporary one, an unclaimed holder first, else the lowest of a cycle.
        evict = next(
            (held[t] for t in sorted(pending.values()) if isinstance(held[t], int) and held[t] not in pending), None
        )
        if evict is None:
            evict = min(k for k in pending if isinstance(k, int))
        tmp = f"{TMP_PREFIX}{evict}"
        if cur_title[evict] == tmp:
            return [], [f"cannot free the title wanted by #{evict}"]
        del held[cur_title[evict]]
        ops.append(("rename", evict, tmp))
        cur_title[evict] = tmp
        held[tmp] = evict

    for i, s in enumerate(slots):
        target = claim.get(i, ("new", i))
        for n in s["issues"]:
            if i not in claim or issue_ms.get(n) != claim[i]:
                ops.append(("set", n, target))

    leaving = Counter(issue_ms.get(n) for s in slots for n in s["issues"])
    for k in sorted(elig - claimed):
        m = by_number[k]
        if m["open_issues"] + m["closed_issues"] - leaving[k] <= 0:
            ops.append(("delete", k))
    return ops, []


def result_lines(slots, issues, reasons):
    lines = []
    for s in slots:
        for n in s["issues"]:
            line = f"#{n} {s['version']}"
            was = issues[n].milestone
            if was and was != s["version"]:
                line += f" (was {was})"
            if reasons.get(str(n)):
                line += f" - {reasons[str(n)]}"
            lines.append(line)
    return lines


# ---- pure: next ----


def worktree_issues(porcelain):
    """-> {issue number: branch} from `git worktree list --porcelain`, for the worktrees other than the first (the main checkout).
    A worktree belongs to an issue when its branch or its folder name holds `issue-{n}`."""
    out = {}
    for block in porcelain.strip().split("\n\n")[1:]:
        path = branch = ""
        for line in block.splitlines():
            if line.startswith("worktree "):
                path = line[len("worktree ") :]
            elif line.startswith("branch "):
                branch = line[len("branch ") :].removeprefix("refs/heads/")
        for text in (branch, path.rstrip("/").rsplit("/", 1)[-1]):
            for m in re.finditer(r"issue-(\d+)(?!\d)", text):
                out.setdefault(int(m.group(1)), branch or path)
    return out


def build_next(issues, milestones, pr_closing, held_by_worktree=None, mine=frozenset()):
    """`held`: an issue that another session may be working on (an open pull request closes it, or a worktree named issue-{n} exists)
    and that the previous hand-over does not list as this run's own (`mine`). It is neither started nor continued."""
    held_by_worktree = held_by_worktree or {}
    open_versions = sorted(
        (parse_version(m["title"]), m["title"]) for m in milestones if m["state"] == "open" and parse_version(m["title"])
    )
    titles = [t for _, t in open_versions]

    def brief(i):
        return {"number": i.number, "title": i.title, "labels": i.labels}

    by_created = lambda i: (i.created_at, i.number)  # noqa: E731
    waiting = sorted((i for i in issues if is_waiting(i) and i.milestone in titles), key=lambda i: (i.closed_at or "", i.number))
    open_issues = [i for i in issues if i.state == "open" and i.milestone in titles]
    chosen = next((t for t in titles if any(i.milestone == t for i in open_issues)), None)
    out = {
        "milestone": chosen,
        "start": [],
        "in_progress": [],
        "held": [],
        "needs_owner": [],
        "blocked": [],
        "waiting": [dict(brief(i), milestone=i.milestone) for i in waiting],
        "later_needs_owner_only": False,
    }
    if chosen is None:
        return out
    here = sorted((i for i in open_issues if i.milestone == chosen), key=by_created)
    for i in here:
        if i.number in pr_closing:
            if i.number in mine:
                out["in_progress"].append(brief(i))
            else:
                out["held"].append(dict(brief(i), reason="pull request open"))
        elif has(i, "needs:owner"):
            out["needs_owner"].append(brief(i))
        elif i.number in held_by_worktree and i.number not in mine:
            out["held"].append(dict(brief(i), reason="worktree " + held_by_worktree[i.number]))
        elif i.blocked_by:
            out["blocked"].append({"number": i.number, "title": i.title, "blocked_by": sorted(i.blocked_by)})
        else:
            out["start"].append(brief(i))
    later = [i for i in open_issues if i.milestone != chosen]
    out["later_needs_owner_only"] = bool(later) and all(has(i, "needs:owner") for i in later)
    return out


# ---- pure: release facts ----


def parse_time(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)


def release_facts(waiting, pr_labels, now):
    """Applies R0 to R3 of issues.md and gathers the figures of R4, which the release-planner judges.
    `waiting` are the merged changes not released yet, `pr_labels` the labels of the Release PR (None when there is none).
    -> {"rule": "R0".."R3" | "R4", "decision": "wait" | "release" | None, ...}"""
    pr_labels = pr_labels or []
    changes = sorted((i for i in waiting if is_waiting(i) and counted(i)), key=lambda i: (i.closed_at or "", i.number))
    if "release:hold" in pr_labels:
        rule, decision = "R0", "wait"
    elif "urgency:high" in pr_labels or any(urgent(i) for i in changes):
        rule, decision = "R1", "release"
    elif any(solo(i) for i in changes):
        rule, decision = "R2", "release"
    elif any(has(i, "bug") and has(i, "importance:high") for i in changes):
        rule, decision = "R3", "release"
    else:
        rule, decision = "R4", None

    def hours(i):
        return round((now - parse_time(i.closed_at)).total_seconds() / 3600, 1) if i.closed_at else None

    rows = [
        {"number": i.number, "title": i.title, "labels": i.labels, "closed_at": i.closed_at, "hours": hours(i)} for i in changes
    ]
    ages = [r["hours"] for r in rows if r["hours"] is not None]
    return {
        "rule": rule,
        "decision": decision,
        "changes": len(changes),
        "bugs": sum(1 for i in changes if has(i, "bug")),
        "oldest_hours": max(ages) if ages else None,
        "waiting": rows,
    }


# ---- gh ----


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise GhError(f"gh {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def api(path, method="GET", fields=None, paginate=False):
    args = ["api", path]
    if method != "GET":
        args += ["-X", method]
    if paginate:
        args.append("--paginate")
    for k, v in (fields or {}).items():
        args += ["-f", f"{k}={v}"] if isinstance(v, str) else ["-F", f"{k}={'null' if v is None else v}"]
    out = parse_stream(gh(*args))
    return out if paginate or len(out) != 1 else out[0]


@dataclass
class State:
    repo: str
    owner: str
    base: str | None
    milestones: list
    issues: dict  # owner's open issues, and the closed ones of the open milestones
    fixed: list
    free: list
    pr_closing: set
    ids: dict  # issue number -> database id
    states: dict  # issue number -> "open" | "closed"
    skipped: int


def to_issue(raw):
    ms = raw.get("milestone") or {}
    return Issue(
        number=raw["number"],
        id=raw["id"],
        title=raw["title"],
        body=raw.get("body") or "",
        labels=[label["name"] for label in raw.get("labels", [])],
        milestone=ms.get("title"),
        milestone_number=ms.get("number"),
        created_at=raw["created_at"],
        closed_at=raw.get("closed_at"),
        state=raw["state"],
        state_reason=raw.get("state_reason"),
    )


def load_state():
    repo = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").strip()
    owner = gh("repo", "view", "--json", "owner", "--jq", ".owner.login").strip()
    tags = [t["name"] for t in api(f"repos/{repo}/tags?per_page=100", paginate=True)]
    milestones = api(f"repos/{repo}/milestones?state=all&per_page=100", paginate=True)
    base = base_tag(tags, milestones)

    raw = [r for r in api(f"repos/{repo}/issues?state=open&per_page=100", paginate=True) if "pull_request" not in r]
    for m in milestones:
        if m["state"] == "open" and eligible_title(m["title"]):
            raw += [
                r
                for r in api(f"repos/{repo}/issues?state=closed&milestone={m['number']}&per_page=100", paginate=True)
                if "pull_request" not in r
            ]
    skipped = sum(1 for r in raw if r["user"]["login"] != owner)
    issues = {r["number"]: to_issue(r) for r in raw if r["user"]["login"] == owner}

    ids = {n: i.id for n, i in issues.items()}
    states = {n: i.state for n, i in issues.items()}
    for n, i in issues.items():
        if i.state != "open":
            continue
        for b in api(f"repos/{repo}/issues/{n}/dependencies/blocked_by?per_page=100", paginate=True):
            if not b["repository_url"].endswith("/" + repo):
                continue
            ids.setdefault(b["number"], b["id"])
            states.setdefault(b["number"], b["state"])
            if b["state"] == "open":
                i.blocked_by.append(b["number"])

    prs = json.loads(gh("pr", "list", "--state", "open", "--limit", "200", "--json", "author,closingIssuesReferences"))
    pr_closing = {
        ref["number"] for p in prs if p["author"]["login"] == owner for ref in p.get("closingIssuesReferences", [])
    }

    waiting, in_progress, rest = split_issues(list(issues.values()), pr_closing)
    return State(
        repo=repo,
        owner=owner,
        base=base,
        milestones=milestones,
        issues=issues,
        fixed=waiting + in_progress,
        free=existing_order(rest),
        pr_closing=pr_closing,
        ids=ids,
        states=states,
        skipped=skipped,
    )


def refuse_missing_size(state):
    bad = missing_size(state.issues.values())
    if bad:
        raise PlanError([f"#{i.number} has no size:* label; run the issue-plan skill" for i in bad])


def describe(op):
    kind = op[0]
    if kind == "create":
        return f"create milestone {op[2]}"
    if kind == "rename":
        return f"rename milestone #{op[1]} to {op[2]}"
    if kind == "set":
        return f"set milestone of #{op[1]} to " + (f"new slot {op[2][1]}" if isinstance(op[2], tuple) else f"#{op[2]}")
    return f"delete milestone #{op[1]}"


def run_ops(state, ops):
    repo = state.repo
    created = {}
    for op in ops:
        kind = op[0]
        if kind == "create":
            created[op[1]] = api(f"repos/{repo}/milestones", "POST", {"title": op[2]})["number"]
        elif kind == "rename":
            api(f"repos/{repo}/milestones/{op[1]}", "PATCH", {"title": op[2]})
        elif kind == "set":
            target = created[op[2][1]] if isinstance(op[2], tuple) else op[2]
            api(f"repos/{repo}/issues/{op[1]}", "PATCH", {"milestone": target})
        else:
            api(f"repos/{repo}/milestones/{op[1]}", "DELETE")


def execute(state, order, groups, wanted, reasons, base, dry_run):
    """Allocates the queue, writes the milestones and the relations, and prints one line per issue.
    `wanted` is None to leave the blocked_by relations alone."""
    by_number = {i.number: i for i in state.free}
    queue = state.fixed + [by_number[n] for n in order]
    slots = allocate(queue, groups, base)
    issue_ms = {i.number: i.milestone_number for i in queue}
    ops, errors = plan_writes(slots, state.milestones, issue_ms)
    if errors:
        raise PlanError(errors)
    add, remove = ([], []) if wanted is None else diff_relations(
        [i.number for i in state.free], {i.number: i.blocked_by for i in state.free}, wanted
    )
    lines = result_lines(slots, state.issues, reasons)

    if dry_run:
        for op in ops:
            print("# " + describe(op), file=sys.stderr)
        for n, b in add:
            print(f"# #{n} blocked by #{b}: add", file=sys.stderr)
        for n, b in remove:
            print(f"# #{n} blocked by #{b}: remove", file=sys.stderr)
    else:
        run_ops(state, ops)
        for n, b in add:
            api(f"repos/{state.repo}/issues/{n}/dependencies/blocked_by", "POST", {"issue_id": state.ids[b]})
        for n, b in remove:
            api(f"repos/{state.repo}/issues/{n}/dependencies/blocked_by/{state.ids[b]}", "DELETE")
    print("\n".join(lines))


# ---- commands ----


def issue_json(i):
    return {
        "number": i.number,
        "title": i.title,
        "body": i.body,
        "labels": i.labels,
        "urgency": "high" if urgent(i) else "normal",
        "importance": importance(i),
        "pin": has(i, "release:pin"),
        "milestone": i.milestone,
        "createdAt": i.created_at,
        "blocked_by": sorted(i.blocked_by),
    }


def cmd_snapshot(args):
    state = load_state()
    print(f"skipped {state.skipped} issues of other authors", file=sys.stderr)
    print(
        json.dumps(
            {
                "last_tag": state.base,
                "fixed": [issue_json(i) for i in state.fixed],
                "free": [issue_json(i) for i in state.free],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_apply(args):
    try:
        with open(args.plan, encoding="utf-8") as f:
            plan = json.load(f)
    except (OSError, ValueError) as e:
        raise PlanError([f"{args.plan}: {e}"])
    state = load_state()
    refuse_missing_size(state)
    problems = validate_plan(plan, state.free, state.fixed, state.states)
    if problems:
        raise PlanError(problems)
    wanted = {int(k): [int(b) for b in v] for k, v in plan.get("blocked_by", {}).items()}
    execute(
        state,
        [int(n) for n in plan["order"]],
        [[int(n) for n in g] for g in plan.get("groups", [])],
        wanted,
        plan.get("reasons", {}),
        state.base,
        args.dry_run,
    )


def sync(args, base=None):
    state = load_state()
    refuse_missing_size(state)
    execute(state, [i.number for i in state.free], derive_groups(state.free), None, {}, base or state.base, args.dry_run)


def cmd_sync(args):
    sync(args)


def cmd_close(args):
    tag = args.tag
    repo = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").strip()
    if tag not in [t["name"] for t in api(f"repos/{repo}/tags?per_page=100", paginate=True)]:
        raise PlanError([f"tag {tag} does not exist on GitHub"])
    state = load_state()
    refuse_missing_size(state)
    versions = sorted(
        (parse_version(m["title"]), m) for m in state.milestones if m["state"] == "open" and parse_version(m["title"])
    )
    if versions:
        low = versions[0][1]
        holder = next((m for m in state.milestones if m["title"] == tag and m["number"] != low["number"]), None)
        if holder and holder["state"] != "open":
            raise PlanError([f"{tag} is held by the closed milestone #{holder['number']}"])
        for i in state.issues.values():
            if i.state == "open" and i.milestone_number == low["number"]:
                api(f"repos/{repo}/issues/{i.number}", "PATCH", {"milestone": None})
        if holder:
            api(f"repos/{repo}/milestones/{holder['number']}", "PATCH", {"title": f"{TMP_PREFIX}{holder['number']}"})
        fields = {"state": "closed"}
        if low["title"] != tag:
            fields["title"] = tag
        api(f"repos/{repo}/milestones/{low['number']}", "PATCH", fields)
        print(f"closed milestone {tag}", file=sys.stderr)
    sync(args, base=tag)


def cmd_next(args):
    state = load_state()
    mine = {int(n) for n in args.mine.replace(" ", "").split(",") if n}
    worktrees = worktree_issues(subprocess.run(["git", "worktree", "list", "--porcelain"], capture_output=True, text=True).stdout)
    print(
        json.dumps(
            build_next(list(state.issues.values()), state.milestones, state.pr_closing, worktrees, mine),
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_release_facts(args):
    state = load_state()
    labels = json.loads(gh("pr", "list", "--state", "open", "--head", "release/next", "--json", "author,labels"))
    labels = [label["name"] for p in labels if p["author"]["login"] == state.owner for label in p["labels"]]
    try:
        now = parse_time(args.now) if args.now else datetime.datetime.now(datetime.timezone.utc)
    except ValueError as e:
        raise PlanError([f"--now: {e}"])
    waiting = [i for i in state.issues.values() if is_waiting(i)]
    print(json.dumps(release_facts(waiting, labels, now), ensure_ascii=False, indent=2))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("snapshot").set_defaults(fn=cmd_snapshot)
    a = sub.add_parser("apply")
    a.add_argument("plan")
    a.add_argument("--dry-run", action="store_true")
    a.set_defaults(fn=cmd_apply)
    s = sub.add_parser("sync")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_sync)
    c = sub.add_parser("close")
    c.add_argument("tag")
    c.set_defaults(fn=cmd_close, dry_run=False)
    n = sub.add_parser("next")
    n.add_argument("--mine", default="", help="issue numbers the previous hand-over lists as this run's own, such as 140,141")
    n.set_defaults(fn=cmd_next)
    r = sub.add_parser("release-facts")
    r.add_argument("--now", help="ISO time such as 2026-11-06T12:00:00Z; the time of the run when omitted")
    r.set_defaults(fn=cmd_release_facts)
    args = p.parse_args(argv)
    try:
        args.fn(args)
    except PlanError as e:
        for problem in e.problems:
            print(problem, file=sys.stderr)
        return 2
    except GhError as e:
        print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
