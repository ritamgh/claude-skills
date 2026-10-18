// HQ web: the /shape plan routes (contract §10, §11). server.ts dispatches here after its Host, token and Origin checks,
// and hands over its own helpers. The plan itself is read from $crewRoot/<task>/plan/; every change goes through the
// `plan` CLI (argv, no shell), which validates it. After an accepted event the session that leads the task is nudged,
// one line per burst.
import { readFile, stat } from 'node:fs/promises'

import { resolveLead } from '../hooks/board'
import type { HqBoard, HqSession, HqTask } from '../types'
import { isTaskId } from './data'
import type { Deps, Source } from './data'
import { run } from './exec'
import { MAX_TEXT, sanitizeText, sendText, submitTyped } from './tmux'

// `planRetryMs` and `planRetryWindowMs` are test seams (default 10 s and 5 min): how often a refused nudge is retried, and for how long after the first attempt.
export type PlanConfig = Deps & { planBin?: string; planPage?: string; planNudgeMs?: number; planRetryMs?: number; planRetryWindowMs?: number }

// What server.ts lends: its response helpers, the JSON body parser, the page with the nonce CSP, and the lead lookup of /api/answer.
export type PlanContext = {
  config: PlanConfig
  source: Source
  json: (status: number, body: unknown) => Response
  text: (status: number, body: string) => Response
  body: (req: Request) => Promise<Record<string, unknown> | Response>
  page: (html: string) => Response
  leadFor: (board: HqBoard, task: HqTask) => { session: HqSession } | { lead: string | null; reason: string }
}

const MAX_PLAN_BYTES = 2 * 1024 * 1024
const MAX_PLAN_TEXT = 2000
const MAX_COMMENT_TEXT = 5000 // a pasted teammate comment (plan_core's cap); every other event keeps MAX_PLAN_TEXT
const MAX_PLAN_LABEL = 120
const MAX_PLAN_AUTHOR = 80
const MAX_PLAN_ANCHOR = 16 // the longest node id or "§18"
const MAX_REVIEW_REFS = 20
const MAX_REVIEW_REF = 16 // a comment id like "CM12"
const DEFAULT_NUDGE_MS = 4000
const DEFAULT_RETRY_MS = 10_000
const DEFAULT_RETRY_WINDOW_MS = 300_000

// The user events of contract §4.1 and the fields each may carry. Any other key of a body is dropped.
const USER_EVENTS: Record<string, readonly string[]> = {
  answer: ['node', 'choice', 'text'],
  park: ['node'],
  reopen: ['node'],
  strike: ['node'],
  prioritize: ['node'],
  edit_label: ['node', 'label'],
  note: ['text', 'node', 'lane'],
  ask: ['text', 'node'],
  expand: ['node', 'text'],
  approve_prd: [],
  // The board events of contract §12.2.
  boost: ['node', 'value'],
  kill: ['node', 'text'],
  restore: ['node'],
  merge: ['node', 'other'],
  twist: ['node', 'text'],
  promote: ['node'],
  weight: ['node', 'value'],
  weights_reset: [],
  research: ['node', 'text'],
  // The teammate-comment events of design-p2; comment_split, comment_triage and reply stay session-only.
  comment: ['text', 'author', 'anchor'],
  comment_accept: ['ref', 'proposal'],
  comment_rework: ['ref', 'text'],
  comment_delete: ['ref'],
  // The PR-review event of design-p2 (addendum 2); refs (a list) and proposals (an object of ref to the proposal rev the page showed) are the two structured fields, only a `post` carries them.
  review: ['action', 'refs', 'proposals'],
}
// The order the forwarded JSON lists its keys in.
const FIELD_ORDER = ['node', 'ref', 'proposal', 'choice', 'text', 'label', 'lane', 'value', 'other', 'author', 'anchor', 'action', 'refs', 'proposals'] as const

// Unicode format characters (bidi overrides, zero-width, tag characters): sanitizeText leaves them, a summary must not carry them to the lead's prompt.
const FORMAT_CHARS = /\p{Cf}/gu

const chars = (s: string): number => Array.from(s).length

// The nudge stays this short, so it never wraps over several composer rows.
const NUDGE_CHARS = 160

