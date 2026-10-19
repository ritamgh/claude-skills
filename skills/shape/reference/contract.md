# /shape contract: plan.json, events, `plan` CLI, PRD, lint, HQ routes

The one place that fixes formats and interfaces. Every piece of /shape (CLI, PRD generator, lint, HQ routes, plan page,
skill) builds against this file. Change it first, then the code.

## 1. Files

A plan belongs to one crew task. Its working directory is `$CREW_ROOT/<task-id>/plan/` (`CREW_ROOT` defaults to
`~/.claude/crew`):

| File | Written by | What |
|---|---|---|
| `plan.json` | `plan` CLI only (under `.lock`) | the plan: the single source of truth |
| `PRD.md` | `plan` CLI, after every applied event | deterministic projection of `plan.json` (§8) |
| `events.jsonl` | `plan` CLI only | every applied event, one JSON object per line, append-only (the audit trail) |
| `session.cursor` | `plan news` | line count of `events.jsonl` the session has already seen |
| `.lock` | `plan` CLI | `fcntl.flock` exclusive lock held for every read-modify-write |
| `.review.lock` | `plan review` | `fcntl.flock` exclusive lock held for a whole `plan review` command (any action), so two runs cannot reply twice and a `pull` cannot list a reply a `post` has sent but not yet recorded |

Writes of `plan.json` and `PRD.md` are atomic: write `<name>.tmp` in the same directory, then `os.replace`. Readers
(HQ) therefore see the old or the new file, never half of one.

**Write order** for every applied event, all under the lock: validate → apply in memory → append the event line to
`events.jsonl` → write `PRD.md` → write the mirror (if published) → write `plan.json` last. A reader that reads
`plan.json` first and then `PRD.md` (HQ does) therefore never gets a PRD older than the plan it read. A crash between
steps leaves `events.jsonl` ahead of `plan.json`; that is detectable (last event `rev` > plan `rev`) and not repaired
automatically.

**Published mirror.** `plan publish` sets `published` to an absolute directory (normally `<repo>/docs/prd/<slug>/`).
From then on every write also writes `PRD.md` and `plan.json` there. The crew task dir stays the working copy; the
repo copy is an output, committed at the gate and as the build changes it. (`events.jsonl` is never mirrored.) The
mirror's `plan.json` is the public view: it omits `comments`, `thread`, `comment_seq`, `review_pr` and the `requests` of
type `comment` or `review` (§13, §14), so teammate names, comment text and the review PR stay in the local plan dir; the
local `plan.json` keeps them.

Task ids match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and must not contain `..` (same rule as HQ `isTaskId`).

## 2. plan.json

```jsonc
{
  "schema": 1,
  "id": "1017-offline-sync",          // crew task id
  "slug": "offline-sync",             // task id without the leading NNNN- date prefix
  "title": "Offline sync for notes",
  "owner": "user",
  "size": "standard",                 // quick | standard | deep
  "stage": "decide",                  // ideate | research | frame | explore | decide | shape | ready | building | shipped
  "rev": 14,                          // +1 per applied event; 0 after init
  "created": "2026-10-17T09:12:00Z",  // UTC, seconds, Z
  "updated": "2026-10-17T10:40:31Z",
  "repo": "/home/user/Developer/notes",   // target repo, absolute, or null
  "published": null,                  // absolute mirror dir, or null
  "approved": null,                   // {"at": iso, "rev": n} once approve_prd passed
  "tldr": "",                         // PRD §1, 3 sentences, written by the session
  "frontier": ["Q7", "Q8", "Q11"],    // DERIVED on every write (§5); never set by an event
  "progress": {"settled": 14, "total": 22},   // DERIVED: questions settled / questions not killed
  "requests": [],                     // page requests waiting for the session (§4.3)
  "recent": [],                       // DERIVED: last 30 applied events, summarised (§4.4)
  "nodes": [],                        // §3, in creation order
  // optional (absent = empty), §13/§14: "comments": [], "thread": [], "comment_seq": 0, "review_pr": null
}
```

Unknown top-level keys are an error on load (exit 2 from any command): the format is closed so drift shows up early.
The only optional keys are `comments`, `thread`, `comment_seq` (§13) and `review_pr` (§14); every other key above is required.

## 3. Nodes

Every node has the common fields; kinds add their own. All text is plain UTF-8; `body` may hold Markdown.

| Field | Type | Notes |
|---|---|---|
| `id` | str | kind prefix + number, see table; assigned by the CLI when an upsert omits it |
| `kind` | str | see table |
| `label` | str | ≤ 120 chars, one line, required |
| `body` | str | ≤ 4000 chars, default `""` |
| `status` | str | `open` \| `settled` \| `parked` \| `killed`; tasks use `todo` \| `doing` \| `done` \| `failed` |
| `depends_on` | [id] | nodes that must be settled (or done) first; drives frontier and the graph |
| `refs` | [id] | nodes this one cites (a task covers FR/SC, a slice covers FRs, a decision settles a question) |
| `rev` | int | plan rev of the last change to this node |
| `by` | str | `user` \| `session`: who last changed it |
| `by_default` | bool | true = accepted as a default, never examined by the user (assumptions, decisions, constraints) |
| `thread` | [entry] | optional, absent = empty. The node's conversation, oldest first: `{"role": "user"\|"session", "text": str ≤ 2000, "at": iso, "ref": "<event id of the ask>"}`. Written only by `ask` (user entry) and `reply` (session entry); last 40 kept; never rendered into `PRD.md` |

| kind | id | lane | PRD § | extra fields |
|---|---|---|---|---|
| `story` | `P1` | why | 2 | `evidence` (str: how we know) |
| `user` | `U1` | who | 3 | `context` (str) |
| `goal` | `G-1` | why | 4 | |
| `criterion` | `SC-001` | why | 4 | `verify` (str: how it is checked), `evidence` (str, filled at Shipped), `goal` (G id or null) |
| `nongoal` | `NG-1` | scope | 5 | `why` (str) |
| `constraint` | `C-1` | scope | 6 | `tag`: `appetite` \| `stack` \| `perf` \| `security` \| `other` |
| `assumption` | `AS-1` | risks | 7 | `validate_by` (str), `impact` (str). status open = unvalidated, settled = validated, killed |
| `slice` | `S1` | slices | 8, 16 | `order` (int, S1 = walking skeleton), `why_priority`, `independent_test`, `scenarios` ([str], Given/When/Then), `exit` (milestone exit criterion); `refs` = FRs it covers |
| `requirement` | `FR-001` | scope | 9 | `nfr` (bool; NFRs must carry a number) |
| `edge` | `E-1` | scope | 10 | `expect` (str: expected behaviour); or `refs` a question |
| `risk` | `R-1` | risks | 11 | `approach` (str: pre-decided approach or time-boxed spike) |
| `approach` | `A-1` | decisions | 12 | `alternatives` ([str]) |
| `boundary` | `B-1` | scope | 13 | `tier`: `always` \| `ask` \| `never` \| `command` |
| `question` | `Q1` | any (field `lane`) | 14 while unsettled | §3.1 |
| `task` | `T-001` | tasks | 15 | `slice` (S id), `files` ([str]), `parallel` (bool), `check` (str: a command), `result` ({ok, at, note} or null), `crew` (task id or null); `refs` = FR/SC ids it covers |
| `decision` | `DEC-1` | decisions | 17 | `chose` (str), `alternatives` ([str]), `why` (str); `refs` = questions it settles |
| `discovery` | `X-1` | tasks | 18 | `evidence` (str) |
| `note` | `N-1` | any (field `lane`) | none | free note from the user or session |
| `idea` | `I1` | ideas | none | §12.1 |
| `rubric` | `K1` | ideas | none | §12.1 |
| `research` | `RS1` | ideas | none | §12.1 |

Lanes, in page order: `ideas`, `why`, `who`, `scope`, `decisions`, `risks`, `slices`, `tasks`.

Numbers: the next number for the prefix is max existing + 1 (so removing the highest id lets it be reused; remove is
rare). Zero-padded to 3 for `SC-`, `FR-`, `T-`; unpadded otherwise.

