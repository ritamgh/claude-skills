# Themes

A theme is one self-contained HTML file in `assets/themes/<name>.html` that renders a lesson JSON object (see `lesson-schema.md`). All themes read the same lesson data, so any lesson can be rebuilt in any theme without changing its JSON.

| Theme | Status | Look |
|---|---|---|
| `zine` | default | Hand-drawn tech zine: dot-grid paper, marker headings, sketched system map, one long scrolling article with a sticky contents rail. Large-monitor first. Design rules: `DESIGN.md`. |
| `sketch` | available | White sketchbook: thin black hand-drawn lines, red/orange/blue Caveat handwriting (blue route, red current stop and damage, orange impact), generous white space, and Blot, a black-blob mascot, acting out steps, nodes, failure modes, decisions, risks, pressure points and invariants in small scenes (the `scene` field, or a per-section default). Dark mode is a blackboard. |

## Choosing a theme

```bash
python3 scripts/build.py lesson.json out.html --theme <name>   # one lesson
export LENS_THEME=<name>                                        # change the default
```

Without either, `build.py` uses `zine`.

## The contract a theme must honour

`build.py` replaces two placeholders and one include line, nothing else:

- `__TITLE__` with the HTML-escaped lesson title (put it in `<title>`).
- `__LESSON_JSON__` with the lesson JSON (put it in `<script id="lesson" type="application/json">`).

- A line that is exactly `<!-- lens:include NAME -->` with the contents of `assets/themes/parts/NAME`, verbatim (no escaping). This happens before the placeholders are filled, a missing part stops the build with an ERROR, and a part must not contain `__TITLE__` or `__LESSON_JSON__`. Parts are how themes share code, for example `parts/scenes.js`, the Blot scene library, which defines the global `LensScenes`. Sketch includes `props.js` BEFORE `scenes.js` (`<!-- lens:include props.js -->` first); scenes.js still works without it and draws generic boxes.

