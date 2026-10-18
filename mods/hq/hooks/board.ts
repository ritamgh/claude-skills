import type { HqBoard, HqChat, HqChatEntry, HqLive, HqMeta, HqParked, HqPr, HqPrEntry, HqResultFiles, HqReviewPr, HqReviews, HqSeen, HqSession, HqTask } from '../types'

// Pure helpers over the text of `crew ls`; nothing here touches `$`.

export const TOAST_STATES = ['review', 'held', 'done', 'landed', 'failed']

// What a store or an atom held, when it may be of an older shape: anything but an object (a list) is empty.
export const asRecord = <T = unknown>(value: unknown): Record<string, T> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, T>) : {}
export const asList = <T = unknown>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

export const emptyBoard = (): HqBoard => ({
  needsYou: [],
  running: [],
  waiting: [],
  done: [],
  elsewhere: [],
  parked: [],
  parkedMore: 0,
})

const HEADER = /^[A-Z][A-Z ]*$/
const AGE = '\\d+[smhd]'
// `  <id> <state> <age>  <shape> <repo> <note>`; shape, repo and note follow the age.
const TASK = new RegExp(`^\\s+(\\S+)\\s+(\\S+)\\s+(${AGE})\\s*(.*)$`)
const DETAIL = /^(?:ship|scout|draft)?\s*(\S+)\s*(.*)$/
// A note that starts with the id of an open decision: `D3 · the rest` (crew ls adds it).
const DECISION = /^(D\d+) ·(?: (.*))?$/
// `  proc   pid <n> run <age>  <args>`; the claude rows are ignored: tmux-map lists those in full.
const SESSION = new RegExp(`^\\s+(claude|proc)\\s+(.+?)\\s+(\\S+)\\s+(${AGE})\\s*(.*)$`)
// `  P2   10-15  <repo> <note>`.
const PARKED = /^\s+(P\d+)\s+(\d\d-\d\d)\s+(\S+)\s+(.*)$/
const MORE = /^\s+\+(\d+) more\s*$/

export function parseBoard(text: string): HqBoard {
  const board = emptyBoard()
  let section = ''

  for (const line of text.split('\n')) {
    if (HEADER.test(line)) {
      section = line
      continue
    }

    if (section === 'NEEDS YOU' || section === 'RUNNING' || section === 'WAITING ON OTHERS' || section === 'DONE') {
      const m = TASK.exec(line)
      if (!m) continue
      const [, repo = '-', detail = ''] = DETAIL.exec(m[4]!) ?? []
      const decided = DECISION.exec(detail.trim())
      const note = decided ? (decided[2] ?? '') : detail
      const task: HqTask = { id: m[1]!, state: m[2]!, age: m[3]!, repo, note: note.trim(), ...(decided ? { decision: decided[1]! } : {}) }
      const list = {
        'NEEDS YOU': board.needsYou,
        RUNNING: board.running,
        'WAITING ON OTHERS': board.waiting,
        DONE: board.done,
      }[section]!
      list.push(task)
    } else if (section === 'RUNNING ELSEWHERE') {
      const m = SESSION.exec(line)
      if (!m || m[1] !== 'proc') continue
      const session: HqSession = {
        kind: 'proc',
        name: m[2]!,
        state: m[3]!,
        age: m[4]!,
        seconds: ageSeconds(m[4]!),
        where: m[5]!,
        target: '',
        window: '',
      }
      board.elsewhere.push(session)
    } else if (section === 'PARKED') {
      const m = PARKED.exec(line)
      if (!m) {
        board.parkedMore = Number(MORE.exec(line)?.[1] ?? board.parkedMore)
        continue
      }
      const parked: HqParked = { pri: m[1]!, date: m[2]!, repo: m[3]!, text: m[4]! }
      board.parked.push(parked)
    }
  }

  return board
}

const stateById = (board: HqBoard): Map<string, string> =>
  new Map([...board.needsYou, ...board.running, ...board.waiting, ...board.done].map(t => [t.id, t.state]))

// One "<id> → <state>" per task whose state is a toast state it was not in at the previous poll.
// The first poll (no previous board) reports nothing.
export function newlyEntered(prev: HqBoard | null, next: HqBoard): string[] {
  if (prev === null) return []

  const before = stateById(prev)

  return [...next.needsYou, ...next.running, ...next.waiting, ...next.done]
    .filter(t => TOAST_STATES.includes(t.state) && before.get(t.id) !== t.state)
    .map(t => `${t.id} → ${t.state}`)
}

// Tasks that wait for the user's answer: held ones and those with an open decision (a D-id).
export const isAsk = (t: HqTask): boolean => t.state === 'held' || t.decision !== undefined
export const asks = (board: HqBoard): HqTask[] => board.needsYou.filter(isAsk)

// What waits for the user: questions (a held task, or a task with an open decision, one in review included), the PRs
// whose review was asked of them, and the sessions that left Needs-you items in their last reply without recording
// them (`chats`, one each however many items). A task in review without an open decision is the lead still verifying: it does not wait for the user.
export const needCount = (board: HqBoard, reviews = 0, chats: ChatNeed[] = []): number =>
  asks(board).length + reviews + asList(chats).length

// The band line, or null when nothing needs you and nothing runs. `reviews` counts the PRs whose review was
// asked of the user; a failed task without a question does not need them.
export function summarize(board: HqBoard, reviews = 0, chats: ChatNeed[] = []): string | null {
  const needs = needCount(board, reviews, chats)
  const running = board.running.length
  const sessions = board.elsewhere.filter(s => s.kind === 'claude').length

  if (needs === 0 && running === 0) return null

  const parts: string[] = []
  if (needs > 0) parts.push(`⚠ ${needs} need you`)
  if (running > 0) parts.push(`${running} running`)
  if (sessions > 0) parts.push(`${sessions} sessions live`)

  return parts.join(' · ')
}

// --- display width: wide characters (CJK, emoji) take two columns, combining marks none ---

const ZERO_WIDTH = /[\p{Mn}\p{Me}​-‏⁠︀-️\u0000-\u001f\u007f-\u009f]/u
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u
const PICTOGRAPH = /\p{Extended_Pictographic}/u

const charCols = (ch: string): number => (ZERO_WIDTH.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)

// The columns `text` takes on a terminal. A pictograph followed by U+FE0F is drawn wide.
export function cols(text: string): number {
  let total = 0
  let previous = ''
  for (const ch of text) {
    total += ch === '️' && PICTOGRAPH.test(previous) && charCols(previous) === 1 ? 1 : charCols(ch)
    previous = ch
  }

  return total
}

// How many of `chars` fit in `width` columns.
function takeCols(chars: string[], width: number): number {
  let used = 0
  let n = 0
  for (const ch of chars) {
    used += charCols(ch)
    if (used > width) break
    n += 1
  }

  return n
}

export const cutCols = (text: string, width: number): string => {
  const chars = Array.from(text)

  return chars.slice(0, takeCols(chars, width)).join('')
}
export const padCols = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - cols(text)))

export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (cols(text) <= width) return text

  return cutCols(text, width - 1) + '…'
}

export const shortName = (id: string): string => id.replace(/^(\d{4}-)+/, '') || id

// The first clause of a task's note, without a leading "verified".
export function shortNote(note: string): string {
  const clause = (note.split(';')[0] ?? '').trim()

  return clause.replace(/^(lead )?verified:?\s+/i, '')
}

export const projectName = (repo: string): string => (repo === '' || repo === '-' ? 'other' : repo)

export function sessionProject(cwd: string): string {
  const base = cwd.replace(/\/+$/, '').split('/').pop() ?? ''

  return base === '' || base === '?' ? 'other' : base
}

export function taskDot(state: string): { glyph: string; color: string } {
  if (state === 'review') return { glyph: '●', color: 'yellow' }
  if (state === 'held') return { glyph: '●', color: 'magenta' }
  if (state === 'failed') return { glyph: '●', color: 'red' }
  if (state === 'done' || state === 'landed') return { glyph: '✓', color: 'green' }

  return { glyph: '●', color: 'cyan' }
}

