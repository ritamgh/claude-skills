import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HqBoard, HqChat, HqChatEntry, HqLive, HqMeta, HqPr, HqPrEntry, HqResultFiles, HqReviewPr, HqReviews, HqSession } from '../types'
import type { FinishedRow, FocusView, HqLink, NeedDetail, NewLeadForm, OwnerEntry, PrRef, ResultItem, Talk } from './board'
import {
  REVIEW_ARGS,
  TAIL_BYTES,
  applyMeta,
  asList,
  asks,
  asRecord,
  boardForModel,
  briefText,
  chatNeeds,
  chatsDue,
  dismissChat,
  diffArgs,
  diffFeedback,
  classify,
  clearText,
  emptyBoard,
  emptySeen,
  findJump,
  findTask,
  finishedParts,
  fit,
  focusLayout,
  ghArgs,
  ghDue,
  holdLine,
  idleText,
  isTarget,
  jumpChoices,
  knownRepos,
  jumpFor,
  markSeen,
  mergeLive,
  mergedNotLogged,
  needCount,
  needDetail,
  needFooter,
  needParts,
  newlyEntered,
  nowParts,
  olderText,
  parseBoard,
  parseDismissed,
  parseLastReply,
  parseLive,
  lastNote,
  markLeads,
  parseLink,
  parseMeta,
  parseOwner,
  parseTalk,
  parsePr,
  parseReviewPrs,
  parseSeen,
  parseStat,
  parseStatusNote,
  parseStatusLastTs,
  parseStatusTs,
  prFor,
  prKey,
  prTasks,
  pruneDismissed,
  prunePrs,
  projectCards,
  projectName,
  projectsFooter,
  quietLine,
  relayPrompt,
  resolveLead,
  resultBody,
  resultItems,
  reviewDue,
  shortName,
  showTarget,
  spawnArgv,
  spawnOutcome,
  closeArgv,
  closeOutcome,
  wakeArgv,
  wakeOutcome,
  splitChats,
  splitRow,
  stripMarks,
  summarize,
  summaryCounts,
  taskDot,
  wrapText,
} from './board'

const PANE = 'hq-board'
// Rows the pane asks for while it sits inline above the prompt (the main screen); a dock ignores it.
const PANE_ARGS = { id: PANE, title: 'Crew board', rows: 16 }
const HIDDEN_HINT = 'Crew board hidden at this width — type /hq to show it'
const ROLE = [
  '# HQ role',
  "You are HQ, the user's command post over their crews. You relay; you do not do crew work yourself (no code edits, no investigations).",
  '- An instruction for a project, task or lead: call hq_board and take the task\'s `lead` (else the project\'s entry under `leads`; never an hq session). SendMessage it the user\'s words, faithfully, prefixed "From HQ (user): ". Then confirm in one line: "→ sent to <session>: <gist>" with the same `Open: <link>` as below when the session has a `link`. If it is ambiguous which lead, ask the user, listing the candidates.',
  '- If a task\'s lead has `leadGuessed` (a guess by project) and the project has more than one live session in hq_board, ask the user which session before sending.',
  '- The user answers a question ("D3 yes", "answer <task> <text>" or similar): call hq_answer {id, answer} (id: the D-id, else the task id) with their words verbatim, then SendMessage the lead it returns: "From HQ (user): <D-id or id> answered. Answer: <text>". Confirm in one line.',
  '- If the user asks about a task whose `pr.state` is MERGED while crew still shows it open: tell that task\'s lead "From HQ (user): PR #<N> is merged on GitHub; log <id> landed" and nothing more. You never log landed yourself.',
  '- Relaying a lead\'s reply or result to the user (also a cross-session idle notice): at most 3 short lines. The verdict in bold; the one or two facts the user needs; any decision they must make as `**Needs you:** …`. Then `Open: <link>` (the session\'s `link` in hq_board; omit it when there is none) and `tmux://<tmux target>` (its `tmux` target as a link, e.g. `tmux://claude:7`; omit it when there is none). Point to the full report path instead of copying it; do not restate what the user can read in the session.',
  '- Never invent instructions, and never approve anything (merges, landing, holds) the user did not say.',
  '- Status questions: answer from hq_board or `crew show <id>`.',
  "- Questions about an HTML report's content belong in that page's Ask panel; say so instead of answering.",
].join('\n')
const POLL_MS = 15_000
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const DECISION_ID = /^D\d+$/i

// Only a successful poll sets `board`, so it is the toast baseline; a failed one sets `error`.
const board = atom({ plugin: 'hq', key: 'board' } as const, null)
const error = atom({ plugin: 'hq', key: 'error' } as const, null)
const view = atom({ plugin: 'hq', key: 'view' } as const, 'focus')
const holdAtom = atom({ plugin: 'hq', key: 'holds' } as const, {})
// What the last gh query found per task, and the tasks already toasted as merged on GitHub.
const prAtom = atom({ plugin: 'hq', key: 'prs' } as const, {})
const prToasted = atom({ plugin: 'hq', key: 'prToasted' } as const, [])
// The PRs whose review is asked of the user, what the user has looked at (kept in the store too), and when each
// task on the board entered its current state.
const reviewAtom = atom({ plugin: 'hq', key: 'reviews' } as const, { fetched: 0, prs: null })
const seenAtom = atom({ plugin: 'hq', key: 'seen' } as const, emptySeen())
const enteredAtom = atom({ plugin: 'hq', key: 'entered' } as const, {})
// When each task last wrote a line to its status file: a task that keeps reporting is alive.
const lastAtom = atom({ plugin: 'hq', key: 'last' } as const, {})
// The Needs-you items of each live session's last reply, by transcript path.
const chatAtom = atom({ plugin: 'hq', key: 'chats' } as const, {})
// Which chat replies the user dismissed with Seen (kept in the store too).
const dismissedAtom = atom({ plugin: 'hq', key: 'dismissed' } as const, {})
// The summary.md / report.md text of each task in RESULTS, and the task whose result the pane shows in full.
const resultsAtom = atom({ plugin: 'hq', key: 'results' } as const, {})
const detailAtom = atom({ plugin: 'hq', key: 'detail' } as const, null)
// The whole text of each open question (hold.md / ask.md) and the last note of each task, by task id, and the line of
// NEEDS YOU whose page the pane shows.
const questionAtom = atom({ plugin: 'hq', key: 'questions' } as const, {})
const noteAtom = atom({ plugin: 'hq', key: 'notes' } as const, {})
const needAtom = atom({ plugin: 'hq', key: 'need' } as const, null)
// The first line of that page's question that is shown.
const needScroll = atom({ plugin: 'hq', key: 'needScroll' } as const, 0)
// The New lead form, null while it is closed.
const leadAtom = atom({ plugin: 'hq', key: 'newLead' } as const, null)
// The feature owners and talk threads of the registry (.owners, .talk), and the owner whose Wake form is open.
const ownerAtom = atom({ plugin: 'hq', key: 'owners' } as const, [])
const talkAtom = atom({ plugin: 'hq', key: 'talks' } as const, [])
const wakeAtom = atom({ plugin: 'hq', key: 'wake' } as const, null)
const SEEN_ALL = '[Seen all]'
const WAKE_MARK = ' [Wake]'
const CLOSE_MARK = ' ✕'
const DISMISS = ' [Dismiss]'
const RESULT_CHARS = 20_000
const DETAIL_LINES = 30
// A question longer than this is paged: the page shows this many of its lines, and Up / Down move by half of them.
const NEED_LINES = 20
const NEED_STEP = NEED_LINES / 2
const CONTEXT_LINES = 12
const NOTE_CHARS = 2_000

