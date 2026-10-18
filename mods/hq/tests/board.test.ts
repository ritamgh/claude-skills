import { describe, expect, test } from 'claude-code/testing'

import {
  applyMeta,
  asList,
  asRecord,
  canDiff,
  cols,
  cutCols,
  diffArgs,
  diffFeedback,
  needFooter,
  padCols,
  clearText,
  cutWords,
  finishedParts,
  idleText,
  markLeads,
  needDetail,
  needParts,
  nowParts,
  parseLink,
  parseStatusNote,
  relayPrompt,
  olderText,
  parseStatusLastTs,
  recentResults,
  resultVerdict,
  splitChats,
  chatNeeds,
  parseLastReply,
  parseNeeds,
  parseStat,
  chatsDue,
  dismissChat,
  parseDismissed,
  pruneDismissed,
  emptyBoard,
  knownRepos,
  spawnArgv,
  spawnOutcome,
  lastNote,
  ownerRows,
  parseOwner,
  parseTalk,
  talkRows,
  closeArgv,
  closeOutcome,
  wakeArgv,
  wakeOutcome,
  focusLayout,
  needCount,
  boardForModel,
  briefText,
  classify,
  emptySeen,
  findJump,
  findTask,
  fit,
  fmtAge,
  ghArgs,
  ghDue,
  holdLine,
  isTarget,
  jumpChoices,
  jumpFor,
  markSeen,
  mergeLive,
  mergedNotLogged,
  newlyEntered,
  parseBoard,
  parseLive,
  parseMeta,
  parsePr,
  parseReviewPrs,
  parseSeen,
  parseStatusTs,
  pickLead,
  prFor,
  prKey,
  prRef,
  prTasks,
  prunePrs,
  projectCards,
  projectsFooter,
  plainLine,
  quietLine,
  repoJump,
  resultBody,
  resultItems,
  wrapText,
  resolveLead,
  reviewDue,
  sessionProject,
  shortName,
  shortNote,
  showTarget,
  splitRow,
  stripMarks,
  summarize,
  summaryCounts,
  taskDot,
} from '../hooks/board'

// One line of bin/tmux-map: name, tmux target, window, full cwd, status, seconds since its last update.
const live = (name: string, target: string, cwd: string, status: string, seconds: number, window = '') =>
  [name, target, window, cwd, status, seconds].join('\t')
const withLive = (crew: string, ...rows: string[]) => mergeLive(parseBoard(crew), parseLive(rows.join('\n')))

// Literal output of `crew ls`, as the script prints it (see ~/.claude/bin/crew).
const SAMPLE = [
  'NEEDS YOU',
  '  1014-1014-report-site        review      2h  ship  acme-gateway   verified 973 pass; branch user/report-site 2ce74e9',
  '  1013-flaky                   failed     12m  ship  -              exit 1',
  'RUNNING',
  '  1015-hq-mod                  running     0m  ship  user           sonnet implementer, in place',
  'RUNNING ELSEWHERE',
  '  claude acme-gateway-9e      busy      2m  ~',
  '  proc   pid 4242             run       5m  jcode run --task x',
  '  +3 more',
  'PARKED',
  '  P2   10-15  user         beta-explore-c1 claude (pid 1225647) is Ctrl-Z\'d',
  '  +4 more',
  'DONE',
  '  1012-old-thing               done        3h  ship  acme-gateway   landed on master',
  '',
].join('\n')

describe('parseBoard', () => {
  test('splits the sections of crew ls into typed rows; claude sessions come from tmux-map, not from here', () => {
    const board = parseBoard(SAMPLE)

    expect(board.needsYou).toEqual([
      {
        id: '1014-1014-report-site',
        state: 'review',
        age: '2h',
        repo: 'acme-gateway',
        note: 'verified 973 pass; branch user/report-site 2ce74e9',
      },
      { id: '1013-flaky', state: 'failed', age: '12m', repo: '-', note: 'exit 1' },
    ])
    expect(board.running).toEqual([
      {
        id: '1015-hq-mod',
        state: 'running',
        age: '0m',
        repo: 'user',
        note: 'sonnet implementer, in place',
      },
    ])
    expect(board.done).toEqual([
      { id: '1012-old-thing', state: 'done', age: '3h', repo: 'acme-gateway', note: 'landed on master' },
    ])
    expect(board.elsewhere).toEqual([
      { kind: 'proc', name: 'pid 4242', state: 'run', age: '5m', seconds: 300, where: 'jcode run --task x', target: '', window: '' },
    ])
    expect(board.parked).toEqual([
      { pri: 'P2', date: '10-15', repo: 'user', text: "beta-explore-c1 claude (pid 1225647) is Ctrl-Z'd" },
    ])
    expect(board.parkedMore).toBe(4)
  })

  test('reads the "+N more" overflow line of PARKED as a count, not a row', () => {
    const board = parseBoard('PARKED\n  P3   10-15  user         a note\n  +4 more\n')

    expect(board.parked.length).toBe(1)
    expect(board.parkedMore).toBe(4)
  })

  test('empty output is an empty board', () => {
    expect(parseBoard('')).toEqual({ needsYou: [], running: [], waiting: [], done: [], elsewhere: [], parked: [], parkedMore: 0 })
  })
})

describe('parseLive and mergeLive', () => {
  const TEXT = [
    live('acme-gateway-9e', 'claude:2.0', '/home/user/Developer/acme-gateway', 'busy', 120, 'crew skill'),
    live('acme-gateway-80', '', '/home/user/Developer/acme-gateway', 'idle', 3600),
    'broken line without tabs',
    '',
  ].join('\n')

  test('parseLive reads the six fields; a session outside tmux has an empty target and window', () => {
    expect(parseLive(TEXT)).toEqual([
      { name: 'acme-gateway-9e', target: 'claude:2.0', window: 'crew skill', cwd: '/home/user/Developer/acme-gateway', state: 'busy', seconds: 120, transcript: '', link: '' },
      { name: 'acme-gateway-80', target: '', window: '', cwd: '/home/user/Developer/acme-gateway', state: 'idle', seconds: 3600, transcript: '', link: '' },
    ])
  })

  test('the seventh field is the transcript path; a path that could confuse stat or tail is dropped', () => {
    const row = (path: string) => ['s', 'claude:1.0', 'w', '/x/p', 'busy', 5, path].join('\t')
    const good = '/home/user/.claude/projects/-home-user-Developer-acme-gateway/4ebcb6b8-e29b-415e-b3eb-9e7e71b4e5cb.jsonl'

    expect(parseLive(row(good))[0]!.transcript).toBe(good)
    expect(['', 'relative/x.jsonl', '/home/a/../b.jsonl', '/home/a/x y.jsonl', '/home/a/x.txt', '/home/a/-x;rm.jsonl'].map(p => parseLive(row(p))[0]!.transcript)).toEqual(['', '', '', '', '', ''])
    expect(mergeLive(parseBoard(''), parseLive(row(good))).elsewhere[0]!.transcript).toBe(good)
  })

  test('the eighth field is the claude.ai link of the session; anything but a plain claude.ai/code URL is dropped', () => {
    const row = (link: string) => ['s', 'claude:1.0', 'w', '/x/p', 'busy', 5, '', link].join('\t')
    const good = 'https://claude.ai/code/session_01ExampleOnly'

    expect(parseLive(row(good))[0]!.link).toBe(good)
    expect(['', 'http://claude.ai/code/session_01Cx', 'https://evil.example/code/session_01Cx', 'https://claude.ai/code/', 'https://claude.ai/code/a b', 'https://claude.ai/code/a;rm'].map(l => parseLive(row(l))[0]!.link)).toEqual(['', '', '', '', '', ''])
    expect(parseLive(live('old', 'claude:1.0', '/x/p', 'busy', 5))[0]!.link).toBe('')
    expect(mergeLive(parseBoard(''), parseLive(row(good))).elsewhere[0]!.link).toBe(good)
    expect('link' in mergeLive(parseBoard(''), parseLive(row(''))).elsewhere[0]!).toBe(false)
  })

  test('mergeLive turns them into session rows with a display age, leaves crew procs, and drops hq sessions', () => {
    const board = withLive(SAMPLE, TEXT, live('hq', 'claude:6.0', '/home/user', 'busy', 0))

    expect(board.elsewhere.map(s => `${s.kind}:${s.name}:${s.state}:${s.age}:${s.seconds}:${s.target}`)).toEqual([
      'proc:pid 4242:run:5m:300:',
      'claude:acme-gateway-9e:busy:2m:120:claude:2.0',
      'claude:acme-gateway-80:idle:1h:3600:',
    ])
    expect(board.elsewhere[1]!.where).toBe('/home/user/Developer/acme-gateway')
  })

  test('fmtAge uses the largest unit that fits', () => {
    expect([fmtAge(45), fmtAge(120), fmtAge(7200), fmtAge(200000)]).toEqual(['45s', '2m', '2h', '2d'])
  })
})

describe('newlyEntered', () => {
  const task = (id: string, state: string) => ({ id, state, age: '1m', repo: '-', note: '' })
  const boardOf = (needsYou: ReturnType<typeof task>[], running: ReturnType<typeof task>[] = [], done: ReturnType<typeof task>[] = []) => ({
    ...parseBoard(''),
    needsYou,
    running,
    done,
  })

  test('says nothing on the very first poll', () => {
    expect(newlyEntered(null, boardOf([task('a', 'review')], [], [task('b', 'done')]))).toEqual([])
  })

  test('reports a task that moved from running to review', () => {
    const prev = boardOf([], [task('a', 'running')])
    const next = boardOf([task('a', 'review')])

    expect(newlyEntered(prev, next)).toEqual(['a → review'])
  })

  test('does not repeat a state the task was already in', () => {
    const board = boardOf([task('a', 'review')], [], [task('b', 'done')])

    expect(newlyEntered(board, board)).toEqual([])
  })

  test('ignores states that are not worth a toast', () => {
    const prev = boardOf([], [task('a', 'queued')])
    const next = boardOf([], [task('a', 'running')])

    expect(newlyEntered(prev, next)).toEqual([])
  })

  test('reports a task first seen already in a toast state, and each change of state', () => {
    const prev = boardOf([task('a', 'held')], [task('c', 'running')])
    const next = boardOf([task('a', 'failed'), task('d', 'review')], [], [task('c', 'landed')])

    expect(newlyEntered(prev, next)).toEqual(['a → failed', 'd → review', 'c → landed'])
  })
})

describe('summarize', () => {
  test('counts what needs you, what runs and the live sessions, hq itself left out', () => {
    const board = withLive(SAMPLE, live('a', '', '/x/p', 'busy', 5), live('b', '', '/x/q', 'idle', 9), live('hq', '', '/home/user', 'busy', 0))

    expect(summarize(board)).toBe('1 running · 2 sessions live')
    expect(summarize({ ...board, needsYou: [...board.needsYou, { id: '1-q', state: 'review', age: '1m', repo: '-', note: 'merge?', decision: 'D3' }] })).toBe(
      '⚠ 1 need you · 1 running · 2 sessions live',
    )
  })

  test('a held task and a task in review that has an open decision need you; a task in review without one (the lead is still verifying) and a failed task without a question do not', () => {
    const task = (state: string, decision?: string) => ({ id: `1-${state}`, state, age: '1m', repo: '-', note: '', ...(decision ? { decision } : {}) })
    const board = { ...parseBoard(''), needsYou: [task('held'), task('review'), task('failed'), task('review', 'D2')] }

    expect(summarize(board)).toBe('⚠ 2 need you')
    expect(needCount(board, 2)).toBe(4)
  })

  test('a task in review without an open decision counts for nothing, whatever its PR says', () => {
    const board = applyMeta(parseBoard('NEEDS YOU\n  1-r  review  3h  ship  acme-gateway  ready\n'), { '1-r': { repoPath: '/r', branch: 'b' } })

    expect(needCount(board)).toBe(0)
    expect(summarize(board)).toBe(null)
  })

  test('PRs whose review is asked of the user count too', () => {
    expect(summarize(parseBoard(''), 2)).toBe('⚠ 2 need you')
    expect(summarize(parseBoard('RUNNING\n  1-a   running  1m  ship  user  x\n'), 1)).toBe('⚠ 1 need you · 1 running')
  })

  test('leaves out a part that is zero', () => {
    const board = withLive('RUNNING\n  1-a   running  1m  ship  user  x\n', live('hq', '', '/home/user', 'busy', 0))

    expect(summarize(board)).toBe('1 running')
  })

  test('is null when nothing needs you and nothing runs, whatever the sessions', () => {
    expect(summarize(withLive('', live('a', '', '/x/p', 'busy', 5)))).toBe(null)
  })
})

describe('fit', () => {
  test('cuts a long line to the width and marks the cut', () => {
    expect(fit('abcdefghij', 6)).toBe('abcde…')
    expect(fit('abc', 6)).toBe('abc')
    expect(fit('abc', 0)).toBe('')
  })
})

describe('names and notes', () => {
  test('shortName strips the repeated date prefixes of a task id', () => {
    expect(shortName('1014-1014-stats')).toBe('stats')
    expect(shortName('1015-hq-mod')).toBe('hq-mod')
    expect(shortName('plain')).toBe('plain')
    expect(shortName('1014-2020')).toBe('2020')
    expect(shortName('1014-')).toBe('1014-')
  })

  test('shortNote keeps the first clause and drops a leading "verified"', () => {
    expect(shortNote('verified 965 pass; branch user/stats 64ce4b4')).toBe('965 pass')
    expect(shortNote('lead verified: 12 checks; rest')).toBe('12 checks')
    expect(shortNote('exit 1')).toBe('exit 1')
    expect(shortNote('')).toBe('')
  })

  test('sessionProject names a session by the last part of its full cwd', () => {
    expect(sessionProject('/home/user/Developer/acme-gateway')).toBe('acme-gateway')
    expect(sessionProject('/home/user')).toBe('user')
    expect(sessionProject('/home/user/Developer/oss/aegra/')).toBe('aegra')
    expect(sessionProject('?')).toBe('other')
    expect(sessionProject('')).toBe('other')
  })

  test('taskDot colors the states that need you and ticks the finished ones', () => {
    expect([taskDot('review'), taskDot('held'), taskDot('failed'), taskDot('running'), taskDot('done'), taskDot('landed')]).toEqual([
      { glyph: '●', color: 'yellow' },
      { glyph: '●', color: 'magenta' },
      { glyph: '●', color: 'red' },
      { glyph: '●', color: 'cyan' },
      { glyph: '✓', color: 'green' },
      { glyph: '✓', color: 'green' },
    ])
  })

  test('splitRow pads the left part so the right part ends exactly at the width', () => {
    expect(splitRow('stats', 'review  3h', 24)).toEqual(['stats' + ' '.repeat(9), 'review  3h'])
    expect(splitRow('a-very-long-task-name', 'review  3h', 20)).toEqual(['a-very-l… ', 'review  3h'])
  })
})

const BOARD = [
  'NEEDS YOU',
  '  1014-1014-stats              review      3h  ship  acme-gateway   verified 965 pass; branch user/stats 64ce4b4',
  '  1014-1014-report-site        held        2h  ship  acme-gateway   lead verified: waiting on key',
  '  1016-odd                     failed      1h  scout -              boom',
  'RUNNING',
  '  1015-hq-mod                  running     0m  ship  user           sonnet implementer',
  'RUNNING ELSEWHERE',
  '  proc   pid 4242             run       5m  jcode run',
  'PARKED',
  '  P2   10-15  user         a note',
  '  +1 more',
  'DONE',
  '  1012-a                       done        3h  ship  acme-gateway   landed',
  '  1011-b                       landed     23h  ship  acme-gateway   landed',
  '  1010-c                       landed     30h  ship  acme-gateway   old',
  '  1009-d                       done        5h  scout -              scouted',
  '',
].join('\n')
const BOARD_LIVE = [
  live('acme-gateway-9e', 'claude:2.0', '/home/user/Developer/acme-gateway', 'busy', 120),
  live('acme-gateway-80', 'claude:3.0', '/home/user/Developer/acme-gateway', 'idle', 3600),
  live('user-cb', 'claude:2.1', '/home/user', 'busy', 0),
  live('hq', 'claude:6.0', '/home/user', 'busy', 0),
  live('dev', '', '/home/user/Developer', 'idle', 10800),
]

