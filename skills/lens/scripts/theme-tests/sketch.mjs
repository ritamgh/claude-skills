// Regression suite for assets/themes/sketch.html, run by scripts/test-template.mjs against the worked example
// (examples/jw-ask-flow.json: 7 nodes, 7 edges, 9 stops, gates at stops 3 and 5, 4 quiz questions).
import { getChromium } from '../pw.mjs';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'; import { tmpdir } from 'os'; import { join, dirname } from 'path'; import { fileURLToPath } from 'url'; import { execFileSync } from 'child_process';
const url = 'file://' + process.argv[2];
const shots = mkdtempSync(join(tmpdir(), 'lens-sketch-')); process.chdir(shots);
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
await p.screenshot({ path: 's1-start.png' });
await t('J moves stops and the route grows', async () => { await p.keyboard.press('j'); await p.keyboard.press('j'); await p.waitForTimeout(300);
  eq(await active(), 'ask', 'active'); eq(await p.locator('#map .route').count(), 2, 'route segs'); eq(await p.locator('.stops li.done').count(), 2, 'rail ticks'); });
await t('gate blurs narrative, keeps code, masks new values', async () => { eq(await p.locator('#stop-2 .blurred').count(), 1, 'blurred');
  eq(await p.locator('#stop-2 figure.code').count(), 1, 'code'); eq(await p.locator('#stop-2 .mv.masked').count(), 2, 'masked'); });
await p.screenshot({ path: 's2-gate.png' });
await t('number key answers the current gate', async () => { await p.keyboard.press('2'); eq(await p.locator('#stop-2 .choice.right').count(), 1, 'right');
  eq(await p.locator('#stop-2 .blurred').count(), 0, 'unblurred'); eq(await p.locator('#stop-2 .mv.masked').count(), 0, 'unmasked'); });
await t('deep toggle swaps the text', async () => { await p.locator('#depth button[data-d="deep"]').click(); const x = await p.locator('#stop-2 .narr').innerText(); if (!x.includes('shift 2')) throw new Error(x.slice(0, 60)); });
await t('rail link jumps to a stop', async () => { await p.locator('[data-lens-stop="4"]').click(); await p.waitForTimeout(300); eq(await active(), 'invoke', 'active'); });
await t('component note opens under the map', async () => { await p.locator('#map .node[data-id="ledger"]').click(); await p.locator('#nodeNote h3', { hasText: 'Ledger' }).waitFor({ timeout: 2000 }); });
await t('show impact paints dependents', async () => { await p.locator('#showImpact').click(); eq(await p.locator('#map .node.origin').count(), 1, 'origin'); eq(await p.locator('#map .node.hit').count(), 4, 'hits'); });
await p.screenshot({ path: 's3-impact.png' });
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
  await p.screenshot({ path: 's4-quiz.png' }); await p.reload(); await p.locator('.score').waitFor({ timeout: 2000 }); });
await t('restart, a miss shows as a red pip', async () => { await p.locator('#restart').click(); await toQuiz(); await p.keyboard.press('2'); eq(await p.locator('.pip.wrong').count(), 1, 'wrong pip'); });
await t('resume banner after reload', async () => { await p.reload(); await p.waitForTimeout(300); eq(await p.locator('#resumeBtn').count(), 1, 'resume'); });
await t('theme toggle persists', async () => { await p.locator('#themeBtn').click(); await p.reload(); eq(await p.evaluate(() => document.documentElement.dataset.theme), 'dark', 'theme'); await p.evaluate(() => localStorage.clear()); });
await t('desktop no horizontal scroll', async () => { const w = await p.evaluate(() => document.documentElement.scrollWidth); if (w > 1440) throw new Error('scrollWidth ' + w); });
const d = await mk(1920, 1080, 'dark'); await d.screenshot({ path: 's5-dark.png' });
const m = await mk(390, 844, 'light');
await t('mobile no horizontal scroll', async () => { const w = await m.evaluate(() => document.documentElement.scrollWidth); if (w > 390) throw new Error('scrollWidth ' + w); });
await m.screenshot({ path: 's6-mobile.png', fullPage: true });

// ---------- the sketch look (worked example) ----------
const RGB = { ink: 'rgb(17, 17, 17)', chalk: 'rgb(236, 233, 225)', board: 'rgb(26, 28, 27)', red: 'rgb(217, 58, 43)', orange: 'rgb(232, 130, 12)', blue: 'rgb(43, 111, 217)' };
const here = dirname(fileURLToPath(import.meta.url)), lensRoot = join(here, '..', '..');
const themeSrc = readFileSync(join(lensRoot, 'assets', 'themes', 'sketch.html'), 'utf8');
const scenes = pg => pg.evaluate(() => [...document.querySelectorAll('svg.lens-scene')].map(s => s.getAttribute('aria-label')));
const blotFill = pg => pg.evaluate(() => getComputedStyle(document.querySelector('#heroMascot svg path[style^="fill:var(--blot,"]')).fill);
const strokeOf = (pg, sel) => pg.evaluate(s => getComputedStyle(document.querySelector(s)).stroke, sel);
const lp = await mk(1440, 960, 'light');
// breaks if the zine paper (cream colour, dot grid) or a shadow comes back on the page
await t('sketch: pure white page, no texture, no shadow', async () => {
  const bs = await lp.evaluate(() => { const c = getComputedStyle(document.body); return [c.backgroundColor, c.backgroundImage, c.boxShadow].join(' | '); });
  eq(bs, 'rgb(255, 255, 255) | none | none', 'body'); });
// breaks if a zine rule is carried over: gradients (highlighter swipes), shadows, zine's hard-coded hexes, or unseeded jitter
await t('sketch: no gradients, shadows, zine colours or Math.random in the theme source', async () => {
  for (const bad of ['gradient', 'box-shadow', 'Math.random', 'Permanent Marker', 'Shantell', '#1B1A17', '#FFD84D', '#1FA898', '#E0458A', '#7CC8F0', '#FFF3B0', '#3B3520', '#FFE47A', 'rgba(60,48,20', 'rgba(189,237,229'])
    if (themeSrc.includes(bad)) throw new Error('theme source contains ' + bad); });
// breaks if the Caveat link is dropped or headings fall back to another face
await t('sketch: Caveat is loaded for headings and handwriting', async () => {
  eq(themeSrc.includes('family=Caveat:wght@400;700'), true, 'font link');
  eq(await lp.evaluate(() => getComputedStyle(document.querySelector('h2')).fontFamily.split(',')[0]), 'Caveat', 'h2 face'); });
// breaks if zine's magnifier mascot survives anywhere instead of Blot (header, rail, both guess gates)
await t('sketch: Blot replaces the mascot in header, rail and gates', async () => {
  eq(await lp.locator('#heroMascot svg[aria-label="Blot"]').count(), 1, 'hero'); eq(await lp.locator('.rail-brand svg[aria-label="Blot"]').count(), 1, 'rail');
  eq(await lp.locator('.turn .masc svg[aria-label="Blot"]').count(), 2, 'gates'); eq(await lp.locator('svg[viewBox="0 0 100 100"]').count(), 0, 'magnifier'); });
