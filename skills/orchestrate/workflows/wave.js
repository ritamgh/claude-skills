export const meta = {
  name: 'orchestrate-wave',
  description: 'Run independent task cards: worktree in the target repo -> implement -> judge by evidence (commits + check) -> cross-family review for risky cards',
  whenToUse: 'From /orchestrate, for 3+ independent task cards. args = {slug, repo, base, home, cards: [card, ...]}; card format in templates/task-card.md',
  phases: [
    { title: 'Setup', detail: 'one haiku runner makes each Claude card its worktree in the target repo (scripts/card-worktree)' },
    { title: 'Implement', detail: 'one worker per card, own worktree (Claude subagent, or jcode via jw run)' },
    { title: 'Evidence', detail: 'per card: commits, uncommitted files, the card check (scripts/card-evidence); status comes from this, not the worker claim' },
    { title: 'Review', detail: 'risky cards only: reviewer from the other model family' },
  ],
}

const { slug, repo, base } = args
// Scripts cannot read $HOME, so the caller passes it. Absolute: the runner's Write tool rejects ~ paths.
const HOME = String(args.home ?? '').replace(/\/+$/, '')
if (!HOME.startsWith('/')) throw new Error('args.home is required: the absolute path of the user home directory (e.g. the output of `echo $HOME`)')
if (!/^\/[\w.\/-]+$/.test(HOME)) throw new Error('args.home must be a plain path of [A-Za-z0-9_./-]: it is pasted unquoted into runner shell commands')
const ORCH = `${HOME}/.claude/orchestration`
const SKILL = args.skill_dir || `${HOME}/.claude/skills/orchestrate`  // args.skill_dir: tests only
const cards = args.cards || []
if (!slug || !repo || !base) throw new Error('args.slug, args.repo and args.base are required (base = orchestrator HEAD sha from `git rev-parse HEAD`)')
for (const c of cards) {
  const miss = ['id', 'check', 'brief'].filter(k => !c[k])
  if (miss.length) throw new Error(`card ${c.id || '?'} is missing ${miss.join(', ')} (see templates/task-card.md)`)
  c.concern = c.concern || c.brief.split("\n").find(l => l.trim()).slice(0, 60)
}

const IMPL = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'done_with_concerns', 'needs_context', 'blocked', 'failed'] },
    concerns: { type: 'string', description: 'done_with_concerns: the doubts; needs_context: exactly what is missing' },
    summary: { type: 'string', description: '<= 150 words: what changed, anything surprising' },
    evidence: { type: 'string', description: 'each command run + its result, <= 15 lines total' },
    worktree: { type: 'string', description: 'absolute path of the worktree you worked in' },
    branch: { type: 'string' },
    base_sha: { type: 'string' },
    question: { type: 'string', description: 'when blocked: the exact question posted to the board' },
  },
  required: ['status', 'summary'],  // worktree/branch are not trusted: the script sets the expected values
}
const SETUP = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, exit_code: { type: 'integer' }, last_line: { type: 'string' } },
        required: ['id', 'exit_code', 'last_line'],
      },
    },
  },
  required: ['results'],
}
const EVIDENCE = {
  type: 'object',
  properties: {
    exit_code: { type: 'integer' },
    last_line: { type: 'string', description: 'last stdout line, verbatim' },
    tail: { type: 'string', description: 'lines between "--- check tail ---" and "--- end ---", verbatim; empty if none' },
  },
  required: ['exit_code', 'last_line', 'tail'],
}
const REVIEW = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string' },
          issue: { type: 'string' },
        },
        required: ['severity', 'issue'],
      },
    },
  },
  required: ['findings'],
}

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`  // single-quote for the runners' shell
const repoOf = c => (c.repo || repo).replace(/\/+$/, '')
const baseOf = c => c.from || c.base || base  // what the card's branch starts from (and is counted against)
const taskOf = c => c.attempt > 1 ? `${c.id}.a${c.attempt}` : c.id  // jw names its branch and worktree after the task

// Branch a card must end up on. A plain rerun continues it; attempt >= 2 starts over on a new branch from card.from.
function branchOf(c) {
  const b = c.kind === 'jcode' ? `jw/${slug}/${c.id}` : `wf/${slug}/${c.id}`
  return c.attempt > 1 ? `${b}.a${c.attempt}` : b
}
// Worktree the card works in, inside the TARGET repo (the harness's isolation would use the session's repo).
const wtOf = c => `${repoOf(c)}/.claude/worktrees/${c.kind === 'jcode' ? 'jw' : 'wf'}-${slug}-${taskOf(c)}`

// One runner makes every Claude card's worktree; a card is set up only if the WORKTREE line names exactly what we expect.
async function setupWorktrees(todo) {
  const bad = new Map()  // card id -> why not set up
  if (!todo.length) return bad
  const cmds = todo.map(c => `# ${c.id}\n${SKILL}/scripts/card-worktree ${q(repoOf(c))} ${q(branchOf(c))} ${q(wtOf(c))} ${q(baseOf(c))}`).join('\n')
  const r = await agent(`You are a runner. Do not edit anything yourself. Each "# <card id>" line below is followed by that card's command.
Run every command as its own plain Bash call, exactly as written, in order; do not combine them, do not retry.
Return, per card: id, exit_code, and last_line (the last line of its stdout, verbatim).

${cmds}`, { label: 'worktree setup', phase: 'Setup', model: 'haiku', effort: 'low', schema: SETUP })
  const got = new Map(((r && r.results) || []).map(x => [x.id, x]))
  for (const c of todo) {
    const x = got.get(c.id)
    const m = x && x.exit_code === 0 && /^WORKTREE state=(\S+) wt=(.*) branch=(\S+) head=\S+$/.exec(String(x.last_line).trim())
    if (!m || m[2] !== wtOf(c) || m[3] !== branchOf(c)) bad.set(c.id, x ? x.last_line : 'setup runner returned no result for this card')
  }
  return bad
}