// `left` padded or cut so that `right` ends exactly at `width`, with a space between.
export function splitRow(left: string, right: string, width: number): [string, string] {
  const room = Math.max(0, width - cols(right) - 1)

  return [padCols(fit(left, room), room + 1), right]
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

function ageSeconds(age: string): number {
  const m = /^(\d+)([smhd])$/.exec(age)

  return m ? Number(m[1]) * UNIT_SECONDS[m[2]!]! : Infinity
}

const isToday = (t: HqTask): boolean => ageSeconds(t.age) < 86400

export type HqCounts = { busy: number; idle: number; doneToday: number; parked: number }

export function summaryCounts(board: HqBoard): HqCounts {
  const claude = board.elsewhere.filter(s => s.kind === 'claude')
  const busy = claude.filter(s => s.state === 'busy').length + board.elsewhere.length - claude.length

  return {
    busy,
    idle: claude.length - claude.filter(s => s.state === 'busy').length,
    doneToday: board.done.filter(isToday).length,
    parked: board.parked.length + board.parkedMore,
  }
}

// --- what goes where: NEEDS YOU / NOW / JUST FINISHED, and the tasks that wait on others ---

export const FINISHED_TTL_MS = 12 * 3_600_000
export const emptySeen = (): HqSeen => ({ all: 0, ids: {} })

// `ended`: GitHub says the task's PR merged or closed (`pr` is its number).
export type FinishedItem = { task: HqTask; mark: '✓' | '✗'; text: string; at: number; ended?: 'merged' | 'closed'; pr?: number }
// `reviews`: tasks in review whose PR is still open (or unknown): they wait for the user, so they never expire.
export type Focus = { asks: HqTask[]; reviews: HqTask[]; now: HqTask[]; finished: FinishedItem[]; waiting: HqTask[] }
// `entered`: when each task entered its state (ms); `seen`: what the user has looked at; `prs`: the gh answers.
export type FocusContext = { now: number; entered: Record<string, number>; seen: HqSeen; prs: Record<string, HqPrEntry> }

// The board as the user needs it: only real questions need them; running work is NOW; what ended since they last
// looked (and within 12 hours) is JUST FINISHED, a waiting task whose PR ended on GitHub among it; the rest of the
// waiting tasks only count in the footer.
export function classify(board: HqBoard, ctx: FocusContext): Focus {
  const enteredAt = (t: HqTask) => ctx.entered[t.id] ?? ctx.now - ageSeconds(t.age) * 1000
  const isNew = ({ task, at }: FinishedItem) => at > Math.max(ctx.seen.all, ctx.seen.ids[task.id] ?? 0) && ctx.now - at < FINISHED_TTL_MS

  const ended = new Map<string, FinishedItem>()
  for (const task of prTasks(board).filter(t => !isAsk(t))) {
    const pr = prFor(task, ctx.prs)
    if (!pr || pr.state === 'OPEN') continue
    const at = pr.at ?? ctx.prs[task.id]!.fetched

    ended.set(
      task.id,
      pr.state === 'MERGED'
        ? { task, mark: '✓', text: `#${pr.number} merged on GitHub — log landed?`, at, ended: 'merged', pr: pr.number }
        : { task, mark: '✗', text: `#${pr.number} closed on GitHub`, at, ended: 'closed', pr: pr.number },
    )
  }
  const plain = [...board.needsYou.filter(t => !isAsk(t)), ...board.done]
    .filter(t => !ended.has(t.id) && t.state !== 'dropped')
    .map((task): FinishedItem => ({ task, mark: task.state === 'failed' ? '✗' : '✓', text: shortNote(task.note), at: enteredAt(task) }))

  return {
    asks: asks(board),
    reviews: board.needsYou.filter(t => t.state === 'review' && !isAsk(t) && !ended.has(t.id)),
    now: board.running.filter(t => !isAsk(t)),
    finished: [...ended.values(), ...plain].filter(isNew).sort((a, b) => b.at - a.at),
    waiting: board.waiting.filter(t => !isAsk(t) && !ended.has(t.id)),
  }
}

export const MAX_REVIEW_PRS = 5

export type ProjectCard = {
  name: string
  tasks: HqTask[]
  busy: HqSession[]
  idle: number
  waiting: number
  hasNeeds: boolean
  // needs-you or running task, or a busy session: worth a full card
  isActive: boolean
  doneCount: number
}

const MAX_DONE_PER_CARD = 3

// One card per project: its questions and running tasks, what just finished, how many wait on others, and its
// claude sessions. Cards with a question come first, then the most recently active.
export function projectCards(board: HqBoard, focus: Focus): ProjectCard[] {
  const cards = new Map<string, ProjectCard & { done: HqTask[]; latest: number }>()
  const card = (name: string) => {
    let c = cards.get(name)
    if (!c) cards.set(name, (c = { name, tasks: [], busy: [], idle: 0, waiting: 0, hasNeeds: false, isActive: false, doneCount: 0, done: [], latest: Infinity }))

    return c
  }

  for (const t of focus.asks) {
    const c = card(projectName(t.repo))
    c.tasks.push(t)
    c.hasNeeds = true
    c.latest = Math.min(c.latest, ageSeconds(t.age))
  }
  for (const t of focus.now) {
    const c = card(projectName(t.repo))
    c.tasks.push(t)
    c.latest = Math.min(c.latest, ageSeconds(t.age))
  }
  for (const { task: t } of focus.finished) {
    const c = card(projectName(t.repo))
    c.done.push(t)
    c.latest = Math.min(c.latest, ageSeconds(t.age))
  }
  for (const t of focus.waiting) card(projectName(t.repo)).waiting += 1
  for (const s of board.elsewhere.filter(s => s.kind === 'claude')) {
    const c = card(sessionProject(s.where))
    if (s.state === 'busy') c.busy.push(s)
    else c.idle += 1
    c.latest = Math.min(c.latest, s.seconds)
  }

  return [...cards.values()]
    .sort((a, b) => Number(b.hasNeeds) - Number(a.hasNeeds) || a.latest - b.latest || a.name.localeCompare(b.name))
    .map(({ done, latest: _latest, ...c }) => ({
      ...c,
      isActive: c.tasks.length > 0 || c.busy.length > 0,
      doneCount: done.length,
      tasks: [...c.tasks, ...done.sort((a, b) => ageSeconds(a.age) - ageSeconds(b.age)).slice(0, MAX_DONE_PER_CARD)],
    }))
}

const joinCounts = (items: [number, (n: number) => string][], separator: string): string =>
  items.filter(([n]) => n > 0).map(([n, text]) => text(n)).join(separator)

export const projectsFooter = (c: HqCounts): string =>
  joinCounts([[c.parked, n => `◇ ${n} parked`], [c.doneToday, n => `✓ ${n} done today`]], ' · ')

// One line for the projects without a card: idle sessions as ○N, tasks done today as ✓N.
export function quietLine(cards: ProjectCard[]): string {
  const parts = cards
    .filter(c => !c.isActive)
    .map(c => [c.name, c.idle > 0 && `○${c.idle}`, c.waiting > 0 && `⏸${c.waiting}`, c.doneCount > 0 && `✓${c.doneCount}`].filter(Boolean).join(' '))

  return parts.length === 0 ? '' : `quiet  ${parts.join(' · ')}`
}

// --- live claude sessions (bin/tmux-map) and jumping to the tmux pane one runs in ---

const TARGET = /^[A-Za-z0-9_.:-]+$/
const HQ_SESSION = /^hq/

export const isTarget = (s: string): boolean => TARGET.test(s)

// A transcript path is handed to `stat` and `tail` as an argument: an absolute .jsonl path of plain characters,
// without "..".
const TRANSCRIPT = /^\/[A-Za-z0-9._/-]+\.jsonl$/
export const isTranscript = (s: string): boolean => TRANSCRIPT.test(s) && !s.includes('..')

// A session's link is only ever a claude.ai/code URL of plain characters: HQ prints it to the user.
const SESSION_LINK = /^https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]+$/
export const isSessionLink = (s: string): boolean => SESSION_LINK.test(s)

// `claude:6.0` shows as `claude:6`; other panes keep their index.
export const showTarget = (target: string): string => target.replace(/\.0$/, '')

