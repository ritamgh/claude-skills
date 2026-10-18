"""prd-review SKILL.md: every value that comes from the PR link is checked before it reaches a command, and quoted there."""
import re
import unittest
from pathlib import Path

SKILL = (Path(__file__).resolve().parents[2] / "prd-review" / "SKILL.md").read_text(encoding="utf-8")


class PrdReviewSkillTests(unittest.TestCase):
    def test_owner_repo_and_number_are_allowlisted_before_use(self):
        """A `{owner}/{repo}/{n}` taken from a pasted link and used unchecked can carry shell syntax into the gh command lines."""
        self.assertIn("`{owner}` and `{repo}` must match `^[A-Za-z0-9._-]+$`", SKILL)
        self.assertIn("`{n}` must be digits (`^[0-9]+$`)", SKILL)

    def test_every_command_that_names_them_single_quotes_the_endpoint(self):
        """An unquoted repos/{owner}/{repo}/... endpoint is word-split and glob-expanded by the shell."""
        for line in SKILL.splitlines():
            if "repos/{owner}" in line and "gh api" in line:
                self.assertRegex(line, r"gh api '[^']*repos/\{owner\}[^']*'", line)
            elif "repos/{owner}" in line:
                self.assertRegex(line, r"'[^']*repos/\{owner\}[^']*'", line)  # prose that names an endpoint quotes it too
        self.assertFalse(re.search(r"""(?<!['\w/])repos/\{owner\}""", SKILL))


if __name__ == "__main__":
    unittest.main()
