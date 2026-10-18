#!/usr/bin/env bun
// HQ web: the crew board in a browser. Run `bun ~/.claude/mods/hq/web/server.ts`, open the URL it prints.
// Bind address is HQ_WEB_HOST (default 127.0.0.1), port HQ_WEB_PORT (default 7717); a host that is not loopback
// needs HQ_WEB_ALLOW_REMOTE=1. Every request needs the token in ~/.config/hq-web/token.
// HQ_WEB_REMOTE_PORT=<port> adds a second listener, always on 127.0.0.1, for `tailscale serve` to point at: whatever arrives there is remote (it is
// limited to REMOTE_ROUTES, gets a Secure cookie, and needs a Host from HQ_WEB_EXTRA_HOSTS=<name>[,<name>], no port). Remote-ness is the listener,
// never a header the client sends. The main port never accepts the extra hosts. HQ_WEB_TS_LOGIN=<login> makes the remote listener also need the
// Tailscale-User-Login header to match.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fchmodSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'

import { closeArgv, closeOutcome, isTarget, knownRepos, resolveLead, projectName, sessionProject, spawnArgv, spawnOutcome, wakeArgv, wakeOutcome } from '../hooks/board'
import type { HqBoard, HqSession, HqTask } from '../types'
import { createSource, isTaskId } from './data'
import type { Deps } from './data'
import { run } from './exec'
import { createPlanRoutes } from './plan'
import { MAX_TEXT, capture, claudeInForeground, inTmux, liveSessions, promptOpen, sanitizeText, sendText } from './tmux'

const COOKIE = 'hq_web'
const MAX_BODY = 16_384
const DECISION = /^D\d+$/
const MIN_TOKEN = 32
// The most of crew diff's output the page is sent.
const MAX_DIFF_TEXT = 1000

// The key that tells `crew deliver-answer` (the typed-answer delivery, not a command for models) that HQ or the input hook is calling.
// Made once, 0600, with a hard link that never replaces a key another process just made.
export function deliverKey(crewRoot: string): string {
  const file = `${crewRoot}/.deliver-key`
  const read = () => {
    try {
      return readFileSync(file, 'utf8').trim()
    } catch {
      return ''
    }
  }
  if (read() === '') {
    mkdirSync(crewRoot, { recursive: true })
    const tmp = `${file}.${process.pid}`
    writeFileSync(tmp, randomBytes(24).toString('hex'), { mode: 0o600 })
    try {
      linkSync(tmp, file)
    } catch {
      // another process made it first
    }
    rmSync(tmp, { force: true })
  }

  return read()
}

export const isLoopback = (host: string): boolean => host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)

// HQ_WEB_EXTRA_HOSTS: exact Host header values (no port) that may reach this server, e.g. the ts.net name `tailscale serve` forwards.
export const parseExtraHosts = (list: string | undefined): string[] => (list ?? '').split(',').map(h => h.trim().toLowerCase()).filter(h => h !== '')

// What a request addressed to an extra host may do. Anything not listed is refused, so a new route is closed to extra hosts until it is added here.
// No /api/pane (tmux text), /api/send, /api/spawn, /api/wake, /api/close, /api/diff or /api/repos: those type into or start Claude sessions, or show screens.
const REMOTE_ROUTES: { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/$/ },
  { method: 'GET', path: /^\/api\/board$/ },
  { method: 'GET', path: /^\/api\/result\/[^/]+$/ },
  { method: 'GET', path: /^\/plan(?:\/[^/]+)?$/ },
  { method: 'GET', path: /^\/api\/plans$/ },
  { method: 'GET', path: /^\/api\/plan\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/answer$/ },
  { method: 'POST', path: /^\/api\/plan\/[^/]+\/event$/ },
]

// Throws when the bind address would expose the board beyond this machine without HQ_WEB_ALLOW_REMOTE=1.
export function assertBindAllowed(host: string, env: Record<string, string | undefined>): void {
  if (!isLoopback(host) && env.HQ_WEB_ALLOW_REMOTE !== '1') {
    throw new Error(`refusing to bind ${host}: it is not a loopback address (set HQ_WEB_ALLOW_REMOTE=1 to allow it)`)
  }
}

// The token of ~/.config/hq-web/token, made on first use (directory 0700, file 0600).
export function loadToken(file: string): string {
  try {
    const kept = readFileSync(file, 'utf8').trim()
    if (kept.length >= MIN_TOKEN) return kept
  } catch {
    // not made yet
  }
  const dir = file.replace(/\/[^/]*$/, '')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const token = randomBytes(24).toString('base64url')
  // an empty or short file is replaced: a token that guesses easily is no token
  const fd = openSync(file, 'w', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, token)
  } finally {
    closeSync(fd)
  }

  return token
}

