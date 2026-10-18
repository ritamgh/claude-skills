#!/usr/bin/env python3
"""Tests for build.py: lesson validation (modes, architecture fields, scenes) and the
`<!-- lens:include NAME -->` parts mechanism. Plain python, no pytest.
Usage: python3 test-build.py"""
import copy, importlib.util, json, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("lens_build", HERE / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
failed = 0


def t(name, fn):
    global failed
    try:
        fn(); print("PASS", name)
    except Exception as e:
        failed += 1; print("FAIL", name, "-", f"{type(e).__name__}: {e}")


def eq(a, b, m=""):
    if a != b:
        raise AssertionError(f"{m} expected {b!r}, got {a!r}")


# A minimal architecture lesson that exercises every new field and must validate clean.
GOOD = {
    "title": "T", "mode": "architecture",
    "nodes": [
        {"id": "api", "label": "API", "simple": "s", "owns": "sessions", "exposes": "REST", "runs": "web pod",
         "scale": "stateless, 20 pods", "scene": {"name": "gate", "caption": "check token", "items": ["valid token", "stale token"],
                   "props": [{"prop": "database", "label": "sessions table"}]}},
        {"id": "db", "label": "DB", "simple": "s", "prop": "database"},
    ],
    "edges": [{"from": "api", "to": "db", "protocol": "SQL", "sync": True, "payload": "row", "guarantee": "ordered"}],
    "traces": [{"title": "t", "steps": [
        {"node": "api", "title": "a", "simple": "s", "scene": {"name": "carry", "caption": "request in"}},
        {"node": "db", "title": "b", "simple": "s"}]}],
    "invariants": [{"rule": "one writer per row", "node": "db", "breaks": "lost updates", "confidence": "inferred",
                    "scene": {"name": "gate", "caption": "one at a time"}}],
    "pressure": [{"title": "pool", "node": "db", "limit": "100 conns", "signal": "p99 up", "mitigation": "pgbouncer",
                  "severity": "high", "confidence": "uncertain", "scene": {"name": "queue", "caption": "waiting"}}],
    "whatifs": [{"title": "w", "change": "c", "outcome": "o", "scene": {"name": "fire", "caption": "db down"}}],
    "decisions": [{"title": "d", "chosen": "c", "context": "small team", "consequences": "we run it",
                   "scene": {"name": "fork", "caption": "pick one"}}],
    "risks": [{"title": "r", "severity": "low", "scene": {"name": "watch", "caption": "dial"}}],
}


def mutated(fn):
    L = copy.deepcopy(GOOD)
    fn(L)
    return build.validate(L)


def expect_err(fn, msg):
    errs, _ = mutated(fn)
    eq(errs, [msg])


def good_passes():
    errs, warns = build.validate(copy.deepcopy(GOOD))
    eq((errs, warns), ([], []))


t("minimal architecture lesson with every new field validates with no errors or warnings", good_passes)


NAMES = ["carry", "gate", "queue", "fork", "wall", "fire", "store", "lookup", "transform", "wait", "handoff", "watch"]
SCENE_LIST = ", ".join(NAMES)


def scene_names():
    eq(list(build.SCENE_NAMES), NAMES)


t("SCENE_NAMES holds exactly the 12 contract names", scene_names)

# mode
t("mode 'code' is accepted", lambda: eq(mutated(lambda L: L.update(mode="code"))[0], []))
t("unknown mode is an error", lambda: expect_err(lambda L: L.update(mode="deep"), "mode must be 'code' or 'architecture', got 'deep'"))

# node fields
for f in ("owns", "exposes", "runs", "scale"):
    t(f"node {f} must be a string", lambda f=f: expect_err(lambda L: L["nodes"][0].update({f: 3}), f"node api: {f} must be a string"))

# edge fields
for f in ("protocol", "payload", "guarantee"):
    t(f"edge {f} must be a string", lambda f=f: expect_err(lambda L: L["edges"][0].update({f: 7}), f"edge api->db: {f} must be a string"))
t("edge sync must be a real bool, not 1", lambda: expect_err(lambda L: L["edges"][0].update(sync=1), "edge api->db: sync must be true or false"))
t("edge sync must be a real bool, not the string 'false'", lambda: expect_err(lambda L: L["edges"][0].update(sync="false"), "edge api->db: sync must be true or false"))
t("edge sync false is valid", lambda: eq(mutated(lambda L: L["edges"][0].update(sync=False))[0], []))

# invariants
t("invariant needs rule", lambda: expect_err(lambda L: L["invariants"][0].pop("rule"), "invariant 1: rule is required"))
t("invariant needs breaks", lambda: expect_err(lambda L: L["invariants"][0].pop("breaks"), "invariant 1: breaks is required"))
t("invariant node must exist", lambda: expect_err(lambda L: L["invariants"][0].update(node="ghost"), "invariant 1: unknown node 'ghost'"))
t("invariant confidence must be known", lambda: expect_err(lambda L: L["invariants"][0].update(confidence="sure"), "invariant 1: bad confidence"))
t("invariants must be a list", lambda: expect_err(lambda L: L.update(invariants={"rule": "x"}), "invariants must be an array"))

# pressure
t("pressure needs title", lambda: expect_err(lambda L: L["pressure"][0].pop("title"), "pressure 1: title is required"))
t("pressure needs limit", lambda: expect_err(lambda L: L["pressure"][0].pop("limit"), "pressure 1: limit is required"))
t("pressure node must exist", lambda: expect_err(lambda L: L["pressure"][0].update(node="ghost"), "pressure 'pool': unknown node 'ghost'"))
t("pressure severity must be high|medium|low", lambda: expect_err(lambda L: L["pressure"][0].update(severity="huge"), "pressure 'pool': severity must be high|medium|low"))
t("pressure confidence must be known", lambda: expect_err(lambda L: L["pressure"][0].update(confidence="sure"), "pressure 'pool': bad confidence"))
t("pressure must be a list", lambda: expect_err(lambda L: L.update(pressure="lots"), "pressure must be an array"))

# decisions
t("decision context must be a string", lambda: expect_err(lambda L: L["decisions"][0].update(context=["a"]), "decision 'd': context must be a string"))
t("decision consequences must be a string", lambda: expect_err(lambda L: L["decisions"][0].update(consequences=5), "decision 'd': consequences must be a string"))

# scenes
t("node scene with unknown name is an error", lambda: expect_err(
    lambda L: L["nodes"][0].update(scene={"name": "explode", "caption": "x"}), f"node api: scene name 'explode' is not one of {SCENE_LIST}"))
t("step scene with unknown name is an error", lambda: expect_err(
    lambda L: L["traces"][0]["steps"][0].update(scene={"name": "zap", "caption": "x"}), f"trace 1 step 1: scene name 'zap' is not one of {SCENE_LIST}"))
t("whatif scene with unknown name is an error", lambda: expect_err(
    lambda L: L["whatifs"][0].update(scene={"name": "zap", "caption": "x"}), f"whatif 'w': scene name 'zap' is not one of {SCENE_LIST}"))
t("decision scene with unknown name is an error", lambda: expect_err(
    lambda L: L["decisions"][0].update(scene={"name": "zap", "caption": "x"}), f"decision 'd': scene name 'zap' is not one of {SCENE_LIST}"))
t("risk scene with unknown name is an error", lambda: expect_err(
    lambda L: L["risks"][0].update(scene={"name": "zap", "caption": "x"}), f"risk 'r': scene name 'zap' is not one of {SCENE_LIST}"))
t("pressure scene with unknown name is an error", lambda: expect_err(
    lambda L: L["pressure"][0].update(scene={"name": "zap", "caption": "x"}), f"pressure 'pool': scene name 'zap' is not one of {SCENE_LIST}"))
t("invariant scene with unknown name is an error", lambda: expect_err(
    lambda L: L["invariants"][0].update(scene={"name": "zap", "caption": "x"}), f"invariant 1: scene name 'zap' is not one of {SCENE_LIST}"))
t("scene must be an object", lambda: expect_err(lambda L: L["nodes"][0].update(scene="gate"), "node api: scene must be an object with name and caption"))
t("scene caption over 60 chars is an error", lambda: expect_err(
    lambda L: L["nodes"][0].update(scene={"name": "gate", "caption": "x" * 61}), "node api: scene caption is 61 chars; max 60"))
t("scene caption of exactly 60 chars is fine", lambda: eq(mutated(lambda L: L["nodes"][0].update(scene={"name": "gate", "caption": "x" * 60}))[0], []))
t("scene caption must be a string", lambda: expect_err(
    lambda L: L["nodes"][0].update(scene={"name": "gate", "caption": 4}), "node api: scene caption must be a string"))


# scene slots: items (things handled) and props (labelled places), node.prop (the component's icon)
KNOWN = {"database", "server", "camera", "db", "cam"}


def with_props(fn):
    """Run fn with the prop library pinned to KNOWN, whatever parts/props.js currently says."""
    old = build.known_props
    build.known_props = lambda: KNOWN
    try:
        fn()
    finally:
        build.known_props = old


def scene_with(**slots):
    return {"name": "carry", "caption": "x", **slots}


def slot_err(slots, msg):
    t("scene slots: " + msg, lambda: with_props(lambda: expect_err(lambda L: L["nodes"][0].update(scene=scene_with(**slots)), "node api: " + msg)))


def slot_warn(update, msg):
    t("scene slots: warns " + msg, lambda: with_props(lambda: eq(mutated(lambda L: L["nodes"][0].update(update)), ([], [msg]))))


slot_err({"items": "packet"}, "scene items must be an array")
slot_err({"items": ["a", "b", "c", "d", "e"]}, "scene items has 5 entries; max 4")
slot_err({"items": ["ok", 3]}, "scene items 2: must be a non-empty string")
slot_err({"items": ["ok", "  "]}, "scene items 2: must be a non-empty string")
slot_err({"props": {"prop": "camera"}}, "scene props must be an array")
slot_err({"props": [{"prop": "camera", "label": "a"}] * 4}, "scene props has 4 entries; max 3")
slot_err({"props": ["camera"]}, "scene props 1: must be an object with prop and label")
slot_err({"props": [{"prop": 7, "label": "x"}]}, "scene props 1: prop must be a string")
slot_err({"props": [{"prop": ["camera"], "label": "x"}]}, "scene props 1: prop must be a string")
slot_err({"props": [{"prop": "camera", "label": 7}]}, "scene props 1: label must be a string")
slot_warn({"scene": scene_with(items=["x" * 19])}, "node api: scene items 1 is 19 chars; max 18 so it fits the picture")
slot_warn({"scene": scene_with(props=[{"prop": "camera", "label": "y" * 19}])}, "node api: scene props 1 label is 19 chars; max 18 so it fits the picture")
slot_warn({"scene": scene_with(props=[{"prop": "jetpack", "label": "x"}])}, "node api: scene props 1: prop 'jetpack' is not in the prop library; a generic box is drawn")
slot_warn({"prop": "jetpack"}, "node api: prop 'jetpack' is not in the prop library; a generic box is drawn")
FULL = scene_with(items=["x" * 18] * 4, props=[{"prop": "cam", "label": "z" * 18}, {"prop": "db", "label": "d"}, {"prop": "server", "label": "s"}])
t("scene slots: 4 items of exactly 18 chars, 3 props, a label of exactly 18 chars and aliases are clean", lambda: with_props(lambda: eq(
    mutated(lambda L: L["nodes"][0].update(scene=FULL)), ([], []))))
t("scene slots: a props entry without a label is allowed (icon only)", lambda: with_props(lambda: eq(
    mutated(lambda L: L["nodes"][0].update(scene=scene_with(props=[{"prop": "camera"}]))), ([], []))))
t("node.prop: a known name, case as written, validates clean", lambda: with_props(lambda: eq(mutated(lambda L: L["nodes"][1].update(prop="database")), ([], []))))
t("node.prop: the library trims and lower-cases, so ' Database ' is known", lambda: with_props(lambda: eq(mutated(lambda L: L["nodes"][1].update(prop=" Database ")), ([], []))))
t("node.prop: must be a string", lambda: expect_err(lambda L: L["nodes"][0].update(prop=["db"]), "node api: prop must be a string"))
t("slots are checked on a step, a whatif, a decision, a risk, a pressure point and an invariant too", lambda: with_props(lambda: eq(
    [mutated(lambda L, f=f: f(L).update(scene=scene_with(items=["a"] * 5)))[0] for f in (
        lambda L: L["traces"][0]["steps"][0], lambda L: L["whatifs"][0], lambda L: L["decisions"][0],
        lambda L: L["risks"][0], lambda L: L["pressure"][0], lambda L: L["invariants"][0])],
    [["trace 1 step 1: scene items has 5 entries; max 4"], ["whatif 'w': scene items has 5 entries; max 4"],
     ["decision 'd': scene items has 5 entries; max 4"], ["risk 'r': scene items has 5 entries; max 4"],
     ["pressure 'pool': scene items has 5 entries; max 4"], ["invariant 1: scene items has 5 entries; max 4"]])))


def known_props_parses_the_library():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "props.js").write_text("const LensProps = (() => {\n  const names = ['camera', 'phone',\n 'mic'];\n  return { names, alias: { db: 'database', 'cam': 'camera' }, resolve() {} };\n})();\n")
        eq(build.props_in(Path(d) / "props.js"), {"camera", "phone", "mic", "db", "cam"})
        (Path(d) / "props.js").write_text("const LensProps = { names: ['a', \"b\"], alias: {x: 'a'}, resolve(n) { return n; } };")
        eq(build.props_in(Path(d) / "props.js"), {"a", "b", "x"})
        eq(build.props_in(Path(d) / "missing.js"), set())
        (Path(d) / "props.js").write_text("// nothing declarative here\nconst LensProps = makeIt();")
        eq(build.props_in(Path(d) / "props.js"), set())


