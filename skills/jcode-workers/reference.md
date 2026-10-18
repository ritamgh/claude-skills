# jcode reference (verified 2026-10-04, jcode v0.90.18-dev)

Binary: `~/.cargo/bin/jcode`. Source + docs: the jcode source checkout, if you have one
(`docs/SWARM_ARCHITECTURE.md`, `docs/SWARM_TASK_GRAPH.md`, `docs/MEMORY_ARCHITECTURE.md`,
`docs/HOOKS.md`, debug commands in `crates/jcode-app-core/src/server/debug_help.rs`). Config: `~/.jcode/config.toml`.
Re-verify with `--help` if jcode was upgraded. The upgrade procedure (rebasing local patches,
installing) is in that repo's `PROJECT_CONTEXT.md`.

`jcode run` is served by a daemon spawned from `~/.jcode/builds/stable/jcode` (the `shared-server`
channel is used only when it matches stable or current). To confirm which build a worker ran on,
grep today's `~/.jcode/logs/jcode-<date>.log` for the version hash.

## `jcode run` (headless one-shot)

```
jcode run [-p openai] [-m MODEL] [-C DIR] [--json | --ndjson] [--quiet]
          [--resume SESSION_ID] [--tool-profile full|minimal|none]
          [--tools a,b,c] [--disabled-tools a,b] [--mcp-tools auto|eager|deferred] "<message>"
```

`--json` output (verified):
```json
{"session_id":"session_jaguar_…","provider":"OpenAI","model":"gpt-6.1-sol","text":"…",
 "usage":{"input_tokens":14100,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}
```
- `--resume <session_id>` continues the same session (context retained, verified).
- The message is one argv string: keep briefs < ~100 KB (Linux per-arg limit 128 KB); point to
  files for anything larger.
- Sessions stored in `~/.jcode/sessions/`; `jcode --resume` (no id) lists them;
  `jcode replay <id>` replays one in the TUI; `jcode replay --swarm` shows related swarm sessions.

## Models (`jcode model list -p openai`)

`gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`,
`gpt-5.5`, `gpt-5.6-pro[web]`, `codex-auto-review`, `gpt-reserve`.
`gpt-6.1-sol` is the newest sol (verified working 2026-10-04); there is no 6.1 astra or luna yet. Sol/astra/luna/terra are separate model families, not effort levels. Most support
reasoning effort `low|medium|high|xhigh|max`.

**Effort:** no `jcode run` flag. The global default is `[provider] openai_reasoning_effort = "medium"`
in config. Per-worker effort is available only through the swarm tool's `effort` param or the
TUI `/effort` command.

## Accounts and limits

- OpenAI OAuth accounts: `openai-otter`, `openai-fox` (both Plus).
- `[provider] same_provider_account_failover = true`: jcode switches accounts automatically
  when one is exhausted. There is no per-run account flag.
- `jcode usage --json` → `{providers:[{provider_name, limits:[{name:"5-hour window"|"7-day window",
  usage_percent, resets_at, reset_in}], extra_info:[[k,v],…]}]}`. `jw usage` condenses it.

## Compaction (automatic, nothing to trigger)

`jcode-compaction-core`: token budget 200k by default, compaction at 80%, emergency synchronous
compaction at 95%, keeps the last 10 turns. Live config `[compaction] mode = "semantic"`,
`proactive_floor = 0.40`, `min_turns_between_compactions = 10`. OpenAI native compaction is
`[provider] openai_native_compaction_mode = "auto"`. There is no CLI command to force compaction.

## Swarm (subagents inside jcode)

> **Not usable from `jcode run`** (verified 2026-09-27; v0.90 adds cross-swarm DMs but leaves the member registry unchanged): `spawn` returns `Error: Not in a swarm.` even in a git
> worktree with `JCODE_SWARM_ID` set. The swarm-member registry (`swarm_members`, see
> `crates/jcode-app-core/src/server/comm_control.rs` `require_plan_driver_swarm`) only holds
> sessions attached to the shared server (TUI / daemon). The details below are for reference
> in case the daemon path is enabled later.

The model-side tool is named `swarm`, with an `action` field: `spawn, dm, broadcast, channel,
status, report, assign_task, assign_next, run_plan, propose_plan, approve_plan, …`.
`spawn` params: `label`, `prompt` / `initial_message`, `working_dir`, `model`
(provider-qualified or `inherit`), `effort` (`none|minimal|low|medium|high|xhigh|max`),
`spawn_mode` (`visible|headless|inline|auto`). The config default is
`[agents] swarm_spawn_mode = "visible"`, so ask for `headless` explicitly.
Only the root session may spawn; recursive spawning needs `swarm-deep` mode. Concurrency guard:
`[agents] swarm_max_concurrent_agents = 32` (env `JCODE_SWARM_MAX_CONCURRENT_AGENTS`).
The swarm supports git worktrees natively (see SWARM_ARCHITECTURE.md).

## Daemon + debug socket (opt-in, currently DISABLED)

`jcode debug …` fails with "Debug control is disabled" unless the **server** was started with
`JCODE_DEBUG_CONTROL=1`, or `display.debug_socket` is enabled in config. Setting the env var on
the client alone is not enough (verified). Enabling it changes the user's jcode setup, so
**ask the user first**.

Once enabled: `jcode debug [-S SESSION] [-w] <command>`
- `create_session` / `create_session:<path>`: headless session
- `message:<text>`, `message_async:<text>` (returns a job id), `job_status:<id>`,
  `job_wait:<id>`, `job_cancel:<id>`
- `swarm_message:<text>` / `swarm_message_async:<text>`: plan and run subtasks via swarm workers, then integrate
- `sessions`, `set_model:<m>`, `set_provider:<p>`, `agent:context`, `agent:memory`,
  `trigger_extraction`, `events:subscribe[:types]`, `swarm:members|list|broadcast:<msg>`

`jcode api-bridge [--api-socket PATH | --stdio]` is a stable JSON protocol (CreateSession,
SendMessage, ForkSession, Cancel, …) used by the `@1jehuang/jcode-sdk` TS SDK. Use it for
programmatic multi-session control if parallel `jw run` processes stop being enough.

## Memory

`jcode memory {list,search,export,import,stats}`. Memories are auto-injected into sessions when
relevant (`features.memory = true`). Treat them as jcode's own concern. Put task facts in the
brief, and don't rely on jcode memory.

## Web search

Since v0.90, the `websearch` tool uses the provider's server-side search by default (OpenAI
`web.run`). It works from headless `jcode run` (verified 2026-10-04: a `jw ask` web question returned
the correct, cited answer). Set `JCODE_WEBSEARCH_PREFER_NATIVE=0` or `websearch.prefer_native = false`
to fall back to local search engines.

## Other

- `--tool-profile full|minimal|none`, `--tools <allow-list>` (help's example: `bash,read,write,apply_patch`),
  and `--disabled-tools` restrict a worker. For review-only runs, disabling `write,apply_patch`
  lowers the risk of edits, but `bash` can still write. Rely on `--no-worktree` only for read-only briefs.
- `jcode browser`: browser automation setup (see `docs/BROWSER_FAST_AGENT.md`).
- `jcode ambient …`: background/scheduled agent mode (not used for orchestration).
