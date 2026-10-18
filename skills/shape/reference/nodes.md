# Node recipes: event JSON that the CLI accepts

Loaded from SKILL.md §1 step 3. The contract (§3, §4) is the spec; these shapes were run against the real CLI (the
Quick dry run "add a --json flag to `crew ls`"). Send each with `~/.claude/bin/plan event <task> --json '<obj>'`
(session events default to `--by session --source terminal`), or on stdin with a quoted heredoc when the text has
quotes, and append `| jq -r .summary`. Omitted optional fields take defaults; unknown fields are rejected (exit 2).
Leave `id` out to create (the summary names the new id); include `id` to update only the fields you send.

## Frame (the user's words: settled, refs the question)

```json
{"type":"upsert","node":{"kind":"story","label":"HQ and a shell script both had to parse crew ls column text","status":"settled","body":"HQ web (data.ts parseBoard) and the HQ pane parse the text table of `crew ls`. Last week the user wanted `crew ls | jq` in a script and had to awk the columns.","evidence":"user, 2026-10-17; mods/hq/web/data.ts:137 runs `crew ls` and parses stdout","refs":["Q1"]}}
{"type":"upsert","node":{"kind":"user","label":"The user: HQ and personal shell scripts","status":"settled","context":"one machine; bash, jq and bun installed","refs":["Q2"]}}
{"type":"upsert","node":{"kind":"constraint","tag":"appetite","label":"Appetite: 1 day","status":"settled","refs":["Q3"]}}
{"type":"upsert","node":{"kind":"constraint","tag":"stack","label":"Bash and Python 3 stdlib only; no new dependencies","status":"settled","refs":["Q7"]}}
{"type":"upsert","node":{"kind":"nongoal","label":"No --json on other crew commands","why":"nothing else needs it yet","status":"settled","refs":["Q4"]}}
{"type":"upsert","node":{"kind":"goal","label":"Scripts and HQ read the crew task list without parsing text","status":"settled","refs":["Q5"]}}
{"type":"upsert","node":{"kind":"criterion","goal":"G-1","label":"crew ls --json parses with jq and lists the same task ids as crew ls","verify":"diff of the two id lists is empty on the real crew dir","status":"settled","refs":["Q5"]}}
{"type":"set","field":"tldr","value":"<who>. <problem>. <outcome>."}
{"type":"set","field":"stage","value":"explore"}
```

## Explore / Decide

A choice you make yourself (mechanical or taste), logged so the page shows it and the user can reopen it:

