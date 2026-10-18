#!/usr/bin/env bash
# Test: the lifecycle sweep in `crew digest` / `crew subs` (crew-lifecycle.sh): a live sub whose work is landed is closed
# by itself (retried while it is viewed), a sub whose tasks are done but not landed is listed as `verify X?` until the lead
# logs landed, the action items come first, --peek takes no action, owners are never closed by this path, and a lead with
# nothing to look at pays no tmux call.
# Real tmux on a private server (tmux -L, TMUX unset) behind a wrapper that counts its calls; the panes run a stand-in
# `claude` that registers a session json for itself and draws an idle screen. "The user is viewing" is a REAL client
# attached to the private server through script(1). This script re-executes itself through a symlink named claude so that
# it is the lead session `boss` (crew recognises a session by its process name).
#   bash test-crew-lifecycle.sh
set -uo pipefail

if [ "$(cat /proc/$$/comm)" != claude ]; then
  RX=$(mktemp -d); ln -s "$(command -v bash)" "$RX/claude"
  REEXEC_DIR=$RX exec "$RX/claude" "$(readlink -f "$0")" "$@"
fi
unset TMUX TMUX_PANE   # the private server is named by -L in the wrapper; never depend on (or inherit) the caller's $TMUX
CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
TS=crewlife$$
real_tmux=$(command -v tmux)
BG=""
trap '"$real_tmux" -L "$TS" kill-server 2>/dev/null; kill $BG 2>/dev/null; rm -rf "$T" "${REEXEC_DIR:-}"' EXIT
mkdir -p "$T/bin" "$T/sessions" "$T/projects/p" "$T/screens"
export LC_ALL=C.UTF-8 CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-17T10:00:00Z T CREW
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
export CREW_COMPACT_SETTLE_S=0.3 CREW_COMPACT_POLL_S=0.2 CREW_COMPACT_WAIT_S=20 CREW_SLEEP_POLL_S=0.3 CREW_SLEEP_WAIT_S=30
unset CREW_LEAD_COMM CREW_AS_USER CREW_OWNER_IDLE_S CREW_OWNER_RETRY_S
# every tmux call is recorded in T/tmuxcalls (one line each)
printf '#!/bin/bash\necho "$1" >>"$T/tmuxcalls"\nexec %s -L %s "$@"\n' "$real_tmux" "$TS" >"$T/bin/tmux"
cat >"$T/standin" <<'EOF'
#!/bin/bash
# stand-in claude (run through the claude symlink): NAME SID [MODE [SECS]]. Registers itself, draws an idle screen and a
# composer, logs each line typed into T/typed.NAME. After a line, MODE sim: busy for SECS (a compaction), then the
# compact_boundary record (timestamp CREW_NOW) in the session transcript, then idle; MODE simlate: idle at once, the
# boundary record SECS later (a compaction that is still running as far as the transcript says).
name=$1 sid=$2 mode=${3:-} secs=${4:-1.2}
jq -nc --argjson pid $$ --arg n "$name" --arg s "$sid" '{pid: $pid, name: $n, sessionId: $s, cwd: "/x"}' >"$CREW_SESSIONS/$sid.json"
boundary() { jq -nc --arg t "$CREW_NOW" --arg s "$sid" '{type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: $t, sessionId: $s}' >>"$CREW_PROJECTS/p/$sid.jsonl"; }
draw() { printf '\033[2J\033[H'; cat "$T/screens/$1"; }
draw idle; printf '❯ '
while IFS= read -r line; do
  printf '%s\n' "$line" >>"$T/typed.$name"
  case "$mode" in
    sim) draw busy; sleep "$secs"; boundary ;;
    simlate) { sleep "$secs"; boundary; } </dev/null >/dev/null 2>&1 & ;;
  esac
  draw idle; printf '❯ '
