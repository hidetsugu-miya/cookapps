#!/usr/bin/env python3
"""Tests of the pure functions of plan-release.py. No network and no gh.
Run: python3 -I .claude/tools/plan-release-test.py
"""
import datetime
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("plan_release", os.path.join(here, "plan-release.py"))
pr = importlib.util.module_from_spec(spec)
sys.modules["plan_release"] = pr
spec.loader.exec_module(pr)


def mk(n, labels=(), milestone=None, created=None, state="open", closed=None, blocked=(), ms_number=None, reason=None):
    return pr.Issue(
        number=n,
        id=1000 + n,
        title=f"issue {n}",
        body="",
        labels=list(labels),
        milestone=milestone,
        milestone_number=ms_number,
        created_at=created or f"2026-11-01T00:00:{n:02d}Z",
        closed_at=closed,
        state=state,
        state_reason=reason or ("completed" if state == "closed" else None),
        blocked_by=list(blocked),
    )


def ms(number, title, state="open", open_issues=0, closed_issues=0):
    return {"number": number, "title": title, "state": state, "open_issues": open_issues, "closed_issues": closed_issues}


def slot_view(slots):
    return [(s["version"], s["issues"]) for s in slots]


class Versions(unittest.TestCase):
    def test_parse_and_compare_numerically(self):
        self.assertEqual(pr.parse_version("v0.9.0"), (0, 9, 0))
        self.assertIsNone(pr.parse_version("plan-tmp-3"))
        self.assertIsNone(pr.parse_version(None))
        self.assertEqual(pr.highest_tag(["v0.9.0", "v0.10.0", "nightly", "v0.2.5"]), "v0.10.0")
        self.assertIsNone(pr.highest_tag(["nightly"]))

    def test_base_skips_a_tag_whose_milestone_is_open(self):
        tags = ["v0.45.0", "v0.46.0"]
        open_ms = [ms(1, "v0.46.0"), ms(2, "v0.47.0")]
        self.assertEqual(pr.base_tag(tags, open_ms), "v0.45.0")
        self.assertEqual(pr.base_tag(tags, [ms(1, "v0.46.0", state="closed"), ms(2, "v0.47.0")]), "v0.46.0")
        self.assertEqual(pr.base_tag(tags, [ms(2, "v0.47.0")]), "v0.46.0")
        self.assertIsNone(pr.base_tag(["v0.46.0"], open_ms))

    def test_bump(self):
        self.assertEqual(pr.bump((0, 39, 2), True), (0, 40, 0))
        self.assertEqual(pr.bump((0, 39, 2), False), (0, 39, 3))
        self.assertEqual(pr.format_version((0, 40, 0)), "v0.40.0")


class Ordering(unittest.TestCase):
    def test_existing_order(self):
        a = mk(1, milestone="v0.41.0", created="2026-11-01T00:00:09Z")
        b = mk(2, milestone="v0.40.0", created="2026-11-01T00:00:08Z")
        c = mk(3, milestone="v0.40.0", created="2026-11-01T00:00:01Z")
        d = mk(4, created="2026-11-01T00:00:02Z")
        e = mk(5, milestone="plan-tmp-7", created="2026-11-01T00:00:00Z")
        order = [i.number for i in pr.existing_order([a, b, c, d, e])]
        self.assertEqual(order, [3, 2, 1, 5, 4])
        self.assertEqual(pr.existing_order([]), [])

    def test_version_order_is_numeric(self):
        a = mk(1, milestone="v0.10.0")
        b = mk(2, milestone="v0.9.0")
        self.assertEqual([i.number for i in pr.existing_order([a, b])], [2, 1])

    def test_quick_bugs_go_first_in_their_old_order(self):
        a = mk(1, milestone="v0.40.0", created="2026-11-01T00:00:01Z")
        b = mk(2, ["bug", "point:2"], milestone="v0.42.0", created="2026-11-01T00:00:02Z")
        c = mk(3, ["bug", "point:2"], milestone="v0.41.0", created="2026-11-01T00:00:03Z")
        d = mk(4, ["bug", "point:5"], milestone="v0.41.0", created="2026-11-01T00:00:04Z")
        e = mk(5, ["point:2"], created="2026-11-01T00:00:05Z")
        f = mk(6, ["bug", "point:2"], created="2026-11-01T00:00:06Z")
        self.assertEqual([i.number for i in pr.existing_order([a, b, c, d, e, f])], [3, 2, 6, 1, 4, 5])

    def test_bugs_of_1_2_and_3_points_go_first_but_not_those_of_5_and_8(self):
        a = mk(1, created="2026-11-01T00:00:01Z")
        b = mk(2, ["bug", "point:8"], created="2026-11-01T00:00:02Z")
        c = mk(3, ["bug", "point:5"], created="2026-11-01T00:00:03Z")
        d = mk(4, ["bug", "point:3"], created="2026-11-01T00:00:04Z")
        e = mk(5, ["bug", "point:2"], created="2026-11-01T00:00:05Z")
        f = mk(6, ["bug", "point:1"], created="2026-11-01T00:00:06Z")
        g = mk(7, ["point:1"], created="2026-11-01T00:00:07Z")
        self.assertEqual([i.number for i in pr.existing_order([a, b, c, d, e, f, g])], [4, 5, 6, 1, 2, 3, 7])

    def test_a_quick_bug_takes_its_free_blocker_with_it(self):
        a = mk(1, milestone="v0.40.0")
        b = mk(2, ["bug", "point:2"], milestone="v0.41.0", blocked=[1])
        c = mk(3, ["bug", "point:2"], milestone="v0.42.0", blocked=[99])
        d = mk(4, milestone="v0.40.0")
        self.assertEqual([i.number for i in pr.existing_order([d, a, b, c])], [1, 2, 3, 4])

    def test_blockers_of_a_quick_bug_are_taken_through_the_chain_and_shared_ones_once(self):
        x = mk(1, milestone="v0.40.0")
        y = mk(2, milestone="v0.40.0", blocked=[1])
        z = mk(3, milestone="v0.40.0")
        b1 = mk(4, ["bug", "point:2"], milestone="v0.41.0", blocked=[2])
        b2 = mk(5, ["bug", "point:2"], milestone="v0.42.0", blocked=[1, 3])
        free = [z, y, x, b2, b1]
        order = [i.number for i in pr.existing_order(free)]
        self.assertEqual(order, [1, 2, 4, 3, 5])
        problems = pr.validate_plan(
            {"order": order, "groups": [], "blocked_by": {"2": [1], "4": [2], "5": [1, 3]}},
            free,
            [],
            {n: "open" for n in range(1, 6)},
        )
        self.assertEqual(problems, [])

    def test_split_queue(self):
        w2 = mk(1, state="closed", closed="2026-11-02T00:00:00Z", milestone="v0.40.0")
        w1 = mk(2, state="closed", closed="2026-11-01T00:00:00Z", milestone="v0.40.0")
        prog = mk(3, created="2026-11-01T00:00:05Z")
        urgent = mk(4, labels=["urgency:high"])
        urgent_and_pr = mk(5, labels=["urgency:high"])
        old_label = mk(7, labels=["release:now"])
        rest = mk(6)
        dropped = mk(8, state="closed", closed="2026-11-03T00:00:00Z", milestone="v0.40.0", reason="not_planned")
        waiting, in_progress, others = pr.split_issues([w2, w1, prog, urgent, urgent_and_pr, old_label, rest, dropped], {3, 5})
        self.assertEqual([i.number for i in waiting], [2, 1])
        self.assertEqual([i.number for i in in_progress], [3, 5])
        # an urgent issue is planned like the others (the order puts it first); release:now means nothing any more
        self.assertEqual([i.number for i in others], [4, 7, 6])

    def test_urgent_issues_go_before_quick_bugs_and_the_rest(self):
        a = mk(1, milestone="v0.40.0", created="2026-11-01T00:00:01Z")
        b = mk(2, ["bug", "point:2"], milestone="v0.40.0", created="2026-11-01T00:00:02Z")
        c = mk(3, ["urgency:high"], milestone="v0.42.0", created="2026-11-01T00:00:03Z")
        d = mk(4, ["urgency:high", "bug", "point:2"], created="2026-11-01T00:00:04Z")
        e = mk(5, ["urgency:high"], milestone="v0.41.0", created="2026-11-01T00:00:05Z")
        self.assertEqual([i.number for i in pr.existing_order([a, b, c, d, e])], [5, 3, 4, 2, 1])

    def test_an_urgent_issue_takes_its_free_blocker_with_it(self):
        a = mk(1, milestone="v0.40.0")
        b = mk(2, ["urgency:high"], milestone="v0.41.0", blocked=[1])
        c = mk(3, ["bug", "point:2"], milestone="v0.39.0")
        self.assertEqual([i.number for i in pr.existing_order([c, a, b])], [1, 2, 3])

    def test_urgency_and_importance_in_the_snapshot(self):
        j = pr.issue_json(mk(1, ["urgency:high", "importance:low"], milestone="v0.40.0"))
        self.assertEqual((j["urgency"], j["importance"]), ("high", "low"))
        self.assertNotIn("pin", j)
        j = pr.issue_json(mk(2, ["importance:high"]))
        self.assertEqual((j["urgency"], j["importance"]), ("normal", "high"))
        j = pr.issue_json(mk(3, ["release:now"]))
        self.assertEqual((j["urgency"], j["importance"]), ("normal", "normal"))


