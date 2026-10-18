"""merge-card integration-branch guard tests. Each docstring names the production regression it catches."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

MERGE_CARD = Path(os.environ.get("MERGE_CARD") or Path(__file__).resolve().parent / "merge-card")


class MergeCardBranchGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo, self.orch = base / "repo", base / "orch"
        self.repo.mkdir()
        (self.orch / "demo").mkdir(parents=True)
        self.ledger = self.orch / "demo/ledger.md"
        self.ledger.write_text("# Ledger: demo\n", encoding="utf-8")
        self.git("init", "-q", "-b", "main")
        self.commit("base.txt", "base")
        self.git("branch", "crew/x")
        self.git("checkout", "-q", "-b", "card")
        self.commit("card.txt", "card work")
        self.git("checkout", "-q", "main")

    def git(self, *args):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=self.repo,
                              check=True, text=True, capture_output=True).stdout.strip()

    def commit(self, name, text):
        (self.repo / name).write_text(text, encoding="utf-8")
        self.git("add", name)
        self.git("commit", "-q", "-m", text)

    def merge_card(self, *args):
        env = dict(os.environ, ORCH_ROOT=str(self.orch), PLAN_BIN=str(self.repo / "no-plan"),
                   GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        return subprocess.run([str(MERGE_CARD), *args], cwd=self.repo, env=env, text=True, capture_output=True,
                              timeout=30)

    def assert_nothing_changed(self, head):
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        self.assertEqual(self.git("branch", "--show-current"), "main")
        self.assertFalse((self.repo / "card.txt").exists())
        self.assertEqual(self.ledger.read_text(encoding="utf-8"), "# Ledger: demo\n")

    def test_refuses_when_checkout_is_on_another_branch(self):
        """Running from main with --into crew/x (the 2026-10-17 incident) must refuse and leave main untouched."""
        head = self.git("rev-parse", "HEAD")
        result = self.merge_card("--into", "crew/x", "demo", "B1", "card", "--", "true")
        self.assertEqual(result.returncode, 2)
        self.assertIn("merge-card: checkout is on 'main', not on the integration branch 'crew/x'; nothing changed",
                      result.stderr)
        self.assert_nothing_changed(head)

    def test_refuses_on_detached_head(self):
        """A detached HEAD is not the integration branch; merging there would orphan the merge commit."""
        self.git("checkout", "-q", "--detach")
        head = self.git("rev-parse", "HEAD")
        result = self.merge_card("--into", "main", "demo", "B1", "card", "--", "true")
        self.assertEqual(result.returncode, 2)
        self.assertIn("checkout is on 'HEAD (detached)', not on the integration branch 'main'", result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        self.assertFalse((self.repo / "card.txt").exists())

    def test_old_positional_form_without_into_is_refused(self):
        """Callers that still omit the integration branch must fail loudly instead of merging into whatever is checked out."""
        head = self.git("rev-parse", "HEAD")
        result = self.merge_card("demo", "B1", "card", "--", "true")
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage: merge-card --into <integration-branch>", result.stderr)
        self.assert_nothing_changed(head)

    def test_matching_branch_merges_and_records(self):
        """The guard must not block the normal case: checkout on the named branch merges and writes the ledger line."""
        result = self.merge_card("--into", "main", "demo", "B1", "card", "--", "true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.repo / "card.txt").exists())
        self.assertEqual(self.git("log", "-1", "--format=%s"), "Merge card (card B1)")
        self.assertIn("- Merged B1: card (", self.ledger.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
