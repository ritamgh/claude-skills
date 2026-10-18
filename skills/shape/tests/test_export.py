"""plan export tests. Each docstring names the production regression it catches."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
CLI = SCRIPTS / "plan.py"

TLDR = ("Script authors who pipe the inv CLI into other tools cannot parse its aligned text columns. "
        "We add a --json flag to inv list and inv show that prints machine-readable JSON and leaves the text "
        "output untouched. It works when inv list --json | jq length returns the item count for 1,000 items "
        "in under 1 s.")
GOAL_SENTENCE = "Script authors who pipe the inv CLI into other tools cannot parse its aligned text columns."
RULES = ["Never change the text output format",
         "Non-goal: No other output formats such as CSV or YAML",
         "Non-goal: No --json on write commands (add, remove)"]
RULE_LINES = "\n".join("Rule: " + rule for rule in RULES)
TASKS = {  # id: (label, files, check, refs)
    "T-001": ("Add --json to inv list", ["inv/cli.py", "inv/render.py", "tests/test_list_json.py"],
              "make test T=list_json", ["FR-001", "SC-001"]),
    "T-002": ("Check the JSON rendering speed and fields", ["tests/test_json_perf.py"],
              "make test T=json_perf", ["FR-004", "SC-002"]),
    "T-003": ("Add --json to inv show", ["inv/cli.py", "tests/test_show_json.py"],
              "make test T=show_json", ["FR-002"]),
    "T-004": ("Report errors as JSON", ["inv/cli.py", "tests/test_json_errors.py"],
              "make test T=json_errors", ["FR-003"]),
}


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "crew"
        self.env = dict(os.environ, CREW_ROOT=str(self.root), PYTHONDONTWRITEBYTECODE="1")
        self.task = "1020-cli-json-flag"
        self.directory = self.root / self.task / "plan"
        self.directory.mkdir(parents=True)
        shutil.copyfile(HERE / "fixtures/plan-ready.json", self.directory / "plan.json")
        (self.directory / "events.jsonl").write_text("", encoding="utf-8")

    def run_cli(self, *args, code=0):
        result = subprocess.run([sys.executable, str(CLI), *args], env=self.env,
                                text=True, capture_output=True, timeout=30)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        return result

    def event(self, event, by="session", source="terminal"):
        self.run_cli("event", self.task, "--by", by, "--source", source, "--json", json.dumps(event))

    def approve(self):
        self.event({"type": "approve_prd"}, by="user", source="page")

    def export(self, target, *extra):
        return json.loads(self.run_cli("export", self.task, "--to", target, *extra).stdout)

    def prd(self):
        return str(self.directory / "PRD.md")

    def test_crew_export_of_approved_plan(self):
        """A wrong brief line, slug, ordering or field in the crew task list must fail."""
        self.approve()
        tasks = []
        for tid, (label, files, check, refs) in TASKS.items():
            brief = "\n".join([
                "Goal: " + GOAL_SENTENCE,
                "PRD: " + self.prd() + " (cite ids, never paste)",
                "Task: " + tid + " " + label,
                "Covers: " + ", ".join(refs),
                "Files: " + ", ".join(files),
                "Check: " + check,
                RULE_LINES,
            ])
            tasks.append({"id": tid, "slug": "cli-json-flag-" + tid.lower(), "title": label, "brief": brief,
                          "check": check, "files": files, "refs": refs})
        self.assertEqual(self.export("crew"), {"kind": "crew", "prd": self.prd(),
                                                "repo": "/home/user/Developer/inv", "tasks": tasks})

    def test_orchestrate_export_of_approved_plan(self):
        """Wrong wave levels, slice lookup, rules or dependency lists in the orchestrate card set must fail."""
        self.approve()
        cards = []
        for tid, (label, files, check, refs) in TASKS.items():
            cards.append({"id": tid, "concern": label, "owns": files, "check": check,
                          "depends_on": {"T-001": [], "T-002": ["T-001"], "T-003": ["T-001"], "T-004": ["T-003"]}[tid],
                          "refs": refs, "slice": {"T-001": "S1", "T-002": "S1", "T-003": "S2", "T-004": "S2"}[tid]})
        self.assertEqual(self.export("orchestrate"), {
            "kind": "orchestrate", "prd": self.prd(), "repo": "/home/user/Developer/inv", "goal": TLDR,
            "success_criteria": [
                {"id": "SC-001", "label": "inv list --json | jq length returns the item count for 1,000 items in under 1 s"},
                {"id": "SC-002", "label": "All 7 columns of the text table appear as fields in the JSON output"}],
            "review_focus": [], "rules": RULES, "cards": cards,
            "waves": [["T-001"], ["T-002", "T-003"], ["T-004"]], "chains": []})

    def test_orchestrate_markdown_is_ledger_ready(self):
        """Wrong ledger section names, numbering, table columns or the pipe escape in the Markdown form must fail."""
        self.approve()
        self.event({"type": "upsert", "node": {"id": "T-002", "check": "make test | tee out"}})
        expected = "\n".join([
            "Plan: " + self.task, "",
            "## Goal", TLDR, "",
            "Success criteria:",
            "1. SC-001 inv list --json | jq length returns the item count for 1,000 items in under 1 s",
            "2. SC-002 All 7 columns of the text table appear as fields in the JSON output", "",
            "## Review Focus", "None.", "",
            "## Tasks",
            "| id | concern | worker | owns | check | status |",
            "|---|---|---|---|---|---|",
            "| T-001 | Add --json to inv list |  | inv/cli.py, inv/render.py, tests/test_list_json.py | make test T=list_json | pending |",
            "| T-002 | Check the JSON rendering speed and fields |  | tests/test_json_perf.py | make test \\| tee out | pending |",
            "| T-003 | Add --json to inv show |  | inv/cli.py, tests/test_show_json.py | make test T=show_json | pending |",
            "| T-004 | Report errors as JSON |  | inv/cli.py, tests/test_json_errors.py | make test T=json_errors | pending |", "",
            "## Waves",
            "1. T-001",
            "2. T-002, T-003",
            "3. T-004", "",
            "## Worker rules (from the PRD)",
            "- Never change the text output format",
            "- Non-goal: No other output formats such as CSV or YAML",
            "- Non-goal: No --json on write commands (add, remove)", ""])
        out = self.run_cli("export", self.task, "--to", "orchestrate", "--markdown").stdout
        self.assertEqual(out, expected)

    def test_stage_below_ready_exits_2(self):
        """Exporting an unapproved plan (stage shape) must exit 2 with a reason and no output."""
        for target in ("crew", "orchestrate"):
            result = self.run_cli("export", self.task, "--to", target, code=2)
            self.assertEqual(result.stdout, "")
            self.assertIn("ready", result.stderr)

    def test_building_stage_exports(self):
        """Refusing the building stage (a re-export while a build runs) must fail."""
        self.approve()
        self.event({"type": "set", "field": "stage", "value": "building"})
        self.assertEqual([t["id"] for t in self.export("crew")["tasks"]], ["T-001", "T-002", "T-003", "T-004"])

    def test_unknown_plan_exits_3(self):
        """A missing plan must exit 3, like every other command."""
        self.run_cli("export", "1999-nothing", "--to", "crew", code=3)

    def test_markdown_only_for_orchestrate(self):
        """--markdown with --to crew is not defined and must be rejected, not silently ignored."""
        self.approve()
        self.run_cli("export", self.task, "--to", "crew", "--markdown", code=2)

    def test_done_tasks_are_left_out_and_unblock_dependents(self):
        """Exporting a done task, or keeping a dangling depends_on on it, or a wave for it, must fail."""
        self.approve()
        self.event({"type": "task_status", "node": "T-001", "status": "done", "ok": True, "note": "merged abc1234"})
        self.assertEqual([t["id"] for t in self.export("crew")["tasks"]], ["T-002", "T-003", "T-004"])
        orch = self.export("orchestrate")
        self.assertEqual([c["id"] for c in orch["cards"]], ["T-002", "T-003", "T-004"])
        self.assertEqual({c["id"]: c["depends_on"] for c in orch["cards"]},
                         {"T-002": [], "T-003": [], "T-004": ["T-003"]})
        self.assertEqual(orch["waves"], [["T-002", "T-003"], ["T-004"]])

    def test_same_wave_tasks_sharing_a_file_are_chained(self):
        """Missing chains, or chaining tasks of different waves (T-003/T-004 share inv/cli.py) must fail."""
        self.approve()
        self.event({"type": "upsert", "node": {"id": "T-002", "files": ["tests/test_json_perf.py", "inv/cli.py"]}})
        orch = self.export("orchestrate")
        self.assertEqual(orch["waves"], [["T-001"], ["T-002", "T-003"], ["T-004"]])
        self.assertEqual(orch["chains"], [["T-002", "T-003"]])

    def test_review_focus_lists_settled_risks_in_id_order(self):
        """Including open or killed risks, or ordering by anything but id, must fail."""
        self.approve()
        for risk in ({"id": "R-2", "kind": "risk", "label": "Huge inventories blow the 1 s budget", "status": "settled"},
                     {"id": "R-1", "kind": "risk", "label": "Unicode names break the JSON encoder", "status": "settled"},
                     {"id": "R-3", "kind": "risk", "label": "Still a draft", "status": "open"}):
            self.event({"type": "upsert", "node": risk})
        self.assertEqual(self.export("orchestrate")["review_focus"],
                         [{"id": "R-1", "label": "Unicode names break the JSON encoder"},
                          {"id": "R-2", "label": "Huge inventories blow the 1 s budget"}])

    def test_published_plan_points_prd_at_the_mirror(self):
        """Pointing prd at the working copy once a mirror is published must fail."""
        self.approve()
        mirror = Path(self.temp.name) / "repo/docs/prd/cli-json-flag"
        self.run_cli("publish", self.task, "--to", str(mirror))
        expected = str(mirror) + "/PRD.md"
        crew = self.export("crew")
        self.assertEqual(crew["prd"], expected)
        self.assertIn("PRD: " + expected + " (cite ids, never paste)", crew["tasks"][0]["brief"])
        self.assertEqual(self.export("orchestrate")["prd"], expected)

    def test_export_is_read_only(self):
        """Export must not write plan.json, events.jsonl or the cursor."""
        self.approve()
        before = [(self.directory / name).read_bytes() for name in ("plan.json", "events.jsonl", "PRD.md")]
        self.export("crew")
        self.run_cli("export", self.task, "--to", "orchestrate", "--markdown")
        after = [(self.directory / name).read_bytes() for name in ("plan.json", "events.jsonl", "PRD.md")]
        self.assertEqual(before, after)

    def test_crew_slug_fits_crews_41_character_rule_for_a_long_plan_slug(self):
        """Joining a 40-character plan slug to -t-001 gives a 46-character slug that crew rejects."""
        slug = "x" * 34 + "-yyyyy"
        task = "1020-" + slug
        directory = self.root / task / "plan"
        directory.parent.mkdir()
        self.directory.rename(directory)
        self.directory, self.task = directory, task
        plan = json.loads((directory / "plan.json").read_text(encoding="utf-8"))
        plan["id"], plan["slug"] = task, slug
        (directory / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
        self.approve()
        slugs = [t["slug"] for t in self.export("crew")["tasks"]]
        self.assertEqual(slugs, ["x" * 34 + "-t-00" + n for n in "1234"])
        self.assertTrue(all(len(s) <= 41 for s in slugs))


if __name__ == "__main__":
    unittest.main()