function taskIdOf(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw)

    return isTaskId(id) ? id : null
  } catch {
    return null
  }
}

const parseObject = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function createPlanRoutes(ctx: PlanContext) {
  const { config, json } = ctx
  const nudgeMs = config.planNudgeMs ?? DEFAULT_NUDGE_MS
  const retryMs = config.planRetryMs ?? DEFAULT_RETRY_MS
  const retryWindowMs = config.planRetryWindowMs ?? DEFAULT_RETRY_WINDOW_MS
  const cli = (argv: string[]) => run([config.planBin!, ...argv], { ...config.env, CREW_ROOT: config.crewRoot }, 20_000)

  // --- the nudge: one line per task per burst of events ---

  // A refused nudge (dialog open, claude not in front, lead not found yet) is retried every `retryMs` for `retryWindowMs`
  // after its first attempt, with the burst kept: events that arrive meanwhile join it. A task that is not on the board
  // is not retried. Retries live in memory only: an HQ restart forgets them (`plan news` still shows the change).
  // `count` is every change of the burst; `summaries` stops growing once their text fills a line.
  const bursts = new Map<string, { summaries: string[]; count: number; since?: number }>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let stopped = false

  const gone = (message: string) => Object.assign(new Error(message), { permanent: true })

  const full = (summaries: string[]) => summaries.join('; ').length > MAX_TEXT

  async function nudge(task: string, summaries: string[], count: number): Promise<void> {
    const { board } = await ctx.source.snapshot(true).catch(() => ({ board: null }))
    if (!board) throw new Error('the board could not be read')
    const found = [...board.needsYou, ...board.running, ...board.waiting, ...board.done].find(t => t.id === task)
    if (!found) throw gone('the task is not on the board')
    // A guess (the only Claude session in the project) may be an orchestrator, not the planner: never type a page note into it.
    if (resolveLead(board, found)?.guessed) throw new Error(`the lead of ${task} is only a guess: not typing the note into it`)
    const told = ctx.leadFor(board, found)
    if (!('session' in told)) throw new Error(told.reason)

    // One short line: a long one wraps over composer rows, and the summaries are in `plan news` anyway.
    const list = summaries.map(s => sanitizeText(s.replace(FORMAT_CHARS, ''))).filter(s => s !== '').join('; ')
    const tail = `. Run: plan news ${task}`
    const line = `From Plan (user): ${count} change(s) on ${task}`
    const short = chars(line) + chars(tail) <= NUDGE_CHARS ? line + tail : `From Plan (user): ${count} change(s)${tail}` // a long task id: it stays in the `Run:` ending only
    const text = list !== '' && chars(line) + 2 + chars(list) + chars(tail) <= NUDGE_CHARS ? `${line}: ${list}${tail}` : short
    const sent = await sendText(config, told.session.target, text)
    if (!sent.ok) {
      const message = sent.reason ? `${sent.error} (${sent.reason})` : sent.error
      if (sent.enterPending) submitLater(told.session.target, text, Date.now())
      // The text is already in the pane: a retry would type it again.
      throw sent.typed ? gone(message) : new Error(message)
    }
  }

  // The nudge was typed but never seen in the composer, so Enter was not pressed. Only the Enter is retried: never the text,
  // and only while the composer holds exactly the nudge (user text is never submitted). Anything else ends it, quietly.
  function submitLater(target: string, text: string, since: number): void {
    const timer = setTimeout(async () => {
      timers.delete(timer)
      if (stopped) return
      const done = await submitTyped(config, target, text).catch(() => null)
      if (done && !done.ok && !done.typed && Date.now() - since + retryMs <= retryWindowMs) submitLater(target, text, since)
    }, retryMs)
    timers.add(timer)
    timer.unref?.()
  }

  function arm(task: string, ms: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer)
      attempt(task)
    }, ms)
    timers.add(timer)
    timer.unref?.()
  }

  function attempt(task: string): void {
    const burst = bursts.get(task)
    if (!burst) return
    bursts.delete(task)
    const since = burst.since ?? Date.now()
    nudge(task, burst.summaries, burst.count).catch(failure => {
      const permanent = failure instanceof Error && 'permanent' in failure
      if (!stopped && !permanent && Date.now() - since + retryMs <= retryWindowMs) {
        // Events that came in during the attempt already started a burst: the kept summaries go in front of it, and its timer sends them all.
        const newer = bursts.get(task)
        if (newer) {
          newer.summaries = full(burst.summaries) ? burst.summaries : [...burst.summaries, ...newer.summaries]
          newer.count += burst.count
          newer.since = Math.min(since, newer.since ?? since) // the window runs from the oldest start
        } else {
          bursts.set(task, { summaries: burst.summaries, count: burst.count, since })
          arm(task, retryMs)
        }

        return
      }
      if (stopped) return
      console.error(`hq-web: plan nudge for ${task} not sent: ${failure instanceof Error ? failure.message : failure}`)
    })
  }

  function schedule(task: string, summary: string): void {
    if (stopped) return
    const pending = bursts.get(task)
    if (pending) {
      pending.count++
      if (!full(pending.summaries)) pending.summaries.push(summary)

      return
    }
    bursts.set(task, { summaries: [summary], count: 1 })
    arm(task, nudgeMs)
  }

  // --- routes ---

  async function readPlan(id: string, rev: string | null): Promise<Response> {
    const dir = `${config.crewRoot}/${id}/plan`
    let size = 0
    try {
      size = (await stat(`${dir}/plan.json`)).size
    } catch {
      return json(404, { error: `no plan for ${id}` })
    }
    if (size > MAX_PLAN_BYTES) return json(502, { error: 'plan.json is larger than 2 MB' })
    let plan: unknown
    try {
      plan = JSON.parse(await readFile(`${dir}/plan.json`, 'utf8'))
    } catch (failure) {
      return failure && (failure as NodeJS.ErrnoException).code === 'ENOENT' ? json(404, { error: `no plan for ${id}` }) : json(502, { error: 'plan.json could not be read' })
    }
    const current = plan && typeof plan === 'object' ? (plan as { rev?: unknown }).rev : undefined
    if (typeof current !== 'number') return json(502, { error: 'plan.json has no rev' })
    if (rev !== null && /^\d+$/.test(rev) && Number(rev) === current) return json(200, { rev: current, unchanged: true })
    const prdSize = await stat(`${dir}/PRD.md`).then(s => s.size, () => 0)
    if (prdSize > MAX_PLAN_BYTES) return json(200, { rev: current, plan, prd: '', prd_error: 'PRD.md is larger than 2 MB' })
    const prd = await readFile(`${dir}/PRD.md`, 'utf8').catch(() => '')

    return json(200, { rev: current, plan, prd })
  }

  async function postEvent(req: Request, id: string): Promise<Response> {
    const data = await ctx.body(req)
    if (data instanceof Response) return data
    const fields = typeof data.type === 'string' && Object.hasOwn(USER_EVENTS, data.type) ? USER_EVENTS[data.type]! : null
    if (typeof data.type !== 'string' || fields === null) return json(400, { error: `type must be one of: ${Object.keys(USER_EVENTS).join(', ')}` })

    const event: Record<string, string | number | string[] | Record<string, number>> = { type: data.type }
    if (event.type !== 'review' && data.refs !== undefined && data.refs !== null) return json(400, { error: 'refs is only for a review event' })
    if (event.type !== 'review' && data.proposals !== undefined && data.proposals !== null) return json(400, { error: 'proposals is only for a review event' })
    for (const key of FIELD_ORDER) {
      const value = data[key]
      if (!fields.includes(key) || value === undefined || value === null) continue
      if (key === 'value' || key === 'proposal') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) return json(400, { error: `${key} must be an integer` })
      } else if (key === 'proposals') {
        const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : null
        if (!entries) return json(400, { error: 'proposals must be an object of refs to integers' })
        if (entries.length > MAX_REVIEW_REFS) return json(400, { error: `proposals has more than ${MAX_REVIEW_REFS} entries` })
        for (const [ref, rev] of entries) {
          if (chars(ref) > MAX_REVIEW_REF) return json(400, { error: `a proposals key is longer than ${MAX_REVIEW_REF} characters` })
          if (/[\p{Cc}\u2028\u2029]/u.test(ref)) return json(400, { error: 'a proposals key must be one line without control characters' })
          if (typeof rev !== 'number' || !Number.isSafeInteger(rev)) return json(400, { error: 'proposals must be an object of refs to integers' })
        }
        event[key] = Object.fromEntries(entries) as Record<string, number>
        continue
      } else if (key === 'refs') {
        if (!Array.isArray(value)) return json(400, { error: 'refs must be a list of strings' })
        if (value.length > MAX_REVIEW_REFS) return json(400, { error: `refs has more than ${MAX_REVIEW_REFS} entries` })
        for (const ref of value) {
          if (typeof ref !== 'string') return json(400, { error: 'refs must be a list of strings' })
          if (chars(ref) > MAX_REVIEW_REF) return json(400, { error: `a refs entry is longer than ${MAX_REVIEW_REF} characters` })
          if (/[\p{Cc}\u2028\u2029]/u.test(ref)) return json(400, { error: 'a refs entry must be one line without control characters' })
        }
        event[key] = value
        continue
      } else if (typeof value !== 'string') return json(400, { error: `${key} must be a string` })
      event[key] = value
    }
    const maxText = event.type === 'comment' ? MAX_COMMENT_TEXT : MAX_PLAN_TEXT
    if (typeof event.text === 'string' && chars(event.text) > maxText) return json(413, { error: `text is longer than ${maxText} characters` })
    if (typeof event.label === 'string' && chars(event.label) > MAX_PLAN_LABEL) return json(413, { error: `label is longer than ${MAX_PLAN_LABEL} characters` })
    for (const [key, max] of [['author', MAX_PLAN_AUTHOR], ['anchor', MAX_PLAN_ANCHOR]] as const) {
      const value = event[key]
      if (typeof value !== 'string') continue
      if (chars(value) > max) return json(400, { error: `${key} is longer than ${max} characters` })
      if (/[\r\n\u2028\u2029]/.test(value)) return json(400, { error: `${key} must be one line` })
    }

    const ran = await cli(['event', id, '--by', 'user', '--source', 'page', '--json', JSON.stringify(event)])
    const message = ran.stderr.trim()
    if (ran.code === 2) return json(400, { error: message || 'the plan refused the event' })
    if (ran.code === 3) return json(404, { error: message || `no plan for ${id}` })
    if (ran.code === 4) return json(409, { error: message || 'the plan has blocking findings', lint: parseObject(ran.stdout)?.lint ?? [] })
    const out = ran.code === 0 ? parseObject(ran.stdout) : null
    if (!out || typeof out.rev !== 'number') return json(502, { error: message || `plan event exited ${ran.code}` })

    const summary = typeof out.summary === 'string' ? out.summary : String(event.type)
    schedule(id, summary)

    return json(200, { ok: true, rev: out.rev, summary, nudge: 'scheduled' })
  }

  // Forget the nudges that are still waiting, and the retries; server.ts calls this when the server stops.
  function dispose(): void {
    stopped = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    bursts.clear()
  }

  // The answer to a plan request, or null when the request is not for a plan route.
  async function handle(req: Request, url: URL): Promise<Response | null> {
    const idError = () => json(400, { error: 'bad task id' })

    const page = /^\/plan(?:\/([^/]+))?$/.exec(url.pathname)
    if (req.method === 'GET' && page) {
      if (config.planPage === undefined) return null

      return page[1] !== undefined && taskIdOf(page[1]) === null ? idError() : ctx.page(config.planPage)
    }
    if (config.planBin === undefined) return null

    if (req.method === 'GET' && url.pathname === '/api/plans') {
      const ran = await cli(['list', '--json'])
      if (ran.code !== 0) return json(502, { error: ran.stderr.trim() || `plan list exited ${ran.code}` })
      try {
        return json(200, JSON.parse(ran.stdout))
      } catch {
        return json(502, { error: 'plan list did not answer JSON' })
      }
    }

    const read = /^\/api\/plan\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && read) {
      const id = taskIdOf(read[1]!)

      return id === null ? idError() : readPlan(id, url.searchParams.get('rev'))
    }

    const event = /^\/api\/plan\/([^/]+)\/event$/.exec(url.pathname)
    if (req.method === 'POST' && event) {
      const id = taskIdOf(event[1]!)

      return id === null ? idError() : postEvent(req, id)
    }

    return null
  }

  return Object.assign(handle, { dispose })
}
