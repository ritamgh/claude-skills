#!/usr/bin/env bash
# Test: `crew spawn` against REAL tmux (a private server, tmux -L), with a stand-in `claude` that is a script named
# claude: it registers a session json for itself, optionally runs `crew whoami` (the join), and blocks, or exits at
# once. The fake-tmux suite (test-crew-spawn.sh) runs the command synchronously; this one proves the window, the
# pane process, the reservation and the startup check against the real thing.
# This script re-executes itself through a symlink named claude so that its own process name is "claude" (that is how
# crew recognises a session), and the lead is this process.
#   bash test-crew-spawn-tmux.sh
set -uo pipefail

if [ "$(cat /proc/$$/comm)" != claude ]; then
  RX=$(mktemp -d); ln -s "$(command -v bash)" "$RX/claude"
  REEXEC_DIR=$RX exec "$RX/claude" "$(readlink -f "$0")" "$@"
fi
CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
TS=crewtest$$
unset TMUX TMUX_PANE   # never inherit the real server: the wrapper below pins -L, this keeps a stray bare tmux off it too
real_tmux=$(command -v tmux)
trap '"$real_tmux" -L "$TS" kill-server 2>/dev/null; rm -rf "$T" "${REEXEC_DIR:-}"' EXIT
mkdir -p "$T/bin" "$T/sessions" "$T/repo"
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects T CREW CREW_SPAWN_WAIT_S=2
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
unset CREW_LEAD_COMM
printf '#!/bin/bash\nexec %s -L %s "$@"\n' "$real_tmux" "$TS" >"$T/bin/tmux"
cat >"$T/bin/claude" <<'EOF'
#!/bin/bash
# stand-in claude: args are -n NAME [--model M] PROMPT. Mode (file $T/mode): die | idle | join
printf '%s\n' "$@" >"$T/args.$CREW_SPAWN_TASK"
pwd -P >"$T/pwd.$CREW_SPAWN_TASK"
mode=$(cat "$T/mode")
[ "$mode" != die ] || exit 1
if [ "$mode" = trust ]; then   # claude's folder-trust dialog (the real wording): it waits for a key, and records which one came
  printf 'Accessing workspace:\n\n /repo\n\n Quick safety check: Is this a project you created or one you trust?\n\n ❯ Yes, I trust this folder\n   No, exit\n\n Enter to confirm · Esc to cancel\n'
  read -r -t 4 -n1 key; printf '%s\n' "${key:-none}" >"$T/key.$CREW_SPAWN_TASK"; exit 0
fi
jq -nc --argjson pid $$ --arg n "$2" '{pid: $pid, name: $n, sessionId: ("SID-" + $n)}' >"$CREW_SESSIONS/child-$$.json"
if [ "$mode" = join ]; then "$CREW" whoami >"$T/whoami.$CREW_SPAWN_TASK" 2>&1; fi
mkfifo "$T/ff.$$" && exec 3<>"$T/ff.$$" && read -t 120 -u 3
EOF
chmod +x "$T/bin/tmux" "$T/bin/claude"
export PATH=$T/bin:$PATH
jq -nc --argjson pid $$ '{pid: $pid, name: "real-lead", sessionId: "SID-RL"}' >"$CREW_SESSIONS/lead.json"
tmux new-session -d -s claude -n main 'sleep 600'   # started after the exports: its panes inherit them

fails=0
check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }
idof() { sed -n 's/^id=//p' <<<"$1"; }
D=$(date +%m%d)
windows() { tmux list-windows -t claude: -F '#{window_name}' | grep -v '^main$' | sort | paste -sd' '; }
# whoami writes its lines one by one into the file: a non-empty file can be a half-written one (seen under load)
wait_for_subs() { local i; for i in $(seq 1 50); do grep -q '^subs:' "$1" 2>/dev/null && return 0; sleep 0.2; done; return 1; }

