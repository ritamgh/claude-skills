// Lens scene library (sketch theme): 12 hand-drawn SVG scenes starring Blot, the ink-blob mascot.
// Plain browser script, no modules, no DOM access. render() and blot() return SVG markup strings.
// Deterministic: every wobble comes from a seeded PRNG keyed on scene name + caption (no unseeded randomness).
// Colours are CSS variables with fallbacks, so the host theme controls light/dark.
// Optional slots on render(): opts.items (<=4 labelled things: packets, messages, values) and opts.props ([{prop,label}], <=3 labelled
// places/objects drawn through the global LensProps from props.js when present, else a generic box). Absent slots draw today's scene byte for byte.
// context(args) draws the architecture "context plate" for one node (not author-selectable, not in names).
// draw(spec, {w, report}) draws a bespoke picture from a list of ops on a 16 x 9 grid (see drawOps and the draw section below); it never throws and
// is deterministic (seed = the ops + caption). The pen below only gained an optional `dash`; the 12 scenes are untouched.
// Legibility: a plate is shown 280-560 px wide (about 360 px on a phone), so 640 viewBox units shrink by 0.56 or less. No text is drawn
// below FLOOR (20 units = 11 px at that scale): labels widen their boxes, wrap to a second line, move beside the object, or are
// ellipsized (only past the validated 18 characters); they are never shrunk below FLOOR.
const LensScenes = (() => {
  const NAMES = ['carry', 'gate', 'queue', 'fork', 'wall', 'fire', 'store', 'lookup', 'transform', 'wait', 'handoff', 'watch'];
  const INK = 'var(--ink,#111)', PAPER = 'var(--paper,#fff)', RED = 'var(--red,#d93a2b)', ORANGE = 'var(--orange,#e8820c)', BLUE = 'var(--blue,#2b6fd9)';
  const BODY = 'var(--blot,var(--ink,#111))', EYE = 'var(--blot-eye,var(--paper,#fff))';
  const HAND = "var(--hand,'Caveat','Patrick Hand',cursive)";
  const TAU = Math.PI * 2;
  const FLOOR = 20;
  const f = v => Math.round(v * 10) / 10;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // smooth path through points: quadratic segments between midpoints
  function qpath(q) {
    let d = `M${f(q[0][0])} ${f(q[0][1])}`;
    for (let i = 1; i < q.length - 1; i++) d += `Q${f(q[i][0])} ${f(q[i][1])} ${f((q[i][0] + q[i + 1][0]) / 2)} ${f((q[i][1] + q[i + 1][1]) / 2)}`;
    const l = q[q.length - 1]; return d + `L${f(l[0])} ${f(l[1])}`;
  }
  function qclosed(q) {
    const n = q.length, m = i => [(q[i % n][0] + q[(i + 1) % n][0]) / 2, (q[i % n][1] + q[(i + 1) % n][1]) / 2];
    let s = m(n - 1), d = `M${f(s[0])} ${f(s[1])}`;
    for (let i = 0; i < n; i++) { const e = m(i); d += `Q${f(q[i][0])} ${f(q[i][1])} ${f(e[0])} ${f(e[1])}`; }
    return d + 'Z';
  }
  // Catmull-Rom through key points, resampled every ~13 units so the tremor has somewhere to live
  function sample(p) {
    if (p.length === 2) p = [p[0], [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2], p[1]];
    const out = [], n = p.length, g = i => p[Math.max(0, Math.min(n - 1, i))];
    for (let i = 0; i < n - 1; i++) {
      const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2), m = Math.max(1, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 13));
      for (let k = 0; k < m; k++) {
        const t = k / m, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map(j => .5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
      }
    }
    out.push(p[n - 1]); return out;
  }

  // ---------- the pen: every primitive draws two slightly offset passes ----------
  function pen(seed) {
    const r = rng(seed), out = [];
    const J = a => (r() - .5) * 2 * a;
    const put = (d, c, w, fill, dash) => out.push(`<path d="${d}" style="fill:${fill || 'none'}${c ? `;stroke:${c};stroke-width:${f(w)}${dash ? `;stroke-dasharray:${dash}` : ''}` : ''}"/>`);
    const ext = (a, b, d) => { const L = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; return [a[0] + (a[0] - b[0]) / L * d, a[1] + (a[1] - b[1]) / L * d]; };
    function curve(keys, c = INK, w = 2.4, o = {}) {
      const passes = o.passes ?? 2, amp = o.amp ?? 1;
      for (let k = 0; k < passes; k++) {
        const q = keys.map(([x, y]) => [x + J(amp), y + J(amp)]);
        if (!o.exact) { const n = q.length; q[0] = ext(q[0], q[1], -.5 + r() * 2.6); q[n - 1] = ext(q[n - 1], q[n - 2], -.5 + r() * 3.2); }
        const d = sample(q).map(([x, y], i, a) => i && i < a.length - 1 ? [x + J(.45), y + J(.45)] : [x, y]);
        put(qpath(d), c, k ? w * .62 : w, undefined, o.dash);
      }
    }
    function line(x1, y1, x2, y2, c = INK, w = 2.4, o = {}) {
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, bow = J(Math.min(2.6, .4 + L * .012)), t = .4 + r() * .2;
      curve([[x1, y1], [x1 + dx * t - dy / L * bow, y1 + dy * t + dx / L * bow], [x2, y2]], c, w, o);
    }
    function poly(pts, closed, c = INK, w = 2.4, fill) {
      if (fill) put(qpathPoly(pts.map(([x, y]) => [x + J(.8), y + J(.8)])), null, 0, fill);
      const n = pts.length;
      for (let i = 0; i < (closed ? n : n - 1); i++) line(...pts[i], ...pts[(i + 1) % n], c, w);
    }
    const qpathPoly = q => 'M' + q.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z';
    const rect = (x, y, w, h, o = {}) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, o.c ?? INK, o.w ?? 2.4, o.fill ?? PAPER);
    function rbox(cx, cy, w, h, ang, o = {}) {
      const c = Math.cos(ang), s = Math.sin(ang), pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
      poly(pts, true, o.c ?? INK, o.w ?? 2.4, o.fill ?? PAPER); return pts;
    }
    function oval(cx, cy, rx, ry, c = INK, w = 2.4, o = {}) {
      const ph = r() * TAU, ph2 = r() * TAU, wob = o.wob ?? .03, R = a => 1 + wob * Math.sin(2 * a + ph) + wob * .6 * Math.sin(3 * a + ph2);
      const n = Math.max(12, Math.round((rx + ry) * Math.PI / 9));
      if (o.fill) { const pts = []; for (let k = 0; k < n; k++) { const a = k / n * TAU; pts.push([cx + Math.cos(a) * rx * R(a), cy + Math.sin(a) * ry * R(a)]); } put(qclosed(pts), null, 0, o.fill); }
      if (!c) return;
      for (let pass = 0; pass < (o.passes ?? 2); pass++) {
        const a0 = r() * TAU, sweep = TAU + .15 + r() * .35, m = Math.round(n * sweep / TAU), pts = [];
        for (let k = 0; k <= m; k++) { const a = a0 + sweep * k / m, g = 1 + .035 * (k / m - .5) + J(.006); pts.push([cx + Math.cos(a) * rx * R(a) * g, cy + Math.sin(a) * ry * R(a) * g]); }
        put(qpath(pts), c, pass ? w * .62 : w);
      }
    }
    function arrow(keys, c = INK, w = 2.4, size = 13, dash) {
      curve(keys, c, w, { passes: 1, dash });
      const [ex, ey] = keys[keys.length - 1], [px, py] = keys[keys.length - 2], a = Math.atan2(ey - py, ex - px);
      const pt = s => [ex - size * Math.cos(a + s), ey - size * Math.sin(a + s)];
      curve([pt(.5 + J(.06)), [ex, ey], pt(-.5 + J(.06))], c, w, { passes: 1, exact: 1, amp: .4 });
    }
    function text(x, y, s, o = {}) {
      out.push(`<text x="${f(x)}" y="${f(y)}"${o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''}${o.rot ? ` transform="rotate(${o.rot} ${f(x)} ${f(y)})"` : ''} style="font-family:${HAND};font-size:${o.size || 24}px;font-weight:${o.weight || 700};fill:${o.c || INK}">${esc(s)}</text>`);
    }
    // little speed / spark ticks radiating from a point
    function ticks(x, y, n, len, a0, a1, c = INK, w = 2.2, gap = 6) {
      for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * (n === 1 ? .5 : i / (n - 1)) + J(.08), l = len * (.75 + r() * .4); line(x + Math.cos(a) * gap, y + Math.sin(a) * gap, x + Math.cos(a) * (gap + l), y + Math.sin(a) * (gap + l), c, w, { passes: 1 }); }
    }
    return { r, J, out, put, curve, line, poly, rect, rbox, oval, arrow, text, ticks };
  }

  // ---------- Blot ----------
  // x,y = body centre, s = body half-width. o: arms [[hx,hy,bend?],[..]], legs [[fx,fy,footDir?],[..]], look [dx,dy], mood, tilt, face (-1|1)
  function drawBlot(p, x, y, s, o = {}) {
    const mood = o.mood || 'blank', [lx, ly] = o.look || [0, 0], tilt = o.tilt || 0, face = o.face || 1;
    const lw = Math.max(1.8, Math.min(2.8, s * .07));
    const rot = (px, py) => [x + (px - x) * Math.cos(tilt) - (py - y) * Math.sin(tilt), y + (px - x) * Math.sin(tilt) + (py - y) * Math.cos(tilt)];
    const limb = (a, b, bend) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, k = Math.max(-9, Math.min(9, L * (bend ?? .14)));
      p.curve([a, [(a[0] + b[0]) / 2 - dy / L * k, (a[1] + b[1]) / 2 + dx / L * k], [b[0], b[1]]], BODY, lw, { passes: 1, amp: .5 });
    };
    const hips = [rot(x - s * .34, y + s * .9), rot(x + s * .3, y + s * .92)];
    (o.legs || [[x - s * .4, y + s * 1.8], [x + s * .36, y + s * 1.8]]).forEach((ft, i) => {
      limb(hips[i], ft, ft[3] ?? (i ? -.06 : .06));
      const dir = ft[2] ?? face;
      if (dir) p.curve([[ft[0], ft[1]], [ft[0] + dir * s * .24, ft[1] + p.J(.6)]], BODY, lw, { passes: 1, exact: 1, amp: .3 });
    });
    const sh = [rot(x - s * .88, y + s * .08), rot(x + s * .88, y + s * .02)];
    (o.arms || [[x - s * 1.25, y + s * .95], [x + s * 1.25, y + s * .95]]).forEach((h, i) => limb(sh[i], h, h[2] ?? (i ? .16 : -.16)));
    // the blob: lopsided, a touch pear-shaped
    const ph = p.r() * TAU, ph2 = p.r() * TAU, pts = [];
    for (let k = 0; k < 26; k++) {
      const a = k / 26 * TAU, rr = 1 + .055 * Math.sin(2 * a + ph) + .035 * Math.sin(3 * a + ph2) + p.J(.012);
      let px = Math.cos(a) * s * rr; const py = Math.sin(a) * s * 1.08 * rr;
      if (py > 0) px *= 1 + .07 * py / s;
      pts.push(rot(x + px, y + py));
    }
    p.put(qclosed(pts), BODY, 1.4, BODY);
    // eyes: the only face. Moods are tiny shifts, never a mouth.
    let er = Math.max(2.1, s * .1);
    const up = mood === 'happy' ? s * .05 : mood === 'proud' ? s * .08 : 0;
    const e = [rot(x - s * .3 + lx, y - s * .3 + ly - up), rot(x + s * .16 + lx, y - s * .36 + ly - up)];
    if (mood === 'proud') e.forEach(([ex, ey]) => p.curve([[ex - er * 1.1, ey + er * .2], [ex, ey - er * .25], [ex + er * 1.1, ey + er * .2]], EYE, er * .9, { passes: 1, exact: 1, amp: .2 }));
    else {
      if (mood === 'worried') er *= .78; if (mood === 'happy') er *= 1.12;
      e.forEach(([ex, ey], i) => p.put(qclosed([0, 1, 2, 3, 4, 5].map(k => [ex + Math.cos(k / 6 * TAU) * er * (i ? .92 : 1) * (1 + p.J(.08)), ey + Math.sin(k / 6 * TAU) * er * (i ? .92 : 1) * (1 + p.J(.08))])), null, 0, EYE));
    }
    if (mood === 'worried') {
      const [bx, by] = e[1]; p.curve([[bx - er * 1.6, by - er * 2.9], [bx + er * 1.4, by - er * 2.1]], EYE, Math.max(1.6, er * .7), { passes: 1, exact: 1, amp: .2 });
      const dx = x + face * s * 1.12, dy = y - s * .82, d = s * .16;
      p.curve([[dx, dy - d * 1.6], [dx - d * .8, dy + d * .2], [dx, dy + d * .9], [dx + d * .8, dy + d * .2], [dx, dy - d * 1.6]], BLUE, 1.8, { passes: 1, exact: 1, amp: .2 });
    }
    if (mood === 'happy') p.ticks(x + face * s * .55, y - s * 1.12, 3, s * .22, face > 0 ? -2.1 : -1.0, face > 0 ? -1 : -2.1, ORANGE, 2, s * .1);
  }

  // ---------- captions ----------
  // Width estimate per character (em). Deliberately generous so real handwriting fonts fit.
  const est = (s, size) => { let w = 0; for (const ch of s) { const c = ch.codePointAt(0); w += c >= 0x2E80 ? 1.02 : ch === 'W' ? .95 : ch === 'M' ? .8 : /[A-Z@#%&mw]/.test(ch) ? .66 : /[iljtfr.,;:'!|()\[\] ]/.test(ch) ? .32 : .52; } return w * size; };
  function breakLines(text, size, maxW) {
    const words = []; for (const wd of text.split(/\s+/).filter(Boolean)) {
      if (est(wd, size) <= maxW) { words.push(wd); continue; }
      let cur = ''; for (const ch of wd) { if (cur && est(cur + ch, size) > maxW) { words.push(cur); cur = ''; } cur += ch; } if (cur) words.push(cur);
    }
    const lines = []; let cur = '';
    for (const wd of words) { const next = cur ? cur + ' ' + wd : wd; if (cur && est(next, size) > maxW) { lines.push(cur); cur = wd; } else cur = next; }
    if (cur) lines.push(cur); return lines;
  }
  // Sizes 28..20 on two lines keep every old caption as it was; a 60-character caption (build.py's limit) then takes three lines at FLOOR
  // in the wider block `w3`, and only a hostile one is cut with an ellipsis.
  function fitCaption(text, maxW, w3) {
    for (const size of [28, 25, 22, FLOOR]) { const lines = breakLines(text, size, maxW); if (lines.length <= 2) return { size, lines }; }
    const size = FLOOR, wide = Math.max(maxW, w3 || 0), all = breakLines(text, size, wide), lines = all.slice(0, 3);
    if (all.length > 3) { let last = lines[2]; while (last.length > 1 && est(last + '…', size) > wide) last = [...last].slice(0, -1).join(''); lines[2] = last.trimEnd() + '…'; }
    return { size, lines, wide: lines.length > 2 };
  }
  // cap: {x, y (top of block), w (two-line width), w3 (width when it needs three lines), x3 (its x then), anchor, c, to?: [x,y] leader target}
  function caption(p, text, cap) {
    text = String(text || '').trim().replace(/\s+/g, ' ');
    if (!text) return;
    const { size, lines, wide } = fitCaption(text, cap.w, cap.w3), lh = size * 1.02, x = wide && cap.x3 != null ? cap.x3 : cap.x;
    lines.forEach((ln, i) => p.text(x, cap.y + size * .82 + i * lh, ln, { size, c: cap.c, anchor: cap.anchor }));
    if (cap.to) {
      const sx = cap.anchor === 'end' ? x - 14 : x + 14, sy = cap.y + lines.length * lh + 8, [tx, ty] = cap.to;
      p.arrow([[sx, sy], [sx + (tx - sx) * .25 + (cap.bend ?? 0), sy + (ty - sy) * .6], [tx, ty]], cap.c, 2, 10);
    }
  }

  // ---------- slots: labelled things and places ----------
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  function ellipsize(s, size, maxW) {
    if (est(s, size) <= maxW) return s;
    const a = [...s.slice(0, 200)]; while (a.length > 1 && est(a.join('') + '…', size) > maxW) a.pop();
    return a.join('').trimEnd() + '…';
  }
  // ---- labels: never below FLOOR. A label takes the width it is given; if it does not fit it wraps (at a space, a joint such as _ . - / :,
  // a camelCase step, else mid-token) and only past the allowed lines is it cut with an ellipsis.
  const cw = ch => est(ch, 1);
  function wrapLabel(s, size, maxW, n) {
    const a = [...s.slice(0, 200)]; if (s.length > 200) a.push('…');
    const W = maxW / size, lines = []; let i = 0;
    if (n >= 2) {   // a label that needs exactly two lines is split near its middle (no widow like "PHONE_IN_FRAMES_" / "OK")
      const tot = a.reduce((x, ch) => x + cw(ch), 0); let best = -1, gap = 1e9, run = 0;
      if (tot > W && tot <= 2 * W) for (let j = 1; j < a.length; j++) {
        run += cw(a[j - 1]); const left = run, right = tot - run - (a[j] === ' ' ? cw(' ') : 0);
        if ((a[j] === ' ' || /[_.\-\/:]/.test(a[j - 1]) || (/[a-z0-9]/.test(a[j - 1]) && /[A-Z]/.test(a[j]))) && left <= W && right <= W && Math.abs(left - right) < gap) { gap = Math.abs(left - right); best = j; }
      }
      if (best > 0) return [a.slice(0, best).join('').trimEnd(), a.slice(best).join('').trimStart()];
    }
    while (i < a.length) {
      let w = 0, k = i; while (k < a.length && w + cw(a[k]) <= W) w += cw(a[k++]);
      if (k >= a.length) { lines.push(a.slice(i).join('')); break; }                                              // the rest fits
      if (lines.length === n - 1) { lines.push(ellipsize(a.slice(i).join(''), size, maxW)); break; }                // out of lines
      if (k === i) k = i + 1;
      let at = -1;
      for (let j = k; j > i + (k - i) * .45; j--) if (a[j] === ' ') { at = j; break; }
      if (at < 0) for (let j = k; j > i + (k - i) * .45; j--) if (/[_.\-\/:]/.test(a[j - 1]) || (/[a-z0-9]/.test(a[j - 1]) && /[A-Z]/.test(a[j]))) { at = j; break; }
      if (at < 0) at = k;
      lines.push(a.slice(i, at).join('').trimEnd()); i = at; while (a[i] === ' ') i++;
    }
    return lines.length ? lines : [''];
  }
  // lay a label out: size o.size (default 22) down to FLOOR while one line is too wide, then up to o.lines (default 2) lines at FLOOR
  function fit(s, maxW, o = {}) {
    s = clean(s); if (!s) return null;
    let size = Math.max(FLOOR, o.size || 22); while (size > FLOOR && est(s, size) > maxW) size--;
    const lines = wrapLabel(s, size, maxW, o.lines || 2);
    return { lines, size, lh: size * 1.02, w: Math.max(...lines.map(l => est(l, size))) };
  }
  // text with its first baseline at y; x is the anchor and is nudged so the (estimated) text stays inside the picture
  function lab(p, s, x, y, maxW, o = {}) {
    const t = fit(s, maxW, { ...o, lines: Math.max(1, Math.min(o.lines || 2, Math.floor((352 - y) / (Math.max(FLOOR, o.size || 22) * 1.02)) + 1)) });   // never a second line below the picture
    if (!t) return { w: 0, n: 0, lh: 0 };
    const anchor = o.anchor || 'middle', xx = anchor === 'middle' ? Math.max(8 + t.w / 2, Math.min(632 - t.w / 2, x)) : anchor === 'start' ? Math.max(8, Math.min(x, 632 - t.w)) : Math.min(632, Math.max(x, 8 + t.w));
    t.lines.forEach((ln, i) => p.text(xx, y + i * t.lh, ln, { size: t.size, c: o.c, anchor, rot: o.rot, weight: o.weight }));
    return { w: t.w, n: t.lines.length, lh: t.lh, x: xx };
  }
  const tag = (p, s, x, y, maxW, o = {}) => lab(p, s, x, y, maxW, { ...o, lines: 1 });
  // one or two lines centred on (cx, cy)
  function boxText(p, s, cx, cy, maxW, o = {}) {
    const t = fit(s, maxW, o); if (!t) return null;
    const rot = o.rot ? Math.round(o.rot * 1800 / Math.PI) / 10 : 0;
    t.lines.forEach((ln, i) => p.text(cx, cy + (i - (t.lines.length - 1) / 2) * t.lh + t.size * .3, ln, { size: t.size, c: o.c, anchor: 'middle', rot }));
    return t;
  }
  // a parcel/box carrying a label; without a label it is exactly p.rbox. A label widens the box (up to o.maxW) and then wraps; returns the box width.
  function parcel(p, label, cx, cy, w, h, ang, o = {}) {
    label = clean(label);
    if (!label) { p.rbox(cx, cy, w, h, ang); return w; }
    const W = Math.max(w, Math.min(o.maxW || 262, est(label, FLOOR) + 18)), t = fit(label, W - 14, { size: o.size || 22 });
    ang *= Math.min(1, 70 / W);   // a long box keeps only a hint of the tilt, or its ends would swing into the neighbours
    p.rbox(cx, cy, W, t.lines.length > 1 ? Math.max(h, t.lh * t.lines.length + 14) : h, ang);
    boxText(p, label, cx, cy, W - 14, { rot: ang, c: o.c, size: o.size || 22 }); return W;
  }
  function drawProp(p, name, cx, cy, size) {
    if (typeof LensProps !== 'undefined' && LensProps && typeof LensProps.draw === 'function') { LensProps.draw(p, name || '', cx, cy, size); return; }
    p.rbox(cx, cy + size * .04, size * .78, size * .6, 0);
    p.curve([[cx - size * .12, cy - size * .26], [cx - size * .12, cy - size * .38], [cx + size * .12, cy - size * .38], [cx + size * .12, cy - size * .26]], INK, 2.2, { passes: 1 });
  }
  const lw = (label, maxW = 260) => { const t = fit(label, maxW, { lines: 1 }); return t ? t.w : 0; };   // width a label wants (0 when empty)
  // an icon with its label (first baseline ly, centred on o.lx or the icon)
  function placeProp(p, spec, cx, cy, size, ly, o = {}) {
    drawProp(p, spec.prop, cx, cy, size);
    lab(p, spec.label, o.lx ?? cx, ly, o.maxW || 260, { size: o.size || 22, c: o.c, anchor: o.anchor });
  }
  const slots = o => ({
    it: (Array.isArray(o.items) ? o.items : []).slice(0, 4).map(clean),
    pr: (Array.isArray(o.props) ? o.props : []).slice(0, 3).map(x => x && typeof x === 'object' && (x.prop || x.label) ? { prop: clean(x.prop), label: clean(x.label) } : null)
  });

  // ---------- the twelve scenes ----------
  // Each draws with pen p, the main Blot mood m, and returns its caption anchor.
  const ground = (p, x1, x2, y) => p.line(x1, y, x2, y, INK, 2.2);
  const S = {
    // data moving: Blot marches a parcel overhead from flag A to flag B
    carry(p, m, k) {
      const [A, B] = k.pr, pk = k.it[0];
      ground(p, 42, 118, 302); ground(p, 520, 612, 302);
      for (let x = 136; x < 500; x += 30) p.line(x, 303 + p.J(1), x + 13, 303 + p.J(1), INK, 1.8, { passes: 1 });
      if (!A) { p.line(72, 302, 72, 226); p.poly([[72, 228], [102, 238], [72, 250]], false); }
      if (!B) { p.line(568, 302, 568, 226); p.poly([[568, 228], [596, 238], [568, 250]], false, BLUE); }
      if (!A) p.text(84, 284, 'A', { size: 22, c: INK });
      if (!B) p.text(580, 284, 'B', { size: 22, c: BLUE });
      if (A) placeProp(p, A, Math.max(80, 8 + lw(A.label) / 2), 238, 70, 292);
      if (B) placeProp(p, B, Math.min(560, 632 - lw(B.label) / 2), 238, 70, 292, { c: BLUE });
      p.ticks(232, 236, 3, 20, Math.PI - .25, Math.PI + .25, INK, 2, 14);
      drawBlot(p, 300, 236, 38, { mood: m, look: [6, -1], tilt: .08, arms: [[252, 176, .3], [350, 172, -.3]], legs: [[272, 302, 1], [334, 296, 1, -.12]] });
      const PW = parcel(p, pk, 300, 150, 108, 56, -.04), ax = 300 + PW / 2 + 18;
      if (!pk) { p.line(250, 140, 350, 136, INK, 1.6, { passes: 1 }); p.line(300, 122, 301, 178, INK, 1.6, { passes: 1 }); }
      p.arrow([[ax, 156], [ax + 48, 140], [ax + 98, 152]], BLUE);
      return { x: 616, y: 40, w: 250, w3: 270, anchor: 'end', c: BLUE };
    },
    // validation: a striped boom gate; Blot passes one parcel and bounces the other
    gate(p, m, k) {
      const [pass, away] = k.it, G = k.pr[0];
      ground(p, 100, 610, 306);
      p.rect(352, 176, 22, 130); p.oval(363, 190, 9, 9, INK, 2, { fill: PAPER });
      p.rect(146, 182, 206, 16);
      for (let x = 166; x < 352; x += 30) p.line(x, 183, x - 12, 197, INK, 2, { passes: 1 });
      const aw = parcel(p, away, 186, 282, 52, 44, -.18);
      if (!away) { p.line(172, 270, 200, 294, RED, 3); p.line(200, 270, 172, 294, RED, 3); }
      else { const xx = 186 - aw / 2 + 6, dy = aw > 60 ? -20 : 0; p.line(xx - 11, 255 + dy, xx + 11, 277 + dy, RED, 3); p.line(xx + 11, 255 + dy, xx - 11, 277 + dy, RED, 3); }
      p.arrow([[232, 246], [212, 226], [178, 230]], RED, 2.2, 11);
      drawBlot(p, 438, 252, 34, { mood: m, look: [-7, 1], face: -1, arms: [[382, 214, -.1], [470, 288, .1]], legs: [[424, 306, -1], [452, 306, -1]] });
      parcel(p, '', 548, 284, 50, 42, .06);
      if (!pass) p.text(548, 252, 'ok', { size: 26, c: BLUE, anchor: 'middle' });
      else lab(p, pass, 548, 328, 260);   // under the ground line: no room beside Blot for a long name
      if (G) placeProp(p, G, 500, 100, 78, 160);
      p.arrow([[492, 234], [516, 220], [536, 232]], BLUE, 2, 9);
      return { x: 30, y: 36, w: 260, w3: 290, anchor: 'start', c: RED, to: [180, 160], bend: 10 };
    },
    // backlog: a pile of boxes queued off the right edge, Blot weighs the front one
    queue(p, m, k) {
      const held = k.it[0], row = k.it.slice(1).filter(Boolean), F = k.pr[0];
      ground(p, 40, 622, 304);
      const xs = [238, 293, 348, 403, 458, 513, 568];
      let xl = 0;   // left edge of the labelled stack
      if (row.length) {   // labelled waiting boxes: a stack against the right edge, each as wide as its label
        xl = 626; row.slice(0, 3).forEach((lb, i) => { const t = fit(lb, 240), W = Math.max(70, t.w + 22), cy = 283 - i * 42; xl = Math.min(xl, 626 - W); p.rbox(626 - W / 2, cy, W, 38, p.J(.04)); boxText(p, lb, 626 - W / 2, cy, W - 14, { size: 22 }); });
      } else {
        if (held) for (let i = 0; i < 4; i++) p.rbox(293 + i * 92, 281, 86, 46, p.J(.04));
        else xs.forEach((x, i) => p.rbox(x + 26, 281, 50, 44, p.J(.05)));
        [[456, 236, .04], [520, 236, -.05], [568, 236, .03], [544, 192, .12], [490, 190, -.04], [546, 146, .08]].forEach(([x, y, a]) => p.rbox(x + 26, y + 1, 50, 42, a));
      }
      drawBlot(p, 132, 240, 40, { mood: m, look: [8, 2], arms: [[184, 230, -.25], [188, 206, .15]], legs: [[112, 304, 1], [146, 304, 1]] });
      if (held) { p.rbox(224, 214, 46, 40, .14); lab(p, held, 226, 168, 260, { anchor: 'start' }); } else p.rbox(204, 214, 46, 40, .14);
      if (F) { placeProp(p, F, 56, 250, 56, 328); p.arrow([[212, 188], [140, 146], [66, 214]], BLUE, 2, 10); }
      else p.text(210, 175, '?', { size: 30, c: ORANGE, anchor: 'middle', rot: 10 });
      if (xl) p.arrow([[xl - 10, 238], [(xl + 290) / 2, 226], [300, 236]], ORANGE, 2, 10);
      else p.arrow([[400, 226], [350, 214], [300, 226]], ORANGE, 2, 10);
      return { x: 30, y: 40, w: 300, w3: 300, anchor: 'start', c: BLUE };
    },
    // branching: the road splits, Blot stands in the fork and cannot decide
    fork(p, m, k) {
      const [la, lb] = k.it, O = k.pr[0];
      p.curve([[350, 360], [356, 300], [338, 240], [292, 160], [236, 64]]);
      p.curve([[440, 360], [436, 300], [452, 240], [500, 168], [568, 72]]);
      p.curve([[312, 60], [348, 130], [396, 196], [436, 136], [486, 62]]);
      p.arrow([[274, 140], [262, 110], [250, 80]], INK, 2, 10); p.arrow([[492, 140], [512, 112], [530, 84]], INK, 2, 10);
      drawBlot(p, 396, 268, 30, { mood: m, look: [-3, -4], arms: [[404, 226, .5], [364, 300, -.1]], legs: [[384, 324, 0], [408, 324, 0]] });
      p.text(372, 232, '?', { size: 34, c: ORANGE, rot: -10 }); p.text(412, 226, '?', { size: 26, c: ORANGE, rot: 12 });
      lab(p, la, 186, 40, 260, { size: 22, c: BLUE }); lab(p, lb, 538, 44, 260, { size: 22, c: BLUE });
      if (O) placeProp(p, O, Math.min(556, 628 - lw(O.label, 184) / 2), 262, 60, 314, { maxW: 184 });
      return { x: 30, y: 250, w: 270, w3: 290, anchor: 'start', c: RED };
    },
    // boundary: Blot shoves a brick wall; the parcel stays outside, the slot beyond stays empty
    wall(p, m, k) {
      const stuck = k.it[0], behind = k.pr[0];
      ground(p, 60, 296, 306); ground(p, 380, 610, 306);
      const X = 304, W = 64, T = 52, B = 306;
      p.rect(X, T, W, B - T);
      for (let y = T + 26, row = 0; y < B; y += 26, row++) {
        p.line(X + 2, y, X + W - 2, y, INK, 1.6, { passes: 1 });
        const off = row % 2 ? 16 : 34; p.line(X + off, y - 25, X + off, y - 1, INK, 1.4, { passes: 1 });
      }
      p.line(X + 20, B - 23, X + 20, B - 1, INK, 1.4, { passes: 1 });
      drawBlot(p, 238, 236, 40, { mood: m, look: [8, 0], tilt: .2, arms: [[302, 212, -.15], [303, 248, .15]], legs: [[192, 306, 1], [222, 306, 1]] });
      parcel(p, '', 132, 282, 54, 46, -.06); if (stuck) lab(p, stuck, 132, 328, 260);   // under the ground line: Blot's feet are in the way
      p.ticks(298, 150, 3, 16, Math.PI - .7, Math.PI + .7, RED, 2.2, 10);
      p.text(286, 120, '!', { size: 34, c: RED });
      if (behind) placeProp(p, behind, 496, 236, 66, 296, { c: BLUE });
      else {
        for (let x = 430; x < 560; x += 18) p.line(x, 262, x + 9, 262, BLUE, 2, { passes: 1 });
        for (let x = 430; x < 560; x += 18) p.line(x, 304, x + 9, 304, BLUE, 2, { passes: 1 });
        p.line(426, 266, 426, 300, BLUE, 2, { passes: 1 }); p.line(566, 266, 566, 300, BLUE, 2, { passes: 1 });
      }
      return { x: 412, y: 70, w: 210, w3: 248, x3: 384, anchor: 'start', c: RED };
    },
    // failure: the box is on fire; Blot, mid-panic, flings a thimble of water at it
    fire(p, m, k) {
      const burns = k.pr[0], lost = k.it[0];
      ground(p, 250, 620, 306);
      if (burns) placeProp(p, burns, 350, 256, 100, 328, { size: 23 });
      else {
        p.rect(286, 206, 128, 100); p.line(300, 236, 400, 236, INK, 1.8); p.line(300, 262, 400, 262, INK, 1.8);
        p.oval(390, 284, 4, 4, INK, 1.6, { fill: INK, passes: 1 });
      }
      const flame = (cx, h, w) => p.curve([[cx - w, 206], [cx - w * .9, 206 - h * .45], [cx - w * .2, 206 - h * .7], [cx - w * .1, 206 - h], [cx + w * .35, 206 - h * .6], [cx + w * .8, 206 - h * .4], [cx + w, 206]], ORANGE, 2.6);
      flame(316, 84, 28); flame(352, 122, 34); flame(392, 72, 24);
      p.curve([[346, 70], [338, 54], [352, 42], [344, 26]], INK, 2); p.curve([[384, 104], [394, 88], [386, 74]], INK, 2);
      p.ticks(352, 140, 4, 12, -2.9, -.3, ORANGE, 2, 70);
      drawBlot(p, 532, 236, 34, { mood: m === 'blank' ? 'worried' : m, face: -1, look: [-6, -2], tilt: -.12, arms: [[478, 176, .25], [572, 182, -.3]], legs: [[512, 306, -1], [556, 290, -1, .2]] });
      p.oval(470, 168, 9, 7, INK, 2, { fill: PAPER });
      [[448, 166], [438, 176], [452, 182]].forEach(([x, y]) => p.oval(x, y, 3, 4, BLUE, 1.8, { passes: 1 }));
      lab(p, lost, 404, 66, 220, { size: 24, c: ORANGE, anchor: 'start' });
      return { x: 30, y: 40, w: 230, w3: 260, anchor: 'start', c: RED };
    },
    // persistence: a filing cabinet, top drawer open, Blot lowers a box straight down into it
    store(p, m, k) {
      const bx = k.it[0], P = k.pr[0];
      ground(p, 160, 560, 308);
      const X = 362, W = 150;
      if (P) placeProp(p, P, X + 75, 238, 134, 330, { size: 23 });
      else {
        p.rect(X, 222, W, 86);
        p.line(X + 4, 265, X + W - 4, 265, INK, 1.8); p.line(X + 58, 244, X + 92, 244, INK, 2.4); p.line(X + 58, 287, X + 92, 287, INK, 2.4);
        p.poly([[X - 14, 196], [X + W + 14, 196], [X + W + 4, 174], [X - 4, 174]], true, INK, 2.4, PAPER);
        p.rect(X - 14, 196, W + 28, 30); p.line(X + 58, 211, X + 92, 211, INK, 2.4);
        [X + 30, X + 52, X + 112].forEach(x => p.line(x, 176, x + 6, 193, INK, 1.6, { passes: 1 }));
      }
      const bw = parcel(p, bx, X + 74, 136, 48, 42, .1), hx = X + 74 - bw / 2 + 2, ax = Math.max(X + 130, X + 74 + bw / 2 + 14);
      p.arrow([[ax, 96], [ax + 10, 132], [ax - 6, 168]], BLUE);
      drawBlot(p, 290, 240, 38, { mood: m, look: [6, -7], arms: [[hx, 152, -.1], [hx + 2, 130, .1]], legs: [[272, 308, 1], [304, 308, 1]] });
      return { x: 30, y: 40, w: 250, w3: 280, anchor: 'start', c: BLUE };
    },
    // read: Blot peers through a giant magnifier at one line of an open ledger
    lookup(p, m, k) {
      const key = k.it[0], P = k.pr[0];
      if (P) placeProp(p, P, 296, 276, 112, 346, { size: 23 });
      else {
        p.poly([[84, 252], [282, 236], [284, 322], [76, 326]], true, INK, 2.4, PAPER);
        p.poly([[282, 236], [476, 252], [484, 326], [284, 322]], true, INK, 2.4, PAPER);
        for (let i = 0; i < 5; i++) {
          const y = 256 + i * 14; p.line(100, y + 1 - i * .4, 100 + 120 + p.J(40), y - 1, INK, 1.4, { passes: 1 });
          p.line(300, y - 2, 300 + 110 + p.J(40), y + 1, INK, 1.4, { passes: 1 });
        }
      }
      p.line(398, 236, 434, 202, INK, 6, { passes: 1 });
      p.oval(364, 270, 50, 48, INK, 3, { fill: PAPER });
      if (key && lw(key, 600) <= 84) boxText(p, key, 364, 270, 88, { c: BLUE, size: 26 });
      else {
        p.line(332, 258, 396, 256, INK, 3.2, { passes: 1 }); p.line(330, 280, 380, 280, INK, 3.2, { passes: 1 });
        p.line(330, 292, 382, 292, BLUE, 2.6, { passes: 1 });
        if (key) lab(p, key, 392, 204, 260, { c: BLUE, anchor: 'end' });   // too long for the lens: written above it
      }
      drawBlot(p, 536, 214, 40, { mood: m, look: [-9, 4], face: -1, tilt: -.16, arms: [[436, 200, .1], [570, 272, -.1]], legs: [[524, 298, -1], [554, 298, -1]] });
      ground(p, 500, 616, 298);
      return { x: 30, y: 46, w: 280, w3: 300, anchor: 'start', c: BLUE };
    },
    // convert: a square goes in the side of a machine, a circle rolls out the other side
    transform(p, m, k) {
      const [inp, outp] = k.it, M = k.pr[0];
      ground(p, 90, 610, 306);
      p.rect(262, 148, 150, 140); p.line(276, 288, 276, 306); p.line(398, 288, 398, 306);
      p.rect(244, 202, 18, 46); p.rect(412, 248, 26, 32);
      if (M) drawProp(p, M.prop, 337, 200, 62);
      else { p.oval(336, 196, 22, 22, INK, 2.2, { fill: PAPER }); p.line(336, 196, 349, 184, INK, 2.2, { passes: 1 }); }
      const mIn = M && M.label && lw(M.label, 600) <= 118;
      if (mIn) tag(p, M.label, 337, 272, 118, { size: 22 });
      else { p.line(300, 252, 372, 252, INK, 1.8); p.line(300, 266, 352, 266, INK, 1.8); if (M && M.label) lab(p, M.label, 366, 138, 260, { anchor: 'end' }); }   // too wide for the machine: written above it
      p.rect(372, 116, 18, 32); p.curve([[381, 106], [372, 92], [386, 80], [378, 64]], INK, 2);
      p.ticks(418, 150, 3, 14, -1.3, -.1, ORANGE, 2.4, 6);
      drawBlot(p, 172, 238, 38, { mood: m, look: [8, -2], tilt: .14, arms: [[226, 214, -.1], [228, 238, .1]], legs: [[140, 306, 1], [168, 306, 1]] });
      parcel(p, '', inp ? 226 : 236, 225, 34, inp ? 42 : 34, .08); if (inp) lab(p, inp, 252, 172, 244, { anchor: 'end' });
      const R = outp ? 22 : 17, oy = outp ? 284 : 288;
      p.oval(504, oy, R, R, INK, 2.4, { fill: PAPER }); p.ticks(504, oy, 3, 10, Math.PI - .5, Math.PI + .5, INK, 1.8, R + 7);
      tag(p, outp, 508, 330, 260, { size: 22, c: BLUE });
      p.arrow([[450, 236], [492, 228], [530, 244]], BLUE, 2.2, 10);
      return { x: 616, y: 40, w: 230, w3: 220, anchor: 'end', c: RED };
    },
    // timeout: a big clock on stick legs; Blot sits on the floor beside it and waits
    wait(p, m, k) {
      const waiting = k.it[0], P = k.pr[0];
      ground(p, 120, waiting ? 560 : 470, 310);
      const cx = 208, cy = 150, R = 86;
      p.line(178, 228, 166, 310); p.line(238, 228, 252, 310); p.line(166, 310, 152, 310, INK, 2.4, { passes: 1 }); p.line(252, 310, 266, 310, INK, 2.4, { passes: 1 });
      p.oval(cx, cy, R, R * .98, INK, 2.8, { fill: PAPER });
      for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; p.line(cx + Math.cos(a) * R * .8, cy + Math.sin(a) * R * .8, cx + Math.cos(a) * R * (i % 3 ? .87 : .7), cy + Math.sin(a) * R * (i % 3 ? .87 : .7), INK, i % 3 ? 1.6 : 2.4, { passes: 1 }); }
      p.line(cx, cy, cx - 38, cy - 20, INK, 3.4, { passes: 1 }); p.line(cx, cy, cx + 6, cy - 64, INK, 2.4, { passes: 1 });
      p.oval(cx, cy, 4, 4, INK, 2, { fill: INK, passes: 1 });
      p.curve([[cx + 22, cy - 82], [cx + 40, cy - 74], [cx + 52, cy - 60]], ORANGE, 2.2, { passes: 1 });
      p.curve([[cx + 32, cy - 96], [cx + 56, cy - 84], [cx + 70, cy - 64]], ORANGE, 2.2, { passes: 1 });
      drawBlot(p, 372, 282, 28, { mood: m, look: [-6, -6], face: 1, arms: [[338, 310, -.1], [404, 306, .1]], legs: [[420, 310, 0, .05], [428, 300, 0, .05]] });
      [0, 1, 2].forEach(i => p.oval(392 + i * 14, 236 - i * 8, 2.6, 2.6, BLUE, 2.2, { fill: BLUE, passes: 1 }));
      if (waiting) { parcel(p, '', 492, 288, 56, 44, .05); lab(p, waiting, 492, 334, 260); }   // under the ground line: Blot sits beside the box
      if (P) placeProp(p, P, 536, 170, 84, 232, { c: BLUE, maxW: 215 });
      return { x: 616, y: 54, w: 200, w3: 260, anchor: 'end', c: RED };
    },
    // delegation: one Blot hands the parcel across a dashed line to a second, smaller Blot
    handoff(p, m, k) {
      const pk = k.it[0], [G, R] = k.pr;
      ground(p, 150, 280, 306); ground(p, 380, 500, 306);
      for (let y = pk ? 132 : 112; y < 318; y += 20) p.line(326, y, 326 + p.J(1), y + 10, INK, 1.8, { passes: 1 });
      drawBlot(p, 226, 236, 42, { mood: m, look: [8, -1], arms: [[296, 214, -.1], [300, 192, .1]], legs: [[204, 306, 1], [244, 306, 1]] });
      drawBlot(p, 432, 254, 30, { mood: 'blank', look: [-6, -3], face: -1, arms: [[352, 218, .1], [356, 198, -.1]], legs: [[420, 306, -1], [444, 306, -1]] });
      parcel(p, '', 326, 202, 62, 44, -.04); if (!pk) p.line(296, 196, 356, 192, INK, 1.6, { passes: 1 }); else lab(p, pk, 300, 124, 260);   // the name sits above the arrow
      p.arrow([[286, 150], [326, 138], [370, 150]], BLUE);
      if (G) placeProp(p, G, Math.max(92, 8 + lw(G.label) / 2), G.label ? 262 : 246, 72, G.label ? 328 : 302);
      if (R) placeProp(p, R, Math.min(548, 632 - lw(R.label) / 2), R.label ? 262 : 250, 72, R.label ? 328 : 302, { c: BLUE });
      return { x: 616, y: 42, w: 210, w3: 235, anchor: 'end', c: BLUE };
    },
    // observability: Blot on a stool, nose to a monitor, watching one pulse go by
    watch(p, m, k) {
      const P = k.pr[0], rd = k.it[0];
      ground(p, 160, 560, 306);
      p.rect(306, 70, 236, 162); p.rect(322, 86, 204, 130, { w: 1.8 });
      p.line(424, 232, 424, 300); p.line(386, 304, 462, 302);
      if (P || rd) {
        const rl = fit(rd, 196, { size: P ? 22 : 28 }), long = rl && rl.lines.length > 1;   // a reading that needs two lines leaves no room for the icon
        if (P) { if (!long) drawProp(p, P.prop, 424, 112, 44); lab(p, P.label, 424, 56, 260); }   // the screen shows the thing; its name is the title above the monitor
        lab(p, rd, 424, long ? 112 : P ? 166 : 130, 196, { size: P ? 22 : 28, c: BLUE });
        const lo = P ? 12 : 0;   // with the icon above, the pulse runs lower so it clears the reading
        p.curve([[330, 192 + lo], [430, 192 + lo], [452, 190 + lo], [470, 150 + lo * 2], [482, 208 + lo * .4], [494, 184 + lo], [504, 192 + lo], [516, 192 + lo]], BLUE, 2.4, { passes: 1, exact: 1, amp: .3 });
        p.oval(470, 148 + lo * 2, 4, 4, ORANGE, 2.4, { fill: ORANGE, passes: 1 });
      } else {
        p.curve([[330, 170], [380, 170], [394, 168], [404, 124], [416, 196], [428, 160], [440, 170], [516, 170]], BLUE, 2.4, { passes: 1, exact: 1, amp: .3 });
        p.oval(404, 122, 4, 4, ORANGE, 2.4, { fill: ORANGE, passes: 1 });
      }
      p.line(214, 266, 286, 266); p.line(224, 268, 218, 306); p.line(276, 268, 284, 306);
      drawBlot(p, 256, 210, 30, { mood: m, look: [8, -3], tilt: .22, arms: [[226, 246, -.4], [296, 186, .2]], legs: [[242, 266, 1], [264, 266, 1]] });
      return { x: 30, y: 40, w: 230, w3: 250, anchor: 'start', c: RED };
    }
  };
  const MOOD = { gate: 'proud', wall: 'worried', fire: 'worried', handoff: 'proud', transform: 'proud' };

  function svg(inner, label, vb, w, h) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${w ? ` width="${w}" height="${f(w * h)}"` : ''} role="img" aria-label="${esc(label)}" style="stroke-linecap:round;stroke-linejoin:round;overflow:hidden">${inner}</svg>`;
  }
  function render(name, opts = {}) {
    if (!Object.prototype.hasOwnProperty.call(S, name)) throw new Error(`LensScenes: unknown scene "${name}"; valid names: ${NAMES.join(', ')}`);
    const text = String(opts.caption || '').trim();
    const p = pen(hash(name + '|' + text));
    const k = slots(opts), cap = S[name](p, opts.mood || MOOD[name] || 'blank', k);
    caption(p, text, cap);
    const said = [...k.it, ...k.pr.map(x => x && x.label)].filter(Boolean).join(', ');
    return svg(p.out.join(''), (text ? `${name}: ${text}` : `${name} scene`) + (said ? ` (${said})` : ''), '0 0 640 360', opts.w, 9 / 16).replace('<svg ', `<svg class="lens-scene" data-scene="${name}" `);
  }
  function blot(opts = {}) {
    const p = pen(hash('blot|' + (opts.mood || 'blank')));
    drawBlot(p, 60, 66, 32, { mood: opts.mood || 'blank', look: [2, 0] });
    return svg(p.out.join(''), 'Blot', '0 0 120 136', opts.w, 136 / 120);
  }
  // ---------- context plate: one architecture node among its neighbours ----------
  // args: { title, prop, owns, inputs: [{label, prop?, payload?}], outputs: [...], mood? }. At most 2 neighbours a side, the rest "+N more".
  // Every text is >= FLOOR, so the room is spent in this order: names and payloads whole, then (only when each side has at most one
  // neighbour, so the top band is free) the `owns` sentence in two lines, which the node note repeats anyway.
  function context(a) {
    a = a || {};
    const title = clean(a.title), mood = a.mood || 'blank';
    const side = list => (Array.isArray(list) ? list : []).filter(x => x && typeof x === 'object');
    const ins = side(a.inputs), outs = side(a.outputs);
    const p = pen(hash('context|' + title + '|' + clean(a.prop)));
    const CX = 320, CY = 178;
    tag(p, title, CX, 34, 330, { size: 28 });
    if (ins.length <= 1 && outs.length <= 1) lab(p, a.owns, CX, 66, 440, { c: BLUE });
    drawProp(p, clean(a.prop), CX, CY, 100);
    drawBlot(p, CX, 268, 24, { mood, look: [0, -4], arms: [[CX - 40, 226, -.1], [CX + 40, 226, .1]], legs: [[CX - 11, 311, 1], [CX + 10, 311, 1]] });
    // dir -1: the left column (arrows come in), +1: the right column (arrows go out). The icon sits at the outer edge with its name under it,
    // aligned to that edge; the arrow runs flat from the icon and bends into the central component; its payload is written on the outer side.
    const col = (list, dir) => {
      const shown = list.slice(0, 2), two = shown.length === 2, ex = dir < 0 ? 40 : 600, ax = dir < 0 ? 8 : 632;
      shown.forEach((n, i) => {
        const y = two ? (i ? 246 : 108) : CY, yc = two ? (i ? 208 : 148) : CY;      // icon centre, where the arrow meets the central component
        drawProp(p, clean(n.prop), ex, y, 48);
        lab(p, n.label, ax, y + (two && i ? 54 : 48), 190, { size: 22, anchor: dir < 0 ? 'start' : 'end' });
        const [sx, tx] = dir < 0 ? [ex + 32, CX - 62] : [CX + 62, ex - 32], mx = (sx + tx) / 2, mid = [mx + dir * 20, y + (yc - y) * .08];
        p.arrow(dir < 0 ? [[sx, y], mid, [tx, yc]] : [[sx, yc], mid, [tx, y]], INK, 2.2, 11);
        const up = !two || !i;                                                       // payload above the upper (or only) arrow, below the lower
        lab(p, n.payload, mx, up ? (two ? y - 14 : y - 16) : y + 30, 184, { size: 22, c: BLUE });
      });
      if (list.length > 2) { // who is hidden: the count, then the names
        lab(p, `+${list.length - 2} more`, ax, 328, 190, { size: 20, c: BLUE, anchor: dir < 0 ? 'start' : 'end', lines: 1 });
        let who = ''; for (const n of list.slice(2).map(n => clean(n.label)).filter(Boolean)) { const next = who ? who + ', ' + n : n; if (est(next, 20) > 170) { who = who ? who + ' …' : ''; break; } who = next; }
        lab(p, who, ax, 350, 190, { size: 20, c: BLUE, anchor: dir < 0 ? 'start' : 'end', lines: 1 });
      }
    };
    col(ins, -1); col(outs, 1);
    const names = l => l.map(n => clean(n.label)).filter(Boolean).join(', ');
    const label = `context: ${title || 'component'}` + (ins.length ? `; in from ${names(ins)}` : '') + (outs.length ? `; out to ${names(outs)}` : '');
    return svg(p.out.join(''), label, '0 0 640 360').replace('<svg ', '<svg class="lens-scene" data-scene="context" ');
  }
  // ---------- draw: a bespoke picture from a short list of ops (the lesson author draws; no raw SVG) ----------
  // spec {caption, draw: [op, ...]}: a 16 x 9 grid, 40 viewBox units a cell, colours ink|red|orange|blue, draw order = array order.
  // Never throws: unknown ops and fields are skipped, wrong types coerced, coordinates clamped, every label whole at >= FLOOR.
  // Phase 1 plans every op (geometry, obstacles, ids) so an arrow can attach to a thing drawn later; phase 2 paints in order.
  const G = 40, COL = { ink: INK, red: RED, orange: ORANGE, blue: BLUE }, LW = { 1: 1.8, 2: 2.4, 3: 3.6 };
  const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const toNum = v => typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  const dstr = (v, n) => { const a = [...clean(typeof v === 'string' ? v.slice(0, 400) : typeof v === 'number' && Number.isFinite(v) ? v : '')]; return a.length > n ? a.slice(0, n - 1).join('').trimEnd() + '…' : a.join(''); };
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  // the point where the ray from the middle of r towards (tx,ty) leaves the rectangle (shape 'r') or ellipse ('o'), pushed out by gap
  function edgeOf(r, shape, tx, ty, gap) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = tx - cx, dy = ty - cy, L = Math.hypot(dx, dy) || 1;
    const k = shape === 'o' ? 1 / (Math.hypot(dx / (r.w / 2), dy / (r.h / 2)) || 1) : Math.min(dx ? r.w / 2 / Math.abs(dx) : 1e9, dy ? r.h / 2 / Math.abs(dy) : 1e9);
    return [cx + dx * k + dx / L * gap, cy + dy * k + dy / L * gap];
  }
  // a text block's real place: x by anchor and the first baseline y, nudged into the picture; r is its box
  function tpos(t, x, y, a) {
    const W = t.w, h = (t.lines.length - 1) * t.lh;
    const xx = a === 'start' ? clampN(x, 4, 636 - W) : a === 'end' ? clampN(x, 4 + W, 636) : clampN(x, 4 + W / 2, 636 - W / 2), yy = clampN(y, 3 + t.size * .8, 357 - h - t.size * .25);
    return { xx, yy, r: { x: a === 'start' ? xx : a === 'end' ? xx - W : xx - W / 2, y: yy - t.size * .8, w: W, h: h + t.size * 1.05 } };
  }
  // a label (whole, >= FLOOR, up to o.lines lines) planned at (x, first baseline y); returns its painter
  function T(c, s, x, y, o = {}) {
    const t = fit(s, o.maxW || 280, { size: o.size || 22, lines: o.lines || 2 }); if (!t) return null;
    const a = o.anchor || 'middle', g = tpos(t, x, y, a);
    c.add(o.k || 'text', g.r, clean(s)); c.said.push(clean(s));
    return p => t.lines.forEach((ln, i) => p.text(g.xx, g.yy + i * t.lh, ln, { size: t.size, c: o.c, anchor: a, rot: o.rot }));
  }
  // a name under an object (else above it when the picture ends first)
  function under(c, s, cx, bottom, top, o) {
    const t = fit(s, 280, { size: 22 }); if (!t) return null;
    const n = (t.lines.length - 1) * t.lh, below = bottom + 6 + t.size * .8;
    return T(c, s, cx, below + n + t.size * .25 > 357 ? top - 8 - n - t.size * .25 : below, o);
  }
  // the widest unbreakable piece of a label (words and the pieces between _ . - / :), at FLOOR
  const wordW = s => Math.max(...s.split(/(?<=[ _.\-\/:])/).map(q => est(q.trimEnd(), FLOOR)));
  // a box that grows (about its middle) until its label fits whole in two lines at FLOOR or more, no word cut in half; `one`: start wide enough for one line
  function sizeBox(label, w, h, one) {
    if (!label) return { W: w, H: h, t: null };
    let W = one ? Math.max(w, Math.min(262, est(label, 22) + 20)) : w;
    while (W < 262 && (wrapLabel(label, FLOOR, W - 14, 9).length > 2 || wordW(label) > W - 14)) W += 8;
    const t = fit(label, W - 14, { size: 22 });
    return { W, H: Math.max(h, t.lines.length * t.lh + 14), t };
  }

  // each op: (o, c) => painter | null. c: n(num), px/py(grid -> units), pt, col, shift, add (obstacle/id), said, warn
  const OPS = {
    blot(o, c) {
      const s = c.n(o.s, 1, .3, 2.2), r = s * G, mood = ['blank', 'worried', 'proud', 'happy'].includes(o.mood) ? o.mood : 'blank';
      const face = o.face === -1 || o.face === '-1' ? -1 : 1, tilt = c.n(o.tilt, 0, -.5, .5), pt = v => c.pt(v);
      const arms = Array.isArray(o.arms) ? [pt(o.arms[0]), pt(o.arms[1])] : [null, null], legs = Array.isArray(o.legs) ? [pt(o.legs[0]), pt(o.legs[1])] : [null, null];
      const look = Array.isArray(o.look) ? [c.n(o.look[0], 0, -.3, .3) * G, c.n(o.look[1], 0, -.3, .3) * G] : [0, 0];
      let x = c.px(o.x, 8), y = c.py(o.y, 4);
      const [dx, dy] = c.shift({ x: x - r * 1.3, y: y - r * 1.15, w: r * 2.6, h: r * (legs[0] || legs[1] ? 2.3 : 3) }); x += dx; y += dy;
      const mv = q => q && [q[0] + dx, q[1] + dy];
      const A = [mv(arms[0]) || [x - r * 1.25, y + r * .95], mv(arms[1]) || [x + r * 1.25, y + r * .95]], Lg = [mv(legs[0]) || [x - r * .4, y + r * 1.8], mv(legs[1]) || [x + r * .36, y + r * 1.8]];
      c.add('blot', { x: x - r, y: y - r * 1.08, w: r * 2, h: r * 2.16 }, '', o.id, 'o');
      return p => drawBlot(p, x, y, r, { mood, look, face, tilt, arms: A, legs: Lg });
    },
    prop(o, c) {
      const name = dstr(o.name, 30), size = c.n(o.size, 2, .6, 5) * G, h = size / 2, label = dstr(o.label, 18);
      let x = c.px(o.x, 8), y = c.py(o.y, 4);
      const [dx, dy] = c.shift({ x: x - h, y: y - h, w: size, h: size }); x += dx; y += dy;
      c.add('prop', { x: x - h * .85, y: y - h * .85, w: h * 1.7, h: h * 1.7 }, name, o.id, 'r');
      const lp = label && under(c, label, x, y + h * .9, y - h * .9);
      return p => { drawProp(p, name, x, y, size); if (lp) lp(p); };
    },
    box(o, c) {
      const w = c.n(o.w, 3, .5, 15.6) * G, h = c.n(o.h, 1.5, .4, 8.6) * G, label = dstr(o.label, 18), g = sizeBox(label, w, h), ink = o.fill === 'ink';
      let x = c.px(o.x, 6) + (w - g.W) / 2, y = c.py(o.y, 3) + (h - g.H) / 2;
      const [dx, dy] = c.shift({ x, y, w: g.W, h: g.H }); x += dx; y += dy;
      c.add('box', { x, y, w: g.W, h: g.H }, label, o.id, 'r'); if (label) c.said.push(label);
      const col = c.col(o.c);
      return p => { p.rect(x, y, g.W, g.H, { c: col, fill: ink ? INK : PAPER }); if (g.t) boxText(p, label, x + g.W / 2, y + g.H / 2, g.W - 14, { size: 22, c: ink ? PAPER : INK }); };
    },
    packet(o, c) {
      const label = dstr(o.label, 18), g = sizeBox(label, 70, 44, true), tilt = c.n(o.tilt, 0, -.3, .3), col = c.col(o.c);
      let x = c.px(o.x, 8), y = c.py(o.y, 4);
      const [dx, dy] = c.shift({ x: x - g.W / 2 - 3, y: y - g.H / 2 - 3, w: g.W + 6, h: g.H + 6 }); x += dx; y += dy;
      c.add('packet', { x: x - g.W / 2, y: y - g.H / 2, w: g.W, h: g.H }, label, o.id, 'r'); if (label) c.said.push(label);
      return p => { const ang = (tilt + p.J(.025)) * Math.min(1, 70 / g.W); p.rbox(x, y, g.W, g.H, ang, { c: col }); if (g.t) boxText(p, label, x, y, g.W - 14, { size: 22, rot: ang }); };
    },
    oval(o, c) {
      let rx = c.n(o.rx, 1.5, .3, 7.6) * G, ry = c.n(o.ry, 1, .3, 4.2) * G; const label = dstr(o.label, 18);
      if (label) { while (rx < 140 && (wrapLabel(label, FLOOR, rx * 1.5, 9).length > 2 || wordW(label) > rx * 1.5)) rx += 6; const t = fit(label, rx * 1.5, { size: 22 }); ry = Math.max(ry, t.lines.length * t.lh / 1.4 + 6); }
      let x = c.px(o.x, 8), y = c.py(o.y, 4);
      const [dx, dy] = c.shift({ x: x - rx - 3, y: y - ry - 3, w: rx * 2 + 6, h: ry * 2 + 6 }); x += dx; y += dy;
      c.add('oval', { x: x - rx, y: y - ry, w: rx * 2, h: ry * 2 }, label, o.id, 'o'); if (label) c.said.push(label);
      const col = c.col(o.c);
      return p => { p.oval(x, y, rx, ry, col, 2.4, { fill: PAPER }); if (label) boxText(p, label, x, y, rx * 1.5, { size: 22 }); };
    },
    stack(o, c) {   // x,y = bottom middle of the pile
      const n = Math.round(c.n(o.n, 3, 1, 6)), label = dstr(o.label, 18), g = sizeBox(label, 100, 40, true), H = g.H;
      let x = c.px(o.x, 8), y = c.py(o.y, 6);
      const [dx, dy] = c.shift({ x: x - g.W / 2 - 6, y: y - n * H, w: g.W + 12, h: n * H }); x += dx; y += dy;
      c.add('stack', { x: x - g.W / 2, y: y - n * H, w: g.W, h: n * H }, label, o.id, 'r'); if (label) c.said.push(label);
      return p => { for (let i = 0; i < n; i++) { const cx = x + (i ? p.J(4) : 0), cy = y - H / 2 - i * H, a = p.J(.03); p.rbox(cx, cy, g.W, H, a); if (i === n - 1 && g.t) boxText(p, label, cx, cy, g.W - 14, { size: 22, rot: a }); } };
    },
    line(o, c) {
      const pts = (Array.isArray(o.pts) ? o.pts.slice(0, 8) : []).map(q => c.pt(q)).filter(Boolean);
      if (pts.length < 2) { c.warn('line needs 2..8 points'); return null; }
      const w = LW[Math.round(c.n(o.w, 2, 1, 3))], col = c.col(o.c), dash = o.dash === true ? `${f(w * 2.5)} ${f(w * 3.5)}` : undefined, xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
      c.add('line', { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
      return p => p.curve(pts, col, w, { passes: dash ? 1 : 2, dash });
    },
    arrow(o, c) {   // ends are resolved when painting: every id is known by then
      const end = v => typeof v === 'string' ? { id: v } : c.pt(v) ? { pt: c.pt(v) } : null, A = end(o.from), B = end(o.to);
      if (!A || !B) { c.warn('arrow needs from and to'); return null; }
      const label = dstr(o.label, 18), col = c.col(o.c), bend = c.n(o.bend, NaN, -1, 1), dash = o.dash === true ? '7 8' : undefined;
      return p => {
        const get = e => e.pt ? { pt: e.pt } : c.ids.has(e.id) ? c.ids.get(e.id) : null, a = get(A), b = get(B);
        if (!a || !b) { c.warn(`arrow: unknown id "${(!a ? A : B).id}"`); return; }
        const mid = e => e.pt || [e.r.x + e.r.w / 2, e.r.y + e.r.h / 2], ma = mid(a), mb = mid(b);
        const S = a.pt || edgeOf(a.r, a.shape, mb[0], mb[1], 3), E = b.pt || edgeOf(b.r, b.shape, ma[0], ma[1], 5);
        const L = Math.hypot(E[0] - S[0], E[1] - S[1]); if (L < 6) return;
        const nx = -(E[1] - S[1]) / L, ny = (E[0] - S[0]) / L, k = Number.isFinite(bend) ? bend * Math.min(80, L * .4) : p.J(Math.min(5, L * .03));
        const ctl = [(S[0] + E[0]) / 2 + nx * k, (S[1] + E[1]) / 2 + ny * k], w = 2.4;
        p.arrow([S, ctl, E], col, w, Math.min(13, L * .35), dash);
        const ax = [S[0], ctl[0], E[0]], ay = [S[1], ctl[1], E[1]]; c.add('arrow', { x: Math.min(...ax), y: Math.min(...ay), w: Math.max(...ax) - Math.min(...ax), h: Math.max(...ay) - Math.min(...ay) });
        if (!label) return;
        const t = fit(label, 220, { size: 22, lines: 2 }), m = [(S[0] + 2 * ctl[0] + E[0]) / 4, (S[1] + 2 * ctl[1] + E[1]) / 4], sg = ny > 0 || (Math.abs(ny) < .2 && nx < 0) ? -1 : 1;
        const H = (t.lines.length - 1) * t.lh + t.size * 1.05, ext = Math.abs(nx) * t.w / 2 + Math.abs(ny) * H / 2;
        let best = null;
        for (const along of [0, -.18, .18]) for (const extra of [8, 24, 44]) for (const side of [1, -1]) {
          const cx = m[0] + (E[0] - S[0]) * along + sg * side * nx * (ext + extra), cy = m[1] + (E[1] - S[1]) * along + sg * side * ny * (ext + extra), r = { x: cx - t.w / 2, y: cy - H / 2, w: t.w, h: H };
          const out = (r.x < 4 ? 4 - r.x : 0) + (r.x + r.w > 636 ? r.x + r.w - 636 : 0) + (r.y < 3 ? 3 - r.y : 0) + (r.y + r.h > 357 ? r.y + r.h - 357 : 0);
          const cost = out * 400 + c.obs.reduce((s, q) => s + overlap(r, q), 0) + extra * .3;
          if (!best || cost < best.cost) best = { cost, cx, cy };
        }
        const lp = T(c, label, best.cx, best.cy - (t.lines.length - 1) * t.lh / 2 + t.size * .3, { c: col, lines: 2, maxW: 220, k: 'arrow label' }); if (lp) lp(p);
      };
    },
    text(o, c) {
      const s = dstr(o.t, 40); if (!s) return null;
      const a = ['start', 'middle', 'end'].includes(o.anchor) ? o.anchor : 'middle', size = o.size === 'l' ? 28 : 22, col = c.col(o.c), x = c.px(o.x, 8), y = c.py(o.y, 4), rot = Math.round(c.n(o.rot, 0, -20, 20) * 10) / 10;
      const avail = a === 'start' ? 636 - x : a === 'end' ? x - 4 : 2 * Math.min(x - 4, 636 - x);
      let mw = clampN(avail, 140, 300); while (mw < 300 && wrapLabel(s, FLOOR, mw, 9).length > 3) mw += 20;   // as narrow as the room says, wider before a word is cut
      return T(c, s, x, y + size * .3, { size, c: col, anchor: a, rot, lines: 3, maxW: mw });
    },
    ticks(o, c) {
      const n = Math.round(c.n(o.n, 3, 1, 7)), len = c.n(o.len, .4, .1, 2) * G, dir = c.n(o.dir, -Math.PI / 2, -7, 7), col = c.col(o.c), R = 6 + len * 1.2;
      let x = c.px(o.x, 8), y = c.py(o.y, 4);
      const [dx, dy] = c.shift({ x: x - R, y: y - R, w: 2 * R, h: 2 * R }); x += dx; y += dy;
      return p => p.ticks(x, y, n, len, dir - .5, dir + .5, col, 2.2, 6);
    },
    ground(o, c) {
      const y = c.py(o.y, 7), a = c.px(o.x1, .3), b = c.px(o.x2, 15.7), x1 = Math.min(a, b), x2 = Math.max(a, b);
      return x2 - x1 < 8 ? null : p => p.line(x1, y, x2, y, INK, 2.2);
    },
    // ---- stage pieces (lifted in spirit from the scenes; the scenes themselves are untouched) ----
    flame(o, c) {   // x,y = middle of the base
      const s = c.n(o.s, 1, .3, 2.5); let x = c.px(o.x, 8), y = c.py(o.y, 6);
      const [dx, dy] = c.shift({ x: x - 76 * s, y: y - 140 * s, w: 152 * s, h: 140 * s }); x += dx; y += dy;
      c.add('flame', { x: x - 70 * s, y: y - 122 * s, w: 140 * s, h: 122 * s }, '', o.id, 'r');
      return p => {
        const P = (a, b) => [x + a * s, y + b * s], tongue = (cx, h, w) => p.curve([[cx - w, 0], [cx - w * .9, -h * .45], [cx - w * .2, -h * .7], [cx - w * .1, -h], [cx + w * .35, -h * .6], [cx + w * .8, -h * .4], [cx + w, 0]].map(q => P(...q)), ORANGE, 2.6);
        tongue(-36, 84, 28); tongue(0, 122, 34); tongue(40, 72, 24); p.ticks(x, y - 66 * s, 4, 12 * s, -2.9, -.3, ORANGE, 2, 60 * s);
      };
    },
    wall(o, c) {   // x,y = top left
      const W = c.n(o.w, 1.6, .5, 8) * G, H = c.n(o.h, 6, 1, 8.6) * G; let x = c.px(o.x, 8), y = c.py(o.y, 2);
      const [dx, dy] = c.shift({ x, y, w: W, h: H }); x += dx; y += dy;
      c.add('wall', { x, y, w: W, h: H }, '', o.id, 'r');
      return p => {
        p.rect(x, y, W, H);
        for (let yy = y + 26, row = 0; yy < y + H; yy += 26, row++) { p.line(x + 2, yy, x + W - 2, yy, INK, 1.6, { passes: 1 }); p.line(x + W * (row % 2 ? .25 : .53), yy - 25, x + W * (row % 2 ? .25 : .53), yy - 1, INK, 1.4, { passes: 1 }); }
      };
    },
    gate(o, c) {   // x,y = bottom middle of the post; the striped arm reaches left (open: raised)
      const H = c.n(o.h, 3.2, 1, 7) * G, open = o.open === true; let L = c.n(o.len, 5, 1.5, 12) * G; if (open) L = Math.min(L, 320 - H);
      const ph = open ? 1 : 0, dir = [-Math.cos(ph), -Math.sin(ph)], nv = [-dir[1], dir[0]];
      let x = c.px(o.x, 12), y = c.py(o.y, 7);
      const ex = x - 11 + dir[0] * L, ey = y - H + 14 + dir[1] * L, left = Math.min(x - 11, ex - 8), top = Math.min(y - H, ey - 8), r = { x: left, y: top, w: x + 11 - left, h: y - top };
      const [sx, sy] = c.shift(r); x += sx; y += sy; r.x += sx; r.y += sy;
      c.add('gate', r, '', o.id, 'r', { x: x - 11, y: y - H, w: 22, h: H });
      return p => {
        const X = x - 11, Y = y - H + 14, E = [X + dir[0] * L, Y + dir[1] * L];
        p.rect(x - 11, y - H, 22, H); p.oval(x, y - H + 14, 9, 9, INK, 2, { fill: PAPER });
        p.poly([[X + nv[0] * 8, Y + nv[1] * 8], [E[0] + nv[0] * 8, E[1] + nv[1] * 8], [E[0] - nv[0] * 8, E[1] - nv[1] * 8], [X - nv[0] * 8, Y - nv[1] * 8]], true, INK, 2.4, PAPER);
        for (let t = 20; t < L; t += 30) { const u = t - 12; p.line(X + dir[0] * t + nv[0] * 8, Y + dir[1] * t + nv[1] * 8, X + dir[0] * u - nv[0] * 8, Y + dir[1] * u - nv[1] * 8, INK, 2, { passes: 1 }); }
      };
    },
    conveyor(o, c) {   // y = the belt's top surface
      const a = clampN(c.px(o.x1, 3), 16, 600), b = clampN(c.px(o.x2, 11), 16, 624), x1 = Math.min(a, b), x2 = Math.max(a, b, x1 + G); let y = c.py(o.y, 6);
      const [dx, dy] = c.shift({ x: x1 - 8, y: y - 2, w: x2 - x1 + 16, h: 44 }); y += dy;
      c.add('conveyor', { x: x1 + dx - 8, y: y - 2, w: x2 - x1 + 16, h: 34 }, '', o.id, 'r');
      return p => {
        const X1 = x1 + dx, X2 = x2 + dx; p.line(X1, y, X2, y, INK, 2.4); p.line(X1, y + 16, X2, y + 16, INK, 2.4);
        p.oval(X1, y + 8, 8, 8, INK, 2.2, { fill: PAPER }); p.oval(X2, y + 8, 8, 8, INK, 2.2, { fill: PAPER });
        for (let q = X1 + 36; q < X2 - 20; q += 36) p.oval(q, y + 8, 3, 3, INK, 1.8, { passes: 1 });
        p.line(X1 + 10, y + 24, X1 + 6, y + 42, INK, 2.2, { passes: 1 }); p.line(X2 - 10, y + 24, X2 - 6, y + 42, INK, 2.2, { passes: 1 });
      };
    },
    magnifier(o, c) {   // x,y = middle of the lens
      const s = c.n(o.s, 1, .4, 2.5), r = 44 * s; let x = c.px(o.x, 8), y = c.py(o.y, 4);
      const [dx, dy] = c.shift({ x: x - r - 3, y: y - r - 3, w: r * 2.5 + 6, h: r * 2.5 + 6 }); x += dx; y += dy;
      c.add('magnifier', { x: x - r, y: y - r, w: r * 2, h: r * 2 }, '', o.id, 'o');
      return p => {
        p.line(x + r * .72, y + r * .72, x + r * 1.42, y + r * 1.42, INK, clampN(6 * s, 4, 9), { passes: 1 });
        p.oval(x, y, r, r * .96, INK, 3, { fill: PAPER }); p.curve([[x - r * .55, y - r * .1], [x - r * .42, y - r * .45], [x - r * .1, y - r * .62]], BLUE, 2.4, { passes: 1 });
      };
    },
    dial(o, c) {   // x,y = middle of the gauge
      const s = c.n(o.s, 1, .4, 2.5), r = 34 * s, label = dstr(o.label, 18); let x = c.px(o.x, 8), y = c.py(o.y, 4);
      const [dx, dy] = c.shift({ x: x - r - 3, y: y - r - 3, w: r * 2 + 6, h: r * 2 + 6 }); x += dx; y += dy;
      c.add('dial', { x: x - r, y: y - r, w: r * 2, h: r * 2 }, label, o.id, 'o');
      const lp = label && under(c, label, x, y + r, y - r);
      return p => {
        p.oval(x, y, r, r, INK, 2.8, { fill: PAPER });
        for (let i = 0; i < 9; i++) { const a = (150 + i * 30) * Math.PI / 180; p.line(x + Math.cos(a) * r * .74, y + Math.sin(a) * r * .74, x + Math.cos(a) * r * .9, y + Math.sin(a) * r * .9, INK, 1.8, { passes: 1 }); }
        const na = 305 * Math.PI / 180; p.line(x, y, x + Math.cos(na) * r * .7, y + Math.sin(na) * r * .7, ORANGE, 3, { passes: 1 }); p.oval(x, y, 3.5, 3.5, INK, 2, { fill: INK, passes: 1 }); if (lp) lp(p);
      };
    },
    cabinet(o, c) {   // x,y = bottom middle; top drawer open
      const s = c.n(o.s, 1, .4, 2.2), label = dstr(o.label, 18); let x = c.px(o.x, 8), y = c.py(o.y, 7);
      const [dx, dy] = c.shift({ x: x - 91 * s, y: y - 136 * s, w: 182 * s, h: 136 * s }); x += dx; y += dy;
      c.add('cabinet', { x: x - 89 * s, y: y - 134 * s, w: 178 * s, h: 134 * s }, label, o.id, 'r');
      const lp = label && under(c, label, x, y, y - 134 * s);
      return p => {
        const P = (a, b) => [x + a * s, y + b * s], R = (a, b, w, h) => p.rect(x + a * s, y + b * s, w * s, h * s);
        R(-75, -86, 150, 86); p.line(...P(-71, -43), ...P(71, -43), INK, 1.8); p.line(...P(-17, -64), ...P(17, -64), INK, 2.4); p.line(...P(-17, -21), ...P(17, -21), INK, 2.4);
        p.poly([P(-89, -112), P(89, -112), P(79, -134), P(-79, -134)], true, INK, 2.4, PAPER); R(-89, -112, 178, 30); p.line(...P(-17, -97), ...P(17, -97), INK, 2.4);
        [-45, -23, 37].forEach(a => p.line(...P(a, -132), ...P(a + 6, -115), INK, 1.6, { passes: 1 })); if (lp) lp(p);
      };
    },
    machine(o, c) {   // x,y = top left of the body; a hopper on the left, a chute on the right, a chimney on top
      const w = c.n(o.w, 3.8, 1.5, 9) * G, h = c.n(o.h, 3.5, 1.5, 6) * G, label = dstr(o.label, 18), g = sizeBox(label, w, h);
      let x = c.px(o.x, 6) + (w - g.W) / 2, y = c.py(o.y, 3) + (h - g.H) / 2; const W = g.W, H = g.H;
      const [dx, dy] = c.shift({ x: x - 20, y: y - 76, w: W + 48, h: H + 94 }); x += dx; y += dy;
      c.add('machine', { x: x - 18, y: y - 74, w: W + 44, h: H + 92 }, label, o.id, 'r'); if (label) c.said.push(label);
      return p => {
        p.rect(x, y, W, H); p.line(x + 14, y + H, x + 14, y + H + 18); p.line(x + W - 14, y + H, x + W - 14, y + H + 18);
        p.rect(x - 18, y + H * .38, 18, 46); p.rect(x + W, y + H * .68, 26, 32);
        const cx = x + W * .73; p.rect(cx, y - 32, 18, 32); p.curve([[cx + 9, y - 42], [cx, y - 56], [cx + 14, y - 66], [cx + 6, y - 78]], INK, 2);
        p.oval(x + W * .3, y + 26, 18, 18, INK, 2.2, { fill: PAPER }); p.line(x + W * .3, y + 26, x + W * .3 + 12, y + 16, INK, 2.2, { passes: 1 });
        p.ticks(x + W + 4, y + H * .64, 3, 14, -1.3, -.1, ORANGE, 2.4, 6);
        if (g.t) boxText(p, label, x + W / 2, y + H * .68, W - 14, { size: 22 }); else { p.line(x + 16, y + H * .72, x + W - 16, y + H * .72, INK, 1.8); p.line(x + 16, y + H * .72 + 14, x + W * .6, y + H * .72 + 14, INK, 1.8); }
      };
    },
    clock(o, c) {   // x,y = middle of the face, on two stick legs
      const s = c.n(o.s, 1, .4, 2.2), R = 50 * s, label = dstr(o.label, 18); let x = c.px(o.x, 8), y = c.py(o.y, 3);
      const [dx, dy] = c.shift({ x: x - R * 1.1, y: y - R * 1.18, w: R * 2.2, h: R * 3.08 }); x += dx; y += dy;
      c.add('clock', { x: x - R, y: y - R, w: R * 2, h: R * 2 }, label, o.id, 'o');
      const lp = label && under(c, label, x, y + R * 1.9, y - R * 1.2);
      return p => {
        p.line(x - R * .35, y + R * .9, x - R * .49, y + R * 1.86); p.line(x + R * .35, y + R * .9, x + R * .51, y + R * 1.86);
        p.line(x - R * .49, y + R * 1.86, x - R * .66, y + R * 1.86, INK, 2.4, { passes: 1 }); p.line(x + R * .51, y + R * 1.86, x + R * .68, y + R * 1.86, INK, 2.4, { passes: 1 });
        p.oval(x, y, R, R * .98, INK, 2.8, { fill: PAPER });
        for (let i = 0; i < 12; i++) { const a = i / 12 * TAU, q = i % 3 ? .87 : .7; p.line(x + Math.cos(a) * R * .8, y + Math.sin(a) * R * .8, x + Math.cos(a) * R * q, y + Math.sin(a) * R * q, INK, i % 3 ? 1.6 : 2.4, { passes: 1 }); }
        p.line(x, y, x - R * .44, y - R * .23, INK, 3.4, { passes: 1 }); p.line(x, y, x + R * .07, y - R * .74, INK, 2.4, { passes: 1 }); p.oval(x, y, 4, 4, INK, 2, { fill: INK, passes: 1 });
        p.curve([[x + R * .26, y - R * .95], [x + R * .47, y - R * .86], [x + R * .6, y - R * .7]], ORANGE, 2.2, { passes: 1 }); if (lp) lp(p);
      };
    }
  };

  function plan(rep) {
    const c = {
      obs: [], ids: new Map(), said: [], clamped: false,
      warn: m => { if (rep && rep.warnings.length < 40) rep.warnings.push(m); },
      n: (v, d, lo, hi) => { const x = toNum(v); if (!Number.isFinite(x)) return d; if (x < lo || x > hi) c.clamped = true; return clampN(x, lo, hi); },
      px: (v, d) => clampN(c.n(v, d, 0, 16) * G, 3, 637), py: (v, d) => clampN(c.n(v, d, 0, 9) * G, 3, 357),
      pt: v => Array.isArray(v) && v.length >= 2 && Number.isFinite(toNum(v[0])) && Number.isFinite(toNum(v[1])) ? [c.px(v[0], 0), c.py(v[1], 0)] : null,
      col: v => typeof v === 'string' && Object.prototype.hasOwnProperty.call(COL, v) ? COL[v] : INK,
      shift: r => { let dx = 0, dy = 0; if (r.x + r.w > 637) dx = 637 - r.x - r.w; if (r.x + dx < 3) dx = 3 - r.x; if (r.y + r.h > 357) dy = 357 - r.y - r.h; if (r.y + dy < 3) dy = 3 - r.y; return [dx, dy]; },
      add: (k, r, label, id, shape, att) => {
        const q = { k, label: label || '', x: r.x, y: r.y, w: r.w, h: r.h }; c.obs.push(q);
        if (typeof id === 'string' && /^[a-z0-9_-]{1,20}$/.test(id)) { q.id = id; if (shape && !c.ids.has(id)) c.ids.set(id, { r: att || q, shape }); else if (shape) c.warn(`duplicate id "${id}"`); }
      }
    };
    return c;
  }
  // spec: {caption, draw: [op, ...], name?}. opts: {w?, report?}. report (filled when given): {unknownOps, warnings, objects: [{k, id, label, x, y, w, h} in grid units]}
  function drawIn(spec, opts) {
    spec = spec && typeof spec === 'object' ? spec : {}; opts = opts && typeof opts === 'object' ? opts : {};
    const rep = opts.report && typeof opts.report === 'object' ? opts.report : null;
    if (rep) { rep.unknownOps = []; rep.warnings = []; rep.objects = []; }
    let caption = '', ops = [], items = [], c = null, p = null;
    try {
      caption = dstr(spec.caption, 120); ops = Array.isArray(spec.draw) ? spec.draw.slice(0, 40) : [];
      if (rep && Array.isArray(spec.draw) && spec.draw.length > 40) rep.warnings.push(`only the first 40 of ${spec.draw.length} ops are drawn`);
      let key = ''; try { key = JSON.stringify(ops) || ''; } catch (e) { key = ''; }
      p = pen(hash('draw|' + key + '|' + caption)); c = plan(rep);
      ops.forEach((o, i) => {
        if (!o || typeof o !== 'object' || Array.isArray(o)) { c.warn(`op ${i}: not an object`); return; }
        try {
          const name = typeof o.op === 'string' ? o.op : '';
          if (!Object.prototype.hasOwnProperty.call(OPS, name)) { if (rep) rep.unknownOps.push(name.slice(0, 20) || '(no op)'); return; }
          c.clamped = false; const it = OPS[name](o, c); if (c.clamped) c.warn(`op ${i} (${name}): a value was clamped into range`);
          if (it) items.push(it);
        } catch (e) { c.warn(`op ${i}: skipped (${String(e && e.message).slice(0, 40)})`); }
      });
    } catch (e) { items = []; }
    if (!items.length && typeof spec.name === 'string' && Object.prototype.hasOwnProperty.call(S, spec.name)) return render(spec.name, { caption: spec.caption, mood: spec.mood, items: spec.items, props: spec.props, w: opts.w });
    if (!p) p = pen(1);
    for (const it of items) { try { it(p); } catch (e) { if (rep) rep.warnings.push('a drawing step failed: ' + String(e && e.message).slice(0, 40)); } }
    if (!items.length && caption && c) { try { const lp = T(c, caption, 320, 190, { size: 28, lines: 3, maxW: 480 }); if (lp) lp(p); } catch (e) { /* an empty frame */ } }
    if (rep && c) rep.objects = c.obs.map(q => ({ k: q.k, id: q.id, label: q.label, x: f(q.x / G), y: f(q.y / G), w: f(q.w / G), h: f(q.h / G) }));
    const said = c ? [...new Set(c.said)].slice(0, 14) : [], w = toNum(opts.w);
    const label = ((caption || 'drawing') + (said.length ? ` (${said.join(', ')})` : '')).slice(0, 400);
    return svg(p.out.join(''), label, '0 0 640 360', Number.isFinite(w) && w > 0 ? Math.round(clampN(w, 40, 4000)) : undefined, 9 / 16).replace('<svg ', '<svg class="lens-scene" data-scene="draw" ');
  }
  // never throws: whatever goes wrong inside, a valid (empty) picture comes out
  function draw(spec, opts) { try { return drawIn(spec, opts); } catch (e) { return svg('', 'drawing', '0 0 640 360').replace('<svg ', '<svg class="lens-scene" data-scene="draw" '); } }
  return { names: NAMES.slice(), render, blot, context, draw, drawOps: ['blot', 'prop', 'box', 'packet', 'oval', 'stack', 'line', 'arrow', 'text', 'ticks', 'ground', 'flame', 'wall', 'gate', 'conveyor', 'magnifier', 'dial', 'cabinet', 'machine', 'clock'], _pen: pen };
})();
