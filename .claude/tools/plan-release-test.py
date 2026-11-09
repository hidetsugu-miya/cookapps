#!/usr/bin/env python3
"""Tests of the pure functions of plan-release.py, and of the shell tools around the nightly run (nightly-limit.sh, use-worktree.sh) and the hook post-gh.sh.
No network and no gh.
Run: python3 -I .claude/tools/plan-release-test.py
"""
import contextlib
import importlib.util
import io
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
    def test_the_basis_is_importance_then_fewer_points_then_older(self):
        a = mk(1, ["point:3"], created="2026-11-01T00:00:01Z")
        b = mk(2, ["point:1"], created="2026-11-01T00:00:02Z")
        c = mk(3, ["point:1", "importance:high"], created="2026-11-01T00:00:03Z")
        d = mk(4, ["point:1", "importance:low"], created="2026-11-01T00:00:04Z")
        e = mk(5, ["point:1"], created="2026-11-01T00:00:00Z")
        self.assertEqual(numbers(pr.base_order([a, b, c, d, e])), [3, 5, 2, 1, 4])
        self.assertEqual(pr.base_order([]), [])

    def test_bugs_of_1_2_and_3_points_go_first_but_not_those_of_5_and_8(self):
        a = mk(1, ["point:1"], created="2026-11-01T00:00:01Z")
        b = mk(2, ["bug", "point:8"], created="2026-11-01T00:00:02Z")
        c = mk(3, ["bug", "point:5"], created="2026-11-01T00:00:03Z")
        d = mk(4, ["bug", "point:3"], created="2026-11-01T00:00:04Z")
        e = mk(5, ["bug", "point:2"], created="2026-11-01T00:00:05Z")
        f = mk(6, ["bug", "point:1"], created="2026-11-01T00:00:06Z")
        self.assertEqual(numbers(pr.base_order([a, b, c, d, e, f])), [6, 5, 4, 1, 3, 2])

    def test_urgent_issues_go_before_quick_bugs_and_the_rest(self):
        a = mk(1, ["point:2"])
        b = mk(2, ["bug", "point:2"])
        c = mk(3, ["urgency:high", "point:5"])
        d = mk(4, ["urgency:high", "bug", "point:2"])
        e = mk(5, ["urgency:high", "point:1"])
        self.assertEqual(numbers(pr.base_order([a, b, c, d, e])), [5, 4, 3, 2, 1])

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
        order = numbers(pr.base_order([z, y, x, b2, b1]))
        self.assertEqual(order, [1, 2, 4, 3, 5])
        problems = pr.validate_plan(
            {"order": order, "blocked_by": {"2": [1], "4": [2], "5": [1, 3]}},
            [z, y, x, b2, b1],
            [],
            {n: "open" for n in range(1, 6)},
        )
        self.assertEqual(problems, [])

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

    def test_urgency_importance_and_points_in_the_snapshot(self):
        j = pr.issue_json(mk(1, ["urgency:high", "importance:low", "point:2"], milestone="Orca files"))
        self.assertEqual((j["urgency"], j["importance"], j["points"], j["milestone"]), ("high", "low", 2, "Orca files"))
        j = pr.issue_json(mk(2, ["importance:high"]))
        self.assertEqual((j["urgency"], j["importance"], j["points"]), ("normal", "high", None))


