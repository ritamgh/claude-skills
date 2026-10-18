#!/usr/bin/env python3
"""Stand-in for `claude -p ... --output-format stream-json` used by the lens tests (set LENS_CLAUDE to this file).
It echoes the flags and prompt it received back as the answer. Prompts containing FAIL, ISERR or HANG fail or hang (see below)."""
import json, sys, time
args, prompt = sys.argv[1:], sys.stdin.read()
opt = lambda f: args[args.index(f) + 1] if f in args else "none"
if "FAIL" in prompt:
    print("boom: fake failure", file=sys.stderr); sys.exit(1)
if "ISERR" in prompt:  # claude's own error result, then a non-zero exit
    print(json.dumps({"type": "result", "is_error": True, "result": "Credit balance too low"})); sys.exit(1)
if "HANG" in prompt:  # silent like a long thinking phase, with a child process; pids go to $FAKE_PID_FILE
    import os, subprocess
    child = subprocess.Popen(["sleep", "60"])
    open(os.environ["FAKE_PID_FILE"], "w").write(f"{os.getpid()} {child.pid}")
    time.sleep(60); sys.exit(0)
sid = opt("--resume") if "--resume" in args else "11111111-2222-3333-4444-555555555555"
out = lambda d: (print(json.dumps(d)), sys.stdout.flush())
delta = lambda t: out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": t}}})
start = lambda: out({"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "text"}}})
out({"type": "system", "subtype": "init", "session_id": sid})
start(); delta("Let me look.")
out({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "/repo/app.py"}}]}})
start()
for chunk in [f"model={opt('--model')} resume={opt('--resume')} tools={opt('--tools')} settings={opt('--settings')} ", "**bold**, *it* and `a*b*c`.\n\n", "PROMPT<<" + prompt + ">>"]:
    delta(chunk); time.sleep(0.05)
out({"type": "result", "subtype": "success", "is_error": False, "session_id": sid, "result": "ok"})