t("known_props reads canonical names and aliases from props.js, and an unreadable library means no check", known_props_parses_the_library)


def real_library_names_are_accepted():
    names = build.known_props()
    if not names:
        print("  (no parts/props.js, or it declares no names yet: skipped)"); return
    for n in ("camera", "database", "server", "chip"):
        if n not in names:
            raise AssertionError(f"{n!r} missing from the parsed library {sorted(names)}")


t("the real props.js, when present, parses to a library containing the contract names", real_library_names_are_accepted)


def missing_caption_warns():
    errs, warns = mutated(lambda L: L["nodes"][0].update(scene={"name": "gate"}))
    eq(errs, [])
    eq(warns, ["node api: scene has no caption"])


t("scene without caption warns but does not fail", missing_caption_warns)


# warnings
def arch_without_trace():
    errs, warns = mutated(lambda L: L.pop("traces"))
    eq(errs, [])
    eq(warns, ["architecture mode has no traces; add 1-3 flows"])


t("architecture mode without traces warns", arch_without_trace)


def code_without_trace_is_quiet():
    L = copy.deepcopy(GOOD); L["mode"] = "code"; L.pop("traces")
    eq(build.validate(L), ([], []))


t("code mode without traces does not warn", code_without_trace_is_quiet)


def protocol_warning():
    def add_edges(L):
        L["nodes"].append({"id": "q", "label": "Q", "simple": "s"})
        L["edges"].append({"from": "api", "to": "q"})
        L["edges"].append({"from": "q", "to": "db"})
    errs, warns = mutated(add_edges)
    eq(errs, [])
    eq(warns, ["architecture mode: 2 of 3 edges have no protocol"])


