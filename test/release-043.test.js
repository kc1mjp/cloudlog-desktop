'use strict';
/*
 * Release 0.4.3: callbook enrichment (four independent switches), upload-time enrichment persisted on the local QSO,
 * and the Live QSO running clock / submission timestamp.
 *
 * Nothing here needs a live provider, credentials or the internet: lookups are fakes, the Cloudlog server is
 * test/mock-cloudlog.js on a loopback port, and the Live QSO / Quick log pages (the real renderer scripts) run in a
 * node:vm context against a small fake DOM with a controllable clock.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const vm = require('vm');
const { LogService } = require('../src/main/logbook');
const { CloudlogClient } = require('../src/main/cloudlog');
const { SETTINGS_DEFAULTS, JsonStore, migrateCallbook } = require('../src/main/store');
const config = require('../src/main/callbook/config');
const enrich = require('../src/main/callbook/enrich');
const { ingestRecords, storeFormQso } = require('../src/main/ingest');
const { AdifServer } = require('../src/main/adifserver');
const { QrzProvider } = require('../src/main/callbook/qrz');
const { HamQthProvider } = require('../src/main/callbook/hamqth');
const { createSecretBox } = require('../src/main/secrets');
const { BAND_NAMES, MODES } = require('../src/main/bands');
const { CONTESTS } = require('../src/main/contests');
const mock = require('./mock-cloudlog');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cld043-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { const d = {}; d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; }); return d; };
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(10); }
  throw new Error('timed out');
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---- fakes -------------------------------------------------------------------------------------------------------
const FULL = { name: 'Pat', state: 'MA', county: 'Suffolk', country: 'United States', grid: 'FN42' };
const ok = (call, o = FULL) => ({ status: 'ok', provider: 'qrz', label: 'QRZ', call, message: '', name: '', qth: '', grid: '', state: '', county: '', country: '', ...o });

/** A lookup that records every call. `reply` is a result object or a function (call) => result | Promise<result>. */
function fakeLookup(reply = (call) => ok(call)) {
  const f = async (call) => { f.calls.push(call); return typeof reply === 'function' ? reply(call) : reply; };
  f.calls = [];
  return f;
}

const SW = { metadataOnNew: false, metadataOnUpload: false, gridOnNew: false, gridOnUpload: false };
function mkSettings(sw = {}) {
  const s = clone(SETTINGS_DEFAULTS);
  s.sync.instant = false; // uploads only when a test calls sync()
  s.cloudlog = { url: '', apiKey: '', urlStyle: 'auto', currentStationId: '1', stations: [] };
  s.callbook.enrich = { ...SW, ...sw };
  return s;
}
function mkLog({ sw = {}, lookup = fakeLookup(), settings = mkSettings(sw), client = { configured: () => false }, dir = tmp(), budget } = {}) {
  const enricher = new enrich.CallbookEnricher({ getSettings: () => settings, lookup, ...(budget ? { newQsoBudgetMs: budget } : {}) });
  const log = new LogService({ dir, client, getSettings: () => settings, enricher });
  return { log, settings, lookup, enricher, dir };
}
const BASE = { call: 'K1ABC', mode: 'SSB', band: '20m', qso_date: '20261012', time_on: '120000' };
const stored = (log, i = 0) => log.localList()[i].fields;

// ---- settings: four independent Booleans ---------------------------------------------------------------------------
test('callbook defaults: four Booleans, new-QSO switches on (Live QSO behaviour kept), upload switches off', () => {
  assert.deepStrictEqual(config.CALLBOOK_DEFAULTS.enrich, { metadataOnNew: true, metadataOnUpload: false, gridOnNew: true, gridOnUpload: false });
  assert.deepStrictEqual(config.ENRICH_KEYS, ['metadataOnNew', 'metadataOnUpload', 'gridOnNew', 'gridOnUpload']);
  assert.deepStrictEqual(SETTINGS_DEFAULTS.callbook.enrich, config.CALLBOOK_DEFAULTS.enrich);
});

test('resolveEnrich accepts only Booleans and falls back to the default for anything else', () => {
  assert.deepStrictEqual(config.resolveEnrich(undefined), config.ENRICH_DEFAULTS);
  assert.deepStrictEqual(config.resolveEnrich({ metadataOnNew: 'yes', metadataOnUpload: 1, gridOnNew: null, gridOnUpload: true }),
    { metadataOnNew: true, metadataOnUpload: false, gridOnNew: true, gridOnUpload: true });
  assert.deepStrictEqual(config.resolveEnrich({ metadataOnNew: false, gridOnNew: false }), { metadataOnNew: false, metadataOnUpload: false, gridOnNew: false, gridOnUpload: false });
});

test('applyPatch changes each switch on its own and never touches the provider or its credentials', () => {
  const box = createSecretBox({});
  const stored0 = { provider: 'qrz', qrz: { username: 'u', password: box.seal('pw') }, hamqth: { username: 'h', password: '' } };
  const before = clone(stored0);
  for (const k of config.ENRICH_KEYS) {
    const st = clone(stored0);
    config.applyPatch(st, { enrich: { [k]: !config.ENRICH_DEFAULTS[k] } }, box);
    const want = { ...config.ENRICH_DEFAULTS, [k]: !config.ENRICH_DEFAULTS[k] };
    assert.deepStrictEqual(st.enrich, want, `only ${k} may change`);
    assert.strictEqual(st.provider, before.provider);
    assert.deepStrictEqual(st.qrz, before.qrz);
    assert.deepStrictEqual(st.hamqth, before.hamqth);
  }
  const st = clone(stored0);
  config.applyPatch(st, { enrich: { metadataOnNew: 'false', gridOnUpload: 1, bogus: true } }, box);
  assert.deepStrictEqual(st.enrich, config.ENRICH_DEFAULTS, 'non-Boolean values and unknown keys are ignored');
  config.applyPatch(st, { provider: 'hamqth' }, box);
  assert.deepStrictEqual(st.enrich, config.ENRICH_DEFAULTS, 'a patch without enrich leaves the switches alone');
});

test('publicConfig and resolveConfig carry the switches; the renderer copy still has no password', () => {
  const box = createSecretBox({});
  const st = { provider: 'qrz', qrz: { username: 'u', password: box.seal('s3cret-pw') }, enrich: { gridOnUpload: true } };
  const pub = config.publicConfig(st);
  assert.deepStrictEqual(pub.enrich, { metadataOnNew: true, metadataOnUpload: false, gridOnNew: true, gridOnUpload: true });
  assert.ok(!JSON.stringify(pub).includes('s3cret-pw'));
  assert.deepStrictEqual(config.resolveConfig(st, box).enrich, pub.enrich);
});

test('settings from before 0.4.3 keep provider and logins and get the documented defaults', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'darkly', callbook: { provider: 'hamqth', qrz: { username: 'q', password: 'enc1:abc' }, hamqth: { username: 'h', password: 'enc1:def' } } }));
  const s = new JsonStore(file, SETTINGS_DEFAULTS);
  migrateCallbook(s.data);
  assert.strictEqual(s.data.theme, 'darkly');
  assert.strictEqual(s.data.callbook.provider, 'hamqth');
  assert.deepStrictEqual(s.data.callbook.qrz, { username: 'q', password: 'enc1:abc' });
  assert.deepStrictEqual(s.data.callbook.hamqth, { username: 'h', password: 'enc1:def' });
  assert.deepStrictEqual(s.data.callbook.enrich, { metadataOnNew: true, metadataOnUpload: false, gridOnNew: true, gridOnUpload: false });
});

