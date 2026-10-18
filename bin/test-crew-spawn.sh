#!/usr/bin/env bash
# Test: `crew spawn` launches a sub-lead in a tmux window and joins it to the spawning lead. tmux and claude are
# fakes on PATH that record their argv (one argument per line); the fake tmux also runs the command it was given,
# so the fake claude proves the argv is launchable. Fake sessions live in a temp CREW_SESSIONS; the lead is this
# test shell (pid $$, comm = CREW_LEAD_COMM); other sessions are `bash -c` processes or background sleepers.
#   bash test-crew-spawn.sh
set -uo pipefail

CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
BGS=""
trap 'kill $BGS 2>/dev/null; rm -rf "$T"' EXIT
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-16T10:00:00Z CREW CREW_LEAD_COMM CREW_SPAWN_TRUST_WAIT_S=0 FAKE=$T/fake FAKE_PANE_PID=$$
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
unset CLAUDE_CODE_AUTO_COMPACT_WINDOW
CREW_LEAD_COMM=$(cat /proc/$$/comm)
mkdir -p "$CREW_SESSIONS" "$CREW_PROJECTS" "$FAKE/bin" "$T/my repo"
fails=0
D=$(date +%m%d)

cat >"$FAKE/bin/tmux" <<'EOF'
#!/usr/bin/env bash
# fake tmux. State: $FAKE/windows, one "id name" line per window. The pane process is $FAKE_PANE_PID (the test shell).
# new-window records its argv ("--END--" after each call), runs the command it was given to completion, and with -P
# prints "<id> <pane pid>". $FAKE/dies: the window is gone right after it was made.
w() { cat "$FAKE/windows" 2>/dev/null || true; }
drop() { w | grep -v "^$1 " >"$FAKE/windows.new" || true; mv "$FAKE/windows.new" "$FAKE/windows"; }
case "$1" in
  list-windows)
    [ ! -e "$FAKE/no-session" ] || { echo "can't find session: claude" >&2; exit 1; }
    case "$*" in *window_id*) w | cut -d' ' -f1 ;; *) w | cut -d' ' -f2- ;; esac; exit 0 ;;
  list-panes)
    w | grep -q "^$3 " || { echo "can't find window: $3" >&2; exit 1; }
    echo "0 claude"; exit 0 ;;
  kill-window) drop "$3"; exit 0 ;;
  new-window)
    { printf '%s\n' "$@"; echo "--END--"; } >>"$FAKE/tmux.log"
    [ ! -e "$FAKE/launch-fails" ] || { echo "no space for new window" >&2; exit 1; }
    shift; name="" envs=()
    while [ $# -gt 0 ]; do
      case "$1" in -n) name=$2; shift 2 ;; -e) envs+=("$2"); shift 2 ;; -t | -F) shift 2 ;; -d | -P) shift ;; --) shift; break ;; *) shift ;; esac
    done
    seq=$(( $(cat "$FAKE/seq" 2>/dev/null || echo 0) + 1 )); echo "$seq" >"$FAKE/seq"
    printf '@%s %s\n' "$seq" "$name" >>"$FAKE/windows"
    env "${envs[@]}" "$@"
    [ ! -e "$FAKE/dies" ] || drop "@$seq"
    echo "@$seq $FAKE_PANE_PID" ;;
  *) exit 0 ;;
esac
EOF
cat >"$FAKE/bin/claude" <<'EOF'
#!/usr/bin/env bash
{ printf 'cwd=%s\ntask=%s\n' "$PWD" "${CREW_SPAWN_TASK:-}"; printf '%s\n' "$@"; echo "--END--"; } >>"$FAKE/claude.log"
EOF
chmod +x "$FAKE/bin/tmux" "$FAKE/bin/claude"
export PATH="$FAKE/bin:$PATH"

