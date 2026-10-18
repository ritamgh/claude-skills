// Shared by every theme: renders the blocks of one `data` section to an HTML string.
// The theme adds the heading and intro, and supplies colours through --d-a, --d-b, --d-c, --d-card, --d-rule, --d-head (see data.css).
// h = {rich, esc, paras}: the theme's own text helpers, so glossary tooltips work inside data blocks.
// Rendering never throws on bad input: a block that is not an object, or has an unknown type, is skipped; build.py reports it.
const DATA_TYPES = ['text', 'note', 'stats', 'table', 'bars', 'dumbbell', 'stack', 'sources'];
function dataBlocksHTML(blocks, h) {
  const { rich, esc, paras } = h;
  const isNum = v => typeof v === 'number' && isFinite(v);
  const arr = v => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
  const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
  let dec = null; // the current block's `decimals`: fixed places for every number in it, so 13 and 94.6 print as 13.0 and 94.6
  const show = (v, unit) => v == null ? '' : isNum(v) ? (dec == null ? String(Math.round(v * 100) / 100) : v.toFixed(dec)) + (unit || '') : String(v);
  const pct = (v, max) => max > 0 && isNum(v) ? Math.max(0, Math.min(100, v / max * 100)) : 0;
  const cap = b => b.caption ? `<div class="d-cap">${rich(b.caption)}</div>` : '';
  const foot = b => b.foot ? `<div class="d-foot">${rich(b.foot)}</div>` : '';
  const valw = strs => Math.max(72, Math.ceil(Math.max(0, ...strs.map(x => String(x).length)) * 9.3) + 6);
  const maxOf = (b, vals) => isNum(b.max) && b.max > 0 ? b.max : Math.max(0, ...vals.filter(isNum));

  const one = b => {
    dec = Number.isInteger(b.decimals) && b.decimals >= 0 && b.decimals <= 4 ? b.decimals : null;
    if (b.type === 'text') return `${b.title ? `<h3 class="d-h">${rich(b.title)}</h3>` : ''}<div class="d-text">${paras(b.text)}</div>`;
    if (b.type === 'note') return `<div class="d-note ${b.tone === 'warn' ? 'warn' : ''}">${b.title ? `<b>${rich(b.title)}</b>` : ''}${paras(b.text)}</div>`;
    if (b.type === 'stats') {
      return `<div class="d-stats">${arr(b.items).map(s => `<div class="d-stat"><div class="d-big">${esc(show(s.value, s.unit))}</div><div class="d-lab">${rich(s.label)}</div>${s.note ? `<div class="d-sub">${rich(s.note)}</div>` : ''}</div>`).join('')}</div>`;
    }
    if (b.type === 'table') {
      const cols = (Array.isArray(b.columns) ? b.columns : []).map(c => (c && typeof c === 'object') ? c : { label: c });
      const rows = (Array.isArray(b.rows) ? b.rows : []).filter(Array.isArray);
      const hi = new Set(Array.isArray(b.highlight) ? b.highlight : []);
      return `${cap(b)}<div class="d-tablewrap"><table class="d-table"><thead><tr>${cols.map(c => `<th class="${c.align === 'right' ? 'num' : ''}">${rich(c.label)}</th>`).join('')}</tr></thead><tbody>` +
        rows.map((r, i) => `<tr class="${hi.has(i) ? 'hi' : ''}">${cols.map((c, j) => {
          const v = r[j]; return j === 0 ? `<th scope="row" data-label="${esc(c.label)}">${rich(show(v))}</th>` : `<td class="${c.align === 'right' ? 'num' : ''}" data-label="${esc(c.label)}">${rich(show(v, c.unit))}</td>`; }).join('')}</tr>`).join('') + `</tbody></table></div>${foot(b)}`;
    }
    if (b.type === 'bars') {
      const rows = arr(b.rows), max = maxOf(b, rows.map(r => r.value));
      return `${cap(b)}<div class="d-bars" style="--d-valw:${valw(rows.map(r => show(r.value, b.unit)))}px">${rows.map(r => `<div class="d-row${r.hi ? ' hi' : ''}"><div class="d-name">${rich(r.label)}</div>
        <div class="d-track" role="img" aria-label="${esc(String(r.label))}: ${esc(show(r.value, b.unit))}"><span class="d-fill" style="width:${pct(r.value, max).toFixed(2)}%"></span></div>
        <div class="d-val">${esc(show(r.value, b.unit))}</div>${r.note ? `<div class="d-sub">${rich(r.note)}</div>` : ''}</div>`).join('')}</div>${foot(b)}`;
    }
    if (b.type === 'dumbbell') {
      const rows = arr(b.rows), max = maxOf(b, rows.flatMap(r => [r.from, r.to]));
      const ticks = isNum(b.step) && b.step > 0 && max > 0 && max / b.step <= 12 ? Array.from({ length: Math.floor(max / b.step) + 1 }, (_, i) => i * b.step) : [0, max / 2, max].filter((v, i, a) => max > 0 && a.indexOf(v) === i);
      return `${cap(b)}<div class="d-legend"><span><i class="d-dot from"></i>${rich(b.from_label || 'before')}</span><span><i class="d-dot to"></i>${rich(b.to_label || 'after')}</span></div>
        <div class="d-bars d-dumb" style="--d-valw:${valw(rows.map(r => show(r.from, b.unit) + ' → ' + show(r.to, b.unit)))}px">${rows.map(r => { const a = pct(r.from, max), z = pct(r.to, max);
          return `<div class="d-row"><div class="d-name">${rich(r.label)}</div>
            <div class="d-track" role="img" aria-label="${esc(String(r.label))}: ${esc(show(r.from, b.unit))} to ${esc(show(r.to, b.unit))}"><span class="d-span" style="left:${Math.min(a, z).toFixed(2)}%;width:${Math.abs(z - a).toFixed(2)}%"></span><i class="d-dot from" style="left:${a.toFixed(2)}%"></i><i class="d-dot to" style="left:${z.toFixed(2)}%"></i></div>
            <div class="d-val">${esc(show(r.from, b.unit))} → ${esc(show(r.to, b.unit))}</div>${r.note ? `<div class="d-sub">${rich(r.note)}</div>` : ''}</div>`; }).join('')}
          <div class="d-axis" aria-hidden="true"><span class="d-name"></span><span class="d-ticks">${ticks.map(t => `<span style="left:${pct(t, max).toFixed(2)}%">${esc(show(t, b.unit))}</span>`).join('')}</span><span class="d-val"></span></div></div>${foot(b)}`;
    }
    if (b.type === 'stack') {
      const rows = arr(b.rows), names = [];
      rows.forEach(r => arr(r.parts).forEach(p => { if (!names.includes(p.name)) names.push(p.name); }));
      return `${cap(b)}<div class="d-legend">${names.map((n, i) => `<span><i class="d-sw s${i % 4}"></i>${rich(n)}</span>`).join('')}</div>
        <div class="d-bars" style="--d-valw:${valw(rows.map(r => arr(r.parts).map(p => show(p.value, b.unit)).join(' / ')))}px">${rows.map(r => { const ps = arr(r.parts), tot = ps.reduce((s, p) => s + (isNum(p.value) ? Math.max(0, p.value) : 0), 0);
          return `<div class="d-row"><div class="d-name">${rich(r.label)}</div><div class="d-track d-stack" role="img" aria-label="${esc(String(r.label))}: ${ps.map(p => esc(`${p.name} ${show(p.value, b.unit)}`)).join(', ')}">${ps.map(p => `<span class="d-seg s${names.indexOf(p.name) % 4}" style="width:${tot > 0 ? (Math.max(0, p.value || 0) / tot * 100).toFixed(2) : 0}%"></span>`).join('')}</div>
            <div class="d-val">${ps.map(p => esc(show(p.value, b.unit))).join(' / ')}</div>${r.note ? `<div class="d-sub">${rich(r.note)}</div>` : ''}</div>`; }).join('')}</div>${foot(b)}`;
    }
    if (b.type === 'sources') {
      return `${cap(b)}<ol class="d-sources">${arr(b.items).map(s => { const u = safeUrl(s.url);
        return `<li>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${rich(s.label)}</a>` : `<span>${rich(s.label)}</span>`}${s.note ? `<div class="d-sub">${rich(s.note)}</div>` : ''}</li>`; }).join('')}</ol>`;
    }
    return '';
  };
  return arr(blocks).map(b => { if (!DATA_TYPES.includes(b.type)) return ''; try { return `<div class="d-block b-${esc(b.type)}">${one(b)}</div>`; } catch { return ''; } }).join('');
}
