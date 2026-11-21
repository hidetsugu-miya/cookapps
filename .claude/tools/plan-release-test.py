#!/usr/bin/env python3
"""Tests of the pure functions of plan-release.py, and of the shell tools around it (use-worktree.sh, ensure-deps.sh) and the hook post-gh.sh.
No network and no gh.
The hook and the tools it runs are this checkout's own copies (the ones beside this file), not the main checkout's, and the hooks write their log to a temporary directory (TSUNAGIAI_HOOK_LOG_DIR), never to the real logs/.
Run: python3 -I .claude/tools/plan-release-test.py
"""
import atexit
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("plan_release", os.path.join(here, "plan-release.py"))
pr = importlib.util.module_from_spec(spec)
sys.modules["plan_release"] = pr
spec.loader.exec_module(pr)


def mk(n, labels=(), parent=None, created=None, state="open", closed=None, blocked=(), sub=0, reason=None):
    return pr.Issue(
        number=n,
        id=1000 + n,
        title=f"issue {n}",
        body="",
        labels=list(labels),
        created_at=created or f"2026-11-01T00:00:{n:02d}Z",
        closed_at=closed,
        state=state,
        state_reason=reason or ("completed" if state == "closed" else None),
        blocked_by=list(blocked),
        parent=parent,
        sub_issues=sub,
    )


def numbers(issues):
    return [i.number for i in issues]


class Versions(unittest.TestCase):
    def test_parse_and_compare_numerically(self):
        self.assertEqual(pr.parse_version("v0.9.0"), (0, 9, 0))
        self.assertIsNone(pr.parse_version("plan-tmp-3"))
        self.assertIsNone(pr.parse_version(None))
        self.assertEqual(pr.highest_tag(["v0.9.0", "v0.10.0", "nightly", "v0.2.5"]), "v0.10.0")
        self.assertIsNone(pr.highest_tag(["nightly"]))

    def test_bump(self):
        self.assertEqual(pr.bump((0, 39, 2), True), (0, 40, 0))
        self.assertEqual(pr.bump((0, 39, 2), False), (0, 39, 3))
        self.assertEqual(pr.format_version((0, 40, 0)), "v0.40.0")


class Points(unittest.TestCase):
    def test_the_points_of_an_issue(self):
        self.assertEqual(pr.points(mk(1, ["bug", "point:3"])), 3)
        self.assertEqual(pr.points(mk(2, ["point:8"])), 8)
        self.assertIsNone(pr.points(mk(3, ["bug"])))


class Ordering(unittest.TestCase):
    def test_the_basis_is_the_tier_then_importance_low_last_then_fewer_points_then_older(self):
        a = mk(1, ["point:3"], created="2026-11-01T00:00:01Z")
        b = mk(2, ["point:1"], created="2026-11-01T00:00:02Z")
        c = mk(3, ["point:1", "importance:high"], created="2026-11-01T00:00:03Z")
        d = mk(4, ["point:1", "importance:low"], created="2026-11-01T00:00:04Z")
        e = mk(5, ["point:1"], created="2026-11-01T00:00:00Z")
        self.assertEqual(numbers(pr.base_order([a, b, c, d, e])), [3, 5, 2, 1, 4])
        self.assertEqual(pr.base_order([]), [])

    def test_importance_low_goes_after_no_label_in_the_same_tier_but_a_quick_bug_still_goes_first(self):
        low = mk(1, ["point:1", "importance:low"], created="2026-11-01T00:00:01Z")
        plain = mk(2, ["point:5"], created="2026-11-01T00:00:02Z")
        low_bug = mk(3, ["bug", "point:2", "importance:low"], created="2026-11-01T00:00:03Z")
        self.assertEqual(numbers(pr.base_order([low, plain, low_bug])), [3, 2, 1])
        self.assertEqual(pr.tier(low), pr.tier(plain))

    def test_bugs_of_1_2_and_3_points_go_first_but_not_those_of_5_and_8(self):
        a = mk(1, ["point:1"], created="2026-11-01T00:00:01Z")
        b = mk(2, ["bug", "point:8"], created="2026-11-01T00:00:02Z")
        c = mk(3, ["bug", "point:5"], created="2026-11-01T00:00:03Z")
        d = mk(4, ["bug", "point:3"], created="2026-11-01T00:00:04Z")
        e = mk(5, ["bug", "point:2"], created="2026-11-01T00:00:05Z")
        f = mk(6, ["bug", "point:1"], created="2026-11-01T00:00:06Z")
        self.assertEqual(numbers(pr.base_order([a, b, c, d, e, f])), [6, 5, 4, 1, 3, 2])

    def test_urgent_issues_go_before_the_rest_and_a_quick_bug_goes_first_in_its_tier(self):
        a = mk(1, ["point:2"])
        b = mk(2, ["bug", "point:2"])
        c = mk(3, ["urgency:high", "point:5"])
        d = mk(4, ["urgency:high", "bug", "point:2"])
        e = mk(5, ["urgency:high", "point:1"])
        self.assertEqual(numbers(pr.base_order([a, b, c, d, e])), [4, 5, 3, 2, 1])

    def test_the_four_tiers_are_urgency_then_importance(self):
        low_low = mk(1, ["point:1"])
        low_high = mk(2, ["importance:high", "point:5"])
        high_low = mk(3, ["urgency:high", "point:8"])
        high_high = mk(4, ["urgency:high", "importance:high", "point:8"])
        self.assertEqual([pr.tier(i) for i in (high_high, high_low, low_high, low_low)], [0, 1, 2, 3])
        self.assertEqual(numbers(pr.base_order([low_low, low_high, high_low, high_high])), [4, 3, 2, 1])
        self.assertEqual(pr.tier(mk(5, ["importance:low"])), pr.tier(mk(6)))
        self.assertEqual(pr.tier(mk(7, ["urgency:high", "importance:low"])), pr.tier(mk(8, ["urgency:high"])))

    def test_a_quick_bug_does_not_leave_its_tier(self):
        bug = mk(1, ["bug", "point:1"])
        important = mk(2, ["importance:high", "point:8"])
        urgent_ = mk(3, ["urgency:high", "point:8"])
        self.assertEqual(numbers(pr.base_order([bug, important, urgent_])), [3, 2, 1])
        # in its own tier it goes first
        plain = mk(4, ["point:1"])
        self.assertEqual(numbers(pr.base_order([plain, bug])), [1, 4])

    def test_the_priority_is_after_the_tier_and_before_the_quick_bug_and_none_is_last(self):
        none = mk(1, ["bug", "point:1"])
        p3 = mk(2, ["point:8", "priority:3"])
        p2 = mk(3, ["point:8", "priority:2"])
        p1 = mk(4, ["point:8", "priority:1"], created="2026-11-01T00:00:09Z")
        self.assertEqual([pr.priority(i) for i in (p1, p2, p3, none)], [1, 2, 3, 4])
        self.assertEqual(numbers(pr.base_order([none, p3, p2, p1])), [4, 3, 2, 1])
        # the same priority: the quick bug goes first again
        plain = mk(5, ["point:1", "priority:2"])
        bug = mk(6, ["bug", "point:2", "priority:2"])
        self.assertEqual(numbers(pr.base_order([plain, bug, p2])), [6, 5, 3])

    def test_the_priority_does_not_leave_the_tier(self):
        important = mk(1, ["importance:high", "point:8"])
        p1 = mk(2, ["priority:1", "point:1"])
        self.assertEqual(numbers(pr.base_order([p1, important])), [1, 2])

    def test_a_blocker_of_a_higher_priority_is_taken_before_the_issue_it_blocks(self):
        blocker = mk(1, ["point:8"])
        p1 = mk(2, ["priority:1", "point:1"], blocked=[1])
        p2 = mk(3, ["priority:2", "point:1"])
        self.assertEqual(numbers(pr.base_order([p2, blocker, p1])), [1, 2, 3])

    def test_a_blocker_of_a_higher_tier_is_taken_across_the_tiers(self):
        blocker = mk(1, ["point:8"])
        urgent_ = mk(2, ["urgency:high", "importance:high", "point:2"], blocked=[1])
        other = mk(3, ["importance:high", "point:1"])
        self.assertEqual(numbers(pr.base_order([other, blocker, urgent_])), [1, 2, 3])

    def test_a_quick_bug_takes_its_free_blocker_with_it(self):
        a = mk(1, ["point:3"])
        b = mk(2, ["bug", "point:2"], blocked=[1])
        c = mk(3, ["bug", "point:2"], blocked=[99])
        d = mk(4, ["point:1"])
        self.assertEqual(numbers(pr.base_order([d, a, b, c])), [1, 2, 3, 4])

    def test_blockers_are_taken_through_the_chain_and_shared_ones_once(self):
        x = mk(1, ["point:3"])
        y = mk(2, ["point:3"], blocked=[1])
        z = mk(3, ["point:3"])
        b1 = mk(4, ["bug", "point:2"], blocked=[2])
        b2 = mk(5, ["bug", "point:2"], blocked=[1, 3])
        self.assertEqual(numbers(pr.base_order([z, y, x, b2, b1])), [1, 2, 4, 3, 5])

    def test_a_dependabot_issue_comes_before_every_tier(self):
        plain = mk(1, ["point:1"])
        top = mk(2, ["urgency:high", "importance:high", "priority:1", "bug", "point:1"])
        by_label = mk(3, ["dependencies", "point:3"], created="2026-11-01T00:00:09Z")
        by_mark = mk(4, ["point:2"])
        by_mark.body = "<!-- dependabot #177 -->\n## 目的"
        self.assertEqual([pr.dependabot(i) for i in (plain, top, by_label, by_mark)], [False, False, True, True])
        self.assertEqual(numbers(pr.base_order([plain, top, by_label, by_mark])), [4, 3, 2, 1])

    def test_a_mark_that_only_looks_like_the_dependabot_one_is_not_one(self):
        i = mk(1, ["point:1"])
        i.body = "dependabot #177 の話"
        self.assertFalse(pr.dependabot(i))

    def test_split_queue(self):
        w2 = mk(1, state="closed", closed="2026-11-02T00:00:00Z")
        w1 = mk(2, state="closed", closed="2026-11-01T00:00:00Z")
        prog = mk(3, created="2026-11-01T00:00:05Z")
        rest = mk(6)
        dropped = mk(8, state="closed", closed="2026-11-03T00:00:00Z", reason="not_planned")
        waiting, in_progress, others = pr.split_issues([w2, w1, prog, rest, dropped], {3})
        self.assertEqual(numbers(waiting), [2, 1])
        self.assertEqual(numbers(in_progress), [3])
        self.assertEqual(numbers(others), [6])

    def test_an_open_parent_is_not_in_the_queue_and_a_closed_one_is_not_waiting(self):
        parent = mk(4, ["point:5"], sub=2)
        done = mk(5, ["point:5"], sub=2, state="closed", closed="2026-11-02T00:00:00Z")
        waiting, in_progress, others = pr.split_issues([parent, done, mk(6)], {4})
        self.assertEqual((numbers(waiting), numbers(in_progress), numbers(others)), ([], [], [6]))

    def test_urgency_importance_and_points_in_the_snapshot(self):
        j = pr.issue_json(mk(1, ["urgency:high", "importance:low", "point:2"], parent=7))
        self.assertEqual((j["urgency"], j["importance"], j["points"], j["parent"]), ("high", "low", 2, 7))
        self.assertNotIn("milestone", j)
        j = pr.issue_json(mk(2, ["importance:high"]))
        self.assertEqual((j["urgency"], j["importance"], j["points"], j["parent"]), ("normal", "high", None, None))

    def test_the_priority_in_the_snapshot(self):
        self.assertEqual(pr.issue_json(mk(1, ["priority:2", "point:1"]))["priority"], 2)
        self.assertIsNone(pr.issue_json(mk(2, ["point:1"]))["priority"])

    def test_the_dependabot_mark_in_the_snapshot(self):
        self.assertTrue(pr.issue_json(mk(1, ["dependencies", "point:2"]))["dependabot"])
        self.assertFalse(pr.issue_json(mk(2, ["point:2"]))["dependabot"])


