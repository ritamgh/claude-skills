"""Generator for examples/lens-architecture.json: an architecture-mode lesson about lens itself.

Every snippet is sliced from the real files by code(), and every file:line cited in the prose is looked up
by ln(), so the lesson cannot drift from the source by hand-editing. Run it after changing build.py,
serve.py or zine.html, then rebuild:

  python3 examples/lens-architecture.gen.py
  python3 scripts/build.py examples/lens-architecture.json examples/lens-architecture.html --check-src .
"""
import json, pathlib

LENS = pathlib.Path(__file__).resolve().parent.parent
BP, SP, ZP = 'scripts/build.py', 'scripts/serve.py', 'assets/themes/zine.html'
_cache = {}


def lines(file):
    if file not in _cache:
        _cache[file] = (LENS / file).read_text().splitlines()
    return _cache[file]


def ln(file, needle, nth=0):
    """1-based line number of the nth line containing needle; raises if it is not there."""
    hits = [i + 1 for i, s in enumerate(lines(file)) if needle in s]
    if len(hits) <= nth:
        raise SystemExit(f'ln: {needle!r} not found (hit {nth}) in {file}')
    return hits[nth]


def code(file, a, b, hl=(), notes=None, lang='python'):
    return {'file': file, 'start': a, 'lang': lang, 'src': '\n'.join(lines(file)[a - 1:b]),
            'highlight': list(hl), 'notes': {str(k): v for k, v in (notes or {}).items()}}


kb = lambda f: round((LENS / f).stat().st_size / 1024)

# ---- build.py anchors
b_val_def, b_val_end = ln(BP, 'def validate'), ln(BP, '    return errs, warns')
b_cc_def = ln(BP, 'def check_code')
b_cc_end = ln(BP, 'errs.append(f"{where}: snippet does not match')
b_repo_check = ln(BP, '    if repo and c.get("file"):')
b_nofile = ln(BP, 'if repo and not c.get("file")')
b_read = ln(BP, 'real = p.read_text')
b_norm = ln(BP, 'norm = lambda s')
b_bad = ln(BP, 'bad = [start + i')
b_inc_def, b_inc_end = ln(BP, 'def apply_includes'), ln(BP, 'return INCLUDE.sub')
b_ph = ln(BP, 'if ph in body')
b_render_def = ln(BP, 'def render')
b_data = ln(BP, 'data = json.dumps(lesson')
b_script_esc = ln(BP, 'data = re.sub(r"<(?=!--|script)"')
b_sub = ln(BP, 'return re.sub("|".join(PLACEHOLDERS)')
b_page = ln(BP, 'page = render(apply_includes')
b_write = ln(BP, 'out.write_text(page)')
b_warnloop = ln(BP, 'for w in warns:')
b_exit = ln(BP, 'sys.exit(1)')
b_nodes_warn = ln(BP, 'if not 2 <= len(nodes) <= 14')
b_nodes_loop, b_fn_code = ln(BP, 'for n in nodes:'), ln(BP, 'check_code(f["code"]')
# ---- serve.py anchors
s_timeout = ln(SP, 'TIMEOUT = int')
s_token_def, s_mode = ln(SP, 'def token()'), ln(SP, '0o600')
s_cmd_def, s_cmd_end = ln(SP, 'def claude_cmd'), ln(SP, '    return cmd')
s_tools, s_settings, s_resume = ln(SP, '"--tools", "Read,Grep,Glob"'), ln(SP, '"--settings"'), ln(SP, 'cmd += ["--resume"')
s_same_def, s_same_ret = ln(SP, 'def _same_origin'), ln(SP, 'return self.headers.get("Host") in ok')
s_post_def, s_key = ln(SP, 'def do_POST'), ln(SP, 'secrets.compare_digest')
s_origin_gate = ln(SP, 'if not self._same_origin():', 1)
s_session_re = ln(SP, 'if session and not re.fullmatch')
s_events_def, s_sess_yield = ln(SP, 'def events(proc)'), ln(SP, 'if d.get("session_id")')
s_popen, s_stop_def, s_killpg = ln(SP, 'proc = subprocess.Popen'), ln(SP, 'def stop():'), ln(SP, 'os.killpg')
s_timer, s_watch_def, s_peek = ln(SP, 'timer = threading.Timer'), ln(SP, 'def watch():'), ln(SP, 'MSG_PEEK')
s_select, s_stopcall = ln(SP, 'select.select([self.connection]'), ln(SP, 'return stop()')
s_final_wait, s_done = ln(SP, '            proc.wait()'), ln(SP, 'emit({"t": "done"})')
s_stdin = ln(SP, 'proc.stdin.write(prompt)')
s_doc_api = ln(SP, 'API used by the theme')
s_doc_login = ln(SP, 'Questions run through your own Claude Code login')
s_buildprompt = ln(SP, 'def build_prompt')
s_main_ports = ln(SP, 'for port in range(a.port')
# ---- SKILL.md anchors
SK = 'SKILL.md'
k_gather, k_verify = ln(SK, '### 2. Gather evidence'), ln(SK, '### 5. Verify')
# ---- zine.html anchors
z_script, z_parse = ln(ZP, '<script id="lesson"'), ln(ZP, 'const L = JSON.parse')
z_arch, z_key, z_qkey = ln(ZP, "const ARCH = L.mode === 'architecture'"), ln(ZP, "const KEY = 'lens:'"), ln(ZP, 'const QKEY')
z_pkey, z_storeset = ln(ZP, 'const PKEY'), ln(ZP, 'set(k, v) { try')
z_last, z_hash = ln(ZP, "store.set('last'"), ln(ZP, 'location.hash.match')
z_busy, z_fetch = ln(ZP, 'if (ASK.busy) return toast'), ln(ZP, "fetch('/__lens/ask'")
z_cut, z_abort = ln(ZP, 'The answer was cut off'), ln(ZP, 'ASK.busy ? ASK.busy.abort()')
z_health, z_sel = ln(ZP, "fetch('/__lens/health')"), ln(ZP, 'quote: text.slice(0, 1500)')
z_copy, z_inner = ln(ZP, 'return copy(`About the'), ln(ZP, 'body.innerHTML = md(text)')
z_curve, z_boot = ln(ZP, 'function curve('), ln(ZP, 'renderMapSection(); syncMode()')
z_resume, z_session = ln(ZP, 'if (S.last && traces[S.last.trace]'), ln(ZP, "if (ev.t === 'session') ASK.session = ev.v")
z_stopped, z_nokey = ln(ZP, "status.textContent = 'Stopped.'"), ln(ZP, 'ASK.key = m?.[1]')
z_grid = ln(ZP, 'const grid = (() =>')
SKP = 'assets/themes/sketch.html'
sk_include = ln(SKP, '<!-- lens:include scenes.js -->')
sk_props_include = ln(SKP, '<!-- lens:include props.js -->')
sk_ctx_def, sk_ctx_end = ln(SKP, 'function ctxPlate'), ln(SKP, 'return `<figure class="plate ctx">')
sk_pick = ln(SKP, 'n.scene ? plate(n) : ctxPlate(n)')
PJ = 'assets/themes/parts/props.js'
p_names = ln(PJ, 'names: [')
b_props_in_def, b_props_in_end = ln(BP, 'def props_in'), ln(BP, '    return out')
b_check_prop = ln(BP, 'def check_prop')
b_unknown = ln(BP, 'is not in the prop library')



def P(prop, label):
    assert len(label) <= 18, label
    return {'prop': prop, 'label': label}


def SC(name, caption, items=None, props=None):
    """An authored scene: caption <= 60 chars, items = the real things that move, props = the real places."""
    assert len(caption) <= 44, caption  # longer captions are clipped by the sketch renderer
    assert all(len(i) <= 18 for i in items or []) and len(items or []) <= 4, items
    sc = {'name': name, 'caption': caption}
    if items:
        sc['items'] = items
    if props:
        assert len(props) <= 3
        sc['props'] = props
    return sc


# ---- bespoke drawings (scene.draw): one dict per picture, each a different composition. Grid is 16 x 9, y grows downward.
def _op(op, **k):
    d = {'op': op}
    d.update(k)
    return d
def blot(x, y, **k): return _op('blot', x=x, y=y, **k)
def prop(name, x, y, size=2, label=None, **k): return _op('prop', name=name, x=x, y=y, size=size, **({'label': label} if label else {}), **k)
def box(x, y, w, h, label=None, **k): return _op('box', x=x, y=y, w=w, h=h, **({'label': label} if label else {}), **k)
def pkt(x, y, label, **k): return _op('packet', x=x, y=y, label=label, **k)
def oval(x, y, rx, ry, label=None, **k): return _op('oval', x=x, y=y, rx=rx, ry=ry, **({'label': label} if label else {}), **k)
def stack(x, y, n=3, label=None, **k): return _op('stack', x=x, y=y, n=n, **({'label': label} if label else {}), **k)
def line(pts, **k): return _op('line', pts=pts, **k)
def arrow(a, b, **k): return _op('arrow', **{'from': a, 'to': b}, **k)
def text(x, y, t, **k): return _op('text', x=x, y=y, t=t, **k)
def ticks(x, y, **k): return _op('ticks', x=x, y=y, **k)
def ground(y, x1=None, x2=None): return _op('ground', y=y, **({'x1': x1} if x1 is not None else {}), **({'x2': x2} if x2 is not None else {}))
def cross(x, y, r=.7, c='red'):  # a hand-drawn X: "this does not happen"
    return [line([[x - r, y - r], [x + r, y + r]], c=c, w=3), line([[x + r, y - r], [x - r, y + r]], c=c, w=3)]


