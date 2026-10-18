#!/usr/bin/env bash
# bin/tmux-map must list a background (daemon-run) session that is attached in a tmux pane: its process runs
# the versioned binary (comm "2.1.301", not "claude") and is not a child of the pane; the pane runs
# `claude attach <jobId>`. Uses a private tmux server and fake processes. Run: bash tests/test-tmux-map.sh
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
t=$(mktemp -d); trap 'tmux -S "$t/tmux-$(id -u)/default" kill-server 2>/dev/null; kill $bg $plain 2>/dev/null; rm -rf "$t"' EXIT
unset TMUX TMUX_PANE
export HOME=$t TMUX_TMPDIR=$t CREW_SESSIONS=$t/sessions
mkdir -p "$t/sessions" "$t/.claude/projects/-work-repo"
ln -s "$(command -v bash)" "$t/claude"; ln -s "$(command -v bash)" "$t/2.1.301"
printf 'sleep 60\n' >"$t/attach"; printf 'sleep 60\n' >"$t/bgjob"
touch "$t/.claude/projects/-work-repo/sid-1.jsonl"
"$t/2.1.301" "$t/bgjob" & bg=$!
"$t/claude" "$t/bgjob" & plain=$!
tmux -f /dev/null new-session -d -s claude -n repo "cd $t && exec ./claude attach abc123"
sleep 0.3
jq -n --argjson pid "$bg" '{pid:$pid,name:"Open PRs",cwd:"/work/repo",status:"idle",sessionId:"sid-1",jobId:"abc123",kind:"bg",statusUpdatedAt:1,bridgeSessionId:"session_01Cxabc"}' >"$t/sessions/$bg.json"
# A session without Remote Control has no bridgeSessionId. A *.key file beside a session file is a secret: it must never
# be read, so this one looks like a live session and is unreadable; listing it would show LEAKED.
jq -n --argjson pid "$plain" '{pid:$pid,name:"No bridge",cwd:"/work/other",status:"busy",statusUpdatedAt:1}' >"$t/sessions/$plain.json"
jq -n --argjson pid "$plain" '{pid:$pid,name:"LEAKED",cwd:"/work/leak",status:"busy",statusUpdatedAt:1,bridgeSessionId:"session_KEYLEAK"}' >"$t/sessions/$plain.0123abcd.key"
chmod 000 "$t/sessions/$plain.0123abcd.key"
out=$(bash "$here/bin/tmux-map")
want=$(printf 'Open PRs\tclaude:0.0\trepo\t/work/repo\tidle')
bgline=$(grep '^Open PRs' <<<"$out")
case "$bgline" in
  "$want"*"$t/.claude/projects/-work-repo/sid-1.jsonl"$'\t'"https://claude.ai/code/session_01Cxabc") echo "ok: bg session listed with its pane and its link" ;;
  *) echo "FAIL: got [$bgline]"; exit 1 ;;
esac
plainline=$(grep '^No bridge' <<<"$out")
case "$plainline" in
  *$'\t'"/work/other"$'\t'busy$'\t'*$'\t'$'\t') echo "ok: a session without bridgeSessionId has an empty link" ;;
  *) echo "FAIL: got [$plainline]"; exit 1 ;;
esac
if [ "$(wc -l <<<"$out")" -ne 2 ] || grep -q 'LEAKED\|KEYLEAK' <<<"$out"; then echo "FAIL: a .key file was read: [$out]"; exit 1; fi
echo "ok: a .key file beside the session files is not read"
