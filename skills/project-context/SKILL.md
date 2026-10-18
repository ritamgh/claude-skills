---
name: project-context
description: Maintain a concise, trustworthy PROJECT_CONTEXT.md map for a software repository. Use when onboarding to a repository, when the map is missing or stale, or after durable changes to architecture, commands, dependencies, services, workflows, feature ownership, or important file locations.
---

# Project Context

Maintain `PROJECT_CONTEXT.md` as a compact navigation map for future development sessions.

## Safety boundary

1. Find the actual repository root with `git rev-parse --show-toplevel` or equivalent project evidence.
2. Do not create `PROJECT_CONTEXT.md` in `$HOME`, a temporary directory, a dependency or vendor tree, a generated directory, or an unrelated parent directory.
3. Preserve unrelated user changes. Do not overwrite useful project-specific documentation.

## Start of work

1. Read `PROJECT_CONTEXT.md` first when it exists.
2. Treat it as a guide, not as ground truth.
3. Verify claims relevant to the current task with targeted code and configuration reads.
4. If it is missing in a real writable repository, perform a lightweight survey before creating it.

## What the map should contain

- A one-paragraph project purpose and architecture summary.
- Important source, test, configuration, documentation, migration, and deployment paths.
- Canonical install, build, lint, type-check, test, development, and deployment commands.
- High-level data flow and external service boundaries.
- Durable conventions, feature ownership, and debugging gotchas.
- Links to authoritative existing documentation instead of duplicated detail.

Keep the document concise and navigational. Exclude chat history, transient task status, speculative notes, generated inventories, and implementation logs.

## Update triggers

Update the map in the same session when a completed change affects:

- architecture or data flow,
- important file locations,
- development, test, build, or deployment commands,
- dependencies or external services,
- durable feature behavior or ownership,
- conventions and recurring debugging knowledge.

Do not edit it merely to restate a small implementation detail that is obvious from the code.

## Verification

Before finishing:

1. Check every new path and command against the repository.
2. Remove stale statements discovered during the task.
3. Confirm the document remains compact enough to be useful as a first-pass map.
4. Include the context-file change in the same focused commit as the durable code change when appropriate.
