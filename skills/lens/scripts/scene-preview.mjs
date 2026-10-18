// The author's feedback loop for a bespoke drawing (scene.draw): render it in a real browser with the sketch theme's colours and the
// Caveat handwriting, write the PNG, and print a short JSON verdict: is every label at least 11px at a 358px plate, do labels collide
// with each other or with drawn things, does anything leave the frame, which ops were not understood.
// Usage: node scripts/scene-preview.mjs spec.json [out.png] [--dark] [--w 640]
//   spec.json: one scene object {caption, draw: [...]}, an array of them, or {scenes: [...]}.
//   out.png:   default <tmp>/lens-preview/<spec name>.png ; several scenes get -1, -2, ... before the extension.
//   --dark:    the blackboard theme.  --w: width of the PNG in px (default 640).
// stdout: {"font": ..., "scenes": [{ok, caption, textMinPx, overlaps, outside, unknownOps, warnings, png}]}; exit 1 when some scene is not ok.
// The network is used once, for the Caveat font, with a 4 second limit; offline the fallback font is measured and the output says so.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os'; import { join, dirname, basename } from 'path'; import { fileURLToPath } from 'url';
import { getChromium } from './pw.mjs';

const here = dirname(fileURLToPath(import.meta.url)), parts = join(here, '..', 'assets', 'themes', 'parts');
const args = process.argv.slice(2), flag = n => args.includes(n), val = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const pos = []; for (let i = 0; i < args.length; i++) { if (args[i] === '--w') i++; else if (!args[i].startsWith('--')) pos.push(args[i]); }
const specFile = pos[0];
if (!specFile) { console.error('usage: node scripts/scene-preview.mjs spec.json [out.png] [--dark] [--w 640]'); process.exit(2); }
const dark = flag('--dark'), W = Math.max(200, Math.min(2000, Number(val('--w')) || 640));
setTimeout(() => { console.error('scene-preview: gave up after 90 s'); process.exit(2); }, 90000).unref();

let raw; try { raw = JSON.parse(readFileSync(specFile, 'utf8')); } catch (e) { console.error(`scene-preview: cannot read ${specFile}: ${e.message}`); process.exit(2); }
const scenes = Array.isArray(raw) ? raw : Array.isArray(raw?.scenes) ? raw.scenes : [raw];
const outBase = pos[1] || join(tmpdir(), 'lens-preview', basename(specFile).replace(/\.json$/i, '') + '.png');
mkdirSync(dirname(outBase), { recursive: true });
const outFile = i => scenes.length === 1 ? outBase : outBase.replace(/(\.png)?$/i, `-${i + 1}.png`);

const THEMES = {
  light: '--ink:#111;--paper:#fff;--blot:#111;--blot-eye:#fff;--red:#d93a2b;--orange:#e8820c;--blue:#2b6fd9;background:#fff;color:#111',
  dark: '--ink:#ececec;--paper:#0f0f10;--blot:#ececec;--blot-eye:#0f0f10;--red:#ff6b5b;--orange:#ffa63d;--blue:#6aa5ff;background:#0f0f10;color:#ececec'
};
// Caveat from Google Fonts, inlined so nothing in the page can stall on the network; null when it cannot be had in time
async function caveatCss() {
  try {
    const sig = AbortSignal.timeout(4000), css = await (await fetch('https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&display=swap', { signal: sig, headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } })).text();
    let out = css; for (const u of new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))) { const b = Buffer.from(await (await fetch(u, { signal: sig })).arrayBuffer()); out = out.split(u).join(`data:font/woff2;base64,${b.toString('base64')}`); }
    return out;
  } catch { return null; }
}