// breaks if --blot / --ink stop reaching the scene library in the light palette
await t('sketch: Blot is drawn in ink on white', async () => { eq(await blotFill(lp), RGB.ink, 'blot fill'); });
// breaks if the defaults (whatif fire, decision fork, risk watch) are not applied, or steps/nodes get a picture without a scene
await t('sketch: the worked example shows its 8 default scenes and no others', async () => {
  eq((await scenes(lp)).join(','), 'fire scene,fire scene,fire scene,fork scene,fork scene,watch scene,watch scene,watch scene', 'scenes');
  eq(await lp.locator('#s-trip svg.lens-scene, #nodeNote svg.lens-scene').count(), 0, 'no step scenes');
  eq(await lp.locator('figure.plate.quiet svg.lens-scene').count(), 8, 'default plates are the quiet size'); });
// breaks if the route is not the blue line, or the current stop loses its red hand-drawn circle
await t('sketch: route is blue, the current stop gets a red circle', async () => {
  await lp.keyboard.press('j'); await lp.keyboard.press('j'); await lp.waitForTimeout(300);
  eq(await strokeOf(lp, '#map .route'), RGB.blue, 'route');
  eq(await lp.evaluate(() => [...document.querySelectorAll('#map .node .circ')].filter(c => getComputedStyle(c).opacity !== '0').map(c => c.closest('.node').dataset.id).join(',')), 'ask', 'circled');
  eq(await strokeOf(lp, '#map .node.active .circ'), RGB.red, 'circle colour'); });
// breaks if impact and damage share one colour again: impact (what depends on it) is orange, damage (break it) is red
await t('sketch: impact paints orange, damage paints red', async () => {
  await lp.locator('#map .node[data-id="ledger"]').click(); await lp.locator('#showImpact').click(); eq(await strokeOf(lp, '#map .node.hit .stroke'), RGB.orange, 'impact');
  await lp.locator('#mapMode button[data-m="route"]').click(); await lp.locator('[data-run="0"]').click(); await lp.locator('[data-show="0"]').click();
  eq(await strokeOf(lp, '#map .node.hit .stroke'), RGB.red, 'damage'); });
// breaks if the dark palette is not a blackboard or Blot keeps its black body on it
await t('sketch dark: blackboard page and a chalk-coloured Blot', async () => {
  eq(await d.evaluate(() => getComputedStyle(document.body).backgroundColor), RGB.board, 'board'); eq(await blotFill(d), RGB.chalk, 'blot fill'); });
// ---------- architecture mode (scripts/testdata/arch-mini.json: 5 nodes, 6 edges of which 3 async, 2 flows of 4 + 3 stops,
// 3 invariants, 2 pressure points, 2 failure modes, 2 decisions, 1 risk, 4 quiz questions) ----------
const fixture = JSON.parse(readFileSync(join(lensRoot, 'scripts', 'testdata', 'arch-mini.json'), 'utf8'));
const buildLesson = (name, lesson) => { const src = join(shots, name + '.json'), out = join(shots, name + '.html'); writeFileSync(src, JSON.stringify(lesson));
  execFileSync('python3', [join(lensRoot, 'scripts', 'build.py'), src, out, '--theme', 'sketch'], { stdio: 'pipe' }); return 'file://' + out; };
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
// breaks if steps without code or state still draw an empty code card or a "nothing stored" memory note
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
// breaks if a section stops drawing its scene, a default (invariant gate, pressure queue, whatif fire, decision fork) is lost,
// a caption is not taken from the item's scene, or a node scene leaks onto the page before its note is opened
await t('arch scenes: 11 scenes in reading order with their captions', async () => {
  eq((await scenes(a)).join(' | '), 'carry: id out, job queued | wall: one writer only | gate scene | gate scene | queue: line out the door | queue scene | fire: crash, then redeliver | fire scene | fork: now or later | fork scene | watch: who checks the dial?', 'scenes');
  eq(await a.locator('figure.plate:not(.quiet) svg.lens-scene').count(), 6, 'authored scenes get the full plate'); });
// breaks if the step scene lands on the wrong stop, below the narrative, or on top of the code card
await t('arch scenes: the step scene sits on stop 1, above its narrative and code', async () => {
  eq(await a.locator('#stop-0 svg.lens-scene').getAttribute('data-scene'), 'carry', 'stop 1'); eq(await a.locator('#stop-1 svg.lens-scene, #stop-2 svg.lens-scene, #stop-3 svg.lens-scene').count(), 0, 'other stops');
  const [pl, narr, code] = await a.evaluate(() => ['.plate', '.narr', 'figure.code'].map(s => document.querySelector('#stop-0 ' + s).getBoundingClientRect()).map(r => [r.top, r.bottom]));
  if (!(pl[1] <= narr[0] && narr[1] <= code[0])) throw new Error(`order plate ${pl} narr ${narr} code ${code}`); });
// breaks if a whatif without a scene gets no picture (the default is fire) or an authored one is replaced by the default
await t('arch scenes: a failure mode without a scene shows the default fire', async () => {
  eq(await a.locator('.exp').nth(0).locator('svg.lens-scene').getAttribute('aria-label'), 'fire: crash, then redeliver', 'authored');
  eq(await a.locator('.exp').nth(1).locator('svg.lens-scene').getAttribute('aria-label'), 'fire scene', 'default'); });
// breaks if the picture box is not reserved (16:9) so content jumps, or the plate grows past its cap
await t('arch scenes: every plate is a 16:9 box no wider than 560px', async () => {
  const bad = await a.evaluate(() => [...document.querySelectorAll('figure.plate')].map(f => f.getBoundingClientRect()).filter(r => r.width > 560.5 || Math.abs(r.height / r.width - .5625) > .01).map(r => `${r.width}x${r.height}`));
  eq(bad.join(','), '', 'odd plates'); });
// breaks if node scenes are not shown in the component note, or a node without one gets a picture
await t('arch scenes: a node scene shows in its component note only', async () => {
  await a.locator('#map .node[data-id="api"]').click(); await a.locator('#nodeNote h3', { hasText: 'Upload API' }).waitFor({ timeout: 2000 });
  eq(await a.locator('#nodeNote svg.lens-scene').getAttribute('aria-label'), 'gate: check, then wave through', 'api');
  await a.locator('#map .node[data-id="cdn"]').click(); await a.locator('#nodeNote h3', { hasText: 'CDN' }).waitFor({ timeout: 2000 }); eq(await a.locator('#nodeNote figure.plate:not(.ctx)').count(), 0, 'cdn has no scene plate'); });
await a.locator('#map .node[data-id="api"]').click(); await a.waitForTimeout(200); await a.screenshot({ path: 'a0-arch-node-scene.png' });
// breaks if switching flows keeps the previous flow's step scenes
await t('arch scenes: the second flow has no step scenes', async () => {
  await a.locator('#s-trip .tabs button').nth(1).click(); eq(await a.locator('#s-trip svg.lens-scene').count(), 0, 'flow 2');
  await a.locator('#s-trip .tabs button').nth(0).click(); eq(await a.locator('#s-trip svg.lens-scene').count(), 1, 'flow 1'); });
