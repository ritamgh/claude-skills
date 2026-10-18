# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Theme templates in `assets/themes/` (one self-contained HTML file each; `zine` is the default). `scripts/build.py` injects one lesson JSON object at `__LESSON_JSON__`. Vanilla JS and CSS. No build step and no framework. External scripts only from cdnjs, jsdelivr, unpkg; stylesheets only from Google Fonts.

## Users

One developer and researcher (the skill's owner) who is learning unfamiliar or AI-written codebases, such as a Python PDF-extraction pipeline. They read lessons on a large monitor (24"+, full-screen), often for long stretches, to understand how the code moves real data, and they come back days later to re-check. Phone or tablet review is occasional.

## Product Purpose

`/lens` turns a question about code ("explain the two extraction paths") into one interactive lesson page. Success means the reader can explain the flow in their own words afterwards, predict what the code does, and knows where it is weak. Failure means a page that looks like a dashboard to skim, not something to learn from.

## Positioning

The lesson is grounded in real code moving real data: verbatim snippets with real line numbers (checked against the repo), the actual values in memory at each step (often captured by running the code), confidence labels on every claim, and predict-before-reveal gates. Generic doc generators and chat answers do not trace one concrete input through the system, and they do not show state.

## Operating Context

- Built by Claude inside a coding session and opened locally from `<repo>/.lens/NNNN-slug.html`; sometimes published as a claude.ai Artifact.
- Confirmed reading preference: a scrolling article (overview map at the top, then each step as a section, interactive pieces inline), not a dense multi-panel explorer.
- Lessons are re-visited; progress (quiz misses, answered gates) is stored per lesson id in localStorage.

## Capabilities and Constraints

Every capability of the lesson schema (`reference/lesson-schema.md`) must keep working:
- System map: layers (columns), nodes with label/kind/files, edges with labels, optional row/col overrides, route highlighting, "Impact" mode (follow edges backwards), click a node to open its detail (simple/deep, analogy, functions with code).
- 1 to 3 traces, 5 to 12 steps each: title, node, simple/deep text, confidence, verbatim code with highlighted lines and per-line notes, state rows (name, value, changed), optional predict gate that blurs content until answered, optional aside.
- Plain/Deep toggle (P/D keys), arrow-key navigation, "Copy question for Claude".
- Break-it experiments (affected nodes painted on the map), design decisions with alternatives, weak spots with severity, quiz (4 to 6, missed questions resurface), glossary terms become hover tooltips in all text.
- Light and dark themes (system preference plus manual toggle).
- No horizontal scroll at 390 px; 16 px side gutter.
- `scripts/smoke.mjs` and `scripts/test-template.mjs` drive the page through DOM selectors; each theme honours the selector contract in `reference/themes.md` and has its own suite in `scripts/theme-tests/`.

## Evidence on Hand

- The zine redesign was tuned on a real lesson of 10 nodes, 13 edges, 2 traces (11 and 10 steps), 4 break-its, 3 decisions, 6 weak spots, 6 quiz questions, 11 glossary terms.
- Worked example lesson in the skill: `examples/jw-ask-flow.json`.
- User feedback on the current template (2026-10-04): font too small and hard to see; looks dull and clinical; the system map is unreadable.

## Product Principles

1. Reading comfort first: long-form text at a size and measure that is pleasant on a large monitor for an hour.
2. One thing in focus at a time; the rest is reachable, not competing.
3. The map must be legible at a glance and is the reader's orientation throughout.
4. Real code and real values are the hero; decoration never outranks them.
5. Make the reader think before telling them.

## Accessibility & Inclusion

Comfortable reading size (body at least 18 px on desktop), WCAG AA contrast in both themes, full keyboard use, reduced-motion respected.
