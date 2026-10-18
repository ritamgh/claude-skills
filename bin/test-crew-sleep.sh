#!/usr/bin/env bash
# Test: `crew sleep FEATURE` puts an idle feature owner to sleep: every refusal, the compaction and closing only the
# owner's window, and the self-sleep that waits for the owner's turn to end.
# Real tmux on a private server (tmux -L, TMUX unset) behind a wrapper; the panes run a stand-in `claude` that
# registers a session json for itself, draws a screen (idle / busy / prompt / draft), logs each line typed into it and
# can turn busy for a while after a line (a compaction). The viewing-client test attaches a REAL client to the private
# server through script(1). This script re-executes itself through a symlink named claude so that it is the lead
# session (crew recognises a session by its process name).
#   bash test-crew-sleep.sh
set -uo pipefail

if [ "$(cat /proc/$$/comm)" != claude ]; then
  RX=$(mktemp -d); ln -s "$(command -v bash)" "$RX/claude"
  REEXEC_DIR=$RX exec "$RX/claude" "$(readlink -f "$0")" "$@"
fi
unset TMUX
CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
TS=crewsleep$$
real_tmux=$(command -v tmux)   # LC_ALL below must be a UTF-8 locale: under LC_ALL=C tmux turns the tabs of its list output into "_"
BG=""
trap '"$real_tmux" -L "$TS" kill-server 2>/dev/null; kill $BG 2>/dev/null; rm -rf "$T" "${REEXEC_DIR:-}"' EXIT
mkdir -p "$T/bin" "$T/sessions" "$T/projects/p" "$T/screens"
export LC_ALL=C.UTF-8 CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-16T10:00:00Z T CREW
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
export CREW_COMPACT_SETTLE_S=0.3 CREW_COMPACT_POLL_S=0.2 CREW_COMPACT_WAIT_S=20 CREW_SLEEP_POLL_S=0.3 CREW_SLEEP_WAIT_S=30
unset CREW_LEAD_COMM CREW_AS_USER
# the tmux wrapper (private server). Fault injection, off unless a file exists: T/fail.CMD makes `tmux CMD` fail;
# an executable T/hook.CMD runs just before `tmux CMD` (to change the world at an exact point of a sleep)
printf '#!/bin/bash\n[ ! -e "$T/fail.$1" ] || exit 1\n[ ! -x "$T/hook.$1" ] || "$T/hook.$1" >/dev/null 2>&1 || true\nexec %s -L %s "$@"\n' "$real_tmux" "$TS" >"$T/bin/tmux"
cat >"$T/standin" <<'EOF'
#!/bin/bash
# stand-in claude (run through the claude symlink, so the pane's process is named claude): NAME SID SCREEN [MODE [SECS]].
# Registers itself, draws SCREEN and a composer, logs each line typed into T/typed.NAME.
# MODE sim: after a line it shows a busy screen for SECS (default 1.2) ("compacting"), then idle again.
# MODE busyfirst: busy for SECS first (a turn that is still running), then idle, then as sim.
# A compaction ends the way a real one does: a compact_boundary line (timestamp CREW_NOW) appended to the session transcript
# T/projects/p/SID.jsonl. MODE simnb: as sim but no boundary line ever. MODE simlate: idle at once, the boundary line SECS later.
name=$1 sid=$2 screen=$3 mode=${4:-} secs=${5:-1.2}
jq -nc --argjson pid $$ --arg n "$name" --arg s "$sid" '{pid: $pid, name: $n, sessionId: $s, cwd: "/x"}' >"$CREW_SESSIONS/$sid.json"
boundary() { jq -nc --arg t "$CREW_NOW" --arg s "$sid" '{type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: $t, sessionId: $s}' >>"$CREW_PROJECTS/p/$sid.jsonl"; }
draw() { printf '\033[2J\033[H'; cat "$T/screens/$1"; }
draw "$screen"
case "$screen" in prompt) read -r -t 600 line; exit 0 ;; nocomposer) sleep 600; exit 0 ;; esac
# MODE simhup: as sim, but SIGHUP (the window closing) is only honoured after 1 s of busy waiting; simnohup: never honoured.
spin() { local end=$(( ${EPOCHREALTIME/./} + $1 )); while [ "${EPOCHREALTIME/./}" -lt "$end" ]; do :; done; }
[ "$mode" != simhup ] || { mode=sim; trap 'spin 1000000; exit 0' HUP; }
nb=0; [ "$mode" != simnb ] || { mode=sim; nb=1; }
late=0; [ "$mode" != simlate ] || { mode=sim; late=1; }
nohup=0; [ "$mode" != simnohup ] || { mode=sim; nohup=1; trap '' HUP; }
if [ "$mode" = busyfirst ]; then sleep "$secs"; draw idle; mode=sim; secs=1.2; fi
case "$screen" in draft) printf '❯ Please delete the deployment' ;; *) printf '❯ ' ;; esac
while IFS= read -r line; do
  printf '%s\n' "$line" >>"$T/typed.$name"
  if [ "$mode" = sim ] && [ $late = 0 ]; then draw busy; sleep "$secs"; fi
  if [ "$mode" = sim ] && [ $late = 1 ]; then { sleep "$secs"; boundary; } & fi
  if [ "$mode" = sim ] && [ $nb = 0 ] && [ $late = 0 ]; then boundary; fi
  draw idle; printf '❯ '
