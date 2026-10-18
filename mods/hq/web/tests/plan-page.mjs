// Acceptance script for web/plan.html. Run from mods/hq:  bun web/tests/plan-page.mjs
// Serves plan.html from a tiny Bun server that fakes the three plan API routes over the shape fixtures
// (same CSP header and a real nonce as server.ts), then drives it with Playwright.
// Prints "ok <name>" per check, "FAIL <name>: why" otherwise; exit 1 on any failure; prints "skip: ..." and exits 0 when Playwright or its chromium is missing.
// Set PLAN_SHOTS=<dir> to save desktop.png, desktop-prd.png, phone.png, board-desktop.png, board-400.png and the 2560 / 1440 / phone node-panel and PRD shots (lanes-2560*.png, prd-2560*.png, board-2560-panel.png, lanes-1440-panel.png, prd-1440.png, phone-panel.png, conversation-2560.png, conversation-1440.png, conversation-phone.png, ideate-2560-panel-on-now.png, prd-2560-taskmap.png, comments-{2560,1440,1024,phone}[-section|-full].png, comments-{2560,1440,1024}-panel.png, prd-pane-{2560,1440}.png, prd-pane-{2560,1440,1024}-thread.png, prd-pane-2560-panel.png, prd-pane-phone.png, review-pr-{2560,1440,phone}.png) there; PLAN_HTML=<file> to test another page.
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FIX = join(here, '../../../../skills/shape/tests/fixtures')
const PW = join(here, '../../../../skills/lens/scripts/pw.mjs')
const PAGE = readFileSync(process.env.PLAN_HTML || join(here, '../plan.html'), 'utf8')
const load = f => JSON.parse(readFileSync(join(FIX, f), 'utf8'))

const PRD = `<!-- generated from plan.json rev 95 -->
# Offline sync for a notes app

## 0. TL;DR

Notes keep working **offline** and sync when the network returns. ~~Real-time collaboration~~ is out.

## 1. Problem

> Pending: who loses work today and how often

## 2. Users

- Mobile note takers on flaky trains
- Two-device owners:
  - phone and laptop

## 7. Functional requirements

1. FR-1: edits made offline are queued as \`ops\`
2. FR-2: the queue drains in order

| ID | Requirement | Scenario |
|----|-------------|----------|
| FR-1 | Queue offline edits | SC-001 |
| FR-2 | Drain in order | SC-002 |

## 12. Open questions

- Conflict policy when two devices edit the same note [NEEDS CLARIFICATION: Q7]
- See [the sync RFC](https://example.com/rfc) for the wire format

\`\`\`
GET /sync?since=<cursor>
\`\`\`

Text that must stay text: <img src=x onerror=alert(1)>
`

// ---------- fake HQ server ----------
const state = { plans: {}, prd: {}, posts: [], respond: null }
function reset() {
  const std = load('plan-standard.json'), rdy = load('plan-ready.json')
  state.plans = { [std.id]: std, [rdy.id]: rdy }
  state.prd = { [std.id]: PRD, [rdy.id]: PRD.replace('## 1. Problem\n\n> Pending: who loses work today and how often', '## 1. Problem\n\nInventory scripts cannot read the CLI output.') }
  state.posts = []
  state.respond = null
}
reset()
const STD = load('plan-standard.json').id
const RDY = load('plan-ready.json').id

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url)
    const m = u.pathname
    if (m === '/plan' || m.startsWith('/plan/')) {
      const nonce = randomBytes(16).toString('base64')
      const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      return new Response(PAGE.replaceAll('__NONCE__', nonce), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp } })
    }
    if (m === '/api/plans') {
      return json(Object.values(state.plans).map(p => ({ id: p.id, title: p.title, stage: p.stage, rev: p.rev, progress: p.progress, updated: p.updated })))
    }
    const g = /^\/api\/plan\/([^/]+)(\/event)?$/.exec(m)
    if (!g) return new Response('not found', { status: 404 })
    const plan = state.plans[decodeURIComponent(g[1])]
    if (!plan) return json({ error: 'no such plan' }, 404)
    if (g[2] && req.method === 'POST') {
      const body = await req.json()
      state.posts.push(body)
      if (state.respond) { const r = state.respond(body); if (r) return json(r.body, r.status) }
      return json({ ok: true, rev: plan.rev + 1, summary: 'applied ' + body.type, nudge: false })
    }
    const have = u.searchParams.get('rev')
    if (have != null && Number(have) === plan.rev) return json({ rev: plan.rev, unchanged: true })
    return json({ rev: plan.rev, plan, prd: state.prd[plan.id] })
  },
})
const BASE = `http://localhost:${server.port}`

// ---------- harness ----------
const pw = await import(PW)
const cr = await pw.getChromium()
const SKIP = 'skip: Playwright chromium not found (install with: npx playwright install chromium, or set LENS_PLAYWRIGHT)'
if (!cr) { console.log(SKIP); process.exit(0) }
let browser
try { browser = await cr.launch({ headless: true }) } catch (e) {
  if (/Executable doesn't exist/.test(String(e && e.message))) { console.log(SKIP); process.exit(0) }
  throw e
}

const failures = []
const consoleErrors = []
const SHOTS = process.env.PLAN_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

// expectHttp: the check forces 4xx answers, whose "Failed to load resource" console lines are not page errors.
async function open(path, vp, fn, expectHttp = false, pre = null) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, colorScheme: 'light' })
  const page = await ctx.newPage()
  page.setDefaultTimeout(6000)
  const dialogs = []
  const errs = []
  page.on('console', msg => { if (msg.type() === 'error') errs.push(msg.text()) })
  page.on('pageerror', e => errs.push('pageerror: ' + e.message))
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss() })
  if (pre) await pre(page)
  await page.goto(BASE + path)
  try {
    return await fn(page, { dialogs, errs })
  } finally {
    consoleErrors.push(...errs.filter(e => !(expectHttp && e.startsWith('Failed to load resource'))).map(e => path + ' ' + e))
    await ctx.close()
  }
}
const DESK = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
const eq = (got, want, what) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`) }
const ONLY = process.env.PLAN_ONLY ? new RegExp(process.env.PLAN_ONLY) : null // PLAN_ONLY=<regex>: run only the checks whose name matches
async function check(name, fn) {
  if (ONLY && !ONLY.test(name)) return
  reset()
  try { await fn(); console.log('ok ' + name) } catch (e) { failures.push(name); console.log('FAIL ' + name + ': ' + e.message.split('\n')[0]) }
}
const lastPost = () => state.posts[state.posts.length - 1]
const waitPost = async (n = 1) => { for (let i = 0; i < 50 && state.posts.length < n; i++) await Bun.sleep(100); if (state.posts.length < n) throw new Error('no event was posted') }

const std = () => state.plans[STD]
const front0 = () => std().nodes.find(n => n.id === std().frontier[0])

// ---------- ideate plan: the fixture of the shape CLI, and a fake of what the CLI does to it for each board event ----------
const IDE = load('plan-ideate.json').id
const ide = () => state.plans[IDE]
// Seeds the ideate plan (mut edits the fixture first) and answers board events like plan_core.board_event does.
function seedIdeate(mut) {
  const p = load('plan-ideate.json')
  if (mut) mut(p)
  state.plans[IDE] = p
  state.prd[IDE] = '# Offline mode for the notes app\n'
  state.respond = ev => applyBoard(state.plans[IDE], ev)
}
function applyBoard(plan, ev) {
  const at = '2026-10-17T17:00:00Z'
  const n = ev.node ? plan.nodes.find(x => x.id === ev.node) : null
  let summary
  if (ev.type === 'boost') { n.boost = ev.value; summary = `boosted ${n.id} (${ev.value})` }
  else if (ev.type === 'kill') { Object.assign(n, { status: 'killed', kill_reason: ev.text, boost: 0 }); summary = `killed ${n.id}: ${ev.text}` }
  else if (ev.type === 'restore') { Object.assign(n, { status: 'open', kill_reason: '' }); summary = `restored ${n.id}` }
  else if (ev.type === 'weight') { n.weight = ev.value; summary = `weight ${n.id} = ${ev.value}` }
  else if (ev.type === 'weights_reset') { for (const r of plan.nodes) if (r.kind === 'rubric' && r.group !== 'gate') r.weight = r.default_weight; summary = 'weights reset' }
  else if (ev.type === 'promote') {
    for (const o of plan.nodes) if (o.kind === 'idea' && o.status === 'settled') o.status = 'open'
    n.status = 'settled'
    if (['ideate', 'research'].includes(plan.stage)) plan.stage = 'frame'
    plan.requests.push({ ref: 'e-promote' + plan.rev, type: 'promote', node: n.id, lane: null, text: '', at })
    summary = `promoted ${n.id}`
  } else if (ev.type === 'merge') {
    const o = plan.nodes.find(x => x.id === ev.other)
    const num = Math.max(...plan.nodes.filter(x => x.kind === 'idea').map(x => Number(x.id.slice(1)))) + 1
    const draft = { ...structuredClone(plan.nodes.find(x => x.id === 'I4')), id: 'I' + num, label: `${n.label} + ${o.label}`.slice(0, 120), merged_from: [n.id, o.id], merged_into: null }
    plan.nodes.push(draft)
    n.merged_into = o.merged_into = draft.id
    plan.requests.push({ ref: 'e-merge' + plan.rev, type: 'merge', node: draft.id, lane: null, text: '', at })
    summary = `merged ${n.id} + ${o.id} into ${draft.id}`
  } else if (ev.type === 'twist') { plan.requests.push({ ref: 'e-twist' + plan.rev, type: 'twist', node: n.id, lane: null, text: ev.text || '', at }); summary = `twist on ${n.id}` }
  else if (ev.type === 'research') { plan.requests.push({ ref: 'e-research' + plan.rev, type: 'research', node: n ? n.id : null, lane: null, text: ev.text || '', at }); summary = `research requested: ${n ? n.id : 'shortlist'}` }
  else return null
  plan.rev++
  plan.recent.unshift({ rev: plan.rev, at, by: 'user', source: 'hq', type: ev.type, node: ev.node || null, summary })
  return { status: 200, body: { ok: true, rev: plan.rev, summary, nudge: false } }
}
const cardIds = page => page.locator('#p-board .b-card').evaluateAll(c => c.map(x => x.dataset.id))
const card = (page, id) => page.locator(`#p-board .b-card[data-id=${id}]`)

// ---------- checks ----------

// Breaks if the page does not read the title/stage/frontier from the API or uses a different focus node.
await check('desktop 1280x800: title, stage Decide current, focus card is frontier[0]', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.waitForSelector('#titleText:not(:empty)')
    eq(await page.textContent('#titleText'), 'Offline sync for a notes app', 'title')
    eq(await page.textContent('#stepper li.cur'), 'Decide', 'current stage')
    const want = front0().label
    eq(await page.textContent('#now h2'), front0().id + ' · ' + want, 'focus card heading')
    eq(await page.locator('#stepper li').count(), 7, 'stage count')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'desktop.png') })
  })
})

// Breaks if Accept ★ posts the option key instead of "recommended", or posts extra fields.
await check('Accept ★ posts answer with choice "recommended"', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('#now [data-act=accept]')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"answer","node":"Q7","choice":"recommended"}', 'posted body')
  })
})

// Breaks if "Decide later" does something other than park the focus node.
await check('Decide later posts park', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('#now [data-act=later]')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"park","node":"Q7"}', 'posted body')
  })
})

// Breaks if picking another option still posts "recommended".
await check('picking option b then Choose posts the option key', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('#now .opt[data-key=b]')
    await page.click('#now [data-act=accept]')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"answer","node":"Q7","choice":"b"}', 'posted body')
  })
})

// Breaks if the free-text answer posts a choice, or loses the text.
await check('Other… posts answer with text', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('#now [data-act=other]')
    await page.fill('#now textarea', 'Last write wins, keep the loser as a copy')
    await page.click('#now .form .btn.primary')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"answer","node":"Q7","text":"Last write wins, keep the loser as a copy"}', 'posted body')
  })
})

// Breaks if Discuss posts park/answer or an empty ask.
await check('Discuss posts ask with text', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('#now [data-act=discuss]')
    await page.fill('#now textarea', 'Can we keep both versions?')
    await page.click('#now .form .btn.primary')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"ask","node":"Q7","text":"Can we keep both versions?"}', 'posted body')
  })
})

// Breaks if the PRD tab does not render one h2 per ## section, or the NEEDS CLARIFICATION marker is not a link to the node.
await check('PRD tab: h2 per section, NEEDS CLARIFICATION link selects Q7', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('#tabs .tab:has-text("PRD")')
    eq(await page.locator('#p-prd .prd h2').count(), 5, 'h2 count')
    eq(await page.locator('#p-prd .prd h2').first().textContent(), '§0TL;DR', 'first h2')
    eq(await page.locator('#p-prd table').count(), 1, 'table')
    eq(await page.locator('#p-prd .prd del').textContent(), 'Real-time collaboration', 'strike')
    eq(await page.locator('#p-prd .prd strong').textContent(), 'offline', 'bold')
    eq(await page.locator('#p-prd section.empty').count(), 1, 'pending section')
    eq(await page.locator('#p-prd .prd a').evaluateAll(a => a.map(x => x.textContent)), ['[NEEDS CLARIFICATION: Q7]'], 'only the NCL marker is a link')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'desktop-prd.png'), fullPage: false })
    await page.click('#p-prd a.ncl')
    await page.waitForSelector('#nodepanel:not([hidden])')
    eq(await page.textContent('#nodepanel .np-id'), 'Q7', 'Q7 opened in the panel')
    eq(await page.getAttribute('.node[data-id=Q7]', 'aria-pressed'), 'true', 'Q7 selected')
  })
})

// Breaks if a markdown link is rendered as an anchor (it must stay plain text) or raw HTML in the PRD is parsed.
await check('PRD renders links as plain text and HTML as text', async () => {
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await page.click('#tabs .tab:has-text("PRD")')
    const t = await page.textContent('#p-prd .prd')
    if (!t.includes('the sync RFC (https://example.com/rfc)')) throw new Error('link text missing')
    eq(await page.locator('#p-prd .prd img').count(), 0, 'img elements in the PRD')
    if (!t.includes('<img src=x onerror=alert(1)>')) throw new Error('html text missing')
    eq(ctx.dialogs.length, 0, 'dialogs')
  })
})

// Breaks if an "Other…" draft (or a picked option) stays bound to the Now form instead of the question: when another
// writer settles Q7 the focus moves to Q22 and the text typed for Q7 would be sent as the answer to Q22.
await check('a draft typed for Q7 is not posted as the answer to Q22 once Q7 is settled elsewhere', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('#now .opt[data-key=b]')
    await page.click('#now [data-act=other]')
    await page.fill('#now textarea', 'Last write wins, keep the loser as a copy')
    const q7 = std().nodes.find(n => n.id === 'Q7')
    q7.status = 'settled'
    q7.answer = { choice: 'a' }
    std().frontier = std().frontier.filter(id => id !== 'Q7')
    std().rev += 1
    await page.waitForFunction(() => document.querySelector('#now h2').textContent.startsWith('Q22'), null, { timeout: 5000 })
    const shown = await page.evaluate(() => { const t = document.querySelector('#now textarea'); return t ? t.value : '' })
    eq(shown, '', 'draft carried into Q22')
    eq(await page.locator('#now .opt.pick').count(), 0, 'option picked for Q7 carried into Q22')
    if (!(await page.innerText('#notice')).includes('Q7 was answered elsewhere')) throw new Error('no visible note that Q7 was answered elsewhere')
    for (const send of await page.locator('#now .form .btn.primary').all()) await send.click({ force: true })
    await page.waitForTimeout(300)
    eq(state.posts, [], 'events posted after the focus moved')
  })
})

// Breaks if a null child reaches replaceChildren/append: it is stringified, so "null" shows in the header meta line
// (no parked nodes, no requests) and in the "Nothing left in focus" card (stage decide, no readiness gate link).
await check('no literal "null" in the header meta or the empty Now card', async () => {
  std().frontier = []
  std().requests = []
  std().nodes.filter(n => n.status === 'parked').forEach(n => { n.status = 'open' })
  await open('/plan/' + STD, DESK, async page => {
    await page.waitForSelector('#now h2')
    eq(await page.textContent('#now h2'), 'Nothing left in focus', 'empty card heading')
    const text = await page.evaluate(() => document.body.innerText)
    if (text.includes('null')) throw new Error('page text holds "null": ' + text.slice(Math.max(0, text.indexOf('null') - 40), text.indexOf('null') + 20).replaceAll('\n', ' '))
  })
})

// Breaks if the page puts the label in through innerHTML.
await check('a label containing <img onerror> renders as text', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  std().nodes.find(n => n.id === 'Q22').label = evil
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await page.waitForSelector('.node[data-id=Q22]')
    eq(await page.textContent('.node[data-id=Q22] .t'), evil, 'label text')
    eq(await page.locator('.node img, #now img, #p-prd img').count(), 0, 'img elements')
    await page.click('.node[data-id=Q22]')
    eq(await page.textContent('#nodepanel h2'), evil, 'panel label text')
    eq(ctx.dialogs.length, 0, 'dialogs')
  })
})

// Breaks if the page keeps showing the first rev, or polls slower than 5 s while visible.
await check('rev polling: a bumped rev shows the new label within 5 s', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.waitForSelector('.node[data-id=Q22]')
    std().rev += 1
    std().nodes.find(n => n.id === 'Q22').label = 'Cursor support on the server'
    await page.waitForFunction(() => document.querySelector('.node[data-id=Q22] .t').textContent === 'Cursor support on the server', null, { timeout: 5000 })
    if (!(await page.textContent('#meta')).includes('rev 96')) throw new Error('meta still shows the old rev')
  })
})

// Breaks if changed nodes do not flash (the .fresh class is how the page marks them).
await check('a node changed by another writer flashes once', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.waitForSelector('.node[data-id=Q22]')
    eq(await page.locator('.node.fresh').count(), 0, 'flashing on first load')
    std().rev += 1
    std().nodes.find(n => n.id === 'Q22').label = 'Cursor support on the server'
    await page.waitForSelector('.node[data-id=Q22].fresh', { timeout: 5000 })
    eq(await page.locator('.node.fresh').count(), 1, 'flashing nodes')
  })
})

// Breaks if the page forgets to poll again after a POST (the new rev would take up to 2 s to show).
await check('after a POST the page polls at once', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.waitForSelector('.node[data-id=Q22]')
    state.respond = () => { std().rev += 1; std().nodes.find(n => n.id === 'Q22').label = 'Changed by the answer'; return null }
    await page.click('#now [data-act=later]')
    await page.waitForFunction(() => document.querySelector('.node[data-id=Q22] .t').textContent === 'Changed by the answer', null, { timeout: 1500 })
  })
})

// Breaks if the page does not list requests as waiting, or hides the count.
await check('requests show as "waiting for the session"', async () => {
  await open('/plan/' + STD, DESK, async page => {
    const t = await page.textContent('#now .reqs')
    if (!t.includes('Waiting for the session · 2')) throw new Error('heading: ' + t.slice(0, 60))
    if (!t.includes('What happens to the version that loses?')) throw new Error('ask text missing')
    if (!(await page.textContent('#meta')).includes('2 waiting for the session')) throw new Error('meta count missing')
  })
})

// Breaks if the page overflows at phone width or the bottom tabs are missing/hidden, in any of the four views.
await check('390x844: no horizontal scroll in every view, bottom tabs visible', async () => {
  await open('/plan/' + STD, PHONE, async page => {
    await page.waitForSelector('#bnav button')
    if (!(await page.isVisible('#bnav'))) throw new Error('bottom tabs hidden')
    eq(await page.locator('#bnav button').allTextContents(), ['◉Now', '▤Map', '§PRD', '≡Log'], 'bottom tabs')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'phone.png') })
    for (const v of ['now', 'lanes', 'prd', 'log']) {
      await page.click(`#bnav [data-view=${v}]`)
      const w = await page.evaluate(() => document.documentElement.scrollWidth)
      if (w > 390) throw new Error(`${v}: scrollWidth ${w}`)
    }
    await page.click('#bnav [data-view=lanes]')
    await page.click('.buildlink')
    const w = await page.evaluate(() => document.documentElement.scrollWidth)
    if (w > 390) throw new Error(`build: scrollWidth ${w}`)
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'phone-build.png') })
  })
})

// Breaks if the phone view does not start on Now (the focus card is the whole point of the phone).
await check('phone starts on the Now card with Accept ★ visible', async () => {
  await open('/plan/' + STD, PHONE, async page => {
    await page.waitForSelector('#now [data-act=accept]')
    if (!(await page.isVisible('#now [data-act=accept]'))) throw new Error('Accept hidden')
    if (await page.isVisible('#p-lanes')) throw new Error('lanes visible on Now')
  })
})

// Breaks if a long unbroken label pushes the layout wider than the phone.
await check('390x844: a very long label does not overflow', async () => {
  std().nodes.find(n => n.id === 'Q22').label = 'Does_the_server_API_support_a_since_cursor_for_incremental_pulls_without_any_break_opportunity_at_all'
  await open('/plan/' + STD, PHONE, async page => {
    for (const v of ['now', 'lanes', 'log']) {
      await page.click(`#bnav [data-view=${v}]`)
      const w = await page.evaluate(() => document.documentElement.scrollWidth)
      if (w > 390) throw new Error(`${v}: scrollWidth ${w}`)
    }
  })
})
// Breaks if the Approve PRD button appears outside stage shape.
await check('Approve PRD is hidden at stage decide and shown at stage shape', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('#tabs .tab:has-text("PRD")')
    eq(await page.locator('#p-prd [data-act=approve]').count(), 0, 'approve at decide')
  })
  await open('/plan/' + RDY, DESK, async page => {
    await page.click('#tabs .tab:has-text("PRD")')
    eq(await page.locator('#p-prd [data-act=approve]').count(), 1, 'approve at shape')
  })
})

// Breaks if a 409 lint answer is dropped or shown with alert() instead of inline.
await check('Approve PRD: 409 shows blocking lint findings inline, then 200 clears them', async () => {
  state.respond = body => (body.type === 'approve_prd' && !state.okNext
    ? { status: 409, body: { ok: false, error: 'not ready', lint: [{ rule: 'task-no-check', severity: 'block', node: 'T-004', section: '15', message: 'T-004 has no runnable check' }, { rule: 'default', severity: 'warn', node: 'DEC-3', section: '13', message: 'DEC-3 was settled by default' }] } }
    : null)
  await open('/plan/' + RDY, DESK, async (page, ctx) => {
    await page.click('#tabs .tab:has-text("PRD")')
    await page.click('#p-prd [data-act=approve]')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"approve_prd"}', 'posted body')
    await page.waitForSelector('.gate .lint button.linkbtn')
    const t = await page.textContent('.gate .lint')
    if (!t.includes('T-004 has no runnable check')) throw new Error('blocking finding missing: ' + t)
    if (!t.includes('DEC-3 was settled by default')) throw new Error('warning missing: ' + t)
    if (!(await page.isVisible('#notice'))) throw new Error('inline notice hidden')
    eq(ctx.dialogs.length, 0, 'dialogs')
    state.okNext = true
    await page.click('#p-prd [data-act=approve]')
    await waitPost(2)
    await page.waitForFunction(() => !document.querySelector('.gate .lint .linkbtn'), null, { timeout: 4000 })
    eq(await page.isVisible('#notice'), false, 'notice cleared')
  }, true)
  delete state.okNext
})

