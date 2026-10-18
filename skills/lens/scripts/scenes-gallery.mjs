// Check and gallery for the sketch-theme scene library (assets/themes/parts/scenes.js, with props.js when present).
// (1) contract checks: names in contract order, deterministic output, no Math.random, valid SVG with role/aria-label,
//     captions (long, short, empty, non-Latin) never leave the 640x360 viewBox, unknown names throw,
//     calls WITHOUT items/props are byte-identical to the pre-slot library (BASELINE hashes below),
//     slots (items/props) are deterministic, drawn, ellipsized and stay inside the viewBox with hostile labels,
//     LensScenes.context() plates are deterministic and stay inside the viewBox for any neighbour count.
//     legibility: no text is drawn under 20 units (11px on a 358px phone plate); labels up to the validated limits (18 characters for items and
//     props, 60 for a caption) are drawn whole, inside the picture, never on top of a drawing or another label (checked on the pixels).
// (2) LensScenes.draw (the bespoke-drawing DSL): 8 hand-written sample drawings, every op, deterministic, never throws on fuzz (junk ops, NaN,
//     huge arrays, __proto__, throwing getters, deep nesting), clamped into the frame, text >= 20 units, labels (<= 18) whole, escaped, arrows attach to
//     ids (also ones drawn later), 40 ops under 50 ms; and scripts/scene-preview.mjs is run on the samples (pixel overlap check) and on a broken
//     drawing (it must say what is wrong).
// (3) gallery: all 12 scenes plain and with Tasklight-flavoured slots, 4 context plates, the 8 drawings, light and dark, at 1440 and 390 px wide;
//     PNG paths printed for a human to look at.
// Usage: node scripts/scenes-gallery.mjs [outdir]
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { tmpdir } from 'os'; import { join, dirname } from 'path'; import { fileURLToPath } from 'url';
import { getChromium } from './pw.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const parts = join(here, '..', 'assets', 'themes', 'parts');
const src = readFileSync(join(parts, 'scenes.js'), 'utf8');
// props.js is card P's deliverable; until it exists a stub with the same contract stands in so the slots can be drawn.
const realProps = existsSync(join(parts, 'props.js'));
const propsSrc = realProps ? readFileSync(join(parts, 'props.js'), 'utf8') : `const LensProps = (() => {
  const names = ['camera', 'chip', 'database', 'file', 'terminal', 'monitor', 'gear', 'user', 'cloud', 'sensor'];
  return { names, alias: {}, resolve: n => names.includes(n) ? n : null, draw(p, name, cx, cy, size) {
    const w = size * .8, h = size * .66, k = names.indexOf(name);
    p.rbox(cx, cy, w, h, 0); p.oval(cx, cy, size * .16, size * .16, 'var(--blue,#2b6fd9)', 2.4);
    if (k < 0) p.curve([[cx - w * .2, cy - h / 2], [cx - w * .2, cy - h / 2 - size * .1], [cx + w * .2, cy - h / 2 - size * .1], [cx + w * .2, cy - h / 2]]);
    else p.line(cx - w * .3, cy + h * .3, cx + w * .3, cy + h * .3);
  } };
})();`;
const NAMES = ['carry', 'gate', 'queue', 'fork', 'wall', 'fire', 'store', 'lookup', 'transform', 'wait', 'handoff', 'watch'];
const CAPTIONS = {
  carry: 'request body travels to the API', gate: 'bad tokens get turned away', queue: 'jobs wait their turn',
  fork: 'router picks a branch', wall: 'sandbox blocks the write', fire: 'one crash takes the batch down',
  store: 'saved to SQLite', lookup: 'find the row by key', transform: 'JSON in, struct out',
  wait: 'retry after 30 s', handoff: 'worker takes over the job', watch: 'health check every minute'
};
const STRESS = ['', 'ok', 'a caption that is exactly sixty characters long, give or take',
  'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', 'Überprüfung der Signatur schlägt fehl, Anfrage wird verworfen',
  'データベースに保存してから応答を返します。再試行は三回まで行います。', 'supercalifragilisticexpialidociousandthensomemorewordsglued'];
