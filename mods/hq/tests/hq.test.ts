import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const runOf = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// One line of bin/tmux-map: name, tmux target, window, full cwd, status, seconds since its last update.
const liveRow = (name: string, target: string, cwd: string, status: string, seconds: number) =>
  [name, target, 'w', cwd, status, seconds].join('\t') + '\n'
const ACME_GATEWAY = '/home/user/Developer/acme-gateway'

const asked = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

const RUNNING = 'RUNNING\n  1-a   running  0m  ship  user  working\n'
const REVIEW = 'NEEDS YOU\n  1-a   review  1m  ship  user  verified\nRUNNING ELSEWHERE\n  claude hq   busy  1m  ~\n'
const HELD = 'NEEDS YOU\n  1-a   held  1m  ship  user  D1 · blocked\nRUNNING ELSEWHERE\n  claude hq   busy  1m  ~\n'

test('polls `crew ls` on a timer and toasts a task that newly enters review, but not on the first poll', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/test' })
  const argvs: string[][] = []
  const toasts: string[] = []
  let stdout = REVIEW
  on('process.run', (_$, e) => {
    if (e.argv[0]!.endsWith('/tmux-map')) return runOf('')
    argvs.push([...e.argv])
    return runOf(stdout)
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__hq__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'hq' } }))

  await $.session.start({ cwd: '/home/test', surface: null, isInteractive: true })
  await clock.advance(2)

  expect(argvs).toEqual([['/home/test/.claude/bin/crew', 'ls']])
  expect(toasts).toEqual([])

  stdout = RUNNING
  await clock.advance(15_000)
  expect(toasts).toEqual([])

  stdout = REVIEW
  await clock.advance(15_000)
  expect(toasts).toEqual(['1-a → review'])

  await clock.advance(15_000)
  expect(toasts).toEqual(['1-a → review'])
})

test('/hq show <id> returns the output of `crew show <id>` and refuses an id that looks like a flag', async ($, on) => {
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on)
  mock.store(on, {})
  const argvs: string[][] = []
  on('process.run', (_$, e) => {
    argvs.push([...e.argv])
    return runOf('== 1-a (review)\n')
  })

  const shown = await $.command.run({ command: 'hq', args: 'show 1-a', ...asked })
  const refused = await $.command.run({ command: 'hq', args: 'show --all', ...asked })

  expect(shown.text).toBe('== 1-a (review)')
  expect(refused.text).toBe('usage: /hq show <task id>')
  expect(argvs).toEqual([['/home/test/.claude/bin/crew', 'show', '1-a']])
})

// A session whose `crew ls` answers come from `replies`, one per call (the last repeats), each
// held for `delayMs` on the mocked clock; `/hq show` answers are not needed here.
async function boot($: Engine, on: On, replies: { stdout: string; exitCode?: number }[], delayMs = 0) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/test' })
  const toasts: string[] = []
  let calls = 0
  on('process.run', async (_$, e) => {
    if (e.argv[0]!.endsWith('/tmux-map')) return runOf('')
    const reply = replies[Math.min(calls, replies.length - 1)]!
    calls += 1
    if (delayMs > 0) await clock.sleep(delayMs)
    return runOf(reply.stdout, reply.exitCode ?? 0)
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__hq__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'hq' } }))
  await $.session.start({ cwd: '/home/test', surface: null, isInteractive: true })

  return { clock, toasts }
}

test('/hq while a poll is still running waits for it and reports what it found', async ($, on) => {
  const { clock } = await boot($, on, [{ stdout: HELD }], 1000)
  await clock.advance(2)

  const pending = $.command.run({ command: 'hq', args: '', ...asked })
  await clock.advance(1000)

  expect((await pending).text).toBe('⚠ 1 need you')
})

test('a failed first poll does not become the baseline: the first good poll toasts nothing', async ($, on) => {
  const { clock, toasts } = await boot($, on, [
    { stdout: '', exitCode: 1 },
    { stdout: REVIEW },
    { stdout: RUNNING },
    { stdout: REVIEW },
  ])
  await clock.advance(2)
  await clock.advance(15_000)
  expect(toasts).toEqual([])

  await clock.advance(15_000)
  await clock.advance(15_000)
  expect(toasts).toEqual(['1-a → review'])
})

test('/hq show with more than one id is refused instead of dropping the extra', async ($, on) => {
  mock.env(on, { HOME: '/home/test' })
  const argvs: string[][] = []
  on('process.run', (_$, e) => {
    argvs.push([...e.argv])
    return runOf('== 1-a (review)\n')
  })

  const refused = await $.command.run({ command: 'hq', args: 'show 1-a 1-b', ...asked })

  expect(refused.text).toBe('usage: /hq show <task id>')
  expect(argvs).toEqual([])
})

test('/hq view switches between the Focus and Projects views', async ($, on) => {
  const first = await $.command.run({ command: 'hq', args: 'view', ...asked })
  const second = await $.command.run({ command: 'hq', args: 'view', ...asked })

  expect([first.text, second.text]).toEqual(['View: projects', 'View: focus'])
})

const PANE_BOARD = [
  'NEEDS YOU',
  '  1014-1014-stats              review      3h  ship  acme-gateway   verified 965 pass; branch user/stats 64ce4b4',
  'PARKED',
  '  P2   10-15  user         a note',
  'DONE',
  '  1012-a                       done        3h  ship  acme-gateway   landed',
  '',
].join('\n')

test('the pane draws Focus first (a review task without a decision is verifying in NOW, a finished task in JUST FINISHED, an idle session in one line) and Projects after the tab is pressed', async ($, on) => {
  await bootJump($, on, {
    inTmux: true,
    crewOut: PANE_BOARD,
    mapOut: liveRow('acme-gateway-9e', 'claude:2.0', ACME_GATEWAY, 'busy', 120) + liveRow('acme-gateway-80', '', ACME_GATEWAY, 'idle', 3600),
  })
  const props = {
    title: 'Crew board',
    isFocused: false,
    bodyColumns: 64,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  } as const
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)

  expect(await texts()).toEqual([
    'Focus',
    ' · ',
    'Projects',
    ' · ',
    '＋ New lead',
    'NOW',
    '  acme-gateway-9e  ',
    '● working 2m  ',
    'stats verifying 3h',
    ' ✕',
    'JUST FINISHED · 1 new'.padEnd(52),
    '[Seen all]',
    '● ',
    `a  ${'landed'.padEnd(38)}  `,
    '→ acme-gateway-9e',
    'idle: acme-gateway-80 1h',
  ])

  await ui.press({ key: 'tab-projects' })
  const after = await texts()
  expect(after.slice(0, 7)).toEqual(['Focus', ' · ', 'Projects', ' · ', '＋ New lead', 'acme-gateway', '● '])
  expect(after).toContain('◇ 1 parked · ✓ 1 done today')
  await ui.unmount()
})

// A session with one tmux-mapped claude session; `crew ls`, `crew answer` and `tmux-map` answer by
// program, hold.md files come from `files`, and every other program (tmux switch-client) is
// answered with `switchReply`. `calls` records every program run, `statuses` the status line.
async function bootJump(
  $: Engine,
  on: On,
  {
    inTmux,
    switchReply = { exitCode: 0, stderr: '' },
    crewOut = '',
    mapOut = liveRow('acme-gateway-80', 'claude:6.0', ACME_GATEWAY, 'idle', 3600),
    now = 1_000_000_000,
    ghOut = '[]',
    ghExit = 0,
    searchOut = '[]',
    files = {},
    opened = { isPlaced: true },
    store = {},
    tails = {},
    spawn = { exitCode: 0, stdout: '', stderr: '' },
    wake = { exitCode: 0, stdout: '', stderr: '' },
    close = { exitCode: 0, stdout: '', stderr: '' },
  }: {
    inTmux: boolean
    // what `crew spawn` answers
    spawn?: { exitCode: number; stdout: string; stderr: string }
    // what `crew wake` answers
    wake?: { exitCode: number; stdout: string; stderr: string }
    // what `crew close` answers
    close?: { exitCode: number; stdout: string; stderr: string }
    // transcripts `stat` and `tail` can read, by path; `fail` makes `tail` exit 1
    tails?: Record<string, { text: string; mtime: number; fail?: boolean; failBytes?: string }>
    switchReply?: { exitCode: number; stderr: string }
    crewOut?: string
    mapOut?: string
    files?: Record<string, string>
    opened?: { isPlaced: true } | { isPlaced: false; reason: string }
    store?: Record<string, unknown>
    now?: number
    ghOut?: string
    ghExit?: number
    searchOut?: string
  },
) {
  const clock = mock.clock(on, { now })
  mock.env(on, inTmux ? { HOME: '/home/test', TMUX: '/tmp/tmux-1000/default,1,0' } : { HOME: '/home/test' })
  const stored = store
  // the store is `store` itself, so a test can read what the pane saved
  on('store.get', (_$, e) => ({ value: stored[e.key] }))
  on('store.set', (_$, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete stored[e.key]
    return { value: undefined }
  })
  const calls: string[][] = []
  // the env each `crew wake` ran with
  const wakeEnvs: (Record<string, string> | undefined)[] = []
  // the env each `crew close` ran with
  const closeEnvs: (Record<string, string> | undefined)[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const opens: { id: string; rows?: number }[] = []
  // what `crew ls` answers; a test changes it between polls
  const crew = { out: crewOut, exitCode: 0, diff: { out: '', err: '', exitCode: 0 } }
  // what `gh` answers, and every gh call with the directory it ran in
  const gh = { out: ghOut, exitCode: ghExit, searchOut }
  const ghCalls: { argv: string[]; cwd: string | undefined }[] = []
  // the one `gh search prs` for review requests is kept apart from the per-task `gh pr` queries
  const searchCalls: string[][] = []
  on('process.run', (_$, e) => {
    const exe = e.argv[0]!
    if (exe === 'gh' && e.argv[1] === 'search') {
      searchCalls.push([...e.argv])
      return runOf(gh.searchOut, gh.exitCode)
    }
    if (exe === 'gh') {
      ghCalls.push({ argv: [...e.argv], cwd: e.init?.cwd })
      return runOf(gh.out, gh.exitCode)
    }
    calls.push([...e.argv])
    if (exe === 'stat') return runOf(e.argv.slice(4).filter(p => tails[p]).map(p => `${p}|${tails[p]!.text.length}|${tails[p]!.mtime}`).join('\n'))
    if (exe === 'tail') {
      const t = tails[e.argv[4]!]

      return t?.fail || t?.failBytes === e.argv[2] ? runOf('', 1) : runOf(t?.text ?? '')
    }
    if (exe.endsWith('/crew') && e.argv[1] === 'ls') return runOf(crew.out, crew.exitCode)
    if (exe.endsWith('/crew') && e.argv[1] === 'diff') {
      return { value: { exitCode: crew.diff.exitCode, stdout: crew.diff.out, stderr: crew.diff.err, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (exe.endsWith('/crew') && e.argv[1] === 'wake') {
      wakeEnvs.push(e.init?.env)
      return { value: { ...wake, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (exe.endsWith('/crew') && e.argv[1] === 'close') {
      closeEnvs.push(e.init?.env)
      return { value: { ...close, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (exe.endsWith('/crew') && e.argv[1] === 'spawn') return { value: { ...spawn, isStdoutTruncated: false, isStderrTruncated: false } }
    if (exe.endsWith('/crew')) return runOf('')
    if (exe.endsWith('/tmux-map')) return runOf(mapOut)

    return { value: { ...switchReply, stdout: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // the files a test may change between polls; an mtime of 1 unless `mtimes` says otherwise
  const reads: string[] = []
  const mtimes: Record<string, number> = {}
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.stat', (_$, e) =>
    files[e.path] === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: files[e.path]!.length, mtimeMs: mtimes[e.path] ?? 1, isLink: false } },
  )
  // a folder is listed from the files under it
  on('fs.list', (_$, e) => {
    const names = new Set(Object.keys(files).filter(f => f.startsWith(`${e.path}/`)).map(f => f.slice(e.path.length + 1).split('/')[0]!))
    if (names.size === 0) return { deny: 'ENOENT' }

    return { value: [...names].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', (_$, e) => {
    opens.push({ id: e.id, rows: e.rows })
    return { value: opened }
  })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__hq__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'hq' } }))
  await $.session.start({ cwd: '/home/test', surface: null, isInteractive: true })
  await clock.advance(2)

  return { calls, wakeEnvs, closeEnvs, toasts, statuses, opens, clock, crew, gh, ghCalls, searchCalls, files, mtimes, reads, tails }
}

const SWITCH = ['tmux', 'switch-client', '-t', 'claude:6.0']

test('each poll runs bin/tmux-map from the plugin folder', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true })

  expect(calls.map(argv => argv[0]!.split('/').slice(-2).join('/'))).toEqual(['bin/tmux-map', 'bin/crew'])
})

test('/hq go <session> switches the tmux client to that session pane', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true })

  const went = await $.command.run({ command: 'hq', args: 'go acme-gateway-80', ...asked })

  expect(calls.slice(2)).toEqual([SWITCH])
  expect(went.text).toBe('Jumped to acme-gateway-80 (claude:6)')
})

test('/hq go <repo> picks a session of that project', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true })

  await $.command.run({ command: 'hq', args: 'go acme-gateway', ...asked })

  expect(calls.slice(2)).toEqual([SWITCH])
})

