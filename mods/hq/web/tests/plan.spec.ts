import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { startServer } from '../server'

const TOKEN = 'test-token-0123456789'
const PAGE = '<html><script nonce="__NONCE__"></script></html>'
const PLAN_PAGE = '<html><script nonce="__NONCE__">plan</script></html>'
const NUDGE_MS = 400
const dirs: string[] = []
const servers: { stop: (force?: boolean) => void }[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const LS = [
  'RUNNING',
  '  1017-run      running  2m  ship  acme-gateway  working',
  '  1017-nolead   running  2m  ship  acme-gateway  working',
  '',
].join('\n')

const COMPOSER = ['● Done. All tests pass.', '', '────────────────', '❯ ', '────────────────', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n')
const MAP_TMUX = 'acme-gateway-lead\tclaude:1.0\tw\t/home/x/acme-gateway\tbusy\t60\t\n'
const MAP_NO_TMUX = 'acme-gateway-lead\t\t\t/home/x/acme-gateway\tbusy\t60\t\n'
const MAP_TWO = `${MAP_TMUX}other-lead\tclaude:2.0\tw\t/home/x/acme-gateway\tidle\t30\t\n`

const PLAN_JSON = { v: 1, rev: 15, title: 'Offline sync', stage: 'shape', nodes: {} }

// A scratch world like server.spec.ts's: fake crew, tmux-map, tmux and plan scripts that read their answers from files
// in `dir` and log every argv (one line per call, arguments joined by \x1f). The fake plan CLI answers `event` with
// event.out / event.err and the exit code in event.code, and `list` with list.out.
function world(opts: { map?: string; planBin?: boolean; planPage?: boolean; extraHosts?: string[] } = {}) {
  const dir = mkdtempSync(`${tmpdir()}/hqplan-`)
  dirs.push(dir)
  const bin = `${dir}/bin`
  mkdirSync(bin)
  const crew = `${dir}/crew`
  writeFileSync(`${dir}/ls.txt`, LS)
  writeFileSync(`${dir}/map.tsv`, opts.map ?? MAP_TMUX)
  writeFileSync(`${dir}/pane.txt`, COMPOSER)
  writeFileSync(`${dir}/event.code`, '0')
  writeFileSync(`${dir}/event.out`, '{"ok":true,"rev":16,"event":{},"summary":"parked Q9"}')
  writeFileSync(`${dir}/event.err`, '')
  writeFileSync(`${dir}/list.out`, '[{"id":"1017-run","title":"Offline sync","stage":"shape","rev":15,"progress":"3/12","updated":"2026-10-17T10:40:31Z"}]')
  const script = (name: string, body: string) => {
    writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${body}\n`)
    chmodSync(`${bin}/${name}`, 0o755)
  }
  const log = (file: string) => `{ for a in "$@"; do printf '%s\\x1f' "$a"; done; printf '\\n'; } >> ${dir}/${file}`
  script('crew', `case "$1" in ls) cat ${dir}/ls.txt;; esac`)
  script('tmux-map', `cat ${dir}/map.tsv`)
  script(
    'tmux',
    `${log('tmux.log')}
case "$1" in
  capture-pane)
    if [ ! -f ${dir}/typed.txt ]; then cat ${dir}/pane.txt
    else T="$(cat ${dir}/typed.txt)" awk '/^❯/ { print "❯ " ENVIRON["T"]; next } { print }' ${dir}/pane.txt; fi;;
  send-keys) if [ "$4" = -l ]; then printf '%s' "$6" > ${dir}/typed.txt; fi;;
  display-message) cat ${dir}/display.txt;;
esac
exit 0`,
  )
  script(
    'plan',
    `${log('plan.log')}
printf '%s\\n' "$CREW_ROOT" >> ${dir}/plan.env
case "$1" in
  list) cat ${dir}/list.out;;
  event) cat ${dir}/event.out; cat ${dir}/event.err >&2; exit "$(cat ${dir}/event.code)";;
