#!/usr/bin/env bash
# Test: a lead compacts its subs by itself (`crew compact`, `crew compact --auto`, the silent sweep in digest/subs).
# Real tmux on a private server (tmux -L) behind a wrapper that records every send-keys argv; the panes run a stand-in
# `claude` that registers a session json for itself, draws a screen (idle / busy / permission prompt) and echoes what
# the pane types. Transcripts are fake files with literal usage numbers. This script re-executes itself through a
# symlink named claude so that it is the lead session (crew recognises a session by its process name).
#   bash test-crew-compact.sh
set -uo pipefail

if [ "$(cat /proc/$$/comm)" != claude ]; then
  RX=$(mktemp -d); ln -s "$(command -v bash)" "$RX/claude"
  REEXEC_DIR=$RX exec "$RX/claude" "$(readlink -f "$0")" "$@"
fi
CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
TS=crewcompact$$
real_tmux=$(command -v tmux)
real_tail=$(command -v tail)
# The "bg" pane's stand-in never stops on a tty read, so tmux's hangup does not end it: kill its (own) process group, found
# from the pid it registered, which holds it and the sleep feeding its stdin.
reap_bg() {
  local pid pgid
  pid=$(jq -r .pid "${CREW_SESSIONS:-/nonexistent}/SID-FG.json" 2>/dev/null) || return 0
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  [[ "$pgid" =~ ^[0-9]+$ ]] && [ "$pgid" != "$(ps -o pgid= -p $$ | tr -d ' ')" ] && kill -- "-$pgid" 2>/dev/null
  return 0
}
trap 'reap_bg; "$real_tmux" -L "$TS" kill-server 2>/dev/null; kill $BG 2>/dev/null; rm -rf "$T" "${REEXEC_DIR:-}"' EXIT
BG=""
mkdir -p "$T/bin" "$T/sessions" "$T/projects/p" "$T/screens"
export LC_ALL=C CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-16T10:00:00Z T CREW
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
export CREW_COMPACT_SETTLE_S=0.3 CREW_COMPACT_POLL_S=0.2 CREW_COMPACT_WAIT_S=20
unset CREW_LEAD_COMM CREW_COMPACT_SOFT CREW_COMPACT_HARD TMUX TMUX_PANE   # the private server is named by -L in the wrapper; never depend on (or inherit) the caller's $TMUX
printf '#!/bin/bash\n[ "$1" != send-keys ] || { printf "%%s\\037" "$@"; echo; } >>"$T/send.log"\nexec %s -L %s "$@"\n' "$real_tmux" "$TS" >"$T/bin/tmux"
printf '#!/bin/bash\ncase " $* " in *" -c "*) echo "$*" >>"$T/tail.log" ;; esac\nexec %s "$@"\n' "$real_tail" >"$T/bin/tail"
cat >"$T/standin" <<'EOF'
#!/bin/bash
# stand-in claude (run through the claude symlink, so the pane's process is named claude): NAME SID SCREEN [sim]. Registers itself, draws SCREEN and a composer, logs each line typed into
# T/typed.NAME. sim: after a line it shows a busy screen for 1.2 s ("compacting"), then idle again.
name=$1 sid=$2 screen=$3 mode=${4:-}
jq -nc --argjson pid $$ --arg n "$name" --arg s "$sid" '{pid: $pid, name: $n, sessionId: $s, cwd: "/x"}' >"$CREW_SESSIONS/$sid.json"
draw() { printf '\033[2J\033[H'; cat "$T/screens/$1"; }
draw "$screen"
case "$screen" in prompt) read -r -t 600 line; exit 0 ;; esac
if [ "$mode" = race ]; then   # someone else types too: once a key arrives the composer shows "concurrent" first
  stty -echo; draw idle; printf '❯ '; buf=""
  while IFS= read -r -n1 ch; do
    if [ -z "$ch" ]; then printf '%s\n' "$buf" >>"$T/typed.$name"; buf=""; draw idle; printf '❯ '; continue; fi
    buf+=$ch; draw idle; printf '❯ concurrent%s' "$buf"
  done
  exit 0
