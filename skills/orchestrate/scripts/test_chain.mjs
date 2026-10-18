// End-to-end tests for workflows/chain.js against real temp git repos. Each test message names the break it catches.
// The runner agents (setup / evidence) execute the card-worktree / card-evidence lines for real through shellRunner;
// the implementer fake writes and commits a file in the worktree its prompt names.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runWorkflow, shellRunner } from './workflow_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const chainJs = path.join(here, '..', 'workflows', 'chain.js');
const skillDir = path.join(here, '..');
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'chain-')));
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (cwd, ...a) => execFileSync('git', [...ID, ...a], { cwd, encoding: 'utf8' }).trim();

function makeRepo(dirName = '') {
  const repo = dirName ? path.join(tmp(), dirName) : tmp();
  if (dirName) mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'base.txt'), 'base');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

const card = (id, check, brief = `do ${id}`) => ({ id, check, brief });

// behaviours[cardId] = {commit: bool (default true), status: 'done' (default), file: name,
//   uncommitted: name of a file left untracked after the commit, removeWt: remove the worktree after the commit, seen: array to record the cd prefix check}
function makeAgent(runnerCwd, behaviours, calls, evidenceMode) {
  const run = shellRunner(runnerCwd);
  return async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    if (opts.phase === 'Setup') {
      const out = run(prompt);
      assert.equal(out.length, 1, 'setup runner gets exactly one card-worktree command');
      return { exit_code: out[0].exit_code, last_line: out[0].stdout.trim().split('\n').at(-1) };
    }
    if (opts.phase === 'Evidence') {
      if (evidenceMode === 'null') return null;
      if (evidenceMode === 'garbage') return { exit_code: 0, last_line: 'all good, trust me', tail: '' };
      const out = run(prompt);
      assert.equal(out.length, 1, 'evidence runner gets exactly one card-evidence command');
      const lines = out[0].stdout.trim().split('\n');
      const a = lines.indexOf('--- check tail ---');
      const b = lines.indexOf('--- end ---');
      return { exit_code: out[0].exit_code, last_line: lines.at(-1), tail: a >= 0 ? lines.slice(a + 1, b).join('\n') : '' };
    }
    assert.equal(opts.phase, 'Step');
    const cardId = /CARD (\S+)/.exec(prompt)[1];
    const b = { commit: true, status: 'done', ...behaviours[cardId] };
    const wt = /^Your worktree: (.+)$/m.exec(prompt)[1];
    if (b.seen) {
      const prefix = /with `(cd .*? && )`/.exec(prompt)?.[1];
      const r = spawnSync('bash', ['-c', `${prefix}pwd`], { encoding: 'utf8' });
      b.seen.push({ prefix, status: r.status, out: r.stdout.trim() });
    }
    if (b.commit) {
      writeFileSync(path.join(wt, b.file || `${cardId}.txt`), cardId);
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', `work ${cardId}`);
    }
    if (b.uncommitted) writeFileSync(path.join(wt, b.uncommitted), 'never committed');
    if (b.removeWt) git(path.resolve(wt, '..', '..', '..'), 'worktree', 'remove', '--force', wt);
    return { status: b.status, summary: `worker summary ${cardId}`, handoff: `handoff from ${cardId}`, worktree: 'ignored', branch: 'ignored' };
  };
}

// Run chain.js with the process cwd in a DIFFERENT repo than args.repo: the bug was worktrees made in the session repo.
async function runChain({ repo, cards, behaviours = {}, extraArgs = {}, evidenceMode }) {
  const sessionRepo = makeRepo();
  const prev = process.cwd();
  process.chdir(sessionRepo);
  const calls = [];
  try {
    const base = git(repo, 'rev-parse', 'HEAD');
    const result = await runWorkflow(chainJs, {
      args: { slug: 'demo', id: 'c1', repo, base, cards, skill_dir: skillDir, ...extraArgs },
      agent: makeAgent(sessionRepo, behaviours, calls, evidenceMode),
    });
    return { result, calls, sessionRepo, base };
  } finally {
    process.chdir(prev);
  }
}