const pw = await getChromium();
if (!pw) { console.error('scene-preview: Playwright not found (npm i -g playwright && npx playwright install chromium)'); process.exit(2); }
const font = await caveatCss();
const browser = await pw.launch({ args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: W + 40, height: Math.round(W * 9 / 16) + 40 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
await page.setContent(`<!doctype html><meta charset="utf-8"><style>${font || ''}html,body{margin:0}body{${THEMES[dark ? 'dark' : 'light']};padding:20px}#host{width:${W}px;font-family:'Caveat',cursive}#host svg{display:block;width:${W}px;height:auto}</style><div id="host"></div>`);
await page.addScriptTag({ content: readFileSync(join(parts, 'props.js'), 'utf8') + '\n' + readFileSync(join(parts, 'scenes.js'), 'utf8') + '\nwindow.LensScenes = LensScenes;' });
await page.evaluate(async () => { try { await document.fonts.load("700 20px Caveat"); } catch {} });
const caveat = await page.evaluate(() => document.fonts.check('700 20px Caveat'));

// measure one scene inside the page
const measure = async scene => page.evaluate(async scene => {
  const rep = {}, res = { overlaps: [], outside: [], unknownOps: [], warnings: [] };
  let svgText = '';
  try { svgText = LensScenes.draw(scene, { report: rep }); } catch (e) { return { ...res, ok: false, error: 'draw threw: ' + e.message }; }
  const host = document.getElementById('host'); host.innerHTML = svgText;
  const svg = host.firstElementChild, scale = svg.getBoundingClientRect().width / 640, box = svg.getBoundingClientRect();
  const gridOf = (x, y) => `(${Math.round(x / 4) / 10},${Math.round(y / 4) / 10})`;
  const probe = document.createElement('i'); probe.style.background = 'var(--paper)'; host.append(probe); const paper = getComputedStyle(probe).backgroundColor; probe.remove();
  const texts = [...svg.querySelectorAll('text')].map(t => {
    const b = t.getBBox(), r = t.getBoundingClientRect(), fs = parseFloat(getComputedStyle(t).fontSize), k = r.height * .22;
    return { s: t.textContent, fs, onInk: getComputedStyle(t).fill === paper, bb: { x: b.x, y: b.y + fs * .2, w: b.width, h: b.height - fs * .35 }, r: { l: (r.left - box.left) / scale, r: (r.right - box.left) / scale, t: (r.top - box.top + k) / scale, b: (r.bottom - box.top - k) / scale }, raw: r };
  });
  res.textMinPx = texts.length ? Math.round(Math.min(...texts.map(t => t.fs)) * 358 / 640 * 10) / 10 : null;
  // the picture without its text, on white: a pixel is ink when it is drawn and not the paper fill
  const c = svg.cloneNode(true); c.querySelectorAll('text').forEach(t => t.remove()); c.setAttribute('width', 640); c.setAttribute('height', 360);
  let str = new XMLSerializer().serializeToString(c); for (let k = 0; k < 4; k++) str = str.replace(/var\(--[a-z-]+,([^()]*)\)/g, (m, d) => d);
  const img = new Image(); await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str); });
  const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360; const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, 640, 360);
  const d = cx.getImageData(0, 0, 640, 360).data, inkAt = (x, y) => { const i = (y * 640 + x) * 4; return d[i + 3] > 100 && Math.min(d[i], d[i + 1], d[i + 2]) < 200; };
  const objs = (rep.objects || []).map(o => ({ ...o, X: o.x * 40, Y: o.y * 40, Wd: o.w * 40, H: o.h * 40 }));
  const nameOf = o => o.id ? `${o.k} '${o.id}'` : o.label ? `${o.k} '${o.label}'` : `${o.k} at ${gridOf(o.X, o.Y)}`;
  const seen = new Set(), say = (list, m) => { if (!seen.has(m)) { seen.add(m); list.push(m); } };
  texts.forEach((t, i) => {
    // text on text
    texts.forEach((u, j) => { if (j > i && t.r.l < u.r.r - 1 && u.r.l < t.r.r - 1 && t.r.t < u.r.b - 1 && u.r.t < t.r.b - 1) say(res.overlaps, `text '${t.s}' overlaps text '${u.s}' at grid ${gridOf((Math.max(t.r.l, u.r.l) + Math.min(t.r.r, u.r.r)) / 2, (Math.max(t.r.t, u.r.t) + Math.min(t.r.b, u.r.b)) / 2)}`); });
    // text on drawn ink
    const x0 = Math.max(0, Math.floor(t.bb.x + 2)), x1 = Math.min(640, Math.ceil(t.bb.x + t.bb.w - 2)), y0 = Math.max(0, Math.floor(t.bb.y)), y1 = Math.min(360, Math.ceil(t.bb.y + t.bb.h));
    let ink = 0, tot = 0, sx = 0, sy = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { tot++; if (inkAt(x, y)) { ink++; sx += x; sy += y; } }
    if (!t.onInk && tot && ink / tot > .012) {   // paper-coloured text is meant to sit on an ink-filled box
      const mx = sx / ink, my = sy / ink, hit = objs.filter(o => o.label !== t.s && o.k !== 'text' && o.k !== 'arrow label' && mx > o.X - 6 && mx < o.X + o.Wd + 6 && my > o.Y - 6 && my < o.Y + o.H + 6);
      say(res.overlaps, `text '${t.s}' ${hit.length ? 'overlaps ' + nameOf(hit[0]) : 'sits on a drawn line'} at grid ${gridOf(mx, my)}`);
    }
    if (t.r.l < -.5 || t.r.r > 640.5 || t.r.t < -.5 || t.r.b > 360.5) say(res.outside, `text '${t.s}' leaves the frame`);
  });
  for (const p of svg.querySelectorAll('path')) { const r = p.getBoundingClientRect(); if (r.width && (r.left < box.left - 6 * scale || r.right > box.right + 6 * scale || r.top < box.top - 6 * scale || r.bottom > box.bottom + 6 * scale)) { say(res.outside, `a shape near grid ${gridOf((r.left - box.left) / scale, (r.top - box.top) / scale)} leaves the frame`); break; } }
  res.unknownOps = rep.unknownOps || []; res.warnings = rep.warnings || [];
  res.labels = texts.length; return res;
}, scene);

const results = [];
for (let i = 0; i < scenes.length; i++) {
  const sc = scenes[i], m = await measure(sc), png = outFile(i);
  try { await page.locator('#host svg').screenshot({ path: png }); } catch (e) { m.warnings.push('no PNG: ' + e.message.split('\n')[0]); }
  const cut = a => a.length > 10 ? [...a.slice(0, 10), `...and ${a.length - 10} more`] : a;
  if (m.textMinPx != null && m.textMinPx < 11) m.warnings.push(`smallest text is ${m.textMinPx}px at a 358px plate (minimum 11)`);
  const ok = !m.error && !m.overlaps.length && !m.outside.length && !m.unknownOps.length && !(m.textMinPx != null && m.textMinPx < 11);
  results.push({ ok, caption: String(sc?.caption ?? '').slice(0, 60), textMinPx: m.textMinPx, overlaps: cut(m.overlaps), outside: cut(m.outside), unknownOps: m.unknownOps, warnings: cut(m.warnings), ...(m.error ? { error: m.error } : {}), png });
}
await browser.close();
const fontNote = caveat ? 'Caveat' : 'fallback (Caveat could not be loaded: widths are approximate, real Caveat is narrower)';
console.log(`{"font": ${JSON.stringify(fontNote)}, "theme": "${dark ? 'dark' : 'light'}", "scenes": [\n${results.map(r => ' ' + JSON.stringify(r)).join(',\n')}\n]}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
