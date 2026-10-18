// End-to-end tests for workflows/wave.js: the script runs for real; only the agents are faked.
// Runner prompts (Setup/Evidence) are executed with the real card-worktree / card-evidence against
// temp git repos, from a process cwd that is a DIFFERENT repo (the Workflow harness launches from
// the session's repo, not the run's target; that mismatch was the bug). Test names say the break caught.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runWorkflow, shellRunner } from './workflow_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(here);
const WAVE = path.join(SKILL_DIR, 'workflows', 'wave.js');
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'wave-')));
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (cwd, ...a) => execFileSync('git', [...IDENT, ...a], { cwd, encoding: 'utf8' }).trim();

function mkRepo(dirName = '') {
  const repo = dirName ? path.join(tmp(), dirName) : tmp();
  if (dirName) mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'f.txt'), 'x');
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-q', '-m', 'base');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

// The session's own repo: the process cwd, which is NOT the run's target.
const launch = mkRepo();
process.chdir(launch.repo);

const card = (id, extra = {}) => ({ id, kind: 'claude', check: `test -f ${id}.txt`, brief: `do ${id}\nmore`, ...extra });
const wtOf = (repo, slug, id) => path.join(repo, '.claude', 'worktrees', `wf-${slug}-${id}`);
const field = (prompt, name) => new RegExp(`^${name}: (.+)$`, 'm').exec(prompt)?.[1];

function commitFile(wt, name) {
  writeFileSync(path.join(wt, name), name);
  git(wt, 'add', name);
  git(wt, 'commit', '-q', '-m', `add ${name}`);
}

// Fake agent. onImpl(id, prompt, opts) answers Implement calls; Setup/Evidence runners really execute.
function fakeAgent(onImpl, onReview = () => ({ findings: [] })) {
  const calls = [];
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    if (opts.phase === 'Setup') {
      const ids = [...prompt.matchAll(/^# (\S+)$/gm)].map((m) => m[1]);
      const outs = shellRunner()(prompt);
      return { results: outs.map((o, i) => ({ id: ids[i], exit_code: o.exit_code, last_line: o.stdout.trim().split('\n').at(-1) ?? '' })) };
    }
    if (opts.phase === 'Evidence') {
      const [o] = shellRunner()(prompt);
      const lines = o.stdout.trim().split('\n');
      const from = lines.indexOf('--- check tail ---');
      const to = lines.indexOf('--- end ---');
      return { exit_code: o.exit_code, last_line: lines.at(-1), tail: from < 0 ? '' : lines.slice(from + 1, to).join('\n') };
    }
    if (opts.phase === 'Review') return onReview(prompt, opts);
    return onImpl(opts.label.split(':')[0], prompt, opts);
  };
  return { agent, calls };
}

async function run(cards, agent, { repo, base, slug = 's', extra = {} }) {
  const logs = [];
  const results = await runWorkflow(WAVE, { args: { slug, repo, base, cards, home: '/home/user', skill_dir: SKILL_DIR, ...extra }, agent, onLog: (m) => logs.push(m) });
  return { results, logs };
}

// A well-behaved implementer: commits <id>.txt in the worktree named in its prompt.
const doer = (id, prompt) => {
  commitFile(field(prompt, 'Worktree'), `${id}.txt`);
  return { status: 'done', summary: `did ${id}`, evidence: 'ok' };
};
const noIsolation = (calls) => assert.deepEqual(calls.filter((c) => 'isolation' in c.opts && c.opts.isolation !== undefined), []);

test('3 Claude cards get worktrees and branches in the TARGET repo (not the process cwd repo), judged done, no agent uses harness isolation', async () => {
  const t = mkRepo();
  const { agent, calls } = fakeAgent(doer);
  const { results, logs } = await run([card('A1'), card('A2'), card('A3')], agent, { ...t });
  for (const id of ['A1', 'A2', 'A3']) {
    const wt = wtOf(t.repo, 's', id);
    assert.ok(existsSync(path.join(wt, `${id}.txt`)), `${id} commit is in the target worktree`);
    assert.equal(git(t.repo, 'rev-list', '--count', `main..wf/s/${id}`), '1');
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), `wf/s/${id}`);
  }
  assert.equal(git(launch.repo, 'worktree', 'list').split('\n').length, 1, 'launch repo got no worktrees');
  assert.deepEqual(results.map((r) => [r.id, r.status, r.commits, r.check, r.branch, r.worktree]), [
    ['A1', 'done', 1, 0, 'wf/s/A1', wtOf(t.repo, 's', 'A1')],
    ['A2', 'done', 1, 0, 'wf/s/A2', wtOf(t.repo, 's', 'A2')],
    ['A3', 'done', 1, 0, 'wf/s/A3', wtOf(t.repo, 's', 'A3')],
  ]);
  assert.equal(calls.filter((c) => c.opts.phase === 'Setup').length, 1, 'one setup runner for all cards');
  assert.equal(calls.filter((c) => c.opts.phase === 'Implement').length, 3);
  assert.equal(calls.filter((c) => c.opts.phase === 'Evidence').length, 3);
  noIsolation(calls);
  const impl = calls.find((c) => c.opts.phase === 'Implement' && c.opts.label.startsWith('A1'));
  assert.ok(impl.prompt.includes(`cd '${wtOf(t.repo, 's', 'A1')}' && `), 'implementer is told to start every command with cd <wt> &&');
  assert.deepEqual(logs, ['wave: 3 done, 0 committed_needs_recheck, 0 failed']);
});

