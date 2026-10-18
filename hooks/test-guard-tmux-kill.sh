#!/usr/bin/env bash
# Test: guard-tmux-kill.sh denies (exit 2 + a reason on stderr) every Bash command that can kill the user's real
# tmux server or close a window, pane or session of it by hand (crew close is the way), and every command that sets
# CREW_AS_USER; it allows everything else: kills on a private -L/-S server, read-only tmux, ordinary commands. Pure stdin/stdout: the hook is fed the PreToolUse JSON and never touches tmux.
#   bash test-guard-tmux-kill.sh
set -uo pipefail

HOOK=$(dirname "$(readlink -f "$0")")/guard-tmux-kill.sh
export CREW_NOTIFY_CONFIG=/dev/null/no-such-config CREW_NOTIFY_LOG=/dev/null   # the hook never runs crew; if a case ever did, no phone alert leaves the machine
fails=0 n=0

# run_hook COMMAND: feed {"tool_input":{"command":COMMAND}} to the hook; sets rc and err.
run_hook() {
  local json
  json=$(python3 -I -c 'import json,sys; print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))' "$1")
  err=$(printf '%s' "$json" | "$HOOK" 2>&1 >/dev/null)
  rc=$?
}

# case VERDICT COMMAND: VERDICT is deny or allow.
case_() {
  local want=$1 cmd=$2
  n=$((n + 1))
  run_hook "$cmd"
  if [ "$want" = deny ]; then
    if [ "$rc" = 2 ] && [[ $err == BLOCKED:* ]]; then echo "ok   deny  $cmd"
    else echo "FAIL deny  $cmd (rc=$rc err=${err:0:60})"; fails=$((fails + 1)); fi
  else
    if [ "$rc" = 0 ] && [ -z "$err" ]; then echo "ok   allow $cmd"
    else echo "FAIL allow $cmd (rc=$rc err=${err:0:60})"; fails=$((fails + 1)); fi
  fi
}

# --- deny: unsocketed kill-server, in every position a command can hide
case_ deny 'tmux kill-server'
case_ deny 'TMUX_TMPDIR=/tmp/x/tmux tmux kill-server 2>/dev/null'
case_ deny 'cd /tmp && tmux kill-server'
case_ deny 'true; tmux kill-server'
case_ deny 'tmux ls | tmux kill-server'
case_ deny 'make test || tmux kill-server'
case_ deny 'bash -c "tmux kill-server"'
case_ deny "sh -lc 'cd /tmp; tmux kill-server'"
case_ deny 'echo $(tmux kill-server)'
case_ deny 'echo `tmux kill-server`'
case_ deny 'env FOO=1 tmux kill-server'
case_ deny 'command tmux kill-server'
case_ deny 'timeout 5 tmux kill-server'
case_ deny '/usr/bin/tmux kill-server'
case_ deny 'tmux -f /dev/null kill-server'
case_ deny 'tmux kill-ser'
case_ deny 'for d in a b; do tmux kill-server; done'
case_ deny 'eval "tmux kill-server"'
case_ deny $'echo start\ntmux kill-server'
# a socket flag that still reaches the real server
case_ deny 'tmux -L default kill-server'
case_ deny 'tmux -S "${TMUX%%,*}" kill-server'
case_ deny 'tmux -S /tmp/tmux-1000/default kill-server'
# --- deny: pkill / killall aimed at tmux
case_ deny 'pkill tmux'
case_ deny 'pkill -f tmux'
case_ deny 'pkill -9 -x tmux'
case_ deny 'killall tmux'
case_ deny 'sudo killall -9 tmux'
# --- deny: kill of the tmux server pid
case_ deny 'kill $(pgrep tmux)'
case_ deny 'kill -9 $(pgrep -x tmux)'
case_ deny 'kill `pidof tmux`'
case_ deny 'pgrep tmux | xargs kill'
case_ deny "kill \$(tmux display-message -p '#{pid}')"

