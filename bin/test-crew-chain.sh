#!/usr/bin/env bash
# Test: chain of command. `crew join LEAD` links a session to a lead; its tasks then count under the lead.
# Fake sessions live in a temp CREW_SESSIONS. The lead is this test shell (pid $$, comm = CREW_LEAD_COMM);
# a sub-session is a short-lived `bash -c` that writes its own json (its pid) and then runs crew.
#   bash test-crew-chain.sh
set -uo pipefail

CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
BG=""
trap 'kill $BG 2>/dev/null; rm -rf "$T"' EXIT
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_NOW=2026-10-16T10:00:00Z CREW CREW_LEAD_COMM
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
CREW_LEAD_COMM=$(cat /proc/$$/comm)
mkdir -p "$CREW_SESSIONS"
fails=0

check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { # description, expected, actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi
}
lead_json() { printf '{"pid":%s,"name":"%s","sessionId":"%s","cwd":"/x"}\n' "${3:-$$}" "$1" "$2" >"$CREW_SESSIONS/$2.json"; }
# as NAME SID cmd...: run crew inside a fresh process of session NAME/SID (same session, new pid each call)
as() {
  local name=$1 sid=$2; shift 2
  bash -c 'printf "{\"pid\":%s,\"name\":\"%s\",\"sessionId\":\"%s\"}\n" "$$" "$1" "$2" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"' _ "$name" "$sid" "$@" 2>&1
}
meta_has() { grep -qxF "$2" "$CREW_ROOT/$1/meta"; }
meta_lacks() { ! grep -q "^$2=" "$CREW_ROOT/$1/meta"; }
new_as() { as "$1" "$2" "$CREW" new "$3" --shape scout "intent" | sed -n 's/^id=//p'; }

lead_json lead-a SID-A
SUB=(review-1 SID-R)

# join: records the link; whoami shows the parent
eq "join prints the link" "joined: review-1 reports to lead-a" "$(as "${SUB[@]}" "$CREW" join lead-a)"
eq "whoami shows a live parent" $'name: review-1\nparent: lead-a (live)\nsubs: none' "$(as "${SUB[@]}" "$CREW" whoami)"
eq "whoami of the lead lists a sub whose process ended as gone" $'name: lead-a\nparent: none\nsubs: review-1 (gone)' "$("$CREW" whoami)"

# a live sub (its own long-running process)
bash -c 'printf "{\"pid\":%s,\"name\":\"review-1\",\"sessionId\":\"SID-R\"}\n" "$$" >"$CREW_SESSIONS/bg-SID-R.json"; while :; do sleep 1; done' &
BG=$!
sleep 0.3
eq "subs lists a live sub" "review-1                 live" "$("$CREW" subs)"
eq "whoami of the lead lists the live sub" $'name: lead-a\nparent: none\nsubs: review-1 (live)' "$("$CREW" whoami)"

# join refusals
eq "join refuses itself" "crew: cannot join yourself" "$(as lead-a SID-A "$CREW" join lead-a)"
eq "join refuses an unknown session" "crew: no live session named 'ghost' (crew ls shows the live ones)" "$(as "${SUB[@]}" "$CREW" join ghost)"
lead_json dead-one SID-D 2000000000
eq "join refuses a dead session" "crew: no live session named 'dead-one' (crew ls shows the live ones)" "$(as "${SUB[@]}" "$CREW" join dead-one)"
eq "join refuses a cycle (lead-a would report to its own sub)" "crew: cycle: 'review-1' already reports to you" "$(as lead-a SID-A "$CREW" join review-1)"
check "refused joins left the link alone" grep -qx 'parent_name=lead-a' "$CREW_ROOT/.links/SID-R"

# tasks from a joined session count under the parent
id=$(new_as "${SUB[@]}" zz-joined)
check "new from a joined session: lead is the parent" meta_has "$id" "lead=lead-a"
check "new from a joined session: lead_pid is the parent's" meta_has "$id" "lead_pid=$$"
check "new from a joined session: sub is this session" meta_has "$id" "sub=review-1"
check "show prints sub=" grep -q "sub=review-1" <<<"$("$CREW" show "$id")"
id0=$(new_as lead-a SID-A zz-own)
check "a lead's own task has no sub" meta_lacks "$id0" sub

# digest tags sub-owned tasks
"$CREW" log "$id" review "2 findings"
"$CREW" hold "$(new_as "${SUB[@]}" zz-held)" "Merge the hotfix?" >/dev/null
eq "digest shows via on changes and needs" \
$'Since last message\n  ? zz-held via review-1    held · Merge the hotfix?\n  ✓ zz-joined via review-1  review · 2 findings\nNeeds you\n  D1  zz-held via review-1 — Merge the hotfix? → crew show '"$(ls "$CREW_ROOT" | grep zz-held)" \
  "$("$CREW" digest --lead lead-a --peek)"

eq "subs --lead names the lead" "review-1                 live" "$("$CREW" subs --lead lead-a)"
kill $BG; BG=""