t("more than half of edges missing protocol warns in architecture mode", protocol_warning)


def half_is_not_more_than_half():
    def add_edge(L):
        L["edges"].append({"from": "db", "to": "api"})
    eq(mutated(add_edge), ([], []))


t("exactly half of edges missing protocol does not warn", half_is_not_more_than_half)

# F1: validate() reports bad shapes as errors and never raises
def never_raises(name, fn, expect_substr):
    def run():
        errs, _ = mutated(fn)
        if not any(expect_substr in e for e in errs):
            raise AssertionError(f"expected an ERROR containing {expect_substr!r}, got {errs}")
    t(f"validate() reports {name} as an ERROR instead of raising", run)


never_raises("invariants[0].node being a list", lambda L: L["invariants"][0].update(node=["db"]), "invariant 1: unknown node ['db']")
never_raises("a string item in invariants", lambda L: L["invariants"].append("oops"), "invariant 2: must be an object")
never_raises("a string item in edges", lambda L: L["edges"].append("a->b"), "edge 2: must be an object")
never_raises("a string item in nodes", lambda L: L["nodes"].append("db"), "node 3: must be an object")
never_raises("a string item in steps", lambda L: L["traces"][0]["steps"].append("x"), "trace 1: step 3: must be an object")
never_raises("a string item in traces", lambda L: L["traces"].append("x"), "trace 2: must be an object")
never_raises("edges: 5", lambda L: L.update(edges=5), "edges must be an array")
never_raises("nodes: null", lambda L: L.update(nodes=None), "nodes must be an array")
never_raises("an edge missing from", lambda L: L["edges"][0].pop("from"), "edge references unknown node")
never_raises("an edge missing to", lambda L: L["edges"][0].pop("to"), "edge references unknown node")
never_raises("an edge whose from is a list", lambda L: L["edges"][0].update({"from": ["api"]}), "edge references unknown node")
never_raises("a step missing node", lambda L: L["traces"][0]["steps"][1].pop("node"), "trace 1 step 2: unknown node None")
never_raises("a step whose node is a list", lambda L: L["traces"][0]["steps"][1].update(node=["db"]), "trace 1 step 2: unknown node ['db']")
never_raises("steps: 'abc'", lambda L: L["traces"][0].update(steps="abc"), "trace 1: steps must be an array")
never_raises("a node missing id", lambda L: L["nodes"][1].pop("id"), "node needs id and label")
never_raises("a node whose id is a list", lambda L: L["nodes"][1].update(id=["db"]), "node needs id and label")
never_raises("a list confidence", lambda L: L["nodes"][0].update(confidence=["x"]), "node api bad confidence")
never_raises("a list severity on a risk", lambda L: L["risks"][0].update(severity=["x"]), "risk 'r' severity must be high|medium|low")
never_raises("a list severity on pressure", lambda L: L["pressure"][0].update(severity=["x"]), "pressure 'pool': severity must be high|medium|low")
never_raises("a non-list functions", lambda L: L["nodes"][0].update(functions="f"), "node api: functions must be an array")
never_raises("a function missing its node id", lambda L: (L["nodes"][1].pop("id"), L["nodes"][1].update(functions=[{"code": {"src": "x"}}])), "needs name")
never_raises("code that is a string", lambda L: L["traces"][0]["steps"][0].update(code="x = 1"), "trace 1 step 1: code needs src")
never_raises("code.src that is a number", lambda L: L["traces"][0]["steps"][0].update(code={"src": 5}), "trace 1 step 1: code needs src")
never_raises("code.notes with a non-numeric key", lambda L: L["traces"][0]["steps"][0].update(code={"src": "x", "notes": {"a": "b"}}), "notes must be an object keyed by line number")
never_raises("code.notes as a list", lambda L: L["traces"][0]["steps"][0].update(code={"src": "x", "notes": ["b"]}), "notes must be an object keyed by line number")
never_raises("code.highlight that is not a list", lambda L: L["traces"][0]["steps"][0].update(code={"src": "x", "highlight": 1}), "highlight must be a list of integers")
never_raises("predict that is a string", lambda L: L["traces"][0]["steps"][0].update(predict="why?"), "trace 1 step 1: must be an object")
never_raises("predict options that are not strings", lambda L: L["traces"][0]["steps"][0].update(predict={"options": [1, 2], "answer": 0, "why": "w"}), "trace 1 step 1: needs 2-5 options")
never_raises("quiz options as a string", lambda L: L.update(quiz=[{"q": "q?", "options": "abc", "answer": 0, "why": "w"}]), "quiz 1: needs 2-5 options")
never_raises("whatif affects that is a string", lambda L: L["whatifs"][0].update(affects="db"), "whatif 'w': affects must be an array")
never_raises("whatif affects holding a list", lambda L: L["whatifs"][0].update(affects=[["db"]]), "whatif 'w' references unknown node ['db']")
never_raises("a layer that is a string", lambda L: L.update(layers=["x"]), "layer 1: must be an object")
never_raises("layers with list ids and a list node layer", lambda L: (L.update(layers=[{"id": ["a"]}, {"id": "l"}]), L["nodes"][0].update(layer=["l"])), "node api has unknown layer ['l']")
never_raises("a list rule", lambda L: L["invariants"][0].update(rule=["x"]), "invariant 1: rule must be a string")


def lesson_not_object():
    eq(build.validate([1, 2]), (["the lesson must be a JSON object"], []))


t("validate() of a JSON array is an ERROR, not a crash", lesson_not_object)


# scene.draw: a bespoke picture from a list of ops on a 16 x 9 grid (see build.py DRAW_FIELDS)
OPS = sorted(build.DRAW_FIELDS)


def with_ops(fn, ops=None):
    """Run fn with the op list pinned (default: build.py's own table), whatever parts/scenes.js currently declares; the prop library too."""
    old = build.known_draw_ops
    build.known_draw_ops = lambda: set(OPS if ops is None else ops)
    try:
        with_props(fn)
    finally:
        build.known_draw_ops = old


def drawn(draw, **extra):
    return {"caption": "x", "draw": draw, **extra}


def draw_result(draw, **extra):
    out = []
    with_ops(lambda: out.append(mutated(lambda L: L["nodes"][0].update(scene=drawn(draw, **extra)))))
    return out[0]


def draw_err(name, draw, msg):
    t("scene draw: error " + name, lambda: eq(draw_result(draw), ([f"node api: {msg}"], [])))


