#!/usr/bin/env node
// Tests for the Ask panel in a real browser (Playwright): file:// mode, artifact mode (stubbed window.claude),
// local mode (real lens serve.py + a fake claude) and a 375px phone width. No network, no Claude usage.
// Usage: node test-panel.mjs
import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, copyFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { getChromium } = await import(pathToFileURL(join(HERE, '../../lens/scripts/pw.mjs')).href);
const pw = await getChromium();
if (!pw) { console.log('skip: Playwright chromium not found (set LENS_PLAYWRIGHT)'); process.exit(0); }

const tmp = mkdtempSync(join(tmpdir(), 'askp-'));
const MARK = 'UNIQUE_PAGE_MARKER_7431';
const SECTION = 'Revenue grew 12 percent in the second quarter.';
const REPORT = `<!doctype html><html><head><meta charset="utf-8"><title>Q2 report</title></head><body>
<h1>Q2 report</h1><p id="p1">${SECTION} ${MARK}</p><p>Costs were flat.</p></body></html>`;
mkdirSync(join(tmp, 'site'));
writeFileSync(join(tmp, 'site', 'report.html'), REPORT);
const injected = join(tmp, 'site', 'injected.html');
execFileSync('python3', [join(HERE, 'inject.py'), join(tmp, 'site', 'report.html'), '-o', injected]);

let failed = 0;
function plain(name, fn) { try { fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); } }
plain('inject.py: injecting twice leaves the file byte-identical, with one copy of the widget', () => {
  const twice = join(tmp, 'site', 'twice.html');
  copyFileSync(join(tmp, 'site', 'report.html'), twice);
  execFileSync('python3', [join(HERE, 'inject.py'), twice]);
  const once = readFileSync(twice, 'utf8');
  execFileSync('python3', [join(HERE, 'inject.py'), twice]);
  if (readFileSync(twice, 'utf8') !== once) throw new Error('second injection changed the file');
  if (once.split('<!-- ask-panel:begin -->').length !== 2 || !once.includes('</script>\n<!-- ask-panel:end -->\n</body>')) throw new Error('widget not injected once before </body>');
});
plain('inject.py: a lens lesson that already has its own Ask is left alone', () => {
  const lens = join(tmp, 'site', 'lens.html');
  writeFileSync(lens, '<html><body><script>fetch("/__lens/ask")</script></body></html>');
  execFileSync('python3', [join(HERE, 'inject.py'), lens], { stdio: 'ignore' });
  if (readFileSync(lens, 'utf8').includes('ask-panel:begin')) throw new Error('injected into a lens lesson');
});

// A stand-in for claude.ai's `sample` capability. The mode decides what a call does.
const stub = mode => `
window.__mode = ${JSON.stringify(mode)}; window.__calls = [];
window.claude = { use: async name => name !== 'sample' ? null : async (input, opts) => {
  window.__calls.push({ input: JSON.parse(JSON.stringify(input)), tier: opts.modelTier, cache: opts.cache });
  if (window.__mode !== 'ok' && window.__mode !== 'wide') throw { code: window.__mode, message: 'stub says ' + window.__mode };
  const n = window.__calls.length;
  const full = window.__mode === 'wide'
    ? 'W' + 'x'.repeat(240) + '\\n\\n\`\`\`\\n' + 'y'.repeat(300) + '\\n\`\`\`'
    : 'Answer ' + n + ': **bold** and \`code\` <img src=x onerror="window.__xss=1">';
  let prev = '';
  for (const text of [full.slice(0, 10), full]) {
    await new Promise(r => setTimeout(r, 25));
    opts.onText({ text, delta: text.slice(prev.length) }); prev = text;
  }
  return { text: full, truncated: false, modelTierApplied: opts.modelTier };
} };`;

const browser = await pw.launch();
async function t(name, fn, { width = 1000 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 700 } });
  const page = await ctx.newPage();
  const errors = [];
  page.setDefaultTimeout(6000);
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', e => errors.push(String(e)));
  try { await fn(page, errors); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '-', String(e.message).split('\n')[0]); }
  finally { await ctx.close(); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const state = (page, want) => page.waitForFunction(w => document.documentElement.dataset.askp === w, want, { timeout: 8000 });
const aiBodies = page => page.locator('.askp-ai .askp-body');
async function ask(page, q) {
  await page.locator('.askp-input').fill(q);
  await page.locator('.askp-input').press('Enter');
}
const idle = page => page.locator('.askp-send', { hasText: 'Send' }).waitFor();
const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);

