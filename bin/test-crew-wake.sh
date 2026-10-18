#!/usr/bin/env bash
# Test: `crew wake FEATURE "task"` and `crew wake --resume ID` against REAL tmux (a private server, tmux -L). The owner
# registry folders are written by hand in the format crew-owners.sh documents. The stand-in `claude` records its argv
# (one element per line, and the count), registers a session json, and with `--resume OLD` either keeps OLD (mode
# same) or comes up under a NEW sessionId with a transcript that starts with the old life's records (mode new, the way
# a real resume does); then it runs `crew whoami` (which completes the join and the relink) and blocks.
# This script re-executes itself through a symlink named claude so that its own process name is "claude" (that is how
# crew recognises a session): it is the owner's lead, user-b8.
#   bash test-crew-wake.sh
set -uo pipefail

if [ "$(cat /proc/$$/comm)" != claude ]; then
  RX=$(mktemp -d); ln -s "$(command -v bash)" "$RX/claude"
  REEXEC_DIR=$RX exec "$RX/claude" "$(readlink -f "$0")" "$@"
fi
RX=$REEXEC_DIR
CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
TS=crewwake$$
BGS=""
unset TMUX TMUX_PANE   # never inherit the real server: the wrapper below pins -L, this keeps a stray bare tmux off it too
real_tmux=$(command -v tmux)
trap 'kill $BGS 2>/dev/null; "$real_tmux" -L "$TS" kill-server 2>/dev/null; rm -rf "$T" "${REEXEC_DIR:-}"' EXIT
mkdir -p "$T/bin" "$T/sessions" "$T/repo" "$T/re#{pane_id}\$HOME" "$T/projects/-x"
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-17T09:00:00Z T CREW CREW_SPAWN_WAIT_S=2 CREW_SPAWN_TRUST_WAIT_S=0   # (no trust dialog in a stand-in: do not poll for one)
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
unset CREW_LEAD_COMM CREW_AS_USER CREW_MEM_MIN_MB
printf '#!/bin/bash\nexec %s -L %s "$@"\n' "$real_tmux" "$TS" >"$T/bin/tmux"
cat >"$T/bin/claude" <<'EOF'
#!/bin/bash
# stand-in claude: args are --resume OLD -n NAME [--model M] PROMPT. Mode (file $T/mode): same | new | die
printf '%s\n' "$@" >"$T/args.$CREW_SPAWN_TASK"
pwd -P >"$T/cwd.$CREW_SPAWN_TASK"
echo $# >"$T/argc.$CREW_SPAWN_TASK"
# mode die: starts, then dies before it ever runs crew (read, not sleep: the pane's process must stay "claude")
[ "$(cat "$T/mode")" != die ] || { mkfifo "$T/df.$$" && exec 3<>"$T/df.$$" && read -t 4 -u 3; exit 1; }
sid=$2
if [ "$(cat "$T/mode")" = new ]; then
  sid=SID-NEW
  { cat "$CREW_PROJECTS/-x/$2.jsonl"; printf '{"type":"user","uuid":"U-NEW","sessionId":"SID-NEW"}\n'; } >"$CREW_PROJECTS/-x/SID-NEW.jsonl"
fi
jq -nc --argjson pid $$ --arg n "$4" --arg s "$sid" '{pid: $pid, name: $n, sessionId: $s}' >"$CREW_SESSIONS/child-$$.json"
"$CREW" whoami >"$T/whoami.$CREW_SPAWN_TASK" 2>&1
mkfifo "$T/ff.$$" && exec 3<>"$T/ff.$$" && read -t 120 -u 3
EOF
# a session that is not the owner's lead nor the owner: runs its arguments with its own pid registered as user-b8/other
cat >"$T/sib.sh" <<'EOF'
#!/bin/bash
jq -nc --argjson pid $$ '{pid: $pid, name: "user-b8/other", sessionId: "SID-SIB"}' >"$CREW_SESSIONS/sib.json"
"$@"; rc=$?; rm -f "$CREW_SESSIONS/sib.json"; exit $rc
EOF
chmod +x "$T/bin/tmux" "$T/bin/claude"
export PATH=$T/bin:$PATH
jq -nc --argjson pid $$ '{pid: $pid, name: "user-b8", sessionId: "SID-RL"}' >"$CREW_SESSIONS/lead.json"
tmux new-session -d -s claude -n main 'sleep 600'   # started after the exports: its panes inherit them

