#!/usr/bin/env python3
"""Lists the open issues of tsunagiai in the basic order, and tells a run what it may start and what waits for the release (.claude/rules/issues.md, "Order the issues"; .claude/skills/implement/SKILL.md; .claude/skills/release/SKILL.md for the release).

Usage:
  plan-release.py snapshot
  plan-release.py unsplit [--mine <issue numbers>]
  plan-release.py split <split.json>
  plan-release.py next [--mine <issue numbers>]
  plan-release.py claim --worktree <path> <issue number>...
  plan-release.py release
  plan-release.py close [--dry-run]

`snapshot` prints the open issues that `issue-ranker` ranks, in the basic order, and first closes as not planned the open issues of other authors (the pull requests are left alone), with a fixed comment and without reading their title or body (a failed close is told on stderr and does not stop it); it refuses an open issue of the owner that has no `point:*` label.
`next` lists in `start` the issues a run may begin, in the basic order. Nothing saves an order: the owner names the issues of each run (.claude/skills/implement/SKILL.md).
`claim` is how a session or a run tells the others that it took an issue: it makes `.claude/claims/{n}/owner` in the main checkout, holding the path of the worktree that works on it, and `next` leaves an issue whose owner worktree still exists out of `start` and lists it in `claimed`.
`claim` refuses an issue whose owner is another worktree that still exists (stderr says `#{n} claimed by {path}`, exit 3, and it still claims the others); a claim whose worktree is gone is stale and is taken over; `use-worktree.sh --park` deletes the claims of its worktree.
A parent is an issue with sub-issues (`sub_issues_summary.total` of the REST issue): the feature that its parts make. It is not ordered, not started and not counted as a change; its parts are.
`unsplit` prints the issues of `point:5` or `point:8` that no one has split yet
(open, not in hand, no sub-issue, no parent, and not labelled `whole`): `implement` applies `issue-plan` step 3 to each before it ranks the issues.
`split` splits a big issue into parts (`issue-plan` step 3): the file is JSON, {"issue": n, "parts": [{"title", "body", "labels", "points_reason"}]}; a `milestone` key is refused.
It checks everything before it writes (the issue is open and the owner's, has no parent, has no sub-issue other than parts it made earlier, each part has exactly one `point:*` of 3 or less, the labels exist, creates the parts in order as sub-issues of the issue (`gh issue create --parent`), each with the reason of its points as a comment, and comments the numbers of the parts on the issue, which stays open as their parent;
a failure stops it with the numbers made, and a second run keeps the parts that are already open sub-issues of the issue under the same title. With no parts it only puts the label `whole` on the issue (a big issue kept as one).
`release` prints the changes that wait for the merge of the Release PR, the Release PR,
the tag that is due after a merge (the workflow tags at the merge, so it shows only until it has, or when it did not), and the release whose follow-up is open (its tag exists, and the issues are not commented yet). `close` closes the parents (a parent is a feature, not a version) whose sub-issues are all closed and released.
Talks to GitHub only through `gh`, so it runs from any checkout. Exit 2: the input or the state is refused (stderr says why).
"""
import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

CLAIMS_DIR = os.path.join(".claude", "claims")
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
    created_at: str
    closed_at: str | None
    state: str
    state_reason: str | None = None  # "completed" or "not_planned" for a closed issue
    blocked_by: list = field(default_factory=list)  # numbers of the open blockers
    parent: int | None = None  # the number of the parent issue, when it is in this repository
    sub_issues: int = 0  # how many sub-issues the issue has; more than 0 makes it a parent


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


DEPENDABOT_MARK = re.compile(r"<!-- dependabot #\d+ -->")
QUICK_POINTS = ("point:1", "point:2", "point:3")
ALL_POINTS = ("point:1", "point:2", "point:3", "point:5", "point:8")


def dependabot(issue):
    """An issue made for a Dependabot pull request (`dependabot-issues.sh`): the label `dependencies`, or the mark `<!-- dependabot #N -->` in its body.
    It comes before every tier (.claude/rules/issues.md; at the owner's instruction, 2026-11-21; #1207)."""
    return has(issue, "dependencies") or DEPENDABOT_MARK.search(issue.body) is not None


