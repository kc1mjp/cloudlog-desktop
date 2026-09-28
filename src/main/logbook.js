'use strict';
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { QsoCache, UNASSIGNED, qsoTimeMs } = require('./qso-cache');
const { parseAdif, generateAdif } = require('./adif');
const { freqToBand, nowUtc } = require('./bands');

// Fields kept from server downloads (keeps the cache small).
const KEEP = ['CALL', 'QSO_DATE', 'TIME_ON', 'BAND', 'MODE', 'SUBMODE', 'FREQ', 'RST_SENT', 'RST_RCVD', 'NAME', 'QTH',
  'GRIDSQUARE', 'COUNTRY', 'COMMENT', 'SOTA_REF', 'POTA_REF', 'SIG', 'SIG_INFO', 'IOTA', 'CONTEST_ID', 'STX', 'SRX',
  'STX_STRING', 'SRX_STRING', 'STATION_CALLSIGN'];

const slim = (r) => { const o = {}; for (const k of KEEP) if (r[k]) o[k] = r[k]; return o; };

class LogService extends EventEmitter {
  constructor({ dir, client, getSettings, dbFile }) {
    super();
    this.dir = dir;
    this.client = client;
    this.getSettings = getSettings;
    this.cache = new QsoCache(dbFile || path.join(dir, 'qsocache.sqlite3'));
    this.online = null;
    this.syncing = false;
    this.lastError = '';
    this.lastSync = null;
    this._timer = null;
    // Start the retry clock at "now" - otherwise the first pending QSO after
    // startup looks like its retry interval has already elapsed. The ping
    // clock stays at 0 so we still confirm connectivity shortly after start.
    this._lastTick = Date.now();
    this._lastPing = 0;
    // Keyset-pagination cursor stacks, keyed by station+filters+pageSize. Cleared
    // whenever the underlying data changes so a stale cursor never serves stale
    // paging - the UI simply falls back to page 1 in that (rare) case.
    this._cursorState = new Map();
    // Any row left mid-upload from a previous run (crash, force-quit) goes back
    // to pending rather than being silently stuck as "syncing" forever.
    for (const row of this.cache.listLocal(['syncing'])) this.cache.setState(row.id, { state: 'pending', error: '', updatedAt: Date.now() });
  }

  start() {
    this._timer = setInterval(() => this._tick(), 2000);
    this._tick();
  }

  stop() {
    clearInterval(this._timer);
    this.cache.close();
  }

  // ---- adding ---------------------------------------------------------

