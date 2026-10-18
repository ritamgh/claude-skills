#!/usr/bin/env bash
# Test: phone alerts. Only top-level leads' summaries and decisions (hold/ask) alert; state changes and
# `crew watch` stay silent unless CREW_NOTIFY_WATCH=1. crew-notify retries once on 5xx. A fake crew-notify
# on PATH records every call, and the real one talks to a local stub server, so nothing leaves the machine.
#   bash test-crew-notify.sh
set -uo pipefail

BIN=$(dirname "$(readlink -f "$0")")
CREW=$BIN/crew
NOTIFY=$BIN/crew-notify
T=$(mktemp -d)
BGS=""
trap 'kill $BGS 2>/dev/null; chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"' EXIT
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_NOW=2026-10-16T10:00:00Z CREW CREW_LEAD_COMM
CREW_LEAD_COMM=$(cat /proc/$$/comm)
export HOME=$T/home XDG_CONFIG_HOME=$T/xdg
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log
mkdir -p "$CREW_SESSIONS" "$T/fakebin"
fails=0

check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
same() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }

# a crew-notify that only records "title|body" per call
CALLS=$T/calls
cat >"$T/fakebin/crew-notify" <<FAKE
#!/usr/bin/env bash
printf '%s|%s\n' "\$1" "\$2" >>"$CALLS"
FAKE
chmod +x "$T/fakebin/crew-notify"
export PATH=$T/fakebin:$PATH
calls() { cat "$CALLS" 2>/dev/null || true; }
reset() { rm -f "$CALLS"; }

as() { # as NAME SID cmd...: run inside a fresh process that is session NAME/SID
  local name=$1 sid=$2; shift 2
  bash -c 'printf "{\"pid\":%s,\"name\":\"%s\",\"sessionId\":\"%s\"}\n" "$$" "$1" "$2" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"' _ "$name" "$sid" "$@" 2>&1
}
live_sub() { # NAME SID: a long-running process that is that session
  bash -c 'printf "{\"pid\":%s,\"name\":\"%s\",\"sessionId\":\"%s\"}\n" "$$" "$1" "$2" >"$CREW_SESSIONS/bg-$2.json"; while :; do sleep 1; done' _ "$1" "$2" &
  BGS="$BGS $!"; sleep 0.3
}
new_task() { "$CREW" new "$1" --shape scout "intent" | sed -n 's/^id=//p'; }

# --- state changes are silent ---
id=$(new_task phone-notify-leads)
"$CREW" log "$id" running "part 1"
for st in review done landed failed; do "$CREW" log "$id" "$st" "note $st"; done
same "log review/done/landed/failed sends no alert" "" "$(calls)"

# --- summary: no session (plain shell) sends nothing ---
"$CREW" summary "$id" "**Shell verdict.**" >/dev/null
same "summary from a shell with no session sends no alert" "" "$(calls)"

# --- summary: top-level lead ---
printf '{"pid":%s,"name":"lead-a","sessionId":"SID-A"}\n' "$$" >"$CREW_SESSIONS/lead-a.json"
live_sub review-1 SID-R
as review-1 SID-R "$CREW" join lead-a >/dev/null
"$CREW" summary "$id" "## **Shipped** the \`crew\` fix, see [the notes](http://x/y)
Second line is not sent." >/dev/null
same "summary from a top-level lead sends one alert: lead: short name, first line without markdown" \
  "lead-a: phone-notify-leads|Shipped the crew fix, see the notes" "$(calls)"

reset
"$CREW" summary "$id" "## **Shipped** the \`crew\` fix, see [the notes](http://x/y)
Second line is not sent." >/dev/null
same "saving the same summary text again sends no second alert" "" "$(calls)"
"$CREW" summary "$id" "Different verdict now." >/dev/null
same "a changed summary alerts again" "lead-a: phone-notify-leads|Different verdict now." "$(calls)"

reset
long=$(printf 'x%.0s' $(seq 1 300))
id2=$(new_task long-one)
"$CREW" summary "$id2" "$long" >/dev/null
same "the body is cut to 200 characters" "lead-a: long-one|$(printf 'x%.0s' $(seq 1 200))" "$(calls)"

# --- summary: sub-lead sends nothing ---
reset
id3=$(new_task sub-task)
as review-1 SID-R "$CREW" summary "$id3" "Sub verdict." >/dev/null
same "summary from a sub-lead with a live parent sends no alert" "" "$(calls)"
check "the sub's summary is still saved" grep -qxF "Sub verdict." "$CREW_ROOT/$id3/summary.md"

