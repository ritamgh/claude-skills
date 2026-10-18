// Tests for home/.claude/workflows/idea-research.js. The script is loaded as text, its `export const meta`
// block is stripped, and the body runs inside an AsyncFunction with stub globals (agent, parallel, pipeline,
// phase, log, args). Stubs return canned schema-shaped objects and record every prompt and option set.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT_PATH = join(import.meta.dir, '..', '..', '..', 'workflows', 'idea-research.js')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function scriptBody(): string {
  const lines = readFileSync(SCRIPT_PATH, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith('export const meta'))
  if (start < 0) throw new Error('script has no export const meta line')
  let end = start
  while (lines[end] !== '}') end++
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n')
}

type Call = { prompt: string; opts: any }
type Canned = (call: Call, calls: Call[]) => any

const claim = { claim: 'c', source: 'https://example.test/a', status: 'OPENED' }

function defaultCanned(call: Call): any {
  const label: string = call.opts?.label ?? ''
  if (label.startsWith('research:') || label.startsWith('gap:'))
    return { summary: 's', key_findings: ['f'], load_bearing_claims: [claim], implications: [], open_questions: [] }
  if (label.startsWith('factcheck:') || label.startsWith('gapcheck:'))
    return { verdicts: [{ claim: 'c', verdict: 'confirmed', correction: '', source: 'https://example.test/a' }], notes: 'n' }
  if (label === 'completeness-critic') return { gaps: [], rationale: 'nothing missing' }
  if (label === 'panel-designer') return { personas: ['A buyer', 'An engineer', 'A lawyer', 'An analyst'] }
  if (label.startsWith('eval:'))
    return { persona: 'p', scores: [], gates: [], preferred: 'none', deciding_factor: 'd' }
  if (label === 'synthesis') return { summary: 'sum', verdicts: [] }
  if (label === 'scores-writer') return { written: true }
  throw new Error('unexpected agent label ' + label)
}

async function run(args: any, canned: Canned = defaultCanned) {
  const calls: Call[] = []
  const logs: string[] = []
  const agent = async (prompt: string, opts?: any) => {
    const call = { prompt, opts }
    calls.push(call)
    return canned(call, calls)
  }
  const parallel = (thunks: Array<() => Promise<any>>) => Promise.all(thunks.map((t) => t().catch(() => null)))
  const pipeline = (items: any[], ...stages: any[]) =>
    Promise.all(
      items.map(async (item, i) => {
        try {
          let prev = item
          for (const stage of stages) prev = await stage(prev, item, i)
          return prev
        } catch {
          return null
        }
      }),
    )
  const phases: string[] = []
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', scriptBody())
  let result: any
  let error: Error | undefined
  try {
    result = await fn(args, agent, parallel, pipeline, (t: string) => phases.push(t), (m: string) => logs.push(m))
  } catch (e: any) {
    error = e
  }
  return { result, error, calls, logs, phases }
}

function baseArgs(over: any = {}) {
  return {
    dir: '/tmp/ir-test-out',
    today: '2026-10-17',
    context: 'A regional logistics firm choosing its next product. Read /tmp/ctx/brief.md for the rules.',
    ideas: [
      { id: 'I1', name: 'Landed-cost checkout', pitch: 'Show duties at checkout' },
      { id: 'I2', name: 'Invoice firewall', pitch: 'Block poisoned invoices' },
      { id: 'I3', name: 'Returns concierge', pitch: 'Automate cross-border returns' },
    ],
    criteria: [
      { id: 'K1', name: 'Impact', description: 'Size of the problem solved', weight: 30 },
      { id: 'K2', name: 'Feasibility', description: 'Buildable by two people in four weeks', weight: 20 },
    ],
    gates: [{ id: 'K6', name: 'Sandbox access', description: 'Works with the free test environment' }],
    gate_docs: ['/tmp/ctx/go-no-go.md'],
    depth: 'full',
    ...over,
  }
}

// ---------------------------------------------------------------------------------------------------------
// whole-script parse