test('a worker that reports failed or nothing after committing is committed_needs_recheck, not failed', async () => {
  const t = mkRepo();
  const { agent } = fakeAgent((id, prompt) => {
    commitFile(field(prompt, 'Worktree'), `${id}.txt`);
    return id === 'B1' ? { status: 'failed', summary: 'ran out of turns' } : null;
  });
  const { results, logs } = await run([card('B1'), card('B2')], agent, { ...t });
  assert.deepEqual(results.map((r) => [r.id, r.status, r.worker_status, r.commits, r.check]), [
    ['B1', 'committed_needs_recheck', 'failed', 1, 0],
    ['B2', 'committed_needs_recheck', null, 1, 0],
  ]);
  assert.ok(results[0].summary.startsWith('COMMITTED, NEEDS RE-CHECK (worker reported failed; 1 commits, check 0): ran out of turns'), results[0].summary);
  assert.ok(results[1].summary.startsWith('COMMITTED, NEEDS RE-CHECK (worker reported nothing; 1 commits, check 0): '), results[1].summary);
  assert.deepEqual(logs, ['wave: 0 done, 2 committed_needs_recheck, 0 failed']);
});

test('a worker that says done but committed nothing is failed with the NO COMMITS prefix', async () => {
  const t = mkRepo();
  const { agent } = fakeAgent(() => ({ status: 'done', summary: 'all good', evidence: 'trust me' }));
  const { results, logs } = await run([card('C1')], agent, { ...t });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].worker_status, 'done');
  assert.equal(results[0].commits, 0);
  assert.equal(results[0].check, 'skipped');
  assert.equal(results[0].summary, 'NO COMMITS beyond base: all good');
  assert.deepEqual(logs, ['wave: 0 done, 0 committed_needs_recheck, 1 failed']);
});

test('a worker that says done and committed but whose check fails is failed with CHECK FAILED and the check tail', async () => {
  const t = mkRepo();
  const { agent } = fakeAgent(doer);
  const { results } = await run([card('D1', { check: 'echo boom-output; false' })], agent, { ...t });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].commits, 1);
  assert.equal(results[0].check, 1);
  assert.equal(results[0].check_tail, 'boom-output');
  assert.equal(results[0].summary, 'CHECK FAILED (exit 1): did D1');
});