// What the atoms hold may be of an older shape (state outlives a reload of this module): a read that is not of the
// shape the pane expects counts as empty, so it can never throw while drawing.
const isBoard = (b: unknown): b is HqBoard => {
  const value = b as Partial<Record<keyof HqBoard, unknown>> | null

  return !!value && typeof value === 'object' && (['needsYou', 'running', 'waiting', 'done', 'elsewhere', 'parked'] as const).every(key => Array.isArray(value[key]))
}
const readBoard = async ($: EngineInterface): Promise<HqBoard | null> => {
  const value = await read($, board)

  return isBoard(value) ? value : null
}
const readReviews = async ($: EngineInterface): Promise<HqReviews> => {
  const value = (await read($, reviewAtom)) as Partial<HqReviews> | null

  return { fetched: typeof value?.fetched === 'number' ? value.fetched : 0, prs: Array.isArray(value?.prs) ? value.prs : null }
}
const saneChats = (raw: unknown): Record<string, HqChatEntry> =>
  Object.fromEntries(Object.entries(asRecord<Partial<HqChatEntry>>(raw)).filter(([, c]) => Array.isArray(c?.items) && typeof c?.at === 'number')) as Record<string, HqChatEntry>

async function crew($: EngineInterface, args: string[]) {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set')

  return $.process.run([`${home}/.claude/bin/crew`, ...args], { timeoutMs: 20_000 })
}

// bin/tmux-map: every live claude session with its full name and cwd, and its tmux pane if it has one.
async function liveSessions($: EngineInterface): Promise<HqLive[]> {
  try {
    const ran = await $.process.run([`${$.plugin.root}/bin/tmux-map`], { timeoutMs: 10_000 })

    return ran.exitCode === 0 ? parseLive(ran.stdout) : []
  } catch {
    return []
  }
}

// The open question of each task that has one, by id: hold.md for a held task, ask.md for another task with an open
// decision. `lines` has its first line, `full` all of it.
async function readHolds($: EngineInterface, b: HqBoard): Promise<{ lines: Record<string, string>; full: Record<string, string> }> {
  const home = await $.env.get('HOME')
  const lines: Record<string, string> = {}
  const full: Record<string, string> = {}

  for (const t of b.needsYou.filter(t => (t.state === 'held' || t.decision) && TASK_ID.test(t.id))) {
    try {
      const text = await $.fs.read(`${home}/.claude/crew/${t.id}/${t.state === 'held' ? 'hold' : 'ask'}.md`)
      lines[t.id] = holdLine(text)
      full[t.id] = text.trim().slice(0, RESULT_CHARS)
    } catch {
      // no hold.md: the task shows without its question
    }
  }

  return { lines, full }
}

// From each task's status file: when it entered its current state (the first line of the last run of that state), when
// it last wrote a line, and that line's note.
async function readStatus($: EngineInterface, b: HqBoard): Promise<{ entered: Record<string, number>; last: Record<string, number>; notes: Record<string, string> }> {
  const home = await $.env.get('HOME')
  const entered: Record<string, number> = {}
  const last: Record<string, number> = {}
  const notes: Record<string, string> = {}

  for (const t of [...b.needsYou, ...b.running, ...b.waiting, ...b.done].filter(t => TASK_ID.test(t.id))) {
    try {
      const text = await $.fs.read(`${home}/.claude/crew/${t.id}/status`)
      const [enteredAt, lastAt] = [parseStatusTs(text), parseStatusLastTs(text)]
      if (enteredAt !== undefined) entered[t.id] = enteredAt
      if (lastAt !== undefined) last[t.id] = lastAt
      notes[t.id] = parseStatusNote(text).slice(0, NOTE_CHARS)
    } catch {
      // no readable status file: the task counts as not new
    }
  }

  return { entered, last, notes }
}

// One crew file as [text, mtime]: kept from the cache while its mtime is unchanged, [null, 0] when it is missing.
async function readCached($: EngineInterface, path: string, was: [string | null, number]): Promise<[string | null, number]> {
  try {
    const { mtimeMs } = await $.fs.stat(path)
    if (was[1] === mtimeMs && was[0] !== null) return was

    return [(await $.fs.read(path)).slice(0, RESULT_CHARS), mtimeMs]
  } catch {
    return [null, 0]
  }
}

// summary.md of each task in RESULTS and of each open question (report.md only for one without a summary), read again
// only when its mtime changes.
async function readResults($: EngineInterface, b: HqBoard, entered: Record<string, number>, prev: Record<string, HqResultFiles>) {
  const home = await $.env.get('HOME')
  const now = await $.clock.now()
  const out: Record<string, HqResultFiles> = {}

  for (const { id } of [...resultItems(b, entered, now), ...asks(b)].filter(r => TASK_ID.test(r.id))) {
    const was = prev[id]
    const [summary, summaryAt] = await readCached($, `${home}/.claude/crew/${id}/summary.md`, [was?.summary ?? null, was?.summaryAt ?? 0])
    const [report, reportAt] = (summary ?? '').trim() === '' ? await readCached($, `${home}/.claude/crew/${id}/report.md`, [was?.report ?? null, was?.reportAt ?? 0]) : [null, 0]
    out[id] = { summary, summaryAt, report, reportAt }
  }

  return out
}

// The lead, repo path and branch from each open task's meta file.
async function readMetas($: EngineInterface, b: HqBoard): Promise<Record<string, HqMeta>> {
  const home = await $.env.get('HOME')
  const out: Record<string, HqMeta> = {}

  for (const t of [...b.needsYou, ...b.running, ...b.waiting, ...b.done].filter(t => TASK_ID.test(t.id))) {
    try {
      out[t.id] = parseMeta(await $.fs.read(`${home}/.claude/crew/${t.id}/meta`))
    } catch {
      // no readable meta: the task keeps the repo heuristic
    }
  }

  return out
}

// The chain links ($CREW_ROOT/.links/<sub sessionId>); a link that cannot be read is left out.
async function readLinks($: EngineInterface): Promise<HqLink[]> {
  const dir = `${await $.env.get('HOME')}/.claude/crew/.links`
  const links: HqLink[] = []

  try {
    for (const e of (await $.fs.list(dir)).filter(e => e.kind !== 'dir' && !e.name.includes('.tmp.'))) {
      try {
        links.push(parseLink(await $.fs.read(`${dir}/${e.name}`)))
      } catch {
        // no readable link: its session counts as a lead if a task says so
      }
    }
  } catch {
    // no links folder: no chains
  }

  return links
}

