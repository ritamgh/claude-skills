#!/usr/bin/env python3
"""Serve a lesson on localhost so the page can ask Claude about what you select.

  python3 serve.py LESSON.html [--repo DIR] [--port 4174] [--open]

Questions run through your own Claude Code login (`claude -p`, no API key), in the repo the lesson
explains, with read-only tools (Read, Grep, Glob) and none of that repo's Claude settings or hooks.
Follow-ups resume the same Claude session. If a lens server for the same lesson is already running,
this just opens the lesson in it.

Only pages opened from the printed link can ask: it carries a key in its #fragment (never sent to the
server, so other local users cannot fetch it), kept in ~/.config/lens/token (mode 600).

API used by the theme (same origin only):
  GET  /__lens/health  -> {"lens": 1, "dir": ..., "lesson": ..., "repo": ..., "models": [...], "model": default}
  POST /__lens/ask     {"q", "model", "session"?, "lesson"?, "quote"?, "where"?, "mode"?: "report", "context"?}  with header X-Lens-Key
                       -> NDJSON lines: {"t": "session"|"text"|"tool"|"error"|"done", "v": ...}
"""
import argparse, html, json, os, re, secrets, select, shutil, signal, socket, subprocess, sys, tempfile, threading, urllib.request, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODELS = ("haiku", "sonnet")
TIMEOUT = int(os.environ.get("LENS_ASK_TIMEOUT", 300))  # seconds per answer, then claude is killed

TUTOR = """You are a patient tutor. The person is reading an interactive lesson that explains code in this repository (your working directory), and they selected part of it to ask you about.

- Answer the question first, in plain words, then add only the detail that helps. Usually 2 to 5 short paragraphs.
- When the answer depends on code, read it with Read, Grep or Glob instead of guessing, and cite it as path:line.
- If the lesson itself looks wrong or out of date, say so plainly and show what the code really does.
- You cannot change anything; never offer to edit files or run commands.
- Format: short paragraphs, `inline code`, short fenced code blocks, bold, and simple bullet lists. No headings, no tables."""

# mode "report" (the ask-panel skill): the page is any HTML report, not a lens lesson
REPORT = """You are answering questions about a web page (a report) that the person is reading. Its text is in their first message; your working directory is the folder or repo it came from.

- Answer the question first, in plain words, then add only the detail that helps. Usually 2 to 5 short paragraphs.
- Rely on the page text. When the answer depends on files or code the page refers to, read them with Read, Grep or Glob instead of guessing, and cite them as path:line.
- If the page does not say, or looks wrong, say so plainly.
- You cannot change anything; never offer to edit files or run commands.
- Format: short paragraphs, `inline code`, short fenced code blocks, bold, and simple bullet lists. No headings, no tables."""


def build_prompt(req):
    """The user turn sent to Claude: where the question comes from, the selected text, and the question."""
    parts = []
    if req.get("context"):  # report mode, first turn only (a resumed session already has it)
        parts.append('The page I am reading:\n"""\n' + req["context"].strip() + '\n"""')
    if req.get("where"):
        parts.append(f"I'm reading: {req['where']}")
    if req.get("quote"):
        parts.append('I selected this from the lesson:\n"""\n' + req["quote"].strip() + '\n"""')
    parts.append(req["q"].strip())
    return "\n\n".join(parts)


def token():
    """A per-user key that survives restarts, so a lesson tab keeps working after serve.py restarts."""
    f = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "lens" / "token"
    if not f.is_file():
        f.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, secrets.token_urlsafe(24).encode())
        os.close(fd)
    return f.read_text().strip()