describe('summaryCounts', () => {
  test('counts busy claude sessions and procs as busy, the other sessions as idle', () => {
    expect(summaryCounts(withLive(BOARD, ...BOARD_LIVE))).toEqual({ busy: 3, idle: 2, doneToday: 3, parked: 2 })
  })

  test('done today stops at 24 hours and parked includes the overflow', () => {
    const board = parseBoard('DONE\n  1-a done 23h ship user x\n  1-b done 24h ship user x\n  1-c done 2d ship user x\n')

    expect(summaryCounts(board).doneToday).toBe(1)
  })
})

const NOW0 = Date.parse('2026-10-16T12:00:00Z')
const focusOf = (board: ReturnType<typeof parseBoard>, over: Partial<Parameters<typeof classify>[1]> = {}) =>
  classify(board, { now: NOW0, entered: {}, seen: emptySeen(), prs: {}, ...over })
const cardsOf = (board: ReturnType<typeof parseBoard>) => projectCards(board, focusOf(board))

describe('projectCards', () => {
  const cards = cardsOf(withLive(BOARD, ...BOARD_LIVE))

  test('orders cards with a question first, then by the most recent activity', () => {
    expect(cards.map(c => c.name)).toEqual(['acme-gateway', 'user', 'other', 'Developer'])
  })

  test('puts questions, then running, then what just finished under the repo they belong to; day-old ones are gone', () => {
    const acmeGateway = cards.find(c => c.name === 'acme-gateway')!

    expect(acmeGateway.tasks.map(t => `${shortName(t.id)}:${t.state}`)).toEqual(['report-site:held', 'stats:review', 'a:done'])
    expect(cards.find(c => c.name === 'user')!.tasks.map(t => shortName(t.id))).toEqual(['hq-mod'])
    expect(cards.find(c => c.name === 'other')!.tasks.map(t => shortName(t.id))).toEqual(['odd', 'd'])
  })

  test('counts the tasks that wait on others per card', () => {
    const board = withLive(BOARD + 'WAITING ON OTHERS\n  1014-w  waiting  1h  ship  acme-gateway  PR #35\n', ...BOARD_LIVE)

    expect(cardsOf(board).find(c => c.name === 'acme-gateway')!.waiting).toBe(1)
  })

  test('lists busy sessions by name and folds idle ones into a count', () => {
    const acmeGateway = cards.find(c => c.name === 'acme-gateway')!
    const home = cards.find(c => c.name === 'user')!
    const dev = cards.find(c => c.name === 'Developer')!

    expect(acmeGateway.busy.map(s => `${s.name}:${s.age}`)).toEqual(['acme-gateway-9e:2m'])
    expect(acmeGateway.idle).toBe(1)
    expect(home.busy.map(s => s.name)).toEqual(['user-cb'])
    expect(dev.busy).toEqual([])
    expect(dev.idle).toBe(1)
  })

  test('files a session under the last part of its full cwd, however long the path is', () => {
    const deep = '/home/user/Developer/oss/some/very/long/path/that/crew/cuts/at/forty/deep-project'
    const found = cardsOf(withLive('', live('s', '', deep, 'busy', 5)))

    expect(found.map(c => c.name)).toEqual(['deep-project'])
  })

  test('shows at most three done tasks per card, the most recent first', () => {
    const many = parseBoard(
      'DONE\n' +
        ['5h', '1h', '9h', '2h', '30h'].map((age, i) => `  10${i}-t${i}  done  ${age}  ship  user  x`).join('\n') +
        '\n',
    )

    expect(cardsOf(many)[0]!.tasks.map(t => t.age)).toEqual(['1h', '2h', '5h'])
  })
})

describe('footers', () => {
  test('Projects footer is one line, parked first', () => {
    expect(projectsFooter({ busy: 2, idle: 4, doneToday: 6, parked: 3 })).toBe('◇ 3 parked · ✓ 6 done today')
    expect(projectsFooter({ busy: 2, idle: 4, doneToday: 6, parked: 0 })).toBe('✓ 6 done today')
  })
})

describe('quiet projects', () => {
  const cards = cardsOf(withLive(BOARD, ...BOARD_LIVE))

  test('a project is active only with a question or running task or a busy session', () => {
    expect(cards.map(c => `${c.name}:${c.isActive}`)).toEqual([
      'acme-gateway:true',
      'user:true',
      'other:false',
      'Developer:false',
    ])
  })

  test('quietLine folds the quiet projects into one line with idle sessions and done tasks', () => {
    const board = withLive(
      'DONE\n  1-x   done  2h  ship  claude-config  x\n  1-y   done  1h  ship  -  y\n',
      live('a', '', '/home/user/Developer/beta-explore', 'idle', 3600),
      live('b', '', '/home/user/Developer/beta-explore', 'idle', 7200),
      live('c', '', '/home/user/Developer', 'idle', 10800),
    )

    expect(quietLine(cardsOf(board))).toBe(
      'quiet  beta-explore ○2 · other ✓1 · claude-config ✓1 · Developer ○1',
    )
  })

  test('quietLine is empty when every project is active', () => {
    expect(quietLine(cards.filter(c => c.isActive))).toBe('')
  })
})

describe('jumping and leads', () => {
  const board = withLive(
    '',
    live('acme-gateway-80', 'claude:3.0', '/home/user/Developer/acme-gateway', 'idle', 3600),
    live('acme-gateway-9e', 'claude:2.0', '/home/user/Developer/acme-gateway', 'busy', 540),
    live('acme-gateway-x', 'claude:7.1', '/home/user/Developer/acme-gateway', 'busy', 120),
    live('hq', 'claude:6.0', '/home/user', 'busy', 0),
    live('a-very-long-session-one', 'claude:9.0', '/home/user/Developer/long', 'busy', 60),
    live('a-very-long-session-two', 'claude:9.1', '/home/user/Developer/long', 'idle', 90),
    live('ghost', '', '/home/user/Developer/ghost', 'busy', 30),
  )

  test('sessions sharing a 20-character name prefix keep their own targets', () => {
    expect(findJump(board, 'a-very-long-session-one')?.target).toBe('claude:9.0')
    expect(findJump(board, 'a-very-long-session-two')?.target).toBe('claude:9.1')
  })

  test('repoJump and pickLead take the busiest, then most recent, session of the project, never hq', () => {
    expect(repoJump(board, 'acme-gateway')?.name).toBe('acme-gateway-x')
    expect(pickLead(board, 'acme-gateway')?.name).toBe('acme-gateway-x')
    expect(pickLead(board, 'user')).toBeUndefined()
    expect(pickLead(withLive('', live('a', '', '/x/p', 'idle', 9000), live('b', '', '/x/p', 'idle', 100)), 'p')?.name).toBe('b')
  })

  test('a session outside tmux can be a lead but not a jump target', () => {
    expect(pickLead(board, 'ghost')?.name).toBe('ghost')
    expect(repoJump(board, 'ghost')).toBeUndefined()
    expect(findJump(board, 'ghost')).toBeUndefined()
  })

  test('findJump takes a session name first, then a project', () => {
    expect(findJump(board, 'acme-gateway-80')?.target).toBe('claude:3.0')
    expect(findJump(board, 'acme-gateway')?.target).toBe('claude:7.1')
    expect(findJump(board, 'nothing')).toBeUndefined()
  })

  test('jumpChoices lists the names of sessions in tmux and the projects that have one', () => {
    expect(jumpChoices(board)).toEqual([
      'a-very-long-session-one',
      'a-very-long-session-two',
      'acme-gateway',
      'acme-gateway-80',
      'acme-gateway-9e',
      'acme-gateway-x',
      'long',
    ])
  })

  test('showTarget drops the pane index of pane 0 only', () => {
    expect([showTarget('claude:6.0'), showTarget('claude:2.1')]).toEqual(['claude:6', 'claude:2.1'])
  })

  test('isTarget accepts session:window.pane and refuses anything with spaces, quotes or semicolons', () => {
    expect(['claude:5.1', '0:0.0', 'a_b-c:1.2'].map(isTarget)).toEqual([true, true, true])
    expect(['', 'a b', 'x;kill-server', '$(x)', 'a\nb'].map(isTarget)).toEqual([false, false, false, false, false])
  })
})

describe('holds', () => {
  const held = { id: '1014-stats', state: 'held', age: '2h', repo: 'acme-gateway', note: 'q' }

  test('holdLine is the first non-empty line of hold.md', () => {
    expect(holdLine('\n  Which DB?  \nmore detail\n')).toBe('Which DB?')
    expect(holdLine('')).toBe('')
  })

})

describe('the model view', () => {
  const board = withLive(
    [
      'NEEDS YOU',
      '  1014-stats  review  3h  ship  acme-gateway  verified 965 pass; branch x',
      '  1014-report-site  held  2h  ship  acme-gateway  lead verified: waiting',
      'RUNNING',
      '  1015-hq-mod  running  0m  ship  user  sonnet implementer',
      '',
    ].join('\n'),
    live('acme-gateway-80', '', '/home/user/Developer/acme-gateway', 'idle', 3600),
    live('acme-gateway-x', 'claude:7.1', '/home/user/Developer/acme-gateway', 'busy', 120),
    live('hq', 'claude:6.0', '/home/user', 'busy', 0),
  )

  test('boardForModel lists open tasks, claude sessions with their tmux targets, and a lead per project', () => {
    expect(boardForModel(board, { '1014-report-site': 'Which DB?' })).toEqual({
      tasks: [
        { id: '1014-stats', name: 'stats', repo: 'acme-gateway', state: 'review', age: '3h', note: '965 pass', lead: 'acme-gateway-x', leadGuessed: true },
        { id: '1014-report-site', name: 'report-site', repo: 'acme-gateway', state: 'held', age: '2h', note: 'waiting', question: 'Which DB?', lead: 'acme-gateway-x', leadGuessed: true },
        { id: '1015-hq-mod', name: 'hq-mod', repo: 'user', state: 'running', age: '0m', note: 'sonnet implementer' },
      ],
      sessions: [
        { name: 'acme-gateway-80', project: 'acme-gateway', state: 'idle', age: '1h' },
        { name: 'acme-gateway-x', project: 'acme-gateway', state: 'busy', age: '2m', tmux: 'claude:7.1' },
      ],
      leads: { 'acme-gateway': 'acme-gateway-x' },
    })
  })
})


describe('parseStatusTs', () => {
  test('a later line in the same state, such as an answer note, does not move the time the state began', () => {
    expect(parseStatusTs('2026-10-15T09:00:00Z\tqueued\tcreated\n2026-10-15T10:30:00Z\treview\tready\n2026-10-15T11:00:00Z\treview\tD2 answered: yes\n')).toBe(
      Date.parse('2026-10-15T10:30:00Z'),
    )
  })

  test('is the time of the last line, when the task entered its current state', () => {
    expect(parseStatusTs('2026-10-15T09:00:00Z\tqueued\tcreated\n2026-10-15T10:30:00Z\treview\tready\n')).toBe(
      Date.parse('2026-10-15T10:30:00Z'),
    )
    expect(parseStatusTs('')).toBeUndefined()
    expect(parseStatusTs('garbage\n')).toBeUndefined()
  })
})

describe('parseStatusLastTs', () => {
  test('is the time of the last line, whatever its state: a task that keeps reporting is alive', () => {
    const status = '2026-10-16T13:16:15Z\trunning\tstarted\n2026-10-16T13:20:35Z\trunning\thalf done\n'

    expect(parseStatusLastTs(status)).toBe(Date.parse('2026-10-16T13:20:35Z'))
    expect(parseStatusLastTs('')).toBeUndefined()
    expect(parseStatusLastTs('garbage\trunning\tx\n')).toBeUndefined()
  })
})

describe('briefText', () => {
  const T0 = Date.parse('2026-10-15T10:00:00Z')
  const NOW = T0 + 2 * 3600_000
  const at = (minutes: number) => T0 + minutes * 60_000
  const board = parseBoard(
    [
      'NEEDS YOU',
      '  1014-a  review  30m  ship  acme-gateway  verified ok; x',
      '  1014-b  held  5h  ship  acme-gateway  question',
      '  1014-c  failed  10m  ship  user  boom',
      '  1014-d  review  1d  ship  user  old thing',
      '  1014-j  review  30m  ship  user  rounded',
      'RUNNING',
      '  1014-e  running  1m  ship  user  w',
      'DONE',
      '  1014-f  landed  20m  ship  acme-gateway  x',
      '  1014-g  done  3h  ship  user  y',
      '  1014-h  done  1h  ship  user  z',
      '  1014-i  dropped  5m  ship  user  gone',
      '',
    ].join('\n'),
  )
  // when each task entered its current state, from its status file
  const entered = {
    '1014-a': at(100),
    '1014-b': at(-300),
    '1014-c': at(60),
    '1014-d': at(-1440),
    '1014-j': at(-10),
    '1014-e': at(115),
    '1014-f': at(100),
    '1014-g': at(-60),
    '1014-h': at(30),
    '1014-i': at(110),
  }

  test('lists what finished, failed and newly needs you since the last look, then what still waits', () => {
    expect(briefText(board, T0, NOW, false, entered)).toBe(
      [
        'Since your last look (2h ago):',
        '  landed or done: f, h (2)',
        '  failed: c — boom',
        '  needs you: a (review) — ok',
        '  still waiting: b (held, 5h), d (review, 1d), j (review, 30m)',
        '  running: 1',
      ].join('\n'),
    )
  })

  test('judges by when a task entered its state, not by its rounded display age', () => {
    expect(briefText(board, T0, NOW, false, entered)).not.toContain('needs you: a (review) — ok; j')
    expect(briefText(board, T0, NOW, false, { ...entered, '1014-j': at(5) })).toContain('needs you: a (review) — ok; j (review) — rounded')
  })

  test('a dropped task is not reported as landed or done', () => {
    expect(briefText(board, T0, NOW, false, entered).split('\n')[1]).toBe('  landed or done: f, h (2)')
  })

  test('the first run covers the last 24 hours', () => {
    expect(briefText(board, NOW - 86400_000, NOW, true, entered).split('\n')[0]).toBe('Last 24h:')
  })

  test('says so when nothing is new, and does not count a task with no status time as new', () => {
    expect(briefText(parseBoard('NEEDS YOU\n  1014-b  held  5h  ship  acme-gateway  q\n'), at(110), NOW, false, {})).toBe(
      ['Since your last look (10m ago):', '  nothing new', '  still waiting: b (held, 5h)'].join('\n'),
    )
  })
})

