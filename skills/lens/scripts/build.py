#!/usr/bin/env python3
"""Build a lens lesson: validate lesson JSON, inject into a theme template, write HTML.

Usage: build.py LESSON.json OUT.html [--open] [--check-src REPO_ROOT] [--theme NAME]

--theme picks a template from assets/themes/NAME.html (default: $LENS_THEME, else zine).

--check-src verifies every code snippet matches the real file at the stated
line numbers, so lessons never show invented code.
"""
import json, os, sys, subprocess, html, re
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
THEMES = HERE / "assets" / "themes"
PARTS = THEMES / "parts"
DEFAULT_THEME = os.environ.get("LENS_THEME") or "zine"


def theme_path(name):
    path = THEMES / f"{name}.html"
    if not path.is_file():
        found = sorted(t.stem for t in THEMES.glob("*.html"))
        sys.exit(f"ERROR: unknown theme {name!r}; available: {', '.join(found)}")
    return path
CONF = {"evidenced", "inferred", "uncertain", None}
SEV = {"high", "medium", "low"}
MODES = ("code", "architecture")
SCENE_NAMES = ("carry", "gate", "queue", "fork", "wall", "fire", "store", "lookup", "transform", "wait", "handoff", "watch")
INCLUDE = re.compile(r"^<!-- lens:include ([\w.-]+) -->$", re.M)
PLACEHOLDERS = ("__TITLE__", "__LESSON_JSON__")


def apply_includes(text, parts_dir=PARTS):
    """Replace each line `<!-- lens:include NAME -->` with parts_dir/NAME, verbatim (no escaping)."""
    def load(m):
        name, path = m.group(1), Path(parts_dir) / m.group(1)
        if not path.is_file():
            sys.exit(f"ERROR: theme includes missing part {name!r} (expected {path})")
        body = path.read_text()
        for ph in PLACEHOLDERS:
            if ph in body:
                sys.exit(f"ERROR: part {name!r} contains the placeholder {ph}; parts must not")
        return body
    return INCLUDE.sub(load, text)


def props_in(path):
    """Canonical names and aliases declared in a props.js (`names: [...]` and `alias: {...}`), read as text so no JS runs.
    An unreadable or non-declarative library gives an empty set, which switches the unknown-prop warning off."""
    try:
        src = Path(path).read_text()
    except OSError:
        return set()
    out = set()
    names = re.search(r"\bnames\b\s*(?::|=)\s*\[(.*?)\]", src, re.S) or re.search(r"\bNAMES\b\s*=\s*\[(.*?)\]", src, re.S)
    if names:
        out.update(re.findall(r"""['"]([\w-]+)['"]""", names.group(1)))
    alias = re.search(r"\balias\b\s*(?::|=)\s*\{(.*?)\}", src, re.S)
    if alias:
        out.update(re.findall(r"""(?:^|[{,])\s*['"]?([\w-]+)['"]?\s*:""", "{" + alias.group(1)))
    return out


_PROPS = {}


def known_props():
    """Prop names the sketch library can draw (cached; the file is read once per build)."""
    if "names" not in _PROPS:
        _PROPS["names"] = props_in(PARTS / "props.js")
    return _PROPS["names"]


def check_prop(name, where, warns):
    known = known_props()
    if known and name.strip().lower() not in known:  # the library resolves names trimmed and lower-cased
        warns.append(f"{where}: prop {name!r} is not in the prop library; a generic box is drawn")


def check_slots(sc, where, errs, warns):
    """scene.items (<=4 short strings: things handled) and scene.props (<=3 {prop, label}: places or objects). Both optional."""
    if "items" in sc:
        its = sc["items"]
        if not isinstance(its, list):
            errs.append(f"{where}: scene items must be an array")
        else:
            if len(its) > 4:
                errs.append(f"{where}: scene items has {len(its)} entries; max 4")
            for i, it in enumerate(its):
                if not (isinstance(it, str) and it.strip()):
                    errs.append(f"{where}: scene items {i + 1}: must be a non-empty string")
                elif len(it) > 18:
                    warns.append(f"{where}: scene items {i + 1} is {len(it)} chars; max 18 so it fits the picture")
    if "props" in sc:
        ps = sc["props"]
        if not isinstance(ps, list):
            errs.append(f"{where}: scene props must be an array")
        else:
            if len(ps) > 3:
                errs.append(f"{where}: scene props has {len(ps)} entries; max 3")
            for i, pr in enumerate(ps):
                if not isinstance(pr, dict):
                    errs.append(f"{where}: scene props {i + 1}: must be an object with prop and label")
                    continue
                if not isinstance(pr.get("prop"), str):
                    errs.append(f"{where}: scene props {i + 1}: prop must be a string")
                else:
                    check_prop(pr["prop"], f"{where}: scene props {i + 1}", warns)
                if "label" in pr:
                    if not isinstance(pr["label"], str):
                        errs.append(f"{where}: scene props {i + 1}: label must be a string")
                    elif len(pr["label"]) > 18:
                        warns.append(f"{where}: scene props {i + 1} label is {len(pr['label'])} chars; max 18 so it fits the picture")