check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { # description, expected, actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi
}
lead_json() { jq -nc --argjson pid "${3:-$$}" --arg n "$1" --arg s "$2" '{pid: $pid, name: $n, sessionId: $s, cwd: "/x"}' >"$CREW_SESSIONS/$2.json"; }
as() { # as NAME SID cmd...: run in a fresh process of session NAME/SID
  local name=$1 sid=$2; shift 2
  bash -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"' _ "$name" "$sid" "$@" 2>&1
}
live_sub() { # NAME SID: a long-running process that is that session
  bash -c 'printf "{\"pid\":%s,\"name\":\"%s\",\"sessionId\":\"%s\"}\n" "$$" "$1" "$2" >"$CREW_SESSIONS/bg-$2.json"; while :; do sleep 1; done' _ "$1" "$2" &
  BGS="$BGS $!"; sleep 0.3
}
meta_has() { grep -qxF "$2" "$CREW_ROOT/$1/meta"; }
tok() { grep -m1 "^token=" "$CREW_ROOT/.pending/$1" 2>/dev/null | cut -d= -f2; }   # the launched session carries this in its environment
idof() { sed -n 's/^id=//p' <<<"$1"; }
last_tmux() { tmux_block | sed -E 's/^CREW_SPAWN_TOKEN=[0-9a-f]{32}$/CREW_SPAWN_TOKEN=TOKEN/'; }
tmux_block() { awk '/^--END--$/ {n = ""; next} {n = n $0 "\n"; last = n} END {printf "%s", last}' "$FAKE/tmux.log" 2>/dev/null; }
reset_fake() { rm -f "$FAKE/tmux.log" "$FAKE/claude.log" "$FAKE/windows" "$FAKE/seq" "$FAKE/no-session" "$FAKE/launch-fails" "$FAKE/dies"; }
prompt_for() { # lead id -> the initial prompt a sub-lead gets
  printf 'You are a sub-lead for %s on crew task %s. Run `crew whoami` first (it completes your join). Read the brief at %s/%s/brief.md. Use /orchestrate (or /crew dispatch for small parts) to do it; report up to %s at milestones only per the crew skill'"'"'s chain-of-command rules; when done, run `crew log %s done` and `crew summary %s`, then stop. Never ask the user in your own pane: every question is `crew ask %s "<question>"` (it reaches your lead and HQ), and the answer arrives typed into your pane as the user'"'"'s words. Do not close your window.' "$1" "$2" "$CREW_ROOT" "$2" "$1" "$2" "$2" "$2"
}

lead_json lead-a SID-A

# --- refusals before anything is made ---
out=$(CREW_LEAD_COMM=nothing-matches "$CREW" spawn nope "brief" 2>&1; echo "rc=$?")
eq "spawn outside a claude session is refused" $'crew: not inside a claude session\nrc=2' "$out"
eq "spawn without a brief is refused" "crew: spawn needs SLUG and a brief (text, or --brief FILE)" "$("$CREW" spawn big-job 2>&1)"
eq "spawn rejects a bad slug" "crew: slug: lowercase letters, digits, dashes" "$("$CREW" spawn 'Big Job' "brief" 2>&1)"
eq "spawn rejects a missing brief file" "crew: brief file not found: $T/nope.md" "$("$CREW" spawn big-job --brief "$T/nope.md" 2>&1)"
eq "spawn rejects an unknown flag" "crew: unknown flag --force" "$("$CREW" spawn big-job --force "brief" 2>&1)"
check "refusals made no task" test ! -d "$CREW_ROOT/$D-big-job"
check "refusals launched nothing" test ! -e "$FAKE/tmux.log"

