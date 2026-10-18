export const meta = {
  name: 'orchestrate-chain',
  description: 'Run task cards one after another (same-file work): each step branches from the previous step, gets its HANDOFF, and must pass its check; stops at the first failure',
  whenToUse: 'From /orchestrate, when several small cards touch the same files. args = {slug, id, repo, base, home, cards: [card, ...]}; Claude cards only',
  phases: [
    { title: 'Setup', detail: 'haiku makes the step worktree in the target repo (card-worktree); step n branches from step n-1' },
    { title: 'Step', detail: 'one small Claude worker per card, in order' },
    { title: 'Evidence', detail: 'haiku runs card-evidence: commits, dirty files and the step acceptance check' },
  ],
}

const { slug, id, repo, base } = args
// Scripts cannot read $HOME, so without the test-only args.skill_dir the caller passes args.home (absolute: the runner's Write tool rejects ~ paths).
const HOME = String(args.home ?? '').replace(/\/+$/, '')
if (!args.skill_dir && !HOME.startsWith('/')) throw new Error('args.home is required: the absolute path of the user home directory (e.g. the output of `echo $HOME`)')
if (HOME && !/^\/[\w.\/-]+$/.test(HOME)) throw new Error('args.home must be a plain path of [A-Za-z0-9_./-]: it is pasted unquoted into runner shell commands')
const SKILL = args.skill_dir || `${HOME}/.claude/skills/orchestrate`  // args.skill_dir is test-only; scripts cannot import helpers
const cards = args.cards || []
if (!slug || !id || !base) throw new Error('args.slug, args.id and args.base are required (base = orchestrator HEAD sha from `git rev-parse HEAD`)')
if (!repo) throw new Error('args.repo is required: the absolute path of the target repo the step worktrees are made in')
for (const c of cards) {
  const miss = ['id', 'check', 'brief'].filter(k => !c[k])
  if (miss.length) throw new Error(`card ${c.id || '?'} is missing ${miss.join(', ')} (see templates/task-card.md)`)
  c.concern = c.concern || c.brief.split("\n").find(l => l.trim()).slice(0, 60)
}

const STEP = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'done_with_concerns', 'needs_context', 'blocked', 'failed'] },
    concerns: { type: 'string', description: 'done_with_concerns: the doubts; needs_context: exactly what is missing' },
    summary: { type: 'string', description: '<= 150 words: what changed, anything surprising' },
    evidence: { type: 'string', description: 'each command run + its result, <= 15 lines total' },
    handoff: { type: 'string', description: 'for the next step: done so far, files touched, gotchas, open questions (<= 150 words)' },
    worktree: { type: 'string', description: 'absolute path of the worktree you worked in' },
    branch: { type: 'string' },
    question: { type: 'string', description: 'when blocked: the exact question posted to the board' },
  },
  required: ['status', 'summary', 'handoff', 'worktree', 'branch'],
}
const SETUP = {
  type: 'object',
  properties: {
    exit_code: { type: 'number' },
    last_line: { type: 'string', description: 'the last stdout line of the command, verbatim' },
  },
  required: ['exit_code', 'last_line'],
}
const EVIDENCE = {
  type: 'object',
  properties: {
    exit_code: { type: 'number' },
    last_line: { type: 'string', description: 'the last stdout line of the command, verbatim' },
    tail: { type: 'string', description: 'the lines between "--- check tail ---" and "--- end ---", verbatim; empty when absent' },
  },
  required: ['exit_code', 'last_line', 'tail'],
}

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Judge a step by evidence, not by the worker's claim. First match wins (same rules as wave.js).
function classify(worker, ev) {
  const ws = worker ? worker.status : null
  const text = worker ? worker.summary : 'worker returned nothing (skipped or died)'
  if (!ev) return { status: ws || 'failed', summary: `${text} (evidence: unavailable)` }
  if (ws === 'needs_context' || ws === 'blocked') return { status: ws, summary: text }
  if (ev.commits === 0) return { status: 'failed', summary: `NO COMMITS beyond base: ${text}` }
  if (typeof ev.check === 'number' && ev.check !== 0) return { status: 'failed', summary: `CHECK FAILED (exit ${ev.check}): ${text}` }
  if (ev.check === 'skipped') return { status: 'committed_needs_recheck', summary: `CHECK NOT RUN (worktree missing; worker reported ${ws || 'nothing'}; ${ev.commits} commits): ${text}` }
  if (ev.check === 0 && ev.dirty > 0) return { status: 'committed_needs_recheck', summary: `UNCOMMITTED CHANGES (${ev.dirty} files; the check ran on the worktree, not the branch; worker reported ${ws || 'nothing'}): ${text}` }
  if (ws === 'done' || ws === 'done_with_concerns') return { status: ws, summary: text }
  return {
    status: 'committed_needs_recheck',
    summary: `COMMITTED, NEEDS RE-CHECK (worker reported ${ws || 'nothing'}; ${ev.commits} commits, check ${ev.check}): ${text}`,
  }
}

