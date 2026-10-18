---
name: orchestrate
description: Deep mode a lead (the main session or a crew sub-lead) switches into on its own when a task needs several workers, waves, or a verify/fix loop. Decomposes into small task cards, routes them to Claude subagents and jcode workers (sol; astra only when strictly necessary), watches their size, verifies, merges and QA-gates, and reports through crew (crew log, holds, summary). One bounded change is a crew worker instead; a part that needs its own conversation or long loop is `crew spawn`. Also when asked to "orchestrate", "fan out", "use workers/subagents/jcode", or "parallelize".
argument-hint: "[plan-file-or-task] [--mode A|B] [--resume <slug>]"
---

# /orchestrate: a lead's deep mode

The lead owns the outcome: decomposition, routing, size watching, verification, integration,
final report. **Crew is the tracker and the voice** (`crew` skill): the run is a crew task, and
its progress, questions and result go through `crew`, so HQ, digests and phone alerts see it
like any other task. This skill adds what crew lacks: cards, waves, merges, QA. Model routing is in §5 here and
crew §2; permissions, rulings, `jw review`/`jw usage` and "workers never spawn agents" live in
CLAUDE.md ("Roles", "Delegation", "Execution discipline") and the crew skill; `/orchestrate` counts as
Workflow opt-in. Skill files are named where a step needs them. Companion: `jcode-workers`.

## 0. Worker, sub-lead, or orchestrate? (leads decide this themselves)

| The task | Use |
|---|---|
| Quick, and you already hold the context | do it yourself |
| One bounded change: one concern, one check | a crew worker (crew §2) |
| Complex work that would take too much of your time or context, or needs its own conversation with the user | `crew spawn` a sub-lead (crew §4); it runs `/orchestrate` if it needs to |
| Several workers, waves, or a verify/fix loop | `/orchestrate` (this skill) |

Apply it to every request; the user never has to ask. Balance cost against quality and
context: neither the cheapest nor the heaviest option is a default. Orchestrating also needs ≥ 2 cards that
are self-contained, checkable and worth the overhead. A typed `/orchestrate` is the decision:
orchestrate even small work, with the lightest launch that fits. State the verdict in one line
first: `§0: 6 cards, 2 waves + QA → orchestrating, mode B` or `§0: one bounded change → worker`.

## Rules that matter most

1. **The lead does not implement.** Inline work is limited to merge/integration fixes of
   ≤ ~20 lines and running checks. Everything else is a card, including QA and review fixes
   (inline fixes skip review: `jw review` found 2 real bugs in them in materials-v1); list any
   in the ledger for the final review. Never edit this skill mid-run; never route around a
   permission refusal: report it.
2. **Small cards** (one concern, ≤ ~5 owned files, one check, ≤ ~120k expected context; split
   before launch, `sizing.md`). **Same-file work is a chain** (`chain.js`), not one big worker.
3. **One approval, then keep going.** An approved plan covers every phase; never call
   ExitPlanMode again (sub-plans go in the ledger). Stop only for CLAUDE.md's stops ("Execution
   discipline", "Git and change safety") and gates the user set ("confirm cost before the full
   rerun"), each as a `crew hold`/`ask` (§3). Decide everything else as a ledger `Ruling:`.
4. **Always leave a wake-up** (crew §10). After a restart or compaction, reconcile before
   waiting: ledger → running cards → branches, notes, `jw` logs (live vs dead: `workflows.md`).

## 1. Mode

**A**: opus orchestrates; judgment-heavy work (unclear design, risky refactors, debugging).
**B** (recommend it whenever an approved plan exists and the work isn't design- or
debugging-heavy): sonnet orchestrates, a fresh **opus** subagent with the ledger path at
checkpoints (decomposition review, hard calls, escalations past sonnet, final review). Model
doesn't match the mode: say so once (`/model`), then continue.

## 2. Tracking: one crew task, plus the ledger for detail

**The run is a crew task.** A spawned sub-lead uses the task in its prompt; past ~100k at start,
§6 first (the spawn makes the task). Otherwise `crew new <slug> --shape ship --repo <repo>
"<user's words>"` and `crew log <id> running "orchestrate: mode B, <n> cards"`. Then
`jw init <slug> "<goal + success criteria>"` (makes `~/.claude/orchestration/<slug>/{ledger.md,
notes/,runs/,briefs/}`, registers the ledger for the re-inject hook), `crew meta <id> orch=<slug>`.