// build.py allows captions of 60 characters: every scene must show all of one, whole, at >= 20 (no ellipsis).
const FLOOR = 20;
const CAP60 = 'the daemon keeps each frame in memory and drops it right off';
const CAPQ = 'This caption is deliberately sixty characters long, no more.';   // card QA's 60-character caption
if (CAP60.length !== 60 || CAPQ.length !== 60) throw new Error('CAP60 and CAPQ must be 60 characters');
// build.py allows 18 characters per item and prop label. How many of each a scene reads (contract A), and a fill that uses every slot at full length.
const USES = { carry: [1, 2], gate: [2, 1], queue: [4, 1], fork: [2, 1], wall: [1, 1], fire: [1, 1], store: [1, 1], lookup: [1, 1], transform: [2, 1], wait: [1, 1], handoff: [1, 2], watch: [1, 1] };
const IT18 = ['ItemLabelEighteen0', 'ItemLabelEighteen1', 'ItemLabelEighteen2', 'ItemLabelEighteen3'], PL18 = 'PropLabel18chars!!', PROPS3 = ['camera', 'chip', 'database'];
const CAPS18 = ['PHONE_IN_FRAMES_OK', 'SESSION_CLOSE_EVNT', 'APP_FOCUS_CHANGED_', 'MIC_IN_USE_FLAG_OK'];   // all-capitals identifiers are the widest 18 characters
const MAXFILL = (n, caption, items = IT18, label = PL18) => ({ caption, items: items.slice(0, USES[n][0]), props: PROPS3.slice(0, USES[n][1]).map(prop => ({ prop, label })) });
const NB18 = i => ({ label: 'NodeLabel18chars!!', prop: PROPS3[i % 3], payload: 'PayloadLabel18chr!' });
const FULL_PLATES = [
  { _k: 'full 2/2', title: 'TitleTitleTitle18c', prop: 'chip', owns: 'x', inputs: [NB18(0), NB18(1)], outputs: [NB18(1), NB18(2)] },
  { _k: 'full 1/1', title: 'TitleTitleTitle18c', prop: 'gear', owns: 'turns frames into presence and keeps nothing else around at all', inputs: [NB18(0)], outputs: [NB18(1)] },
  { _k: 'full 3/5', title: 'engine', prop: 'gear', inputs: [NB18(0), NB18(1), NB18(2)], outputs: [NB18(1), NB18(2), NB18(0), NB18(1), NB18(2)] },
  { _k: 'full 2/0', title: 'x', prop: 'gear', inputs: [NB18(0), NB18(1)], outputs: [] },
  { _k: 'full 0/2', title: 'x', prop: 'gear', inputs: [], outputs: [NB18(0), NB18(1)] }
];
// Tasklight flavoured slots: how many items / props each scene reads (contract A) and a realistic fill.
const SLOTTED = {
  carry: { caption: 'camera.py hands each frame to fusion', items: ['frame'], props: [{ prop: 'camera', label: 'camera.py' }, { prop: 'chip', label: 'fusion' }] },
  gate: { caption: 'only presence is kept', items: ['presence', 'raw frame'], props: [{ prop: 'database', label: 'events.db' }] },
  queue: { caption: 'sensor events wait for the engine', items: ['frame 41', 'mic event', 'idle tick', 'app class'], props: [{ prop: 'chip', label: 'engine' }] },
  fork: { caption: 'fusion decides who is looking', items: ['focused', 'elsewhere'], props: [{ prop: 'chip', label: 'fusion' }] },
  wall: { caption: 'frames never leave camera.py', items: ['frame'], props: [{ prop: 'cloud', label: 'network' }] },
  fire: { caption: 'a crash mid-write', items: ['open session'], props: [{ prop: 'database', label: 'events.db' }] },
  store: { caption: 'sessions are written once', items: ['session row'], props: [{ prop: 'database', label: 'events.db' }] },
  lookup: { caption: 'is this a call?', items: ['call_window'], props: [{ prop: 'file', label: 'rules.toml' }] },
  transform: { caption: 'frames in, presence out', items: ['frame', 'presence'], props: [{ prop: 'chip', label: 'fusion.py' }] },
  wait: { caption: 'the agent waits for you', items: ['approval'], props: [{ prop: 'user', label: 'you' }] },
  handoff: { caption: 'the task moves to the agent', items: ['task'], props: [{ prop: 'user', label: 'you' }, { prop: 'terminal', label: 'agent' }] },
  watch: { caption: 'mic sensor, one reading', items: ['0.3 s'], props: [{ prop: 'sensor', label: 'mic sensor' }] }
};
// Hostile slot fills: every label must stay inside the viewBox whatever it says.
const LONG = 'a_really_long_label_that_never_ends_and_keeps_going';
const SLOT_STRESS = [
  { items: [], props: [] },
  { items: ['x', 'y', 'z', 'w'], props: [{ prop: 'camera', label: 'a' }, { prop: 'chip', label: 'b' }, { prop: 'gear', label: 'c' }] },
  { items: [LONG, LONG, LONG, LONG], props: [{ prop: 'camera', label: LONG }, { prop: 'chip', label: LONG }, { prop: 'database', label: LONG }] },
  { items: ['データベースに保存', 'Überprüfung der Signatur', 'WWWWWWWWWWWWWWWWWW', '<b>&"quotes"</b>'], props: [{ prop: 'camera', label: '日本語のラベルです長い' }, { prop: 'no-such-prop', label: 'unknown prop' }, { prop: '', label: '' }] },
  { items: ['two words here', 'a b c d e f g h i j k', '', 'x'], props: [{ label: 'no prop name' }, null, { prop: 'cloud' }] }
];
const NEIGHBOURS = n => Array.from({ length: n }, (_, i) => ({ label: `neighbour_${i + 1}`, prop: ['camera', 'chip', 'database', 'gear', 'cloud', 'user'][i % 6], payload: `payload ${i + 1}` }));
const PLATES = {
  'a node with 2 in and 2 out': { title: 'fusion', prop: 'chip', owns: 'turns frames into presence', inputs: [{ label: 'camera.py', prop: 'camera', payload: 'frame' }, { label: 'desktop', prop: 'monitor', payload: 'app class' }], outputs: [{ label: 'engine', prop: 'gear', payload: 'presence' }, { label: 'events.db', prop: 'database', payload: 'raw sample' }], mood: 'happy' },
  'a lone node': { title: 'doctor', prop: 'terminal', owns: 'checks licences and sensors', inputs: [], outputs: [] },
  'one in, one out, a long owns line': { title: 'Engine', prop: 'gear', owns: 'Pending requests, the session state machine, mode state, and the ledger', inputs: [{ label: 'Daemon', prop: 'process', payload: 'cmd, args' }], outputs: [{ label: 'Fusion', prop: 'chip', payload: 'feed' }] },
  'a node with 5 neighbours': { title: 'engine', prop: 'gear', owns: 'one asyncio loop', inputs: NEIGHBOURS(3), outputs: NEIGHBOURS(5) },
  'a long owns line and 4 outputs': { title: 'Engine', prop: 'gear', owns: 'Pending requests, the session state machine, mode state, and the ledger', inputs: [{ label: 'Daemon', prop: 'process', payload: 'cmd, args' }, { label: 'Desktop and mic', prop: 'monitor', payload: 'on_app' }, { label: 'Camera', prop: 'camera', payload: 'camera events' }], outputs: [{ label: 'Fusion', prop: 'chip', payload: 'feed' }, { label: 'Event store', prop: 'database', payload: 'append' }, { label: 'camera', prop: 'camera' }, { label: 'notify', prop: 'bell' }] },
  'long labels': { title: LONG + '.py', prop: 'no-such-prop', owns: 'owns a very long sentence about everything it does for everyone', inputs: [{ label: LONG, payload: 'payload that is far too long to print', prop: 'camera' }, { label: 'データベース接続', payload: 'データ', prop: 'chip' }], outputs: [{ label: LONG, payload: LONG }] }
};
for (const [k, v] of Object.entries(PLATES)) v._k = k;
// Eight hand-written drawings (scene.draw), Tasklight flavoured and composed differently: a conveyor behind a wall, Blot juggling under a bell, a cut link,
// a queue falling off an edge, a locked cabinet, a split screen, a pipeline of stage pieces, a gate opened by a dial. Not the 12 scenes redone.
const DRAW_SAMPLES = [
  { caption: 'frames stay inside camera.py', draw: [
    { op: 'conveyor', x1: .6, x2: 7.4, y: 6.4 },
    { op: 'packet', x: 1.5, y: 5.7, label: 'frame 3' }, { op: 'packet', x: 3.7, y: 5.7, label: 'frame 2' }, { op: 'packet', x: 5.9, y: 5.7, label: 'frame 1', id: 'f1' },
    { op: 'prop', name: 'chip', x: 9.9, y: 5, size: 2.4, label: 'fusion', id: 'chip' },
    { op: 'arrow', from: 'f1', to: 'chip' },
    { op: 'wall', x: 12.3, y: 2.2, w: .9, h: 4.5 },
    { op: 'packet', x: 9.9, y: 1.5, label: 'presence', c: 'blue', id: 'pres' },
    { op: 'arrow', from: 'chip', to: 'pres', c: 'blue' },
    { op: 'text', x: 14.4, y: 3.4, t: 'raw frames never cross', c: 'red' },
    { op: 'ticks', x: 12, y: 3.2, n: 3, c: 'red', dir: 3.14 }
  ] },
  { caption: 'one person, three signals, an agent is waiting', draw: [
    { op: 'ground', y: 7.9, x1: 2, x2: 11 },
    { op: 'blot', x: 6.5, y: 6, mood: 'worried', look: [0, -.2], arms: [[5.2, 3.8], [7.8, 3.8]], id: 'me' },
    { op: 'packet', x: 3.7, y: 3.1, label: 'idle tick', tilt: -.2 }, { op: 'packet', x: 6.5, y: 1.6, label: 'mic event' }, { op: 'packet', x: 9.3, y: 3.1, label: 'app class', tilt: .2, id: 'app' },
    { op: 'prop', name: 'bell', x: 13.4, y: 3, size: 2.2, label: 'agent waiting', id: 'bell', },
    { op: 'ticks', x: 13.4, y: 1.7, n: 5, c: 'orange', len: .5 },
    { op: 'arrow', from: 'app', to: 'bell', c: 'orange', dash: true, bend: -.4 }
  ] },
  { caption: 'cut the link and nothing leaves the machine', draw: [
    { op: 'prop', name: 'phone', x: 2.6, y: 3.6, size: 2.2, label: 'phone', id: 'ph' },
    { op: 'prop', name: 'cloud', x: 13.4, y: 3.6, size: 2.4, label: 'cloud', id: 'cl' },
    { op: 'arrow', from: 'ph', to: 'cl', dash: true, c: 'red', label: 'frames' },
    { op: 'line', pts: [[7.4, 3.1], [8.6, 4.3]], c: 'red', w: 3 }, { op: 'line', pts: [[8.6, 3.1], [7.4, 4.3]], c: 'red', w: 3 },
    { op: 'blot', x: 8, y: 6.2, s: .9, mood: 'proud', arms: [[7.3, 4.4], [8.7, 4.4]] },
    { op: 'ground', y: 7.8, x1: 5, x2: 11 }
  ] },
  { caption: 'a queue that falls off the edge', draw: [
    { op: 'ground', y: 6.2, x1: .3, x2: 8.6 },
    { op: 'packet', x: 1.3, y: 5.5, label: 'job 4' }, { op: 'packet', x: 3.2, y: 5.5, label: 'job 3' }, { op: 'packet', x: 5.1, y: 5.5, label: 'job 2' }, { op: 'packet', x: 7, y: 5.5, label: 'job 1', id: 'j1' },
    { op: 'line', pts: [[8.6, 6.2], [8.9, 7], [8.5, 7.9], [8.8, 8.8]], w: 2 },
    { op: 'packet', x: 11, y: 7.4, label: 'job 0', tilt: .3, id: 'fall' },
    { op: 'ticks', x: 11, y: 6.2, n: 3, c: 'orange', dir: -1.57 },
    { op: 'arrow', from: 'j1', to: 'fall', c: 'red', bend: -.8 },
    { op: 'text', x: 13.6, y: 6.2, t: 'dropped', c: 'red', size: 'l', rot: -8 }
  ] },
  { caption: 'the database is locked', draw: [
    { op: 'cabinet', x: 10, y: 7.4, s: 1.1, label: 'events.db' },
    { op: 'prop', name: 'lock', x: 10, y: 5.8, size: 1.1, id: 'lk' },
    { op: 'blot', x: 4.2, y: 5.8, tilt: .3, look: [0, .25], legs: [[3.6, 7.6], [4.7, 7.6]] },
    { op: 'text', x: 5.9, y: 3.5, t: 'z z z', c: 'blue', size: 'l', rot: 12 },
    { op: 'prop', name: 'key', x: 14, y: 2.2, size: 1.6, label: 'key', id: 'key' },
    { op: 'arrow', from: 'key', to: 'lk', dash: true, label: 'opens', bend: .3 }
  ] },
  { caption: 'before and after the sensor fix', draw: [
    { op: 'line', pts: [[8, .3], [8, 8.7]], dash: true },
    { op: 'text', x: 4, y: .7, t: 'before', c: 'red', size: 'l' }, { op: 'text', x: 12, y: .7, t: 'after', c: 'blue', size: 'l' },
    { op: 'blot', x: 3.6, y: 5.2, mood: 'worried', s: .9, legs: [[3.1, 7.2], [4.1, 7.2]] },
    { op: 'box', x: 1.2, y: 1.4, w: 4.8, h: 1.2, label: 'raw frame' },
    { op: 'ticks', x: 6.2, y: 4.2, n: 3, c: 'red', dir: -.4 },
    { op: 'blot', x: 11.8, y: 5.2, mood: 'happy', s: .9, legs: [[11.3, 7.2], [12.3, 7.2]] },
    { op: 'box', x: 9.8, y: 1.4, w: 4.4, h: 1.2, label: 'presence', fill: 'ink' },
    { op: 'ground', y: 7.3, x1: 1, x2: 7.2 }, { op: 'ground', y: 7.3, x1: 8.8, x2: 15 }
  ] },
  { caption: 'events in, one session out', draw: [
    { op: 'stack', x: 2.4, y: 7, n: 5, label: 'events', id: 'ev' },
    { op: 'machine', x: 6.2, y: 3.2, w: 3.8, h: 3.3, label: 'engine', id: 'en' },
    { op: 'oval', x: 13.4, y: 6.2, rx: 1.6, ry: 1, label: 'session', c: 'blue', id: 'ss' },
    { op: 'arrow', from: 'ev', to: 'en', label: 'append' }, { op: 'arrow', from: 'en', to: 'ss', c: 'blue' },
    { op: 'clock', x: 13.4, y: 1.7, s: .7, label: 'timeout' },
    { op: 'ground', y: 7.4, x1: 1, x2: 15 }
  ] },
  { caption: 'a score opens the gate', draw: [
    { op: 'dial', x: 2.8, y: 3.2, s: 1.5, label: 'confidence', id: 'dl' },
    { op: 'gate', x: 9, y: 7.4, h: 3, len: 3.5, open: true, id: 'gt' },
    { op: 'arrow', from: 'dl', to: 'gt', dash: true, label: 'passes?', bend: .3 },
    { op: 'ground', y: 7.4, x1: 4, x2: 15.5 },
    { op: 'packet', x: 12.6, y: 6.6, label: 'session', c: 'blue', id: 'pk' },
    { op: 'magnifier', x: 13.3, y: 2.6, s: 1.1 },
    { op: 'text', x: 13.3, y: 4.6, t: 'check twice', c: 'orange' }
  ] }
];
const PLATE_STRESS = [{}, { title: '' }, { title: 't', inputs: NEIGHBOURS(2), outputs: [] }, { title: 'x', inputs: NEIGHBOURS(9), outputs: NEIGHBOURS(9), prop: 'camera' }, { title: '<b>&"</b>', inputs: [{ label: '<i>' }], outputs: [{}] }, ...Object.values(PLATES), ...FULL_PLATES];

