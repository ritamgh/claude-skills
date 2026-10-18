#!/usr/bin/env python3
"""Check the shape fixtures against the contract invariants that need no CLI.

Everything here is written from reference/contract.md alone (frontier ranking, progress, lint rules), so it
does not share code with the real plan_core, prd or lint modules. Stdlib only.

Run: python3 check_fixtures.py   (prints "ok <name>" per file, exits 1 on any violation)
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
SEEDS = os.path.join(HERE, "..", "scripts", "seeds.json")

TOP_KEYS = ["schema", "id", "slug", "title", "owner", "size", "stage", "rev", "created", "updated", "repo",
            "published", "approved", "tldr", "frontier", "progress", "requests", "recent", "nodes"]
SIZES = ["quick", "standard", "deep"]
STAGES = ["frame", "explore", "decide", "shape", "ready", "building", "shipped"]
QSTAGES = ["frame", "explore", "decide", "shape"]
LANES = ["why", "who", "scope", "decisions", "risks", "slices", "tasks"]
STATUS = ["open", "settled", "parked", "killed"]
TASK_STATUS = ["todo", "doing", "done", "failed"]
USER_EVENTS = ["answer", "park", "reopen", "strike", "prioritize", "edit_label", "note", "ask", "expand", "approve_prd"]
SESSION_EVENTS = ["upsert", "remove", "set", "resolve", "task_status"]
TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

COMMON = ["id", "kind", "label", "body", "status", "depends_on", "refs", "rev", "by", "by_default"]
# kind -> (id regex, extra fields)
KINDS = {
    "story": (r"^P\d+$", ["evidence"]),
    "user": (r"^U\d+$", ["context"]),
    "goal": (r"^G-\d+$", []),
    "criterion": (r"^SC-\d{3,}$", ["verify", "evidence", "goal"]),
    "nongoal": (r"^NG-\d+$", ["why"]),
    "constraint": (r"^C-\d+$", ["tag"]),
    "assumption": (r"^AS-\d+$", ["validate_by", "impact"]),
    "slice": (r"^S\d+$", ["order", "why_priority", "independent_test", "scenarios", "exit"]),
    "requirement": (r"^FR-\d{3,}$", ["nfr"]),
    "edge": (r"^E-\d+$", ["expect"]),
    "risk": (r"^R-\d+$", ["approach"]),
    "approach": (r"^A-\d+$", ["alternatives"]),
    "boundary": (r"^B-\d+$", ["tier"]),
    "question": (r"^Q\d+$", ["lane", "why", "stage", "class", "options", "recommended", "answer", "priority",
                              "blocking", "fills"]),
    "task": (r"^T-\d{3,}$", ["slice", "files", "parallel", "check", "result", "crew"]),
    "decision": (r"^DEC-\d+$", ["chose", "alternatives", "why"]),
    "discovery": (r"^X-\d+$", ["evidence"]),
    "note": (r"^N-\d+$", ["lane"]),
}

# lint (contract 9), written independently
MANDATORY = {"quick": [0, 1, 2, 4, 5, 8, 13, 15]}
MANDATORY["standard"] = sorted(set(MANDATORY["quick"] + [3, 6, 7, 9, 11, 12, 16]))
MANDATORY["deep"] = sorted(set(MANDATORY["standard"] + [10, 17]))
VAGUE = re.compile(r"\b(fast|slow|scalable|easy|simple|intuitive|robust|user-friendly|efficient|seamless|quickly)\b",
                   re.I)
SECTION_KIND = {2: "story", 3: "user", 5: "nongoal", 6: "constraint", 7: "assumption", 8: "slice", 9: "requirement",
                10: "edge", 11: "risk", 12: "approach", 13: "boundary", 15: "task", 17: "decision"}


class Bad(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise Bad(msg)


def is_str(v):
    return isinstance(v, str)


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def str_list(v):
    return isinstance(v, list) and all(is_str(x) for x in v)


def num(i):
    return int(re.search(r"\d+", i).group())


def check_answer(nid, a, rev):
    need(isinstance(a, dict) and sorted(a) == sorted(["choice", "text", "by", "source", "at", "rev"]),
         "%s: answer keys %r" % (nid, a))
    need(a["by"] in ("user", "session") and a["source"] in ("page", "terminal", "build"), "%s: answer by/source" % nid)
    need(ISO.match(a["at"]) and is_int(a["rev"]) and 0 < a["rev"] <= rev, "%s: answer at/rev" % nid)
    need(a["choice"] is not None or (is_str(a["text"]) and a["text"].strip()), "%s: answer empty" % nid)


def check_node(n, rev):
    need(n.get("kind") in KINDS, "unknown kind %r" % n.get("kind"))
    pat, extra = KINDS[n["kind"]]
    nid = n.get("id", "?")
    need(sorted(n) == sorted(COMMON + extra), "%s: fields %s != %s" % (nid, sorted(n), sorted(COMMON + extra)))
    need(re.match(pat, nid), "%s: id does not match kind %s" % (nid, n["kind"]))
    need(is_str(n["label"]) and n["label"].strip() and len(n["label"]) <= 120 and "\n" not in n["label"],
         "%s: label" % nid)
    need(is_str(n["body"]) and len(n["body"]) <= 4000, "%s: body" % nid)
    ok = TASK_STATUS if n["kind"] == "task" else STATUS
    need(n["status"] in ok, "%s: status %r invalid for %s" % (nid, n["status"], n["kind"]))
    need(str_list(n["depends_on"]) and str_list(n["refs"]), "%s: depends_on/refs" % nid)
    need(is_int(n["rev"]) and 0 <= n["rev"] <= rev, "%s: rev %r vs plan rev %d" % (nid, n["rev"], rev))
    need(n["by"] in ("user", "session") and isinstance(n["by_default"], bool), "%s: by/by_default" % nid)
    k = n["kind"]
    if k in ("story", "discovery"):
        need(is_str(n["evidence"]), "%s: evidence" % nid)
    if k == "user":
        need(is_str(n["context"]), "%s: context" % nid)
    if k == "criterion":
        need(is_str(n["verify"]) and is_str(n["evidence"]) and (n["goal"] is None or is_str(n["goal"])),
             "%s: criterion fields" % nid)
    if k == "nongoal":
        need(is_str(n["why"]), "%s: why" % nid)
    if k == "constraint":
        need(n["tag"] in ("appetite", "stack", "perf", "security", "other"), "%s: tag" % nid)
    if k == "assumption":
        need(is_str(n["validate_by"]) and is_str(n["impact"]), "%s: assumption fields" % nid)
    if k == "slice":
        need(is_int(n["order"]) and is_str(n["why_priority"]) and is_str(n["independent_test"])
             and str_list(n["scenarios"]) and is_str(n["exit"]), "%s: slice fields" % nid)
    if k == "requirement":
        need(isinstance(n["nfr"], bool), "%s: nfr" % nid)
        if n["nfr"]:
            need(re.search(r"\d", n["label"] + n["body"]), "%s: NFR without a number" % nid)
    if k == "edge":
        need(is_str(n["expect"]) and (n["expect"].strip() or n["refs"] or n["status"] != "settled"),
             "%s: settled edge needs expect or a ref" % nid)
    if k == "risk":
        need(is_str(n["approach"]), "%s: approach" % nid)
    if k in ("approach", "decision"):
        need(str_list(n["alternatives"]), "%s: alternatives" % nid)
    if k == "decision":
        need(is_str(n["chose"]) and is_str(n["why"]), "%s: decision fields" % nid)
    if k == "boundary":
        need(n["tier"] in ("always", "ask", "never", "command"), "%s: tier" % nid)
    if k == "note":
        need(n["lane"] in LANES, "%s: lane" % nid)
    if k == "task":
        need(n["slice"] is None or is_str(n["slice"]), "%s: slice" % nid)
        need(str_list(n["files"]) and isinstance(n["parallel"], bool) and is_str(n["check"]), "%s: task fields" % nid)
        r = n["result"]
        need(r is None or (isinstance(r, dict) and sorted(r) == ["at", "note", "ok"] and isinstance(r["ok"], bool)
                           and ISO.match(r["at"])), "%s: result" % nid)
        need(n["crew"] is None or is_str(n["crew"]), "%s: crew" % nid)
    if k == "question":
        need(n["lane"] in LANES and n["stage"] in QSTAGES and n["class"] in ("mechanical", "taste", "user"),
             "%s: lane/stage/class" % nid)
        need(is_str(n["why"]) and is_int(n["priority"]) and isinstance(n["blocking"], bool), "%s: why/prio/blocking" % nid)
        need(str_list(n["fills"]), "%s: fills" % nid)
        opts = n["options"]
        need(isinstance(opts, list) and len(opts) <= 6, "%s: options" % nid)
        for i, o in enumerate(opts):
            need(isinstance(o, dict) and sorted(o) == ["key", "label", "why"] and o["key"] == "abcdef"[i]
                 and is_str(o["label"]) and o["label"].strip() and is_str(o["why"]), "%s: option %d" % (nid, i))
        keys = [o["key"] for o in opts]
        need(n["recommended"] is None or n["recommended"] in keys, "%s: recommended" % nid)
        if n["answer"] is not None:
            check_answer(nid, n["answer"], rev)
            need(n["answer"]["choice"] is None or n["answer"]["choice"] in keys, "%s: answer choice" % nid)
            need(n["status"] == "settled", "%s: answered but %s" % (nid, n["status"]))
        else:
            need(n["status"] != "settled", "%s: settled without answer" % nid)


def frontier(p):
    """contract 5: eligible open questions, ranked."""
    nodes = {n["id"]: n for n in p["nodes"]}
    done = ("settled", "done", "killed")
    stage_rank = {s: i for i, s in enumerate(QSTAGES)}

    def open_dependents(i):
        return sum(1 for n in p["nodes"] if n["status"] == "open" and i in n["depends_on"])

    elig = [n for n in p["nodes"] if n["kind"] == "question" and n["status"] == "open"
            and all(nodes[d]["status"] in done for d in n["depends_on"])]
    elig.sort(key=lambda n: (-n["priority"], stage_rank[n["stage"]], -open_dependents(n["id"]), num(n["id"])))
    return [n["id"] for n in elig]


def lint_blocking(p):
    """contract 9 blocking rules -> sorted list of (rule, node)."""
    nodes = p["nodes"]
    out = []
    settled = lambda k: [n for n in nodes if n["kind"] == k and n["status"] == "settled"]

    def renders(n):
        """contract 8: which nodes render as content of their section."""
        if n["kind"] in ("assumption", "task"):
            return True
        return n["status"] in ("settled", "parked")

    def pending(sec):
        if sec == 0:
            return False
        if sec == 1:
            return not p["tldr"].strip()
        kinds = ("goal", "criterion") if sec == 4 else (SECTION_KIND[sec],)
        return not [n for n in nodes if n["kind"] in kinds and renders(n)]

    for sec in MANDATORY[p["size"]]:
        if pending(sec):
            out.append(("empty-section", None))
    for n in nodes:
        if n["kind"] == "question" and n["blocking"] and n["status"] in ("open", "parked"):
            out.append(("blocking-question", n["id"]))
    slices = [n for n in nodes if n["kind"] == "slice" and n["status"] == "settled"]
    tasks = [n for n in nodes if n["kind"] == "task"]
    for n in nodes:
        if n["kind"] == "requirement" and n["status"] == "settled":
            if not any(n["id"] in s["refs"] and s["scenarios"] for s in slices):
                out.append(("fr-no-scenario", n["id"]))
        if n["kind"] in ("requirement", "criterion") and n["status"] == "settled":
            if not any(n["id"] in t["refs"] for t in tasks):
                out.append(("uncovered", n["id"]))
        if n["kind"] == "task" and not n["check"].strip():
            out.append(("task-no-check", n["id"]))
        if n["kind"] in ("requirement", "criterion"):
            text = n["label"] + " " + n["body"]
            if VAGUE.search(text) and not re.search(r"\d", text):
                out.append(("vague", n["id"]))
    if not settled("nongoal"):
        out.append(("no-nongoals", None))
    return out


def check_plan(name, p):
    need(isinstance(p, dict) and sorted(p) == sorted(TOP_KEYS), "top-level keys %s" % sorted(set(p) ^ set(TOP_KEYS)))
    need(p["schema"] == 1 and p["size"] in SIZES and p["stage"] in STAGES, "schema/size/stage")
    need(TASK_ID.match(p["id"]) and ".." not in p["id"], "task id")
    need(p["slug"] == re.sub(r"^\d{4}-", "", p["id"]), "slug")
    need(is_str(p["title"]) and p["title"] and is_str(p["owner"]) and is_str(p["tldr"]), "title/owner/tldr")
    need(is_int(p["rev"]) and p["rev"] >= 0, "rev")
    need(ISO.match(p["created"]) and ISO.match(p["updated"]) and p["created"] <= p["updated"], "created/updated")
    need(p["repo"] is None or os.path.isabs(p["repo"]), "repo")
    need(p["published"] is None or os.path.isabs(p["published"]), "published")
    need(p["approved"] is None or sorted(p["approved"]) == ["at", "rev"], "approved")
    rev = p["rev"]
    ids = [n["id"] for n in p["nodes"]]
    need(len(ids) == len(set(ids)), "duplicate ids: %s" % [i for i in ids if ids.count(i) > 1])
    for n in p["nodes"]:
        check_node(n, rev)
    byid = {n["id"]: n for n in p["nodes"]}
    for n in p["nodes"]:
        for f in ("depends_on", "refs") + (("fills",) if n["kind"] == "question" else ()):
            for r in n[f]:
                need(r in byid, "%s.%s -> missing %s" % (n["id"], f, r))
        if n["kind"] == "criterion" and n["goal"] is not None:
            need(byid.get(n["goal"], {}).get("kind") == "goal", "%s: goal %s" % (n["id"], n["goal"]))
        if n["kind"] == "task" and n["slice"] is not None:
            need(byid.get(n["slice"], {}).get("kind") == "slice", "%s: slice %s" % (n["id"], n["slice"]))
        if n["kind"] == "question":
            for f in n["fills"]:
                need(byid[f]["kind"] not in ("question", "task"), "%s fills %s (question/task not allowed)" % (n["id"], f))
        if n["kind"] == "question" and n["answer"] is not None:
            for f in n["fills"]:
                need(byid[f]["status"] == "settled", "%s answered but fills %s is %s" % (n["id"], f, byid[f]["status"]))
    # depends_on must not form a cycle
    state = {}

    def visit(i):
        if state.get(i) == 1:
            raise Bad("depends_on cycle through %s" % i)
        if state.get(i) == 2:
            return
        state[i] = 1
        for d in byid[i]["depends_on"]:
            visit(d)
        state[i] = 2

    for i in byid:
        visit(i)
    # progress and frontier
    qs = [n for n in p["nodes"] if n["kind"] == "question"]
    prog = {"settled": sum(1 for q in qs if q["status"] == "settled"), "total": sum(1 for q in qs if q["status"] != "killed")}
    need(p["progress"] == prog, "progress %r != %r" % (p["progress"], prog))
    need(p["frontier"] == frontier(p), "frontier %r != %r" % (p["frontier"], frontier(p)))
    # recent
    rc = p["recent"]
    need(len(rc) == min(30, rev), "recent length %d for rev %d" % (len(rc), rev))
    for i, e in enumerate(rc):
        need(sorted(e) == ["at", "by", "node", "rev", "source", "summary", "type"], "recent[%d] keys" % i)
        need(e["rev"] == rev - i, "recent[%d] rev %r" % (i, e["rev"]))
        need(e["by"] in ("user", "session") and e["source"] in ("page", "terminal", "build"), "recent[%d] by/source" % i)
        need(e["type"] in USER_EVENTS + SESSION_EVENTS, "recent[%d] type" % i)
        need(ISO.match(e["at"]) and is_str(e["summary"]) and e["summary"], "recent[%d] at/summary" % i)
        # an event may name a node that was removed later, so only check nodes that still exist
        if e["node"] in byid:
            need(byid[e["node"]]["rev"] >= e["rev"], "recent[%d]: node %s rev below event rev" % (i, e["node"]))
        if i:
            need(e["at"] <= rc[i - 1]["at"], "recent[%d] not newest-first" % i)
    if rc:
        need(rc[0]["at"] == p["updated"], "updated != newest event")
    # requests
    for r in p["requests"]:
        need(sorted(r) == ["at", "lane", "node", "ref", "text", "type"], "request keys")
        need(re.match(r"^e-[0-9a-f]{12}$", r["ref"]) and r["type"] in ("note", "ask", "expand") and ISO.match(r["at"])
             and (r["node"] is None or r["node"] in byid) and (r["lane"] is None or r["lane"] in LANES)
             and is_str(r["text"]) and r["text"], "request %r" % r)


def check_seeds(seeds):
    need(sorted(seeds) == ["deep", "quick", "standard"], "seeds keys")
    sizes = {"quick": 5, "standard": 7, "deep": 9}
    for size, lst in seeds.items():
        need(len(lst) == sizes[size], "%s: %d seeds" % (size, len(lst)))
        for i, s in enumerate(lst):
            need(sorted(s) == sorted(w for w in COMMON + KINDS["question"][1] if w not in ("rev", "by")),
                 "%s[%d] fields %s" % (size, i, sorted(s)))
            need(s["id"] == "Q%d" % (i + 1) and s["kind"] == "question" and s["status"] == "open", "%s[%d] id/status" % (size, i))
            need(s["stage"] == "frame" and s["answer"] is None and s["fills"] == [] and s["depends_on"] == [], "%s[%d] frame" % (size, i))
            need(s["lane"] in LANES and s["class"] in ("mechanical", "taste", "user"), "%s[%d] lane/class" % (size, i))
            need(is_str(s["why"]) and s["why"] and is_str(s["label"]) and 0 < len(s["label"]) <= 120, "%s[%d] label/why" % (size, i))
            keys = [o["key"] for o in s["options"]]
            need(keys == list("abcdef")[:len(keys)] and s["recommended"] in keys + [None], "%s[%d] options" % (size, i))
            need(isinstance(s["blocking"], bool) and is_int(s["priority"]) and isinstance(s["by_default"], bool), "%s[%d] flags" % (size, i))


def main():
    bad = 0

    def run(name, fn):
        nonlocal bad
        try:
            fn()
            print("ok", name)
        except Bad as e:
            bad += 1
            print("FAIL %s: %s" % (name, e))

    def load(n):
        with open(os.path.join(FIX, n), encoding="utf-8") as f:
            return json.load(f)

    def standard():
        p = load("plan-standard.json")
        check_plan("standard", p)
        need(p["size"] == "standard" and p["stage"] == "decide" and p["rev"] == 95, "standard header")
        need({n["kind"] for n in p["nodes"]} == set(KINDS), "standard misses kinds %s" % (set(KINDS) - {n["kind"] for n in p["nodes"]}))
        need(p["progress"] == {"settled": 14, "total": 22} and p["frontier"][0] == "Q7", "standard shape")

    def ready():
        p = load("plan-ready.json")
        check_plan("ready", p)
        need(p["size"] == "quick" and p["stage"] == "shape", "ready header")
        need(p["frontier"] == [] and all(q["status"] == "settled" for q in p["nodes"] if q["kind"] == "question"), "ready questions")
        need(lint_blocking(p) == [], "ready has blocking findings: %r" % lint_blocking(p))

    def defects():
        p = load("plan-defects.json")
        check_plan("defects", p)
        exp = [(e["rule"], e["node"]) for e in load("plan-defects.expected.json")]
        got = lint_blocking(p)
        need(sorted(got, key=str) == sorted(exp, key=str), "defects findings %r != expected %r" % (got, exp))
        need(len({r for r, _ in exp}) == 7 == len(exp), "expected list must name each of the 7 rules once")

    def seeds():
        with open(SEEDS, encoding="utf-8") as f:
            check_seeds(json.load(f))

    run("plan-standard.json", standard)
    run("plan-ready.json", ready)
    run("plan-defects.json", defects)
    run("seeds.json", seeds)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