// Breaks if a plain error body (400/404) is swallowed.
await check('an error answer is shown inline, never alert()', async () => {
  state.respond = () => ({ status: 400, body: { error: 'text too long' } })
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await page.click('#now [data-act=later]')
    await page.waitForSelector('#notice:not([hidden])')
    eq(await page.textContent('#notice .msg'), 'text too long', 'notice text')
    eq(ctx.dialogs.length, 0, 'dialogs')
  }, true)
})

// Breaks if the plan list route does not list every plan, or links point anywhere but /plan/<id>.
await check('/plan lists both fixtures with links', async () => {
  await open('/plan', DESK, async page => {
    await page.waitForSelector('#plist a.pl')
    eq(await page.locator('#plist a.pl').evaluateAll(a => a.map(x => x.getAttribute('href'))), ['/plan/' + STD, '/plan/' + RDY], 'hrefs')
    const t = await page.textContent('#plist')
    if (!t.includes('Offline sync for a notes app') || !t.includes('Add a --json flag to the inv CLI')) throw new Error('titles missing: ' + t.slice(0, 120))
    await page.click('#plist a.pl >> nth=1')
    await page.waitForSelector('#titleText:not(:empty)')
    eq(await page.textContent('#titleText'), 'Add a --json flag to the inv CLI', 'ready plan title')
    eq(await page.textContent('#stepper li.cur'), 'Shape', 'ready stage')
  })
})

// Breaks if an unknown plan id leaves a blank page.
await check('unknown plan id shows a message', async () => {
  await open('/plan/nope', DESK, async page => {
    await page.waitForSelector('#fatal:not([hidden])')
    if (!(await page.textContent('#fatal')).includes('nope')) throw new Error('message does not name the plan')
  }, true)
})

// ---------- board (Ideate and Research) ----------
const BOARD = '/plan/' + IDE

// Breaks if the stepper lacks the Ideate stage, or the Board tab is not the default one while ideating.
await check('board: stage ideate opens on the Board tab and the stepper shows Ideate', async () => {
  seedIdeate()
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await page.textContent('#tabs .tab[aria-selected=true]'), 'Board', 'selected tab')
    eq(await page.locator('#p-board').evaluate(e => e.classList.contains('on')), true, 'board panel shown')
    eq(await page.textContent('#stepper li.cur'), 'Ideate', 'current stage')
    eq(await page.locator('#stepper li').count(), 9, 'stage count')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'board-desktop.png') })
  })
})

// Breaks if #board is ignored: after ideating the default view is the lanes.
await check('board: #board selects the Board tab on a plan past ideate, and a plan without ideas has no Board tab', async () => {
  seedIdeate(p => { p.stage = 'explore' })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#titleText:not(:empty)')
    eq(await page.textContent('#tabs .tab[aria-selected=true]'), 'Lanes', 'selected tab without #board')
  })
  await open(BOARD + '#board', DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await page.textContent('#tabs .tab[aria-selected=true]'), 'Board', 'selected tab with #board')
  })
  await open('/plan/' + STD + '#board', DESK, async page => {
    await page.waitForSelector('#titleText:not(:empty)')
    eq(await page.locator('#tabs .tab').allTextContents(), ['Lanes', 'PRD', 'Build', 'Log'], 'tabs of a plan with no ideas')
    eq(await page.textContent('#tabs .tab[aria-selected=true]'), 'Lanes', 'falls back to the lanes')
  })
})

// Breaks if the sort ignores the board score of §12.1: I2 = (30*5+25*4.5)/55 + 0.25 = 5.02, I1 = (30*4+25*3.5)/55 + 0.5 = 4.27, I4 is unscored, I3 is killed.
await check('board: cards are sorted by board score, boost included; killed ideas are in the graveyard', async () => {
  seedIdeate()
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await cardIds(page), ['I2', 'I1', 'I4'], 'card order')
    eq(await page.locator('#p-board .b-card .b-score .num').allTextContents(), ['4.8', '3.8'], 'scores')
    eq(await page.locator('#p-board .b-grave li').evaluateAll(l => l.map(x => x.dataset.id)), ['I3'], 'graveyard')
    eq(await page.locator('#p-board .b-stat .v').allTextContents(), ['3', '2', '2of 3', '1', '1'], 'stat tiles')
  })
})

// Breaks if a partly scored idea is sorted by value alone: I1 has the higher raw mean but one score missing, so it goes after fully scored I2... and an unscored idea last.
await check('board: partly scored ranks below fully scored whatever the value, and shows what is missing', async () => {
  seedIdeate(p => {
    const i1 = p.nodes.find(n => n.id === 'I1'), i2 = p.nodes.find(n => n.id === 'I2')
    delete i1.scores.K2
    i1.scores.K1.value = 5
    i2.scores.K1.value = 1
    i2.scores.K2.value = 1
  })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await cardIds(page), ['I2', 'I1', 'I4'], 'card order')
    eq(await card(page, 'I1').locator('.b-score .cov').textContent(), '1 of 2 scored', 'coverage')
    eq(await card(page, 'I4').locator('.b-score').textContent(), 'not scored yet', 'unscored card')
    await card(page, 'I1').locator('summary').click()
    const bar = card(page, 'I1').locator('.b-bar.none')
    eq(await bar.textContent(), 'Edits are never lost on a clashnot scored yet', 'missing score bar')
  })
})

// Breaks if the inline error is skipped (the empty reason is posted) or Enter does not submit.
await check('board: kill needs a reason: empty shows the error and posts nothing, Enter posts it, Escape cancels', async () => {
  seedIdeate()
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    await card(page, 'I1').locator('[data-act=kill]').click()
    await page.click('#p-board [data-act=kill-confirm]')
    if (!(await page.locator('#p-board .b-pop .err').isVisible())) throw new Error('no inline error for an empty reason')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    eq(state.posts.length, 0, 'posts after empty reasons')
    await page.keyboard.press('Escape')
    eq(await page.locator('#p-board .b-pop').count(), 0, 'kill panel after Escape')
    await card(page, 'I1').locator('[data-act=kill]').click()
    await page.keyboard.type('Two competitors ship it already')
    await page.keyboard.press('Enter')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"kill","node":"I1","text":"Two competitors ship it already"}', 'posted body')
    await page.waitForSelector('#p-board .b-grave li[data-id=I1]', { state: 'attached' })
    eq(await cardIds(page), ['I2', 'I4'], 'cards after the kill')
  })
})

// Breaks if a server refusal is swallowed or changes the UI: the toast must carry the server's words and the kill panel must stay.
await check('board: a refused event shows the server error in the toast and leaves the panel open', async () => {
  seedIdeate()
  state.respond = () => ({ status: 400, body: { error: 'Idea is killed already' } })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    await card(page, 'I1').locator('[data-act=kill]').click()
    await page.keyboard.type('stale')
    await page.keyboard.press('Enter')
    await waitPost()
    await page.waitForSelector('#toast.on')
    eq(await page.textContent('#toast'), 'Idea is killed already', 'toast')
    eq(await page.locator('#p-board .b-pop input').inputValue(), 'stale', 'kept reason')
    eq(await cardIds(page), ['I2', 'I1', 'I4'], 'cards unchanged')
  }, true)
})

// Breaks if boost posts the stars shown instead of current+1, or does not wrap 3 to 0.
await check('board: boost posts current+1 and wraps 3 to 0', async () => {
  seedIdeate(p => { p.nodes.find(n => n.id === 'I2').boost = 3 })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    await card(page, 'I1').locator('[data-act=boost]').click()
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"boost","node":"I1","value":3}', 'I1 2 -> 3')
    await page.waitForSelector('#p-board .b-card[data-id=I1][data-boost="3"]')
    await card(page, 'I2').locator('[data-act=boost]').click()
    await waitPost(2)
    eq(JSON.stringify(lastPost()), '{"type":"boost","node":"I2","value":0}', 'I2 3 -> 0')
  })
})

// Breaks if merge posts the clicked card as node, swaps the pair, or posts before the second pick.
await check('board: merge posts the first pick as node and the second as other, and the draft appears', async () => {
  seedIdeate()
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    await card(page, 'I1').locator('[data-act=merge]').click()
    eq(await page.locator('#p-board .b-banner').textContent().then(t => t.includes('Merging I1')), true, 'banner')
    eq(state.posts.length, 0, 'posts before the second pick')
    await card(page, 'I2').locator('[data-act=merge]').click()
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"merge","node":"I1","other":"I2"}', 'posted body')
    await page.waitForSelector('#p-board .b-card[data-id=I5]')
    eq(await card(page, 'I5').locator('h3').textContent(), 'Local-first store with background sync + Read-only offline cache', 'draft label')
    eq(await page.locator('#p-board .b-banner').count(), 0, 'banner after the merge')
  })
})

// Breaks if a gate gets a stepper, a step is not 5, or a stepper posts the wrong rubric or value.
await check('board: weight steppers post node and value, gates have none, reset posts weights_reset', async () => {
  seedIdeate()
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-rail .b-crit')
    eq(await page.locator('#p-board .b-crit[data-id=K4] button').count(), 0, 'gate steppers')
    eq(await page.locator('#p-board .b-crit[data-id=K1] button').count(), 2, 'weighted steppers')
    await page.click('#p-board .b-crit[data-id=K1] [data-act=weight-up]')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"weight","node":"K1","value":35}', 'K1 up')
    await page.waitForFunction(() => document.querySelector('#p-board .b-crit[data-id=K1] output').firstChild.textContent === '35')
    await page.click('#p-board .b-crit[data-id=K2] [data-act=weight-down]')
    await waitPost(2)
    eq(JSON.stringify(lastPost()), '{"type":"weight","node":"K2","value":20}', 'K2 down')
    await page.click('#p-board [data-act=weights-reset]')
    await waitPost(3)
    eq(JSON.stringify(lastPost()), '{"type":"weights_reset"}', 'reset')
  })
})

// Breaks if promote fires without the confirm step, or the handoff panel is missing once the plan is in Frame.
await check('board: promote asks to confirm, posts promote, then the handoff panel shows', async () => {
  seedIdeate()
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    await card(page, 'I2').locator('[data-act=promote]').click()
    eq(state.posts.length, 0, 'posts before the confirm')
    await page.click('#p-board [data-act=promote-confirm]')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"promote","node":"I2"}', 'posted body')
    await page.waitForSelector('#p-board .b-handoff')
    eq(await page.textContent('#p-board .b-handoff h2'), '→ Frame: Read-only offline cache', 'handoff heading')
    eq(await page.textContent('#stepper li.cur'), 'Frame', 'current stage')
    eq(await card(page, 'I2').locator('.b-stamp').textContent(), 'Promoted', 'stamp')
    eq(await card(page, 'I2').locator('[data-act=promote]').count(), 0, 'promote button on the promoted card')
  })
})

// Breaks if Restore posts the wrong node or the restored idea does not come back to the board.
await check('board: Restore in the graveyard posts restore and the card returns', async () => {
  seedIdeate()
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-grave')
    await page.click('#p-board .b-grave summary')
    eq(await page.textContent('#p-board .b-grave li[data-id=I3] .why'), 'Needs a server change and months of work', 'kill reason')
    await page.click('#p-board .b-grave li[data-id=I3] [data-act=restore]')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"restore","node":"I3"}', 'posted body')
    await page.waitForSelector('#p-board .b-card[data-id=I3]')
    eq(await page.locator('#p-board .b-grave').count(), 0, 'graveyard once empty')
  })
})

// Breaks if the shortlist button posts a node, or the per-card button posts none; breaks if queued/researching/done/failed are not shown from nodes and open requests.
await check('board: research buttons post the right events and each card shows its research state', async () => {
  seedIdeate(p => {
    p.nodes.push({ ...structuredClone(p.nodes.find(n => n.id === 'RS1')), id: 'RS2', label: 'Check the cache for I2', targets: ['I2'], state: 'done', report: '/home/user/Developer/notes/research/RS2.md', note: 'Done, nothing new' })
  })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await card(page, 'I1').locator('.b-rs').textContent(), 'researchresearching…Reading sync library docs', 'running job')
    eq(await card(page, 'I2').locator('.b-rs').textContent(), 'researchdone/home/user/Developer/notes/research/RS2.md', 'done job')
    eq(await page.locator('#p-board .b-rs a').count(), 0, 'links in research state')
    await page.click('#p-board [data-act=research-shortlist]')
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"research"}', 'shortlist body')
    await card(page, 'I4').locator('[data-act=research]').click()
    await waitPost(2)
    eq(JSON.stringify(lastPost()), '{"type":"research","node":"I4"}', 'card body')
    await page.waitForFunction(() => document.querySelector('#p-board .b-card[data-id=I4] .b-rs'))
    eq(await card(page, 'I4').locator('.b-rs b').textContent(), 'queued', 'open request shows queued')
  })
  seedIdeate(p => { Object.assign(p.nodes.find(n => n.id === 'RS1'), { state: 'failed', note: 'No network in the sandbox' }) })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await card(page, 'I1').locator('.b-rs').textContent(), 'researchfailedNo network in the sandbox', 'failed job')
  })
})

// Breaks if "fails gate <label>" is not shown when a gate has pass:false.
await check('board: a failed gate shows "fails gate <label>"', async () => {
  seedIdeate(p => { p.nodes.find(n => n.id === 'I2').gates.K4.pass = false })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await card(page, 'I2').locator('.b-gate').textContent(), '✕ fails gate Works without a server-side change', 'gate line')
    eq(await card(page, 'I1').locator('.b-gate').textContent(), '✓ passes the gate', 'passing card')
  })
})

// Breaks if twist hides the "waiting" state or shows the session's twists without a way to turn one into an idea.
await check('board: twist posts, shows waiting, then lists the session-written twists', async () => {
  seedIdeate(p => { p.nodes.find(n => n.id === 'I1').twists = ['Sync only on wifi'] })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await card(page, 'I2').locator('[data-bd=twist-wait]').textContent(), 'twists requested, waiting for the session', 'waiting line')
    eq(await card(page, 'I1').locator('.b-tw li span').textContent(), 'Sync only on wifi', 'written twist')
    await card(page, 'I1').locator('[data-act=twist]').click()
    await waitPost()
    eq(JSON.stringify(lastPost()), '{"type":"twist","node":"I1"}', 'twist body')
    await card(page, 'I1').locator('[data-act=twist-make]').click()
    await waitPost(2)
    eq(JSON.stringify(lastPost()), '{"type":"twist","node":"I1","text":"Sync only on wifi"}', 'make-an-idea body')
  })
})

// Breaks if any plan text reaches innerHTML: the <img> would become an element and fire onerror.
await check('board: markup in plan text renders as text', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  seedIdeate(p => {
    p.nodes.find(n => n.id === 'I1').label = evil
    p.nodes.find(n => n.id === 'I1').pitch = evil
    p.nodes.find(n => n.id === 'I3').kill_reason = evil
    p.nodes.find(n => n.id === 'K1').label = evil
    p.nodes.find(n => n.id === 'RS1').note = evil
  })
  await open(BOARD, DESK, async (page, ctx) => {
    await page.waitForSelector('#p-board .b-card')
    eq(await card(page, 'I1').locator('h3').textContent(), evil, 'label as text')
    eq(await page.locator('#p-board img').count(), 0, 'img elements')
    await page.waitForTimeout(300)
    eq(ctx.dialogs.length, 0, 'dialogs')
  })
})

// Breaks if the board overflows a phone, drops an action off-screen, undersizes a touch target, or the rail starts open.
await check('board: 400x800 has no horizontal scroll, one column, a collapsed rail and every card action reachable', async () => {
  seedIdeate()
  await open(BOARD, { width: 400, height: 800 }, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await page.evaluate(() => document.documentElement.scrollWidth <= 400), true, 'scrollWidth <= 400')
    eq(await page.locator('#p-board .b-rail').evaluate(e => e.open), false, 'rail open')
    const xs = await page.locator('#p-board .b-card').evaluateAll(c => c.map(x => Math.round(x.getBoundingClientRect().left)))
    eq(new Set(xs).size, 1, 'one column')
    const bad = await page.locator('#p-board .b-card .b-acts button').evaluateAll(bs => bs.filter(b => {
      const r = b.getBoundingClientRect()
      return r.width < 40 || r.height < 40 || r.left < 0 || r.right > 400
    }).map(b => b.textContent))
    eq(bad, [], 'action buttons that are clipped or smaller than 40px')
    eq(await page.locator('#bnav button').allTextContents(), ['◉Now', '▦Board', '▤Map', '§PRD', '≡Log'], 'bottom nav')
    await page.click('#p-board .b-rail summary')
    const railBad = await page.locator('#p-board .b-wctl button').evaluateAll(bs => bs.filter(b => b.getBoundingClientRect().width < 40 || b.getBoundingClientRect().height < 40).length)
    eq(railBad, 0, 'weight buttons under 40px')
    eq(await page.evaluate(() => document.documentElement.scrollWidth <= 400), true, 'scrollWidth with the rail open')
    await card(page, 'I1').locator('[data-act=kill]').click()
    eq(await page.evaluate(() => document.documentElement.scrollWidth <= 400), true, 'scrollWidth with a kill panel open')
    if (SHOTS) { await page.keyboard.press('Escape'); await page.click('#p-board .b-rail summary'); await page.screenshot({ path: join(SHOTS, 'board-400.png'), fullPage: true }) }
  })
})

// Breaks if .b-chip text cannot shrink or wrap: an unbroken 60-character check label widens the page past the 400px viewport.
await check('board: a long unbroken check label wraps inside its chip at 400px', async () => {
  seedIdeate(p => { p.nodes.find(n => n.id === 'I1').checks = { allowed: { verdict: 'ok', label: 'A'.repeat(60), note: '' } } })
  await open(BOARD, { width: 400, height: 800 }, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await page.evaluate(() => document.documentElement.scrollWidth <= 400), true, 'scrollWidth <= 400')
  })
})

// Breaks if "Why it could win" is nested under "Who it is for": an idea with who "" and a win must still show the win.
await check('board: why it could win shows when who is empty, who shows when win is empty', async () => {
  seedIdeate(p => {
    Object.assign(p.nodes.find(n => n.id === 'I4'), { who: '', win: 'Needs no new infrastructure' })
    Object.assign(p.nodes.find(n => n.id === 'I2'), { who: 'People who only look notes up on the go', win: '' })
  })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    await card(page, 'I4').locator('summary').click()
    eq(await card(page, 'I4').locator('.b-kv').allTextContents(), ['Why it could winNeeds no new infrastructure'], 'I4 detail')
    await card(page, 'I2').locator('summary').click()
    eq(await card(page, 'I2').locator('.b-kv').first().textContent(), 'Who it is forPeople who only look notes up on the go', 'I2 detail')
  })
})

// Breaks if the boost is left out of the sort key: raw I2 = 4.77 beats raw I1 = 4.55, but I1 + 0.25 boost = 4.80 must win.
await check('board: a boost lifts an idea over a slightly higher raw score', async () => {
  seedIdeate(p => {
    const i1 = p.nodes.find(n => n.id === 'I1'), i2 = p.nodes.find(n => n.id === 'I2')
    i1.scores.K1.value = 5; i1.scores.K2.value = 4; i1.boost = 1
    i2.boost = 0
  })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await cardIds(page), ['I1', 'I2', 'I4'], 'card order')
    eq(await page.locator('#p-board .b-card .b-score .num').allTextContents(), ['4.5', '4.8'], 'raw scores')
  })
})

// Breaks if the stepper ticks Research when the plan went from Ideate straight to Frame: no research node exists, so it was skipped.
await check('board: a skipped Research stage is muted without a check, Ideate stays done', async () => {
  seedIdeate(p => { p.stage = 'frame'; p.nodes = p.nodes.filter(n => n.kind !== 'research') })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#stepper li.cur')
    eq(await page.locator('#stepper li').evaluateAll(l => l.map(x => [x.textContent, x.className])), [['✓ Ideate', 'done'], ['Research', 'skipped'], ['Frame', 'cur'], ['Explore', ''], ['Decide', ''], ['Shape', ''], ['Ready', ''], ['Building', ''], ['Shipped', '']], 'stepper')
  })
  seedIdeate(p => { p.stage = 'frame' })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#stepper li.cur')
    eq(await page.textContent('#stepper li:nth-child(2)'), '✓ Research', 'Research after a research run')
  })
})

// Breaks if a card keeps saying "merged into I4" after I4 was killed: it must say "(killed)".
await check('board: a merged-into line says when the merge target was killed', async () => {
  seedIdeate(p => {
    p.nodes.find(n => n.id === 'I1').merged_into = 'I4'
    p.nodes.find(n => n.id === 'I2').merged_into = 'I3'
  })
  await open(BOARD, DESK, async page => {
    await page.waitForSelector('#p-board .b-card')
    eq(await card(page, 'I1').locator('.b-hook:has-text("merged into")').allTextContents(), ['merged into I4'], 'live target')
    eq(await card(page, 'I2').locator('.b-hook:has-text("merged into")').allTextContents(), ['merged into I3 (killed)'], 'killed target')
  })
})

// ---------- node panel: the right-hand column that replaced the bottom action bar ----------
const NP = '#nodepanel'
const WIDE = { width: 2560, height: 1440 }
const LONG = 'Does the server API support a since cursor for incremental pulls without breaking mobile clients in the field?'
const npVisible = page => page.isVisible(NP)
const npFocused = page => page.evaluate(() => { const p = document.getElementById('nodepanel'); return !!p && p.contains(document.activeElement) })
const edgeBoxes = (page, sels) => page.evaluate(s => s.map(q => { const r = document.querySelector(q).getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) } }), sels)

// Breaks if the box shows the whole label (nothing left to expand), a click does not open the panel with the FULL label,
// the panel shows while nothing is selected, or focus stays on the box instead of moving into the panel.
await check('panel: hidden at first; a lane node opens it with the full label its box truncates; focus moves in', async () => {
  std().nodes.find(n => n.id === 'Q22').label = LONG
  await open('/plan/' + STD, DESK, async page => {
    await page.waitForSelector('.node[data-id=Q22]')
    eq(await npVisible(page), false, 'panel visible with nothing selected')
    eq(await page.$eval('.node[data-id=Q22] .t', e => e.scrollHeight > e.clientHeight + 1), true, 'box label is clamped')
    await page.click('.node[data-id=Q22]')
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.textContent(NP + ' h2'), LONG, 'panel label')
    eq(await page.textContent(NP + ' .np-id'), 'Q22', 'panel id')
    eq(await npFocused(page), true, 'focus inside the panel')
  })
})

// Breaks if a second click on the node keeps the panel, Close or Esc do nothing, Esc does not hand focus back to the node,
// or Esc inside a form closes the panel instead of only the form.
await check('panel: click again, Close and Esc close it; Esc returns focus to the node; Esc in a form only cancels the form', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=Q22]')
    await page.waitForSelector(NP + ':not([hidden])')
    await page.click('.node[data-id=Q22]')
    eq(await npVisible(page), false, 'after clicking the node again')
    await page.click('.node[data-id=Q22]')
    await page.click(NP + ' .np-close')
    eq(await npVisible(page), false, 'after Close')
    await page.click('.node[data-id=Q22]')
    await page.keyboard.press('Escape')
    eq(await npVisible(page), false, 'after Esc')
    eq(await page.evaluate(() => document.activeElement.getAttribute('data-id')), 'Q22', 'focus returns to the node')
    await page.click('.node[data-id=AS-1]')
    await page.click(NP + ' [data-act=edit_label]')
    await page.waitForSelector(NP + ' input[data-draft]')
    await page.keyboard.press('Escape')
    eq(await page.locator(NP + ' input[data-draft]').count(), 0, 'form after Esc')
    eq(await npVisible(page), true, 'panel after Esc in the form')
    await page.keyboard.press('Escape')
    eq(await npVisible(page), false, 'panel after the second Esc')
  })
})

