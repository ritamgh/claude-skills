#!/usr/bin/env bash
# Test: `crew spawn --top` starts a top-level lead (no chain link, no pending join, `claude -n <slug>`) from any
# context. tmux and claude are fakes on PATH that record their argv (one argument per line); HOME is a temp dir so
# ~/.claude and ~/Developer are the test's own. The lead/HQ is this test shell (pid $$, comm = CREW_LEAD_COMM);
# "a plain shell" is the same shell with CREW_LEAD_COMM set to a name nothing matches.
#   bash test-crew-spawn-top.sh
set -uo pipefail

CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
BGS=""
trap 'kill $BGS 2>/dev/null; rm -rf "$T"' EXIT
export HOME=$T/home CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-16T10:00:00Z CREW CREW_LEAD_COMM CREW_SPAWN_TRUST_WAIT_S=0 FAKE=$T/fake FAKE_PANE_PID=$$
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
unset CLAUDE_CODE_AUTO_COMPACT_WINDOW
CREW_LEAD_COMM=$(cat /proc/$$/comm)
mkdir -p "$CREW_SESSIONS" "$CREW_PROJECTS" "$FAKE/bin" "$HOME/.claude/sub" "$HOME/Developer/not git" "$T/repo" "$T/plain"
git init -q "$T/repo"
fails=0
D=$(date +%m%d)

cat >"$FAKE/bin/tmux" <<'EOF'
#!/usr/bin/env bash
# fake tmux. State: $FAKE/windows, one "id name" line per window. The pane process is $FAKE_PANE_PID (the test shell).
# new-window records its argv ("--END--" after each call), runs the command it was given to completion, and with -P
# prints "<id> <pane pid>".
w() { cat "$FAKE/windows" 2>/dev/null || true; }
case "$1" in
  list-windows)
    case "$*" in *window_id*) w | cut -d' ' -f1 ;; *) w | cut -d' ' -f2- ;; esac; exit 0 ;;
  list-panes)
    w | grep -q "^$3 " || { echo "can't find window: $3" >&2; exit 1; }
    echo "0 claude"; exit 0 ;;
  new-window)
    { printf '%s\n' "$@"; echo "--END--"; } >>"$FAKE/tmux.log"
    shift; name="" envs=()
    while [ $# -gt 0 ]; do
      case "$1" in -n) name=$2; shift 2 ;; -e) envs+=("$2"); shift 2 ;; -t | -F) shift 2 ;; -d | -P) shift ;; --) shift; break ;; *) shift ;; esac
    done
    seq=$(( $(cat "$FAKE/seq" 2>/dev/null || echo 0) + 1 )); echo "$seq" >"$FAKE/seq"
    printf '@%s %s\n' "$seq" "$name" >>"$FAKE/windows"
    env "${envs[@]}" "$@"
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
as() { # as NAME SID cmd...: run in a fresh process of session NAME/SID
  local name=$1 sid=$2; shift 2
  bash -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" "{pid: \$pid, name: \$n, sessionId: \$s}" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"' _ "$name" "$sid" "$@" 2>&1
}
live_sub() { # NAME SID: a long-running process that is that session
  bash -c 'printf "{\"pid\":%s,\"name\":\"%s\",\"sessionId\":\"%s\"}\n" "$$" "$1" "$2" >"$CREW_SESSIONS/bg-$2.json"; while :; do sleep 1; done' _ "$1" "$2" &
  BGS="$BGS $!"; sleep 0.3
}
plain() { "$CREW" "$@" 2>&1; }   # a plain shell: no claude session above it (this shell has no sessions json)
meta_has() { grep -qxF "$2" "$CREW_ROOT/$1/meta"; }
tok() { grep -m1 "^token=" "$CREW_ROOT/.pending/$1" 2>/dev/null | cut -d= -f2; }
idof() { sed -n 's/^id=//p' <<<"$1"; }
tmux_block() { awk '/^--END--$/ {n = ""; next} {n = n $0 "\n"; last = n} END {printf "%s", last}' "$FAKE/tmux.log" 2>/dev/null; }
last_tmux() { tmux_block | sed -E 's/^CREW_SPAWN_TOKEN=[0-9a-f]{32}$/CREW_SPAWN_TOKEN=TOKEN/'; }
reset_fake() { rm -f "$FAKE/tmux.log" "$FAKE/claude.log" "$FAKE/windows" "$FAKE/seq"; }