// breaks if the quiz or terms stop working in architecture mode
await t('arch: quiz and glossary still work', async () => { eq(await a.locator('#s-quiz .pip').count(), 4, 'pips'); eq(await a.locator('#s-terms dt').count(), 2, 'terms'); });
await a.evaluate(() => document.getElementById('s-interfaces')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a2-arch-interfaces.png' });
await a.evaluate(() => document.getElementById('s-invariants')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a3-arch-invariants.png' });
await a.evaluate(() => document.getElementById('s-pressure')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a4-arch-pressure.png' });
await a.evaluate(() => document.getElementById('s-why')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a5-arch-decisions.png' });
await a.evaluate(() => document.getElementById('stop-0')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a5b-arch-step-scene.png' });
await a.evaluate(() => document.getElementById('s-break')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a5c-arch-failures.png' });
await a.evaluate(() => document.getElementById('s-weak')?.scrollIntoView({ block: 'start' })); await a.waitForTimeout(200); await a.screenshot({ path: 'a5d-arch-weak.png' });
await a.evaluate(() => scrollTo(0, 0)); await a.locator('#map .node[data-id="queue"]').click(); await a.waitForTimeout(300); await a.screenshot({ path: 'a6-arch-node.png' });
await clickEdge(a, 0); await a.waitForTimeout(300); await a.screenshot({ path: 'a7-arch-edge.png' });


// ---------- lens-specific pictures: slots on scenes, node.prop and the context plate (scripts/testdata/arch-ctx.json:
// 7 nodes; `engine` is a hub with 3 inputs and 2 outputs, `notes` has no edges, `events.db` has an authored scene with slots) ----------
const ctxFixture = JSON.parse(readFileSync(join(lensRoot, 'scripts', 'testdata', 'arch-ctx.json'), 'utf8'));
const ctxUrl = buildLesson('arch-ctx', ctxFixture);
const hasContext = await a.evaluate(() => typeof LensScenes.context === 'function'); // false only while the scene library predates the context plate
const svgText = loc => loc.evaluate(el => [...el.querySelectorAll('text')].map(t => t.textContent).join(' | '));
const openNodeNote = async (pg, id, label) => { await pg.locator(`#map .node[data-id="${id}"]`).click(); await pg.locator('#nodeNote h3', { hasText: label }).waitFor({ timeout: 2000 }); };
const cx = await mk(1440, 960, 'light', ctxUrl);
// breaks if a node without a scene opens with no picture of where it sits, or the plate is not the first thing in the note, or the
// hub's neighbours and edge payloads are not drawn as readable text (more than 2 a side must collapse to "+N more")
await t('ctx: a node with no scene opens with a context plate first, naming its neighbours and edge payloads', async () => {
  await openNodeNote(cx, 'engine', 'engine');
  eq(await cx.locator('#nodeNote figure.plate.ctx svg').count(), 1, 'one context plate'); eq(await cx.locator('#nodeNote figure.plate:not(.ctx)').count(), 0, 'no scene plate');
  eq(await cx.evaluate(() => document.querySelector('#nodeNote .node-grid > div > :first-child').className), 'plate ctx', 'first thing in the note');
  const txt = await svgText(cx.locator('#nodeNote figure.plate.ctx'));
  for (const want of ['engine', 'camera.py', 'mic.py', 'presence', 'mic in use', 'events.db', 'notifier', 'agent waiting', '+1 more']) if (!txt.includes(want)) throw new Error(`plate text lacks "${want}": ${txt}`);
  if (!txt.includes('+1 more | desktop.py')) throw new Error('a third input should collapse into "+1 more" and be named under it: ' + txt); });
await cx.screenshot({ path: 'c1-ctx-hub.png' });
// breaks if the plate is built once and not redrawn for the next node, or a neighbour is not looked up by edge direction
await t('ctx: the plate is recomputed for every node clicked', async () => {
  await openNodeNote(cx, 'camera', 'camera.py');
  let txt = await svgText(cx.locator('#nodeNote figure.plate.ctx')); for (const want of ['camera.py', 'engine', 'presence']) if (!txt.includes(want)) throw new Error(`camera plate lacks "${want}": ${txt}`);
  if (txt.includes('mic.py') || txt.includes('events.db')) throw new Error('camera plate shows the hub\'s other neighbours: ' + txt);
  await openNodeNote(cx, 'engine', 'engine'); txt = await svgText(cx.locator('#nodeNote figure.plate.ctx')); if (!txt.includes('mic.py')) throw new Error('hub plate did not come back: ' + txt); });
// breaks if a node with no edges throws, draws nothing, or is shown as if it had neighbours
await t('ctx: a node with no edges still gets a plate with its own name and no "more"', async () => {
  await openNodeNote(cx, 'notes', 'NOTES.md'); eq(await cx.locator('#nodeNote figure.plate.ctx svg').count(), 1, 'plate');
  const txt = await svgText(cx.locator('#nodeNote figure.plate.ctx')); if (!txt.includes('NOTES.md')) throw new Error('no title: ' + txt); if (txt.includes('more')) throw new Error('lone node claims neighbours: ' + txt); });
// breaks if an authored node scene is replaced by the context plate, or its items/props never reach the drawing
await t('ctx: an authored node scene wins, and its slot labels are drawn as text', async () => {
  await openNodeNote(cx, 'store', 'events.db'); eq(await cx.locator('#nodeNote figure.plate.ctx').count(), 0, 'no context plate');
  eq(await cx.locator('#nodeNote svg.lens-scene').getAttribute('data-scene'), 'store', 'authored scene');
  const txt = await svgText(cx.locator('#nodeNote svg.lens-scene')); for (const want of ['state change', 'events.db']) if (!txt.includes(want)) throw new Error(`scene lacks "${want}": ${txt}`); });
// breaks if a step scene's items/props are dropped on the way to the renderer
await t('ctx: a step scene carries its items and props to the drawing', async () => {
  const txt = await svgText(cx.locator('#stop-0 svg.lens-scene')); for (const want of ['presence: away', 'camera.py', 'engine']) if (!txt.includes(want)) throw new Error(`step scene lacks "${want}": ${txt}`); });
// breaks if the plate leaves architecture mode, or an item/label/neighbour name is put in as markup instead of text
{ const code = JSON.parse(JSON.stringify(ctxFixture)); delete code.mode; const pcode = await mk(1280, 900, 'light', buildLesson('ctx-asCode', code));
  await t('ctx: a code-mode lesson never shows the context plate', async () => { await openNodeNote(pcode, 'engine', 'engine'); eq(await pcode.locator('#nodeNote figure.plate.ctx').count(), 0, 'plate'); }); await pcode.close(); }
{ const evil = JSON.parse(JSON.stringify(ctxFixture)), bad = '<img src=x onerror=window.__x=1>';
  evil.nodes.find(n => n.id === 'store').scene.items = [bad]; evil.nodes.find(n => n.id === 'store').scene.props = [{ prop: 'database', label: '"><script>window.__x=2</script>' }];
  evil.nodes.find(n => n.id === 'camera').label = '<i onclick=window.__x=3>cam'; evil.edges[0].payload = '<b onmouseover=1>p</b>';
  const px = await mk(1280, 900, 'light', buildLesson('ctx-xss', evil));
  await t('ctx: an XSS string in an item, a prop label, a neighbour name or a payload stays text', async () => {
    await openNodeNote(px, 'store', 'events.db'); await openNodeNote(px, 'engine', 'engine');
    eq(await px.evaluate(() => typeof window.__x), 'undefined', 'script ran'); eq(await px.locator('#nodeNote img, #nodeNote script, #nodeNote svg b, #nodeNote svg i, #stop-0 svg img, #stop-0 svg script').count(), 0, 'injected elements');
    await openNodeNote(px, 'store', 'events.db'); if (!(await svgText(px.locator('#nodeNote svg.lens-scene'))).includes('<img')) throw new Error('the item text is not shown literally');
    if (hasContext) { await openNodeNote(px, 'engine', 'engine'); if (!(await svgText(px.locator('#nodeNote figure.plate.ctx'))).includes('<i onclick')) throw new Error('the neighbour name is not shown literally'); } });
  await px.close(); }
// breaks if the zine theme starts needing props.js/scenes.js, or chokes on slots, node.prop and a lone node
{ const zurl = (() => { const out = join(shots, 'arch-ctx-zine.html'); execFileSync('python3', [join(lensRoot, 'scripts', 'build.py'), join(lensRoot, 'scripts', 'testdata', 'arch-ctx.json'), out, '--theme', 'zine'], { stdio: 'pipe' }); return 'file://' + out; })();
  const pz = await mk(1280, 900, 'light', zurl);
  await t('ctx: zine ignores slots, node.prop and the context plate and still builds and opens every node', async () => {
    eq(await pz.locator('#map .node').count(), 7, 'nodes'); for (let i = 0; i < 7; i++) await pz.locator('#map .node').nth(i).click();
    eq(await pz.locator('svg.lens-scene, .plate').count(), 0, 'sketch pictures in zine'); eq(readFileSync(zurl.slice(7), 'utf8').includes('LensProps'), false, 'props.js in zine'); });
  await pz.close(); }
await cx.close();

// ---------- bespoke pictures: scene.draw (scripts/testdata/arch-draw.json: draw in node `limiter` (no name), node `api` (name gate + draw),
// step 1 and 2 (2 is behind a predict gate), a whatif and a risk) ----------
const drawFixture = JSON.parse(readFileSync(join(lensRoot, 'scripts', 'testdata', 'arch-draw.json'), 'utf8'));
const drawUrl = buildLesson('arch-draw', drawFixture);
const dx = await mk(1440, 960, 'light', drawUrl);
const hasDraw = await dx.evaluate(() => typeof LensScenes.draw === 'function'); // false only while the scene library predates draw()
if (!hasDraw) console.log('SKIP draw tests: LensScenes.draw is not in the scene library yet (X1 not landed); the fallback tests below still run');
const drawSvgs = pg => pg.evaluate(() => [...document.querySelectorAll('figure.plate svg')].map(s => s.getAttribute('data-scene') + '/' + (s.getAttribute('aria-label') || '').slice(0, 30)));
// breaks if sketch.html never calls LensScenes.draw for authored `draw`, or the labels are lost on the way to the picture
await t('draw: a node note, a step, a failure mode and a weak spot show their drawn pictures with the labels as text', async () => {
  if (!hasDraw) return;
  await openNodeNote(dx, 'limiter', 'Rate limiter'); eq(await dx.locator('#nodeNote figure.plate.ctx').count(), 0, 'the drawn node scene wins over the context plate');
  let txt = await svgText(dx.locator('#nodeNote figure.plate svg')); for (const want of ['token bucket', '429 slow down', '200 ok', 'takes one', 'refills at 10 tokens a second']) if (!txt.includes(want)) throw new Error(`node picture lacks "${want}": ${txt}`);
  txt = await svgText(dx.locator('#stop-0 figure.plate svg')); for (const want of ['30 calls', 'one second']) if (!txt.includes(want)) throw new Error(`step picture lacks "${want}": ${txt}`);
  txt = await svgText(dx.locator('#s-break figure.plate svg')); for (const want of ['limiter', 'counters', 'no answer']) if (!txt.includes(want)) throw new Error(`whatif picture lacks "${want}": ${txt}`);
  txt = await svgText(dx.locator('#s-weak figure.plate svg')); for (const want of ['10 a second', 'same key']) if (!txt.includes(want)) throw new Error(`risk picture lacks "${want}": ${txt}`);
  eq(await dx.locator('#stop-0 figure.plate').getAttribute('class'), 'plate cap', 'an authored picture is full size, not quiet'); });
await dx.locator('#map .node[data-id="limiter"]').click(); await dx.locator('#nodeNote').scrollIntoViewIfNeeded(); await dx.screenshot({ path: 'd1-draw-node.png' });
// breaks if a draw scene uses its `name` instead of the drawing (the gate scene for node `api` has the label "orders", the stock gate scene does not)
await t('draw: when name and draw are both given the drawing wins', async () => {
  if (!hasDraw) return;
  await openNodeNote(dx, 'api', 'Orders API'); const txt = await svgText(dx.locator('#nodeNote figure.plate svg'));
  if (!txt.includes('orders') || !txt.includes('allowed')) throw new Error('the drawing is not shown: ' + txt);
  if (await dx.locator('#nodeNote svg[data-scene="gate"]').count()) throw new Error('the stock gate scene was drawn instead'); });
// breaks if the blurred plate behind an unanswered predict gate leaks the drawing's labels to assistive tech or shows it unblurred
await t('draw: a drawn step behind a predict gate is blurred and hidden from assistive tech until answered', async () => {
  const sel = '#stop-1 figure.plate'; eq(await dx.locator(sel + '.blurred[aria-hidden="true"]').count(), 1, 'blurred plate');
  if (hasDraw) { const txt = await svgText(dx.locator(sel + ' svg')); if (!txt.includes('10 tokens')) throw new Error('gated drawing missing: ' + txt); } });
// A drawn picture has no caption inside the svg, so sketch.html writes it as handwriting under the plate.
const capOf = (pg, sel) => pg.evaluate(sel => { const f = document.querySelector(sel); if (!f) return null; const c = f.querySelector('figcaption'), sv = f.querySelector('svg'); if (!c) return { none: true, svgText: [...sv.querySelectorAll('text')].map(t => t.textContent).join(' | ') };
  const cb = c.getBoundingClientRect(), sb = sv.getBoundingClientRect(), fb = f.getBoundingClientRect(), cs = getComputedStyle(c);
  return { text: c.textContent, px: parseFloat(cs.fontSize), face: cs.fontFamily.split(',')[0], color: cs.color, below: cb.top >= sb.bottom - 0.5, inside: cb.bottom <= fb.bottom + 0.5 && cb.left >= -0.5 && cb.right <= innerWidth + 0.5, svgHasIt: [...sv.querySelectorAll('text')].some(t => t.textContent.includes(c.textContent)), hidden: c.closest('[aria-hidden="true"]') !== null, blurred: c.closest('.blurred') !== null, tag: c.tagName, last: f.lastElementChild === c }; }, sel);
// breaks if the caption of a drawn picture is never shown (the svg does not draw it), is not under the plate, is smaller than 16px, or not handwriting
await t('draw caption: shown as handwriting under the plate in a step, a node note, a failure mode and a weak spot', async () => {
  if (!hasDraw) return;
  await openNodeNote(dx, 'limiter', 'Rate limiter');
  for (const [sel, want] of [['#nodeNote figure.plate', 'tokens in, requests out'], ['#stop-0 figure.plate', 'thirty calls, one door'], ['#s-break figure.plate', 'no counts, no verdict'], ['#s-weak figure.plate', 'many people, one allowance']]) {
    const c = await capOf(dx, sel); if (!c || c.none) throw new Error(`${sel}: no caption under the plate`);
    eq(c.text, want, sel + ' text'); eq(c.tag, 'FIGCAPTION', sel); eq(c.last, true, sel + ' is the last child'); eq(c.below, true, sel + ' below the picture'); eq(c.inside, true, sel + ' inside the figure and the screen');
    eq(c.face, 'Caveat', sel + ' face'); if (c.px < 16) throw new Error(`${sel}: caption ${c.px}px`); eq(c.svgHasIt, false, sel + ': the svg must not repeat it'); eq(c.hidden, true, sel + ' hidden from assistive tech (the svg label has it)'); } });
// breaks if the caption leaks through the predict gate, i.e. is not blurred and hidden with its plate until the guess is made
await t('draw caption: behind an unanswered predict gate the caption is blurred and hidden with the plate, then shown after the guess', async () => {
  if (!hasDraw) return;
  let c = await capOf(dx, '#stop-1 figure.plate'); eq(c.text, 'ten pass, twenty wait', 'text'); eq(c.blurred, true, 'blurred'); eq(c.hidden, true, 'aria-hidden');
  await dx.locator('#stop-1 .choice').nth(1).click(); await dx.waitForTimeout(200);
  c = await capOf(dx, '#stop-1 figure.plate'); eq(c.text, 'ten pass, twenty wait', 'text after'); eq(c.blurred, false, 'unblurred after the guess'); });
// breaks if the caption is cut off, overflows, or is unreadable on a phone or on the blackboard
for (const [w, scheme] of [[390, 'light'], [390, 'dark'], [1440, 'dark']]) await t(`draw caption: readable and inside the screen at ${w} ${scheme}`, async () => {
  if (!hasDraw) return; const pg = await mk(w, 900, scheme, drawUrl);
  await openNodeNote(pg, 'limiter', 'Rate limiter');
  for (const sel of ['#nodeNote figure.plate', '#stop-0 figure.plate', '#s-break figure.plate']) { const c = await capOf(pg, sel); eq(c.inside, true, sel + ' inside'); eq(c.below, true, sel + ' below'); if (c.px < 16) throw new Error(`${sel}: ${c.px}px`);
    const rgb = c.color.match(/\d+/g).map(Number); const lum = rgb[0] + rgb[1] + rgb[2]; if (scheme === 'dark' ? lum < 400 : lum > 400) throw new Error(`${sel}: caption colour ${c.color} on ${scheme}`); }
  const sw = await pg.evaluate(() => document.documentElement.scrollWidth); if (sw > w) throw new Error('scrollWidth ' + sw); await pg.close(); });
// breaks if a broken or missing LensScenes.draw takes the page down, or the named scene is not the fallback, or a draw-only scene is not skipped
for (const [how, breakIt] of [['draw() throws', () => { LensScenes.draw = () => { throw new Error('boom'); }; }], ['draw() returns nothing', () => { LensScenes.draw = () => ''; }], ['draw() is missing', () => { delete LensScenes.draw; }]]) {
  await t(`draw: when ${how} the named scene is the fallback, draw-only scenes show no plate and nothing else breaks`, async () => {
    const fx = await b.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }); fx.on('pageerror', e => errs.push('pageerror: ' + e.message));
    await fx.goto(drawUrl); await fx.evaluate(() => localStorage.clear()); await fx.reload(); await fx.waitForTimeout(300);
    await fx.evaluate(breakIt); await fx.locator('#depth button[data-d="deep"]').click(); await fx.waitForTimeout(200);   // re-render the trip with the broken library
    eq(await fx.locator('#stop-0 figure.plate').count(), 0, 'a draw-only step shows no plate'); eq(await fx.locator('#stop-0 .narr').count(), 1, 'the step narrative is still there');
    await openNodeNote(fx, 'api', 'Orders API'); eq(await fx.locator('#nodeNote svg.lens-scene').getAttribute('data-scene'), 'gate', 'fallback to the named scene');
    eq(await fx.locator('#nodeNote figcaption').count(), 0, 'the fallback must not add a second, HTML caption');
    eq(await fx.evaluate(() => { const t = [...document.querySelectorAll('#nodeNote svg.lens-scene text')].map(x => x.textContent).join('').replace(/\s+/g, ''), w = 'onlyallowedrequestsarrive'; return t.split(w).length - 1; }), 1, 'the named scene draws the caption once, inside the svg (it may wrap onto lines)');
    await openNodeNote(fx, 'limiter', 'Rate limiter'); eq(await fx.locator('#nodeNote figure.plate').count(), 0, 'a draw-only node scene shows no plate (and no context plate)');
    eq(await fx.locator('#nodeNote .narr').count(), 1, 'the node narrative is still there'); await fx.close(); });
}
// breaks if the caption or a label reaches the drawing as markup
{ const evil = JSON.parse(JSON.stringify(drawFixture)), bad = '<img src=x onerror=window.__x=1>';
  const sc = evil.nodes.find(n => n.id === 'limiter').scene; sc.caption = bad; sc.draw[2].label = bad; sc.draw.push({ op: 'text', x: 8, y: 8, t: '"><script>window.__x=2</script>' });
  const px = await mk(1280, 900, 'light', buildLesson('draw-xss', evil));
  await t('draw: an <img onerror> caption or label and a script in a note stay text', async () => {
    await openNodeNote(px, 'limiter', 'Rate limiter');
    eq(await px.evaluate(() => typeof window.__x), 'undefined', 'script ran'); eq(await px.locator('#nodeNote img, #nodeNote script, #nodeNote svg img, #nodeNote svg script').count(), 0, 'injected elements');
    if (hasDraw) { const txt = await svgText(px.locator('#nodeNote figure.plate svg')); if (!txt.includes('<img src=x')) throw new Error('the label is not shown literally: ' + txt);
      if (!(await px.locator('#nodeNote figure.plate svg').getAttribute('aria-label')).includes('<img src=x')) throw new Error('the caption is not in aria-label as text');
      eq(await px.locator('#nodeNote figure.plate figcaption').textContent(), '<img src=x onerror=window.__x=1>', 'the visible caption is the literal text'); eq(await px.locator('#nodeNote figcaption *').count(), 0, 'no element inside the caption'); } });
  await px.close(); }
// breaks if the zine theme starts needing scenes.js for draw, or chokes on it
{ const zurl = (() => { const out = join(shots, 'arch-draw-zine.html'); execFileSync('python3', [join(lensRoot, 'scripts', 'build.py'), join(lensRoot, 'scripts', 'testdata', 'arch-draw.json'), out, '--theme', 'zine'], { stdio: 'pipe' }); return 'file://' + out; })();
  const pz = await mk(1280, 900, 'light', zurl);
  await t('draw: zine ignores draw scenes and still builds and opens every node', async () => {
    eq(await pz.locator('#map .node').count(), 4, 'nodes'); for (let i = 0; i < 4; i++) await pz.locator('#map .node').nth(i).click();
    eq(await pz.locator('svg.lens-scene, .plate').count(), 0, 'sketch pictures in zine'); eq(readFileSync(zurl.slice(7), 'utf8').includes('LensScenes'), false, 'scenes.js in zine'); });
  await pz.close(); }
await dx.close();

// ---------- map legibility: node icons and edge labels ----------
const QA_LESSON = process.env.LENS_QA_LESSON || '/tmp/lens-qa/tasklight-arch.json';
const denseFixture = JSON.parse(readFileSync(join(lensRoot, 'scripts', 'testdata', 'arch-dense.json'), 'utf8'));
const mapLessons = [['arch-ctx', ctxFixture], ['arch-dense', denseFixture], ['arch-mini', fixture], ...(existsSync(QA_LESSON) ? [['tasklight-arch', JSON.parse(readFileSync(QA_LESSON, 'utf8'))]] : [])];
if (!existsSync(QA_LESSON)) console.log('note: QA lesson not found at', QA_LESSON, '(set LENS_QA_LESSON); label checks run on the testdata lessons only');
const rectsOf = pg => pg.evaluate(() => {
  const r = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  return { labels: [...document.querySelectorAll('#map .elabel')].map(e => ({ name: e.textContent, ...r(e), ei: e.dataset.ei })), nodes: [...document.querySelectorAll('#map .node')].map(g => ({ name: g.dataset.id, ...r(g.querySelector('.fill')) })),
    svg: r(document.querySelector('#map')) };
});
const hit = (a, b, g = 0) => a.l < b.r + g && b.l < a.r + g && a.t < b.b + g && b.t < a.b + g;
// breaks if a node with `prop` draws no icon on the map, an icon is drawn for a node without one, or the icon sits outside its box or on the label
await t('map icons: a node with prop draws its icon inside its box, left of the label; a node without draws none', async () => {
  const pg = await mk(1440, 960, 'light', buildLesson('map-icons', (() => { const l = JSON.parse(JSON.stringify(ctxFixture)); delete l.nodes[2].prop; return l; })()));
  const have = ctxFixture.nodes.map((n, i) => i !== 2 && n.prop ? n.id : null).filter(Boolean);
  eq(await pg.locator('#map .node .nicon').count(), have.length, 'icons');
  const geo = await pg.evaluate(() => [...document.querySelectorAll('#map .node')].map(g => { const box = g.querySelector('.fill').getBoundingClientRect(), ic = g.querySelector('.nicon'), ib = ic && ic.getBoundingClientRect();
    const tx = [...g.querySelectorAll('text')].map(x => x.getBoundingClientRect());
    return { id: g.dataset.id, icon: !!ic, inside: ic ? ib.left >= box.left - 1 && ib.right <= box.right + 1 && ib.top >= box.top - 1 && ib.bottom <= box.bottom + 1 : null, wide: ic ? ib.width : null,
      clash: ic ? tx.some(r => r.left < ib.right && ib.left < r.right && r.top < ib.bottom && ib.top < r.bottom) : null, textRight: tx.every(r => r.right <= box.right - 2) }; }));
  const bare = ctxFixture.nodes[2].id; for (const g of geo) { eq(g.icon, g.id !== bare, `icon on ${g.id}`); if (g.icon) { eq(g.inside, true, `${g.id} icon inside box`); eq(g.clash, false, `${g.id} icon on its label`); if (g.wide < 20 || g.wide > 60) throw new Error(`${g.id} icon width ${g.wide}`); } eq(g.textRight, true, `${g.id} label inside box`); }
  const none = await mk(1440, 960, 'light', archUrl); eq(await none.locator('#map .node .nicon').count(), 0, 'icons without prop'); await none.close();
  await pg.close(); });
// breaks if the icon's strokes are the fixed light-mode ink on the blackboard, or a damaged / impact node loses its icon or its coloured outline
await t('map icons: chalk in dark mode; impact and damage styles still apply', async () => {
  const pg = await mk(1440, 960, 'dark', ctxUrl);
  const ink = await pg.evaluate(() => [...document.querySelectorAll('#map .nicon path')].filter(p => getComputedStyle(p).stroke === 'rgb(17, 17, 17)').length); eq(ink, 0, 'light-mode ink strokes in dark');
  await pg.locator('#map .node[data-id="engine"]').click(); await pg.locator('#showImpact').click();
  eq(await pg.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--orange)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return getComputedStyle(document.querySelector('#map .node.origin .stroke')).stroke === c; }), true, 'origin outline is the impact orange');
  eq(await pg.locator('#map .node.hit .nicon, #map .node.origin .nicon').count() > 0, true, 'icons on impacted nodes'); await pg.close(); });
// breaks if a 390px phone grows a page scroll because of the icons (the map scrolls inside its own box)
await t('map icons: no horizontal page scroll at 390px', async () => {
  const pg = await mk(390, 844, 'light', ctxUrl); const w = await pg.evaluate(() => document.documentElement.scrollWidth); if (w > 390) throw new Error('scrollWidth ' + w); await pg.close(); });
// breaks if two edge labels, or a label and a node box, overlap (labels used to pile up where edges bend round one column)
for (const w of [1440, 768]) for (const [name, lesson] of mapLessons) {
  await t(`map labels ${name} @${w}: no label overlaps another label or a node, all stay in the map`, async () => {
    const pg = await mk(w, 900, 'light', buildLesson('map-' + name, lesson)); const { labels, nodes, svg } = await rectsOf(pg), bad = [];
    labels.forEach((a, i) => { labels.slice(i + 1).forEach(b => { if (hit(a, b)) bad.push(`"${a.name}" x "${b.name}"`); }); nodes.forEach(n => { if (hit(a, n)) bad.push(`"${a.name}" on node ${n.name}`); }); });
    await pg.close(); if (bad.length) throw new Error(bad.slice(0, 4).join('; ')); });
}
const cm = await mk(390, 844, 'light', ctxUrl);
// breaks if the context plate (or an authored scene with slots) widens the page or spills out of the viewport on a phone
await t('ctx mobile: the plate fits 390px with no horizontal scroll, for the hub, a lone node and a scene with slots', async () => {
  for (const [id, label] of [['engine', 'engine'], ['notes', 'NOTES.md'], ['store', 'events.db']]) {
    await openNodeNote(cm, id, label); await cm.waitForTimeout(150);
    const r = await cm.evaluate(() => { const f = document.querySelector('#nodeNote figure.plate'), b = f.getBoundingClientRect(); return { w: document.documentElement.scrollWidth, left: b.left, right: b.right, ratio: b.height / b.width }; });
    if (r.w > 390 || r.left < 0 || r.right > 390.5 || Math.abs(r.ratio - .5625) > .01) throw new Error(`${id}: ${JSON.stringify(r)}`); } });
await openNodeNote(cm, 'engine', 'engine'); await cm.locator('#nodeNote figure.plate').scrollIntoViewIfNeeded(); await cm.screenshot({ path: 'c2-ctx-mobile.png' }); await cm.close();
const cd = await mk(1440, 960, 'dark', ctxUrl);
// breaks if the plate paints with a fixed light-mode colour: on the blackboard its lettering must be chalk and no stroke may be the light-mode ink
await t('ctx dark: the plate is drawn in chalk, not light-mode ink', async () => {
  await openNodeNote(cd, 'engine', 'engine');
  const r = await cd.evaluate(() => { const svg = document.querySelector('#nodeNote figure.plate svg'), cs = [...svg.querySelectorAll('text')].map(t => getComputedStyle(t).fill), st = [...svg.querySelectorAll('path')].map(p => getComputedStyle(p).stroke);
    return { chalkText: cs.filter(c => c === 'rgb(236, 233, 225)').length, inkText: cs.filter(c => c === 'rgb(17, 17, 17)').length, inkStroke: st.filter(c => c === 'rgb(17, 17, 17)').length }; });
  if (!r.chalkText || r.inkText || r.inkStroke) throw new Error(JSON.stringify(r)); });
await cd.locator('#nodeNote').scrollIntoViewIfNeeded(); await cd.screenshot({ path: 'c3-ctx-dark.png' }); await cd.close();

const ad = await mk(1440, 960, 'dark', archUrl);
// breaks if the new sections or dashed edges only work in the light palette
await t('arch dark: dark palette, dashed edges and new sections render', async () => {
  eq(await ad.evaluate(() => getComputedStyle(document.body).backgroundColor), RGB.board, 'page bg'); eq(await ad.locator('#s-invariants .inv').count(), 3, 'invariants');
  eq(await ad.evaluate(() => getComputedStyle(document.querySelector('.inv h3')).color), RGB.chalk, 'ink'); eq(await blotFill(ad), RGB.chalk, 'blot'); });
await ad.evaluate(() => document.getElementById('s-pressure')?.scrollIntoView({ block: 'start' })); await ad.waitForTimeout(200); await ad.screenshot({ path: 'a8-arch-dark.png' });
await ad.evaluate(() => document.getElementById('s-break')?.scrollIntoView({ block: 'start' })); await ad.waitForTimeout(200); await ad.screenshot({ path: 'a8b-arch-dark-failures.png' });
await ad.evaluate(() => document.getElementById('stop-0')?.scrollIntoView({ block: 'start' })); await ad.waitForTimeout(200); await ad.screenshot({ path: 'a8c-arch-dark-step.png' });
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

// ---------- rendered text size: every <text> in every plate is >= 11px ON SCREEN ----------
// A plate is drawn in a 640-unit viewBox and shown 280-560px wide, so a font-size of 20 units is only 11px at 358px wide (the phone). F's
// "13px floor" was measured in viewBox units and left real text at 6-9px. This measures what the reader sees: font-size * rendered width / 640.
// Lessons: card QA's break variant (60-character captions, 18-character item/prop/node/payload labels on every scene), the QA lesson tasklight-arch.json
// (when present), and arch-ctx (context plates). Every plate on the page counts: steps, failure modes, decisions, risks, invariants,
// pressure, and the node note of every node (authored scene or context plate).
const longify = lesson => { const l = JSON.parse(JSON.stringify(lesson)), CAP = 'This caption is deliberately sixty characters long, no more.';
  const full = (o, k) => { o.scene = { name: o.scene?.name || 'carry', caption: CAP, items: [0, 1, 2, 3].slice(0, o.scene?.name === 'queue' ? 4 : 2).map(i => `ItemLabelEighteen${i}`), props: [0, 1].map(i => ({ prop: ['camera', 'chip', 'database'][(k + i) % 3], label: 'PropLabel18chars!!' })) }; };
  let k = 0; const walk = o => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.scene) full(o, k++); Object.values(o).forEach(walk); } };
  walk(l); l.nodes.slice(0, 2).forEach((n, i) => full(n, i)); l.nodes.forEach((n, i) => { n.label = `Node${i % 10}LabelEighteen`; n.prop = n.prop || ['camera', 'chip', 'database', 'gear'][i % 4]; n.owns = 'The one thing it owns, said in about sixty characters.'; });
  l.edges.forEach(e => { e.payload = 'PayloadLabel18chr!'; }); return l; };