test('/hq go outside tmux toasts why and calls nothing', async ($, on) => {
  const { calls, toasts } = await bootJump($, on, { inTmux: false })

  const went = await $.command.run({ command: 'hq', args: 'go acme-gateway-80', ...asked })

  expect(toasts).toEqual(["HQ isn't running inside tmux — start it with tmux"])
  expect(went.text).toBe("HQ isn't running inside tmux — start it with tmux")
  expect(calls.slice(2)).toEqual([])
})

test('/hq go with a failing switch-client toasts the reason instead of throwing', async ($, on) => {
  const { toasts } = await bootJump($, on, { inTmux: true, switchReply: { exitCode: 1, stderr: "can't find session: claude\n" } })

  await $.command.run({ command: 'hq', args: 'go acme-gateway-80', ...asked })

  expect(toasts).toEqual(["tmux: can't find session: claude"])
})

test('/hq go with an unknown name lists what it can jump to', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true })

  const went = await $.command.run({ command: 'hq', args: 'go zzz', ...asked })

  expect(went.text).toBe('No match for "zzz". Try: acme-gateway, acme-gateway-80')
  expect(calls.slice(2)).toEqual([])
})

test('a question in NEEDS YOU and the Projects busy session jump to their session when pressed', async ($, on) => {
  const { calls } = await bootJump($, on, {
    inTmux: true,
    crewOut: 'NEEDS YOU\n  1014-1014-stats  review  3h  ship  acme-gateway  D3 · verified 965 pass; x\n',
    mapOut: liveRow('acme-gateway-80', 'claude:6.0', ACME_GATEWAY, 'busy', 60),
  })
  const props = {
    title: 'Crew board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  } as const
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props })

  expect((await ui.find({ type: 'Text', text: /^acme-gateway-80 +D3 965 pass/ }))?.text.trimEnd()).toBe('acme-gateway-80  D3 965 pass ▸')
  expect(await ui.find({ type: 'Text', text: '⏎ claude:6.0' })).toBeDefined()
  await ui.press({ key: 'go-1014-1014-stats' })
  expect(calls.slice(2)).toEqual([SWITCH])

  await ui.press({ key: 'tab-projects' })
  expect((await ui.find({ type: 'Text', text: /busy  1m  claude:6$/ }))?.text).toBe('busy  1m  claude:6')
  await ui.press({ key: 'go-acme-gateway-80' })
  expect(calls.slice(2)).toEqual([SWITCH, SWITCH])
  await ui.unmount()
})

const PR_BOARD = 'NEEDS YOU\n  1014-a  review  3h  ship  acme-gateway  PR #36 open, waiting\n'
const META_A = {
  '/home/test/.claude/crew/1014-a/meta': 'shape=ship\nrepo=/home/user/Developer/acme-gateway\nbranch=user/a\nlead=acme-gateway-x\n',
}
const LIVE_X = liveRow('acme-gateway-x', 'claude:7.1', ACME_GATEWAY, 'busy', 120)
const MERGED = '{"mergedAt":"2026-10-15T10:00:00Z","number":36,"state":"MERGED","url":"https://x/36"}'
const OPEN = '{"mergedAt":null,"number":36,"state":"OPEN","url":"https://x/36"}'
const VIEW_36 = ['gh', 'pr', 'view', '36', '--json', 'number,state,mergedAt,closedAt,url']

const HELD_BOARD =
  'NEEDS YOU\n  1014-1014-stats  held  2h  ship  acme-gateway  verified 965 pass\n' +
  '  1014-1014-report  review  3h  ship  acme-gateway  ready\n' +
  ''
const HELD_LIVE = liveRow('acme-gateway-80', 'claude:6.0', ACME_GATEWAY, 'idle', 3600) + liveRow('acme-gateway-x', 'claude:7.1', ACME_GATEWAY, 'busy', 120)
const CREW = '/home/test/.claude/bin/crew'

test('at session start the pane is opened with a row budget, and a hint is set when it is not placed', async ($, on) => {
  const { statuses, opens } = await bootJump($, on, { inTmux: true, opened: { isPlaced: false, reason: 'too narrow' } })

  expect(opens).toEqual([{ id: 'hq-board', rows: 16 }])
  expect(statuses).toEqual(['Crew board hidden at this width — type /hq to show it'])
})

test('no hint when the pane is placed; /hq opens the pane again and clears an old hint', async ($, on) => {
  const placed = await bootJump($, on, { inTmux: true })
  expect(placed.statuses).toEqual([])

  await $.command.run({ command: 'hq', args: '', ...asked })

  expect(placed.opens).toEqual([
    { id: 'hq-board', rows: 16 },
    { id: 'hq-board', rows: 16 },
  ])
  expect(placed.statuses).toEqual([undefined])
})

test('the HQ role is added to the system prompt as a session section, short, naming both tools', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'You are Claude.', scope: 'shared' }] }))
  await bootJump($, on, { inTmux: true })

  const composed = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: [],
    tools: [],
    outputStyle: null,
    traits: [],
  })

  expect(composed.sections.map(sec => `${sec.id}:${sec.scope}`)).toEqual(['base:shared', 'hq-role:session'])
  const role = composed.sections[1]!.text
  expect(role.split('\n').length).toBeLessThanOrEqual(15)
  expect(role).toContain('From HQ (user): ')
  expect(role).toContain('hq_board')
  expect(role).toContain('hq_answer')
})

test('hq_board returns the open tasks, sessions with tmux targets and the lead per project as JSON', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: HELD_BOARD, mapOut: HELD_LIVE })

  const board = await $.tool.call({ tool: 'mcp__hq__hq_board' })

  expect(JSON.parse(board.result as string)).toEqual({
    tasks: [
      { id: '1014-1014-stats', name: 'stats', repo: 'acme-gateway', state: 'held', age: '2h', note: '965 pass', lead: 'acme-gateway-x', leadGuessed: true },
      { id: '1014-1014-report', name: 'report', repo: 'acme-gateway', state: 'review', age: '3h', note: 'ready', lead: 'acme-gateway-x', leadGuessed: true },
    ],
    sessions: [
      { name: 'acme-gateway-80', project: 'acme-gateway', state: 'idle', age: '1h', tmux: 'claude:6.0' },
      { name: 'acme-gateway-x', project: 'acme-gateway', state: 'busy', age: '2m', tmux: 'claude:7.1' },
    ],
    leads: { 'acme-gateway': 'acme-gateway-x' },
  })
})

test('hq_board gives a session its claude.ai link when Remote Control is on, and none otherwise', async ($, on) => {
  const withLink = ['acme-gateway-x', 'claude:7.1', 'w', ACME_GATEWAY, 'busy', 120, '', 'https://claude.ai/code/session_01ExampleOnly'].join('\t') + '\n'
  await bootJump($, on, { inTmux: true, crewOut: HELD_BOARD, mapOut: liveRow('acme-gateway-80', 'claude:6.0', ACME_GATEWAY, 'idle', 3600) + withLink })

  const board = JSON.parse(((await $.tool.call({ tool: 'mcp__hq__hq_board' })).result as string))

  expect(board.sessions).toEqual([
    { name: 'acme-gateway-80', project: 'acme-gateway', state: 'idle', age: '1h', tmux: 'claude:6.0' },
    { name: 'acme-gateway-x', project: 'acme-gateway', state: 'busy', age: '2m', tmux: 'claude:7.1', link: 'https://claude.ai/code/session_01ExampleOnly' },
  ])
})

test('the HQ role tells HQ to relay a lead\'s reply in three short lines with the session link and tmux target, not the whole report', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  await bootJump($, on, { inTmux: true })

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const role = composed.sections[0]!.text

  expect(role.split('\n').length).toBeLessThanOrEqual(15)
  expect(role).toContain('at most 3 short lines')
  expect(role).toContain('**Needs you:**')
  expect(role).toContain('Open: <link>')
  expect(role).toContain('tmux: claude:<window>')
  expect(role).toContain('Point to the full report path')
  expect(role).toContain('"→ sent to <session>: <gist>" with the same `Open: <link>`')
})

test('hq_answer runs `crew answer <id> <answer>` for a held task and names the lead to notify', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: HELD_BOARD, mapOut: HELD_LIVE })

  const answered = await $.tool.call({ tool: 'mcp__hq__hq_answer', id: '1014-1014-stats', answer: 'use postgres; not sqlite' })

  expect(calls.filter(argv => argv[1] === 'answer')).toEqual([[CREW, 'answer', '1014-1014-stats', 'use postgres; not sqlite']])
  expect(JSON.parse(answered.result as string)).toEqual({ ok: true, id: '1014-1014-stats', lead: 'acme-gateway-x', leadGuessed: true })
})

