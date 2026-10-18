#!/usr/bin/env bash
# Test: identity by sessionId. Renaming a lead or a sub, or restarting a session (new sessionId), must not orphan
# the tasks and links above and under it. Fake sessions live in a temp CREW_SESSIONS; the lead is this test shell
# (pid $$), a sub is a `bash -c` that writes its own json and then runs crew, or a background sleeper.
#   bash test-crew-identity.sh
set -uo pipefail

CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
BGS=""
trap 'kill $BGS 2>/dev/null; rm -rf "$T"' EXIT
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-16T10:00:00Z CREW CREW_LEAD_COMM
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
CREW_LEAD_COMM=$(cat /proc/$$/comm)
mkdir -p "$CREW_SESSIONS" "$CREW_PROJECTS/-x"
fails=0

check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { # description, expected, actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi
}
lead_json() { printf '{"pid":%s,"name":"%s","sessionId":"%s","cwd":"/x"}\n' "${3:-$$}" "$1" "$2" >"$CREW_SESSIONS/$2.json"; }
as() { # as NAME SID cmd...: run crew inside a fresh process of session NAME/SID
  local name=$1 sid=$2; shift 2
  bash -c 'printf "{\"pid\":%s,\"name\":\"%s\",\"sessionId\":\"%s\"}\n" "$$" "$1" "$2" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"' _ "$name" "$sid" "$@" 2>&1
}
live_sub() { # NAME SID: a long-running process that is that session (kept until the test ends)
  bash -c 'printf "{\"pid\":%s,\"name\":\"%s\",\"sessionId\":\"%s\"}\n" "$$" "$1" "$2" >"$CREW_SESSIONS/bg-$2.json"; while :; do sleep 1; done' _ "$1" "$2" &
  BGS="$BGS $!"; sleep 0.3
}
meta_has() { grep -qxF "$2" "$CREW_ROOT/$1/meta"; }
new_as() { as "$1" "$2" "$CREW" new "$3" --shape scout "intent" | sed -n 's/^id=//p'; }
transcript() { # SID OLD...: a resumed session's transcript: the records of each older life (ending in uuid U-<OLD>), then its own
  local sid=$1; shift
  local o; for o in "$@"; do
    [ -f "$CREW_PROJECTS/-x/$o.jsonl" ] || printf '{"type":"user","uuid":"U-%s","sessionId":"%s","message":"hi"}\n' "$o" "$o" >"$CREW_PROJECTS/-x/$o.jsonl"
  done
  { for o in "$@"; do printf '{"type":"user","uuid":"U-%s","sessionId":"%s","message":"hi"}\n' "$o" "$o"; done
    printf '{"type":"user","uuid":"U-%s","sessionId":"%s","message":"after resume"}\n' "$sid" "$sid"; } >"$CREW_PROJECTS/-x/$sid.jsonl"
}

# --- a lead is renamed: its tasks stay with it ---
lead_json lead-a SID-A
live_sub review-1 SID-R
as review-1 SID-R "$CREW" join lead-a >/dev/null
id=$(new_as lead-a SID-A zz-own)
check "new records lead_sid" meta_has "$id" "lead_sid=SID-A"
sid2=$(new_as review-1 SID-R zz-sub)
check "a joined sub's task records the parent's lead_sid" meta_has "$sid2" "lead_sid=SID-A"
check "a joined sub's task records sub_sid" meta_has "$sid2" "sub_sid=SID-R"
"$CREW" log "$id" review "ready"
"$CREW" log "$sid2" review "also ready"

lead_json lead-z SID-A   # the user renames the session; the sessionId stays
eq "digest of the renamed lead still has its tasks (and the sub's)" \
$'Since last message\n  ✓ zz-own               review · ready\n  ✓ zz-sub via review-1  review · also ready' \
  "$("$CREW" digest --lead lead-z --peek)"
eq "digest without --lead (run as the renamed session) has them too" \
$'Since last message\n  ✓ zz-own               review · ready\n  ✓ zz-sub via review-1  review · also ready' \
  "$(as lead-z SID-A "$CREW" digest --peek)"
eq "ls --leads shows the current lead name" "lead-z" "$("$CREW" ls --leads | awk -v i="$id" '$1 == i {print $6}')"
check "ls refreshed lead= in meta so name-matching readers (HQ) follow" meta_has "$id" "lead=lead-z"
check "ls kept the old name as lead_was" meta_has "$id" "lead_was=lead-a"
check "the sub's task follows too" meta_has "$sid2" "lead=lead-z"
check "show prints the current name and the old one" grep -qxF "lead: lead-z (was lead-a)" <<<"$("$CREW" show "$id")"
eq "the sub's whoami shows the live parent under its new name" $'name: review-1\nparent: lead-z (live)\nsubs: none' "$(as review-1 SID-R "$CREW" whoami)"

