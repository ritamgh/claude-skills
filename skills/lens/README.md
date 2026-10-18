# lens: a Claude Code skill that teaches you a codebase

Ask Claude how some code works and `/lens` builds you one interactive HTML lesson instead of a wall of text. The lesson follows a real input through the real code: a sketched system map you can click, numbered stops with verbatim code and handwritten notes on the lines that matter, an "In memory now" note showing the actual values at each stop, guess-before-you-read checkpoints, "break it" experiments, design trade-offs, weak spots, and a short quiz that remembers what you missed.

## Install

1. Put this folder at `~/.claude/skills/lens/`, so that `~/.claude/skills/lens/SKILL.md` exists:
   ```bash
   mkdir -p ~/.claude/skills && unzip lens-skill.zip -d ~/.claude/skills/
   ```
2. Restart Claude Code (or start a new session). `/lens` appears in the skill list.

Requirements (unchanged by the two switches below, which add no dependencies): Claude Code and Python 3 (to build lessons). Optional: Node 18+ and Playwright for the automatic render check, which runs a headless browser over each lesson:

```bash
npm i -g playwright && npx playwright install chromium
```

Without Playwright the check prints `skip` and everything else still works.

## Use

In a repo, ask things like:

- `/lens how does authentication work`
- `/lens what happens when I run make deploy`
- `/lens src/payments/refund.py`
- `/lens explain today's diff`
- `/lens` with no argument for an overview of the whole repo

Claude reads the code, writes the lesson, and saves it as `.lens/0001-<topic>.html` in the repo (kept out of git), then opens it in your browser through a small local helper (`scripts/serve.py`, at `http://127.0.0.1:4174/`). In the lesson: scroll, or press J/K to move between stops; P/D switches Plain and Deep explanations; 1-3 answer a guess; click any box on the map to read about it.

**Ask about anything.** Select any text in a lesson and press **Ask Claude** (or A). A side panel opens with Haiku (switch to Sonnet for harder "why" questions) and quick buttons like "Explain it simply". Claude can read the repo the lesson is about, so it answers from the real code and cites file:line, but it cannot change anything. Ask follow-ups in the same panel; "New chat" starts over. This uses your own Claude Code login, so there is no API key to set up, and each question counts toward your normal Claude Code usage. The helper only listens on your own machine and only answers tabs opened from the link it prints. It also ignores the explained repo's own Claude settings and hooks, so asking about a repo you cloned is safe.

To reopen an old lesson with asking turned on:

```bash
python3 ~/.claude/skills/lens/scripts/serve.py .lens/0001-<topic>.html --open
```

Double-clicking the HTML file still works; the Ask buttons then copy a question for you to paste into Claude instead.

## Two switches

Every lesson has two independent choices, and any mix works.

**Theme: how it looks.** `zine` is the default: a hand-made tech zine. `sketch` is a white-paper ink look: black line art, red/orange/blue handwriting, and Blot, a small black-blob mascot who acts out each idea in a little scene (dark mode becomes a blackboard).

- `/lens how does auth work, sketch style`
- `/lens src/payments/refund.py, whiteboard doodle`

Sketch pictures are specific to the system: each component gets an icon (`prop`), architecture-mode nodes get a plate drawn from their real neighbours and edge payloads, and scenes can name the real things that move.

Beyond the 12 stock scenes, the lesson author can draw a bespoke picture per idea (`scene.draw`): a short list of ops (Blot, props, boxes, packets, arrows, notes) on a 16 x 9 grid, rendered by the same hand-drawn pen, never raw SVG. `scripts/scene-preview.mjs` renders a drawing in a headless browser and reports overlaps, anything outside the frame and unknown ops, so the author can fix it before it goes into the lesson.

**Mode: what it teaches.** `code` is the default: one input traced through real code. `architecture` is a deep dive on structure: components and what each owns, the protocols between them, invariants that must hold, pressure points, failure modes with blast radius, and the decisions behind it. Claude picks it when you ask about design, boundaries, trade-offs, scaling or failure modes.

- `/lens architecture deep dive of the payments service`
- `/lens how is this system designed, what breaks first under load`

A finished lesson is just data, so you can switch the look without regenerating anything: `python3 ~/.claude/skills/lens/scripts/build.py lesson.json out.html --theme sketch` (or `--theme zine`). Set `LENS_THEME=sketch` to make it your default. The keys are the same in both themes.

## What is in here

| Path | What it is |
|---|---|
| `SKILL.md` | The instructions Claude follows to research and write a lesson. |
| `assets/themes/zine.html` | The page design (the "zine" theme, the default). Lessons are data; the theme renders them. |
| `assets/themes/sketch.html` | The white-paper ink theme, with Blot. Renders both modes. |
| `assets/themes/parts/scenes.js` | The 12 Blot scenes and the `draw` engine for custom drawings (SVG), shared into the sketch theme at build time. |
| `assets/themes/parts/props.js` | The icon library (camera, database, chip...) for components in sketch pictures; included before `scenes.js`. |
| `scripts/build.py` | Validates a lesson (modes, architecture fields, scenes), checks every code snippet against the real file, writes the HTML (`--theme NAME` to pick a theme). |
| `scripts/serve.py` | The local helper behind Ask Claude: serves `.lens/` on 127.0.0.1 and runs `claude -p` (read-only tools) for each question. |
| `scripts/smoke.mjs`, `scripts/test-template.mjs`, `scripts/test-ask.mjs`, `scripts/test-serve.py` | Render check for a lesson (either theme), and the tests (the ask tests use a fake `claude`, so they cost nothing). |
| `scripts/test-build.py`, `scripts/scenes-gallery.mjs`, `scripts/testdata/arch-mini.json` | Tests for the build and validation, a checker and screenshot gallery for the scenes, and the small architecture lesson the theme tests use. |
| `scripts/scene-preview.mjs` | Renders one custom drawing (`scene.draw`) to a PNG and prints a JSON verdict (overlaps, outside, unknown ops, smallest text); needs Playwright. |
| `scripts/props-gallery.mjs`, `scripts/testdata/arch-ctx.json` | Checker and screenshot gallery for the prop icons, and the architecture lesson (hub, lone node, authored scene) the context-plate tests use. |
| `reference/lesson-schema.md`, `reference/themes.md` | The lesson format, and how to make your own theme. |
| `examples/lens-architecture.*` | A worked architecture-mode lesson: lens explaining its own design, with scenes. Its snippets are the skill's own files, so it can be re-checked on your machine. |
| `examples/jw-ask-flow.*` | A complete worked code-mode lesson. It explains a small shell script from the author's own setup, so it is there to show tone and depth; you will not have that script, so its code cannot be re-checked on your machine. |
| `DESIGN.md`, `PRODUCT.md`, `.impeccable/` | Design notes for the zine theme. |

## Acknowledgements

The sketch theme's look is inspired by [helloianneo/ian-xiaohei-illustrations](https://github.com/helloianneo/ian-xiaohei-illustrations) (MIT), a prompt skill for generated images. lens recreates the look as SVG with its own original mascot, "Blot".
