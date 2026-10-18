#!/usr/bin/env bash
# Test: decision ids (D1, D2...) for `crew hold` / `crew ask` / `crew answer`, their rows in `crew ls`
# and `crew show`, and `crew digest`. Everything runs in a temp crew root; the phone alert is pointed at
# a missing config, so nothing leaves the machine. CREW_NOW fixes the clock for the digest cases.
#   bash test-crew-decisions.sh
set -uo pipefail

CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
trap 'chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"' EXIT
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
mkdir -p "$CREW_SESSIONS"
fails=0

check() { # description, then a command that must succeed
  local desc=$1; shift
  if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi
}
same() { # description, expected text, actual text
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi
}
new_task() { # slug [lead] -> id on stdout
  local id
  id=$("$CREW" new "$1" --shape ship "intent of $1" | sed -n 's/^id=//p')
  [ -z "${2:-}" ] || "$CREW" meta "$id" "lead=$2"
  printf '%s' "$id"
}
state_of() { tail -n 1 "$CREW_ROOT/$1/status" | cut -f2; }
fails_with() { # a command that must exit 2
  "$@" >/dev/null 2>&1
  [ $? = 2 ]
}
ls_has() { grep -qF -- "$1" <<<"$("$CREW" ls)"; }   # not a pipe: grep -q exits early and pipefail would see crew's SIGPIPE

# --- D-id assignment ---
a=$(new_task zz-a)
b=$(new_task zz-b)
c=$(new_task zz-c)
"$CREW" log "$b" review "branch ready"
"$CREW" log "$c" review "branch ready"

same "hold prints the new decision id" "D1" "$("$CREW" hold "$a" "Which DB?")"
same "hold keeps the task held" "held" "$(state_of "$a")"
same "ask prints the next id" "D2" "$("$CREW" ask "$b" "merge zz-b?")"
same "ask leaves the state alone" "review" "$(state_of "$b")"
same "ask writes ask.md" "merge zz-b?" "$(cat "$CREW_ROOT/$b/ask.md")"

# --- stability on re-ask ---
same "hold again on the same task keeps its id" "D1" "$("$CREW" hold "$a" "Which DB, sqlite or postgres?")"
same "hold again replaces the question" "Which DB, sqlite or postgres?" "$(cat "$CREW_ROOT/$a/hold.md")"
same "ask again keeps the id" "D2" "$("$CREW" ask "$b" "merge zz-b into master?")"
same "ask again replaces the question" "merge zz-b into master?" "$(cat "$CREW_ROOT/$b/ask.md")"
same "ask on a held task replaces hold.md and keeps its id" "D1" "$("$CREW" ask "$a" "Which DB: sqlite or postgres?")"
same "ask on a held task did not unhold it" "held" "$(state_of "$a")"
same "ask on a held task wrote hold.md" "Which DB: sqlite or postgres?" "$(cat "$CREW_ROOT/$a/hold.md")"

# --- ls and show ---
check "ls shows D1 on the held row" ls_has "D1 · "
check "ls shows D2 on the review row" bash -c '"$0" ls | grep -F "'"$b"'" | grep -qF "D2 · branch ready"' "$CREW"
check "ls: a review task without a decision shows as before" bash -c '"$0" ls | grep -F "'"$c"'" | grep -qF "branch ready" && ! "$0" ls | grep -F "'"$c"'" | grep -qF " D"' "$CREW"
in_section() { # header, task id: the task's row is under that exact header of `crew ls`
  "$CREW" ls | awk -v h="$1" '/^[A-Z]/ {on = ($0 == h); next} on' | grep -qF "$2"
}
not_in_section() { ! in_section "$@"; }
check "ls: a review task without a decision is RUNNING" in_section RUNNING "$c"
check "ls: a review task without a decision is not NEEDS YOU" not_in_section "NEEDS YOU" "$c"
check "ls: a review task with an open ask is NEEDS YOU" in_section "NEEDS YOU" "$b"
check "ls: a review task with an open ask is not RUNNING" not_in_section RUNNING "$b"
check "show prints the open decision" bash -c '"$0" show "'"$b"'" | grep -qxF "decision: D2 — merge zz-b into master?"' "$CREW"
check "show accepts a D-id" bash -c '"$0" show D2 | head -n 1 | grep -qF "== '"$b"' (review)"' "$CREW"

# --- answer by D-id: held task ---
"$CREW" answer D1 "use postgres" >/dev/null
same "answering a held decision sets state answered" "answered" "$(state_of "$a")"
same "answering a held decision writes answer.md" "use postgres" "$(cat "$CREW_ROOT/$a/answer.md")"
check "the closed decision leaves ls" bash -c '! "$0" ls | grep -qF "D1 · "' "$CREW"
check "answering a closed decision fails" fails_with "$CREW" answer D1 "again"