def D(caption, ops):
    flat = []
    for o in ops:
        flat.extend(o if isinstance(o, list) else [o])
    ids = [o['id'] for o in flat if 'id' in o]
    assert len(caption) <= 60 and 1 <= len(flat) <= 40 and len(ids) == len(set(ids)), (caption, len(flat))
    for o in flat:
        assert len(o.get('label') or '') <= 18 and len(o.get('t') or '') <= 40, o
    return {'caption': caption, 'draw': flat}

DRAW = {}
# --- what-ifs ------------------------------------------------------------------------------------------------
# No helper running: the Ask button cannot POST, so the page offers Copy question and you paste it into Claude yourself.
DRAW['no_helper'] = D('no helper: Ask becomes Copy question', [
    prop('browser', 2.4, 2.2, 2.2, 'lesson page', id='pg'),
    prop('server', 13.6, 1.8, 2.2, 'serve.py', id='sv'),
    cross(13.6, 1.8, 1.2),
    arrow('pg', 'sv', c='red', dash=True, label='POST /__lens/ask'),
    box(5.8, 4.9, 3.8, 1.4, 'Copy question', id='cq'),
    arrow('pg', 'cq', c='blue', bend=.3),
    prop('terminal', 14.0, 6.0, 2.0, 'claude', id='cl'),
    blot(11.4, 5.6, s=.85, mood='happy', arms=[[10.0, 5.6], [12.8, 6.0]]),
])
# claude hangs: the 300 s timer fires and kills the process group, then one red error line closes the stream.
DRAW['silent'] = D('300 s of silence, then claude is killed', [
    _op('clock', x=8.0, y=2.4, s=1.4, label='300 s', id='clk'),
    prop('terminal', 2.6, 6.0, 2.0, 'claude -p', id='cl'),
    text(2.6, 3.7, 'z z z', c='blue', size='l', rot=-8),
    arrow('clk', 'cl', c='red', bend=.3, label='killpg'),
    blot(12.8, 5.4, s=.9, mood='happy', arms=[[11.4, 4.6], [14.2, 4.4]]),
    text(12.6, 8.3, 'No answer within the 300-second limit', c='red'),
])
# storage blocked: writes are swallowed, so Plain/Deep and quiz answers are forgotten; the ask key lives only in memory.
DRAW['no_storage'] = D('storage blocked: progress is forgotten', [
    prop('database', 8.0, 2.0, 2.4, 'localStorage', id='ls'),
    prop('lock', 9.4, 2.7, 1.0),
    prop('browser', 2.4, 6.2, 2.0, 'lesson page', id='pg'),
    arrow('pg', 'ls', c='red', dash=True, bend=-.2, label='write swallowed'),
    pkt(11.0, 5.0, 'ask key', c='blue', id='key'),
    blot(13.4, 5.8, s=.9, mood='worried', arms=[[12.3, 5.2], [14.6, 5.2]]),
    text(11.8, 8.3, 'kept in memory until reload', c='blue'),
])
# an icon name that props.js does not have: the build warns and exits 0, the page draws a plain box.
DRAW['jetpack'] = D('unknown prop: a plain box is drawn', [
    pkt(2.4, 1.6, 'jetpack', c='red', tilt=-.08, id='jp'),
    _op('cabinet', x=3.4, y=7.4, s=.8, label='props.js', id='ps'),
    arrow('jp', 'ps', dash=True, label='not found'),
    blot(8.2, 5.2, s=.9, mood='worried', look=[-.3, .1], arms=[[7.0, 4.4], [9.8, 4.0]]),
    _op('magnifier', x=6.2, y=4.2, s=.8),
    box(11.6, 2.6, 3.2, 1.6, 'jetpack', id='gb'),
    text(13.2, 5.4, 'a generic box', c='blue'),
    text(13.2, 6.2, 'build still ok', c='blue'),
])
# --- invariants ----------------------------------------------------------------------------------------------
# render() turns `</` in the lesson data into `<\/` so a step cannot close the data script.
DRAW['escape'] = D('render() escapes </ in the lesson data', [
    pkt(4.0, 1.6, '</script>', c='red', id='raw'),
    pkt(4.0, 6.4, '<\\/script>', c='blue', id='safe'),
    arrow('raw', 'safe', bend=.2),
    text(7.8, 1.6, 'render()', c='blue'),
    blot(7.6, 4.0, s=.9, mood='proud', arms=[[4.4, 3.9], [9.2, 4.6]]),
    prop('browser', 13.6, 5.8, 2.0, 'page draws', id='pg'),
    arrow('safe', 'pg', c='blue', bend=.3),
])
# serve.py checks the own Host first, then X-Lens-Key; a foreign site gets 403.
DRAW['own_host'] = D('own Host, then X-Lens-Key; else 403', [
    pkt(2.4, 3.2, 'other site', c='red', tilt=-.1, id='bad'),
    pkt(2.4, 5.8, '127.0.0.1', c='blue', id='ok'),
    _op('gate', x=7.6, y=7.6, h=3.4, len=2.6),
    text(2.6, 8.4, '403', c='red', size='l'),
    blot(10.2, 5.6, s=.9, mood='proud', arms=[[8.6, 4.8], [10.1, 3.1]]),
    prop('key', 10.0, 2.2, 1.6, id='key'), text(12.8, 2.3, 'X-Lens-Key', c='blue'),
    prop('server', 14.2, 5.4, 2.2, 'serve.py', id='sv'),
])
# claude -p gets Read, Grep and Glob only: Edit, Write and Bash stay behind a wall.
DRAW['read_only'] = D('Read, Grep, Glob only: no edit tool', [
    pkt(2.2, 1.7, 'Read', c='blue', id='t1'), pkt(2.2, 3.3, 'Grep', c='blue', id='t2'), pkt(2.2, 4.9, 'Glob', c='blue', id='t3'),
    prop('terminal', 8.4, 3.4, 2.4, 'claude -p', id='cl'),
    arrow('t1', 'cl', c='blue', bend=.15), arrow('t2', 'cl', c='blue'), arrow('t3', 'cl', c='blue', bend=-.15),
    _op('wall', x=9.8, y=5.8, w=.9, h=2.8),
    pkt(13.0, 6.2, 'Edit', c='red', id='e1'), pkt(13.0, 7.6, 'Write, Bash', c='red', id='e2'),
    blot(6.4, 6.9, s=.7, mood='proud', arms=[[5.6, 5.8], [9.7, 6.6]]),
])
# --- pressure points -----------------------------------------------------------------------------------------
# the map is a fixed grid of fixed boxes; an edge is one curve between box sides and never routes around a box.
DRAW['grid'] = D('a fixed grid: build warns outside 2 to 14', [
    box(1.0, 1.2, 2.6, 1.3, 'writer'), box(4.6, 1.2, 2.6, 1.3, 'source'), box(8.2, 1.2, 2.6, 1.3, 'validator', id='mid'),
    box(1.0, 5.4, 2.6, 1.3, 'assembler', id='a'), box(4.6, 5.4, 2.6, 1.3, 'theme'), box(8.2, 5.4, 2.6, 1.3, 'helper', id='b'),
    arrow([3.7, 5.62], [8.1, 5.62], c='red', bend=0),
    text(6.0, 7.8, 'the edge runs through a box', c='red'),
    blot(13.4, 5.2, s=.85, mood='worried', arms=[[12.2, 4.6], [14.6, 4.4]]),
    text(13.4, 8.2, 'warns outside 2 to 14', c='blue', anchor='middle'),
])
# every question starts its own claude -p; serve.py has no semaphore, only the 300 s limit.
DRAW['no_cap'] = D('one claude -p per question, no cap', [
    pkt(2.0, 4.4, 'question', id='q'),
    prop('server', 6.8, 4.4, 2.4, 'serve.py', id='sv'),
    arrow('q', 'sv'),
    prop('terminal', 13.8, 1.6, 1.6, 'claude -p', id='c1'), prop('terminal', 13.8, 4.4, 1.6, 'claude -p', id='c2'), prop('terminal', 13.8, 7.2, 1.6, 'claude -p', id='c3'),
    arrow('sv', 'c1', bend=-.2), arrow('sv', 'c2'), arrow('sv', 'c3', bend=.2),
    text(10.8, 7.9, 'no cap', c='red', size='l', rot=-6),
    blot(3.2, 7.0, s=.7, mood='worried', arms=[[2.5, 5.9], [3.9, 5.9]]),
])
# --- decisions -----------------------------------------------------------------------------------------------
# Claude writes lesson.json (data); the fixed themes draw it. A page the model wrote itself is the road not taken.
DRAW['data_not_html'] = D('Claude writes lesson.json; themes draw', [
    prop('model', 2.2, 4.4, 2.2, 'Claude', id='cl'),
    prop('braces', 7.2, 4.4, 2.0, 'lesson.json', id='js'),
    arrow('cl', 'js', c='blue'),
    prop('browser', 13.4, 1.9, 1.8, 'zine', id='z'), prop('browser', 13.4, 6.4, 1.8, 'sketch', id='s'),
    arrow('js', 'z', c='blue', bend=-.2), arrow('js', 's', c='blue', bend=.2),
    pkt(4.8, 1.2, 'model-made HTML', c='red'),
    text(4.8, 2.1, 'not this', c='red'),
    blot(10.4, 4.4, s=.6, mood='proud', arms=[[9.6, 3.4], [10.6, 5.2]]),
])
# questions run through the reader's own `claude -p` login; an API key would need storage and billing.
DRAW['own_login'] = D('claude -p under your login, no API key', [
    prop('key', 8.0, 1.6, 1.6, 'API key', id='ak'),
    cross(8.0, 1.6, 1.0),
    prop('user', 2.4, 5.0, 2.2, 'your login', id='u'),
    prop('terminal', 13.4, 5.0, 2.2, 'claude -p', id='cl'),
    arrow('u', 'cl', c='blue', label='inherited', bend=-.2),
    blot(8.0, 6.3, s=.8, mood='happy', arms=[[6.8, 5.6], [9.2, 5.6]]),
])
# --- risks ---------------------------------------------------------------------------------------------------
# without --check-src a wrong snippet builds fine: the check_code magnifier is never picked up.
DRAW['opt_in'] = D('no --check-src: a wrong snippet passes', [
    ground(7.9, .5, 15.5),
    box(1.0, 2.0, 3.6, 1.5, 'totally wrong', c='red', id='bad'),
    _op('machine', x=6.4, y=1.6, w=3.0, h=3.0, label='build.py', id='bp'),
    arrow('bad', 'bp', dash=True),
    pkt(13.4, 3.4, 'ok: wrote', c='blue', id='ok'),
    arrow('bp', 'ok', c='blue'),
    blot(9.0, 6.1, s=.8, mood='blank', look=[.3, 0], arms=[[7.8, 6.6], [10.4, 5.6]]),
    _op('magnifier', x=6.4, y=6.9, s=.7),
    text(12.8, 7.2, '--check-src not given', c='red', anchor='middle'),
])
# events() reads claude's stream-json by hand: a renamed event type is skipped and the answer panel stays empty.
DRAW['by_hand'] = D('events() parses by hand; a rename breaks it', [
    pkt(3.4, .9, 'text', id='e1'), pkt(6.0, .9, 'tool', id='e2'), pkt(11.8, 1.6, 'renamed', c='red', tilt=.2, id='e3'),
    _op('machine', x=4.8, y=3.5, w=3.6, h=2.3, label='events()', id='ev'),
    arrow('e1', 'ev', bend=.2), arrow('e2', 'ev'),
    arrow('e3', [13.8, 5.0], c='red', bend=.4, label='skipped'),
    box(5.4, 7.0, 3.6, 1.2, 'answer panel', id='ap'),
    arrow('ev', 'ap', c='blue', dash=True),
    blot(1.8, 5.2, s=.8, mood='worried', arms=[[3.0, 4.4], [.9, 6.3]]),
    text(12.4, 8.2, 'No answer came back', c='red', anchor='middle'),
])


