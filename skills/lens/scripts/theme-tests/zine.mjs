// Regression suite for assets/themes/zine.html, run by scripts/test-template.mjs against the worked example
// (examples/jw-ask-flow.json: 7 nodes, 7 edges, 9 stops, gates at stops 3 and 5, 4 quiz questions).
import { getChromium } from '../pw.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'; import { tmpdir } from 'os'; import { join, dirname } from 'path'; import { fileURLToPath } from 'url'; import { execFileSync } from 'child_process';
const url = 'file://' + process.argv[2];
const shots = mkdtempSync(join(tmpdir(), 'lens-zine-')); process.chdir(shots);
const pw = await getChromium();
if (!pw) { console.log('skip: Playwright not found (npm i -g playwright && npx playwright install chromium)'); process.exit(0); }
const b = await pw.launch();
let failed = 0; const errs = [];
const mk = async (w, h, scheme, u = url) => { const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: 'reduce' });
  p.on('pageerror', e => errs.push('pageerror: ' + e.message)); p.on('console', m => m.type() === 'error' && !/fonts\.g/.test(m.text()) && errs.push('console: ' + m.text()));
  await p.goto(u); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(400); return p; };
const p = await mk(1440, 960, 'light');
const t = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); } };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${a} !== ${b}`); };
const active = () => p.locator('#map .node.active').getAttribute('data-id');
const toQuiz = async () => { await p.evaluate(() => document.getElementById('s-quiz')?.scrollIntoView({ block: 'start' })); await p.waitForTimeout(250); };

await t('map drawn', async () => { eq(await p.locator('#map .node').count(), 7, 'nodes'); eq(await p.locator('#map .edge').count(), 7, 'edges'); });
await t('trip renders 9 stops and the rail lists them', async () => { eq(await p.locator('article.stop').count(), 9, 'stops'); eq(await p.locator('.stops li').count(), 9, 'rail'); });
await t('stop 1 active, no route yet', async () => { eq(await active(), 'shell', 'active'); eq(await p.locator('#map .route').count(), 0, 'route'); });
await p.screenshot({ path: 'z1-start.png' });
await t('J moves stops and the route grows', async () => { await p.keyboard.press('j'); await p.keyboard.press('j'); await p.waitForTimeout(300);
  eq(await active(), 'ask', 'active'); eq(await p.locator('#map .route').count(), 2, 'route segs'); eq(await p.locator('.stops li.done').count(), 2, 'rail ticks'); });
await t('gate blurs narrative, keeps code, masks new values', async () => { eq(await p.locator('#stop-2 .blurred').count(), 1, 'blurred');
  eq(await p.locator('#stop-2 figure.code').count(), 1, 'code'); eq(await p.locator('#stop-2 .mv.masked').count(), 2, 'masked'); });
await p.screenshot({ path: 'z2-gate.png' });
await t('number key answers the current gate', async () => { await p.keyboard.press('2'); eq(await p.locator('#stop-2 .choice.right').count(), 1, 'right');
  eq(await p.locator('#stop-2 .blurred').count(), 0, 'unblurred'); eq(await p.locator('#stop-2 .mv.masked').count(), 0, 'unmasked'); });
await t('deep toggle swaps the text', async () => { await p.locator('#depth button[data-d="deep"]').click(); const x = await p.locator('#stop-2 .narr').innerText(); if (!x.includes('shift 2')) throw new Error(x.slice(0, 60)); });
await t('rail link jumps to a stop', async () => { await p.locator('[data-lens-stop="4"]').click(); await p.waitForTimeout(300); eq(await active(), 'invoke', 'active'); });
await t('component note opens under the map', async () => { await p.locator('#map .node[data-id="ledger"]').click(); await p.locator('#nodeNote h3', { hasText: 'Ledger' }).waitFor({ timeout: 2000 }); });
await t('show impact paints dependents', async () => { await p.locator('#showImpact').click(); eq(await p.locator('#map .node.origin').count(), 1, 'origin'); eq(await p.locator('#map .node.hit').count(), 4, 'hits'); });
await p.screenshot({ path: 'z3-impact.png' });
await t('route mode clears impact', async () => { await p.locator('#mapMode button[data-m="route"]').click(); eq(await p.locator('#map .node.hit').count(), 0, 'cleared'); });
await t('break it: run + show damage', async () => { await p.locator('[data-run="0"]').click(); eq(await p.locator('.exp .result.shown').count(), 1, 'shown');
  await p.locator('[data-show="0"]').click(); eq(await p.locator('#map .node.hit').count(), 3, 'hits'); eq(await p.locator('#map .node.origin').count(), 1, 'origin'); });
await t('clicking a node clears the experiment', async () => { await p.locator('#map .node[data-id="router"]').click(); eq(await p.locator('#map .node.hit').count(), 0, 'cleared'); });
await t('why + weak render', async () => { eq(await p.locator('.dec').count(), 2, 'decisions'); eq(await p.locator('.risk').count(), 3, 'risks'); });
await t('glossary tooltip on hover', async () => { await p.evaluate(() => [...document.querySelectorAll('.term')].find(e => !e.closest('.blurred, [hidden]'))?.setAttribute('data-hover-me', '')); const term = p.locator('[data-hover-me]'); await term.scrollIntoViewIfNeeded(); await term.hover(); eq(await p.locator('#tip.on').count(), 1, 'tip'); const GDEF = { subshell: 'A child copy of the shell, made with ( ... ). Changes inside it, such as cd, do not affect the parent.', 'set -e': 'Bash option: exit immediately when a command fails, except commands tested by if, &&, || and similar.', ledger: "jw's markdown table of runs: time, task, model, session id and status.", worktree: 'A second working folder for the same git repo, on its own branch, so a worker can edit without touching your checkout.' };
  const word = (await term.innerText()).trim(); eq((await p.locator('#tip').innerText()).replace(/\s+/g, ' ').trim(), word + ': ' + GDEF[word.toLowerCase()], 'tip text'); });
await t('a map redraw (focus restore) does not dismiss an open tooltip', async () => { await p.locator('#map .node').first().focus(); await p.mouse.move(2, 2);
  await p.evaluate(() => { document.querySelector('[data-hover-me]')?.removeAttribute('data-hover-me'); [...document.querySelectorAll('.term')].find(e => !e.closest('.blurred, [hidden]'))?.setAttribute('data-hover-me', ''); });
  const term = p.locator('[data-hover-me]'); await term.scrollIntoViewIfNeeded(); await p.waitForTimeout(100); await term.hover(); eq(await p.locator('#tip.on').count(), 1, 'tip before');
  await p.evaluate(() => { document.documentElement.style.overflowAnchor = 'none'; }); /* a 1px scroll shift would close the tip for a reason that is not under test */ await p.setViewportSize({ width: 1439, height: 960 }); await p.waitForTimeout(400); eq(await p.locator('#tip.on').count(), 1, 'tip after redraw'); await p.setViewportSize({ width: 1440, height: 960 }); await p.evaluate(() => { document.documentElement.style.overflowAnchor = ''; }); await p.waitForTimeout(300); });
await t('quiz by keyboard, score persists', async () => { await toQuiz();
  for (const k of ['1', 'Enter', '2', 'Enter', '3', 'Enter', '1', 'Enter']) await p.keyboard.press(k);
  await p.locator('.score').waitFor({ timeout: 2000 }); eq((await p.locator('.score').innerText()).replace(/\s+/g, ' '), '4 of 4', 'score');
  await p.screenshot({ path: 'z4-quiz.png' }); await p.reload(); await p.locator('.score').waitFor({ timeout: 2000 }); });
await t('restart, a miss shows as a pink pip', async () => { await p.locator('#restart').click(); await toQuiz(); await p.keyboard.press('2'); eq(await p.locator('.pip.wrong').count(), 1, 'wrong pip'); });
await t('resume banner after reload', async () => { await p.reload(); await p.waitForTimeout(300); eq(await p.locator('#resumeBtn').count(), 1, 'resume'); });
await t('theme toggle persists', async () => { await p.locator('#themeBtn').click(); await p.reload(); eq(await p.evaluate(() => document.documentElement.dataset.theme), 'dark', 'theme'); await p.evaluate(() => localStorage.clear()); });
await t('desktop no horizontal scroll', async () => { const w = await p.evaluate(() => document.documentElement.scrollWidth); if (w > 1440) throw new Error('scrollWidth ' + w); });
const d = await mk(1920, 1080, 'dark'); await d.screenshot({ path: 'z5-dark.png' });
const m = await mk(390, 844, 'light');
await t('mobile no horizontal scroll', async () => { const w = await m.evaluate(() => document.documentElement.scrollWidth); if (w > 390) throw new Error('scrollWidth ' + w); });
await m.screenshot({ path: 'z6-mobile.png', fullPage: true });
// ---------- architecture mode (scripts/testdata/arch-mini.json: 5 nodes, 6 edges of which 3 async, 2 flows of 4 + 3 stops,
// 3 invariants, 2 pressure points, 2 failure modes, 2 decisions, 1 risk, 4 quiz questions) ----------
const here = dirname(fileURLToPath(import.meta.url)), lensRoot = join(here, '..', '..');
const fixture = JSON.parse(readFileSync(join(lensRoot, 'scripts', 'testdata', 'arch-mini.json'), 'utf8'));
const buildLesson = (name, lesson) => { const src = join(shots, name + '.json'), out = join(shots, name + '.html'); writeFileSync(src, JSON.stringify(lesson));
  execFileSync('python3', [join(lensRoot, 'scripts', 'build.py'), src, out, '--theme', 'zine'], { stdio: 'pipe' }); return 'file://' + out; };
const archUrl = buildLesson('arch-mini', fixture);
const a = await mk(1440, 960, 'light', archUrl);
const secIds = pg => pg.evaluate(() => [...document.querySelectorAll('section.sec')].filter(s => !s.hidden).map(s => s.id));
const railNames = pg => pg.evaluate(() => [...document.querySelectorAll('.toc>li>a')].map(x => x.firstChild.textContent));
const h2s = pg => pg.evaluate(() => [...document.querySelectorAll('section.sec:not([hidden]) h2')].map(x => x.textContent.trim()));
const flat = async loc => (await loc.innerText()).replace(/\s+/g, ' ');
// a point on the middle of an edge's wire in page coordinates, so a real mouse click proves the edge is hittable
const edgeXY = (pg, i) => pg.evaluate(i => { const path = document.querySelector(`#map .edge[data-ei="${i}"] .hitarea`); path.scrollIntoView({ block: 'center' });
  const m = path.getPointAtLength(path.getTotalLength() * .5), pt = new DOMPoint(m.x, m.y).matrixTransform(path.getScreenCTM()); return { x: pt.x, y: pt.y }; }, i);
