// Lens prop library (sketch theme): hand-drawn icons for the THINGS and PLACES a lesson talks about
// (a camera, a database, a queue of jobs...). Plain browser script, global `LensProps`, no DOM access.
// draw(p, name, cx, cy, size) pushes SVG into the pen `p` from scenes.js (LensScenes._pen), inside a size x size
// square centred on cx,cy. It draws no label: the caller labels. Deterministic: all wobble comes from the pen's
// seeded PRNG. Colours are the same CSS variables as scenes.js: INK and PAPER plus at most one accent per icon.
// Keep `names:` and `alias:` below plain literals (single-quoted, no nesting): build.py reads them with a regex.
const LensProps = (() => {
  const INK = 'var(--ink,#111)', PAPER = 'var(--paper,#fff)', RED = 'var(--red,#d93a2b)', ORANGE = 'var(--orange,#e8820c)', BLUE = 'var(--blue,#2b6fd9)';
  const f = v => Math.round(v * 10) / 10;
  const RAD = Math.PI / 180;
  const pol = (r, deg, cx = 0, cy = 0) => [cx + Math.cos(deg * RAD) * r, cy + Math.sin(deg * RAD) * r];
  const arc = (cx, cy, r, a0, a1, n = 9) => Array.from({ length: n + 1 }, (_, i) => pol(r, a0 + (a1 - a0) * i / n, cx, cy));

  const lib = {
    names: ['camera', 'phone', 'mic', 'speaker', 'headphones', 'monitor', 'laptop', 'terminal', 'keyboard', 'browser',
      'file', 'folder', 'log', 'package', 'database', 'stack', 'server', 'cloud', 'network', 'globe',
      'chip', 'gear', 'process', 'model', 'braces', 'sensor', 'dial', 'clock', 'bell', 'envelope',
      'key', 'lock', 'shield', 'user', 'eye', 'magnifier', 'battery'],
    alias: {
      cam: 'camera', webcam: 'camera', video: 'camera', iphone: 'phone', mobile: 'phone', smartphone: 'phone',
      microphone: 'mic', audio: 'mic', speakers: 'speaker', sound: 'speaker', headset: 'headphones',
      screen: 'monitor', display: 'monitor', desktop: 'monitor', computer: 'laptop', pc: 'laptop', machine: 'laptop',
      shell: 'terminal', cli: 'terminal', console: 'terminal', kbd: 'keyboard', keys: 'keyboard', tab: 'browser', window: 'browser',
      doc: 'file', document: 'file', config: 'file', dir: 'folder', directory: 'folder', logs: 'log', journal: 'log', trace: 'log', events: 'log',
      pkg: 'package', box: 'package', bundle: 'package', db: 'database', sqlite: 'database', sql: 'database', storage: 'database', store: 'database',
      layers: 'stack', pile: 'stack', backend: 'server', host: 'server', service: 'server', internet: 'cloud', remote: 'cloud',
      graph: 'network', mesh: 'network', web: 'globe', world: 'globe', cpu: 'chip', processor: 'chip', hardware: 'chip',
      settings: 'gear', cog: 'gear', engine: 'gear', daemon: 'process', job: 'process', task: 'process', worker: 'process', loop: 'process', pipeline: 'process',
      llm: 'model', ai: 'model', neural: 'model', json: 'braces', code: 'braces', schema: 'braces',
      probe: 'sensor', signal: 'sensor', detector: 'sensor', gauge: 'dial', meter: 'dial', threshold: 'dial', knob: 'dial',
      timer: 'clock', time: 'clock', schedule: 'clock', alert: 'bell', notification: 'bell', notify: 'bell',
      mail: 'envelope', email: 'envelope', message: 'envelope', secret: 'key', token: 'key', credential: 'key', password: 'lock', private: 'lock',
      security: 'shield', guard: 'shield', firewall: 'shield', person: 'user', human: 'user', people: 'user', you: 'user',
      vision: 'eye', view: 'eye', see: 'eye', search: 'magnifier', find: 'magnifier', lookup: 'magnifier', power: 'battery', energy: 'battery'
    },
    resolve, draw
  };

  function resolve(name) {
    const k = String(name == null ? '' : name).trim().toLowerCase();
    if (!k || k === '__proto__') return null;
    if (lib.names.includes(k)) return k;
    return Object.prototype.hasOwnProperty.call(lib.alias, k) ? lib.alias[k] : null;
  }

  // smooth closed path through points: quadratic segments between midpoints (same trick as scenes.js)
  function qclosed(q) {
    const n = q.length, m = i => [(q[i % n][0] + q[(i + 1) % n][0]) / 2, (q[i % n][1] + q[(i + 1) % n][1]) / 2];
    let s = m(n - 1), d = `M${f(s[0])} ${f(s[1])}`;
    for (let i = 0; i < n; i++) { const e = m(i); d += `Q${f(q[i][0])} ${f(q[i][1])} ${f(e[0])} ${f(e[1])}`; }
    return d + 'Z';
  }

  // Each icon is drawn on a -1..1 grid (y down) and kept inside about +-.85 so pen overshoot stays in the square.
  // d: ln/cv/pg/blob/rr/rc/ov/dot/arrow helpers in grid units, d.w the base line width, d.p the raw pen.
  const ICONS = {
    camera(d) {
      d.pg([[-.3, -.38], [-.18, -.66], [.22, -.66], [.34, -.38]], true);
      d.rr(-.82, -.4, 1.64, 1.1, .12);
      d.ov(0, .16, .42, .42, { fill: PAPER }); d.ov(0, .16, .19, .19, { c: BLUE, fill: BLUE, passes: 1 });
      d.dot(.62, -.2, .06, INK);
    },
    phone(d) {
      d.rr(-.42, -.85, .84, 1.7, .14);
      d.ln(-.1, -.68, .1, -.68, INK, d.w * .8, { passes: 1 }); d.ov(0, .67, .07, .07, { passes: 1 });
      d.ln(-.2, -.35, .2, -.35, BLUE, d.w * .9, { passes: 1 }); d.ln(-.2, -.12, .08, -.12, BLUE, d.w * .9, { passes: 1 });
      d.ln(-.2, .11, .15, .11, INK, d.w * .7, { passes: 1 });
    },
    mic(d) {
      d.cv([[-.52, -.12], [-.5, .25], [-.2, .52], [0, .56], [.2, .52], [.5, .25], [.52, -.12]]);
      d.ln(0, .56, 0, .8); d.ln(-.32, .8, .32, .8);
      d.blob([[0, -.84], [.2, -.78], [.26, -.55], [.26, -.1], [.2, .12], [0, .18], [-.2, .12], [-.26, -.1], [-.26, -.55], [-.2, -.78]]);
      d.ln(-.26, -.48, .26, -.48, INK, d.w * .6, { passes: 1 }); d.ln(-.26, -.22, .26, -.22, INK, d.w * .6, { passes: 1 });
      d.dot(.62, -.66, .1, RED);
    },
    speaker(d) {
      d.rc(-.82, -.26, .38, .52);
      d.pg([[-.44, -.26], [.02, -.68], [.02, .68], [-.44, .26]], true);
      d.cv(arc(.0, 0, .36, -48, 48, 4), ORANGE, d.w, { passes: 1 });
      d.cv(arc(.0, 0, .66, -52, 52, 5), ORANGE, d.w, { passes: 1 });
    },
    headphones(d) {
      d.cv([[-.66, .12], [-.66, -.3], [-.38, -.7], [0, -.8], [.38, -.7], [.66, -.3], [.66, .12]], INK, d.w * 1.3);
      d.rr(-.84, -.02, .36, .66, .12); d.rr(.48, -.02, .36, .66, .12);
      d.ln(-.58, .12, -.58, .5, BLUE, d.w, { passes: 1 }); d.ln(.58, .12, .58, .5, BLUE, d.w, { passes: 1 });
    },
    monitor(d) {
      d.rr(-.85, -.72, 1.7, 1.14, .06);
      d.cv([[-.6, .2], [-.34, -.12], [-.08, .1], [.22, -.32], [.6, -.12]], BLUE, d.w, { passes: 1 });
      d.ln(0, .42, 0, .66); d.ln(-.36, .72, .36, .72);
    },
    laptop(d) {
      d.rr(-.62, -.72, 1.24, .9, .06);
      d.ln(-.38, -.35, .3, -.35, BLUE, d.w, { passes: 1 }); d.ln(-.38, -.12, .05, -.12, INK, d.w * .7, { passes: 1 });
      d.pg([[-.7, .3], [.7, .3], [.88, .66], [-.88, .66]], true);
      d.ln(-.14, .46, .14, .46, INK, d.w * .6, { passes: 1 });
    },
    terminal(d) {
      d.rr(-.86, -.72, 1.72, 1.44, .08);
      d.ln(-.86, -.42, .86, -.42, INK, d.w * .8, { passes: 1 });
      [-.66, -.5, -.34].forEach(x => d.dot(x, -.57, .035, INK));
      d.cv([[-.6, -.14], [-.26, .08], [-.6, .3]], BLUE, d.w * 1.2, { passes: 1 });
      d.ln(-.08, .32, .34, .32, INK, d.w * 1.1, { passes: 1 });
    },
    keyboard(d) {
      d.rr(-.9, -.5, 1.8, 1.0, .08);
      for (let r = 0; r < 2; r++) for (let c = 0; c < 6; c++) d.rc(-.72 + c * .26, -.34 + r * .27, .16, .16, PAPER, d.w * .55);
      d.rc(-.46, .2, .92, .15, BLUE, d.w * .55);
    },
    browser(d) {
      d.rr(-.86, -.72, 1.72, 1.44, .08);
      d.ln(-.86, -.4, .86, -.4, INK, d.w * .8, { passes: 1 });
      [-.7, -.56].forEach(x => d.dot(x, -.56, .035, INK));
      d.rr(-.38, -.62, 1.14 - .16, .17, .08, PAPER, BLUE, d.w * .8);
      d.rc(-.64, -.14, .5, .5, PAPER, d.w * .7);
      d.ln(-.02, -.08, .62, -.08, INK, d.w * .7, { passes: 1 }); d.ln(-.02, .14, .62, .14, INK, d.w * .7, { passes: 1 }); d.ln(-.02, .36, .4, .36, INK, d.w * .7, { passes: 1 });
    },
    file(d) {
      d.pg([[-.58, -.85], [.2, -.85], [.58, -.47], [.58, .85], [-.58, .85]], true);
      d.cv([[.2, -.85], [.2, -.47], [.58, -.47]], INK, d.w * .9, { passes: 1 });
      d.ln(-.34, -.1, .34, -.1, BLUE, d.w, { passes: 1 }); d.ln(-.34, .15, .34, .15, INK, d.w * .8, { passes: 1 }); d.ln(-.34, .4, .12, .4, INK, d.w * .8, { passes: 1 });
    },
    folder(d) {
      d.pg([[-.86, -.56], [-.3, -.56], [-.1, -.34], [.86, -.34], [.86, .7], [-.86, .7]], true);
      d.pg([[-.86, -.08], [.86, -.08], [.78, .7], [-.78, .7]], true);
      d.ln(-.86, -.08, .86, -.08, ORANGE, d.w * 1.1, { passes: 1 });
    },
    log(d) {
      d.rr(-.78, -.82, 1.56, 1.64, .08);
      [[-.5, .5], [-.22, .26], [.06, .6, RED], [.34, .38], [.62, .18]].forEach(([y, len, col]) => {
        d.dot(-.54, y, .05, col || INK);
        d.ln(-.38, y, -.38 + len, y, col || INK, d.w * .8, { passes: 1 });
      });
    },
    package(d) {
      d.pg([[-.82, -.4], [0, 0], [0, .84], [-.82, .44]], true);
      d.pg([[0, 0], [.82, -.4], [.82, .44], [0, .84]], true);
      d.pg([[0, -.84], [.82, -.4], [0, 0], [-.82, -.4]], true);
      d.ln(-.41, -.62, .41, -.2, BLUE, d.w * 1.4, { passes: 1 });
    },
    database(d) {
      d.fill([[-.66, -.52], [-.66, .54], [-.3, .74], [.3, .74], [.66, .54], [.66, -.52]]);
      d.ln(-.66, -.52, -.66, .54); d.ln(.66, -.52, .66, .54);
      d.cv([[-.66, .54], [-.3, .76], [.3, .76], [.66, .54]]);
      d.cv([[-.66, -.1], [-.3, .1], [.3, .1], [.66, -.1]], BLUE, d.w, { passes: 1 });
      d.cv([[-.66, .22], [-.3, .42], [.3, .42], [.66, .22]], BLUE, d.w, { passes: 1 });
      d.ov(0, -.52, .66, .24, { fill: PAPER });
    },
    stack(d) {
      [.42, .02].forEach(c => d.pg([[0, c - .36], [.84, c], [0, c + .36], [-.84, c]], true));
      d.pg([[0, -.76], [.84, -.4], [0, -.04], [-.84, -.4]], true, PAPER, BLUE);
    },
    server(d) {
      [-.84, -.28, .28].forEach((y, i) => {
        d.rr(-.82, y, 1.64, .55, .06);
        d.dot(-.6, y + .275, .06, i ? INK : BLUE);
        d.ln(-.2, y + .275, .6, y + .275, INK, d.w * .7, { passes: 1 });
      });
    },
    cloud(d) {
      d.blob([[-.7, .46], [-.86, .12], [-.62, -.2], [-.3, -.22], [-.12, -.6], [.26, -.66], [.5, -.3], [.8, -.16], [.86, .22], [.62, .46]]);
    },
    network(d) {
      const N = { a: [-.66, -.46], b: [.62, -.56], c: [0, .02], e: [-.5, .62], g: [.68, .46] };
      [['a', 'c'], ['b', 'c'], ['c', 'e'], ['c', 'g'], ['a', 'e'], ['b', 'g']].forEach(([s, t]) => d.ln(...N[s], ...N[t], INK, d.w * .9, { passes: 1 }));
      Object.entries(N).forEach(([k, [x, y]]) => k === 'c' ? d.ov(x, y, .22, .22, { c: BLUE, fill: BLUE }) : d.ov(x, y, .16, .16, { fill: PAPER }));
    },
    globe(d) {
      d.ov(0, 0, .8, .8, { fill: PAPER });
      d.ov(0, 0, .34, .8, { c: BLUE, passes: 1 });
      d.ln(-.8, 0, .8, 0, INK, d.w * .8, { passes: 1 });
      d.cv([[-.7, -.42], [0, -.3], [.7, -.42]], INK, d.w * .8, { passes: 1 }); d.cv([[-.7, .42], [0, .54], [.7, .42]], INK, d.w * .8, { passes: 1 });
    },
    chip(d) {
      [-.28, 0, .28].forEach(o => { d.ln(o, -.5, o, -.78, INK, d.w, { passes: 1 }); d.ln(o, .5, o, .78, INK, d.w, { passes: 1 }); d.ln(-.5, o, -.78, o, INK, d.w, { passes: 1 }); d.ln(.5, o, .78, o, INK, d.w, { passes: 1 }); });
      d.rr(-.5, -.5, 1, 1, .08);
      d.rc(-.24, -.24, .48, .48, PAPER, d.w * .9, BLUE);
    },
    gear(d) {
      const pts = [];
      for (let i = 0; i < 8; i++) { const b = i * 45; pts.push(pol(.6, b - 17), pol(.84, b - 9), pol(.84, b + 9), pol(.6, b + 17)); }
      d.pg(pts, true);
      d.ov(0, 0, .24, .24, { c: ORANGE, fill: PAPER });
    },
    process(d) {
      d.arrow(arc(0, 0, .6, 205, 335, 7), INK, d.w * 1.1); d.arrow(arc(0, 0, .6, 25, 155, 7), INK, d.w * 1.1);
      d.pg([[-.1, -.2], [.22, 0], [-.1, .2]], true, BLUE, BLUE);
    },
    model(d) {
      const L = [[-.72, [-.5, 0, .5]], [0, [-.66, -.22, .22, .66]], [.72, [-.28, .28]]];
      for (let i = 0; i < 2; i++) L[i][1].forEach(y1 => L[i + 1][1].forEach(y2 => d.ln(L[i][0], y1, L[i + 1][0], y2, INK, d.w * .45, { passes: 1 })));
      L.forEach(([x, ys], i) => ys.forEach(y => d.ov(x, y, .13, .13, i === 2 ? { c: BLUE, fill: BLUE } : { fill: PAPER })));
    },
    braces(d) {
      const L = [[-.12, -.8], [-.4, -.74], [-.44, -.42], [-.44, -.12], [-.76, 0], [-.44, .12], [-.44, .42], [-.4, .74], [-.12, .8]];
      d.cv(L, INK, d.w * 1.3); d.cv(L.map(([x, y]) => [-x, y]), INK, d.w * 1.3);
      d.dot(0, 0, .1, BLUE);
    },
    sensor(d) {
      d.cv(arc(-.55, .55, .3, -88, -2, 5), ORANGE, d.w, { passes: 1 });
      d.cv(arc(-.55, .55, .58, -88, -2, 6), ORANGE, d.w, { passes: 1 });
      d.cv(arc(-.55, .55, .86, -88, -2, 7), ORANGE, d.w, { passes: 1 });
      d.ov(-.55, .55, .13, .13, { c: INK, fill: INK, passes: 1 });
    },
    dial(d) {
      d.cv(arc(0, .1, .78, 150, 390, 12), INK, d.w * 1.2);
      for (let i = 0; i <= 6; i++) { const a = 150 + 40 * i; d.ln(...pol(.58, a, 0, .1), ...pol(.7, a, 0, .1), INK, d.w * .8, { passes: 1 }); }
      d.ln(0, .1, ...pol(.52, 305, 0, .1), BLUE, d.w * 1.3, { passes: 1 });
      d.ov(0, .1, .09, .09, { c: INK, fill: INK, passes: 1 });
    },
    clock(d) {
      d.ov(0, 0, .8, .8, { fill: PAPER });
      [0, 90, 180, 270].forEach(a => d.ln(...pol(.6, a), ...pol(.72, a), INK, d.w, { passes: 1 }));
      d.ln(0, 0, 0, -.5, BLUE, d.w * 1.2, { passes: 1 }); d.ln(0, 0, .34, .16, INK, d.w * 1.5, { passes: 1 });
      d.dot(0, 0, .05, INK);
    },
    bell(d) {
      d.blob([[0, -.74], [-.3, -.56], [-.38, -.14], [-.52, .24], [-.78, .48], [.78, .48], [.52, .24], [.38, -.14], [.3, -.56]]);
      d.ov(0, .68, .13, .11, { fill: PAPER });
      d.dot(.5, -.56, .17, RED);
    },
    envelope(d) {
      d.rc(-.85, -.56, 1.7, 1.12);
      d.cv([[-.85, -.56], [0, .12], [.85, -.56]], INK, d.w, { passes: 1 });
      d.ln(-.85, .56, -.22, -.02, INK, d.w * .7, { passes: 1 }); d.ln(.85, .56, .22, -.02, INK, d.w * .7, { passes: 1 });
      d.dot(0, .2, .09, RED);
    },
    key(d) {
      d.ln(-.2, -.2, .74, .74);
      d.ln(.42, .42, .64, .2, INK, d.w, { passes: 1 }); d.ln(.6, .58, .82, .36, INK, d.w, { passes: 1 });
      d.ov(-.46, -.46, .34, .34, { fill: PAPER }); d.ov(-.46, -.46, .12, .12, { c: ORANGE, passes: 1 });
    },
    lock(d) {
      d.cv([[-.36, -.08], [-.36, -.5], [-.18, -.8], [.18, -.8], [.36, -.5], [.36, -.08]], INK, d.w * 1.2);
      d.rr(-.62, -.1, 1.24, .92, .1);
      d.ov(0, .28, .1, .1, { c: BLUE, fill: BLUE, passes: 1 }); d.ln(0, .3, 0, .55, BLUE, d.w * 1.2, { passes: 1 });
    },
    shield(d) {
      d.blob([[0, -.84], [.4, -.7], [.72, -.6], [.72, -.1], [.5, .38], [0, .84], [-.5, .38], [-.72, -.1], [-.72, -.6], [-.4, -.7]]);
      d.cv([[-.3, -.02], [-.08, .24], [.32, -.26]], BLUE, d.w * 1.4, { passes: 1 });
    },
    user(d) {
      d.blob([[-.76, .82], [-.72, .42], [-.4, .18], [0, .12], [.4, .18], [.72, .42], [.76, .82]]);
      d.ov(0, -.4, .3, .3, { fill: PAPER });
      d.cv([[-.2, .14], [0, .42], [.2, .14]], BLUE, d.w, { passes: 1 });
    },
    eye(d) {
      d.blob([[-.86, 0], [-.46, -.4], [0, -.56], [.46, -.4], [.86, 0], [.46, .4], [0, .56], [-.46, .4]]);
      d.ov(0, 0, .3, .3, { c: BLUE, fill: BLUE }); d.dot(0, 0, .13, INK); d.dot(.1, -.1, .05, PAPER);
    },
    magnifier(d) {
      d.ln(.2, .2, .8, .8, INK, d.w * 1.9);
      d.ov(-.2, -.2, .52, .52, { fill: PAPER });
      d.cv(arc(-.2, -.2, .3, 200, 260, 3), BLUE, d.w, { passes: 1 });
    },
    battery(d) {
      d.rr(-.86, -.42, 1.54, .84, .1); d.rc(.68, -.14, .16, .28, INK);
      d.rc(-.72, -.26, .32, .52, BLUE, d.w * .7); d.rc(-.3, -.26, .32, .52, BLUE, d.w * .7); d.rc(.12, -.26, .32, .52, PAPER, d.w * .7);
    }
  };

  // fallback for names we do not know: a little carry-case, a rounded box with a handle
  const thing = d => {
    d.cv([[-.22, -.52], [-.22, -.78], [.22, -.78], [.22, -.52]]);
    d.rr(-.72, -.56, 1.44, 1.2, .14);
    d.ln(-.72, -.08, .72, -.08, INK, d.w * .7, { passes: 1 });
  };

  function draw(p, name, cx, cy, size) {
    cx = Number(cx) || 0; cy = Number(cy) || 0; size = Number(size) > 0 ? Number(size) : 90;
    const h = size / 2, w = Math.max(1.5, Math.min(2.6, size * .028));
    const X = u => cx + u * h, Y = u => cy + u * h, S = u => u * h, K = pts => pts.map(([x, y]) => [X(x), Y(y)]);
    const d = {
      p, w,
      ln: (x1, y1, x2, y2, c, ww, o) => p.line(X(x1), Y(y1), X(x2), Y(y2), c || INK, ww || w, o),
      cv: (pts, c, ww, o) => p.curve(K(pts), c || INK, ww || w, o),
      arrow: (pts, c, ww) => p.arrow(K(pts), c || INK, ww || w, S(.24)),
      pg: (pts, closed, fill, c) => p.poly(K(pts), closed, c || INK, w, fill === undefined ? PAPER : fill),
      rc: (x, y, ww, hh, fill, lw, c) => p.rect(X(x), Y(y), S(ww), S(hh), { fill: fill === undefined ? PAPER : fill, w: lw || w, c: c || INK }),
      ov: (x, y, rx, ry, o = {}) => p.oval(X(x), Y(y), S(rx), S(ry), o.c === undefined ? INK : o.c, w, { wob: .02, ...o }),
      dot: (x, y, r, c) => p.oval(X(x), Y(y), S(r), S(r), null, 0, { fill: c, wob: .02 }),
      fill: pts => p.put(qclosed(K(pts)), null, 0, PAPER),
      blob(pts, fill = PAPER, c = INK, ww = w) {
        if (fill) p.put(qclosed(K(pts)), null, 0, fill);
        p.curve(K(pts.concat([pts[0], pts[1]])), c, ww);
      },
      rr(x, y, ww, hh, r, fill = PAPER, c = INK, lw = w) {
        const x2 = x + ww, y2 = y + hh, P = (a, b) => `${f(X(a))} ${f(Y(b))}`;
        if (fill) p.put(`M${P(x + r, y)}L${P(x2 - r, y)}Q${P(x2, y)} ${P(x2, y + r)}L${P(x2, y2 - r)}Q${P(x2, y2)} ${P(x2 - r, y2)}L${P(x + r, y2)}Q${P(x, y2)} ${P(x, y2 - r)}L${P(x, y + r)}Q${P(x, y)} ${P(x + r, y)}Z`, null, 0, fill);
        p.curve(K([[x + r, y], [x2 - r, y], [x2, y + r], [x2, y2 - r], [x2 - r, y2], [x + r, y2], [x, y2 - r], [x, y + r], [x + r, y]]), c, lw);
      }
    };
    (ICONS[resolve(name)] || thing)(d);
  }

  return lib;
})();