class Allocation(unittest.TestCase):
    def test_current_repository(self):
        queue = [
            mk(43, ["documentation", "point:2"], state="closed"),
            mk(42, ["point:8", "adds:requirement"]),
            mk(33, ["point:8", "adds:requirement"]),
            mk(45, ["documentation", "point:2"]),
            mk(47, ["point:3"]),
            mk(48, ["point:3"]),
        ]
        slots = pr.allocate(queue, [], "v0.39.2")
        self.assertEqual(
            slot_view(slots),
            [("v0.40.0", [43, 42]), ("v0.41.0", [33]), ("v0.41.1", [45, 47, 48])],
        )

    def test_patch_issues_have_no_cap_and_share_one_version(self):
        queue = [mk(n, ["point:3"]) for n in range(1, 8)]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.1.0")), [("v0.1.1", [1, 2, 3, 4, 5, 6, 7])])

    def test_a_version_that_adds_a_requirement_is_cut_at_three(self):
        queue = [mk(n, ["point:3", "adds:requirement"]) for n in range(1, 5)]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.1.0")), [("v0.2.0", [1, 2, 3]), ("v0.3.0", [4])])
        queue = [mk(1, ["adds:requirement"])] + [mk(n, ["point:3"]) for n in range(2, 6)]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.1.0")), [("v0.2.0", [1, 2, 3]), ("v0.2.1", [4, 5])])

    def test_a_requirement_issue_does_not_join_more_than_three_patch_issues(self):
        queue = [mk(n, ["point:3"]) for n in range(1, 5)] + [mk(5, ["adds:requirement"])]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.1.0")), [("v0.1.1", [1, 2, 3, 4]), ("v0.2.0", [5])])
        queue = [mk(1, ["point:3"]), mk(2, ["point:3"]), mk(3, ["adds:requirement"])]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.1.0")), [("v0.2.0", [1, 2, 3])])

    def test_documentation_does_not_count(self):
        queue = [mk(1, ["point:3", "adds:requirement"]), mk(2, ["point:3"]), mk(3, ["documentation"]), mk(4, ["point:3"]), mk(5, ["point:3"])]
        self.assertEqual(
            slot_view(pr.allocate(queue, [], "v0.1.0")),
            [("v0.2.0", [1, 2, 3, 4]), ("v0.2.1", [5])],
        )

    def test_urgent_closes_the_slot(self):
        queue = [mk(1, ["urgency:high", "point:2"]), mk(2, ["point:2"]), mk(3, ["point:2"])]
        self.assertEqual(
            slot_view(pr.allocate(queue, [], "v0.1.0")),
            [("v0.1.1", [1]), ("v0.1.2", [2, 3])],
        )

    def test_release_now_no_longer_closes_the_slot(self):
        queue = [mk(1, ["release:now", "point:2"]), mk(2, ["point:2"]), mk(3, ["point:2"])]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.1.0")), [("v0.1.1", [1, 2, 3])])

    def test_an_8_point_issue_stays_alone_among_patch_issues(self):
        queue = [mk(1, ["point:3"]), mk(2, ["point:3"]), mk(3, ["point:8"]), mk(4, ["point:3"]), mk(5, ["point:3"])]
        self.assertEqual(
            slot_view(pr.allocate(queue, [], "v0.41.0")),
            [("v0.41.1", [1, 2]), ("v0.41.2", [3]), ("v0.41.3", [4, 5])],
        )

    def test_merged_patch_issues_and_the_ones_that_follow_share_a_version(self):
        queue = [mk(1, ["bug", "point:2"], state="closed"), mk(2, ["bug", "point:2"], state="closed")] + [
            mk(n, ["bug", "point:2"]) for n in range(3, 7)
        ]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.55.1")), [("v0.55.2", [1, 2, 3, 4, 5, 6])])

    def test_documentation_only_slot_joins_next(self):
        queue = [mk(1, ["documentation"]), mk(2, ["point:8"]), mk(3, ["point:3"])]
        self.assertEqual(
            slot_view(pr.allocate(queue, [], "v0.1.0")),
            [("v0.1.1", [1, 2]), ("v0.1.2", [3])],
        )

    def test_trailing_documentation_only_slot_stays(self):
        queue = [mk(1, ["point:8"]), mk(2, ["documentation"])]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.1.0")), [("v0.1.1", [1]), ("v0.1.2", [2])])

    def test_group_that_does_not_fit_starts_a_new_slot(self):
        queue = [mk(1, ["point:3", "adds:requirement"]), mk(2, ["point:3"]), mk(3, ["point:3"]), mk(4, ["point:3"])]
        slots = pr.allocate(queue, [[3, 4]], "v0.1.0")
        self.assertEqual(slot_view(slots), [("v0.2.0", [1, 2]), ("v0.2.1", [3, 4])])

    def test_group_that_fits_stays(self):
        queue = [mk(1, ["point:3", "adds:requirement"]), mk(2, ["point:3"]), mk(3, ["point:3"])]
        self.assertEqual(slot_view(pr.allocate(queue, [[2, 3]], "v0.1.0")), [("v0.2.0", [1, 2, 3])])

    def test_minor_bump_for_requirement_then_patch(self):
        queue = [mk(1, ["point:8", "adds:requirement"]), mk(2, ["point:8"]), mk(3, ["point:8", "adds:requirement"])]
        self.assertEqual(
            slot_view(pr.allocate(queue, [], "v0.5.3")),
            [("v0.6.0", [1]), ("v0.6.1", [2]), ("v0.7.0", [3])],
        )

    def test_no_tag_starts_from_zero(self):
        self.assertEqual(slot_view(pr.allocate([mk(1, ["adds:requirement"])], [], None)), [("v0.1.0", [1])])

    def test_empty_queue(self):
        self.assertEqual(pr.allocate([], [], "v0.1.0"), [])


