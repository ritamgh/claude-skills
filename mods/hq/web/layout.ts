import { classify, ownerRows, projectName, resolveLead, shortName, shortNote, talkRows } from '../hooks/board'
import type { ChatNeed, Focus, OwnerEntry, OwnerRow, Talk } from '../hooks/board'
import type { HqBoard, HqReviewPr, HqSession, HqTask } from '../types'

// The page's own layout, built from the data-level functions of hooks/board.ts (classify, chatNeeds, resolveLead,
// ...). It does not use the text-layout helpers of the HQ pane: the page renders HTML.

export type Row = { id: string; kind: 'ask' | 'review' | 'run' | 'wait'; name: string; state: string; note: string }
export type Need = {
  kind: 'ask' | 'chat' | 'pr'
  tag: string
  what: string
  msg: string
  taskId?: string
  decision?: string
  session?: string
  target?: string
}
// `owners` and `talks` are the asleep owners and open talk threads led by the card's session (see ownerRows, talkRows).
export type Card = { session?: HqSession; rows: Row[]; owners?: OwnerRow[]; talks?: string[] }
export type Layout = { needs: Need[]; cards: Card[]; folded: number }

const OLD_IDLE_SECONDS = 86_400

function rowOf(task: HqTask, kind: Row['kind']): Row {
  const name = shortName(task.id)
  const id = task.id
  if (kind === 'ask') return { id, kind, name, state: task.state, note: task.decision ?? task.age }
  if (kind === 'review') return { id, kind, name, state: 'verifying', note: '' }
  if (kind === 'run') return { id, kind, name, state: task.state, note: task.state === 'queued' && task.note !== '' ? shortNote(task.note) : task.age }

  return { id, kind, name, state: 'waiting', note: shortNote(task.note) }
}

// `plan` is classify()'s answer. Questions first, then the Needs-you items sessions left in chat, then review requests;
// one card per live session (busy first, then the most recent) with a row for each task it leads, and a card without a
// session for the tasks, asleep owners and talk threads whose lead is not live. Idle sessions over a day old with
// nothing to show are only counted, except a live top-level lead (session.lead), which always has its card.
export function webLayout(board: HqBoard, plan: Focus, holds: Record<string, string>, requested: HqReviewPr[], chats: ChatNeed[], registry: { owners: OwnerEntry[]; talks: Talk[]; now: number } = { owners: [], talks: [], now: 0 }): Layout {
  const entries = [
    ...plan.asks.map(t => ({ task: t, row: rowOf(t, 'ask') })),
    ...plan.reviews.map(t => ({ task: t, row: rowOf(t, 'review') })),
    ...plan.now.map(t => ({ task: t, row: rowOf(t, 'run') })),
    ...plan.waiting.map(t => ({ task: t, row: rowOf(t, 'wait') })),
  ]
  const sessions = board.elsewhere
    .filter(s => s.kind === 'claude')
    .sort((a, b) => Number(b.state === 'busy') - Number(a.state === 'busy') || a.seconds - b.seconds)
  const rows = new Map<HqSession, Row[]>(sessions.map(s => [s, []]))
  const other: Row[] = []
  for (const { task, row } of entries) {
    const lead = resolveLead(board, task)?.session
    ;(lead ? rows.get(lead)! : other).push(row)
  }

  // owners and talk threads go under the card of their lead, matched by name; those whose lead is not live go with the other crew work
  const live = sessions.map(s => s.name)
  const extras = (lead: string | null) => {
    const [owners, talks] = [ownerRows(registry.owners, registry.now, lead, live), talkRows(registry.talks, lead, live)]

    return { ...(owners.length > 0 ? { owners } : {}), ...(talks.length > 0 ? { talks } : {}) }
  }

  const cards: Card[] = []
  let folded = 0
  for (const session of sessions) {
    const more = extras(session.name)
    if (session.state === 'idle' && !session.lead && session.seconds >= OLD_IDLE_SECONDS && rows.get(session)!.length === 0 && Object.keys(more).length === 0) folded += 1
    else cards.push({ session, rows: rows.get(session)!, ...more })
  }
  const otherExtras = extras(null)
  if (other.length > 0 || Object.keys(otherExtras).length > 0) cards.push({ rows: other, ...otherExtras })

  const needs: Need[] = [
    ...plan.asks.map((t): Need => ({
      kind: 'ask',
      tag: t.decision ?? 'held',
      what: `${projectName(t.repo)} · ${shortName(t.id)}`,
      msg: holds[t.id] ?? shortNote(t.note),
      taskId: t.id,
      ...(t.decision ? { decision: t.decision } : {}),
    })),
    ...chats.flatMap((c) => c.items.map((msg): Need => ({ kind: 'chat', tag: '(chat)', what: c.session.name, msg, session: c.session.name, target: c.session.target }))),
    ...requested.map((pr): Need => ({ kind: 'pr', tag: 'PR', what: `${pr.repo} #${pr.number}`, msg: `review requested: ${pr.title}` })),
  ]

  return { needs, cards, folded }
}

// Nothing counts as just finished: the page has no Seen button, RESULTS shows what ended.
export const planFor = (board: HqBoard, now: number, entered: Record<string, number>): Focus =>
  classify(board, { now, entered, seen: { all: now, ids: {} }, prs: {} })