// Breaks if the links come from the wrong fields (depends_on / refs / fills / dependents()), lack the status chip,
// or a click does not switch the panel and highlight the node in its lane.
await check('panel: linked nodes (depends on, depended on by, refs, fills) with status chips; clicking one switches the panel', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=Q7]')
    const ids = g => page.locator(`${NP} [data-group=${g}] .np-link`).evaluateAll(l => l.map(x => x.dataset.id))
    eq(await ids('depends_on'), ['DEC-2', 'SC-002'], 'depends on')
    eq(await ids('refs'), ['AS-1'], 'refs')
    eq(await ids('fills'), ['DEC-4'], 'fills')
    const by = await ids('dependents')
    for (const want of ['Q9', 'S2', 'R-1', 'FR-004']) if (!by.includes(want)) throw new Error(`depended on by lacks ${want}: ${by}`)
    eq(await page.locator(`${NP} [data-group=depends_on] .np-link[data-id=DEC-2] .chip`).getAttribute('class'), 'chip settled', 'status chip of DEC-2')
    await page.click(`${NP} [data-group=depends_on] .np-link[data-id=DEC-2]`)
    await page.waitForFunction(() => document.querySelector('#nodepanel h2').textContent === 'Op-log sync, no CRDT')
    eq(await page.locator('.node.sel').evaluateAll(l => l.map(x => x.dataset.id)), ['DEC-2'], 'selected lane node')
    eq(await npFocused(page), true, 'focus stays in the panel')
  })
})

// Breaks if the panel only answers the focus question (Q7), posts the wrong node, or loses the recommended star on an option.
await check('panel: any open question is answerable: Choose, Accept ★, Other and Decide later post the right events', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=Q22]')
    await page.click(NP + ' .opt[data-key=b]')
    await page.click(NP + ' [data-act=accept]')
    await waitPost(1)
    eq(JSON.stringify(state.posts[0]), '{"type":"answer","node":"Q22","choice":"b"}', 'Q22 choose')
    await page.click('.node[data-id=Q8]')
    eq(await page.textContent(NP + ' .opt[data-key=a]'), '30 days ★Covers a long holiday', 'recommended option card')
    eq(await page.textContent(NP + ' [data-act=accept]'), 'Accept ★', 'accept label')
    await page.click(NP + ' [data-act=accept]')
    await waitPost(2)
    eq(JSON.stringify(state.posts[1]), '{"type":"answer","node":"Q8","choice":"recommended"}', 'Q8 accept')
    await page.click('.node[data-id=Q9]')
    await page.click(NP + ' [data-act=other]')
    await page.fill(NP + ' textarea', 'Retry three times, then wait for the user')
    await page.click(NP + ' .form .btn.primary')
    await waitPost(3)
    eq(JSON.stringify(state.posts[2]), '{"type":"answer","node":"Q9","text":"Retry three times, then wait for the user"}', 'Q9 other')
    await page.click('.node[data-id=Q22]')
    await page.click(NP + ' [data-act=later]')
    await waitPost(4)
    eq(JSON.stringify(state.posts[3]), '{"type":"park","node":"Q22"}', 'Decide later')
  })
})

// Breaks if a draft typed in the panel is wiped (or loses focus) when the live poll re-renders the page,
// or if it is carried to another node after the panel switches.
await check('panel: a draft survives the live re-render with focus, and is dropped when the panel switches node', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=Q22]')
    await page.click(NP + ' [data-act=other]')
    await page.fill(NP + ' textarea', 'half a thought')
    std().rev += 1
    std().nodes.find(n => n.id === 'Q8').label = 'Tombstone retention window'
    await page.waitForFunction(() => document.querySelector('.node[data-id=Q8] .t').textContent === 'Tombstone retention window', null, { timeout: 5000 })
    eq(await page.inputValue(NP + ' textarea'), 'half a thought', 'draft after the re-render')
    eq(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA', 'focus after the re-render')
    await page.click('.node[data-id=Q8]')
    eq(await page.locator(NP + ' textarea[data-draft=other]').count(), 0, 'draft carried to Q8')
    eq(state.posts, [], 'events posted')
  })
})

// Breaks if the live re-render throws the reader back to the top of a long panel.
await check('panel: the panel keeps its scroll position through a live re-render', async () => {
  std().nodes.find(n => n.id === 'Q7').body = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long body.`).join('\n\n')
  await open('/plan/' + STD, { width: 1280, height: 600 }, async page => {
    await page.click('.node[data-id=Q7]')
    await page.waitForSelector(NP + ' .np-body')
    await page.$eval(NP + ' .np-body', e => { e.scrollTop = 300 })
    std().rev += 1
    std().nodes.find(n => n.id === 'Q8').label = 'Tombstone retention window'
    await page.waitForFunction(() => document.querySelector('.node[data-id=Q8] .t').textContent === 'Tombstone retention window', null, { timeout: 5000 })
    eq(await page.$eval(NP + ' .np-body', e => e.scrollTop), 300, 'scrollTop after the re-render')
  })
})

// Breaks if Park / Strike / Expand / Edit label / Ask / Add note / Reopen / Prioritize of the old bottom bar did not move
// into the panel with the same events, or are offered for the wrong kind.
await check('panel: node actions post strike, expand, edit_label, ask, note, reopen, prioritize', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=AS-1]')
    eq(await page.locator(NP + ' .np-acts .btn').allTextContents(), ['Park', 'Strike', 'Expand', 'Edit label', 'Ask', 'Add note'], 'assumption buttons')
    await page.click(NP + ' [data-act=strike]')
    await waitPost(1)
    eq(JSON.stringify(state.posts[0]), '{"type":"strike","node":"AS-1"}', 'strike')
    await page.click(NP + ' [data-act=expand]')
    await waitPost(2)
    eq(JSON.stringify(state.posts[1]), '{"type":"expand","node":"AS-1"}', 'expand')
    await page.click(NP + ' [data-act=edit_label]')
    eq(await page.inputValue(NP + ' input[data-draft]'), 'One developer for the whole 2 weeks', 'label prefilled')
    await page.fill(NP + ' input[data-draft]', 'Two developers for the whole 2 weeks')
    await page.press(NP + ' input[data-draft]', 'Enter')
    await waitPost(3)
    eq(JSON.stringify(state.posts[2]), '{"type":"edit_label","node":"AS-1","label":"Two developers for the whole 2 weeks"}', 'edit_label')
    await page.click(NP + ' [data-act=ask]')
    await page.fill(NP + ' textarea[data-draft=thread]', 'Who confirms this?')
    await page.press(NP + ' textarea[data-draft=thread]', 'Control+Enter')
    await waitPost(4)
    eq(JSON.stringify(state.posts[3]), '{"type":"ask","node":"AS-1","text":"Who confirms this?"}', 'ask')
    await page.click(NP + ' [data-act=note]')
    await page.fill(NP + ' input[data-draft]', 'Check with Priya')
    await page.click(NP + ' .np-form .btn.primary')
    await waitPost(5)
    eq(JSON.stringify(state.posts[4]), '{"type":"note","node":"AS-1","text":"Check with Priya"}', 'note')
    await page.click('.node[data-id=DEC-1]')
    eq(await page.locator(NP + ' .np-acts .btn').allTextContents(), ['Reopen', 'Park', 'Expand', 'Edit label', 'Ask', 'Add note'], 'settled decision buttons')
    await page.click(NP + ' [data-act=reopen]')
    await waitPost(6)
    eq(JSON.stringify(state.posts[5]), '{"type":"reopen","node":"DEC-1"}', 'reopen')
    await page.click('.node[data-id=Q22]')
    eq(await page.locator(NP + ' .np-acts .btn').allTextContents(), ['Prioritize', 'Expand', 'Edit label', 'Ask', 'Add note'], 'open question buttons')
    await page.click(NP + ' [data-act=prioritize]')
    await waitPost(7)
    eq(JSON.stringify(state.posts[6]), '{"type":"prioritize","node":"Q22"}', 'prioritize')
  })
})

// Breaks if the panel offers Strike on a non-assumption.
await check('panel: Strike is offered for assumptions only', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=DEC-1]')
    eq(await page.locator(NP + ' [data-act=strike]').count(), 0, 'strike on a decision')
    await page.click('.node[data-id=T-001]')
    eq(await page.locator(NP + ' [data-act=strike]').count(), 0, 'strike on a task')
  })
})

// Breaks if a field the node holds is not shown: decision (chose/alternatives/why), task (check/files/result),
// settled question (options, answer, by whom), assumption (validate_by/impact/default).
await check('panel: details show every populated field of a decision, task, settled question and assumption', async () => {
  await open('/plan/' + STD, DESK, async page => {
    const text = async id => { await page.click(`.node[data-id=${id}]`); return page.innerText(NP) }
    const has = (t, what, parts) => { for (const p of parts) if (!t.includes(p)) throw new Error(`${what}: panel lacks "${p}"`) }
    has(await text('DEC-1'), 'DEC-1', ['SQLite', 'IndexedDB', 'localStorage', 'Same schema on phone and web; the op-log stays queryable.'])
    has(await text('T-001'), 'T-001', ['npx jest app/db', 'app/db/schema.ts', 'app/db/migrate.ts', 'passed', 'schema applies cleanly'])
    has(await text('Q19'), 'Q19', ['Jest', 'Already in the repo', 'Vitest', 'answered by user'])
    has(await text('AS-1'), 'AS-1', ['Confirm at the readiness gate', 'S2 would not fit with half a developer', 'unexamined'])
    has(await text('T-004'), 'T-004', ['no runnable check'])
  })
})

// Breaks if the history is not filtered to the node, shows other events than plan.recent holds, or has no empty state.
await check('panel: history lists only the node events from plan.recent, and says so when there are none', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=Q7]')
    eq(await page.locator(NP + ' .np-hist li .np-sum').allTextContents(), ['prioritized Q7', 'asked about Q7'], 'Q7 history')
    eq(await page.textContent(NP + ' .np-hist li'), 'prioritized Q7by user via page · rev 95 · 10-17 02:07', 'Q7 first event line')
    await page.click('.node[data-id=T-001]')
    eq(await page.locator(NP + ' .np-hist li .np-sum').allTextContents(), ['T-001 done', 'added T-001: SQLite schema and migrations'], 'T-001 history')
    await page.click('.node[data-id=Q8]')
    eq(await page.locator(NP + ' .np-hist li').count(), 0, 'Q8 events')
    if (!(await page.textContent(NP + ' .np-hist')).includes('No events for this node')) throw new Error('empty state text missing')
  })
})

// ---------- node conversation: the thread, the pending row and the composer in the panel ----------
const TH = '#nodethread'
const T0 = '2026-10-17T03:00:00Z'
const mkThread = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'session' : 'user', text: (i % 2 ? 'Answer ' : 'Question ') + (i + 1) + ' ' + 'word '.repeat(18), at: T0, ref: 'e-th' + i }))
const nodeOf = id => std().nodes.find(n => n.id === id)
// What the CLI does for an ask from the page (plan_core: a user thread entry + an open request) and for the session's reply (a session entry with the request's ref; the request goes).
function applyAsk(plan, ev) {
  const ref = 'e-ask' + plan.rev
  const n = plan.nodes.find(x => x.id === ev.node)
  n.thread = [...(n.thread || []), { role: 'user', text: ev.text, at: '2026-10-17T04:00:00Z', ref }]
  plan.requests.push({ ref, type: 'ask', node: ev.node, lane: null, text: ev.text, at: '2026-10-17T04:00:00Z' })
  plan.rev++
  return { status: 200, body: { ok: true, rev: plan.rev, summary: 'asked about ' + ev.node, nudge: true } }
}
function sessionReply(plan, id, text) {
  const n = plan.nodes.find(x => x.id === id)
  const i = plan.requests.findIndex(r => r.type === 'ask' && r.node === id)
  n.thread = [...(n.thread || []), { role: 'session', text, at: '2026-10-17T04:05:00Z', ref: plan.requests[i].ref }]
  plan.requests.splice(i, 1)
  plan.rev++
}
const bubbles = page => page.locator(TH + ' .th-msg')
const forcePoll = page => page.evaluate(() => poll())
const atBottom = page => page.$eval(TH + ' .th-list', e => e.scrollHeight - e.scrollTop - e.clientHeight < 4)

// Breaks if the thread renders newest first, drops an entry, mixes up the role classes/labels, or collapses the line breaks of a reply.
await check('conversation: a 3-entry thread renders oldest first as bubbles with You/Session labels and kept line breaks', async () => {
  nodeOf('AS-1').thread = [
    { role: 'user', text: 'Why is this here?', at: T0, ref: 'e-th0' },
    { role: 'session', text: 'It sizes the plan.\nSecond line.', at: '2026-10-17T03:01:00Z', ref: 'e-th0' },
    { role: 'user', text: 'And what blocks it?', at: '2026-10-17T03:02:00Z', ref: 'e-th1' },
  ]
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=AS-1]')
    await page.waitForSelector(TH + ' .th-msg')
    eq(await bubbles(page).evaluateAll(l => l.map(x => x.className)), ['th-msg user', 'th-msg session', 'th-msg user'], 'role classes in order')
    eq(await bubbles(page).evaluateAll(l => l.map(x => x.querySelector('.th-text').textContent)), ['Why is this here?', 'It sizes the plan.\nSecond line.', 'And what blocks it?'], 'texts in order')
    eq(await bubbles(page).evaluateAll(l => l.map(x => x.querySelector('.th-meta b').textContent)), ['You', 'Session', 'You'], 'role labels')
    eq(await bubbles(page).nth(1).locator('time').textContent(), '10-17 03:01', 'timestamp')
    eq(await bubbles(page).nth(1).locator('.th-text').evaluate(e => getComputedStyle(e).whiteSpace), 'pre-wrap', 'white-space keeps the line break')
    eq(await page.locator(TH + ' .th-wait').count(), 0, 'no pending row without an open ask')
    eq(await atBottom(page), true, 'opens scrolled to the newest entry')
  })
})

// Breaks if thread text goes in as markup (an <img onerror> or <b> would become an element, run, or hit the CSP).
await check('conversation: entry text with markup stays inert text (no element, no dialog, no console error)', async () => {
  const evil = 'Look <b>bold</b> <img src=x onerror=alert(1)> <script>alert(2)</script>'
  nodeOf('AS-1').thread = [{ role: 'user', text: evil, at: T0, ref: 'e-th0' }, { role: 'session', text: evil, at: T0, ref: 'e-th0' }]
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await page.click('.node[data-id=AS-1]')
    await page.waitForSelector(TH + ' .th-msg')
    eq(await bubbles(page).evaluateAll(l => l.map(x => x.querySelector('.th-text').textContent)), [evil, evil], 'text shown verbatim')
    eq(await page.locator(TH + ' .th-text *').count(), 0, 'elements inside the bubble text')
    await page.waitForTimeout(300)
    eq(ctx.dialogs, [], 'dialogs')
    eq(ctx.errs, [], 'console errors')
  })
})

// Breaks if the empty line is gone, Send is enabled with nothing typed, plain Enter sends instead of adding a line, or Ctrl+Enter does not send.
await check('conversation: empty state line, Send disabled when empty, Enter is a newline, Ctrl+Enter sends the ask event', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=AS-1]')
    await page.waitForSelector(TH + ' textarea')
    if (!(await page.textContent(TH)).includes('Ask anything about this node: why it is here, what it blocks, what to change.')) throw new Error('empty line missing')
    eq(await page.getAttribute(TH + ' textarea', 'placeholder'), 'Ask the session about AS-1…', 'placeholder')
    eq(await page.isDisabled(TH + ' .th-send'), true, 'Send disabled when empty')
    await page.fill(TH + ' textarea', '   ')
    eq(await page.isDisabled(TH + ' .th-send'), true, 'Send disabled for whitespace')
    await page.fill(TH + ' textarea', 'first')
    eq(await page.isDisabled(TH + ' .th-send'), false, 'Send enabled')
    await page.press(TH + ' textarea', 'Enter')
    await page.keyboard.type('second')
    eq(await page.inputValue(TH + ' textarea'), 'first\nsecond', 'Enter adds a line')
    eq(state.posts.length, 0, 'nothing sent by Enter')
    await page.press(TH + ' textarea', 'Control+Enter')
    await waitPost(1)
    eq(JSON.stringify(lastPost()), '{"type":"ask","node":"AS-1","text":"first\\nsecond"}', 'ask event')
  })
})

// Breaks if the 2000 limit is not enforced, or the counter is missing near the limit / shown when far from it.
await check('conversation: counter appears near the 2000 limit and the box stops at 2000', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=AS-1]')
    await page.fill(TH + ' textarea', 'x'.repeat(100))
    eq(await page.isVisible(TH + ' .th-count'), false, 'counter hidden far from the limit')
    await page.fill(TH + ' textarea', 'x'.repeat(1850))
    eq(await page.textContent(TH + ' .th-count'), '1850 / 2000', 'counter near the limit')
    await page.fill(TH + ' textarea', 'x'.repeat(2500))
    eq((await page.inputValue(TH + ' textarea')).length, 2000, 'box length')
  })
})

// Breaks if the ask is posted without node/text, no pending row shows after sending, the draft is not cleared, or the user bubble does not show once the plan has it.
await check('conversation: sending posts ask {node,text}, clears the box and shows the pending row with its hint', async () => {
  state.respond = ev => (ev.type === 'ask' ? applyAsk(std(), ev) : null)
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=AS-1]')
    eq(await page.locator(TH + ' .th-wait').count(), 0, 'no pending row before sending')
    await page.fill(TH + ' textarea', 'Who confirms this?')
    await page.click(TH + ' .th-send')
    await waitPost(1)
    eq(JSON.stringify(lastPost()), '{"type":"ask","node":"AS-1","text":"Who confirms this?"}', 'ask event')
    await page.waitForSelector(TH + ' .th-wait')
    const t = await page.textContent(TH + ' .th-wait')
    if (!t.includes('Waiting for the session…') || !t.includes('It answers when it is next at its prompt')) throw new Error('pending text: ' + t)
    eq(await page.inputValue(TH + ' textarea'), '', 'box cleared')
    eq(await page.isDisabled(TH + ' .th-send'), true, 'Send disabled again')
    await page.waitForFunction(sel => document.querySelectorAll(sel).length === 1, TH + ' .th-msg.user')
    eq(await page.textContent(TH + ' .th-msg.user .th-text'), 'Who confirms this?', 'user bubble')
    eq(await page.evaluate(() => document.querySelector('#nodethread .th-list').lastElementChild.className), 'th-wait', 'pending row follows the last bubble')
    eq(await page.locator(NP).isVisible(), true, 'panel still open')
  })
})

// Breaks if a failed post clears the draft, or the page's error line does not show the failure.
await check('conversation: a failed ask keeps the draft and shows the error; no pending row', async () => {
  state.respond = () => ({ status: 400, body: { error: 'text too long for the fixture' } })
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await page.click('.node[data-id=AS-1]')
    await page.fill(TH + ' textarea', 'keep me')
    await page.click(TH + ' .th-send')
    await waitPost(1)
    await page.waitForSelector('.notice')
    if (!(await page.textContent('.notice')).includes('text too long for the fixture')) throw new Error('error line missing')
    eq(await page.inputValue(TH + ' textarea'), 'keep me', 'draft kept')
    eq(await page.locator(TH + ' .th-wait').count(), 0, 'no pending row')
  }, true)
})

// Breaks if the pending row follows only the optimistic click (Q7 already has an open ask in the plan) or other nodes show it too.
await check('conversation: the pending row comes from an open ask request for that node only', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=Q7]')
    await page.waitForSelector(TH + ' .th-wait')
    await page.click('.node[data-id=AS-1]')
    eq(await page.locator(TH + ' .th-wait').count(), 0, 'AS-1 has none')
  })
})

// Breaks if a reply arriving by poll needs the panel to be reopened, closes it, steals the focus or wipes the half-typed draft, or leaves the pending row.
await check('conversation: a session reply appears live; panel stays open, half-typed draft, focus and caret survive, pending row goes', async () => {
  state.respond = ev => (ev.type === 'ask' ? applyAsk(std(), ev) : null)
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=AS-1]')
    await page.fill(TH + ' textarea', 'Who confirms this?')
    await page.click(TH + ' .th-send')
    await page.waitForSelector(TH + ' .th-wait')
    await page.fill(TH + ' textarea', 'half typed follow-up')
    await page.evaluate(() => { const t = document.querySelector('#nodethread textarea'); t.focus(); t.setSelectionRange(5, 10) })
    sessionReply(std(), 'AS-1', 'The product owner confirms it.\nAt the readiness gate.')
    await forcePoll(page)
    await page.waitForSelector(TH + ' .th-msg.session')
    eq(await page.textContent(TH + ' .th-msg.session .th-text'), 'The product owner confirms it.\nAt the readiness gate.', 'reply text')
    eq(await page.locator(TH + ' .th-wait').count(), 0, 'pending row gone')
    eq(await page.locator(TH + ' .th-msg').evaluateAll(l => l.map(x => x.classList.contains('user') ? 'u' : 's')), ['u', 's'], 'order')
    eq(await page.isVisible(NP), true, 'panel open')
    eq(await page.inputValue(TH + ' textarea'), 'half typed follow-up', 'draft kept')
    eq(await page.evaluate(() => { const t = document.activeElement; return [t.matches('#nodethread textarea'), t.selectionStart, t.selectionEnd] }), [true, 5, 10], 'focus and selection kept')
  })
})

// Breaks if a live re-render always jumps to the newest entry (annoying while reading older ones) or never follows it (a reply stays out of sight).
await check('conversation: the thread scrolls to a new reply only when it was already at the bottom', async () => {
  nodeOf('AS-1').thread = mkThread(10)
  std().requests.push({ ref: 'e-th9', type: 'ask', node: 'AS-1', lane: null, text: 'q', at: T0 })
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=AS-1]')
    await page.waitForSelector(TH + ' .th-msg')
    eq(await atBottom(page), true, 'starts at the bottom')
    sessionReply(std(), 'AS-1', 'reply one')
    await forcePoll(page)
    await page.waitForFunction(() => document.querySelectorAll('#nodethread .th-msg').length === 11)
    eq(await atBottom(page), true, 'followed the new reply from the bottom')
    await page.$eval(TH + ' .th-list', e => { e.scrollTop = 0 })
    std().requests.push({ ref: 'e-th11', type: 'ask', node: 'AS-1', lane: null, text: 'q', at: T0 })
    sessionReply(std(), 'AS-1', 'reply two')
    await forcePoll(page)
    await page.waitForFunction(() => document.querySelectorAll('#nodethread .th-msg').length === 12)
    eq(await page.$eval(TH + ' .th-list', e => e.scrollTop), 0, 'stays where the reader was')
  })
})

// Breaks if the Ask action still opens the old one-line form (or no longer sends to the composer).
await check('conversation: the Ask action focuses the composer instead of opening a form', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=AS-1]')
    await page.click(NP + ' [data-act=ask]')
    eq(await page.evaluate(() => document.activeElement.matches('#nodethread textarea[data-draft=thread]')), true, 'composer focused')
    eq(await page.locator(NP + ' .np-form').count(), 0, 'no inline form')
  })
})

// Breaks if a long thread (40 entries, an unbreakable 300-char word) overflows the page sideways, the thread has no scroll of its own, or the panel stops scrolling.
await check('conversation: a long thread has no horizontal scroll at 390/1440/2560, its own scroll, and the panel still scrolls', async () => {
  const th = mkThread(40)
  th[5].text = 'u'.repeat(300)
  th[6].text = 'https://example.com/' + 'a/'.repeat(120)
  nodeOf('AS-1').thread = th
  std().requests.push({ ref: 'e-th39', type: 'ask', node: 'AS-1', lane: null, text: 'q', at: T0 })
  for (const vp of [PHONE, { width: 1440, height: 900 }, WIDE]) {
    await open('/plan/' + STD, vp, async page => {
      await page.waitForSelector('#titleText:not(:empty)')
      if (vp.width <= 640) await page.click('#bnav [data-view=lanes]')
      await page.click('.node[data-id=AS-1]')
      await page.waitForSelector(TH + ' .th-msg')
      eq(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, vp.width + 'px page overflow')
      const [li, body] = await page.evaluate(() => ['#nodethread .th-list', '#nodepanel .np-body'].map(s => { const e = document.querySelector(s); return { sw: e.scrollWidth - e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight } }))
      eq(li.sw, 0, vp.width + 'px thread sideways overflow')
      eq(li.sh > li.ch && li.ch <= 420, true, vp.width + 'px thread own scroll: ' + JSON.stringify(li))
      if (vp.height <= 900) eq(body.sh > body.ch, true, vp.width + 'px panel scroll: ' + JSON.stringify(body))
      await page.waitForSelector(TH + ' .th-wait')
    })
  }
})

// Breaks if a conversation with a pending row does not render in the panel at the two desktop sizes and on a phone (the shots show how it looks).
await check('conversation: a conversation with a pending ask on a question node (shots at 2560, 1440 and the phone sheet)', async () => {
  nodeOf('Q7').thread = [
    { role: 'user', text: 'Why is this the next question?', at: '2026-10-17T01:00:00Z', ref: 'e-th0' },
    { role: 'session', text: 'Because three open requirements wait on it: FR-001 and FR-004 cannot be written until we know what happens to the version that loses.\n\nIf you prefer, I can park it and ask Q9 first.', at: '2026-10-17T01:02:00Z', ref: 'e-th0' },
    { role: 'user', text: 'Park it, and tell me what Q9 unblocks.', at: '2026-10-17T01:05:00Z', ref: 'e-th1' },
    { role: 'session', text: 'Parked. Q9 unblocks S2 and R-1.', at: '2026-10-17T01:06:00Z', ref: 'e-th1' },
    { role: 'user', text: 'What happens to the version that loses?', at: '2026-10-17T01:26:00Z', ref: 'e-3f9a1c2b7d10' },
  ]
  for (const [vp, name] of [[WIDE, 'conversation-2560.png'], [{ width: 1440, height: 900 }, 'conversation-1440.png'], [PHONE, 'conversation-phone.png']]) {
    await open('/plan/' + STD, vp, async page => {
      await page.waitForSelector('#titleText:not(:empty)')
      if (vp.width <= 640) await page.click('#bnav [data-view=lanes]')
      await page.click('.node[data-id=Q7]')
      await page.waitForSelector(TH + ' .th-wait')
      eq(await page.locator(TH + ' .th-msg').count(), 5, vp.width + 'px bubbles')
      await page.locator(TH).scrollIntoViewIfNeeded()
      if (SHOTS) await page.screenshot({ path: join(SHOTS, name) })
    })
  }
})

// Breaks if a node deleted by another writer leaves its panel open on stale data.
await check('panel: closes when its node vanishes from the plan', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=Q22]')
    await page.waitForSelector(NP + ':not([hidden])')
    std().rev += 1
    std().nodes = std().nodes.filter(n => n.id !== 'Q22')
    std().frontier = std().frontier.filter(id => id !== 'Q22')
    await page.waitForSelector(NP, { state: 'hidden', timeout: 5000 })
  })
})

// Breaks if any plan text reaches innerHTML in the panel (label, option, chose).
await check('panel: markup in a label, an option and a decision renders as text', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  const q = std().nodes.find(n => n.id === 'Q7')
  q.label = evil; q.options[0].label = evil
  std().nodes.find(n => n.id === 'DEC-1').chose = evil
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await page.click('.node[data-id=Q7]')
    eq(await page.textContent(NP + ' h2'), evil, 'label text')
    if (!(await page.textContent(NP + ' .opt[data-key=a]')).includes(evil)) throw new Error('option text missing')
    await page.click('.node[data-id=DEC-1]')
    if (!(await page.innerText(NP)).includes(evil)) throw new Error('chose text missing')
    eq(await page.locator(NP + ' img').count(), 0, 'img elements in the panel')
    await page.waitForTimeout(300)
    eq(ctx.dialogs.length, 0, 'dialogs')
  })
})

// Breaks if a PRD reference, a request link or an Up next row still jumps to the Lanes tab instead of opening the panel where the reader is.
await check('panel: PRD references, Up next rows and request links open the panel without leaving the view', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('#tabs .tab:has-text("PRD")')
    await page.click('#p-prd a.ncl')
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.textContent(NP + ' .np-id'), 'Q7', 'PRD link opens Q7')
    eq(await page.locator('#p-prd').evaluate(e => e.classList.contains('on')), true, 'still on the PRD tab')
    await page.keyboard.press('Escape')
    await page.click('#tabs .tab:has-text("Lanes")')
    await page.click('#now .next .t >> nth=1')
    eq(await page.textContent(NP + ' .np-id'), 'Q8', 'Up next row opens Q8')
    await page.click(NP + ' .np-close')
    await page.click('#now .reqs .linkbtn')
    eq(await page.textContent(NP + ' .np-id'), 'Q7', 'request link opens Q7')
  })
})

// Breaks if a board idea card cannot open the panel, the panel hides the scores / gate evidence the card keeps folded,
// or a button on the card (Boost) also opens it.
await check('panel: a board idea card opens the panel with scores and gate evidence; its own buttons do not', async () => {
  seedIdeate()
  await open(BOARD, WIDE, async page => {
    await page.waitForSelector('#p-board .b-card')
    await card(page, 'I2').locator('[data-act=boost]').click()
    await waitPost()
    eq(await npVisible(page), false, 'panel after a card button')
    await card(page, 'I1').locator('h3 .b-open').click()
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.textContent(NP + ' h2'), 'Local-first store with background sync', 'idea label')
    eq(await card(page, 'I1').locator('.b-more').getAttribute('open'), null, 'card detail stays folded')
    const t = await page.innerText(NP)
    for (const p of ['Sync worker is the long pole but fits two weeks.', 'https://example.com/offline-first-patterns', 'Uses the existing sync endpoints.', 'notes/backend-go-no-go.md', 'Two competitors ship offline editing', 'Commuters and field workers who write notes with no signal']) if (!t.includes(p)) throw new Error('panel lacks "' + p + '"')
    eq(await card(page, 'I1').evaluate(e => e.classList.contains('sel')), true, 'selected card')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'board-2560-panel.png') })
    await page.keyboard.press('Escape')
    eq(await npVisible(page), false, 'panel after Esc')
    eq(await page.evaluate(() => document.activeElement.className), 'b-open', 'focus returns to the card title button')
  })
})

// Breaks if .app keeps a width cap or the lanes stop growing: at 2560x1440 the used region must span >= 85% of the screen
// with and without the panel, the panel must be viewport tall, and the 7 lane columns must be wide.
await check('2560x1440: lanes use the width with and without the panel', async () => {
  await open('/plan/' + STD, WIDE, async page => {
    await page.waitForSelector('.node[data-id=Q22]')
    let [main, lanes] = await edgeBoxes(page, ['.main', '.lanes'])
    if (main.w < 0.85 * 2560) throw new Error('main spans only ' + main.w)
    if (lanes.w < 0.78 * 2560) throw new Error('lanes span only ' + lanes.w + ' without the panel')
    if ((await page.$$eval('.lane', l => l.map(x => x.getBoundingClientRect().width))).some(w => w < 250)) throw new Error('a lane column is under 250px wide')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'lanes-2560.png') })
    await page.click('.node[data-id=Q7]')
    await page.waitForSelector(NP + ':not([hidden])')
    let pn
    ;[main, lanes, pn] = await edgeBoxes(page, ['.main', '.lanes', NP])
    if (pn.r - main.l < 0.85 * 2560) throw new Error('main plus panel span only ' + (pn.r - main.l))
    if (pn.r < 0.95 * 2560) throw new Error('panel ends at ' + pn.r)
    if (pn.w < 420 || pn.w > 600) throw new Error('panel width ' + pn.w)
    if (lanes.w < 0.55 * 2560) throw new Error('lanes span only ' + lanes.w + ' beside the panel')
    eq(pn.h, 1440 - 24, 'panel height')
    eq(await page.$eval('#now', e => getComputedStyle(e).display), 'block', 'Now card stays beside the panel')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'lanes-2560-panel.png') })
  })
})

// Breaks if the PRD is a narrow centred column at 2560: it must fill the width, flow in several columns of readable
// measure, and carry an outline rail that gives way to the panel.
await check('2560x1440: the PRD spreads over the width in columns with an outline; the panel replaces the outline', async () => {
  await open('/plan/' + STD, WIDE, async page => {
    await page.click('#tabs .tab:has-text("PRD")')
    await page.waitForSelector('.prd-outline a')
    const m = await page.evaluate(() => ({
      art: Math.round(document.querySelector('.prd').getBoundingClientRect().width),
      wrap: Math.round(document.querySelector('#p-prd').getBoundingClientRect().width),
      cols: new Set([...document.querySelectorAll('.prd > section')].map(s => Math.round(s.getBoundingClientRect().left))).size,
      measure: Math.max(...[...document.querySelectorAll('.prd p, .prd li')].map(p => Math.round(p.getBoundingClientRect().width))),
    }))
    if (m.wrap < 0.6 * 2560) throw new Error('PRD container spans only ' + m.wrap) // the docked PRD pane takes its 30rem, the Now card its column
    if (m.art < 0.5 * 2560) throw new Error('PRD text spans only ' + m.art)
    if (m.cols < 2) throw new Error('PRD sections sit in ' + m.cols + ' column')
    if (m.measure > 800) throw new Error('PRD line measure is ' + m.measure + 'px')
    eq(await page.locator('.prd-outline a').allTextContents(), ['§0TL;DR', '§1Problem', '§2Users', '§7Functional requirements', '§12Open questions'], 'outline entries')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'prd-2560.png') })
    await page.click('#p-prd a.ncl')
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.isVisible('.prd-outline'), false, 'outline while the panel is open')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'prd-2560-panel.png') })
  })
})

// Breaks if the outline does not follow the reader: the first section is current at the top, the last at the bottom,
// and a click scrolls to its section and makes it current.
await check('PRD outline: marks the section being read and jumps on click', async () => {
  await open('/plan/' + STD, { width: 1440, height: 420 }, async page => {
    await page.click('#tabs .tab:has-text("PRD")')
    await page.waitForSelector('.prd-outline a')
    const cur = () => page.locator('.prd-outline a[aria-current=true]').allTextContents()
    eq(await cur(), ['§0TL;DR'], 'current at the top')
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForFunction(() => document.querySelector('.prd-outline a[aria-current=true]').textContent === '§12Open questions', null, { timeout: 3000 })
    await page.click('.prd-outline a:has-text("Users")')
    await page.waitForFunction(() => document.querySelector('.prd-outline a[aria-current=true]').textContent === '§2Users', null, { timeout: 3000 })
    const top = await page.$eval('#prd-2', e => Math.round(e.getBoundingClientRect().top))
    if (top < -2 || top > 200) throw new Error('section top at ' + top)
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'prd-1440.png') })
  })
})

// Breaks if any view, or the panel, makes the page scroll sideways at the sizes the page is built for.
await check('no horizontal page scroll at 2560, 1440, 1024 and 390 in every view, panel closed and open', async () => {
  for (const vp of [WIDE, { width: 1440, height: 900 }, { width: 1024, height: 768 }, PHONE]) {
    await open('/plan/' + STD, vp, async page => {
      await page.waitForSelector('#titleText:not(:empty)')
      const over = async what => {
        const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        if (o > 0) throw new Error(`${vp.width}px ${what}: ${o}px too wide`)
      }
      const phone = vp.width <= 640
      const go = async v => (phone ? page.click(`#bnav [data-view=${v.toLowerCase()}]`) : page.click(`#tabs .tab:has-text("${v}")`))
      for (const v of phone ? ['Now', 'Lanes', 'PRD', 'Log'] : ['Lanes', 'PRD', 'Build', 'Log']) { await go(v); await over(v) }
      await go('Lanes')
      await page.click('.node[data-id=Q7]')
      await page.waitForSelector(NP + ':not([hidden])')
      await over('Lanes with the panel')
      if (vp.width === 1440 && SHOTS) await page.screenshot({ path: join(SHOTS, 'lanes-1440-panel.png') })
      if (!phone) for (const v of ['PRD', 'Build', 'Log']) { await go(v); await over(v + ' with the panel') }
    })
  }
})

