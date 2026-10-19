"""GitHub PR review model and events in the plan core (contract 14). Each docstring names the production regression it catches."""
import copy
import json
from pathlib import Path
import sys
import unittest

import test_comments
import test_core
from test_core import HERE, SCRIPTS

sys.path.insert(0, str(SCRIPTS))
import plan_core as core  # noqa: E402
import prd  # noqa: E402

PR = {"repo": "acme/notes", "number": 7, "url": "https://github.com/acme/notes/pull/7", "branch": "prd/offline-sync",
      "head_sha": "0123456789abcdef0123456789abcdef01234567", "prd_rev": 95, "opened_at": "2026-10-17T10:00:00Z",
      "pulled_at": None}
NEW_FIELDS = {"ext", "url", "reply_to", "resolved", "edited", "posted"}


def item(ext="rc:101", **fields):
    return dict({"ext": ext, "author": "Dana", "text": "[FR-001] question: why?", "anchor": "FR-001",
                 "url": "https://github.com/acme/notes/pull/7#discussion_r101"}, **fields)


class ReviewTests(unittest.TestCase):
    setUp = test_core.CoreTests.setUp
    cli = test_core.CoreTests.cli
    event = test_core.CoreTests.event
    plan = test_core.CoreTests.plan
    node = test_core.CoreTests.node
    snapshot = test_core.CoreTests.snapshot
    user = test_comments.CommentTests.user
    comment = test_comments.CommentTests.comment
    triage = test_comments.CommentTests.triage
    proposed = test_comments.CommentTests.proposed
    accept = test_comments.CommentTests.accept
    comments = test_comments.CommentTests.comments
    cli_error = test_comments.CommentTests.cli_error
    comment_requests = test_comments.CommentTests.comment_requests
    loaded = test_comments.CommentTests.loaded
    apply = test_comments.CommentTests.apply

    def review_set(self, value=PR, **kw):
        return self.event({"type": "review_set", "value": value}, **kw)

    def imp(self, *items, **kw):
        return self.event({"type": "comment_import", "items": list(items)}, **kw)

    def by_ext(self, ext):
        return next(c for c in self.comments() if c["ext"] == ext)

    def displayed(self, refs):
        """The proposal rev the page shows on each of these comments (0 where there is none)."""
        byid = {c["id"]: c for c in self.comments()}
        return {ref: (byid[ref]["proposal"] or {}).get("rev", 0) if ref in byid else 0 for ref in refs}

    def review(self, action, code=0, **fields):
        if action == "post" and isinstance(fields.get("refs"), list) and "proposals" not in fields:
            fields["proposals"] = self.displayed(fields["refs"])  # the page sends the proposal rev it shows with a Post click
        return self.event(dict(fields, type="review", action=action), code=code, by="user", source="page")

    def review_requests(self):
        return [r for r in self.plan()["requests"] if r["type"] == "review"]

    def refused_and_unchanged(self, event, **kw):
        before = self.snapshot()
        self.event(event, code=2, **kw)
        self.assertEqual(self.snapshot(), before)

    # ---- 1. old comments still load

    def test_comments_written_without_the_new_fields_still_validate_and_new_paste_comments_stay_as_they_were(self):
        """A validator that demands the seven new comment fields rejects every plan C1 already wrote."""
        self.comment()
        self.assertFalse(NEW_FIELDS & set(self.comments()[0]))
        self.cli("show", self.task)
        self.imp(item())
        self.assertEqual(set(self.comments()[1]) & NEW_FIELDS, NEW_FIELDS)  # an imported comment carries all seven
        core.validate(self.plan(), strict=True)

    def test_hand_edited_malformed_review_comment_fields_are_rejected_on_load(self):
        """A loader that skips the closed checks on the new comment fields lets a forged ext, link or posted record in."""
        self.imp(item())
        good = self.plan()
        link = "https://github.com/acme/notes/pull/7#x"
        bad_edits = [
            lambda p: p["comments"][0].update(extra=1),
            lambda p: p["comments"][0].update(source="chat"),
            lambda p: p["comments"][0].update(source="paste"),  # ext set but not github
            lambda p: p["comments"][0].update(ext=None),  # github without ext
            lambda p: p["comments"][0].update(ext="rc:abc"), lambda p: p["comments"][0].update(ext="xx:1"),
            lambda p: p["comments"][0].update(ext=5),
            lambda p: p["comments"][0].update(url="javascript:alert(1)"), lambda p: p["comments"][0].update(url="http://x.test"),
            lambda p: p["comments"][0].update(url="https://x.test/a b"), lambda p: p["comments"][0].update(url=None),
            lambda p: p["comments"][0].update(reply_to="nope"), lambda p: p["comments"][0].update(reply_to=7),
            lambda p: p["comments"][0].update(resolved="no"), lambda p: p["comments"][0].update(edited=1),
            lambda p: p["comments"][0].update(posted={"at": "2026-10-17T10:00:00Z", "url": link}),
            lambda p: p["comments"][0].update(posted={"at": "bad", "url": link, "ext": "rc:9"}),
            lambda p: p["comments"][0].update(posted={"at": "2026-10-17T10:00:00Z", "url": "http://x", "ext": "rc:9"}),
            lambda p: p["comments"][0].update(posted={"at": "2026-10-17T10:00:00Z", "url": link, "ext": "rc:9", "x": 1}),
            lambda p: p["comments"][0].update(posted="yes"),
            lambda p: p["comments"].append(dict(copy.deepcopy(p["comments"][0]), id="CM2")),  # duplicate ext
            lambda p: p.update(review_pr="x"), lambda p: p.update(review_pr=dict(PR, extra=1)),
            lambda p: p.update(review_pr=dict(PR, repo="nonsense")), lambda p: p.update(review_pr=dict(PR, number=0)),
            lambda p: p.update(review_pr=dict(PR, number=True)), lambda p: p.update(review_pr=dict(PR, url="http://x.test/1")),
            lambda p: p.update(review_pr=dict(PR, head_sha="abc")), lambda p: p.update(review_pr=dict(PR, head_sha="G" * 40)),
            lambda p: p.update(review_pr=dict(PR, branch="")), lambda p: p.update(review_pr=dict(PR, branch="a b")),
            lambda p: p.update(review_pr=dict(PR, prd_rev=p["rev"] + 1)), lambda p: p.update(review_pr=dict(PR, prd_rev="1")),
            lambda p: p.update(review_pr=dict(PR, opened_at="yesterday")), lambda p: p.update(review_pr=dict(PR, pulled_at="x")),
        ]
        for edit in bad_edits:
            plan = copy.deepcopy(good)
            edit(plan)
            with self.assertRaises(core.PlanError):
                core.validate(plan)
        for edit in (lambda p: p.update(review_pr=PR), lambda p: p.update(review_pr=None),
                     lambda p: p["comments"][0].update(resolved=True, edited=True, reply_to="rc:100",
                                                       posted={"at": "2026-10-17T10:00:00Z", "url": link, "ext": "rc:55"})):
            plan = copy.deepcopy(good)
            edit(plan)
            core.validate(plan, strict=True)

    # ---- 2. review_set

    def test_review_set_stores_clears_and_is_session_only(self):
        """A review_set a page user can send, or one that cannot clear the record, must fail."""
        response = self.review_set()
        self.assertEqual(response["summary"], "review PR set")
        self.assertEqual(self.plan()["review_pr"], PR)
        self.assertEqual(self.review_set(dict(PR, pulled_at="2026-10-17T11:00:00Z", prd_rev=96))["rev"], 97)
        self.assertEqual(self.plan()["review_pr"]["pulled_at"], "2026-10-17T11:00:00Z")
        self.refused_and_unchanged({"type": "review_set", "value": PR}, by="user", source="page")
        self.assertEqual(self.review_set(None)["summary"], "review PR cleared")
        self.assertNotIn("review_pr", self.plan())

    def test_review_set_refuses_every_malformed_record_and_changes_nothing(self):
        """A review_set that stores a shell-looking repo, a non-https url, a short sha or a missing key must fail."""
        invalid = [
            "x", 5, [], {}, dict(PR, repo="nonsense"), dict(PR, repo="a/b/c"), dict(PR, repo="a b/c"), dict(PR, repo="/x"),
            dict(PR, number=0), dict(PR, number=-1), dict(PR, number="7"), dict(PR, number=7.0), dict(PR, number=True),
            dict(PR, url="http://github.com/x"), dict(PR, url="git@github.com:a/b"), dict(PR, url="javascript:1"),
            dict(PR, url="https://x.test/a b"), dict(PR, url=7),
            dict(PR, branch=""), dict(PR, branch="a b"), dict(PR, branch="-x"), dict(PR, branch="a..b"), dict(PR, branch="a;rm"),
            dict(PR, branch="x" * 201),
            dict(PR, head_sha="abc"), dict(PR, head_sha="G" * 40), dict(PR, head_sha="A" * 40), dict(PR, head_sha="a" * 41),
            dict(PR, prd_rev=-1), dict(PR, prd_rev=100), dict(PR, prd_rev="1"), dict(PR, prd_rev=True),
            dict(PR, opened_at="yesterday"), dict(PR, opened_at=None), dict(PR, pulled_at="x"), dict(PR, pulled_at=5),
            dict(PR, extra=1), {k: v for k, v in PR.items() if k != "head_sha"}, dict(PR, repo="a/b\x1b[0m"),
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.refused_and_unchanged({"type": "review_set", "value": value})
        self.refused_and_unchanged({"type": "review_set"})
        self.assertEqual(self.review_set()["summary"], "review PR set")  # the refusals above are for the value, not the event

    def test_review_set_branch_must_be_the_plans_own_prd_branch(self):
        """A review_set naming main (or another plan's branch) lets `push` write a PRD commit onto a branch the owner never meant."""
        for branch in ("main", "master", "prd/other-plan", "prd/offline-sync/x", "prd/offline-sync2", "feature/offline-sync"):
            with self.subTest(branch=branch):
                self.refused_and_unchanged({"type": "review_set", "value": dict(PR, branch=branch)})
        self.assertEqual(self.review_set(dict(PR, branch="prd/offline-sync"))["summary"], "review PR set")

    def test_repo_names_with_dot_segments_are_refused(self):
        """A repo like x/.. or ../x is a path, not an owner/name, once it reaches gh api URLs."""
        for repo in ("x/..", "x/.", "../x", "./x", "a/b/c"):
            with self.subTest(repo=repo):
                self.refused_and_unchanged({"type": "review_set", "value": dict(PR, repo=repo)})
        self.assertEqual(self.review_set(dict(PR, repo="a.b/c..d", url="https://github.com/a.b/c..d/pull/7"))["summary"], "review PR set")

    def test_review_pr_fields_that_pick_the_target_cannot_change_while_a_pr_is_recorded(self):
        """A session that retargets repo/number/url/branch/opened_at sends the owner's next Post click to repos/evil/target/pulls/99."""
        self.review_set()
        evil = "https://github.com/evil/target/pull/99"
        cases = {"repo": dict(PR, repo="evil/target", url="https://github.com/evil/target/pull/7"),
                 "number": dict(PR, number=99, url="https://github.com/acme/notes/pull/99"),
                 "opened_at": dict(PR, opened_at="2026-10-18T10:00:00Z"),
                 "everything": dict(PR, repo="evil/target", number=99, url=evil, opened_at="2026-10-18T10:00:00Z")}
        for name, value in cases.items():
            with self.subTest(changed=name):
                self.refused_and_unchanged({"type": "review_set", "value": value})
        self.assertEqual(self.plan()["review_pr"], PR)
        later = self.review_set(dict(PR, head_sha="f" * 40, prd_rev=96, pulled_at="2026-10-18T11:00:00Z"))  # the CLI's own writes still work
        self.assertEqual(later["summary"], "review PR set")
        self.assertEqual(self.plan()["review_pr"], dict(PR, head_sha="f" * 40, prd_rev=96, pulled_at="2026-10-18T11:00:00Z"))
        self.review_set(None)
        self.assertEqual(self.review_set(dict(PR, repo="evil/target", number=99, url="https://github.com/evil/target/pull/99"))["summary"],
                         "review PR set")  # clearing is the only way to point at another PR

    def test_review_pr_url_must_be_the_github_pull_link_of_its_own_repo_and_number(self):
        """A url the page links as 'the PR' that points at another repo, host, number or path sends the owner somewhere else."""
        for url in ("https://evil.test/acme/notes/pull/7", "https://github.com/acme/other/pull/7", "https://github.com/acme/notes/pull/8",
                    "https://github.com/acme/notes/pull/7/files", "https://github.com/acme/notes/pull/7?x=1", "https://github.com/acme/notes/pull/7#c",
                    "https://github.com.evil.test/acme/notes/pull/7", "https://github.com/acme/notes/issues/7"):
            with self.subTest(url=url):
                self.refused_and_unchanged({"type": "review_set", "value": dict(PR, url=url)})
        plan = self.loaded()
        plan["review_pr"] = dict(PR, url="https://github.com/acme/other/pull/7")
        with self.assertRaises(core.PlanError):
            core.validate(plan)
        self.assertEqual(self.review_set()["summary"], "review PR set")

    def test_only_github_links_are_kept_for_imported_comments_and_posted_replies(self):
        """The page labels these links GitHub: an import whose url points at any other https site would send the owner to it."""
        self.imp(item("rc:1", url="https://evil.test/phish"), item("rc:2", url="https://github.com.evil.test/x"),
                 item("rc:3", url="https://github.com/acme/notes/pull/7#discussion_r3"))
        by = {c["ext"]: c for c in self.comments()}
        self.assertEqual((by["rc:1"]["url"], by["rc:2"]["url"]), ("", ""))
        self.assertEqual(by["rc:3"]["url"], "https://github.com/acme/notes/pull/7#discussion_r3")
        self.refused_and_unchanged({"type": "comment_posted", "ref": "CM1", "url": "https://evil.test/1", "ext": "rc:9"})

    # ---- 3. comment_import

    def test_import_creates_open_github_comments_with_requests_and_a_name_free_summary(self):
        """An import that skips the request, leaks the name/text into the summary, or loses a field must fail."""
        response = self.imp(item(), item("rv:5", author="Lee K", text="General remark", anchor="§9", url="", reply_to="rc:101",
                                         resolved=True, path="docs/prd/offline-sync/PRD.md", line=12))
        self.assertEqual(response["summary"], "imported 2 comments (2 new)")
        plan = self.plan()
        first, second = plan["comments"]
        self.assertEqual({k: v for k, v in first.items() if k != "at"},
                         {"id": "CM1", "author": "Dana", "text": "[FR-001] question: why?", "anchor": "FR-001", "state": "open",
                          "source": "github", "proposal": None, "ext": "rc:101",
                          "url": "https://github.com/acme/notes/pull/7#discussion_r101", "reply_to": None,
                          "resolved": False, "edited": False, "posted": None})
        self.assertEqual({k: second[k] for k in ("id", "author", "anchor", "ext", "url", "reply_to", "resolved", "state")},
                         {"id": "CM2", "author": "Lee K", "anchor": "§9", "ext": "rv:5", "url": "", "reply_to": "rc:101",
                          "resolved": True, "state": "open"})
        self.assertNotIn("path", second)
        self.assertEqual([(r["ref"], r["node"], r["text"]) for r in self.comment_requests()],
                         [("CM1", "FR-001", "[FR-001] question: why?"), ("CM2", None, "General remark")])
        self.assertEqual(plan["comment_seq"], 2)
        self.assertNotIn("Dana", json.dumps(plan["recent"]))
        self.assertNotIn("General", json.dumps(plan["recent"]))
        stored = response["event"]["items"]
        self.assertEqual([i["ext"] for i in stored], ["rc:101", "rv:5"])

    def test_import_is_idempotent_by_ext(self):
        """An import that creates a second comment for a known ext duplicates the whole review on every pull."""
        self.imp(item(), item("ic:9", text="Looks fine"))
        self.assertEqual(self.imp(item(), item("ic:9", text="Looks fine"))["summary"], "imported 2 comments (0 new)")
        self.assertEqual([c["ext"] for c in self.comments()], ["rc:101", "ic:9"])
        self.assertEqual(len(self.comment_requests()), 2)
        self.assertEqual(self.imp(item(), item("ic:10", text="New"))["summary"], "imported 2 comments (1 new)")
        self.assertEqual([c["id"] for c in self.comments()], ["CM1", "CM2", "CM3"])
        self.assertFalse(self.comments()[0]["edited"])

    def test_deleting_or_splitting_a_github_comment_remembers_its_ext_so_an_import_skips_it(self):
        """A forgotten ext makes the next pull import a deleted or split GitHub comment again, with its original body, as a new open comment."""
        plan = self.loaded()
        self.apply(plan, {"type": "comment_import", "items": [item("rc:1"), item("rc:2"), item("ic:3")]})
        self.apply(plan, {"type": "comment", "text": "pasted"}, by="user")
        self.apply(plan, {"type": "comment_delete", "ref": "CM1"}, by="user")
        self.apply(plan, {"type": "comment_split", "ref": "CM2", "parts": [{"text": "first half"}, {"text": "second half"}]})
        self.apply(plan, {"type": "comment_delete", "ref": "CM4"}, by="user")  # a paste comment has no ext to remember
        self.assertEqual(plan["ext_dropped"], ["rc:1", "rc:2"])
        parts = [c for c in plan["comments"] if c["text"] in ("first half", "second half")]
        self.assertEqual([(c["source"], c.get("ext")) for c in parts], [("paste", None), ("paste", None)])
        core.validate(plan, strict=True)
        before = copy.deepcopy(plan["comments"])
        self.assertEqual(self.apply(plan, {"type": "comment_import", "items": [item("rc:1"), item("rc:2"), item("ic:3")]}),
                         "imported 1 comments (0 new)")  # only ic:3 is still a GitHub comment of ours
        self.assertEqual(plan["comments"], before)

    def test_deleting_a_comment_we_replied_to_remembers_the_reply_ext_so_a_pull_does_not_import_our_reply(self):
        """A deleted comment takes posted.ext with it, so the next pull imports the owner's own reply as a teammate comment."""
        plan = self.loaded()
        self.apply(plan, {"type": "comment_import", "items": [item("rc:1")]})
        self.apply(plan, {"type": "comment_posted", "ref": "CM1", "url": "https://github.com/acme/notes/pull/7#discussion_r900", "ext": "rc:900"})
        self.apply(plan, {"type": "comment_delete", "ref": "CM1"}, by="user")
        self.assertEqual(plan["ext_dropped"], ["rc:1", "rc:900"])
        self.assertEqual(self.apply(plan, {"type": "comment_import", "items": [item("rc:900", text="our reply")]}), "imported 0 comments (0 new)")
        self.assertEqual(plan["comments"], [])

    def test_a_dropped_ext_does_not_count_toward_the_comment_cap(self):
        """A dropped ext counted as new makes a PR with more than 100 comments unpullable after the owner deletes closed ones."""
        plan = self.loaded()
        for n in range(97):
            self.apply(plan, {"type": "comment", "text": f"c{n}"}, by="user")
        plan["ext_dropped"] = ["rc:1", "rc:2", "rc:3"]
        items = [item(f"rc:{n}") for n in range(1, 7)]  # rc:1-3 were deleted before, rc:4-6 are new
        self.assertEqual(self.apply(plan, {"type": "comment_import", "items": items}), "imported 3 comments (3 new)")
        self.assertEqual(len(plan["comments"]), 100)

    def test_ext_dropped_keeps_the_newest_thousand_and_rejects_malformed_values(self):
        """An unbounded list grows plan.json past the 2 MB cap; a hand-edited non-ext value must not load."""
        plan = self.loaded()
        plan["ext_dropped"] = [f"rc:{n}" for n in range(1000)]
        core.validate(plan, strict=True)
        self.apply(plan, {"type": "comment_import", "items": [item("rc:5000")]})
        self.apply(plan, {"type": "comment_delete", "ref": plan["comments"][0]["id"]}, by="user")
        self.assertEqual((len(plan["ext_dropped"]), plan["ext_dropped"][0], plan["ext_dropped"][-1]), (1000, "rc:1", "rc:5000"))
        for bad in ("rc:1", [5], ["xx:1"], ["rc:1", "rc:1"], [f"rc:{n}" for n in range(1001)], None):
            with self.subTest(bad=str(bad)[:30]):
                broken = self.loaded()
                broken["ext_dropped"] = bad
                with self.assertRaises(core.PlanError):
                    core.validate(broken)

    def test_the_mirror_and_the_review_branch_do_not_carry_ext_dropped(self):
        """A published plan.json with the owner's dropped GitHub ids tells teammates which of their comments were deleted."""
        plan = self.loaded()
        plan["ext_dropped"] = ["rc:1"]
        self.assertNotIn("ext_dropped", core.public_plan(plan))
        self.assertNotIn("ext_dropped", core.review_plan(plan))

    def test_import_text_change_updates_and_marks_edited_per_state(self):
        """An edit that resets an accepted comment, or leaves a proposed one proposing stale text, must fail."""
        self.imp(item("rc:1", text="open one"), item("rc:2", text="to be proposed"), item("rc:3", text="to be accepted"),
                 item("rc:4", text="to be answered"), item("rc:5", text="to be declined"))
        self.triage("CM2", "answer", "Because")
        self.proposed("CM3", changes=[{"type": "edit_label", "node": "FR-004", "label": "Sync retries"}])
        self.accept("CM3")
        self.triage("CM4", "answer", "Because")
        self.accept("CM4")
        self.triage("CM5", "decline", "No")
        self.accept("CM5")
        before = {c["ext"]: c["state"] for c in self.comments()}
        self.assertEqual(before, {"rc:1": "open", "rc:2": "proposed", "rc:3": "accepted", "rc:4": "answered", "rc:5": "declined"})
        proposal3 = self.by_ext("rc:3")["proposal"]
        response = self.imp(*(item(f"rc:{n}", text=f"edited {n}") for n in range(1, 6)))
        self.assertEqual(response["summary"], "imported 5 comments (0 new)")
        after = {c["ext"]: c for c in self.comments()}
        self.assertEqual({e: c["state"] for e, c in after.items()},
                         {"rc:1": "open", "rc:2": "open", "rc:3": "accepted", "rc:4": "answered", "rc:5": "declined"})
        self.assertEqual({e: (c["text"], c["edited"]) for e, c in after.items()},
                         {f"rc:{n}": (f"edited {n}", True) for n in range(1, 6)})
        self.assertIsNone(after["rc:2"]["proposal"])
        self.assertEqual(after["rc:3"]["proposal"], proposal3)
        requests = {r["ref"]: r["text"] for r in self.comment_requests()}
        self.assertEqual(requests, {"CM1": "edited 1", "CM2": "edited 2"})  # CM2 has a new request, CM1's carries the new text

    def test_import_text_change_drops_the_gist_but_a_resolved_flip_keeps_it(self):
        """A gist that outlives an edit on GitHub shows the session's reading of words the comment no longer has."""
        self.imp(item("rc:1", text="old wording"))
        self.triage("CM1", "answer", "Because", gist="Asks about the old wording.")
        self.imp(item("rc:1", text="old wording", resolved=True))
        self.assertEqual(self.comments()[0]["gist"], "Asks about the old wording.")
        self.imp(item("rc:1", text="new wording", resolved=True))
        self.assertNotIn("gist", self.comments()[0])

    def test_import_resolved_change_updates_the_flag_only(self):
        """A resolved flip that also marks the comment edited or reopens its state must fail."""
        self.imp(item())
        self.triage("CM1", "answer", "Because")
        self.imp(item(resolved=True))
        comment = self.comments()[0]
        self.assertEqual((comment["resolved"], comment["edited"], comment["state"], comment["text"]),
                         (True, False, "proposed", "[FR-001] question: why?"))
        self.imp(item(resolved=False))
        self.assertFalse(self.comments()[0]["resolved"])

    def test_import_skips_our_own_posted_replies(self):
        """A pull that re-imports the reply we posted shows our own words back as a new teammate comment."""
        self.imp(item())
        self.triage("CM1", "answer", "Because")
        self.accept("CM1")
        self.event({"type": "comment_posted", "ref": "CM1", "url": "https://github.com/acme/notes/pull/7#discussion_r102",
                    "ext": "rc:102"})
        response = self.imp(item(), item("rc:102", author="dana", text="Because", reply_to="rc:101"))
        self.assertEqual(response["summary"], "imported 1 comments (0 new)")
        self.assertEqual([c["ext"] for c in self.comments()], ["rc:101"])

    def test_import_normalises_text_author_anchor_and_url_without_refusing(self):
        """An import refused for CRLF, a ZWJ emoji, an unknown node id or a long body loses the whole review."""
        long_text = "x" * 6000
        response = self.imp(
            item("rc:1", text="line one\r\nline two\rline three ‍\x07ok\t.", author="Dana \n K‮"),
            item("rc:2", text=long_text, anchor="FR-404"), item("rc:3", anchor="§19", url="javascript:alert(1)"),
            item("rc:4", anchor="§18"),
            item("rc:5", text="y" * 5000), item("rc:6", author="a" * 120), item("rc:7", text="   \n "))
        self.assertEqual(response["summary"], "imported 6 comments (6 new)")
        by = {c["ext"]: c for c in self.comments()}
        self.assertEqual(by["rc:1"]["text"], "line one\nline two\nline three ok\t.")
        self.assertEqual(by["rc:1"]["author"], "Dana K")
        self.assertEqual(len(by["rc:2"]["text"]), 5000)
        self.assertTrue(by["rc:2"]["text"].endswith("x [truncated]"), by["rc:2"]["text"][-20:])
        self.assertEqual(by["rc:2"]["anchor"], None)
        self.assertEqual((by["rc:3"]["anchor"], by["rc:3"]["url"]), (None, ""))
        self.assertEqual(by["rc:4"]["anchor"], "§18")
        self.assertEqual(by["rc:5"]["text"], "y" * 5000)  # exactly at the cap: not truncated
        self.assertEqual(len(by["rc:6"]["author"]), 80)
        self.assertNotIn("rc:7", by)
        core.validate(self.plan(), strict=True)

    def test_import_refuses_malformed_input_and_session_only(self):
        """An import a page user can send, or one that accepts a shell-looking ext or a stray key, must fail."""
        self.refused_and_unchanged({"type": "comment_import", "items": [item()]}, by="user", source="page")
        bad = [None, "x", [], {}, [item()] * 0, [5], ["x"], [item(ext="")], [item(ext="rc:")], [item(ext="rc:1 x")],
               [item(ext="zz:1")], [item(ext=None)], [item(ext=5)], [{k: v for k, v in item().items() if k != "ext"}],
               [item(extra=1)], [item(author=5)], [item(text=5)], [{k: v for k, v in item().items() if k != "text"}],
               [item(resolved="yes")], [item(reply_to="nope")], [item(reply_to=5)], [item(url=5)], [item(line="x")],
               [item(path=5)], [item(), item("ic:1", text=None)],
               [item(f"rc:{n}") for n in range(51)]]
        for items in bad:
            with self.subTest(items=str(items)[:60]):
                self.refused_and_unchanged({"type": "comment_import", "items": items})
        self.refused_and_unchanged({"type": "comment_import"})
        self.assertEqual(self.imp(*(item(f"rc:{n}") for n in range(50)))["summary"], "imported 50 comments (50 new)")

    def test_import_over_the_comment_cap_refuses_the_whole_event(self):
        """An import that writes the first items before hitting the 100 cap leaves a half-imported review."""
        plan = self.loaded()
        for i in range(96):
            self.apply(plan, {"type": "comment", "text": f"c{i}"}, by="user")
        before = copy.deepcopy(plan)
        items = [item(f"rc:{n}") for n in range(5)]
        with self.assertRaisesRegex(core.PlanError, "delete closed comments"):
            self.apply(plan, {"type": "comment_import", "items": items})
        self.assertEqual(plan, before)
        self.assertEqual(self.apply(plan, {"type": "comment_import", "items": items[:4]}), "imported 4 comments (4 new)")
        self.assertEqual(len(plan["comments"]), 100)
        self.apply(plan, {"type": "comment_import", "items": items[:4]})  # known ext: no new comment, so no cap hit
        with self.assertRaisesRegex(core.PlanError, "delete closed comments"):
            self.apply(plan, {"type": "comment_import", "items": [item("rc:99")]})

    # ---- 4. review

    def test_review_open_needs_a_repo_and_no_pr_yet_and_writes_one_request(self):
        """An open that works with a PR already recorded or without a repo opens a second PR / pushes to nowhere."""
        response = self.review("open")
        self.assertEqual(response["summary"], "review requested: open")
        request = self.review_requests()[0]
        self.assertEqual({k: v for k, v in request.items() if k != "at"},
                         {"ref": response["event"]["id"], "type": "review", "node": None, "lane": None, "text": "open"})
        plan = self.loaded()
        plan["repo"] = None
        with self.assertRaisesRegex(core.PlanError, "repo"):
            self.apply(plan, {"type": "review", "action": "open"}, by="user")
        self.assertEqual(plan["requests"], self.loaded()["requests"])
        self.review_set()
        self.review("open", code=2)

    def test_push_pull_post_need_a_review_pr(self):
        """A push/pull/post accepted with no review PR sends the review CLI at a PR that does not exist."""
        self.imp(item())
        self.triage("CM1", "answer", "Because")
        for action, extra in (("push", {}), ("pull", {}), ("post", {"refs": ["CM1"]})):
            with self.subTest(action=action):
                before = self.snapshot()
                self.review(action, code=2, **extra)
                self.assertEqual(self.snapshot(), before)
        self.review_set()
        self.assertEqual(self.review("push")["summary"], "review requested: push")
        self.assertEqual(self.review("pull")["summary"], "review requested: pull")
        self.assertEqual(self.review("post", refs=["CM1"])["summary"], "review requested: post CM1")
        self.assertEqual([r["text"] for r in self.review_requests()], ["push", "pull", "post CM1"])

    def test_review_is_user_only_and_validates_action_and_refs_shape(self):
        """A review a session can send, or a refs list on a push, lets the session authorise its own outward action."""
        self.review_set()
        self.imp(item())
        self.triage("CM1", "answer", "Because")
        self.refused_and_unchanged({"type": "review", "action": "push"})  # by session
        for fields in ({"action": "merge"}, {"action": None}, {}, {"action": "push", "refs": ["CM1"]},
                       {"action": "push", "refs": []}, {"action": "post"}, {"action": "post", "refs": []},
                       {"action": "post", "refs": "CM1"}, {"action": "post", "refs": [1]}, {"action": "post", "refs": ["CM1", "CM1"]},
                       {"action": "post", "refs": [f"CM{n}" for n in range(1, 22)]}, {"action": "post", "refs": ["CM9"]}):
            with self.subTest(fields=fields):
                self.refused_and_unchanged(dict(fields, type="review"), by="user", source="page")

    def test_review_from_a_terminal_or_build_source_is_refused_even_by_user(self):
        """A session typing `--by user --source terminal` would authorise its own outward gh/git action."""
        self.review_set()
        before = self.snapshot()
        for source in ("terminal", "build"):
            self.event({"type": "review", "action": "pull"}, code=2, by="user", source=source)
        self.assertEqual(self.snapshot(), before)
        self.review("pull")
        self.assertEqual(self.review_requests()[0]["text"], "pull")

    def test_post_requires_github_comments_with_a_reply_that_are_not_posted_yet(self):
        """A post of a paste comment, an open one, a declined-without-text one or one already posted sends the wrong thing to GitHub."""
        self.review_set()
        self.imp(item("rc:1"), item("rc:2"), item("rc:3"), item("rc:4"))
        paste = self.comment("pasted")
        self.triage("CM1", "answer", "Because")  # proposed answer: postable
        self.proposed("CM3", changes=[{"type": "edit_label", "node": "FR-004", "label": "Sync retries"}])  # accept proposal, no text yet
        self.proposed(paste, action="answer", text="reply to a paste comment")
        self.review("post", code=2, refs=["CM2"])  # open, no proposal
        self.review("post", code=2, refs=[paste])  # not from github
        self.review("post", code=2, refs=["CM1", "CM2"])  # one bad ref refuses the whole request
        self.review("post", code=2, refs=["CM3"])  # proposed accept: state is not accepted yet
        self.accept("CM3")
        self.assertEqual(self.review("post", refs=["CM1", "CM3"])["summary"], "review requested: post CM1,CM3")
        self.event({"type": "comment_posted", "ref": "CM1", "url": "https://github.com/acme/notes/pull/7#discussion_r9", "ext": "rc:9"})
        self.review("post", code=2, refs=["CM1"])  # already posted
        self.assertEqual(self.review("post", refs=["CM3"])["summary"], "review requested: post CM3")

    def test_identical_pending_review_request_is_a_noop_with_the_same_summary(self):
        """A double click that queues two pulls wakes the session twice and runs the outward call twice."""
        self.review_set()
        first = self.review("pull")
        second = self.review("pull")
        self.assertEqual(second["summary"], first["summary"])
        self.assertEqual([r["ref"] for r in self.review_requests()], [first["event"]["id"]])
        self.review("push")
        self.assertEqual([r["text"] for r in self.review_requests()], ["pull", "push"])  # a different action is a new request
        self.event({"type": "resolve", "ref": first["event"]["id"]})
        self.assertEqual([r["text"] for r in self.review_requests()], ["push"])
        self.review("pull")  # no longer pending: queued again
        self.assertEqual([r["text"] for r in self.review_requests()], ["push", "pull"])
        self.imp(item("rc:1"), item("rc:2"))
        self.triage("CM1", "answer", "a")
        self.triage("CM2", "answer", "b")
        self.review("post", refs=["CM1", "CM2"])
        self.review("post", refs=["CM1"])
        self.assertEqual([r["text"] for r in self.review_requests()], ["push", "pull", "post CM1"])  # see the re-click test below

    def test_a_new_post_click_replaces_the_open_post_request_that_names_the_same_comments(self):
        """A refused post leaves its request open and the old click in force: the owner can neither refresh the click nor change the refs."""
        self.review_set()
        self.imp(item("rc:1"), item("rc:2"), item("rc:3"))
        for n in (1, 2, 3):
            self.triage(f"CM{n}", "answer", f"a{n}")
        first = self.review("post", refs=["CM1", "CM2"])["event"]["id"]
        other = self.review("post", refs=["CM3"])["event"]["id"]
        same = self.review("post", refs=["CM1", "CM2"])  # the same line again: a new click, not a no-op
        self.assertEqual([(r["text"], r["ref"]) for r in self.review_requests()], [("post CM3", other), ("post CM1,CM2", same["event"]["id"])])
        self.assertNotEqual(same["event"]["id"], first)
        self.review("post", refs=["CM2"])  # overlaps the open CM1,CM2 request: it replaces it whole
        self.assertEqual([r["text"] for r in self.review_requests()], ["post CM3", "post CM2"])

    def test_post_click_binds_to_the_proposal_the_page_displayed(self):
        """A Post click that names only comment ids posts whatever proposal the session swapped in before the click landed."""
        self.review_set()
        self.imp(item("rc:1"), item("rc:2"))
        self.triage("CM1", "answer", "reply A")
        self.triage("CM2", "answer", "other reply")
        seen = self.displayed(["CM1", "CM2"])
        self.event({"type": "comment_rework", "ref": "CM1"}, by="user", source="page")
        self.triage("CM1", "answer", "reply B")  # replaces A before the owner's click arrives
        self.assertNotEqual(self.displayed(["CM1"])["CM1"], seen["CM1"])
        before = self.snapshot()
        for proposals, why in ((seen, "the displayed rev of CM1 is stale"), ({"CM1": seen["CM1"]}, "CM2 has no displayed rev"),
                               (dict(seen, CM1=True), "a bool is not a rev"), (dict(seen, CM1=str(seen["CM1"])), "a text rev"),
                               ({**seen, "CM3": 1}, "a ref the click does not name"), (None, "no proposals"), ([], "a list")):
            with self.subTest(why=why):
                fields = {"refs": ["CM1", "CM2"]} | ({} if proposals is None else {"proposals": proposals})
                self.event(dict(fields, type="review", action="post"), code=2, by="user", source="page")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.review("post", refs=["CM1", "CM2"], proposals=self.displayed(["CM1", "CM2"]))["summary"],
                         "review requested: post CM1,CM2")
        self.review("push", proposals={"CM1": 1}, code=2)  # proposals apply only to post

    def test_stale_post_click_names_the_reload(self):
        """A refusal that does not say the proposal changed leaves the owner clicking Post again on the same stale card."""
        self.review_set()
        self.imp(item("rc:1"))
        self.triage("CM1", "answer", "reply A")
        stale = self.displayed(["CM1"])
        self.event({"type": "comment_rework", "ref": "CM1"}, by="user", source="page")
        self.triage("CM1", "answer", "reply B")
        result = self.cli_error({"type": "review", "action": "post", "refs": ["CM1"], "proposals": stale})
        self.assertIn("The proposal changed; reload the page", result)

    def test_resolve_closes_a_review_request_and_still_refuses_a_comment_request(self):
        """A resolve that refuses review requests leaves the review CLI unable to close what it served."""
        self.review_set()
        ref = self.review("push")["event"]["id"]
        cid = self.comment()
        self.event({"type": "resolve", "ref": cid}, code=2)
        self.assertEqual(self.event({"type": "resolve", "ref": ref})["summary"], f"resolved {ref}")
        self.assertEqual(self.review_requests(), [])
        self.assertEqual(len(self.comment_requests()), 1)

    # ---- 5. comment_posted

    def test_comment_posted_sets_posted_once_and_is_session_only(self):
        """A second post that overwrites the first, or a user-sendable comment_posted, forges the audit of what went to GitHub."""
        self.imp(item())
        url = "https://github.com/acme/notes/pull/7#discussion_r102"
        self.refused_and_unchanged({"type": "comment_posted", "ref": "CM1", "url": url, "ext": "rc:102"}, by="user", source="page")
        response = self.event({"type": "comment_posted", "ref": "CM1", "url": url, "ext": "rc:102"})
        self.assertEqual(response["summary"], "posted reply on CM1")
        self.assertEqual(self.comments()[0]["posted"], {"at": response["event"]["at"], "url": url, "ext": "rc:102"})
        for event in ({"ref": "CM1", "url": url, "ext": "rc:103"}, {"ref": "CM9", "url": url, "ext": "rc:103"}):
            self.refused_and_unchanged(dict(event, type="comment_posted"))
        self.imp(item("rc:2"))
        for fields in ({"url": "http://x.test", "ext": "rc:5"}, {"url": url, "ext": "bad"}, {"url": url, "ext": "rv:5"},
                       {"url": url}, {"ext": "rc:5"}, {"url": 5, "ext": "rc:5"}, {"url": url + " x", "ext": "rc:5"}):
            with self.subTest(fields=fields):
                self.refused_and_unchanged(dict(fields, type="comment_posted", ref="CM2"))

    def test_comment_posted_works_on_a_comment_that_had_none_of_the_new_fields(self):
        """A posted that needs the other six fields present breaks on a comment created before them."""
        self.review_set()
        self.imp(item())
        self.event({"type": "comment_posted", "ref": "CM1", "url": "https://github.com/acme/notes/pull/7#issuecomment-1", "ext": "ic:1"})
        core.validate(self.plan(), strict=True)

    # ---- 6. nothing in the nodes or PRD.md changes

    def test_nodes_and_prd_md_are_byte_identical_across_every_review_event(self):
        """Any review event that edits a node or renders a teammate's text or the PR into PRD.md must fail."""
        before = self.plan()

        def rendered():
            plan = self.plan()
            plan.update(rev=before["rev"], updated=before["updated"])
            return plan["nodes"], prd.render(plan)

        nodes, text = rendered()
        self.review_set()
        self.imp(item(text="SECRET remark about the PRD", author="Dana Secret"))
        self.imp(item(text="SECRET remark, edited"))
        self.triage("CM1", "answer", "Reply SECRET")
        self.review("pull")
        self.review("post", refs=["CM1"])
        self.event({"type": "comment_posted", "ref": "CM1", "url": "https://github.com/acme/notes/pull/7#r2", "ext": "rc:2"})
        self.event({"type": "resolve", "ref": next(r["ref"] for r in self.review_requests())})
        self.review_set(None)
        self.assertEqual(rendered(), (nodes, text))
        self.assertEqual(self.plan()["nodes"], before["nodes"])
        rendered_prd = (self.directory / "PRD.md").read_text(encoding="utf-8")
        for secret in ("SECRET", "Dana", "acme/notes"):
            self.assertNotIn(secret, rendered_prd)

    # ---- 7. mirror

    def test_mirror_strips_review_pr_and_review_requests_but_the_local_plan_keeps_them(self):
        """A mirror plan.json that copies review_pr or a review request publishes the private PR link."""
        mirror = Path(self.temp.name) / "mirror"
        self.cli("publish", self.task, "--to", str(mirror))
        self.review_set()
        self.imp(item(text="Secret remark Wombat", author="Dana Teammate"))
        self.review("pull")
        local, public = self.plan(), json.loads((mirror / "plan.json").read_text(encoding="utf-8"))
        self.assertEqual(local["review_pr"], PR)
        self.assertTrue(any(r["type"] == "review" for r in local["requests"]))
        self.assertNotIn("review_pr", public)
        self.assertEqual([r["type"] for r in public["requests"]], ["ask", "note"])
        for name in ("plan.json", "PRD.md"):
            text = (mirror / name).read_text(encoding="utf-8")
            for secret in ("acme/notes", "Wombat", "Dana", "rc:101", "github.com"):
                self.assertNotIn(secret, text)
        core.validate(public)
        self.assertIn("github.com/acme/notes/pull/7", (self.directory / "plan.json").read_text(encoding="utf-8"))

    # ---- 8. registration

    def test_every_new_event_type_is_registered_with_the_right_sender(self):
        """A new event missing from EVENT_FIELDS is refused as unknown; one in the wrong sender list lets the wrong party send it."""
        for kind in ("comment_import", "review", "review_set", "comment_posted"):
            self.assertIn(kind, core.EVENT_FIELDS)
        self.assertEqual({"comment_import", "review_set", "comment_posted"} & set(core.SESSION_EVENTS),
                         {"comment_import", "review_set", "comment_posted"})
        self.assertNotIn("review", core.SESSION_EVENTS)
        self.assertIn("review", core.REQUEST_TYPES)
        self.assertIn("review_pr", core.OPTIONAL_TOP_KEYS)


if __name__ == "__main__":
    unittest.main()