const digest = (s: string) => createHash('sha256').update(s).digest()
// An empty token on either side never matches.
const sameToken = (given: string, token: string): boolean => given !== '' && token !== '' && timingSafeEqual(digest(given), digest(token))

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers } })
const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS, ...headers } })

// `planBin` is the plan CLI, `planPage` the plan page's HTML (with __NONCE__); without them the plan routes answer 404.
// `planNudgeMs` is how long a burst of plan events is collected before the session is told (default 4000).
// `diffTimeoutMs` is a test seam for the Diff route (default 20 s).
// `remotePort` starts a second listener on 127.0.0.1 (0 picks a free port, see `remotePort` on the result) where `tailscale serve` points. Every request on
// it is remote: only REMOTE_ROUTES, https Origins, a Secure cookie, and a Host that is one of `extraHosts` (HQ_WEB_EXTRA_HOSTS; the main listener never
// takes them). `tsLogin` (HQ_WEB_TS_LOGIN) then also needs the Tailscale-User-Login header to be that login.
export type AppConfig = Deps & {
  token: string
  host: string
  page: string
  planBin?: string
  planPage?: string
  planNudgeMs?: number
  diffTimeoutMs?: number
  remotePort?: number
  extraHosts?: string[]
  tsLogin?: string
}

// The session to tell about a task: its lead, unless it is only a guess among several sessions of the project, or not in tmux.
function leadFor(board: HqBoard, task: HqTask): { session: HqSession } | { lead: string | null; reason: string } {
  const lead = resolveLead(board, task)
  const candidates = board.elsewhere.filter(s => s.kind === 'claude' && sessionProject(s.where) === projectName(task.repo))
  if (!lead) return { lead: null, reason: 'no live session leads this task' }
  if (lead.guessed && candidates.length > 1) return { lead: null, reason: `several sessions work on ${projectName(task.repo)}: tell the right one` }
  if (lead.session.target === '') return { lead: lead.session.name, reason: 'the lead is not in tmux' }

  return { session: lead.session }
}

// The page with a fresh nonce in its CSP.
function pageResponse(html: string): Response {
  const nonce = randomBytes(16).toString('base64')

  return new Response(html.replaceAll('__NONCE__', nonce), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      ...SECURITY_HEADERS,
    },
  })
}