class Validation(unittest.TestCase):
    def setUp(self):
        self.free = [mk(32), mk(50), mk(42, ["point:8"]), mk(33)]
        self.fixed = [mk(7)]
        self.states = {7: "open", 32: "open", 50: "open", 42: "open", 33: "open", 9: "closed"}

    def check(self, plan):
        return pr.validate_plan(plan, self.free, self.fixed, self.states)

    def test_valid(self):
        plan = {"order": [42, 32, 50, 33], "groups": [[32, 50]], "blocked_by": {"33": [42, 7, 9]}, "reasons": {}}
        self.assertEqual(self.check(plan), [])

    def test_touches_may_be_left_out_and_may_name_a_fixed_issue(self):
        plan = {"order": [42, 32, 50, 33], "touches": {"32": ["ts/a.ts", "req:A-18"], "7": ["src-tauri/src/"]}}
        self.assertEqual(self.check(plan), [])

    def test_touches_must_map_a_number_to_strings(self):
        base = {"order": [42, 32, 50, 33]}
        for touches in (["ts/a.ts"], {"32": "ts/a.ts"}, {"32": [1]}, {"x": ["ts/a.ts"]}):
            problems = self.check(dict(base, touches=touches))
            self.assertEqual(len(problems), 1, touches)
            self.assertIn("plan.touches", problems[0])

    def test_order_must_hold_each_free_issue_once(self):
        problems = self.check({"order": [42, 32, 32, 7, 99], "groups": [], "blocked_by": {}})
        text = "\n".join(problems)
        for needle in ("#50", "#33", "twice", "#7", "#99"):
            self.assertIn(needle, text)

    def test_group_must_be_adjacent(self):
        problems = self.check({"order": [32, 42, 50, 33], "groups": [[32, 50]], "blocked_by": {}})
        self.assertTrue(any("adjacent" in p for p in problems))

    def test_group_with_8_points(self):
        problems = self.check({"order": [32, 42, 50, 33], "groups": [[32, 42]], "blocked_by": {}})
        self.assertTrue(any("point:8" in p for p in problems))

    def test_group_of_documentation_may_exceed_three_members(self):
        free = [mk(1), mk(2), mk(3), mk(4, ["documentation"])]
        self.assertEqual(pr.validate_plan({"order": [1, 2, 3, 4], "groups": [[1, 2, 3, 4]], "blocked_by": {}}, free, [], {}), [])

    def test_blocker_must_come_first(self):
        problems = self.check({"order": [33, 42, 32, 50], "groups": [], "blocked_by": {"33": [42]}})
        self.assertTrue(any("#33" in p and "#42" in p for p in problems))

    def test_quick_bug_must_come_before_other_issues(self):
        free = [mk(1), mk(2, ["bug", "point:2"]), mk(3, ["bug", "point:5"]), mk(4, ["bug", "point:2"])]
        plan = lambda order, blocked=None: {"order": order, "groups": [], "blocked_by": blocked or {}}  # noqa: E731
        check = lambda p: pr.validate_plan(p, free, [], {1: "open", 2: "open", 3: "open", 4: "open"})  # noqa: E731
        self.assertEqual(check(plan([2, 4, 1, 3])), [])
        problems = check(plan([1, 2, 4, 3]))
        self.assertEqual(len(problems), 2)
        self.assertTrue(all("bug of 1, 2 or 3 points" in p and "#1" in p for p in problems))
        self.assertTrue(any("#2" in p for p in problems) and any("#4" in p for p in problems))
        problems = check(plan([2, 3, 4, 1]))
        self.assertEqual(len(problems), 1)
        self.assertIn("#3", problems[0])

    def test_bugs_of_1_2_and_3_points_must_come_first_but_not_those_of_5_and_8(self):
        free = [mk(1), mk(2, ["bug", "point:1"]), mk(3, ["bug", "point:3"]), mk(4, ["bug", "point:5"]), mk(5, ["bug", "point:8"])]
        states = {n: "open" for n in range(1, 6)}
        check = lambda order: pr.validate_plan({"order": order, "groups": [], "blocked_by": {}}, free, [], states)  # noqa: E731
        self.assertEqual(check([2, 3, 1, 4, 5]), [])
        self.assertEqual(len(check([4, 5, 2, 3, 1])), 2)
        self.assertEqual(check([2, 3, 5, 4, 1]), [])

    def test_quick_bug_may_follow_what_blocks_it(self):
        free = [mk(1), mk(5), mk(2, ["bug", "point:2"]), mk(4, ["bug", "point:2"])]
        states = {1: "open", 2: "open", 4: "open", 5: "open", 9: "closed"}
        check = lambda order, blocked: pr.validate_plan(  # noqa: E731
            {"order": order, "groups": [], "blocked_by": blocked}, free, [], states
        )
        # #2 waits for #1 directly, and #4 for #1 through #2; #5 blocks nothing
        self.assertEqual(check([1, 2, 4, 5], {"2": [1], "4": [2]}), [])
        self.assertEqual(check([1, 2, 4, 5], {"2": [1], "4": [9]}), [])
        problems = check([1, 5, 2, 4], {"2": [1]})
        self.assertTrue(any("#5" in p and "#2" in p for p in problems))
        # a blocker placed after the bug does not excuse it, and the blocker rule still applies
        problems = check([2, 1, 4, 5], {"2": [1]})
        self.assertTrue(any("blocks #2" in p for p in problems))

    def test_urgent_issue_must_come_before_other_issues_but_after_its_blockers(self):
        free = [mk(1), mk(2, ["urgency:high"]), mk(3, ["bug", "point:2"]), mk(4, ["urgency:high"])]
        states = {1: "open", 2: "open", 3: "open", 4: "open"}
        check = lambda order, blocked=None: pr.validate_plan(  # noqa: E731
            {"order": order, "groups": [], "blocked_by": blocked or {}}, free, [], states
        )
        self.assertEqual(check([2, 4, 3, 1]), [])
        problems = check([3, 2, 4, 1])
        self.assertEqual(len(problems), 2)
        self.assertTrue(all("urgency:high" in p and "#3" in p for p in problems))
        problems = check([1, 2, 4, 3])
        self.assertTrue(any("#2" in p and "#1" in p for p in problems))
        self.assertEqual(check([1, 2, 4, 3], {"2": [1], "4": [1], "3": [1]}), [])

    def test_quick_bug_may_follow_urgent_issues_only(self):
        free = [mk(1), mk(2, ["urgency:high"]), mk(3, ["bug", "point:2"])]
        states = {1: "open", 2: "open", 3: "open"}
        ok = pr.validate_plan({"order": [2, 3, 1], "groups": [], "blocked_by": {}}, free, [], states)
        self.assertEqual(ok, [])
        bad = pr.validate_plan({"order": [1, 3, 2], "groups": [], "blocked_by": {}}, free, [], states)
        self.assertEqual(len(bad), 2)

    def test_release_now_has_no_rule(self):
        free = [mk(1), mk(2, ["release:now"])]
        self.assertEqual(pr.validate_plan({"order": [1, 2], "groups": [], "blocked_by": {}}, free, [], {}), [])

    def test_a_group_of_patch_issues_has_no_cap_and_a_group_that_adds_a_requirement_holds_three(self):
        free = [mk(n) for n in range(1, 6)]
        self.assertEqual(pr.validate_plan({"order": [1, 2, 3, 4, 5], "groups": [[1, 2, 3, 4]], "blocked_by": {}}, free, [], {}), [])
        free = [mk(1, ["adds:requirement"])] + [mk(n) for n in range(2, 6)]
        problems = pr.validate_plan({"order": [1, 2, 3, 4, 5], "groups": [[1, 2, 3, 4]], "blocked_by": {}}, free, [], {})
        self.assertEqual(len(problems), 1)
        self.assertIn("more than 3", problems[0])

    def test_cycle(self):
        problems = self.check({"order": [32, 50, 42, 33], "groups": [], "blocked_by": {"32": [50], "50": [32]}})
        self.assertTrue(any("cycle" in p for p in problems))

    def test_self_block_is_a_cycle(self):
        problems = self.check({"order": [32, 50, 42, 33], "groups": [], "blocked_by": {"32": [32]}})
        self.assertTrue(any("cycle" in p for p in problems))

    def test_unknown_blocker_and_fixed_blocked(self):
        problems = self.check({"order": [32, 50, 42, 33], "groups": [], "blocked_by": {"33": [99], "7": [32]}})
        text = "\n".join(problems)
        self.assertIn("#99", text)
        self.assertIn("#7", text)

    def test_malformed(self):
        self.assertTrue(self.check({"groups": [], "blocked_by": {}}))
        self.assertTrue(self.check({"order": "x"}))


