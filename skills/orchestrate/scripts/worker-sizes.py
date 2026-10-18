#!/usr/bin/env python3
"""Report (or watch) how big each worker's context is. Read-only.

Orchestrator: the session's own transcript; the report adds cumulative input tokens for the
orchestrator vs its Claude workers (the share was 45-78% in the 2026-09 runs), and --watch
prints an "orchestrator" line past --orch-threshold (soft) and --orch-hard (read
incrementally: it can be ~100MB). Both default to the crew compaction policy:
$CREW_COMPACT_SOFT (200k) and $CREW_COMPACT_HARD (400k).
Claude workers: every subagent transcript under the session, both direct Agent calls
(<session>/subagents/agent-*.jsonl) and Workflow agents
(<session>/subagents/workflows/<run>/agent-*.jsonl). Context = input + cache tokens of
the worker's latest turn, so it is the size the worker is carrying right now.
jcode workers: final usage from ~/.claude/orchestration/<slug>/runs/*.json (report only;
jw writes it when the run ends).

Usage:
  worker-sizes.py [--session ID] [--slug SLUG]
  worker-sizes.py --watch [--threshold 150000] [--step 50000] [--orch-threshold 200000]
                  [--orch-hard 400000] [--interval 20] [--session ID]

--session defaults to $CLAUDE_CODE_SESSION_ID. --watch prints one line when a worker
first crosses the threshold and again every --step above it, then keeps running
(start it with the Monitor tool so the orchestrator is woken instead of polling).
"""
import argparse, glob, json, os, sys, time

HOME = os.path.expanduser("~/.claude")


def session_dir(sid):
    hits = glob.glob(f"{HOME}/projects/*/{sid}.jsonl")
    if not hits:
        sys.exit(f"no transcript for session {sid}")
    return hits[0][: -len(".jsonl")]


def turn_context(line):
    """(message id, context) for an assistant transcript line with usage, else None."""
    if '"assistant"' not in line:
        return None  # cheap skip before parsing
    try:
        o = json.loads(line)
    except ValueError:
        return None  # a line still being written
    if o.get("type") != "assistant":
        return None
    m = o.get("message") or {}
    u = m.get("usage")
    if not u:
        return None
    return m.get("id"), (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                         + u.get("cache_creation_input_tokens", 0))


def usage_stats(path):
    """(turns, current_context, peak_context, cumulative_input) for one transcript.

    cumulative_input sums each API turn's context once (one turn spans several lines):
    it is what the transcript's owner paid to re-read its context over the session."""
    cur, peak, per_turn = 0, 0, {}
    try:
        f = open(path)
    except OSError:
        return 0, 0, 0, 0
    with f:
        for line in f:
            tc = turn_context(line)
            if not tc:
                continue
            mid, ctx = tc
            cur, peak = ctx, max(peak, ctx)
            per_turn[mid] = ctx
    # (output_tokens isn't usable: transcripts keep only partial streaming counts)
    return len(per_turn), cur, peak, sum(per_turn.values())


class Tail:
    """Latest context of a transcript, reading only lines appended since the last call."""

    def __init__(self, path):
        self.path, self.pos, self.cur = path, 0, 0

    def context(self):
        try:
            with open(self.path) as f:
                f.seek(self.pos)
                while True:
                    line = f.readline()
                    if not line.endswith("\n"):
                        break  # partial line: reread it next time
                    self.pos = f.tell()
                    tc = turn_context(line)
                    if tc:
                        self.cur = tc[1]
        except OSError:
            pass
        return self.cur


def workers(sdir):
    for p in sorted(glob.glob(f"{sdir}/subagents/**/agent-*.jsonl", recursive=True)):
        meta = {}
        try:
            meta = json.load(open(p[: -len(".jsonl")] + ".meta.json"))
        except (OSError, ValueError):
            pass
        run = os.path.basename(os.path.dirname(p)) if "/workflows/" in p else "-"
        name = os.path.basename(p)[len("agent-"):-len(".jsonl")]
        yield name, run, meta, p