# --- a spawn: task, brief, pending join, exact argv ---
reset_fake
out=$("$CREW" spawn big-job --repo "$T/my repo" --model haiku "Build the thing. Then \"verify\" it." 2>&1); rc=$?
id=$(idof "$out")
eq "spawn exits 0" "0" "$rc"
eq "spawn prints the task id, window target and child name" $'id='"$D-big-job"$'\nwindow=claude:big-job\nchild=lead-a/big-job' "$out"
eq "the brief is written verbatim to the task dir" 'Build the thing. Then "verify" it.' "$(cat "$CREW_ROOT/$id/brief.md")"
check "meta: spawned" meta_has "$id" "spawned=1"
check "meta: window" meta_has "$id" "window=claude:big-job"
check "meta: lead is the spawner" meta_has "$id" "lead=lead-a"
check "meta: lead_sid is the spawner's" meta_has "$id" "lead_sid=SID-A"
check "meta: repo" meta_has "$id" "repo=$T/my repo"
eq "state is running" "running" "$(tail -n 1 "$CREW_ROOT/$id/status" | cut -f2)"
eq "the exact tmux argv (an array: nothing is shell-interpolated)" \
"new-window
-d
-P
-F
#{window_id} #{pane_pid}
-t
claude:
-n
big-job
-e
CREW_SPAWN_TASK=$id
-e
CREW_SPAWN_TOKEN=TOKEN
-e
CLAUDE_CODE_AUTO_COMPACT_WINDOW=213000
--
env
-C
$T/my repo
claude
-n
lead-a/big-job
--model
haiku
--effort
high
$(prompt_for lead-a "$id")" "$(last_tmux)"
eq "the fake claude was started in the repo with the task in its environment" "cwd=$T/my repo
task=$id" "$(sed -n 1,2p "$FAKE/claude.log")"
check "the pending join record exists until the child consumes it" test -f "$CREW_ROOT/.pending/$id"
eq "the reservation names the spawning lead, window and pane" $'parent_name=lead-a\nparent_sid=SID-A\nchild_name=lead-a/big-job\nwindow_id=@1\npane_pid='"$$" "$(grep -v '^token=' "$CREW_ROOT/.pending/$id")"
eq "the reservation holds a 32-hex nonce" "32" "$(tok "$id" | wc -c | awk '{print $1 - 1}')"

# --- the child joins on its first crew call ---
live_sub lead-a/big-job SID-C1
out=$(CREW_SPAWN_TASK=$id CREW_SPAWN_TOKEN=$(tok $id) as lead-a/big-job SID-C1 "$CREW" whoami)
eq "whoami completes the join and shows the parent" $'crew: joined: lead-a/big-job reports to lead-a (spawned for '"$id"$')\nname: lead-a/big-job\nparent: lead-a (live)\nsubs: none' "$out"
check "the pending record is consumed" test ! -e "$CREW_ROOT/.pending/$id"
eq "it became a normal link filed under the child's sessionId" $'sub_name=lead-a/big-job\nparent_name=lead-a\nparent_sid=SID-A' "$(cat "$CREW_ROOT/.links/SID-C1")"
check "meta: sub is the child session" meta_has "$id" "sub=lead-a/big-job"
check "meta: sub_sid is the child session" meta_has "$id" "sub_sid=SID-C1"
eq "a second call is quiet" $'name: lead-a/big-job\nparent: lead-a (live)\nsubs: none' "$(CREW_SPAWN_TASK=$id CREW_SPAWN_TOKEN=$(tok $id) as lead-a/big-job SID-C1 "$CREW" whoami)"
eq "subs shows the window target of a spawned sub-lead" "lead-a/big-job           live  claude:big-job" "$("$CREW" subs)"
show=$("$CREW" show "$id")
check "show has spawned=1" grep -qxF "  spawned=1" <<<"$show"
check "show has the window" grep -qxF "  window=claude:big-job" <<<"$show"
check "show has the child session" grep -qxF "sub: lead-a/big-job" <<<"$show"
ls_row=$("$CREW" ls --leads | grep -F "$id")
check "ls shows the window target on the task row" grep -qF "[claude:big-job]" <<<"$ls_row"
"$CREW" ls >/dev/null; eq "crew ls exits 0" "0" "$?"

# --- a pending record is consumed only by the session carrying its task id ---
reset_fake
id2=$(idof "$("$CREW" spawn second --repo "$T/my repo" "second brief" 2>&1)")
live_sub stranger SID-X
eq "a session without CREW_SPAWN_TASK does not join" $'name: stranger\nparent: none\nsubs: none' "$(as stranger SID-X "$CREW" whoami)"
check "the pending record is still there" test -f "$CREW_ROOT/.pending/$id2"
check "no link for the stranger" test ! -e "$CREW_ROOT/.links/SID-X"
eq "a task id with path parts is ignored" $'name: stranger\nparent: none\nsubs: none' "$(CREW_SPAWN_TASK=../../etc as stranger SID-X "$CREW" whoami)"