describe('task meta and the exact lead', () => {
  const META = 'shape=ship\nrepo=/home/user/Developer/acme-gateway\nlead=old-one\ncreated=x\nbranch=user/stats\nlead=acme-gateway-80\nlead=\n'

  test('parseMeta takes the last lead, repo and branch line, and ignores an empty value', () => {
    expect(parseMeta(META)).toEqual({ lead: 'acme-gateway-80', repoPath: '/home/user/Developer/acme-gateway', branch: 'user/stats' })
    expect(parseMeta('shape=ship\n')).toEqual({})
  })

  test('parseMeta reads the worktree line too, and ignores an empty one', () => {
    expect(parseMeta('worktree=/home/user/Developer/acme-gateway/.claude/worktrees/crew-a\nbranch=crew/a\n')).toEqual({
      worktree: '/home/user/Developer/acme-gateway/.claude/worktrees/crew-a',
      branch: 'crew/a',
    })
    expect(parseMeta('worktree=\n')).toEqual({})
  })

  test('a branch or worktree line cleared by a later empty one leaves no diff target, the way crew diff and the web page read it', () => {
    const task = { id: 'a', state: 'review', age: '1m', repo: 'x', note: '' }
    const diffable = (text: string) => canDiff({ ...task, ...parseMeta(text) })

    expect(diffable('branch=crew/old\nbranch=\n')).toBe(false)
    expect(diffable('branch=crew/old\nbranch=\nworktree=/w\n')).toBe(true)
    expect(diffable('worktree=/w\nworktree=\n')).toBe(false)
    expect(diffable('branch=\nbranch=crew/new\n')).toBe(true)
    expect(diffable('branch=crew/a\nworktree=/w\nbranch=\nworktree=\n')).toBe(false)
    // the other features keep reading the last non-empty value
    expect(parseMeta('branch=crew/old\nbranch=\n').branch).toBe('crew/old')
  })

  test('applyMeta puts the meta on the tasks it names and leaves the others alone', () => {
    const board = parseBoard('NEEDS YOU\n  1014-a  review  3h  ship  acme-gateway  x\nRUNNING\n  1014-b  running  1m  ship  user  y\n')
    const merged = applyMeta(board, { '1014-a': { lead: 'l', repoPath: '/r', branch: 'b' } })

    expect(merged.needsYou[0]).toEqual({ id: '1014-a', state: 'review', age: '3h', repo: 'acme-gateway', note: 'x', lead: 'l', repoPath: '/r', branch: 'b' })
    expect(merged.running[0]).toEqual(board.running[0])
  })

  const board = withLive(
    'NEEDS YOU\n  1014-a  review  3h  ship  acme-gateway  x\n',
    live('acme-gateway-x', 'claude:7.1', '/home/user/Developer/acme-gateway', 'busy', 120),
    live('acme-gateway-80', '', '/home/user/Developer/acme-gateway', 'idle', 3600),
  )
  const task = board.needsYou[0]!

  test('resolveLead uses the lead the task names when that session is live', () => {
    expect(resolveLead(board, { ...task, lead: 'acme-gateway-80' })).toEqual({ session: board.elsewhere[1], guessed: false })
  })

  test('resolveLead guesses by project when there is no lead, or the named lead is not live', () => {
    expect(resolveLead(board, task)?.session.name).toBe('acme-gateway-x')
    expect(resolveLead(board, task)?.guessed).toBe(true)
    expect(resolveLead(board, { ...task, lead: 'long-gone' })).toEqual({ session: board.elsewhere[0], guessed: true })
    expect(resolveLead(board, { ...task, repo: 'ghost' })).toBeUndefined()
  })

  test('jumpFor gives the exact lead when it is in tmux, a guess when there is no lead, nothing for an exact lead outside tmux', () => {
    expect(jumpFor(board, { ...task, lead: 'acme-gateway-x' })).toEqual({ session: board.elsewhere[0], guessed: false })
    expect(jumpFor(board, task)).toEqual({ session: board.elsewhere[0], guessed: true })
    expect(jumpFor(board, { ...task, lead: 'acme-gateway-80' })).toBeUndefined()
  })
})