nodes = [
 {'id': 'writer', 'label': 'Claude, the writer', 'kind': 'model in a Claude Code session', 'prop': 'model', 'layer': 'author', 'col': 0, 'row': 0,
  'files': [f'{SK}:{k_gather}-{k_verify - 1}'],
  'simple': 'The only part that thinks. It reads the real code, then writes the lesson as plain data: nodes, edges, steps and a quiz. It never writes the page itself.',
  'deep': "SKILL.md's workflow has Claude resolve the question, gather evidence with `nl -ba FILE | sed -n 'A,Bp'` so line numbers are exact, then write a small Python generator whose `code()` helper slices snippets straight out of the source file. The generator emits the lesson JSON and runs build.py. Everything the model decides lives in that JSON. Layout, interaction and styling are not its job: SKILL.md says 'Your job is to produce excellent *lesson data*. The template does the rest.'",
  'analogy': 'An author who hands the typesetter a manuscript, not a printed book.',
  'owns': 'What the lesson claims, and how sure it is.',
  'exposes': 'One JSON file shaped by reference/lesson-schema.md.',
  'runs': 'Your Claude Code session. The only step in the whole pipeline that needs a model.',
  'scale': 'One lesson per question. The schema budgets (4 to 10 map nodes, at most 25 lines per snippet) cap its size, because the reader is the limit, not the machine.',
  'confidence': 'evidenced'},
 {'id': 'source', 'label': 'Real source files', 'kind': 'the code being explained', 'prop': 'folder', 'layer': 'author', 'col': 0, 'row': 2,
  'files': [f'{BP}:{b_repo_check}-{b_cc_end}'],
  'simple': 'The files the lesson is about. The lesson shows lines copied from them, and the build can check each copy against the original.',
  'deep': f'build.py never runs or parses this code. With `--check-src REPO` it opens the file named by each snippet, takes `start` and the snippet length, and compares line by line ({BP}:{b_read}-{b_cc_end}). The file is looked up relative to REPO first, then as a `~` path. The comparison ignores trailing spaces and any snippet line that is only `...`.',
  'owns': 'The truth every snippet is held to.',
  'exposes': 'Plain text files, addressed by path and line number.',
  'runs': 'Wherever the explained repo lives. lens only reads it.',
  'scale': f'The whole file is re-read for every snippet ({BP}:{b_read}). At 25 lines a snippet that never matters.',
  'confidence': 'evidenced'},
 {'id': 'validator', 'label': 'Validator', 'kind': 'build.py: validate and check_code', 'prop': 'shield', 'layer': 'build', 'col': 1, 'row': 2,
  'files': [f'{BP}:{b_val_def}-{b_val_end}', f'{BP}:{b_cc_def}-{b_cc_end}'],
  'simple': 'Reads the lesson before anything is drawn. Mistakes that would break the page are errors and stop the build. Softer problems are warnings you should still read.',
  'deep': f'`validate()` fills two lists and never raises: a field of the wrong type is reported as an error, not a crash. Errors: unknown node ids, a `sync` that is not a real boolean, missing required text, a scene name outside the twelve, a snippet that does not match its file. Warnings: an architecture lesson with no flows, more than half the edges without a protocol, two consecutive steps with no edge between their nodes, a repeated or self-loop edge, an invariant rule over 120 characters. main() prints every warning, then every error, and exits 1 if there is any error ({BP}:{b_warnloop}-{b_exit}).',
  'analogy': 'A proofreader who marks errors in red and warnings in pencil.',
  'owns': 'The definition of a valid lesson.',
  'exposes': '`validate(L, repo)` returns `(errs, warns)`. On the command line: `warn:` and `ERROR:` lines, and exit code 1.',
  'runs': 'Inside the build.py process on your machine, once per build.',
  'scale': f'Linear in lesson size. The one hidden cost is the file re-read per snippet ({BP}:{b_read}).',
  'confidence': 'evidenced'},
 {'id': 'assembler', 'label': 'Assembler', 'kind': 'build.py: includes and injection', 'prop': 'package', 'layer': 'build', 'col': 1, 'row': 1,
  'files': [f'{BP}:{b_inc_def}-{b_inc_end}', f'{BP}:{b_render_def}-{b_sub}', f'{BP}:{b_page}-{b_write}'],
  'simple': 'Takes the chosen theme file and fills in three blanks: shared parts, the title and the lesson data. The result is one HTML file that opens on its own.',
  'deep': f'`apply_includes()` replaces every line that is exactly `<!-- lens:include NAME -->` with the file `assets/themes/parts/NAME`, verbatim, and exits with an ERROR if the part is missing or contains `__TITLE__` or `__LESSON_JSON__`. Then `render()` fills `__TITLE__` (HTML-escaped) and `__LESSON_JSON__` (the lesson on one line) in a single regex pass, so text inserted for one is never scanned for the other ({BP}:{b_render_def}-{b_sub}). On the way it rewrites every `</` to `<\\/` and the `<` of any `<!--` or `<script` to `\\u003c`; JSON.parse reads all three back as the original text. Includes run first, so nothing inside a lesson can ever expand one.',
  'analogy': 'A mail merge: the theme is the letter, the lesson is the address list.',
  'owns': 'The final page text.',
  'exposes': 'One self-contained .html file. By itself it fetches only Google Fonts; the ask helper is the one other thing it can call.',
  'runs': 'The same build.py process, after validation has passed.',
  'scale': f'Output size is theme plus lesson: zine.html is {kb(ZP)} KB and examples/jw-ask-flow.html is {kb("examples/jw-ask-flow.html")} KB. Every lesson repeats the theme.',
  'confidence': 'evidenced'},
 {'id': 'theme', 'label': 'Theme page', 'kind': 'single-file HTML renderer', 'prop': 'browser', 'layer': 'page', 'col': 2, 'row': 1,
  'files': [f'{ZP}:{z_script}-{z_boot}', f'{SKP}:{sk_ctx_def}-{sk_ctx_end}', 'reference/themes.md'],
  'simple': 'The page the reader sees. It reads the lesson data, draws the map, flows, quiz and notes, and handles keys and clicks. It works with no server at all.',
  'deep': f'A theme is one HTML file. build.py fills `__LESSON_JSON__` into `<script id="lesson" type="application/json">` and the page runs `JSON.parse` on it ({ZP}:{z_script}, {z_parse}). `L.mode === \'architecture\'` ({ZP}:{z_arch}) relabels the sections (traces become Flows, whatifs become Failure modes) and adds Interfaces, Invariants and Pressure points. Each node sits in the column of its layer unless it sets `col` or `row` ({ZP}:{z_grid}). Each edge is a single curve between the facing sides of two boxes, fanned apart when several edges join the same pair ({ZP}:{z_curve}); I found no routing around other boxes, so crossings are fixed by choosing rows. A second theme, `sketch` ({SKP}), renders the same JSON with the same script tag and `lens:<id>` keys, and splices in two parts: `parts/props.js`, the icon library (LensProps), then `parts/scenes.js`, Blot and his twelve scenes (LensScenes) ({SKP}:{sk_props_include}-{sk_include}). An authored `scene` is drawn with its `items` (labelled things that move) and `props` (labelled places). A node with no scene gets a context plate instead: ctxPlate() builds it from the graph, with the node\'s own `prop` in the middle, its neighbours on either side and each edge\'s `payload` on the arrows ({SKP}:{sk_ctx_def}-{sk_ctx_end}; the choice is made at {SKP}:{sk_pick}). zine.html never mentions `scene` or `prop`, so it ignores all of them.',
  'analogy': 'A reusable stage set: the lesson is the script, the theme decides the lighting and the props.',
  'owns': 'How a lesson looks and behaves.',
  'exposes': 'The contract in reference/themes.md: two placeholders, include lines, and the selectors `.node`, `[data-lens-stop]` and `.choice[data-p]` that scripts/smoke.mjs relies on. The sketch theme also reaches LensProps.draw, LensScenes.render and LensScenes.context in the parts.',
  'runs': "In the reader's browser. It works from a plain file and from the helper's http://127.0.0.1 address.",
  'scale': f'Client side only. The map is a grid of fixed-size boxes, so the build warns outside 2 to 14 nodes ({BP}:{b_nodes_warn}) and the schema recommends 4 to 10.',
  'confidence': 'evidenced'},
 {'id': 'store', 'label': 'Browser memory', 'kind': 'localStorage', 'prop': 'database', 'layer': 'page', 'col': 2, 'row': 2,
  'files': [f'{ZP}:{z_key}-{z_storeset}', f'{ZP}:{z_hash}'],
  'simple': 'The browser remembers where you stopped, which guesses you answered and how the quiz went, so coming back picks up where you left off.',
  'deep': f'Every key is `lens:<lesson id>:<name>` ({ZP}:{z_key}). Saved: Plain or Deep, current flow, last stop, light or dark, the model choice, answered guess gates and quiz answers. The gate and quiz keys also contain a hash of their own questions ({ZP}:{z_qkey}, {z_pkey}), so editing a question starts that part fresh instead of pinning old answers to new text. Reads and writes are wrapped in try/catch ({ZP}:{z_storeset}), so blocked storage simply means the page forgets. The ask key lives apart, under `lens:key`. Nothing in a key names the theme or the file, so zine and sketch share one set of progress, and in Chromium so do two different file:// pages with the same lesson id (tried: a stop saved in a zine build showed as Welcome back in a sketch build of the same id).',
  'analogy': 'A bookmark that also remembers your quiz marks.',
  'owns': "One reader's progress through one lesson.",
  'exposes': 'localStorage keys you can read in the dev tools. Nothing here leaves the browser.',
  'runs': "The reader's browser profile, one store per origin. In Chromium every file:// page counts as the same origin.",
  'scale': 'A handful of small JSON values per lesson. Browsers cap localStorage at a few MB per origin (typical figure, not checked here); a failed write is swallowed.',
  'confidence': 'evidenced'},
 {'id': 'helper', 'label': 'Ask helper (serve.py)', 'kind': 'localhost HTTP server', 'prop': 'server', 'layer': 'helper', 'col': 3, 'row': 0,
  'files': [f'{SP}:{s_doc_api}-{ln(SP, "-> NDJSON lines")}', f'{SP}:{s_same_def}-{s_done}'],
  'simple': 'A tiny local web server. It serves your lessons and is the one door through which the page can ask Claude. It checks who is knocking before it does anything.',
  'deep': f'A ThreadingHTTPServer on 127.0.0.1, from port 4174 upward ({SP}:{s_main_ports}), one thread per request. GET /__lens/health, GET / and GET /<name>.html need a same-origin Host. POST /__lens/ask also needs the `X-Lens-Key` header, a JSON content type, string fields, a model of haiku or sonnet and a UUID-shaped session id ({SP}:{s_post_def}-{s_session_re + 1}). It then starts `claude -p` and relays its events as NDJSON. The key is a random token kept in ~/.config/lens/token with mode 600 ({SP}:{s_token_def}-{s_mode}) and handed to the page in the link\'s #fragment, which browsers never send to a server.',
  'analogy': 'A doorman with a guest list: wrong address, no entry; right address but no key, no entry.',
  'owns': 'The key, the port and every claude process.',
  'exposes': 'GET /__lens/health, GET /<name>.html and POST /__lens/ask, all on 127.0.0.1 only.',
  'runs': 'A background Python process started by `serve.py LESSON.html`. One server per lessons folder; a second launch finds it and reuses it.',
  'scale': f'One thread and one claude process per question in flight. I found no cap on concurrent asks in serve.py. Each answer is cut off after 300 seconds ({SP}:{s_timeout}), set by LENS_ASK_TIMEOUT.',
  'confidence': 'evidenced'},
 {'id': 'claude', 'label': 'claude -p subprocess', 'kind': 'child process (Claude Code CLI)', 'prop': 'terminal', 'layer': 'helper', 'col': 3, 'row': 1,
  'files': [f'{SP}:{s_cmd_def}-{s_cmd_end}', f'{SP}:{s_popen}-{s_stdin}'],
  'simple': 'A fresh Claude Code run for every question, under your own login. It may only read: open files and search them. It cannot edit anything.',
  'deep': f'claude_cmd() builds `claude -p --model haiku|sonnet --tools Read,Grep,Glob --setting-sources "" --strict-mcp-config --settings {{autoMemoryEnabled:false, disableAllHooks:true}} --system-prompt TUTOR --output-format stream-json --verbose --include-partial-messages`, plus `--resume SESSION` for a follow-up ({SP}:{s_cmd_def}-{s_cmd_end}). The process starts in the explained repo (`cwd=repo`), in its own process group, with the prompt written to stdin and stream-json read from stdout ({SP}:{s_popen}-{s_stdin}).',
  'owns': 'The session id and the answer text.',
  'exposes': 'A prompt on stdin, one JSON event per line on stdout, an exit code, and `--resume` to continue a chat.',
  'runs': "A child of serve.py, in the explained repo's directory, under your own Claude Code login (no API key).",
  'scale': 'One process per question. Parallel questions mean parallel processes, limited by your machine and by your Claude usage limits (not measured here).',
  'confidence': 'evidenced'},
]

