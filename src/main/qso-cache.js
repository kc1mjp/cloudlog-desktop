'use strict';
// Main-process-only SQLite repository for the offline/local QSO cache.
//
// This is the ONLY module that touches the database file or writes SQL. The
// rest of the app (LogService, IPC handlers) goes through the methods below,
// which all take plain values and return plain objects/arrays - never a
// statement, a connection, or a raw file path. Keeping SQL confined to this
// file is what lets main.js expose a narrow, validated IPC surface instead of
// letting the renderer run arbitrary queries.
//
// One SQLite database file backs the whole app; every row is scoped by
// `logbook_id` (the Cloudlog "station profile" id - what this app calls a
// logbook). QSOs added before any logbook has ever been chosen are filed
// under the UNASSIGNED sentinel below and re-filed under the real logbook id
// the moment one becomes known (see LogService.sync in logbook.js), which is
// how every row can be NOT NULL on logbook_id while still allowing fully
// offline first use.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const UNASSIGNED = '__unassigned__';

const SCHEMA_VERSION = 1;

/** Parse an ADIF-style {QSO_DATE:'YYYYMMDD', TIME_ON:'HHMMSS'|'HHMM'} pair into a UTC ms timestamp. */
function qsoTimeMs(fields) {
  const d = fields.QSO_DATE || '';
  if (!/^\d{8}$/.test(d)) return 0;
  const t = (fields.TIME_ON || '').padEnd(6, '0');
  const y = Number(d.slice(0, 4)); const mo = Number(d.slice(4, 6)); const da = Number(d.slice(6, 8));
  const hh = Number(t.slice(0, 2)) || 0; const mm = Number(t.slice(2, 4)) || 0; const ss = Number(t.slice(4, 6)) || 0;
  const ms = Date.UTC(y, mo - 1, da, hh, mm, ss);
  return Number.isFinite(ms) ? ms : 0;
}

/** Same dedupe key used historically: same call/date/minute/band/mode counts as "the same QSO". */
function dedupeKey(fields) {
  return [fields.CALL, fields.QSO_DATE, (fields.TIME_ON || '').slice(0, 4), fields.BAND, fields.MODE].join('|');
}

function deriveColumns(fields) {
  return {
    callsign: (fields.CALL || '').toUpperCase(),
    qsoTimeMs: qsoTimeMs(fields),
    band: (fields.BAND || '').toLowerCase(),
    mode: (fields.MODE || '').toUpperCase(),
    freqHz: fields.FREQ && isFinite(parseFloat(fields.FREQ)) ? Math.round(parseFloat(fields.FREQ) * 1e6) : null,
  };
}

/** Deterministic id for a server-fetched row, so re-downloading the same QSO is a no-op (ON CONFLICT DO NOTHING). */
function remoteRowId(logbookId, fields) {
  const h = crypto.createHash('sha1').update(`${logbookId}\u0000${dedupeKey(fields)}`).digest('hex').slice(0, 24);
  return `remote-${h}`;
}

function rowToFields(row) {
  const f = JSON.parse(row.fields_json);
  if (row.source !== 'remote') { f._state = row.sync_state; f._id = row.id; f._error = row.error || ''; }
  return f;
}