fi
if [ "$mode" = wrap ]; then   # as Claude draws it: rules (the top one carrying the session name), the composer wrapped at word boundaries
  stty -echo; buf=${5:-}   # (a 5th argument is text already in the composer)
  rule=$(printf '─%.0s' $(seq 1 103)); top="$(printf '─%.0s' $(seq 1 85)) acme-gateway-review ─"
  drawwrap() {
    draw idle; printf '%s\n' "$top"
    if [ -z "$buf" ]; then printf '❯ \n'; else printf '%s' "$buf" | fold -s -w 98 | sed '1s/^/❯ /; 2,$s/^/  /; s/ *$//'; echo; fi
    printf '%s\n  ? for shortcuts\n' "$rule"
  }
  drawwrap
  while IFS= read -r -n1 ch; do
    if [ -z "$ch" ]; then printf '%s\n' "$buf" >>"$T/typed.$name"; buf=""; drawwrap; continue; fi
    buf+=$ch; drawwrap
  done
  exit 0
fi
case "$screen" in draft) printf '❯ Please delete the deployment' ;; *) printf '❯ ' ;; esac
while IFS= read -r line; do
  printf '%s\n' "$line" >>"$T/typed.$name"
  if [ "$mode" = sim ]; then draw busy; sleep 1.2; fi
  draw idle; printf '❯ '
done
EOF
chmod +x "$T/bin/tmux" "$T/bin/tail" "$T/standin"
printf 'earlier output\n\n  ? for shortcuts\n' >"$T/screens/idle"
printf 'earlier output\n\n✻ Working… (12s · esc to interrupt)\n' >"$T/screens/busy"
printf 'earlier output\n\n  ? for shortcuts\n' >"$T/screens/draft"
printf 'Bash command\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n' >"$T/screens/prompt"
export PATH=$T/bin:$PATH
jq -nc --argjson pid $$ '{pid: $pid, name: "boss", sessionId: "SID-BOSS", cwd: "/x"}' >"$CREW_SESSIONS/boss.json"
tmux new-session -d -x 120 -y 40 -s cc -n main 'sleep 600'   # started after the exports: its panes inherit them

fails=0
check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }
as() { # as NAME SID cmd...: run in a fresh process (named claude) of session NAME/SID
  local name=$1 sid=$2; shift 2
  "$REEXEC_DIR/claude" -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"; exit $?' _ "$name" "$sid" "$@" 2>&1   # (not the last command: bash would exec it and lose the claude name)
}

# sub NAME SID SCREEN [sim|wrap [composer text]]: a live sub in its own tmux window, joined under boss
sub() {
  mkdir -p "$CREW_ROOT/.links"
  printf 'sub_name=%s\nparent_name=boss\nparent_sid=SID-BOSS\n' "$1" >"$CREW_ROOT/.links/$2"
  tmux new-window -d -t cc: -n "$1" "$REEXEC_DIR/claude" "$T/standin" "$1" "$2" "$3" ${4:-} ${5:+"$5"}
  local i; for i in $(seq 1 50); do [ -s "$CREW_SESSIONS/$2.json" ] && break; sleep 0.1; done
  sleep 0.2
}
# ghost NAME SID [joined]: a live session that is in no tmux pane
ghost() {
  "$REEXEC_DIR/claude" -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/$2.json"; while :; do sleep 1; done' _ "$1" "$2" &
  BG="$BG $!"
  if [ "${3:-}" = joined ]; then mkdir -p "$CREW_ROOT/.links"; printf 'sub_name=%s\nparent_name=boss\nparent_sid=SID-BOSS\n' "$1" >"$CREW_ROOT/.links/$2"; fi
  sleep 0.3
}
# transcript SID CTX [TS]: an old turn of 900000 tokens, then the latest turn of CTX (input 1000 + cache_creation 1000 + cache_read), then a user line
transcript() {
  local ts=${3:-2026-10-16T09:50:00.000Z}
  {
    printf '{"type":"assistant","timestamp":"2026-10-16T08:00:00.000Z","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":1000,"cache_read_input_tokens":898000,"cache_creation_input_tokens":1000,"output_tokens":5}}}\n'
    printf '{"type":"assistant","timestamp":"%s","message":{"id":"m2","model":"claude-opus-5-5","usage":{"input_tokens":1000,"cache_read_input_tokens":%s,"cache_creation_input_tokens":1000,"output_tokens":5}}}\n' "$ts" "$(($2 - 2000))"
    printf '{"type":"user","timestamp":"%s","message":{"content":"ok"}}\n' "$ts"
  } >"$T/projects/p/$1.jsonl"
}
# task SID ID status-lines...: a task of that sub ("ts<TAB>state<TAB>note" per line)
task() {
  local sid=$1 id=$2; shift 2
  mkdir -p "$CREW_ROOT/$id"
  printf 'sub_sid=%s\n' "$sid" >"$CREW_ROOT/$id/meta"
  printf '%b\n' "$@" >"$CREW_ROOT/$id/status"
}
record() { mkdir -p "$CREW_ROOT/.compact"; printf 'compacted=%s\nctx_before=240000\n' "$2" >"$CREW_ROOT/.compact/$1"; }
target_of() { tmux display-message -p -t "cc:$1" '#{session_name}:#{window_index}.#{pane_index}'; }
sent() { tr '\037' '|' <"$T/send.log" 2>/dev/null; }   # one line per send-keys call
typed() { cat "$T/typed.$1" 2>/dev/null; }