class Relations(unittest.TestCase):
    def test_diff_adds_and_removes_for_free_issues_only(self):
        current = {1: [5], 2: [6], 9: [1]}
        add, remove = pr.diff_relations([1, 2, 3], current, {1: [5, 7], 3: [2]})
        self.assertEqual(add, [(1, 7), (3, 2)])
        self.assertEqual(remove, [(2, 6)])

    def test_no_change(self):
        self.assertEqual(pr.diff_relations([1], {1: [2]}, {1: [2]}), ([], []))


class ReleaseDecision(unittest.TestCase):
    NOW = datetime.datetime(2026, 11, 6, 12, 0, tzinfo=datetime.timezone.utc)

    def waiting(self, n, labels=(), hours=1):
        closed = self.NOW - datetime.timedelta(hours=hours)
        return mk(n, labels, state="closed", milestone="v0.40.0", closed=closed.strftime("%Y-%m-%dT%H:%M:%SZ"))

    def decide(self, waiting, pr_labels=None):
        return pr.release_facts(waiting, pr_labels, self.NOW)

    def test_nothing_waits(self):
        out = self.decide([])
        self.assertEqual((out["rule"], out["decision"]), ("R4", None))
        self.assertEqual((out["changes"], out["bugs"], out["oldest_hours"]), (0, 0, None))

    def test_hold_wins_over_everything(self):
        out = self.decide([self.waiting(1, ["urgency:high"])], ["release:hold", "urgency:high"])
        self.assertEqual((out["rule"], out["decision"]), ("R0", "wait"))

    def test_urgent_change_or_urgent_release_pr(self):
        out = self.decide([self.waiting(1, ["urgency:high", "point:2"]), self.waiting(2, ["point:8"])])
        self.assertEqual((out["rule"], out["decision"]), ("R1", "release"))
        out = self.decide([self.waiting(1)], ["urgency:high"])
        self.assertEqual((out["rule"], out["decision"]), ("R1", "release"))
        out = self.decide([self.waiting(1, ["release:now"])])
        self.assertEqual(out["rule"], "R4")

    def test_8_point_change(self):
        out = self.decide([self.waiting(1, ["point:8"])])
        self.assertEqual((out["rule"], out["decision"]), ("R2", "release"))

    def test_important_bug(self):
        out = self.decide([self.waiting(1, ["bug", "importance:high"])])
        self.assertEqual((out["rule"], out["decision"]), ("R3", "release"))
        out = self.decide([self.waiting(1, ["importance:high"])])
        self.assertEqual(out["rule"], "R4")

    def test_a_change_closed_as_not_planned_does_not_wait(self):
        dropped = mk(1, ["point:8", "urgency:high"], state="closed", milestone="v0.40.0", closed="2026-11-06T11:00:00Z", reason="not_planned")
        out = self.decide([dropped])
        self.assertEqual((out["rule"], out["decision"], out["changes"], out["waiting"]), ("R4", None, 0, []))
        out = self.decide([dropped, self.waiting(2, ["bug"], hours=30)])
        self.assertEqual((out["rule"], out["changes"], out["oldest_hours"]), ("R4", 1, 30.0))

    def test_documentation_is_not_counted(self):
        out = self.decide([self.waiting(1, ["documentation", "urgency:high"]), self.waiting(2, ["documentation", "point:8"])])
        self.assertEqual((out["rule"], out["decision"], out["changes"]), ("R4", None, 0))

    def test_judgment_facts(self):
        out = self.decide(
            [self.waiting(1, ["bug"], hours=30), self.waiting(2, ["bug", "importance:low"], hours=5), self.waiting(3, hours=2)]
        )
        self.assertEqual((out["rule"], out["decision"]), ("R4", None))
        self.assertEqual((out["changes"], out["bugs"], out["oldest_hours"]), (3, 2, 30.0))
        self.assertEqual([w["number"] for w in out["waiting"]], [1, 2, 3])

    def test_the_planned_version_and_its_open_issues_are_passed_on(self):
        out = pr.release_facts([self.waiting(1)], None, self.NOW, "v0.40.0", 2)
        self.assertEqual((out["milestone"], out["milestone_open"]), ("v0.40.0", 2))
        out = self.decide([self.waiting(1)])
        self.assertEqual((out["milestone"], out["milestone_open"]), (None, None))


class Refuse(unittest.TestCase):
    def test_open_issue_without_points_label(self):
        issues = [mk(1, ["point:2"]), mk(2, ["bug"]), mk(3, state="closed")]
        self.assertEqual([i.number for i in pr.missing_points(issues)], [2])


def simulate(ops, milestones):
    """Replays the ops against fake titles and fails like GitHub (422) on a held title."""
    titles = {m["number"]: m["title"] for m in milestones}
    gone = set()
    next_number = 100
    created = {}
    for op in ops:
        if op[0] == "create":
            assert op[2] not in titles.values(), f"422 on create {op[2]}"
            titles[next_number] = op[2]
            created[op[1]] = next_number
            next_number += 1
        elif op[0] == "rename":
            assert op[2] not in titles.values(), f"422 on rename to {op[2]}"
            titles[op[1]] = op[2]
        elif op[0] == "delete":
            gone.add(op[1])
            del titles[op[1]]
    return titles, created


