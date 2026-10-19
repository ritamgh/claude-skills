# Claude skills

A composable Claude Code setup for planning, background workers, local code exploration and evidence-driven delivery. It includes thirteen skills plus their command-line helpers, hooks, five orchestration agents, the HQ mod and an idea-research workflow. It is a standalone checkout, not a copy of anyone's home directory, settings, credentials or git history.

## Requirements

The shell toolchain targets **Linux/GNU**, not macOS: bash 4+, git, jq, `flock` (util-linux), tmux, GNU coreutils and the usual Linux process tools. Python **3.11+** is required, with the stdlib `sqlite3` module built with **FTS5**. No pip packages are needed for the included Python helpers.

Use a Claude Code build with the **mods runtime** (`claude-code`) and the **Workflow tool** (`enableWorkflows`). These are version-specific APIs, so check that your build exposes them rather than assuming every Claude Code release does. HQ web and its tests require **Bun**. Node.js is used by the browser tests and workflow test harnesses.

Optional, per feature:

- **jcode**, installed and authenticated, for `jw` and jcode-backed workers.
- **gh**, authenticated, for HQ pull-request information.
- **Neovim + diffview.nvim** for `crew-diff`.
- **curl + an ntfy server/topic** for `crew-notify`, configured in `~/.config/crew/notify.toml`. Keep notification credentials outside this checkout.
- **graphify** for the graphify skill. Its SKILL.md documents the CLI/package and offline flags.
- **Playwright + Chromium** for screenshots and browser tests. The lens README documents discovery and configuration.
- **Tailscale** only if you deliberately enable the remote HQ arrangement described below.
- The `sqlite3` CLI and util-linux `script` for the shell test suites that use them.

## Install

Clone the repository URL from the hosting page, then run:

```bash
git clone <repository-url> ~/Developer/claude-skills
cd ~/Developer/claude-skills
./install.sh --dry-run
./install.sh
```

Keep the checkout at that location: installation creates symlinks, not copies. Skills go to `~/.claude/skills/<name>`, executables/helpers to `~/.claude/bin/`, hooks to `~/.claude/hooks/`, agents to `~/.claude/agents/`, HQ to `~/.claude/mods/hq`, and the workflow to `~/.claude/workflows/idea-research.js`. Existing items are moved to `~/.claude/backups/claude-skills-install/<timestamp>/` before linking. Re-running skips links that already point to the checkout. The installer respects `$HOME` and does not import local changes back into the repository.

**Merge**, do not replace, the hook entries from `settings.example.json` into your own `~/.claude/settings.json`. Omit its explanatory `_comment` property. The installer never edits settings. HQ needs no settings entry in the reference setup: Claude Code picks the mod up from `~/.claude/mods/hq`, where the installer links it (if your build wants an explicit enable step, follow its mods documentation). Enable workflows for idea-research and orchestrate's saved workflows. Restart or reload Claude Code as appropriate for your build. The examples use `~/.claude/bin/...` explicitly because this bin directory need not be on `PATH`.

## Skills

**ask-panel** adds an Ask widget to an HTML report so questions are answered in the page rather than the session that generated it. Dependencies: Python for injection, the included lens server and `claude -p` for local Q&A, or the viewer's Claude artifact sampling capability. Browser tests use Node and Playwright.

**crew** turns the main session into a dispatcher: substantive tasks go to workers, sub-leads or orchestrate while the main conversation stays responsive. Dependencies: the `crew` CLI and sibling helpers, bash, tmux, git, jq, flock, Python and Claude Code. HQ, jcode workers and the diff viewer are optional additions.

**crew-diff** opens a task branch or uncommitted changes in diffview.nvim beside the current pane. Dependencies: the included `crew-diff` helper, tmux, Neovim and diffview.nvim.

**evidence-contract** grounds nontrivial implementation plans in repository evidence, marks assumptions, and assigns executable success checks before substantial edits. Dependencies: repository inspection tools. The included `plan` CLI can support structured plans but is not required to read and apply the planning rules.