# --- answer by D-id: review task keeps its state ---
"$CREW" answer D2 "yes, merge" >/dev/null
same "answering an ask leaves the state alone" "review" "$(state_of "$b")"
same "answering an ask writes answer.md" "yes, merge" "$(cat "$CREW_ROOT/$b/answer.md")"
same "answering an ask adds to the status note and keeps what it said" "branch ready · answered D2: yes, merge" "$(tail -n 1 "$CREW_ROOT/$b/status" | cut -f3)"
check "answered ask leaves ls" bash -c '! "$0" ls | grep -qF "D2 · "' "$CREW"

# --- never reused ---
same "a new hold after closes gets a fresh id" "D3" "$("$CREW" hold "$a" "And the schema?")"
same "the counter file holds the last id" "3" "$(cat "$CREW_ROOT/.dseq")"

# --- answer by task id ---
same "ask on another review task" "D4" "$("$CREW" ask "$c" "land zz-c?")"
"$CREW" answer "$c" "go" >/dev/null
same "answer by task id closes an ask" "review" "$(state_of "$c")"
check "answer by task id closed D4" fails_with "$CREW" answer D4 "x"
check "answer by task id fails without a decision on a non-held task" fails_with "$CREW" answer "$c" "x"
check "answer of an unknown D-id fails" fails_with "$CREW" answer D99 "x"

# --- ask on a task with an ask open, then the task ends: the decision closes ---
same "ask on review task" "D5" "$("$CREW" ask "$b" "land zz-b?")"
"$CREW" log "$b" landed "merged"
check "landing closes the open decision" fails_with "$CREW" answer D5 "yes"
check "landed task is out of NEEDS YOU" bash -c '! "$0" ls | sed -n "/^NEEDS YOU/,/^[A-Z]/p" | grep -qF "'"$b"'"' "$CREW"

# --- a progress line does not close an ask; an ask on a running task lands in NEEDS YOU ---
d=$(new_task zz-d)
"$CREW" log "$d" running "part 1/2"
same "ask on a running task" "D6" "$("$CREW" ask "$d" "use tabs?")"
"$CREW" log "$d" running "part 2/2"
check "a progress line keeps the ask open" bash -c '"$0" ls | sed -n "/^NEEDS YOU/,/^RUNNING/p" | grep -F "'"$d"'" | grep -qF "D6 · "' "$CREW"
"$CREW" answer D6 "tabs" >/dev/null
same "answering an ask on a running task keeps it running" "running" "$(state_of "$d")"
check "ask on a finished task is refused" fails_with "$CREW" ask "$b" "too late?"

# --- waiting: someone else must act; its own group, not NEEDS YOU ---
w=$(new_task zz-w)
"$CREW" log "$w" waiting "Sam merges #35"
same "waiting is a state" "waiting" "$(state_of "$w")"
check "ls groups it under WAITING ON OTHERS" bash -c '"$0" ls | sed -n "/^WAITING ON OTHERS/,/^[A-Z]/p" | grep -qF "'"$w"'"' "$CREW"
check "ls keeps it out of NEEDS YOU and RUNNING" bash -c '! "$0" ls | sed -n "/^NEEDS YOU/,/^WAITING/p" | grep -qF "'"$w"'"' "$CREW"
same "ask on a waiting task" "D7" "$("$CREW" ask "$w" "ok to wait for Sam?")"
check "a waiting task with an open decision moves to NEEDS YOU" bash -c '"$0" ls | sed -n "/^NEEDS YOU/,/^RUNNING/p" | grep -F "'"$w"'" | grep -qF "D7 · "' "$CREW"
"$CREW" answer D7 "yes" >/dev/null
same "answering keeps it waiting" "waiting" "$(state_of "$w")"
h=$(new_task zz-h)
"$CREW" hold "$h" "q?" >/dev/null
check "a held task cannot go to waiting before it is answered" fails_with "$CREW" log "$h" waiting "x"
"$CREW" answer "$h" "a" >/dev/null

# --- the answer keeps the PR reference HQ tracks in the note ---
pr=$(new_task zz-pr)
"$CREW" log "$pr" waiting "PR #35 needs colleague merge"
"$CREW" ask "$pr" "ok to keep waiting?" >/dev/null
pid=$(cat "$CREW_ROOT/$pr/decision")
"$CREW" answer "$pid" "yes" >/dev/null
same "answering a waiting task keeps its note with the PR number" "PR #35 needs colleague merge · answered $pid: yes" "$(tail -n 1 "$CREW_ROOT/$pr/status" | cut -f3)"
"$CREW" ask "$pr" "still ok?" >/dev/null
"$CREW" answer "$pr" "yes again" >/dev/null
same "a second answer replaces the first answer note instead of piling up" "PR #35 needs colleague merge · answered $(cat "$CREW_ROOT/.dseq" | sed 's/^/D/'): yes again" "$(tail -n 1 "$CREW_ROOT/$pr/status" | cut -f3)"

