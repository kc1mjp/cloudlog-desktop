'use strict';
/*
 * Release 0.3.7: Dashboard drops Station and shows Country instead of Notes; Logbook shows Grid and Country instead of
 * Station and Notes; the Logbook Previous/Next buttons are readable without hover.
 *
 * The real renderer scripts (util.js, pages/dashboard.js, pages/logbook.js) run unmodified in a node:vm context against a
 * tiny fake DOM with a mocked IPC bridge. Nothing touches the network, a real window or the real data folder.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

class FakeEl {
  constructor(sel) {
    this.sel = sel; this._html = ''; this.textContent = ''; this.value = ''; this.disabled = false; this.dataset = {};
    this.listeners = {}; this.classes = new Set(); this.style = { removeProperty() {} };
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => { if (on === undefined ? !this.classes.has(c) : on) this.classes.add(c); else this.classes.delete(c); } };
  }

  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); } // a real DOM coerces the page's html`` template objects to strings

  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  click() { if (this.disabled) return; (this.listeners.click || []).forEach((fn) => fn({ type: 'click', preventDefault() {} })); }
}

function createEnv(handlers) {
  const els = new Map();
  const get = (sel) => { if (!els.has(sel)) els.set(sel, new FakeEl(sel)); return els.get(sel); };
  const calls = [];
  const ctx = {
    document: { querySelector: get, querySelectorAll: () => [], createElement: () => new FakeEl('x'), body: new FakeEl('body'), activeElement: null },
    console, location: { hash: '' }, URLSearchParams, Event: class {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {},
  };
  ctx.window = ctx;
  ctx.cl = { on() {}, call: async (name, ...args) => { calls.push({ name, args }); if (!handlers[name]) throw new Error(`Unmocked call ${name}`); return handlers[name](...args); } };
  vm.createContext(ctx);
  const load = (rel) => vm.runInContext(read('src', 'renderer', rel), ctx, { filename: rel });
  load('util.js');
  return { ctx, load, get, calls };
}

const SETTINGS = { cloudlog: { url: '', currentStationId: '7', stations: [{ id: '7', name: 'Home', callsign: 'KC1MJP', grid: 'FN41' }] }, sync: { instant: true }, theme: 'cerulean' };
const SYNC = { configured: true, pending: 0, failed: 0, paused: false, lastError: '' };

const FULL = { QSO_DATE: '20261003', TIME_ON: '1415', CALL: 'K1ABC', BAND: '20m', MODE: 'SSB', RST_SENT: '59', RST_RCVD: '57', NAME: 'Pat Example', QTH: 'Springfield', GRIDSQUARE: 'FN42ab', COUNTRY: 'United States', COMMENT: 'private note text' };
const NO_COUNTRY = { QSO_DATE: '20261003', TIME_ON: '1416', CALL: 'W1NOC', BAND: '40m', MODE: 'CW', GRIDSQUARE: 'FN31' };
const NO_GRID = { QSO_DATE: '20261003', TIME_ON: '1417', CALL: 'G0NOG', BAND: '15m', MODE: 'FT8', COUNTRY: 'England' };
const NULLS = { QSO_DATE: '20261003', TIME_ON: '1418', CALL: 'DL0NUL', BAND: '10m', MODE: 'SSB', GRIDSQUARE: null, COUNTRY: null };
const BLANKS = { QSO_DATE: '20261003', TIME_ON: '1419', CALL: 'VE3BLK', BAND: '80m', MODE: 'SSB', GRIDSQUARE: '   ', COUNTRY: '   ' };

const headers = (htmlStr) => [...htmlStr.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]);
const bodyRows = (htmlStr) => [...htmlStr.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].trim()));
const noJunk = (s) => { assert.ok(!/undefined|null|NaN|\[object/.test(s), `rendered junk in: ${s}`); };

// ---- shared table helpers -------------------------------------------------------------------------------
test('qsoHead: Dashboard layout has Country and neither Station nor Notes', () => {
  const { ctx } = createEnv({});
  const h = headers(String(ctx.App.util.qsoHead(['country'])));
  assert.deepStrictEqual(h, ['Date', 'UTC', 'Call', 'Band', 'Mode', 'RST', 'Country', '']);
});

test('qsoHead: Logbook layout has Grid then Country and neither Station nor Notes', () => {
  const { ctx } = createEnv({});
  const h = headers(String(ctx.App.util.qsoHead(['grid', 'country'])));
  assert.deepStrictEqual(h, ['Date', 'UTC', 'Call', 'Band', 'Mode', 'RST', 'Grid', 'Country', '']);
});

test('qsoRows: header and cell counts always match, including the empty state', () => {
  const { ctx } = createEnv({});
  const { qsoHead, qsoRows } = ctx.App.util;
  for (const cols of [['country'], ['grid', 'country']]) {
    const n = headers(String(qsoHead(cols))).length;
    for (const row of bodyRows(String(qsoRows([FULL, NO_COUNTRY, NO_GRID, NULLS, BLANKS], cols)))) assert.strictEqual(row.length, n, cols.join());
    assert.match(String(qsoRows([], cols)), new RegExp(`colspan="${n}"`));
  }
});

test('qsoRows: country and grid are escaped and unknown column names are ignored', () => {
  const { ctx } = createEnv({});
  const out = String(ctx.App.util.qsoRows([{ ...FULL, COUNTRY: '<b>x</b>', GRIDSQUARE: '"><i>' }], ['grid', 'country', 'station', 'notes']));
  assert.ok(!out.includes('<b>x</b>') && !out.includes('<i>'));
  assert.ok(out.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.deepStrictEqual(headers(String(ctx.App.util.qsoHead(['station', 'notes']))), ['Date', 'UTC', 'Call', 'Band', 'Mode', 'RST', '']);
});

// ---- Dashboard ---------------------------------------------------------------------------------------------
async function mountDashboard(recent) {
  const env = createEnv({ 'log:stats': () => ({ total: recent.length, today: 1, recent }) });
  env.load('pages/dashboard.js');
  env.ctx.App.state = { settings: SETTINGS, info: { bands: [], modes: [] }, rig: null, rigs: [], sync: SYNC, adif: { enabled: false } };
  const root = new FakeEl('#page');
  env.ctx.App.pages.dashboard.mount(root);
  await settle();
  return root.innerHTML;
}

test('Dashboard: no Station column, Notes replaced by Country, header text exact', async () => {
  const out = await mountDashboard([FULL]);
  const thead = /<thead>[\s\S]*?<\/thead>/.exec(out)[0];
  assert.deepStrictEqual(headers(thead), ['Date', 'UTC', 'Call', 'Band', 'Mode', 'RST', 'Country', '']);
  assert.ok(!/Station|Notes/.test(thead));
  assert.ok(thead.includes('<th>Country</th>'));
});

test('Dashboard: each row shows the contact country and none of the removed columns\' content', async () => {
  const out = await mountDashboard([FULL, { ...FULL, CALL: 'JA1XYZ', COUNTRY: 'Japan' }]);
  const rows = bodyRows(/<tbody>[\s\S]*<\/tbody>/.exec(out)[0]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0][6], 'United States');
  assert.strictEqual(rows[1][6], 'Japan');
  for (const gone of ['Pat Example', 'Springfield', 'FN42ab', 'private note text']) assert.ok(!out.includes(gone), `${gone} should no longer be in the Recent QSOs table`);
});

test('Dashboard: missing, null or blank country renders an empty cell, not undefined/null, and the page still loads', async () => {
  const out = await mountDashboard([NO_COUNTRY, NULLS, BLANKS, NO_GRID]);
  const table = /<table[\s\S]*<\/table>/.exec(out)[0];
  noJunk(table);
  const rows = bodyRows(/<tbody>[\s\S]*<\/tbody>/.exec(table)[0]);
  assert.deepStrictEqual(rows.map((r) => r[6]), ['', '', '', 'England']);
  assert.ok(out.includes('Recent QSOs'));
});

test('Dashboard: no QSOs shows the empty row spanning every column', async () => {
  const out = await mountDashboard([]);
  assert.match(out, /colspan="8"[^>]*>No QSOs yet/);
});

// ---- Logbook -----------------------------------------------------------------------------------------------
async function mountLogbook(rows, { total = rows.length, page = 1, pageSize = 50, fetchedAt = 1700000000000 } = {}) {
  const env = createEnv({
    'log:query': (params) => ({ rows, total, page: params.page || page, pageSize, fetchedAt, cached: rows.length }),
    'local:list': () => [],
  });
  env.load('pages/logbook.js');
  env.ctx.App.state = { settings: SETTINGS, info: { bands: ['20m'], modes: ['SSB'] }, rig: null, rigs: [], sync: SYNC, adif: {} };
  const root = new FakeEl('#page');
  env.ctx.App.pages.logbook.mount(root);
  await settle();
  return { env, root, body: env.get('#lb-body'), prev: env.get('#lb-prev'), next: env.get('#lb-next') };
}

test('Logbook: Station is replaced by Grid, Notes by Country, header text exact', async () => {
  const { root } = await mountLogbook([FULL]);
  const thead = /<thead>[\s\S]*?<\/thead>/.exec(root.innerHTML)[0];
  assert.deepStrictEqual(headers(thead), ['Date', 'UTC', 'Call', 'Band', 'Mode', 'RST', 'Grid', 'Country', '']);
  assert.ok(!/Station|Notes/.test(thead));
  assert.ok(thead.includes('<th>Grid</th><th>Country</th>'));
});

test('Logbook: rows show the contact gridsquare and country', async () => {
  const { body } = await mountLogbook([FULL, { ...FULL, CALL: 'JA1XYZ', GRIDSQUARE: 'PM95', COUNTRY: 'Japan' }]);
  const rows = bodyRows(body.innerHTML);
  assert.deepStrictEqual(rows.map((r) => r.slice(6, 8)), [['FN42ab', 'United States'], ['PM95', 'Japan']]);
  for (const gone of ['Pat Example', 'Springfield', 'private note text']) assert.ok(!body.innerHTML.includes(gone), `${gone} should no longer be in the Logbook table`);
});

test('Logbook: missing, null or blank grid/country render empty cells and the rest of the row is intact', async () => {
  const { body } = await mountLogbook([NO_COUNTRY, NO_GRID, NULLS, BLANKS]);
  noJunk(body.innerHTML);
  const rows = bodyRows(body.innerHTML);
  assert.deepStrictEqual(rows.map((r) => r.slice(6, 8)), [['FN31', ''], ['', 'England'], ['', ''], ['', '']]);
  assert.deepStrictEqual(rows.map((r) => r[2]), ['W1NOC', 'G0NOG', 'DL0NUL', 'VE3BLK']);
});

test('Logbook: empty-state messages span all nine columns', async () => {
  const { body } = await mountLogbook([], { total: 0, fetchedAt: null });
  assert.match(body.innerHTML, /colspan="9"/);
  assert.ok(!/colspan="8"/.test(body.innerHTML));
});

// ---- Logbook pagination -------------------------------------------------------------------------------------
const HIDING = /\b(d-none|invisible|visually-hidden|opacity-0|collapse)\b|\bhidden\b|style=|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0\b/;

test('Pagination: Previous and Next are present in the rendered markup with no hiding classes or inline styles', async () => {
  const { root } = await mountLogbook([FULL]);
  const footer = /<div class="card-footer[\s\S]*$/.exec(root.innerHTML)[0];
  for (const [id, label] of [['lb-prev', 'Previous'], ['lb-next', 'Next']]) {
    const m = new RegExp(`<button([^>]*)id="${id}"([^>]*)>${label}</button>`).exec(footer);
    assert.ok(m, `${label} button`);
    const attrs = `${m[1]} ${m[2]}`;
    assert.ok(!HIDING.test(attrs), `${label} attrs: ${attrs}`);
    assert.match(attrs, /type="button"/);
    assert.match(attrs, /class="btn pager-btn"/);
    assert.ok(!/btn-outline-secondary/.test(attrs), 'must not use the pale Cerulean secondary outline again');
  }
  assert.ok(!HIDING.test(/<div class="card-footer[^>]*>/.exec(footer)[0]) && !/class="btn-group[^"]*(d-none|invisible)/.test(footer));
});

test('Pagination CSS: the rest state is not hidden and never depends on hover/focus', () => {
  const css = read('src', 'renderer', 'styles.css');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /pager-btn|card-footer|lb-prev|lb-next/.test(m[1]));
  assert.ok(rules.some((m) => /\.pager-btn\s*$/.test(m[1].trim())), 'a base .pager-btn rule exists');
  for (const [, sel, decl] of rules) {
    assert.ok(!/opacity\s*:\s*0\b|visibility\s*:\s*hidden|display\s*:\s*none|\bclip\b|height\s*:\s*0\b/.test(decl), `${sel.trim()} hides the buttons`);
  }
  const base = rules.find((m) => /\.pager-btn\s*$/.test(m[1].trim()))[2];
  assert.match(base, /--bs-btn-color:\s*var\(--bs-body-color\)/);
  assert.match(base, /--bs-btn-border-color:\s*var\(--bs-secondary-color\)/);
  assert.match(base, /--bs-btn-disabled-border-color:\s*var\(--bs-secondary-color\)/);
  assert.match(base, /--bs-btn-disabled-opacity:\s*\.7/, 'disabled stays clearly visible');
  assert.match(base, /--bs-btn-disabled-color:\s*var\(--bs-body-color\)/);
});

// WCAG-style helpers. Colours are #hex or rgba(); alpha is blended over a background colour.
const parseColor = (v) => {
  v = v.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (m) { const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]; return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 }; }
  m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(v);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error(`cannot parse colour ${v}`);
};
const over = (fg, bg) => ({ rgb: fg.rgb.map((c, i) => c * fg.a + bg.rgb[i] * (1 - fg.a)), a: 1 });
const lum = ({ rgb }) => { const [r, g, b] = rgb.map((c) => c / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// The app puts <html data-bs-theme="dark"> on every theme except cerulean (app.js applyTheme), and each Bootswatch file defines a
// separate colour set per mode - so read the block the app actually uses (Darkly's light block has #fff text and would hide a bug).
const modeBlock = (css, dark) => {
  const sel = dark ? /\[data-bs-theme=dark\]\s*\{([^}]*)\}/g : /:root,\[data-bs-theme=light\]\s*\{([^}]*)\}/g;
  for (const m of css.matchAll(sel)) if (m[1].includes('--bs-body-color:')) return m[1];
  throw new Error('colour block not found');
};
const prop = (block, name) => { const m = new RegExp(`${name}:\\s*([^;]+);?`).exec(block); return m && m[1].trim(); };

test('Pagination colours, using the colour set each bundled theme really runs in: text and border both stand out from the footer', (t) => {
  const dir = path.join(RENDERER, 'vendor');
  const themes = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^[a-z]+\.css$/.test(f)) : [];
  if (!themes.length) { t.skip('vendor themes not installed (run npm install / node scripts/copy-vendor.js)'); return; }
  assert.match(read('src', 'renderer', 'app.js'), /const dark = t !== 'cerulean'/, 'test assumes cerulean is the only light theme');
  assert.deepStrictEqual(themes.sort(), ['cerulean.css', 'cyborg.css', 'darkly.css']);
  for (const f of themes) {
    const css = fs.readFileSync(path.join(dir, f), 'utf8');
    const b = modeBlock(css, f !== 'cerulean.css');
    const text = parseColor(prop(b, '--bs-body-color')); const body = parseColor(prop(b, '--bs-body-bg'));
    const styles = read('src', 'renderer', 'styles.css');
    const borderVar = /\.pager-btn\s*\{[^}]*--bs-btn-border-color:\s*var\((--[a-z-]+)\)/.exec(styles)[1]; // whichever variable the stylesheet really uses
    const border = parseColor(prop(b, borderVar));
    // Footer background: Darkly sets a solid colour; the others tint the body colour at 3%. Reproduce the real colour either way.
    const cap = /--bs-card-cap-bg:\s*(#[0-9a-f]{3,6})/i.exec(css);
    const footer = cap ? parseColor(cap[1]) : over({ rgb: text.rgb, a: 0.03 }, body);
    const btnBg = body; // .pager-btn background is --bs-body-bg
    assert.ok(contrast(text, btnBg) >= 4.5, `${f}: button text on button background ${contrast(text, btnBg).toFixed(2)}:1`);
    const edge = over(border, footer);
    assert.ok(contrast(edge, footer) >= 3, `${f}: button border against the footer is ${contrast(edge, footer).toFixed(2)}:1 (needs 3:1 so the control is visible)`);
  }
});

test('Pagination colours: documents why the old buttons vanished (btn-outline-secondary matched the footer in Darkly and Cyborg, and the page in Cerulean)', (t) => {
  const dir = path.join(RENDERER, 'vendor');
  if (!fs.existsSync(path.join(dir, 'darkly.css'))) { t.skip('vendor themes not installed'); return; }
  const outline = (css) => parseColor(/\.btn-outline-secondary\{--bs-btn-color:(#[0-9a-f]{3,6})/i.exec(css)[1]);
  const darkly = fs.readFileSync(path.join(dir, 'darkly.css'), 'utf8');
  const footer = parseColor(/--bs-card-cap-bg:\s*(#[0-9a-f]{3,6})/i.exec(darkly)[1]);
  assert.ok(contrast(outline(darkly), footer) < 1.1, 'Darkly: old border/text colour was identical to the footer');
  const cerulean = fs.readFileSync(path.join(dir, 'cerulean.css'), 'utf8');
  assert.ok(contrast(outline(cerulean), parseColor('#fff')) < 1.5, 'Cerulean: old colour was near-white on white');
});

test('Pagination: disabled states at the bounds, and Next/Previous still page through the logbook', async () => {
  const only = await mountLogbook([FULL], { total: 1 });
  assert.strictEqual(only.prev.disabled, true); assert.strictEqual(only.next.disabled, true);

  const first = await mountLogbook([FULL], { total: 120, page: 1 });
  assert.strictEqual(first.prev.disabled, true); assert.strictEqual(first.next.disabled, false);
  first.next.click(); await settle();
  const queries = first.env.calls.filter((c) => c.name === 'log:query').map((c) => c.args[0].page);
  assert.deepStrictEqual(queries, [1, 2]);
  assert.strictEqual(first.prev.disabled, false, 'Previous enabled once past page 1');
  first.prev.click(); await settle();
  assert.deepStrictEqual(first.env.calls.filter((c) => c.name === 'log:query').map((c) => c.args[0].page), [1, 2, 1]);

  const last = await mountLogbook([FULL], { total: 100, page: 1, pageSize: 50 });
  last.next.click(); await settle(); // page 2 of 2
  assert.strictEqual(last.next.disabled, true); assert.strictEqual(last.prev.disabled, false);
});

test('Pagination: buttons are real <button type="button"> elements, so Tab/Enter/Space keep working', async () => {
  const { root } = await mountLogbook([FULL]);
  assert.strictEqual((root.innerHTML.match(/<button type="button" class="btn pager-btn" id="lb-(prev|next)">/g) || []).length, 2);
  assert.match(root.innerHTML, /role="group" aria-label="Logbook pages"/);
});

// ---- Logbook sizes itself to the window (one scrollbar) --------------------------------------------------------
const cssRule = (css, selector) => { const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css); return m && m[1]; };

test('Logbook layout: table height is no longer a fixed share of the viewport', async () => {
  const css = read('src', 'renderer', 'styles.css');
  assert.ok(!/\.scroll-y\b/.test(css) && !/max-height:\s*62vh/.test(css), 'old fixed-height table box is gone');
  const { root } = await mountLogbook([FULL]);
  assert.ok(!/scroll-y/.test(root.innerHTML));
  assert.match(root.innerHTML, /<div class="table-responsive lb-scroll">/);
  assert.match(root.innerHTML, /<div class="card" id="lb-card">/);
});

test('Logbook layout CSS: window-height column, table region grows and scrolls, header and footer stay put', () => {
  const css = read('src', 'renderer', 'styles.css');
  const body = cssRule(css, 'body.fill-viewport');
  assert.match(body, /height:\s*100vh/); assert.match(body, /display:\s*flex/); assert.match(body, /flex-direction:\s*column/); assert.match(body, /overflow:\s*hidden/);
  assert.match(cssRule(css, 'body.fill-viewport #topnav'), /flex:\s*0 0 auto/);
  const page = cssRule(css, 'body.fill-viewport #page');
  assert.match(page, /flex:\s*1 1 auto/); assert.match(page, /min-height:\s*0/); assert.match(page, /overflow-x:\s*hidden/);
  const card = cssRule(css, 'body.fill-viewport #lb-card');
  assert.match(card, /flex:\s*1 1 auto/); assert.match(card, /flex-direction:\s*column/);
  const table = cssRule(css, 'body.fill-viewport .lb-scroll');
  assert.match(table, /flex:\s*1 1 auto/); assert.match(table, /overflow:\s*auto/); assert.match(table, /min-height:\s*\d/, 'keeps a few rows visible on very short windows');
  assert.match(css, /body\.fill-viewport #lb-card > \.card-footer[^{]*\{[^}]*flex:\s*0 0 auto/, 'pager footer is never squeezed out');
  const queue = cssRule(css, 'body.fill-viewport #queue');
  assert.match(queue, /flex:\s*0 0 auto/, 'the queue card keeps its height rather than being squashed under the Logbook card');
  assert.match(cssRule(css, 'body.fill-viewport #queue .table-responsive'), /max-height:\s*clamp\(/, 'a long queue list is capped relative to the window and scrolls on its own');
});

test('Logbook layout: the fill-viewport mode is on while the Logbook is open and gone when it is left', async () => {
  const { env } = await mountLogbook([FULL]);
  const body = env.ctx.document.body;
  assert.strictEqual(body.classList.contains('fill-viewport'), true);
  env.ctx.App.pages.logbook.unmount();
  assert.strictEqual(body.classList.contains('fill-viewport'), false, 'other pages must scroll normally again');
  // re-entering restores it, and the Dashboard never turns it on
  env.ctx.App.pages.logbook.mount(new FakeEl('#page')); await settle();
  assert.strictEqual(body.classList.contains('fill-viewport'), true);
  env.ctx.App.pages.logbook.unmount();
  const dash = createEnv({ 'log:stats': () => ({ total: 0, today: 0, recent: [] }) });
  dash.load('pages/dashboard.js');
  dash.ctx.App.state = { settings: SETTINGS, info: { bands: [], modes: [] }, rig: null, rigs: [], sync: SYNC, adif: { enabled: false } };
  dash.ctx.App.pages.dashboard.mount(new FakeEl('#page')); await settle();
  assert.strictEqual(dash.ctx.document.body.classList.contains('fill-viewport'), false);
});

// ---- release plumbing -------------------------------------------------------------------------------------
test('release 0.3.7: the new test file is part of npm test, and the 0.3.7 notes are kept', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.includes('test/release-037.test.js'));
  assert.match(read('README.md'), /^### 0\.3\.7$/m);
});
