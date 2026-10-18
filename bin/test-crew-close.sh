#!/usr/bin/env bash
# Test: `crew close SUB [--force-draft]` closes a session's tmux window (by window id) only for SUB's direct lead (the
# chain link by sessionId, following .prev), for HQ (CREW_AS_USER=1, set only by HQ and the user), and only when the
# window holds just SUB's pane, SUB is idle and its composer is empty (unless --force-draft).
# Real tmux on a private server (tmux -L, TMUX unset) behind a wrapper; the panes run a stand-in `claude` that
# registers a session json for itself and draws a screen (idle / busy / prompt / draft). This script re-executes itself
# through a symlink named claude so that it is the session `boss`.
#   bash test-crew-close.sh
set -uo pipefail

if [ "$(cat /proc/$$/comm)" != claude ]; then
  RX=$(mktemp -d); ln -s "$(command -v bash)" "$RX/claude"
  REEXEC_DIR=$RX exec "$RX/claude" "$(readlink -f "$0")" "$@"
fi
unset TMUX TMUX_PANE
CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
TS=crewclose$$
real_tmux=$(command -v tmux)
trap '"$real_tmux" -L "$TS" kill-server 2>/dev/null; rm -rf "$T" "${REEXEC_DIR:-}"' EXIT
mkdir -p "$T/bin" "$T/sessions" "$T/projects/p" "$T/screens"
export LC_ALL=C.UTF-8 CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-17T10:00:00Z T CREW
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
unset CREW_LEAD_COMM CREW_AS_USER
# T/hook.CMD (executable) runs just before the Nth `tmux CMD` (N in T/hookn.CMD, default 1): changes the world at an exact point
printf '#!/bin/bash\nif [ -x "$T/hook.$1" ]; then n=$(($(cat "$T/hookc.$1" 2>/dev/null || echo 0) + 1)); echo $n >"$T/hookc.$1"; [ "$n" != "$(cat "$T/hookn.$1" 2>/dev/null || echo 1)" ] || "$T/hook.$1" >/dev/null 2>&1 || true; fi\nexec %s -L %s "$@"\n' "$real_tmux" "$TS" >"$T/bin/tmux"
cat >"$T/standin" <<'EOF'
#!/bin/bash
# stand-in claude (run through the claude symlink): NAME SID SCREEN. Registers itself, draws SCREEN and a composer, logs
# each line typed into it to T/typed.NAME.
name=$1 sid=$2 screen=$3
jq -nc --argjson pid $$ --arg n "$name" --arg s "$sid" '{pid: $pid, name: $n, sessionId: $s, cwd: "/x"}' >"$CREW_SESSIONS/$sid.json"
printf '\033[2J\033[H'; cat "$T/screens/$screen"
case "$screen" in prompt) read -r -t 600 line; exit 0 ;; esac
case "$screen" in draft) printf '❯ Please delete the deployment' ;; *) printf '❯ ' ;; esac
while IFS= read -r line; do printf '%s\n' "$line" >>"$T/typed.$name"; done
EOF
chmod +x "$T/bin/tmux" "$T/standin"
printf 'earlier output\n\n  ? for shortcuts\n' >"$T/screens/idle"
printf 'earlier output\n\n✻ Working… (12s · esc to interrupt)\n' >"$T/screens/busy"
printf 'earlier output\n\n  ? for shortcuts\n' >"$T/screens/draft"
printf 'Bash command\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n' >"$T/screens/prompt"
export PATH=$T/bin:$PATH
jq -nc --argjson pid $$ '{pid: $pid, name: "boss", sessionId: "SID-BOSS", cwd: "/x"}' >"$CREW_SESSIONS/boss.json"
tmux new-session -d -x 120 -y 40 -s cc -n main 'sleep 600'   # started after the exports: its panes inherit them
tmux new-session -d -x 120 -y 40 -s dd -n main 'sleep 600'
tmux set-option -g renumber-windows on   # as the user's server: a window's index is not its identity