test('hq_answer refuses a task that is not held, an odd id and an empty answer, running nothing', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: HELD_BOARD, mapOut: HELD_LIVE })

  const notHeld = await $.tool.call({ tool: 'mcp__hq__hq_answer', id: '1014-1014-report', answer: 'yes' })
  const odd = await $.tool.call({ tool: 'mcp__hq__hq_answer', id: '../x', answer: 'yes' })
  const empty = await $.tool.call({ tool: 'mcp__hq__hq_answer', id: '1014-1014-stats', answer: '  ' })

  expect([notHeld.deny, odd.deny, empty.deny]).toEqual([
    'task 1014-1014-report is not held (state: review)',
    'no held task "../x"',
    'the answer is empty',
  ])
  expect(calls.filter(argv => argv[1] === 'answer')).toEqual([])
})

const NOW = Date.parse('2026-10-15T12:00:00Z')
const STATUS = (ts: string, state: string) => `2026-10-15T08:00:00Z\tqueued\tcreated\n${ts}\t${state}\tx\n`
const BRIEF_FILES = {
  '/home/test/.claude/crew/1014-a/status': STATUS('2026-10-15T11:30:00Z', 'review'),
  '/home/test/.claude/crew/1014-b/status': STATUS('2026-10-15T09:00:00Z', 'landed'),
}
const BRIEF_BOARD = 'NEEDS YOU\n  1014-a  review  30m  ship  acme-gateway  verified ok\nDONE\n  1014-b  landed  3h  ship  acme-gateway  x\n'

test('/hq brief covers the last 24h on the first run, then only what entered a state after the last brief', async ($, on) => {
  const { clock } = await bootJump($, on, { inTmux: true, crewOut: BRIEF_BOARD, files: BRIEF_FILES, now: NOW })

  const first = await $.command.run({ command: 'hq', args: 'brief', ...asked })
  expect(first.text).toBe('Last 24h:\n  landed or done: b (1)\n  needs you: a (review) — ok')

  await clock.advance(3600 * 1000)
  const second = await $.command.run({ command: 'hq', args: 'brief', ...asked })
  expect(second.text).toBe('Since your last look (1h ago):\n  nothing new\n  still waiting: a (review, 30m)')
})

test('/hq brief after a failed refresh returns the error and keeps the time of the last brief', async ($, on) => {
  const { clock, crew } = await bootJump($, on, { inTmux: true, crewOut: BRIEF_BOARD, files: BRIEF_FILES, now: NOW })
  await $.command.run({ command: 'hq', args: 'brief', ...asked })

  crew.exitCode = 1
  await clock.advance(3600 * 1000)
  const failed = await $.command.run({ command: 'hq', args: 'brief', ...asked })
  expect(failed.text).toBe('crew ls failed: Error: crew ls exited 1')

  crew.exitCode = 0
  await clock.advance(3600 * 1000)
  const later = await $.command.run({ command: 'hq', args: 'brief', ...asked })
  expect(later.text!.split('\n')[0]).toBe('Since your last look (2h ago):')
})

test('the lead comes from the full session list: a long cwd and a shared 20-character name prefix do not confuse it', async ($, on) => {
  const deep = '/home/user/Developer/oss/some/very/long/path/that/crew/cuts/at/forty/acme-gateway'
  await bootJump($, on, {
    inTmux: true,
    crewOut: 'NEEDS YOU\n  1014-1014-stats  held  2h  ship  acme-gateway  q\n',
    mapOut:
      liveRow('a-very-long-session-one', 'claude:9.0', '/home/user/Developer/other', 'busy', 10) +
      liveRow('a-very-long-session-two', 'claude:9.1', deep, 'busy', 20),
  })

  const answered = await $.tool.call({ tool: 'mcp__hq__hq_answer', id: '1014-1014-stats', answer: 'yes' })

  expect(JSON.parse(answered.result as string).lead).toBe('a-very-long-session-two')
})

test('a held task shows the first line of its hold.md in NEEDS YOU', async ($, on) => {
  await bootJump($, on, {
    inTmux: true,
    crewOut: 'NEEDS YOU\n  1014-stats  held  2h  ship  acme-gateway  waiting\n',
    files: { '/home/test/.claude/crew/1014-stats/hold.md': 'Which database?\nmore detail\n' },
  })
  const props = {
    title: 'Crew board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  } as const
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props })

  expect((await ui.find({ type: 'Text', text: /^acme-gateway-80 +held / }))?.text.trimEnd()).toBe('acme-gateway-80  held Which database? ▸')
  await ui.unmount()
})

test('gh is asked about the PR in the note, in the task repo; a merged one is toasted once', async ($, on) => {
  const { clock, ghCalls, toasts } = await bootJump($, on, { inTmux: true, crewOut: PR_BOARD, mapOut: LIVE_X, files: META_A, ghOut: MERGED })

  expect(ghCalls).toEqual([{ argv: VIEW_36, cwd: '/home/user/Developer/acme-gateway' }])
  expect(toasts).toEqual(['a merged on GitHub — not logged'])

  await clock.advance(15_000)
  expect(ghCalls.length).toBe(1)
  expect(toasts.length).toBe(1)
})

test('the answer is cached for five minutes, then asked again without a second toast', async ($, on) => {
  const { clock, ghCalls, toasts } = await bootJump($, on, { inTmux: true, crewOut: PR_BOARD, mapOut: LIVE_X, files: META_A, ghOut: MERGED })

  await clock.advance(4 * 60_000)
  expect(ghCalls.length).toBe(1)

  await clock.advance(90_000)
  expect(ghCalls.length).toBe(2)
  expect(toasts).toEqual(['a merged on GitHub — not logged'])
})

test('with no PR number in the note gh is asked by the meta branch', async ($, on) => {
  const { ghCalls } = await bootJump($, on, {
    inTmux: true,
    crewOut: 'NEEDS YOU\n  1014-a  review  3h  ship  acme-gateway  verified ok\n',
    mapOut: LIVE_X,
    files: META_A,
  })

  expect(ghCalls).toEqual([
    {
      argv: ['gh', 'pr', 'list', '--head', 'user/a', '--state', 'all', '--json', 'number,state,mergedAt,closedAt,url', '--limit', '1'],
      cwd: '/home/user/Developer/acme-gateway',
    },
  ])
})

test('a failing gh shows nothing, throws nothing, and is not asked again until the cache runs out', async ($, on) => {
  const { clock, ghCalls, toasts } = await bootJump($, on, { inTmux: true, crewOut: PR_BOARD, mapOut: LIVE_X, files: META_A, ghExit: 1 })

  expect(ghCalls.length).toBe(1)
  await clock.advance(15_000)
  expect(ghCalls.length).toBe(1)
  expect(toasts).toEqual([])

  const board = JSON.parse(((await $.tool.call({ tool: 'mcp__hq__hq_board' })).result as string))
  expect(board.tasks[0].pr).toBeUndefined()

  await clock.advance(5 * 60_000)
  expect(ghCalls.length).toBe(2)
})

test('at most three gh queries per poll, the review search among them: the rest wait for the next one', async ($, on) => {
  const five = [1, 2, 3, 4, 5]
  const { clock, ghCalls, searchCalls } = await bootJump($, on, {
    inTmux: true,
    crewOut: 'NEEDS YOU\n' + five.map(n => `  1014-t${n}  review  3h  ship  acme-gateway  PR #${n}\n`).join(''),
    mapOut: LIVE_X,
    files: Object.fromEntries(five.map(n => [`/home/test/.claude/crew/1014-t${n}/meta`, 'repo=/home/user/Developer/acme-gateway\n'])),
    ghOut: OPEN,
  })

  expect(ghCalls.map(c => c.argv[3])).toEqual(['1', '2'])
  expect(searchCalls.length).toBe(1)
  await clock.advance(15_000)
  expect(ghCalls.map(c => c.argv[3])).toEqual(['1', '2', '3', '4', '5'])
})

test('hq_board carries the PR and the exact lead of a task; a lead that is not live is a guess', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: PR_BOARD, mapOut: LIVE_X, files: META_A, ghOut: OPEN })

  const exact = JSON.parse((await $.tool.call({ tool: 'mcp__hq__hq_board' })).result as string).tasks[0]
  expect(exact).toEqual({
    id: '1014-a',
    name: 'a',
    repo: 'acme-gateway',
    state: 'review',
    age: '3h',
    note: 'PR #36 open, waiting',
    lead: 'acme-gateway-x',
    pr: { number: 36, state: 'OPEN' },
  })
})

test('a lead that is not live is guessed by project and marked so', async ($, on) => {
  await bootJump($, on, {
    inTmux: true,
    crewOut: PR_BOARD,
    mapOut: LIVE_X,
    files: { '/home/test/.claude/crew/1014-a/meta': 'repo=/home/user/Developer/acme-gateway\nlead=long-gone\n' },
  })

  const task = JSON.parse((await $.tool.call({ tool: 'mcp__hq__hq_board' })).result as string).tasks[0]

  expect([task.lead, task.leadGuessed]).toEqual(['acme-gateway-x', true])
})

test('a review task whose PR is merged on GitHub stops counting in /hq and the band line', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: PR_BOARD, mapOut: LIVE_X, files: META_A, ghOut: MERGED, now: NOW })
  await $.command.run({ command: 'hq', args: '', ...asked })
  await $.command.run({ command: 'hq', args: 'seen', ...asked })

  expect((await $.command.run({ command: 'hq', args: '', ...asked })).text).toBe('Crew board refreshed.')
})

test('/hq brief lists a task merged on GitHub but not logged', async ($, on) => {
  await bootJump($, on, {
    inTmux: true,
    crewOut: PR_BOARD,
    mapOut: LIVE_X,
    files: { ...META_A, '/home/test/.claude/crew/1014-a/status': STATUS('2026-10-15T11:30:00Z', 'review') },
    ghOut: MERGED,
    now: NOW,
  })

  const brief = await $.command.run({ command: 'hq', args: 'brief', ...asked })

  expect(brief.text).toBe('Last 24h:\n  needs you: a (review) — PR #36 open, waiting\n  merged on GitHub, not logged: a (PR #36)')
})

test('the HQ role tells HQ to ask when the lead is a guess and never to log landed itself', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  await bootJump($, on, { inTmux: true })

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const role = composed.sections[0]!.text

  expect(role.split('\n').length).toBeLessThanOrEqual(15)
  expect(role).toContain('leadGuessed')
  expect(role).toContain('log <id> landed')
  expect(role).toContain('You never log landed yourself')
})