| Where | Holds | Not there |
|---|---|---|
| crew task (`crew show`) | run state, progress notes, user decisions (D-ids), `agent_<card>=`, `workflow_run=`, final summary | card detail |
| `ledger.md` | Goal + success criteria, Mode, Baseline, Review Focus, Tasks table (id, concern, worker, owns, check, status, rework, peak), `Ruling:`/`Minor (deferred):`/`Advisor:` lines, watch decisions, Next step | overall state, user questions |
| `board.md` | contracts between cards; workers' QUESTION/BLOCKER posts to you | questions for the user |
| `notes/<card>.md` | each worker's progress and HANDOFF | |

The ledger is the source of truth for detail: update it at every milestone, in the same call
as the work where you can; < ~200 lines. Formats: `Baseline: <command> → <result>` (full
validation on base before launch), `Ruling: <what> — <why> — <cost if wrong>`, `Minor
(deferred): <one-liner>`. Read `~/.claude/orchestration/routing-lessons.md` before routing.

## 3. Reporting through crew

- **Progress:** `crew log <id> running "<milestone>"` at each wave/chain launch and return, each
  wave merged, each QA gate, and at least every ~20 min. HQ shows the note; never message HQ.
- **User questions:** `crew hold <id> "<question; options; recommendation>"` when the run can't
  go on, `crew ask` when it can; keep working (D-id and phone alert: crew §5). Worker questions
  stay on the board (§7) unless only the user can answer them.
- **Sub-lead:** report up at milestones only, per crew §4 "Chain of command". **Result:** §10.

## 4. Decompose into task cards

