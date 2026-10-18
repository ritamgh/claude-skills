# Lesson JSON schema

Every theme in `assets/themes/` renders the same JSON object (see `themes.md`). Every section except `title` is optional and its tab hides when empty. Text fields accept `backticks` for inline code and `\n\n` for paragraph breaks. Glossary terms inside any text become hover tooltips automatically.

## Modes

`"mode"` picks what the lesson teaches. It is independent of the theme (how it looks): every theme renders both modes.

| Mode | Teaches | Default |
|---|---|---|
| `code` | A feature or flow through real code: traces with verbatim snippets and what is in memory at each step. | yes (absent means `code`) |
| `architecture` | A system's structure: who owns what, the interfaces between parts, the rules that must hold, where it strains, how it fails. Code per step is optional. | |

Architecture mode relabels existing sections instead of restructuring them: `traces` show as "Flows", `whatifs` as "Failure modes" (`change` = what fails, `outcome` = blast radius, damage still painted on the map), `risks` as "Weak spots", `decisions` as "Decisions". `invariants` and `pressure` are new sections whose tabs hide when empty. `build.py` warns when an architecture lesson has no traces, or when more than half of its edges have no `protocol`.

Section order:

- `code`: Map, Trace, Break it, Decisions, Weak spots, Quiz, Terms (unchanged).
- `architecture`: Map, Flows, Interfaces (the edge list; only if some edge has `protocol`, `payload`, `sync` or `guarantee`), Invariants, Pressure points, Failure modes, Decisions, Weak spots, Quiz, Terms.
- `data` sections (either mode) go after Weak spots and before Quiz, or before the Map when `at` is `"start"`.