test('worktree setup failure fails only that card, with no implementer spent on it', async () => {
  const t = mkRepo();
  const other = path.join(tmp(), 'elsewhere');
  git(t.repo, 'worktree', 'add', '-q', '-b', 'wf/s/E1', other, 'main');
  const { agent, calls } = fakeAgent(doer);
  const { results } = await run([card('E1'), card('E2')], agent, { ...t });
  assert.equal(results[0].status, 'failed');
  assert.ok(results[0].summary.startsWith('worktree setup failed: WORKTREE-ERROR '), results[0].summary);
  assert.deepEqual(results.map((r) => r.status), ['failed', 'done']);
  assert.deepEqual(calls.filter((c) => c.opts.phase === 'Implement').map((c) => c.opts.label.split(':')[0]), ['E2']);
  assert.equal(calls.filter((c) => c.opts.phase === 'Evidence').length, 1, 'no evidence run for the card that was never set up');
});

test('a rerun attaches to the existing branch keeping its old commit, and attempt 2 starts a fresh .a2 branch and worktree', async () => {
  const t = mkRepo();
  // earlier run: one commit on the branch, worktree later removed
  const old = path.join(tmp(), 'old');
  git(t.repo, 'worktree', 'add', '-q', '-b', 'wf/s/R1', old, 'main');
  commitFile(old, 'old.txt');
  git(t.repo, 'worktree', 'remove', '--force', old);

  const { agent } = fakeAgent(doer);
  const first = await run([card('R1', { check: 'test -f old.txt && test -f R1.txt' })], agent, { ...t });
  assert.deepEqual([first.results[0].status, first.results[0].commits, first.results[0].check], ['done', 2, 0]);
  assert.ok(existsSync(path.join(wtOf(t.repo, 's', 'R1'), 'old.txt')));

  const again = fakeAgent((id, prompt) => {  // the .a2 branch already has R1.txt from the first run, so add a new file
    commitFile(field(prompt, 'Worktree'), 'R1-a2.txt');
    return { status: 'done', summary: 'redid R1' };
  });
  const second = await run([card('R1', { attempt: 2, from: 'wf/s/R1', check: 'test -f R1-a2.txt' })], again.agent, { ...t });
  const r = second.results[0];
  assert.deepEqual([r.status, r.commits, r.branch, r.worktree], ['done', 1, 'wf/s/R1.a2', wtOf(t.repo, 's', 'R1.a2')]);
  assert.equal(git(t.repo, 'rev-list', '--count', 'wf/s/R1..wf/s/R1.a2'), '1');
});

test('a jcode card whose runner reports failed (quota) but whose jw branch has a commit is committed_needs_recheck; a risky jcode card is reviewed without isolation', async () => {
  const t = mkRepo();
  const jw = (id) => {
    const wt = path.join(t.repo, '.claude', 'worktrees', `jw-s-${id}`);
    git(t.repo, 'worktree', 'add', '-q', '-b', `jw/s/${id}`, wt, 'main');
    commitFile(wt, `${id}.txt`);
  };
  const { agent, calls } = fakeAgent((id) => {
    jw(id);
    return id === 'J1' ? { status: 'failed', summary: 'jw exit 75: quota' } : { status: 'done', summary: 'jcode did it' };
  });
  const { results, logs } = await run([card('J1', { kind: 'jcode' }), card('J2', { kind: 'jcode', risky: true })], agent, { ...t });
  assert.deepEqual(results.map((r) => [r.id, r.status, r.worker_status, r.commits, r.branch]), [
    ['J1', 'committed_needs_recheck', 'failed', 1, 'jw/s/J1'],
    ['J2', 'done', 'done', 1, 'jw/s/J2'],
  ]);
  assert.equal(calls.filter((c) => c.opts.phase === 'Setup').length, 0, 'jw makes its own worktrees; no setup runner');
  const reviews = calls.filter((c) => c.opts.phase === 'Review');
  assert.equal(reviews.length, 1, 'only the risky card that ended done is reviewed');
  assert.equal(reviews[0].opts.agentType, 'reviewer');
  assert.equal(reviews[0].opts.isolation, undefined);
  assert.ok(reviews[0].prompt.includes(`git -C ${t.repo} diff ${t.base} jw/s/J2`), reviews[0].prompt);
  noIsolation(calls);
  assert.deepEqual(logs, ['wave: 1 done, 1 committed_needs_recheck, 0 failed']);
});