// Breaks if the phone panel is not a full-screen sheet (the Map would stay half visible behind it) or cannot be closed.
await check('390x844: the panel is a full-screen sheet with a Close button', async () => {
  await open('/plan/' + STD, PHONE, async page => {
    await page.click('#bnav [data-view=lanes]')
    await page.click('.node[data-id=Q22]')
    await page.waitForSelector(NP + ':not([hidden])')
    const [sheet] = await edgeBoxes(page, [NP])
    eq([sheet.l, sheet.r, sheet.h], [0, 390, 844], 'sheet box')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'phone-panel.png') })
    await page.click(NP + ' .np-close')
    eq(await npVisible(page), false, 'sheet after Close')
    eq(await page.isVisible('#p-lanes'), true, 'map visible again')
  })
})

// ---------- QA polish: one answer box per question, the PRD task map, the panel across a reload, a removed node ----------
const PLAN_BIN = join(here, '../../../../bin/plan')

// Breaks if the Now card keeps its answer box and buttons while the panel is open on the same question (two boxes, two drafts for one question),
// loses its heading / why line, or does not come back after Close; or if opening the panel on ANOTHER node touches the Now card.
await check('2560x1440: panel open on the Now question: the Now card says so, with no textarea or buttons; Close restores it', async () => {
  seedIdeate()
  await open(BOARD, WIDE, async page => {
    await page.click('#tabs .tab:has-text("Lanes")')
    await page.waitForSelector('.node[data-id=Q1]')
    const q = async sel => page.locator(sel).count()
    eq(await q('textarea[data-draft=other]'), 1, 'answer boxes for Q1 before opening the panel')
    await page.click('.node[data-id=Q2]')
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await q('#now textarea'), 1, 'Now card textarea with the panel on another node')
    await page.click(NP + ' .np-close')
    await page.click('.node[data-id=Q1]')
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await q('textarea[data-draft=other]'), 1, 'answer boxes for Q1 with the panel open on it')
    eq(await q('#now textarea'), 0, 'Now card textarea')
    eq(await q('#now .btns, #now .opt, #now .form'), 0, 'Now card buttons and inputs')
    eq(await page.textContent('#now .here'), 'Answering in the panel', 'calm line')
    eq(await page.textContent('#now .qid'), 'Q1', 'Now heading kept')
    if (!(await page.textContent('#now .why')).includes('A concrete story keeps the PRD')) throw new Error('why line lost')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ideate-2560-panel-on-now.png') })
    await page.click(NP + ' .np-close')
    eq(await q('#now textarea'), 1, 'Now card textarea after Close')
    eq(await q('#now .here'), 0, 'calm line after Close')
  })
})

// Breaks if the task map's check cells split a word across lines ("app/qu eue"), the empty P column is still drawn (or is dropped when it has data),
// or the table pushes the page sideways.
await check('PRD task map: no check word is split mid-word at 2560, the empty P column is hidden, no page scroll at 390 / 1440 / 2560', async () => {
  const md = readFileSync(join(FIX, 'plan-standard.PRD.md'), 'utf8')
  const withP = md.replace('| T-001 |  | `npx jest app/queue` |', '| T-001 | 2 | `npx jest app/queue` |')
  if (withP === md) throw new Error('fixture row for the P column data not found')
  const heads = page => page.$$eval('.prd th', l => l.map(x => x.textContent))
  const split = page => page.evaluate(() => {
    const out = []
    for (const code of document.querySelectorAll('.prd td code')) {
      const w = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
      for (let t; (t = w.nextNode());) for (const m of t.data.matchAll(/\S+/g)) {
        const r = document.createRange(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length)
        if (new Set([...r.getClientRects()].map(x => Math.round(x.top))).size > 1) out.push(m[0])
      }
    }
    return out
  })
  for (const vp of [WIDE, { width: 1440, height: 900 }, PHONE]) {
    state.prd[STD] = md
    await open('/plan/' + STD, vp, async page => {
      await page.waitForSelector('#titleText:not(:empty)')
      if (vp.width === PHONE.width) await page.click('#bnav [data-view=prd]'); else await page.click('#tabs .tab:has-text("PRD")')
      await page.waitForSelector('.prd td code')
      eq(await heads(page), ['id', 'slice', 'covers', 'files', 'depends on', 'check', 'status'], 'task map columns at ' + vp.width)
      const mid = await split(page)
      if (vp.width === 2560) eq(mid, [], 'words split across lines at 2560')
      eq(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no page scroll at ' + vp.width)
      if (vp.width === 2560) {
        eq(await page.$$eval('.prd .tw', l => l.map(x => x.scrollWidth <= x.clientWidth)).then(a => a.every(Boolean)), true, 'no table scrolls inside its column at 2560')
        if (SHOTS) { await page.locator('.prd h2:has-text("Task map")').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(SHOTS, 'prd-2560-taskmap.png') }) }
      }
    })
  }
  state.prd[STD] = withP
  await open('/plan/' + STD, WIDE, async page => {
    await page.click('#tabs .tab:has-text("PRD")')
    await page.waitForSelector('.prd td code')
    eq(await page.$$eval('.prd th', l => l.map(x => x.textContent)), ['id', 'slice', 'covers', 'files', 'depends on', 'P', 'check', 'status'], 'task map columns with P data')
    eq(await page.$$eval('.prd tbody tr:nth-child(2) td', l => l[5].textContent), '2', 'P value kept')
  })
})

// Breaks if the open node lives only in memory: after a reload the panel must be open on the same node, closed stays closed, and a hash
// naming a missing node is ignored without a toast, an error or a panel.
await check('panel: the open node survives a reload through location.hash; Close clears it; a bad hash is ignored', async () => {
  await open('/plan/' + STD, DESK, async page => {
    const hist = await page.evaluate(() => history.length)
    await page.click('.node[data-id=Q22]')
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.evaluate(() => location.hash), '#node=Q22', 'hash with the panel open')
    eq(await page.evaluate(() => history.length), hist, 'history entries (replaceState, no history spam)')
    await page.reload()
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.textContent(NP + ' .np-id'), 'Q22', 'panel node after reload')
    await page.click('.node[data-id=Q8]')
    eq(await page.evaluate(() => location.hash), '#node=Q8', 'hash after switching node')
    await page.click(NP + ' .np-close')
    eq(await page.evaluate(() => location.hash), '', 'hash after Close')
    await page.reload()
    await page.waitForSelector('.node[data-id=Q22]')
    eq(await npVisible(page), false, 'panel after reload when closed')
  })
  await open('/plan/' + STD + '#node=NOPE', DESK, async (page, ctx) => {
    await page.waitForSelector('.node[data-id=Q22]')
    eq(await npVisible(page), false, 'panel for a missing node')
    eq(await page.locator('#toast.on').count(), 0, 'toast for a missing node')
    eq(await page.isVisible('#notice'), false, 'notice for a missing node')
    eq(ctx.errs, [], 'console errors')
  })
})

// Breaks if a node the session removes (the real `plan event --by session` remove) while its panel is open makes the panel vanish silently:
// the toast must say which node went, and the panel and the hash must go with it.
await check('panel: a node removed by the session closes the open panel with a notice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-f1-'))
  const cli = (...a) => {
    const r = Bun.spawnSync([PLAN_BIN, ...a], { env: { ...process.env, CREW_ROOT: root } })
    if (r.exitCode !== 0) throw new Error('plan ' + a.join(' ') + ': ' + r.stderr.toString())
    return r.stdout.toString()
  }
  const pull = () => { state.plans.f3 = JSON.parse(cli('show', 'f3', '--json')); state.prd.f3 = '' }
  try {
    cli('init', 'f3', '--title', 'Removal plan', '--size', 'quick')
    pull()
    await open('/plan/f3', DESK, async page => {
      await page.waitForSelector('.node[data-id=Q3]')
      await page.click('.node[data-id=Q3]')
      await page.waitForSelector(NP + ':not([hidden])')
      cli('event', 'f3', '--by', 'session', '--json', '{"type":"remove","node":"Q3"}')
      pull()
      await page.waitForSelector(NP, { state: 'hidden', timeout: 5000 })
      await page.waitForSelector('#toast.on')
      eq(await page.textContent('#toast'), 'Q3 was removed by the session', 'toast text')
      eq(await page.evaluate(() => location.hash), '', 'hash after the node is gone')
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---------- teammate comments on the PRD view (contract §13): composer, lists by section and node, proposals ----------
const CM_AT = '2026-10-17T05:00:00Z'
const CM_PAT = '2026-10-17T05:10:00Z'
const mkCm = (id, o) => ({ id, author: 'Sam', text: 'Comment ' + id, anchor: null, at: CM_AT, state: 'open', source: 'paste', proposal: null, ...o })
const mkProp = (action, o) => ({ action, text: 'Because.', rev: 95, changes: [], at: CM_PAT, ...o })
const REPLY = 'Last write wins, per Q7.\nSee §7.'
// One comment in every state; the PRD above has sections 0, 1, 2, 7 and 12 only.
function seedComments(extra) {
  std().comments = [
    mkCm('CM1', { author: 'Priya', text: 'Who owns the sync spec?\nSecond line' }),
    mkCm('CM2', { author: 'Lee', anchor: '§7', text: 'Queue must survive a restart', state: 'proposed', proposal: mkProp('accept', { text: 'Adds the durability requirement.', changes: [
      { type: 'upsert', node: { kind: 'requirement', label: 'Queue survives restart', body: 'The op queue persists across app restarts', nfr: 'durability' } },
      { type: 'upsert', node: { id: 'FR-001', label: 'Users can edit offline', body: 'Edits work offline' } },
      { type: 'reopen', node: 'Q8' },
      { type: 'edit_label', node: 'Q7', label: 'Conflict policy' },
      { type: 'set', field: 'tldr', value: 'Notes sync offline' },
    ] }) }),
    mkCm('CM3', { author: 'Ana', anchor: 'Q7', text: 'What is the conflict policy?', state: 'proposed', proposal: mkProp('answer', { text: REPLY }) }),
    mkCm('CM4', { author: 'Raj', anchor: '§12', text: 'Drop the RFC link', state: 'proposed', proposal: mkProp('decline', { text: 'The RFC is the wire format source.' }) }),
    mkCm('CM5', { author: 'Kim', anchor: '§7', text: 'FR-2 is fine', state: 'accepted', proposal: mkProp('accept', { text: 'No change needed.', changes: [{ type: 'reopen', node: 'Q8' }] }) }),
    mkCm('CM6', { author: 'Joe', text: 'Is this for web too?', state: 'answered', proposal: mkProp('answer', { text: 'Web is out of scope (NG-1).' }) }),
    mkCm('CM7', { author: 'Zed', anchor: '§5', text: 'Add a rollout section', state: 'declined', proposal: mkProp('decline', { text: 'Rollout lives in the slices.' }) }),
    ...(extra || []),
  ]
  std().rev++
}
const cmGoPrd = (page, phone) => (phone ? page.click('#bnav [data-view=prd]') : page.click('#tabs .tab:has-text("PRD")'))
const cmEl = (page, id) => page.locator(`.cm[data-id=${id}]`)
const CM_TYPES = ['comment', 'comment_accept', 'comment_rework', 'comment_delete']

// Breaks if the composer posts the wrong shape (the text trimmed of nothing, an empty author or "Whole PRD" sent as "", a missing field),
// lets an empty comment through, or forgets to clear the box while keeping the author and the anchor for the next paste.
await check('comments: the composer posts text, author and anchor, clears the text and keeps author and anchor', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    eq(await page.isDisabled('#cm-send'), true, 'Add comments disabled when empty')
    await page.fill('#cm-text', '   ')
    eq(await page.isDisabled('#cm-send'), true, 'Add comments disabled for blanks')
    await page.fill('#cm-text', 'First point\n\nSecond point')
    await page.fill('#cm-author', 'Dana')
    await page.selectOption('#cm-anchor', '§7')
    await page.click('#cm-send')
    await waitPost()
    eq(lastPost(), { type: 'comment', text: 'First point\n\nSecond point', author: 'Dana', anchor: '§7' }, 'event')
    await page.waitForFunction(() => document.getElementById('cm-text').value === '')
    eq(await page.inputValue('#cm-author'), 'Dana', 'author kept')
    eq(await page.inputValue('#cm-anchor'), '§7', 'anchor kept')
    eq(await page.isDisabled('#cm-send'), true, 'disabled again after clearing')
  })
})

