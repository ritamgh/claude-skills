import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { run } from '../exec'
import { assertBindAllowed, loadToken, parseExtraHosts, startServer } from '../server'
import { cleanPane, promptOpen, sanitizeText } from '../tmux'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const TOKEN = 'test-token-0123456789'
const PAGE = '<html><script nonce="__NONCE__"></script></html>'
const dirs: string[] = []
const servers: { stop: (force?: boolean) => void }[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const LS = [
  'NEEDS YOU',
  '  1017-held-q   held     3m  ship  acme-gateway  D4 · need a go on the schema',
  '  1017-rev      review   1m  ship  acme-gateway  verified',
  'RUNNING',
  '  1017-run      running  2m  ship  acme-gateway  working',
  'RUNNING ELSEWHERE',
  '  claude acme-gateway-lead busy 1m ~/x',
  'DONE',
  '  1017-done     done     1h  ship  acme-gateway  lead verified: all green',
  '  1017-bare     done     2h  scout acme-gateway  four parts back',
  '',
].join('\n')

const SELECTION = [
  '● Bash(rm -rf build)',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for rm commands",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n')
const COMPOSER = ['● Done. All tests pass.', '', '────────────────', '❯\u00a0', '────────────────', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n')

// A scratch HOME-less world: fake crew, tmux-map, tmux and gh scripts that read their answers from files in `dir` and
// log every argv (one line per call, arguments joined by \x1f).
function world(opts: { map?: string; pane?: string; ls?: string; extraHosts?: string[]; tsLogin?: string } = {}) {
  const dir = mkdtempSync(`${tmpdir()}/hqweb-`)
  dirs.push(dir)
  const bin = `${dir}/bin`
  mkdirSync(bin)
  const transcript = `${dir}/lead.jsonl`
  writeFileSync(
    transcript,
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-16T11:59:00Z', message: { content: [{ type: 'text', text: 'Built it.\n\nNeeds you: pick the rollout order' }] } }) + '\n',
  )
  const map =
    opts.map ??
    [
      `acme-gateway-lead\tclaude:1.0\tw\t/home/x/acme-gateway\tbusy\t60\t${transcript}`,
      'scratch\tclaude:2.0\tw\t/home/x/scratch\tidle\t100000\t',
      'detached\t\t\t/home/x/other\tidle\t30\t',
    ].join('\n') + '\n'
  writeFileSync(`${dir}/ls.txt`, opts.ls ?? LS)
  writeFileSync(`${dir}/map.tsv`, map)
  writeFileSync(`${dir}/pane.txt`, opts.pane ?? COMPOSER)
  const script = (name: string, body: string) => {
    writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${body}\n`)
    chmodSync(`${bin}/${name}`, 0o755)
  }
  const log = (file: string) => `{ for a in "$@"; do printf '%s\\x1f' "$a"; done; printf '\\n'; } >> ${dir}/${file}`
  script(
    'crew',
    `case "$1" in ls) cat ${dir}/ls.txt;; deliver-answer) ${log('crew.log')}; printf '%s' "$CREW_DELIVER_KEY" > ${dir}/key.seen; if [ -f ${dir}/answer.fail ]; then echo "no such decision" >&2; exit 1; fi; cat ${dir}/deliver.out 2>/dev/null || echo nosub;;
spawn) ${log('crew.log')}; if [ -f ${dir}/spawn.fail ]; then cat ${dir}/spawn.fail >&2; exit 2; fi; printf 'id=1017-%s\\nwindow=claude:%s\\nchild=%s\\n' "$3" "$3" "$3";;
close) ${log('crew.log')}; printf '%s' "\${CREW_AS_USER-unset}" > ${dir}/close.env; if [ -f ${dir}/close.fail ]; then cat ${dir}/close.fail >&2; exit \$(cat ${dir}/close.exit 2>/dev/null || echo 3); fi; printf 'closed: %s, window claude:%s (@7)\\n' "$2" "$2";;
wake) ${log('crew.log')}; printf '%s' "\${CREW_AS_USER-unset}" > ${dir}/wake.env; if [ -f ${dir}/wake.fail ]; then cat ${dir}/wake.fail >&2; exit \$(cat ${dir}/wake.exit 2>/dev/null || echo 3); fi; printf 'woke %s in claude:%s (task 1017-%s)\\n' "$2" "$2" "$2";; esac`,
  )
  script('tmux-map', `cat ${dir}/map.tsv`)
  // capture-pane prints pane.txt, with its composer line (the one that starts with the prompt mark) holding what
  // send-keys -l typed; `onType.txt` replaces the pane at that moment (a dialog opening), `noecho` hides the typed text,
  // `slow` delays the typing. display-message answers with display.txt.
  script(
    'tmux',
    `${log('tmux.log')}
case "$1" in
  capture-pane)
    if [ -f ${dir}/frozen ] || [ -f ${dir}/noecho ] || [ ! -f ${dir}/typed.txt ]; then cat ${dir}/pane.txt
    else T="$(cat ${dir}/typed.txt)" awk '/^❯/ { print "❯ " ENVIRON["T"]; next } { print }' ${dir}/pane.txt; fi;;
  send-keys)
    if [ "$4" = -l ]; then
      [ -f ${dir}/slow ] && sleep 0.2
      printf '%s' "$6" > ${dir}/typed.txt
      if [ -f ${dir}/onType.txt ]; then cp ${dir}/onType.txt ${dir}/pane.txt; touch ${dir}/frozen; fi
    fi;;
  display-message) cat ${dir}/display.txt;;
esac
exit 0`,
  )
  script('gh', `printf '[{"number":7,"title":"Tidy the parser","repository":{"nameWithOwner":"acme/api"},"url":"https://x/7","updatedAt":"2026-10-16T09:00:00Z"}]'`)

  const crew = `${dir}/crew`
  const task = (id: string, files: Record<string, string>) => {
    mkdirSync(`${crew}/${id}`, { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(`${crew}/${id}/${name}`, text)
  }
  task('1017-held-q', { meta: 'lead=acme-gateway-lead\nrepo=/home/x/acme-gateway\n', 'hold.md': 'Need a go on the schema?\nmore detail\n', status: '2026-10-16T11:55:00Z\theld\tD4\n' })
  task('1017-rev', { status: '2026-10-16T11:58:00Z\treview\tverified\n' })
  task('1017-done', { 'summary.md': '# All green\n\nShipped **v2** with 12 tests.\n', 'report.md': 'long report', status: '2026-10-16T11:00:00Z\tdone\tok\n' })
  task('1017-bare', { 'report.md': 'Four parts came back.\nDetails.', status: '2026-10-16T10:00:00Z\tdone\tok\n' })
  task('1017-run', { status: '2026-10-16T11:57:00Z\trunning\n' })

  // A fake /proc: the pane's shell (500) with claude (501) in the foreground of its terminal.
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
    { host: '127.0.0.1', token: TOKEN, page: PAGE, crewBin: `${bin}/crew`, crewRoot: crew, tmuxMapBin: `${bin}/tmux-map`, tmuxBin: 'tmux', ghBin: `${bin}/gh`, env, now: () => NOW, cacheMs: 0, procRoot, settleMs: 300, ...(opts.extraHosts ? { extraHosts: opts.extraHosts, remotePort: 0 } : {}), ...(opts.tsLogin ? { tsLogin: opts.tsLogin } : {}) },
    0,
  )
  servers.push(server)
  const base = `http://127.0.0.1:${server.port}`
  const auth = { Authorization: `Bearer ${TOKEN}` }
  const calls = (file: string): string[][] =>
    existsSync(`${dir}/${file}`)
      ? readFileSync(`${dir}/${file}`, 'utf8')
          .split('\n')
          .filter(l => l !== '')
          .map(l => l.split('\x1f').slice(0, -1))
      : []
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth, ...headers }, body: JSON.stringify(body) })
  const sends = () => calls('tmux.log').filter(c => c[0] === 'send-keys')

  const remoteBase = `http://127.0.0.1:${server.remotePort}`

  return { dir, base, remoteBase, auth, calls, post, sends, server, proc, setDisplay: (t: string) => writeFileSync(`${dir}/display.txt`, t), setPane: (t: string) => writeFileSync(`${dir}/pane.txt`, t) }
}

