#!/usr/bin/env bash
# Test: `crew new` records the owning Claude session as lead=/lead_pid= in meta.
# Fake sessions live in a temp CREW_SESSIONS; CREW_LEAD_COMM stands in for the "claude" process name.
#   bash test-crew-lead.sh
set -uo pipefail

CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
trap 'chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"' EXIT
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
mkdir -p "$CREW_SESSIONS"
fails=0

check() { # description, then a command that must succeed
  local desc=$1; shift
  if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi
}
meta_of() { cat "$CREW_ROOT/$1/meta"; }
new_task() { # slug -> id on stdout; stderr and exit status go to $T/err and $T/rc
  local out
  out=$("$CREW" new "$1" --shape scout "intent of $1" 2>"$T/err"); echo $? >"$T/rc"
  sed -n 's/^id=//p' <<<"$out"
}
rc_is() { [ "$(cat "$T/rc")" = "$1" ]; }
has_line() { grep -qxF "$2" <<<"$(meta_of "$1")"; }
lacks_key() { ! grep -q "^$2=" <<<"$(meta_of "$1")"; }

MYCOMM=$(cat /proc/$$/comm)
printf '{"pid":%s,"name":"fake-lead","cwd":"/x","status":"idle"}\n' "$$" >"$CREW_SESSIONS/aaa.json"

# (a) a session json whose pid is an ancestor of crew and whose comm matches
export CREW_LEAD_COMM=$MYCOMM
id=$(new_task zz-test-a)
check "(a) exit 0" rc_is 0
check "(a) meta has lead=fake-lead" has_line "$id" "lead=fake-lead"
check "(a) meta has lead_pid=$$" has_line "$id" "lead_pid=$$"
check "(a) show prints the lead" grep -q "lead=fake-lead" <<<"$("$CREW" show "$id")"

# crew meta ID lead=<name> overrides it (last one wins)
"$CREW" meta "$id" lead=other-lead
check "(a) meta override: show prints only the new lead" \
  bash -c '"$0" show "$1" | grep -q "lead=other-lead" && ! "$0" show "$1" | grep -q "lead=fake-lead"' "$CREW" "$id"

# (b) comm differs (the pid is an ancestor but not a claude process): no lead lines, exit 0
export CREW_LEAD_COMM=claude-not-this-one
id=$(new_task zz-test-b1)
check "(b) comm mismatch: exit 0" rc_is 0
check "(b) comm mismatch: no lead" lacks_key "$id" lead
check "(b) comm mismatch: no lead_pid" lacks_key "$id" lead_pid

# (b) pid is not an ancestor: no lead lines, exit 0
export CREW_LEAD_COMM=$MYCOMM
printf '{"pid":%s,"name":"fake-lead","cwd":"/x"}\n' 2000000000 >"$CREW_SESSIONS/aaa.json"
id=$(new_task zz-test-b2)
check "(b) not an ancestor: exit 0" rc_is 0
check "(b) not an ancestor: no lead" lacks_key "$id" lead
check "(b) not an ancestor: no lead_pid" lacks_key "$id" lead_pid

# (b) no sessions dir at all
rm -rf "$CREW_SESSIONS"
id=$(new_task zz-test-b3)
check "(b) no sessions dir: exit 0" rc_is 0
check "(b) no sessions dir: no lead" lacks_key "$id" lead

# (c) a *.key secret is never read: unreadable, must not error or leak
mkdir -p "$CREW_SESSIONS"
printf '{"pid":%s,"name":"fake-lead"}\n' "$$" >"$CREW_SESSIONS/aaa.json"
printf 'SECRET-TOKEN\n' >"$CREW_SESSIONS/aaa.key"
chmod 000 "$CREW_SESSIONS/aaa.key"
id=$(new_task zz-test-c)
check "(c) key file present: exit 0" rc_is 0
check "(c) key file present: nothing on stderr" test ! -s "$T/err"
check "(c) key file present: lead still recorded" has_line "$id" "lead=fake-lead"
check "(c) key file present: secret not in meta" bash -c '! grep -rq SECRET-TOKEN "$0"' "$CREW_ROOT"

# (d) a background session (run by the claude daemon) runs the versioned binary, so its comm is "2.1.301":
# it is still the lead. d.sh runs under a bash named 2.1.301 and writes its own pid into the session json.
ln -s "$(command -v bash)" "$T/2.1.301"
cat >"$T/d.sh" <<'SH'
printf '{"pid":%s,"name":"bg-lead","cwd":"/x","status":"idle","kind":"bg"}\n' "$$" >"$CREW_SESSIONS/aaa.json"
"$CREW" new zz-test-d --shape scout "intent of zz-test-d" | sed -n 's/^id=//p'
SH
mkdir -p "$CREW_SESSIONS"
export CREW_LEAD_COMM=claude CREW
id=$("$T/2.1.301" "$T/d.sh")
check "(d) bg session (versioned comm): lead recorded" has_line "$id" "lead=bg-lead"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