// Breaks if Ctrl+Enter does not send, a blank author or the "Whole PRD" choice is posted as a field, or a node id cannot be the anchor.
await check('comments: Ctrl+Enter sends; no author and Whole PRD post only the text; a node can be the anchor', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.fill('#cm-text', 'Just a paste')
    await page.press('#cm-text', 'Control+Enter')
    await waitPost(1)
    eq(lastPost(), { type: 'comment', text: 'Just a paste' }, 'event without author and anchor')
    await page.waitForFunction(() => document.getElementById('cm-text').value === '')
    await page.fill('#cm-text', 'About Q7')
    await page.selectOption('#cm-anchor', 'Q7')
    await page.click('#cm-send')
    await waitPost(2)
    eq(lastPost(), { type: 'comment', text: 'About Q7', anchor: 'Q7' }, 'node anchor')
    eq(await page.$$eval('#cm-anchor option', l => l.map(o => o.value).filter(v => /^§/.test(v))), ['§0', '§1', '§2', '§7', '§12'], 'section choices are the sections of the PRD')
    eq(await page.$eval('#cm-anchor option[value=Q7]', o => o.textContent), 'Q7 · Conflict policy when two devices edit the same note', 'node choice shows id and label')
  })
})

// Breaks if the counter is missing near the 5000 limit, shows far from it, or the box has no limit.
await check('comments: the counter shows near 5000 and the box is capped at 5000', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.fill('#cm-text', 'x'.repeat(100))
    eq(await page.textContent('#cm-count'), '', 'no counter far from the limit')
    await page.fill('#cm-text', 'x'.repeat(4600))
    eq(await page.textContent('#cm-count'), '4600 / 5000', 'counter near the limit')
    eq(await page.getAttribute('#cm-text', 'maxlength'), '5000', 'maxlength')
  })
})

// Breaks if the author is lost on reload (a teammate's name would be retyped for every paste).
await check('comments: the author is remembered across a reload', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    eq(await page.inputValue('#cm-author'), '', 'empty at first')
    await page.fill('#cm-author', 'Dana Whitfield')
    await page.reload()
    await cmGoPrd(page)
    eq(await page.inputValue('#cm-author'), 'Dana Whitfield', 'author after reload')
  })
})

// Breaks if the page dies or shows no composer when localStorage throws (private windows).
await check('comments: a throwing localStorage does not break the page or the composer', async () => {
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied') } }) })
    await page.reload()
    await cmGoPrd(page)
    await page.fill('#cm-text', 'still works')
    await page.fill('#cm-author', 'Dana')
    await page.click('#cm-send')
    await waitPost()
    eq(lastPost(), { type: 'comment', text: 'still works', author: 'Dana' }, 'event')
    eq(ctx.errs, [], 'console errors')
  })
})

// Breaks if a comment shows under the wrong section, a node comment is missing from the PRD list or the node panel, or an unanchored
// comment (or one on a section the PRD does not have) is not in the group at the top.
await check('comments: listed under their section, on their node (list and panel), and the rest in Unanchored below the PRD', async () => {
  seedComments()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm')
    eq(await page.locator('#prd-7 .cm').evaluateAll(l => l.map(x => x.dataset.id)), ['CM2', 'CM5'], 'comments under §7')
    eq(await page.locator('#prd-12 .cm').evaluateAll(l => l.map(x => x.dataset.id)), ['CM4'], 'comments under §12')
    eq(await page.locator('#prd-0 .cm, #prd-1 .cm, #prd-2 .cm').count(), 0, 'no stray comments in other sections')
    eq(await page.locator('#cm-unanchored .cm').evaluateAll(l => l.map(x => x.dataset.id)), ['CM1', 'CM6', 'CM7'], 'Unanchored holds anchor null and a section the PRD lacks')
    eq(await page.textContent('#cm-unanchored .cm[data-id=CM7] .cm-anchor'), '§5', 'a missing section is named')
    eq(await page.locator('#cm-nodes .cm').evaluateAll(l => l.map(x => x.dataset.id)), ['CM3'], 'comments on nodes')
    const y = async s => (await page.locator(s).first().boundingBox()).y
    if (!(await y('#prd-12') < await y('#cm-box') && await y('#cm-box') < await y('#cm-unanchored'))) throw new Error('order: the PRD, then the composer, then Unanchored')
    await page.click('#cm-nodes .cm[data-id=CM3] .cm-anchor')
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.textContent(NP + ' .np-id'), 'Q7', 'the node chip opens the panel')
    eq(await page.locator(NP + ' #nodecomments .cm').evaluateAll(l => l.map(x => x.dataset.id)), ['CM3'], 'the panel lists the comment on its node')
    await page.click('.np-close')
  })
  await open('/plan/' + STD + '#node=Q22', DESK, async page => {
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.locator(NP + ' #nodecomments').count(), 0, 'no Comments block for a node without comments')
  })
})

// Breaks if a badge is colour only (it must carry a word), a state is missing, the author is blank for an unknown author, or the time lacks the absolute title.
await check('comments: each of the five states has a badge with its word; time has an absolute title; "Waiting for the session…" only on open', async () => {
  const recent = new Date(Date.now() - 5 * 60000).toISOString()
  seedComments([mkCm('CM8', { author: '', text: 'no name', at: recent })])
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm')
    const badge = id => page.textContent(`.cm[data-id=${id}] .cm-badge .w`)
    eq([await badge('CM1'), await badge('CM2'), await badge('CM5'), await badge('CM6'), await badge('CM7')], ['open', 'proposed', 'accepted', 'answered', 'declined'], 'badge words')
    eq(await page.getAttribute('.cm[data-id=CM1] time', 'title'), CM_AT, 'absolute time in title')
    eq(await page.textContent('.cm[data-id=CM8] time'), '5 min ago', 'relative time')
    eq(await page.textContent('.cm[data-id=CM8] .cm-au'), 'Unknown', 'unknown author')
    eq(await page.textContent('.cm[data-id=CM1] .cm-wait'), 'Waiting for the session…', 'open comment waits')
    eq(await page.locator('.cm-wait').count(), 2, 'only the two open comments wait')
    eq(await page.locator('.cm[data-id=CM1] .cm-wait').evaluate(e => getComputedStyle(e).animationName), 'none', 'no animation on the waiting line')
  })
})

// Breaks if the tab chip is missing, counts accepted/declined comments, or does not go away when nothing is open.
await check('comments: the PRD tab says how many comments are open or proposed', async () => {
  seedComments()
  await open('/plan/' + STD, DESK, async page => {
    await page.waitForSelector('#tabs .tab')
    eq(await page.textContent('#tabs .tab:has-text("PRD")'), 'PRD · 4 open', 'tab with 1 open + 3 proposed')
    eq(await page.textContent('#bnav [data-view=prd]'), '§PRD · 4', 'phone nav')
    std().comments = std().comments.filter(c => !['open', 'proposed'].includes(c.state))
    std().rev++
    await forcePoll(page)
    await page.waitForFunction(() => document.querySelector('#tabs .tab:nth-child(2)').textContent === 'PRD')
  })
})

// Breaks if any change is hidden or abbreviated before Accept: every change line and every upsert field must show.
await check('comments: a proposal lists every change, every upsert field with its value, and the reply text', async () => {
  seedComments()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm')
    eq(await page.locator('.cm[data-id=CM2] .cm-ch-h').allTextContents(),
      ['Upsert · requirement · new', 'Upsert · requirement · FR-001', 'Reopen · Q8', 'Edit label · Q7 → “Conflict policy”', 'Set tldr → “Notes sync offline”'], 'change headers (kind, id or new)')
    const fields = i => page.locator('.cm[data-id=CM2] .cm-change').nth(i).locator('.cm-f > div').evaluateAll(l => l.map(d => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]))
    eq(await fields(0), [['label', 'Queue survives restart'], ['body', 'The op queue persists across app restarts'], ['nfr', 'durability']], 'new upsert fields')
    eq(await fields(1), [['label', 'Users can edit offline'], ['body', 'Edits work offline']], 'upsert of FR-001 fields')
    eq(await page.textContent('.cm[data-id=CM2] .cm-ref'), 'How long are tombstones kept?', 'the reopened node is named')
    eq(await page.textContent('.cm[data-id=CM2] .cm-pt'), 'Adds the durability requirement.', 'proposal text')
    eq(await page.textContent('.cm[data-id=CM2] .cm-pl'), 'Proposal: add to the plan', 'action label')
    eq(await page.textContent('.cm[data-id=CM3] .cm-pl'), 'Proposed reply', 'answer label')
    eq(await page.textContent('.cm[data-id=CM3] .cm-pt'), REPLY, 'reply text keeps its line break')
    eq(await page.textContent('.cm[data-id=CM4] .cm-pl'), 'Proposal: decline', 'decline label')
    eq(await page.textContent('.cm[data-id=CM4] .cm-pt'), 'The RFC is the wire format source.', 'the reason shows')
  })
})

// Breaks if Accept is offered for a reply or a decline (nothing to apply), is missing for an accept, or posts the wrong proposal stamp.
await check('comments: Accept exists for an accept proposal only and posts comment_accept with proposal = proposal.rev', async () => {
  seedComments()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm')
    eq(await page.locator('.cm[data-id=CM3] [data-act=accept], .cm[data-id=CM4] [data-act=accept]').count(), 0, 'no Accept on answer or decline')
    eq(await page.getAttribute('.cm[data-id=CM2] [data-act=accept]', 'aria-label'), 'Accept the proposal on CM2', 'accessible name')
    await page.click('.cm[data-id=CM2] [data-act=accept]')
    await waitPost()
    eq(lastPost(), { type: 'comment_accept', ref: 'CM2', proposal: 95 }, 'event')
  })
})

// Breaks if Accept after a server refusal (stale proposal) keeps showing the old proposal: the error must show and the list must refresh at once.
await check('comments: a refused (stale) Accept shows the server error and the list refreshes', async () => {
  seedComments()
  state.respond = ev => {
    if (ev.type !== 'comment_accept') return null
    const c = std().comments.find(x => x.id === ev.ref)
    Object.assign(c, { state: 'open', proposal: null })
    std().rev++
    return { status: 400, body: { error: 'proposal changed' } }
  }
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.click('.cm[data-id=CM2] [data-act=accept]')
    await page.waitForSelector('#notice:not([hidden])')
    eq(await page.textContent('#notice .msg'), 'proposal changed', 'server error shown')
    await page.waitForFunction(() => document.querySelector('.cm[data-id=CM2] .cm-badge .w').textContent === 'open', null, { timeout: 1500 })
  }, true)
})

// Breaks if Rework posts at once without asking what should change, loses the text, or an empty box still posts text "".
await check('comments: Rework opens "what should change?", posts comment_rework with the text; Escape cancels; empty sends no text', async () => {
  seedComments()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.click('.cm[data-id=CM2] [data-act=rework]')
    eq(await page.getAttribute('.cm[data-id=CM2] [data-draft=cm-rw]', 'placeholder'), 'What should change?', 'prompt')
    eq(await page.evaluate(() => document.activeElement.dataset.draft), 'cm-rw', 'focus moves to the input')
    await page.keyboard.press('Escape')
    eq(await page.locator('[data-draft=cm-rw]').count(), 0, 'Escape closes it')
    eq(state.posts.length, 0, 'nothing posted')
    await page.click('.cm[data-id=CM2] [data-act=rework]')
    await page.fill('[data-draft=cm-rw]', 'Make it a risk, not a requirement')
    await page.press('[data-draft=cm-rw]', 'Enter')
    await waitPost()
    eq(lastPost(), { type: 'comment_rework', ref: 'CM2', text: 'Make it a risk, not a requirement' }, 'event with text')
    await page.click('.cm[data-id=CM3] [data-act=rework]')
    await page.click('.cm[data-id=CM3] [data-act=rework-send]')
    await waitPost(2)
    eq(lastPost(), { type: 'comment_rework', ref: 'CM3' }, 'event without text')
  })
})

// Breaks if Delete fires at once or through a browser dialog; it must confirm inline, post comment_delete only after, and Keep must cancel.
await check('comments: Delete confirms inline (no browser dialog) and posts comment_delete only after the confirm', async () => {
  seedComments()
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await cmGoPrd(page)
    await page.click('.cm[data-id=CM1] [data-act=delete]')
    eq(state.posts.length, 0, 'not posted by the first click')
    eq(await page.textContent('.cm[data-id=CM1] .cm-confirm'), 'Delete this comment?DeleteKeep', 'inline confirm')
    await page.click('.cm[data-id=CM1] [data-act=delete-keep]')
    eq(await page.locator('.cm[data-id=CM1] .cm-confirm').count(), 0, 'Keep closes the confirm')
    await page.click('.cm[data-id=CM1] [data-act=delete]')
    await page.click('.cm[data-id=CM1] [data-act=delete-confirm]')
    await waitPost()
    eq(lastPost(), { type: 'comment_delete', ref: 'CM1' }, 'event')
    eq(ctx.dialogs, [], 'no browser dialog')
  })
})

// Breaks if Copy reply copies anything but the exact reply, or shows no "Copied" feedback.
await check('comments: Copy reply puts the exact reply on the clipboard and toasts "Copied"', async () => {
  seedComments()
  await open('/plan/' + STD, DESK, async page => {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__clip = t } }, configurable: true }))
    await cmGoPrd(page)
    eq(await page.locator('.cm[data-id=CM2] [data-act=copy], .cm[data-id=CM4] [data-act=copy]').count(), 0, 'Copy reply only for an answer')
    await page.click('.cm[data-id=CM3] [data-act=copy]')
    await page.waitForFunction(() => window.__clip !== undefined)
    eq(await page.evaluate(() => window.__clip), REPLY, 'clipboard text')
    eq(await page.textContent('#toast'), 'Copied', 'toast')
  })
})

// Breaks if Copy reply does nothing where navigator.clipboard is missing (plain http, old browsers): select + execCommand must run.
await check('comments: Copy reply falls back to select + execCommand when navigator.clipboard is missing', async () => {
  seedComments()
  await open('/plan/' + STD, DESK, async page => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
      document.addEventListener('copy', () => { window.__copied = document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd) })
    })
    await cmGoPrd(page)
    await page.click('.cm[data-id=CM3] [data-act=copy]')
    await page.waitForFunction(() => window.__copied !== undefined)
    eq(await page.evaluate(() => window.__copied), REPLY, 'selected text at copy time')
    eq(await page.textContent('#toast'), 'Copied', 'toast')
    eq(await page.locator('body > textarea').count(), 0, 'the scratch textarea is removed')
  })
})

// Breaks if accepted/answered/declined comments take as much room as live ones (they must be one quiet line until expanded), or the expand state is lost on a poll.
await check('comments: accepted, answered and declined are one line until expanded, and stay expanded through a poll', async () => {
  seedComments()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    for (const id of ['CM5', 'CM6', 'CM7']) {
      eq(await cmEl(page, id).locator('.cm-body').count(), 0, id + ' collapsed')
      eq(await cmEl(page, id).locator('.cm-tog').getAttribute('aria-expanded'), 'false', id + ' aria-expanded')
    }
    eq(await cmEl(page, 'CM7').locator('.cm-sum').textContent(), 'Add a rollout section', 'one-line summary is the comment text')
    await cmEl(page, 'CM7').locator('.cm-tog').click()
    eq(await cmEl(page, 'CM7').locator('.cm-pt').textContent(), 'Rollout lives in the slices.', 'the decline reason shows when expanded')
    std().rev++
    await forcePoll(page)
    await page.waitForFunction(() => document.querySelector('#p-prd').textContent.includes('Rollout lives in the slices.'))
    eq(await cmEl(page, 'CM7').locator('.cm-tog').getAttribute('aria-expanded'), 'true', 'still expanded after the poll')
  })
})

// Breaks if a long comment is shown whole (the list becomes a wall), has no way to read it all, or short ones get a useless button.
await check('comments: a long comment collapses to about 4 lines with show more / show less; a short one has no button', async () => {
  seedComments([mkCm('CM8', { text: Array.from({ length: 9 }, (_, i) => 'Line ' + (i + 1)).join('\n') })])
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    const t = '.cm[data-id=CM8] .cm-text'
    eq(await page.locator('.cm[data-id=CM1] [data-act=more]').count(), 0, 'short: no button')
    const lh = await page.$eval(t, e => parseFloat(getComputedStyle(e).lineHeight))
    const h0 = (await page.locator(t).boundingBox()).height
    if (!(h0 < lh * 4.5)) throw new Error('collapsed height ' + h0 + ' for line height ' + lh)
    eq(await page.textContent('.cm[data-id=CM8] [data-act=more]'), 'show more', 'button')
    await page.click('.cm[data-id=CM8] [data-act=more]')
    if (!((await page.locator(t).boundingBox()).height > lh * 8)) throw new Error('still collapsed')
    eq(await page.textContent('.cm[data-id=CM8] [data-act=more]'), 'show less', 'button flips')
  })
})

// Breaks if comment text, an author or proposal fields reach innerHTML: the <img> would become an element, run onerror, or hit the CSP.
await check('comments: markup in text, author, proposal text and change fields stays inert text', async () => {
  const bad = '<img src=x onerror=alert(1)>'
  seedComments([
    mkCm('CM8', { author: '<b onmouseover=alert(2)>Eve</b>', text: bad + '\n<script>alert(3)</script>' }),
    mkCm('CM9', { text: 'x', state: 'proposed', proposal: mkProp('accept', { text: bad, changes: [{ type: 'upsert', node: { kind: 'note', label: bad, body: bad } }, { type: 'edit_label', node: 'Q7', label: bad }] }) }),
  ])
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm[data-id=CM9]')
    await page.waitForTimeout(300)
    eq(await page.locator('#p-prd .cm img, #p-prd .cm script, #p-prd .cm-au b').count(), 0, 'no element from comment text')
    eq(await page.textContent('.cm[data-id=CM8] .cm-au'), '<b onmouseover=alert(2)>Eve</b>', 'author is text')
    eq(await page.textContent('.cm[data-id=CM8] .cm-text'), bad + '\n<script>alert(3)</script>', 'comment is text')
    eq(await page.locator('.cm[data-id=CM9] .cm-change').first().locator('dd').allTextContents(), [bad, bad], 'upsert fields are text')
    eq(ctx.dialogs, [], 'no dialog')
    eq(ctx.errs, [], 'console errors')
  })
})

// Breaks if a live re-render wipes a half-typed paste or rework note, moves the caret, steals focus, or throws the reader back to the top.
await check('comments: composer and rework drafts, focus, caret and scroll survive a live re-render', async () => {
  seedComments()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.fill('#cm-text', 'half a paste')
    await page.evaluate(() => { const t = document.getElementById('cm-text'); t.focus(); t.setSelectionRange(2, 6) })
    std().comments.push(mkCm('CM8', { text: 'arrived while typing' }))
    std().rev++
    await forcePoll(page)
    await page.waitForSelector('.cm[data-id=CM8]')
    eq(await page.inputValue('#cm-text'), 'half a paste', 'composer draft kept')
    eq(await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]), ['cm-text', 2, 6], 'focus and caret kept')
    await page.click('.cm[data-id=CM2] [data-act=rework]')
    await page.fill('[data-draft=cm-rw]', 'rework note')
    std().rev++
    await forcePoll(page)
    await page.waitForFunction(() => document.querySelector('[data-draft=cm-rw]') && document.activeElement.dataset.draft === 'cm-rw')
    eq(await page.inputValue('[data-draft=cm-rw]'), 'rework note', 'rework draft kept')
    await page.evaluate(() => window.scrollTo(0, 300))
    const y0 = await page.evaluate(() => scrollY)
    if (y0 < 100) throw new Error('page did not scroll: ' + y0)
    std().rev++
    await forcePoll(page)
    await page.waitForTimeout(200)
    const y1 = await page.evaluate(() => scrollY)
    if (Math.abs(y1 - y0) > 2) throw new Error(`scroll moved from ${y0} to ${y1}`)
  })
})

// Breaks if a draft is dropped when a send fails: the paste must stay so it can be sent again.
await check('comments: a refused comment keeps the draft and shows the error', async () => {
  state.respond = ev => (ev.type === 'comment' ? { status: 400, body: { error: '100 comments exist; delete closed comments' } } : null)
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.fill('#cm-text', 'keep me')
    await page.click('#cm-send')
    await page.waitForSelector('#notice:not([hidden])')
    eq(await page.inputValue('#cm-text'), 'keep me', 'draft kept')
    eq(await page.textContent('#notice .msg'), '100 comments exist; delete closed comments', 'error')
  }, true)
})