test('migrateCallbook repairs a bad switch value only, and a missing callbook block gets the defaults', () => {
  const d = migrateCallbook({ callbook: { provider: 'qrz', enrich: { metadataOnNew: 'x', gridOnUpload: true, gridOnNew: false } } });
  assert.deepStrictEqual(d.callbook.enrich, { metadataOnNew: true, metadataOnUpload: false, gridOnNew: false, gridOnUpload: true });
  assert.strictEqual(d.callbook.provider, 'qrz');
  assert.deepStrictEqual(migrateCallbook({}).callbook, config.CALLBOOK_DEFAULTS);
});

test('the four switches persist through the settings file and survive a restart', () => {
  const file = path.join(tmp(), 'settings.json');
  const s = new JsonStore(file, SETTINGS_DEFAULTS);
  config.applyPatch(s.data.callbook, { enrich: { metadataOnNew: false, metadataOnUpload: true, gridOnNew: true, gridOnUpload: true } }, createSecretBox({}));
  s.saveNow();
  const again = new JsonStore(file, SETTINGS_DEFAULTS);
  migrateCallbook(again.data);
  assert.deepStrictEqual(again.data.callbook.enrich, { metadataOnNew: false, metadataOnUpload: true, gridOnNew: true, gridOnUpload: true });
});

test('Settings page: both categories, each with its own new-QSO and "On upload" switch, saved through callbook:save', () => {
  const src = read('src', 'renderer', 'pages', 'settings.js');
  assert.match(src, /Add Lookup Data to QSO Log Event/);
  assert.match(src, /Add Lookup Grid if QSO Grid is Missing/);
  for (const id of ['cb-meta-new', 'cb-meta-up', 'cb-grid-new', 'cb-grid-up']) assert.match(src, new RegExp(`'${id}'`), id);
  assert.strictEqual((src.match(/'On upload'/g) || []).length, 2, 'one "On upload" label per category');
  assert.strictEqual((src.match(/'On a new QSO'/g) || []).length, 2);
  assert.match(src, /Applies when a QSO is created or accepted/, 'new-QSO tooltip');
  assert.match(src, /Applies immediately before a queued QSO is uploaded/, 'upload tooltip');
  assert.match(src, /enrich: \{ metadataOnNew: \$\('#cb-meta-new'\)\.checked, metadataOnUpload: \$\('#cb-meta-up'\)\.checked, gridOnNew: \$\('#cb-grid-new'\)\.checked, gridOnUpload: \$\('#cb-grid-up'\)\.checked \}/);
});

// ---- providers return state / county / country ---------------------------------------------------------------------
function fakeFetch(handler) {
  const f = async (url, init = {}) => { const r = await handler({ url: String(url), body: init.body ? String(init.body) : '' }); return { status: r.status ?? 200, headers: { get: () => null }, text: async () => r.body }; };
  return f;
}
const CREDS = { username: 'u', password: 'p' };

test('QRZ lookup result includes state, county and country', async () => {
  const xml = '<QRZDatabase><Callsign><call>XX1ABC</call><fname>Pat</fname><addr2>Springfield</addr2><state>MA</state><county>Suffolk</county><country>United States</country><grid>FN42</grid></Callsign><Session><Key>K</Key></Session></QRZDatabase>';
  const p = new QrzProvider({ fetchImpl: fakeFetch(({ body }) => ({ body: new URLSearchParams(body).has('username') ? '<QRZDatabase><Session><Key>K</Key></Session></QRZDatabase>' : xml })) });
  const r = await p.lookup('XX1ABC', CREDS);
  assert.deepStrictEqual({ s: r.status, n: r.name, st: r.state, c: r.county, co: r.country, g: r.grid }, { s: 'ok', n: 'Pat', st: 'MA', c: 'Suffolk', co: 'United States', g: 'FN42' });
});

test('HamQTH lookup result includes state, county and country', async () => {
  const xml = '<HamQTH><search><callsign>xx1abc</callsign><nick>Pat</nick><country>Germany</country><us_state>MA</us_state><us_county>Suffolk</us_county><grid>JO62</grid></search></HamQTH>';
  const p = new HamQthProvider({ fetchImpl: fakeFetch(({ url }) => ({ body: new URL(url).searchParams.has('u') ? '<HamQTH><session><session_id>S</session_id></session></HamQTH>' : xml })) });
  const r = await p.lookup('XX1ABC', CREDS);
  assert.deepStrictEqual({ s: r.status, st: r.state, c: r.county, co: r.country, g: r.grid }, { s: 'ok', st: 'MA', c: 'Suffolk', co: 'Germany', g: 'JO62' });
});

// ---- shared merge rules ------------------------------------------------------------------------------------------------
test('missing means absent, null, empty or blank - never a falsy number or identifier', () => {
  for (const v of [undefined, null, '', ' ', '\t\n  ', NaN]) assert.ok(enrich.isMissing(v), JSON.stringify(v));
  for (const v of [0, '0', 'x', ' a ', false, 14.074, 'FN42']) assert.ok(!enrich.isMissing(v), JSON.stringify(v));
});

test('mergeLookup fills only missing fields of the allowed categories and never changes its input', () => {
  const input = { CALL: 'K1ABC', NAME: '  ', STATE: 'NH' };
  const frozen = clone(input);
  const meta = enrich.mergeLookup(input, ok('K1ABC'), ['metadata']);
  assert.deepStrictEqual(meta.fields, { CALL: 'K1ABC', NAME: 'Pat', STATE: 'NH', COUNTRY: 'United States' }, 'the lookup county is for MA, so it is not added to a contact whose state is NH');
  assert.deepStrictEqual(meta.filled.sort(), ['COUNTRY', 'NAME']);
  assert.ok(!('GRIDSQUARE' in meta.fields), 'grid is a different category');
  const grid = enrich.mergeLookup(input, ok('K1ABC'), ['grid']);
  assert.deepStrictEqual(grid.fields, { CALL: 'K1ABC', NAME: '  ', STATE: 'NH', GRIDSQUARE: 'FN42' });
  const both = enrich.mergeLookup(input, ok('K1ABC'), ['metadata', 'grid']);
  assert.strictEqual(both.fields.GRIDSQUARE, 'FN42');
  assert.strictEqual(both.fields.NAME, 'Pat');
  assert.deepStrictEqual(input, frozen);
});

test('mergeLookup never overwrites an existing value, and an empty or unusable lookup changes nothing', () => {
  const have = { CALL: 'K1ABC', NAME: 'Manual', STATE: 'VT', CNTY: 'VT,Orange', COUNTRY: 'Canada', GRIDSQUARE: 'FN33', STX: '0' };
  assert.deepStrictEqual(enrich.mergeLookup(have, ok('K1ABC'), ['metadata', 'grid']).fields, have);
  const empty = ok('K1ABC', {});
  assert.deepStrictEqual(enrich.mergeLookup(have, empty, ['metadata', 'grid']), { fields: have, filled: [] });
  for (const status of ['not_found', 'limited', 'offline', 'disabled', 'not_configured', 'invalid', 'auth_failed', 'rate_limited', 'unavailable', 'error']) {
    assert.deepStrictEqual(enrich.mergeLookup({ CALL: 'K1ABC' }, { ...ok('K1ABC'), status }, ['metadata', 'grid']).filled, [], status);
  }
  assert.deepStrictEqual(enrich.mergeLookup({ CALL: 'K1ABC' }, null, ['grid']).filled, []);
});