describe('token and headers', () => {
  test('non-TTY startup prints the configured token file path, never the token', async () => {
    const dir = mkdtempSync(`${tmpdir()}/hqweb-startup-`)
    dirs.push(dir)
    const config = `${dir}/config`
    mkdirSync(`${config}/hq-web`, { recursive: true })
    const token = 'test-token-'.padEnd(40, 'x')
    writeFileSync(`${config}/hq-web/token`, token, { mode: 0o600 })
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/../server.ts`], {
      env: { HOME: dir, XDG_CONFIG_HOME: config, HQ_WEB_HOST: '127.0.0.1', HQ_WEB_PORT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ''
      while (!output.includes('\n')) {
        const { done, value } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
      }
      expect(output).not.toContain(token)
      expect(output).not.toContain('?t=')
      expect(output).toMatch(/^HQ web: http:\/\/127\.0\.0\.1:\d+\//)
      expect(output).toContain(`token in ${config}/hq-web/token`)
    } finally {
      child.kill()
      await child.exited
    }
  })

  test('a request without the token is 401, with the bearer token 200', async () => {
    const w = world()
    expect((await fetch(`${w.base}/api/board`)).status).toBe(401)
    expect((await fetch(`${w.base}/api/board`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(`${w.base}/api/board`, { headers: w.auth })).status).toBe(200)
    expect((await fetch(`${w.base}/`)).status).toBe(401)
  })

  test('?t= on the first load sets an HttpOnly SameSite=Strict cookie and redirects without the token; the cookie then works', async () => {
    const w = world()
    const first = await fetch(`${w.base}/?t=${TOKEN}`, { redirect: 'manual' })
    expect(first.status).toBe(302)
    expect(first.headers.get('location')).toBe('/')
    const cookie = first.headers.get('set-cookie')!
    expect(cookie).toContain(`hq_web=${TOKEN}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')

    const page = await fetch(`${w.base}/`, { headers: { Cookie: `hq_web=${TOKEN}` } })
    expect(page.status).toBe(200)
    const html = await page.text()
    const nonce = /nonce="([^"]+)"/.exec(html)![1]!
    expect(page.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`)
    expect((await fetch(`${w.base}/?t=nope`, { redirect: 'manual' })).status).toBe(401)
    expect((await fetch(`${w.base}/api/board?t=${TOKEN}`)).status).toBe(401)
  })

  test('a request addressed to another host name (DNS rebinding) is 403 even with the token', async () => {
    const w = world()
    const res = await fetch(`${w.base}/api/board`, { headers: { ...w.auth, Host: 'evil.example:80' } })
    expect(res.status).toBe(403)
  })

  test('a POST from another origin is 403 and sends nothing', async () => {
    const w = world()
    const res = await w.post('/api/send', { target: 'claude:1.0', text: 'hi' }, { Origin: 'http://evil.example' })
    expect(res.status).toBe(403)
    expect(w.sends()).toEqual([])
    const same = await w.post('/api/send', { target: 'claude:1.0', text: 'hi' }, { Origin: w.base })
    expect(same.status).toBe(200)
  })

  test('a POST that is not JSON is refused', async () => {
    const w = world()
    const res = await fetch(`${w.base}/api/send`, { method: 'POST', headers: { ...w.auth, 'Content-Type': 'text/plain' }, body: 'target=claude:1.0&text=hi' })
    expect(res.status).toBe(415)
    expect(w.sends()).toEqual([])
  })
})

const TS = 'example-tailnet.ts.net'

// The remote listener (HQ_WEB_REMOTE_PORT) is where `tailscale serve` points: every request on it is remote, whatever its Host says.
describe('remote listener (HQ_WEB_REMOTE_PORT + HQ_WEB_EXTRA_HOSTS, tailscale serve in front, HQ still on loopback)', () => {
  const remote = (extra: Record<string, string> = {}) => ({ Host: TS, Authorization: `Bearer ${TOKEN}`, ...extra })
  const json = { 'Content-Type': 'application/json' }

  test('parseExtraHosts lowercases, trims and drops empty entries; unset is none', () => {
    expect(parseExtraHosts(' Example-Tailnet.ts.net , ,phone.example ')).toEqual([TS, 'phone.example'])
    expect(parseExtraHosts(undefined)).toEqual([])
    expect(parseExtraHosts('')).toEqual([])
  })

  test('unset: there is no second listener, the ts.net Host is 403 on the main one and its cookie has no Secure, as before', async () => {
    const w = world()
    expect(w.server.remotePort).toBeUndefined()
    const res = await fetch(`${w.base}/api/board`, { headers: remote() })
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('unknown host')
    const boot = await fetch(`${w.base}/?t=${TOKEN}`, { redirect: 'manual' })
    expect(boot.headers.get('set-cookie')).not.toContain('Secure')
  })

  test('the main listener never accepts an extra host, even with a remote listener running', async () => {
    const w = world({ extraHosts: [TS] })
    const res = await fetch(`${w.base}/api/board`, { headers: remote() })
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('unknown host')
    expect((await fetch(`${w.base}/api/board`, { headers: w.auth })).status).toBe(200)
  })

  test('a loopback Host on the remote listener is 403 (host check and /api/send), and nothing is typed', async () => {
    const w = world({ extraHosts: [TS] })
    for (const host of [`localhost:${w.server.port}`, `127.0.0.1:${w.server.port}`, `localhost:${w.server.remotePort}`, '127.0.0.1']) {
      const board = await fetch(`${w.remoteBase}/api/board`, { headers: remote({ Host: host }) })
      expect([host, board.status, await board.text()]).toEqual([host, 403, 'unknown host'])
      const send = await fetch(`${w.remoteBase}/api/send`, { method: 'POST', headers: { ...remote({ Host: host }), ...json }, body: JSON.stringify({ target: 'claude:1.0', text: 'hi' }) })
      expect([host, send.status]).toEqual([host, 403])
    }
    expect(w.sends()).toEqual([])
  })

  test('the extra host (no port) may GET the page, the board and a result; a lookalike or ported Host is still 403', async () => {
    const w = world({ extraHosts: [TS] })
    expect((await fetch(`${w.remoteBase}/`, { headers: remote() })).status).toBe(200)
    const board = await fetch(`${w.remoteBase}/api/board`, { headers: remote() })
    expect(board.status).toBe(200)
    expect(((await board.json()) as { results: { id: string }[] }).results.map(r => r.id)).toContain('1017-done')
    expect((await fetch(`${w.remoteBase}/api/result/1017-done`, { headers: remote() })).status).toBe(200)
    for (const host of [`${TS}:7717`, `${TS}.evil.example`, TS.toUpperCase(), 'evil.example']) {
      expect([host, (await fetch(`${w.remoteBase}/api/board`, { headers: remote({ Host: host }) })).status]).toEqual([host, 403])
    }
  })

  test('the extra host without the token is 401, not served', async () => {
    const w = world({ extraHosts: [TS] })
    expect((await fetch(`${w.remoteBase}/api/board`, { headers: { Host: TS } })).status).toBe(401)
  })

  test('POST /api/answer on the remote listener delivers the answer; Origin https://<extra> passes, http://<extra>, a loopback origin and a stranger are 403', async () => {
    const w = world({ extraHosts: [TS] })
    const answer = (origin: string) => fetch(`${w.remoteBase}/api/answer`, { method: 'POST', headers: { ...remote({ Origin: origin }), ...json }, body: JSON.stringify({ did: 'D4', text: 'go' }) })
    expect((await answer(`http://${TS}`)).status).toBe(403)
    expect((await answer('https://evil.example')).status).toBe(403)
    expect((await answer(w.base)).status).toBe(403)
    expect(w.calls('crew.log')).toEqual([])
    expect((await answer(`https://${TS}`)).status).toBe(200)
    expect(w.calls('crew.log')).toEqual([['deliver-answer', '--did', 'D4', '--via', 'HQ', '--', 'go']])
  })

  test('every other write and the pane text are 403 on the remote listener and run nothing; the same calls work on the main one', async () => {
    const w = world({ extraHosts: [TS] })
    const post = (path: string, body: unknown, method = 'POST') => fetch(`${w.remoteBase}${path}`, { method, headers: { ...remote(), ...json }, body: JSON.stringify(body) })
    const denied = [
      await post('/api/send', { target: 'claude:1.0', text: 'hi' }),
      await post('/api/spawn', { repo: '/home/x/acme-gateway', slug: 'a', text: 'b' }),
      await post('/api/wake', { feature: 'f', text: 'b' }),
      await post('/api/close', { name: 'acme-gateway-lead' }),
      await post('/api/diff', { id: '1017-done' }),
      await post('/api/brand-new-write', {}),
      await post('/api/answer', { did: 'D4', text: 'go' }, 'PUT'),
      await post('/api/answer', {}, 'DELETE'),
      await fetch(`${w.remoteBase}/api/pane/${encodeURIComponent('claude:1.0')}`, { headers: remote() }),
      await fetch(`${w.remoteBase}/api/repos`, { headers: remote() }),
    ]
    expect(denied.map(r => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403, 403])
    expect(await denied[0]!.json()).toEqual({ error: 'not available from a remote host' })
    expect(w.sends()).toEqual([])
    expect(w.calls('crew.log')).toEqual([])
    expect(w.calls('tmux.log').filter(c => c[0] === 'capture-pane')).toEqual([])
    expect((await w.post('/api/send', { target: 'claude:1.0', text: 'hi' })).status).toBe(200)
    expect((await fetch(`${w.base}/api/pane/${encodeURIComponent('claude:1.0')}`, { headers: w.auth })).status).toBe(200)
  })

  test('the ?t= bootstrap on the remote listener sets Secure; on the main one the cookie has none', async () => {
    const w = world({ extraHosts: [TS] })
    const far = await fetch(`${w.remoteBase}/?t=${TOKEN}`, { redirect: 'manual', headers: { Host: TS } })
    expect(far.status).toBe(302)
    expect(far.headers.get('set-cookie')).toBe(`hq_web=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000; Secure`)
    const near = await fetch(`${w.base}/?t=${TOKEN}`, { redirect: 'manual' })
    expect(near.headers.get('set-cookie')).toBe(`hq_web=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`)
  })

  test('with HQ_WEB_TS_LOGIN the remote listener needs a matching Tailscale-User-Login (even for the bootstrap); the main one does not', async () => {
    const w = world({ extraHosts: [TS], tsLogin: 'me@example.com' })
    expect((await fetch(`${w.remoteBase}/api/board`, { headers: remote() })).status).toBe(403)
    expect((await fetch(`${w.remoteBase}/api/board`, { headers: remote({ 'Tailscale-User-Login': 'other@example.com' }) })).status).toBe(403)
    expect((await fetch(`${w.remoteBase}/?t=${TOKEN}`, { redirect: 'manual', headers: { Host: TS } })).status).toBe(403)
    expect((await fetch(`${w.remoteBase}/api/board`, { headers: remote({ 'Tailscale-User-Login': 'Me@Example.com' }) })).status).toBe(200)
    expect((await fetch(`${w.base}/api/board`, { headers: w.auth })).status).toBe(200)
  })

  test('without HQ_WEB_TS_LOGIN the login header is not asked for', async () => {
    const w = world({ extraHosts: [TS] })
    expect((await fetch(`${w.remoteBase}/api/board`, { headers: remote() })).status).toBe(200)
  })
})

