// Smoke tests for workflow_harness.mjs. Each test message names the break it catches.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runWorkflow, shellRunner } from './workflow_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'wfh-')));

const SCRIPT = `export const meta = { name: 'tiny' };
phase('start');
log('begin ' + meta.name);
const staged = await pipeline(args.items,
  (item) => agent('stage1 ' + item),
  (prev, item, i) => { if (item === 'bad') throw new Error('boom'); return prev + '+' + i; });
const side = await parallel([() => agent('p1'), () => { throw new Error('nope'); }, async () => 'ok']);
return { staged, side, name: meta.name };
`;

test('runWorkflow evaluates a script with top-level return, pipeline stages in order, and a throwing stage nulls only that item', async () => {
  const dir = tmp();
  const file = path.join(dir, 'tiny.js');
  writeFileSync(file, SCRIPT);
  const logs = [];
  const prompts = [];
  const result = await runWorkflow(file, {
    args: { items: ['a', 'bad', 'c'] },
    agent: async (prompt) => { prompts.push(prompt); return prompt.toUpperCase(); },
    onLog: (m) => logs.push(m),
  });
  assert.deepEqual(result, {
    staged: ['STAGE1 A+0', null, 'STAGE1 C+2'],
    side: ['P1', null, 'ok'],
    name: 'tiny',
  });
  assert.deepEqual(logs, ['begin tiny']);
  assert.deepEqual(prompts.sort(), ['p1', 'stage1 a', 'stage1 bad', 'stage1 c']);
});

test('a stage that throws skips that item\'s later stages', async () => {
  const dir = tmp();
  const file = path.join(dir, 'skip.js');
  writeFileSync(file, `const seen = [];
await pipeline(['x'], () => { throw new Error('first'); }, () => { seen.push('second'); });
return seen;`);
  const result = await runWorkflow(file, { args: {}, agent: async () => null });
  assert.deepEqual(result, []);
});

test('shellRunner really runs card-worktree lines from a prompt against a temp repo', async () => {
  const repo = tmp();
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'f.txt'), 'x');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'base');
  const wt = path.join(tmp(), 'wts', 'card-a');
  const prompt = [
    'Run these exactly:',
    `   $ ${here}/card-worktree ${repo} card/a ${wt} main`,
    'then report the output. This line mentions card-worktree but not a path.',
  ].join('\n');
  const out = shellRunner(tmp())(prompt);
  assert.equal(out.length, 1);
  assert.equal(out[0].exit_code, 0);
  assert.match(out[0].stdout.trim().split('\n').at(-1), /^WORKTREE state=created wt=\S+ branch=card\/a head=[0-9a-f]{40}$/);
  assert.ok(existsSync(path.join(wt, 'f.txt')));
  assert.match(out[0].cmd, /^\/.*\/scripts\/card-worktree /);
});

test('shellRunner reports a nonzero exit code instead of throwing', async () => {
  const out = shellRunner()(`${here}/card-evidence only-one-arg`);
  assert.equal(out.length, 1);
  assert.equal(out[0].exit_code, 2);
});