test('mergeLookup: a lookup grid must be a valid Maidenhead locator, and values are trimmed', () => {
  assert.strictEqual(enrich.mergeLookup({}, ok('K1ABC', { grid: 'not a grid' }), ['grid']).fields.GRIDSQUARE, undefined);
  assert.strictEqual(enrich.mergeLookup({}, ok('K1ABC', { grid: 'fn42ab' }), ['grid']).fields.GRIDSQUARE, 'FN42AB');
  assert.strictEqual(enrich.mergeLookup({}, ok('K1ABC', { name: '  Pat  ', state: 'ma' }), ['metadata']).fields.NAME, 'Pat');
  assert.strictEqual(enrich.mergeLookup({}, ok('K1ABC', { state: 'ma' }), ['metadata']).fields.STATE, 'MA');
});

test('county is saved as ST,County for United States contacts and left as given otherwise', () => {
  const us = enrich.mergeLookup({}, ok('K1ABC'), ['metadata']).fields;
  assert.strictEqual(us.CNTY, 'MA,Suffolk');
  const de = enrich.mergeLookup({}, ok('DL1ABC', { county: 'Bavaria', state: '', country: 'Germany' }), ['metadata']).fields;
  assert.strictEqual(de.CNTY, 'Bavaria');
  const known = enrich.mergeLookup({ COUNTRY: 'United States' }, ok('K1ABC', { state: 'NH', country: '', county: 'Orange' }), ['metadata']).fields;
  assert.strictEqual(known.CNTY, 'NH,Orange', 'uses the contact\'s own country when the lookup has none');
  assert.strictEqual(enrich.formatCounty('MA,Suffolk', 'MA', 'United States'), 'MA,Suffolk');
  const same = enrich.mergeLookup({ STATE: 'ma' }, ok('K1ABC'), ['metadata']).fields;
  assert.strictEqual(same.CNTY, 'MA,Suffolk', 'same state (any case): the county is added');
});

test('plan: no lookup when everything is off, everything is filled, or there is no usable callsign', () => {
  const mk = (sw) => new enrich.CallbookEnricher({ getSettings: () => mkSettings(sw), lookup: fakeLookup() });
  const empty = { CALL: 'K1ABC' };
  assert.strictEqual(mk({}).plan(empty, 'new'), null);
  assert.strictEqual(mk({ metadataOnNew: true, gridOnNew: true }).plan(empty, 'upload'), null, 'upload ignores the new-QSO switches');
  assert.strictEqual(mk({ metadataOnUpload: true, gridOnUpload: true }).plan(empty, 'new'), null, 'new ignores the upload switches');
  const full = { CALL: 'K1ABC', NAME: 'A', STATE: 'MA', CNTY: 'MA,X', COUNTRY: 'United States', GRIDSQUARE: 'FN42' };
  assert.strictEqual(mk({ metadataOnNew: true, gridOnNew: true }).plan(full, 'new'), null);
  assert.strictEqual(mk({ metadataOnNew: true, gridOnNew: true }).plan({ CALL: 'W1AW//P' }, 'new'), null);
  assert.strictEqual(mk({ metadataOnNew: true, gridOnNew: true }).plan({}, 'new'), null);
  // only the category that still has a gap is requested
  assert.deepStrictEqual(mk({ metadataOnNew: true, gridOnNew: true }).plan({ ...full, GRIDSQUARE: '' }, 'new'), { call: 'K1ABC', cats: ['grid'] });
  assert.deepStrictEqual(mk({ metadataOnNew: true, gridOnNew: true }).plan({ CALL: 'k1abc' }, 'new'), { call: 'K1ABC', cats: ['metadata', 'grid'] });
});

test('the four switches are independent: every combination enables exactly its own category and phase', () => {
  for (let bits = 0; bits < 16; bits++) {
    const sw = { metadataOnNew: !!(bits & 1), metadataOnUpload: !!(bits & 2), gridOnNew: !!(bits & 4), gridOnUpload: !!(bits & 8) };
    const e = new enrich.CallbookEnricher({ getSettings: () => mkSettings(sw), lookup: fakeLookup() });
    assert.deepStrictEqual(e.categories('new'), [sw.metadataOnNew && 'metadata', sw.gridOnNew && 'grid'].filter(Boolean), JSON.stringify(sw));
    assert.deepStrictEqual(e.categories('upload'), [sw.metadataOnUpload && 'metadata', sw.gridOnUpload && 'grid'].filter(Boolean), JSON.stringify(sw));
  }
});

// ---- new QSOs: addQsoWithLookup ------------------------------------------------------------------------------------------
const META = ['NAME', 'STATE', 'CNTY', 'COUNTRY'];
const has = (f, names) => names.every((n) => f[n]);
const hasNone = (f, names) => names.every((n) => !(n in f));

test('new QSO: metadata on, grid off fills only name, state, county and country', async () => {
  const { log, lookup } = mkLog({ sw: { metadataOnNew: true } });
  await log.addQsoWithLookup(BASE);
  const f = stored(log);
  assert.deepStrictEqual({ NAME: f.NAME, STATE: f.STATE, CNTY: f.CNTY, COUNTRY: f.COUNTRY }, { NAME: 'Pat', STATE: 'MA', CNTY: 'MA,Suffolk', COUNTRY: 'United States' });
  assert.ok(!('GRIDSQUARE' in f));
  assert.strictEqual(lookup.calls.length, 1);
});

test('new QSO: metadata off, grid on fills only the gridsquare', async () => {
  const { log, lookup } = mkLog({ sw: { gridOnNew: true } });
  await log.addQsoWithLookup(BASE);
  const f = stored(log);
  assert.strictEqual(f.GRIDSQUARE, 'FN42');
  assert.ok(hasNone(f, META));
  assert.strictEqual(lookup.calls.length, 1);
});

test('new QSO: both on fills both categories from one lookup; both off does no lookup at all', async () => {
  const both = mkLog({ sw: { metadataOnNew: true, gridOnNew: true } });
  await both.log.addQsoWithLookup(BASE);
  assert.ok(has(stored(both.log), [...META, 'GRIDSQUARE']));
  assert.strictEqual(both.lookup.calls.length, 1, 'one lookup serves both categories');
  const off = mkLog({ sw: {} });
  await off.log.addQsoWithLookup(BASE);
  assert.ok(hasNone(stored(off.log), [...META, 'GRIDSQUARE']));
  assert.strictEqual(off.lookup.calls.length, 0);
});

test('the upload switches do nothing for a new QSO, and the new-QSO switches do nothing at upload', async () => {
  const up = mkLog({ sw: { metadataOnUpload: true, gridOnUpload: true } });
  await up.log.addQsoWithLookup(BASE);
  assert.ok(hasNone(stored(up.log), [...META, 'GRIDSQUARE']));
  assert.strictEqual(up.lookup.calls.length, 0);
});