done
EOF
chmod +x "$T/bin/tmux" "$T/standin"
printf 'earlier output\n\n  ? for shortcuts\n' >"$T/screens/idle"
printf 'earlier output\n\n✻ Working… (12s · esc to interrupt)\n' >"$T/screens/busy"
export PATH=$T/bin:$PATH
jq -nc --argjson pid $$ '{pid: $pid, name: "boss", sessionId: "SID-BOSS", cwd: "/x"}' >"$CREW_SESSIONS/boss.json"
tmux new-session -d -x 120 -y 40 -s cc -n main 'sleep 600'   # started after the exports: its panes inherit them

fails=0
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }
as() { # as NAME SID cmd...: run in a fresh process (named claude) of session NAME/SID
  local name=$1 sid=$2; shift 2
  "$REEXEC_DIR/claude" -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"; exit $?' _ "$name" "$sid" "$@" 2>&1
}
# pane NAME SID [MODE [SECS]]: a session SID named NAME, a stand-in in its own tmux window named NAME (session cc)
pane() {
  tmux new-window -d -t cc: -n "$1" "$REEXEC_DIR/claude" "$T/standin" "$@"
  local i; for i in $(seq 1 50); do [ -s "$CREW_SESSIONS/$2.json" ] && break; sleep 0.1; done
  sleep 0.2
}
# live NAME SID: the same, joined under boss
live() {
  pane "$1" "$2"
  mkdir -p "$CREW_ROOT/.links"; printf 'sub_name=%s\nparent_name=boss\nparent_sid=SID-BOSS\n' "$1" >"$CREW_ROOT/.links/$2"
}
task() { # SID ID TS STATE: a task of that session, one status line
  mkdir -p "$CREW_ROOT/$2"
  printf 'sub_sid=%s\nlead=boss\nlead_sid=SID-BOSS\n' "$1" >"$CREW_ROOT/$2/meta"
  printf '%s\t%s\tstart\n' "$3" "$4" >"$CREW_ROOT/$2/status"
}
windows() { tmux list-windows -t cc: -F '#{window_name}' | sort | tr '\n' ' '; }
digest() { "$CREW" digest "$@" 2>&1; }
# viewer NAME: a real client attached to session cc with NAME's window selected (script(1) types ^D into the client when
# its stdin hits EOF: give it a stdin that never ends, a fifo held open read-write)
mkfifo "$T/ttyin"; exec 7<>"$T/ttyin"
viewer() {
  tmux select-window -t "cc:$1"
  TERM=xterm script -qfc "tmux attach -t cc" /dev/null <&7 >/dev/null 2>&1 &
  VIEW_PID=$!; BG="$BG $VIEW_PID"
  local i; for i in $(seq 1 50); do [ -n "$(tmux list-clients -F x)" ] && break; sleep 0.1; done
}
unviewer() { tmux detach-client -s cc; wait "$VIEW_PID" 2>/dev/null; tmux select-window -t cc:main; }
PEND=$CREW_ROOT/.lifecycle/close-pending

# --- 1. a landed sub is closed by the lead's digest (this fails if digest never runs the sweep) ---
live landA SID-LA; task SID-LA 1017-landed1 2026-10-17T09:00:00Z landed
out=$(digest)
eq "landed sub: the digest opens with the closed line" $'Action items\n  closed landA (landed)\nSince last message\n  ✓ landed1 via landA  landed · start' "$out"
eq "landed sub: its window is gone" "main " "$(windows)"