fails=0
check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }
as() { # as NAME SID cmd...: run in a fresh process (named claude) of session NAME/SID
  local name=$1 sid=$2; shift 2
  "$REEXEC_DIR/claude" -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"; exit $?' _ "$name" "$sid" "$@" 2>&1
}
plain() { # plain cmd...: run with no claude session among its ancestors (what HQ's web server is)
  local f=$T/plain.$RANDOM
  setsid -f bash -c 'out=$("$@" 2>&1); rc=$?; printf "%s\n%s" "$rc" "$out" >"$0.tmp"; mv "$0.tmp" "$0"' "$f" "$@" </dev/null >/dev/null 2>&1
  local i; for i in $(seq 1 100); do [ -f "$f" ] && break; sleep 0.1; done
  printf 'rc=%s %s' "$(head -n 1 "$f")" "$(tail -n +2 "$f")"
}
run() { local out rc; out=$("$@" 2>&1); rc=$?; printf 'rc=%s %s' "$rc" "$out"; }
# live NAME SID SCREEN: a session SID named NAME, a stand-in in its own tmux window named NAME (session cc)
live() {
  local name=$1 sid=$2 screen=$3
  tmux new-window -d -t cc: -n "$name" "$REEXEC_DIR/claude" "$T/standin" "$name" "$sid" "$screen"
  local i; for i in $(seq 1 50); do [ -s "$CREW_SESSIONS/$sid.json" ] && break; sleep 0.1; done
  sleep 0.2
}
link() { mkdir -p "$CREW_ROOT/.links"; printf 'sub_name=%s\nparent_name=%s\nparent_sid=%s\n' "$2" "$3" "$4" >"$CREW_ROOT/.links/$1"; }   # SUB-SID sub-name parent-name parent-sid
task() { # SID ID STATE: a task of that session
  mkdir -p "$CREW_ROOT/$1-$2"
  printf 'sub_sid=%s\n' "$1" >"$CREW_ROOT/$1-$2/meta"
  printf '2026-10-17T09:00:00Z\t%s\tstart\n' "$3" >"$CREW_ROOT/$1-$2/status"
}
windows() { tmux list-windows -a -F '#{session_name}:#{window_name}' | sort | tr '\n' ' '; }
wid() { tmux display-message -p -t "cc:$1" '#{window_id}'; }

# --- the lead closes its sub: by window id, never touching a window of the same name or its neighbours ---
live subA SID-A idle; link SID-A subA boss SID-BOSS
live keepB SID-KB idle
tmux new-window -d -t cc: -n subA 'sleep 600'   # a decoy with the same NAME, created later (so a name lookup would hit it)
live afterC SID-AC idle
task SID-A t1 running; task SID-A t2 done
decoy=$(tmux list-windows -t cc: -F '#{window_id} #{window_name}' | awk '$2 == "subA" {print $1}' | tail -n 1)
real=$(tmux list-windows -t cc: -F '#{window_id} #{window_name} #{pane_current_command}' | awk '$2 == "subA" && $3 != "sleep" {print $1}')
out=$(run "$CREW" close subA)
eq "the lead closes its sub" "rc=0 closed: subA, window cc:subA ($real)" "$out"
eq "only the sub's own window is gone, the same-named decoy and the neighbours stay" "cc:afterC cc:keepB cc:main cc:subA dd:main " "$(windows)"
eq "the decoy window survives (closed by id)" "$decoy" "$(tmux list-windows -t cc: -F '#{window_id} #{window_name}' | awk '$2 == "subA" {print $1}')"
eq "the open task got a close line in its current state" "running	closed by boss (crew close)" "$(tail -n 1 "$CREW_ROOT/SID-A-t1/status" | cut -f2-)"
eq "a done task is left alone" "1" "$(wc -l <"$CREW_ROOT/SID-A-t2/status")"
tmux kill-window -t "$decoy"

# --- nobody but the direct lead: a sibling, a grandparent ---
live subB SID-B idle; link SID-B subB boss SID-BOSS
live kid SID-KID idle; link SID-KID kid subB SID-B
out=$(as other SID-OTH "$CREW" close subB; echo "rc=$?")
eq "a session that is not its lead is refused" $'crew: refused: subB reports to boss; only boss or HQ can close it\nrc=3' "$out"
out=$(run "$CREW" close kid)
eq "the grandparent is refused: only the direct lead" "rc=3 crew: refused: kid reports to subB; only subB or HQ can close it" "$out"
kidw=$(wid kid)
out=$(as subB SID-B "$CREW" close kid; echo "rc=$?")
eq "the direct lead closes (subB closes kid)" "closed: kid, window cc:kid ($kidw)"$'\nrc=0' "$out"
eq "kid is gone, subB stays" "cc:afterC cc:keepB cc:main cc:subB dd:main " "$(windows)"
live loner SID-LONE idle
out=$(run "$CREW" close loner)
eq "a session that reports to no one: only HQ" "rc=3 crew: refused: loner reports to no one; only HQ can close it" "$out"
eq "a sub cannot close its own lead" $'crew: refused: boss reports to no one; only HQ can close it\nrc=3' "$(as subB SID-B "$CREW" close boss; echo "rc=$?")"
eq "a session cannot close itself" $'crew: refused: selfy cannot close itself (exit it from inside)\nrc=3' "$(as selfy SID-SELF "$CREW" close selfy; echo "rc=$?")"
eq "not even as the user" $'crew: refused: selfy cannot close itself (exit it from inside)\nrc=3' "$(CREW_AS_USER=1 as selfy SID-SELF "$CREW" close selfy; echo "rc=$?")"