done
[ $nohup = 0 ] || while :; do sleep 0.2; done   # (the terminal is gone and SIGHUP is ignored: stay)
EOF
chmod +x "$T/bin/tmux" "$T/standin"
printf 'earlier output\n\n  ? for shortcuts\n' >"$T/screens/idle"
printf 'earlier output\n\n✻ Working… (12s · esc to interrupt)\n' >"$T/screens/busy"
printf 'earlier output\n\n✶ Compacting conversation… (4s · ↓ 116 tokens)\n' >"$T/screens/compacting"
printf 'earlier output\n\n  ? for shortcuts\n' >"$T/screens/draft"
printf 'earlier output\n\n  nothing to type into\n' >"$T/screens/nocomposer"
printf 'Bash command\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n' >"$T/screens/prompt"
export PATH=$T/bin:$PATH
jq -nc --argjson pid $$ '{pid: $pid, name: "boss", sessionId: "SID-BOSS", cwd: "/x"}' >"$CREW_SESSIONS/boss.json"
tmux new-session -d -x 120 -y 40 -s cc -n main 'sleep 600'   # started after the exports: its panes inherit them
tmux new-session -d -x 120 -y 40 -s dd -n main 'sleep 600'

fails=0
check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }
as() { # as NAME SID cmd...: run in a fresh process (named claude) of session NAME/SID
  local name=$1 sid=$2; shift 2
  "$REEXEC_DIR/claude" -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"; exit $?' _ "$name" "$sid" "$@" 2>&1   # (not the last command: bash would exec it and lose the claude name)
}
RF=$CREW_ROOT/.owners

# owner FEATURE SID NAME [extra owner-file lines...]: a registered owner (contract format), awake, under boss
owner() {
  local f=$1 sid=$2 name=$3; shift 3
  mkdir -p "$RF/$f"
  { printf 'feature=%s\nrepo=/x\npath=src/\nsid=%s\nname=%s\nlead=boss\nlead_sid=SID-BOSS\nnotes=%s/%s/notes.md\nstate=awake\ncreated=2026-10-16T08:00:00Z\n' "$f" "$sid" "$name" "$RF" "$f"
    for l in "$@"; do printf '%s\n' "$l"; done; } >"$RF/$f/owner"
}
# live FEATURE SID NAME SCREEN [MODE [SECS]]: the owner's session, a stand-in in its own tmux window named NAME (session cc)
live() {
  local sid=$2 name=$3; shift 3
  tmux new-window -d -t cc: -n "$name" "$REEXEC_DIR/claude" "$T/standin" "$name" "$sid" "$@"
  local i; for i in $(seq 1 50); do [ -s "$CREW_SESSIONS/$sid.json" ] && break; sleep 0.1; done
  sleep 0.2
}
# notes FEATURE ISO [text]: the owner's notes file with that mtime
notes() { mkdir -p "$RF/$1"; printf '%s' "${3-notes}" >"$RF/$1/notes.md"; touch -d "$2" "$RF/$1/notes.md"; }
# task SID ID status-lines...: a task of that session ("ts<TAB>state<TAB>note" per line)
task() {
  local sid=$1 id=$2; shift 2
  mkdir -p "$CREW_ROOT/$id"
  printf 'sub_sid=%s\n' "$sid" >"$CREW_ROOT/$id/meta"
  printf '%b\n' "$@" >"$CREW_ROOT/$id/status"
}
typed() { cat "$T/typed.$1" 2>/dev/null; }
windows() { tmux list-windows -a -F '#{session_name}:#{window_name}' | sort | tr '\n' ' '; }
fresh=2026-10-16T09:30:00Z   # notes written after the last task log
LOG='2026-10-16T09:00:00Z\trunning\tstart\n2026-10-16T09:20:00Z\treview\tdone building'
refused() { # refused FEATURE WHY...: `crew sleep FEATURE` as boss exits 3 with "crew: refused: WHY"
  local f=$1; shift
  out=$("$CREW" sleep "$f" 2>&1); rc=$?
  eq "refused: $f (exit 3)" 3 "$rc"
  eq "refused: $f message" "crew: refused: $*" "$out"
}

# --- refusals 1-2: who and what ---
refused nope "nope is not an owner (crew owners lists them)"
owner asl SID-ASL aslname state=asleep
refused asl "asl is already asleep (crew wake asl brings it back)"
owner stranger SID-STR strname; notes stranger "$fresh"
out=$(as other SID-OTH "$CREW" sleep stranger); rc=$?
eq "a session that is neither the lead nor the owner: exit 3" 3 "$rc"
eq "a session that is neither the lead nor the owner: message" "crew: refused: only stranger's lead (boss) or the owner may put it to sleep" "$out"

# --- refusals 3-4: running, and in a pane ---
owner gone SID-GONE gonename
refused gone "gonename is not running: there is no window to close"
owner ghf SID-GH ghname
"$REEXEC_DIR/claude" -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/$2.json"; while :; do sleep 1; done' _ ghname SID-GH &
BG="$BG $!"; sleep 0.3
refused ghf "ghname has no tmux pane (it is not running in tmux): nothing to close"

# --- refusal 5: the window holds more than the owner ---
owner splitf SID-SP spname; live splitf SID-SP spname idle
tmux split-window -d -t cc:spname 'sleep 600'
notes splitf "$fresh"
refused splitf "window has 2 panes (e.g. an nvim split): close the others first"

# --- refusal 6: a real attached client is looking at the window ---
# script(1) types ^D into the client when its stdin hits EOF, and that ^D reaches the stand-in as end of input: give it a
# stdin that never ends (a fifo held open read-write)
mkfifo "$T/ttyin"; exec 7<>"$T/ttyin"
owner viewf SID-VW vwname; live viewf SID-VW vwname idle
notes viewf "$fresh"
tmux select-window -t cc:vwname
TERM=xterm script -qfc "tmux attach -t cc" /dev/null <&7 >/dev/null 2>&1 &
SCRIPT_PID=$!; BG="$BG $SCRIPT_PID"
for i in $(seq 1 50); do [ -n "$(tmux list-clients -F x)" ] && break; sleep 0.1; done
refused viewf "the user is viewing vwname's window; try again later"
eq "nothing was typed into the viewed window" "" "$(typed vwname)"