const steps = []
let from = base
let handoff = ''
for (const [i, c] of cards.entries()) {
  const branch = `wf/${slug}/${id}.${i + 1}`
  const wt = `${repo.replace(/\/+$/, '')}/.claude/worktrees/wf-${slug}-${id}.${i + 1}`
  const label = `${id}.${i + 1} ${c.id}: ${c.concern}`.slice(0, 60)

  const setup = await agent(`Run this command exactly as ONE Bash call and report the result. Do not fix, retry or edit anything.
$ ${SKILL}/scripts/card-worktree ${q(repo)} ${q(branch)} ${q(wt)} ${q(from)}
Return exit_code (the command's exit code) and last_line (its last stdout line, verbatim).`,
    { label: `setup ${id}.${i + 1} ${c.id}`.slice(0, 60), phase: 'Setup', model: 'haiku', effort: 'low', schema: SETUP })
  const setupLine = setup && typeof setup.last_line === 'string' ? setup.last_line.trim() : ''
  if (!setup || setup.exit_code !== 0 || !new RegExp(`^WORKTREE state=\\S+ wt=${esc(wt)} branch=${esc(branch)} `).test(setupLine)) {
    steps.push({ id: c.id, status: 'failed', branch, worktree: wt, summary: `worktree setup failed: ${setup ? setupLine : 'setup runner returned nothing'}`, passed: false })
    break
  }

  const prompt = `You are step ${i + 1} of ${cards.length} in a chain of workers on the same files.
Your worktree: ${wt}
Your branch: ${branch}
The worktree and branch already exist (earlier steps' commits are in it): do not create or switch branches.
Your shell may reset its working directory between calls, so start EVERY Bash command with \`cd ${q(wt)} && \`
(this overrides any worker rule about cd chains). Give Read, Edit and Write absolute paths under ${wt}.
Never edit files outside ${wt}. Run \`git log --oneline ${base}..HEAD\` first to see earlier steps' commits.
Commit on the branch as you go and when the acceptance check passes. Never change git config; if a commit fails for a missing identity, use
  git -c user.name=claude-worker -c user.email=claude-worker@localhost commit ...
Return status, summary, evidence, worktree, branch, and a handoff for the next step.
${handoff ? `\nHANDOFF FROM THE PREVIOUS STEP:\n${handoff}\n` : ''}
CARD ${c.id}
${c.brief}`
  const r = await agent(prompt, {
    label,
    phase: 'Step',
    model: c.model || 'sonnet',
    effort: c.effort,
    schema: STEP,
  })

  const ev = await agent(`Run this command exactly as ONE Bash call with timeout 600000. Do not fix, retry or edit anything.
$ ${SKILL}/scripts/card-evidence ${q(repo)} ${q(from)} ${q(branch)} ${q(wt)} -- ${q(c.check)}
Return exit_code (the command's exit code), last_line (its last stdout line, verbatim) and tail (the lines between
"--- check tail ---" and "--- end ---", verbatim; empty if those markers are absent).`,
    { label: `evidence ${c.id}`, phase: 'Evidence', model: 'haiku', effort: 'low', schema: EVIDENCE })
  const m = ev && ev.exit_code === 0 && typeof ev.last_line === 'string'
    ? /^EVIDENCE commits=(\d+) dirty=(-?\d+) check=(\d+|skipped|none)$/.exec(ev.last_line.trim()) : null
  const facts = m ? { commits: +m[1], dirty: +m[2], check: /^\d+$/.test(m[3]) ? +m[3] : m[3] } : null

  const verdict = classify(r, facts)
  const passed = !!facts && ['done', 'done_with_concerns'].includes(verdict.status)  // no usable evidence = not verified = not passed
  steps.push({
    id: c.id,
    ...(r || {}),
    status: verdict.status,
    summary: verdict.summary,
    worker_status: r ? r.status : null,
    commits: facts ? facts.commits : null,
    dirty: facts ? facts.dirty : null,
    check: facts ? facts.check : null,
    check_tail: facts ? ev.tail || '' : 'evidence unavailable',
    worktree: wt,
    branch,
    passed,
  })
  if (!passed) break  // incl. committed_needs_recheck: later steps must not build on unverified work
  if (verdict.status === 'done_with_concerns') break  // later steps would build on doubted work: the orchestrator decides first
  from = branch
  handoff = r.handoff
}

const done = steps.filter(s => s.passed)
const last = steps[steps.length - 1]
return {
  chain: id,
  branch: done.length ? done[done.length - 1].branch : null,   // merge this one: it contains every passed step
  completed: done.length,
  total: cards.length,
  stopped_at: last && !last.passed ? last.id : null,
  paused_for_concerns: last && last.passed && last.status === 'done_with_concerns' && done.length < cards.length ? last.id : null,
  steps,
}
