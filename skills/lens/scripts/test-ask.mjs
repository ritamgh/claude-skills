// End-to-end test of "Ask Claude" in a theme (default zine): the worked example served by serve.py with a fake `claude`
// (scripts/testdata/fake-claude.py echoes its flags and prompt), plus the copy fallback when opened as a file.
// No Claude usage. Usage: node test-ask.mjs [theme]
import { getChromium } from './pw.mjs';
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync } from 'fs'; import { tmpdir } from 'os'; import { join, dirname } from 'path'; import { fileURLToPath } from 'url';
const HERE = dirname(fileURLToPath(import.meta.url)), THEME = process.argv[2] || 'zine';
const pw = await getChromium();
if (!pw) { console.log('skip: Playwright not found (npm i -g playwright && npx playwright install chromium)'); process.exit(0); }
const tmp = mkdtempSync(join(tmpdir(), 'lens-ask-')), lens = join(tmp, '.lens'); mkdirSync(lens);
const html = join(lens, '0001-demo.html');
execFileSync('python3', [join(HERE, 'build.py'), join(HERE, '..', 'examples', 'jw-ask-flow.json'), html, '--theme', THEME], { stdio: 'ignore' });
const port = 4300 + Math.floor(Math.random() * 500);
const srv = spawn('python3', [join(HERE, 'serve.py'), html, '--port', String(port)], { env: { ...process.env, LENS_CLAUDE: join(HERE, 'testdata', 'fake-claude.py') } });
const url = await new Promise((ok, no) => { srv.stdout.once('data', d => { const m = String(d).match(/http:\S+/); m ? ok(m[0]) : no(new Error(String(d))); }); setTimeout(() => no(new Error('serve.py did not start')), 5000); });

const b = await pw.launch();
let failed = 0; const errs = [];
const t = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); } };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const has = (s, sub, m) => { if (!String(s).includes(sub)) throw new Error(`${m}: ${JSON.stringify(String(s).slice(0, 160))} lacks ${JSON.stringify(sub)}`); };
const mk = async (u, w = 1440, h = 960, scheme = 'light', allow = /^$/) => { const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: 'reduce' });
  p.on('pageerror', e => errs.push('pageerror: ' + e.message)); p.on('console', m => m.type() === 'error' && !/fonts\.g/.test(m.text()) && !allow.test(m.text()) && errs.push('console: ' + m.text()));
  await p.goto(u); await p.evaluate(() => localStorage.clear()); await p.goto('about:blank'); await p.goto(u); await p.waitForTimeout(400); return p; };
// Select the first sentence-ish chunk of stop N's narration, as a reader would with the mouse.
const select = (p, stop) => p.evaluate(i => { const el = document.querySelector(`#stop-${i} .narr p`); el.scrollIntoView({ block: 'center' });
  const n = el.firstChild, r = document.createRange(); r.setStart(n, 0); r.setEnd(n, Math.min(40, n.length));
  getSelection().removeAllRanges(); getSelection().addRange(r); return r.toString().trim(); }, stop);
const lastAnswer = async p => { await p.locator('#askSend', { hasText: 'Send' }).waitFor({ timeout: 8000 }); return p.locator('.ask-ai .body').last().innerHTML(); };

// --- opened as a file: no helper, asking copies a question ---
const f = await mk('file://' + html);
await t('file: buttons say Copy question', async () => { eq(await f.locator('[data-ask="0"] .if-copy').isVisible(), true, 'copy label'); eq(await f.locator('[data-ask="0"] .if-ask').isVisible(), false, 'ask label'); });
await t('file: selecting text shows a Copy question pop, clicking copies', async () => { await select(f, 0); await f.locator('#askPop.on').waitFor({ timeout: 2000 });
  has(await f.locator('#askPop').innerText(), 'Copy question', 'pop'); await f.locator('#askPop').click(); await f.locator('#toast.on').waitFor({ timeout: 2000 });
  eq(await f.locator('#ask.on').count(), 0, 'panel stays closed'); });

// --- served by serve.py ---
const p = await mk(url);
await t('served: the key is kept and removed from the address bar', async () => { eq(await p.evaluate(() => [location.hash, localStorage.getItem('lens:key')?.length >= 24]).then(JSON.stringify), '["",true]', 'hash, key'); });
await t('served: health detected, buttons say Ask Claude', async () => { eq(await p.evaluate(() => document.body.classList.contains('can-ask')), true, 'can-ask');
  eq(await p.locator('[data-ask="0"] .if-ask').isVisible(), true, 'ask label'); });
let quote;
await t('selection pop opens the panel with the quote and where it came from', async () => { quote = await select(p, 0); await p.locator('#askPop.on').waitFor({ timeout: 2000 });
  has(await p.locator('#askPop').innerText(), 'Ask Claude', 'pop'); await p.locator('#askPop').click();
  await p.locator('#ask.on').waitFor({ timeout: 2000 }); has(await p.locator('.ask-pending .ask-quote').innerText(), quote, 'quote');
  has(await p.locator('.ask-pending .where').innerText(), 'stop 1', 'where'); eq(await p.locator('#askPop.on').count(), 0, 'pop hidden'); });