# --- refusal 7: notes older than the last task log ---
owner stale SID-ST stname; live stale SID-ST stname idle
task SID-ST 1016-stale '2026-10-16T09:00:00Z\trunning\tgo\n2026-10-16T09:20:00Z\tdone\tfinished'   # the running line is the work; the done line after it does not count
notes stale 2026-10-16T08:30:00Z
refused stale "notes at $RF/stale/notes.md are older than its last task log: ask the owner to update its notes first"
owner nonotes SID-NN nnname; live nonotes SID-NN nnname idle
refused nonotes "notes at $RF/nonotes/notes.md are missing or empty: ask the owner to write them first"
owner emptyn SID-EN enname; live emptyn SID-EN enname idle; notes emptyn "$fresh" ""
refused emptyn "notes at $RF/emptyn/notes.md are missing or empty: ask the owner to write them first"
owner notask SID-NT ntname woken_at=2026-10-16T09:00:00Z; live notask SID-NT ntname idle
notes notask 2026-10-16T08:30:00Z
refused notask "notes at $RF/notask/notes.md are older than its last task log: ask the owner to update its notes first"

# --- refusal 8: the pane must be idle with an empty composer ---
owner busyf SID-BY bynname; live busyf SID-BY bynname busy; notes busyf "$fresh"
refused busyf "bynname is busy (mid-turn): try again when it is idle"
owner promptf SID-PR prname; live promptf SID-PR prname prompt; notes promptf "$fresh"
refused promptf "a prompt is open in prname's pane: answer it in tmux first"
owner draftf SID-DR drname; live draftf SID-DR drname draft; notes draftf "$fresh"
refused draftf "unsent text in drname's composer (draft): nothing was typed"
owner nocf SID-NC ncname; live nocf SID-NC ncname nocomposer; notes nocf "$fresh"
refused nocf "ncname's composer is not visible (nocomposer): nothing was typed"
for n in bynname prname drname ncname; do eq "$n received nothing" "" "$(typed $n)"; done

# --- a compaction that does not end: nothing is closed ---
owner slowf SID-SL slname; live slowf SID-SL slname idle sim 4; notes slowf "$fresh"
out=$(CREW_COMPACT_WAIT_S=1 "$CREW" sleep slowf 2>&1); rc=$?
eq "compaction still running after the wait: exit 3" 3 "$rc"
eq "compaction still running: message" "crew: refused: still busy after compaction; nothing closed" "$out"
eq "its owner file still says awake" "awake" "$(sed -n 's/^state=//p' "$RF/slowf/owner")"
eq "the owner of the slow compaction was typed /compact (it started)" "/compact asleep next: keep slowf owner notes (crew owners --notes slowf), open talk threads, interface decisions, next step" "$(typed slname)"

# every window that was refused is still there, the viewed one too
eq "all refused owners' windows survive" "cc:bynname cc:drname cc:enname cc:main cc:ncname cc:nnname cc:ntname cc:prname cc:slname cc:spname cc:stname cc:vwname dd:main " "$(windows)"
kill "$SCRIPT_PID" 2>/dev/null; sleep 0.3
tmux select-window -t cc:main

# --- the happy path: the lead puts an idle owner to sleep ---
owner happy SID-HP hpname
live happy SID-HP hpname idle sim
task SID-HP 1016-happy "$LOG"
task SID-OTHER-SUB 1016-elsewhere '2026-10-16T11:00:00Z\trunning\ta later log of another session'   # not the owner's: must not make its notes stale
notes happy "$fresh"
tmux new-window -d -t cc: -n hpname 'sleep 600'                  # a decoy window with the same NAME: closed by id, never by name
tmux new-window -d -t cc: -n bystander 'sleep 600'
tmux new-window -d -t dd: -n peer 'sleep 600'
before=$(windows)
out=$("$CREW" sleep happy 2>&1); rc=$?
eq "happy path: exit 0" 0 "$rc"
eq "happy path: report line" "asleep: happy (hpname), window cc:hpname closed" "$out"
eq "/compact was typed with the owner focus" "/compact asleep next: keep happy owner notes (crew owners --notes happy), open talk threads, interface decisions, next step" "$(typed hpname)"
eq "only the owner's window is gone: the same-named decoy, a sibling window and another session survive" "$(sed 's/cc:hpname //' <<<"$before")" "$(windows)"
eq "one hpname window is left (the decoy)" 1 "$(windows | tr ' ' '\n' | grep -cx 'cc:hpname')"
owner_pid=$(jq -r .pid "$CREW_SESSIONS/SID-HP.json")
check "the owner process died with its window" test ! -d "/proc/$owner_pid"
f=$RF/happy/owner
eq "owner file: state" "asleep" "$(sed -n 's/^state=//p' "$f")"
eq "owner file: slept_at" "2026-10-16T10:00:00Z" "$(sed -n 's/^slept_at=//p' "$f")"
eq "owner file: window" "cc:hpname" "$(sed -n 's/^window=//p' "$f")"
eq "owner file: sid and name kept" "SID-HP hpname" "$(sed -n 's/^sid=//p' "$f") $(sed -n 's/^name=//p' "$f")"
eq "owner file: one line per key (nothing duplicated)" 1 "$(grep -c '^state=' "$f")"
eq "sleeping logs no task event" "" "$(cat "$CREW_ROOT/1016-happy/status" | grep -v '^2026-10-16T09:' || true)"
refused happy "happy is already asleep (crew wake happy brings it back)"