class Writes(unittest.TestCase):
    def test_steady_state_makes_no_write(self):
        slots = [{"version": "v0.40.0", "issues": [43, 42]}, {"version": "v0.41.0", "issues": [33]}]
        milestones = [ms(4, "v0.40.0", open_issues=1, closed_issues=1), ms(5, "v0.41.0", open_issues=1)]
        ops, errors = pr.plan_writes(slots, milestones, {43: 4, 42: 4, 33: 5})
        self.assertEqual((ops, errors), ([], []))

    def test_new_issue_creates_a_milestone_and_sets_it(self):
        slots = [{"version": "v0.40.0", "issues": [42]}, {"version": "v0.41.0", "issues": [50]}]
        milestones = [ms(4, "v0.40.0", open_issues=1)]
        ops, errors = pr.plan_writes(slots, milestones, {42: 4, 50: None})
        self.assertEqual(errors, [])
        self.assertEqual(ops, [("create", 1, "v0.41.0"), ("set", 50, ("new", 1))])

    def test_moving_an_issue_only_sets_it(self):
        slots = [{"version": "v0.40.0", "issues": [1, 2]}, {"version": "v0.41.0", "issues": [3]}]
        milestones = [ms(4, "v0.40.0", open_issues=1), ms(5, "v0.41.0", open_issues=2)]
        ops, _ = pr.plan_writes(slots, milestones, {1: 4, 2: 5, 3: 5})
        self.assertEqual(ops, [("set", 2, 4)])

    def test_swap_goes_through_a_temporary_title(self):
        slots = [{"version": "v0.40.0", "issues": [2]}, {"version": "v0.41.0", "issues": [1]}]
        milestones = [ms(4, "v0.40.0", open_issues=1), ms(5, "v0.41.0", open_issues=1)]
        ops, errors = pr.plan_writes(slots, milestones, {1: 4, 2: 5})
        self.assertEqual(errors, [])
        titles, _ = simulate(ops, milestones)
        self.assertEqual(titles, {4: "v0.41.0", 5: "v0.40.0"})
        self.assertTrue(any(op[0] == "rename" and op[2].startswith("plan-tmp-") for op in ops))
        self.assertEqual([op for op in ops if op[0] == "set"], [])

    def test_three_cycle(self):
        slots = [
            {"version": "v0.40.0", "issues": [3]},
            {"version": "v0.41.0", "issues": [1]},
            {"version": "v0.42.0", "issues": [2]},
        ]
        milestones = [ms(4, "v0.40.0", open_issues=1), ms(5, "v0.41.0", open_issues=1), ms(6, "v0.42.0", open_issues=1)]
        ops, errors = pr.plan_writes(slots, milestones, {1: 4, 2: 5, 3: 6})
        self.assertEqual(errors, [])
        titles, _ = simulate(ops, milestones)
        self.assertEqual(titles, {4: "v0.41.0", 5: "v0.42.0", 6: "v0.40.0"})

    def test_shift_by_one_needs_no_temporary_title(self):
        slots = [{"version": "v0.41.0", "issues": [1]}, {"version": "v0.42.0", "issues": [2]}]
        milestones = [ms(4, "v0.40.0", open_issues=1), ms(5, "v0.41.0", open_issues=1)]
        ops, errors = pr.plan_writes(slots, milestones, {1: 4, 2: 5})
        self.assertEqual(errors, [])
        titles, _ = simulate(ops, milestones)
        self.assertEqual(sorted(titles.values()), ["v0.41.0", "v0.42.0"])
        self.assertFalse(any(op[2].startswith("plan-tmp-") for op in ops if op[0] == "rename"))

    def test_target_held_by_a_closed_milestone_is_an_error(self):
        slots = [{"version": "v0.39.2", "issues": [1]}]
        milestones = [ms(3, "v0.39.2", state="closed", closed_issues=1)]
        ops, errors = pr.plan_writes(slots, milestones, {1: None})
        self.assertEqual(ops, [])
        self.assertEqual(len(errors), 1)
        self.assertIn("v0.39.2", errors[0])
        self.assertIn("#3", errors[0])

    def test_empty_milestone_is_deleted_only_when_its_title_is_ours(self):
        slots = [{"version": "v0.40.0", "issues": [1]}]
        milestones = [
            ms(4, "v0.40.0", open_issues=1),
            ms(5, "v0.41.0"),
            ms(6, "plan-tmp-6"),
            ms(7, "backlog"),
            ms(8, "v0.42.0", open_issues=1),
        ]
        ops, _ = pr.plan_writes(slots, milestones, {1: 4})
        self.assertEqual(ops, [("delete", 5), ("delete", 6)])

    def test_unclaimed_milestone_with_foreign_issues_is_kept(self):
        slots = [{"version": "v0.40.0", "issues": [1]}]
        milestones = [ms(4, "v0.40.0", open_issues=1), ms(5, "v0.41.0", open_issues=2)]
        ops, _ = pr.plan_writes(slots, milestones, {1: 4})
        self.assertEqual(ops, [])

    def test_issue_leaving_makes_its_old_milestone_empty_and_deleted(self):
        slots = [{"version": "v0.40.0", "issues": [1, 2]}]
        milestones = [ms(4, "v0.40.0", open_issues=1), ms(5, "v0.41.0", open_issues=1)]
        ops, _ = pr.plan_writes(slots, milestones, {1: 4, 2: 5})
        self.assertEqual(ops, [("set", 2, 4), ("delete", 5)])

    def test_leftover_temporary_milestone_is_reused(self):
        slots = [{"version": "v0.40.0", "issues": [1, 2]}]
        milestones = [ms(4, "plan-tmp-4", open_issues=2)]
        ops, errors = pr.plan_writes(slots, milestones, {1: 4, 2: 4})
        self.assertEqual(errors, [])
        self.assertEqual(ops, [("rename", 4, "v0.40.0")])

    def test_unclaimed_holder_of_a_needed_title_is_reused_instead_of_a_create(self):
        slots = [{"version": "v0.40.0", "issues": [1]}, {"version": "v0.41.0", "issues": [2]}]
        milestones = [ms(4, "v0.40.0", open_issues=1), ms(5, "v0.41.0")]
        ops, errors = pr.plan_writes(slots, milestones, {1: 4, 2: None})
        self.assertEqual(errors, [])
        self.assertEqual(ops, [("set", 2, 5)])

    def test_rename_blocked_by_an_unclaimed_holder_evicts_it(self):
        slots = [{"version": "v0.40.0", "issues": [1]}]
        milestones = [ms(4, "v0.39.9", open_issues=1), ms(5, "v0.40.0", open_issues=1)]
        ops, errors = pr.plan_writes(slots, milestones, {1: 4, 2: 5})
        self.assertEqual(errors, [])
        titles, _ = simulate(ops, milestones)
        self.assertEqual(titles[4], "v0.40.0")

    def test_milestone_with_most_members_is_taken(self):
        slots = [{"version": "v0.40.0", "issues": [1, 2, 3]}]
        milestones = [ms(4, "v0.40.0", open_issues=1), ms(5, "v0.99.0", open_issues=2)]
        ops, _ = pr.plan_writes(slots, milestones, {1: 4, 2: 5, 3: 5})
        titles, _ = simulate(ops, milestones)
        self.assertEqual(titles[5], "v0.40.0")
        self.assertIn(("set", 1, 5), ops)


class Report(unittest.TestCase):
    def test_lines(self):
        slots = [{"version": "v0.40.0", "issues": [42, 43]}, {"version": "v0.41.0", "issues": [33]}]
        issues = {42: mk(42, milestone="v0.40.0"), 43: mk(43, milestone="v0.39.2"), 33: mk(33)}
        lines = pr.result_lines(slots, issues, {"33": "after #42"})
        self.assertEqual(lines, ["#42 v0.40.0", "#43 v0.40.0 (was v0.39.2)", "#33 v0.41.0 - after #42"])


class Next(unittest.TestCase):
    def test_next(self):
        milestones = [ms(4, "v0.40.0"), ms(5, "v0.41.0"), ms(6, "v0.41.1"), ms(7, "backlog")]
        issues = [
            mk(43, ["documentation"], milestone="v0.40.0", state="closed", closed="2026-11-04T00:00:00Z"),
            mk(44, ["point:8"], milestone="v0.40.0", state="closed", closed="2026-11-04T01:00:00Z", reason="not_planned"),
            mk(42, ["point:8"], milestone="v0.40.0"),
            mk(41, ["point:2"], milestone="v0.40.0", created="2026-11-01T00:00:01Z"),
            mk(40, ["point:2"], milestone="v0.40.0", blocked=[42]),
            mk(39, ["needs:owner"], milestone="v0.40.0"),
            mk(38, ["needs:owner"], milestone="v0.40.0", blocked=[42]),
            mk(37, [], milestone="v0.40.0"),
            mk(33, [], milestone="v0.41.0"),
            mk(48, ["needs:owner"], milestone="v0.41.1"),
        ]
        out = pr.build_next(issues, milestones, {37}, mine={37})
        self.assertEqual(out["milestone"], "v0.40.0")
        self.assertEqual([i["number"] for i in out["start"]], [41, 42, 33])
        self.assertEqual([i["milestone"] for i in out["start"]], ["v0.40.0", "v0.40.0", "v0.41.0"])
        self.assertEqual([i["number"] for i in out["in_progress"]], [37])
        self.assertEqual(out["held"], [])
        self.assertEqual([i["number"] for i in out["needs_owner"]], [38, 39])
        self.assertEqual(out["blocked"], [{"number": 40, "title": "issue 40", "blocked_by": [42]}])
        self.assertEqual([i["number"] for i in out["waiting"]], [43])
        self.assertFalse(out["later_needs_owner_only"])
        self.assertEqual(set(out["start"][0]), {"number", "title", "labels", "milestone"})

    def test_an_issue_another_session_has_is_held(self):
        milestones = [ms(4, "v0.40.0")]
        issues = [mk(n, milestone="v0.40.0") for n in (1, 2, 3, 4)] + [mk(5, ["needs:owner"], milestone="v0.40.0")]
        out = pr.build_next(issues, milestones, {1, 2}, {3: "fix/issue-3-x", 4: "fix/issue-4-y", 5: "fix/issue-5-z"}, mine={2, 4})
        self.assertEqual([i["number"] for i in out["start"]], [4])
        self.assertEqual([i["number"] for i in out["in_progress"]], [2])
        self.assertEqual(
            [(i["number"], i["reason"]) for i in out["held"]], [(1, "pull request open"), (3, "worktree fix/issue-3-x")]
        )
        self.assertEqual([i["number"] for i in out["needs_owner"]], [5])

    def test_parallel_leaves_out_what_overlaps_an_issue_another_session_holds_in_any_milestone(self):
        milestones = [ms(4, "v0.40.0"), ms(5, "v0.41.0")]
        issues = [
            mk(1, milestone="v0.40.0"),
            mk(2, milestone="v0.40.0"),
            mk(3, milestone="v0.40.0"),
            mk(4, milestone="v0.41.0"),
            mk(5, milestone="v0.41.0"),
        ]
        plan = {
            "order": [1, 2, 3, 4, 5],
            "touches": {"1": ["ts/a.ts"], "2": ["ts/b.ts"], "3": ["ts/c.ts"], "4": ["ts/d.ts"], "5": ["ts/e.ts"]},
        }
        out = pr.build_next(issues, milestones, {3}, {4: "fix/issue-4-x"}, plan=plan)
        self.assertEqual([i["number"] for i in out["start"]], [1, 2, 5])
        self.assertEqual(out["parallel"], [1, 2, 5])
        plan["touches"]["1"] = ["ts/c.ts"]
        plan["touches"]["5"] = ["ts/d.ts"]
        out = pr.build_next(issues, milestones, {3}, {4: "fix/issue-4-x"}, plan=plan)
        self.assertEqual(out["parallel"], [2])

    def test_worktree_issues(self):
        porcelain = (
            "worktree /w/cookapps\nHEAD aaa\nbranch refs/heads/issue-9-main\n\n"
            "worktree /w/cookapps/.claude/worktrees/fix-issue-12-foo\nHEAD bbb\nbranch refs/heads/fix/issue-12-foo\n\n"
            "worktree /w/cookapps/.claude/worktrees/issue-7\nHEAD ccc\nbranch refs/heads/feat/C-2\n\n"
            "worktree /w/cookapps/.claude/worktrees/feat-C-2\nHEAD ddd\nbranch refs/heads/feat/C-2\nlocked\n\n"
            "worktree /w/cookapps/.claude/worktrees/x\nHEAD eee\ndetached\n"
        )
        self.assertEqual(pr.worktree_issues(porcelain), {12: "fix/issue-12-foo", 7: "feat/C-2"})
        self.assertEqual(pr.worktree_issues(""), {})

    def test_later_milestones_only_need_the_owner(self):
        milestones = [ms(4, "v0.40.0"), ms(6, "v0.41.1")]
        issues = [mk(1, [], milestone="v0.40.0"), mk(2, ["needs:owner"], milestone="v0.41.1")]
        self.assertTrue(pr.build_next(issues, milestones, set())["later_needs_owner_only"])

    def test_skips_a_milestone_without_open_issues(self):
        milestones = [ms(4, "v0.40.0"), ms(5, "v0.41.0")]
        issues = [mk(1, milestone="v0.40.0", state="closed", closed="2026-11-04T00:00:00Z"), mk(2, milestone="v0.41.0")]
        out = pr.build_next(issues, milestones, set())
        self.assertEqual(out["milestone"], "v0.41.0")
        self.assertEqual([i["number"] for i in out["waiting"]], [1])

    def test_nothing_planned(self):
        out = pr.build_next([], [ms(4, "v0.40.0")], set())
        self.assertIsNone(out["milestone"])
        self.assertEqual(out["start"], [])
        self.assertFalse(out["later_needs_owner_only"])