export function fmtAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`

  return seconds < 86400 ? `${Math.round(seconds / 3600)}h` : `${Math.round(seconds / 86400)}d`
}

// Lines of bin/tmux-map: `name<TAB>target<TAB>window<TAB>cwd<TAB>status<TAB>seconds<TAB>transcript<TAB>link`; target and
// window are empty for a session outside tmux, the transcript when the file is not there, the link without Remote Control.
export function parseLive(text: string): HqLive[] {
  return text
    .split('\n')
    .map(line => line.split('\t'))
    .filter(([name, target = '', , cwd, state, seconds]) => name && cwd && state && !Number.isNaN(Number(seconds)) && (target === '' || isTarget(target)))
    .map(([name, target, window, cwd, state, seconds, transcript = '', link = '']) => ({
      name: name!,
      target: target!,
      window: window!,
      cwd: cwd!,
      state: state!,
      seconds: Number(seconds),
      transcript: isTranscript(transcript) ? transcript : '',
      link: isSessionLink(link) ? link : '',
    }))
}

// The board with its claude sessions taken from tmux-map (full names, full cwd), not from `crew ls`, which cuts
// both. hq sessions are left out: they are the viewer, not a crew.
export function mergeLive(board: HqBoard, live: HqLive[]): HqBoard {
  const sessions = live
    .filter(l => !HQ_SESSION.test(l.name))
    .map(l => ({
      kind: 'claude' as const,
      name: l.name,
      state: l.state,
      age: fmtAge(l.seconds),
      seconds: l.seconds,
      where: l.cwd,
      target: l.target,
      window: l.window,
      ...(l.transcript ? { transcript: l.transcript } : {}),
      ...(l.link ? { link: l.link } : {}),
    }))

  return { ...board, elsewhere: [...board.elsewhere.filter(s => s.kind === 'proc'), ...sessions] }
}

// A project's claude sessions, best lead first: busy, then the most recent.
function rankedSessions(board: HqBoard, project: string): HqSession[] {
  return board.elsewhere
    .filter(s => s.kind === 'claude' && sessionProject(s.where) === project)
    .sort((a, b) => Number(b.state === 'busy') - Number(a.state === 'busy') || a.seconds - b.seconds)
}

export const pickLead = (board: HqBoard, project: string): HqSession | undefined => rankedSessions(board, project)[0]

// The session of a project to jump to: its best-ranked claude session that runs in tmux.
export const repoJump = (board: HqBoard, project: string): HqSession | undefined =>
  rankedSessions(board, project).find(s => s.target !== '')

// A task of the board by its id or its short name.
export const findTask = (board: HqBoard, query: string): HqTask | undefined =>
  [...board.needsYou, ...board.running, ...board.waiting, ...board.done].find(t => t.id === query || shortName(t.id) === query)

// `/hq go <query>`: a session name, else a project name.
export const findJump = (board: HqBoard, query: string): HqSession | undefined =>
  board.elsewhere.find(s => s.kind === 'claude' && s.target !== '' && s.name === query) ?? repoJump(board, query)

export function jumpChoices(board: HqBoard): string[] {
  const inTmux = board.elsewhere.filter(s => s.kind === 'claude' && s.target !== '')

  return [...new Set([...inTmux.map(s => s.name), ...inTmux.map(s => sessionProject(s.where))])].sort()
}

// --- holds, the model's view of the board, and the brief ---

export const holdLine = (text: string): string =>
  text
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '') ?? ''

// What the hq_board tool returns: open tasks (with their lead, `leadGuessed` when it is a guess by project, and
// their PR), claude sessions, and the best lead session per project.
export function boardForModel(board: HqBoard, holds: Record<string, string>, prs: Record<string, HqPrEntry> = {}) {
  const tasks = [...board.needsYou, ...board.running, ...board.waiting].map(t => {
    const lead = resolveLead(board, t)
    const pr = prFor(t, prs)

    return {
      id: t.id,
      name: shortName(t.id),
      repo: projectName(t.repo),
      state: t.state,
      age: t.age,
      note: shortNote(t.note),
      ...(t.decision ? { decision: t.decision } : {}),
      ...(holds[t.id] ? { question: holds[t.id] } : {}),
      ...(lead ? { lead: lead.session.name, ...(lead.guessed ? { leadGuessed: true } : {}) } : {}),
      ...(pr ? { pr: { number: pr.number, state: pr.state } } : {}),
    }
  })
  const claude = board.elsewhere.filter(s => s.kind === 'claude')
  const sessions = claude.map(s => ({
    name: s.name,
    project: sessionProject(s.where),
    state: s.state,
    age: s.age,
    ...(s.target ? { tmux: s.target } : {}),
    ...(s.link ? { link: s.link } : {}),
  }))
  const leads: Record<string, string> = {}
  for (const project of new Set(sessions.map(s => s.project))) {
    const lead = pickLead(board, project)
    if (lead) leads[project] = lead.name
  }

  return { tasks, sessions, leads }
}

// --- the task's own lead (meta file) and its pull request ---

// A task's meta file is `key=value` lines; the last `lead=`, `repo=`, `branch=` and `worktree=` win, an empty value does not count.
// The Diff action reads branch and worktree the way crew diff does (the last line of a key wins, an empty one clears it):
// when that leaves neither, `diffCleared` is set so canDiff says no even though an earlier value is still in `branch`.
export function parseMeta(text: string): HqMeta {
  const meta: HqMeta = {}
  const last: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const m = /^(lead|repo|branch|worktree)=(.*)$/.exec(line.trim())
    if (!m) continue
    if (m[1] === 'branch' || m[1] === 'worktree') last[m[1]] = m[2]!
    if (!m[2]) continue
    if (m[1] === 'lead') meta.lead = m[2]
    else if (m[1] === 'repo') meta.repoPath = m[2]
    else if (m[1] === 'branch') meta.branch = m[2]
    else meta.worktree = m[2]
  }
  if (!last.branch && !last.worktree && (meta.branch !== undefined || meta.worktree !== undefined)) meta.diffCleared = true

  return meta
}

export function applyMeta(board: HqBoard, metas: Record<string, HqMeta>): HqBoard {
  const withMeta = (t: HqTask): HqTask => (metas[t.id] ? { ...t, ...metas[t.id] } : t)

  return {
    ...board,
    needsYou: board.needsYou.map(withMeta),
    running: board.running.map(withMeta),
    waiting: board.waiting.map(withMeta),
    done: board.done.map(withMeta),
  }
}

// A chain link ($CREW_ROOT/.links/<sub sessionId>): the sub-lead's name and the name of the lead it reports to.
export type HqLink = { sub: string; parent: string }

export function parseLink(text: string): HqLink {
  const value = (key: string): string => text.split('\n').filter(l => l.startsWith(`${key}=`)).pop()?.slice(key.length + 1).trim() ?? ''

  return { sub: value('sub_name'), parent: value('parent_name') }
}

// Marks the live top-level leads: claude sessions named as the lead of a task, or as the parent of a chain link, that are
// not themselves a sub-lead (the sub of a link). `led` is the lead of every task meta under $CREW_ROOT, of any age and
// state (a lead stays a lead after crew ls forgets its tasks); the board's own tasks count too. Other sessions stay plain.
export function markLeads(board: HqBoard, links: HqLink[], led: string[] = []): HqBoard {
  const subs = new Set(links.map(l => l.sub))
  const leads = new Set([...[...board.needsYou, ...board.running, ...board.waiting, ...board.done].map(t => t.lead), ...led, ...links.map(l => l.parent)])
  const marked = (s: HqSession): HqSession => (s.kind === 'claude' && leads.has(s.name) && !subs.has(s.name) ? { ...s, lead: true } : s)

  return { ...board, elsewhere: board.elsewhere.map(marked) }
}

// The session that leads a task: the one its meta names, when it is live; else the best session of its project,
// marked as a guess.
export function resolveLead(board: HqBoard, task: HqTask): { session: HqSession; guessed: boolean } | undefined {
  const named = task.lead ? board.elsewhere.find(s => s.kind === 'claude' && s.name === task.lead) : undefined
  if (named) return { session: named, guessed: false }

  const guess = pickLead(board, projectName(task.repo))

  return guess ? { session: guess, guessed: true } : undefined
}

// Where to jump for a task: its exact lead, if it is in tmux; else a session of its project that is.
export function jumpFor(board: HqBoard, task: HqTask): { session: HqSession; guessed: boolean } | undefined {
  const lead = resolveLead(board, task)
  if (lead && !lead.guessed) return lead.session.target === '' ? undefined : lead

  const guess = repoJump(board, projectName(task.repo))

  return guess ? { session: guess, guessed: true } : undefined
}

export type PrRef = { kind: 'number'; key: string; n: number } | { kind: 'branch'; key: string; branch: string }

const BRANCH = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/

// What to ask GitHub about a task: the PR number its note mentions, else its meta branch (a plain ref name only).
export function prRef(task: HqTask): PrRef | undefined {
  const n = /PR #(\d{1,7})\b/.exec(task.note)?.[1]
  if (n) return { kind: 'number', key: `#${n}`, n: Number(n) }
  if (task.branch && BRANCH.test(task.branch)) return { kind: 'branch', key: `branch:${task.branch}`, branch: task.branch }

  return undefined
}

// What a cached answer is about: the repo path and the reference. A task with no repo or no reference has none.
export function prKey(task: HqTask): string | undefined {
  const ref = prRef(task)

  return ref && task.repoPath ? `${task.repoPath}|${ref.key}` : undefined
}

// The cached PR of a task, only when it was asked about the task's current repo and reference.
export function prFor(task: HqTask, prs: Record<string, HqPrEntry>): HqPr | null | undefined {
  const entry = prs[task.id]

  return entry && entry.key === prKey(task) ? entry.pr : undefined
}

// The cache without the answers that no longer match their task, or whose task left the board.
export function prunePrs(board: HqBoard, prs: Record<string, HqPrEntry>): Record<string, HqPrEntry> {
  const tasks = prTasks(board)

  return Object.fromEntries(Object.entries(prs).filter(([id, entry]) => entry.key === prKey(tasks.find(t => t.id === id) ?? ({} as HqTask))))
}

const PR_FIELDS = 'number,state,mergedAt,closedAt,url'

export const ghArgs = (ref: PrRef): string[] =>
  ref.kind === 'number'
    ? ['gh', 'pr', 'view', String(ref.n), '--json', PR_FIELDS]
    : ['gh', 'pr', 'list', '--head', ref.branch, '--state', 'all', '--json', PR_FIELDS, '--limit', '1']

// The PR in gh's JSON (an object from `pr view`, a list from `pr list`); null for none or anything unreadable.
// A merged or closed PR carries `at`, the time it ended (ms).
export function parsePr(stdout: string): HqPr | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    const pr = Array.isArray(parsed) ? parsed[0] : parsed
    const { number, state, mergedAt, closedAt } = (pr ?? {}) as Record<string, unknown>
    if (typeof number !== 'number' || (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED')) return null

    const at = state === 'OPEN' ? NaN : Date.parse(String(state === 'MERGED' ? mergedAt : closedAt))

    return Number.isNaN(at) ? { number, state } : { number, state, at }
  } catch {
    return null
  }
}

// The tasks gh is asked about: the ones that wait on someone else, and those in review.
export const prTasks = (board: HqBoard): HqTask[] => [...board.waiting, ...board.needsYou.filter(t => t.state === 'review')]

export function mergedNotLogged(board: HqBoard, prs: Record<string, HqPrEntry>): { task: HqTask; pr: HqPr }[] {
  return prTasks(board).flatMap(task => {
    const pr = prFor(task, prs)

    return pr?.state === 'MERGED' && task.state !== 'landed' ? [{ task, pr }] : []
  })
}

export const PR_TTL_MS = 5 * 60_000
export const PR_QUERIES_PER_POLL = 3

// The gh queries to make now: tasks with something to ask and a repo to ask in, whose answer is missing, was about
// another reference or is older than the TTL; the oldest first, never more than `limit` (three by default).
export function ghDue(tasks: HqTask[], cache: Record<string, HqPrEntry>, now: number, limit = PR_QUERIES_PER_POLL): { task: HqTask; ref: PrRef }[] {
  return tasks
    .flatMap(task => {
      const ref = prRef(task)
      const cached = cache[task.id]
      const fetched = cached && cached.key === prKey(task) ? cached.fetched : 0

      return ref && task.repoPath && now - fetched >= PR_TTL_MS ? [{ task, ref, fetched }] : []
    })
    .sort((a, b) => a.fetched - b.fetched)
    .slice(0, limit)
    .map(({ task, ref }) => ({ task, ref }))
}

// The user has looked at everything (no id) or at one task. Entries too old to matter any more are dropped.
export function markSeen(seen: HqSeen, now: number, id?: string): HqSeen {
  if (id === undefined) return { all: now, ids: {} }
  const ids = Object.fromEntries(Object.entries(seen.ids).filter(([, at]) => now - at < 2 * FINISHED_TTL_MS))

  return { all: seen.all, ids: { ...ids, [id]: now } }
}

// What the store held: anything that is not the right shape is no seen-state at all.
export function parseSeen(raw: unknown): HqSeen {
  const { all, ids } = (raw ?? {}) as { all?: unknown; ids?: unknown }
  const entries = Object.entries((ids && typeof ids === 'object' ? ids : {}) as Record<string, unknown>).filter(([, at]) => typeof at === 'number')

  return { all: typeof all === 'number' ? all : 0, ids: Object.fromEntries(entries) as Record<string, number> }
}

// One search for the PRs whose review is asked of the user; it takes one of the poll's gh queries.
export const REVIEW_ARGS = ['gh', 'search', 'prs', '--review-requested=@me', '--state=open', '--json', 'number,title,repository,url,updatedAt']

export const reviewDue = (cache: HqReviews, now: number): boolean => now - cache.fetched >= PR_TTL_MS

