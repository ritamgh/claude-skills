#!/usr/bin/env python3
"""Stand-in for `claude -p ... --output-format stream-json` used by test-panel.mjs (set LENS_CLAUDE to this file).
Answers with the flags, the start of the system prompt and the prompt it received, so the test can see what serve.py sent."""
import json, sys, time
args, prompt = sys.argv[1:], sys.stdin.read()
opt = lambda f: args[args.index(f) + 1] if f in args else "none"
sid = opt("--resume") if "--resume" in args else "11111111-2222-3333-4444-555555555555"
out = lambda d: (print(json.dumps(d)), sys.stdout.flush())
delta = lambda t: out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": t}}})
out({"type": "system", "subtype": "init", "session_id": sid})
out({"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "text"}}})
for chunk in [f"model={opt('--model')} resume={opt('--resume')} sys={opt('--system-prompt')[:44]} ", "PROMPT<<" + prompt + ">>"]:
    delta(chunk); time.sleep(0.05)
out({"type": "result", "subtype": "success", "is_error": False, "session_id": sid, "result": "ok"})