# --- decisions alert, from any session ---
reset
id4=$(new_task pick-db)
"$CREW" meta "$id4" lead=lead-a
d=$("$CREW" hold "$id4" "Which DB: sqlite or postgres?")
same "hold alerts once, titled lead: D<n>, body the question" "lead-a: $d|Which DB: sqlite or postgres?" "$(calls)"
reset
as review-1 SID-R "$CREW" ask "$id4" "and the port?" >/dev/null
same "ask from a sub session alerts, titled lead: D<n>" "lead-a: $d|and the port?" "$(calls)"

# --- watch: silent by default ---
reset
id5=$(new_task stalled-one)
"$CREW" log "$id5" running "start"
# the status line is from CREW_NOW 2026-10-16; the real clock is later, so the task looks stalled
(unset CREW_NOW; "$CREW" watch)
same "watch sends no alert by default" "" "$(calls)"
(unset CREW_NOW; CREW_NOTIFY_WATCH=1 "$CREW" watch)
same "watch alerts with CREW_NOTIFY_WATCH=1" "$id5: stalled?|running, no status line for $(( ($(date +%s) - $(date -d 2026-10-16T10:00:00Z +%s)) / 60 )) min: start" "$(calls)"

# --- crew-notify: retry on 5xx, --test ---
cat >"$T/stub.py" <<'PY'
import http.server, sys
codes = [int(c) for c in sys.argv[2].split(",")]
log = open(sys.argv[1], "a")
class H(http.server.BaseHTTPRequestHandler):
    n = 0
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with open(sys.argv[1] + ".body", "ab") as f:
            f.write(body + b"\n")
        code = codes[min(H.n, len(codes) - 1)]; H.n += 1
        log.write("%s %s %s\n" % (code, self.path, self.headers.get("Title"))); log.flush()
        with open(sys.argv[1] + ".headers", "a") as headers:
            for key, value in self.headers.items():
                headers.write("%s: %s\n" % (key, value))
        self.send_response(code); self.end_headers()
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[3], "w").write(str(s.server_port))
s.serve_forever()
PY
conf() { # CODES: start a stub answering those codes in turn (requests land in $T/hits) and point the config at it
  rm -f "$T/hits" "$T/hits.headers" "$T/hits.body" "$T/port"
  python3 -I "$T/stub.py" "$T/hits" "$1" "$T/port" >/dev/null 2>&1 &
  BGS="$BGS $!"
  for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
  conf_url "http://127.0.0.1:$(cat "$T/port")"
}
conf_url() { printf '[phone]\nserver = "%s"\ntopic = "secret-topic-xyz"\n' "$1" >"$T/notify.toml"; export CREW_NOTIFY_CONFIG=$T/notify.toml; }
export CREW_NOTIFY_RETRY_DELAY=0.2
run_notify() { PATH=${PATH#"$T/fakebin:"} "$NOTIFY" "$@"; }

conf 502,200; : >"$CREW_NOTIFY_LOG"
run_notify "t" "b"; rc=$?
same "crew-notify retries once after a 502 and succeeds" "502 /secret-topic-xyz t
200 /secret-topic-xyz t" "$(cat "$T/hits")"
same "crew-notify exits 0" "0" "$rc"
same "a retried success logs nothing" "" "$(cat "$CREW_NOTIFY_LOG")"

conf 502; : >"$CREW_NOTIFY_LOG"
run_notify "t" "b"; rc=$?
same "crew-notify tries exactly twice on a persistent 502" "2" "$(wc -l <"$T/hits")"
same "a persistent 502 still exits 0" "0" "$rc"
check "a persistent 502 is logged once" bash -c '[ "$(grep -c "http 502" "$0")" = 1 ]' "$CREW_NOTIFY_LOG"

conf 404,200; : >"$CREW_NOTIFY_LOG"
run_notify "t" "b"
same "a 4xx is not retried" "1" "$(wc -l <"$T/hits")"

conf 200
same "--test prints sent when the server accepts" "sent" "$(run_notify --test)"
same "--test sends 'crew: test alert'" "200 /secret-topic-xyz crew: test alert" "$(cat "$T/hits")"
conf 502
out=$(run_notify --test); rc=$?
same "--test prints the http code on failure and nothing else" "failed: http 502" "$out"
same "--test exits 1 on failure" "1" "$rc"
check "--test output never contains the topic" bash -c '! grep -q secret-topic-xyz <<<"$0"' "$out"
conf_url "http://127.0.0.1:1"
out=$(run_notify --test)
check "--test on an unreachable server says failed and hides the topic" bash -c 'case "$0" in "failed: "*) ! grep -q secret-topic-xyz <<<"$0" ;; *) false ;; esac' "$out"
# Reverting the config lookup breaks the explicit override and both default paths.
conf 200
same "CREW_NOTIFY_CONFIG overrides the default path" "sent" "$(run_notify --test)"
mkdir -p "$XDG_CONFIG_HOME/crew" "$HOME/.config/crew"
ln -s "$CREW_NOTIFY_CONFIG" "$XDG_CONFIG_HOME/crew/notify.toml"
ln -s "$CREW_NOTIFY_CONFIG" "$HOME/.config/crew/notify.toml"
same "XDG config default supports a symlink to existing TOML" "sent" "$(unset CREW_NOTIFY_CONFIG; run_notify --test)"
same "HOME config default is used without XDG_CONFIG_HOME" "sent" "$(unset CREW_NOTIFY_CONFIG XDG_CONFIG_HOME; run_notify --test)"
export CREW_NOTIFY_CONFIG=$T/no-such-config
same "--test without a config says why" "failed: no crew notify config" "$(run_notify --test)"

# --- sensitive curl options stay off argv; titles cannot inject headers ---
conf 200
printf 'token = "test-bearer-secret"\n' >>"$CREW_NOTIFY_CONFIG"
export REAL_CURL
REAL_CURL=$(command -v curl)
export CURL_ARGV=$T/curl.argv CURL_STDIN=$T/curl.stdin
mkdir -p "$T/curlbin"
cat >"$T/curlbin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$CURL_ARGV"
cat >"$CURL_STDIN"
exec "$REAL_CURL" "$@" <"$CURL_STDIN"
SH
chmod +x "$T/curlbin/curl"
PATH="$T/curlbin:$PATH" run_notify $'task\r\nClick: http://x\t\001\177' "body"
check "bearer token never appears in curl argv" bash -c 'test -s "$1" && ! grep -qF test-bearer-secret "$1"' _ "$CURL_ARGV"
check "topic URL never appears in curl argv" bash -c 'test -s "$1" && ! grep -qF secret-topic-xyz "$1"' _ "$CURL_ARGV"
check "curl receives sensitive configuration on stdin" test -s "$CURL_STDIN"
same "title control characters are stripped on the wire" "200 /secret-topic-xyz taskClick: http://x" "$(cat "$T/hits")"
same "only one Title header reaches the server" "1" "$(grep -c '^Title:' "$T/hits.headers")"
check "title cannot inject a Click header" bash -c 'test -s "$1" && ! grep -qi "^Click:" "$1"' _ "$T/hits.headers"
check "bearer authentication still reaches the server" grep -qxF 'Authorization: Bearer test-bearer-secret' "$T/hits.headers"

# --- an alert body starting with @ is sent as text, never read as a file (curl -d @path would post the file) ---
conf 200
printf 'secret-file-marker-8f3a1c\n' >"$T/secret.txt"
run_notify "t" "@$T/secret.txt"
same "an @path body reaches the server as the literal text" "@$T/secret.txt" "$(cat "$T/hits.body")"
check "the file an @path body names is never sent" bash -c '! grep -qF secret-file-marker-8f3a1c "$1"' _ "$T/hits.body"

# --- no other test can reach the user's real phone: every crew test points crew-notify at a missing config ---
unguarded=$(cd "$BIN" && grep -L 'CREW_NOTIFY_CONFIG=' $(grep -l crew test-*.sh ../hooks/test-*.sh | grep -vx test-crew-notify.sh) 2>/dev/null | tr '\n' ' ')
check "every test that mentions crew sets CREW_NOTIFY_CONFIG= (unguarded: ${unguarded:-none})" test -z "$unguarded"
# ...and finds this checkout's crew-notify first: an older one installed on PATH may ignore CREW_NOTIFY_CONFIG (the hooks test never runs crew)
nopath=$(cd "$BIN" && grep -LF -e 'readlink -f "$0")"):$PATH' -e 'export PATH="$BIN:$PATH"' $(grep -l crew test-*.sh | grep -vx test-crew-notify.sh) 2>/dev/null | tr '\n' ' ')
check "every crew test puts this checkout's bin first on PATH (offenders: ${nopath:-none})" test -z "$nopath"

# --- an older crew-notify earlier on PATH (stood in for by a sentinel) is never reached by tests that alert ---
mkdir -p "$T/older"
printf '#!/bin/sh\necho called >>"%s"\n' "$T/older.log" >"$T/older/crew-notify"
chmod +x "$T/older/crew-notify"
for t in test-crew-summary.sh test-crew-chain.sh; do
  PATH="$T/older:$PATH" CREW_NOTIFY_CONFIG=$T/no-such-config bash "$BIN/$t" >"$T/$t.out" 2>&1
  same "$t passes with an older crew-notify first on PATH" "0" "$?"
done
check "no older crew-notify on PATH was ever called" test ! -s "$T/older.log"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
