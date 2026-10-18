#!/bin/bash
# Test: `crew go TARGET` (the handler behind a tmux://TARGET link) selects a tmux window, switches the attached client
# to its session when the client is elsewhere, never types into a pane, and refuses anything but a plain target
# before a single tmux command runs. Real tmux on a PRIVATE server (tmux -L crewgo-test-$$, via CREW_TMUX_SOCKET; the
# default server is never touched); a control-mode client stands in for the user's attached terminal. A shim tmux in
# PATH logs every call it is given, then runs the real one.
#   bash test-crew-go.sh
set -uo pipefail

unset TMUX TMUX_PANE
CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
TS=crewgo-test-$$
real_tmux=$(command -v tmux)
export LC_ALL=C.UTF-8 CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_TMUX_SOCKET=$TS T
export CREW_NOTIFY_CONFIG=/nonexistent CREW_NOTIFY_LOG=$T/notify.log
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"
mkdir -p "$T/bin" "$CREW_ROOT" "$CREW_SESSIONS"
CLPID=""
cleanup() {
  [ -z "$CLPID" ] || kill "$CLPID" 2>/dev/null
  exec 7>&- 2>/dev/null
  "$real_tmux" -L "$TS" kill-server 2>/dev/null
  rm -rf "$T"
}
trap cleanup EXIT
printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"$T/tmux.log"\nexec %s "$@"\n' "$real_tmux" >"$T/bin/tmux"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"$T/notify.log"\n' >"$T/bin/notify-send"   # no desktop popup from the handler's failures
chmod +x "$T/bin/tmux" "$T/bin/notify-send"
export PATH=$T/bin:$PATH
SRV() { "$real_tmux" -L "$TS" "$@"; }

SRV new-session -d -x 120 -y 40 -s a -n w0 'sleep 600'
SRV new-window -d -t =a: -n w1 'sleep 600'
SRV new-window -d -t =a: -n w2 'sleep 600'
SRV split-window -d -t =a:1 'sleep 600'      # a:1 has panes 0 and 1
SRV new-session -d -x 120 -y 40 -s b -n x0 'sleep 600'
SRV new-window -d -t =b: -n x1 'sleep 600'
SRV select-window -t =a:0
SRV select-pane -t =a:1.0
# the user's terminal: a control-mode client attached to session a (its stdin is a fifo we keep open on fd 7)
mkfifo "$T/ctl"
SRV -C attach -t =a <"$T/ctl" >/dev/null 2>&1 &
CLPID=$!
exec 7>"$T/ctl"
for _ in $(seq 1 50); do [ -n "$(SRV list-clients 2>/dev/null)" ] && break; sleep 0.1; done

fails=0
check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }
active() { SRV list-windows -t "=$1:" -F '#{?window_active,#{window_index},}' | grep . ; }    # the active window index of session $1
active_pane() { SRV list-panes -t "=$1:$2" -F '#{?pane_active,#{pane_index},}' | grep . ; }
client_sess() { SRV list-clients -F '#{client_session}'; }
run() { out=$("$CREW" go "$@" 2>&1); rc=$?; }       # sets $out and $rc
: >"$T/tmux.log"

eq "setup: client on a, a:0 active" "a 0" "$(client_sess) $(active a)"

# --- selects the window. Fails if go never calls select-window (or selects another index) ---
run a:2
eq "go a:2 exits 0" "0" "$rc"
eq "go a:2 makes window 2 of session a active" "2" "$(active a)"
eq "go a:2 stays on session a" "a" "$(client_sess)"
check "go a:2 does not switch the client when it is already on a" bash -c '! grep -q switch-client "$T/tmux.log"'

# --- a pane suffix selects the pane. Fails if the .PANE part is dropped ---
run a:1.1
eq "go a:1.1 exits 0" "0" "$rc"
eq "go a:1.1 makes window 1 active" "1" "$(active a)"
eq "go a:1.1 makes pane 1 active in it" "1" "$(active_pane a 1)"