const renderedSizes = async (pg, lesson) => {   // -> { kind: { min, who, n } } over every plate reachable on the page
  const seen = new Map();
  const collect = async () => { for (const x of await pg.evaluate(() => [...document.querySelectorAll('figure.plate')].map(f => { const sv = f.querySelector('svg'), sc = sv ? sv.getBoundingClientRect().width / 640 : 0; if (!sc) return null;
    const kind = f.classList.contains('ctx') ? 'context' : f.closest('.stop') ? 'step' : f.closest('.node-note') ? 'node' : (f.parentElement.className.split(' ')[0] || 'other'), full = sv.getAttribute('aria-label'), why = full.slice(0, 40);
    return { key: kind + '|' + full + '|' + [...f.parentElement.parentElement.children].indexOf(f.parentElement) + '|' + f.parentElement.id, kind, why, w: sv.getBoundingClientRect().width, ts: [...sv.querySelectorAll('text')].map(t => ({ t: t.textContent, px: parseFloat(getComputedStyle(t).fontSize) * sc })) }; }).filter(Boolean))) seen.set(x.key, x); };
  await collect();
  for (const n of lesson.nodes) { await pg.locator(`#map .node[data-id="${n.id}"]`).dispatchEvent('click'); await pg.waitForTimeout(60); await collect(); }
  const by = {}; for (const x of seen.values()) { const k = by[x.kind] ??= { min: 1e9, who: '', n: 0, minW: 1e9, cut: [] }; k.n++; k.minW = Math.min(k.minW, x.w);
    for (const t of x.ts) { if (t.px < k.min) { k.min = t.px; k.who = `"${t.t}" in ${x.why}`; } if (t.t.includes('…')) k.cut.push(t.t); } }
  return by; };