const clickEdge = async (pg, i) => { await pg.locator('#map').scrollIntoViewIfNeeded(); const { x, y } = await edgeXY(pg, i); await pg.mouse.click(x, y); };

// breaks if the architecture map stops drawing every node and edge, or draws the extra hit-area as a second edge
await t('arch: map has 5 nodes and 6 edges', async () => { eq(await a.locator('#map .node').count(), 5, 'nodes'); eq(await a.locator('#map .edge').count(), 6, 'edges'); });
// breaks if sync:false stops being drawn dashed, or if sync:true / absent edges get dashed too
await t('arch: exactly the 3 sync:false edges are dashed', async () => {
  const dashed = await a.evaluate(() => [...document.querySelectorAll('#map .edge')].filter(e => getComputedStyle(e.querySelector('.wire')).strokeDasharray !== 'none').map(e => e.dataset.from + '>' + e.dataset.to));
  eq(dashed.join(','), 'api>queue,queue>worker,worker>cdn', 'dashed edges'); });
// breaks if the section order, the new sections or the rail entries drift from the contract, or an empty section leaves a rail entry
await t('arch: section order and rail follow the contract', async () => {
  eq((await secIds(a)).join(','), 's-map,s-trip,s-interfaces,s-invariants,s-pressure,s-break,s-why,s-weak,s-quiz,s-terms', 'sections');
  eq((await railNames(a)).join('|'), 'The map|Flows|Interfaces|Invariants|Pressure points|Failure modes|Decisions|Weak spots|Check yourself|Words to know', 'rail'); });
// breaks if architecture mode keeps the code-mode names (The trip, Break it, Why it's built this way)
await t('arch: headings are relabelled', async () => {
  eq((await h2s(a)).join('|'), 'The map|Flows|Interfaces|Invariants|Pressure points|Failure modes|Decisions|Weak spots|Check yourself|Words to know', 'h2'); });