def k(n):
    return f"{n / 1000:.0f}k"


def report(sid, slug):
    sdir = session_dir(sid)
    t, cur, peak, ocum = usage_stats(sdir + ".jsonl")
    print(f"orchestrator {sid[:8]}: context {k(cur)} (peak {k(peak)}), {t} turns")
    rows, wcum = [], 0
    for name, run, meta, p in workers(sdir):
        t, cur, peak, cum = usage_stats(p)
        wcum += cum
        rows.append((peak, name[:12], run[:16], meta.get("model", "?"),
                     t, cur, meta.get("description", "")[:40]))
    if rows:
        print(f"{'worker':12} {'workflow':16} {'model':7} {'turns':>5} {'now':>6} {'peak':>6}  description")
        for peak, name, run, model, t, cur, desc in sorted(rows, reverse=True):
            print(f"{name:12} {run:16} {model:7} {t:5} {k(cur):>6} {k(peak):>6}  {desc}")
    else:
        print("no Claude workers yet")
    if ocum + wcum:
        print(f"cumulative input (whole session): orchestrator {ocum / 1e6:.1f}M, "
              f"Claude workers {wcum / 1e6:.1f}M, orchestrator share {100 * ocum / (ocum + wcum):.0f}%")
    for s in ([slug] if slug else []):
        for p in sorted(glob.glob(f"{HOME}/orchestration/{s}/runs/*.json")):
            try:
                u = json.load(open(p)).get("usage") or {}
            except (OSError, ValueError):
                continue
            # OpenAI-style usage: cache_read_input_tokens is a subset of input_tokens, so it is not added
            ctx = u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            print(f"jcode {os.path.basename(p)[:-5]}: last-turn context {k(ctx)}")


def watch(sid, threshold, step, interval, orch_threshold, orch_hard):
    sdir = session_dir(sid)
    marks = {}  # worker -> next size that triggers a line
    orch, orch_next = Tail(sdir + ".jsonl"), orch_threshold
    while True:
        cur = orch.context()
        if cur >= orch_next:
            if cur >= orch_hard:
                print(f"orchestrator is at {k(cur)} context (hard {k(orch_hard)}): finish the current "
                      f"step, bring the ledger up to date, then hand off (SKILL.md §6)", flush=True)
            else:
                print(f"orchestrator is at {k(cur)} context (soft {k(orch_threshold)}): at the next "
                      f"boundary bring the ledger's Next step up to date and crew log the milestone "
                      f"(SKILL.md §6)", flush=True)
            while cur >= orch_next:
                orch_next += step
        for name, run, meta, p in workers(sdir):
            _, cur, _, _ = usage_stats(p)
            nxt = marks.get(name, threshold)
            if cur >= nxt:
                where = f" in workflow {run}" if run != "-" else ""
                print(f"worker {name[:12]} ({meta.get('model', '?')}, "
                      f"\"{meta.get('description', '')[:50]}\"){where} is at {k(cur)} context "
                      f"(recommended max {k(threshold)}) — decide: finish, checkpoint+restart, or stop",
                      flush=True)
                while cur >= nxt:
                    nxt += step
                marks[name] = nxt
        time.sleep(interval)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default=os.environ.get("CLAUDE_CODE_SESSION_ID"))
    ap.add_argument("--slug")
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--threshold", type=int, default=150_000)
    ap.add_argument("--step", type=int, default=50_000)
    ap.add_argument("--orch-threshold", type=int, default=int(os.environ.get("CREW_COMPACT_SOFT", 200_000)))
    ap.add_argument("--orch-hard", type=int, default=int(os.environ.get("CREW_COMPACT_HARD", 400_000)))
    ap.add_argument("--interval", type=int, default=20)
    a = ap.parse_args()
    if not a.session:
        sys.exit("pass --session (CLAUDE_CODE_SESSION_ID is not set)")
    if a.watch:
        watch(a.session, a.threshold, a.step, a.interval, a.orch_threshold, a.orch_hard)
    else:
        report(a.session, a.slug)