const sizeLessons = [['break variant (arch-mini, every label full length)', longify(fixture)], ['arch-ctx', ctxFixture], ['arch-draw', drawFixture], ...(existsSync(QA_LESSON) ? [['tasklight-arch (QA)', JSON.parse(readFileSync(QA_LESSON, 'utf8'))], ['tasklight-arch (break variant)', longify(JSON.parse(readFileSync(QA_LESSON, 'utf8')))]] : [])];
for (const [name, lesson] of sizeLessons) {
  const u = buildLesson('size-' + name.replace(/\W+/g, '-'), lesson);
  for (const scheme of ['light', 'dark']) for (const w of [1440, 768, 390]) {
    // breaks if a plate shows text under 11px at this width (the viewBox floor shrinks, a plate is drawn narrower, a label is cut with an ellipsis)
    await t(`plate text >= 11px on screen: ${name} @${w} ${scheme}`, async () => {
      const pg = await mk(w, 900, scheme, u), by = await renderedSizes(pg, lesson); await pg.close();
      const bad = Object.entries(by).filter(([, v]) => v.min < 10.99).map(([k, v]) => `${k} ${v.min.toFixed(1)}px ${v.who}`);
      console.log(`  min rendered font @${w} ${scheme} ${name}: ` + Object.entries(by).map(([k, v]) => `${k} ${v.min > 1e8 ? 'no text' : v.min.toFixed(1) + 'px'} (n=${v.n}, narrowest ${Math.round(v.minW)}px)`).join(', '));
      if (bad.length) throw new Error(bad.join('; '));
      if (/break variant/.test(name)) { const cut = Object.entries(by).flatMap(([k, v]) => v.cut.map(c => k + ' ' + c)); if (cut.length) throw new Error('labels cut with an ellipsis: ' + cut.slice(0, 4).join('; ')); } });
  }
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
    eq(await pj.locator('#map .node.hit, #map .node.origin').count(), 0, 'damage cleared'); if (!(await hint(pj)).startsWith('The blue line is')) throw new Error('hint: ' + await hint(pj)); });
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
    if (!(await hint(ph)).startsWith('The blue circle marks')) throw new Error(await hint(ph)); eq(await ph.locator('#nodeNote').isHidden(), true, 'edge note closed'); });
  // breaks if selecting a connection leaves the yellow mark painted
  await t('QA4: selecting a connection clears a mark', async () => {
    await clickEdge(ph, 2); eq(await ph.locator('#map .node.marked').count(), 0, 'mark'); eq(await sel(ph), '2', 'edge'); if (!(await hint(ph)).startsWith('The thick blue arrow')) throw new Error(await hint(ph)); });
  // breaks if the failure-mode damage view keeps the selected connection painted
  await t('QA4: showing damage replaces a selected connection', async () => {
    await ph.locator('[data-run="0"]').click(); await ph.locator('[data-show="0"]').click(); await ph.waitForTimeout(150); eq(await sel(ph), '', 'edge'); eq(await ph.locator('#s-interfaces tr.on').count(), 0, 'row');
    eq(await ph.locator('#map .node.hit').count(), 2, 'damage'); if (!(await hint(ph)).startsWith('Red shows what')) throw new Error(await hint(ph)); });
  // breaks if clicking a node leaves a stale yellow mark beside the node you just opened
  await t('QA4: opening a node clears a mark', async () => {
    await ph.locator('.inv [data-mark]').first().click(); eq(await ph.locator('#map .node.marked').count(), 1, 'marked'); await ph.locator('#map .node[data-id="api"]').click(); eq(await ph.locator('#map .node.marked').count(), 0, 'mark cleared'); });
  // breaks if selecting a connection erases the damage of a failure mode without saying so, or if impact mode hint and map disagree
  await t('QA4: selecting a connection in impact mode keeps the impact view and its hint', async () => {
    await ph.locator('#map .node[data-id="store"]').click(); await ph.locator('#showImpact').click(); await clickEdge(ph, 0); eq(await ph.locator('#map .node.hit').count(), 4, 'hits');
    eq(await sel(ph), '', 'a selected connection is not painted over the impact view'); if (!(await hint(ph)).startsWith('Orange shows everything that depends on')) throw new Error(await hint(ph)); });
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