test('a merged answer is dropped when the task moves to another PR, even if gh then fails', async ($, on) => {
  const { clock, crew, gh } = await bootJump($, on, { inTmux: true, crewOut: PR_BOARD, mapOut: LIVE_X, files: META_A, ghOut: MERGED })
  const pr = async () => JSON.parse((await $.tool.call({ tool: 'mcp__hq__hq_board' })).result as string).tasks[0].pr
  expect(await pr()).toEqual({ number: 36, state: 'MERGED' })

  crew.out = 'NEEDS YOU\n  1014-a  review  3h  ship  acme-gateway  PR #37 open\n'
  gh.exitCode = 1
  await clock.advance(15_000)

  expect(await pr()).toBeUndefined()
})

test('a merged answer is dropped when the task loses its PR reference', async ($, on) => {
  const files = { '/home/test/.claude/crew/1014-a/meta': 'repo=/home/user/Developer/acme-gateway\n' }
  const { clock, crew } = await bootJump($, on, { inTmux: true, crewOut: PR_BOARD, mapOut: LIVE_X, files, ghOut: MERGED })

  crew.out = 'NEEDS YOU\n  1014-a  review  3h  ship  acme-gateway  ready\n'
  await clock.advance(15_000)
  const task = JSON.parse((await $.tool.call({ tool: 'mcp__hq__hq_board' })).result as string).tasks[0]

  expect(task.pr).toBeUndefined()
})

const DECIDED_BOARD = 'NEEDS YOU\n  1014-a  review  3h  ship  acme-gateway  D3 · PR #36 open, waiting on merge go\n  1014-b  held  1h  ship  acme-gateway  D4 · tests need a decision\n'
const DECIDED_FILES = {
  '/home/test/.claude/crew/1014-a/ask.md': 'merge acme-gateway #36?\n',
  '/home/test/.claude/crew/1014-b/hold.md': 'Which DB?\n',
}
const paneProps = { title: 'Crew board', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

test('NEEDS YOU shows the decision id first, then the question from ask.md or hold.md', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: DECIDED_BOARD, mapOut: LIVE_X, files: DECIDED_FILES })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: paneProps })

  expect((await ui.find({ type: 'Text', text: /^acme-gateway-x +D3 / }))?.text.trimEnd()).toBe('acme-gateway-x  D3 merge acme-gateway #36?')
  expect((await ui.find({ type: 'Text', text: /^acme-gateway-x +D4 / }))?.text.trimEnd()).toBe('acme-gateway-x  D4 Which DB?')
  await ui.unmount()
})

test('hq_answer takes a decision id (any case): it runs `crew answer D3 ...` on a review task and names its lead', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: DECIDED_BOARD, mapOut: HELD_LIVE, files: DECIDED_FILES })

  const answered = await $.tool.call({ tool: 'mcp__hq__hq_answer', id: 'd3', answer: 'yes, merge' })

  expect(calls.filter(argv => argv[1] === 'answer')).toEqual([[CREW, 'answer', 'D3', 'yes, merge']])
  expect(JSON.parse(answered.result as string)).toEqual({ ok: true, id: '1014-a', decision: 'D3', lead: 'acme-gateway-x', leadGuessed: true })
})

test('hq_answer by D-id also answers a held task, and by task id answers a review task that has a decision', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: DECIDED_BOARD, mapOut: HELD_LIVE, files: DECIDED_FILES })

  const held = await $.tool.call({ tool: 'mcp__hq__hq_answer', id: 'D4', answer: 'postgres' })
  const byTask = await $.tool.call({ tool: 'mcp__hq__hq_answer', id: '1014-a', answer: 'go' })

  expect(calls.filter(argv => argv[1] === 'answer')).toEqual([
    [CREW, 'answer', 'D4', 'postgres'],
    [CREW, 'answer', '1014-a', 'go'],
  ])
  expect([JSON.parse(held.result as string).id, JSON.parse(byTask.result as string).decision]).toEqual(['1014-b', 'D3'])
})

test('hq_answer refuses a decision id that is not open, running nothing', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: DECIDED_BOARD, mapOut: HELD_LIVE, files: DECIDED_FILES })

  const gone = await $.tool.call({ tool: 'mcp__hq__hq_answer', id: 'D9', answer: 'yes' })

  expect(gone.deny).toBe('no open decision "D9"')
  expect(calls.filter(argv => argv[1] === 'answer')).toEqual([])
})

test('hq_board lists the decision id and question of a review task with an open decision', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: DECIDED_BOARD, mapOut: HELD_LIVE, files: DECIDED_FILES })

  const tasks = JSON.parse((await $.tool.call({ tool: 'mcp__hq__hq_board' })).result as string).tasks

  expect(tasks.map((t: { id: string; decision: string; question: string }) => [t.id, t.decision, t.question])).toEqual([
    ['1014-a', 'D3', 'merge acme-gateway #36?'],
    ['1014-b', 'D4', 'Which DB?'],
  ])
})

test('the HQ role tells HQ to answer a decision id through hq_answer and relay it to the lead', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  await bootJump($, on, { inTmux: true })

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const role = composed.sections[0]!.text

  expect(role.split('\n').length).toBeLessThanOrEqual(15)
  expect(role).toContain('"D3 yes"')
  expect(role).toContain('From HQ (user): <D-id or id> answered. Answer: <text>')
})

// --- the Focus view: NEEDS YOU / NOW / JUST FINISHED, and what waits on others ---

const FOCUS_BOARD = [
  'NEEDS YOU',
  '  1016-ask                     held        1h  ship  acme-gateway   D1 · blocked',
  '  1016-ready                   review      2h  ship  acme-gateway   verified 90 pass; branch x',
  'RUNNING',
  '  1016-busy                    running     5m  ship  user           sonnet implementer',
  'WAITING ON OTHERS',
  '  1016-stats                   waiting     3h  ship  acme-gateway   PR #35 open, waiting on Sam',
  '  1016-docs                    waiting     2h  ship  acme-gateway   after review',
  'DONE',
  '  1016-shipped                 done        2h  ship  acme-gateway   merged cleanly',
  '  1016-older                   done        3h  ship  user           all done',
  '',
].join('\n')
const narrow = { ...paneProps, bodyColumns: 60 } as const

const FOCUS_META = {
  '/home/test/.claude/crew/1016-ask/meta': 'repo=/home/user/Developer/acme-gateway\nlead=acme-gateway-x\n',
  '/home/test/.claude/crew/1016-ready/meta': 'repo=/home/user/Developer/acme-gateway\nlead=acme-gateway-x\n',
  '/home/test/.claude/crew/1016-stats/meta': 'repo=/home/user/Developer/acme-gateway\nlead=acme-gateway-x\n',
  '/home/test/.claude/crew/1016-shipped/meta': 'repo=/home/user/Developer/acme-gateway\nlead=acme-gateway-x\n',
  '/home/test/.claude/crew/1016-busy/meta': 'repo=/home/user/Developer\nlead=user-cb\n',
  '/home/test/.claude/crew/1016-older/meta': 'repo=/home/user\nlead=user-cb\n',
}
const FOCUS_LIVE = liveRow('acme-gateway-x', 'claude:7.1', ACME_GATEWAY, 'busy', 240) + liveRow('user-cb', '', '/home/user', 'idle', 600)

const paneTexts = async ($: Engine, props: typeof narrow | typeof paneProps = narrow) => {
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()

  return texts
}

test('the Focus view: a question with where to answer it, NOW with the open tasks inline, JUST FINISHED once per task, and no per-row Seen button', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: FOCUS_LIVE, files: FOCUS_META })

  expect(await paneTexts($)).toEqual([
    'Focus',
    ' · ',
    'Projects',
    ' · ',
    '＋ New lead',
    'NEEDS YOU (1)',
    '? ',
    `acme-gateway-x  ${'D1 blocked'.padEnd(26)}  `,
    '⏎ claude:7.1',
    'NOW',
    '  acme-gateway-x  ',
    '● working 4m  ',
    'ready verifying 2h',
    ' ✕',
    `  ${' '.repeat(30)}stats #35 waiting on Sam`,
    `  ${' '.repeat(30)}docs waiting after…`,
    '  user-cb         ',
    '○ idle 10m    ',
    'busy running 5m',
    'JUST FINISHED · 2 new'.padEnd(48),
    '[Seen all]',
    '● ',
    `shipped  ${'merged cleanly'.padEnd(29)}  `,
    '→ acme-gateway-x',
    '● ',
    `older    ${'all done'.padEnd(29)}  `,
    '→ user-cb       ',
  ])
})

test('a finished task is on the screen once: one row, no ✓ line under its session, no [Seen] button on it', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: FOCUS_LIVE, files: FOCUS_META })
  const texts = await paneTexts($)

  expect(texts.filter(t => t.startsWith('shipped'))).toHaveLength(1)
  expect(texts.filter(t => t.includes('[Seen]') || t.includes('seen?'))).toEqual([])
})

// --- the Needs-you block of a session's last reply, shown in NEEDS YOU as (chat) ---

const TRANSCRIPT = '/home/test/.claude/projects/-home-user-Developer-acme-gateway/s1.jsonl'
const CHAT_NOW = Date.parse('2026-10-16T14:00:00Z')
const jsonl = (...records: object[]) => records.map(r => JSON.stringify(r)).join('\n') + '\n'
const said = (text: string, timestamp: string) => ({ type: 'assistant', timestamp, message: { content: [{ type: 'text', text }] } })
const typed = (text: string) => ({ type: 'user', origin: { kind: 'human' }, message: { content: text } })
const NEEDS_REPLY = said('Deploy prepared.\n\n**Needs you:**\n- **PR #51:** review it\n- merge #49\n\n**Next:** the sweep', '2026-10-16T13:12:54.933Z')
const CHAT_MAP = ['acme-gateway-x', 'claude:7.1', 'w', ACME_GATEWAY, 'idle', 60, TRANSCRIPT].join('\t') + '\n'
const bootChat = ($: Engine, on: On, text: string, over: object = {}) =>
  bootJump($, on, { inTmux: true, crewOut: '', mapOut: CHAT_MAP, now: CHAT_NOW, tails: { [TRANSCRIPT]: { text, mtime: 1_760_000_000 } }, ...over })

test('the last reply of a live session ends with Needs you: the band has ONE line for the session, /hq and the line above the prompt count it once, and pressing it jumps to the session', async ($, on) => {
  const { calls } = await bootChat($, on, jsonl(typed('go'), NEEDS_REPLY))
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)

  expect(texts.filter(t => t.startsWith('NEEDS YOU') || t.startsWith('acme-gateway-x') || t.startsWith('⏎'))).toEqual([
    'NEEDS YOU (1)',
    `acme-gateway-x  ${'2 questions ▸'.padEnd(26)}  `,
    '⏎ claude:7.1',
  ])
  await ui.press({ key: 'go-chat-acme-gateway-x' })
  expect(calls.filter(argv => argv[0] === 'tmux')).toEqual([['tmux', 'switch-client', '-t', 'claude:7.1']])
  await ui.unmount()

  expect((await $.command.run({ command: 'hq', args: '', ...asked })).text).toBe('⚠ 1 need you · 1 sessions live')
})

