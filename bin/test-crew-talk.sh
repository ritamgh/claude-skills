#!/usr/bin/env bash
# Test: `crew talk` between sibling feature owners (threads, caps, refusals, --done, --list) and the `talk:` lines
# of `crew digest`. Fake sessions live in a temp CREW_SESSIONS: the owner that "runs" crew is the session json that
# points at this script's pid (switched with `as NAME`); every other live session is a background process with its
# own json. Owners are written straight into $CREW_ROOT/.owners/<id>/owner. No tmux involved.
#   bash test-crew-talk.sh
set -uo pipefail

CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
BG=()
cleanup() {
  local p
  for p in "${BG[@]:-}"; do [ -z "$p" ] || kill "$p" 2>/dev/null; done
  chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"
}
trap cleanup EXIT
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_LEAD_COMM=bash
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
export CREW_NOW=2026-01-01T10:00:00Z
unset CREW_TALK_CAP
mkdir -p "$CREW_SESSIONS" "$CREW_ROOT"
fails=0

check() { # description, then a command that must succeed
  local desc=$1; shift
  if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi
}
same() { # description, expected text, actual text
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi
}

# live session NAME/SID backed by a background process whose comm is "bash" (what CREW_LEAD_COMM says a claude is)
live() {
  { while kill -0 $$ 2>/dev/null; do sleep 1; done; } >/dev/null 2>&1 </dev/null &   # ends with this script
  BG+=("$!")
  printf '{"pid":%s,"name":"%s","sessionId":"%s"}\n' "$!" "$1" "$2" >"$CREW_SESSIONS/$2.json"
}
# the session that runs crew from here on is NAME/SID (this script's pid); "none" = a plain shell
as() {
  if [ "$1" = none ]; then rm -f "$CREW_SESSIONS/me.json"
  else printf '{"pid":%s,"name":"%s","sessionId":"%s"}\n' "$$" "$1" "$2" >"$CREW_SESSIONS/me.json"; fi
}
owner() { # id sid name lead lead_sid state
  mkdir -p "$CREW_ROOT/.owners/$1"
  printf 'feature=%s\nrepo=/x\npath=src/\nsid=%s\nname=%s\nlead=%s\nlead_sid=%s\nstate=%s\n' "$1" "$2" "$3" "$4" "$5" "$6" >"$CREW_ROOT/.owners/$1/owner"
}
meta_of() { cat "$CREW_ROOT/.talk/$1/meta"; }
log_of() { cat "$CREW_ROOT/.talk/$1/log"; }
run() { # run crew talk: stdout to $T/out, stderr to $T/err, exit status to $T/rc
  "$CREW" talk "$@" >"$T/out" 2>"$T/err"; echo $? >"$T/rc"
}
rc_is() { [ "$(cat "$T/rc")" = "$1" ]; }

live lead1 sid-lead1
live lead2 sid-lead2
live api-sess sid-api
live web-sess sid-web
live other-sess sid-other
live idle-sess sid-stranger
owner api sid-api api-sess lead1 sid-lead1 awake
owner web sid-web web-sess lead1 sid-lead1 awake
owner other sid-other other-sess lead2 sid-lead2 awake
owner db sid-db db-sess lead1 sid-lead1 asleep
owner ghost sid-ghost ghost-sess lead1 sid-lead1 awake

# --- the first message and the reply: one thread, both directions ---
as web-sess sid-web
run api "Auth header" "does the API expect Bearer?"
check "first message: exit 0" rc_is 0
same "first message: the two lines to send" \
  $'send with SendMessage to api-sess:\n[talk web→api "Auth header" 1/6] does the API expect Bearer?' "$(cat "$T/out")"
same "first message: thread folder is a--b--slug with a<b" "api--web--auth-header" "$(ls "$CREW_ROOT/.talk")"
same "first message: meta" \
  $'a=api\nb=web\ntopic=Auth header\nlead=lead1\nlead_sid=sid-lead1\ncap=6\nturns=1\nstate=open\ncreated=2026-01-01T10:00:00Z\nupdated=2026-01-01T10:00:00Z' \
  "$(meta_of api--web--auth-header)"