def waiting(n, labels=(), closed="2026-11-06T10:00:00Z"):
    return mk(n, labels, state="closed", closed=closed)


class Next(unittest.TestCase):
    def test_the_queue_is_the_basic_order(self):
        issues = [
            mk(1, ["point:3"], created="2026-11-01T00:00:01Z"),
            mk(2, ["point:3"], created="2026-11-01T00:00:02Z"),
            mk(3, ["point:3"], created="2026-11-01T00:00:03Z"),
            mk(4, ["point:2", "bug"], created="2026-11-01T00:00:04Z"),
            mk(5, ["point:1"], created="2026-11-01T00:00:05Z"),
        ]
        out = pr.build_next(issues, set(), frozenset())
        self.assertEqual([i["number"] for i in out["start"]], [4, 5, 1, 2, 3])
        self.assertEqual(out["start"][2]["points"], 3)

    def test_a_dependabot_issue_starts_first(self):
        issues = [mk(1, ["urgency:high", "importance:high", "point:1"]), mk(2, ["dependencies", "point:3"])]
        out = pr.build_next(issues, set(), frozenset())
        self.assertEqual([i["number"] for i in out["start"]], [2, 1])

    def test_blocked_and_held_issues_are_reported_not_started(self):
        issues = [
            mk(1, ["point:2"]),
            mk(2, ["point:2", "needs:owner"]),
            mk(3, ["point:2"], blocked=[1]),
            mk(4, ["point:2"]),
        ]
        out = pr.build_next(issues, {4}, frozenset())
        self.assertEqual([i["number"] for i in out["start"]], [1, 2])
        self.assertNotIn("needs_owner", out)
        self.assertEqual(out["blocked"], [{"number": 3, "title": "issue 3", "blocked_by": [1]}])
        self.assertEqual([(i["number"], i["reason"]) for i in out["held"]], [(4, "pull request open")])

    def test_an_issue_in_hand_is_in_progress_and_is_not_held(self):
        issues = [mk(1, ["point:2"]), mk(2, ["point:2"])]
        out = pr.build_next(issues, {1}, frozenset({1}))
        self.assertEqual([i["number"] for i in out["in_progress"]], [1])
        self.assertEqual(out["held"], [])
        self.assertEqual([i["number"] for i in out["start"]], [2])

    def test_an_issue_another_worktree_holds_is_claimed_and_does_not_start(self):
        issues = [mk(1, ["point:2"]), mk(2, ["point:2"]), mk(3, ["point:2"])]
        claimed = {2: "/m/.claude/worktrees/feat-two"}
        out = pr.build_next(issues, set(), frozenset(), claimed=claimed)
        self.assertEqual([i["number"] for i in out["start"]], [1, 3])
        self.assertEqual([(i["number"], i["owner"]) for i in out["claimed"]], [(2, "/m/.claude/worktrees/feat-two")])
        self.assertEqual(pr.build_next(issues, set(), frozenset())["claimed"], [])

    def test_mine_comes_before_a_claim(self):
        issues = [mk(1, ["point:2"]), mk(2, ["point:2"])]
        out = pr.build_next(issues, set(), frozenset({1}), claimed={1: "/w/a", 2: "/w/b"})
        self.assertEqual([i["number"] for i in out["in_progress"]], [1])
        self.assertEqual([i["number"] for i in out["claimed"]], [2])
        self.assertEqual(out["start"], [])

    def test_a_claim_of_a_closed_issue_is_no_entry(self):
        out = pr.build_next([mk(1, ["point:2"])], set(), frozenset(), claimed={9: "/w/a"})
        self.assertEqual(out["claimed"], [])
        self.assertEqual([i["number"] for i in out["start"]], [1])

    def test_a_point_8_issue_and_a_change_that_waits_do_not_hold_back_the_queue(self):
        issues = [mk(1, ["point:8"]), mk(2, ["point:3"], parent=900), mk(3, ["point:2"]), waiting(4, ["point:2"])]
        out = pr.build_next(issues, set(), frozenset())
        self.assertEqual(sorted(i["number"] for i in out["start"]), [1, 2, 3])
        self.assertEqual([w["number"] for w in out["waiting"]], [4])
        self.assertNotIn("stop", out)
        self.assertNotIn("waits_for_release", out)
        self.assertNotIn("waits_for_session", out)

    def test_the_queue_is_by_tier_then_quick_bug_then_points(self):
        issues = [
            mk(1, ["point:1"]),
            mk(2, ["bug", "point:1"]),
            mk(3, ["importance:high", "point:5"]),
            mk(4, ["urgency:high", "point:8"]),
            mk(5, ["point:3"]),
        ]
        out = pr.build_next(issues, set(), frozenset())
        self.assertEqual([i["number"] for i in out["start"]], [4, 3, 2, 1, 5])

    def test_the_queue_is_by_priority_after_the_tier(self):
        issues = [mk(1, ["bug", "point:1"]), mk(2, ["point:8", "priority:2"]), mk(3, ["point:8", "priority:1"]), mk(4, ["importance:high", "point:8"])]
        out = pr.build_next(issues, set(), frozenset())
        self.assertEqual([i["number"] for i in out["start"]], [4, 3, 2, 1])

    def test_a_parent_is_in_no_list_and_its_parts_start(self):
        issues = [mk(1, ["point:5"], sub=2), mk(2, ["point:3"], parent=1), mk(3, ["point:3"], sub=1), mk(4, ["point:2"])]
        out = pr.build_next(issues, {1}, frozenset({3}))
        self.assertEqual([i["number"] for i in out["start"]], [4, 2])
        self.assertEqual((out["in_progress"], out["held"], out["blocked"]), ([], [], []))

    def test_a_closed_parent_is_no_change(self):
        issues = [mk(1, ["point:8"], sub=2, state="closed", closed="2026-11-06T10:00:00Z"), mk(2, ["point:2"])]
        out = pr.build_next(issues, set(), frozenset())
        self.assertEqual(out["waiting"], [])
        self.assertEqual([i["number"] for i in out["start"]], [2])

    def test_nothing_open(self):
        out = pr.build_next([], set(), frozenset())
        self.assertEqual((out["start"], out["in_progress"]), ([], []))

class Unsplit(unittest.TestCase):
    def test_a_big_issue_with_no_sub_issue_no_parent_and_no_whole_is_unsplit(self):
        issues = [
            mk(1, ["point:5"]),
            mk(2, ["point:8", "bug"]),
            mk(3, ["point:3"]),
            mk(5, ["point:8"], sub=3),
            mk(6, ["point:5"], state="closed"),
            mk(7, ["point:5", "whole"]),
            mk(8, ["point:5"], parent=5),  # a part: split refuses an issue that has a parent
        ]
        self.assertEqual(numbers(pr.unsplit(issues)), [1, 2])
        self.assertEqual(numbers(pr.unsplit([mk(9, ["point:5", "needs:owner"])])), [9])

    def test_an_issue_in_hand_is_not_unsplit(self):
        issues = [mk(1, ["point:5"]), mk(2, ["point:8"]), mk(3, ["point:5"]), mk(4, ["point:5"])]
        self.assertEqual(numbers(pr.unsplit(issues, pr_closing={2}, mine={3})), [1, 4])

    def test_nothing_is_unsplit_once_every_big_issue_is_split(self):
        self.assertEqual(pr.unsplit([mk(1, ["point:2"]), mk(2, ["point:5", "whole"])]), [])


class Parallel(unittest.TestCase):
    def test_the_results_come_in_the_order_given_whatever_ends_first(self):
        import threading

        gate = threading.Event()

        def slow():
            gate.wait(5)
            return "slow"

        def fast():
            gate.set()
            return "fast"

        self.assertEqual(pr.parallel([slow, fast]), ["slow", "fast"])
        self.assertEqual(pr.parallel([]), [])

    def test_the_first_failure_in_order_is_raised_after_every_call_has_ended(self):
        ended = []

        def boom(text):
            def f():
                raise pr.GhError(text)

            return f

        def last():
            ended.append(1)

        with self.assertRaises(pr.GhError) as cm:
            pr.parallel([boom("a"), boom("b"), last])
        self.assertEqual(str(cm.exception), "a")
        self.assertEqual(ended, [1])


