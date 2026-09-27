'use strict';
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { JsonStore } = require('./store');
const { parseAdif, generateAdif } = require('./adif');
const { freqToBand, nowUtc } = require('./bands');

// Fields kept from server downloads (keeps the cache small).
const KEEP = ['CALL', 'QSO_DATE', 'TIME_ON', 'BAND', 'MODE', 'SUBMODE', 'FREQ', 'RST_SENT', 'RST_RCVD', 'NAME', 'QTH',
  'GRIDSQUARE', 'COUNTRY', 'COMMENT', 'SOTA_REF', 'POTA_REF', 'SIG', 'SIG_INFO', 'IOTA', 'CONTEST_ID', 'STX', 'SRX',
  'STX_STRING', 'SRX_STRING', 'STATION_CALLSIGN'];

const slim = (r) => { const o = {}; for (const k of KEEP) if (r[k]) o[k] = r[k]; return o; };
const sortKey = (f) => `${f.QSO_DATE || ''}${f.TIME_ON || ''}`;
const dupeKey = (f) => [f.CALL, f.QSO_DATE, (f.TIME_ON || '').slice(0, 4), f.BAND, f.MODE].join('|');

class LogService extends EventEmitter {
  constructor({ dir, client, getSettings }) {
    super();
    this.dir = dir;
    this.client = client;
    this.getSettings = getSettings;
    this.local = new JsonStore(path.join(dir, 'qsos.json'), { qsos: [] });
    this.remote = new Map();
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
    for (const r of this.local.data.qsos) if (r.state === 'syncing') r.state = 'pending';
  }

  start() {
    this._timer = setInterval(() => this._tick(), 2000);
    this._tick();
  }

  stop() {
    clearInterval(this._timer);
    this.local.saveNow();
    for (const s of this.remote.values()) s.saveNow();
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
    if (dedupe) {
      const k = dupeKey(fields);
      if (this.local.data.qsos.some((r) => dupeKey(r.fields) === k)) return null;
    }
    const rec = {
      id: crypto.randomUUID(), fields, stationId: stationId || null, state: 'pending',
      error: '', source, created: Date.now(),
    };
    this.local.data.qsos.push(rec);
    this.local.saveNow();
    this.emit('changed');
    if (this.getSettings().sync.instant !== false) setImmediate(() => this.sync());
    return rec;
  }

  // ---- local queue ----------------------------------------------------

  localList(states) {
    return this.local.data.qsos.filter((r) => !states || states.includes(r.state)).slice().reverse();
  }

  deleteLocal(id) {
    const i = this.local.data.qsos.findIndex((r) => r.id === id);
    if (i >= 0) { this.local.data.qsos.splice(i, 1); this.local.saveNow(); this.emit('changed'); this.emit('status'); }
  }

  /** Edit a QSO that hasn't uploaded yet (pending or failed). Puts it back in the queue. */
  updateLocal(id, patch) {
    const rec = this.local.data.qsos.find((r) => r.id === id);
    if (!rec) throw new Error('That QSO is no longer in the queue');
    if (rec.state === 'synced') throw new Error('Already uploaded - it can only be edited on the server');
    rec.fields = this.normalize({ ...rec.fields, ...patch });
    rec.state = 'pending';
    rec.error = '';
    this.local.saveNow();
    this.emit('changed');
    if (this.getSettings().sync.instant !== false) setImmediate(() => this.sync());
    return rec;
  }

  retryFailed() {
    for (const r of this.local.data.qsos) if (r.state === 'failed') { r.state = 'pending'; r.error = ''; }
    this.local.saveNow();
    this.emit('changed');
    return this.sync();
  }

  exportLocalAdif() {
    const head = generateAdif({}, { header: true }).replace(/<EOR>\n$/, '');
    return head + this.local.data.qsos.map((r) => generateAdif(r.fields)).join('');
  }

  // ---- upload ---------------------------------------------------------

  status() {
    const q = this.local.data.qsos;
    const cfg = this.getSettings();
    return {
      configured: this.client.configured(),
      online: this.online,
      syncing: this.syncing,
      paused: !!cfg.sync.paused,
      pending: q.filter((r) => r.state === 'pending').length,
      failed: q.filter((r) => r.state === 'failed').length,
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
    const pending = this.local.data.qsos.some((r) => r.state === 'pending');
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
      for (const rec of this.local.data.qsos.filter((r) => r.state === 'pending')) {
        const sid = rec.stationId || this.getSettings().cloudlog.currentStationId;
        if (!sid) { this.lastError = 'Choose a logbook before uploading'; break; }
        let res;
        try {
          res = await this.client.postQso(generateAdif(rec.fields), sid);
        } catch (e) {
          this.lastError = e.message;
          this.online = e.retry ? false : true;
          break;
        }
        this.online = true;
        this.lastError = '';
        rec.stationId = sid;
        if (res.ok || res.duplicate) {
          rec.state = 'synced';
          rec.error = res.duplicate ? 'Already on server' : '';
          rec.syncedAt = Date.now();
          this.lastSync = Date.now();
        } else {
          rec.state = 'failed';
          rec.error = res.message;
        }
        this.local.saveNow();
        this.emit('changed');
      }
      this._prune();
    } finally {
      this.syncing = false;
      this.emit('status');
    }
    return this.status();
  }