class Validation(unittest.TestCase):
    def setUp(self):
        self.free = [mk(32), mk(50), mk(42, ["point:8"]), mk(33)]
        self.fixed = [mk(7)]
        self.states = {7: "open", 32: "open", 50: "open", 42: "open", 33: "open", 9: "closed"}

    def check(self, plan):
        return pr.validate_plan(plan, self.free, self.fixed, self.states)

    def test_valid(self):
        plan = {"order": [42, 32, 50, 33], "blocked_by": {"33": [42, 7, 9]}, "reasons": {}}
        self.assertEqual(self.check(plan), [])

    def test_keys_of_an_older_plan_are_ignored(self):
        plan = {"order": [42, 32, 50, 33], "groups": [[32, 50]], "touches": {"32": ["ts/a.ts"]}}
        self.assertEqual(self.check(plan), [])

    def test_order_must_hold_each_free_issue_once(self):
        problems = self.check({"order": [42, 32, 32, 7, 99], "blocked_by": {}})
        text = "\n".join(problems)
        for needle in ("#50", "#33", "twice", "#7", "#99"):
            self.assertIn(needle, text)

    def test_blocker_must_come_first(self):
        problems = self.check({"order": [32, 50, 42, 33], "blocked_by": {"42": [33]}})
        self.assertTrue(any("#33 blocks #42" in p for p in problems))

    def test_quick_bug_must_come_before_other_issues(self):
        free = [mk(1), mk(2, ["bug", "point:2"]), mk(3)]
        states = {1: "open", 2: "open", 3: "open"}
        problems = pr.validate_plan({"order": [1, 2, 3]}, free, [], states)
        self.assertEqual(problems, ["order: #2 is a bug of 1, 2 or 3 points but is placed after #1"])
        self.assertEqual(pr.validate_plan({"order": [2, 1, 3]}, free, [], states), [])

    def test_bugs_of_1_2_and_3_points_must_come_first_but_not_those_of_5_and_8(self):
        free = [mk(1), mk(2, ["bug", "point:5"]), mk(3, ["bug", "point:8"])]
        states = {1: "open", 2: "open", 3: "open"}
        self.assertEqual(pr.validate_plan({"order": [1, 2, 3]}, free, [], states), [])

    def test_quick_bug_may_follow_what_blocks_it(self):
        free = [mk(1), mk(2, ["bug", "point:2"], blocked=[1])]
        states = {1: "open", 2: "open"}
        plan = {"order": [1, 2], "blocked_by": {"2": [1]}}
        self.assertEqual(pr.validate_plan(plan, free, [], states), [])

    def test_urgent_issue_must_come_before_other_issues_but_after_its_blockers(self):
        free = [mk(1), mk(2, ["urgency:high"], blocked=[1]), mk(3)]
        states = {1: "open", 2: "open", 3: "open"}
        self.assertEqual(pr.validate_plan({"order": [1, 2, 3], "blocked_by": {"2": [1]}}, free, [], states), [])
        problems = pr.validate_plan({"order": [3, 1, 2], "blocked_by": {"2": [1]}}, free, [], states)
        self.assertTrue(any("#2 has urgency:high but is placed after #3" in p for p in problems))

    def test_quick_bug_may_follow_urgent_issues_only(self):
        free = [mk(1, ["urgency:high"]), mk(2, ["bug", "point:2"]), mk(3)]
        states = {1: "open", 2: "open", 3: "open"}
        self.assertEqual(pr.validate_plan({"order": [1, 2, 3]}, free, [], states), [])

    def test_cycle(self):
        problems = self.check({"order": [32, 50, 42, 33], "blocked_by": {"32": [50], "50": [32]}})
        self.assertTrue(any("cycle" in p for p in problems))

    def test_unknown_blocker_and_fixed_blocked(self):
        problems = self.check({"order": [32, 50, 42, 33], "blocked_by": {"32": [777], "7": [32]}})
        text = "\n".join(problems)
        self.assertIn("#777", text)
        self.assertIn("#7 is not an issue to plan", text)

    def test_malformed(self):
        for plan in ([], {"order": "x"}, {"order": [1], "blocked_by": []}, {"order": [1], "blocked_by": {"1": 2}}):
            self.assertEqual(len(self.check(plan)), 1, plan)


class Relations(unittest.TestCase):
    def test_diff_adds_and_removes_for_free_issues_only(self):
        add, remove = pr.diff_relations([1, 2], {1: [5], 3: [6]}, {1: [7], 2: [5]})
        self.assertEqual(add, [(1, 7), (2, 5)])
        self.assertEqual(remove, [(1, 5)])

    def test_no_change(self):
        self.assertEqual(pr.diff_relations([1], {1: [2]}, {1: [2]}), ([], []))


class Report(unittest.TestCase):
    def test_lines(self):
        issues = {1: mk(1, milestone="Orca files"), 2: mk(2)}
        lines = pr.result_lines([2, 1], issues, {"1": "same area as #2"})
        self.assertEqual(lines, ["1. #2 issue 2", "2. #1 issue 1 [Orca files] - same area as #2"])