# --- a target in another session moves the client. Fails if switch-client is not run (or not with -c CLIENT) ---
run b:1
eq "go b:1 exits 0" "0" "$rc"
eq "go b:1 selects window 1 of b" "1" "$(active b)"
eq "go b:1 switches the attached client to b" "b" "$(client_sess)"
run a:0
eq "go a:0 brings the client back to a" "a 0" "$(client_sess) $(active a)"

# --- it types nothing: no send-keys call, ever. Fails if go ever sends keys to a pane ---
check "no tmux send-keys was run" bash -c '! grep -q "send-keys" "$T/tmux.log"'

# --- a task id resolves through meta window_id. Fails if go ignores the recorded window id ---
wid_x1=$(SRV list-windows -t =b: -F '#{window_id} #{window_name}' | awk '$2 == "x1" {print $1}')
mkdir -p "$CREW_ROOT/task-a"; printf 'shape=ship\nwindow=claude:x1\nwindow_id=%s\n' "$wid_x1" >"$CREW_ROOT/task-a/meta"
run task-a
eq "go <task id> exits 0" "0" "$rc"
eq "go <task id> selects the task's window and moves the client" "1 b" "$(active b) $(client_sess)"
SRV select-window -t =b:0; run a:0
mkdir -p "$CREW_ROOT/task-gone"; printf 'window_id=@9999\n' >"$CREW_ROOT/task-gone/meta"
run task-gone
eq "a task whose window is gone: exit 1, one line" "1 1" "$rc $(wc -l <<<"$out")"
case "$out" in *gone*) echo "ok   ... and it says the window is gone" ;; *) echo "FAIL reason: $out"; fails=$((fails + 1)) ;; esac
mkdir -p "$CREW_ROOT/task-plain"; printf 'shape=ship\n' >"$CREW_ROOT/task-plain/meta"
run task-plain
eq "a task with no window: exit 1, one line naming it" "1 1" "$rc $(wc -l <<<"$out")"
case "$out" in *"task-plain has no tmux window"*) echo "ok   ... and says so" ;; *) echo "FAIL reason: $out"; fails=$((fails + 1)) ;; esac

# --- a live session name resolves through tmux-map (stubbed). Fails if go cannot turn a name into a target ---
printf '#!/bin/bash\nprintf "lead-x\\tb:0.0\\tx0\\t/x\\tidle\\t5\\t\\t\\n"\n' >"$T/tmap"; chmod +x "$T/tmap"
export CREW_TMUX_MAP=$T/tmap
run lead-x
eq "go <session name> exits 0 and lands on its pane's window" "0 0 b" "$rc $(active b) $(client_sess)"
run nobody
eq "an unknown name: exit 1" "1" "$rc"
run a:0
unset CREW_TMUX_MAP

# --- missing window / session / server: exit 1, one line, nothing changes. Fails if go exits 0 or prints a trace ---
before="$(active a) $(client_sess)"
run a:9
eq "go a:9 (no such window): exit 1, one line" "1 1" "$rc $(wc -l <<<"$out")"
case "$out" in *"no window a:9"*) echo "ok   ... and it names the window" ;; *) echo "FAIL reason: $out"; fails=$((fails + 1)) ;; esac
run a:9.0
eq "go a:9.0 (no such window, pane given): exit 1, one line" "1 1" "$rc $(wc -l <<<"$out")"
run nosuch:0
eq "go nosuch:0 (no such session): exit 1" "1" "$rc"
run a:1.7
eq "go a:1.7 (no such pane): exit 1, one line" "1 1" "$rc $(wc -l <<<"$out")"
eq "failed gos changed nothing" "$before" "$(active a) $(client_sess)"
# the session part is an exact match: "=a:0", not a prefix (tmux would take m:0 for main). Fails if the target is not =-prefixed
SRV new-session -d -x 80 -y 24 -s mainsess -n m0 'sleep 600'
run mainsess:0
eq "an exact session name works" "0" "$rc"
run mains:0
eq "a prefix of a session name is not that session" "1" "$rc"
run a:0
out=$(CREW_TMUX_SOCKET=crewgo-none-$$ "$CREW" go a:0 2>&1); rc=$?
eq "no tmux server: exit 1, one line saying so" "1 1 crew: go: tmux is not running" "$rc $(wc -l <<<"$out") $out"