// Breaks if any control posts a session-only event (comment_split, comment_triage, reply) or an event outside the four the page may send.
await check('comments: no control posts a session-only event; every post is one of the four user events', async () => {
  for (const t of ['comment_split', 'comment_triage', "type: 'reply'", 'comment_import']) if (PAGE.includes(t)) throw new Error('plan.html mentions ' + t)
  seedComments()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.fill('#cm-text', 'one')
    await page.click('#cm-send')
    await waitPost(1)
    await page.click('.cm[data-id=CM2] [data-act=accept]')
    await waitPost(2)
    await page.click('.cm[data-id=CM3] [data-act=rework]')
    await page.click('.cm[data-id=CM3] [data-act=rework-send]')
    await waitPost(3)
    await page.click('.cm[data-id=CM4] [data-act=delete]')
    await page.click('.cm[data-id=CM4] [data-act=delete-confirm]')
    await waitPost(4)
    await page.click('.cm[data-id=CM3] [data-act=copy]')
    eq(state.posts.map(p => p.type), CM_TYPES, 'posted types')
  })
})

// Breaks if comments make the page scroll sideways (a long unbroken word, a long change field), at the sizes the page is built for, or a state shows no look at those sizes.
await check('comments: no horizontal scroll at 2560, 1440, 1024 and 390 with comments in every state, an unbroken word, and the panel open; shots', async () => {
  const word = 'W'.repeat(240)
  seedComments([mkCm('CM8', { author: word, text: word }),
    mkCm('CM9', { text: 'x', state: 'proposed', anchor: '§7', proposal: mkProp('accept', { text: word, changes: [{ type: 'upsert', node: { kind: 'note', label: word, body: word } }] }) })])
  for (const vp of [WIDE, { width: 1440, height: 900 }, { width: 1024, height: 768 }, PHONE]) {
    await open('/plan/' + STD, vp, async page => {
      const phone = vp.width <= 640
      await cmGoPrd(page, phone)
      await page.waitForSelector('.cm')
      await cmEl(page, 'CM7').locator('.cm-tog').click()
      const over = async what => {
        const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        if (o > 0) throw new Error(`${vp.width}px ${what}: ${o}px too wide`)
      }
      await over('PRD comments')
      if (phone) {
        const w = await page.$eval('.cm[data-id=CM1]', e => Math.round(e.getBoundingClientRect().width))
        if (w < PHONE.width - 16 * 2 - 24 - 2) throw new Error('comment is not full width on the phone: ' + w)
      }
      if (SHOTS) {
        const tag = phone ? 'phone' : String(vp.width)
        await page.screenshot({ path: join(SHOTS, `comments-${tag}.png`) })
        await page.locator('#prd-7').scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(SHOTS, `comments-${tag}-section.png`) })
        await page.screenshot({ path: join(SHOTS, `comments-${tag}-full.png`), fullPage: true })
      }
      await page.click('.cm[data-id=CM9] .cm-anchor').catch(() => {})
      await page.evaluate(() => selectNode('Q7'))
      await page.waitForSelector(NP + ':not([hidden])')
      await over('with the panel')
      if (SHOTS && !phone) await page.screenshot({ path: join(SHOTS, `comments-${vp.width}-panel.png`) })
    })
  }
})

// ---------- the PRD-wide pane (card C3b): the session conversation about the whole PRD, docked from 1800px, a sheet below ----------
const PN = '#prdpane'
const PL = PN + ' .th-list'
const P_AT = '2026-10-17T06:00:00Z'
const MID = { width: 1440, height: 900 }
const TAB = { width: 1024, height: 768 }
// What the CLI does for an ask without a node (plan_core: a user entry on the plan thread + an open request with node null) and for the session's reply (a session entry with the request's ref and its links; the request goes).
function applyPaneAsk(plan, ev) {
  if (ev.type !== 'ask' || ev.node) return null
  const ref = 'e-pn' + plan.rev
  plan.thread = [...(plan.thread || []), { role: 'user', text: ev.text, at: P_AT, ref }]
  plan.requests.push({ ref, type: 'ask', node: null, lane: null, text: ev.text, at: P_AT })
  plan.rev++
  return { status: 200, body: { ok: true, rev: plan.rev, summary: 'asked about the PRD', nudge: true } }
}
function paneReply(plan, text, links) {
  const i = plan.requests.findIndex(r => r.type === 'ask' && !r.node)
  plan.thread = [...(plan.thread || []), { role: 'session', text, at: '2026-10-17T06:05:00Z', ref: plan.requests[i].ref, links: links || [] }]
  plan.requests.splice(i, 1)
  plan.rev++
}
const paneThread = () => [
  { role: 'user', text: 'Which comments conflict?', at: '2026-10-17T05:30:00Z', ref: 'e-pa0' },
  { role: 'session', text: 'CM2 and CM3 pull in different directions: CM2 adds a durability requirement while CM3 asks what Q7 decides.\n\nQ7 should be settled first.', at: '2026-10-17T05:32:00Z', ref: 'e-pa0', links: ['CM2', 'CM3', 'Q7'] },
]
const paneBoxes = (page, sels) => page.evaluate(s => s.map(q => { const r = document.querySelector(q).getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) } }), sels)
const paneHas = page => page.evaluate(() => { const p = document.getElementById('prdpane'); return !!p && p.contains(document.activeElement) })
const openPane = async page => { await page.click('#pane-open'); await page.waitForSelector(PN + ' textarea') }
const paneBottom = page => page.$eval(PL, e => e.scrollHeight - e.scrollTop - e.clientHeight < 4)
const paneTypes = () => state.posts.map(p => p.type)

// Breaks if the pane is not a docked column at 2560 (hidden, or laid over the PRD), overlaps the node panel when that opens beside it, shows on tabs other than the PRD,
// makes the page scroll sideways, or opens at the top of a thread instead of at the newest message.
await check('pane: docked at 2560 beside the PRD, clear of the node panel, only on the PRD tab; opens at the newest message; shot', async () => {
  seedComments()
  std().thread = [...paneThread(), ...Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'session' : 'user', text: 'Filler message ' + i + ' ' + 'word '.repeat(20), at: P_AT, ref: 'e-pf' + i }))]
  await open('/plan/' + STD, WIDE, async page => {
    await page.waitForSelector('#titleText:not(:empty)')
    eq(await page.isVisible(PN), false, 'pane on the Lanes tab')
    await cmGoPrd(page)
    await page.waitForSelector(PN + ' .th-msg')
    eq(await page.isVisible('#pane-open'), false, 'the sheet button is not needed when docked')
    const [pn, prd] = await paneBoxes(page, [PN, '.prd-wrap'])
    const w = pn.r - pn.l
    if (w < 440 || w > 560) throw new Error('pane width ' + w)
    if (pn.t > 20 || pn.b < WIDE.height - 20) throw new Error('pane is not full height: ' + JSON.stringify(pn))
    if (prd.r > pn.l) throw new Error('PRD overlaps the pane: ' + JSON.stringify([prd, pn]))
    if (prd.r - prd.l < 600) throw new Error('PRD is squeezed to ' + (prd.r - prd.l))
    eq(await paneBottom(page), true, 'opens at the newest message')
    eq(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, 'page overflow')
    await page.click('#p-prd a.ncl')
    await page.waitForSelector(NP + ':not([hidden])')
    const [pn2, np2, prd2] = await paneBoxes(page, [PN, NP, '.prd-wrap'])
    if (pn2.r > np2.l) throw new Error('pane overlaps the node panel: ' + JSON.stringify([pn2, np2]))
    if (prd2.r > pn2.l) throw new Error('PRD overlaps the pane next to the node panel: ' + JSON.stringify([prd2, pn2]))
    eq(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, 'page overflow with the node panel')
    await page.click('.np-close')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'prd-pane-2560.png') })
    await page.click('#tabs .tab:has-text("Lanes")')
    eq(await page.isVisible(PN), false, 'pane on the Lanes tab again')
  })
})

// Breaks if the pane shows below 1800 without being asked for, the button is missing from the PRD header, opening does not move focus in or write #pane,
// or closing (button or Escape) does not hand focus back to the button and clear the hash.
await check('pane: below 1800 the header button opens a sheet; Close and Esc close it and give focus back; #pane follows', async () => {
  seedComments()
  std().thread = paneThread()
  await open('/plan/' + STD, MID, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('#pane-open')
    eq(await page.textContent('#pane-open'), 'Ask about the PRD', 'button text')
    eq(await page.isVisible(PN), false, 'pane before asking for it')
    await page.click('#pane-open')
    await page.waitForSelector(PN + ':not([hidden])')
    eq(await paneHas(page), true, 'focus moved into the pane')
    eq(await page.evaluate(() => location.hash), '#pane', 'hash when open')
    eq(await page.getAttribute(PN, 'role'), 'dialog', 'sheet role')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'prd-pane-1440.png') })
    await page.click(PN + ' .pane-close')
    eq(await page.isVisible(PN), false, 'closed by Close')
    eq(await page.evaluate(() => document.activeElement.id), 'pane-open', 'focus back on the button after Close')
    eq(await page.evaluate(() => location.hash), '', 'hash after Close')
    await page.click('#pane-open')
    await page.waitForSelector(PN + ':not([hidden])')
    await page.press(PN + ' textarea', 'Escape')
    eq(await page.isVisible(PN), false, 'closed by Esc')
    eq(await page.evaluate(() => document.activeElement.id), 'pane-open', 'focus back on the button after Esc')
  })
  await open('/plan/' + STD, TAB, async page => {
    await cmGoPrd(page)
    await openPane(page)
    const [pn] = await paneBoxes(page, [PN])
    if (pn.r > TAB.width) throw new Error('sheet leaves the screen: ' + JSON.stringify(pn))
  })
})

// Breaks if #pane does not bring the sheet back after a reload (or does not switch to the PRD tab it belongs to), if the node hash and #pane clobber each other,
// or if closing one drops the other from the hash.
await check('pane: #pane survives a reload and combines with the node hash (#node=Q7&pane) without breaking either', async () => {
  seedComments()
  await open('/plan/' + STD + '#pane', MID, async page => {
    await page.waitForSelector(PN + ':not([hidden])')
    eq((await page.textContent('#tabs .tab[aria-selected=true]')).startsWith('PRD'), true, 'PRD tab for #pane')
    await page.reload()
    await page.waitForSelector(PN + ':not([hidden])')
    eq(await page.evaluate(() => location.hash), '#pane', 'hash after reload')
    await page.evaluate(() => selectNode('Q7'))
    eq(await page.evaluate(() => location.hash), '#node=Q7&pane', 'both in the hash')
    await page.reload()
    await page.waitForSelector(PN + ':not([hidden])')
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.textContent(NP + ' .np-id'), 'Q7', 'node restored from the combined hash')
    await page.click('.np-close')
    eq(await page.evaluate(() => location.hash), '#pane', 'hash after the node closes')
    await page.evaluate(() => selectNode('Q7'))
    await page.click(PN + ' .pane-close')
    eq(await page.evaluate(() => location.hash), '#node=Q7', 'hash after the pane closes')
    eq(await page.isVisible(NP), true, 'node panel stays')
  })
  await open('/plan/' + STD + '#node=Q22', MID, async page => {
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.isVisible(PN), false, 'a node hash alone does not open the pane')
  })
})

// Breaks if an ask from the pane carries a node (it would land in a node thread), the pane waits on the wrong requests (a node ask, a note) or not on its own,
// the waiting row lacks the hint, or the draft stays in the box after a send.
await check('pane: asking posts {type ask, text} with no node; the open node-less ask shows Waiting for the session…; node asks and notes do not', async () => {
  state.respond = ev => applyPaneAsk(std(), ev)
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await openPane(page)
    eq(await page.isDisabled(PN + ' .th-send'), true, 'Send disabled when empty')
    eq(await page.getAttribute(PN + ' textarea', 'placeholder'), 'Ask about the whole PRD or the comments…', 'placeholder')
    await page.fill(PN + ' textarea', '   ')
    eq(await page.isDisabled(PN + ' .th-send'), true, 'Send disabled for blanks')
    eq(await page.locator(PN + ' .th-wait').count(), 0, 'nothing pending yet (a node ask and a note are open in the fixture)')
    await page.fill(PN + ' textarea', 'Is the PRD ready to approve?')
    await page.click(PN + ' .th-send')
    await waitPost()
    eq(lastPost(), { type: 'ask', text: 'Is the PRD ready to approve?' }, 'posted event')
    await page.waitForSelector(PN + ' .th-wait')
    const wait = await page.textContent(PN + ' .th-wait')
    if (!wait.includes('Waiting for the session…') || !wait.includes('It answers when it is next at its prompt')) throw new Error('pending row: ' + wait)
    eq(await page.inputValue(PN + ' textarea'), '', 'draft cleared after the send')
    eq(await paneHas(page), true, 'focus still in the pane')
    eq(await page.textContent(PL + ' .th-msg.user b'), 'You', 'role label')
    paneReply(std(), 'Not yet: Q7 is open.', ['Q7'])
    await forcePoll(page)
    await page.waitForSelector(PN + ' .th-msg.session')
    eq(await page.locator(PN + ' .th-wait').count(), 0, 'pending row gone after the reply')
    eq(await page.textContent(PL + ' .th-msg.session b'), 'Session', 'role label')
  })
  // A node-less ask that is already open when the page loads is pending too.
  reset()
  std().requests.push({ ref: 'e-pw', type: 'ask', node: null, lane: null, text: 'q', at: P_AT })
  std().thread = [{ role: 'user', text: 'q', at: P_AT, ref: 'e-pw' }]
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await openPane(page)
    await page.waitForSelector(PN + ' .th-wait')
  })
})

// Breaks if Ctrl/Cmd+Enter does not send, the counter is missing near the limit, the box has no 2000 cap.
await check('pane: Ctrl+Enter sends; the counter shows near 2000; the box is capped at 2000', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await openPane(page)
    eq(await page.getAttribute(PN + ' textarea', 'maxlength'), '2000', 'maxlength')
    await page.fill(PN + ' textarea', 'x'.repeat(100))
    eq(await page.textContent(PN + ' .th-count'), '', 'no counter far from the limit')
    await page.fill(PN + ' textarea', 'x'.repeat(1850))
    eq(await page.textContent(PN + ' .th-count'), '1850 / 2000', 'counter near the limit')
    await page.fill(PN + ' textarea', 'Send with the keyboard')
    await page.press(PN + ' textarea', 'Control+Enter')
    await waitPost()
    eq(lastPost(), { type: 'ask', text: 'Send with the keyboard' }, 'posted event')
  })
})

// Breaks if the starters show next to an existing conversation, send on click instead of filling the box, or name a comment that is not in the plan.
await check('pane: starters show only on an empty thread, fill the composer without sending, and name the first real comment', async () => {
  seedComments()
  std().comments = std().comments.map(c => ({ ...c, id: c.id.replace('CM', 'CX') }))
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await openPane(page)
    eq(await page.locator(PN + ' .pane-start').allTextContents(), ['Which comments conflict?', 'What would change if we accept CX1?', 'What is still unclear in this PRD?'], 'starters')
    await page.click(PN + ' .pane-start >> nth=1')
    eq(await page.inputValue(PN + ' textarea'), 'What would change if we accept CX1?', 'composer filled')
    eq(await paneHas(page), true, 'focus in the composer')
    eq(state.posts, [], 'a starter must not send')
    std().thread = paneThread()
    std().rev++
    await forcePoll(page)
    await page.waitForSelector(PN + ' .th-msg')
    eq(await page.locator(PN + ' .pane-start').count(), 0, 'starters once the thread has messages')
    eq(await page.inputValue(PN + ' textarea'), 'What would change if we accept CX1?', 'draft kept when the starters go')
  })
})

// Breaks if the links of a session answer do not show as chips, a node chip does not open the panel, a comment chip does not take you to the PRD tab, scroll to the
// comment and mark it, or an id the plan no longer has becomes a clickable control.
await check('pane: link chips: a node opens the panel, a comment scrolls to it and marks it (PRD tab included), unknown ids are plain text', async () => {
  seedComments()
  std().thread = [...paneThread().slice(0, 1), { ...paneThread()[1], links: ['Q7', 'CM2', 'ZZ99'] }]
  await open('/plan/' + STD, MID, async page => {
    await cmGoPrd(page)
    await openPane(page)
    eq(await page.locator(PL + ' .pane-chip').evaluateAll(l => l.map(x => [x.tagName, x.textContent])), [['BUTTON', 'Q7'], ['BUTTON', 'CM2'], ['SPAN', 'ZZ99']], 'chips')
    await page.click(PL + ' .pane-chip[data-id=Q7]')
    await page.waitForSelector(NP + ':not([hidden])')
    eq(await page.textContent(NP + ' .np-id'), 'Q7', 'node chip opens the node')
    await page.click('.np-close')
    eq(await page.evaluate(() => document.activeElement.dataset.id), 'Q7', 'focus back on the chip')
    await page.click('#tabs .tab:has-text("Lanes")')
    eq(await page.isVisible('#p-prd'), false, 'left the PRD tab')
    await page.click(PL + ' .pane-chip[data-id=CM2]')
    eq((await page.textContent('#tabs .tab[aria-selected=true]')).startsWith('PRD'), true, 'chip switched to the PRD tab')
    await page.waitForSelector('.cm[data-id=CM2].hl')
    eq(await page.$eval('.cm[data-id=CM2]', e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }), true, 'comment scrolled into view')
    eq(await page.locator('.cm.hl').count(), 1, 'only the chosen comment is marked')
    await page.waitForFunction(() => !document.querySelector('.cm.hl'), null, { timeout: 5000 })
  })
})

// Breaks if thread text reaches the page as markup.
await check('pane: HTML in messages and link ids stays inert text', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  std().thread = [{ role: 'user', text: evil, at: P_AT, ref: 'e-ev0' }, { role: 'session', text: evil, at: P_AT, ref: 'e-ev0', links: [evil] }]
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await cmGoPrd(page)
    await openPane(page)
    eq(await page.locator(PL + ' .th-text').allTextContents(), [evil, evil], 'message text')
    eq(await page.textContent(PL + ' .pane-chip'), evil, 'chip text')
    eq(await page.locator(PN + ' img').count(), 0, 'img elements')
    eq(ctx.dialogs.length, 0, 'dialogs')
  })
})

// Breaks if Turn into proposal posts the wrong thing: another author, a text other than the answer, a CM id (or a removed node) as the anchor, the second node
// instead of the first, an anchor when no node is linked, or a text over the 5000 limit; or if the button does not turn into a disabled Sent that survives a re-render.
await check('pane: Turn into proposal posts the answer as a comment by "Me (pane)" anchored on the first linked node; Sent stays', async () => {
  seedComments()
  const long = 'L'.repeat(5200)
  std().thread = [
    { role: 'user', text: 'a', at: P_AT, ref: 'e-t0' },
    { role: 'session', text: 'Settle Q7 first.\nThen FR-1.', at: P_AT, ref: 'e-t0', links: ['CM2', 'ZZ99', 'Q7', 'Q22'] },
    { role: 'user', text: 'b', at: P_AT, ref: 'e-t1' },
    { role: 'session', text: 'Only comments matter here.', at: P_AT, ref: 'e-t1', links: ['CM2', 'CM3'] },
    { role: 'user', text: 'c', at: P_AT, ref: 'e-t2' },
    { role: 'session', text: long, at: P_AT, ref: 'e-t2' },
  ]
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await openPane(page)
    eq(await page.locator(PN + ' .pane-turn').allTextContents(), ['Turn into proposal', 'Turn into proposal', 'Turn into proposal'], 'a button on each session answer, none on yours')
    await page.click(PN + ' .pane-turn[data-ref=e-t0]')
    await waitPost(1)
    eq(lastPost(), { type: 'comment', text: 'Settle Q7 first.\nThen FR-1.', author: 'Me (pane)', anchor: 'Q7' }, 'first linked node, not CM2 or the unknown id')
    await page.waitForFunction(() => document.getElementById('toast').textContent === 'Sent as a comment; the session will propose a change')
    eq(await page.textContent(PN + ' .pane-turn[data-ref=e-t0]'), 'Sent', 'button after sending')
    eq(await page.isDisabled(PN + ' .pane-turn[data-ref=e-t0]'), true, 'Sent is disabled')
    await page.click(PN + ' .pane-turn[data-ref=e-t1]')
    await waitPost(2)
    eq(lastPost(), { type: 'comment', text: 'Only comments matter here.', author: 'Me (pane)' }, 'only comment links: no anchor')
    await page.click(PN + ' .pane-turn[data-ref=e-t2]')
    await waitPost(3)
    eq([lastPost().text.length, lastPost().text.slice(-12), 'anchor' in lastPost()], [5000, ' [truncated]', false], 'long answer truncated with the marker, no links no anchor')
    std().rev++
    await forcePoll(page)
    await page.waitForTimeout(200)
    eq(await page.locator(PN + ' .pane-turn:disabled').count(), 3, 'Sent survives a re-render')
  })
})

// Breaks if a re-render from the poll wipes a half-typed question, moves the caret, steals focus, throws a reader of older messages to the bottom,
// or fails to follow when the reader is already at the bottom.
await check('pane: draft, focus, caret survive a poll; the list follows new messages only when at the bottom', async () => {
  std().thread = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'session' : 'user', text: (i % 2 ? 'Answer ' : 'Question ') + i + ' ' + 'word '.repeat(18), at: P_AT, ref: 'e-d' + i }))
  state.respond = ev => applyPaneAsk(std(), ev)
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await openPane(page)
    await page.fill(PN + ' textarea', 'half a question')
    await page.evaluate(() => { const t = document.querySelector('#prdpane textarea'); t.focus(); t.setSelectionRange(2, 6) })
    eq(await paneBottom(page), true, 'at the newest message when opened')
    std().thread.push({ role: 'session', text: 'NEWEST while at the bottom', at: P_AT, ref: 'e-dn' })
    std().rev++
    await forcePoll(page)
    await page.waitForFunction(() => document.querySelector('#prdpane .th-list').textContent.includes('NEWEST while'))
    eq(await page.inputValue(PN + ' textarea'), 'half a question', 'draft kept')
    eq(await page.evaluate(() => [document.activeElement.dataset.draft, document.activeElement.selectionStart, document.activeElement.selectionEnd]), ['pane-ask', 2, 6], 'focus and caret kept')
    eq(await paneBottom(page), true, 'followed the new message')
    await page.$eval(PL, e => { e.scrollTop = 0 })
    std().thread.push({ role: 'session', text: 'NEWER while reading up', at: P_AT, ref: 'e-dm' })
    std().rev++
    await forcePoll(page)
    await page.waitForFunction(() => document.querySelector('#prdpane .th-list').textContent.includes('NEWER while'))
    eq(await page.$eval(PL, e => e.scrollTop), 0, 'a reader of older messages stays put')
  })
})

// Breaks if a reply that arrives while the sheet is closed leaves no sign on the button, the sign stays after opening, shows for replies that were already there
// when the page loaded, or shows for a reply that arrives while the sheet is open.
await check('pane: an unread dot on the button for a reply that arrives while the sheet is closed', async () => {
  state.respond = ev => applyPaneAsk(std(), ev)
  std().thread = paneThread()
  await open('/plan/' + STD, MID, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('#pane-open')
    eq(await page.locator('#pane-open .pane-dot').count(), 0, 'no dot for replies already there at load')
    std().requests.push({ ref: 'e-ur', type: 'ask', node: null, lane: null, text: 'q', at: P_AT })
    paneReply(std(), 'A reply while closed', [])
    await forcePoll(page)
    await page.waitForSelector('#pane-open .pane-dot')
    eq((await page.getAttribute('#pane-open', 'aria-label')).includes('new reply'), true, 'dot is announced')
    await openPane(page)
    await page.click(PN + ' .pane-close')
    eq(await page.locator('#pane-open .pane-dot').count(), 0, 'dot cleared by opening')
    await openPane(page)
    std().requests.push({ ref: 'e-ur2', type: 'ask', node: null, lane: null, text: 'q', at: P_AT })
    paneReply(std(), 'A reply while open', [])
    await forcePoll(page)
    await page.waitForFunction(() => document.querySelector('#prdpane .th-list').textContent.includes('while open'))
    await page.click(PN + ' .pane-close')
    eq(await page.locator('#pane-open .pane-dot').count(), 0, 'no dot for a reply seen while open')
  })
})