# --- the cycle check runs again at consume ---
setparent() { sed -i -E "s/^parent_name=.*/parent_name=$2/; s/^parent_sid=.*/parent_sid=$3/" "$CREW_ROOT/.pending/$1"; }
setparent "$id2" lead-a SID-A
printf 'sub_name=lead-a\nparent_name=cyc\nparent_sid=SID-CY\n' >"$CREW_ROOT/.links/SID-A"
live_sub cyc SID-CY
out=$(CREW_SPAWN_TASK=$id2 CREW_SPAWN_TOKEN=$(tok $id2) as cyc SID-CY "$CREW" whoami)
eq "a pending join that would close a loop is refused" $'crew: spawn join refused: cycle: \'lead-a\' already reports to you\nname: cyc\nparent: none\nsubs: lead-a (live)' "$out"
check "the refused pending record is removed" test ! -e "$CREW_ROOT/.pending/$id2"
check "no link was made for the refused child" test ! -e "$CREW_ROOT/.links/SID-CY"
rm -f "$CREW_ROOT/.links/SID-A"
id3=$(idof "$("$CREW" spawn third --repo "$T/my repo" "third brief" 2>&1)")
setparent "$id3" gone SID-GONE
live_sub orphan SID-OR
out=$(CREW_SPAWN_TASK=$id3 CREW_SPAWN_TOKEN=$(tok $id3) as orphan SID-OR "$CREW" whoami)
eq "a pending join whose lead is gone is refused" $'crew: spawn join refused: the spawning lead \'gone\' is not running\nname: orphan\nparent: none\nsubs: none' "$out"

# --- limits: depth 2 below the top lead ---
reset_fake
lead_json lead-d SID-D
id=$(idof "$(as lead-d SID-D "$CREW" spawn lvl1 --repo "$T/my repo" "b")")
live_sub lead-d/lvl1 SID-L1
CREW_SPAWN_TASK=$id CREW_SPAWN_TOKEN=$(tok $id) as lead-d/lvl1 SID-L1 "$CREW" whoami >/dev/null
id=$(idof "$(as lead-d/lvl1 SID-L1 "$CREW" spawn lvl2 --repo "$T/my repo" "b")")
check "a sub-lead can spawn (one level down is allowed)" test -n "$id"
live_sub lead-d/lvl1/lvl2 SID-L2
CREW_SPAWN_TASK=$id CREW_SPAWN_TOKEN=$(tok $id) as lead-d/lvl1/lvl2 SID-L2 "$CREW" whoami >/dev/null
reset_fake
out=$(as lead-d/lvl1/lvl2 SID-L2 "$CREW" spawn lvl3 --repo "$T/my repo" "b"; echo "rc=$?")
eq "a third level is refused with the reason" "crew: spawn refused: depth limit: you are 2 levels below the top lead and sub-leads nest at most 2 levels. Dispatch a worker instead.
rc=2" "$out"
check "the refused spawn launched nothing" test ! -e "$FAKE/tmux.log"
check "the refused spawn made no task" test ! -d "$CREW_ROOT/$D-lvl3"

# --- limits: at most 3 live sub-leads per lead (joined ones and launched-but-not-yet-joined ones) ---
lead_json lead-b SID-B
for n in 1 2 3; do live_sub "s$n" "SID-S$n"; as "s$n" "SID-S$n" "$CREW" join lead-b >/dev/null; done
out=$(as lead-b SID-B "$CREW" spawn fourth --repo "$T/my repo" "b"; echo "rc=$?")
eq "a fourth live sub-lead is refused" "crew: spawn refused: lead-b already has 3 live sub-leads (max 3). Wait for one to finish or dispatch a worker.
rc=2" "$out"
lead_json lead-c SID-C
for n in 1 2 3; do as lead-c SID-C "$CREW" spawn "c$n" --repo "$T/my repo" "b" >/dev/null; done
out=$(as lead-c SID-C "$CREW" spawn c4 --repo "$T/my repo" "b"; echo "rc=$?")
eq "launched sub-leads that have not joined yet count" "crew: spawn refused: lead-c already has 3 live sub-leads (max 3). Wait for one to finish or dispatch a worker.
rc=2" "$out"