// breaks if steps without code or state still draw an empty code card or a "nothing stored" sticky note
await t('arch: flows show code and memory only where the step has them', async () => {
  eq(await a.locator('#s-trip .tabs button').count(), 2, 'flow tabs'); eq(await a.locator('article.stop').count(), 4, 'stops');
  eq(await a.locator('article.stop figure.code').count(), 1, 'code cards'); eq(await a.locator('article.stop .memo').count(), 1, 'memory notes');
  eq(await a.locator('#stop-1 .memo, #stop-1 figure.code').count(), 0, 'plain step'); eq(await a.locator('.stops li').count(), 4, 'rail stops'); });
// breaks if the Interfaces list drops rows, loses a column, or stops saying which connections are async
await t('arch: interfaces list has one row per connection with its contract', async () => {
  const rows = a.locator('#s-interfaces tbody tr'); eq(await rows.count(), 6, 'rows');
  eq(await flat(rows.nth(0)), 'Upload API → Job queue AMQP publish async Upload id and object key. at-least-once', 'row 1');
  eq(await flat(rows.nth(3)), 'Upload API → Photo store SQL over TLS sync One metadata row per upload. read-your-writes', 'row 4');
  eq(await flat(rows.nth(5)), 'CDN → Photo store S3 GET — — —', 'row 6'); });
await a.screenshot({ path: 'a1-arch-top.png' });
// breaks if edges cannot be clicked with a real mouse (hit area missing or covered), or the note drops protocol/payload/guarantee
await t('arch: clicking an edge shows protocol, payload and guarantee', async () => {
  await clickEdge(a, 0); const note = a.locator('#nodeNote'); await note.locator('h3', { hasText: 'Upload API → Job queue' }).waitFor({ timeout: 2000 });
  const x = await flat(note); for (const w of ['AMQP publish', 'fire and forget', 'Upload id and object key.', 'at-least-once']) if (!x.includes(w)) throw new Error('note lacks ' + w + ': ' + x.slice(0, 120));
  eq(await a.locator('#map .edge.sel').count(), 1, 'selected edge'); eq(await a.locator('#map .edge.sel').getAttribute('data-ei'), '0', 'which'); });
// breaks if making edges clickable swallows node clicks, or the Architecture block (owns/exposes/runs/scale) is missing from the node note
await t('arch: node click still works and its note lists owns, exposes, runs, scale', async () => {
  await a.locator('#map .node[data-id="api"]').click(); const note = a.locator('#nodeNote'); await note.locator('h3', { hasText: 'Upload API' }).waitFor({ timeout: 2000 });
  eq(await a.locator('#map .edge.sel').count(), 0, 'edge selection cleared'); const x = await flat(note.locator('.archblock'));
  eq(x, 'Architecture Owns Upload ids and the first metadata row of every upload. Exposes POST /uploads and GET /uploads/{id} over HTTPS. Runs Container pool behind the public load balancer. Scale Horizontally, add containers. Tops out at the store connection limit.', 'block'); });
// breaks if a node with no architecture fields still gets an empty Architecture block
await t('arch: a node without architecture fields shows no block, a partial one only what it has', async () => {
  await a.locator('#map .node[data-id="cdn"]').click(); await a.locator('#nodeNote h3', { hasText: 'CDN' }).waitFor({ timeout: 2000 }); eq(await a.locator('#nodeNote .archblock').count(), 0, 'cdn block');
  await a.locator('#map .node[data-id="worker"]').click(); await a.locator('#nodeNote h3', { hasText: 'Thumbnail worker' }).waitFor({ timeout: 2000 });
  eq(await a.locator('#nodeNote .archblock dt').allInnerTexts().then(l => l.join(',')), 'Owns,Runs,Scale', 'worker labels'); });
// breaks if edges are mouse-only (no tabindex or Enter handler)
await t('arch: an edge can be opened from the keyboard', async () => {
  await a.locator('#map .edge[data-ei="2"]').focus(); await a.keyboard.press('Enter'); await a.locator('#nodeNote h3', { hasText: 'Thumbnail worker → Photo store' }).waitFor({ timeout: 2000 });
  if (!(await flat(a.locator('#nodeNote'))).includes('SQL over TLS')) throw new Error('no protocol'); eq(await flat(a.locator('#nodeNote .edge-dl dd').nth(1)), 'sync: the caller waits for the reply', 'sync text'); });
// breaks if clicking a row of the Interfaces list stops highlighting that edge on the map
await t('arch: an interfaces row highlights its edge on the map', async () => {
  await a.locator('#s-interfaces tbody tr').nth(4).locator('button').click(); await a.waitForTimeout(150);
  eq(await a.locator('#map .edge.sel').getAttribute('data-ei'), '4', 'edge'); eq(await a.locator('#map .edge.sel').getAttribute('data-to'), 'cdn', 'to');
  if (!(await flat(a.locator('#nodeNote'))).includes('HTTPS purge call')) throw new Error('note'); });
// breaks if selecting an edge clears impact mode (its origin and the 4 painted dependents); the F2 tests below cover the other highlights, which an edge does clear
await t('arch: edge click leaves impact mode intact', async () => {
  await a.locator('#map .node[data-id="store"]').click(); await a.locator('#showImpact').click(); eq(await a.locator('#map .node.hit').count(), 4, 'hits before');
  await clickEdge(a, 0); eq(await a.locator('#map .node.origin').count(), 1, 'origin'); eq(await a.locator('#map .node.hit').count(), 4, 'hits after');
  await a.locator('#mapMode button[data-m="route"]').click(); eq(await a.locator('#map .node.hit').count(), 0, 'cleared'); });
// breaks if invariants lose their enforcer link, their "what breaks" text, or stop painting the enforcing node
await t('arch: invariants show rule, enforcer, consequence and paint the node', async () => {
  eq(await a.locator('.inv').count(), 3, 'invariants'); const first = a.locator('.inv').first();
  eq(await flat(first.locator('h3')), 'Only the worker writes thumbnails. seen in code', 'rule'); eq(await flat(first.locator('.enf')), 'Enforced at Thumbnail worker', 'enforcer');
  eq(await flat(first.locator('.breaks')), 'If it breaks: Two writers race and a reader sees a half-overwritten thumbnail.', 'breaks');
  await first.locator('[data-mark]').click(); await a.waitForTimeout(150); eq(await a.locator('#map .node.marked').count(), 1, 'marked'); eq(await a.locator('#map .node.marked').getAttribute('data-id'), 'worker', 'node');
  await a.locator('#mapMode button[data-m="route"]').click(); eq(await a.locator('#map .node.marked').count(), 0, 'cleared'); });