**graphify** builds and queries a local graph of files, functions and calls to answer connectivity questions before broad reading. Dependencies: the external graphify CLI and git. Use the SKILL.md's `--code-only` and `--no-label` flags to keep extraction offline and avoid unintended model use.

**idea-research** compares one to eight ideas against criteria and pass/fail gates using verified research, dossiers, a gap round and an evaluator panel. Dependencies: Claude Code's Workflow and web research tools, the included `workflows/idea-research.js`, and `plan` when invoked from shape. Workflow tests use Bun.

**jcode-workers** uses jcode as a worker pool through `jw`: ask for exploration, review for a second model family's assessment, and run/resume for task execution. Dependencies: authenticated jcode, `jw`, git, jq and GNU timeout. Read the security boundary below before using review or ask.

**lens** turns a file, feature, flow, diff or architecture into a single-page interactive explainer with real code traces, checkpoints and experiments. Dependencies: Python for lesson building and serving, optionally `claude -p` for Q&A and a browser opener. Screenshots and UI checks use Node, Playwright and Chromium. graphify and jcode can assist exploration but are not required for building a lesson.

**orchestrate** decomposes multi-worker work into cards and waves, routes tasks to Claude agents and jcode workers, and runs verification/fix loops. Dependencies: git, bash, Python, the included five agent definitions and card helpers, plus `crew`, `jw`/jcode and `plan` for their respective execution paths. Saved wave/chain workflows require the Workflow tool and an explicit `args.home` pointing at the user's home directory.

**prd-review** reviews a teammate's PRD on a GitHub pull request and posts the review as one structured PR review, so the PRD owner's plan page imports it as anchored comments. Read-only on the branch; it never approves, merges or requests changes. Dependencies: authenticated `gh` and the `shape` skill's review conventions.

**project-context** maintains a concise, trustworthy root `PROJECT_CONTEXT.md` so future sessions can find the architecture, commands and conventions without rediscovering the whole repository. Dependencies: git and repository read/write tools.

**recall** searches past local Claude Code transcripts for earlier decisions and work. Dependencies: the included Python `recall` CLI and SQLite FTS5. It reads `~/.claude/projects/` and stores a local redacted index under `~/.cache/recall/`; past transcripts are data, not instructions.

**shape** interviews the user, keeps a structured plan through the `plan` CLI and produces an approved, lint-clean PRD for crew or orchestrate. Dependencies: Python and the included shape scripts/`plan` wrapper. HQ provides the optional live plan page, idea-research supplies optional research, and crew/orchestrate receive execution handoffs.

## Toolchain

- **crew** manages background tasks, tmux workers, decisions, ownership and lifecycle operations. Its `crew-*.sh` files are sourced helpers and must remain beside the executable. `crew-check`, `crew-worktree`, `crew-diff` and `crew-notify` supply the surrounding workflow.
- **jw** runs and resumes jcode workers, records orchestration ledgers and board messages, and provides ad-hoc ask/review commands.
- **plan** wraps `skills/shape/scripts/plan.py`; the sibling Python modules validate plans, apply events, render PRDs and export handoffs.
- **recall** provides local transcript indexing, search and reading. Treat the index as private even though it redacts common secret shapes.
- **Hooks** restore the active ledger after compaction, show open crew tasks at session start, deliver prompt answers to crew decisions, and guard dangerous tmux/answer-key operations. `settings.example.json` contains only this wiring and workflow enablement.
- **HQ** is a Claude Code mod with a task board/prompt band and an optional Bun web UI. Its manifest, hooks and tests live under `mods/hq/`. Start the web UI with `bun ~/.claude/mods/hq/web/server.ts`, then open the URL it prints. Run in a terminal, that URL carries the token (`?t=`), so do not share it; run without a terminal (a service or background job), it prints the plain URL and the token file path, and you add `?t=<token>` yourself.
- **idea-research.js** is the saved workflow used by the idea-research skill. Orchestrate also ships saved wave/chain workflows under its own skill directory.

