"""Comments, proposals and the plan-level thread (contract 13). Each docstring names the production regression it catches."""
import copy
import json
import os
from pathlib import Path
import shutil
import sys
import unittest
from unittest import mock

import test_core
from test_core import HERE, SCRIPTS

sys.path.insert(0, str(SCRIPTS))
import plan_core as core  # noqa: E402
import prd  # noqa: E402


class CommentTests(unittest.TestCase):
    setUp = test_core.CoreTests.setUp
    cli = test_core.CoreTests.cli
    event = test_core.CoreTests.event
    plan = test_core.CoreTests.plan
    node = test_core.CoreTests.node
    snapshot = test_core.CoreTests.snapshot
    ready = test_core.CoreTests.ready

    def user(self, event):
        return self.event(event, by="user", source="page")

    def comment(self, text="Add pinned notes", author="Dana", anchor=None):
        event = {"type": "comment", "text": text}
        if author is not None:
            event["author"] = author
        if anchor is not None:
            event["anchor"] = anchor
        return self.user(event)["event"]["comment"]

    def triage(self, cid, action="accept", text="", changes=None, **extra):
        event = {"type": "comment_triage", "ref": cid, "action": action, "text": text}
        if changes is not None:
            event["changes"] = changes
        event.update(extra)
        return self.event(event)

    def proposed(self, cid=None, changes=None, action="accept", text="Add it"):
        cid = cid or self.comment()
        if changes is None and action == "accept":
            changes = [{"type": "upsert", "node": {"kind": "requirement", "label": "Pinned notes sync first"}}]
        self.triage(cid, action, text, changes)
        return cid

    def accept(self, cid, code=0, by="user"):
        proposal = next(c for c in self.plan()["comments"] if c["id"] == cid)["proposal"]
        return self.event({"type": "comment_accept", "ref": cid, "proposal": proposal["rev"]},
                          code=code, by=by, source="page")

    def comments(self):
        return self.plan().get("comments", [])

    def comment_requests(self):
        return [r for r in self.plan()["requests"] if r["type"] == "comment"]

    # in-process helpers (a hundred CLI calls would take a minute)
    def loaded(self):
        return json.loads((HERE / "fixtures/plan-standard.json").read_text(encoding="utf-8"))

    def apply(self, plan, event, by="session"):
        event = dict(event, by=by, source="page" if by == "user" else "terminal")
        return core.apply_event(plan, event)

    # ---- 1. old plans stay valid

    def test_old_plans_and_every_fixture_load_without_the_optional_keys(self):
        """A validator that requires comments/thread/comment_seq rejects every existing plan."""
        for name in ("plan-standard.json", "plan-ready.json", "plan-ideate.json", "plan-defects.json"):
            plan = json.loads((HERE / "fixtures" / name).read_text(encoding="utf-8"))
            self.assertFalse({"comments", "thread", "comment_seq"} & set(plan))
            core.validate(plan, strict=True)
        self.cli("show", self.task)

    def test_hand_edited_malformed_comments_thread_or_seq_are_rejected_on_load(self):
        """A loader that skips the closed comment/thread/comment_seq checks lets a forged proposal or id counter in."""
        self.comment()
        good = self.plan()
        bad_edits = [
            lambda p: p["comments"][0].update(extra=1),
            lambda p: p["comments"][0].update(state="done"),
            lambda p: p["comments"][0].update(source="chat"),
            lambda p: p["comments"][0].update(id="X1"),
            lambda p: p["comments"][0].update(author="x" * 81),
            lambda p: p["comments"][0].update(author="a\nb"),
            lambda p: p["comments"][0].update(text=""),
            lambda p: p["comments"][0].update(text="x" * 5001),
            lambda p: p["comments"][0].update(anchor="NOPE-9"),
            lambda p: p["comments"][0].update(anchor="§19"),
            lambda p: p["comments"][0].update(state="proposed"),  # proposed needs a proposal
            lambda p: p["comments"][0].update(proposal={"action": "accept"}),  # open has none
            lambda p: p.update(comment_seq=0),  # counter behind an existing id
            lambda p: p.update(comment_seq="1"),
            lambda p: p.update(comments="x"),
            lambda p: p.update(comments=[p["comments"][0]] * 101),
            lambda p: p.update(thread=[{"role": "user", "text": "hi", "at": "2026-10-17T00:00:00Z", "ref": "e-1"}]),  # no links
            lambda p: p.update(thread=[{"role": "user", "text": "hi", "at": "2026-10-17T00:00:00Z", "ref": "e-1", "links": ["Q7"]}]),
            lambda p: p.update(thread=[{"role": "bot", "text": "hi", "at": "2026-10-17T00:00:00Z", "ref": "e-1", "links": []}]),
            lambda p: p.update(thread=[{"role": "session", "text": "hi", "at": "2026-10-17T00:00:00Z", "ref": "e-1", "links": ["Q7"] * 11}]),
            lambda p: p.update(thread=[{"role": "user", "text": "hi", "at": "2026-10-17T00:00:00Z", "ref": "e-1", "links": []}] * 41),
            lambda p: p.update(surprise=1),
        ]
        for edit in bad_edits:
            plan = copy.deepcopy(good)
            edit(plan)
            (self.directory / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
            self.cli("show", self.task, code=2)
        (self.directory / "plan.json").write_text(json.dumps(good), encoding="utf-8")
        self.cli("show", self.task)

    # ---- 2. comment

    def test_comment_creates_an_open_comment_and_a_request_without_leaking_name_or_text(self):
        """A comment without its request, without the CM counter, or whose summary carries the name/text, must fail."""
        response = self.user({"type": "comment", "text": " Add pinned notes\nand tags ", "author": " Dana K ", "anchor": "FR-001"})
        self.assertEqual(response["summary"], "comment CM1 added")
        self.assertEqual(response["event"]["comment"], "CM1")
        plan = self.plan()
        comment = plan["comments"][0]
        self.assertEqual({k: v for k, v in comment.items() if k != "at"},
                         {"id": "CM1", "author": "Dana K", "text": "Add pinned notes\nand tags", "anchor": "FR-001",
                          "state": "open", "source": "paste", "proposal": None})
        self.assertEqual(plan["comment_seq"], 1)
        request = self.comment_requests()[0]
        self.assertEqual((request["ref"], request["node"], request["text"], request["lane"]),
                         ("CM1", "FR-001", "Add pinned notes\nand tags", None))
        self.assertEqual(plan["rev"], 96)
        self.assertNotIn("Dana", json.dumps(plan["recent"]))
        self.assertNotIn("pinned", json.dumps(plan["recent"]))
        self.assertEqual(self.node("FR-001")["rev"], 23)  # a comment is not a spec change
        self.comment(author=None, anchor="§9")
        second = self.comments()[1]
        self.assertEqual((second["id"], second["author"], second["anchor"]), ("CM2", "", "§9"))
        self.assertEqual(self.comment_requests()[1]["node"], None)  # a section anchor is not a node

    def test_comment_ids_are_never_reused_after_a_delete(self):
        """A counter derived from max existing id reuses CM2 after it was deleted."""
        self.comment()
        self.comment()
        self.user({"type": "comment_delete", "ref": "CM2"})
        self.assertEqual(self.comment(), "CM3")
        self.assertEqual(self.plan()["comment_seq"], 3)

    def test_comment_refuses_bad_text_author_anchor_and_control_characters(self):
        """Accepting an over-cap text, multi-line author, unknown anchor or a control character must fail."""
        invalid = [
            {"text": "x" * 5001}, {"text": "  "}, {"text": 7}, {},
            {"text": "ok", "author": "x" * 81}, {"text": "ok", "author": "two\nlines"}, {"text": "ok", "author": 5},
            {"text": "ok", "anchor": "Q99"}, {"text": "ok", "anchor": "§19"}, {"text": "ok", "anchor": "§-1"},
            {"text": "ok", "anchor": "§01"}, {"text": "ok", "anchor": 7}, {"text": "ok", "anchor": ""},
            {"text": "bell\x07"}, {"text": "esc\x1b[2J"}, {"text": "bidi‮x"}, {"text": "ok", "author": "ev\x1bil"},
            {"text": "ok", "author": "ev‮il"},
        ]
        before = self.snapshot()
        for fields in invalid:
            with self.subTest(fields=fields):
                self.event(dict(fields, type="comment"), code=2, by="user", source="page")
                self.assertEqual(self.snapshot(), before)
        self.user({"type": "comment", "text": "x" * 5000, "author": "y" * 80, "anchor": "§18"})
        self.user({"type": "comment", "text": "tab\there\nnewline", "anchor": "§0"})

    def test_comment_cap_is_one_hundred(self):
        """No cap (or an off-by-one) lets comments grow without bound."""
        plan = self.loaded()
        for i in range(100):
            self.apply(plan, {"type": "comment", "text": f"c{i}"}, by="user")
        self.assertEqual(len(plan["comments"]), 100)
        before = copy.deepcopy(plan)
        with self.assertRaisesRegex(core.PlanError, "delete closed comments"):
            self.apply(plan, {"type": "comment", "text": "one too many"}, by="user")
        self.assertEqual(plan, before)
        self.apply(plan, {"type": "comment_delete", "ref": "CM7"}, by="user")
        self.apply(plan, {"type": "comment", "text": "fits again"}, by="user")
        self.assertEqual(plan["comments"][-1]["id"], "CM101")

    # ---- 3. split

    def test_split_replaces_the_raw_comment_and_its_request_with_one_per_part(self):
        """A split that keeps the raw comment/request, loses the author default, or skips the per-part requests must fail."""
        raw = self.comment("one. two. three.", author="Dana", anchor="FR-001")
        response = self.event({"type": "comment_split", "ref": raw, "parts": [
            {"text": "one"}, {"text": "two", "author": "Lee", "anchor": "§9"}, {"text": " three ", "anchor": None}]})
        self.assertEqual(response["summary"], "split CM1 into 3")
        got = [(c["id"], c["author"], c["text"], c["anchor"], c["state"]) for c in self.comments()]
        self.assertEqual(got, [("CM2", "Dana", "one", "FR-001", "open"), ("CM3", "Lee", "two", "§9", "open"),
                               ("CM4", "Dana", "three", None, "open")])
        self.assertEqual([(r["ref"], r["node"]) for r in self.comment_requests()],
                         [("CM2", "FR-001"), ("CM3", None), ("CM4", None)])
        self.assertEqual(self.plan()["comment_seq"], 4)

    def test_split_refuses_user_senders_bad_parts_non_open_comments_and_the_cap(self):
        """A split a page user can send, with 1 or 11 parts, on a proposed comment, or over the cap, must fail."""
        raw = self.comment("a b")
        two = [{"text": "a"}, {"text": "b"}]
        self.event({"type": "comment_split", "ref": raw, "parts": two}, code=2, by="user", source="page")
        for event in ({"ref": raw, "parts": [{"text": "a"}]}, {"ref": raw, "parts": [{"text": str(i)} for i in range(11)]},
                      {"ref": raw, "parts": [{"text": "a"}, {"text": ""}]}, {"ref": raw, "parts": [{"text": "a"}, {"nope": 1}]},
                      {"ref": raw, "parts": [{"text": "a"}, {"text": "b", "anchor": "Q99"}]},
                      {"ref": raw, "parts": [{"text": "a"}, {"text": "b", "author": "x" * 81}]},
                      {"ref": raw, "parts": [{"text": "a"}, {"text": "b" * 5001}]},
                      {"ref": raw, "parts": [{"text": "a"}, {"text": "e\x1b[0m"}]},
                      {"ref": raw, "parts": "ab"}, {"ref": raw}, {"ref": "CM9", "parts": two}):
            before = self.snapshot()
            self.event(dict(event, type="comment_split"), code=2)
            self.assertEqual(self.snapshot(), before)
        self.proposed(raw)
        self.event({"type": "comment_split", "ref": raw, "parts": two}, code=2)
        plan = self.loaded()
        for i in range(99):
            self.apply(plan, {"type": "comment", "text": f"c{i}"}, by="user")
        self.apply(plan, {"type": "comment_split", "ref": "CM1", "parts": two[:1] * 2})  # 99 - 1 + 2 = 100
        self.assertEqual(len(plan["comments"]), 100)
        with self.assertRaisesRegex(core.PlanError, "delete closed comments"):
            self.apply(plan, {"type": "comment_split", "ref": "CM3", "parts": two})  # 100 - 1 + 2 = 101

    # ---- 4. triage

    def test_triage_proposes_and_removes_the_request_without_touching_the_plan(self):
        """A triage that applies its changes, keeps the request open, or loses the proposal fields must fail."""
        cid = self.comment(anchor="§9")
        before = self.plan()
        change = {"type": "upsert", "node": {"kind": "requirement", "label": " Pinned notes sync first "}}
        response = self.triage(cid, "accept", "Teammate wants pinned notes", [change, {"type": "reopen", "node": "FR-005"}],
                               anchor="FR-004")
        self.assertEqual(response["summary"], "proposal on CM1: accept")
        plan = self.plan()
        comment = plan["comments"][0]
        proposal = comment["proposal"]
        self.assertEqual((comment["state"], comment["anchor"]), ("proposed", "FR-004"))
        self.assertEqual({k: v for k, v in proposal.items() if k != "at"},
                         {"action": "accept", "text": "Teammate wants pinned notes", "rev": 97,
                          "changes": [{"type": "upsert", "node": {"kind": "requirement", "label": "Pinned notes sync first"}},
                                      {"type": "reopen", "node": "FR-005"}]})
        self.assertEqual(proposal["at"], response["event"]["at"])
        self.assertEqual(self.comment_requests(), [])
        self.assertEqual(plan["nodes"], before["nodes"])

    def test_triage_answer_and_decline_need_text_and_forbid_changes(self):
        """An answer/decline that carries changes or no text, or an accept with 0 or 6 changes, must fail."""
        cid = self.comment()
        upsert = {"type": "upsert", "node": {"kind": "requirement", "label": "Req"}}
        invalid = [
            {"action": "accept"}, {"action": "accept", "changes": []}, {"action": "accept", "changes": [upsert] * 6},
            {"action": "accept", "changes": "x"}, {"action": "accept", "changes": [upsert], "text": "x" * 2001},
            {"action": "answer", "text": "yes", "changes": [upsert]}, {"action": "decline", "text": "no", "changes": [upsert]},
            {"action": "answer"}, {"action": "decline", "text": "  "}, {"action": "maybe", "text": "x"},
            {"action": "answer", "text": "yes", "anchor": "Q99"},
        ]
        before = self.snapshot()
        for fields in invalid:
            with self.subTest(fields=fields):
                self.event(dict(fields, type="comment_triage", ref=cid), code=2)
                self.assertEqual(self.snapshot(), before)
        self.event({"type": "comment_triage", "ref": cid, "action": "accept", "changes": [upsert] * 5})
        other = self.comment("second")
        self.event({"type": "comment_triage", "ref": other, "action": "decline", "text": "Out of scope", "changes": []})
        self.assertEqual(self.comments()[1]["proposal"]["changes"], [])
        self.event({"type": "comment_triage", "ref": other, "action": "answer", "text": "x"}, code=2)  # no longer open
        self.event({"type": "comment_triage", "ref": cid, "action": "answer", "text": "x"}, code=2)
        self.user_triage_refused(self.comment("third"))

    def user_triage_refused(self, cid):
        self.event({"type": "comment_triage", "ref": cid, "action": "answer", "text": "x"}, code=2, by="user", source="page")

    def test_triage_changes_are_allow_listed(self):
        """A proposal that can touch tasks, status, dependencies, other events or resurrect a node lets a comment inject work."""
        cid = self.comment()
        node = lambda **patch: {"type": "upsert", "node": patch}  # noqa: E731
        forbidden = [
            node(kind="task", label="T", check="rm -rf /"), node(id="T-002", label="x"), node(kind="idea", label="x"),
            node(kind="decision", label="x"), node(kind="criterion", label="x"), node(kind="rubric", label="x"),
            node(kind="research", label="x"), node(kind="slice", label="x"), node(kind="boundary", label="x"),
            node(id="FR-001", status="killed"), node(id="FR-001", depends_on=["Q7"]), node(id="FR-001", refs=["Q7"]),
            node(id="Q7", fills=["DEC-1"]), node(id="Q7", answer={"choice": "a"}), node(id="FR-001", thread=[]),
            node(id="FR-001", rev=1), node(id="FR-001", by="session"), node(id="FR-001", by_default=True),
            node(kind="requirement", label="x", files=["a"]), node(kind="risk", label="x", nfr=True),
            node(kind="requirement", label="x", approach="x"), node(kind="question", label="x", answer=None),
            node(id="FR-404", label="resurrected"), node(id="FR-001", kind="risk"), node(label="no kind"),
            node(), {"type": "upsert"}, {"type": "upsert", "node": "FR-001"},
            {"type": "upsert", "node": {"kind": "risk", "label": "x"}, "by": "user"},
            {"type": "reopen", "node": "T-001"}, {"type": "reopen", "node": "I1"}, {"type": "reopen", "node": "NOPE"},
            {"type": "reopen"}, {"type": "edit_label", "node": "T-002", "label": "x"}, {"type": "edit_label", "node": "FR-001"},
            {"type": "set", "field": "stage", "value": "shape"}, {"type": "set", "field": "owner", "value": "x"},
            {"type": "set", "field": "published", "value": "/tmp/x"}, {"type": "set", "field": "title"},
            {"type": "remove", "node": "FR-001"}, {"type": "answer", "node": "Q7", "choice": "a"},
            {"type": "approve_prd"}, {"type": "task_status", "node": "T-002", "status": "done"},
            {"type": "comment", "text": "nested"}, {"type": "kill", "node": "I1", "text": "x"}, {"label": "no type"}, "text",
            node(kind="risk", label="x" * 121), node(kind="risk", label="ok", body="b" * 4001),
            node(kind="risk", label="bad\x1b[0m"), node(kind="risk", label="ok", approach="esc\x1b[2J"),
            node(kind="risk", label="ok", approach="x" * 4001),
            {"type": "set", "field": "tldr", "value": "bidi‮x"},
        ]
        before = self.snapshot()
        for change in forbidden:
            with self.subTest(change=change):
                self.event({"type": "comment_triage", "ref": cid, "action": "accept", "text": "",
                            "changes": [change]}, code=2)
                self.assertEqual(self.snapshot(), before)
        allowed = [
            node(kind="requirement", label="R", nfr=True, body="under 2 s"), node(kind="risk", label="R", approach="spike"),
            node(kind="assumption", label="A", validate_by="demo", impact="high"), node(kind="edge", label="E", expect="x"),
            node(kind="nongoal", label="N", why="x"), node(kind="constraint", label="C", tag="perf"),
            node(kind="note", label="N", lane="scope"), node(kind="goal", label="G"), node(kind="story", label="S"),
            node(id="Q7", label="Renamed", why="because", recommended="b", lane="scope"),
            node(id="FR-001", label="Renamed", body="b"), {"type": "reopen", "node": "FR-005"},
            {"type": "edit_label", "node": "Q7", "label": "New"}, {"type": "set", "field": "title", "value": "T"},
            {"type": "set", "field": "tldr", "value": "Three sentences."},
        ]
        for change in allowed:
            with self.subTest(change=change):
                other = self.comment("c")
                self.event({"type": "comment_triage", "ref": other, "action": "accept", "changes": [change]})

    def test_triage_dry_run_catches_changes_that_make_the_plan_invalid(self):
        """Storing a proposal that cannot be applied (invalid node, unknown option key) defers the failure to the user's click."""
        cid = self.comment()
        for change in ({"type": "upsert", "node": {"kind": "requirement", "label": "Fast", "nfr": True}},  # NFR without a number
                       {"type": "upsert", "node": {"kind": "note", "label": "x"}},  # note without a lane
                       {"type": "upsert", "node": {"kind": "constraint", "label": "x", "tag": "weird"}},
                       {"type": "upsert", "node": {"id": "Q7", "recommended": "z"}},
                       {"type": "upsert", "node": {"kind": "requirement", "label": "x", "nfr": "yes"}},
                       {"type": "reopen", "node": "AS-1"},  # already open
                       {"type": "set", "field": "title", "value": ""}):
            before = self.snapshot()
            self.event({"type": "comment_triage", "ref": cid, "action": "accept", "changes": [change]}, code=2)
            self.assertEqual(self.snapshot(), before)
        cid2 = self.comment("two")
        before = self.snapshot()  # the second change fails after the first would have applied
        self.event({"type": "comment_triage", "ref": cid2, "action": "accept", "changes": [
            {"type": "upsert", "node": {"kind": "risk", "label": "ok"}}, {"type": "reopen", "node": "AS-1"}]}, code=2)
        self.assertEqual(self.snapshot(), before)

    # ---- 5. accept / rework / delete

    def test_accept_applies_the_stored_changes_atomically_with_the_event(self):
        """An accept that leaves the plan unchanged, applies with by=session, or stores the changes without assigned ids must fail."""
        cid = self.proposed(changes=[
            {"type": "upsert", "node": {"kind": "requirement", "label": "Pinned notes sync first", "body": "Pinned first."}},
            {"type": "upsert", "node": {"kind": "risk", "label": "Pin storms"}},
            {"type": "edit_label", "node": "FR-004", "label": "Sync retries after a failure"},
            {"type": "set", "field": "tldr", "value": "Offline notes that sync."}])
        before = self.plan()
        response = self.accept(cid)
        self.assertEqual(response["summary"], "accepted CM1")
        self.assertEqual(response["rev"], 98)
        plan = self.plan()
        self.assertEqual(plan["comments"][0]["state"], "accepted")
        self.assertEqual(plan["comments"][0]["proposal"], before["comments"][0]["proposal"])
        requirement, risk = self.node("FR-006"), self.node("R-4")
        self.assertEqual((requirement["label"], requirement["body"], requirement["status"], requirement["by"], requirement["rev"]),
                         ("Pinned notes sync first", "Pinned first.", "open", "user", 98))
        self.assertEqual((risk["by"], risk["rev"]), ("user", 98))
        self.assertEqual((self.node("FR-004")["label"], self.node("FR-004")["by"], self.node("FR-004")["rev"]),
                         ("Sync retries after a failure", "user", 98))
        self.assertEqual(plan["tldr"], "Offline notes that sync.")
        stored = response["event"]["changes"]
        self.assertEqual([c["node"]["id"] for c in stored if c["type"] == "upsert"], ["FR-006", "R-4"])
        self.assertEqual(stored[0]["node"]["label"], "Pinned notes sync first")
        self.assertEqual(json.loads((self.directory / "events.jsonl").read_text().splitlines()[-1])["changes"], stored)
        self.assertEqual(plan["recent"][0]["summary"], "accepted CM1")
        self.assertNotIn("Pinned", json.dumps(plan["recent"]))

    def test_accept_of_an_answer_or_decline_only_changes_the_comment_state(self):
        """An answered/declined accept that touches nodes, or sets state accepted, must fail."""
        answer = self.proposed(self.comment("why?"), action="answer", text="Because CRDTs are out of scope.")
        decline = self.proposed(self.comment("add crdt"), action="decline", text="Non-goal NG-1.")
        nodes = self.plan()["nodes"]
        self.assertEqual(self.accept(answer)["summary"], "answered CM1")
        self.assertEqual(self.accept(decline)["summary"], "declined CM2")
        plan = self.plan()
        self.assertEqual([c["state"] for c in plan["comments"]], ["answered", "declined"])
        self.assertEqual(plan["nodes"], nodes)
        self.accept(decline, code=2)

    def test_accept_refuses_sessions_wrong_states_a_changed_proposal_and_stale_nodes(self):
        """A session accepting its own proposal, an accept of an open/closed comment, a stale proposal id or a node edited since must fail."""
        cid = self.proposed(changes=[{"type": "edit_label", "node": "FR-004", "label": "Sync retries"}])
        before = self.snapshot()
        self.accept(cid, code=2, by="session")
        at = self.comments()[0]["proposal"]["rev"]
        for proposal in ("2020-01-01T00:00:00Z", None, at + 1000, at - 1, True, str(at), float(at)):
            self.event({"type": "comment_accept", "ref": cid, "proposal": proposal}, code=2, by="user", source="page")
        self.event({"type": "comment_accept", "ref": cid}, code=2, by="user", source="page")
        self.event({"type": "comment_accept", "ref": "CM9", "proposal": at}, code=2, by="user", source="page")
        self.assertEqual(self.snapshot(), before)
        openc = self.comment("still open")
        self.event({"type": "comment_accept", "ref": openc, "proposal": at}, code=2, by="user", source="page")
        self.event({"type": "edit_label", "node": "FR-004", "label": "Edited by someone else"})
        before = self.snapshot()
        self.accept(cid, code=2)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.comments()[0]["state"], "proposed")
        self.event({"type": "comment_rework", "ref": cid}, by="user", source="page")
        self.assertEqual(self.comments()[0]["state"], "open")

    def test_accept_names_the_proposal_by_its_rev_so_two_proposals_in_one_second_are_told_apart(self):
        """An accept keyed on proposal.at (second resolution) applies a newer proposal the owner never saw when it shares the second with the one they saw."""
        plan = self.loaded()
        with mock.patch.object(core, "utcnow", return_value="2026-10-18T10:00:00Z"):
            self.apply(plan, {"type": "comment", "text": "Add pinned notes"}, by="user")
            relabel = lambda label: {"type": "comment_triage", "ref": "CM1", "action": "accept", "text": "do it",
                                     "changes": [{"type": "edit_label", "node": "FR-004", "label": label}]}
            self.apply(plan, relabel("Sync retries"))
            seen = plan["comments"][0]["proposal"]
            self.apply(plan, {"type": "comment_rework", "ref": "CM1"}, by="user")
            self.apply(plan, relabel("Sync forever"))
            newer = plan["comments"][0]["proposal"]
            self.assertEqual(seen["at"], newer["at"])
            self.assertNotEqual(seen["rev"], newer["rev"])
            for stale in (seen["at"], seen["rev"]):
                with self.assertRaisesRegex(core.PlanError, "The proposal changed; reload the page"):
                    self.apply(plan, {"type": "comment_accept", "ref": "CM1", "proposal": stale}, by="user")
            self.assertEqual(plan["comments"][0]["state"], "proposed")
            self.apply(plan, {"type": "comment_accept", "ref": "CM1", "proposal": newer["rev"]}, by="user")
        self.assertEqual(next(n for n in plan["nodes"] if n["id"] == "FR-004")["label"], "Sync forever")

    def test_accept_from_a_terminal_or_build_source_is_refused_even_by_user(self):
        """A session typing `--by user --source terminal` must not be able to accept its own proposal: only the page click is the owner's."""
        cid = self.proposed(changes=[{"type": "edit_label", "node": "FR-004", "label": "Sync retries"}])
        at = self.comments()[0]["proposal"]["rev"]
        before = self.snapshot()
        for source in ("terminal", "build"):
            self.event({"type": "comment_accept", "ref": cid, "proposal": at}, code=2, by="user", source=source)
        self.assertEqual(self.snapshot(), before)
        self.accept(cid)
        self.assertEqual(self.comments()[0]["state"], "accepted")

    def test_stale_refusal_names_the_node_and_the_proposal_prefix(self):
        """A stale accept that reports a bare validation error instead of the contract's 'Proposal no longer applies' hides why."""
        cid = self.proposed(changes=[{"type": "edit_label", "node": "FR-004", "label": "Sync retries"}])
        self.event({"type": "edit_label", "node": "FR-004", "label": "Changed"})
        result = self.cli_error({"type": "comment_accept", "ref": cid,
                                 "proposal": self.comments()[0]["proposal"]["rev"]})
        self.assertIn("Proposal no longer applies: node changed since the proposal", result)

    def cli_error(self, event):
        import subprocess
        result = subprocess.run([sys.executable, str(SCRIPTS / "plan.py"), "event", self.task, "--by", "user", "--source", "page",
                                 "--json", json.dumps(event)], env=self.env, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 2, result.stdout)
        return result.stderr

    def test_accept_refuses_when_a_target_was_removed_or_the_plan_no_longer_validates(self):
        """An accept that crashes or half-applies when a target node is gone must fail; nothing may be written."""
        cid = self.proposed(changes=[{"type": "upsert", "node": {"kind": "risk", "label": "New risk"}},
                                     {"type": "reopen", "node": "FR-005"}])
        self.event({"type": "remove", "node": "FR-005"})
        before = self.snapshot()
        self.accept(cid, code=2)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual([n["id"] for n in self.plan()["nodes"] if n["kind"] == "risk"], ["R-1", "R-2", "R-3"])
        self.assertEqual(self.comments()[0]["state"], "proposed")

    def test_accepting_twice_is_refused(self):
        """A second accept of an accepted comment would re-apply its changes."""
        cid = self.proposed()
        self.accept(cid)
        self.event({"type": "comment_accept", "ref": cid, "proposal": 99999}, code=2, by="user", source="page")
        self.assertEqual(len([n for n in self.plan()["nodes"] if n["kind"] == "requirement"]), 6)

    def test_rework_reopens_with_a_new_request_and_delete_removes_everything(self):
        """A rework that keeps the proposal or loses the feedback, a user-less rework/delete, or a delete that orphans the request must fail."""
        cid = self.proposed(self.comment("original text", anchor="FR-001"))
        self.event({"type": "comment_rework", "ref": cid, "text": "not like that"}, code=2, by="session")
        self.event({"type": "comment_rework", "ref": "CM9"}, code=2, by="user", source="page")
        self.assertEqual(self.user({"type": "comment_rework", "ref": cid, "text": " not like that "})["summary"], "reworked CM1")
        comment = self.comments()[0]
        self.assertEqual((comment["state"], comment["proposal"], comment["text"]), ("open", None, "original text"))
        request = self.comment_requests()[0]
        self.assertEqual((request["ref"], request["text"], request["node"]), ("CM1", "not like that", "FR-001"))
        self.event({"type": "comment_rework", "ref": cid}, code=2, by="user", source="page")  # open now
        self.proposed(cid)
        self.user({"type": "comment_rework", "ref": cid})
        self.assertEqual(self.comment_requests()[0]["text"], "original text")
        self.assertEqual(len(self.comment_requests()), 1)
        self.event({"type": "comment_delete", "ref": cid}, code=2, by="session")
        self.assertEqual(self.user({"type": "comment_delete", "ref": cid})["summary"], "deleted CM1")
        self.assertEqual((self.comments(), self.comment_requests()), ([], []))
        done = self.proposed(self.comment("closed one"))
        self.accept(done)
        self.user({"type": "comment_delete", "ref": done})
        self.assertEqual(self.comments(), [])
        self.event({"type": "comment_delete", "ref": done}, code=2, by="user", source="page")

    def test_resolve_refuses_a_comment_request(self):
        """A resolve that drops a comment request orphans an open comment the session can no longer find."""
        cid = self.comment()
        self.event({"type": "resolve", "ref": cid}, code=2)
        self.assertEqual(len(self.comment_requests()), 1)

    # ---- 6. nothing changes before accept

    def test_nodes_and_the_rendered_prd_are_identical_until_accept(self):
        """Any comment/split/triage/rework step that edits a node (or renders a comment into PRD.md) must fail."""
        self.ready()
        before = self.plan()

        def rendered():
            plan = self.plan()
            plan.update(rev=before["rev"], updated=before["updated"])
            return plan["nodes"], prd.render(plan)

        baseline = rendered()
        cid = self.comment("Please add pinned notes to FR-001", author="Dana", anchor="FR-001")
        self.assertEqual(rendered(), baseline)
        parts = self.event({"type": "comment_split", "ref": cid, "parts": [{"text": "pinned notes SECRET"}, {"text": "tags"}]})
        self.assertEqual(rendered(), baseline)
        self.triage("CM2", "accept", "do it", [{"type": "upsert", "node": {"kind": "requirement", "label": "Pinned SECRET"}},
                                              {"type": "set", "field": "tldr", "value": "Changed tldr"}])
        self.assertEqual(rendered(), baseline)
        self.user({"type": "comment_rework", "ref": "CM2"})
        self.assertEqual(rendered(), baseline)
        self.assertNotIn("SECRET", (self.directory / "PRD.md").read_text())
        self.assertNotIn("Dana", (self.directory / "PRD.md").read_text())
        self.assertEqual(parts["rev"], before["rev"] + 2)
        self.proposed("CM2")
        self.accept("CM2")
        self.assertNotEqual(rendered(), baseline)
        self.assertNotIn("Dana", (self.directory / "PRD.md").read_text())

    # ---- 7. plan thread

    def test_nodeless_ask_goes_to_the_plan_thread_and_reply_answers_into_it(self):
        """A nodeless ask that appends nowhere, a reply that is refused (QA1-F1), or links that skip validation must fail."""
        ref = self.user({"type": "ask", "text": " What is blocking the PRD? "})["event"]["id"]
        plan = self.plan()
        self.assertEqual(len(plan["thread"]), 1)
        entry = plan["thread"][0]
        self.assertEqual((entry["role"], entry["text"], entry["ref"], entry["links"]), ("user", "What is blocking the PRD?", ref, []))
        self.assertIn((ref, "ask", None), [(r["ref"], r["type"], r["node"]) for r in plan["requests"]])
        self.assertEqual(plan["recent"][0]["summary"], "asked about plan")
        self.assertTrue(all("thread" not in n for n in plan["nodes"]))
        cid = self.comment()
        bad = ({"links": ["Q7", "Q99"]}, {"links": ["Q7", "CM9"]}, {"links": "Q7"}, {"links": [7]}, {"links": ["Q7"] * 11},
               {"links": ["Q7"] * 10 + ["Q8"]})
        for extra in bad:
            before = self.snapshot()
            self.event(dict(extra, type="reply", ref=ref, text="x"), code=2)
            self.assertEqual(self.snapshot(), before)
        self.event({"type": "reply", "ref": ref, "text": " Q7 and CM1. ", "links": ["Q7", cid]}, by="session")
        plan = self.plan()
        self.assertEqual([(e["role"], e["text"], e["links"]) for e in plan["thread"]],
                         [("user", "What is blocking the PRD?", []), ("session", "Q7 and CM1.", ["Q7", cid])])
        self.assertEqual(plan["thread"][1]["ref"], ref)
        self.assertNotIn(ref, [r["ref"] for r in plan["requests"]])
        self.assertEqual(plan["recent"][0]["summary"], "replied on plan")
        self.event({"type": "reply", "ref": ref, "text": "again"}, code=2)
        self.event({"type": "reply", "ref": ref, "text": "x"}, code=2, by="user")

    def test_reply_links_are_for_plan_replies_only_and_default_empty(self):
        """A node-thread reply that silently drops or stores links, or a plan reply with no links key, must fail."""
        node_ask = self.user({"type": "ask", "text": "why?", "node": "Q7"})["event"]["id"]
        self.event({"type": "reply", "ref": node_ask, "text": "x", "links": ["Q8"]}, code=2)
        self.event({"type": "reply", "ref": node_ask, "text": "because"})
        self.assertEqual(set(self.node("Q7")["thread"][1]), {"role", "text", "at", "ref"})
        plan_ask = self.user({"type": "ask", "text": "overall?"})["event"]["id"]
        self.event({"type": "reply", "ref": plan_ask, "text": "fine"})
        self.assertEqual(self.plan()["thread"][1]["links"], [])

    def test_plan_thread_keeps_the_last_forty_entries(self):
        """A plan thread that grows past 40 or drops the newest entry must fail."""
        plan = self.loaded()
        for i in range(21):
            ref = self.apply(plan, {"type": "ask", "text": f"q{i}"}, by="user") and plan["requests"][-1]["ref"]
            self.apply(plan, {"type": "reply", "ref": ref, "text": f"a{i}"})
        self.assertEqual(len(plan["thread"]), 40)
        self.assertEqual((plan["thread"][0]["text"], plan["thread"][-1]["text"]), ("q1", "a20"))

    def test_removing_a_node_cleans_comments_links_and_keeps_the_users_question(self):
        """A remove that leaves dangling anchors/links, or drops the user's ask with the node's thread (QA1-F1), must fail."""
        ask = self.user({"type": "ask", "text": "Why is FR-004 here?", "node": "FR-004"})["event"]["id"]
        plan_ask = self.user({"type": "ask", "text": "overall?"})["event"]["id"]
        self.event({"type": "reply", "ref": plan_ask, "text": "see FR-004", "links": ["FR-004", "FR-005"]})
        anchored = self.comment("on FR-004", anchor="FR-004")
        other = self.comment("on FR-005", anchor="FR-005")
        self.event({"type": "remove", "node": "FR-004"})
        plan = self.plan()
        by_id = {c["id"]: c for c in plan["comments"]}
        self.assertEqual((by_id[anchored]["anchor"], by_id[other]["anchor"]), (None, "FR-005"))
        self.assertEqual(next(r for r in plan["requests"] if r["ref"] == anchored)["node"], None)
        self.assertEqual(plan["thread"][1]["links"], ["FR-005"])
        self.assertEqual([(e["role"], e["text"], e["ref"], e["links"]) for e in plan["thread"][2:]],
                         [("user", "Why is FR-004 here?", ask, [])])
        self.assertEqual(next(r for r in plan["requests"] if r["ref"] == ask)["node"], None)
        self.event({"type": "reply", "ref": ask, "text": "It was redundant.", "links": ["FR-005"]})
        self.assertEqual(self.plan()["thread"][-1]["text"], "It was redundant.")
        core.validate(self.plan(), strict=True)

    # ---- 8. mirror

    def test_mirror_never_carries_comments_the_plan_thread_or_comment_requests(self):
        """A mirror plan.json that copies the working plan leaks a teammate's name and text into the repo."""
        mirror = Path(self.temp.name) / "mirror"
        self.cli("publish", self.task, "--to", str(mirror))
        self.user({"type": "comment", "text": "Secret remark about FR-001", "author": "Dana Teammate", "anchor": "FR-001"})
        self.user({"type": "ask", "text": "Pane question Wombat"})
        local, public = self.plan(), json.loads((mirror / "plan.json").read_text(encoding="utf-8"))
        for key in ("comments", "thread", "comment_seq"):
            self.assertIn(key, local)
            self.assertNotIn(key, public)
        self.assertEqual([r["type"] for r in public["requests"]], [r["type"] for r in local["requests"] if r["type"] != "comment"])
        self.assertTrue(any(r["type"] == "comment" for r in local["requests"]))
        for name in ("plan.json", "PRD.md"):
            text = (mirror / name).read_text(encoding="utf-8")
            for secret in ("Dana", "Secret remark"):
                self.assertNotIn(secret, text)
        core.validate(public)
        self.assertEqual({k: v for k, v in local.items() if k not in ("comments", "thread", "comment_seq", "requests")},
                         {k: v for k, v in public.items() if k != "requests"})
        self.assertIn("Dana Teammate", (self.directory / "plan.json").read_text(encoding="utf-8"))
        self.cli("render", self.task)
        self.assertNotIn("Dana", (mirror / "plan.json").read_text(encoding="utf-8"))

    def test_mirror_without_comments_is_byte_identical_to_the_working_plan(self):
        """A mirror writer that re-encodes differently for comment-free plans breaks the published plan.json equality."""
        mirror = Path(self.temp.name) / "mirror"
        self.cli("publish", self.task, "--to", str(mirror))
        self.event({"type": "edit_label", "node": "Q7", "label": "Revised policy"})
        self.assertEqual((mirror / "plan.json").read_bytes(), (self.directory / "plan.json").read_bytes())

    # ---- 9. CLI

    def test_news_and_show_print_open_comments_with_author_anchor_and_full_text_and_plan_asks(self):
        """A news/show that hides the comment author, anchor or text, or the pane question, leaves the session blind."""
        text = "Please add pinned notes.\nThey should sync first, before everything else, because 10 pinned notes matter."
        self.user({"type": "comment", "text": text, "author": "Dana K", "anchor": "FR-001"})
        self.user({"type": "ask", "text": "Pane question Wombat"})
        for command in ("show", "news"):
            out = self.cli(command, self.task)
            with self.subTest(command=command):
                self.assertIn("CM1", out)
                self.assertIn("Dana K", out)
                self.assertIn("FR-001", out)
                self.assertIn("Please add pinned notes. They should sync first, before everything else, because 10 pinned notes matter.", out)
                self.assertIn("Pane question Wombat", out)
        self.assertEqual(self.cli("show", self.task, "--json").count("Dana K"), 1)
        news = json.loads(self.cli("news", self.task, "--json"))
        self.assertEqual(news, [])  # cursor moved by the first human news
        self.user({"type": "comment", "text": "Second", "author": "Lee"})
        events = json.loads(self.cli("news", self.task, "--json", "--peek"))
        self.assertEqual([(e["type"], e["comment"], e["author"], e["text"]) for e in events], [("comment", "CM2", "Lee", "Second")])
        self.assertIn("Lee", self.cli("news", self.task, "--peek"))

    def test_news_lists_comment_accept_and_rework_events_without_crashing(self):
        """A human news formatter that assumes every event has a node/text fails on comment_accept."""
        cid = self.proposed()
        self.accept(cid)
        out = self.cli("news", self.task)
        self.assertIn("comment_accept", out)
        self.assertIn("CM1", out)
        self.assertNotIn("Traceback", out)

    def test_show_after_a_comment_was_triaged_has_no_comment_request(self):
        """A show that keeps listing a triaged comment as waiting hides that the user must accept it."""
        cid = self.proposed(self.comment(author="Dana"))
        out = self.cli("show", self.task)
        self.assertNotIn(f"{cid} comment", out)

    def test_every_new_event_type_is_known_to_the_core(self):
        """A new event missing from EVENT_FIELDS is refused as 'Unknown event type' and can never be recorded in recent."""
        for kind in ("comment", "comment_accept", "comment_rework", "comment_delete", "comment_split", "comment_triage"):
            self.assertIn(kind, core.EVENT_FIELDS)
        self.assertEqual({"comment_split", "comment_triage"} & set(core.SESSION_EVENTS), {"comment_split", "comment_triage"})
        self.assertIn("comment", core.REQUEST_TYPES)


if __name__ == "__main__":
    unittest.main()