def draw_ops_in(path):
    """Op names declared in scenes.js (`drawOps: [...]`), read as text so no JS runs. Absent or unreadable gives an empty set,
    which switches the unknown-op check off."""
    try:
        src = Path(path).read_text()
    except OSError:
        return set()
    m = re.search(r"\bdrawOps\b\s*(?::|=)\s*\[(.*?)\]", src, re.S)
    return set(re.findall(r"""['"]([\w-]+)['"]""", m.group(1))) if m else set()


_DRAW_OPS = {}


def known_draw_ops():
    if "names" not in _DRAW_OPS:
        _DRAW_OPS["names"] = draw_ops_in(PARTS / "scenes.js")
    return _DRAW_OPS["names"]


DRAW_COLOURS = ("ink", "red", "orange", "blue")
# Field kinds: n number, s string, b bool, pt [x,y], off [dx,dy] (a small offset, not a grid point), pts list of 2..8 points, pt2 two points, ref id or point, or an enum tuple.
# A name ending in ? is optional; the rest are required. Fields not listed are ignored (the renderer ignores them too).
_C = "c?:" + ",".join(DRAW_COLOURS)
DRAW_FIELDS = {
    "blot": "x:n y:n s?:n mood?:blank,worried,proud,happy look?:off face?:-1,1 tilt?:n arms?:pt2 legs?:pt2",
    "prop": "name:s x:n y:n size?:n label?:s",
    "box": "x:n y:n w:n h:n label?:s %s fill?:paper,ink" % _C,
    "packet": "x:n y:n label:s %s tilt?:n" % _C,
    "oval": "x:n y:n rx:n ry:n label?:s %s" % _C,
    "stack": "x:n y:n n?:n label?:s",
    "line": "pts:pts %s w?:1,2,3 dash?:b" % _C,
    "arrow": "from:ref to:ref label?:s %s bend?:n dash?:b" % _C,
    "text": "x:n y:n t:s %s size?:m,l anchor?:start,middle,end rot?:n" % _C,
    "ticks": "x:n y:n n?:n %s dir?:n len?:n" % _C,
    "ground": "y:n x1?:n x2?:n",
    "flame": "x:n y:n s?:n",
    "wall": "x:n y:n w?:n h?:n",
    "gate": "x:n y:n h?:n len?:n open?:b",
    "conveyor": "x1:n x2:n y:n",
    "magnifier": "x:n y:n s?:n",
    "dial": "x:n y:n s?:n label?:s",
    "cabinet": "x:n y:n s?:n label?:s",
    "machine": "x:n y:n w?:n h?:n label?:s",
    "clock": "x:n y:n s?:n label?:s",
}
for _op, _spec in list(DRAW_FIELDS.items()):
    _fields = {}
    for _tok in _spec.split():
        _name, _kind = _tok.split(":", 1)
        _fields[_name.rstrip("?")] = (not _name.endswith("?"), _kind if _kind in ("n", "s", "b", "pt", "off", "pts", "pt2", "ref") else tuple(_kind.split(",")))
    DRAW_FIELDS[_op] = _fields
del _op, _spec, _fields, _tok, _name, _kind
DRAW_MAX_OPS, DRAW_MAX_LABEL, DRAW_MAX_TEXT = 40, 18, 40
_ID_RE = re.compile(r"^[a-z0-9_-]{1,20}$")


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def _pt(v):
    return isinstance(v, list) and len(v) == 2 and all(_num(c) for c in v)


def _x_in(v):
    return 0 <= v <= 16


def _y_in(v):
    return 0 <= v <= 9