// Hashes (sha256, first 24 hex) of the library's output BEFORE slots existed, for every scene x (caption, empty) x mood, plus blot().
// A call without items/props must still produce exactly these bytes.
const BASELINE = {
  // carry
  "carry|request body travels to the API|undefined": "e20491e5d705fbe143d47872",
  "carry|request body travels to the API|worried": "cbb9df247fd2067038e2e0bf",
  "carry|request body travels to the API|proud": "19748ab42d515105130ffd92",
  "carry|request body travels to the API|happy": "e3b4f404ffe5e522a18b8d5e",
  "carry||undefined": "0959f4b9ce52d55203543854",
  "carry||worried": "89d9db79d65c2375f955c7db",
  "carry||proud": "6ea1fa2d0cde290e0be8de60",
  "carry||happy": "e44c4a14e009cf065e6de4d9",
  // gate
  "gate|bad tokens get turned away|undefined": "80fc31c31e318070a74ab66b",
  "gate|bad tokens get turned away|worried": "98983f9c052c2bf254872004",
  "gate|bad tokens get turned away|proud": "80fc31c31e318070a74ab66b",
  "gate|bad tokens get turned away|happy": "f4fb0879d668e75d54bba211",
  "gate||undefined": "b2d6e5862610405215b4fae6",
  "gate||worried": "71d39af11fd0b13fbc363384",
  "gate||proud": "b2d6e5862610405215b4fae6",
  "gate||happy": "aa7d18088c3923af59b54a45",
  // queue (re-pinned in card F: the pile and the floor now stay inside the viewBox; every other scene is unchanged)
  "queue|jobs wait their turn|undefined": "388b7682080c95d7a7847cce",
  "queue|jobs wait their turn|worried": "c2f692ae2bbd1d70935e8b34",
  "queue|jobs wait their turn|proud": "aa66010ef65fd510819af000",
  "queue|jobs wait their turn|happy": "0084728f0a314f288404f750",
  "queue||undefined": "3d99aa4a364008d1abc95cf2",
  "queue||worried": "2187cbd8e6591ec9bfe9fd91",
  "queue||proud": "c57139947dd8c5f87b6c988c",
  "queue||happy": "7077ee27aa282a7c300a8a42",
  // fork
  "fork|router picks a branch|undefined": "d8708b103a809823d168f626",
  "fork|router picks a branch|worried": "d9e641884e949a51a042632c",
  "fork|router picks a branch|proud": "460058c1a9e129098dc1c1ee",
  "fork|router picks a branch|happy": "d3849ab037d8da30e291069c",
  "fork||undefined": "eb49af6259158f148c66044c",
  "fork||worried": "a2df43e44fad17411dd078c8",
  "fork||proud": "4db1bda7bd255cc619a3fca9",
  "fork||happy": "16a0af15db5b2c79496b2a23",
  // wall
  "wall|sandbox blocks the write|undefined": "13ca0c0c804001c107ded4fc",
  "wall|sandbox blocks the write|worried": "13ca0c0c804001c107ded4fc",
  "wall|sandbox blocks the write|proud": "40323d772d7359d35a9ccaec",
  "wall|sandbox blocks the write|happy": "2705973924ad5ed03b37f59b",
  "wall||undefined": "72dfe17c7cd0b83f73fa3723",
  "wall||worried": "72dfe17c7cd0b83f73fa3723",
  "wall||proud": "496e11e45a0a1e80fb72cbf1",
  "wall||happy": "1e88d0e1ca5413613e21ec3b",
  // fire
  "fire|one crash takes the batch down|undefined": "df8ad5713aab7bc3b333393e",
  "fire|one crash takes the batch down|worried": "df8ad5713aab7bc3b333393e",
  "fire|one crash takes the batch down|proud": "21687f19f2980d24fb441631",
  "fire|one crash takes the batch down|happy": "63c885bead65193da27d27eb",
  "fire||undefined": "ee6ce46570e9fccb2ddcefc2",
  "fire||worried": "ee6ce46570e9fccb2ddcefc2",
  "fire||proud": "907458705bf742a3dabe738f",
  "fire||happy": "5b0fdb810921432a4688a688",
  // store
  "store|saved to SQLite|undefined": "ccecd046b2bb356a20a21a6e",
  "store|saved to SQLite|worried": "9b19fb0f46ef49f5a3b0f477",
  "store|saved to SQLite|proud": "8d7f58bb65db4ddac2f336dd",
  "store|saved to SQLite|happy": "1d3eb0a4f2af936d1bca1c09",
  "store||undefined": "9d8ff1f18ac5344f640b96fc",
  "store||worried": "8944924e77b8cafee171ea3c",
  "store||proud": "ac5540188641020988d62043",
  "store||happy": "e8875d59017f55a1a12f018c",
  // lookup
  "lookup|find the row by key|undefined": "e89476c3723300e07b7dfd49",
  "lookup|find the row by key|worried": "961c4694a867a21d50bb881c",
  "lookup|find the row by key|proud": "b369c2f1e9e0ec0f8873ec49",
  "lookup|find the row by key|happy": "9fe11fb7ca4395ad33e7ff86",
  "lookup||undefined": "7d94af76ce8c9a690d4ebd32",
  "lookup||worried": "c22d71b139d0ebdb668cf67a",
  "lookup||proud": "4ea1f71cb12dc8172c76ca00",
  "lookup||happy": "adbc67bc0ffaf514558fdd9b",
  // transform
  "transform|JSON in, struct out|undefined": "df3e46fa11e6835df4c6ab00",
  "transform|JSON in, struct out|worried": "f36de7080a4d2186396f80a8",
  "transform|JSON in, struct out|proud": "df3e46fa11e6835df4c6ab00",
  "transform|JSON in, struct out|happy": "19f79acad3f477c915446d6e",
  "transform||undefined": "8da8e281fa9002abb8360a9b",
  "transform||worried": "dee4b2573bfd37f627894dbc",
  "transform||proud": "8da8e281fa9002abb8360a9b",
  "transform||happy": "e3ddd40a9975db008f2c0746",
  // wait
  "wait|retry after 30 s|undefined": "e9ef5ab81518280ee56be38f",
  "wait|retry after 30 s|worried": "d9b19be6fc6e6b8a78812e9b",
  "wait|retry after 30 s|proud": "a6da75b03006ecb070e3018d",
  "wait|retry after 30 s|happy": "060c4513172bc95d8d3e07a6",
  "wait||undefined": "fbe03362b6e8234557f1d78b",
  "wait||worried": "c85252cd3bf172ff4f940db2",
  "wait||proud": "19e320092e3576dab6399e10",
  "wait||happy": "1ad6926bfb9378f10eb1ef70",
  // handoff
  "handoff|worker takes over the job|undefined": "d6a965a77e485ebd44c6b5bc",
  "handoff|worker takes over the job|worried": "c9c14add07919c97420ff39a",
  "handoff|worker takes over the job|proud": "d6a965a77e485ebd44c6b5bc",
  "handoff|worker takes over the job|happy": "159bbb0c3dcf991bdf90d91b",
  "handoff||undefined": "fab08185088083adab5b13fb",
  "handoff||worried": "d668bb5fec2830db63100d6f",
  "handoff||proud": "fab08185088083adab5b13fb",
  "handoff||happy": "98bc578a9adfd182744c874e",
  // watch
  "watch|health check every minute|undefined": "0ef5ec6f0f4929ed945e54f9",
  "watch|health check every minute|worried": "5e031fcdb149eb3c65d8f7a2",
  "watch|health check every minute|proud": "af5d5ef83d80a1664d992544",
  "watch|health check every minute|happy": "c9ae77ef632f356c3c5a9916",
  "watch||undefined": "c81c8909d1f76b24a58564c9",
  "watch||worried": "781d6555ce3c4a2fa45638b3",
  "watch||proud": "95a27711c5d064cb45dbbfab",
  "watch||happy": "bbb421f99c69d76faf6aeb2f",
  // blot
  "blot|undefined": "ca53551f7005f4c7491cdafc",
  "blot|worried": "02638f3a2a87e1ba2dedab3a",
  "blot|proud": "2391403f2719fa4a77d186e4",
  "blot|happy": "221ea187e77d528d9098a3df",
};

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 24);