test('shell-hostile characters in a check survive the runner command intact', async () => {
  const t = mkRepo();
  const { agent } = fakeAgent(doer);
  const { results } = await run([card('Q1', { check: `test -f Q1.txt && echo "it's ok" | grep -q 'it'` })], agent, { ...t });
  assert.deepEqual([results[0].status, results[0].check], ['done', 0]);
});

test('F3: when the evidence runner returns nothing a worker that said done is done_with_concerns (never plain done), and a worker with no result is failed', async () => {
  const t = mkRepo();
  const inner = fakeAgent((id, prompt) => (id === 'U1' ? doer(id, prompt) : (doer(id, prompt), null)));
  const agent = (prompt, opts) => (opts.phase === 'Evidence' ? Promise.resolve(null) : inner.agent(prompt, opts));
  const { results } = await run([card('U1'), card('U2')], agent, { ...t });
  assert.deepEqual(results.map((r) => [r.status, r.commits, r.check]), [['done_with_concerns', null, null], ['failed', null, null]]);
  assert.equal(results[0].summary, 'EVIDENCE UNAVAILABLE: did U1');
  assert.equal(results[0].concerns, 'evidence unavailable: commits and check not verified.');
});

test('F3: with evidence unavailable the worker own concerns are kept after the evidence prefix, and a needs_context worker stays needs_context', async () => {
  const t = mkRepo();
  const inner = fakeAgent((id, prompt) => {
    if (id === 'V1') return { status: 'done_with_concerns', summary: 'did V1', concerns: 'shaky parser' };
    return { status: 'needs_context', summary: 'which schema?', concerns: 'schema unknown' };
  });
  const agent = (prompt, opts) => (opts.phase === 'Evidence' ? Promise.resolve(null) : inner.agent(prompt, opts));
  const { results } = await run([card('V1'), card('V2')], agent, { ...t });
  assert.deepEqual(results.map((r) => r.status), ['done_with_concerns', 'needs_context']);
  assert.equal(results[0].concerns, 'evidence unavailable: commits and check not verified. shaky parser');
  assert.equal(results[1].concerns, 'schema unknown');
});

test('F1: a committed branch whose check only passes thanks to an uncommitted file is committed_needs_recheck, not done', async () => {
  const t = mkRepo();
  const { agent } = fakeAgent((id, prompt) => {
    const wt = field(prompt, 'Worktree');
    commitFile(wt, `${id}-partial.txt`);
    writeFileSync(path.join(wt, 'fix.txt'), 'never committed');
    return { status: 'done', summary: `did ${id}` };
  });
  const { results, logs } = await run([card('F1', { check: 'test -f fix.txt' })], agent, { ...t });
  assert.deepEqual([results[0].status, results[0].commits, results[0].dirty, results[0].check], ['committed_needs_recheck', 1, 1, 0]);
  assert.equal(results[0].summary, 'UNCOMMITTED CHANGES (1 files; the check ran on the worktree, not the branch; worker reported done): did F1');
  assert.deepEqual(logs, ['wave: 0 done, 1 committed_needs_recheck, 0 failed']);
});

