'use strict';
/*
 * Callsign helpers, external profile URLs and the Live QSO lookup coordinator.
 *
 * This file is plain JavaScript with no DOM or Electron dependencies so it can be
 * loaded by the renderer (as a classic <script>, exposing window.CallbookShared)
 * and required by the main process and the node:test suites.
 */
(function factory(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CallbookShared = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  /** Same normalisation the Live QSO page has always applied: strip whitespace, uppercase. */
  const normalizeCall = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();

  /**
   * Loose sanity check, not a licence-format validator: 3-15 characters from A-Z, 0-9 and "/",
   * containing at least one letter and one digit, no empty "/" segments, at most three segments.
   * Rejects things like "AB", "12345", "W1AW//P" and anything with path/URL characters.
   */
  function isValidCallsign(v) {
    const c = normalizeCall(v);
    if (c.length < 3 || c.length > 15) return false;
    if (!/^[A-Z0-9]+(\/[A-Z0-9]+){0,2}$/.test(c)) return false;
    return /[A-Z]/.test(c) && /\d/.test(c);
  }

  /** Percent-encode each path segment but keep "/" so portable calls read like QRZ's own URLs. */
  const encodeCallPath = (call) => call.split('/').map(encodeURIComponent).join('/');

  const PROFILE_BASES = {
    qrz: 'https://www.qrz.com/db/',
    hamqth: 'https://www.hamqth.com/',
  };

  /** Profile page URL for a provider, or null when the callsign is not valid. No network access. */
  function profileUrl(provider, callsign) {
    const base = Object.prototype.hasOwnProperty.call(PROFILE_BASES, provider) ? PROFILE_BASES[provider] : undefined;
    const call = normalizeCall(callsign);
    if (!base || !isValidCallsign(call)) return null;
    return `${base}${encodeCallPath(call)}`;
  }

  const LOOKUP_FIELDS = ['name', 'qth', 'grid'];
  // Results that cost nothing to repeat (no network was involved), so the coordinator may retry them.
  const RETRYABLE_STATUSES = new Set(['offline', 'not_configured', 'disabled']);

  /**
   * Drives callbook lookups for the Live QSO form.
   *
   *  - performs no lookup while the operator is typing; flush() (called on leaving the
   *    callsign field) is the only thing that triggers a request
   *  - never asks twice for the same normalised callsign
   *  - never overwrites a field the operator edited during this QSO entry
   *  - replaces values it filled itself when the callsign changes, so stale data never sticks
   *  - never throws: a failed lookup only produces a status for the UI
   */
  class LookupCoordinator {
    /**
     * @param {object} o
     * @param {Object<string,{get:()=>string,set:(v:string)=>void}>} o.fields  name / qth / grid accessors
     * @param {(call:string)=>Promise<object>} o.lookup   resolves a normalised result object
     * @param {(status:object|null)=>void} [o.onStatus]
     */
    constructor({ fields, lookup, onStatus = () => {} }) {
      Object.assign(this, { fields, lookup, onStatus });
      this.seq = 0;
      this.reset();
    }

    reset() {
      this.seq += 1; // invalidates any lookup still in flight
      this.call = '';
      this.lastKey = null;
      this.touched = {};
      this.auto = {};
      this.onStatus(null);
    }

    /** The operator typed in one of the lookup fields: from now on it is theirs. */
    touch(key) { if (LOOKUP_FIELDS.includes(key)) this.touched[key] = true; }

    /** Callsign input changed. Tracks state only - never triggers a lookup by itself. */
    input(raw) {
      const call = normalizeCall(raw);
      if (call !== this.call) {
        this._clearAutoValues();
        this.call = call;
        this.lastKey = null;
        this.seq += 1;
        this.onStatus(null);
      }
    }

    /** Callsign field left (blur): the only place a lookup is triggered. */
    flush() {
      if (isValidCallsign(this.call)) return this._run(this.call);
      return Promise.resolve();
    }

    _clearAutoValues() {
      for (const k of LOOKUP_FIELDS) {
        const f = this.fields[k];
        if (!f || this.touched[k] || this.auto[k] === undefined) continue;
        if (f.get() === this.auto[k]) f.set('');
        delete this.auto[k];
      }
    }

    async _run(call) {
      if (this.lastKey === call) return; // already asked for this callsign
      this.lastKey = call;
      const mine = ++this.seq;
      let res;
      try {
        res = await this.lookup(call);
      } catch {
        res = { status: 'error', message: 'Callbook lookup failed. You can keep logging.' };
      }
      if (mine !== this.seq || call !== this.call) return; // the operator moved on
      if (!res || typeof res !== 'object') res = { status: 'error', message: 'Callbook lookup failed. You can keep logging.' };
      if (RETRYABLE_STATUSES.has(res.status)) this.lastKey = null;
      if (res.status === 'ok') this._apply(res);
      this.onStatus(res);
    }

    _apply(res) {
      for (const k of LOOKUP_FIELDS) {
        const f = this.fields[k];
        const v = typeof res[k] === 'string' ? res[k] : '';
        if (!f || !v || this.touched[k]) continue;
        const cur = f.get();
        if (cur === '' || cur === this.auto[k]) { f.set(v); this.auto[k] = v; }
      }
    }
  }

  return { normalizeCall, isValidCallsign, profileUrl, PROFILE_BASES, LookupCoordinator, LOOKUP_FIELDS };
});
