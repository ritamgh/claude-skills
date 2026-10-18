import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { createPlanRoutes } from '../plan'
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
function world(opts: { map?: string; planBin?: boolean; planPage?: boolean; extraHosts?: string[]; nudgeMs?: number; retry?: { ms: number; windowMs: number } } = {}) {
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
  script('crew', `${log('crew.log')}\ncase "$1" in ls) cat ${dir}/ls.txt;; esac`)
  script('tmux-map', `cat ${dir}/map.tsv`)
  script(
    'tmux',
    `${log('tmux.log')}
case "$1" in
  capture-pane)
    if [ ! -f ${dir}/typed.txt ] || [ -f ${dir}/noecho ]; then cat ${dir}/pane.txt
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
      planNudgeMs: opts.nudgeMs ?? NUDGE_MS,
      ...(opts.retry ? { planRetryMs: opts.retry.ms, planRetryWindowMs: opts.retry.windowMs } : {}),
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
  const captures = () => lines('tmux.log').filter(c => c[0] === 'capture-pane').length
  const crewCalls = () => lines('crew.log').length
  const set = (name: string, text: string) => writeFileSync(`${dir}/${name}`, text)

  const remoteBase = `http://127.0.0.1:${server.remotePort}`

  return { dir, base, remoteBase, get, post, event, sends, planCalls, captures, crewCalls, set, crew, stop: () => server.stop(true) }
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
      error:
        'type must be one of: answer, park, reopen, strike, prioritize, edit_label, note, ask, expand, approve_prd, boost, kill, restore, merge, twist, promote, weight, weights_reset, research, comment, comment_accept, comment_rework, comment_delete, review',
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

  // Break caught: a USER_EVENTS table without the comment types (400), or a FIELD_ORDER without ref/proposal/author/anchor (keys silently dropped).
  test('each teammate-comment event reaches the CLI with exactly its fields, in a stable order, and a pane ask has no node', async () => {
    const w = world()
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'comment', text: 'tighten the retry rule' }, '{"type":"comment","text":"tighten the retry rule"}'],
      [{ anchor: '§4', author: 'Priya N', text: 'why 3 retries?', type: 'comment' }, '{"type":"comment","text":"why 3 retries?","author":"Priya N","anchor":"§4"}'],
      [{ type: 'comment', text: 'x', anchor: 'R12' }, '{"type":"comment","text":"x","anchor":"R12"}'],
      [{ proposal: 14, ref: 'CM3', type: 'comment_accept' }, '{"type":"comment_accept","ref":"CM3","proposal":14}'],
      [{ type: 'comment_rework', ref: 'CM3' }, '{"type":"comment_rework","ref":"CM3"}'],
      [{ text: 'shorter please', ref: 'CM3', type: 'comment_rework' }, '{"type":"comment_rework","ref":"CM3","text":"shorter please"}'],
      [{ type: 'comment_delete', ref: 'CM3' }, '{"type":"comment_delete","ref":"CM3"}'],
      [{ type: 'ask', text: 'what is still open?' }, '{"type":"ask","text":"what is still open?"}'],
      [{ type: 'ask', text: 'why Q4?', node: 'Q4' }, '{"type":"ask","node":"Q4","text":"why Q4?"}'],
    ]
    for (const [body] of cases) expect([body, (await w.event('1017-run', body)).status]).toEqual([body, 200])
    expect(w.planCalls()).toEqual(cases.map(([, json]) => ANSWER_ARGV('1017-run', json)))
  })

  // Break caught: forwarding every key regardless of type (a ref on a comment, a proposal on a delete, an author on a rework).
  test('a field that is not listed for a comment event type is not forwarded', async () => {
    const w = world()
    await w.event('1017-run', { type: 'comment', text: 'x', ref: 'CM1', proposal: 5, node: 'Q1', parts: [] })
    await w.event('1017-run', { type: 'comment_accept', ref: 'CM1', proposal: 5, text: 'x', author: 'a', anchor: 'Q1', changes: [{ type: 'upsert' }] })
    await w.event('1017-run', { type: 'comment_rework', ref: 'CM1', proposal: 5, author: 'a', anchor: 'Q1' })
    await w.event('1017-run', { type: 'comment_delete', ref: 'CM1', text: 'x', proposal: 5 })
    expect(w.planCalls()).toEqual([
      ANSWER_ARGV('1017-run', '{"type":"comment","text":"x"}'),
      ANSWER_ARGV('1017-run', '{"type":"comment_accept","ref":"CM1","proposal":5}'),
      ANSWER_ARGV('1017-run', '{"type":"comment_rework","ref":"CM1"}'),
      ANSWER_ARGV('1017-run', '{"type":"comment_delete","ref":"CM1"}'),
    ])
  })

  // Break caught: comment_split, comment_triage and reply put into USER_EVENTS: the page could then triage its own comments.
  test('comment_split, comment_triage and reply are session-only: 400 and the CLI is not run', async () => {
    const w = world()
    for (const type of ['comment_split', 'comment_triage', 'reply']) {
      const res = await w.event('1017-run', { type, ref: 'CM1', text: 'x', parts: [{ text: 'a' }, { text: 'b' }], action: 'accept' })
      expect([type, res.status]).toEqual([type, 400])
    }
    expect(w.planCalls()).toEqual([])
  })

  // Break caught: comment_accept's ref, or any comment field, accepted as a non-string.
  test('ref, author and anchor must be strings', async () => {
    const w = world()
    for (const [body, key] of [
      [{ type: 'comment_accept', ref: 3, proposal: 7 }, 'ref'],
      [{ type: 'comment', text: 'x', author: ['a'] }, 'author'],
      [{ type: 'comment', text: 'x', anchor: 4 }, 'anchor'],
    ] as const) {
      const res = await w.event('1017-run', body)
      expect([key, res.status, await res.json()]).toEqual([key, 400, { error: `${key} must be a string` }])
    }
    expect(w.planCalls()).toEqual([])
  })

  // Break caught: the proposal id left a string (the page now sends proposal.rev, an integer) or let through as a float, a string or a boolean.
  test('the comment_accept proposal must be an integer', async () => {
    const w = world()
    for (const proposal of ['7', 7.5, true, [7], { rev: 7 }, 2 ** 60]) {
      const res = await w.event('1017-run', { type: 'comment_accept', ref: 'CM1', proposal })
      expect([proposal, res.status, await res.json()]).toEqual([proposal, 400, { error: 'proposal must be an integer' }])
    }
    expect(w.planCalls()).toEqual([])
  })

  // Break caught: the one 2000 cap applied to a comment (a 5000-character paste refused), or the 5000 cap leaking to every event.
  test('a comment may carry 5000 characters of text, every other event keeps the 2000 cap', async () => {
    const w = world()
    expect((await w.event('1017-run', { type: 'comment', text: 'x'.repeat(5001) })).status).toBe(413)
    expect((await w.event('1017-run', { type: 'comment', text: '€'.repeat(5001) })).status).toBe(413)
    for (const body of [
      { type: 'comment_rework', ref: 'CM1', text: 'x'.repeat(2001) },
      { type: 'ask', text: 'x'.repeat(2001) },
      { type: 'note', text: 'x'.repeat(2001) },
      { type: 'answer', node: 'Q1', text: 'x'.repeat(2001) },
    ]) {
      expect([body.type, (await w.event('1017-run', body)).status]).toEqual([body.type, 413])
    }
    expect(w.planCalls()).toEqual([])
    expect((await w.event('1017-run', { type: 'comment', text: 'x'.repeat(5000) })).status).toBe(200)
    expect((await w.event('1017-run', { type: 'comment', text: '€'.repeat(5000) })).status).toBe(200)
    expect((await w.event('1017-run', { type: 'comment_rework', ref: 'CM1', text: 'x'.repeat(2000) })).status).toBe(200)
    expect(w.planCalls()).toHaveLength(3)
    expect(JSON.parse(w.planCalls()[0]![7]!).text).toHaveLength(5000)
  })

  // Break caught: no author/anchor limit (a name of any length or a paragraph in the anchor reaches the plan CLI), or a line break let through.
  test('an author over 80 characters or on two lines, an anchor over 16 or on two lines, is 400; at the limit it passes', async () => {
    const w = world()
    for (const [key, value] of [
      ['author', 'a'.repeat(81)],
      ['author', 'Priya\nN'],
      ['author', 'Priya\rN'],
      ['author', 'Priya N'],
      ['anchor', 'Q'.repeat(17)],
      ['anchor', 'Q1\nQ2'],
    ] as const) {
      const res = await w.event('1017-run', { type: 'comment', text: 'x', [key]: value })
      expect([key, value, res.status]).toEqual([key, value, 400])
      expect(((await res.json()) as { error: string }).error).toContain(key)
    }
    expect(w.planCalls()).toEqual([])
    expect((await w.event('1017-run', { type: 'comment', text: 'x', author: 'a'.repeat(80), anchor: 'Q'.repeat(16) })).status).toBe(200)
    expect((await w.event('1017-run', { type: 'comment', text: 'x', author: '€'.repeat(80) })).status).toBe(200)
    expect(w.planCalls()).toHaveLength(2)
  })

  // Break caught: no `review` in USER_EVENTS (400), refs flattened to a string or dropped by FIELD_ORDER, or action/refs reordered before existing keys.
  test('a review event reaches the CLI with action and refs as a JSON array', async () => {
    const w = world()
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'review', action: 'open' }, '{"type":"review","action":"open"}'],
      [{ action: 'post', refs: ['CM12', 'CM3'], type: 'review' }, '{"type":"review","action":"post","refs":["CM12","CM3"]}'],
      [{ type: 'review', action: 'pull', node: 'Q1', text: 'x', ref: 'CM1' }, '{"type":"review","action":"pull"}'],
      [{ type: 'review', action: 'post', refs: [] }, '{"type":"review","action":"post","refs":[]}'],
      [{ proposals: { CM12: 31, CM3: 4 }, refs: ['CM12', 'CM3'], action: 'post', type: 'review' }, '{"type":"review","action":"post","refs":["CM12","CM3"],"proposals":{"CM12":31,"CM3":4}}'],
    ]
    for (const [body] of cases) expect([body, (await w.event('1017-run', body)).status]).toEqual([body, 200])
    expect(w.planCalls()).toEqual(cases.map(([, json]) => ANSWER_ARGV('1017-run', json)))
  })

  // Break caught: refs accepted as a string/object, a list too long or with a long/multi-line/control entry, or a non-string action.
  test('refs must be a list of at most 20 one-line strings of at most 16 characters; action must be a string', async () => {
    const w = world()
    const bad: [Record<string, unknown>, string][] = [
      [{ type: 'review', action: 'post', refs: 'CM1' }, 'refs'],
      [{ type: 'review', action: 'post', refs: { 0: 'CM1' } }, 'refs'],
      [{ type: 'review', action: 'post', refs: 7 }, 'refs'],
      [{ type: 'review', action: 'post', refs: ['CM1', 2] }, 'refs'],
      [{ type: 'review', action: 'post', refs: [['CM1']] }, 'refs'],
      [{ type: 'review', action: 'post', refs: [null] }, 'refs'],
      [{ type: 'review', action: 'post', refs: Array.from({ length: 21 }, (_, i) => `CM${i}`) }, 'refs'],
      [{ type: 'review', action: 'post', refs: ['C'.repeat(17)] }, 'refs'],
      [{ type: 'review', action: 'post', refs: ['CM1\nCM2'] }, 'refs'],
      [{ type: 'review', action: 'post', refs: ['CM1\r'] }, 'refs'],
      [{ type: 'review', action: 'post', refs: ['CM\u20281'] }, 'refs'],
      [{ type: 'review', action: 'post', refs: ['CM\u00001'] }, 'refs'],
      [{ type: 'review', action: 'post', refs: ['CM\u001b[31m'] }, 'refs'],
      [{ type: 'review', action: 4 }, 'action'],
      [{ type: 'review', action: ['open'] }, 'action'],
    ]
    for (const [body, key] of bad) {
      const res = await w.event('1017-run', body)
      expect([body, res.status, ((await res.json()) as { error: string }).error]).toEqual([body, 400, expect.stringContaining(key)])
    }
    expect(w.planCalls()).toEqual([])
    const twenty = Array.from({ length: 20 }, (_, i) => `CM${i}`)
    expect((await w.event('1017-run', { type: 'review', action: 'post', refs: [...twenty.slice(0, 19), 'C'.repeat(16)] })).status).toBe(200)
    expect((await w.event('1017-run', { type: 'review', action: 'post', refs: twenty })).status).toBe(200)
    expect(w.planCalls()).toHaveLength(2)
  })

  // Break caught: proposals dropped or reshaped by the allow-list (the core would then refuse every Post), or accepted as a string, a list, a float or a long or multi-line key.
  test('proposals must be an object of at most 20 one-line refs of at most 16 characters to integers', async () => {
    const w = world()
    const bad: Record<string, unknown>[] = [
      { type: 'review', action: 'post', refs: ['CM1'], proposals: 'CM1' },
      { type: 'review', action: 'post', refs: ['CM1'], proposals: [4] },
      { type: 'review', action: 'post', refs: ['CM1'], proposals: 4 },
      { type: 'review', action: 'post', refs: ['CM1'], proposals: { CM1: '4' } },
      { type: 'review', action: 'post', refs: ['CM1'], proposals: { CM1: 4.5 } },
      { type: 'review', action: 'post', refs: ['CM1'], proposals: { CM1: null } },
      { type: 'review', action: 'post', refs: ['CM1'], proposals: { CM1: [4] } },
      { type: 'review', action: 'post', refs: ['CM1'], proposals: { ['C'.repeat(17)]: 4 } },
      { type: 'review', action: 'post', refs: ['CM1'], proposals: { 'CM1\nCM2': 4 } },
      { type: 'review', action: 'post', refs: ['CM1'], proposals: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`CM${i}`, i])) },
    ]
    for (const body of bad) {
      const res = await w.event('1017-run', body)
      expect([body.proposals, res.status, ((await res.json()) as { error: string }).error]).toEqual([body.proposals, 400, expect.stringContaining('proposals')])
    }
    expect(w.planCalls()).toEqual([])
    const twenty = Array.from({ length: 20 }, (_, i) => `CM${i}`)
    const all = Object.fromEntries(twenty.map((ref, i) => [ref, i]))
    expect((await w.event('1017-run', { type: 'review', action: 'post', refs: twenty, proposals: all })).status).toBe(200)
    expect(w.planCalls()).toHaveLength(1)
  })

  // Break caught: proposals accepted on another event type (it would reach the CLI, which refuses it for a non-post review).
  test('proposals on any other event type is 400', async () => {
    const w = world()
    for (const body of [
      { type: 'note', text: 'x', proposals: { CM1: 4 } },
      { type: 'comment_accept', ref: 'CM1', proposal: 4, proposals: { CM1: 4 } },
      { type: 'approve_prd', proposals: {} },
    ]) {
      const res = await w.event('1017-run', body)
      expect([body.type, res.status, ((await res.json()) as { error: string }).error]).toEqual([body.type, 400, expect.stringContaining('proposals')])
    }
    expect(w.planCalls()).toEqual([])
  })

  // Break caught: refs accepted on another event type (it would reach the CLI), or a list let through where every other field must be a string.
  test('refs on any other event type is 400, and no other field accepts a list', async () => {
    const w = world()
    for (const body of [
      { type: 'note', text: 'x', refs: ['CM1'] },
      { type: 'comment', text: 'x', refs: ['CM1'] },
      { type: 'approve_prd', refs: [] },
      { type: 'answer', node: 'Q1', choice: 'recommended', refs: 'CM1' },
    ]) {
      const res = await w.event('1017-run', body)
      expect([body.type, res.status, ((await res.json()) as { error: string }).error]).toEqual([body.type, 400, expect.stringContaining('refs')])
    }
    for (const [body, key] of [
      [{ type: 'note', text: ['a'] }, 'text'],
      [{ type: 'note', text: 'x', node: ['Q1'] }, 'node'],
      [{ type: 'ask', text: 'x', node: ['Q1'] }, 'node'],
    ] as const) {
      const res = await w.event('1017-run', body)
      expect([key, res.status, await res.json()]).toEqual([key, 400, { error: `${key} must be a string` }])
    }
    expect(w.planCalls()).toEqual([])
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

  // Break caught: a nudge built from the posted event (author, comment text) instead of the CLI summary, leaking a teammate's name or words into the lead's prompt.
  test('a comment from a named teammate nudges the lead with the CLI summary only: no name, no text', async () => {
    const w = world()
    w.set('event.out', '{"ok":true,"rev":16,"event":{},"summary":"comment CM3 added"}')
    const res = await w.event('1017-run', { type: 'comment', text: 'Zebulon says: drop the Kafka dependency', author: 'Zebulon Quirke', anchor: 'Q4' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, rev: 16, summary: 'comment CM3 added', nudge: 'scheduled' })
    await until(() => w.sends().length >= 2)
    expect(w.sends()[0]![5]).toBe('From Plan (user): 1 change(s) on 1017-run: comment CM3 added. Run: plan news 1017-run')
    const typed = w.sends().map(c => c.join(' ')).join('\n')
    for (const leak of ['Zebulon', 'Quirke', 'Kafka', 'drop the']) expect(typed).not.toContain(leak)
  })

  // Break caught: a nudge built from the posted event (the refs) instead of the CLI summary.
  test('a review post nudges the lead with the CLI summary only: no refs', async () => {
    const w = world()
    w.set('event.out', '{"ok":true,"rev":17,"event":{},"summary":"review post requested"}')
    const res = await w.event('1017-run', { type: 'review', action: 'post', refs: ['CM41', 'CM77'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, rev: 17, summary: 'review post requested', nudge: 'scheduled' })
    await until(() => w.sends().length >= 2)
    expect(w.sends()[0]![5]).toBe('From Plan (user): 1 change(s) on 1017-run: review post requested. Run: plan news 1017-run')
    const typed = w.sends().map(c => c.join(' ')).join('\n')
    for (const leak of ['CM41', 'CM77', 'refs']) expect(typed).not.toContain(leak)
  })

  // Break caught: summaries inlined until the line fills the composer (QA4 F1: 330 characters wrapped over rows and lost its Enter).
  test('five long summaries make one short line that keeps the task id and the plan news hint', async () => {
    const w = world()
    w.set('event.out', JSON.stringify({ ok: true, rev: 20, event: {}, summary: `answered Q2: ${'z'.repeat(90)}` }))
    for (let i = 0; i < 5; i++) await w.event('1017-run', { type: 'note', text: `n${i}` })
    await until(() => w.sends().length >= 2)
    expect(w.sends()[0]![5]).toBe('From Plan (user): 5 change(s) on 1017-run. Run: plan news 1017-run')
  })

  // Break caught: the short form repeating a long task id (170 characters for a 60-character id) and so passing the composer line it was meant to fit.
  test('a 60-character task id still gets a nudge of at most 160 characters that ends with the plan news hint', async () => {
    const w = world()
    const id = `1017-${'x'.repeat(55)}`
    mkdirSync(`${w.crew}/${id}/plan`, { recursive: true })
    writeFileSync(`${w.crew}/${id}/meta`, 'lead=acme-gateway-lead\nrepo=/home/x/acme-gateway\n')
    writeFileSync(`${w.crew}/${id}/status`, '2026-10-16T11:57:00Z\trunning\n')
    writeFileSync(`${w.crew}/${id}/plan/plan.json`, JSON.stringify(PLAN_JSON))
    w.set('ls.txt', ['RUNNING', `  ${id}   running  2m  ship  acme-gateway  working`, ''].join('\n'))
    w.set('event.out', JSON.stringify({ ok: true, rev: 20, event: {}, summary: `answered Q2: ${'z'.repeat(90)}` }))
    expect((await w.event(id, ANSWER)).status).toBe(200)
    await until(() => w.sends().length >= 2)
    expect(w.sends()[0]![5]).toBe(`From Plan (user): 1 change(s). Run: plan news ${id}`)
    expect(w.sends()[0]![5]!.length).toBeLessThanOrEqual(160)
  })

  // Break caught: the short form losing the bound (a summary of 160 characters or more typed as it is) or applying it too early.
  test('summaries that fit in 160 characters stay in the line; one character more and they do not', async () => {
    const w = world({ nudgeMs: 50 })
    const fits = 160 - 'From Plan (user): 1 change(s) on 1017-run: '.length - '. Run: plan news 1017-run'.length
    w.set('event.out', JSON.stringify({ ok: true, rev: 20, event: {}, summary: 'a'.repeat(fits) }))
    await w.event('1017-run', ANSWER)
    await until(() => w.sends().length >= 2)
    expect(w.sends()[0]![5]!.length).toBe(160)
    expect(w.sends()[0]![5]).toContain('aaa')
    w.set('event.out', JSON.stringify({ ok: true, rev: 21, event: {}, summary: 'a'.repeat(fits + 1) }))
    await w.event('1017-run', ANSWER)
    await until(() => w.sends().length >= 4)
    expect(w.sends()[2]![5]).toBe('From Plan (user): 1 change(s) on 1017-run. Run: plan news 1017-run')
  })

  test('a summary is one line, free of escapes, and still ends with the plan news hint', async () => {
    const w = world()
    w.set('event.out', JSON.stringify({ ok: true, rev: 16, event: {}, summary: 'noted line one\nline two \u001b[31mred\u001b[0m' }))
    expect((await w.event('1017-run', { type: 'note', text: 'x' })).status).toBe(200)
    await until(() => w.sends().length >= 2)
    const typed = w.sends()[0]![5]!
    expect(typed).not.toMatch(/[\u0000-\u001f]/)
    expect(typed).toBe('From Plan (user): 1 change(s) on 1017-run: noted line one line two [31mred[0m. Run: plan news 1017-run')
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
    const w = world({ retry: { ms: 20, windowMs: 400 } })
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

// A nudge the pane refuses is not lost: it is retried until it is typed or the window runs out.
describe('the session nudge, retried', () => {
  const DIALOG = ['Edit file?', '❯ 1. Yes', '  2. No', 'Esc to cancel'].join('\n')
  const RETRY = { ms: 40, windowMs: 3000 }
  const logs = () => {
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args.join(' '))

    return { logged, restore: () => (console.error = original) }
  }
  const LINE = (n: number, list: string) => `From Plan (user): ${n} change(s) on 1017-run: ${list}. Run: plan news 1017-run`

  // Break caught: a refused send (dialog open in the pane) only logged and dropped, so the session never hears of the page answer.
  test('a send refused by an open dialog is retried and typed once the pane is free: one line in total', async () => {
    const w = world({ nudgeMs: 50, retry: RETRY })
    w.set('pane.txt', DIALOG)
    w.set('event.out', '{"ok":true,"rev":16,"event":{},"summary":"answered Q7: Last-write-wins"}')
    expect((await w.event('1017-run', ANSWER)).status).toBe(200)
    await until(() => w.captures() >= 2)
    expect(w.sends()).toEqual([])

    w.set('pane.txt', COMPOSER)
    await until(() => w.sends().length >= 2)
    await wait(RETRY.ms * 4)
    expect(w.sends()).toEqual([
      ['send-keys', '-t', 'claude:1.0', '-l', '--', LINE(1, 'answered Q7: Last-write-wins')],
      ['send-keys', '-t', 'claude:1.0', 'Enter'],
    ])
  })

  // Break caught: the retry replaying only the first burst, or one line per event, once more events arrive while the pane is blocked.
  test('events that arrive while the nudge is being retried join it: still one line, with every summary', async () => {
    const w = world({ nudgeMs: 50, retry: RETRY })
    w.set('pane.txt', DIALOG)
    w.set('event.out', '{"ok":true,"rev":16,"event":{},"summary":"answered Q7: Last-write-wins"}')
    await w.event('1017-run', ANSWER)
    await until(() => w.captures() >= 1)
    w.set('event.out', '{"ok":true,"rev":17,"event":{},"summary":"parked Q9"}')
    await w.event('1017-run', { type: 'park', node: 'Q9' })
    await until(() => w.captures() >= 3)

    w.set('pane.txt', COMPOSER)
    await until(() => w.sends().length >= 2)
    await wait(RETRY.ms * 4 + 200)
    expect(w.sends()).toEqual([
      ['send-keys', '-t', 'claude:1.0', '-l', '--', LINE(2, 'answered Q7: Last-write-wins; parked Q9')],
      ['send-keys', '-t', 'claude:1.0', 'Enter'],
    ])
  })

  // Break caught: a task that is not on the board retried for the whole window (a retry storm), or logged on every attempt.
  test('a task that is not on the board is not retried: one error line, no further board reads', async () => {
    const w = world({ nudgeMs: 50, retry: RETRY })
    mkdirSync(`${w.crew}/ghost/plan`, { recursive: true })
    writeFileSync(`${w.crew}/ghost/plan/plan.json`, JSON.stringify(PLAN_JSON))
    const { logged, restore } = logs()
    try {
      expect((await w.event('ghost', ANSWER)).status).toBe(200)
      await until(() => logged.length >= 1)
      const reads = w.crewCalls()
      await wait(RETRY.ms * 6)
      expect(w.crewCalls()).toBe(reads)
    } finally {
      restore()
    }
    expect(logged).toEqual(['hq-web: plan nudge for ghost not sent: the task is not on the board'])
    expect(w.sends()).toEqual([])
  })

  // Break caught: no cap on the retries (a blocked pane retried forever), or one error line per failed attempt.
  test('when the window runs out the retries stop, with the error logged once', async () => {
    const w = world({ nudgeMs: 50, retry: { ms: 20, windowMs: 400 } })
    w.set('pane.txt', DIALOG)
    const { logged, restore } = logs()
    try {
      expect((await w.event('1017-run', ANSWER)).status).toBe(200)
      await until(() => logged.length >= 1)
      await wait(100)
      const attempts = w.captures()
      expect(attempts).toBeGreaterThanOrEqual(2)
      await wait(300)
      expect(w.captures()).toBe(attempts)
    } finally {
      restore()
    }
    expect(logged).toEqual(['hq-web: plan nudge for 1017-run not sent: a prompt is open in the pane: answer it in tmux (❯ 1. Yes)'])
    expect(w.sends()).toEqual([])
  })

  // Break caught: a failure after `send-keys -l` retried like a refusal, typing the whole nudge into the pane again on every attempt.
  test('a failure after the text was typed is not retried: one send-keys -l, the error logged once', async () => {
    const w = world({ nudgeMs: 50, retry: RETRY })
    w.set('pane.txt', '● Done.\n')
    const { logged, restore } = logs()
    try {
      expect((await w.event('1017-run', ANSWER)).status).toBe(200)
      await until(() => logged.length >= 1)
      await wait(RETRY.ms * 6)
    } finally {
      restore()
    }
    expect(w.sends().map(c => c[3])).toEqual(['-l'])
    expect(logged).toEqual(['hq-web: plan nudge for 1017-run not sent: the text did not show up in the composer: Enter was not pressed, and the text may still be there'])
  })

  // Break caught: a `send-keys -l` that itself fails (tmux may have taken some keys, the 10 s timeout too) not marked typed, so the retry types the nudge again.
  test('a send-keys -l that fails is not retried: one -l call, the error logged once', async () => {
    const w = world({ nudgeMs: 50, retry: RETRY })
    const tmux = `${w.dir}/bin/tmux`
    writeFileSync(tmux, readFileSync(tmux, 'utf8').replace('case "$1" in\n', 'if [ "$1" = send-keys ] && [ "$4" = -l ]; then echo boom >&2; exit 1; fi\ncase "$1" in\n'))
    const { logged, restore } = logs()
    try {
      expect((await w.event('1017-run', ANSWER)).status).toBe(200)
      await until(() => logged.length >= 1)
      await wait(RETRY.ms * 6)
    } finally {
      restore()
    }
    expect(w.sends().map(c => c[3])).toEqual(['-l'])
    expect(logged).toEqual(['hq-web: plan nudge for 1017-run not sent: tmux send-keys failed: boom'])
  })

  // The fake pane draws the composer the way Claude Code does on a narrow screen: the first 60 characters on the `❯` row, then the
  // rest on a row indented by two spaces (the break eats the space), which `capture-pane -J` does not join. `noecho` hides the typed text.
  const wrapComposer = (w: ReturnType<typeof world>) => {
    const tmux = `${w.dir}/bin/tmux`
    const wrapped = `{ t = ENVIRON["T"]; n = match(substr(t, 1, 60), / [^ ]*$/); if (n > 0) { print "❯ " substr(t, 1, n - 1); print "  " substr(t, n + 1) } else print "❯ " t; next }`
    writeFileSync(tmux, readFileSync(tmux, 'utf8').replace('{ print "❯ " ENVIRON["T"]; next }', wrapped))
  }

  // Break caught: the composer check reading only the `❯` row, so a nudge that wraps onto a second row never gets its Enter (QA4 F1).
  test('a nudge that wraps over two composer rows still gets its Enter', async () => {
    const w = world({ nudgeMs: 50, retry: RETRY })
    wrapComposer(w)
    w.set('event.out', '{"ok":true,"rev":16,"event":{},"summary":"answered Q7: Last-write-wins"}')
    expect((await w.event('1017-run', ANSWER)).status).toBe(200)
    await until(() => w.sends().length >= 2)
    expect(w.sends()).toEqual([
      ['send-keys', '-t', 'claude:1.0', '-l', '--', LINE(1, 'answered Q7: Last-write-wins')],
      ['send-keys', '-t', 'claude:1.0', 'Enter'],
    ])
  })

  // Break caught: a retry that types the nudge again, or presses Enter without the text being there, once the first attempt could not confirm it.
  test('a nudge typed but not seen in the composer: the retry presses Enter once, and types nothing', async () => {
    const w = world({ nudgeMs: 50, retry: { ms: 200, windowMs: 3000 } })
    wrapComposer(w)
    w.set('noecho', '')
    const { logged, restore } = logs()
    try {
      expect((await w.event('1017-run', ANSWER)).status).toBe(200)
      await until(() => logged.length >= 1)
      rmSync(`${w.dir}/noecho`)
      await until(() => w.sends().length >= 2)
      await wait(600)
    } finally {
      restore()
    }
    expect(w.sends().map(c => c[3] ?? c[4])).toEqual(['-l', 'Enter'])
  })

  // Break caught: the retry pressing Enter over whatever the composer holds, submitting words the user typed (or the nudge with the user's words around it).
  test('a nudge not seen in the composer is not submitted when the composer then holds something else', async () => {
    const w = world({ nudgeMs: 50, retry: { ms: 200, windowMs: 3000 } })
    wrapComposer(w)
    w.set('noecho', '')
    w.set('pane.txt', COMPOSER.replace('❯\u00a0', '❯ my own half-written question'))
    const { logged, restore } = logs()
    try {
      expect((await w.event('1017-run', ANSWER)).status).toBe(200)
      await until(() => logged.length >= 1)
      await wait(800)
    } finally {
      restore()
    }
    expect(w.sends().map(c => c[3] ?? c[4])).toEqual(['-l'])
    expect(logged.length).toBe(1)
  })

  // Break caught: the retry accepting any leading rows of the composer, so a nudge followed by a line the user then typed gets submitted with it.
  test('a nudge not seen in the composer is not submitted when the user typed more under it', async () => {
    const w = world({ nudgeMs: 50, retry: { ms: 200, windowMs: 3000 } })
    w.set('noecho', '')
    w.set('event.out', '{"ok":true,"rev":16,"event":{},"summary":"answered Q7: Last-write-wins"}')
    const { logged, restore } = logs()
    try {
      expect((await w.event('1017-run', ANSWER)).status).toBe(200)
      await until(() => logged.length >= 1)
      w.set('pane.txt', COMPOSER.replace('❯ ', `❯ ${LINE(1, 'answered Q7: Last-write-wins')}\n  and my own second line`))
      await wait(800)
    } finally {
      restore()
    }
    expect(w.sends().map(c => c[3] ?? c[4])).toEqual(['-l'])
  })

  // A composer the way Claude Code draws it: the rows given under the `❯` mark, between two rules (or none below, with `ruled` false).
  const composerOf = (rows: string[], ruled = true) =>
    ['● Done. All tests pass.', '', '────────────────', ...rows, ...(ruled ? ['────────────────', '  ⏵⏵ auto mode on (shift+tab to cycle)'] : [])].join('\n')
  const NUDGED = LINE(1, 'answered Q7: Last-write-wins')

  // Runs one nudge that is typed but never seen in the composer (`noecho`), then shows `pane` and gives the retry time to act.
  // Returns the keys sent.
  const lateScreen = async (pane: string, enterExpected: boolean) => {
    const w = world({ nudgeMs: 50, retry: { ms: 200, windowMs: 3000 } })
    w.set('noecho', '')
    w.set('event.out', '{"ok":true,"rev":16,"event":{},"summary":"answered Q7: Last-write-wins"}')
    const { logged, restore } = logs()
    try {
      expect((await w.event('1017-run', ANSWER)).status).toBe(200)
      await until(() => logged.length >= 1)
      w.set('pane.txt', pane)
      if (enterExpected) await until(() => w.sends().length >= 2)
      await wait(600)
    } finally {
      restore()
    }

    return w.sends().map(c => c[3] ?? c[4])
  }

  // Break caught: the composer ending at the first blank row, so a nudge followed by a blank line and instructions the user typed under it
  // (Shift+Enter twice) reads as the nudge alone and the late Enter submits the owner's unfinished text.
  test('a nudge not seen in the composer is not submitted when the user typed after a blank row under it', async () => {
    const keys = await lateScreen(composerOf([`❯\u00a0${NUDGED}`, '', '  user instructions']), false)
    expect(keys).toEqual(['-l'])
  })

  // Break caught: the whole-composer check refusing a composer that holds the nudge and only an empty row before the rule.
  test('a nudge not seen in the composer still gets its Enter when only an empty row follows it', async () => {
    const keys = await lateScreen(composerOf([`❯\u00a0${NUDGED}`, '']), true)
    expect(keys).toEqual(['-l', 'Enter'])
  })

  // Break caught: any row starting with a box-drawing dash closing the composer, so user text typed under the nudge that begins with `─`
  // reads as the rule and the late Enter submits it.
  test('a nudge not seen in the composer gets no Enter when the user typed a row starting with a dash character under it', async () => {
    const keys = await lateScreen(composerOf([`❯\u00a0${NUDGED}`, '', '  ─ user instructions: do not send yet']), false)
    expect(keys).toEqual(['-l'])
  })

  // Break caught: the whole-composer check accepting a composer with no rule below it, where the rows after the nudge cannot be told apart from the user's.
  test('a nudge not seen in the composer gets no Enter when no rule shows under the composer', async () => {
    const keys = await lateScreen(composerOf([`❯\u00a0${NUDGED}`], false), false)
    expect(keys).toEqual(['-l'])
  })

  // Break caught: a failing attempt that started later overwriting the retry burst's start (`newer.since = since`), so the retry window moves
  // later and the retries run past it. Every pane read takes 700 ms, and sends to one pane queue: attempt A (start 0) fails at 700 and arms
  // a retry for 1700; attempt B (start ~450, queued behind A) fails at 1400 into that retry burst; the retry fails at 2400. Measured from
  // 0, the window of 3150 ms allows no further retry (2400 + 1000 > 3150); measured from B's 450 it would allow a fourth attempt.
  test('two attempts that both fail do not move the retry window later', async () => {
    const w = world({ nudgeMs: 50, retry: { ms: 1000, windowMs: 3150 } })
    const tmux = `${w.dir}/bin/tmux`
    writeFileSync(tmux, readFileSync(tmux, 'utf8').replace('  capture-pane)\n', '  capture-pane)\n    sleep 0.7\n'))
    w.set('pane.txt', DIALOG)
    const { logged, restore } = logs()
    try {
      expect((await w.event('1017-run', ANSWER)).status).toBe(200)
      await wait(500)
      expect((await w.event('1017-run', { type: 'park', node: 'Q9' })).status).toBe(200)
      await wait(4200)
    } finally {
      restore()
    }
    expect(w.captures()).toBe(3)
    expect(logged.length).toBe(1)
  }, 10_000)

  // Break caught: schedule() arming a timer after dispose(), so a request still in flight at shutdown types into the pane.
  test('an event that is accepted after dispose() arms no nudge', async () => {
    const w = world({ nudgeMs: 50, retry: RETRY })
    let reads = 0
    const routes = createPlanRoutes({
      config: { crewRoot: w.crew, env: {}, planBin: `${w.dir}/bin/plan`, planNudgeMs: 50 } as never,
      source: { snapshot: async () => (reads++, { board: null }) } as never,
      json: (status, body) => Response.json(body, { status }),
      text: (status, body) => new Response(body, { status }),
      body: async req => (await req.json()) as Record<string, unknown>,
      page: html => new Response(html),
      leadFor: () => ({ lead: null, reason: 'unused' }),
    })
    routes.dispose()
    const req = new Request('http://x/api/plan/1017-run/event', { method: 'POST', body: JSON.stringify({ type: 'park', node: 'Q9' }) })
    expect((await routes(req, new URL(req.url)))!.status).toBe(200)
    await wait(300)
    expect(reads).toBe(0)
  })

  // Break caught: an unbounded summaries list during the five minute window; the head must still count every change.
  test('a thousand events for one task keep the burst bounded: the line is the short one and counts all of them', async () => {
    const w = world({ nudgeMs: 8000 })
    w.set('event.out', JSON.stringify({ ok: true, rev: 20, event: {}, summary: `noted ${'y'.repeat(100)}` }))
    for (let i = 0; i < 1000; i += 50) {
      const batch = await Promise.all(Array.from({ length: 50 }, () => w.event('1017-run', { type: 'note', text: 'n' })))
      expect(batch.every(r => r.status === 200)).toBe(true)
    }
    for (let waited = 0; w.sends().length < 2 && waited < 10_000; waited += 50) await wait(50)
    const typed = w.sends()[0]![5]!
    expect(typed).toBe('From Plan (user): 1000 change(s) on 1017-run. Run: plan news 1017-run')
  }, 30_000)

  // Break caught: dispose() (server stop) leaving a retry timer that later types into the pane.
  test('stopping the server cancels a retry that is waiting', async () => {
    const w = world({ nudgeMs: 50, retry: RETRY })
    w.set('pane.txt', DIALOG)
    const { logged, restore } = logs()
    try {
      await w.event('1017-run', ANSWER)
      await until(() => w.captures() >= 1)
      w.stop()
      await wait(RETRY.ms)
      const attempts = w.captures()
      w.set('pane.txt', COMPOSER)
      await wait(RETRY.ms * 5)
      expect(w.captures()).toBe(attempts)
    } finally {
      restore()
    }
    expect(w.sends()).toEqual([])
    expect(logged).toEqual([])
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