// a reply two days before CHAT_NOW
const OLD_REPLY = said('Deploy prepared.\n\n**Needs you:**\n- **PR #51:** review it\n- merge #49\n', '2026-10-14T09:00:00.000Z')
const OLD_AT = Date.parse('2026-10-14T09:00:00.000Z')

test('questions over a day old are not a need: one dim "older questions" line, not counted, and Dismiss hides it until the session writes a newer reply', async ($, on) => {
  const { clock, tails } = await bootChat($, on, jsonl(OLD_REPLY))
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text.trimEnd())

  expect(await texts()).toContain('older questions: acme-gateway-x')
  expect((await texts()).filter(t => t.startsWith('NEEDS YOU'))).toEqual([])
  expect((await $.command.run({ command: 'hq', args: '', ...asked })).text).toBe('Crew board refreshed.')

  await ui.press({ key: 'dismiss-older' })
  expect(await texts()).not.toContain('older questions: acme-gateway-x')

  await clock.advance(15_000)
  expect(await texts()).not.toContain('older questions: acme-gateway-x')

  tails[TRANSCRIPT] = { text: jsonl(OLD_REPLY, said('**Needs you:** one more thing', '2026-10-16T14:05:00.000Z')), mtime: 1_760_000_100 }
  await clock.advance(15_000)
  expect(await texts()).toContain('NEEDS YOU (1)')
  await ui.unmount()
})

test('a reply more than 2 hours old says how old it is on its line', async ($, on) => {
  await bootChat($, on, jsonl(said('**Needs you:** pick a name', '2026-10-16T09:00:00.000Z')))
  const texts = await paneTexts($)

  expect(texts).toContain(`acme-gateway-x  ${'pick a name · 5h old'.padEnd(26)}  `)
})

test('once the user answers in the session the items are gone at the next poll', async ($, on) => {
  const { clock, tails } = await bootChat($, on, jsonl(NEEDS_REPLY))
  expect((await $.command.run({ command: 'hq', args: '', ...asked })).text).toBe('⚠ 1 need you · 1 sessions live')

  tails[TRANSCRIPT] = { text: jsonl(NEEDS_REPLY, typed('merge it')), mtime: 1_760_000_100 }
  await clock.advance(15_000)

  expect((await $.command.run({ command: 'hq', args: '', ...asked })).text).toBe('Crew board refreshed.')
})

test('a transcript that cannot be read draws nothing and is read again at the next poll; one that is unchanged is not', async ($, on) => {
  const { calls, clock, tails } = await bootChat($, on, jsonl(NEEDS_REPLY), { tails: { [TRANSCRIPT]: { text: '', mtime: 1, fail: true } } })
  const tails_ = () => calls.filter(argv => argv[0] === 'tail').length

  expect((await paneTexts($)).filter(t => t.startsWith('NEEDS YOU'))).toEqual([])
  const first = tails_()
  await clock.advance(15_000)
  expect(tails_()).toBeGreaterThan(first)

  tails[TRANSCRIPT] = { text: jsonl(NEEDS_REPLY), mtime: 5 }
  await clock.advance(15_000)
  const after = tails_()
  await clock.advance(15_000)
  expect(tails_()).toBe(after)
  expect((await paneTexts($)).filter(t => t.startsWith('NEEDS YOU'))).toEqual(['NEEDS YOU (1)'])
})

test('a failed wide read is not kept as "nothing found": the next poll reads again, until the transcript changes', async ($, on) => {
  // 300 KB of records that are neither a reply nor a prompt: the 256 KB read finds nothing, the 1 MB read fails
  const filler = JSON.stringify({ type: 'attachment', pad: 'x'.repeat(300_000) }) + '\n'
  const { calls, clock } = await bootChat($, on, filler, { tails: { [TRANSCRIPT]: { text: filler, mtime: 5, failBytes: '1048576' } } })
  const reads = () => calls.filter(argv => argv[0] === 'tail').map(argv => argv[2])
  await clock.advance(15_000)

  expect(reads().slice(0, 4)).toEqual(['262144', '1048576', '262144', '1048576'])
})

test('Dismiss of older questions survives Seen all, and persists in the store keyed by the reply', async ($, on) => {
  const store: Record<string, unknown> = {}
  const { clock } = await bootChat($, on, jsonl(OLD_REPLY), { store })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'dismiss-older' })
  await $.command.run({ command: 'hq', args: 'seen', ...asked })
  await clock.advance(15_000)

  expect((await ui.findAll({ type: 'Text' })).map(t => t.text.trimEnd())).not.toContain('older questions: acme-gateway-x')
  expect(store.chatSeen).toEqual({ 'chat:acme-gateway-x': OLD_AT })
  await ui.unmount()
})

test('a dismissal saved in the store hides the items after a restart', async ($, on) => {
  await bootChat($, on, jsonl(NEEDS_REPLY), { store: { chatSeen: { 'chat:acme-gateway-x': Date.parse('2026-10-16T13:12:54.933Z') } } })

  expect((await $.command.run({ command: 'hq', args: '', ...asked })).text).toBe('Crew board refreshed.')
})

test('a session whose transcript is gone or empty has no chat lines and the pane still says it is idle', async ($, on) => {
  await bootChat($, on, '', { tails: {} })
  const texts = await paneTexts($)

  expect(texts.filter(t => t.startsWith('NEEDS YOU'))).toEqual([])
  expect(texts.map(t => t.trimEnd())).toContain('All clear · 1 session idle')
})

test('without a question, review or PR to look at there is no NEEDS YOU band at all', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: 'RUNNING\n  1016-a  running  1m  ship  acme-gateway  x\n', mapOut: LIVE_X })
  const texts = await paneTexts($)

  expect(texts.filter(t => t.startsWith('NEEDS YOU'))).toEqual([])
  expect(texts.slice(5)).toEqual(['NOW', '  acme-gateway-x  ', '● working 2m  ', 'a running 1m', ' ✕'])
})

test('idle sessions, old or fresh, fold into one line; with nothing else to show it is "All clear"', async ($, on) => {
  const idles = liveRow('fresh', '', '/home/user/Developer/x', 'idle', 600) + liveRow('stale-a', '', '/home/user/Developer/y', 'idle', 100_000) + liveRow('stale-b', '', '/home/user/Developer/z', 'idle', 200_000)
  await bootJump($, on, { inTmux: true, crewOut: '', mapOut: idles })

  expect((await paneTexts($)).slice(5)).toEqual(['All clear · 3 sessions idle'])
})

test('with a session at work the idle ones are a dim "idle:" line after NOW, newest first', async ($, on) => {
  const idles = liveRow('fresh', '', '/home/user/Developer/x', 'idle', 600) + liveRow('stale-a', '', '/home/user/Developer/y', 'idle', 100_000) + liveRow('stale-b', '', '/home/user/Developer/z', 'idle', 200_000)
  await bootJump($, on, { inTmux: true, crewOut: '', mapOut: idles + liveRow('worker', '', '/home/user/Developer/w', 'busy', 30) })
  const texts = await paneTexts($)

  expect(texts.slice(5)).toContain('idle: fresh 10m · stale-a 1d · stale-b 2d')
  expect(texts.some(t => t.startsWith('All clear'))).toBe(false)
})

// the ● that marks a row of JUST FINISHED as not seen yet is the text before the row's own
const unseenRow = (texts: string[], name: string) => {
  const i = texts.findIndex(t => new RegExp(`^${name} {2}`).test(t))

  return i > 0 && texts[i - 1] === '● '
}

test('pressing [Seen all] clears the ● of every finished row, keeps the rows, and removes its own button', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: FOCUS_LIVE, files: FOCUS_META })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect([unseenRow(await texts(), 'shipped'), unseenRow(await texts(), 'older')]).toEqual([true, true])

  await ui.press({ key: 'seen-all' })

  expect([unseenRow(await texts(), 'shipped'), unseenRow(await texts(), 'older')]).toEqual([false, false])
  expect((await texts()).filter(t => t.startsWith('shipped') || t.startsWith('older'))).toHaveLength(2)
  expect(await texts()).toContain('JUST FINISHED')
  expect(await ui.find({ type: 'Text', text: '[Seen all]' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ready/ })).toBeDefined()
  await ui.unmount()
})

test('opening a finished row shows its result and marks only that one seen', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: FOCUS_LIVE, files: FOCUS_META })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)

  await ui.press({ key: 'result-1016-shipped' })
  expect(await texts()).toContain('← Back')
  await ui.press({ key: 'result-back' })

  expect([unseenRow(await texts(), 'shipped'), unseenRow(await texts(), 'older')]).toEqual([false, true])
  expect(await texts()).toContain('JUST FINISHED · 1 new'.padEnd(48))
  await ui.unmount()
})

const SHIPPED_META = { '/home/test/.claude/crew/1016-shipped/meta': 'repo=/home/user/Developer/acme-gateway\nlead=acme-gateway-x\n' }

test('/hq seen clears the ● of the finished rows', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: '' })
  expect(unseenRow(await paneTexts($), 'shipped')).toBe(true)

  const cleared = await $.command.run({ command: 'hq', args: 'seen', ...asked })
  const texts = await paneTexts($)

  expect(cleared.text).toBe('✓/✗ marks cleared')
  expect([unseenRow(texts, 'shipped'), unseenRow(texts, 'older')]).toEqual([false, false])
})

test('/hq show on a task clears its ● and no other', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: '' })

  await $.command.run({ command: 'hq', args: 'show 1016-shipped', ...asked })
  const texts = await paneTexts($)

  expect([unseenRow(texts, 'shipped'), unseenRow(texts, 'older')]).toEqual([false, true])
})

test('/hq go <task> jumps to the task lead and clears its ●', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: liveRow('acme-gateway-x', 'claude:7.1', ACME_GATEWAY, 'busy', 60), files: SHIPPED_META })

  const went = await $.command.run({ command: 'hq', args: 'go shipped', ...asked })

  expect(went.text).toBe('Jumped to acme-gateway-x (claude:7.1)')
  expect(calls.slice(2)).toEqual([['tmux', 'switch-client', '-t', 'claude:7.1']])
  expect(unseenRow(await paneTexts($), 'shipped')).toBe(false)
})

test('what was seen before a restart stays seen', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: '', store: { seen: { all: 1_000_000_000_000, ids: {} } } })
  const texts = await paneTexts($)

  expect([unseenRow(texts, 'shipped'), unseenRow(texts, 'older')]).toEqual([false, false])
  expect(texts).not.toContain('[Seen all]')
})

