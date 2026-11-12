#!/usr/bin/env python3
"""Orders the open issues of cookapps, and tells a run what to start and what the owner has to release (issues.md).

Usage:
  plan-release.py snapshot
  plan-release.py apply <plan.json> [--dry-run]
  plan-release.py unsplit [--mine <issue numbers>]
  plan-release.py migrate [--dry-run]
  plan-release.py split <split.json>
  plan-release.py next [--mine <issue numbers>]
  plan-release.py release
  plan-release.py close [--dry-run]

`snapshot` prints the open issues the planner orders. `apply` leaves out of the plan the closed issues and the fixed ones (stderr says which), writes the
`blocked_by` relations, and, unless --dry-run, saves the plan it accepted as `.claude/plan.json` of the main checkout. `next` reads that plan:
`start` lists the issues a run may begin, in the order of the plan (the point:8 unit rule applies only when NIGHTLY_DEADLINE_EPOCH is set, that is, in the night run). `unsplit` prints the issues of `point:5` or `point:8` that no one has split yet
(open, no `needs:owner`, not in hand, and no milestone named for a feature; a milestone named for a version is no mark): `issue-plan` applies its step 3 to each before it orders.
`split` splits a big issue into parts (`issue-plan` step 3): the file is JSON, {"issue": n, "milestone": "feature", "parts": [{"title", "body", "labels", "points_reason"}]}.
It checks everything before it writes (the issue is open and the owner's, each part has exactly one `point:*` of 3 or less, the labels exist, a part of a point:8 issue has `solo`), makes the milestone and `solo` when they are missing,
creates the parts in order, each with the reason of its points as a comment, and closes the issue as not planned only when every part exists; a failure stops it with the numbers made, and a second run keeps the parts
that are already open in the milestone under the same title. With no parts it only puts the issue in the milestone.
`migrate` is run once after the milestones named for versions are retired: it takes such a milestone off the open issues of less than 5 points and closes the ones left empty (it splits nothing). `release` prints the changes that wait for the owner's merge of the Release PR, the Release PR,
the tag that is due after a merge (the workflow tags at the merge, so it shows only until it has, or when it did not), and the release whose follow-up is open (its tag exists, and the issues are not commented yet). `close` closes the milestones (a milestone is a feature, not a version) whose issues are all done and released.
Talks to GitHub only through `gh`, so it runs from any checkout. Exit 2: the plan or the state is refused (stderr says why).
"""
import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field

PLAN_FILE = os.path.join(".claude", "plan.json")
RELEASE_BRANCH = "release/next"


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


def bump(version, minor):
    major, mi, pa = version
    return (major, mi + 1, 0) if minor else (major, mi, pa + 1)


def has(issue, label):
    return label in issue.labels


QUICK_POINTS = ("point:1", "point:2", "point:3")
ALL_POINTS = ("point:1", "point:2", "point:3", "point:5", "point:8")


def quick_bug(issue):
    """A bug of 1, 2 or 3 points goes to the front of its tier; a bug of 5 or 8 points does not."""
    return has(issue, "bug") and any(has(issue, label) for label in QUICK_POINTS)


def solo(issue):
    """A member of a unit that is a release of its own: an issue of 8 points, or a part (`solo`) of a point:8 issue that `issue-plan` split.
    The unit is that one point:8 issue, or all the `solo` parts of one milestone. Only the night run keeps a unit apart from everything else (issues.md):
    `nightly-limit.sh` and `build_next` do so when NIGHTLY_DEADLINE_EPOCH is set, and a session of the owner does not."""
    return has(issue, "point:8") or has(issue, "solo")


def urgent(issue):
    return has(issue, "urgency:high")


def importance(issue):
    return "high" if has(issue, "importance:high") else "low" if has(issue, "importance:low") else "normal"


def tier(issue):
    """The tier of the order (issues.md), 0 first: urgency high and importance high, urgency high only, importance high only, neither.
    A label that is missing is low, and `importance:low` is the same as none."""
    return (0 if urgent(issue) else 2) + (0 if has(issue, "importance:high") else 1)


def tier_label(issue):
    return f"urgency {'high' if urgent(issue) else 'low'}, importance {'high' if tier(issue) % 2 == 0 else 'low'}"


def points(issue):
    """The number of the `point:*` label, or None."""
    return next((int(label.split(":")[1]) for label in ALL_POINTS if has(issue, label)), None)


def counted(issue):
    return not has(issue, "documentation")


def missing_points(issues):
    return [i for i in issues if i.state == "open" and not any(label.startswith("point:") for label in i.labels)]


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


# ---- pure: queue ----

def base_key(i):
    """The basis of the order (issues.md): the tier, then a bug of 1, 2 or 3 points first, then an issue without `importance:low` before one with it, then fewer points first, then the older issue first."""
    return (tier(i), not quick_bug(i), importance(i) == "low", points(i) or 99, i.created_at, i.number)


