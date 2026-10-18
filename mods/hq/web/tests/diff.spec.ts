import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { hasDiffTarget } from '../data'
import { startServer } from '../server'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const TOKEN = 'test-token-0123456789'
const PAGE_FILE = `${import.meta.dir}/../index.html`
const dirs: string[] = []
const servers: { stop: (force?: boolean) => void }[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const LS = [
  'NEEDS YOU',
  '  d1-rev-branch  review   1m  ship  acme-gateway  verified',
  '  d1-rev-wt      review   1m  ship  acme-gateway  verified',
  '  d1-rev-bare    review   1m  ship  acme-gateway  verified',
  '  d1-rev-blank   review   1m  ship  acme-gateway  verified',
  'RUNNING',
  '  d1-run-branch  running  2m  ship  acme-gateway  working',
  '',
].join('\n')

// A scratch world with a fake crew that logs the argv of `crew diff` (arguments joined by \x1f, one line per call).
// Its answer comes from files in `dir`: diff.out (stdout), diff.err (stderr, exit 5), diff.hang (sleeps 30 s).
function world(opts: { diffTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(`${tmpdir()}/hqdiff-`)
  dirs.push(dir)
  const bin = `${dir}/bin`
  mkdirSync(bin)
  const script = (name: string, body: string) => {
    writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${body}\n`)
    chmodSync(`${bin}/${name}`, 0o755)
  }
  writeFileSync(`${dir}/ls.txt`, LS)
  writeFileSync(`${dir}/diff.out`, 'diff: opened d1 (reused pane %7)\n')
  const log = `{ for a in "$@"; do printf '%s\\x1f' "$a"; done; printf '\\n'; } >> ${dir}/crew.log`
  script(
    'crew',
    `case "$1" in
  ls) cat ${dir}/ls.txt;;
  diff) ${log}
    [ -f ${dir}/diff.hang ] && sleep 30
    if [ -f ${dir}/diff.err ]; then cat ${dir}/diff.err >&2; exit 5; fi
    cat ${dir}/diff.out;;
esac`,
  )
  script('tmux-map', 'exit 0')
  script('gh', 'printf "[]"')

  const crew = `${dir}/crew`
  const task = (id: string, files: Record<string, string>) => {
    mkdirSync(`${crew}/${id}`, { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(`${crew}/${id}/${name}`, text)
  }
  const review = '2026-10-16T11:58:00Z\treview\tverified\n'
  task('d1-rev-branch', { meta: 'repo=/home/x/acme-gateway\nbranch=crew/d1-rev-branch\n', status: review })
  task('d1-rev-wt', { meta: 'repo=/home/x/acme-gateway\nworktree=/home/x/acme-gateway/.claude/worktrees/crew-d1-rev-wt\n', status: review })
  task('d1-rev-bare', { meta: 'repo=/home/x/acme-gateway\nlead=acme-gateway-lead\n', status: review })
  task('d1-rev-blank', { meta: 'repo=/home/x/acme-gateway\nbranch=\nworktree=\n', status: review })
  task('d1-run-branch', { meta: 'repo=/home/x/acme-gateway\nbranch=crew/d1-run-branch\n', status: '2026-10-16T11:57:00Z\trunning\n' })

  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir }
  const server = startServer(
    { host: '127.0.0.1', token: TOKEN, page: '<html></html>', crewBin: `${bin}/crew`, crewRoot: crew, tmuxMapBin: `${bin}/tmux-map`, tmuxBin: 'tmux', ghBin: `${bin}/gh`, env, now: () => NOW, cacheMs: 0, diffTimeoutMs: opts.diffTimeoutMs },
    0,
  )
  servers.push(server)
  const base = `http://127.0.0.1:${server.port}`
  const auth = { Authorization: `Bearer ${TOKEN}` }
  const diffs = (): string[][] =>
    existsSync(`${dir}/crew.log`)
      ? readFileSync(`${dir}/crew.log`, 'utf8')
          .split('\n')
          .filter(l => l !== '')
          .map(l => l.split('\x1f').slice(0, -1))
      : []
  const post = (body: unknown, headers: Record<string, string> = auth) =>
    fetch(`${base}/api/diff`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

  return { dir, base, auth, diffs, post }
}

describe('POST /api/diff guards', () => {
  test('a missing or wrong token is 401 and crew diff is never run (the route must sit behind the auth check)', async () => {
    const w = world()
    expect((await w.post({ id: 'd1-rev-branch' }, {})).status).toBe(401)
    expect((await w.post({ id: 'd1-rev-branch' }, { Authorization: 'Bearer wrong' })).status).toBe(401)
    expect(w.diffs()).toEqual([])
  })

  test('a POST from another origin is 403 and crew diff is never run (the CSRF check must cover the route)', async () => {
    const w = world()
    expect((await w.post({ id: 'd1-rev-branch' }, { ...w.auth, Origin: 'http://evil.example' })).status).toBe(403)
    expect(w.diffs()).toEqual([])
  })

  test('a malformed id, including one that would read as a crew flag, is 400 and crew diff is never run (the id must pass isTaskId)', async () => {
    const w = world()
    for (const id of ['', '--focus', '-x', 'a b', 'a;b', '$(id)', 'a..b', '../d1-rev-branch', 'a/b', 7, null]) {
      const res = await w.post({ id })
      expect([id, res.status]).toEqual([id, 400])
    }
    expect((await w.post({})).status).toBe(400)
    expect(w.diffs()).toEqual([])
  })

  test('a well-formed id that crew does not list is 404 (the id must name a real task)', async () => {
    const w = world()
    const res = await w.post({ id: 'd1-nothing' })
    expect([res.status, await res.json()]).toEqual([404, { error: 'no such task' }])
    expect(w.diffs()).toEqual([])
  })

  test('a task that is not in review is 409 even with a branch (only review tasks may be diffed)', async () => {
    const w = world()
    const res = await w.post({ id: 'd1-run-branch' })
    expect([res.status, await res.json()]).toEqual([409, { error: 'd1-run-branch is not in review' }])
    expect(w.diffs()).toEqual([])
  })

  test('a review task with no branch= or worktree= (absent or empty) is 409 (the meta check must ignore empty values)', async () => {
    const w = world()
    for (const id of ['d1-rev-bare', 'd1-rev-blank']) {
      const res = await w.post({ id })
      expect([id, res.status, await res.json()]).toEqual([id, 409, { error: `${id} has no branch or worktree to diff` }])
    }
    expect(w.diffs()).toEqual([])
  })
})

describe('POST /api/diff runs crew diff', () => {
  test('a review task with a branch runs argv [diff, id, --focus] exactly and returns the one-line output', async () => {
    const w = world()
    writeFileSync(`${w.dir}/diff.out`, 'diff: opened d1-rev-branch (new pane %9)\n')
    const res = await w.post({ id: 'd1-rev-branch' })
    expect([res.status, await res.json()]).toEqual([200, { ok: true, message: 'diff: opened d1-rev-branch (new pane %9)' }])
    expect(w.diffs()).toEqual([['diff', 'd1-rev-branch', '--focus']])
  })

  test('a review task with only a worktree is diffable too (worktree= must count like branch=)', async () => {
    const w = world()
    const res = await w.post({ id: 'd1-rev-wt' })
    expect(res.status).toBe(200)
    expect(w.diffs()).toEqual([['diff', 'd1-rev-wt', '--focus']])
  })

  test('a non-zero exit is 502 carrying the stderr text (the failure must reach the page)', async () => {
    const w = world()
    writeFileSync(`${w.dir}/diff.err`, 'diff: nvim or diffview.nvim is missing\n')
    const res = await w.post({ id: 'd1-rev-branch' })
    expect([res.status, await res.json()]).toEqual([502, { error: 'diff: nvim or diffview.nvim is missing' }])
    expect(w.diffs()).toEqual([['diff', 'd1-rev-branch', '--focus']])
  })

  test('a crew diff that hangs is cut off at the per-request timeout and answers 504', async () => {
    const w = world({ diffTimeoutMs: 300 })
    writeFileSync(`${w.dir}/diff.hang`, '')
    const started = Date.now()
    const res = await w.post({ id: 'd1-rev-branch' })
    expect([res.status, await res.json()]).toEqual([504, { error: 'crew diff timed out after 300 ms' }])
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('/api/board marks diffable rows', () => {
  test('only review rows with branch= or worktree= carry diffable:true, and no path or branch name reaches the page', async () => {
    const w = world()
    const res = await fetch(`${w.base}/api/board`, { headers: w.auth })
    const text = await res.text()
    const rows = JSON.parse(text).cards.flatMap((c: { rows: unknown[] }) => c.rows)
    expect(rows).toEqual([
      { id: 'd1-rev-branch', kind: 'review', name: 'd1-rev-branch', state: 'verifying', note: '', diffable: true },
      { id: 'd1-rev-wt', kind: 'review', name: 'd1-rev-wt', state: 'verifying', note: '', diffable: true },
      { id: 'd1-rev-bare', kind: 'review', name: 'd1-rev-bare', state: 'verifying', note: '' },
      { id: 'd1-rev-blank', kind: 'review', name: 'd1-rev-blank', state: 'verifying', note: '' },
      { id: 'd1-run-branch', kind: 'run', name: 'd1-run-branch', state: 'running', note: '2m' },
    ])
    expect(text).not.toContain('worktrees')
    expect(text).not.toContain('crew/d1-rev-branch')
  })
})

// The page's own script, run against a minimal fake DOM: the real render() and click handler, no browser.
class El {
  children: (El | string)[] = []
  attrs: Record<string, string> = {}
  className = ''
  listeners: Record<string, (e?: unknown) => unknown> = {}
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v
  }
  addEventListener(type: string, fn: (e?: unknown) => unknown) {
    this.listeners[type] = fn
  }
  append(...kids: (El | string)[]) {
    this.children.push(...kids)
  }
  replaceChildren(...kids: (El | string)[]) {
    this.children = kids
  }
  get textContent(): string {
    return this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join('')
  }
  set textContent(v: string) {
    this.children = [v]
  }
  all(): El[] {
    return [this, ...this.children.flatMap(c => (typeof c === 'string' ? [] : c.all()))]
  }
}

// A `post` that throws stands for a dropped connection: the fetch promise rejects.
function page(post: (path: string, body: unknown) => { status: number; data: unknown }) {
  const script = /<script nonce="__NONCE__">([\s\S]*?)<\/script>/.exec(readFileSync(PAGE_FILE, 'utf8'))![1]!
  const els: Record<string, El> = {}
  const document = {
    createElement: (tag: string) => new El(tag),
    getElementById: (id: string) => (els[id] ??= new El('div')),
    addEventListener: () => undefined,
    activeElement: null,
  }
  const calls: { path: string; body: unknown }[] = []
  const fetchStub = (path: string, init?: { body?: string }) => {
    if (init?.body === undefined) return new Promise(() => undefined)
    const body = JSON.parse(init.body)
    calls.push({ path, body })
    let reply: { status: number; data: unknown }
    try {
      reply = post(path, body)
    } catch (e) {
      return Promise.reject(e)
    }
    const { status, data } = reply

    return Promise.resolve({ status, json: async () => data })
  }
  const boot = new Function('document', 'fetch', 'setInterval', `${script}\nreturn { render }`)
  const { render } = boot(document, fetchStub, () => 0) as { render: (view: unknown) => void }

  return { render, board: document.getElementById('board'), calls }
}

const ROW = (id: string, kind: string, extra: object = {}) => ({ id, kind, name: id.slice(3), state: kind === 'review' ? 'verifying' : 'running', note: '', ...extra })
const VIEW = {
  at: NOW,
  needs: [],
  total: 0,
  folded: 0,
  results: [],
  cards: [{ rows: [ROW('d1-rev-a', 'review', { diffable: true }), ROW('d1-rev-b', 'review'), ROW('d1-run-c', 'run')] }],
}
const buttons = (board: El) => board.all().filter(e => e.tag === 'button' && e.textContent === 'Diff')
const wrapperText = (board: El, name: string) => board.all().find(e => e.className === 'rowwrap' && e.textContent.includes(name))

describe('page', () => {
  test('the Diff button is drawn only on the row the server marked diffable (the page must not guess from the row kind)', () => {
    const p = page(() => ({ status: 200, data: {} }))
    p.render(VIEW)
    expect(buttons(p.board).length).toBe(1)
    expect(wrapperText(p.board, 'rev-a')!.all().filter(e => e.tag === 'button').length).toBe(1)
    expect(wrapperText(p.board, 'rev-b')).toBeUndefined()
    expect(p.board.textContent).toContain('rev-b')
    expect(p.board.textContent).toContain('run-c')
  })

  test('clicking Diff posts {id} to /api/diff and shows the one-line result in the row', async () => {
    const p = page(() => ({ status: 200, data: { ok: true, message: 'diff: opened d1-rev-a (reused pane %7)' } }))
    p.render(VIEW)
    await buttons(p.board)[0]!.listeners.click!()
    expect(p.calls).toEqual([{ path: '/api/diff', body: { id: 'd1-rev-a' } }])
    const note = wrapperText(p.board, 'rev-a')!.all().find(e => e.className === 'note ok')!
    expect(note.textContent).toBe('diff: opened d1-rev-a (reused pane %7)')
  })

  test('a failed diff shows the error text in the row, and it survives the next board render', async () => {
    const p = page(() => ({ status: 502, data: { error: 'diff: no tmux server' } }))
    p.render(VIEW)
    await buttons(p.board)[0]!.listeners.click!()
    p.render({ ...VIEW, at: NOW + 5000 })
    const note = wrapperText(p.board, 'rev-a')!.all().find(e => e.className === 'note bad')!
    expect(note.textContent).toBe('diff: no tmux server')
  })

  test('a fetch that rejects (dropped connection) re-enables the button, shows an error note, and a second click posts again', async () => {
    let drop = true
    const p = page(() => {
      if (drop) throw new Error('network down')

      return { status: 200, data: { ok: true, message: 'diff: opened d1-rev-a (reused pane %7)' } }
    })
    p.render(VIEW)
    const button = buttons(p.board)[0]! as El & { disabled?: boolean }
    await button.listeners.click!()
    expect(button.disabled).toBe(false)
    const note = wrapperText(p.board, 'rev-a')!.all().find(e => e.className === 'note bad')!
    expect(note.textContent).toBe('diff failed: network down')
    drop = false
    await button.listeners.click!()
    expect(p.calls.length).toBe(2)
    expect(wrapperText(p.board, 'rev-a')!.all().find(e => e.className === 'note ok')!.textContent).toBe('diff: opened d1-rev-a (reused pane %7)')
  })
})

describe('hasDiffTarget (crew meta files are append-only: the last value of a key wins)', () => {
  test('a branch or a worktree alone is a target; neither, or only empty values, is not', () => {
    expect(hasDiffTarget('repo=/r\nbranch=crew/x\n')).toBe(true)
    expect(hasDiffTarget('repo=/r\nworktree=/r/.claude/worktrees/x\n')).toBe(true)
    expect(hasDiffTarget('repo=/r\nlead=l\n')).toBe(false)
    expect(hasDiffTarget('repo=/r\nbranch=\nworktree=\n')).toBe(false)
  })

  test('a branch cleared by a later empty branch= is no target', () => {
    expect(hasDiffTarget('branch=crew/old\nbranch=\n')).toBe(false)
  })

  test('a cleared branch with a worktree set is still a target', () => {
    expect(hasDiffTarget('branch=crew/old\nbranch=\nworktree=/r/wt\n')).toBe(true)
  })

  test('the last value wins: a later branch= replaces an earlier one, and an earlier empty one does not hide a later value', () => {
    expect(hasDiffTarget('branch=\nbranch=crew/new\n')).toBe(true)
    expect(hasDiffTarget('worktree=/r/wt\nworktree=\nbranch=\n')).toBe(false)
  })
})