test('chain makes each step worktree in the TARGET repo from the previous step, judges by evidence, uses no isolation', async () => {
  const repo = makeRepo();
  const { result, calls, sessionRepo } = await runChain({
    repo,
    cards: [card('A', 'test -f A.txt'), card('B', 'test -f A.txt && test -f B.txt')],
  });
  const wt1 = path.join(repo, '.claude', 'worktrees', 'wf-demo-c1.1');
  const wt2 = path.join(repo, '.claude', 'worktrees', 'wf-demo-c1.2');
  assert.ok(existsSync(path.join(wt1, 'A.txt')));
  assert.ok(existsSync(path.join(wt2, 'B.txt')));
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(wt2, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wf/demo/c1.2');
  assert.equal(git(repo, 'branch', '--list', 'wf/demo/c1.2', '--contains', git(repo, 'rev-parse', 'wf/demo/c1.1')), '+ wf/demo/c1.2');
  // nothing leaked into the session repo
  assert.equal(git(sessionRepo, 'worktree', 'list').split('\n').length, 1);
  assert.equal(existsSync(path.join(sessionRepo, '.claude')), false);
  assert.ok(calls.length >= 6);
  for (const c of calls) assert.equal('isolation' in c.opts, false, `agent call ${c.opts.label} must not pass isolation`);
  assert.deepEqual(calls.map((c) => c.opts.phase), ['Setup', 'Step', 'Evidence', 'Setup', 'Step', 'Evidence']);
  // step 2's implementer prompt carries step 1's handoff
  assert.match(calls[4].prompt, /handoff from A/);
  assert.match(calls[1].prompt, /Your worktree: .*wf-demo-c1\.1/);

  assert.equal(result.chain, 'c1');
  assert.equal(result.branch, 'wf/demo/c1.2');
  assert.equal(result.completed, 2);
  assert.equal(result.total, 2);
  assert.equal(result.stopped_at, null);
  assert.equal(result.paused_for_concerns, null);
  assert.deepEqual(result.steps.map((s) => [s.id, s.status, s.worker_status, s.commits, s.dirty, s.check, s.passed, s.branch]), [
    ['A', 'done', 'done', 1, 0, 0, true, 'wf/demo/c1.1'],
    ['B', 'done', 'done', 1, 0, 0, true, 'wf/demo/c1.2'],
  ]);
});

test('chain without args.repo throws an error naming repo (no silent fallback to the session repo)', async () => {
  const repo = makeRepo();
  await assert.rejects(
    runChain({ repo, cards: [card('A', 'true')], extraArgs: { repo: undefined } }),
    /repo/,
  );
});

test('a worker that reports failed after committing, with a passing check, is committed_needs_recheck and stops the chain', async () => {
  const repo = makeRepo();
  const { result, calls } = await runChain({
    repo,
    cards: [card('A', 'test -f A.txt'), card('B', 'true')],
    behaviours: { A: { status: 'failed' } },
  });
  assert.equal(result.completed, 0);
  assert.equal(result.branch, null);
  assert.equal(result.stopped_at, 'A');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].status, 'committed_needs_recheck');
  assert.equal(result.steps[0].worker_status, 'failed');
  assert.equal(result.steps[0].commits, 1);
  assert.equal(result.steps[0].passed, false);
  assert.match(result.steps[0].summary, /^COMMITTED, NEEDS RE-CHECK \(worker reported failed; 1 commits, check 0\): /);
  assert.equal(calls.filter((c) => c.opts.phase === 'Step').length, 1, 'step 2 never runs');
});

test('a step claiming done with no commits beyond its base is failed (NO COMMITS) and stops the chain', async () => {
  const repo = makeRepo();
  const { result } = await runChain({
    repo,
    cards: [card('A', 'true'), card('B', 'true')],
    behaviours: { A: { commit: false } },
  });
  assert.equal(result.completed, 0);
  assert.equal(result.stopped_at, 'A');
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[0].worker_status, 'done');
  assert.equal(result.steps[0].commits, 0);
  assert.equal(result.steps[0].check, 'skipped');
  assert.match(result.steps[0].summary, /^NO COMMITS beyond base: worker summary A/);
});

