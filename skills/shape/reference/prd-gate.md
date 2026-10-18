# The PRD gate: lint, approval, publish, commit

Loaded from SKILL.md §5. The gate is hard: nothing is built or committed before the user approves (the uncommitted mirror
in the repo is written earlier and tracks the plan).

## 1. Lint until clean

`~/.claude/bin/plan lint <task>` (exit 0 clean, 1 blocking findings). Fix each blocking finding by writing the plan,
never by deleting the thing that fails:

| rule | Fix |
|---|---|
| `empty-section` §N | §N has nothing settled. Draft the missing nodes (kinds per contract §8) and settle them through the user (an answer or the playback). §1 is `tldr`; §16 needs a settled slice with a non-empty `exit`. |
| `blocking-question` Qn | Ask it. If the user says "decide later" on a blocking question, ask whether it can be non-blocking (then `upsert` `"blocking":false`, write the default as an assumption with `by_default: true`). Never answer a `class: user` question yourself. |
| `fr-no-scenario` FR | Add the FR to a slice's `refs` and give that slice Given/When/Then `scenarios`. |
| `uncovered` FR/SC | Add the id to a task's `refs` (or draft the task that covers it). |
| `task-no-check` T | Give the task a runnable `check` command (a test, a script, a curl with an expected status). |
| `no-nongoals` | Ask the no-gos seed again, with options drawn from the plan's tempting extras. |
| `vague` FR/SC | Replace the adjective with a number and a unit in the label or body ("fast" → "under 1 s for 300 tasks"). |

Warnings: `default` lists the unexamined defaults (show them in the playback: "accepted without discussion: …");
`open-question` lists non-blocking questions still open (they stay in §14 as open questions; say so).

## 2. Deep: the review lenses

Run plan-ceo-review, then plan-eng-review, against the rendered PRD (`$(~/.claude/bin/plan path <task>)/PRD.md`).
Use them as lenses: read their findings, and turn each one you accept into an event (a new question for the user, a
risk with an approach, a decision, an FR edit). Do not write their separate plan files or let them restart the
interview. Re-run lint afterwards.

## 3. Publish, playback and approval

First publish the mirror: `~/.claude/bin/plan publish <task> --to <repo>/docs/prd/<slug>` (absolute path; `<slug>`
= the task id without its date prefix). It writes `PRD.md` and `plan.json` there and rewrites them on every later
event (`approve_prd` included, so the approval is in the mirror you commit); it never commits.

Then print ≤ 10 lines:
```
<title> · <size> · rev <n>
TL;DR: <the tldr>
Slices: S1 <label> (walking skeleton); S2 …
Riskiest: R-1 <label> → <approach>
Tasks: <n> (T-001…T-00n), every FR/SC covered
Defaults not discussed: DEC-2 …, AS-1 …   (or "none")
Open, non-blocking: Q9 …                  (or "none")
PRD: <plan dir>/PRD.md · page: http://127.0.0.1:7717/plan/<task>
```
Then the order, for every size:
1. Ask the playback question (`reference/questions.md` §5) **alone**. Record its answer; a yes is what settles the
   drafts, so lint is usually not clean until then.
2. Re-run `plan lint <task>`. Blocking findings: fix, play back what changed, go to 1.
3. Only at exit 0, a **separate** AskUserQuestion: "Approve the PRD?" with "Approve (Recommended)" and "Change
   something". Never put it in the same call as the playback or any other question. On Approve:
   `~/.claude/bin/plan event <task> --by user --source terminal --json '{"type":"approve_prd"}'`. Exit 4 means lint
   found a blocking problem after all (stdout lists it): fix, play back what changed, ask again.

The page's Approve button sends the same event; you see it as an `approve_prd` line in `plan news`. Treat it exactly
like the terminal yes and continue with §4.

## 4. Commit

1. The mirror is already in `<repo>/docs/prd/<slug>/` (§3) and now carries the approval.
2. Decide whether the repo is **shared**. It is shared when either holds:
   - a remote's owner is not the user's own GitHub account. Look the login up first with
     `gh api user --jq .login` (call it `<login>`); if `gh` is missing or not logged in, ask the user for their
     GitHub login (`crew ask`) and do not guess:
     `git -C <repo> remote -v` shows a `github.com[:/]<owner>/…` with `<owner>` ≠ `<login>` (any non-GitHub remote
     counts as shared unless the user has said otherwise);
   - another author committed: `git -C <repo> log --format=%ae | sort -u` lists an address other than
     `git -C <repo> config user.email` and `*<login>@users.noreply.github.com`.
3. **Personal repo**: the Approve was the yes. Stage only `docs/prd/<slug>/` and commit:
   `git -C <repo> add docs/prd/<slug>` then `git -C <repo> commit -m "PRD: <title>" -- docs/prd/<slug>` (the
   pathspec keeps anything the user had already staged out of this commit). Never push.
4. **Shared repo**: `~/.claude/bin/crew ask <task> "Commit the approved PRD to <repo>/docs/prd/<slug>/ (shared repo)?"`
   and wait for the D-id answer. Commit as above only on yes; on no, the PRD stays in the crew task dir and the
   mirror (uncommitted) and you say so.
5. If the repo has unrelated uncommitted changes, commit only the PRD paths; never stage anything else.

## 5. After approval

- The PRD header shows `Approved at rev N; changed since (rev M)` once a spec node changes after approval. Task
  status, discoveries and top-level sets (`set stage building`) do not count. Commit the mirror together with the
  spec change; build progress alone may be committed at milestones.
- Re-entering `frame`…`shape` (to rework the plan) clears the approval; approve again before building on it.
- Handoff: SKILL.md §6.