describe('bind address and token file', () => {
  test('a non-loopback host is refused unless HQ_WEB_ALLOW_REMOTE=1', () => {
    expect(() => assertBindAllowed('0.0.0.0', {})).toThrow('not a loopback address')
    expect(() => assertBindAllowed('100.101.102.103', { HQ_WEB_ALLOW_REMOTE: '0' })).toThrow('HQ_WEB_ALLOW_REMOTE=1')
    expect(() => assertBindAllowed('100.101.102.103', { HQ_WEB_ALLOW_REMOTE: '1' })).not.toThrow()
    for (const ok of ['127.0.0.1', 'localhost', '::1', '127.0.0.2']) expect(() => assertBindAllowed(ok, {})).not.toThrow()
  })

  test('server.ts exits 1 with the reason when started on 0.0.0.0, and never creates a token', () => {
    const dir = mkdtempSync(`${tmpdir()}/hqweb-`)
    dirs.push(dir)
    const ran = Bun.spawnSync([process.execPath, `${import.meta.dir}/../server.ts`], {
      env: { PATH: process.env.PATH!, HOME: dir, XDG_CONFIG_HOME: `${dir}/cfg`, HQ_WEB_HOST: '0.0.0.0', HQ_WEB_PORT: '0' },
      timeout: 10_000,
    })
    expect(ran.exitCode).toBe(1)
    expect(ran.stderr.toString()).toContain('refusing to bind 0.0.0.0')
    expect(existsSync(`${dir}/cfg`)).toBe(false)
  })

  test('the token is made on first use with a 0700 directory and a 0600 file, and kept afterwards', () => {
    const dir = mkdtempSync(`${tmpdir()}/hqweb-`)
    dirs.push(dir)
    const file = `${dir}/cfg/hq-web/token`
    const token = loadToken(file)
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(`${dir}/cfg/hq-web`).mode & 0o777).toBe(0o700)
    expect(loadToken(file)).toBe(token)
  })
})