# --- HQ: CREW_AS_USER=1 (from a claude session or a plain process) ---
live deep SID-DEEP idle; link SID-DEEP deep subB SID-B
eq "a plain process without CREW_AS_USER is refused" "rc=3 crew: refused: deep reports to subB; only subB or HQ can close it" "$(plain "$CREW" close deep)"
eq "CREW_AS_USER=1 from a plain process closes any session" "rc=0 closed: deep, window cc:deep ($(wid deep))" "$(plain env CREW_AS_USER=1 "$CREW" close deep)"
live deep2 SID-DEEP2 idle; link SID-DEEP2 deep2 subB SID-B
eq "CREW_AS_USER=1 from a claude session that is not its lead closes it" "rc=0 closed: deep2, window cc:deep2 ($(wid deep2))" "$(CREW_AS_USER=1 run "$CREW" close deep2)"
live deep3 SID-DEEP3 idle; link SID-DEEP3 deep3 subB SID-B
eq "a session merely named hq has no authority (names are caller-controlled)" $'crew: refused: deep3 reports to subB; only subB or HQ can close it\nrc=3' "$(as hq SID-HQ "$CREW" close deep3; echo "rc=$?")"
live loner2 SID-LONE2 idle
eq "HQ closes a session with no lead" "rc=0 closed: loner2, window cc:loner2 ($(wid loner2))" "$(CREW_AS_USER=1 run "$CREW" close loner2)"

# --- the chain follows .prev: a restarted lead and a restarted sub ---
live resub SID-RESUB-NEW idle
link SID-RESUB-OLD resub boss SID-BOSS-OLD   # the link is still filed under the sub's old id and names the lead's old id
mkdir -p "$CREW_ROOT/.prev"; printf 'SID-RESUB-OLD\n' >"$CREW_ROOT/.prev/SID-RESUB-NEW"; printf 'SID-BOSS-OLD\n' >"$CREW_ROOT/.prev/SID-BOSS"
eq "a lead that restarted (its .prev lists the id in the link) closes a sub that restarted" "rc=0 closed: resub, window cc:resub ($(wid resub))" "$(run "$CREW" close resub)"

# --- authority is by sessionId only: a new session that takes a dead lead's name inherits nothing, and no link is rewritten
live impsub SID-IMPSUB idle; link SID-IMPSUB impsub oldlead SID-OLDLEAD   # the lead SID-OLDLEAD is not running
before=$(cat "$CREW_ROOT/.links/SID-IMPSUB")
eq "a session with the dead lead's name cannot close its sub" $'crew: refused: impsub: lead gone: only HQ can close it\nrc=3' "$(as oldlead SID-IMPOSTOR "$CREW" close impsub; echo "rc=$?")"
eq "the link still names the dead lead's sessionId" "$before" "$(cat "$CREW_ROOT/.links/SID-IMPSUB")"
as oldlead SID-IMPOSTOR "$CREW" subs >/dev/null   # listing the subs of the name it took must not re-point their links to it
eq "crew subs by the impostor leaves the link naming the dead lead's sessionId" "$before" "$(cat "$CREW_ROOT/.links/SID-IMPSUB")"
eq "and close is still refused to it afterwards" $'crew: refused: impsub: lead gone: only HQ can close it\nrc=3' "$(as oldlead SID-IMPOSTOR "$CREW" close impsub; echo "rc=$?")"
eq "the sub of a dead lead is refused for a plain process too" "rc=3 crew: refused: impsub: lead gone: only HQ can close it" "$(plain "$CREW" close impsub)"
eq "HQ closes it" "rc=0 closed: impsub, window cc:impsub ($(wid impsub))" "$(CREW_AS_USER=1 run "$CREW" close impsub)"
live renamed SID-REN idle; link SID-REN renamed staleboss SID-BOSS   # the link carries an old label of the lead; its sessionId is right
eq "a lead that was renamed (same sessionId) still closes" "rc=0 closed: renamed, window cc:renamed ($(wid renamed))" "$(run "$CREW" close renamed)"