MS='2026-10-16T09:00:00Z\tqueued\tstart\n2026-10-16T09:40:00Z\treview\tread to verify'   # a log entry after the last compaction = a milestone
NOMS='2026-10-16T09:00:00Z\trunning\tstart\n2026-10-16T09:20:00Z\trunning\tstill going'  # logged before the last compaction (09:30): not new
WAVE='2026-10-16T09:00:00Z\trunning\tstart\n2026-10-16T09:40:00Z\trunning\twave 2 done'  # running -> running with a new note: a milestone (orchestrate logs waves so)

# --- the world: one sub per rule ---
sub alpha SID-1 idle;       transcript SID-1 250000; task SID-1 1016-alpha "$MS"
ghost beta SID-2 joined;    transcript SID-2 250000; task SID-2 1016-beta "$NOMS"; record SID-2 2026-10-16T09:30:00Z
sub gamma SID-3 idle;       transcript SID-3 450000; task SID-3 1016-gamma "$NOMS"; record SID-3 2026-10-16T09:30:00Z
sub delta SID-4 busy;       transcript SID-4 450000; task SID-4 1016-delta "$NOMS"; record SID-4 2026-10-16T09:30:00Z
sub eps SID-5 busy;         transcript SID-5 250000; task SID-5 1016-eps "$MS"
ghost zeta SID-6 joined;    transcript SID-6 150000; task SID-6 1016-zeta "$MS"
ghost eta SID-7 joined;     transcript SID-7 310000; task SID-7 1016-eta '2026-10-16T09:00:00Z\trunning\tgo\n2026-10-16T09:30:00Z\tdone\tfinished'
sub theta SID-8 prompt;     transcript SID-8 450000; task SID-8 1016-theta "$NOMS"; record SID-8 2026-10-16T09:30:00Z
sub iota SID-9 idle;        transcript SID-9 250000; task SID-9 1016-iota "$MS"; record SID-9 2026-10-16T09:45:00Z
sub kappa SID-A idle;       transcript SID-A 250000; task SID-A 1016-kappa "$MS"; record SID-A 2026-10-16T09:30:00Z
ghost lambda SID-B joined;  transcript SID-B 250000; task SID-B 1016-lambda '2026-10-16T07:00:00Z\tqueued\tstart\n2026-10-16T08:00:00Z\trunning\tgo'; record SID-B 2026-10-16T09:00:00Z
ghost mu SID-C joined;      transcript SID-C 250000 2026-10-16T08:50:00.000Z; task SID-C 1016-mu "$MS"; record SID-C 2026-10-16T09:00:00Z
ghost nu SID-D joined;      transcript SID-D 250000; task SID-D 1016-nu "$MS"
ghost xi SID-E joined;      task SID-E 1016-xi "$MS"
ghost omicron SID-F joined; transcript SID-F 250000
sub wave SID-W idle;        transcript SID-W 250000; task SID-W 1016-wave "$WAVE"; record SID-W 2026-10-16T09:30:00Z
# a resumed sub: its task still carries the old sessionId, which .prev ties to the new one
sub resumed SID-X-NEW idle; transcript SID-X-NEW 450000
rm "$CREW_ROOT/.links/SID-X-NEW"; printf 'sub_name=resumed\nparent_name=boss\nparent_sid=SID-BOSS\n' >"$CREW_ROOT/.links/SID-X-OLD"
mkdir -p "$CREW_ROOT/.prev"; printf 'SID-X-OLD\n' >"$CREW_ROOT/.prev/SID-X-NEW"
task SID-X-OLD 1016-resumed '2026-10-16T09:00:00Z\trunning\tgo\n2026-10-16T09:20:00Z\trunning\twave 1'; record SID-X-NEW 2026-10-16T09:30:00Z
printf 'D9\n' >"$CREW_ROOT/1016-resumed/decision"; printf 'brief\n' >"$CREW_ROOT/1016-resumed/brief.md"
# SID-A's milestone (09:40) is after its last compaction (09:30, more than 20 min ago); SID-9's compaction was 15 min ago
printf 'Verdict: all green\nmore\n' >"$CREW_ROOT/1016-alpha/summary.md"
printf 'D7\n' >"$CREW_ROOT/1016-alpha/decision"
printf 'brief\n' >"$CREW_ROOT/1016-alpha/brief.md"
printf '2026-10-16T09:00:00Z\tqueued\tstart\n2026-10-16T09:40:00Z\treview\ttests written\n' >"$CREW_ROOT/1016-alpha/status"
ta=$(target_of alpha); tg=$(target_of gamma)