describe('board', () => {
  test('/api/board lays out needs, session cards with task rows and results from literal fixtures', async () => {
    const w = world()
    const res = await fetch(`${w.base}/api/board`, { headers: w.auth })
    expect(res.status).toBe(200)
    const view = await res.json()
    expect(view).toEqual({
      at: NOW,
      needs: [
        { kind: 'ask', tag: 'D4', what: 'acme-gateway · held-q', msg: 'Need a go on the schema?', taskId: '1017-held-q', decision: 'D4' },
        { kind: 'chat', tag: '(chat)', what: 'acme-gateway-lead', msg: 'pick the rollout order', session: 'acme-gateway-lead', target: 'claude:1.0' },
        { kind: 'pr', tag: 'PR', what: 'acme/api #7', msg: 'review requested: Tidy the parser' },
      ],
      total: 3,
      cards: [
        {
          session: { name: 'acme-gateway-lead', project: 'acme-gateway', state: 'busy', age: '1m', target: 'claude:1.0' },
          rows: [
            { id: '1017-held-q', kind: 'ask', name: 'held-q', state: 'held', note: 'D4' },
            { id: '1017-rev', kind: 'review', name: 'rev', state: 'verifying', note: '' },
            { id: '1017-run', kind: 'run', name: 'run', state: 'running', note: '2m' },
          ],
        },
        { session: { name: 'detached', project: 'other', state: 'idle', age: '30s', target: '' }, rows: [] },
      ],
      folded: 1,
      results: [
        { id: '1017-done', mark: '✓', name: 'done', project: 'acme-gateway', verdict: 'All green', at: Date.parse('2026-10-16T11:00:00Z') },
        { id: '1017-bare', mark: '✓', name: 'bare', project: 'acme-gateway', verdict: 'Four parts came back.', at: Date.parse('2026-10-16T10:00:00Z') },
      ],
    })
  })

  test('/api/board is 502 with the reason when crew ls fails', async () => {
    const w = world()
    writeFileSync(`${w.dir}/bin/crew`, '#!/bin/bash\necho "crew broke" >&2\nexit 3\n')
    const res = await fetch(`${w.base}/api/board`, { headers: w.auth })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'crew broke' })
  })
})

describe('result and pane', () => {
  test('/api/result prefers summary.md, then report.md, then the note; a bad or unknown id is refused', async () => {
    const w = world()
    const get = async (id: string) => {
      const res = await fetch(`${w.base}/api/result/${id}`, { headers: w.auth })

      return [res.status, await res.json().catch(() => null)]
    }
    expect(await get('1017-done')).toEqual([200, { id: '1017-done', source: 'summary', text: '# All green\n\nShipped **v2** with 12 tests.\n' }])
    expect(await get('1017-bare')).toEqual([200, { id: '1017-bare', source: 'report', text: 'Four parts came back.\nDetails.' }])
    expect(await get('1017-run')).toEqual([200, { id: '1017-run', source: 'note', text: 'working' }])
    expect((await get('a..b'))[0]).toBe(400)
    expect((await get('a%2Fb'))[0]).toBe(400)
    expect((await get('1017-nothing'))[0]).toBe(404)
  })

  test('/api/pane captures 200 lines of a live session with escape sequences removed; other targets are 403 or 400', async () => {
    const w = world({ pane: 'plain \u001b[31mred\u001b[0m text\u0007\n\u001b]0;title\u0007second\n' })
    const res = await fetch(`${w.base}/api/pane/${encodeURIComponent('claude:1.0')}`, { headers: w.auth })
    expect(await res.json()).toEqual({ target: 'claude:1.0', text: 'plain red text\nsecond\n', promptOpen: false })
    expect(w.calls('tmux.log').filter(c => c[0] === 'capture-pane')).toEqual([['capture-pane', '-p', '-J', '-S', '-200', '-t', 'claude:1.0']])

    expect((await fetch(`${w.base}/api/pane/claude:9.9`, { headers: w.auth })).status).toBe(403)
    expect((await fetch(`${w.base}/api/pane/${encodeURIComponent('a;b')}`, { headers: w.auth })).status).toBe(400)
    expect(w.calls('tmux.log').filter(c => c[0] === 'capture-pane').length).toBe(1)
  })

  test('/api/pane says when a prompt is open', async () => {
    const w = world({ pane: SELECTION })
    const res = await fetch(`${w.base}/api/pane/claude:1.0`, { headers: w.auth })
    expect((await res.json()).promptOpen).toBe(true)
  })
})

describe('send', () => {
  test('types the text with send-keys -l -- as one argv element, then Enter; control characters are stripped and no shell sees it', async () => {
    const w = world()
    const evil = 'run $(touch /tmp/pwn); `id` "q" \'s\' -x\u001b[31m\nsecond\tline\u0007\u0000'
    const res = await w.post('/api/send', { target: 'claude:1.0', text: evil })
    expect(res.status).toBe(200)
    expect(w.sends()).toEqual([
      ['send-keys', '-t', 'claude:1.0', '-l', '--', 'run $(touch /tmp/pwn); `id` "q" \'s\' -x[31m second line'],
      ['send-keys', '-t', 'claude:1.0', 'Enter'],
    ])
  })

  test('a target that tmux-map does not list as a live claude session is 403 and nothing is typed', async () => {
    const w = world()
    for (const target of ['claude:9.9', 'claude:0.0', 'claude:2.1']) {
      const res = await w.post('/api/send', { target, text: 'hi' })
      expect(res.status).toBe(403)
    }
    expect(w.sends()).toEqual([])
  })

  test('a target with shell or tmux syntax is 400 before tmux is asked anything', async () => {
    const w = world()
    for (const target of ['claude:1.0;reboot', '$(id)', 'a b', '']) {
      expect((await w.post('/api/send', { target, text: 'hi' })).status).toBe(400)
    }
    expect(w.calls('tmux.log')).toEqual([])
  })

  test('a pane with a permission prompt open is 409 with the marker line and nothing is typed', async () => {
    const w = world({ pane: SELECTION })
    const res = await w.post('/api/send', { target: 'claude:1.0', text: 'yes' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'a prompt is open in the pane: answer it in tmux', reason: '❯ 1. Yes' })
    expect(w.sends()).toEqual([])
  })

  test('empty and over-long text are refused', async () => {
    const w = world()
    expect((await w.post('/api/send', { target: 'claude:1.0', text: ' \n\u0007 ' })).status).toBe(400)
    expect((await w.post('/api/send', { target: 'claude:1.0', text: 'x'.repeat(2001) })).status).toBe(413)
    expect((await w.post('/api/send', { target: 'claude:1.0', text: 'x'.repeat(2000) })).status).toBe(200)
    expect(w.sends().length).toBe(2)
  })
})