# --- an owner whose session name is a tmux format: it is data, nothing but its own window is closed ---
owner fmtf SID-FM 'x#{pane_id}x'
tmux new-window -d -t cc: -n fmtwin "$REEXEC_DIR/claude" "$T/standin" 'x#{pane_id}x' SID-FM idle sim
for i in $(seq 1 50); do [ -s "$CREW_SESSIONS/SID-FM.json" ] && break; sleep 0.1; done; sleep 0.2
notes fmtf "$fresh"
before=$(windows)
out=$("$CREW" sleep fmtf 2>&1); rc=$?
eq "a session name with #{pane_id} sleeps literally" "0 asleep: fmtf (x#{pane_id}x), window cc:fmtwin closed" "$rc $out"
eq "only its own window closed" "$(sed 's/cc:fmtwin //' <<<"$before")" "$(windows)"
eq "the focus was typed literally" "/compact asleep next: keep fmtf owner notes (crew owners --notes fmtf), open talk threads, interface decisions, next step" "$(typed 'x#{pane_id}x')"
eq "its name was recorded literally" "x#{pane_id}x" "$(sed -n 's/^name=//p' "$RF/fmtf/owner")"

# --- a client looking at a DIFFERENT window does not block ---
owner other2 SID-O2 o2name; live other2 SID-O2 o2name idle sim; notes other2 "$fresh"
tmux select-window -t cc:main
TERM=xterm script -qfc "tmux attach -t cc" /dev/null <&7 >/dev/null 2>&1 &
SCRIPT_PID=$!; BG="$BG $SCRIPT_PID"
for i in $(seq 1 50); do [ -n "$(tmux list-clients -F x)" ] && break; sleep 0.1; done
out=$("$CREW" sleep other2 2>&1); rc=$?
eq "a client on cc:main does not stop another window from sleeping" "0 asleep: other2 (o2name), window cc:o2name closed" "$rc $out"
kill "$SCRIPT_PID" 2>/dev/null; sleep 0.3

# --- self-sleep: the owner asks, the sleep waits for its turn to end ---
owner selfs SID-SS ssname; live selfs SID-SS ssname busy busyfirst 3
task SID-SS 1016-selfs "$LOG"
notes selfs 2026-10-16T08:30:00Z
out=$(as ssname SID-SS "$CREW" sleep selfs); rc=$?
eq "self-sleep with stale notes is refused at once" "3 crew: refused: notes at $RF/selfs/notes.md are older than its last task log: ask the owner to update its notes first" "$rc $out"
check "no waiter was started (no sleep.log)" test ! -e "$RF/selfs/sleep.log"
notes selfs "$fresh"
out=$(as ssname SID-SS timeout 10 "$CREW" sleep selfs); rc=$?
eq "self-sleep: returns at once with the wait notice (the waiter does not hold the caller's pipe)" "0 will sleep when this turn ends (result in $RF/selfs/sleep.log)" "$rc $out"
check "the owner's window is still there while its turn runs" tmux list-panes -t cc:ssname
eq "nothing was typed into the busy owner" "" "$(typed ssname)"
for i in $(seq 1 100); do tmux list-panes -t cc:ssname >/dev/null 2>&1 || break; sleep 0.2; done
check "the window closed after the turn ended" test -z "$(windows | tr ' ' '\n' | grep -x 'cc:ssname')"
eq "the owner's /compact was typed once" "/compact asleep next: keep selfs owner notes (crew owners --notes selfs), open talk threads, interface decisions, next step" "$(typed ssname)"
sleep 0.3
eq "sleep.log has the result line" "2026-10-16T10:00:00Z"$'\t'"asleep: selfs (ssname), window cc:ssname closed" "$(cat "$RF/selfs/sleep.log")"
eq "self-sleep recorded the owner asleep" "asleep 2026-10-16T10:00:00Z" "$(sed -n 's/^state=//p' "$RF/selfs/owner") $(sed -n 's/^slept_at=//p' "$RF/selfs/owner")"

# --- deferred: a refusal after the wait is logged, a turn that never ends times out ---
owner defd SID-DF dfname; live defd SID-DF dfname draft; notes defd "$fresh"
deferred() { printf 'tok-%s\n' "$1" >"$RF/$1/sleep.token"; CREW_SLEEP_TOKEN=tok-$1 "$CREW" sleep --deferred "$@" 2>&1; }   # (with the waiter's one-time token)
out=$(deferred defd); rc=$?
eq "deferred: exit 0 and silent" "0 " "$rc $out"
eq "deferred: a draft in the composer is refused and logged" "2026-10-16T10:00:00Z"$'\t'"unsent text in dfname's composer (draft): nothing was typed" "$(cat "$RF/defd/sleep.log")"
owner tmo SID-TM tmname; live tmo SID-TM tmname busy; notes tmo "$fresh"
out=$(export CREW_SLEEP_WAIT_S=1; deferred tmo); rc=$?
eq "deferred: exit 0 and silent when the wait runs out" "0 " "$rc $out"
eq "deferred: a turn that does not end within the wait is logged" "2026-10-16T10:00:00Z"$'\t'"tmname is still busy after 1s: not put to sleep" "$(cat "$RF/tmo/sleep.log")"
check "and its window is still there" tmux list-panes -t cc:tmname


# --- review fixes ---
ownset() { bash -c 'die() { echo "crew: $*" >&2; exit 1; }; . "$1"; shift; owner_set "$@"' _ "$(dirname "$CREW")/crew-owners.sh" "$@" 2>&1; }