def claude_cmd(model, session, system):
    cmd = [os.environ.get("LENS_CLAUDE") or shutil.which("claude") or "claude", "-p", "--model", model,
           # no settings, hooks or MCP from the explained repo (it may be untrusted); no auto-memory, so
           # answers come from the code, not from your private session notes
           "--tools", "Read,Grep,Glob", "--setting-sources", "", "--strict-mcp-config",
           "--settings", '{"autoMemoryEnabled": false, "disableAllHooks": true}',
           "--system-prompt", system, "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    if session:
        cmd += ["--resume", session]
    return cmd


def events(proc):
    """Turn Claude Code's stream-json into the small event list the page understands."""
    wrote_text = False
    for line in proc.stdout:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        t = d.get("type")
        if t == "stream_event":
            e = d.get("event", {})
            if e.get("type") == "content_block_start" and e.get("content_block", {}).get("type") == "text" and wrote_text:
                yield {"t": "text", "v": "\n\n"}
            elif e.get("type") == "content_block_delta" and e.get("delta", {}).get("type") == "text_delta":
                wrote_text = True
                yield {"t": "text", "v": e["delta"]["text"]}
        elif t == "assistant":
            for c in d.get("message", {}).get("content", []):
                if c.get("type") == "tool_use":
                    i = c.get("input", {})
                    target = i.get("file_path") or i.get("pattern") or i.get("path") or ""
                    yield {"t": "tool", "v": f"{c.get('name')} {target}".strip()}
        elif t == "result":
            if d.get("is_error"):
                yield {"t": "error", "v": str(d.get("result") or d.get("subtype") or "Claude returned an error")}
            if d.get("session_id"):  # only once the turn is saved, so --resume of a stopped turn cannot fail
                yield {"t": "session", "v": d["session_id"]}


class Handler(BaseHTTPRequestHandler):
    server_version = "lens"

    def log_message(self, fmt, *args):
        if os.environ.get("LENS_SERVE_LOG"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Content-Security-Policy", "connect-src 'self'; img-src 'self' data: blob:; form-action 'self'")
        super().end_headers()

    def _same_origin(self):
        # Only pages served by this server may call it: blocks other sites and DNS rebinding.
        port = self.server.server_address[1]
        ok = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("Origin")
        return self.headers.get("Host") in ok and (origin is None or origin.removeprefix("http://") in ok)

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else (json.dumps(body) if ctype == "application/json" else body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._same_origin():
            return self._send(403, {"error": "forbidden"})
        cfg, path = self.server.cfg, self.path.split("?")[0]
        if path == "/__lens/health":
            return self._send(200, {"lens": 1, "dir": str(cfg["dir"]), "lesson": cfg["lesson"], "repo": str(cfg["repo"]), "models": list(MODELS), "model": cfg["model"]})
        if path == "/":
            name = html.escape(cfg["lesson"])
            keep_key = "<script>for (const a of document.links) a.href += location.hash</script>"   # the link keeps #k=
            return self._send(200, f'<!doctype html><meta charset=utf-8><title>lens</title><ul><li><a href="/{name}">{name}</a></li></ul>{keep_key}', "text/html")
        name = path.lstrip("/")
        f = cfg["dir"] / name
        # Clients keep the key in origin-wide storage. Never serve sibling HTML on this origin.
        if name == cfg["lesson"] and re.fullmatch(r"[\w.-]+\.html", name) and f.is_file():
            return self._send(200, f.read_bytes(), "text/html")
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._same_origin():
            return self._send(403, {"error": "forbidden"})
        if self.path != "/__lens/ask":
            return self._send(404, {"error": "not found"})
        if not secrets.compare_digest(self.headers.get("X-Lens-Key") or "", self.server.cfg["key"]):
            return self._send(403, {"error": "This tab has no key for the lens helper. Reopen the lesson from the link serve.py printed."})
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self._send(415, {"error": "send JSON"})
        try:
            req = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 200_000)))
        except ValueError:
            return self._send(400, {"error": "bad JSON"})
        if not isinstance(req, dict) or not all(isinstance(req.get(k) or "", str) for k in ("q", "model", "session", "lesson", "quote", "where", "mode", "context")):
            return self._send(400, {"error": "bad request"})
        if (req.get("mode") or "") not in ("", "report"):
            return self._send(400, {"error": "mode must be report"})
        model, session = req.get("model") or self.server.cfg["model"], req.get("session")
        if model not in MODELS:
            return self._send(400, {"error": f"model must be one of {', '.join(MODELS)}"})
        if not (req.get("q") or "").strip():
            return self._send(400, {"error": "empty question"})
        if session and not re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", session):
            return self._send(400, {"error": "bad session id"})
        report = req.get("mode") == "report"
        system = (REPORT if report else TUTOR) + (f'\n\nThe {"page" if report else "lesson"} is titled "{req["lesson"]}".' if req.get("lesson") else "")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.ask(claude_cmd(model, session, system), build_prompt(req))

    def ask(self, cmd, prompt):
        erred = False

        def emit(ev):
            nonlocal erred
            erred = erred or ev["t"] == "error"
            self.wfile.write((json.dumps(ev) + "\n").encode())
            self.wfile.flush()

        errf = tempfile.TemporaryFile("w+", encoding="utf-8")
        try:
            proc = subprocess.Popen(cmd, cwd=self.server.cfg["repo"], text=True, encoding="utf-8", errors="replace",
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errf, start_new_session=True)
        except OSError as e:
            errf.close()
            return emit({"t": "error", "v": f"Could not start Claude Code: {e}"})

        def stop():  # kill claude and anything it started (rg and friends)
            try:
                os.killpg(proc.pid, signal.SIGKILL) if hasattr(os, "killpg") else proc.kill()
            except OSError:
                pass

        timed_out = threading.Event()
        timer = threading.Timer(TIMEOUT, lambda: (timed_out.set(), stop()))
        timer.start()

        def watch():  # the reader pressed Stop or closed the tab while claude was quiet (thinking, reading)
            while proc.poll() is None:
                if select.select([self.connection], [], [], 0.5)[0]:
                    try:
                        gone = self.connection.recv(1, socket.MSG_PEEK) == b""
                    except OSError:
                        gone = True
                    if gone:
                        return stop()

        threading.Thread(target=watch, daemon=True).start()
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
            for ev in events(proc):
                emit(ev)
            if proc.wait() != 0 and not erred:
                errf.seek(0)
                err = errf.read().strip().splitlines()
                emit({"t": "error", "v": f"No answer within the {TIMEOUT}-second limit, so it was stopped." if timed_out.is_set()
                      else err[-1] if err else f"claude exited with code {proc.returncode}"})
            emit({"t": "done"})
        except (BrokenPipeError, ConnectionResetError):
            stop()
        finally:
            timer.cancel()
            errf.close()
            if proc.poll() is None:
                stop()
            proc.wait()