describe('pull requests', () => {
  const task = { id: '1014-a', state: 'review', age: '3h', repo: 'acme-gateway', note: 'PR #36 open, waiting', branch: 'user/stats' }

  test('prRef prefers the PR number in the note and falls back to the meta branch', () => {
    expect(prRef(task)).toEqual({ kind: 'number', key: '#36', n: 36 })
    expect(prRef({ ...task, note: 'verified 965 pass' })).toEqual({ kind: 'branch', key: 'branch:user/stats', branch: 'user/stats' })
    expect(prRef({ ...task, note: 'x', branch: undefined })).toBeUndefined()
  })

  test('prRef refuses a branch that is not a plain ref name', () => {
    expect(['a b', 'x;rm -rf', '$(x)', '--json', '-x', ''].map(branch => prRef({ ...task, note: 'x', branch }))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  test('ghArgs asks gh for the PR by number, or by branch', () => {
    expect(ghArgs({ kind: 'number', key: '#36', n: 36 })).toEqual(['gh', 'pr', 'view', '36', '--json', 'number,state,mergedAt,closedAt,url'])
    expect(ghArgs({ kind: 'branch', key: 'branch:user/stats', branch: 'user/stats' })).toEqual([
      'gh', 'pr', 'list', '--head', 'user/stats', '--state', 'all', '--json', 'number,state,mergedAt,closedAt,url', '--limit', '1',
    ])
  })

  test('parsePr reads the object of pr view and the first of pr list, and anything else as no PR', () => {
    expect(parsePr('{"mergedAt":null,"number":35,"state":"OPEN","url":"https://x/35"}')).toEqual({ number: 35, state: 'OPEN' })
    expect(parsePr('[{"mergedAt":"2026-10-15T10:00:00Z","number":36,"state":"MERGED","url":"u"}]')).toEqual({
      number: 36,
      state: 'MERGED',
      at: Date.parse('2026-10-15T10:00:00Z'),
    })
    expect(parsePr('{"closedAt":"2026-10-15T11:00:00Z","mergedAt":null,"number":37,"state":"CLOSED"}')).toEqual({
      number: 37,
      state: 'CLOSED',
      at: Date.parse('2026-10-15T11:00:00Z'),
    })
    expect(parsePr('[]')).toBe(null)
    expect(parsePr('not json')).toBe(null)
    expect(parsePr('{"number":3,"state":"WEIRD"}')).toBe(null)
  })

  test('mergedNotLogged lists open tasks whose PR is merged, with the PR', () => {
    const board = applyMeta(
      parseBoard('NEEDS YOU\n  1014-a  review  3h  ship  acme-gateway  PR #1\n  1014-b  review  3h  ship  acme-gateway  PR #2\nWAITING ON OTHERS\n  1014-c  waiting  1m  ship  user  PR #3\n'),
      { '1014-a': { repoPath: '/r' }, '1014-b': { repoPath: '/r' }, '1014-c': { repoPath: '/r' } },
    )
    const prs = {
      '1014-a': { key: '/r|#1', fetched: 0, pr: { number: 1, state: 'MERGED' } },
      '1014-b': { key: '/r|#2', fetched: 0, pr: { number: 2, state: 'OPEN' } },
      '1014-c': { key: '/r|#3', fetched: 0, pr: { number: 3, state: 'MERGED' } },
    }

    expect(mergedNotLogged(board, prs).map(m => `${m.task.id}:${m.pr.number}`)).toEqual(['1014-c:3', '1014-a:1'])
  })

  describe('an answer counts only for the PR the task points at now', () => {
    const merged = { number: 36, state: 'MERGED' }
    const withTask = (over: Partial<typeof task & { repoPath: string }>) => ({ ...task, repoPath: '/r', ...over })
    const entry = { key: '/r|#36', fetched: 5, pr: merged }

    test('prKey is the repo path and the reference, and nothing without both', () => {
      expect(prKey(withTask({}))).toBe('/r|#36')
      expect(prKey(withTask({ note: 'x' }))).toBe('/r|branch:user/stats')
      expect(prKey(withTask({ note: 'x', branch: undefined }))).toBeUndefined()
      expect(prKey(withTask({ repoPath: undefined }))).toBeUndefined()
    })

    test('prFor ignores an answer about another PR, another repo, or a task that lost its reference', () => {
      expect(prFor(withTask({}), { [task.id]: entry })).toEqual(merged)
      expect(prFor(withTask({ note: 'PR #37 open' }), { [task.id]: entry })).toBeUndefined()
      expect(prFor(withTask({ repoPath: '/other' }), { [task.id]: entry })).toBeUndefined()
      expect(prFor(withTask({ note: 'x', branch: undefined }), { [task.id]: entry })).toBeUndefined()
    })

    test('a task that moved to another PR is no longer merged-not-logged, and shows no badge', () => {
      const board = applyMeta(parseBoard('NEEDS YOU\n  1014-a  review  3h  ship  acme-gateway  PR #37 open\n'), { '1014-a': { repoPath: '/r' } })

      expect(mergedNotLogged(board, { '1014-a': entry })).toEqual([])
    })

    test('prunePrs drops entries of tasks that are gone or point somewhere else now', () => {
      const board = applyMeta(
        parseBoard('NEEDS YOU\n  1014-a  review  3h  ship  acme-gateway  PR #37\n  1014-b  review  3h  ship  acme-gateway  PR #2\n'),
        { '1014-a': { repoPath: '/r' }, '1014-b': { repoPath: '/r' } },
      )
      const kept = { key: '/r|#2', fetched: 7, pr: null }

      expect(prunePrs(board, { '1014-a': entry, '1014-b': kept, '1014-gone': entry })).toEqual({ '1014-b': kept })
    })
  })

  describe('ghDue', () => {
    const NOW = 10_000_000
    const t = (n: number) => ({ id: `1014-t${n}`, state: 'review', age: '1m', repo: 'acme-gateway', note: `PR #${n}`, repoPath: '/r' })
    const entry = (n: number, ago: number) => ({ key: `/r|#${n}`, fetched: NOW - ago, pr: null })
    const ids = (due: { task: { id: string } }[]) => due.map(d => d.task.id.slice(5))

    test('skips fresh entries, takes the oldest first, at most three', () => {
      const cache = {
        '1014-t1': entry(1, 1_000),
        '1014-t2': entry(2, 400_000),
        '1014-t3': entry(3, 301_000),
        '1014-t4': entry(4, 350_000),
        '1014-t5': entry(5, 999_000),
      }

      expect(ids(ghDue([t(1), t(2), t(3), t(4), t(5)], cache, NOW))).toEqual(['t5', 't2', 't4'])
    })

    test('a task never queried comes before any stale one, and a changed reference counts as never queried', () => {
      const cache = { '1014-t1': entry(1, 400_000), '1014-t2': { key: '/r|#99', fetched: NOW - 1_000, pr: null } }

      expect(ids(ghDue([t(1), t(2), t(3)], cache, NOW))).toEqual(['t2', 't3', 't1'])
    })

    test('leaves out tasks with nothing to ask about, or no repo path to ask in', () => {
      const noRef = { ...t(1), note: 'x' }
      const noRepo = { ...t(2), repoPath: undefined }

      expect(ghDue([noRef, noRepo], {}, NOW)).toEqual([])
    })
  })
})


describe('decision ids', () => {
  const crewLs = [
    'NEEDS YOU',
    '  1014-1014-stats              review     22h  ship  acme-gateway   D3 · PR #35 open, waiting on merge go',
    '  1014-1014-report-site        held        2h  ship  acme-gateway   D4 ·',
    '  1014-notes                   review      1h  ship  acme-gateway   D12 migration done, check it',
    '  1014-plain                   failed      5m  ship  acme-gateway   exit 1',
    '',
  ].join('\n')

  test('parseBoard reads the `D<n> · ` that crew ls puts in front of the note, and leaves other notes alone', () => {
    const board = parseBoard(crewLs)

    expect(board.needsYou).toEqual([
      { id: '1014-1014-stats', state: 'review', age: '22h', repo: 'acme-gateway', note: 'PR #35 open, waiting on merge go', decision: 'D3' },
      { id: '1014-1014-report-site', state: 'held', age: '2h', repo: 'acme-gateway', note: '', decision: 'D4' },
      { id: '1014-notes', state: 'review', age: '1h', repo: 'acme-gateway', note: 'D12 migration done, check it' },
      { id: '1014-plain', state: 'failed', age: '5m', repo: 'acme-gateway', note: 'exit 1' },
    ])
  })

  test('hq_board lists the decision id of a task', () => {
    const view = boardForModel(parseBoard(crewLs), { '1014-1014-stats': 'merge acme-gateway #35?' })

    expect(view.tasks[0]).toEqual({
      id: '1014-1014-stats',
      name: 'stats',
      repo: 'acme-gateway',
      state: 'review',
      age: '22h',
      note: 'PR #35 open, waiting on merge go',
      decision: 'D3',
      question: 'merge acme-gateway #35?',
    })
  })
})

describe('waiting on others', () => {
  test('parseBoard reads the WAITING ON OTHERS section', () => {
    const board = parseBoard('WAITING ON OTHERS\n  1014-1014-stats              waiting     1h  ship  acme-gateway   Sam merges PR #35\n')

    expect(board.waiting).toEqual([{ id: '1014-1014-stats', state: 'waiting', age: '1h', repo: 'acme-gateway', note: 'Sam merges PR #35' }])
    expect(board.needsYou).toEqual([])
  })

  test('a waiting task with an open decision needs the user, not the footer', () => {
    const board = parseBoard('NEEDS YOU\n  1014-a  waiting  1h  ship  acme-gateway  D5 · wait for Sam?\n')

    expect(focusOf(board).asks.map(t => t.decision)).toEqual(['D5'])
    expect(focusOf(board).waiting).toEqual([])
  })
})

describe('classify: NEEDS YOU, NOW, JUST FINISHED', () => {
  const NOW = Date.parse('2026-10-16T12:00:00Z')
  const hoursAgo = (h: number) => NOW - h * 3_600_000
  const BOARD3 = parseBoard(
    [
      'NEEDS YOU',
      '  1016-ask-held                held        1h  ship  acme-gateway   Which DB?',
      '  1016-ask-review              review      1h  ship  acme-gateway   D4 · PR #40 open, merge go?',
      '  1016-ready                   review      2h  ship  acme-gateway   verified 90 pass; branch x',
      '  1016-broken                  failed     30m  ship  acme-gateway   tests failed',
      'RUNNING',
      '  1016-busy                    running     5m  ship  acme-gateway   sonnet implementer',
      'WAITING ON OTHERS',
      '  1016-stats                   waiting     3h  ship  acme-gateway   PR #35 open',
      'DONE',
      '  1015-old                     done       20h  ship  acme-gateway   old news',
      '  1016-shipped                 landed      4h  ship  acme-gateway   landed on master',
      '',
    ].join('\n'),
  )
  const ctx = { now: NOW, entered: {}, seen: emptySeen(), prs: {} }

  test('only held tasks and tasks with a D-id need the user; running is NOW; waiting stays in the footer', () => {
    const plan = classify(BOARD3, ctx)

    expect(plan.asks.map(t => shortName(t.id))).toEqual(['ask-held', 'ask-review'])
    expect(plan.now.map(t => shortName(t.id))).toEqual(['busy'])
    expect(plan.waiting.map(t => shortName(t.id))).toEqual(['stats'])
  })

  test('JUST FINISHED holds review, failed, done and landed tasks without a question, newest first, for 12 hours', () => {
    const plan = classify(BOARD3, ctx)

    expect(plan.finished.map(f => `${f.mark} ${shortName(f.task.id)} ${f.text}`)).toEqual([
      '✗ broken tests failed',
      '✓ ready 90 pass',
      '✓ shipped landed on master',
    ])
  })

  test('the time a task entered its state decides: older than 12 hours is gone, and the status file beats the rounded age', () => {
    const entered = { '1016-ready': hoursAgo(13), '1016-broken': hoursAgo(11.9), '1016-shipped': hoursAgo(0.5) }

    expect(classify(BOARD3, { ...ctx, entered }).finished.map(f => shortName(f.task.id))).toEqual(['shipped', 'broken'])
  })

  test('a dropped task is not a success: it does not show up as finished', () => {
    const board = parseBoard('DONE\n  1016-gone  dropped  1h  ship  acme-gateway  cancelled\n  1016-fine  done  1h  ship  acme-gateway  ok\n')

    expect(classify(board, ctx).finished.map(f => shortName(f.task.id))).toEqual(['fine'])
  })

  test('"seen" hides what finished before it: for everything, or for one task', () => {
    const all = classify(BOARD3, { ...ctx, seen: { all: hoursAgo(1), ids: {} } })
    const one = classify(BOARD3, { ...ctx, seen: { all: 0, ids: { '1016-broken': NOW } } })

    expect(all.finished.map(f => shortName(f.task.id))).toEqual(['broken'])
    expect(one.finished.map(f => shortName(f.task.id))).toEqual(['ready', 'shipped'])
  })

  test('a task that enters a new state after it was seen shows again', () => {
    const entered = { '1016-ready': hoursAgo(0.2) }
    const seen = { all: 0, ids: { '1016-ready': hoursAgo(1) } }

    expect(classify(BOARD3, { ...ctx, entered, seen }).finished.map(f => shortName(f.task.id))).toContain('ready')
  })

  describe('a waiting or review task whose PR ended on GitHub', () => {
    const withMeta = applyMeta(BOARD3, { '1016-stats': { repoPath: '/r' }, '1016-ready': { repoPath: '/r', branch: 'b' } })
    const merged = { key: '/r|#35', fetched: hoursAgo(0.1), pr: { number: 35, state: 'MERGED', at: hoursAgo(2) } }

    test('moves to JUST FINISHED as "merged on GitHub — log landed?" and leaves the waiting footer', () => {
      const plan = classify(withMeta, { ...ctx, prs: { '1016-stats': merged } })

      expect(plan.finished.map(f => `${f.mark} ${shortName(f.task.id)} ${f.text}`)).toContain('✓ stats #35 merged on GitHub — log landed?')
      expect(plan.waiting).toEqual([])
    })

    test('a closed PR is a ✗, dated by when it closed', () => {
      const closed = { key: '/r|#35', fetched: hoursAgo(0.1), pr: { number: 35, state: 'CLOSED', at: hoursAgo(3) } }
      const item = classify(withMeta, { ...ctx, prs: { '1016-stats': closed } }).finished.find(f => f.task.id === '1016-stats')!

      expect([item.mark, item.text, item.at]).toEqual(['✗', '#35 closed on GitHub', hoursAgo(3)])
    })

    test('an open PR changes nothing, and a merged one older than 12 hours is not news any more', () => {
      const open = { key: '/r|#35', fetched: hoursAgo(0.1), pr: { number: 35, state: 'OPEN' } }
      const old = { ...merged, pr: { number: 35, state: 'MERGED', at: hoursAgo(20) } }

      expect(classify(withMeta, { ...ctx, prs: { '1016-stats': open } }).waiting.map(t => t.id)).toEqual(['1016-stats'])
      expect(classify(withMeta, { ...ctx, prs: { '1016-stats': old } }).finished.map(f => f.task.id)).not.toContain('1016-stats')
      expect(classify(withMeta, { ...ctx, prs: { '1016-stats': old } }).waiting).toEqual([])
    })

    test('a review task with a merged PR is reported once, as the merged line', () => {
      const entry = { key: '/r|branch:b', fetched: hoursAgo(0.1), pr: { number: 40, state: 'MERGED', at: hoursAgo(1) } }
      const finished = classify(withMeta, { ...ctx, prs: { '1016-ready': entry } }).finished.filter(f => f.task.id === '1016-ready')

      expect(finished.map(f => f.text)).toEqual(['#40 merged on GitHub — log landed?'])
    })

    test('prTasks are the waiting tasks and the review tasks', () => {
      expect(prTasks(BOARD3).map(t => shortName(t.id))).toEqual(['stats', 'ask-review', 'ready'])
    })
  })
})

describe('review requests from GitHub', () => {
  test('parseReviewPrs reads gh search output, taking the full repo name, and drops control characters from titles', () => {
    const out = JSON.stringify([
      { number: 41, title: 'Add stats\u001b[31m page', repository: { name: 'acme-gateway', nameWithOwner: 'user/acme-gateway' }, url: 'https://github.com/user/acme-gateway/pull/41', updatedAt: '2026-10-16T10:00:00Z' },
      { number: 7, title: 'Fix', repository: { name: 'beta' }, url: 'https://x/7', updatedAt: 'nonsense' },
      { number: 'bad', title: 'x', repository: { name: 'r' }, url: 'u', updatedAt: '' },
    ])

    expect(parseReviewPrs(out)).toEqual([
      { repo: 'user/acme-gateway', number: 41, title: 'Add stats [31m page', url: 'https://github.com/user/acme-gateway/pull/41', updatedAt: Date.parse('2026-10-16T10:00:00Z') },
      { repo: 'beta', number: 7, title: 'Fix', url: 'https://x/7', updatedAt: 0 },
    ])
    expect(parseReviewPrs('[]')).toEqual([])
    expect(parseReviewPrs('{"number":1}')).toBeNull()
    expect(parseReviewPrs('not json')).toBeNull()
  })

  test('the search is due when it never ran or its answer is five minutes old', () => {
    expect(reviewDue({ fetched: 0, prs: null }, 1_000_000)).toBe(true)
    expect(reviewDue({ fetched: 1_000, prs: [] }, 1_000 + 299_000)).toBe(false)
    expect(reviewDue({ fetched: 1_000, prs: [] }, 1_000 + 300_000)).toBe(true)
  })

  test('ghDue leaves room for the search when asked for fewer queries', () => {
    const t = (n: number) => ({ id: `1014-t${n}`, state: 'review', age: '1m', repo: 'acme-gateway', note: `PR #${n}`, repoPath: '/r' })

    expect(ghDue([t(1), t(2), t(3)], {}, 10_000_000, 2).map(d => d.task.id)).toEqual(['1014-t1', '1014-t2'])
  })
})

describe('what the user has seen', () => {
  test('markSeen with no id clears everything up to now; with an id it marks that task and keeps the rest', () => {
    expect(markSeen({ all: 5, ids: { a: 6 } }, 100)).toEqual({ all: 100, ids: {} })
    expect(markSeen({ all: 5, ids: { a: 6 } }, 100, 'b')).toEqual({ all: 5, ids: { a: 6, b: 100 } })
  })

  test('markSeen forgets single marks older than a day', () => {
    const day = 24 * 3_600_000

    expect(markSeen({ all: 0, ids: { old: 1 } }, day + 10, 'b')).toEqual({ all: 0, ids: { b: day + 10 } })
  })

  test('parseSeen takes what the store held and treats anything else as nothing seen', () => {
    expect(parseSeen({ all: 7, ids: { a: 3, b: 'x' } })).toEqual({ all: 7, ids: { a: 3 } })
    expect(parseSeen(undefined)).toEqual({ all: 0, ids: {} })
    expect(parseSeen('junk')).toEqual({ all: 0, ids: {} })
  })

  test('findTask finds a task by id or short name on any list', () => {
    const board = parseBoard('WAITING ON OTHERS\n  1016-stats  waiting  1h  ship  acme-gateway  x\nDONE\n  1015-old  done  2h  ship  user  y\n')

    expect(findTask(board, 'stats')?.id).toBe('1016-stats')
    expect(findTask(board, '1015-old')?.id).toBe('1015-old')
    expect(findTask(board, 'zzz')).toBeUndefined()
  })
})

describe('the Focus layout: NEEDS YOU, NOW, JUST FINISHED, idle', () => {
  const H = 3_600_000
  const NOW = Date.parse('2026-10-16T12:00:00Z')
  const CREW = [
    'NEEDS YOU',
    '  1016-noop-review-fixes       review     15h  ship  acme-gateway   1481668 on user/noop-guard: findings 3+4 fixed; 1+2 need gate',
    '  1016-schema                  held        1h  ship  acme-gateway   D14 · pick the schema',
    '  1016-broken                  failed     20m  ship  claude-config  exit 1',
    'RUNNING',
    '  1015-docs-refresh            queued     17h  ship  acme-gateway   after Sam merges #35/#36',
    '  1016-hq-acme-gateway         running     4m  ship  claude-config  sonnet implementer',
    '  1016-bake-off                running     1m  scout -              hands-on',
    'WAITING ON OTHERS',
    '  1016-stats                   waiting     3h  ship  acme-gateway   PR #44 open, waiting on Sam',
    'DONE',
    '  1016-memory-tools            done        9m  scout claude-config  pick: DIY FTS5',
    '  1014-old                     landed     40h  ship  acme-gateway   PR #1',
    '',
  ].join('\n')
  const ACME_GATEWAY_LIVE = live('acme-gateway-80', 'claude:1.0', '/home/user/Developer/acme-gateway', 'idle', 600)
  const CONFIG_LIVE = live('claude-config', 'claude:3.0', '/home/user/Developer/claude-config', 'busy', 240)
  const board = applyMeta(
    withLive(CREW, ACME_GATEWAY_LIVE, CONFIG_LIVE, live('beta', '', '/home/user/Developer/beta', 'idle', 100_000), live('hq', 'claude:6.0', '/home/user', 'busy', 0)),
    { '1016-noop-review-fixes': { lead: 'acme-gateway-80' }, '1015-docs-refresh': { lead: 'acme-gateway-80' }, '1016-stats': { lead: 'acme-gateway-80' }, '1016-hq-acme-gateway': { lead: 'claude-config' } },
  )
  type Over = Partial<Parameters<typeof focusLayout>[0]>
  const layoutOf = (b = board, over: Over = {}) => {
    const ctx = over.ctx ?? { now: NOW, entered: {}, seen: emptySeen(), prs: {} }

    return focusLayout({ board: b, plan: classify(b, ctx), ctx, ...over })
  }
  const needs = (l = layoutOf(), width = 70) => needParts(l.needs, width).map(p => `${p.name.trimEnd()} | ${p.msg.trimEnd()} | ${p.go.trimEnd()}`)
  const nowLines = (l = layoutOf(), width = 120) => nowParts(l.now, width).map(p => `${p.name.trimEnd()} | ${p.status.trimEnd()} | ${p.lines.join(' // ')}`)
  const chat = (name: string, items: string[], at: number, b = board) => ({ session: b.elsewhere.find(s => s.name === name)!, key: `chat:${name}`, items, at })

  describe('NEEDS YOU: one line per question, each with where to go', () => {
    test('a decision names the session that leads it, the D-id with its question, and the pane to press', () => {
      expect(needs(layoutOf(board, { holds: { '1016-schema': 'Which schema?' } }))).toEqual(['acme-gateway-80 | D14 Which schema? | ⏎ claude:1.0'])
    })

    test('without hold.md the question is the first clause of the note', () => {
      expect(needs()).toEqual(['acme-gateway-80 | D14 pick the schema | ⏎ claude:1.0'])
    })

    test('a lead that is live but outside tmux says so; a task with no live lead says that; neither can be pressed', () => {
      const outside = layoutOf(withLive(CREW, live('acme-gateway-80', '', '/home/user/Developer/acme-gateway', 'idle', 600)))
      const nobody = layoutOf(withLive(CREW))

      expect(needs(outside)).toEqual(['acme-gateway-80 | D14 pick the schema | not in tmux'])
      expect(needs(nobody)).toEqual(['schema | D14 pick the schema | no live lead'])
      expect([outside.needs[0]!.session, nobody.needs[0]!.session]).toEqual([undefined, undefined])
    })

    test('a session with several questions in its last reply is ONE line: the first item, or "N questions"', () => {
      const one = layoutOf(board, { chats: [chat('claude-config', ['merge #49'], NOW - 600_000)] })
      const three = layoutOf(board, { chats: [chat('claude-config', ['Register at hackathon', 'Run npm run wallet', 'Run npm run ask'], NOW - 600_000)] })

      expect(needs(one)).toEqual(['acme-gateway-80 | D14 pick the schema | ⏎ claude:1.0', 'claude-config | merge #49 | ⏎ claude:3.0'])
      expect(needs(three)[1]).toBe('claude-config | 3 questions ▸ | ⏎ claude:3.0')
      expect([one.total, three.total]).toEqual([2, 2])
    })

    test('a reply more than 2 hours old says how old; one just under does not', () => {
      const lines = (ageMs: number) => needs(layoutOf(board, { chats: [chat('claude-config', ['a', 'b'], NOW - ageMs)] }))[1]

      expect(lines(2 * H - 1000)).toBe('claude-config | 2 questions ▸ | ⏎ claude:3.0')
      expect(lines(2 * H + 60_000)).toBe('claude-config | 2 questions · 2h old ▸ | ⏎ claude:3.0')
      expect(lines(20 * H)).toBe('claude-config | 2 questions · 20h old ▸ | ⏎ claude:3.0')
    })

    test('the age is kept when the item is cut to fit', () => {
      const l = layoutOf(board, { chats: [chat('claude-config', ['Register at the hackathon portal and then paste the wallet address back to me'], NOW - 5 * H)] })

      expect(needs(l, 50)[1]).toBe('claude-config | Registe… · 5h old ▸ | ⏎ claude:3.0')
    })

    test('a reply over 24 hours old is not a line of NEEDS YOU and is not counted: its session goes to `older`', () => {
      const old = chat('claude-config', ['stale a', 'stale b', 'stale c'], NOW - 26 * H)
      const l = layoutOf(board, { chats: [old] })

      expect(needs(l)).toEqual(['acme-gateway-80 | D14 pick the schema | ⏎ claude:1.0'])
      expect(l.older.map(c => c.session.name)).toEqual(['claude-config'])
      expect(l.total).toBe(1)
      expect(olderText(l.older, 70)).toBe('older questions: claude-config')
    })

    test('splitChats: 24 hours is the line', () => {
      const a = chat('claude-config', ['x'], NOW - 24 * H + 1000)
      const b = chat('acme-gateway-80', ['y'], NOW - 24 * H)

      expect(splitChats([a, b], NOW)).toEqual({ fresh: [a], older: [b] })
    })

    test('review requests follow as PR lines: the repo session pane when there is one, else "on GitHub"', () => {
      const prs = [
        { repo: 'user/acme-gateway', number: 41, title: 'Add stats', url: 'u', updatedAt: NOW },
        { repo: 'user/widget', number: 7, title: 'Fix bug', url: 'u', updatedAt: NOW },
      ]
      const l = layoutOf(board, { requested: prs })

      expect(needs(l)).toEqual([
        'acme-gateway-80 | D14 pick the schema | ⏎ claude:1.0',
        'PR user/acme-gateway … | Add stats | ⏎ claude:1.0',
        'PR user/widget #7 | Fix bug | on GitHub',
      ])
      expect(l.total).toBe(3)
    })

    test('review requests beyond five are counted, not listed', () => {
      const prs = Array.from({ length: 7 }, (_, i) => ({ repo: 'o/r', number: i, title: 't', url: 'u', updatedAt: 0 }))
      const l = layoutOf(parseBoard(''), { requested: prs })

      expect([l.needs.length, l.morePrs, l.total]).toEqual([5, 2, 7])
    })

    test('every line is as wide as the pane: the pane column and the target column line up', () => {
      const l = layoutOf(board, { chats: [chat('claude-config', ['merge #49'], NOW - 600_000)] })

      expect(needParts(l.needs, 60).map(p => `${p.name}  ${p.msg}  ${p.go}`.length)).toEqual([60, 60])
    })
  })

  describe('NOW: one line per session that is busy or has open tasks', () => {
    test('a session lists its open tasks inline; a review without a decision is "verifying" and stale work is flagged', () => {
      expect(nowLines()).toEqual([
        'claude-config | ● working 4m | hq-acme-gateway running 4m',
        'acme-gateway-80 | ○ idle 10m | docs-refresh queued · noop-review-fixes verifying 15h ⚠ · stats #44 waiting on Sam',
        'other crew |  | bake-off running 1m',
      ])
    })

    test('the warning goes by the last status line, not by how long the state has lasted', () => {
      const fresh = { '1016-noop-review-fixes': NOW - 20 * 60_000, '1016-hq-acme-gateway': NOW - 7 * H }
      const l = layoutOf(board, { last: fresh })

      expect(nowParts(l.now, 120).map(p => p.lines.join(' ')).join(' / ')).toBe(
        'hq-acme-gateway running 4m ⚠ / docs-refresh queued · noop-review-fixes verifying 15h · stats #44 waiting on Sam / bake-off running 1m',
      )
    })

    test('a task in review that crew ls lists under RUNNING is "verifying" too, not "review"', () => {
      const b = withLive('RUNNING\n  1016-r  review  16h  ship  q  built\n', live('s', '', '/x/q', 'busy', 5))

      expect(nowLines(layoutOf(b))).toEqual(['s | ● working 5s | r verifying 16h ⚠'])
    })

    test('a queued task is never flagged, however old', () => {
      expect(nowLines().join('\n')).toContain('docs-refresh queued ·')
    })

    test('with no status time at all the task falls back to when it entered its state, then to its age', () => {
      const l = layoutOf(board, { ctx: { now: NOW, entered: { '1016-noop-review-fixes': NOW - 1 * H }, seen: emptySeen(), prs: {} } })

      expect(nowLines(l)[1]).toBe('acme-gateway-80 | ○ idle 10m | docs-refresh queued · noop-review-fixes verifying 15h · stats #44 waiting on Sam')
    })

    test('a question is a line of NEEDS YOU only, never of NOW; finished work is not here either', () => {
      expect(nowLines().join('\n')).not.toMatch(/schema|memory-tools|broken/)
    })

    test('a busy session with no task still has its line; an idle one with no task does not', () => {
      const l = layoutOf(withLive('', live('a', '', '/x/p', 'busy', 90), live('b', '', '/x/q', 'idle', 90)))

      expect(nowLines(l)).toEqual(['a | ● working 2m | '])
    })

    test('a session that waits for input shows its own state with ⏸', () => {
      const l = layoutOf(withLive('', live('a', '', '/x/p', 'waiting', 90)))

      expect(nowLines(l)).toEqual(['a | ⏸ waiting 2m | '])
    })

    test('tasks wrap onto an indented second line instead of being cut', () => {
      const parts = nowParts(layoutOf().now, 100)

      expect(parts[1]!.lines).toEqual(['docs-refresh queued · noop-review-fixes verifying 15h ⚠', `${' '.repeat(31)}stats #44 waiting on Sam`])
      expect(parts[1]!.name + parts[1]!.status).toHaveLength(31)
    })
  })

  describe('JUST FINISHED: each result once, newest first, with where to follow up', () => {
    const rows = (l = layoutOf(), width = 70) =>
      finishedParts(l.finished, width).map((p, i) => `${l.finished[i]!.mark === '✗' ? '✗' : l.finished[i]!.isNew ? '●' : ' '} ${p.name.trimEnd()} | ${p.verdict.trimEnd()} | ${p.lead}`)

    test('finished tasks appear here and nowhere else: not in the card of their session, not in NOW', () => {
      const l = layoutOf()

      expect(rows(l)).toEqual(['● memory-tools | pick: DIY FTS5 | → claude-config', '✗ broken | exit 1 | → claude-config'])
      expect(l.newCount).toBe(2)
      expect(nowLines(l).join('\n')).not.toContain('memory-tools')
    })

    test('the verdict is the first line of summary.md, else report.md, else the note', () => {
      const files = { '1016-memory-tools': { summary: '**Picked DIY FTS5.**\nmore', summaryAt: 1, report: null, reportAt: 0 } }

      expect(layoutOf(board, { files }).finished[0]!.verdict).toBe('Picked DIY FTS5.')
      expect(layoutOf().finished[0]!.verdict).toBe('pick: DIY FTS5')
    })

    test('seen rows lose their ● but stay; "Seen all" leaves none new', () => {
      const ctx = { now: NOW, entered: {}, seen: { all: NOW - 10 * 60_000, ids: {} }, prs: {} }
      const l = layoutOf(board, { ctx })

      expect(l.finished.map(f => [f.name, f.isNew])).toEqual([['memory-tools', true], ['broken', false]])
      expect(l.newCount).toBe(1)
    })

    test('a result nobody has opened is new for the whole 24 hours, not only the first 12', () => {
      const b = withLive('DONE\n  1016-x  done  13h  ship  user  ok\n', live('a', '', '/home/user', 'idle', 60))
      const l = layoutOf(b)

      expect([l.finished[0]!.isNew, l.newCount]).toEqual([true, 1])
      expect(layoutOf(b, { ctx: { now: NOW, entered: {}, seen: { all: NOW - 1 * H, ids: {} }, prs: {} } }).newCount).toBe(0)
      expect(layoutOf(b, { ctx: { now: NOW, entered: {}, seen: { all: 0, ids: { '1016-x': NOW - 1 * H } }, prs: {} } }).newCount).toBe(0)
    })

    test('at most five rows, the rest counted as earlier; the header counts every new one', () => {
      const many = Array.from({ length: 9 }, (_, i) => `  1016-t${i}  done  ${i + 1}h  ship  user  n${i}`)
      const l = layoutOf(withLive(['DONE', ...many, ''].join('\n'), live('a', '', '/home/user', 'idle', 60)))

      expect(l.finished.map(f => f.name)).toEqual(['t0', 't1', 't2', 't3', 't4'])
      expect(l.earlier).toBe(4)
      expect(l.newCount).toBe(9)
    })

    test('the verdict is cut at a word, not in the middle of one, and the lead column stays aligned', () => {
      const files = { '1016-memory-tools': { summary: 'HQ now shows chat questions in the pane with the session to open', summaryAt: 1, report: null, reportAt: 0 } }
      const l = layoutOf(board, { files })
      const parts = finishedParts(l.finished, 50)

      expect(parts[0]!.verdict.trimEnd()).toBe('HQ now shows chat…')
      expect(parts.map(p => `${p.name}  ${p.verdict}  ${p.lead}`.length)).toEqual([50, 50])
    })

    test('a task whose PR merged on GitHub is a row too, saying the lead has to log it', () => {
      const b = applyMeta(withLive(CREW, ACME_GATEWAY_LIVE), { '1016-stats': { lead: 'acme-gateway-80', repoPath: '/r' } })
      const prs = { '1016-stats': { key: '/r|#44', fetched: NOW, pr: { number: 44, state: 'MERGED', at: NOW - H } } }
      const l = layoutOf(b, { ctx: { now: NOW, entered: {}, seen: emptySeen(), prs } })

      const row = l.finished.find(f => f.id === '1016-stats')!

      expect([row.name, row.verdict, row.lead, row.detail, row.isNew]).toEqual(['stats #44', '#44 merged on GitHub — log landed?', 'acme-gateway-80', false, true])
      expect(nowLines(l).join('\n')).not.toContain('stats')
    })

    test('a failed task is marked ✗', () => {
      expect(layoutOf().finished.map(f => f.mark)).toEqual(['✓', '✗'])
    })
  })

  describe('idle sessions fold into one dim line', () => {
    test('live idle sessions with no task and no question: newest first, with their age', () => {
      const l = layoutOf()

      expect(l.idle).toEqual([{ name: 'beta', age: '1d' }])
      expect(idleText(l.idle, 70)).toBe('idle: beta 1d')
    })

    test('a session that has a question or a task is not idle', () => {
      const l = layoutOf(withLive(CREW, live('acme-gateway-80', 'claude:1.0', '/home/user/Developer/acme-gateway', 'idle', 600)))

      expect(l.idle).toEqual([])
    })

    test('the line is cut with a count of the rest', () => {
      const idle = [{ name: 'acme-gateway-review', age: '9m' }, { name: 'beta-explore-68', age: '2h' }, { name: 'another-one', age: '3h' }]

      expect(idleText(idle, 80)).toBe('idle: acme-gateway-review 9m · beta-explore-68 2h · another-one 3h')
      expect(idleText(idle, 56)).toBe('idle: acme-gateway-review 9m · beta-explore-68 2h · +1')
      expect(idleText(idle, 50)).toBe('idle: acme-gateway-review 9m · +2')
    })
  })

  describe('live top-level leads are never folded into the idle line', () => {
    const DONE = 'DONE\n  1017-hackathon-idea-scout  done  20h  scout  demo-hackathon  ideas ranked\n'
    const PLAIN = ['alpha', 'beta', 'gamma', 'delta'].map((n, i) => live(n, '', `/home/user/Developer/${n}-repo`, 'idle', 60 + i))
    const LEAD = live('developer-56', 'claude:5.0', '/home/user/Developer/demo-hackathon', 'idle', 3600)
    const crewOf = (links: { sub: string; parent: string }[] = []) =>
      markLeads(applyMeta(withLive(DONE, ...PLAIN, LEAD), { '1017-hackathon-idea-scout': { lead: 'developer-56' } }), links)

    test('a task-less idle lead is a row with its project, while four newer plain idle sessions overflow the width', () => {
      const l = layoutOf(crewOf())

      expect(nowLines(l)).toEqual(['developer-56 | ○ idle 1h | demo-hackathon'])
      // the plain sessions are newer, so they fill the line and the lead (idle 1h) would be the first one cut
      expect(idleText(l.idle, 36)).toBe('idle: alpha 1m · beta 1m · +2')
      expect(l.idle.map(i => i.name)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    })

    test('the same session as a plain idle session is folded: the idle line has it and NOW has no row', () => {
      const plain = layoutOf(applyMeta(withLive(DONE, ...PLAIN, LEAD), {}))

      expect(nowLines(plain)).toEqual([])
      expect(plain.idle.map(i => i.name)).toEqual(['alpha', 'beta', 'gamma', 'delta', 'developer-56'])
    })

    test('a sub-lead (the sub of a chain link) stays in the fold even when a task names it as lead', () => {
      const l = layoutOf(crewOf([{ sub: 'developer-56', parent: 'acme-gateway-lead' }]))

      expect(nowLines(l)).toEqual([])
      expect(l.idle.map(i => i.name)).toContain('developer-56')
    })

    test('a live lead whose only task is older than the board window still gets its NOW row', () => {
      // the board lists no task for developer-56 any more; its meta file under the crew folder still names it
      const l = layoutOf(markLeads(withLive('', LEAD), [], ['developer-56']))

      expect(nowLines(l)).toEqual(['developer-56 | ○ idle 1h | demo-hackathon'])
      expect(l.idle).toEqual([])
    })

    test('a session that only appears as the parent of a link is a lead', () => {
      const l = layoutOf(markLeads(withLive('', LEAD), [{ sub: 'developer-56/x', parent: 'developer-56' }]))

      expect(nowLines(l)).toEqual(['developer-56 | ○ idle 1h | demo-hackathon'])
      expect(l.idle).toEqual([])
    })

    test('a lead with a task shows the task, not the project', () => {
      const l = layoutOf(markLeads(applyMeta(withLive('RUNNING\n  1017-x  running  4m  ship  demo-hackathon  go\n', LEAD), { '1017-x': { lead: 'developer-56' } }), []))

      expect(nowLines(l)).toEqual(['developer-56 | ○ idle 1h | x running 4m'])
    })

    test('parseLink reads the sub and parent names of a link file; the last line of a key wins', () => {
      expect(parseLink('sub_name=old\nparent_name=acme-gateway-lead\nparent_sid=abc\nsub_name=acme-gateway-lead/live-pilot\n')).toEqual({ sub: 'acme-gateway-lead/live-pilot', parent: 'acme-gateway-lead' })
      expect(parseLink('')).toEqual({ sub: '', parent: '' })
    })
  })

  describe('nothing to show', () => {
    test('with nothing needing, running or finished the pane says all clear and how many sessions are idle', () => {
      const l = layoutOf(withLive('', live('a', '', '/x/p', 'idle', 60), live('b', '', '/x/q', 'idle', 90)))

      expect([l.needs, l.now, l.finished, l.older]).toEqual([[], [], [], []])
      expect(l.isClear).toBe(true)
      expect(clearText(l.idle.length)).toBe('All clear · 2 sessions idle')
      expect(clearText(1)).toBe('All clear · 1 session idle')
      expect(clearText(0)).toBe('All clear')
    })

    test('anything to show means not clear', () => {
      expect(layoutOf().isClear).toBe(false)
    })
  })
})

describe('narrow panes: columns shrink to a share of the width and nothing overflows', () => {
  const need = (name: string, go: string, msg = 'D14 pick the schema'): Parameters<typeof needParts>[0][number] => ({ kind: 'ask', key: `ask:${name}`, name, msg, suffix: '', go })
  const wide = (parts: { name: string; msg: string; go: string }) => cols(`${parts.name}  ${parts.msg}  ${parts.go}`)

  test('the target column becomes "⏎ 1.0" when the message would be squeezed, and every line is exactly the width', () => {
    const lines = [need('acme-gateway-80', '⏎ claude:1.0'), need('user-20', '⏎ claude:0.0')]

    expect(needParts(lines, 44).map(p => p.go)).toEqual(['⏎ claude:1.0', '⏎ claude:0.0'])
    const tight = needParts(lines, 38)
    expect(tight.map(p => p.go.trimEnd())).toEqual(['⏎ 1.0', '⏎ 0.0'])
    expect(tight.map(wide)).toEqual([38, 38])
  })

  test('at 20 columns the target moves to a second line and the name keeps at most two fifths of the width', () => {
    const [p] = needParts([need('Open PRs and project status', '⏎ claude:1.0')], 20)

    expect(wide(p!)).toBeLessThanOrEqual(20)
    expect(p!.name.trimEnd()).toBe('Open PR…')
    expect(p!.go).toBe('')
    expect(p!.below).toBe('⏎ claude:1.0')
  })

  test('without a squeeze nothing is on a second line', () => {
    expect(needParts([need('acme-gateway-80', '⏎ claude:1.0')], 70)[0]!.below).toBe('')
  })

  test('NOW continuation lines use a small indent when the name column is wide, and the first line then holds no tasks', () => {
    const entries = [{ name: 'Open PRs and project status', status: '● working 4m', tasks: ['docs-refresh queued', 'stats #44 waiting on Sam'] }]
    const [p] = nowParts(entries, 40)

    expect(p!.lines).toEqual(['', '    docs-refresh queued', '    stats #44 waiting on Sam'])
    expect(cols(p!.name + p!.status)).toBeLessThanOrEqual(40)
  })

  test('NOW keeps the aligned indent while there is room for the tasks', () => {
    const entries = [{ name: 'acme-gateway-80', status: '○ idle 10m', tasks: ['docs-refresh queued'] }]

    expect(nowParts(entries, 80)[0]!.lines).toEqual(['docs-refresh queued'])
  })

  test('JUST FINISHED drops the lead column when the verdict would have no room, and keeps every line within the width', () => {
    const rows = [{ id: 'a', mark: '✓' as const, isNew: true, name: 'hq-chat-needs', verdict: 'HQ now shows chat questions', lead: 'user-20', detail: true }]

    expect(finishedParts(rows, 60)[0]!.lead).toBe('→ user-20')
    const [tight] = finishedParts(rows, 26)

    expect(tight!.lead).toBe('')
    expect(cols(`${tight!.name}  ${tight!.verdict}  `)).toBeLessThanOrEqual(26)
  })
})

describe('display width: wide characters count 2, combining marks 0', () => {
  test('cols', () => {
    expect([cols('abc'), cols('漢字'), cols('🚀'), cols('e\u0301'), cols('한글'), cols('Ａ'), cols('⏎ ●→')]).toEqual([3, 4, 2, 1, 4, 2, 4])
  })

  test('padCols pads by columns and cutCols cuts without splitting a wide character', () => {
    expect(padCols('漢字', 6)).toBe('漢字  ')
    expect(cutCols('漢字漢', 5)).toBe('漢字')
    expect(cutCols('ab漢', 3)).toBe('ab')
  })

  test('fit and cutWords keep wide text within the width, ellipsis included', () => {
    expect(fit('漢字漢字漢字', 7)).toBe('漢字漢…')
    expect(cutWords('日本語 の テキスト です', 9)).toBe('日本語…')
    expect(cols(fit('🚀🚀🚀🚀', 5))).toBeLessThanOrEqual(5)
  })

  test('the columns of a line with wide names still add up to the width', () => {
    const lines = [{ kind: 'ask' as const, name: '日本語の名前', msg: 'D14 承認してください', suffix: '', go: '⏎ claude:1.0' }, { kind: 'ask' as const, name: 'user-20', msg: 'push?', suffix: '', go: '⏎ claude:0.0' }]

    expect(needParts(lines, 50).map(p => cols(`${p.name}  ${p.msg}  ${p.go}`))).toEqual([50, 50])
  })
})

describe('cutWords', () => {
  test('cuts on a word boundary and marks the cut', () => {
    expect(cutWords('Chain of command committed (7314077): /crew join', 30)).toBe('Chain of command committed…')
    expect(cutWords('short', 30)).toBe('short')
  })

  test('a word that ends exactly at the cut is kept', () => {
    expect(cutWords('abcd efgh ijkl', 10)).toBe('abcd efgh…')
  })

  test('with no space in the first half it cuts inside the word', () => {
    expect(cutWords('a verylongwordwithoutspaces', 12)).toBe('a verylongw…')
    expect(cutWords('abcdefghijkl', 5)).toBe('abcd…')
  })

  test('trailing punctuation does not hang before the ellipsis', () => {
    expect(cutWords('Done: shipped, then more words', 15)).toBe('Done: shipped…')
  })
})

describe('store values of an older shape never throw', () => {
  const task = { id: '1-q', state: 'held', age: '1m', repo: '-', note: 'x', decision: 'D3' }
  const board = { ...parseBoard(''), needsYou: [task] }

  test('needCount and summarize take chats that are not a list', () => {
    expect(needCount(board, 0, {} as never)).toBe(1)
    expect(needCount(board, 0, 'old' as never)).toBe(1)
    expect(summarize(board, 0, null as never)).toBe('⚠ 1 need you')
  })

  test('splitChats takes anything', () => {
    expect(splitChats(undefined as never, 1_800_000_000_000)).toEqual({ fresh: [], older: [] })
    expect(splitChats({ a: 1 } as never, 1_800_000_000_000)).toEqual({ fresh: [], older: [] })
  })

  test('asRecord keeps an object and turns anything else into an empty one; asList does the same for lists', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect([asRecord(null), asRecord([1]), asRecord('x'), asRecord(5)]).toEqual([{}, {}, {}, {}])
    expect(asList([1, 2])).toEqual([1, 2])
    expect([asList(null), asList({ a: 1 }), asList('x')]).toEqual([[], [], []])
  })
})

describe('RESULTS (24h)', () => {
  const H = 3_600_000
  const NOW = 1_000_000_000_000
  const ago = (hours: number) => NOW - hours * H
  const board = (crew: string) => parseBoard(crew)
  const CREW = [
    'NEEDS YOU',
    '  1016-broke   failed    1h  ship  user  exit 1',
    '  1016-wait    review    1h  ship  user  branch ready',
    'RUNNING',
    '  1016-going   running   5m  ship  user  working',
    'DONE',
    '  1016-new     done      2h  ship  acme-gateway  merged cleanly',
    '  1016-mid     landed    9h  scout user  landed',
    '  1016-old     done     30h  ship  user  too old',
    '  1016-drop    dropped   1h  ship  user  gone',
    '',
  ].join('\n')
  const entered = { '1016-broke': ago(1), '1016-new': ago(2), '1016-mid': ago(9), '1016-old': ago(30), '1016-drop': ago(1) }

  test('lists done, landed and failed tasks of the last 24 hours, newest first, and nothing else', () => {
    expect(resultItems(board(CREW), entered, NOW).map(r => `${r.mark} ${r.name} · ${r.project}`)).toEqual([
      '✗ broke · user',
      '✓ new · acme-gateway',
      '✓ mid · user',
    ])
  })

  test('a result dated in the future is left out beyond 5 minutes of clock skew, and kept within it', () => {
    const future = { ...entered, '1016-broke': NOW + 6 * 60_000, '1016-new': NOW + 4 * 60_000 }

    expect(resultItems(board(CREW), future, NOW).map(r => r.name)).toEqual(['new', 'mid'])
  })

  test('resultBody is summary.md, else report.md, else the note; an empty or blank file counts as missing', () => {
    const files = { summary: '  \n', summaryAt: 1, report: 'the report', reportAt: 1 }

    expect(resultBody(files, 'note')).toBe('the report')
    expect(resultBody({ ...files, summary: 'the summary' }, 'note')).toBe('the summary')
    expect(resultBody({ ...files, summary: '', report: '' }, 'note')).toBe('note')
    expect(resultBody(undefined, 'note')).toBe('note')
  })

  test('a task without a status time falls back to its crew ls age', () => {
    const items = resultItems(board(CREW), {}, NOW)

    expect(items.map(r => r.name)).toEqual(['broke', 'new', 'mid'])
  })

  test('shows at most 8 results, the 8 newest', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `  1016-t${i}  done  ${i + 1}h  ship  user  n${i}`)
    const items = resultItems(board(['DONE', ...rows, ''].join('\n')), {}, NOW)

    expect(items.map(r => r.name)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'])
  })

  test('no finished task in the window gives no results', () => {
    expect(resultItems(board('RUNNING\n  1016-going  running  5m  ship  user  working\n'), {}, NOW)).toEqual([])
  })

  test('plainLine takes the first non-empty line and strips markdown emphasis, headings and code ticks', () => {
    expect(plainLine('\n\n**Graphify beats `/understand`: 0 tokens.**\nBody')).toBe('Graphify beats /understand: 0 tokens.')
    expect(plainLine('## Report\ntext')).toBe('Report')
    expect(plainLine('   \n')).toBe('')
    expect(plainLine(null)).toBe('')
  })

  test('the verdict comes from summary.md, else the first line of report.md, else the last note', () => {
    const item = resultItems(board(CREW), entered, NOW).find(r => r.name === 'new')!
    const files = { summary: '**Won.**\nmore', summaryAt: 1, report: 'report first line\nx', reportAt: 1 }

    expect(resultVerdict(item, files)).toBe('Won.')
    expect(resultVerdict(item, { ...files, summary: null })).toBe('report first line')
    expect(resultVerdict(item, { ...files, summary: '  \n', report: null })).toBe('merged cleanly')
    expect(resultVerdict(item, undefined)).toBe('merged cleanly')
  })

  test('recentResults has no cap, so the pane can say how many more there are', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `  1016-t${i}  done  ${i + 1}h  ship  user  n${i}`)

    expect(recentResults(board(['DONE', ...rows, ''].join('\n')), {}, NOW)).toHaveLength(10)
  })

  test('wrapText wraps at word boundaries, keeps blank lines and caps the lines with a note', () => {
    expect(wrapText('one two three\n\nfour', 9, 10)).toEqual(['one two', 'three', '', 'four'])
    expect(wrapText('abcdefghijkl', 5, 10)).toEqual(['abcde', 'fghij', 'kl'])
    expect(wrapText('a\nb\nc\nd', 5, 3)).toEqual(['a', 'b', '… 2 more lines'])
  })
})