def waiting(n, labels=(), closed="2026-11-06T10:00:00Z"):
    return mk(n, labels, state="closed", closed=closed)


class Next(unittest.TestCase):
    def test_the_queue_follows_the_saved_plan_and_the_issues_the_plan_lacks_come_last(self):
        issues = [
            mk(1, ["point:3"], created="2026-11-01T00:00:01Z"),
            mk(2, ["point:3"], created="2026-11-01T00:00:02Z"),
            mk(3, ["point:3"], created="2026-11-01T00:00:03Z"),
            mk(4, ["point:2", "bug"], created="2026-11-01T00:00:04Z"),
            mk(5, ["point:1"], created="2026-11-01T00:00:05Z"),
        ]
        plan = {"order": [3, 1, 2]}
        out = pr.build_next(issues, set(), frozenset(), plan)
        self.assertEqual([i["number"] for i in out["start"]], [3, 1, 2, 4, 5])
        self.assertEqual(out["start"][0]["points"], 3)
        self.assertIsNone(out["stop"])
        out = pr.build_next(issues, set(), frozenset(), None)
        self.assertEqual([i["number"] for i in out["start"]], [4, 5, 1, 2, 3])

    def test_needs_owner_blocked_and_held_issues_are_reported_not_started(self):
        issues = [
            mk(1, ["point:2"]),
            mk(2, ["point:2", "needs:owner"]),
            mk(3, ["point:2"], blocked=[1]),
            mk(4, ["point:2"]),
        ]
        out = pr.build_next(issues, {4}, frozenset(), None)
        self.assertEqual([i["number"] for i in out["start"]], [1])
        self.assertEqual([i["number"] for i in out["needs_owner"]], [2])
        self.assertEqual(out["blocked"], [{"number": 3, "title": "issue 3", "blocked_by": [1]}])
        self.assertEqual([(i["number"], i["reason"]) for i in out["held"]], [(4, "pull request open")])

    def test_an_issue_the_hand_over_lists_is_in_progress_and_is_not_held(self):
        issues = [mk(1, ["point:2"]), mk(2, ["point:2"])]
        out = pr.build_next(issues, {1}, frozenset({1}), None)
        self.assertEqual([i["number"] for i in out["in_progress"]], [1])
        self.assertEqual(out["held"], [])
        self.assertEqual([i["number"] for i in out["start"]], [2])

    def test_a_point_8_issue_does_not_start_while_a_change_waits(self):
        issues = [mk(1, ["point:8"]), mk(2, ["point:2"]), waiting(3, ["point:2"])]
        out = pr.build_next(issues, set(), frozenset(), None)
        self.assertEqual([i["number"] for i in out["start"]], [2])
        self.assertEqual(out["waits_for_release"], [1])
        self.assertEqual([w["number"] for w in out["waiting"]], [3])

    def test_a_point_8_issue_starts_when_nothing_waits(self):
        issues = [mk(1, ["point:8"]), mk(2, ["point:2"]), waiting(3, ["documentation"])]
        out = pr.build_next(issues, set(), frozenset(), None)
        self.assertEqual([i["number"] for i in out["start"]], [2, 1])
        self.assertEqual(out["waits_for_release"], [])
        self.assertEqual(out["waiting"], [])

    def test_nothing_new_starts_while_a_point_8_change_waits_for_the_owner(self):
        issues = [mk(1, ["point:2"]), waiting(2, ["point:8"])]
        out = pr.build_next(issues, set(), frozenset(), None)
        self.assertEqual(out["start"], [])
        self.assertIn("point:8", out["stop"])

    def test_nothing_open(self):
        out = pr.build_next([], set(), frozenset(), None)
        self.assertEqual((out["start"], out["in_progress"], out["stop"]), ([], [], None))

    def test_a_broken_plan_is_taken_as_no_plan(self):
        issues = [mk(1, ["point:3"]), mk(2, ["point:1"])]
        out = pr.build_next(issues, set(), frozenset(), {"order": "x"})
        self.assertEqual([i["number"] for i in out["start"]], [2, 1])