# --- the sweep: one line per sub, and only the due ones are typed into ---
out=$("$CREW" compact --auto 2>&1); rc=$?
eq "--auto exits 0" 0 "$rc"
eq "--auto: one literal line per sub, in link order" "compacted alpha (ctx 250k)
skip beta: no milestone (ctx 250k)
compacted gamma (ctx 450k)
wait delta: busy at 450k
skip eps: busy
skip zeta: ctx 150k
close eta? (done, ctx 310k)
skip theta: prompt
skip iota: recent
compacted kappa (ctx 250k)
skip lambda: no milestone (ctx 250k)
skip mu: recent
skip nu: no tmux pane
skip xi: no transcript
skip omicron: no task
compacted wave (ctx 250k)
compacted resumed (ctx 450k)" "$out"
eq "alpha was sent /compact with the focus built from its own words, as argv: -l --, then a separate Enter" \
"send-keys|-t|$ta|-l|--|/compact keep: crew task(s) 1016-alpha; latest log: review - tests written; summary: Verdict: all green; briefs: $CREW_ROOT/1016-alpha/brief.md; open decisions: D7; the current milestone and the next step|
send-keys|-t|$ta|Enter|" "$(sent | grep -F "|$ta|" | head -n 2)"
eq "what alpha's pane received" "/compact keep: crew task(s) 1016-alpha; latest log: review - tests written; summary: Verdict: all green; briefs: $CREW_ROOT/1016-alpha/brief.md; open decisions: D7; the current milestone and the next step" "$(typed alpha)"
eq "gamma (450k, no milestone) got the focus without summary, brief or D-id" "/compact keep: crew task(s) 1016-gamma; latest log: running - still going; the current milestone and the next step" "$(typed gamma)"
eq "only alpha, gamma, kappa, wave and resumed were typed into (10 send-keys calls: text + Enter each)" 10 "$(sent | wc -l)"
eq "wave (running -> running with a new note after the last compaction, 250k) was compacted" "/compact keep: crew task(s) 1016-wave; latest log: running - wave 2 done; the current milestone and the next step" "$(typed wave)"
eq "a resumed sub (task under the old sessionId via .prev) keeps its task's brief, log and D-id in the focus" "/compact keep: crew task(s) 1016-resumed; latest log: running - wave 1; briefs: $CREW_ROOT/1016-resumed/brief.md; open decisions: D9; the current milestone and the next step" "$(typed resumed)"
for n in delta eps theta iota; do eq "$n received nothing" "" "$(typed $n)"; done
eq "the compaction is recorded for the cooldown" $'compacted=2026-10-16T10:00:00Z\nctx_before=250000' "$(cat "$CREW_ROOT/.compact/SID-1")"
eq "and in the open task's meta" $'sub_sid=SID-1\ncompacted=2026-10-16T10:00:00Z\nctx_before=250000' "$(cat "$CREW_ROOT/1016-alpha/meta")"
eq "a second sweep right after compacts nothing (20-min cooldown)" "skip alpha: recent
skip beta: no milestone (ctx 250k)
skip gamma: recent
wait delta: busy at 450k
skip eps: busy
skip zeta: ctx 150k
close eta? (done, ctx 310k)
skip theta: prompt
skip iota: recent
skip kappa: recent
skip lambda: no milestone (ctx 250k)
skip mu: recent
skip nu: no tmux pane
skip xi: no transcript
skip omicron: no task
skip wave: recent
skip resumed: recent" "$("$CREW" compact --auto 2>&1)"

