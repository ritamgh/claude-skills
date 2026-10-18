// Check and gallery for the sketch-theme prop library (assets/themes/parts/props.js).
// (1) contract checks: names unique and >= 32, every alias resolves to a canonical name, resolve(unknown) === null,
//     draw() deterministic and never throws (unknown or odd names), every canonical name has its own icon (not the
//     fallback), no Math.random, size budget, names/alias literals readable by build.py's regex, and in the browser:
//     the drawn ink stays inside the size x size square.
// (2) gallery: every icon with its name underneath, light and dark, at 1440 and 390 px wide; PNG paths printed.
// The pen comes from scenes.js (LensScenes._pen); until that export exists the script patches it in on a copy.
// Usage: node scripts/props-gallery.mjs [outdir]
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os'; import { join, dirname } from 'path'; import { fileURLToPath } from 'url';
import { getChromium } from './pw.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const parts = join(here, '..', 'assets', 'themes', 'parts');
const propsSrc = readFileSync(join(parts, 'props.js'), 'utf8');
let scenesSrc = readFileSync(join(parts, 'scenes.js'), 'utf8');
const patched = !/_pen/.test(scenesSrc);
if (patched) scenesSrc = scenesSrc.replace('return { names: NAMES.slice(), render, blot };', 'return { names: NAMES.slice(), render, blot, _pen: pen };');

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

