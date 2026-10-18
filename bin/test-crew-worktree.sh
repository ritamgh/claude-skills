#!/usr/bin/env bash
# Test: `crew worktree` (crew-worktree) makes a worktree + branch + port for a task and runs the repo's setup hook.
# Everything lives in a temp CREW_ROOT and a scratch git repo. Port expectations are literals: the start port of a
# task id is 20000 + cksum(id) % 12001 (wt-one 21092, wt-two 29671, wt-three 23871, hk-env 24051, hk-fail 30923;
# p647, p1612 and p2104 all start at 24145).
#   bash test-crew-worktree.sh
set -uo pipefail

BIN=$(dirname "$(readlink -f "$0")")
CREW=$BIN/crew
WT=$BIN/crew-worktree
T=$(mktemp -d)
LPID="" HPID=""
cleanup() { [ -z "$LPID" ] || kill "$LPID" 2>/dev/null; [ -z "$HPID" ] || kill -9 "$HPID" 2>/dev/null; chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$BIN:$PATH"   # this checkout's crew-notify, never an older installed one
mkdir -p "$CREW_SESSIONS" "$CREW_ROOT"
fails=0

check() { # description, then a command that must succeed
  local desc=$1; shift
  if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi
}
meta_of() { cat "$CREW_ROOT/$1/meta"; }
has_line() { grep -qxF "$2" <<<"$(meta_of "$1")"; }
count_lines() { [ "$(grep -c "^$2=" "$CREW_ROOT/$1/meta")" = "$3" ]; } # task, key, expected count
mk_task() { # id: a ship task on the scratch repo with a fixed id (crew new's ids carry the date)
  mkdir -p "$CREW_ROOT/$1"
  printf 'shape=ship\nrepo=%s\n' "${2:-$REPO}" >"$CREW_ROOT/$1/meta"
  printf '2026-10-17T00:00:00Z\tqueued\tcreated\n' >"$CREW_ROOT/$1/status"
}
run_wt() { # args -> $T/out (stdout), $T/err (stderr), $T/rc
  "$WT" "$@" >"$T/out" 2>"$T/err"; echo $? >"$T/rc"
}
rc_is() { [ "$(cat "$T/rc")" = "$1" ]; }
last_out_is() { [ "$(tail -n 1 "$T/out")" = "$1" ]; }
err_has() { grep -q -- "$1" "$T/err"; }
git_() { git -C "$REPO" -c user.name=t -c user.email=t@t "$@"; }

REPO=$T/repo
git init -q -b main "$REPO"
git_ commit -q --allow-empty -m base
git_ checkout -q -b feature
git_ commit -q --allow-empty -m feature-work
git_ checkout -q main
MAIN_SHA=$(git_ rev-parse main)
FEATURE_SHA=$(git_ rev-parse feature)

# (a) first run: worktree, branch, meta, last stdout line is the path
mk_task wt-one
run_wt wt-one
check "(a) exit 0" rc_is 0
check "(a) last stdout line is the worktree path" last_out_is "$REPO/.claude/worktrees/crew-wt-one"
check "(a) the worktree is a checkout of main's commit on crew/wt-one" \
  test "$(git -C "$REPO/.claude/worktrees/crew-wt-one" rev-parse HEAD):$(git -C "$REPO/.claude/worktrees/crew-wt-one" branch --show-current)" = "$MAIN_SHA:crew/wt-one"
check "(a) meta worktree=" has_line wt-one "worktree=$REPO/.claude/worktrees/crew-wt-one"
check "(a) meta branch=" has_line wt-one "branch=crew/wt-one"
check "(a) meta base=main (the repo's current branch)" has_line wt-one "base=main"
check "(a) meta port=21092 (hash start, nothing in the way)" has_line wt-one "port=21092"

# (b) rerun is idempotent: same path, no second worktree, no new meta lines
run_wt wt-one
check "(b) rerun exit 0" rc_is 0
check "(b) rerun prints the same path last" last_out_is "$REPO/.claude/worktrees/crew-wt-one"
check "(b) one worktree entry" test "$(git -C "$REPO" worktree list --porcelain | grep -c 'crew-wt-one$')" = 1
check "(b) one port= line" count_lines wt-one port 1
check "(b) one worktree= line" count_lines wt-one worktree 1
check "(b) still port=21092" has_line wt-one "port=21092"

# (c) --base and --branch
mk_task wt-two
run_wt wt-two --base feature --branch custom/two
check "(c) exit 0" rc_is 0
check "(c) worktree is on custom/two at feature's commit" \
  test "$(git -C "$REPO/.claude/worktrees/crew-wt-two" rev-parse HEAD):$(git -C "$REPO/.claude/worktrees/crew-wt-two" branch --show-current)" = "$FEATURE_SHA:custom/two"
check "(c) meta branch=custom/two" has_line wt-two "branch=custom/two"
check "(c) meta base=feature" has_line wt-two "base=feature"
check "(c) meta port=29671" has_line wt-two "port=29671"
run_wt wt-two
check "(c) a rerun without flags keeps the recorded branch (exit 0, one worktree)" \
  bash -c 'rc=$(cat "$1"); [ "$rc" = 0 ] && [ "$(git -C "$2" worktree list --porcelain | grep -c "crew-wt-two$")" = 1 ]' _ "$T/rc" "$REPO"

# (d) refusals: exit 2
run_wt no-such-task
check "(d) unknown task: exit 2" rc_is 2
mk_task wt-norepo ""
printf 'shape=ship\n' >"$CREW_ROOT/wt-norepo/meta"
run_wt wt-norepo
check "(d) task without repo=: exit 2" rc_is 2
mk_task wt-badbase
run_wt wt-badbase --base no-such-ref
check "(d) base that is not a commit: exit 2, no worktree" bash -c 'rc=$(cat "$1"); [ "$rc" = 2 ] && [ ! -e "$2/.claude/worktrees/crew-wt-badbase" ]' _ "$T/rc" "$REPO"
run_wt wt-badbase --bogus
check "(d) unknown flag: exit 2" rc_is 2
mk_task wt-foreign
mkdir -p "$REPO/.claude/worktrees/crew-wt-foreign"
printf 'mine\n' >"$REPO/.claude/worktrees/crew-wt-foreign/keep.txt"
run_wt wt-foreign
check "(d) path that is not this task's worktree: exit 2, contents untouched" \
  bash -c 'rc=$(cat "$1"); [ "$rc" = 2 ] && [ "$(cat "$2/.claude/worktrees/crew-wt-foreign/keep.txt")" = mine ]' _ "$T/rc" "$REPO"

# (e) ports: distinct across live tasks, reused once the holder is done
mk_task p647; mk_task p1612; mk_task p2104
run_wt p647
check "(e) first task gets its start port 24145" has_line p647 "port=24145"
run_wt p1612
check "(e) second live task with the same start gets 24146" has_line p1612 "port=24146"
"$CREW" log p647 done "finished"
run_wt p2104
check "(e) once the holder is done its port is free again (24145)" has_line p2104 "port=24145"

# (f) a port something listens on is skipped
mk_task wt-three
python3 -I -c '
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 23871)); s.listen(); open(sys.argv[1], "w").write("up"); time.sleep(60)' "$T/listener-up" &
LPID=$!
for _ in $(seq 100); do [ -e "$T/listener-up" ] && break; sleep 0.05; done
run_wt wt-three
kill "$LPID" 2>/dev/null; wait "$LPID" 2>/dev/null; LPID=""
check "(f) port 23871 is taken by a listener: wt-three gets 23872" has_line wt-three "port=23872"
# the task's dev server now listens on its own port: a rerun must keep that port, not move on to 23873
python3 -I -c '
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 23872)); s.listen(); open(sys.argv[1], "w").write("up"); time.sleep(60)' "$T/listener2-up" &
LPID=$!
for _ in $(seq 100); do [ -e "$T/listener2-up" ] && break; sleep 0.05; done
run_wt wt-three
kill "$LPID" 2>/dev/null; wait "$LPID" 2>/dev/null; LPID=""
check "(f) a rerun keeps the recorded port while the task's own server listens on it" bash -c 'rc=$(cat "$1"); [ "$rc" = 0 ] && tail -n 1 "$2/wt-three/meta" | grep -qx "port=23872" && [ "$(grep -c "^port=" "$2/wt-three/meta")" = 1 ]' _ "$T/rc" "$CREW_ROOT"