// Breaks if a pane control posts anything but the two events a user may send here (ask, comment): a session-only event, or a node-ful ask.
await check('pane: no control posts a session-only event; every post is an ask without a node or a comment', async () => {
  for (const t of ['comment_split', 'comment_triage', "type: 'reply'", 'comment_import', 'review_set', 'comment_posted']) if (PAGE.includes(t)) throw new Error('plan.html mentions ' + t)
  seedComments()
  std().thread = [{ role: 'user', text: 'a', at: P_AT, ref: 'e-s0' }, { role: 'session', text: 'Answer', at: P_AT, ref: 'e-s0', links: ['Q7', 'CM2'] }]
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await openPane(page)
    await page.click(PL + ' .pane-chip[data-id=CM2]')
    await page.click(PL + ' .pane-chip[data-id=Q7]')
    await page.click('.np-close')
    await page.fill(PN + ' textarea', 'one more')
    await page.click(PN + ' .th-send')
    await waitPost(1)
    await page.click(PN + ' .pane-turn')
    await waitPost(2)
    await page.click(PN + ' .pane-close').catch(() => {})
    eq(paneTypes(), ['ask', 'comment'], 'posted types')
    eq('node' in state.posts[0], false, 'the ask carries no node')
  })
})

// Breaks if the pane makes the page scroll sideways (a long unbroken word, long chips, a 40-message thread), with the node panel next to or over it, at the four sizes; shots.
await check('pane: no horizontal scroll at 2560, 1440, 1024 and 390 with chips, an unbroken word and the node panel; shots', async () => {
  seedComments()
  const word = 'W'.repeat(240)
  std().thread = [
    ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'session' : 'user', text: (i % 2 ? 'Answer ' : 'Question ') + i + ' ' + 'word '.repeat(14), at: P_AT, ref: 'e-w' + i, ...(i % 2 ? { links: ['Q7', 'CM1'] } : {}) })),
    { role: 'user', text: word, at: P_AT, ref: 'e-wx' },
    { role: 'session', text: word, at: P_AT, ref: 'e-wx', links: [word, 'Q7', 'Q22', 'CM2', 'CM3', 'FR-001', 'ZZ99'] },
  ]
  std().requests.push({ ref: 'e-wp', type: 'ask', node: null, lane: null, text: 'q', at: P_AT })
  std().thread.push({ role: 'user', text: 'What would change if we accept CM1?', at: P_AT, ref: 'e-wp' })
  for (const vp of [WIDE, MID, TAB, PHONE]) {
    await open('/plan/' + STD, vp, async page => {
      const phone = vp.width <= 640
      await cmGoPrd(page, phone)
      if (vp.width < 1800) await openPane(page)
      await page.waitForSelector(PN + ' .th-msg')
      const over = async what => {
        const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        if (o > 0) throw new Error(`${vp.width}px ${what}: ${o}px too wide`)
        const inner = await page.$eval(PL, e => e.scrollWidth - e.clientWidth)
        if (inner > 0) throw new Error(`${vp.width}px ${what}: thread ${inner}px too wide`)
      }
      await over('pane')
      if (phone) {
        const [pn] = await paneBoxes(page, [PN])
        eq([pn.l, pn.t, pn.r, pn.b], [0, 0, PHONE.width, PHONE.height], 'full-screen sheet on the phone')
        eq(await page.evaluate(() => document.querySelector('.app').inert), true, 'page behind the sheet is inert')
      }
      if (SHOTS) await page.screenshot({ path: join(SHOTS, vp.width === 2560 ? 'prd-pane-2560-thread.png' : phone ? 'prd-pane-phone.png' : `prd-pane-${vp.width}-thread.png`) })
      await page.click(PL + ' .pane-chip[data-id=Q7] >> nth=0')
      await page.waitForSelector(NP + ':not([hidden])')
      await over('with the node panel')
      if (SHOTS && vp.width === 2560) await page.screenshot({ path: join(SHOTS, 'prd-pane-2560-panel.png') })
      await page.click('.np-close')
      eq(await page.evaluate(() => document.activeElement.dataset.id), 'Q7', vp.width + 'px focus back on the chip')
    })
  }
})

// ---------- GitHub review PR on the PRD view (contract §14): the strip, reply posting, GitHub comment tags, auto-pull ----------
const RV_PR = { repo: 'acme/notes', number: 12, url: 'https://github.com/acme/notes/pull/12', branch: 'prd/offline-sync', head_sha: 'a'.repeat(40), prd_rev: 90, opened_at: '2026-10-17T06:00:00Z', pulled_at: null }
const mkGh = (id, o) => mkCm(id, { source: 'github', ext: 'rc:' + id.slice(2), url: 'https://github.com/acme/notes/pull/12#discussion_r' + id.slice(2), reply_to: null, resolved: false, edited: false, posted: null, ...o })
const rvTypes = () => state.posts.map(p => p.type)
const rvReq = (text, ref = 'e-rv') => ({ ref, type: 'review', node: null, lane: null, text, at: CM_AT })
const RV_POSTED = { at: '2026-10-17T07:00:00Z', url: 'https://github.com/acme/notes/pull/12#discussion_r99', ext: 'rc:99' }
// One comment of every reply situation: GH1 proposed answer, GH2 accepted, GH3 proposed decline, GH4 already replied, GH5 an accept proposal (nothing to reply yet), CM9 pasted (not GitHub).
function seedGh(o) {
  std().review_pr = { ...RV_PR, pulled_at: new Date(Date.now() - 5 * 60000).toISOString(), ...o }
  std().comments = [
    mkGh('GH1', { author: 'octo', text: 'What is the conflict policy?', anchor: 'Q7', state: 'proposed', proposal: mkProp('answer', { text: REPLY }) }),
    mkGh('GH2', { author: 'hubot', text: 'Add a durability line', anchor: '§7', state: 'accepted', proposal: mkProp('accept', { text: 'Added.', changes: [{ type: 'reopen', node: 'Q8' }] }) }),
    mkGh('GH3', { author: 'mona', text: 'Drop the RFC link', anchor: '§12', state: 'proposed', proposal: mkProp('decline', { text: 'The RFC is the wire format source.' }) }),
    mkGh('GH4', { author: 'linus', text: 'Typo in section 1', state: 'answered', proposal: mkProp('answer', { text: 'Fixed.' }), posted: RV_POSTED }),
    mkGh('GH5', { author: 'ada', text: 'Please add a rollout', state: 'proposed', proposal: mkProp('accept', { text: 'Adds one.', changes: [{ type: 'reopen', node: 'Q8' }] }) }),
    mkCm('CM9', { author: 'Sam', text: 'Pasted from chat', state: 'proposed', proposal: mkProp('answer', { text: 'A reply.' }) }),
  ]
  std().rev++
}
const rvBox = (page, id) => page.locator(`.cm[data-id=${id}] > .cm-reply input[data-act=reply]`)

// Breaks if "Open review PR" publishes on the first click (the click must only ask), the explanation is missing, Cancel posts, the event carries more than {type, action},
// or a plan with no repo still offers a button the core would refuse.
await check('review PR: Open asks first, then posts review {action: open}; no repo, no strip', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('#rv-open')
    eq(await page.textContent('#rv'), 'Review PROpen review PRPublishes the PRD to branch prd/offline-sync and opens a DRAFT pull request. Needs your click.', 'strip text')
    await page.click('#rv-open')
    eq(await page.textContent('#rv-confirm'), 'Open a draft pull request now?Yes, open itCancel', 'inline confirm')
    eq(await page.evaluate(() => document.activeElement.id), 'rv-no', 'focus lands on the safe button')
    eq(state.posts.length, 0, 'the first click posts nothing')
    await page.click('#rv-no')
    eq(await page.locator('#rv-confirm').count(), 0, 'Cancel closes the confirm')
    eq(state.posts.length, 0, 'Cancel posts nothing')
    await page.click('#rv-open')
    await page.click('#rv-yes')
    await waitPost()
    eq(lastPost(), { type: 'review', action: 'open' }, 'event')
    eq(state.posts.length, 1, 'one event')
  })
  std().repo = null
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('#cm-box')
    eq(await page.locator('#rv').count(), 0, 'no strip without a repo')
  })
})

// Breaks if the strip lacks the PR link, branch or published rev, nags about a changed PRD when rev matches (or stays silent when the plan moved on), or Push / Pull post the wrong event.
await check('review PR: with a PR the strip shows link, branch, published rev, the changed-PRD hint, last pulled; Push and Pull post exact events', async () => {
  seedGh()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('#rv-pr')
    eq([await page.textContent('#rv-pr'), await page.getAttribute('#rv-pr', 'href'), await page.getAttribute('#rv-pr', 'target'), await page.getAttribute('#rv-pr', 'rel')],
      ['PR #12', 'https://github.com/acme/notes/pull/12', '_blank', 'noopener noreferrer'], 'PR link')
    eq(await page.textContent('#rv .rv-branch'), 'prd/offline-sync', 'branch')
    eq(await page.textContent('#rv .rv-rev'), 'published rev 90', 'published rev')
    eq(await page.textContent('#rv .rv-drift'), 'PRD changed since publish (rev 96)', 'hint when the plan moved on')
    eq(await page.textContent('#rv .rv-pulled'), 'last pulled 5 min ago', 'last pulled')
    eq(await page.locator('#rv-open').count(), 0, 'no Open button with a PR')
    await page.click('#rv-push')
    await waitPost(1)
    eq(lastPost(), { type: 'review', action: 'push' }, 'push event')
    await page.click('#rv-pull')
    await waitPost(2)
    eq(lastPost(), { type: 'review', action: 'pull' }, 'pull event')
    eq(rvTypes(), ['review', 'review'], 'nothing else posted')
  })
  seedGh({ prd_rev: 97, pulled_at: null })
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('#rv-pr')
    eq(await page.locator('#rv .rv-drift').count(), 0, 'no hint when the published rev is current')
    eq(await page.textContent('#rv .rv-pulled'), 'not pulled yet', 'never pulled')
  })
})

// Breaks if an open review request leaves its button live (duplicate clicks), disables the wrong button, omits the waiting line, or keeps it after the session resolved the request.
await check('review PR: an open request disables its own button, shows "Waiting for the session…: <action>", and clears when resolved', async () => {
  seedGh()
  std().requests.push(rvReq('pull'))
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('#rv-pull')
    eq(await page.isDisabled('#rv-pull'), true, 'Pull disabled')
    eq(await page.isDisabled('#rv-push'), false, 'Push untouched')
    eq(await page.textContent('#rv-pending'), 'Waiting for the session…: pull', 'pending line')
    std().requests = []
    std().rev++
    await forcePoll(page)
    await page.waitForFunction(() => !document.getElementById('rv-pending') && !document.getElementById('rv-pull').disabled)
    eq(state.posts.length, 0, 'nothing posted')
  })
})

// Breaks if a box starts checked, a reply is posted without the explicit click, the count includes unchecked or non-GitHub comments, refs go out unordered or whole,
// a comment with nothing to reply (accept proposal, pasted) offers a box, or a posted comment loses its "Replied on GitHub" link.
await check('review PR: reply boxes start unchecked; the bar counts only checked boxes and posts exactly those refs', async () => {
  seedGh()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm[data-id=GH1]')
    eq(await page.locator('input[data-act=reply]').evaluateAll(l => l.map(x => [x.closest('.cm').dataset.id, x.checked]).sort((p, q) => p[0] < q[0] ? -1 : 1)), [['GH1', false], ['GH2', false], ['GH3', false]], 'boxes: only postable GitHub comments, all unchecked')
    eq(await page.locator('#rv-bar').count(), 0, 'no bar with nothing checked')
    eq(await page.textContent('.cm[data-id=GH2] .cm-reply'), 'Reply on GitHubReply names the pushed commit: push the new version first', 'accepted hint')
    eq(await page.textContent('.cm[data-id=GH4] .cm-reply'), 'Replied on GitHub', 'posted state')
    eq(await page.getAttribute('.cm[data-id=GH4] .cm-reply a', 'href'), RV_POSTED.url, 'posted link')
    await rvBox(page, 'GH3').check()
    await rvBox(page, 'GH1').check()
    eq(await page.textContent('#rv-post'), 'Post 2 replies', 'count of checked')
    eq(await page.evaluate(() => document.activeElement.dataset.act + ':' + document.activeElement.closest('.cm').dataset.id), 'reply:GH1', 'focus stays on the box through the re-render')
    await rvBox(page, 'GH3').uncheck()
    eq(await page.textContent('#rv-post'), 'Post 1 reply', 'count after uncheck')
    await rvBox(page, 'GH2').check()
    eq(state.posts.length, 0, 'ticking posts nothing')
    await page.click('#rv-post')
    await waitPost()
    eq(lastPost(), { type: 'review', action: 'post', refs: ['GH1', 'GH2'], proposals: { GH1: 95, GH2: 95 } }, 'event names exactly the checked refs')
    await page.waitForFunction(() => !document.getElementById('rv-bar'))
    eq(await rvBox(page, 'GH1').count(), 1, 'boxes remain until the session replies')
    eq(await rvBox(page, 'GH1').isChecked(), false, 'and are unchecked again')
  })
})

// Breaks if a Post names only comment ids (the reply the session swapped in after the page last polled would be posted, not the one the owner read), sends another
// revision than the card shows, or a refused Post (the core says the proposal changed) leaves the user with the raw core string.
await check('review PR: Post sends the proposal rev the card shows; a stale one is refused with a plain message', async () => {
  seedGh()
  const gh1 = () => std().comments.find(c => c.id === 'GH1')
  gh1().proposal.rev = 131
  // The core's rule: a Post is refused when the proposal's current rev is not the one the click carries.
  state.respond = ev => (ev.type === 'review' && ev.action === 'post' && ev.proposals?.GH1 !== gh1().proposal.rev
    ? { status: 400, body: { error: 'The proposal changed; reload the page' } } : null)
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm[data-id=GH1]')
    await rvBox(page, 'GH1').check()
    await page.click('#rv-post')
    await waitPost()
    eq(lastPost(), { type: 'review', action: 'post', refs: ['GH1'], proposals: { GH1: 131 } }, 'the displayed rev, not another comment\'s')
    await page.waitForFunction(() => !document.getElementById('rv-bar'))
    gh1().proposal.rev = 140 // the session replaced the reply; the plan rev is not bumped here, so the page still shows the old one
    await rvBox(page, 'GH1').check()
    await page.click('#rv-post')
    await page.waitForSelector('#notice:not([hidden])')
    eq(await page.textContent('#notice .msg'), 'That proposal changed; the list was refreshed', 'plain message')
    eq(lastPost().proposals, { GH1: 131 }, 'the stale click still carried what the page showed')
  }, true)
})

// Breaks if more than 20 refs can be sent (the core refuses the whole post) or the 21st box stays live.
await check('review PR: at most 20 replies per post; the rest of the boxes lock', async () => {
  seedGh()
  std().comments = Array.from({ length: 22 }, (_, i) => mkGh('GH' + (i + 1), { state: 'proposed', proposal: mkProp('answer', { text: 'r' + i }) }))
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm[data-id=GH22]')
    for (let i = 1; i <= 20; i++) await rvBox(page, 'GH' + i).check()
    eq(await page.textContent('#rv-post'), 'Post 20 replies', 'capped count')
    eq(await rvBox(page, 'GH21').isDisabled(), true, '21st locked')
    eq(await rvBox(page, 'GH20').isDisabled(), false, 'a checked box can still be cleared')
    await page.click('#rv-post')
    await waitPost()
    eq(lastPost().refs.length, 20, 'twenty refs')
  })
})

// Breaks if a ref in an open post request has no way to be posted again (the core replaces the old request, so a refused post could never be retried), if Post again
// names more than its own ref, or if a queued ref joins the sticky bar without a tick.
await check('review PR: a reply already queued shows as queued, offers Post again for exactly that ref, and joins the bar only when ticked', async () => {
  seedGh()
  std().requests.push(rvReq('post GH1,GH2'))
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm[data-id=GH1]')
    eq(await page.textContent('.cm[data-id=GH1] .cm-reply span'), 'Reply queued: waiting for the session…', 'queued text')
    eq(await page.locator('.cm[data-id=GH1] .cm-reply [data-act=repost]').textContent(), 'Post again', 'Post again on GH1')
    eq(await page.locator('.cm[data-id=GH3] [data-act=repost]').count(), 0, 'not on a ref that is not queued')
    eq(await rvBox(page, 'GH3').count(), 1, 'others still open')
    eq(await page.textContent('#rv-pending'), 'Waiting for the session…: post GH1,GH2', 'strip names the post')
    eq(await page.locator('#rv-bar').count(), 0, 'no bar until something is ticked')
    state.posts.length = 0
    await page.click('.cm[data-id=GH1] [data-act=repost]')
    await waitPost()
    eq(state.posts.length, 1, 'one post')
    eq(lastPost(), { type: 'review', action: 'post', refs: ['GH1'], proposals: { GH1: 95 } }, 'names exactly that ref')
    await rvBox(page, 'GH1').check()
    await rvBox(page, 'GH3').check()
    eq(await page.textContent('#rv-post'), 'Post 2 replies', 'ticked queued ref counts')
    eq(await page.getAttribute('#rv-post', 'aria-disabled'), null, 'the bar is live')
    await page.click('#rv-post')
    await waitPost(2)
    eq(lastPost(), { type: 'review', action: 'post', refs: ['GH1', 'GH3'], proposals: { GH1: 95, GH3: 95 } }, 'bar names the ticked refs')
  })
})

// Breaks if a javascript:/http: URL from plan data becomes an href (review_pr.url, a comment url, posted.url), or markup in GitHub fields becomes elements.
await check('review PR: only https URLs become links; markup in branch, author, text and tags stays inert', async () => {
  const bad = '<img src=x onerror=alert(1)>'
  seedGh({ url: 'javascript:alert(1)', branch: bad })
  std().comments = [
    mkGh('GH1', { author: bad, text: bad, url: 'http://insecure.example/c', state: 'proposed', proposal: mkProp('answer', { text: bad }) }),
    mkGh('GH2', { text: 'x', url: 'javascript:alert(2)', state: 'answered', proposal: mkProp('answer', { text: 'y' }), posted: { ...RV_POSTED, url: 'javascript:alert(3)' } }),
  ]
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await cmGoPrd(page)
    await page.waitForSelector('#rv .rv-branch')
    eq(await page.locator('#rv a, #p-prd .cm a').count(), 0, 'no anchors at all')
    eq(await page.textContent('#rv .rv-pr'), 'PR #12', 'PR number still shown')
    eq(await page.textContent('#rv .rv-branch'), bad, 'branch is text')
    eq(await page.locator('#p-prd img, #p-prd script').count(), 0, 'no element from data')
    eq(await page.textContent('.cm[data-id=GH2] .cm-reply'), 'Replied on GitHub', 'unsafe posted url is plain text')
    eq(ctx.dialogs, [], 'no alert fired')
  })
})

// Breaks if GitHub comments look like pasted ones (no source tag), lose the edited / resolved tags, link to a non-https URL, a reply is not nested under its parent,
// a reply whose parent is missing vanishes, or the nested reply is hidden when the parent is a collapsed quiet card.
await check('review PR: GitHub comments carry source, edited and resolved tags; replies nest under their parent; orphans stay in the list', async () => {
  seedGh()
  std().comments = [
    mkGh('GH1', { author: 'octo', text: 'Root question', anchor: '§7', state: 'accepted', proposal: mkProp('accept', { text: 'Done.' }), edited: true, resolved: true }),
    mkGh('GH2', { author: 'mona', text: 'Follow-up', anchor: '§12', reply_to: 'rc:1' }),
    mkGh('GH3', { author: 'ada', text: 'Orphan reply', anchor: '§7', reply_to: 'rc:404' }),
    mkCm('CM9', { author: 'Sam', text: 'Pasted', anchor: '§7' }),
  ]
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm[data-id=GH1]')
    eq(await page.locator('#prd-7 > .cm-sec > .cm').evaluateAll(l => l.map(x => x.dataset.id)), ['GH1', 'GH3', 'CM9'], 'top-level cards under §7 (the follow-up is not one of them)')
    eq(await page.locator('.cm[data-id=GH1] .cm-thread > .cm').evaluateAll(l => l.map(x => x.dataset.id)), ['GH2'], 'follow-up nested under its parent although the parent is collapsed')
    eq(await page.locator('#prd-12 > .cm-sec > .cm').count(), 0, 'and not repeated under its own section')
    const tags = id => page.locator(`.cm[data-id=${id}] > .cm-head .cm-tag`).evaluateAll(l => l.map(x => x.textContent))
    eq(await tags('GH1'), ['GitHub', 'edited', 'resolved on GitHub'], 'tags on the root')
    eq(await tags('GH2'), ['GitHub'], 'tag on the follow-up')
    eq(await tags('CM9'), [], 'a pasted comment has none')
    eq(await page.getAttribute('.cm[data-id=GH1] > .cm-head a.cm-tag', 'href'), 'https://github.com/acme/notes/pull/12#discussion_r1', 'source tag links to the comment')
    eq(await page.getAttribute('.cm[data-id=GH1] > .cm-head a.cm-tag', 'rel'), 'noopener noreferrer', 'rel')
  })
})

// Breaks if auto-pull is on by default (it talks to GitHub through the session), is forgotten on reload, ignores the 2-minute floor, fires while the tab is hidden or a pull is
// already pending, or runs with no review PR.
await check('review PR: auto-pull is off by default, remembered, posts a pull at most every 2 min, and never while hidden or pending', async () => {
  seedGh()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('#rv-auto')
    eq(await page.isChecked('#rv-auto'), false, 'off by default')
    eq(await page.locator('#rv-next').count(), 0, 'no countdown while off')
    await page.clock.runFor(300000)
    eq(state.posts.length, 0, 'off posts nothing')
    await page.check('#rv-auto')
    eq(await page.textContent('#rv-next'), 'next check in ~2m', 'countdown after enabling')
    await page.reload()
    await cmGoPrd(page)
    await page.waitForSelector('#rv-auto')
    eq(await page.isChecked('#rv-auto'), true, 'remembered across a reload')
    await page.uncheck('#rv-auto')
    await page.reload()
    await cmGoPrd(page)
    await page.waitForSelector('#rv-auto')
    eq(await page.isChecked('#rv-auto'), false, 'and so is off')
  }, false, page => page.clock.install())
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('#rv-auto')
    await page.check('#rv-auto')
    await page.clock.runFor(100000)
    eq(state.posts.length, 0, 'not before 2 min')
    await page.clock.runFor(30000)
    await waitPost(1)
    eq(lastPost(), { type: 'review', action: 'pull' }, 'the pull')
    await page.clock.runFor(100000)
    eq(state.posts.length, 1, 'not again within 2 min')
    std().requests.push(rvReq('pull', 'e-auto'))
    std().rev++
    await forcePoll(page)
    await page.waitForSelector('#rv-pending')
    await page.clock.runFor(150000)
    eq(state.posts.length, 1, 'not while a pull is pending')
    std().requests = []
    std().rev++
    await forcePoll(page)
    await page.waitForFunction(() => !document.getElementById('rv-pending'))
    await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }))
    await page.clock.runFor(300000)
    eq(state.posts.length, 1, 'not while the tab is hidden')
    await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }))
    await page.clock.runFor(30000)
    await waitPost(2)
    eq(state.posts.map(p => p.action), ['pull', 'pull'], 'resumes once visible')
  }, false, page => page.clock.install())
  seedGh()
  delete std().review_pr
  state.posts = []
  await open('/plan/' + STD, DESK, async page => {
    await page.evaluate(() => localStorage.setItem('hq.plan.autopull', '1'))
    await page.reload()
    await cmGoPrd(page)
    await page.waitForSelector('#rv-open')
    await page.clock.runFor(400000)
    eq(state.posts.length, 0, 'no review PR, no auto pull')
  }, false, page => page.clock.install())
})