test('a step whose acceptance check fails is failed with the exit code and tail, stops the chain; branch stays null', async () => {
  const repo = makeRepo();
  const { result } = await runChain({
    repo,
    cards: [card('A', 'echo not-good; exit 3'), card('B', 'true')],
  });
  assert.equal(result.completed, 0);
  assert.equal(result.branch, null);
  assert.equal(result.stopped_at, 'A');
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[0].check, 3);
  assert.equal(result.steps[0].check_tail, 'not-good');
  assert.match(result.steps[0].summary, /^CHECK FAILED \(exit 3\): /);
});

test('step 2 failing its check keeps step 1 as the branch to merge and counts only step 2 own commits', async () => {
  const repo = makeRepo();
  const { result } = await runChain({
    repo,
    cards: [card('A', 'true'), card('B', 'exit 1')],
  });
  assert.equal(result.completed, 1);
  assert.equal(result.branch, 'wf/demo/c1.1');
  assert.equal(result.stopped_at, 'B');
  assert.deepEqual(result.steps.map((s) => [s.id, s.status, s.commits]), [['A', 'done', 1], ['B', 'failed', 1]]);
});

test('rerun: an existing step branch with a commit and no worktree directory is attached and its commit kept', async () => {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'wf/demo/c1.1');
  writeFileSync(path.join(repo, 'earlier.txt'), 'earlier run');
  git(repo, 'add', 'earlier.txt');
  git(repo, 'commit', '-q', '-m', 'earlier run commit');
  git(repo, 'switch', '-q', 'main');
  const { result } = await runChain({
    repo,
    cards: [card('A', 'test -f earlier.txt')],
    behaviours: { A: { commit: false } },
  });
  const wt1 = path.join(repo, '.claude', 'worktrees', 'wf-demo-c1.1');
  assert.ok(existsSync(path.join(wt1, 'earlier.txt')));
  assert.equal(result.completed, 1);
  assert.equal(result.branch, 'wf/demo/c1.1');
  assert.equal(result.steps[0].status, 'done');
  assert.equal(result.steps[0].commits, 1);
});

test('a worktree setup failure fails the step with the setup line and stops the chain without running the implementer', async () => {
  const repo = makeRepo();
  // a plain directory where the worktree must go: card-worktree refuses to touch it
  execFileSync('mkdir', ['-p', path.join(repo, '.claude', 'worktrees', 'wf-demo-c1.1')]);
  const { result, calls } = await runChain({ repo, cards: [card('A', 'true')] });
  assert.equal(result.completed, 0);
  assert.equal(result.stopped_at, 'A');
  assert.equal(result.steps[0].status, 'failed');
  assert.match(result.steps[0].summary, /^worktree setup failed: WORKTREE-ERROR /);
  assert.deepEqual(calls.map((c) => c.opts.phase), ['Setup']);
});

test('a check containing single quotes and spaces reaches card-evidence intact (shell quoting of the runner command)', async () => {
  const repo = makeRepo();
  const { result } = await runChain({ repo, cards: [card('A', `echo "it's fine"; test -f A.txt`)] });
  assert.equal(result.steps[0].status, 'done');
  assert.equal(result.steps[0].check, 0);
  assert.equal(result.steps[0].check_tail, "it's fine");
});

for (const mode of ['null', 'garbage']) {
  test(`a step whose evidence runner returns ${mode} does not pass even when the worker says done: chain stops, step 2 never runs`, async () => {
    const repo = makeRepo();
    const { result, calls } = await runChain({
      repo,
      cards: [card('A', 'true'), card('B', 'true')],
      evidenceMode: mode,
    });
    assert.equal(result.completed, 0);
    assert.equal(result.branch, null);
    assert.equal(result.stopped_at, 'A');
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].status, 'done');
    assert.equal(result.steps[0].passed, false);
    assert.equal(result.steps[0].commits, null);
    assert.equal(result.steps[0].summary, 'worker summary A (evidence: unavailable)');
    assert.equal(calls.filter((c) => c.opts.phase === 'Step').length, 1);
  });
}