class Prune(unittest.TestCase):
    states = {1: "open", 2: "open", 3: "open", 4: "closed", 5: "open", 6: "closed"}

    def prune(self, plan, fixed=(5,)):
        return pr.prune_plan(plan, self.states, set(fixed))

    def test_closed_and_fixed_issues_leave_every_part_of_the_plan(self):
        plan = {
            "order": [4, 1, 5, 2, 3],
            "groups": [[1, 2], [4, 3]],
            "blocked_by": {"4": [1], "2": [5, 4], "3": [4]},
            "reasons": {"4": "r4", "1": "r1", "5": "r5"},
            "touches": {"4": ["a"], "1": ["b"], "5": ["c"]},
        }
        pruned, dropped = self.prune(plan)
        self.assertEqual(pruned["order"], [1, 2, 3])
        self.assertEqual(pruned["groups"], [[1, 2]])
        self.assertEqual(pruned["blocked_by"], {"2": [5, 4], "3": [4]})
        self.assertEqual(pruned["reasons"], {"1": "r1"})
        self.assertEqual(pruned["touches"], plan["touches"])
        self.assertEqual(dropped, [(4, "closed"), (5, "fixed")])

    def test_a_group_left_with_fewer_than_two_is_dropped_and_one_that_lost_nothing_stays(self):
        pruned, _ = self.prune({"order": [1, 2, 3, 4, 5], "groups": [[1, 4], [2, 3], [5]]})
        self.assertEqual(pruned["groups"], [[2, 3]])
        pruned, _ = self.prune({"order": [1, 2, 3], "groups": [[3]]})
        self.assertEqual(pruned["groups"], [[3]])

    def test_a_group_member_not_in_order_is_still_dropped(self):
        pruned, dropped = self.prune({"order": [1, 2], "groups": [[2, 4]]})
        self.assertEqual(pruned["groups"], [])
        self.assertEqual(dropped, [(4, "closed")])

    def test_a_number_nobody_knows_stays_for_the_validation_to_refuse(self):
        pruned, dropped = self.prune({"order": [1, 99, 4]})
        self.assertEqual(pruned["order"], [1, 99])
        self.assertEqual(dropped, [(4, "closed")])
        free = [mk(1)]
        problems = pr.validate_plan(pruned, free, [], {1: "open"})
        self.assertTrue(any("#99" in p for p in problems))

    def test_fixed_wins_over_closed_and_each_number_is_reported_once(self):
        pruned, dropped = pr.prune_plan({"order": [6, 1], "reasons": {"6": "x"}, "blocked_by": {"6": [1]}}, self.states, {6})
        self.assertEqual(dropped, [(6, "fixed")])
        self.assertEqual(pruned, {"order": [1], "groups": [], "blocked_by": {}, "reasons": {}})

    def test_a_plan_of_the_wrong_shape_is_returned_as_it_is(self):
        for plan in ({"order": "x"}, [1, 2], {"order": [1], "touches": {"1": "a"}}):
            self.assertEqual(pr.prune_plan(plan, self.states, set()), (plan, []))

    def test_a_pruned_plan_passes_the_validation_that_the_full_one_fails(self):
        free = [mk(1), mk(2)]
        fixed = [mk(5)]
        states = {1: "open", 2: "open", 5: "open", 4: "closed"}
        plan = {"order": [4, 1, 5, 2], "blocked_by": {"2": [1]}}
        self.assertTrue(pr.validate_plan(plan, free, fixed, states))
        pruned, _ = pr.prune_plan(plan, states, {5})
        self.assertEqual(pr.validate_plan(pruned, free, fixed, states), [])

    def test_mentioned(self):
        plan = {"order": [3, 1], "groups": [[1, 2]], "blocked_by": {"4": [9]}, "reasons": {"5": "x", "3": "y"}}
        self.assertEqual(pr.mentioned(plan), [3, 1, 2, 4, 5])
        self.assertEqual(pr.mentioned({"order": "x"}), [])


class Overlap(unittest.TestCase):
    def test_equal_entries_overlap(self):
        self.assertTrue(pr.overlaps(["ts/a.ts"], ["ts/b.ts", "ts/a.ts"]))
        self.assertTrue(pr.overlaps(["req:A-18"], ["req:A-18"]))
        self.assertFalse(pr.overlaps(["ts/a.ts", "req:A-1"], ["ts/b.ts", "req:A-18"]))

    def test_a_directory_overlaps_what_lies_under_it(self):
        self.assertTrue(pr.overlaps(["src-tauri/src/"], ["src-tauri/src/orca.rs"]))
        self.assertTrue(pr.overlaps(["src-tauri/src/orca.rs"], ["src-tauri/src/"]))
        self.assertTrue(pr.overlaps(["src-tauri/"], ["src-tauri/src/"]))
        self.assertFalse(pr.overlaps(["src-tauri/src/"], ["src-tauri/srcs/a.rs"]))
        self.assertFalse(pr.overlaps(["src-tauri/src"], ["src-tauri/src/orca.rs"]))

    def test_an_unknown_issue_overlaps_every_issue(self):
        self.assertTrue(pr.overlaps(None, ["a"]))
        self.assertTrue(pr.overlaps(["a"], None))
        self.assertTrue(pr.overlaps(None, None))
        self.assertTrue(pr.overlaps(None, []))

    def test_an_issue_that_touches_nothing_overlaps_no_known_issue(self):
        self.assertFalse(pr.overlaps([], ["a"]))


