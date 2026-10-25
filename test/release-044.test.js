'use strict';
/*
 * Release 0.4.4: Logbook Collections (named aggregators of existing logbooks), the separate "Active collection"
 * setting, and the Dashboard / Logbooks-page / Queued-QSOs integration.
 *
 * Main-process logic runs for real against a temporary SQLite cache; the renderer pages run in node:vm against a small
 * fake DOM, like the earlier release tests. No network, no Electron.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { LogService } = require('../src/main/logbook');
const { UNASSIGNED } = require('../src/main/qso-cache');
const { SETTINGS_DEFAULTS, JsonStore, migrateRigs, migrateCallbook } = require('../src/main/store');
const C = require('../src/main/collections');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cld044-'));
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

const STATIONS = [
  { id: '1', name: 'Home', callsign: 'W1AW', grid: 'FN31', active: true },
  { id: '2', name: 'Portable', callsign: 'W1AW/P', grid: 'FN42', active: true },
  { id: '3', name: 'Club', callsign: 'W1AWC', grid: 'FN32', active: true },
];

function mkSettings({ current = '1', stations = STATIONS } = {}) {
  const s = clone(SETTINGS_DEFAULTS);
  s.cloudlog.stations = clone(stations);
  s.cloudlog.currentStationId = current;
  s.sync.instant = false;
  return s;
}

function mkEnv(opts = {}) {
  const dir = tmp();
  const data = mkSettings(opts);
  const log = new LogService({ dir, client: { configured: () => false }, getSettings: () => data });
  return { dir, data, log, cache: log.cache };
}

let seq = 0;
const fields = (call, { date = '20260115', time = '120000', band = '20m', mode = 'SSB' } = {}) => ({ CALL: call, QSO_DATE: date, TIME_ON: time, BAND: band, MODE: mode });
/** Put a QSO straight into the cache under an explicit logbook, as a stored or queued row. */
function put(env, logbookId, call, { state = 'synced', source = 'manual', ...f } = {}) {
  seq += 1;
  env.cache.insertLocal({ id: `q${String(seq).padStart(4, '0')}`, logbookId, stationId: logbookId === UNASSIGNED ? null : logbookId, fields: fields(call, f), state, source, error: '', createdAt: 1000 + seq });
  return `q${String(seq).padStart(4, '0')}`;
}
const snapshot = (env) => env.cache.db.prepare('SELECT * FROM qsos ORDER BY id').all();
const calls = (rows) => rows.map((r) => r.CALL);

// ================================ collection model ======================================================================
test('a collection returns the union of its logbooks; each QSO once; a logbook may be in several collections', () => {
  const env = mkEnv();
  for (const [lb, call] of [['1', 'K1AAA'], ['1', 'K1AAB'], ['2', 'K2BBB'], ['3', 'K3CCC']]) put(env, lb, call);
  const a = C.createCollection(env.data, 'Home+Portable', ['1', '2']);
  const b = C.createCollection(env.data, 'Home+Club', ['1', '3']);
  const ra = C.queryScoped(env.log, env.data, { scope: { kind: 'collection', id: a.id } });
  const rb = C.queryScoped(env.log, env.data, { scope: { kind: 'collection', id: b.id } });
  assert.deepStrictEqual(calls(ra.rows).sort(), ['K1AAA', 'K1AAB', 'K2BBB']);
  assert.strictEqual(ra.total, 3);
  assert.deepStrictEqual(calls(rb.rows).sort(), ['K1AAA', 'K1AAB', 'K3CCC']);
  assert.strictEqual(new Set(ra.rows.map((r) => r._id)).size, ra.rows.length, 'no duplicate rows');
  // the same underlying QSO is in both collections
  assert.ok(ra.rows.some((r) => r.CALL === 'K1AAA') && rb.rows.some((r) => r.CALL === 'K1AAA'));
  assert.strictEqual(env.cache.db.prepare('SELECT COUNT(*) n FROM qsos').get().n, 4, 'still exactly four stored rows');
});

test('duplicate membership relationships are prevented, on create, on edit and when loading a settings file', () => {
  const env = mkEnv();
  const col = C.createCollection(env.data, 'Dups', ['1', '1', '2', '1']);
  assert.deepStrictEqual(col.members, ['1', '2']);
  C.setMembers(env.data, col.id, ['2', '2', '3', '2']);
  assert.deepStrictEqual(env.data.logbookCollections.collections[0].members, ['2', '3']);
  const loaded = { logbookCollections: { collections: [{ id: 'x', name: 'X', members: ['1', '1', 2, '2'] }, { id: 'x', name: 'Same id twice', members: [] }], active: null } };
  C.migrateCollections(loaded);
  assert.deepStrictEqual(loaded.logbookCollections.collections, [{ id: 'x', name: 'X', members: ['1', '2'] }]);
});

test('an empty collection is a valid, empty scope: no QSOs, never all QSOs', () => {
  const env = mkEnv();
  put(env, '1', 'K1AAA'); put(env, '2', 'K2BBB');
  const col = C.createCollection(env.data, 'Empty', []);
  const scope = C.resolveScope(env.data, { kind: 'collection', id: col.id });
  assert.deepStrictEqual(scope.logbookIds, []);
  assert.strictEqual(scope.empty, true);
  assert.strictEqual(scope.unrestricted, false);
  const r = C.queryScoped(env.log, env.data, { scope: { kind: 'collection', id: col.id } });
  assert.deepStrictEqual([r.rows.length, r.total], [0, 0]);
  // the cache layer itself refuses to run an unfiltered query for an empty list
  assert.deepStrictEqual(env.cache.pageQuery({ logbookIds: [], pageSize: 10 }).rows, []);
  assert.strictEqual(env.cache.countQuery({ logbookIds: [] }), 0);
  assert.strictEqual(env.log.query({ logbookIds: [] }).total, 0);
  assert.strictEqual(env.log.query({}).total, 0);
  // and as the explicit Active collection it stays selected and shows nothing
  C.setActive(env.data, { kind: 'collection', id: col.id });
  const st = C.statsScoped(env.log, env.data);
  assert.deepStrictEqual([st.total, st.today, st.recent.length], [0, 0, 0]);
  assert.strictEqual(st.scope.id, col.id);
});