# --- deny: typing into another pane on the default server (a session must not fake a user turn)
case_ deny 'tmux send-keys -t claude:3 -l hello'
case_ deny 'tmux send-keys -t %5 Enter'
case_ deny 'tmux send -t claude:3 hi'
case_ deny 'tmux send-k -t claude:3 hi'
case_ deny 'tmux -u send-keys -t %5 -l -- "D17 go"'
case_ deny 'tmux paste-buffer -t %5'
case_ deny 'tmux pasteb -t %5'
case_ deny 'tmux pas -t %5'
case_ deny 'tmux loa /tmp/x'
case_ deny 'tmux sen -t %5 hi'
case_ deny 'tmux load-buffer /tmp/x && tmux paste-buffer -t %5'
case_ deny 'tmux loadb -b b /tmp/x'
case_ deny 'tmux -L default send-keys -t %5 hi'
case_ deny 'tmux -S "${TMUX%%,*}" send-keys -t %5 hi'
case_ deny 'bash -c "tmux send-keys -t %5 hi Enter"'
case_ deny 'cd /tmp && env FOO=1 tmux send-keys -t %5 hi'
case_ deny '/usr/bin/tmux send-keys -t %5 hi'
case_ deny 'tmux new-window \; send-keys -t %5 hi'
case_ deny 'for p in %5 %6; do tmux send-keys -t $p x; done'
case_ deny 'tmux run-shell "tmux send-keys -t %5 hi Enter"'
case_ deny "tmux if-shell true 'send-keys -t %5 hi'"
case_ deny "tmux run-shell 'tmux paste-buffer -t %5'"
case_ deny "tmux bind-key x send-keys -t %5 hi"
# --- deny: the delivery key
case_ deny 'cat ~/.claude/crew/.deliver-key'
case_ deny 'CREW_DELIVER_KEY=x ~/.claude/bin/crew deliver-answer --did D1 -- go'

# --- deny: kill-window / kill-pane / kill-session on the default server (use crew close)
case_ deny 'tmux kill-window -t claude:foo'
case_ deny 'tmux kill-pane -t %3'
case_ deny 'tmux kill-session -t claude'
case_ deny 'tmux killw -t claude:3'
case_ deny 'tmux killp -t %1'
case_ deny 'tmux kill-window -a'
case_ deny 'tmux kill-w -t x'
case_ deny 'tmux -f /dev/null kill-window -t x'
case_ deny 'cd /tmp && tmux kill-window -t claude:x'
case_ deny 'bash -c "tmux kill-window -t claude:x"'
case_ deny 'tmux list-windows \; kill-window -t x'
case_ deny 'tmux -L default kill-window -t x'
case_ deny 'tmux -S "${TMUX%%,*}" kill-pane -t %2'
case_ deny "tmux run-shell 'tmux kill-window -t claude:x'"
case_ deny 'for w in a b; do tmux kill-window -t claude:$w; done'
case_ deny 'env FOO=1 /usr/bin/tmux kill-session -t claude'
# --- deny: setting CREW_AS_USER (only HQ's own code and the user may)
case_ deny 'CREW_AS_USER=1 crew close sub'
case_ deny 'CREW_AS_USER=1 ~/.claude/bin/crew wake web -- go'
case_ deny 'FOO=1 CREW_AS_USER=1 crew close sub'
case_ deny 'env CREW_AS_USER=1 crew close sub'
case_ deny 'export CREW_AS_USER=1; crew close sub'
case_ deny 'bash -c "CREW_AS_USER=1 crew close sub"'
case_ deny 'declare -x CREW_AS_USER=1 && crew close sub'
case_ deny 'tmux new-window -e CREW_AS_USER=1 crew close sub'