esac`,
  )

  const task = (id: string, meta: string, plan = true) => {
    mkdirSync(`${crew}/${id}/plan`, { recursive: true })
    writeFileSync(`${crew}/${id}/meta`, meta)
    writeFileSync(`${crew}/${id}/status`, '2026-10-16T11:57:00Z\trunning\n')
    if (plan) {
      writeFileSync(`${crew}/${id}/plan/plan.json`, JSON.stringify(PLAN_JSON))
      writeFileSync(`${crew}/${id}/plan/PRD.md`, '# Offline sync\n')
    }
  }
  task('1017-run', 'lead=acme-gateway-lead\nrepo=/home/x/acme-gateway\n')
  task('1017-nolead', 'repo=/home/x/acme-gateway\n', false)

  const procRoot = `${dir}/proc`
  const proc = (pid: number, comm: string, pgrp: number, tpgid: number) => {
    mkdirSync(`${procRoot}/${pid}`, { recursive: true })
    writeFileSync(`${procRoot}/${pid}/stat`, `${pid} (${comm}) S 1 ${pgrp} ${pgrp} 34816 ${tpgid} 4194304 0 0 0 0\n`)
  }
  proc(500, 'zsh', 500, 501)
  proc(501, 'claude', 501, 501)
  writeFileSync(`${dir}/display.txt`, '500\tclaude\n')
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir }
  const server = startServer(
    {
      host: '127.0.0.1',
      token: TOKEN,
      page: PAGE,
      crewBin: `${bin}/crew`,
      crewRoot: crew,
      tmuxMapBin: `${bin}/tmux-map`,
      tmuxBin: 'tmux',
      env,
      cacheMs: 0,
      procRoot,
      settleMs: 300,
      ...(opts.planBin === false ? {} : { planBin: `${bin}/plan` }),
      ...(opts.planPage === false ? {} : { planPage: PLAN_PAGE }),
      planNudgeMs: NUDGE_MS,
      ...(opts.extraHosts ? { extraHosts: opts.extraHosts, remotePort: 0 } : {}),
    },
    0,
  )
  servers.push(server)
  const base = `http://127.0.0.1:${server.port}`
  const auth = { Authorization: `Bearer ${TOKEN}` }
  const lines = (file: string): string[][] =>
    existsSync(`${dir}/${file}`)
      ? readFileSync(`${dir}/${file}`, 'utf8')
          .split('\n')
          .filter(l => l !== '')
          .map(l => l.split('\x1f').slice(0, -1))
      : []
  const get = (path: string, headers: Record<string, string> = auth) => fetch(base + path, { headers })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth, ...headers }, body: JSON.stringify(body) })
  const event = (id: string, body: unknown, headers: Record<string, string> = {}) => post(`/api/plan/${id}/event`, body, headers)
  const sends = () => lines('tmux.log').filter(c => c[0] === 'send-keys')
  const planCalls = () => lines('plan.log')
  const set = (name: string, text: string) => writeFileSync(`${dir}/${name}`, text)

  const remoteBase = `http://127.0.0.1:${server.remotePort}`

  return { dir, base, remoteBase, get, post, event, sends, planCalls, set, crew, stop: () => server.stop(true) }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// Resolves once `done()` holds; fails the test after two seconds.
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2000; waited += 20) {
    if (done()) return
    await wait(20)
  }
  throw new Error('timed out waiting')
}

const ANSWER = { type: 'answer', node: 'Q7', choice: 'recommended' }
const ANSWER_ARGV = (id: string, json: string) => ['event', id, '--by', 'user', '--source', 'page', '--json', json]