test('creating, renaming, editing members, selecting and deleting collections never change stored or queued QSOs', () => {
  const env = mkEnv();
  put(env, '1', 'K1AAA'); put(env, '2', 'K2BBB'); put(env, '3', 'K3CCC', { state: 'pending' }); put(env, '2', 'K2FAIL', { state: 'failed' }); put(env, UNASSIGNED, 'K9NONE', { state: 'pending' });
  env.cache.upsertRemoteBatch('1', [fields('K1REM', { time: '130000' })]);
  const before = snapshot(env);
  const adifBefore = env.log.exportLocalAdif();
  const col = C.createCollection(env.data, 'Temp', ['1']);
  C.renameCollection(env.data, col.id, 'Renamed');
  C.setMembers(env.data, col.id, ['2', '3']);
  C.setActive(env.data, { kind: 'collection', id: col.id });
  C.queryScoped(env.log, env.data, { scope: { kind: 'collection', id: col.id } });
  C.statsScoped(env.log, env.data);
  C.deleteCollection(env.data, col.id);
  assert.deepStrictEqual(snapshot(env), before, 'every stored and queued row is byte-for-byte identical');
  assert.strictEqual(env.log.exportLocalAdif(), adifBefore, 'upload/export serialization is unchanged');
  assert.deepStrictEqual(env.data.cloudlog.stations, STATIONS, 'the logbooks themselves are untouched');
});

test('deleting a collection removes only its metadata and clears it as the Active collection', () => {
  const env = mkEnv({ current: '2' });
  put(env, '1', 'K1AAA');
  const keep = C.createCollection(env.data, 'Keep', ['1']);
  const gone = C.createCollection(env.data, 'Gone', ['1', '2']);
  C.setActive(env.data, { kind: 'collection', id: gone.id });
  C.deleteCollection(env.data, gone.id);
  assert.deepStrictEqual(env.data.logbookCollections.collections.map((c) => c.id), [keep.id]);
  assert.strictEqual(env.data.logbookCollections.active, null);
  assert.strictEqual(C.resolveScope(env.data).id, '2', 'falls back to the Active logbook');
  assert.strictEqual(env.cache.countByLogbook('1'), 1);
  assert.throws(() => C.deleteCollection(env.data, gone.id), /no longer exists/);
});

test('names are validated: required, trimmed, unique ignoring case; unknown logbooks are refused', () => {
  const env = mkEnv();
  const a = C.createCollection(env.data, '  Field   Day ', ['1']);
  assert.strictEqual(a.name, 'Field Day');
  assert.throws(() => C.createCollection(env.data, 'field day'), /already a collection/);
  assert.throws(() => C.createCollection(env.data, '   '), /Enter a name/);
  assert.throws(() => C.createCollection(env.data, 'x'.repeat(61)), /at most/);
  assert.throws(() => C.createCollection(env.data, 'Bad', ['99']), /Unknown logbook/);
  assert.doesNotThrow(() => C.renameCollection(env.data, a.id, 'FIELD DAY'), 'a collection may be renamed to a different case of itself');
});

test('stale members (a logbook that no longer exists) are ignored, and editing the collection cleans them up; new logbooks join nothing', () => {
  const env = mkEnv();
  put(env, '3', 'K3CCC'); put(env, '1', 'K1AAA');
  const col = C.createCollection(env.data, 'Mix', ['1', '3']);
  env.data.cloudlog.stations = env.data.cloudlog.stations.filter((s) => s.id !== '3'); // logbook 3 deleted on the server
  const scope = C.resolveScope(env.data, { kind: 'collection', id: col.id });
  assert.deepStrictEqual(scope.logbookIds, ['1']);
  assert.strictEqual(scope.staleMembers, 1);
  assert.deepStrictEqual(calls(C.queryScoped(env.log, env.data, { scope: { kind: 'collection', id: col.id } }).rows), ['K1AAA']);
  assert.deepStrictEqual(env.data.logbookCollections.collections[0].members, ['1', '3'], 'ignored, not silently rewritten');
  C.setMembers(env.data, col.id, ['1']);
  assert.deepStrictEqual(env.data.logbookCollections.collections[0].members, ['1']);
  // a logbook created later is a new individual option and is in no collection
  env.data.cloudlog.stations.push({ id: '4', name: 'New', callsign: 'W1NEW', grid: '', active: true });
  assert.deepStrictEqual(C.resolveScope(env.data, { kind: 'collection', id: col.id }).logbookIds, ['1']);
  assert.deepStrictEqual(C.resolveScope(env.data, { kind: 'logbook', id: '4' }).logbookIds, ['4']);
});