```jsonc
{
  "id": "jw-ask-flow",                 // stable id; keys the viewer's saved progress
  "title": "How `jw ask` reaches GPT", // short, specific
  "mode": "code",                      // code (default) | architecture
  "subtitle": "From your shell to a worker answer, in 9 steps",
  "legend": "optional custom map legend",

  "layers": [                          // columns on the map, left → right, in flow order
    {"id": "cli", "name": "Your shell"},
    {"id": "core", "name": "Wrapper"},
    {"id": "ext", "name": "Outside world"}
  ],

  "nodes": [{
    "id": "dispatch", "label": "Command router", "kind": "bash case", "layer": "core",
    "col": 1, "row": 0,                // optional overrides of auto layout
    "files": ["bin/jw:40-95"],
    "simple": "Plain-English role in 1-3 sentences.",
    "deep": "Granular version: exact mechanism, types, edge cases, why it lives here.",
    "analogy": "Like the switchboard operator who routes each call.",
    "owns": "The parsed argv and the chosen subcommand.",      // architecture: the one state/responsibility it alone owns
    "exposes": "`jw <cmd> [args]` on the command line.",       // its interface to the rest of the system
    "runs": "Your login shell, one process per call.",         // process, host, team, trust zone
    "scale": "Stateless; tops out at fork cost.",              // how it scales and where it stops
    "scene": {"name": "fork", "caption": "pick a path"},       // sketch theme picture, see "Scenes"
    "prop": "terminal",                // sketch: the component's icon (a prop name or alias, see "Props"); drives its context plate
    "confidence": "evidenced",         // evidenced | inferred | uncertain
    "functions": [{                    // drill-down "Inside" list
      "name": "cmd_ask()", "loc": "bin/jw:60",
      "simple": "...", "deep": "...",
      "code": { /* same shape as step code */ }
    }]
  }],

  "edges": [{
    "from": "dispatch", "to": "runner", "label": "calls",
    "protocol": "in-process call",     // architecture: HTTP/JSON, SQL, unix socket, ...
    "sync": true,                      // true = caller blocks; false = fire-and-forget (drawn dashed); absent = unknown (solid). Must be a real boolean.
    "payload": "argv array",           // what crosses
    "guarantee": "best-effort"         // at-least-once, ordered, ...
  }],
  // Arrow means "caller/producer -> callee/consumer", the way data or control is pushed (a sensor or webhook points at its consumer). "Impact" mode follows edges backwards, so avoid reply/back edges and cycles: put a response in the forward edge's `payload` or `guarantee`. Keep a map to about 8 edges and 8 nodes, with edge labels of 1 to 2 short words.

  "traces": [{
    "title": "jw ask \"where is auth?\"",
    "trigger": "You type `jw ask --cwd ~/app \"where is auth?\"`",
    "steps": [{
      "node": "dispatch",              // must exist; consecutive nodes should share an edge
      "title": "Pick the subcommand",
      "simple": "...", "deep": "...",
      "confidence": "evidenced",
      "code": {
        "file": "bin/jw", "start": 58, "lang": "bash",
        "src": "verbatim lines 58..70 copied from the file",
        "highlight": [61, 62],         // absolute line numbers
        "notes": {"61": "Why this line matters, shown when clicked."}
      },
      "state": [                       // the "what's in memory now" panel
        {"name": "$1", "value": "\"ask\"", "changed": true},
        {"name": "CWD", "value": "\"/home/me/app\""}
      ],
      "predict": {                     // optional gate: content blurs until answered
        "q": "What happens if --cwd is missing?",
        "options": ["It uses the current dir", "It exits with an error"],
        "answer": 0, "why": "Line 64 defaults CWD to $PWD."
      },
      "aside": "Optional one-line analogy or 'fun fact'.",
      "scene": {"name": "carry", "caption": "argv goes in"}    // optional, sketch theme
    }]
  }],

  "whatifs": [{                        // "Break it" experiments
    "title": "Delete the timeout",
    "change": "Remove `--timeout 600` on line 88.",
    "outcome": "What breaks, where, and how you would notice.",
    "lesson": "The general principle this shows.",
    "node": "runner", "affects": ["dispatch", "shell"],   // painted red on the map
    "confidence": "inferred",
    "scene": {"name": "fire", "caption": "no timeout"}     // optional; default fire
  }],

  "decisions": [{
    "title": "Bash, not Python",
    "chosen": "A single bash script.",
    "simple": "Why, briefly.", "deep": "Why, with evidence.",
    "alternatives": [{"name": "Python CLI", "tradeoff": "Gains / costs / why not here."}],
    "context": "The forces: one maintainer, no install step.",   // optional
    "consequences": "What we now live with: no real tests.",    // optional
    "confidence": "inferred",
    "scene": {"name": "fork", "caption": "two roads"}           // optional; default fork
  }],

  "risks": [{
    "title": "Unquoted variable", "where": "bin/jw:120",
    "what": "Failure mode in plain words.", "fix": "Smallest practical fix.",
    "severity": "medium", "confidence": "evidenced",
    "scene": {"name": "watch", "caption": "unquoted"}           // optional; default watch
  }],

  "invariants": [{                     // rules that must always hold
    "rule": "Exactly one worker per session id.",   // one sentence, at most 120 characters (build warns)
    "node": "runner",                  // must exist; the node that enforces it
    "evidence": "test_one_worker_per_session in tests/test_runner.py",  // optional string: where it is enforced or checked (test name, file:line, CI step); shown as "Enforced by:"
    "breaks": "What happens when it is violated.",
    "confidence": "inferred",
    "scene": {"name": "gate", "caption": "one at a time"}       // optional; default gate
  }],

  "pressure": [{                       // where it strains first
    "title": "Session lock contention",
    "node": "runner",                  // must exist
    "limit": "About 50 concurrent asks.",
    "signal": "How you would notice.", "mitigation": "Smallest practical relief.",
    "severity": "medium",              // high | medium | low
    "confidence": "uncertain",
    "scene": {"name": "queue", "caption": "backlog"}            // optional; default queue
  }],

  "quiz": [{
    "q": "Question answerable only if you understood the flow",
    "options": ["Option A same length", "Option B same length", "Option C same length"],
    "answer": 2, "why": "Feedback that teaches, not just 'correct'."
  }],

  "glossary": [{"term": "subshell", "def": "A child copy of the shell ..."}]
}
```

## Scenes

`scene` is an optional `{"name": ..., "caption": ...}` on a node, trace step, whatif, decision, risk, pressure point or invariant. Only the `sketch` theme draws it (other themes ignore it); `build.py` validates it for every theme. `name` must be one of the 12 below (unknown is an error; optional when the scene has a `draw`, see "Custom drawings"); `caption` is at most 60 characters (longer is an error, missing is a warning) and should be about three words.

| Name | Picture |
|---|---|
| `carry` | Blot carries a packet from A to B (data moving) |
| `gate` | Blot at a checkpoint, one thing passes, one is turned away (validation, auth) |
| `queue` | A line of boxes waiting, Blot handling the front one (buffering, backlog) |
| `fork` | A path splits, Blot choosing (branching, routing, a decision) |
| `wall` | Blot blocked by a wall, packet stuck outside (isolation, boundary, permission) |
| `fire` | Something burning, Blot flustered (failure, blast radius) |
| `store` | Blot files a box into a cabinet (persistence, cache, database) |
| `lookup` | Blot with a magnifier over a ledger (read, search, resolve) |
| `transform` | Blot feeds a square into a machine, a circle comes out (parse, convert, serialize) |
| `wait` | Blot sits beside a clock (timeout, retry, async wait) |
| `handoff` | Blot hands a packet to a second Blot (delegation, process or service boundary) |
| `watch` | Blot looks at a dial (observability, health, an invariant check) |

Defaults when `scene` is absent (sketch theme): whatif `fire`, decision `fork`, risk `watch`, pressure `queue`, invariant `gate`. Steps get no picture; a node gets none unless it is an architecture-mode node without a `scene`, which gets a context plate (see `themes.md`).

### Scene slots: make the picture specific

A scene may also name the real things in it, so the picture shows this system and not a metaphor. Both slots are optional; without them the scene is drawn as before.

- `items`: up to 4 strings of at most 18 characters, the labelled THINGS handled (a message, a value, a packet).
- `props`: up to 3 `{"prop": <prop name or alias>, "label": <at most 18 chars>}`, the labelled PLACES or OBJECTS (a component, a store).

| Scene | `items` | `props` |
|---|---|---|
| `carry` | [0] the packet | [0] source, [1] destination |
| `gate` | [0] what passes, [1] what is turned away | [0] the guarded thing |
| `queue` | the waiting boxes | [0] what Blot feeds |
| `fork` | [0], [1] the branch labels | [0] the origin |
| `wall` | [0] the stuck packet | [0] what is behind the wall |
| `fire` | [0] what is lost | [0] what burns |
| `store` | [0] the box | [0] where it is stored (drawn instead of the cabinet) |
| `lookup` | [0] the key searched | [0] what is searched |
| `transform` | [0] input, [1] output | [0] the machine |
| `wait` | [0] what waits | [0] what is awaited |
| `handoff` | [0] the packet | [0] giver, [1] receiver |
| `watch` | [0] the reading | [0] the watched thing |

Every label must be a name already in the lesson (a node id or label, an edge `payload`, a name from the code). `build.py` errors on a non-list, too many entries or a wrong type, and warns on a label over 18 characters or an unknown prop name (the theme then draws a generic box).

```jsonc
{"scene": {"name": "carry", "caption": "a frame goes to fusion",
           "items": ["frame"],
           "props": [{"prop": "camera", "label": "camera.py"}, {"prop": "chip", "label": "fusion.py"}]}}
