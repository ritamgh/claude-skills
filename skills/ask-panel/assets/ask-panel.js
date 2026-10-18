/* ask-panel: an Ask button and side panel for any HTML page (skill ask-panel).
   Picks a backend at runtime: claude.ai artifact (window.claude "sample"), a local lens serve.py (/__lens/ask), or none (then it shows nothing). */
(() => {
  'use strict';
  const doc = document, html = doc.documentElement;
  if (html.dataset.askp) return;
  html.dataset.askp = 'starting';

  const MAX_PAGE = 60000, MAX_LOCAL_PAGE = 40000, MAX_QUOTE = 1500, MAX_HISTORY = 150000;
  const RULES = 'You answer a reader\'s questions about the web page whose text follows. Answer the question first, in plain words, then add only the detail that helps; usually 2 to 5 short paragraphs. ' +
    'Use only the page text; if the page does not say, say so instead of guessing. A passage the reader quotes was selected from the page. You cannot browse or change anything. ' +
    'Format: short paragraphs, `inline code`, short fenced code blocks, bold, simple bullet lists. No headings, no tables.';
  const HIDE_CODES = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];
  const MESSAGES = {
    rate_limited: 'Claude is busy or a usage limit was reached. Wait a little, then ask again.',
    session_expired: 'Your Claude session expired. Sign in again, then ask again.',
    refused: 'Claude declined this question. Try rewording it.',
    prompt_too_large: 'This page is too long to send. Select the part you mean and ask about that.',
    empty_completion: 'No answer came back. Try rewording the question.',
  };

  const S = { mode: 'off', sample: null, model: 'haiku', thread: [], session: null, busy: null, pending: null };
  const store = {
    get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window: fine */ } },
  };
  const h = (tag, cls, ...kids) => { const e = doc.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e; };

  // ---------- backend detection ----------
  function localKey() {
    const m = location.hash.match(/(?:^#|&)k=([\w-]+)/);
    if (m) { // serve.py's link carries its key in the #fragment; keep it for this origin and tidy the address bar
      store.set('lens:key', m[1]);
      const rest = location.hash.slice(1).split('&').filter(p => !p.startsWith('k=')).join('&');
      history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
    }
    return m ? m[1] : store.get('lens:key');
  }
  async function detect() {
    if (window.claude && typeof window.claude.use === 'function') {
      try { const sample = await window.claude.use('sample'); if (sample) return { mode: 'artifact', sample }; } catch { /* not available */ }
    }
    if (/^https?:$/.test(location.protocol)) {
      const key = localKey();
      if (key) {
        try {
          const r = await fetch('/__lens/health'), info = r.ok ? await r.json() : null;
          if (info && info.lens) return { mode: 'local', key, models: info.models };
        } catch { /* no helper here */ }
      }
    }
    return null;
  }

  // ---------- safe markdown: paragraphs, lists, `code`, **bold**, fenced blocks; DOM nodes only ----------
  const LI = /^\s*([-*]|\d+\.)\s+/;
  function inline(parent, s) {
    for (const p of s.split(/(`[^`]+`)/)) {
      if (/^`[^`]+`$/.test(p)) parent.append(h('code', '', p.slice(1, -1)));
      else for (const q of p.split(/(\*\*[^*]+\*\*)/)) { if (/^\*\*[^*]+\*\*$/.test(q)) parent.append(h('strong', '', q.slice(2, -2))); else if (q) parent.append(q); }
    }
  }
  function md(text) {
    const out = doc.createDocumentFragment();
    String(text).split('```').forEach((chunk, i) => {
      if (i % 2) return out.append(h('pre', '', h('code', '', chunk.replace(/^[\w+-]*\n/, '').replace(/\n$/, ''))));
      for (const block of chunk.split(/\n{2,}/)) {
        if (!block.trim()) continue;
        let run = [], kind = null;
        const flush = () => {
          if (!run.length) return;
          if (kind === 'p') { const p = h('p'); run.forEach((l, n) => { if (n) p.append(h('br')); inline(p, l); }); out.append(p); }
          else { const list = h(/^\s*\d/.test(run[0]) ? 'ol' : 'ul'); run.forEach(l => { const li = h('li'); inline(li, l.replace(LI, '')); list.append(li); }); out.append(list); }
          run = [];
        };
        for (const line of block.split('\n')) {
          const k = LI.test(line) ? 'li' : 'p';
          if (k !== kind) { flush(); kind = k; }
          run.push(k === 'p' ? line.replace(/^#+\s*/, '') : line);
        }
        flush();
      }
    });
    return out;
  }

  // ---------- page text (everything but the panel), cut at a section boundary ----------
  function pageText(max) {
    ui.root.style.display = 'none';
    let t = '';
    try { t = doc.body.innerText; } finally { ui.root.style.display = ''; }
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    if (t.length <= max) return t;
    let cut = t.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = t.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    return t.slice(0, cut).trimEnd() + '\n\n[The page text is cut here: the rest is longer than fits.]';
  }
  const turn = (q, quote) => quote ? `I selected this passage from the page:\n"""\n${quote}\n"""\n\n${q}` : q;

  // ---------- UI ----------
  const ui = {};
  function build() {
    ui.root = h('div', 'askp-root');
    ui.fab = h('button', 'askp-fab', 'Ask'); ui.fab.type = 'button'; ui.fab.setAttribute('aria-label', 'Ask about this page'); ui.fab.setAttribute('aria-expanded', 'false');
    ui.pop = h('button', 'askp-pop', 'Ask about this'); ui.pop.type = 'button'; ui.pop.hidden = true;
    ui.model = h('div', 'askp-model');
    for (const m of ['haiku', 'sonnet']) { const b = h('button', '', m[0].toUpperCase() + m.slice(1)); b.type = 'button'; b.dataset.model = m; b.onclick = () => { S.model = m; store.set('askp:model', m); sync(); }; ui.model.append(b); }
    ui.model.setAttribute('role', 'group'); ui.model.setAttribute('aria-label', 'Model');
    ui.newChat = h('button', 'askp-link', 'New chat'); ui.newChat.type = 'button';
    ui.close = h('button', 'askp-x', '×'); ui.close.type = 'button'; ui.close.setAttribute('aria-label', 'Close');
    ui.log = h('div', 'askp-log'); ui.log.setAttribute('aria-live', 'polite');
    ui.quoteText = h('span'); ui.quoteX = h('button', 'askp-x', '×'); ui.quoteX.type = 'button'; ui.quoteX.setAttribute('aria-label', 'Remove quote');
    ui.quote = h('div', 'askp-quote', ui.quoteText, ui.quoteX); ui.quote.hidden = true;
    ui.input = h('textarea', 'askp-input'); ui.input.rows = 2; ui.input.placeholder = 'Ask a question about this page'; ui.input.setAttribute('aria-label', 'Your question');
    ui.send = h('button', 'askp-send', 'Send'); ui.send.type = 'submit';
    ui.form = h('form', 'askp-form', ui.quote, h('div', 'askp-row', ui.input, ui.send));
    ui.panel = h('aside', 'askp-panel', h('div', 'askp-head', h('span', 'askp-title', 'Ask about this page'), ui.model, ui.newChat, ui.close), ui.log, ui.form);
    ui.panel.setAttribute('role', 'dialog'); ui.panel.setAttribute('aria-label', 'Ask about this page'); ui.panel.inert = true;
    ui.root.append(ui.fab, ui.pop, ui.panel);
    doc.body.append(ui.root);
  }
  function sync() {
    for (const b of ui.model.children) b.setAttribute('aria-pressed', String(b.dataset.model === S.model));
    ui.send.textContent = S.busy ? 'Stop' : 'Send';
  }
  function emptyHint() {
    ui.log.replaceChildren(h('div', 'askp-empty', 'Select any text on the page and press Ask about this, or just type a question. ' +
      (S.mode === 'local' ? 'Answers can also read the files this page came from.' : 'Answers come from the text of this page.')));
  }
  function open() { ui.panel.inert = false; ui.panel.classList.add('askp-open'); ui.fab.setAttribute('aria-expanded', 'true'); ui.input.focus({ preventScroll: true }); }
  function close() { ui.panel.classList.remove('askp-open'); ui.panel.inert = true; ui.fab.setAttribute('aria-expanded', 'false'); } // an answer in progress keeps streaming
  function hideAll() { S.busy?.abort(); ui.root.hidden = true; ui.root.style.display = 'none'; html.dataset.askp = 'denied'; }
  function setPending(quote) {
    S.pending = quote || null;
    ui.quote.hidden = !quote; ui.quoteText.textContent = quote ? `“${quote}”` : '';
  }

  // ---------- select text, then Ask ----------
  let selTimer, selText = '';
  function placePop() {
    const sel = getSelection(), text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
    const node = sel && sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (text.length < 2 || !el || ui.root.contains(el)) { ui.pop.hidden = true; return; }
    selText = text.slice(0, MAX_QUOTE);
    ui.pop.hidden = false;
    const r = sel.getRangeAt(0).getBoundingClientRect(), w = ui.pop.offsetWidth, ph = ui.pop.offsetHeight;
    let y = r.top - ph - 10; if (y < 8) y = r.bottom + 10;
    ui.pop.style.left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8) + 'px';
    ui.pop.style.top = Math.min(Math.max(8, y), innerHeight - ph - 8) + 'px';
  }

  // ---------- one question ----------
  const toolLabel = v => { const [tool, ...rest] = v.split(' '), arg = rest.join(' '); return tool === 'Read' ? `Reading ${arg.split('/').slice(-2).join('/')}…` : `${tool} ${arg}`.trim() + '…'; };

  async function viaSample(q, quote, signal, onText) {
    let past = S.thread.slice();
    const size = () => past.reduce((n, t) => n + t.q.length + t.a.length + (t.quote || '').length, 0);
    while (past.length && size() > MAX_HISTORY) past.shift();
    const msgs = [{ role: 'user', content: RULES + '\n\nPAGE TEXT:\n"""\n' + pageText(MAX_PAGE) + '\n"""' }];
    for (const t of past) msgs.push({ role: 'user', content: turn(t.q, t.quote) }, { role: 'assistant', content: t.a });
    msgs.push({ role: 'user', content: turn(q, quote) });
    const r = await S.sample(msgs, { cache: false, signal, modelTier: S.model === 'haiku' ? 'quick' : 'default', onText: u => onText(u.text, '') });
    return { text: r.text, note: r.truncated ? 'Cut short. Ask for less at a time.' : '' };
  }

  async function viaLocal(q, quote, signal, onText) {
    const body = { q, model: S.model, session: S.session || '', mode: 'report', lesson: doc.title || '', quote: quote || '' };
    if (!S.session) body.context = pageText(MAX_LOCAL_PAGE);
    const r = await fetch('/__lens/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lens-Key': S.key }, signal, body: JSON.stringify(body) });
    if (!r.ok) throw { message: (await r.json().catch(() => ({}))).error || `The helper answered ${r.status}.` };
    const rd = r.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '', finished = false, failure = '';
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.t === 'session') S.session = ev.v;
        else if (ev.t === 'text') { text += ev.v; onText(text, ''); }
        else if (ev.t === 'tool') onText(text, toolLabel(ev.v));
        else if (ev.t === 'error') failure = ev.v;
        else if (ev.t === 'done') finished = true;
      }
    }
    if (failure) throw { message: failure, text };
    if (!finished) throw { message: 'The answer was cut off. Ask again, or press New chat.', text };
    if (!text.trim()) throw { message: 'No answer came back. Try again, or switch model.' };
    return { text, note: '' };
  }

  async function send(q) {
    q = q.trim();
    if (!q || S.busy) return;
    const quote = S.pending; setPending(null); ui.input.value = '';
    ui.log.querySelector('.askp-empty')?.remove();
    const who = S.model[0].toUpperCase() + S.model.slice(1);
    const body = h('div', 'askp-body'), status = h('div', 'askp-status', `${who} is thinking…`);
    ui.log.append(h('div', 'askp-me', ...(quote ? [h('span', 'askp-qt', quote)] : []), q), h('div', 'askp-ai', h('div', 'askp-who', who), body, status));
    const near = () => ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 80, stick = () => { ui.log.scrollTop = ui.log.scrollHeight; };
    stick();
    const ctrl = new AbortController(); S.busy = ctrl; sync();
    const show = (text, st) => { const stuck = near(); body.replaceChildren(md(text)); status.textContent = st; if (stuck) stick(); };
    const fail = (msg, partial) => { if (partial) body.replaceChildren(md(partial)); status.textContent = ''; body.append(h('p', 'askp-err', msg)); };
    try {
      const r = await (S.mode === 'artifact' ? viaSample : viaLocal)(q, quote, ctrl.signal, show);
      status.textContent = r.note;
      if (S.mode === 'artifact') S.thread.push({ q, quote, a: r.text });
    } catch (e) {
      if (e?.code === 'cancelled' || e?.name === 'AbortError') { status.textContent = 'Stopped.'; if (e.text) body.replaceChildren(md(e.text)); }
      else if (HIDE_CODES.includes(e?.code)) hideAll();
      else if (e?.code === 'refused') { body.replaceChildren(); fail(MESSAGES.refused); }
      else fail(MESSAGES[e?.code] || (/fetch/i.test(e?.message || '') ? 'Lost the connection to the helper. Is serve.py still running?' : e?.message || 'Something went wrong. Try again.'), e?.text);
    } finally { S.busy = null; sync(); }
  }

  function reset() { S.busy?.abort(); S.thread = []; S.session = null; setPending(null); emptyHint(); }

  // ---------- start ----------
  detect().then(found => {
    if (!found) { html.dataset.askp = 'off'; return; }
    S.mode = found.mode; S.sample = found.sample || null; S.key = found.key || '';
    const saved = store.get('askp:model');
    if (saved === 'haiku' || saved === 'sonnet') S.model = saved;
    if (found.models && !found.models.includes(S.model)) S.model = found.models[0];
    build(); emptyHint(); sync();
    ui.fab.onclick = () => (ui.panel.classList.contains('askp-open') ? close() : open());
    ui.close.onclick = () => { close(); ui.fab.focus(); };
    ui.newChat.onclick = reset;
    ui.quoteX.onclick = () => setPending(null);
    ui.form.onsubmit = e => { e.preventDefault(); if (S.busy) S.busy.abort(); else send(ui.input.value); };
    ui.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!S.busy) send(ui.input.value); } });
    doc.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.panel.classList.contains('askp-open')) { close(); ui.fab.focus(); } });
    doc.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(placePop, 160); });
    addEventListener('scroll', () => { if (!ui.pop.hidden) placePop(); }, { passive: true });
    ui.pop.addEventListener('mousedown', e => e.preventDefault()); // keep the selection while clicking
    ui.pop.onclick = () => { setPending(selText); ui.pop.hidden = true; getSelection().removeAllRanges(); open(); };
    html.dataset.askp = found.mode;
  });
})();
