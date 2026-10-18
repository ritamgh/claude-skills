"""Text regression tests for the page-first rules in SKILL.md / questions.md.

Each test fails if the matching doc edit is reverted (the old terminal-first wording comes back).
"""
import re
import unittest
from pathlib import Path

SHAPE = Path(__file__).resolve().parents[1]
SKILL = (SHAPE / "SKILL.md").read_text()
QUESTIONS = (SHAPE / "reference" / "questions.md").read_text()


class TestSkillDocs(unittest.TestCase):
    def test_page_check_uses_plan_page(self):
        # Break caught: reverting to the curl probe, which only proves something listens on 7717.
        self.assertIn("plan page", SKILL)
        self.assertNotIn("%{http_code}", SKILL)

    def test_page_first_rule_is_stated(self):
        # Break caught: dropping the rule, so the session asks frontier questions in the terminal again.
        m = re.search(r"NOT call AskUserQuestion", SKILL)
        self.assertIsNotNone(m)
        self.assertIn("plan page", SKILL[max(0, m.start() - 400):m.end() + 400])

    def test_echo_rule_present(self):
        # Break caught: page answers no longer echoed in the terminal, so the two surfaces look unsynced.
        self.assertIn("answered on the page", SKILL)

    def test_ask_is_answered_with_reply_event(self):
        # Break caught: a page `ask` answered in prose or with `resolve`, so the user never sees it in the panel.
        self.assertIn('"type":"reply"', SKILL)

    def test_old_which_one_stands_rule_is_gone(self):
        # Break caught: the page answer stops being final and the user is asked twice again.
        self.assertNotIn("ask which one stands", SKILL)

    def test_terminal_mapping_is_labelled_fallback(self):
        # Break caught: the AskUserQuestion mapping presented as the default path.
        self.assertRegex(QUESTIONS, r"(?m)^## 4\. Terminal fallback")


if __name__ == "__main__":
    unittest.main()