describe('GET /api/plan/<task>', () => {
  test('answers {rev, plan, prd} from the task directory, and {rev, unchanged} when the page already has that rev', async () => {
    const w = world()
    const res = await w.get('/api/plan/1017-run')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rev: 15, plan: PLAN_JSON, prd: '# Offline sync\n' })

    const same = await w.get('/api/plan/1017-run?rev=15')
    expect(same.status).toBe(200)
    expect(await same.json()).toEqual({ rev: 15, unchanged: true })

    const older = await w.get('/api/plan/1017-run?rev=14')
    expect(((await older.json()) as { rev: number; unchanged?: boolean }).unchanged).toBeUndefined()
  })

  test('a task without a plan is 404', async () => {
    const w = world()
    expect((await w.get('/api/plan/1017-nolead')).status).toBe(404)
    expect((await w.get('/api/plan/no-such-task')).status).toBe(404)
  })

  test('a malformed task id, also percent-encoded, is 400 and reads nothing', async () => {
    const w = world()
    for (const bad of ['a%2Fb', '%2E%2E%2Fetc', 'bad%20id', '%E0%A4%A', '-lead']) {
      expect([bad, (await w.get(`/api/plan/${bad}`)).status]).toEqual([bad, 400])
    }
  })

  test('a plan.json over 2 MB is refused', async () => {
    const w = world()
    writeFileSync(`${w.crew}/1017-run/plan/plan.json`, JSON.stringify({ rev: 1, pad: 'x'.repeat(2 * 1024 * 1024) }))
    expect((await w.get('/api/plan/1017-run')).status).toBe(502)
  })

  test('a PRD.md over 2 MB is not served: prd is empty and prd_error says why, the plan is still answered', async () => {
    const w = world()
    writeFileSync(`${w.crew}/1017-run/plan/PRD.md`, 'x'.repeat(2 * 1024 * 1024 + 1))
    const res = await w.get('/api/plan/1017-run')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rev: 15, plan: PLAN_JSON, prd: '', prd_error: 'PRD.md is larger than 2 MB' })
  })
})

describe('plan routes and the existing checks', () => {
  test('no token is 401, a foreign Host is 403, a foreign Origin on a POST is 403 and runs nothing', async () => {
    const w = world()
    expect((await w.get('/api/plan/1017-run', {})).status).toBe(401)
    expect((await w.get('/api/plans', {})).status).toBe(401)
    expect((await w.get('/plan/1017-run', {})).status).toBe(401)
    expect((await w.event('1017-run', ANSWER, { Authorization: '' })).status).toBe(401)
    expect((await w.get('/api/plan/1017-run', { Authorization: `Bearer ${TOKEN}`, Host: 'evil.example:80' })).status).toBe(403)
    expect((await w.event('1017-run', ANSWER, { Origin: 'http://evil.example' })).status).toBe(403)
    expect(w.planCalls()).toEqual([])
    expect((await w.event('1017-run', ANSWER, { Origin: w.base })).status).toBe(200)
  })

  test('without planBin the API routes answer 404, without planPage the page routes do', async () => {
    const w = world({ planBin: false, planPage: false })
    expect((await w.get('/api/plans')).status).toBe(404)
    expect((await w.get('/api/plan/1017-run')).status).toBe(404)
    expect((await w.event('1017-run', ANSWER)).status).toBe(404)
    expect((await w.get('/plan')).status).toBe(404)
    expect((await w.get('/plan/1017-run')).status).toBe(404)
    expect(w.planCalls()).toEqual([])
  })
})