// (a) a plain file:// page has no backend: the widget must run, find none, show nothing and say nothing
await t('file:// mode: the widget runs, finds no backend, shows no button, logs no errors', async (page, errors) => {
  await page.goto(pathToFileURL(injected).href);
  await state(page, 'off');
  eq(await visible(page, '.askp-fab'), false, 'button visible');
  eq(await page.locator('.askp-panel').count(), 0, 'panel nodes');
  eq(errors, [], 'console errors');
});

// (b) artifact mode
await t('artifact mode: answer renders as safe markdown; page text goes out; the second call carries the first Q and A', async (page, errors) => {
  await page.addInitScript(stub('ok'));
  await page.goto(pathToFileURL(injected).href);
  await state(page, 'artifact');
  eq(await page.evaluate(() => window.__calls.length), 0, 'calls before any click');
  await page.locator('.askp-fab').click();
  await ask(page, 'What grew?');
  await idle(page);
  const body = aiBodies(page).first();
  eq(await body.locator('strong').allTextContents(), ['bold'], 'bold');
  eq(await body.locator('code').allTextContents(), ['code'], 'inline code');
  eq(await body.locator('img').count(), 0, 'model text became an element');
  ok((await body.textContent()).includes('<img src=x'), 'literal tag text missing');
  eq(await page.evaluate(() => window.__xss), undefined, 'model html executed');
  await ask(page, 'And costs?');
  await idle(page);
  const calls = await page.evaluate(() => window.__calls);
  const first = calls[0].input, second = calls[1].input;
  ok(Array.isArray(first) && first[0].role === 'user', 'first input is not a turn list starting on user');
  ok(first[0].content.includes(MARK) && first[0].content.includes(SECTION), 'page text not sent');
  ok(!first[0].content.includes('Ask about this page'), 'the panel itself was sent as page text');
  eq(first[first.length - 1], { role: 'user', content: 'What grew?' }, 'first question turn');
  eq(second.slice(-3), [{ role: 'user', content: 'What grew?' },
    { role: 'assistant', content: 'Answer 1: **bold** and `code` <img src=x onerror="window.__xss=1">' },
    { role: 'user', content: 'And costs?' }], 'history in the second call');
  eq([calls[0].tier, calls[0].cache], ['quick', false], 'haiku maps to quick, no cache');
  await page.locator('.askp-model button', { hasText: 'Sonnet' }).click();
  await ask(page, 'Third?');
  await idle(page);
  eq((await page.evaluate(() => window.__calls))[2].tier, 'default', 'sonnet maps to default');
  eq(errors, [], 'console errors');
});

await t('artifact mode: a selected passage is quoted in the next question', async page => {
  await page.addInitScript(stub('ok'));
  await page.goto(pathToFileURL(injected).href);
  await state(page, 'artifact');
  await page.evaluate(() => getSelection().selectAllChildren(document.getElementById('p1')));
  await page.locator('.askp-pop').waitFor({ state: 'visible' });
  await page.locator('.askp-pop').click();
  ok(await page.locator('.askp-panel').isVisible(), 'panel did not open');
  ok((await page.locator('.askp-quote').textContent()).includes(SECTION), 'quote chip missing the passage');
  await ask(page, 'Why?');
  await idle(page);
  const last = (await page.evaluate(() => window.__calls))[0].input.at(-1).content;
  ok(last.includes(SECTION) && last.endsWith('Why?'), 'quote not in the sent turn: ' + last);
});

await t('artifact mode: not_granted hides the button and the panel', async page => {
  await page.addInitScript(stub('not_granted'));
  await page.goto(pathToFileURL(injected).href);
  await state(page, 'artifact');
  await page.locator('.askp-fab').click();
  await ask(page, 'Hello?');
  await page.waitForFunction(() => !document.querySelector('.askp-fab')?.checkVisibility() && !document.querySelector('.askp-panel')?.checkVisibility());
});