# --- parallel asks: no id handed out twice ---
ids=()
for i in 1 2 3 4 5 6; do ids+=("$(new_task "zz-p$i")"); done
for id in "${ids[@]}"; do "$CREW" ask "$id" "q" >"$T/par-$id" & done
wait
same "six parallel asks get six distinct ids" "6" "$(cat "$T"/par-* | sort -u | wc -l | tr -d ' ')"
same "the parallel ids are D11..D16" "D11 D12 D13 D14 D15 D16" "$(cat "$T"/par-* | sort | tr '\n' ' ' | sed 's/ $//')"

# --- parallel asks on one task: one id, and it can be answered ---
one=$(new_task zz-one)
for i in 1 2 3 4 5 6; do "$CREW" ask "$one" "q$i" >"$T/one-$i" & done
wait
same "six parallel asks on one task all get the same id" "1" "$(cat "$T"/one-? | sort -u | wc -l | tr -d ' ')"
check "that id answers the task" bash -c '"$0" answer "$(cat "$1")" ok >/dev/null' "$CREW" "$T/one-1"

# --- notes check: a question or a D-id in a status note warns that notes do not reach the user ---
WARNMSG='status notes do not reach the user; ask with crew ask <id> "<question>" (it opens a D-id)'
nt=$(new_task zz-notes)
nq=$(new_task zz-notes-open)
open_id=$("$CREW" ask "$nq" "keep going?")
err=$("$CREW" log "$nt" running "D99: which option?" 2>&1 >/dev/null); rc=$?
same "a note naming an unopened D-id warns with the D-id prefix" "crew: warning: D99 is not an open decision: $WARNMSG" "$err"
same "the warning does not change the exit status" "0" "$rc"
same "the note is still logged" "D99: which option?" "$(tail -n 1 "$CREW_ROOT/$nt/status" | cut -f3)"
same "a question mark at the end of a note warns without prefix" "crew: warning: $WARNMSG" "$("$CREW" log "$nt" running "ship it?" 2>&1 >/dev/null)"
same "a question mark before a space warns" "crew: warning: $WARNMSG" "$("$CREW" log "$nt" running "which db? sqlite or pg" 2>&1 >/dev/null)"
same "a note naming an open D-id does not warn" "" "$("$CREW" log "$nt" waiting "waiting on $open_id" 2>&1 >/dev/null)"
same "a lower-case d-id that is not open warns with the prefix" "crew: warning: d98 is not an open decision: $WARNMSG" "$("$CREW" log "$nt" running "see d98 later" 2>&1 >/dev/null)"
same "a D-id inside a word is not a D-id" "" "$("$CREW" log "$nt" running "built ADD99 and D99x" 2>&1 >/dev/null)"
same "a question mark inside a URL does not warn" "" "$("$CREW" log "$nt" running "see http://x/?a=1" 2>&1 >/dev/null)"
same "a plain note prints nothing" "" "$("$CREW" log "$nt" running "tests green, pushing" 2>&1)"
same "no note prints nothing" "" "$("$CREW" log "$nt" running 2>&1)"
same "both reasons at once print one line" "crew: warning: D99 is not an open decision: $WARNMSG" "$("$CREW" log "$nt" running "D99 or D98?" 2>&1 >/dev/null)"
nh=$(new_task zz-notes-hold)
same "hold logs its question without the notes warning" "D19" "$("$CREW" hold "$nh" "Which DB?" 2>&1)"
same "answer logs its note without the notes warning" "" "$("$CREW" answer "$nh" "what about D99?" 2>&1)"

# --- help ---
check "help documents ask and digest" bash -c '"$0" help | grep -q "crew ask" && "$0" help | grep -q "crew digest"' "$CREW"

# --- digest (fresh root, fixed clock) ---
export CREW_ROOT=$T/crew2
at() { export CREW_NOW=$1; }
at 2026-10-16T10:00:00Z
ng=$(new_task noop-guard lead-a)
su=$(new_task spec-update lead-a)
st=$(new_task stats lead-a)
rn=$(new_task still-going lead-a)
ot=$(new_task other-lead lead-b)
mm=$(new_task merge-me lead-c)
lo=$(new_task no-lead)
wp=$(new_task wait-pr lead-a)
"$CREW" log "$rn" running "working"
at 2026-10-16T10:01:00Z; "$CREW" log "$ng" review "branch ready to land"
at 2026-10-16T10:01:10Z; "$CREW" log "$su" failed "tests failed"
at 2026-10-16T10:01:20Z; "$CREW" hold "$st" "Which DB?" >/dev/null
at 2026-10-16T10:01:30Z; "$CREW" ask "$ng" "merge acme-gateway #35?" >/dev/null
at 2026-10-16T10:01:40Z; "$CREW" log "$ot" done "elsewhere"
at 2026-10-16T10:01:50Z; "$CREW" log "$lo" done "nobody's"
at 2026-10-16T10:01:55Z; "$CREW" log "$wp" waiting "Sam merges #35"   # in neither Since nor Needs you
at 2026-10-16T10:01:55Z; "$CREW" log "$wp" waiting "Sam merges #35"   # not in Since, not in Needs you