class LoadState(unittest.TestCase):
    """load_state asks for what does not depend on each other at the same time, and builds the same state as asking one by one."""

    def run_load(self, blockers=True):
        def raw(n, state="open", login="owner", total=0, closed_at=None, parent=None, subs=0):
            return {
                "number": n,
                "id": 1000 + n,
                "title": f"issue {n}",
                "body": "",
                "labels": [{"name": "point:2"}],
                "parent_issue_url": parent,
                "sub_issues_summary": {"total": subs, "completed": 0, "percent_completed": 0},
                "created_at": f"2026-11-01T00:00:{n:02d}Z",
                "closed_at": closed_at,
                "state": state,
                "user": {"login": login},
                "issue_dependencies_summary": {"total_blocked_by": total},
            }

        calls = []

        def fake_gh(*args):
            calls.append(list(args))
            if args[:2] == ("repo", "view"):
                return json.dumps({"nameWithOwner": "o/r", "owner": {"login": "owner"}})
            if args[:2] == ("pr", "list"):
                return json.dumps([{"author": {"login": "owner"}, "closingIssuesReferences": [{"number": 3}]}, {"author": {"login": "bot"}, "closingIssuesReferences": [{"number": 4}]}])
            raise AssertionError(args)

        def fake_api(path, method="GET", fields=None, paginate=False):
            calls.append(["api", path])
            if path.endswith("/tags?per_page=100"):
                return [{"name": "v0.1.0", "commit": {"sha": "old"}}, {"name": "v0.2.0", "commit": {"sha": "abc"}}]
            if path.endswith("/commits/abc"):
                return {"commit": {"committer": {"date": "2026-11-05T00:00:00Z"}}}
            if "state=open" in path:
                return [
                    raw(1, total=1, subs=2),
                    raw(2, total=0, parent="https://api.github.com/repos/o/r/issues/1"),
                    raw(3, total=2, parent="https://api.github.com/repos/x/y/issues/1"),
                    raw(5, login="other"),
                ]
            if "state=closed" in path:
                return [
                    raw(6, "closed", closed_at="2026-11-06T00:00:00Z"),
                    raw(7, "closed", closed_at="2026-11-04T00:00:00Z"),
                    raw(10, "closed", login="other", closed_at="2026-11-06T00:00:00Z"),
                ]
            if path.endswith("/issues/1/dependencies/blocked_by?per_page=100"):
                return [{"number": 9, "id": 9009, "state": "open", "repository_url": "https://api.github.com/repos/o/r"}]
            if path.endswith("/issues/3/dependencies/blocked_by?per_page=100"):
                return [
                    {"number": 8, "id": 8008, "state": "closed", "repository_url": "https://api.github.com/repos/o/r"},
                    {"number": 2, "id": 1002, "state": "open", "repository_url": "https://api.github.com/repos/o/r"},
                    {"number": 4, "id": 4004, "state": "open", "repository_url": "https://api.github.com/repos/x/y"},
                ]
            raise AssertionError(path)

        real_gh, real_api = pr.gh, pr.api
        pr.gh, pr.api = fake_gh, fake_api
        try:
            return pr.load_state(blockers), calls
        finally:
            pr.gh, pr.api = real_gh, real_api

    def test_the_state_is_the_same_as_when_asked_one_by_one(self):
        state, calls = self.run_load()
        self.assertEqual((state.repo, state.owner, state.last_tag), ("o/r", "owner", "v0.2.0"))
        self.assertEqual(sorted(state.issues), [1, 2, 3, 6])  # 7 closed before the release, 5 is another author's
        self.assertEqual(state.strangers, [(5, "other")])  # only an open issue of another author, not 10, which is closed
        self.assertEqual(state.issues[1].blocked_by, [9])
        self.assertEqual(state.issues[3].blocked_by, [2])  # a closed blocker and one of another repository are not blockers
        self.assertEqual(state.pr_closing, {3})
        self.assertEqual(state.tags, ["v0.1.0", "v0.2.0"])
        self.assertEqual([c for c in calls if c[:2] == ["repo", "view"]], [["repo", "view", "--json", "nameWithOwner,owner"]])

    def test_a_parent_and_its_sub_issues_are_read_from_the_list_and_a_parent_of_another_repository_is_none(self):
        state, calls = self.run_load()
        self.assertEqual((state.issues[1].parent, state.issues[1].sub_issues), (None, 2))
        self.assertEqual((state.issues[2].parent, state.issues[2].sub_issues), (1, 0))
        self.assertEqual(state.issues[3].parent, None)
        self.assertEqual(numbers(state.free), [2])  # the parent #1 is neither free nor fixed
        self.assertEqual(numbers(state.fixed), [3])
        self.assertFalse(any("sub_issues" in c[-1] for c in calls if c[0] == "api"))

    def test_no_blockers_are_asked_when_not_wanted(self):
        state, calls = self.run_load(blockers=False)
        self.assertFalse(any("blocked_by" in c[-1] for c in calls if c[0] == "api"))
        self.assertEqual(state.issues[1].blocked_by, [])


class ReleaseFacts(unittest.TestCase):
    def facts(self, issues, release_pr=None, last_tag="v0.55.2"):
        return pr.release_facts(issues, release_pr, last_tag)

    def test_nothing_waits(self):
        out = self.facts([mk(1, ["point:2"])])
        self.assertEqual(out["changes"], [])
        self.assertEqual((out["urgent"], out["minor"], out["version"], out["release_pr"]), (False, False, None, None))

    def test_the_changes_are_the_merged_ones_oldest_first_and_documentation_is_not_one(self):
        out = self.facts(
            [
                waiting(1, ["point:2"], closed="2026-11-06T12:00:00Z"),
                waiting(2, ["point:3"], closed="2026-11-06T10:00:00Z"),
                waiting(3, ["documentation"]),
                mk(4, state="closed", closed="2026-11-06T09:00:00Z", reason="not_planned"),
            ]
        )
        self.assertEqual([c["number"] for c in out["changes"]], [2, 1])
        self.assertEqual(out["changes"][0]["points"], 3)

    def test_the_digit_follows_the_requirement_label(self):
        self.assertEqual(self.facts([waiting(1)])["version"], "v0.55.3")
        out = self.facts([waiting(1), waiting(2, ["adds:requirement"])])
        self.assertEqual((out["minor"], out["version"]), (True, "v0.56.0"))

    def test_no_tag_starts_from_zero(self):
        self.assertEqual(self.facts([waiting(1)], last_tag=None)["version"], "v0.0.1")

    def test_urgent(self):
        self.assertTrue(self.facts([waiting(1, ["urgency:high"])])["urgent"])
        self.assertTrue(self.facts([waiting(1, ["bug", "importance:high"])])["urgent"])
        self.assertFalse(self.facts([waiting(1, ["importance:high"])])["urgent"])
        pr_ = {"number": 5, "title": "release: v0.55.3", "url": "u", "labels": ["urgency:high"]}
        out = self.facts([waiting(1)], pr_)
        self.assertTrue(out["urgent"])
        self.assertEqual(out["release_pr"], {"number": 5, "title": "release: v0.55.3", "url": "u"})
        self.assertFalse(self.facts([waiting(1, ["documentation", "urgency:high"])])["urgent"])

    def test_a_closed_parent_is_no_change_and_counts_for_no_digit_or_urgency(self):
        parent = mk(1, ["point:8", "adds:requirement", "urgency:high"], sub=3, state="closed", closed="2026-11-06T10:00:00Z")
        out = self.facts([parent, waiting(2, ["point:2"])])
        self.assertEqual([c["number"] for c in out["changes"]], [2])
        self.assertEqual((out["urgent"], out["minor"], out["version"]), (False, False, "v0.55.3"))
        self.assertEqual(self.facts([parent])["changes"], [])

class TagDueHidesTheChanges(unittest.TestCase):
    def test_while_a_tag_is_due_nothing_is_shown_as_waiting(self):
        facts = pr.release_facts([waiting(1, ["urgency:high", "adds:requirement", "point:8"])], None, "v0.55.2")
        due = {"tag": "v0.56.0", "commit": "bbb", "pr": 12}
        out = pr.with_tag_due(facts, due)
        self.assertEqual(out["tag_due"], due)
        self.assertEqual(out["changes"], [])
        self.assertEqual((out["urgent"], out["minor"], out["version"]), (False, False, None))

    def test_with_no_tag_due_the_facts_are_kept(self):
        facts = pr.release_facts([waiting(1)], None, "v0.55.2")
        out = pr.with_tag_due(dict(facts), None)
        self.assertIsNone(out["tag_due"])
        self.assertEqual({k: v for k, v in out.items() if k != "tag_due"}, facts)


class ChangelogVersion(unittest.TestCase):
    def test_the_version_of_the_first_heading(self):
        text = "# Changelog\n\nThe newest version comes first.\n\n## v0.55.2\n\nM-1: a\n\n## v0.55.1\n\nM-2: b\n"
        self.assertEqual(pr.changelog_version(text), "0.55.2")

    def test_a_heading_that_is_not_a_version_is_skipped(self):
        self.assertEqual(pr.changelog_version("## Notes\n## v0.9.0 extra\n### v0.8.0\n## v0.7.1\n"), "0.7.1")

    def test_none_without_a_version_heading(self):
        self.assertIsNone(pr.changelog_version("# Changelog\n\n[package]\nversion = \"1.0.0\"\n"))
        self.assertIsNone(pr.changelog_version(""))


class TagDue(unittest.TestCase):
    PRS = [
        {"number": 10, "mergedAt": "2026-11-05T00:00:00Z", "mergeCommit": {"oid": "aaa"}},
        {"number": 12, "mergedAt": "2026-11-08T00:00:00Z", "mergeCommit": {"oid": "bbb"}},
    ]

    def test_the_newest_release_pr_with_no_tag_is_due_on_its_merge_commit(self):
        read = {"aaa": "0.55.1", "bbb": "0.55.2"}.get
        self.assertEqual(pr.tag_due(self.PRS, ["v0.55.1"], read), {"tag": "v0.55.2", "commit": "bbb", "pr": 12})

    def test_nothing_is_due_when_the_tag_exists(self):
        read = {"aaa": "0.55.1", "bbb": "0.55.2"}.get
        self.assertIsNone(pr.tag_due(self.PRS, ["v0.55.1", "v0.55.2"], read))

    def test_nothing_is_due_without_a_release_pr_or_a_readable_version(self):
        self.assertIsNone(pr.tag_due([], ["v0.55.1"], lambda oid: "0.55.2"))
        self.assertIsNone(pr.tag_due(self.PRS, [], lambda oid: None))
        self.assertIsNone(pr.tag_due([{"number": 1, "mergedAt": "2026-11-01T00:00:00Z", "mergeCommit": None}], [], lambda oid: "0.1.0"))


class FollowUpDue(unittest.TestCase):
    PRS = TagDue.PRS
    READ = {"aaa": "0.55.1", "bbb": "0.55.2"}.get

    def test_the_newest_release_pr_with_a_tag_and_no_mark_is_open(self):
        out = pr.follow_up_due(self.PRS, ["v0.55.1", "v0.55.2"], self.READ, lambda number, tag: False)
        self.assertEqual(out, {"tag": "v0.55.2", "commit": "bbb", "pr": 12})

    def test_the_mark_is_asked_for_the_newest_pr_and_its_tag(self):
        asked = []
        pr.follow_up_due(self.PRS, ["v0.55.2"], self.READ, lambda number, tag: asked.append((number, tag)) or False)
        self.assertEqual(asked, [(12, "v0.55.2")])

    def test_nothing_is_open_once_the_pr_is_marked(self):
        self.assertIsNone(pr.follow_up_due(self.PRS, ["v0.55.2"], self.READ, lambda number, tag: True))

    def test_nothing_is_open_while_the_tag_is_due(self):
        self.assertIsNone(pr.follow_up_due(self.PRS, ["v0.55.1"], self.READ, lambda number, tag: False))

    def test_nothing_is_open_without_a_release_pr_or_a_readable_version(self):
        self.assertIsNone(pr.follow_up_due([], ["v0.55.2"], self.READ, lambda number, tag: False))
        self.assertIsNone(pr.follow_up_due(self.PRS, ["v0.55.2"], lambda oid: None, lambda number, tag: False))

    def test_the_mark_is_a_comment_line_with_the_tag(self):
        self.assertEqual(pr.follow_up_mark("v0.55.2"), "<!-- released v0.55.2 -->")