class Unsplit(unittest.TestCase):
    def test_a_big_issue_with_no_milestone_and_no_needs_owner_is_unsplit(self):
        issues = [
            mk(1, ["point:5"]),
            mk(2, ["point:8", "bug"]),
            mk(3, ["point:3"]),
            mk(4, ["point:5", "needs:owner"]),
            mk(5, ["point:8"], milestone="Orca files", ms_number=7),
            mk(6, ["point:5"], state="closed"),
        ]
        self.assertEqual(numbers(pr.unsplit(issues)), [1, 2])

    def test_nothing_is_unsplit_once_every_big_issue_is_split_or_waits_for_the_owner(self):
        self.assertEqual(pr.unsplit([mk(1, ["point:2"]), mk(2, ["point:5", "needs:owner"])]), [])


class Prune(unittest.TestCase):
    def test_closed_and_fixed_issues_leave_every_part_of_the_plan(self):
        plan = {
            "order": [1, 2, 3, 4],
            "blocked_by": {"2": [1], "3": [2]},
            "reasons": {"1": "a", "2": "b", "3": "c"},
        }
        pruned, dropped = pr.prune_plan(plan, {1: "closed", 3: "open"}, {2})
        self.assertEqual(pruned["order"], [3, 4])
        self.assertEqual(pruned["blocked_by"], {"3": [2]})  # a blocker that is fixed stays: only the keys of dropped issues go
        self.assertEqual(pruned["reasons"], {"3": "c"})
        self.assertEqual(dropped, [(1, "closed"), (2, "fixed")])

    def test_a_number_nobody_knows_stays_for_the_validation_to_refuse(self):
        pruned, dropped = pr.prune_plan({"order": [1, 99]}, {1: "open"}, set())
        self.assertEqual(pruned["order"], [1, 99])
        self.assertEqual(dropped, [])

    def test_fixed_wins_over_closed_and_each_number_is_reported_once(self):
        plan = {"order": [1, 2], "blocked_by": {"1": [2]}, "reasons": {"1": "x"}}
        _, dropped = pr.prune_plan(plan, {1: "closed", 2: "closed"}, {1})
        self.assertEqual(dropped, [(1, "fixed"), (2, "closed")])

    def test_a_plan_of_the_wrong_shape_is_returned_as_it_is(self):
        self.assertEqual(pr.prune_plan({"order": "x"}, {}, set()), ({"order": "x"}, []))

    def test_a_pruned_plan_passes_the_validation_that_the_full_one_fails(self):
        free = [mk(2), mk(3)]
        states = {2: "open", 3: "open", 1: "closed"}
        plan = {"order": [1, 2, 3], "blocked_by": {"3": [1]}}
        self.assertTrue(pr.validate_plan(plan, free, [], states))
        pruned, _ = pr.prune_plan(plan, states, set())
        self.assertEqual(pr.validate_plan(pruned, free, [], states), [])

    def test_mentioned(self):
        plan = {"order": [3, 1], "blocked_by": {"2": [9]}, "reasons": {"1": "a", "4": "b"}}
        self.assertEqual(pr.mentioned(plan), [3, 1, 2, 4])
        self.assertEqual(pr.mentioned({"order": "x"}), [])


class ReleaseFacts(unittest.TestCase):
    def facts(self, issues, release_pr=None, last_tag="v0.55.2"):
        return pr.release_facts(issues, release_pr, last_tag)

    def test_nothing_waits(self):
        out = self.facts([mk(1, ["point:2"])])
        self.assertEqual(out["changes"], [])
        self.assertEqual((out["urgent"], out["solo"], out["minor"], out["version"], out["release_pr"]), (False, False, False, None, None))

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

    def test_solo(self):
        self.assertTrue(self.facts([waiting(1, ["point:8"])])["solo"])
        self.assertFalse(self.facts([waiting(1, ["point:5"])])["solo"])


class CargoVersion(unittest.TestCase):
    def test_the_version_of_the_package_table(self):
        text = '[package]\nname = "cookapps"\nversion = "0.55.2"\n\n[dependencies]\nserde = { version = "1" }\nfoo = "1"\n[dev]\nversion = "9.9.9"\n'
        self.assertEqual(pr.cargo_version(text), "0.55.2")
        self.assertIsNone(pr.cargo_version('[dependencies]\nversion = "1.0.0"\n'))
        self.assertIsNone(pr.cargo_version(""))


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