export function startServer(config: AppConfig, port: number) {
  assertBindAllowed(config.host, config.env)
  const source = createSource(config)
  let listening = port

  const allowedHosts = () => {
    const names = new Set(['127.0.0.1', 'localhost', '[::1]', config.host.includes(':') ? `[${config.host}]` : config.host])

    return new Set([...names].map(n => `${n}:${listening}`))
  }
  const extraHosts = new Set(config.extraHosts ?? [])
  // An Origin is this listener's own: any scheme for the main one's loopback and bind names, https only for an extra host on the remote one (the front terminates TLS).
  const ownOrigin = (origin: string, remote: boolean): boolean => {
    const m = /^(https?):\/\/(.+)$/.exec(origin)

    return m !== null && (remote ? m[1] === 'https' && extraHosts.has(m[2]!) : allowedHosts().has(m[2]!))
  }
  const authed = (req: Request): boolean => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
    if (bearer && sameToken(bearer, config.token)) return true
    const cookie = (req.headers.get('cookie') ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(`${COOKIE}=`))

    return cookie !== undefined && sameToken(cookie.slice(COOKIE.length + 1), config.token)
  }

  async function body(req: Request): Promise<Record<string, unknown> | Response> {
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return text(415, 'send application/json')
    const raw = await req.text()
    if (raw.length > MAX_BODY) return text(413, 'body too large')
    try {
      const parsed = JSON.parse(raw)

      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : text(400, 'send a JSON object')
    } catch {
      return text(400, 'invalid JSON')
    }
  }

  const plan = createPlanRoutes({ config, source, json, text, body, page: pageResponse, leadFor })

  // `remote` is which listener the request came in on, not anything the client says.
  async function handle(req: Request, remote: boolean): Promise<Response> {
    const url = new URL(req.url)
    // DNS rebinding: a request must be addressed to this server by one of its own names.
    const host = req.headers.get('host') ?? ''
    if (!(remote ? extraHosts : allowedHosts()).has(host)) return text(403, 'unknown host')
    // Only sound because HQ binds loopback: `tailscale serve` is then the one writer of this header. A local process could set it, but could also read the token.
    if (remote && config.tsLogin !== undefined && (req.headers.get('tailscale-user-login') ?? '').toLowerCase() !== config.tsLogin.toLowerCase()) {
      return text(403, 'not your tailscale login')
    }

    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      if (!sameToken(url.searchParams.get('t') ?? '', config.token)) return text(401, 'unauthorized')
      url.searchParams.delete('t')
      const rest = url.searchParams.toString()

      return new Response(null, {
        status: 302,
        headers: {
          Location: `/${rest ? `?${rest}` : ''}`,
          'Set-Cookie': `${COOKIE}=${config.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${remote ? '; Secure' : ''}`,
          ...SECURITY_HEADERS,
        },
      })
    }
    if (!authed(req)) return text(401, 'unauthorized: open the URL the server printed, or send Authorization: Bearer <token>')

    if (remote && !REMOTE_ROUTES.some(r => r.method === req.method && r.path.test(url.pathname))) return json(403, { error: 'not available from a remote host' })

    if (req.method === 'POST') {
      // CSRF: a browser that sends an Origin must send this server's own.
      const origin = req.headers.get('origin')
      if (origin !== null && !ownOrigin(origin, remote)) return text(403, 'bad origin')
    }

    if (req.method === 'GET' && url.pathname === '/') return pageResponse(config.page)

    if (req.method === 'GET' && url.pathname === '/api/board') {
      try {
        return json(200, (await source.snapshot()).view)
      } catch (failure) {
        return json(502, { error: String(failure instanceof Error ? failure.message : failure) })
      }
    }

    const pane = /^\/api\/pane\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && pane) {
      let target = ''
      try {
        target = decodeURIComponent(pane[1]!)
      } catch {
        return json(400, { error: 'bad target' })
      }
      if (!isTarget(target)) return json(400, { error: 'bad target' })
      if (!inTmux(await liveSessions(config)).some(s => s.target === target)) return json(403, { error: 'not a live claude session in tmux' })
      if (!(await claudeInForeground(config, target))) return json(409, { error: 'Claude is not in the foreground of the pane' })
      const screen = await capture(config, target, 200)
      if (screen === null) return json(502, { error: 'could not read the pane' })

      return json(200, { target, text: screen, promptOpen: promptOpen(screen) !== null })
    }

    const result = /^\/api\/result\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && result) {
      let id = ''
      try {
        id = decodeURIComponent(result[1]!)
      } catch {
        return json(400, { error: 'bad task id' })
      }
      if (!isTaskId(id)) return json(400, { error: 'bad task id' })
      const found = await source.result(id, (await source.snapshot().catch(() => null))?.board ?? null)

      return found ? json(200, found) : json(404, { error: 'no such task' })
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      const data = await body(req)
      if (data instanceof Response) return data
      if (typeof data.target !== 'string' || typeof data.text !== 'string') return json(400, { error: 'send {target, text}' })
      const sent = await sendText(config, data.target, data.text)

      return sent.ok ? json(200, { ok: true }) : json(sent.status, { error: sent.error, ...(sent.reason ? { reason: sent.reason } : {}) })
    }

    if (req.method === 'POST' && url.pathname === '/api/answer') {
      const data = await body(req)
      if (data instanceof Response) return data
      if (typeof data.did !== 'string' || !DECISION.test(data.did) || typeof data.text !== 'string') return json(400, { error: 'send {did: "D<n>", text}' })
      const answer = sanitizeText(data.text)
      if (answer === '') return json(400, { error: 'empty answer' })
      if (Array.from(answer).length > MAX_TEXT) return json(413, { error: `answer is longer than ${MAX_TEXT} characters` })

      const { board } = await source.snapshot(true).catch(() => ({ board: null }))
      if (!board) return json(502, { error: 'the board could not be read' })
      const task = board.needsYou.find(t => t.decision === data.did)
      if (!task) return json(404, { error: `no open decision ${data.did}` })

      // Recorded and typed into the asking sub's pane as the user's words (queued by crew while that pane is busy or has a draft).
      const ran = await run([config.crewBin, 'deliver-answer', '--did', data.did, '--via', 'HQ', '--', answer], { ...config.env, CREW_DELIVER_KEY: deliverKey(config.crewRoot) }, 30_000)
      if (ran.code !== 0) return json(502, { error: ran.stderr.trim() || `crew deliver-answer exited ${ran.code}` })
      const said = ran.stdout.trim().split('\n')[0] ?? ''
      if (said.startsWith('delivered ')) return json(200, { ok: true, recorded: true, relayed: true, lead: said.slice('delivered '.length) })
      if (said.startsWith('waiting ')) return json(200, { ok: true, recorded: true, relayed: false, lead: null, reason: said.slice('waiting '.length) })
      if (said !== 'nosub') return json(404, { error: said || `no open decision ${data.did}` })

      // A task with no sub (the lead's own question): tell the lead what was decided. A lead that is only a guess by project is not told when the project has several sessions.
      const told = leadFor(board, task)
      let relay: { relayed: boolean; lead: string | null; reason?: string } = { relayed: false, ...('session' in told ? {} : told) }
      if ('session' in told) {
        const sent = await sendText(config, told.session.target, `From HQ (user): ${data.did} answered. Answer: ${answer}`)
        relay = sent.ok ? { relayed: true, lead: told.session.name } : { relayed: false, lead: told.session.name, reason: sent.reason ? `${sent.error} (${sent.reason})` : sent.error }
      }

      return json(200, { ok: true, recorded: true, ...relay })
    }

    if (req.method === 'POST' && url.pathname === '/api/diff') {
      const data = await body(req)
      if (data instanceof Response) return data
      if (typeof data.id !== 'string' || !isTaskId(data.id)) return json(400, { error: 'send {id: "<task id>"}' })

      const { board } = await source.snapshot(true).catch(() => ({ board: null }))
      if (!board) return json(502, { error: 'the board could not be read' })
      const blocked = await source.diffBlocker(data.id, board)
      if (blocked) return json(blocked.status, { error: blocked.error })

      const timeoutMs = config.diffTimeoutMs ?? 20_000
      const ran = await run([config.crewBin, 'diff', data.id, '--focus'], config.env, timeoutMs)
      if (ran.code === 124) return json(504, { error: `crew diff timed out after ${timeoutMs} ms` })
      if (ran.code !== 0) return json(502, { error: ran.stderr.trim().slice(0, MAX_DIFF_TEXT) || `crew diff exited ${ran.code}` })

      const line = ran.stdout.split('\n').map(l => l.trim()).filter(l => l !== '').pop() ?? 'opened'

      return json(200, { ok: true, message: line.slice(0, MAX_DIFF_TEXT) })
    }

    if (req.method === 'GET' && url.pathname === '/api/repos') {
      const { board } = await source.snapshot().catch(() => ({ board: null }))

      return json(200, { repos: knownRepos(await liveSessions(config), board, config.env.HOME ?? homedir()) })
    }

    // A new top-level lead: `crew spawn --top`, as argv, never a model turn. crew's own refusals (the cap, a bad folder) are 409.
    if (req.method === 'POST' && url.pathname === '/api/spawn') {
      const data = await body(req)
      if (data instanceof Response) return data
      if (typeof data.repo !== 'string' || typeof data.slug !== 'string' || typeof data.text !== 'string' || (data.model !== undefined && typeof data.model !== 'string')) {
        return json(400, { error: 'send {repo, slug, text, model?}' })
      }
      const built = spawnArgv(config.crewBin, { repo: data.repo, name: data.slug, text: data.text, model: data.model ?? '' }, config.env.HOME ?? homedir())
      if ('error' in built) return json(400, { error: built.error })

      const ran = await run(built.argv, config.env, 30_000)
      const outcome = spawnOutcome({ exitCode: ran.code, stdout: ran.stdout, stderr: ran.stderr })
      if (!outcome.ok) return json(ran.code === 124 || ran.code === 127 ? 502 : 409, { error: outcome.error })

      return json(200, outcome)
    }

    // Wake a sleeping feature owner: `crew wake <feature> -- <text>` as argv, as the user, never a model turn. crew's own refusals and user errors (exit 3, 2) are 409, a timeout or a missing crew (124, 127) 502.
    if (req.method === 'POST' && url.pathname === '/api/wake') {
      const data = await body(req)
      if (data instanceof Response) return data
      if (typeof data.feature !== 'string' || typeof data.text !== 'string') return json(400, { error: 'send {feature, text}' })
      const built = wakeArgv(config.crewBin, data.feature, data.text)
      if ('error' in built) return json(400, { error: built.error })

      const ran = await run(built.argv, { ...config.env, ...built.env }, 30_000)
      const outcome = wakeOutcome({ exitCode: ran.code, stdout: ran.stdout, stderr: ran.stderr })
      if (!outcome.ok) return json(ran.code === 124 || ran.code === 127 ? 502 : 409, { error: outcome.error })

      return json(200, outcome)
    }

    // Close a session's window: `crew close <name>` as argv, as the user (CREW_AS_USER=1), never a model turn. crew's own refusals (busy, a draft, other panes) are 409. Not in REMOTE_ROUTES.
    if (req.method === 'POST' && url.pathname === '/api/close') {
      const data = await body(req)
      if (data instanceof Response) return data
      if (typeof data.name !== 'string') return json(400, { error: 'send {name}' })
      const built = closeArgv(config.crewBin, data.name)
      if ('error' in built) return json(400, { error: built.error })

      const ran = await run(built.argv, { ...config.env, ...built.env }, 30_000)
      const outcome = closeOutcome({ exitCode: ran.code, stdout: ran.stdout, stderr: ran.stderr })
      if (!outcome.ok) return json(ran.code === 124 || ran.code === 127 ? 502 : 409, { error: outcome.error })

      return json(200, outcome)
    }

    return (await plan(req, url)) ?? text(404, 'not found')
  }

  const serve = (hostname: string, at: number, remote: boolean) =>
    Bun.serve({
      hostname,
      port: at,
      fetch: req => handle(req, remote).catch(failure => json(500, { error: String(failure instanceof Error ? failure.message : failure) })),
    })
  const server = serve(config.host, port, false)
  listening = server.port ?? port
  let remoteServer: ReturnType<typeof serve> | undefined
  if (config.remotePort !== undefined) {
    try {
      remoteServer = serve('127.0.0.1', config.remotePort, true)
    } catch (failure) {
      server.stop(true)
      throw failure
    }
  }

  // Stopping the server also stops the remote listener and drops the plan nudges that are still waiting.
  const stop = server.stop.bind(server)
  server.stop = closeActiveConnections => {
    plan.dispose()
    remoteServer?.stop(closeActiveConnections)

    return stop(closeActiveConnections)
  }

  return Object.assign(server, { remotePort: remoteServer?.port })
}