class DoneParents(unittest.TestCase):
    def sub(self, n, state="closed"):
        return {"number": n, "state": state}

    def test_a_parent_is_done_when_every_sub_issue_is_closed_and_released(self):
        parents = [mk(1, sub=2), mk(2, sub=2), mk(3, sub=1), mk(4, sub=1)]
        subs = {1: [self.sub(10), self.sub(11)], 2: [self.sub(12), self.sub(13, "open")], 3: [self.sub(14)], 4: []}
        issues = [mk(14, state="closed", closed="2026-11-06T10:00:00Z", parent=3)]  # closed after the last release
        self.assertEqual(numbers(pr.done_parents(parents, subs, issues)), [1])

    def test_a_sub_issue_closed_as_not_planned_is_not_waiting(self):
        issues = [mk(14, state="closed", closed="2026-11-06T10:00:00Z", parent=3, reason="not_planned")]
        self.assertEqual(numbers(pr.done_parents([mk(3, sub=1)], {3: [self.sub(14)]}, issues)), [3])

    def test_the_close_command_closes_only_the_done_parents_as_completed(self):
        calls = []

        def fake_gh(*args):
            calls.append(list(args))
            if args[:2] == ("repo", "view"):
                return json.dumps({"nameWithOwner": "o/r", "owner": {"login": "owner"}})
            return "\n"

        def fake_api(path, method="GET", fields=None, paginate=False):
            if path.endswith("/sub_issues?per_page=100"):
                return {"1": [self.sub(10)]}[path.split("/issues/")[1].split("/")[0]]  # #2 has an open part in the state: its sub-issues are not read
            raise AssertionError(path)

        state = pr.State("o/r", "owner", "v0.1.0", {1: mk(1, sub=1), 2: mk(2, sub=1), 3: mk(3, parent=2), 4: mk(4, sub=1, state="closed")}, [], [], set(), [], [])
        real = (pr.gh, pr.api, pr.load_state)
        pr.gh, pr.api, pr.load_state = fake_gh, fake_api, lambda blockers=True: state
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                self.assertEqual(pr.main(["close"]), 0)
                self.assertEqual(pr.main(["close", "--dry-run"]), 0)
        finally:
            pr.gh, pr.api, pr.load_state = real
        self.assertEqual(calls, [["issue", "close", "1", "--reason", "completed", "--comment", pr.close_comment()]])
        self.assertEqual(out.getvalue().count("closed #1 "), 2)


class Snapshot(unittest.TestCase):
    def run_snapshot(self, strangers, fail_on=None, issue=None):
        calls = []
        issue = issue or mk(1, ["point:2"])

        def fake_gh(*args):
            calls.append(list(args))
            if fail_on and args[2] == str(fail_on):
                raise pr.GhError(f"gh {' '.join(args[:3])}: boom")
            return "\n"

        state = pr.State("o/r", "owner", "v0.1.0", {issue.number: issue}, [], [issue], set(), strangers, [])
        real = (pr.gh, pr.load_state)
        pr.gh, pr.load_state = fake_gh, lambda blockers=True: state
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = pr.main(["snapshot"])
        finally:
            pr.gh, pr.load_state = real
        return code, calls, out.getvalue(), err.getvalue()

    def test_an_open_issue_of_another_author_is_closed_as_not_planned_with_the_fixed_comment_and_is_not_in_the_output(self):
        code, calls, out, err = self.run_snapshot([(12, "someone"), (13, "other")])
        self.assertEqual(code, 0)
        self.assertEqual(
            calls,
            [
                ["issue", "close", "12", "--reason", "not planned", "--comment", pr.stranger_comment()],
                ["issue", "close", "13", "--reason", "not planned", "--comment", pr.stranger_comment()],
            ],
        )
        self.assertEqual(err.splitlines(), ["closed #12 of someone (not the owner)", "closed #13 of other (not the owner)"])
        self.assertEqual([i["number"] for i in json.loads(out)["free"]], [1])
        self.assertNotIn("someone", out)

    def test_nothing_is_closed_or_said_when_every_open_issue_is_the_owners(self):
        code, calls, out, err = self.run_snapshot([])
        self.assertEqual((code, calls, err), (0, [], ""))

    def test_a_failed_close_is_told_and_the_snapshot_goes_on_with_the_rest(self):
        code, calls, out, err = self.run_snapshot([(12, "someone"), (13, "other")], fail_on=12)
        self.assertEqual(code, 0)
        self.assertEqual([c[2] for c in calls], ["12", "13"])
        self.assertEqual(len(err.splitlines()), 2)
        self.assertIn("could not close #12 of someone", err)
        self.assertIn("closed #13 of other (not the owner)", err)
        self.assertEqual([i["number"] for i in json.loads(out)["free"]], [1])

    def test_an_open_issue_of_the_owner_without_points_is_refused_after_the_strangers_are_closed(self):
        code, calls, out, err = self.run_snapshot([(12, "someone")], issue=mk(1, ["bug"]))
        self.assertEqual((code, out), (2, ""))
        self.assertEqual([c[2] for c in calls], ["12"])
        self.assertIn("#1 has no point:* label", err)


class Claims(unittest.TestCase):
    def test_the_claims_live_in_the_main_checkout(self):
        self.assertEqual(pr.claims_dir("/w/tsunagiai/.git"), "/w/tsunagiai/.claude/claims")
        self.assertEqual(pr.claims_dir("/w/tsunagiai/.git/"), "/w/tsunagiai/.claude/claims")

    def test_the_live_worktrees_are_read_from_the_porcelain_list(self):
        with tempfile.TemporaryDirectory() as d:
            d = os.path.realpath(d)
            text = f"worktree {d}/m\nHEAD abc\nbranch refs/heads/main\n\nworktree {d}/w\nHEAD def\ndetached\n"
            self.assertEqual(pr.live_worktrees(text), {f"{d}/m", f"{d}/w"})
        self.assertEqual(pr.live_worktrees(""), set())

    def test_a_worktree_whose_directory_is_gone_is_not_live(self):
        text = (
            "worktree /w/m\nHEAD abc\nbranch refs/heads/main\n\n"
            "worktree /w/gone\nHEAD def\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n\n"
            "worktree /w/bare\nHEAD 111\ndetached\nprunable\n"
        )
        self.assertEqual(pr.live_worktrees(text), {os.path.realpath("/w/m")})

    def test_a_free_issue_is_claimed_with_the_path_of_the_owner(self):
        with tempfile.TemporaryDirectory() as d:
            root = os.path.join(d, "claims")
            self.assertIsNone(pr.claim_issue(root, 7, "/w/a", {"/w/a"}))
            with open(os.path.join(root, "7", "owner"), encoding="utf-8") as f:
                self.assertEqual(f.read().strip(), "/w/a")
            self.assertEqual(os.listdir(root), ["7"])

    def test_a_claim_of_a_live_worktree_holds_and_the_same_owner_may_claim_again(self):
        with tempfile.TemporaryDirectory() as d:
            root = os.path.join(d, "claims")
            live = {"/w/a", "/w/b"}
            self.assertIsNone(pr.claim_issue(root, 7, "/w/a", live))
            self.assertEqual(pr.claim_issue(root, 7, "/w/b", live), "/w/a")
            self.assertIsNone(pr.claim_issue(root, 7, "/w/a", live))
            self.assertEqual(os.listdir(root), ["7"])

    def test_a_claim_whose_worktree_is_gone_is_taken_over(self):
        with tempfile.TemporaryDirectory() as d:
            root = os.path.join(d, "claims")
            self.assertIsNone(pr.claim_issue(root, 7, "/w/a", {"/w/a"}))
            self.assertIsNone(pr.claim_issue(root, 7, "/w/b", {"/w/b"}))
            with open(os.path.join(root, "7", "owner"), encoding="utf-8") as f:
                self.assertEqual(f.read().strip(), "/w/b")
            self.assertEqual(os.listdir(root), ["7"])

    def test_a_claim_with_no_owner_is_taken_over(self):
        with tempfile.TemporaryDirectory() as d:
            root = os.path.join(d, "claims")
            os.makedirs(os.path.join(root, "7"))
            self.assertIsNone(pr.claim_issue(root, 7, "/w/a", {"/w/a"}))
            self.assertEqual(pr.read_claims(root, {"/w/a"}), {7: "/w/a"})
            self.assertEqual(os.listdir(root), ["7"])

    def test_of_many_claimants_at_once_exactly_one_wins(self):
        with tempfile.TemporaryDirectory() as d:
            root = os.path.join(d, "claims")
            owners = [f"/w/{n}" for n in range(8)]
            live = set(owners)
            barrier = threading.Barrier(len(owners))
            results = {}

            def claim(owner):
                barrier.wait()
                results[owner] = pr.claim_issue(root, 7, owner, live)

            threads = [threading.Thread(target=claim, args=(o,)) for o in owners]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            winners = [o for o, held in results.items() if held is None]
            self.assertEqual(len(winners), 1)
            self.assertTrue(all(held == winners[0] for o, held in results.items() if o != winners[0]))
            self.assertEqual(os.listdir(root), ["7"])

    def test_of_many_claimants_at_a_stale_claim_exactly_one_wins(self):
        with tempfile.TemporaryDirectory() as d:
            root = os.path.join(d, "claims")
            self.assertIsNone(pr.claim_issue(root, 7, "/w/old", {"/w/old"}))
            owners = [f"/w/{n}" for n in range(8)]
            live = set(owners)
            barrier = threading.Barrier(len(owners))
            results = {}

            def claim(owner):
                barrier.wait()
                results[owner] = pr.claim_issue(root, 7, owner, live)

            threads = [threading.Thread(target=claim, args=(o,)) for o in owners]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertEqual(len([o for o, held in results.items() if held is None]), 1)
            self.assertEqual(os.listdir(root), ["7"])

    def test_only_the_claims_of_live_worktrees_are_read(self):
        with tempfile.TemporaryDirectory() as d:
            root = os.path.join(d, "claims")
            pr.claim_issue(root, 1, "/w/a", {"/w/a"})
            pr.claim_issue(root, 2, "/w/gone", {"/w/gone"})
            os.makedirs(os.path.join(root, "x"))
            os.makedirs(os.path.join(root, "3"))
            self.assertEqual(pr.read_claims(root, {"/w/a"}), {1: "/w/a"})
            self.assertEqual(pr.read_claims(os.path.join(d, "none"), {"/w/a"}), {})