# --- crew subs: the context and pane state; the silent sweep says nothing when nothing is due ---
: >"$T/send.log"
subs=$("$CREW" subs 2>&1)
eq "subs: alpha with its context and pane state" "alpha                    live  ctx 250k  idle" "$(grep '^alpha ' <<<"$subs")"
eq "subs: a busy sub" "delta                    live  ctx 450k  busy" "$(grep '^delta ' <<<"$subs")"
eq "subs: a sub with a permission prompt open" "theta                    live  ctx 450k  prompt" "$(grep '^theta ' <<<"$subs")"
eq "subs: a sub not in tmux shows only its context" "nu                       live  ctx 250k" "$(grep '^nu ' <<<"$subs")"
eq "subs: a sub without a transcript has no context column" "xi                       live" "$(grep '^xi ' <<<"$subs")"
# eta (done, not landed) is the lifecycle sweep's `verify` item: two lines (header, item) before the 17 rows
V=$'Action items\n  verify eta? (eta done) → crew log 1016-eta landed, or reopen it'
eq "subs printed nothing but the action items and the 17 subs (the sweep had nothing due)" 19 "$(wc -l <<<"$subs")"
eq "and typed nothing" "" "$(sent)"

# --- a sub that needs it is compacted by digest and subs, one line, no prompt from the model ---
sub rho SID-G idle;   transcript SID-G 250000; task SID-G 1016-rho "$MS"
sub sigma SID-H idle; transcript SID-H 450000; task SID-H 1016-sigma "$NOMS"; record SID-H 2026-10-16T09:30:00Z
eq "digest --peek never compacts" "$V" "$("$CREW" digest --peek 2>&1)"
eq "nothing was typed by --peek" "" "$(typed rho)$(typed sigma)"
eq "digest compacts the sub that is due and says so in one line each" "$V
compacted rho (ctx 250k)
compacted sigma (ctx 450k)" "$("$CREW" digest 2>&1)"
eq "rho's pane got /compact" "/compact keep: crew task(s) 1016-rho; latest log: review - read to verify; the current milestone and the next step" "$(typed rho)"
eq "the next digest has only the verify item" "$V" "$("$CREW" digest 2>&1)"
sub tau SID-I idle;   transcript SID-I 450000; task SID-I 1016-tau "$NOMS"; record SID-I 2026-10-16T09:30:00Z
out=$("$CREW" subs 2>&1)
eq "subs also compacts a sub that is due (after the action items, before the list)" "$V
compacted tau (ctx 450k)" "$(head -n 3 <<<"$out")"

# --- the cheap pre-check: no live subs, no transcript reads ---
jq -nc --argjson pid $$ '{pid: 0, name: "x", sessionId: "SID-L2"}' >/dev/null
mkdir -p "$CREW_ROOT/.links"; printf 'sub_name=gone-sub\nparent_name=lead2\nparent_sid=SID-L2\n' >"$CREW_ROOT/.links/SID-GONE"
transcript SID-GONE 450000
: >"$T/tail.log"
eq "digest of a lead whose only sub is gone prints nothing" "" "$(as lead2 SID-L2 "$CREW" digest)"
eq "and read no transcript" "" "$(cat "$T/tail.log")"
eq "a lead with no subs at all reads none either" "" "$(as lonely SID-LO "$CREW" digest)$(cat "$T/tail.log")"
: >"$T/tail.log"
"$CREW" digest >/dev/null 2>&1
check "a lead with live subs does read their transcripts" test -s "$T/tail.log"