class QsoCache {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
    this._prepare();
  }

  // ---- schema -----------------------------------------------------------

  _migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version');
    let have = row ? Number(row.value) : 0;
    const setVersion = this.db.prepare('INSERT INTO schema_meta (key, value) VALUES (\'version\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (have < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS qsos (
          id TEXT PRIMARY KEY,
          logbook_id TEXT NOT NULL,
          station_id TEXT,
          callsign TEXT NOT NULL,
          qso_time_utc_ms INTEGER NOT NULL,
          band TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL DEFAULT '',
          freq_hz INTEGER,
          sync_state TEXT NOT NULL DEFAULT 'pending',
          source TEXT NOT NULL DEFAULT 'manual',
          error TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          synced_at INTEGER,
          fields_json TEXT NOT NULL
        );
        -- Chronological paging within one logbook (keyset pagination, newest first).
        CREATE INDEX IF NOT EXISTS idx_qsos_logbook_time ON qsos (logbook_id, qso_time_utc_ms DESC, id DESC);
        -- Callsign history / dupe checking within one logbook.
        CREATE INDEX IF NOT EXISTS idx_qsos_logbook_call_time ON qsos (logbook_id, callsign, qso_time_utc_ms DESC);
        -- Pending/failed/synced local-record lookup within one logbook.
        CREATE INDEX IF NOT EXISTS idx_qsos_logbook_state_time ON qsos (logbook_id, sync_state, qso_time_utc_ms DESC);

        CREATE TABLE IF NOT EXISTS sync_meta (
          logbook_id TEXT PRIMARY KEY,
          last_fetch_id INTEGER NOT NULL DEFAULT 0,
          fetched_at INTEGER
        );
      `);
      have = 1;
      setVersion.run(String(have));
    }
    // Future schema changes: `if (have < 2) { ...; setVersion.run('2'); have = 2; }`
  }

  _prepare() {
    this._insert = this.db.prepare(`
      INSERT INTO qsos (id, logbook_id, station_id, callsign, qso_time_utc_ms, band, mode, freq_hz,
                         sync_state, source, error, created_at, updated_at, synced_at, fields_json)
      VALUES (@id, @logbookId, @stationId, @callsign, @qsoTimeMs, @band, @mode, @freqHz,
              @state, @source, @error, @createdAt, @updatedAt, @syncedAt, @fieldsJson)
    `);
    this._insertRemote = this.db.prepare(`
      INSERT OR IGNORE INTO qsos (id, logbook_id, station_id, callsign, qso_time_utc_ms, band, mode, freq_hz,
                                   sync_state, source, error, created_at, updated_at, synced_at, fields_json)
      VALUES (@id, @logbookId, @stationId, @callsign, @qsoTimeMs, @band, @mode, @freqHz,
              'synced', 'remote', '', @createdAt, @createdAt, @createdAt, @fieldsJson)
    `);
    this._get = this.db.prepare('SELECT * FROM qsos WHERE id = ?');
    this._delete = this.db.prepare('DELETE FROM qsos WHERE id = ?');
    this._updateFields = this.db.prepare(`
      UPDATE qsos SET callsign=@callsign, qso_time_utc_ms=@qsoTimeMs, band=@band, mode=@mode, freq_hz=@freqHz,
        sync_state=@state, error=@error, updated_at=@updatedAt, fields_json=@fieldsJson WHERE id=@id
    `);
    this._setState = this.db.prepare('UPDATE qsos SET sync_state=@state, error=@error, synced_at=@syncedAt, updated_at=@updatedAt WHERE id=@id');
    this._reassignLogbook = this.db.prepare('UPDATE qsos SET logbook_id=?, station_id=? WHERE id=?');
    this._retryFailed = this.db.prepare("UPDATE qsos SET sync_state='pending', error='', updated_at=? WHERE sync_state='failed'");
    this._localStateCounts = this.db.prepare("SELECT sync_state AS state, COUNT(*) AS n FROM qsos WHERE source != 'remote' AND sync_state IN ('pending','failed') GROUP BY sync_state");
    this._hasPending = this.db.prepare("SELECT 1 FROM qsos WHERE sync_state = 'pending' LIMIT 1");
    this._listLocalByState = this.db.prepare("SELECT * FROM qsos WHERE source != 'remote' AND sync_state = ? ORDER BY created_at DESC, id DESC");
    this._listPending = this.db.prepare("SELECT * FROM qsos WHERE sync_state = 'pending' ORDER BY created_at ASC, id ASC");
    this._listLocalAll = this.db.prepare("SELECT * FROM qsos WHERE source != 'remote' ORDER BY created_at ASC, id ASC");
    this._listLocalAllDesc = this.db.prepare("SELECT * FROM qsos WHERE source != 'remote' ORDER BY created_at DESC, id DESC");

    this._getSyncMeta = this.db.prepare('SELECT last_fetch_id AS lastFetchId, fetched_at AS fetchedAt FROM sync_meta WHERE logbook_id = ?');
    this._upsertSyncCursor = this.db.prepare(`
      INSERT INTO sync_meta (logbook_id, last_fetch_id, fetched_at) VALUES (?, ?, NULL)
      ON CONFLICT(logbook_id) DO UPDATE SET last_fetch_id = excluded.last_fetch_id
    `);
    this._setFetchedAt = this.db.prepare(`
      INSERT INTO sync_meta (logbook_id, last_fetch_id, fetched_at) VALUES (?, 0, ?)
      ON CONFLICT(logbook_id) DO UPDATE SET fetched_at = excluded.fetched_at
    `);

    this._dedupeCandidates = this.db.prepare(`
      SELECT id, fields_json FROM qsos
      WHERE logbook_id = ? AND callsign = ? AND qso_time_utc_ms BETWEEN ? AND ?
    `);

    this._countByLogbook = this.db.prepare('SELECT COUNT(*) AS n FROM qsos WHERE logbook_id = ?');
    this._countRemoteByLogbook = this.db.prepare("SELECT COUNT(*) AS n FROM qsos WHERE logbook_id = ? AND source = 'remote'");
    this._countToday = this.db.prepare('SELECT COUNT(*) AS n FROM qsos WHERE logbook_id = ? AND qso_time_utc_ms >= ? AND qso_time_utc_ms < ?');

    this._callsignHistory = this.db.prepare('SELECT fields_json, source, sync_state, id, error FROM qsos WHERE logbook_id = ? AND callsign = ? AND qso_time_utc_ms >= ? ORDER BY qso_time_utc_ms DESC, id DESC');
    this._recordsSince = this.db.prepare('SELECT fields_json, source, sync_state, id, error FROM qsos WHERE logbook_id = ? AND qso_time_utc_ms >= ? ORDER BY qso_time_utc_ms DESC, id DESC');

    this._clearLogbookQsos = this.db.prepare("DELETE FROM qsos WHERE logbook_id = ? AND sync_state = 'synced'");
    this._clearLogbookMeta = this.db.prepare('DELETE FROM sync_meta WHERE logbook_id = ?');

    this._insertRemoteBatchTxn = this.db.transaction((rows) => {
      let added = 0;
      for (const row of rows) {
        const { logbookId, fields } = row;
        const cols = deriveColumns(fields);
        // Half-minute window either side, matching the original minute-precision dedupe key.
        const lo = cols.qsoTimeMs - 60000; const hi = cols.qsoTimeMs + 60000;
        const candidates = cols.callsign ? this._dedupeCandidates.all(logbookId, cols.callsign, lo, hi) : [];
        const key = dedupeKey(fields);
        const already = candidates.some((c) => dedupeKey(JSON.parse(c.fields_json)) === key);
        if (already) continue;
        const now = Date.now();
        const info = this._insertRemote.run({
          id: remoteRowId(logbookId, fields), logbookId, stationId: logbookId,
          callsign: cols.callsign, qsoTimeMs: cols.qsoTimeMs, band: cols.band, mode: cols.mode, freqHz: cols.freqHz,
          createdAt: now, fieldsJson: JSON.stringify(fields),
        });
        if (info.changes) added += 1;
      }
      return added;
    });

    this._clearLogbookTxn = this.db.transaction((logbookId) => {
      this._clearLogbookQsos.run(logbookId);
      this._clearLogbookMeta.run(logbookId);
    });
  }

  close() { this.db.close(); }

  // ---- local queue (add / edit / delete / list) --------------------------

  insertLocal({ id, logbookId, stationId, fields, state, source, error, createdAt }) {
    const cols = deriveColumns(fields);
    this._insert.run({
      id, logbookId, stationId, callsign: cols.callsign, qsoTimeMs: cols.qsoTimeMs, band: cols.band, mode: cols.mode,
      freqHz: cols.freqHz, state, source, error: error || '', createdAt, updatedAt: createdAt, syncedAt: null,
      fieldsJson: JSON.stringify(fields),
    });
  }

  get(id) { return this._get.get(id); }

  delete(id) { this._delete.run(id); }

  /** Rewrite a row's fields (an edit) and put it back in the pending queue. */
  updateFieldsAndState(id, { fields, state, error, updatedAt }) {
    const cols = deriveColumns(fields);
    this._updateFields.run({
      id, callsign: cols.callsign, qsoTimeMs: cols.qsoTimeMs, band: cols.band, mode: cols.mode, freqHz: cols.freqHz,
      state, error: error || '', updatedAt, fieldsJson: JSON.stringify(fields),
    });
  }

  setState(id, { state, error, syncedAt, updatedAt }) {
    this._setState.run({ id, state, error: error || '', syncedAt: syncedAt || null, updatedAt });
  }

  reassignLogbook(id, logbookId) { this._reassignLogbook.run(logbookId, logbookId, id); }

  retryFailedToPending() { this._retryFailed.run(Date.now()); }

  localStateCounts() {
    const out = { pending: 0, failed: 0 };
    for (const r of this._localStateCounts.all()) out[r.state] = r.n;
    return out;
  }

  hasPendingAny() { return !!this._hasPending.get(); }

  /** Local (non-remote) queue rows, newest first. `states` narrows to those sync_state values; omit for all. */
  listLocal(states) {
    if (!states || !states.length) return this._listLocalAllDesc.all();
    const out = [];
    for (const s of states) out.push(...this._listLocalByState.all(s));
    out.sort((a, b) => (b.created_at - a.created_at) || (a.id < b.id ? 1 : -1));
    return out;
  }

  listPending() { return this._listPending.all(); }

  listLocalAll() { return this._listLocalAll.all(); }

  // ---- dedupe -------------------------------------------------------------

  /** True if a QSO matching call/date/minute/band/mode already exists in this logbook. Uses the callsign index. */
  findDedupeMatch(logbookId, fields) {
    const cols = deriveColumns(fields);
    if (!cols.callsign) return null;
    const lo = cols.qsoTimeMs - 60000; const hi = cols.qsoTimeMs + 60000;
    const key = dedupeKey(fields);
    const hit = this._dedupeCandidates.all(logbookId, cols.callsign, lo, hi)
      .find((c) => dedupeKey(JSON.parse(c.fields_json)) === key);
    return hit ? hit.id : null;
  }

  // ---- remote (server-fetched) cache --------------------------------------

  getSyncMeta(logbookId) {
    return this._getSyncMeta.get(logbookId) || { lastFetchId: 0, fetchedAt: null };
  }

  setSyncCursor(logbookId, lastFetchId) { this._upsertSyncCursor.run(logbookId, lastFetchId); }

  setSyncFetchedAt(logbookId, ts) { this._setFetchedAt.run(logbookId, ts); }

  /** Insert any of `records` (parsed ADIF field objects) not already present, skipping ones that dupe an existing row. Returns count inserted. */
  upsertRemoteBatch(logbookId, records) {
    return this._insertRemoteBatchTxn(records.map((fields) => ({ logbookId, fields })));
  }

  // ---- queries used by the UI ---------------------------------------------

  countByLogbook(logbookId) { return this._countByLogbook.get(logbookId).n; }

  countRemoteByLogbook(logbookId) { return this._countRemoteByLogbook.get(logbookId).n; }

  countToday(logbookId, startMs, endMs) { return this._countToday.get(logbookId, startMs, endMs).n; }

  /** Callsign history within one logbook, newest first, optionally bounded to qso_time_utc_ms >= sinceMs. */
  callsignHistory(logbookId, callsign, sinceMs = 0) {
    return this._callsignHistory.all(logbookId, callsign, sinceMs).map(rowToFields);
  }

  /** QSOs within one logbook at/after sinceMs, newest first. */
  recordsSince(logbookId, sinceMs = 0) {
    return this._recordsSince.all(logbookId, sinceMs).map(rowToFields);
  }

  /**
   * Keyset-paginated browse of one logbook: newest first, optionally filtered by band/mode/free-text.
   * `cursor` (if given) is the {t, id} of the last row on the previous page - never an OFFSET.
   * Returns up to `pageSize` rows plus whether more exist after them.
   */
  pageQuery({ logbookId, band, mode, needle, pageSize, cursor }) {
    const where = ['logbook_id = ?']; const params = [logbookId];
    if (cursor) { where.push('(qso_time_utc_ms < ? OR (qso_time_utc_ms = ? AND id < ?))'); params.push(cursor.t, cursor.t, cursor.id); }
    if (band) { where.push('band = ?'); params.push(band); }
    if (mode) { where.push('mode = ?'); params.push(mode); }
    if (needle) { where.push('(callsign LIKE ? OR UPPER(fields_json) LIKE ?)'); params.push(`%${needle}%`, `%${needle}%`); }
    const sql = `SELECT * FROM qsos WHERE ${where.join(' AND ')} ORDER BY qso_time_utc_ms DESC, id DESC LIMIT ?`;
    params.push(pageSize + 1);
    const rows = this.db.prepare(sql).all(...params);
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return { rows: page.map(rowToFields), nextCursor: hasMore && last ? { t: last.qso_time_utc_ms, id: last.id } : null };
  }

  countQuery({ logbookId, band, mode, needle }) {
    const where = ['logbook_id = ?']; const params = [logbookId];
    if (band) { where.push('band = ?'); params.push(band); }
    if (mode) { where.push('mode = ?'); params.push(mode); }
    if (needle) { where.push('(callsign LIKE ? OR UPPER(fields_json) LIKE ?)'); params.push(`%${needle}%`, `%${needle}%`); }
    const sql = `SELECT COUNT(*) AS n FROM qsos WHERE ${where.join(' AND ')}`;
    return this.db.prepare(sql).get(...params).n;
  }

  // ---- cache clearing -------------------------------------------------------

  /**
   * Clear the local cache for exactly one logbook: every row already confirmed synced
   * (server-fetched rows, and local additions that finished uploading), plus its sync
   * cursor, in one transaction. A QSO still pending or failed upload is never touched -
   * clearing the cache must not lose work that hasn't reached the server yet.
   */
  clearLogbook(logbookId) { this._clearLogbookTxn(logbookId); }

  /** Development-only: wipe every logbook's cache. Never wired to IPC - see scripts/reset-qso-cache.js. */
  devResetAll() {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM qsos').get().n;
    this.db.exec('DELETE FROM qsos; DELETE FROM sync_meta;');
    return n;
  }
}

module.exports = { QsoCache, UNASSIGNED, qsoTimeMs, dedupeKey, deriveColumns, remoteRowId, rowToFields, SCHEMA_VERSION };