# --- from a plain shell: the exact launch argv, no link, no pending join ---
reset_fake
out=$(plain spawn --top fix-bug --repo "$T/repo" --model sonnet "Fix the login bug."); rc=$?
id=$(idof "$out")
eq "spawn --top exits 0 and prints the task, window and name" $'0 id='"$D-fix-bug"$'\nwindow=claude:fix-bug\nchild=fix-bug' "$rc $out"
eq "the exact tmux argv: claude -n <slug>, no lead prefix, the first message then the top-lead line" \
"new-window
-d
-P
-F
#{window_id} #{pane_pid}
-t
claude:
-n
fix-bug
-e
CREW_SPAWN_TASK=$id
-e
CREW_SPAWN_TOKEN=TOKEN
-e
CLAUDE_CODE_AUTO_COMPACT_WINDOW=213000
--
env
-C
$T/repo
claude
-n
fix-bug
--model
sonnet
Fix the login bug.

You are a top-level lead (crew); run \`crew whoami\` first." "$(last_tmux)"
check "meta: top=1" meta_has "$id" "top=1"
check "meta: spawned=1" meta_has "$id" "spawned=1"
check "meta: no lead until the session starts" test -z "$(grep '^lead' "$CREW_ROOT/$id/meta")"
check "no link was made" test -z "$(ls -A "$CREW_ROOT/.links" 2>/dev/null)"
eq "the brief is the first message" "Fix the login bug." "$(cat "$CREW_ROOT/$id/brief.md")"
eq "the reservation says top and has no parent" $'parent_name=\nparent_sid=\nchild_name=fix-bug\nwindow_id=@1\npane_pid='"$$"$'\ntop=1' "$(grep -v '^token=' "$CREW_ROOT/.pending/$id")"
eq "state is running" "running	top-level lead launched in claude:fix-bug" "$(tail -n 1 "$CREW_ROOT/$id/status" | cut -f2-3)"

# --- the new session's first crew call makes it the lead of its own task ---
live_sub fix-bug SID-FB
out=$(CREW_SPAWN_TASK=$id CREW_SPAWN_TOKEN=$(tok $id) as fix-bug SID-FB "$CREW" whoami)
eq "whoami says it started as a top-level lead and has no parent" $'crew: started as a top-level lead (task '"$id"$')\nname: fix-bug\nparent: none\nsubs: none' "$out"
check "meta: lead is the new session" meta_has "$id" "lead=fix-bug"
check "meta: lead_sid is the new session" meta_has "$id" "lead_sid=SID-FB"
check "the reservation is consumed" test ! -e "$CREW_ROOT/.pending/$id"
check "still no link" test -z "$(ls -A "$CREW_ROOT/.links" 2>/dev/null)"

# --- from a lead session (HQ): the caller is recorded nowhere ---
reset_fake
jq -nc --argjson pid $$ '{pid: $pid, name: "hq", sessionId: "SID-HQ"}' >"$CREW_SESSIONS/hq.json"
out=$("$CREW" spawn --top second --repo "$T/repo" "Second job" 2>&1)
id2=$(idof "$out")
eq "spawn --top from a session works" $'id='"$D-second"$'\nwindow=claude:second\nchild=second' "$out"
check "the caller session is not the task's lead" test -z "$(grep '^lead\|^sub' "$CREW_ROOT/$id2/meta")"
check "no pending join names the caller" test -z "$(grep '^parent_sid=.' "$CREW_ROOT/.pending/$id2")"
rm -f "$CREW_SESSIONS/hq.json"

# --- a window name that is taken gets a number, and the session is named for the final window name ---
reset_fake
printf '@9 dup\n' >"$FAKE/windows"
out=$(plain spawn --top dup --repo "$T/repo" "again")
eq "a taken window name is numbered, and so is the printed child" $'id='"$D-dup"$'\nwindow=claude:dup-2\nchild=dup-2' "$out"
eq "claude -n is the numbered window name" "claude
-n
dup-2" "$(last_tmux | sed -n '/^claude$/,$p' | head -3)"
rm -f "$FAKE/windows"

# --- refusals: bad slug, missing repo, ~/.claude, not a repo ---
reset_fake
eq "a one-letter slug is refused" "crew: slug: 2-41 lowercase letters, digits, dashes" "$(plain spawn --top a --repo "$T/repo" "m")"
eq "an upper-case slug is refused" "crew: slug: 2-41 lowercase letters, digits, dashes" "$(plain spawn --top Big --repo "$T/repo" "m")"
eq "a slug starting with a dash is refused" "crew: slug: 2-41 lowercase letters, digits, dashes" "$(plain spawn --top -- -ab "m" --repo "$T/repo")"
eq "a missing repo flag is refused" "crew: spawn --top needs --repo DIR" "$(plain spawn --top okay "m")"
eq "a repo that does not exist is refused" "crew: repo not found: $T/nowhere" "$(plain spawn --top okay --repo "$T/nowhere" "m")"
eq "~/.claude is refused" "crew: refused: $HOME/.claude is inside ~/.claude" "$(plain spawn --top okay --repo "$HOME/.claude" "m")"
eq "a folder under ~/.claude is refused" "crew: refused: $HOME/.claude/sub is inside ~/.claude" "$(plain spawn --top okay --repo "$HOME/.claude/sub" "m")"
mkdir -p "$T/home2/Developer/real-claude"
ln -s "$T/home2/Developer/real-claude" "$T/home2/.claude"
eq "a folder that ~/.claude points to (a symlink into ~/Developer) is refused" "crew: refused: $T/home2/Developer/real-claude is inside ~/.claude" "$(HOME=$T/home2 plain spawn --top okay --repo "$T/home2/Developer/real-claude" "m")"
eq "a folder that is not a git repo and not under ~/Developer is refused" "crew: refused: $T/plain is not a git repo and not under ~/Developer" "$(plain spawn --top okay --repo "$T/plain" "m")"
eq "an empty first message is refused" "crew: the brief is empty" "$(plain spawn --top okay --repo "$T/repo" "")"
check "refusals made no task and launched nothing" test ! -e "$FAKE/tmux.log" -a ! -d "$CREW_ROOT/$D-okay"
out=$(plain spawn --top devdir --repo "$HOME/Developer/not git" "m")
eq "a folder under ~/Developer need not be a git repo" $'id='"$D-devdir"$'\nwindow=claude:devdir\nchild=devdir' "$out"

# --- a quote, a space, $( ) and a backtick in the first message stay literal; a leading dash gets -- ---
reset_fake
msg=$'it\'s "quoted" $(touch '"$T"$'/pwned) `touch '"$T"$'/pwned2`; rm -rf x\nsecond line'
plain spawn --top quoted --repo "$T/repo" "$msg" >/dev/null
eq "the message reaches claude as one argument, verbatim" "cwd=$T/repo
task=$D-quoted
-n
quoted
$msg

You are a top-level lead (crew); run \`crew whoami\` first.
--END--" "$(cat "$FAKE/claude.log")"
check "nothing in the message was executed" test ! -e "$T/pwned" -a ! -e "$T/pwned2"
reset_fake
plain spawn --top dashed --repo "$T/repo" -- "- a list item first" >/dev/null
eq "a first message starting with a dash follows --" "--
- a list item first

You are a top-level lead (crew); run \`crew whoami\` first." "$(last_tmux | sed -n '/^claude$/,$p' | sed 1,3d)"

# --- the cap: 5 live top-level leads, the 6th is refused ---
rm -rf "$CREW_ROOT" "$CREW_SESSIONS"/*; mkdir -p "$CREW_SESSIONS"; reset_fake
for n in 1 2 3 4 5; do
  i=$(idof "$(plain spawn --top "cap$n" --repo "$T/repo" "job $n")")
  live_sub "cap$n" "SID-C$n"
  CREW_SPAWN_TASK=$i CREW_SPAWN_TOKEN=$(tok $i) as "cap$n" "SID-C$n" "$CREW" whoami >/dev/null
done
out=$(plain spawn --top cap6 --repo "$T/repo" "job 6"; echo "rc=$?")
eq "the 6th live top-level lead is refused with the reason" "crew: spawn refused: 5 live top-level leads started with spawn --top (max 5). Close one first.
rc=2" "$out"
check "the refusal made no task" test ! -d "$CREW_ROOT/$D-cap6"
eq "five windows were opened" "5" "$(grep -c '^--END--$' "$FAKE/tmux.log")"
kill "${BGS##* }"; sleep 0.3
out=$(plain spawn --top cap6 --repo "$T/repo" "job 6")
eq "when one of them ends, its place frees" $'id='"$D-cap6"$'\nwindow=claude:cap6\nchild=cap6' "$out"
out=$(plain spawn --top cap7 --repo "$T/repo" "job 7"; echo "rc=$?")
check "a launched one that has not run crew yet counts too" grep -q "^crew: spawn refused: 5 live top-level leads" <<<"$out"

# --- RAM low: queued, not launched; --resume from anywhere launches it ---
rm -rf "$CREW_ROOT" "$CREW_SESSIONS"/*; mkdir -p "$CREW_SESSIONS"; reset_fake
out=$(CREW_MEM_MIN_MB=999999999 plain spawn --top heavy --repo "$T/repo" --model haiku "heavy job")
idr=$(idof "$out")
eq "RAM low: queued with the resume command" "id=$D-heavy
queued: spawn waiting for RAM, not launched (mem low: N MB available < 999999999 MB needed, M MB swap free). Start it with: crew spawn --resume $D-heavy" \
  "$(sed -E 's/[0-9]+ MB available/N MB available/; s/, [0-9]+ MB swap/, M MB swap/' <<<"$out")"
check "RAM low: nothing launched" test ! -e "$FAKE/tmux.log"
eq "RAM low: state queued" "queued	spawn waiting for RAM" "$(tail -n 1 "$CREW_ROOT/$idr/status" | cut -f2-3)"
check "RAM low: top=1 is kept" meta_has "$idr" "top=1"
out=$(CREW_MEM_MIN_MB=1 plain spawn --resume "$idr")
eq "--resume from a plain shell launches it as a top-level lead" $'id='"$idr"$'\nwindow=claude:heavy\nchild=heavy' "$out"
eq "--resume used the stored model, repo and no lead prefix" "-n
heavy
--model
haiku
heavy job

You are a top-level lead (crew); run \`crew whoami\` first." "$(last_tmux | sed -n '/^claude$/,$p' | sed 1d)"

# --- existing sub-lead spawn is unchanged: no top flag, a lead prefix ---
reset_fake
jq -nc --argjson pid $$ '{pid: $pid, name: "lead-a", sessionId: "SID-A"}' >"$CREW_SESSIONS/lead-a.json"
out=$("$CREW" spawn sub1 --repo "$T/repo" "a sub brief" 2>&1)
eq "a sub-lead still gets <lead>/<slug>" $'id='"$D-sub1"$'\nwindow=claude:sub1\nchild=lead-a/sub1' "$out"
check "a sub-lead task has no top flag" test -z "$(grep '^top=' "$CREW_ROOT/$D-sub1/meta")"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