```

### Custom drawings: `scene.draw`

When the point is specific to this system, draw it instead of picking a library scene. `scene.draw` is a list of 1 to 40 ops that the sketch theme renders with the same pen and the same Blot as the 12 scenes (light and dark, same legibility floor). Zine ignores it. There is no raw SVG: only the ops below, so a lesson can never inject markup. `name` becomes optional when `draw` is present; if you keep one it must still be a valid scene name, and the picture falls back to that scene when the drawing cannot be rendered. `items` and `props` only matter to that fallback scene.

The canvas is a 16 x 9 grid: x 0..16 to the right, y 0..9 down, decimals fine, one unit is 40 px of the 640 x 360 plate. Out-of-range numbers are clamped and shapes are shifted back into the frame. Sizes are in grid units. Colours: `ink` (default), `red`, `orange`, `blue`; anything else is ink. Draw order is array order, later on top. `caption` (at most 60 characters) is the system-specific fact in one line and is shown under the picture; the picture itself is only what your ops draw. Every `label` is at most 18 characters and every `t` at most 40: shorter is drawn whole, longer is cut (build warns). Text never renders below 11px (plate at least 358px wide), so boxes and ovals grow to fit their label.

Optional `id` (at most 20 characters of a-z 0-9 _ -, unique) names an object so an `arrow` can attach to its edge instead of guessing coordinates. Fields marked `?` are optional; defaults in brackets.

| Op | Fields |
|---|---|
| `blot` | `x y` (body centre) `s?` [1, size 0.3..2.2] `mood?` blank, worried, proud, happy `look?` [dx,dy] (+-0.3) `face?` -1 or 1 `tilt?` radians `arms?` two hand targets [[x,y],[x,y]] `legs?` two foot targets. Standing feet are at y + 1.8*s. |
| `prop` | `name` (prop or alias, see Props) `x y` (centre) `size?` [2] `label?` (under the icon) |
| `box` | `x y` (top-left) `w h` `label?` (inside) `c?` `fill?` paper or ink |
| `packet` | `x y` (centre) `label` (box sized to its text) `c?` `tilt?` |
| `oval` | `x y` (centre) `rx ry` `label?` `c?` |
| `stack` | `x y` (bottom middle) `n?` [3, 1..6] `label?` (on the top box) |
| `line` | `pts` 2..8 points [[x,y],...] `c?` `w?` 1..3 [2] `dash?` |
| `arrow` | `from` `to` (each an id or [x,y]) `label?` `c?` `bend?` -1..1 `dash?`. An id end attaches to that object's edge; the label is placed beside the curve. |
| `text` | `x y` (middle of the first line) `t` `c?` `size?` m or l `anchor?` middle [default], start, end `rot?` -20..20 degrees. Wraps to 3 lines. |
| `ticks` | `x y` `n?` [3, 1..7] `c?` `dir?` radians [up] `len?` [0.4]: spark or alarm ticks |
| `ground` | `y` `x1?` `x2?`: a floor line |
| `flame` | `x y` (middle of base) `s?` |
| `wall` | `x y` (top-left) `w?` `h?` |
| `gate` | `x y` (bottom middle of the post) `h?` `len?` `open?` (arm raised); arrows attach to the post |
| `conveyor` | `x1 x2 y` (belt top) |
| `magnifier` | `x y` (lens centre) `s?` |
| `dial` | `x y` `s?` `label?` |
| `cabinet` | `x y` (bottom middle) `s?` `label?` |
| `machine` | `x y` (top-left) `w?` `h?` `label?` |
| `clock` | `x y` (face centre) `s?` `label?` |

Validation (`build.py`). Errors: `draw` not a list or empty, more than 40 ops, an op that is not an object, an unknown or missing `op`, a missing required field, a wrong field type, a duplicate or non-string `id`. Warnings: label over 18 or `t` over 40 characters, a coordinate outside the grid (clamped at render), an `arrow` pointing at an id that does not exist (the arrow is skipped), an unknown prop name, more than 3 `blot` ops, a colour or mood outside its list, a badly formed `id`. Render never throws on bad input: unknown ops and fields are ignored and the result is reported by `scripts/scene-preview.mjs` (see `themes.md`).

A lesson picture, a camera thread dying (it passes `scene-preview.mjs` clean):

```jsonc
{"scene": {
  "caption": "camera thread dies, fusion keeps waiting",
  "draw": [
    {"op": "ground", "y": 7.5},
    {"op": "prop", "name": "camera", "x": 2.2, "y": 4.2, "label": "camera.py", "id": "cam"},
    {"op": "ticks", "x": 2.2, "y": 2.6, "c": "red"},
    {"op": "prop", "name": "chip", "x": 13.6, "y": 4.2, "size": 2.2, "label": "fusion.py", "id": "fusion"},
    {"op": "packet", "x": 7.2, "y": 2.2, "label": "frame"},
    {"op": "arrow", "from": "cam", "to": "fusion", "dash": true, "c": "red", "bend": -0.6},
    {"op": "blot", "x": 8, "y": 5.4, "mood": "worried", "arms": [[6.6, 3.6], [9.4, 4.6]]},
    {"op": "text", "x": 8, "y": 8.3, "t": "no frame for 10 s: presence goes blind", "c": "red"}
  ]
}}
```

### Props

A node's `prop` (and each `scene.props[i].prop`) is an icon name from the sketch theme's prop library, `assets/themes/parts/props.js`: camera, phone, mic, speaker, headphones, monitor, laptop, terminal, keyboard, browser, file, folder, log, package, database, stack, server, cloud, network, globe, chip, gear, process, model, braces, sensor, dial, clock, bell, envelope, key, lock, shield, user, eye, magnifier, battery. Aliases resolve to these (`db` and `sqlite` to `database`, `daemon` and `worker` to `process`, `llm` to `model`, `cli` to `terminal`); matching ignores case and spaces at the ends. Pick the icon that is what the component really is. An unknown name is a build warning, not an error, and is drawn as a generic box. A queue has no icon of its own: use `stack`. Only sketch draws props; zine ignores `prop`, `items` and `props`.

```jsonc
{"id": "fusion", "label": "fusion.py", "prop": "chip", "layer": "engine", "owns": "the presence verdict"}
```

## Data sections

`data` is an optional list of extra sections for content that is evidence rather than a system: score tables, charts, headline numbers, caveats and sources. Each one gets its own entry in the contents rail and renders in both themes (colours come from the theme). A lesson with no map can be all `data`. The content is yours to supply and `build.py` does not check it against any source, so every number must come from a source you read; say where in `foot`.

```jsonc
"data": [{
  "title": "Current scores",              // required; the section heading and rail entry
  "intro": "One or two sentences.",
  "at": "end",                            // "end" (default: after Weak spots, before the quiz) | "start" (before the map)
  "blocks": [ /* 1 to 8 blocks, each {"type": ..., ...} */ ]
}]
```

| `type` | Fields | Shows |
|---|---|---|
| `text` | `text`, `title?` (a small heading above it) | Paragraphs (`\n\n` splits them). |
| `note` | `text`, `title?`, `tone?` (`info` default, `warn`) | A boxed caveat or callout. |
| `stats` | `items`: `{value, label, note?, unit?}` (at most 6) | Big headline numbers. |
| `table` | `columns` (strings or `{label, align?: "right", unit?}`), `rows` (arrays, one cell per column; the first column is the row header), `highlight?` (0-based row indices), `caption?`, `foot?` | A table; below 900px each row becomes a labelled card. |
| `bars` | `rows`: `{label, value, note?, hi?}`, `unit?`, `max?` (default: the largest value), `caption?`, `foot?` | Horizontal bars; `hi` paints one in the second colour. |
| `dumbbell` | `rows`: `{label, from, to, note?}`, `from_label?`, `to_label?`, `unit?`, `max?`, `step?` (axis tick spacing, at most 12 ticks) | Before and after per row. |
| `stack` | `rows`: `{label, parts: [{name, value}], note?}`, `unit?` | Each row's parts as shares of that row (4 colours). |
| `sources` | `items`: `{label, url?, note?}` | A numbered list; `url` must be http(s). |

Any block may carry `decimals` (0 to 4): every number in it prints with that many places, so a column of 13, 94.6 and 83 reads 13.0, 94.6 and 83.0. Every text field accepts `backticks` and glossary terms like the rest of the lesson. Cells and values may be strings or numbers; a number is shown as given plus `unit`. Put the unit and the date or version in the caption so a screenshot stands alone.

Validation (`build.py`). Errors: a section without a title or blocks, an unknown `type`, a missing required field, a table row whose cell count differs from the column count, a non-number where a number is required, a `max` or `step` of 0 or less, a `highlight` index outside the table, a source URL that is not http(s). Warnings: more than 8 sections or blocks, more than 6 stats, more than 8 columns, more than 40 table rows, more than 20 chart rows, more than 4 stack part names, a value above `max`. Render never throws on bad input: a block with an unknown type is skipped.

## Size budgets

| Part | Budget |
|---|---|
| Map nodes | 4 to 10 (8 or fewer recommended for architecture) |
| Trace steps (code mode) | 5 to 12 per trace, 1 to 3 traces |
| Snippet | at most 25 lines, verbatim, real line numbers |
| Break-it experiments | 2 to 4 |
| Decisions | 2 to 4 |
| Invariants (architecture) | 3 to 6, each rule at most 120 characters |
| Pressure points (architecture) | 2 to 5 |
| Flows (architecture mode traces) | 1 to 3 traces, 4 to 9 steps each |
| Quiz | 4 to 6 questions; build warns when the longest option is over 1.6x the shortest plus 8 characters (the longest must not be the answer) |
| Glossary | only terms that appear in the lesson |
| Data sections | at most 8 sections, 1 to 8 blocks each; tables at most 8 columns and 40 rows, charts at most 20 rows |