# --- 2. a viewed sub is never closed; one pending line; closed once the viewer leaves ---
live viewA SID-VA; task SID-VA 1017-viewed1 2026-10-17T09:00:00Z landed
viewer viewA
eq "viewed sub: pending line says why, once" $'Action items\n  close viewA pending: the user is viewing viewA\'s window; try again later; retrying next sweep' "$(digest)"
eq "viewed sub: its window stays" "main viewA " "$(windows)"
eq "viewed sub: the marker holds the reason" "the user is viewing viewA's window; try again later" "$(cat "$PEND/SID-VA")"
eq "viewed sub: a second digest says nothing new" "" "$(digest)"
"$CREW" log 1017-viewed1 running "reopened" >/dev/null 2>&1
eq "reopened sub: nothing is printed" "" "$(digest)"
eq "reopened sub: the pending marker is dropped" "no" "$([ -e "$PEND/SID-VA" ] && echo yes || echo no)"
"$CREW" log 1017-viewed1 landed "again" >/dev/null 2>&1
eq "landed again while viewed: the pending line returns (a new marker)" $'Action items\n  close viewA pending: the user is viewing viewA\'s window; try again later; retrying next sweep\nSince last message\n  ✓ viewed1 via viewA  landed · again' "$(digest)"
unviewer
eq "viewer left: the next digest closes it" $'Action items\n  closed viewA (landed)' "$(digest)"
eq "viewer left: window gone and marker removed" "main no" "$(windows)$([ -e "$PEND/SID-VA" ] && echo yes || echo no)"

# --- 3. done but not landed: stays open, standing verify line until the lead logs landed ---
live doneA SID-DA; task SID-DA 1017-donetask 2026-10-17T09:00:00Z done
want=$'Action items\n  verify doneA? (donetask done) → crew log 1017-donetask landed, or reopen it'
eq "done sub: verify line" "$want" "$(digest)"
eq "done sub: still there on the next digest (standing)" "$want" "$(digest)"
eq "done sub: its window stays" "doneA main " "$(windows)"
"$CREW" log 1017-donetask landed "merged" >/dev/null 2>&1
eq "after crew log landed the next digest closes it" $'Action items\n  closed doneA (landed)\nSince last message\n  ✓ donetask via doneA  landed · merged' "$(digest)"

# --- 4. action items come before the changes (digest) and before the rows (subs) ---
live ordA SID-OA; task SID-OA 1017-ordtask 2026-10-17T10:00:00Z done
out=$(digest)
eq "digest: action items, then Since last message" $'Action items\n  verify ordA? (ordtask done) → crew log 1017-ordtask landed, or reopen it\nSince last message\n  ✓ ordtask via ordA  done · start' "$out"
out=$("$CREW" subs 2>&1)
eq "subs: action items, then the rows" $'Action items\n  verify ordA? (ordtask done) → crew log 1017-ordtask landed, or reopen it' "$(head -n 2 <<<"$out")"
eq "subs: the rows follow the block (the closed subs' rows say gone)" $'doneA gone\nordA live' "$(sed -n '3,$p' <<<"$out" | awk '$1 == "doneA" || $1 == "ordA" {print $1, $2}')"

# --- 5. --peek lists the verify lines and closes nothing ---
live peekL SID-PL; task SID-PL 1017-peeklanded 2026-10-17T09:00:00Z landed
out=$(digest --peek)
eq "peek: verify line shown, no closed line" $'Action items\n  verify ordA? (ordtask done) → crew log 1017-ordtask landed, or reopen it' "$out"
eq "peek: the landed sub's window stays" "main ordA peekL " "$(windows)"
eq "peek: crew subs --lead takes no action either" "main ordA peekL " "$("$CREW" subs --lead boss >/dev/null 2>&1; windows)"
eq "after the peek a plain digest closes the landed sub" $'Action items\n  closed peekL (landed)\n  verify ordA? (ordtask done) → crew log 1017-ordtask landed, or reopen it' "$(digest)"
"$CREW" log 1017-ordtask landed "merged" >/dev/null 2>&1

# --- 6. a registered owner is never closed by this path ---
live ownA SID-OW; task SID-OW 1017-ownertask 2026-10-17T09:00:00Z landed
mkdir -p "$CREW_ROOT/.owners/ownfeat"
printf 'feature=ownfeat\nrepo=/x\npath=src/\nsid=SID-OW\nname=ownA\nlead=boss\nlead_sid=SID-BOSS\nstate=awake\ncreated=2026-10-17T08:00:00Z\n' >"$CREW_ROOT/.owners/ownfeat/owner"
eq "owner with a landed task: only the plain sub is closed" $'Action items\n  closed ordA (landed)\nSince last message\n  ✓ ordtask via ordA  landed · merged' "$(digest)"
eq "owner with a landed task: its window stays" "main ownA " "$(windows)"
eq "owner with a landed task: the next digest has nothing" "" "$(digest)"

