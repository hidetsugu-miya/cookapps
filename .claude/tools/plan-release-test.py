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

    def test_urgency_importance_and_pin_in_the_snapshot(self):
        i = mk(1, ["urgency:high", "importance:low", "release:pin"], milestone="v0.40.0")
        j = pr.issue_json(i)
        self.assertEqual((j["urgency"], j["importance"], j["pin"]), ("high", "low", True))
        j = pr.issue_json(mk(2, ["importance:high"]))
        self.assertEqual((j["urgency"], j["importance"], j["pin"]), ("normal", "high", False))
        j = pr.issue_json(mk(3, ["release:now"]))
        self.assertEqual((j["urgency"], j["importance"], j["pin"]), ("normal", "normal", False))


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

    def test_cap_of_three_and_patch_bumps(self):
        queue = [mk(n, ["point:3"]) for n in range(1, 5)]
        self.assertEqual(
            slot_view(pr.allocate(queue, [], "v0.1.0")),
            [("v0.1.1", [1, 2, 3]), ("v0.1.2", [4])],
        )

    def test_documentation_does_not_count(self):
        queue = [mk(1, ["point:3"]), mk(2, ["point:3"]), mk(3, ["documentation"]), mk(4, ["point:3"]), mk(5, ["point:3"])]
        self.assertEqual(
            slot_view(pr.allocate(queue, [], "v0.1.0")),
            [("v0.1.1", [1, 2, 3, 4]), ("v0.1.2", [5])],
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

    def test_pinned_issues_share_their_version_even_with_an_8_point_one(self):
        queue = [
            mk(128, ["point:3", "release:pin"], milestone="v0.42.0", state="closed"),
            mk(135, ["point:8", "release:pin"], milestone="v0.42.0"),
            mk(140, ["point:3"]),
        ]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.41.0")), [("v0.42.0", [128, 135]), ("v0.42.1", [140])])

    def test_a_pinned_slot_keeps_its_version_and_closes_the_slot_before_it(self):
        queue = [
            mk(1, ["point:3"]),
            mk(128, ["point:3", "release:pin"], milestone="v0.42.0"),
            mk(135, ["point:8", "release:pin"], milestone="v0.42.0"),
        ]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.41.0")), [("v0.41.1", [1]), ("v0.42.0", [128, 135])])

    def test_a_later_pinned_issue_joins_the_first_one_and_the_others_stay_in_order(self):
        queue = [
            mk(128, ["point:3", "release:pin"], milestone="v0.42.0", state="closed"),
            mk(130, ["point:3"], state="closed"),
            mk(135, ["point:8", "release:pin"], milestone="v0.42.0"),
        ]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.41.0")), [("v0.42.0", [128, 135]), ("v0.42.1", [130])])

    def test_pins_of_different_versions_or_without_a_version_stay_ordinary(self):
        queue = [
            mk(1, ["point:8", "release:pin"], milestone="v0.42.0"),
            mk(2, ["point:3", "release:pin"], milestone="v0.43.0"),
            mk(3, ["point:8", "release:pin"]),
            mk(4, ["point:3", "release:pin"]),
        ]
        self.assertEqual(
            slot_view(pr.allocate(queue, [], "v0.41.0")),
            [("v0.42.0", [1]), ("v0.43.0", [2]), ("v0.43.1", [3]), ("v0.43.2", [4])],
        )

    def test_a_pinned_version_that_is_already_reached_is_refused(self):
        queue = [mk(1, ["adds:requirement"]), mk(2, ["point:8"]), mk(128, ["release:pin"], milestone="v0.42.0")]
        with self.assertRaises(pr.PlanError) as ctx:
            pr.allocate(queue, [], "v0.41.0")
        self.assertIn("v0.42.0 is pinned (#128)", ctx.exception.problems[0])
        with self.assertRaises(pr.PlanError):
            pr.allocate([mk(128, ["release:pin"], milestone="v0.41.0")], [], "v0.41.0")

    def test_an_unpinned_8_point_issue_stays_alone(self):
        queue = [mk(1, ["point:3", "release:pin"], milestone="v0.42.0"), mk(2, ["point:8"], milestone="v0.42.0")]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.41.0")), [("v0.42.0", [1]), ("v0.42.1", [2])])

    def test_a_documentation_only_pin_does_not_wait_for_the_next_slot(self):
        queue = [mk(1, ["documentation", "release:pin"], milestone="v0.42.0"), mk(2, ["point:3"])]
        self.assertEqual(slot_view(pr.allocate(queue, [], "v0.41.0")), [("v0.42.0", [1]), ("v0.42.1", [2])])

    def test_pinned_issues_are_not_derived_into_groups(self):
        a = mk(1, ["release:pin"], milestone="v0.42.0")
        b = mk(2, milestone="v0.42.0")
        c = mk(3, milestone="v0.42.0")
        self.assertEqual(pr.derive_groups([a, b, c]), [[2, 3]])

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
        queue = [mk(1, ["point:3"]), mk(2, ["point:3"]), mk(3, ["point:3"]), mk(4, ["point:3"])]
        slots = pr.allocate(queue, [[3, 4]], "v0.1.0")
        self.assertEqual(slot_view(slots), [("v0.1.1", [1, 2]), ("v0.1.2", [3, 4])])

    def test_group_that_fits_stays(self):
        queue = [mk(1, ["point:3"]), mk(2, ["point:3"]), mk(3, ["point:3"])]
        self.assertEqual(slot_view(pr.allocate(queue, [[2, 3]], "v0.1.0")), [("v0.1.1", [1, 2, 3])])

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

    def test_order_must_hold_each_free_issue_once(self):
        problems = self.check({"order": [42, 32, 32, 7, 99], "groups": [], "blocked_by": {}})
        text = "\n".join(problems)
        for needle in ("#50", "#33", "twice", "#7", "#99"):
            self.assertIn(needle, text)

    def test_group_must_be_adjacent(self):
        problems = self.check({"order": [32, 42, 50, 33], "groups": [[32, 50]], "blocked_by": {}})
        self.assertTrue(any("adjacent" in p for p in problems))

    def test_group_with_8_points_and_over_three(self):
        problems = self.check({"order": [32, 42, 50, 33], "groups": [[32, 42]], "blocked_by": {}})
        self.assertTrue(any("point:8" in p for p in problems))
        free = [mk(n) for n in (1, 2, 3, 4)]
        problems = pr.validate_plan({"order": [1, 2, 3, 4], "groups": [[1, 2, 3, 4]], "blocked_by": {}}, free, [], {})
        self.assertTrue(any("3" in p for p in problems))

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

    def test_a_group_may_not_hold_a_pinned_issue(self):
        free = [mk(1, ["release:pin"], milestone="v0.42.0"), mk(2), mk(3, ["release:pin"])]
        plan = {"order": [1, 2, 3], "groups": [[1, 2]], "blocked_by": {}}
        problems = pr.validate_plan(plan, free, [], {})
        self.assertEqual(len(problems), 1)
        self.assertIn("release:pin", problems[0])
        self.assertEqual(pr.validate_plan({"order": [1, 2, 3], "groups": [[2, 3]], "blocked_by": {}}, free, [], {}), [])

    def test_a_later_pinned_issue_may_not_depend_on_an_issue_after_the_first_pin_of_its_version(self):
        free = [mk(1, ["release:pin"], milestone="v0.42.0"), mk(2), mk(3, ["release:pin"], milestone="v0.42.0")]
        plan = {"order": [1, 2, 3], "groups": [], "blocked_by": {"3": [2]}}
        problems = pr.validate_plan(plan, free, [], {2: "open"})
        self.assertEqual(len(problems), 1)
        self.assertIn("#3", problems[0])
        self.assertIn("#2", problems[0])
        self.assertIn("v0.42.0", problems[0])
        ok = {"order": [2, 1, 3], "groups": [], "blocked_by": {"3": [2]}}
        self.assertEqual(pr.validate_plan(ok, free, [], {2: "open"}), [])
        same = [mk(1, ["release:pin"], milestone="v0.42.0"), mk(3, ["release:pin"], milestone="v0.42.0")]
        self.assertEqual(pr.validate_plan({"order": [1, 3], "groups": [], "blocked_by": {"3": [1]}}, same, [], {1: "open"}), [])

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
        self.assertEqual([i["number"] for i in out["start"]], [41, 42])
        self.assertEqual([i["number"] for i in out["in_progress"]], [37])
        self.assertEqual(out["held"], [])
        self.assertEqual([i["number"] for i in out["needs_owner"]], [38, 39])
        self.assertEqual(out["blocked"], [{"number": 40, "title": "issue 40", "blocked_by": [42]}])
        self.assertEqual([i["number"] for i in out["waiting"]], [43])
        self.assertFalse(out["later_needs_owner_only"])
        self.assertEqual(set(out["start"][0]), {"number", "title", "labels"})

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
        free = [mk(1, milestone="v0.40.0"), mk(2, milestone="v0.40.0"), mk(3, milestone="v0.41.0"), mk(4, milestone="v0.41.0"), mk(5, milestone="v0.41.0")]
        ordered = pr.existing_order(free)
        self.assertEqual(
            slot_view(pr.allocate(ordered, pr.derive_groups(ordered), "v0.39.2")),
            [("v0.39.3", [1, 2]), ("v0.39.4", [3, 4, 5])],
        )
        # without the groups, the second slot would have been packed into the first
        self.assertEqual(slot_view(pr.allocate(ordered, [], "v0.39.2")), [("v0.39.3", [1, 2, 3]), ("v0.39.4", [4, 5])])


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
