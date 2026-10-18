"""merge-card plan sync tests. Each docstring names the production regression it catches."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

MERGE_CARD = Path(os.environ.get("MERGE_CARD") or Path(__file__).resolve().parent / "merge-card")
FAKE_PLAN = """#!/usr/bin/env bash
{ printf 'call'; printf ' %s' "$@"; printf '\\n'; } >> "$FAKE_PLAN_LOG"
printf '%s\\n' "$@" > "$FAKE_PLAN_LOG.last"
if [ -n "${FAKE_PLAN_FAIL:-}" ]; then echo "plan: no plan for $2" >&2; exit 3; fi
echo '{"ok":true}'
"""


class MergeCardPlanSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo, self.orch = base / "repo", base / "orch"
        self.log = base / "plan-calls.log"
        self.plan_bin = base / "fake-plan"
        self.plan_bin.write_text(FAKE_PLAN, encoding="utf-8")
        self.plan_bin.chmod(0o755)
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.commit("base.txt", "base")
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

    def merge(self, ledger_text, card_id="T-001", fail=False, extra_env=None):
        (self.orch / "demo").mkdir(parents=True, exist_ok=True)
        (self.orch / "demo/ledger.md").write_text(ledger_text, encoding="utf-8")
        env = dict(os.environ, ORCH_ROOT=str(self.orch), PLAN_BIN=str(self.plan_bin), FAKE_PLAN_LOG=str(self.log),
                   GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        if fail:
            env["FAKE_PLAN_FAIL"] = "1"
        env.update(extra_env or {})
        return subprocess.run([str(MERGE_CARD), "--into", "main", "demo", card_id, "card", "--", "true"], cwd=self.repo, env=env,
                              text=True, capture_output=True, timeout=30)

    def calls(self):
        return self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else []

    def test_linked_plan_task_card_marks_task_done(self):
        """Dropping the hook, a wrong argv, or a wrong sha/node/status in the event JSON must fail."""
        result = self.merge("# Ledger: demo\n\nPlan: 1020-cli-json-flag\n\n## Tasks\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        sha = self.git("rev-parse", "--short", "HEAD")
        self.assertEqual(len(self.calls()), 1)
        argv = Path(str(self.log) + ".last").read_text(encoding="utf-8").splitlines()
        self.assertEqual(argv[:5], ["event", "1020-cli-json-flag", "--source", "build", "--json"])
        self.assertEqual(json.loads(argv[5]), {"type": "task_status", "node": "T-001", "status": "done",
                                               "ok": True, "note": "merged " + sha})
        self.assertEqual(len(argv), 6)

    def test_non_task_card_id_makes_no_call(self):
        """Syncing a card id that is not T-### (B3, T-1, T-0012) would send events plan rejects."""
        for card in ("B3", "T-1", "T-0012", "xT-001"):
            result = self.merge("Plan: 1020-cli-json-flag\n", card_id=card)  # later merges are no-ops
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.calls(), [], card)

    def test_unlinked_ledger_makes_no_call(self):
        """Calling plan for an orchestration with no 'Plan:' line must fail."""
        result = self.merge("# Ledger: demo\n\nGoal mentions Plan: not at line start\n  Plan: indented\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [])

    def test_failing_plan_warns_and_keeps_exit_zero(self):
        """A plan failure that changes merge-card's exit code, or that is not reported on stderr, must fail."""
        result = self.merge("Plan: 1020-cli-json-flag\n", fail=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("merge-card: plan sync failed: plan: no plan for 1020-cli-json-flag", result.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assertIn("- Merged T-001: card", (self.orch / "demo/ledger.md").read_text(encoding="utf-8"))

    def test_missing_plan_binary_warns_and_keeps_exit_zero(self):
        """An absent plan executable must not abort merge-card after the merge was recorded."""
        result = self.merge("Plan: 1020-cli-json-flag\n", extra_env={"PLAN_BIN": str(self.plan_bin) + "-gone"})
        self.assertEqual(result.returncode, 0)
        self.assertIn("merge-card: plan sync failed:", result.stderr)

    def test_red_validation_makes_no_call(self):
        """Syncing before validation is green (card not recorded) must fail."""
        (self.orch / "demo").mkdir(parents=True)
        (self.orch / "demo/ledger.md").write_text("Plan: 1020-cli-json-flag\n", encoding="utf-8")
        env = dict(os.environ, ORCH_ROOT=str(self.orch), PLAN_BIN=str(self.plan_bin), FAKE_PLAN_LOG=str(self.log),
                   GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        result = subprocess.run([str(MERGE_CARD), "--into", "main", "demo", "T-001", "card", "--", "false"], cwd=self.repo, env=env,
                                text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
