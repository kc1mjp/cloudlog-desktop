'use strict';
/*
 * Regression tests for 0.3.5: Enter-to-log created duplicate QSOs on Live QSO (8x) and Quick log (4x), and
 * Quick log could report "Cannot read properties of null (reading 'value')".
 *
 * The real renderer scripts (util.js, page-guards.js and the Live / Quick / Contest pages) run unmodified in a
 * node:vm context against a very small fake DOM, and QSOs are stored by the real LogService (SQLite in a temp
 * dir). Nothing touches the network or real data. The harness mirrors app.js route(): unmount the current page,
 * clear #page, mount the next one - all pages mount into the same long-lived #page element.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { LogService } = require('../src/main/logbook');
const { SETTINGS_DEFAULTS } = require('../src/main/store');
const { BAND_NAMES, MODES } = require('../src/main/bands');
const { CONTESTS } = require('../src/main/contests');
const PageGuards = require('../src/renderer/page-guards');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const clone = (o) => JSON.parse(JSON.stringify(o));
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { const d = {}; d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; }); return d; };

// ---- fake DOM ---------------------------------------------------------------------------------------

class FakeEl {
  constructor(tag = 'div', props = {}) {
    Object.assign(this, { tagName: tag.toUpperCase(), value: '', checked: false, textContent: '', className: '', placeholder: '', innerHTML: '', parent: null, dataset: {}, style: { removeProperty() {} }, children: [] }, props);
    this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }

  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { const l = this.listeners.get(type); const i = l ? l.indexOf(fn) : -1; if (i >= 0) l.splice(i, 1); }
  listenerCount(type) { return (this.listeners.get(type) || []).length; }
  dispatchBubbling(ev) { for (let n = this; n; n = n.parent) for (const fn of [...(n.listeners.get(ev.type) || [])]) fn(ev); }
  focus() { this.ownerDoc.activeElement = this; }
  appendChild(c) { this.children.push(c); return c; }
  remove() {}
  setAttribute() {}
  querySelector(sel) { return this.ownerDoc.query(sel); }
  querySelectorAll() { return []; }
}

class FakeRoot extends FakeEl {
  constructor(doc) { super('main'); this.doc = doc; this._html = ''; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); if (this.doc) this.doc.elements.clear(); } // doc is unset while the base constructor runs
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.activeElement = null;
    this.root = new FakeRoot(this); this.root.ownerDoc = this;
    this.toastBox = this.make('div'); this.toastBox.appendChild = (c) => { this.toasts.push(c); return c; };
    this.toasts = [];
    this.body = this.make('body');
    this.documentElement = this.make('html');
  }

  make(tag, props) { const e = new FakeEl(tag, props); e.ownerDoc = this; return e; }
  createElement(tag) { return this.make(tag); }
  querySelector(sel) { return this.query(sel); }
  querySelectorAll() { return []; }

  /** Elements exist only while the current page's HTML contains their id - like the real DOM after innerHTML is replaced. */
  query(sel) {
    if (sel === '#page') return this.root;
    if (sel === '#toasts') return this.toastBox;
    const html = this.root.innerHTML;
    const aria = /^\[aria-label="([^"]+)"\]$/.exec(sel);
    if (aria) return html.includes(`aria-label="${aria[1]}"`) ? this.cached(sel, () => this.make('div')) : null;
    const m = /^#([\w-]+)$/.exec(sel);
    if (!m) return null;
    const id = m[1];
    return this.cached(sel, () => {
      const tag = new RegExp(`<(\\w+)(?=[\\s>])[^>]*?\\sid="${id}"[^>]*>`).exec(html);
      if (!tag) return null;
      const el = this.make(tag[1], { id });
      const v = /\svalue="([^"]*)"/.exec(tag[0]);
      if (v) el.value = v[1];
      if (tag[1] === 'select') {
        const body = new RegExp(`<select[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
        const opts = [...(body ? body[1].matchAll(/<option([^>]*)>([^<]*)<\/option>/g) : [])];
        const pick = opts.find((o) => /\bselected\b/.test(o[1])) || opts[0];
        if (pick) el.value = (/\svalue="([^"]*)"/.exec(pick[1]) || [])[1] ?? pick[2];
      }
      el.parent = this.root;
      return el;
    });
  }

  cached(key, build) {
    if (!this.elements.has(key)) { const e = build(); if (!e) return null; this.elements.set(key, e); }
    return this.elements.get(key);
  }
}

// ---- harness -----------------------------------------------------------------------------------------

/** Loads the real renderer scripts into a fresh vm context. `mocks` lets a test control the IPC replies. */
function createHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-enter-'));
  const settings = clone(SETTINGS_DEFAULTS);
  settings.sync.instant = false; // never start an upload
  settings.cloudlog = { url: '', apiKey: '', urlStyle: 'auto', currentStationId: '1', stations: [{ id: '1', name: 'Home', callsign: 'W1AW', grid: 'FN31', active: true }] };
  const log = new LogService({ dir, client: { configured: () => false }, getSettings: () => settings });

  const doc = new FakeDocument();
  const timers = new Set();
  const calls = [];
  const mocks = { defer: null, fail: null, workedBefore: { count: 0, bands: [], recent: [], last: null }, workedBeforeGate: null };

  const handlers = {
    'qso:add': async (fields, opts = {}) => {
      if (mocks.defer) { const d = mocks.defer; mocks.defer = null; await d.promise; }
      if (mocks.fail) { const e = mocks.fail; mocks.fail = null; throw e; }
      const rec = log.addQso(fields, { source: opts.source || 'manual' });
      return { id: rec.id, call: rec.fields.CALL };
    },
    'qso:workedBefore': async () => { if (mocks.workedBeforeGate) await mocks.workedBeforeGate.promise; return mocks.workedBefore; },
    'log:stats': () => ({ recent: [] }),
    'callbook:lookup': () => ({ status: 'disabled', message: '' }),
    'settings:set': () => undefined,
    'external:profile': () => true,
  };

  const ctx = {
    document: doc,
    console,
    Event: class { constructor(type) { this.type = type; } },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); timers.add(t); return t; },
    clearTimeout: (t) => { clearTimeout(t); timers.delete(t); },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); timers.add(t); return t; },
    clearInterval: (t) => { clearInterval(t); timers.delete(t); },
  };
  ctx.window = ctx;
  ctx.cl = { on() {}, call: async (name, ...args) => { calls.push({ name, args }); const h = handlers[name]; if (!h) throw new Error(`Unmocked call ${name}`); return h(...args); } };
  vm.createContext(ctx);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(RENDERER, rel), 'utf8'), ctx, { filename: rel });
  for (const f of ['callbook-shared.js', 'page-guards.js', 'util.js', 'pages/live.js', 'pages/quick.js', 'pages/contest.js']) load(f);

  const App = ctx.App;
  Object.assign(App.state, { settings, rig: null, info: { bands: BAND_NAMES, modes: MODES, contests: CONTESTS, version: '0.0.0' } });

  const h = {
    doc, root: doc.root, App, log, settings, mocks, calls,
    records: () => log.localList(),
    addCalls: () => calls.filter((c) => c.name === 'qso:add'),
    toasts: () => doc.toasts.map((t) => ({ text: t.textContent, kind: t.className })),
    errorToasts: () => doc.toasts.filter((t) => /danger/.test(t.className)).map((t) => t.textContent),
    el: (id) => doc.query(`#${id}`),
    set(id, v) { const e = doc.query(`#${id}`); assert.ok(e, `#${id} should exist on the mounted page`); e.value = v; },
    /** Same sequence as app.js route(): unmount the old page, clear #page, mount the new one. */
    go(name) {
      if (h.current) App.pages[h.current].unmount?.();
      h.current = name;
      doc.root.innerHTML = '';
      App.pages[name].mount(doc.root);
    },
    /** A keydown that starts on the given field and bubbles up to #page, like the real thing. */
    key(id, key = 'Enter', extra = {}) {
      const target = typeof id === 'string' ? doc.query(`#${id}`) : id;
      assert.ok(target, `#${id} should exist on the mounted page`);
      const ev = { type: 'keydown', key, target, repeat: false, isComposing: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      target.dispatchBubbling(ev);
      return ev;
    },
    click(id) { const e = doc.query(`#${id}`); assert.ok(e, `#${id} should exist`); e.dispatchBubbling({ type: 'click', target: e }); },
    close() { if (h.current) App.pages[h.current].unmount?.(); h.current = null; for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.clear(); },
    current: null,
  };
  return h;
}

/** Runs fn with a fresh harness and always releases its timers. */
const withHarness = (fn) => async () => { const h = createHarness(); try { await fn(h); } finally { h.close(); } };

const LIVE_FIELDS = ['f-date', 'f-time', 'f-call', 'f-mode', 'f-band', 'f-freq', 'f-rsts', 'f-rstr', 'f-pwr', 'f-name', 'f-qth', 'f-grid', 'f-comment'];
const QUICK_FIELDS = ['my-type', 'my-ref', 'q-call', 'their-type', 'their-ref', 'q-rsts', 'q-rstr', 'q-mode', 'q-band', 'q-freq', 'q-name', 'q-comment'];

// ---- Live QSO ----------------------------------------------------------------------------------------

test('Live QSO: Enter in every field logs exactly one QSO per keypress', withHarness(async (h) => {
  h.go('live');
  for (const [i, id] of LIVE_FIELDS.entries()) {
    h.set('f-call', 'K1ABC');
    const ev = h.key(id);
    assert.ok(ev.defaultPrevented, `Enter in #${id} must not also trigger native submit/default action`);
    await settle();
    assert.strictEqual(h.addCalls().length, i + 1, `#${id}: qso:add calls`);
    assert.strictEqual(h.records().length, i + 1, `#${id}: stored records`);
  }
}));

test('Live QSO: the Save button logs exactly one QSO', withHarness(async (h) => {
  h.go('live');
  h.set('f-call', 'K1ABC');
  h.click('save');
  await settle();
  assert.strictEqual(h.addCalls().length, 1);
  assert.strictEqual(h.records().length, 1);
  assert.strictEqual(h.records()[0].fields.CALL, 'K1ABC');
}));

test('Live QSO: Enter on a focused button is left to the button (no second save path)', withHarness(async (h) => {
  h.go('live');
  h.set('f-call', 'K1ABC');
  const ev = h.key('save');
  await settle();
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(h.addCalls().length, 0, 'the keydown handler must not log when a button has focus; the click does');
}));

test('Live QSO: rapid repeated Enter during a save cannot create overlapping saves', withHarness(async (h) => {
  h.go('live');
  h.set('f-call', 'K1ABC');
  const gate = deferred(); h.mocks.defer = gate;
  for (let i = 0; i < 6; i++) h.key('f-call');
  h.click('save'); // the button is also ignored while a save is in progress
  await settle();
  assert.strictEqual(h.addCalls().length, 1, 'only one save may be in flight');
  gate.resolve();
  await settle();
  assert.strictEqual(h.records().length, 1);
  assert.strictEqual(h.el('f-call').value, '', 'form resets after the save completes');
}));

test('Live QSO: key auto-repeat from holding Enter is ignored', withHarness(async (h) => {
  h.go('live');
  h.set('f-call', 'K1ABC');
  h.key('f-call', 'Enter', { repeat: true });
  await settle();
  assert.strictEqual(h.addCalls().length, 0);
  h.key('f-call');
  await settle();
  assert.strictEqual(h.records().length, 1);
}));

test('Live QSO: a later QSO logs normally after a successful save', withHarness(async (h) => {
  h.go('live');
  h.set('f-call', 'K1ABC'); h.key('f-call'); await settle();
  h.set('f-call', 'W2XYZ'); h.key('f-call'); await settle();
  assert.deepStrictEqual(h.records().map((r) => r.fields.CALL).sort(), ['K1ABC', 'W2XYZ']);
}));

test('Live QSO: a failed save releases the in-progress state, keeps the entry, and the retry logs once', withHarness(async (h) => {
  h.go('live');
  h.set('f-call', 'K1ABC');
  h.mocks.fail = new Error('disk full');
  h.key('f-call'); await settle();
  assert.strictEqual(h.records().length, 0);
  assert.deepStrictEqual(h.errorToasts(), ['disk full']);
  assert.strictEqual(h.el('f-call').value, 'K1ABC', 'a failed save must not clear what the operator typed');
  h.key('f-call'); await settle();
  assert.strictEqual(h.records().length, 1);
  h.set('f-call', 'W2XYZ'); h.key('f-call'); await settle();
  assert.strictEqual(h.records().length, 2);
}));

test('Live QSO: validation failures log nothing and do not wedge the next save', withHarness(async (h) => {
  h.go('live');
  h.key('f-call'); await settle();
  assert.deepStrictEqual(h.errorToasts(), ['Enter a callsign']);
  assert.strictEqual(h.records().length, 0);
  h.set('f-call', 'K1ABC'); h.key('f-call'); await settle();
  assert.strictEqual(h.records().length, 1);
}));

test('Live QSO: normal workflow - fields are saved, form resets, focus returns to the callsign', withHarness(async (h) => {
  h.go('live');
  h.set('f-call', 'K1ABC'); h.set('f-freq', '14.2'); h.set('f-name', 'Ann'); h.set('f-qth', 'Boston'); h.set('f-grid', 'fn42'); h.set('f-comment', 'hi');
  h.key('f-comment'); await settle();
  const [rec] = h.records();
  assert.strictEqual(rec.source, 'Live QSO');
  assert.strictEqual(rec.fields.CALL, 'K1ABC');
  assert.strictEqual(rec.fields.NAME, 'Ann');
  assert.strictEqual(rec.fields.QTH, 'Boston');
  assert.strictEqual(rec.fields.GRIDSQUARE, 'FN42');
  assert.strictEqual(rec.fields.COMMENT, 'hi');
  assert.strictEqual(rec.fields.SUBMODE, 'USB');
  for (const id of ['f-call', 'f-name', 'f-qth', 'f-grid', 'f-comment']) assert.strictEqual(h.el(id).value, '', `#${id} cleared`);
  assert.strictEqual(h.el('f-rsts').value, '59');
  assert.strictEqual(h.doc.activeElement, h.el('f-call'));
  assert.deepStrictEqual(h.toasts().map((t) => t.text), ['Logged K1ABC']);
}));

test('Live QSO: with no logbook chosen nothing is saved', withHarness(async (h) => {
  h.settings.cloudlog.currentStationId = null;
  h.go('live');
  h.set('f-call', 'K1ABC'); h.key('f-call'); await settle();
  assert.strictEqual(h.addCalls().length, 0);
  assert.match(h.errorToasts()[0], /Choose a logbook/);
}));

// ---- Quick log -----------------------------------------------------------------------------------------

test('Quick log: Enter in every field logs exactly one QSO per keypress', withHarness(async (h) => {
  h.go('quick');
  for (const [i, id] of QUICK_FIELDS.entries()) {
    h.set('q-call', 'K1ABC');
    const ev = h.key(id);
    assert.ok(ev.defaultPrevented, `Enter in #${id} must not also trigger native submit/default action`);
    await settle();
    assert.strictEqual(h.addCalls().length, i + 1, `#${id}: qso:add calls`);
    assert.strictEqual(h.records().length, i + 1, `#${id}: stored records`);
  }
  assert.deepStrictEqual(h.errorToasts(), []);
}));

test('Quick log: the Log it button logs exactly one QSO', withHarness(async (h) => {
  h.go('quick');
  h.set('q-call', 'K1ABC');
  h.click('q-save');
  await settle();
  assert.strictEqual(h.addCalls().length, 1);
  assert.strictEqual(h.records().length, 1);
}));

test('Quick log: Enter on a focused button is left to the button (no second save path)', withHarness(async (h) => {
  h.go('quick');
  h.set('q-call', 'K1ABC');
  const ev = h.key('q-save');
  await settle();
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(h.addCalls().length, 0);
}));

test('Quick log: rapid repeated Enter during a save cannot create overlapping saves', withHarness(async (h) => {
  h.go('quick');
  h.set('q-call', 'K1ABC');
  const gate = deferred(); h.mocks.defer = gate;
  for (let i = 0; i < 6; i++) h.key('q-call');
  h.click('q-save');
  await settle();
  assert.strictEqual(h.addCalls().length, 1, 'only one save may be in flight');
  gate.resolve();
  await settle();
  assert.strictEqual(h.records().length, 1);
  assert.strictEqual(h.el('count').textContent, '1 this session');
}));

test('Quick log: key auto-repeat from holding Enter is ignored', withHarness(async (h) => {
  h.go('quick');
  h.set('q-call', 'K1ABC');
  h.key('q-call', 'Enter', { repeat: true });
  await settle();
  assert.strictEqual(h.addCalls().length, 0);
}));

test('Quick log: a later QSO logs normally after a successful save', withHarness(async (h) => {
  h.go('quick');
  h.set('q-call', 'K1ABC'); h.key('q-call'); await settle();
  h.set('q-call', 'W2XYZ'); h.key('q-call'); await settle();
  assert.deepStrictEqual(h.records().map((r) => r.fields.CALL).sort(), ['K1ABC', 'W2XYZ']);
}));

test('Quick log: a failed save releases the in-progress state, keeps the entry, and the retry logs once', withHarness(async (h) => {
  h.go('quick');
  h.set('q-call', 'K1ABC');
  h.mocks.fail = new Error('disk full');
  h.key('q-call'); await settle();
  assert.strictEqual(h.records().length, 0);
  assert.deepStrictEqual(h.errorToasts(), ['disk full']);
  assert.strictEqual(h.el('q-call').value, 'K1ABC');
  assert.notStrictEqual(h.el('count').textContent, '1 this session', 'a failed save must not count as logged');
  h.key('q-call'); await settle();
  assert.strictEqual(h.records().length, 1);
  h.set('q-call', 'W2XYZ'); h.key('q-call'); await settle();
  assert.strictEqual(h.records().length, 2);
}));

test('Quick log: normal workflow - fields saved, form reset, focus, counter and "just logged" list', withHarness(async (h) => {
  h.settings.quick.myRef = 'K-0001';
  h.go('quick');
  h.set('q-call', 'K1ABC'); h.set('their-ref', 'k-0042'); h.set('q-name', 'Ann'); h.set('q-freq', '14.285');
  h.key('q-call'); await settle();
  const [rec] = h.records();
  assert.strictEqual(rec.source, 'Quick log');
  assert.strictEqual(rec.fields.CALL, 'K1ABC');
  assert.strictEqual(rec.fields.MY_POTA_REF, 'K-0001');
  assert.strictEqual(rec.fields.POTA_REF, 'K-0042');
  assert.strictEqual(h.el('count').textContent, '1 this session');
  assert.match(h.el('just').innerHTML, /K1ABC · 20m SSB · K-0042/);
  for (const id of ['q-call', 'their-ref', 'q-name', 'q-comment']) assert.strictEqual(h.el(id).value, '', `#${id} cleared`);
  assert.strictEqual(h.doc.activeElement, h.el('q-call'));
}));

test('Quick log: Escape clears the entry without logging', withHarness(async (h) => {
  h.go('quick');
  h.set('q-call', 'K1ABC'); h.set('q-name', 'Ann');
  h.key('q-call', 'Escape'); await settle();
  assert.strictEqual(h.el('q-call').value, '');
  assert.strictEqual(h.el('q-name').value, '');
  assert.strictEqual(h.addCalls().length, 0);
}));

test('Quick log: an already-worked callsign is armed by the first Enter and logged once by the second', withHarness(async (h) => {
  const today = h.App.util.utcNow().date.replace(/-/g, '');
  h.mocks.workedBefore = { count: 1, bands: ['20m'], recent: [{ date: today, band: '20m', mode: 'SSB' }], last: { date: today } };
  h.go('quick');
  h.set('q-call', 'K1ABC');
  h.el('q-mode').dispatchBubbling({ type: 'change', target: h.el('q-mode') }); // runs the duplicate check
  await settle();
  h.key('q-call'); await settle();
  assert.strictEqual(h.addCalls().length, 0, 'first Enter only arms the duplicate warning');
  h.key('q-call'); await settle();
  assert.strictEqual(h.addCalls().length, 1);
  assert.strictEqual(h.records().length, 1);
}));

// ---- listeners, lifecycle and the null .value error -------------------------------------------------------

test('Navigating away and back never accumulates Enter listeners on #page', withHarness(async (h) => {
  for (let i = 0; i < 8; i++) { h.go('live'); h.go('quick'); h.go('contest'); }
  h.go('live');
  assert.strictEqual(h.root.listenerCount('keydown'), 1, 'Live QSO');
  h.go('quick');
  assert.strictEqual(h.root.listenerCount('keydown'), 1, 'Quick log');
  h.close();
  assert.strictEqual(h.root.listenerCount('keydown'), 0, 'nothing left after the page is unmounted');
}));

test('Re-mounting a page without an unmount in between still leaves a single listener', withHarness(async (h) => {
  h.go('live');
  h.App.pages.live.mount(h.root);
  h.App.pages.live.mount(h.root);
  assert.strictEqual(h.root.listenerCount('keydown'), 1);
  h.set('f-call', 'K1ABC'); h.key('f-call'); await settle();
  assert.strictEqual(h.records().length, 1);
}));

test('Live QSO: after eight visits one Enter still creates exactly one QSO (was eight)', withHarness(async (h) => {
  for (let i = 0; i < 8; i++) { h.go('live'); h.go('quick'); }
  h.go('live');
  h.set('f-call', 'K1ABC'); h.key('f-call'); await settle();
  assert.strictEqual(h.addCalls().length, 1);
  assert.strictEqual(h.records().length, 1);
  assert.deepStrictEqual(h.errorToasts(), []);
}));

test('Quick log: after four visits one Enter still creates exactly one QSO (was four)', withHarness(async (h) => {
  for (let i = 0; i < 4; i++) { h.go('quick'); h.go('live'); }
  h.go('quick');
  h.set('q-call', 'K1ABC'); h.key('q-call'); await settle();
  assert.strictEqual(h.addCalls().length, 1);
  assert.strictEqual(h.records().length, 1);
}));

test('Quick log: other pages\' Enter handlers no longer run against its form (the null .value error)', withHarness(async (h) => {
  // Before the fix a Live/Contest handler left on #page ran on the Quick page, where #f-call / #c-call do not
  // exist, and reported "Cannot read properties of null (reading 'value')".
  h.go('live'); h.go('contest'); h.go('live'); h.go('quick');
  h.set('q-call', 'K1ABC');
  h.key('q-call'); await settle();
  assert.deepStrictEqual(h.errorToasts(), []);
  assert.ok(!h.toasts().some((t) => /null|Cannot read/.test(t.text)));
  assert.strictEqual(h.records().length, 1);
}));

test('A page that has been left does not react to Enter at all', withHarness(async (h) => {
  h.go('live'); h.go('quick');
  h.root.innerHTML = ''; // e.g. the dashboard, which has no Enter handling
  h.App.pages.quick.unmount();
  h.current = null;
  const before = h.calls.length;
  h.root.dispatchBubbling({ type: 'keydown', key: 'Enter', target: h.root, repeat: false, preventDefault() {} });
  await settle();
  assert.strictEqual(h.calls.length, before, 'no IPC call made');
  assert.deepStrictEqual(h.toasts(), []);
}));

test('Quick log: leaving the page while a save is in flight does not read null fields or touch the next page', withHarness(async (h) => {
  h.go('quick');
  h.set('q-call', 'K1ABC'); h.set('their-ref', 'k-0042');
  const gate = deferred(); h.mocks.defer = gate;
  h.key('q-call'); await settle();
  h.go('live');
  h.set('f-call', 'W2XYZ'); // operator has already started typing on the next page
  gate.resolve(); await settle();
  assert.deepStrictEqual(h.errorToasts(), [], 'no "Cannot read properties of null" after navigating away');
  assert.strictEqual(h.records().length, 1);
  assert.strictEqual(h.el('f-call').value, 'W2XYZ', 'the finished save must not clear the page the operator is on now');
  // the session list was still updated, so it shows when they come back
  h.go('quick');
  assert.match(h.el('just').innerHTML, /K1ABC · 20m SSB · K-0042/);
}));

test('Live QSO: leaving the page while a save is in flight does not touch the next page', withHarness(async (h) => {
  h.go('live');
  h.set('f-call', 'K1ABC');
  const gate = deferred(); h.mocks.defer = gate;
  h.key('f-call'); await settle();
  h.go('quick');
  h.set('q-call', 'W2XYZ');
  gate.resolve(); await settle();
  assert.deepStrictEqual(h.errorToasts(), []);
  assert.strictEqual(h.records().length, 1);
  assert.strictEqual(h.el('q-call').value, 'W2XYZ');
}));

test('Quick log: a duplicate check that returns after the page was left does not read null fields', withHarness(async (h) => {
  h.go('quick');
  h.set('q-call', 'K1ABC');
  const gate = deferred(); h.mocks.workedBeforeGate = gate;
  h.el('q-mode').dispatchBubbling({ type: 'change', target: h.el('q-mode') }); // starts checkDupe, which awaits the lookup
  await settle();
  h.go('live');
  h.mocks.workedBefore = { count: 1, bands: ['20m'], recent: [], last: { date: '20260101' } };
  gate.resolve();
  await settle(); // an exception here would surface as an unhandled rejection and fail the run
  assert.ok(true);
}));

// ---- the helpers themselves --------------------------------------------------------------------------------

test('createSingleFlight: ignores calls while busy and is released on success and on failure', async () => {
  const sf = PageGuards.createSingleFlight();
  const gate = deferred();
  let runs = 0;
  const first = sf.run(async () => { runs++; await gate.promise; return 'a'; });
  assert.strictEqual(sf.busy, true);
  assert.strictEqual(await sf.run(async () => { runs++; }), undefined);
  gate.resolve();
  assert.strictEqual(await first, 'a');
  assert.strictEqual(sf.busy, false);
  await assert.rejects(sf.run(async () => { throw new Error('x'); }), /x/);
  assert.strictEqual(sf.busy, false);
  await assert.rejects(sf.run(() => { throw new Error('sync'); }), /sync/);
  assert.strictEqual(sf.busy, false);
  assert.strictEqual(await sf.run(async () => 'again'), 'again');
  assert.strictEqual(runs, 1);
});

test('createDisposer: removes every registered listener, once', () => {
  const t = new FakeEl('div');
  const d = PageGuards.createDisposer();
  d.listen(t, 'keydown', () => {});
  d.listen(t, 'keydown', () => {});
  assert.strictEqual(t.listenerCount('keydown'), 2);
  d.dispose(); d.dispose();
  assert.strictEqual(t.listenerCount('keydown'), 0);
  assert.strictEqual(d.size, 0);
});

test('isLogEnter: only a fresh Enter that is not on a button', () => {
  const on = (tag) => ({ tagName: tag });
  assert.ok(PageGuards.isLogEnter({ key: 'Enter', target: on('INPUT') }));
  assert.ok(PageGuards.isLogEnter({ key: 'Enter', target: on('SELECT') }));
  assert.ok(!PageGuards.isLogEnter({ key: 'Enter', target: on('BUTTON') }));
  assert.ok(!PageGuards.isLogEnter({ key: 'Enter', target: on('INPUT'), repeat: true }));
  assert.ok(!PageGuards.isLogEnter({ key: 'Enter', target: on('INPUT'), isComposing: true }));
  assert.ok(!PageGuards.isLogEnter({ key: 'a', target: on('INPUT') }));
  assert.ok(!PageGuards.isLogEnter(null));
});

test('the page-guards script is loaded by the renderer before the pages that use it', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const order = ['page-guards.js', 'util.js', 'pages/live.js', 'pages/quick.js', 'pages/contest.js'].map((s) => html.indexOf(`src="${s}"`));
  assert.ok(order.every((i) => i >= 0), 'all scripts present');
  assert.ok(order[0] < order[2] && order[0] < order[3] && order[0] < order[4], 'page-guards.js precedes the pages');
});