test('the whole script parses as an async function body (top-level await and return allowed)', () => {
  expect(() => new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', scriptBody())).not.toThrow()
})

test('meta is a literal block named idea-research with the four phases', () => {
  const text = readFileSync(SCRIPT_PATH, 'utf8')
  expect(text).toContain("name: 'idea-research'")
  for (const title of ['Research', 'Gaps', 'Panel', 'Synthesis']) expect(text).toContain(`title: '${title}'`)
})

// ---------------------------------------------------------------------------------------------------------
// validation: a loosened check in normaliseArgs makes these fail

for (const field of ['dir', 'today', 'context', 'ideas', 'criteria']) {
  test(`missing ${field} throws naming the field and runs no agent`, async () => {
    const args: any = baseArgs()
    delete args[field]
    const { error, calls } = await run(args)
    expect(error?.message).toContain(field)
    expect(calls.length).toBe(0)
  })
}

test('non-absolute dir throws naming dir', async () => {
  const { error, calls } = await run(baseArgs({ dir: 'relative/out' }))
  expect(error?.message).toContain('dir')
  expect(calls.length).toBe(0)
})

for (const today of ['17-10-2026', '2026-1-7', '2026-13-01', '2026-02-30', 'today']) {
  test(`bad today "${today}" throws naming today`, async () => {
    const { error, calls } = await run(baseArgs({ today }))
    expect(error?.message).toContain('today')
    expect(calls.length).toBe(0)
  })
}

test('duplicate idea ids throw naming ideas', async () => {
  const ideas = [
    { id: 'I1', name: 'a', pitch: '' },
    { id: 'I1', name: 'b', pitch: '' },
  ]
  const { error, calls } = await run(baseArgs({ ideas }))
  expect(error?.message).toContain('ideas[1].id')
  expect(calls.length).toBe(0)
})

test('idea ids that collide once made file-safe throw naming ideas', async () => {
  const ideas = [
    { id: 'I 1', name: 'a' },
    { id: 'i-1', name: 'b' },
  ]
  const { error, calls } = await run(baseArgs({ ideas }))
  expect(error?.message).toContain('ideas[1].id')
  expect(calls.length).toBe(0)
})

test('more than 8 ideas throws naming ideas', async () => {
  const ideas = Array.from({ length: 9 }, (_, i) => ({ id: `I${i + 1}`, name: `n${i}` }))
  const { error, calls } = await run(baseArgs({ ideas }))
  expect(error?.message).toContain('ideas')
  expect(error?.message).toContain('8')
  expect(calls.length).toBe(0)
})

test('empty criteria throws naming criteria', async () => {
  const { error, calls } = await run(baseArgs({ criteria: [] }))
  expect(error?.message).toContain('criteria')
  expect(calls.length).toBe(0)
})

test('a criterion id reused as a gate id throws naming gates', async () => {
  const { error, calls } = await run(baseArgs({ gates: [{ id: 'K1', name: 'dup' }] }))
  expect(error?.message).toContain('gates[0].id')
  expect(calls.length).toBe(0)
})

test('bad depth throws naming depth', async () => {
  const { error } = await run(baseArgs({ depth: 'medium' }))
  expect(error?.message).toContain('depth')
})

test('non-boolean dry_run throws naming dry_run', async () => {
  const { error } = await run(baseArgs({ dry_run: 'yes' }))
  expect(error?.message).toContain('dry_run')
})

test('relative gate_docs path throws naming gate_docs', async () => {
  const { error, calls } = await run(baseArgs({ gate_docs: ['notes.md'] }))
  expect(error?.message).toContain('gate_docs[0]')
  expect(calls.length).toBe(0)
})

// ---------------------------------------------------------------------------------------------------------
// dry run and topic generation

test('full dry run for 3 ideas + 1 gate doc returns the literal plan and runs no agent', async () => {
  const { result, calls } = await run(baseArgs({ dry_run: true }))
  expect(calls.length).toBe(0)
  expect(result.dry_run).toBe(true)
  expect(result.topics.map((t: any) => t.key)).toEqual([
    'ctx-rules',
    'ctx-precedents',
    'ctx-competition',
    'ctx-platform',
    'ctx-strategy',
    'i1-feasibility',
    'i1-evidence',
    'i1-landscape',
    'i2-feasibility',
    'i2-evidence',
    'i2-landscape',
    'i3-feasibility',
    'i3-evidence',
    'i3-landscape',
    'gates-1',
  ])
  expect(result.topics.every((t: any) => typeof t.title === 'string' && t.title.length > 0)).toBe(true)
  expect(result.agents).toEqual({
    research: 15,
    factcheck: 15,
    critic: 1,
    gap_max: 6,
    designer: 1,
    evaluators: 8,
    synthesis: 1,
    scores_writer: 1,
    total_max: 54,
  })
  expect(result.models).toEqual({ sonnet: 43, opus: 11 })
})

test('quick dry run for 3 ideas + 1 gate doc collapses topics, drops the gap round, uses 3 evaluators', async () => {
  const { result, calls } = await run(baseArgs({ dry_run: true, depth: 'quick' }))
  expect(calls.length).toBe(0)
  expect(result.topics.map((t: any) => t.key)).toEqual([
    'ctx-rules',
    'ctx-landscape',
    'i1-scan',
    'i2-scan',
    'i3-scan',
    'gates-1',
  ])
  expect(result.agents).toEqual({
    research: 6,
    factcheck: 6,
    critic: 0,
    gap_max: 0,
    designer: 0,
    evaluators: 3,
    synthesis: 1,
    scores_writer: 1,
    total_max: 17,
  })
  expect(result.models).toEqual({ sonnet: 13, opus: 4 })
})

test('gates without gate_docs produce one gates topic; neither produces none', async () => {
  const a = await run(baseArgs({ dry_run: true, depth: 'quick', gate_docs: [] }))
  expect(a.result.topics.map((t: any) => t.key)).toEqual(['ctx-rules', 'ctx-landscape', 'i1-scan', 'i2-scan', 'i3-scan', 'gates'])
  const b = await run(baseArgs({ dry_run: true, depth: 'quick', gate_docs: [], gates: [] }))
  expect(b.result.topics.map((t: any) => t.key)).toEqual(['ctx-rules', 'ctx-landscape', 'i1-scan', 'i2-scan', 'i3-scan'])
})

test('two gate docs give gates-1 and gates-2', async () => {
  const { result } = await run(baseArgs({ dry_run: true, depth: 'quick', gate_docs: ['/a.md', '/b.md'] }))
  expect(result.topics.map((t: any) => t.key).slice(-2)).toEqual(['gates-1', 'gates-2'])
})

test('idea ids are made file-safe in topic keys', async () => {
  const { result } = await run(
    baseArgs({ dry_run: true, depth: 'quick', gate_docs: [], gates: [], ideas: [{ id: 'Idea #1/a', name: 'x' }] }),
  )
  expect(result.topics.map((t: any) => t.key)).toEqual(['ctx-rules', 'ctx-landscape', 'idea-1-a-scan'])
})

test('args.topics replaces the generated topics', async () => {
  const topics = [{ key: 'My Topic', title: 'One question', prompt: 'Find the answer.' }]
  const { result, calls } = await run(baseArgs({ dry_run: true, topics }))
  expect(calls.length).toBe(0)
  expect(result.topics).toEqual([{ key: 'my-topic', title: 'One question' }])
  expect(result.agents.research).toBe(1)
  expect(result.agents.factcheck).toBe(1)
})

test('args.evaluators skips the panel designer and adds skeptic and literal reader', async () => {
  const { result } = await run(baseArgs({ dry_run: true, evaluators: ['An investor', 'A customer'] }))
  expect(result.agents.designer).toBe(0)
  expect(result.agents.evaluators).toBe(4)
})

// ---------------------------------------------------------------------------------------------------------
// real run: prompts, models, scores

// quick-mode canned evaluator answers: each evaluator scores per the table below.
// I1/K1 [4,3,5] -> 4 ; I1/K2 [3,4] (evaluator 3 omits it) -> 3.5 ; I2/K1 [2,2,3] -> 2.3 ; I3/K1 [5,5,5] -> 5
// I1/K6 [pass,fail,pass] -> true ; I2/K6 [pass,fail,unknown] -> null (tie) ; I3/K6 [fail,fail,unknown] -> false
const evalScript: Record<number, any> = {
  1: {
    persona: 'buyer',
    scores: [
      { idea_id: 'I1', criterion_id: 'K1', score: 4, reason: 'Clear pain', sources: ['https://example.test/a', 'not a url'] },
      { idea_id: 'I1', criterion_id: 'K2', score: 3, reason: 'Doable', sources: [] },
      { idea_id: 'I2', criterion_id: 'K1', score: 2, reason: 'Small market', sources: ['https://example.test/b'] },
      { idea_id: 'I3', criterion_id: 'K1', score: 5, reason: 'Huge', sources: [] },
    ],
    gates: [
      { idea_id: 'I1', gate_id: 'K6', verdict: 'pass', reason: 'Sandbox exists', sources: ['https://example.test/g'] },
      { idea_id: 'I2', gate_id: 'K6', verdict: 'pass', reason: 'Works', sources: [] },
      { idea_id: 'I3', gate_id: 'K6', verdict: 'fail', reason: 'No sandbox', sources: [] },
    ],
    preferred: 'I3',
    deciding_factor: 'size',
  },
  2: {
    persona: 'skeptic',
    scores: [
      { idea_id: 'I1', criterion_id: 'K1', score: 3, reason: 'Crowded', sources: ['https://example.test/a'] },
      { idea_id: 'I1', criterion_id: 'K2', score: 4, reason: 'Fine', sources: [] },
      { idea_id: 'I2', criterion_id: 'K1', score: 2, reason: 'Niche', sources: [] },
      { idea_id: 'I3', criterion_id: 'K1', score: 5, reason: 'Big', sources: [] },
    ],
    gates: [
      { idea_id: 'I1', gate_id: 'K6', verdict: 'fail', reason: 'Rate limits', sources: [] },
      { idea_id: 'I2', gate_id: 'K6', verdict: 'fail', reason: 'Blocked', sources: [] },
      { idea_id: 'I3', gate_id: 'K6', verdict: 'fail', reason: 'Still none', sources: [] },
    ],
    preferred: 'I3',
    deciding_factor: 'flaw',
  },
  3: {
    persona: 'literal',
    scores: [
      { idea_id: 'I1', criterion_id: 'K1', score: 5, reason: 'Meets text', sources: [] },
      { idea_id: 'I2', criterion_id: 'K1', score: 3, reason: 'Partial', sources: [] },
      { idea_id: 'I3', criterion_id: 'K1', score: 5, reason: 'Meets text', sources: [] },
    ],
    gates: [
      { idea_id: 'I1', gate_id: 'K6', verdict: 'pass', reason: 'Ok', sources: [] },
      { idea_id: 'I2', gate_id: 'K6', verdict: 'unknown', reason: 'No data', sources: [] },
      { idea_id: 'I3', gate_id: 'K6', verdict: 'unknown', reason: 'No data', sources: [] },
    ],
    preferred: 'I1',
    deciding_factor: 'text',
  },
}

function scriptedCanned(call: Call): any {
  const label: string = call.opts?.label ?? ''
  if (label.startsWith('eval:')) return evalScript[Number(label.slice(5))]
  if (label === 'synthesis')
    return {
      summary: 'Pick I3.',
      verdicts: [
        { idea_id: 'I1', verdict: 'Solid but crowded' },
        { idea_id: 'I2', verdict: 'Too niche' },
        { idea_id: 'I3', verdict: 'Biggest upside, no sandbox yet' },
      ],
    }
  return defaultCanned(call)
}

function writerJson(calls: Call[]): any {
  const w = calls.find((c) => c.opts?.label === 'scores-writer')!
  const m = /<<<JSON\n([\s\S]*?)\nJSON>>>/.exec(w.prompt)
  expect(m).not.toBeNull()
  return JSON.parse(m![1])
}

test('quick run: scores.json content equals the hand-computed means and gate majorities', async () => {
  const { result, error, calls } = await run(baseArgs({ depth: 'quick' }), scriptedCanned)
  expect(error).toBeUndefined()
  expect(writerJson(calls)).toEqual({
    today: '2026-10-17',
    report: '/tmp/ir-test-out/REPORT.md',
    ideas: {
      I1: {
        verdict: 'Solid but crowded',
        scores: {
          K1: { value: 4, label: 'Strong', rationale: 'Clear pain | Crowded | Meets text', sources: ['https://example.test/a'] },
          K2: { value: 3.5, label: 'Strong', rationale: 'Doable | Fine', sources: [] },
        },
        gates: {
          K6: { pass: true, note: 'Sandbox exists | Rate limits | Ok', sources: ['https://example.test/g'] },
        },
      },
      I2: {
        verdict: 'Too niche',
        scores: {
          K1: { value: 2.3, label: 'Weak', rationale: 'Small market | Niche | Partial', sources: ['https://example.test/b'] },
        },
        gates: { K6: { pass: null, note: 'Works | Blocked | No data', sources: [] } },
      },
      I3: {
        verdict: 'Biggest upside, no sandbox yet',
        scores: {
          K1: { value: 5, label: 'Excellent', rationale: 'Huge | Big | Meets text', sources: [] },
        },
        gates: { K6: { pass: false, note: 'No sandbox | Still none | No data', sources: [] } },
      },
    },
  })
  expect(result.report).toBe('/tmp/ir-test-out/REPORT.md')
  expect(result.scores_file).toBe('/tmp/ir-test-out/scores.json')
  expect(result.agents.total).toBe(17)
  expect(result.gaps).toEqual([])
  expect(result.topics).toEqual(['ctx-rules', 'ctx-landscape', 'i1-scan', 'i2-scan', 'i3-scan', 'gates-1'])
})

test('the writer is told to write the exact JSON to scores.json', async () => {
  const { calls } = await run(baseArgs({ depth: 'quick' }), scriptedCanned)
  const w = calls.find((c) => c.opts?.label === 'scores-writer')!
  expect(w.prompt).toContain('/tmp/ir-test-out/scores.json')
  expect(w.opts.model).toBe('sonnet')
})

test('the synthesis prompt carries the script-built scorecard so numbers are not invented', async () => {
  const { calls } = await run(baseArgs({ depth: 'quick' }), scriptedCanned)
  const s = calls.find((c) => c.opts?.label === 'synthesis')!
  expect(s.prompt).toContain('/tmp/ir-test-out/REPORT.md')
  expect(s.prompt).toContain('| E1 | 4 | 3 |')
  expect(s.prompt).toContain('| Mean | 4 | 3.5 |')
})

test('every agent call passes an explicit model and an effort', async () => {
  const { calls } = await run(baseArgs(), scriptedCanned)
  expect(calls.length).toBeGreaterThan(30)
  for (const c of calls) {
    expect(['sonnet', 'opus']).toContain(c.opts?.model)
    expect(typeof c.opts?.effort).toBe('string')
  }
  const model = (prefix: string) => calls.filter((c) => c.opts.label.startsWith(prefix)).map((c) => c.opts.model)
  expect(new Set(model('research:'))).toEqual(new Set(['sonnet']))
  expect(new Set(model('factcheck:'))).toEqual(new Set(['sonnet']))
  expect(new Set(model('eval:'))).toEqual(new Set(['opus']))
  expect(model('synthesis')).toEqual(['opus'])
  expect(model('completeness-critic')).toEqual(['opus'])
})

test('every schema is valid for the runtime: object root, required within properties', async () => {
  const { calls } = await run(baseArgs(), scriptedCanned)
  const schemas = calls.map((c) => c.opts.schema).filter(Boolean)
  expect(schemas.length).toBeGreaterThan(10)
  for (const s of schemas) {
    expect(s.type).toBe('object')
    for (const r of s.required ?? []) expect(Object.keys(s.properties)).toContain(r)
  }
})

test('evaluator schema is keyed by this run idea, criterion and gate ids', async () => {
  const { calls } = await run(baseArgs({ depth: 'quick' }), scriptedCanned)
  const ev = calls.find((c) => c.opts.label === 'eval:1')!.opts.schema
  expect(ev.properties.scores.items.properties.idea_id.enum).toEqual(['I1', 'I2', 'I3'])
  expect(ev.properties.scores.items.properties.criterion_id.enum).toEqual(['K1', 'K2'])
  expect(ev.properties.gates.items.properties.gate_id.enum).toEqual(['K6'])
  expect(ev.properties.scores.items.properties.score.minimum).toBe(1)
  expect(ev.properties.scores.items.properties.score.maximum).toBe(5)
})

test('freshness: every prompt carries args.today and no other YYYY-MM-DD date', async () => {
  const { calls } = await run(baseArgs({ today: '2031-03-09' }), scriptedCanned)
  const checked = calls.filter((c) => /^(research|factcheck|gap|gapcheck|eval):|^(completeness-critic|panel-designer|synthesis)$/.test(c.opts.label))
  expect(checked.length).toBeGreaterThan(30)
  for (const c of checked) {
    expect(c.prompt).toContain('2031-03-09')
    expect(c.prompt).toContain('OPENED')
    const dates = c.prompt.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []
    expect(dates.filter((d) => d !== '2031-03-09')).toEqual([])
  }
})

test('no prompt tells the agent to spawn subagents, and each says not to', async () => {
  const { calls } = await run(baseArgs(), scriptedCanned)
  for (const c of calls.filter((c) => c.opts.label !== 'scores-writer')) expect(c.prompt).toContain('Do not spawn subagents')
})

test('no prompt contains the names of the project this was generalised from', async () => {
  const { calls } = await run(baseArgs(), scriptedCanned)
  for (const c of calls) {
    expect(c.prompt).not.toMatch(/demo-hackathon/i)
    expect(c.prompt).not.toMatch(/hackathon/i)
  }
})

test('gate doc topic tells the agent to read the doc and treat its criteria as gates', async () => {
  const { calls } = await run(baseArgs({ depth: 'quick' }), scriptedCanned)
  const g = calls.find((c) => c.opts.label === 'research:gates-1')!
  expect(g.prompt).toContain('/tmp/ctx/go-no-go.md')
  expect(g.prompt).toContain('GATES')
  expect(g.prompt).toContain('/tmp/ir-test-out/gates-1.md')
})

test('full run: critic gaps are capped at 6 and each gap is researched and fact-checked', async () => {
  const canned: Canned = (call) => {
    if (call.opts.label === 'completeness-critic')
      return {
        gaps: Array.from({ length: 8 }, (_, i) => ({ key: `g${i + 1}-x`, title: `Gap ${i + 1}`, prompt: `Look into ${i + 1}` })),
        rationale: 'missing pieces',
      }
    return scriptedCanned(call)
  }
  const { result, calls, logs } = await run(baseArgs(), canned)
  expect(calls.filter((c) => c.opts.label.startsWith('gap:')).length).toBe(6)
  expect(calls.filter((c) => c.opts.label.startsWith('gapcheck:')).length).toBe(6)
  expect(result.gaps).toEqual(['Gap 1', 'Gap 2', 'Gap 3', 'Gap 4', 'Gap 5', 'Gap 6'])
  expect(logs.some((l) => l.includes('dropped 2'))).toBe(true)
})

test('quick run never calls the critic or the panel designer', async () => {
  const { calls } = await run(baseArgs({ depth: 'quick' }), scriptedCanned)
  const labels = calls.map((c) => c.opts.label)
  expect(labels).not.toContain('completeness-critic')
  expect(labels).not.toContain('panel-designer')
  expect(labels.filter((l) => l.startsWith('eval:')).length).toBe(3)
})

test('full run without args.evaluators uses designer personas plus skeptic and literal reader', async () => {
  const { calls } = await run(baseArgs(), scriptedCanned)
  const evals = calls.filter((c) => c.opts.label.startsWith('eval:'))
  expect(evals.length).toBe(6)
  expect(evals[0].prompt).toContain('A buyer')
  expect(evals[4].prompt.toLowerCase()).toContain('fatal flaw')
  expect(evals[5].prompt.toLowerCase()).toContain('only against the written criteria')
})

test('a research agent that fails does not stop the run and its topic is logged', async () => {
  const canned: Canned = (call) => (call.opts.label === 'research:ctx-rules' ? null : scriptedCanned(call))
  const { error, logs, calls } = await run(baseArgs({ depth: 'quick' }), canned)
  expect(error).toBeUndefined()
  expect(logs.some((l) => l.includes('ctx-rules'))).toBe(true)
  expect(calls.some((c) => c.opts.label === 'factcheck:ctx-rules')).toBe(false)
})

test('when every evaluator fails the run throws instead of writing empty scores', async () => {
  const canned: Canned = (call) => (call.opts.label.startsWith('eval:') ? null : scriptedCanned(call))
  const { error, calls } = await run(baseArgs({ depth: 'quick' }), canned)
  expect(error?.message).toContain('evaluator')
  expect(calls.some((c) => c.opts.label === 'scores-writer')).toBe(false)
})

// ---------------------------------------------------------------------------------------------------------
// review fixes

// One vote per evaluator: aggregate() counting every returned row lets one evaluator's duplicate rows
// outvote the others (3x 5/pass vs 1/fail and 1/fail gave 3.4/pass instead of 2.3/fail).
test('an evaluator returning duplicate rows still casts one score vote and one gate vote', async () => {
  const row = (score: number, verdict: string) => ({
    scores: [{ idea_id: 'I1', criterion_id: 'K1', score, reason: `s${score}`, sources: [] }],
    gates: [{ idea_id: 'I1', gate_id: 'K6', verdict, reason: `g${verdict}`, sources: [] }],
  })
  const canned: Canned = (call) => {
    const label: string = call.opts.label
    if (label === 'eval:1') {
      const one = row(5, 'pass')
      return { persona: 'p', preferred: 'I1', deciding_factor: 'd', scores: [...one.scores, ...one.scores, ...one.scores], gates: [...one.gates, ...one.gates, ...one.gates] }
    }
    if (label.startsWith('eval:')) return { persona: 'p', preferred: 'I1', deciding_factor: 'd', ...row(1, 'fail') }
    return scriptedCanned(call)
  }
  const { calls } = await run(
    baseArgs({
      depth: 'quick',
      ideas: [{ id: 'I1', name: 'Only idea' }],
      criteria: [{ id: 'K1', name: 'Impact', weight: 10 }],
    }),
    canned,
  )
  const ent = writerJson(calls).ideas.I1
  expect(ent.scores.K1.value).toBe(2.3)
  expect(ent.scores.K1.rationale).toBe('s5 | s1 | s1')
  expect(ent.gates.K6.pass).toBe(false)
})

// Finalization must fail loudly: reporting success with no REPORT.md or no scores.json makes the caller
// write research_status done for a run that produced nothing.
test('a null synthesis throws naming the output dir and writes no scores', async () => {
  const canned: Canned = (call) => (call.opts.label === 'synthesis' ? null : scriptedCanned(call))
  const { error, calls } = await run(baseArgs({ depth: 'quick' }), canned)
  expect(error?.message).toContain('synthesis')
  expect(error?.message).toContain('/tmp/ir-test-out')
  expect(calls.some((c) => c.opts.label === 'scores-writer')).toBe(false)
})

for (const [name, answer] of [['written:false', { written: false }], ['null', null]] as const) {
  test(`a scores-writer that returns ${name} throws naming the output dir`, async () => {
    const canned: Canned = (call) => (call.opts.label === 'scores-writer' ? answer : scriptedCanned(call))
    const { error } = await run(baseArgs({ depth: 'quick' }), canned)
    expect(error?.message).toContain('scores.json')
    expect(error?.message).toContain('/tmp/ir-test-out')
  })
}

// Ids become object keys of the scores map; __proto__ as a key is silently dropped by JSON/object literals.
for (const bad of ['__proto__', 'constructor', 'prototype']) {
  test(`id "${bad}" is rejected in ideas, criteria and gates naming the field`, async () => {
    const a = await run(baseArgs({ ideas: [{ id: bad, name: 'x' }] }))
    expect(a.error?.message).toContain('ideas[0].id')
    const b = await run(baseArgs({ criteria: [{ id: bad, name: 'x' }] }))
    expect(b.error?.message).toContain('criteria[0].id')
    const c = await run(baseArgs({ gates: [{ id: bad, name: 'x' }] }))
    expect(c.error?.message).toContain('gates[0].id')
    expect(a.calls.length + b.calls.length + c.calls.length).toBe(0)
  })
}

// SKILL.md event loop: run the real bash block against a stub `plan` that fails one score event.
// If a failed event is swallowed (loop exits 0, done sent anyway), the last research_status is "done".
function skillBlock(): string {
  const md = readFileSync(join(import.meta.dir, '..', 'SKILL.md'), 'utf8')
  const m = /```bash\n([\s\S]*?)\n```/.exec(md)
  if (!m) throw new Error('SKILL.md has no bash block')
  return m[1]
}

function runSkillLoop(failOn: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'ir-skill-'))
  const log = join(dir, 'events.log')
  const stub = join(dir, 'plan')
  writeFileSync(
    stub,
    `#!/bin/bash\njson=""\nwhile [ $# -gt 0 ]; do [ "$1" = "--json" ] && json="$2"; shift; done\necho "$json" >> "${log}"\n` +
      (failOn ? `case "$json" in *'${failOn}'*) echo "invalid event" >&2; exit 2;; esac\n` : '') +
      `echo '{"summary":"ok"}'\n`,
  )
  chmodSync(stub, 0o755)
  writeFileSync(
    join(dir, 'scores.json'),
    JSON.stringify({
      today: '2026-10-17',
      report: `${dir}/REPORT.md`,
      ideas: {
        I1: {
          verdict: 'v',
          scores: { K1: { value: 4, label: 'Strong', rationale: 'r', sources: ['https://example.test/a'] }, K2: { value: 3.5, label: 'Strong', rationale: 'r', sources: [] } },
          gates: { K6: { pass: null, note: 'n', sources: [] } },
        },
      },
    }),
  )
  const r = spawnSync('bash', ['-c', skillBlock()], { env: { ...process.env, PLAN: stub, T: 'T-1', RS: 'RS1', RUN: 'wf-1', D: dir }, encoding: 'utf8' })
  const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  rmSync(dir, { recursive: true, force: true })
  return { r, events, dir }
}