# --- hostile targets: refused before ANY tmux call, no side effect. Fails if go passes URL text to tmux or a shell ---
: >"$T/tmux.log"
rm -f "$T/pwned"
mkdir -p "$CREW_ROOT/.links"
bad=(
  'a:1;touch $T/pwned' 'a:1; touch $T/pwned' 'a;touch $T/pwned' 'a:1$(touch $T/pwned)' 'a:1`touch $T/pwned`'
  '$(touch $T/pwned):1' '`touch $T/pwned`:1' 'a:1 b' 'a b:1' $'a:1\nb' $'a:1\n' $'a:1\ttouch' $'a:1\r'
  '-t' '-a:1' '--' '--help' '-x:1' 'a:-1' 'a:' ':1' 'a:1.' 'a:1.2.3' 'a:1.b' '=a:1' '../x' 'a/b' '.links' '.hidden' 'a:1|b' 'a:1&b' 'a:1>b'
  "a:1'b" 'a:"1"' 'a:1\x' 'a:1*' 'a:1%' 'tmux://a:1' ''
)
rejected=0
for b in "${bad[@]}"; do
  run "$b"
  if [ "$rc" = 2 ]; then rejected=$((rejected + 1)); else echo "FAIL not refused with exit 2 (rc=$rc): $(printf %q "$b") -> $out"; fails=$((fails + 1)); fi
done
eq "every hostile target exits 2" "${#bad[@]}" "$rejected"
eq "... and ran no tmux command at all" "0" "$(wc -c <"$T/tmux.log" | tr -d ' ')"
check "... and ran no shell code" test ! -e "$T/pwned"
out=$("$CREW" go 2>&1); rc=$?; eq "no argument: exit 2" "2" "$rc"
out=$("$CREW" go a:0 a:1 2>&1); rc=$?; eq "two arguments: exit 2" "2" "$rc"
eq "... still no tmux command" "0" "$(wc -c <"$T/tmux.log" | tr -d ' ')"
out=$(CREW_TMUX_SOCKET='x;y' "$CREW" go a:0 2>&1); rc=$?; eq "a hostile CREW_TMUX_SOCKET is refused too" "2" "$rc"
eq "... with no tmux command" "0" "$(wc -c <"$T/tmux.log" | tr -d ' ')"

# --- the link handler (skills/crew/tmux-link/crew-tmux-open): strips tmux:// and passes only the rest to crew go ---
OPEN=$(dirname "$(readlink -f "$0")")/../skills/crew/tmux-link/crew-tmux-open
export CREW_BIN=$CREW
run_open() { out=$("$OPEN" "$@" 2>&1); rc=$?; }
run a:0
run_open 'tmux://a:2'
eq "tmux://a:2 selects window 2 of a (the handler strips the scheme)" "0 2" "$rc $(active a)"
run_open 'tmux://a:1.1/'
eq "a trailing slash is dropped: tmux://a:1.1/ selects pane 1 of window 1" "0 1 1" "$rc $(active a) $(active_pane a 1)"
run_open 'tmux://b:1'
eq "tmux://b:1 switches the client" "0 b" "$rc $(client_sess)"
run a:0
: >"$T/tmux.log"
hostile_urls=('tmux://a:1;touch $T/pwned' 'tmux://a:1$(touch $T/pwned)' 'tmux://a:1`touch $T/pwned`' 'tmux://-t' 'tmux://a:1 b' $'tmux://a:1\nb' 'tmux://' 'tmux:///' 'https://a:1' 'a:1' '')
ok=0
for u in "${hostile_urls[@]}"; do
  run_open "$u"
  if [ "$rc" != 0 ]; then ok=$((ok + 1)); else echo "FAIL handler accepted $(printf %q "$u") -> $out"; fails=$((fails + 1)); fi
done
eq "every hostile link makes the handler fail" "${#hostile_urls[@]}" "$ok"
eq "... without any tmux command" "0" "$(wc -c <"$T/tmux.log" | tr -d ' ')"
check "... or any shell code" test ! -e "$T/pwned"

echo
if [ "$fails" = 0 ]; then echo "all passed"; else echo "$fails FAILED"; exit 1; fi