// The lead named in every task's meta file, of any age and state (not only the tasks crew ls still lists).
async function readLed($: EngineInterface): Promise<string[]> {
  const dir = `${await $.env.get('HOME')}/.claude/crew`
  let ids: string[] = []

  try {
    ids = (await $.fs.list(dir)).filter(e => e.kind === 'dir' && TASK_ID.test(e.name)).map(e => e.name)
  } catch {
    // no crew folder: no tasks
  }
  const metas = await Promise.all(ids.map(id => $.fs.read(`${dir}/${id}/meta`).then(parseMeta, () => ({}) as HqMeta)))

  return metas.flatMap(m => (m.lead ? [m.lead] : []))
}

// The registry of feature owners ($CREW_ROOT/.owners/<id>/owner with the last line of its notes.md) and the talk
// threads ($CREW_ROOT/.talk/<thread>/meta). A folder that cannot be read is left out; `.removed` is skipped.
async function readRegistry($: EngineInterface): Promise<{ owners: OwnerEntry[]; talks: Talk[] }> {
  const home = await $.env.get('HOME')
  const owners: OwnerEntry[] = []
  const talks: Talk[] = []
  const folders = async (dir: string) => {
    try {
      return (await $.fs.list(dir)).filter(e => e.kind === 'dir' && !e.name.startsWith('.') && TASK_ID.test(e.name)).map(e => e.name)
    } catch {
      return []
    }
  }

  for (const id of await folders(`${home}/.claude/crew/.owners`)) {
    try {
      const owner = parseOwner(await $.fs.read(`${home}/.claude/crew/.owners/${id}/owner`))
      const note = await $.fs.read(`${home}/.claude/crew/.owners/${id}/notes.md`).then(lastNote, () => '')
      if (owner.feature === id) owners.push({ ...owner, note: note.slice(0, NOTE_CHARS) })
    } catch {
      // no readable owner file: it shows nowhere
    }
  }
  for (const id of await folders(`${home}/.claude/crew/.talk`)) {
    try {
      talks.push(parseTalk(await $.fs.read(`${home}/.claude/crew/.talk/${id}/meta`)))
    } catch {
      // no readable meta: the thread shows nowhere
    }
  }

  return { owners, talks }
}

// One gh query; any failure (no auth, not a GitHub repo, network) is just "no PR known".
async function fetchPr($: EngineInterface, ref: PrRef, cwd: string): Promise<HqPr | null> {
  try {
    const ran = await $.process.run(ghArgs(ref), { cwd, timeoutMs: 20_000 })

    return ran.exitCode === 0 ? parsePr(ran.stdout) : null
  } catch {
    return null
  }
}

// The one search for PRs whose review is asked of the user. A failed search keeps the last list.
async function fetchReviews($: EngineInterface): Promise<HqReviewPr[] | null> {
  try {
    const ran = await $.process.run(REVIEW_ARGS, { timeoutMs: 20_000 })

    return ran.exitCode === 0 ? parseReviewPrs(ran.stdout) : null
  } catch {
    return null
  }
}

let isReading = false

// Reads the end of each live session's transcript when the file changed since the last read: one `stat` for all of
// them, then a `tail` for each changed one, reading more of the end while neither a reply nor a prompt is in it. No
// model is involved, and what is read stays in the pane's state: it is never logged, toasted or sent to the model.
async function refreshChats($: EngineInterface, sessions: HqSession[]) {
  if (isReading) return
  isReading = true

  try {
    const paths = sessions.flatMap(s => (s.transcript ? [s.transcript] : []))
    const cache = saneChats(await read($, chatAtom))
    const next: Record<string, HqChatEntry> = Object.fromEntries(Object.entries(cache).filter(([path]) => paths.includes(path)))
    let changed = Object.keys(next).length !== Object.keys(cache).length

    if (paths.length > 0) {
      const stats = parseStat((await $.process.run(['stat', '-c', '%n|%s|%Y', '--', ...paths], { timeoutMs: 10_000 })).stdout)

      for (const path of Object.keys(next).filter(path => !stats[path])) {
        delete next[path]
        changed = true
      }
      for (const path of chatsDue(stats, next)) {
        const { size, mtime } = stats[path]!
        let chat: HqChat | null = null
        let failed = false
        for (const bytes of TAIL_BYTES) {
          try {
            const tail = await $.process.run(['tail', '-c', String(bytes), '--', path], { timeoutMs: 10_000 })
            if (tail.exitCode !== 0 || tail.isStdoutTruncated) throw new Error('unreadable')
            chat = parseLastReply(tail.stdout, size > bytes)
          } catch {
            // a read that failed, at either size, is not kept: the next poll tries again
            failed = true
            break
          }
          if (chat !== null || size <= bytes) break
        }
        delete next[path]
        if (!failed) next[path] = { items: chat?.items ?? [], at: chat?.at || mtime * 1000, size, mtime }
        changed = true
      }
    }
    if (changed) await update($, chatAtom, () => next)
  } catch {
    // an unreadable transcript leaves its session without chat items
  } finally {
    isReading = false
  }
}

let isRefreshing = false

// Asks GitHub (outside the board poll, at most three queries each time, the review search among them): who asked
// the user for a review, and about the PRs of the tasks that are due. Caches the answers, and toasts each task the
// first time it is seen merged on GitHub but not logged landed.
async function refreshPrs($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true

  try {
    const b = await readBoard($)
    if (!b) return

    const now = await $.clock.now()
    const reviews = await readReviews($)
    const searching = reviewDue(reviews, now)
    if (searching) {
      const prs = await fetchReviews($)
      await update($, reviewAtom, () => ({ fetched: now, prs: prs ?? reviews.prs }))
    }
    const found: Record<string, HqPrEntry> = {}
    for (const { task, ref } of ghDue(prTasks(b), asRecord<HqPrEntry>(await read($, prAtom)), now, searching ? 2 : undefined)) {
      found[task.id] = { key: prKey(task)!, fetched: now, pr: await fetchPr($, ref, task.repoPath!) }
    }
    const cache = asRecord<HqPrEntry>(await read($, prAtom))
    const kept = prunePrs(b, cache)
    if (Object.keys(found).length === 0 && Object.keys(kept).length === Object.keys(cache).length) return

    await update($, prAtom, () => ({ ...kept, ...found }))

    const prs = asRecord<HqPrEntry>(await read($, prAtom))
    const seen = asList<string>(await read($, prToasted))
    for (const { task } of mergedNotLogged(b, prs).filter(m => !seen.includes(m.task.id))) {
      $.ui.toast(`${shortName(task.id)} merged on GitHub — not logged`)
      await update($, prToasted, list => [...list, task.id])
    }
  } catch {
    // a failed refresh leaves the cache as it was
  } finally {
    isRefreshing = false
  }
}

// Switches the tmux client to the session's pane; says why not (and toasts it) instead of throwing.
async function jump($: EngineInterface, to: HqSession): Promise<string | null> {
  const reason = await switchClient($, to.target)
  if (reason) $.ui.toast(reason)

  return reason
}

// The user asks for the changes of a task in review: `crew diff <id> --focus` opens them in nvim next to the lead. Its
// one-line answer, or why it failed, is toasted; a failure to run it at all is toasted too, not thrown.
async function diffInPane($: EngineInterface, id: string): Promise<void> {
  if (!TASK_ID.test(id)) return $.ui.toast(`diff failed: no task "${id}"`)

  try {
    $.ui.toast(diffFeedback(await crew($, diffArgs(id)), id))
  } catch (failure) {
    $.ui.toast(`diff failed: ${String(failure)}`)
  }
}

