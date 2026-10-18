---
name: idea-research
description: Deep, web-verified research that compares a set of ideas (1-8) against criteria and pass/fail gates - fact-checked dossiers, a gap round, an evaluator panel, REPORT.md and a scores.json. Use for "research these ideas", "compare options against criteria", "deep research on candidates", "which of these should we build", "/idea-research", or when /shape hands over a research job.
---

# /idea-research: compare ideas against criteria with fresh evidence

Runs the saved Workflow `idea-research` (`~/.claude/workflows/idea-research.js`). Each topic is researched and
fact-checked, a critic asks what is missing, an evaluator panel scores every idea on every criterion and judges every
gate, and a synthesis agent writes `REPORT.md`. `scores.json` is computed in the script from the evaluators' numbers
(mean, one decimal; gate = majority of pass/fail votes), never by a model. Interface: `/shape` `reference/contract.md`
§12.5.

Invoking `/idea-research`, or a research request from /shape, is the user's opt-in for the Workflow tool.

## Steps

1. **Gather the inputs.** Read the user's documents first (rules, briefs, go/no-go docs), then ask only for what is
   still missing:
   - `context`: the situation in a paragraph, plus the paths of docs agents should read.
   - `ideas`: 1-8 of `{id, name, pitch}`. From /shape use the plan's idea node ids (`I1`) and the criteria's `K` ids.
   - `criteria`: `{id, name, description, weight}` (weighted or lens rubrics).
   - `gates`: `{id, name, description}` pass/fail must-haves; `gate_docs`: absolute paths of teammate or user docs
     whose criteria are gates (each gets its own research topic). Put those criteria in `gates` too, so evaluators
     can vote on them.
   - Optional: `evaluators` (personas; a skeptic and a literal reader are always added), `topics` (replaces the
     generated topics for a narrow ask), `depth` `"quick"` (fewer topics, no gap round, 3 evaluators).
2. **Build args** with `dir` (absolute output folder, e.g. `<task dir>/research/<n>`), `today` (today's date,
   YYYY-MM-DD; take it from the system date, not memory) and the fields above.
3. **Dry run first.** Call the Workflow with `name: "idea-research"` and `args` plus `dry_run: true`. It runs no agent
   and returns `topics`, `agents` and `models`. Tell the user the cost in one line, from the result:
   `~54 agents: 43 sonnet, 11 opus (max, full depth), N topics`. **Ask before the real run**, unless the plan's
   research node already carries the user's go-ahead (in /shape, the node and §12.5 say who asks).
4. **Run it in the background** (same args, no `dry_run`). A full run takes a long time; keep talking meanwhile.
5. **When done**, read `REPORT.md` (verdict first) and `scores.json`. Give the user the verdict, the ranking, any
   failed gate, and the report path. An invalid-args error names the field: fix it and re-run the dry run.

## When called for a plan (from /shape)

Set `T` (task id), `RS` (research node id), `RUN` (workflow run id) and `D` (the `dir`) in the environment, then send
`research_status` first and last. The snippet counts rejected events: it sends `done` only when none failed.

```bash
PLAN=${PLAN:-$HOME/.claude/bin/plan}; : "${T:?}" "${RS:?}" "${RUN:?}" "${D:?}"
ev() { $PLAN event "$T" --by session --source build --json "$1" </dev/null; }
ev "{\"type\":\"research_status\",\"node\":\"$RS\",\"state\":\"running\",\"run\":\"$RUN\"}" | jq -r .summary
# ... after the Workflow returns:
set -o pipefail; failures=0
evs=$(jq -c '.ideas | to_entries[] | .key as $i | ((.value.scores | to_entries[] | {type:"score",node:$i,rubric:.key,value:.value.value,label:.value.label,rationale:.value.rationale,sources:.value.sources,basis:"research"}), (.value.gates | to_entries[] | {type:"score",node:$i,rubric:.key,pass:.value.pass,rationale:.value.note,sources:.value.sources,basis:"research"}))' "$D/scores.json") || failures=1
while read -r e; do
  [ -n "$e" ] || continue
  ev "$e" | jq -r .summary || failures=$((failures+1))
done <<< "$evs"
if [ "$failures" -eq 0 ]; then st="\"state\":\"done\",\"report\":\"$D/REPORT.md\""
else st="\"state\":\"failed\",\"note\":\"$failures score events failed; see the plan stderr and scores.json\""; fi
ev "{\"type\":\"research_status\",\"node\":\"$RS\",$st}" | jq -r .summary
```

On a Workflow failure send `state: "failed"` with a `note` instead. A rejected score event (exit 2, for example a rubric
id the plan does not have) makes the run `failed`: fix the ids in the args, do not edit scores.json. The Workflow itself
throws, naming `dir`, when no evaluator returns, synthesis returns nothing, or `scores.json` was not written; treat
that as a failed run (the dossiers stay in `dir`).

## Notes

- Every prompt carries the freshness rule built from `today`: facts are web-verified as of that date, the latest edition
  of every statistic is used, each claim is labelled OPENED / SEARCH-ONLY / INFERRED.
- Output files in `dir`: `<key>.md` and `<key>.factcheck.md` per topic, `REPORT.md`, `scores.json`.
- Keep ideas to what the user listed; do not invent candidates. A failed research or evaluator agent is logged and the
  run continues; if no evaluator returns, the run stops and the dossiers stay in `dir`.