def check_draw(draw, where, errs, warns):
    """scene.draw: 1..40 ops from a 16 x 9 grid (see the contract). Shape and types are errors; things the renderer clamps, trims or skips are warnings."""
    if not isinstance(draw, list):
        errs.append(f"{where}: scene draw must be an array of ops")
        return
    if not draw:
        errs.append(f"{where}: scene draw is empty; give 1 to {DRAW_MAX_OPS} ops")
        return
    if len(draw) > DRAW_MAX_OPS:
        errs.append(f"{where}: scene draw has {len(draw)} ops; max {DRAW_MAX_OPS}")
    known = known_draw_ops()
    ids_seen, refs, blots = set(), [], 0
    for i, op in enumerate(draw):
        at = f"{where}: draw op {i + 1}"
        if not isinstance(op, dict):
            errs.append(f"{at}: must be an object, got {json.dumps(op)[:40]}")
            continue
        name = op.get("op")
        if not isinstance(name, str) or (known and name not in known) or (not known and name not in DRAW_FIELDS):
            errs.append(f"{at}: unknown op {name!r}" + (f"; valid ops: {', '.join(sorted(known or DRAW_FIELDS))}" if not isinstance(name, (dict, list)) else ""))
            continue
        at = f"{where}: draw op {i + 1} ({name})"
        blots += name == "blot"
        if name == "prop" and isinstance(op.get("name"), str):
            check_prop(op["name"], at, warns)
        for f, (required, kind) in DRAW_FIELDS.get(name, {}).items():
            if f not in op or op[f] is None:
                if required:
                    errs.append(f"{at}: {f} is required")
                continue
            v = op[f]
            if kind == "n":
                if not _num(v):
                    errs.append(f"{at}: {f} must be a number")
                elif (f in ("x", "x1", "x2") and not _x_in(v)) or (f == "y" and not _y_in(v)):
                    warns.append(f"{at}: {f} {v} is outside the {'0..16' if f != 'y' else '0..9'} grid; it is clamped")
            elif kind == "s":
                if not isinstance(v, str):
                    errs.append(f"{at}: {f} must be a string")
                elif f == "label" and len(v) > DRAW_MAX_LABEL:
                    warns.append(f"{at}: label is {len(v)} chars; max {DRAW_MAX_LABEL} so it is shown whole")
                elif f == "t" and len(v) > DRAW_MAX_TEXT:
                    warns.append(f"{at}: t is {len(v)} chars; max {DRAW_MAX_TEXT}")
            elif kind == "b":
                if not isinstance(v, bool):
                    errs.append(f"{at}: {f} must be true or false")
            elif kind == "off":
                if not _pt(v):
                    errs.append(f"{at}: {f} must be an [dx, dy] pair of numbers")
                elif abs(v[0]) > 2 or abs(v[1]) > 2:
                    warns.append(f"{at}: {f} {v} is a small offset (about -2 to 2); it is clamped")
            elif kind in ("pt", "pts", "pt2", "ref"):
                if kind == "ref" and isinstance(v, str):
                    refs.append((at, f, v))
                    continue
                pts = None
                if kind == "pt" or kind == "ref":
                    pts = [v] if _pt(v) else None
                elif kind == "pts":
                    pts = v if isinstance(v, list) and 2 <= len(v) <= 8 and all(_pt(q) for q in v) else None
                else:
                    pts = v if isinstance(v, list) and len(v) == 2 and all(_pt(q) for q in v) else None
                if pts is None:
                    want = {"pt": "an [x, y] pair", "pts": "2 to 8 [x, y] pairs", "pt2": "two [x, y] pairs", "ref": "an object id or an [x, y] pair"}[kind]
                    errs.append(f"{at}: {f} must be {want}")
                elif any(not _x_in(q[0]) or not _y_in(q[1]) for q in pts):
                    warns.append(f"{at}: {f} has a point outside the 16 x 9 grid; it is clamped")
            else:  # enum; numbers such as -1 and 2 are compared as text
                if str(v) not in kind or isinstance(v, bool):
                    warns.append(f"{at}: {f} {v!r} is not one of {', '.join(kind)}; the default is used")
        if "id" in op and op["id"] is not None:
            oid = op["id"]
            if not isinstance(oid, str):
                errs.append(f"{at}: id must be a string")
            else:
                if oid in ids_seen:
                    errs.append(f"{at}: duplicate id {oid!r}")
                ids_seen.add(oid)
                if not _ID_RE.match(oid):
                    warns.append(f"{at}: id {oid!r} should be 1 to 20 chars of a-z, 0-9, _ or -")
    for at, f, ref in refs:
        if ref not in ids_seen:
            warns.append(f"{at}: {f} {ref!r} is not the id of any object in this picture; the arrow is skipped")
    if blots > 3:
        warns.append(f"{where}: scene draw has {blots} blots; 3 or fewer keeps the picture readable")