# --- 7. cheap path: a lead with no subs and no owners makes no tmux call and prints nothing ---
rm -f "$T/tmuxcalls"
out=$(as lone SID-LONE "$CREW" digest)
eq "idle lead: empty digest" "" "$out"
eq "idle lead: not one tmux call" "0" "$(cat "$T/tmuxcalls" 2>/dev/null | wc -l)"

# --- 8. sleep: the digest puts an idle owner of this lead to sleep (it starts the detached waiter, never waits for /compact) ---
RF=$CREW_ROOT/.owners
FRESH=2026-10-17T09:30:00Z   # notes written after the last task log
owner() { # owner F SID NAME [extra owner-file lines...]: a registered owner under boss, awake
  local f=$1 sid=$2 name=$3; shift 3
  mkdir -p "$RF/$f"
  { printf 'feature=%s\nrepo=/x\npath=src/\nsid=%s\nname=%s\nlead=boss\nlead_sid=SID-BOSS\nnotes=%s/%s/notes.md\nstate=awake\ncreated=2026-10-17T08:00:00Z\n' "$f" "$sid" "$name" "$RF" "$f"
    for l in "$@"; do printf '%s\n' "$l"; done; } >"$RF/$f/owner"
}
notes() { mkdir -p "$RF/$1"; printf 'notes' >"$RF/$1/notes.md"; touch -d "$2" "$RF/$1/notes.md"; }   # notes F ISO: with that mtime
tasklog() { # tasklog SID ID status-lines...: a task of that session ("ts<TAB>state<TAB>note" per line); not the lead's: no digest change line
  local sid=$1 id=$2; shift 2
  mkdir -p "$CREW_ROOT/$id"
  printf 'sub_sid=%s\n' "$sid" >"$CREW_ROOT/$id/meta"
  printf '%b\n' "$@" >"$CREW_ROOT/$id/status"
}
typed() { cat "$T/typed.$1" 2>/dev/null; }
state() { sed -n 's/^state=//p' "$RF/$1/owner"; }
waitlog() { local i; for i in $(seq 1 150); do [ -s "$RF/$1/sleep.log" ] && return 0; sleep 0.2; done; return 1; }   # the waiter has logged its result
haslog() { [ -s "$RF/$1/sleep.log" ] && echo yes || echo no; }
SLEEPING() { printf 'Action items\n  sleeping %s (idle, no open task; result next sweep)' "$1"; }
FOCUS() { printf '/compact asleep next: keep %s owner notes (crew owners --notes %s), open talk threads, interface decisions, next step' "$1" "$1"; }
DONE1='2026-10-17T08:30:00Z\trunning\tgo\n2026-10-17T09:00:00Z\tdone\tfinished'

# idle owner, no open task, quiet past the grace: `sleeping`, then (once the waiter has finished) `slept` exactly once
owner happy SID-HP hpname; pane hpname SID-HP sim 0.5; notes happy "$FRESH"
tasklog SID-HP 1017-happy "$DONE1"
eq "idle owner: the digest says it is going to sleep" "$(SLEEPING happy)" "$(digest)"
waitlog happy || echo "FAIL happy: the waiter never logged"
eq "idle owner: the next digest reports slept, once" $'Action items\n  slept happy' "$(digest)"
eq "idle owner: and says nothing the time after" "" "$(digest)"
eq "idle owner: asleep, its window gone" "asleep main ownA " "$(state happy) $(windows)"
eq "idle owner: /compact typed once with the owner focus" "$(FOCUS happy)" "$(typed hpname)"
eq "idle owner: the waiter's log line" $'2026-10-17T10:00:00Z\tasleep: happy (hpname), window cc:hpname closed' "$(cat "$RF/happy/sleep.log")"