// ================================ settings and selection ================================================================
test('Active collection can select a collection or an individual logbook, and the two kinds can share an id', () => {
  const env = mkEnv();
  env.data.logbookCollections = { collections: [{ id: '2', name: 'Numeric id', members: ['1', '3'] }], active: null };
  C.setActive(env.data, { kind: 'collection', id: '2' });
  assert.deepStrictEqual(C.resolveScope(env.data).logbookIds, ['1', '3']);
  assert.strictEqual(C.resolveScope(env.data).kind, 'collection');
  C.setActive(env.data, { kind: 'logbook', id: '2' });
  assert.deepStrictEqual(C.resolveScope(env.data).logbookIds, ['2']);
  assert.strictEqual(C.resolveScope(env.data).kind, 'logbook');
  assert.deepStrictEqual(env.data.logbookCollections.active, { kind: 'logbook', id: '2' });
  // typed page-level values are just as unambiguous
  assert.deepStrictEqual(C.resolveScope(env.data, { kind: 'collection', id: '2' }).logbookIds, ['1', '3']);
  assert.throws(() => C.setActive(env.data, { kind: 'logbook', id: '77' }), /not in your list/);
  assert.throws(() => C.setActive(env.data, { kind: 'collection', id: '77' }), /no longer exists/);
  assert.throws(() => C.setActive(env.data, { kind: 'banana', id: '1' }), /Choose/);
  assert.throws(() => C.setActive(env.data, '2'), /Choose/, 'a bare id is never accepted: names and bare ids are ambiguous');
});

test('Active collection and Active logbook are independent in both directions', () => {
  const env = mkEnv({ current: '1' });
  const col = C.createCollection(env.data, 'Pair', ['2', '3']);
  C.setActive(env.data, { kind: 'collection', id: col.id });
  assert.strictEqual(env.data.cloudlog.currentStationId, '1', 'choosing an Active collection leaves the Active logbook alone');
  env.data.cloudlog.currentStationId = '3'; // what stations:setCurrent does
  assert.deepStrictEqual(env.data.logbookCollections.active, { kind: 'collection', id: col.id }, 'a valid explicit selection survives an Active logbook change');
  assert.strictEqual(C.resolveScope(env.data).id, col.id);
  // single-logbook explicit selection is independent too
  C.setActive(env.data, { kind: 'logbook', id: '2' });
  env.data.cloudlog.currentStationId = '1';
  assert.deepStrictEqual(C.resolveScope(env.data).logbookIds, ['2']);
});

test('with no collections and no explicit selection the scope tracks the current Active logbook (not a captured id)', () => {
  const env = mkEnv({ current: '1' });
  let s = C.resolveScope(env.data);
  assert.deepStrictEqual([s.kind, s.id, s.source, s.logbookIds], ['logbook', '1', 'fallback', ['1']]);
  env.data.cloudlog.currentStationId = '2';
  s = C.resolveScope(env.data);
  assert.deepStrictEqual([s.id, s.source], ['2', 'fallback']);
  assert.strictEqual(env.data.logbookCollections.active, null, 'the fallback is computed, never stored');
  assert.deepStrictEqual(env.data.logbookCollections.collections, [], 'no collection was created for it');
});

test('an explicit single-logbook selection is kept when no collections exist', () => {
  const env = mkEnv({ current: '1' });
  C.setActive(env.data, { kind: 'logbook', id: '3' });
  env.data.cloudlog.currentStationId = '2';
  const s = C.resolveScope(env.data);
  assert.deepStrictEqual([s.id, s.source], ['3', 'explicit']);
});

test('a missing, deleted or invalid persisted selection falls back to the Active logbook', () => {
  const env = mkEnv({ current: '2' });
  for (const bad of [null, { kind: 'collection', id: 'col-gone' }, { kind: 'logbook', id: '99' }, { kind: 'x', id: '1' }, { kind: 'logbook' }, 'logbook:1', 7]) {
    env.data.logbookCollections = { collections: [], active: bad };
    const s = C.resolveScope(env.data);
    assert.deepStrictEqual([s.kind, s.id, s.source], ['logbook', '2', 'fallback'], JSON.stringify(bad));
  }
  // a logbook that disappears from the server list after being selected
  C.setActive(env.data, { kind: 'logbook', id: '3' });
  env.data.cloudlog.stations = env.data.cloudlog.stations.filter((x) => x.id !== '3');
  assert.strictEqual(C.resolveScope(env.data).id, '2');
});

test('no valid Active logbook either: an empty "unconfigured" scope, not every QSO', () => {
  const env = mkEnv({ current: null, stations: [] });
  put(env, '1', 'K1AAA'); put(env, UNASSIGNED, 'K9NONE', { state: 'pending' });
  const s = C.resolveScope(env.data);
  assert.deepStrictEqual([s.kind, s.unconfigured, s.empty, s.unrestricted, s.logbookIds], ['none', true, true, false, []]);
  const st = C.statsScoped(env.log, env.data);
  assert.deepStrictEqual([st.total, st.recent.length], [0, 0]);
  assert.strictEqual(C.queryScoped(env.log, env.data, {}).total, 0);
});

test('settings from before 0.4.4 load, migrate idempotently, keep the Active logbook and create no collection', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  const old = clone(SETTINGS_DEFAULTS); delete old.logbookCollections;
  old.cloudlog.currentStationId = '2'; old.cloudlog.stations = clone(STATIONS);
  fs.writeFileSync(file, JSON.stringify(old));
  const store = new JsonStore(file, SETTINGS_DEFAULTS);
  migrateRigs(store.data); migrateCallbook(store.data);
  C.migrateCollections(store.data);
  const once = clone(store.data);
  C.migrateCollections(store.data); C.migrateCollections(store.data);
  assert.deepStrictEqual(store.data, once, 'idempotent');
  assert.deepStrictEqual(store.data.logbookCollections, { collections: [], active: null });
  assert.strictEqual(store.data.cloudlog.currentStationId, '2');
  assert.deepStrictEqual(C.resolveScope(store.data).logbookIds, ['2']);
  // garbage in the file never crashes the loader
  for (const junk of [null, 5, 'x', [], { collections: 'nope', active: 3 }, { collections: [null, 4, { id: '', name: 'n' }, { id: 'ok', name: '' }] }]) {
    const d = { logbookCollections: junk };
    assert.doesNotThrow(() => C.migrateCollections(d));
    assert.deepStrictEqual(d.logbookCollections, { collections: [], active: null });
  }
});