# --- a sub is renamed: the lead still lists it, tasks say who it is now ---
jq '.name = "review-2"' "$CREW_SESSIONS/bg-SID-R.json" >"$T/r.json" && mv "$T/r.json" "$CREW_SESSIONS/bg-SID-R.json"   # same process and sessionId, new name
eq "subs lists the sub under its new name" "review-2                 live" "$(as lead-z SID-A "$CREW" subs)"
eq "the link stores the new sub name" "sub_name=review-2" "$(grep '^sub_name=' "$CREW_ROOT/.links/SID-R")"
"$CREW" ls >/dev/null
check "ls refreshed sub= in meta" meta_has "$sid2" "sub=review-2"
eq "digest tags the task with the sub's new name" "  ✓ zz-sub via review-2  review · also ready" "$("$CREW" digest --lead lead-z --peek | sed -n 3p)"

# --- the lead restarts: new sessionId, new name; its transcript starts with the old id ---
rm -f "$CREW_SESSIONS/SID-A.json"
lead_json lead-new SID-A2
eq "before relink the restarted lead's digest has none of the old tasks (sessionId unknown)" "" "$("$CREW" digest --lead lead-new --peek)"
transcript SID-A2 SID-A
eq "relink says what it followed" "relink: lead-new continues SID-A" "$(as lead-new SID-A2 "$CREW" relink)"
eq "relink is idempotent" "relink: lead-new continues SID-A (already recorded)" "$(as lead-new SID-A2 "$CREW" relink)"
eq "the old tasks are back in the restarted lead's digest" \
$'Since last message\n  ✓ zz-own               review · ready\n  ✓ zz-sub via review-2  review · also ready' \
  "$("$CREW" digest --lead lead-new --peek)"
check "the sub's link now points at the new sessionId" grep -qx 'parent_sid=SID-A2' "$CREW_ROOT/.links/SID-R"
eq "the sub's whoami sees the restarted parent" $'name: review-2\nparent: lead-new (live)\nsubs: none' "$(as review-2 SID-R "$CREW" whoami)"

# --- a sub restarts: its link moves to its new sessionId ---
rm -f "$CREW_SESSIONS"/bg-SID-R.json "$CREW_SESSIONS"/run-SID-R.json
transcript SID-R2 SID-R
live_sub review-3 SID-R2
eq "sub restart: relink moves the link" "relink: review-3 continues SID-R" "$(as review-3 SID-R2 "$CREW" relink)"
check "the link is filed under the new sub id" test -f "$CREW_ROOT/.links/SID-R2"
check "the old link file is gone" test ! -e "$CREW_ROOT/.links/SID-R"
eq "the sub's new life still reports to the lead" $'name: review-3\nparent: lead-new (live)\nsubs: none' "$(as review-3 SID-R2 "$CREW" whoami)"
eq "the sub's old task shows the new life's name" "review-3" "$("$CREW" ls --leads >/dev/null; "$CREW" digest --lead lead-new --peek | sed -n 3p | sed -E 's/.* via ([^ ]+) .*/\1/')"

# --- lazy relink: no hook needed ---
lead_json lead-q SID-Q
transcript SID-Q2 SID-Q
printf 'sub_name=lead-q\nparent_name=lead-new\nparent_sid=SID-A2\n' >"$CREW_ROOT/.links/SID-Q"
rm -f "$CREW_SESSIONS/SID-Q.json"; lead_json lead-q2 SID-Q2
lid=$(new_as lead-q2 SID-Q2 zz-lazy)
check "new relinks first: the link followed the new sessionId" test -f "$CREW_ROOT/.links/SID-Q2"
check "new relinks first: marker written" test -f "$CREW_ROOT/.relinked/SID-Q2"
check "the new task is the moved link's: sub_sid is the new id, lead is the parent" meta_has "$lid" "sub_sid=SID-Q2"

# an id that is another live session in the transcript is not an earlier life
lead_json lead-other SID-O
transcript SID-N SID-O
as lead-n SID-N "$CREW" relink >/dev/null
check "a live session's id in a transcript is not adopted" test ! -s "$CREW_ROOT/.prev/SID-N"

# --- legacy meta (name only) keeps working ---
mkdir -p "$CREW_ROOT/1016-legacy"; printf 'shape=scout\nlead=lead-new\nlead_pid=1\n' >"$CREW_ROOT/1016-legacy/meta"
printf '%s\tdone\tok\n' "$CREW_NOW" >"$CREW_ROOT/1016-legacy/status"; echo x >"$CREW_ROOT/1016-legacy/intent.md"
check "name-only task still reaches its lead's digest" grep -q "legacy" <<<"$("$CREW" digest --lead lead-new --peek)"