def quick_bug(issue):
    """A bug of 1, 2 or 3 points goes to the front of its tier; a bug of 5 or 8 points does not."""
    return has(issue, "bug") and any(has(issue, label) for label in QUICK_POINTS)


def urgent(issue):
    return has(issue, "urgency:high")


def importance(issue):
    return "high" if has(issue, "importance:high") else "low" if has(issue, "importance:low") else "normal"


def tier(issue):
    """The tier of the order (.claude/rules/issues.md, "Order the issues"), 0 first: urgency high and importance high, urgency high only, importance high only, neither.
    A label that is missing is low, and `importance:low` is the same as none."""
    return (0 if urgent(issue) else 2) + (0 if has(issue, "importance:high") else 1)


PRIORITIES = ("priority:1", "priority:2", "priority:3")
NO_PRIORITY = len(PRIORITIES) + 1


def priority(issue):
    """The rank that the label `priority:1`, `priority:2` or `priority:3` gives within a tier (.claude/rules/issues.md), 1 first; an issue with none of them is after priority:3 (NO_PRIORITY).
    An issue with more than one takes the first of them."""
    return next((k for k, label in enumerate(PRIORITIES, 1) if has(issue, label)), NO_PRIORITY)


def priority_label(issue):
    return "no priority" if priority(issue) == NO_PRIORITY else PRIORITIES[priority(issue) - 1]


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
    """The basic order (.claude/rules/issues.md, "Order the issues"): a Dependabot issue first, then the tier, then the priority (`priority:1` first, none last), then a bug of 1, 2 or 3 points first, then an issue without `importance:low` before one with it, then fewer points first, then the older issue first."""
    return (not dependabot(i), tier(i), priority(i), not quick_bug(i), importance(i) == "low", points(i) or 99, i.created_at, i.number)


def base_order(free):
    """The basic order that `snapshot` and `next` print: by `base_key`. An issue that waits for free issues takes them (and theirs, through the chain) with it, each before the issue that waits for it."""
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


def is_parent(i):
    """The feature that its parts make: an issue with sub-issues. It is not ordered, not started and not a change (its parts are)."""
    return i.sub_issues > 0


def is_waiting(i):
    """A merged change not released yet: closed as completed after the last release. An issue closed as not planned (wontfix) is no change, and a parent is not one either."""
    return i.state == "closed" and i.state_reason == "completed" and not is_parent(i)


def release_changes(issues):
    """The changes the Release PR carries: merged, not released, and not only documentation, the oldest first."""
    return sorted((i for i in issues if is_waiting(i) and counted(i)), key=lambda i: (i.closed_at or "", i.number))


def split_issues(issues, pr_closing):
    """-> waiting, in progress, the rest. Issues closed as completed are the waiting ones. An open parent is none of them."""
    waiting = sorted((i for i in issues if is_waiting(i)), key=lambda i: (i.closed_at or "", i.number))
    open_ = [i for i in issues if i.state == "open" and not is_parent(i)]
    in_progress = sorted((i for i in open_ if i.number in pr_closing), key=lambda i: (i.created_at, i.number))
    rest = [i for i in open_ if i.number not in pr_closing]
    return waiting, in_progress, rest


# ---- pure: next ----


def unsplit(issues, pr_closing=frozenset(), mine=frozenset()):
    """The open issues of 5 or 8 points that wait for `issue-plan` step 3: not in hand (`pr_closing`, `mine`),
    no sub-issue, no parent (`split` refuses a part) and not labelled `whole`. The mark of a split issue is its sub-issues, and the mark of one kept as one is the label `whole`."""
    return [
        i
        for i in issues
        if i.state == "open"
        and points(i) in (5, 8)
        and i.number not in pr_closing
        and i.number not in mine
        and not is_parent(i)
        and i.parent is None
        and not has(i, "whole")
    ]