test('new QSO: existing values are never overwritten, blanks count as missing, and an empty lookup clears nothing', async () => {
  const { log } = mkLog({ sw: { metadataOnNew: true, gridOnNew: true }, lookup: fakeLookup(() => ok('K1ABC', { name: 'Looked', state: 'MA', county: 'Suffolk', country: 'United States', grid: 'FN42' })) });
  await log.addQsoWithLookup({ ...BASE, name: 'Typed', gridsquare: 'jo62', state: '   ', country: '' });
  const f = stored(log);
  assert.strictEqual(f.NAME, 'Typed');
  assert.strictEqual(f.GRIDSQUARE, 'jo62', 'the operator\'s own grid is left exactly as entered');
  assert.strictEqual(f.STATE, 'MA', 'whitespace-only state is missing');
  assert.strictEqual(f.COUNTRY, 'United States', 'empty country is missing');
  const empty = mkLog({ sw: { metadataOnNew: true, gridOnNew: true }, lookup: fakeLookup(ok('K1ABC', {})) });
  await empty.log.addQsoWithLookup({ ...BASE, name: 'Typed', state: 'NH' });
  assert.strictEqual(stored(empty.log).NAME, 'Typed');
  assert.strictEqual(stored(empty.log).STATE, 'NH');
  assert.ok(!('COUNTRY' in stored(empty.log)));
});

test('new QSO: nothing is looked up when every allowed field is already filled, or the callsign is unusable', async () => {
  const { log, lookup } = mkLog({ sw: { metadataOnNew: true, gridOnNew: true } });
  await log.addQsoWithLookup({ ...BASE, name: 'A', state: 'MA', cnty: 'MA,Suffolk', country: 'United States', gridsquare: 'FN42' });
  await log.addQsoWithLookup({ ...BASE, call: 'W1AW//P' });
  assert.strictEqual(lookup.calls.length, 0);
  assert.strictEqual(log.localList().length, 2);
});

test('new QSO: lookup failures, odd results and slow providers never stop the QSO being logged', async () => {
  const cases = {
    throws: fakeLookup(() => { throw new Error('boom https://x/?p=secret'); }),
    rejects: fakeLookup(() => Promise.reject(new Error('nope'))),
    unavailable: fakeLookup({ ...ok('K1ABC', {}), status: 'unavailable', message: 'down' }),
    authFailed: fakeLookup({ ...ok('K1ABC', {}), status: 'auth_failed' }),
    nothing: fakeLookup(null),
    junk: fakeLookup('text'),
  };
  for (const [name, lookup] of Object.entries(cases)) {
    const { log } = mkLog({ sw: { metadataOnNew: true, gridOnNew: true }, lookup });
    const rec = await log.addQsoWithLookup(BASE);
    assert.ok(rec && rec.id, name);
    assert.deepStrictEqual(Object.keys(stored(log)).filter((k) => [...META, 'GRIDSQUARE'].includes(k)), [], name);
  }
  const slow = mkLog({ sw: { metadataOnNew: true }, lookup: fakeLookup(() => new Promise(() => {})), budget: 30 });
  const t0 = Date.now();
  await slow.log.addQsoWithLookup(BASE);
  assert.ok(Date.now() - t0 < 2000, 'a QSO waits only a bounded time for a lookup');
  assert.strictEqual(slow.log.localList().length, 1);
});

test('new QSO: validation errors still reject the QSO, before any lookup', async () => {
  const { log, lookup } = mkLog({ sw: { metadataOnNew: true } });
  await assert.rejects(() => log.addQsoWithLookup({ ...BASE, call: 'NOPE' }), /does not look like a callsign/);
  await assert.rejects(() => log.addQsoWithLookup({ ...BASE, mode: '' }), /Mode is required/);
  assert.strictEqual(lookup.calls.length, 0);
  assert.strictEqual(log.localList().length, 0);
});

test('new QSO: timestamps are never touched by enrichment (incoming contacts keep theirs)', async () => {
  const { log } = mkLog({ sw: { metadataOnNew: true, gridOnNew: true } });
  await log.addQsoWithLookup({ ...BASE, qso_date: '20240229', time_on: '2359', time_off: '0001' });
  const f = stored(log);
  assert.deepStrictEqual({ d: f.QSO_DATE, on: f.TIME_ON, off: f.TIME_OFF }, { d: '20240229', on: '235900', off: '0001' });
});

test('incoming duplicates are dropped before a lookup is spent on them', async () => {
  const { log, lookup } = mkLog({ sw: { metadataOnNew: true } });
  assert.ok(await log.addQsoWithLookup(BASE, { source: 'ADIF UDP', dedupe: true }));
  assert.strictEqual(await log.addQsoWithLookup(BASE, { source: 'ADIF UDP', dedupe: true }), null);
  assert.strictEqual(lookup.calls.length, 1);
  assert.strictEqual(log.localList().length, 1);
  // two identical records arriving while the first lookup is still running: only one is stored
  const gate = deferred();
  const slow = mkLog({ sw: { metadataOnNew: true }, lookup: fakeLookup(async () => { await gate.promise; return ok('K1ABC'); }) });
  const a = slow.log.addQsoWithLookup(BASE, { dedupe: true }); const b = slow.log.addQsoWithLookup(BASE, { dedupe: true });
  await settle(); gate.resolve();
  assert.deepStrictEqual([!!(await a), !!(await b)].sort(), [false, true]);
  assert.strictEqual(slow.log.localList().length, 1);
});

test('a lookup without an enricher configured leaves addQso / addQsoWithLookup exactly as before', async () => {
  const log = new LogService({ dir: tmp(), client: { configured: () => false }, getSettings: () => mkSettings({ metadataOnNew: true }) });
  const rec = await log.addQsoWithLookup(BASE);
  assert.ok(rec.id);
  assert.deepStrictEqual(Object.keys(stored(log)).sort(), Object.keys(log.normalize(BASE)).sort());
});

