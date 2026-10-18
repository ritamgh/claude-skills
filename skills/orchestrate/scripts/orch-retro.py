#!/usr/bin/env python3
"""Post-run numbers for one orchestration (SKILL.md §10). Read-only.

Where the run's tokens and time went, from the session transcripts on disk: orchestrator
vs Claude worker input tokens, peaks, what filled the orchestrator's context, inline
edits, errors and refusals, idle gaps, compactions, jcode run outcomes. Every finding
cites a transcript path:line so it can be checked.

Usage:
  orch-retro.py --slug SLUG [--session ID] [--from ISO] [--to ISO]

--session defaults to $CLAUDE_CODE_SESSION_ID. The run's window defaults to the first and
last lines of the orchestrator transcript that mention the slug; --from/--to override it
(ISO timestamps as in the transcript, UTC, e.g. 2026-09-29T22:48).
"""
import argparse, collections, glob, json, os, re, sys

HOME = os.path.expanduser("~/.claude")
REFUSAL = re.compile(r"permission|denied|refus|not allowed", re.I)


def session_file(sid):
    hits = glob.glob(f"{HOME}/projects/*/{sid}.jsonl")
    if not hits:
        sys.exit(f"no transcript for session {sid}")
    return hits[0]


def lines(path):
    with open(path) as f:
        for n, line in enumerate(f, 1):
            try:
                yield n, line, json.loads(line)
            except ValueError:
                continue


def window(path, slug):
    first = last = None
    for _, line, o in lines(path):
        if slug in line and o.get("timestamp"):
            first = first or o["timestamp"]
            last = o["timestamp"]
    if not first:
        sys.exit(f"slug {slug!r} never appears in {path}; pass --from/--to")
    return first, last


def ctx_of(o):
    u = (o.get("message") or {}).get("usage")
    if not u:
        return 0
    return u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)


def transcript_stats(path, t0, t1):
    """Per-turn-deduplicated usage of one transcript inside [t0, t1]."""
    per_turn, first, peak = {}, None, (0, 0)
    for n, _, o in lines(path):
        ts = o.get("timestamp") or ""
        if o.get("type") != "assistant" or not (t0 <= ts <= t1):
            continue
        c = ctx_of(o)
        if not c:
            continue
        per_turn[(o.get("message") or {}).get("id")] = c
        first = first or c
        if c > peak[0]:
            peak = (c, n)
    return {"turns": len(per_turn), "cum": sum(per_turn.values()), "first": first or 0,
            "last": list(per_turn.values())[-1] if per_turn else 0, "peak": peak[0], "peak_line": peak[1]}


def orchestrator_detail(path, t0, t1):
    names, res_bytes, res_n = {}, collections.Counter(), collections.Counter()
    images, edits, errors, refusals, compactions, gaps = 0, [], [], [], [], []
    prev = None
    for n, _, o in lines(path):
        ts = o.get("timestamp") or ""
        if not (t0 <= ts <= t1):
            continue
        if prev and ts[:19] > prev[0]:
            gap = minutes(prev[0], ts)
            if gap > 10:
                gaps.append((gap, prev[1], n))
        prev = (ts[:19], n)
        if o.get("isCompactSummary"):
            compactions.append(n)
        msg = o.get("message") or {}
        content = msg.get("content")
        if o.get("type") == "assistant" and isinstance(content, list):
            for b in content:
                if b.get("type") != "tool_use":
                    continue
                inp = b.get("input") or {}
                name = b["name"]
                if name == "Bash":
                    words = (inp.get("command") or "").split()
                    name = "Bash " + " ".join(w for w in words[:2] if not w.startswith("-"))[:28]
                names[b.get("id")] = name
                fp = inp.get("file_path", "")
                if b["name"] in ("Edit", "Write") and "/orchestration/" not in fp and "/scratchpad/" not in fp:
                    edits.append((fp, n))
        elif o.get("type") == "user" and isinstance(content, list):
            for b in content:
                if b.get("type") != "tool_result":
                    continue
                name = names.get(b.get("tool_use_id"), "?")
                body = b.get("content")
                if isinstance(body, list) and any(isinstance(x, dict) and x.get("type") == "image" for x in body):
                    images += 1
                    name += " (image)"
                res_bytes[name] += len(json.dumps(body))
                res_n[name] += 1
                if b.get("is_error"):
                    text = json.dumps(body)[:160]
                    (refusals if REFUSAL.search(text) else errors).append((name, n, text))
    return dict(res_bytes=res_bytes, res_n=res_n, images=images, edits=edits, errors=errors,
                refusals=refusals, compactions=compactions, gaps=gaps)


