# Workflows in /orchestrate

## What a Workflow is

`Workflow` runs a small JavaScript script in the background. The script calls
`agent(prompt, opts)` to spawn subagents and combines them with `pipeline()` (each item
flows through all stages independently) and `parallel()` (a barrier). You get **one
notification with the script's return value** when it finishes. The workers' transcripts
never enter your context: you see only the JSON the script returns. That is what keeps the
orchestrator small during a big wave.

Useful properties:
- `agent()` options: `model`, `effort`, `schema` (forces structured JSON output),
  `isolation: 'worktree'`, `agentType` (e.g. `reviewer`), `label`, `phase`.
- Concurrency is capped by the runtime (≈ CPUs − 2, max 16); extra agents queue.
  No wave-size limit is configured.
- Scripts have **no filesystem access** and no `Date.now()`/`Math.random()`: pass
  everything in `args`. Cards go in as JSON.
- **`args.home`** (wave.js and chain.js): the absolute home directory, e.g. the output of
  `echo $HOME`. Scripts cannot read `$HOME`, and the runner's Write tool rejects `~` paths,
  so `${home}/.claude/orchestration` and `${home}/.claude/skills/orchestrate` are built from
  it. Missing, `~` or relative: the script throws "args.home is required". chain.js only
  needs it when the test-only `args.skill_dir` is absent.
- `resumeFromRunId`: re-running the same script with the same args returns finished
  agents from cache instantly; only changed or new agents run. **Same session only:** in a
  new session the args aren't persisted and the rerun fails ("Cannot destructure 'slug'").
  After a restart, WIP-commit any interrupted worktrees, then launch the remaining cards as
  a fresh wave/chain with `base` (or `from`) = the last good branch's sha.
- Agent transcripts land in `<session>/subagents/workflows/<runId>/agent-*.jsonl` and are
  written live, so `scripts/worker-sizes.py --watch` sees them.
- Workflow agents **can't be messaged** while running. Size control inside a workflow is
  small cards, plus stop and rerun if one card goes wrong.

## Launching: copy the script into the scratchpad first