same "first message: log line" $'2026-01-01T10:00:00Z\tweb\tapi\tdoes the API expect Bearer?' "$(log_of api--web--auth-header)"

as api-sess sid-api
CREW_NOW=2026-01-01T10:05:00Z run web "Auth header" "yes, Bearer"
same "reply: the two lines to send" \
  $'send with SendMessage to web-sess:\n[talk api→web "Auth header" 2/6] yes, Bearer' "$(cat "$T/out")"
same "reply: same thread, still one folder" "api--web--auth-header" "$(ls "$CREW_ROOT/.talk")"
same "reply: log has both senders" \
  $'2026-01-01T10:00:00Z\tweb\tapi\tdoes the API expect Bearer?\n2026-01-01T10:05:00Z\tapi\tweb\tyes, Bearer' "$(log_of api--web--auth-header)"
check "reply: updated moved, created did not" bash -c 'grep -qx "updated=2026-01-01T10:05:00Z" "$1" && grep -qx "created=2026-01-01T10:00:00Z" "$1"' _ "$CREW_ROOT/.talk/api--web--auth-header/meta"
run web-sess "Auth header" "and the realm?"
same "TO may be the owner's session name; turns count both senders" '[talk api→web "Auth header" 3/6] and the realm?' "$(sed -n 2p "$T/out")"

# --- cap ---
for i in 1 2 3 4 5 6; do
  if [ $((i % 2)) = 1 ]; then as api-sess sid-api; run web "cap test" "m$i"; else as web-sess sid-web; run api "cap test" "m$i"; fi
done
same "6th message is accepted" '[talk web→api "cap test" 6/6] m6' "$(sed -n 2p "$T/out")"
as api-sess sid-api
run web "cap test" "m7"
check "7th message: exit 3" rc_is 3
same "7th message: refusal text" 'crew: refused: cap reached (6/6) on api↔web "cap test": take it to your lead (lead1), it decides or asks the user' "$(cat "$T/err")"
same "7th message: nothing printed" "" "$(cat "$T/out")"
same "7th message: log has exactly 6 lines" 6 "$(wc -l <"$CREW_ROOT/.talk/api--web--cap-test/log")"
check "7th message: state=capped" grep -qx "state=capped" "$CREW_ROOT/.talk/api--web--cap-test/meta"
run web "cap test" "m8"
check "8th message: still refused" rc_is 3
CREW_TALK_CAP=2 run web "tiny" "one"
CREW_TALK_CAP=2 run web "tiny" "two"
same "CREW_TALK_CAP=2: second message accepted" '[talk api→web "tiny" 2/2] two' "$(sed -n 2p "$T/out")"
CREW_TALK_CAP=2 run web "tiny" "three"
check "CREW_TALK_CAP=2: third refused" rc_is 3
same "CREW_TALK_CAP=2: refusal text" 'crew: refused: cap reached (2/2) on api↔web "tiny": take it to your lead (lead1), it decides or asks the user' "$(cat "$T/err")"

# --- closed ---
run --done web "Auth header"
check "--done: exit 0" rc_is 0
check "--done: state=closed" grep -qx "state=closed" "$CREW_ROOT/.talk/api--web--auth-header/meta"
as web-sess sid-web
run api "Auth header" "one more thing"
check "closed thread: exit 3" rc_is 3
same "closed thread: refusal text" "crew: refused: thread closed: start a new topic" "$(cat "$T/err")"
same "closed thread: log unchanged" 3 "$(wc -l <"$CREW_ROOT/.talk/api--web--auth-header/log")"
run --done api "no such topic"
check "--done on a missing thread: exit 2" rc_is 2

