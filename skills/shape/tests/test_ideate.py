"""Ideate and Research tests (contract section 12). Each docstring names the production regression it catches.

The plan comes from fixtures/plan-ideate.json: stage ideate, ideas I1 (boost 2), I2 (boost 1), I3 (killed), I4 (merge
draft of I1 + I2), rubrics K1 (weight 30), K2 (25), K3 (lens), K4 (gate), research RS1 (running) and a pending
merge and twist request.
"""
import copy
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
sys.path.insert(0, str(SCRIPTS))

import lint  # noqa: E402
import plan_core as core  # noqa: E402
import prd  # noqa: E402

FIXTURE = HERE / "fixtures/plan-ideate.json"
TASK = "1017-notes-offline-mode"


def fixture_plan():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class BoardTests(unittest.TestCase):
    def setUp(self):
        self.plan = fixture_plan()

    def apply(self, event, by="session", source="terminal"):
        return core.apply_event(self.plan, dict(event, by=by, source=source))

    def node(self, node_id):
        return next(n for n in self.plan["nodes"] if n["id"] == node_id)

    def rejected(self, event, by="session"):
        before = copy.deepcopy(self.plan)
        with self.assertRaises(core.PlanError) as caught:
            self.apply(event, by=by)
        self.assertEqual(caught.exception.code, 2)
        self.assertEqual(self.plan, before)

    def user(self, event):
        return self.apply(event, by="user", source="page")

    def test_fixture_is_valid_and_has_the_shape_the_board_card_needs(self):
        """A fixture that fails validate() or lacks a kill, a merge draft, a gate or a research node would break the HQ board card."""
        core.validate(self.plan, strict=True)
        kinds = [(n["id"], n["status"]) for n in self.plan["nodes"] if n["kind"] in ("idea", "rubric", "research")]
        self.assertEqual(kinds, [("K1", "settled"), ("K2", "settled"), ("K3", "settled"), ("K4", "settled"),
                                 ("I1", "open"), ("I2", "open"), ("I3", "killed"), ("I4", "open"), ("RS1", "open")])
        self.assertEqual(self.node("I3")["kill_reason"], "Needs a server change and months of work")
        self.assertEqual(self.node("I4")["merged_from"], ["I1", "I2"])
        self.assertEqual([self.node(k)["group"] for k in ("K1", "K2", "K3", "K4")], ["weighted", "weighted", "lens", "gate"])

    def test_every_invalid_board_event_exits_2_and_changes_nothing(self):
        """A missing guard in boost/kill/restore/merge/twist/promote/weight/research/score/research_status lets a bad board event through."""
        cases = [
            {"type": "boost", "node": "I3", "value": 1},  # killed idea
            {"type": "boost", "node": "I4", "value": 4},  # above 3
            {"type": "boost", "node": "I4", "value": -1},
            {"type": "boost", "node": "I4", "value": "2"},
            {"type": "boost", "node": "I4", "value": True},
            {"type": "boost", "node": "I4"},
            {"type": "boost", "node": "K1", "value": 1},  # not an idea
            {"type": "kill", "node": "I3", "text": "again"},  # killed already
            {"type": "kill", "node": "I1"},  # no reason
            {"type": "kill", "node": "I1", "text": "  "},
            {"type": "kill", "node": "K1", "text": "no"},
            {"type": "restore", "node": "I1"},  # not killed
            {"type": "restore", "node": "K1"},
            {"type": "merge", "node": "I1", "other": "I1"},
            {"type": "merge", "node": "I1", "other": "I3"},  # other killed
            {"type": "merge", "node": "I3", "other": "I1"},  # node killed
            {"type": "merge", "node": "I1", "other": "K1"},  # other not an idea
            {"type": "merge", "node": "K1", "other": "I1"},
            {"type": "merge", "node": "I1", "other": "I99"},
            {"type": "merge", "node": "I1"},
            {"type": "merge", "node": "I1", "other": ["I2"]},
            {"type": "twist", "node": "K1"},
            {"type": "promote", "node": "I3"},  # killed
            {"type": "promote", "node": "K1"},
            {"type": "weight", "node": "K4", "value": 10},  # gate
            {"type": "weight", "node": "I1", "value": 10},
            {"type": "weight", "node": "K1", "value": 51},
            {"type": "weight", "node": "K1", "value": -1},
            {"type": "weight", "node": "K1", "value": 2.5},
            {"type": "research", "node": "K1"},  # neither idea nor question
            {"type": "research", "node": "RS1"},
            {"type": "research", "node": "I1", "text": "  "},
        ]
        for event in cases:
            with self.subTest(event=event):
                self.rejected(event, by="user")

    def test_weights_reset_needs_a_rubric(self):
        """weights_reset on a plan with no rubric must be refused rather than recorded as a no-op."""
        self.plan["nodes"] = [n for n in self.plan["nodes"] if n["kind"] != "rubric"]
        for node in self.plan["nodes"]:
            if node["kind"] == "idea":
                node["scores"], node["gates"] = {}, {}
        self.rejected({"type": "weights_reset"}, by="user")

    def test_every_invalid_session_event_exits_2_and_changes_nothing(self):
        """Missing score/research_status guards let a value land on a gate, a pass on a weighted rubric, or an off-scale number."""
        cases = [
            {"type": "score", "node": "K1", "rubric": "K1", "value": 3},  # node not an idea
            {"type": "score", "node": "I1", "rubric": "I2", "value": 3},  # rubric is an idea
            {"type": "score", "node": "I1", "rubric": "K9", "value": 3},  # no such rubric
            {"type": "score", "node": "I1", "rubric": "K4", "value": 3},  # value on a gate
            {"type": "score", "node": "I1", "rubric": "K1", "pass": True},  # pass on a weighted rubric
            {"type": "score", "node": "I1", "rubric": "K3", "pass": False},  # pass on a lens rubric
            {"type": "score", "node": "I1", "rubric": "K1", "value": 5.25},  # more than one decimal
            {"type": "score", "node": "I1", "rubric": "K1", "value": 0.9},
            {"type": "score", "node": "I1", "rubric": "K1", "value": 5.1},
            {"type": "score", "node": "I1", "rubric": "K1", "value": "4"},
            {"type": "score", "node": "I1", "rubric": "K1", "value": True},
            {"type": "score", "node": "I1", "rubric": "K1"},  # neither value nor pass
            {"type": "score", "node": "I1", "rubric": "K1", "value": 3, "pass": True},
            {"type": "score", "node": "I1", "rubric": "K4", "pass": "yes"},
            {"type": "score", "node": "I1", "rubric": "K1", "value": 3, "basis": "guess"},
            {"type": "score", "node": "I1", "rubric": "K1", "value": 3, "sources": "https://example.com"},
            {"type": "score", "node": "I1", "rubric": "K1", "value": 3, "label": "x" * 61},
            {"type": "research_status", "node": "I1", "state": "done"},  # not a research node
            {"type": "research_status", "node": "RS1", "state": "paused"},
            {"type": "research_status", "node": "RS1"},
        ]
        for event in cases:
            with self.subTest(event=event):
                self.rejected(event)

    def test_a_killed_rubric_cannot_be_scored_and_user_cannot_send_session_events(self):
        """Scoring a dropped rubric, or letting the page send score/research_status, must fail."""
        self.node("K3")["status"] = "killed"
        self.rejected({"type": "score", "node": "I1", "rubric": "K3", "value": 3})
        self.rejected({"type": "score", "node": "I1", "rubric": "K1", "value": 3}, by="user")
        self.rejected({"type": "research_status", "node": "RS1", "state": "done"}, by="user")

    def test_kill_records_the_reason_and_zeroes_boost_and_restore_clears_it(self):
        """kill without text/boost reset, or restore that keeps kill_reason, must fail."""
        summary = self.user({"type": "kill", "node": "I1", "text": " Too big for the appetite "})
        idea = self.node("I1")
        self.assertEqual((idea["status"], idea["kill_reason"], idea["boost"]), ("killed", "Too big for the appetite", 0))
        self.assertEqual(summary, "killed I1: Too big for the appetite")
        self.assertEqual((idea["by"], idea["rev"]), ("user", self.plan["rev"]))
        self.assertEqual(self.user({"type": "restore", "node": "I1"}), "restored I1")
        idea = self.node("I1")
        self.assertEqual((idea["status"], idea["kill_reason"], idea["boost"]), ("open", "", 0))

    def test_kill_with_a_multi_line_reason_keeps_the_reason_and_a_one_line_summary(self):
        """A kill reason with a newline in the recent summary would fail strict validation and reject the event."""
        summary = self.user({"type": "kill", "node": "I2", "text": "Line one\nline two"})
        self.assertEqual(summary, "killed I2: Line one line two")
        self.assertEqual(self.node("I2")["kill_reason"], "Line one\nline two")

    def test_boost_sets_the_value_on_an_open_idea(self):
        """boost that ignores the value or accepts a settled idea must fail."""
        self.assertEqual(self.user({"type": "boost", "node": "I4", "value": 3}), "boosted I4 (3)")
        self.assertEqual(self.node("I4")["boost"], 3)
        self.user({"type": "boost", "node": "I4", "value": 0})
        self.assertEqual(self.node("I4")["boost"], 0)
        self.user({"type": "promote", "node": "I4"})
        self.rejected({"type": "boost", "node": "I4", "value": 1}, by="user")

    def test_merge_creates_the_next_idea_id_as_a_draft_and_links_both_parents(self):
        """merge that reuses an id, forgets merged_from/merged_into or the request, or kills a parent must fail."""
        revision = self.plan["rev"]
        summary = self.user({"type": "merge", "node": "I2", "other": "I1"})
        draft = self.node("I5")
        self.assertEqual(summary, "merged I2 + I1 into I5")
        self.assertEqual((draft["label"], draft["tier"], draft["status"], draft["merged_from"]),
                         ("Read-only offline cache + Local-first store with background sync", "Draft", "open", ["I2", "I1"]))
        self.assertEqual((draft["pitch"], draft["boost"], draft["scores"], draft["checks"], draft["merged_into"]), ("", 0, {}, None, None))
        self.assertEqual((self.node("I1")["merged_into"], self.node("I2")["merged_into"]), ("I5", "I5"))
        self.assertEqual((self.node("I1")["status"], self.node("I2")["status"]), ("open", "open"))
        request = self.plan["requests"][-1]
        self.assertEqual((request["type"], request["node"], request["text"], request["lane"]), ("merge", "I5", "", None))
        self.assertRegex(request["ref"], r"^e-[0-9a-f]{12}$")
        self.assertEqual(self.plan["recent"][0]["rev"], revision + 1)

    def test_merge_numbers_the_draft_from_the_highest_idea_id_not_the_count(self):
        """Counting ideas instead of taking max + 1 reuses I4 after a removal and collides with the existing draft."""
        self.apply({"type": "remove", "node": "I3"})
        self.user({"type": "merge", "node": "I1", "other": "I4"})
        self.assertEqual(self.node("I5")["merged_from"], ["I1", "I4"])

    def test_merge_label_is_cut_to_120_characters(self):
        """A merge label longer than 120 characters would fail validation and refuse the merge."""
        self.apply({"type": "upsert", "node": {"id": "I1", "label": "A" * 100}})
        self.apply({"type": "upsert", "node": {"id": "I2", "label": "B" * 100}})
        self.user({"type": "merge", "node": "I1", "other": "I2"})
        self.assertEqual(self.node("I5")["label"], "A" * 100 + " + " + "B" * 17)

    def test_twist_and_research_only_add_requests(self):
        """twist/research that mutate the idea, drop the text or the node, or mis-type the request must fail."""
        before = len(self.plan["requests"])
        self.assertEqual(self.user({"type": "twist", "node": "I1"}), "twist on I1")
        self.assertEqual(self.user({"type": "twist", "node": "I2", "text": "Make it tiny"}), "twist on I2")
        self.assertEqual(self.user({"type": "research", "node": "I1"}), "research requested: I1")
        self.assertEqual(self.user({"type": "research"}), "research requested: shortlist")
        self.apply({"type": "upsert", "node": {"kind": "question", "label": "Which sync library?", "lane": "ideas",
                                               "stage": "research", "class": "taste"}})
        self.assertEqual(self.user({"type": "research", "node": "Q6", "text": "Compare sync libraries"}),
                         "research requested: question")
        added = [(r["type"], r["node"], r["text"]) for r in self.plan["requests"][before:]]
        self.assertEqual(added, [("twist", "I1", ""), ("twist", "I2", "Make it tiny"), ("research", "I1", ""),
                                 ("research", None, ""), ("research", "Q6", "Compare sync libraries")])
        self.assertEqual((self.node("I1")["boost"], self.node("I1")["status"], self.node("I1")["rev"]), (2, "open", 23))

    def test_promote_settles_one_idea_reopens_the_other_and_moves_ideate_to_frame(self):
        """promote that leaves two settled ideas, forgets the request or the stage move must fail."""
        self.assertEqual(self.user({"type": "promote", "node": "I1"}), "promoted I1")
        self.assertEqual((self.node("I1")["status"], self.plan["stage"]), ("settled", "frame"))
        self.assertEqual((self.plan["requests"][-1]["type"], self.plan["requests"][-1]["node"]), ("promote", "I1"))
        self.user({"type": "promote", "node": "I2"})
        self.assertEqual((self.node("I1")["status"], self.node("I2")["status"]), ("open", "settled"))
        self.assertEqual(self.node("I1")["rev"], self.plan["rev"])

    def test_promote_moves_research_to_frame_but_leaves_a_later_stage_alone(self):
        """promote that always sets frame would drag a plan in decide or shape backwards."""
        self.apply({"type": "set", "field": "stage", "value": "research"})
        self.user({"type": "promote", "node": "I1"})
        self.assertEqual(self.plan["stage"], "frame")
        for stage in ("decide", "shape"):
            with self.subTest(stage=stage):
                self.apply({"type": "set", "field": "stage", "value": stage})
                self.user({"type": "promote", "node": "I2"})
                self.assertEqual((self.plan["stage"], self.node("I2")["status"]), (stage, "settled"))

    def test_reopen_unpromotes_without_touching_the_stage(self):
        """Unpromote is reopen on the settled idea: status open, stage unchanged."""
        self.user({"type": "promote", "node": "I1"})
        self.apply({"type": "set", "field": "stage", "value": "decide"})
        self.user({"type": "reopen", "node": "I1"})
        self.assertEqual((self.node("I1")["status"], self.plan["stage"]), ("open", "decide"))

    def test_weight_sets_a_weighted_or_lens_rubric_and_reset_restores_defaults(self):
        """weight that edits a gate, or weights_reset that keeps edits or touches gates, must fail."""
        self.assertEqual(self.user({"type": "weight", "node": "K1", "value": 50}), "weight K1 = 50")
        self.user({"type": "weight", "node": "K3", "value": 20})
        self.user({"type": "weight", "node": "K2", "value": 0})
        self.assertEqual([self.node(k)["weight"] for k in ("K1", "K2", "K3", "K4")], [50, 0, 20, 0])
        self.assertEqual(self.user({"type": "weights_reset"}), "weights reset")
        self.assertEqual([self.node(k)["weight"] for k in ("K1", "K2", "K3", "K4")], [30, 25, 0, 0])
        self.assertEqual([self.node(k)["default_weight"] for k in ("K1", "K2", "K3", "K4")], [30, 25, 0, 0])

    def test_score_writes_a_value_or_a_gate_verdict_and_replaces_the_entry(self):
        """score that mixes scores/gates, ignores basis default session, or merges instead of replacing must fail."""
        revision = self.plan["rev"]
        self.assertEqual(self.apply({"type": "score", "node": "I4", "rubric": "K1", "value": 4.5}), "scored I4 on K1: 4.5 (session)")
        self.assertEqual(self.node("I4")["scores"]["K1"],
                         {"value": 4.5, "label": "", "rationale": "", "sources": [], "basis": "session", "rev": revision + 1})
        self.assertEqual(self.apply({"type": "score", "node": "I4", "rubric": "K1", "value": 4, "label": "Good", "rationale": "Checked the docs",
                                     "sources": ["https://example.com/a"], "basis": "research"}, source="build"),
                         "scored I4 on K1: 4 (research)")
        self.assertEqual(self.node("I4")["scores"]["K1"],
                         {"value": 4, "label": "Good", "rationale": "Checked the docs", "sources": ["https://example.com/a"],
                          "basis": "research", "rev": revision + 2})
        self.assertEqual(self.apply({"type": "score", "node": "I4", "rubric": "K4", "pass": True, "rationale": "Existing endpoints"}),
                         "I4 passes K4")
        self.assertEqual(self.node("I4")["gates"]["K4"],
                         {"pass": True, "note": "Existing endpoints", "sources": [], "basis": "session", "rev": revision + 3})
        self.assertEqual(self.apply({"type": "score", "node": "I4", "rubric": "K4", "pass": False}), "I4 fails K4")
        self.assertEqual(self.node("I4")["gates"]["K4"]["pass"], False)
        self.assertEqual(self.apply({"type": "score", "node": "I4", "rubric": "K4", "pass": None}), "I4 is undecided on K4")
        self.assertIsNone(self.node("I4")["gates"]["K4"]["pass"])
        self.assertEqual(sorted(self.node("I4")["scores"]), ["K1"])

    def test_research_status_sets_state_note_report_and_run(self):
        """research_status that drops report/run/note or the summary line must fail."""
        self.assertEqual(self.apply({"type": "research_status", "node": "RS1", "state": "queued", "run": "wf-9"}, source="build"), "RS1 queued")
        self.assertEqual(self.node("RS1")["run"], "wf-9")
        summary = self.apply({"type": "research_status", "node": "RS1", "state": "done", "report": "/tmp/idea-research/REPORT.md",
                              "note": "All topics covered"}, source="build")
        self.assertEqual(summary, "RS1 done: /tmp/idea-research/REPORT.md")
        research = self.node("RS1")
        self.assertEqual((research["state"], research["report"], research["note"], research["run"], research["status"]),
                         ("done", "/tmp/idea-research/REPORT.md", "All topics covered", "wf-9", "open"))
        self.assertEqual(self.apply({"type": "research_status", "node": "RS1", "state": "failed", "note": "Rate limited"}), "RS1 failed: Rate limited")
        self.assertEqual(self.node("RS1")["report"], "/tmp/idea-research/REPORT.md")

    def test_research_status_note_is_replaced_or_cleared_by_each_event(self):
        """research_status that keeps the previous note leaves 'Reading sync library docs' on a done job."""
        self.apply({"type": "research_status", "node": "RS1", "state": "done", "report": "/tmp/idea-research/REPORT.md"}, source="build")
        self.assertEqual(self.node("RS1")["note"], "")
        self.apply({"type": "research_status", "node": "RS1", "state": "running", "note": "Reading docs"}, source="build")
        self.assertEqual(self.node("RS1")["note"], "Reading docs")
        self.apply({"type": "research_status", "node": "RS1", "state": "done"}, source="build")
        self.assertEqual((self.node("RS1")["state"], self.node("RS1")["note"]), ("done", ""))

    def test_research_status_report_must_be_an_absolute_path(self):
        """research_status that stores a relative report path hands the page and PRD a path nobody can open."""
        self.rejected({"type": "research_status", "node": "RS1", "state": "done", "report": "REPORT.md"})
        self.rejected({"type": "research_status", "node": "RS1", "state": "done", "report": ""})
        self.apply({"type": "research_status", "node": "RS1", "state": "done", "report": "/tmp/r/REPORT.md"})
        self.assertEqual(self.node("RS1")["report"], "/tmp/r/REPORT.md")

    def test_upsert_enforces_research_target_cardinality_but_stored_plans_stay_loadable(self):
        """Missing scope/targets cardinality lets an idea job name two ideas or a shortlist name none; enforcing it in validate() breaks remove."""
        job = {"kind": "research", "label": "Probe", "vehicle": "inline", "state": "queued"}
        for scope, targets in (("idea", ["I1", "I2"]), ("idea", []), ("shortlist", [])):
            with self.subTest(scope=scope, targets=targets):
                with self.assertRaises(core.PlanError) as caught:
                    core.apply_event(self.plan, dict(
                        {"type": "upsert", "node": dict(job, scope=scope, targets=targets)}, by="session", source="terminal"))
                self.assertIn("targets", str(caught.exception))
        self.rejected({"type": "upsert", "node": {"id": "RS1", "targets": ["I1", "I2"]}})
        self.rejected({"type": "upsert", "node": {"id": "RS1", "scope": "shortlist", "targets": []}})
        self.apply({"type": "upsert", "node": dict(job, scope="idea", targets=["I2"])})
        self.apply({"type": "upsert", "node": dict(job, scope="question", targets=[])})
        self.apply({"type": "upsert", "node": dict(job, scope="shortlist", targets=["I1", "I2"])})
        self.apply({"type": "remove", "node": "I1"})  # leaves RS1 (scope idea) with no target
        self.assertEqual(self.node("RS1")["targets"], [])
        core.validate(self.plan, strict=True)
        self.apply({"type": "upsert", "node": {"id": "RS1", "label": "Renamed after its idea was removed"}})

    def test_upsert_research_targets_must_be_a_list_of_strings_not_a_crash(self):
        """A research upsert that takes len() of targets before checking its type raises TypeError (exit 1 with a traceback) for null, a number or a bool."""
        for targets in (None, 3, True, "I1", ["I1", 2]):
            with self.subTest(targets=targets):
                self.rejected({"type": "upsert", "node": {"id": "RS1", "targets": targets}})
                self.rejected({"type": "upsert", "node": {"kind": "research", "label": "Probe", "vehicle": "inline",
                                                           "state": "queued", "scope": "question", "targets": targets}})

    def test_remove_drops_the_id_from_every_reference_an_idea_or_rubric_can_hold(self):
        """remove that leaves a dangling merged_from/merged_into/targets/scores/gates key makes the whole plan unloadable."""
        self.apply({"type": "remove", "node": "K1"})
        self.assertTrue(all("K1" not in n["scores"] for n in self.plan["nodes"] if n["kind"] == "idea"))
        self.apply({"type": "remove", "node": "K4"})
        self.assertTrue(all(n["gates"] == {} for n in self.plan["nodes"] if n["kind"] == "idea"))
        self.apply({"type": "remove", "node": "I1"})
        self.assertEqual(self.node("I4")["merged_from"], ["I2"])
        self.assertEqual(self.node("RS1")["targets"], [])
        self.apply({"type": "remove", "node": "I4"})
        self.assertIsNone(self.node("I2")["merged_into"])
        self.assertIsNone(next(r for r in self.plan["requests"] if r["type"] == "merge")["node"])
        core.validate(self.plan, strict=True)

    def test_node_validation_is_closed_and_cross_checked(self):
        """Dropping a validation lets a score name a gate, two ideas be settled, a gate carry a weight or a job target a rubric."""
        score = {"value": 3, "label": "", "rationale": "", "sources": [], "basis": "session", "rev": 1}
        verdict = {"pass": True, "note": "", "sources": [], "basis": "session", "rev": 1}
        cases = [
            {"id": "I4", "scores": {"K4": score}},  # a gate under scores
            {"id": "I4", "gates": {"K1": verdict}},  # a weighted rubric under gates
            {"id": "I4", "scores": {"K9": score}},
            {"id": "I4", "scores": {"K1": dict(score, value=6)}},
            {"id": "I4", "scores": {"K1": dict(score, value=3.25)}},
            {"id": "I4", "scores": {"K1": dict(score, extra=1)}},
            {"id": "I4", "gates": {"K4": dict(verdict, **{"pass": "yes"})}},
            {"id": "I4", "boost": 4},
            {"id": "I4", "tier": "x" * 41},
            {"id": "I4", "hook": "two\nlines"},
            {"id": "I4", "twists": ["t"] * 7},
            {"id": "I4", "twists": ["x" * 301]},
            {"id": "I4", "merged_into": "K1"},
            {"id": "I4", "merged_from": ["I1", "I2", "I3"]},
            {"id": "I4", "merged_from": ["K1"]},
            {"id": "I4", "status": "parked"},
            {"id": "I4", "unknown": 1},
            {"id": "I4", "checks": {"allowed": {"verdict": "ok", "label": "", "note": ""}}},
            {"id": "I4", "checks": {k: {"verdict": "great", "label": "", "note": ""} for k in ("allowed", "exists", "feasible")}},
            {"id": "K1", "group": "other"},
            {"id": "K1", "weight": 51},
            {"id": "K1", "default_weight": -1},
            {"id": "K4", "weight": 10},
            {"id": "K4", "default_weight": 10},
            {"id": "K1", "group": "gate"},  # K1 is scored with values and has weight
            {"id": "RS1", "scope": "everything"},
            {"id": "RS1", "vehicle": "pigeon"},
            {"id": "RS1", "state": "paused"},
            {"id": "RS1", "targets": ["K1"]},
            {"id": "RS1", "targets": ["I99"]},
            {"id": "RS1", "note": "x" * 2001},
            {"kind": "research", "label": "No state yet", "scope": "idea", "vehicle": "inline"},
            {"kind": "rubric", "label": "No group"},
        ]
        for patch in cases:
            with self.subTest(patch=patch):
                self.rejected({"type": "upsert", "node": patch})
        self.apply({"type": "upsert", "node": {"id": "I1", "status": "settled"}})
        self.rejected({"type": "upsert", "node": {"id": "I2", "status": "settled"}})
        self.rejected({"type": "park", "node": "I4"}, by="user")

    def test_valid_upserts_assign_ids_and_defaults_for_the_new_kinds(self):
        """Wrong id prefixes (I, K, RS) or missing defaults for new nodes must fail."""
        self.apply({"type": "upsert", "node": {"kind": "idea", "label": "Offline-first search"}})
        self.apply({"type": "upsert", "node": {"kind": "rubric", "label": "Delight", "group": "lens"}})
        self.apply({"type": "upsert", "node": {"kind": "research", "label": "Probe", "scope": "shortlist", "targets": ["I1", "I2"],
                                               "vehicle": "sublead", "state": "queued"}})
        idea = self.node("I5")
        self.assertEqual((idea["status"], idea["boost"], idea["scores"], idea["gates"], idea["checks"], idea["merged_into"], idea["twists"]),
                         ("open", 0, {}, {}, None, None, []))
        self.assertEqual((self.node("K5")["weight"], self.node("K5")["default_weight"], self.node("K5")["origin"]), (0, 0, ""))
        self.assertEqual((self.node("RS2")["run"], self.node("RS2")["report"], self.node("RS2")["status"]), ("", "", "open"))

    def test_multi_line_pitch_win_rationale_and_gate_note_survive_strict_validation(self):
        """Treating pitch/win/rationale/note as one-line fields rejects every Markdown pitch and multi-paragraph rationale."""
        self.apply({"type": "upsert", "node": {"id": "I4", "pitch": "Line one\n\nLine two", "win": "a\nb", "who": "x\ny"}})
        self.apply({"type": "score", "node": "I4", "rubric": "K1", "value": 3, "rationale": "para one\n\npara two"})
        self.apply({"type": "score", "node": "I4", "rubric": "K4", "pass": False, "rationale": "reason\nmore"})
        self.assertEqual(self.node("I4")["gates"]["K4"]["note"], "reason\nmore")

    def test_ideate_and_research_are_free_stages_and_questions_may_be_asked_there(self):
        """set stage that refuses ideate/research, or a frontier that ranks them after frame, must fail."""
        self.apply({"type": "set", "field": "stage", "value": "shape"})
        self.apply({"type": "set", "field": "stage", "value": "research"})
        self.apply({"type": "set", "field": "stage", "value": "ideate"})
        self.apply({"type": "set", "field": "stage", "value": "decide"})
        self.assertEqual(self.plan["stage"], "decide")
        for stage in ("research", "ideate"):
            self.apply({"type": "upsert", "node": {"kind": "question", "label": f"Asked in {stage}", "lane": "ideas",
                                                   "stage": stage, "class": "taste"}})
        self.assertEqual(self.plan["frontier"], ["Q7", "Q6", "Q1", "Q2", "Q3", "Q4", "Q5"])
        self.rejected({"type": "upsert", "node": {"kind": "question", "label": "Bad", "lane": "ideas", "stage": "ready", "class": "taste"}})

    def test_setting_ideate_below_ready_clears_approval(self):
        """Approval must reset when the plan goes back to Ideate."""
        self.plan["stage"], self.plan["approved"] = "ready", {"at": "2026-10-17T10:00:00Z", "rev": 1}
        self.apply({"type": "set", "field": "stage", "value": "ideate"})
        self.assertIsNone(self.plan["approved"])


