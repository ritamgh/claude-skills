#!/usr/bin/env python3
"""Tests for serve.py against a fake `claude` (scripts/testdata/fake-claude.py). No network, no Claude usage.
Usage: python3 test-serve.py"""
import http.client, json, os, re, socket, stat, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
tmp = Path(tempfile.mkdtemp(prefix="lens-serve-"))
repo, lens = tmp / "repo", tmp / "repo" / ".lens"
lens.mkdir(parents=True)
(lens / "0001-demo.html").write_text("<!doctype html><title>demo</title>hello lesson")
(lens / "0002-untrusted.html").write_text("<!doctype html><script>window.stolen = localStorage.getItem('lens:key')</script>")
(repo / "secret.txt").write_text("not served")
PIDS = tmp / "pids"
env = dict(os.environ, LENS_CLAUDE=str(HERE / "testdata" / "fake-claude.py"), XDG_CONFIG_HOME=str(tmp / "config"), FAKE_PID_FILE=str(PIDS))
SID = "11111111-2222-3333-4444-555555555555"
failed = 0


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def start(port, lesson="0001-demo.html", **extra):
    p = subprocess.Popen([sys.executable, str(HERE / "serve.py"), str(lens / lesson), "--port", str(port)],
                         env={**env, **extra}, stdout=subprocess.PIPE, text=True)
    return p, p.stdout.readline()


PORT = free_port()
srv, banner = start(PORT)
KEY = (re.search(r"#k=([\w-]+)", banner) or [None, ""])[1]


def req(method, path, body=None, headers=None, port=None, include_headers=False):
    port = port or PORT
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    h = {"Host": f"127.0.0.1:{port}", **(headers or {})}
    data = None
    if body is not None:
        data = (body if isinstance(body, bytes) else json.dumps(body).encode()); h.setdefault("Content-Type", "application/json")
    c.request(method, path, body=data, headers=h)
    r = c.getresponse()
    result = r.status, r.read().decode()
    return (*result, r.headers) if include_headers else result


def ask(body, headers=None, port=None):
    code, text = req("POST", "/__lens/ask", body, {"X-Lens-Key": KEY, **(headers or {})}, port)
    return code, [json.loads(l) for l in text.splitlines() if l.strip()] if code == 200 else text


def t(name, fn):
    global failed
    try:
        fn(); print("PASS", name)
    except Exception as e:
        failed += 1; print("FAIL", name, "-", e)


def eq(a, b, m=""):
    if a != b:
        raise AssertionError(f"{m}: {a!r} != {b!r}")


def answer(evs):
    return "".join(e["v"] for e in evs if e["t"] == "text")


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    st = Path(f"/proc/{pid}/stat")  # a zombie still answers kill(0); count it as dead only if reaped
    return not (st.exists() and st.read_text().split(") ")[1].startswith("Z"))


# Each check names the change that would break it.
t("banner prints the lesson URL with its key in the #fragment", lambda: eq(banner.startswith(f"lens: http://127.0.0.1:{PORT}/0001-demo.html#k={KEY} ") and len(KEY) >= 24, True, banner))
t("the key lives in a private file (mode 600)", lambda: eq(stat.S_IMODE((tmp / "config" / "lens" / "token").stat().st_mode), 0o600, "mode"))
t("health reports dir, repo above .lens and default model haiku", lambda: eq(json.loads(req("GET", "/__lens/health")[1]),
  {"lens": 1, "dir": str(lens), "lesson": "0001-demo.html", "repo": str(repo), "models": ["haiku", "sonnet"], "model": "haiku"}))
t("serves a lesson from the folder, without the key in it", lambda: eq(req("GET", "/0001-demo.html"), (200, "<!doctype html><title>demo</title>hello lesson")))
t("index has only the named lesson link, which keeps the #k= fragment", lambda: eq(req("GET", "/"),
  (200, '<!doctype html><meta charset=utf-8><title>lens</title><ul><li><a href="/0001-demo.html">0001-demo.html</a></li></ul>'
        '<script>for (const a of document.links) a.href += location.hash</script>')))
t("sibling HTML cannot read the named lesson's origin-wide stored key", lambda: eq(req("GET", "/0002-untrusted.html")[0], 404))
for path in ("/", "/0001-demo.html"):
    t(f"HTML {path} restricts outbound connections, images and forms with CSP", lambda path=path: eq(
      req("GET", path, include_headers=True)[2].get("Content-Security-Policy"),
      "connect-src 'self'; img-src 'self' data: blob:; form-action 'self'"))


def error_csp():
    code, _, headers = req("OPTIONS", "/0001-demo.html", include_headers=True)
    eq(code, 501, "unsupported method")
    eq(headers.get_content_type(), "text/html", "built-in error is HTML too")
    eq(headers.get("Content-Security-Policy"), "connect-src 'self'; img-src 'self' data: blob:; form-action 'self'")