test('a fresh install (no logbooks, no QSOs) shows empty states and nothing throws', () => {
  const env = mkEnv({ current: null, stations: [] });
  assert.strictEqual(C.resolveScope(env.data).unconfigured, true);
  const st = C.statsScoped(env.log, env.data);
  assert.deepStrictEqual([st.total, st.today, st.recent, st.queue.pending], [0, 0, [], 0]);
  assert.throws(() => C.createCollection(env.data, 'X', ['1']), /Unknown logbook/);
});

// ================================ Dashboard =============================================================================
test('Dashboard statistics and recent QSOs use the scope; the limit applies after scoping; ownership is the real logbook', () => {
  const env = mkEnv({ current: '3' });
  // 12 older QSOs in logbook 1, 3 newer in 2, and 5 even newer in 3 (which is the Active logbook but not in the collection)
  for (let i = 0; i < 12; i++) put(env, '1', `K1A${String(i).padStart(2, '0')}`, { date: '20260101', time: `10${String(i).padStart(2, '0')}00` });
  for (let i = 0; i < 3; i++) put(env, '2', `K2B${i}`, { date: '20260102', time: `100${i}00` });
  for (let i = 0; i < 5; i++) put(env, '3', `K3C${i}`, { date: '20260103', time: `100${i}00` });
  const col = C.createCollection(env.data, 'One+Two', ['1', '2']);
  C.setActive(env.data, { kind: 'collection', id: col.id });
  const st = C.statsScoped(env.log, env.data);
  assert.strictEqual(st.total, 15);
  assert.strictEqual(st.recent.length, 10, 'limit is still 10');
  assert.deepStrictEqual(st.recent.slice(0, 3).map((r) => [r.CALL, r._logbookId]), [['K2B2', '2'], ['K2B1', '2'], ['K2B0', '2']], 'newest first, and not contaminated by the newer QSOs of logbook 3');
  assert.ok(st.recent.every((r) => r._logbookId === '1' || r._logbookId === '2'));
  assert.strictEqual(st.recent[3]._logbookId, '1');
  // a single-logbook selection uses only that logbook
  C.setActive(env.data, { kind: 'logbook', id: '3' });
  const one = C.statsScoped(env.log, env.data);
  assert.deepStrictEqual([one.total, one.recent.length, new Set(one.recent.map((r) => r._logbookId)).size], [5, 5, 1]);
  // "today" counts follow the scope as well
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  put(env, '2', 'K2NOW', { date: today, time: '000100' }); put(env, '3', 'K3NOW', { date: today, time: '000200' });
  C.setActive(env.data, { kind: 'collection', id: col.id });
  assert.strictEqual(C.statsScoped(env.log, env.data).today, 1);
});

test('queued QSOs are shown for the scope only, by their own logbook, never by the Active logbook', () => {
  const env = mkEnv({ current: '3' }); // Active logbook 3 is NOT in the collection
  put(env, '1', 'K1PEND', { state: 'pending' });
  put(env, '2', 'K2FAIL', { state: 'failed' });
  put(env, '3', 'K3PEND', { state: 'pending' });
  put(env, UNASSIGNED, 'K9NONE', { state: 'pending' });
  put(env, '1', 'K1DONE', { state: 'synced' });
  const col = C.createCollection(env.data, 'One+Two', ['1', '2']);
  C.setActive(env.data, { kind: 'collection', id: col.id });
  let q = C.statsScoped(env.log, env.data).queue;
  assert.deepStrictEqual(q, { pending: 1, failed: 1, otherPending: 2, otherFailed: 0 });
  C.setActive(env.data, { kind: 'logbook', id: '1' });
  q = C.statsScoped(env.log, env.data).queue;
  assert.deepStrictEqual([q.pending, q.failed, q.otherPending, q.otherFailed], [1, 0, 2, 1]);
  C.setActive(env.data, null);
  q = C.statsScoped(env.log, env.data).queue; // fallback: Active logbook 3
  assert.deepStrictEqual([q.pending, q.failed], [1, 0]);
});

test('a QSO moving from queued to stored is never counted or listed twice, and queue counts only follow its state', () => {
  const env = mkEnv();
  const id = put(env, '1', 'K1MOVE', { state: 'pending' });
  const read1 = () => C.statsScoped(env.log, env.data);
  let st = read1();
  assert.deepStrictEqual([st.total, st.recent.length, st.queue.pending], [1, 1, 1], 'existing semantics: queued rows are part of the logbook total');
  env.cache.setState(id, { state: 'synced', error: '', syncedAt: 5, updatedAt: 5 });
  st = read1();
  assert.deepStrictEqual([st.total, st.recent.length, st.queue.pending, st.queue.failed], [1, 1, 0, 0]);
  assert.strictEqual(st.recent[0].CALL, 'K1MOVE');
});