def build_next(issues, pr_closing, mine=frozenset(), claimed=None):
    """What a run does with the open issues. A run works in one worktree on one branch, so there is no parallel set: `start` is the queue.
    `mine`: the issues this run already has in hand; they are `in_progress` (continue them first).
    `claimed`: {issue number: the worktree that holds the claim}, only the claims whose worktree still exists (`read_claims`); another session works on those issues, so they are not in `start`, and `claimed` lists them.
    `held`: an open pull request of the owner closes the issue and it is not `mine`: someone else's work, left alone.
    `start`: the other issues that can begin, in the basic order (`base_key`).
    An issue with an open blocker is left out. A session may bundle issues of any points in one pull request (.claude/skills/implement/SKILL.md).
    `waiting` are the changes that wait for the release. A parent is in none of the lists: its parts are.
    """
    waiting = release_changes(issues)
    claimed = claimed or {}

    def brief(i):
        return {"number": i.number, "title": i.title, "labels": i.labels, "points": points(i)}

    out = {
        "start": [],
        "in_progress": [],
        "claimed": [],
        "held": [],
        "blocked": [],
        "waiting": [dict(brief(i), closed_at=i.closed_at) for i in waiting],
    }
    startable = []
    for i in sorted((i for i in issues if i.state == "open" and not is_parent(i)), key=lambda i: (i.created_at, i.number)):
        if i.number in mine:
            out["in_progress"].append(brief(i))
        elif i.number in claimed:
            out["claimed"].append(dict(brief(i), owner=claimed[i.number]))
        elif i.number in pr_closing:
            out["held"].append(dict(brief(i), reason="pull request open"))
        elif i.blocked_by:
            out["blocked"].append({"number": i.number, "title": i.title, "blocked_by": sorted(i.blocked_by)})
        else:
            startable.append(i)
    startable.sort(key=base_key)
    out["start"] = [brief(i) for i in startable]
    return out


# ---- pure: release ----


def release_facts(issues, release_pr, last_tag):
    """The figures a run needs to prepare the Release PR.
    `issues`: the owner's issues (the waiting ones are picked from them). `release_pr`: {"number", "title", "url", "labels"} of the open Release PR, or None.
    `urgent`: a change that waits has urgency:high, or is a bug with importance:high, or the Release PR has urgency:high; the session merges the Release PR as soon as it is ready either way.
    `minor`: a change adds a requirement ID (.claude/skills/release/SKILL.md checks the label against requirements/). `version`: the version the Release PR writes as the first heading of CHANGELOG.md."""
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
        "minor": minor,
        "version": format_version(bump(base, minor)) if changes else None,
    }


def with_tag_due(facts, due):
    """Adds `tag_due` to the facts. While a tag is due (the Release PR has been merged and the tag is not made), what is counted from the last tag is the merged Release PR itself,
    so `changes`, `urgent`, `minor` and `version` are emptied: the tag comes first, and `release` runs again after it."""
    facts["tag_due"] = due
    if due:
        facts.update(changes=[], urgent=False, minor=False, version=None)
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
    release.yml tags the merge commit at the merge (.claude/skills/release/SKILL.md), so this shows only until it has, or when the workflow did not: the way back is a tag by hand."""
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


def done_parents(parents, sub_issues, issues):
    """-> the open parents to close: every sub-issue is closed, and none of them waits for the release.
    `sub_issues`: {parent number: the REST issues of its sub-issues}. `issues`: the owner's issues of the state, where the waiting ones are found."""
    waiting = {i.number for i in issues if is_waiting(i)}
    return [
        p
        for p in parents
        if sub_issues.get(p.number) and all(s["state"] == "closed" and s["number"] not in waiting for s in sub_issues[p.number])
    ]


def close_comment():
    return "部品がすべてリリースされたので、この機能を閉じます"


def stranger_comment():
    return "このリポジトリは、オーナーが立てた issue だけで運用しています。外部から立てられた issue は自動で閉じます。"


# ---- pure: split ----

WHOLE_DESCRIPTION = "a big issue kept as one, not split into parts"


def parse_split(raw):
    """-> (problems, spec). `spec` is {"issue": int, "parts": [{"title", "body", "labels", "points_reason"}]} when the shape is right."""
    if not isinstance(raw, dict):
        return ["split: not a JSON object"], None
    problems = []
    n = raw.get("issue")
    if not isinstance(n, int) or isinstance(n, bool) or n <= 0:
        problems.append("split.issue: must be an issue number")
    if "milestone" in raw:
        problems.append("split.milestone: not accepted; the parts are the sub-issues of the issue")
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
        "parts": [
            {"title": p["title"].strip(), "body": p["body"], "labels": list(dict.fromkeys(p["labels"])), "points_reason": p["points_reason"].strip()}
            for p in parts
        ],
    }