// breaks if pressure points lose limit/signal/mitigation, the severity badge, or the node painting
await t('arch: pressure points show limit, signal, mitigation, severity and paint the node', async () => {
  eq(await a.locator('.press').count(), 2, 'pressure'); const first = a.locator('.press').first();
  eq(await flat(first.locator('.sev')), 'high', 'severity'); eq(await flat(first.locator('h3')), 'Queue backlog during a burst likely', 'title');
  const x = await flat(first.locator('.links')); eq(x, 'limit About 5,000 jobs a minute per worker pool. you would notice Queue depth keeps growing for more than five minutes. mitigation Add workers and cap new uploads per user.', 'dl');
  await first.locator('[data-mark]').click(); await a.waitForTimeout(150); eq(await a.locator('#map .node.marked').getAttribute('data-id'), 'queue', 'node'); });
// breaks if failure modes keep the code-mode wording or lose the damage painting
await t('arch: failure modes reveal a blast radius and paint it', async () => {
  eq(await a.locator('.exp').count(), 2, 'failure modes'); eq(await flat(a.locator('[data-run="0"]')), 'Reveal the blast radius', 'button');
  await a.locator('[data-run="0"]').click(); eq(await flat(a.locator('.exp .result.shown .what')), 'Blast radius likely', 'label');
  await a.locator('[data-show="0"]').click(); eq(await a.locator('#map .node.origin').getAttribute('data-id'), 'worker', 'origin'); eq(await a.locator('#map .node.hit').count(), 2, 'hits'); });
// breaks if decisions drop the forces (context) or what we live with (consequences)
await t('arch: decisions show context and consequences when present', async () => {
  eq(await a.locator('.dec').count(), 2, 'decisions'); eq(await a.locator('.dec-ctx').count(), 2, 'context'); eq(await a.locator('.dec-cons').count(), 2, 'consequences');
  eq(await flat(a.locator('.dec-ctx').first()), 'The forces Uploads arrive in bursts and thumbnailing takes seconds of CPU per photo.', 'ctx');
  eq(await flat(a.locator('.dec-cons').nth(1)), 'What we live with The database is a shared ceiling on write throughput.', 'cons'); eq(await a.locator('.risk').count(), 1, 'weak spots'); });
