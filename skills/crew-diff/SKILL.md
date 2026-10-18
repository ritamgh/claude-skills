---
name: crew-diff
description: Open a crew task's branch, or the uncommitted changes, in diffview.nvim next to this pane.
argument-hint: "[task-id] [--print]"
disable-model-invocation: true
allowed-tools: Bash(~/.claude/bin/crew diff:*)
---

!`~/.claude/bin/crew diff $ARGUMENTS --focus 2>&1; echo "exit=$?"`

Report the result above in one line. If exit is 4, nvim or diffview.nvim is missing; say which. Do nothing else.