fails=0
check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }
D=$(date +%m%d)
windows() { tmux list-windows -t claude: -F '#{window_name}' | grep -v '^main$' | sort | paste -sd' '; }
wait_for() { local i; for i in $(seq 1 50); do grep -q "^subs:" "$1" 2>/dev/null && return 0; sleep 0.2; done; return 1; }   # whoami ends with its subs line
sibling() { "$RX/claude" "$T/sib.sh" "$@"; }
run() { local out rc; out=$("$@" 2>&1); rc=$?; printf 'rc=%s %s' "$rc" "$out"; }
ofile() { printf '%s/.owners/%s/owner' "$CREW_ROOT" "$1"; }
mkowner() { # feature name sid repo state: an owner folder as crew-owners.sh documents it (lead user-b8, SID-RL)
  mkdir -p "$CREW_ROOT/.owners/$1" "$CREW_ROOT/.links"
  printf 'feature=%s\nrepo=%s\npath=src/web/**\npath=docs/\nsid=%s\nname=%s\nlead=user-b8\nlead_sid=SID-RL\nnotes=%s\nstate=%s\ncreated=2026-10-15T09:00:00Z\nslept_at=2026-10-16T08:00:00Z\n' \
    "$1" "$4" "$3" "$2" "$CREW_ROOT/.owners/$1/notes.md" "$5" >"$(ofile "$1")"
  printf 'sub_name=%s\nparent_name=user-b8\nparent_sid=SID-RL\n' "$2" >"$CREW_ROOT/.links/$3"
  echo "notes" >"$CREW_ROOT/.owners/$1/notes.md"
}
sleepify() { sed -i 's/^state=.*/state=asleep/' "$(ofile "$1")"; tmux kill-window -t "claude:$2" 2>/dev/null; }   # owner id, window name
for s in SID-OLD SID-ODD SID-CRASH SID-CRASH2 SID-Q SID-DIES SID-GHOSTO SID-WTW SID-TOPQ SID-SL; do   # every resumable session has a transcript
  printf '{"type":"user","uuid":"U-%s","sessionId":"%s"}\n' "$s" "$s" >"$T/projects/-x/$s.jsonl"
done