# --- a sub-lead that joins: the child's own `crew whoami` completes the join under the real pane ---
echo join >"$T/mode"
out=$("$CREW" spawn tm1 --repo "$T/repo" --model haiku -- "- a brief that starts with a dash" 2>&1); rc=$?
id=$(idof "$out")
eq "spawn against real tmux" "0 id=$D-tm1 window=claude:tm1 child=real-lead/tm1" "$rc $(paste -sd' ' <<<"$out")"
eq "the window exists" "tm1" "$(windows)"
wait_for_subs "$T/whoami.$id"
eq "the child joined from inside its pane" $'crew: joined: real-lead/tm1 reports to real-lead (spawned for '"$id"$')\nname: real-lead/tm1\nparent: real-lead (live)\nsubs: none' "$(cat "$T/whoami.$id" 2>/dev/null)"
eq "the stand-in claude got the argv intact" $'-n\nreal-lead/tm1\n--model\nhaiku\nYou are a sub-lead for real-lead on crew task '"$id"$'. Run `crew whoami` first (it completes your join). Read the brief at '"$CREW_ROOT/$id"$'/brief.md. Use /orchestrate (or /crew dispatch for small parts) to do it; report up to real-lead at milestones only per the crew skill\'s chain-of-command rules; when done, run `crew log '"$id"$' done` and `crew summary '"$id"$'`, then stop. Never ask the user in your own pane: every question is `crew ask '"$id"$' "<question>"` (it reaches your lead and HQ), and the answer arrives typed into your pane as the user\'s words. Do not close your window.' "$(cat "$T/args.$id")"
check "the reservation was consumed" test ! -e "$CREW_ROOT/.pending/$id"
eq "subs shows the live window" "real-lead/tm1            live  claude:tm1" "$("$CREW" subs)"

# --- a repo path is a directory, not a tmux format: #{...} and $HOME in it are literal ---
echo idle >"$T/mode"
odd="$T/"'odd#{pane_id}-$HOME'; mkdir -p "$odd"
out=$("$CREW" spawn oddrepo --repo "$odd" "b" 2>&1); id=$(idof "$out")
eq "a repo whose path holds #{pane_id} and \$HOME launches" "id=$D-oddrepo window=claude:oddrepo child=real-lead/oddrepo" "$(paste -sd' ' <<<"$out")"
wait_for_file() { local i; for i in $(seq 1 50); do [ -s "$1" ] && return 0; sleep 0.2; done; return 1; }
wait_for_file "$T/pwd.$id"
eq "claude started in exactly that directory" "$odd" "$(cat "$T/pwd.$id")"
tmux kill-window -t claude:oddrepo

# --- the folder-trust dialog is raised to HQ as a decision, and never answered by crew ---
echo trust >"$T/mode"
out=$("$CREW" spawn trusty --repo "$T/repo" "b" 2>&1); id=$(idof "$out")
eq "a spawn whose pane shows the trust dialog still succeeds, and says so with a decision id" "id=$D-trusty window=claude:trusty child=real-lead/trusty note=trust prompt open in claude:trusty (D1): accept it there" "$(paste -sd' ' <<<"$out")"
eq "the decision text names the window" "trust prompt open in claude:trusty: accept it there" "$(cat "$CREW_ROOT/$id/ask.md" 2>/dev/null)"
eq "crew pressed no key in the dialog" "none" "$(for i in $(seq 1 50); do [ -s "$T/key.$id" ] && { cat "$T/key.$id"; break; }; sleep 0.2; done)"
tmux kill-window -t claude:trusty 2>/dev/null
echo idle >"$T/mode"
out=$("$CREW" spawn untrusty --repo "$T/repo" "b" 2>&1)
eq "a pane without the dialog raises nothing" "id=$D-untrusty window=claude:untrusty child=real-lead/untrusty" "$(paste -sd' ' <<<"$out")"
tmux kill-window -t claude:untrusty 2>/dev/null

# --- a window that dies at once is a failed start, not a silent success ---
echo die >"$T/mode"
out=$("$CREW" spawn doomed --repo "$T/repo" "b" 2>&1; echo "rc=$?")
eq "a claude that exits at once fails the spawn" "crew: spawn: the sub-lead window closed right after launch (does \`claude\` start in $T/repo?) (task $D-doomed marked failed)
rc=2" "$out"
eq "its task is failed" "failed" "$(tail -n 1 "$CREW_ROOT/$D-doomed/status" | cut -f2)"
check "no reservation is left" test ! -e "$CREW_ROOT/.pending/$D-doomed"
eq "no window is left" "tm1" "$(windows)"

# --- a reservation lives and dies with its window ---
echo idle >"$T/mode"
for n in 1 2; do "$CREW" spawn "idle$n" --repo "$T/repo" "b" >/dev/null; done
touch -d '3 hours ago' "$CREW_ROOT"/.pending/*-idle[12]
out=$("$CREW" spawn idle3 --repo "$T/repo" "b" 2>&1; echo "rc=$?")
eq "three sub-leads (one joined, two idle for hours) fill the limit" "crew: spawn refused: real-lead already has 3 live sub-leads (max 3). Wait for one to finish or dispatch a worker.
rc=2" "$out"
tmux kill-window -t claude:idle1
out=$("$CREW" spawn idle3 --repo "$T/repo" "b" 2>&1)
eq "closing a sub-lead's window frees its place" "id=$D-idle3 window=claude:idle3 child=real-lead/idle3" "$(paste -sd' ' <<<"$out")"
check "the closed window's reservation was dropped" test ! -e "$CREW_ROOT/.pending/$D-idle1"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
