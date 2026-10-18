"""card-worktree and card-evidence tests (real git in temp dirs). Each docstring names the production regression it catches."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
CARD_WORKTREE = Path(os.environ.get("CARD_WORKTREE") or SCRIPTS / "card-worktree")
CARD_EVIDENCE = Path(os.environ.get("CARD_EVIDENCE") or SCRIPTS / "card-evidence")


class GitTempCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.repo = self.make_repo("repo")
        self.wt = self.base / "wts" / "card-a"

    def make_repo(self, name):
        repo = self.base / name
        repo.mkdir()
        self.git("init", "-q", "-b", "main", cwd=repo)
        (repo / "base.txt").write_text("base", encoding="utf-8")
        self.git("add", "base.txt", cwd=repo)
        self.git("commit", "-q", "-m", "base", cwd=repo)
        return repo

    def git(self, *args, cwd=None):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd or self.repo,
                              check=True, text=True, capture_output=True).stdout.strip()

    def run_script(self, script, *args, cwd=None, env=None):
        return subprocess.run([str(script), *map(str, args)], cwd=cwd or self.base, env=env, text=True,
                              capture_output=True, timeout=60)

    def commit_in(self, where, name, text):
        (Path(where) / name).write_text(text, encoding="utf-8")
        self.git("add", name, cwd=where)
        self.git("commit", "-q", "-m", text, cwd=where)


class CardWorktreeTests(GitTempCase):
    def worktree(self, *, repo=None, branch="card/a", wt=None, base="main", cwd=None):
        return self.run_script(CARD_WORKTREE, repo or self.repo, branch, wt or self.wt, base, cwd=cwd)

    def last_line(self, result):
        return result.stdout.strip().splitlines()[-1]

    def test_creates_branch_and_worktree_from_base(self):
        """A first run must make the branch off BASE and report the worktree HEAD sha, or the card starts from nothing."""
        result = self.worktree()
        head = self.git("rev-parse", "main")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.last_line(result), f"WORKTREE state=created wt={self.wt} branch=card/a head={head}")
        self.assertEqual(self.git("branch", "--show-current", cwd=self.wt), "card/a")
        self.assertTrue((self.wt / "base.txt").exists())

    def test_reused_keeps_uncommitted_work(self):
        """A rerun on a live worktree must not reset or clean it: the worker's uncommitted file has to survive."""
        self.worktree()
        (self.wt / "wip.txt").write_text("wip", encoding="utf-8")
        result = self.worktree()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(self.last_line(result), r"^WORKTREE state=reused wt=\S+ branch=card/a head=[0-9a-f]{40}$")
        self.assertEqual((self.wt / "wip.txt").read_text(encoding="utf-8"), "wip")

    def test_attaches_existing_branch_after_worktree_removed(self):
        """When the worktree dir is gone but the branch has commits, a rerun must re-attach it and keep those commits."""
        self.worktree()
        self.commit_in(self.wt, "work.txt", "card work")
        head = self.git("rev-parse", "HEAD", cwd=self.wt)
        self.git("worktree", "remove", str(self.wt))
        result = self.worktree()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.last_line(result), f"WORKTREE state=attached wt={self.wt} branch=card/a head={head}")
        self.assertEqual((self.wt / "work.txt").read_text(encoding="utf-8"), "card work")

    def test_attaches_after_worktree_dir_deleted_without_git(self):
        """A worktree dir removed with rm leaves stale metadata; the prune step must clear it so the branch can be re-attached."""
        self.worktree()
        self.commit_in(self.wt, "work.txt", "card work")
        head = self.git("rev-parse", "HEAD", cwd=self.wt)
        subprocess.run(["rm", "-rf", str(self.wt)], check=True)
        result = self.worktree()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.last_line(result), f"WORKTREE state=attached wt={self.wt} branch=card/a head={head}")

    def test_existing_dir_on_another_branch_is_an_error_and_untouched(self):
        """A worktree path already holding a different branch must be refused, not silently reused for the wrong card."""
        self.worktree(branch="card/other")
        (self.wt / "wip.txt").write_text("wip", encoding="utf-8")
        result = self.worktree(branch="card/a")
        self.assertEqual(result.returncode, 1)
        self.assertRegex(self.last_line(result), r"^WORKTREE-ERROR .+")
        self.assertEqual(self.git("branch", "--show-current", cwd=self.wt), "card/other")
        self.assertTrue((self.wt / "wip.txt").exists())
        self.assertFalse(self.last_line(result).startswith("WORKTREE "))

    def test_existing_plain_directory_is_an_error_and_untouched(self):
        """A directory that is not a registered worktree must never be adopted or overwritten."""
        self.wt.mkdir(parents=True)
        (self.wt / "keep.txt").write_text("keep", encoding="utf-8")
        result = self.worktree()
        self.assertEqual(result.returncode, 1)
        self.assertRegex(self.last_line(result), r"^WORKTREE-ERROR ")
        self.assertEqual((self.wt / "keep.txt").read_text(encoding="utf-8"), "keep")

    def test_branch_checked_out_elsewhere_is_an_error(self):
        """Git refuses a branch that another worktree holds; the failure must surface as WORKTREE-ERROR with git's message."""
        self.worktree()
        other = self.base / "wts" / "card-b"
        result = self.worktree(wt=other)
        self.assertEqual(result.returncode, 1)
        self.assertRegex(self.last_line(result), r"^WORKTREE-ERROR .*card/a")
        self.assertFalse(other.exists())

    def test_bad_base_is_an_error(self):
        """A base ref that does not resolve must fail loudly instead of printing a worktree that was never made."""
        result = self.worktree(base="no-such-ref")
        self.assertEqual(result.returncode, 1)
        self.assertRegex(self.last_line(result), r"^WORKTREE-ERROR ")
        self.assertFalse(self.wt.exists())

    def test_repo_may_be_a_subdirectory(self):
        """REPO is any path inside the repo; passing a subdirectory must resolve to the top level."""
        sub = self.repo / "sub" / "dir"
        sub.mkdir(parents=True)
        result = self.worktree(repo=sub)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("branch", "--show-current", cwd=self.wt), "card/a")

    def test_worktree_is_made_in_the_target_repo_not_the_process_cwd(self):
        """The original bug: the worktree was made from the launch repo. Run from repo B, target repo A: the worktree must belong to A."""
        other = self.make_repo("other")
        result = self.worktree(cwd=other)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("rev-parse", "--git-common-dir", cwd=self.wt),
                         str(self.repo / ".git"))
        self.assertIn(f"worktree {self.wt}", self.git("worktree", "list", "--porcelain", cwd=self.repo))
        self.assertNotIn("card/a", self.git("branch", "--list", cwd=other))
        self.assertEqual(self.git("worktree", "list", "--porcelain", cwd=other).count("worktree "), 1)

    def test_relative_worktree_path_is_printed_absolute(self):
        """The caller may pass a relative WT; the WORKTREE line must still carry an absolute path."""
        result = self.run_script(CARD_WORKTREE, self.repo, "card/a", "rel/wt", "main", cwd=self.base)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"wt={self.base / 'rel/wt'} ", self.last_line(result))

    def test_git_noise_goes_to_stderr(self):
        """Only the final WORKTREE line may be on stdout; git chatter on stdout would break the runner's parsing."""
        result = self.worktree()
        self.assertEqual(len(result.stdout.strip().splitlines()), 1, result.stdout)

    def test_bad_usage_exits_2(self):
        """Missing arguments must exit 2 with usage on stderr, not run git with empty values."""
        result = self.run_script(CARD_WORKTREE, self.repo, "card/a")
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage: card-worktree", result.stderr)