# 1. `--deferred` is internal: only the waiter that `crew sleep` started (it holds the one-time token) may run it
owner dtok SID-DT dtname; live dtok SID-DT dtname idle sim; notes dtok "$fresh"
NOTOKEN=$'2026-10-16T10:00:00Z\tsleep --deferred is internal (crew sleep starts it): no valid token'
out=$(as other SID-OTH "$CREW" sleep --deferred dtok); rc=$?
eq "--deferred from a session without the token: exit 0 and silent" "0 " "$rc $out"
eq "--deferred without the token is logged and refused" "$NOTOKEN" "$(cat "$RF/dtok/sleep.log")"
printf 'secret\n' >"$RF/dtok/sleep.token"
out=$(as other SID-OTH env CREW_SLEEP_TOKEN=guess "$CREW" sleep --deferred dtok)
eq "--deferred with the wrong token is refused too" "$NOTOKEN"$'\n'"$NOTOKEN" "$(cat "$RF/dtok/sleep.log")"
check "a wrong token does not burn the real one" test -e "$RF/dtok/sleep.token"
eq "nothing was typed into the owner" "" "$(typed dtname)"
check "its window is still there" tmux list-panes -t cc:dtname
rm -f "$RF/dtok/sleep.token"

# 1. the owner logs a task while the waiter waits: the notes are checked again and the sleep is refused
owner latef SID-LT ltname; live latef SID-LT ltname busy busyfirst 3
task SID-LT 1016-latef "$LOG"; notes latef "$fresh"
out=$(as ltname SID-LT timeout 10 "$CREW" sleep latef); rc=$?
eq "self-sleep is accepted while the notes are fresh" "0 will sleep when this turn ends (result in $RF/latef/sleep.log)" "$rc $out"
task SID-LT 1016-latef '2026-10-16T09:00:00Z\trunning\tstart\n2026-10-16T09:45:00Z\trunning\tnew work after the notes'
for i in $(seq 1 100); do [ -s "$RF/latef/sleep.log" ] && break; sleep 0.2; done
eq "the waiter refused: notes are older than the task logged during the wait" "2026-10-16T10:00:00Z"$'\t'"notes at $RF/latef/notes.md are older than its last task log: ask the owner to update its notes first" "$(cat "$RF/latef/sleep.log")"
eq "nothing was typed into it" "" "$(typed ltname)"
check "its window is still there" tmux list-panes -t cc:ltname
eq "and it is still awake" awake "$(sed -n 's/^state=//p' "$RF/latef/owner")"

# 2. the pane found by NAME must hold the owner's own session (not another session with that name)
owner clashf SID-CL clname; notes clashf "$fresh"
"$REEXEC_DIR/claude" -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/$2.json"; while :; do sleep 1; done' _ clname SID-CL &
BG="$BG $!"; sleep 0.3
live clashf SID-IMP clname idle sim   # another session, same name, in a pane
refused clashf "clname's tmux pane belongs to another session: nothing was typed"
eq "nothing was typed into the other session's pane" "" "$(typed clname)"
check "and its window is still there" tmux list-panes -t cc:clname

# 3. owner_set stores a value literally: a backslash-n is two characters, a real newline is refused
owner osf SID-OSF osfname
out=$(ownset osf 'window=a\nstate=asleep'); rc=$?
eq "owner_set with a backslash-n in the value: exit 0" "0 " "$rc $out"
eq "the value is stored literally on one line" 'a\nstate=asleep' "$(sed -n 's/^window=//p' "$RF/osf/owner")"
eq "and state is untouched" "awake 1" "$(sed -n 's/^state=//p' "$RF/osf/owner") $(grep -c '^state=' "$RF/osf/owner")"
out=$(ownset osf $'window=b\nstate=asleep'); rc=$?
eq "owner_set with a real newline in the value is refused" "3 crew: refused: a value may not contain a newline" "$rc $out"
eq "and the file is unchanged" 'a\nstate=asleep awake' "$(sed -n 's/^window=//p' "$RF/osf/owner") $(sed -n 's/^state=//p' "$RF/osf/owner")"

# 4. tmux cannot say who is viewing (list-clients fails): refuse, do not read it as "nobody"
owner lcf SID-LC lcname; live lcf SID-LC lcname idle sim; notes lcf "$fresh"
touch "$T/fail.list-clients"
refused lcf "cannot tell who is viewing: nothing closed"
rm -f "$T/fail.list-clients"
eq "nothing was typed" "" "$(typed lcname)"
check "its window is still there" tmux list-panes -t cc:lcname

# 5. the owner's window is the last one of its tmux session: closing it would end the session
owner solof SID-SO solname; notes solof "$fresh"
tmux new-session -d -x 120 -y 40 -s solo -n solo "$REEXEC_DIR/claude" "$T/standin" solname SID-SO idle sim
for i in $(seq 1 50); do [ -s "$CREW_SESSIONS/SID-SO.json" ] && break; sleep 0.1; done; sleep 0.2
refused solof "solname's window is the last one in its tmux session: nothing closed"
eq "nothing was typed" "" "$(typed solname)"
check "the tmux session solo is still there" tmux has-session -t solo