# (g) setup hook: cwd, argv, env
mkdir -p "$REPO/.crew"
cat >"$REPO/.crew/setup" <<'SH'
#!/usr/bin/env bash
{
  echo "cwd=$(pwd -P)"
  echo "argc=$#"
  echo "argv0=$0"
  echo "task=$CREW_TASK"
  echo "worktree=$CREW_WORKTREE"
  echo "repo=$CREW_REPO"
  echo "port=$CREW_PORT"
  echo run
} >>"$HOOK_OUT"
echo "hook stdout noise"
SH
chmod +x "$REPO/.crew/setup"
export HOOK_OUT=$T/hook.out
mk_task hk-env
run_wt hk-env
check "(g) exit 0" rc_is 0
check "(g) the hook ran in the worktree" grep -qxF "cwd=$REPO/.claude/worktrees/crew-hk-env" "$HOOK_OUT"
check "(g) argv is just the hook path" bash -c 'grep -qxF "argc=0" "$0" && grep -qxF "argv0=$1/.crew/setup" "$0"' "$HOOK_OUT" "$REPO"
check "(g) CREW_TASK, CREW_WORKTREE, CREW_REPO, CREW_PORT" \
  bash -c 'grep -qxF "task=hk-env" "$0" && grep -qxF "worktree=$1/.claude/worktrees/crew-hk-env" "$0" && grep -qxF "repo=$1" "$0" && grep -qxF "port=24051" "$0"' "$HOOK_OUT" "$REPO"