await t('artifact mode: rate_limited shows a calm message and keeps the panel', async page => {
  await page.addInitScript(stub('rate_limited'));
  await page.goto(pathToFileURL(injected).href);
  await state(page, 'artifact');
  await page.locator('.askp-fab').click();
  await ask(page, 'Hello?');
  await page.locator('.askp-err', { hasText: /later|wait/i }).waitFor();
  ok(await page.locator('.askp-panel').isVisible(), 'panel vanished');
});

// (c) local mode: the real lens serve.py with a fake claude
const freePort = () => new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const srv = spawn('python3', [join(HERE, '../../lens/scripts/serve.py'), injected, '--port', String(port)], {
  env: { ...process.env, LENS_CLAUDE: join(HERE, 'testdata/fake-claude.py'), XDG_CONFIG_HOME: join(tmp, 'config') }, stdio: ['ignore', 'pipe', 'inherit'] });
const banner = await new Promise((res, rej) => { srv.stdout.once('data', d => res(String(d))); srv.once('exit', () => rej(new Error('serve.py exited'))); });
const url = banner.match(/http:\/\/\S+#k=[\w-]+/)[0];
try {
  await t('local mode: ask streams an answer from serve.py in report mode; the follow-up resumes the session without resending the page', async (page, errors) => {
    await page.goto(url);
    await state(page, 'local');
    ok(!page.url().includes('k='), 'key left in the address bar');
    await page.locator('.askp-fab').click();
    await ask(page, 'What grew?');
    const b = aiBodies(page).first();
    await idle(page);
    const a1 = await b.textContent();
    ok(a1.includes('model=haiku resume=none sys=You are answering questions about a web page'), 'first call: ' + a1.slice(0, 120));
    ok(a1.includes(MARK) && a1.endsWith('What grew?>>'), 'page text or question missing from the prompt');
    await ask(page, 'And costs?');
    await idle(page);
    const a2 = await aiBodies(page).nth(1).textContent();
    ok(a2.includes('resume=11111111-2222-3333-4444-555555555555'), 'follow-up did not resume: ' + a2.slice(0, 100));
    ok(!a2.includes(MARK) && a2.endsWith('PROMPT<<And costs?>>'), 'follow-up prompt: ' + a2);
    eq(errors, [], 'console errors');
  });
  await t('local mode: serve.py rejects an unknown mode', async () => {
    const key = url.match(/#k=([\w-]+)/)[1];
    const r = await fetch(`http://127.0.0.1:${port}/__lens/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lens-Key': key }, body: JSON.stringify({ q: 'hi', mode: 'evil' }) });
    eq(r.status, 400, 'status');
  });
  await t('local mode: without the key in the link the button stays hidden', async (page) => {
    await page.goto(url.split('#')[0]);
    await state(page, 'off');
    eq(await visible(page, '.askp-fab'), false, 'button visible');
  });
} finally { srv.kill(); }

// (d) phone width
await t('375px: the panel is a full-width sheet and nothing scrolls sideways, even with long unbroken text', async page => {
  await page.addInitScript(stub('wide'));
  await page.goto(pathToFileURL(injected).href);
  await state(page, 'artifact');
  await page.locator('.askp-fab').click();
  await ask(page, 'Show me something wide');
  await idle(page);
  const m = await page.evaluate(() => {
    const r = document.querySelector('.askp-panel').getBoundingClientRect(), log = document.querySelector('.askp-log');
    return { docW: document.documentElement.scrollWidth, top: r.top, bottom: r.bottom, left: r.left, right: r.right, logOver: log.scrollWidth - log.clientWidth };
  });
  ok(m.docW <= 375, 'page scrolls sideways: ' + m.docW);
  ok(m.left >= 0 && m.right <= 375 && m.right - m.left >= 370, `panel not full width: ${m.left}..${m.right}`);
  ok(m.top >= 40 && m.bottom === 700, `not a bottom sheet: ${m.top}..${m.bottom}`);
  ok(m.logOver <= 1, 'answer overflows the panel by ' + m.logOver);
}, { width: 375 });

await browser.close();
console.log(failed ? `FAIL: ${failed} failed` : 'ok: all passed');
process.exit(failed ? 1 : 0);