# --- refusals ---
run other "Shared type" "can you export Foo?"
check "non-sibling: exit 3" rc_is 3
same "non-sibling: refusal text" "crew: refused: other is not your sibling (lead lead2): ask your lead" "$(cat "$T/err")"
check "non-sibling: no thread" test ! -d "$CREW_ROOT/.talk/other--web--shared-type"
run db "Schema" "which column?"
check "asleep receiver: exit 3" rc_is 3
same "asleep receiver: refusal text" "crew: refused: db is asleep: ask your lead (lead1) to wake it" "$(cat "$T/err")"
run ghost "Schema" "which column?"
same "awake but not running receiver: refused as asleep" "crew: refused: ghost is asleep: ask your lead (lead1) to wake it" "$(cat "$T/err")"
run web "Self" "hi me"
check "to yourself: exit 3" rc_is 3
run nobody "Schema" "which column?"
check "unknown receiver: exit 2" rc_is 2
as idle-sess sid-stranger
run api "Hello" "hi"
check "not an owner: exit 3" rc_is 3
same "not an owner: refusal text" "crew: refused: only feature owners talk; you are not one" "$(cat "$T/err")"
as none
run api "Hello" "hi"
same "plain shell: refused too" "crew: refused: only feature owners talk; you are not one" "$(cat "$T/err")"
as web-sess sid-web

# --- input checks (usage errors, exit 2) ---
run api "Topic" ""
check "empty message: exit 2" rc_is 2
run api "" "hi"
check "empty topic: exit 2" rc_is 2
run api "!!!" "hi"
check "topic with no letters or digits: exit 2" rc_is 2
run api "$(printf 'x%.0s' $(seq 81))" "hi"
check "topic over 80 chars: exit 2" rc_is 2
run api "two"$'\n'"lines" "hi"
check "multi-line topic: exit 2" rc_is 2
run api "Big" "$(printf 'y%.0s' $(seq 1501))"
check "message over 1500 chars: exit 2" rc_is 2
run api "Big" "$(printf 'y%.0s' $(seq 1500))"
check "message of exactly 1500 chars: accepted" rc_is 0
run api "Two args" "one" "two"
check "two message arguments: exit 2" rc_is 2

# --- topic -> slug ---
run api "Authentication header handling for the websocket upgrade path now" "long"
check "long topic: slug cut at 40, no trailing dash" test -d "$CREW_ROOT/.talk/api--web--authentication-header-handling-for-the-w"
run api "  Mixed -- CASE & punct!  " "slug"
check "punctuation runs become one dash" test -d "$CREW_ROOT/.talk/api--web--mixed-case-punct"
same "the topic is kept as given (trimmed) in the printed line" '[talk web→api "Mixed -- CASE & punct!" 1/6] slug' "$(sed -n 2p "$T/out")"

# --- messages are data ---
msg=$'a $(touch '"$T"$'/pwned) "q" \'s\' `touch '"$T"$'/pwned2` \\n\tb\nc'
run api "Literal" "$msg"
check "weird message: exit 0" rc_is 0
want='a $(touch '"$T"'/pwned) "q" '"'s'"' `touch '"$T"'/pwned2` \n b c'
same "weird message: printed on one line, literally" "[talk web→api \"Literal\" 1/6] $want" "$(sed -n 2p "$T/out")"
same "weird message: logged on one line, literally" "$want" "$(cut -f4 "$CREW_ROOT/.talk/api--web--literal/log")"
same "weird message: one log line" 1 "$(wc -l <"$CREW_ROOT/.talk/api--web--literal/log")"
check "weird message: nothing was executed" test ! -e "$T/pwned" -a ! -e "$T/pwned2"
run api "Dashes" -- "--looks like a flag"
same "message after --: taken literally" '[talk web→api "Dashes" 1/6] --looks like a flag' "$(sed -n 2p "$T/out")"

# --- concurrency: turns 5 of 6, ten at once, one gets in ---
mkdir -p "$CREW_ROOT/.talk/api--web--race"
printf 'a=api\nb=web\ntopic=race\nlead=lead1\nlead_sid=sid-lead1\ncap=6\nturns=5\nstate=open\ncreated=2026-01-01T09:00:00Z\nupdated=2026-01-01T09:00:00Z\n' >"$CREW_ROOT/.talk/api--web--race/meta"
for i in 1 2 3 4 5; do printf '2026-01-01T09:00:00Z\tapi\tweb\tm%s\n' "$i"; done >"$CREW_ROOT/.talk/api--web--race/log"
pids=()
for i in $(seq 10); do "$CREW" talk api race "racer $i" >"$T/race.$i.out" 2>"$T/race.$i.err" & pids+=("$!"); done
ok=0; refused=0
for i in "${!pids[@]}"; do
  wait "${pids[$i]}"; rc=$?
  case $rc in 0) ok=$((ok + 1)) ;; 3) refused=$((refused + 1)) ;; esac