class ClosedStates(unittest.TestCase):
    def test_the_milestones_to_read_are_the_closed_ones_with_closed_issues_newest_first(self):
        milestones = [
            ms(1, "v0.38.0", "closed", 0, 4),
            ms(2, "v0.40.0", "closed", 0, 2),
            ms(3, "v0.39.0", "closed", 0, 0),
            ms(4, "v0.41.0", "open", 1, 1),
            ms(5, "backlog", "closed", 0, 3),
            ms(6, "v0.39.1", "closed", 0, 1),
        ]
        self.assertEqual(pr.closed_milestone_numbers(milestones), [2, 6, 1])

    def test_the_issues_read_in_bulk_are_the_closed_numbers_asked_for(self):
        raw = [
            {"number": 5, "state": "closed"},
            {"number": 6, "state": "closed", "pull_request": {}},
            {"number": 7, "state": "closed"},
            {"number": 8, "state": "open"},
        ]
        self.assertEqual(pr.closed_in(raw, {5, 6, 8, 9}), {5: "closed"})
        self.assertEqual(pr.closed_in([], {5}), {})


class Parallel(unittest.TestCase):
    def test_overlapping_issues_are_skipped_and_the_next_is_looked_at(self):
        touches = {1: ["ts/a.ts"], 2: ["ts/a.ts"], 3: ["ts/b.ts"], 4: ["ts/c.ts"], 5: ["ts/d.ts"]}
        self.assertEqual(pr.pick_parallel([1, 2, 3, 4, 5], [], touches), [1, 3, 4])

    def test_the_cap_counts_the_issues_in_progress(self):
        touches = {n: [f"ts/{n}.ts"] for n in range(1, 8)}
        self.assertEqual(pr.pick_parallel([1, 2, 3, 4], [], touches), [1, 2, 3])
        self.assertEqual(pr.pick_parallel([1, 2, 3, 4], [5], touches), [1, 2])
        self.assertEqual(pr.pick_parallel([1, 2, 3, 4], [5, 6], touches), [1])
        self.assertEqual(pr.pick_parallel([1, 2, 3, 4], [5, 6, 7], touches), [])

    def test_an_issue_overlapping_one_in_progress_is_skipped(self):
        touches = {1: ["ts/a.ts"], 2: ["ts/b.ts"], 9: ["ts/a.ts"]}
        self.assertEqual(pr.pick_parallel([1, 2], [9], touches), [2])

    def test_an_issue_the_plan_does_not_know_overlaps_all(self):
        touches = {1: ["ts/a.ts"], 3: ["ts/c.ts"]}
        self.assertEqual(pr.pick_parallel([2, 1, 3], [], touches), [2])
        self.assertEqual(pr.pick_parallel([1, 2, 3], [], touches), [1, 3])
        self.assertEqual(pr.pick_parallel([1, 3], [9], touches), [])

    def test_the_first_unknown_candidate_alone_when_nothing_is_in_progress(self):
        self.assertEqual(pr.pick_parallel([1, 2, 3], [], {}), [1])

    def test_nothing_to_start(self):
        self.assertEqual(pr.pick_parallel([], [], {}), [])
        self.assertEqual(pr.PARALLEL, 3)

    def test_an_issue_overlapping_one_another_session_holds_is_skipped(self):
        touches = {1: ["ts/a.ts"], 2: ["ts/b.ts"], 9: ["ts/a.ts"]}
        self.assertEqual(pr.pick_parallel([1, 2], [], touches, [9]), [2])

    def test_the_issues_held_by_other_sessions_are_not_counted_in_the_cap(self):
        touches = {n: [f"ts/{n}.ts"] for n in range(1, 10)}
        self.assertEqual(pr.pick_parallel([1, 2, 3, 4], [], touches, [7, 8, 9]), [1, 2, 3])
        self.assertEqual(pr.pick_parallel([1, 2, 3, 4], [5], touches, [7, 8, 9]), [1, 2])

    def test_a_held_issue_the_plan_does_not_know_overlaps_all(self):
        self.assertEqual(pr.pick_parallel([1, 2], [], {1: ["ts/a.ts"], 2: ["ts/b.ts"]}, [9]), [])


class NextAcrossMilestones(unittest.TestCase):
    milestones = [ms(4, "v0.40.0"), ms(5, "v0.41.0"), ms(6, "v0.42.0")]

    def test_start_runs_through_the_later_milestones_in_the_order_of_the_plan(self):
        issues = [
            mk(10, milestone="v0.40.0"),
            mk(11, milestone="v0.40.0"),
            mk(12, milestone="v0.41.0"),
            mk(13, milestone="v0.41.0"),
            mk(14, milestone="v0.42.0"),
            mk(15, milestone="v0.42.0"),
        ]
        plan = {"order": [11, 10, 13, 12, 15, 14], "touches": {}}
        out = pr.build_next(issues, self.milestones, set(), plan=plan)
        self.assertEqual([i["number"] for i in out["start"]], [11, 10, 13, 12, 15, 14])
        self.assertEqual(out["milestone"], "v0.40.0")

    def test_the_issues_the_plan_lacks_come_last_in_their_version_oldest_first(self):
        issues = [
            mk(10, milestone="v0.40.0", created="2026-11-01T00:00:05Z"),
            mk(11, milestone="v0.40.0", created="2026-11-01T00:00:01Z"),
            mk(12, milestone="v0.40.0", created="2026-11-01T00:00:03Z"),
            mk(13, milestone="v0.41.0", created="2026-11-01T00:00:02Z"),
            mk(14, milestone="v0.41.0", created="2026-11-01T00:00:01Z"),
        ]
        out = pr.build_next(issues, self.milestones, set(), plan={"order": [12, 13]})
        self.assertEqual([i["number"] for i in out["start"]], [12, 11, 10, 13, 14])
        out = pr.build_next(issues, self.milestones, set())
        self.assertEqual([i["number"] for i in out["start"]], [11, 12, 10, 14, 13])

    def test_needs_owner_held_and_blocked_issues_of_a_later_milestone_are_left_out_and_not_reported(self):
        issues = [
            mk(10, milestone="v0.40.0"),
            mk(21, ["needs:owner"], milestone="v0.41.0"),
            mk(22, milestone="v0.41.0"),
            mk(23, milestone="v0.41.0"),
            mk(24, milestone="v0.41.0", blocked=[10]),
            mk(25, milestone="v0.41.0"),
            mk(26, milestone="v0.41.0"),
        ]
        out = pr.build_next(issues, self.milestones, {22}, {23: "fix/issue-23-x"}, mine={26})
        self.assertEqual([i["number"] for i in out["start"]], [10, 25, 26])
        self.assertEqual(out["held"], [])
        self.assertEqual(out["needs_owner"], [])
        self.assertEqual(out["blocked"], [])

    def test_the_later_milestones_are_taken_and_an_issue_that_merges_first_breaks_no_allocation(self):
        issues = [
            mk(10, ["point:8", "adds:requirement"], milestone="v0.40.0"),
            mk(11, ["adds:requirement"], milestone="v0.41.0"),
            mk(12, ["adds:requirement"], milestone="v0.41.0"),
        ]
        plan = {"order": [10, 11, 12], "touches": {"10": ["ts/a.ts"], "11": ["ts/b.ts"], "12": ["ts/c.ts"]}}
        out = pr.build_next(issues, self.milestones, set(), plan=plan)
        self.assertEqual(out["parallel"], [10, 11, 12])
        done = mk(11, ["adds:requirement"], milestone="v0.41.0", state="closed")
        queue = [done, issues[0], issues[2]]
        self.assertEqual(
            slot_view(pr.allocate(queue, [], "v0.39.0")),
            [("v0.40.0", [11]), ("v0.41.0", [10]), ("v0.42.0", [12])],
        )

    def test_an_issue_of_this_run_in_progress_in_a_later_milestone_is_in_progress(self):
        issues = [mk(10, milestone="v0.40.0"), mk(12, milestone="v0.41.0"), mk(13, milestone="v0.41.0")]
        out = pr.build_next(issues, self.milestones, {12, 13}, mine={12})
        self.assertEqual([(i["number"], i["milestone"]) for i in out["in_progress"]], [(12, "v0.41.0")])
        self.assertEqual([i["number"] for i in out["start"]], [10])
        self.assertEqual(out["held"], [])

    def test_parallel_picks_the_issues_that_do_not_overlap(self):
        issues = [mk(10, milestone="v0.40.0"), mk(11, milestone="v0.40.0"), mk(12, milestone="v0.41.0"), mk(13, milestone="v0.42.0")]
        plan = {
            "order": [10, 11, 12, 13],
            "touches": {"10": ["ts/a.ts"], "11": ["ts/a.ts"], "12": ["ts/b.ts"], "13": ["req:A-18"]},
        }
        out = pr.build_next(issues, self.milestones, set(), plan=plan)
        self.assertEqual(out["parallel"], [10, 12, 13])

    def test_parallel_leaves_room_for_the_issues_in_progress_and_avoids_their_files(self):
        issues = [mk(9, milestone="v0.40.0"), mk(10, milestone="v0.40.0"), mk(11, milestone="v0.40.0"), mk(12, milestone="v0.41.0")]
        plan = {"order": [10, 11, 12], "touches": {"9": ["ts/a.ts"], "10": ["ts/a.ts"], "11": ["ts/b.ts"], "12": ["ts/c.ts"]}}
        out = pr.build_next(issues, self.milestones, {9}, mine={9}, plan=plan)
        self.assertEqual(out["parallel"], [11, 12])

    def test_without_a_plan_one_issue_is_picked(self):
        issues = [mk(10, milestone="v0.40.0"), mk(11, milestone="v0.41.0")]
        out = pr.build_next(issues, self.milestones, set())
        self.assertEqual(out["parallel"], [10])
        self.assertEqual([i["number"] for i in out["start"]], [10, 11])

    def test_a_broken_plan_is_taken_as_no_plan(self):
        issues = [mk(10, milestone="v0.40.0"), mk(11, milestone="v0.41.0")]
        out = pr.build_next(issues, self.milestones, set(), plan={"order": "x"})
        self.assertEqual(out["parallel"], [10])

    def test_nothing_planned_has_no_parallel(self):
        self.assertEqual(pr.build_next([], [ms(4, "v0.40.0")], set())["parallel"], [])