def draw_warn(name, draw, msg):
    t("scene draw: warns " + name, lambda: eq(draw_result(draw), ([], [f"node api: {msg}"])))


OK_DRAW = [{"op": "blot", "x": 3, "y": 5, "mood": "worried", "id": "b"}, {"op": "box", "x": 6, "y": 3, "w": 4, "h": 2, "label": "queue", "id": "q"},
           {"op": "arrow", "from": "b", "to": "q", "label": "sends", "bend": -0.4}, {"op": "arrow", "from": [1, 1], "to": "q"},
           {"op": "line", "pts": [[0, 8], [16, 8]], "w": 2}, {"op": "text", "x": 8, "y": 1, "t": "a note", "rot": -5}]
t("scene draw: a valid draw scene with no name validates clean", lambda: eq(draw_result(OK_DRAW), ([], [])))
t("scene draw: a name plus a valid draw validates clean", lambda: eq(draw_result(OK_DRAW, name="gate"), ([], [])))
t("scene draw: the name is still validated when draw is present", lambda: eq(draw_result(OK_DRAW, name="zap"), ([f"node api: scene name 'zap' is not one of {SCENE_LIST}"], [])))
t("scene draw: without draw the name is still required", lambda: expect_err(
    lambda L: L["nodes"][0].update(scene={"caption": "x"}), f"node api: scene name None is not one of {SCENE_LIST}"))
t("scene draw: the caption limit and type still apply to a drawn scene", lambda: eq(draw_result(OK_DRAW, caption="x" * 61), (["node api: scene caption is 61 chars; max 60"], [])))
draw_err("not a list", {"op": "blot"}, "scene draw must be an array of ops")
draw_err("empty list", [], "scene draw is empty; give 1 to 40 ops")
draw_err("41 ops", [{"op": "ground", "y": 8}] * 41, "scene draw has 41 ops; max 40")
t("scene draw: exactly 40 ops is fine", lambda: eq(draw_result([{"op": "ground", "y": 8}] * 40), ([], [])))
draw_err("op is not an object", [{"op": "ground", "y": 8}, "blot"], 'draw op 2: must be an object, got "blot"')
draw_err("unknown op", [{"op": "zork", "x": 1}], "draw op 1: unknown op 'zork'; valid ops: " + ", ".join(OPS))
draw_err("op name missing", [{"x": 1}], "draw op 1: unknown op None; valid ops: " + ", ".join(OPS))
draw_err("op name not a string", [{"op": ["blot"]}], "draw op 1: unknown op ['blot']")
draw_err("a required field is missing", [{"op": "box", "x": 1, "y": 1, "w": 2}], "draw op 1 (box): h is required")
draw_err("x is a string", [{"op": "blot", "x": "3", "y": 3}], "draw op 1 (blot): x must be a number")
draw_err("a bool is not a number", [{"op": "blot", "x": True, "y": 3}], "draw op 1 (blot): x must be a number")
draw_err("label is a number", [{"op": "box", "x": 1, "y": 1, "w": 2, "h": 2, "label": 4}], "draw op 1 (box): label must be a string")
draw_err("dash is not a bool", [{"op": "line", "pts": [[0, 0], [1, 1]], "dash": 1}], "draw op 1 (line): dash must be true or false")
draw_err("line with one point", [{"op": "line", "pts": [[0, 0]]}], "draw op 1 (line): pts must be 2 to 8 [x, y] pairs")
draw_err("line with nine points", [{"op": "line", "pts": [[i, i] for i in range(9)]}], "draw op 1 (line): pts must be 2 to 8 [x, y] pairs")
draw_err("line point is a string", [{"op": "line", "pts": [[0, 0], ["a", 1]]}], "draw op 1 (line): pts must be 2 to 8 [x, y] pairs")
draw_err("arrow endpoint is neither id nor point", [{"op": "arrow", "from": [1], "to": [2, 2]}], "draw op 1 (arrow): from must be an object id or an [x, y] pair")
draw_err("blot arms are not two points", [{"op": "blot", "x": 1, "y": 1, "arms": [[1, 1]]}], "draw op 1 (blot): arms must be two [x, y] pairs")
t("scene draw: a gate takes h (post height) and len (arm length) as numbers", lambda: eq(
    [draw_result([{"op": "gate", "x": 8, "y": 7, "h": 3, "len": 4, "open": True}]), draw_result([{"op": "gate", "x": 8, "y": 7, "len": "long"}])],
    [([], []), (["node api: draw op 1 (gate): len must be a number"], [])]))
t("scene draw: blot look is an offset, not a grid point: [-0.3, 0] and [1.5, -2] are clean", lambda: eq(
    [draw_result([{"op": "blot", "x": 3, "y": 3, "look": lk}]) for lk in ([-0.3, 0], [1.5, -2], [0, 0])], [([], [])] * 3))
draw_warn("blot look far beyond an offset", [{"op": "blot", "x": 3, "y": 3, "look": [5, 0]}], "draw op 1 (blot): look [5, 0] is a small offset (about -2 to 2); it is clamped")
draw_err("blot look is a string", [{"op": "blot", "x": 3, "y": 3, "look": "x"}], "draw op 1 (blot): look must be an [dx, dy] pair of numbers")
draw_err("blot look has three numbers", [{"op": "blot", "x": 3, "y": 3, "look": [0, 0, 1]}], "draw op 1 (blot): look must be an [dx, dy] pair of numbers")
t("scene draw: tilt, rot, dir, bend, len, s and size are never range-checked as grid coordinates", lambda: eq(draw_result([
    {"op": "blot", "x": 3, "y": 3, "s": 20, "tilt": -30}, {"op": "packet", "x": 3, "y": 3, "label": "a", "tilt": 99}, {"op": "text", "x": 3, "y": 3, "t": "a", "rot": 200},
    {"op": "ticks", "x": 8, "y": 3, "dir": -50, "len": 40}, {"op": "arrow", "from": [1, 1], "to": [5, 5], "bend": 12}, {"op": "prop", "name": "server", "x": 3, "y": 3, "size": 30},
    {"op": "gate", "x": 8, "y": 7, "len": 60, "h": 30}, {"op": "flame", "x": 3, "y": 3, "s": 50}]), ([], [])))
