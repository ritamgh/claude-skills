---
name: graphify
description: Build and query a local code map (graph of files, functions, calls) with the graphify CLI. Use for "how is this code connected", "what calls X", "what depends on X", "map this repo", "path between A and B", or before reading many files to orient in an unfamiliar codebase.
---

# graphify: local code map, no LLM spend

CLI `graphify` (PyPI `graphifyy`, pinned 0.9.91, installed with `uv tool`). Output goes to
`graphify-out/` in the repo root. It is git-ignored globally (`~/.config/git/ignore`); never commit it.

## Build (code only, offline)

```
graphify extract . --code-only
graphify cluster-only . --no-label
```

- `--code-only` is pure tree-sitter, free. `--no-label` is mandatory: without it `cluster-only`
  finds the `claude` CLI on PATH and silently spends subscription tokens naming communities.
  Never drop it, and never run `graphify label`, `--backend`, or semantic/doc extraction, unless
  the user asks. No env var or config disables the LLM backend, so the flag is the only guard.
- Refresh after code changes: `graphify update .` (local, no LLM). Use `--force` only after
  refactors that delete code.
- Do not run `graphify install`, `graphify claude install` or `graphify hook install`: they edit
  CLAUDE.md, settings.json or git hooks. Not needed.

## Query

1. Read `graphify-out/GRAPH_REPORT.md` first (god nodes, communities, surprising links).
2. `graphify explain "Name"` for one node and its neighbours (`--all` for every edge).
3. `graphify path "A" "B" --undirected` for how two things connect. Without `--undirected` it
   reports a false "no path".
4. `graphify query "question" --budget 2000` for a BFS slice (always pass `--budget`).
Exit code 3 means an ambiguous name; retry with a more specific one.

Labels read `Community N` by design. Trust the graph for structure, then read the real files
before acting on it.
