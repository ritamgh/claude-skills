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


COMMENTS = (SHAPE / "reference" / "comments.md").read_text()
PRD_REVIEW = (SHAPE.parent / "prd-review" / "SKILL.md").read_text()
CONTRACT = (SHAPE / "reference" / "contract.md").read_text()


class TestPlainWordsRule(unittest.TestCase):
    def test_shape_skill_says_label_first_with_the_id_in_brackets(self):
        # Break caught: deleting the rule, so replies go back to bare ids ("T-017 needs a decision") the user cannot read.
        self.assertIn("label first with the id in brackets", SKILL)
        self.assertIn("(T-017)", SKILL)

    def test_comments_playbook_says_it_for_replies_proposals_and_gist(self):
        # Break caught: the playbook losing the rule or the gist field the page renders above the comment.
        section = COMMENTS[COMMENTS.index("## 0. Plain words"):COMMENTS.index("## 1. Woken by a comment")]
        self.assertIn("label first with the id in brackets", section)
        for word in ("reply", "proposal", "gist", "300"):
            self.assertIn(word, section)
        self.assertIn('"gist":', COMMENTS)

    def test_prd_review_keeps_the_anchor_and_asks_for_words_in_the_body(self):
        # Break caught: dropping the rule from the reviewer's skill, or weakening the `[FR-003] blocker:` anchor it must keep.
        self.assertIn("label first with its id in brackets", PRD_REVIEW)
        self.assertIn("anchor stays exactly as it is", PRD_REVIEW)
        self.assertIn("Comment body, exactly: `[FR-003] blocker: <text>`", PRD_REVIEW)

    def test_contract_documents_the_gist_field(self):
        # Break caught: the schema doc forgetting the optional comment key the validator accepts.
        self.assertRegex(CONTRACT, r"(?s)Optional key `gist`.{0,250}str ≤ 300")


if __name__ == "__main__":
    unittest.main()