# --- the argv arrives literally: --resume, -n, and the whole prompt as ONE element ---
echo same >"$T/mode"
mkowner web user-b8/web SID-OLD "$T/repo" asleep
WP=$CREW_ROOT/.owners/web/wake.pending   # C3: a pending wake recorded by a merge (crew owners --record-wake)
printf '2026-10-16T09:00:00Z\tcard/x (card T-9, abc1234)\n' >"$WP"
eq "a sibling's refused wake of an owner with a pending wake" "rc=3 crew: refused: web is asleep: ask its lead (user-b8) to wake it" "$(run sibling "$CREW" wake web -- x)"
check "a refused wake leaves the pending wake (a wake that never launched must keep nagging the lead)" test -s "$WP"
task='-x $(touch PWN) #{pane_id} "dq" '\''sq'\'' `bt`'; task=${task/PWN/$T/pwned}
out=$(run "$CREW" wake web -- "$task")
id=$D-web
eq "wake launches the owner" "rc=0 woke web in claude:web (task $id)" "$out"
eq "the window exists" "web" "$(windows)"
wait_for "$T/whoami.$id"
eq "claude got --resume SID-OLD -n user-b8/web and the prompt as one element" "--resume
SID-OLD
-n
user-b8/web
Woken by user-b8 for: $task. First run \`crew whoami\`, then \`git log --since=2026-10-16T08:00:00Z -- 'src/web/**' 'docs/'\` in $T/repo and re-read your notes at $CREW_ROOT/.owners/web/notes.md; then do it. Report up as before; when done run \`crew log $id done\` and \`crew summary $id\`, then update your notes." "$(cat "$T/args.$id")"
eq "five argv elements" "5" "$(cat "$T/argc.$id")"
check "the task text was not executed" test ! -e "$T/pwned"
eq "the owner is awake with the wake recorded" "state=awake woken_at=2026-10-17T09:00:00Z task=$id window=claude:web" "$(grep -E '^(state|woken_at|task|window)=' "$(ofile web)" | paste -sd' ')"
check "a successful wake clears the pending wake" test ! -e "$WP"
eq "the task is a running spawned task for the owner" "queued->running owner=web spawned=1 spawn_slug=web resume_sid=SID-OLD lead=user-b8 lead_sid=SID-RL sub=user-b8/web sub_sid=SID-OLD" \
  "$(tail -n 1 "$CREW_ROOT/$id/status" | cut -f2 | sed 's/^/queued->/') $(for k in owner spawned spawn_slug resume_sid lead lead_sid sub sub_sid; do printf '%s=%s ' "$k" "$(grep -E "^$k=" "$CREW_ROOT/$id/meta" | tail -n 1 | cut -d= -f2-)"; done | sed 's/ $//')"
eq "brief.md is the task text verbatim" "$task" "$(cat "$CREW_ROOT/$id/brief.md")"
eq "the resumed session found its link and its parent" $'name: user-b8/web\nparent: user-b8 (live)\nsubs: none' "$(cat "$T/whoami.$id")"
check "the reservation was consumed" test ! -e "$CREW_ROOT/.pending/$id"

# --- awake: refused, with where to send the message ---
eq "an awake owner is refused" "rc=3 crew: refused: web is awake: SendMessage user-b8/web" "$(run "$CREW" wake web -- again)"

# --- refusals while it sleeps ---
sleepify web web
eq "a sibling is refused" "rc=3 crew: refused: web is asleep: ask its lead (user-b8) to wake it" "$(run sibling "$CREW" wake web -- x)"
eq "not an owner" "rc=3 crew: refused: nope is not a feature owner" "$(run "$CREW" wake nope -- x)"
eq "an empty task" "rc=2 crew: wake needs a task text (one non-empty argument)" "$(run "$CREW" wake web -- "")"
eq "a task starting with a dash needs --" "rc=2 crew: unknown flag -x (put -- before a task that starts with a dash)" "$(run "$CREW" wake web -x)"
eq "two task arguments" "rc=2 crew: wake takes one task text, quote it" "$(run "$CREW" wake web -- a b)"
eq "a 2001 character task" "rc=2 crew: the task is 2001 characters (max 2000)" "$(run "$CREW" wake web -- "$(head -c 2001 /dev/zero | tr '\0' x)")"
check "none of those launched anything" test "$(windows)" = ""
for n in 1 2 3; do
  mkfifo "$T/sl$n"   # a "live session" that blocks without a child process (and holds no pipe of ours open)
  "$RX/claude" -c 'exec 3<>"$0"; read -t 600 -u 3; :' "$T/sl$n" >/dev/null 2>&1 & pid=$!; BGS="$BGS $pid"
  jq -nc --argjson pid "$pid" --arg n "user-b8/f$n" --arg s "SID-F$n" '{pid: $pid, name: $n, sessionId: $s}' >"$CREW_SESSIONS/f$n.json"
  printf 'sub_name=user-b8/f%s\nparent_name=user-b8\nparent_sid=SID-RL\n' "$n" >"$CREW_ROOT/.links/SID-F$n"
done
eq "three live sub-leads fill the lead's limit" "rc=3 crew: refused: user-b8 already has 3 live sub-leads (max 3). Wait for one to finish or dispatch a worker." "$(run "$CREW" wake web -- x)"
check "a refused wake leaves no task behind" test ! -e "$CREW_ROOT/$id-2"
kill $BGS; BGS=""; rm -f "$CREW_SESSIONS"/f[123].json "$CREW_ROOT"/.links/SID-F[123]

# --- the user (CREW_AS_USER=1, even from inside a claude session) may wake it; the sessionId changes on resume ---
echo new >"$T/mode"
out=$(CREW_AS_USER=1 run sibling "$CREW" wake web -- "second task")
id2=$D-web-2
eq "CREW_AS_USER=1 wakes it" "rc=0 woke web in claude:web (task $id2)" "$out"
wait_for "$T/whoami.$id2"
check "the prompt names the user" grep -qF "Woken by the user for: second task. First run \`crew whoami\`, then " "$T/args.$id2"
eq "the new session joined the lead and relinked" $'crew: joined: user-b8/web reports to user-b8 (spawned for '"$id2"$')\nname: user-b8/web\nparent: user-b8 (live)\nsubs: none' "$(head -n 4 "$T/whoami.$id2")"
check "the link moved to the new sessionId" test -f "$CREW_ROOT/.links/SID-NEW" -a ! -e "$CREW_ROOT/.links/SID-OLD"
eq "the new session continues the old one" "SID-OLD" "$(cat "$CREW_ROOT/.prev/SID-NEW")"
eq "the task's last sub_sid is the new session" "SID-NEW" "$(grep '^sub_sid=' "$CREW_ROOT/$id2/meta" | tail -n 1 | cut -d= -f2-)"
eq "the lead lists the owner once, live" "1 user-b8/web live claude:web" "$("$CREW" subs | grep -c . | tr '\n' ' ')$("$CREW" subs | awk '{print $1, $2, $3}')"
eq "the owner file still has the old sid until it is refreshed" "sid=SID-OLD" "$(grep '^sid=' "$(ofile web)")"
eq "awake check follows the sessionId" "rc=3 crew: refused: web is awake: SendMessage user-b8/web" "$(run "$CREW" wake web -- again)"
eq "owner_refresh recorded the new sid" "sid=SID-NEW" "$(grep '^sid=' "$(ofile web)")"

# --- RAM: queued (a shell with no claude session is the user), then --resume launches it ---
sleepify web web
printf '2026-10-17T08:00:00Z\tcard/y (card T-10, def5678)\n' >"$WP"
echo same >"$T/mode"
out=$(CREW_LEAD_COMM=zzz CREW_MEM_MIN_MB=999999999 run "$CREW" wake web -- "third task")
id3=$D-web-3
eq "low RAM queues the wake" "rc=0 queued: wake of web waiting for RAM (mem low:" "$(cut -c1-50 <<<"$out")"
eq "...and says how to start it" "Start it with: crew wake --resume $id3" "$(sed -n 's/.*\(Start it with: crew wake --resume [^ ]*\)$/\1/p' <<<"$out")"
eq "the task is queued for RAM" "queued	wake waiting for RAM" "$(tail -n 1 "$CREW_ROOT/$id3/status" | cut -f2,3)"
check "a wake queued for RAM has not launched, so the pending wake stays" test -s "$WP"
eq "nothing launched, the owner sleeps" "state=asleep |  " "$(grep '^state=' "$(ofile web)") | $(windows) $(ls "$T"/args.$id3 2>/dev/null)"
eq "--resume of a task that is not queued" "rc=2 crew: wake --resume: $id2 is running, not queued" "$(run "$CREW" wake --resume "$id2")"
eq "--resume checks the caller like wake" "rc=3 crew: refused: web is asleep: ask its lead (user-b8) to wake it" "$(run sibling "$CREW" wake --resume "$id3")"
out=$(CREW_LEAD_COMM=zzz run "$CREW" wake --resume "$id3")
eq "--resume launches it; the lead is not visible to this shell, so the owner reports in its own pane" "rc=0 woke web in claude:web (task $id3)
lead user-b8 is not running: web will report in its pane" "$out"
wait_for "$T/whoami.$id3"
check "--resume of the queued wake clears the pending wake" test ! -e "$WP"
eq "it resumes the sessionId the owner has now" "--resume
SID-NEW
-n
user-b8/web" "$(head -n 4 "$T/args.$id3")"
check "woken by the user" grep -qF "Woken by the user for: third task. First run \`crew whoami\`, then " "$T/args.$id3"
eq "the task is running" "running" "$(tail -n 1 "$CREW_ROOT/$id3/status" | cut -f2)"

# --- tmux format characters in the owner's name and repo path stay literal ---
sleepify web web
mkowner odd 'user-b8/o#{pane_id}x' SID-ODD "$T/re#{pane_id}\$HOME" asleep
out=$(run "$CREW" wake odd -- "hash")
eq "an owner name with tmux format characters wakes" "rc=0 woke odd in claude:o--pane-id-x (task $D-odd)" "$out"
wait_for "$T/whoami.$D-odd"
eq "the window name is plain" "o--pane-id-x" "$(windows)"
eq "the owner starts in its repo whose path holds #{pane_id} and $HOME literally" "$T/re#{pane_id}\$HOME" "$(cat "$T/cwd.$D-odd")"
eq "claude is named with the owner's name as is" "user-b8/o#{pane_id}x" "$(sed -n 4p "$T/args.$D-odd")"

closew() { tmux kill-window -t "claude:$1" 2>/dev/null; }   # window name
gone() { local i; for i in $(seq 1 40); do tmux list-windows -t claude: -F '#{window_name}' | grep -qx "$1" || return 0; sleep 0.2; done; return 1; }
pendings() { ls "$CREW_ROOT/.pending" 2>/dev/null | paste -sd' '; }
last() { tail -n 1 "$CREW_ROOT/$1/status" | cut -f2,3; }   # a task's state and note

# --- F1: an owner with no sessionId has nothing to resume ---
echo same >"$T/mode"
mkowner nosid user-b8/nosid SID-NOSID "$T/repo" asleep; sed -i 's/^sid=.*/sid=/' "$(ofile nosid)"; rm -f "$CREW_ROOT/.links/SID-NOSID"
before=$(cksum <"$(ofile nosid)")
eq "an owner with an empty sid is refused" "rc=3 crew: refused: nosid has no sessionId to resume: nothing launched" "$(run "$CREW" wake nosid -- "do it")"
closew nosid
eq "...no task, no reservation, no window, the registry is unchanged" "| | $before" "$(ls -d "$CREW_ROOT/$D-nosid"* 2>/dev/null | paste -sd' ')|$(pendings) | $(cksum <"$(ofile nosid)")"

# --- F5a: no transcript for the sessionId, nothing to resume ---
mkowner notr user-b8/notr SID-NOTR "$T/repo" asleep
eq "a session without a transcript is refused" "rc=3 crew: refused: no transcript for SID-NOTR: cannot resume notr" "$(run "$CREW" wake notr -- "do it")"
closew notr
eq "...no task, no window of its own" "|o--pane-id-x" "$(ls -d "$CREW_ROOT/$D-notr"* 2>/dev/null | paste -sd' ')|$(windows)"

# --- F2: liveness decides, not state=awake (a crash, a reboot, a launch that died) ---
mkowner crash user-b8/crash SID-CRASH "$T/repo" awake; echo 'woken_at=2026-10-16T12:00:00Z' >>"$(ofile crash)"
mkowner crash2 user-b8/crash2 SID-CRASH2 "$T/repo" awake; sed -i '/^slept_at=/d' "$(ofile crash2)"
eq "an owner marked awake whose session is gone is woken" "rc=0 woke crash in claude:crash (task $D-crash)" "$(run "$CREW" wake crash -- "after the crash")"
wait_for "$T/whoami.$D-crash"
check "it asks for the commits since the wake it lost" grep -qF "git log --since=2026-10-16T12:00:00Z -- 'src/web/**' 'docs/'" "$T/args.$D-crash"
eq "...and it is live again" "rc=3 crew: refused: crash is awake: SendMessage user-b8/crash" "$(run "$CREW" wake crash -- again)"
closew crash
eq "with no woken_at the history starts at created" "rc=0 woke crash2 in claude:crash2 (task $D-crash2)" "$(run "$CREW" wake crash2 -- "no stamp")"
wait_for "$T/whoami.$D-crash2"
check "--since falls back to created" grep -qF "git log --since=2026-10-15T09:00:00Z -- " "$T/args.$D-crash2"
closew crash2

# --- F9: one queued wake per owner ---
mkowner q user-b8/q SID-Q "$T/repo" asleep
out=$(CREW_LEAD_COMM=zzz CREW_MEM_MIN_MB=999999999 run "$CREW" wake q -- "first")
eq "low RAM queues the first wake" "rc=0 queued: wake of q waiting for RAM (mem low:" "$(cut -c1-48 <<<"$out")"
eq "a second wake is refused" "rc=3 crew: refused: a wake of q is already queued: crew wake --resume $D-q" "$(CREW_LEAD_COMM=zzz CREW_MEM_MIN_MB=999999999 run "$CREW" wake q -- "second")"
check "...and made no second task" test ! -e "$CREW_ROOT/$D-q-2"
eq "the queued wake itself still launches" "rc=0 woke q in claude:q (task $D-q)" "$(run "$CREW" wake --resume "$D-q")"
wait_for "$T/whoami.$D-q"
closew q

# --- F3: the user wakes an owner whose lead is gone: it runs unlinked and says so ---
mkowner ghost user-b8/ghost SID-GHOSTO "$T/repo" asleep; sed -i 's/^lead=.*/lead=ghostlead/; s/^lead_sid=.*/lead_sid=SID-GHOST/' "$(ofile ghost)"; rm -f "$CREW_ROOT/.links/SID-GHOSTO"
out=$(CREW_AS_USER=1 run "$CREW" wake ghost -- "lead is away")
eq "the user wakes it, and the output names the missing lead" "rc=0 woke ghost in claude:ghost (task $D-ghost)
lead ghostlead is not running: ghost will report in its pane" "$out"
wait_for "$T/whoami.$D-ghost"
eq "its first crew call is not a refused join" $'crew: started as a top-level lead (task '"$D-ghost"$')\nname: user-b8/ghost\nparent: none\nsubs: none' "$(cat "$T/whoami.$D-ghost")"
closew ghost

# --- F5b: a launch that started and died must not block the retry ---
echo die >"$T/mode"
mkowner dies user-b8/dies SID-DIES "$T/repo" asleep
eq "a claude that starts is a wake" "rc=0 woke dies in claude:dies (task $D-dies)" "$(run "$CREW" wake dies -- "first try")"
eq "retrying while its window is still open is refused" "rc=3 crew: refused: dies is starting: its window claude:dies is still open" "$(run "$CREW" wake dies -- "too soon")"
gone dies
eq "the leftover: owner awake, task running, reservation kept" "state=awake running .pending/$D-dies" "$(grep '^state=' "$(ofile dies)") $(last $D-dies | cut -f1) $(ls "$CREW_ROOT/.pending/$D-dies" >/dev/null 2>&1 && echo ".pending/$D-dies")"
echo same >"$T/mode"
eq "once it is dead the owner is wakeable again" "rc=0 woke dies in claude:dies (task $D-dies-2)" "$(run "$CREW" wake dies -- "second try")"
wait_for "$T/whoami.$D-dies-2"
eq "the dead launch's task ends failed" "failed	woken session died before it joined" "$(last $D-dies)"
check "...and its reservation is gone" test ! -e "$CREW_ROOT/.pending/$D-dies"
closew dies

# --- W1: an owner registered from a worktree is woken in that worktree (cwd=), repo= stays the main checkout ---
echo same >"$T/mode"
mkdir -p "$T/wtdir"
mkowner wtw user-b8/wtw SID-WTW "$T/repo" asleep; echo "cwd=$T/wtdir" >>"$(ofile wtw)"
eq "an owner with a cwd= wakes" "rc=0 woke wtw in claude:wtw (task $D-wtw)" "$(run "$CREW" wake wtw -- "in the worktree")"
wait_for "$T/whoami.$D-wtw"
eq "the task's repo is the owner's cwd" "repo=$T/wtdir" "$(grep '^repo=' "$CREW_ROOT/$D-wtw/meta" | tail -n 1)"
eq "claude started in the worktree" "$T/wtdir" "$(cat "$T/cwd.$D-wtw")"
check "the prompt still asks for the git log in repo=" grep -qF "in $T/repo and re-read your notes" "$T/args.$D-wtw"
eq "repo= is unchanged" "repo=$T/repo" "$(grep '^repo=' "$(ofile wtw)")"
sleepify wtw wtw
rm -rf "$T/wtdir"
eq "a cwd= that is gone falls back to repo=" "rc=0 woke wtw in claude:wtw (task $D-wtw-2)" "$(run "$CREW" wake wtw -- "worktree removed")"
wait_for "$T/whoami.$D-wtw-2"
eq "...the task's repo is repo=" "repo=$T/repo" "$(grep '^repo=' "$CREW_ROOT/$D-wtw-2/meta" | tail -n 1)"
eq "...and claude started there" "$T/repo" "$(cat "$T/cwd.$D-wtw-2")"
closew wtw

# --- W2: a wake queued while the lead was away is not a top-level wake once the lead is back ---
mkowner topq user-b8/topq SID-TOPQ "$T/repo" asleep
out=$(CREW_AS_USER=1 CREW_LEAD_COMM=zzz CREW_MEM_MIN_MB=999999999 run "$CREW" wake topq -- "while the lead is away")
eq "queued with no live lead" "rc=0 queued: wake of topq waiting for RAM (mem low:" "$(cut -c1-51 <<<"$out")"
eq "...it recorded top=1" "top=1" "$(grep '^top=' "$CREW_ROOT/$D-topq/meta" | tail -n 1)"
out=$(CREW_AS_USER=1 run "$CREW" wake --resume "$D-topq")
eq "--resume with the lead back prints no lead-away line" "rc=0 woke topq in claude:topq (task $D-topq)" "$out"
eq "...and cleared top" "top=" "$(grep '^top=' "$CREW_ROOT/$D-topq/meta" | tail -n 1)"
wait_for "$T/whoami.$D-topq"
eq "...so the owner reports to its lead, not as a top-level lead" $'name: user-b8/topq\nparent: user-b8 (live)' "$(head -n 2 "$T/whoami.$D-topq")"
closew topq

# --- W3: a wake that lands while the owner is falling asleep is refused ---
mkowner sl user-b8/sl SID-SL "$T/repo" asleep
mkdir -p "$CREW_ROOT/.locks"
mkfifo "$T/hold"
( exec 7>"$CREW_ROOT/.locks/sleep-sl"; flock 7; : >"$T/held"; exec 3<>"$T/hold"; read -t 60 -u 3 ) & holder=$!; BGS="$BGS $holder"
for i in $(seq 1 50); do [ -e "$T/held" ] && break; sleep 0.1; done
eq "wake while the sleep lock is held" "rc=3 crew: refused: sl is falling asleep: try again in a moment" "$(run "$CREW" wake sl -- "too early")"
check "...no task was made" test ! -e "$CREW_ROOT/$D-sl"
eq "...and the owner is still asleep" "state=asleep" "$(grep '^state=' "$(ofile sl)")"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
eq "once the lock is free the wake goes through" "rc=0 woke sl in claude:sl (task $D-sl)" "$(run "$CREW" wake sl -- "now")"
wait_for "$T/whoami.$D-sl"
check "...and it does not keep the sleep lock" flock -n "$CREW_ROOT/.locks/sleep-sl" true
closew sl

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
