---
name: ask-panel
description: Add an Ask panel to any HTML report, page or artifact you show the user, so they ask questions in the page and the page's own Claude answers, never the session that made it. Use whenever you publish or open an HTML report, page or artifact for the user, and when they say "add ask", "ask questions from the page" or want to question a report.
---

# Ask panel

An "Ask" button (bottom right) opens a side panel on the page: question box, Haiku/Sonnet toggle, streamed answers, follow-ups in one thread, Stop, and select-text-then-"Ask about this" to quote a passage. One widget, two backends picked at runtime:

| Where the page is | Backend | Answers |
|---|---|---|
| claude.ai artifact | `claude.use("sample")`, on the viewer's own Claude | from the page text |
| served by `ask-open` | lens `serve.py` (`claude -p`, read-only) | page text, plus files in `--repo` |
| plain `file://` | none: the button never appears | n/a |

## Steps

1. **Publish as an Artifact:** `python3 ~/.claude/skills/ask-panel/scripts/inject.py report.html` (in place, or `-o out.html`), then publish that file with `capabilities: {sample: {}}`. Load the `artifact-capabilities` skill first, as for any capability.
2. **Show locally:** `~/.claude/skills/ask-panel/scripts/ask-open report.html [--repo DIR]`. It injects, starts the server and opens the browser. It runs until Ctrl-C, so start it as a background command. It serves only that report, on its own port. It gives the opened page the lens key, so only open trusted reports with it.
3. Tell the user the page has an Ask button. That is the whole handoff.

## Rules

- **Questions about the page belong in the page's panel.** Do not answer them in the session, and do not offer artifact comments for Q&A (comments route back to the session). If a question needs real work (code changes, new investigation), that is a new task, not a panel question.
- Inject is idempotent, and skips lens lessons (they have their own Ask).
- Artifact mode calls `sample` only on a click, never on load. `not_granted` and the other permanent codes hide the panel.
- Model text is rendered with DOM nodes only, never as HTML.

## Files

`assets/ask-panel.js`, `assets/ask-panel.css` (the widget, inlined by inject.py), `scripts/inject.py`, `scripts/ask-open`. The local backend is `~/.claude/skills/lens/scripts/serve.py`; it answers `POST /__lens/ask` with `mode: "report"` for pages that are not lens lessons.

Tests: `node ~/.claude/skills/ask-panel/scripts/test-panel.mjs` (Playwright, fake claude, no network), plus `python3 ~/.claude/skills/lens/scripts/test-serve.py` for the server.