class DoneMilestones(unittest.TestCase):
    def ms(self, number, title, open_issues, closed_issues):
        return {"number": number, "title": title, "open_issues": open_issues, "closed_issues": closed_issues}

    def test_a_milestone_is_done_when_its_issues_are_closed_and_released(self):
        milestones = [self.ms(1, "A", 0, 3), self.ms(2, "B", 1, 2), self.ms(3, "C", 0, 0), self.ms(4, "D", 0, 2)]
        issues = [mk(10, state="closed", closed="2026-11-06T10:00:00Z", milestone="D")]
        self.assertEqual([m["title"] for m in pr.done_milestones(milestones, issues)], ["A"])

    def test_a_closed_issue_that_is_not_released_does_not_count_as_waiting_when_not_planned(self):
        milestones = [self.ms(4, "D", 0, 2)]
        issues = [mk(10, state="closed", closed="2026-11-06T10:00:00Z", milestone="D", reason="not_planned")]
        self.assertEqual([m["title"] for m in pr.done_milestones(milestones, issues)], ["D"])


class SavedPlan(unittest.TestCase):
    def test_the_plan_lives_in_the_main_checkout(self):
        self.assertEqual(pr.plan_file("/w/cookapps/.git"), "/w/cookapps/.claude/plan.json")
        self.assertEqual(pr.plan_file("/w/cookapps/.git/"), "/w/cookapps/.claude/plan.json")

    def test_save_and_read(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "plan.json")
            self.assertIsNone(pr.read_plan(path))
            plan = {"order": [1, 2], "blocked_by": {}}
            pr.save_plan(path, plan)
            self.assertEqual(pr.read_plan(path), plan)
            self.assertEqual(os.listdir(d), ["plan.json"])
            pr.save_plan(path, {"order": [3]})
            self.assertEqual(pr.read_plan(path), {"order": [3]})

    def test_a_broken_plan_is_ignored_with_one_line(self):
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


class Refuse(unittest.TestCase):
    def test_open_issue_without_points_label(self):
        bad = pr.missing_points([mk(1, ["point:2"]), mk(2, ["bug"]), mk(3, state="closed")])
        self.assertEqual(numbers(bad), [2])


class Stream(unittest.TestCase):
    def test_paginated_output_is_flattened(self):
        self.assertEqual(pr.parse_stream('[{"a":1}][{"a":2}]\n[]'), [{"a": 1}, {"a": 2}])
        self.assertEqual(pr.parse_stream('{"a":1}'), [{"a": 1}])
        self.assertEqual(pr.parse_stream(""), [])