// ---- the five new-contact paths --------------------------------------------------------------------------------------------
test('main process: Live QSO and TCP, UDP, multicast store through the lookup path; Quick log and Contest do not', () => {
  const main = read('src', 'main', 'main.js');
  assert.match(main, /'qso:add': async \(fields, opts = \{\}\) => \{\s*const rec = await storeFormQso\(log, fields, opts\.source \|\| 'manual'\)/);
  assert.match(main, /ingestRecords\(log, recs, source\)/);
  assert.ok(!/log\.addQso\(/.test(main), 'no path may bypass the shared enrichment');
  assert.match(main, /new LogService\(\{[^}]*enricher: callbookEnricher/);
  assert.match(main, /migrateCallbook\(settings\.data\)/);
  assert.match(read('src', 'main', 'ingest.js'), /log\.addQsoWithLookup\(r, \{ source, dedupe: true \}\)/);
});

test('TCP, UDP and multicast contacts are enriched (and keep their own values) through the real listeners', async () => {
  const { log, settings, lookup } = mkLog({ sw: { metadataOnNew: true, gridOnNew: true } });
  const [tcpPort, udpPort] = [await freePort(), await freePort()];
  settings.adifServer = { enabled: true, bind: '127.0.0.1', tcp: true, tcpPort, udp: true, udpPort, multicast: { enabled: false, address: '224.0.0.1', port: 2237, interface: 'loopback' } };
  const server = new AdifServer({ getSettings: () => settings });
  const work = [];
  server.on('records', (recs, source) => { work.push(ingestRecords(log, recs, source)); });
  await server.apply();
  try {
    const adif = (call, extra = '') => `<call:${call.length}>${call} <mode:3>FT8 <band:3>20m <qso_date:8>20261012 <time_on:6>120000 ${extra}<eor>`;
    await new Promise((res) => { const s = net.connect(tcpPort, '127.0.0.1', () => { s.end(adif('K1TCP')); }); s.on('close', res); });
    const udp = dgram.createSocket('udp4');
    await new Promise((res) => udp.send(Buffer.from(adif('K1UDP', '<name:6>Manual ')), udpPort, '127.0.0.1', res));
    udp.close();
    server.mc.emit('adif', adif('K1MCS'));
    await until(() => work.length === 3);
    await Promise.all(work);
    const byCall = Object.fromEntries(log.localList().map((r) => [r.fields.CALL, r]));
    assert.deepStrictEqual(Object.keys(byCall).sort(), ['K1MCS', 'K1TCP', 'K1UDP']);
    assert.deepStrictEqual(Object.values(byCall).map((r) => r.source).sort(), ['ADIF UDP', 'ADIF socket', 'WSJT-X multicast']);
    for (const r of Object.values(byCall)) {
      assert.strictEqual(r.fields.GRIDSQUARE, 'FN42', r.fields.CALL);
      assert.strictEqual(r.fields.QSO_DATE, '20261012');
      assert.strictEqual(r.fields.TIME_ON, '120000');
    }
    assert.strictEqual(byCall.K1UDP.fields.NAME, 'Manual', 'a value that arrived with the contact is not replaced');
    assert.strictEqual(byCall.K1TCP.fields.NAME, 'Pat');
    assert.strictEqual(byCall.K1MCS.fields.COUNTRY, 'United States');
    assert.strictEqual(lookup.calls.length, 3);
  } finally { await server.stop(); }
});

test('ingestRecords: one bad record is reported and the rest are still stored, in order', async () => {
  const { log } = mkLog({ sw: { metadataOnNew: true } });
  const recs = [{ CALL: 'K1AAA', MODE: 'FT8', BAND: '20m', QSO_DATE: '20261012', TIME_ON: '120000' }, { CALL: 'BAD', MODE: 'FT8', BAND: '20m' }, { CALL: 'K1BBB', MODE: 'FT8', BAND: '20m', QSO_DATE: '20261012', TIME_ON: '120100' }];
  const r = await ingestRecords(log, recs, 'ADIF socket');
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0], /^BAD:/);
  assert.deepStrictEqual(log.localList().map((x) => x.fields.CALL).sort(), ['K1AAA', 'K1BBB']);
});

// ---- upload-time enrichment -------------------------------------------------------------------------------------------------
async function uploadEnv({ sw = {}, lookup = fakeLookup(), serverUp = true } = {}) {
  const m = serverUp ? await mock.start(0) : null;
  const port = m ? m.port : await freePort();
  const settings = mkSettings(sw);
  settings.cloudlog = { url: `http://127.0.0.1:${port}`, apiKey: 'abc123', urlStyle: 'auto', currentStationId: '1', stations: [] };
  const client = new CloudlogClient(() => settings.cloudlog);
  const dir = tmp();
  const dbFile = path.join(dir, 'q.sqlite3');
  const mk = () => new LogService({ dir, dbFile, client, getSettings: () => settings, enricher: new enrich.CallbookEnricher({ getSettings: () => settings, lookup }) });
  return { m, port, settings, lookup, dir, dbFile, client, mk, log: mk() };
}

test('upload: the switches work with the new-QSO switches off, and the payload carries what was found', async () => {
  const env = await uploadEnv({ sw: { metadataOnUpload: true, gridOnUpload: true } });
  try {
    await env.log.addQsoWithLookup(BASE);
    assert.strictEqual(env.lookup.calls.length, 0, 'saving did not look anything up (new-QSO switches are off)');
    await env.log.sync();
    assert.strictEqual(env.lookup.calls.length, 1);
    const sent = env.m.state.qsos[0].f;
    assert.deepStrictEqual({ n: sent.NAME, s: sent.STATE, c: sent.CNTY, co: sent.COUNTRY, g: sent.GRIDSQUARE }, { n: 'Pat', s: 'MA', c: 'MA,Suffolk', co: 'United States', g: 'FN42' });
  } finally { env.log.stop(); await env.m.close(); }
});

test('upload: a QSO saved before the switches existed (no enricher, nothing stored) is enriched when it uploads', async () => {
  const env = await uploadEnv({});
  try {
    const old = new LogService({ dir: env.dir, dbFile: env.dbFile, client: env.client, getSettings: () => env.settings }); // the pre-0.4.3 shape
    old.addQso(BASE);
    old.stop();
    env.settings.callbook.enrich.metadataOnUpload = true;
    const log = env.mk();
    await log.sync();
    assert.strictEqual(env.m.state.qsos[0].f.NAME, 'Pat');
    assert.ok(!('GRIDSQUARE' in env.m.state.qsos[0].f), 'only the enabled category is added');
    log.stop();
  } finally { await env.m.close(); }
});

test('upload: what was found is saved on the local QSO, not only sent', async () => {
  const env = await uploadEnv({ sw: { metadataOnUpload: true, gridOnUpload: true } });
  try {
    env.log.addQso(BASE);
    await env.log.sync();
    const [row] = env.log.localList(['synced']);
    assert.ok(has(row.fields, [...META, 'GRIDSQUARE']));
    assert.strictEqual(row.state, 'synced');
    assert.strictEqual(row.fields.TIME_ON, '120000', 'nothing else on the QSO changed');
  } finally { env.log.stop(); await env.m.close(); }
});

test('upload: a failed upload keeps the discovered values locally, across a restart, and the retry sends them once', async () => {
  const env = await uploadEnv({ sw: { metadataOnUpload: true, gridOnUpload: true }, serverUp: false });
  env.log.addQso({ ...BASE, name: 'Manual' });
  await env.log.sync(); // nothing is listening: upload fails
  assert.strictEqual(env.log.status().pending, 1);
  assert.strictEqual(env.lookup.calls.length, 1);
  const [pending] = env.log.localList(['pending']);
  assert.strictEqual(pending.fields.NAME, 'Manual', 'existing value untouched');
  assert.ok(has(pending.fields, ['STATE', 'CNTY', 'COUNTRY', 'GRIDSQUARE']), 'found values are stored although the upload failed');
  env.log.stop();

  const log2 = env.mk(); // "restart": a new service on the same database file
  assert.ok(has(log2.localList(['pending'])[0].fields, ['STATE', 'CNTY', 'COUNTRY', 'GRIDSQUARE']));
  const m = await mock.start(env.port);
  try {
    await log2.sync();
    await log2.sync(); // a further sync finds nothing left to send
    assert.strictEqual(m.state.qsos.length, 1, 'no duplicate contact');
    assert.strictEqual(m.state.qsos[0].f.NAME, 'Manual');
    assert.strictEqual(m.state.qsos[0].f.GRIDSQUARE, 'FN42');
    assert.strictEqual(env.lookup.calls.length, 1, 'the retry used what was stored; no new lookup');
  } finally { log2.stop(); await m.close(); }
});

test('upload: both categories needing data share one lookup', async () => {
  const env = await uploadEnv({ sw: { metadataOnUpload: true, gridOnUpload: true } });
  try {
    env.log.addQso(BASE); env.log.addQso({ ...BASE, call: 'K2XYZ' });
    await env.log.sync();
    assert.deepStrictEqual(env.lookup.calls.sort(), ['K1ABC', 'K2XYZ'], 'one lookup per contact, not per category');
  } finally { env.log.stop(); await env.m.close(); }
});

test('upload: no lookup when both upload switches are off, everything is filled, or there is no usable callsign', async () => {
  const off = await uploadEnv({ sw: { metadataOnNew: true, gridOnNew: true } });
  try { off.log.addQso(BASE); await off.log.sync(); assert.strictEqual(off.lookup.calls.length, 0); assert.strictEqual(off.m.state.qsos.length, 1); } finally { off.log.stop(); await off.m.close(); }
  const full = await uploadEnv({ sw: { metadataOnUpload: true, gridOnUpload: true } });
  try {
    full.log.addQso({ ...BASE, name: 'A', state: 'MA', cnty: 'MA,X', country: 'United States', gridsquare: 'FN42' });
    await full.log.sync();
    assert.strictEqual(full.lookup.calls.length, 0);
    assert.strictEqual(full.m.state.qsos.length, 1);
  } finally { full.log.stop(); await full.m.close(); }
  const bad = await uploadEnv({ sw: { metadataOnUpload: true, gridOnUpload: true } });
  try { bad.log.addQso({ ...BASE, call: 'W1AW//P' }); await bad.log.sync(); assert.strictEqual(bad.lookup.calls.length, 0); assert.strictEqual(bad.m.state.qsos.length, 1); } finally { bad.log.stop(); await bad.m.close(); }
  const gridOnly = await uploadEnv({ sw: { gridOnUpload: true } });
  try { gridOnly.log.addQso({ ...BASE, gridsquare: 'FN42' }); await gridOnly.log.sync(); assert.strictEqual(gridOnly.lookup.calls.length, 0, 'metadata is missing but not allowed on upload'); } finally { gridOnly.log.stop(); await gridOnly.m.close(); }
});

test('upload: lookup trouble never stops the upload, and nothing existing is changed', async () => {
  for (const [name, lookup] of Object.entries({ throws: fakeLookup(() => { throw new Error('x'); }), unavailable: fakeLookup({ ...ok('K1ABC', {}), status: 'unavailable' }), empty: fakeLookup(ok('K1ABC', {})) })) {
    const env = await uploadEnv({ sw: { metadataOnUpload: true, gridOnUpload: true }, lookup });
    try {
      env.log.addQso({ ...BASE, name: 'Manual' });
      await env.log.sync();
      assert.strictEqual(env.m.state.qsos.length, 1, name);
      assert.strictEqual(env.m.state.qsos[0].f.NAME, 'Manual', name);
      assert.strictEqual(env.log.status().pending, 0, name);
    } finally { env.log.stop(); await env.m.close(); }
  }
});

test('upload: a slow lookup never overwrites an edit made meanwhile, and is dropped if the callsign changed or the QSO was removed', async () => {
  const gate = deferred();
  const env = await uploadEnv({ sw: { metadataOnUpload: true, gridOnUpload: true }, lookup: fakeLookup(async () => { await gate.promise; return ok('K1ABC', { name: 'Looked Up', state: 'MA', grid: 'FN42' }); }) });
  try {
    const rec = env.log.addQso(BASE);
    const running = env.log.sync();
    await until(() => env.lookup.calls.length === 1);
    env.log.updateLocal(rec.id, { NAME: 'Edited Meanwhile' }); // the operator edits the queued QSO while the lookup is out
    gate.resolve();
    await running;
    const sent = env.m.state.qsos[0].f;
    assert.strictEqual(sent.NAME, 'Edited Meanwhile');
    assert.strictEqual(sent.STATE, 'MA', 'still-missing fields are filled');
  } finally { env.log.stop(); await env.m.close(); }

  const gate2 = deferred();
  const env2 = await uploadEnv({ sw: { metadataOnUpload: true }, lookup: fakeLookup(async () => { await gate2.promise; return ok('K1ABC'); }) });
  try {
    const rec = env2.log.addQso(BASE);
    const running = env2.log.sync();
    await until(() => env2.lookup.calls.length === 1);
    env2.log.updateLocal(rec.id, { CALL: 'W2NEW' });
    gate2.resolve();
    await running;
    assert.strictEqual(env2.m.state.qsos[0].f.CALL, 'W2NEW');
    assert.ok(!('NAME' in env2.m.state.qsos[0].f), 'data for the old callsign is not applied to the new one');
  } finally { env2.log.stop(); await env2.m.close(); }

  const gate3 = deferred();
  const env3 = await uploadEnv({ sw: { metadataOnUpload: true }, lookup: fakeLookup(async () => { await gate3.promise; return ok('K1ABC'); }) });
  try {
    const rec = env3.log.addQso(BASE);
    const running = env3.log.sync();
    await until(() => env3.lookup.calls.length === 1);
    env3.log.deleteLocal(rec.id);
    gate3.resolve();
    await running;
    assert.strictEqual(env3.m.state.qsos.length, 0);
    assert.strictEqual(env3.log.localList().length, 0, 'a removed QSO is not brought back');
  } finally { env3.log.stop(); await env3.m.close(); }
});

test('upload: "Work offline" holds uploads, so no lookup is made either', async () => {
  const env = await uploadEnv({ sw: { metadataOnUpload: true } });
  try {
    env.settings.sync.paused = true;
    env.log.addQso(BASE);
    await env.log.sync();
    assert.strictEqual(env.lookup.calls.length, 0);
    assert.strictEqual(env.m.state.qsos.length, 0);
  } finally { env.log.stop(); await env.m.close(); }
});

// ---- Live QSO / Quick log in the real renderer scripts ---------------------------------------------------------------------------
class FakeEl {
  constructor(tag = 'div', props = {}) {
    Object.assign(this, { tagName: tag.toUpperCase(), value: '', checked: false, textContent: '', className: '', placeholder: '', innerHTML: '', parent: null, dataset: {}, style: { removeProperty() {} }, children: [] }, props);
    this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }

  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { const l = this.listeners.get(type); const i = l ? l.indexOf(fn) : -1; if (i >= 0) l.splice(i, 1); }
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
  set innerHTML(v) { this._html = String(v); if (this.doc) this.doc.elements.clear(); }
}
class FakeDocument {
  constructor() {
    this.elements = new Map(); this.activeElement = null;
    this.root = new FakeRoot(this); this.root.ownerDoc = this;
    this.toasts = [];
    this.toastBox = this.make('div'); this.toastBox.appendChild = (c) => { this.toasts.push(c); return c; };
    this.body = this.make('body'); this.documentElement = this.make('html');
  }

  make(tag, props) { const e = new FakeEl(tag, props); e.ownerDoc = this; return e; }
  createElement(tag) { return this.make(tag); }
  querySelector(sel) { return this.query(sel); }
  querySelectorAll() { return []; }
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

  cached(key, build) { if (!this.elements.has(key)) { const e = build(); if (!e) return null; this.elements.set(key, e); } return this.elements.get(key); }
}

/**
 * The real renderer scripts in a vm context with a controllable clock (`h.now`, UTC ms). `qso:add` does what main.js does:
 * it stores the QSO through storeFormQso, so the whole form -> (lookup) -> storage path runs.
 */
function rendererHarness({ sw = {}, lookup = fakeLookup(), now = Date.UTC(2026, 9, 12, 14, 30, 0) } = {}) {
  const env = mkLog({ sw, lookup });
  const { log, settings } = env;
  settings.cloudlog.stations = [{ id: '1', name: 'Home', callsign: 'W1AW', grid: 'FN31', active: true }];
  const doc = new FakeDocument();
  const timers = new Set();
  const calls = [];
  const handlers = {
    'qso:add': async (fields, opts = {}) => { const rec = await storeFormQso(log, fields, opts.source || 'manual'); return { id: rec.id, call: rec.fields.CALL }; },
    'qso:workedBefore': () => ({ count: 0, bands: [], recent: [], last: null }),
    'log:stats': () => ({ recent: [] }),
    'callbook:lookup': (call) => lookup(call),
    'settings:set': () => undefined,
    'external:profile': () => true,
  };
  const ctx = {
    document: doc, console, Event: class { constructor(type) { this.type = type; } },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); timers.add(t); return t; },
    clearTimeout: (t) => { clearTimeout(t); timers.delete(t); },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); timers.add(t); return t; },
    clearInterval: (t) => { clearInterval(t); timers.delete(t); },
  };
  ctx.window = ctx;
  ctx.cl = { on() {}, call: async (name, ...args) => { calls.push({ name, args }); const h = handlers[name]; if (!h) throw new Error(`Unmocked call ${name}`); return h(...args); } };
  vm.createContext(ctx);
  // Replace Date inside the page's world with one that reads the test's clock.
  ctx.__now = now;
  vm.runInContext('(() => { const R = Date; class D extends R { constructor(...a) { if (a.length === 0) super(globalThis.__now); else super(...a); } static now() { return globalThis.__now; } } globalThis.Date = D; })()', ctx);
  for (const f of ['callbook-shared.js', 'page-guards.js', 'util.js', 'pages/live.js', 'pages/quick.js']) vm.runInContext(read('src', 'renderer', f), ctx, { filename: f });
  const App = ctx.App;
  Object.assign(App.state, { settings: clone(settings), rig: null, info: { bands: BAND_NAMES, modes: MODES, contests: CONTESTS, version: '0.0.0' } });
  const h = {
    ...env, doc, App, calls, current: null,
    get now() { return ctx.__now; },
    set now(v) { ctx.__now = v; },
    el: (id) => doc.query(`#${id}`),
    go(name) { if (h.current) App.pages[h.current].unmount?.(); h.current = name; doc.root.innerHTML = ''; App.pages[name].mount(doc.root); },
    tick() { App.pages[h.current].tick(); },
    /** Typing: sets the value and fires the field's own "input" event, like the browser does. */
    type(id, v) { const e = doc.query(`#${id}`); assert.ok(e, id); e.value = v; e.dispatchBubbling({ type: 'input', target: e }); },
    enter(id) {
      const target = doc.query(`#${id}`);
      target.dispatchBubbling({ type: 'keydown', key: 'Enter', target, repeat: false, isComposing: false, preventDefault() {} });
    },
    close() { if (h.current) App.pages[h.current].unmount?.(); h.current = null; for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.clear(); },
  };
  return h;
}
const withRenderer = (opts, fn) => async () => { const h = rendererHarness(opts); try { await fn(h); } finally { h.close(); h.log.stop(); } };
const T0 = Date.UTC(2026, 9, 12, 14, 30, 0);
const clockText = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };
const shown = (h) => `${h.el('f-date').value} ${h.el('f-time').value}`;