test('a waiting task whose PR was merged on GitHub is a JUST FINISHED row telling the lead to log it, instead of a waiting task; pressing it jumps to the lead', async ($, on) => {
  const board = 'WAITING ON OTHERS\n  1014-a  waiting  3h  ship  acme-gateway  PR #36 open, Sam merges\n'
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: board, mapOut: LIVE_X, files: META_A, ghOut: MERGED, now: NOW })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: paneProps })

  expect((await ui.find({ type: 'Text', text: /^a #36/ }))?.text.trimEnd()).toBe('a #36  #36 merged on GitHub — log landed?')
  expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeUndefined()

  await ui.press({ key: 'result-1014-a' })
  expect(calls.filter(argv => argv[0] === 'tmux')).toEqual([['tmux', 'switch-client', '-t', 'claude:7.1']])
  expect(await ui.find({ type: 'Text', text: /^● $/ })).toBeUndefined()
  await ui.unmount()
})

test('PRs whose review is asked of the user are asked for once, shown under NEEDS YOU, and counted in the band', async ($, on) => {
  const search = JSON.stringify([
    { number: 41, title: 'Add the stats page', repository: { name: 'acme-gateway', nameWithOwner: 'user/acme-gateway' }, url: 'https://github.com/user/acme-gateway/pull/41', updatedAt: new Date(NOW - 3_600_000).toISOString() },
  ])
  const { clock, searchCalls } = await bootJump($, on, { inTmux: true, crewOut: '', mapOut: '', searchOut: search, now: NOW })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  expect(searchCalls).toEqual([['gh', 'search', 'prs', '--review-requested=@me', '--state=open', '--json', 'number,title,repository,url,updatedAt']])
  expect((await ui.find({ type: 'Text', text: /^PR / }))?.text.trimEnd()).toBe('PR user/acme-gateway …  Add the stats page')
  expect(await ui.find({ type: 'Text', text: /^on GitHub/ })).toBeDefined()
  expect((await $.command.run({ command: 'hq', args: '', ...asked })).text).toBe('⚠ 1 need you')
  await ui.unmount()

  await clock.advance(4 * 60_000)
  expect(searchCalls.length).toBe(1)
  await clock.advance(90_000)
  expect(searchCalls.length).toBe(2)
})

test('a failing review search shows nothing and keeps what it knew', async ($, on) => {
  const { clock, gh } = await bootJump($, on, { inTmux: true, crewOut: '', mapOut: '', searchOut: '[{"number":41,"title":"t","repository":{"name":"r"},"url":"u","updatedAt":"2026-10-16T10:00:00Z"}]', now: NOW })
  gh.exitCode = 1
  await clock.advance(6 * 60_000)
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  expect((await ui.find({ type: 'Text', text: /^PR / }))?.text.trimEnd()).toBe('PR r #41  t')
  await ui.unmount()
})

test('the Projects view counts the same way: a question marks the card, finished work and waiting tasks are noted', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: '' })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'tab-projects' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)

  expect(texts).toContain('⏸ 2 waiting')
  expect(texts.slice(5, 7)).toEqual(['acme-gateway', '● '])
  await ui.unmount()
})

// --- fixes from the review ---

const DONE_LED = 'DONE\n  1015-old  done  3h  ship  user  all done\n'

test('a finished task says which session to follow up in, because its meta is read too', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: DONE_LED, mapOut: liveRow('user-cb', '', '/home/user', 'idle', 600), files: { '/home/test/.claude/crew/1015-old/meta': 'lead=user-cb\n' } })
  const texts = await paneTexts($)

  // user-cb led a task, so it is a live lead: a NOW row with its project, not a name in the idle line
  expect(texts.slice(5)).toEqual(['NOW', '  user-cb  ', '○ idle 10m  ', 'user', 'JUST FINISHED · 1 new'.padEnd(48), '[Seen all]', '● ', `old  ${'all done'.padEnd(40)}  `, '→ user-cb'])
})

test('/hq go on a finished task keeps its ● when there is nowhere to jump', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: liveRow('acme-gateway-x', '', ACME_GATEWAY, 'busy', 60), files: SHIPPED_META })

  const went = await $.command.run({ command: 'hq', args: 'go shipped', ...asked })

  expect(went.text).toBe('No tmux sessions known yet.')
  expect(unseenRow(await paneTexts($), 'shipped')).toBe(true)
})

test('/hq go on a finished task keeps its ● when tmux refuses the jump', async ($, on) => {
  await bootJump($, on, {
    inTmux: true,
    switchReply: { exitCode: 1, stderr: "can't find session: claude\n" },
    crewOut: FOCUS_BOARD,
    mapOut: liveRow('acme-gateway-x', 'claude:7.1', ACME_GATEWAY, 'busy', 60),
    files: SHIPPED_META,
  })

  const went = await $.command.run({ command: 'hq', args: 'go shipped', ...asked })

  expect(went.text).toBe("tmux: can't find session: claude")
  expect(unseenRow(await paneTexts($), 'shipped')).toBe(true)
})

// --- RESULTS (24h) ---

const RESULT_BOARD = [
  'NEEDS YOU',
  '  1016-broke                   failed      1h  ship  user           exit 1',
  'DONE',
  '  1016-shipped                 done        2h  ship  acme-gateway   merged cleanly',
  '  1016-older                   done        3h  ship  user           all done',
  '  1016-ancient                 done       30h  ship  user           too old',
  '',
].join('\n')
const CREW_DIR = '/home/test/.claude/crew'
const RESULT_FILES = {
  [`${CREW_DIR}/1016-shipped/summary.md`]: '**Shipped: the report site is live.**\nSecond line of the summary.\n',
  [`${CREW_DIR}/1016-older/report.md`]: '# Older report\nbody\n',
}
const resultTexts = (texts: string[]) => texts.filter(t => /^(broke|shipped|older) {2}/.test(t)).map(t => t.trimEnd())

test('JUST FINISHED lists tasks done or failed in the last day, newest first, with the verdict from summary.md, else report.md, else the note', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: RESULT_BOARD, mapOut: '', files: RESULT_FILES })
  const texts = await paneTexts($, paneProps)

  expect(texts.some(t => t.startsWith('JUST FINISHED · 3 new'))).toBe(true)
  expect(resultTexts(texts)).toEqual([
    `${'broke'.padEnd(7)}  exit 1`,
    'shipped  Shipped: the report site is live.',
    `${'older'.padEnd(7)}  Older report`,
  ])
})

test('a result stays in JUST FINISHED after it is marked seen', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: RESULT_BOARD, mapOut: '', files: RESULT_FILES })
  await $.command.run({ command: 'hq', args: 'seen', ...asked })
  const texts = await paneTexts($, paneProps)

  expect(unseenRow(texts, 'shipped')).toBe(false)
  expect(texts).toContain('JUST FINISHED')
  expect(resultTexts(texts)).toHaveLength(3)
})

test('there is no JUST FINISHED section when nothing finished in the last day', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: 'RUNNING\n  1016-busy  running  5m  ship  user  working\n', mapOut: '' })

  expect((await paneTexts($, paneProps)).some(t => t.startsWith('JUST FINISHED'))).toBe(false)
})

test('pressing a result shows its summary wrapped in the pane, and Back returns to the board', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: RESULT_BOARD, mapOut: '', files: RESULT_FILES })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: { ...paneProps, bodyColumns: 30 } })

  await ui.press({ key: 'result-1016-shipped' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)

  expect(texts).toEqual(
    expect.arrayContaining(['← Back', '✓ shipped · acme-gateway', 'Shipped: the report site is', 'live.', 'Second line of the summary.', 'crew show 1016-shipped']),
  )
  expect(texts.some(t => t.startsWith('JUST FINISHED'))).toBe(false)

  await ui.press({ key: 'result-back' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).some(t => t.startsWith('JUST FINISHED'))).toBe(true)
  await ui.unmount()
})

test('a result with no summary.md or report.md opens with its note and does not throw', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: RESULT_BOARD, mapOut: '', files: {} })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: paneProps })

  await ui.press({ key: 'result-1016-shipped' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)

  expect(texts).toEqual(expect.arrayContaining(['← Back', '✓ shipped · acme-gateway', 'merged cleanly']))
  await ui.unmount()
})

test('summary.md is read again only when its mtime changes', async ($, on) => {
  const { clock, files, mtimes, reads } = await bootJump($, on, { inTmux: true, crewOut: RESULT_BOARD, mapOut: '', files: { ...RESULT_FILES } })
  const path = `${CREW_DIR}/1016-shipped/summary.md`
  const count = () => reads.filter(r => r === path).length
  expect(count()).toBe(1)

  await clock.advance(15_000)
  expect(count()).toBe(1)

  files[path] = '**Changed.**\n'
  await clock.advance(15_000)
  expect(count()).toBe(1)

  mtimes[path] = 2
  await clock.advance(15_000)
  expect(count()).toBe(2)
  expect(resultTexts(await paneTexts($, paneProps))).toContain('shipped  Changed.')
})

test('an empty summary.md does not hide report.md: the row and the detail pane both fall back to it', async ($, on) => {
  const files = { [`${CREW_DIR}/1016-shipped/summary.md`]: '\n', [`${CREW_DIR}/1016-shipped/report.md`]: '# Report title\nreport body\n' }
  await bootJump($, on, { inTmux: true, crewOut: RESULT_BOARD, mapOut: '', files })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: paneProps })

  expect(resultTexts((await ui.findAll({ type: 'Text' })).map(t => t.text))).toContain('shipped  Report title')

  await ui.press({ key: 'result-1016-shipped' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(expect.arrayContaining(['# Report title', 'report body']))
  await ui.unmount()
})

// --- state left by an older version of the module must never throw while drawing ---

test('atoms of an older shape never throw while drawing: the pane, /hq and the line above the prompt carry on, and the next poll repairs the board', async ($, on) => {
  // what the atoms hold after a reload of the module, by key; empty until the board has been drawn once
  const old: Record<string, unknown> = {}
  on('state.get', (_$, e, next) => (e.key in old ? { value: { value: old[e.key], version: 1 } } : next(e)))
  const { clock } = await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: FOCUS_LIVE, files: FOCUS_META })
  Object.assign(old, { chats: [['an old item']], dismissed: ['x'], reviews: [], seen: 'seen', prs: [], holds: null, results: [], entered: 'x', last: 5, prToasted: {} })

  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text.trimEnd())
  expect(await texts()).toContain('NOW')

  const band = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 80 } })
  expect((await band.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['⚠ 1 need you · 1 running · 2 sessions live'])
  await band.unmount()

  await ui.unmount()

  old.board = { needsYou: [], running: [] }
  const loading = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })
  expect((await loading.findAll({ type: 'Text' })).map(t => t.text)).toContain('Loading the crew board...')
  expect(typeof (await $.command.run({ command: 'hq', args: '', ...asked })).text).toBe('string')
  await loading.unmount()

  delete old.board
  await clock.advance(15_000)
  const repaired = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })
  expect((await repaired.findAll({ type: 'Text' })).map(t => t.text.trimEnd())).toContain('NOW')
  await repaired.unmount()
})

test('the result page names the lead and jumps to it', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: FOCUS_BOARD, mapOut: FOCUS_LIVE, files: FOCUS_META })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'result-1016-shipped' })
  expect(await ui.find({ type: 'Text', text: '→ acme-gateway-x (claude:7.1)' })).toBeDefined()
  await ui.press({ key: 'result-go' })

  expect(calls.filter(argv => argv[0] === 'tmux')).toEqual([['tmux', 'switch-client', '-t', 'claude:7.1']])
  await ui.unmount()
})