def check_scene(s, where, errs, warns):
    if "scene" not in s:
        return
    sc = s["scene"]
    if not isinstance(sc, dict):
        errs.append(f"{where}: scene must be an object with name and caption")
        return
    if sc.get("name") not in SCENE_NAMES and not (sc.get("name") is None and "draw" in sc):  # name is optional once the scene is drawn
        errs.append(f"{where}: scene name {sc.get('name')!r} is not one of {', '.join(SCENE_NAMES)}")
    cap = sc.get("caption")
    if cap is None:
        warns.append(f"{where}: scene has no caption")
    elif not isinstance(cap, str):
        errs.append(f"{where}: scene caption must be a string")
    elif len(cap) > 60:
        errs.append(f"{where}: scene caption is {len(cap)} chars; max 60")
    check_slots(sc, where, errs, warns)
    if "draw" in sc:
        check_draw(sc["draw"], where, errs, warns)


def check_strings(o, fields, where, errs):
    for f in fields:
        if f in o and not isinstance(o[f], str):
            errs.append(f"{where}: {f} must be a string")


def items(o, key, label, errs, prefix=""):
    """o[key] as a list of dicts. A non-array value or a non-object item is reported (never raised) and skipped."""
    v = o.get(key, [])
    if not isinstance(v, list):
        errs.append(f"{prefix}{key} must be an array")
        return []
    out = []
    for i, x in enumerate(v):
        if isinstance(x, dict):
            out.append(x)
        else:
            errs.append(f"{prefix}{label} {i + 1}: must be an object, got {json.dumps(x)[:40]}")
    return out


def one_of(v, allowed):
    """`v in allowed` that never raises on unhashable values (lists, objects from a bad lesson)."""
    return isinstance(v, (str, type(None))) and v in allowed


