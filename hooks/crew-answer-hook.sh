#!/usr/bin/env bash
# UserPromptSubmit hook. When the prompt the user typed into a lead session answers an open D-id of one of that lead's
# subs ("D17 go", "D17: A", "D17 - use the worktree"), `crew deliver-answer` records it and types it into the asking
# sub's pane as the user's words (skill: crew, "Answers"). Only a real typed prompt reaches a hook, so no model can
# trigger this. Never blocks or changes the prompt: any problem exits 0 with no output.
raw=$(cat 2>/dev/null) || exit 0
[[ $raw =~ [Dd][0-9] ]] || exit 0   # the quick way out for nearly every prompt
parsed=$(printf '%s' "$raw" | python3 -I -c '
import base64, json, re, sys
try:
    d = json.load(sys.stdin)
    sid, prompt = d["session_id"], d["prompt"]
    m = re.match(r"\s*[Dd](\d{1,9})(?:\s*[:\-–—]\s*|\s+)(.+)", prompt, re.S)
    if not (isinstance(sid, str) and re.fullmatch(r"[A-Za-z0-9-]{1,80}", sid) and m and m.group(2).strip()):
        sys.exit(0)
    sys.stdout.write("%s\x1fD%s\x1f%s" % (sid, m.group(1), base64.b64encode(m.group(2).encode()).decode()))   # (crew cleans the text: one function for the hook and HQ)
except Exception:
    sys.exit(0)
' 2>/dev/null) || exit 0
[ -n "$parsed" ] || exit 0
IFS=$'\x1f' read -r sid did b64 <<<"$parsed"
text=$(printf '%s' "$b64" | base64 -d 2>/dev/null)
[ -n "$sid" ] && [ -n "$did" ] && [ -n "$text" ] || exit 0
root=${CREW_ROOT:-$HOME/.claude/crew}
crew=${CREW_BIN:-$(dirname "$(readlink -f "$0")")/../bin}/crew
[ -x "$crew" ] || exit 0
key=$(cat "$root/.deliver-key" 2>/dev/null)
if [ -z "$key" ]; then   # the first answer: make the key that tells crew this call comes from the hook (or HQ)
  mkdir -p "$root" 2>/dev/null && (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$root/.deliver-key.$$" && ln "$root/.deliver-key.$$" "$root/.deliver-key"; rm -f "$root/.deliver-key.$$") 2>/dev/null
  key=$(cat "$root/.deliver-key" 2>/dev/null)
fi
[ -n "$key" ] || exit 0
err=$(CREW_DELIVER_KEY=$key timeout "${CREW_ANSWER_HOOK_TIMEOUT:-8}" "$crew" deliver-answer --sid "$sid" --did "$did" -- "$text" 2>&1 >/dev/null </dev/null)
rc=$?
if [ $rc -ne 0 ]; then   # the answer was recorded or not, but it did not reach the sub: tell the lead model (the prompt itself is unchanged)
  why=$(printf '%s' "$err" | awk 'NF {print; exit}' | cut -c1-160)
  [ $rc -ne 124 ] || why="timed out"
  jq -nc --arg c "$did: answer not delivered (${why:-exit $rc}); tell the user" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $c}}' 2>/dev/null
fi
exit 0
