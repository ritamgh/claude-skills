# Scoped re-review (after a fix card)

Verifies that each finding a fix card was given is gone, and that the fix broke nothing.
It is not a fresh review: the full review (card review, QA pass or final review) already
happened. One re-review per fix card; there is no second fix wave for the same findings.

Pick the reviewer from the other model family: Claude-written fix → `jw review`;
jcode-written fix → Claude `reviewer` agent on sonnet.

## As a `jw review` focus

```
~/.claude/bin/jw review --repo <fix worktree> --base <fix base sha> "SCOPED RE-REVIEW.
Findings the fix was meant to address:
1. <finding, verbatim>
2. ...
For each finding: ADDRESSED or NOT ADDRESSED, with file:line evidence ('attempted' is not
addressed; the defect must no longer exist). Then list new problems the fix diff itself
introduced. Anything outside the fix diff goes under OUT OF SCOPE and does not block."
```

## As a Claude reviewer prompt

```
You are re-reviewing one fix. Do not modify files, the index, HEAD or branches, and do not
spawn agents.
WORKER RULES:
  - Your shell tool is `Bash` (capital B).
  - Read a file before you Write or Edit it.
  - One simple command per Bash call. No `cd x && ...` chains, except the `cd <your worktree> && ` prefix your brief asks for; no
    heredoc interpreters, no variables inside git paths. For multi-step logic, write a script
    file with Write, then run it.
  - Never `sleep` to wait: use Monitor, or run_in_background and wait for the notification.
  - Tests and cleanup kill only PIDs they recorded themselves (`$!` of what they started); never `pkill -f`, `killall`, or a pid list from `pgrep`.
  - Worktree tasks: commit work in progress at each green check, not only at the end.
FINDINGS UNDER VERIFICATION:
<findings, verbatim, one per bullet>
FIX: base <fix base sha>, branch <branch>. Read `git diff <fix base>..<branch>` once, and the
fix card's report at <notes path>. Treat the report as claims to check against the diff.
Do not re-run the whole suite; run one focused test only for a specific doubt.
OUTPUT (nothing else):
FINDING VERDICTS: each finding → ADDRESSED | NOT ADDRESSED, file:line evidence.
NEW BREAKAGE IN THE FIX DIFF: severity + file:line, or "None".
OUT OF SCOPE: issues outside the fix diff (non-blocking), or "None".
VERDICT: all addressed, no new high/medium breakage | open findings (list them).
```

## After it returns

Open findings or new breakage get an explicit decision each, as
`Ruling: <finding> — <fix now | stands | deferred> because <why> — <cost if wrong>`.
Only a load-bearing one (later work builds on it, or a user would clearly hit it) gets a
new card; the rest stand or are deferred and reach the user in the final report.
Out-of-scope items become `Minor (deferred):` lines unless they are serious enough to card.