draw_err("duplicate ids", [{"op": "blot", "x": 1, "y": 1, "id": "a"}, {"op": "box", "x": 4, "y": 1, "w": 2, "h": 2, "id": "a"}], "draw op 2 (box): duplicate id 'a'")
draw_err("id is a number", [{"op": "blot", "x": 1, "y": 1, "id": 7}], "draw op 1 (blot): id must be a string")
draw_warn("label over 18 chars", [{"op": "box", "x": 1, "y": 1, "w": 2, "h": 2, "label": "L" * 19}], "draw op 1 (box): label is 19 chars; max 18 so it is shown whole")
t("scene draw: a label of exactly 18 chars is clean", lambda: eq(draw_result([{"op": "box", "x": 1, "y": 1, "w": 2, "h": 2, "label": "L" * 18}]), ([], [])))
draw_warn("t over 40 chars", [{"op": "text", "x": 1, "y": 1, "t": "t" * 41}], "draw op 1 (text): t is 41 chars; max 40")
t("scene draw: a text of exactly 40 chars is clean", lambda: eq(draw_result([{"op": "text", "x": 1, "y": 1, "t": "t" * 40}]), ([], [])))
draw_warn("x past the grid", [{"op": "blot", "x": 17, "y": 3}], "draw op 1 (blot): x 17 is outside the 0..16 grid; it is clamped")
draw_warn("negative y", [{"op": "blot", "x": 3, "y": -0.5}], "draw op 1 (blot): y -0.5 is outside the 0..9 grid; it is clamped")
draw_warn("y past the grid", [{"op": "ground", "y": 9.5}], "draw op 1 (ground): y 9.5 is outside the 0..9 grid; it is clamped")
draw_warn("a line point outside the grid", [{"op": "line", "pts": [[0, 0], [16, 12]]}], "draw op 1 (line): pts has a point outside the 16 x 9 grid; it is clamped")
t("scene draw: the grid edges 0 and 16 / 9 are inside", lambda: eq(draw_result([{"op": "line", "pts": [[0, 0], [16, 9]]}, {"op": "blot", "x": 16, "y": 9}]), ([], [])))
draw_warn("arrow to an unknown id", [{"op": "blot", "x": 1, "y": 1, "id": "b"}, {"op": "arrow", "from": "b", "to": "ghost"}],
          "draw op 2 (arrow): to 'ghost' is not the id of any object in this picture; the arrow is skipped")
t("scene draw: an arrow may name an id drawn later", lambda: eq(draw_result([{"op": "arrow", "from": "a", "to": "b"}, {"op": "blot", "x": 1, "y": 1, "id": "a"}, {"op": "blot", "x": 5, "y": 1, "id": "b"}]), ([], [])))
draw_warn("four blots", [{"op": "blot", "x": i * 3 + 1, "y": 5} for i in range(4)], "scene draw has 4 blots; 3 or fewer keeps the picture readable")
draw_warn("unknown prop name", [{"op": "prop", "name": "jetpack", "x": 3, "y": 3}], "draw op 1 (prop): prop 'jetpack' is not in the prop library; a generic box is drawn")
draw_warn("colour outside the four", [{"op": "packet", "x": 3, "y": 3, "label": "a", "c": "green"}], "draw op 1 (packet): c 'green' is not one of ink, red, orange, blue; the default is used")
draw_warn("mood outside the four", [{"op": "blot", "x": 3, "y": 3, "mood": "sad"}], "draw op 1 (blot): mood 'sad' is not one of blank, worried, proud, happy; the default is used")
draw_warn("a badly formed id", [{"op": "blot", "x": 3, "y": 3, "id": "Big Blot"}], "draw op 1 (blot): id 'Big Blot' should be 1 to 20 chars of a-z, 0-9, _ or -")
t("scene draw: unknown extra fields are ignored", lambda: eq(draw_result([{"op": "blot", "x": 3, "y": 3, "colour": "pink", "z": 9}]), ([], [])))
t("scene draw: JSON null for an optional field means absent", lambda: eq(draw_result([{"op": "blot", "x": 3, "y": 3, "mood": None, "id": None}]), ([], [])))
t("scene draw: NaN and Infinity (accepted by Python's json) are not numbers", lambda: eq(draw_result([{"op": "blot", "x": float("nan"), "y": float("inf")}]),
    (["node api: draw op 1 (blot): x must be a number", "node api: draw op 1 (blot): y must be a number"], [])))
t("scene draw: the same checks run on a step, a whatif, a decision, a risk, a pressure point and an invariant", lambda: with_ops(lambda: eq(
    [mutated(lambda L, f=f: f(L).update(scene=drawn([{"op": "zork"}])))[0][0].split(":")[0] for f in (
        lambda L: L["traces"][0]["steps"][0], lambda L: L["whatifs"][0], lambda L: L["decisions"][0],
        lambda L: L["risks"][0], lambda L: L["pressure"][0], lambda L: L["invariants"][0])],
    ["trace 1 step 1", "whatif 'w'", "decision 'd'", "risk 'r'", "pressure 'pool'", "invariant 1"])))


def draw_ops_text_is_read():
    with tempfile.TemporaryDirectory() as d:
        sc = Path(d) / "scenes.js"
        sc.write_text("const LensScenes = (() => {\n  const NAMES = ['carry'];\n  return { names: NAMES, drawOps: ['blot', 'box',\n 'zork-9'], render };\n})();\n")
        eq(build.draw_ops_in(sc), {"blot", "box", "zork-9"})
        sc.write_text("const LensScenes = { names: ['carry'], render() {} };")
        eq(build.draw_ops_in(sc), set())
        eq(build.draw_ops_in(Path(d) / "missing.js"), set())


t("draw_ops_in reads the drawOps literal as text; absent or missing gives an empty set", draw_ops_text_is_read)


def unknown_op_check_follows_scenes_js():
    old, out = build.known_draw_ops, {}
    try:
        build.known_draw_ops = lambda: {"blot"}
        out["narrow"] = mutated(lambda L: L["nodes"][0].update(scene=drawn([{"op": "ground", "y": 8}])))[0]
        build.known_draw_ops = lambda: set()
        out["none"] = mutated(lambda L: L["nodes"][0].update(scene=drawn([{"op": "ground", "y": 8}, {"op": "zork"}])))[0]
    finally:
        build.known_draw_ops = old
    eq(out["narrow"][0].startswith("node api: draw op 1: unknown op 'ground'; valid ops: blot"), True, out["narrow"])
    # with no declared list, only the table in build.py is the reference
    eq(len(out["none"]), 1, out["none"])
    eq(out["none"][0].startswith("node api: draw op 2: unknown op 'zork'"), True, out["none"])


t("unknown-op check uses the drawOps declared in scenes.js, and build.py's own table when none is declared", unknown_op_check_follows_scenes_js)


def scenes_js_declares_every_validated_op():
    declared = build.draw_ops_in(build.PARTS / "scenes.js")
    if not declared:
        print("skip: parts/scenes.js declares no drawOps yet"); return
    eq(sorted(set(build.DRAW_FIELDS) - declared), [], "ops validated by build.py but not drawn by scenes.js")
    eq(sorted(declared - set(build.DRAW_FIELDS)), [], "ops drawn by scenes.js that build.py cannot check the fields of")


t("build.py DRAW_FIELDS and scenes.js drawOps list exactly the same ops (the two cannot drift)", scenes_js_declares_every_validated_op)


def draw_fixture_is_clean():
    L = json.loads((HERE / "testdata" / "arch-draw.json").read_text())
    eq(build.validate(L), ([], []))


t("testdata/arch-draw.json (draw in node, step, whatif and risk) validates clean", draw_fixture_is_clean)


def zine_ignores_draw():
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "z.html"
        r = subprocess.run([sys.executable, str(HERE / "build.py"), str(HERE / "testdata" / "arch-draw.json"), str(out), "--theme", "zine"], capture_output=True, text=True)
        eq(r.returncode, 0, r.stdout + r.stderr)
        eq("LensScenes" in out.read_text(), False, "zine pulled in the scene library")


t("a lesson with draw scenes builds in the zine theme", zine_ignores_draw)


def bad_draw_stops_the_build():
    with tempfile.TemporaryDirectory() as d:
        L = json.loads((HERE / "testdata" / "arch-draw.json").read_text())
        L["nodes"][1]["scene"]["draw"][0] = {"op": "blot", "x": "far", "y": 1}
        src, out = Path(d) / "l.json", Path(d) / "o.html"
        src.write_text(json.dumps(L))
        r = subprocess.run([sys.executable, str(HERE / "build.py"), str(src), str(out), "--theme", "sketch"], capture_output=True, text=True)
        eq(r.returncode != 0 and "x must be a number" in r.stdout + r.stderr and not out.exists(), True, r.stdout + r.stderr)