# --- deny: any mention of CREW_AS_USER in the command text (fails closed: no assignment form is parsed)
case_ deny 'printf -v CREW_AS_USER 1; export CREW_AS_USER; crew close sub'
case_ deny 'env printf %s CREW_AS_USER=1'
case_ deny 'grep -n "CREW_AS_USER=1" home/.claude/bin/crew'
case_ deny 'echo CREW_AS_USER=1 is for HQ'
case_ deny 'git commit -m "CREW_AS_USER stays HQ-only"'
case_ deny 'declare -n x=CREW_AS_USER; x=1 crew close sub'
case_ deny $'cat <<EOF\nCREW_AS_USER=1\nEOF'
case_ deny $'cat <<\'EOF\' | bash\nexport CREW_AS_USER=1\nEOF'
# --- deny: tmux commands hidden in arguments of a tmux invocation on the default server
case_ deny 'tmux if-shell true "kill-window -t x"'
case_ deny 'tmux confirm-before -p sure kill-window'
case_ deny 'tmux bind-key X kill-window'
case_ deny 'tmux set -g @x 1 \; kill-pane -t %2'
case_ deny 'tmux source-file -'
case_ deny 'printf "kill-window -t x\n" | tmux source -'
case_ deny 'tmux -C attach'
case_ deny 'tmux respawn-pane -k -t %2'
case_ deny 'tmux respawnw -kt claude:3'
case_ deny 'tmux unlink-window -k -t claude:3'
case_ deny 'tmux run-shell "tmux -L default kill-window -t x"'
# --- deny: command strings of command-taking tmux subcommands are checked as shell commands and as tmux commands
case_ deny "tmux run-shell 'pkill tmux'"
case_ deny "tmux run-shell 'kill \$(pgrep tmux)'"
case_ deny "tmux if-shell 'pkill tmux' ''"
case_ deny "tmux if-shell true 'run-shell \"pkill tmux\"'"
case_ deny "tmux if-shell true '\"kill-window\" -t x'"
case_ deny "tmux command-prompt -p x 'kill-window -t %%'"
case_ deny "tmux new-window 'tmux kill-window -t x'"
case_ deny "tmux split-window 'tmux kill-server'"
case_ deny "tmux display-popup 'tmux kill-pane -t %2'"
case_ deny "tmux respawn-pane 'tmux kill-window -t x'"
case_ deny 'tmux bind X confirm-before kill-pane'
case_ deny "tmux run-shell 'tmux -S /tmp/tmux-1000/default kill-session -t claude'"
case_ deny 'tmux -C'
case_ deny 'tmux -CC'
case_ deny 'tmux -u -C new-session'
# --- allow: plain text arguments of tmux subcommands that take no command are never read as commands
case_ allow "tmux display-message 'pkill tmux'"
case_ allow "tmux display-message -p 'tmux kill-window now goes through crew close'"
case_ allow "tmux -L t1 send-keys -t claude:3 -l 'kill-window'"
case_ allow "tmux set-buffer 'tmux kill-server'"
case_ allow 'tmux rename-window kill-pane'
case_ allow "tmux list-windows -F 'kill-window'"
case_ allow "tmux new-window 'sleep 600'"
case_ allow "tmux run-shell 'echo hello'"
case_ allow "tmux -L t run-shell 'pkill tmux'"
# --- heredocs: a # comment is not a heredoc marker; a pipeline that goes on after the body may end in a shell
case_ deny $'echo hi # <<\'EOF\'\ntmux kill-window -t x\nEOF'
case_ deny $'cat <<\'EOF\' |\ntmux kill-window -t x\nEOF\nbash'
case_ deny $'cat <<\'EOF\' &&\ntmux kill-window -t x\nEOF\nbash'
case_ deny $'cat <<\'EOF\' \\\n  | sh\ntmux kill-window -t x\nEOF'
# --- heredocs: a quoted body is literal text unless a shell reads it; an unquoted one is always scanned
case_ deny $'bash <<EOF\ntmux kill-window -t x\nEOF'
case_ deny $'bash <<\'EOF\'\ntmux kill-window -t x\nEOF'
case_ deny $'sh <<"EOF"\nexport CREW_AS_USER=1\nEOF'
case_ deny $'cat <<EOF\n$(tmux kill-window -t x)\nEOF'