edges = [
 {'from': 'writer', 'to': 'validator', 'label': 'json', 'protocol': 'command line: LESSON.json OUT.html --check-src REPO', 'sync': True,
  'payload': 'lesson.json path',
  'guarantee': f'All or nothing: any error exits 1 before a page is written ({BP}:{b_exit}).'},
 {'from': 'source', 'to': 'validator', 'label': 'lines', 'protocol': 'file read', 'sync': True,
  'payload': 'snippet lines'},
 {'from': 'validator', 'to': 'assembler', 'label': 'valid', 'protocol': 'in-process call, reached only when there are no errors', 'sync': True,
  'payload': 'parsed lesson'},
 {'from': 'assembler', 'to': 'theme', 'label': 'page', 'protocol': 'file write: the theme with parts, title and lesson JSON filled in', 'sync': True,
  'payload': 'one .html page'},
 {'from': 'theme', 'to': 'store', 'label': 'progress', 'protocol': 'localStorage API', 'sync': True,
  'payload': 'lens:<id>:last',
  'guarantee': f'Best effort: a failed write is silently ignored ({ZP}:{z_storeset}).'},
 {'from': 'theme', 'to': 'helper', 'label': 'ask', 'protocol': 'HTTP POST; out: q, model, session, lesson, quote, where; back: text, tool, session, error, done', 'sync': False,
  'payload': 'POST /__lens/ask',
  'guarantee': f'A stream that ends without a done event is reported as cut off ({ZP}:{z_cut}).'},
 {'from': 'helper', 'to': 'claude', 'label': 'prompt', 'protocol': 'subprocess: where, quote and question on stdin; JSON event lines out', 'sync': True,
  'payload': 'prompt on stdin',
  'guarantee': f'Never outlives its request: SIGKILL to the whole process group on Stop, tab close or timeout ({SP}:{s_killpg}).'},
 {'from': 'writer', 'to': 'helper', 'label': 'start it', 'protocol': 'shell command in the background: serve.py LESSON.html --open', 'sync': False,
  'payload': 'serve.py LESSON'},
]