# --- compact --auto SUB: new work is the boundary ---
: >"$T/send.log"
sub upsilon SID-J idle sim; transcript SID-J 250000; task SID-J 1016-upsilon "$NOMS"; record SID-J 2026-10-16T09:30:00Z
t0=$(date +%s.%N)
eq "--auto SUB compacts at SOFT with no milestone, and waits until the pane is idle again" "compacted upsilon (ctx 250k)" "$("$CREW" compact --auto upsilon 2>&1)"
t1=$(date +%s.%N)
check "it waited for the compaction to finish (1.2 s busy)" awk -v a="$t0" -v b="$t1" 'BEGIN {exit !(b - a >= 1.1)}'
eq "the pane is idle when the command returns" "" "$(tmux capture-pane -p -t cc:upsilon | grep -c 'esc to interrupt' | grep -v '^0$')"
sub phi SID-K idle; transcript SID-K 250000; task SID-K 1016-phi '2026-10-16T09:00:00Z\trunning\tgo\n2026-10-16T09:30:00Z\tdone\tfinished'
eq "--auto SUB compacts a sub whose task is done (it is about to get new work: no close line)" "compacted phi (ctx 250k)" "$("$CREW" compact --auto phi 2>&1)"
sub chi SID-M idle; transcript SID-M 150000; task SID-M 1016-chi "$MS"
eq "--auto SUB below SOFT: skip" "skip chi: ctx 150k" "$("$CREW" compact --auto chi 2>&1)"
eq "--auto SUB right after a compaction: skip" "skip phi: recent" "$("$CREW" compact --auto phi 2>&1)"
eq "--auto SUB on a busy sub: skip, nothing typed" "skip eps: busy" "$("$CREW" compact --auto eps 2>&1)"
eq "--auto SUB on a non-sub is refused (exit 3)" "crew: refused: 'stranger' is not a live session joined under boss
3" "$("$CREW" compact --auto stranger 2>&1; echo $?)"

# --- compact SUB "focus": the one-off ---
: >"$T/send.log"
sub psi SID-N idle; transcript SID-N 90000
focus="keep the 'API' plan \"v2\" \$(touch $T/PWNED) \`touch $T/PWNED2\` & more; done"
eq "a one-off needs only idle and no prompt (ctx 90k is fine)" "compacted psi (ctx 90k)" "$("$CREW" compact psi "$focus" 2>&1)"
tp=$(target_of psi)
eq "the focus is one argv element after -l --, nothing interpolated; Enter is separate" \
"send-keys|-t|$tp|-l|--|/compact $focus|
send-keys|-t|$tp|Enter|" "$(sent)"
eq "the pane received the focus verbatim" "/compact $focus" "$(typed psi)"
check "no shell ran anything in it" test ! -e "$T/PWNED" -a ! -e "$T/PWNED2"
eq "newlines in a focus become spaces (one line, no early Enter)" "compacted psi (ctx 90k)" "$("$CREW" compact psi $'two\nlines' 2>&1)"
eq "(and arrived as one line)" "/compact two lines" "$(typed psi | tail -n 1)"
rc=$("$CREW" compact delta "x" >/dev/null 2>"$T/err"; echo $?)
eq "a busy sub is refused: exit 3" 3 "$rc"
eq "with the reason" "crew: refused: delta is busy (the pane shows esc to interrupt)" "$(cat "$T/err")"
rc=$("$CREW" compact theta >/dev/null 2>"$T/err"; echo $?)
eq "a sub with a permission prompt open is refused: exit 3" 3 "$rc"
eq "with the reason" "crew: refused: a prompt is open in theta's pane: answer it in tmux" "$(cat "$T/err")"
eq "nothing was typed into the busy or prompt panes" "" "$(typed delta)$(typed theta)"
rc=$("$CREW" compact nu >/dev/null 2>"$T/err"; echo $?)
eq "a sub that is not in a tmux pane is refused: exit 3" "3 crew: refused: nu is not in a tmux pane" "$rc $(cat "$T/err")"
ghost stranger SID-ST
rc=$("$CREW" compact stranger >/dev/null 2>"$T/err"; echo $?)
eq "a live session that is not one of my subs is refused" "3 crew: refused: 'stranger' is not a live session joined under boss" "$rc $(cat "$T/err")"
rc=$("$CREW" compact SID-ST >/dev/null 2>"$T/err"; echo $?)
eq "(also by sessionId)" "3 crew: refused: 'SID-ST' is not a live session joined under boss" "$rc $(cat "$T/err")"
rc=$("$CREW" compact boss >/dev/null 2>"$T/err"; echo $?)
eq "the lead cannot compact itself" "3 crew: refused: a session cannot compact itself" "$rc $(cat "$T/err")"
printf 'sub_name=sub-lead\nparent_name=boss\nparent_sid=SID-BOSS\n' >"$CREW_ROOT/.links/SID-SL"
out=$(as sub-lead SID-SL "$CREW" compact boss; echo "rc=$?")
eq "a sub cannot compact its own lead" "crew: refused: 'boss' is your own lead; only a lead compacts its subs
rc=3" "$out"
out=$(as sub-lead SID-SL "$CREW" compact alpha; echo "rc=$?")
eq "a sub cannot compact its lead's other subs" "crew: refused: 'alpha' is not a live session joined under sub-lead
rc=3" "$out"
out=$(as sub-lead SID-SL "$CREW" compact --auto; echo "rc=$?")
eq "a sub with no subs: --auto is quiet and exits 0" "rc=0" "$out"
mkdir -p "$T/nosessions"
rc=$(CREW_SESSIONS=$T/nosessions "$CREW" compact alpha >/dev/null 2>"$T/err"; echo $?)
eq "outside a claude session it is a usage error" "2 crew: not inside a claude session" "$rc $(cat "$T/err")"