check "(g) the hook's stdout does not reach crew's stdout (path is the only line)" test "$(wc -l <"$T/out")" = 1
check "(g) a rerun does not run a hook that succeeded" bash -c 'run_before=$(grep -c "^run$" "$1"); "$2" hk-env >/dev/null 2>&1; [ "$(grep -c "^run$" "$1")" = "$run_before" ]' _ "$HOOK_OUT" "$WT"

# (h) hook failure: exit 4, worktree kept, path still printed; a rerun retries the hook
cat >"$REPO/.crew/setup" <<'SH'
#!/usr/bin/env bash
echo "boom" >&2
echo "attempt" >>"$HOOK_OUT"
[ -e "$HOOK_PASS" ] || exit 7
SH
export HOOK_PASS=$T/hook-pass HOOK_OUT=$T/hook2.out
mk_task hk-fail
run_wt hk-fail
check "(h) failing hook: exit 4" rc_is 4
check "(h) the worktree is kept" test -d "$REPO/.claude/worktrees/crew-hk-fail/.git" -o -f "$REPO/.claude/worktrees/crew-hk-fail/.git"
check "(h) the path is still the last stdout line" last_out_is "$REPO/.claude/worktrees/crew-hk-fail"
check "(h) stderr names the exit code" err_has "exit 7"
check "(h) meta was recorded (port=30923)" has_line hk-fail "port=30923"
run_wt hk-fail
check "(h) rerun retries the failed hook (exit 4 again, 2 attempts)" bash -c 'rc=$(cat "$1"); [ "$rc" = 4 ] && [ "$(grep -c attempt "$2")" = 2 ]' _ "$T/rc" "$HOOK_OUT"
: >"$HOOK_PASS"
run_wt hk-fail
check "(h) once the hook passes the rerun exits 0" rc_is 0
run_wt hk-fail
check "(h) and a further rerun does not run it again (3 attempts)" test "$(grep -c attempt "$HOOK_OUT")" = 3

