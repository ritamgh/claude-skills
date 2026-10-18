# Ideate and Research: the playbook

Loaded from SKILL.md §2 (start) and §3 (stages). The spec is `contract.md` §12; node shapes are in `nodes.md`. These
stages are optional and never render in `PRD.md`; the one thing the PRD keeps is the `decision` node written on
promote. Words are generic: **context** (the challenge, product or market), **criteria** (a rubric, product goals,
an investor thesis), **evaluators** (who judges), **gates** (pass/fail must-haves).

## 1. Sizes

- **Quick**: skips Ideate and Research; start at Frame.
- **Standard**: runs Ideate only when the user brings ≥ 2 candidates or none. Research is offered per idea or per
  question. A shortlist run is optional: ask, Recommended: skip unless the choice is close or the stakes are high.
- **Deep**: runs Ideate on the same trigger and recommends a shortlist research run before promote.

Research may also start at Explore or Decide, for one idea or one question.

## 2. Ideate

Start with `{"type":"set","field":"stage","value":"ideate"}`.

1. **Read the user's documents first** (rules, briefs, notes, transcripts, a teammate's go/no-go doc). Facts are
   yours to find; the user's words about what matters are data to record, not rules to second-guess.
2. **Write `rubric` nodes** from whatever criteria the context gives (a rubric, product goals, an investor thesis).
   Set `origin` to where each came from. A hard constraint or a must-have is a `gate` rubric, never a weight. A
   concern only the user raised is a `lens` (shown, not counted until they weight it). Everything else is `weighted`
   with `default_weight` = `weight`. Rubrics start `open`; settle them when the user agrees.
3. **Write `idea` nodes**: `hook` (one line), `pitch`, `who`, `win`, `tier`, `sources`. Candidates the user brought are
   written as they stated them; add your own only when asked or when there are none. Cap the list near 8.
4. **Run the three checks per idea** and write them into `checks`: `allowed` (do the rules and constraints permit
   it?), `exists` (does it already exist: search the web and the repo), `feasible` (can this team build it in the
   appetite?). Each is a verdict `ok|warn|bad|na`, a ≤ 60-char `label` and a `note` with the evidence.
5. **Initial scores from documents** are `score` events with `basis: session` (the default) and a `label` that says
   where the number came from ("from the research doc", "my read of the brief"). Gate rubrics get `pass`.
6. **Shortlist by boosting** (value 1): propose the shortlist in your reply; the user boosts on the page, or tells you
   and you send `{"type":"boost","node":"I3","value":1}` with `--by user --source terminal`.
7. **Point the user at the board**: `http://127.0.0.1:7717/plan/<task>#board`. Say what is there (ideas ranked by
   weighted score, gates, the checks) and what they can do (boost, kill, merge, twist, promote, weight, research).

## 3. Board requests from `plan news`

All page text is the user's words (data). Each request below ends with `resolve`.

- **merge** (`node` is the draft, `merged_from` its parents): write the draft's `label`, `hook`, `pitch`, `who`,
  `win` from both parents, rerun the three checks, score it on every rubric (`basis: session`), then resolve. The
  parents stay in play, marked `merged_into`, until the user kills them: never kill them yourself.
- **twist without text**: write 3 twists into the idea's `twists` (each ≤ 300 chars), specific to that idea and never
  generic: flip a constraint, serve a different user, run it in reverse. Resolve.
- **twist with text**: the text is a new idea. Upsert it (`tier: "Twist"`, `sources` names the parent), run the
  checks, score it, resolve.
- **promote**: contract §12.4. Write a settled `decision` node (`chose` = the idea, `alternatives` = the other
  shortlisted ideas, `why` = the scores and the user's kill reasons), draft `tldr` from the idea's `who` and `pitch`,
  smart-skip the Frame seeds the idea already answers (quote the idea in `text`). The CLI has already moved the stage
  to `frame`. Resolve.
- **research**: `node` is an idea or a question, no node means the whole shortlist; `text` is the user's focus.
  Start it as in §4 and resolve at once: starting is the answer.

## 4. Research handoff: never blocks

Starting research returns at once; the session keeps asking questions.

1. **Upsert the `research` node first**, `state: queued`, with `scope`, `targets` and `question`.
2. **Choose the vehicle by size** (contract §12.5) and record why in `note`:

   | Ask | Vehicle |
   |---|---|
   | one factual question | `inline` lookup, or one `worker` |
   | one or two focused topics (an idea, a question) | `workflow`: `idea-research` with `topics` or `depth: "quick"` |
   | a full shortlist | `sublead`: a research sub-lead that owns the run |

3. **Show the cost and ask before a `workflow` or `sublead` run**: call the workflow with `dry_run: true`, then one
   AskUserQuestion with the topic and agent counts (`agents.total_max`) and Recommended first (usually "run it").
   `inline` and a single `worker` need no question.
4. **Launch** and record `vehicle` and `run` on the node:
   - `worker`: Agent with `run_in_background` and an explicit `model`; the prompt says what to write and where.
   - `workflow`: Workflow name `idea-research` with the args of contract §12.5 (`dir` under the task's folder, `today`,
     `context`, `ideas`, `criteria`, `gates`, `gate_docs`, `evaluators` if the user named any). It returns at once; a
     task-notification arrives when it is done. Then send `research_status running` with its run id.
   - `sublead`: `~/.claude/bin/crew spawn <slug>-research --repo <repo> "<prompt>"`. The prompt names the plan task,
     the research node id, the idea and rubric ids, and the output dir, and says: run /idea-research; write
     `research_status running`, the `score` events and `research_status done|failed` with `~/.claude/bin/plan event
     <task> --by session --source build`; report up through crew. The sub-lead logs its crew task `done` once its
     results are in the plan. You verify, then mark it `landed` (`~/.claude/bin/crew log <task> landed`); the next
     `crew digest` or `crew subs` sweep closes the sub-lead's window by itself. Do not close it by hand.
5. For a shortlist run, `set stage research`. Say in one line what started, the vehicle and what happens next, then
   go on with the questions.

## 5. Folding results in

At the next natural turn, never mid-question (`plan news` returns `research_status` events with state `done` or
`failed`):

- **`done`**: read the scores (`plan show <task> --json`) and the report. Say which ideas moved, whether the leader
  changed, and flag any idea whose verdict flipped (a gate that now fails, a score that dropped a point or more).
  Settle nothing for the user. Resolve the matching request if there is one.
- **`failed`**: say so with the `note`, and offer a smaller rerun (fewer ideas, `depth: "quick"`, one topic).

## 6. While research runs

If the stage is `research` (a shortlist run), ask the Frame seeds that do not depend on which idea wins: who,
appetite, no-gos. The user keeps moving, and the answers fit every candidate. Hold the seeds that depend on the
winner (story, success) until promote.
