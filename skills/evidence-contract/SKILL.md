---
name: evidence-contract
description: |
  Automatically apply an evidence contract whenever creating, reviewing, or revising
  a nontrivial implementation plan, before substantial code edits begin. Grounds plan
  claims in repository evidence, labels assumptions as observed/inferred/unknown,
  identifies affected files and dependencies, and gives every plan item an executable
  success check. Use automatically for architecture plans, feature plans, bug-fix plans,
  refactors, migrations, implementation proposals, and requests to "plan", "design the
  implementation", "figure out how to build", or "review this plan". Skip for trivial,
  obvious single-line changes. Can also be invoked manually with /evidence-contract.
---

# Evidence Contract

Create plans that are testable and grounded in the actual repository rather than plausible guesses.

## Activation

Apply this skill automatically when the task requires a nontrivial implementation plan or plan review. Do not wait for the user to invoke it explicitly.

Skip the full contract for trivial changes where the target, behavior, and verification are already obvious. State the simple check instead.

This skill is planning-only. Do not edit implementation files unless the user also asked you to execute the plan.

## Workflow

### 1. Establish intent and success

Restate the desired outcome in one sentence. Extract concrete acceptance behavior from the request. If wording is ambiguous, investigate the repository before asking the user. Ask only when materially different outcomes remain possible after investigation.

### 2. Gather minimum sufficient evidence

Before proposing architecture or naming affected files:

1. Read `PROJECT_CONTEXT.md` when present.
2. Locate the feature entry points with targeted search.
3. Read the smallest set of relevant implementation, configuration, and test files.
4. Trace important callers, dependencies, persistence boundaries, and public interfaces.
5. Record contradictions between documentation and code. Treat code and executable behavior as stronger evidence.

Avoid broad repository scans when targeted evidence is enough.

### 3. Classify every material claim

Use these labels internally and expose them when useful:

- **Observed**: directly supported by a file, symbol, command result, test, or runtime observation.
- **Inferred**: strongly implied by observed evidence but not directly demonstrated.
- **Unknown**: material information that has not been established.

Never present an inferred or unknown claim as fact. Include a code location or tool observation for important observed claims. Do not invent file paths, APIs, dependencies, or existing behavior.

### 4. Resolve blocking unknowns

Investigate unknowns that could change architecture, scope, data flow, compatibility, or acceptance behavior. If an unknown cannot be resolved locally:

- state it explicitly,
- explain why it matters,
- propose the safest bounded assumption, and
- ask the user only if proceeding could produce the wrong outcome.

### 5. Produce an evidence-gated plan

Every nontrivial plan item must include:

1. **Change**: the smallest coherent implementation step.
2. **Evidence**: observed repository facts that justify the step, with relevant paths or symbols.
3. **Affected surface**: files, interfaces, data, callers, dependencies, or workflows likely to change.
4. **Success check**: an executable test, build, lint, runtime, or acceptance observation.
5. **Risk or assumption**: only when material, labeled inferred or unknown.

Prefer plans that map one requirement to one observable check. Include regression coverage for bug fixes and compatibility-sensitive changes.

### 6. Run the planning gate

Before presenting the plan, verify:

- Each requested outcome maps to at least one plan item.
- Each plan item has evidence and a concrete success check.
- Named files and symbols were observed, not guessed.
- Material assumptions are visible and classified.
- Dependencies and integration boundaries are covered.
- The plan uses the smallest change that satisfies the request.
- No speculative features or unrelated refactors were added.

If the gate fails, investigate or revise the plan before returning it.

## Output format

Keep the result concise unless the task is complex.

```markdown
## Evidence contract
- Observed: `path/to/file` establishes ...
- Inferred: ... because ...
- Unknown: ...; bounded assumption or required decision ...

## Plan
1. **Change** ...
   - Evidence: ...
   - Affected: ...
   - Verify: ...
   - Risk/assumption: ...

## Completion gate
- [ ] Requirement-to-check mapping is complete
- [ ] No unlabelled assumptions remain
- [ ] Acceptance checks are executable
```

Omit empty inferred or unknown sections. For small plans, compress each item to a single line while retaining evidence and verification.

## Anti-patterns

Do not:

- produce a plan from filenames alone,
- use "likely", "probably", or "should" without marking an inference,
- claim tests pass without running them,
- substitute a mocked check for an available real acceptance path,
- burden the user with questions answerable from the repository,
- turn the contract into paperwork for trivial changes,
- begin implementation merely because the plan is complete.