done
same "race: exactly one of ten succeeds" "1 9" "$ok $refused"
same "race: log has exactly 6 lines" 6 "$(wc -l <"$CREW_ROOT/.talk/api--web--race/log")"
check "race: turns=6 in meta" grep -qx "turns=6" "$CREW_ROOT/.talk/api--web--race/meta"

# --- list ---
rm -rf "$CREW_ROOT/.talk"
as web-sess sid-web
run api "Auth header" "a"
run api "Auth header" "b"
as api-sess sid-api
CREW_NOW=2026-01-01T10:30:00Z run web "Auth header" "c"
as web-sess sid-web
run api "Closed one" "x"
run --done api "Closed one"
as lead2 sid-lead2
mkdir -p "$CREW_ROOT/.talk/api--other--theirs"
printf 'a=api\nb=other\ntopic=theirs\nlead=lead2\nlead_sid=sid-lead2\ncap=6\nturns=1\nstate=open\ncreated=2026-01-01T09:00:00Z\nupdated=2026-01-01T09:00:00Z\n' >"$CREW_ROOT/.talk/api--other--theirs/meta"
export CREW_NOW=2026-01-01T11:30:00Z
as lead1 sid-lead1
run --list
same "--list as lead1: its threads with turns, state and age" \
  $'api↔web "Auth header" 3/6 open 1h\napi↔web "Closed one" 1/6 closed 1h' "$(cat "$T/out")"
run --list --lead lead2
same "--list --lead NAME: only that lead's threads" 'api↔other "theirs" 1/6 open 2h' "$(cat "$T/out")"
as none
run --list
same "--list in a plain shell: all threads" \
  $'api↔other "theirs" 1/6 open 2h\napi↔web "Auth header" 3/6 open 1h\napi↔web "Closed one" 1/6 closed 1h' "$(cat "$T/out")"

# --- digest ---
rm -rf "$CREW_ROOT/.talk"
export CREW_NOW=2026-01-01T10:00:00Z
as web-sess sid-web
run api "Auth header" "a"
as api-sess sid-api
run web "Auth header" "b"
as web-sess sid-web
run api "Auth header" "c"
as web-sess sid-web
run api "Done topic" "d"
run --done api "Done topic"
as none
export CREW_NOW=2026-01-01T11:00:00Z
same "digest shows the talk for the lead" $'Talk\n  talk: api↔web "Auth header" (3/6)' "$("$CREW" digest --lead lead1)"
export CREW_NOW=2026-01-01T12:00:00Z
same "digest shows it only once after the marker moved" "" "$("$CREW" digest --lead lead1)"
as web-sess sid-web
CREW_NOW=2026-01-01T12:30:00Z run api "Auth header" "e"
as none
export CREW_NOW=2026-01-01T13:00:00Z
same "a new message shows the thread again" $'Talk\n  talk: api↔web "Auth header" (4/6)' "$("$CREW" digest --lead lead1)"
same "another lead sees nothing" "" "$("$CREW" digest --lead lead2)"
as web-sess sid-web
CREW_NOW=2026-01-01T13:10:00Z run api "Auth header" "f"
CREW_NOW=2026-01-01T13:11:00Z run api "Auth header" "g"
as api-sess sid-api
CREW_NOW=2026-01-01T13:12:00Z run web "Auth header" "h"
CREW_NOW=2026-01-01T13:13:00Z run web "Auth header" "i"
check "digest case: the cap refusal" rc_is 3
as none
export CREW_NOW=2026-01-01T14:00:00Z
same "--peek prints the same and leaves the marker alone" $'Talk\n  talk: api↔web "Auth header" (6/6) capped → you' "$("$CREW" digest --lead lead1 --peek)"
same "the real digest still shows it" $'Talk\n  talk: api↔web "Auth header" (6/6) capped → you' "$("$CREW" digest --lead lead1)"
same "and then not again" "" "$("$CREW" digest --lead lead1)"

if [ $fails -eq 0 ]; then echo "all passed"; else echo "$fails FAILED"; exit 1; fi
