"""`plan review open|push|pull|post` (contract 14.4) against a fake gh and a local bare remote. Each docstring names the production regression it catches."""
import getpass
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import test_comments
import test_core
from test_core import CLI, HERE, SCRIPTS

sys.path.insert(0, str(SCRIPTS))
import plan_core as core  # noqa: E402
import prd  # noqa: E402
import review  # noqa: E402

PR = {"repo": "acme/notes", "number": 7, "url": "https://github.com/acme/notes/pull/7", "branch": "prd/offline-sync",
      "head_sha": "0123456789abcdef0123456789abcdef01234567", "prd_rev": 95, "opened_at": "2026-10-17T10:00:00Z",
      "pulled_at": None}
PRD_PATH = "docs/prd/offline-sync/PRD.md"
BRANCH = "prd/offline-sync"
SLUG = "offline-sync"
PROFILE = {"user": {"login": "dana"}, "html_url": "https://github.com/acme/notes/pull/7#x"}


def standard_prd():
    return prd.render(json.loads((HERE / "fixtures/plan-standard.json").read_text(encoding="utf-8")))


class ReviewCliTests(unittest.TestCase):
    plan = test_core.CoreTests.plan
    snapshot = test_core.CoreTests.snapshot
    event = test_core.CoreTests.event
    cli = test_core.CoreTests.cli
    triage = test_comments.CommentTests.triage
    proposed = test_comments.CommentTests.proposed
    accept = test_comments.CommentTests.accept
    comments = test_comments.CommentTests.comments

    def setUp(self):
        test_core.CoreTests.setUp(self)
        base = Path(self.temp.name)
        self.ghdir, self.remote, self.work = base / "gh", base / "remote.git", base / "work"
        (self.ghdir / "bin").mkdir(parents=True)
        fake = (HERE / "fake_gh.py").read_text(encoding="utf-8").split("\n", 1)[1]
        gh = self.ghdir / "bin/gh"
        gh.write_text(f"#!{sys.executable}\n{fake}", encoding="utf-8")
        gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
        (base / ".gitconfig").write_text("[user]\n\tname = Test\n\temail = t@example.test\n", encoding="utf-8")  # review.py drops GIT_* from its env: identity comes from $HOME
        self.env.update(HOME=str(base), FAKE_GH_DIR=str(self.ghdir), PATH=f"{self.ghdir / 'bin'}{os.pathsep}{os.environ['PATH']}")
        self.git("init", "--bare", "-b", "main", str(self.remote), cwd=base)
        self.git("init", "-b", "main", str(self.work), cwd=base)
        (self.work / "README.md").write_text("notes\n", encoding="utf-8")
        self.git("add", "README.md")
        self.git("commit", "-m", "start")
        self.git("remote", "add", "origin", "https://github.com/acme/notes.git")  # the local bare repo stands in for it
        self.git("config", f"url.{self.remote}.insteadOf", "https://github.com/acme/notes.git")
        self.git("push", "origin", "main")
        self.routes(repo="acme/notes", get={})
        self.event({"type": "set", "field": "repo", "value": str(self.work)})

    # ---- helpers

    def git(self, *args, cwd=None, bare=False):
        command = ["git", *(["--git-dir", str(self.remote)] if bare else []), *args]
        result = subprocess.run(command, cwd=None if bare else (cwd or self.work), env=self.env, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def routes(self, **updates):
        path = self.ghdir / "routes.json"
        current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        path.write_text(json.dumps(dict(current, **updates)), encoding="utf-8")

    def gh_log(self):
        path = self.ghdir / "log.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def posts(self):
        return [call for call in self.gh_log() if "POST" in call["argv"]]

    def run_review(self, *args):
        return subprocess.run([sys.executable, str(CLI), "review", *args], env=self.env, text=True, capture_output=True, timeout=60)

    def review(self, action, *extra, code=0):
        result = self.run_review(action, self.task, *extra)
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        self.assertNotIn("Traceback", result.stderr)
        if code:
            self.assertEqual(len(result.stderr.strip().splitlines()), 1, "a failure is one line")
        return result

    def click(self, action, **fields):
        if action == "post" and "proposals" not in fields:  # the page sends the proposal rev it displays on each card
            byid = {c["id"]: c for c in self.comments()}
            fields["proposals"] = {ref: byid[ref]["proposal"]["rev"] for ref in fields["refs"]}
        self.event(dict(fields, type="review", action=action), by="user", source="page")

    def review_requests(self):
        return [r["text"] for r in self.plan()["requests"] if r["type"] == "review"]

    def checkout_state(self):
        return [self.git(*args) for args in (("status", "--porcelain"), ("rev-parse", "HEAD"), ("branch", "--list"), ("worktree", "list"),
                                              ("diff", "--cached"), ("diff",), ("for-each-ref", "refs/heads"), ("stash", "list"))] + [
            (self.work / name).read_text(encoding="utf-8") for name in ("README.md", "staged.txt", "scratch.txt")]

    def dirty_checkout(self):
        (self.work / "README.md").write_text("notes\nunsaved edit\n", encoding="utf-8")
        (self.work / "staged.txt").write_text("staged\n", encoding="utf-8")
        self.git("add", "staged.txt")
        (self.work / "scratch.txt").write_text("untracked\n", encoding="utf-8")

    def remote_heads(self):
        return self.git("for-each-ref", "--format=%(refname:short)", "refs/heads", bare=True).split()

    def opened(self):
        self.click("open")
        self.review("open")
        self.assertEqual(self.review_requests(), [])

    def remote_plan(self, ref=BRANCH):
        return json.loads(self.git("show", f"{ref}:docs/prd/offline-sync/plan.json", bare=True))

    def import_items(self, *items):
        return self.event({"type": "comment_import", "items": [dict({"author": "dana", "text": "x"}, **i) for i in items]})

    def comment_by_ext(self, ext):
        return next(c for c in self.comments() if c["ext"] == ext)

    # ---- 1. the gate

    def test_every_command_refuses_without_its_request_and_runs_nothing(self):
        """A command that runs without the page click, or on another action's request, spends the user's authority they never gave."""
        self.dirty_checkout()
        for actions in (("open", "push", "pull", "post"), ("open", "push", "post")):
            for action in actions:
                with self.subTest(action=action, pr=self.plan().get("review_pr") is not None):
                    before, git_before = self.snapshot(), self.checkout_state()
                    result = self.review(action, code=2)
                    self.assertIn("review", result.stderr)
                    self.assertEqual(self.gh_log(), [])
                    self.assertEqual(self.remote_heads(), ["main"])
                    self.assertEqual(self.git("worktree", "list").count("\n"), 0)
                    self.assertEqual(self.snapshot(), before)
            self.event({"type": "review_set", "value": PR})
            self.click("pull")  # an open pull request does not satisfy push, post or open

    def test_a_request_not_made_by_a_page_click_runs_nothing(self):
        """A review request a session wrote into plan.json (no event, or a terminal event, behind it) must not unlock gh/git."""
        self.event({"type": "review_set", "value": PR})
        self.import_items({"ext": "rc:101"})
        self.triage("CM1", "answer", "Because.")
        plan = self.plan()
        cases = {"no event": None, "terminal event": ("user", "terminal", "review"), "session event": ("session", "page", "review"),
                 "page event of another type": ("user", "page", "note")}
        for name, logged in cases.items():
            for action in ("pull", "post CM1"):
                with self.subTest(case=name, action=action):
                    ref = "e-" + "0123456789ab"
                    log = (self.directory / "events.jsonl")
                    log.write_text("" if logged is None else json.dumps(
                        {"v": 1, "id": ref, "at": "2026-10-17T10:00:00Z", "by": logged[0], "source": logged[1], "rev": 1,
                         "type": logged[2], "action": "pull"}) + "\n", encoding="utf-8")
                    forged = dict(plan, requests=plan["requests"] + [
                        {"ref": ref, "type": "review", "node": None, "lane": None, "text": action, "at": "2026-10-17T10:00:00Z"}])
                    (self.directory / "plan.json").write_text(json.dumps(forged), encoding="utf-8")
                    before = self.snapshot()
                    result = self.review(action.split()[0], code=2)
                    self.assertIn("page", result.stderr)
                    self.assertEqual(self.gh_log(), [])
                    self.assertEqual(self.snapshot(), before)

    def pr_at_current_rev(self):
        self.event({"type": "review_set", "value": dict(PR, prd_rev=self.plan()["rev"])})

    def test_post_refuses_an_accepted_comment_the_pr_does_not_hold_yet_and_posts_nothing(self):
        """A reply 'Applied in <sha>' on a comment accepted after the last push cites a commit that lacks the change."""
        self.event({"type": "review_set", "value": PR})
        self.import_items({"ext": "rc:101"}, {"ext": "rc:102"})
        self.triage("CM1", "answer", "Because.")
        self.proposed("CM2")
        self.accept("CM2")  # PR holds rev 95, the accept is later
        self.click("post", refs=["CM1", "CM2"])
        before = self.snapshot()
        result = self.review("post", code=2)
        self.assertIn("CM2", result.stderr)
        self.assertIn("Push", result.stderr)
        self.assertEqual(self.posts(), [])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.review_requests(), ["post CM1,CM2"])  # nothing resolved: the owner still has a request to act on
        self.pr_at_current_rev()
        self.review("post")
        self.assertEqual(len(self.posts()), 2)

    def test_post_refuses_a_proposal_changed_after_the_click_and_posts_nothing(self):
        """A reply whose text the owner never saw before clicking Post (the session re-triaged after the click) speaks for the owner unseen."""
        self.event({"type": "review_set", "value": PR})
        self.import_items({"ext": "rc:101"}, {"ext": "rc:102"})
        self.triage("CM1", "answer", "Because.")
        self.triage("CM2", "answer", "Fine.")
        self.click("post", refs=["CM1", "CM2"])
        self.event({"type": "comment_rework", "ref": "CM2"}, by="user", source="page")
        self.triage("CM2", "answer", "Sneaky new words.")
        before = self.snapshot()
        result = self.review("post", code=2)
        self.assertIn("CM2", result.stderr)
        self.assertNotIn("CM1", result.stderr)
        self.assertIn("click Post again", result.stderr)  # the one line tells the owner what cures it
        self.assertEqual(self.posts(), [])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.review_requests(), ["post CM1,CM2"])
        old_click = self.plan()["requests"][-1]["ref"]
        self.click("post", refs=["CM1", "CM2"])  # a fresh click after the new proposal replaces the stale request and its click
        self.assertEqual(self.review_requests(), ["post CM1,CM2"])
        self.assertNotEqual(self.plan()["requests"][-1]["ref"], old_click)
        self.assertEqual(self.review("post").stdout.strip(), "posted 2 replies")
        self.assertEqual([call["argv"][-1] for call in self.posts()], ["body=Because.", "body=Sneaky new words."])
        self.assertEqual(self.review_requests(), [])

    def test_post_pull_and_push_refuse_a_recorded_pr_that_is_not_the_checkouts_origin_and_run_no_gh_or_git(self):
        """A review_pr retargeted at another repo makes the owner's next Post click reply on repos/evil/target/pulls/99."""
        evil = dict(PR, repo="evil/target", number=99, url="https://github.com/evil/target/pull/99")
        self.event({"type": "review_set", "value": evil})
        self.import_items({"ext": "rc:101"})
        self.triage("CM1", "answer", "Because.")
        for action, fields in (("post", {"refs": ["CM1"]}), ("pull", {}), ("push", {})):
            with self.subTest(action=action):
                self.click(action, **fields)
                before = self.snapshot()
                result = self.review(action, code=2)
                self.assertIn("evil/target", result.stderr)
                self.assertIn("acme/notes", result.stderr)
                self.assertEqual(self.gh_log(), [])
                self.assertEqual(self.remote_heads(), ["main"])
                self.assertEqual(self.snapshot(), before)
        self.event({"type": "review_set", "value": None})
        self.event({"type": "review_set", "value": PR})
        self.click("post", refs=["CM1"])
        self.review("post")
        self.assertEqual([c["argv"][-3] for c in self.posts()], ["repos/acme/notes/pulls/7/comments/101/replies"])

    def test_clearing_the_review_pr_drops_open_review_requests_so_a_click_never_posts_to_the_next_pr(self):
        """review_set null leaving 'post CM1' standing lets the next PR of the same repo receive a reply the owner clicked for the old one."""
        self.event({"type": "review_set", "value": PR})
        self.import_items({"ext": "rc:101"})
        self.triage("CM1", "answer", "Because.")
        self.click("post", refs=["CM1"])
        self.click("pull")
        self.assertEqual(self.review_requests(), ["post CM1", "pull"])
        self.event({"type": "review_set", "value": None})
        self.assertEqual(self.review_requests(), [])
        self.event({"type": "review_set", "value": dict(PR, number=8, url="https://github.com/acme/notes/pull/8")})
        before = self.snapshot()
        result = self.review("post", code=2)
        self.assertIn("review", result.stderr)
        self.assertEqual(self.gh_log(), [])
        self.assertEqual(self.snapshot(), before)

    # ---- 2. open

    def test_open_publishes_only_the_two_files_on_a_new_branch_and_leaves_the_users_checkout_alone(self):
        """An open that commits in, switches or adds a branch to the user's checkout loses their work; a leaky mirror publishes teammate names."""
        self.event({"type": "comment", "text": "Secret Wombat remark", "author": "Dana Teammate"}, by="user", source="page")
        self.dirty_checkout()
        before = self.checkout_state()
        self.click("open")
        result = self.review("open")
        self.assertEqual(self.checkout_state(), before)
        self.assertEqual(sorted(self.remote_heads()), ["main", BRANCH])
        self.assertEqual(self.git("diff", "--name-only", "main", BRANCH, bare=True).split(), [PRD_PATH, "docs/prd/offline-sync/plan.json"])
        self.assertEqual(self.git("log", "-1", "--format=%s", BRANCH, bare=True), "PRD: Offline sync for a notes app (rev 98)")
        self.assertEqual(self.git("rev-list", "--count", f"main..{BRANCH}", bare=True), "1")
        mirror = self.remote_plan()
        self.assertFalse({"comments", "thread", "comment_seq", "review_pr", "requests", "repo", "owner", "published"} & set(mirror))
        for name in (PRD_PATH, "docs/prd/offline-sync/plan.json"):
            blob = self.git("show", f"{BRANCH}:{name}", bare=True)
            for secret in ("Wombat", "Dana", "github.com", "acme/notes"):
                self.assertNotIn(secret, blob)
        sha = self.git("rev-parse", BRANCH, bare=True)
        self.assertEqual(self.plan()["review_pr"], dict(PR, head_sha=sha, prd_rev=98, opened_at=self.plan()["review_pr"]["opened_at"]))
        self.assertEqual(self.review_requests(), [])
        self.assertEqual(result.stdout.strip(), "opened PR #7 https://github.com/acme/notes/pull/7")
        create = next(call["argv"] for call in self.gh_log() if call["argv"][:2] == ["pr", "create"])
        for part in (["--draft"], ["--head", BRANCH], ["--title", "PRD: Offline sync for a notes app"], ["--repo", "acme/notes"]):
            self.assertEqual(create[create.index(part[0]):][:len(part)], part)
        self.assertTrue(all(call["no_prompt"] == ["0", "1"] and call["stdin_closed"] for call in self.gh_log()))
        self.assertEqual(self.git("worktree", "list").count("\n"), 0)

    def test_the_pr_goes_to_the_repo_origin_points_at_even_when_gh_would_guess_another_remote(self):
        """With a fork's `upstream` remote, a bare `gh repo view` can name the upstream: the PRD would then be offered to a repo the owner never chose."""
        self.git("remote", "add", "upstream", "git@github.com:upstream-org/notes.git")
        self.routes(repo="upstream-org/notes")  # what an unguided gh answers
        self.opened()
        create = next(call["argv"] for call in self.gh_log() if call["argv"][:2] == ["pr", "create"])
        self.assertEqual(create[create.index("--repo") + 1], "acme/notes")
        self.assertEqual(create[create.index("--head") + 1], BRANCH)
        self.assertEqual(self.plan()["review_pr"]["repo"], "acme/notes")
        self.assertNotIn("upstream-org/notes", json.dumps(self.gh_log()))

    def test_open_refuses_an_origin_that_is_not_a_github_remote(self):
        """A local or other-host origin has no owner/name to pass to gh: refuse rather than let gh guess."""
        for url in (str(self.remote), "https://gitlab.com/acme/notes.git", "https://github.com/acme/../notes.git"):
            with self.subTest(url=url):
                self.git("config", "remote.origin.url", url)
                self.click("open")
                before = self.snapshot()
                result = self.review("open", code=2)
                self.assertIn("origin", result.stderr)
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(self.gh_log(), [])
                self.assertEqual(self.remote_heads(), ["main"])

    def test_gh_and_git_run_without_git_environment_overrides_and_credentials_in_errors_are_redacted(self):
        """GIT_SSH_COMMAND, GIT_CONFIG_* and the like in the caller's environment run arbitrary commands or redirect the push; a gh error that echoes a URL with a password must not reach the terminal."""
        self.click("open")
        env = dict(self.env, GIT_SSH_COMMAND="touch /nonexistent/pwned", GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="core.pager", GIT_CONFIG_VALUE_0="x",
                   GIT_DIR=str(self.remote), GH_TOKEN="t0ken-123")
        result = subprocess.run([sys.executable, str(CLI), "review", "open", self.task], env=env, text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.gh_log()
        self.assertEqual([call["git_env"] for call in calls], [["GIT_TERMINAL_PROMPT"]] * len(calls))
        self.assertEqual({call["gh_token"] for call in calls}, {"t0ken-123"})
        self.assertNotIn("t0ken-123", result.stdout + result.stderr)
        self.assertEqual(self.remote_heads(), ["main", BRANCH])  # the push went to origin, not to $GIT_DIR
        self.routes(fail=["pulls/7/comments"], fail_message="fatal: unable to access 'https://bob:s3cret@github.com/acme/notes.git/': 403")
        self.click("pull")
        failed = self.review("pull", code=5)
        self.assertNotIn("s3cret", failed.stderr)
        self.assertNotIn("bob", failed.stderr)

    def test_open_json_reports_the_pr_without_secrets(self):
        """A --json result that is not one object with the PR fields breaks the SKILL.md card that reads it."""
        self.click("open")
        out = json.loads(self.review("open", "--json").stdout)
        sha = self.git("rev-parse", BRANCH, bare=True)
        self.assertEqual(out, {"action": "open", "number": 7, "url": "https://github.com/acme/notes/pull/7", "branch": BRANCH,
                               "head_sha": sha, "prd_rev": 97})

    def test_a_failed_gh_before_the_push_leaves_nothing_on_the_remote_and_a_failed_pr_create_is_retryable(self):
        """An open that pushes before it knows gh works strands a branch; one that cannot be retried after pr create fails duplicates the commit."""
        self.click("open")
        before = self.snapshot()
        self.routes(fail=["repo view"])
        self.review("open", code=5)
        self.assertEqual(self.remote_heads(), ["main"])
        self.routes(fail=["pr create"])
        self.review("open", code=5)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.review_requests(), ["open"])
        self.assertNotIn("review_pr", self.plan())
        self.routes(fail=[])
        self.review("open")
        self.assertEqual(self.git("rev-list", "--count", f"main..{BRANCH}", bare=True), "1")
        self.assertEqual(self.plan()["review_pr"]["number"], 7)
        self.assertEqual(self.review_requests(), [])
        self.assertEqual(self.git("worktree", "list").count("\n"), 0)

    # ---- 3. push

    def test_the_published_pr_files_carry_no_local_paths_owner_threads_or_requests(self):
        """The PR is readable by every teammate (and the world on a public repo): the owner login, the local checkout path and the chat threads stay on this machine."""
        plan = self.plan()
        plan["nodes"][0]["thread"] = [{"role": "user", "text": "private aside to my session", "at": "2026-10-17T10:00:00Z", "ref": "e-0123456789ab"}]
        (self.directory / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
        self.assertIn(str(self.work), json.dumps(self.plan()))  # the local copy has them, so the PR view is what drops them
        self.opened()
        published = self.remote_plan()
        for key in ("repo", "published", "owner", "requests"):
            self.assertNotIn(key, published)
        self.assertTrue(all("thread" not in node for node in published["nodes"]))
        everything = self.git("show", f"{BRANCH}:{PRD_PATH}", bare=True) + json.dumps(published)
        self.assertNotIn(str(self.work), everything)
        self.assertNotIn(getpass.getuser(), everything)  # the local login, whatever it is
        self.assertNotIn("private aside", everything)
        self.assertEqual(published["title"], "Offline sync for a notes app")
        self.assertEqual(len(published["nodes"]), len(plan["nodes"]))
        self.assertIn("set repo", json.dumps(published["recent"]))  # the trail stays, only the value goes

    def test_a_symlink_in_the_branch_tree_stops_the_push_and_nothing_outside_is_written(self):
        """A PR branch whose docs/prd/<slug> (or a file in it) is a symlink would make `push` write the PRD through it to wherever it points."""
        outside = Path(self.temp.name) / "outside"
        cases = {"docs": outside, "docs/prd": outside, "docs/prd/offline-sync": outside,
                 "docs/prd/offline-sync/PRD.md": outside / "target.txt", "docs/prd/offline-sync/plan.json": outside / "target.txt"}
        for link, target in cases.items():
            with self.subTest(link=link):
                shutil.rmtree(outside, ignore_errors=True)
                outside.mkdir()
                (outside / "target.txt").write_text("mine\n", encoding="utf-8")
                shutil.rmtree(self.work / "docs", ignore_errors=True)
                (self.work / link).parent.mkdir(parents=True, exist_ok=True)
                (self.work / link).symlink_to(target)
                self.git("checkout", "-q", "-B", BRANCH, "main")
                self.git("add", "-A")
                self.git("commit", "-q", "-m", "evil")
                self.git("push", "-q", "-f", "origin", BRANCH)
                self.git("checkout", "-q", "main")
                self.git("branch", "-q", "-D", BRANCH)
                shutil.rmtree(self.work / "docs", ignore_errors=True)
                self.event({"type": "review_set", "value": PR})
                self.click("push")
                before = sorted(p.name for p in outside.rglob("*"))
                result = self.review("push", code=5)
                self.assertIn("symlink", result.stderr)
                self.assertEqual(sorted(p.name for p in outside.rglob("*")), before)
                self.assertEqual((outside / "target.txt").read_text(encoding="utf-8"), "mine\n")
                self.event({"type": "review_set", "value": None})
                for request in [r for r in self.plan()["requests"] if r["type"] == "review"]:
                    self.event({"type": "resolve", "ref": request["ref"]})

    def test_push_adds_a_commit_only_when_the_prd_changed_and_nothing_new_otherwise(self):
        """A push that commits an unchanged PRD spams the PR; one that skips a changed PRD leaves the teammate reviewing stale text."""
        self.opened()
        first = self.git("rev-parse", BRANCH, bare=True)
        self.event({"type": "edit_label", "node": "FR-001", "label": "Users can edit notes offline"}, by="user", source="page")
        self.click("push")
        rev = self.plan()["rev"]
        result = self.review("push")
        second = self.git("rev-parse", BRANCH, bare=True)
        self.assertNotEqual(second, first)
        self.assertEqual(self.git("rev-parse", f"{BRANCH}~1", bare=True), first)
        self.assertEqual(self.git("log", "-1", "--format=%s", BRANCH, bare=True), f"PRD: Offline sync for a notes app (rev {rev})")
        self.assertIn("Users can edit notes offline", self.git("show", f"{BRANCH}:{PRD_PATH}", bare=True))
        self.assertEqual((self.plan()["review_pr"]["head_sha"], self.plan()["review_pr"]["prd_rev"]), (second, rev))
        self.assertEqual(result.stdout.strip(), f"pushed {second[:7]} (rev {rev})")
        self.assertEqual(self.review_requests(), [])
        self.click("push")
        rev = self.plan()["rev"]
        result = self.review("push", "--json")
        self.assertEqual(json.loads(result.stdout), {"action": "push", "changed": False, "head_sha": second, "prd_rev": rev})
        self.assertEqual(self.git("rev-parse", BRANCH, bare=True), second)
        self.assertEqual(self.plan()["review_pr"]["prd_rev"], rev)
        self.assertEqual(self.review_requests(), [])
        self.click("push")
        self.assertEqual(self.review("push").stdout.strip(), "nothing new")

    def publish_with_a_second_fetch_in_between(self):
        """review.publish() with another fetch (another plan's publish, or the owner's) landing in the checkout right after publish's own."""
        real = review.git

        def interleaved(*args, cwd):
            out = real(*args, cwd=cwd)
            if args[0] == "fetch":
                real("fetch", "origin", "refs/heads/unrelated", cwd=cwd)  # rewrites the shared FETCH_HEAD
            return out

        plan = self.plan()
        with patch.dict(os.environ, self.env), patch.object(review, "git", interleaved):
            return review.publish(plan, BRANCH)[0]

    def test_publish_starts_from_the_branch_it_fetched_even_when_another_fetch_lands_in_between(self):
        """Reading the shared FETCH_HEAD after the fetch builds the PRD commit on whichever branch was fetched last, so a reviewer pushes a PRD branch with an unrelated parent."""
        self.git("checkout", "-q", "-b", "unrelated")
        (self.work / "elsewhere.txt").write_text("another plan's branch\n", encoding="utf-8")
        self.git("add", "elsewhere.txt")
        self.git("commit", "-q", "-m", "unrelated work")
        self.git("push", "-q", "origin", "unrelated")
        self.git("checkout", "-q", "main")
        main = self.git("rev-parse", "main", bare=True)
        first = self.publish_with_a_second_fetch_in_between()  # a new branch: starts from the default branch
        self.assertEqual(self.git("rev-parse", f"{BRANCH}~1", bare=True), main)
        self.assertEqual(self.git("rev-parse", BRANCH, bare=True), first)
        self.assertEqual(self.git("ls-tree", "--name-only", BRANCH, bare=True).split(), ["README.md", "docs"])
        self.event({"type": "edit_label", "node": "FR-001", "label": "Users can edit notes offline"}, by="user", source="page")
        second = self.publish_with_a_second_fetch_in_between()  # an existing branch: continues from its own head
        self.assertNotEqual(second, first)
        self.assertEqual(self.git("rev-parse", f"{BRANCH}~1", bare=True), first)
        self.assertEqual(self.git("ls-tree", "--name-only", BRANCH, bare=True).split(), ["README.md", "docs"])
        self.assertEqual(self.git("for-each-ref", "refs/prd-review"), "")  # the private ref does not stay in the owner's checkout

    def tamper_branch(self, edit, message="tamper"):
        """Push a commit to prd/offline-sync as someone with push rights would: edit(directory) changes the docs/prd/<slug> files."""
        self.git("fetch", "-q", "origin", f"refs/heads/{BRANCH}")
        self.git("checkout", "-q", "-B", BRANCH, "FETCH_HEAD")
        edit(self.work / "docs/prd" / SLUG)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        self.git("push", "-q", "origin", BRANCH)
        self.git("checkout", "-q", "main")
        self.git("branch", "-q", "-D", BRANCH)

    def test_push_rewrites_a_branch_whose_prd_md_or_directory_was_altered_instead_of_saying_nothing_new(self):
        """A push that compares plan.json alone says 'nothing new' over a PRD.md a teammate rewrote, and records that commit as the PR the owner reviewed."""
        self.opened()
        cases = {"edited PRD.md": lambda d: (d / "PRD.md").write_text("# Not the plan\n", encoding="utf-8"),
                 "extra file": lambda d: (d / "NOTES.md").write_text("hello\n", encoding="utf-8"),
                 "deleted PRD.md": lambda d: (d / "PRD.md").unlink()}
        for name, edit in cases.items():
            with self.subTest(case=name):
                self.tamper_branch(edit)
                tampered = self.git("rev-parse", BRANCH, bare=True)
                self.click("push")
                result = self.review("push")
                self.assertNotEqual(result.stdout.strip(), "nothing new")
                sha = self.git("rev-parse", BRANCH, bare=True)
                self.assertEqual(self.git("rev-parse", f"{BRANCH}~1", bare=True), tampered)
                self.assertEqual(self.git("show", f"{BRANCH}:{PRD_PATH}", bare=True), prd.render(dict(self.remote_plan(), owner="withheld")).strip())
                self.assertEqual(sorted(self.git("ls-tree", "--name-only", f"{BRANCH}:docs/prd/{SLUG}", bare=True).split()), ["PRD.md", "plan.json"])
                self.assertEqual(self.plan()["review_pr"]["head_sha"], sha)
                self.click("push")
                self.assertEqual(self.review("push").stdout.strip(), "nothing new")  # and the restored branch is quiet again

    def test_push_to_a_branch_other_than_the_plans_prd_branch_is_refused_and_origin_is_untouched(self):
        """A plan.json whose review_pr.branch was edited to main would make `push` commit a PRD onto the default branch."""
        self.opened()
        main_before = self.git("rev-parse", "main", bare=True)
        plan = self.plan()
        plan["review_pr"]["branch"] = "main"
        (self.directory / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
        self.click("push")
        result = self.review("push", code=2)
        self.assertIn("prd/offline-sync", result.stderr)
        self.assertEqual(self.git("rev-parse", "main", bare=True), main_before)

    # ---- 4. pull

    def pull_fixtures(self, review_comments=(), reviews=(), issues=()):
        self.routes(get={
            "repos/acme/notes/pulls/7/comments": list(review_comments), "repos/acme/notes/pulls/7/reviews": list(reviews),
            "repos/acme/notes/issues/7/comments": list(issues),
            f"repos/acme/notes/contents/{PRD_PATH}": {"raw": self.git("show", f"{BRANCH}:{PRD_PATH}", bare=True) + "\n"}})

    def rc(self, cid, body, line, path=PRD_PATH, **extra):
        return dict(PROFILE, id=cid, body=body, path=path, line=line, html_url=f"https://github.com/acme/notes/pull/7#discussion_r{cid}", **extra)

    def test_pull_imports_all_three_kinds_with_anchors_threads_and_a_name_free_request_trail(self):
        """A pull that misses a kind, drops the thread link, mis-anchors, or skips pagination loses the teammate's review."""
        self.opened()
        self.pull_fixtures(
            review_comments=[self.rc(101, "[Q1] question: why SQLite?", 77), self.rc(102, "Needs a number", 78),
                             self.rc(103, "Reply from Dana", 78, in_reply_to_id=102), self.rc(104, "Intro is vague", 15),
                             self.rc(105, "[ZZ-99] odd", None), self.rc(106, "wrong file", 3, path="README.md")],
            reviews=[dict(PROFILE, id=201, state="COMMENTED", body="Overall: solid scope.", html_url="https://github.com/acme/notes/pull/7#r201"),
                     dict(PROFILE, id=202, state="APPROVED", body=""), dict(PROFILE, id=203, state="PENDING", body="draft")],
            issues=[dict(PROFILE, id=301, body="[PRD] general: where is the rollout plan?",
                         html_url="https://github.com/acme/notes/pull/7#issuecomment-301")])
        self.click("pull")
        result = self.review("pull")
        self.assertEqual(result.stdout.strip(), "pulled 8 comments (8 new)")
        found = {c["ext"]: c for c in self.comments()}
        self.assertEqual({e: c["anchor"] for e, c in found.items()},
                         {"rc:101": "Q1", "rc:102": "FR-002", "rc:103": "FR-002", "rc:104": "§1", "rc:105": None, "rc:106": None,
                          "rv:201": None, "ic:301": None})
        self.assertEqual((found["rc:103"]["reply_to"], found["rc:102"]["reply_to"]), ("rc:102", None))
        self.assertEqual((found["rv:201"]["author"], found["rv:201"]["text"], found["rv:201"]["url"], found["rv:201"]["state"]),
                         ("dana", "Overall: solid scope.", "https://github.com/acme/notes/pull/7#r201", "open"))
        self.assertTrue(all(c["source"] == "github" and c["resolved"] is False for c in found.values()))
        self.assertEqual(len([r for r in self.plan()["requests"] if r["type"] == "comment"]), 8)
        pr = self.plan()["review_pr"]
        self.assertIsNotNone(pr["pulled_at"])
        self.assertEqual(self.review_requests(), [])
        calls = [call["argv"] for call in self.gh_log() if call["argv"][0] == "api"]
        for endpoint in ("pulls/7/comments", "pulls/7/reviews", "issues/7/comments"):
            self.assertTrue(any("--paginate" in argv and argv[-1].startswith(f"repos/acme/notes/{endpoint}") for argv in calls), endpoint)
        contents = next(argv for argv in calls if "contents" in argv[-1])
        self.assertEqual(contents[-1], f"repos/acme/notes/contents/{PRD_PATH}?ref={pr['head_sha']}")
        self.assertIn("Accept: application/vnd.github.raw", contents)

    def test_pull_twice_adds_no_duplicates_and_an_edited_comment_updates(self):
        """A pull that is not idempotent doubles every comment; one that ignores an edit leaves the user answering stale text."""
        self.opened()
        review_comments = [self.rc(101, "[Q1] question: why SQLite?", 77)]
        self.pull_fixtures(review_comments=review_comments, issues=[dict(PROFILE, id=301, body="First")])
        self.click("pull")
        self.assertEqual(self.review("pull").stdout.strip(), "pulled 2 comments (2 new)")
        self.click("pull")
        self.assertEqual(self.review("pull").stdout.strip(), "pulled 2 comments (0 new)")
        self.assertEqual([c["id"] for c in self.comments()], ["CM1", "CM2"])
        self.pull_fixtures(review_comments=[self.rc(101, "[Q1] question: why SQLite? (edited)", 77)], issues=[dict(PROFILE, id=301, body="First")])
        self.click("pull")
        self.assertEqual(json.loads(self.review("pull", "--json").stdout), {"action": "pull", "imported": 2, "new": 0})
        self.assertEqual((self.comments()[0]["text"], self.comments()[0]["edited"], self.comments()[1]["edited"]),
                         ("[Q1] question: why SQLite? (edited)", True, False))

    def test_pull_sends_at_most_fifty_items_per_import_and_a_pull_of_nothing_still_resolves(self):
        """A single oversized import is refused by the core; a pull that errors on an empty PR never clears its request."""
        self.opened()
        self.pull_fixtures()
        self.click("pull")
        self.assertEqual(self.review("pull").stdout.strip(), "pulled 0 comments (0 new)")
        self.assertEqual(self.review_requests(), [])
        self.assertIsNotNone(self.plan()["review_pr"]["pulled_at"])
        self.pull_fixtures(issues=[dict(PROFILE, id=1000 + n, body=f"remark {n}") for n in range(60)])
        self.click("pull")
        self.assertEqual(self.review("pull").stdout.strip(), "pulled 60 comments (60 new)")
        imports = [json.loads(line) for line in (self.directory / "events.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([len(e["items"]) for e in imports if e["type"] == "comment_import"], [50, 10])

    def test_pull_that_would_pass_the_comment_cap_imports_nothing_and_names_the_cap(self):
        """A flood of PR comments past the 100 cap used to import the first batch and then die: half a pull, request left open."""
        self.opened()
        self.import_items(*[{"ext": f"ic:{n}", "text": f"old {n}"} for n in range(50)])
        self.import_items(*[{"ext": f"ic:{n}", "text": f"old {n}"} for n in range(50, 98)])
        self.assertEqual(len(self.comments()), 98)
        self.pull_fixtures(issues=[dict(PROFILE, id=n, body=f"old {n}") for n in range(98)]
                           + [dict(PROFILE, id=2000 + n, body=f"flood {n}") for n in range(3)])
        self.click("pull")
        before = self.snapshot()
        result = self.review("pull", code=5)
        self.assertIn("100", result.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(self.comments()), 98)
        self.pull_fixtures(issues=[dict(PROFILE, id=n, body=f"old {n}") for n in range(98)]
                           + [dict(PROFILE, id=2000 + n, body=f"flood {n}") for n in range(2)])
        self.assertEqual(self.review("pull").stdout.strip(), "pulled 100 comments (2 new)")
        self.assertEqual(len(self.comments()), 100)

    def test_a_failing_read_leaves_the_plan_and_the_request_untouched(self):
        """A pull that imports the pages it got before one failed, or resolves anyway, loses the retry."""
        self.opened()
        self.pull_fixtures(review_comments=[self.rc(101, "ok", 77)])
        self.routes(fail=["pulls/7/reviews"])
        self.click("pull")
        before = self.snapshot()
        result = self.review("pull", code=5)
        self.assertIn("502", result.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.review_requests(), ["pull"])

    def test_pull_survives_an_unreadable_prd_with_null_anchors(self):
        """A failed contents fetch (outdated head) that aborts the pull loses every comment for want of an anchor."""
        self.opened()
        self.pull_fixtures(review_comments=[self.rc(102, "Needs a number", 78)])
        self.routes(fail=["/contents/"])
        self.click("pull")
        self.assertEqual(self.review("pull").stdout.strip(), "pulled 1 comments (1 new)")
        self.assertIsNone(self.comments()[0]["anchor"])

    # ---- 5. post

    def setup_posts(self, count=4):
        self.event({"type": "review_set", "value": PR})
        self.import_items({"ext": "rc:101", "text": "[Q1] why?"}, {"ext": "rc:102", "text": "needs a number"},
                          {"ext": "rc:103", "text": "reply", "reply_to": "rc:101"}, {"ext": "ic:301", "text": "general"},
                          {"ext": "ic:302", "text": "never named"})

    def test_post_replies_in_thread_to_exactly_the_named_comments_and_records_each(self):
        """A reply on the wrong endpoint, to an unnamed comment, with changed text, or never recorded breaks the PR conversation or double-posts."""
        self.setup_posts()
        hostile = 'Out of scope; $(touch /tmp/pwned) "quoted" `id` \'x\' --flag'
        self.triage("CM1", "answer", "Because ops are replayable.")
        self.proposed("CM2")
        self.accept("CM2")
        self.triage("CM3", "decline", hostile)
        self.triage("CM4", "answer", "Noted.")
        self.triage("CM5", "answer", "Not named, never sent.")
        self.pr_at_current_rev()
        self.click("post", refs=["CM1", "CM2", "CM3", "CM4"])
        result = self.review("post")
        self.assertEqual(result.stdout.strip(), "posted 4 replies")
        sent = [(next(a for a in call["argv"] if a.startswith("repos/")), call["argv"][-1]) for call in self.posts()]
        self.assertEqual(sent, [
            ("repos/acme/notes/pulls/7/comments/101/replies", "body=Because ops are replayable."),
            ("repos/acme/notes/pulls/7/comments/102/replies", "body=Applied in 0123456 (PRD rev 104).\nAdd it"),
            ("repos/acme/notes/pulls/7/comments/101/replies", "body=" + hostile),
            ("repos/acme/notes/issues/7/comments", "body=Noted.")])
        posted = {c["id"]: c["posted"] for c in self.comments()}
        self.assertEqual({k: (v or {}).get("ext") for k, v in posted.items()},
                         {"CM1": "rc:901", "CM2": "rc:902", "CM3": "rc:903", "CM4": "ic:904", "CM5": None})
        self.assertEqual(posted["CM4"]["url"], "https://github.com/acme/notes/pull/7#issuecomment-904")
        self.assertEqual(self.review_requests(), [])
        self.assertEqual(self.review("post", code=2).returncode, 2)  # resolved: a second run has no request
        self.assertEqual(len(self.posts()), 4)
        self.assertFalse(Path("/tmp/pwned").exists())

    def test_two_post_runs_at_once_post_each_reply_once(self):
        """Two `plan review post` racing on one click both read 'CM1 not posted yet' and reply twice in the teammate's thread."""
        self.event({"type": "review_set", "value": PR})
        self.import_items({"ext": "rc:101"})
        self.triage("CM1", "answer", "Because.")
        self.click("post", refs=["CM1"])
        self.routes(sleep=2)  # each gh call takes 2 s, so the second process starts while the first is mid-post
        command = [sys.executable, str(CLI), "review", "post", self.task]
        runs = [subprocess.Popen(command, env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
        results = [(run.communicate(timeout=60), run.returncode) for run in runs]
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(sorted(code for _, code in results), [0, 2])
        self.assertIn("No open review request", next(err for (_, err), code in results if code == 2))
        self.assertEqual(self.comments()[0]["posted"]["ext"], "rc:901")

    def test_a_pull_racing_a_post_waits_and_never_imports_the_owners_own_reply(self):
        """A pull outside the post lock lists the reply gh just stored before comment_posted is recorded and imports it as a teammate comment."""
        self.opened()
        teammate = dict(PROFILE, id=301, body="Teammate remark")
        self.pull_fixtures(issues=[teammate])
        self.click("pull")
        self.review("pull")
        self.triage("CM1", "answer", "Our answer")
        self.click("post", refs=["CM1"])
        self.routes(sleep=3)
        runs = [subprocess.Popen([sys.executable, str(CLI), "review", "post", self.task], env=self.env, text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)]
        for _ in range(100):  # the POST is logged before gh sleeps: from here the post is mid-flight
            if self.posts():
                break
            time.sleep(0.1)
        self.assertEqual(len(self.posts()), 1)
        self.routes(sleep=0, get={"repos/acme/notes/pulls/7/comments": [], "repos/acme/notes/pulls/7/reviews": [],
                                  "repos/acme/notes/issues/7/comments": [teammate, dict(PROFILE, id=901, body="Our answer")]})
        self.click("pull")
        runs.append(subprocess.Popen([sys.executable, str(CLI), "review", "pull", self.task], env=self.env, text=True,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE))
        results = [(run.communicate(timeout=60), run.returncode) for run in runs]
        self.assertEqual([code for _, code in results], [0, 0], results)
        self.assertEqual([(c["ext"], (c["posted"] or {}).get("ext")) for c in self.comments()], [("ic:301", "ic:901")])
        self.assertEqual(self.review_requests(), [])

    def test_post_on_an_unknown_task_is_the_usual_one_line_error(self):
        """The post lock lives in the plan dir: a task that does not exist must not surface as a FileNotFoundError traceback."""
        result = self.run_review("post", "1099-nothing")
        self.assertEqual((result.returncode, result.stderr.strip()), (3, "No plan for 1099-nothing"))

    def test_post_json_lists_what_was_posted(self):
        """A --json that omits the ref/url/ext breaks the SKILL.md card that reports posted replies."""
        self.setup_posts()
        self.triage("CM4", "answer", "Noted.")
        self.click("post", refs=["CM4"])
        out = json.loads(self.review("post", "--json").stdout)
        self.assertEqual(out, {"action": "post", "posted": [{"ref": "CM4", "url": "https://github.com/acme/notes/pull/7#issuecomment-901",
                                                            "ext": "ic:901"}], "remaining": []})

    def test_a_failure_on_the_third_of_five_keeps_the_first_two_recorded_and_a_retry_posts_only_the_rest(self):
        """A post that records nothing until the end, or retries everything, double-posts on a teammate's PR."""
        self.event({"type": "review_set", "value": PR})
        self.import_items(*({"ext": f"ic:{300 + n}", "text": f"remark {n}"} for n in range(1, 6)))
        for n in range(1, 6):
            self.triage(f"CM{n}", "answer", f"A{n}")
        self.click("post", refs=[f"CM{n}" for n in range(1, 6)])
        self.routes(fail_post_nth=3)
        result = self.review("post", code=5)
        self.assertIn("CM3", result.stderr)
        self.assertIn("CM4", result.stderr)
        self.assertEqual([c["posted"] is not None for c in self.comments()], [True, True, False, False, False])
        self.assertEqual(self.review_requests(), ["post CM1,CM2,CM3,CM4,CM5"])
        self.routes(fail_post_nth=0)
        self.assertEqual(self.review("post", "--json").stdout.count("CM"), 3)
        self.assertEqual([call["argv"][-1] for call in self.posts()], ["body=A1", "body=A2", "body=A3", "body=A3", "body=A4", "body=A5"])
        self.assertTrue(all(c["posted"] is not None for c in self.comments()))
        self.assertEqual(self.review_requests(), [])

    def test_a_first_post_failure_changes_nothing(self):
        """A failed post that records or resolves anyway makes the user believe a reply went out."""
        self.setup_posts()
        self.triage("CM1", "answer", "Because.")
        self.click("post", refs=["CM1"])
        before = self.snapshot()
        self.routes(fail_post_nth=1)
        self.review("post", code=5)
        self.assertEqual(self.snapshot(), before)

    def test_a_split_github_comment_is_not_imported_again_by_the_next_pull(self):
        """A split that drops the original's ext makes the next pull bring the original body back as a new open comment next to its parts."""
        self.opened()
        self.pull_fixtures(issues=[dict(PROFILE, id=301, body="Two things: rollout and naming")])
        self.click("pull")
        self.review("pull")
        self.event({"type": "comment_split", "ref": "CM1", "parts": [{"text": "rollout"}, {"text": "naming"}]})
        self.click("pull")
        self.assertEqual(self.review("pull").stdout.strip(), "pulled 0 comments (0 new)")
        self.assertEqual([(c["text"], c["source"]) for c in self.comments()], [("rollout", "paste"), ("naming", "paste")])

    def test_deleting_closed_comments_frees_room_on_a_pr_with_more_than_the_cap(self):
        """Deleted ext ids that a pull counts as new again make a 101-comment PR fail with 'room for' after the owner cleared space."""
        self.opened()
        remarks = [dict(PROFILE, id=300 + n, body=f"remark {n}") for n in range(100)]
        self.pull_fixtures(issues=remarks)
        self.click("pull")
        self.assertEqual(self.review("pull").stdout.strip(), "pulled 100 comments (100 new)")
        for ref in ("CM1", "CM2", "CM3"):
            self.event({"type": "comment_delete", "ref": ref}, by="user", source="page")
        self.pull_fixtures(issues=remarks + [dict(PROFILE, id=500, body="late remark")])
        self.click("pull")
        self.assertEqual(self.review("pull").stdout.strip(), "pulled 98 comments (1 new)")
        self.assertEqual(len(self.comments()), 98)
        self.assertNotIn("remark 0", [c["text"] for c in self.comments()])

    def test_our_own_reply_coming_back_in_a_pull_is_not_imported(self):
        """A pull that re-imports the reply the user just posted shows the user their own words as a teammate comment."""
        self.opened()
        self.pull_fixtures(issues=[dict(PROFILE, id=301, body="Teammate remark")])
        self.click("pull")
        self.review("pull")
        self.triage("CM1", "answer", "Our answer")
        self.click("post", refs=["CM1"])
        self.review("post")
        reply_id = self.comments()[0]["posted"]["ext"].split(":")[1]
        self.pull_fixtures(issues=[dict(PROFILE, id=301, body="Teammate remark"), dict(PROFILE, id=int(reply_id), body="Our answer")])
        self.click("pull")
        self.assertEqual(self.review("pull").stdout.strip(), "pulled 1 comments (0 new)")
        self.assertEqual(len(self.comments()), 1)

    # ---- 6. subprocess discipline

    def test_a_hanging_gh_is_cut_off_with_a_one_line_error(self):
        """A gh call without a timeout hangs the session on a stuck network."""
        self.routes(sleep=5)
        with patch.dict(os.environ, self.env), patch.object(review, "TIMEOUT", 1):
            with self.assertRaises(core.PlanError) as caught:
                review.gh("repo", "view", "--json", "nameWithOwner")
        self.assertEqual((caught.exception.code, "timed out" in str(caught.exception)), (5, True))

    def test_a_missing_gh_is_a_one_line_error(self):
        """A gh that is not installed must fail the command, not crash with a traceback."""
        with patch.dict(os.environ, self.env, PATH=str(self.ghdir)):
            with self.assertRaises(core.PlanError) as caught:
                review.gh("repo", "view")
        self.assertEqual((caught.exception.code, "not found" in str(caught.exception)), (5, True))

    def test_text_flag_and_unknown_action_are_usage_errors(self):
        """A --text flag (the session's free-form reply text is gone) or an unknown action must be refused, not silently ignored."""
        self.assertEqual(self.run_review("bogus", self.task).returncode, 2)
        self.event({"type": "review_set", "value": PR})
        self.click("pull")
        for action in ("pull", "post"):  # no free-form reply text any more
            result = self.run_review(action, self.task, "--text", "CM1=x")
            self.assertEqual(result.returncode, 2)
            self.assertIn("unrecognized arguments", result.stderr)
        self.assertEqual(self.gh_log(), [])

    # ---- 7. anchor mapping (pure)

    def test_anchor_for_a_leading_id_beats_the_line_and_prd_means_the_whole_prd(self):
        """A mapping that lets the line override the teammate's explicit [ID], or maps [PRD] to a node, misfiles the comment."""
        ids, text = {"Q1", "FR-002", "P1"}, standard_prd()
        for body, expected in (("[Q1] question: why?", "Q1"), ("[Q1]no space", "Q1"), ("  [Q1] indented", "Q1")):
            with self.subTest(body=body):
                self.assertEqual(review.anchor_for(body, PRD_PATH, 78, text, SLUG, ids), expected)
        self.assertIsNone(review.anchor_for("[PRD] general", PRD_PATH, 78, text, SLUG, ids))
        for body in ("[Q1 unclosed", "see [Q1] later", "[q1] lowercase"):
            with self.subTest(body=body):
                self.assertIsNone(review.anchor_for(body, None, None, None, SLUG, ids))

    def test_anchor_for_walks_up_from_the_line_to_the_defining_node_then_the_section_heading(self):
        """A mapping that picks a mentioned id, climbs past a section, or errors on an odd line misfiles or aborts the pull."""
        ids = {"P1", "FR-001", "FR-002", "T-001", "T-002", "AS-1", "S2", "Q11"}
        text = standard_prd()
        cases = {20: "P1", 21: "P1", 19: "P1", 77: "FR-001", 78: "FR-002", 55: "AS-1", 167: "T-001", 168: "T-002",
                 3: "§0", 13: "§1", 15: "§1", 14: "§1", 17: "§2", 76: "§9"}
        for line, expected in cases.items():
            with self.subTest(line=line):
                self.assertEqual(review.anchor_for("no id", PRD_PATH, line, text, SLUG, ids), expected)
        self.assertEqual(review.anchor_for("[ZZ-9] unknown id", PRD_PATH, 78, text, SLUG, ids), "FR-002")

    def test_anchor_for_degrades_to_none_for_anything_it_cannot_place(self):
        """A mapping that raises on an outdated, foreign or malformed location aborts the whole pull."""
        ids, text = {"FR-001"}, standard_prd()
        for path, line in ((PRD_PATH, None), (PRD_PATH, 0), (PRD_PATH, -3), (PRD_PATH, 99999), (PRD_PATH, "7"), (PRD_PATH, True),
                           ("README.md", 77), (None, 77), ("docs/prd/other/PRD.md", 77)):
            with self.subTest(path=path, line=line):
                self.assertIsNone(review.anchor_for("no id", path, line, text, SLUG, ids))
        self.assertIsNone(review.anchor_for("no id", PRD_PATH, 77, None, SLUG, ids))
        self.assertEqual(review.anchor_for("x", PRD_PATH, 3, "## 19. Beyond\ntext\n", SLUG, ids), None)
        self.assertEqual(review.anchor_for("x", PRD_PATH, 2, "### 4 Goals\ntext\n", SLUG, ids), "§4")
        self.assertEqual(review.anchor_for("x", PRD_PATH, 2, "## 18. Progress\ntext\n", SLUG, ids), "§18")


if __name__ == "__main__":
    unittest.main()