# --- a hand-set lead= does not keep the creator's sid ---
"$CREW" meta "$id" lead=lead-other
eq "meta lead= takes the sid of the live session of that name" "SID-O" "$(grep '^lead_sid=' "$CREW_ROOT/$id/meta" | tail -n 1 | cut -d= -f2)"
"$CREW" meta "$id" lead=nobody
eq "meta lead= for an unknown name clears the sid" "" "$(grep '^lead_sid=' "$CREW_ROOT/$id/meta" | tail -n 1 | cut -d= -f2)"

# --- meta-migrate: unambiguous names only, dry run by default ---
for n in uniq dup ghost; do
  mkdir -p "$CREW_ROOT/1016-m-$n"; printf 'shape=scout\nlead=%s\n' "$n" >"$CREW_ROOT/1016-m-$n/meta"
  printf '%s\trunning\tgo\n' "$CREW_NOW" >"$CREW_ROOT/1016-m-$n/status"; echo x >"$CREW_ROOT/1016-m-$n/intent.md"
done
lead_json uniq SID-U; lead_json dup SID-D1; lead_json dup SID-D2
eq "meta-migrate dry run lists what it would do" \
$'skip   1016-m-dup: lead=dup is ambiguous (2 live sessions)\nskip   1016-m-ghost: lead=ghost has no live session\nwould  1016-m-uniq: lead_sid=SID-U (lead=uniq)\ndry run: 1 field(s) to migrate (crew meta-migrate --apply)' \
  "$("$CREW" meta-migrate | grep -E 'm-(uniq|dup|ghost)|dry run')"
check "dry run changed nothing" test -z "$(grep lead_sid "$CREW_ROOT/1016-m-uniq/meta")"
"$CREW" meta-migrate --apply >/dev/null
check "--apply sets the unambiguous one" meta_has 1016-m-uniq "lead_sid=SID-U"
check "--apply leaves the ambiguous one alone" test -z "$(grep lead_sid "$CREW_ROOT/1016-m-dup/meta")"
check "--apply leaves the one without a live session alone" test -z "$(grep lead_sid "$CREW_ROOT/1016-m-ghost/meta")"

# --- review fixes ---
# 1. a fork copies only part of another session: it does not adopt that session, and a full copy cannot be stolen twice
printf '{"type":"user","uuid":"X1","sessionId":"SID-X"}\n{"type":"user","uuid":"X2","sessionId":"SID-X"}\n' >"$CREW_PROJECTS/-x/SID-X.jsonl"
printf '{"type":"user","uuid":"X1","sessionId":"SID-X"}\n{"type":"user","uuid":"F1","sessionId":"SID-F"}\n' >"$CREW_PROJECTS/-x/SID-F.jsonl"
printf 'sub_name=xsub\nparent_name=lead-new\nparent_sid=SID-A2\n' >"$CREW_ROOT/.links/SID-X"
eq "a fork (copied up to X1 of X1,X2) adopts nothing" "relink: fork-1 has no earlier session id in its transcript" "$(as fork-1 SID-F "$CREW" relink)"
check "a fork leaves the other session's link alone" test -f "$CREW_ROOT/.links/SID-X"
printf '{"type":"user","uuid":"X1","sessionId":"SID-X"}\n{"type":"user","uuid":"X2","sessionId":"SID-X"}\n{"type":"user","uuid":"P1","sessionId":"SID-P"}\n' >"$CREW_PROJECTS/-x/SID-P.jsonl"
printf '{"type":"user","uuid":"X1","sessionId":"SID-X"}\n{"type":"user","uuid":"X2","sessionId":"SID-X"}\n{"type":"user","uuid":"P2","sessionId":"SID-P2"}\n' >"$CREW_PROJECTS/-x/SID-P2.jsonl"
eq "a full copy adopts it" "relink: res-1 continues SID-X" "$(as res-1 SID-P "$CREW" relink)"
check "...and takes the link" test -f "$CREW_ROOT/.links/SID-P"
eq "a second full copy cannot claim the same session" "relink: res-2 has no earlier session id in its transcript" "$(as res-2 SID-P2 "$CREW" relink)"
rm -f "$CREW_ROOT/.links/SID-P"