// --- a NEEDS YOU line opened: the whole question, and the actions to take on it ---

const ASK_LONG =
  'Review fleet: not good to go. Start A fixes now as crew tasks (2 trim, 3 attempt/cost/time metrics, 4 carriage+denominator, A half of 1 pairs, 7 natural-runs regen) and draft a note to Sam for fixes 1/6/8?\n' +
  'The validation sweep waits for a separate go after fixes land.'
const ASK_BOARD = 'NEEDS YOU\n  1016-review-fleet  review  1h  scout acme-gateway  D1 · report verified; waiting on go for fix tasks\n'
const ASK_DIR = '/home/test/.claude/crew/1016-review-fleet'
const ASK_FILES = {
  [`${ASK_DIR}/meta`]: 'repo=/home/user/Developer/acme-gateway\nlead=acme-gateway-x\n',
  [`${ASK_DIR}/ask.md`]: ASK_LONG,
  [`${ASK_DIR}/status`]: '2026-10-16T11:00:00Z\trunning\tverifying\n2026-10-16T11:30:00Z\treview\treport verified; all 6 blockers settled\n',
  [`${ASK_DIR}/report.md`]: '# Review fleet\nNot good to go: the gate never ran on a natural loss.\n',
}
const wide = { ...paneProps, bodyColumns: 100 } as const
const lineTexts = async (ui: Awaited<ReturnType<Engine['ui']['mount']>>) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

test('opening a long question shows all of its text wrapped to the pane at width 60 and at 100, with where it is from and what to decide with', async ($, on) => {
  await bootJump($, on, { inTmux: true, crewOut: ASK_BOARD, mapOut: FOCUS_LIVE, files: ASK_FILES })

  for (const props of [narrow, wide]) {
    const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props })
    const row = (await lineTexts(ui)).find(t => t.startsWith('acme-gateway-x'))!
    expect(row.trimEnd().endsWith('▸')).toBe(true)

    await ui.press({ key: 'need-ask:1016-review-fleet' })
    const all = await lineTexts(ui)
    const texts = all.slice(all.indexOf('← Back'))
    const lines = texts.slice(texts.indexOf('lead acme-gateway-x · project acme-gateway') + 1, texts.indexOf('Latest note'))

    expect(texts.slice(0, 4)).toEqual(['← Back', '? D1 · review-fleet', 'task 1016-review-fleet · review 1h', 'lead acme-gateway-x · project acme-gateway'])
    // every word of both paragraphs is on screen, in order, and no line is wider than the pane's inside
    expect(lines.filter(l => l !== ' ').join(' ')).toBe(ASK_LONG.replace(/\s+/g, ' '))
    expect(Math.max(...lines.map(l => l.length))).toBeLessThanOrEqual(props.bodyColumns - 2)
    expect(lines.length).toBeGreaterThan(props === narrow ? 4 : 2)
    expect(texts.slice(texts.indexOf('Latest note'))).toEqual([
      'Latest note',
      '  report verified; all 6 blockers settled',
      'Report',
      '  # Review fleet',
      '  Not good to go: the gate never ran on a natural loss.',
      '⏎ acme-gateway-x (claude:7.1)',
      'crew show 1016-review-fleet',
    ])
    // the page stays open in the pane's state: leave it, so the next width starts at Focus
    await ui.press({ key: 'need-back' })
    await ui.unmount()
  }
})

test('answering a D-id on its page runs `crew answer D1 <text>` as argv, asks HQ to tell the lead, and returns to Focus', async ($, on) => {
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: ASK_BOARD, mapOut: FOCUS_LIVE, files: ASK_FILES })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'need-ask:1016-review-fleet' })
  await ui.input({ key: 'need-answer', text: 'yes; start A "now" $(rm -rf x)' })

  expect(calls.filter(argv => argv[1] === 'answer')).toEqual([[CREW, 'answer', 'D1', 'yes; start A "now" $(rm -rf x)']])
  expect(submitted).toEqual([
    'The user answered D1 in the HQ pane; crew answer has recorded it, so do not call hq_answer. SendMessage acme-gateway-x exactly:\nFrom HQ (user): D1 answered. Answer: yes; start A "now" $(rm -rf x)\nThen confirm in one line.',
  ])
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'NEEDS YOU (1)' })).toBeDefined()
  await ui.unmount()
})

test('an empty answer is refused with a toast: nothing is recorded, the page stays open', async ($, on) => {
  const { calls, toasts } = await bootJump($, on, { inTmux: true, crewOut: ASK_BOARD, mapOut: FOCUS_LIVE, files: ASK_FILES })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'need-ask:1016-review-fleet' })
  await ui.input({ key: 'need-answer', text: '   ' })

  expect(calls.filter(argv => argv[1] === 'answer')).toEqual([])
  expect(toasts).toEqual(['answer not recorded: the answer is empty'])
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeDefined()
  await ui.unmount()
})

test('Back returns to Focus, and Go on the page jumps to the lead', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: ASK_BOARD, mapOut: FOCUS_LIVE, files: ASK_FILES })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'need-ask:1016-review-fleet' })
  await ui.press({ key: 'need-go' })
  expect(calls.filter(argv => argv[0] === 'tmux')).toEqual([['tmux', 'switch-client', '-t', 'claude:7.1']])
  await ui.press({ key: 'need-back' })

  expect(await ui.find({ type: 'Text', text: 'NEEDS YOU (1)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeUndefined()
  await ui.unmount()
})

// The same task with a branch in its meta: its page offers Diff.
const DIFF_FILES = { ...ASK_FILES, [`${ASK_DIR}/meta`]: `${ASK_FILES[`${ASK_DIR}/meta`]}branch=crew/1016-review-fleet\nworktree=/home/user/Developer/acme-gateway/.claude/worktrees/crew-1016-review-fleet\n` }

test('Diff on a review task page runs `crew diff <id> --focus` as argv and toasts its one-line result; the page stays open', async ($, on) => {
  const { calls, toasts, crew } = await bootJump($, on, { inTmux: true, crewOut: ASK_BOARD, mapOut: FOCUS_LIVE, files: DIFF_FILES })
  crew.diff.out = 'diff: opened 1016-review-fleet (reused pane %7)\n'
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'need-ask:1016-review-fleet' })
  await ui.press({ key: 'need-diff' })

  expect(calls.filter(argv => argv[1] === 'diff')).toEqual([[CREW, 'diff', '1016-review-fleet', '--focus']])
  expect(toasts).toEqual(['diff: opened 1016-review-fleet (reused pane %7)'])
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeDefined()
  await ui.unmount()
})

test('a failing `crew diff` toasts its stderr, not a success line', async ($, on) => {
  const { toasts, crew } = await bootJump($, on, { inTmux: true, crewOut: ASK_BOARD, mapOut: FOCUS_LIVE, files: DIFF_FILES })
  crew.diff.exitCode = 4
  crew.diff.err = 'crew diff: diffview.nvim is not installed (restart nvim once)\n'
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'need-ask:1016-review-fleet' })
  await ui.press({ key: 'need-diff' })

  expect(toasts).toEqual(['diff failed: crew diff: diffview.nvim is not installed (restart nvim once)'])
  await ui.unmount()
})

async function reviewPage($: Engine, on: On, files: Record<string, string>) {
  await bootJump($, on, { inTmux: true, crewOut: ASK_BOARD, mapOut: FOCUS_LIVE, files })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })
  const row = (await lineTexts(ui)).find(t => t.startsWith('acme-gateway-x'))!
  await ui.press({ key: 'need-ask:1016-review-fleet' })

  return { ui, row, texts: await lineTexts(ui) }
}

test('the review page of a task whose meta has a branch and worktree shows Diff and its footer line, and its row still ends with the more-mark', async ($, on) => {
  const { ui, row, texts } = await reviewPage($, on, DIFF_FILES)

  expect(row.trimEnd().endsWith('▸')).toBe(true)
  expect(texts.slice(texts.indexOf('⏎ acme-gateway-x (claude:7.1)'))).toEqual(['⏎ acme-gateway-x (claude:7.1)', '  ', '[Diff]', 'crew show 1016-review-fleet', 'crew diff 1016-review-fleet --focus'])
  await ui.unmount()
})

test('the review page of a task without branch or worktree in its meta has no Diff and no footer line for it', async ($, on) => {
  const { ui, row, texts } = await reviewPage($, on, ASK_FILES)

  expect(row.trimEnd().endsWith('▸')).toBe(true)
  expect(texts).not.toContain('[Diff]')
  expect(texts.slice(-2)).toEqual(['⏎ acme-gateway-x (claude:7.1)', 'crew show 1016-review-fleet'])
  await ui.unmount()
})

test('a chat item opens with every item and Dismiss, no Answer; Dismiss hides it and returns to Focus', async ($, on) => {
  await bootChat($, on, jsonl(typed('go'), NEEDS_REPLY))
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'need-chat:acme-gateway-x' })
  const texts = await lineTexts(ui)

  expect(texts.slice(texts.indexOf('← Back'), texts.indexOf('[Dismiss]') + 1)).toEqual([
    '← Back',
    '? acme-gateway-x · in chat',
    expect.stringMatching(/^session acme-gateway-x · replied \d+m ago$/),
    '- PR #51: review it',
    '- merge #49',
    '⏎ acme-gateway-x (claude:7.1)',
    '  ',
    '[Dismiss]',
  ])
  expect(await ui.find({ key: 'need-answer' })).toBeUndefined()

  await ui.press({ key: 'need-dismiss' })

  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^NEEDS YOU/ })).toBeUndefined()
  await ui.unmount()
})

test('a review request opens with its URL and neither Answer nor Dismiss', async ($, on) => {
  const search = JSON.stringify([
    { number: 41, title: 'Add the stats page', repository: { name: 'acme-gateway', nameWithOwner: 'user/acme-gateway' }, url: 'https://github.com/user/acme-gateway/pull/41', updatedAt: new Date(NOW - 3_600_000).toISOString() },
  ])
  await bootJump($, on, { inTmux: true, crewOut: '', mapOut: '', searchOut: search, now: NOW })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'need-pr:user/acme-gateway#41' })
  const texts = await lineTexts(ui)

  expect(texts.slice(texts.indexOf('← Back'))).toEqual([
    '← Back',
    '? PR user/acme-gateway #41',
    'review requested · updated 1h ago',
    'Add the stats page',
  ])
  expect((await ui.find({ type: 'Link' }))?.props).toEqual({ href: 'https://github.com/user/acme-gateway/pull/41' })
  expect(await ui.find({ key: 'need-answer' })).toBeUndefined()
  await ui.unmount()
})