await p.screenshot({ path: join(tmp, 'a1-pending.png') });
await t('a chip asks; answer streams with read-only tools, markdown, and the quote in the prompt', async () => {
  await p.locator('.ask-chips button', { hasText: 'Explain it simply' }).click(); const a = await lastAnswer(p);
  eq(await p.locator('.ask-me').last().innerText(), 'Explain this in plain words.', 'question'); has(a, 'model=haiku resume=none tools=Read,Grep,Glob', 'flags');
  has(a, '<b>bold</b>', 'bold'); has(a, '<i>it</i>', 'italic'); has(a, '<code>a*b*c</code>', 'code untouched by emphasis'); has(a, quote, 'quote in prompt'); has(a, 'stop 1 (', 'where in prompt');
  eq(await p.locator('.ask-chips').count(), 0, 'chips gone'); });
await t('follow-up on Sonnet resumes the same session', async () => { await p.locator('#askModel button[data-model="sonnet"]').click();
  await p.locator('#askIn').fill('And then?'); await p.locator('#askIn').press('Enter'); const a = await lastAnswer(p);
  has(a, 'model=sonnet resume=11111111-2222-3333-4444-555555555555', 'resume'); has(a, 'PROMPT&lt;&lt;And then?&gt;&gt;', 'bare follow-up'); });
await p.screenshot({ path: join(tmp, 'a2-thread.png') });
await t('a Claude failure shows as an error line', async () => { await p.locator('#askIn').fill('FAIL now'); await p.locator('#askIn').press('Enter');
  await lastAnswer(p); has(await p.locator('.ask-err').last().innerText(), 'boom: fake failure', 'error'); });
await t('New chat forgets the session', async () => { await p.locator('#askNew').click(); eq(await p.locator('.ask-empty').count(), 1, 'empty state');
  await p.locator('#askIn').fill('Fresh?'); await p.locator('#askIn').press('Enter'); has(await lastAnswer(p), 'resume=none', 'new session'); });
await t('Escape closes the panel and makes it inert', async () => { await p.keyboard.press('Escape'); eq(await p.locator('#ask.on').count(), 0, 'closed');
  eq(await p.locator('#ask').getAttribute('inert'), '', 'inert'); });
await t('A asks about the current selection', async () => { const q = await select(p, 1); await p.waitForTimeout(250); await p.keyboard.press('a');
  await p.locator('#ask.on').waitFor({ timeout: 2000 }); has(await p.locator('.ask-pending .ask-quote').innerText(), q, 'quote');
  has(await p.locator('.ask-pending .where').innerText(), 'stop 2', 'where'); await p.keyboard.press('Escape'); });
await t('text blurred behind an unanswered guess offers no pop (no spoilers)', async () => { await select(p, 2); await p.waitForTimeout(300);
  eq(await p.locator('#askPop.on').count(), 0, 'pop'); await p.evaluate(() => getSelection().removeAllRanges()); });
await t('the stop button asks about that stop', async () => { await p.locator('[data-ask="4"]').click(); has(await p.locator('.ask-pending .ask-about').innerText(), 'stop 5', 'about');
  await p.keyboard.press('Escape'); });
await t('the model choice persists', async () => { await p.reload(); await p.waitForTimeout(400); eq(await p.locator('#askModel button[data-model="sonnet"]').getAttribute('aria-pressed'), 'true', 'sonnet'); });
const nokey = await mk(url.split('#')[0], 1440, 960, 'light', /status of 403/); // the refused ask logs a 403
await t('a tab without the key is told how to fix it', async () => { await select(nokey, 0); await nokey.waitForTimeout(250); await nokey.keyboard.press('a');
  await nokey.locator('.ask-chips button').first().click(); await lastAnswer(nokey); has(await nokey.locator('.ask-err').innerText(), 'Reopen the lesson from the link serve.py printed', 'error'); });
const d = await mk(url, 1920, 1080, 'dark');
await select(d, 1); await d.waitForTimeout(250); await d.keyboard.press('a'); await d.locator('#ask.on').waitFor(); await d.waitForTimeout(400);
await t('wide screens make room for the panel', async () => { const r = await d.evaluate(() => document.querySelector('.page').getBoundingClientRect().right);
  if (r > 1920 - 500) throw new Error('page right edge ' + r); });
await d.screenshot({ path: join(tmp, 'a3-dark-wide.png') });
const m = await mk(url, 390, 844);
await t('phone: panel fills the screen, no sideways scroll', async () => { await select(m, 0); await m.waitForTimeout(250); await m.locator('#askPop').click();
  await m.locator('#ask.on').waitFor(); eq(Math.round((await m.locator('#ask').boundingBox()).width), 390, 'width');
  const w = await m.evaluate(() => document.documentElement.scrollWidth); if (w > 390) throw new Error('scrollWidth ' + w); });
await m.waitForTimeout(400); await m.screenshot({ path: join(tmp, 'a4-phone.png') });
console.log('errors:', errs.length ? errs : 'none'); console.log('screenshots:', tmp);
await b.close(); srv.kill();
process.exit(failed || errs.length ? 1 : 0);