# the digest does not wait for /compact: it returns with the `sleeping` line while the stand-in has not written its boundary
owner late SID-LT ltname; pane ltname SID-LT simlate 4; notes late "$FRESH"
tasklog SID-LT 1017-late "$DONE1"
t0=$SECONDS
out=$(digest)
dt=$((SECONDS - t0))
eq "slow compaction: sleeping line" "$(SLEEPING late)" "$out"
eq "slow compaction: the digest returned in under 3 s" "yes" "$([ "$dt" -lt 3 ] && echo yes || echo "no ($dt s)")"
eq "slow compaction: no compact_boundary yet, no result yet, window still there" "0 no ltname" "$(cat "$T/projects/p/SID-LT.jsonl" 2>/dev/null | grep -c compact_boundary || true) $(haslog late) $(tmux list-windows -t cc: -F '#{window_name}' | grep -x ltname)"
waitlog late || echo "FAIL late: the waiter never logged"
eq "slow compaction: reported slept once the waiter is done" $'Action items\n  slept late' "$(digest)"

# an owner with an open task is not touched
owner busyo SID-BO bsname; pane bsname SID-BO sim 0.5; notes busyo "$FRESH"
tasklog SID-BO 1017-busyo '2026-10-17T09:00:00Z\trunning\tstill working'
eq "open task: no line" "" "$(digest)"
eq "open task: no waiter, nothing typed, awake" "no  awake" "$(haslog busyo) $(typed bsname) $(state busyo)"
# its wake task (task=) is open although the sid it carries is not the owner's current one
owner wakeo SID-WO wkname task=1017-wake; pane wkname SID-WO sim 0.5; notes wakeo "$FRESH"
tasklog SID-WO-OLD 1017-wake '2026-10-17T09:00:00Z\trunning\twoken'
eq "open wake task: no line" "" "$(digest)"
eq "open wake task: no waiter, awake" "no awake" "$(haslog wakeo) $(state wakeo)"

# an owner inside the grace is not touched; the grace is CREW_OWNER_IDLE_S and a task exactly that old counts as quiet
owner gr SID-GR grname; pane grname SID-GR sim 0.5; notes gr "$FRESH"
tasklog SID-GR 1017-gr '2026-10-17T09:00:00Z\trunning\tgo\n2026-10-17T09:55:00Z\tdone\tfinished'
eq "inside the grace (last log 5 min ago): no line" "" "$(digest)"
eq "inside the grace: no waiter, awake" "no awake" "$(haslog gr) $(state gr)"
eq "grace of exactly the task's age: sleeping" "$(SLEEPING gr)" "$(CREW_OWNER_IDLE_S=300 digest)"
waitlog gr || echo "FAIL gr: the waiter never logged"
eq "grace: reported" $'Action items\n  slept gr' "$(digest)"
owner wk2 SID-W2 w2name woken_at=2026-10-17T09:58:00Z; pane w2name SID-W2 sim 0.5; notes wk2 2026-10-17T09:59:00Z
eq "woken 2 min ago, no task: no line" "" "$(digest)"
eq "woken 2 min ago: the grace of 120 s lets it sleep" "$(SLEEPING wk2)" "$(CREW_OWNER_IDLE_S=120 digest)"
waitlog wk2 || echo "FAIL wk2: the waiter never logged"
eq "woken: reported" $'Action items\n  slept wk2' "$(digest)"