First the ledger's **Review Focus**: the 3–5 real inputs or failure modes most likely to bite a
user that no card's check exercises, most likely first (a real PDF with control glyphs, two
skills at once, reload with unsaved edits, the LLM returning fenced JSON). Pin each to the card
owning that code (it joins that card's check) or to the wave's QA card. Empty = you looked.

Each card (format `templates/task-card.md`): one concern and its owned files (parallel cards own
**disjoint** files); the acceptance check written first (failing test, script, or command +
expected output); the brief from the template (WORKER RULES verbatim, kill rule included; a card using another
card's new interface names its exact signatures in CONTEXT); a ledger row; shared contracts
posted to the board (`jw post <slug> orchestrator DECISION "..."`). Pilot first: a kind of card
you haven't routed before runs once and gets its brief fixed before you fan out.

## 5. Route and launch

| Work | Worker (always pass `model`) |
|---|---|
| Exploration, search, log reading | `jw ask`, or `Explore` on haiku (`effort: high` across many files) |
| Mechanical or fully specified edits | sonnet; haiku at `effort: high` when every change is named |
| Features, tests, refactors; QA cards | sonnet, or jcode gpt-6.1-sol when Claude usage is tight (QA: sonnet) |
| Hard design, gnarly debugging, escalations | opus (Mode B) or yourself (Mode A, edits still via cards) |
| Only after sol **and** opus fell short | gpt-6-astra, with a one-line ledger justification |

Haiku at `effort: high`/`xhigh` usually suffices for read-heavy or fully specified work with an
easy-to-check output; effort buys depth, not judgment. Set it per card (`"effort"`); Claude cards default to
`"high"` (crew §2).

- **1–2 cards:** Agent (`isolation: "worktree"` for writers, `run_in_background: true`) or
  `jw run` in background Bash. `isolation: "worktree"` branches off the session's cwd repo, which may
  be the wrong one: for another repo make the worktree with `git -C <target repo> worktree add`, pass its path.
  Record each: `crew meta <id> agent_<card>=<agent id or jw task>`
  (`crew save <id> <card>` can then recover its reply).
- **≥ 3 independent cards:** `wave.js` (`{slug, repo, base, home, cards}`); **same-file sequence:**
  `chain.js` (`{slug, id, repo, base, home, cards}`); `home` is your absolute `$HOME` (scripts
  can't read it); both create the card worktrees in `repo` themselves.
  Copy the script to the session scratchpad and pass
  that copy as `scriptPath` (Workflow rejects paths outside the working directory). In crew:
  `crew log <id> running "wave 2: 5 cards (wave.js)"` at launch, `crew meta <id>
  workflow_run=<runId>`, and `crew log <id> running "wave 2 back: 4 done, 1 blocked"` on return.
- `base` is your HEAD sha; **commit** contracts and shared setup first. Run from the target
  repo, in auto mode or interactively (workers write under `.claude/`; headless `acceptEdits`
  refuses that, and a worker reporting a refusal means fix the mode).
- Before each wave: `crew mem` (~0.25 GB per worktree test runner); low → `crew log <id> queued
  "RAM: wave <n>"`, launch when `crew next` says ok (crew §11). `jw usage` before > 3 jcode runs.

## 6. Context: yourself and workers

Thresholds follow crew's compaction policy: **soft 200k** (quality starts to drop), **hard
400k**; act at boundaries (a wave launched or merged, a QA gate done), never mid-step. You are
most of the bill (45–78% of Claude input tokens in the 2026-09 runs, peaks 300–500k). At
fan-out start the watcher with **Monitor** (one event per line; re-arm on timeout):
`<skill>/scripts/worker-sizes.py --watch --threshold 150000 --step 50000`. It reports workers
past ~150k (a recommended max, not a cap) and you past soft and hard (`CREW_COMPACT_SOFT`/`_HARD`
override). `worker-sizes.py --slug <slug>` prints a full report incl. jcode runs and your share.

**Yourself.** The ledger is your save point (no `/context-save` needed).
- **At start past ~100k:** `jw init`, write the plan and cards into the ledger, then
  `crew spawn <slug> --repo <repo> "Run /orchestrate --resume <slug>"` and verify its result
  like a worker's. Spawn refused: say so in one line, orchestrate here with a `Ruling:`.
- **Past soft:** at the next boundary update the ledger's Next step and `crew log` the
  milestone. A sub-lead's lead compacts it then (`crew compact --auto`); a top-level lead
  relies on auto-compaction, which the ledger hook survives.
- **Past hard:** launch nothing new. Finish the step, update the ledger, then hand off as at
  start (top-level), or log the milestone and stop for your lead's compaction (sub-lead).
- **On `--resume`:** `jw init <slug>` (re-registers the ledger for this session), read ledger
  and board, reconcile (rule 4), carry on from Next step.

**A worker event is a prompt to check in, not to act.** Read its notes file and last message,
decide, and log the decision in the ledger. **Let it finish** when it's close or its notes show
real progress (restarts cost more). **No signal** (notes empty/stale): `SendMessage` it (or `jw
resume`) for a one-line status and a checkpoint; unsaved findings are the risk, not the size.
**Checkpoint and restart:** `TaskStop`, then `SendMessage` asking for its HANDOFF in the notes
file (that resumes it for one turn; messages to a *running* subagent wait for its turn to end;
jcode: `jw resume`), then a smaller card seeded from it. **Stop now** when looping or off-track.
jcode compacts itself; Workflow agents can't be messaged: let it finish, or stop the workflow,
split the card, rerun with `resumeFromRunId`. Repeated oversize patterns → routing-lessons.

## 7. Message board

After each worker or workflow returns: `jw board <slug> --since <N> --type QUESTION,BLOCKER`,
answer with `jw post … ANSWER`, note the last line read in the ledger, then rerun the
`blocked`/`needs_context` card (fresh worker, `jw resume`, or `resumeFromRunId` same session).

## 8. Verify, merge, QA (evidence, not transcripts)

`done` → verify; `done_with_concerns` → read the concerns, resolve doubts about correctness or
scope before merging; `committed_needs_recheck` → re-run its check in its worktree, read the
worker summary, then merge or re-card; `needs_context`/`blocked` → §7; `failed` → §9. The branch must have
commits past base (`git log --oneline <base>..<branch>`; jcode cards have timed out with correct
but uncommitted work). Read summary + EVIDENCE (never raw transcripts or full `runs/*.json`),
re-run the card's check in its worktree with quiet output, read diffs closely only where risky
(auth, deletion, migrations, concurrency, public APIs, security parsing, money). Risky cards get
cross-family review: Claude-written → `jw review --repo <wt> --base <base-sha>`; jcode-written →
Claude `reviewer` on sonnet (`wave.js` does both for `risky: true`). Findings are claims (AGENTS.md §9).
On an already-committed branch `--base` must be `<first commit>~1`.

Merge one card at a time: `<skill>/scripts/merge-card --into <integration branch> <slug> <card-id>
<branch> -- <full validation>` (merges, logs to `runs/merge-<id>.log`, prints the tail, writes the
ledger line only when green). It refuses, changing nothing, when the checkout is not on `--into`
(run it in the integration worktree, never in the main checkout). Exit 3 = conflicts: resolve,
commit, rerun; 2 = refused or bad usage; other non-zero = red, fix first.

**QA gate after each wave.** On the merged HEAD, one QA card (`templates/qa-card.md`, sonnet)
exercises the Review Focus lines pinned to QA plus each new feature against the running app or
real data (one real item end to end; real LLM calls where the feature makes them). In the
2026-09 runs every real bug came from this pass, none from card checks. You keep the app
running (workers can't read credential files); read its findings and at most 2–3 screenshots
(one orchestrator once took in 46), then `crew log` the result. Findings → **one** fix card (a chain if they share files) with the complete list, each fix
reproduced as a failing test first where possible → one scoped re-review
(`templates/re-review.md`). No second fix wave: each finding still open gets a `Ruling:` (a new
card only if load-bearing) or a `Minor (deferred):` line.

## 9. Escalation ladder

Two failures on one card → one tier up, never a third try on the same worker: haiku → haiku
`effort: high` (only if it ran at default and the misses look shallow) → sonnet → opus; sol →
opus → (genuinely hard) astra; jcode infrastructure failure (`jw` exit 3/4 twice, or both
accounts near limit) → sonnet. Seed it with the notes/HANDOFF and the failed summary. Too big →
split, not escalate. Three failed fixes for one bug, by any workers, means the design is wrong:
opus checkpoint (B) or your call (A), a `Ruling:`, then re-card.

**Advisor, last resort:** only the CLAUDE.md "Fable advisor" cases (in a run: the ladder
exhausted, the same bug back after a design `Ruling:`, going in circles); never for
decomposition, checkpoints, per-card review or the final report. First an `Advisor: <what
failed, how often, what was tried>` ledger line, said in the session too.

## 10. Finish

1. Every Tasks row `done` and merged via `merge-card`; the last QA gate clean or ruled on.
2. **Final whole-branch review**, cross-family: `jw review --repo <repo> --base <run base>` (a
   Claude `reviewer` on opus when most of the branch is jcode-written), with the Review Focus and
   the `Ruling:` lines as focus. Findings → **one** fix card → one re-review → merge.
3. **Success criteria, line by line:** run the command proving each one now; unmet is reported
   as unmet. Asked before 2–3 finish: report verified vs pending, keep going, don't call it done.
4. **Retro:** `<skill>/scripts/orch-retro.py --slug <slug>` → summary into the ledger; 1–3 lines
   to `routing-lessons.md` (`YYYY-MM-DD <slug>: <card kind> → <worker> worked|failed because …`;
   keep < ~60 lines); a repeated lesson becomes a proposed skill edit in the report. Then
   `rm -f ~/.claude/orchestration/active/$CLAUDE_CODE_SESSION_ID`.
5. **Report through crew:** `crew summary <id> -` (heredoc), verdict line first, then what was
   done, which workers did what (peak sizes), verification results, **Rulings I made** (each
   with its cost if wrong), **Deferred minors**, lessons. Then `crew log <id> review "branch <b>
   ready to land"` and `crew ask <id> "land <b>: merge locally / push + PR / keep as is?"`. A
   sub-lead reports up (crew §4); a top-level lead replies in crew's "Talking to the user" shape,
   Needs-you line `**D<n> <topic>:** <context> → <options>  (crew show <id>)`.
6. On the answer: land per crew §6, `crew log <id> landed`, offer `git worktree remove` for
   merged card worktrees (`crew gc` lists them; never `--force`; removing is the user's call).