// breaks if scene objects (sketch-only) leak into zine's DOM or throw
await t('arch: scene objects are ignored', async () => { const x = await a.evaluate(() => document.querySelector('main').innerText); for (const c of ['one writer only', 'crash, then redeliver', 'who checks the dial?']) if (x.includes(c)) throw new Error('scene caption rendered: ' + c); });
// breaks if the quiz or terms stop working in architecture mode
await t('arch: quiz and glossary still work', async () => { eq(await a.locator('#s-quiz .pip').count(), 4, 'pips'); eq(await a.locator('#s-terms dt').count(), 2, 'terms'); });
await a.evaluate(() => document.getElementById('s-interfaces')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a2-arch-interfaces.png' });
await a.evaluate(() => document.getElementById('s-invariants')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a3-arch-invariants.png' });
await a.evaluate(() => document.getElementById('s-pressure')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a4-arch-pressure.png' });
await a.evaluate(() => document.getElementById('s-why')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a5-arch-decisions.png' });
await a.evaluate(() => scrollTo(0, 0)); await a.locator('#map .node[data-id="queue"]').click(); await a.waitForTimeout(300); await a.screenshot({ path: 'a6-arch-node.png' });
await clickEdge(a, 0); await a.waitForTimeout(300); await a.screenshot({ path: 'a7-arch-edge.png' });

const ad = await mk(1440, 960, 'dark', archUrl);
// breaks if the new sections or dashed edges only work in the light palette
await t('arch dark: dark palette, dashed edges and new sections render', async () => {
  eq(await ad.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(26, 25, 21)', 'page bg'); eq(await ad.locator('#s-invariants .inv').count(), 3, 'invariants');
  eq(await ad.evaluate(() => getComputedStyle(document.querySelector('.inv h3')).color), 'rgb(243, 237, 224)', 'ink'); });
await ad.evaluate(() => document.getElementById('s-pressure')?.scrollIntoView({ block: 'start' })); await ad.waitForTimeout(200); await ad.screenshot({ path: 'a8-arch-dark.png' });
const am = await mk(390, 844, 'light', archUrl);
// breaks if the interfaces table or the new cards overflow a phone
await t('arch mobile: no horizontal scroll, interfaces stack', async () => {
  const w = await am.evaluate(() => document.documentElement.scrollWidth); if (w > 390) throw new Error('scrollWidth ' + w);
  eq(await am.evaluate(() => getComputedStyle(document.querySelector('#s-interfaces td')).display), 'block', 'stacked cells'); });
await am.screenshot({ path: 'a9-arch-mobile.png', fullPage: true });

// robustness: tiny variants built in memory from the fixture
const vis = pg => pg.evaluate(() => [...document.querySelectorAll('section.sec')].filter(s => !s.hidden).map(s => s.id).join(','));
const clone = () => JSON.parse(JSON.stringify(fixture));
{ // no traces at all
  const v = clone(); delete v.traces; const pv = await mk(1280, 900, 'light', buildLesson('arch-notraces', v));
  // breaks if a lesson without flows leaves the Flows heading or rail entry, or throws on J/K
  await t('arch variant: no traces hides Flows cleanly', async () => {
    eq(await vis(pv), 's-map,s-interfaces,s-invariants,s-pressure,s-break,s-why,s-weak,s-quiz,s-terms', 'sections'); eq((await railNames(pv)).includes('Flows'), false, 'rail');
    await pv.keyboard.press('j'); await pv.keyboard.press('k'); await pv.locator('#map .node[data-id="api"]').click(); await pv.locator('#map .edge[data-ei="0"]').focus(); await pv.keyboard.press('Enter');
    eq(await pv.locator('section.sec:not([hidden]) h2').count(), 9, 'every visible section has a heading'); });
  // bare: no code, no state, no edge contract, no invariants or pressure
  const w = clone(); w.traces.forEach(tr => tr.steps.forEach(s => { delete s.code; delete s.state; })); delete w.invariants; delete w.pressure;
  w.edges.forEach(e => { delete e.protocol; delete e.sync; delete e.payload; delete e.guarantee; });
  const pw2 = await mk(1280, 900, 'light', buildLesson('arch-bare', w));
  // breaks if sections without data keep an empty heading or rail entry, or steps without code/state keep empty cards
  await t('arch variant: no code, state, edge contract, invariants or pressure', async () => {
    eq(await vis(pw2), 's-map,s-trip,s-break,s-why,s-weak,s-quiz,s-terms', 'sections'); eq(await pw2.locator('figure.code, .memo').count(), 0, 'cards');
    eq(await pw2.locator('#map .edge').evaluateAll(l => l.filter(e => e.hasAttribute('tabindex')).length), 0, 'clickable edges'); eq(await pw2.locator('#map .hitarea').count(), 0, 'hit areas');
    eq((await railNames(pw2)).join('|'), 'The map|Flows|Failure modes|Decisions|Weak spots|Check yourself|Words to know', 'rail'); });
  // the same data without mode is a code-mode lesson: old names and order, but node and decision fields still show
  const c = clone(); delete c.mode; const pc = await mk(1280, 900, 'light', buildLesson('arch-asCode', c));
  // breaks if mode:code (or absent) is relabelled as architecture, or if the new node/decision fields are ignored in code mode
  await t('code mode keeps its names and still shows node and decision fields', async () => {
    eq((await h2s(pc)).slice(0, 2).join('|'), 'The map|The trip', 'h2'); eq((await h2s(pc)).includes('Break it'), true, 'break it'); eq((await h2s(pc)).includes('Failure modes'), false, 'no failure modes');
    await pc.locator('#map .node[data-id="queue"]').click(); await pc.locator('#nodeNote .archblock').waitFor({ timeout: 2000 }); eq(await pc.locator('.dec-cons').count(), 2, 'consequences');
    eq(await vis(pc), 's-map,s-trip,s-invariants,s-pressure,s-break,s-why,s-weak,s-quiz,s-terms', 'no Interfaces outside architecture mode'); eq(await pc.locator('#map .edge.async, #map .edge.link').count(), 0, 'no async/clickable edges'); });
  await pv.close(); await pw2.close(); await pc.close();
}


// ---------- fix wave F2: parallel edges, J/K, one highlight, interfaces width, invariants, focus, glossary, escaping, empty maps ----------
const dense = JSON.parse(readFileSync(join(lensRoot, 'scripts', 'testdata', 'arch-dense.json'), 'utf8')); // a synthetic 9-node, 10-edge lesson with long text
const mkv = async (name, mutate, w = 1440, h = 900, scheme = 'light', base = fixture) => { const v = JSON.parse(JSON.stringify(base)); mutate?.(v); return mk(w, h, scheme, buildLesson(name, v)); };
const sel = pg => pg.evaluate(() => [...document.querySelectorAll('#map .edge.sel')].map(e => e.dataset.ei).join(','));
const pathMid = (pg, q, k = 0) => pg.evaluate(([q, k]) => { const p = document.querySelectorAll(q)[k], m = p.getPointAtLength(p.getTotalLength() * .5); return { x: m.x, y: m.y }; }, [q, k]);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const hereStop = pg => pg.evaluate(() => document.querySelector('.stop.here')?.dataset.i);
const hint = pg => pg.evaluate(() => document.getElementById('mapHint').innerText.replace(/\s+/g, ' '));
const addEdge = (v, from, to, label) => v.edges.push({ from, to, label, protocol: label + ' protocol', sync: true, payload: label + ' payload.', guarantee: 'best-effort' });

{ // 1 (R2) reciprocal and duplicate edges used to share one curve and one hit area; the first one could not be clicked
  const pr = await mkv('recip', v => { addEdge(v, 'queue', 'api', 'ack'); addEdge(v, 'api', 'queue', 'again'); addEdge(v, 'store', 'cdn', 'revalidate'); }, 1440, 900);
  // breaks if two edges between the same two nodes are drawn on one curve, so a mouse click always selects the last drawn one
  await t('R2: a reciprocal edge, a duplicate edge and a same-column reply each get their own clickable curve', async () => {
    for (const group of [[0, 6, 7], [5, 8]]) {
      for (const i of group) { await clickEdge(pr, i); eq(await sel(pr), String(i), 'selected after clicking edge ' + i); }
      const mids = []; for (const i of group) mids.push(await pathMid(pr, `#map .edge[data-ei="${i}"] .hitarea`));
      for (let a = 0; a < mids.length; a++) for (let b = a + 1; b < mids.length; b++) if (dist(mids[a], mids[b]) < 16) throw new Error(`edges ${group[a]} and ${group[b]} are ${dist(mids[a], mids[b]).toFixed(1)}px apart`);
    } });
  // breaks if parallel edges lose their own arrowhead, or an offset curve no longer ends on the node it points to
  await t('R2: every parallel edge keeps its arrowhead and ends at its node', async () => {
    const ends = await pr.evaluate(() => [0, 6].map(i => { const g = document.querySelector(`#map .edge[data-ei="${i}"]`), w = g.querySelector('.wire'), h = g.querySelector('.head'), tgt = document.querySelector(`#map .node[data-id="${g.dataset.to}"]`);
      const hp = h.getPointAtLength(h.getTotalLength() / 2), r = tgt.getBoundingClientRect(), pt = new DOMPoint(hp.x, hp.y).matrixTransform(h.getScreenCTM());
      return { heads: g.querySelectorAll('.head').length, near: pt.x >= r.left - 20 && pt.x <= r.right + 20 && pt.y >= r.top - 4 && pt.y <= r.bottom + 4 }; }));
    eq(JSON.stringify(ends), '[{"heads":1,"near":true},{"heads":1,"near":true}]', 'heads'); });
  await pr.evaluate(() => scrollTo(0, 0)); await pr.locator('#map').scrollIntoViewIfNeeded(); await pr.screenshot({ path: 'f2-parallel-edges.png' }); await pr.close();
  // the route follows the edge that matches the direction of the step: api -> queue uses edge 0, queue -> api uses edge 6
  const pd = await mkv('recip-route', v => { addEdge(v, 'queue', 'api', 'ack'); v.traces.push({ title: 'Ack', trigger: 'A job is acknowledged.', steps: ['api', 'queue', 'api'].map((n, i) => ({ node: n, title: 'Hop ' + (i + 1), simple: 'Step ' + (i + 1) + '.', confidence: 'evidenced' })) }); });
  // breaks if the route ignores edge direction and draws the reply hop along the forward edge
  await t('R2: the route draws a reply hop along the reply edge, not the forward edge', async () => {
    await pd.locator('[data-tr="2"]').click(); await pd.keyboard.press('j'); await pd.keyboard.press('j'); await pd.waitForTimeout(300); eq(await pd.locator('#map .route').count(), 2, 'route segments');
    const fwd = await pathMid(pd, '#map .edge[data-ei="0"] .hitarea'), rev = await pathMid(pd, '#map .edge[data-ei="6"] .hitarea');
    const r1 = await pathMid(pd, '#routeLayer .route', 0), r2 = await pathMid(pd, '#routeLayer .route', 1);
    if (dist(r1, fwd) > 8) throw new Error('first hop is ' + dist(r1, fwd).toFixed(1) + 'px from the forward edge'); if (dist(r2, rev) > 8) throw new Error('reply hop is ' + dist(r2, rev).toFixed(1) + 'px from the reply edge'); });
  await pd.close();
}

{ // 2 (QA3, QA5) J and K move exactly one stop, from the current stop, and clear transient highlights
  const pj = await mkv('jk', null, 1440, 900);
  const seq = async keys => { const seen = []; for (const k of keys) { await pj.keyboard.press(k); await pj.waitForTimeout(350); seen.push(await hereStop(pj)); } return seen.join(','); };
  // breaks if several visible stops let the scroll observer override the stop J just moved to (J from stop 1 used to land on 3)
  await t('QA3: J J J visits stops 2, 3, 4 and K K K walks back one at a time', async () => {
    eq(await seq(['j', 'j', 'j']), '1,2,3', 'forward'); eq(await seq(['j']), '3', 'J at the last stop stays'); eq(await seq(['k', 'k', 'k']), '2,1,0', 'backward'); eq(await seq(['k']), '0', 'K at the first stop stays'); });
  await t('QA3: the stop J lands on is scrolled into view', async () => {
    await seq(['j', 'j']); const r = await pj.evaluate(() => { const b = document.getElementById('stop-2').getBoundingClientRect(); return b.top < innerHeight && b.bottom > 0; }); eq(r, true, 'stop 3 visible'); });
  // breaks if J/K leave a selected connection, a marked node or painted damage on the map, so the route is not shown
  await t('QA5: J clears a selected connection, a mark and painted damage', async () => {
    await clickEdge(pj, 0); eq(await sel(pj), '0', 'edge selected'); await pj.keyboard.press('j'); await pj.waitForTimeout(350); eq(await sel(pj), '', 'edge cleared'); eq(await pj.locator('#nodeNote').isHidden(), true, 'edge note closed');
    await pj.evaluate(() => document.getElementById('s-invariants').scrollIntoView()); await pj.locator('.inv [data-mark]').first().click(); eq(await pj.locator('#map .node.marked').count(), 1, 'marked'); await pj.keyboard.press('k'); await pj.waitForTimeout(350); eq(await pj.locator('#map .node.marked').count(), 0, 'mark cleared');
    await pj.evaluate(() => document.getElementById('s-break').scrollIntoView()); await pj.locator('[data-run="0"]').click(); await pj.locator('[data-show="0"]').click(); eq(await pj.locator('#map .node.hit').count(), 2, 'damage'); await pj.keyboard.press('j'); await pj.waitForTimeout(350);
    eq(await pj.locator('#map .node.hit, #map .node.origin').count(), 0, 'damage cleared'); if (!(await hint(pj)).startsWith('The teal line is')) throw new Error('hint: ' + await hint(pj)); });
  await pj.close();
}

{ // F7: J/K clamp first, and the J hold only covers scrolling WE caused
  const pw7 = await mkv('jkwheel', null, 1440, 900);
  // breaks if the scroll listener keeps the programmatic-navigation hold alive on the user's own wheel scroll: the observer then ignores every stop crossed and the step stays at 1
  await t('F7: J then a manual wheel scroll leaves the step on the stop under the reading band', async () => {
    await pw7.keyboard.press('j'); eq(await hereStop(pw7), '1', 'J moved to stop 1');
    for (let k = 0; k < 14; k++) { await pw7.mouse.wheel(0, 70); await pw7.waitForTimeout(40); } await pw7.waitForTimeout(600);
    const band = await pw7.evaluate(() => { const hi = innerHeight * .42; const s = [...document.querySelectorAll('.stop')].filter(el => el.getBoundingClientRect().top <= hi); return s.at(-1)?.dataset.i; }); // the observer rule: the last stop that has entered the band
    eq(band, '3', 'the stop under the band'); eq(await hereStop(pw7), '3', 'the active stop');  });
  await pw7.close();
  const pc7 = await mkv('jkclamp', null, 1440, 900);
  const dmg = async pg => { await pg.evaluate(() => document.getElementById('s-break').scrollIntoView()); if (await pg.locator('[data-run="0"]').count()) await pg.locator('[data-run="0"]').click(); await pg.locator('[data-show="0"]').click(); eq(await pg.locator('#map .node.hit').count(), 2, 'damage painted'); };
  // breaks if K at the first stop (nothing moves) still wipes painted damage / a mark
  await t('F7: K at the first stop keeps painted damage and a mark', async () => {
    await dmg(pc7); eq(await hereStop(pc7), '0', 'on the first stop'); await pc7.keyboard.press('k'); await pc7.waitForTimeout(350); eq(await pc7.locator('#map .node.hit').count(), 2, 'damage kept');
    await pc7.evaluate(() => document.getElementById('s-invariants').scrollIntoView()); await pc7.locator('.inv [data-mark]').first().click(); eq(await pc7.locator('#map .node.marked').count(), 1, 'marked'); await pc7.keyboard.press('k'); await pc7.waitForTimeout(350); eq(await pc7.locator('#map .node.marked').count(), 1, 'mark kept'); });
  // breaks if J at the last stop still wipes painted damage
  await t('F7: J at the last stop keeps painted damage', async () => {
    for (let k = 0; k < 3; k++) { await pc7.keyboard.press('j'); await pc7.waitForTimeout(350); } eq(await hereStop(pc7), '3', 'on the last stop'); await dmg(pc7); eq(await hereStop(pc7), '3', 'still the last stop');
    await pc7.keyboard.press('j'); await pc7.waitForTimeout(350); eq(await pc7.locator('#map .node.hit').count(), 2, 'damage kept'); });
  await pc7.close();
}

{ // 3 (QA4, R7) one highlight at a time, and the hint says what the map paints
  const ph = await mkv('onehl', null, 1440, 900);
  // breaks if marking a node leaves the selected connection (and its Interfaces row) painted, so two highlights show at once
  await t('QA4: show-on-map replaces a selected connection', async () => {
    await clickEdge(ph, 1); eq(await sel(ph), '1', 'selected'); eq(await ph.locator('#s-interfaces tr.on').count(), 1, 'row on');
    await ph.locator('.inv [data-mark]').first().click(); await ph.waitForTimeout(150); eq(await sel(ph), '', 'edge'); eq(await ph.locator('#s-interfaces tr.on').count(), 0, 'row'); eq(await ph.locator('#map .node.marked').count(), 1, 'marked');
    if (!(await hint(ph)).startsWith('Yellow marks')) throw new Error(await hint(ph)); eq(await ph.locator('#nodeNote').isHidden(), true, 'edge note closed'); });
  // breaks if selecting a connection leaves the yellow mark painted
  await t('QA4: selecting a connection clears a mark', async () => {
    await clickEdge(ph, 2); eq(await ph.locator('#map .node.marked').count(), 0, 'mark'); eq(await sel(ph), '2', 'edge'); if (!(await hint(ph)).startsWith('The thick teal arrow')) throw new Error(await hint(ph)); });
  // breaks if the failure-mode damage view keeps the selected connection painted
  await t('QA4: showing damage replaces a selected connection', async () => {
    await ph.locator('[data-run="0"]').click(); await ph.locator('[data-show="0"]').click(); await ph.waitForTimeout(150); eq(await sel(ph), '', 'edge'); eq(await ph.locator('#s-interfaces tr.on').count(), 0, 'row');
    eq(await ph.locator('#map .node.hit').count(), 2, 'damage'); if (!(await hint(ph)).startsWith('Pink shows what')) throw new Error(await hint(ph)); });
  // breaks if clicking a node leaves a stale yellow mark beside the node you just opened
  await t('QA4: opening a node clears a mark', async () => {
    await ph.locator('.inv [data-mark]').first().click(); eq(await ph.locator('#map .node.marked').count(), 1, 'marked'); await ph.locator('#map .node[data-id="api"]').click(); eq(await ph.locator('#map .node.marked').count(), 0, 'mark cleared'); });
  // breaks if selecting a connection erases the damage of a failure mode without saying so, or if impact mode hint and map disagree
  await t('QA4: selecting a connection in impact mode keeps the impact view and its hint', async () => {
    await ph.locator('#map .node[data-id="store"]').click(); await ph.locator('#showImpact').click(); await clickEdge(ph, 0); eq(await ph.locator('#map .node.hit').count(), 4, 'hits');
    eq(await sel(ph), '', 'a selected connection is not painted over the impact view'); if (!(await hint(ph)).startsWith('Pink shows everything that depends on')) throw new Error(await hint(ph)); });
  await ph.close();
}

{ // 4 (QA2) the Interfaces table must not be clipped by its card
  for (const [name, base] of [['arch-mini', fixture], ['arch-dense', dense]]) for (const w of [768, 920, 1024, 1440]) {
    const pi = await mkv(`iface-${name}-${w}`, null, w, 900, 'light', base);
    // breaks if the table is wider than its card (overflow:hidden then cuts the Guarantee column off)
    await t(`QA2: interfaces table is not clipped (${name} at ${w}px)`, async () => {
      await pi.evaluate(() => document.getElementById('s-interfaces').scrollIntoView()); await pi.waitForTimeout(150);
      const m = await pi.evaluate(() => { const c = document.querySelector('.iface-card'), tb = c.querySelector('table'); return { card: c.clientWidth, cardScroll: c.scrollWidth, table: Math.round(tb.getBoundingClientRect().width), right: Math.round(tb.getBoundingClientRect().right - c.getBoundingClientRect().right) }; });
      if (m.cardScroll > m.card || m.table > m.card || m.right > 1) throw new Error(JSON.stringify(m)); });
    if (w === 768 && name === 'arch-dense') { await pi.evaluate(() => document.getElementById('s-interfaces').scrollIntoView()); await pi.waitForTimeout(150); await pi.screenshot({ path: 'f2-interfaces-768.png' }); }
    await pi.close();
  }
}

{ // 5 invariants: the rule reads as body text, and evidence says where it is checked
  const rule2 = 'Only the worker writes thumbnails. Readers must never see a half-written file or a stale one.'; // 2 sentences, under 120 characters
  const pv = await mkv('inv390', v => { v.invariants[0].rule = rule2; v.invariants[0].evidence = 'tests/test_thumbnails.py::test_single_writer'; }, 390, 844);
  // breaks if the rule is a huge bold heading again: a 2-sentence rule must take at most 4 lines and be normal weight
  await t('invariants: a 2-sentence rule is body text of at most 4 lines at 390px', async () => {
    const m = await pv.evaluate(() => { const h = document.querySelector('.inv h3'), cs = getComputedStyle(h), lh = parseFloat(cs.lineHeight); const stamp = h.querySelector('.stamp'); const clone = h.cloneNode(true); clone.querySelector('.stamp')?.remove(); document.body.append(clone); clone.style.cssText = 'position:absolute;visibility:hidden;width:' + h.clientWidth + 'px'; const lines = Math.round(clone.getBoundingClientRect().height / lh); clone.remove(); return { weight: cs.fontWeight, size: parseFloat(cs.fontSize), lines, stamp: !!stamp }; });
    eq(m.weight, '400', 'weight'); if (m.size > 21) throw new Error('font-size ' + m.size); if (m.lines > 4) throw new Error('lines ' + m.lines); });
  // breaks if the evidence field is dropped, or shown without its label, or shown for invariants that have none
  await t('invariants: evidence shows as "Enforced by:" under the rule, only where given', async () => {
    eq(await flat(pv.locator('.inv .ev').first()), 'Enforced by: tests/test_thumbnails.py::test_single_writer', 'evidence'); eq(await pv.locator('.inv .ev').count(), 1, 'only one invariant has evidence');
    eq(await flat(pv.locator('.inv .enf').first()), 'Enforced at Thumbnail worker', 'enforcer node line'); });
  await pv.evaluate(() => document.getElementById('s-invariants').scrollIntoView()); await pv.waitForTimeout(200); await pv.screenshot({ path: 'f2-invariants-390.png' });
  await pv.close();
}

{ // 6 (R3) focus survives the redraw that the map note opening triggers
  const pf = await mkv('focus', null, 1440, 900);
  // breaks if the map redraw drops keyboard focus, so a keyboard user must tab back to the edge after every Enter
  await t('R3: Enter on a focused edge keeps focus on that edge, and on a node', async () => {
    await pf.locator('#map .edge[data-ei="2"]').focus(); await pf.keyboard.press('Enter'); await pf.waitForTimeout(700);
    eq(await pf.evaluate(() => document.activeElement?.dataset?.ei), '2', 'edge keeps focus');
    await pf.locator('#map .node[data-id="queue"]').focus(); await pf.keyboard.press('Enter'); await pf.waitForTimeout(700);
    eq(await pf.evaluate(() => document.activeElement?.dataset?.id), 'queue', 'node keeps focus'); });
  await pf.close();
}

{ // 7 (R4) glossary matching works on the raw text, never on entities, and an empty term matches nothing
  const pg = await mkv('gloss', v => { v.glossary = [{ term: 'amp', def: 'A unit.' }, { term: 'lt', def: 'Less than.' }, { term: '', def: 'Nothing.' }]; v.nodes[0].simple = 'Fan-in & fan-out, a < b, "quoted" and \'single\'.'; v.nodes[1].simple = 'Plug in an amp, then check the LT sign.'; });
  // breaks if the glossary matches inside &amp; / &lt; / &quot; entities (the page then shows raw entity text or broken markup)
  await t('R4: glossary terms amp and lt do not match inside escaped characters', async () => {
    await pg.locator('#map .node[data-id="api"]').click(); await pg.locator('#nodeNote h3', { hasText: 'Upload API' }).waitFor({ timeout: 2000 });
    eq(await flat(pg.locator('#nodeNote .narr')), 'Fan-in & fan-out, a < b, "quoted" and \'single\'.', 'text'); eq(await pg.locator('#nodeNote .narr .term').count(), 0, 'term spans'); });
  // breaks if real term matching stopped working, or an empty term wraps every word boundary in an empty span
  await t('R4: real terms still match (case-insensitive) and an empty term matches nothing', async () => {
    await pg.locator('#map .node[data-id="queue"]').click(); await pg.locator('#nodeNote h3', { hasText: 'Job queue' }).waitFor({ timeout: 2000 });
    eq(await pg.locator('#nodeNote .narr .term').allInnerTexts().then(l => l.join('|')), 'amp|LT', 'terms'); eq(await pg.locator('.term:empty').count(), 0, 'empty spans'); });
  await pg.close();
}

{ // 8 untrusted strings are text everywhere they are shown
  const X = '<img src=x onerror="window.__pwn=1">';
  const px = await mkv('xss', v => { v.nodes[0].label = 'Evil ' + X; v.edges[0].protocol = 'P ' + X; v.edges[0].payload = 'Q ' + X; v.edges[0].label = 'L ' + X; v.invariants[0].rule = 'Rule ' + X; v.invariants[0].evidence = 'Ev ' + X; v.invariants[0].breaks = 'B ' + X; v.pressure[0].title = 'T ' + X; v.traces[0].steps[0].title = 'S ' + X; });
  // breaks if a node label, edge protocol, invariant rule or evidence is ever put into innerHTML unescaped
  await t('escaping: node label, edge protocol, invariant rule and evidence render as text', async () => {
    await px.locator('#map .edge[data-ei="0"]').focus(); await px.keyboard.press('Enter'); await px.waitForTimeout(300); await px.locator('#map .node').first().click(); await px.waitForTimeout(300);
    eq(await px.evaluate(() => document.querySelectorAll('main img, aside img, svg image').length), 0, 'injected img elements'); eq(await px.evaluate(() => typeof window.__pwn), 'undefined', '__pwn');
    const x = await px.evaluate(() => document.querySelector('.inv').innerText); for (const w of ['Rule <img src=x onerror="window.__pwn=1">', 'Ev <img src=x onerror="window.__pwn=1">']) if (!x.includes(w)) throw new Error('not shown as text: ' + w); });
  await px.close();
}

{ // 8 empty maps
  const noNodes = v => { v.nodes = []; v.edges = []; v.traces = []; v.whatifs = []; v.invariants = []; v.pressure = []; };
  const before = errs.length;
  const pe = await mkv('empty-arch', noNodes, 1280, 800);
  // breaks if an architecture lesson with no nodes shows a lone "The map" heading over an empty drawing
  await t('empty: an architecture lesson with no nodes says so instead of showing an empty map', async () => {
    eq(await pe.locator('#s-map #map').count(), 0, 'no svg'); const x = await flat(pe.locator('#s-map')); if (!/The map/.test(x) || x.length < 30) throw new Error('no friendly note: ' + x);
    eq(await pe.locator('#s-map .empty-map').count(), 1, 'note'); eq(await pe.locator('#mapMode').count(), 0, 'no map-mode buttons'); });
  const pc2 = await mkv('empty-code', v => { noNodes(v); delete v.mode; }, 1280, 800);
  // breaks if a code lesson with no nodes keeps an empty "The map" heading and rail entry, or throws
  await t('empty: a code lesson with no nodes hides the map section and still works', async () => {
    eq(await pc2.locator('#s-map').isHidden(), true, 'map hidden'); eq((await railNames(pc2)).includes('The map'), false, 'rail'); await pc2.keyboard.press('j'); await pc2.keyboard.press('k'); eq(await pc2.locator('#s-quiz .qcard').count(), 1, 'quiz still renders'); });
  await t('empty: no page errors for lessons without nodes', async () => { eq(errs.slice(before).join('|'), '', 'errors'); });
  await pe.close(); await pc2.close();
}

console.log('errors:', errs.length ? errs : 'none'); console.log('screenshots:', shots);
await b.close();
process.exit(failed || errs.length ? 1 : 0);