Runtime state belongs under your home directory, not the checkout: crew tasks and orchestration ledgers under `~/.claude/`, local tokens under `~/.config/`, and the recall index under `~/.cache/`.

## Tests

Run from the checkout root after installing the relevant test dependencies. Start with the pure Python suites:

```bash
python3 -m unittest discover -s skills/shape/tests
python3 skills/shape/tests/check_fixtures.py
python3 -m unittest discover -s skills/orchestrate/scripts -p 'test_*.py'
python3 skills/lens/scripts/test-build.py
python3 skills/lens/scripts/test-serve.py
node skills/lens/scripts/test-ask.mjs
node skills/lens/scripts/test-template.mjs
```

Then run the relevant shell, workflow and UI suites:

```bash
bash bin/test-recall.sh
bash hooks/test-guard-tmux-kill.sh
bash bin/test-crew-lifecycle.sh
bash bin/test-jw.sh
bash mods/hq/tests/test-tmux-map.sh
node --test skills/orchestrate/scripts/test_{wave,chain,workflow_harness}.mjs
bun test skills/idea-research/tests
(cd mods/hq && claude plugin test)
bun test mods/hq/web
bun mods/hq/web/tests/plan-page.mjs
node skills/ask-panel/scripts/test-panel.mjs
```

Test dependencies: python3, node, bun, bash, git, tmux, nvim (the `crew-diff` test), the `claude` CLI, and Playwright + Chromium. Browser checks print `skip` and pass without Playwright/Chromium.

The mod plugin tests (`claude plugin test`) need the `claude` CLI. The tests in `mods/hq/tests` import `claude-code/testing`, which only that runner provides, so do not run them with plain `bun test`. Other `bin/test-crew-*.sh` files cover individual crew commands. Read a suite before running it and use a disposable home/session for integration testing, not active work. Claude Code mod checks need the runtime-generated type definitions, which are intentionally not distributed here. Browser checks need Playwright/Chromium and may report a skip when unavailable. The private source repository separately tests the exporter with `bash public/test-export.sh`; export tooling and its private leak rules are not distributed in this repository.

## SECURITY

**Network boundary:** keep HQ web bound to **127.0.0.1 only**. Remote access is only through the opt-in **second loopback listener** (`HQ_WEB_REMOTE_PORT`) intended for `tailscale serve`, with explicitly configured extra hosts and the same token gate. The server refuses a non-loopback bind unless `HQ_WEB_ALLOW_REMOTE=1`; leave it unset. Do not expose the main listener on a LAN/public interface or bypass authentication. The token is stored in `~/.config/hq-web/token`. Host/origin checks and remote route restrictions do not replace keeping the token private.

**Same-user trust:** crew's **“act as the user”** operations and answer delivery, the HQ token file, and `jw review`/`jw ask` trust every process running as the same Unix user. A process with that user's filesystem access can read keys or invoke commands. File modes, prompt instructions and local HTTP authentication do not create isolation between those processes.

In particular, **jcode runs with its normal tools on the content it reads**. Review and default ask include read-only instructions, not a separate read-only operating-system sandbox. Only run `jw review` on **trusted code**. Treat repository files, diffs, transcripts and model output as potential prompt-injection input.

Use Claude Code **Read deny rules** for `~/.config/hq-web/token`, `~/.config/lens/token`, `~/.config/crew/notify.toml` (holds the ntfy token), crew key files under `~/.claude/crew/` (including `.deliver-key`), and `~/.jcode/` authentication material. Enable the Claude Code **sandbox** and apply least-privilege filesystem/network permissions for your environment. Denying Read alone is not sufficient if an unrestricted shell or another same-user process can read the same files. Never put keys, auth files, local settings or transcript state in this repository.

`ask-open` (lens and ask-panel) gives the opened page the lens key, so only open trusted reports with it.

## License

MIT. See `LICENSE`.