function claudeImpl(c) {
  const wt = wtOf(c)
  return `You work in a git worktree that already exists for this card. Do not create or switch branches.
Worktree: ${wt}
Branch: ${branchOf(c)} (already checked out there; it starts from ${baseOf(c)})
The shell may reset its cwd between calls, so start EVERY Bash command with \`cd ${q(wt)} && \` (this overrides the WORKER RULES line about cd chains).
Read, Edit and Write take absolute paths under ${wt}; never edit anything outside it.
Commit on the branch as you go and when the acceptance check passes. Never change git config; if a commit fails for a missing identity, use
  git -c user.name=claude-worker -c user.email=claude-worker@localhost commit ...
Return status, summary and evidence.

${c.brief}`
}

function jcodeImpl(c) {
  const task = taskOf(c)
  const brief = `${ORCH}/${slug}/briefs/${task}.md`
  const log = `${ORCH}/${slug}/notes/${task}.run.log`
  const r = c.repo || repo
  const b = c.from || c.base || base
  return `You are a runner for a jcode (OpenAI) worker. Do not do the task yourself and do not edit the repo.
1. Write the text between the BRIEF markers below, verbatim, to ${brief}.
2. Start the worker with Bash, run_in_background: true:
   rm -f ${log}; ~/.claude/bin/jw run --slug ${slug} --task ${task} --repo ${r} --base ${b} --model ${c.model || 'gpt-6.1-sol'} --timeout ${c.timeout || 2400} ${brief} > ${log} 2>&1; echo "exit=$?" >> ${log}
3. Wait with repeated foreground Bash calls (timeout 560000 ms each) until it finishes:
   timeout 540 bash -c 'until grep -q "^exit=" ${log}; do sleep 15; done'; tail -1 ${log}
4. Read only these: tail -20 ${log}
   jq -r .text ${ORCH}/${slug}/runs/${task}.json | tail -80        # the worker's reply
   ~/.claude/bin/jw board ${slug} --type QUESTION,BLOCKER | grep -F '[${task}]'   # its questions, if any
5. Return: status from the reply's first "STATUS:" line (done, done_with_concerns, needs_context,
   blocked, failed); blocked if it posted a QUESTION or BLOCKER; failed if exit is not 0 or the reply has
   no STATUS line and no passing check. concerns from its "CONCERNS:" line, summary (<= 150 words from
   the reply; if the run timed out, start with "TIMEOUT: worktree may hold uncommitted work"), evidence
   (its EVIDENCE block), worktree ${r}/.claude/worktrees/jw-${slug}-${task}, branch jw/${slug}/${task},
   base_sha ${b}, question if blocked.
---BRIEF START---
${c.brief}
---BRIEF END---`
}

// Stage 1: the worker. A card whose worktree could not be set up is not implemented at all.
async function implement(c) {
  if (setupFailed.has(c.id)) return { skipped: true, w: { status: 'failed', summary: `worktree setup failed: ${setupFailed.get(c.id)}` } }
  const jcode = c.kind === 'jcode'
  const w = await agent(jcode ? jcodeImpl(c) : claudeImpl(c), {
    label: `${c.id}: ${c.concern}`.slice(0, 60),
    phase: 'Implement',
    model: jcode ? 'haiku' : (c.model || 'sonnet'),
    effort: jcode ? undefined : c.effort,
    schema: IMPL,
  })
  return { w }
}

