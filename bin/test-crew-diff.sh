#!/usr/bin/env bash
# Test: `crew diff ID [--focus] [--print]` (bin/crew-diff). Everything runs against a temp CREW_ROOT, a scratch git repo
# and an isolated tmux server (TMUX_TMPDIR); the lead's Claude session is faked with CREW_TMUX_MAP. The nvim that
# crew-diff starts in a pane is a wrapper that records its argv and then runs a real headless nvim with a stub
# DiffviewOpen, so the reuse path (nvim --server SOCK --remote-expr) talks to a real nvim. The last part uses the real
# diffview.nvim when it is installed.
#   bash test-crew-diff.sh
set -uo pipefail

CREW=$(dirname "$(readlink -f "$0")")/crew
REAL_NVIM=$(command -v nvim || true)
T=$(mktemp -d)
unset TMUX TMUX_PANE
export CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions TMUX_TMPDIR=$T/tmux XDG_RUNTIME_DIR=$T/run XDG_DATA_HOME=$T/data
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$(dirname "$(readlink -f "$0")"):$PATH"   # this checkout's crew-notify, never an older installed one
export CREW_TMUX_MAP=$T/map-none
# the trap is installed only now: TMUX_TMPDIR is set, so the kill-server below can only reach this test's own server
cleanup() {
  tmux -S "$TMUX_TMPDIR/tmux-$(id -u)/default" kill-server >/dev/null 2>&1 || true   # the nvim in its panes get SIGHUP
  chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$CREW_SESSIONS" "$TMUX_TMPDIR" "$XDG_DATA_HOME/nvim/lazy/diffview.nvim"
mkdir -m 700 "$XDG_RUNTIME_DIR"
printf '#!/bin/sh\n' >"$T/map-none"; chmod +x "$T/map-none"
fails=0

check() { # description, then a command that must succeed
  local desc=$1; shift
  if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi
}
run_diff() { # args -> OUT (stdout), ERR (stderr), RC
  OUT=$("$CREW" diff "$@" 2>"$T/err"); RC=$?; ERR=$(cat "$T/err")
}
out_is() { [ "$OUT" = "$1" ]; }
rc_is() { [ "$RC" = "$1" ]; }
wait_for() { local i; for i in $(seq 100); do "$@" && return 0; sleep 0.1; done; return 1; }
sock_up() { [ -S "$1" ]; }
panes() { tmux list-panes -a -F '#{pane_id}' | tr '\n' ' '; }
active_pane() { tmux display-message -p -t t '#{pane_id}'; }
active_window() { tmux display-message -p -t t '#{window_name}'; }
remote() { nvim --server "$1" --remote-expr "$2"; }   # the fake nvim on PATH passes --server calls to the real one

git_quiet() { git -c user.email=a@b -c user.name=t "$@" >/dev/null 2>&1; }

# --- scratch repo: main + a worktree on crew/t1 with one commit ahead; a clone (origin/HEAD) and a master-only repo ---
R=$T/repo
git init -q -b main "$R"
echo a >"$R/f"; git_quiet -C "$R" add f; git_quiet -C "$R" commit -m init
git_quiet -C "$R" worktree add "$T/wt" -b crew/t1 main
echo b >>"$T/wt/f"; git_quiet -C "$T/wt" commit -am work
git_quiet -C "$R" worktree add "$T/my wt#1|x" -b crew/t2 main
echo c >>"$T/my wt#1|x/f"; git_quiet -C "$T/my wt#1|x" commit -am work2
git_quiet -C "$R" worktree add "$T/it's \"q\" \$x" -b crew/t3 main
git_quiet -C "$R" worktree add "$T/\$HOME ~/w t" -b crew/t4 main
echo e >>"$T/\$HOME ~/w t/f"; git_quiet -C "$T/\$HOME ~/w t" commit -am work4
echo d >>"$T/it's \"q\" \$x/f"; git_quiet -C "$T/it's \"q\" \$x" commit -am work3
git_quiet clone -q "$R" "$T/clone"
git_quiet -C "$T/clone" branch feature
git init -q -b master "$T/mrepo"
echo a >"$T/mrepo/f"; git_quiet -C "$T/mrepo" add f; git_quiet -C "$T/mrepo" commit -m init
git_quiet -C "$T/mrepo" branch feature

new_task() { # slug key=value... -> id
  local slug=$1 id; shift
  id=$("$CREW" new "$slug" --shape ship --repo "$R" "intent $slug" | sed -n 's/^id=//p')
  [ $# -eq 0 ] || "$CREW" meta "$id" "$@"
  echo "$id"
}

# (a) --print: worktree + branch task. Catches a wrong cwd (repo instead of worktree), range order or base.
A=$(new_task d-a "worktree=$T/wt" branch=crew/t1 base=main lead=fake-lead)
run_diff "$A" --print
check "(a) print: exit 0" rc_is 0
check "(a) print: plan" out_is "task: $A
cwd: $T/wt
ex: DiffviewOpen main...crew/t1
target: new window diff-$A
socket: $T/run/crew-diff-window-$A.sock"
check "(a) print has no side effects: no .diff dir, no socket dir content" bash -c '[ ! -e "$1/.diff" ] && [ -z "$(ls "$2")" ]' _ "$CREW_ROOT" "$XDG_RUNTIME_DIR"

# (b) in-place task (no branch=): uncommitted changes of the repo
B=$(new_task d-b)
run_diff "$B" --print
check "(b) in-place: ex has no range, cwd is the repo" bash -c '[[ "$1" == *"cwd: $2"$'"'"'\n'"'"'"ex: DiffviewOpen"$'"'"'\n'"'"'* ]]' _ "$OUT" "$R"

# (c) base fallbacks: meta base= that is gone -> origin/HEAD target -> main -> master
C=$(new_task d-c "worktree=$T/wt" branch=crew/t1 base=gone-branch)
run_diff "$C" --print
check "(c) base missing: falls back to main" bash -c '[[ "$1" == *"ex: DiffviewOpen main...crew/t1"* ]]' _ "$OUT"
C2=$(new_task d-c2 "worktree=$T/clone" branch=feature)
run_diff "$C2" --print
check "(c) clone: base is the origin/HEAD target" bash -c '[[ "$1" == *"ex: DiffviewOpen origin/main...feature"* ]]' _ "$OUT"
C3=$(new_task d-c3 "worktree=$T/mrepo" branch=feature)
run_diff "$C3" --print
check "(c) master-only repo: base is master" bash -c '[[ "$1" == *"ex: DiffviewOpen master...feature"* ]]' _ "$OUT"
C4=$(new_task d-c4 "worktree=$T/wt" branch=crew/t1 base=crew/t1~1)
run_diff "$C4" --print
check "(c) meta base= wins over the fallbacks" bash -c '[[ "$1" == *"ex: DiffviewOpen crew/t1~1...crew/t1"* ]]' _ "$OUT"

# (d) errors
run_diff no-such-task
check "(d) unknown task: exit 2" rc_is 2
check "(d) unknown task: says so" bash -c '[[ "$1" == *"no task '"'"'no-such-task'"'"'"* ]]' _ "$ERR"
run_diff
check "(d) no id: exit 2" rc_is 2
E=$(new_task d-e "worktree=$T/wt" branch=nope/none)
run_diff "$E" --print
check "(d) branch that does not exist: exit 2" rc_is 2
F=$("$CREW" new d-f --shape scout "no repo" | sed -n 's/^id=//p')
run_diff "$F" --print
check "(d) task without worktree or repo: exit 2 (nothing to diff)" rc_is 2

# no tmux server reachable (nothing listens in TMUX_TMPDIR yet, TMUX unset): exit 3, nothing created
export CREW_DIFF_SKIP_PLUGIN_CHECK=1
run_diff "$A"
check "(d) no tmux: exit 3" rc_is 3
check "(d) no tmux: nothing was recorded" bash -c '[ ! -e "$1/.diff/window-$2" ]' _ "$CREW_ROOT" "$A"
unset CREW_DIFF_SKIP_PLUGIN_CHECK

# nvim or diffview.nvim missing: exit 4 with a hint (a PATH that has git etc. but no nvim and no tmux)
mkdir "$T/minbin"
for c in git grep tail cut sed awk wc readlink dirname id; do ln -s "$(command -v $c)" "$T/minbin/$c"; done
OUT=$(PATH=$T/minbin "$BASH" "$(dirname "$CREW")/crew-diff" "$A" 2>"$T/err"); RC=$?; ERR=$(cat "$T/err")
check "(d) nvim missing: exit 4" rc_is 4
check "(d) nvim missing: one-line hint" bash -c '[ "$1" = "crew diff: nvim is not installed" ]' _ "$ERR"
EMPTY_DATA=$T/nodata; mkdir "$EMPTY_DATA"
OUT=$(XDG_DATA_HOME=$EMPTY_DATA "$CREW" diff "$A" 2>"$T/err"); RC=$?; ERR=$(cat "$T/err")
check "(d) diffview.nvim missing: exit 4" rc_is 4
check "(d) diffview.nvim missing: hint names the plugin file" bash -c '[[ "$1" == *"plugins/diffview.lua"* ]]' _ "$ERR"

# --- an isolated tmux server with a fake lead pane; fake nvim on PATH ---
mkdir "$T/fakebin"
cat >"$T/fakebin/nvim" <<EOF
#!/usr/bin/env bash
{ printf 'cwd=%s\n' "\$PWD"; printf 'arg=%s\n' "\$@"; echo --; } >>"$T/nvim.log"
case " \$* " in
  *" --server "*) exec "$REAL_NVIM" "\$@" ;;
esac
mode=\$(cat "$T/nvim-mode" 2>/dev/null || true)   # test hook: die = exit at once, hang = never start nvim
[ "\$mode" != die ] || exit 1
[ "\$mode" != hang ] || exec sleep 60
exec "$REAL_NVIM" --headless --clean --cmd 'command! -nargs=* DiffviewOpen call writefile([getcwd() . "|" . <q-args>], "$T/stub.out", "a")' "\$@"
EOF
chmod +x "$T/fakebin/nvim"
export PATH=$T/fakebin:$PATH
export CREW_DIFF_SKIP_PLUGIN_CHECK=1
ORIG_PWD=$PWD
cd "$T"   # the tmux server starts here: a #(...) it wrongly runs would land in $T, not in the checkout
tmux new-session -d -s t -x 200 -y 50
printf '#!/bin/sh\nprintf "fake-lead\\tt:0.0\\tclaude\\t/x\\tidle\\t1\\t\\n"\n' >"$T/map-lead"; chmod +x "$T/map-lead"
export CREW_TMUX_MAP=$T/map-lead
check "(e) setup: the lead pane is %0, alone" bash -c '[ "$(tmux list-panes -a -F "#{pane_id}" | tr "\n" " ")" = "%0 " ]'

run_diff "$A" --print
check "(e) print with a live lead: target is a new pane right of it" bash -c '[[ "$1" == *"target: new pane right of lead fake-lead (%0)"* ]]' _ "$OUT"

# first call: a pane is split off the lead pane, to its right, without taking focus
run_diff "$A"
check "(e) create: exit 0" rc_is 0
check "(e) create: stdout" out_is "diff: opened $A (new pane %1)"
check "(e) create: the lead's window now has panes %0 and %1" bash -c '[ "$(tmux list-panes -t t:0 -F "#{pane_id}" | tr "\n" " ")" = "%0 %1 " ]'
check "(e) create: %1 is right of %0 at the same top" bash -c '[ "$(tmux display-message -p -t %0 "#{pane_left} #{pane_top}")" = "0 0" ] && [ "$(tmux display-message -p -t %1 "#{pane_left} #{pane_top}")" = "100 0" ]'
check "(e) create: focus stays on the lead pane" bash -c '[ "$(tmux display-message -p -t t "#{pane_id}")" = "%0" ]'
SOCK=$T/run/crew-diff-fake-lead.sock
check "(e) create: state file is pane<TAB>socket" bash -c '[ "$(cat "$1/.diff/fake-lead")" = "$(printf "%%1\t%s" "$2")" ]' _ "$CREW_ROOT" "$SOCK"
wait_for sock_up "$SOCK"
check "(e) create: nvim started with --listen, cwd of the worktree and the DiffviewOpen range as -c" bash -c '[ "$(cat "$1")" = "cwd=$2
arg=--listen
arg=$3
arg=-c
arg=DiffviewOpen main...crew/t1
--" ]' _ "$T/nvim.log" "$T/wt" "$SOCK"
check "(e) create: the socket dir is private" bash -c '[ "$(stat -c %a "$1")" = 700 ]' _ "$XDG_RUNTIME_DIR"

# second call: the same pane is reused through the nvim socket (remote-expr, not keys); DiffviewOpen runs in the task's dir
: >"$T/nvim.log"
run_diff "$A"
check "(e) reuse: stdout" out_is "diff: opened $A (reused pane %1)"
check "(e) reuse: no new pane" bash -c '[ "$(tmux list-panes -a -F "#{pane_id}" | tr "\n" " ")" = "%0 %1 " ]'
check "(e) reuse: nvim got the ex command through --server --remote-expr luaeval, no keys" bash -c '[ "$(sed -n 1p "$1")" = "cwd=$2" ] && [ "$(sed -n 2,4p "$1")" = "arg=--server
arg=$3
arg=--remote-expr" ] && [[ "$(sed -n 5p "$1")" == "arg=luaeval("* ]] && grep -qF "DiffviewOpen main...crew/t1" "$1" && grep -qF "$4/wt" "$1" && [ "$(tail -n 1 "$1")" = -- ]' _ "$T/nvim.log" "$PWD" "$SOCK" "$T"
check "(e) reuse: no leftover tab (1 tab), the user tab keeps its cwd" bash -c '[ "$(nvim --server "$1" --remote-expr "tabpagenr(\"\$\") . \"|\" . getcwd()")" = "1|$2" ]' _ "$SOCK" "$T/wt"
check "(e) reuse: DiffviewOpen ran twice (startup -c, then remote in the task dir) with the range" bash -c '[ "$(cat "$1")" = "$2|main...crew/t1
$2|main...crew/t1" ]' _ "$T/stub.out" "$T/wt"
check "(e) reuse: state file unchanged" bash -c '[ "$(cat "$1/.diff/fake-lead")" = "$(printf "%%1\t%s" "$2")" ]' _ "$CREW_ROOT" "$SOCK"

# another task of the same lead, in a folder with a space, # and |: same pane, and the folder travels as data
G=$(new_task d-g "worktree=$T/my wt#1|x" branch=crew/t2 base=main lead=fake-lead)
run_diff "$G"
check "(e) reuse with space, # and | in the dir: reused" out_is "diff: opened $G (reused pane %1)"
check "(e) reuse with space, # and | in the dir: DiffviewOpen ran with the whole path as cwd" bash -c '[ "$(tail -n 1 "$1")" = "$2|main...crew/t2" ]' _ "$T/stub.out" "$T/my wt#1|x"
check "(e) reuse with space, # and | in the dir: still 1 tab" bash -c '[ "$(nvim --server "$1" --remote-expr "tabpagenr(\"\$\")")" = 1 ]' _ "$SOCK"

# a dir with ' and " and $: reaches nvim as data, not as vimscript/lua
G2=$(new_task d-g2 "worktree=$T/it's \"q\" \$x" branch=crew/t3 base=main lead=fake-lead)
run_diff "$G2"
check "(e) reuse with ' \" and \$ in the dir: reused, DiffviewOpen ran with the whole path as cwd" bash -c '[ "$2" = "diff: opened $3 (reused pane %1)" ] && [ "$(tail -n 1 "$1")" = "$4|main...crew/t3" ]' _ "$T/stub.out" "$OUT" "$G2" "$T/it's \"q\" \$x"

# a dir with a literal $HOME and a space: nvim expands $VAR and ~ in ex command arguments, so the dir must travel as data
G3=$(new_task d-g3 "worktree=$T/\$HOME ~/w t" branch=crew/t4 base=main lead=fake-lead)
run_diff "$G3"
check "(e) reuse with a literal \$HOME and ~ in the dir: DiffviewOpen ran with the unexpanded path as cwd" bash -c '[ "$2" = "diff: opened $3 (reused pane %1)" ] && [ "$(tail -n 1 "$1")" = "$4|main...crew/t4" ]' _ "$T/stub.out" "$OUT" "$G3" "$T/\$HOME ~/w t"

# focus: --focus selects the pane, the default did not
run_diff "$A" --focus
check "(e) --focus on a reused pane: pane %1 is selected" bash -c '[ "$(tmux display-message -p -t t "#{pane_id}")" = "%1" ]'
tmux select-pane -t %0

# stale state: the pane is gone (even though an nvim still listens on the recorded socket), a fresh pane is made and recorded
tmux kill-pane -t %1
pane_gone() { ! tmux display-message -p -t "$1" >/dev/null 2>&1; }
wait_for pane_gone %1
"$REAL_NVIM" --headless --clean --listen "$T/orphan.sock" >/dev/null 2>&1 &
ORPHAN=$!
wait_for sock_up "$T/orphan.sock"
printf '%%1\t%s\n' "$T/orphan.sock" >"$CREW_ROOT/.diff/fake-lead"
run_diff "$A"
kill "$ORPHAN"
check "(f) stale state: a new pane %2 is created" out_is "diff: opened $A (new pane %2)"
check "(f) stale state: state names %2" bash -c '[ "$(cut -f1 "$1/.diff/fake-lead")" = "%2" ]' _ "$CREW_ROOT"
wait_for sock_up "$SOCK"
check "(f) stale state: the new nvim listens on the socket" sock_up "$SOCK"
run_diff "$A" --focus --print
check "(f) --print reports the reusable pane" bash -c '[[ "$1" == *"target: reuse pane %2"* ]]' _ "$OUT"
tmux select-pane -t %0
tmux kill-pane -t %2

# fresh pane with --focus
run_diff "$A" --focus
check "(g) --focus on a new pane: selected" bash -c '[ "$(tmux display-message -p -t t "#{pane_id}")" = "%3" ]'
tmux kill-pane -t %3
tmux select-pane -t %0

# no live lead (the fake map lists nobody): window diff-<ID>, no focus by default, selected with --focus
export CREW_TMUX_MAP=$T/map-none
H=$(new_task d-h "worktree=$T/wt" branch=crew/t1 base=main lead=gone-lead)
run_diff "$H"
check "(h) no live lead: window diff-$H" bash -c '[[ "$1" == "diff: opened $2 (window diff-$2)" ]]' _ "$OUT" "$H"
check "(h) the window exists" bash -c '[[ "$(tmux list-windows -a -F "#{window_name}")" == *"diff-$1"* ]]' _ "$H"
check "(h) focus stays on the first window" bash -c '[ "$(tmux display-message -p -t t "#{window_name}")" != "diff-$1" ]' _ "$H"
check "(h) the window pane runs nvim in the worktree" bash -c '[ "$(tmux list-panes -a -F "#{window_name} #{pane_current_command} #{pane_current_path}" | grep "^diff-$1")" = "diff-$1 nvim $2" ]' _ "$H" "$T/wt"
run_diff "$H" --focus
check "(h) --focus selects the window" bash -c '[ "$(tmux display-message -p -t t "#{window_name}")" = "diff-$1" ]' _ "$H"

# --- a real nvim round trip against the scratch repo (real diffview.nvim when installed) ---
DV=$HOME/.local/share/nvim/lazy/diffview.nvim
RT=$(new_task d-rt "worktree=$T/wt" branch=crew/t1 base=main lead=rt-lead)
RSOCK=$T/run/crew-diff-rt-lead.sock
printf '#!/bin/sh\nprintf "rt-lead\\tt:0.0\\tclaude\\t/x\\tidle\\t1\\t\\n"\n' >"$T/map-rt"; chmod +x "$T/map-rt"
export CREW_TMUX_MAP=$T/map-rt
if [ -d "$DV" ]; then
  RTPANE=$(tmux new-window -d -P -F '#{pane_id}' -n rt "$REAL_NVIM" --headless --clean --cmd "set rtp+=$DV" --listen "$RSOCK")
  RT_NOTE="real diffview.nvim"
else
  RTPANE=$(tmux new-window -d -P -F '#{pane_id}' -n rt "$REAL_NVIM" --headless --clean --cmd 'command! -nargs=* DiffviewOpen let g:dv = <q-args> . "|" . getcwd()' --listen "$RSOCK")
  RT_NOTE="stub DiffviewOpen (diffview.nvim not installed)"
fi
printf '%s\t%s\n' "$RTPANE" "$RSOCK" >"$CREW_ROOT/.diff/rt-lead"
wait_for sock_up "$RSOCK"
run_diff "$RT"
check "(i) round trip [$RT_NOTE]: reused the nvim pane" out_is "diff: opened $RT (reused pane $RTPANE)"
if [ -d "$DV" ]; then
  # DiffviewOpen opens its own tab (the scratch tab of the reuse path is gone)
  check "(i) round trip: nvim has diffview open on main...crew/t1 in the worktree" bash -c '[ "$(nvim --server "$1" --remote-expr "tabpagenr(\"\$\") . \"|\" . getcwd() . \"|\" . luaeval(\"require(\\\"diffview.lib\\\").get_current_view() ~= nil\") . \"|\" . luaeval(\"require(\\\"diffview.lib\\\").get_current_view().rev_arg\")")" = "2|$2|v:true|main...crew/t1" ]' _ "$RSOCK" "$T/wt"
else
  check "(i) round trip: the stub received the range" bash -c '[ "$(nvim --server "$1" --remote-expr "g:dv")" = "main...crew/t1|$2" ]' _ "$RSOCK" "$T/wt"
fi

# (i2) repeated calls must not pile up tabs or views (real diffview.nvim only: the stub opens no tab)
if [ -d "$DV" ]; then
  ntabs() { nvim --server "$1" --remote-expr 'tabpagenr("$")'; }
  # live diffview views whose rev_arg is $2 ("" = uncommitted changes)
  nviews() { nvim --server "$1" --remote-expr "luaeval('#vim.tbl_filter(function(v) return (v.rev_arg or \"\") == _A and v.tabpage ~= nil and vim.api.nvim_tabpage_is_valid(v.tabpage) end, require(\"diffview.lib\").views)', '$2')"; }
  export -f ntabs nviews
  TABS1=$(ntabs "$RSOCK")
  run_diff "$RT"; run_diff "$RT"
  check "(i2) 3 calls for one task: exactly one diffview of the range" bash -c '[ "$(nviews "$1" "$2")" = 1 ]' _ "$RSOCK" main...crew/t1
  check "(i2) 3 calls for one task: tab count is that of the first call ($TABS1), no empty tabs" bash -c '[ "$(ntabs "$1")" = "$2" ]' _ "$RSOCK" "$TABS1"
  check "(i2) 3 calls: the one view is the current tab, in the task dir" bash -c '[ "$(nvim --server "$1" --remote-expr "getcwd() . \"|\" . luaeval(\"require(\\\"diffview.lib\\\").get_current_view().rev_arg\")")" = "$2|main...crew/t1" ]' _ "$RSOCK" "$T/wt"
  RT2=$(new_task d-rt2 "worktree=$T/my wt#1|x" branch=crew/t2 base=main lead=rt-lead)
  run_diff "$RT2"; run_diff "$RT2"
  check "(i2) a different task adds one view of its own range and keeps the first" bash -c '[ "$(nviews "$1" main...crew/t1)$(nviews "$1" main...crew/t2)" = 11 ]' _ "$RSOCK"
  check "(i2) a different task adds exactly one tab (no empty tab)" bash -c '[ "$(ntabs "$1")" = "$2" ]' _ "$RSOCK" "$((TABS1 + 1))"
  check "(i2) a different task: its view has the task dir as cwd" bash -c '[ "$(nvim --server "$1" --remote-expr "getcwd()")" = "$2" ]' _ "$RSOCK" "$T/my wt#1|x"
  echo x >>"$R/f"
  RT3=$(new_task d-rt3 lead=rt-lead)
  run_diff "$RT3"; run_diff "$RT3"
  check "(i2) in-place task (uncommitted changes), 2 calls: one view, one more tab" bash -c '[ "$(nviews "$1" "")" = 1 ] && [ "$(ntabs "$1")" = "$2" ]' _ "$RSOCK" "$((TABS1 + 2))"
  git_quiet -C "$R" checkout f
fi

# --- review fixes: lock before state, stale socket, startup check, socket length, "."/".." leads ---
LONG=$(printf 'L%.0s' $(seq 120))
printf '#!/bin/sh\nfor n in conc-lead stale-lead die-lead hang-lead . .. %s; do printf "%%s\\tt:0.0\\tclaude\\t/x\\tidle\\t1\\t\\n" "$n"; done\n' "$LONG" >"$T/map-multi"
chmod +x "$T/map-multi"
export CREW_TMUX_MAP=$T/map-multi
npanes() { tmux list-panes -a -F x | wc -l | tr -d ' '; }
state_pane() { cut -f1 "$CREW_ROOT/.diff/$1"; }
state_sock() { cut -f2 "$CREW_ROOT/.diff/$1"; }

# (j) two concurrent calls for one lead: exactly one pane is created, the other call reuses it
J=$(new_task d-j "worktree=$T/wt" branch=crew/t1 base=main lead=conc-lead)
N0=$(npanes)
"$CREW" diff "$J" >"$T/j1.out" 2>"$T/j1.err" & J1=$!
"$CREW" diff "$J" >"$T/j2.out" 2>"$T/j2.err" & J2=$!
wait $J1; JR1=$?; wait $J2; JR2=$?
check "(j) concurrent: both calls exit 0" bash -c '[ "$1$2" = 00 ]' _ "$JR1" "$JR2"
check "(j) concurrent: exactly one pane was created" bash -c '[ "$(( $2 - $1 ))" = 1 ]' _ "$N0" "$(npanes)"
check "(j) concurrent: one call created, the other reused" bash -c '[ "$(cat "$1" "$2" | grep -c "(new pane ")" = 1 ] && [ "$(cat "$1" "$2" | grep -c "(reused pane ")" = 1 ]' _ "$T/j1.out" "$T/j2.out"
check "(j) concurrent: the state file names the created pane" bash -c '[[ "$(cat "$2" "$3")" == *"(new pane $1)"* ]]' _ "$(state_pane conc-lead)" "$T/j1.out" "$T/j2.out"
tmux kill-pane -t "$(state_pane conc-lead)"

# (k) stale state: a recorded socket nobody listens on (file left behind) and a live pane that runs some other nvim
K=$(new_task d-k "worktree=$T/wt" branch=crew/t1 base=main lead=stale-lead)
"$REAL_NVIM" --headless --clean --listen "$T/stale.sock" >/dev/null 2>&1 &
SP=$!
wait_for sock_up "$T/stale.sock"
kill -9 "$SP"; { wait "$SP"; } 2>/dev/null
FOREIGN=$(tmux new-window -d -P -F '#{pane_id}' -n foreign "$REAL_NVIM" --headless --clean)
pane_nvim() { [ "$(tmux display-message -p -t "$1" '#{pane_current_command}' 2>/dev/null)" = nvim ]; }
wait_for pane_nvim "$FOREIGN"
printf '%s\t%s\n' "$FOREIGN" "$T/stale.sock" >"$CREW_ROOT/.diff/stale-lead"
check "(k) setup: dead socket file exists, foreign pane runs nvim" bash -c '[ -S "$1" ] && ! nvim --server "$1" --remote-expr 1 >/dev/null 2>&1' _ "$T/stale.sock"
run_diff "$K"
check "(k) stale socket: exit 0 (not 5)" rc_is 0
check "(k) stale socket: a new pane is created" bash -c '[[ "$1" == "diff: opened $2 (new pane %"* ]]' _ "$OUT" "$K"
check "(k) stale socket: state names the new pane and socket, not the foreign pane" bash -c '[ "$(cat "$1/.diff/stale-lead")" = "$(printf "%s\t%s" "$2" "$3")" ] && [ "$2" != "$4" ]' _ "$CREW_ROOT" "$(state_pane stale-lead)" "$T/run/crew-diff-stale-lead.sock" "$FOREIGN"
check "(k) stale socket: the foreign pane is left alone" bash -c 'tmux display-message -p -t "$1" >/dev/null 2>&1' _ "$FOREIGN"
tmux kill-pane -t "$FOREIGN"; tmux kill-pane -t "$(state_pane stale-lead)"

# (l) lead name too long for a unix socket path: a short hashed socket name under the same dir
L=$(new_task d-l "worktree=$T/wt" branch=crew/t1 base=main lead=$LONG)
run_diff "$L" --print
check "(l) print: the socket path is short and under the socket dir" bash -c 's=$(sed -n "s/^socket: //p" <<<"$1"); [ "${#s}" -le 100 ] && [ "$(dirname "$s")" = "$2" ]' _ "$OUT" "$T/run"
run_diff "$L"
check "(l) long lead: exit 0 and a new pane" bash -c '[[ "$1" == "diff: opened $2 (new pane %"* ]]' _ "$OUT" "$L"
LSOCK=$(state_sock "$LONG")
check "(l) long lead: nvim listens on the recorded short socket" bash -c '[ "${#1}" -le 100 ] && [ -S "$1" ]' _ "$LSOCK"
tmux kill-pane -t "$(state_pane "$LONG")"

# (m) nvim does not come up: exit 5 with a message, no state recorded, the pane we made is gone
M1=$(new_task d-m1 "worktree=$T/wt" branch=crew/t1 base=main lead=die-lead)
echo die >"$T/nvim-mode"; N0=$(npanes)
run_diff "$M1"
check "(m) nvim exits at once: exit 5" rc_is 5
check "(m) nvim exits at once: clear message" bash -c '[[ "$1" == *"nvim did not start"* ]]' _ "$ERR"
check "(m) nvim exits at once: no state, no new pane" bash -c '[ ! -e "$1/.diff/die-lead" ] && [ "$3" = "$2" ]' _ "$CREW_ROOT" "$N0" "$(npanes)"
M2=$(new_task d-m2 "worktree=$T/wt" branch=crew/t1 base=main lead=hang-lead)
echo hang >"$T/nvim-mode"; N0=$(npanes)
run_diff "$M2"
check "(m) nvim never listens: exit 5" rc_is 5
check "(m) nvim never listens: no state, the stuck pane is removed" bash -c '[ ! -e "$1/.diff/hang-lead" ] && [ "$3" = "$2" ]' _ "$CREW_ROOT" "$N0" "$(npanes)"
rm -f "$T/nvim-mode"

# (n) lead keys "." and ".." are no lead at all
for DOT in . ..; do
  D=$(new_task d-dot "worktree=$T/wt" branch=crew/t1 base=main "lead=$DOT")
  run_diff "$D" --print
  check "(n) lead '$DOT': key is window-<id>, target a new window" bash -c '[[ "$1" == *"target: new window diff-$2"*"socket: $3/crew-diff-window-$2.sock" ]]' _ "$OUT" "$D" "$T/run"
done
run_diff "$D"
check "(n) lead '..': new window, state under window-<id>" bash -c '[ "$1" = "diff: opened $2 (window diff-$2)" ] && [ -f "$3/.diff/window-$2" ]' _ "$OUT" "$D" "$CREW_ROOT"

# (o) tmux expands # formats in split-window/new-window -c and new-window -n: a dir like a#Sb (#S is a format alias) or
# x#(touch PWNED)y (runs a command in the tmux server) and an id like x#(touch PWN2) must stay plain data
printf '#!/bin/sh\nprintf "o-lead\\tt:0.0\\tclaude\\t/x\\tidle\\t1\\t\\n"\n' >"$T/map-o"; chmod +x "$T/map-o"
n=0
for name in 'a#Sb' 'x#(touch PWNED)y'; do
  n=$((n + 1))
  git_quiet -C "$R" worktree add "$T/$name" -b "crew/o$n" main
  echo o >>"$T/$name/f"; git_quiet -C "$T/$name" commit -am "o$n"
  for mode in pane window; do
    if [ $mode = pane ]; then export CREW_TMUX_MAP=$T/map-o; else export CREW_TMUX_MAP=$T/map-none; fi
    O=$(new_task d-o "worktree=$T/$name" "branch=crew/o$n" base=main lead=o-lead)
    : >"$T/nvim.log"
    run_diff "$O"
    check "(o) $mode, dir '$name': exit 0" rc_is 0
    if [ $mode = pane ]; then ostate=$CREW_ROOT/.diff/o-lead; else ostate=$CREW_ROOT/.diff/window-$O; fi
    opane=$(cut -f1 "$ostate" 2>/dev/null || true) osock=$(cut -f2 "$ostate" 2>/dev/null || true)
    check "(o) $mode, dir '$name': nvim started in exactly that dir" bash -c '[ "$(sed -n 1p "$1")" = "cwd=$2" ]' _ "$T/nvim.log" "$T/$name"
    check "(o) $mode, dir '$name': the live nvim has that cwd" bash -c '[ "$(nvim --server "$1" --remote-expr "getcwd()")" = "$2" ]' _ "$osock" "$T/$name"
    check "(o) $mode, dir '$name': no command ran in the tmux server" bash -c '[ ! -e "$1/PWNED" ] && [ ! -e "$2/PWNED" ]' _ "$T" "$ORIG_PWD"
    [ -z "$opane" ] || tmux kill-pane -t "$opane" >/dev/null 2>&1 || true
    [ -z "$opane" ] || wait_for pane_gone "$opane"
  done
done
export CREW_TMUX_MAP=$T/map-none
OID='x#(touch PWN2)'
mkdir -p "$CREW_ROOT/$OID"
printf 'worktree=%s\nbranch=crew/t1\nbase=main\nlead=gone-lead\n' "$T/wt" >"$CREW_ROOT/$OID/meta"
run_diff "$OID"
check "(o) id with #(...): exit 0, window name has the # neutralised" bash -c '[ "$1" = 0 ] && [ "$2" = "diff: opened $3 (window diff-x__touch_PWN2_)" ]' _ "$RC" "$OUT" "$OID"
check "(o) id with #(...): that window exists, no command ran" bash -c '[[ "$(tmux list-windows -a -F "#{window_name}")" == *"diff-x__touch_PWN2_"* ]] && [ ! -e "$1/PWN2" ] && [ ! -e "$2/PWN2" ]' _ "$T" "$ORIG_PWD"
oc=$(cut -f1 "$CREW_ROOT/.diff/window-$OID" 2>/dev/null || true)
[ -z "$oc" ] || tmux kill-pane -t "$oc" >/dev/null 2>&1 || true

echo
if [ "$fails" -eq 0 ]; then echo "all ok"; else echo "$fails FAILED"; exit 1; fi