// ---- node-side checks ----
check(!/Math\.random/.test(src), 'scenes.js uses Math.random');
if (realProps) check(!/Math\.random/.test(propsSrc), 'props.js uses Math.random');
const LS = new Function(propsSrc + '\n' + src + '\n;return LensScenes;')();
const LS0 = new Function(src + '\n;return LensScenes;')();   // no LensProps at all: scenes.js must stand alone
check(JSON.stringify(LS.names) === JSON.stringify(NAMES), `names ${JSON.stringify(LS.names)} != contract order`);
check(!LS.names.includes('context'), 'context must not be an author-selectable scene name');
check(typeof LS._pen === 'function', 'LensScenes._pen is not exported');
for (const n of NAMES) for (const caption of [CAPTIONS[n], '']) for (const mood of [undefined, 'worried']) {
  check(LS.render(n, { caption, mood }) === LS.render(n, { caption, mood }), `${n} render is not deterministic`);
}
check(LS.blot({ mood: 'proud' }) === LS.blot({ mood: 'proud' }), 'blot() is not deterministic');
let threw = '';
try { LS.render('nope'); } catch (e) { threw = String(e.message); }
check(/nope/.test(threw) && NAMES.every(n => threw.includes(n)), `unknown name should throw naming valid ones, got: ${threw || 'no throw'}`);
check(/^<svg[^>]*width="200"/.test(LS.render('carry', { w: 200 })), 'opts.w does not set width');
{ const t0 = Date.now(); LS.render('carry', { items: ['x'.repeat(20000)], props: [{ prop: 'db', label: 'y'.repeat(20000) }] });
  check(Date.now() - t0 < 1500, `a 20000-char label took ${Date.now() - t0} ms (ellipsize must stay cheap)`); }
{ let ok = true; try { ok = typeof LS.context(null) === 'string'; } catch { ok = false; } check(ok, 'context(null) must not throw'); }
check(src.length < 90000, `scenes.js is ${src.length} bytes (budget 90 KB)`);

// byte-identical without slots (also with empty slot arrays, and with or without LensProps loaded)
let identical = 0;
for (const [key, want] of Object.entries(BASELINE)) {
  const [n, caption, mood] = key.split('|'), mo = (n === 'blot' ? caption : mood) === 'undefined' ? undefined : (n === 'blot' ? caption : mood);
  const draw = (L, o) => n === 'blot' ? L.blot({ mood: mo, ...o }) : L.render(n, { caption, mood: mo, ...o });
  for (const [what, got] of [['plain', draw(LS, {})], ['without LensProps', draw(LS0, {})], ['empty slots', draw(LS, { items: [], props: [] })], ['undefined slots', draw(LS, { items: undefined, props: undefined })]]) {
    if (hash(got) !== want) fails.push(`byte-identical: ${key} (${what}) differs from the pre-slot output`); else identical++;
  }
}

// slots: each scene reads its items/props, deterministically, and says so in aria-label
for (const n of NAMES) {
  const s = SLOTTED[n], o = { caption: s.caption, items: s.items, props: s.props }, a = LS.render(n, o), plain = LS.render(n, { caption: s.caption });
  check(a === LS.render(n, o), `${n} with slots is not deterministic`);
  check(a !== plain, `${n} ignores its slots`);
  for (const label of [...s.items, ...s.props.map(x => x.label)]) check(a.includes(`>${label}</text>`), `${n}: label "${label}" is not drawn verbatim`);
  for (const [i, it] of s.items.entries()) check(LS.render(n, { caption: s.caption, items: s.items.map((x, j) => j === i ? x + '!' : x) }) !== a, `${n}: items[${i}] is not used`);
  for (const [i] of s.props.entries()) check(LS.render(n, { caption: s.caption, props: s.props.map((x, j) => j === i ? { ...x, label: x.label + '!' } : x) }) !== a, `${n}: props[${i}] is not used`);
  check(LS0.render(n, o).startsWith('<svg') && LS0.render(n, o) !== plain, `${n}: slots without LensProps do not draw a fallback`);
  check(/aria-label="[^"]*\(/.test(a) && s.items.every(x => a.split('aria-label="')[1].split('"')[0].includes(x)), `${n}: aria-label does not list the items`);
  check(LS.render(n, { caption: s.caption, items: [LONG] }).includes('…'), `${n}: a 50-character item is not ellipsized`);
  check(!LS.render(n, { items: ['<b>&"x'], props: [{ prop: '<i>', label: '<u>' }] }).match(/<(b|i|u)>/), `${n}: labels are not escaped`);
}
for (const o of SLOT_STRESS) for (const n of NAMES) { let ok = true; try { ok = LS.render(n, { caption: 'c', ...o }).startsWith('<svg') && LS0.render(n, { caption: 'c', ...o }).startsWith('<svg'); } catch (e) { ok = false; fails.push(`${n}: slots threw ${e.message}`); } check(ok, `${n}: slot stress did not render`); }

// text size floor: every label in every picture is at least FLOOR (20) viewBox units, so it is >= 11px on a 358px phone plate (scale .56)
const sizesOf = svg => [...svg.matchAll(/<text[^>]*font-size:(\d+(?:\.\d+)?)px[^>]*>([^<]*)</g)].map(m => ({ size: +m[1], text: m[2] }));
const minFont = (what, svg) => { const small = sizesOf(svg).filter(t => t.size < FLOOR); check(!small.length, `${what}: text under ${FLOOR}px: ${small.map(t => t.size + 'px "' + t.text + '"').join(', ').slice(0, 120)}`); };
for (const n of NAMES) {
  minFont(`${n} (slotted)`, LS.render(n, SLOTTED[n])); minFont(`${n} (plain)`, LS.render(n, { caption: CAPTIONS[n] }));
  for (const o of SLOT_STRESS) minFont(`${n} (slot stress)`, LS.render(n, { caption: CAP60, ...o }));
  for (const cap of [CAP60, CAPQ]) {   // everything at full length: 60-character caption, 18-character labels, every slot the scene reads
    const full = LS.render(n, MAXFILL(n, cap)), said = sizesOf(full).map(x => x.text);
    minFont(`${n} (full)`, full); check(!said.some(x => x.includes('…')), `${n}: a full-length label or caption is cut: ${said.filter(x => x.includes('…')).join(' | ')}`);
    for (const it of IT18.slice(0, USES[n][0])) check(said.includes(it), `${n}: item "${it}" is not drawn whole (${said.join(' | ').slice(0, 160)})`);
    check(said.includes(PL18), `${n}: prop label "${PL18}" is not drawn whole`);
    check(cap.split(' ').every(w => said.join(' ').includes(w)), `${n}: the 60-character caption lost words`);
  }
  { const caps = sizesOf(LS.render(n, MAXFILL(n, CAPQ, CAPS18, CAPS18[0]))); minFont(`${n} (full, capitals)`, LS.render(n, MAXFILL(n, CAPQ, CAPS18, CAPS18[0])));
    check(!caps.some(x => x.text.includes('…')), `${n}: 18-character capitals labels are cut: ${caps.filter(x => x.text.includes('…')).map(x => x.text).join(' | ')}`); }
  // a 60-character caption fits whole: no ellipsis, every word still there
  const t = sizesOf(LS.render(n, { caption: CAP60 })), said = t.map(x => x.text).join(' ');
  check(said.includes(CAP60.split(' ')[0]) && !said.includes('…'), `${n}: a 60-character caption is cut: "${said}"`);
  check(CAP60.split(' ').every(w => said.includes(w)), `${n}: a 60-character caption lost words: "${said}"`);
}
// context plates
for (const a of PLATE_STRESS) {
  let s1 = '', s2 = '';
  try { s1 = LS.context(a); s2 = LS.context(a); LS0.context(a); } catch (e) { fails.push(`context threw ${e.message} for ${JSON.stringify(a).slice(0, 60)}`); }
  check(s1 === s2 && s1.startsWith('<svg'), 'context() is not deterministic');
}
try { check(LS.context().includes('viewBox="0 0 640 360"'), 'context() without arguments is not 640x360'); } catch (e) { fails.push('context() with no args threw'); }
check(LS.context(PLATES['a node with 5 neighbours']).includes('+1 more') && LS.context(PLATES['a node with 5 neighbours']).includes('+3 more'), 'context: extra neighbours do not collapse to "+N more"');
check(!LS.context(PLATES['a node with 2 in and 2 out']).includes('+'), 'context: 2 neighbours per side must not show "+N more"');
for (const a of PLATE_STRESS) minFont('context plate', LS.context(a));
// the owns line is readable when each side has at most one neighbour (>= 20, two lines, the whole sentence for ~70 characters) and is
// left out when a side has two or more (that band holds the payload labels; the node note repeats owns anyway)
{ const one = LS.context(PLATES['one in, one out, a long owns line']), own = sizesOf(one).filter(t => /Pending|mode state/.test(t.text));
  check(own.length === 2 && own.every(t => t.size >= FLOOR), `context: owns should be two lines of >= ${FLOOR}px, got ${JSON.stringify(own)}`);
  check(own.map(t => t.text).join(' ') === 'Pending requests, the session state machine, mode state, and the ledger', `context: owns text is cut: ${own.map(t => t.text).join(' ')}`);
  check(LS.context(PLATES['a lone node']).includes('>checks licences and sensors</text>'), 'context: a lone node lost its owns line');
  check(!LS.context(PLATES['a long owns line and 4 outputs']).includes('Pending requests'), 'context: owns is drawn over the payload labels of a crowded plate');
  check(!LS.context(PLATES['a node with 2 in and 2 out']).includes('turns frames into presence'), 'context: owns is drawn over the payload labels of a 2 in / 2 out plate');
  // "+N more" names who is hidden when the names fit whole, else gives the count alone
  const hub = LS.context(PLATES['a long owns line and 4 outputs']);
  check(hub.includes('>+1 more</text>') && hub.includes('>+2 more</text>'), 'context: +N more lines are missing');
  check(hub.includes('>Camera</text>'), 'context: "+1 more" does not say who is hidden (Camera)');
  check(hub.includes('>camera, notify</text>'), 'context: "+2 more" does not say who is hidden (camera, notify)');
  const big = LS.context(FULL_PLATES[2]); check(big.includes('>+1 more</text>') && !/NodeLabel[^<]*…/.test(big), 'context: a hidden name that does not fit is cut instead of left out'); }