test('the one-line row keeps its tmux jump: pressing the target still switches the client, only the text opens the page', async ($, on) => {
  const { calls } = await bootJump($, on, { inTmux: true, crewOut: ASK_BOARD, mapOut: FOCUS_LIVE, files: ASK_FILES })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'go-1016-review-fleet' })

  expect(calls.filter(argv => argv[0] === 'tmux')).toEqual([['tmux', 'switch-client', '-t', 'claude:7.1']])
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeUndefined()
  await ui.unmount()
})

test('a question of 45 lines is paged on its page: Down reaches line 45, Up goes back, and Answer stays on the page throughout', async ($, on) => {
  const long = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n')
  await bootJump($, on, { inTmux: true, crewOut: ASK_BOARD, mapOut: FOCUS_LIVE, files: { ...ASK_FILES, [`${ASK_DIR}/ask.md`]: long } })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })
  const has = async (text: string) => (await lineTexts(ui)).includes(text)

  await ui.press({ key: 'need-ask:1016-review-fleet' })
  expect([await has('line 1'), await has('line 45'), await has('line 21')]).toEqual([true, false, false])
  expect(await ui.find({ key: 'need-up' })).toBeUndefined()
  expect(await ui.find({ key: 'need-answer' })).toBeDefined()

  for (let i = 0; i < 5 && !(await has('line 45')); i++) await ui.press({ key: 'need-down' })

  expect([await has('line 45'), await has('line 1')]).toEqual([true, false])
  expect(await ui.find({ key: 'need-down' })).toBeUndefined()
  expect(await ui.find({ key: 'need-answer' })).toBeDefined()

  for (let i = 0; i < 5 && (await ui.find({ key: 'need-up' })); i++) await ui.press({ key: 'need-up' })

  expect([await has('line 1'), await has('line 45')]).toEqual([true, false])
  await ui.press({ key: 'need-back' })
  await ui.unmount()
})

const NEW_LEAD_LIVE = liveRow('acme-gateway-x', 'claude:7.1', ACME_GATEWAY, 'busy', 240) + liveRow('user-cb', '', '/home/test', 'idle', 600)

test('New lead: pick a folder, fill the form, Start runs crew spawn --top as argv with the message untouched, toasts the window and closes the form', async ($, on) => {
  const { calls, toasts } = await bootJump($, on, {
    inTmux: true,
    mapOut: NEW_LEAD_LIVE,
    spawn: { exitCode: 0, stdout: 'id=1017-fix-login\nwindow=claude:fix-login\nchild=fix-login\n', stderr: '' },
  })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'new-lead' })
  // only the acme-gateway folder is offered: the home folder is not
  expect((await lineTexts(ui)).filter(t => t.startsWith('○') || t.startsWith('◉'))).toEqual([`○ ${ACME_GATEWAY}`])
  await ui.press({ key: 'new-repo-0' })
  await ui.input({ key: 'new-name', text: 'fix-login' })
  await ui.input({ key: 'new-text', text: 'Fix the "login" bug $(rm -rf x); it\'s `urgent`' })
  await ui.input({ key: 'new-model', text: 'sonnet' })
  expect((await lineTexts(ui)).filter(t => /^(repo|name|message|model)/.test(t))).toEqual([
    `repo    ${ACME_GATEWAY}`,
    'name    fix-login',
    'message Fix the "login" bug $(rm -rf x); it\'s `urgent`',
    'model   sonnet',
  ])
  await ui.press({ key: 'new-start' })

  expect(calls.filter(argv => argv[1] === 'spawn')).toEqual([[CREW, 'spawn', '--top', 'fix-login', '--repo', ACME_GATEWAY, '--model', 'sonnet', '--', 'Fix the "login" bug $(rm -rf x); it\'s `urgent`']])
  expect(toasts).toEqual(['fix-login started in claude:fix-login'])
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeUndefined()
  expect(await ui.find({ key: 'new-lead' })).toBeDefined()
  await ui.unmount()
})

test('New lead: a refusal from crew is toasted with its reason and the form stays open with what was typed', async ($, on) => {
  const { toasts } = await bootJump($, on, {
    inTmux: true,
    mapOut: NEW_LEAD_LIVE,
    spawn: { exitCode: 2, stdout: '', stderr: 'crew: spawn refused: 5 live top-level leads started with spawn --top (max 5). Close one first.\n' },
  })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'new-lead' })
  await ui.input({ key: 'new-repo', text: '~/Developer/app' })
  await ui.input({ key: 'new-name', text: 'sixth' })
  await ui.input({ key: 'new-text', text: 'go' })
  await ui.press({ key: 'new-start' })

  expect(toasts).toEqual(['not started: spawn refused: 5 live top-level leads started with spawn --top (max 5). Close one first.'])
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'name    sixth' })).toBeDefined()
  await ui.unmount()
})

test('New lead: a bad name never reaches crew; Back leaves the form', async ($, on) => {
  const { calls, toasts } = await bootJump($, on, { inTmux: true, mapOut: NEW_LEAD_LIVE })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'new-lead' })
  await ui.press({ key: 'new-repo-0' })
  await ui.input({ key: 'new-name', text: 'Fix Login' })
  await ui.input({ key: 'new-text', text: 'go' })
  await ui.press({ key: 'new-start' })

  expect(calls.filter(argv => argv[1] === 'spawn')).toEqual([])
  expect(toasts).toEqual(['not started: name: 2-41 lowercase letters, digits, dashes'])
  await ui.press({ key: 'new-back' })
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeUndefined()
  expect(await ui.find({ key: 'new-lead' })).toBeDefined()
  await ui.unmount()
})

const OWNER_FILES = (lead: string) => ({
  '/home/test/.claude/crew/.owners/billing/owner': `feature=billing\nrepo=/r\npath=src/**\nlead=${lead}\nstate=asleep\nslept_at=2026-10-16T09:00:00Z\n`,
  '/home/test/.claude/crew/.owners/billing/notes.md': '# Billing\nRetry owns ids.\n',
  '/home/test/.claude/crew/.owners/search/owner': `feature=search\nrepo=/r\npath=x/\nlead=${lead}\nstate=awake\n`,
  '/home/test/.claude/crew/.owners/.removed/old.1/owner': `feature=old\nlead=${lead}\nstate=asleep\n`,
  '/home/test/.claude/crew/.talk/billing--search--ids/meta': `a=billing\nb=search\ntopic=invoice ids\nlead=${lead}\ncap=6\nturns=2\nstate=open\n`,
  '/home/test/.claude/crew/.talk/auth--billing--tok/meta': `a=auth\nb=billing\ntopic=tok\nlead=${lead}\ncap=6\nturns=6\nstate=closed\n`,
})

test('Focus shows an asleep owner and an open talk thread under the lead\'s card; Wake runs crew wake as argv with CREW_AS_USER=1 and toasts the outcome', async ($, on) => {
  const { calls, wakeEnvs, toasts } = await bootJump($, on, {
    inTmux: true,
    mapOut: liveRow('acme-gateway-80', 'claude:6.0', ACME_GATEWAY, 'idle', 3600),
    now: Date.parse('2026-10-16T12:00:00Z'),
    files: OWNER_FILES('acme-gateway-80'),
    wake: { exitCode: 0, stdout: 'woke billing in claude:billing (task 1017-wake-billing)\n', stderr: '' },
  })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)

  expect((await texts()).filter(t => /billing|talk:/.test(t))).toEqual(['  ☾ billing · asleep 3h · Retry owns ids.', '  talk: billing↔search "invoice ids" (2/6)'])
  await ui.press({ key: 'wake-billing' })
  await ui.input({ key: 'wake-text', text: '--now do $(x) #{pane_id}' })

  expect(calls.filter(argv => argv[1] === 'wake')).toEqual([[CREW, 'wake', 'billing', '--', '--now do $(x) #{pane_id}']])
  expect(wakeEnvs).toEqual([{ CREW_AS_USER: '1' }])
  expect(toasts).toEqual(['woke billing in claude:billing (task 1017-wake-billing)'])
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeUndefined()
  await ui.unmount()
})

test('Close on a session row runs crew close <name> as argv with CREW_AS_USER=1 and toasts the outcome; a refusal is toasted as it is', async ($, on) => {
  const { calls, closeEnvs, toasts } = await bootJump($, on, {
    inTmux: true,
    mapOut: liveRow('acme-gateway-80', 'claude:6.0', ACME_GATEWAY, 'idle', 3600),
    now: Date.parse('2026-10-16T12:00:00Z'),
    files: OWNER_FILES('acme-gateway-80'),
    close: { exitCode: 0, stdout: 'closed: acme-gateway-80, window claude:acme-gateway-80 (@6)\n', stderr: '' },
  })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'close-acme-gateway-80' })

  expect(calls.filter(argv => argv[1] === 'close')).toEqual([[CREW, 'close', 'acme-gateway-80']])
  expect(closeEnvs).toEqual([{ CREW_AS_USER: '1' }])
  expect(toasts).toEqual(['closed: acme-gateway-80, window claude:acme-gateway-80 (@6)'])
  await ui.unmount()
})

test('Close: a refusal of crew is toasted with its reason', async ($, on) => {
  const { toasts } = await bootJump($, on, {
    inTmux: true,
    mapOut: liveRow('acme-gateway-80', 'claude:6.0', ACME_GATEWAY, 'idle', 3600),
    now: Date.parse('2026-10-16T12:00:00Z'),
    files: OWNER_FILES('acme-gateway-80'),
    close: { exitCode: 3, stdout: '', stderr: 'crew: refused: acme-gateway-80 is busy (mid-turn): try again when it is idle\n' },
  })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  await ui.press({ key: 'close-acme-gateway-80' })

  expect(toasts).toEqual(['not closed: refused: acme-gateway-80 is busy (mid-turn): try again when it is idle'])
  await ui.unmount()
})

test('Wake: empty text never reaches crew, and a refusal is toasted with the form left open', async ($, on) => {
  const { calls, toasts } = await bootJump($, on, {
    inTmux: true,
    mapOut: liveRow('gone-lead-not-live', 'claude:6.0', ACME_GATEWAY, 'idle', 3600),
    now: Date.parse('2026-10-16T12:00:00Z'),
    files: OWNER_FILES('gone-lead'),
    wake: { exitCode: 3, stdout: '', stderr: 'crew: refused: billing is awake\n' },
  })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq-board', props: narrow })

  // the owner's lead is not live: its rows go with "other crew"
  expect((await lineTexts(ui)).some(t => t.includes('other crew'))).toBe(true)
  await ui.press({ key: 'wake-billing' })
  await ui.input({ key: 'wake-text', text: '   ' })
  expect(calls.filter(argv => argv[1] === 'wake')).toEqual([])
  await ui.input({ key: 'wake-text', text: 'go' })

  expect(toasts).toEqual(['not woken: the message is empty', 'not woken: refused: billing is awake'])
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeDefined()
  await ui.press({ key: 'wake-back' })
  expect(await ui.find({ type: 'Text', text: '← Back' })).toBeUndefined()
  await ui.unmount()
})