// ================================ Logbooks page (query) =================================================================
test('default scope is the effective Active collection; a page-level choice leaves Settings and the Active logbook untouched', () => {
  const env = mkEnv({ current: '1' });
  put(env, '1', 'K1AAA'); put(env, '2', 'K2BBB'); put(env, '3', 'K3CCC');
  const col = C.createCollection(env.data, 'Two+Three', ['2', '3']);
  C.setActive(env.data, { kind: 'collection', id: col.id });
  assert.deepStrictEqual(calls(C.queryScoped(env.log, env.data, {}).rows).sort(), ['K2BBB', 'K3CCC']);
  const settingsBefore = clone(env.data);
  const r = C.queryScoped(env.log, env.data, { scope: { kind: 'logbook', id: '1' } });
  assert.deepStrictEqual(calls(r.rows), ['K1AAA']);
  assert.deepStrictEqual([r.scope.kind, r.scope.source], ['logbook', 'requested']);
  assert.deepStrictEqual(env.data, settingsBefore, 'nothing in Settings changed');
  // a requested scope that no longer exists is ignored in favour of the effective Active collection
  const stale = C.queryScoped(env.log, env.data, { scope: { kind: 'collection', id: 'col-deleted' } });
  assert.strictEqual(stale.scope.id, col.id);
  // the older single-logbook parameter still means exactly that logbook
  assert.deepStrictEqual(calls(C.queryScoped(env.log, env.data, { stationId: '3' }).rows), ['K3CCC']);
});

test('filters, counts, sorting and keyset pagination stay correct across a collection', () => {
  const env = mkEnv();
  const expected = [];
  for (let i = 0; i < 23; i++) {
    const lb = ['1', '2', '3'][i % 3];
    const call = `K${lb}X${String(i).padStart(2, '0')}`;
    put(env, lb, call, { date: '20260105', time: `${String(10 + (i % 10)).padStart(2, '0')}${String(i).padStart(2, '0')}00`, band: i % 2 ? '40m' : '20m', mode: i % 4 === 0 ? 'CW' : 'SSB' });
    if (lb !== '3') expected.push(call);
  }
  const col = C.createCollection(env.data, 'One+Two', ['1', '2']);
  const sel = { kind: 'collection', id: col.id };
  const seen = []; let total = 0;
  for (let page = 1; page <= 4; page++) {
    const r = C.queryScoped(env.log, env.data, { scope: sel, page, pageSize: 5 });
    total = r.total;
    seen.push(...r.rows.map((x) => x.CALL));
    assert.ok(r.rows.every((x) => ['1', '2'].includes(x._logbookId)));
  }
  assert.strictEqual(total, expected.length, 'count is the union, not inflated');
  assert.strictEqual(seen.length, expected.length);
  assert.strictEqual(new Set(seen).size, seen.length, 'no row twice across pages');
  assert.deepStrictEqual([...seen].sort(), [...expected].sort());
  const all = C.queryScoped(env.log, env.data, { scope: sel, page: 1, pageSize: 100 }).rows;
  const keys = all.map((x) => `${x.QSO_DATE}${x.TIME_ON}`);
  assert.deepStrictEqual(keys, [...keys].sort().reverse(), 'newest first');
  const f = C.queryScoped(env.log, env.data, { scope: sel, band: '40m', mode: 'SSB', pageSize: 100 });
  assert.ok(f.rows.length > 0 && f.rows.every((x) => x.BAND === '40m' && x.MODE === 'SSB') && f.total === f.rows.length);
  const s = C.queryScoped(env.log, env.data, { scope: sel, q: 'k2x', pageSize: 100 });
  assert.ok(s.rows.length > 0 && s.rows.every((x) => x._logbookId === '2'));
  // changing membership changes the result at once and never serves a stale cursor
  C.setMembers(env.data, col.id, ['3']); env.log.invalidateScopeCaches();
  const after = C.queryScoped(env.log, env.data, { scope: sel, page: 3, pageSize: 5 });
  assert.ok(after.rows.every((x) => x._logbookId === '3'));
});

test('"Update from server" bookkeeping: a collection reports the oldest download time, and unknown while any member was never fetched', () => {
  const env = mkEnv();
  const col = C.createCollection(env.data, 'Pair', ['1', '2']);
  const sel = { kind: 'collection', id: col.id };
  assert.strictEqual(C.queryScoped(env.log, env.data, { scope: sel }).fetchedAt, null);
  env.cache.setSyncFetchedAt('1', 2000);
  assert.strictEqual(C.queryScoped(env.log, env.data, { scope: sel }).fetchedAt, null);
  env.cache.setSyncFetchedAt('2', 1500);
  assert.strictEqual(C.queryScoped(env.log, env.data, { scope: sel }).fetchedAt, 1500);
});

// ================================ queued QSOs / storage =================================================================
test('the queue list reports each queued QSO\'s own logbook, keeps its old shape, and is not filtered by scope', () => {
  const env = mkEnv({ current: '3' });
  put(env, '1', 'K1PEND', { state: 'pending' });
  put(env, UNASSIGNED, 'K9NONE', { state: 'failed' });
  put(env, '2', 'K2DONE', { state: 'synced' });
  const col = C.createCollection(env.data, 'Only1', ['1']);
  C.setActive(env.data, { kind: 'collection', id: col.id });
  const list = env.log.localList(['pending', 'failed']);
  assert.strictEqual(list.length, 2, 'both queued QSOs are listed whatever the Active collection is');
  const by = Object.fromEntries(list.map((r) => [r.fields.CALL, r]));
  assert.strictEqual(by.K1PEND.logbookId, '1');
  assert.strictEqual(by.K9NONE.logbookId, UNASSIGNED, 'unresolved ownership is reported as such, not assigned to the current logbook');
  assert.strictEqual(by.K9NONE.stationId, null);
  for (const key of ['id', 'fields', 'stationId', 'state', 'error', 'source', 'created']) assert.ok(key in by.K1PEND, key);
});