test('Live QSO: the displayed time keeps advancing while a callsign is typed, changed or cleared, and while other fields are edited', withRenderer({}, async (h) => {
  h.go('live');
  assert.strictEqual(shown(h), clockText(T0));
  h.type('f-call', 'K');
  h.now = T0 + 5000; h.tick();
  assert.strictEqual(shown(h), clockText(T0 + 5000), 'first character typed: clock still runs');
  h.type('f-call', 'K1ABC');
  h.now = T0 + 9000; h.tick();
  assert.strictEqual(shown(h), clockText(T0 + 9000));
  h.type('f-call', 'W2XYZ');
  h.now = T0 + 12000; h.tick();
  assert.strictEqual(shown(h), clockText(T0 + 12000), 'callsign changed');
  h.type('f-name', 'Sam'); h.type('f-comment', 'hello'); h.type('f-grid', 'FN31');
  h.now = T0 + 15000; h.tick();
  assert.strictEqual(shown(h), clockText(T0 + 15000), 'other fields edited');
  h.type('f-call', '');
  h.now = T0 + 20000; h.tick();
  assert.strictEqual(shown(h), clockText(T0 + 20000), 'callsign cleared');
}));

test('Live QSO: the QSO is stamped when it is submitted, not when the first callsign character was typed', withRenderer({}, async (h) => {
  h.go('live');
  h.now = T0 + 1000; h.tick();
  h.type('f-call', 'K1ABC'); // typed at 14:30:01
  h.now = T0 + 95000; // no tick between: the submission itself must read the clock
  h.enter('f-call');
  await settle();
  const f = h.log.localList()[0].fields;
  assert.deepStrictEqual({ d: f.QSO_DATE, t: f.TIME_ON, off: f.TIME_OFF }, { d: '20261012', t: '143135', off: '143135' });
}));