const p2 = LS.context(PLATES['a node with 2 in and 2 out']);
for (const w of ['fusion', 'frame', 'app class', 'presence', 'raw sample', 'camera.py', 'desktop', 'engine', 'events.db']) check(p2.includes(`>${w}</text>`), `context: "${w}" is not drawn`);

// ---- draw: the bespoke-drawing DSL ----
const OPSRC = src.match(/drawOps: \[([^\]]*)\]/), OPLIST = OPSRC ? [...OPSRC[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]) : [];
const OPIMPL = [...src.matchAll(/^    ([a-z]+)\(o, c\) \{/gm)].map(m => m[1]);
check(OPLIST.length >= 20 && JSON.stringify([...OPLIST].sort()) === JSON.stringify([...OPIMPL].sort()), `drawOps literal ${OPLIST.join(',')} does not match the implemented ops ${OPIMPL.join(',')}`);
check(JSON.stringify(LS.drawOps) === JSON.stringify(OPLIST), 'LensScenes.drawOps differs from the literal build.py reads');
check(typeof LS.draw === 'function' && typeof LS0.draw === 'function', 'LensScenes.draw is missing');
const drawRep = spec => { const report = {}, svg = LS.draw(spec, { report }); return { svg, report }; };
const tagsOf = svg => [...new Set([...svg.matchAll(/<([a-z]+)[\s>]/g)].map(m => m[1]))].sort().join(','), tagsOk = svg => [...svg.matchAll(/<([a-z]+)[\s>]/g)].every(m => ['svg', 'path', 'text'].includes(m[1]));
const textsOf = svg => sizesOf(svg).map(t => t.text);
const MINIMAL = {   // one valid, simple use of every op
  blot: { op: 'blot', x: 3, y: 4 }, prop: { op: 'prop', name: 'camera', x: 8, y: 4, label: 'camera.py' }, box: { op: 'box', x: 2, y: 2, w: 3, h: 1.5, label: 'a box' },
  packet: { op: 'packet', x: 8, y: 4, label: 'frame' }, oval: { op: 'oval', x: 8, y: 4, rx: 1.5, ry: 1, label: 'oval' }, stack: { op: 'stack', x: 8, y: 6, n: 3, label: 'pile' },
  line: { op: 'line', pts: [[1, 1], [5, 3], [9, 2]] }, arrow: { op: 'arrow', from: [2, 2], to: [8, 5], label: 'goes' }, text: { op: 'text', x: 8, y: 4, t: 'a note' },
  ticks: { op: 'ticks', x: 8, y: 4 }, ground: { op: 'ground', y: 7 }, flame: { op: 'flame', x: 8, y: 6 }, wall: { op: 'wall', x: 8, y: 2 }, gate: { op: 'gate', x: 10, y: 7, open: true },
  conveyor: { op: 'conveyor', x1: 2, x2: 10, y: 6 }, magnifier: { op: 'magnifier', x: 8, y: 4 }, dial: { op: 'dial', x: 8, y: 4, label: 'dial' },
  cabinet: { op: 'cabinet', x: 8, y: 7, label: 'cabinet' }, machine: { op: 'machine', x: 6, y: 3, label: 'machine' }, clock: { op: 'clock', x: 8, y: 3, label: 'clock' }
};
for (const op of OPLIST) {
  const spec = { caption: 'one op', draw: [MINIMAL[op]] }, { svg, report } = drawRep(spec);
  check(MINIMAL[op] !== undefined, `no minimal example for op ${op}`);
  check(report.unknownOps.length === 0 && report.warnings.length === 0, `${op}: a plain use is reported as unknown/warned: ${JSON.stringify(report).slice(0, 120)}`);
  check((svg.match(/<(path|text)/g) || []).length > 0, `${op}: draws nothing`);
  check(svg === LS.draw(spec) && LS0.draw(spec).startsWith('<svg'), `${op}: not deterministic, or does not draw without LensProps`);
  minFont(`draw ${op}`, svg);
}
// samples: valid, deterministic, different from each other, nothing unknown, text floor, whole labels, aria-label
check(DRAW_SAMPLES.length === 8, 'there must be 8 draw samples');
const sampleSvgs = DRAW_SAMPLES.map(sp => drawRep(sp));
DRAW_SAMPLES.forEach((sp, i) => {
  const { svg, report } = sampleSvgs[i], ops = new Set(sp.draw.map(o => o.op));
  check(svg === LS.draw(sp) && svg === LS.draw(JSON.parse(JSON.stringify(sp))), `sample ${i + 1} is not deterministic`);
  check(/role="img"/.test(svg) && svg.includes('data-scene="draw"') && svg.includes('class="lens-scene"') && svg.includes('viewBox="0 0 640 360"'), `sample ${i + 1}: missing role/class/viewBox`);
  check(svg.split('aria-label="')[1].split('"')[0].includes(sp.caption), `sample ${i + 1}: aria-label lacks the caption`);
  for (const o of sp.draw) if (o.label) check(svg.split('aria-label="')[1].split('"')[0].includes(o.label), `sample ${i + 1}: aria-label lacks "${o.label}"`);
  check(report.unknownOps.length === 0 && report.warnings.length === 0, `sample ${i + 1}: ${JSON.stringify(report.unknownOps)} ${JSON.stringify(report.warnings)}`);
  check(ops.size >= 4, `sample ${i + 1} uses only ${ops.size} kinds of op`);
  check(tagsOf(svg) === 'path,svg,text', `sample ${i + 1}: unexpected tags ${tagsOf(svg)}`);
  minFont(`draw sample ${i + 1}`, svg);
  const said = textsOf(svg); check(!said.some(x => x.includes('…')), `sample ${i + 1}: a label is cut`);
  for (const o of sp.draw) for (const L of [o.label, o.t].filter(Boolean)) check(said.join('').replace(/\s/g, '').includes(L.replace(/\s/g, '')), `sample ${i + 1}: "${L}" is not drawn whole`);
  check(!svg.includes('NaN') && !svg.includes('undefined') && !svg.includes('Infinity'), `sample ${i + 1}: NaN/undefined in the SVG`);
});
check(new Set(sampleSvgs.map(x => hash(x.svg))).size === 8, 'two samples render identically');
check(new Set(DRAW_SAMPLES.map(sp => sp.draw.map(o => o.op).sort().join())).size >= 7, 'the samples share op mixes: they should be composed differently');
// a different caption or op changes the hand (seed = draw + caption)
check(LS.draw({ caption: 'a', draw: [MINIMAL.box] }) !== LS.draw({ caption: 'b', draw: [MINIMAL.box] }), 'the seed ignores the caption');
// unknown ops: skipped, named in the report, the rest still drawn; prototype names are not ops
{ const { svg, report } = drawRep({ caption: 'c', draw: [{ op: 'nope' }, { op: '__proto__' }, { op: 'constructor' }, { op: 'toString' }, { op: 5 }, {}, null, 'x', [], MINIMAL.box] });
  check(report.unknownOps.length === 6 && ['nope', '__proto__', 'constructor', 'toString'].every(x => report.unknownOps.includes(x)), `unknown ops not reported: ${JSON.stringify(report.unknownOps)}`);
  check(svg.includes('>a box</text>'), 'a valid op after unknown ones is not drawn'); }
// every label up to 18 characters is drawn whole at >= 20, whatever the op and whatever the letters
{ const LAB = ['ItemLabelEighteen0', 'PHONE_IN_FRAMES_OK', 'WWWWWWWWWWWWWWWWWW', 'two words here ok', 'a', 'データベースに保存してから', 'frame_buffer.pop()'];
  const withLabel = { box: { op: 'box', x: 1, y: 1, w: 1, h: .5 }, packet: { op: 'packet', x: 8, y: 4 }, oval: { op: 'oval', x: 8, y: 4, rx: .5, ry: .3 }, stack: { op: 'stack', x: 8, y: 6 }, prop: { op: 'prop', name: 'camera', x: 8, y: 8.6 }, dial: { op: 'dial', x: 8, y: 8.7 }, cabinet: { op: 'cabinet', x: 8, y: 8.9 }, machine: { op: 'machine', x: 6, y: 3 }, clock: { op: 'clock', x: 8, y: 6 } };
  for (const [op, base] of Object.entries(withLabel)) for (const L of LAB) {
    const svg = LS.draw({ caption: 'c', draw: [{ ...base, label: L }] }), said = textsOf(svg);
    minFont(`draw ${op} "${L}"`, svg); check(!said.some(x => x.includes('…')) && said.join('').replace(/\s/g, '').includes(L.replace(/\s/g, '')), `${op}: label "${L}" is cut or lost: ${said.join(' | ')}`);
  }
  for (const L of LAB) { const svg = LS.draw({ caption: 'c', draw: [{ op: 'arrow', from: [1, 4], to: [15, 5], label: L }] }), said = textsOf(svg); check(said.join('').includes(L) && !said.some(x => x.includes('…')), `arrow label "${L}" is cut`); minFont('draw arrow label', svg); }
  for (const t of ['a note of exactly forty characters, no more', 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', 'x']) for (const size of ['m', 'l']) for (const x of [0, 8, 16]) for (const anchor of ['start', 'middle', 'end']) {
    const svg = LS.draw({ draw: [{ op: 'text', x, y: 4, t: t.slice(0, 40), size, anchor }] }); minFont('draw text', svg); check(!textsOf(svg).some(z => z.includes('…')), `text "${t.slice(0, 10)}" is cut at x ${x} ${anchor}`); }
  // a label past the limit is cut to the limit (the validator warns), still >= 20 and escaped
  const longSvg = LS.draw({ draw: [{ op: 'box', x: 2, y: 2, label: 'x'.repeat(5000) }, { op: 'text', x: 8, y: 6, t: 'y'.repeat(5000) }] }); minFont('draw over-long labels', longSvg);
  check(textsOf(longSvg).every(z => z.length <= 40), 'an over-long label is not cut to its limit'); }
// escaping and tags: nothing but svg/path/text ever comes out
{ const svg = LS.draw({ caption: '<img src=x onerror=alert(1)>"&', draw: [{ op: 'box', x: 1, y: 1, label: '<img onerror=x>' }, { op: 'text', x: 8, y: 4, t: '</text><script>x</script>' }, { op: 'prop', name: '"><b>', x: 4, y: 4, label: '<i>&' }, { op: 'packet', x: 8, y: 6, label: '&amp;', id: '"><x' }] });
  check(!/<(img|script|b|i|x)[\s>]/.test(svg) && tagsOf(svg) === 'path,svg,text', `unescaped markup in the output: ${tagsOf(svg)}`);
  check(svg.includes('&lt;img') && svg.includes('&amp;amp;'), 'labels are not escaped'); }
// clamping: absurd coordinates never move anything out of the frame (checked on the pixels in the browser too)
const EXTREME = { caption: 'far out', draw: OPLIST.map(op => { const o = { ...MINIMAL[op] }; for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = k === 'n' ? 99 : -1e9 * (k.length % 2 ? -1 : 1); if (o.pts) o.pts = [[-50, 99], [1e6, -1e6], [NaN, 3]]; if (o.from) { o.from = [-9e9, 9e9]; o.to = [9e9, -9e9]; } return o; }) };
{ const { svg, report } = drawRep(EXTREME); check(svg.startsWith('<svg') && !svg.includes('NaN') && !svg.includes('Infinity'), 'extreme coordinates give NaN'); check(report.warnings.some(w => /clamped/.test(w)), 'clamping is not reported');
  const nums = [...svg.matchAll(/<path d="([^"]*)"/g)].flatMap(m => [...m[1].matchAll(/-?\d+(?:\.\d+)?/g)].map(x => +x[0])); check(Math.min(...nums) > -40 && Math.max(...nums) < 680, `a path coordinate is far outside the frame (${Math.min(...nums)}..${Math.max(...nums)})`); }
// ids and arrows: an arrow attaches to the edge of the thing (also one drawn after it), an unknown id is skipped, duplicates are warned
{ const A = { op: 'box', id: 'a', x: 2, y: 3, w: 3, h: 1.5 }, B = { op: 'box', id: 'b', x: 10, y: 3, w: 3, h: 1.5 };
  const edge = ops => { const { report } = drawRep({ draw: ops }), ar = report.objects.find(o => o.k === 'arrow'); return ar && { x0: ar.x, x1: ar.x + ar.w, y: ar.y + ar.h / 2 }; };
  const e1 = edge([A, B, { op: 'arrow', from: 'a', to: 'b' }]), e2 = edge([{ op: 'arrow', from: 'a', to: 'b' }, A, B]);
  check(e1 && Math.abs(e1.x0 - 5.1) < .3 && Math.abs(e1.x1 - 9.9) < .3 && Math.abs(e1.y - 3.75) < .3, `arrow does not attach to the right edge of a and left edge of b: ${JSON.stringify(e1)}`);
  check(e2 && JSON.stringify(e1) === JSON.stringify(e2) || (e2 && Math.abs(e2.x0 - e1.x0) < .05), 'an arrow drawn before its targets does not attach');
  const un = drawRep({ draw: [A, { op: 'arrow', from: 'a', to: 'ghost' }, { ...B, id: 'a' }] });
  check(un.report.warnings.some(w => /ghost/.test(w)) && un.report.warnings.some(w => /duplicate id "a"/.test(w)), `unknown/duplicate ids are not warned: ${JSON.stringify(un.report.warnings)}`);
  check(!un.report.objects.some(o => o.k === 'arrow'), 'an arrow to an unknown id is drawn'); 
  const bent = drawRep({ draw: [{ op: 'arrow', from: [1, 1], to: [10, 1], bend: .8 }, { op: 'arrow', from: [1, 5], to: [10, 5], bend: -.8 }] }).report.objects.filter(o => o.k === 'arrow');
  check(bent.length === 2 && bent[0].h > .4 && bent[1].h > .4, 'bend does not curve the arrow'); }
// 40 ops at most: the rest are ignored and said so
{ const ops = Array.from({ length: 60 }, (_, i) => ({ op: 'packet', x: 1 + i % 14, y: 1 + Math.floor(i / 14) * 2, label: 'p' + i })), { svg, report } = drawRep({ draw: ops });
  check(svg.includes('>p39</text>') && !svg.includes('>p40</text>') && report.warnings.some(w => /first 40/.test(w)), 'more than 40 ops are not cut at 40'); }
// the named scene is the fallback when the drawing draws nothing; nothing at all still gives a valid picture
check(LS.draw({ name: 'carry', caption: 'cap', draw: 'junk' }) === LS.render('carry', { caption: 'cap' }) && LS.draw({ name: 'wall', caption: 'cap', draw: [{ op: 'zzz' }], items: ['frame'] }) === LS.render('wall', { caption: 'cap', items: ['frame'] }), 'draw does not fall back to the named scene');
check(LS.draw({ name: 'nope', caption: 'only a caption' }).includes('>only a caption</text>') && LS.draw().startsWith('<svg') && /^<svg[^>]*width="200"/.test(LS.draw({ draw: [MINIMAL.box] }, { w: 200 })) && !/ width=/.test(LS.draw({ draw: [MINIMAL.box] }, { w: 'wide' }).slice(0, 200)), 'draw with no usable ops / opts.w misbehaves');
// FUZZ: junk in, an SVG out, never a throw (and the same SVG twice)
function mulberry(a) { return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const FIELDS = ['x', 'y', 'w', 'h', 's', 'size', 'rx', 'ry', 'n', 'len', 'dir', 'tilt', 'rot', 'bend', 'x1', 'x2', 'label', 't', 'c', 'fill', 'mood', 'look', 'face', 'arms', 'legs', 'pts', 'from', 'to', 'name', 'id', 'dash', 'open', 'anchor', 'op', 'caption', 'draw'];
function fuzz(r) {
  const pick = a => a[Math.floor(r() * a.length)];
  const junk = (d = 0) => pick([null, undefined, NaN, Infinity, -Infinity, 0, -0, 1, -1, 1e308, -1e308, 1e-320, 7.5, '', ' ', 'x', 'a'.repeat(300), '<b>&"\'', '__proto__', 'constructor', 'prototype', true, false, [], {}, [[]], [1], ['a', 'b'], [NaN, NaN], 'ink', 'red', 'blank', 3.99, -20, 9999, () => 1, Symbol.iterator, 10n ** 30n,
    ...(d < 3 ? [[junk(d + 1), junk(d + 1)], { x: junk(d + 1), y: junk(d + 1), op: junk(d + 1) }, [[junk(d + 1), junk(d + 1)], [junk(d + 1), 3]]] : [0])]);
  const names = [...OPLIST, 'zzz', '', '__proto__'];
  const op = () => { const o = { op: r() < .92 ? pick(names) : junk() }; for (let i = Math.floor(r() * 9); i > 0; i--) o[pick(FIELDS)] = junk(); return o; };
  return pick([() => ({ caption: junk(), draw: Array.from({ length: Math.floor(r() * 46) }, () => (r() < .9 ? op() : junk())) }), () => ({ caption: 'c', draw: Array.from({ length: 1 + Math.floor(r() * 6) }, op) }), junk, () => ({ draw: junk() }), () => ({ ...op(), draw: [op(), op()] })])();
}
{ const r = mulberry(20260607); let n = 0, bad = '';
  for (let i = 0; i < 1500; i++) { const spec = fuzz(r); n++; try { const a = LS.draw(spec, i % 3 ? undefined : { report: {} }), b = LS.draw(spec), c0 = LS0.draw(spec, { w: spec && spec.w }); if (typeof a !== 'string' || !a.startsWith('<svg') || a.includes('NaN') || a.includes('undefined') || a.includes('Infinity') || !tagsOk(a) || a !== b || !c0.startsWith('<svg')) bad = bad || `fuzz #${i}: bad output for ${String(JSON.stringify(spec, (k, v) => typeof v === 'bigint' ? 'big' : v)).slice(0, 100)}`; minFont(`fuzz #${i}`, a); } catch (e) { bad = bad || `fuzz #${i} threw ${e.message}`; } }
  check(!bad, bad || ''); }
const BROWSER_FUZZ = (() => { const r = mulberry(7), out = []; while (out.length < 80) { try { const js = JSON.stringify(fuzz(r)); if (js) out.push(js); } catch {} } return out; })();
// hostile inputs that JSON cannot carry
{ const boom = { get x() { throw new Error('boom'); }, op: 'blot' }, prox = new Proxy({}, { get() { throw new Error('proxy'); }, has() { throw new Error('proxy'); } });
  const cyc = { op: 'box' }; cyc.self = cyc; cyc.label = cyc;
  let deep = { op: 'box' }; for (let i = 0; i < 30000; i++) deep = { n: deep }; deep.op = 'box';
  const wide = { op: 'line', pts: Array.from({ length: 1e6 }, (_, i) => [i % 16, i % 9]) };
  const nul = Object.create(null); nul.op = 'box'; nul.label = 'null proto';
  const evil = JSON.parse('{"caption":"c","draw":[{"op":"box","__proto__":{"op":"blot"},"label":"proto"},{"op":"__proto__"},{"__proto__":{"op":"box"}}]}');
  for (const [what, spec] of [['throwing getter', { draw: [boom, MINIMAL.box] }], ['throwing proxy op', { draw: [prox, MINIMAL.box] }], ['proxy spec', prox], ['cyclic op', { draw: [cyc, MINIMAL.box] }], ['deep nesting', { draw: [deep, MINIMAL.box], caption: deep }],
    ['million points', { draw: [wide, MINIMAL.box] }], ['null prototype', { draw: [nul] }], ['__proto__ keys', evil], ['million ops', { draw: Array.from({ length: 1e6 }, () => MINIMAL.box) }], ['sparse array', { draw: new Array(2 ** 32 - 1) }], ['getter caption', { get caption() { throw new Error('c'); }, draw: [MINIMAL.box] }]]) {
    let out = ''; const t0 = Date.now(); try { out = LS.draw(spec); } catch (e) { fails.push(`draw threw on ${what}: ${e.message}`); } check(out.startsWith('<svg'), `draw gave no SVG for ${what}`); check(Date.now() - t0 < 1500, `draw took ${Date.now() - t0} ms on ${what}`); }
  check(LS.draw({ draw: [boom, MINIMAL.box] }).includes('>a box</text>'), 'an op that throws stops the ones after it'); }
// speed: 40 ops (two of every kind) under 50 ms, best of seven
{ const forty = Array.from({ length: 40 }, (_, i) => MINIMAL[OPLIST[i % OPLIST.length]]), times = []; for (let i = 0; i < 7; i++) { const t0 = process.hrtime.bigint(); LS.draw({ caption: 'speed', draw: forty }); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  check(Math.min(...times) < 50, `40 ops took ${Math.min(...times).toFixed(1)} ms (limit 50)`); globalThis.__drawMs = Math.min(...times).toFixed(1); }

// ---- browser checks + gallery ----
const pw = await getChromium();
if (!pw) { console.log('skip: Playwright not found (npm i -g playwright && npx playwright install chromium)'); if (fails.length) console.log(`FAIL (${fails.length}):\n  ` + fails.slice(0, 40).join('\n  ')); else console.log(`ok (node checks only): ${identical} byte-identical outputs`); process.exit(fails.length ? 1 : 0); }
const out = process.argv[2] || mkdtempSync(join(tmpdir(), 'lens-scenes-'));
mkdirSync(out, { recursive: true });
const FONT = '<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&display=swap" rel="stylesheet">';
const THEMES = {
  light: 'body{background:#fff;--ink:#111;--paper:#fff;--blot:#111;--blot-eye:#fff;--red:#d93a2b;--orange:#e8820c;--blue:#2b6fd9;color:#111}',
  dark: 'body{background:#0f0f10;--ink:#ececec;--paper:#0f0f10;--blot:#ececec;--blot-eye:#0f0f10;--red:#ff6b5b;--orange:#ffa63d;--blue:#6aa5ff;color:#ececec}'
};
const fig = (svg, cap) => `<figure>${svg}<figcaption>${cap}</figcaption></figure>`;
const page = (theme, only) => { const show = k => !only || only === k; return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${FONT}
<style>${THEMES[theme]}*{box-sizing:border-box}body{margin:0;padding:16px;font:14px system-ui,sans-serif}
h2{font:600 15px system-ui,sans-serif;margin:22px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:20px}
figure{margin:0}figure svg{display:block;width:100%;height:auto;border:1px dashed color-mix(in srgb,currentColor 18%,transparent)}
figcaption{opacity:.6;margin-top:4px}.blot{width:90px}</style></head><body>
${show('plain') ? `<h2>scenes, captions only</h2><div class="grid">${NAMES.map(n => fig(LS.render(n, { caption: CAPTIONS[n] }), n)).join('')}
<figure><div class="blot">${LS.blot({})}</div><div class="blot" style="display:inline-block">${LS.blot({ mood: 'worried' })}</div><div class="blot" style="display:inline-block">${LS.blot({ mood: 'proud' })}</div><div class="blot" style="display:inline-block">${LS.blot({ mood: 'happy' })}</div><figcaption>blot(): blank, worried, proud, happy</figcaption></figure></div>` : ''}
${show('slotted') ? `<h2>scenes with slots (items / props)${realProps ? '' : ' - STUB props'}</h2><div class="grid">${NAMES.map(n => fig(LS.render(n, SLOTTED[n]), n + ' (slotted)')).join('')}</div>` : ''}
${show('plates') ? `<h2>context plates</h2><div class="grid">${Object.entries(PLATES).map(([k, a]) => fig(LS.context(a), k)).join('')}</div>` : ''}
${show('draw') ? `<h2>drawings (scene.draw): eight hand-written compositions</h2><div class="grid">${DRAW_SAMPLES.map((sp, i) => fig(LS.draw(sp), `${i + 1}. ${sp.caption}`)).join('')}</div>` : ''}
<script>${propsSrc}</script><script>${src}</script></body></html>`; };
const files = {};
for (const t of Object.keys(THEMES)) { files[t] = join(out, `gallery-${t}.html`); writeFileSync(files[t], page(t)); }
// the two views a human is meant to look at: slotted scenes (light) and context plates (dark)
files['slotted-light'] = join(out, 'slotted-light.html'); writeFileSync(files['slotted-light'], page('light', 'slotted'));
files['plates-dark'] = join(out, 'plates-dark.html'); writeFileSync(files['plates-dark'], page('dark', 'plates'));
for (const t of ['light', 'dark']) { files[`draw-${t}`] = join(out, `draw-${t}.html`); writeFileSync(files[`draw-${t}`], page(t, 'draw')); }

const b = await pw.launch();
const errs = [];
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', e => errs.push(e.message));
await p.goto('file://' + files.light);
await p.evaluate(() => document.fonts.ready);
const res = await p.evaluate(async ({ NAMES, STRESS, SLOT_STRESS, SLOTTED, PLATE_STRESS, CAP60, FULL, FLOOR, DRAW }) => {
  const bad = [];
  const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:0;top:0;width:640px'; document.body.append(host);
  const inspect = (what, svgText, wantName, caption, allShapes) => {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    if (doc.querySelector('parsererror')) { bad.push(`${what}: SVG does not parse`); return; }
    const root = doc.documentElement;
    if (root.getAttribute('role') !== 'img') bad.push(`${what}: role is not img`);
    if (!(root.getAttribute('aria-label') || '').includes(wantName)) bad.push(`${what}: aria-label lacks "${wantName}"`);
    if (caption && !(root.getAttribute('aria-label') || '').includes(caption)) bad.push(`${what}: aria-label lacks the caption`);
    host.innerHTML = svgText;
    const svg = host.firstElementChild; svg.setAttribute('width', 640); svg.setAttribute('height', 360);
    const box = svg.getBoundingClientRect();
    for (const t of svg.querySelectorAll('text')) {
      const bb = t.getBBox(), r = t.getBoundingClientRect();
      if (bb.width > 640 || r.left < box.left - 0.5 || r.right > box.left + 640.5 || r.top < box.top - 0.5 || r.bottom > box.top + 360.5)
        bad.push(`${what}: text "${t.textContent}" leaves the viewBox (x ${Math.round(r.left - box.left)}..${Math.round(r.right - box.left)}, y ${Math.round(r.top - box.top)}..${Math.round(r.bottom - box.top)})`);
    }
    if (allShapes) for (const e of svg.querySelectorAll('path')) {
      const r = e.getBoundingClientRect();
      if (r.width && (r.left < box.left - 6 || r.right > box.left + 646 || r.top < box.top - 6 || r.bottom > box.top + 366)) { bad.push(`${what}: a shape leaves the viewBox (x ${Math.round(r.left - box.left)}..${Math.round(r.right - box.left)}, y ${Math.round(r.top - box.top)}..${Math.round(r.bottom - box.top)})`); break; }
    }
    return svg;
  };
  for (const n of NAMES) for (const caption of STRESS) {
    const svg = inspect(`${n} (caption ${JSON.stringify(caption).slice(0, 30)})`, LensScenes.render(n, { caption }), n, caption);
    if (caption && svg && !svg.querySelector('text')) bad.push(`${n}: caption ${JSON.stringify(caption)} not drawn`);
  }
  SLOT_STRESS.forEach((o, i) => { for (const n of NAMES) inspect(`${n} (slot stress #${i})`, LensScenes.render(n, { caption: 'a caption that is exactly sixty characters long, give or take', ...o }), n); });
  for (const n of NAMES) inspect(`${n} (Tasklight slots)`, LensScenes.render(n, SLOTTED[n]), n, SLOTTED[n].caption);
  // the queue pile keeps a margin to the viewBox edge, plain, with the Tasklight slots and with hostile slots
  for (const [what, o] of [['plain', { caption: 'jobs wait their turn' }], ['Tasklight slots', SLOTTED.queue], ...SLOT_STRESS.map((x, i) => ['slot stress #' + i, { caption: 'c', ...x }])]) {
    host.innerHTML = LensScenes.render('queue', o); const svg = host.firstElementChild; svg.setAttribute('width', 640); svg.setAttribute('height', 360); const box = svg.getBoundingClientRect();
    for (const e of svg.querySelectorAll('path')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > box.left + 632 || r.left < box.left + 8)) { bad.push(`queue (${what}): the pile reaches x ${Math.round(r.left - box.left)}..${Math.round(r.right - box.left)}, closer than 8px to the edge`); break; } }
  }
  // on a realistic plate no two labels overlap (the owns lines used to sit on the upper payload label)
  for (const k of ['a node with 2 in and 2 out', 'a node with 5 neighbours', 'a long owns line and 4 outputs']) {
    host.innerHTML = LensScenes.context(PLATE_STRESS.find(a => a._k === k)); const ts = [...host.firstElementChild.querySelectorAll('text')].map(t => { const r = t.getBoundingClientRect(), k = r.height * .22; return [t.textContent, { left: r.left, right: r.right, top: r.top + k, bottom: r.bottom - k }]; }); // a text box is about 1.2em tall; shave the line gap so only touching glyphs count
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) { const [, a] = ts[i], [, b] = ts[j]; if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) bad.push(`plate "${k}": "${ts[i][0]}" overlaps "${ts[j][0]}"`); }
  }
  for (const n of NAMES) inspect(`${n} (60-character caption)`, LensScenes.render(n, { caption: CAP60 }), n, CAP60);
  // legibility on the pixels: draw the picture WITHOUT its text; no text may sit on ink (a drawing, a wire, a box edge) or on other text,
  // and with full-length labels nothing is cut. Rotated text (inside a tilted parcel) is exempt from the ink test: its box is the parcel's.
  const raster = async svg => { const c = svg.cloneNode(true); c.querySelectorAll('text').forEach(t => t.remove()); c.setAttribute('width', 640); c.setAttribute('height', 360);
    let str = new XMLSerializer().serializeToString(c); for (let k = 0; k < 4; k++) str = str.replace(/var\(--[a-z-]+,([^()]*)\)/g, (m, d) => d);
    const img = new Image(); await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str); });
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360; const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 640, 360); x.drawImage(img, 0, 0, 640, 360); return x.getImageData(0, 0, 640, 360).data; };
  const legible = async (what, svgText, whole) => {
    host.innerHTML = svgText; const svg = host.firstElementChild; svg.setAttribute('width', 640); svg.setAttribute('height', 360); const box = svg.getBoundingClientRect(), d = await raster(svg);
    const ts = [...svg.querySelectorAll('text')].map(t => { const r = t.getBoundingClientRect(), fs = parseFloat(getComputedStyle(t).fontSize); return { rot: t.hasAttribute('transform'), t: t.textContent, fs, l: r.left - box.left, r: r.right - box.left, top: r.top - box.top + fs * .2, b: r.bottom - box.top - fs * .15 }; });
    for (const t of ts) {
      if (t.fs < FLOOR - 1e-6) bad.push(`${what}: "${t.t}" is ${t.fs}px`);
      if (whole && t.t.includes('…')) bad.push(`${what}: "${t.t}" is cut`);
      if (t.rot) continue;
      let ink = 0, tot = 0; for (let y = Math.max(0, Math.floor(t.top)); y < Math.min(360, Math.ceil(t.b)); y++) for (let x = Math.max(0, Math.floor(t.l + 2)); x < Math.min(640, Math.ceil(t.r - 2)); x++) { tot++; if (d[(y * 640 + x) * 4] < 150) ink++; }
      if (tot && ink / tot > .012) bad.push(`${what}: "${t.t}" sits on a drawing (${(100 * ink / tot).toFixed(1)}% ink, x ${Math.round(t.l)}..${Math.round(t.r)}, y ${Math.round(t.top)}..${Math.round(t.b)})`);
    }
    for (let i = 0; i < ts.length; i++) for (let k = i + 1; k < ts.length; k++) { const a = ts[i], c = ts[k]; if (a.l < c.r - 1 && c.l < a.r - 1 && a.top < c.b - 1 && c.top < a.b - 1) bad.push(`${what}: "${a.t}" overlaps "${c.t}"`); }
  };
  for (const [n, o] of FULL) await legible(`${n} (full-length labels, caption "${o.caption.slice(0, 10)}")`, LensScenes.render(n, o), true);
  for (const n of NAMES) await legible(`${n} (Tasklight slots)`, LensScenes.render(n, SLOTTED[n]), true);
  for (const a of PLATE_STRESS.filter(a => a._k && !/long labels/.test(a._k))) await legible(`context plate "${a._k}"`, LensScenes.context(a), /^(full|a lone|one in|a node with 2)/.test(a._k));   // a crowded plate may end its "+N more" names with …
  PLATE_STRESS.forEach((a, i) => inspect(`context plate #${i} (${a.title ? String(a.title).slice(0, 12) : 'untitled'})`, LensScenes.context(a), 'context', '', true));
  // drawings: every shape and text inside the frame (also with absurd coordinates and junk), valid SVG, same size text as the node-side check says
  DRAW.samples.forEach((sp, i) => inspect(`draw sample ${i + 1}`, LensScenes.draw(sp), '', sp.caption, true));
  inspect('draw extreme coordinates', LensScenes.draw(DRAW.extreme), '', '', true);
  DRAW.fuzz.forEach((js, i) => inspect(`draw fuzz #${i}`, LensScenes.draw(JSON.parse(js)), '', '', true));
  host.remove();
  return { bad, font: getComputedStyle(document.querySelector('svg text') || document.body).fontFamily, caveat: document.fonts.check('20px Caveat') };
}, { NAMES, STRESS, SLOT_STRESS, SLOTTED, PLATE_STRESS, CAP60, FLOOR, DRAW: { samples: DRAW_SAMPLES, extreme: EXTREME, fuzz: BROWSER_FUZZ }, FULL: NAMES.flatMap(n => [[n, MAXFILL(n, CAPQ)], [n, MAXFILL(n, CAP60)], [n, MAXFILL(n, CAPQ, CAPS18, CAPS18[0])]]) });
res.bad.forEach(m => fails.push(m));