test('SKILL loop: all events accepted -> running, three score events, then done with the report path', () => {
  const { events, dir } = runSkillLoop(null)
  expect(events.map((e) => e.type)).toEqual(['research_status', 'score', 'score', 'score', 'research_status'])
  expect(events[0]).toEqual({ type: 'research_status', node: 'RS1', state: 'running', run: 'wf-1' })
  expect(events[1]).toEqual({ type: 'score', node: 'I1', rubric: 'K1', value: 4, label: 'Strong', rationale: 'r', sources: ['https://example.test/a'], basis: 'research' })
  expect(events[3]).toEqual({ type: 'score', node: 'I1', rubric: 'K6', pass: null, rationale: 'n', sources: [], basis: 'research' })
  expect(events[4]).toEqual({ type: 'research_status', node: 'RS1', state: 'done', report: `${dir}/REPORT.md` })
})

test('SKILL loop: one rejected score event -> failed with the count, never done', () => {
  const { events, r } = runSkillLoop('"rubric":"K2"')
  const last = events[events.length - 1]
  expect(last).toEqual({ type: 'research_status', node: 'RS1', state: 'failed', note: '1 score events failed; see the plan stderr and scores.json' })
  expect(events.some((e) => e.state === 'done')).toBe(false)
  expect(events.filter((e) => e.type === 'score').length).toBe(3)
  expect(r.status).toBe(0)
})

