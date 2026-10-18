#!/usr/bin/env bash
# Test: shared crew paths for feature owners (fix card FXc).
#   F10  a long /compact line that real Claude wraps in its composer (continuation lines indented by two spaces up to the
#        composer's bottom border) is still read as the typed text, also when a long word wraps mid-word; an empty composer
#        reads as empty and a wrapped user draft as a draft.
#   F6   a woken owner that comes back under a NEW sessionId counts once against its lead's sub-lead limit.
#   F4   `crew next` names `crew wake --resume` for a RAM-queued wake task.
# Real tmux on a private server (tmux -L) for F10; the panes run a stand-in `claude` that draws the composer the way real
# Claude does. This script re-executes itself through a symlink named claude so that it is the lead session.
#   (unset TMUX; bash test-crew-ownerfix.sh)
set -uo pipefail

if [ "$(cat /proc/$$/comm)" != claude ]; then
  RX=$(mktemp -d); ln -s "$(command -v bash)" "$RX/claude"
  REEXEC_DIR=$RX exec "$RX/claude" "$(readlink -f "$0")" "$@"
fi
unset TMUX TMUX_PANE CREW_LEAD_COMM CREW_AS_USER CREW_COMPACT_SOFT CREW_COMPACT_HARD
CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
TS=crewownerfix$$
real_tmux=$(command -v tmux)
trap '"$real_tmux" -L "$TS" kill-server 2>/dev/null; kill $BG 2>/dev/null; rm -rf "$T" "${REEXEC_DIR:-}"' EXIT
BG=""
mkdir -p "$T/bin" "$T/sessions" "$T/projects/p"
export LC_ALL=C.UTF-8 CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-16T10:00:00Z T CREW
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
export CREW_COMPACT_SETTLE_S=0.3 CREW_COMPACT_POLL_S=0.2 CREW_COMPACT_WAIT_S=20
printf '#!/bin/bash\nunset TMUX TMUX_PANE\nexec %s -L %s "$@"\n' "$real_tmux" "$TS" >"$T/bin/tmux"
# stand-in claude (run through the claude symlink, so the pane's process is named claude): NAME SID WIDTH FOLD [DRAFT].
# Draws what real Claude draws: a border, the composer ("❯" + NBSP, then the text wrapped at WIDTH columns, continuation
# lines indented by two spaces), a border and a footer. FOLD: word (break at spaces) or char (a long word breaks mid-word).
# Each line typed is logged to T/typed.NAME.
cat >"$T/standin" <<'EOF'
#!/bin/bash
name=$1 sid=$2 width=$3 fold=$4 buf=${5:-}
jq -nc --argjson pid $$ --arg n "$name" --arg s "$sid" '{pid: $pid, name: $n, sessionId: $s, cwd: "/x"}' >"$CREW_SESSIONS/$sid.json"
border=$(printf '─%.0s' $(seq 1 60))
draw() {
  local first=1 l
  printf '\033[2J\033[H'
  printf 'earlier output\n\n%s\n' "$border"
  if [ -z "$buf" ]; then printf '❯\xc2\xa0\n'
  else
    if [ "$fold" = word ]; then lines=$(printf '%s' "$buf" | fold -s -w "$width"); else lines=$(printf '%s' "$buf" | fold -w "$width"); fi
    while IFS= read -r l; do
      if [ $first = 1 ]; then printf '❯\xc2\xa0%s\n' "$l"; first=0; else printf '  %s\n' "$l"; fi
    done <<<"$lines"
  fi
  printf '%s\n  Haiku 5.5 · claude-config (main) · ctx -- · 5h -- · RAM 4.9G\n' "$border"
}
stty -echo
draw
while IFS= read -r -n1 ch; do
  if [ -z "$ch" ]; then printf '%s\n' "$buf" >>"$T/typed.$name"; buf=""; else buf+=$ch; fi
  draw
done
EOF
chmod +x "$T/bin/tmux" "$T/standin"
export PATH=$T/bin:$PATH
jq -nc --argjson pid $$ '{pid: $pid, name: "boss", sessionId: "SID-BOSS", cwd: "/x"}' >"$CREW_SESSIONS/boss.json"
tmux new-session -d -x 200 -y 40 -s cc -n main 'sleep 600'   # started after the exports: its panes inherit them

fails=0
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }
as() { # as NAME SID cmd...: run in a fresh process (named claude) of session NAME/SID
  local name=$1 sid=$2; shift 2
  "$REEXEC_DIR/claude" -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"; exit $?' _ "$name" "$sid" "$@" 2>&1   # (not the last command: bash would exec it and lose the claude name)
}
link() { mkdir -p "$CREW_ROOT/.links"; printf 'sub_name=%s\nparent_name=boss\nparent_sid=SID-BOSS\n' "$2" >"$CREW_ROOT/.links/$1"; }
ghost() { # NAME SID: a live session that is in no tmux pane
  "$REEXEC_DIR/claude" -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/$2.json"; while :; do sleep 1; done' _ "$1" "$2" &
  BG="$BG $!"
  sleep 0.3
}

# --- F10: a wrapped composer ---
FOCUS='asleep next: keep the feat owner notes at /tmp/claude-1001/fo-qa/crew/.owners/feat/notes.md, open talk threads, interface decisions and the next step'
sub() { # NAME SID WIDTH FOLD [DRAFT]: a live sub in its own window, joined under boss
  link "$2" "$1"
  tmux new-window -d -t cc: -n "$1" "$REEXEC_DIR/claude" "$T/standin" "$1" "$2" "$3" "$4" "${5:-}"
  local i; for i in $(seq 1 50); do [ -s "$CREW_SESSIONS/$2.json" ] && break; sleep 0.1; done
  sleep 0.3
}
compact() { # NAME FOCUS: `crew compact` as boss; prints "rc=N <output>"
  local out rc; out=$(as boss SID-BOSS "$CREW" compact "$1" "$2"); rc=$?
  printf 'rc=%s %s' "$rc" "$out"
}