# 6. the user types into the owner's pane while it compacts: the window is not closed
owner inputf SID-IN inname; live inputf SID-IN inname idle sim; notes inputf "$fresh"
cat >"$T/hook.list-clients" <<HOOK
#!/bin/bash
# the second list-clients of a sleep is the check after the compaction: type into the owner's composer just before it
n=\$(cat "$T/lc.n" 2>/dev/null || echo 0); n=\$((n + 1)); echo \$n >"$T/lc.n"
[ "\$n" = 2 ] || exit 0
tmux send-keys -t cc:inname -l 'oops'
for i in \$(seq 1 40); do tmux capture-pane -p -t cc:inname | grep -q oops && break; sleep 0.05; done
HOOK
chmod +x "$T/hook.list-clients"; rm -f "$T/lc.n"
refused inputf "inname got input during compaction: nothing closed"
rm -f "$T/hook.list-clients" "$T/lc.n"
eq "only the /compact line was submitted" "/compact asleep next: keep inputf owner notes (crew owners --notes inputf), open talk threads, interface decisions, next step" "$(typed inname)"
check "its window is still there" tmux list-panes -t cc:inname
eq "and it is still awake" awake "$(sed -n 's/^state=//p' "$RF/inputf/owner")"

# 6. another sleep finished while this one was on its way to the lock: state is read again under the lock
owner recheckf SID-RC rcname; live recheckf SID-RC rcname idle sim; notes recheckf "$fresh"
cat >"$T/hook.capture-pane" <<HOOK
#!/bin/bash
# the first pane read of the sleep is its idle check, just before the lock: another sleep records the owner asleep
rm -f "$T/hook.capture-pane"
bash -c '. "\$1"; owner_set recheckf state=asleep' _ "$(dirname "$CREW")/crew-owners.sh"
HOOK
chmod +x "$T/hook.capture-pane"
refused recheckf "recheckf is already asleep"
rm -f "$T/hook.capture-pane"
eq "nothing was typed" "" "$(typed rcname)"
check "its window is still there" tmux list-panes -t cc:rcname

# 6. a notes check needs a time it can read: an unreadable one refuses
owner badts SID-BT btname created=garbage; live badts SID-BT btname idle sim; notes badts "$fresh"
refused badts "cannot read the time of badts's creation: nothing closed"
owner badlog SID-BL blname; live badlog SID-BL blname idle sim; notes badlog "$fresh"
task SID-BL 1016-badlog 'garbage\trunning\tgo'
refused badlog "cannot read the time of the last log line of 1016-badlog: nothing closed"
eq "nothing was typed into either" "" "$(typed btname)$(typed blname)"

# 7. the deferred waiter waits for the turn to end: if the owner's pane is taken over meanwhile (the owner exits and
# another session gets the same window index), nothing is typed into the other session
owner swapf SID-SW swname; live swapf SID-SW swname busy busyfirst 3; notes swapf "$fresh"
swidx=$(tmux display-message -p -t cc:swname '#{window_index}')
cat >"$T/hook.capture-pane" <<HOOK
#!/bin/bash
# the waiter's first look at the pane (after it found the owner there): the owner's window goes, another session takes its index
rm -f "$T/hook.capture-pane"
tmux kill-window -t cc:swname
tmux new-window -d -t cc:$swidx -n imp2name "$REEXEC_DIR/claude" "$T/standin" imp2name SID-IMP2 idle sim
for i in \$(seq 1 50); do [ -s "$CREW_SESSIONS/SID-IMP2.json" ] && break; sleep 0.1; done
sleep 0.4
HOOK
chmod +x "$T/hook.capture-pane"
out=$(as swname SID-SW timeout 10 "$CREW" sleep swapf); rc=$?
eq "self-sleep is accepted" "0 will sleep when this turn ends (result in $RF/swapf/sleep.log)" "$rc $out"
for i in $(seq 1 100); do [ -s "$RF/swapf/sleep.log" ] && break; sleep 0.2; done
rm -f "$T/hook.capture-pane"
eq "the waiter refused: the owner is gone" "2026-10-16T10:00:00Z"$'\t'"swname is not running: there is no window to close" "$(cat "$RF/swapf/sleep.log")"
eq "nothing was typed into the session that took the pane" "" "$(typed imp2name)"
check "its window is still there" tmux list-panes -t cc:imp2name
eq "the owner is still recorded awake" awake "$(sed -n 's/^state=//p' "$RF/swapf/owner")"

# --- FX2s ---
# S1. renumber-windows on: a window closing between the locate and the /compact renumbers the others, so a
# session:index.pane target would name ANOTHER idle Claude. The owner is in window 2, another claude in window 3; window 0
# is killed just after the idle check (the first pane read) of the sleep. /compact must still land in the owner's pane.
tmux new-session -d -x 120 -y 40 -s rn -n w0 'sleep 600'
tmux set-option -t rn renumber-windows on
eq "the test server really renumbers windows" "on" "$(tmux show-options -t rn -v renumber-windows)"
tmux new-window -d -t rn:1 -n w1 'sleep 600'
owner rnf SID-RN rnname; notes rnf "$fresh"
tmux new-window -d -t rn:2 -n rnname "$REEXEC_DIR/claude" "$T/standin" rnname SID-RN idle sim
tmux new-window -d -t rn:3 -n rnother "$REEXEC_DIR/claude" "$T/standin" rnother SID-RO idle sim
for i in $(seq 1 50); do [ -s "$CREW_SESSIONS/SID-RN.json" ] && [ -s "$CREW_SESSIONS/SID-RO.json" ] && break; sleep 0.1; done; sleep 0.3
cat >"$T/hook.capture-pane" <<HOOK
#!/bin/bash
rm -f "$T/hook.capture-pane"
tmux kill-window -t rn:w0
tmux display-message -p -t rn:2.0 '#{window_name}' >"$T/rn.after"
HOOK
chmod +x "$T/hook.capture-pane"
out=$("$CREW" sleep rnf 2>&1); rc=$?
rm -f "$T/hook.capture-pane"
eq "S1 after window 0 closed, the old target rn:2 named the other claude" "rnother" "$(cat "$T/rn.after" 2>/dev/null)"
eq "S1 the sleep still closed the owner's own window" "0 asleep: rnf (rnname), window rn:rnname closed" "$rc $out"
eq "S1 /compact landed in the owner's pane" "/compact asleep next: keep rnf owner notes (crew owners --notes rnf), open talk threads, interface decisions, next step" "$(typed rnname)"
eq "S1 nothing was typed into the other claude" "" "$(typed rnother)"
check "S1 the other claude's window is still there" tmux list-panes -t rn:rnother