# ---------------------------------------------------------------- flows
flow_build = {
 'title': 'A lesson is built and opened',
 'trigger': 'You ask lens how something works. Claude has gathered its evidence and now writes the lesson, builds it and opens it.',
 'steps': [
  {'node': 'writer', 'title': 'Read the real lines',
   'simple': 'Claude reads the files it will show, with line numbers. It copies nothing from memory.',
   'deep': "SKILL.md step 2 says to read the actual code with `nl -ba FILE | sed -n 'A,Bp'` so the numbers are exact, and to run cheap, safe code when that gives real values for the state panel. Anything it only guessed gets `inferred` or `uncertain` as its confidence.",
   'confidence': 'evidenced', 'scene': SC('lookup', 'Claude reads exact line numbers, not memory', ['nl -ba FILE'], [P('folder', 'source files')])},
  {'node': 'writer', 'title': 'Write the lesson as data',
   'simple': 'Claude writes a small Python script that produces the JSON. A helper in it slices each snippet out of the real file, so code is right by construction.',
   'deep': "SKILL.md step 4 describes a generator in the scratchpad with a `code(file, a, b, highlight, notes)` helper; examples/jw-ask-flow.gen.py is the model, and so is the script that produced this lesson. Because snippets are sliced, never typed, only the line numbers can go wrong, and the next stage catches those for snippets. Line numbers written into prose or a node's `files` are not checked (see Weak spots), which is why the `ln()` helper in this lesson's generator looks each one up. Then Claude runs build.py.",
   'confidence': 'evidenced',
   'state': [{'name': 'lesson.json', 'value': f'mode "architecture", {len(nodes)} nodes, {len(edges)} edges, 3 flows', 'changed': True},
             {'name': 'snippets', 'value': 'sliced from real files by code()', 'changed': True}],
   'scene': SC('transform', 'gen.py slices snippets, writes lesson.json', ['code(file, a, b)', 'lesson.json'], [P('process', 'gen.py')])},
  {'node': 'validator', 'title': 'Check the shape',
   'simple': 'build.py reads the JSON and checks it. Missing text, unknown node ids and bad scene names are errors. Odd but legal things are warnings.',
   'deep': f'`validate()` runs every rule in one pass and collects `errs` and `warns` ({BP}:{b_val_def}-{b_val_end}). Nothing is thrown, even for a field of the wrong type, so one build reports every problem at once. Warnings never stop the build, which is why SKILL.md says to read them anyway.',
   'confidence': 'evidenced',
   'state': [{'name': 'errs', 'value': '[]', 'changed': True}, {'name': 'warns', 'value': '[]', 'changed': True}],
   'scene': SC('gate', 'errors stop the build, warnings pass', ['lesson.json', 'unknown node id'], [P('shield', 'validate()')])},
  {'node': 'validator', 'title': 'Compare each snippet with its file',
   'simple': 'With `--check-src`, build.py opens the real file and compares the snippet line by line. Any difference is an error.',
   'deep': f'The block only runs when a repo was given ({BP}:{b_repo_check}). It slices the real file at the snippet\'s start line and length, then compares line by line after trimming trailing spaces. A line that is only `...` is skipped, so a lesson can elide code. A file that is shorter than the snippet is a mismatch as well. The error names the first five wrong line numbers.',
   'confidence': 'evidenced',
   'code': code(BP, b_repo_check, b_cc_end, [b_read, b_norm, b_bad, b_cc_end],
                {b_norm: 'Trailing spaces are trimmed on both sides before comparing.',
                 b_bad: 'Lines that are only `...` are skipped, so a snippet may elide code.',
                 b_cc_end: 'Any difference, or a file that ends early, is a build error.'}),
   'predict': {'q': 'A snippet matches the real file except that one of its lines has extra spaces at the end. What does the build do?',
               'options': ['It passes, trailing spaces are ignored', 'It fails, lines must match exactly', 'It passes but prints a warning'],
               'answer': 0,
               'why': f'`norm = lambda s: s.rstrip()` ({BP}:{b_norm}) trims each line on both sides before the comparison, so only differences in the visible text count.'},
   'state': [{'name': 'mine', 'value': "c['src'] split into lines", 'changed': True},
             {'name': 'real', 'value': 'file lines[start-1 : start-1+n]', 'changed': True},
             {'name': 'bad', 'value': '[]  (an empty list means a match)', 'changed': True}],
   'scene': SC('watch', 'check_code diffs snippets vs the real file', ['snippet lines'], [P('file', 'scripts/build.py')])},
  {'node': 'assembler', 'title': 'Fill the template, then write the page',
   'simple': 'build.py first expands the include lines in the theme, then drops in the title and the lesson in one pass. The lesson is made safe first and nothing it inserts is read again, so lesson text cannot be mistaken for an instruction.',
   'deep': f'`render()` ({BP}:{b_render_def}) serialises the lesson on one line ({BP}:{b_data}), rewrites every `</` to `<\\/` and turns the `<` of any `<!--` or `<script` into `\\u003c` ({BP}:{b_script_esc}). Line {b_page} runs `apply_includes` on the theme text and hands the result to `render()`, which replaces `__TITLE__` and `__LESSON_JSON__` in one `re.sub` pass ({BP}:{b_sub}). Three things keep lesson text from posing as a directive: includes are expanded before the data is inserted, the data is one line so no lesson string is a whole line on its own, and the single pass never rescans inserted text, so a title containing `__LESSON_JSON__` stays literal. scripts/test-build.py pins each: cli_includes_before_placeholders, title_placeholder_cannot_inject_json and comment_open_is_escaped_and_roundtrips.',
   'confidence': 'evidenced',
   'code': code(BP, b_render_def, b_sub, [b_data, b_script_esc, b_sub],
                {b_data: 'Every `</` becomes `<\\/`, so no lesson text can end the data script early.',
                 b_script_esc: 'A `<` before `!--` or `script` becomes `\\u003c`, so the page cannot go blank.',
                 b_sub: 'One pass fills the title and the data; inserted text is never rescanned.'}),
   'predict': {'q': 'A step of a lesson quotes the include line `<!-- lens:include scenes.js -->` as text. What does the built page contain at that spot?',
               'options': ['That text, unchanged', 'The scenes.js file pasted in', 'No page: the build stops on it'],
               'answer': 0,
               'why': 'Includes are expanded in the theme before the lesson is inserted, and the insert is one pass whose output is never rescanned, so lesson text is never expanded.'},
   'state': [{'name': 'data', 'value': 'the lesson on one line, </ and <!-- escaped', 'changed': True},
             {'name': 'page', 'value': 'theme + parts + title + data', 'changed': True},
             {'name': 'out', 'value': 'one .html file, no other files', 'changed': True}],
   'scene': SC('carry', 'one re.sub pass fills in the lesson', ['lesson JSON'], [P('braces', 'lesson JSON'), P('browser', 'theme page')])},
  {'node': 'theme', 'title': 'Open the page and draw it',
   'simple': 'You open the file. The page reads the lesson from its own script tag, then draws the map, the flows and every other section that has something to show.',
   'deep': f'`JSON.parse` of the script tag gives `L` ({ZP}:{z_parse}). The boot line renders every section from it ({ZP}:{z_boot}); a section with no data hides itself and drops out of the contents rail. In architecture mode `ARCH` is true ({ZP}:{z_arch}), which changes the labels and adds the Interfaces, Invariants and Pressure sections. The sketch theme does the same, and also draws each node\'s context plate from the edges when you click it.',
   'confidence': 'evidenced',
   'state': [{'name': 'L', 'value': 'the parsed lesson object', 'changed': True}, {'name': 'ARCH', 'value': 'true', 'changed': True},
             {'name': 'S.depth', 'value': '"simple"  (the default)', 'changed': True}],
   'scene': SC('fork', 'L.mode relabels: traces become Flows', ['code', 'architecture'], [P('braces', 'lesson JSON')])},
  {'node': 'store', 'title': 'Pick up where you left off',
   'simple': "The page looks in the browser's memory for this lesson. If you stopped partway last time, it offers a Jump back in button.",
   'deep': f'Initial state is read from localStorage ({ZP}:{z_key}). Each stop you visit saves `last` ({ZP}:{z_last}), and the Welcome back banner appears only when the saved step is past the first ({ZP}:{z_resume}). A fresh browser or cleared storage gives the defaults. scripts/smoke.mjs clears storage on purpose so every run starts the same.',
   'confidence': 'evidenced',
   'state': [{'name': 'lens:lens-architecture:last', 'value': '{"trace":0,"step":3}', 'changed': True},
             {'name': 'resume banner', 'value': 'shown (step 3 > 0)', 'changed': True}],
   'scene': SC('lookup', 'the page offers Jump back in', ['lens:<id>:last'], [P('database', 'localStorage')])},
 ]}

