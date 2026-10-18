#!/usr/bin/env bash
# Test: `crew check` (crew-check) runs a task's .crew/check and records the verdict; `crew log ID review` and
# `crew show` surface it. Everything lives in a temp CREW_ROOT and scratch folders; check scripts are tiny fixtures.
#   bash test-crew-check.sh
set -uo pipefail

BIN=$(dirname "$(readlink -f "$0")")
CREW=$BIN/crew
T=$(mktemp -d)
cleanup() { chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$BIN:$PATH"   # this checkout's crew-notify, never an older installed one
unset CREW_CHECK_TIMEOUT
mkdir -p "$CREW_SESSIONS" "$CREW_ROOT"
fails=0

check() { # description, then a command that must succeed
  local desc=$1; shift
  if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi
}
meta_last() { grep -E "^$2=" "$CREW_ROOT/$1/meta" | tail -n 1 | cut -d= -f2-; } # task key -> its last value
mk_task() { # id repo [extra meta line]
  mkdir -p "$CREW_ROOT/$1"
  printf 'shape=ship\nrepo=%s\n' "$2" >"$CREW_ROOT/$1/meta"
  [ -z "${3:-}" ] || printf '%s\n' "$3" >>"$CREW_ROOT/$1/meta"
  printf '2026-10-17T00:00:00Z\trunning\tcreated\n' >"$CREW_ROOT/$1/status"
}
mk_check() { # dir, script body: an executable <dir>/.crew/check
  mkdir -p "$1/.crew"
  printf '#!/usr/bin/env bash\n%s\n' "$2" >"$1/.crew/check"
  chmod +x "$1/.crew/check"
}
run_check() { # args -> $T/out (stdout), $T/err (stderr), $T/rc
  "$CREW" check "$@" >"$T/out" 2>"$T/err" </dev/null; echo $? >"$T/rc"
}
rc_is() { [ "$(cat "$T/rc")" = "$1" ]; }
out_matches() { grep -Eq -- "$1" "$T/out" && [ "$(wc -l <"$T/out")" = 1 ]; } # exactly one line, matching
err_has() { grep -q -- "$1" "$T/err"; }
log_is() { [ "$(cat "$CREW_ROOT/$1/check.log")" = "$2" ]; }
last_status() { tail -n 1 "$CREW_ROOT/$1/status" | cut -f"$2"; }

# (a) pass
REPO_A=$T/repo-a; mkdir -p "$REPO_A"
mk_check "$REPO_A" 'echo building; echo tests green'
mk_task ck-pass "$REPO_A"
run_check ck-pass
check "(a) pass: exit 0" rc_is 0
check "(a) pass: one line 'check: pass (N.Ns)'" out_matches '^check: pass \([0-9]+\.[0-9]s\)$'
check "(a) pass: meta check=pass" test "$(meta_last ck-pass check)" = pass
check "(a) pass: meta check_at is an iso8601 UTC time" \
  test "$(meta_last ck-pass check_at | grep -cE '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$')" = 1
check "(a) pass: check.log holds the output" log_is ck-pass $'building\ntests green'

# (b) fail: the script's own exit code is reported; stderr lands in the log too
REPO_B=$T/repo-b; mkdir -p "$REPO_B"
mk_check "$REPO_B" 'echo out-line; echo err-line >&2; exit 3'
mk_task ck-fail "$REPO_B"
run_check ck-fail
check "(b) fail: exit 1" rc_is 1
check "(b) fail: one line 'check: fail (exit 3, N.Ns)'" out_matches '^check: fail \(exit 3, [0-9]+\.[0-9]s\)$'
check "(b) fail: meta check=fail" test "$(meta_last ck-fail check)" = fail
check "(b) fail: check.log has stdout and stderr" log_is ck-fail $'out-line\nerr-line'

# (c) a rerun overwrites: the verdict flips to pass, the log is replaced, the last meta value wins
mk_check "$REPO_B" 'echo fixed'
run_check ck-fail
check "(c) rerun: exit 0" rc_is 0
check "(c) rerun: meta check=pass now" test "$(meta_last ck-fail check)" = pass
check "(c) rerun: check.log replaced" log_is ck-fail fixed

# (d) timeout: CREW_CHECK_TIMEOUT=1 stops a hanging check well before its own 30 s
REPO_D=$T/repo-d; mkdir -p "$REPO_D"
mk_check "$REPO_D" 'echo started; exec sleep 30'
mk_task ck-slow "$REPO_D"
t0=$SECONDS
CREW_CHECK_TIMEOUT=1 run_check ck-slow
check "(d) timeout: exit 1" rc_is 1
check "(d) timeout: one line 'check: timeout (1s)'" out_matches '^check: timeout \(1s\)$'
check "(d) timeout: meta check=timeout" test "$(meta_last ck-slow check)" = timeout
check "(d) timeout: returned within 10 s" test $((SECONDS - t0)) -lt 10
check "(d) timeout: output before the stop is kept" log_is ck-slow started

# (e) none: no script, and a script that is not executable
REPO_E=$T/repo-e; mkdir -p "$REPO_E"
mk_task ck-none "$REPO_E"
run_check ck-none
check "(e) none: exit 3" rc_is 3
check "(e) none: one line 'check: none (no .crew/check)'" out_matches '^check: none \(no \.crew/check\)$'
check "(e) none: meta check=none" test "$(meta_last ck-none check)" = none
check "(e) none: meta check_at set" test -n "$(meta_last ck-none check_at)"
mkdir -p "$REPO_E/.crew"; printf '#!/bin/sh\nexit 0\n' >"$REPO_E/.crew/check"
run_check ck-none
check "(e) not executable: exit 3, not run" rc_is 3
check "(e) not executable: says so" out_matches '^check: none \(.*not executable'

# (f) where it runs: the worktree when meta worktree= is set, else the repo; env incl. CREW_PORT
REPO_F=$T/repo-f; WT_F=$T/wt-f; mkdir -p "$REPO_F" "$WT_F"
mk_check "$REPO_F" 'echo "repo-script cwd=$PWD"'
mk_check "$WT_F" 'echo "wt-script cwd=$PWD"; echo "task=$CREW_TASK wt=$CREW_WORKTREE repo=$CREW_REPO port=$CREW_PORT"'
mk_task ck-wt "$REPO_F" "worktree=$WT_F"
printf 'port=24051\n' >>"$CREW_ROOT/ck-wt/meta"
run_check ck-wt
check "(f) worktree set: exit 0" rc_is 0
check "(f) worktree set: the worktree's script ran in the worktree, env filled" \
  log_is ck-wt "wt-script cwd=$WT_F"$'\n'"task=ck-wt wt=$WT_F repo=$REPO_F port=24051"
mk_task ck-norepo-wt "$REPO_F"
run_check ck-norepo-wt
check "(f) no worktree=: the repo's script ran in the repo" log_is ck-norepo-wt "repo-script cwd=$REPO_F"

# (g) check.log keeps only the last 200 lines
REPO_G=$T/repo-g; mkdir -p "$REPO_G"
mk_check "$REPO_G" 'seq 1 500'
mk_task ck-long "$REPO_G"
run_check ck-long
check "(g) long output: 200 lines" test "$(wc -l <"$CREW_ROOT/ck-long/check.log")" = 200
check "(g) long output: lines 301..500" \
  test "$(head -n 1 "$CREW_ROOT/ck-long/check.log"):$(tail -n 1 "$CREW_ROOT/ck-long/check.log")" = 301:500
check "(g) no raw temp file left behind" test -z "$(ls "$CREW_ROOT/ck-long" | grep raw)"

# (h) usage errors: exit 2 and nothing recorded
run_check
check "(h) no id: exit 2" rc_is 2
run_check nosuchtask
check "(h) unknown task: exit 2" rc_is 2
mkdir -p "$CREW_ROOT/ck-norepo"; printf 'shape=ship\n' >"$CREW_ROOT/ck-norepo/meta"
run_check ck-norepo
check "(h) task without repo=/worktree=: exit 2" rc_is 2
check "(h) task without repo=/worktree=: says why" err_has "neither worktree= nor repo="
mk_task ck-gone "$REPO_F" "worktree=$T/not-there"
run_check ck-gone
check "(h) worktree folder missing: exit 2" rc_is 2
check "(h) nothing recorded for it" test -z "$(meta_last ck-gone check 2>/dev/null)"
run_check ck-pass extra
check "(h) two args: exit 2" rc_is 2

# (i) crew log: a review note gets [check: <value>]; other states, and tasks never checked, do not
"$CREW" log ck-pass review "ready to land" >/dev/null
check "(i) review note gets the suffix" test "$(last_status ck-pass 3)" = "ready to land [check: pass]"
check "(i) the state column is untouched" test "$(last_status ck-pass 2)" = review
"$CREW" log ck-pass running "back at it" >/dev/null
check "(i) running note has no suffix" test "$(last_status ck-pass 3)" = "back at it"
"$CREW" log ck-pass done "merged" >/dev/null
check "(i) done note has no suffix" test "$(last_status ck-pass 3)" = merged
"$CREW" log ck-pass review >/dev/null
check "(i) review without a note: just the suffix" test "$(last_status ck-pass 3)" = "[check: pass]"
"$CREW" log ck-slow review "needs a look" >/dev/null
check "(i) the recorded verdict is used (timeout)" test "$(last_status ck-slow 3)" = "needs a look [check: timeout]"
mk_task ck-never "$REPO_E"
"$CREW" log ck-never review "no check yet" >/dev/null
check "(i) never checked: note unchanged" test "$(last_status ck-never 3)" = "no check yet"

# (j) crew show: a check: line when set
"$CREW" show ck-fail >"$T/show" 2>&1
check "(j) show prints 'check: pass (<time>)'" \
  grep -Eq '^check: pass \(20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]+Z\)$' "$T/show"
"$CREW" show ck-never >"$T/show" 2>&1
check "(j) show has no check: line for a task never checked" test -z "$(grep -E '^check:' "$T/show")"

echo
if [ "$fails" = 0 ]; then echo "all passed"; else echo "$fails failed"; exit 1; fi