# S2. the done/landed/review lines come after the work: the notes only have to be newer than the work itself, and a notes
# file touched in the same second as the work is enough
owner nf SID-NF nfname; live nf SID-NF nfname idle sim
task SID-NF 1016-nf '2026-10-16T10:00:00Z\trunning\tthe work'
notes nf 2026-10-16T10:00:00Z
CREW_NOW=2026-10-16T10:00:00Z "$CREW" log 1016-nf done 'finished'
CREW_NOW=2026-10-16T10:00:00Z "$CREW" log 1016-nf landed 'merged'
CREW_NOW=2026-10-16T10:00:07Z "$CREW" log 1016-nf review 'look again'
out=$("$CREW" sleep nf 2>&1); rc=$?
eq "S2 notes written with the work, then done/landed/review lines: sleep passes" "0 asleep: nf (nfname), window cc:nfname closed" "$rc $out"
owner nf2 SID-NF2 nf2name; live nf2 SID-NF2 nf2name idle sim
task SID-NF2 1016-nf2 '2026-10-16T09:00:00Z\trunning\tstart\n2026-10-16T09:55:00Z\trunning\tmore work\n2026-10-16T10:00:00Z\tdone\tfinished'
notes nf2 2026-10-16T09:50:00Z
refused nf2 "notes at $RF/nf2/notes.md are older than its last task log: ask the owner to update its notes first"
eq "S2 nothing was typed into the stale one" "" "$(typed nf2name)"

# S5. the sleep lock is held from before the /compact through the close, on the direct path and in the deferred waiter:
# the tmux wrapper tries the lock from outside at each send-keys and kill-window (flock -n fails = held)
for p in send-keys kill-window; do
  printf '#!/bin/bash\nflock -n "$CREW_ROOT/.locks/sleep-lockf" true; echo "$?" >>"$T/lockrc"\n' >"$T/hook.$p"; chmod +x "$T/hook.$p"
done
owner lockf SID-LK lkname; live lockf SID-LK lkname idle sim; notes lockf "$fresh"
rm -f "$T/lockrc"
out=$("$CREW" sleep lockf 2>&1); rc=$?
eq "S5 direct sleep: exit 0" "0 asleep: lockf (lkname), window cc:lkname closed" "$rc $out"
eq "S5 direct sleep: the lock was held at send-keys (text, Enter) and kill-window" "1 1 1" "$(tr '\n' ' ' <"$T/lockrc" | sed 's/ $//')"
check "S5 and it is free again afterwards" flock -n "$CREW_ROOT/.locks/sleep-lockf" true
owner lock2 SID-LK2 lk2name; live lock2 SID-LK2 lk2name busy busyfirst 2; notes lock2 "$fresh"
sed -i 's/sleep-lockf/sleep-lock2/' "$T/hook.send-keys" "$T/hook.kill-window"
rm -f "$T/lockrc"
out=$(as lk2name SID-LK2 timeout 10 "$CREW" sleep lock2); rc=$?
eq "S5 deferred: accepted" "0 will sleep when this turn ends (result in $RF/lock2/sleep.log)" "$rc $out"
for i in $(seq 1 100); do [ -s "$RF/lock2/sleep.log" ] && break; sleep 0.2; done
eq "S5 deferred waiter: the lock was held at send-keys (text, Enter) and kill-window" "1 1 1" "$(tr '\n' ' ' <"$T/lockrc" 2>/dev/null | sed 's/ $//')"
rm -f "$T/hook.send-keys" "$T/hook.kill-window"

# S7. the owner's process may outlive its window's SIGHUP for a moment: the asleep write waits until the pid is gone
# (a refresh that sees a live session would flip the owner back to awake)
owner hupf SID-HU hupname; live hupf SID-HU hupname idle simhup; notes hupf "$fresh"
hup_pid=$(jq -r .pid "$CREW_SESSIONS/SID-HU.json")
out=$("$CREW" sleep hupf 2>&1); rc=$?
eq "S7 a process that takes 1 s to honour SIGHUP: reported asleep, no still-exiting note" "0 asleep: hupf (hupname), window cc:hupname closed" "$rc $out"
check "S7 and by then its pid is gone" test ! -d "/proc/$hup_pid"
owner nohupf SID-NH nohupname; live nohupf SID-NH nohupname idle simnohup; notes nohupf "$fresh"
nohup_pid=$(jq -r .pid "$CREW_SESSIONS/SID-NH.json")
out=$(CREW_SLEEP_EXIT_S=1 "$CREW" sleep nohupf 2>&1); rc=$?
eq "S7 a process that never exits: asleep anyway, and it says so" "0 asleep: nohupf (nohupname), window cc:nohupname closed (nohupname still exiting)" "$rc $out"
eq "S7 the owner file says asleep" "asleep" "$(sed -n 's/^state=//p' "$RF/nohupf/owner")"
kill -9 "$nohup_pid" 2>/dev/null

