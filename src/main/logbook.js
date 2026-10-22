'use strict';
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { QsoCache, UNASSIGNED, qsoTimeMs } = require('./qso-cache');
const { parseAdif, generateAdif } = require('./adif');
const { freqToBand, nowUtc } = require('./bands');
const { normalizeCall } = require('../renderer/callbook-shared');

// Fields kept from server downloads (keeps the cache small).
const KEEP = ['CALL', 'QSO_DATE', 'TIME_ON', 'BAND', 'MODE', 'SUBMODE', 'FREQ', 'RST_SENT', 'RST_RCVD', 'NAME', 'QTH',
  'GRIDSQUARE', 'COUNTRY', 'COMMENT', 'SOTA_REF', 'POTA_REF', 'SIG', 'SIG_INFO', 'IOTA', 'CONTEST_ID', 'STX', 'SRX',
  'STX_STRING', 'SRX_STRING', 'STATION_CALLSIGN'];

const slim = (r) => { const o = {}; for (const k of KEEP) if (r[k]) o[k] = r[k]; return o; };

class LogService extends EventEmitter {
  constructor({ dir, client, getSettings, dbFile, enricher = null }) {
    super();
    this.dir = dir;
    this.enricher = enricher; // callbook enrichment (callbook/enrich.js); without one QSOs are stored exactly as given
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

  addQso(input, opts = {}) {
    return this._store(this.normalize(input), opts);
  }

  /**
   * addQso for the five new-contact paths (Live QSO, Quick log, TCP, UDP, multicast): the lookup, when the settings
   * call for one, happens before the QSO is stored so the upload already carries what it found. The input is
   * normalised first - that fixes any default date/time and validates the QSO - so a slow lookup can never move the
   * timestamp, and a duplicate is rejected before a lookup is spent on it. Lookup trouble never blocks the QSO.
   */
  async addQsoWithLookup(input, opts = {}) {
    const fields = this.normalize(input);
    if (!this.enricher) return this._store(fields, opts);
    if (opts.dedupe && this.cache.findDedupeMatch(this._targetLogbook(opts), fields)) return null;
    return this._store(await this.enricher.enrichNew(fields), opts); // _store checks for a duplicate again: one may have arrived meanwhile
  }

  _targetLogbook({ stationId = null } = {}) {
    return String(stationId || this.getSettings().cloudlog.currentStationId || UNASSIGNED);
  }

  _store(fields, { source = 'manual', stationId = null, dedupe = false } = {}) {
    const logbookId = this._targetLogbook({ stationId });
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
      id: row.id, fields: JSON.parse(row.fields_json), stationId: row.station_id, logbookId: row.logbook_id, state: row.sync_state,
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
      for (const queued of this.cache.listPending()) {
        // Earlier rows awaited the network (upload, lookup), so look at this one as it is now: it may have been
        // edited, deleted or uploaded in the meantime.
        let row = this.cache.get(queued.id);
        if (!row || row.sync_state !== 'pending') continue;
        const cur = this.getSettings().cloudlog.currentStationId;
        const sid = (row.logbook_id !== UNASSIGNED ? row.logbook_id : null) || (cur ? String(cur) : null);
        if (!sid) { this.lastError = 'Choose a logbook before uploading'; break; }
        if (sid !== row.logbook_id) this.cache.reassignLogbook(row.id, sid);
        await this._enrichForUpload(row.id); // never throws; the QSO uploads as it is when nothing could be added
        row = this.cache.get(row.id);
        if (!row || row.sync_state !== 'pending') continue;
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

  /**
   * Immediately before a queued QSO is uploaded: fill what the enabled "On upload" switches allow from the callbook
   * and save it on the stored QSO itself (not just in the provider's result cache), so it survives a restart and is
   * still there when a failed upload is retried. Works the same for QSOs saved before these switches existed.
   * The row is read again after the lookup: the merge only fills what is still missing in the QSO as it is now, and
   * is dropped if the QSO was meanwhile removed, uploaded or given a different callsign - a slow lookup never
   * overwrites a newer edit.
   */
  async _enrichForUpload(id) {
    if (!this.enricher) return;
    try {
      let row = this.cache.get(id);
      if (!row || row.sync_state !== 'pending') return;
      const plan = this.enricher.plan(JSON.parse(row.fields_json), 'upload');
      if (!plan) return;
      const result = await this.enricher.fetch(plan); // one lookup serves every category that needs data
      if (!result) return;
      row = this.cache.get(id);
      if (!row || row.sync_state !== 'pending') return;
      const fields = JSON.parse(row.fields_json);
      if (normalizeCall(fields.CALL) !== plan.call) return;
      const { fields: merged, filled } = this.enricher.merge(fields, result, plan.cats);
      if (!filled.length) return;
      this.cache.updateFieldsOnly(id, { fields: merged, updatedAt: Date.now() });
      this._cursorState.clear();
      this.emit('changed');
    } catch { /* lookup or storage trouble must never stop the upload */ }
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

  /** Forget keyset cursors (collection membership / selection changed, or the data did). The next page request restarts at page 1. */
  invalidateScopeCaches() { this._cursorState.clear(); }

  /**
   * Browse QSOs. The scope is `logbookIds` (a resolved collection or logbook scope) or the older single `stationId`.
   * With neither, or with an empty list, the result is empty: this never falls back to every QSO. The scope is applied
   * in the SQL before counting and paging, over one table, so a QSO can never appear twice.
   */
  query({ stationId, logbookIds, q = '', band = '', mode = '', page = 1, pageSize = 50 }) {
    const ids = [...new Set((logbookIds || (stationId ? [stationId] : [])).map(String).filter(Boolean))];
    if (!ids.length) return { rows: [], total: 0, page: 1, pageSize, fetchedAt: null, cached: 0 };
    const needle = q.trim().toUpperCase();
    const key = JSON.stringify([[...ids].sort(), needle, band, mode, pageSize]);
    let st = this._cursorState.get(key);
    if (!st) { st = { cursors: [null] }; this._cursorState.set(key, st); }
    const p = Math.max(1, Math.min(page, st.cursors.length));
    const cursor = st.cursors[p - 1];
    const { rows, nextCursor } = this.cache.pageQuery({ logbookIds: ids, band, mode, needle, pageSize, cursor });
    if (p === st.cursors.length && nextCursor) st.cursors.push(nextCursor);
    const total = this.cache.countQuery({ logbookIds: ids, band, mode, needle });
    // "Server data from": the oldest download among the logbooks in view; unknown while any of them was never downloaded.
    const fetched = ids.map((id) => this.cache.getSyncMeta(id).fetchedAt);
    const fetchedAt = fetched.every(Boolean) ? Math.min(...fetched) : null;
    return { rows, total, page: p, pageSize, fetchedAt, cached: this.cache.countRemoteByLogbooks(ids) };
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

  /**
   * Dashboard numbers for a scope (`logbookIds`, or a single logbook id for older callers). Totals count stored and
   * queued rows the same way they always have (a queued QSO is a row in the same table, so it is counted once and stays
   * counted once when it becomes stored). `queue` splits the not-yet-uploaded QSOs by actual owner: those in this scope
   * are what the Dashboard displays; `other*` are elsewhere (never assigned to the current Active logbook by inference).
   */
  stats(scope) {
    const ids = [...new Set((Array.isArray(scope) ? scope : scope ? [scope] : []).map(String).filter(Boolean))];
    const queue = this.cache.queueCountsByLogbooks(ids);
    if (!ids.length) return { total: 0, today: 0, recent: [], queue };
    const today = nowUtc().date;
    const startMs = qsoTimeMs({ QSO_DATE: today, TIME_ON: '000000' });
    // Scope first, then the limit: the ten newest QSOs *of the scope*.
    const { rows: recent } = this.cache.pageQuery({ logbookIds: ids, band: '', mode: '', needle: '', pageSize: 10, cursor: null });
    return { total: this.cache.countByLogbooks(ids), today: this.cache.countTodayLogbooks(ids, startMs, startMs + 86400000), recent, queue };
  }
}

module.exports = { LogService };