at 2026-10-16T10:02:00Z
same "digest lists changes since the marker and open decisions, aligned" "Since last message
  ✓ noop-guard   review · branch ready to land
  ✗ spec-update  failed · tests failed
  ? stats        held · Which DB?
Needs you
  D1  stats — Which DB? → crew show $st
  D2  noop-guard — merge acme-gateway #35? → crew show $ng" "$("$CREW" digest --lead lead-a)"
check "digest wrote the per-lead marker" test -s "$CREW_ROOT/.digest-lead-a"

at 2026-10-16T10:03:00Z
same "a second digest repeats only the open decisions" "Needs you
  D1  stats — Which DB? → crew show $st
  D2  noop-guard — merge acme-gateway #35? → crew show $ng" "$("$CREW" digest --lead lead-a)"

at 2026-10-16T10:04:00Z; "$CREW" answer D1 "use postgres" >/dev/null
at 2026-10-16T10:05:00Z
same "an answered hold shows once as a change; the ask stays in Needs you" "Since last message
  → stats  answered · use postgres
Needs you
  D2  noop-guard — merge acme-gateway #35? → crew show $ng" "$("$CREW" digest --lead lead-a)"

at 2026-10-16T10:06:00Z; "$CREW" log "$ng" landed "merged"
at 2026-10-16T10:07:00Z
same "--peek shows the landed task and no open decision" "Since last message
  ✓ noop-guard  landed · merged" "$("$CREW" digest --lead lead-a --peek)"
same "--peek did not move the marker" "Since last message
  ✓ noop-guard  landed · merged" "$("$CREW" digest --lead lead-a)"
at 2026-10-16T10:08:00Z
same "after a real digest nothing is printed" "" "$("$CREW" digest --lead lead-a)"
check "an empty digest prints no bytes at all" bash -c '[ "$("$0" digest --lead lead-a | wc -c)" = 0 ]' "$CREW"

at 2026-10-16T10:09:00Z
same "another lead sees only its own tasks" "Since last message
  ✓ other-lead  done · elsewhere" "$("$CREW" digest --lead lead-b)"

# an ask answered on a review task is not a new state change
at 2026-10-16T10:09:10Z; "$CREW" log "$mm" review "ready"
at 2026-10-16T10:09:20Z
"$CREW" digest --lead lead-c >/dev/null
at 2026-10-16T10:09:30Z; "$CREW" ask "$mm" "land it?" >/dev/null
at 2026-10-16T10:09:40Z; "$CREW" answer "$mm" "yes" >/dev/null
at 2026-10-16T10:09:50Z
same "answering an ask on a review task is not reported as a change" "" "$("$CREW" digest --lead lead-c)"

# a lead with no marker gets the last 24 hours: at 10:03 next day, the 10:01 failure is just out of range
rm -f "$CREW_ROOT/.digest-lead-a"
at 2026-10-17T10:03:00Z
same "no marker: only events from the last 24h are included" "Since last message
  → stats       answered · use postgres
  ✓ noop-guard  landed · merged" "$("$CREW" digest --lead lead-a --peek)"

# an event in the same second as the digest is reported by the next digest, once
ld=$(new_task same-second lead-d)
at 2026-10-16T11:00:00Z
"$CREW" digest --lead lead-d >/dev/null
"$CREW" log "$ld" done "ok"
same "a change in the same second as the last digest is not lost" "Since last message
  ✓ same-second  done · ok" "$("$CREW" digest --lead lead-d)"
same "and it is not reported twice" "" "$("$CREW" digest --lead lead-d)"
at 2026-10-16T11:00:05Z
same "nor in a later second" "" "$("$CREW" digest --lead lead-d)"

# default lead: the owning claude session (a fake session file whose pid is this shell)
MYCOMM=$(cat /proc/$$/comm)
export CREW_LEAD_COMM=$MYCOMM
printf '{"pid":%s,"name":"lead-b","cwd":"/x","status":"idle"}\n' "$$" >"$CREW_SESSIONS/aaa.json"
at 2026-10-16T10:10:00Z
rm -f "$CREW_ROOT/.digest-lead-b"
same "without --lead the session's own name is used" "Since last message
  ✓ other-lead  done · elsewhere" "$("$CREW" digest --peek)"
rm -f "$CREW_SESSIONS/aaa.json"
check "without --lead and outside a session digest fails" fails_with "$CREW" digest

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