# --- what is in the window: other panes, a draft, a busy turn, a prompt ---
live splitf SID-SP idle; link SID-SP splitf boss SID-BOSS
tmux split-window -d -t cc:splitf 'sleep 600'
eq "a window with a second pane (an nvim split) is refused" "rc=3 crew: refused: window has 2 panes (e.g. an nvim split): close the others first" "$(run "$CREW" close splitf)"
live draftf SID-DR draft; link SID-DR draftf boss SID-BOSS
eq "an unsent draft in the composer is refused" "rc=3 crew: refused: unsent text in draftf's composer (draft): nothing closed; --force-draft closes it anyway" "$(run "$CREW" close draftf)"
check "the draft window is still there" tmux has-session -t cc:draftf
eq "--force-draft closes it" "rc=0 closed: draftf, window cc:draftf ($(wid draftf))" "$(run "$CREW" close draftf --force-draft)"
live busyf SID-BY busy; link SID-BY busyf boss SID-BOSS
eq "a busy session is refused" "rc=3 crew: refused: busyf is busy (mid-turn): try again when it is idle" "$(run "$CREW" close busyf)"
eq "--force-draft does not close a busy one" "rc=3 crew: refused: busyf is busy (mid-turn): try again when it is idle" "$(run "$CREW" close busyf --force-draft)"
live promptf SID-PR prompt; link SID-PR promptf boss SID-BOSS
eq "an open permission prompt is refused" "rc=3 crew: refused: a prompt is open in promptf's pane: answer it in tmux first" "$(run "$CREW" close promptf)"
for n in splitf draftf busyf promptf; do eq "$n received nothing" "" "$(cat "$T/typed.$n" 2>/dev/null)"; done

# --- the composer is read again right before the kill: a draft typed after the first look is not lost
live racef SID-RACE idle; link SID-RACE racef boss SID-BOSS
cat >"$T/hook.list-clients" <<EOF
#!/bin/bash
$real_tmux -L $TS send-keys -t cc:racef -l 'half a message'
sleep 0.3
EOF
chmod +x "$T/hook.list-clients"; echo 2 >"$T/hookn.list-clients"   # the second list-clients is the last window check before the kill
eq "a draft typed after the first idle check stops the close" "rc=3 crew: refused: unsent text in racef's composer (draft): nothing closed; --force-draft closes it anyway" "$(run "$CREW" close racef)"
check "the window of the racing session is still there" tmux has-session -t cc:racef
rm -f "$T/hook.list-clients" "$T/hookc.list-clients" "$T/hookn.list-clients"

# --- not a session, not in tmux, usage ---
eq "a name that is not running" "rc=3 crew: refused: nope is not running: nothing to close" "$(run "$CREW" close nope)"
"$REEXEC_DIR/claude" -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/$2.json"; while :; do sleep 1; done' _ nopane SID-NP &
NP=$!; sleep 0.3; link SID-NP nopane boss SID-BOSS
eq "a session outside tmux" "rc=3 crew: refused: nopane has no tmux pane (it is not running in tmux): nothing to close" "$(run "$CREW" close nopane)"
kill "$NP" 2>/dev/null
eq "no argument" "rc=2 crew: close needs SUB (a live session name)" "$(run "$CREW" close)"
eq "two names" "rc=2 crew: close takes one SUB" "$(run "$CREW" close a b)"
eq "an unknown flag" "rc=2 crew: unknown flag --force" "$(run "$CREW" close a --force)"
live twin1 SID-TW1 idle; link SID-TW1 same boss boss SID-BOSS
sed -i 's/"twin1"/"same"/' "$CREW_SESSIONS/SID-TW1.json"
live twin2 SID-TW2 idle; sed -i 's/"twin2"/"same"/' "$CREW_SESSIONS/SID-TW2.json"
eq "two live sessions with one name are refused" "rc=3 crew: refused: 2 live sessions are named same: nothing closed" "$(run "$CREW" close same)"

# --- the last window of a tmux session is never closed (that would end the session) ---
tmux new-session -d -x 120 -y 40 -s solo -n only "$REEXEC_DIR/claude" "$T/standin" lastw SID-LAST idle
for i in $(seq 1 50); do [ -s "$CREW_SESSIONS/SID-LAST.json" ] && break; sleep 0.1; done; sleep 0.2
eq "the only window of its tmux session is refused" "rc=3 crew: refused: lastw's window is the last one in its tmux session: nothing closed" "$(CREW_AS_USER=1 run "$CREW" close lastw)"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
