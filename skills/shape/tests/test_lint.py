"""Readiness rules tested independently of implementation helpers."""
import copy
import json
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import lint
import prd


def fixture(name="plan-ready.json"):
    with (HERE / "fixtures" / name).open(encoding="utf-8") as source:
        return json.load(source)


def findings(plan, rule):
    return [f for f in lint.lint(plan) if f["rule"] == rule]


class LintTests(unittest.TestCase):
    def test_exact_seeded_blocking_findings(self):
        """Catches any missing or extra blocker, including duplicate findings."""
        expected = fixture("plan-defects.expected.json")
        actual = [{"rule": f["rule"], "node": f["node"]} for f in lint.lint(fixture("plan-defects.json"))
                  if f["severity"] == "block"]
        key = lambda f: (f["rule"], f["node"] or "")
        self.assertEqual(sorted(actual, key=key), sorted(expected, key=key))
        for finding in lint.lint(fixture("plan-defects.json")):
            self.assertEqual(set(finding), {"rule", "severity", "node", "section", "message"})
            self.assertTrue(finding["message"].strip())
            self.assertIsInstance(finding["section"], (int, type(None)))

    def test_ready_has_no_blockers_and_is_not_mutated(self):
        """Catches readiness false positives and in-place lint mutations."""
        plan = fixture()
        original = copy.deepcopy(plan)
        self.assertEqual([f for f in lint.lint(plan) if f["severity"] == "block"], [])
        self.assertEqual(plan, original)

    def test_mandatory_sections_by_size(self):
        """Catches wrong size-specific gates at the real lint boundary."""
        expected = {
            "quick": [1, 2, 4, 5, 8, 13, 15],
            "standard": [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 15, 16],
            "deep": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17],
        }
        for size, sections in expected.items():
            with self.subTest(size=size):
                plan = dict(fixture(), size=size, nodes=[], tldr="")
                actual = findings(plan, "empty-section")
                self.assertEqual([f["section"] for f in actual], sections)
                self.assertTrue(all(f["node"] is None for f in actual))
                self.assertEqual(len(findings(plan, "no-nongoals")), 1)

    def test_empty_section_matches_render_for_statuses_and_milestones(self):
        """Catches independent visibility rules drifting from the actual PRD output."""
        source = fixture("plan-standard.json")
        for kind, number, states in [
            ("story", 2, [("open", True), ("settled", False), ("parked", False), ("killed", True)]),
            ("assumption", 7, [("open", False), ("settled", False), ("killed", False), ("parked", True)]),
            ("task", 15, [("todo", False), ("doing", False), ("done", False), ("failed", False)]),
        ]:
            template = next(n for n in source["nodes"] if n["kind"] == kind)
            for status, pending in states:
                with self.subTest(kind=kind, status=status):
                    plan = dict(source, nodes=[dict(template, status=status)])
                    actual = [f["section"] for f in findings(plan, "empty-section")]
                    self.assertEqual(number in actual, pending)
                    part = prd.render(plan).split(f"## {number}. ", 1)[1].split("\n## ", 1)[0]
                    self.assertEqual("> Pending:" in part, pending)
        plan = fixture("plan-standard.json")
        for node in plan["nodes"]:
            if node["kind"] == "slice":
                node["exit"] = "" if node["status"] == "settled" else "Draft milestone"
        self.assertIn(16, [f["section"] for f in findings(plan, "empty-section")])

    def test_blocking_and_open_questions_statuses(self):
        """Catches missed parked blockers and warnings on settled/killed/parked nonblockers."""
        template = next(n for n in fixture()["nodes"] if n["kind"] == "question")
        for blocking in (False, True):
            for status in ("open", "parked", "settled", "killed"):
                with self.subTest(blocking=blocking, status=status):
                    node = dict(template, blocking=blocking, status=status)
                    plan = dict(fixture(), nodes=[node])
                    self.assertEqual(len(findings(plan, "blocking-question")), int(blocking and status in ("open", "parked")))
                    warnings = findings(plan, "open-question")
                    self.assertEqual(len(warnings), int(not blocking and status == "open"))
                    self.assertTrue(all(f["severity"] == "warn" for f in warnings))

    def test_scenario_must_be_on_a_settled_citing_slice(self):
        """Catches accepting draft slices or scenarios on an unrelated slice."""
        plan = fixture()
        target = next(n for n in plan["nodes"] if n["id"] == "FR-001")
        slices = [n for n in plan["nodes"] if n["kind"] == "slice"]
        for node in slices:
            node["scenarios"] = []
        self.assertIn(target["id"], [f["node"] for f in findings(plan, "fr-no-scenario")])
        slices[0]["scenarios"] = ["Given a list, When requested as JSON, Then it is an array"]
        slices[0]["status"] = "parked"
        self.assertIn(target["id"], [f["node"] for f in findings(plan, "fr-no-scenario")])
        slices[0]["status"] = "settled"
        self.assertNotIn(target["id"], [f["node"] for f in findings(plan, "fr-no-scenario")])
        target["nfr"] = True
        slices[0]["scenarios"] = []
        self.assertNotIn(target["id"], [f["node"] for f in findings(plan, "fr-no-scenario")])

    def test_blank_scenarios_do_not_cover_a_requirement(self):
        """Catches counting empty or whitespace-only scenario strings as a scenario."""
        plan = fixture()
        target = next(n for n in plan["nodes"] if n["id"] == "FR-001")
        cited = [n for n in plan["nodes"] if n["kind"] == "slice" and target["id"] in n["refs"]]
        self.assertTrue(cited)
        for node in plan["nodes"]:
            if node["kind"] == "slice":
                node["scenarios"] = []
        cited[0].update(status="settled", scenarios=["", "  \n\t"])
        self.assertIn(target["id"], [f["node"] for f in findings(plan, "fr-no-scenario")])
        cited[0]["scenarios"] = ["", "Given a list, When requested, Then it is an array"]
        self.assertNotIn(target["id"], [f["node"] for f in findings(plan, "fr-no-scenario")])

    def test_whitespace_tldr_is_an_empty_section(self):
        """Catches a whitespace-only tldr passing the mandatory TL;DR gate."""
        plan = fixture()
        self.assertNotIn(1, [f["section"] for f in findings(plan, "empty-section")])
        plan["tldr"] = " \n\t "
        self.assertEqual([f["section"] for f in findings(plan, "empty-section")], [1])

    def test_any_task_status_covers_settled_fr_nfr_and_sc(self):
        """Catches treating failed/todo tasks as noncoverage or overlooking NFR and SC."""
        plan = fixture()
        tasks = [n for n in plan["nodes"] if n["kind"] == "task"]
        covered = [n["id"] for n in plan["nodes"] if n["kind"] in ("requirement", "criterion")]
        for task in tasks:
            task["refs"] = []
        self.assertEqual({f["node"] for f in findings(plan, "uncovered")}, set(covered))
        for status in ("todo", "doing", "done", "failed"):
            tasks[0].update(status=status, refs=covered)
            self.assertEqual(findings(plan, "uncovered"), [])
        target = next(n for n in plan["nodes"] if n["id"] == "FR-001")
        tasks[0]["refs"] = []
        target["status"] = "open"
        self.assertNotIn("FR-001", [f["node"] for f in findings(plan, "uncovered")])

    def test_task_checks_and_settled_nongoals(self):
        """Catches skipped done tasks and accepting parked non-goals as a settled no-go."""
        plan = fixture()
        task = next(n for n in plan["nodes"] if n["kind"] == "task")
        task.update(check="", status="done")
        self.assertEqual([f["node"] for f in findings(plan, "task-no-check")], [task["id"]])
        task["check"] = " \n\t "
        self.assertEqual([f["node"] for f in findings(plan, "task-no-check")], [task["id"]])
        task["check"] = "npx jest"
        self.assertEqual(findings(plan, "task-no-check"), [])
        for node in plan["nodes"]:
            if node["kind"] == "nongoal":
                node["status"] = "parked"
        self.assertEqual(len(findings(plan, "no-nongoals")), 1)
        self.assertNotIn(5, [f["section"] for f in findings(plan, "empty-section")])

    def test_vague_whole_words_digits_and_all_target_kinds(self):
        """Catches substring matching, case sensitivity, missed body digits and NFR/SC."""
        source = fixture()
        for kind, nfr in [("requirement", False), ("requirement", True), ("criterion", False)]:
            template = next(n for n in source["nodes"] if n["kind"] == kind)
            for label, body, count in [
                ("Fast", "", 1), ("fast", "under 2 s", 0), ("Fast in 3 ms", "", 0),
                ("breakfast", "", 0), ("simplest", "", 0), ("Output", "USER-FRIENDLY", 1),
                ("slow scalable easy simple intuitive robust efficient seamless quickly", "", 1),
            ]:
                with self.subTest(kind=kind, nfr=nfr, label=label, body=body):
                    node = dict(template, label=label, body=body, status="open")
                    if kind == "requirement":
                        node["nfr"] = nfr
                    actual = findings(dict(source, nodes=[node]), "vague")
                    self.assertEqual(len(actual), count)
                    if actual:
                        self.assertEqual(actual[0]["severity"], "block")

    def test_defaults_warn_for_only_assumptions_decisions_constraints(self):
        """Catches omitted default warnings or warning for unrelated by_default kinds."""
        plan = fixture("plan-standard.json")
        expected = ["C-2", "AS-1", "AS-3", "DEC-3"]
        actual = findings(plan, "default")
        self.assertCountEqual([f["node"] for f in actual], expected)
        self.assertTrue(all(f["severity"] == "warn" for f in actual))
        next(n for n in plan["nodes"] if n["id"] == "FR-001")["by_default"] = True
        self.assertCountEqual([f["node"] for f in findings(plan, "default")], expected)


if __name__ == "__main__":
    unittest.main()