class ClaimCommand(unittest.TestCase):
    """`plan-release.py claim` in a throwaway repository with two worktrees."""

    def git(self, *args, cwd=None):
        return subprocess.run(["git", "-C", cwd or self.main, *args], capture_output=True, text=True, check=True).stdout.strip()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = os.path.realpath(self.tmp.name)
        self.main = os.path.join(t, "main")
        subprocess.run(["git", "init", "-q", "-b", "main", self.main], check=True)
        for k, v in (("user.email", "t@example.com"), ("user.name", "t")):
            self.git("config", k, v)
        self.git("commit", "-q", "--allow-empty", "-m", "first")
        self.a = os.path.join(self.main, ".claude", "worktrees", "a")
        self.b = os.path.join(self.main, ".claude", "worktrees", "b")
        self.git("worktree", "add", "-q", "-b", "a", self.a)
        self.git("worktree", "add", "-q", "-b", "b", self.b)
        self.cwd = os.getcwd()

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def run_claim(self, cwd, *argv):
        os.chdir(cwd)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pr.main(["claim", *argv])
        return code, out.getvalue(), err.getvalue()

    def test_the_claim_is_made_in_the_main_checkout_from_any_worktree(self):
        code, out, err = self.run_claim(self.a, "--worktree", self.a, "5", "6")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out.splitlines(), ["claimed #5", "claimed #6"])
        self.assertEqual(sorted(os.listdir(os.path.join(self.main, ".claude", "claims"))), ["5", "6"])
        self.assertFalse(os.path.exists(os.path.join(self.a, ".claude", "claims")))

    def test_an_issue_that_another_worktree_holds_is_refused_with_exit_3_and_the_rest_is_claimed(self):
        self.run_claim(self.a, "--worktree", self.a, "5")
        code, out, err = self.run_claim(self.b, "--worktree", self.b, "5", "6")
        self.assertEqual(code, 3)
        self.assertEqual(out.splitlines(), ["claimed #6"])
        self.assertEqual(err.splitlines(), [f"#5 claimed by {self.a}"])

    def test_the_claim_of_a_removed_worktree_is_taken_over(self):
        self.run_claim(self.a, "--worktree", self.a, "5")
        self.git("worktree", "remove", self.a)
        code, out, err = self.run_claim(self.b, "--worktree", self.b, "5")
        self.assertEqual((code, out.splitlines(), err), (0, ["claimed #5"], ""))

    def test_the_claim_of_a_worktree_whose_directory_alone_is_gone_is_taken_over(self):
        self.run_claim(self.a, "--worktree", self.a, "5")
        shutil.rmtree(self.a)  # `git worktree list` still names it, as prunable
        self.assertIn(self.a, self.git("worktree", "list", "--porcelain"))
        code, out, err = self.run_claim(self.b, "--worktree", self.b, "5")
        self.assertEqual((code, out.splitlines(), err), (0, ["claimed #5"], ""))

    def test_a_path_that_is_no_worktree_of_the_repository_is_refused(self):
        code, out, err = self.run_claim(self.a, "--worktree", os.path.join(self.main, "nowhere"), "5")
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("not a worktree", err)
        self.assertFalse(os.path.exists(os.path.join(self.main, ".claude", "claims")))


class Refuse(unittest.TestCase):
    def test_open_issue_without_points_label(self):
        bad = pr.missing_points([mk(1, ["point:2"]), mk(2, ["bug"]), mk(3, state="closed")])
        self.assertEqual(numbers(bad), [2])


class FakeGh:
    """An in-memory GitHub behind `pr.gh`: it takes the argument list as gh does, and records every call that writes."""

    def __init__(self, labels=("point:1", "point:2", "point:3", "point:5", "point:8", "bug", "proposal"), fail_on=None):
        self.labels = list(labels)
        self.issues = {}  # number -> raw issue
        self.parents = {}  # sub-issue number -> parent number
        self.writes = []
        self.comments = {}  # issue number -> comments written by `gh issue comment`
        self.fail_on = fail_on  # (command words, nth call of it) -> fail
        self.counts = {}
        self.next_number = 500

    def add_issue(self, n, title, labels=(), user="owner", state="open", parent=None):
        self.issues[n] = {
            "number": n,
            "title": title,
            "state": state,
            "user": {"login": user},
            "labels": [{"name": label} for label in labels],
        }
        if parent:
            self.parents[n] = parent

    def children(self, n):
        return [self.issues[c] for c, p in self.parents.items() if p == n]

    def written(self, *words):
        return [w for w in self.writes if w[: len(words)] == list(words)]

    def _fail_if(self, words):
        if not self.fail_on:
            return
        key, nth = self.fail_on
        if words[: len(key)] == list(key):
            self.counts[key] = self.counts.get(key, 0) + 1
            if self.counts[key] == nth:
                raise pr.GhError("gh " + " ".join(words) + ": boom")

    def __call__(self, *args):
        a = list(args)
        if a[:2] == ["repo", "view"]:
            return json.dumps({"nameWithOwner": "owner/repo", "owner": {"login": "owner"}})
        if a[0] == "api":
            return self._api(a[1:])
        self._fail_if(a)
        self.writes.append(a)
        if a[:2] == ["label", "create"]:
            self.labels.append(a[2])
            return "\n"
        if a[:2] == ["issue", "create"]:
            title = a[a.index("--title") + 1]
            labels = [a[i + 1] for i, x in enumerate(a) if x == "--label"]
            parent = int(a[a.index("--parent") + 1])
            assert all(label in self.labels for label in labels), "gh refuses a label that does not exist"
            self.next_number += 1
            self.add_issue(self.next_number, title, labels, parent=parent)
            return f"https://github.com/owner/repo/issues/{self.next_number}\n"
        if a[:2] == ["issue", "comment"]:
            self.comments.setdefault(int(a[2]), []).append({"user": {"login": "owner"}, "body": a[a.index("--body") + 1]})
            return "\n"
        if a[:2] == ["issue", "close"]:
            self.issues[int(a[2])]["state"] = "closed"
            return "\n"
        if a[:2] == ["issue", "edit"]:
            label = a[a.index("--add-label") + 1]
            assert label in self.labels, "gh refuses a label that does not exist"
            self.issues[int(a[2])]["labels"].append({"name": label})
            return "\n"
        return "\n"

    def _api(self, a):
        path = a[0]
        if path.endswith("/labels?per_page=100"):
            return json.dumps([{"name": label} for label in self.labels])
        if "/sub_issues?" in path:
            return json.dumps(self.children(int(path.split("/issues/")[1].split("/")[0])))
        if "/comments?" in path:
            return json.dumps(self.comments.get(int(path.split("/issues/")[1].split("/")[0]), []))
        n = int(path.rsplit("/", 1)[1])
        if n not in self.issues:
            raise pr.GhError(f"gh api {path}: Not Found")
        parent = self.parents.get(n)
        return json.dumps(
            dict(
                self.issues[n],
                parent_issue_url=f"https://api.github.com/repos/owner/repo/issues/{parent}" if parent else None,
                sub_issues_summary={"total": len(self.children(n)), "completed": 0, "percent_completed": 0},
            )
        )


def part(title, labels=("point:3",), reason="一つの画面だけを触る"):
    return {"title": title, "body": f"{title} の本文\n\nCreated by Claude Code", "labels": list(labels), "points_reason": reason}