class CardEvidenceTests(GitTempCase):
    def setUp(self):
        super().setUp()
        self.git("worktree", "add", "-q", "-b", "card/a", str(self.wt), "main")

    def evidence(self, *check, branch="card/a", wt=None, env=None):
        args = [self.repo, "main", branch, wt or self.wt]
        if check:
            args += ["--", *check]
        return self.run_script(CARD_EVIDENCE, *args, env=env)

    def last_line(self, result):
        return result.stdout.strip().splitlines()[-1]

    def test_no_commits_skips_the_check(self):
        """A card with no commits must not run its check (it would pass on the untouched base) and must say skipped."""
        marker = self.base / "ran"
        result = self.evidence(f"touch {marker}")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.last_line(result), "EVIDENCE commits=0 dirty=0 check=skipped")
        self.assertFalse(marker.exists())
        self.assertNotIn("--- check tail ---", result.stdout)

    def test_commits_and_passing_check_show_tail(self):
        """Two commits plus a passing check must report commits=2 check=0 and print the check output between the markers."""
        self.commit_in(self.wt, "a.txt", "one")
        self.commit_in(self.wt, "b.txt", "two")
        result = self.evidence("echo checked-in-$(basename $PWD); ls b.txt; echo last-line")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.last_line(result), "EVIDENCE commits=2 dirty=0 check=0")
        self.assertIn("--- check tail ---\nchecked-in-card-a\n", result.stdout)
        self.assertIn("b.txt\nlast-line\n--- end ---\n", result.stdout)

    def test_failing_check_is_data_not_an_error(self):
        """A failing check must be reported as its exit code with exit 0; exiting nonzero would look like a crashed helper."""
        self.commit_in(self.wt, "a.txt", "one")
        result = self.evidence("echo boom >&2; exit 7")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.last_line(result), "EVIDENCE commits=1 dirty=0 check=7")
        self.assertIn("--- check tail ---\nboom\n--- end ---", result.stdout)

    def test_tail_is_limited_to_last_15_lines(self):
        """A chatty check must not flood the runner: only the last 15 lines of combined output are printed."""
        self.commit_in(self.wt, "a.txt", "one")
        result = self.evidence("seq 1 40")
        body = result.stdout.split("--- check tail ---\n")[1].split("--- end ---")[0]
        self.assertEqual(body.splitlines(), [str(n) for n in range(26, 41)])

    def test_missing_branch_counts_zero_commits(self):
        """A branch that was never created is zero commits, not a git error."""
        result = self.evidence("true", branch="card/never")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.last_line(result), "EVIDENCE commits=0 dirty=0 check=skipped")

    def test_missing_worktree_reports_dirty_minus_one_and_skips(self):
        """With the worktree gone the check cannot run; dirty=-1 tells the caller the worktree is missing."""
        self.commit_in(self.wt, "a.txt", "one")
        self.git("worktree", "remove", str(self.wt))
        result = self.evidence("true")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.last_line(result), "EVIDENCE commits=1 dirty=-1 check=skipped")

    def test_no_check_given_reports_none(self):
        """Without a CHECK the evidence is only commits and dirty; check must read none, not skipped or 0."""
        self.commit_in(self.wt, "a.txt", "one")
        (self.wt / "wip.txt").write_text("wip", encoding="utf-8")
        result = self.evidence()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.last_line(result), "EVIDENCE commits=1 dirty=1 check=none")

    def test_dirty_counts_uncommitted_and_untracked_files(self):
        """Uncommitted worker output is the signal a card half-finished; every porcelain line must be counted."""
        self.commit_in(self.wt, "a.txt", "one")
        (self.wt / "a.txt").write_text("changed", encoding="utf-8")
        (self.wt / "new1.txt").write_text("x", encoding="utf-8")
        (self.wt / "new2.txt").write_text("x", encoding="utf-8")
        result = self.evidence("true")
        self.assertEqual(self.last_line(result), "EVIDENCE commits=1 dirty=3 check=0")

    def test_repo_and_worktree_are_unchanged(self):
        """The helper only observes: refs, HEAD, index and files must be identical before and after it runs."""
        self.commit_in(self.wt, "a.txt", "one")
        (self.wt / "wip.txt").write_text("wip", encoding="utf-8")
        before = (self.git("for-each-ref"), self.git("status", "--porcelain", cwd=self.wt),
                  self.git("worktree", "list", "--porcelain"), sorted(p.name for p in self.wt.iterdir()))
        self.evidence("cat a.txt")
        after = (self.git("for-each-ref"), self.git("status", "--porcelain", cwd=self.wt),
                 self.git("worktree", "list", "--porcelain"), sorted(p.name for p in self.wt.iterdir()))
        self.assertEqual(before, after)

    def test_check_timeout_comes_from_env(self):
        """A hung check must be killed at CARD_CHECK_TIMEOUT and reported as 124, not block the runner forever."""
        self.commit_in(self.wt, "a.txt", "one")
        env = dict(os.environ, CARD_CHECK_TIMEOUT="1")
        result = self.evidence("sleep 30", env=env)
        self.assertEqual(self.last_line(result), "EVIDENCE commits=1 dirty=0 check=124")

    def test_bad_usage_exits_2(self):
        """Too few arguments, or a fifth argument that is not --, must exit 2 with usage."""
        for args in ([self.repo, "main", "card/a"], [self.repo, "main", "card/a", self.wt, "true"]):
            result = self.run_script(CARD_EVIDENCE, *args)
            self.assertEqual(result.returncode, 2)
            self.assertIn("usage: card-evidence", result.stderr)


if __name__ == "__main__":
    unittest.main()