// The PRs in gh's JSON list; null for anything unreadable. Titles lose their control characters.
export function parseReviewPrs(stdout: string): HqReviewPr[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed)) return null

    return parsed.flatMap((item): HqReviewPr[] => {
      const { number, title, repository, url, updatedAt } = (item ?? {}) as Record<string, unknown>
      const repo = (repository ?? {}) as { nameWithOwner?: unknown; name?: unknown }
      const name = typeof repo.nameWithOwner === 'string' ? repo.nameWithOwner : repo.name
      if (typeof number !== 'number' || typeof title !== 'string' || typeof url !== 'string' || typeof name !== 'string') return []
      const at = Date.parse(String(updatedAt))

      return [{ repo: name, number, title: title.replace(/[\u0000-\u001f\u007f]/g, ' '), url, updatedAt: Number.isNaN(at) ? 0 : at }]
    })
  } catch {
    return null
  }
}

// The time a task entered its current state: the first line of the last run of one state in its status file
// (`ts<TAB>state<TAB>note`). A later line with the same state, such as an answer note, does not move it.
export function parseStatusTs(text: string): number | undefined {
  let state = ''
  let ts = ''
  for (const line of text.split('\n').filter(l => l.trim() !== '')) {
    const [at = '', now = ''] = line.split('\t')
    if (now !== state) [state, ts] = [now, at]
  }
  const ms = Date.parse(ts)

  return Number.isNaN(ms) ? undefined : ms
}

// The time of the last line of a status file, whatever its state: a task that keeps reporting is alive.
export function parseStatusLastTs(text: string): number | undefined {
  const last = text.split('\n').filter(l => l.trim() !== '').pop() ?? ''
  const ms = Date.parse(last.split('\t')[0] ?? '')

  return Number.isNaN(ms) ? undefined : ms
}

const fmtElapsed = (ms: number): string => fmtAge(ms / 1000)

const FINISHED = ['done', 'landed']