# 4. repeated resumes: the middle life is further than 200 lines into the transcript
{ for i in $(seq 1 250); do printf '{"type":"user","uuid":"A%s","sessionId":"SID-RA"}\n' "$i"; done; } >"$CREW_PROJECTS/-x/SID-RA.jsonl"
{ cat "$CREW_PROJECTS/-x/SID-RA.jsonl"; printf '{"type":"user","uuid":"B1","sessionId":"SID-RB"}\n'; } >"$CREW_PROJECTS/-x/SID-RB.jsonl"
{ cat "$CREW_PROJECTS/-x/SID-RB.jsonl"; printf '{"type":"user","uuid":"C1","sessionId":"SID-RC"}\n'; } >"$CREW_PROJECTS/-x/SID-RC.jsonl"
printf 'sub_name=rsub\nparent_name=lead-new\nparent_sid=SID-A2\n' >"$CREW_ROOT/.links/SID-RB"
eq "relink finds both earlier lives (newest first)" "relink: res-3 continues SID-RB SID-RA" "$(as res-3 SID-RC "$CREW" relink)"
check "the link filed under the middle life moved" test -f "$CREW_ROOT/.links/SID-RC"
rm -f "$CREW_ROOT/.links/SID-RC"

# 5. a link that cannot be moved is an error, not a success with a marker; the next run retries
printf '{"type":"user","uuid":"Y1","sessionId":"SID-Y"}\n' >"$CREW_PROJECTS/-x/SID-Y.jsonl"
printf '{"type":"user","uuid":"Y1","sessionId":"SID-Y"}\n{"type":"user","uuid":"Y2","sessionId":"SID-Y2"}\n' >"$CREW_PROJECTS/-x/SID-Y2.jsonl"
printf 'sub_name=ysub\nparent_name=lead-new\nparent_sid=SID-A2\n' >"$CREW_ROOT/.links/SID-Y"
chmod 555 "$CREW_ROOT/.links"
out=$(as y-2 SID-Y2 "$CREW" relink; echo "rc=$?")
chmod 755 "$CREW_ROOT/.links"
eq "unmovable link: error, exit non-zero" "crew: relink: cannot update the links (will retry)
rc=2" "$out"
check "unmovable link: no marker" test ! -e "$CREW_ROOT/.relinked/SID-Y2"
check "unmovable link: old link kept" test -f "$CREW_ROOT/.links/SID-Y"
eq "retry succeeds" "relink: y-2 continues SID-Y" "$(as y-2 SID-Y2 "$CREW" relink)"
check "retry moved the link" test -f "$CREW_ROOT/.links/SID-Y2"

# 2. a name match is a display, never an ownership change: no read command rewrites lead_sid
live_sub reuse SID-REUSE
mkdir -p "$CREW_ROOT/1016-stale"; printf 'shape=scout\nlead=reuse\nlead_sid=SID-DEAD\n' >"$CREW_ROOT/1016-stale/meta"
printf '%s\treview\tready\n' "$CREW_NOW" >"$CREW_ROOT/1016-stale/status"; echo x >"$CREW_ROOT/1016-stale/intent.md"
"$CREW" ls --open >/dev/null; "$CREW" digest --lead reuse --peek >/dev/null; "$CREW" ls --leads >/dev/null
eq "ls and digest leave lead_sid alone when only the name matches" "lead=reuse
lead_sid=SID-DEAD" "$(grep -E '^lead' "$CREW_ROOT/1016-stale/meta")"

# 3. meta writes are serialized per task and re-read under the lock: an explicit lead= wins over a refresh
mkdir -p "$CREW_ROOT/1016-race"; printf 'shape=scout\nlead=lead-new\nlead_sid=SID-A2\n' >"$CREW_ROOT/1016-race/meta"
printf '%s\trunning\tgo\n' "$CREW_NOW" >"$CREW_ROOT/1016-race/status"; echo x >"$CREW_ROOT/1016-race/intent.md"
lead_json lead-renamed SID-A2   # the session was renamed: ls wants to refresh lead= to lead-renamed
mkdir -p "$CREW_ROOT/.locks"; exec 8>"$CREW_ROOT/.locks/1016-race"; flock 8
"$CREW" ls >/dev/null &
LSP=$!
sleep 0.8
printf 'lead=somebody\nlead_sid=\n' >>"$CREW_ROOT/1016-race/meta"   # the explicit change lands while ls waits
flock -u 8; exec 8>&-
wait $LSP
eq "a refresh that lost the race to an explicit lead= does not overwrite it" "somebody" "$(grep '^lead=' "$CREW_ROOT/1016-race/meta" | tail -n 1 | cut -d= -f2)"
mkdir -p "$CREW_ROOT/.locks"; exec 8>"$CREW_ROOT/.locks/1016-race"; flock 8
"$CREW" meta 1016-race lead=held-up >"$T/m.out" 2>&1 &
MP=$!
sleep 0.6
check "...and its stale refresh was never written" test "$(grep -c '^lead=lead-renamed' "$CREW_ROOT/1016-race/meta")" = 0
check "crew meta waits while the task's lock is held" test "$(grep -c '^lead=held-up' "$CREW_ROOT/1016-race/meta")" = 0
flock -u 8; exec 8>&-
wait $MP
check "crew meta completes once the lock is free" grep -q '^lead=held-up' "$CREW_ROOT/1016-race/meta"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