# --- allow: private servers
case_ allow 'tmux -L test kill-server'
case_ allow 'tmux -Ltest kill-server'
case_ allow 'tmux -S /tmp/x/sock kill-server'
case_ allow 'tmux -f /dev/null -L t1 kill-server 2>/dev/null'
case_ allow 'cd /tmp && TMUX_TMPDIR=/tmp/x tmux -L crewtest123 kill-server'
case_ allow 'pkill -f "tmux -L crewtest"'
case_ allow 'kill $(pgrep -f "tmux -L crewtest")'
# --- allow: single windows and read/send tmux commands
case_ allow 'tmux -L test kill-window -t claude:foo'
case_ allow 'tmux -Ltest kill-pane -t %3'
case_ allow 'tmux -S /tmp/x/sock kill-session -t a'
case_ allow 'tmux -f /dev/null -L t1 killw -t x 2>/dev/null'
case_ allow 'tmux -L t1 list-windows \; kill-window -t x'
case_ allow 'crew close subname'
case_ allow 'crew close subname --force-draft'
case_ allow 'tmux list-windows -t claude: -F "#{window_id}"'
case_ allow 'tmux select-window -t claude:2'
case_ allow 'git commit -m "tmux kill-window now goes through crew close"'
case_ allow 'bash home/.claude/bin/test-crew-close.sh'
case_ allow 'bash home/.claude/bin/test-crew-wake.sh'
case_ allow 'tmux capture-pane -p -t claude:3'
case_ allow 'tmux -L test send-keys -t cc:1 -l hello'
case_ allow 'tmux -Ltest send-keys -t cc:1 Enter'
case_ allow 'tmux -S /tmp/x/sock paste-buffer -t cc:1'
case_ allow 'tmux -f /dev/null -L t1 load-buffer /tmp/x'
case_ allow 'tmux -L t1 run-shell "tmux -L t1 send-keys -t cc:1 hi"'
case_ allow '~/.claude/bin/crew compact sub-name'
case_ allow 'git commit -m "no tmux send-keys by hand"'
case_ allow 'echo "tmux send-keys is for your own -L server"'
case_ allow 'grep -rn "send-keys" home/.claude'
case_ allow 'tmux send-prefix -t claude:3'
case_ allow 'tmux display-message "send-keys -t %5"'
case_ allow 'tmux list-sessions'
case_ allow 'tmux list-windows -a -F "#{window_name}"'
case_ allow 'tmux switch-client -t claude:0'
case_ allow 'tmux display-message -p "#{pid}"'
# --- allow: ordinary commands that merely mention the words
case_ allow 'git status'
case_ allow 'git commit -m "guard against tmux kill-server"'
case_ allow 'echo "run tmux kill-server only with -L"'
case_ allow 'grep -rn "kill-server" home/.claude'
case_ allow 'pgrep tmux'
case_ allow 'kill $(pgrep -f myserver)'
case_ allow 'kill 4242'
case_ allow 'pkill -f nvim'
case_ allow 'bash home/.claude/mods/hq/tests/test-tmux-map.sh'
# --- allow: quoted heredoc bodies that are only text
case_ allow $'cat > notes.md <<\'EOF\'\nuse crew close, never tmux kill-window; CREW_AS_USER=1 is for HQ\nEOF'
case_ allow $'python3 - <<"EOF"\nprint("tmux kill-server CREW_AS_USER")\nEOF'
case_ allow $'git commit -F - <<\'EOF\'\nguard kill-window and CREW_AS_USER\nEOF'
case_ allow 'tmux respawn-pane -t %2'
case_ allow 'tmux -L t respawn-pane -k -t %2'
case_ allow 'tmux -L t if-shell true "kill-window -t x"'
case_ allow 'tmux source-file ~/.tmux.conf'
# --- fail open: unparseable input and non-Bash payloads never block
n=$((n + 1))
err=$(printf 'not json at all' | "$HOOK" 2>&1 >/dev/null); rc=$?
if [ "$rc" = 0 ] && [ -z "$err" ]; then echo "ok   fail-open on invalid JSON"; else echo "FAIL fail-open on invalid JSON (rc=$rc)"; fails=$((fails + 1)); fi
n=$((n + 1))
err=$(printf '{"tool_input":{"command":42}}' | "$HOOK" 2>&1 >/dev/null); rc=$?
if [ "$rc" = 0 ] && [ -z "$err" ]; then echo "ok   fail-open on non-string command"; else echo "FAIL fail-open on non-string command (rc=$rc)"; fails=$((fails + 1)); fi
n=$((n + 1))
run_hook 'tmux kill-server "unterminated'
if [ "$rc" = 2 ]; then echo "ok   unbalanced quote still parsed (denied)"; else echo "FAIL unbalanced quote (rc=$rc)"; fails=$((fails + 1)); fi
n=$((n + 1))
run_hook 'echo "unterminated'
if [ "$rc" = 0 ]; then echo "ok   unbalanced quote, harmless command (allowed)"; else echo "FAIL unbalanced quote harmless (rc=$rc)"; fails=$((fails + 1)); fi

if [ $fails -gt 0 ]; then echo "$fails of $n check(s) failed"; exit 1; fi
echo "all $n checks passed"