{ // 8 scene captions and names (sketch only): text stays text, an unknown name draws no plate and breaks nothing
  const X = '<img src=x onerror="window.__pwn=1">';
  const base = await mkv('scene-base', null, 1440, 900); const total = await base.locator('svg.lens-scene').count(); await base.close();
  const ps = await mkv('scene-xss', v => { v.nodes[0].scene = { name: 'gate', caption: X }; v.traces[0].steps[0].scene = { name: 'carry', caption: X }; v.whatifs[0].scene = { name: 'fire', caption: X }; v.invariants[0].scene = { name: 'wall', caption: X }; v.decisions[0].scene = { name: 'fork', caption: X }; }, 1440, 900);
  // breaks if a scene caption is put into the page unescaped (captions come from the lesson author or from the code being explained)
  await t('escaping: scene captions render as text', async () => {
    await ps.locator('#map .node[data-id="api"]').click(); await ps.locator('#nodeNote h3', { hasText: 'Upload API' }).waitFor({ timeout: 2000 });
    eq(await ps.evaluate(() => document.querySelectorAll('main img, aside img, svg.lens-scene image').length), 0, 'injected img elements'); eq(await ps.evaluate(() => typeof window.__pwn), 'undefined', '__pwn');
    eq(await ps.evaluate(() => [...document.querySelectorAll('svg.lens-scene')].filter(s => s.textContent.includes('onerror')).length >= 5), true, 'the caption is drawn as text'); });
  await ps.close();
  // an unknown scene name can only reach the page by skipping build.py's validation, so build the page by hand
  const rawBuild = (name, lesson) => { const out = join(shots, name + '.html'), parts = readFileSync(join(lensRoot, 'assets', 'themes', 'parts', 'scenes.js'), 'utf8');
    writeFileSync(out, themeSrc.replace('<!-- lens:include scenes.js -->', () => parts).replace('__TITLE__', () => lesson.title).replace('__LESSON_JSON__', () => JSON.stringify(lesson).replace(/<\//g, '<\\/'))); return 'file://' + out; };
  const bad = JSON.parse(JSON.stringify(fixture)); bad.traces[0].steps[0].scene = { name: 'nope', caption: 'x' }; bad.whatifs[0].scene = { name: '<b>', caption: 'x' }; bad.nodes[0].scene = { name: 'nope' };
  const before = errs.length, pu = await mk(1440, 900, 'light', rawBuild('scene-unknown', bad));
  // breaks if an unknown scene name throws while rendering, or draws something (or an empty plate) in its place
  await t('plate: an unknown scene name draws no plate and does not break the page', async () => {
    eq(await pu.locator('svg.lens-scene').count(), total - 2, 'scenes'); eq(await pu.locator('#stop-0 .plate').count(), 0, 'step plate'); eq(await pu.locator('.exp').first().locator('.plate').count(), 0, 'failure mode plate');
    await pu.locator('#map .node[data-id="api"]').click(); await pu.locator('#nodeNote h3', { hasText: 'Upload API' }).waitFor({ timeout: 2000 }); eq(await pu.locator('#nodeNote .plate').count(), 0, 'node plate'); eq(errs.slice(before).join('|'), '', 'errors'); });
  await pu.close();
}

// ---------- Caveat unavailable (offline): the fallback cursive is wider, nothing may overflow ----------
// Every handwriting element outside the sideways scrollers stays inside the viewport and inside its own box, and every
// map label stays inside its node. Returns the offenders.
const handOverflow = pg => pg.evaluate(() => {
  const bad = [], W = document.documentElement.clientWidth; let checked = 0;
  if (document.documentElement.scrollWidth > W) bad.push('page scrollWidth ' + document.documentElement.scrollWidth);
  for (const el of document.querySelectorAll('main *, nav *')) {
    if (el.closest('svg, .mapwrap, .code .rows, [hidden]') || (W <= 1120 && el.closest('.rail'))) continue; // map, code rows and the phone rail scroll sideways by design
    if (W <= 760 && el.closest('.ifaces thead')) continue; // visually hidden on phones (kept for screen readers)
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(); if (!cs.fontFamily.startsWith('Caveat') || !r.width) continue; checked++;
    const name = el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' "' + el.textContent.trim().slice(0, 30) + '"';
    if (r.right > W + 1 || r.left < -1) bad.push('outside viewport: ' + name);
    if (cs.display !== 'inline' && el.scrollWidth > el.clientWidth + 1) bad.push(`overflows its box (${el.scrollWidth} > ${el.clientWidth}): ${name}`);
  }
  document.querySelectorAll('#map .node').forEach(g => { const box = g.querySelector('.stroke').getBBox();
    g.querySelectorAll('text').forEach(t => { const b = t.getBBox(); if (b.x + b.width > box.x + box.width - 2) bad.push('map label leaves its box: ' + t.textContent); }); });
  if (checked < 20) bad.push(`only ${checked} handwriting elements found`);
  return bad; });
const caveatLoaded = pg => pg.evaluate(() => [...document.fonts].some(f => /Caveat/.test(f.family) && f.status === 'loaded'));
const offline = async (w, h, u) => { const pg = await b.newPage({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
  pg.on('pageerror', e => errs.push('pageerror: ' + e.message)); await pg.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await pg.goto(u); await pg.evaluate(() => localStorage.clear()); await pg.reload(); await pg.waitForTimeout(500); return pg; };
// breaks if a handwriting label gets a fixed width or nowrap that only Caveat's narrow letters fit (stamps, labels, rail, map kinds)
for (const [w, h] of [[1440, 960], [390, 844]]) for (const [name, u] of [['example', url], ['arch', archUrl]]) {
  const pg = await offline(w, h, u);
  await t(`offline fonts ${name} ${w}: Caveat absent, nothing overflows`, async () => { eq(await caveatLoaded(pg), false, 'Caveat loaded');
    if (name === 'arch') { await pg.locator('[data-run="0"]').click(); await pg.locator('#map .node[data-id="api"]').click(); }
    eq((await handOverflow(pg)).join(' | '), '', 'overflow'); });
  await pg.screenshot({ path: `o-${name}-${w}.png`, fullPage: w < 500 }); await pg.close();
}
// the same check with the real font, when the network allows it to load
await t('online fonts: nothing overflows at 1440 or 390', async () => { eq((await handOverflow(lp)).join(' | ') + (await handOverflow(m)).join(' | '), '', 'overflow'); });
console.log('Caveat loaded online:', await caveatLoaded(m));

console.log('errors:', errs.length ? errs : 'none'); console.log('screenshots:', shots);
await b.close();
process.exit(failed || errs.length ? 1 : 0);