flow_ask = {
 'title': 'A reader selects text and asks Claude',
 'trigger': 'serve.py is running. You open the link it printed, `http://127.0.0.1:4174/<lesson>.html#k=KEY`, select a sentence and press A.',
 'steps': [
  {'node': 'store', 'title': 'Keep the key, hide the key',
   'simple': 'The link carries a secret key after the `#`. The page saves it in browser memory and removes it from the address bar.',
   'deep': f'serve.py creates the key once and keeps it in a private file ({SP}:{s_token_def}-{s_mode}). The page reads `k=` from `location.hash`, saves it as `lens:key` and rewrites the address bar without it ({ZP}:{z_hash}). If storage throws, the key stays in memory for this load only ({ZP}:{z_nokey}).',
   'confidence': 'evidenced',
   'state': [{'name': 'lens:key', 'value': '"Qm3x...(32 chars)"', 'changed': True}, {'name': 'location.hash', 'value': '""', 'changed': True}],
   'scene': SC('store', 'the #fragment key moves to lens:key', ['k=KEY'], [P('database', 'lens:key')])},
  {'node': 'theme', 'title': 'Selection becomes a question',
   'simple': 'When you select text, the page records the words and where you were reading, like stop 3 or the Invariants section. Pressing A or the pop-up opens the panel.',
   'deep': f'`selInfo()` keeps the trimmed text (at least 2 characters, cut at 1,500; {ZP}:{z_sel}), but only from inside the main article. `whereOf()` turns the spot into words such as `stop 3` or `the "Invariants" section`. If the helper was not found (a plain file), the same gesture copies a ready-made question to the clipboard instead ({ZP}:{z_copy}).',
   'confidence': 'evidenced',
   'state': [{'name': 'quote', 'value': '"A watcher thread peeks at the connection"', 'changed': True},
             {'name': 'where', 'value': '"the Invariants section"', 'changed': True}],
   'scene': SC('carry', 'selected words plus where you were', ['quote + where'], [P('browser', 'article'), P('envelope', 'ask panel')])},
  {'node': 'theme', 'title': 'Send the question',
   'simple': 'The page sends the question to the helper and shows an empty answer that fills as text arrives. A tab can run one question at a time.',
   'deep': f'`send()` refuses to start while one is running ({ZP}:{z_busy}). It POSTs to the relative URL `/__lens/ask`, so only the helper that served the page can answer, with `Content-Type: application/json` and the `X-Lens-Key` header, and passes an AbortController signal so Stop can cancel it ({ZP}:{z_fetch}). The first question carries no session; a follow-up sends the saved one.',
   'confidence': 'evidenced',
   'state': [{'name': 'ASK.busy', 'value': 'AbortController', 'changed': True}, {'name': 'ASK.session', 'value': 'null (first question)'}],
   'scene': SC('handoff', 'send() posts with the key, then waits', ['POST /__lens/ask'], [P('browser', 'theme page'), P('server', 'serve.py')])},
  {'node': 'helper', 'title': 'Two gates: origin, then key',
   'simple': 'The helper first checks that the request really comes from its own page. Only then does it compare the key. After that it validates every field.',
   'deep': f'`_same_origin()` ({SP}:{s_same_def}-{s_same_ret}) requires the Host header and any Origin header to be 127.0.0.1 or localhost on this server\'s port. That blocks other sites and DNS rebinding. Next the key is compared in constant time ({SP}:{s_key}). The session id must look like a UUID ({SP}:{s_session_re}), so a crafted value can never be read by claude as a command line flag.',
   'confidence': 'evidenced',
   'code': code(SP, s_post_def, s_session_re + 1, [s_origin_gate, s_key, s_session_re],
                {s_origin_gate: 'Host and Origin must be this server\'s own address. This runs before the key is even looked at.',
                 s_key: 'Constant-time comparison of the X-Lens-Key header.',
                 s_session_re: 'Only a UUID-shaped session id is accepted.'}),
   'predict': {'q': 'A web page on another site posts to http://127.0.0.1:4174/__lens/ask with a correct copy of your key. What does the helper answer?',
               'options': ['403: the Origin is not this server', '200: a correct key is enough', '415: the body is not JSON'],
               'answer': 0,
               'why': f'The origin check runs first ({SP}:{s_origin_gate}). The browser attaches the other site\'s Origin, which is not in the allowed set, so the key is never compared. A leaked key alone is not enough from another site.'},
   'state': [{'name': 'Host', 'value': '"127.0.0.1:4174"'}, {'name': 'X-Lens-Key', 'value': 'equals the token file', 'changed': True},
             {'name': 'model', 'value': '"haiku"'}],
   'scene': SC('gate', 'Origin is checked first, then the key', ['X-Lens-Key', 'foreign Origin'], [P('server', 'serve.py')])},
  {'node': 'helper', 'title': 'Start claude, read-only',
   'simple': "The helper starts `claude -p` in the explained repo. The flags give it three read tools and switch off settings, hooks and memory. Your question goes in on stdin.",
   'deep': f'`claude_cmd()` lists the flags ({SP}:{s_cmd_def}-{s_cmd_end}). `build_prompt()` ({SP}:{s_buildprompt}) joins the where line, the selected quote in triple quotes and the question. Popen gets `cwd=repo`, stdout piped, stderr to a temp file and `start_new_session=True`, so the whole process tree shares one group ({SP}:{s_popen}).',
   'confidence': 'evidenced',
   'code': code(SP, s_cmd_def, s_cmd_end, [s_tools, s_settings, s_resume],
                {s_tools: 'Three read tools. No Bash, no Edit, no Write.',
                 s_settings: 'No hooks and no auto-memory, so answers come from the code.',
                 s_resume: 'A follow-up continues the same Claude session.'}),
   'state': [{'name': 'cmd', 'value': 'claude -p --model haiku --tools Read,Grep,Glob ...', 'changed': True},
             {'name': 'cwd', 'value': 'the explained repo', 'changed': True}],
   'scene': SC('handoff', 'Popen starts claude -p with three read tools', ['prompt on stdin'], [P('server', 'serve.py'), P('terminal', 'claude -p')])},
  {'node': 'claude', 'title': 'Claude reads the code and streams',
   'simple': 'Claude searches and reads the real files to answer, and its words arrive in small pieces. Each file it opens is reported so the panel can say Reading and the file name.',
   'deep': f'The system prompt (TUTOR, {SP}:{ln(SP, "TUTOR = ")}) tells it to answer first, read code instead of guessing, cite path:line, say plainly if the lesson is wrong, and never offer edits. That prompt is the soft layer. The hard layer is the tool list: with only Read, Grep and Glob, Claude has nothing to edit with, whatever it is asked. Partial messages are on, so text arrives as deltas.',
   'confidence': 'evidenced',
   'state': [{'name': 'tools', 'value': 'Read, Grep, Glob'}, {'name': 'output', 'value': 'stream-json, one event per line', 'changed': True}],
   'scene': SC('wait', 'claude reads files, then streams text', ['text deltas'], [P('terminal', 'claude -p')])},
  {'node': 'helper', 'title': 'Turn the stream into small events',
   'simple': "The helper converts Claude's detailed stream into five simple event types, one per line. The session id goes out last, once the turn is saved.",
   'deep': f'`events()` ({SP}:{s_events_def}) yields `text` for each text delta, `tool` for each tool_use block, and from the final `result` an `error` if it failed and the `session`. `emit()` writes one JSON line and flushes it. If claude exits non-zero without having reported an error, the helper adds one (the last stderr line, or the time-limit message), and every stream ends with `done`.',
   'confidence': 'evidenced',
   'predict': {'q': 'Why does the helper send the session id only after Claude has finished the turn, not at the start?',
               'options': ['So the page can show the id sooner', 'So resuming a stopped turn cannot fail', 'So the id is never stored on disk'],
               'answer': 1,
               'why': f'The comment at {SP}:{s_sess_yield} says it: only once the turn is saved. If you press Stop, no id was sent, so the next question does not try to `--resume` a turn that never finished.'},
   'state': [{'name': 'events, in order', 'value': 'text, tool, text, session, done', 'changed': True}],
   'scene': SC('transform', 'the stream shrinks to five event types', ['stream-json', 'NDJSON events'], [P('process', 'events()')])},
  {'node': 'theme', 'title': 'Draw the answer, keep the thread',
   'simple': 'The page reads the events line by line and draws the answer as it grows. It remembers the session id, so your next question continues the same chat.',
   'deep': f'The loop splits the response on newlines and handles each event ({ZP}:{z_session}). The whole answer text is re-rendered on every chunk ({ZP}:{z_inner}). A stream that ends without `done` shows "The answer was cut off" ({ZP}:{z_cut}). The session lives only in the page object `ASK.session`, not in localStorage, so reloading starts a fresh chat; the model choice, by contrast, is saved.',
   'confidence': 'evidenced',
   'state': [{'name': 'ASK.session', 'value': '"11111111-2222-3333-4444-555555555555"', 'changed': True},
             {'name': 'text', 'value': 'the whole answer so far', 'changed': True}],
   'scene': SC('watch', 'the answer re-renders on every chunk', ['text, tool, done'], [P('browser', 'answer panel')])},
 ]}

flow_stop = {
 'title': 'A reader presses Stop mid-answer',
 'trigger': 'Claude has been silent for 40 seconds, reading files, and you press Stop or close the tab.',
 'steps': [
  {'node': 'theme', 'title': 'Cancel the request',
   'simple': 'Stop cancels the request in the browser. The panel says Stopped. Closing the tab does the same thing.',
   'deep': f'The form handler calls `ASK.busy.abort()` while a question is running ({ZP}:{z_abort}). The fetch rejects with an AbortError, which is shown as Stopped ({ZP}:{z_stopped}). The browser closes its end of the connection.',
   'confidence': 'evidenced',
   'scene': SC('wall', 'abort() hangs up on the helper', ['abort()'], [P('server', 'serve.py')])},
  {'node': 'helper', 'title': 'Notice the hang-up',
   'simple': 'Claude is quiet, so the helper has nothing to write and would never find out. A watcher thread peeks at the connection twice a second instead.',
   'deep': f'`watch()` loops while claude lives ({SP}:{s_watch_def}). `select` waits at most half a second, then `recv(1, MSG_PEEK)` reads one byte without consuming it. An empty result means the client hung up, so it calls `stop()`. A test closes a socket while a fake claude sleeps and checks that claude and its child both die (scripts/test-serve.py, disconnect).',
   'confidence': 'evidenced',
   'code': code(SP, s_watch_def, s_watch_def + 10, [s_select, s_peek, s_stopcall],
                {s_select: 'Look at the connection every half second, even while claude says nothing.',
                 s_peek: 'Peek one byte without consuming it. Empty bytes means the browser hung up.',
                 s_stopcall: 'Kill claude and everything it started.'}),
   'scene': SC('watch', 'watch() peeks one byte twice a second', ['MSG_PEEK: b""'], [P('network', 'connection')])},
  {'node': 'helper', 'title': 'Kill the whole process tree',
   'simple': 'The helper kills Claude and everything Claude started, such as search tools. Claude was launched in its own process group, so one signal reaches all of them.',
   'deep': f'`stop()` sends SIGKILL to the process group ({SP}:{s_stop_def}, {s_killpg}). The same function serves the time-limit timer ({SP}:{s_timer}) and the broken-pipe handler. The `finally` block kills anything still alive and calls `proc.wait()` ({SP}:{s_final_wait}), which reaps it so no zombie entry is left behind.',
   'confidence': 'evidenced',
   'scene': SC('fire', 'killpg ends claude and every tool it started', ['child processes'], [P('terminal', 'claude -p')])},
  {'node': 'claude', 'title': 'Nothing is left running',
   'simple': 'Claude and its helpers are gone. The half answer is discarded. The session id was never sent, so the next question will not resume the stopped turn.',
   'deep': f'The `session` event is yielded only after claude\'s final `result` ({SP}:{s_sess_yield}), which never came, so `ASK.session` is whatever it was before this question. A follow-up after Stop therefore resumes the last completed turn, or starts fresh if there was none.',
   'confidence': 'evidenced',
   'state': [{'name': 'claude + its children', 'value': 'dead and reaped', 'changed': True},
             {'name': 'ASK.session', 'value': 'unchanged by this question'}],
   'scene': SC('handoff', 'proc.wait() reaps it; no session id sent', ['exit, reaped'], [P('terminal', 'claude -p'), P('server', 'serve.py')])},
 ]}

