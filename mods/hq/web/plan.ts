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
import { MAX_TEXT, sanitizeText, sendText } from './tmux'

export type PlanConfig = Deps & { planBin?: string; planPage?: string; planNudgeMs?: number }

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
const MAX_PLAN_LABEL = 120
const DEFAULT_NUDGE_MS = 4000

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
}
// The order the forwarded JSON lists its keys in.
const FIELD_ORDER = ['node', 'choice', 'text', 'label', 'lane', 'value', 'other'] as const

// Unicode format characters (bidi overrides, zero-width, tag characters): sanitizeText leaves them, a summary must not carry them to the lead's prompt.
const FORMAT_CHARS = /\p{Cf}/gu

const chars = (s: string): number => Array.from(s).length

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
  const cli = (argv: string[]) => run([config.planBin!, ...argv], { ...config.env, CREW_ROOT: config.crewRoot }, 20_000)

  // --- the nudge: one line per task per burst of events ---

  const bursts = new Map<string, string[]>()
  const timers = new Set<ReturnType<typeof setTimeout>>()

  async function nudge(task: string, summaries: string[]): Promise<void> {
    const { board } = await ctx.source.snapshot(true).catch(() => ({ board: null }))
    if (!board) throw new Error('the board could not be read')
    const found = [...board.needsYou, ...board.running, ...board.waiting, ...board.done].find(t => t.id === task)
    if (!found) throw new Error('the task is not on the board')
    // A guess (the only Claude session in the project) may be an orchestrator, not the planner: never type a page note into it.
    if (resolveLead(board, found)?.guessed) throw new Error(`the lead of ${task} is only a guess: not typing the note into it`)
    const told = ctx.leadFor(board, found)
    if (!('session' in told)) throw new Error(told.reason)

    const head = `From Plan (user): ${summaries.length} change(s) on ${task}: `
    const tail = `. Run: plan news ${task}`
    let list = summaries.map(s => sanitizeText(s.replace(FORMAT_CHARS, ''))).filter(s => s !== '').join('; ')
    const room = MAX_TEXT - chars(head) - chars(tail)
    if (chars(list) > room) list = `${Array.from(list).slice(0, Math.max(0, room - 1)).join('')}…`
    const sent = await sendText(config, told.session.target, head + list + tail)
    if (!sent.ok) throw new Error(sent.reason ? `${sent.error} (${sent.reason})` : sent.error)
  }

  function schedule(task: string, summary: string): void {
    const pending = bursts.get(task)
    if (pending) {
      pending.push(summary)

      return
    }
    bursts.set(task, [summary])
    const timer = setTimeout(() => {
      timers.delete(timer)
      const summaries = bursts.get(task) ?? []
      bursts.delete(task)
      nudge(task, summaries).catch(failure => console.error(`hq-web: plan nudge for ${task} not sent: ${failure instanceof Error ? failure.message : failure}`))
    }, nudgeMs)
    timers.add(timer)
    timer.unref?.()
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

    const event: Record<string, string | number> = { type: data.type }
    for (const key of FIELD_ORDER) {
      const value = data[key]
      if (!fields.includes(key) || value === undefined || value === null) continue
      if (key === 'value') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) return json(400, { error: 'value must be an integer' })
      } else if (typeof value !== 'string') return json(400, { error: `${key} must be a string` })
      event[key] = value
    }
    if (typeof event.text === 'string' && chars(event.text) > MAX_PLAN_TEXT) return json(413, { error: `text is longer than ${MAX_PLAN_TEXT} characters` })
    if (typeof event.label === 'string' && chars(event.label) > MAX_PLAN_LABEL) return json(413, { error: `label is longer than ${MAX_PLAN_LABEL} characters` })

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

  // Forget the nudges that are still waiting; server.ts calls this when the server stops.
  function dispose(): void {
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