# the parent restarts under another name: same sessionId still resolves
lead_json lead-b SID-A
eq "renamed parent: whoami follows the sessionId" $'name: review-1\nparent: lead-b (live)\nsubs: none' "$(as "${SUB[@]}" "$CREW" whoami)"
id=$(new_as "${SUB[@]}" zz-renamed)
check "renamed parent: new uses the new name" meta_has "$id" "lead=lead-b"

# the parent dies: whoami says gone, new falls back to lead=self
lead_json lead-b SID-A 2000000000
eq "dead parent: whoami says gone (under the name it last had)" $'name: review-1\nparent: lead-b (gone; reporting in this pane)\nsubs: none' "$(as "${SUB[@]}" "$CREW" whoami)"
id=$(new_as "${SUB[@]}" zz-orphan)
check "dead parent: lead falls back to self" meta_has "$id" "lead=review-1"
check "dead parent: no sub" meta_lacks "$id" sub

# leave clears the link
lead_json lead-b SID-A
eq "leave prints" "left: review-1 reports to no one" "$(as "${SUB[@]}" "$CREW" leave)"
eq "whoami after leave" $'name: review-1\nparent: none\nsubs: none' "$(as "${SUB[@]}" "$CREW" whoami)"
id=$(new_as "${SUB[@]}" zz-left)
check "after leave: lead is self" meta_has "$id" "lead=review-1"
check "after leave: no sub" meta_lacks "$id" sub
eq "leave when not joined" "not joined" "$(as "${SUB[@]}" "$CREW" leave)"

# --- review findings ---
# join is serialized: while another join holds the lock, this one waits and installs nothing
lead_json lead-a SID-A
rm -f "$CREW_ROOT/.links/SID-W"
exec 8>"$CREW_ROOT/.links.lock"; flock 8
as review-w SID-W "$CREW" join lead-a >"$T/w.out" 2>&1 &
WJ=$!
sleep 0.6
check "join waits while the join lock is held" test ! -e "$CREW_ROOT/.links/SID-W"
flock -u 8; exec 8>&-
wait $WJ
check "join completes once the lock is free" test -f "$CREW_ROOT/.links/SID-W"
rm -f "$CREW_ROOT/.links/SID-W"

# a nameless session record is skipped, and does not hide the real ancestor
bash -c 'printf "{\"pid\":%s,\"name\":\"\",\"sessionId\":\"SID-N\"}\n" "$$" >"$CREW_SESSIONS/nameless.json"; "$CREW" whoami' >"$T/n.out" 2>&1
eq "a nameless session is not this session (the next ancestor is)" "name: lead-a" "$(head -n 1 "$T/n.out")"
rm -f "$CREW_SESSIONS/nameless.json"

# a failed link write is an error: non-zero, no success line
chmod 555 "$CREW_ROOT/.links"
out=$(as review-w SID-W "$CREW" join lead-a; echo "rc=$?")
chmod 755 "$CREW_ROOT/.links"
eq "failed link write: error and exit non-zero" "crew: cannot write the link
rc=2" "$out"
check "failed link write: no link" test ! -e "$CREW_ROOT/.links/SID-W"

# the parent restarts with the same name and a new sessionId: subs are still listed under its name, but only a recorded
# continuation (.prev, written by crew relink) re-points the link: a session that merely took the name is not the parent
as "${SUB[@]}" "$CREW" join lead-a >/dev/null
rm -f "$CREW_SESSIONS/SID-A.json"; lead_json lead-a SID-A2
eq "subs --lead finds subs after the parent got a new sessionId" "review-1                 gone" "$("$CREW" subs --lead lead-a)"
check "a name alone does not re-point the stored parent_sid" grep -qx 'parent_sid=SID-A' "$CREW_ROOT/.links/SID-R"
mkdir -p "$CREW_ROOT/.prev"; printf 'SID-A\n' >"$CREW_ROOT/.prev/SID-A2"
"$CREW" subs --lead lead-a >/dev/null
check "a recorded continuation (.prev) re-points the stored parent_sid" grep -qx 'parent_sid=SID-A2' "$CREW_ROOT/.links/SID-R"
rm -f "$CREW_ROOT/.prev/SID-A2"
rm -f "$CREW_SESSIONS/SID-A2.json"; lead_json lead-a SID-A
as "${SUB[@]}" "$CREW" join lead-a >/dev/null

# a long chain back to this session is still a cycle (no hop limit)
for i in $(seq 1 24); do
  p=X$((i + 1)); [ $i -lt 24 ] || p=SID-R
  printf 'sub_name=x%s\nparent_name=x%s\nparent_sid=%s\n' "$i" "$((i + 1))" "$p" >"$CREW_ROOT/.links/X$i"
done
printf 'sub_name=lead-a\nparent_name=x1\nparent_sid=X1\n' >"$CREW_ROOT/.links/SID-A"
eq "a 25-hop chain back to the joiner is refused as a cycle" "crew: cycle: 'lead-a' already reports to you" "$(as "${SUB[@]}" "$CREW" join lead-a)"
rm -f "$CREW_ROOT"/.links/X* "$CREW_ROOT/.links/SID-A"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