async function switchClient($: EngineInterface, target: string): Promise<string | null> {
  if (!isTarget(target)) return `tmux: refusing the target "${target}"`
  if (!(await $.env.get('TMUX'))) return "HQ isn't running inside tmux — start it with tmux"

  try {
    const ran = await $.process.run(['tmux', 'switch-client', '-t', target])

    return ran.exitCode === 0 ? null : `tmux: ${ran.stderr.trim() || `switch-client exited ${ran.exitCode}`}`
  } catch (failure) {
    return `tmux: ${String(failure)}`
  }
}

// hq_answer: records the user's answer to a held task or an open decision (a D-id, or the id of a task that has
// one) and names the lead session to notify.
async function answerHold($: EngineInterface, id: string, answerText: string) {
  const answer = answerText.trim()
  if (answer === '') return { deny: 'the answer is empty' }
  if (!TASK_ID.test(id)) return { deny: `no held task "${id}"` }

  const decision = DECISION_ID.test(id) ? id.toUpperCase() : undefined
  await poll($)
  const b = await readBoard($)
  const task = b?.needsYou.find(t => (decision ? t.decision === decision : t.id === id))
  if (!b || !task) return { deny: decision ? `no open decision "${id}"` : `no held task "${id}"` }
  if (task.state !== 'held' && !task.decision) return { deny: `task ${id} is not held (state: ${task.state})` }

  const ran = await crew($, ['answer', decision ?? id, answer])
  if (ran.exitCode !== 0) return { deny: ran.stderr.trim() || `crew answer exited ${ran.exitCode}` }

  const lead = resolveLead(b, task)

  return {
    result: JSON.stringify({
      ok: true,
      id: task.id,
      ...(task.decision ? { decision: task.decision } : {}),
      lead: lead ? lead.session.name : null,
      ...(lead?.guessed ? { leadGuessed: true } : {}),
      ...(lead ? {} : { note: 'no live session for this project: tell the user' }),
    }),
  }
}

// The user answers a question on its page: the same as hq_answer, then HQ's model is asked to tell the lead, as it
// does for an answer typed in chat. Says why not (and toasts it) instead of throwing.
async function answerInPane($: EngineInterface, id: string, text: string): Promise<boolean> {
  const answered = await answerHold($, id, text)
  if ('deny' in answered) {
    $.ui.toast(`answer not recorded: ${answered.deny}`)

    return false
  }

  const result = JSON.parse(answered.result) as { id: string; decision?: string; lead: string | null; leadGuessed?: boolean }
  $.ui.toast(`${result.decision ?? result.id} answered${result.lead ? ` — telling ${result.lead}` : ' — no live lead to tell'}`)
  void poll($)
  // a turn of HQ's own: not waited for here, so the page closes at once
  $.prompt
    .submit({ text: relayPrompt(result, text.trim()) })
    .then(submitted => submitted.drop !== undefined && $.ui.toast(`recorded, but the lead was not told: ${submitted.drop}`))
    .catch(failure => $.ui.toast(`recorded, but the lead was not told: ${String(failure)}`))

  return true
}

// Opens the New lead form with the folders HQ knows: where live sessions run and the repos of crew tasks.
async function openLeadForm($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const choices = knownRepos(await liveSessions($), await readBoard($), home)
  await update($, leadAtom, () => ({ repo: '', name: '', text: '', model: '', choices }))
}

// Starts a top-level lead: `crew spawn --top` as argv, a plain command and never a model turn. Toasts what happened
// (the window, or why not) instead of throwing; true when it started or queued.
async function startLead($: EngineInterface, form: NewLeadForm): Promise<boolean> {
  const home = (await $.env.get('HOME')) ?? ''
  const built = spawnArgv(`${home}/.claude/bin/crew`, form, home)
  if ('error' in built) {
    $.ui.toast(`not started: ${built.error}`)

    return false
  }

  const ran = await $.process.run(built.argv, { timeoutMs: 30_000 }).catch(failure => ({ exitCode: 127, stdout: '', stderr: String(failure) }))
  const outcome = spawnOutcome(ran)
  if (!outcome.ok) {
    $.ui.toast(`not started: ${outcome.error}`)

    return false
  }

  $.ui.toast(outcome.queued ? `${form.name.trim()} queued: waiting for RAM (crew spawn --resume ${outcome.id})` : `${form.name.trim()} started in ${outcome.window}`)
  void poll($)

  return true
}

async function openWakeForm($: EngineInterface, feature: string) {
  await update($, wakeAtom, () => feature)
}

// Wakes an owner: `crew wake FEATURE -- text` as argv with CREW_AS_USER=1, a plain command and never a model turn.
// Toasts what happened (woke in a window, queued, or why not) instead of throwing; true when it woke or queued.
async function wakeOwner($: EngineInterface, feature: string, text: string): Promise<boolean> {
  const home = (await $.env.get('HOME')) ?? ''
  const built = wakeArgv(`${home}/.claude/bin/crew`, feature, text)
  if ('error' in built) {
    $.ui.toast(`not woken: ${built.error}`)

    return false
  }

  const ran = await $.process.run(built.argv, { env: built.env, timeoutMs: 30_000 }).catch(failure => ({ exitCode: 127, stdout: '', stderr: String(failure) }))
  const outcome = wakeOutcome(ran)
  if (!outcome.ok) {
    $.ui.toast(`not woken: ${outcome.error}`)

    return false
  }

  $.ui.toast(outcome.message)
  void poll($)

  return true
}

// Closes a session's window: `crew close NAME` as argv with CREW_AS_USER=1 (HQ is the user's), a plain command and never a
// model turn. Toasts what happened (the closed window, or crew's reason for refusing) instead of throwing.
async function closeSession($: EngineInterface, name: string): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const built = closeArgv(`${home}/.claude/bin/crew`, name)
  if ('error' in built) {
    $.ui.toast(`not closed: ${built.error}`)

    return
  }

  const ran = await $.process.run(built.argv, { env: built.env, timeoutMs: 30_000 }).catch(failure => ({ exitCode: 127, stdout: '', stderr: String(failure) }))
  const outcome = closeOutcome(ran)
  $.ui.toast(outcome.ok ? outcome.message : `not closed: ${outcome.error}`)
  void poll($)
}

// The user has looked at everything (no id) or at one task: JUST FINISHED drops it.
async function see($: EngineInterface, id?: string) {
  const next = markSeen(parseSeen(await read($, seenAtom)), await $.clock.now(), id)
  await update($, seenAtom, () => next)
  try {
    await $.store.set('seen', next)
  } catch {
    // not persisted: the seen-state lasts until HQ closes
  }
}

// The Needs-you items that sessions left in chat and nobody recorded.
const allChats = async ($: EngineInterface, b: HqBoard) => chatNeeds(b, saneChats(await read($, chatAtom)), parseDismissed(await read($, dismissedAtom)))
// Only the sessions whose last reply is under a day old are a need: the band and /hq count those.
const chatsOf = async ($: EngineInterface, b: HqBoard) => splitChats(await allChats($, b), await $.clock.now()).fresh