t("a draw error stops the build before any file is written", bad_draw_stops_the_build)


def fuzz_never_raises():
    # Replace every value in a rich lesson, one at a time, with each of several wrong types; validate must always return.
    junk = [None, 5, True, "s", [], ["x"], {}, {"a": 1}, [[]], [{}]]
    L0 = json.loads((HERE.parent / "examples" / "jw-ask-flow.json").read_text())
    paths = []

    def walk(o, path):
        paths.append(path)
        for k, v in (o.items() if isinstance(o, dict) else enumerate(o) if isinstance(o, list) else ()):
            walk(v, path + (k,))
    for base in (L0, GOOD, json.loads((HERE / "testdata" / "arch-draw.json").read_text())):
        paths.clear(); walk(base, ())
        for path in list(paths):
            for j in junk:
                L = copy.deepcopy(base)
                if path:
                    cur = L
                    for k in path[:-1]:
                        cur = cur[k]
                    cur[path[-1]] = j
                else:
                    L = j
                try:
                    build.validate(L)
                except Exception as e:
                    raise AssertionError(f"validate raised {type(e).__name__}: {e} for {path} = {j!r}")


t("validate() never raises when any single value of a real lesson is replaced by a wrong type", fuzz_never_raises)


def quiz_q_required():
    def add(L):
        L["quiz"] = [{"q": "", "options": ["aa", "bb"], "answer": 0, "why": "w"}, {"options": ["aa", "bb"], "answer": 1, "why": "w"},
                     {"q": "  ", "options": ["aa", "bb"], "answer": 1, "why": "w"}]
    errs, _ = mutated(add)
    eq(errs, ["quiz 1: q (the question) is required", "quiz 2: q (the question) is required", "quiz 3: q (the question) is required"])


t("quiz item with a missing, empty or blank q is an ERROR", quiz_q_required)


def dup_edge_warns():
    errs, warns = mutated(lambda L: L["edges"].append({"from": "api", "to": "db", "protocol": "SQL"}))
    eq(errs, [])
    eq(warns, ["edge api->db appears more than once; merge the duplicates into one edge"])


t("two edges with the same from and to warn", dup_edge_warns)


def reciprocal_edge_is_not_a_duplicate():
    eq(mutated(lambda L: L["edges"].append({"from": "db", "to": "api", "protocol": "SQL"})), ([], []))


t("a reverse edge db->api is not reported as a duplicate", reciprocal_edge_is_not_a_duplicate)


def self_loop_warns():
    errs, warns = mutated(lambda L: L["edges"].append({"from": "db", "to": "db", "protocol": "SQL"}))
    eq(errs, [])
    eq(warns, ["edge db->db is a self-loop; show it as text on the node instead"])


t("a self-loop edge warns", self_loop_warns)


def warns_are_one_based():
    def jump(L):
        L["nodes"].append({"id": "q", "label": "Q", "simple": "s"})
        L["traces"].append({"title": "second", "steps": [{"node": "api", "title": "a", "simple": "s"}, {"node": "q", "title": "b", "simple": "s"}]})
    errs, warns = mutated(jump)
    eq(errs, [])
    eq(warns, ["trace 2 step 2: no edge between api and q; the map will show a jump"])


t("trace and step numbers in a warning are both 1-based", warns_are_one_based)
t("trace without title is reported as trace 1, not trace 0", lambda: expect_err(lambda L: L["traces"][0].pop("title"), "trace 1 needs title and steps"))

# invariants[].evidence and rule length
t("invariant evidence must be a string", lambda: expect_err(lambda L: L["invariants"][0].update(evidence=["test_x"]), "invariant 1: evidence must be a string"))
t("invariant evidence as a string is valid", lambda: eq(mutated(lambda L: L["invariants"][0].update(evidence="tests/test_x.py::test_one_writer"))[0:2], ([], [])))


def long_rule_warns():
    errs, warns = mutated(lambda L: L["invariants"][0].update(rule="x" * 121))
    eq(errs, [])
    eq(warns, ["invariant 1: rule is 121 chars; keep it to one sentence of 120 or fewer and put detail in breaks/evidence"])


t("invariant rule over 120 chars warns", long_rule_warns)
t("invariant rule of exactly 120 chars does not warn", lambda: eq(mutated(lambda L: L["invariants"][0].update(rule="x" * 120)), ([], [])))

# jw-ask-flow example still validates cleanly
EXAMPLE = HERE.parent / "examples" / "jw-ask-flow.json"
t("examples/jw-ask-flow.json has zero validation errors", lambda: eq(build.validate(json.loads(EXAMPLE.read_text()))[0], []))

# include mechanism
tmp = Path(tempfile.mkdtemp(prefix="lens-build-"))
parts = tmp / "parts"
parts.mkdir()
(parts / "scenes.js").write_text("const LensScenes = { names: ['a'] };\nconst x = '\\n' + \"</script>\" + '$1';\n")


def include_replaces_line():
    tpl = "<head>\n<script>\n<!-- lens:include scenes.js -->\n</script>\n__TITLE__\n"
    out = build.apply_includes(tpl, parts)
    eq(out, "<head>\n<script>\nconst LensScenes = { names: ['a'] };\nconst x = '\\n' + \"</script>\" + '$1';\n\n</script>\n__TITLE__\n")


t("include line is replaced verbatim by the part, with no regex or escape processing", include_replaces_line)
t("template without include lines is returned unchanged", lambda: eq(build.apply_includes("a\n<!-- lens:include x -->  trailing\n", parts), "a\n<!-- lens:include x -->  trailing\n"))


def missing_part_exits():
    try:
        build.apply_includes("<!-- lens:include nope.js -->\n", parts)
    except SystemExit as e:
        eq(str(e), f"ERROR: theme includes missing part 'nope.js' (expected {parts / 'nope.js'})")
        return
    raise AssertionError("no SystemExit")


t("missing part exits with a clear ERROR", missing_part_exits)


def placeholder_in_part_exits():
    (parts / "bad.js").write_text("var t = '__LESSON_JSON__';\n")
    try:
        build.apply_includes("<!-- lens:include bad.js -->\n", parts)
    except SystemExit as e:
        eq(str(e), "ERROR: part 'bad.js' contains the placeholder __LESSON_JSON__; parts must not")
        return
    raise AssertionError("no SystemExit")


t("a part containing a placeholder is an error", placeholder_in_part_exits)


def title_placeholder_in_part_exits():
    (parts / "bad2.js").write_text("// __TITLE__\n")
    try:
        build.apply_includes("<!-- lens:include bad2.js -->\n", parts)
    except SystemExit as e:
        eq(str(e), "ERROR: part 'bad2.js' contains the placeholder __TITLE__; parts must not")
        return
    raise AssertionError("no SystemExit")


t("a part containing __TITLE__ is an error", title_placeholder_in_part_exits)


