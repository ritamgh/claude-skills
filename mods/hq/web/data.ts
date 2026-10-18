import { open, readdir, stat } from 'node:fs/promises'

import {
  REVIEW_ARGS,
  TAIL_BYTES,
  applyMeta,
  chatNeeds,
  chatsDue,
  holdLine,
  lastNote,
  mergeLive,
  parseBoard,
  parseLastReply,
  markLeads,
  parseLink,
  parseMeta,
  parseOwner,
  parseReviewPrs,
  parseStatusTs,
  parseTalk,
  plainLine,
  resultBody,
  resultItems,
  reviewDue,
  sessionProject,
} from '../hooks/board'
import type { HqLink, OwnerEntry, OwnerRow, Talk } from '../hooks/board'
import type { HqBoard, HqChat, HqChatEntry, HqReviewPr, HqSession } from '../types'
import { run } from './exec'
import { planFor, webLayout } from './layout'
import type { Need, Row } from './layout'
import { liveSessions } from './tmux'
import type { TmuxDeps } from './tmux'

// The board as the page needs it. It is built from the same sources and the same pure functions as the HQ pane
// (hooks/board.ts): `crew ls`, bin/tmux-map, the crew task files, the tail of each session's transcript, one cached
// `gh search prs`. Nothing here asks a model anything.

export type Deps = TmuxDeps & { crewBin: string; crewRoot: string; ghBin?: string; cacheMs?: number; now?: () => number }

export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const isTaskId = (s: string): boolean => TASK_ID.test(s) && !s.includes('..')
const RESULT_CHARS = 20_000
// At most this many bytes of a task file are read, however large (or endless) the file is.
const READ_BYTES = 4 * RESULT_CHARS
// An owner's notes are read from their end, this many bytes, and the note cut to this many characters.
const NOTES_TAIL_BYTES = 8_192
const NOTE_CHARS = 2_000

// A task can be diffed when its meta names a branch or a worktree (`crew diff` needs one of them). Meta files are
// append-only and the last value of a key wins, so `branch=x` followed by `branch=` clears it; an empty value does not count.
export const hasDiffTarget = (metaText: string): boolean => {
  const last: Record<string, string> = {}
  for (const line of metaText.split('\n')) {
    const m = /^(branch|worktree)=(.*)$/.exec(line.trim())
    if (m) last[m[1]!] = m[2]!
  }

  return Boolean(last.branch || last.worktree)
}

// `diffable` is only a flag: the page never learns the branch name or the worktree path.
export type ViewRow = Row & { diffable?: true }
export type SessionView = { name: string; project: string; state: string; age: string; target: string }
export type BoardView = {
  at: number
  needs: Need[]
  total: number
  cards: { session?: SessionView; rows: ViewRow[]; owners?: OwnerRow[]; talks?: string[] }[]
  folded: number
  results: { id: string; mark: string; name: string; project: string; verdict: string; at: number }[]
}
export type Snapshot = { board: HqBoard; view: BoardView }

const sessionView = (s: HqSession): SessionView => ({ name: s.name, project: sessionProject(s.where), state: s.state, age: s.age, target: s.target })