describe('answer', () => {
  test('a task with no sub: records the answer with crew deliver-answer and relays the line to the lead session', async () => {
    const w = world()
    const res = await w.post('/api/answer', { did: 'D4', text: 'yes, go ahead' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, recorded: true, relayed: true, lead: 'acme-gateway-lead' })
    expect(w.calls('crew.log')).toEqual([['deliver-answer', '--did', 'D4', '--via', 'HQ', '--', 'yes, go ahead']])
    expect(w.sends()).toEqual([
      ['send-keys', '-t', 'claude:1.0', '-l', '--', 'From HQ (user): D4 answered. Answer: yes, go ahead'],
      ['send-keys', '-t', 'claude:1.0', 'Enter'],
    ])
  })

  test('a sub that crew typed the answer into is the one named, and the lead is not told; HQ passes the delivery key from the crew root', async () => {
    const w = world()
    writeFileSync(`${w.dir}/deliver.out`, 'delivered bravo\n')
    const res = await w.post('/api/answer', { did: 'D4', text: 'A' })
    expect(await res.json()).toEqual({ ok: true, recorded: true, relayed: true, lead: 'bravo' })
    expect(w.sends()).toEqual([])
    const key = readFileSync(`${w.dir}/crew/.deliver-key`, 'utf8')
    expect(key).toMatch(/^[0-9a-f]{48}$/)
    expect(readFileSync(`${w.dir}/key.seen`, 'utf8')).toBe(key)
    expect(statSync(`${w.dir}/crew/.deliver-key`).mode & 0o777).toBe(0o600)
  })

  test('an answer crew queued (the sub is busy or has a draft) is recorded and says why it has not arrived yet', async () => {
    const w = world()
    writeFileSync(`${w.dir}/deliver.out`, 'waiting busy\n')
    const res = await w.post('/api/answer', { did: 'D4', text: 'A' })
    expect(await res.json()).toEqual({ ok: true, recorded: true, relayed: false, lead: null, reason: 'busy' })
    expect(w.sends()).toEqual([])
  })

  test('a bad decision id never reaches crew; an id that is not open is 404', async () => {
    const w = world()
    for (const did of ['D4;ls', 'd4', '4', 'D', '../D4']) expect((await w.post('/api/answer', { did, text: 'x' })).status).toBe(400)
    expect((await w.post('/api/answer', { did: 'D9', text: 'x' })).status).toBe(404)
    expect((await w.post('/api/answer', { did: 'D4', text: '  ' })).status).toBe(400)
    expect(w.calls('crew.log')).toEqual([])
  })

  test('the answer stays recorded when the lead has a prompt open, and says why it was not relayed', async () => {
    const w = world({ pane: SELECTION })
    const res = await w.post('/api/answer', { did: 'D4', text: 'no' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      recorded: true,
      relayed: false,
      lead: 'acme-gateway-lead',
      reason: 'a prompt is open in the pane: answer it in tmux (❯ 1. Yes)',
    })
    expect(w.calls('crew.log')).toEqual([['deliver-answer', '--did', 'D4', '--via', 'HQ', '--', 'no']])
    expect(w.sends()).toEqual([])
  })

  test('a crew answer that fails is 502 and relays nothing', async () => {
    const w = world()
    writeFileSync(`${w.dir}/answer.fail`, '')
    const res = await w.post('/api/answer', { did: 'D4', text: 'yes' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'no such decision' })
    expect(w.sends()).toEqual([])
  })

  test('a lead that is only a guess is not told when the project has several sessions', async () => {
    const map = ['a\tclaude:1.0\tw\t/home/x/acme-gateway\tbusy\t60\t', 'b\tclaude:2.0\tw\t/home/x/acme-gateway\tidle\t90\t'].join('\n') + '\n'
    const w = world({ map })
    const res = await w.post('/api/answer', { did: 'D4', text: 'ok' })
    expect(await res.json()).toEqual({ ok: true, recorded: true, relayed: false, lead: null, reason: 'several sessions work on acme-gateway: tell the right one' })
    expect(w.calls('crew.log')).toEqual([['deliver-answer', '--did', 'D4', '--via', 'HQ', '--', 'ok']])
    expect(w.sends()).toEqual([])
  })
})

// The registry of feature owners and talk threads, as bin/crew-owners.sh writes it under the crew root.
function registry(dir: string) {
  const crew = `${dir}/crew`
  const owner = (id: string, lines: string[], notes?: string) => {
    mkdirSync(`${crew}/.owners/${id}`, { recursive: true })
    writeFileSync(`${crew}/.owners/${id}/owner`, lines.join('\n') + '\n')
    if (notes !== undefined) writeFileSync(`${crew}/.owners/${id}/notes.md`, notes)
  }
  const talk = (id: string, lines: string[]) => {
    mkdirSync(`${crew}/.talk/${id}`, { recursive: true })
    writeFileSync(`${crew}/.talk/${id}/meta`, lines.join('\n') + '\n')
  }
  owner('web', ['feature=web', 'repo=/home/x/acme-gateway', 'path=web/**', 'path=docs/', 'lead=acme-gateway-lead', 'state=asleep', 'slept_at=2026-10-16T10:00:00Z'], '# web notes\n\nRoutes done.\nNext: wire the Wake form\n\n')
  owner('api', ['feature=api', 'repo=/home/x/acme-gateway', 'path=api/**', 'lead=acme-gateway-lead', 'state=awake', 'slept_at=2026-10-16T09:00:00Z'], 'awake note\n')
  owner('infra', ['feature=infra', 'repo=/home/x/acme-gateway', 'path=infra/**', 'lead=gone-lead', 'state=asleep', 'slept_at=2026-10-15T12:00:00Z'], 'Terraform half done\n')
  talk('api--web--shared-types', ['a=api', 'b=web', 'topic=shared types', 'lead=acme-gateway-lead', 'cap=6', 'turns=2', 'state=open'])
  talk('api--infra--ports', ['a=api', 'b=infra', 'topic=ports', 'lead=gone-lead', 'cap=4', 'turns=4', 'state=capped'])
  talk('api--web--old', ['a=api', 'b=web', 'topic=old thing', 'lead=acme-gateway-lead', 'cap=6', 'turns=6', 'state=closed'])
  // a removed owner is not listed
  owner('.removed/web.1760000000', ['feature=web', 'lead=acme-gateway-lead', 'state=asleep', 'slept_at=2026-10-16T01:00:00Z'])
}