The new question's id is whatever the upsert's summary prints (`added Q<n>: …`); the seeds already own the low ids
(Standard's Q6 is the reuse seed), so never type an id you did not read. Capture it, then answer and cite it:

```bash
plan=~/.claude/bin/plan
q=$($plan event <task> --json '{"type":"upsert","node":{"kind":"question","lane":"decisions","stage":"decide","class":"mechanical","blocking":false,"label":"Build the JSON with jq or by hand-escaping with printf?","why":"Decides whether notes with quotes or tabs can break the output","options":[{"key":"a","label":"jq -n --arg per row","why":"crew already requires jq"},{"key":"b","label":"printf with manual escaping","why":"easy to get wrong"}],"recommended":"a"}}' | jq -r .summary | grep -o 'Q[0-9]*' | head -1)
$plan event <task> --json '{"type":"answer","node":"'"$q"'","choice":"recommended"}'
$plan event <task> --json '{"type":"upsert","node":{"kind":"decision","label":"Build the JSON with jq --arg per row","chose":"jq -n --arg per row, collected into one array","alternatives":["printf with manual escaping","a python3 helper"],"why":"jq is already a crew dependency and escapes every value","status":"settled","by_default":true,"refs":["'"$q"'"]}}'
```

Drafts you propose (open until a playback settles them):

```json
{"type":"upsert","node":{"kind":"approach","label":"Emit JSON from the existing ls loop","alternatives":["a python helper","a --format flag"],"status":"open"}}
{"type":"upsert","node":{"kind":"requirement","label":"crew ls --json MUST print one JSON array; each item has id, section, state, age_s, shape, repo, note","status":"open"}}
{"type":"upsert","node":{"kind":"requirement","nfr":true,"label":"crew ls --json MUST finish in under 1 s for 300 tasks","status":"open"}}
{"type":"upsert","node":{"kind":"assumption","label":"jq is installed wherever crew runs","validate_by":"command -v jq in the test","impact":"--json fails with a clear error","status":"open"}}
{"type":"upsert","node":{"kind":"edge","label":"A note with quotes, tabs or newlines","expect":"escaped; output still parses","status":"open"}}
```

An NFR (`"nfr":true`) must carry a digit in its label or body, or the CLI rejects it. A node that waits on an open
question: `"depends_on":["Q9"]` (the PRD shows `[NEEDS CLARIFICATION: Q9]`). An assumption renders in §7 even while
open ("unvalidated"); `strike` kills it, settling means validated.

## Shape

```json
{"type":"upsert","node":{"kind":"risk","label":"Notes with control characters break the JSON","approach":"build every value with jq --arg; a test feeds a note with a tab and a quote","status":"open"}}
{"type":"upsert","node":{"kind":"slice","order":1,"label":"crew ls --json prints the task array","why_priority":"walking skeleton: the whole change in one step","independent_test":"crew ls --all --json | jq -e 'type == \"array\"'","scenarios":["Given 3 tasks, When I run crew ls --all --json, Then stdout is an array of 3 objects"],"exit":"the test script passes on the real crew dir","refs":["FR-001","FR-002"],"status":"open"}}
{"type":"upsert","node":{"kind":"boundary","tier":"always","label":"Run the new test and the existing crew tests before reporting","status":"open"}}
{"type":"upsert","node":{"kind":"boundary","tier":"ask","label":"Changing the text output of crew ls","status":"open"}}
{"type":"upsert","node":{"kind":"boundary","tier":"never","label":"Edit HQ to read --json in this task","status":"open"}}
{"type":"upsert","node":{"kind":"boundary","tier":"command","label":"bash home/.claude/bin/test-crew-ls-json.sh","status":"open"}}
{"type":"upsert","node":{"kind":"task","slice":"S1","label":"Add --json to cmd_ls with a test script","files":["home/.claude/bin/crew","home/.claude/bin/test-crew-ls-json.sh"],"check":"bash home/.claude/bin/test-crew-ls-json.sh","refs":["FR-001","FR-002","SC-001"]}}
```

Then the playback question (questions.md §5) with `fills` = every open draft above except tasks. Lint needs: every
settled FR in a settled slice's `refs` with scenarios, every settled FR and SC in some task's `refs`, every task with
a `check`. Tasks start `todo`; `depends_on` between tasks orders them, `parallel: true` marks [P].

## Ideate and Research (contract §12; playbook in `ideate.md`)

These nodes never render in `PRD.md`. Leave `id` out to create; the summary names the new id (`I1`, `K1`, `RS1`).
`weight` and `default_weight` are the same at creation (0–50); a `gate` rubric has both 0 and never a weight.

```json
{"type":"upsert","node":{"kind":"rubric","group":"weighted","label":"Clear user value","weight":30,"default_weight":30,"origin":"the brief, criterion 2","status":"settled"}}
{"type":"upsert","node":{"kind":"rubric","group":"gate","label":"Uses only the approved data sources","weight":0,"default_weight":0,"origin":"teammate's go/no-go doc","status":"settled"}}
{"type":"upsert","node":{"kind":"idea","label":"Landed-cost checkout","hook":"Show the full price, duties included, before the buyer pays","pitch":"At checkout, add duties and shipping for the buyer's country to the total and show the split.","who":"Cross-border buyers","win":"The demo moment: the price does not change at the last step","tier":"Tier 1","sources":["brief.md section 3"],"checks":{"allowed":{"verdict":"ok","label":"Within the rules","note":"rules section 4 allows third-party data"},"exists":{"verdict":"warn","label":"Partly exists","note":"two plugins show duties but not at checkout"},"feasible":{"verdict":"ok","label":"Fits the appetite","note":"one API, two days"}}}}
{"type":"upsert","node":{"kind":"research","scope":"shortlist","targets":["I1","I3"],"vehicle":"sublead","state":"queued","note":"two ideas, full depth: a sub-lead owns the run","label":"Shortlist research: I1, I3"}}
```

A score from documents (`basis` defaults to `session`; research runs send `"basis":"research"` and `sources`). A gate
rubric takes `pass` (true, false or null) instead of `value`:

```json
{"type":"score","node":"I1","rubric":"K1","value":3.5,"label":"From the brief","rationale":"The brief names buyers who abandon at the last step","sources":["brief.md section 3"],"basis":"session"}
{"type":"score","node":"I1","rubric":"K2","pass":true,"label":"Passes","rationale":"Only the approved sources are used"}
```

`research_status` (the job's own events, `--by session --source build`):

```json
{"type":"research_status","node":"RS1","state":"running","run":"wf-1","note":"3 topics, 14 agents"}
```

## Requests, answers, stages

```json
{"type":"resolve","ref":"e-490d50ff6d2b"}
{"type":"answer","node":"Q3","choice":"recommended"}
{"type":"answer","node":"Q1","text":"<the user's words>"}
{"type":"park","node":"Q9"}
{"type":"reopen","node":"Q12"}
{"type":"set","field":"stage","value":"shape"}
{"type":"approve_prd"}
{"type":"task_status","node":"T-001","status":"done","ok":true,"note":"check passed"}
```

Answers and `approve_prd` the user gave in the terminal go with `--by user --source terminal`; `task_status` from a
build with `--source build`.