def validate(L, repo=None):
    errs, warns = [], []
    need = lambda cond, msg: cond or errs.append(msg)
    if not isinstance(L, dict):
        return ["the lesson must be a JSON object"], warns
    if "mode" in L and L["mode"] not in MODES:
        errs.append(f"mode must be 'code' or 'architecture', got {L['mode']!r}")
    arch = L.get("mode") == "architecture"
    need(isinstance(L.get("title"), str) and L["title"], "title is required")
    nodes = items(L, "nodes", "node", errs)
    ids = [n["id"] for n in nodes if isinstance(n.get("id"), str)]
    need(len(ids) == len(set(ids)), f"duplicate node ids: {sorted({i for i in ids if ids.count(i) > 1})}")
    ids = set(ids)
    layer_ids = {l["id"] for l in items(L, "layers", "layer", errs) if isinstance(l.get("id"), str)}
    if not 2 <= len(nodes) <= 14 and not (not nodes and L.get("data")):  # a data-only lesson has no map
        warns.append(f"{len(nodes)} nodes on the map; 4-10 is easiest to read")
    for n in nodes:
        need(isinstance(n.get("id"), str) and n["id"] and n.get("label"), f"node needs id and label: {n}")
        need(n.get("simple") or n.get("deep"), f"node {n.get('id')} needs simple or deep text")
        if layer_ids and not one_of(n.get("layer"), layer_ids):
            errs.append(f"node {n.get('id')} has unknown layer {n.get('layer')!r}")
        need(one_of(n.get("confidence"), CONF), f"node {n.get('id')} bad confidence")
        check_strings(n, ("owns", "exposes", "runs", "scale"), f"node {n.get('id')}", errs)
        check_scene(n, f"node {n.get('id')}", errs, warns)
        if "prop" in n:
            if not isinstance(n["prop"], str):
                errs.append(f"node {n.get('id')}: prop must be a string")
            else:
                check_prop(n["prop"], f"node {n.get('id')}", warns)
        for f in items(n, "functions", "function", errs, f"node {n.get('id')}: "):
            need(f.get("name"), f"function in node {n.get('id')} needs name")
            if f.get("code"):
                check_code(f["code"], f"node {n.get('id')} fn {f.get('name')}", errs, warns, repo)
    edges = items(L, "edges", "edge", errs)
    seen_pairs = set()
    for e in edges:
        need(one_of(e.get("from"), ids) and one_of(e.get("to"), ids) and e.get("from") and e.get("to"), f"edge references unknown node: {e}")
        where = f"edge {e.get('from')}->{e.get('to')}"
        check_strings(e, ("protocol", "payload", "guarantee"), where, errs)
        if "sync" in e and not isinstance(e["sync"], bool):
            errs.append(f"{where}: sync must be true or false")
        if isinstance(e.get("from"), str) and isinstance(e.get("to"), str) and e["from"] in ids and e["to"] in ids:
            if e["from"] == e["to"]:
                warns.append(f"{where} is a self-loop; show it as text on the node instead")
            elif (e["from"], e["to"]) in seen_pairs:
                warns.append(f"{where} appears more than once; merge the duplicates into one edge")
            seen_pairs.add((e["from"], e["to"]))
    linked = {frozenset((e["from"], e["to"])) for e in edges if isinstance(e.get("from"), str) and isinstance(e.get("to"), str)}
    if arch and edges and sum(1 for e in edges if not e.get("protocol")) * 2 > len(edges):
        warns.append(f"architecture mode: {sum(1 for e in edges if not e.get('protocol'))} of {len(edges)} edges have no protocol")
    if arch and not L.get("traces"):
        warns.append("architecture mode has no traces; add 1-3 flows")
    for ti, t in enumerate(items(L, "traces", "trace", errs)):
        tn = f"trace {ti + 1}"
        need(t.get("title") and t.get("steps"), f"{tn} needs title and steps")
        steps = items(t, "steps", "step", errs, f"{tn}: ")
        if len(steps) > 14:
            warns.append(f"trace {t.get('title')!r} has {len(steps)} steps; split it (max ~12)")
        for si, s in enumerate(steps):
            where = f"{tn} step {si + 1}"
            need(one_of(s.get("node"), ids) and s.get("node"), f"{where}: unknown node {s.get('node')!r}")
            need(s.get("title"), f"{where}: title required")
            need(s.get("simple") or s.get("deep"), f"{where}: needs simple or deep text")
            need(one_of(s.get("confidence"), CONF), f"{where}: bad confidence")
            check_scene(s, where, errs, warns)
            if s.get("code"):
                check_code(s["code"], where, errs, warns, repo)
            if s.get("predict"):
                check_mcq(s["predict"], where, errs, warns)
            a, b = steps[si - 1].get("node") if si else None, s.get("node")
            if si and a != b and one_of(a, ids) and one_of(b, ids) and a and b and frozenset((a, b)) not in linked:
                warns.append(f"{where}: no edge between {a} and {b}; the map will show a jump")
    quiz = items(L, "quiz", "quiz", errs)
    for i, q in enumerate(quiz):
        if not (isinstance(q.get("q"), str) and q["q"].strip()):
            errs.append(f"quiz {i + 1}: q (the question) is required")
        check_mcq(q, f"quiz {i + 1}", errs, warns)
    answers = [q["answer"] for q in quiz if isinstance(q.get("answer"), int)]
    if len(answers) >= 3 and len(set(answers)) == 1:
        warns.append("every quiz answer is at the same position; shuffle them")
    for w in items(L, "whatifs", "whatif", errs):
        need(w.get("title") and w.get("change") and w.get("outcome"), f"whatif needs title/change/outcome: {w.get('title')}")
        refs = w.get("affects", [])
        if not isinstance(refs, list):
            errs.append(f"whatif {w.get('title')!r}: affects must be an array of node ids")
            refs = []
        for a in refs + ([w["node"]] if w.get("node") else []):
            need(one_of(a, ids), f"whatif {w.get('title')!r} references unknown node {a!r}")
        check_scene(w, f"whatif {w.get('title')!r}", errs, warns)
    for r in items(L, "risks", "risk", errs):
        need(one_of(r.get("severity"), SEV) and r.get("severity"), f"risk {r.get('title')!r} severity must be high|medium|low")
        check_scene(r, f"risk {r.get('title')!r}", errs, warns)
    for d in items(L, "decisions", "decision", errs):
        need(d.get("title") and d.get("chosen"), f"decision needs title and chosen: {d}")
        check_strings(d, ("context", "consequences"), f"decision {d.get('title')!r}", errs)
        check_scene(d, f"decision {d.get('title')!r}", errs, warns)
    for i, v in enumerate(items(L, "invariants", "invariant", errs)):
        where = f"invariant {i + 1}"
        need(v.get("rule"), f"{where}: rule is required")
        need(v.get("breaks"), f"{where}: breaks is required")
        need(one_of(v.get("node"), ids) and v.get("node"), f"{where}: unknown node {v.get('node')!r}")
        need(one_of(v.get("confidence"), CONF), f"{where}: bad confidence")
        check_strings(v, ("rule", "evidence"), where, errs)
        if isinstance(v.get("rule"), str) and len(v["rule"]) > 120:
            warns.append(f"{where}: rule is {len(v['rule'])} chars; keep it to one sentence of 120 or fewer and put detail in breaks/evidence")
        check_scene(v, where, errs, warns)
    for i, p in enumerate(items(L, "pressure", "pressure", errs)):
        where = f"pressure {p.get('title')!r}"
        need(p.get("title"), f"pressure {i + 1}: title is required")
        need(p.get("limit"), f"pressure {i + 1}: limit is required")
        need(one_of(p.get("node"), ids) and p.get("node"), f"{where}: unknown node {p.get('node')!r}")
        need(one_of(p.get("severity"), SEV) and p.get("severity"), f"{where}: severity must be high|medium|low")
        need(one_of(p.get("confidence"), CONF), f"{where}: bad confidence")
        check_strings(p, ("signal", "mitigation"), where, errs)
        check_scene(p, where, errs, warns)
    check_data(L, errs, warns)
    return errs, warns