test('F2: a worktree removed after the commit means the check never ran: committed_needs_recheck with CHECK NOT RUN, not done', async () => {
  const t = mkRepo();
  const { agent } = fakeAgent((id, prompt) => {
    const wt = field(prompt, 'Worktree');
    commitFile(wt, `${id}.txt`);
    git(t.repo, 'worktree', 'remove', '--force', wt);
    return { status: 'done', summary: `did ${id}` };
  });
  const { results } = await run([card('G1')], agent, { ...t });
  assert.deepEqual([results[0].status, results[0].commits, results[0].dirty, results[0].check], ['committed_needs_recheck', 1, -1, 'skipped']);
  assert.equal(results[0].summary, 'CHECK NOT RUN (worktree missing; worker reported done; 1 commits): did G1');
});

test('F4: a target repo path with a space still gives the implementer a cd prefix that works in bash, and setup and evidence work end to end', async () => {
  const t = mkRepo('my repo');
  const seen = [];
  const { agent } = fakeAgent((id, prompt) => {
    const prefix = /with `(cd .*? && )`/.exec(prompt)?.[1];
    const r = spawnSync('bash', ['-c', `${prefix}pwd`], { encoding: 'utf8' });
    seen.push({ prefix, status: r.status, out: r.stdout.trim() });
    return doer(id, prompt);
  });
  const { results } = await run([card('H1')], agent, { ...t });
  const wt = wtOf(t.repo, 's', 'H1');
  assert.deepEqual(seen, [{ prefix: `cd '${wt}' && `, status: 0, out: wt }]);
  assert.deepEqual([results[0].status, results[0].commits, results[0].check], ['done', 1, 0]);
});

// Breaks if wave.js goes back to a hardcoded home: the paths in the runner prompts would not follow args.home.
test('paths in the runner prompts follow args.home: skill scripts for setup and evidence, orchestration dir for jcode briefs and logs', async () => {
  const t = mkRepo();
  const home = tmp();
  mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(SKILL_DIR, path.join(home, '.claude', 'skills', 'orchestrate'));
  const { agent, calls } = fakeAgent((id, prompt) => {
    if (id !== 'J1') return doer(id, prompt);
    const wt = path.join(t.repo, '.claude', 'worktrees', 'jw-s-J1');
    git(t.repo, 'worktree', 'add', '-q', '-b', 'jw/s/J1', wt, 'main');
    commitFile(wt, 'J1.txt');
    return { status: 'done', summary: 'jcode did it' };
  });
  const { results } = await run([card('C1'), card('J1', { kind: 'jcode' })], agent, { ...t, extra: { home: `${home}/`, skill_dir: undefined } });
  assert.deepEqual(results.map((r) => [r.id, r.status]), [['C1', 'done'], ['J1', 'done']]);
  const setup = calls.find((c) => c.opts.phase === 'Setup');
  assert.ok(setup.prompt.includes(`${home}/.claude/skills/orchestrate/scripts/card-worktree `), setup.prompt);
  const evidence = calls.find((c) => c.opts.phase === 'Evidence');
  assert.ok(evidence.prompt.includes(`${home}/.claude/skills/orchestrate/scripts/card-evidence `), evidence.prompt);
  const jcode = calls.find((c) => c.opts.label.startsWith('J1')).prompt;
  assert.ok(jcode.includes(`to ${home}/.claude/orchestration/s/briefs/J1.md.`), jcode);
  assert.ok(jcode.includes(`${home}/.claude/orchestration/s/runs/J1.json`), jcode);
  assert.ok(jcode.includes(`> ${home}/.claude/orchestration/s/notes/J1.run.log`), jcode);
});

test('wave without a usable args.home throws an error naming args.home (also when skill_dir is given)', async () => {
  const t = mkRepo();
  for (const home of [undefined, '', '~', 'relative/home', '/home/A User', '/home/$(id)']) {
    await assert.rejects(run([card('A1')], fakeAgent(doer).agent, { ...t, extra: { home } }), /args\.home/, `home=${home}`);
  }
});