**Node validation** (closed, like the top level): a field not listed for the node's kind is invalid. Omitted optional
fields take defaults: str → `""`, list → `[]`, bool → `false`, int → `0`, object/ref → `null`. `rev` and `by` are set
by the CLI (values sent by a caller are ignored). A question's `answer` is set only by `answer`/`reopen` events, never by
`upsert`; likewise `thread`: an upsert that names it is refused (exit 2). An upsert may not change a node's `kind`. Every id in `depends_on`, `refs`, `fills`, `goal` and `slice`
must exist; `depends_on` must not form a cycle; `fills` may name any kind except question and task.

**Status by kind.** New nodes are `open` (tasks `todo`) unless the upsert says otherwise. `open` means drafted but not
agreed; the session sets `settled` when the user has agreed (an answer, a playback "yes").

### 3.1 Questions

```jsonc
{
  "id": "Q7", "kind": "question", "lane": "decisions",
  "label": "Conflict policy when two devices edit the same note",
  "why": "Decides the data model and two slices",          // why we ask, shown on the focus card
  "stage": "decide",              // ideate | research | frame | explore | decide | shape: the stage that asks it
  "class": "taste",               // mechanical | taste | user (autoplan triage; `user` is never auto-decided)
  "options": [
    {"key": "a", "label": "Last-write-wins", "why": "solo users, 2-week appetite"},
    {"key": "b", "label": "Field-level merge", "why": ""},
    {"key": "c", "label": "Ask the user on a clash", "why": ""}
  ],
  "recommended": "a",             // an option key or null
  "answer": null,                 // {"choice": key|null, "text": str|null, "by": "user"|"session", "source": ..., "at": iso, "rev": n}
  "priority": 0,                  // higher first; `prioritize` sets max+1
  "blocking": true,               // must be settled before the PRD can be approved
  "fills": ["DEC-3"],             // nodes this answer settles (status → settled) when answered
  "status": "open", "depends_on": ["Q3"], "refs": [], "body": "", "rev": 9, "by": "session", "by_default": false
}
```

Options: 0–6, keys `a`…`f`. A question with no options takes free text only.

## 4. Events

Every change is an event. `plan event` validates it, applies it, bumps `rev`, recomputes the derived fields, writes
`plan.json`, renders `PRD.md`, and appends the event to `events.jsonl`, all under the lock. An invalid event changes
nothing and is not appended.

Stored line (the CLI fills `v`, `id`, `at`, `by`, `source`, `rev`; callers send only `type` and its fields):

```json
{"v":1,"id":"e-3f9a1c2b7d10","at":"2026-10-17T10:40:31Z","by":"user","source":"page","rev":15,"type":"answer","node":"Q7","choice":"recommended"}
```