# (i) hook timeout
cat >"$REPO/.crew/setup" <<'SH'
#!/usr/bin/env bash
exec sleep 30
SH
mk_task hk-slow
start=$SECONDS
CREW_SETUP_TIMEOUT=1 run_wt hk-slow
check "(i) timeout: exit 4 well before the hook would end" bash -c 'rc=$(cat "$1"); [ "$rc" = 4 ] && [ "$2" -lt 10 ]' _ "$T/rc" "$((SECONDS - start))"
check "(i) stderr says it timed out" err_has "timed out after 1s"
check "(i) the worktree is kept" test -e "$REPO/.claude/worktrees/crew-hk-slow/.git"

# (j) a present but non-executable hook is skipped with a warning
printf '#!/usr/bin/env bash\necho ran >>"$HOOK_OUT"\n' >"$REPO/.crew/setup"
chmod 644 "$REPO/.crew/setup"
: >"$T/hook3.out"; export HOOK_OUT=$T/hook3.out
mk_task hk-noexec
run_wt hk-noexec
check "(j) exit 0" rc_is 0
check "(j) warns that the hook is not executable" err_has "not executable"
check "(j) the hook did not run" test ! -s "$T/hook3.out"
check "(j) the worktree exists" test -e "$REPO/.claude/worktrees/crew-hk-noexec/.git"

# (k) no hook at all, and the `crew worktree` dispatch
rm -rf "$REPO/.crew"
mk_task wt-dispatch
out=$("$CREW" worktree wt-dispatch 2>/dev/null); rc=$?
check "(k) crew worktree ID: exit 0 and the path on stdout" test "$rc:$out" = "0:$REPO/.claude/worktrees/crew-wt-dispatch"
check "(k) crew usage lists worktree" bash -c '"$0" help | grep -q "crew worktree ID"' "$CREW"

# (l) repo= through a symlink or with a trailing slash: the rerun is still idempotent, no `//` in the recorded path
ln -s "$REPO" "$T/repolink"
mk_task wt-link "$T/repolink"
run_wt wt-link
check "(l) symlinked repo=: first run exit 0" rc_is 0
run_wt wt-link
check "(l) symlinked repo=: rerun exit 0 (the path is canonical, not the raw repo= text)" rc_is 0
check "(l) symlinked repo=: one worktree= line" count_lines wt-link worktree 1
mk_task wt-slash "$REPO/"
run_wt wt-slash
check "(l) trailing-slash repo=: first run exit 0" rc_is 0
run_wt wt-slash
check "(l) trailing-slash repo=: rerun exit 0" rc_is 0
check "(l) trailing-slash repo=: no // in the recorded worktree=" bash -c '! grep "^worktree=.*//" "$1/wt-slash/meta"' _ "$CREW_ROOT"
check "(l) trailing-slash repo=: the path printed has no //" bash -c '! tail -n 1 "$1" | grep -q "//"' _ "$T/out"

# (m) a setup hook that ignores TERM is killed after the grace period: exit 4, the hook process is gone
mkdir -p "$REPO/.crew"
cat >"$REPO/.crew/setup" <<'SH'
#!/usr/bin/env bash
trap "" TERM
echo $$ >"$HOOK_PID"
while :; do sleep 1; done
SH
chmod +x "$REPO/.crew/setup"
export HOOK_PID=$T/hook.pid
mk_task hk-stubborn
start=$SECONDS
CREW_SETUP_TIMEOUT=1 timeout 15 "$WT" hk-stubborn >"$T/out" 2>"$T/err"; echo $? >"$T/rc"
elapsed=$((SECONDS - start))
HPID=$(cat "$HOOK_PID" 2>/dev/null || true)
check "(m) TERM-ignoring hook: exit 4 (not stuck until the outer timeout)" rc_is 4
check "(m) stderr says it timed out" err_has "timed out after 1s"
check "(m) the hook process is gone" bash -c '[ -n "$1" ] && ! kill -0 "$1" 2>/dev/null' _ "$HPID"
check "(m) the worktree is kept and the path is the last stdout line" last_out_is "$REPO/.claude/worktrees/crew-hk-stubborn"
rm -rf "$REPO/.crew"

