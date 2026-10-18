// Smoke-test a built lens lesson in headless Chromium, any theme: no JS errors, every trace step opens,
// open guess-first gates get answered, every node opens, no horizontal scroll on a phone.
// Relies only on the selector contract in reference/themes.md. Screenshot saved next to the HTML.
// Usage: node smoke.mjs LESSON.html
import { resolve, dirname, basename } from 'path';
import { getChromium } from './pw.mjs';
const pw = await getChromium();
if (!pw) { console.log('skip: Playwright not found (npm i -g playwright && npx playwright install chromium)'); process.exit(0); }
const file = resolve(process.argv[2]); const url = 'file://' + file;
const b = await pw.launch();
const errs = [];
const p = await b.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && !/fonts\.g/.test(m.text()) && errs.push(m.text()));
await p.goto(url);
await p.evaluate(() => localStorage.clear()); await p.reload();
// Every stop of the current trace: open it, then answer one open guess-first gate if one is showing.
const stops = await p.evaluate(() => new Set([...document.querySelectorAll('[data-lens-stop]')].map(e => e.dataset.lensStop)).size);
let gates = 0;
for (let i = 0; i < stops; i++) {
  await p.locator(`[data-lens-stop="${i}"]:visible`).first().click();
  const gate = p.locator('.choice[data-p="0"]:not(:disabled):visible').first();
  if (await gate.count()) { await gate.click(); gates++; }
}
const nodes = await p.locator('.node').count();
for (let i = 0; i < nodes; i++) await p.locator('.node').nth(i).click();
const shot = resolve(dirname(file), basename(file, '.html') + '.png');
await p.locator('#mapMode button[data-m="route"]').click().catch(() => {});
await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
await p.screenshot({ path: shot });
const m = await b.newPage({ viewport: { width: 390, height: 844 } });
await m.goto(url); await m.waitForTimeout(300);
const sw = await m.evaluate(() => document.documentElement.scrollWidth);
await b.close();
const ok = !errs.length && sw <= 390 && stops > 0 && nodes > 0;
console.log(`${ok ? 'ok' : 'FAIL'}: ${stops} steps, ${gates} gates answered, ${nodes} nodes clicked, mobile width ${sw}px, errors: ${errs.length ? errs.join(' | ') : 'none'}\nscreenshot: ${shot}`);
process.exit(ok ? 0 : 1);