// --- the Needs-you block of a session's last reply ---

describe('parseNeeds: the items of a "Needs you" block', () => {
  test('inline text after the label, in the three bold forms and plain', () => {
    expect(parseNeeds('Done.\n\n**Needs you:** pick the schema')).toEqual(['pick the schema'])
    expect(parseNeeds('**Needs you**: pick the schema')).toEqual(['pick the schema'])
    expect(parseNeeds('Needs you: pick the schema')).toEqual(['pick the schema'])
    expect(parseNeeds('NEEDS YOU: pick the schema')).toEqual(['pick the schema'])
  })

  test('bullets and numbered lines under the label, markdown stripped', () => {
    const text = [
      '**Needs you:**',
      '- **PR #51:** review it, then install the `nebius` CLI',
      '* merge [#49](https://github.com/x/y/pull/49)',
      '1. first',
      '2) second',
    ].join('\n')

    expect(parseNeeds(text)).toEqual(['PR #51: review it, then install the nebius CLI', 'merge #49', 'first', 'second'])
  })

  test('the block stops at ---, a heading or **Next:**, and a block that starts later still counts', () => {
    expect(parseNeeds('**Needs you:**\n- a\n\n---\n- not an item')).toEqual(['a'])
    expect(parseNeeds('**Needs you:**\n- a\n## Details\n- not an item')).toEqual(['a'])
    expect(parseNeeds('**Needs you:**\n- a\n- b\n\n**Next:** when the sweep ends\n- not an item')).toEqual(['a', 'b'])
    expect(parseNeeds('intro\n- bullet before the label\n**Needs you:** x')).toEqual(['x'])
  })

  test('an inline lead-in that ends with a colon is dropped when bullets follow; an indented line continues its item', () => {
    expect(parseNeeds('**Needs you:** two things:\n- one\n  more of one\n  - sub-point\n- two')).toEqual(['one more of one sub-point', 'two'])
  })

  test('a label or items inside a fenced code block are not read', () => {
    expect(parseNeeds('Example:\n```\n**Needs you:** x\n```')).toEqual([])
    expect(parseNeeds('~~~md\nNeeds you:\n- x\n~~~\nafter')).toEqual([])
    expect(parseNeeds('**Needs you:**\n- a\n```\n- not an item\n```\n- b')).toEqual(['a', 'b'])
    expect(parseNeeds('```\nunclosed\n**Needs you:** x')).toEqual([])
  })

  test('bullets that all share an indent are siblings; only a deeper one is nested', () => {
    expect(parseNeeds('**Needs you:**\n  - approve deploy\n  - choose region')).toEqual(['approve deploy', 'choose region'])
    expect(parseNeeds('**Needs you:** lead-in:\n    1. one\n      - detail\n    2. two')).toEqual(['one detail', 'two'])
  })

  test('a block that starts with "nothing" or "none" is no item, even when prose follows', () => {
    expect(parseNeeds('**Needs you:** nothing yet. Once the review is done I\'ll ask you to merge.')).toEqual([])
    expect(parseNeeds('**Needs you:**\n- Nothing right now, the lead is verifying.')).toEqual([])
    expect(parseNeeds('**Needs you:** None. Everything is running.')).toEqual([])
    expect(parseNeeds('**Needs you:** — nothing')).toEqual([])
    expect(parseNeeds('**Needs you:**\n- None\n- merge #49')).toEqual(['merge #49'])
    expect(parseNeeds('**Needs you:** none needed; the lead is verifying')).toEqual([])
    expect(parseNeeds('**Needs you:**\n- Nothing pending.')).toEqual([])
    expect(parseNeeds('**Needs you:** nothingness is not a word we match... merge #49')).toEqual(['nothingness is not a word we match... merge #49'])
  })

  test('a real request that merely starts with "None of" or "Nothing but" is kept', () => {
    const request = 'None of these options fit our budget; please approve the cheaper plan.'

    expect(parseNeeds(`**Needs you:** ${request}`)).toEqual([request])
    expect(parseNeeds('**Needs you:**\n- Nothing but the cheaper plan fits: approve it?')).toEqual(['Nothing but the cheaper plan fits: approve it?'])
  })

  test('"nothing" is not an item, and a reply without the label has none', () => {
    expect(parseNeeds('**Needs you:** nothing right now.')).toEqual([])
    expect(parseNeeds('**Needs you:**\n- None')).toEqual([])
    expect(parseNeeds('We discussed what needs you to decide later.')).toEqual([])
  })

  test('items are one line each: whitespace collapsed, control characters gone, and the text kept whole', () => {
    expect(parseNeeds('**Needs you:** a\u001b[31m   b\tc')).toEqual(['a [31m b c'])
    expect(parseNeeds(`**Needs you:** ${'x'.repeat(500)}`)[0]).toHaveLength(400)
  })
})