DATA_TYPES = ("text", "note", "stats", "table", "bars", "dumbbell", "stack", "sources")


def _isnum(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check_data(L, errs, warns):
    """`data`: extra sections of typed blocks (tables, charts, stats, notes, sources) for content that is not a system map."""
    if "data" not in L:
        return
    secs = items(L, "data", "data section", errs)
    if len(secs) > 8:
        warns.append(f"data: {len(secs)} sections; more than 8 makes the contents rail long")
    for si, sec in enumerate(secs):
        where = f"data section {si + 1}"
        if not (isinstance(sec.get("title"), str) and sec["title"].strip()):
            errs.append(f"{where}: title is required")
        else:
            where = f"data section {sec['title']!r}"
        check_strings(sec, ("intro",), where, errs)
        if "at" in sec and sec["at"] not in ("start", "end"):
            errs.append(f"{where}: at must be 'start' or 'end', got {sec['at']!r}")
        blocks = items(sec, "blocks", "block", errs, prefix=f"{where}: ")
        if not blocks:
            errs.append(f"{where}: needs at least one block")
        if len(blocks) > 8:
            warns.append(f"{where}: {len(blocks)} blocks; split it into two sections past 8")
        for bi, b in enumerate(blocks):
            w = f"{where}, block {bi + 1}"
            t = b.get("type")
            if t not in DATA_TYPES:
                errs.append(f"{w}: type must be one of {', '.join(DATA_TYPES)}; got {t!r}")
                continue
            w += f" ({t})"
            check_strings(b, ("caption", "foot", "unit"), w, errs)
            if "decimals" in b and not (isinstance(b["decimals"], int) and not isinstance(b["decimals"], bool) and 0 <= b["decimals"] <= 4):
                errs.append(f"{w}: decimals must be a whole number from 0 to 4")
            if "max" in b and not (_isnum(b["max"]) and b["max"] > 0):
                errs.append(f"{w}: max must be a number above 0")
            if t in ("text", "note"):
                if not (isinstance(b.get("text"), str) and b["text"].strip()):
                    errs.append(f"{w}: text is required")
                if t == "note" and "tone" in b and b["tone"] not in ("info", "warn"):
                    errs.append(f"{w}: tone must be 'info' or 'warn'")
                check_strings(b, ("title",), w, errs)  # a text block's title is a small heading above it
            elif t == "stats":
                its = items(b, "items", "item", errs, prefix=f"{w}: ")
                if not its:
                    errs.append(f"{w}: needs at least one item")
                if len(its) > 6:
                    warns.append(f"{w}: {len(its)} stats; keep it to 6 or fewer")
                for i, x in enumerate(its):
                    if x.get("value") in (None, ""):
                        errs.append(f"{w}, item {i + 1}: value is required")
                    if not (isinstance(x.get("label"), str) and x["label"].strip()):
                        errs.append(f"{w}, item {i + 1}: label is required")
                    check_strings(x, ("note", "unit"), f"{w}, item {i + 1}", errs)
            elif t == "table":
                cols = b.get("columns")
                if not (isinstance(cols, list) and cols):
                    errs.append(f"{w}: columns must be a non-empty array")
                    cols = []
                for ci, c in enumerate(cols):
                    lab = c.get("label") if isinstance(c, dict) else c
                    if not isinstance(lab, str):
                        errs.append(f"{w}: column {ci + 1} must be a string or an object with a string label")
                    if isinstance(c, dict) and c.get("align") not in (None, "left", "right"):
                        errs.append(f"{w}: column {ci + 1} align must be 'left' or 'right'")
                rows = b.get("rows")
                if not (isinstance(rows, list) and rows):
                    errs.append(f"{w}: rows must be a non-empty array of arrays")
                    rows = []
                for ri, r in enumerate(rows):
                    if not isinstance(r, list):
                        errs.append(f"{w}: row {ri + 1} must be an array")
                    elif len(r) != len(cols):
                        errs.append(f"{w}: row {ri + 1} has {len(r)} cells for {len(cols)} columns")
                if len(cols) > 8:
                    warns.append(f"{w}: {len(cols)} columns; past 8 the table scrolls sideways")
                if len(rows) > 40:
                    warns.append(f"{w}: {len(rows)} rows; split the table")
                hi = b.get("highlight", [])
                if not (isinstance(hi, list) and all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(rows) for i in hi)):
                    errs.append(f"{w}: highlight must be an array of row indices (0-based) inside the table")
            elif t in ("bars", "dumbbell", "stack"):
                rows = items(b, "rows", "row", errs, prefix=f"{w}: ")
                if not rows:
                    errs.append(f"{w}: needs at least one row")
                if len(rows) > 20:
                    warns.append(f"{w}: {len(rows)} rows; keep a chart to 20 or fewer")
                vals = []
                for ri, r in enumerate(rows):
                    rw = f"{w}, row {ri + 1}"
                    if not (isinstance(r.get("label"), str) and r["label"].strip()):
                        errs.append(f"{rw}: label is required")
                    check_strings(r, ("note",), rw, errs)
                    if t == "bars":
                        if not _isnum(r.get("value")):
                            errs.append(f"{rw}: value must be a number")
                        else:
                            vals.append(r["value"])
                    elif t == "dumbbell":
                        for k in ("from", "to"):
                            if not _isnum(r.get(k)):
                                errs.append(f"{rw}: {k} must be a number")
                            else:
                                vals.append(r[k])
                    else:
                        ps = items(r, "parts", "part", errs, prefix=f"{rw}: ")
                        if not ps:
                            errs.append(f"{rw}: needs at least one part")
                        for pi, p in enumerate(ps):
                            if not (isinstance(p.get("name"), str) and p["name"].strip()):
                                errs.append(f"{rw}, part {pi + 1}: name is required")
                            if not (_isnum(p.get("value")) and p["value"] >= 0):
                                errs.append(f"{rw}, part {pi + 1}: value must be a number, 0 or more")
                if t == "stack":
                    names = {p.get("name") for r in rows for p in r.get("parts", []) if isinstance(p, dict)}
                    if len(names) > 4:
                        warns.append(f"{w}: {len(names)} part names; only 4 colours, so the 5th reuses the first")
                if t == "dumbbell":
                    check_strings(b, ("from_label", "to_label"), w, errs)
                    if "step" in b and not (_isnum(b["step"]) and b["step"] > 0):
                        errs.append(f"{w}: step must be a number above 0")
                if t in ("bars", "dumbbell") and _isnum(b.get("max")) and any(v > b["max"] for v in vals):
                    warns.append(f"{w}: a value is above max ({b['max']}); its mark is clamped to the end")
            elif t == "sources":
                its = items(b, "items", "item", errs, prefix=f"{w}: ")
                if not its:
                    errs.append(f"{w}: needs at least one item")
                for i, x in enumerate(its):
                    if not (isinstance(x.get("label"), str) and x["label"].strip()):
                        errs.append(f"{w}, item {i + 1}: label is required")
                    u = x.get("url")
                    if u is not None and not (isinstance(u, str) and re.match(r"https?://", u, re.I)):
                        errs.append(f"{w}, item {i + 1}: url must start with http:// or https://")
                    check_strings(x, ("note",), f"{w}, item {i + 1}", errs)