  normalize(input) {
    const f = {};
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (s !== '') f[k.toUpperCase()] = s;
    }
    if (!f.CALL) throw new Error('Callsign is required');
    f.CALL = f.CALL.toUpperCase();
    if (!/^[A-Z0-9\/]{3,}$/.test(f.CALL) || !/\d/.test(f.CALL) || !/[A-Z]/.test(f.CALL)) throw new Error(`"${f.CALL}" does not look like a callsign`);
    const now = nowUtc();
    f.QSO_DATE = (f.QSO_DATE || now.date).replace(/-/g, '');
    f.TIME_ON = (f.TIME_ON || now.time).replace(/:/g, '');
    if (f.TIME_ON.length === 4) f.TIME_ON += '00';
    if (!f.TIME_OFF) f.TIME_OFF = f.TIME_ON;
    if (f.FREQ) {
      const n = parseFloat(f.FREQ);
      if (isFinite(n)) f.FREQ = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
      if (!f.BAND) f.BAND = freqToBand(n);
    }
    if (f.BAND) f.BAND = f.BAND.toLowerCase();
    if (!f.MODE) throw new Error('Mode is required');
    f.MODE = f.MODE.toUpperCase();
    if (!f.BAND) throw new Error('Band or frequency is required');
    return f;
  }

  addQso(input, { source = 'manual', stationId = null, dedupe = false } = {}) {
    const fields = this.normalize(input);
    const logbookId = String(stationId || this.getSettings().cloudlog.currentStationId || UNASSIGNED);
    if (dedupe && this.cache.findDedupeMatch(logbookId, fields)) return null;
    const id = crypto.randomUUID();
    const now = Date.now();
    this.cache.insertLocal({
      id, logbookId, stationId: logbookId === UNASSIGNED ? null : logbookId, fields,
      state: 'pending', source, error: '', createdAt: now,
    });
    this._cursorState.clear();
    this.emit('changed');
    if (this.getSettings().sync.instant !== false) setImmediate(() => this.sync());
    return { id, fields, stationId: logbookId === UNASSIGNED ? null : logbookId, state: 'pending', error: '', source, created: now };
  }

  // ---- local queue ----------------------------------------------------

  localList(states) {
    return this.cache.listLocal(states).map((row) => ({
      id: row.id, fields: JSON.parse(row.fields_json), stationId: row.station_id, state: row.sync_state,
      error: row.error || '', source: row.source, created: row.created_at,
    }));
  }

  deleteLocal(id) {
    if (!this.cache.get(id)) return;
    this.cache.delete(id);
    this._cursorState.clear();
    this.emit('changed');
    this.emit('status');
  }

  /** Edit a QSO that hasn't uploaded yet (pending or failed). Puts it back in the queue. */
  updateLocal(id, patch) {
    const row = this.cache.get(id);
    if (!row) throw new Error('That QSO is no longer in the queue');
    if (row.sync_state === 'synced') throw new Error('Already uploaded - it can only be edited on the server');
    const fields = this.normalize({ ...JSON.parse(row.fields_json), ...patch });
    this.cache.updateFieldsAndState(id, { fields, state: 'pending', error: '', updatedAt: Date.now() });
    this._cursorState.clear();
    this.emit('changed');
    if (this.getSettings().sync.instant !== false) setImmediate(() => this.sync());
    return { id, fields, state: 'pending', error: '' };
  }

  retryFailed() {
    this.cache.retryFailedToPending();
    this.emit('changed');
    return this.sync();
  }

  exportLocalAdif() {
    const head = generateAdif({}, { header: true }).replace(/<EOR>\n$/, '');
    return head + this.cache.listLocalAll().map((row) => generateAdif(JSON.parse(row.fields_json))).join('');
  }

  // ---- upload ---------------------------------------------------------

  status() {
    const cfg = this.getSettings();
    const counts = this.cache.localStateCounts();
    return {
      configured: this.client.configured(),
      online: this.online,
      syncing: this.syncing,
      paused: !!cfg.sync.paused,
      pending: counts.pending,
      failed: counts.failed,
      lastSync: this.lastSync,
      lastError: this.lastError,
    };
  }

  async _tick() {
    const cfg = this.getSettings();
    const now = Date.now();
    if (!this.client.configured() || cfg.sync.paused) {
      if (this.online !== null && cfg.sync.paused) { this.online = null; this.emit('status'); }
      return;
    }
    const pending = this.cache.hasPendingAny();
    if (pending && cfg.sync.auto && now - this._lastTick >= (cfg.sync.intervalSec || 20) * 1000) {
      this._lastTick = now;
      await this.sync();
    } else if (!pending && now - this._lastPing >= 60000) {
      await this.ping();
    }
  }

  async ping() {
    this._lastPing = Date.now();
    if (!this.client.configured()) return;
    try {
      const r = await this.client.auth();
      this.online = true;
      this.lastError = r.valid ? '' : r.message;
    } catch (e) {
      this.online = false;
      this.lastError = e.message;
    }
    this.emit('status');
  }

  async sync() {
    if (this.syncing || !this.client.configured() || this.getSettings().sync.paused) return this.status();
    this._lastTick = Date.now();
    this.syncing = true;
    this.emit('status');
    try {
      for (const row of this.cache.listPending()) {
        const cur = this.getSettings().cloudlog.currentStationId;
        const sid = (row.logbook_id !== UNASSIGNED ? row.logbook_id : null) || (cur ? String(cur) : null);
        if (!sid) { this.lastError = 'Choose a logbook before uploading'; break; }
        if (sid !== row.logbook_id) this.cache.reassignLogbook(row.id, sid);
        let res;
        try {
          res = await this.client.postQso(generateAdif(JSON.parse(row.fields_json)), sid);
        } catch (e) {
          this.lastError = e.message;
          this.online = e.retry ? false : true;
          break;
        }
        this.online = true;
        this.lastError = '';
        const now = Date.now();
        if (res.ok || res.duplicate) {
          this.cache.setState(row.id, { state: 'synced', error: res.duplicate ? 'Already on server' : '', syncedAt: now, updatedAt: now });
          this.lastSync = now;
        } else {
          this.cache.setState(row.id, { state: 'failed', error: res.message, updatedAt: now });
        }
        this._cursorState.clear();
        this.emit('changed');
      }
    } finally {
      this.syncing = false;
      this.emit('status');
    }
    return this.status();
  }

  // ---- server logbook cache ---------------------------------------------

  async refreshRemote(stationId, { full = false } = {}) {
    const logbookId = String(stationId);
    if (full) this.cache.clearLogbook(logbookId);
    let from = full ? 0 : (this.cache.getSyncMeta(logbookId).lastFetchId || 0);
    let added = 0;
    for (let i = 0; i < 200; i++) {
      const j = await this.client.getContactsAdif(stationId, from);
      const n = Number(j.exported_qsos || 0);
      if (!n || !j.adif) break;
      const { records } = parseAdif(Buffer.from(j.adif, 'utf8').toString('latin1'));
      added += this.cache.upsertRemoteBatch(logbookId, records.map(slim));
      const last = Number(j.lastfetchedid);
      if (!(last > from)) break;
      from = last;
      this.cache.setSyncCursor(logbookId, last);
      this.emit('progress', { stationId, added });
    }
    this.cache.setSyncFetchedAt(logbookId, Date.now());
    this._cursorState.clear();
    this.online = true;
    this.emit('changed');
    return { added, total: this.cache.countByLogbook(logbookId) };
  }

  /**
   * Clear the local cache for one logbook only: rows already confirmed synced with the
   * server, plus its sync cursor. Pending/failed (not-yet-uploaded) QSOs are preserved.
   * Marks the logbook for a fresh download next time it's viewed/refreshed.
   */
  clearLogbookCache(stationId) {
    if (!stationId) throw new Error('Choose a logbook first');
    this.cache.clearLogbook(String(stationId));
    this._cursorState.clear();
    this.emit('changed');
  }

  query({ stationId, q = '', band = '', mode = '', page = 1, pageSize = 50 }) {
    if (!stationId) return { rows: [], total: 0, page: 1, pageSize, fetchedAt: null, cached: 0 };
    const logbookId = String(stationId);
    const needle = q.trim().toUpperCase();
    const key = JSON.stringify([logbookId, needle, band, mode, pageSize]);
    let st = this._cursorState.get(key);
    if (!st) { st = { cursors: [null] }; this._cursorState.set(key, st); }
    const p = Math.max(1, Math.min(page, st.cursors.length));
    const cursor = st.cursors[p - 1];
    const { rows, nextCursor } = this.cache.pageQuery({ logbookId, band, mode, needle, pageSize, cursor });
    if (p === st.cursors.length && nextCursor) st.cursors.push(nextCursor);
    const total = this.cache.countQuery({ logbookId, band, mode, needle });
    const meta = this.cache.getSyncMeta(logbookId);
    return { rows, total, page: p, pageSize, fetchedAt: meta.fetchedAt, cached: this.cache.countRemoteByLogbook(logbookId) };
  }

  /** Callsign history within one logbook, newest first. Uses the (logbook_id, callsign, time) index. */
  callsignHistory(stationId, call, sinceMs = 0) {
    if (!stationId) return [];
    return this.cache.callsignHistory(String(stationId), (call || '').toUpperCase(), sinceMs);
  }

  /** QSOs within one logbook at/after sinceMs, newest first. Uses the (logbook_id, time) index. */
  recordsSince(stationId, sinceMs = 0) {
    if (!stationId) return [];
    return this.cache.recordsSince(String(stationId), sinceMs);
  }

  /** All known QSOs for a logbook matching a predicate (generic fallback; prefer callsignHistory/recordsSince). */
  records(stationId, pred) {
    return this.recordsSince(stationId, 0).filter(pred);
  }

  /** Parse the app's "YYYYMMDDHHMMSS" contest-since stamp into a UTC ms timestamp. */
  static stampToMs(stamp) {
    return qsoTimeMs({ QSO_DATE: (stamp || '').slice(0, 8), TIME_ON: (stamp || '').slice(8, 14) });
  }

  workedBefore(call, stationId) {
    const hits = this.callsignHistory(stationId, call);
    if (!hits.length) return { count: 0 };
    const last = hits[0];
    return {
      count: hits.length,
      last: { date: last.QSO_DATE, band: last.BAND, mode: last.MODE },
      bands: [...new Set(hits.map((h) => h.BAND))],
      recent: hits.slice(0, 20).map((h) => ({ date: h.QSO_DATE, time: h.TIME_ON, band: h.BAND, mode: h.MODE, my_ref: h.SOTA_REF || h.POTA_REF || '' })),
    };
  }

  stats(stationId) {
    if (!stationId) return { total: 0, today: 0, recent: [] };
    const logbookId = String(stationId);
    const today = nowUtc().date;
    const startMs = qsoTimeMs({ QSO_DATE: today, TIME_ON: '000000' });
    const { rows: recent } = this.cache.pageQuery({ logbookId, band: '', mode: '', needle: '', pageSize: 10, cursor: null });
    return { total: this.cache.countByLogbook(logbookId), today: this.cache.countToday(logbookId, startMs, startMs + 86400000), recent };
  }
}

module.exports = { LogService };