# a refusal of the synchronous checks (notes older than the owner's work) is silent, starts no waiter and leaves no mark
owner stale SID-ST stname; pane stname SID-ST sim 0.5; notes stale 2026-10-17T08:30:00Z
tasklog SID-ST 1017-stale '2026-10-17T09:00:00Z\trunning\tgo\n2026-10-17T09:05:00Z\tdone\tfinished'
eq "stale notes: no line" "" "$(digest)"
eq "stale notes: still no line the next time (no retry spam)" "" "$(digest)"
eq "stale notes: no waiter, no mark, nothing typed, awake" "no no  awake" "$(haslog stale) $([ -e "$RF/stale/sweep-sleep" ] && echo yes || echo no) $(typed stname) $(state stale)"
notes stale "$FRESH"
eq "stale notes: updated, it sleeps (the refusal was a skip, not a verdict)" "$(SLEEPING stale)" "$(digest)"
waitlog stale || echo "FAIL stale: the waiter never logged"
digest >/dev/null
# the user is viewing its window
owner viewo SID-VO vwname; pane vwname SID-VO sim 0.5; notes viewo "$FRESH"
tasklog SID-VO 1017-viewo "$DONE1"
viewer vwname
eq "viewed owner: no line" "" "$(digest)"
eq "viewed owner: no waiter, nothing typed" "no " "$(haslog viewo) $(typed vwname)"
unviewer
eq "viewer left: sleeping" "$(SLEEPING viewo)" "$(digest)"
waitlog viewo || echo "FAIL viewo: the waiter never logged"
digest >/dev/null

# --peek and `subs --lead` and `digest --lead` never start a sleep
owner peeko SID-PK pkname; pane pkname SID-PK sim 0.5; notes peeko "$FRESH"
tasklog SID-PK 1017-peeko "$DONE1"
eq "peek: no line" "" "$(digest --peek)"
"$CREW" subs --lead boss >/dev/null 2>&1
"$CREW" digest --lead boss >/dev/null 2>&1
eq "peek, subs --lead, digest --lead: no waiter, no mark, nothing typed, awake" "no no  awake" "$(haslog peeko) $([ -e "$RF/peeko/sweep-sleep" ] && echo yes || echo no) $(typed pkname) $(state peeko)"
eq "the owner did qualify: a plain digest puts it to sleep" "$(SLEEPING peeko)" "$(digest)"
waitlog peeko || echo "FAIL peeko: the waiter never logged"
digest >/dev/null

# no new attempt within CREW_OWNER_RETRY_S (1800 s) of the last one; after it, a new one
owner rty SID-RT rtname; pane rtname SID-RT sim 0.5; notes rty "$FRESH"
tasklog SID-RT 1017-rty "$DONE1"
printf 'started=2026-10-17T09:59:00Z\nreported=1\n' >"$RF/rty/sweep-sleep"
eq "attempt 1 min ago: no new attempt" "" "$(digest)"
eq "attempt 1 min ago: no waiter" "no" "$(haslog rty)"
printf 'started=2026-10-17T09:20:00Z\nreported=1\n' >"$RF/rty/sweep-sleep"
eq "attempt 40 min ago: a new one starts" "$(SLEEPING rty)" "$(digest)"
waitlog rty || echo "FAIL rty: the waiter never logged"
digest >/dev/null

# the waiter's refusal is reported once (and only a line stamped at or after the attempt counts)
owner rfo SID-RF rfname; notes rfo "$FRESH"
printf 'started=2026-10-17T09:59:00Z\n' >"$RF/rfo/sweep-sleep"
printf '2026-10-17T08:00:00Z\tan older result\n' >"$RF/rfo/sleep.log"
eq "waiter still running (only an older log line): nothing" "" "$(digest)"
printf '2026-10-17T09:59:30Z\tthe user is viewing rfname'"'"'s window; try again later\n' >>"$RF/rfo/sleep.log"
eq "waiter refused: reported" $'Action items\n  sleep rfo refused: the user is viewing rfname\'s window; try again later' "$(digest)"
eq "waiter refused: reported once" "" "$(digest)"
eq "waiter refused: no new attempt inside the retry window" "2" "$(wc -l <"$RF/rfo/sleep.log")"