const shots = [];
for (const [t, file] of Object.entries(files)) for (const width of (t.includes('-') ? [1000] : [1440, 390])) {
  const pg = await b.newPage({ viewport: { width, height: 900 } });
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('file://' + file); await pg.evaluate(() => document.fonts.ready); await pg.waitForTimeout(200);
  const sw = await pg.evaluate(() => document.documentElement.scrollWidth);
  check(sw <= width, `${t} gallery scrolls horizontally at ${width}px (${sw}px)`);
  const shot = join(out, `gallery-${t}-${width}.png`);
  await pg.screenshot({ path: shot, fullPage: true }); shots.push(shot);
  await pg.close();
}
await b.close();
// scripts/scene-preview.mjs: the samples must come out ok (pixel overlap check, text size), a deliberately broken drawing must be called out
const previewDir = join(out, 'preview'); mkdirSync(previewDir, { recursive: true });
const runPreview = (spec, name, ...flags) => { const f = join(previewDir, name + '.json'); writeFileSync(f, JSON.stringify(spec)); const r = spawnSync('node', [join(here, 'scene-preview.mjs'), f, join(previewDir, name + '.png'), ...flags], { encoding: 'utf8', timeout: 90000 }); let j = null; try { j = JSON.parse(r.stdout); } catch {} return { status: r.status, j, err: r.stderr }; };
let prevNote = '';
for (const flags of [[], ['--dark']]) {
  const r = runPreview({ scenes: DRAW_SAMPLES }, 'samples' + flags.join(''), ...flags);
  if (!r.j) { fails.push(`scene-preview on the samples gave no JSON (${flags}): ${r.err.slice(0, 200)}`); continue; }
  check(r.status === 0 && r.j.scenes.length === 8 && r.j.scenes.every(x => x.ok), `scene-preview on the samples ${flags}: ${JSON.stringify(r.j.scenes.filter(x => !x.ok)).slice(0, 400)}`);
  check(r.j.scenes.every(x => x.textMinPx >= 11 && x.overlaps.length === 0 && x.outside.length === 0 && x.unknownOps.length === 0), 'scene-preview reports problems on the samples');
  prevNote = r.j.font;
}
{ const bad = { caption: 'bad on purpose', draw: [{ op: 'packet', x: 6, y: 4, label: 'frame', id: 'frame' }, { op: 'text', x: 6, y: 4.2, t: 'detect_sample' }, { op: 'zap' }, { op: 'arrow', from: 'frame', to: 'nowhere' }] };
  const r = runPreview(bad, 'bad'), s0 = r.j && r.j.scenes[0];
  check(r.status === 1 && s0 && s0.ok === false && s0.overlaps.some(x => /detect_sample.*packet 'frame'/.test(x)) && s0.unknownOps[0] === 'zap' && s0.warnings.some(x => /nowhere/.test(x)), `scene-preview did not call out a broken drawing: ${r.j ? JSON.stringify(s0).slice(0, 300) : r.err.slice(0, 200)}`); }
errs.forEach(e => fails.push('page error: ' + e));
console.log(`props: ${realProps ? 'assets/themes/parts/props.js' : 'STUB (props.js not written yet)'}`);
console.log(`font: ${res.caveat ? 'Caveat loaded' : 'Caveat NOT loaded, measured with fallback'}`);
console.log(`byte-identical: ${identical} outputs match the pre-slot library`);
console.log(`draw: ${OPLIST.length} ops, ${DRAW_SAMPLES.length} samples, 1500 fuzz specs, 40 ops in ${globalThis.__drawMs} ms; scene-preview font: ${prevNote}`);
console.log(`checked ${NAMES.length} scenes x ${STRESS.length} captions, x ${SLOT_STRESS.length} slot fills, and ${PLATE_STRESS.length} context plates in the browser`);
shots.forEach(s => console.log('screenshot: ' + s));
if (fails.length) { console.log(`FAIL (${fails.length}):\n  ` + fails.slice(0, 40).join('\n  ')); process.exit(1); }
console.log('ok: scenes contract holds');