def check_mcq(q, where, errs, warns):
    if not isinstance(q, dict):
        errs.append(f"{where}: must be an object with options, answer and why")
        return
    opts = q.get("options", [])
    ans = q.get("answer")
    if not (isinstance(opts, list) and 2 <= len(opts) <= 5 and all(isinstance(o, str) for o in opts)
            and isinstance(ans, int) and not isinstance(ans, bool) and 0 <= ans < len(opts)):
        errs.append(f"{where}: needs 2-5 options and a valid answer index")
        return
    if not q.get("why"):
        errs.append(f"{where}: needs 'why' feedback")
    lens = [len(o) for o in opts]
    if max(lens) > 1.6 * min(lens) + 8:
        warns.append(f"{where}: option lengths vary a lot {lens}; the longest often gives the answer away")


def check_code(c, where, errs, warns, repo):
    if not isinstance(c, dict) or not isinstance(c.get("src"), str) or not c["src"]:
        errs.append(f"{where}: code needs src")
        return
    n = c["src"].rstrip("\n").count("\n") + 1
    start = c.get("start", 1)
    if not isinstance(start, int) or isinstance(start, bool) or start < 1:
        errs.append(f"{where}: code.start must be a positive integer")
        return
    hl = c.get("highlight", [])
    if not isinstance(hl, list) or not all(isinstance(h, int) and not isinstance(h, bool) for h in hl):
        errs.append(f"{where}: highlight must be a list of integers")
        return
    notes = c.get("notes", {})
    if not isinstance(notes, dict) or not all(isinstance(k, str) and k.lstrip("-").isdigit() for k in notes):
        errs.append(f"{where}: notes must be an object keyed by line number")
        return
    if n > 30:
        warns.append(f"{where}: snippet is {n} lines; keep under ~25")
    for k in list(notes) + hl:
        if not start <= int(k) < start + n:
            errs.append(f"{where}: note/highlight line {k} outside snippet {start}-{start + n - 1}")
    if repo and not c.get("file"):
        warns.append(f"{where}: snippet has no file, so it cannot be verified; mark the step inferred")
    if repo and c.get("file"):
        if not isinstance(c["file"], str):
            errs.append(f"{where}: code.file must be a string")
            return
        p = Path(repo) / c["file"]
        if not p.exists():
            p = Path(c["file"]).expanduser()
        if not p.exists():
            errs.append(f"{where}: cannot find {c['file']} to verify the snippet")
            return
        real = p.read_text(errors="replace").splitlines()[start - 1:start - 1 + n]
        mine = c["src"].rstrip("\n").split("\n")
        norm = lambda s: s.rstrip()
        bad = [start + i for i, (a, b) in enumerate(zip(mine, real)) if norm(a) != norm(b) and not re.fullmatch(r"\s*(\.\.\.|…|# \.\.\.|// \.\.\.)\s*", a)]
        if len(real) < len(mine) or bad:
            errs.append(f"{where}: snippet does not match {c['file']} at lines {bad[:5] or 'end of file'}")