test('Live QSO: a slow lookup / save cannot change the captured submission time, and the page keeps working meanwhile', withRenderer({ sw: { metadataOnNew: true, gridOnNew: true } }, async (h) => {
  const gate = deferred();
  const slowLookup = fakeLookup(async () => { await gate.promise; return ok('K1ABC'); });
  h.enricher.lookup = slowLookup;
  h.go('live');
  h.type('f-call', 'K1ABC');
  h.now = T0 + 60000;
  h.enter('f-call'); // submitted at 14:31:00
  await settle();
  assert.strictEqual(slowLookup.calls.length, 1, 'the save is waiting on the lookup');
  assert.strictEqual(h.log.localList().length, 0);
  h.now = T0 + 300000; // five minutes pass before the lookup answers
  gate.resolve();
  await settle();
  const f = h.log.localList()[0].fields;
  assert.deepStrictEqual({ t: f.TIME_ON, name: f.NAME, grid: f.GRIDSQUARE }, { t: '143100', name: 'Pat', grid: 'FN42' });
}));

test('Live QSO: date and time come from one reading, so UTC midnight cannot split them', withRenderer({ sw: { metadataOnNew: true } }, async (h) => {
  const gate = deferred();
  h.enricher.lookup = fakeLookup(async () => { await gate.promise; return ok('K1ABC'); });
  h.now = Date.UTC(2026, 9, 12, 23, 59, 59, 900);
  h.go('live');
  h.type('f-call', 'K1ABC');
  h.enter('f-call');
  h.now = Date.UTC(2026, 9, 13, 0, 0, 2); // midnight passes while the lookup is out
  await settle();
  gate.resolve();
  await settle();
  const f = h.log.localList()[0].fields;
  assert.deepStrictEqual({ d: f.QSO_DATE, t: f.TIME_ON }, { d: '20261012', t: '235959' });
  // and a submission just after midnight is wholly the new day
  h.type('f-call', 'K2XYZ'); h.now = Date.UTC(2026, 9, 13, 0, 0, 3);
  h.enricher.lookup = fakeLookup(ok('K2XYZ', {}));
  h.enter('f-call');
  await settle();
  const g = h.log.localList().find((r) => r.fields.CALL === 'K2XYZ').fields;
  assert.deepStrictEqual({ d: g.QSO_DATE, t: g.TIME_ON }, { d: '20261013', t: '000003' });
}));