def split_problems(spec, parent, owner, repo_labels, kept):
    """-> every reason the split must not start. `parent`: the issue as the REST API gives it. `repo_labels`: the names of the labels of the repository.
    `kept`: {title: number} of its open sub-issues made by the owner; a second run finds its own parts there, and an issue whose sub-issues are none of the parts is already split."""
    problems = []
    n = spec["issue"]
    if parent.get("pull_request"):
        problems.append(f"#{n} is a pull request")
    if parent.get("state") != "open":
        problems.append(f"#{n} is not open")
    if (parent.get("user") or {}).get("login") != owner:
        problems.append(f"#{n} is not an issue of the owner")
    if parent.get("parent_issue_url"):
        problems.append(f"#{n} already has a parent")
    if (parent.get("sub_issues_summary") or {}).get("total", 0) > 0 and not any(p["title"] in kept for p in spec["parts"]):
        problems.append(f"#{n} already has sub-issues that are none of these parts")
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
            if label not in known:
                problems.append(f"{where}: the label '{label}' does not exist")
    return problems


def split_comment(numbers):
    return "部品に分けました: " + "、".join(f"#{n}" for n in numbers)


# ---- gh ----


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise GhError(f"gh {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def parallel(calls, workers=10):
    """Runs the callables at the same time and returns their results in the order given.
    The first failure in that order is raised, after every call has ended."""
    if not calls:
        return []
    with ThreadPoolExecutor(max_workers=min(workers, len(calls))) as pool:
        futures = [pool.submit(c) for c in calls]
        return [f.result() for f in futures]


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
    strangers: list  # (number, login) of the open issues of other authors: only these two are read of them
    tags: list  # the names of the tags


def parent_number(url, repo):
    """The number of the parent a REST issue names in `parent_issue_url`, or None when it has none or the parent is in another repository."""
    m = re.fullmatch(r"https://api\.github\.com/repos/([^/]+/[^/]+)/issues/(\d+)", url or "")
    return int(m.group(2)) if m and m.group(1) == repo else None


def to_issue(raw, repo):
    return Issue(
        number=raw["number"],
        id=raw["id"],
        title=raw["title"],
        body=raw.get("body") or "",
        labels=[label["name"] for label in raw.get("labels", [])],
        created_at=raw["created_at"],
        closed_at=raw.get("closed_at"),
        state=raw["state"],
        state_reason=raw.get("state_reason"),
        parent=parent_number(raw.get("parent_issue_url"), repo),
        sub_issues=(raw.get("sub_issues_summary") or {}).get("total", 0),
    )


def released_at(repo, tags, last_tag):
    """The time of the commit the last tag names: the merge of its Release PR. What closed after it waits for the next release."""
    sha = next((t["commit"]["sha"] for t in tags if t["name"] == last_tag), None)
    return api(f"repos/{repo}/commits/{sha}")["commit"]["committer"]["date"] if sha else None


def read_tags_and_closed(repo):
    """-> (tags, since, closed issues): the tags, the time of the last release, and what closed after it.
    Each step needs the one before it, so they run in order."""
    tags = api(f"repos/{repo}/tags?per_page=100", paginate=True)
    last_tag = highest_tag([t["name"] for t in tags])
    since = released_at(repo, tags, last_tag) if last_tag else None
    closed = api(f"repos/{repo}/issues?state=closed&since={since}&per_page=100", paginate=True) if since else []
    return tags, since, closed


def load_state(blockers=True):
    """`blockers` False leaves `blocked_by` empty: only `snapshot` and `next` read it, and it costs one request for each open issue.
    The requests that do not depend on each other are made at the same time."""
    view, prs = parallel(
        [
            lambda: json.loads(gh("repo", "view", "--json", "nameWithOwner,owner")),
            lambda: json.loads(gh("pr", "list", "--state", "open", "--limit", "200", "--json", "author,closingIssuesReferences")),
        ]
    )
    repo = view["nameWithOwner"]
    owner = view["owner"]["login"]
    opened, (tags, since, closed) = parallel(
        [
            lambda: api(f"repos/{repo}/issues?state=open&per_page=100", paginate=True),
            lambda: read_tags_and_closed(repo),
        ]
    )
    names = [t["name"] for t in tags]
    last_tag = highest_tag(names)

    raw = [r for r in opened if "pull_request" not in r]
    raw += [r for r in closed if "pull_request" not in r and (r.get("closed_at") or "") > since]
    strangers = [(r["number"], r["user"]["login"]) for r in raw if r["state"] == "open" and r["user"]["login"] != owner]
    issues = {r["number"]: to_issue(r, repo) for r in raw if r["user"]["login"] == owner}

    # The list already says how many blockers an issue has, open or closed; an issue with none is not asked.
    unblocked = {r["number"] for r in raw if (r.get("issue_dependencies_summary") or {}).get("total_blocked_by") == 0}
    asked = [i for n, i in issues.items() if blockers and i.state == "open" and n not in unblocked]
    found = parallel([lambda n=i.number: api(f"repos/{repo}/issues/{n}/dependencies/blocked_by?per_page=100", paginate=True) for i in asked])
    for i, bs in zip(asked, found):
        for b in bs:
            if not b["repository_url"].endswith("/" + repo):
                continue
            if b["state"] == "open":
                i.blocked_by.append(b["number"])

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
        strangers=strangers,
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
        "dependabot": dependabot(i),
        "urgency": "high" if urgent(i) else "normal",
        "importance": importance(i),
        "priority": None if priority(i) == NO_PRIORITY else priority(i),
        "points": points(i),
        "parent": i.parent,
        "createdAt": i.created_at,
        "blocked_by": sorted(i.blocked_by),
    }


