#!/usr/bin/env bash
# Test: `crew summary` (the user-facing result saved per task), its place in `crew show`, and the
# `→ crew show <id>` tail of the digest's "Needs you" lines. Runs in a temp crew root.
#   bash test-crew-summary.sh
set -uo pipefail

CREW=$(dirname "$(readlink -f "$0")")/crew
T=$(mktemp -d)
trap 'chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"' EXIT
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
mkdir -p "$CREW_SESSIONS"
fails=0

check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
same() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }
fails_with() { "$@" >/dev/null 2>&1; [ $? = 2 ]; }

id=$("$CREW" new graph-bake --shape scout "compare graphify and understand" | sed -n 's/^id=//p')
"$CREW" log "$id" done "graphify wins"
S=$CREW_ROOT/$id/summary.md

# --- write ---
"$CREW" summary "$id" "**Graphify wins: 0 tokens.**
Details on the second line." >/dev/null
same "summary with a text argument writes summary.md" "**Graphify wins: 0 tokens.**
Details on the second line." "$(cat "$S")"

printf '%s\n' "**Replaced verdict.**" "Body line." | "$CREW" summary "$id" - >/dev/null
same "summary - reads stdin and replaces the old text" "**Replaced verdict.**
Body line." "$(cat "$S")"
check "no temp file is left behind" bash -c '[ -z "$(ls -A "$0"/ | grep -F summary.md.)" ]' "$CREW_ROOT/$id"

check "an empty summary is refused" fails_with "$CREW" summary "$id" ""
check "an empty stdin is refused" bash -c 'printf "" | "$0" summary "$1" - >/dev/null 2>&1; [ $? = 2 ]' "$CREW" "$id"
same "a refused summary leaves the old text" "**Replaced verdict.**
Body line." "$(cat "$S")"
check "an unknown task is refused" fails_with "$CREW" summary no-such-task "text"
check "no text is refused" fails_with "$CREW" summary "$id"

check "an id with .. is refused and writes nothing outside the crew root" bash -c 'mkdir "$1/../outside"; "$0" summary ../outside x >/dev/null 2>&1; rc=$?; [ $rc = 2 ] && [ ! -e "$1/../outside/summary.md" ]' "$CREW" "$CREW_ROOT"
check "an id with a slash is refused" fails_with "$CREW" summary "$id/../$id" x
check "show refuses an id with .." fails_with "$CREW" show ../outside
# a folder that cannot take the temp file: the old summary stays and the command fails
chmod a-w "$CREW_ROOT/$id"
if [ -w "$CREW_ROOT/$id" ]; then echo "skip unwritable-dir checks (running as a user that ignores modes)"; else
  out=$("$CREW" summary "$id" "new text" 2>&1); rc=$?
  same "a failed write exits 2" "2" "$rc"
  check "a failed write does not say saved" bash -c '! grep -q "^saved" <<<"$0"' "$out"
  same "a failed write keeps the old summary" "**Replaced verdict.**
Body line." "$(cat "$S")"
fi
chmod u+w "$CREW_ROOT/$id"

# --- show ---
first=$("$CREW" show "$id" | sed -n 1p)
same "show prints the summary first" "**Replaced verdict.**" "$first"
check "show prints the whole summary" bash -c '"$0" show "$1" | sed -n 2p | grep -qxF "Body line."' "$CREW" "$id"
check "show still prints the fields after it" bash -c '"$0" show "$1" | grep -q "^== $1 (done)"' "$CREW" "$id"

rid=$("$CREW" new no-summary --shape scout "x" | sed -n 's/^id=//p')
printf 'full report\n' >"$CREW_ROOT/$rid/report.md"
check "without a summary show starts with the header" bash -c '"$0" show "$1" | sed -n 1p | grep -q "^== $1 "' "$CREW" "$rid"
check "without a summary show still lists report.md" bash -c '"$0" show "$1" | grep -q "^report.md: "' "$CREW" "$rid"

hid=$("$CREW" new asked --shape scout "x" | sed -n 's/^id=//p')
"$CREW" meta "$hid" lead=lead-a
"$CREW" summary "$hid" "Held verdict." >/dev/null
did=$("$CREW" hold "$hid" "Which DB?")
same "show D<n> prints that task's summary first" "Held verdict." "$("$CREW" show "$did" | sed -n 1p)"

# --- digest: Needs you ends with the command that shows the task ---
export CREW_NOW=2026-10-16T10:00:00Z
same "a Needs-you line ends with → crew show <id>" "Needs you
  $did  asked — Which DB? → crew show $hid" "$("$CREW" digest --lead lead-a --peek | sed -n '/^Needs you/,$p')"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