- `by`: who decided: `user` | `session`. `source`: where it came from: `page` | `terminal` | `build`.
- `id`: `e-` + 12 lowercase hex chars, random.
- Text fields are stripped; empty after stripping is invalid. `text` ≤ 2000 chars (a `comment` event's: ≤ 5000, §13), `label` ≤ 120 chars.

### 4.1 User events (allowed from the page; also from the terminal with `--by user --source terminal`, except `comment_accept` and `review`, which are page-only: §14.3)

| type | fields | effect | invalid when |
|---|---|---|---|
| `answer` | `node` (Q id), `choice` (option key or `"recommended"`), `text` | `answer` set; question → settled; each `fills` node → settled; `"recommended"` resolves to the key | node not a question; question killed; choice unknown; `"recommended"` with no recommendation; neither choice nor text |
| `park` | `node` | → parked ("decide later") | node is a task |
| `reopen` | `node` | → open (tasks → todo); a question's `answer` → null | node is open/todo already |
| `strike` | `node` | assumption → killed | node not an assumption |
| `prioritize` | `node` | question `priority` = max priority + 1 | node not an open question |
| `edit_label` | `node`, `label` | label replaced | |
| `note` | `text`, optional `node`, optional `lane` | adds a request (§4.3) | |
| `ask` | `text`, optional `node` | adds a request: the user asks something about a node. With a `node` it also appends a `user` entry (`ref` = the event id) to that node's `thread`; the node's `rev`/`by` are not touched. Without a `node` it is a plan-level message: the `user` entry (`ref` = the event id, `links` `[]`) goes to the plan `thread` (§13) | |
| `expand` | `node`, optional `text` | adds a request: "give me more options here" | |
| `comment`, `comment_accept`, `comment_rework`, `comment_delete` | §13 | a teammate's comment is recorded; the user accepts, reworks or deletes the session's proposal for it | §13 |
| `review` | §14 | the user asks the session to open, push, pull or post the GitHub review PR (by `user` only) | §14 |
| `boost`, `kill`, `restore`, `merge`, `twist`, `promote`, `weight`, `weights_reset`, `research` | §12.2 | board actions on ideas and rubric weights | §12.2 |
| `approve_prd` | | if `plan lint` has no blocking finding and stage is `shape`: stage → `ready`, `approved` set | stage not `shape` → exit 2; blocking findings → exit 4 |

`node` must exist. `answer` on a settled question re-answers it (the latest answer wins; the old one stays in
`events.jsonl`).

### 4.2 Session events (`--by session` only; HQ never sends these)

| type | fields | effect |
|---|---|---|
| `upsert` | `node` (object) | with `id`: merge the given fields into that node (create it if the id is new and well-formed); without `id`: create, CLI assigns the id from `kind`. Validates kind, required fields, field types, id refs in `depends_on`/`refs`/`fills` |
| `remove` | `node` (id) | node deleted; the id is dropped from other nodes' `depends_on`/`refs`/`fills`; a `goal` or `slice` field naming it becomes `null`; a request naming it keeps its text with `node: null`. Also (§13): comment anchors naming it become `null`, its id is dropped from plan-`thread` `links`, and the `user` entry of each open `ask` request on it moves from its (dropped) node thread into the plan `thread` |
| `set` | `field` (`title`\|`tldr`\|`stage`\|`size`\|`owner`\|`repo`\|`published`), `value` | top-level field set. Stage rules below |
| `resolve` | `ref` (event id) | removes that request from `requests`. Invalid for a `comment` request (§13: triage, split or delete the comment) |
| `reply` | `ref` (event id of an open `ask` request), `text` (≤ 2000, non-empty), optional `links` | appends a `session` entry (same `ref`) to that node's `thread` and removes the request like `resolve`; summary "replied on Q7". The node's `rev`/`by` are not touched. A request with no node (a plan-level ask, or one whose node was removed) is answered into the plan `thread` instead, summary "replied on plan"; only that reply takes `links` (§13). Invalid when `ref` is not an open `ask` request, or `text` is empty |
| `comment_split`, `comment_triage` | §13 | session-only: break a pasted comment into several; propose what to do about one |
| `review_set`, `comment_import`, `comment_posted` | §14 | session-only: record the review PR; import its comments; record a reply posted to GitHub |
| `task_status` | `node` (T id), `status` (todo/doing/done/failed), optional `ok` (bool), optional `note` | task status; `result` = {ok, at, note} when `ok` given |
| `score`, `research_status` | §12.3 | an idea's score or gate verdict; a research job's progress |

The session may also send any user event type (with `--by session`, e.g. an autoplan auto-decision), except
`comment_accept`, `comment_rework`, `comment_delete` and `review`, which require `--by user` (§13, §14); `comment_accept` and `review` also require `--source page`.

**Stages.** `ideate`, `research`, `frame`, `explore`, `decide`, `shape` may be set freely among themselves (forward or back). `ready` is
reached only through `approve_prd`. `building` may be set only from `ready`, `shipped` only from `building`. Setting a
stage below `ready` clears `approved`. After approval, any further applied event that changes a node keeps `approved`
but the PRD header says `Approved at rev N; changed since (rev M)` so the drift shows.

**Answer side effects.** `answer` settles the question and its `fills`. `reopen` of a question clears its `answer`
and leaves its `fills` nodes as they are: the session decides whether they still hold. Re-answering also leaves
`fills` settled.

### 4.3 Requests

`note`, `ask` and `expand` need the session's judgment, so they also land in `requests`:
`{"ref": "<event id>", "type": "ask", "node": "Q7"|null, "lane": null, "text": "...", "at": iso}`. They stay there
until a `resolve` event (or, for an `ask`, a `reply`) names them. The page shows them as "waiting for the session".
An `ask` with `node: null` is a plan-level message (the PRD pane). A `comment` request (§13) has `ref` = the comment
id (`CM3`), `node` = the anchor when it is a node id (else `null`), `text` = the comment text; it is removed by
`comment_triage`, `comment_split`, `comment_delete`, never by `resolve`. A `review` request (§14) has `ref` = the event
id, `node` `null`, `text` = `<action>` or `post CM1,CM2`; the session closes it with `resolve` after the outward call
succeeded.

An `ask` is answered in the plan: the session sends `reply` (`ref` = the ask's event id, `text` = its answer), which
records the answer in the node's `thread` and removes the request. The conversation therefore lives in `plan.json`
and is shown on the node; the terminal is not the only place the answer exists. `plan news --json` lists the page's
`ask` with its `text` and `node`, so the session answers without opening `plan.json`.

### 4.4 recent

Last 30 applied events, newest first: `{"rev", "at", "by", "source", "type", "node", "summary"}`. `summary` is a short
human line made by the CLI ("answered Q7: Last-write-wins", "parked Q9", "note on S2").

## 5. Frontier (derived)

Eligible: questions with status `open` whose `depends_on` nodes are all settled or done (killed counts as settled).
Order: `priority` desc → stage order (ideate, research, frame, explore, decide, shape) → number of nodes with status `open` that list it directly in `depends_on` (desc)
→ id number asc. `frontier` holds all eligible ids in that order; the first is the focus. A question that is open but
not eligible is *blocked* (the page derives that; it is not stored).

## 6. `plan` CLI

`~/.claude/bin/plan` → `python3 <skill>/scripts/plan.py`. Python 3 standard library only.

| Command | Does | Output | Exit |
|---|---|---|---|
| `plan init <task> --title T [--size S] [--repo DIR] [--owner NAME]` | create `plan/` with the size's seed questions (`scripts/seeds.json`), stage `frame`, rev 0; render PRD | the plan dir | 0; 2 if a plan exists |
| `plan event <task> [--by user\|session] [--source page\|terminal\|build] (--json OBJ \| -)` | §4 | `{"ok":true,"rev":n,"event":{…},"summary":"…"}` | 0; 2 invalid (reason on stderr); 3 no plan; 4 approve rejected (stdout `{"ok":false,"lint":[…]}`) |
| `plan show <task> [--json]` | title, stage, rev, progress, frontier top 3 with recommendation, open requests | text or the plan | 0; 3 |
| `plan frontier <task> [-n N] [--json]` | ranked eligible questions | text or `[{id,label,why,options,recommended}]` | 0; 3 |
| `plan news <task> [--json] [--peek]` | events since `session.cursor` with `by=user` and `source=page`, plus `research_status` events with state `done` or `failed` (any by/source, §12.3), then advance the cursor (`--peek`: don't) | one line each, or JSON list | 0; 3 |
| `plan render <task>` | re-render `PRD.md` (and mirror) | paths | 0; 3 |
| `plan lint <task> [--json]` | §9 | findings | 0 clean; 1 blocking findings; 3 |
| `plan publish <task> --to DIR` | applies a session event `set published DIR` (so it is audited like any change), which writes the mirror | paths | 0; 2 when DIR is not absolute or cannot be created; 3 |
| `plan path <task>` | print the plan dir | | 0; 3 |
| `plan list [--json]` | every task under `$CREW_ROOT` with a `plan/plan.json` | `[{id,title,stage,rev,progress,updated}]` | 0 |
| `plan export <task> --to crew\|orchestrate [--markdown]` | §6.1; read-only, needs stage `ready` or `building` | JSON (or ledger-ready Markdown for orchestrate) | 0; 2 stage below ready; 3 |

`--by` defaults to `session`, `--source` to `terminal`. Default `--size` is `standard`.

### 6.1 `plan export`

Read-only: it prints what to create and never runs `crew` itself. Tasks with status `done` are left out. `prd` is
`<published>/PRD.md` when `published` is set, else `<plan dir>/PRD.md`. `rules` = the label of every settled `never`
boundary, then "Non-goal: <label>" for every settled non-goal.

- `--to crew`: `{"kind":"crew","prd":…,"repo":…,"tasks":[{"id","slug","title","brief","check","files","refs"}]}`. `slug`
  = `<plan slug>-<t id lowercased>`; `brief` = these lines, in order: `Goal: <tldr's first sentence>`, `PRD: <prd> (cite
  ids, never paste)`, `Task: <id> <label>`, `Covers: <refs joined by ", ">`, `Files: <files>`, `Check: <check>`, then
  one `Rule: <rule>` line per rule.
- `--to orchestrate`: `{"kind":"orchestrate","prd","repo","goal":<tldr>,"success_criteria":[{id,label}],
  "review_focus":[{id,label}] (settled risks, most likely first by id order),"rules":[…],"cards":[{"id","concern":<label>,
  "owns":<files>,"check","depends_on":<task ids only>,"refs","slice"}],"waves":[[ids]…]}`. `slice` = the first settled
  slice whose `refs` contain the task id or one of the task's refs, else null. `waves` = levels of the task dependency
  graph (a wave holds tasks whose task dependencies are all in earlier waves, ids ascending); two tasks in one wave that
  share a file are listed in `"chains":[[ids]…]`.
- `--markdown` (orchestrate only): a first line `Plan: <task>` (the §6.2 link), then the same as ledger sections `## Goal`, `Success criteria:` (numbered), `## Review
  Focus` (numbered), `## Tasks` (the ledger table: id, concern, worker blank, owns, check, status `pending`), `## Waves`,
  `## Worker rules (from the PRD)`.

### 6.2 Build sync

A ledger line `Plan: <task>` links an orchestration to a plan. When `merge-card` merges a card whose id is a task id
(`T-\d{3}`) and validation is green, it runs `plan event <task> --source build --json
'{"type":"task_status","node":"<id>","status":"done","ok":true,"note":"merged <sha>"}'`; any failure prints a warning
and never changes merge-card's exit code.

## 7. Python interfaces (`skills/shape/scripts/`)

```python
# plan_core.py (B1)
def plan_dir(task_id: str) -> pathlib.Path            # raises PlanError(3) when missing
def load(task_id: str) -> dict
def apply_event(plan: dict, event: dict) -> str       # mutates plan, returns the summary line; raises PlanError(2|4)
def frontier(plan: dict) -> list[str]
class PlanError(Exception): code: int                 # exit code

# prd.py (B2)
def render(plan: dict) -> str                         # pure, deterministic: same plan → byte-identical text

# lint.py (B2)
def lint(plan: dict) -> list[dict]                    # [{"rule","severity":"block"|"warn","node":id|None,"section":int|None,"message"}]
MANDATORY: dict[str, list[int]]                       # size → PRD sections that must not be empty
```

`plan_core` imports `prd` and `lint`; neither imports `plan_core`.

## 8. PRD.md

First line: `<!-- Generated from plan.json rev <n> by `plan render`. Do not edit: change the plan. -->`. Then sections 0–18 in
order, each `## <n>. <Title>`. A section with nothing settled shows `> Pending: <intent>` (intents below) instead of
content. Open questions are referenced inline as `[NEEDS CLARIFICATION: Q7]` wherever a node `depends_on` an open
question. Node ids are always printed (`**FR-003** System MUST …`), so tasks, tests and reviews can cite them.

| § | Title | From | Pending intent |
|---|---|---|---|
| 0 | Header | title, owner, size, stage, rev, updated, approved | (never pending) |
| 1 | TL;DR | `tldr` | Three sentences: who, problem, outcome |
| 2 | Problem & evidence | story | One concrete story and how we know |
| 3 | Users & context | user | Who it is for and where they work |
| 4 | Goals & success criteria | goal, criterion (grouped under their goal) | Goals with measurable success criteria |
| 5 | Non-goals | nongoal | What we will not do, and why |
| 6 | Appetite & constraints | constraint (appetite first) | Time budget and hard limits |
| 7 | Assumptions | assumption (with status) | What we believe but have not checked |
| 8 | Slices | slice by `order` | Vertical slices, walking skeleton first |
| 9 | Requirements | requirement (FR then NFR) | What the system must do |
| 10 | Edge cases | edge | Expected behaviour at the edges |
| 11 | Risks & rabbit holes | risk | What could sink it and the pre-decided way round |
| 12 | Technical approach | approach | Architecture and alternatives considered |
| 13 | Agent boundaries | boundary by tier (Always / Ask first / Never / Commands) | What agents always do, ask first, never do |
| 14 | Open questions | questions not settled and not killed | (empty is fine: "None.") |
| 15 | Task map | task, as a table: id · slice · covers · files · depends on · P · check · status | Tasks with a runnable check each |
| 16 | Milestones | slice `exit` | An exit criterion per slice |
| 17 | Decision log | decision (chose; alternatives; why; "default" when `by_default`) | Decisions and why |
| 18 | Progress & discoveries | task status counts, discovery | (empty is fine: "Nothing yet.") |

Which nodes render as content of their section (one rule, shared by prd.py and lint's `empty-section`):

| kind | rendered when status is |
|---|---|
| question | open or parked (in §14 only) |
| assumption | open (shown "unvalidated"), settled ("validated"), killed (struck: `~~AS-2 …~~ (killed)`) |
| task | any |
| every other kind | settled, or parked (suffix `(parked)`); open (still a draft) and killed are left out |

A section "renders as Pending" when none of its nodes render (for §1: `tldr` is empty; §4: no goal and no criterion
renders; §16: no rendered slice has a non-empty `exit`; §14 and §18 never render as Pending, they say "None." /
"Nothing yet.").

## 9. Readiness lint

Blocking (`severity: "block"`):

| rule | fails when |
|---|---|
| `empty-section` | a section in `MANDATORY[size]` would render as Pending |
| `blocking-question` | a question with `blocking: true` is open or parked |
| `fr-no-scenario` | a settled FR (not an NFR: `nfr` true is exempt) is in no settled slice's `refs`, or every settled slice citing it has no scenarios |
| `uncovered` | a settled FR or SC is cited by no task's `refs` (tasks of any status count) |
| `task-no-check` | a task has an empty `check` |
| `no-nongoals` | no settled nongoal |
| `vague` | an FR, NFR or SC label/body uses fast, slow, scalable, easy, simple, intuitive, robust, user-friendly, efficient, seamless, quickly (whole word, any case) and the label + body together contain no digit |

An empty §5 fires both `empty-section` (node null) and `no-nongoals` (node null); that is intended.

Warnings (`severity: "warn"`): `default` (each assumption, decision or constraint with `by_default: true`: the
unexamined defaults to look at once more), `open-question` (non-blocking questions still open).

`MANDATORY`: quick = 0, 1, 2, 4, 5, 8, 13, 15; standard = quick + 3, 6, 7, 9, 11, 12, 16; deep = standard + 10, 17.

## 10. HQ web routes (B3)

Added to `mods/hq/web/server.ts` through `web/plan.ts`. Plan routes are dispatched inside `handle()` **after** the
existing Host, token and POST Origin checks, and use the same `body()` parser, `json`/`text` helpers, security headers
and page nonce/CSP. The task id in a path is decoded once (`decodeURIComponent`, 400 on failure) and must pass
`isTaskId` (400). `AppConfig` gains optional `planBin` and `planPage`; without them the plan
routes answer 404.

| Route | Answer |
|---|---|
| `GET /healthz` | the only route that needs no token (Host check still applies; main listener only: not in `REMOTE_ROUTES`, so the remote one answers 403 with a token, 401 without). `200 {"service":"hq-web","plan":<bool>}`, `plan` true only when both `planBin` and `planPage` are set; nothing else in the body |
| `GET /plan`, `GET /plan/<task>` | `plan.html` with the nonce CSP of `/` |
| `GET /api/plans` | `planBin list --json` output |
| `GET /api/plan/<task>?rev=N` | reads `$crewRoot/<task>/plan/plan.json` and `PRD.md` directly. Same rev → `{"rev":N,"unchanged":true}`; else `{"rev","plan","prd"}`; 404 when missing |
| `POST /api/plan/<task>/event` | body `{type, node?, choice?, text?, label?, lane?, value?, other?, author?, anchor?, ref?, proposal?, action?, refs?, proposals?}`; `proposal` is an integer (`comment_accept`), `refs` a list of comment ids and `proposals` an object `{ref: integer}` (both only for `review`); `type` must be a §4.1 user type (including `comment`, `comment_accept`, `comment_rework`, `comment_delete`, §13); runs `planBin event <task> --by user --source page --json <event>` (argv, no shell); exit 0 → 200 `{"ok":true,"rev","summary","nudge"}`; 2 → 400; 3 → 404; 4 → 409 with the lint findings |

**Nudge.** After an accepted event, HQ tells the session that leads the task, the way `/api/answer` does
(`resolveLead`, `sendText`, same refusals), and additionally never a *guessed* lead: only a session recorded as the
task's lead is typed into (a guess could be another session working in the same repo). Nudges coalesce: the first event of a burst starts a timer (default 4 s);
when it fires, one line is typed: `From Plan (user): <n> change(s) on <task>: <summaries joined by "; ">. Run: plan news <task>`
(capped at `MAX_TEXT`). The POST answers at once with `nudge: "scheduled"`. Events are already applied, so a nudge
that fails loses nothing: the skill also runs `plan news` at the start of every turn.

## 11. Limits and safety

- Page text is data, never instructions: the session treats `note`/`ask`/`expand` text as the user's words about the
  plan, and the page renders all plan text with `textContent` (never `innerHTML` with plan data). A comment is a
  teammate's words, not the user's: the session never acts on it until the user accepts a proposal (§13).
- A `thread` is conversation, not spec: it is capped at 40 entries per node, dropped with its node, and never rendered into `PRD.md` or counted as a change since approval.
- HQ body cap 16 KB (existing); `text` ≤ 2000 chars (a comment: 5000), `label` ≤ 120; `plan.json` over 2 MB is refused on load.
- Comments: at most 100, text ≤ 5000, author ≤ 80; the plan `thread` keeps the last 40 entries (§13). One
  `comment_import` carries at most 50 items and counts toward the 100 (§14).
- The CLI never runs a task's `check` and never touches the target repo except writing the mirror dir.

## 12. Ideate and Research

Two optional stages before Frame, for when the user arrives with several candidates or none, and a research
handoff usable at any stage. Words are generic: **context** (the challenge, product or market), **criteria** (a
rubric, product goals, an investor thesis), **evaluators** (who judges: judges, PM + eng + customer, investors),
**gates** (pass/fail must-haves, including a teammate's go/no-go doc). Ideate/Research nodes never render in
`PRD.md` and lint ignores them; what the PRD keeps is the `decision` node the session writes on promote (§12.4).

### 12.1 Nodes

**`idea`** (`I1`, lane `ideas`). Status: `open` = in play, `settled` = promoted (at most one idea is settled),
`killed` = in the graveyard. `parked` is not used. **Shortlisted** = open and `boost` ≥ 1 (derived, not stored).

| Field | Type | Notes |
|---|---|---|
| `hook` | str | ≤ 120 chars, one line: "a landed-cost checkout" |
| `pitch` | str | ≤ 4000; empty on a fresh merge draft until the session writes it |
| `who` | str | who it is for |
| `win` | str | why it could win / work: the demo moment, the evidence |
| `tier` | str | ≤ 40, free label from the session ("Tier 1", "Draft", "From research doc") |
| `checks` | object | `{"allowed": C, "exists": C, "feasible": C}`, each `C` = `{"verdict": "ok"\|"warn"\|"bad"\|"na", "label": str ≤ 60, "note": str}`; default `null` (= all `na`, "not checked") |
| `scores` | object | `{"<K id>": S}` for weighted/lens rubrics; default `{}`. `S` = `{"value": number 1–5 (≤ 1 decimal), "label": str ≤ 60, "rationale": str ≤ 2000, "sources": [str], "basis": "research"\|"session", "rev": int}` |
| `gates` | object | `{"<K id>": G}` for gate rubrics; default `{}`. `G` = `{"pass": true\|false\|null, "note": str ≤ 2000, "sources": [str], "basis": …, "rev": int}` |
| `boost` | int | 0–3 |
| `kill_reason` | str | set by `kill`, cleared by `restore` |
| `merged_from` | [id] | the two parent ideas of a merge draft |
| `merged_into` | id or null | the latest draft this idea was merged into |
| `twists` | [str] | ≤ 6, each ≤ 300; written by the session, never hardcoded |
| `sources` | [str] | where the idea came from (doc, transcript line, URL) |

`scores`/`gates` keys must name existing rubric nodes of the matching group; `score` events (§12.3) are the normal
way to write them (an upsert may also set them whole). Scores written by the session from documents are
`basis: session`; evaluator scores from a research run are `basis: research` and replace them.

**`rubric`** (`K1`, lane `ideas`): one criterion. Status `open` = proposed, `settled` = agreed, `killed` = dropped.

| Field | Type | Notes |
|---|---|---|
| `group` | str | `weighted` (counts by default) \| `lens` (shown; counts only once weighted) \| `gate` (pass/fail must-have, never weighted) |
| `weight` | int | 0–50; always 0 for `gate` |
| `default_weight` | int | 0–50; what `weights_reset` restores; 0 for `gate` |
| `origin` | str | where it comes from ("official rules §4", "teammate's go/no-go doc", "the user's words") |

**`research`** (`RS1`, lane `ideas`): one research job. Status stays `open`; `state` carries progress.

| Field | Type | Notes |
|---|---|---|
| `scope` | str | `idea` \| `question` \| `shortlist` |
| `targets` | [id] | idea ids (one for `idea`, ≥ 1 for `shortlist`, any for `question`) |
| `question` | str | the question, for `question` scope |
| `vehicle` | str | `inline` \| `worker` \| `workflow` \| `sublead` (§12.5) |
| `run` | str | the crew task id, workflow run id or agent id doing it |
| `state` | str | `queued` \| `running` \| `done` \| `failed` |
| `report` | str | absolute path of the report once done |
| `note` | str | ≤ 2000, latest progress or failure line |

**Board score** (derived on the page, never stored): over rubrics not killed, of group `weighted` or `lens`, with
`weight` > 0: `value` = Σ(weight × score) / Σ(weight) over those the idea has a score for; `n` = how many it has,
`m` = how many there are. Sort: fully scored (n = m) first, then partly, then unscored; within a group by `value` +
0.25 × `boost` desc; then creation order. An idea with any gate `pass: false` shows "fails gate <label>". A rubric
the idea has no score for shows "not scored yet".

### 12.2 User events (page and terminal)

| type | fields | effect | invalid when |
|---|---|---|---|
| `boost` | `node`, `value` (int 0–3) | `boost` = value | node not an open idea; value out of range |
| `kill` | `node`, `text` (the reason) | status → killed, `kill_reason` = text, `boost` → 0; if it was settled (promoted) it is no longer | node not an idea, or killed already; no text |
| `restore` | `node` | killed → open, `kill_reason` → "" | node not a killed idea |
| `merge` | `node`, `other` | creates a draft idea: next `I` id, `label` = "<node label> + <other label>" (cut to 120 chars), `tier` "Draft", `merged_from` [node, other], everything else default; sets `merged_into` = the draft on both parents (they stay in play); adds a request `{type: "merge", node: <draft id>}` | node = other; either not an idea or killed |
| `twist` | `node`, optional `text` | adds a request `{type: "twist", node, text}`: no text = "write twists for this idea", text = "make a new idea from this twist" | node not an idea |
| `promote` | `node` | idea → settled; any other settled idea → open; if stage is `ideate` or `research`, stage → `frame`; adds a request `{type: "promote", node}` | node not an idea, or killed |
| `weight` | `node`, `value` (int 0–50) | rubric `weight` = value | node not a rubric, or a gate; value out of range |
| `weights_reset` | | every non-gate rubric: `weight` = `default_weight` | no rubric exists |
| `research` | optional `node` (an idea or question), optional `text` | adds a request `{type: "research", node, text}`; no node = the whole shortlist | node given but not an idea or question |

Unpromote is `reopen` on the settled idea (→ open; stage untouched). `requests[].type` gains `merge`, `twist`,
`promote`, `research`; `plan news` lists these page events like the others, and the session `resolve`s them.

Recent summaries: `boosted I3 (2)`, `killed I4: <reason>`, `restored I4`, `merged I1 + I3 into I9`, `twist on I3`,
`promoted I3`, `weight K2 = 30`, `weights reset`, `research requested: <I id | question | shortlist>`.

### 12.3 Session events

| type | fields | effect | invalid when |
|---|---|---|---|
| `score` | `node` (idea), `rubric` (K id), either `value` (number 1–5, ≤ 1 decimal; weighted/lens rubric) or `pass` (true/false/null; gate rubric), optional `label`, `rationale`, `sources` ([str]), `basis` (`research`\|`session`, default `session`) | sets `scores[rubric]` or `gates[rubric]` (replacing the entry), with `rev` | node not an idea; rubric missing or killed; `value` on a gate or `pass` on a non-gate; value out of range |
| `research_status` | `node` (RS id), `state`, optional `note`, `report`, `run` | sets those fields | node not a research node; unknown state |

Summaries: `scored I3 on K2: 4 (research)`, `I3 passes K6` / `I3 fails K6`, `RS1 running`, `RS1 done: <report>`.
Research jobs write with `--by session --source build`. `plan news` also returns `research_status` events whose
state is `done` or `failed`, whoever sent them, so the /shape session sees results at its next turn.

### 12.4 Promote seeds Frame

On a `promote` request the session: writes a `decision` node (`chose` = the idea, `alternatives` = the other
shortlisted ideas, `why` = the scores and the user's kill reasons; it renders in PRD §17), drafts `tldr` from the
idea's `who`/`pitch`, and pre-answers the Frame seeds the idea already answers (smart-skip, quoting the idea).

### 12.5 Research handoff (never blocks the /shape session)

Starting research returns at once; the /shape session keeps asking. It upserts a `research` node (`state:
queued`), picks the vehicle by size and records why in `note`:

| Size of the ask | Vehicle |
|---|---|
| one factual question | `inline` lookup, or one background `worker` |
| one or two focused topics (one idea, one question) | a background `workflow` run of `idea-research` with `topics` or `depth: "quick"` |
| a full shortlist | a `sublead`: `crew spawn` a research sub-lead reporting to the /shape session; it owns the `idea-research` run, its restarts and pruning, and writes the events |

Whoever runs it sends `research_status running` (with `run`), then per idea and rubric one `score` event with
`basis: research` and `sources`, then `research_status done` with `report` (or `failed` with a `note`).

**`idea-research` interface** (`skills/idea-research/`, saved workflow `~/.claude/workflows/idea-research.js`):

```jsonc
// args
{ "dir": "/abs/output/dir",          // required
  "today": "2026-10-17",             // required, YYYY-MM-DD: the freshness date
  "context": "…",                    // required: the context in a paragraph, plus doc paths to read
  "ideas": [{"id": "I1", "name": "…", "pitch": "…"}],          // required, 1–8, unique ids
  "criteria": [{"id": "K1", "name": "…", "description": "…", "weight": 20}],   // required, ≥ 1
  "gates": [{"id": "K6", "name": "…", "description": "…"}],    // default []
  "gate_docs": ["/abs/teammate-go-no-go.md"],                  // default []; each becomes a gates topic
  "evaluators": ["…persona…"],       // default: derived from context + criteria by one agent
  "depth": "full",                   // "full" | "quick"
  "topics": [{"key": "…", "title": "…", "prompt": "…"}],       // optional: replaces the generated topics
  "dry_run": false }                 // true: return the plan and agent counts, run no agent
```

Invalid args throw before any agent runs, naming the field. Outputs in `dir`: `<key>.md` and
`<key>.factcheck.md` per topic, `REPORT.md`, and `scores.json`:

```jsonc
{ "today": "2026-10-17", "report": "/abs/dir/REPORT.md",
  "ideas": { "I1": { "verdict": "…one line…",
                     "scores": {"K1": {"value": 3.5, "label": "Strong", "rationale": "…", "sources": ["https://…"]}},
                     "gates":  {"K6": {"pass": true, "note": "…", "sources": ["…"]}} } } }
```

`value` = the mean of the evaluators' 1–5 scores, one decimal. The return value is `{report, scores_file, agents,
topics, gaps}`; a dry run returns `{dry_run: true, topics: [{key, title}], agents: {research, factcheck, critic,
gap_max, designer, evaluators, synthesis, scores_writer, total_max}, models: {sonnet, opus}}`.

## 13. Comments, proposals and the plan thread

A teammate's comments on the PRD are plan state. Nothing in `nodes` or `PRD.md` changes until the **user** accepts
the session's proposal for a comment; the accept event itself applies the proposal, so no terminal and no idle
session are needed to accept. `comments`, `thread` and `comment_seq` are optional top-level keys (absent = empty, so
older plans stay valid); `PRD.md` never renders them; the published mirror omits them (§1).

### 13.1 Plan shape

- `comments`: list, at most 100, newest last. Each is closed: `{"id": "CM3", "author": str ≤ 80 single line ("" =
  unknown), "text": str ≤ 5000, "anchor": null | node id (must exist) | "§N" (a PRD section, N 0–18), "at": iso,
  "state": "open"|"proposed"|"accepted"|"declined"|"answered", "source": "paste", "proposal": null | {"action":
  "accept"|"answer"|"decline", "text": str ≤ 2000, "rev": int, "changes": [change, …], "at": iso}}`. `open` has no
  proposal; every other state has one (accepted/answered/declined keep it for display); `accepted`/`answered`/`declined`
  match `proposal.action`. Optional key `gist` (absent on older plans and on comments the session never read, so they
  load unchanged): str ≤ 300, single line, no control characters, never empty: the session's one plain sentence of what
  the comment says. Set only by `comment_triage` and `comment_split` parts (a later triage replaces it, a rework keeps it); the page shows it above the verbatim `text`, marked as the
  session's reading. It is a reading, never an instruction or a source of truth.
- `comment_seq`: int, the counter for comment ids: `CM<comment_seq + 1>` is the next id, so an id is never reused.
  Absent = the highest existing number.
- `thread`: the plan-level conversation (the PRD pane), at most 40 entries (the last 40 kept), oldest first:
  `{"role": "user"|"session", "text": str ≤ 2000, "at": iso, "ref": "<event id of the ask>", "links": [id, …]}`.
  `links` (≤ 10 node or comment ids) is `[]` for user entries; it is checked against the plan only when `reply`
  writes it. Node threads (§3) keep their 4-key entries.
- Requests (§4.3) gain type `comment`.

### 13.2 User events

| type | fields | effect | invalid when |
|---|---|---|---|
| `comment` | `text` (≤ 5000), optional `author`, optional `anchor` | adds `CM<n>` in state `open` and a `comment` request; stored event also carries `comment` = the id. Summary `comment CM3 added` (never a name or text) | 100 comments exist ("delete closed comments"); author over 80 chars or multi-line; anchor not null, an existing node id or `§0`…`§18` |
| `comment_accept` | `ref` (comment id), `proposal` (int, = the comment's `proposal.rev`: the plan rev when the proposal was made, unique per proposal, where `proposal.at` has only second resolution) | `--by user --source page` only. Applies `proposal.changes` in order, with `by` user and this event's rev/at, atomically with the event; state → `accepted` / `answered` / `declined` by `proposal.action`; the stored event carries `changes` = the applied changes with their assigned node ids. Summary `accepted CM3` / `answered CM3` / `declined CM3` | comment not `proposed`; `proposal` is not an int or differs from `proposal.rev` ("The proposal changed; reload the page"); a node the changes target has `rev` > `proposal.rev` ("node changed since the proposal"); any change no longer applies or leaves the plan invalid (error `Proposal no longer applies: <reason>`) |
| `comment_rework` | `ref`, optional `text` (feedback) | by `user` only. `proposed` → `open`, proposal cleared, a new `comment` request (text = the feedback, else the comment text). Summary `reworked CM3` | comment not `proposed` |
| `comment_delete` | `ref` | by `user` only. Removes the comment (any state) and its `comment` request; a GitHub-sourced comment's `ext`, and the `ext` of our reply on it (`posted.ext`), are appended to `ext_dropped` (§14.1), so it is never imported again and a later edit on GitHub is ignored. Summary `deleted CM3` | unknown comment |
| `ask` | `text`, no `node` | plan-level message, §4.1 | |

### 13.3 Session events (`--by session` only)

| type | fields | effect | invalid when |
|---|---|---|---|
| `comment_split` | `ref`, `parts` (2–10 of `{text, author?, anchor?, gist?}`) | the `open` comment and its request are removed; each part becomes a new `open` comment with its own request (`author` and `anchor` default to the raw comment's). Parts are always local `paste` comments: if the raw comment was imported from GitHub, its `ext` is appended to `ext_dropped` (§14.1) so the next `pull` does not import it again, and the owner replies on GitHub by hand. Summary `split CM3 into 3` | comment not `open`; fewer than 2 or more than 10 parts; the 100 cap would be exceeded |
| `comment_triage` | `ref`, `action` (`accept`\|`answer`\|`decline`), `text`, `changes`, optional `anchor`, optional `gist` (§13.1) | `open` → `proposed` with `proposal` = `{action, text, rev, changes, at}` (`rev` = the triage event's rev); `anchor` (if sent, null clears) replaces the comment's; its `comment` request is removed. Summary `proposal on CM3: accept` | comment not `open`; `accept` without 1–5 `changes`; `answer`/`decline` with `changes` or without `text`; a change outside the allow-list below or one that fails when dry-run on a copy of the plan |
| `reply` | `ref`, `text`, optional `links` | §4.2. On a node-less ask: appends a `session` entry to the plan `thread` with `links`, removes the request. Summary `replied on plan` | `links` over 10, not a list of existing node/comment ids, or sent with a reply to a node thread |

`resolve` refuses a `comment` request.

### 13.4 Allowed changes (injection guard)

A proposal's `changes` are event objects limited to:

- `upsert` `{"type":"upsert","node":{…}}` of kind `requirement`, `risk`, `assumption`, `edge`, `nongoal`, `constraint`,
  `question`, `note`, `goal` or `story`. Patch keys: `id`, `kind`, `label`, `body`, plus per kind `requirement.nfr`,
  `risk.approach`, `edge.expect`, `assumption.validate_by` / `impact`, `constraint.tag`, `nongoal.why`, `note.lane`,
  `question.lane` / `why` / `options` / `recommended`. An upsert with an `id` must name an existing node of an allowed
  kind (a removed node is never resurrected); without an `id` it needs an allowed `kind`.
- `reopen` `{"type":"reopen","node":id}` and `edit_label` `{"type":"edit_label","node":id,"label":str}` on an existing
  node of an allowed kind.
- `set` `{"type":"set","field":"title"|"tldr","value":str}` (one line: stored inside the comment).

Never: nodes of kind `task`, `research`, `rubric`, `idea`, `criterion`, `decision` or any other; the fields `status`,
`depends_on`, `refs`, `fills`, `check`, `files`, `crew`, `scores`, `answer`, `thread`; any other event type. Changes are
normalised like normal events (strings stripped, control characters refused) and every string is capped at 4000
chars. The page must show every changed field of every change before Accept.

### 13.5 Summaries

`comment CM3 added`, `proposal on CM3: accept`, `accepted CM3`, `reworked CM3`, `deleted CM3`, `split CM3 into 3`,
`asked about plan`, `replied on plan`. Never a name or comment text: summaries reach nudges and `recent`.

### 13.6 `plan news` and `plan show`

`plan news` prints one line per new `comment` event (id, author, anchor, the full text). `plan show` prints, after its
usual output, every open `comment` request and every plan-level `ask` request, so the session can split, triage or reply
without opening `plan.json`. A consumed `plan news` does not re-list old comments: `plan show` is the list of what is
still open. `plan news --json` is unchanged: it lists the events (a `comment` event carries `text`, `author`, `anchor`
and `comment` = the id).

## 14. GitHub PR review (comments imported from, and replies posted to, a draft PRD PR)

The user's click on the page is the authorization for every outward action: a `review` event (user only) records what
the user asked for as a `review` request, and the review CLI acts only on a matching open request (card C6; the core
here has no `gh`/`git` code). A teammate's GitHub comment is data: it enters as an `open` comment (§13) and the
session only proposes. Nothing in `nodes` or `PRD.md` changes on any event of this section. All of it is local state:
the mirror omits `review_pr` and the `review` requests (§1).

### 14.1 Plan shape

- `review_pr`: optional top-level key, absent = `null`. `null` or the closed record `{"repo": "owner/name", "number":
  int > 0, "url": "https://github.com/<repo>/pull/<number>", "branch": str, "head_sha": 40 lowercase hex, "prd_rev": int 0…rev, "opened_at": iso,
  "pulled_at": null | iso}`. Only `review_set` writes it.
- A comment (§13.1) gains seven fields, all **optional per record** (a record without them, such as every comment
  written by `comment`/`comment_split` or by an older plan, means the default in brackets, and still validates):
  `source` `"paste"` (`"github"`), `ext` null | `"rc:<id>"` (review comment) | `"rv:<id>"` (review body) |
  `"ic:<id>"` (issue comment) (`null`), `url` `""` or an `https://github.com/` link (`""`), `reply_to` null | an `ext` (the thread
  root, for an in-thread reply) (`null`), `resolved` bool (`false`), `edited` bool (`false`), `posted` null | `{"at":
  iso, "url": https, "ext": ext}` (`null`). Rules: `source` `github` iff `ext` is set; `ext` is unique among comments;
  `comment_import` writes all seven for a comment it creates; `comment_posted` adds only `posted`. Readers use the
  defaults for an absent field.
- `ext_dropped`: optional top-level key, absent = `[]`. A list of at most 1000 distinct `ext` strings (each valid as above): the
  GitHub comments the owner deleted or split away. `comment_delete` of a GitHub-sourced comment and `comment_split` of one
  append its `ext` (the oldest entry is dropped past 1000); `comment_import` skips every item whose `ext` is listed.
- Requests (§4.3) gain type `review`.

### 14.2 Session events (`--by session` only)

| type | fields | effect | invalid when |
|---|---|---|---|
| `review_set` | `value` (`null` or the closed record above; `null` removes the key) | sets `review_pr`; `null` also drops every open `review` request, so the owner's next click is a new one for the PR they adopt. Summary `review PR set` / `review PR cleared` | `value` missing or not null/an object; unknown or missing record key; `repo` not `owner/name` (a `.` or `..` name is refused); `number` not an int > 0; `url` other than exactly `https://github.com/<repo>/pull/<number>`; `branch` other than `prd/<slug>` (the only branch `plan review` writes to); `head_sha` not 40 hex; `prd_rev` not an int ≤ the plan rev; bad timestamp; **while `review_pr` is set**, any change to `repo`, `number`, `url`, `branch` or `opened_at` (only `head_sha`, `prd_rev` and `pulled_at` may change: clear it with `value` null first to point at another PR) |
| `comment_import` | `items` (1–50 of `{ext, author, text, anchor?, reply_to?, url?, resolved?, path?, line?}`) | idempotent by `ext`, per item, in order (below). Summary `imported N comments (M new)`: no name, no text. `N` = items not skipped, `M` = comments created. The stored event carries `items` normalised (`path`/`line` are accepted for the caller's convenience, never stored on the comment) | `items` not a list of 1–50 objects; an item with an unknown key, a missing/malformed `ext` or `reply_to`, a non-string `author`/`text`, a non-bool `resolved`; creating comments would exceed the cap of 100 ("delete closed comments"): the whole event is refused, nothing is written |
| `comment_posted` | `ref` (comment id), `url` (`https://github.com/…`), `ext` (`rc:`/`ic:` id) | sets that comment's `posted` = `{at, url, ext}` (`at` = the event's). Summary `posted reply on CM3` | unknown comment; already posted; `url` not a `https://github.com/` link; bad `ext` |

`comment_import`, per item:

1. `text` has CRLF/CR turned into `\n` and control/format characters other than `\n`/`\t` removed, is stripped, and is cut
   to 5000 characters with a trailing ` [truncated]` marker (the total stays ≤ 5000); `author` is collapsed to one
   line and cut to 80; an `anchor` that is not null, an existing node id or `§0`…`§18` becomes `null` (it does not
   refuse the import); a `url` that is not an `https://github.com/` link becomes `""` (the page labels it GitHub). An item whose text is empty after this is skipped.
2. An item whose `ext` equals the `posted.ext` of any comment, or is in `ext_dropped`, is skipped (our own reply coming back; a comment the owner deleted or split). A skipped item is not imported, not counted as new and not counted toward the cap.
3. New `ext`: a new `open` comment, `source` `github`, with its `comment` request (counts toward the cap).
4. Same `ext`, text unchanged: only a changed `resolved` flag is updated.
5. Same `ext`, text changed: `text` updated and `edited` true (a pending `comment` request carries the new text). A
   `proposed` comment returns to `open` with its proposal cleared and a new `comment` request; `accepted`, `answered`
   and `declined` keep their state. `resolved` is updated as in 4.

### 14.3 User event `review` (`--by user --source page` only)

| fields | effect | invalid when |
|---|---|---|
| `action` `open`\|`push`\|`pull`\|`post`; `refs` (post only, 1–20 comment ids, no duplicates); `proposals` (post only, an object with exactly the keys of `refs`, each the `proposal.rev` the page showed for that comment) | appends a `review` request `{ref: event id, type: "review", node: null, lane: null, text: "<action>" or "post CM1,CM2", at}`. Summary `review requested: <text>`. For `open`/`push`/`pull`, a second **pending** request with the identical `text` is not added: the event is recorded with the same summary and nothing else changes. For `post`, the new click **replaces** every pending `post` request that names any of the same comments (the old request is removed whole, the new one carries the new `refs` and the new click's event id), so a `post` refused for a reason a re-click cures (the proposal changed after the click) can be clicked again; comments that were only in the replaced request must be clicked again | `open` when `review_pr` is set or `repo` is null; `push`/`pull`/`post` when `review_pr` is null; `refs` or `proposals` given for a non-`post` action; `post` without 1–20 `refs`, or with `proposals` missing, not an object, or not keyed by exactly `refs`; a ref that is not a comment with `source` `github`, a stored `proposal.text` (action `answer`/`decline`) or state `accepted`, and `posted` null; a ref whose current proposal's `rev` is not the integer in `proposals` ("The proposal changed; reload the page": a click binds the reply the owner saw, so a newer proposal is never posted by an older click) |

`resolve` closes a `review` request (the review CLI does, after the outward call succeeded); it still refuses a
`comment` request (§13.3).

**Source gate.** `review` and `comment_accept` are refused unless the event is `--by user --source page`, and
`plan review` re-checks it: the request's `ref` is its originating event's id, and the command refuses (exit 2) unless
that event in `events.jsonl` is a `review` event `by user, source page`. This is a speed bump, not a wall: a session
runs as the same OS user and can type `--source page` itself. The real guard is a permission deny rule on the user's
side for `plan event * --source page*`, which the owner may add to their Claude settings.

**Where a post goes cannot be changed by a session.** `review_set` is a session event, so once `review_pr` is set it may
change only `head_sha`, `prd_rev` and `pulled_at`; `repo`, `number`, `url`, `branch` and `opened_at` are fixed until a
`review_set` null clears the record, and `url` must be exactly `https://github.com/<repo>/pull/<number>`. `plan review
push|pull|post` additionally refuse (exit 2, nothing run) unless `review_pr.repo` equals the `owner/name` of the plan
repo's `origin` (case-insensitive). Residual: `head_sha` and `prd_rev` are still writable by a session `review_set`
(the CLI and a shell are the same OS user; the only gate that could separate them is the same speed bump as above), so a
session can fake "pushed" for a post that says `Applied in <sha7>`. A session with a shell can still run `plan review
push` itself, but only after a page click opened a `push` request, and it cannot change where a post goes.

### 14.4 `plan review open|push|pull|post <task> [--json]`

`scripts/review.py`, called from `plan.py`. Python 3 standard library plus the `gh` and `git` found on `PATH`. The only
code that talks to GitHub; plan state changes only through events (`review_set`, `comment_import`, `comment_posted`,
`resolve`), never by editing `plan.json`. Every command takes `.review.lock` first, so at most one `plan review` runs per plan
and the others wait, then re-read the plan.

**The gate (all four).** For `push`, `pull` and `post` the recorded `review_pr.repo` must also be the `owner/name` of the plan repo's `origin` (exit 2, one line naming both, otherwise). The command runs only when `plan.requests` holds an **open** `review` request for the same
action (`open`, `push`, `pull`, or `post …`: the request the page click created, §14.3). Otherwise: exit 2, one line on
stderr, no `gh`/`git` process started, nothing changed. After the outward calls succeeded the state events are sent and
the request is resolved. Any `gh`/`git` failure (non-zero exit, timeout, missing binary): exit 5, one line on stderr,
state and request untouched, so the user can click again. Every subprocess is a list (never a shell string), has a 60 s
timeout, runs with `GIT_TERMINAL_PROMPT=0` and `GH_PROMPT_DISABLED=1` and every other `GIT_*` variable removed (`GH_TOKEN` is kept and never printed), and has stdin closed. A `://user:pass@` in echoed stderr is shown as `://***@`. A teammate's text is data:
it is never executed, never part of a command line except as the `body=` value of a reply, and never written anywhere
but plan events. stdout is one summary line (or, with `--json`, one JSON object); neither carries a token or comment
text.

| Command | Needs | Does | Summary line / `--json` |
|---|---|---|---|
| `open` | request `open`; `review_pr` null; `repo` is a git repo with an `origin` | publish `PRD.md` + the mirror's `plan.json` as `docs/prd/<slug>/` on branch `prd/<slug>` (below), `git push origin prd/<slug>`, `gh repo view <owner/name> --json nameWithOwner`, `gh pr create --repo <owner/name> --draft --head prd/<slug> --title "PRD: <title>"` (`owner/name` comes from `origin`'s configured `github.com` URL, never from what `gh` guesses; any other origin is refused), then `review_set` `{repo, number, url, branch, head_sha, prd_rev: rev, opened_at, pulled_at: null}` | `opened PR #N <url>` / `{"action","number","url","branch","head_sha","prd_rev"}` |
| `push` | request `push`; `review_pr` | publish onto the existing branch and push; `review_set` with the new `head_sha` and `prd_rev` | `pushed <sha7> (rev N)` or `nothing new` / `{"action","changed","head_sha","prd_rev"}` |
| `pull` | request `pull`; `review_pr` | read review comments, review bodies and issue comments with `gh api --paginate`; if the new comments (not counting those in `ext_dropped`) would pass the cap of 100, import nothing and exit 5 naming the cap; else one `comment_import` per 50 items, `review_set` with `pulled_at` | `pulled N comments (M new)` / `{"action","imported","new"}` |
| `post` | request `post CM1,…`; `review_pr` | post the replies the request names (below), `comment_posted` after each | `posted N replies` / `{"action","posted":[{"ref","url","ext"}],"remaining":[refs]}` |

**Publishing (`open`, `push`).** In a temporary `git worktree` of `repo` (detached, in a temp dir, removed in a `finally`; the base branch is fetched into a private ref `refs/prd-review/<slug>/base`, never read through the shared `FETCH_HEAD`, and the ref is deleted again):
the user's checkout, index, branch, working tree and local branches are never touched. The base is the tip of
`origin/prd/<slug>` when that branch exists on the remote, else the tip of origin's default branch (`git ls-remote
--symref origin HEAD`). `docs/prd/<slug>/PRD.md` and `plan.json` come from `review_plan` (`public_plan` minus `repo`, `published`, `owner`,
`requests`, node `thread`s, and the value in a `set repo|published|owner` trail entry; `PRD.md` shows the owner as `withheld`):
the PR is read by every teammate. The repo mirror (§13) keeps the fuller `public_plan`. Before writing, the command
refuses (exit 5) a `docs`, `docs/prd`, `docs/prd/<slug>`, `PRD.md` or `plan.json` that is a symlink on the branch. A commit `PRD: <title> (rev <n>)` is made
unless `docs/prd/<slug>/` holds exactly `PRD.md` and `plan.json`, the branch's `plan.json` differs from the new one in nothing but `rev`, `updated`,
`recent` and `requests`, and the branch's `PRD.md` is byte-for-byte what that `plan.json` renders to; otherwise there is nothing new
(no commit, no push). A branch someone with push rights altered (an edited `PRD.md`, an extra file in the directory) is therefore rewritten:
the commit writes both files and removes everything else in the directory. The push is `git push origin HEAD:refs/heads/prd/<slug>` without
`-u` and never forced (no local branch is created, so there is nothing to set upstream on). `open` is safe to retry
after a failed `gh pr create`: the branch exists on the remote with the same content and is reused.

**`pull` mapping.** `rc:<id>` review comment, `rv:<id>` review body (empty and `PENDING` ones skipped), `ic:<id>` issue
comment; `author` = `user.login`, `text` = `body`, `url` = `html_url`, `reply_to` = `rc:<in_reply_to_id>` for a threaded
review comment, `resolved` false (the REST API has none). Anchor, first match wins: (1) the text starts `[ID]` or
`[ID] type:`: an existing node id is the anchor, `[PRD]` is the whole PRD (`null`); (2) a review comment on
`docs/prd/<slug>/PRD.md` with a `line`: read that file at the recorded `head_sha` (`gh api repos/<repo>/contents/<path>?ref=<sha>`,
raw) and walk up from the line: the first line that defines an existing node (`- **ID**`, `- ~~ID`, `| **ID**`) gives that
node; a heading `## N.` or `### N` (N 0…18) first gives `§N`; (3) otherwise `null`. An outdated or unreadable line gives
`null`, never an error. Replies we posted come back as comments whose id is a `posted.ext`; the core skips them (§14.2).

**`post`.** Posts exactly the comment ids the open request names and that are not yet `posted` (a retry after a partial
failure posts only the rest; the request text is not rewritten). Text per ref is built by the command, never passed in: `proposal.text` for a stored `answer` or
`decline`; for an `accepted` comment `Applied in <sha7> (PRD rev N).` (`review_pr.head_sha`, `review_pr.prd_rev`), a newline, then
the stored `proposal.text` if any. Before any outward call it refuses (exit 2, one line, nothing posted) a ref whose
`proposal.rev` is newer than the click that requested the post ("proposal changed after your click"; the line says the owner must click Post again, and nothing is resolved), and an accepted
ref accepted at a rev newer than `review_pr.prd_rev` (not pushed yet). There is no `--text` flag. Destination: `reply_to` `rc:<id>`, or the
comment's own `rc:<id>` when it is a thread root, → `gh api --method POST repos/<repo>/pulls/<n>/comments/<id>/replies -f body=TEXT`
(`posted.ext` = `rc:<new id>`); any other comment → `repos/<repo>/issues/<n>/comments` (`ic:<new id>`). `comment_posted`
is sent right after each success; the first failure stops the run: exit 5, the line names the failed ref and those left,
the request stays open.