// ---------------------------------------------------------------------------------------------------------
// final review fixes

// R1: treating any non-null evaluator result as "returned" lets a panel of empty answers succeed with nothing
// scored, and the import then overwrites gate evidence and marks the job done.
test('when every evaluator returns empty scores and gates the run throws instead of writing empty scores', async () => {
  const empty = { persona: 'p', scores: [], gates: [], preferred: 'none', deciding_factor: 'd' }
  const canned: Canned = (call) => (call.opts.label.startsWith('eval:') ? empty : scriptedCanned(call))
  const { error, calls } = await run(baseArgs({ depth: 'quick' }), canned)
  expect(error?.message).toContain('every evaluator failed')
  expect(calls.some((c) => c.opts.label === 'scores-writer')).toBe(false)
})

test('an empty evaluator is dropped like a null one and the returned count excludes it', async () => {
  const empty = { persona: 'p', scores: [], gates: [], preferred: 'none', deciding_factor: 'd' }
  const canned: Canned = (call) => (call.opts.label === 'eval:2' ? empty : scriptedCanned(call))
  const { error, logs, calls } = await run(baseArgs({ depth: 'quick' }), canned)
  expect(error).toBeUndefined()
  expect(logs).toContain('2/3 evaluators returned; scores use those only')
  // evaluators 1 and 3 only: I1/K1 [4,5] -> 4.5
  expect(writerJson(calls).ideas.I1.scores.K1.value).toBe(4.5)
})

