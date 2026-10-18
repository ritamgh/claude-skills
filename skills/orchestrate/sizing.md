# Sizing task cards

Worker quality drops and cost climbs as context grows: every turn re-reads the whole
context. A worker at 300k pays for 300k on each tool call. Small cards keep each worker
short and focused, and a failed card is cheap to redo.

## The limit

A card must have:
- **one concern**: one bug class or one feature slice, describable in one sentence;
- **≤ ~5 owned files** (tests included);
- **one acceptance check** (a command that passes or fails);
- **expected context ≤ ~120k**: a rough guess from files to read plus turns needed. A
  worker that reads ~10 medium files and runs ~40 tool calls is around 100k.

If a card fails any of these, split it before launch.

## How to split

1. **By concern first.** Each bug class, feature slice or migration step is its own card.
   A plan item list like "A1–A7" in one brief is the main red flag.
2. **Same file, different concerns → chain.** Don't merge them into one worker because the
   files overlap. Run them as `chain.js` steps: step 2 starts from step 1's
   branch and HANDOFF.
3. **Different files, independent → wave.** They run in parallel with `wave.js`.
4. **Shared contract first.** If cards depend on a new interface, make a tiny first card (or
   a chain step 1) that adds it; post it to the board as a DECISION.
5. **Scripts and reports are their own cards** (replay scripts, eval runners, docs).

When to merge instead: two cards that would each change < ~10 lines in the same file for
the same concern. Merging them costs less than a chain hop.

## Red flags in a draft decomposition

- One card owns > 5 files or lists several plan items.
- "Owner: me" on anything beyond a ≤ ~20-line integration fix.
- A check like "pytest green + report" that covers several concerns at once.
- A worker brief that pastes large content instead of giving paths to read.
- A card whose notes file will need several sections to explain what's done.

## Worked example: ladder-fixes Task A (2026-09-27)

**Before:** one card, one Sonnet worker.

| id | owns | check |
|---|---|---|
| A | checks.py, verifier.py, 2 prompt files, ladder.py (rung3/rung4 parts), 3 test files, scripts/replay_checks.py, rung3/rung4 configs (~11 files) | pytest green + replay report |

It covered plan items A1–A7 (6 bug classes). Result: **290 turns, 321k peak context**,
one rework, and the orchestrator added its own fixes on top. Meanwhile the orchestrator
kept B2 and C for itself ("owner: me") and ran at ~250k.

**After:** five cards, one chain plus a parallel wave.

| id | concern | owns | check | runs as |
|---|---|---|---|---|
| A-1 | unit/grounding false positives in the checks | checks.py, tests/test_checks.py | `pytest -q tests/test_checks.py -k "unit or grounding"` | chain A, step 1 |
| A-2 | sig-fig and negation false positives | checks.py, tests/test_checks.py | `pytest -q tests/test_checks.py -k "sigfig or negation"` | chain A, step 2 (after A-1's HANDOFF) |
| A-3 | verifier v0.2 prompt + calibration | verifier.py, prompts/verifier-v0.2.txt, tests/test_verifier.py | `pytest -q tests/test_verifier.py` | wave |
| A-4 | targeted fallback (never send a failing draft) | ladder.py (rung3/rung4), prompts/r3-v0.2.txt, configs/rung3.*, tests/test_ladder.py | `pytest -q tests/test_ladder.py -k fallback` | wave |
| A-5 | replay script for check false positives | scripts/replay_checks.py | `python scripts/replay_checks.py --limit 20` exits 0 with a report | direct call, after chain A merges |

B2 (the multi-turn loop) and C (configs + smoke) become cards too. The orchestrator only
merges, runs the full `pytest -q`, and handles the D cost gate with the user.
Each card now needs a handful of files and one check, so each worker should finish around
50–100k. The size watcher still covers the case where one doesn't.
