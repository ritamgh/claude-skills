# Questions: how /shape asks

Loaded from SKILL.md §4. The question engine is grilling's frontier rounds plus spec-kit clarify discipline, in
Shape Up / PR-FAQ order. The CLI ranks; you write good questions and set their order fields.

## 1. A good question card

Every question node the user sees has:

| Field | Rule |
|---|---|
| `label` | one decision, ≤ 120 chars, a question. Two decisions → two questions. |
| `why` | one line: what this answer decides downstream ("Decides the data model and two slices"). |
| `options` | 2–4 for the terminal (the CLI allows 6; AskUserQuestion shows 4), keys `a`… in order, each with a short `why`. Distinct, not overlapping. |
| `recommended` | the key you would pick, worded so "yes" accepts it. Its `why` says the reason (the appetite, a fact you found). |
| `class` | `mechanical` (one right answer given the facts: you decide), `taste` (reasonable people differ: you decide, it surfaces at the gate), `user` (only the user can say: always asked). When unsure, `user`. |
| `blocking` | true when the PRD cannot be approved without it. |
| `depends_on` | the questions whose answers change this one. Ask by dependency: a question waits until these settle. |
| `priority` | raise it (0 = default) for the riskiest, most uncertain decision. The frontier sorts priority first. |
| `fills` | draft nodes the answer settles (playbacks, a drafted decision). Never questions or tasks. |
| `stage` | the stage that asks it. |

Bad → good:
- "How should notifications work?" → "Send the digest by email, by ntfy push, or both?" (one decision, options).
- "Should it be fast?" → "Generate the digest in under 10 s for 500 tasks? (Recommended: yes, the current
  `crew ls` takes 0.4 s for 300)".
- "Any constraints?" (seed Q7) → tailored options: "a) bash + stdlib python only (Recommended: matches the repo)",
  "b) a new dependency is fine", "c) must run without network".

## 2. Order

1. Frame backbone (fixed): concrete story → who → appetite (a budget, not an estimate) → no-gos → success with a
   number. Standard adds reuse (look it up first; it is `mechanical`) and hard constraints. Deep adds "is this the
   right problem / cost of doing nothing" (seed Q8) at priority 1.
2. Explore: one shapes question (minimal / ideal / lateral, ≥ 3 options, each option's `why` = effort + what it
   reuses + main risk). The recommendation fits the appetite.
3. Decide: the decisions the chosen shape opens, riskiest first. Set `depends_on` so a question that only makes sense
   after another waits for it.
4. Shape: the pre-mortem question, then the playback question.

Quick: the five seeds, at most one Decide question if the change has a real choice, then the Shape playback and the
approval asked together (gate §3 in prd-gate.md).

## 3. Tailoring seeds

Seeds (`scripts/seeds.json`) arrive generic and some have no options. Before the first ask, upsert each seed you
are about to ask with options drawn from what you read and the user's words, and a `recommended` key. Keep the
seed's `id`, `why` and `class`; you may sharpen the `label` (still one decision). Example for seed Q4 on "add a
--json flag to crew ls":

```json
{"type":"upsert","node":{"id":"Q4","options":[
  {"key":"a","label":"Only crew ls gets --json; text output unchanged","why":"smallest change that serves the need"},
  {"key":"b","label":"Also crew show --json","why":"HQ reads show too"},
  {"key":"c","label":"A --format flag with several formats","why":"more flexible, more to test"}],
  "recommended":"a"}}
```

Smart-skip: when the user's request already answers a seed ("for me, by Friday"), record it as their answer with
`--by user --source terminal` and `text` quoting their words, write the nodes, and tell them which seeds you skipped
and why, so they can reopen one.

## 4. AskUserQuestion mapping

- One call holds up to 4 frontier questions; ask fewer when one answer could change another's options.
- `header`: the question id and a 1–2 word topic ("Q3 appetite"). `question`: the label plus the why on one line.
- Options in this order: the recommended one first with " (Recommended)" appended, then the others. Map the picked
  label back to its key. "Other" text → `answer` with `text` (and `choice` if it clearly picks one).
- Never add a "Decide later" option to a `blocking` question unless the user asks for it; for non-blocking questions
  it maps to `park`.
- After the answers: record them (`--by user --source terminal`), write the nodes they settle, re-run the frontier.
  Say in one line what each answer changed ("Q3 → C-1 appetite 1 day; unblocks Q9").

## 5. Playback questions

A playback question settles your drafts with one user answer, and works the same from the page. **Any** answer to
it (any option, or free text) settles every `fills` node, so it has exactly one option, the yes:

```json
{"type":"upsert","node":{"kind":"question","lane":"slices","stage":"shape","class":"user","blocking":true,
  "label":"Do the risks, slices and boundaries played back hold?",
  "why":"Settles the drafts so they enter the PRD; tell me what to change instead if not",
  "options":[{"key":"a","label":"Yes, they hold","why":"settles R-1, R-2, S1-S3 and B-1 to B-4"}],
  "recommended":"a","fills":["R-1","R-2","S1","S2","S3","B-1","B-2","B-3","B-4"]}}
```

Before asking, print the playback (≤ 10 lines): each draft by id, one line each, marking `(your words)` vs
`(my guess)`. Tasks cannot be in `fills` (they are rendered at any status); list them in the playback anyway.

- **Terminal**: AskUserQuestion needs two options: "Yes, they hold (Recommended)" and "Change something". Yes →
  `answer` with `choice: "recommended"`. "Change something" or Other text → do **not** send an answer: record their
  words as `{"type":"note","node":"<the draft they named>","text":"…"}` (`--by user --source terminal`), edit the
  drafts, `resolve` the note, play back what changed and ask again (the question is still open).
- **Page**: if the user answered the playback on the page with text asking for a change, the drafts are already
  settled: `reopen` the question, upsert each named draft back to `"status":"open"`, edit, ask again.

Standard and Deep usually need two: one at the end of Decide (requirements, edge cases, approach drafts) and one
at Shape (risks, slices, boundaries). Quick needs one, at Shape.

## 6. Pre-mortem (Shape, mandatory for Standard and Deep)

Ask: "It is three months from now and this failed. What is the most likely reason?" with 3–4 options you drew from
the plan (an assumption that may be false, a rabbit hole, an integration that may not behave) and Other. Each real
reason becomes a `risk` node with an `approach` (a pre-decided way round or a time-boxed spike); a reason that is a
belief becomes an `assumption` with `validate_by` and `impact`. These feed `/orchestrate`'s Review Focus.

## 7. Triage and defaults (autoplan's classes)

| class | Who decides | How it is recorded |
|---|---|---|
| mechanical | you, from facts | a question node (`class: mechanical`, usually `blocking: false`) answered `--by session` with the right option; the decision it produces carries `by_default: true` and cites the facts in `why` |
| taste | you, surfaced later | the same, and say in your reply which way you leaned and why |
| user | the user, always | asked; never answered `--by session` |

Anything you decided without the user carries `by_default: true` (the contract's meaning: never examined by the
user), so lint's `default` warning lists it at the gate playback for one look. Logging the question as a node keeps
the choice and its alternatives on the page, where the user can `reopen` it.