describe('parseLastReply: the last assistant message with text, in the tail of a transcript', () => {
  const lines = (...records: unknown[]) => records.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
  const reply = (text: string, timestamp = '2026-10-16T13:12:54.933Z') => ({ type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const toolOnly = { type: 'assistant', timestamp: '2026-10-16T13:13:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }
  const thinking = { type: 'assistant', timestamp: '2026-10-16T13:13:01.000Z', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }
  const human = (text: string) => ({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } })
  const AT = Date.parse('2026-10-16T13:12:54.933Z')

  test('takes the Needs-you items of the last reply, with its time', () => {
    const text = lines(human('go'), reply('older\n**Needs you:** old thing', '2026-10-16T12:00:00.000Z'), reply('done\n\n**Needs you:**\n- merge #49\n- review #51'))

    expect(parseLastReply(text, false)).toEqual({ items: ['merge #49', 'review #51'], at: AT })
  })

  test('skips messages with only tool calls or thinking: the reply before them is the last one with text', () => {
    const text = lines(reply('**Needs you:** approve the deploy'), toolOnly, thinking, { type: 'attachment' })

    expect(parseLastReply(text, false)).toEqual({ items: ['approve the deploy'], at: AT })
  })

  test('a real prompt after the reply means the user answered: no items', () => {
    const text = lines(reply('**Needs you:** approve the deploy'), toolOnly, human('yes, go'))

    expect(parseLastReply(text, false)).toEqual({ items: [], at: 0 })
  })

  test('tool results, task notifications, shell echoes, slash commands and subagent records after the reply are not an answer and not the reply', () => {
    const text = lines(
      reply('**Needs you:** approve the deploy'),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
      { type: 'user', origin: { kind: 'task-notification', producer: 'session-task' }, message: { content: '<task-notification>x' } },
      { type: 'user', message: { content: '<bash-input>ls</bash-input>' } },
      { type: 'user', isMeta: true, message: { content: '<local-command-caveat>Caveat: x</local-command-caveat>' } },
      { type: 'user', message: { content: '/model sonnet' } },
      { type: 'user', isSidechain: true, origin: { kind: 'human' }, message: { content: 'a subagent prompt' } },
      { ...reply('**Needs you:** a subagent asks', '2026-10-16T14:00:00.000Z'), isSidechain: true },
    )

    expect(parseLastReply(text, false)).toEqual({ items: ['approve the deploy'], at: AT })
  })

  test('an answer the user gave through HQ counts, as does a prompt with no origin; other peers do not', () => {
    const peer = (body: string) => ({ type: 'user', isMeta: true, origin: { kind: 'peer', name: 'hq', body }, message: { content: `Another Claude session sent a message:\n${body}` } })

    expect(parseLastReply(lines(reply('**Needs you:** x'), peer('From HQ (user): D3 yes')), false)).toEqual({ items: [], at: 0 })
    expect(parseLastReply(lines(reply('**Needs you:** x'), peer('status please')), false)?.items).toEqual(['x'])
    expect(parseLastReply(lines(reply('**Needs you:** x'), { type: 'user', message: { content: 'plain typed words' } }), false)?.items).toEqual([])
  })

  test('a reply without the label gives no items, and does not fall back to an older reply that had one', () => {
    const text = lines(reply('**Needs you:** old', '2026-10-16T12:00:00.000Z'), reply('all done, nothing pending'))

    expect(parseLastReply(text, false)).toEqual({ items: [], at: AT })
  })

  test('with no reply and no prompt in the tail it is null, so the reader reads more', () => {
    expect(parseLastReply(lines(toolOnly, { type: 'attachment' }), false)).toBeNull()
    expect(parseLastReply('', false)).toBeNull()
  })

  test('the first line of a tail that starts mid-file is cut and ignored; lines that are not JSON are skipped', () => {
    const cut = JSON.stringify(human('the only prompt'))

    expect(parseLastReply(cut + '\n' + lines(reply('**Needs you:** x')), true)?.items).toEqual(['x'])
    expect(parseLastReply(cut + '\n' + lines(reply('**Needs you:** x')), false)?.items).toEqual(['x'])
    expect(parseLastReply('not json\n{"type":"user"\n' + lines(reply('**Needs you:** y')), false)?.items).toEqual(['y'])
  })
})

describe('chatNeeds: what the board shows of those items', () => {
  const NOW = 1_800_000_000_000
  const CREW = 'NEEDS YOU\n  1016-schema  held  1h  ship  acme-gateway  D14 · pick the schema\n'
  const board = withLive(
    CREW,
    live('Open PRs and project status', 'claude:1.0', '/home/user/Developer/acme-gateway', 'idle', 600) + '\t/t/a.jsonl',
    live('acme-gateway-0c', 'claude:1.1', '/home/user/Developer/acme-gateway', 'idle', 900) + '\t/t/b.jsonl',
    live('hq', 'claude:3.0', '/home/user', 'idle', 10) + '\t/t/hq.jsonl',
    live('no-transcript', '', '/x/y', 'idle', 10),
  )
  const entry = (items: string[], at = NOW) => ({ items, at, size: 1, mtime: 1 })
  const chats = {
    '/t/a.jsonl': entry(['merge #49', 'review #51 (D14)', 'install nebius'], NOW - 60_000),
    '/t/b.jsonl': entry(['pick a name'], NOW),
    '/t/hq.jsonl': entry(['hq item']),
  }

  test('an item that names an open decision is dropped (the band already shows that decision); the rest stay, newest reply first', () => {
    expect(chatNeeds(board, chats, {}).map(c => [c.session.name, c.items])).toEqual([
      ['acme-gateway-0c', ['pick a name']],
      ['Open PRs and project status', ['merge #49', 'install nebius']],
    ])
  })

  test('a D-id that is not open does not cover an item; a session whose items are all covered shows nothing', () => {
    const closed = { '/t/a.jsonl': entry(['review (D13)', 'done D14']) }

    expect(chatNeeds(board, closed, {}).map(c => c.items)).toEqual([['review (D13)']])
  })

  test('a dismissed session stays hidden until it writes a newer reply', () => {
    const key = chatNeeds(board, chats, {})[1]!.key
    const dismissed = dismissChat({}, key, NOW - 60_000)

    expect(key).toBe('chat:Open PRs and project status')
    expect(dismissed).toEqual({ 'chat:Open PRs and project status': NOW - 60_000 })
    expect(chatNeeds(board, chats, dismissed).map(c => c.session.name)).toEqual(['acme-gateway-0c'])
    expect(chatNeeds(board, { ...chats, '/t/a.jsonl': entry(['again'], NOW + 1) }, dismissed).map(c => c.items)).toEqual([['again'], ['pick a name']])
  })

  test('a dismissal is dropped once its session wrote a newer reply or is gone, and kept while its transcript is unread', () => {
    const dismissed = { 'chat:Open PRs and project status': NOW - 60_000, 'chat:acme-gateway-0c': NOW, 'chat:gone': NOW }

    expect(pruneDismissed(board, chats, dismissed)).toEqual({ 'chat:Open PRs and project status': NOW - 60_000, 'chat:acme-gateway-0c': NOW })
    expect(pruneDismissed(board, { '/t/a.jsonl': entry(['again'], NOW + 1) }, dismissed)).toEqual({ 'chat:acme-gateway-0c': NOW })
    expect(pruneDismissed(parseBoard(''), {}, dismissed)).toEqual(dismissed)
  })

  test('parseDismissed keeps only numbers from the store', () => {
    expect(parseDismissed({ 'chat:a': 5, 'chat:b': 'x', c: null })).toEqual({ 'chat:a': 5 })
    expect(parseDismissed('nonsense')).toEqual({})
    expect(parseDismissed(undefined)).toEqual({})
  })

  test('a session without a read transcript, and the hq session, have no items', () => {
    expect(chatNeeds(board, {}, {})).toEqual([])
  })

  test('items are cut to 100 characters', () => {
    const long = { '/t/b.jsonl': entry(['x'.repeat(300)]) }

    expect(chatNeeds(board, long, {})[0]!.items[0]).toBe('x'.repeat(99) + '…')
  })

  test('needCount and summarize count a session once, however many items it left: the band and the pane agree', () => {
    const needs = chatNeeds(board, chats, {})

    expect(needCount(board, 0, needs)).toBe(1 + 2)
    expect(summarize(board, 0, needs)).toBe('⚠ 3 need you · 3 sessions live')
    expect(summarize(parseBoard(''), 0, chatNeeds(board, { '/t/b.jsonl': entry(['x', 'y']) }, {}))).toBe('⚠ 1 need you')
  })
})

describe('reading transcripts only when they changed', () => {
  test('parseStat reads size and mtime per path and drops anything that is not a transcript path', () => {
    expect(parseStat('/h/.claude/projects/-p/a.jsonl|1200|1760000000\n/etc/passwd|1|2\n/h/b.jsonl|x|3\n')).toEqual({
      '/h/.claude/projects/-p/a.jsonl': { size: 1200, mtime: 1_760_000_000 },
    })
  })

  test('only a transcript with no cached read, or another size or mtime, is due', () => {
    const stats = { '/a.jsonl': { size: 10, mtime: 5 }, '/b.jsonl': { size: 10, mtime: 5 }, '/c.jsonl': { size: 10, mtime: 5 }, '/d.jsonl': { size: 11, mtime: 5 } }
    const cache = {
      '/a.jsonl': { items: [], at: 0, size: 10, mtime: 5 },
      '/b.jsonl': { items: [], at: 0, size: 10, mtime: 6 },
      '/d.jsonl': { items: [], at: 0, size: 10, mtime: 5 },
    }

    expect(chatsDue(stats, cache)).toEqual(['/b.jsonl', '/c.jsonl', '/d.jsonl'])
  })
})

describe('a NEEDS YOU line opened: its page', () => {
  const NOW = Date.parse('2026-10-16T12:00:00Z')
  const LONG =
    'Review fleet: not good to go. Start A fixes now as crew tasks (2 trim, 3 metrics, 4 carriage) and draft a note to Sam for fixes 1/6/8?\nThe $50 validation sweep waits for a separate go after fixes land.'
  const CREW = [
    'NEEDS YOU',
    '  1016-review-fleet            review      1h  scout acme-gateway   D1 · report verified; waiting on go for fix tasks',
    '  1016-held-one                held        2h  ship  acme-gateway   waiting',
    '',
  ].join('\n')
  const board = applyMeta(withLive(CREW, live('acme-gateway-lead', 'claude:1.0', '/home/user/Developer/acme-gateway', 'busy', 60)), {
    '1016-review-fleet': { lead: 'acme-gateway-lead' },
  })
  const ctx = { now: NOW, entered: {}, seen: emptySeen(), prs: {} }
  const layout = (over: Partial<Parameters<typeof focusLayout>[0]> = {}) => focusLayout({ board, plan: classify(board, ctx), ctx, ...over })
  const pageOf = (key: string, over: Partial<Parameters<typeof needDetail>[1]> = {}, lay = layout()) => needDetail(lay.needs.find(n => n.key === key)!, { board, now: NOW, ...over })

  test('a long D-id question shows its whole text, not the cut line of the band', () => {
    const lay = layout({ questions: { '1016-review-fleet': LONG }, holds: { '1016-review-fleet': 'Review fleet: not good to go. Start A fixes now as crew tasks (2 trim, 3 metrics, 4 carriage) and draft a note to Sam for fixes 1/6/8?' } })
    const page = pageOf('ask:1016-review-fleet', { questions: { '1016-review-fleet': LONG } }, lay)

    expect(page.text).toBe(LONG)
    expect(page.title).toBe('D1 · review-fleet')
    expect(page.meta).toEqual(['task 1016-review-fleet · review 1h', 'lead acme-gateway-lead · project acme-gateway'])
    expect(page.answer).toBe('D1')
    expect(page.go?.target).toBe('claude:1.0')
    expect(page.dismiss).toBeUndefined()
  })

  test('the line of a question that has more behind it ends with the mark; one that is all there does not', () => {
    const cut = needParts(layout({ questions: { '1016-review-fleet': LONG }, holds: { '1016-review-fleet': 'Start A fixes now?' } }).needs, 70)
    const whole = needParts(layout({ questions: { '1016-review-fleet': 'Start A fixes now?' }, holds: { '1016-review-fleet': 'Start A fixes now?' } }).needs, 70)

    expect(cut[0]!.msg.trimEnd()).toBe('D1 Start A fixes now? ▸')
    expect(whole[0]!.msg.trimEnd()).toBe('D1 Start A fixes now?')
  })

  test('a held task without a D-id is answered by its task id', () => {
    expect(pageOf('ask:1016-held-one').answer).toBe('1016-held-one')
  })

  test('the latest note and the summary come as context; a missing summary falls back to report.md, and with neither only the note shows', () => {
    const notes = { '1016-review-fleet': 'report verified; waiting on go for fix tasks (all 6 blockers settled)' }
    const withSummary = pageOf('ask:1016-review-fleet', { notes, questions: { '1016-review-fleet': LONG }, files: { '1016-review-fleet': { summary: '# Review fleet\nnot good to go', summaryAt: 1, report: 'R', reportAt: 1 } } })
    const withReport = pageOf('ask:1016-review-fleet', { notes, files: { '1016-review-fleet': { summary: ' \n', summaryAt: 1, report: '# Report\nfindings', reportAt: 1 } } })
    const neither = pageOf('ask:1016-review-fleet', { notes })

    expect(withSummary.context).toEqual([
      { label: 'Latest note', text: 'report verified; waiting on go for fix tasks (all 6 blockers settled)' },
      { label: 'Summary', text: '# Review fleet\nnot good to go' },
    ])
    expect(withReport.context.map(c => c.label)).toEqual(['Latest note', 'Report'])
    expect(neither.context).toEqual([{ label: 'Latest note', text: 'report verified; waiting on go for fix tasks (all 6 blockers settled)' }])
  })

  test('without ask.md the page shows the note crew ls gave, and does not repeat it as context', () => {
    const page = pageOf('ask:1016-review-fleet', { notes: { '1016-review-fleet': 'report verified; waiting on go for fix tasks' } })

    expect(page.text).toBe('report verified; waiting on go for fix tasks')
    expect(page.context).toEqual([])
  })

  describe('the Diff action', () => {
    const WORKTREE = '/home/user/Developer/acme-gateway/.claude/worktrees/crew-1016-review-fleet'
    const pageWith = (meta: Parameters<typeof applyMeta>[1][string], key = 'ask:1016-review-fleet') => {
      const b = applyMeta(board, { '1016-review-fleet': { lead: 'acme-gateway-lead', ...meta }, '1016-held-one': { lead: 'acme-gateway-lead', ...meta } })

      return needDetail(focusLayout({ board: b, plan: classify(b, ctx), ctx }).needs.find(n => n.key === key)!, { board: b, now: NOW })
    }

    test('canDiff is true only for a task in review that has a branch or a worktree', () => {
      const task = { id: 'a', state: 'review', age: '1m', repo: 'x', note: '' }

      expect(canDiff({ ...task, branch: 'crew/a' })).toBe(true)
      expect(canDiff({ ...task, worktree: WORKTREE })).toBe(true)
      expect(canDiff(task)).toBe(false)
      expect(canDiff({ ...task, state: 'held', branch: 'crew/a' })).toBe(false)
      expect(canDiff({ ...task, state: 'running', worktree: WORKTREE })).toBe(false)
    })

    test('the page of a review task offers Diff when its meta has a branch, or only a worktree', () => {
      expect(pageWith({ branch: 'crew/1016-review-fleet' }).diff).toBe('1016-review-fleet')
      expect(pageWith({ worktree: WORKTREE }).diff).toBe('1016-review-fleet')
    })

    test('no Diff on the page of a review task without branch or worktree, of a held task, or of a chat reply', () => {
      expect(pageWith({}).diff).toBeUndefined()
      expect(pageWith({ branch: 'crew/x' }, 'ask:1016-held-one').diff).toBeUndefined()
      expect(pageWith({ branch: 'crew/x' }, 'ask:1016-held-one').answer).toBe('1016-held-one')
    })

    test('the footer names `crew show` and, with Diff, `crew diff <id> --focus`', () => {
      expect(needFooter(pageWith({}))).toEqual(['crew show 1016-review-fleet'])
      expect(needFooter(pageWith({ branch: 'crew/x' }))).toEqual(['crew show 1016-review-fleet', 'crew diff 1016-review-fleet --focus'])
      expect(needFooter({ key: 'chat:x', kind: 'chat', title: '', meta: [], text: '', context: [] })).toEqual([])
    })

    test('the row of a review task with a branch is cut with the more-mark exactly as one without', () => {
      const rows = (meta: Parameters<typeof applyMeta>[1][string]) => {
        const b = applyMeta(board, { '1016-review-fleet': { lead: 'acme-gateway-lead', ...meta } })

        return needParts(focusLayout({ board: b, plan: classify(b, ctx), ctx, questions: { '1016-review-fleet': LONG }, holds: { '1016-review-fleet': 'Start A fixes now?' } }).needs, 70)[0]!
      }

      expect(rows({ branch: 'crew/x', worktree: WORKTREE })).toEqual(rows({}))
      expect(rows({ branch: 'crew/x' }).msg.trimEnd()).toBe('D1 Start A fixes now? ▸')
    })

    test('diffArgs is `diff <id> --focus`, one argv entry each', () => {
      expect(diffArgs('1016-review-fleet')).toEqual(['diff', '1016-review-fleet', '--focus'])
    })

    test('diffFeedback is the stdout line on success and the stderr on failure, with the exit code when stderr is empty', () => {
      expect(diffFeedback({ exitCode: 0, stdout: 'diff: opened a (reused pane %7)\n', stderr: '' }, 'a')).toBe('diff: opened a (reused pane %7)')
      expect(diffFeedback({ exitCode: 0, stdout: '', stderr: '' }, 'a')).toBe('diff a: opened')
      expect(diffFeedback({ exitCode: 4, stdout: '', stderr: 'crew diff: diffview.nvim missing\n' }, 'a')).toBe('diff failed: crew diff: diffview.nvim missing')
      expect(diffFeedback({ exitCode: 3, stdout: 'partial\n', stderr: '' }, 'a')).toBe('diff failed: crew diff exited 3')
    })
  })

  test('a chat reply lists every item, can be dismissed with the reply time, and cannot be answered', () => {
    const lead = board.elsewhere.find(s => s.name === 'acme-gateway-lead')!
    const chats = [{ session: lead, key: 'chat:acme-gateway-lead', items: ['merge #49', 'review PR #51'], at: NOW - 600_000 }]
    const page = pageOf('chat:acme-gateway-lead', { chats }, layout({ chats }))

    expect(page.text).toBe('- merge #49\n- review PR #51')
    expect(page.meta).toEqual(['session acme-gateway-lead · replied 10m ago'])
    expect(page.dismiss).toEqual({ key: 'chat:acme-gateway-lead', at: NOW - 600_000 })
    expect(page.answer).toBeUndefined()
  })

  test('a review request gives its title and its URL, and no answer; an address that is not https is not offered', () => {
    const pr = { repo: 'user/acme-gateway', number: 41, title: 'Add the stats page', url: 'https://github.com/user/acme-gateway/pull/41', updatedAt: NOW - 3_600_000 }
    const requested = [pr, { ...pr, number: 42, url: 'javascript:alert(1)' }]
    const lay = layout({ requested })
    const page = pageOf('pr:user/acme-gateway#41', { requested }, lay)

    expect(page.text).toBe('Add the stats page')
    expect(page.url).toBe('https://github.com/user/acme-gateway/pull/41')
    expect(page.meta).toEqual(['review requested · updated 1h ago'])
    expect(page.answer).toBeUndefined()
    expect(pageOf('pr:user/acme-gateway#42', { requested }, lay).url).toBeUndefined()
  })

  test('a chat item of 199 characters opens whole; only the collapsed row and the band cut it at 100', () => {
    const lead = live('acme-gateway-lead', 'claude:1.0', '/home/user/Developer/acme-gateway', 'busy', 60) + '\t/t/a.jsonl'
    const b = withLive(CREW, lead)
    const long = `Approve the migration plan ${'x'.repeat(171)}?`
    const chats = chatNeeds(b, { '/t/a.jsonl': { items: [long], at: NOW - 600_000, size: 1, mtime: 1 } }, {})
    const lay = focusLayout({ board: b, plan: classify(b, ctx), ctx, chats })
    const page = needDetail(lay.needs.find(n => n.key === 'chat:acme-gateway-lead')!, { board: b, now: NOW, chats })

    expect(long.length).toBe(199)
    expect(chats[0]!.items[0]!.length).toBe(100)
    expect(page.text).toBe(long)
  })

  test('parseStatusNote is the note of the last line of a status file', () => {
    expect(parseStatusNote('2026-10-16T15:06:48Z\trunning\tverifying\n2026-10-16T15:21:34Z\treview\treport verified; waiting\n')).toBe('report verified; waiting')
    expect(parseStatusNote('')).toBe('')
  })

  test('relayPrompt tells HQ to message the lead with the answer, or to say nobody was told', () => {
    expect(relayPrompt({ id: '1016-review-fleet', decision: 'D1', lead: 'acme-gateway-lead' }, 'yes, start A')).toBe(
      'The user answered D1 in the HQ pane; crew answer has recorded it, so do not call hq_answer. SendMessage acme-gateway-lead exactly:\nFrom HQ (user): D1 answered. Answer: yes, start A\nThen confirm in one line.',
    )
    expect(relayPrompt({ id: '1016-held-one', lead: null }, 'go')).toBe(
      'The user answered 1016-held-one in the HQ pane; crew answer has recorded it, so do not call hq_answer. No live session leads that task: tell the user the answer is recorded and nobody was told.',
    )
    expect(relayPrompt({ id: 'x', decision: 'D2', lead: 'a', leadGuessed: true }, 'y')).toContain('only a guess by project')
  })
})

describe('stripMarks: bold stars and code ticks go; underscores never do, so __init__ and a__b stay whole', () => {
  test('**bold** and `code` ticks are removed', () => {
    expect(stripMarks('**done** and `x`')).toBe('done and x')
  })

  test('__init__ and a__b stay whole, inside a code span or not', () => {
    expect(stripMarks('Approve __init__ and `a__b`?')).toBe('Approve __init__ and a__b?')
    expect(stripMarks('rename a__b to c__d')).toBe('rename a__b to c__d')
  })
})

describe('starting a top-level lead', () => {
  const CREW = '/home/test/.claude/bin/crew'
  const form = { repo: '/home/test/Developer/app', name: 'fix-bug', text: 'Fix the bug.', model: '' }

  test('spawnArgv is one argument per value, the message after -- with its quotes, $( ) and newline intact', () => {
    const text = 'say "hi" $(rm -rf x) `y`; it\'s\nline 2'

    expect(spawnArgv(CREW, { ...form, text, model: 'sonnet' }, '/home/test')).toEqual({
      argv: [CREW, 'spawn', '--top', 'fix-bug', '--repo', '/home/test/Developer/app', '--model', 'sonnet', '--', text],
    })
    expect(spawnArgv(CREW, form, '/home/test')).toEqual({ argv: [CREW, 'spawn', '--top', 'fix-bug', '--repo', '/home/test/Developer/app', '--', 'Fix the bug.'] })
    expect(spawnArgv(CREW, { ...form, repo: '~/Developer/app', text: '- a list' }, '/home/test')).toEqual({
      argv: [CREW, 'spawn', '--top', 'fix-bug', '--repo', '/home/test/Developer/app', '--', '- a list'],
    })
  })

  test('spawnArgv refuses a bad name, a relative or empty repo, an empty or huge message and a model that looks like a flag', () => {
    expect(spawnArgv(CREW, { ...form, name: 'Fix Bug' }, '/h')).toEqual({ error: 'name: 2-41 lowercase letters, digits, dashes' })
    expect(spawnArgv(CREW, { ...form, name: 'a' }, '/h')).toEqual({ error: 'name: 2-41 lowercase letters, digits, dashes' })
    expect(spawnArgv(CREW, { ...form, name: '-ab' }, '/h')).toEqual({ error: 'name: 2-41 lowercase letters, digits, dashes' })
    expect(spawnArgv(CREW, { ...form, repo: '' }, '/h')).toEqual({ error: 'pick a repo or type its path' })
    expect(spawnArgv(CREW, { ...form, repo: 'app' }, '/h')).toEqual({ error: 'the repo must be an absolute path (or start with ~/)' })
    expect(spawnArgv(CREW, { ...form, text: '  \n ' }, '/h')).toEqual({ error: 'the first message is empty' })
    expect(spawnArgv(CREW, { ...form, text: 'x'.repeat(8001) }, '/h')).toEqual({ error: 'the first message is longer than 8000 characters' })
    expect(spawnArgv(CREW, { ...form, model: '--dangerous' }, '/h')).toEqual({ error: "bad model '--dangerous'" })
  })

  test('knownRepos lists live session folders and task repos once, never the home folder, ~/.claude or a .claude worktree', () => {
    const row = (cwd: string) => `s\tclaude:1.0\tw\t${cwd}\tidle\t5\t\n`
    const live = parseLive(row('/home/test/Developer/app') + row('/home/test') + row('/home/test/.claude') + row('/home/test/Developer/app/.claude/worktrees/x') + row('?') + row('/home/test/Developer/zed/'))
    const b = { ...emptyBoard(), running: [{ id: '1-a', state: 'running', age: '1m', repo: 'api', note: '', repoPath: '/home/test/Developer/api' }, { id: '1-b', state: 'running', age: '1m', repo: 'app', note: '', repoPath: '/home/test/Developer/app' }] }

    expect(knownRepos(live, b, '/home/test')).toEqual(['/home/test/Developer/api', '/home/test/Developer/app', '/home/test/Developer/zed'])
    expect(knownRepos([], null, '/home/test')).toEqual([])
  })

  test('spawnOutcome reads the window, a queued spawn, and the reason of a refusal', () => {
    expect(spawnOutcome({ exitCode: 0, stdout: 'id=1017-fix-bug\nwindow=claude:fix-bug\nchild=fix-bug\n', stderr: '' })).toEqual({ ok: true, id: '1017-fix-bug', window: 'claude:fix-bug', queued: false })
    expect(spawnOutcome({ exitCode: 0, stdout: 'id=1017-fix-bug\nqueued: spawn waiting for RAM, not launched (mem low). Start it with: crew spawn --resume 1017-fix-bug\n', stderr: '' })).toEqual({ ok: true, id: '1017-fix-bug', window: '', queued: true })
    expect(spawnOutcome({ exitCode: 2, stdout: '', stderr: 'crew: spawn refused: 5 live top-level leads started with spawn --top (max 5). Close one first.\n' })).toEqual({
      ok: false,
      error: 'spawn refused: 5 live top-level leads started with spawn --top (max 5). Close one first.',
    })
  })
})

describe('feature owners and talk threads on the lead\'s card', () => {
  const NOW = Date.parse('2026-10-16T12:00:00Z')
  const OWNER = [
    'feature=billing',
    'repo=/home/test/Developer/app',
    'path=src/billing/**',
    'path=docs/billing/',
    'sid=0a1b',
    'name=billing-owner',
    'lead=acme-gateway-80',
    'lead_sid=ff00',
    'state=asleep',
    'created=2026-10-16T08:00:00Z',
    'slept_at=2026-10-16T09:00:00Z',
    '',
  ].join('\n')
  const entry = (feature: string, state: string, lead: string, note = '', sleptAt = '2026-10-16T09:00:00Z') => ({
    ...parseOwner(OWNER),
    feature,
    state,
    lead,
    sleptAt,
    note,
  })
  const meta = (a: string, b: string, topic: string, state: string, turns: number, lead = 'acme-gateway-80') =>
    parseTalk(`a=${a}\nb=${b}\ntopic=${topic}\nlead=${lead}\nlead_sid=ff00\ncap=6\nturns=${turns}\nstate=${state}\n`)

  test('parseOwner reads both path= globs, the single keys, and lets the last line of a key win', () => {
    expect(parseOwner(OWNER + 'state=awake\nwoken_at=2026-10-16T10:00:00Z\n')).toEqual({
      feature: 'billing',
      repo: '/home/test/Developer/app',
      paths: ['src/billing/**', 'docs/billing/'],
      sid: '0a1b',
      name: 'billing-owner',
      lead: 'acme-gateway-80',
      leadSid: 'ff00',
      state: 'awake',
      sleptAt: '2026-10-16T09:00:00Z',
      wokenAt: '2026-10-16T10:00:00Z',
      window: '',
      task: '',
    })
  })

  test('lastNote is the last non-empty line that is not a heading', () => {
    expect(lastNote('# Billing\n\nInvoices are rounded per line.\nRetry queue owns idempotency.\n\n## Open\n  \n')).toBe('Retry queue owns idempotency.')
    expect(lastNote('# only a heading\n')).toBe('')
  })

  test('ownerRows shows only the asleep owner of the lead, as "☾ feature · asleep age · note"', () => {
    const owners = [entry('billing', 'asleep', 'acme-gateway-80', 'Retry queue owns idempotency.'), entry('search', 'awake', 'acme-gateway-80', 'indexing'), entry('mail', 'asleep', 'claude-config', 'x')]

    expect(ownerRows(owners, NOW, 'acme-gateway-80', ['acme-gateway-80', 'claude-config'])).toEqual([{ feature: 'billing', text: '☾ billing · asleep 3h · Retry queue owns idempotency.' }])
  })

  test('ownerRows leaves the note out when there is none, and the age out when slept_at is missing', () => {
    expect(ownerRows([entry('billing', 'asleep', 'acme-gateway-80', '', '2026-10-14T12:00:00Z'), entry('auth', 'asleep', 'acme-gateway-80', 'ok', '')], NOW, 'acme-gateway-80')).toEqual([
      { feature: 'auth', text: '☾ auth · asleep · ok' },
      { feature: 'billing', text: '☾ billing · asleep 2d' },
    ])
  })

  test('an owner whose lead is not live lands in the other bucket, not under a live lead', () => {
    const owners = [entry('billing', 'asleep', 'gone-lead', 'n'), entry('mail', 'asleep', 'acme-gateway-80', 'm')]
    const live = ['acme-gateway-80']

    expect(ownerRows(owners, NOW, null, live)).toEqual([{ feature: 'billing', text: '☾ billing · asleep 3h · n' }])
    expect(ownerRows(owners, NOW, 'acme-gateway-80', live).map(r => r.feature)).toEqual(['mail'])
  })

  test('talkRows shows open and capped threads of the lead and no closed one; a capped one says so', () => {
    const talks = [
      meta('billing', 'search', 'invoice ids', 'open', 2),
      meta('auth', 'billing', 'token shape', 'capped', 6),
      meta('auth', 'mail', 'done topic', 'closed', 4),
      meta('mail', 'search', 'elsewhere', 'open', 1, 'claude-config'),
    ]

    expect(talkRows(talks, 'acme-gateway-80', ['acme-gateway-80', 'claude-config'])).toEqual(['talk: billing↔search "invoice ids" (2/6)', 'talk: auth↔billing "token shape" (6/6) capped'])
    expect(talkRows([meta('a', 'b', 't', 'open', 1, 'gone')], null, ['acme-gateway-80'])).toEqual(['talk: a↔b "t" (1/6)'])
  })

  test('ownerRows and talkRows show no control character or escape sequence from notes, topics or owner fields', () => {
    const owner = entry('bill\u0007ing', 'asleep', 'acme-gateway-80', '\u001b[31mred\u001b[0m a\u0007b x\u009by')
    const talk = { ...meta('a\u0000', 'b', 't', 'open', 1), topic: 'top\u001b]0;title\u0007ic\u007f\ttwo\r\nlines' }

    expect(ownerRows([owner], NOW, 'acme-gateway-80')).toEqual([{ feature: 'billing', text: '☾ billing · asleep 3h · red ab xy' }])
    expect(talkRows([talk], 'acme-gateway-80')).toEqual(['talk: a↔b "topic two lines" (1/6)'])
  })

  test('parseOwner, parseTalk and lastNote clean what they read', () => {
    expect(parseOwner('feature=bil\u001b[1mling\u001b[0m\nname=o\u0007k\nsid=0a\u009b1b\n').feature).toBe('billing')
    expect(parseOwner('feature=billing\nname=o\u0007k\nsid=0a\u009b1b\n')).toMatchObject({ name: 'ok', sid: '0a1b' })
    expect(parseTalk('a=x\u001b[2Jy\nb=b\ntopic=to\tpic here\n')).toMatchObject({ a: 'xy', topic: 'to pic here' })
    expect(lastNote('# h\n\u001b[31mred\u001b[0m\u0007 done\u0000\n')).toBe('red done')
  })

  test('focusLayout puts the rows on the lead\'s card, even an idle one, and the rest under "other crew"', () => {
    const b = withLive('', live('acme-gateway-80', 'claude:1.0', '/home/user/Developer/acme-gateway', 'idle', 600))
    const ctx = { now: NOW, entered: {}, seen: emptySeen(), prs: {} }
    const owners = [entry('billing', 'asleep', 'acme-gateway-80', 'n'), entry('mail', 'asleep', 'gone-lead', 'm')]
    const l = focusLayout({ board: b, plan: classify(b, ctx), ctx, owners, talks: [meta('a', 'b', 't', 'open', 1)] })

    expect(l.now.map(e => [e.name, e.owners?.map(o => o.text), e.talks])).toEqual([
      ['acme-gateway-80', ['☾ billing · asleep 3h · n'], ['talk: a↔b "t" (1/6)']],
      ['other crew', ['☾ mail · asleep 3h · m'], undefined],
    ])
    expect(l.idle).toEqual([])
  })

  test('wakeArgv is one argument per value with CREW_AS_USER=1; a text starting with - or holding #{pane_id} and $(x) stays one verbatim element', () => {
    const CREW = '/home/test/.claude/bin/crew'

    expect(wakeArgv(CREW, 'billing', '  finish the retry queue  ')).toEqual({ argv: [CREW, 'wake', 'billing', '--', 'finish the retry queue'], env: { CREW_AS_USER: '1' } })
    expect(wakeArgv(CREW, 'billing', '--force it')).toEqual({ argv: [CREW, 'wake', 'billing', '--', '--force it'], env: { CREW_AS_USER: '1' } })
    expect(wakeArgv(CREW, 'billing', 'show #{pane_id} and $(x) `y`; "z"')).toEqual({
      argv: [CREW, 'wake', 'billing', '--', 'show #{pane_id} and $(x) `y`; "z"'],
      env: { CREW_AS_USER: '1' },
    })
  })

  test('wakeArgv refuses an empty text, one over 2000 characters, and a feature that is not a slug', () => {
    const CREW = '/home/test/.claude/bin/crew'

    expect(wakeArgv(CREW, 'billing', ' \n ')).toEqual({ error: 'the message is empty' })
    expect(wakeArgv(CREW, 'billing', 'x'.repeat(2001))).toEqual({ error: 'the message is longer than 2000 characters' })
    expect(wakeArgv(CREW, 'billing', 'x'.repeat(2000))).toHaveProperty('argv')
    expect(wakeArgv(CREW, '-rf', 'go')).toEqual({ error: "bad feature '-rf'" })
    expect(wakeArgv(CREW, 'Billing', 'go')).toEqual({ error: "bad feature 'Billing'" })
    expect(wakeArgv(CREW, 'a'.repeat(42), 'go')).toEqual({ error: `bad feature '${'a'.repeat(42)}'` })
  })

  test('closeArgv is crew close <name> as argv with CREW_AS_USER=1; a name that could be read as a flag or hold a shell word is refused', () => {
    const CREW = '/home/test/.claude/bin/crew'

    expect(closeArgv(CREW, 'user-b8/web')).toEqual({ argv: [CREW, 'close', 'user-b8/web'], env: { CREW_AS_USER: '1' } })
    expect(closeArgv(CREW, 'acme-gateway-80')).toEqual({ argv: [CREW, 'close', 'acme-gateway-80'], env: { CREW_AS_USER: '1' } })
    for (const bad of ['', '-x', '--force-draft', 'a b', '$(id)', 'a;b', 'a'.repeat(81)]) expect(closeArgv(CREW, bad)).toEqual({ error: `bad session name '${bad}'` })
  })

  test('closeOutcome reads the closed line and the refusal text of exit 3', () => {
    expect(closeOutcome({ exitCode: 0, stdout: 'closed: user-b8/web, window claude:web (@7)\n', stderr: '' })).toEqual({ ok: true, message: 'closed: user-b8/web, window claude:web (@7)' })
    expect(closeOutcome({ exitCode: 3, stdout: '', stderr: 'crew: refused: web is busy (mid-turn): try again when it is idle\n' })).toEqual({
      ok: false,
      error: 'refused: web is busy (mid-turn): try again when it is idle',
    })
    expect(closeOutcome({ exitCode: 124, stdout: '', stderr: 'timed out after 30000 ms' })).toEqual({ ok: false, error: 'timed out after 30000 ms' })
  })

  test('wakeOutcome reads the woke line, a queued wake, and the refusal text of exit 3', () => {
    expect(wakeOutcome({ exitCode: 0, stdout: 'woke billing in claude:billing (task 1017-wake-billing)\n', stderr: '' })).toEqual({
      ok: true,
      queued: false,
      message: 'woke billing in claude:billing (task 1017-wake-billing)',
    })
    expect(wakeOutcome({ exitCode: 0, stdout: 'queued: wake waiting for RAM, not launched (mem low). Start it with: crew wake --resume 1017-wake-billing\n', stderr: '' })).toEqual({
      ok: true,
      queued: true,
      message: 'queued: wake waiting for RAM, not launched (mem low). Start it with: crew wake --resume 1017-wake-billing',
    })
    expect(wakeOutcome({ exitCode: 3, stdout: '', stderr: 'crew: refused: billing is awake; message it with SendMessage\n' })).toEqual({
      ok: false,
      error: 'refused: billing is awake; message it with SendMessage',
    })
  })
})