// Drops the dismissals of replies that were replaced and of sessions that are gone.
async function forgetDismissed($: EngineInterface, b: HqBoard) {
  const was = parseDismissed(await read($, dismissedAtom))
  const kept = pruneDismissed(b, saneChats(await read($, chatAtom)), was)
  if (Object.keys(kept).length === Object.keys(was).length) return
  await update($, dismissedAtom, () => kept)
  try {
    await $.store.set('chatSeen', kept)
  } catch {
    // not persisted: the dismissals lasted until HQ closes
  }
}

// The user dismisses what a session said in chat: the items stay hidden until its next reply.
async function dismiss($: EngineInterface, key: string, at: number) {
  const next = dismissChat(parseDismissed(await read($, dismissedAtom)), key, at)
  await update($, dismissedAtom, () => next)
  try {
    await $.store.set('chatSeen', next)
  } catch {
    // not persisted: the dismissal lasts until HQ closes
  }
}

// The user dismisses the sessions whose questions are over a day old.
async function dismissAll($: EngineInterface, chats: { key: string; at: number }[]) {
  for (const { key, at } of chats) await dismiss($, key, at)
}

let inflight: Promise<void> | null = null

// One poll at a time; a caller that arrives meanwhile waits for the one under way.
function poll($: EngineInterface): Promise<void> {
  inflight ??= pollOnce($).finally(() => {
    inflight = null
  })

  return inflight
}