test('new QSOs are still recorded in the Active logbook, whatever the Active collection is', async () => {
  const env = mkEnv({ current: '2' });
  const col = C.createCollection(env.data, 'Other', ['1', '3']);
  C.setActive(env.data, { kind: 'collection', id: col.id });
  const rec = env.log.addQso({ CALL: 'K1NEW', MODE: 'SSB', BAND: '20m' });
  assert.strictEqual(env.cache.get(rec.id).logbook_id, '2');
  C.setActive(env.data, { kind: 'logbook', id: '3' });
  const rec2 = env.log.addQso({ CALL: 'K1NE2', MODE: 'SSB', BAND: '20m' });
  assert.strictEqual(env.cache.get(rec2.id).logbook_id, '2');
  assert.strictEqual(env.cache.countByLogbook('3'), 0);
});

test('storage schema and serialization are unchanged', () => {
  const env = mkEnv();
  assert.strictEqual(env.cache.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version').value, '1');
  const tables = env.cache.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  assert.deepStrictEqual(tables, ['qsos', 'schema_meta', 'sync_meta']);
  const cols = env.cache.db.prepare('PRAGMA table_info(qsos)').all().map((c) => c.name);
  assert.deepStrictEqual(cols, ['id', 'logbook_id', 'station_id', 'callsign', 'qso_time_utc_ms', 'band', 'mode', 'freq_hz', 'sync_state', 'source', 'error', 'created_at', 'updated_at', 'synced_at', 'fields_json']);
  const id = put(env, '1', 'K1AAA', { state: 'pending' });
  C.createCollection(env.data, 'X', ['1']);
  assert.deepStrictEqual(JSON.parse(env.cache.get(id).fields_json), fields('K1AAA'), 'the stored fields carry no collection data');
  assert.ok(!('logbookCollections' in JSON.parse(env.cache.get(id).fields_json)));
});

// ================================ renderer ==============================================================================
class FakeEl {
  constructor(sel) {
    this.sel = sel; this._html = ''; this.textContent = ''; this.value = ''; this.disabled = false; this.dataset = {};
    this.listeners = {}; this.classes = new Set(); this.style = { removeProperty() {} };
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => { if (on === undefined ? !this.classes.has(c) : on) this.classes.add(c); else this.classes.delete(c); } };
  }

  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function createEnv(handlers, hash = '') {
  const els = new Map();
  const get = (sel) => { if (!els.has(sel)) els.set(sel, new FakeEl(sel)); return els.get(sel); };
  const calls_ = [];
  const ctx = {
    document: { querySelector: get, querySelectorAll: () => [], createElement: () => new FakeEl('x'), body: new FakeEl('body'), activeElement: null },
    console, location: { hash }, URLSearchParams, Event: class {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {},
  };
  ctx.window = ctx;
  ctx.cl = { on() {}, call: async (name, ...args) => { calls_.push({ name, args }); if (!handlers[name]) throw new Error(`Unmocked call ${name}`); return handlers[name](...args); } };
  vm.createContext(ctx);
  const load = (rel) => vm.runInContext(read('src', 'renderer', rel), ctx, { filename: rel });
  load('util.js');
  return { ctx, load, get, calls: calls_ };
}

const headers = (h) => [...h.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]);
const bodyRows = (h) => [...h.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].trim()));
const SYNC = { configured: true, pending: 0, failed: 0, paused: false, lastError: '' };
const rsettings = ({ collections = [], active = null, eff = null, current = '1' } = {}) => ({
  cloudlog: { url: '', currentStationId: current, stations: clone(STATIONS) }, sync: { instant: true }, theme: 'cerulean',
  logbookCollections: { collections, active }, effectiveScope: eff,
});
const ROW = { QSO_DATE: '20261003', TIME_ON: '1415', CALL: 'K1ABC', BAND: '20m', MODE: 'SSB', RST_SENT: '59', RST_RCVD: '57', GRIDSQUARE: 'FN42', COUNTRY: 'United States' };
const EFF1 = { kind: 'logbook', id: '1', name: 'Home', source: 'fallback', empty: false, unconfigured: false };

test('qsoHead / qsoRows: the Logbook column is rightmost, resolved by id, and only present when asked for', () => {
  const { ctx } = createEnv({});
  ctx.App.state.settings = rsettings();
  const { qsoHead, qsoRows } = ctx.App.util;
  assert.deepStrictEqual(headers(String(qsoHead(['country']))), ['Date', 'UTC', 'Call', 'Band', 'Mode', 'RST', 'Country', ''], 'unchanged without the column');
  assert.deepStrictEqual(headers(String(qsoHead(['grid', 'country', 'logbook']))), ['Date', 'UTC', 'Call', 'Band', 'Mode', 'RST', 'Grid', 'Country', '', 'Logbook']);
  const rows = bodyRows(String(qsoRows([{ ...ROW, _logbookId: '2' }, { ...ROW, _logbookId: '3' }, { ...ROW, _logbookId: '88' }, { ...ROW, _logbookId: '<b>x</b>' }, { ...ROW }], ['grid', 'country', 'logbook'])));
  assert.deepStrictEqual(rows.map((r) => r[r.length - 1]), ['Portable', 'Club', 'Logbook #88', 'Logbook #&lt;b&gt;x&lt;/b&gt;', '']);
  assert.ok(rows.every((r) => r.length === 10));
  assert.match(String(qsoRows([], ['country', 'logbook'])), /colspan="9"/);
});