def base_order(free):
    """The order the planner starts from: by `base_key`. An issue that waits for free issues takes them (and theirs, through the chain) with it, each before the issue that waits for it."""
    ordered = sorted(free, key=base_key)
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

    for i in ordered:
        take(i)
    return lead


def is_waiting(i):
    """A merged change not released yet: closed as completed after the last release. An issue closed as not planned (wontfix) is no change."""
    return i.state == "closed" and i.state_reason == "completed"


def release_changes(issues):
    """The changes the Release PR carries: merged, not released, and not only documentation, the oldest first."""
    return sorted((i for i in issues if is_waiting(i) and counted(i)), key=lambda i: (i.closed_at or "", i.number))


def split_issues(issues, pr_closing):
    """-> waiting, in progress, the rest. Issues closed as completed are the waiting ones."""
    waiting = sorted((i for i in issues if is_waiting(i)), key=lambda i: (i.closed_at or "", i.number))
    open_ = [i for i in issues if i.state == "open"]
    in_progress = sorted((i for i in open_ if i.number in pr_closing), key=lambda i: (i.created_at, i.number))
    rest = [i for i in open_ if i.number not in pr_closing]
    return waiting, in_progress, rest


# ---- pure: validation of a plan ----


def _int(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return None


def parse_plan(plan):
    """-> (problem, order, blocked_by), the numbers as ints. `problem` is a message when the shape is wrong, and the rest is then None.
    Keys of an older plan that are not used any more (`groups`, `touches`) are ignored."""
    bad = (None, None)
    if not isinstance(plan, dict):
        return ("plan: not a JSON object", *bad)
    order = plan.get("order")
    if not isinstance(order, list) or any(_int(n) is None for n in order):
        return ("plan.order: must be a list of issue numbers", *bad)
    blocked_by = plan.get("blocked_by", {})
    if not isinstance(blocked_by, dict) or any(
        _int(k) is None or not isinstance(v, list) or any(_int(b) is None for b in v) for k, v in blocked_by.items()
    ):
        return ("plan.blocked_by: must map an issue number to a list of issue numbers", *bad)
    return (None, [_int(n) for n in order], {_int(k): [_int(b) for b in v] for k, v in blocked_by.items()})


def validate_plan(plan, free, fixed, states):
    """-> list of problems. `states` maps an issue number to "open" or "closed"."""
    problem, order, blocked_by = parse_plan(plan)
    if problem:
        return [problem]

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

    for n, blockers in sorted(blocked_by.items()):
        if n not in free_by:
            problems.append(f"blocked_by: #{n} is not an issue to plan")
            continue
        for b in blockers:
            state = states.get(b)
            if state is None:
                problems.append(f"blocked_by: #{n} names #{b}, which is unknown")
            elif state == "open" and b in free_by and position.get(b, -1) >= position.get(n, -1):
                problems.append(f"blocked_by: #{b} blocks #{n} but is not placed earlier in order")
            elif state == "open" and b not in free_by and b not in fixed_nums:
                problems.append(f"blocked_by: #{n} names #{b}, which is open but not planned")

    # An issue comes before every issue of a lower tier (urgency, then importance), and a bug of 1, 2 or 3 points comes before every other issue of its tier.
    # The issues that block it, or that block an earlier issue, may stand before it.
    def front(member, allowed, message):
        needed = set()
        for k, n in enumerate(order):
            if n not in free_by:
                continue
            todo = [n]
            while todo:
                for b in blocked_by.get(todo.pop(), []):
                    if b not in needed and b in free_by:
                        needed.add(b)
                        todo.append(b)
            if not member(free_by[n]):
                continue
            late = next((m for m in order[:k] if m in free_by and not allowed(free_by[m], free_by[n]) and m not in needed), None)
            if late is not None:
                problems.append(message(n, late))

    for t in range(3):
        front(
            lambda i, t=t: tier(i) == t,
            lambda m, n: tier(m) <= tier(n),
            lambda n, late: f"order: #{n} ({tier_label(free_by[n])}) is placed after #{late} ({tier_label(free_by[late])})",
        )
    front(
        quick_bug,
        lambda m, n: quick_bug(m) or tier(m) != tier(n),
        lambda n, late: f"order: #{n} is a bug of 1, 2 or 3 points but is placed after #{late}, which is not one, in the same tier",
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


def mentioned(plan):
    """The issue numbers a well-formed plan names in order, the keys of blocked_by and the keys of reasons, once each, in that sequence.
    The issues named as blockers are not counted: a blocker may be closed."""
    problem, order, blocked_by = parse_plan(plan)
    if problem:
        return []
    reasons = plan.get("reasons", {})
    keys = [_int(k) for k in reasons] if isinstance(reasons, dict) else []
    out = []
    for n in order + list(blocked_by) + [k for k in keys if k is not None]:
        if n not in out:
            out.append(n)
    return out


def blockers(plan):
    """The issue numbers a well-formed plan names as blockers in the lists of blocked_by, once each, sorted."""
    problem, _, blocked_by = parse_plan(plan)
    return [] if problem else sorted({b for v in blocked_by.values() for b in v})


def prune_plan(plan, states, fixed_numbers):
    """-> (the plan without the fixed issues and the closed ones, [(number, "fixed" | "closed")]).
    They leave order, the keys of blocked_by and the keys of reasons.
    Only a closed issue also leaves the blockers in the lists of blocked_by (a key left with no blocker goes too): a fixed issue is still open, and its dependency is real.
    A number nobody knows stays, for the validation to refuse. A plan of the wrong shape is returned as it is."""
    problem, order, blocked_by = parse_plan(plan)
    if problem:
        return plan, []

    def why(n):
        return "fixed" if n in fixed_numbers else "closed" if states.get(n) == "closed" else None

    dropped = [(n, why(n)) for n in mentioned(plan) if why(n)]
    gone = {n for n, _ in dropped}
    pruned = dict(
        plan,
        order=[n for n in order if n not in gone],
        blocked_by={str(k): left for k, v in blocked_by.items() if k not in gone and (left := [b for b in v if states.get(b) != "closed"])},
    )
    if isinstance(plan.get("reasons"), dict):
        pruned["reasons"] = {k: v for k, v in plan["reasons"].items() if _int(k) not in gone}
    return pruned, dropped


def diff_relations(free_numbers, current, wanted):
    """-> (add, remove) as (blocked, blocker) pairs, for the free issues only."""
    add, remove = [], []
    for n in sorted(free_numbers):
        want = set(wanted.get(n, []))
        have = set(current.get(n, []))
        add += [(n, b) for b in sorted(want - have)]
        remove += [(n, b) for b in sorted(have - want)]
    return add, remove


def result_lines(order, issues, reasons):
    lines = []
    for k, n in enumerate(order, 1):
        line = f"{k}. #{n} {issues[n].title}"
        if issues[n].milestone:
            line += f" [{issues[n].milestone}]"
        if reasons.get(str(n)):
            line += f" - {reasons[str(n)]}"
        lines.append(line)
    return lines


# ---- pure: next ----


def plan_positions(plan):
    """-> {issue number: position in order} of a saved plan; empty without a usable plan."""
    problem, order, _ = parse_plan(plan)
    return {} if problem else {n: k for k, n in enumerate(order)}


def unsplit(issues, pr_closing=frozenset(), mine=frozenset()):
    """The open issues of 5 or 8 points that wait for `issue-plan` step 3: no needs:owner (the owner has not settled it), not in hand (`pr_closing`, `mine`),
    and no milestone of a feature. The mark of a split issue, or of one kept whole, is a milestone named for a feature; a milestone named for a version is the old mechanism and is no mark."""
    return [
        i
        for i in issues
        if i.state == "open"
        and points(i) in (5, 8)
        and not has(i, "needs:owner")
        and i.number not in pr_closing
        and i.number not in mine
        and (not i.milestone or parse_version(i.milestone))
    ]


def migration(issues, milestones):
    """-> {"clear": numbers, "close": titles}: the move from the milestones named for versions to the ones named for features (issues.md).
    `clear`: the open issues of less than 5 points (or with no points yet) that sit in a milestone named for a version; they belong to no feature.
    `close`: the open milestones named for a version that no open issue will be left in. `milestones`: the open milestones of the API, with `open_issues`.
    An issue of 5 or 8 points keeps its milestone here: `unsplit` and `issue-plan` step 3 move it."""
    clear = sorted(
        i.number for i in issues if i.state == "open" and parse_version(i.milestone) and points(i) not in (5, 8)
    )
    cleared = Counter(i.milestone for i in issues if i.number in clear)
    close = [
        m["title"]
        for m in milestones
        if parse_version(m["title"]) and m["open_issues"] - cleared[m["title"]] <= 0
    ]
    return {"clear": clear, "close": close}


def build_next(issues, pr_closing, mine=frozenset(), plan=None, night=True):
    """What a run does with the open issues. One worktree and one branch carry the run, so there is no parallel set: `start` is the queue.
    `mine`: the issues the previous hand-over lists as this run's own; they are `in_progress` (continue them first).
    `held`: an open pull request of the owner closes the issue and it is not `mine`: someone else's work, left alone.
    `start`: the other issues that can begin, by the order of the saved plan (the issues the plan lacks come last, by `base_key`).
    An issue with needs:owner, and one with an open blocker, are left out. In the night run (`night`; cmd_next takes it from NIGHTLY_DEADLINE_EPOCH, as nightly-limit.sh does), a member of a solo unit
    (point:8, or a `solo` part) is left out too while a change waits for the release. A session of the owner has no unit rule (issues.md): it may bundle issues of any units.
    `stop` says why `start` is empty on purpose: a change of a solo unit waits for the owner's merge, and nothing new begins before it (the rest of its unit included); the night run only.
    `waiting` are the changes that wait for the release."""
    position = plan_positions(plan)
    waiting = release_changes(issues)

    def brief(i):
        return {"number": i.number, "title": i.title, "labels": i.labels, "points": points(i)}

    def start_key(i):
        if i.number in position:
            return (0, position[i.number], (), 0)
        return (1, 0, base_key(i), i.number)

    out = {
        "start": [],
        "in_progress": [],
        "held": [],
        "needs_owner": [],
        "blocked": [],
        "waits_for_release": [],
        "waiting": [dict(brief(i), closed_at=i.closed_at) for i in waiting],
        "stop": None,
    }
    startable = []
    for i in sorted((i for i in issues if i.state == "open"), key=lambda i: (i.created_at, i.number)):
        if i.number in mine:
            out["in_progress"].append(brief(i))
        elif i.number in pr_closing:
            out["held"].append(dict(brief(i), reason="pull request open"))
        elif has(i, "needs:owner"):
            out["needs_owner"].append(brief(i))
        elif i.blocked_by:
            out["blocked"].append({"number": i.number, "title": i.title, "blocked_by": sorted(i.blocked_by)})
        elif night and solo(i) and waiting:
            out["waits_for_release"].append(i.number)
        else:
            startable.append(i)
    if night and any(solo(i) for i in waiting):
        out["stop"] = "a point:8 change (or a part of one, labelled solo) waits for the owner to merge the Release PR; start nothing new"
        return out
    startable.sort(key=start_key)
    out["start"] = [brief(i) for i in startable]
    return out


# ---- pure: release ----


def release_facts(issues, release_pr, last_tag):
    """The figures a run needs to prepare the Release PR.
    `issues`: the owner's issues (the waiting ones are picked from them). `release_pr`: {"number", "title", "url", "labels"} of the open Release PR, or None.
    `urgent`: a change that waits has urgency:high, or is a bug with importance:high, or the Release PR has urgency:high; the run tells the owner at once.
    `minor`: a change adds a requirement ID (issues.md checks the label against requirements/). `version`: the version the Release PR writes as the first heading of CHANGELOG.md."""
    changes = release_changes(issues)
    labels = (release_pr or {}).get("labels", [])
    minor = any(has(i, "adds:requirement") for i in changes)
    base = parse_version(last_tag) or (0, 0, 0)
    return {
        "last_tag": last_tag,
        "changes": [
            {"number": i.number, "title": i.title, "labels": i.labels, "points": points(i), "closed_at": i.closed_at} for i in changes
        ],
        "release_pr": release_pr and {k: release_pr[k] for k in ("number", "title", "url")},
        "urgent": "urgency:high" in labels or any(urgent(i) or (has(i, "bug") and has(i, "importance:high")) for i in changes),
        "solo": any(solo(i) for i in changes),
        "minor": minor,
        "version": format_version(bump(base, minor)) if changes else None,
    }


def with_tag_due(facts, due):
    """Adds `tag_due` to the facts. While a tag is due (the owner has merged the Release PR and the tag is not made), what is counted from the last tag is the merged Release PR itself,
    so `changes`, `urgent`, `solo`, `minor` and `version` are emptied: the tag comes first, and `release` runs again after it."""
    facts["tag_due"] = due
    if due:
        facts.update(changes=[], urgent=False, solo=False, minor=False, version=None)
    return facts


def changelog_version(text):
    """The version of the first `## v{version}` heading of a CHANGELOG.md, or None. The Release PR writes it, and the tag is taken from it (versioning.md)."""
    m = re.search(r"^## v(\d+\.\d+\.\d+)[ \t]*$", text, re.MULTILINE)
    return m.group(1) if m else None


def newest_release(merged_prs, read_version):
    """-> {"tag", "commit", "pr"} of the newest merged Release PR, with the tag of the version it wrote, or None.
    `merged_prs`: [{"number", "mergedAt", "mergeCommit": {"oid"}}] of the owner's merged Release PRs. `read_version(oid)`: the version of the first heading of CHANGELOG.md at that commit.
    The tag goes on the merge commit of the Release PR, not on origin/main, which may have moved on (versioning.md)."""
    if not merged_prs:
        return None
    newest = max(merged_prs, key=lambda p: p["mergedAt"])
    oid = (newest.get("mergeCommit") or {}).get("oid")
    version = read_version(oid) if oid else None
    if not version:
        return None
    return {"tag": f"v{version}", "commit": oid, "pr": newest["number"]}


def tag_due(merged_prs, tag_names, read_version):
    """-> the newest merged Release PR (see newest_release) when its version has no tag yet, else None.
    release.yml tags the merge commit at the merge (issues.md), so this shows only until it has, or when the workflow did not: the way back is a tag by hand."""
    due = newest_release(merged_prs, read_version)
    return due if due and due["tag"] not in tag_names else None


def follow_up_due(merged_prs, tag_names, read_version, is_marked):
    """-> the newest merged Release PR (see newest_release) when its tag exists and `is_marked(pr, tag)` is false, else None.
    The workflow tags at the merge, so nobody sees the tag come: the follow-up (the comment on each issue of the Release PR) is open until the agent that did it marks the Release PR."""
    due = newest_release(merged_prs, read_version)
    return due if due and due["tag"] in tag_names and not is_marked(due["pr"], due["tag"]) else None


def follow_up_mark(tag):
    """The first line of the comment on a Release PR that says its follow-up is done."""
    return f"<!-- released {tag} -->"


def done_milestones(milestones, issues):
    """-> the open milestones to close: they hold closed issues and no open one, and none of their issues waits for the release."""
    waiting = {i.milestone for i in issues if is_waiting(i)}
    return [m for m in milestones if m["open_issues"] == 0 and m["closed_issues"] > 0 and m["title"] not in waiting]


# ---- pure: split ----

SOLO_DESCRIPTION = "a part of a point:8 issue: the parts are a release of their own"


def parse_split(raw):
    """-> (problems, spec). `spec` is {"issue": int, "milestone": str, "parts": [{"title", "body", "labels", "points_reason"}]} when the shape is right."""
    if not isinstance(raw, dict):
        return ["split: not a JSON object"], None
    problems = []
    n = raw.get("issue")
    if not isinstance(n, int) or isinstance(n, bool) or n <= 0:
        problems.append("split.issue: must be an issue number")
    milestone = raw.get("milestone")
    if not isinstance(milestone, str) or not milestone.strip():
        problems.append("split.milestone: must be the name of the feature")
    parts = raw.get("parts")
    if not isinstance(parts, list):
        problems.append("split.parts: must be a list (empty when the issue cannot be split)")
        parts = []
    out = []
    for k, part in enumerate(parts, 1):
        where = f"split.parts[{k}]"
        if not isinstance(part, dict):
            problems.append(f"{where}: not an object")
            continue
        title, body, labels, reason = (part.get(key) for key in ("title", "body", "labels", "points_reason"))
        if not isinstance(title, str) or not title.strip():
            problems.append(f"{where}.title: must be a text")
        if not isinstance(body, str):
            problems.append(f"{where}.body: must be a text")
        if not isinstance(labels, list) or any(not isinstance(label, str) or not label.strip() for label in labels):
            problems.append(f"{where}.labels: must be a list of label names")
        if not isinstance(reason, str) or not reason.strip():
            problems.append(f"{where}.points_reason: must be a text")
    if problems:
        return problems, None
    return [], {
        "issue": n,
        "milestone": milestone.strip(),
        "parts": [
            {"title": p["title"].strip(), "body": p["body"], "labels": list(dict.fromkeys(p["labels"])), "points_reason": p["points_reason"].strip()}
            for p in parts
        ],
    }


def split_problems(spec, parent, owner, repo_labels):
    """-> every reason the split must not start. `parent`: the issue as the REST API gives it. `repo_labels`: the names of the labels of the repository."""
    problems = []
    n = spec["issue"]
    if parent.get("pull_request"):
        problems.append(f"#{n} is a pull request")
    if parent.get("state") != "open":
        problems.append(f"#{n} is not open")
    if (parent.get("user") or {}).get("login") != owner:
        problems.append(f"#{n} is not an issue of the owner")
    parent_labels = [label["name"] for label in parent.get("labels", [])]
    big = "point:8" in parent_labels
    known = set(repo_labels)
    titles = Counter(p["title"] for p in spec["parts"])
    for title, c in sorted(titles.items()):
        if c > 1:
            problems.append(f"parts: the title '{title}' appears twice")
    for k, part in enumerate(spec["parts"], 1):
        where = f"part {k} ({part['title']})"
        marks = [label for label in part["labels"] if label.startswith("point:")]
        if len(marks) != 1:
            problems.append(f"{where}: needs exactly one point:* label, has {len(marks)}")
        elif marks[0] not in QUICK_POINTS:
            problems.append(f"{where}: {marks[0]} is more than point:3")
        for label in part["labels"]:
            if label != "solo" and label not in known:
                problems.append(f"{where}: the label '{label}' does not exist")
        if big and "solo" not in part["labels"]:
            problems.append(f"{where}: #{n} is point:8, so every part needs the label solo")
    return problems


def split_comment(numbers):
    return "部品に分けました: " + "、".join(f"#{n}" for n in numbers)


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
    last_tag: str | None
    issues: dict  # owner's open issues, and the ones closed since the last release
    fixed: list
    free: list
    pr_closing: set
    ids: dict  # issue number -> database id
    states: dict  # issue number -> "open" | "closed"
    skipped: int
    tags: list  # the names of the tags


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


def released_at(repo, tags, last_tag):
    """The time of the commit the last tag names: the merge of its Release PR. What closed after it waits for the next release."""
    sha = next((t["commit"]["sha"] for t in tags if t["name"] == last_tag), None)
    return api(f"repos/{repo}/commits/{sha}")["commit"]["committer"]["date"] if sha else None


def load_state(blockers=True):
    """`blockers` False leaves `blocked_by` empty: only `snapshot`, `apply` and `next` read it, and it costs one request for each open issue."""
    repo = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").strip()
    owner = gh("repo", "view", "--json", "owner", "--jq", ".owner.login").strip()
    tags = api(f"repos/{repo}/tags?per_page=100", paginate=True)
    names = [t["name"] for t in tags]
    last_tag = highest_tag(names)
    since = released_at(repo, tags, last_tag) if last_tag else None

    raw = [r for r in api(f"repos/{repo}/issues?state=open&per_page=100", paginate=True) if "pull_request" not in r]
    if since:
        raw += [
            r
            for r in api(f"repos/{repo}/issues?state=closed&since={since}&per_page=100", paginate=True)
            if "pull_request" not in r and (r.get("closed_at") or "") > since
        ]
    skipped = sum(1 for r in raw if r["user"]["login"] != owner)
    issues = {r["number"]: to_issue(r) for r in raw if r["user"]["login"] == owner}

    ids = {n: i.id for n, i in issues.items()}
    states = {n: i.state for n, i in issues.items()}
    # The list already says how many blockers an issue has, open or closed; an issue with none is not asked.
    unblocked = {r["number"] for r in raw if (r.get("issue_dependencies_summary") or {}).get("total_blocked_by") == 0}
    for n, i in issues.items():
        if not blockers or i.state != "open" or n in unblocked:
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
        last_tag=last_tag,
        issues=issues,
        fixed=waiting + in_progress,
        free=base_order(rest),
        pr_closing=pr_closing,
        ids=ids,
        states=states,
        skipped=skipped,
        tags=names,
    )


def refuse_missing_points(state):
    bad = missing_points(state.issues.values())
    if bad:
        raise PlanError([f"#{i.number} has no point:* label; run the issue-plan skill" for i in bad])


# ---- commands ----


def issue_json(i):
    return {
        "number": i.number,
        "title": i.title,
        "body": i.body,
        "labels": i.labels,
        "urgency": "high" if urgent(i) else "normal",
        "importance": importance(i),
        "points": points(i),
        "milestone": None if parse_version(i.milestone) else i.milestone,
        "createdAt": i.created_at,
        "blocked_by": sorted(i.blocked_by),
    }


def cmd_snapshot(args):
    state = load_state()
    print(f"skipped {state.skipped} issues of other authors", file=sys.stderr)
    print(
        json.dumps(
            {
                "last_tag": state.last_tag,
                "fixed": [issue_json(i) for i in state.fixed],
                "free": [issue_json(i) for i in state.free],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def plan_file(git_common_dir):
    """The saved plan lives in the main checkout, which is the parent of the common git directory."""
    return os.path.join(os.path.dirname(git_common_dir.rstrip("/")), PLAN_FILE)


def saved_plan_path():
    r = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True)
    if r.returncode != 0:
        raise GhError(f"git rev-parse: {r.stderr.strip()}")
    return plan_file(r.stdout.strip())


def save_plan(path, plan):
    """Writes through a temporary file and a rename, so that a reader never sees half a plan."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def read_plan(path):
    """-> the saved plan, or None when there is none, or when it is broken (one line on stderr says so)."""
    try:
        with open(path, encoding="utf-8") as f:
            plan = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        print(f"{path}: {e}; the plan is ignored", file=sys.stderr)
        return None
    problem = parse_plan(plan)[0]
    if problem:
        print(f"{path}: {problem}; the plan is ignored", file=sys.stderr)
        return None
    return plan


def closed_states(repo, numbers):
    """-> {number: "closed"} for the numbers GitHub says are closed. The issues closed before the last release are not in the state, and a plan made earlier may still name them."""
    out = {}
    for n in sorted(numbers):
        try:
            raw = api(f"repos/{repo}/issues/{n}")
        except GhError:
            continue
        if isinstance(raw, dict) and raw.get("state") == "closed":
            out[n] = "closed"
    return out


def cmd_apply(args):
    try:
        with open(args.plan, encoding="utf-8") as f:
            plan = json.load(f)
    except (OSError, ValueError) as e:
        raise PlanError([f"{args.plan}: {e}"])
    state = load_state()
    refuse_missing_points(state)
    states = dict(state.states)
    states.update(closed_states(state.repo, [n for n in {*mentioned(plan), *blockers(plan)} if n not in states]))
    plan, dropped = prune_plan(plan, states, {i.number for i in state.fixed})
    for n, why in dropped:
        print(f"dropped #{n} ({why})", file=sys.stderr)
    problems = validate_plan(plan, state.free, state.fixed, state.states)
    if problems:
        raise PlanError(problems)
    wanted = {int(k): [int(b) for b in v] for k, v in plan.get("blocked_by", {}).items()}
    order = [int(n) for n in plan["order"]]
    by_number = {i.number: i for i in state.free}
    add, remove = diff_relations([i.number for i in state.free], {i.number: i.blocked_by for i in state.free}, wanted)
    if args.dry_run:
        for n, b in add:
            print(f"# #{n} blocked by #{b}: add", file=sys.stderr)
        for n, b in remove:
            print(f"# #{n} blocked by #{b}: remove", file=sys.stderr)
    else:
        for n, b in add:
            api(f"repos/{state.repo}/issues/{n}/dependencies/blocked_by", "POST", {"issue_id": state.ids[b]})
        for n, b in remove:
            api(f"repos/{state.repo}/issues/{n}/dependencies/blocked_by/{state.ids[b]}", "DELETE")
    print("\n".join(result_lines(order, by_number, plan.get("reasons", {}))))
    if not args.dry_run:
        try:
            save_plan(saved_plan_path(), plan)
        except (OSError, GhError) as e:
            print(f"the plan was applied but not saved: {e}", file=sys.stderr)


def cmd_next(args):
    state = load_state()
    mine = {int(n) for n in args.mine.replace(" ", "").split(",") if n}
    plan = read_plan(saved_plan_path())
    print(json.dumps(build_next(list(state.issues.values()), state.pr_closing, mine, plan, night=bool(os.environ.get("NIGHTLY_DEADLINE_EPOCH"))), ensure_ascii=False, indent=2))


def cmd_unsplit(args):
    state = load_state(blockers=False)
    mine = {int(n) for n in args.mine.replace(" ", "").split(",") if n}
    found = [
        {"number": i.number, "title": i.title, "points": points(i), "milestone": i.milestone}
        for i in unsplit(list(state.issues.values()), state.pr_closing, mine)
    ]
    print(json.dumps(found, ensure_ascii=False, indent=2))


def cmd_migrate(args):
    state = load_state(blockers=False)
    milestones = api(f"repos/{state.repo}/milestones?state=open&per_page=100", paginate=True)
    moves = migration(list(state.issues.values()), milestones)
    by_title = {m["title"]: m["number"] for m in milestones}
    for n in moves["clear"]:
        if not args.dry_run:
            api(f"repos/{state.repo}/issues/{n}", "PATCH", {"milestone": None})
        print(f"took the milestone off #{n}")
    for title in moves["close"]:
        if not args.dry_run:
            api(f"repos/{state.repo}/milestones/{by_title[title]}", "PATCH", {"state": "closed"})
        print(f"closed milestone {title}")


def release_pr_of(owner):
    """-> the open Release PR of the owner, or None."""
    found = json.loads(gh("pr", "list", "--state", "open", "--head", RELEASE_BRANCH, "--json", "number,title,url,author,labels"))
    found = [p for p in found if p["author"]["login"] == owner]
    if not found:
        return None
    p = found[0]
    return {"number": p["number"], "title": p["title"], "url": p["url"], "labels": [label["name"] for label in p["labels"]]}


def cmd_release(args):
    state = load_state(blockers=False)
    facts = release_facts(list(state.issues.values()), release_pr_of(state.owner), state.last_tag)
    merged = json.loads(gh("pr", "list", "--state", "merged", "--head", RELEASE_BRANCH, "--limit", "10", "--json", "number,author,mergedAt,mergeCommit"))
    merged = [p for p in merged if p["author"]["login"] == state.owner]

    def read_version(oid):
        try:
            return changelog_version(gh("api", f"repos/{state.repo}/contents/CHANGELOG.md?ref={oid}", "-H", "Accept: application/vnd.github.raw+json"))
        except GhError:
            return None

    def is_marked(number, tag):
        comments = json.loads(gh("pr", "view", str(number), "--json", "comments"))["comments"]
        return any(c["author"]["login"] == state.owner and c["body"].startswith(follow_up_mark(tag)) for c in comments)

    with_tag_due(facts, tag_due(merged, state.tags, read_version))
    facts["follow_up"] = follow_up_due(merged, state.tags, read_version, is_marked)
    print(json.dumps(facts, ensure_ascii=False, indent=2))


def cmd_close(args):
    state = load_state(blockers=False)
    milestones = api(f"repos/{state.repo}/milestones?state=open&per_page=100", paginate=True)
    for m in done_milestones(milestones, state.issues.values()):
        if not args.dry_run:
            api(f"repos/{state.repo}/milestones/{m['number']}", "PATCH", {"state": "closed"})
        print(f"closed milestone {m['title']}")


def cmd_split(args):
    try:
        with open(args.file, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise PlanError([f"{args.file}: {e}"])
    problems, spec = parse_split(raw)
    if problems:
        raise PlanError(problems)
    repo = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").strip()
    owner = gh("repo", "view", "--json", "owner", "--jq", ".owner.login").strip()
    n = spec["issue"]
    try:
        parent = api(f"repos/{repo}/issues/{n}")
    except GhError as e:
        raise PlanError([f"#{n}: {e}"])
    repo_labels = [label["name"] for label in api(f"repos/{repo}/labels?per_page=100", paginate=True)]
    milestones = api(f"repos/{repo}/milestones?state=all&per_page=100", paginate=True)
    found = next((m for m in milestones if m["title"] == spec["milestone"]), None)
    problems = split_problems(spec, parent, owner, repo_labels)
    if found and found["state"] != "open":
        problems.append(f"the milestone '{spec['milestone']}' is closed")
    if problems:
        raise PlanError(problems)
    # The existing parts are read before anything is written, so that a failure here leaves nothing behind.
    kept = {}
    if found and spec["parts"]:
        for r in api(f"repos/{repo}/issues?milestone={found['number']}&state=open&per_page=100", paginate=True):
            if "pull_request" not in r and r["number"] != n and r["user"]["login"] == owner:
                kept.setdefault(r["title"], r["number"])

    made = []  # the numbers of the parts, made now or found
    try:
        if found:
            print(f"milestone {spec['milestone']} exists")
        else:
            api(f"repos/{repo}/milestones", "POST", {"title": spec["milestone"], "description": f"#{n} {parent['title']}"})
            print(f"made milestone {spec['milestone']}")
        if not spec["parts"]:
            gh("issue", "edit", str(n), "--milestone", spec["milestone"])
            print(f"put #{n} in the milestone; it was not split")
            return
        if any("solo" in p["labels"] for p in spec["parts"]) and "solo" not in repo_labels:
            gh("label", "create", "solo", "--description", SOLO_DESCRIPTION)
            print("made label solo")
        for part in spec["parts"]:
            if part["title"] in kept:
                made.append(kept[part["title"]])
                print(f"#{kept[part['title']]} {part['title']}: kept")
                continue
            args_ = ["issue", "create", "--title", part["title"], "--body", part["body"], "--milestone", spec["milestone"]]
            for label in part["labels"]:
                args_ += ["--label", label]
            printed = gh(*args_).strip().splitlines()
            url = printed[-1] if printed else ""
            number = re.search(r"/issues/(\d+)\s*$", url)
            if not number:
                raise GhError(f"gh issue create printed no issue URL: {url!r}")
            made.append(int(number.group(1)))
            print(f"#{made[-1]} {part['title']}: made")
            gh("issue", "comment", str(made[-1]), "--body", part["points_reason"])
        gh("issue", "close", str(n), "--reason", "not planned", "--comment", split_comment(made))
        print(f"closed #{n} as not planned")
    except GhError as e:
        raise GhError(f"{e}\nstopped: #{n} stays open; parts so far: {', '.join(f'#{m}' for m in made) or 'none'}")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("snapshot").set_defaults(fn=cmd_snapshot)
    a = sub.add_parser("apply")
    a.add_argument("plan")
    a.add_argument("--dry-run", action="store_true")
    a.set_defaults(fn=cmd_apply)
    n = sub.add_parser("next")
    n.add_argument("--mine", default="", help="issue numbers the previous hand-over lists as this run's own, such as 140,141")
    n.set_defaults(fn=cmd_next)
    u = sub.add_parser("unsplit")
    u.add_argument("--mine", default="", help="issue numbers the previous hand-over lists as this run's own, such as 140,141")
    u.set_defaults(fn=cmd_unsplit)
    m = sub.add_parser("migrate")
    m.add_argument("--dry-run", action="store_true")
    m.set_defaults(fn=cmd_migrate)
    sp = sub.add_parser("split")
    sp.add_argument("file")
    sp.set_defaults(fn=cmd_split)
    sub.add_parser("release").set_defaults(fn=cmd_release)
    c = sub.add_parser("close")
    c.add_argument("--dry-run", action="store_true")
    c.set_defaults(fn=cmd_close)
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
