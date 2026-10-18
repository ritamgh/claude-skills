# Task card + brief

One card per worker. Cards live in the ledger's Tasks table (short form) and are passed
whole to `workflows/wave.js` / `workflows/chain.js` as `args` (JSON form).

## Card (annotated JSON — drop the comments when passing it as `args`)

```jsonc
{
  "id": "A2",
  "concern": "sig-fig check ignores unit exponents",
  "kind": "claude",              // "claude" | "jcode"
  "model": "sonnet",             // claude: haiku|sonnet|opus; jcode: gpt-6.1-sol (astra only with a ledger justification)
  "effort": "high",              // optional, claude only: low|medium|high|xhigh|max; mainly to lift haiku (SKILL.md §5). Omit for the model's default
  "repo": "/abs/path/to/repo",   // optional; defaults to the wave's args.repo (Claude and jcode cards: the repo whose worktree the card gets)
  "base": "<sha>",               // optional; defaults to the wave's args.base (orchestrator HEAD sha)
  "attempt": 1,                  // optional; a plain rerun continues the card's branch. 2, 3… = start over on <branch>.a<N>
  "from": "wf/<slug>/A1",        // optional; branch a fresh start (attempt ≥ 2) or split card begins from
  "owns": ["src/pkg/checks.py", "tests/test_checks.py"],
  "check": ".venv/bin/python -m pytest -q tests/test_checks.py -k sigfig",  // run from the card's worktree root; never cd to the main repo
  "risky": false,                // true → cross-family review stage runs
  "timeout": 2400,               // jcode only: jw run timeout in seconds (default 2400; 1800 timed out 3/3 in rpa-fixes)
  "notes": "~/.claude/orchestration/<slug>/notes/A2.md",
  "brief": "…the brief below, filled in…"
}
```

`chain.js` steps use the same fields minus `kind`/`repo`/`base`/`risky`/`attempt`/`from`
(steps are always Claude workers; `chain.js` takes `repo` once in its args). `wave.js` and
`chain.js` put the worktree, branch and git-identity instructions in front of the brief
themselves (the scripts create the worktree and branch in `repo` and tell the worker its
absolute worktree path), so briefs say "worktree root", not a path. Every brief carries the
WORKER RULES block below verbatim, including QA and re-review briefs.

**Size limit (see sizing.md):** one concern · ≤ ~5 owned files · one check · expected
worker context ≤ ~120k. Fails the limit → split before launch.

## Brief

```
ROLE: <specialist role>
GOAL: <one paragraph; what done looks like — one concern only>
CONTEXT: <only what's needed; paths to read, not pasted content; for a chain step,
  the previous step's HANDOFF; interfaces from other cards you consume or produce, with
  exact signatures>
YOU OWN: <files>. Do not edit anything else.
ACCEPTANCE CHECK: <command>. It must pass before you finish. While iterating, run the
  focused test for what you are changing; run the full check once before committing.
TESTS: before writing a test, name the production change that would make it fail. Exercise
  real code with realistic inputs; mock only slow or external dependencies and never assert
  on the mock itself. Expected values are literals or hand-checked fixtures, never computed
  by the code under test. When the check is a test you wrote, EVIDENCE shows it failing
  before your change and passing after.
CONSTRAINTS: match surrounding code style; no new dependencies unless stated;
  no git push, no force, no reset/clean/branch deletion; no secrets.
  Do all of the work yourself: never spawn subagents or reviewers (review is scheduled
  separately after you report).
  If a tool call is refused by permissions, do not route around it with another tool
  (no python/heredoc writes); post a BLOCKER and return status "blocked".
  Commit on your branch as soon as a step passes and again when the check passes; work that
  isn't committed is lost if you are stopped.
WORKER RULES:
  - Your shell tool is `Bash` (capital B).
  - Read a file before you Write or Edit it.
  - One simple command per Bash call. No `cd x && ...` chains, except the `cd <your worktree> && ` prefix your brief asks for; no
    heredoc interpreters, no variables inside git paths. For multi-step logic, write a script
    file with Write, then run it.
  - Never `sleep` to wait: use Monitor, or run_in_background and wait for the notification.
  - Tests and cleanup kill only PIDs they recorded themselves (`$!` of what they started); never `pkill -f`, `killall`, or a pid list from `pgrep`.
  - Worktree tasks: commit work in progress at each green check, not only at the end.
BOARD: read ~/.claude/orchestration/<slug>/board.md first (missing = no posts yet); post decisions, questions,
  and blockers with `~/.claude/bin/jw post <slug> <task> <TYPE> "..."`. If blocked,
  post a QUESTION, finish everything else, and return status "blocked".
STATUS: done — check passes, you have no doubts. done_with_concerns — check passes but you
  doubt correctness or scope; say why in "concerns". needs_context — you are missing
  information the brief should have given; say exactly what. blocked — a decision or
  permission is needed (QUESTION/BLOCKER posted). failed — you could not make the check pass.
  Never report done on work you are unsure about.
NOTES FILE: <notes path>. Append progress and open questions as you go. For read-only work
  (audits, reviews) with no file changes to point to, this is your only record of progress:
  append findings as you land them (e.g. after each section/file audited), not only at the end.
HANDOFF: keep the notes file current as you go (you may be stopped at any time). If the
  orchestrator asks for a handoff, or you notice you are going in circles, stop and write
  a "HANDOFF:" section to the notes file (done so far, files touched, what's left, next
  command to run, open questions), then finish.
OUTPUT: first line "STATUS: <value>" (plus a "CONCERNS: …" line when you have any), then
  ≤ 150 words: what changed (files), anything surprising, then a block starting with
  "EVIDENCE:" listing each command you ran and its result.
```

Claude workers also return these as structured fields; for jcode cards the wave's runner
reads the STATUS/CONCERNS lines from the reply.
