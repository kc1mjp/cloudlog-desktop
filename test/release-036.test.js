'use strict';
/*
 * Release 0.3.6: "Cloudlog Desktop" branding, cloud icon -> configured server, Settings hamburger, new About tab.
 *
 * The real renderer scripts (util.js, about-shared.js, app.js, pages/settings.js) run unmodified in a node:vm context
 * against a tiny fake DOM with a mocked IPC bridge. External-link, Hamlib and data-folder values are all fixtures:
 * nothing touches the network, a real browser, a real rigctld or the real data folder.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createExternalLinks, normalizeHttpUrl, NOT_CONFIGURED } = require('../src/main/external-links');
const { parseHamlibVersion, RigManager } = require('../src/main/rig');
const About = require('../src/renderer/about-shared');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

const EXPECTED_LINKS = {
  cloudlog: 'https://github.com/magicbug/Cloudlog',
  wavelog: 'https://github.com/wavelog/wavelog',
  github: 'https://github.com/kc1mjp/cloudlog-desktop',
  gpl3: 'https://github.com/kc1mjp/cloudlog-desktop/blob/master/LICENSE',
};

// ---- version -----------------------------------------------------------------------------------------
test('package metadata reports 0.3.7 and the product name is unchanged', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.version, '0.3.7');
  assert.strictEqual(pkg.build.appId, 'org.cloudlog.desktop');
  assert.strictEqual(pkg.build.productName, 'Cloudlog Desktop');
});

// ---- address validation / opening -------------------------------------------------------------------------
test('normalizeHttpUrl accepts http(s) and refuses everything else', () => {
  assert.strictEqual(normalizeHttpUrl('  https://log.example.com  '), 'https://log.example.com/');
  assert.strictEqual(normalizeHttpUrl('http://192.168.1.5:8080/cloudlog'), 'http://192.168.1.5:8080/cloudlog');
  assert.strictEqual(normalizeHttpUrl('HTTPS://Log.Example.com/index.php'), 'https://log.example.com/index.php');
  for (const bad of [undefined, null, 42, {}, '', '   ', 'log.example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.example',
    'data:text/html,hi', 'https:/example.com', 'http:example.com', 'https://', 'https://user:pw@example.com', 'https://exa mple.com', 'https://a.example/\nx',
    `https://example.com/${'a'.repeat(3000)}`]) {
    assert.strictEqual(normalizeHttpUrl(bad), null, JSON.stringify(bad));
  }
});

test('cloud icon: opens the configured address through openExternal', async () => {
  const opened = [];
  const links = createExternalLinks({ getCloudlogUrl: () => ' https://log.example.com/ ', openExternal: async (u) => { opened.push(u); } });
  assert.deepStrictEqual(await links.openCloudlog(), { ok: true });
  assert.deepStrictEqual(opened, ['https://log.example.com/']);
});

test('cloud icon: missing, malformed or unsafe addresses do not throw or open anything', async () => {
  for (const value of ['', '   ', undefined, null, 'not a url', 'log.example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@example.com']) {
    const opened = [];
    const links = createExternalLinks({ getCloudlogUrl: () => value, openExternal: async (u) => { opened.push(u); } });
    const r = await links.openCloudlog();
    assert.deepStrictEqual(r, { ok: false, message: NOT_CONFIGURED }, JSON.stringify(value));
    assert.strictEqual(opened.length, 0, JSON.stringify(value));
  }
  assert.strictEqual(NOT_CONFIGURED, 'Configure a valid Cloudlog address in Settings before opening it.');
  // A settings read that throws, or a browser launch that fails, is reported rather than thrown.
  const broken = createExternalLinks({ getCloudlogUrl: () => { throw new Error('boom'); }, openExternal: async () => {} });
  assert.strictEqual((await broken.openCloudlog()).ok, false);
  const refusing = createExternalLinks({ getCloudlogUrl: () => 'https://log.example.com', openExternal: async () => { throw new Error('no browser'); } });
  assert.strictEqual((await refusing.openCloudlog()).ok, false);
});

test('About links: only the four fixed targets can be opened, by key', async () => {
  const opened = [];
  const links = createExternalLinks({ getCloudlogUrl: () => '', openExternal: async (u) => { opened.push(u); } });
  for (const [key, url] of Object.entries(EXPECTED_LINKS)) assert.deepStrictEqual(await links.openAbout(key), { ok: true }, key);
  assert.deepStrictEqual(opened, Object.values(EXPECTED_LINKS));
  opened.length = 0;
  for (const bad of ['https://evil.example', 'constructor', '__proto__', '', null, undefined, 7]) assert.strictEqual((await links.openAbout(bad)).ok, false, String(bad));
  assert.strictEqual(opened.length, 0);
});

// ---- About content -----------------------------------------------------------------------------------
const INFO = { version: '0.3.6', hamlibVersion: '4.5.5', rigctld: '/opt/test-hamlib/bin/rigctld', dataDir: '/tmp/fixture-data/cloudlog-desktop' };

test('About body shows the runtime values and the four exact links', () => {
  const body = About.renderAboutBody(INFO);
  for (const v of Object.values(INFO)) assert.ok(body.includes(v), v);
  assert.match(body, /An unofficial desktop companion for <a [^>]*>Cloudlog<\/a> or <a [^>]*>WaveLog<\/a>:/);
  for (const line of ['Log contacts with or without a server connection.', 'Drive your radio through Hamlib.', 'Accept QSOs from other programs.']) assert.ok(body.includes(line), line);
  for (const label of ['Version:', 'Hamlib Version:', 'Hamlib rigctld:', 'Data Folder:', 'Source:', 'License:']) assert.ok(body.includes(label), label);
  for (const [key, url] of Object.entries(EXPECTED_LINKS)) {
    const m = new RegExp(`<a href="([^"]+)" data-ext="${key}" aria-label="([^"]+)"[^>]*>([^<]+)</a>`).exec(body);
    assert.ok(m, key);
    assert.strictEqual(m[1], url);
    assert.ok(m[2].length > m[3].length, `${key} needs a descriptive accessible name`);
    assert.strictEqual(m[3], About.ABOUT_LINKS[key].label);
  }
  assert.deepStrictEqual(Object.fromEntries(Object.entries(About.ABOUT_LINKS).map(([k, v]) => [k, v.url])), EXPECTED_LINKS);
  assert.ok(!/\/home\/users\/mford|\/usr\/bin\/rigctld/.test(body), 'no hard-coded example paths');
});

test('About body: neutral fallbacks and HTML escaping', () => {
  const body = About.renderAboutBody({ version: '0.3.6', hamlibVersion: null, rigctld: null, dataDir: '/data' });
  assert.match(body, /Hamlib Version:<\/dt><dd[^>]*>Not available</);
  assert.match(body, /Hamlib rigctld:<\/dt><dd[^>]*>Not configured</);
  const evil = About.renderAboutBody({ ...INFO, dataDir: '/x/<img src=x onerror=alert(1)>' });
  assert.ok(!evil.includes('<img'));
});

// ---- Hamlib discovery ------------------------------------------------------------------------------------
test('parseHamlibVersion reads rigctld --version output', () => {
  assert.strictEqual(parseHamlibVersion('rigctld Hamlib 4.5.5 2023-04-29T14:20:00Z SHA 1a2b3c 64-bit'), '4.5.5');
  assert.strictEqual(parseHamlibVersion('rigctld, Hamlib 4.6.2\n'), '4.6.2');
  assert.strictEqual(parseHamlibVersion('rigctld Hamlib 4.7~git'), '4.7~git');
  assert.strictEqual(parseHamlibVersion(''), null);
  assert.strictEqual(parseHamlibVersion('something else'), null);
});

test('RigManager.aboutInfo uses the configured rigctld path and a fake binary, and falls back cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-about-'));
  const fake = path.join(dir, 'rigctld');
  fs.writeFileSync(fake, '#!/bin/sh\necho "rigctld Hamlib 9.8.7 2030-01-01T00:00:00Z SHA deadbeef 64-bit"\n', { mode: 0o755 });
  const mk = (rigctldPath, env) => new RigManager({ getSettings: () => ({ activeRigId: 'a', rigs: [{ id: 'a', rigctldPath }] }), resourcesPath: path.join(dir, 'none'), ...env });
  const info = await mk(fake).aboutInfo();
  assert.deepStrictEqual(info, { rigctld: fake, hamlibVersion: '9.8.7' });

  const broken = path.join(dir, 'bin2'); fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'rigctld'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  assert.deepStrictEqual(await mk(path.join(broken, 'rigctld')).aboutInfo(), { rigctld: path.join(broken, 'rigctld'), hamlibVersion: null });

  const savedPath = process.env.PATH; process.env.PATH = path.join(dir, 'empty');
  try {
    const none = await mk('').aboutInfo();
    if (!none.rigctld) assert.deepStrictEqual(none, { rigctld: null, hamlibVersion: null }); // only when no system rigctld sits in /usr/bin etc.
  } finally { process.env.PATH = savedPath; }
});

// ---- renderer harness ---------------------------------------------------------------------------------------
class FakeEl {
  constructor(sel) {
    this.sel = sel; this.innerHTML = ''; this.textContent = ''; this.className = ''; this.value = ''; this.dataset = {};
    this.listeners = {}; this.classes = new Set(); this.attrs = {}; this.style = { removeProperty() {} };
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => { if (on === undefined ? !this.classes.has(c) : on) this.classes.add(c); else this.classes.delete(c); } };
  }

  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(c) { return c; }
  remove() {}
  querySelector() { return null; }
  querySelectorAll(sel) {
    const m = /^\[data-ext\]$/.exec(sel);
    if (!m) return [];
    return [...String(this.innerHTML).matchAll(/data-ext="(\w+)"/g)].map(([, key]) => {
      const a = new FakeEl(`a[${key}]`); a.dataset.ext = key; return a;
    });
  }

  click() { const ev = { type: 'click', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (this.listeners.click || []).forEach((fn) => fn(ev)); return ev; }
}

function createEnv({ handlers = {}, hash = '' } = {}) {
  const els = new Map();
  const get = (sel) => { if (!els.has(sel)) els.set(sel, new FakeEl(sel)); return els.get(sel); };
  const toasts = []; const calls = [];
  const doc = { querySelector: get, querySelectorAll: () => [], createElement: () => new FakeEl('x'), body: new FakeEl('body'), documentElement: new FakeEl('html'), activeElement: null };
  doc.toastBox = get('#toasts'); doc.toastBox.appendChild = (c) => { toasts.push(c); return c; };
  const ctx = {
    document: doc, console, location: { hash }, URLSearchParams, Event: class {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {},
  };
  ctx.window = ctx;
  ctx.cl = { on() {}, call: async (name, ...args) => { calls.push({ name, args }); if (!handlers[name]) throw new Error(`Unmocked call ${name}`); return handlers[name](...args); } };
  vm.createContext(ctx);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(RENDERER, rel), 'utf8'), ctx, { filename: rel });
  return { ctx, load, get, toasts, calls, toastTexts: () => toasts.map((t) => t.textContent) };
}

const APP_HANDLERS = {
  'settings:get': () => ({ theme: 'cerulean', cloudlog: { url: '', currentStationId: null, stations: [] }, sync: {} }),
  'rig:status': () => ({ rigs: [], activeId: null }),
  'sync:status': () => ({ configured: false, pending: 0, failed: 0 }),
  'adif:status': () => ({}),
  'app:info': () => ({ version: '0.3.6', dataDir: '/tmp/x', hamlib: {} }),
};

async function bootApp(extra = {}) {
  const env = createEnv({ handlers: { ...APP_HANDLERS, ...extra } });
  for (const f of ['util.js', 'app.js']) { if (f === 'app.js') { env.ctx.App.pages = { dashboard: { mount() {} }, settings: { mount() {} } }; } env.load(f); }
  await settle();
  return env;
}

// ---- top bar ------------------------------------------------------------------------------------------------
test('top bar markup: Cloudlog Desktop title, labelled cloud button, hamburger last', () => {
  const html = read('src', 'renderer', 'index.html');
  const nav = /<nav[^>]*id="topnav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)[1];
  assert.match(nav, /<a [^>]*href="#\/dashboard"[^>]*>Cloudlog Desktop<\/a>/);
  assert.ok(!/>Cloudlog<\/a>/.test(nav), 'old title must be gone');
  assert.match(nav, /<button[^>]*id="open-server"[^>]*title="Open configured Cloudlog server in browser"[^>]*aria-label="Open configured Cloudlog server in browser"/);
  const burger = /<button[^>]*id="btn-settings"[^>]*>/.exec(nav)[0];
  assert.match(burger, /title="Settings menu"/);
  assert.match(burger, /aria-label="Settings menu"/);
  assert.match(burger, /type="button"/);
  assert.match(nav, /fa-bars/);
  // Far right: the last element in the nav, after the status chips/clock; and no second Settings entry in the main navigation.
  const tags = [...nav.matchAll(/<(button|ul|div|a)\b[^>]*>/g)].map((m) => m[0]);
  assert.match(tags[tags.length - 1], /id="btn-settings"/);
  assert.ok(nav.indexOf('id="btn-settings"') > nav.indexOf('id="clock"'));
  assert.ok(!/data-route="settings"/.test(nav));
  assert.strictEqual((html.match(/id="btn-settings"/g) || []).length, 1);
});

test('cloud icon click asks the main process to open the configured server, and shows its message when it cannot', async () => {
  let reply = { ok: true };
  const env = await bootApp({ 'external:cloudlog': () => reply });
  const cloud = env.get('#open-server');
  assert.strictEqual(cloud.listeners.click.length, 1);
  cloud.click(); await settle();
  assert.strictEqual(env.calls.filter((c) => c.name === 'external:cloudlog').length, 1);
  assert.deepStrictEqual(env.toastTexts(), []);
  reply = { ok: false, message: NOT_CONFIGURED };
  cloud.click(); await settle();
  assert.deepStrictEqual(env.toastTexts(), [NOT_CONFIGURED]);
  // Rendering/hovering never calls it; the renderer never sends a URL.
  assert.ok(env.calls.filter((c) => c.name === 'external:cloudlog').every((c) => c.args.length === 0));
});

test('cloud icon: an IPC failure becomes a toast, not an exception', async () => {
  const env = await bootApp({ 'external:cloudlog': () => { throw new Error('ipc down'); } });
  env.get('#open-server').click(); await settle();
  assert.deepStrictEqual(env.toastTexts(), ['ipc down']);
});

test('hamburger button opens the existing Settings route, with a single click binding', async () => {
  const env = await bootApp();
  const burger = env.get('#btn-settings');
  assert.strictEqual(burger.listeners.click.length, 1);
  burger.click();
  assert.strictEqual(env.ctx.location.hash, '#/settings');
});

// ---- Settings > About (real settings.js) ---------------------------------------------------------------------
async function openAbout(about) {
  const env = createEnv({ hash: '#/settings?tab=about', handlers: {
    'rig:models': () => [],
    'app:about': about,
    'external:about': () => ({ ok: true }),
  } });
  for (const f of ['util.js', 'about-shared.js', 'pages/settings.js']) env.load(f);
  env.ctx.App.state.settings = { cloudlog: {}, sync: {}, theme: 'cerulean' };
  env.ctx.App.state.info = { version: '0.3.6', dataDir: '/fallback/dir', hamlib: { rigctld: null } };
  const root = new FakeEl('#page');
  env.ctx.App.pages.settings.mount(root);
  await settle();
  return env;
}

test('About tab renders runtime values from the main process and opens each link through IPC', async () => {
  const env = await openAbout(() => INFO);
  const body = env.get('#about-body');
  for (const v of Object.values(INFO)) assert.ok(body.innerHTML.includes(v), v);
  assert.strictEqual(body.querySelectorAll('[data-ext]').length, 4);
});

test('About tab: link clicks call external:about with the link key and prevent navigation', async () => {
  const bound = [];
  const env = createEnv({ hash: '#/settings?tab=about', handlers: { 'rig:models': () => [], 'app:about': () => INFO, 'external:about': () => ({ ok: true }) } });
  const body = env.get('#about-body');
  body.querySelectorAll = (sel) => {
    if (sel !== '[data-ext]') return [];
    return ['cloudlog', 'wavelog', 'github', 'gpl3'].map((key) => { const a = new FakeEl(key); a.dataset.ext = key; bound.push(a); return a; });
  };
  for (const f of ['util.js', 'about-shared.js', 'pages/settings.js']) env.load(f);
  env.ctx.App.state.settings = { cloudlog: {}, sync: {}, theme: 'cerulean' };
  env.ctx.App.state.info = { version: '0.3.6', dataDir: '/fallback/dir', hamlib: {} };
  env.ctx.App.pages.settings.mount(new FakeEl('#page'));
  await settle();
  assert.strictEqual(bound.length, 4);
  for (const a of bound) { const ev = a.click(); assert.ok(ev.defaultPrevented, `${a.dataset.ext} must not navigate the app window`); }
  await settle();
  assert.deepStrictEqual(env.calls.filter((c) => c.name === 'external:about').map((c) => c.args), [['cloudlog'], ['wavelog'], ['github'], ['gpl3']]);
});

test('About tab: shows neutral fallbacks when the main process cannot determine Hamlib details', async () => {
  const env = await openAbout(() => ({ version: '0.3.6', dataDir: '/data/dir', rigctld: null, hamlibVersion: null }));
  const html = env.get('#about-body').innerHTML;
  assert.ok(html.includes('Not available') && html.includes('Not configured') && html.includes('/data/dir'));
});

test('About tab still renders (from startup info) if the about call fails', async () => {
  const env = await openAbout(() => { throw new Error('ipc down'); });
  const html = env.get('#about-body').innerHTML;
  assert.ok(html.includes('0.3.6') && html.includes('/fallback/dir') && html.includes('Not configured'));
});
