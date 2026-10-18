---
name: lens
description: |
  Interactive code and architecture explainer. Turns a file, function, feature, flow, diff,
  or whole repo into a single-page explorer: a clickable architecture map, a step-through
  trace of real data moving through real code (with what's in memory at each step),
  Plain/Deep detail toggle, predict-before-reveal checkpoints, "break it" experiments with
  blast-radius highlighting, design decisions with alternatives, weak spots, and a quiz.
  Use when the user asks to "explain how X works", "walk me through this code", "teach me
  this codebase", "what happens when...", "explain this diff/feature", "how is this
  architected", "I don't get this module", or wants to understand code at a granular level
  in a non-boring, visual, interactive way. Also does architecture deep dives ("architecture
  deep dive", "how is this system designed", boundaries, trade-offs, failure modes, scaling)
  and can draw any lesson in a sketch / whiteboard / doodle style. Consolidates teach,
  mentor-replay, understand-explain and wait-what into one lesson format.
argument-hint: "[path | function | 'how X works' | 'what happens when Y' | diff | commit range | (empty = repo overview)] [arch] [sketch]"
---

# /lens — see code move

The output is **one interactive HTML lesson**, not a wall of text. The reader should be able to *click through* the system, watch a real input travel through real code, guess before they are told, and break things safely.

Template and tooling live next to this file:

- `assets/themes/*.html` — the renderers (themes). `zine` is the default; `sketch` is the white-paper ink look (black line art, red/orange/blue handwriting, Blot the black-blob mascot acting out ideas in scenes). Both render both modes; `parts/scenes.js` (scenes) and `parts/props.js` (icons) are the shared sketch libraries. Never hand-edit per lesson.
- `scripts/build.py` — validates the lesson JSON, checks snippets against real files, injects into a theme (`--theme NAME`, default `$LENS_THEME` or `zine`), opens.
- `scripts/serve.py` — serves only the named lesson file on localhost (one port per lesson) so the reader can select text and ask Claude (Haiku or Sonnet) in a side panel. It runs `claude -p` with the reader's login, read-only, in the repo. Opened as a plain file, the page copies questions instead.
- `scripts/smoke.mjs` — headless-browser check for any theme (details in Step 5). Needs Playwright (see `README.md`); prints `skip` without it.
- `scripts/test-template.mjs` — regression suites for the themes (`scripts/theme-tests/<theme>.mjs`). Run it after editing any theme. `scripts/test-build.py` tests the build; `scripts/scene-preview.mjs` renders and checks one custom drawing; `scripts/scenes-gallery.mjs` and `scripts/props-gallery.mjs` check and screenshot the scenes and the prop icons; `scripts/testdata/arch-mini.json` (small) and `arch-dense.json` (a synthetic 9-node lesson, deliberately dense) are the architecture fixtures.
- `reference/lesson-schema.md` — the JSON contract and size budgets. **Read it before writing a lesson.**
- `reference/themes.md` — how themes work, the selector contract, and how to add a theme. `DESIGN.md` holds the zine theme's design rules.
- `examples/jw-ask-flow.json` (+ `.gen.py`, `.html`) — a complete worked code-mode lesson. Skim it for tone, depth and density.
- `examples/lens-architecture.json` (+ `.gen.py`, `.html`) — the worked architecture-mode lesson (lens explaining itself), with scenes. Skim it before writing an architecture deep dive.

Your job is to produce excellent *lesson data*. The template does the rest.

## Principles

1. **Real, not illustrative.** Every snippet is copied verbatim with real line numbers. `build.py --check-src` checks only `code` snippets, not node `files` ranges or file:line citations in prose: derive those numbers in code (the `ln` helper) or re-check them. Every claim carries a confidence: `evidenced` (read it in code/docs/tests), `inferred` (likely), `uncertain` (guess). Never state an inferred reason as fact.
2. **One concrete journey beats ten abstractions.** Anchor every lesson on a trace: a specific input (a command, an HTTP request, a function call with actual arguments) moving through the code. Architecture is learned by following something through it.
3. **Two altitudes, always.** `simple` is Plain mode: short sentences, no unexplained jargon, one idea per sentence (the wait-what standard). `deep` is granular: exact mechanism, types, control flow, edge cases, why it lives here. Write both for every node and step.
4. **Show state.** The "what's in memory now" panel is what makes code click. Fill `state` on most steps with the real variable names and the values this specific input produces. Mark new or changed values with `changed: true`. If you did not observe a value by running the code, derive it from the code and set the step's confidence accordingly.
5. **Make them think.** Put a `predict` gate on 2 to 4 steps where the outcome is non-obvious; the step blurs until they answer. Quiz questions must need understanding, not recall of wording. Options must be similar length and answer positions must vary.
6. **Small working memory.** Stay inside the budgets in the schema reference. One lesson answers one question. If the scope is bigger, make an overview lesson and offer deeper follow-ups.
7. **Add your own insight.** Go beyond describing the code: analogies, "why this way" with real alternatives, what would break, weak spots, and the general principle each part teaches. This is where the lesson stops being boring.

## Workflow

### 1. Resolve the question (≈1 min)

Map `$ARGUMENTS` to one lesson shape:

| Ask | Shape | Trace follows |
|---|---|---|
| empty or "how is this architected" | **Overview** | the main user journey end to end |
| a path or function | **Component** | one call into it, through its internals, and back out |
| "what happens when Y" / "how does X work" | **Flow** | Y from trigger to final effect |
| diff, commit range, "today's work", "this feature" | **Change** | the new behaviour's path, with before/after where useful |

Then pick the two independent switches; any mix works.

| Switch | Choose | When |
|---|---|---|
| **Mode** (what it teaches) | `code` (default) | the ask is how one function, flow or feature executes: a trace through real code |
| | `architecture` | design, components and boundaries, data flow across services, trade-offs, scaling, failure modes, "architecture deep dive", an `arch` flag, or a whole-system overview about structure rather than one execution path |
| **Theme** (how it looks) | `zine` (default, or `$LENS_THEME`) | otherwise |
| | `sketch` | they say sketch, whiteboard, doodle, "white paper" or Blot, or pass a `sketch` flag |

Set `"mode": "architecture"` in the lesson JSON for architecture mode; the theme is only a build flag. If both modes are plausible, state your assumption in the subtitle.

Resolve change scopes the way mentor-replay does: `git status --short`, `git diff --stat`, `git log --oneline -20`, or the given range. If the scope is ambiguous in a way that changes the lesson materially, ask one short question with options; otherwise state your assumption in the subtitle.

### 2. Gather evidence (≈3–8 min)

- Read `PROJECT_CONTEXT.md` if present. For the map, use the graphify code graph (`graphify` skill): if `graphify-out/` is missing, build it with `graphify extract . --code-only && graphify cluster-only . --no-label` (zero tokens; never drop `--no-label`), or refresh it with `graphify update .`. Read `graphify-out/GRAPH_REPORT.md`, then `graphify explain <symbol>` and `graphify path A B --undirected` for the calls and dependencies around the target. If an older `.understand-anything/knowledge-graph.json` exists, its summaries and layers can still help with naming the map's groups.
- Read the actual code for everything you will show. Use `nl -ba FILE | sed -n 'A,Bp'` so line numbers are exact.
- For large repos, delegate the broad sweep to a cheap read-only agent (e.g. haiku Explore): "<question>; answer in 300 words or less with file:line"; verify key claims yourself.
- When it is cheap and safe (pure function, test, `--help`, dry-run), **run the code** with the trace's input to capture real state values. Never run anything with side effects you were not asked to cause.
- Check `.lens/` for earlier lessons; reuse their glossary terms.

### 3. Design the lesson before writing JSON (≈2 min)

Decide, briefly and in your head or scratchpad:
- The one question this lesson answers, and the trace input that answers it.
- 4 to 10 map nodes (8 or fewer for architecture) grouped into 2 to 4 layers ordered by flow. Nodes are responsibilities, not necessarily files.
- The steps (5 to 12 per code trace). Consecutive steps on different nodes should share an edge so the route line follows a real arrow.
- Edge direction: caller/producer -> callee/consumer, the way data or control is pushed (sensors and webhooks point at their consumer). Impact follows edges backwards, so avoid reply/back edges and cycles (they make Impact list half the system): put a response in the forward edge's `payload` or `guarantee`; keep a cycle only when it is the point.
- Layout: at most about 8 edges and 8 nodes per map, no back-edges, explicit `col`/`row` so no edge crosses a node, edge labels of 1 to 2 short words (labels collide on dense maps). A bigger system gets an overview lesson plus deeper ones.
- Where the "aha" is, and put a predict gate right before it.
- 2 to 4 break-it experiments: a realistic change (delete a line, swap an order, pass a bad value, remove a dependency) with the true consequence and which nodes it affects.

#### Architecture mode (`"mode": "architecture"`)

The lesson answers "how is this system put together, and where does it hurt?", not "what does this call do?". Read `reference/lesson-schema.md` (Modes) and skim `examples/lens-architecture.json`:

- **Flows, not one code trace.** 1 to 3 traces of real scenarios (a request, a job, a deploy), 4 to 9 steps each. Add code to a step only where the mechanism is the point; `state` is optional.
- **Nodes** carry `owns` (what it alone owns), `exposes` (its interface), `runs` (process, host, trust zone) and `scale` (where it tops out), only the ones you can evidence.
- **Edges** carry `protocol`, `sync` (true = caller blocks, false = async, drawn dashed), `payload` and `guarantee`, only when verified. Omit a field rather than guess it.
- **`invariants`**: rules that must always hold, each with its enforcing `node`, what `breaks` if violated, and `evidence` (where it is enforced: a test name, file:line, a CI step). `rule` is one sentence of at most 120 characters (build warns). **`pressure`**: where it strains, with `limit`, `signal` (how you would notice) and `mitigation`. **`whatifs`** are failure modes: `change` = what fails, `outcome` = blast radius. **`decisions`** add `context` (the forces) and `consequences` (what we now live with).
- **Evidence rules are unchanged**: never invent topology, protocols or numbers. Structure is found in SPEC, PROJECT_CONTEXT and ADRs, entry points, manifests, docker-compose, k8s and terraform files, config and env files, queue and database client setup, the tests that enforce the invariants, CI, and by running `--help`. Report drift between the documented and the actual architecture as a weak spot. An unseen limit is `uncertain`, or drop the point.

#### Scenes (sketch theme)

Nodes, steps, whatifs, decisions, risks, pressure points and invariants may carry `"scene": {"name": ..., "caption": ...}`; sketch draws it as a small picture of Blot, zine ignores it. Write scenes whenever the reader might view in sketch. Pick the scene that shows the ACTION: `carry` (data moving), `gate` (validation, auth), `queue` (buffering, backlog), `fork` (branching, a decision), `wall` (boundary, permission), `fire` (failure, blast radius), `store` (persistence, cache), `lookup` (read, search), `transform` (parse, convert), `wait` (timeout, retry), `handoff` (crossing a process or service boundary), `watch` (observability, an invariant check). Caption: at most 60 characters, lower-case sketchbook voice, one idea ("parked until it's free"). Defaults when absent: whatif `fire`, decision `fork`, risk `watch`, pressure `queue`, invariant `gate`; steps and nodes get none.

**Make the pictures specific to the system (sketch).** The reader should see THIS system, not a metaphor. Slot table and prop names: `reference/lesson-schema.md` (Scene slots, Props).

- Set `prop` on every node: the icon of what the component really is (`camera`, `database`, `chip`, `process`, `terminal`, `stack` for a queue...). Names are in the schema; an unknown one warns.
- In architecture mode leave a node's `scene` empty unless a picture says something its context plate cannot. The theme draws each node from its real neighbours and edge payloads, so give every edge a real `payload`.
- For failure modes, pressure points, invariants, decisions and risks write a scene with `items` (the real values or messages that move, names from the code) and `props` (the real components). The caption states the system-specific fact. Good: `fire`, props `[{"prop": "camera", "label": "camera.py"}]`, items `["frame"]`, caption "camera thread dies, presence goes blind". Pick each scene by the mechanism, not the section (`wait` for timeouts, `handoff` for a process boundary, `store` for persistence), and use no scene more than twice in one section.
- Never invent labels: each one is a node id or label, an edge payload or a name already in the lesson.

#### Draw it yourself (sketch)

Library `name` scenes are for the generic beats (data moving, a check, a wait). Whenever the point is specific to this system (a failure mode, an invariant, a pressure point, a decision, the key steps), write `scene.draw` instead: sketch the actual situation, which object, which component, what goes wrong where. Ops, grid, limits and an example are in `reference/lesson-schema.md` ("Custom drawings"); never raw SVG.

Loop for each drawing: write the scene JSON to a temp file, run `node $LENS/scripts/scene-preview.mjs spec.json out.png`, fix every overlap, outside and unknownOps it reports (and any warning), look at the PNG when it is not ok or the picture matters, then paste it into the lesson. `build.py` rejects malformed ops.

- One idea per picture. Blot DOES the action: hands on the objects (`arms`, `legs` targets), not standing beside them.
- 3 to 8 ops, 12 at most. Connect things with `id` plus `arrow`, not guessed coordinates.
- Vary the composition: different poses, stage pieces and props; never reuse a layout for neighbouring pictures.
- Every label is a real name from the lesson. The caption is the system-specific fact, shown under the picture.

#### Data sections (either mode, either theme)

When part of the request is evidence rather than structure (score tables, a chart, headline numbers, caveats, a source list), put it in `data` sections instead of dropping it or bending it into a flow. Each section is its own entry in the contents rail, so a mixed document reads as one artifact: the map and flows for the mechanism, plus tabs of numbers. Block types, fields and validation are in `reference/lesson-schema.md` ("Data sections"); `scripts/testdata/data-mini.json` has one of each.

- The numbers are yours: `build.py` checks shape, not truth. Copy each value from a source you read, put the source and date or version in the block's `caption` or `foot`, and add a `sources` block.
- Use `bars` for one value per row, `dumbbell` for before and after, `stack` for shares of a whole, `table` when exact values matter, `stats` for 3 to 4 headline numbers, `note` (tone `warn`) for the caveat a reader must not miss.
- `at: "start"` puts a section before the map (a summary); the default puts it after Weak spots. A lesson may have no nodes at all and be only `data` sections.
- A lesson still answers one question. Do not use `data` to bolt an unrelated report onto a lesson.

### 4. Write the lesson JSON and build (≈5–10 min)

Write the lesson as a small Python generator in the scratchpad (see `examples/jw-ask-flow.gen.py`). A helper like `code(file, a, b, highlight, notes)` slices snippets straight from the source file, so they are verbatim by construction and you never retype code; `examples/lens-architecture.gen.py` adds `ln(file, needle)`, which finds a line number by its text so line numbers in prose cannot rot. Then build into the repo:

```bash
python3 ~/.claude/skills/lens/scripts/build.py <scratch>/lesson.json <repo>/.lens/<NNNN>-<slug>.html --check-src <repo> [--theme sketch]
```

- `NNNN` increments from the highest existing lesson in `.lens/`.
- Fix every `ERROR`. Treat `warn` lines seriously (snippet mismatches, missing edges, quiz give-aways).
- Keep `.lens/` out of commits: append `.lens/` to `<repo>/.git/info/exclude` if missing.
- Not in a git repo, the target is outside it, or you were told not to touch the repo (or it is read-only): build into the scratchpad instead of `.lens/`, skip the git exclude, give the path.

### 5. Verify it renders (≈1 min)

```bash
node ~/.claude/skills/lens/scripts/smoke.mjs <repo>/.lens/<file>.html
```

It works for either theme but walks only the FIRST trace (its steps and gates), clicks every node, checks phone width and saves a viewport screenshot next to the lesson. It does not exercise edges, Interfaces rows, Impact or later traces: click through those yourself (or run the theme tests when you touch a theme). Look at the screenshot. Fix anything broken or cramped before replying. On `skip`, use the Playwright MCP tools or at least a clean build. When you touch the skill's own internals, also run `python3 scripts/test-build.py` and `node scripts/test-template.mjs` (add a theme name to run one).

Then open it through the ask helper, as a background command (it serves only this lesson, on its own port, until stopped; opening the same lesson again reuses it):

```bash
python3 ~/.claude/skills/lens/scripts/serve.py <repo>/.lens/<file>.html --open
```

If you cannot run a background command, open the file directly (`build.py ... --open`); asking then only copies the question.

### 6. Reply in the terminal (short)

- The path, and the URL it opened at (`http://127.0.0.1:4174/...` when served). Say which mode and theme it used, and that the same JSON rebuilds in the other with `build.py lesson.json out.html --theme sketch` (or `zine`).
- Three to five sentences: the answer to their question in plain words, the single most surprising thing, and the biggest weak spot found.
- One or two natural follow-up lessons they could ask for.
- How to use it (same keys in both themes): scroll the trip, or press J/K (or the arrow keys) to move between stops. Guess before the explanation unlocks (number keys answer). P and D switch Plain and Deep, clicking a map box opens that component, "What depends on it?" shows the impact. Select text and press "Ask Claude" (or A) to ask Haiku or Sonnet about it in a side panel (it can read the repo). On return the page offers to jump back to the last stop.

## Look and feel (the template handles this; keep lesson text consistent with it)

The default zine theme is a hand-made explainer: the trace is a numbered trip of panels, each with its code card, handwritten line notes and an "In memory now" sticky note. Write step titles as short actions ("Parse the flags"); they are the panel titles and contents rail. Line notes appear handwritten next to their line, so keep them to one short sentence. Titles may contain `backticks`. Plain text only everywhere else: no markdown bold, lists or headings inside JSON strings.

To share it, publish the same HTML with the Artifact tool.

## Follow-ups

- "Deeper on X" or "zoom into step N": make a new Component lesson for that node. Link back to the parent in its subtitle.
- "Wait, what?": re-explain that part in the terminal in Plain style first. If it reveals a gap in the lesson, fix the JSON and rebuild the same file.
- Quiz misses: the page keeps missed questions at the top on revisit. When the user returns to a topic days later, suggest they retake the quiz before a new lesson.

## Quality bar (check before building)

- [ ] Every snippet verbatim, at most 25 lines, with notes on the 1 to 3 lines that matter.
- [ ] Every node and step has both `simple` and `deep`, and a confidence.
- [ ] State panel filled on most steps, with real names.
- [ ] At least one analogy on the map, and one "why this way" decision with a real alternative.
- [ ] Predict gates at the non-obvious moments, not on trivia.
- [ ] Weak spots are real findings with a location, or the section is omitted. Never invented to fill space.
- [ ] Quiz answers vary in position; build warns when the longest option is over 1.6x the shortest plus 8 characters, and the longest must not be the answer; `why` teaches.
- [ ] Architecture mode: every edge has a verified protocol or omits it; at least one invariant and one failure mode, each tied to a real node; no invented numbers or topology; every flow is a trace of a real scenario.