describe('GET /plan and /api/plans', () => {
  test('the plan page carries a fresh nonce in the CSP, for /plan and /plan/<task>', async () => {
    const w = world()
    for (const path of ['/plan', '/plan/1017-run']) {
      const res = await w.get(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const nonce = /nonce="([^"]+)"/.exec(await res.text())![1]!
      expect(res.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`)
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    }
    expect((await w.get('/plan/a%2Fb')).status).toBe(400)
  })

  test('/api/plans is the output of `plan list --json`, run with the same CREW_ROOT as HQ', async () => {
    const w = world()
    const res = await w.get('/api/plans')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: '1017-run', title: 'Offline sync', stage: 'shape', rev: 15, progress: '3/12', updated: '2026-10-17T10:40:31Z' }])
    expect(w.planCalls()).toEqual([['list', '--json']])
    expect(readFileSync(`${w.dir}/plan.env`, 'utf8')).toBe(`${w.crew}\n`)
  })

  test('a `plan list` that does not answer JSON is 502', async () => {
    const w = world()
    w.set('list.out', 'not json')
    expect((await w.get('/api/plans')).status).toBe(502)
  })
})

describe('POST /api/plan/<task>/event', () => {
  test('a valid answer runs the CLI with exactly this argv and answers 200 with rev, summary and nudge', async () => {
    const w = world()
    w.set('event.out', '{"ok":true,"rev":16,"event":{"type":"answer"},"summary":"answered Q7: Last-write-wins"}')
    const res = await w.event('1017-run', ANSWER)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, rev: 16, summary: 'answered Q7: Last-write-wins', nudge: 'scheduled' })
    expect(w.planCalls()).toEqual([ANSWER_ARGV('1017-run', '{"type":"answer","node":"Q7","choice":"recommended"}')])
  })

  test('keys outside the listed fields of the type are dropped from the forwarded JSON', async () => {
    const w = world()
    const res = await w.event('1017-run', { type: 'park', node: 'Q9', text: 'ignored', label: 'ignored', by: 'session', rev: 99, source: 'build', extra: { a: 1 } })
    expect(res.status).toBe(200)
    expect(w.planCalls()).toEqual([ANSWER_ARGV('1017-run', '{"type":"park","node":"Q9"}')])

    await w.event('1017-run', { type: 'approve_prd', node: 'Q1', text: 'x' })
    expect(w.planCalls()[1]).toEqual(ANSWER_ARGV('1017-run', '{"type":"approve_prd"}'))

    await w.event('1017-run', { type: 'note', text: 'cache it', node: 'S2', lane: 'build', choice: 'a' })
    expect(w.planCalls()[2]).toEqual(ANSWER_ARGV('1017-run', '{"type":"note","node":"S2","text":"cache it","lane":"build"}'))
  })

  // Break caught: a USER_EVENTS table without the §12.2 types answers 400 for them; a FIELD_ORDER without value/other drops those keys.
  test('each §12.2 board event reaches the CLI with exactly its fields, in a stable order', async () => {
    const w = world()
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'boost', node: 'I3', value: 2 }, '{"type":"boost","node":"I3","value":2}'],
      [{ value: 0, node: 'I3', type: 'boost' }, '{"type":"boost","node":"I3","value":0}'],
      [{ type: 'kill', node: 'I4', text: 'needs a licence we lack' }, '{"type":"kill","node":"I4","text":"needs a licence we lack"}'],
      [{ type: 'restore', node: 'I4' }, '{"type":"restore","node":"I4"}'],
      [{ other: 'I3', type: 'merge', node: 'I1' }, '{"type":"merge","node":"I1","other":"I3"}'],
      [{ type: 'twist', node: 'I3' }, '{"type":"twist","node":"I3"}'],
      [{ type: 'twist', node: 'I3', text: 'make it offline-first' }, '{"type":"twist","node":"I3","text":"make it offline-first"}'],
      [{ type: 'promote', node: 'I3' }, '{"type":"promote","node":"I3"}'],
      [{ type: 'weight', node: 'K2', value: 30 }, '{"type":"weight","node":"K2","value":30}'],
      [{ type: 'weights_reset' }, '{"type":"weights_reset"}'],
      [{ type: 'research' }, '{"type":"research"}'],
      [{ type: 'research', node: 'I3' }, '{"type":"research","node":"I3"}'],
      [{ type: 'research', node: 'Q4', text: 'who else ships this?' }, '{"type":"research","node":"Q4","text":"who else ships this?"}'],
    ]
    for (const [body] of cases) expect([body, (await w.event('1017-run', body)).status]).toEqual([body, 200])
    expect(w.planCalls()).toEqual(cases.map(([, json]) => ANSWER_ARGV('1017-run', json)))
  })

  // Break caught: forwarding every FIELD_ORDER key regardless of type (e.g. `other` on a boost, `value` on a kill).
  test('a field that is not listed for a board event type is not forwarded', async () => {
    const w = world()
    await w.event('1017-run', { type: 'boost', node: 'I3', value: 1, other: 'I1', text: 'x', label: 'y' })
    await w.event('1017-run', { type: 'kill', node: 'I4', text: 'no', value: 3, other: 'I1' })
    await w.event('1017-run', { type: 'merge', node: 'I1', other: 'I3', value: 2, text: 'x' })
    await w.event('1017-run', { type: 'weights_reset', node: 'K1', value: 5, text: 'x', other: 'K2' })
    await w.event('1017-run', { type: 'park', node: 'Q9', value: 4, other: 'Q1' })
    expect(w.planCalls()).toEqual([
      ANSWER_ARGV('1017-run', '{"type":"boost","node":"I3","value":1}'),
      ANSWER_ARGV('1017-run', '{"type":"kill","node":"I4","text":"no"}'),
      ANSWER_ARGV('1017-run', '{"type":"merge","node":"I1","other":"I3"}'),
      ANSWER_ARGV('1017-run', '{"type":"weights_reset"}'),
      ANSWER_ARGV('1017-run', '{"type":"park","node":"Q9"}'),
    ])
  })

  // Break caught: reusing the string-only check for value (a string "3" would reach the CLI), or Number() coercion.
  test('a value that is not a JSON integer is 400 "value must be an integer" and the CLI is not run', async () => {
    const w = world()
    for (const value of ['3', 2.5, true, [1], { n: 1 }, 1e300]) {
      const res = await w.event('1017-run', { type: 'boost', node: 'I3', value })
      expect([value, res.status, await res.json()]).toEqual([value, 400, { error: 'value must be an integer' }])
    }
    const weight = await w.event('1017-run', { type: 'weight', node: 'K2', value: '30' })
    expect([weight.status, await weight.json()]).toEqual([400, { error: 'value must be an integer' }])
    expect(w.planCalls()).toEqual([])
  })

  // Break caught: `other` accepted as anything but a string.
  test('other must be a string', async () => {
    const w = world()
    const res = await w.event('1017-run', { type: 'merge', node: 'I1', other: 3 })
    expect([res.status, await res.json()]).toEqual([400, { error: 'other must be a string' }])
    expect(w.planCalls()).toEqual([])
  })

  // Break caught: a board event skipping the shared exit-code mapping or the coalesced nudge.
  test('a board event refused by the CLI is 400 with its message, an accepted one is nudged with the CLI summary', async () => {
    const w = world()
    w.set('event.code', '2')
    w.set('event.out', '')
    w.set('event.err', 'boost: value must be 0 to 3\n')
    const refused = await w.event('1017-run', { type: 'boost', node: 'I3', value: 9 })
    expect([refused.status, await refused.json()]).toEqual([400, { error: 'boost: value must be 0 to 3' }])
    expect(w.sends()).toEqual([])

    w.set('event.code', '0')
    w.set('event.err', '')
    w.set('event.out', '{"ok":true,"rev":16,"event":{},"summary":"boosted I3 (2)"}')
    expect((await w.event('1017-run', { type: 'boost', node: 'I3', value: 2 })).status).toBe(200)
    w.set('event.out', '{"ok":true,"rev":17,"event":{},"summary":"killed I4: too big"}')
    expect((await w.event('1017-run', { type: 'kill', node: 'I4', text: 'too big' })).status).toBe(200)
    await until(() => w.sends().length >= 2)
    expect(w.sends()[0]![5]).toBe('From Plan (user): 2 change(s) on 1017-run: boosted I3 (2); killed I4: too big. Run: plan news 1017-run')
  })

  test('text that holds shell syntax travels as one argv element', async () => {
    const w = world()
    const text = '"; rm -rf ~ ; echo \'$(whoami)\' `id`\nline two'
    expect((await w.event('1017-run', { type: 'note', text })).status).toBe(200)
    const [call] = w.planCalls()
    expect(call).toHaveLength(8)
    expect(JSON.parse(call![7]!)).toEqual({ type: 'note', text })
  })

  test('session-only types and unknown types are 400 and the CLI is not run', async () => {
    const w = world()
    for (const type of ['upsert', 'remove', 'set', 'resolve', 'task_status', 'nope', '__proto__', 'toString']) {
      expect([type, (await w.event('1017-run', { type, node: { id: 'T1' }, field: 'stage', value: 'ready' })).status]).toEqual([type, 400])
    }
    const unknown = await w.event('1017-run', { type: 'nope' })
    expect(await unknown.json()).toEqual({
      error: 'type must be one of: answer, park, reopen, strike, prioritize, edit_label, note, ask, expand, approve_prd, boost, kill, restore, merge, twist, promote, weight, weights_reset, research',
    })
    expect((await w.event('1017-run', { node: 'Q7' })).status).toBe(400)
    expect((await w.event('1017-run', { type: 7 })).status).toBe(400)
    expect(w.planCalls()).toEqual([])
  })

  test('a field of the wrong type is 400 and the CLI is not run', async () => {
    const w = world()
    expect((await w.event('1017-run', { type: 'park', node: { id: 'Q1' } })).status).toBe(400)
    expect((await w.event('1017-run', { type: 'answer', node: 'Q7', choice: 3 })).status).toBe(400)
    expect(w.planCalls()).toEqual([])
  })

  test('text over 2000 characters and a label over 120 are 413, exactly at the cap passes', async () => {
    const w = world()
    expect((await w.event('1017-run', { type: 'note', text: 'x'.repeat(2001) })).status).toBe(413)
    expect((await w.event('1017-run', { type: 'edit_label', node: 'Q1', label: 'y'.repeat(121) })).status).toBe(413)
    expect(w.planCalls()).toEqual([])
    expect((await w.event('1017-run', { type: 'note', text: 'x'.repeat(2000) })).status).toBe(200)
    expect((await w.event('1017-run', { type: 'edit_label', node: 'Q1', label: 'y'.repeat(120) })).status).toBe(200)
    expect(w.planCalls()).toHaveLength(2)
  })

  test('a bad task id is 400, a body that is not JSON is 415, a bad JSON body is 400', async () => {
    const w = world()
    expect((await w.event('a%2Fb', ANSWER)).status).toBe(400)
    expect((await w.event('..%2F..', ANSWER)).status).toBe(400)
    expect((await fetch(`${w.base}/api/plan/1017-run/event`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' }, body: 'x' })).status).toBe(415)
    expect((await fetch(`${w.base}/api/plan/1017-run/event`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400)
    expect(w.planCalls()).toEqual([])
  })

  test('CLI exit 2 is 400 with its stderr, 3 is 404, 4 is 409 with the lint findings, anything else is 502', async () => {
    const w = world()
    w.set('event.code', '2')
    w.set('event.out', '')
    w.set('event.err', 'Q7: choice z is not an option\n')
    const invalid = await w.event('1017-run', ANSWER)
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'Q7: choice z is not an option' })

    w.set('event.code', '3')
    w.set('event.err', 'no plan for 1017-run\n')
    const missing = await w.event('1017-run', ANSWER)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'no plan for 1017-run' })

    const lint = [{ rule: 'open-blocking', severity: 'block', msg: 'Q3 is open' }]
    w.set('event.code', '4')
    w.set('event.err', '')
    w.set('event.out', JSON.stringify({ ok: false, lint }))
    const blocked = await w.event('1017-run', { type: 'approve_prd' })
    expect(blocked.status).toBe(409)
    expect(((await blocked.json()) as { lint: unknown }).lint).toEqual(lint)

    w.set('event.code', '1')
    w.set('event.err', 'boom')
    expect((await w.event('1017-run', ANSWER)).status).toBe(502)
    expect(w.sends()).toEqual([])
  })
})

describe('the session nudge', () => {
  test('two events within the window make exactly one line, with both summaries', async () => {
    const w = world()
    w.set('event.out', '{"ok":true,"rev":16,"event":{},"summary":"answered Q7: Last-write-wins"}')
    expect((await w.event('1017-run', ANSWER)).status).toBe(200)
    w.set('event.out', '{"ok":true,"rev":17,"event":{},"summary":"parked Q9"}')
    expect((await w.event('1017-run', { type: 'park', node: 'Q9' })).status).toBe(200)
    expect(w.sends()).toEqual([])

    await until(() => w.sends().length >= 2)
    await wait(NUDGE_MS * 3)
    expect(w.sends()).toEqual([
      ['send-keys', '-t', 'claude:1.0', '-l', '--', 'From Plan (user): 2 change(s) on 1017-run: answered Q7: Last-write-wins; parked Q9. Run: plan news 1017-run'],
      ['send-keys', '-t', 'claude:1.0', 'Enter'],
    ])
  })

  test('a later burst starts a new nudge', async () => {
    const w = world()
    await w.event('1017-run', { type: 'park', node: 'Q9' })
    await until(() => w.sends().length >= 2)
    w.set('event.out', '{"ok":true,"rev":17,"event":{},"summary":"reopened Q9"}')
    await w.event('1017-run', { type: 'reopen', node: 'Q9' })
    await until(() => w.sends().length >= 4)
    expect(w.sends()[2]![5]).toBe('From Plan (user): 1 change(s) on 1017-run: reopened Q9. Run: plan news 1017-run')
  })

  test('a long burst is cut to 2000 characters and keeps the plan news hint', async () => {
    const w = world()
    w.set('event.out', JSON.stringify({ ok: true, rev: 20, event: {}, summary: `noted ${'z'.repeat(900)}` }))
    for (let i = 0; i < 4; i++) await w.event('1017-run', { type: 'note', text: `n${i}` })
    await until(() => w.sends().length >= 2)
    const typed = w.sends()[0]![5]!
    expect(Array.from(typed).length).toBeLessThanOrEqual(2000)
    expect(typed.startsWith('From Plan (user): 4 change(s) on 1017-run: noted zzz')).toBe(true)
    expect(typed.endsWith('…. Run: plan news 1017-run')).toBe(true)
  })

  test('a summary is one line, at most 2000 characters, free of escapes, and still ends with the plan news hint', async () => {
    const w = world()
    w.set('event.out', JSON.stringify({ ok: true, rev: 16, event: {}, summary: `noted line one\nline two \u001b[31mred\u001b[0m ${'q'.repeat(3000)}` }))
    expect((await w.event('1017-run', { type: 'note', text: 'x' })).status).toBe(200)
    await until(() => w.sends().length >= 2)
    const typed = w.sends()[0]![5]!
    expect(typed).not.toMatch(/[\u0000-\u001f]/)
    expect(Array.from(typed).length).toBeLessThanOrEqual(2000)
    expect(typed.startsWith('From Plan (user): 1 change(s) on 1017-run: noted line one line two [31mred[0m qqq')).toBe(true)
    expect(typed.endsWith('…. Run: plan news 1017-run')).toBe(true)
  })

  test('bidi overrides, zero-width and tag characters are stripped from a summary', async () => {
    const w = world()
    w.set('event.out', JSON.stringify({ ok: true, rev: 16, event: {}, summary: 'answered‮ Q7​: re\u{E0041}ad⁦ me' }))
    expect((await w.event('1017-run', ANSWER)).status).toBe(200)
    await until(() => w.sends().length >= 2)
    expect(w.sends()[0]![5]).toBe('From Plan (user): 1 change(s) on 1017-run: answered Q7: read me. Run: plan news 1017-run')
  })

  test('stopping the server cancels a nudge that is still waiting', async () => {
    const w = world()
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args.join(' '))
    try {
      expect((await w.event('1017-run', ANSWER)).status).toBe(200)
      w.stop()
      await wait(NUDGE_MS * 2)
    } finally {
      console.error = original
    }
    expect(w.sends()).toEqual([])
    expect(logged).toEqual([])
  })

  test('a lead that is not in tmux gets nothing, and the POST is still 200', async () => {
    const w = world({ map: MAP_NO_TMUX })
    const res = await w.event('1017-run', ANSWER)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { nudge: string }).nudge).toBe('scheduled')
    await wait(NUDGE_MS * 4)
    expect(w.sends()).toEqual([])
    expect((await w.get('/api/plan/1017-run')).status).toBe(200)
  })

  test('a lead that is only a guess among several sessions of the project gets nothing', async () => {
    const w = world({ map: MAP_TWO })
    w.set('ls.txt', ['RUNNING', '  1017-nolead   running  2m  ship  acme-gateway  working', ''].join('\n'))
    expect((await w.event('1017-nolead', ANSWER)).status).toBe(200)
    await wait(NUDGE_MS * 4)
    expect(w.sends()).toEqual([])
  })

  test('a lone session of the project that no task records as its lead is a guess, and gets nothing', async () => {
    const w = world()
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args.join(' '))
    try {
      expect((await w.event('1017-nolead', ANSWER)).status).toBe(200)
      await wait(NUDGE_MS * 4)
    } finally {
      console.error = original
    }
    expect(w.sends()).toEqual([])
    expect(logged).toEqual(['hq-web: plan nudge for 1017-nolead not sent: the lead of 1017-nolead is only a guess: not typing the note into it'])
  })

  test('a task that is not on the board gets nothing and the server keeps answering', async () => {
    const w = world()
    mkdirSync(`${w.crew}/ghost/plan`, { recursive: true })
    writeFileSync(`${w.crew}/ghost/plan/plan.json`, JSON.stringify(PLAN_JSON))
    expect((await w.event('ghost', ANSWER)).status).toBe(200)
    await wait(NUDGE_MS * 4)
    expect(w.sends()).toEqual([])
    expect((await w.get('/api/plans')).status).toBe(200)
  })

  test('an event the CLI refused schedules no nudge', async () => {
    const w = world()
    w.set('event.code', '2')
    w.set('event.err', 'invalid')
    expect((await w.event('1017-run', ANSWER)).status).toBe(400)
    await wait(NUDGE_MS * 4)
    expect(w.sends()).toEqual([])
  })
})

describe('plan routes on the remote listener (tailscale serve)', () => {
  const TS = 'example-tailnet.ts.net'
  const far = (extra: Record<string, string> = {}) => ({ Host: TS, Authorization: `Bearer ${TOKEN}`, ...extra })
  const at = (w: { remoteBase: string }, path: string, headers: Record<string, string>) => fetch(w.remoteBase + path, { headers })

  test('the remote listener reads the plan page, the list and a plan, and posts an event with Origin https://<host>', async () => {
    const w = world({ extraHosts: [TS] })
    expect((await at(w, '/plan/1017-run', far())).status).toBe(200)
    expect((await at(w, '/api/plans', far())).status).toBe(200)
    expect((await at(w, '/api/plan/1017-run', far())).status).toBe(200)
    const post = (origin: string) =>
      fetch(`${w.remoteBase}/api/plan/1017-run/event`, { method: 'POST', headers: { ...far({ Origin: origin }), 'Content-Type': 'application/json' }, body: JSON.stringify(ANSWER) })
    expect((await post(`https://${TS}`)).status).toBe(200)
    expect(w.planCalls().filter(c => c[0] === 'event')).toEqual([ANSWER_ARGV('1017-run', JSON.stringify(ANSWER))])
    expect((await post(`http://${TS}`)).status).toBe(403)
  })

  test('without the remote listener the ts.net Host is 403 on a plan route of the main one', async () => {
    const w = world()
    expect((await w.get('/api/plans', far())).status).toBe(403)
  })
})