if (import.meta.main) {
  const env = process.env as Record<string, string | undefined>
  const home = env.HOME ?? homedir()
  const host = env.HQ_WEB_HOST || '127.0.0.1'
  const port = Number(env.HQ_WEB_PORT || 7717)
  const dir = import.meta.dir
  try {
    assertBindAllowed(host, env)
    const tokenFile = `${env.XDG_CONFIG_HOME || `${home}/.config`}/hq-web/token`
    const token = loadToken(tokenFile)
    const server = startServer(
      {
        host,
        token,
        page: readFileSync(`${dir}/index.html`, 'utf8'),
        crewBin: `${home}/.claude/bin/crew`,
        crewRoot: env.CREW_ROOT || `${home}/.claude/crew`,
        tmuxMapBin: `${dir}/../bin/tmux-map`,
        tmuxBin: 'tmux',
        ...(env.HQ_WEB_REMOTE_PORT ? { remotePort: Number(env.HQ_WEB_REMOTE_PORT) } : {}),
        extraHosts: parseExtraHosts(env.HQ_WEB_EXTRA_HOSTS),
        ...(env.HQ_WEB_TS_LOGIN ? { tsLogin: env.HQ_WEB_TS_LOGIN } : {}),
        planBin: `${home}/.claude/bin/plan`,
        ...(existsSync(`${dir}/plan.html`) ? { planPage: readFileSync(`${dir}/plan.html`, 'utf8') } : {}),
        env,
      },
      port,
    )
    const shown = host.includes(':') ? `[${host}]` : host
    const url = `http://${shown}:${server.port}/`
    console.log(process.stdout.isTTY ? `HQ web: ${url}?t=${token}` : `HQ web: ${url} (token in ${tokenFile})`)
    if (server.remotePort !== undefined) console.log(`HQ web remote listener: 127.0.0.1:${server.remotePort} (point tailscale serve here)`)
    else if (env.HQ_WEB_EXTRA_HOSTS) console.log('hq-web: HQ_WEB_EXTRA_HOSTS is set but HQ_WEB_REMOTE_PORT is not: no remote listener, the extra hosts do nothing')
  } catch (failure) {
    console.error(`hq-web: ${failure instanceof Error ? failure.message : failure}`)
    process.exit(1)
  }
}