def render(template, title, lesson):
    """Fill __TITLE__ and __LESSON_JSON__ in one pass, so text inserted for one is never rescanned for the other."""
    data = json.dumps(lesson, ensure_ascii=False).replace("</", "<\\/")
    # Inside <script> a literal `<!--` followed later by `<script` switches the HTML parser into the
    # "script data double escaped" state and swallows the closing tag. \u003c is the same character to JSON.parse.
    data = re.sub(r"<(?=!--|script)", r"\\u003c", data, flags=re.I)
    values = {"__TITLE__": html.escape(title), "__LESSON_JSON__": data}
    return re.sub("|".join(PLACEHOLDERS), lambda m: values[m.group(0)], template)


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lesson"); ap.add_argument("out")
    ap.add_argument("--open", action="store_true")
    ap.add_argument("--check-src", metavar="REPO_ROOT")
    ap.add_argument("--theme", default=DEFAULT_THEME, help="template in assets/themes/ (default: %(default)s)")
    a = ap.parse_args()
    src, out, repo = Path(a.lesson), Path(a.out), a.check_src
    template = theme_path(a.theme)
    L = json.loads(src.read_text())
    errs, warns = validate(L, repo)
    for w in warns:
        print("warn:", w)
    if errs:
        for e in errs:
            print("ERROR:", e)
        sys.exit(1)
    page = render(apply_includes(template.read_text()), L["title"], L)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)
    counts = {k: len(L.get(k, [])) for k in ("nodes", "edges", "traces", "whatifs", "decisions", "risks", "invariants", "pressure", "quiz", "glossary", "data")}
    print(f"ok: wrote {out} ({out.stat().st_size // 1024} KB, theme {a.theme}) {counts}")
    if a.open:
        subprocess.Popen(["xdg-open", str(out)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