describe('feature owners and talk threads on the board', () => {
  test('an asleep owner and an open talk thread sit under their lead; an owner without a live lead goes with other crew', async () => {
    const w = world()
    registry(w.dir)
    const res = await fetch(`${w.base}/api/board`, { headers: w.auth })
    expect(res.status).toBe(200)
    const { cards } = (await res.json()) as { cards: { session?: { name: string }; owners?: unknown[]; talks?: unknown[] }[] }
    const lead = cards.find(c => c.session?.name === 'acme-gateway-lead')!
    expect(lead.owners).toEqual([{ feature: 'web', text: '☾ web · asleep 2h · Next: wire the Wake form' }])
    expect(lead.talks).toEqual(['talk: api↔web "shared types" (2/6)'])
    const other = cards.find(c => c.session === undefined)!
    expect(other.owners).toEqual([{ feature: 'infra', text: '☾ infra · asleep 1d · Terraform half done' }])
    expect(other.talks).toEqual(['talk: api↔infra "ports" (4/4) capped'])
    // an awake owner, a closed thread and a removed owner show nowhere; a card without any has neither field
    expect(JSON.stringify(cards)).not.toContain('old thing')
    expect(JSON.stringify(cards)).not.toContain('awake note')
    expect(cards.find(c => c.session?.name === 'scratch')).toBeUndefined()
  })

  test('the last note is found at the end of a notes file larger than what a head read would see', async () => {
    const w = world()
    registry(w.dir)
    writeFileSync(`${w.dir}/crew/.owners/web/notes.md`, `# web\n${'filler line\n'.repeat(20_000)}the very last note\n`)
    const { cards } = (await (await fetch(`${w.base}/api/board`, { headers: w.auth })).json()) as { cards: { session?: { name: string }; owners?: { text: string }[] }[] }
    expect(cards.find(c => c.session?.name === 'acme-gateway-lead')!.owners).toEqual([{ feature: 'web', text: '☾ web · asleep 2h · the very last note' }])
  })

  test('an idle session over a day old is still shown when an owner is asleep under it', async () => {
    const w = world()
    mkdirSync(`${w.dir}/crew/.owners/web`, { recursive: true })
    writeFileSync(`${w.dir}/crew/.owners/web/owner`, 'feature=web\nlead=scratch\nstate=asleep\nslept_at=2026-10-16T10:00:00Z\n')
    const { cards, folded } = (await (await fetch(`${w.base}/api/board`, { headers: w.auth })).json()) as { cards: { session?: { name: string }; owners?: unknown[] }[]; folded: number }
    expect(cards.find(c => c.session?.name === 'scratch')!.owners).toEqual([{ feature: 'web', text: '☾ web · asleep 2h' }])
    expect(folded).toBe(0)
  })

  test('an idle lead over a day old with no tasks still gets its card', async () => {
    const w = world()
    mkdirSync(`${w.dir}/crew/.links`)
    writeFileSync(`${w.dir}/crew/.links/sub-sid`, 'sub_name=scratch/child\nparent_name=scratch\nparent_sid=abc\n')
    const { cards, folded } = (await (await fetch(`${w.base}/api/board`, { headers: w.auth })).json()) as { cards: { session?: { name: string; project: string; age: string } }[]; folded: number }
    expect(cards.find(c => c.session?.name === 'scratch')!.session).toMatchObject({ project: 'scratch', age: '1d' })
    expect(folded).toBe(0)
  })

  test('an idle lead over a day old whose only task is not on the board any more still gets its card', async () => {
    const w = world()
    mkdirSync(`${w.dir}/crew/1015-gone`)
    writeFileSync(`${w.dir}/crew/1015-gone/meta`, 'repo=/home/x/scratch\nlead=scratch\n')
    const { cards, folded } = (await (await fetch(`${w.base}/api/board`, { headers: w.auth })).json()) as { cards: { session?: { name: string } }[]; folded: number }
    expect(cards.map(c => c.session?.name)).toContain('scratch')
    expect(folded).toBe(0)
  })

  test('a sub-lead (the sub of a chain link) idle over a day is folded, not given a card', async () => {
    const w = world()
    mkdirSync(`${w.dir}/crew/.links`)
    writeFileSync(`${w.dir}/crew/.links/sub-sid`, 'sub_name=scratch\nparent_name=acme-gateway-lead\nparent_sid=abc\n')
    const { cards, folded } = (await (await fetch(`${w.base}/api/board`, { headers: w.auth })).json()) as { cards: { session?: { name: string } }[]; folded: number }
    expect(cards.map(c => c.session?.name)).not.toContain('scratch')
    expect(folded).toBe(1)
  })

  test('a board without a registry has no owners or talks fields', async () => {
    const w = world()
    const { cards } = (await (await fetch(`${w.base}/api/board`, { headers: w.auth })).json()) as { cards: Record<string, unknown>[] }
    for (const c of cards) {
      expect(c.owners).toBeUndefined()
      expect(c.talks).toBeUndefined()
    }
  })
})