def running(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/__lens/health", timeout=1) as r:
            return json.load(r)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lesson", help="a lesson .html file (only this file is served on this port)")
    ap.add_argument("--repo", help="repo Claude reads from (default: the folder above .lens/, else the lesson's folder)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("LENS_PORT", 4174)))
    ap.add_argument("--model", default=os.environ.get("LENS_MODEL", "haiku"), choices=MODELS)
    ap.add_argument("--open", action="store_true", help="open the lesson in the browser")
    a = ap.parse_args()
    lesson = Path(a.lesson).resolve()
    if not lesson.is_file():
        sys.exit(f"no such lesson: {lesson}")
    folder = lesson.parent
    repo = Path(a.repo).resolve() if a.repo else folder.parent if folder.name == ".lens" else folder
    key = token()
    for port in range(a.port, a.port + 20):
        info = running(port)
        if info and info.get("dir") == str(folder) and info.get("lesson") == lesson.name:
            url = f"http://127.0.0.1:{port}/{lesson.name}#k={key}"
            print(f"already serving {folder}: {url}")
            if a.open:
                webbrowser.open(url)
            return
        if info:
            continue
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    else:
        sys.exit(f"no free port in {a.port}-{a.port + 19}")
    srv.daemon_threads = True
    srv.cfg = {"dir": folder, "lesson": lesson.name, "repo": repo, "model": a.model, "key": key}
    url = f"http://127.0.0.1:{port}/{lesson.name}#k={key}"
    print(f"lens: {url}  (Claude reads {repo}; Ctrl-C to stop)", flush=True)
    if not (os.environ.get("LENS_CLAUDE") or shutil.which("claude")):
        print("warn: `claude` not found on PATH, so asking will fail; the lesson still works", flush=True)
    if a.open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