_common = subprocess.run(
    ["git", "-C", here, "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True, check=True
).stdout.strip()
HOOK = os.path.join(os.path.dirname(_common), ".claude", "hooks", "post-gh.sh")
TOOLS = here


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


class NightlyLimit(unittest.TestCase):
    """nightly-limit.sh with the points and the clock given by the environment."""

    POINTS = "1 1\n2 2\n3 3\n5 5\n8 8\n9 3\n10 3\n"

    def run_limit(self, *args, deadline=2000, now=1000):
        env = {k: v for k, v in os.environ.items() if not k.startswith("NIGHTLY_")}
        env["NIGHTLY_POINTS_LIST"] = self.POINTS
        if deadline is not None:
            env["NIGHTLY_DEADLINE_EPOCH"] = str(deadline)
            env["NIGHTLY_NOW_EPOCH"] = str(now)
        r = subprocess.run(["sh", os.path.join(TOOLS, "nightly-limit.sh"), *args], capture_output=True, text=True, env=env)
        return r.returncode, r.stdout + r.stderr

    def test_the_first_issue_may_start(self):
        self.assertEqual(self.run_limit("issue", "5")[0], 0)

    def test_issues_fit_up_to_ten_points(self):
        self.assertEqual(self.run_limit("issue", "9", "--taken", "5,2")[0], 0)  # 5 + 2 + 3 = 10
        code, text = self.run_limit("issue", "3", "--taken", "5,9")  # 5 + 3 + 3 = 11
        self.assertEqual(code, 3, text)
        self.assertIn("10", text)

    def test_a_smaller_issue_still_fits_where_a_bigger_one_did_not(self):
        self.assertEqual(self.run_limit("issue", "3", "--taken", "5,9")[0], 3)
        self.assertEqual(self.run_limit("issue", "2", "--taken", "5,9")[0], 0)  # 5 + 3 + 2 = 10

    def test_after_the_deadline_nothing_starts(self):
        code, text = self.run_limit("issue", "1", deadline=1000, now=1000)
        self.assertEqual(code, 1, text)
        self.assertEqual(self.run_limit("judgment", deadline=1000, now=1500)[0], 1)
        self.assertEqual(self.run_limit("proposal", deadline=2000, now=1500)[0], 0)

    def test_a_point_8_issue_starts_only_as_the_first_issue_and_nothing_follows_it(self):
        self.assertEqual(self.run_limit("issue", "8")[0], 0)
        self.assertEqual(self.run_limit("issue", "8", "--taken", "1")[0], 3)
        code, text = self.run_limit("issue", "1", "--taken", "8")
        self.assertEqual(code, 3, text)
        self.assertIn("#8", text)

    def test_a_session_has_no_time_or_points_limit_but_the_point_8_rule_stands(self):
        self.assertEqual(self.run_limit("issue", "3", "--taken", "5,9,10", deadline=None)[0], 0)
        self.assertEqual(self.run_limit("issue", "8", "--taken", "1", deadline=None)[0], 3)

    def test_an_issue_without_a_point_label_is_refused(self):
        self.assertEqual(self.run_limit("issue", "77")[0], 2)
        self.assertEqual(self.run_limit("issue", "1", "--taken", "77")[0], 2)

    def test_wrong_usage(self):
        for args in (["issue"], ["issue", "x"], ["issue", "1", "--taken"], ["issue", "1", "5"], ["release", "v0.1.0"], ["judgment", "1"], []):
            self.assertEqual(self.run_limit(*args)[0], 2, args)


class UseWorktree(unittest.TestCase):
    """use-worktree.sh in a throwaway repository with a bare origin."""

    def git(self, cwd, *args):
        return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, check=True).stdout.strip()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.origin = os.path.join(t, "origin.git")
        self.main = os.path.join(t, "main")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", self.origin], check=True)
        subprocess.run(["git", "clone", "-q", self.origin, self.main], check=True, capture_output=True)
        for k, v in (("user.email", "t@example.com"), ("user.name", "t")):
            self.git(self.main, "config", k, v)
        os.makedirs(os.path.join(self.main, ".claude", "tools"))
        for name in ("use-worktree.sh",):
            with open(os.path.join(TOOLS, name), encoding="utf-8") as f, open(os.path.join(self.main, ".claude", "tools", name), "w") as g:
                g.write(f.read())
        with open(os.path.join(self.main, ".worktreeinclude"), "w") as f:
            f.write("# private\nsecret.txt\n")
        with open(os.path.join(self.main, "secret.txt"), "w") as f:
            f.write("one\n")
        with open(os.path.join(self.main, ".gitignore"), "w") as f:
            f.write("secret.txt\n")
        self.git(self.main, "add", ".gitignore")
        self.commit(self.main, "a.txt", "a\n", "first")
        self.git(self.main, "push", "-q", "origin", "main")
        self.work = os.path.join(self.main, ".claude", "worktrees", "work")

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, cwd, name, text, message):
        with open(os.path.join(cwd, name), "w") as f:
            f.write(text)
        self.git(cwd, "add", name)
        self.git(cwd, "commit", "-q", "-m", message)

    def use(self, arg):
        script = os.path.join(self.main, ".claude", "tools", "use-worktree.sh")
        r = subprocess.run(["bash", script, arg], capture_output=True, text=True, cwd=self.main)
        return r.returncode, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "", r.stderr

    def merge_to_main(self, branch):
        self.git(self.work, "push", "-q", "origin", f"{branch}:main")

    def test_the_first_use_makes_the_worktree_on_the_branch_with_the_private_files(self):
        code, path, err = self.use("feat/one")
        self.assertEqual((code, path), (0, os.path.realpath(self.work)), err)
        self.assertEqual(self.git(self.work, "branch", "--show-current"), "feat/one")
        with open(os.path.join(self.work, "secret.txt")) as f:
            self.assertEqual(f.read(), "one\n")

    def test_the_same_branch_is_a_continuation_and_another_branch_finds_it_in_use(self):
        self.use("feat/one")
        self.commit(self.work, "b.txt", "b\n", "work")
        self.assertEqual(self.use("feat/one")[0], 0)
        code, _, err = self.use("feat/two")
        self.assertEqual(code, 3)
        self.assertIn("push していないコミット", err)
        self.assertEqual(self.git(self.work, "branch", "--show-current"), "feat/one")

    def test_uncommitted_changes_mean_in_use(self):
        self.use("feat/one")
        with open(os.path.join(self.work, "a.txt"), "w") as f:
            f.write("changed\n")
        code, _, err = self.use("feat/two")
        self.assertEqual(code, 3)
        self.assertIn("未コミット", err)

    def test_after_the_merge_the_worktree_is_reused_from_the_new_origin_main(self):
        self.use("feat/one")
        self.commit(self.work, "b.txt", "b\n", "work")
        self.merge_to_main("feat/one")
        code, path, err = self.use("feat/two")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.git(self.work, "branch", "--show-current"), "feat/two")
        self.assertTrue(os.path.exists(os.path.join(self.work, "b.txt")))
        branches = self.git(self.main, "branch", "--format=%(refname:short)").split()
        self.assertNotIn("feat/one", branches)

    def test_the_private_files_are_copied_again_at_each_use(self):
        self.use("feat/one")
        with open(os.path.join(self.main, "secret.txt"), "w") as f:
            f.write("two\n")
        self.use("feat/one")
        with open(os.path.join(self.work, "secret.txt")) as f:
            self.assertEqual(f.read(), "two\n")

    def test_park_returns_the_worktree_to_idle_only_when_nothing_is_lost(self):
        self.use("feat/one")
        self.commit(self.work, "b.txt", "b\n", "work")
        script = os.path.join(self.main, ".claude", "tools", "use-worktree.sh")
        r = subprocess.run(["bash", script, "--park"], capture_output=True, text=True, cwd=self.main)
        self.assertEqual(r.returncode, 3)
        self.merge_to_main("feat/one")
        r = subprocess.run(["bash", script, "--park"], capture_output=True, text=True, cwd=self.main)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.git(self.work, "branch", "--show-current"), "")
        self.assertEqual(self.use("feat/two")[0], 0)

    def test_a_pushed_branch_that_is_not_merged_does_not_keep_the_worktree(self):
        self.use("release/next")
        self.commit(self.work, "b.txt", "b\n", "release work")
        self.assertEqual(self.use("feat/two")[0], 3)
        self.git(self.work, "push", "-q", "origin", "release/next")
        code, _, err = self.use("feat/two")
        self.assertEqual(code, 0, err)
        branches = self.git(self.main, "branch", "--format=%(refname:short)").split()
        self.assertIn("release/next", branches)  # the branch of an open pull request is kept
        code, _, err = self.use("release/next")
        self.assertEqual(code, 0, err)
        self.assertTrue(os.path.exists(os.path.join(self.work, "b.txt")))

    def test_a_branch_that_exists_and_is_merged_is_moved_up_to_origin_main(self):
        self.use("release/next")
        self.git(self.work, "push", "-q", "origin", "release/next")
        script = os.path.join(self.main, ".claude", "tools", "use-worktree.sh")
        subprocess.run(["bash", script, "--park"], capture_output=True, text=True, cwd=self.main, check=True)
        self.git(self.main, "branch", "-f", "release/next", "origin/main")
        self.commit(self.main, "c.txt", "c\n", "later")
        self.git(self.main, "push", "-q", "origin", "main")
        code, _, err = self.use("release/next")
        self.assertEqual(code, 0, err)
        self.assertTrue(os.path.exists(os.path.join(self.work, "c.txt")))


if __name__ == "__main__":
    unittest.main()