class Split(unittest.TestCase):
    def run_split(self, fake, spec):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "split.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(spec, f)
            real, pr.gh = pr.gh, fake
            out, err = io.StringIO(), io.StringIO()
            try:
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = pr.main(["split", path])
            finally:
                pr.gh = real
        return code, out.getvalue(), err.getvalue()

    def big(self, labels=("point:5",), user="owner", state="open"):
        fake = FakeGh()
        fake.add_issue(438, "大きな機能", labels, user=user, state=state)
        return fake

    def test_the_parts_are_made_in_order_as_sub_issues_with_the_reason_and_the_big_issue_stays_open_as_their_parent(self):
        fake = self.big()
        fake.labels.append("adds:requirement")
        spec = {"issue": 438, "parts": [part("一つ目", ("point:3", "adds:requirement")), part("二つ目", ("point:2",), "小さい修正")]}
        code, out, err = self.run_split(fake, spec)
        self.assertEqual((code, err), (0, ""))
        creates = fake.written("issue", "create")
        self.assertEqual([c[c.index("--title") + 1] for c in creates], ["一つ目", "二つ目"])
        self.assertEqual([c[c.index("--parent") + 1] for c in creates], ["438", "438"])
        self.assertNotIn("--milestone", creates[0])
        self.assertEqual([creates[0][i + 1] for i, x in enumerate(creates[0]) if x == "--label"], ["point:3", "adds:requirement"])
        self.assertEqual([(c[2], c[-1]) for c in fake.written("issue", "comment")], [("501", "一つの画面だけを触る"), ("502", "小さい修正"), ("438", "部品に分けました: #501、#502")])
        self.assertEqual(fake.written("issue", "close"), [])
        self.assertEqual(fake.issues[438]["state"], "open")
        self.assertEqual(fake.written("label"), [])
        kinds = [w[0] + ":" + w[1] for w in fake.writes]
        self.assertEqual(kinds, ["issue:create", "issue:comment", "issue:create", "issue:comment", "issue:comment"])

    def test_a_value_with_spaces_or_dashes_reaches_gh_as_one_argument(self):
        fake = self.big()
        code, _, _ = self.run_split(fake, {"issue": 438, "parts": [part("--x y $(z)")]})
        self.assertEqual(code, 0)
        create = fake.written("issue", "create")[0]
        self.assertEqual(create[create.index("--title") + 1], "--x y $(z)")

    def test_a_failed_check_writes_nothing(self):
        one = [part("a")]
        child = self.big()
        child.add_issue(300, "別の親", ("point:5",))
        child.add_issue(438, "大きな機能", ("point:5",), parent=300)
        split_already = self.big()
        split_already.add_issue(400, "前の部品", ("point:3",), parent=438)
        cases = {
            "closed": (self.big(state="closed"), {"issue": 438, "parts": one}, "is not open"),
            "other author": (self.big(user="someone"), {"issue": 438, "parts": one}, "not an issue of the owner"),
            "no point": (self.big(), {"issue": 438, "parts": [part("a", ("bug",))]}, "exactly one point:*"),
            "two points": (self.big(), {"issue": 438, "parts": [part("a", ("point:2", "point:3"))]}, "exactly one point:*"),
            "too big": (self.big(), {"issue": 438, "parts": [part("a", ("point:5",))]}, "more than point:3"),
            "unknown label": (self.big(), {"issue": 438, "parts": [part("a", ("point:3", "nope"))]}, "'nope' does not exist"),
            "same title": (self.big(), {"issue": 438, "parts": [part("a"), part("a")]}, "appears twice"),
            "unknown issue": (self.big(), {"issue": 999, "parts": one}, "#999"),
            "not a split file": (self.big(), {"issue": "x", "parts": [{"title": "a"}]}, "split.issue"),
            "milestone key": (self.big(), {"issue": 438, "milestone": "f", "parts": one}, "split.milestone"),
            "has a parent": (child, {"issue": 438, "parts": one}, "already has a parent"),
            "has other sub-issues": (split_already, {"issue": 438, "parts": one}, "already has sub-issues"),
            "has sub-issues and no parts": (split_already, {"issue": 438, "parts": []}, "already has sub-issues"),
        }
        for name, (fake, spec, text) in cases.items():
            with self.subTest(name):
                before = len(fake.issues)
                code, out, err = self.run_split(fake, spec)
                self.assertEqual(code, 2)
                self.assertIn(text, err)
                self.assertEqual(fake.writes, [])
                self.assertEqual(len(fake.issues), before)

    def test_every_problem_is_listed_at_once(self):
        fake = self.big(state="closed")
        code, _, err = self.run_split(fake, {"issue": 438, "parts": [part("a", ("bug",)), part("b", ("point:5",))]})
        self.assertEqual(code, 2)
        self.assertEqual(len(err.strip().splitlines()), 3)

    def test_a_failed_part_stops_the_run_and_the_parent_gets_no_comment(self):
        fake = self.big()
        fake.fail_on = (("issue", "create"), 2)
        code, out, err = self.run_split(fake, {"issue": 438, "parts": [part("a"), part("b"), part("c")]})
        self.assertEqual(code, 1)
        self.assertIn("parts so far: #501", err)
        self.assertEqual(len(fake.written("issue", "create")), 1)
        self.assertNotIn(438, fake.comments)

    def test_a_failed_comment_stops_the_run_too(self):
        fake = self.big()
        fake.fail_on = (("issue", "comment"), 1)
        code, _, err = self.run_split(fake, {"issue": 438, "parts": [part("a"), part("b")]})
        self.assertEqual(code, 1)
        self.assertIn("#501", err)
        self.assertNotIn(438, fake.comments)

    def test_a_failed_comment_on_the_parent_is_said_with_the_parts(self):
        fake = self.big()
        fake.fail_on = (("issue", "comment"), 2)
        code, _, err = self.run_split(fake, {"issue": 438, "parts": [part("a")]})
        self.assertEqual(code, 1)
        self.assertIn("parts so far: #501", err)
        self.assertEqual(fake.issues[438]["state"], "open")

    def test_a_second_run_keeps_the_open_parts_of_the_same_title_and_makes_the_rest(self):
        fake = self.big()
        spec = {"issue": 438, "parts": [part("a"), part("b"), part("c")]}
        fake.fail_on = (("issue", "create"), 3)
        self.assertEqual(self.run_split(fake, spec)[0], 1)
        fake.fail_on = None
        fake.writes.clear()
        code, out, err = self.run_split(fake, spec)
        self.assertEqual((code, err), (0, ""))
        self.assertEqual([c[c.index("--title") + 1] for c in fake.written("issue", "create")], ["c"])
        self.assertEqual(fake.comments[438][-1]["body"], "部品に分けました: #501、#502、#503")
        self.assertIn("#501 a: kept", out)
        self.assertEqual(len([i for i in fake.issues.values() if i["title"] == "a"]), 1)

    def test_a_third_run_after_a_complete_one_writes_nothing(self):
        fake = self.big()
        spec = {"issue": 438, "parts": [part("a"), part("b")]}
        self.assertEqual(self.run_split(fake, spec)[0], 0)
        fake.writes.clear()
        code, out, err = self.run_split(fake, spec)
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(fake.writes, [])
        self.assertEqual(len(fake.comments[438]), 1)

    def test_a_second_run_writes_the_reason_of_a_kept_part_whose_comment_failed_and_not_one_that_has_it(self):
        fake = self.big()
        spec = {"issue": 438, "parts": [part("a", reason="理由 a"), part("b", reason="理由 b")]}
        fake.fail_on = (("issue", "comment"), 2)
        self.assertEqual(self.run_split(fake, spec)[0], 1)
        fake.fail_on = None
        fake.writes.clear()
        code, _, err = self.run_split(fake, spec)
        self.assertEqual((code, err), (0, ""))
        self.assertEqual([(c[2], c[-1]) for c in fake.written("issue", "comment")], [("502", "理由 b"), ("438", "部品に分けました: #501、#502")])
        self.assertEqual(fake.written("issue", "create"), [])

    def test_a_part_of_the_same_title_closed_or_of_someone_else_or_under_another_parent_is_not_kept(self):
        fake = self.big()
        fake.add_issue(300, "a", ("point:3",))
        fake.add_issue(301, "b", ("point:3",), state="closed", parent=438)
        fake.add_issue(302, "a", ("point:3",), user="someone", parent=438)
        fake.add_issue(303, "x", ("point:3",), parent=438)
        code, _, err = self.run_split(fake, {"issue": 438, "parts": [part("a"), part("b"), part("x")]})
        self.assertEqual((code, err), (0, ""))
        self.assertEqual([c[c.index("--title") + 1] for c in fake.written("issue", "create")], ["a", "b"])

    def test_no_parts_only_puts_the_label_whole_on_the_issue_and_makes_it_when_it_is_missing(self):
        fake = self.big()
        code, out, err = self.run_split(fake, {"issue": 438, "parts": []})
        self.assertEqual((code, err), (0, ""))
        self.assertEqual([w[2] for w in fake.written("label", "create")], ["whole"])
        self.assertEqual(fake.written("issue", "edit"), [["issue", "edit", "438", "--add-label", "whole"]])
        self.assertEqual(fake.written("issue", "create"), [])
        self.assertEqual(fake.written("issue", "close"), [])
        self.assertEqual(fake.issues[438]["state"], "open")
        self.assertIn("whole", [x["name"] for x in fake.issues[438]["labels"]])

    def test_no_parts_with_the_label_whole_that_exists_makes_no_label(self):
        fake = self.big(("point:8",))
        fake.labels.append("whole")
        code, _, _ = self.run_split(fake, {"issue": 438, "parts": []})
        self.assertEqual(code, 0)
        self.assertEqual(fake.written("label"), [])
        self.assertEqual(len(fake.written("issue", "edit")), 1)

    def test_a_split_file_that_is_not_json_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "x.json")
            with open(path, "w") as f:
                f.write("{")
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                self.assertEqual(pr.main(["split", path]), 2)
            self.assertIn(path, err.getvalue())


class Stream(unittest.TestCase):
    def test_paginated_output_is_flattened(self):
        self.assertEqual(pr.parse_stream('[{"a":1}][{"a":2}]\n[]'), [{"a": 1}, {"a": 2}])
        self.assertEqual(pr.parse_stream('{"a":1}'), [{"a": 1}])
        self.assertEqual(pr.parse_stream(""), [])


HOOK = os.path.join(here, "..", "hooks", "post-gh.sh")
TOOLS = here

# Every hook and tool started below inherits this, so a test never adds a line to the real logs/hooks-*.log.
_hook_log_dir = tempfile.mkdtemp()
os.environ["TSUNAGIAI_HOOK_LOG_DIR"] = _hook_log_dir
atexit.register(shutil.rmtree, _hook_log_dir, ignore_errors=True)


