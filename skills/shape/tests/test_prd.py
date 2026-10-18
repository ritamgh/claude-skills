"""Contract section 8 regressions against real JSON fixtures (stdlib only)."""
import copy
import json
from pathlib import Path
import random
import sys
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import prd


def fixture(name="plan-standard.json"):
    with (HERE / "fixtures" / name).open(encoding="utf-8") as source:
        return json.load(source)


def section(text, number):
    return text.split(f"## {number}. ", 1)[1].split("\n## ", 1)[0]


class PrdTests(unittest.TestCase):
    def test_standard_literal_lines_and_sections(self):
        """Catches omitted ids, reordered/renamed headings and missing task columns."""
        text = prd.render(fixture())
        self.assertEqual(text.splitlines()[0], "<!-- Generated from plan.json rev 95 by `plan render`. Do not edit: change the plan. -->")
        self.assertEqual([line for line in text.splitlines() if line.startswith("## ")], [
            "## 0. Header", "## 1. TL;DR", "## 2. Problem & evidence",
            "## 3. Users & context", "## 4. Goals & success criteria", "## 5. Non-goals",
            "## 6. Appetite & constraints", "## 7. Assumptions", "## 8. Slices",
            "## 9. Requirements", "## 10. Edge cases", "## 11. Risks & rabbit holes",
            "## 12. Technical approach", "## 13. Agent boundaries", "## 14. Open questions",
            "## 15. Task map", "## 16. Milestones", "## 17. Decision log",
            "## 18. Progress & discoveries",
        ])
        self.assertIn("- **NG-1** No CRDT or real-time co-editing", text.splitlines())
        self.assertIn("- **FR-001** Users can create and edit notes while offline", text.splitlines())
        self.assertIn("- **R-2** Large attachments (parked)", text.splitlines())
        self.assertIn("- ~~AS-4 Users want end-to-end encryption in v1~~ (killed)", text.splitlines())
        self.assertIn("[NEEDS CLARIFICATION: Q11]", section(text, 7))
        self.assertIn("| id | slice | covers | files | depends on | P | check | status |", section(text, 15).splitlines())
        self.assertIn("| **T-001** SQLite schema and migrations | S1 | FR-001 | app/db/schema.ts, app/db/migrate.ts |  |  | `npx jest app/db` | done |", text.splitlines())

    def test_standard_golden(self):
        """Catches lost field content and formatting drift beyond focused assertions."""
        golden = HERE / "fixtures" / "plan-standard.PRD.md"
        self.assertTrue(golden.exists(), "Generate and review the golden after implementing render")
        self.assertEqual(prd.render(fixture()), golden.read_text(encoding="utf-8"))

    def test_pending_intents_for_all_empty_sections(self):
        """Catches draft/killed content incorrectly satisfying Pending sections."""
        plan = fixture()
        plan.update(nodes=[], tldr="")
        text = prd.render(plan)
        intents = {
            1: "Three sentences: who, problem, outcome",
            2: "One concrete story and how we know",
            3: "Who it is for and where they work",
            4: "Goals with measurable success criteria",
            5: "What we will not do, and why",
            6: "Time budget and hard limits",
            7: "What we believe but have not checked",
            8: "Vertical slices, walking skeleton first",
            9: "What the system must do",
            10: "Expected behaviour at the edges",
            11: "What could sink it and the pre-decided way round",
            12: "Architecture and alternatives considered",
            13: "What agents always do, ask first, never do",
            15: "Tasks with a runnable check each",
            16: "An exit criterion per slice",
            17: "Decisions and why",
        }
        for number, intent in intents.items():
            with self.subTest(section=number):
                self.assertIn(f"> Pending: {intent}", section(text, number).splitlines())
                self.assertFalse(prd.section_has_content(plan, number))
        self.assertIn("None.", section(text, 14).splitlines())
        self.assertIn("Nothing yet.", section(text, 18).splitlines())
        for number in (0, 14, 18):
            self.assertTrue(prd.section_has_content(plan, number))

    def test_standard_draft_only_section_uses_exact_pending_intent(self):
        """Catches treating an open story as settled content."""
        plan = fixture()
        next(n for n in plan["nodes"] if n["id"] == "P1")["status"] = "open"
        self.assertEqual(section(prd.render(plan), 2), "Problem & evidence\n\n> Pending: One concrete story and how we know\n")

    def test_visibility_status_matrix(self):
        """Catches generic visibility leaking to the special assumption/question/task kinds."""
        source = fixture()
        cases = [
            ("story", 2, {"open": False, "settled": True, "parked": True, "killed": False}),
            ("assumption", 7, {"open": True, "settled": True, "parked": False, "killed": True}),
            ("question", 14, {"open": True, "settled": False, "parked": True, "killed": False}),
            ("task", 15, {"todo": True, "doing": True, "done": True, "failed": True}),
        ]
        for kind, number, states in cases:
            original = next(n for n in source["nodes"] if n["kind"] == kind)
            for status, visible in states.items():
                with self.subTest(kind=kind, status=status):
                    node = dict(original, status=status)
                    plan = dict(source, nodes=[node])
                    rendered = section(prd.render(plan), number)
                    self.assertEqual(node["id"] in rendered, visible)
                    if number != 14:
                        self.assertEqual(prd.section_has_content(plan, number), visible)

    def test_goal_grouping_unattached_criteria_and_ordered_sections(self):
        """Catches missing goal-less SCs and sorting by creation order instead of keys."""
        plan = fixture()
        nodes = {n["id"]: n for n in plan["nodes"]}
        nodes["S2"]["status"] = "settled"
        nodes["S2"]["exit"] = "Background sync exits"
        nodes["SC-002"]["goal"] = None
        text = prd.render(plan)
        goals = section(text, 4)
        self.assertLess(goals.index("**G-1**"), goals.index("**SC-001**"))
        self.assertIn("**SC-002**", goals)
        for number, before, after in [(6, "**C-1**", "**C-2**"), (8, "**S1**", "**S2**"),
                                      (9, "**FR-003**", "**FR-005**"), (13, "### Always", "### Ask first"),
                                      (13, "### Ask first", "### Never"), (13, "### Never", "### Commands"),
                                      (16, "**S1**", "**S2**")]:
            part = section(text, number)
            self.assertLess(part.index(before), part.index(after))
        self.assertIn("Chose: Server", section(text, 17))
        self.assertIn("(default)", section(text, 17))
        self.assertNotIn("**DEC-4**", text)
        self.assertNotIn("**FR-004**", section(text, 9))
        self.assertNotIn("**Q23**", section(text, 14))

    def test_render_is_pure_and_deterministic_for_ordered_kinds_and_dict_keys(self):
        """Catches in-place sorts, implicit dict iteration and unstable node ordering."""
        plan = fixture()
        next(n for n in plan["nodes"] if n["id"] == "S2")["status"] = "settled"
        original = copy.deepcopy(plan)
        expected = prd.render(plan)
        self.assertEqual(expected, prd.render(plan))
        self.assertEqual(plan, original)
        shuffled = copy.deepcopy(plan)
        random.Random(41).shuffle(shuffled["nodes"])
        self.assertEqual(prd.render(shuffled), expected)
        reordered = json.loads(json.dumps(plan, sort_keys=True))
        self.assertEqual(prd.render(reordered), expected)

    def test_explicit_order_keys_override_numeric_ids(self):
        """Catches dropping the primary sort key in favor of numeric ids alone."""
        plan = fixture()
        nodes = {n["id"]: n for n in plan["nodes"]}
        nodes["S1"]["order"] = 20
        nodes["S2"].update(status="settled", order=1, exit="Background sync works")
        nodes["C-1"]["tag"] = "stack"
        nodes["C-2"]["tag"] = "appetite"
        nodes["FR-001"]["nfr"] = True
        nodes["FR-005"]["nfr"] = False
        text = prd.render(plan)
        for number, before, after in [(6, "**C-2**", "**C-1**"), (8, "**S2**", "**S1**"),
                                      (9, "**FR-005**", "**FR-001**"), (16, "**S2**", "**S1**")]:
            with self.subTest(section=number):
                part = section(text, number)
                self.assertLess(part.index(before), part.index(after))
        random.Random(12).shuffle(plan["nodes"])
        self.assertEqual(prd.render(plan), text)

    def test_header_approval_drift(self):
        """Catches hiding post-approval changes and using current rather than stored metadata."""
        plan = fixture()
        plan["approved"] = {"at": "2026-10-16T10:00:00Z", "rev": 94}
        text = section(prd.render(plan), 0)
        for literal in ("Offline sync for a notes app", "user", "standard", "decide", "95", "2026-10-17T02:07:00Z",
                        "Approved at rev 94; changed since (rev 95)"):
            self.assertIn(literal, text)
        plan["approved"]["rev"] = 95
        self.assertNotIn("changed since", section(prd.render(plan), 0))

    def test_milestones_require_visible_slice_with_exit(self):
        """Catches counting a draft exit or an exit-less settled slice as milestone content."""
        plan = fixture()
        nodes = {n["id"]: n for n in plan["nodes"]}
        nodes["S1"]["exit"] = ""
        nodes["S2"]["exit"] = "Draft exit"
        self.assertFalse(prd.section_has_content(plan, 16))
        self.assertIn("> Pending: An exit criterion per slice", section(prd.render(plan), 16))

    def test_task_cells_escape_pipes_newlines_and_keep_clarifications(self):
        """Catches task data breaking the eight-column Markdown table."""
        plan = fixture()
        task = next(n for n in plan["nodes"] if n["id"] == "T-004")
        task.update(check="printf x | grep x\nprintf y", depends_on=["Q7"], parallel=True)
        table = section(prd.render(plan), 15)
        self.assertIn("`printf x \\| grep x`<br>`printf y`", table)
        self.assertIn("[NEEDS CLARIFICATION: Q7]", table)
        self.assertIn("| P |", table)

    def test_task_check_is_a_code_span_even_with_backticks(self):
        """Catches a check cell that renders as prose or lets a backtick end the span early."""
        plan = fixture()
        tasks = {n["id"]: n for n in plan["nodes"] if n["kind"] == "task"}
        tasks["T-001"]["check"] = "test \"$(echo `date`)\" = x"
        tasks["T-002"]["check"] = "`lead` and trail`"
        tasks["T-003"]["check"] = "  \n "
        rows = {line.split(" | ")[0].removeprefix("| "): line for line in section(prd.render(plan), 15).splitlines()
                if line.startswith("| **T-")}
        self.assertTrue(rows["**T-001** SQLite schema and migrations"].endswith(
            "|  | ``test \"$(echo `date`)\" = x`` | done |"), rows)
        self.assertTrue(rows["**T-002** Offline edit queue"].endswith("|  | `` `lead` and trail` `` | todo |"), rows)
        self.assertTrue(rows["**T-003** Manual sync action"].endswith("|  |  | todo |"), rows)

    def test_whitespace_tldr_renders_pending(self):
        """Catches a whitespace-only tldr counting as TL;DR content."""
        plan = fixture()
        plan["tldr"] = "  \n\t \n"
        self.assertFalse(prd.section_has_content(plan, 1))
        self.assertEqual(section(prd.render(plan), 1),
                         "TL;DR\n\n> Pending: Three sentences: who, problem, outcome\n")

    def test_tldr_lines_starting_with_hash_do_not_become_headings(self):
        """Catches tldr text forging a '## n.' section heading or a Markdown heading of its own."""
        plan = fixture()
        plan["tldr"] = "Solo users lose edits.\n## 3. Users & context\n   # Outcome\nSync under 2 s."
        text = prd.render(plan)
        self.assertEqual(len([line for line in text.splitlines() if line.startswith("## ")]), 19)
        self.assertEqual(section(text, 1),
                         "TL;DR\n\nSolo users lose edits.\n\\## 3. Users & context\n\\# Outcome\nSync under 2 s.\n")

    def test_blank_line_between_task_counts_and_discovery_list(self):
        """Catches a list glued to the 'Tasks: ...' paragraph, which Markdown renders as one paragraph."""
        text = section(prd.render(fixture()), 18)
        self.assertTrue(text.startswith(
            "Progress & discoveries\n\nTasks: todo 3, doing 0, done 1, failed 0.\n\n- **X-1**"), text)
        plan = fixture()
        plan["nodes"] = [n for n in plan["nodes"] if n["kind"] != "discovery"]
        self.assertEqual(section(prd.render(plan), 18),
                         "Progress & discoveries\n\nTasks: todo 3, doing 0, done 1, failed 0.\n")

    def test_progress_counts_and_discovery_evidence(self):
        """Catches omitting zero status buckets or discovery evidence."""
        text = section(prd.render(fixture()), 18)
        self.assertIn("Tasks: todo 3, doing 0, done 1, failed 0.", text)
        self.assertIn("**X-1** The REST API pages notes at 100 per page", text)
        self.assertIn("GET /notes returns next_page; checked against staging.", text)


if __name__ == "__main__":
    unittest.main()
