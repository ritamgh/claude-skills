// Run a Workflow script (workflows/wave.js, chain.js) outside the Claude Code harness, for unit tests.
// runWorkflow evaluates the script body with the same names the harness provides; the caller supplies a
// fake `agent`. shellRunner lets that fake really execute the card-worktree / card-evidence lines a
// script puts in its runner prompts.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Each item runs its stages in order; stage(prev, item, index), the first stage's prev is the item itself.
// A stage that throws makes that item null and skips its later stages.
async function pipeline(items, ...stages) {
  return Promise.all(items.map(async (item, index) => {
    let prev = item;
    try {
      for (const stage of stages) prev = await stage(prev, item, index);
      return prev;
    } catch {
      return null;
    }
  }));
}

async function parallel(thunks) {
  return Promise.all(thunks.map(async (thunk) => {
    try {
      return await thunk();
    } catch {
      return null;
    }
  }));
}

export async function runWorkflow(scriptPath, { args, agent, onLog } = {}) {
  const body = readFileSync(scriptPath, 'utf8').replace(/^(\s*)export const meta =/m, '$1const meta =');
  const log = (msg) => { if (onLog) onLog(msg); };
  const phase = () => {};
  const fn = new AsyncFunction('args', 'agent', 'pipeline', 'parallel', 'log', 'phase', body);
  return fn(args, agent, pipeline, parallel, log, phase);
}

const HELPER_LINE = /\/scripts\/card-(worktree|evidence) /;

// Returns (prompt) => [{cmd, exit_code, stdout}] for every card-worktree / card-evidence line in the prompt.
export function shellRunner(cwd) {
  return (prompt) => String(prompt).split('\n')
    .filter((line) => HELPER_LINE.test(line))
    .map((line) => line.trim().replace(/^\$ /, ''))
    .map((cmd) => {
      const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: process.env });
      return { cmd, exit_code: r.status ?? 1, stdout: r.stdout };
    });
}