# S6. an owner put to sleep before it logged done leaves its wake task running: sleep closes it with a review line
owner wkf SID-WK wkname task=1016-wk; live wkf SID-WK wkname idle sim; notes wkf "$fresh"
task SID-WK 1016-wk '2026-10-16T09:00:00Z\trunning\twoken'; printf 'owner=wkf\n' >>"$CREW_ROOT/1016-wk/meta"
out=$("$CREW" sleep wkf 2>&1); rc=$?
eq "S6 sleep with a running wake task: exit 0" "0 asleep: wkf (wkname), window cc:wkname closed" "$rc $out"
eq "S6 the wake task's last line is review with the note" "2026-10-16T10:00:00Z"$'\t'"review"$'\t'"wkf fell asleep before it logged done" "$(tail -n 1 "$CREW_ROOT/1016-wk/status")"
owner dnf SID-DN dnname task=1016-dn; live dnf SID-DN dnname idle sim; notes dnf "$fresh"
task SID-DN 1016-dn '2026-10-16T09:00:00Z\trunning\twoken\n2026-10-16T09:10:00Z\tdone\tall done'; printf 'owner=dnf\n' >>"$CREW_ROOT/1016-dn/meta"
out=$("$CREW" sleep dnf 2>&1); rc=$?
eq "S6 a wake task that is done stays done" "0 2026-10-16T09:10:00Z"$'\t'"done"$'\t'"all done" "$rc $(tail -n 1 "$CREW_ROOT/1016-dn/status")"
owner otf SID-OT otname task=1016-ot; live otf SID-OT otname idle sim; notes otf "$fresh"
task SID-OT 1016-ot '2026-10-16T09:00:00Z\trunning\tsomeone else'"'"'s'; printf 'owner=another\n' >>"$CREW_ROOT/1016-ot/meta"
out=$("$CREW" sleep otf 2>&1); rc=$?
eq "S6 a task that belongs to another owner is left alone" "0 2026-10-16T09:00:00Z"$'\t'"running"$'\t'"someone else's" "$rc $(tail -n 1 "$CREW_ROOT/1016-ot/status")"

# --- FX3: a real compaction shows "Compacting conversation…" with no "esc to interrupt" and an empty composer; it is over
# only when the session transcript has its compact_boundary line ---
FOCUSX() { printf '/compact asleep next: keep %s owner notes (crew owners --notes %s), open talk threads, interface decisions, next step' "$1" "$1"; }
BREC='{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","timestamp":"2026-10-16T09:59:59.500Z","sessionId":"SID-X"}'
transcript() { cat "$T/projects/p/$1.jsonl" 2>/dev/null; }
# X1. the compacting screen is busy: the sleep (and `crew compact`) must not read it as idle
owner cmpf SID-CM cmpname; live cmpf SID-CM cmpname compacting; notes cmpf "$fresh"
refused cmpf "cmpname is busy (mid-turn): try again when it is idle"
eq "X1 nothing was typed into the compacting pane" "" "$(typed cmpname)"
# X2. the stand-in takes the /compact, goes idle, and never writes the boundary: nothing is closed
owner nobf SID-NB nobname; live nobf SID-NB nobname idle simnb 0.5; notes nobf "$fresh"
out=$(CREW_COMPACT_WAIT_S=3 "$CREW" sleep nobf 2>&1); rc=$?
eq "X2 no compact_boundary in the transcript: exit 3 and the refusal" "3 crew: refused: the compaction was not confirmed in the transcript: nothing closed" "$rc $out"
check "X2 its window is still there" tmux list-panes -t cc:nobname
eq "X2 and it is still awake" awake "$(sed -n 's/^state=//p' "$RF/nobf/owner")"
eq "X2 the /compact was typed once" "$(FOCUSX nobf)" "$(typed nobname)"
# X3. a boundary from before the send does not count
owner stalebf SID-SB sbname; live stalebf SID-SB sbname idle simnb 0.5; notes stalebf "$fresh"
sed 's/SID-X/SID-SB/' <<<"$BREC" >"$T/projects/p/SID-SB.jsonl"
out=$(CREW_COMPACT_WAIT_S=3 "$CREW" sleep stalebf 2>&1); rc=$?
eq "X3 only a boundary older than the send exists: refused" "3 crew: refused: the compaction was not confirmed in the transcript: nothing closed" "$rc $out"
check "X3 its window is still there" tmux list-panes -t cc:sbname
# X4. the boundary comes 3 s after the pane is idle and calm (settle 0.3 + 2 polls of 0.2): the sleep waits for it
owner latebf SID-LB lbname; live latebf SID-LB lbname idle simlate 3; notes latebf "$fresh"
sed 's/SID-X/SID-LB/' <<<"$BREC" >"$T/projects/p/SID-LB.jsonl"
out=$("$CREW" sleep latebf 2>&1); rc=$?
eq "X4 sleep waited for the late boundary and closed" "0 asleep: latebf (lbname), window cc:lbname closed" "$rc $out"
eq "X4 the new boundary was in the transcript when sleep returned" "2" "$(transcript SID-LB | grep -c '"compact_boundary"')"
eq "X4 the owner is asleep" asleep "$(sed -n 's/^state=//p' "$RF/latebf/owner")"
# X5. the deferred waiter goes through the same gate
owner nbdf SID-ND ndname; live nbdf SID-ND ndname idle simnb 0.5; notes nbdf "$fresh"
out=$(export CREW_COMPACT_WAIT_S=3; deferred nbdf); rc=$?
eq "X5 deferred: exit 0 and silent" "0 " "$rc $out"
eq "X5 deferred: the unconfirmed compaction is logged" "2026-10-16T10:00:00Z"$'\t'"the compaction was not confirmed in the transcript: nothing closed" "$(cat "$RF/nbdf/sleep.log")"
check "X5 its window is still there" tmux list-panes -t cc:ndname

echo
if [ "$fails" -eq 0 ]; then echo "all passed"; else echo "$fails FAILED"; exit 1; fi