class Hook(unittest.TestCase):
    """post-gh.sh against a stub project whose plan-release.py prints STUB."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = cls.tmp.name
        subprocess.run(["git", "init", "-q", root], check=True)
        os.makedirs(os.path.join(root, ".claude", "tools"))
        stub = os.path.join(root, ".claude", "tools", "plan-release.py")
        with open(stub, "w") as f:
            f.write("#!/bin/sh\necho STUB\n")
        os.chmod(stub, 0o755)
        cls.root = root

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_hook(self, command):
        r = subprocess.run(
            ["bash", HOOK],
            input=json.dumps({"tool_input": {"command": command}}),
            capture_output=True,
            text=True,
            env={**os.environ, "CLAUDE_PROJECT_DIR": self.root},
        )
        self.assertEqual(r.returncode, 0)
        return json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"] if r.stdout.strip() else ""

    def test_merge_shows_what_waits_for_the_release(self):
        for cmd in ["gh pr merge --merge", "cd x && gh pr merge 5 --merge", "a; gh pr merge", "echo hi | gh pr merge", "echo x\ngh pr merge"]:
            out = self.run_hook(cmd)
            self.assertIn("STUB", out, cmd)
            self.assertIn("Release PR", out, cmd)

    def test_release_failure_is_passed_on(self):
        stub = os.path.join(self.root, ".claude", "tools", "plan-release.py")
        with open(stub, "w") as f:
            f.write("#!/bin/sh\necho boom >&2\nexit 2\n")
        try:
            out = self.run_hook("gh pr merge")
            self.assertIn("exit 2", out)
            self.assertIn("boom", out)
        finally:
            with open(stub, "w") as f:
                f.write("#!/bin/sh\necho STUB\n")

    def test_issue_create_points_to_issue_plan(self):
        for cmd in [
            "gh issue create --title x",
            "cd x && gh issue create",
        ]:
            self.assertIn("issue-plan", self.run_hook(cmd), cmd)

    def test_text_that_only_mentions_a_command_does_nothing(self):
        for cmd in [
            "ls -la",
            "gh issue edit 5 --add-label bug",
            "gh issue edit 5 --remove-label needs:owner",
            'gh issue edit 5 --remove-label "bug,needs:owner"',
            'echo "gh pr merge"',
            "echo 'gh issue create'",
            "printf '%s' 'gh pr merge --merge' | jq -Rs .",
            'git commit -m "docs: gh issue create flow"',
            'echo "a; gh pr merge"',
            "git commit -m 'x\ngh pr merge\ny'",
            "echo gh pr merge-now",
            "git log --grep='gh issue edit --remove-label needs:owner'",
        ]:
            self.assertEqual(self.run_hook(cmd), "", cmd)


class EnsureDeps(unittest.TestCase):
    """ensure-deps.sh in a temporary checkout, with a `mise` that records where `mise exec -- npm ci` ran."""

    MARK = os.path.join("node_modules", ".tsunagiai-lock-sha256")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = os.path.realpath(self.tmp.name)
        self.root = os.path.join(t, "checkout")
        os.makedirs(self.root)
        subprocess.run(["git", "init", "-q", self.root], check=True, cwd=t, env={**os.environ, "GIT_CEILING_DIRECTORIES": os.path.dirname(t)})
        with open(os.path.join(self.root, ".gitignore"), "w") as f:
            f.write("node_modules/\n")
        self.fake_bin = os.path.join(t, "bin")
        self.mise_log = os.path.join(t, "mise.log")
        os.makedirs(self.fake_bin)
        with open(os.path.join(self.fake_bin, "mise"), "w") as f:
            f.write(
                '#!/bin/sh\necho "$PWD $*" >> "$FAKE_MISE_LOG"\n'
                '[ -z "$FAKE_MISE_FAIL" ] || exit 1\n'
                '[ -z "$FAKE_MISE_SLEEP" ] || sleep "$FAKE_MISE_SLEEP"\n'
                '# the lock changes while npm ci runs\n'
                '[ -z "$FAKE_MISE_CHANGE_LOCK" ] || echo changed >> package-lock.json\n'
                'rm -rf node_modules\nmkdir -p node_modules/from-npm-ci\n'
            )
        os.chmod(os.path.join(self.fake_bin, "mise"), 0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def lock(self, text="lock\n"):
        with open(os.path.join(self.root, "package-lock.json"), "w") as f:
            f.write(text)

    def sha(self, text):
        return hashlib.sha256(text.encode()).hexdigest()

    def mark(self, value):
        os.makedirs(os.path.join(self.root, "node_modules"), exist_ok=True)
        with open(os.path.join(self.root, self.MARK), "w") as f:
            f.write(value + "\n")

    def read_mark(self):
        try:
            with open(os.path.join(self.root, self.MARK)) as f:
                return f.read().strip()
        except FileNotFoundError:
            return None

    def runs(self):
        try:
            with open(self.mise_log) as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []

    def script(self, arg=True, **extra):
        env = {**os.environ, "PATH": f"{self.fake_bin}{os.pathsep}{os.environ['PATH']}", "FAKE_MISE_LOG": self.mise_log, **extra}
        return ["bash", os.path.join(TOOLS, "ensure-deps.sh")] + ([self.root] if arg else []), env

    def run_script(self, arg=True, cwd=None, **extra):
        args, env = self.script(arg, **extra)
        return subprocess.run(args, capture_output=True, text=True, cwd=cwd or self.root, env=env)

    def lock_path(self):
        return subprocess.run(
            ["git", "-C", self.root, "rev-parse", "--path-format=absolute", "--git-path", "tsunagiai-ensure-deps.lock"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()

    @contextlib.contextmanager
    def lock_held(self):
        """Another run of ensure-deps.sh holds the lock of this checkout."""
        with open(self.lock_path(), "w") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            yield

    def test_missing_node_modules_is_installed_and_marked(self):
        self.lock()
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.runs(), [f"{self.root} exec -- npm ci --silent"])
        self.assertEqual(self.read_mark(), self.sha("lock\n"))

    def test_a_different_mark_is_installed_again(self):
        self.lock()
        self.mark(self.sha("old lock\n"))
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(len(self.runs()), 1)
        self.assertEqual(self.read_mark(), self.sha("lock\n"))

    def test_node_modules_without_a_mark_is_installed_again(self):
        self.lock()
        os.makedirs(os.path.join(self.root, "node_modules", "p"))
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(len(self.runs()), 1)
        self.assertEqual(self.read_mark(), self.sha("lock\n"))

    def test_the_same_mark_runs_nothing(self):
        self.lock()
        self.mark(self.sha("lock\n"))
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.runs(), [])

    def test_no_lock_file_runs_nothing(self):
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.runs(), [])
        self.assertFalse(os.path.exists(os.path.join(self.root, "node_modules")))

    def test_a_failed_npm_ci_writes_no_mark_and_exits_non_zero(self):
        self.lock()
        r = self.run_script(FAKE_MISE_FAIL="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIsNone(self.read_mark())

    def test_a_failed_npm_ci_drops_the_old_mark(self):
        self.lock()
        self.mark(self.sha("old lock\n"))
        self.assertNotEqual(self.run_script(FAKE_MISE_FAIL="1").returncode, 0)
        self.assertIsNone(self.read_mark())

    def test_the_mark_is_the_hash_of_the_lock_read_before_npm_ci(self):
        self.lock()
        self.assertEqual(self.run_script(FAKE_MISE_CHANGE_LOCK="1").returncode, 0)
        self.assertEqual(self.read_mark(), self.sha("lock\n"))

    def test_two_runs_at_once_install_once_and_the_second_reads_the_mark_after_the_wait(self):
        self.lock()
        args, env = self.script(FAKE_MISE_SLEEP="1")
        procs = [subprocess.Popen(args, env=env, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        for p in procs:
            _, err = p.communicate()
            self.assertEqual(p.returncode, 0, err)
        self.assertEqual(len(self.runs()), 1)
        self.assertEqual(self.read_mark(), self.sha("lock\n"))
        self.assertTrue(os.path.isdir(os.path.join(self.root, "node_modules", "from-npm-ci")))

    def test_a_run_that_cannot_get_the_lock_in_time_fails_and_installs_nothing(self):
        self.lock()
        with self.lock_held():
            r = self.run_script(ENSURE_DEPS_LOCK_WAIT="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.runs(), [])
        self.assertIsNone(self.read_mark())

    def test_a_checkout_that_is_in_step_needs_no_lock(self):
        self.lock()
        self.mark(self.sha("lock\n"))
        with self.lock_held():
            r = self.run_script(ENSURE_DEPS_LOCK_WAIT="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.runs(), [])

    def test_the_lock_is_in_the_git_directory_and_leaves_the_work_tree_alone(self):
        self.lock()
        self.assertEqual(self.run_script().returncode, 0)
        self.assertTrue(os.path.exists(self.lock_path()))
        status = subprocess.run(["git", "-C", self.root, "status", "--porcelain", "--untracked-files=all"], capture_output=True, text=True, check=True).stdout.splitlines()
        self.assertEqual(sorted(status), ["?? .gitignore", "?? package-lock.json"])

    def test_no_argument_means_the_current_directory(self):
        self.lock()
        self.assertEqual(self.run_script(arg=False).returncode, 0)
        self.assertEqual(self.runs(), [f"{self.root} exec -- npm ci --silent"])


class UseWorktree(unittest.TestCase):
    """use-worktree.sh in a throwaway repository with a bare origin: one worktree for each branch."""

    def inside(self, path):
        """The path itself, after checking that it is a directory of this test's temporary tree. An empty or stray path (a failed `use()` returns "") must stop the test, never reach the current directory: `git -C ""` and a write to "" act on the checkout the test was started in."""
        self.assertTrue(path and os.path.isabs(path), f"not an absolute path: {path!r}")
        self.assertTrue(os.path.realpath(path).startswith(self.t + os.sep), f"outside the temporary tree: {path}")
        return path

    def git(self, cwd, *args):
        # The process runs in the temporary tree, which is no repository, and git may not look above it.
        return subprocess.run(["git", "-C", self.inside(cwd), *args], capture_output=True, text=True, check=True, cwd=self.t, env=self.env).stdout.strip()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.t = os.path.realpath(self.tmp.name)
        self.env = {**os.environ, "GIT_CEILING_DIRECTORIES": os.path.dirname(t)}
        self.origin = os.path.join(t, "origin.git")
        self.main = os.path.join(t, "main")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", self.origin], check=True, cwd=t, env=self.env)
        subprocess.run(["git", "clone", "-q", self.origin, self.main], check=True, capture_output=True, cwd=t, env=self.env)
        for k, v in (("user.email", "t@example.com"), ("user.name", "t")):
            self.git(self.main, "config", k, v)
        os.makedirs(os.path.join(self.main, ".claude", "tools"))
        self.script = os.path.join(self.main, ".claude", "tools", "use-worktree.sh")
        for name in ("use-worktree.sh", "ensure-deps.sh"):
            shutil.copy(os.path.join(TOOLS, name), os.path.join(self.main, ".claude", "tools", name))
        with open(os.path.join(self.main, ".worktreeinclude"), "w") as f:
            f.write("# private\nsecret.txt\n")
        with open(os.path.join(self.main, "secret.txt"), "w") as f:
            f.write("one\n")
        with open(os.path.join(self.main, ".gitignore"), "w") as f:
            f.write("secret.txt\ntarget/\nnode_modules/\n.claude/claims/\n")
        self.git(self.main, "add", ".gitignore")
        self.commit(self.main, "a.txt", "a\n", "first")
        self.git(self.main, "push", "-q", "origin", "main")
        # a `mise` that only records where `mise exec -- npm ci` was run
        self.fake_bin = os.path.join(t, "bin")
        self.mise_log = os.path.join(t, "mise.log")
        os.makedirs(self.fake_bin)
        with open(os.path.join(self.fake_bin, "mise"), "w") as f:
            f.write('#!/bin/sh\necho "$PWD $*" >> "$FAKE_MISE_LOG"\nmkdir -p node_modules/from-npm-ci\n')
        os.chmod(os.path.join(self.fake_bin, "mise"), 0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def npm_ci_runs(self):
        try:
            with open(self.mise_log) as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []

    def main_with_node_modules(self, lock="lock\n"):
        self.commit(self.main, "package-lock.json", lock, "lock")
        self.git(self.main, "push", "-q", "origin", "main")
        os.makedirs(os.path.join(self.main, "node_modules", "p"))
        with open(os.path.join(self.main, "node_modules", "p", "y"), "w") as f:
            f.write("m\n")

    def wt(self, branch):
        return os.path.join(self.main, ".claude", "worktrees", branch.replace("/", "-"))

    def commit(self, cwd, name, text, message):
        with open(os.path.join(self.inside(cwd), name), "w") as f:
            f.write(text)
        self.git(cwd, "add", name)
        self.git(cwd, "commit", "-q", "-m", message)

    def run_script(self, arg, cwd=None):
        env = {**self.env, "PATH": f"{self.fake_bin}{os.pathsep}{os.environ['PATH']}", "FAKE_MISE_LOG": self.mise_log}
        r = subprocess.run(["bash", self.script, arg], capture_output=True, text=True, cwd=self.inside(self.main if cwd is None else cwd), env=env)
        return r.returncode, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "", r.stderr

    def use(self, branch):
        return self.run_script(branch)

    def use_ok(self, branch):
        """The worktree path of a `use()` that has to work: the exit code is checked before the path is used."""
        code, path, err = self.use(branch)
        self.assertEqual(code, 0, err)
        return self.inside(path)

    def test_the_helpers_stop_on_an_empty_or_stray_path_before_they_touch_anything(self):
        for bad in ("", "relative", os.path.dirname(self.t)):
            with self.assertRaises(AssertionError):
                self.commit(bad, "stray.txt", "x\n", "stray")
            with self.assertRaises(AssertionError):
                self.git(bad, "status")
            with self.assertRaises(AssertionError):
                self.park(bad)
        self.assertFalse(os.path.exists("stray.txt"))
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.t), "stray.txt")))

    def park(self, cwd):
        return self.run_script("--park", cwd)

    def merge_to_main(self, branch):
        self.git(self.wt(branch), "push", "-q", "origin", f"{branch}:main")

    def branches(self):
        return self.git(self.main, "branch", "--format=%(refname:short)").split()

    def claim(self, n, owner):
        os.makedirs(os.path.join(self.main, ".claude", "claims", str(n)))
        with open(os.path.join(self.main, ".claude", "claims", str(n), "owner"), "w") as f:
            f.write(owner + "\n")

    def test_the_first_use_makes_a_worktree_named_after_the_branch_with_the_private_files(self):
        code, path, err = self.use("feat/one")
        self.assertEqual((code, path), (0, self.wt("feat/one")), err)
        self.assertEqual(os.path.basename(path), "feat-one")
        self.assertEqual(self.git(path, "branch", "--show-current"), "feat/one")
        with open(os.path.join(path, "secret.txt")) as f:
            self.assertEqual(f.read(), "one\n")
        self.assertFalse(os.path.exists(self.wt("work")))

    def test_a_new_branch_is_cut_from_origin_main_with_no_upstream(self):
        self.commit(self.main, "local.txt", "x\n", "local only")  # main moves ahead of origin/main
        path = self.use_ok("feat/one")
        self.assertEqual(self.git(path, "rev-parse", "HEAD"), self.git(self.main, "rev-parse", "origin/main"))
        r = subprocess.run(["git", "-C", self.inside(path), "rev-parse", "--abbrev-ref", "feat/one@{u}"], capture_output=True, text=True, cwd=self.t, env=self.env)
        self.assertNotEqual(r.returncode, 0)

    def test_two_branches_have_two_worktrees_at_once(self):
        one = self.use_ok("feat/one")
        self.commit(one, "b.txt", "b\n", "work")  # in use, and it does not matter to the other
        code, two, err = self.use("feat/two")
        self.assertEqual((code, two), (0, self.wt("feat/two")), err)
        self.assertNotEqual(one, two)
        self.assertEqual(self.git(one, "branch", "--show-current"), "feat/one")
        self.assertEqual(self.git(two, "branch", "--show-current"), "feat/two")
        self.assertFalse(os.path.exists(os.path.join(two, "b.txt")))

    def test_the_same_branch_is_a_continuation_and_the_private_files_are_copied_again(self):
        path = self.use_ok("feat/one")
        self.commit(path, "b.txt", "b\n", "work")
        with open(os.path.join(self.main, "secret.txt"), "w") as f:
            f.write("two\n")
        code, again, err = self.use("feat/one")
        self.assertEqual((code, again), (0, path), err)
        with open(os.path.join(path, "secret.txt")) as f:
            self.assertEqual(f.read(), "two\n")
        self.assertTrue(os.path.exists(os.path.join(path, "b.txt")))

    def test_the_path_of_another_branch_is_in_use(self):
        self.use_ok("feat/a-b")
        code, _, err = self.use("feat-a/b")  # the same name once the slash is a dash
        self.assertEqual(code, 3)
        self.assertIn("feat/a-b", err)
        self.assertEqual(self.git(self.wt("feat/a-b"), "branch", "--show-current"), "feat/a-b")

    def test_a_detached_worktree_at_the_path_is_in_use(self):
        self.git(self.main, "worktree", "add", "-q", "--detach", self.wt("feat/one"), "origin/main")
        code, _, err = self.use("feat/one")
        self.assertEqual(code, 3)
        self.assertIn("detached", err)

    def test_a_branch_checked_out_in_another_worktree_is_in_use_and_nothing_is_made(self):
        other = os.path.join(os.path.dirname(self.main), "elsewhere")
        self.git(self.main, "worktree", "add", "-q", "-b", "release/next", other, "origin/main")
        code, _, err = self.use("release/next")
        self.assertEqual(code, 3)
        self.assertIn(other, err)
        self.assertFalse(os.path.exists(self.wt("release/next")))
        self.assertEqual(self.use("main")[0], 3)  # the main checkout holds main

    def test_a_worktree_whose_directory_is_gone_does_not_hold_its_branch(self):
        other = os.path.join(os.path.dirname(self.main), "elsewhere")
        self.git(self.main, "worktree", "add", "-q", "-b", "release/next", other, "origin/main")
        shutil.rmtree(other)
        code, path, err = self.use("release/next")
        self.assertEqual((code, path), (0, self.wt("release/next")), err)

    def test_a_branch_that_exists_is_used_with_its_commits(self):
        self.git(self.main, "switch", "-q", "-c", "feat/old")
        self.commit(self.main, "old.txt", "o\n", "old work")
        self.git(self.main, "switch", "-q", "main")
        code, path, err = self.use("feat/old")
        self.assertEqual(code, 0, err)
        self.assertTrue(os.path.exists(os.path.join(path, "old.txt")))

    def test_a_branch_that_exists_and_is_merged_is_moved_up_to_origin_main(self):
        self.git(self.main, "branch", "release/next", "origin/main")
        self.commit(self.main, "c.txt", "c\n", "later")
        self.git(self.main, "push", "-q", "origin", "main")
        code, path, err = self.use("release/next")
        self.assertEqual(code, 0, err)
        self.assertTrue(os.path.exists(os.path.join(path, "c.txt")))

    def test_a_branch_only_on_origin_is_tracked(self):
        self.git(self.main, "switch", "-q", "-c", "feat/remote")
        self.commit(self.main, "r.txt", "r\n", "remote work")
        self.git(self.main, "push", "-q", "origin", "feat/remote")
        self.git(self.main, "switch", "-q", "main")
        self.git(self.main, "branch", "-D", "feat/remote")
        code, path, err = self.use("feat/remote")
        self.assertEqual(code, 0, err)
        self.assertTrue(os.path.exists(os.path.join(path, "r.txt")))
        self.assertEqual(self.git(path, "rev-parse", "--abbrev-ref", "feat/remote@{u}"), "origin/feat/remote")

    def test_the_target_is_cloned_without_the_incremental_directory(self):
        os.makedirs(os.path.join(self.main, "src-tauri"))
        self.commit(self.main, "src-tauri/Cargo.toml", "x\n", "src-tauri")
        self.git(self.main, "push", "-q", "origin", "main")
        target = os.path.join(self.main, "src-tauri", "target")
        os.makedirs(os.path.join(target, "debug", "incremental"))
        os.makedirs(os.path.join(target, "debug", "deps"))
        for rel in ("debug/incremental/x", "debug/deps/y"):
            with open(os.path.join(target, rel), "w") as f:
                f.write("t\n")
        path = self.use_ok("feat/one")
        copy = os.path.join(path, "src-tauri", "target", "debug")
        self.assertTrue(os.path.exists(os.path.join(copy, "deps", "y")))
        self.assertFalse(os.path.exists(os.path.join(copy, "incremental")))

    def test_npm_ci_is_run_when_the_worktree_is_made_and_node_modules_is_not_copied(self):
        self.main_with_node_modules()
        code, path, err = self.use("feat/one")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.npm_ci_runs(), [f"{path} exec -- npm ci --silent"])
        self.assertFalse(os.path.exists(os.path.join(path, "node_modules", "p")))  # the main checkout's node_modules may be old

    def test_no_lock_file_means_no_node_modules_and_no_npm_ci(self):
        path = self.use_ok("feat/one")
        self.assertEqual(self.npm_ci_runs(), [])
        self.assertFalse(os.path.exists(os.path.join(path, "node_modules")))

    def test_park_removes_the_worktree_and_the_merged_branch_and_prints_the_main_checkout(self):
        path = self.use_ok("feat/one")
        self.commit(path, "b.txt", "b\n", "work")
        self.merge_to_main("feat/one")
        code, out, err = self.park(path)
        self.assertEqual((code, out), (0, self.main), err)
        self.assertFalse(os.path.exists(path))
        self.assertNotIn("feat/one", self.branches())
        self.assertNotIn(path, self.git(self.main, "worktree", "list", "--porcelain"))
        self.assertEqual(self.use("feat/one")[0], 0)  # the name is free again

    def test_park_removes_the_ignored_files_without_force(self):
        path = self.use_ok("feat/one")
        os.makedirs(os.path.join(path, "src-tauri", "target", "debug"))
        os.makedirs(os.path.join(path, "node_modules", "p"))
        for rel in ("src-tauri/target/debug/x", "node_modules/p/y"):
            with open(os.path.join(path, rel), "w") as f:
                f.write("i\n")
        self.assertEqual(self.git(path, "status", "--porcelain"), "")
        self.assertEqual(self.park(path)[0], 0)
        self.assertFalse(os.path.exists(path))

    def test_park_keeps_a_pushed_branch_that_is_not_merged(self):
        path = self.use_ok("release/next")
        self.commit(path, "b.txt", "b\n", "release work")
        self.git(path, "push", "-q", "origin", "release/next")
        code, _, err = self.park(path)
        self.assertEqual(code, 0, err)
        self.assertFalse(os.path.exists(path))
        self.assertIn("release/next", self.branches())
        code, path, err = self.use("release/next")
        self.assertEqual(code, 0, err)
        self.assertTrue(os.path.exists(os.path.join(path, "b.txt")))

    def test_park_refuses_when_something_would_be_lost_and_removes_nothing(self):
        path = self.use_ok("feat/one")
        self.commit(path, "b.txt", "b\n", "work")
        code, _, err = self.park(path)
        self.assertEqual(code, 3)
        self.assertIn("push していないコミット", err)
        self.git(path, "push", "-q", "origin", "feat/one")
        with open(os.path.join(path, "a.txt"), "w") as f:
            f.write("changed\n")
        code, _, err = self.park(path)
        self.assertEqual(code, 3)
        self.assertIn("未コミット", err)
        self.assertTrue(os.path.exists(path))
        self.assertIn("feat/one", self.branches())

    def test_park_is_for_a_linked_worktree_under_claude_worktrees_only(self):
        self.assertEqual(self.park(self.main)[0], 3)
        outside = os.path.join(os.path.dirname(self.main), "elsewhere")
        self.git(self.main, "worktree", "add", "-q", "-b", "feat/else", outside, "origin/main")
        code, _, err = self.park(outside)
        self.assertEqual(code, 3)
        self.assertTrue(os.path.exists(outside))
        self.assertIn("feat/else", self.branches())

    def test_park_deletes_the_claims_of_this_worktree_only(self):
        one = self.use_ok("feat/one")
        two = self.use_ok("feat/two")
        for n, owner in ((5, one), (6, two), (7, one)):
            self.claim(n, owner)
        self.assertEqual(self.park(one)[0], 0)
        self.assertEqual(os.listdir(os.path.join(self.main, ".claude", "claims")), ["6"])

    def test_park_keeps_the_claims_when_it_refuses(self):
        one = self.use_ok("feat/one")
        self.commit(one, "b.txt", "b\n", "work")
        self.claim(5, one)
        self.assertEqual(self.park(one)[0], 3)
        self.assertEqual(os.listdir(os.path.join(self.main, ".claude", "claims")), ["5"])

    def test_park_with_no_claims_directory_works(self):
        one = self.use_ok("feat/one")
        self.assertEqual(self.park(one)[0], 0)


if __name__ == "__main__":
    unittest.main()