class ProjectionTests(unittest.TestCase):
    def test_ideate_nodes_never_render_and_lint_ignores_them(self):
        """Rendering an idea, rubric or research node into the PRD, or a lint finding about one, must fail."""
        plan = fixture_plan()
        text = prd.render(plan)
        for needle in ("Local-first", "Read-only offline cache", "Fits the two-week", "Check sync libraries", "I4", "RS1"):
            self.assertNotIn(needle, text)
        board = ("idea", "rubric", "research")
        stripped = copy.deepcopy(plan)
        stripped["nodes"] = [n for n in stripped["nodes"] if n["kind"] not in board]
        self.assertEqual(text, prd.render(stripped))
        self.assertEqual(lint.lint(plan), lint.lint(stripped))
        self.assertEqual([prd.section_has_content(plan, n) for n in range(19)], [prd.section_has_content(stripped, n) for n in range(19)])

    def test_board_events_after_approval_do_not_flag_the_prd_as_changed(self):
        """Counting ideas, rubrics and research as spec changes stamps 'changed since' on a PRD whose text did not change."""
        plan = json.loads((HERE / "fixtures/plan-ready.json").read_text(encoding="utf-8"))
        core.apply_event(plan, {"type": "approve_prd", "by": "user", "source": "page"})
        core.apply_event(plan, {"type": "upsert", "node": {"kind": "idea", "label": "Late idea"}, "by": "session"})
        core.apply_event(plan, {"type": "boost", "node": "I1", "value": 1, "by": "user", "source": "page"})
        header = prd.render(plan).split("\n## 1. ", 1)[0]
        self.assertIn("- Approved at rev 41\n", header)
        self.assertNotIn("changed since", header)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "crew"
        self.env = dict(os.environ, CREW_ROOT=str(self.root), PYTHONDONTWRITEBYTECODE="1")
        self.directory = self.root / TASK / "plan"
        self.directory.mkdir(parents=True)
        shutil.copyfile(FIXTURE, self.directory / "plan.json")
        (self.directory / "events.jsonl").write_text("", encoding="utf-8")

    def cli(self, *args, code=0):
        result = subprocess.run([sys.executable, str(CLI), *args], env=self.env, text=True, capture_output=True, timeout=30)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        return result.stdout

    def event(self, event, by="session", source="terminal", code=0):
        out = self.cli("event", TASK, "--by", by, "--source", source, "--json", json.dumps(event), code=code)
        return json.loads(out) if out else None

    def test_news_returns_finished_research_from_any_actor_and_skips_running(self):
        """news that filters research_status by by/source hides results sent --by session --source build; one that returns running spams the session."""
        self.event({"type": "research_status", "node": "RS1", "state": "running", "run": "wf-1"}, source="build")
        done = self.event({"type": "research_status", "node": "RS1", "state": "done", "report": "/tmp/r/REPORT.md"}, source="build")
        failed = self.event({"type": "research_status", "node": "RS1", "state": "failed", "note": "No network"})
        self.event({"type": "score", "node": "I4", "rubric": "K1", "value": 3}, source="build")
        boost = self.event({"type": "boost", "node": "I4", "value": 2}, by="user", source="page")
        peek = json.loads(self.cli("news", TASK, "--json", "--peek"))
        self.assertEqual([e["id"] for e in peek], [done["event"]["id"], failed["event"]["id"], boost["event"]["id"]])
        self.assertEqual(json.loads(self.cli("news", TASK, "--json")), peek)
        self.assertEqual(json.loads(self.cli("news", TASK, "--json")), [])
        self.event({"type": "research_status", "node": "RS1", "state": "done"}, source="build")
        text = self.cli("news", TASK)
        self.assertRegex(text, r"^rev \d+ research_status RS1 done\n$")

    def test_page_events_are_listed_by_news_and_requests_are_shown(self):
        """merge/twist/promote/research requests missing from news or show leave the session blind to the board."""
        self.event({"type": "twist", "node": "I2", "text": "What if it queued edits?"}, by="user", source="page")
        self.event({"type": "promote", "node": "I2"}, by="user", source="page")
        text = self.cli("news", TASK)
        self.assertEqual([line.split()[2:4] for line in text.splitlines()], [["twist", "I2"], ["promote", "I2"]])
        shown = self.cli("show", TASK)
        self.assertIn("Stage: frame", shown)
        self.assertIn("merge I4", shown)
        self.assertIn("twist I2: What if it queued edits?", shown)
        self.assertIn("promote I2:", shown)

    def test_news_names_the_merge_draft_not_a_parent(self):
        """A merge news entry whose node is the parent (or that omits the draft) lets the session treat parent I2 as the draft to write up."""
        sent = self.event({"type": "merge", "node": "I2", "other": "I1"}, by="user", source="page")
        self.assertEqual(sent["summary"], "merged I2 + I1 into I5")
        self.assertEqual(self.cli("news", TASK, "--peek"), f"rev {sent['rev']} merge I2 + I1 \u2192 draft I5\n")
        entry, = json.loads(self.cli("news", TASK, "--json"))
        self.assertEqual((entry["type"], entry["node"], entry["merged_from"], "other" in entry), ("merge", "I5", ["I2", "I1"], False))
        draft = json.loads(self.cli("show", TASK, "--json"))["nodes"]
        self.assertEqual([n["merged_from"] for n in draft if n["id"] == "I5"], [["I2", "I1"]])

    def test_a_plan_with_the_new_kinds_loads_renders_lints_and_lists(self):
        """Any command crashing on idea/rubric/research nodes fails this round trip."""
        self.cli("render", TASK)
        self.assertTrue((self.directory / "PRD.md").read_text().startswith("<!-- Generated from plan.json rev 26"))
        self.cli("lint", TASK, code=1)
        self.cli("frontier", TASK)
        self.assertIn("ideate", self.cli("list"))
        self.assertEqual(json.loads(self.cli("show", TASK, "--json"))["rev"], 26)
        self.assertEqual(json.loads((self.directory / "plan.json").read_text())["nodes"][0]["id"], "Q1")


if __name__ == "__main__":
    unittest.main()