Every theme must render both lesson modes (`code` and `architecture`; see "Modes" in `lesson-schema.md`), including the architecture fields and sections (an invariant's optional `evidence` goes under its rule as a small "Enforced by:" line), so any lesson can be rebuilt in any theme. The `scene` field (with its `items` and `props`) and a node's `prop` are sketch-only: other themes ignore them (zine ignores all of it), and a lesson never needs scenes to work. Every capability in `lesson-schema.md` must work: map with layers, nodes, edges and row/col overrides; route highlighting; Impact mode; node detail with functions and code; 1 to 3 traces with code, notes, state and predict gates; Plain/Deep (P/D keys); keyboard navigation between stops; break-it with damage painted on the map; decisions; weak spots; quiz with persistence and missed-first ordering; glossary tooltips; Ask Claude (below); light and dark themes; no horizontal scroll at 390 px. Persist per lesson in `localStorage` under `lens:<lesson id>:...`.

`scripts/smoke.mjs` relies only on these selectors, so every theme needs them:

| Selector | Meaning |
|---|---|
| `.node` | One per map node, clickable (opens its detail). |
| `[data-lens-stop="<i>"]` | A visible control that goes to stop `i` of the current trace. |
| `.choice[data-p="<j>"]` | Option `j` of a predict gate; clicking an enabled one answers that gate. |
| `#mapMode button[data-m="route"]` | Optional: returns the map to the route view. |

## Ask Claude

When a lesson is served by `scripts/serve.py`, `GET /__lens/health` answers `{"lens": 1, "models": [...], "model": default}` on the same origin. A theme should then let the reader select text (or press A) and ask about it, and offer an ask button per stop and per component. To ask, POST JSON `{q, model, session?, lesson?, quote?, where?}` to `/__lens/ask` with `Content-Type: application/json` and an `X-Lens-Key` header. The key arrives in the link serve.py prints, as `#k=<key>`: read it from `location.hash`, keep it in `localStorage` under `lens:key`, and remove the hash from the address bar. The reply is NDJSON lines: `{"t":"text","v":chunk}`, `{"t":"tool","v":"Read path"}`, `{"t":"error","v":msg}`, `{"t":"session","v":id}` once the turn is saved (send it back as `session` for follow-ups), then `{"t":"done"}`; a stream without `done` was cut off. Opened as a file (no health), the same controls copy a question to the clipboard. `scripts/test-ask.mjs [theme]` covers it end to end with a fake `claude` (zine by default; `node scripts/test-ask.mjs sketch` for sketch).

## Adding a theme

1. Copy the closest existing theme to `assets/themes/<name>.html` and change it. Keep the JS data handling; restyle and restructure freely.
2. Add a regression suite at `scripts/theme-tests/<name>.mjs` (copy `zine.mjs`; it receives the built example's path as `argv[2]`). Expected values are literals from `examples/jw-ask-flow.json`.
3. Run `node scripts/test-template.mjs <name>`, `python3 scripts/test-serve.py`, and `node scripts/smoke.mjs` on a real lesson, at desktop and phone width, light and dark.
4. Add a row to the table above.

## Sketch parts: props, scenes, context plates

- `parts/props.js` defines the global `LensProps = { names, alias, resolve(name), draw(p, name, cx, cy, size) }`. `names` is the icon list, `alias` maps synonyms to names, `resolve` returns the canonical name or `null` (unknown, empty, any case), `draw` pushes one icon into the pen `p` inside a `size` square centred at `cx,cy` (no label, one accent colour at most; an unknown name draws a generic box and never throws). `names` and `alias` must stay plain single-quoted literals: `build.py` reads them with a regex to warn on unknown prop names. To add an icon: add the name, add its drawing to `ICONS`, run the props gallery.
- `parts/scenes.js` exports `LensScenes.render(name, {caption, mood, items, props})`, `LensScenes.blot()`, `LensScenes.context(...)` and `LensScenes._pen` (the pen, internal; the props gallery uses it). Absent `items` and `props` give the old drawing byte for byte, and the gallery pins that with hashes.
- `LensScenes.context({title, prop, owns, inputs: [{label, prop?, payload?}], outputs: [...], mood})` returns a 640x360 SVG: the node's own component in the centre with Blot working on it, up to 2 upstream neighbours on the left and 2 downstream on the right with arrows labelled by payload, more collapsed to "+N more". It is not a scene name and no lesson can select it.
- `LensScenes.draw(spec, {w?, report?})` draws a bespoke picture for `scene.draw` (ops and fields: `lesson-schema.md`) and returns a 640x360 SVG string (`data-scene="draw"`, `role="img"`, aria-label from the caption and labels). `spec` is the scene object (`{caption, draw, name?, items?, props?}`). `LensScenes.drawOps` is the op list, a one-line single-quoted literal (`drawOps: ['blot', ...]`) that `build.py` reads as text to reject unknown ops; keep it so, and add any new op to `DRAW_FIELDS` in `build.py`. A theme that draws pictures calls `draw` inside try/catch and falls back to the named scene when it throws or does not return a string starting with `<svg` (sketch does this in `plate()`); a theme that cannot draw ignores `draw`, and a lesson never needs it to work. Guarantees the engine keeps and `scenes-gallery.mjs` enforces: deterministic (the seed is a hash of the first 40 ops and the caption), never throws on any input (unknown ops and fields ignored, wrong types coerced or skipped, hostile objects survived), only the first 40 ops drawn, every `<text>` at least 20 viewBox units, labels shown whole (at most 18 characters, `t` at most 40) by growing boxes and wrapping rather than shrinking, coordinates clamped and every shape kept inside the frame, all text escaped, colours through the same CSS variables as the scenes, no `Math.random`. With `report` (an object) it fills `{unknownOps, warnings, objects}` (grid-unit boxes of every drawn thing and label), which the preview tool uses. If no op draws and `spec.name` is a scene name it returns that scene instead.
- `node scripts/scene-preview.mjs spec.json [out.png] [--dark] [--w 640]` is the author's feedback loop for a drawing (needs Playwright; the font is fetched once with a 4 s limit, offline it measures a fallback font and says so). `spec.json` is one scene object, an array of them, or `{scenes: [...]}`. It renders each in a real browser with the sketch colours and writes the PNG (default `<tmp>/lens-preview/<spec name>.png`, several scenes get `-1`, `-2`...). Stdout is JSON `{font, theme, scenes: [{ok, caption, textMinPx, overlaps, outside, unknownOps, warnings, png}]}`: `textMinPx` is the smallest text at a 358px plate (must be 11 or more), `overlaps` lines read like `text 'detect_sample' overlaps packet 'frame' at grid (6,4.2)` (also text on text and text sitting on a drawn line), `outside` lists things leaving the frame, `unknownOps` the ops it did not understand, `warnings` the clamps, duplicate or unknown ids and the 40-op cut. `ok` is true when there are no overlaps, outside items or unknown ops and text is at least 11px. Exit 0 all scenes ok, 1 some scene not ok, 2 usage or environment (no Playwright, unreadable spec).
- Legibility rule for any scene or plate you write: text is never smaller than 20 viewBox units, so it renders at 11px or more when the plate is at least 358px wide (plates with authored text show at up to 560px; plates on a phone fill the card). Labels (18 chars) and captions (60 chars) are drawn whole: they widen their box, wrap (captions up to 3 lines) or sit beside the object, never shrink below the floor or end in an ellipsis. When a context plate is crowded it drops the `owns` line first (the note already has an Owns row). The galleries enforce this with a pixel check; the sketch theme tests check the rendered size at 1440, 768 and 390.
- In architecture mode, sketch builds a context plate from the lesson graph for every node that has no authored `scene` and shows it first in the node's note: `inputs` are edges into the node, `outputs` edges out of it, neighbour `label` and `prop` come from the neighbour node, arrow text is the edge `payload`, else `protocol`, else `label`, clipped to 18 characters. A node with an authored `scene` shows that instead. Code mode and zine draw no plates.
- Galleries (need Playwright, no network): `node scripts/scenes-gallery.mjs [outdir]` checks the scene contract (including the draw ops, 8 sample drawings, fuzz and hostile input) and writes screenshots of all scenes, the draw samples (`gallery-draw-{light,dark}-1000.png`) and sample plates; `node scripts/props-gallery.mjs [outdir]` checks the prop contract and writes the icon grids (light and dark, 1440 and 390 px).