# --- claude must be in the foreground of the pane ---
# (sh -c, so it does not depend on tmux's default shell: set -m puts the stand-in in its own process group, a background one, and
# its stdin is a pipe that stays open, so it stays alive instead of being stopped or EOF'd by a read from the tty)
tmux new-window -d -t cc: -n bg "sh -c 'set -m; sleep 600 | \"\$0\" \"\$@\" & sleep 600' $REEXEC_DIR/claude $T/standin fg SID-FG idle"
printf 'sub_name=fg\nparent_name=boss\nparent_sid=SID-BOSS\n' >"$CREW_ROOT/.links/SID-FG"
sleep 1
rc=$("$CREW" compact fg >/dev/null 2>"$T/err"; echo $?)
eq "a claude that is not the pane's foreground process is refused (keys would reach the shell)" "3 crew: refused: claude is not in the foreground of the pane" "$rc $(cat "$T/err")"
eq "and nothing was typed" "" "$(typed fg)"

# --- unsent text in the composer is never submitted ---
: >"$T/send.log"
sub dr SID-DR draft; transcript SID-DR 250000; task SID-DR 1016-dr "$MS"
rc=$("$CREW" compact dr "x" >/dev/null 2>"$T/err"; echo $?)
eq "a pane with a draft in the composer is refused: exit 3, reason draft" "3 crew: refused: draft: unsent text in dr's composer, nothing was typed" "$rc $(cat "$T/err")"
eq "--auto SUB says skip: draft" "skip dr: draft" "$("$CREW" compact --auto dr 2>&1)"
eq "the sweep skips it too" "skip dr: draft" "$("$CREW" compact --auto 2>&1 | grep '^[a-z]* dr:')"
eq "nothing at all was sent to the pane (no text, no Enter): the draft is untouched" "" "$(sent)"
eq "the draft is still the only thing in the composer" "❯ Please delete the deployment" "$(tmux capture-pane -p -t cc:dr | grep '❯')"
eq "subs shows the draft state" "dr                       live  ctx 250k  draft" "$("$CREW" subs 2>&1 | grep '^dr ')"
sub racer SID-RC idle race; transcript SID-RC 250000
rc=$("$CREW" compact racer "x" >/dev/null 2>"$T/err"; echo $?)
eq "text that appears in the composer while typing is refused: exit 3" "3 crew: refused: the composer does not hold exactly the typed text: Enter was not pressed, and the text may still be there" "$rc $(cat "$T/err")"
eq "and Enter was not pressed (the one send-keys call is the text)" 1 "$(sent | wc -l)"
eq "nothing was submitted" "" "$(typed racer)"

