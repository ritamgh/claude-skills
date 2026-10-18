#!/usr/bin/env bash
# SessionStart hook (matcher: compact). If this session registered an
# orchestration ledger, print it so it is re-added to context after auto-compact.
# Registration: echo /path/to/ledger.md > ~/.claude/orchestration/active/<session_id>
ORCH_ROOT="${ORCH_ROOT:-$HOME/.claude/orchestration}"
sid=$(jq -r '.session_id // empty' 2>/dev/null) || exit 0
[[ -n $sid && -f "$ORCH_ROOT/active/$sid" ]] || exit 0
ledger=$(head -n 1 "$ORCH_ROOT/active/$sid")
[[ -f $ledger ]] || exit 0
echo "## Orchestration ledger restored after compaction ($ledger)"
echo "You are orchestrating with the \`orchestrate\` skill. Re-read this ledger, reload the skill if needed, and continue from 'Next step'."
echo
head -n 200 "$ledger"
exit 0