test('typed scope values keep logbook and collection ids apart', () => {
  const { ctx } = createEnv({});
  const { scopeValue, parseScopeValue } = ctx.App.util;
  assert.notStrictEqual(scopeValue('logbook', '2'), scopeValue('collection', '2'));
  assert.deepStrictEqual({ ...parseScopeValue('collection:2') }, { kind: 'collection', id: '2' });
  assert.deepStrictEqual({ ...parseScopeValue('logbook:a:b') }, { kind: 'logbook', id: 'a:b' });
  for (const bad of ['', '2', ':2', 'x:2', 'logbook:', null, undefined]) assert.strictEqual(parseScopeValue(bad), null, String(bad));
});

async function mountDashboard(stats, settings) {
  const env = createEnv({ 'log:stats': () => stats });
  env.load('pages/dashboard.js');
  env.ctx.App.state = { settings, info: { bands: [], modes: [] }, rig: null, rigs: [], sync: { ...SYNC, pending: 9, failed: 0 }, adif: { enabled: false } };
  const root = new FakeEl('#page');
  env.ctx.App.pages.dashboard.mount(root);
  await settle();
  return root.innerHTML;
}

test('Dashboard: Recent QSOs gets a rightmost Logbook column with the real owner; the queue card shows only the scope', async () => {
  const eff = { kind: 'collection', id: 'c1', name: 'Hams', source: 'explicit', empty: false, unconfigured: false };
  const out = await mountDashboard({
    total: 2, today: 1, scope: eff, queue: { pending: 1, failed: 2, otherPending: 5, otherFailed: 0 },
    recent: [{ ...ROW, _logbookId: '2' }, { ...ROW, CALL: 'K9ZZZ', _logbookId: '1' }],
  }, rsettings({ collections: [{ id: 'c1', name: 'Hams', members: ['1', '2'] }], active: { kind: 'collection', id: 'c1' }, eff }));
  const thead = /<thead>[\s\S]*?<\/thead>/.exec(out)[0];
  assert.deepStrictEqual(headers(thead), ['Date', 'UTC', 'Call', 'Band', 'Mode', 'RST', 'Country', '', 'Logbook']);
  const rows = bodyRows(/<tbody>[\s\S]*<\/tbody>/.exec(out)[0]);
  assert.deepStrictEqual(rows.map((r) => r[r.length - 1]), ['Portable', 'Home']);
  assert.match(out, /Viewing: Hams \(collection\)/);
  assert.match(out, /3<\/div>\s*<div class="text-muted">2 failed, 1 waiting/, 'scoped queue count (1 pending + 2 failed), not the global 9');
  assert.match(out, /\+5 in other logbooks/);
});

test('Dashboard: older stats replies without scope/queue still render (global sync counts)', async () => {
  const out = await mountDashboard({ total: 1, today: 0, recent: [{ ...ROW, _logbookId: '1' }] }, rsettings());
  assert.match(out, /9<\/div>\s*<div class="text-muted">9 waiting/);
  assert.deepStrictEqual(bodyRows(/<tbody>[\s\S]*<\/tbody>/.exec(out)[0]).map((r) => r[r.length - 1]), ['Home']);
});

async function mountLogbook({ settings, rows = [], hash = '', queue = [], result = {} }) {
  const env = createEnv({
    'log:query': (p) => ({ rows, total: rows.length, page: 1, pageSize: 50, fetchedAt: 1700000000000, cached: rows.length, scope: null, ...result }),
    'local:list': () => queue,
    'log:refresh': () => ({ added: 0, total: 0 }), 'log:refreshScope': () => ({ added: 0, total: 0 }),
  }, hash);
  env.load('pages/logbook.js');
  env.ctx.App.state = { settings, info: { bands: ['20m'], modes: ['SSB'] }, rig: null, rigs: [], sync: SYNC, adif: {} };
  const root = new FakeEl('#page');
  env.ctx.App.pages.logbook.mount(root);
  await settle();
  return { env, root, body: env.get('#lb-body') };
}

test('Logbooks page: opens on the effective Active collection; the dropdown has Collections and Logbooks groups with typed values', async () => {
  const eff = { kind: 'collection', id: '2', name: 'Pair', source: 'explicit', empty: false, unconfigured: false };
  const settings = rsettings({ collections: [{ id: '2', name: 'Pair', members: ['1', '3'] }], active: { kind: 'collection', id: '2' }, eff });
  const { env, root } = await mountLogbook({ settings, rows: [{ ...ROW, _logbookId: '3' }] });
  const q = env.calls.find((c) => c.name === 'log:query').args[0];
  assert.deepStrictEqual({ ...q.scope }, { kind: 'collection', id: '2' });
  const html = root.innerHTML;
  assert.match(html, /<optgroup label="Collections">/);
  assert.match(html, /<optgroup label="Logbooks">/);
  assert.match(html, /<option value="collection:2" selected>Pair \(2\)<\/option>/);
  for (const id of ['1', '2', '3']) assert.ok(html.includes(`value="logbook:${id}"`), `individual logbook ${id} is still selectable`);
  assert.ok(!/value="logbook:2" selected/.test(html), 'logbook 2 shares the id of the collection but is not the selected option');
  const thead = /<thead>[\s\S]*?<\/thead>/.exec(html)[0];
  assert.deepStrictEqual(headers(thead).slice(-2), ['', 'Logbook']);
  assert.strictEqual(headers(thead)[headers(thead).length - 1], 'Logbook', 'rightmost');
  assert.deepStrictEqual(bodyRows(env.get('#lb-body').innerHTML).map((r) => r[r.length - 1]), ['Club']);
});

