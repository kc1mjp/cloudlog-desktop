'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { QsoCache, UNASSIGNED } = require('../src/main/qso-cache');
const { LogService } = require('../src/main/logbook');
const { SETTINGS_DEFAULTS } = require('../src/main/store');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-cache-')), 'qsocache.sqlite3');
const clone = (o) => JSON.parse(JSON.stringify(o));

function fields(call, { date = '20260115', time = '120000', band = '20m', mode = 'SSB', extra = {} } = {}) {
  return { CALL: call, QSO_DATE: date, TIME_ON: time, BAND: band, MODE: mode, ...extra };
}

// ---- schema initialization ------------------------------------------------

test('schema initializes tables/indexes and is idempotent across reopen', () => {
  const file = tmpFile();
  const c1 = new QsoCache(file);
  const tables = c1.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  assert.deepStrictEqual(tables, ['qsos', 'schema_meta', 'sqlite_sequence'.slice(0, 0) || 'sync_meta'].filter(Boolean).sort());
  const indexes = c1.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_qsos%' ORDER BY name").all().map((r) => r.name);
  assert.deepStrictEqual(indexes, ['idx_qsos_logbook_call_time', 'idx_qsos_logbook_state_time', 'idx_qsos_logbook_time']);
  assert.strictEqual(c1.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.strictEqual(c1.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const version = c1.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version');
  assert.strictEqual(version.value, '1');
  c1.insertLocal({ id: 'a', logbookId: '1', stationId: '1', fields: fields('K1ABC'), state: 'pending', source: 'manual', error: '', createdAt: Date.now() });
  c1.close();
  // Reopening an existing DB file must not error, drop data, or re-run migrations destructively.
  const c2 = new QsoCache(file);
  assert.strictEqual(c2.get('a').callsign, 'K1ABC');
  assert.strictEqual(c2.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version').value, '1');
  c2.close();
});

// ---- main-process-only ownership ------------------------------------------

test('main-process-only ownership: no renderer/preload code touches the DB, and only the cache module requires better-sqlite3', () => {
  const root = path.join(__dirname, '..');
  const rendererDir = path.join(root, 'src', 'renderer');
  const rendererFiles = fs.readdirSync(rendererDir, { recursive: true })
    .filter((f) => f.endsWith('.js')).map((f) => path.join(rendererDir, f));
  for (const f of rendererFiles) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /better-sqlite3|qso-cache|require\(['"].*qso/i, `${f} must not touch the QSO cache directly`);
  }
  const preload = fs.readFileSync(path.join(root, 'src', 'main', 'preload.js'), 'utf8');
  assert.doesNotMatch(preload, /better-sqlite3/);
  // preload only exposes the generic call/on bridge - no direct DB/SQL/filesystem methods.
  assert.match(preload, /exposeInMainWorld\('cl', \{\s*call:/);
});

test('renderer IPC validation: the exposed api never passes through raw SQL, arbitrary query execution, or a raw db path', () => {
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.doesNotMatch(mainJs, /\bexec\s*\(|\bprepare\s*\(|SELECT\s+\*|db\.(get|all|run)\(/i, 'main.js IPC layer must not issue SQL directly - only qso-cache.js may');
  assert.doesNotMatch(mainJs, /dataDir.*getPath\('userData'\).*qsocache|qsocache\.sqlite3/i);
});

// ---- multi-logbook isolation -----------------------------------------------

test('multi-logbook isolation: rows, counts, and clearing never cross logbook_id', () => {
  const cache = new QsoCache(tmpFile());
  cache.insertLocal({ id: 'a1', logbookId: 'A', stationId: 'A', fields: fields('K1AAA'), state: 'synced', source: 'manual', error: '', createdAt: 1 });
  cache.insertLocal({ id: 'b1', logbookId: 'B', stationId: 'B', fields: fields('K1BBB'), state: 'synced', source: 'manual', error: '', createdAt: 2 });
  assert.strictEqual(cache.countByLogbook('A'), 1);
  assert.strictEqual(cache.countByLogbook('B'), 1);
  const { rows: aRows } = cache.pageQuery({ logbookId: 'A', band: '', mode: '', needle: '', pageSize: 50, cursor: null });
  assert.deepStrictEqual(aRows.map((r) => r.CALL), ['K1AAA']);
  const { rows: bRows } = cache.pageQuery({ logbookId: 'B', band: '', mode: '', needle: '', pageSize: 50, cursor: null });
  assert.deepStrictEqual(bRows.map((r) => r.CALL), ['K1BBB']);
});

// ---- pending/failed/synced state queries -----------------------------------

test('local queue state queries: pending/failed/synced counts and filtered listing', () => {
  const cache = new QsoCache(tmpFile());
  const mk = (id, state, call) => cache.insertLocal({ id, logbookId: '1', stationId: '1', fields: fields(call), state, source: 'manual', error: state === 'failed' ? 'boom' : '', createdAt: Date.now() });
  mk('p1', 'pending', 'K1AAA'); mk('p2', 'pending', 'K1BBB'); mk('f1', 'failed', 'K1CCC'); mk('s1', 'synced', 'K1DDD');
  // a remote-cached row must never count toward the local pending/failed/synced queue
  cache.upsertRemoteBatch('1', [fields('K1EEE')]);

  const counts = cache.localStateCounts();
  assert.strictEqual(counts.pending, 2);
  assert.strictEqual(counts.failed, 1);
  assert.strictEqual(cache.hasPendingAny(), true);

  assert.deepStrictEqual(cache.listLocal(['pending']).map((r) => r.id).sort(), ['p1', 'p2']);
  assert.deepStrictEqual(cache.listLocal(['failed']).map((r) => r.id), ['f1']);
  assert.strictEqual(cache.listLocal(['pending', 'failed']).length, 3);
  assert.strictEqual(cache.listPending().length, 2);
});

// ---- incremental insert and update behaviour -------------------------------

test('incremental insert and update: editing a row updates in place, never duplicates it', () => {
  const cache = new QsoCache(tmpFile());
  cache.insertLocal({ id: 'a', logbookId: '1', stationId: '1', fields: fields('K1ABC'), state: 'pending', source: 'manual', error: '', createdAt: 1000 });
  assert.strictEqual(cache.countByLogbook('1'), 1);
  cache.updateFieldsAndState('a', { fields: fields('K1XYZ', { band: '40m' }), state: 'pending', error: '', updatedAt: 2000 });
  assert.strictEqual(cache.countByLogbook('1'), 1, 'edit must update the existing row, not insert a new one');
  const row = cache.get('a');
  assert.strictEqual(row.callsign, 'K1XYZ');
  assert.strictEqual(row.band, '40m');
  assert.strictEqual(row.updated_at, 2000);
  cache.setState('a', { state: 'synced', error: '', syncedAt: 3000, updatedAt: 3000 });
  assert.strictEqual(cache.get('a').sync_state, 'synced');
});

// ---- callsign history / dupe lookup, constrained to one logbook -----------

test('callsign history and dupe lookup use the callsign index and stay within one logbook', () => {
  const cache = new QsoCache(tmpFile());
  cache.insertLocal({ id: 'a', logbookId: '1', stationId: '1', fields: fields('K1ABC', { date: '20260101', time: '100000' }), state: 'synced', source: 'manual', error: '', createdAt: 1 });
  cache.insertLocal({ id: 'b', logbookId: '1', stationId: '1', fields: fields('K1ABC', { date: '20260102', time: '100000' }), state: 'synced', source: 'manual', error: '', createdAt: 2 });
  // same callsign, different logbook - must not appear in logbook "1" history
  cache.insertLocal({ id: 'c', logbookId: '2', stationId: '2', fields: fields('K1ABC', { date: '20260103', time: '100000' }), state: 'synced', source: 'manual', error: '', createdAt: 3 });

  const hist = cache.callsignHistory('1', 'K1ABC');
  assert.strictEqual(hist.length, 2);
  assert.strictEqual(hist[0].QSO_DATE, '20260102', 'newest first');

  // dedupe: same call/date/minute/band/mode is a match
  const dupe = cache.findDedupeMatch('1', fields('K1ABC', { date: '20260101', time: '100030' }));
  assert.strictEqual(dupe, 'a');
  // different band is not a match
  assert.strictEqual(cache.findDedupeMatch('1', fields('K1ABC', { date: '20260101', time: '100000', band: '40m' })), null);
});

// ---- clearing one selected local logbook without affecting another --------

test('clearing one logbook cache removes only that logbook\'s synced rows and sync metadata, and never touches pending/failed work', () => {
  const cache = new QsoCache(tmpFile());
  cache.insertLocal({ id: 'a', logbookId: '1', stationId: '1', fields: fields('K1AAA'), state: 'synced', source: 'manual', error: '', createdAt: 1 });
  cache.insertLocal({ id: 'p', logbookId: '1', stationId: '1', fields: fields('K1PPP'), state: 'pending', source: 'manual', error: '', createdAt: 2 });
  cache.insertLocal({ id: 'fl', logbookId: '1', stationId: '1', fields: fields('K1FFF'), state: 'failed', source: 'manual', error: 'boom', createdAt: 3 });
  cache.insertLocal({ id: 'b', logbookId: '2', stationId: '2', fields: fields('K1BBB'), state: 'synced', source: 'manual', error: '', createdAt: 4 });
  cache.setSyncCursor('1', 42); cache.setSyncFetchedAt('1', 9999);
  cache.setSyncCursor('2', 7); cache.setSyncFetchedAt('2', 8888);

  cache.clearLogbook('1');

  assert.strictEqual(cache.countByLogbook('1'), 2, 'the still-queued pending/failed rows must survive the clear');
  assert.ok(cache.get('p'), 'pending QSO not yet uploaded must never be deleted by a cache clear');
  assert.ok(cache.get('fl'), 'failed-but-retryable QSO must never be deleted by a cache clear');
  assert.strictEqual(cache.get('a'), undefined, 'the already-synced row is safely re-downloadable and gets cleared');
  assert.strictEqual(cache.countByLogbook('2'), 1, 'other logbook untouched');
  assert.deepStrictEqual(cache.getSyncMeta('1'), { lastFetchId: 0, fetchedAt: null }, 'cleared logbook requires a fresh sync');
  assert.strictEqual(cache.getSyncMeta('2').lastFetchId, 7, 'other logbook\'s sync cursor untouched');
});

test('LogService.clearLogbookCache clears exactly one logbook\'s synced history without losing a queued QSO, and requires a stationId', () => {
  const settings = clone(SETTINGS_DEFAULTS);
  const log = new LogService({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cld-clear-')), client: { configured: () => false }, getSettings: () => settings });
  const synced = log.addQso({ call: 'K1AAA', freq: '14.2', mode: 'SSB' }, { stationId: '1' });
  log.cache.setState(synced.id, { state: 'synced', error: '', syncedAt: Date.now(), updatedAt: Date.now() });
  const stillPending = log.addQso({ call: 'K1CCC', freq: '14.2', mode: 'SSB' }, { stationId: '1' });
  log.addQso({ call: 'K1BBB', freq: '14.2', mode: 'SSB' }, { stationId: '2' });

  assert.throws(() => log.clearLogbookCache(''), /choose a logbook/i);
  log.clearLogbookCache('1');

  const remaining = log.localList(['pending', 'failed']).map((r) => r.id);
  assert.ok(remaining.includes(stillPending.id), 'the not-yet-uploaded QSO must survive clearing the cache');
  assert.strictEqual(log.query({ stationId: '1' }).total, 1, 'the synced row is gone but the still-pending one remains visible');
  assert.strictEqual(log.query({ stationId: '2' }).total, 1, 'other logbook untouched');
});

// ---- indexed chronological paging at scale (100,000+ rows) ----------------

test('keyset pagination over 100,000 QSOs: correct, complete, newest-first, and never uses OFFSET', { timeout: 120000 }, () => {
  // The query layer must never build an OFFSET clause - keyset/cursor paging only.
  // (Comments are allowed to mention the word; only check actual SQL string content.)
  const cacheSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'qso-cache.js'), 'utf8');
  const sqlOnly = cacheSrc.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(sqlOnly, /\bOFFSET\b/i);

  const cache = new QsoCache(tmpFile());
  const TOTAL = 100000;
  const insertMany = cache.db.transaction((n) => {
    const base = Date.UTC(2020, 0, 1);
    for (let i = 0; i < n; i++) {
      const t = new Date(base + i * 1000);
      const y = t.getUTCFullYear(); const mo = String(t.getUTCMonth() + 1).padStart(2, '0'); const da = String(t.getUTCDate()).padStart(2, '0');
      const hh = String(t.getUTCHours()).padStart(2, '0'); const mm = String(t.getUTCMinutes()).padStart(2, '0'); const ss = String(t.getUTCSeconds()).padStart(2, '0');
      cache.insertLocal({
        id: `q${i}`, logbookId: 'BIG', stationId: 'BIG',
        fields: fields(`K${String(i % 1000).padStart(4, '0')}`, { date: `${y}${mo}${da}`, time: `${hh}${mm}${ss}`, band: i % 2 ? '40m' : '20m', mode: i % 3 ? 'SSB' : 'CW' }),
        state: 'synced', source: 'manual', error: '', createdAt: i,
      });
    }
  });
  insertMany(TOTAL);
  assert.strictEqual(cache.countByLogbook('BIG'), TOTAL);

  // First page must be fast (indexed - not a full-table scan/sort) and newest first.
  const t0 = Date.now();
  const first = cache.pageQuery({ logbookId: 'BIG', band: '', mode: '', needle: '', pageSize: 50, cursor: null });
  const firstMs = Date.now() - t0;
  assert.ok(firstMs < 300, `first page should be fast via the index, took ${firstMs}ms`);
  assert.strictEqual(first.rows.length, 50);
  assert.strictEqual(first.rows[0].QSO_DATE + first.rows[0].TIME_ON > first.rows[1].QSO_DATE + first.rows[1].TIME_ON || first.rows[0].TIME_ON >= first.rows[1].TIME_ON, true);

  // Walk every page via cursor only, never an absolute offset, and confirm full, non-overlapping coverage.
  let cursor = null; let seen = 0; const ids = new Set(); let pages = 0; let prevLast = null;
  const pageT0 = Date.now();
  for (;;) {
    const { rows, nextCursor } = cache.pageQuery({ logbookId: 'BIG', band: '', mode: '', needle: '', pageSize: 500, cursor });
    if (!rows.length) break;
    for (const r of rows) { assert.ok(!ids.has(r._id), 'no row repeated across pages'); ids.add(r._id); }
    if (prevLast) assert.ok(`${prevLast.QSO_DATE}${prevLast.TIME_ON}` >= `${rows[0].QSO_DATE}${rows[0].TIME_ON}`, 'strictly newest-first across the page boundary');
    prevLast = rows[rows.length - 1];
    seen += rows.length; pages += 1;
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  const totalPagingMs = Date.now() - pageT0;
  assert.strictEqual(seen, TOTAL);
  assert.strictEqual(pages, Math.ceil(TOTAL / 500));
  // Average per-page latency should stay low and roughly flat regardless of how deep we paged -
  // an OFFSET-based scheme gets progressively slower; keyset paging does not.
  assert.ok(totalPagingMs / pages < 20, `average page latency too high for keyset paging: ${(totalPagingMs / pages).toFixed(2)}ms/page`);

  // Band/mode filters + callsign search still resolve correctly at this scale.
  const band40 = cache.countQuery({ logbookId: 'BIG', band: '40m', mode: '', needle: '' });
  assert.strictEqual(band40, TOTAL / 2);
  const callHits = cache.countQuery({ logbookId: 'BIG', band: '', mode: '', needle: 'K0001' });
  assert.strictEqual(callHits, TOTAL / 1000);

  cache.close();
});

test('LogService.query paginates via Next/Previous without offsets, staying consistent under a large logbook', () => {
  const settings = clone(SETTINGS_DEFAULTS);
  const log = new LogService({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cld-page-')), client: { configured: () => false }, getSettings: () => settings });
  const N = 250;
  for (let i = 0; i < N; i++) {
    log.cache.insertLocal({
      id: `r${i}`, logbookId: '9', stationId: '9',
      fields: fields(`K${i}`, { date: '20260101', time: String(100000 + i).padStart(6, '0') }),
      state: 'synced', source: 'manual', error: '', createdAt: i,
    });
  }
  const page1 = log.query({ stationId: '9', page: 1, pageSize: 50 });
  assert.strictEqual(page1.rows.length, 50);
  assert.strictEqual(page1.total, N);
  const page2 = log.query({ stationId: '9', page: 2, pageSize: 50 });
  assert.strictEqual(page2.rows.length, 50);
  assert.notStrictEqual(page1.rows[0].CALL, page2.rows[0].CALL);
  const back1 = log.query({ stationId: '9', page: 1, pageSize: 50 });
  assert.deepStrictEqual(back1.rows.map((r) => r.CALL), page1.rows.map((r) => r.CALL));
});

// ---- packaging: native module is unpacked from asar, declared as a production dependency ----

test('packaging config: better-sqlite3 is a production dependency and unpacked from asar', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies && pkg.dependencies['better-sqlite3'], 'better-sqlite3 must be a production dependency');
  assert.ok(!pkg.devDependencies || !pkg.devDependencies['better-sqlite3'], 'must not only be a devDependency');
  assert.ok(pkg.build && Array.isArray(pkg.build.asarUnpack) && pkg.build.asarUnpack.some((p) => /better-sqlite3/.test(p)), 'better-sqlite3 must be unpacked from asar');
  assert.strictEqual(pkg.build.asar, true);
  assert.strictEqual(pkg.version, '0.3.7');
});
