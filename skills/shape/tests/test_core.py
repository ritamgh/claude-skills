"""Contract tests. Each docstring names the production regression it catches."""
import copy
import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
CLI = SCRIPTS / "plan.py"
sys.path.insert(0, str(SCRIPTS))


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "crew"
        self.env = dict(os.environ, CREW_ROOT=str(self.root), PYTHONDONTWRITEBYTECODE="1")
        self.task = "1017-offline-sync"
        self.directory = self.root / self.task / "plan"
        self.directory.mkdir(parents=True)
        shutil.copyfile(HERE / "fixtures/plan-standard.json", self.directory / "plan.json")
        (self.directory / "events.jsonl").write_text("", encoding="utf-8")

    def cli(self, *args, code=0, stdin=None):
        result = subprocess.run([sys.executable, str(CLI), *args], env=self.env,
                                input=stdin, text=True, capture_output=True, timeout=30)
        self.assertNotIn("can't open file", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        if code == 2:
            self.assertTrue(result.stderr.strip(), "Invalid input needs a reason on stderr")
        return result.stdout

    def event(self, event, code=0, by="session", source="terminal"):
        out = self.cli("event", self.task, "--by", by, "--source", source,
                       "--json", json.dumps(event), code=code)
        return json.loads(out) if out else None

    def plan(self):
        return json.loads((self.directory / "plan.json").read_text(encoding="utf-8"))

    def node(self, node_id):
        return next(n for n in self.plan()["nodes"] if n["id"] == node_id)

    def snapshot(self):
        return [(self.directory / name).read_bytes() for name in ("plan.json", "events.jsonl")]

    def ready(self):
        shutil.copyfile(HERE / "fixtures/plan-ready.json", self.directory / "plan.json")
        self.task = "1020-cli-json-flag"
        new = self.root / self.task / "plan"
        new.parent.mkdir(parents=True)
        self.directory.rename(new)
        self.directory = new

    def test_init_seeds_sizes_and_refuses_duplicate(self):
        """Missing seed loading, wrong defaults or overwriting init must fail."""
        for size, total in (("quick", 5), ("standard", 7), ("deep", 9)):
            task = "1021-" + size
            out = self.cli("init", task, "--title", " Test plan ", "--size", size,
                           "--repo", str(Path(self.temp.name)), "--owner", "user")
            directory = self.root / task / "plan"
            self.assertEqual(out.strip(), str(directory))
            plan = json.loads((directory / "plan.json").read_text())
            self.assertEqual((plan["rev"], plan["stage"], plan["slug"]), (0, "frame", size))
            self.assertEqual(len(plan["nodes"]), total)
            self.assertEqual(plan["progress"], {"settled": 0, "total": total})
            self.assertTrue((directory / "PRD.md").read_text().startswith("<!-- Generated"))
            self.cli("init", task, "--title", "Again", code=2)
        self.assertEqual(list(self.root.rglob("*.tmp")), [])

    def test_answer_recommended_settles_fills_and_derives_frontier(self):
        """Omitting fill side effects or any frontier ranking term must fail."""
        response = self.event({"type": "answer", "node": "Q7", "choice": "recommended"},
                              by="user", source="page")
        self.assertEqual(response["rev"], 96)
        self.assertRegex(response["event"]["id"], r"^e-[a-f0-9]{12}$")
        self.assertEqual(response["event"]["choice"], "recommended")
        self.assertEqual(self.node("Q7")["answer"]["choice"], "a")
        self.assertEqual(self.node("DEC-4")["status"], "settled")
        self.assertEqual(self.node("DEC-4")["rev"], 96)
        self.assertEqual(self.plan()["frontier"], ["Q22", "Q8", "Q9", "Q11", "Q17", "Q21"])
        self.assertEqual(self.plan()["progress"], {"settled": 15, "total": 22})
        self.assertEqual(len(self.plan()["recent"]), 30)
        self.assertEqual(self.plan()["recent"][0]["rev"], 96)
        self.assertEqual(json.loads(self.cli("frontier", self.task, "-n", "2", "--json"))[0]["id"], "Q22")

    def test_park_reopen_strike_prioritize_and_label(self):
        """Wrong status transitions, answer clearing or priority increment must fail."""
        self.event({"type": "park", "node": "Q7"})
        self.assertEqual(self.node("Q7")["status"], "parked")
        self.event({"type": "reopen", "node": "Q7"})
        self.event({"type": "answer", "node": "Q7", "text": " Keep both versions "})
        self.event({"type": "reopen", "node": "Q7"})
        self.assertIsNone(self.node("Q7")["answer"])
        self.assertEqual(self.node("DEC-4")["status"], "settled")
        self.event({"type": "strike", "node": "AS-1"})
        self.assertEqual(self.node("AS-1")["status"], "killed")
        self.event({"type": "prioritize", "node": "Q8"})
        self.assertEqual(self.node("Q8")["priority"], 2)
        self.assertEqual(self.plan()["frontier"][0], "Q8")
        self.event({"type": "edit_label", "node": "S2", "label": " New label "})
        self.assertEqual(self.node("S2")["label"], "New label")

    def test_requests_resolve_and_remove_node(self):
        """Losing request fields, failing resolve or retaining a removed node must fail."""
        for event in ({"type": "note", "text": " scope note ", "lane": "scope"},
                      {"type": "ask", "text": "What now?", "node": "Q7"},
                      {"type": "expand", "node": "Q7"}):
            response = self.event(event, by="user", source="page")
            request = self.plan()["requests"][-1]
            self.assertEqual(request["ref"], response["event"]["id"])
            self.assertEqual(request["type"], event["type"])
        self.assertEqual(len(self.plan()["requests"]), 5)
        self.event({"type": "resolve", "ref": response["event"]["id"]})
        self.assertEqual(len(self.plan()["requests"]), 4)
        self.event({"type": "remove", "node": "Q7"})
        self.assertTrue(all(n["id"] != "Q7" and "Q7" not in n["depends_on"] + n["refs"]
                            for n in self.plan()["nodes"]))
        self.assertIsNone(self.plan()["requests"][0]["node"])

    def test_upsert_defaults_padding_merge_and_remove_references(self):
        """Incorrect auto IDs, metadata trust, merge or dangling ref cleanup must fail."""
        self.event({"type": "upsert", "node": {"kind": "requirement", "label": "Next FR",
                                                  "rev": 800, "by": "user"}})
        node = self.node("FR-006")
        self.assertEqual((node["body"], node["status"], node["nfr"], node["rev"], node["by"]),
                         ("", "open", False, 96, "session"))
        self.event({"type": "upsert", "node": {"id": "FR-006", "body": "More detail"}})
        self.assertEqual(self.node("FR-006")["label"], "Next FR")
        self.event({"type": "remove", "node": "FR-001"})
        self.assertNotIn("FR-001", self.node("S1")["refs"])
        self.event({"type": "remove", "node": "G-1"})
        self.assertIsNone(self.node("SC-001")["goal"])
        self.event({"type": "remove", "node": "S1"})
        self.assertIsNone(self.node("T-001")["slice"])
        self.event({"type": "remove", "node": "DEC-4"})
        self.assertEqual(self.node("Q7")["fills"], [])

    def test_invalid_events_preserve_plan_and_audit_bytes(self):
        """Any write before full validation or missing event guards must fail."""
        invalid = [
            {"type": "answer", "node": "Q7", "choice": "z"},
            {"type": "answer", "node": "Q7"},
            {"type": "answer", "node": "Q23", "text": "killed"},
            {"type": "answer", "node": "Q22", "choice": "recommended"},
            {"type": "answer", "node": "S1", "text": "wrong kind"},
            {"type": "park", "node": "T-001"},
            {"type": "reopen", "node": "Q7"},
            {"type": "strike", "node": "Q7"},
            {"type": "prioritize", "node": "Q1"},
            {"type": "edit_label", "node": "Q7", "label": " "},
            {"type": "edit_label", "node": "Q7", "label": "two\nlines"},
            {"type": "note", "text": "x" * 2001},
            {"type": "note", "text": "ok", "lane": "bad"},
            {"type": "expand", "node": "missing"},
            {"type": "set", "field": "stage", "value": "ready"},
            {"type": "set", "field": "stage", "value": "building"},
            {"type": "set", "field": "stage", "value": "shipped"},
            {"type": "set", "field": "frontier", "value": []},
            {"type": "set", "field": "repo", "value": "relative"},
            {"type": "resolve", "ref": "e-missing"},
            {"type": "task_status", "node": "Q7", "status": "done"},
            {"type": "task_status", "node": "T-001", "status": "settled"},
            {"type": "upsert", "node": {"id": "Q7", "kind": "story"}},
            {"type": "upsert", "node": {"id": "Q7", "answer": None}},
            {"type": "upsert", "node": {"id": "Q7", "unknown": 1}},
            {"type": "upsert", "node": {"id": "Q7", "depends_on": ["missing"]}},
            {"type": "upsert", "node": {"id": "Q7", "depends_on": ["S2"]}},
            {"type": "upsert", "node": {"id": "Q7", "fills": ["T-001"]}},
            {"type": "upsert", "node": {"id": "Q7", "fills": ["Q8"]}},
            {"type": "upsert", "node": {"kind": "requirement", "label": "Latency", "nfr": True}},
            {"type": "upsert", "node": {"kind": "story", "label": "x", "body": "x" * 4001}},
            {"type": "upsert", "node": {"kind": "story", "label": "x", "by_default": 1}},
            {"type": "unknown"},
        ]
        before = self.snapshot()
        for event in invalid:
            with self.subTest(event=event):
                self.event(event, code=2)
                self.assertEqual(self.snapshot(), before)
        self.event({"type": "remove", "node": "Q7"}, code=2, by="user", source="page")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(list(self.root.rglob("*.tmp")), [])

    def test_control_chars_rejected_in_labels_bodies_and_text(self):
        """Accepting ESC/BEL/DEL/C1 in a label, body or text puts raw terminal escapes into PRD.md and output."""
        invalid = [
            {"type": "edit_label", "node": "S2", "label": "red\x1b[31m"},
            {"type": "edit_label", "node": "S2", "label": "tab\there"},
            {"type": "edit_label", "node": "S2", "label": "del\x7f"},
            {"type": "edit_label", "node": "S2", "label": "csi\x9b31m"},
            {"type": "note", "text": "bell\x07"},
            {"type": "ask", "text": "esc\x1b]0;pwned\x07", "node": "Q7"},
            {"type": "expand", "node": "Q7", "text": "nel\x85"},
            {"type": "set", "field": "title", "value": "esc\x1b[2J"},
            {"type": "set", "field": "tldr", "value": "esc\x1b[2J"},
            {"type": "upsert", "node": {"kind": "story", "label": "esc\x1b[0m"}},
            {"type": "upsert", "node": {"kind": "story", "label": "ok", "body": "esc\x1b[31m"}},
            {"type": "upsert", "node": {"kind": "story", "label": "ok", "body": "c1\x85line"}},
            {"type": "upsert", "node": {"id": "S2", "body": "cr\rline"}},
        ]
        before = self.snapshot()
        for event in invalid:
            with self.subTest(event=event):
                self.event(event, code=2, by="session")
                self.assertEqual(self.snapshot(), before)
        self.event({"type": "upsert", "node": {"kind": "story", "label": "Fine", "body": "line one\n\tindented line"}})
        self.assertEqual(self.node("P2")["body"], "line one\n\tindented line")
        self.event({"type": "note", "text": "a\n\tb"}, by="user", source="page")
        self.assertEqual(self.plan()["requests"][-1]["text"], "a\n\tb")

    def test_control_and_format_chars_rejected_in_every_stored_string_field(self):
        """A control check that covers only label/body/text lets ESC and bidi overrides into PRD.md via why, check, files, evidence, chose, option why, title, owner."""
        esc, rlo = "bad\x1b[2Jtext", "evil‮text"
        invalid = [
            {"type": "upsert", "node": {"id": "Q7", "why": esc}},
            {"type": "upsert", "node": {"id": "Q7", "options": [{"key": "a", "label": "Yes", "why": esc}]}},
            {"type": "upsert", "node": {"id": "Q7", "options": [{"key": "a", "label": "Y‮es", "why": "fine"}]}},
            {"type": "upsert", "node": {"id": "T-001", "check": esc}},
            {"type": "upsert", "node": {"id": "T-001", "files": ["src/ok.py", esc]}},
            {"type": "upsert", "node": {"id": "SC-001", "evidence": esc}},
            {"type": "upsert", "node": {"id": "SC-001", "verify": "run\ncheck"}},
            {"type": "upsert", "node": {"id": "DEC-1", "why": esc}},
            {"type": "upsert", "node": {"id": "DEC-1", "chose": esc}},
            {"type": "upsert", "node": {"id": "S2", "scenarios": ["Given a\nWhen b", esc]}},
            {"type": "upsert", "node": {"id": "S2", "label": rlo}},
            {"type": "upsert", "node": {"id": "S2", "body": "zero​width"}},
            {"type": "upsert", "node": {"id": "S2", "body": "tag\U000e0041char"}},
            {"type": "set", "field": "owner", "value": esc},
            {"type": "set", "field": "repo", "value": "/tmp/re‮po"},
            {"type": "set", "field": "published", "value": "/tmp/pub\x1b"},
            {"type": "set", "field": "title", "value": rlo},
            {"type": "set", "field": "tldr", "value": "bidi‮here"},
        ]
        before = self.snapshot()
        for event in invalid:
            with self.subTest(event=event):
                self.event(event, code=2)
                self.assertEqual(self.snapshot(), before)
        self.event({"type": "upsert", "node": {"id": "DEC-1", "why": "line one\n\tline two"}})
        self.assertEqual(self.node("DEC-1")["why"], "line one\n\tline two")
        self.event({"type": "upsert", "node": {"id": "S2", "scenarios": ["Given a, When b, Then c"]}})
        self.assertEqual(self.node("S2")["scenarios"], ["Given a, When b, Then c"])

    def test_approval_and_stage_transitions(self):
        """Bypassing shape or forgetting approval rev and reset must fail."""
        self.event({"type": "approve_prd"}, code=2)
        self.ready()
        self.event({"type": "approve_prd"}, by="user", source="page")
        self.assertEqual(self.plan()["stage"], "ready")
        self.assertEqual(self.plan()["approved"]["rev"], 41)
        self.event({"type": "edit_label", "node": "S1", "label": "Updated skeleton"})
        self.assertEqual(self.plan()["approved"]["rev"], 41)
        self.event({"type": "set", "field": "stage", "value": "building"})
        self.event({"type": "set", "field": "stage", "value": "shipped"})
        self.event({"type": "set", "field": "stage", "value": "frame"})
        self.assertIsNone(self.plan()["approved"])

    def test_changed_since_approval_only_after_a_node_changes(self):
        """Flagging drift on a stage/published set or a resolve, rather than a node change, must fail."""
        self.ready()
        self.event({"type": "approve_prd"}, by="user", source="page")
        header = lambda: (self.directory / "PRD.md").read_text().split("\n## 1. ", 1)[0]
        self.assertIn("Approved at rev 41\n", header())
        request = self.event({"type": "note", "text": "later request"}, by="user", source="page")
        self.event({"type": "set", "field": "published", "value": str(Path(self.temp.name) / "mirror")})
        self.event({"type": "resolve", "ref": request["event"]["id"]})
        self.event({"type": "set", "field": "owner", "value": "someone"})
        self.assertEqual(self.plan()["rev"], 45)
        self.assertIn("- Approved at rev 41\n", header())
        self.assertNotIn("changed since", header())
        self.event({"type": "upsert", "node": {"kind": "story", "label": "Late story"}})
        self.assertIn("- Approved at rev 41; changed since (rev 46)\n", header())

    def test_build_progress_is_not_a_spec_change(self):
        """Stamping "changed since" for task_status or discovery events, i.e. build progress, must fail."""
        self.ready()
        self.event({"type": "approve_prd"}, by="user", source="page")
        header = lambda: (self.directory / "PRD.md").read_text().split("\n## 1. ", 1)[0]
        self.event({"type": "task_status", "node": "T-001", "status": "doing"}, source="build")
        self.event({"type": "task_status", "node": "T-001", "status": "done", "ok": True, "note": "passed"},
                   source="build")
        self.event({"type": "upsert", "node": {"kind": "discovery", "label": "Parser needs a flush"}},
                   source="build")
        self.assertEqual(self.plan()["rev"], 44)
        self.assertEqual(self.node("T-001")["rev"], 43)
        self.assertIn("- Approved at rev 41\n", header())
        self.assertNotIn("changed since", header())
        self.event({"type": "upsert", "node": {"id": "FR-002", "label": "Reworded requirement"}})
        self.assertIn("- Approved at rev 41; changed since (rev 45)\n", header())

    def test_approval_lint_rejection_does_not_mutate(self):
        """Ignoring blocking lint or mutating before rejection must fail."""
        self.ready()
        core = importlib.import_module("plan_core")
        plan = self.plan()
        before = copy.deepcopy(plan)
        finding = {"rule": "empty-section", "severity": "block", "node": None,
                   "section": 1, "message": "Missing summary"}
        with patch.object(core.lint, "lint", return_value=[finding]):
            with self.assertRaises(core.PlanError) as caught:
                core.apply_event(plan, {"type": "approve_prd"})
        self.assertEqual(caught.exception.code, 4)
        self.assertEqual(plan, before)
        with patch.dict(os.environ, self.env), patch.object(core.lint, "lint", return_value=[finding]):
            cli_module = importlib.import_module("plan")
            from contextlib import redirect_stdout
            from io import StringIO
            output = StringIO()
            with redirect_stdout(output):
                code = cli_module.main(["event", self.task, "--json", '{"type":"approve_prd"}'])
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(output.getvalue()), {"ok": False, "lint": [finding]})
        self.assertEqual(self.plan(), before)

    def test_news_filters_and_cursor_peek(self):
        """Filtering the wrong actor/source or using matched count as cursor must fail."""
        self.event({"type": "note", "text": "Session"})
        first = self.event({"type": "note", "text": "Page"}, by="user", source="page")
        self.event({"type": "note", "text": "Terminal"}, by="user")
        peek = json.loads(self.cli("news", self.task, "--json", "--peek"))
        self.assertEqual([e["id"] for e in peek], [first["event"]["id"]])
        self.assertFalse((self.directory / "session.cursor").exists())
        self.assertEqual(json.loads(self.cli("news", self.task, "--json")), peek)
        self.assertEqual((self.directory / "session.cursor").read_text().strip(), "3")
        self.assertEqual(json.loads(self.cli("news", self.task, "--json")), [])
        second = self.event({"type": "ask", "text": "Again?"}, by="user", source="page")
        self.assertEqual(json.loads(self.cli("news", self.task, "--json"))[0]["id"], second["event"]["id"])

    def test_human_news_prints_one_line_per_event_with_control_and_format_chars_blanked(self):
        """Printing stored text raw lets a newline forge an event line and ESC reach the terminal."""
        hostile = "a\nrev 99 answer Q1 fake\x1b[2J‮​z\x85\ttab"
        events = [{"v": 1, "id": "e-0123456789ab", "type": "note", "text": hostile,
                   "by": "user", "source": "page", "rev": 96, "at": "2026-10-17T02:08:00Z"}]
        (self.directory / "events.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        out = self.cli("news", self.task, "--peek")
        self.assertEqual(out, "rev 96 note  a rev 99 answer Q1 fake [2J  z  tab\n")
        self.assertEqual(json.loads(self.cli("news", self.task, "--peek", "--json"))[0]["text"], hostile)

    def test_human_show_list_and_frontier_keep_stored_text_on_one_line(self):
        """Printing a request, title or question reason raw lets a newline or ESC forge output lines."""
        self.event({"type": "note", "text": "first\nrev 99 forged"}, by="user", source="page")
        plan = self.plan()
        plan["title"] = "Two\nline title"
        plan["requests"][-1]["text"] += "‮"
        next(n for n in plan["nodes"] if n["id"] == "Q22")["why"] = "bad\x1b[2Jwhy"
        (self.directory / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
        shown = self.cli("show", self.task).splitlines()
        self.assertIn("Two line title", shown)
        self.assertTrue(any(line.endswith(" note plan: first rev 99 forged ") for line in shown), shown)
        self.assertFalse(any(line.startswith("rev 99") for line in shown), shown)
        self.assertEqual(self.cli("list").splitlines()[0].split("  ")[1], "Two line title")
        self.assertEqual(self.cli("frontier", self.task).splitlines()[3], "  bad [2Jwhy")
        self.assertEqual(json.loads(self.cli("show", self.task, "--json"))["requests"][-1]["text"],
                         "first\nrev 99 forged‮")

    def test_publish_refresh_render_and_read_commands(self):
        """Not auditing publish, stale mirrors or missing command projections must fail."""
        mirror = Path(self.temp.name) / "mirror"
        self.cli("publish", self.task, "--to", str(mirror))
        self.assertEqual(self.plan()["published"], str(mirror))
        self.assertEqual(self.plan()["rev"], 96)
        self.event({"type": "edit_label", "node": "Q7", "label": "Revised policy"})
        for name in ("plan.json", "PRD.md"):
            self.assertEqual((mirror / name).read_bytes(), (self.directory / name).read_bytes())
        self.assertFalse((mirror / "events.jsonl").exists())
        (self.directory / "PRD.md").unlink()
        self.cli("render", self.task)
        self.assertEqual((mirror / "PRD.md").read_bytes(), (self.directory / "PRD.md").read_bytes())
        self.assertEqual(self.cli("path", self.task).strip(), str(self.directory))
        self.assertEqual(json.loads(self.cli("show", self.task, "--json")), self.plan())
        self.assertIn("Revised policy", self.cli("show", self.task))
        listed = json.loads(self.cli("list", "--json"))
        self.assertEqual(listed[0]["id"], self.task)
        self.assertEqual(listed[0]["rev"], 97)
        self.assertIsInstance(json.loads(self.cli("lint", self.task, "--json", code=1)), list)
        self.cli("publish", self.task, "--to", "relative", code=2)
        self.assertEqual(list(Path(self.temp.name).rglob("*.tmp")), [])

    def test_unknown_top_key_rejected_by_every_loader(self):
        """Silently accepting schema drift on any command must fail."""
        plan = self.plan()
        plan["drift"] = True
        (self.directory / "plan.json").write_text(json.dumps(plan))
        for command in ("show", "frontier", "news", "render", "lint", "path"):
            self.cli(command, self.task, code=2)
        self.cli("list", "--json", code=2)
        self.event({"type": "note", "text": "Rejected"}, code=2)

    def test_hand_edited_boundary_tier_or_digitless_id_is_rejected_before_render(self):
        """Letting load accept an empty tier or a digit-free id would crash prd.render with a traceback."""
        original = self.plan()
        boundary = next(n for n in original["nodes"] if n["kind"] == "boundary")
        for change in ({"tier": ""}, {"tier": "sometimes"}, {"id": "B-x"}, {"id": "B-"}):
            with self.subTest(change=change):
                damaged = copy.deepcopy(original)
                next(n for n in damaged["nodes"] if n["id"] == boundary["id"]).update(change)
                (self.directory / "plan.json").write_text(json.dumps(damaged))
                for command in ("show", "render", "lint"):
                    self.cli(command, self.task, code=2)

    def test_missing_invalid_ids_and_stdin(self):
        """Missing plan exit codes, path traversal or ignored stdin must fail."""
        for command in ("show", "frontier", "news", "render", "lint", "path"):
            self.cli(command, "missing", code=3)
            self.cli(command, "a..b", code=2)
        self.cli("init", "../escape", "--title", "Bad", code=2)
        output = self.cli("event", self.task, "-", stdin='{"type":"note","text":" stdin "}')
        self.assertEqual(json.loads(output)["rev"], 96)
        self.assertEqual(self.plan()["requests"][-1]["text"], "stdin")
        self.cli("event", self.task, "--json", "[]", code=2)
        self.cli("event", self.task, "--json", "{", code=2)

    def test_task_status_result(self):
        """Forgetting result metadata or allowing CLI task check execution must fail."""
        self.event({"type": "task_status", "node": "T-002", "status": "done", "ok": True, "note": " Passed "})
        node = self.node("T-002")
        self.assertEqual(node["status"], "done")
        self.assertEqual(node["result"]["ok"], True)
        self.assertEqual(node["result"]["note"], "Passed")
        self.event({"type": "reopen", "node": "T-002"})
        self.assertEqual(self.node("T-002")["status"], "todo")

    def test_malformed_schema_and_non_json_numbers_are_rejected(self):
        """Unchecked unhashable schema fields or NaN JSON must not escape as tracebacks."""
        original = self.plan()
        for field, value in (("recent", [{**original["recent"][0], "type": []}]),
                             ("nodes", [{**original["nodes"][0], "kind": []}])):
            with self.subTest(field=field):
                damaged = copy.deepcopy(original)
                damaged[field] = value
                (self.directory / "plan.json").write_text(json.dumps(damaged))
                self.cli("show", self.task, code=2)
        (self.directory / "plan.json").write_text(json.dumps(original))
        self.cli("event", self.task, "--json",
                 '{"type":"upsert","node":{"kind":"story","label":"Bad JSON","rev":NaN}}', code=2)
        (self.directory / "events.jsonl").write_text("null\n")
        self.cli("news", self.task, "--json", code=2)

    def test_core_invalid_event_preserves_input_objects(self):
        """In-place partial mutation before validation must fail even outside the CLI."""
        core = importlib.import_module("plan_core")
        original = self.plan()
        for event in ({"type": "upsert", "node": {"id": "Q7", "priority": "bad"}},
                      {"type": "upsert", "node": {"id": "Q7", "depends_on": ["missing"]}},
                      {"type": "upsert", "node": {"id": "Q7", "depends_on": ["S2"]}}):
            with self.subTest(event=event):
                plan = copy.deepcopy(original)
                before = copy.deepcopy(event)
                with self.assertRaises(core.PlanError) as caught:
                    core.apply_event(plan, event)
                self.assertEqual(caught.exception.code, 2)
                self.assertEqual(plan, original)
                self.assertEqual(event, before)

    def test_storage_failure_after_append_rolls_back_audit_and_leaves_no_tmp(self):
        """Leaving the audit line ahead of plan.json after a failed projection write, or leaking tmp files, must fail."""
        core = importlib.import_module("plan_core")
        (self.directory / "events.jsonl").write_text('{"rev": 95}\n', encoding="utf-8")
        before = self.snapshot()
        with patch.dict(os.environ, self.env), patch.object(core.os, "replace", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                core.send_event(self.task, {"type": "note", "text": "durable event"})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(list(self.root.rglob("*.tmp")), [])
        self.event({"type": "note", "text": "Works again"})
        self.assertEqual(self.plan()["rev"], 96)

    def test_unwritable_publish_directory_leaves_no_audit_and_later_events_work(self):
        """Appending the audit event before the mirror destination is known writable must fail."""
        if os.geteuid() == 0:
            self.skipTest("root ignores directory permissions")
        mirror = Path(self.temp.name) / "readonly-mirror"
        mirror.mkdir(mode=0o555)
        self.addCleanup(mirror.chmod, 0o755)
        before = self.snapshot()
        self.cli("publish", self.task, "--to", str(mirror), code=2)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(list(mirror.iterdir()), [])
        self.event({"type": "note", "text": "Not blocked by the failed publish"})
        self.assertEqual(self.plan()["rev"], 96)

    def test_prd_path_that_is_a_directory_leaves_no_audit_and_later_events_work(self):
        """Appending the audit event before PRD.md is known replaceable must fail."""
        (self.directory / "PRD.md").mkdir()
        before = self.snapshot()
        self.event({"type": "note", "text": "Cannot project"}, code=2)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(list(self.root.rglob("*.tmp")), [])
        (self.directory / "PRD.md").rmdir()
        self.event({"type": "note", "text": "Projection restored"})
        self.assertEqual(self.plan()["rev"], 96)
        self.assertEqual(len((self.directory / "events.jsonl").read_text().splitlines()), 1)

    def test_atomic_replacement_order_exposes_old_or_complete_new_plan(self):
        """Replacing working plan before its PRD and mirror must fail this boundary check."""
        core = importlib.import_module("plan_core")
        mirror = Path(self.temp.name) / "projection"
        self.cli("publish", self.task, "--to", str(mirror))
        observations = []
        replace = os.replace

        def observe(source, destination):
            # Exercise real filesystem replacement, then inspect public files at this boundary.
            replace(source, destination)
            observations.append((str(destination), self.plan()["rev"],
                                 json.loads((mirror / "plan.json").read_text())["rev"],
                                 (self.directory / "PRD.md").read_text().splitlines()[0]))

        with patch.dict(os.environ, self.env), patch.object(core.os, "replace", side_effect=observe):
            core.send_event(self.task, {"type": "note", "text": "ordered write"})
        self.assertEqual([Path(row[0]).name for row in observations], ["PRD.md", "PRD.md", "plan.json", "plan.json"])
        self.assertEqual([row[1] for row in observations], [96, 96, 96, 97])
        self.assertEqual([row[2] for row in observations], [96, 96, 97, 97])
        self.assertTrue(all("rev 97 " in row[3] for row in observations))

    def test_all_kinds_allocate_ids_and_default_fields(self):
        """Missing a kind, incorrect prefixes/padding, or task status defaults must fail."""
        examples = [
            ("story", "P2", {}), ("user", "U2", {}), ("goal", "G-2", {}),
            ("criterion", "SC-003", {}), ("nongoal", "NG-3", {}),
            ("constraint", "C-3", {"tag": "stack"}), ("assumption", "AS-5", {}),
            ("slice", "S3", {}), ("requirement", "FR-006", {}), ("edge", "E-3", {}),
            ("risk", "R-4", {}), ("approach", "A-2", {}), ("boundary", "B-5", {"tier": "ask"}),
            ("question", "Q24", {"lane": "scope", "stage": "frame", "class": "user"}),
            ("task", "T-005", {}), ("decision", "DEC-6", {}), ("discovery", "X-2", {}),
            ("note", "N-2", {"lane": "why"}),
        ]
        for kind, expected, extra in examples:
            with self.subTest(kind=kind):
                self.event({"type": "upsert", "node": {"kind": kind, "label": "New node", **extra}})
                node = self.node(expected)
                self.assertEqual(node["status"], "todo" if kind == "task" else "open")
                self.assertEqual(node["body"], "")
        self.event({"type": "remove", "node": "FR-006"})
        self.event({"type": "upsert", "node": {"kind": "requirement", "label": "Reuse highest id"}})
        self.assertEqual(self.node("FR-006")["label"], "Reuse highest id")

    def test_lint_exit_code_and_uncreatable_publish(self):
        """Ignoring lint's blocking severity or auditing a failed publish must fail."""
        from contextlib import redirect_stdout
        from io import StringIO
        core = importlib.import_module("plan_core")
        cli_module = importlib.import_module("plan")
        finding = {"rule": "uncovered", "severity": "block", "node": "FR-004", "section": 9, "message": "Not covered"}
        with patch.dict(os.environ, self.env), patch.object(core.lint, "lint", return_value=[finding]):
            output = StringIO()
            with redirect_stdout(output):
                code = cli_module.main(["lint", self.task, "--json"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue()), [finding])
        destination = Path(self.temp.name) / "file-not-directory"
        destination.write_text("Keep this file")
        before = self.snapshot()
        self.cli("publish", self.task, "--to", str(destination), code=2)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(destination.read_text(), "Keep this file")

    def test_concurrent_writers_keep_all_events_and_valid_json(self):
        """Removing flock or reading before locking loses revisions and must fail."""
        worker = (
            "import subprocess,sys; "
            "[subprocess.run([sys.executable,sys.argv[1],'event',sys.argv[2],"
            "'--json','{\"type\":\"note\",\"text\":\"concurrent\"}'],"
            "check=True,stdout=subprocess.DEVNULL) for _ in range(20)]"
        )
        processes = [subprocess.Popen([sys.executable, "-c", worker, str(CLI), self.task],
                                      env=self.env, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        for process in processes:
            _, err = process.communicate(timeout=60)
            self.assertEqual(process.returncode, 0, err)
        self.assertEqual(self.plan()["rev"], 135)
        lines = (self.directory / "events.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 40)
        self.assertEqual([json.loads(line)["rev"] for line in lines], list(range(96, 136)))
        self.assertEqual(len({json.loads(line)["id"] for line in lines}), 40)
        self.assertEqual(len(self.plan()["recent"]), 30)
        self.assertEqual(list(self.root.rglob("*.tmp")), [])

    def test_twenty_simultaneous_writers_and_a_reader_never_see_partial_json(self):
        """Non-atomic plan.json writes or a missing lock must fail: lost updates, bad rev or a torn read."""
        import threading
        stop = threading.Event()
        torn, reads = [], []

        def reader():
            while not stop.is_set():
                try:
                    reads.append(json.loads((self.directory / "plan.json").read_text())["rev"])
                except ValueError as exc:
                    torn.append(str(exc))

        thread = threading.Thread(target=reader)
        thread.start()
        try:
            processes = [subprocess.Popen(
                [sys.executable, str(CLI), "event", self.task, "--by", "user", "--source", "page",
                 "--json", json.dumps({"type": "note", "text": f"parallel {i}"})],
                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in range(20)]
            outputs = [process.communicate(timeout=60) for process in processes]
        finally:
            stop.set()
            thread.join()
        self.assertEqual([process.returncode for process in processes], [0] * 20, [o[1] for o in outputs])
        self.assertEqual(sorted(json.loads(o[0])["rev"] for o in outputs), list(range(96, 116)))
        self.assertEqual(torn, [])
        self.assertTrue(reads)
        self.assertEqual(reads, sorted(reads))
        self.assertGreaterEqual(reads[0], 95)
        self.assertLessEqual(reads[-1], 115)
        self.assertEqual(self.plan()["rev"], 115)
        lines = (self.directory / "events.jsonl").read_text().splitlines()
        self.assertEqual(sorted(json.loads(line)["rev"] for line in lines), list(range(96, 116)))
        self.assertEqual(len(self.plan()["requests"]), 22)  # fixture starts with 2
        self.assertEqual(list(self.root.rglob("*.tmp")), [])

    def test_line_and_paragraph_separators_in_event_text_are_refused(self):
        """Letting U+2028/U+2029 into a stored event writes a raw separator that splitlines() cuts mid-string and bricks every later command."""
        before = self.snapshot()
        for separator in (" ", " "):
            payload = json.dumps({"type": "answer", "node": "Q1", "text": "pasted" + separator + "line"})
            self.cli("event", self.task, "--by", "user", "--source", "page", "-", stdin=payload, code=2)
        self.assertEqual(self.snapshot(), before)
        self.event({"type": "note", "text": "Still works"})

    def test_audit_line_with_raw_separators_inside_a_string_still_loads(self):
        """Splitting events.jsonl on anything but \\n makes a log written before the refusal (raw U+2028, VT, FF, NEL in a string) unreadable."""
        text = "a b c\x0bd\x0ce\x1cf\x85g"
        events = [{"v": 1, "id": "e-0123456789ab", "type": "note", "text": text, "by": "user", "source": "page",
                   "rev": 95, "at": "2026-10-17T02:08:00Z"},
                  {"v": 1, "id": "e-ba9876543210", "type": "note", "text": "second", "by": "user", "source": "page",
                   "rev": 95, "at": "2026-10-17T02:09:00Z"}]
        (self.directory / "events.jsonl").write_text(
            "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events), encoding="utf-8")
        news = json.loads(self.cli("news", self.task, "--json"))
        self.assertEqual([event["text"] for event in news], [text, "second"])
        self.assertEqual((self.directory / "session.cursor").read_text().strip(), "2")
        self.event({"type": "note", "text": "Appended"})
        self.assertEqual([event["text"] for event in json.loads(self.cli("news", self.task, "--json"))], [])

    def test_failed_projection_leaves_prd_and_mirror_as_they_were(self):
        """Replacing PRD.md copies before a later temp write fails leaves the rejected event's text published."""
        mirror = Path(self.temp.name) / "mirror"
        self.cli("publish", self.task, "--to", str(mirror))
        (mirror / "plan.json.tmp").mkdir()
        names = [self.directory / "PRD.md", mirror / "PRD.md", mirror / "plan.json", self.directory / "plan.json"]
        before = [path.read_bytes() for path in names] + self.snapshot()
        self.event({"type": "set", "field": "tldr", "value": "ROLLEDBACK"}, code=2)
        self.assertEqual([path.read_bytes() for path in names] + self.snapshot(), before)
        self.assertNotIn(b"ROLLEDBACK", b"".join(before))
        self.assertEqual(self.plan()["rev"], 96)


if __name__ == "__main__":
    unittest.main()