# --- 9. a resumed owner (registry sid is an earlier id of the live session, .prev) is an owner: never closed as a sub ---
live resumedA SID-NEWA; mkdir -p "$CREW_ROOT/.prev"; printf 'SID-OLDA\n' >"$CREW_ROOT/.prev/SID-NEWA"
owner resum SID-OLDA resname
tasklog SID-NEWA 1017-resumed '2026-10-17T09:59:00Z\tlanded\tmerged'
eq "resumed owner with a landed task: not closed (no closed line)" "" "$(digest)"
eq "resumed owner with a landed task: its window stays" "yes" "$(windows | grep -q 'resumedA ' && echo yes || echo no)"

# --- 10. an owner is led by a lead session only through its lead_sid (.prev), never by name: a live session that took a dead lead's name is not that lead ---
mkdir -p "$RF/ghost"
printf 'feature=ghost\nrepo=/x\npath=src/\nsid=SID-GH\nname=ghname\nlead=boss\nlead_sid=SID-DEAD\nnotes=%s/ghost/notes.md\nstate=awake\ncreated=2026-10-17T08:00:00Z\n' "$RF" >"$RF/ghost/owner"
pane ghname SID-GH sim 0.5; notes ghost "$FRESH"
tasklog SID-GH 1017-ghost "$DONE1"
eq "owner of a dead lead named boss: a lead named boss does not put it to sleep" "" "$(digest)"
eq "owner of a dead lead named boss: no waiter, nothing typed, awake" "no  awake" "$(haslog ghost) $(typed ghname) $(state ghost)"
mkdir -p "$RF/ghostw"
printf 'feature=ghostw\nrepo=/x\npath=src/\nsid=SID-GW\nname=gwname\nlead=boss\nlead_sid=SID-DEAD\nstate=asleep\ncreated=2026-10-17T08:00:00Z\n' >"$RF/ghostw/owner"
printf '2026-10-17T09:00:00Z\tmerged abc1234\n' >"$RF/ghostw/wake.pending"
eq "owner of a dead lead named boss: its pending wake is not the namesake's to see" "" "$(digest)"

# --- 11. a sub whose newest task is landed but an older one is still done (unverified) is not closed: verify line, then closed once that one lands ---
live mixA SID-MX
tasklog SID-MX 1017-mixa '2026-10-17T07:00:00Z\trunning\tgo\n2026-10-17T08:00:00Z\tdone\tfinished'
tasklog SID-MX 1017-mixb '2026-10-17T08:30:00Z\trunning\tgo\n2026-10-17T09:00:00Z\tlanded\tmerged'
want=$'Action items\n  verify mixA? (mixa done) → crew log 1017-mixa landed, or reopen it'
eq "landed newest task, older task done: verify line, no closed line" "$want" "$(digest)"
eq "landed newest task, older task done: window stays" "yes" "$(windows | grep -q 'mixA ' && echo yes || echo no)"
"$CREW" log 1017-mixa landed "merged" >/dev/null 2>&1
eq "the done task landed: the next digest closes it" $'Action items\n  closed mixA (landed)' "$(digest)"

# --- 12. the precheck finds an owner whose lead resumed under a new sessionId AND a new name (lead_sid of an earlier id, .prev) ---
mkdir -p "$RF/renamed"
printf 'feature=renamed\nrepo=/x\npath=src/\nsid=SID-RN\nname=rnname\nlead=oldboss\nlead_sid=SID-OLDB\nstate=asleep\ncreated=2026-10-17T08:00:00Z\n' >"$RF/renamed/owner"
printf '2026-10-17T09:00:00Z\tmerged def5678\n' >"$RF/renamed/wake.pending"
printf 'SID-OLDB\n' >"$CREW_ROOT/.prev/SID-NEWB"
eq "owner of a lead that resumed as newboss: its wake line reaches the new session" $'Action items\n  wake renamed: merged def5678? → crew wake renamed "<task>", or crew owners --dismiss renamed' "$(as newboss SID-NEWB "$CREW" digest)"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
