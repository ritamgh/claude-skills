# QA card (after each wave, SKILL.md §8)

One sonnet worker per wave, launched on the merged HEAD after the wave's cards are merged.
It finds bugs; it does not fix them. Launch it as a direct Agent call (`model: "sonnet"`,
`run_in_background: true`, no worktree needed since it doesn't edit source), so you can
message it.

Before launching: the app or pipeline it tests is running on the merged HEAD (you restart
dev servers and workers yourself; workers can't read credential files), and the QA
directory exists: `mkdir -p ~/.claude/orchestration/<slug>/notes/qa-<wave>`.

## Brief

```
ROLE: QA engineer testing a feature wave end to end on real inputs.
GOAL: find the bugs a user would hit in what this wave changed. Report them; do not fix them.
WHAT CHANGED: <one line per merged card: id, what it does, where it shows up in the app/CLI>
REVIEW FOCUS (test each one; most likely first):
  <the ledger's Review Focus lines pinned to QA, verbatim>
ENVIRONMENT: <URLs / commands / real input files to use, e.g. web http://localhost:3001,
  api http://localhost:8001, sample paper papers/primary/x.pdf, test account ...>
  The app is already running. Do not start or restart servers, do not read .env or
  credential files, do not edit source or config. Real LLM/API calls are allowed only
  within: <budget or item limit>.
WORKER RULES:
  - Your shell tool is `Bash` (capital B).
  - Read a file before you Write or Edit it.
  - One simple command per Bash call. No `cd x && ...` chains, except the `cd <your worktree> && ` prefix your brief asks for; no
    heredoc interpreters, no variables inside git paths. For multi-step logic, write a script
    file with Write, then run it.
  - Never `sleep` to wait: use Monitor, or run_in_background and wait for the notification.
  - Tests and cleanup kill only PIDs they recorded themselves (`$!` of what they started); never `pkill -f`, `killall`, or a pid list from `pgrep`.
  - Worktree tasks: commit work in progress at each green check, not only at the end.
METHOD:
  - For each feature and each focus line: do what a user would do with realistic input,
    including the unhappy paths (reload mid-action, two actions at once, empty/huge/odd
    input, network or LLM error).
  - Compare what happens with what a reasonable user expects, even where no spec says so.
  - When something breaks, reproduce it once more, then narrow it: note what goes in and
    comes out at each boundary you can observe (UI → API response → worker log → stored
    result) to name the layer where it goes wrong. Don't guess at fixes.
  - Save screenshots and logs under ~/.claude/orchestration/<slug>/notes/qa-<wave>/ with
    descriptive names. Append each finding to that directory's findings.md as you land it
    (you may be stopped at any time).
OUTPUT: ≤ 200 words, then a FINDINGS block, one entry per bug, most severe first:
  - id, severity (high/medium/low), one-line title
  - steps to reproduce (numbered, exact inputs)
  - expected vs observed
  - suspected layer and the evidence for it
  - screenshot/log paths
  Then "CHECKED:" — each focus line and feature with passed / failed / not tested (why).
```

## After it returns

Read the FINDINGS and CHECKED blocks and at most 2–3 screenshots for findings you can't
judge from text. Real findings → one fix card (a chain if they share files) with the full
list; each fix reproduced as a failing test or script first where possible. Then a scoped
re-review with `templates/re-review.md`.