class SavedPlan(unittest.TestCase):
    def test_the_plan_lives_in_the_main_checkout(self):
        self.assertEqual(pr.plan_file("/w/cookapps/.git"), "/w/cookapps/.claude/plan.json")
        self.assertEqual(pr.plan_file("/w/cookapps/.git/"), "/w/cookapps/.claude/plan.json")

    def test_save_and_read(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "plan.json")
            self.assertIsNone(pr.read_plan(path))
            plan = {"order": [1, 2], "groups": [], "blocked_by": {}, "touches": {"1": ["ts/a.ts"]}}
            pr.save_plan(path, plan)
            self.assertEqual(pr.read_plan(path), plan)
            self.assertEqual(os.listdir(d), ["plan.json"])
            pr.save_plan(path, {"order": [3]})
            self.assertEqual(pr.read_plan(path), {"order": [3]})

    def test_a_broken_plan_is_ignored_with_one_line(self):
        import contextlib
        import io

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "plan.json")
            for text in ("{", '{"order": "x"}', "[1]"):
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    self.assertIsNone(pr.read_plan(path), text)
                self.assertEqual(len(err.getvalue().strip().splitlines()), 1, text)
                self.assertIn("ignored", err.getvalue())


class DeriveGroups(unittest.TestCase):
    def test_consecutive_issues_of_one_milestone_form_a_group(self):
        free = [mk(1, milestone="v0.40.0"), mk(2, milestone="v0.40.0"), mk(3, milestone="v0.41.0"), mk(4, milestone="v0.41.0"), mk(5, milestone="v0.41.0")]
        self.assertEqual(pr.derive_groups(free), [[1, 2], [3, 4, 5]])

    def test_singles_unplanned_and_temporary_milestones_form_no_group(self):
        free = [mk(1, milestone="v0.40.0"), mk(2, milestone="v0.41.0"), mk(3), mk(4), mk(5, milestone="plan-tmp-7"), mk(6, milestone="plan-tmp-7")]
        self.assertEqual(pr.derive_groups(free), [])

    def test_not_consecutive_is_not_a_group(self):
        free = [mk(1, milestone="v0.40.0"), mk(2, milestone="v0.41.0"), mk(3, milestone="v0.40.0")]
        self.assertEqual(pr.derive_groups(free), [])

    def test_8_point_issue_breaks_a_run(self):
        free = [mk(1, milestone="v0.40.0"), mk(2, ["point:8"], milestone="v0.40.0"), mk(3, milestone="v0.40.0"), mk(4, milestone="v0.40.0")]
        self.assertEqual(pr.derive_groups(free), [[3, 4]])

    def test_run_over_the_cap_is_left_to_the_allocation(self):
        free = [mk(n, milestone="v0.40.0") for n in range(1, 5)]
        self.assertEqual(pr.derive_groups(free), [])

    def test_documentation_does_not_count_toward_the_cap(self):
        free = [mk(1, milestone="v0.40.0"), mk(2, milestone="v0.40.0"), mk(3, milestone="v0.40.0"), mk(4, ["documentation"], milestone="v0.40.0")]
        self.assertEqual(pr.derive_groups(free), [[1, 2, 3, 4]])

    def test_sync_keeps_the_slots_of_a_previous_plan(self):
        free = [mk(1, ["adds:requirement"], milestone="v0.40.0"), mk(2, milestone="v0.40.0")] + [
            mk(n, ["adds:requirement"], milestone="v0.41.0") for n in (3, 4, 5)
        ]
        ordered = pr.existing_order(free)
        self.assertEqual(
            slot_view(pr.allocate(ordered, pr.derive_groups(ordered), "v0.39.2")),
            [("v0.40.0", [1, 2]), ("v0.41.0", [3, 4, 5])],
        )
        # without the groups, the second slot would have been packed into the first
        self.assertEqual(slot_view(pr.allocate(ordered, [], "v0.39.2")), [("v0.40.0", [1, 2, 3]), ("v0.41.0", [4, 5])])


# The hooks that run are the main checkout's (a worktree's own copy takes effect after the merge): test those
_common = subprocess.run(
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=here, check=True, capture_output=True, text=True
).stdout.strip()
HOOK = os.path.join(os.path.dirname(_common), ".claude", "hooks", "post-gh.sh")


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

    def test_merge_runs_sync(self):
        for cmd in ["gh pr merge --merge", "cd x && gh pr merge 5 --merge", "a; gh pr merge", "echo hi | gh pr merge", "echo x\ngh pr merge"]:
            self.assertIn("STUB", self.run_hook(cmd), cmd)

    def test_sync_failure_is_passed_on(self):
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

    def test_issue_create_and_needs_owner_removal_point_to_issue_plan(self):
        for cmd in [
            "gh issue create --title x",
            "gh issue edit 5 --remove-label needs:owner",
            'gh issue edit 5 --remove-label "bug,needs:owner"',
            "cd x && gh issue create",
        ]:
            self.assertIn("issue-plan", self.run_hook(cmd), cmd)

    def test_text_that_only_mentions_a_command_does_nothing(self):
        for cmd in [
            "ls -la",
            "gh issue edit 5 --add-label bug",
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


class Stream(unittest.TestCase):
    def test_paginated_output_is_flattened(self):
        self.assertEqual(pr.parse_stream('[{"a":1}][{"a":2}]\n[]'), [{"a": 1}, {"a": 2}])
        self.assertEqual(pr.parse_stream('{"a":1}'), [{"a": 1}])
        self.assertEqual(pr.parse_stream(""), [])


if __name__ == "__main__":
    unittest.main()
