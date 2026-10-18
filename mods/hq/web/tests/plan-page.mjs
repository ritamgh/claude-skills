// Acceptance script for web/plan.html. Run from mods/hq:  bun web/tests/plan-page.mjs
// Serves plan.html from a tiny Bun server that fakes the three plan API routes over the shape fixtures
// (same CSP header and a real nonce as server.ts), then drives it with Playwright.
// Prints "ok <name>" per check, "FAIL <name>: why" otherwise; exit 1 on any failure; prints "skip: ..." and exits 0 when Playwright or its chromium is missing.
// Set PLAN_SHOTS=<dir> to save desktop.png, desktop-prd.png, phone.png, board-desktop.png and board-400.png there; PLAN_HTML=<file> to test another page.
import { readFileSync, mkdirSync } from 'node:fs'
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
async function open(path, vp, fn, expectHttp = false) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, colorScheme: 'light' })
  const page = await ctx.newPage()
  page.setDefaultTimeout(6000)
  const dialogs = []
  const errs = []
  page.on('console', msg => { if (msg.type() === 'error') errs.push(msg.text()) })
  page.on('pageerror', e => errs.push('pageerror: ' + e.message))
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss() })
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
async function check(name, fn) {
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
    await page.waitForSelector('#p-lanes.on')
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
    if (!(await page.textContent('#actbar .who')).includes(evil)) throw new Error('label text missing in the action bar')
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

// Breaks if the node action bar shows the wrong buttons for the kind, or posts the wrong event type.
await check('node actions post strike, edit_label, note, expand, reopen, prioritize', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=AS-1]')
    eq(await page.locator('#actbar .btn').allTextContents(), ['Park', 'Strike', 'Expand', 'Edit label', 'Ask', 'Add note'], 'assumption buttons')
    await page.click('#actbar [data-act=strike]')
    await waitPost(1)
    eq(JSON.stringify(state.posts[0]), '{"type":"strike","node":"AS-1"}', 'strike')

    await page.click('#actbar [data-act=expand]')
    await waitPost(2)
    eq(JSON.stringify(state.posts[1]), '{"type":"expand","node":"AS-1"}', 'expand')

    await page.click('#actbar [data-act=edit_label]')
    await page.fill('#actbar input', 'Two developers for the whole 2 weeks')
    await page.press('#actbar input', 'Enter')
    await waitPost(3)
    eq(JSON.stringify(state.posts[2]), '{"type":"edit_label","node":"AS-1","label":"Two developers for the whole 2 weeks"}', 'edit_label')

    await page.click('#actbar [data-act=note]')
    await page.fill('#actbar input', 'Check with Priya')
    await page.click('#actbar .frm .btn.primary')
    await waitPost(4)
    eq(JSON.stringify(state.posts[3]), '{"type":"note","node":"AS-1","text":"Check with Priya"}', 'note')

    await page.click('.node[data-id=DEC-1]')
    eq(await page.locator('#actbar .btn').allTextContents(), ['Reopen', 'Park', 'Expand', 'Edit label', 'Ask', 'Add note'], 'settled decision buttons')
    await page.click('#actbar [data-act=reopen]')
    await waitPost(5)
    eq(JSON.stringify(state.posts[4]), '{"type":"reopen","node":"DEC-1"}', 'reopen')

    await page.click('.node[data-id=Q22]')
    if ((await page.locator('#actbar [data-act=prioritize]').count()) !== 1) throw new Error('no Prioritize on an open question')
    await page.click('#actbar [data-act=prioritize]')
    await waitPost(6)
    eq(JSON.stringify(state.posts[5]), '{"type":"prioritize","node":"Q22"}', 'prioritize')
  })
})

// Breaks if the action bar offers Strike on a non-assumption.
await check('Strike is offered for assumptions only', async () => {
  await open('/plan/' + STD, DESK, async page => {
    await page.click('.node[data-id=DEC-1]')
    eq(await page.locator('#actbar [data-act=strike]').count(), 0, 'strike on a decision')
    await page.click('.node[data-id=T-001]')
    eq(await page.locator('#actbar [data-act=strike]').count(), 0, 'strike on a task')
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
