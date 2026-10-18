"""merge-card pending-wake hook tests. Each docstring names the production regression it catches."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

MERGE_CARD = Path(os.environ.get("MERGE_CARD") or Path(__file__).resolve().parent / "merge-card")
FAKE_CREW = """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_CREW_LOG.argv"
echo x >> "$FAKE_CREW_LOG.calls"
grep -c '^- Merged' "$FAKE_CREW_LEDGER" > "$FAKE_CREW_LOG.ledger" || true
if [ -n "${FAKE_CREW_FAIL:-}" ]; then echo "crew: refused: boom" >&2; exit 3; fi
echo "wake pending: web"
echo "wake pending: docs"
"""


class MergeCardWakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo, self.orch = base / "repo", base / "orch"
        self.log = base / "crew"
        self.crew_bin = base / "fake-crew"
        self.crew_bin.write_text(FAKE_CREW, encoding="utf-8")
        self.crew_bin.chmod(0o755)
        self.ledger = self.orch / "demo/ledger.md"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.commit("base.txt", "base")
        self.git("checkout", "-q", "-b", "card")
        self.commit("card.txt", "card work")
        self.git("checkout", "-q", "main")
        self.ledger.parent.mkdir(parents=True)
        self.ledger.write_text("# Ledger: demo\n", encoding="utf-8")

    def git(self, *args):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=self.repo,
                              check=True, text=True, capture_output=True).stdout.strip()

    def commit(self, name, text):
        (self.repo / name).write_text(text, encoding="utf-8")
        self.git("add", name)
        self.git("commit", "-q", "-m", text)

    def merge(self, validation="true", crew=None, fail=False):
        env = dict(os.environ, ORCH_ROOT=str(self.orch), CREW_EXE=str(crew or self.crew_bin),
                   FAKE_CREW_LOG=str(self.log), FAKE_CREW_LEDGER=str(self.ledger),
                   GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        if fail:
            env["FAKE_CREW_FAIL"] = "1"
        return subprocess.run([str(MERGE_CARD), "--into", "main", "demo", "C3", "card", "--", validation], cwd=self.repo,
                              env=env, text=True, capture_output=True, timeout=30)

    def calls(self):
        path = Path(str(self.log) + ".calls")
        return len(path.read_text(encoding="utf-8").splitlines()) if path.exists() else 0

    def test_green_merge_records_a_wake_and_prints_the_owners(self):
        """Dropping the hook, a wrong ref (not HEAD^1), a wrong --change text/sha, or not printing crew's stdout must fail."""
        result = self.merge()
        self.assertEqual(result.returncode, 0, result.stderr)
        sha = self.git("rev-parse", "--short", "HEAD")
        argv = Path(str(self.log) + ".argv").read_text(encoding="utf-8").splitlines()
        self.assertEqual(argv, ["owners", "--record-wake", "HEAD^1", "--change", f"card (card C3, {sha})"])
        self.assertEqual(self.calls(), 1)
        self.assertIn("wake pending: web\nwake pending: docs\n", result.stdout)

    def test_wake_is_recorded_after_the_ledger_line(self):
        """Recording a wake before the green ledger line is written (so a crash leaves a wake with no ledger entry) must fail."""
        self.merge()
        self.assertEqual(Path(str(self.log) + ".ledger").read_text(encoding="utf-8").strip(), "1")

    def test_failing_crew_keeps_exit_zero_and_the_ledger_line(self):
        """A crew failure that changes merge-card's exit code, loses the ledger line, or leaks crew's stderr must fail."""
        result = self.merge(fail=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), 1)
        self.assertIn("- Merged C3: card", self.ledger.read_text(encoding="utf-8"))
        self.assertNotIn("boom", result.stderr)
        self.assertNotIn("wake pending", result.stdout)

    def test_missing_crew_binary_keeps_exit_zero(self):
        """An absent crew executable aborting merge-card under set -e after the merge was recorded must fail."""
        result = self.merge(crew=self.crew_bin.with_name("no-such-crew"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("- Merged C3: card", self.ledger.read_text(encoding="utf-8"))

    def test_red_validation_makes_no_crew_call(self):
        """Recording a wake for a merge whose validation failed (nothing recorded in the ledger) must fail."""
        result = self.merge(validation="false")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.calls(), 0)


if __name__ == "__main__":
    unittest.main()
