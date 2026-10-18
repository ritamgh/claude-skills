"""`plan page` tests. Each docstring names the production regression it catches."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = Path(__file__).resolve().parent
CLI = HERE.parent / "scripts/plan.py"
TASK = "1020-page"


class FakeHQ(ThreadingHTTPServer):
    """A real HTTP server standing in for hq-web: `reply` is (status, body) for /healthz."""
    daemon_threads = True

    def __init__(self, reply, delay=0):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(handler):
                self.seen.append((handler.path, dict(handler.headers)))
                time.sleep(delay)
                status, body = self.reply
                handler.send_response(status)
                handler.send_header("Content-Type", "application/json")
                handler.end_headers()
                try:
                    handler.wfile.write(body.encode())
                except BrokenPipeError:  # the hung-server test hangs up first
                    pass

            def log_message(handler, *args):
                pass
        super().__init__(("127.0.0.1", 0), Handler)
        self.reply = reply
        self.seen = []
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_address[1]}"


LIVE = (200, json.dumps({"service": "hq-web", "plan": True}))


class PageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = dict(os.environ, CREW_ROOT=str(Path(self.temp.name) / "crew"), PYTHONDONTWRITEBYTECODE="1")
        self.env.pop("HQ_WEB_URL", None)
        self.env.pop("HQ_WEB_PORT", None)
        self.cli("init", TASK, "--title", "Page demo")

    def run_cli(self, *args, **env):
        return subprocess.run([sys.executable, str(CLI), *args], env=dict(self.env, **env),
                              text=True, capture_output=True, timeout=30)

    def cli(self, *args):
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def event(self, event, by="user"):
        self.cli("event", TASK, "--by", by, "--source", "page", "--json", json.dumps(event))

    def park_questions(self):
        for qid in ("Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"):
            self.event({"type": "park", "node": qid})

    def serve(self, reply, delay=0):
        server = FakeHQ(reply, delay)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def page(self, server, *extra):
        return self.run_cli("page", TASK, *extra, HQ_WEB_URL=server.url)

    def test_live_hq_exits_0_with_link_and_status_line(self):
        """Fails if a live HQ is reported with a wrong link, a wrong exit code, or a status line that is not line 2."""
        server = self.serve(LIVE)
        result = self.page(server)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            f"{server.url}/plan/{TASK}",
            "frame · 0/7 settled · waiting for your answer on Q1: "
            "Tell one concrete story: who hits the problem, what happens,",
        ])
        self.assertEqual(result.stderr, "")
        self.assertEqual([path for path, _ in server.seen], ["/healthz"])

    def test_healthz_request_carries_no_credentials(self):
        """Fails if the probe sends an Authorization header or cookie to whatever answers on the port."""
        server = self.serve(LIVE)
        self.page(server)
        headers = {key.lower() for key in server.seen[0][1]}
        self.assertFalse(headers & {"authorization", "cookie", "x-hq-token"}, headers)

    def test_any_200_is_not_live(self):
        """Fails if any 200 counts as live: a foreign service on the port must read 'not hq-web'."""
        for body in (json.dumps({"service": "nginx", "plan": True}), "<html>hello</html>"):
            with self.subTest(body=body):
                result = self.page(self.serve((200, body)))
                self.assertEqual(result.returncode, 1)
                self.assertIn("not hq-web", result.stderr)
                self.assertEqual(len(result.stdout.splitlines()), 2)

    def test_plan_routes_missing_is_not_live(self):
        """Fails if an HQ answering plan:false (old build without the routes) is treated as live."""
        result = self.page(self.serve((200, json.dumps({"service": "hq-web", "plan": False}))))
        self.assertEqual(result.returncode, 1)
        self.assertIn("HQ is running without the plan routes: restart it", result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 2)

    def test_missing_healthz_is_not_live(self):
        """Fails if the 404/401 of an HQ that predates /healthz is mistaken for live or for unreachable."""
        for status in (404, 401):
            with self.subTest(status=status):
                result = self.page(self.serve((status, "{}")))
                self.assertEqual(result.returncode, 1)
                self.assertIn("HQ has no /healthz: it predates the plan page, restart it", result.stderr)

    def test_connection_refused_is_unreachable(self):
        """Fails if a closed port crashes with a traceback or exits 0 instead of 1 with 'unreachable'."""
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        result = self.run_cli("page", TASK, HQ_WEB_URL=f"http://127.0.0.1:{port}")
        self.assertEqual(result.returncode, 1)
        self.assertIn("unreachable", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], f"http://127.0.0.1:{port}/plan/{TASK}")

    def test_non_http_service_is_not_hq_web_without_a_traceback(self):
        """Fails if http.client errors (BadStatusLine from a non-HTTP service on the port) escape hq_reason as a traceback."""
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        self.addCleanup(listener.close)

        def banner():
            conn, _ = listener.accept()
            with conn:
                conn.recv(4096)
                conn.sendall(b"SSH-2.0-x\r\n")

        thread = threading.Thread(target=banner, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        result = self.run_cli("page", TASK, HQ_WEB_URL=f"http://127.0.0.1:{listener.getsockname()[1]}")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not hq-web", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_hung_server_times_out_as_unreachable(self):
        """Fails if the probe has no timeout: a server that accepts and never answers would hang the session."""
        started = time.monotonic()
        result = self.page(self.serve(LIVE, delay=4))
        self.assertLess(time.monotonic() - started, 3.5)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unreachable", result.stderr)

    def test_no_plan_exits_3_before_probing(self):
        """Fails if a missing plan is reported as not live (1) instead of the existing no-plan code 3."""
        server = self.serve(LIVE)
        result = self.run_cli("page", "9999-missing", HQ_WEB_URL=server.url)
        self.assertEqual(result.returncode, 3)
        self.assertIn("No plan for 9999-missing", result.stderr)
        self.assertEqual(server.seen, [])

    def test_default_base_uses_hq_web_port(self):
        """Fails if the link ignores HQ_WEB_PORT or does not fall back to 127.0.0.1 when HQ_WEB_URL is unset."""
        result = self.run_cli("page", TASK, HQ_WEB_PORT="1")
        self.assertEqual(result.stdout.splitlines()[0], f"http://127.0.0.1:1/plan/{TASK}")
        result = self.run_cli("page", TASK)
        self.assertEqual(result.stdout.splitlines()[0], f"http://127.0.0.1:7717/plan/{TASK}")

    def test_trailing_slash_in_base_url_is_dropped(self):
        """Fails if HQ_WEB_URL with a trailing slash produces a '//plan/' link."""
        server = self.serve(LIVE)
        result = self.run_cli("page", TASK, HQ_WEB_URL=server.url + "/")
        self.assertEqual(result.stdout.splitlines()[0], f"{server.url}/plan/{TASK}")

    def test_only_requests_open_waits_for_the_session(self):
        """Fails if open requests with an empty frontier read as 'nothing' and the user's note is forgotten."""
        self.park_questions()
        self.event({"type": "note", "text": "please add a risk lane"})
        result = self.page(self.serve(LIVE))
        self.assertEqual(result.stdout.splitlines()[1], "frame · 0/7 settled · waiting for the session")

    def test_nothing_pending_waits_for_nothing(self):
        """Fails if an empty frontier with no requests still names a person or the session."""
        self.park_questions()
        result = self.page(self.serve(LIVE))
        self.assertEqual(result.stdout.splitlines()[1], "frame · 0/7 settled · waiting for nothing")

    def test_frontier_wins_over_requests(self):
        """Fails if open requests mask the pending question: the frontier question must still be named."""
        self.event({"type": "note", "text": "a side note"})
        result = self.page(self.serve(LIVE))
        self.assertIn("waiting for your answer on Q1: ", result.stdout.splitlines()[1])

    def test_json_output(self):
        """Fails if --json drops a key, mislabels live, or prints a bare reason for a not-live HQ."""
        live = json.loads(self.page(self.serve(LIVE), "--json").stdout)
        self.assertEqual(live, {
            "url": live["url"], "live": True, "reason": None,
            "status": live["status"]})
        self.assertTrue(live["url"].endswith(f"/plan/{TASK}"))
        self.assertTrue(live["status"].startswith("frame · 0/7 settled · waiting for your answer on Q1: "))
        down = self.page(self.serve((200, json.dumps({"service": "hq-web", "plan": False}))), "--json")
        self.assertEqual(down.returncode, 1)
        payload = json.loads(down.stdout)
        self.assertIs(payload["live"], False)
        self.assertEqual(payload["reason"], "HQ is running without the plan routes: restart it")
        self.assertEqual(set(payload), {"url", "live", "reason", "status"})

    def test_short_label_is_kept_whole(self):
        """Fails if the 60-character cut pads or alters a label that is already shorter than 60."""
        self.event({"type": "edit_label", "node": "Q1", "label": "Who is it for?"}, by="session")
        result = self.page(self.serve(LIVE))
        self.assertEqual(result.stdout.splitlines()[1],
                         "frame · 0/7 settled · waiting for your answer on Q1: Who is it for?")


if __name__ == "__main__":
    unittest.main()