sub wrap2 SID-W2 100 word
eq "F10 /compact wrapped onto two lines is read as typed: Enter pressed" "rc=0 compacted wrap2 (ctx 0k)" "$(compact wrap2 "$FOCUS")"
eq "F10 the two-line wrap submitted the whole text, once" "/compact $FOCUS" "$(cat "$T/typed.wrap2" 2>/dev/null)"

sub wrap3 SID-W3 60 word
eq "F10 /compact wrapped onto three lines is read as typed" "rc=0 compacted wrap3 (ctx 0k)" "$(compact wrap3 "$FOCUS")"
eq "F10 the three-line wrap submitted the whole text, once" "/compact $FOCUS" "$(cat "$T/typed.wrap3" 2>/dev/null)"

sub mid SID-MID 37 char
eq "F10 a word that wraps mid-word still counts as the typed text" "rc=0 compacted mid (ctx 0k)" "$(compact mid "$FOCUS")"
eq "F10 the mid-word wrap submitted the whole text, once" "/compact $FOCUS" "$(cat "$T/typed.mid" 2>/dev/null)"

sub draft SID-DR 60 word 'Please delete the deployment of the staging cluster and then remove every old backup we still keep around'
eq "F10 a wrapped user draft is still a draft: nothing typed" "rc=3 crew: refused: draft: unsent text in draft's composer, nothing was typed" "$(compact draft "$FOCUS")"
eq "F10 the draft pane received no /compact" "" "$(cat "$T/typed.draft" 2>/dev/null)"

sub dash SID-DA 60 word '── a draft that starts like a border'
eq "S3 a draft that starts with a border character is a draft: nothing typed" "rc=3 crew: refused: draft: unsent text in dash's composer, nothing was typed" "$(compact dash "$FOCUS")"
eq "S3 the pane of that draft received no /compact" "" "$(cat "$T/typed.dash" 2>/dev/null)"

# the F10 subs are done: close their windows and unjoin them, so that boss has no subs but the ones F6 sets up
for w in wrap2 wrap3 mid draft dash; do tmux kill-window -t "cc:$w"; done
rm -f "$CREW_ROOT"/.links/* "$CREW_SESSIONS"/SID-W2.json "$CREW_SESSIONS"/SID-W3.json "$CREW_SESSIONS"/SID-MID.json "$CREW_SESSIONS"/SID-DR.json "$CREW_SESSIONS"/SID-DA.json

# --- F6: a woken owner under a new sessionId counts once ---
# boss has peer1 and peer2 live; the owner `web` (old life SID-OLD, not running) comes back as SID-NEW with the same
# name and its first crew call completes the join of the wake task 0101-web.
ghost peer1 SID-P1; link SID-P1 peer1
ghost peer2 SID-P2; link SID-P2 peer2
link SID-OLD web
printf '{"type":"user","uuid":"U-OLD","sessionId":"SID-OLD"}\n' >"$T/projects/p/SID-OLD.jsonl"
{ cat "$T/projects/p/SID-OLD.jsonl"; printf '{"type":"user","uuid":"U-NEW","sessionId":"SID-NEW"}\n'; } >"$T/projects/p/SID-NEW.jsonl"
mkdir -p "$CREW_ROOT/0101-web" "$CREW_ROOT/.pending"
printf 'spawned=1\nspawn_slug=web\nresume_sid=SID-OLD\nowner=web\nwoken_by=boss\nlead=boss\nlead_sid=SID-BOSS\nsub=web\nsub_sid=SID-OLD\n' >"$CREW_ROOT/0101-web/meta"
printf '2026-10-16T09:00:00Z\tqueued\twake\n' >"$CREW_ROOT/0101-web/status"
printf 'parent_name=boss\nparent_sid=SID-BOSS\nchild_name=web\ntoken=tok123\nwindow_id=@%s\npane_pid=%s\n' "$(tmux display-message -p -t cc:main '#{window_id}' | tr -d @)" "$$" >"$CREW_ROOT/.pending/0101-web"
ghost web SID-NEW
out=$(as web SID-NEW env CREW_SPAWN_TASK=0101-web CREW_SPAWN_TOKEN=tok123 "$CREW" whoami)
case "$out" in *"spawn join refused"*) refused=refused ;; *) refused=joined ;; esac
eq "F6 the woken owner is joined, not refused at 3 live sub-leads" joined "$refused"
eq "F6 the wake task's sub_sid is the new sessionId" "SID-NEW" "$(grep '^sub_sid=' "$CREW_ROOT/0101-web/meta" | tail -n 1 | cut -d= -f2)"
eq "F6 the lead lists three live subs" "3" "$(as boss SID-BOSS "$CREW" subs | grep -c ' live')"

# --- F4: crew next hint for a RAM-queued wake task ---
mkdir -p "$CREW_ROOT/0101-f4"
printf 'spawned=1\nspawn_slug=f4\nresume_sid=SID-F4\nowner=f4\nlead=boss\nlead_sid=SID-BOSS\n' >"$CREW_ROOT/0101-f4/meta"
printf '2026-10-16T09:30:00Z\tqueued\twaiting for RAM\n' >"$CREW_ROOT/0101-f4/status"
eq "F4 the hint for a queued wake is crew wake --resume" "ok to start: 0101-f4 (crew wake --resume 0101-f4)" "$(CREW_MEM_MIN_MB=1 "$CREW" next | grep '^ok to start')"

echo
if [ $fails = 0 ]; then echo "all passed"; else echo "$fails failed"; exit 1; fi