// ---- node-side checks ----
check(!/Math\.random/.test(propsSrc), 'props.js uses Math.random');
check(propsSrc.length < 40000, `props.js is ${propsSrc.length} bytes (budget 40 KB)`);
const LS = new Function(scenesSrc + '\n;return LensScenes;')();
check(typeof LS._pen === 'function', 'LensScenes._pen is not a function (patch for the pen failed)');
const LP = new Function(propsSrc + '\n;return LensProps;')();
const { names, alias } = LP;
check(names.length >= 32, `only ${names.length} icons, contract wants >= 32`);
check(new Set(names).size === names.length, 'names are not unique');
check(names.every(n => LP.resolve(n) === n), 'a canonical name does not resolve to itself');
for (const [a, c] of Object.entries(alias)) {
  check(names.includes(c), `alias "${a}" points at "${c}", which is not a canonical name`);
  check(LP.resolve(a) === c, `alias "${a}" does not resolve to "${c}"`);
  check(!names.includes(a), `alias "${a}" shadows a canonical name`);
}
for (const u of ['', 'nope', 'zzz', '__proto__', 'constructor', 'toString', null, undefined, 42, {}]) check(LP.resolve(u) === null, `resolve(${JSON.stringify(u)}) should be null, got ${LP.resolve(u)}`);
check(LP.resolve('  Camera ') === 'camera' && LP.resolve('DB') === 'database', 'resolve should ignore case and surrounding spaces');
// build.py reads the two literals with a regex: they must say the same as the running object
const arr = (propsSrc.match(/names:\s*\[([^\]]*)\]/) || [])[1] || '';
const obj = (propsSrc.match(/alias:\s*\{([^}]*)\}/) || [])[1] || '';
check(JSON.stringify([...arr.matchAll(/'([^']+)'/g)].map(m => m[1])) === JSON.stringify(names), 'names: [...] literal is not plain single-quoted strings');
check(JSON.stringify([...obj.matchAll(/(?:^|[,{\s])'?([a-z0-9_-]+)'?\s*:\s*'([a-z]+)'/g)].map(m => [m[1], m[2]])) === JSON.stringify(Object.entries(alias)), 'alias: {...} literal is not plain key: \'canonical\' pairs');

const run = (name, seed = 'x', size = 90) => { const p = LS._pen(hash(seed)); LP.draw(p, name, 60, 60, size); return p.out.join(''); };
const odd = ['nope', '', null, undefined, 42, {}, [], '__proto__', 'constructor'];
for (const n of odd) { try { check(run(n).length > 0, `draw(${JSON.stringify(n)}) drew nothing`); } catch (e) { check(false, `draw(${JSON.stringify(n)}) threw: ${e.message}`); } }
for (const bad of [[NaN, 5, 0], [10, undefined, -4], ['a', 'b', 'c']]) {
  try { const p = LS._pen(1); LP.draw(p, 'camera', ...bad); check(!/NaN|undefined/.test(p.out.join('')), `draw with ${JSON.stringify(bad)} wrote NaN/undefined`); } catch (e) { check(false, `draw with ${JSON.stringify(bad)} threw: ${e.message}`); }
}
const fallback = run('zzz-unknown');
for (const n of names) {
  const a = run(n); check(a === run(n), `${n}: draw is not deterministic`);
  check(a !== fallback, `${n}: drew the fallback box, it has no icon of its own`);
  check(a.length > 600, `${n}: suspiciously little ink (${a.length} chars)`);
  check(!/NaN|undefined/.test(a), `${n}: output contains NaN/undefined`);
  const acc = ['--red', '--orange', '--blue'].filter(v => a.includes(`var(${v},`));
  check(acc.length <= 1, `${n}: uses ${acc.length} accent colours (${acc.join(', ')}), max is one`);
  check(!/https?:|<image|href=/.test(a), `${n}: output references something external`);
}
// the pen RNG is shared: drawing the same icon after another thing must still be deterministic given the same seed
check(run('camera', 'seed-1') === run('camera', 'seed-1') && run('camera', 'seed-1') !== run('camera', 'seed-2'), 'different seeds should give different wobble, same seed identical');

// ---- browser checks + gallery ----
const pw = await getChromium();
if (!pw) { console.log('skip: Playwright not found (npm i -g playwright && npx playwright install chromium)'); if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  ')); process.exit(fails.length ? 1 : 0); }
const out = process.argv[2] || mkdtempSync(join(tmpdir(), 'lens-props-'));
mkdirSync(out, { recursive: true });
const THEMES = {
  light: 'body{background:#fff;--ink:#111;--paper:#fff;--red:#d93a2b;--orange:#e8820c;--blue:#2b6fd9;color:#111}',
  dark: 'body{background:#0f0f10;--ink:#ececec;--paper:#0f0f10;--red:#ff6b5b;--orange:#ffa63d;--blue:#6aa5ff;color:#ececec}'
};
const cell = n => { const p = LS._pen(hash('gallery|' + n)); LP.draw(p, n, 60, 60, 90); return `<figure><svg viewBox="0 0 120 120" style="stroke-linecap:round;stroke-linejoin:round"><rect x="15" y="15" width="90" height="90" class="sq"/>${p.out.join('')}</svg><figcaption>${n}</figcaption></figure>`; };
const page = theme => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${THEMES[theme]}*{box-sizing:border-box}body{margin:0;padding:12px;font:14px system-ui,sans-serif}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px}
figure{margin:0;text-align:center}figure svg{display:block;width:100%;height:auto}.sq{fill:none;stroke:currentColor;stroke-opacity:.14;stroke-dasharray:3 3}
figcaption{opacity:.7;margin-top:2px}</style></head><body><div class="grid">${names.map(cell).join('')}</div></body></html>`;
const files = {};
for (const t of Object.keys(THEMES)) { files[t] = join(out, `props-${t}.html`); writeFileSync(files[t], page(t)); }

const b = await pw.launch();
const errs = [];
const p0 = await b.newPage({ viewport: { width: 1440, height: 900 } });
p0.on('pageerror', e => errs.push(e.message));
await p0.setContent(`<!doctype html><body><script>${scenesSrc}</script><script>${propsSrc}</script></body>`);
const res = await p0.evaluate(({ names, odd }) => {
  const bad = [], worst = {};
  const ns = 'http://www.w3.org/2000/svg';
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  for (const name of names.concat(['zzz-unknown'])) for (const size of [90, 60]) for (const [cx, cy] of [[320, 180], [60, 40]]) {
    const pen = LensScenes._pen(hash(name + size));
    LensProps.draw(pen, name, cx, cy, size);
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 640 360'); svg.setAttribute('width', 640); svg.setAttribute('height', 360);
    svg.setAttribute('style', 'stroke-linecap:round;stroke-linejoin:round'); svg.innerHTML = pen.out.join(''); document.body.append(svg);
    const g = svg.getBBox(), pad = size / 2, tol = 2.5; // ink may stray a pen-stroke past the square (hand overshoot), no more
    const over = Math.max(cx - pad - g.x, g.x + g.width - (cx + pad), cy - pad - g.y, g.y + g.height - (cy + pad));
    worst[size] = Math.max(worst[size] || -99, over);
    if (over > tol) bad.push(`${name} @${size}: ink strays ${over.toFixed(1)}px outside its square (x ${g.x.toFixed(1)}..${(g.x + g.width).toFixed(1)}, y ${g.y.toFixed(1)}..${(g.y + g.height).toFixed(1)} vs centre ${cx},${cy})`);
    if (g.width < size * .45 || g.height < size * .3) bad.push(`${name} @${size}: icon is only ${g.width.toFixed(0)}x${g.height.toFixed(0)}px, too small to read`);
    svg.remove();
  }
  return { bad, worst };
}, { names, odd: [] });
res.bad.forEach(m => fails.push(m));

const shots = [];
for (const [t, file] of Object.entries(files)) for (const width of [1440, 390]) {
  const pg = await b.newPage({ viewport: { width, height: 900 } });
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('file://' + file); await pg.waitForTimeout(100);
  const sw = await pg.evaluate(() => document.documentElement.scrollWidth);
  check(sw <= width, `${t} gallery scrolls horizontally at ${width}px (${sw}px)`);
  const shot = join(out, `props-${t}-${width}.png`);
  await pg.screenshot({ path: shot, fullPage: true }); shots.push(shot);
  await pg.close();
}
await b.close();
errs.forEach(e => fails.push('page error: ' + e));
console.log(`${names.length} icons, ${Object.keys(alias).length} aliases${patched ? ' (pen patched into a copy of scenes.js: LensScenes._pen not exported yet)' : ''}`);
console.log(`ink beyond the square at worst: ${Object.entries(res.worst).map(([s, o]) => `${o.toFixed(1)}px @${s}`).join(', ')}`);
shots.forEach(s => console.log('screenshot: ' + s));
if (fails.length) { console.log(`FAIL (${fails.length}):\n  ` + fails.slice(0, 40).join('\n  ')); process.exit(1); }
console.log('ok: props contract holds');