t("built-in HTML error responses also carry CSP", error_csp)
t("does not serve files outside the folder (path traversal)", lambda: eq(req("GET", "/../secret.txt")[0], 404))
t("does not serve non-html files", lambda: eq(req("GET", "/%2e%2e/secret.txt")[0], 404))
t("rejects a foreign Host (DNS rebinding)", lambda: eq(req("GET", "/__lens/health", headers={"Host": f"evil.test:{PORT}"})[0], 403))
t("rejects a cross-site Origin on ask", lambda: eq(ask({"q": "hi"}, headers={"Origin": "https://evil.test"})[0], 403))
t("rejects an ask without the key (another local user with curl)", lambda: eq(req("POST", "/__lens/ask", {"q": "hi"})[0], 403))
t("rejects an ask with a wrong key", lambda: eq(ask({"q": "hi"}, headers={"X-Lens-Key": "x" * 32})[0], 403))
t("rejects non-JSON bodies (forces a CORS preflight for other sites)", lambda: eq(ask({"q": "hi"}, headers={"Content-Type": "text/plain"})[0], 415))
t("rejects a JSON array body", lambda: eq(ask([1, 2])[0], 400))
t("rejects a non-string question", lambda: eq(ask({"q": 5})[0], 400))
t("rejects models outside haiku/sonnet", lambda: eq(ask({"q": "hi", "model": "opus"})[0], 400))
t("rejects an empty question", lambda: eq(ask({"q": "  "})[0], 400))
t("rejects a malformed session id (no flag injection)", lambda: eq(ask({"q": "hi", "session": "-" * 36})[0], 400))


def first_ask():
    code, evs = ask({"q": "Why two paths?", "model": "haiku", "lesson": "Two paths", "quote": "cheap mode", "where": "The trip, stop 2"},
                    headers={"Origin": f"http://127.0.0.1:{PORT}"})
    eq(code, 200, "status")
    eq([e["t"] for e in evs][:2], ["text", "tool"], "event order")
    eq(evs[1]["v"], "Read /repo/app.py", "tool label")
    eq(evs[-2:], [{"t": "session", "v": SID}, {"t": "done"}], "session only once the turn is saved, then done")
    a = answer(evs)
    eq(a.startswith('Let me look.\n\nmodel=haiku resume=none tools=Read,Grep,Glob settings={"autoMemoryEnabled": false, "disableAllHooks": true} '), True, a[:140])
    eq('PROMPT<<I\'m reading: The trip, stop 2\n\nI selected this from the lesson:\n"""\ncheap mode\n"""\n\nWhy two paths?>>' in a, True, a)


t("first ask: text, tool, then session and done; read-only tools; no repo settings, hooks or memory; prompt has where + quote + question", first_ask)


def follow_up():
    code, evs = ask({"q": "And then?", "model": "sonnet", "session": SID})
    a = answer(evs)
    eq(f"model=sonnet resume={SID}" in a, True, a[:120])
    eq(a.endswith("PROMPT<<And then?>>"), True, a[-40:])


t("follow-up resumes the session with the chosen model", follow_up)
t("a failing claude reports its last stderr line, then done", lambda: eq(ask({"q": "FAIL please"})[1], [{"t": "error", "v": "boom: fake failure"}, {"t": "done"}]))
t("claude's own error result is reported once, not twice", lambda: eq(ask({"q": "ISERR"})[1], [{"t": "error", "v": "Credit balance too low"}, {"t": "done"}]))


def disconnect():
    PIDS.unlink(missing_ok=True)
    s = socket.create_connection(("127.0.0.1", PORT))
    body = json.dumps({"q": "HANG"}).encode()
    s.sendall(f"POST /__lens/ask HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nContent-Type: application/json\r\nX-Lens-Key: {KEY}\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
    for _ in range(50):
        if PIDS.exists() and PIDS.read_text():
            break
        time.sleep(0.1)
    claude_pid, child_pid = map(int, PIDS.read_text().split())
    s.close()  # the reader pressed Stop while claude was silent
    time.sleep(2)
    eq((alive(claude_pid), alive(child_pid)), (False, False), "claude and its child after disconnect")


t("closing the tab while claude is silent kills claude and its children, and reaps them", disconnect)
srv.terminate(); srv.wait()


def timeout():
    port = free_port()
    p, _ = start(port, LENS_ASK_TIMEOUT="2")
    try:
        code, evs = ask({"q": "HANG"}, port=port)
        eq(evs, [{"t": "error", "v": "No answer within the 2-second limit, so it was stopped."}, {"t": "done"}])
    finally:
        p.terminate(); p.wait()


t("a hung claude is stopped at the time limit with a clear message", timeout)


def reuse():
    a, _ = start(PORT)
    b = subprocess.run([sys.executable, str(HERE / "serve.py"), str(lens / "0001-demo.html"), "--port", str(PORT)], env=env, capture_output=True, text=True, timeout=10)
    a.terminate(); a.wait()
    eq(b.stdout.startswith(f"already serving {lens}: http://127.0.0.1:{PORT}/0001-demo.html#k={KEY}"), True, b.stdout)


t("a second serve.py for the same folder reuses the running server, same key", reuse)


def isolate_pages():
    a, _ = start(PORT)
    b = None
    try:
        b, other_banner = start(PORT, lesson="0002-untrusted.html")
        other_port = int(re.search(r"http://127\.0\.0\.1:(\d+)/", other_banner)[1])
        eq(other_port != PORT, True, "different pages must not share browser storage")
        eq(req("GET", "/0002-untrusted.html")[0], 404, "first origin rejects second page")
        eq(req("GET", "/0001-demo.html", port=other_port)[0], 404, "second origin rejects first page")
        eq(req("GET", "/0002-untrusted.html", port=other_port)[0], 200, "explicitly opened second page is served")
    finally:
        if b is not None:
            b.terminate(); b.wait()
        a.terminate(); a.wait()


t("opening another named page uses a separate origin, not the first page's stored key", isolate_pages)
print(f"{'ok' if not failed else 'FAIL'}: {failed} failed")
sys.exit(1 if failed else 0)