def cli_includes_before_placeholders():
    # End to end through the CLI with a scratch LENS root: lesson text containing the include line must not be expanded.
    root = tmp / "lens"
    (root / "assets" / "themes" / "parts").mkdir(parents=True)
    (root / "scripts").mkdir()
    (root / "scripts" / "build.py").write_text((HERE / "build.py").read_text())
    (root / "assets" / "themes" / "parts" / "p.js").write_text("PART_BODY\n")
    (root / "assets" / "themes" / "mini.html").write_text("<title>__TITLE__</title>\n<!-- lens:include p.js -->\n<script>__LESSON_JSON__</script>\n")
    lesson = tmp / "l.json"
    lesson.write_text(json.dumps({"title": "A <b>", "nodes": [{"id": "a", "label": "A", "simple": "<!-- lens:include p.js -->"},
                                                              {"id": "b", "label": "B", "simple": "s"}]}))
    out = tmp / "out.html"
    r = subprocess.run([sys.executable, str(root / "scripts" / "build.py"), str(lesson), str(out), "--theme", "mini"], capture_output=True, text=True)
    eq(r.returncode, 0, r.stdout + r.stderr)
    eq(out.read_text(), '<title>A &lt;b&gt;</title>\nPART_BODY\n\n<script>{"title": "A <b>", "nodes": [{"id": "a", "label": "A", "simple": "\\u003c!-- lens:include p.js -->"}, {"id": "b", "label": "B", "simple": "s"}]}</script>\n')
    eq("invariants': 0, 'pressure': 0" in r.stdout, True, r.stdout)


t("CLI expands includes in the theme only, never in lesson text, and reports new counts", cli_includes_before_placeholders)


# F1: substitution and script-safety of the rendered page
def title_placeholder_cannot_inject_json():
    L = {"title": "Why __LESSON_JSON__ and __TITLE__ matter", "nodes": [{"id": "a", "label": "A", "simple": "s"}, {"id": "b", "label": "B", "simple": "s"}]}
    page = build.render("<title>__TITLE__</title>\n<script>__LESSON_JSON__</script>\n", L["title"], L)
    first = page.split("\n")[0]
    eq(first, "<title>Why __LESSON_JSON__ and __TITLE__ matter</title>")
    eq(page.count('"nodes"'), 1)


t("a title containing __LESSON_JSON__ or __TITLE__ stays literal text in <title>", title_placeholder_cannot_inject_json)


def lesson_text_placeholder_not_rescanned():
    L = {"title": "T", "nodes": [{"id": "a", "label": "A", "simple": "uses __TITLE__ here"}]}
    page = build.render("<title>__TITLE__</title><script>__LESSON_JSON__</script>", "T", L)
    eq(page, '<title>T</title><script>{"title": "T", "nodes": [{"id": "a", "label": "A", "simple": "uses __TITLE__ here"}]}</script>')


t("a placeholder inside the lesson JSON is not replaced by the title", lesson_text_placeholder_not_rescanned)


def comment_open_is_escaped_and_roundtrips():
    L = {"title": "T", "nodes": [{"id": "a", "label": "A", "simple": "x <!-- y </script> <SCRIPT src=z> \\<!-- end"}]}
    page = build.render("<script>__LESSON_JSON__</script>", "T", L)
    body = page[len("<script>"):-len("</script>")]
    for bad in ("<!--", "</", "<script", "<SCRIPT"):
        eq(bad in body, False, bad)
    eq(body, '{"title": "T", "nodes": [{"id": "a", "label": "A", "simple": "x \\u003c!-- y <\\/script> \\u003cSCRIPT src=z> \\\\\\u003c!-- end"}]}')
    eq(json.loads(body), L)


t("<!--, </ and <script in lesson text are escaped and JSON.parse gives the same lesson back", comment_open_is_escaped_and_roundtrips)


def cli_title_injection_end_to_end():
    root = tmp / "lens2"
    (root / "assets" / "themes").mkdir(parents=True)
    (root / "scripts").mkdir()
    (root / "scripts" / "build.py").write_text((HERE / "build.py").read_text())
    (root / "assets" / "themes" / "mini.html").write_text("<title>__TITLE__</title>\n<script>__LESSON_JSON__</script>\n")
    lesson = tmp / "l2.json"
    lesson.write_text(json.dumps({"title": "__LESSON_JSON__", "nodes": [{"id": "a", "label": "A", "simple": "s"}, {"id": "b", "label": "B", "simple": "s"}]}))
    out = tmp / "out2.html"
    r = subprocess.run([sys.executable, str(root / "scripts" / "build.py"), str(lesson), str(out), "--theme", "mini"], capture_output=True, text=True)
    eq(r.returncode, 0, r.stdout + r.stderr)
    eq(out.read_text().split("\n")[0], "<title>__LESSON_JSON__</title>")


t("CLI: a lesson titled __LESSON_JSON__ gets that literal title and valid JSON below", cli_title_injection_end_to_end)


# The real-browser proof: a lesson whose text holds `<!--` and `<script` still draws, in both themes.
def browser_check():
    node = subprocess.run(["which", "node"], capture_output=True, text=True).stdout.strip()
    if not node:
        print("skip real-browser <!-- <script> test: node not found"); return
    script = """
import { getChromium } from %s;
import fs from 'fs';
const pw = await getChromium();
if (!pw) { console.log('NOPW'); process.exit(0); }
const b = await pw.launch();
const out = [];
for (const file of process.argv.slice(1)) {
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('file://' + file); await p.waitForTimeout(600);
  const r = await p.evaluate(() => { try { return { nodes: document.querySelectorAll('.node').length, title: document.title,
    json: JSON.stringify(JSON.parse(document.getElementById('lesson').textContent)) }; } catch (e) { return { nodes: -1, title: document.title, json: String(e) }; } });
  out.push({ file, ...r, errs });
}
await b.close();
console.log(JSON.stringify(out));
""" % json.dumps(str(HERE / "pw.mjs"))
    lesson = {"title": "Comment <!-- <script> title", "nodes": [
        {"id": "a", "label": "A", "simple": "simple <!-- then <script> and </script> text"},
        {"id": "b", "label": "B", "simple": "second node", "deep": "<!-- <SCRIPT> deep"}],
        "edges": [{"from": "a", "to": "b"}],
        "traces": [{"title": "t", "steps": [{"node": "a", "title": "a <!-- <script>", "simple": "s"}, {"node": "b", "title": "b", "simple": "s"}]}]}
    lj = tmp / "browser.json"
    lj.write_text(json.dumps(lesson))
    files = []
    for theme in ("zine", "sketch"):
        f = tmp / f"browser-{theme}.html"
        r = subprocess.run([sys.executable, str(HERE / "build.py"), str(lj), str(f), "--theme", theme], capture_output=True, text=True)
        eq(r.returncode, 0, r.stdout + r.stderr)
        files.append(str(f))
    r = subprocess.run([node, "--input-type=module", "-e", script, *files], capture_output=True, text=True, timeout=120)
    if r.stdout.strip() == "NOPW":
        print("skip real-browser <!-- <script> test: Playwright not found"); return
    eq(r.returncode, 0, r.stderr)
    res = json.loads(r.stdout.strip().splitlines()[-1])
    for x in res:
        eq((x["nodes"], x["errs"], x["title"]), (2, [], "Comment <!-- <script> title"), x["file"])
        eq(x["json"], json.dumps(lesson, separators=(",", ":"), ensure_ascii=False), x["file"])


t("real browser, both themes: a lesson with <!-- and <script in its text still draws every node", browser_check)