async function readText(path: string): Promise<string | null> {
  try {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(READ_BYTES)
      const { bytesRead } = await file.read(buffer, 0, READ_BYTES, 0)

      return buffer.toString('utf8', 0, bytesRead).slice(0, RESULT_CHARS)
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

// The last bytes of a file, for a notes file whose newest line is at the end; null when it cannot be read.
async function readTail(path: string): Promise<string | null> {
  try {
    const file = await open(path, 'r')
    try {
      const { size } = await file.stat()
      const start = Math.max(0, size - NOTES_TAIL_BYTES)
      const buffer = Buffer.alloc(size - start)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start)

      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

export function createSource(deps: Deps) {
  const now = deps.now ?? Date.now
  const cacheMs = deps.cacheMs ?? 5_000
  const taskFile = (id: string, name: string) => `${deps.crewRoot}/${id}/${name}`
  const chats: Record<string, HqChatEntry> = {}
  let reviews: { fetched: number; prs: HqReviewPr[] | null } = { fetched: 0, prs: null }
  let cached: { at: number; value: Promise<Snapshot> } | null = null

  async function readChat(path: string): Promise<{ chat: HqChat | null; size: number; mtime: number } | null> {
    try {
      const { size, mtimeMs } = await stat(path)
      let chat: HqChat | null = null
      for (const bytes of TAIL_BYTES) {
        const start = Math.max(0, size - bytes)
        const tail = await Bun.file(path).slice(start, size).text()
        chat = parseLastReply(tail, start > 0)
        if (chat !== null || start === 0) break
      }

      return { chat, size, mtime: Math.floor(mtimeMs / 1000) }
    } catch {
      return null
    }
  }

  async function refreshChats(sessions: HqSession[]) {
    const paths = sessions.flatMap(s => (s.transcript ? [s.transcript] : []))
    for (const path of Object.keys(chats).filter(p => !paths.includes(p))) delete chats[path]
    const stats: Record<string, { size: number; mtime: number }> = {}
    for (const path of paths) {
      try {
        const s = await stat(path)
        stats[path] = { size: s.size, mtime: Math.floor(s.mtimeMs / 1000) }
      } catch {
        delete chats[path]
      }
    }
    for (const path of chatsDue(stats, chats)) {
      const read = await readChat(path)
      if (read) chats[path] = { items: read.chat?.items ?? [], at: read.chat?.at || read.mtime * 1000, size: read.size, mtime: read.mtime }
      else delete chats[path]
    }
  }

  async function fetchReviews(at: number) {
    const argv = [...REVIEW_ARGS]
    if (deps.ghBin) argv[0] = deps.ghBin
    const ran = await run(argv, deps.env, 8_000)
    reviews = { fetched: at, prs: ran.code === 0 ? (parseReviewPrs(ran.stdout) ?? reviews.prs) : reviews.prs }
  }

  // The registry of feature owners ($CREW_ROOT/.owners/<id>/owner with the last line of its notes.md) and the talk threads
  // ($CREW_ROOT/.talk/<thread>/meta). A folder that cannot be read is left out; `.removed` and other dot folders are skipped.
  async function readRegistry(): Promise<{ owners: OwnerEntry[]; talks: Talk[] }> {
    const folders = async (dir: string) => {
      try {
        return (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.') && isTaskId(e.name)).map(e => e.name)
      } catch {
        return []
      }
    }
    const owners: OwnerEntry[] = []
    const talks: Talk[] = []
    for (const id of await folders(`${deps.crewRoot}/.owners`)) {
      const text = await readText(`${deps.crewRoot}/.owners/${id}/owner`)
      if (text === null) continue
      const owner = parseOwner(text)
      if (owner.feature === id) owners.push({ ...owner, note: lastNote((await readTail(`${deps.crewRoot}/.owners/${id}/notes.md`)) ?? '').slice(0, NOTE_CHARS) })
    }
    for (const id of await folders(`${deps.crewRoot}/.talk`)) {
      const text = await readText(`${deps.crewRoot}/.talk/${id}/meta`)
      if (text !== null) talks.push(parseTalk(text))
    }

    return { owners, talks }
  }

  // The chain links ($CREW_ROOT/.links/<sub sessionId>); a link that cannot be read is left out.
  async function readLinks(): Promise<HqLink[]> {
    const dir = `${deps.crewRoot}/.links`
    let names: string[] = []
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter(e => !e.isDirectory() && !e.name.includes('.tmp.')).map(e => e.name)
    } catch {
      // no links folder: no chains
    }
    const texts = await Promise.all(names.map(name => readText(`${dir}/${name}`)))

    return texts.flatMap(text => (text === null ? [] : [parseLink(text)]))
  }

  // The lead named in every task's meta file, of any age and state (not only the tasks crew ls still lists).
  async function readLed(): Promise<string[]> {
    let ids: string[] = []
    try {
      ids = (await readdir(deps.crewRoot, { withFileTypes: true })).filter(e => e.isDirectory() && isTaskId(e.name)).map(e => e.name)
    } catch {
      // no crew folder: no tasks
    }
    const texts = await Promise.all(ids.map(id => readText(taskFile(id, 'meta'))))

    return texts.flatMap(text => {
      const lead = text === null ? undefined : parseMeta(text).lead

      return lead ? [lead] : []
    })
  }

  async function build(): Promise<Snapshot> {
    const at = now()
    const [ls, live] = await Promise.all([run([deps.crewBin, 'ls'], deps.env, 20_000), liveSessions(deps)])
    if (ls.code !== 0) throw new Error(ls.stderr.trim() || `crew ls exited ${ls.code}`)

    const parsed = parseBoard(ls.stdout)
    const tasks = [...parsed.needsYou, ...parsed.running, ...parsed.waiting, ...parsed.done].filter(t => isTaskId(t.id))
    const metaTexts = Object.fromEntries(await Promise.all(tasks.map(async t => [t.id, (await readText(taskFile(t.id, 'meta'))) ?? ''] as const)))
    const metas = Object.fromEntries(Object.entries(metaTexts).map(([id, text]) => [id, parseMeta(text)] as const))
    const board = markLeads(applyMeta(mergeLive(parsed, live), metas), await readLinks(), await readLed())
    const diffable = new Set(tasks.filter(t => t.state === 'review' && hasDiffTarget(metaTexts[t.id]!)).map(t => t.id))

    const holds: Record<string, string> = {}
    for (const t of board.needsYou.filter(t => (t.state === 'held' || t.decision) && isTaskId(t.id))) {
      const text = await readText(taskFile(t.id, t.state === 'held' ? 'hold.md' : 'ask.md'))
      if (text !== null) holds[t.id] = holdLine(text)
    }
    const entered: Record<string, number> = {}
    for (const t of tasks) {
      const ts = parseStatusTs((await readText(taskFile(t.id, 'status'))) ?? '')
      if (ts !== undefined) entered[t.id] = ts
    }

    await refreshChats(board.elsewhere.filter(s => s.kind === 'claude'))
    if (reviewDue(reviews, at)) {
      const fetching = fetchReviews(at)
      if (reviews.prs === null) await fetching
      else void fetching
    }

    const layout = webLayout(board, planFor(board, at, entered), holds, reviews.prs ?? [], chatNeeds(board, chats, {}), { ...(await readRegistry()), now: at })
    const results = await Promise.all(
      resultItems(board, entered, at)
        .filter(r => isTaskId(r.id))
        .map(async r => {
          const verdict = plainLine(await readText(taskFile(r.id, 'summary.md'))) || plainLine(await readText(taskFile(r.id, 'report.md'))) || r.note

          return { id: r.id, mark: r.mark, name: r.name, project: r.project, verdict, at: r.at }
        }),
    )

    return {
      board,
      view: {
        at,
        needs: layout.needs,
        total: layout.needs.length,
        cards: layout.cards.map(c => ({
          ...(c.session ? { session: sessionView(c.session) } : {}),
          rows: c.rows.map((r): ViewRow => (diffable.has(r.id) ? { ...r, diffable: true } : r)),
          ...(c.owners ? { owners: c.owners } : {}),
          ...(c.talks ? { talks: c.talks } : {}),
        })),
        folded: layout.folded,
        results,
      },
    }
  }

  return {
    // The board, at most `cacheMs` old unless `fresh`; concurrent callers share one build.
    snapshot(fresh = false): Promise<Snapshot> {
      if (!fresh && cached && now() - cached.at < cacheMs) return cached.value
      const value = build()
      const entry = { at: now(), value }
      cached = entry
      value.catch(() => {
        if (cached === entry) cached = null
      })

      return value
    },
    // Why `id` cannot be diffed, or null when it can: crew must list it, it must be in review and its meta must name a branch or a worktree.
    async diffBlocker(id: string, board: HqBoard): Promise<{ status: number; error: string } | null> {
      const task = [...board.needsYou, ...board.running, ...board.waiting, ...board.done].find(t => t.id === id)
      if (!task) return { status: 404, error: 'no such task' }
      if (task.state !== 'review') return { status: 409, error: `${id} is not in review` }
      if (!hasDiffTarget((await readText(taskFile(id, 'meta'))) ?? '')) return { status: 409, error: `${id} has no branch or worktree to diff` }

      return null
    },
    // The user-facing text of a task: summary.md, else report.md, else its note on the board; null when the task is unknown.
    async result(id: string, board: HqBoard | null) {
      if (!isTaskId(id)) return null
      const note = board ? [...board.needsYou, ...board.running, ...board.waiting, ...board.done].find(t => t.id === id)?.note : undefined
      const summary = await readText(taskFile(id, 'summary.md'))
      const report = (summary ?? '').trim() === '' ? await readText(taskFile(id, 'report.md')) : null
      try {
        await stat(`${deps.crewRoot}/${id}`)
      } catch {
        if (note === undefined) return null
      }
      const text = resultBody({ summary, summaryAt: 0, report, reportAt: 0 }, note ?? '')
      const source = (summary ?? '').trim() !== '' ? 'summary' : (report ?? '').trim() !== '' ? 'report' : 'note'

      return { id, source, text }
    },
  }
}

export type Source = ReturnType<typeof createSource>