# --- RAM low: queued, not launched; next names the resume command ---
reset_fake
lead_json lead-r SID-R
out=$(CREW_MEM_MIN_MB=999999999 as lead-r SID-R "$CREW" spawn heavy --repo "$T/my repo" --model sonnet "heavy brief")
idr=$(idof "$out")
eq "RAM low: queued with a clear message" "id=$D-heavy
queued: spawn waiting for RAM, not launched (mem low: N MB available < 999999999 MB needed, M MB swap free). Start it with: crew spawn --resume $D-heavy" \
  "$(sed -E 's/[0-9]+ MB available/N MB available/; s/, [0-9]+ MB swap/, M MB swap/' <<<"$out")"
check "RAM low: nothing launched" test ! -e "$FAKE/tmux.log"
eq "RAM low: state queued, note says why" "queued	spawn waiting for RAM" "$(tail -n 1 "$CREW_ROOT/$idr/status" | cut -f2-3)"
check "RAM low: the brief is kept" test -s "$CREW_ROOT/$idr/brief.md"
eq "next while RAM is short" "waiting for RAM: mem low:" "$(CREW_MEM_MIN_MB=999999999 "$CREW" next | grep '^waiting for RAM' | cut -d' ' -f1-5)"
eq "next when RAM is free says how to start it" "ok to start: $idr (crew spawn --resume $idr)" "$(CREW_MEM_MIN_MB=1 "$CREW" next | grep 'ok to start')"
out=$(CREW_MEM_MIN_MB=999999999 as lead-r SID-R "$CREW" spawn --resume "$idr"; echo "rc=$?")
check "--resume while RAM is still short stays queued (exit 1)" grep -q "rc=1" <<<"$out"
check "--resume while RAM is short launched nothing" test ! -e "$FAKE/tmux.log"
out=$(CREW_MEM_MIN_MB=1 as lead-a SID-A "$CREW" spawn --resume "$idr")
eq "--resume from another session is refused" "crew: spawn --resume: $idr was spawned by lead-r, not lead-a" "$out"
out=$(CREW_MEM_MIN_MB=1 as lead-r SID-R "$CREW" spawn --resume "$idr")
eq "--resume launches it" "id=$idr
window=claude:heavy
child=lead-r/heavy" "$out"
eq "--resume used the stored model and repo" "new-window
-d
-P
-F
#{window_id} #{pane_pid}
-t
claude:
-n
heavy
-e
CREW_SPAWN_TASK=$idr
-e
CREW_SPAWN_TOKEN=TOKEN
-e
CLAUDE_CODE_AUTO_COMPACT_WINDOW=213000
--
env
-C
$T/my repo
claude
-n
lead-r/heavy
--model
sonnet
--effort
high
$(prompt_for lead-r "$idr")" "$(last_tmux)"
eq "--resume: running" "running" "$(tail -n 1 "$CREW_ROOT/$idr/status" | cut -f2)"
check "--resume wrote the pending record" test -f "$CREW_ROOT/.pending/$idr"
eq "--resume on a task that is not queued is refused" "crew: spawn --resume: $idr is running, not queued" "$(as lead-r SID-R "$CREW" spawn --resume "$idr")"

# --- model and effort: sonnet/high unless the caller says otherwise ---
launch_opts() { last_tmux | sed -n '/^claude$/,$p' | sed -n '4,7p' | paste -sd' '; }   # what follows `claude -n NAME`, before the prompt
reset_fake
lead_json lead-e SID-E
out=$(as lead-e SID-E "$CREW" spawn me-default --repo "$T/my repo" "b"); ide=$(idof "$out")
eq "no --model/--effort: the sub-lead starts on sonnet at effort high" "--model sonnet --effort high" "$(launch_opts)"
check "meta records the default model" meta_has "$ide" "spawn_model=sonnet"
check "meta records the default effort" meta_has "$ide" "spawn_effort=high"
eq "the launched line names model and effort" "running	sub-lead launched in claude:me-default (model sonnet, effort high)" "$(tail -n 1 "$CREW_ROOT/$ide/status" | cut -f2-3)"
out=$(as lead-e SID-E "$CREW" spawn me-opus --repo "$T/my repo" --model opus "b"); ido=$(idof "$out")
eq "--model opus alone keeps effort high" "--model opus --effort high" "$(launch_opts)"
check "meta records opus" meta_has "$ido" "spawn_model=opus"
out=$(as lead-e SID-E "$CREW" spawn me-med --repo "$T/my repo" --effort medium "b"); idm=$(idof "$out")
eq "--effort medium overrides and the model stays sonnet" "--model sonnet --effort medium" "$(launch_opts)"
check "meta records the overriding effort" meta_has "$idm" "spawn_effort=medium"
reset_fake
eq "a bad --effort is refused" "crew: bad --effort 'extreme' (low, medium, high, xhigh or max)" "$(as lead-e SID-E "$CREW" spawn me-bad --repo "$T/my repo" --effort extreme "b")"
check "the refused effort made no task and launched nothing" test ! -d "$CREW_ROOT/$D-me-bad" -a ! -e "$FAKE/tmux.log"