`Workflow` rejects a `scriptPath` outside the session's working directory (`scriptPath must
be a script path this tool returned, or a file you can already read`). Orchestrating from
a target repo puts `~/.claude/skills/...` outside it, so never pass the skill path directly.
Copy the script into the session scratchpad and launch that copy:

```
cp ~/.claude/skills/orchestrate/workflows/{wave,chain}.js <scratchpad>/
Workflow({ scriptPath: "<scratchpad>/wave.js", args: {...} })
```

`<scratchpad>` is the session scratchpad directory named in the system prompt. Re-copy
before each launch so edits to the skill's scripts are picked up. The `<skill>/workflows/…`
paths below mean the copied script.

## When to use which

| Situation | Launch |
|---|---|
| 1–2 cards | Direct Agent calls / `jw run` (you can message or stop each one) |
| ≥ 3 independent cards | `workflows/wave.js` |
| Same-file sequence | `workflows/chain.js` |
| Both | Launch the wave and the chain together; they're independent runs |
| QA pass after a wave | One direct Agent call with `templates/qa-card.md` (no workflow) |

## wave.js

```
Workflow({
  scriptPath: "<skill>/workflows/wave.js",
  args: { slug: "<slug>", repo: "<abs repo path>", base: "<HEAD sha>", home: "<abs $HOME>", cards: [ <card>, ... ] }
})                                                    // card format: templates/task-card.md
```

Pipeline per card: **Setup → Implement → Evidence → Review**. Evidence replaces trusting the
worker's word: the script runs the card's check itself and classifies the result. You still
re-run each card's check before merging it (SKILL.md §8).
- Setup (Claude cards): one haiku runner runs `scripts/card-worktree <repo> <branch>
  <worktree> <base>` per card in the target `repo`; the script checks the `WORKTREE` line it
  gets back. A card whose setup fails comes back `failed` ("worktree setup failed: …") and
  spends no worker.
- Claude card: a subagent on `card.model` (default sonnet) at `card.effort` (if set), with
  no harness isolation. It works in the worktree `<repo>/.claude/worktrees/wf-<slug>-<id>`
  on branch `wf/<slug>/<id>` (attempt ≥ 2: `.a<N>` on both), both already created, and
  commits there. Its prompt gives the absolute worktree path.
- jcode card: a haiku runner writes the brief to `briefs/<id>.md`, runs `jw run` in the
  background and waits for it. The jcode worktree is `<repo>/.claude/worktrees/jw-<slug>-<id>`,
  branch `jw/<slug>/<id>`.
- Evidence (every card that was set up, jcode included, even when the worker returned
  nothing): a haiku runner runs `scripts/card-evidence <repo> <base> <branch> <worktree> --
  <check>`, which counts commits past base, dirty files and the check's exit code.
- Review (only `risky: true` and status `done`/`done_with_concerns`): jcode-written → sonnet
  `reviewer` diffing `<base> jw/<slug>/<id>` via `git -C <repo>`; Claude-written → haiku
  runner calling `jw review --repo <worktree> --base <base-sha>`.

Returns one entry per card: `{id, kind, status, worker_status, concerns?, summary, commits,
dirty, check, check_tail, evidence, worktree, branch, base_sha, review?, question?}`.
`status` is the evidence-checked outcome: `done`, `done_with_concerns` (check passes, worker
has doubts, or the evidence was unavailable: read `concerns` before merging), `committed_needs_recheck` (the worker failed,
timed out or hit a jcode quota limit, but its branch has commits and the check did not fail,
or the worktree holds uncommitted changes, or the check could not run:
re-run the check in its worktree and read its work before merging), `needs_context` (answer
and rerun), `blocked`, `failed` (no commits past base, a failing check, or setup failure).
`worker_status` is what the worker itself reported; `check` is the check's raw exit code
(or `skipped`/`none`) and `check_tail` its last output lines. A script log line tallies the
statuses. `chain.js` verifies each step the same way, since the next step builds on the
previous one. A `done_with_concerns` step is kept (its branch is
mergeable) but pauses the chain, returned as `paused_for_concerns: <step id>`, so later steps
don't build on doubted work: resolve the concerns, then launch the remaining steps as a new
chain with `base` = the returned `branch`. jcode cards default to `timeout: 2400`; a timed-out
run that committed comes back `committed_needs_recheck`, one with no commits `failed` with
"TIMEOUT" in the summary (its worktree may still hold uncommitted work: run the check there
before discarding it).

### Worktrees and gotchas
- `wave.js` and `chain.js` create each Claude card's worktree themselves with
  `scripts/card-worktree`, as `<repo>/.claude/worktrees/wf-<slug>-<id>` in the **target
  repo**, whatever repo the session is in. Don't pre-create worktrees for these cards. A rerun
  reuses the existing worktree (or attaches an existing branch); a setup failure fails only
  that card.
- A lead that entered a worktree with `EnterWorktree` is **git-isolated**: its workers can't
  run git in other repos. Launch waves from a normal session (a `cd` into the integration
  worktree is fine).
- Commit anything workers need before launching: new branches start from the card's `base`.
- **Permissions:** card worktrees and `~/.claude/orchestration` are under `.claude/`,
  which `default`/`acceptEdits` modes treat as sensitive: headless (`claude -p`) workers
  get every Edit/Write refused there. Orchestrate in auto mode, or interactively where
  you can approve. A worker that reports such a refusal is blocked, not failed.
- On a machine without a global git identity, workers commit with `git -c user.name=…`.
  Briefs forbid `git config` (a test worker once wrote an identity into the repo config).

## chain.js

```
Workflow({
  scriptPath: "<skill>/workflows/chain.js",
  args: { slug, id: "<chain id>", repo: "<abs repo path>", base: "<HEAD sha>", home: "<abs $HOME>", cards: [ <step card>, ... ] }
})
```

`repo` is required. Steps run in order. Step n is a fresh Claude worker in its own worktree
`<repo>/.claude/worktrees/wf-<slug>-<chain id>.<n>` (made by `scripts/card-worktree`), on branch
`wf/<slug>/<chain id>.<n>` created from step n-1's branch (step 1: `base`), and it gets step
n-1's `handoff` text. After each step a `card-evidence` runner counts that step's own
commits and runs its check. The chain stops at the first failed or blocked step, and also at
a `committed_needs_recheck` step (the worker failed but committed work and the check did not
fail, the worktree holds uncommitted changes, or the check could not run): re-check that branch, then launch the remaining steps as a new chain with `base` =
that branch. It returns `{chain, branch, completed, total, stopped_at, steps}`; each step
carries `status`, `worker_status`, `commits`, `dirty`, `check`, `check_tail`. `branch` is the last passed step's
branch, which contains all passed steps: merge that one. Claude steps only; for a jcode
step, run a direct `jw run --base <last chain branch>` between chains.

## After a restart: which workers are still alive?

Notifications from workers launched before a restart, `--resume` or compaction can be lost.
For each card the ledger lists as running:
- **Work already done?** `git log --oneline <base>..<card branch>` and the notes file.
- **jcode:** `tail -1 ~/.claude/orchestration/<slug>/notes/<id>.run.log` shows `exit=N` when
  the run ended; `pgrep -af "jw run .*--task <id>"` shows whether it is still running.
- **Workflow:** the runId is in the run's crew task (`crew show <id>`, `workflow_run=`);
  `<session>/subagents/workflows/<runId>/journal.jsonl` holds each finished
  agent's return value; the `agent-*.jsonl` transcripts' modification times show whether
  anything is still working (`ls -lt`). No change for ~5 minutes and no journal entry →
  treat that card as dead.
- Dead card: WIP-commit its worktree if it has changes, then relaunch only the unfinished
  cards as a fresh wave/chain from the last good branch (`resumeFromRunId` does not work
  across sessions). Never relaunch a card whose branch already has passing work.
Re-arm the watcher Monitor, record what is still running in the ledger, then wait.

## Blocked cards and questions

A worker that needs a decision posts a QUESTION on the board, finishes everything else,
and returns `status: "blocked"` with the question; one missing information the brief
should have given returns `"needs_context"` with what it needs in `concerns`. After the
workflow returns:
1. `jw board <slug> --since <N> --type QUESTION,BLOCKER`, answer with `jw post … ANSWER`.
   A question only the user can answer goes to `crew hold <id>` first (SKILL.md §3).
2. Add the answer to that card's brief (for example a line `ANSWER: …`) and re-invoke
   the same script with `resumeFromRunId` (same session only; see above). Unchanged cards come back from cache; only the
   edited card (or chain step, and the steps after it) runs again, continuing on its own
   branch from its committed work. Nothing else to set. To throw an attempt away instead,
   set `attempt: 2` (wave cards: new branch `<branch>.a2` from `from`, default `base`).

## When a card goes oversize inside a workflow

The watcher reports it like any other worker. Options:
- let it finish (usually right when its check is close);
- `TaskStop` the workflow, split the card in `args`, and re-invoke with `resumeFromRunId`.
  Finished cards stay cached and the split cards run fresh. A stopped card's commits stay
  on its branch; point the new cards at it with `from`, and at its notes file in the brief.

## Debugging a workflow result

If a result looks empty or odd, read `<transcript dir>/journal.jsonl` (each agent's actual
return value) before re-running. Don't read the agents' full transcripts unless the
journal isn't enough.