def cmd_snapshot(args):
    state = load_state()
    # An issue of another author is data (issues.md): only its number and author are read, never its title, body or comments.
    # A failed close is told and goes on: the output below leaves the issue out either way, and the next snapshot closes it again.
    for number, login in state.strangers:
        try:
            gh("issue", "close", str(number), "--reason", "not planned", "--comment", stranger_comment())
            print(f"closed #{number} of {login} (not the owner)", file=sys.stderr)
        except GhError as e:
            print(f"could not close #{number} of {login} (not the owner): {e}", file=sys.stderr)
    refuse_missing_points(state)
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


def git_common_dir():
    r = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True)
    if r.returncode != 0:
        raise GhError(f"git rev-parse: {r.stderr.strip()}")
    return r.stdout.strip()


# ---- claims: which worktree works on which issue ----


def claims_dir(git_common_dir):
    """The claims live in the main checkout: `.claude/claims/{n}/owner` holds the path of the worktree that works on issue n."""
    return os.path.join(os.path.dirname(git_common_dir.rstrip("/")), CLAIMS_DIR)


def live_worktrees(porcelain):
    """-> the real paths of the worktrees in the output of `git worktree list --porcelain`, without the ones whose directory is gone (git marks them `prunable`)."""
    live = set()
    for block in porcelain.split("\n\n"):
        lines = block.splitlines()
        path = next((line[len("worktree "):] for line in lines if line.startswith("worktree ")), None)
        if path is not None and not any(line == "prunable" or line.startswith("prunable ") for line in lines):
            live.add(os.path.realpath(path))
    return live