# --- a focus wider than the pane wraps over several composer lines (Claude's own layout): still typed, then Enter ---
wfocus="You are the acme-gateway review session. Keep: your role and review method, which PRs you reviewed and your open findings, and the project rules. Drop: step-by-step tool output from finished reviews. Note that a lot has changed since your last pass (PRs #55-#64 merged; #65-#68 open)."
wrapped="$(printf '─%.0s' $(seq 1 85)) acme-gateway-review ─
❯ /compact You are the acme-gateway review session. Keep: your role and review method, which PRs
  you reviewed and your open findings, and the project rules. Drop: step-by-step tool output from
  finished reviews. Note that a lot has changed since your last pass (PRs #55-#64 merged; #65-#68
  open).
$(printf '─%.0s' $(seq 1 103))"
: >"$T/send.log"
sub wrapper SID-WR idle wrap; transcript SID-WR 250000
eq "a focus wider than the pane is compacted (the wrapped composer is matched, Enter pressed)" "compacted wrapper (ctx 250k)" "$("$CREW" compact wrapper "$wfocus" 2>&1)"
eq "the pane received the whole /compact line, once" "/compact $wfocus" "$(typed wrapper)"
eq "text, then Enter" "2" "$(sent | wc -l)"
: >"$T/send.log"
sub stuck SID-WS idle wrap "/compact $wfocus"; transcript SID-WS 250000
eq "(fixture) a /compact left typed shows as four wrapped composer lines between the rules" "$wrapped" "$(tmux capture-pane -p -J -t cc:stuck | sed -n '/acme-gateway-review/,$p' | head -n 6)"
eq "crew compact with the identical focus sends only Enter to the unsent /compact" "compacted stuck (ctx 250k)" "$("$CREW" compact stuck "$wfocus" 2>&1)"
ts=$(target_of stuck)
eq "no text was typed again: Enter alone" "send-keys|-t|$ts|Enter|" "$(sent)"
eq "and the pane submitted the one line" "/compact $wfocus" "$(typed stuck)"
: >"$T/send.log"
sub other SID-WO idle wrap "/compact $wfocus and also delete the deployment"; transcript SID-WO 250000
rc=$("$CREW" compact other "$wfocus" >/dev/null 2>"$T/err"; echo $?)
eq "any other unsent text is still refused" "3 crew: refused: draft: unsent text in other's composer, nothing was typed" "$rc $(cat "$T/err")"
eq "and nothing was sent or submitted" "" "$(sent)$(typed other)"
# a word longer than the pane is broken mid-word, and the joined composer gets a space there: the identical unsent
# /compact is still matched (whitespace is not compared, as when typing)
lfocus="keep notes in /home/u/$(printf 'a%.0s' $(seq 1 120))/notes.md"
: >"$T/send.log"
sub longw SID-WL idle wrap "/compact $lfocus"; transcript SID-WL 250000
eq "an unsent /compact wrapped mid-word with the identical focus is compacted" "compacted longw (ctx 250k)" "$("$CREW" compact longw "$lfocus" 2>&1)"
eq "and gets Enter alone" "send-keys|-t|$(target_of longw)|Enter|" "$(sent)"

# --- thresholds come from the environment ---
: >"$T/send.log"
sub omega SID-O idle; transcript SID-O 150000; task SID-O 1016-omega "$MS"
eq "CREW_COMPACT_SOFT=100000 makes 150k due" "compacted omega (ctx 150k)" "$(CREW_COMPACT_SOFT=100000 "$CREW" compact --auto 2>&1 | grep omega)"

# --- a real /compact shows "Compacting conversation…" (no "esc to interrupt") above an empty composer: busy ---
printf 'earlier output\n\n✶ Compacting conversation… (4s · ↓ 116 tokens)\n' >"$T/screens/compacting"
sub cmpsub SID-XI compacting; transcript SID-XI 250000; task SID-XI 1016-cmpsub "$MS"
rc=$("$CREW" compact cmpsub >/dev/null 2>"$T/err"; echo $?)
eq "a sub that is compacting is busy: exit 3, the reason, nothing typed" "3 crew: refused: cmpsub is busy (the pane shows esc to interrupt) " "$rc $(cat "$T/err") $(typed cmpsub)"

# --- the rest of crew still works ---
"$CREW" ls >/dev/null 2>&1; eq "crew ls exits 0" 0 "$?"
"$CREW" compact >/dev/null 2>&1; eq "compact with no arguments is a usage error" 2 "$?"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