  _prune() {
    const synced = this.local.data.qsos.filter((r) => r.state === 'synced');
    if (synced.length > 1000) {
      const drop = new Set(synced.slice(0, synced.length - 1000).map((r) => r.id));
      this.local.data.qsos = this.local.data.qsos.filter((r) => !drop.has(r.id));
      this.local.saveNow();
    }
  }

  // ---- server logbook cache ---------------------------------------------

  _remote(stationId) {
    const id = String(stationId);
    if (!this.remote.has(id)) {
      this.remote.set(id, new JsonStore(path.join(this.dir, `remote-${id.replace(/\W/g, '_')}.json`), { lastId: 0, fetchedAt: null, qsos: [] }));
    }
    return this.remote.get(id);
  }

  async refreshRemote(stationId, { full = false } = {}) {
    const store = this._remote(stationId);
    if (full) { store.data.lastId = 0; store.data.qsos = []; }
    let from = store.data.lastId || 0;
    let added = 0;
    for (let i = 0; i < 200; i++) {
      const j = await this.client.getContactsAdif(stationId, from);
      const n = Number(j.exported_qsos || 0);
      if (!n || !j.adif) break;
      const { records } = parseAdif(Buffer.from(j.adif, 'utf8').toString('latin1'));
      for (const r of records) store.data.qsos.push(slim(r));
      added += records.length;
      const last = Number(j.lastfetchedid);
      if (!(last > from)) break;
      from = last;
      store.data.lastId = last;
      this.emit('progress', { stationId, added });
    }
    store.data.fetchedAt = Date.now();
    store._sorted = null;
    store.saveNow();
    this.online = true;
    this.emit('changed');
    return { added, total: store.data.qsos.length };
  }

  _all(stationId) {
    const store = this._remote(stationId);
    if (!store._sorted) store._sorted = store.data.qsos.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1));
    const cur = this.getSettings().cloudlog.currentStationId;
    const seen = new Set(store._sorted.map(dupeKey));
    const extra = [];
    for (const r of this.local.data.qsos) {
      if (String(r.stationId || cur) !== String(stationId)) continue;
      if (r.state === 'synced' && seen.has(dupeKey(r.fields))) continue;
      extra.push({ ...r.fields, _state: r.state, _id: r.id, _error: r.error });
    }
    if (!extra.length) return store._sorted;
    return extra.concat(store._sorted).sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1));
  }

  query({ stationId, q = '', band = '', mode = '', page = 1, pageSize = 50 }) {
    if (!stationId) return { rows: [], total: 0, page: 1, pageSize, fetchedAt: null, cached: 0 };
    const store = this._remote(stationId);
    let rows = this._all(stationId);
    const needle = q.trim().toUpperCase();
    if (needle || band || mode) {
      rows = rows.filter((r) => {
        if (band && r.BAND !== band) return false;
        if (mode && r.MODE !== mode) return false;
        if (!needle) return true;
        return ['CALL', 'NAME', 'QTH', 'GRIDSQUARE', 'COMMENT', 'SOTA_REF', 'POTA_REF', 'SIG_INFO', 'CONTEST_ID']
          .some((k) => r[k] && r[k].toUpperCase().includes(needle));
      });
    }
    const start = (page - 1) * pageSize;
    return { rows: rows.slice(start, start + pageSize), total: rows.length, page, pageSize, fetchedAt: store.data.fetchedAt, cached: store.data.qsos.length };
  }

  /** All known QSOs for a logbook matching a predicate (used for dupe checks). */
  records(stationId, pred) {
    return stationId ? this._all(stationId).filter(pred) : [];
  }

  workedBefore(call, stationId) {
    const c = (call || '').toUpperCase();
    const hits = this.records(stationId, (r) => r.CALL === c);
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
    const today = nowUtc().date;
    const all = stationId ? this._all(stationId) : [];
    return { total: all.length, today: all.filter((r) => r.QSO_DATE === today).length, recent: all.slice(0, 10) };
  }
}

module.exports = { LogService };