// "Since you last looked", plain text. `entered` is when each task entered its current state (ms, from its status
// file); a task is new when that is after `since`, one with no time is not.
export function briefText(
  board: HqBoard,
  since: number,
  now: number,
  isFirst: boolean,
  entered: Record<string, number>,
  merged: { task: HqTask; pr: HqPr }[] = [],
): string {
  const isNew = (t: HqTask) => (entered[t.id] ?? -Infinity) > since
  const finished = board.done.filter(t => FINISHED.includes(t.state) && isNew(t))
  const failed = board.needsYou.filter(t => t.state === 'failed' && isNew(t))
  const fresh = board.needsYou.filter(t => t.state !== 'failed' && isNew(t))
  const waiting = board.needsYou.filter(t => !isNew(t))
  const withNote = (label: string, t: HqTask) => {
    const note = shortNote(t.note)

    return note === '' ? label : `${label} — ${note}`
  }
  const lines = [isFirst ? 'Last 24h:' : `Since your last look (${fmtElapsed(now - since)} ago):`]

  if (finished.length > 0) lines.push(`  landed or done: ${finished.map(t => shortName(t.id)).join(', ')} (${finished.length})`)
  if (failed.length > 0) lines.push(`  failed: ${failed.map(t => withNote(shortName(t.id), t)).join('; ')}`)
  if (fresh.length > 0) lines.push(`  needs you: ${fresh.map(t => withNote(`${shortName(t.id)} (${t.state})`, t)).join('; ')}`)
  if (finished.length + failed.length + fresh.length === 0) lines.push('  nothing new')
  if (merged.length > 0) lines.push(`  merged on GitHub, not logged: ${merged.map(m => `${shortName(m.task.id)} (PR #${m.pr.number})`).join(', ')}`)
  if (waiting.length > 0) lines.push(`  still waiting: ${waiting.map(t => `${shortName(t.id)} (${t.state}, ${t.age})`).join(', ')}`)
  if (board.running.length > 0) lines.push(`  running: ${board.running.length}`)

  return lines.join('\n')
}

// --- what sessions say in chat: the Needs-you block of the last reply of each live session ---

// How much of the end of a transcript is read, and how much more if neither a reply nor a prompt is in it yet.
export const TAIL_BYTES = [262_144, 1_048_576]
const CHAT_ITEM_MAX = 100

// Terminal escapes and other control characters in transcript text would reach the screen as they are.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
// What a user "prompt" with no origin can be besides a prompt: a slash command (`/word`, not a path), the tags of
// shell and slash-command echoes, notifications and reminders, a message from another session, the summary after
// a compaction.
const NOT_A_PROMPT =
  /^(?:\/[A-Za-z][\w:-]*(?:\s|$)|<(?:bash-input|bash-stdout|bash-stderr|local-command-[a-z]+|command-(?:name|message|args)|task-notification|system-reminder|teammate-message|user-prompt-submit-hook)\b|Caveat:|Another Claude session sent|This session is being continued)/

type Block = { type?: unknown; text?: unknown }
type TranscriptRecord = {
  type?: unknown
  timestamp?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  origin?: { kind?: unknown; body?: unknown } | null
  message?: { content?: unknown }
}

const blocksOf = (rec: TranscriptRecord): Block[] => (Array.isArray(rec.message?.content) ? (rec.message.content as Block[]) : [])
const textOf = (rec: TranscriptRecord): string => {
  const content = rec.message?.content

  return typeof content === 'string' ? content : blocksOf(rec).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}

// A record that answers the session: a prompt the user typed, or their words relayed by HQ. Tool results, meta
// records, sidechains, and what other senders put in the user's seat (notifications, other sessions) are not answers.
function isAnswer(rec: TranscriptRecord): boolean {
  if (rec.type !== 'user' || rec.isSidechain === true) return false
  const origin = rec.origin
  if (origin && typeof origin === 'object' && origin.kind === 'peer' && typeof origin.body === 'string' && origin.body.startsWith('From HQ (user)')) return true
  if (rec.isMeta === true || blocksOf(rec).some(b => b?.type === 'tool_result')) return false
  if (origin && typeof origin === 'object' && origin.kind !== 'human') return false

  return origin?.kind === 'human' || !NOT_A_PROMPT.test(textOf(rec).trimStart())
}

const NEEDS_LABEL = /^\s*(?:\*\*|__)?needs you\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i
// What ends a block: a rule, a heading, or a Next line.
const BLOCK_END = /^\s*(?:-{3,}|#{1,6}\s.*|(?:\*\*|__)?next(?:\s+steps?)?\s*(?:\*\*|__)?\s*:.*)$/i
const FENCE = /^\s*(```+|~~~+)/
const BULLET = /^(\s*)(?:[-*•]|\d+[.)])\s+(.*)$/
// An item that only says there is nothing: "nothing", "none" or "n/a" (also "no") alone, with a short qualifier, or with
// a sentence after it ("nothing yet. Once the review is done..."). "None of these fit" is a request, not an empty block.
const NOTHING = /^(?:[\s—–-]*(?:nothing|none|n\/a)(?:\s+(?:yet|right now|for now|at the moment|needed|pending|else))?\s*(?:[.!;:,—–-]|$)|no(?:\s+(?:right now|for now|else|yet|needed|at the moment))?[.!]?$)/i

const cleanItem = (text: string): string =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)

// The items of the "Needs you" blocks in a message: the text after the label and the bullet or numbered lines below
// it, up to the end of the message or the next rule, heading or Next line. Markdown is stripped, a line is one item.
export function parseNeeds(text: string): string[] {
  const items: string[] = []
  let first = -1
  let joins = false
  let fence = ''
  // the indent of the first bullet of the block: bullets indented deeper are part of the item above
  let base = -1

  // a lead-in such as "two things:" is no item when bullets follow it
  const close = () => {
    if (first >= 0 && items.length > first + 1 && items[first]!.trimEnd().endsWith(':')) items.splice(first, 1)
    first = -1
  }

  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (fence === '' && marker) fence = marker[0]!
    else if (fence !== '' && marker?.[0] === fence) fence = ''
    if (fence !== '' || marker) continue
    const label = NEEDS_LABEL.exec(line)
    if (label) {
      close()
      base = -1
      first = items.length
      items.push(label[1]!)
      joins = true
      continue
    }
    if (first < 0) continue
    if (BLOCK_END.test(line)) {
      close()
      continue
    }
    if (line.trim() === '') {
      joins = false
      continue
    }
    const bullet = BULLET.exec(line)
    const last = items.length - 1
    if (bullet && base < 0) base = bullet[1]!.length
    if (bullet && bullet[1]!.length <= base) {
      items.push(bullet[2]!)
      joins = true
    } else if (joins) {
      items[last] += ` ${bullet ? bullet[2]! : line}`
    }
  }
  close()

  return items.map(cleanItem).filter(item => item !== '' && !NOTHING.test(item))
}

// The Needs-you items of the last assistant message with text in the tail of a transcript (JSONL), and its time (ms,
// 0 when it has none); no items when a prompt came after it. Null when the tail holds neither. `partial` says the text
// begins in the middle of the file, so its first line is cut and left out. Lines that are not JSON are skipped.
export function parseLastReply(text: string, partial: boolean): HqChat | null {
  const lines = text.split('\n')
  if (partial) lines.shift()

  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: TranscriptRecord
    try {
      rec = JSON.parse(lines[i]!) as TranscriptRecord
    } catch {
      continue
    }
    if (!rec || typeof rec !== 'object') continue
    if (isAnswer(rec)) return { items: [], at: 0 }
    if (rec.type !== 'assistant' || rec.isSidechain === true) continue
    const reply = textOf(rec)
    if (reply.trim() === '') continue
    const at = Date.parse(String(rec.timestamp))

    return { items: parseNeeds(reply), at: Number.isNaN(at) ? 0 : at }
  }

  return null
}

// `stat -c '%n|%s|%Y'` output: size and modification time per path.
export function parseStat(stdout: string): Record<string, { size: number; mtime: number }> {
  const out: Record<string, { size: number; mtime: number }> = {}
  for (const line of stdout.split('\n')) {
    const [path, size, mtime] = line.split('|')
    if (path && isTranscript(path) && /^\d+$/.test(size ?? '') && /^\d+$/.test(mtime ?? '')) out[path] = { size: Number(size), mtime: Number(mtime) }
  }

  return out
}

// The transcripts whose file changed since they were read: no entry, or another size or modification time.
export const chatsDue = (stats: Record<string, { size: number; mtime: number }>, cache: Record<string, HqChatEntry>): string[] =>
  Object.entries(stats)
    .filter(([path, s]) => cache[path]?.size !== s.size || cache[path]?.mtime !== s.mtime)
    .map(([path]) => path)

// What a session said in chat that needs the user and is not recorded: `items` of its last reply, written at `at`.
// Dismissing it stores `key` and `at`.
// `items` are cut to fit a line; `full` (when set) is the same items whole.
export type ChatNeed = { session: HqSession; key: string; items: string[]; full?: string[]; at: number }

// What the user dismissed: per session key, the time (ms) of the reply that was dismissed. Kept apart from the seen-state
// of tasks, which "Seen all" resets and which ages out.
export type ChatDismissed = Record<string, number>

export const CHAT_AGE_SHOWN_MS = 2 * 3_600_000
export const CHAT_OLD_MS = 24 * 3_600_000

// The sessions whose last reply is under a day old are a need; older ones are not, though the pane still names them.
export function splitChats(chats: ChatNeed[], now: number): { fresh: ChatNeed[]; older: ChatNeed[] } {
  const list = asList<ChatNeed>(chats)

  return { fresh: list.filter(c => now - c.at < CHAT_OLD_MS), older: list.filter(c => now - c.at >= CHAT_OLD_MS) }
}

export const dismissChat = (dismissed: ChatDismissed, key: string, at: number): ChatDismissed => ({ ...dismissed, [key]: at })

// What the store held: anything that is not a number per key is dropped.
export function parseDismissed(raw: unknown): ChatDismissed {
  const entries = Object.entries(raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}).filter(([, at]) => typeof at === 'number')

  return Object.fromEntries(entries) as ChatDismissed
}

const chatKey = (session: HqSession): string => `chat:${session.name}`

// The dismissals still worth keeping: not those of a session that wrote a newer reply since, nor of one that is gone
// (judged only while some claude session is live, so a failed tmux-map does not wipe them). A session whose transcript
// has not been read yet keeps its dismissal.
export function pruneDismissed(board: HqBoard, chats: Record<string, HqChatEntry>, dismissed: ChatDismissed): ChatDismissed {
  const sessions = board.elsewhere.filter(s => s.kind === 'claude')

  return Object.fromEntries(
    Object.entries(dismissed).filter(([key, at]) => {
      const session = sessions.find(s => chatKey(s) === key)
      if (!session) return sessions.length === 0

      const chat = session.transcript ? chats[session.transcript] : undefined

      return !chat || chat.at <= at
    }),
  )
}

// The items of each live session's last reply, minus those that name an open decision (the band shows that decision
// itself), and those of a session whose reply was dismissed. The newest reply first.
export function chatNeeds(board: HqBoard, chats: Record<string, HqChatEntry>, dismissed: ChatDismissed): ChatNeed[] {
  const open = new Set([...board.needsYou, ...board.running, ...board.waiting, ...board.done].flatMap(t => (t.decision ? [t.decision] : [])))

  return board.elsewhere
    .flatMap((session): ChatNeed[] => {
      const chat = session.kind === 'claude' && session.transcript ? chats[session.transcript] : undefined
      const key = chatKey(session)
      if (!chat || chat.at <= (dismissed[key] ?? -Infinity)) return []
      const full = chat.items.filter(item => !(item.match(/\bD\d+\b/g) ?? []).some(id => open.has(id)))
      const items = full.map(item => fit(item, CHAT_ITEM_MAX))

      return items.length === 0 ? [] : [{ session, key, items, full, at: chat.at }]
    })
    .sort((a, b) => b.at - a.at)
}

// --- the Focus view: NEEDS YOU, NOW, JUST FINISHED, and the idle sessions on one line ---

// One line per open question, each ending with where to go. `session` is the pane that pressing it jumps to (missing
// when there is none); `go` is the text at the right edge. A chat line stands for a whole session: its first item, or
// "N questions"; `suffix` says how old the reply is when it is more than two hours.
// `key` names the line (`ask:<task id>`, `chat:<session>`, `pr:<repo>#<n>`): pressing it opens its page. `full` is the
// whole text behind `msg`, when that is more than it shows.
export type NeedLine = { kind: 'ask' | 'chat' | 'pr'; key: string; name: string; msg: string; suffix: string; go: string; id?: string; full?: string; session?: HqSession }
// A claude session that is busy or has open tasks, and those tasks as short phrases; `session` is missing on the line of
// tasks without a live lead.
// `owners` and `talks` are the asleep owners and open talk threads led by that session (see ownerRows, talkRows), when it has any.
export type NowEntry = { name: string; status: string; session?: HqSession; tasks: string[]; owners?: OwnerRow[]; talks?: string[] }
// A finished task for the user to look at, `isNew` until they have seen it. `detail`: it is a result with a page of its own.
export type FinishedRow = { id: string; mark: '✓' | '✗'; isNew: boolean; name: string; verdict: string; lead: string; detail: boolean }

export type FocusInput = {
  board: HqBoard
  plan: Focus
  ctx: FocusContext
  holds?: Record<string, string>
  requested?: HqReviewPr[]
  chats?: ChatNeed[]
  files?: Record<string, HqResultFiles>
  // when each task last wrote a line to its status file (ms)
  last?: Record<string, number>
  // the whole text of each open question, by task id (hold.md / ask.md)
  questions?: Record<string, string>
  // the feature owners and talk threads of the registry
  owners?: OwnerEntry[]
  talks?: Talk[]
}

// `total`: what the NEEDS YOU header counts, the review requests cut from the list included. `older`: sessions whose last
// reply is over a day old: they are not a need any more. `earlier`: finished rows beyond the five shown.
export type FocusView = {
  needs: NeedLine[]
  morePrs: number
  total: number
  older: ChatNeed[]
  now: NowEntry[]
  finished: FinishedRow[]
  newCount: number
  earlier: number
  idle: { name: string; age: string }[]
  isClear: boolean
}

export const MAX_FINISHED_ROWS = 5
export const STALE_MS = 6 * 3_600_000
const NEED_NAME_MAX = 22
const NOW_NAME_MAX = 20
const FINISHED_NAME_MAX = 20
const LEAD_MAX = 16

const prNumber = (note: string): string | undefined => /PR #(\d+)/.exec(note)?.[1] ?? /#(\d+)/.exec(note)?.[1]

// "on Sam" when the note says who it waits for, else the note's first clause.
function waitNote(note: string): string {
  const who = /\b(?:[Oo]n|[Ff]or)\s+([A-Z][\w-]*)/.exec(note)?.[1]

  return who ? `on ${who}` : shortNote(note)
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

// `text` cut to `width` at the last word that fits, with an ellipsis; inside the word when the first half has no space.
export function cutWords(text: string, width: number): string {
  if (width <= 0) return ''
  if (cols(text) <= width) return text

  const chars = Array.from(text)
  const n = takeCols(chars, width - 1)
  const head = chars.slice(0, n)
  const space = chars[n] === ' ' ? n : head.lastIndexOf(' ')
  const kept = space >= head.length / 2 ? head.slice(0, space) : head

  return kept.join('').replace(/[\s,;:.\-–—(]+$/, '') + '…'
}

const goText = (session: HqSession | undefined, lead: HqSession | undefined): string =>
  session ? `⏎ ${session.target}` : lead ? 'not in tmux' : 'no live lead'

const statusOf = (s: HqSession): string => `${s.state === 'busy' ? '● working' : s.state === 'idle' ? '○ idle' : `⏸ ${s.state}`} ${s.age}`

// What the user sees, in the order they need it: questions with where to answer them, work in flight, work that just
// finished, and the sessions with nothing to do. A task is in one place only: a question is not in NOW, and a finished
// task is not in NOW or in a card.
export function focusLayout({ board, plan, ctx, holds = {}, requested = [], chats = [], files = {}, last = {}, questions = {}, owners = [], talks = [] }: FocusInput): FocusView {
  const [heldQuestions, lastLine, results, wholeQuestions] = [asRecord<string>(holds), asRecord<number>(last), asRecord<HqResultFiles>(files), asRecord<string>(questions)]
  const { fresh, older } = splitChats(chats, ctx.now)
  const sessions = board.elsewhere.filter(s => s.kind === 'claude').sort((a, b) => Number(b.state === 'busy') - Number(a.state === 'busy') || a.seconds - b.seconds)
  // the sessions a question sends the user to: they are not idle
  const asked = new Set<string>()
  const lastAt = (t: HqTask): number => lastLine[t.id] ?? ctx.entered[t.id] ?? ctx.now - ageSeconds(t.age) * 1000
  const stale = (t: HqTask): string => (ctx.now - lastAt(t) > STALE_MS ? ' ⚠' : '')

  const needs: NeedLine[] = [
    ...plan.asks.map((t): NeedLine => {
      const lead = resolveLead(board, t)?.session
      const to = jumpFor(board, t)?.session
      asked.add((to ?? lead)?.name ?? '')

      const label = t.decision ?? 'held'

      return {
        kind: 'ask',
        key: `ask:${t.id}`,
        name: (to ?? lead)?.name ?? shortName(t.id),
        msg: `${label} ${heldQuestions[t.id] ?? shortNote(t.note)}`.trimEnd(),
        full: `${label} ${collapse(wholeQuestions[t.id] ?? heldQuestions[t.id] ?? t.note)}`.trimEnd(),
        suffix: '',
        go: goText(to, lead),
        id: t.id,
        ...(to ? { session: to } : {}),
      }
    }),
    ...fresh.map((c): NeedLine => {
      asked.add(c.session.name)
      const age = ctx.now - c.at

      return {
        kind: 'chat',
        key: chatKey(c.session),
        name: c.session.name,
        msg: c.items.length > 1 ? `${c.items.length} questions` : (c.items[0] ?? ''),
        full: collapse(c.items.join(' ')),
        suffix: age > CHAT_AGE_SHOWN_MS ? ` · ${fmtAge(age / 1000)} old` : '',
        go: goText(c.session.target === '' ? undefined : c.session, c.session),
        ...(c.session.target === '' ? {} : { session: c.session }),
      }
    }),
    ...asList<HqReviewPr>(requested).slice(0, MAX_REVIEW_PRS).map((pr): NeedLine => {
      const to = repoJump(board, pr.repo.split('/').pop() ?? pr.repo)

      return { kind: 'pr', key: `pr:${pr.repo}#${pr.number}`, name: `PR ${pr.repo} #${pr.number}`, msg: pr.title, suffix: '', go: to ? `⏎ ${to.target}` : 'on GitHub', ...(to ? { session: to } : {}) }
    }),
  ]
  const morePrs = Math.max(0, asList(requested).length - MAX_REVIEW_PRS)

  const tasksOf = new Map<HqSession, string[]>(sessions.map(s => [s, []]))
  const other: string[] = []
  const open = (t: HqTask, phrase: string) => {
    const lead = resolveLead(board, t)?.session

    ;(lead ? tasksOf.get(lead)! : other).push(phrase)
  }
  // crew ls lists a task in review without a decision under RUNNING: the lead is verifying it
  for (const t of plan.now) open(t, t.state === 'queued' ? `${shortName(t.id)} queued` : `${shortName(t.id)} ${t.state === 'review' ? 'verifying' : t.state} ${t.age}${stale(t)}`)
  for (const t of plan.reviews) open(t, `${shortName(t.id)} verifying ${t.age}${stale(t)}`)
  for (const t of plan.waiting) open(t, `${[shortName(t.id), prNumber(t.note) && `#${prNumber(t.note)}`].filter(Boolean).join(' ')} waiting ${waitNote(t.note)}`.trimEnd())

  // asleep owners and open talk threads sit under their lead's card; those whose lead is not live go with "other crew"
  const live = sessions.map(s => s.name)
  const extras = (lead: string | null) => {
    const [ownerList, talkList] = [ownerRows(asList<OwnerEntry>(owners), ctx.now, lead, live), talkRows(asList<Talk>(talks), lead, live)]

    return { ...(ownerList.length > 0 ? { owners: ownerList } : {}), ...(talkList.length > 0 ? { talks: talkList } : {}) }
  }
  const extrasOf = new Map<HqSession, ReturnType<typeof extras>>(sessions.map(s => [s, extras(s.name)]))
  const hasExtras = (s: HqSession): boolean => Object.keys(extrasOf.get(s)!).length > 0

  const now: NowEntry[] = sessions
    .filter(s => tasksOf.get(s)!.length > 0 || s.state !== 'idle' || hasExtras(s) || s.lead)
    // a live lead with nothing else to show names its project in the task column
    .map(s => ({ name: s.name, status: statusOf(s), session: s, tasks: tasksOf.get(s)!.length === 0 && s.lead && !hasExtras(s) ? [sessionProject(s.where)] : tasksOf.get(s)!, ...extrasOf.get(s)! }))
  const otherExtras = extras(null)
  if (other.length > 0 || Object.keys(otherExtras).length > 0) now.push({ name: 'other crew', status: '', tasks: other, ...otherExtras })

  const idle = sessions.filter(s => s.state === 'idle' && !s.lead && tasksOf.get(s)!.length === 0 && !hasExtras(s) && !asked.has(s.name)).map(s => ({ name: s.name, age: s.age }))

  // unseen: finished after the user last looked, at everything or at this task (a result stays in the list for 24 hours)
  const seenAt = (id: string): number => Math.max(ctx.seen.all, ctx.seen.ids[id] ?? 0)
  const leadOf = (t: HqTask | undefined): string => (t ? (resolveLead(board, t)?.session.name ?? '') : '')
  const rows = [
    ...recentResults(board, ctx.entered, ctx.now).map((r): [number, FinishedRow] => [
      r.at,
      { id: r.id, mark: r.mark, isNew: r.at > seenAt(r.id), name: r.name, verdict: resultVerdict(r, results[r.id]), lead: leadOf(findTask(board, r.id)), detail: true },
    ]),
    // a task whose PR ended on GitHub has no result page: it asks the lead to log it
    ...plan.finished
      .filter(f => f.ended)
      .map((f): [number, FinishedRow] => [
        f.at,
        { id: f.task.id, mark: f.mark, isNew: true, name: `${shortName(f.task.id)} #${f.pr}`, verdict: f.text, lead: leadOf(f.task), detail: false },
      ]),
  ]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) => row)
  const finished = rows.slice(0, MAX_FINISHED_ROWS)

  return {
    needs,
    morePrs,
    total: needs.length + morePrs,
    older,
    now,
    finished,
    newCount: rows.filter(r => r.isNew).length,
    earlier: rows.length - finished.length,
    idle,
    isClear: needs.length === 0 && morePrs === 0 && older.length === 0 && now.length === 0 && rows.length === 0,
  }
}

const MIN_MSG = 12
const MIN_TASK_ROOM = 24
const MIN_VERDICT = 10
const COMPACT_INDENT = 4
const STATUS_MAX = 18

// A column may take at most this share of a narrow pane.
const share = (width: number, part = 0.3): number => Math.max(4, Math.floor(width * part))
const widest = (texts: string[]): number => Math.max(0, ...texts.map(cols))

// The columns of the NEEDS YOU lines: name, what, and where to go, as wide as `width` together with their two gaps.
// In a narrow pane the name keeps two fifths of it at most; the target is shortened to "⏎ 1.0" when the message would
// get under 12 columns, and when it still would, it moves to `below`, a dim line under the message.
export const MORE_MARK = ' ▸'

export function needParts(needs: NeedLine[], width: number): { name: string; msg: string; go: string; below: string }[] {
  const nameWidth = Math.min(NEED_NAME_MAX, share(width, 0.4), widest(needs.map(n => n.name)))
  let gos = needs.map(n => n.go)
  let msgWidth = width - nameWidth - 4 - widest(gos)
  if (msgWidth < MIN_MSG) {
    gos = gos.map(go => go.replace(/^⏎ [^:\s]*:/, '⏎ '))
    msgWidth = width - nameWidth - 4 - widest(gos)
  }
  const below = msgWidth < MIN_MSG
  if (below) {
    gos = gos.map(() => '')
    msgWidth = width - nameWidth - 4
  }
  const goWidth = widest(gos)
  msgWidth = Math.max(0, msgWidth)

  return needs.map((n, i) => {
    // a text that is cut, here or by the line itself, ends with a mark that the page has the rest
    const cut = n.full !== undefined && collapse(n.full) !== collapse(n.msg)
    const marked = (cut || cols(n.msg) > msgWidth) && msgWidth >= MIN_MSG
    const room = marked ? msgWidth - cols(MORE_MARK) : msgWidth
    const suffix = cols(n.suffix) + 4 <= room ? n.suffix : ''
    const text = suffix === '' ? cutWords(n.msg, room) : cutWords(n.msg, room - cols(suffix)) + suffix
    const msg = marked ? text + MORE_MARK : text

    return { name: padCols(fit(n.name, nameWidth), nameWidth), msg: padCols(msg, msgWidth), go: padCols(gos[i]!, goWidth), below: below ? n.go : '' }
  })
}

// The NOW lines: name and status in columns, then the tasks joined with " · "; when they do not fit in `width` they
// continue on lines indented under the first one, or, when the name column leaves them under 24 columns, on lines
// with a small indent (and the first line holds no task).
export function nowParts(entries: NowEntry[], width: number): { name: string; status: string; lines: string[] }[] {
  const nameWidth = Math.min(NOW_NAME_MAX, share(width), widest(entries.map(e => e.name)))
  const statuses = entries.map(e => fit(e.status, STATUS_MAX))
  const statusWidth = widest(statuses)
  const aligned = nameWidth + 2 + statusWidth + 2
  const roomy = width - aligned >= MIN_TASK_ROOM
  const room = roomy ? width - aligned : Math.max(10, width - COMPACT_INDENT)
  const indent = ' '.repeat(roomy ? aligned : COMPACT_INDENT)

  return entries.map((e, i) => {
    const out: string[] = []
    let line = ''
    for (const task of e.tasks.map(t => cutWords(t, room))) {
      if (line === '') line = task
      else if (cols(line) + 3 + cols(task) <= room) line += ` · ${task}`
      else {
        out.push(line)
        line = task
      }
    }
    if (line !== '' || out.length === 0) out.push(line)
    const lines = roomy || e.tasks.length === 0 ? out : ['', ...out]

    return { name: padCols(fit(e.name, nameWidth), nameWidth + 2), status: padCols(statuses[i]!, statusWidth + 2), lines: lines.map((l, j) => (j === 0 ? l : indent + l)) }
  })
}

// The JUST FINISHED rows after their mark: name, verdict cut at a word, and `→ lead` in a column; the lead is left out
// when the verdict would get under 10 columns.
export function finishedParts(rows: FinishedRow[], width: number): { name: string; verdict: string; lead: string }[] {
  const nameWidth = Math.min(FINISHED_NAME_MAX, share(width), widest(rows.map(r => r.name)))
  const leadMax = Math.max(4, Math.min(LEAD_MAX, share(width) - 2))
  let leads = rows.map(r => (r.lead === '' ? '' : `→ ${fit(r.lead, leadMax)}`))
  let verdictWidth = width - nameWidth - 4 - widest(leads)
  if (verdictWidth < MIN_VERDICT && widest(leads) > 0) {
    leads = leads.map(() => '')
    verdictWidth = width - nameWidth - 4
  }
  const leadWidth = widest(leads)
  verdictWidth = Math.max(0, verdictWidth)

  return rows.map((r, i) => ({
    name: padCols(fit(r.name, nameWidth), nameWidth),
    verdict: padCols(cutWords(r.verdict, verdictWidth), verdictWidth),
    lead: padCols(leads[i]!, leadWidth),
  }))
}

// `idle: acme-gateway-review 9m · beta-explore-68 2h`, with `· +N` for the sessions that do not fit.
export function idleText(idle: { name: string; age: string }[], width: number): string {
  const items = idle.map(i => `${i.name} ${i.age}`)
  const text = (n: number) => `idle: ${items.slice(0, n).join(' · ')}${n < items.length ? ` · +${items.length - n}` : ''}`

  for (let n = items.length; n > 0; n--) if (cols(text(n)) <= width) return text(n)

  return items.length === 0 ? '' : fit(text(1), width)
}

export const olderText = (older: ChatNeed[], width: number): string => fit(`older questions: ${older.map(c => c.session.name).join(', ')}`, width)

export const clearText = (idle: number): string => (idle === 0 ? 'All clear' : `All clear · ${idle} session${idle === 1 ? '' : 's'} idle`)

// --- RESULTS (24h): what finished lately, with the verdict the lead gave the user ---

export const RESULT_WINDOW_MS = 24 * 3_600_000
export const MAX_RESULTS = 8
export const RESULT_SKEW_MS = 5 * 60_000
const RESULT_STATES = ['done', 'landed', 'failed']

export type ResultItem = { id: string; mark: '✓' | '✗'; name: string; project: string; note: string; at: number }

// The tasks that reached done, landed or failed in the last 24 hours (a task stays here after it is marked Seen),
// newest first, at most 8. `entered` is when each entered its state (ms); a task without a time uses its crew ls age.
export const resultItems = (board: HqBoard, entered: Record<string, number>, now: number): ResultItem[] => recentResults(board, entered, now).slice(0, MAX_RESULTS)

// The same without the cap of eight: every task that finished in the last 24 hours, newest first.
export function recentResults(board: HqBoard, entered: Record<string, number>, now: number): ResultItem[] {
  return [...board.needsYou, ...board.done]
    .filter(t => RESULT_STATES.includes(t.state))
    .map((t): ResultItem => ({
      id: t.id,
      mark: t.state === 'failed' ? '✗' : '✓',
      name: shortName(t.id),
      project: projectName(t.repo),
      note: t.note,
      at: entered[t.id] ?? now - ageSeconds(t.age) * 1000,
    }))
    .filter(r => r.at <= now + RESULT_SKEW_MS && now - r.at < RESULT_WINDOW_MS)
    .sort((a, b) => b.at - a.at)
}

// Bold stars and code ticks; underscores are never taken out, they are part of identifiers (`__init__`, `a__b`).
const MARKS = /\*\*|`/g
export const stripMarks = (text: string): string => text.replace(MARKS, '')

// The first non-empty line of a markdown text on one line: heading marks, bold stars and code ticks removed.
export function plainLine(text: string | null | undefined): string {
  const line = (text ?? '').split('\n').find(l => l.trim() !== '') ?? ''

  return line
    .trim()
    .replace(/^#+\s*/, '')
    .replace(MARKS, '')
    .trim()
}

// The verdict of a result: the first line of summary.md, else of report.md, else the task's last note.
export const resultVerdict = (item: ResultItem, files: HqResultFiles | undefined): string => plainLine(files?.summary) || plainLine(files?.report) || item.note

// The text of a result in full: summary.md, else report.md, else the note; an empty or blank file counts as missing.
export function resultBody(files: HqResultFiles | undefined, note: string): string {
  return [files?.summary, files?.report].find(t => (t ?? '').trim() !== '') ?? note
}

// Plain text wrapped to `width` at spaces (a longer word is cut), blank lines kept; past `max` lines the rest is
// replaced by a count.
export function wrapText(text: string, width: number, max: number): string[] {
  const lines: string[] = []
  for (const para of text.trimEnd().split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(w => w !== '')) {
      let rest = Array.from(word)
      if (line !== '' && cols(line) + 1 + cols(word) <= width) {
        line += ` ${word}`
        continue
      }
      if (line !== '') lines.push(line)
      while (cols(rest.join('')) > width) {
        const n = Math.max(1, takeCols(rest, width))
        lines.push(rest.slice(0, n).join(''))
        rest = rest.slice(n)
      }
      line = rest.join('')
    }
    lines.push(line)
  }
  if (lines.length <= max) return lines

  return [...lines.slice(0, max - 1), `… ${lines.length - (max - 1)} more lines`]
}

// --- a NEEDS YOU line opened: the whole question, where it comes from, what to decide with, and what can be done ---

// What a page needs besides the line: the whole text of each open question and the last note of each task (by task id),
// the summary.md / report.md read for them, and the chat replies and review requests the lines came from.
export type NeedSources = {
  board: HqBoard
  now: number
  questions?: Record<string, string>
  notes?: Record<string, string>
  files?: Record<string, HqResultFiles>
  chats?: ChatNeed[]
  requested?: HqReviewPr[]
}

// `answer`: the id `crew answer` takes (a D-id, else a held task); `go`: the session to jump to; `dismiss`: the chat
// reply to hide; `url`: where a PR is; `diff`: the id of a task in review whose changes `crew diff` can show.
export type NeedDetail = {
  key: string
  kind: NeedLine['kind']
  title: string
  meta: string[]
  text: string
  context: { label: string; text: string }[]
  answer?: string
  go?: HqSession
  dismiss?: { key: string; at: number }
  url?: string
  diff?: string
}

// A task in review with a branch or a worktree in its meta has changes to look at.
export const canDiff = (t: HqTask): boolean =>
  t.state === 'review' && !t.diffCleared && (t.branch !== undefined || t.worktree !== undefined)

// The arguments `crew` is run with for the Diff action; `--focus` moves the user to the diff pane.
export const diffArgs = (id: string): string[] => ['diff', id, '--focus']

// What the user is told after `crew diff`: its one-line answer, or why it failed.
export function diffFeedback(ran: { exitCode: number; stdout: string; stderr: string }, id: string): string {
  if (ran.exitCode !== 0) return `diff failed: ${ran.stderr.trim() || `crew diff exited ${ran.exitCode}`}`

  return holdLine(ran.stdout) || `diff ${id}: opened`
}

// The dim lines at the foot of a page: the crew commands that show the same thing outside HQ.
export function needFooter(d: NeedDetail): string[] {
  const id = d.key.startsWith('ask:') ? d.key.slice(4) : undefined

  return id === undefined ? [] : [`crew show ${id}`, ...(d.diff ? [`crew ${diffArgs(d.diff).join(' ')}`] : [])]
}

// The last note of a status file (`ts<TAB>state<TAB>note`), whatever its state.
export function parseStatusNote(text: string): string {
  const last = text.split('\n').filter(l => l.trim() !== '').pop() ?? ''

  return last.split('\t').slice(2).join('\t').trim()
}

const nonBlank = (text: string | null | undefined): string => (text ?? '').trim()

// The page of one NEEDS YOU line. A question shows hold.md / ask.md whole (else the note crew ls gave), the task's last note
// when that says something else, and its summary.md, else report.md; a chat reply lists every item; a PR gives its URL.
export function needDetail(line: NeedLine, src: NeedSources): NeedDetail {
  const base = { key: line.key, kind: line.kind, ...(line.session ? { go: line.session } : {}) }

  if (line.kind === 'ask') {
    const task = [...src.board.needsYou, ...src.board.running, ...src.board.waiting, ...src.board.done].find(t => `ask:${t.id}` === line.key)
    if (!task) return { ...base, title: line.name, meta: [], text: line.full ?? line.msg, context: [] }

    const lead = resolveLead(src.board, task)
    const text = nonBlank(asRecord<string>(src.questions)[task.id]) || task.note
    const note = nonBlank(asRecord<string>(src.notes)[task.id])
    const files = asRecord<HqResultFiles>(src.files)[task.id]
    const summary = nonBlank(files?.summary)
    const report = nonBlank(files?.report)
    const context = [
      ...(note !== '' && collapse(note) !== collapse(text) ? [{ label: 'Latest note', text: note }] : []),
      ...(summary !== '' ? [{ label: 'Summary', text: summary }] : report !== '' ? [{ label: 'Report', text: report }] : []),
    ]

    return {
      ...base,
      title: `${task.decision ?? 'held'} · ${shortName(task.id)}`,
      meta: [
        `task ${task.id} · ${task.state} ${task.age}`,
        `lead ${lead ? `${lead.session.name}${lead.guessed ? ' (guess)' : ''}` : 'none live'} · project ${projectName(task.repo)}`,
      ],
      text,
      context,
      answer: task.decision ?? task.id,
      ...(canDiff(task) ? { diff: task.id } : {}),
    }
  }

  if (line.kind === 'chat') {
    const chat = asList<ChatNeed>(src.chats).find(c => c.key === line.key)
    const items = chat?.full ?? chat?.items ?? [line.msg]

    return {
      ...base,
      title: `${line.name} · in chat`,
      meta: [`session ${line.name}${chat ? ` · replied ${fmtAge(Math.max(0, src.now - chat.at) / 1000)} ago` : ''}`],
      text: items.length > 1 ? items.map(item => `- ${item}`).join('\n') : (items[0] ?? ''),
      context: [],
      ...(chat ? { dismiss: { key: chat.key, at: chat.at } } : {}),
    }
  }

  const pr = asList<HqReviewPr>(src.requested).find(p => `pr:${p.repo}#${p.number}` === line.key)

  return {
    ...base,
    title: line.name,
    meta: [`review requested${pr?.updatedAt ? ` · updated ${fmtAge(Math.max(0, src.now - pr.updatedAt) / 1000)} ago` : ''}`],
    text: pr?.title ?? line.msg,
    context: [],
    ...(pr && /^https:\/\//.test(pr.url) ? { url: pr.url } : {}),
  }
}

// What HQ's model is asked after the user answered in the pane: tell the lead, as it does for an answer typed in chat.
// `crew answer` has already recorded it.
export function relayPrompt(result: { id: string; decision?: string; lead: string | null; leadGuessed?: boolean }, answer: string): string {
  const label = result.decision ?? result.id
  const head = `The user answered ${label} in the HQ pane; crew answer has recorded it, so do not call hq_answer.`
  if (!result.lead) return `${head} No live session leads that task: tell the user the answer is recorded and nobody was told.`

  const guess = result.leadGuessed ? ` ${result.lead} is only a guess by project: if hq_board lists more than one live session for the project, ask the user which one instead of sending.` : ''

  return `${head} SendMessage ${result.lead} exactly:\nFrom HQ (user): ${label} answered. Answer: ${answer}\nThen confirm in one line.${guess}`
}

// --- starting a top-level lead (`crew spawn --top`), shared by the pane form and HQ web ---

export type NewLeadForm = { repo: string; name: string; text: string; model: string }

const LEAD_SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/
const LEAD_MODEL = /^[A-Za-z0-9][\][A-Za-z0-9._:-]*$/
export const LEAD_TEXT_MAX = 8000

// The folders a new lead can start in: where live sessions run and the repos of crew tasks, as full paths. Not `~/.claude`
// (crew refuses it) or anything inside a `.claude` folder (worktrees of agents).
export function knownRepos(live: HqLive[], b: HqBoard | null, home: string): string[] {
  const all = [...live.map(s => s.cwd), ...(b ? [...b.needsYou, ...b.running, ...b.waiting, ...b.done].map(t => t.repoPath ?? '') : [])]
  const fine = (p: string) => p.startsWith('/') && p !== '/' && p !== home && !`${p}/`.includes('/.claude/')

  return [...new Set(all.map(p => p.replace(/\/+$/, '')).filter(fine))].sort().slice(0, 12)
}

// The argv of `crew spawn --top` for the form, or why it cannot be built. Everything is a separate argument: nothing is
// quoted or interpolated, and the message follows `--` so that a leading dash is text.
export function spawnArgv(crewBin: string, form: NewLeadForm, home: string): { argv: string[] } | { error: string } {
  const name = form.name.trim()
  const model = form.model.trim()
  const text = form.text.replace(/\u0000/g, '').trim()
  let repo = form.repo.trim()
  if (repo === '~' || repo.startsWith('~/')) repo = `${home}${repo.slice(1)}`
  if (repo === '') return { error: 'pick a repo or type its path' }
  if (!repo.startsWith('/') || /[\u0000-\u001f]/.test(repo)) return { error: 'the repo must be an absolute path (or start with ~/)' }
  if (!LEAD_SLUG.test(name)) return { error: 'name: 2-41 lowercase letters, digits, dashes' }
  if (text === '') return { error: 'the first message is empty' }
  if (Array.from(text).length > LEAD_TEXT_MAX) return { error: `the first message is longer than ${LEAD_TEXT_MAX} characters` }
  if (model !== '' && !LEAD_MODEL.test(model)) return { error: `bad model '${model}'` }

  return { argv: [crewBin, 'spawn', '--top', name, '--repo', repo, ...(model === '' ? [] : ['--model', model]), '--', text] }
}

export type SpawnOutcome = { ok: true; id: string; window: string; queued: boolean } | { ok: false; error: string }

// What `crew spawn --top` said: the task and window it opened, `queued` when RAM was short, or why it refused.
export function spawnOutcome(ran: { exitCode: number; stdout: string; stderr: string }): SpawnOutcome {
  if (ran.exitCode !== 0) return { ok: false, error: ran.stderr.trim().replace(/^crew: /, '').split('\n').pop() || `crew spawn exited ${ran.exitCode}` }
  const id = /^id=(\S+)/m.exec(ran.stdout)?.[1] ?? ''
  const window = /^window=(\S+)/m.exec(ran.stdout)?.[1] ?? ''

  return { ok: true, id, window, queued: /^queued:/m.test(ran.stdout) }
}

// --- feature owners and talk threads (the registry of bin/crew-owners.sh), shared by the pane and HQ web ---

export type Owner = {
  feature: string
  repo: string
  paths: string[]
  sid: string
  name: string
  lead: string
  leadSid: string
  state: string
  sleptAt: string
  wokenAt: string
  window: string
  task: string
}

// An owner with the last line of its notes.md that says something (see lastNote).
export type OwnerEntry = Owner & { note: string }

// Rows are one line of plain text: what a registry file says would reach the terminal as it is. Escape sequences (OSC,
// CSI, a lone ESC and the byte after it), C0/C1 controls and DEL go; tabs, newlines and U+2028/9 become one space.
const ESCAPES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]?|\u001b[ -/]*[0-~]?/g
const plain = (text: string): string =>
  text
    .replace(ESCAPES, '')
    .replace(/[\t\n\r\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

// $CREW_ROOT/.owners/<id>/owner: `key=value` lines; the last one of a key wins, `path=` repeats.
export function parseOwner(text: string): Owner {
  const one: Record<string, string> = {}
  const paths: string[] = []

  for (const line of text.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/s.exec(line.trim())
    if (!m) continue
    if (m[1] === 'path') {
      if (m[2]) paths.push(plain(m[2]))
    } else one[m[1]!] = plain(m[2]!)
  }

  return {
    feature: one.feature ?? '',
    repo: one.repo ?? '',
    paths,
    sid: one.sid ?? '',
    name: one.name ?? '',
    lead: one.lead ?? '',
    leadSid: one.lead_sid ?? '',
    state: one.state ?? '',
    sleptAt: one.slept_at ?? '',
    wokenAt: one.woken_at ?? '',
    window: one.window ?? '',
    task: one.task ?? '',
  }
}

// The last non-empty line of an owner's notes.md that is not a heading.
export function lastNote(notes: string): string {
  const lines = notes.split('\n').map(l => l.trim())

  return plain([...lines].reverse().find(l => l !== '' && !l.startsWith('#')) ?? '').trim()
}

export type Talk = { a: string; b: string; topic: string; lead: string; leadSid: string; cap: number; turns: number; state: string }

// $CREW_ROOT/.talk/<thread>/meta: `key=value` lines, the last one of a key wins.
export function parseTalk(text: string): Talk {
  const one: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/s.exec(line.trim())
    if (m) one[m[1]!] = plain(m[2]!)
  }

  return { a: one.a ?? '', b: one.b ?? '', topic: one.topic ?? '', lead: one.lead ?? '', leadSid: one.lead_sid ?? '', cap: Number(one.cap) || 0, turns: Number(one.turns) || 0, state: one.state ?? '' }
}

// Rows go under the card of the live session that is their lead (matched by name: the board has no session ids); with
// `lead` null, they are the ones whose lead is not live, which go with "other crew".
const ledBy = (owner: string, lead: string | null, live: string[]): boolean => (lead === null ? !live.includes(owner) : owner === lead)

export type OwnerRow = { feature: string; text: string }

// `☾ <feature> · asleep <age> · <last note>` for each asleep owner of `lead`, by feature.
export function ownerRows(owners: OwnerEntry[], now: number, lead: string | null, live: string[] = []): OwnerRow[] {
  return owners
    .filter(o => o.state === 'asleep' && ledBy(o.lead, lead, live))
    .sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0))
    .map(o => {
      const at = Date.parse(o.sleptAt)
      const age = Number.isNaN(at) ? '' : ` ${fmtAge(Math.max(0, now - at) / 1000)}`

      const [feature, note] = [plain(o.feature), plain(o.note).trim()]

      return { feature, text: `☾ ${feature} · asleep${age}${note === '' ? '' : ` · ${note}`}` }
    })
}

// `talk: <a>↔<b> "<topic>" (<turns>/<cap>)` for each open thread of `lead`, ` capped` appended to a capped one.
export function talkRows(talks: Talk[], lead: string | null, live: string[] = []): string[] {
  return talks
    .filter(t => (t.state === 'open' || t.state === 'capped') && ledBy(t.lead, lead, live))
    .map(t => `talk: ${plain(t.a)}↔${plain(t.b)} "${plain(t.topic).trim()}" (${t.turns}/${t.cap})${t.state === 'capped' ? ' capped' : ''}`)
}

export const WAKE_TEXT_MAX = 2000
const OWNER_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

// The argv of `crew wake` and the environment it needs (CREW_AS_USER: the user is waking it, not a sibling), or why it
// cannot be built. Everything is a separate argument and the text follows `--`, so that a leading dash is text.
export function wakeArgv(crewBin: string, feature: string, text: string): { argv: string[]; env: Record<string, string> } | { error: string } {
  const task = text.replace(/\u0000/g, '').trim()
  if (!OWNER_ID.test(feature)) return { error: `bad feature '${feature}'` }
  if (task === '') return { error: 'the message is empty' }
  if (Array.from(task).length > WAKE_TEXT_MAX) return { error: `the message is longer than ${WAKE_TEXT_MAX} characters` }

  return { argv: [crewBin, 'wake', feature, '--', task], env: { CREW_AS_USER: '1' } }
}

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/

// The argv of `crew close` and the environment it needs (CREW_AS_USER: HQ is the user's, so it may close any session), or
// why it cannot be built. The name never starts with a dash, so crew cannot read it as a flag.
export function closeArgv(crewBin: string, name: string): { argv: string[]; env: Record<string, string> } | { error: string } {
  if (!SESSION_NAME.test(name)) return { error: `bad session name '${name}'` }

  return { argv: [crewBin, 'close', name], env: { CREW_AS_USER: '1' } }
}

export type CloseOutcome = { ok: true; message: string } | { ok: false; error: string }

// What `crew close` said: `closed: <name>, window <session:window> (<id>)`, or why it refused.
export function closeOutcome(ran: { exitCode: number; stdout: string; stderr: string }): CloseOutcome {
  if (ran.exitCode !== 0) return { ok: false, error: ran.stderr.trim().replace(/^crew: /, '').split('\n').pop() || `crew close exited ${ran.exitCode}` }

  return { ok: true, message: /^closed: .*$/m.exec(ran.stdout)?.[0]?.trim() ?? 'closed' }
}

export type WakeOutcome = { ok: true; queued: boolean; message: string } | { ok: false; error: string }

// What `crew wake` said: `woke <feature> in <window> (task <id>)`, `queued: …` when RAM was short, or why it refused.
export function wakeOutcome(ran: { exitCode: number; stdout: string; stderr: string }): WakeOutcome {
  if (ran.exitCode !== 0) return { ok: false, error: ran.stderr.trim().replace(/^crew: /, '').split('\n').pop() || `crew wake exited ${ran.exitCode}` }
  const queued = /^queued:.*$/m.exec(ran.stdout)?.[0]
  if (queued) return { ok: true, queued: true, message: queued.trim() }

  return { ok: true, queued: false, message: /^woke .*$/m.exec(ran.stdout)?.[0]?.trim() ?? 'woke' }
}