# (n) a task whose id equals the port lock's old file name does not deadlock on crew meta's per-task lock
mk_task worktree-port
timeout 20 "$CREW" worktree worktree-port >"$T/out" 2>"$T/err"; echo $? >"$T/rc"
check "(n) task id worktree-port: exit 0 (no lock collision)" rc_is 0
check "(n) task id worktree-port: meta has a port=" grep -q '^port=' "$CREW_ROOT/worktree-port/meta"

# (o) an existing crew/<ID> branch is reattached: --base is ignored with a warning and never recorded as the branch's origin
mk_task wt-reatt
run_wt wt-reatt --base feature
git_ worktree remove --force "$REPO/.claude/worktrees/crew-wt-reatt"
run_wt wt-reatt --base main
check "(o) reattach with --base: exit 0" rc_is 0
check "(o) reattach: the worktree is on the old branch tip (feature's commit)" \
  test "$(git -C "$REPO/.claude/worktrees/crew-wt-reatt" rev-parse HEAD)" = "$FEATURE_SHA"
check "(o) reattach: stderr warns that --base is ignored" err_has "base.*ignored"
check "(o) reattach: the recorded base=feature is kept, not overwritten with main" bash -c '[ "$(grep -c "^base=" "$1/wt-reatt/meta")" = 1 ] && grep -qx "base=feature" "$1/wt-reatt/meta"' _ "$CREW_ROOT"
# a branch made by hand has no known origin: no base= is recorded at all, even with --base
git_ branch crew/wt-hand feature
mk_task wt-hand
run_wt wt-hand --base main
check "(o) hand-made branch with --base: exit 0, warning, no base= recorded" bash -c 'rc=$(cat "$1"); [ "$rc" = 0 ] && grep -q "base.*ignored" "$2" && ! grep -q "^base=" "$3/wt-hand/meta"' _ "$T/rc" "$T/err" "$CREW_ROOT"
# a rerun of a live worktree with --base does not rewrite base= either
run_wt wt-reatt --base main
check "(o) rerun with --base on a live worktree keeps base=feature" bash -c '[ "$(grep -c "^base=" "$1/wt-reatt/meta")" = 1 ] && grep -qx "base=feature" "$1/wt-reatt/meta"' _ "$CREW_ROOT"

# (p) two tasks with the same start port (20033) run at the same time get two different ports
mk_task cc1255; mk_task cc2664
"$WT" cc1255 >/dev/null 2>&1 & PA=$!
"$WT" cc2664 >/dev/null 2>&1 & PB=$!
wait "$PA"; wait "$PB"
check "(p) concurrent runs: the two tasks hold ports 20033 and 20034, one each" \
  bash -c 'a=$(grep "^port=" "$1/cc1255/meta"); b=$(grep "^port=" "$1/cc2664/meta"); [ "$a" != "$b" ] && [ "$(printf "%s\n%s\n" "$a" "$b" | sort | tr "\n" " ")" = "port=20033 port=20034 " ]' _ "$CREW_ROOT"

# (q) a repo path with a literal backslash-t: the rerun check matches it as text (awk -v would turn \t into a tab)
BS=$T/re\\tpo
git init -q -b main "$BS"
git -C "$BS" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
mk_task wt-bs "$BS"
run_wt wt-bs
check "(q) backslash-t repo: first run exit 0" rc_is 0
run_wt wt-bs
check "(q) backslash-t repo: rerun exit 0" rc_is 0
check "(q) backslash-t repo: one worktree= line" count_lines wt-bs worktree 1

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