describe('wake an owner', () => {
  const text = '-x #{pane_id} $(id)'

  test('runs crew wake <feature> -- <text> as argv with CREW_AS_USER=1 and answers with what crew said', async () => {
    const w = world()
    const res = await w.post('/api/wake', { feature: 'web', text: `  ${text}  ` }, { Origin: w.base })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, queued: false, message: 'woke web in claude:web (task 1017-web)' })
    expect(w.calls('crew.log')).toEqual([['wake', 'web', '--', text]])
    expect(readFileSync(`${w.dir}/wake.env`, 'utf8')).toBe('1')
  })

  test('without the token it is 401 and crew is not run', async () => {
    const w = world()
    const res = await fetch(`${w.base}/api/wake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: 'web', text: 'go' }) })
    expect(res.status).toBe(401)
    expect(w.calls('crew.log')).toEqual([])
  })

  test('a POST from another origin is 403 and crew is not run', async () => {
    const w = world()
    expect((await w.post('/api/wake', { feature: 'web', text: 'go' }, { Origin: 'http://evil.example' })).status).toBe(403)
    expect(w.calls('crew.log')).toEqual([])
  })

  test('a bad feature, an empty or too long text or a missing field is 400 and never reaches crew', async () => {
    const w = world()
    for (const bad of [{ feature: 'Web', text: 'go' }, { feature: '-x', text: 'go' }, { feature: 'web', text: '   ' }, { feature: 'web', text: 'x'.repeat(2001) }, { feature: 'web' }, { text: 'go' }, { feature: 5, text: 'go' }, { feature: 'web', text: 5 }]) {
      expect((await w.post('/api/wake', bad)).status).toBe(400)
    }
    expect(w.calls('crew.log')).toEqual([])
  })

  test('a refusal by crew (exit 3) is 409 with its reason', async () => {
    const w = world()
    writeFileSync(`${w.dir}/wake.fail`, "crew: refused: owner 'web' is awake\n")
    const res = await w.post('/api/wake', { feature: 'web', text: 'go' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "refused: owner 'web' is awake" })
  })

  test("a user error of crew's (exit 2) is 409 and a timeout or a missing crew (124, 127) is 502", async () => {
    const w = world()
    writeFileSync(`${w.dir}/wake.fail`, 'crew: repo not found\n')
    for (const [code, status] of [['2', 409], ['124', 502], ['127', 502]] as const) {
      writeFileSync(`${w.dir}/wake.exit`, code)
      const res = await w.post('/api/wake', { feature: 'web', text: 'go' })
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ error: 'repo not found' })
    }
  })
})

describe('close a session', () => {
  test('runs crew close <name> as argv with CREW_AS_USER=1 and answers with what crew said', async () => {
    const w = world()
    const res = await w.post('/api/close', { name: 'user-b8/web' }, { Origin: w.base })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, message: 'closed: user-b8/web, window claude:user-b8/web (@7)' })
    expect(w.calls('crew.log')).toEqual([['close', 'user-b8/web']])
    expect(readFileSync(`${w.dir}/close.env`, 'utf8')).toBe('1')
  })

  test('without the token it is 401 and crew is not run', async () => {
    const w = world()
    const res = await fetch(`${w.base}/api/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'web' }) })
    expect(res.status).toBe(401)
    expect(w.calls('crew.log')).toEqual([])
  })

  test('a POST from another origin is 403 and crew is not run', async () => {
    const w = world()
    expect((await w.post('/api/close', { name: 'web' }, { Origin: 'http://evil.example' })).status).toBe(403)
    expect(w.calls('crew.log')).toEqual([])
  })

  test('on the remote (Tailscale) listener it is 403 with a valid token and a valid https Origin, and crew is not run', async () => {
    const w = world({ extraHosts: [TS] })
    const res = await fetch(`${w.remoteBase}/api/close`, { method: 'POST', headers: { Host: TS, Authorization: `Bearer ${TOKEN}`, Origin: `https://${TS}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'web' }) })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'not available from a remote host' })
    expect(w.calls('crew.log')).toEqual([])
  })

  test('a name that is missing, not a string, a flag or holds a shell word is 400 and never reaches crew', async () => {
    const w = world()
    for (const bad of [{}, { name: 5 }, { name: '' }, { name: '-x' }, { name: '--force-draft' }, { name: 'a b' }, { name: '$(id)' }]) {
      expect((await w.post('/api/close', bad)).status).toBe(400)
    }
    expect(w.calls('crew.log')).toEqual([])
  })

  test('a refusal by crew (exit 3) is 409 with its reason; a timeout or a missing crew (124, 127) is 502', async () => {
    const w = world()
    writeFileSync(`${w.dir}/close.fail`, 'crew: refused: web is busy (mid-turn): try again when it is idle\n')
    const refused = await w.post('/api/close', { name: 'web' })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'refused: web is busy (mid-turn): try again when it is idle' })
    for (const code of ['124', '127']) {
      writeFileSync(`${w.dir}/close.exit`, code)
      expect((await w.post('/api/close', { name: 'web' })).status).toBe(502)
    }
  })
})

describe('spawn a top-level lead', () => {
  const body = { repo: '/home/x/acme-gateway', slug: 'fix-login', text: 'Fix the "login" bug $(rm -rf x); it\'s `urgent`', model: 'sonnet' }

  test('a valid request runs crew spawn --top with the right argv and returns the window', async () => {
    const w = world()
    const res = await w.post('/api/spawn', body, { Origin: w.base })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, id: '1017-fix-login', window: 'claude:fix-login', queued: false })
    expect(w.calls('crew.log')).toEqual([['spawn', '--top', 'fix-login', '--repo', '/home/x/acme-gateway', '--model', 'sonnet', '--', body.text]])

    const bare = await w.post('/api/spawn', { repo: '/home/x/acme-gateway', slug: 'second', text: 'go' })
    expect(bare.status).toBe(200)
    expect(w.calls('crew.log')[1]).toEqual(['spawn', '--top', 'second', '--repo', '/home/x/acme-gateway', '--', 'go'])
  })

  test('without the token it is 401 and crew is not run', async () => {
    const w = world()
    const res = await fetch(`${w.base}/api/spawn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect(res.status).toBe(401)
    expect(w.calls('crew.log')).toEqual([])
  })

  test('a POST from another origin is 403 and crew is not run', async () => {
    const w = world()
    const res = await w.post('/api/spawn', body, { Origin: 'http://evil.example' })
    expect(res.status).toBe(403)
    expect(w.calls('crew.log')).toEqual([])
  })

  test('a bad slug, a relative repo, an empty text or a missing field is 400 and never reaches crew', async () => {
    const w = world()
    for (const bad of [{ ...body, slug: 'Fix Login' }, { ...body, slug: '-x' }, { ...body, repo: 'acme-gateway' }, { ...body, text: '  ' }, { ...body, model: '--x' }, { repo: body.repo, slug: 'ok-name' }, { ...body, model: 5 }]) {
      expect((await w.post('/api/spawn', bad)).status).toBe(400)
    }
    expect(w.calls('crew.log')).toEqual([])
  })

  test('a refusal by crew is 409 with its reason', async () => {
    const w = world()
    writeFileSync(`${w.dir}/spawn.fail`, 'crew: spawn refused: 5 live top-level leads started with spawn --top (max 5). Close one first.\n')
    const res = await w.post('/api/spawn', body)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'spawn refused: 5 live top-level leads started with spawn --top (max 5). Close one first.' })
  })

  test('/api/repos offers the folders of live sessions, not the home folder', async () => {
    const w = world()
    const res = await fetch(`${w.base}/api/repos`, { headers: w.auth })
    expect(await res.json()).toEqual({ repos: ['/home/x/acme-gateway', '/home/x/other', '/home/x/scratch'] })
  })
})