# --- names with spaces and quotes, hostile brief text ---
reset_fake
lead_json "it's a \"big\" lead" SID-Q
cat >"$T/evil.md" <<EOF
\$(touch $T/PWNED) \`touch $T/PWNED2\` 'x' "y" ; touch $T/PWNED3
second line
EOF
mkdir -p "$T/it's a \"dir\""
out=$(as "it's a \"big\" lead" SID-Q "$CREW" spawn quoted --repo "$T/it's a \"dir\"" --brief "$T/evil.md")
idq=$(idof "$out")
check "hostile brief text ran nothing" test ! -e "$T/PWNED" -a ! -e "$T/PWNED2" -a ! -e "$T/PWNED3"
eq "the brief file is copied byte for byte" "$(cat "$T/evil.md")" "$(cat "$CREW_ROOT/$idq/brief.md")"
eq "the argv carries the odd lead name, repo and prompt as single arguments" "new-window
-d
-P
-F
#{window_id} #{pane_pid}
-t
claude:
-n
quoted
-e
CREW_SPAWN_TASK=$idq
-e
CREW_SPAWN_TOKEN=TOKEN
-e
CLAUDE_CODE_AUTO_COMPACT_WINDOW=213000
--
env
-C
$T/it's a \"dir\"
claude
-n
it's a \"big\" lead/quoted
--model
sonnet
--effort
high
$(prompt_for "it's a \"big\" lead" "$idq")" "$(last_tmux)"

# --- the user's own auto-compact window wins; SOFT moves the default ---
reset_fake
lead_json lead-c SID-C
CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000 as lead-c SID-C "$CREW" spawn mine --repo "$T/my repo" "b" >/dev/null
eq "a CLAUDE_CODE_AUTO_COMPACT_WINDOW set by the caller is forwarded with -e (a running tmux server would not inherit it)" $'-e\nCLAUDE_CODE_AUTO_COMPACT_WINDOW=500000' "$(last_tmux | grep -B1 '^CLAUDE_CODE_AUTO_COMPACT_WINDOW=')"
reset_fake
CREW_COMPACT_SOFT=250000 as lead-c SID-C "$CREW" spawn soft --repo "$T/my repo" "b" >/dev/null
eq "the default window is SOFT plus the 13000 token buffer" "CLAUDE_CODE_AUTO_COMPACT_WINDOW=263000" "$(last_tmux | grep '^CLAUDE_CODE_AUTO_COMPACT_WINDOW=')"

# --- window names do not collide ---
reset_fake
lead_json lead-w SID-W
as lead-w SID-W "$CREW" spawn dup --repo "$T/my repo" "one" >/dev/null
out=$(as lead-w SID-W "$CREW" spawn dup --repo "$T/my repo" "two")
eq "a second window for the same slug gets a suffix" "id=$D-dup-2
window=claude:dup-2
child=lead-w/dup-2" "$out"

# --- launch failures ---
reset_fake
touch "$FAKE/launch-fails"
out=$(as lead-w SID-W "$CREW" spawn broken --repo "$T/my repo" "b"; echo "rc=$?")
eq "tmux failing is an error" "no space for new window
crew: spawn: tmux could not open the window (task $D-broken marked failed)
rc=2" "$out"
eq "the task is marked failed" "failed" "$(tail -n 1 "$CREW_ROOT/$D-broken/status" | cut -f2)"
check "no pending record left behind" test ! -e "$CREW_ROOT/.pending/$D-broken"
reset_fake
touch "$FAKE/no-session"
out=$(as lead-w SID-W "$CREW" spawn nosess --repo "$T/my repo" "b"; echo "rc=$?")
eq "no tmux session: refused before any task is made" "can't find session: claude
crew: spawn: no tmux session 'claude' (CREW_SPAWN_TMUX names another)
rc=2" "$out"
check "no task for the missing session" test ! -d "$CREW_ROOT/$D-nosess"

# --- review findings ---
# provenance: only the session that carries the token and runs under the reservation's pane can consume it
reset_fake
lead_json lead-p SID-P
idp=$(idof "$(as lead-p SID-P "$CREW" spawn prov --repo "$T/my repo" "b")")
live_sub kid SID-K
out=$(CREW_SPAWN_TASK=$idp CREW_SPAWN_TOKEN=0000 as kid SID-K "$CREW" whoami)
eq "a wrong token is refused" $'crew: spawn join refused: this is not the session that task '"$idp"$' launched\nname: kid\nparent: none\nsubs: none' "$out"
out=$(CREW_SPAWN_TASK=$idp as kid SID-K "$CREW" whoami)
eq "no token is refused" $'crew: spawn join refused: this is not the session that task '"$idp"$' launched\nname: kid\nparent: none\nsubs: none' "$out"
check "refusals leave the reservation for the real session" test -f "$CREW_ROOT/.pending/$idp"
good=$(tok "$idp")
sed -i 's/^pane_pid=.*/pane_pid=1/' "$CREW_ROOT/.pending/$idp"
out=$(CREW_SPAWN_TASK=$idp CREW_SPAWN_TOKEN=$good as kid SID-K "$CREW" whoami)
eq "the right token outside the reservation's pane is refused" $'crew: spawn join refused: this is not the session that task '"$idp"$' launched\nname: kid\nparent: none\nsubs: none' "$out"
check "still intact" test -f "$CREW_ROOT/.pending/$idp"
sed -i "s/^pane_pid=.*/pane_pid=$$/" "$CREW_ROOT/.pending/$idp"
out=$(CREW_SPAWN_TASK=$idp CREW_SPAWN_TOKEN=$good as kid SID-K "$CREW" whoami)
eq "the right token under the right pane joins" $'crew: joined: kid reports to lead-p (spawned for '"$idp"$')\nname: kid\nparent: lead-p (live)\nsubs: none' "$out"

# a reservation counts while its window and pane live, however old, and is dropped when they are gone
reset_fake
lead_json lead-e SID-E
for n in 1 2 3; do as lead-e SID-E "$CREW" spawn "e$n" --repo "$T/my repo" "b" >/dev/null; done
touch -d '3 hours ago' "$CREW_ROOT"/.pending/*-e[123]
out=$(as lead-e SID-E "$CREW" spawn e4 --repo "$T/my repo" "b"; echo "rc=$?")
eq "an old reservation whose window is open still counts" "crew: spawn refused: lead-e already has 3 live sub-leads (max 3). Wait for one to finish or dispatch a worker.
rc=2" "$out"
grep -v ' e1$' "$FAKE/windows" >"$FAKE/w.new"; mv "$FAKE/w.new" "$FAKE/windows"   # the user closed e1's window
sed -i 's/^pane_pid=.*/pane_pid=2000000000/' "$CREW_ROOT/.pending/$D-e2"            # e2's process is gone
out=$(as lead-e SID-E "$CREW" spawn e4 --repo "$T/my repo" "b")
eq "reservations of a closed window and of a dead process no longer count" "id=$D-e4
window=claude:e4
child=lead-e/e4" "$out"
check "the dead reservations were dropped" test ! -e "$CREW_ROOT/.pending/$D-e1" -a ! -e "$CREW_ROOT/.pending/$D-e2"

# --resume replaces only a dead window
reset_fake
idz=$(idof "$(CREW_MEM_MIN_MB=999999999 as lead-r SID-R "$CREW" spawn rs --repo "$T/my repo" "b")")
CREW_MEM_MIN_MB=1 as lead-r SID-R "$CREW" spawn --resume "$idz" >/dev/null
"$CREW" log "$idz" queued "again"
out=$(CREW_MEM_MIN_MB=1 as lead-r SID-R "$CREW" spawn --resume "$idz")
eq "--resume refuses while the task's window is alive" "crew: spawn --resume: $idz already has a live window (claude:rs); close it first" "$out"
grep -v ' rs$' "$FAKE/windows" >"$FAKE/w.new"; mv "$FAKE/w.new" "$FAKE/windows"
out=$(CREW_MEM_MIN_MB=1 as lead-r SID-R "$CREW" spawn --resume "$idz")
eq "--resume relaunches once the old window is gone" "id=$idz
window=claude:rs
child=lead-r/rs" "$out"

# a spawned session's own first command may be `crew spawn`: it joins first, so its depth counts
reset_fake
lead_json lead-g SID-G
live_sub g1 SID-G1
idg=$(idof "$(as lead-g SID-G "$CREW" spawn g1 --repo "$T/my repo" "b")")
CREW_SPAWN_TASK=$idg CREW_SPAWN_TOKEN=$(tok $idg) as g1 SID-G1 "$CREW" whoami >/dev/null
live_sub g2 SID-G2
idg=$(idof "$(as g1 SID-G1 "$CREW" spawn g2 --repo "$T/my repo" "b")")
reset_fake
out=$(CREW_SPAWN_TASK=$idg CREW_SPAWN_TOKEN=$(tok $idg) as g2 SID-G2 "$CREW" spawn g3 --repo "$T/my repo" "b"; echo "rc=$?")
eq "spawn as a not-yet-joined sub-lead's first command still hits the depth limit" "crew: joined: g2 reports to g1 (spawned for $idg)
crew: spawn refused: depth limit: you are 2 levels below the top lead and sub-leads nest at most 2 levels. Dispatch a worker instead.
rc=2" "$out"
check "nothing was launched" test ! -e "$FAKE/tmux.log"

# consuming waits for the spawn lock (one lock for limits, launch and consume)
reset_fake
lead_json lead-l SID-L
idl=$(idof "$(as lead-l SID-L "$CREW" spawn lk --repo "$T/my repo" "b")")
live_sub lk-kid SID-LK
exec 7>"$CREW_ROOT/.spawn.lock"; flock 7
CREW_SPAWN_TASK=$idl CREW_SPAWN_TOKEN=$(tok $idl) as lk-kid SID-LK "$CREW" whoami >"$T/lk.out" 2>&1 &
LKP=$!
sleep 0.6
check "consume waits while the spawn lock is held" test -f "$CREW_ROOT/.pending/$idl"
flock -u 7; exec 7>&-
wait $LKP
check "consume completes once the lock is free" test -f "$CREW_ROOT/.links/SID-LK"

# a window that is gone right after launch is a failed start
reset_fake
touch "$FAKE/dies"
out=$(as lead-w SID-W "$CREW" spawn shortlived --repo "$T/my repo" "b"; echo "rc=$?")
eq "a sub-lead window that closed right away is an error" "crew: spawn: the sub-lead window closed right after launch (does \`claude\` start in $T/my repo?) (task $D-shortlived marked failed)
rc=2" "$out"
eq "its task is failed" "failed" "$(tail -n 1 "$CREW_ROOT/$D-shortlived/status" | cut -f2)"
check "and holds no reservation" test ! -e "$CREW_ROOT/.pending/$D-shortlived"

# a brief that starts with a dash is a brief, not an option
reset_fake
out=$(as lead-w SID-W "$CREW" spawn dash-text -- "- first item")
eq "brief text starting with a dash (after --)" "id=$D-dash-text
window=claude:dash-text
child=lead-w/dash-text" "$out"
eq "its intent is that text" "- first item" "$(cat "$CREW_ROOT/$D-dash-text/intent.md")"
printf -- '--force the thing\nmore\n' >"$T/dash.md"
out=$(as lead-w SID-W "$CREW" spawn dash-file --repo "$T/my repo" --brief "$T/dash.md")
eq "a --brief file whose first line starts with dashes" "id=$D-dash-file
window=claude:dash-file
child=lead-w/dash-file" "$out"
eq "its intent is the first line" "--force the thing" "$(cat "$CREW_ROOT/$D-dash-file/intent.md")"


if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