test('Live QSO: after a save the clock follows the time again for the next QSO', withRenderer({}, async (h) => {
  h.go('live');
  h.type('f-call', 'K1ABC'); h.now = T0 + 10000; h.enter('f-call'); await settle();
  h.now = T0 + 70000; h.tick();
  assert.strictEqual(shown(h), clockText(T0 + 70000));
  h.type('f-call', 'K2XYZ'); h.now = T0 + 80000; h.enter('f-call'); await settle();
  assert.deepStrictEqual(h.log.localList().map((r) => r.fields.TIME_ON).sort(), ['143010', '143120']);
}));

test('Live QSO: a date or time the operator typed (manual / historical QSO) is logged as typed, whatever the clock says', withRenderer({}, async (h) => {
  h.go('live');
  h.type('f-call', 'K1ABC');
  h.type('f-date', '2025-01-02'); h.type('f-time', '03:04'); // typing into the field switches the clock off
  h.now = T0 + 600000; h.tick();
  assert.strictEqual(h.el('f-date').value, '2025-01-02', 'the clock leaves a manually edited field alone');
  h.enter('f-call'); await settle();
  const f = h.log.localList()[0].fields;
  assert.deepStrictEqual({ d: f.QSO_DATE, t: f.TIME_ON }, { d: '20250102', t: '030400' });
  // an invalid manual value is still refused, as before
  h.type('f-call', 'K2XYZ'); h.type('f-time', 'nope'); h.enter('f-call'); await settle();
  assert.strictEqual(h.log.localList().length, 1);
  assert.ok(h.doc.toasts.some((t) => /Time must look like/.test(t.textContent)));
}));

test('Live QSO: Name/QTH and Grid pre-fill follow the new-QSO switches; nothing is offered when both are off', async () => {
  for (const [sw, want] of [[{ metadataOnNew: true }, { name: 'Pat', grid: '' }], [{ gridOnNew: true }, { name: '', grid: 'FN42' }], [{ metadataOnNew: true, gridOnNew: true }, { name: 'Pat', grid: 'FN42' }], [{}, { name: '', grid: '' }]]) {
    const h = rendererHarness({ sw, lookup: fakeLookup(ok('K1ABC', { name: 'Pat', grid: 'FN42', qth: 'Springfield' })) });
    h.App.state.settings.callbook = { enrich: { ...SW, ...sw } };
    try {
      h.go('live');
      h.type('f-call', 'K1ABC');
      h.el('f-call').dispatchBubbling({ type: 'blur', target: h.el('f-call') });
      await settle();
      assert.deepStrictEqual({ name: h.el('f-name').value, grid: h.el('f-grid').value }, want, JSON.stringify(sw));
      assert.strictEqual(h.el('f-qth').value, sw.metadataOnNew ? 'Springfield' : '', 'QTH follows the metadata switch');
    } finally { h.close(); h.log.stop(); }
  }
});

test('Live QSO is looked up as it is logged; Quick log is stored as entered and is enriched at upload instead', withRenderer({ sw: { metadataOnNew: true, gridOnNew: true } }, async (h) => {
  h.go('live');
  h.type('f-call', 'K1LIV'); h.type('f-name', 'Typed Name');
  h.enter('f-call'); await settle();
  assert.deepStrictEqual(h.lookup.calls, ['K1LIV']);
  h.go('quick');
  h.type('q-call', 'K1QCK');
  h.enter('q-call'); await settle();
  assert.deepStrictEqual(h.lookup.calls, ['K1LIV'], 'Quick log made no lookup');
  const by = Object.fromEntries(h.log.localList().map((r) => [r.fields.CALL, r]));
  assert.strictEqual(by.K1LIV.source, 'Live QSO');
  assert.strictEqual(by.K1LIV.fields.NAME, 'Typed Name');
  assert.strictEqual(by.K1LIV.fields.GRIDSQUARE, 'FN42');
  assert.strictEqual(by.K1LIV.fields.COUNTRY, 'United States');
  assert.strictEqual(by.K1QCK.source, 'Quick log');
  assert.ok(hasNone(by.K1QCK.fields, [...META, 'GRIDSQUARE']), 'nothing added to a Quick log QSO when it is logged');
}));

test('Contest entries, like Quick log, are stored without a lookup', async () => {
  const { log, lookup } = mkLog({ sw: { metadataOnNew: true, gridOnNew: true } });
  await storeFormQso(log, { ...BASE, call: 'K1CON' }, 'Contest');
  await storeFormQso(log, { ...BASE, call: 'K1QCK' }, 'Quick log');
  assert.strictEqual(lookup.calls.length, 0);
  assert.strictEqual(log.localList().length, 2);
});

test('a Quick log QSO is enriched when it uploads, with the "On upload" switches', async () => {
  const env = await uploadEnv({ sw: { metadataOnNew: true, gridOnNew: true, metadataOnUpload: true, gridOnUpload: true } });
  try {
    await storeFormQso(env.log, { ...BASE, call: 'K1QCK' }, 'Quick log');
    assert.strictEqual(env.lookup.calls.length, 0, 'logging it looked nothing up');
    await env.log.sync();
    assert.deepStrictEqual(env.lookup.calls, ['K1QCK']);
    const sent = env.m.state.qsos[0].f;
    assert.deepStrictEqual({ n: sent.NAME, g: sent.GRIDSQUARE, c: sent.COUNTRY }, { n: 'Pat', g: 'FN42', c: 'United States' });
    assert.strictEqual(env.log.localList(['synced'])[0].fields.NAME, 'Pat', 'and it is kept on the local QSO');
  } finally { env.log.stop(); await env.m.close(); }
});

test('Quick log keeps supplying its own timestamp: this release does not change it', withRenderer({}, async (h) => {
  h.go('quick');
  h.now = T0 + 1000; h.tick();
  h.type('q-call', 'K1ABC'); // Quick log has always stamped from the moment the callsign is entered
  h.now = T0 + 90000;
  h.enter('q-call'); await settle();
  const f = h.log.localList()[0].fields;
  assert.deepStrictEqual({ d: f.QSO_DATE, t: f.TIME_ON }, { d: '20261012', t: '143001' });
  const quick = read('src', 'renderer', 'pages', 'quick.js');
  assert.match(quick, /if \(v\) time\.freeze\(\); else time\.reset\(\);/);
  const live = read('src', 'renderer', 'pages', 'live.js');
  assert.ok(!/time\.freeze\(\)/.test(live), 'Live QSO no longer freezes the clock');
}));