describe('prompt detection and text cleaning', () => {
  test('a normal composer, busy footer or prose that mentions a question is not a prompt', () => {
    expect(promptOpen(COMPOSER)).toBeNull()
    expect(promptOpen('✻ Working… (12s · esc to interrupt)\n❯ ')).toBeNull()
    expect(promptOpen('I asked: Do you want to proceed?\nThe plan has steps.\n❯ ')).toBeNull()
    expect(promptOpen('> 1. a quoted list item\n> 2. another')).toBeNull()
    expect(promptOpen('')).toBeNull()
  })

  test('selection dialogs are detected by the cursor option, the footer, or a question over numbered options', () => {
    expect(promptOpen(SELECTION)).toBe('❯ 1. Yes')
    expect(promptOpen('Which one?\n  Pick a color\n  Enter to select · ↑/↓ to navigate · Esc to cancel')).toBe('Enter to select · ↑/↓ to navigate · Esc to cancel')
    expect(promptOpen('Do you want to make this edit?\n  1. Yes\n  2. No')).toBe('Do you want to make this edit?')
    expect(promptOpen('Do you trust the files in this folder?\n  1. Yes, proceed')).toBe('Do you trust the files in this folder?')
  })

  test('a dialog that scrolled out of the bottom of the screen no longer blocks', () => {
    const old = [SELECTION, ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n')
    expect(promptOpen(old)).toBeNull()
  })

  test('sanitizeText flattens line breaks and drops control characters; cleanPane keeps newlines', () => {
    expect(sanitizeText('a\r\nb\tc\u001bd\u0007e\u0085f')).toBe('a b cdef')
    expect(cleanPane('x\u001b[1;32mgreen\u001b[0m\ty\n\u001b[2K\u0008z')).toBe('xgreen\ty\nz')
  })
})

describe('claude must own the pane', () => {
  test('a Ctrl-Z\'d claude (the shell is in the foreground) gets no keys and no pane read', async () => {
    const w = world()
    w.proc(500, 'zsh', 500, 500)
    w.setDisplay('500\tzsh\n')
    const sent = await w.post('/api/send', { target: 'claude:1.0', text: 'git status' })
    expect(sent.status).toBe(409)
    expect((await sent.json()).error).toContain('Claude is not in the foreground')
    const read = await fetch(`${w.base}/api/pane/claude:1.0`, { headers: w.auth })
    expect(read.status).toBe(409)
    expect(w.sends()).toEqual([])
    expect(w.calls('tmux.log').filter(c => c[0] === 'capture-pane')).toEqual([])
  })

  test('a pane whose foreground process group holds no claude is refused even when tmux names claude', async () => {
    const w = world()
    w.proc(500, 'zsh', 500, 777)
    w.proc(777, 'bash', 777, 777)
    expect((await w.post('/api/send', { target: 'claude:1.0', text: 'x' })).status).toBe(409)
    expect(w.sends()).toEqual([])
  })

  test('a background session (a version number as the command) in front is accepted; an unreadable /proc is refused', async () => {
    const w = world()
    w.proc(501, '2.1.301', 501, 501)
    w.setDisplay('500\t2.1.301\n')
    expect((await w.post('/api/send', { target: 'claude:1.0', text: 'x' })).status).toBe(200)
    rmSync(`${w.dir}/proc/500`, { recursive: true })
    expect((await w.post('/api/send', { target: 'claude:1.0', text: 'y' })).status).toBe(409)
  })
})

describe('the Enter is the last step', () => {
  test('a dialog that opens after the text is typed: no Enter, 409 that says the text is still in the composer', async () => {
    const w = world()
    writeFileSync(`${w.dir}/onType.txt`, SELECTION)
    const res = await w.post('/api/send', { target: 'claude:1.0', text: 'ship it' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'a prompt opened while typing: nothing more was sent, and the text is still in the composer', reason: '❯ 1. Yes' })
    expect(w.sends()).toEqual([['send-keys', '-t', 'claude:1.0', '-l', '--', 'ship it']])
  })

  test('text that never shows in the composer gets no Enter', async () => {
    const w = world()
    writeFileSync(`${w.dir}/noecho`, '')
    const res = await w.post('/api/send', { target: 'claude:1.0', text: 'ship it' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('did not show up in the composer')
    expect(w.sends()).toEqual([['send-keys', '-t', 'claude:1.0', '-l', '--', 'ship it']])
  })

  test('claude suspended between the typing and the Enter gets no Enter', async () => {
    const w = world()
    // the first display answers "claude", the second "zsh"
    writeFileSync(`${w.dir}/bin/tmux`, readFileSync(`${w.dir}/bin/tmux`, 'utf8').replace('display-message) cat', `display-message) if [ -f ${w.dir}/seen ]; then printf '500\\tzsh\\n'; else touch ${w.dir}/seen; cat`).replace('display.txt;;', 'display.txt; fi;;'))
    const res = await w.post('/api/send', { target: 'claude:1.0', text: 'ship it' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('Claude is not in the foreground')
    expect(w.sends().length).toBe(1)
  })

  test('two sends at once to one pane run one after the other: type, Enter, type, Enter', async () => {
    const w = world()
    writeFileSync(`${w.dir}/slow`, '')
    const [a, b] = await Promise.all([w.post('/api/send', { target: 'claude:1.0', text: 'first' }), w.post('/api/send', { target: 'claude:1.0', text: 'second' })])
    expect([a.status, b.status]).toEqual([200, 200])
    const order = w.sends().map(c => (c[3] === 'Enter' ? 'Enter' : c[5]))
    expect(order).toEqual(['first', 'Enter', 'second', 'Enter'])
  })
})

describe('token file and bounded reads', () => {
  test('an empty, blank or short token file is replaced with a fresh 0600 token', () => {
    for (const bad of ['', '  \n', 'short']) {
      const dir = mkdtempSync(`${tmpdir()}/hqweb-`)
      dirs.push(dir)
      mkdirSync(`${dir}/hq-web`, { mode: 0o700 })
      writeFileSync(`${dir}/hq-web/token`, bad, { mode: 0o644 })
      const token = loadToken(`${dir}/hq-web/token`)
      expect(token.length).toBeGreaterThanOrEqual(32)
      expect(readFileSync(`${dir}/hq-web/token`, 'utf8')).toBe(token)
      expect(statSync(`${dir}/hq-web/token`).mode & 0o777).toBe(0o600)
    }
  })

  test('an empty cookie or bearer never authenticates, even if the server\'s token were empty', async () => {
    const w = world()
    w.server.stop(true)
    const open = startServer({ host: '127.0.0.1', token: '', page: PAGE, crewBin: `${w.dir}/bin/crew`, crewRoot: `${w.dir}/crew`, tmuxMapBin: `${w.dir}/bin/tmux-map`, tmuxBin: 'tmux', env: {} }, 0)
    servers.push(open)
    const base = `http://127.0.0.1:${open.port}`
    expect((await fetch(`${base}/api/board`, { headers: { Cookie: 'hq_web=' } })).status).toBe(401)
    expect((await fetch(`${base}/?t=`, { redirect: 'manual' })).status).toBe(401)
    expect((await fetch(`${base}/api/board`, { headers: { Authorization: 'Bearer  ' } })).status).toBe(401)
  })

  test('a huge or endless task file is read only up to a bound', async () => {
    const w = world()
    rmSync(`${w.dir}/crew/1017-done/summary.md`)
    symlinkSync('/dev/zero', `${w.dir}/crew/1017-done/summary.md`)
    const res = await fetch(`${w.base}/api/result/1017-done`, { headers: w.auth })
    const body = await res.json()
    expect([res.status, body.source, body.text.length]).toEqual([200, 'summary', 20000])
  })
})

describe('run', () => {
  test('a timeout kills the whole process group and returns at once, though a descendant holds the pipes', async () => {
    const started = Date.now()
    const ran = await run(['bash', '-c', 'sleep 31.7 & sleep 31.7'], process.env, 300)
    expect(ran.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(3000)
    await Bun.sleep(100)
    const left = Bun.spawnSync(['pgrep', '-x', 'sleep', '-a'])
    expect(left.stdout.toString()).not.toContain('31.7')
  })
})