test('Logbooks page: no collections -> opens on the Active logbook; ?id= and ?collection= open that one; Settings is never written', async () => {
  let m = await mountLogbook({ settings: rsettings({ eff: EFF1 }) });
  assert.deepStrictEqual({ ...m.env.calls.find((c) => c.name === 'log:query').args[0].scope }, { kind: 'logbook', id: '1' });
  assert.ok(!/<optgroup label="Collections">/.test(m.root.innerHTML), 'no empty Collections group');
  m = await mountLogbook({ settings: rsettings({ eff: EFF1 }), hash: '#/logbook?id=3' });
  assert.deepStrictEqual({ ...m.env.calls.find((c) => c.name === 'log:query').args[0].scope }, { kind: 'logbook', id: '3' });
  m = await mountLogbook({ settings: rsettings({ collections: [{ id: 'c9', name: 'Nine', members: ['1'] }], eff: EFF1 }), hash: '#/logbook?collection=c9' });
  assert.deepStrictEqual({ ...m.env.calls.find((c) => c.name === 'log:query').args[0].scope }, { kind: 'collection', id: 'c9' });
  for (const c of m.env.calls) assert.ok(!/^(settings:set|stations:setCurrent|collections:)/.test(c.name), `${c.name} must not be called just by viewing`);
});

test('Logbooks page: unconfigured and empty-collection states say so (and the empty-state row spans every column)', async () => {
  let m = await mountLogbook({
    settings: rsettings({ current: null, eff: { kind: 'none', id: null, name: '', source: 'fallback', empty: true, unconfigured: true } }),
    result: { total: 0, fetchedAt: null, scope: { kind: 'none', empty: true, unconfigured: true } },
  });
  assert.match(m.env.get('#lb-body').innerHTML, /colspan="10"[^>]*>No Logbook is selected/);
  const eff = { kind: 'collection', id: 'e', name: 'Empty', source: 'explicit', empty: true, unconfigured: false };
  m = await mountLogbook({
    settings: rsettings({ collections: [{ id: 'e', name: 'Empty', members: [] }], active: { kind: 'collection', id: 'e' }, eff }),
    result: { total: 0, fetchedAt: null, scope: eff },
  });
  assert.match(m.env.get('#lb-body').innerHTML, /This Collection has no Logbooks/);
});

test('Existing Queued QSOs view: only a rightmost Logbook column is added; every queued QSO is still listed', async () => {
  const q = (id, call, logbookId, state = 'pending') => ({ id, fields: { QSO_DATE: '20261003', TIME_ON: '141500', CALL: call, BAND: '20m', MODE: 'SSB' }, stationId: logbookId === '__unassigned__' ? null : logbookId, logbookId, state, error: state === 'failed' ? 'Rejected' : '', source: 'manual', created: 1 });
  const eff = { kind: 'logbook', id: '2', name: 'Portable', source: 'explicit', empty: false, unconfigured: false };
  const { env } = await mountLogbook({
    settings: rsettings({ active: { kind: 'logbook', id: '2' }, eff, current: '1' }),
    queue: [q('a', 'K1AAA', '1'), q('b', 'K2BBB', '2', 'failed'), q('c', 'K3CCC', '3'), q('d', 'K9NONE', '__unassigned__')],
  });
  const box = env.get('#queue').innerHTML;
  assert.deepStrictEqual(headers(/<thead>[\s\S]*?<\/thead>/.exec(box)[0]), ['Date (UTC)', 'Call', 'Band / Mode', 'Status', '', 'Logbook']);
  const rows = bodyRows(/<tbody>[\s\S]*<\/tbody>/.exec(box)[0]);
  assert.strictEqual(rows.length, 4, 'not filtered by the Active collection');
  assert.deepStrictEqual(rows.map((r) => r[r.length - 1]), ['Home', 'Portable', 'Club', 'Unassigned']);
  assert.strictEqual(rows[1].length, 6);
  assert.ok(box.includes('data-edit="a"') && box.includes('data-del="d"'), 'edit and discard actions are still there');
  assert.ok(env.calls.some((c) => c.name === 'local:list' && c.args[0].join() === 'pending,failed'), 'same list call as before');
});

// ================================ plumbing ==============================================================================
test('main.js: collection settings change only through validated collections:* calls; reads use the shared scope code', () => {
  const main = read('src', 'main', 'main.js');
  for (const n of ['create', 'rename', 'setMembers', 'delete', 'setActive']) assert.match(main, new RegExp(`'collections:${n}'`));
  assert.match(main, /logbookCollections: _lc, effectiveScope: _es/, 'a generic settings:set patch cannot write them');
  assert.match(main, /'log:query': \(params = \{\}\) => collections\.queryScoped\(log, settings\.data, params\)/);
  assert.match(main, /'log:stats': \(\) => collections\.statsScoped\(log, settings\.data\)/);
  assert.match(main, /collections\.migrateCollections\(settings\.data\)/);
  assert.ok(!/stations:setCurrent[^}]*logbookCollections/.test(main), 'changing the Active logbook never touches the Active collection');
});

test('the sync/upload path was not touched by collections', () => {
  const src = read('src', 'main', 'logbook.js');
  const sync = src.slice(src.indexOf('  async sync()'), src.indexOf('  async _enrichForUpload'));
  assert.ok(!/collection|scope|logbookIds/i.test(sync), 'sync() knows nothing about collections');
  assert.ok(!/collection/i.test(read('src', 'main', 'ingest.js')) && !/collection/i.test(read('src', 'main', 'adif.js')));
});