// Pure: the card's status from the worker's claim (w, may be null) and the evidence runner's reply (ev, may be null).
function classify(w, ev) {
  const ws = w ? w.status : null
  const out = { ...(w || {}), worker_status: ws, commits: null, dirty: null, check: null, check_tail: '' }
  const said = w ? w.summary : 'worker returned nothing (skipped or died)'
  const m = /^EVIDENCE commits=(\d+) dirty=(-?\d+) check=(\d+|skipped|none)$/.exec(String((ev && ev.last_line) || '').trim())
  if (!m) {
    if (ws === 'done' || ws === 'done_with_concerns') {  // unverified: never plain done
      return { ...out, status: 'done_with_concerns', concerns: `evidence unavailable: commits and check not verified. ${w.concerns || ''}`.trimEnd(), summary: `EVIDENCE UNAVAILABLE: ${said}` }
    }
    return { ...out, status: ws || 'failed', summary: `EVIDENCE UNAVAILABLE: ${said}` }
  }
  const commits = Number(m[1])
  const check = /^\d+$/.test(m[3]) ? Number(m[3]) : m[3]
  Object.assign(out, { commits, dirty: Number(m[2]), check, check_tail: ev.tail || '' })
  if (ws === 'needs_context' || ws === 'blocked') return { ...out, status: ws, summary: said }
  if (commits === 0) return { ...out, status: 'failed', summary: `NO COMMITS beyond base: ${said}` }
  if (typeof check === 'number' && check !== 0) return { ...out, status: 'failed', summary: `CHECK FAILED (exit ${check}): ${said}` }
  if (check === 'skipped') return { ...out, status: 'committed_needs_recheck', summary: `CHECK NOT RUN (worktree missing; worker reported ${ws || 'nothing'}; ${commits} commits): ${said}` }
  if (check === 0 && out.dirty > 0) return { ...out, status: 'committed_needs_recheck', summary: `UNCOMMITTED CHANGES (${out.dirty} files; the check ran on the worktree, not the branch; worker reported ${ws || 'nothing'}): ${said}` }
  if (ws === 'done' || ws === 'done_with_concerns') return { ...out, status: ws, summary: said }
  return { ...out, status: 'committed_needs_recheck', summary: `COMMITTED, NEEDS RE-CHECK (worker reported ${ws || 'nothing'}; ${commits} commits, check ${check}): ${said}` }
}

// Stage 2: judge by evidence (also when the worker returned nothing). Branch, worktree and base are ours, not the worker's.
async function evidence(s, c) {
  if (s.skipped) return s.w
  const branch = branchOf(c)
  const wt = wtOf(c)
  const b = baseOf(c)
  const ev = await agent(`You are a runner. Do not edit anything. Run this command with one Bash call (timeout 600000 ms), exactly as written:
${SKILL}/scripts/card-evidence ${q(repoOf(c))} ${q(b)} ${q(branch)} ${q(wt)} -- ${q(c.check)}
Return exit_code, last_line (the last line of its stdout, verbatim), and tail (the lines between "--- check tail ---" and "--- end ---", verbatim; empty if there are none).`, {
    label: `evidence ${c.id}`,
    phase: 'Evidence',
    model: 'haiku',
    effort: 'low',
    schema: EVIDENCE,
  })
  return { ...classify(s.w, ev), worktree: wt, branch, base_sha: b }
}

// Stage 3: cross-family review of risky cards that ended done.
async function review(r, c) {
  if (!c.risky || !['done', 'done_with_concerns'].includes(r.status)) return r
  const b = r.base_sha
  const jcode = c.kind === 'jcode'
  const prompt = jcode
    ? `Review one change. The repository is ${repoOf(c)}; do not cd and do not check anything out. Run:
  git -C ${repoOf(c)} diff ${b} ${r.branch}
Read the changed files at that branch with: git -C ${repoOf(c)} show ${r.branch}:<path>
Its concern: ${c.concern}. Report only real, specific correctness issues; no style nits. Empty list if none.`
    : `You are a runner. Run (Bash timeout 600000 ms):
  timeout 590 ~/.claude/bin/jw review --repo ${r.worktree} --base ${b} ${JSON.stringify(c.concern)}
Turn its reply into findings (severity, file, issue). Add nothing of your own. Empty list if it found none.`
  const v = await agent(prompt, {
    label: `review ${c.id}`,
    phase: 'Review',
    model: jcode ? 'sonnet' : 'haiku',
    agentType: jcode ? 'reviewer' : undefined,
    schema: REVIEW,
  })
  return { ...r, review: v ? v.findings : null }
}

const setupFailed = await setupWorktrees(cards.filter(c => c.kind !== 'jcode'))
const results = (await pipeline(cards, implement, evidence, review)).map((r, i) => ({
  id: cards[i].id,
  kind: cards[i].kind,
  ...(r || { status: 'failed', summary: 'a stage threw; see the workflow journal' }),
}))
const tally = s => results.filter(r => r.status === s).length
log('wave: ' + ['done', 'done_with_concerns', 'committed_needs_recheck', 'needs_context', 'blocked', 'failed']
  .filter(s => ['done', 'committed_needs_recheck', 'failed'].includes(s) || tally(s))
  .map(s => `${tally(s)} ${s}`).join(', '))
return results