lesson = {
 'id': 'lens-architecture', 'mode': 'architecture',
 'title': 'How lens turns a question into a lesson page',
 'subtitle': 'An architecture deep dive: eight parts from a model\'s pen to a page that can phone Claude, and the rules that keep it honest',
 'layers': [{'id': 'author', 'name': 'Authoring'}, {'id': 'build', 'name': 'Build'}, {'id': 'page', 'name': 'Page'}, {'id': 'helper', 'name': 'Ask helper'}],
 'nodes': nodes, 'edges': edges, 'traces': [flow_build, flow_ask, flow_stop],

 'invariants': [
  {'rule': 'A snippet shown in a lesson equals the real file at the stated lines, trailing spaces aside.',
   'evidence': f'{BP}:{b_read}-{b_cc_end}, and only when --check-src is given',
   'node': 'validator',
   'breaks': 'The build exits with "snippet does not match FILE at lines [...]" and no page is written. Without --check-src nothing compares, and an invented snippet ships (see Weak spots).',
   'confidence': 'evidenced', 'scene': SC('lookup', 'snippet = real file, only with --check-src', ['snippet'], [P('file', 'scripts/build.py')])},
  {'rule': 'Lesson text can never act as a template directive.',
   'evidence': f'Includes are expanded in the theme before the lesson is inserted ({BP}:{b_page}); title and lesson fill in one pass ({BP}:{b_sub}); a part may not contain `__TITLE__` or `__LESSON_JSON__` ({BP}:{b_ph})',
   'node': 'assembler',
   'breaks': 'A lesson that quotes an include line would have a file pasted into it, or the build would stop on a missing part. scripts/test-build.py pins the order with cli_includes_before_placeholders and the one-pass fill with title_placeholder_cannot_inject_json.',
   'confidence': 'evidenced', 'scene': SC('wall', 'a quoted include line stays plain text', ['lens:include text'], [P('package', 'theme parts')])},
  {'rule': 'Lesson text cannot end or hide the data script: `</` becomes `<\\/`; `<!--` and `<script` lose their `<`.',
   'evidence': f'{BP}:{b_data}-{b_script_esc}',
   'node': 'assembler',
   'breaks': 'Unescaped, a step that mentions a closing script tag cuts the JSON off mid-string: the page throws and draws nothing. With only `</` escaped, a step holding `<!--` and later `<script` blanks the page with no error at all. I ran both in headless Chromium. scripts/test-build.py pins the second with comment_open_is_escaped_and_roundtrips.',
   'confidence': 'evidenced', 'scene': DRAW['escape']},
  {'rule': 'Only a page served from the helper\'s own address, holding the key, can ask a question.',
   'evidence': f'Host and Origin must be 127.0.0.1 or localhost on the server port ({SP}:{s_same_def}-{s_same_ret}), then X-Lens-Key must match ({SP}:{s_key})',
   'node': 'helper',
   'breaks': 'Any website open in your browser could post questions and make your machine run claude in your repo (a cross-site or DNS-rebinding attack). scripts/test-serve.py has one test per rejection.',
   'confidence': 'evidenced', 'scene': DRAW['own_host']},
  {'rule': 'claude runs with only Read, Grep and Glob, and without the explained repo\'s settings, hooks, MCP servers or memory.',
   'evidence': f'{SP}:{s_cmd_def}-{s_cmd_end}',
   'node': 'helper',
   'breaks': f'A repo you are reading may be untrusted: its own hooks could run code while you read a lesson, or a stray edit tool could change files. The comment at {SP}:{s_cmd_def + 2} gives the same reason.',
   'confidence': 'evidenced', 'scene': DRAW['read_only']},
 ],

 'pressure': [
  {'title': 'Every lesson carries its own copy of the theme', 'node': 'assembler',
   'limit': f'About {kb(ZP)} KB of theme per lesson (zine.html), {kb("examples/jw-ask-flow.html")} KB for the jw example. The sketch theme is {kb("assets/themes/sketch.html")} KB and splices in the icon library (parts/props.js, {kb(PJ)} KB) and the Blot library (parts/scenes.js, {kb("assets/themes/parts/scenes.js")} KB) on top, so its pages are larger still.',
   'signal': 'The .lens/ folder grows by roughly 100 KB per lesson.',
   'mitigation': 'Nothing is needed at dozens of lessons. Past that, a shared theme file would shrink pages but give up the one-file property.',
   'severity': 'low', 'confidence': 'inferred', 'scene': SC('store', 'every lesson file repeats the whole theme', [f'zine.html {kb(ZP)} KB'], [P('folder', '.lens/ folder')])},
  {'title': 'The map is a fixed grid of fixed-size boxes', 'node': 'theme',
   'limit': f'4 to 10 nodes read well; the build warns outside 2 to 14 ({BP}:{b_nodes_warn}). Edges are single curves between box sides, so the theme never routes around a box.',
   'signal': 'A build warning, or an edge visibly running through a box on the map.',
   'mitigation': 'Split into an overview lesson plus component lessons (SKILL.md principle 6), or set `col` and `row` by hand until the lines are clear.',
   'severity': 'medium', 'confidence': 'evidenced', 'scene': DRAW['grid']},
  {'title': 'One claude process per question, no global cap', 'node': 'helper',
   'limit': f'Each tab runs one question at a time ({ZP}:{z_busy}); serve.py itself has no cap (no semaphore or pool found), only the 300-second time limit ({SP}:{s_timeout}).',
   'signal': 'Several `claude -p` processes in `ps`, or Claude usage-limit messages arriving as red error lines in the panel.',
   'mitigation': 'Lower LENS_ASK_TIMEOUT. A small semaphore around the ask handler would cap concurrency; it is not built.',
   'severity': 'low', 'confidence': 'inferred', 'scene': DRAW['no_cap']},
 ],

 'whatifs': [
  {'title': 'Open the file without the helper',
   'change': 'You double-click the .html, or serve.py is not running.',
   'outcome': f'The page only looks for the helper over http, so asking stays off. The Ask buttons become Copy question and put a ready-made question on the clipboard to paste into Claude yourself ({ZP}:{z_copy}). The map, flows, quiz and progress all still work. Progress is stored per origin, so the file copy and the http://127.0.0.1 copy keep separate progress (tried in headless Chromium: a stop saved on the file page was absent at http://127.0.0.1).',
   'lesson': 'The helper is an optional layer. A lesson page has to be useful alone.',
   'node': 'helper', 'affects': ['theme', 'store'], 'confidence': 'evidenced', 'scene': DRAW['no_helper']},
  {'title': 'Claude goes quiet for five minutes',
   'change': 'claude hangs on a slow tool or a bad connection and prints nothing.',
   'outcome': f'The timer fires after 300 seconds ({SP}:{s_timer}), kills the process group, and the stream gets one error line, "No answer within the 300-second limit, so it was stopped.", then done. The panel shows it in red, the thread is freed, and the next question works. scripts/test-serve.py runs this with a 2-second limit.',
   'lesson': 'Every child process needs its own deadline, not just the request that started it.',
   'node': 'claude', 'affects': ['helper', 'theme'], 'confidence': 'evidenced', 'scene': DRAW['silent']},
  {'title': 'The browser blocks localStorage',
   'change': 'A private window, a cleared profile or a locked-down browser makes storage throw.',
   'outcome': f'Reads fall back to defaults and writes are swallowed ({ZP}:{z_storeset}), so the lesson works but forgets Plain or Deep, your stop and your quiz. The ask key is kept in memory for that one load ({ZP}:{z_nokey}), so asking works until you reload. After a reload the key is gone and the helper answers 403 with "Reopen the lesson from the link serve.py printed".',
   'lesson': 'Treat persistence as a bonus, never as a requirement for the page to work.',
   'node': 'store', 'affects': ['theme', 'helper'], 'confidence': 'evidenced', 'scene': DRAW['no_storage']},
  {'title': 'A lesson names an icon the library does not have',
   'change': 'A node says `"prop": "jetpack"`, or a scene lists a prop with that name, but props.js has no such icon.',
   'outcome': f'The build still succeeds: check_prop() prints `prop \'jetpack\' is not in the prop library; a generic box is drawn` ({BP}:{b_unknown}) and exits 0. In the sketch page the library falls back to a plain rounded box with a handle, and a node with the unknown prop gets that box in its context plate. The label is still drawn. I built a two-node lesson with `jetpack` to see the warning; zine ignores `prop`, so that theme shows nothing different.',
   'lesson': 'A soft fallback keeps the page up, but it only helps if someone reads the build warnings.',
   'node': 'validator', 'affects': ['theme'], 'confidence': 'evidenced', 'scene': DRAW['jetpack']},
 ],

 'decisions': [
  {'title': 'Lessons are data, not model-written HTML',
   'chosen': 'Claude writes a JSON file. Fixed theme files turn it into the page.',
   'simple': 'A page the model writes could look different every time and be broken in ways nobody checks. Data can be checked before anything is drawn.',
   'deep': f'SKILL.md says it outright: produce lesson data, the template does the rest. That one split is what lets build.py validate ({BP}:{b_val_def}), lets two themes render the same lesson, and let a lesson be rebuilt in a new theme without touching its content. The reasons here are my reading of the design, not stated in the repo.',
   'context': 'A model is strong on facts and prose and weak on hundreds of lines of interaction code. Readers want the same keys and behaviour in every lesson. The same lesson should work in more than one look and teach in more than one mode.',
   'consequences': 'Every new capability needs three edits: a schema field, validator rules and a renderer change in every theme. That is how modes, scenes, invariants and pressure points were just added. A lesson cannot do anything the schema lacks. In return: checks at build time, swappable themes and old lessons that keep working.',
   'alternatives': [
    {'name': 'The model writes the whole HTML page', 'tradeoff': 'Total freedom, but each page is large, unchecked and different, and a bug fix means regenerating every lesson.'},
    {'name': 'Markdown plus a static site generator', 'tradeoff': 'Easy to write and read, but there is no structure to validate and nothing to step through: no flows, state or guess gates.'}],
   'confidence': 'inferred', 'scene': DRAW['data_not_html']},
  {'title': 'Themes are single files; shared code is spliced in at build time',
   'chosen': f'One self-contained HTML file per theme. build.py replaces include lines with files from assets/themes/parts/ ({BP}:{b_inc_def}-{b_inc_end}).',
   'simple': 'Each theme is one file, so a lesson opens anywhere. When two themes need the same code, the build copies it in rather than the page loading it later.',
   'deep': 'reference/themes.md describes a theme as one self-contained file and parts as the way themes share code, for example parts/props.js and parts/scenes.js. The splice is plain text replacement, which is why a part may not contain the two placeholders. Why this way is my reading: the page must work from a plain file with no neighbours.',
   'context': 'Lessons should open from a file, be emailable and be publishable as one file. Two themes may want the same large mascot and icon libraries.',
   'consequences': f'Every built page repeats the shared code (pressure point 1). A part is spliced as raw text, so it is not checked as part of any theme. A theme grows large: zine.html alone is {len(lines(ZP))} lines.',
   'alternatives': [
    {'name': 'Load shared scripts at runtime', 'tradeoff': 'Pages stay small, but a lesson then needs its neighbours to open and cannot travel as one file.'},
    {'name': 'Copy the library into each theme', 'tradeoff': 'No build step needed, but the copies drift apart the first time one is fixed.'},
    {'name': 'Use a bundler', 'tradeoff': 'Real modules, but it adds a dependency and a toolchain to a skill that is two Python files and some HTML.'}],
   'confidence': 'inferred', 'scene': SC('handoff', 'build.py splices parts/ into the theme', ['scenes.js'], [P('package', 'parts/'), P('browser', 'sketch.html')])},
  {'title': "Ask through the user's own `claude -p`, not an API key",
   'chosen': 'serve.py starts the `claude` command for each question, under the reader\'s own login.',
   'simple': 'Asking about a lesson uses the account you already have. There is no key to paste and no billing to set up in this tool.',
   'deep': f'The docstring states it: questions run through your own Claude Code login, no API key, in the repo the lesson explains, with read-only tools ({SP}:{s_doc_login}-{s_doc_login + 2}). Follow-ups use `--resume` with the session id the stream reports.',
   'context': 'Answers should come from this repo\'s real code, which needs file-reading tools, and the tool should not hold secrets.',
   'consequences': f'The helper parses Claude Code\'s stream-json by hand ({SP}:{s_events_def}-{s_sess_yield + 1}), so a format change in the CLI can empty the answers (see Weak spots). Each question pays process start-up. Safety rests on getting the flags in {SP}:{s_cmd_def}-{s_cmd_end} right, and the tests run a fake claude (scripts/testdata/fake-claude.py), not the real one.',
   'alternatives': [
    {'name': 'Call the API with a stored key', 'tradeoff': 'Direct and fast, but it needs key storage, billing and your own tool loop to read files.'},
    {'name': 'Only copy a question to the clipboard', 'tradeoff': 'Zero risk and zero setup, but manual; it is what the page falls back to without the helper.'}],
   'confidence': 'evidenced', 'scene': DRAW['own_login']},
 ],

 'risks': [
  {'title': 'The snippet check is opt-in', 'where': f'{BP}:{b_nofile}-{b_repo_check}',
   'what': 'Run build.py without --check-src and a wrong or invented snippet builds fine. I tried it: a snippet reading `totally wrong` for scripts/build.py line 1 printed `ok:` and exited 0. The same lesson with --check-src failed with exit 1.',
   'fix': 'Print a warning when a lesson contains snippets but --check-src was not given, or default the repo to the current folder.',
   'severity': 'medium', 'confidence': 'evidenced', 'scene': DRAW['opt_in']},
  {'title': 'Line numbers outside a snippet are never checked', 'where': f'{BP}:{b_nodes_loop}-{b_fn_code}',
   'what': 'With --check-src, build.py compares `code` snippets and nothing else. A node\'s `files` ranges and every file:line written in prose are never read. I built this lesson with a node `files` of scripts/build.py:9000-9999, a missing file scripts/nope.py:1-2 and a prose citation of scripts/build.py:9999: it printed `ok:`, no warning, exit 0. A wrong snippet in the same lesson exited 1. SKILL.md principle 1 warns about this, but nothing enforces it.',
   'fix': 'Have --check-src confirm that each `files` entry names a real file and a range inside it, or at least print a warning that prose citations are unchecked. Until then, derive every number with ln(), as this lesson\'s generator does.',
   'severity': 'medium', 'confidence': 'evidenced', 'scene': SC('lookup', 'file ranges and prose line numbers unread', ['build.py:9999'], [P('file', 'node files')])},
  {'title': 'The helper reads Claude Code output by hand', 'where': f'{SP}:{s_events_def}-{s_sess_yield + 1}',
   'what': f'`events()` picks fields out of stream-json and skips lines it cannot parse. If a CLI update renames them, answers would arrive empty and the page would say only "No answer came back" ({ZP}:{ln(ZP, "No answer came back")}), not the cause. The tests use a fake claude that emits today\'s shape, so they cannot notice.',
   'fix': 'Log unrecognised event types to stderr, and run one live check against the real CLI after updating it.',
   'severity': 'medium', 'confidence': 'inferred', 'scene': DRAW['by_hand']},
  {'title': 'build.py learns the icon names by regex over props.js', 'where': f'{BP}:{b_props_in_def}-{b_props_in_end}',
   'what': f'`props_in()` reads `names: [...]` and `alias: {{...}}` from props.js as text, so no JS runs ({PJ}:{p_names}). I changed a scratch copy to `names: Object.keys(ICONS)`: `camera`, a real icon, drew a false unknown-prop warning. I also emptied `alias`: then `jetpack` built with no warning at all, because an empty set switches the check off. The comment in props.js asks editors to keep both as plain literals, and nothing tests that.',
   'fix': 'Have the build print a warning when the prop library parses to no names, or load the names through node instead of a regex.',
   'severity': 'low', 'confidence': 'evidenced', 'scene': SC('watch', 'unparsed names turn the prop warning off', ['names: [...]'], [P('braces', 'props.js')])},
 ],

 'quiz': [
  {'q': 'You rebuild a lesson without --check-src and one snippet was typed wrong. What happens?',
   'options': ['The build passes and ships the wrong snippet', 'The build fails with a snippet mismatch error', 'The build passes but warns about that snippet'],
   'answer': 0,
   'why': f'The comparison sits inside `if repo and c.get("file")` ({BP}:{b_repo_check}). With no repo, only the structure is checked, so the wrong snippet ships silently.'},
  {'q': 'Why is every `</` in the lesson JSON rewritten to `<\\/` before it goes into the page?',
   'options': ['So the file is smaller to download', 'So search engines skip the lesson text', 'So text cannot end the data script early'],
   'answer': 2,
   'why': f'The lesson sits inside a script element, which a browser ends at the first closing script tag. Rewriting `</` ({BP}:{b_data}) makes that impossible, and JSON.parse reads `<\\/` as `</` again.'},
  {'q': 'You fix a typo in one quiz question and rebuild with the same id. What do returning readers see?',
   'options': ['Everything is kept; answers match by position', 'Their quiz answers reset; the last stop is kept', 'The whole lesson restarts, including the stop'],
   'answer': 1,
   'why': f'The quiz key includes a hash of the quiz text ({ZP}:{z_qkey}), so changed text means a new key and empty answers. Last stop and Plain or Deep are keyed by lesson id only, so they survive.'},
  {'q': 'What actually stops the ask helper from letting Claude edit your files?',
   'options': ['The tutor prompt says Claude cannot change anything', 'The browser hides edit buttons in the panel', 'The tool list contains only Read, Grep and Glob'],
   'answer': 2,
   'why': f'The tool list on the command line ({SP}:{s_tools}) is the hard limit: no edit tool exists in that run. The prompt is only a second, soft layer.'},
  {'q': 'You close the tab while Claude is thinking and silent. What notices?',
   'options': ['The timer, five minutes later', 'A watcher thread peeking at the socket', 'The next write to the page fails'],
   'answer': 1,
   'why': f'Claude is silent, so there is no write to fail and the timer is far away. `watch()` ({SP}:{s_watch_def}) peeks at the connection twice a second and kills the process group when it sees the hang-up.'},
  {'q': 'You open the sketch page of an architecture lesson and click a node that has no `scene`. What is drawn at the top of its note?',
   'options': ['Nothing: only nodes with a scene get a picture', 'A context plate built from the node\'s edges and neighbours', 'The scene of the node it is connected to'],
   'answer': 1,
   'why': f'ctxPlate() runs when the node has no scene ({SKP}:{sk_pick}). It puts the node\'s own `prop` in the middle, up to two neighbours on each side, and each edge\'s `payload` on the arrows ({SKP}:{sk_ctx_def}-{sk_ctx_end}).'},
 ],

 'glossary': [
  {'term': 'NDJSON', 'def': 'Newline-delimited JSON: one complete JSON object per line, so a reader can act on each line as it arrives.'},
  {'term': 'stream-json', 'def': "Claude Code's output mode that prints one JSON event per line while the answer is being produced."},
  {'term': 'localStorage', 'def': 'Small key-value storage inside the browser, kept per origin, that survives closing the tab.'},
  {'term': 'origin', 'def': 'Scheme, host and port of a page, such as http://127.0.0.1:4174. Browsers keep each origin storage and permissions separate.'},
  {'term': 'DNS rebinding', 'def': "A trick where a hostile site's name is made to point at 127.0.0.1 so the browser lets its page talk to local servers. A Host check blocks it."},
  {'term': 'process group', 'def': 'A set of related processes that one signal can reach together. Killing the group also kills helpers that claude started.'},
  {'term': 'fragment', 'def': 'The part of a link after the #. Browsers keep it to themselves and never send it to the server.'},
 ],
}
json.dump(lesson, open(pathlib.Path(__file__).with_suffix('').with_suffix('.json'), 'w'), indent=1, ensure_ascii=False)