# ---------- data sections ----------
DATA_FIX = json.loads((HERE / "testdata" / "data-mini.json").read_text())


def with_data(data):
    L = copy.deepcopy(DATA_FIX)
    L["data"] = data
    return L


def data_errs(data):
    return build.validate(with_data(data))[0]


def one_block(b):
    return [{"title": "S", "blocks": [b]}]


def has(errs, needle):
    if not any(needle in e for e in errs):
        raise AssertionError(f"no error containing {needle!r} in {errs}")


# breaks if check_data starts rejecting a valid block or the fixture drifts from the schema reference
t("data: the fixture with every block type validates with no errors and no warnings", lambda: eq(build.validate(DATA_FIX), ([], [])))
t("data: a lesson with no map and only data sections validates, without the map-size warning",
  lambda: eq(build.validate({"title": "T", "data": one_block({"type": "text", "text": "x"})}), ([], [])))
t("data: data must be an array of objects", lambda: has(build.validate({"title": "T", "data": {"a": 1}})[0], "data must be an array"))
t("data: a section needs a title and at least one block", lambda: (has(data_errs([{"blocks": [{"type": "text", "text": "x"}]}]), "title is required"), has(data_errs([{"title": "S", "blocks": []}]), "at least one block")))
t("data: 'at' is start or end", lambda: has(data_errs([{"title": "S", "at": "middle", "blocks": [{"type": "text", "text": "x"}]}]), "at must be"))
t("data: an unknown block type is an error naming the choices", lambda: has(data_errs(one_block({"type": "pie"})), "type must be one of"))
t("data: a table row with the wrong cell count is an error", lambda: has(data_errs(one_block({"type": "table", "columns": ["a", "b"], "rows": [["x"]]})), "has 1 cells for 2 columns"))
t("data: a table highlight index outside the rows is an error", lambda: has(data_errs(one_block({"type": "table", "columns": ["a"], "rows": [["x"]], "highlight": [3]})), "highlight"))
t("data: a bar value must be a number (a numeric string is rejected)", lambda: has(data_errs(one_block({"type": "bars", "rows": [{"label": "A", "value": "54.8"}]})), "value must be a number"))
t("data: a boolean is not a number", lambda: has(data_errs(one_block({"type": "bars", "rows": [{"label": "A", "value": True}]})), "value must be a number"))
t("data: max of 0 is rejected", lambda: has(data_errs(one_block({"type": "bars", "max": 0, "rows": [{"label": "A", "value": 1}]})), "max must be"))
t("data: a dumbbell row needs from and to", lambda: has(data_errs(one_block({"type": "dumbbell", "rows": [{"label": "A", "from": 1}]})), "to must be a number"))
t("data: a stack part value cannot be negative", lambda: has(data_errs(one_block({"type": "stack", "rows": [{"label": "A", "parts": [{"name": "x", "value": -1}]}]})), "value must be a number, 0 or more"))
t("data: a javascript: source url is an error", lambda: has(data_errs(one_block({"type": "sources", "items": [{"label": "x", "url": "javascript:alert(1)"}]})), "url must start with http"))
ABOVE_MAX = one_block({"type": "bars", "max": 50, "rows": [{"label": "A", "value": 60}]})
t("data: a value above max is a warning, not an error", lambda: (eq(data_errs(ABOVE_MAX), []), eq(any("above max" in w for w in build.validate(with_data(ABOVE_MAX))[1]), True)))


def data_browser_check():
    node = "node"
    script = """
import { getChromium } from %s;
const pw = await getChromium(); if (!pw) { console.log('NOPW'); process.exit(0); }
const b = await pw.launch(), out = [];
for (const f of process.argv.slice(1)) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } }); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + f); await p.waitForTimeout(300);
  out.push(await p.evaluate(() => ({
    secs: [...document.querySelectorAll('section.dsec')].map(s => s.id + ':' + s.hidden),
    rail: [...document.querySelectorAll('#rail .toc>li>a')].map(a => a.textContent.replace(/[0-9\\/]+$/, '')),
    firstIsData: document.querySelector('main section.sec').id,
    rows: document.querySelectorAll('.d-table tbody tr').length,
    barW: [...document.querySelectorAll('.b-bars .d-fill')].map(e => Math.round(parseFloat(e.style.width) * 10) / 10),
    stackW: [...document.querySelectorAll('.b-stack .d-row')[0].querySelectorAll('.d-seg')].map(e => Math.round(parseFloat(e.style.width))),
    dots: document.querySelectorAll('.b-dumbbell .d-track .d-dot').length,
    link: [...document.querySelectorAll('.d-sources a')].map(a => a.getAttribute('href') + '|' + a.rel),
    plainSource: document.querySelectorAll('.d-sources li span').length,
    tip: document.querySelectorAll('.dsec .term').length,
    code: document.querySelectorAll('.b-note code').length,
    junk: dataBlocksHTML([null, 5, {type: 'pie'}, {type: 'table'}, {type: 'bars', rows: 7}, {type: 'stack', rows: [{parts: 'x'}]}], {rich: x => String(x), esc: x => String(x), paras: x => String(x)}).length,
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })));
  out[out.length - 1].errs = errs; await p.close();
}
await b.close(); console.log(JSON.stringify(out));
""" % json.dumps(str(HERE / "pw.mjs"))
    tmp = Path(tempfile.mkdtemp())
    files = []
    for theme in ("zine", "sketch"):
        f = tmp / f"data-{theme}.html"
        r = subprocess.run([sys.executable, str(HERE / "build.py"), str(HERE / "testdata" / "data-mini.json"), str(f), "--theme", theme], capture_output=True, text=True)
        eq(r.returncode, 0, r.stdout + r.stderr)
        files.append(str(f))
    r = subprocess.run([node, "--input-type=module", "-e", script, *files], capture_output=True, text=True, timeout=180)
    if r.stdout.strip() == "NOPW":
        print("skip real-browser data test: Playwright not found"); return
    eq(r.returncode, 0, r.stderr)
    for x, f in zip(json.loads(r.stdout.strip().splitlines()[-1]), files):
        eq(x["errs"], [], f)
        eq(x["secs"], ["s-data-0:false", "s-data-1:false", "s-data-2:false"], f + " sections")
        eq(x["firstIsData"], "s-data-0", f + " the at=start section sits before the map")
        eq(x["rail"], ["Headline", "The map", "The trip", "Scores", "Sources", "Words to know"], f + " rail order")
        eq(x["rows"], 3, f + " table rows")
        eq(x["barW"], [54.8, 46.5, 2.7], f + " bar widths are value/max")
        eq(x["stackW"], [88, 8, 4], f + " stack parts are shares of the row")
        eq(x["dots"], 4, f + " dumbbell dots")
        eq(x["link"], ["https://arxiv.org/abs/2609.13009|noopener noreferrer"], f + " links")
        eq(x["plainSource"], 1, f + " source without url is plain text")
        eq(x["code"], 1, f + " backticks in a note render as code")
        eq(x["junk"] >= 0, True, f + " malformed blocks never throw")
        eq(x["sw"], x["cw"], f + " no sideways scroll")


t("real browser, both themes: data sections render, order in the rail, bars and stacks scale, links are safe", data_browser_check)

print(f"\n{'FAILED: ' + str(failed) if failed else 'all passed'}")
sys.exit(1 if failed else 0)