def read_owner(claim):
    try:
        with open(os.path.join(claim, "owner"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None


def read_claims(root, live):
    """-> {issue number: owner path} for the claims whose worktree still exists. A claim whose worktree is gone is stale and is not listed."""
    try:
        names = os.listdir(root)
    except FileNotFoundError:
        return {}
    found = {}
    for name in names:
        if name.isdigit():
            owner = read_owner(os.path.join(root, name))
            if owner in live:
                found[int(name)] = owner
    return found


def claim_issue(root, n, owner, live):
    """Claims issue n for the worktree `owner`. -> None when it is the owner's, or the path of the other worktree that holds it.
    Claimants take turns: each holds an exclusive `flock` on the claims directory while it reads the claim and changes it, so exactly one claimant wins, also at a stale claim (reading it and moving it away is no longer a gap that another claimant can use).
    The claim is made whole in a directory of its own and renamed into place, so a reader, which takes no lock, never sees a claim without its owner.
    A claim whose owner is no longer in `live` (or that has no owner) is stale: it is moved away and replaced."""
    os.makedirs(root, exist_ok=True)
    claim = os.path.join(root, str(n))
    fd = os.open(root, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        holder = read_owner(claim)
        if holder == owner:
            return None
        if holder in live:
            return holder
        tmp = tempfile.mkdtemp(prefix=".claim-", dir=root)
        with open(os.path.join(tmp, "owner"), "w", encoding="utf-8") as f:
            f.write(owner + "\n")
        if os.path.lexists(claim):
            gone = f"{claim}.stale-{uuid.uuid4().hex}"
            os.rename(claim, gone)
            shutil.rmtree(gone, ignore_errors=True)
        os.rename(tmp, claim)
        return None
    finally:
        os.close(fd)


def worktree_list():
    r = subprocess.run(["git", "worktree", "list", "--porcelain"], capture_output=True, text=True)
    if r.returncode != 0:
        raise GhError(f"git worktree list: {r.stderr.strip()}")
    return r.stdout


def cmd_claim(args):
    root = claims_dir(git_common_dir())
    live = live_worktrees(worktree_list())
    owner = os.path.realpath(args.worktree)
    if owner not in live:
        raise PlanError([f"{args.worktree} is not a worktree of this repository"])
    refused = False
    for n in args.issues:
        holder = claim_issue(root, n, owner, live)
        if holder is None:
            print(f"claimed #{n}")
        else:
            print(f"#{n} claimed by {holder}", file=sys.stderr)
            refused = True
    return 3 if refused else 0


def cmd_next(args):
    state = load_state()
    mine = {int(n) for n in args.mine.replace(" ", "").split(",") if n}
    claimed = read_claims(claims_dir(git_common_dir()), live_worktrees(worktree_list()))
    print(json.dumps(build_next(list(state.issues.values()), state.pr_closing, mine, claimed=claimed), ensure_ascii=False, indent=2))


def cmd_unsplit(args):
    state = load_state(blockers=False)
    mine = {int(n) for n in args.mine.replace(" ", "").split(",") if n}
    found = [
        {"number": i.number, "title": i.title, "points": points(i)}
        for i in unsplit(list(state.issues.values()), state.pr_closing, mine)
    ]
    print(json.dumps(found, ensure_ascii=False, indent=2))


def release_pr_of(owner, found):
    """-> the open Release PR of the owner among `found` (what `gh pr list --head release/next` printed, parsed), or None."""
    found = [p for p in found if p["author"]["login"] == owner]
    if not found:
        return None
    p = found[0]
    return {"number": p["number"], "title": p["title"], "url": p["url"], "labels": [label["name"] for label in p["labels"]]}


def cmd_release(args):
    state, open_prs, merged = parallel(
        [
            lambda: load_state(blockers=False),
            lambda: json.loads(gh("pr", "list", "--state", "open", "--head", RELEASE_BRANCH, "--json", "number,title,url,author,labels")),
            lambda: json.loads(gh("pr", "list", "--state", "merged", "--head", RELEASE_BRANCH, "--limit", "10", "--json", "number,author,mergedAt,mergeCommit")),
        ]
    )
    facts = release_facts(list(state.issues.values()), release_pr_of(state.owner, open_prs), state.last_tag)
    merged = [p for p in merged if p["author"]["login"] == state.owner]
    versions = {}  # commit -> version: tag_due and follow_up_due read the same one

    def read_version(oid):
        if oid not in versions:
            try:
                versions[oid] = changelog_version(gh("api", f"repos/{state.repo}/contents/CHANGELOG.md?ref={oid}", "-H", "Accept: application/vnd.github.raw+json"))
            except GhError:
                versions[oid] = None
        return versions[oid]

    def is_marked(number, tag):
        comments = json.loads(gh("pr", "view", str(number), "--json", "comments"))["comments"]
        return any(c["author"]["login"] == state.owner and c["body"].startswith(follow_up_mark(tag)) for c in comments)

    with_tag_due(facts, tag_due(merged, state.tags, read_version))
    facts["follow_up"] = follow_up_due(merged, state.tags, read_version, is_marked)
    print(json.dumps(facts, ensure_ascii=False, indent=2))


def cmd_close(args):
    state = load_state(blockers=False)
    open_children = {i.parent for i in state.issues.values() if i.state == "open" and i.parent}
    parents = [i for i in state.issues.values() if i.state == "open" and is_parent(i) and i.number not in open_children]
    found = parallel([lambda n=p.number: api(f"repos/{state.repo}/issues/{n}/sub_issues?per_page=100", paginate=True) for p in parents])
    for p in done_parents(parents, {p.number: subs for p, subs in zip(parents, found)}, state.issues.values()):
        if not args.dry_run:
            gh("issue", "close", str(p.number), "--reason", "completed", "--comment", close_comment())
        print(f"closed #{p.number} {p.title}")


def cmd_split(args):
    try:
        with open(args.file, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise PlanError([f"{args.file}: {e}"])
    problems, spec = parse_split(raw)
    if problems:
        raise PlanError(problems)
    view = json.loads(gh("repo", "view", "--json", "nameWithOwner,owner"))
    repo, owner = view["nameWithOwner"], view["owner"]["login"]
    n = spec["issue"]
    try:
        parent = api(f"repos/{repo}/issues/{n}")
    except GhError as e:
        raise PlanError([f"#{n}: {e}"])
    repo_labels = [label["name"] for label in api(f"repos/{repo}/labels?per_page=100", paginate=True)]
    # The existing parts are read before anything is written, so that a failure here leaves nothing behind.
    kept = {}
    if (parent.get("sub_issues_summary") or {}).get("total", 0) > 0:
        for r in api(f"repos/{repo}/issues/{n}/sub_issues?per_page=100", paginate=True):
            if r["state"] == "open" and r["user"]["login"] == owner:
                kept.setdefault(r["title"], r["number"])
    problems = split_problems(spec, parent, owner, repo_labels, kept)
    if problems:
        raise PlanError(problems)

    made = []  # the numbers of the parts, made now or found
    try:
        if not spec["parts"]:
            if "whole" not in repo_labels:
                gh("label", "create", "whole", "--description", WHOLE_DESCRIPTION)
                print("made label whole")
            gh("issue", "edit", str(n), "--add-label", "whole")
            print(f"labelled #{n} whole; it was not split")
            return
        for part in spec["parts"]:
            if part["title"] in kept:
                made.append(kept[part["title"]])
                print(f"#{kept[part['title']]} {part['title']}: kept")
                # A first run may have stopped at this part's comment, so the reason is written when it is not there.
                comments = api(f"repos/{repo}/issues/{kept[part['title']]}/comments?per_page=100", paginate=True)
                if not any(c["user"]["login"] == owner and c["body"].strip() == part["points_reason"].strip() for c in comments):
                    gh("issue", "comment", str(kept[part["title"]]), "--body", part["points_reason"])
                continue
            args_ = ["issue", "create", "--parent", str(n), "--title", part["title"], "--body", part["body"]]
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
        comment = split_comment(made)
        if not any(c["user"]["login"] == owner and c["body"].strip() == comment for c in api(f"repos/{repo}/issues/{n}/comments?per_page=100", paginate=True)):
            gh("issue", "comment", str(n), "--body", comment)
        print(f"commented the parts on #{n}; it stays open as their parent")
    except GhError as e:
        raise GhError(f"{e}\nstopped: parts so far: {', '.join(f'#{m}' for m in made) or 'none'}")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("snapshot").set_defaults(fn=cmd_snapshot)
    n = sub.add_parser("next")
    n.add_argument("--mine", default="", help="issue numbers this run already has in hand, such as 140,141")
    n.set_defaults(fn=cmd_next)
    u = sub.add_parser("unsplit")
    u.add_argument("--mine", default="", help="issue numbers this run already has in hand, such as 140,141")
    u.set_defaults(fn=cmd_unsplit)
    sp = sub.add_parser("split")
    sp.add_argument("file")
    sp.set_defaults(fn=cmd_split)
    cl = sub.add_parser("claim")
    cl.add_argument("--worktree", required=True, help="the worktree that works on the issues")
    cl.add_argument("issues", nargs="+", type=int)
    cl.set_defaults(fn=cmd_claim)
    sub.add_parser("release").set_defaults(fn=cmd_release)
    c = sub.add_parser("close")
    c.add_argument("--dry-run", action="store_true")
    c.set_defaults(fn=cmd_close)
    args = p.parse_args(argv)
    try:
        return args.fn(args) or 0
    except PlanError as e:
        for problem in e.problems:
            print(problem, file=sys.stderr)
        return 2
    except GhError as e:
        print(e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