// R2: a fact-check that returns null was wrapped in a truthy item, so the log claimed N/N fact-checked.
test('a fact-check that returns null is named in the log as not fact-checked, and the dossier still goes on', async () => {
  const canned: Canned = (call) => (call.opts.label === 'factcheck:ctx-rules' ? null : scriptedCanned(call))
  const { error, logs, calls } = await run(baseArgs({ depth: 'quick' }), canned)
  expect(error).toBeUndefined()
  const line = logs.find((l) => l.includes('dossiers researched'))!
  expect(line).toContain('not fact-checked: ctx-rules')
  expect(line).not.toContain('failed:')
  const evalCall = calls.find((c) => c.opts.label === 'eval:1')!
  expect(evalCall.prompt).toContain('/tmp/ir-test-out/ctx-rules.md')
  expect(evalCall.prompt).not.toContain('ctx-rules.factcheck.md')
})

test('a gap-round fact-check that returns null is named in the log', async () => {
  const canned: Canned = (call) => {
    if (call.opts.label === 'completeness-critic') return { gaps: [{ key: 'g1-abuse', title: 'Abuse', prompt: 'p' }], rationale: 'r' }
    if (call.opts.label === 'gapcheck:g1-abuse') return null
    return scriptedCanned(call)
  }
  const { error, logs } = await run(baseArgs({ depth: 'full' }), canned)
  expect(error).toBeUndefined()
  expect(logs.some((l) => l.includes('not fact-checked: g1-abuse'))).toBe(true)
})

test('with every fact-check returning the log says researched and fact-checked with no not-fact-checked clause', async () => {
  const { logs } = await run(baseArgs({ depth: 'quick' }), scriptedCanned)
  expect(logs).toContain('6/6 dossiers researched and fact-checked')
  expect(logs.some((l) => l.includes('not fact-checked'))).toBe(false)
})