async function pollOnce($: EngineInterface) {
  try {
    const prev = await readBoard($)
    const [ran, live] = await Promise.all([crew($, ['ls']), liveSessions($)])
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `crew ls exited ${ran.exitCode}`)
    const parsed = parseBoard(ran.stdout)
    const next = markLeads(applyMeta(mergeLive(parsed, live), await readMetas($, parsed)), await readLinks($), await readLed($))
    await update($, board, () => next)
    const asked = await readHolds($, next)
    const registry = await readRegistry($)
    await update($, ownerAtom, () => registry.owners)
    await update($, talkAtom, () => registry.talks)
    await update($, holdAtom, () => asked.lines)
    await update($, questionAtom, () => asked.full)
    const { entered, last, notes } = await readStatus($, next)
    await update($, enteredAtom, () => entered)
    await update($, lastAtom, () => last)
    await update($, noteAtom, () => notes)
    const results = await readResults($, next, entered, asRecord<HqResultFiles>(await read($, resultsAtom)))
    await update($, resultsAtom, () => results)
    await refreshChats($, next.elsewhere.filter(s => s.kind === 'claude'))
    await forgetDismissed($, next)
    await update($, error, () => null)
    for (const message of newlyEntered(prev, next)) $.ui.toast(message)
    void refreshPrs($)
  } catch (failure) {
    await update($, error, () => String(failure))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hq',
      description:
        'Refresh the crew board and show its pane; "show <id>" prints one task, "view" switches Focus and Projects, "go <name>" jumps to a session or task in tmux, "seen" clears JUST FINISHED, "brief" says what changed since you last looked',
      argumentHint: '[show <id> | view | go <name> | seen | brief]',
    })
    await $.tool.register({
      name: 'hq_board',
      description:
        'Read-only. The crew board as JSON: open tasks (id, short name, repo, state, age, note, decision id and question when one is open), live claude sessions (name, project, state, age, tmux target, `link`: the claude.ai URL that opens the session, when it has one), the lead session of each task (`leadGuessed` when it is only a guess by project) and its GitHub PR (number, state) when known, and the best lead per project. Call it before relaying an instruction.',
      isDeferred: false,
    })
    await $.tool.register({
      name: 'hq_answer',
      description:
        "Records the user's answer to a held crew task or an open decision (runs crew answer). id: a decision id such as D3, or a held task; answer: the user's words verbatim. Returns the lead session to notify.",
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, answer: { type: 'string' } },
        required: ['id', 'answer'],
      },
      isDeferred: false,
    })
    try {
      const saved = parseSeen(await $.store.get('seen'))
      await update($, seenAtom, () => saved)
    } catch {
      // no store: nothing has been looked at yet
    }
    try {
      const dismissed = parseDismissed(await $.store.get('chatSeen'))
      await update($, dismissedAtom, () => dismissed)
    } catch {
      // no store: nothing has been dismissed yet
    }
    const opened = await $.ui.open(PANE_ARGS)
    if (!opened.isPlaced) $.ui.status(HIDDEN_HINT)
    $.clock.after(1, () => void poll($))
    $.clock.every(POLL_MS, () => void poll($))

    return next(e)
  })

  on('tool.call', { tool: 'mcp__hq__hq_board' }, async $ => {
    await poll($)
    const [b, asked, prs] = [await readBoard($), asRecord<string>(await read($, holdAtom)), asRecord<HqPrEntry>(await read($, prAtom))]

    return b ? { result: JSON.stringify(boardForModel(b, asked, prs)) } : { deny: (await read($, error)) ?? 'the board is not loaded yet' }
  })

  on('tool.call', { tool: 'mcp__hq__hq_answer' }, ($, e) => answerHold($, String(e.id ?? ''), String(e.answer ?? '')))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, { id: 'hq-role', text: ROLE, scope: 'session' as const }] }
  })

  on('command.run', { command: 'hq' }, async ($, e) => {
    const [sub, ...ids] = e.args.trim().split(/\s+/)

    if (sub === 'show') {
      const [id] = ids
      if (ids.length !== 1 || !id || !TASK_ID.test(id)) return { text: 'usage: /hq show <task id>' }
      const ran = await crew($, ['show', id])
      if (ran.exitCode === 0) await see($, id)

      return { text: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trimEnd() }
    }

    if (sub === 'go') {
      const b = (await readBoard($)) ?? emptyBoard()
      const query = ids.length === 1 ? ids[0]! : ''
      const named = b.elsewhere.find(s => s.kind === 'claude' && s.target !== '' && s.name === query)
      const task = named ? undefined : findTask(b, query)
      const hit = named ?? (task ? jumpFor(b, task)?.session : undefined) ?? (ids.length === 1 ? findJump(b, query) : undefined)

      if (!hit) {
        const choices = jumpChoices(b)

        return { text: choices.length === 0 ? 'No tmux sessions known yet.' : `No match for "${ids.join(' ')}". Try: ${choices.slice(0, 12).join(', ')}` }
      }

      const reason = await jump($, hit)
      if (!reason && task) await see($, task.id)

      return { text: reason ?? `Jumped to ${hit.name} (${showTarget(hit.target)})` }
    }

    if (sub === 'brief') {
      await poll($)
      const failure = await read($, error)
      const b = await readBoard($)
      if (failure || !b) return { text: `crew ls failed: ${failure ?? 'the board is not loaded yet'}` }

      const [now, last] = [await $.clock.now(), await $.store.get('lastBrief')]
      const isFirst = typeof last !== 'number'
      const text = briefText(b, isFirst ? now - 86_400_000 : last, now, isFirst, (await readStatus($, b)).entered, mergedNotLogged(b, asRecord<HqPrEntry>(await read($, prAtom))))
      await $.store.set('lastBrief', now)

      return { text }
    }

    if (sub === 'seen') {
      await see($)

      return { text: '✓/✗ marks cleared' }
    }

    if (sub === 'view') {
      const next = (await read($, view)) === 'focus' ? 'projects' : 'focus'
      await update($, view, () => next)

      return { text: `View: ${next}` }
    }

    $.ui.status(undefined)
    await poll($)
    await $.ui.open(PANE_ARGS)
    const current = await readBoard($)
    const failure = await read($, error)

    const reviews = (await readReviews($)).prs?.length ?? 0

    return { text: failure ?? (current && summarize(current, reviews, await chatsOf($, current))) ?? 'Crew board refreshed.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await readBoard($)
    const reviews = (await readReviews($)).prs?.length ?? 0
    const chats = current ? await chatsOf($, current) : []
    const line = current && summarize(current, reviews, chats)

    if (e.props.hasSurvey || !line) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color={needCount(current, reviews, chats) > 0 ? 'warning' : undefined}>{fit(line, e.props.bodyColumns)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Link, Text } = $.ui.resolve(e)
    const current = await readBoard($)
    const failure = await read($, error)
    const mode = await read($, view)
    const asked = asRecord<string>(await read($, holdAtom))
    const prs = asRecord<HqPrEntry>(await read($, prAtom))
    const now = await $.clock.now()
    const reviewPrs = (await readReviews($)).prs ?? []
    const results = asRecord<HqResultFiles>(await read($, resultsAtom))
    const detailRead = await read($, detailAtom)
    const detail = typeof detailRead === 'string' ? detailRead : null
    const needRead = await read($, needAtom)
    const needKey = typeof needRead === 'string' ? needRead : null
    const scrolledRead = await read($, needScroll)
    const scrolled = typeof scrolledRead === 'number' ? scrolledRead : 0
    const leadRead = (await read($, leadAtom)) as (NewLeadForm & { choices: string[] }) | null
    const leadForm = leadRead && typeof leadRead === 'object' && Array.isArray(leadRead.choices) ? leadRead : null
    const wakeRead = await read($, wakeAtom)
    const wakeFeature = typeof wakeRead === 'string' ? wakeRead : null
    const owners = asList<OwnerEntry>(await read($, ownerAtom))
    const talks = asList<Talk>(await read($, talkAtom))
    const questions = asRecord<string>(await read($, questionAtom))
    const notes = asRecord<string>(await read($, noteAtom))
    const last = asRecord<number>(await read($, lastAtom))
    const ctx = { now, entered: asRecord<number>(await read($, enteredAtom)), seen: parseSeen(await read($, seenAtom)), prs }
    // all of them: the layout puts the sessions whose reply is over a day old apart
    const chats = current ? await allChats($, current) : []
    // inside the pane's padding of 1
    const width = Math.max(10, e.props.bodyColumns - 2)

    const tab = (key: 'focus' | 'projects', label: string) => (
      <Button
        key={`tab-${key}`}
        plain
        onPress={async () => {
          await update($, detailAtom, () => null)
          await update($, needAtom, () => null)
          await update($, needScroll, () => 0)
          await update($, leadAtom, () => null)
          await update($, wakeAtom, () => null)
          await update($, view, () => key)
        }}
      >
        <Text bold={mode === key} dimColor={mode !== key}>
          {label}
        </Text>
      </Button>
    )

    const jumpToLead = (b: HqBoard, id: string) => {
      const task = findTask(b, id)

      return task ? jumpFor(b, task)?.session : undefined
    }

    // A row of JUST FINISHED: a result opens its page and counts as seen; one without a page (its PR ended on GitHub)
    // jumps to the lead that has to log it, and counts as seen once there.
    const openFinished = async (b: HqBoard, row: FinishedRow) => {
      if (row.detail) {
        await see($, row.id)
        await update($, detailAtom, () => row.id)

        return
      }
      const hit = jumpToLead(b, row.id)
      if (hit && !(await jump($, hit))) await see($, row.id)
    }

    const layoutOf = (b: HqBoard) => focusLayout({ board: b, plan: classify(b, ctx), ctx, holds: asked, requested: reviewPrs, chats, files: results, last, questions, owners, talks })

    const focus = (b: HqBoard, layout: FocusView) => {
      // inside the two columns of the glyph or indent that starts every line
      const inner = width - 2
      const needs = needParts(layout.needs, inner)
      const nowLines = nowParts(layout.now, inner - CLOSE_MARK.length)
      const finished = finishedParts(layout.finished, inner)
      const heading = `JUST FINISHED${layout.newCount > 0 ? ` · ${layout.newCount} new` : ''}`
      // with something new the line is padded so that [Seen all] ends at the right edge
      const headingText = layout.newCount > 0 ? splitRow(heading, SEEN_ALL, width)[0] : heading

      return (
        <Box flexDirection="column">
          {(layout.needs.length > 0 || layout.older.length > 0) && (
            <Box flexDirection="column" marginTop={1}>
              {layout.needs.length > 0 && <Text bold>{`NEEDS YOU (${layout.total})`}</Text>}
              {layout.needs.map((n, i) => {
                const open = (
                  <Button
                    key={`need-${n.key}`}
                    plain
                    onPress={async () => {
                      await update($, needScroll, () => 0)
                      await update($, needAtom, () => n.key)
                    }}
                  >
                    <Text color={n.kind === 'pr' ? 'yellow' : 'magenta'}>{'? '}</Text>
                    <Text wrap="truncate-end">{`${needs[i]!.name}  ${needs[i]!.msg}  `}</Text>
                  </Button>
                )
                const goKey = n.id ? `go-${n.id}` : n.kind === 'chat' ? `go-chat-${n.session?.name}` : `go-pr-${i}`
                // where to go: at the right edge, or on a dim line of its own when the pane is too narrow for both
                const goAt = (text: string, dim: boolean) =>
                  n.session ? (
                    <Button key={goKey} plain onPress={() => void jump($, n.session!)}>
                      <Text color="cyan" dimColor={dim}>
                        {text}
                      </Text>
                    </Button>
                  ) : (
                    <Text dimColor>{text}</Text>
                  )

                return (
                  <Box flexDirection="column">
                    <Box>
                      {open}
                      {needs[i]!.below === '' && goAt(needs[i]!.go, false)}
                    </Box>
                    {needs[i]!.below !== '' && <Box>{goAt(`  ${needs[i]!.below}`, true)}</Box>}
                  </Box>
                )
              })}
              {layout.morePrs > 0 && <Text dimColor>{`  +${layout.morePrs} more review requests`}</Text>}
              {layout.older.length > 0 && (
                <Box>
                  <Text dimColor wrap="truncate-end">
                    {olderText(layout.older, width - DISMISS.length)}
                  </Text>
                  <Button key="dismiss-older" plain onPress={() => void dismissAll($, layout.older)}>
                    <Text dimColor>{DISMISS}</Text>
                  </Button>
                </Box>
              )}
            </Box>
          )}
          {layout.now.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>NOW</Text>
              {layout.now.map((e, i) => {
                const hit = e.session && e.session.target !== '' ? e.session : undefined
                const busy = e.session?.state === 'busy'
                const texts = [
                  <Text bold={e.session !== undefined} dimColor={e.session === undefined}>{`  ${nowLines[i]!.name}`}</Text>,
                  <Text color={busy ? 'cyan' : undefined} dimColor={!busy}>
                    {nowLines[i]!.status}
                  </Text>,
                  <Text wrap="truncate-end">{nowLines[i]!.lines[0]}</Text>,
                ]

                return (
                  <Box flexDirection="column">
                    {hit ? (
                      <Box>
                        <Button key={`go-${hit.name}`} plain onPress={() => void jump($, hit)}>
                          {texts}
                        </Button>
                        <Button key={`close-${hit.name}`} plain onPress={() => void closeSession($, hit.name)}>
                          <Text color="cyan">{CLOSE_MARK}</Text>
                        </Button>
                      </Box>
                    ) : (
                      <Box>{texts}</Box>
                    )}
                    {nowLines[i]!.lines.slice(1).map(line => (
                      <Text wrap="truncate-end">{`  ${line}`}</Text>
                    ))}
                    {e.owners?.map(o => (
                      <Box key={`owner-${o.feature}`}>
                        <Text dimColor wrap="truncate-end">
                          {fit(`  ${o.text}`, inner - WAKE_MARK.length)}
                        </Text>
                        <Button key={`wake-${o.feature}`} plain onPress={() => void openWakeForm($, o.feature)}>
                          <Text color="cyan">{WAKE_MARK}</Text>
                        </Button>
                      </Box>
                    ))}
                    {e.talks?.map(t => (
                      <Text dimColor wrap="truncate-end">
                        {fit(`  ${t}`, inner)}
                      </Text>
                    ))}
                  </Box>
                )
              })}
            </Box>
          )}
          {layout.finished.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text bold>{headingText}</Text>
                {layout.newCount > 0 && (
                  <Button key="seen-all" plain onPress={() => void see($)}>
                    <Text dimColor>{SEEN_ALL}</Text>
                  </Button>
                )}
              </Box>
              {layout.finished.map((row, i) => (
                <Button key={`result-${row.id}`} plain onPress={() => void openFinished(b, row)}>
                  <Text color={row.mark === '✗' ? 'red' : 'green'}>{`${row.mark === '✗' ? '✗' : row.isNew ? '●' : ' '} `}</Text>
                  <Text wrap="truncate-end">{`${finished[i]!.name}  ${finished[i]!.verdict}  `}</Text>
                  {finished[i]!.lead !== '' && <Text dimColor>{finished[i]!.lead}</Text>}
                </Button>
              ))}
              {layout.earlier > 0 && <Text dimColor>{`  +${layout.earlier} earlier`}</Text>}
            </Box>
          )}
          {(layout.isClear || layout.idle.length > 0) && (
            <Box marginTop={1}>
              <Text dimColor wrap="truncate-end">
                {layout.isClear ? clearText(layout.idle.length) : idleText(layout.idle, width)}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    // One result in full: summary.md, else report.md, else the note; a missing file only shortens what is shown.
    const detailView = (b: HqBoard, item: ResultItem) => {
      const files = results[item.id]
      const hit = jumpToLead(b, item.id)
      const lines = wrapText(stripMarks(resultBody(files, item.note)), width, DETAIL_LINES)

      return (
        <Box flexDirection="column">
          <Box marginTop={1}>
            <Button key="result-back" plain onPress={() => update($, detailAtom, () => null)}>
              <Text>← Back</Text>
            </Button>
          </Box>
          <Box marginTop={1}>
            <Text bold color={item.mark === '✓' ? 'green' : 'red'}>{`${item.mark} ${item.name} · ${item.project}`}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {lines.map(line => (
              <Text>{line === '' ? ' ' : line}</Text>
            ))}
          </Box>
          {hit && (
            <Box marginTop={1}>
              <Button key="result-go" plain onPress={() => void jump($, hit)}>
                <Text>{`→ ${hit.name} (${hit.target})`}</Text>
              </Button>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>{`crew show ${item.id}`}</Text>
          </Box>
        </Box>
      )
    }

    // One NEEDS YOU line in full: what it is and where it comes from, the whole text wrapped to the pane, what to
    // decide with, and what can be done (answer, go, dismiss, open the PR).
    const needView = (d: NeedDetail) => {
      const footer = needFooter(d)
      const back = async () => {
        await update($, needScroll, () => 0)
        await update($, needAtom, () => null)
      }
      const all = wrapText(stripMarks(d.text), width, Infinity)
      const top = Math.min(Math.max(0, scrolled), Math.max(0, all.length - NEED_LINES))
      const end = Math.min(all.length, top + NEED_LINES)
      const move = (to: number) => update($, needScroll, () => Math.max(0, Math.min(to, all.length - NEED_LINES)))

      return (
        <Box flexDirection="column">
          <Box marginTop={1}>
            <Button key="need-back" plain onPress={back}>
              <Text>← Back</Text>
            </Button>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold color={d.kind === 'pr' ? 'yellow' : 'magenta'}>{`? ${d.title}`}</Text>
            {d.meta.map(line => (
              <Text dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {all.slice(top, end).map(line => (
              <Text>{line === '' ? ' ' : line}</Text>
            ))}
            {all.length > NEED_LINES && (
              <Box>
                {top > 0 && (
                  <Button key="need-up" plain onPress={() => move(top - NEED_STEP)}>
                    <Text color="cyan">▲ Up  </Text>
                  </Button>
                )}
                {end < all.length && (
                  <Button key="need-down" plain onPress={() => move(top + NEED_STEP)}>
                    <Text color="cyan">▼ Down  </Text>
                  </Button>
                )}
                <Text dimColor>{`lines ${top + 1}-${end} of ${all.length}`}</Text>
              </Box>
            )}
          </Box>
          {d.url && (
            <Box marginTop={1}>
              <Link href={d.url} />
            </Box>
          )}
          {d.context.map(c => (
            <Box flexDirection="column" marginTop={1}>
              <Text bold dimColor>
                {c.label}
              </Text>
              {wrapText(stripMarks(c.text), width - 2, CONTEXT_LINES).map(line => (
                <Text>{`  ${line}`}</Text>
              ))}
            </Box>
          ))}
          {d.answer && (
            <Box marginTop={1}>
              <Input
                key="need-answer"
                label="Answer "
                placeholder="type it, then Enter"
                submitLabel="answer"
                onSubmit={async text => {
                  if (await answerInPane($, d.answer!, text)) await back()
                }}
              />
            </Box>
          )}
          {(d.go || d.dismiss || d.diff) && (
            <Box marginTop={1}>
              {d.go && (
                <Button key="need-go" plain onPress={() => void jump($, d.go!)}>
                  <Text color="cyan">{`⏎ ${d.go.name} (${d.go.target})`}</Text>
                </Button>
              )}
              {d.go && d.diff && <Text>{'  '}</Text>}
              {d.diff && (
                <Button key="need-diff" plain onPress={() => void diffInPane($, d.diff!)}>
                  <Text color="cyan">[Diff]</Text>
                </Button>
              )}
              {(d.go || d.diff) && d.dismiss && <Text>{'  '}</Text>}
              {d.dismiss && (
                <Button
                  key="need-dismiss"
                  plain
                  onPress={() => {
                    void dismiss($, d.dismiss!.key, d.dismiss!.at)
                    void back()
                  }}
                >
                  <Text dimColor>{DISMISS.trim()}</Text>
                </Button>
              )}
            </Box>
          )}
          {footer.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              {footer.map(line => (
                <Text dimColor>{line}</Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    // The New lead form: pick a folder or type its path, then name, first message and (optionally) model; each field is
    // kept when Enter is pressed in it, and Start runs `crew spawn --top`.
    const leadView = (f: NewLeadForm & { choices: string[] }) => {
      const close = () => update($, leadAtom, () => null)
      const set = (patch: Partial<NewLeadForm>) => update($, leadAtom, () => ({ ...f, ...patch }))
      const field = (label: string, value: string) => (
        <Text dimColor wrap="truncate-end">
          {`${label} ${value === '' ? '—' : value.replace(/\s+/g, ' ')}`}
        </Text>
      )

      return (
        <Box flexDirection="column">
          <Box marginTop={1}>
            <Button key="new-back" plain onPress={() => void close()}>
              <Text>← Back</Text>
            </Button>
          </Box>
          <Box marginTop={1}>
            <Text bold>New lead</Text>
          </Box>
          {f.choices.map((path, i) => (
            <Button key={`new-repo-${i}`} plain onPress={() => void set({ repo: path })}>
              <Text wrap="truncate-end" color={f.repo === path ? 'cyan' : undefined}>{`${f.repo === path ? '◉' : '○'} ${path}`}</Text>
            </Button>
          ))}
          <Box marginTop={1} flexDirection="column">
            {field('repo   ', f.repo)}
            {field('name   ', f.name)}
            {field('message', f.text)}
            {field('model  ', f.model)}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Input key="new-repo" label="Path " placeholder="or type a folder" submitLabel="set" onSubmit={text => void set({ repo: text.trim() })} />
            <Input key="new-name" label="Name " placeholder="a-z, 0-9, dashes" submitLabel="set" onSubmit={text => void set({ name: text.trim() })} />
            <Input key="new-text" label="Message " placeholder="the lead's first message" submitLabel="set" onSubmit={text => void set({ text })} />
            <Input key="new-model" label="Model " placeholder="blank: the CLI default" submitLabel="set" onSubmit={text => void set({ model: text.trim() })} />
          </Box>
          <Box marginTop={1}>
            <Button
              key="new-start"
              plain
              onPress={async () => {
                if (await startLead($, f)) await close()
              }}
            >
              <Text color="cyan">▶ Start lead</Text>
            </Button>
          </Box>
        </Box>
      )
    }

    const wakeView = (feature: string) => {
      const close = () => update($, wakeAtom, () => null)

      return (
        <Box flexDirection="column">
          <Box marginTop={1}>
            <Button key="wake-back" plain onPress={() => void close()}>
              <Text>← Back</Text>
            </Button>
          </Box>
          <Box marginTop={1}>
            <Text bold wrap="truncate-end">{`Wake ${feature}`}</Text>
          </Box>
          <Box marginTop={1}>
            <Input
              key="wake-text"
              label="Task "
              placeholder="what it should do first"
              submitLabel="wake"
              onSubmit={async text => {
                if (await wakeOwner($, feature, text)) await close()
              }}
            />
          </Box>
        </Box>
      )
    }

    const projects = (b: HqBoard) => {
      const all = projectCards(b, classify(b, ctx))
      const cards = all.filter(c => c.isActive)
      const quiet = quietLine(all)
      const footer = projectsFooter(summaryCounts(b))
      const inner = width - 4

      return (
        <Box flexDirection="column">
          {cards.length === 0 && quiet === '' && (
            <Box marginTop={1}>
              <Text dimColor>No projects active</Text>
            </Box>
          )}
          {cards.map(card => (
            <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1} width={width}>
              <Text bold wrap="truncate-end">
                {card.name}
              </Text>
              {card.tasks.map(t => {
                const dot = taskDot(t.state)
                const [name, state] = splitRow(shortName(t.id), `${t.state}  ${t.age}`, inner - 2)

                return (
                  <Box>
                    <Text color={dot.color}>{dot.glyph} </Text>
                    <Text wrap="truncate-end">{name}</Text>
                    <Text dimColor>{state}</Text>
                  </Box>
                )
              })}
              {card.busy.map(s => {
                const hit = s.target === '' ? undefined : s
                const [name, state] = splitRow(s.name, `busy  ${s.age}${hit ? `  ${showTarget(hit.target)}` : ''}`, inner - 2)
                const texts = [
                  <Text color="cyan">◐ </Text>,
                  <Text>{name}</Text>,
                  <Text dimColor>{state}</Text>,
                ]

                return hit ? (
                  <Button key={`go-${s.name}`} plain onPress={() => void jump($, hit)}>
                    {texts}
                  </Button>
                ) : (
                  <Box>{texts}</Box>
                )
              })}
              {card.idle > 0 && <Text dimColor>○ {card.idle} idle</Text>}
              {card.waiting > 0 && <Text dimColor>⏸ {card.waiting} waiting</Text>}
            </Box>
          ))}
          {quiet !== '' && (
            <Box marginTop={1}>
              <Text dimColor wrap="truncate-end">
                {quiet}
              </Text>
            </Box>
          )}
          {footer !== '' && (
            <Box marginTop={1}>
              <Text dimColor wrap="truncate-end">
                {footer}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" padding={1}>
        <Box>
          {tab('focus', 'Focus')}
          <Text dimColor> · </Text>
          {tab('projects', 'Projects')}
          <Text dimColor> · </Text>
          <Button key="new-lead" plain onPress={() => void openLeadForm($)}>
            <Text color="cyan">＋ New lead</Text>
          </Button>
        </Box>
        {leadForm && leadView(leadForm)}
        {!leadForm && wakeFeature !== null && wakeView(wakeFeature)}
        {!leadForm && wakeFeature === null && failure && (
          <Box marginTop={1}>
            <Text color="error" wrap="truncate-end">
              {fit(`crew ls failed: ${failure}`, width)}
            </Text>
          </Box>
        )}
        {leadForm || wakeFeature !== null ? null : !current ? (
          !failure && (
            <Box marginTop={1}>
              <Text dimColor>Loading the crew board...</Text>
            </Box>
          )
        ) : mode === 'focus' ? (
          (() => {
            const shown = detail === null ? undefined : resultItems(current, ctx.entered, now).find(r => r.id === detail)
            if (shown) return detailView(current, shown)

            const layout = layoutOf(current)
            const line = needKey === null ? undefined : layout.needs.find(n => n.key === needKey)

            return line ? needView(needDetail(line, { board: current, now, questions, notes, files: results, chats: splitChats(chats, now).fresh, requested: reviewPrs })) : focus(current, layout)
          })()
        ) : (
          projects(current)
        )}
      </Box>
    )
  })
}