def minutes(a, b):
    from datetime import datetime
    def parse(t):
        return datetime.strptime(t[:19], "%Y-%m-%dT%H:%M:%S" if len(t) >= 19 else "%Y-%m-%dT%H:%M")
    return (parse(b) - parse(a)).total_seconds() / 60


def jcode_runs(slug):
    ledger = f"{HOME}/orchestration/{slug}/ledger.md"
    out = collections.Counter()
    try:
        for line in open(ledger):
            m = re.match(r"\|\s*\d{4}-\d\d-\d\d [\d:]+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*[^|]*\|\s*([^|\s]+)\s*\|", line)
            if m:
                out[m.group(3)] += 1
    except OSError:
        pass
    return out


def k(n):
    return f"{n / 1000:.0f}k"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", required=True)
    ap.add_argument("--session", default=os.environ.get("CLAUDE_CODE_SESSION_ID"))
    ap.add_argument("--from", dest="t0")
    ap.add_argument("--to", dest="t1")
    a = ap.parse_args()
    if not a.session:
        sys.exit("pass --session (CLAUDE_CODE_SESSION_ID is not set)")
    path = session_file(a.session)
    t0, t1 = window(path, a.slug) if not (a.t0 and a.t1) else (a.t0, a.t1)
    t0, t1 = a.t0 or t0, a.t1 or t1
    span = minutes(t0, t1)
    if len(t1) < 19:
        t1 += "~"  # make a minute-precision --to include that whole minute

    o = transcript_stats(path, t0, t1)
    workers = []
    for p in glob.glob(path[:-len(".jsonl")] + "/subagents/**/agent-*.jsonl", recursive=True):
        s = transcript_stats(p, t0, t1)
        if s["turns"]:
            workers.append((s, p))
    wcum = sum(s["cum"] for s, _ in workers)
    d = orchestrator_detail(path, t0, t1)

    print(f"# Retro: {a.slug}")
    sdir = path[:-len(".jsonl")]
    print(f"window {t0[:16]} → {t1[:16]} UTC ({span:.0f} min)")
    print(f"evidence: O = {path}; workers are relative to {sdir}/")
    print(f"orchestrator: {o['turns']} turns, context {k(o['first'])} at start → peak {k(o['peak'])} "
          f"(O:{o['peak_line']}) → {k(o['last'])} at end; cumulative input {o['cum'] / 1e6:.1f}M")
    print(f"Claude workers: {len(workers)} agents, cumulative input {wcum / 1e6:.1f}M"
          + (f"; orchestrator share {100 * o['cum'] / (o['cum'] + wcum):.0f}%" if o["cum"] + wcum else ""))
    for s, p in sorted(workers, key=lambda w: -w[0]["peak"])[:5]:
        print(f"  worker peak {k(s['peak'])}, {s['turns']} turns: {os.path.relpath(p, sdir)}:{s['peak_line']}")
    jr = jcode_runs(a.slug)
    if jr:
        print("jcode runs: " + ", ".join(f"{n} {st}" for st, n in jr.most_common()))
    if o["first"] > 100_000:
        print(f"rule 7: orchestrator started at {k(o['first'])} (> 100k): a fresh --resume was due")

    print(f"\n## What filled the orchestrator ({d['images']} screenshots/images)")
    total = sum(d["res_bytes"].values()) or 1
    for name, b in d["res_bytes"].most_common(8):
        print(f"  {b // 1000:6} KB {100 * b // total:3}%  {d['res_n'][name]:4}x  {name}")
    print(f"\n## Orchestrator Edit/Write outside the ledger: {len(d['edits'])} calls")
    for fp, n in collections.OrderedDict((fp, n) for fp, n in d["edits"]).items():
        print(f"  {fp}  (first at O:{n})")
    print(f"\n## Errors {len(d['errors'])}, permission refusals {len(d['refusals'])}")
    for name, n, text in (d["refusals"] + d["errors"])[:8]:
        print(f"  O:{n} {name}: {text[:100]}")
    print(f"\n## Idle gaps > 10 min: {len(d['gaps'])}; compactions: {len(d['compactions'])}")
    for gap, n0, n1 in d["gaps"]:
        print(f"  {gap:.0f} min between O:{n0} and O:{n1}")
    for n in d["compactions"]:
        print(f"  compaction at O:{n}")


if __name__ == "__main__":
    main()