// Breaks if a throwing localStorage stops the strip or the toggle from working.
await check('review PR: a throwing localStorage leaves the strip and the toggle working', async () => {
  seedGh()
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('#rv-auto')
    await page.check('#rv-auto')
    eq(await page.isChecked('#rv-auto'), true, 'toggle works for this visit')
    await page.click('#rv-pull')
    await waitPost()
    eq(lastPost(), { type: 'review', action: 'pull' }, 'pull event')
  }, false, page => page.addInitScript(() => { Storage.prototype.getItem = () => { throw new Error('denied') }; Storage.prototype.setItem = () => { throw new Error('denied') } }))
})

// Breaks if the strip, the boxes or the bar make the page scroll sideways, or the bar hides behind the phone's bottom nav; shots of the PRD view with strip, GitHub comments and bar.
await check('review PR: no horizontal scroll at 2560, 1440 and 390 with strip, GitHub comments and bar; the bar sits above the bottom nav; shots', async () => {
  seedGh()
  std().comments.push(
    mkGh('GH6', { author: 'a-very-long-github-login-name-for-wrapping', text: 'W'.repeat(240), reply_to: 'rc:1', edited: true, resolved: true, anchor: 'Q7' }),
    mkGh('GH7', { author: 'dev', text: 'Looks right, thanks', reply_to: 'rc:1', anchor: '§7', state: 'proposed', proposal: mkProp('answer', { text: 'Thanks.' }) }))
  std().requests.push(rvReq('pull'))
  for (const vp of [WIDE, MID, PHONE]) {
    await open('/plan/' + STD, vp, async page => {
      const phone = vp.width <= 640
      await cmGoPrd(page, phone)
      await page.waitForSelector('#rv-pr')
      await rvBox(page, 'GH1').check()
      await rvBox(page, 'GH2').check()
      await page.waitForSelector('#rv-bar')
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (o > 0) throw new Error(`${vp.width}px: ${o}px too wide`)
      const box = await page.$eval('#rv-bar', e => { const r = e.getBoundingClientRect(); return [r.bottom, r.right, window.innerHeight, window.innerWidth] })
      if (box[0] > box[2] || box[1] > box[3]) throw new Error(`${vp.width}px: the bar is off screen ${box}`)
      if (phone) {
        const nav = await page.$eval('#bnav', e => e.getBoundingClientRect().top)
        if (box[0] > nav + 0.5) throw new Error('the bar is behind the bottom nav: ' + box[0] + ' > ' + nav)
      }
      for (const id of ['rv-pull', 'rv-push', 'rv-post']) {
        const h = await page.$eval('#' + id, e => e.getBoundingClientRect().height)
        if (phone && h < 40) throw new Error(`${id} is ${h}px tall on the phone`)
      }
      await page.evaluate(() => window.scrollTo(0, 0))
      if (SHOTS) await page.screenshot({ path: join(SHOTS, vp.width === 2560 ? 'review-pr-2560.png' : phone ? 'review-pr-phone.png' : `review-pr-${vp.width}.png`) })
    })
  }
})

// ---------- card FX3: comment closing, request list, draft nodes, bar and toast, draft keeping, long replies, plain errors, PRD layout ----------
const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
const tabText = page => page.textContent('#tabs .tab:has-text("PRD")')

// Breaks if an answer or a decline proposal still has no way to be closed on the page (only Delete), the buttons post anything but comment_accept with proposal.rev,
// or the card and the "PRD · N open" count keep the closed comment as open work.
await check('comments: answer and decline cards offer Mark answered / Agree, decline; the click posts comment_accept and the card and the open count move on', async () => {
  seedComments()
  state.respond = ev => {
    if (ev.type !== 'comment_accept') return null
    const c = std().comments.find(x => x.id === ev.ref)
    c.state = c.proposal.action === 'decline' ? 'declined' : 'answered'
    std().rev++
    return null
  }
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm')
    eq(await page.textContent('.cm[data-id=CM3] [data-act=settle]'), 'Mark answered', 'answer card')
    eq(await page.textContent('.cm[data-id=CM4] [data-act=settle]'), 'Agree, decline', 'decline card')
    eq(await page.getAttribute('.cm[data-id=CM3] [data-act=settle]', 'aria-label'), 'Mark CM3 answered', 'accessible name')
    eq(await page.locator('.cm[data-id=CM2] [data-act=settle], .cm[data-id=CM1] [data-act=settle], .cm[data-id=CM5] [data-act=settle]').count(), 0, 'not on an accept proposal, an open or a closed comment')
    eq(await tabText(page), 'PRD · 4 open', 'count before')
    await page.click('.cm[data-id=CM3] [data-act=settle]')
    await waitPost()
    eq(lastPost(), { type: 'comment_accept', ref: 'CM3', proposal: 95 }, 'event')
    await page.waitForFunction(() => document.querySelector('.cm[data-id=CM3] .cm-badge .w').textContent === 'answered')
    eq(await tabText(page), 'PRD · 3 open', 'count after the answer')
    await page.click('.cm[data-id=CM4] [data-act=settle]')
    await page.waitForFunction(() => document.querySelector('.cm[data-id=CM4] .cm-badge .w').textContent === 'declined')
    eq(await tabText(page), 'PRD · 2 open', 'count after the decline')
  })
})

// Breaks if a long list of waiting requests prints in full (the Now card ran to ~1900px) instead of one line each, five entries and "+N more".
await check('requests: each entry is one line (full text in the title), at most 5 are listed, the rest is "+N more"', async () => {
  const long = i => 'Request ' + i + ' ' + 'long words '.repeat(40)
  std().requests = Array.from({ length: 8 }, (_, i) => ({ ref: 'e-rq' + i, type: 'comment', node: null, lane: null, text: long(i), at: CM_AT }))
  await open('/plan/' + STD, PHONE, async page => {
    await page.waitForSelector('#now .reqs')
    eq(await page.locator('#now .reqs .req-i').count(), 5, 'entries listed')
    eq(await page.textContent('#now .reqs .req-more'), '+3 more', 'the rest')
    eq(await page.textContent('#now .reqs .eyebrow'), 'Waiting for the session · 8', 'heading keeps the full count')
    const tx = await page.locator('#now .reqs .req-i .tx').evaluateAll(l => l.map(e => ({ n: Array.from(e.textContent).length, end: e.textContent.slice(-1), title: e.title, h: Math.round(e.getBoundingClientRect().height) })))
    for (const [i, t] of tx.entries()) {
      if (t.n > 100 || t.end !== '…') throw new Error('entry ' + i + ' is not cut to ~100 chars: ' + JSON.stringify(t))
      eq(t.title, long(i), 'full text in the title of ' + i)
      if (t.h > 24) throw new Error('entry ' + i + ' wraps to ' + t.h + 'px')
    }
    const h = await page.$eval('#now .reqs', e => e.getBoundingClientRect().height)
    if (h > 400) throw new Error('the list is ' + h + 'px tall')
  })
  std().requests = [{ ref: 'e-rq0', type: 'ask', node: 'Q7', lane: null, text: 'Short one', at: CM_AT }]
  await open('/plan/' + STD, PHONE, async page => {
    await page.waitForSelector('#now .reqs')
    eq(await page.textContent('#now .reqs .tx'), 'Short one', 'a short text is not cut')
    eq(await page.locator('#now .reqs .req-more').count(), 0, 'no "more" for a short list')
  })
})

// Breaks if the preview of a node-creating change does not say it lands as a draft (QA4 F2), says so for a change that edits an existing node, or the accepted card
// does not name the node that was added (read from the node stamped with the accept's rev) and falls over when that node cannot be found.
await check('comments: a change that creates a node says it is added as a draft; the accepted card lists "added FR-007 as a draft"', async () => {
  const fr = { ...JSON.parse(JSON.stringify(std().nodes.find(n => n.id === 'FR-001'))), id: 'FR-007', label: 'Queue survives restart', rev: 96, status: 'open' }
  seedComments([
    mkCm('CM8', { text: 'Add the durability line', state: 'accepted', proposal: mkProp('accept', { text: 'Adds it.', changes: [{ type: 'upsert', node: { kind: 'requirement', label: 'Queue survives restart', body: 'The op queue persists' } }, { type: 'reopen', node: 'Q8' }] }) }),
    mkCm('CM9', { text: 'Add another', state: 'accepted', proposal: mkProp('accept', { text: 'Adds it.', changes: [{ type: 'upsert', node: { kind: 'risk', label: 'No such node in the plan', body: 'x' } }] }) }),
  ])
  std().nodes.push(fr)
  std().recent.unshift({ rev: 96, at: CM_PAT, by: 'user', source: 'page', type: 'comment_accept', node: null, summary: 'accepted CM8' })
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm')
    eq(await page.locator('.cm[data-id=CM2] .cm-note').allTextContents(), ['Added as a draft; it joins the PRD once you confirm it'], 'preview: only the change that creates a node (FR-001 exists, the rest edit)')
    eq(await page.locator('.cm[data-id=CM2] .cm-change[data-kind=upsert]').nth(0).locator('.cm-note').count(), 1, 'the note is on the creating change')
    await page.click('.cm[data-id=CM8] [data-act=toggle]')
    eq(await page.locator('.cm[data-id=CM8] .cm-note').allTextContents(), ['Applied: added FR-007 as a draft'], 'accepted card names the new node; reopen keeps its wording')
    await page.click('.cm[data-id=CM9] [data-act=toggle]')
    eq(await page.locator('.cm[data-id=CM9] .cm-note').allTextContents(), ['Applied: added a new risk as a draft'], 'no matching node: still says draft')
  })
})

// Breaks if the "Post N replies" bar covers the bottom of the sticky Approve gate (both were sticky at the bottom), or the toast lands on the gate, the bar or the phone pane composer.
await check('layout: the reply bar stacks above the gate and the toast clears the gate, the bar and the pane composer', async () => {
  seedGh()
  await open('/plan/' + STD, MID, async page => {
    await cmGoPrd(page)
    await page.waitForSelector('.cm[data-id=GH1]')
    await rvBox(page, 'GH1').check()
    await rvBox(page, 'GH3').check()
    await page.waitForSelector('#rv-bar')
    await page.evaluate(() => window.scrollTo(0, 150))
    const [gate, bar] = await paneBoxes(page, ['.gate', '#rv-bar'])
    if (hit(gate, bar)) throw new Error('bar covers the gate: ' + JSON.stringify([gate, bar]))
    if (gate.b > MID.height + 1) throw new Error('the gate is pushed off the screen: ' + JSON.stringify(gate))
    await page.evaluate(() => toast('Copied'))
    await page.waitForTimeout(450)
    const [g2, b2, t2] = await paneBoxes(page, ['.gate', '#rv-bar', '#toast'])
    if (hit(t2, g2) || hit(t2, b2)) throw new Error('toast overlaps: ' + JSON.stringify({ t2, g2, b2 }))
  })
  seedComments()
  await open('/plan/' + STD, PHONE, async page => {
    await cmGoPrd(page, true)
    await page.waitForSelector('.cm')
    await openPane(page)
    await page.evaluate(() => toast('Sent as a comment'))
    await page.waitForTimeout(450)
    const [comp, t] = await paneBoxes(page, ['#prdpane .pane-comp', '#toast'])
    if (hit(t, comp)) throw new Error('toast overlaps the pane composer: ' + JSON.stringify({ t, comp }))
  })
})

// Breaks if a reload loses the half-typed comment (text and anchor), the draft leaks to another plan, an emptied or sent draft is kept, or a throwing localStorage breaks the composer.
await check('comments: the half-typed comment (text, anchor) survives a reload, per task; emptied or sent drafts are dropped', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.fill('#cm-text', 'half typed\nsecond line')
    await page.selectOption('#cm-anchor', '§7')
    await page.reload()
    await cmGoPrd(page)
    eq(await page.inputValue('#cm-text'), 'half typed\nsecond line', 'text after reload')
    eq(await page.inputValue('#cm-anchor'), '§7', 'anchor after reload')
    eq(await page.isDisabled('#cm-send'), false, 'Add comments enabled for the restored text')
    await page.fill('#cm-text', '')
    await page.reload()
    await cmGoPrd(page)
    eq(await page.inputValue('#cm-text'), '', 'an emptied draft is not kept')
    await page.fill('#cm-text', 'to be sent')
    await page.click('#cm-send')
    await waitPost()
    await page.waitForFunction(() => document.getElementById('cm-text').value === '')
    await page.reload()
    await cmGoPrd(page)
    eq(await page.inputValue('#cm-text'), '', 'a sent draft is not kept')
    await page.fill('#cm-text', 'only for the first plan')
    await page.goto(BASE + '/plan/' + RDY) // the same browser context: localStorage is shared, so only the per-task key keeps the drafts apart
    await cmGoPrd(page)
    await page.waitForSelector('#cm-text')
    eq(await page.inputValue('#cm-text'), '', 'another plan starts empty')
    await page.goto(BASE + '/plan/' + STD)
    await cmGoPrd(page)
    eq(await page.inputValue('#cm-text'), 'only for the first plan', 'the first plan keeps its draft')
  })
  await open('/plan/' + STD, DESK, async page => {
    await page.addInitScript(() => { Storage.prototype.getItem = () => { throw new Error('denied') }; Storage.prototype.setItem = () => { throw new Error('denied') }; Storage.prototype.removeItem = () => { throw new Error('denied') } })
    await page.reload()
    await cmGoPrd(page)
    await page.fill('#cm-text', 'still works')
    await page.click('#cm-send')
    await waitPost()
  })
})

// Breaks if a long session reply opens (or arrives) with its END in view so the reader has to scroll up to find the start, or a short reply stops following the bottom.
await check('pane: the start of a long newest session reply is in view; a short one still sits at the bottom', async () => {
  const long = Array.from({ length: 40 }, (_, i) => 'Paragraph ' + i + ' of a long answer about the conflicting comments.').join('\n\n')
  const startInView = page => page.evaluate(() => {
    const l = document.querySelector('#prdpane .th-list'), m = [...l.querySelectorAll('.th-msg.session')].pop()
    const d = m.getBoundingClientRect().top - l.getBoundingClientRect().top
    return d >= -2 && d < 40
  })
  seedComments()
  std().thread = [...paneThread(), { role: 'user', text: 'Explain everything', at: P_AT, ref: 'e-pl1' }, { role: 'session', text: long, at: P_AT, ref: 'e-pl1', links: [] }]
  await open('/plan/' + STD, WIDE, async page => {
    await cmGoPrd(page)
    await page.waitForSelector(PN + ' .th-msg')
    eq(await startInView(page), true, 'opens at the start of the long reply')
  })
  std().thread = paneThread()
  await open('/plan/' + STD, WIDE, async page => {
    await cmGoPrd(page)
    await page.waitForSelector(PN + ' .th-msg')
    eq(await paneBottom(page), true, 'a short thread sits at the bottom')
    std().thread = [...std().thread, { role: 'user', text: 'Explain everything', at: P_AT, ref: 'e-pl2' }, { role: 'session', text: long, at: P_AT, ref: 'e-pl2', links: [] }]
    std().rev++
    await forcePoll(page)
    await page.waitForFunction(() => document.querySelectorAll('#prdpane .th-msg.session').length === 2)
    eq(await startInView(page), true, 'a long reply that arrives while at the bottom shows its start')
    await page.$eval(PL, e => { e.scrollTop = e.scrollHeight })
    std().thread = [...std().thread, { role: 'user', text: 'Thanks', at: P_AT, ref: 'e-pl3' }, { role: 'session', text: 'You are welcome.', at: P_AT, ref: 'e-pl3', links: [] }]
    std().rev++
    await forcePoll(page)
    await page.waitForFunction(() => document.querySelectorAll('#prdpane .th-msg.session').length === 3)
    eq(await paneBottom(page), true, 'a short reply that arrives once the reader is at the bottom follows it')
  })
})

// Breaks if a stale-target refusal reaches the user as the core's raw string, leaves the list old, keeps the notice after the next successful action, or a 413 says only "The server answered 413."
await check('errors: known core refusals read plainly, the list refreshes, the notice clears on the next success; a 413 says the text is too long', async () => {
  seedComments()
  state.respond = ev => {
    if (ev.type !== 'comment_accept') return null
    std().comments = std().comments.filter(c => c.id !== ev.ref)
    std().rev++
    return { status: 400, body: { error: 'ref must name an existing comment' } }
  }
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    await page.click('.cm[data-id=CM3] [data-act=settle]')
    await page.waitForFunction(() => document.getElementById('toast').textContent === 'That comment changed; the list was refreshed')
    await page.waitForFunction(() => !document.querySelector('.cm[data-id=CM3]'), null, { timeout: 2500 })
    await page.waitForFunction(() => document.getElementById('notice').hidden, null, { timeout: 2500 })
  }, true)
  seedComments()
  const once = text => { let n = 0; state.respond = ev => (ev.type === 'comment_accept' && n++ === 0 ? { status: 400, body: { error: text } } : null) }
  const plain = [
    ['The proposal changed; reload the page', 'That proposal changed; the list was refreshed'],
    ['Only a proposed comment can be accepted', 'That comment changed; the list was refreshed'],
    ['Proposal no longer applies: node changed since the proposal', 'The plan changed since this proposal was made; the list was refreshed. Ask for a new one with Rework.'],
  ]
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    for (const [i, [raw, want]] of plain.entries()) {
      once(raw)
      await page.click('.cm[data-id=CM2] [data-act=accept]')
      await page.waitForSelector('#notice:not([hidden])')
      eq(await page.textContent('#notice .msg'), want, raw)
      state.respond = null
      if (i === 0) {
        await page.click('.cm[data-id=CM3] [data-act=settle]')
        await waitPost(2)
        await page.waitForSelector('#notice', { state: 'hidden' })
      } else await page.click('#notice button')
    }
  }, true)
  await open('/plan/' + STD, DESK, async page => {
    await cmGoPrd(page)
    state.respond = () => ({ status: 413, body: {} })
    await page.fill('#cm-text', 'x')
    await page.click('#cm-send')
    await page.waitForSelector('#notice:not([hidden])')
    eq(await page.textContent('#notice .msg'), 'That text is too long to send (the limit is about 16 KB). Shorten it and try again.', '413')
  }, true)
})

// Breaks if the PRD text starts far below its header because the comments sit above it (QA3 F-J, QA4 F5), the comments are not below the PRD, a width scrolls sideways,
// the docked pane no longer fits, the phone buttons start right of the textarea edge, "Ask about the PRD" reads as disabled, or the 1440 sheet has no scrim.
await check('layout: PRD body within 300px of its header at 2560 and 1440, comments below it; no sideways scroll; 390 buttons align; the pane button reads as a button; the sheet has a scrim', async () => {
  seedComments()
  for (const vp of [WIDE, MID, TAB, PHONE]) {
    await open('/plan/' + STD, vp, async page => {
      await cmGoPrd(page, vp === PHONE)
      await page.waitForSelector('.cm')
      const [head, prd, wrap, box] = await paneBoxes(page, ['#p-prd .prdhead', '#p-prd .prd', '#p-prd .prd-wrap', '#cm-box'])
      if (vp.width >= 1440 && prd.t - head.b > 300) throw new Error(vp.width + 'px: the PRD starts ' + (prd.t - head.b) + 'px below its header')
      if (box.t < wrap.b - 1) throw new Error(vp.width + 'px: the comments are not below the PRD: ' + JSON.stringify({ wrap, box }))
      eq(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, vp.width + 'px sideways overflow')
      if (vp === WIDE) {
        const [pn, w2] = await paneBoxes(page, [PN, '#p-prd .prd-wrap'])
        if (w2.r > pn.l || pn.r > WIDE.width) throw new Error('the docked pane does not fit: ' + JSON.stringify({ pn, w2 }))
        if (SHOTS) await page.screenshot({ path: join(SHOTS, 'fx3-2560.png') })
      }
      if (vp === MID) {
        eq(await page.evaluate(() => getComputedStyle(document.getElementById('pane-open')).color === getComputedStyle(document.body).color), true, 'Ask about the PRD uses the text colour')
        eq(await page.evaluate(() => getComputedStyle(document.body, '::before').content), 'none', 'no scrim without the sheet')
        await openPane(page)
        eq(await page.evaluate(() => { const s = getComputedStyle(document.body, '::before'); return s.position + ' ' + (s.backgroundColor !== 'rgba(0, 0, 0, 0)') }), 'fixed true', 'scrim behind the 1440 sheet')
        if (SHOTS) await page.screenshot({ path: join(SHOTS, 'fx3-1440-sheet.png') })
        await page.click('#prdpane .pane-close')
        eq(await page.evaluate(() => getComputedStyle(document.body, '::before').content), 'none', 'scrim gone after Close')
        if (SHOTS) await page.screenshot({ path: join(SHOTS, 'fx3-1440.png') })
      }
      if (vp === PHONE) {
        const left = sel => page.$eval(sel, e => Math.round(e.getBoundingClientRect().left))
        eq(await left('#cm-send'), await left('#cm-text'), 'Add comments starts at the textarea edge')
        if (SHOTS) await page.screenshot({ path: join(SHOTS, 'fx3-390.png'), fullPage: true })
        await openPane(page)
        eq(await left(PN + ' .th-send'), await left('#pane-text'), 'pane Send starts at the textarea edge')
        if (SHOTS) await page.screenshot({ path: join(SHOTS, 'fx3-390-pane.png') })
      }
    })
  }
})

// Breaks if the page loads anything the CSP forbids or throws; also covers every page opened above.
await check('zero console errors (CSP violations count)', async () => {
  await open('/plan/' + STD, DESK, async (page, ctx) => {
    await page.waitForSelector('#titleText:not(:empty)')
    for (const t of ['PRD', 'Build', 'Log', 'Lanes']) await page.click(`#tabs .tab:has-text("${t}")`)
    await page.waitForTimeout(300)
    eq(ctx.errs, [], 'console errors on the standard plan')
  })
  eq(consoleErrors, [], 'console errors across all checks')
})

await browser.close()
server.stop(true)
if (failures.length) { console.log(`${failures.length} check(s) failed`); process.exit(1) }
process.exit(0)
