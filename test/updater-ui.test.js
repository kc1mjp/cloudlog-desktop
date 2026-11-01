'use strict';
// The real src/renderer/pages/settings.js running in a node:vm context with a fake DOM and a mocked IPC bridge: the
// Updates tab renders the main process state and sends user actions through the updates:* calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { UpdateService } = require('../src/main/updater/service');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

class FakeEl {
  constructor(sel) { this.sel = sel; this.innerHTML = ''; this.textContent = ''; this.className = ''; this.dataset = {}; this.listeners = {}; this.style = {}; this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} }; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  setAttribute() {}
  appendChild(c) { return c; }
  remove() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  fire(type, extra = {}) { const ev = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra }; (this.listeners[type] || []).forEach((fn) => fn(ev)); return ev; }
}

function service(over = {}) {
  const store = { data: { updates: over.saved || {} }, saveNow() {} };
  const rel = { tag_name: 'v2610.2.0', draft: false, prerelease: false, assets: [] };
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([rel]) });
  return new UpdateService({ store, appVersion: '2610.1.0', fetchImpl, installation: { type: 'deb', label: 'Debian package (.deb)', selfUpdate: false, reason: 'Use the release page.', arch: 'x64', platform: 'linux' }, scheduler: { initialDelayMs: 1e9 } });
}

function boot(svc) {
  const els = new Map(); const calls = []; const toasts = [];
  const get = (s) => { if (!els.has(s)) els.set(s, new FakeEl(s)); return els.get(s); };
  const doc = { querySelector: get, querySelectorAll: () => [], createElement: () => new FakeEl('x'), body: new FakeEl('body'), documentElement: new FakeEl('html'), activeElement: null };
  get('#toasts').appendChild = (c) => { toasts.push(c); return c; };
  const ctx = { document: doc, console, location: { hash: '#/settings?tab=updates' }, URLSearchParams, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, addEventListener() {} };
  ctx.window = ctx;
  const handlers = {
    'rig:models': () => [],
    'updates:state': () => svc.getState(),
    'updates:set': (p) => svc.setPreferences(p),
    'updates:check': async () => { const result = await svc.check('manual'); return { result, state: svc.getState() }; },
    'updates:skip': () => svc.skip(),
    'updates:openRelease': () => ({ ok: true }),
  };
  ctx.cl = { on() {}, call: async (name, ...args) => { calls.push({ name, args }); if (!handlers[name]) throw new Error(`Unmocked call ${name}`); return handlers[name](...args); } };
  vm.createContext(ctx);
  for (const f of ['util.js', 'updates-shared.js', 'about-shared.js', 'pages/settings.js']) vm.runInContext(fs.readFileSync(path.join(RENDERER, f), 'utf8'), ctx, { filename: f });
  ctx.App.state.settings = { cloudlog: {}, sync: {}, theme: 'cerulean', rigs: [] };
  ctx.App.state.info = { version: '2610.1.0', dataDir: '/d', hamlib: {} };
  // The tab body: hand out the data-pref / data-act controls found in its current markup.
  const body = get('#tab-body'); const bound = [];
  body.querySelectorAll = (sel) => {
    const attr = sel === '[data-pref]' ? 'pref' : sel === '[data-act]' ? 'act' : null;
    if (!attr) return [];
    const out = [...String(body.innerHTML).matchAll(new RegExp(`<(?:input|button|a)\\b[^>]*data-${attr}="([\\w-]+)"[^>]*>`, 'g'))].map((m) => {
      const e = new FakeEl(m[1]); e.dataset[attr] = m[1]; e.checked = /\bchecked\b/.test(m[0]); bound.push(e); return e;
    });
    return out;
  };
  ctx.App.pages.settings.mount(new FakeEl('#page'));
  return { ctx, calls, toasts, body, bound, handlers };
}

test('Updates tab renders the main-process state and a toggle sends one atomic updates:set', async () => {
  const svc = service({ saved: { allowPrerelease: true } });
  const t = boot(svc);
  await settle();
  assert.ok(t.calls.some((c) => c.name === 'updates:state'));
  assert.match(t.body.innerHTML, /Auto check update/);
  const beta = t.bound.filter((e) => e.dataset.pref === 'allowBeta').pop();
  beta.checked = true; beta.fire('change'); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(t.calls.filter((c) => c.name === 'updates:set').map((c) => c.args))), [[{ allowBeta: true }]]);
  assert.equal(svc.getState().settings.allowBeta, true);
  const alpha = t.bound.filter((e) => e.dataset.pref === 'allowAlpha').pop();
  alpha.checked = true; alpha.fire('change'); await settle();
  assert.deepEqual([svc.getState().settings.allowBeta, svc.getState().settings.allowAlpha], [true, true]);
  assert.match(t.body.innerHTML, /id="up-alpha"[^>]*checked/);
});

test('Updates tab: a refused change shows the reason and re-reads the state; the master switch greys the controls', async () => {
  const svc = service();
  const t = boot(svc);
  await settle();
  const beta = t.bound.filter((e) => e.dataset.pref === 'allowBeta').pop();
  beta.checked = true; beta.fire('change'); await settle();            // pre-release is off: the main process refuses
  assert.match(t.toasts.map((x) => x.textContent).join('|'), /pre-release/);
  assert.equal(svc.getState().settings.allowBeta, false);
  const master = t.bound.find((e) => e.dataset.pref === 'autoCheck');
  master.checked = false; master.fire('change'); await settle();
  assert.match(t.body.innerHTML, /data-master-off/);
  assert.match(t.body.innerHTML, /id="up-prerelease"[^>]*disabled/);
});

test('Updates tab buttons: manual check, skip, and the release link (opened through IPC, never navigated)', async () => {
  const svc = service();
  const t = boot(svc);
  await settle();
  t.bound.find((e) => e.dataset.act === 'check').fire('click'); await settle();
  assert.ok(t.calls.some((c) => c.name === 'updates:check'));
  assert.match(t.body.innerHTML, /2610\.2\.0/); assert.match(t.body.innerHTML, /Update available/);
  t.bound.filter((e) => e.dataset.act === 'skip').pop().fire('click'); await settle();
  assert.equal(svc.getState().release.status, 'skipped');
  assert.match(t.body.innerHTML, /Skipped/);
  const link = t.bound.filter((e) => e.dataset.act === 'open-release').pop();
  const ev = link.fire('click'); await settle();
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(t.calls.filter((c) => c.name === 'updates:openRelease').map((c) => c.args), [[]]);   // no URL from the renderer
});