test('F1: a step committed but whose check only passes thanks to an uncommitted file is committed_needs_recheck and stops the chain', async () => {
  const repo = makeRepo();
  const { result, calls } = await runChain({
    repo,
    cards: [card('A', 'test -f fix.txt'), card('B', 'true')],
    behaviours: { A: { uncommitted: 'fix.txt' } },
  });
  assert.equal(result.completed, 0);
  assert.equal(result.branch, null);
  assert.equal(result.stopped_at, 'A');
  assert.deepEqual([result.steps[0].status, result.steps[0].commits, result.steps[0].dirty, result.steps[0].check, result.steps[0].passed], ['committed_needs_recheck', 1, 1, 0, false]);
  assert.equal(result.steps[0].summary, 'UNCOMMITTED CHANGES (1 files; the check ran on the worktree, not the branch; worker reported done): worker summary A');
  assert.equal(calls.filter((c) => c.opts.phase === 'Step').length, 1, 'step 2 never runs');
});

test('F2: a step whose worktree vanished after the commit never ran its check: committed_needs_recheck with CHECK NOT RUN, chain stops', async () => {
  const repo = makeRepo();
  const { result } = await runChain({
    repo,
    cards: [card('A', 'true'), card('B', 'true')],
    behaviours: { A: { removeWt: true } },
  });
  assert.equal(result.completed, 0);
  assert.equal(result.stopped_at, 'A');
  assert.deepEqual([result.steps[0].status, result.steps[0].commits, result.steps[0].dirty, result.steps[0].check, result.steps[0].passed], ['committed_needs_recheck', 1, -1, 'skipped', false]);
  assert.equal(result.steps[0].summary, 'CHECK NOT RUN (worktree missing; worker reported done; 1 commits): worker summary A');
});

test('F4: a target repo path with a space still gives each step a cd prefix that works in bash, and the chain runs end to end', async () => {
  const repo = makeRepo('my repo');
  const seen = [];
  const { result } = await runChain({
    repo,
    cards: [card('A', 'test -f A.txt'), card('B', 'test -f B.txt')],
    behaviours: { A: { seen }, B: { seen } },
  });
  const wt1 = path.join(repo, '.claude', 'worktrees', 'wf-demo-c1.1');
  const wt2 = path.join(repo, '.claude', 'worktrees', 'wf-demo-c1.2');
  assert.deepEqual(seen, [
    { prefix: `cd '${wt1}' && `, status: 0, out: wt1 },
    { prefix: `cd '${wt2}' && `, status: 0, out: wt2 },
  ]);
  assert.equal(result.completed, 2);
  assert.deepEqual(result.steps.map((s) => [s.status, s.commits, s.check]), [['done', 1, 0], ['done', 1, 0]]);
});

// Breaks if chain.js goes back to a hardcoded home: the helper script paths would not follow args.home.
test('without args.skill_dir the helper script paths come from args.home', async () => {
  const repo = makeRepo();
  const home = tmp();
  mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(skillDir, path.join(home, '.claude', 'skills', 'orchestrate'));
  const { result, calls } = await runChain({
    repo,
    cards: [card('A', 'test -f A.txt')],
    extraArgs: { skill_dir: undefined, home: `${home}/` },
  });
  assert.equal(result.completed, 1);
  const setup = calls.find((c) => c.opts.phase === 'Setup');
  assert.ok(setup.prompt.includes(`${home}/.claude/skills/orchestrate/scripts/card-worktree `), setup.prompt);
  const evidence = calls.find((c) => c.opts.phase === 'Evidence');
  assert.ok(evidence.prompt.includes(`${home}/.claude/skills/orchestrate/scripts/card-evidence `), evidence.prompt);
});

test('chain with neither args.skill_dir nor a usable args.home throws an error naming args.home', async () => {
  const repo = makeRepo();
  for (const home of [undefined, '', '~', 'relative/home', '/home/A User', '/home/$(id)']) {
    await assert.rejects(
      runChain({ repo, cards: [card('A', 'true')], extraArgs: { skill_dir: undefined, home } }),
      /args\.home/,
      `home=${home}`,
    );
  }
});
