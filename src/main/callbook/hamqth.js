'use strict';
const crypto = require('crypto');
const { request, CallbookError } = require('./http');
const { tag, block, clean, cleanGrid, firstWord } = require('./text');
const { makeResult, missingConfigMessage } = require('./results');

const SESSION_TTL_MS = 55 * 60 * 1000; // HamQTH session ids live one hour; renew a little early

/**
 * HamQTH XML callbook (https://www.hamqth.com/developers.php):
 *   1. GET xml.php?u=<user>&p=<password>            -> <session_id>   (valid one hour)
 *   2. GET xml.php?id=<session_id>&callsign=<call>&prg=<program>
 * The session id is kept in memory only, reused until it expires, and never persisted, logged or sent to the renderer.
 */
class HamQthProvider {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, baseUrl = 'https://www.hamqth.com/xml.php', timeoutMs = 8000, program = 'CloudlogDesktop' } = {}) {
    Object.assign(this, { fetchImpl, now, baseUrl, timeoutMs, program });
    this.id = 'hamqth';
    this.label = 'HamQTH';
    this.session = null; // { id, fp, exp }
    this.loginInFlight = null;
  }

  configured(cfg) { return !!(cfg && cfg.username && cfg.password); }
  missingMessage() { return missingConfigMessage(this.label); }
  invalidate() { this.session = null; }

  _fingerprint(cfg) { return crypto.createHash('sha256').update(`${cfg.username}\0${cfg.password}`).digest('hex'); }

  _url(params) { return `${this.baseUrl}?${new URLSearchParams(params).toString()}`; }

  async _login(cfg) {
    // HamQTH documents this call as GET with u/p query parameters only; the URL is never logged or surfaced.
    const text = await request(this.fetchImpl, this._url({ u: cfg.username, p: cfg.password }), { timeoutMs: this.timeoutMs });
    const session = block(text, 'session');
    const id = tag(session, 'session_id');
    if (id) return id;
    const err = tag(session, 'error');
    if (/wrong user|password/i.test(err)) throw new CallbookError('auth_failed');
    if (/limit|too many|blocked/i.test(err)) throw new CallbookError('rate_limited');
    throw new CallbookError('error');
  }

  async _sessionId(cfg, forceNew) {
    const fp = this._fingerprint(cfg);
    const s = this.session;
    if (!forceNew && s && s.fp === fp && s.exp > this.now()) return s.id;
    if (!this.loginInFlight) {
      this.loginInFlight = this._login(cfg)
        .then((id) => { this.session = { id, fp, exp: this.now() + SESSION_TTL_MS }; return id; })
        .finally(() => { this.loginInFlight = null; });
    }
    return this.loginInFlight;
  }

  _map(search, call) {
    return makeResult('ok', {
      provider: this.id, label: this.label, call,
      name: clean(tag(search, 'nick'), 60) || firstWord(tag(search, 'adr_name')),
      qth: clean(tag(search, 'qth'), 80) || clean(tag(search, 'adr_city'), 80),
      grid: cleanGrid(tag(search, 'grid')),
    });
  }

  /** Never throws: every outcome is a normalised result. */
  async lookup(call, cfg) {
    const base = { provider: this.id, label: this.label, call };
    if (!this.configured(cfg)) return makeResult('not_configured', { ...base, message: this.missingMessage() });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const id = await this._sessionId(cfg, attempt > 0);
        const text = await request(this.fetchImpl, this._url({ id, callsign: call, prg: this.program }), { timeoutMs: this.timeoutMs });
        const search = block(text, 'search');
        const err = tag(block(text, 'session'), 'error');
        if (err) {
          if (/session does not exist|expired/i.test(err)) { this.session = null; continue; } // log in again, once
          if (/callsign not found/i.test(err)) return makeResult('not_found', base);
          if (/wrong user|password/i.test(err)) return makeResult('auth_failed', base);
          if (/limit|too many/i.test(err)) return makeResult('rate_limited', base);
          return makeResult('error', base);
        }
        if (search && tag(search, 'callsign')) return this._map(search, call);
        return makeResult('error', base); // reply had neither data nor a recognisable error
      }
      return makeResult('error', base);
    } catch (e) {
      return makeResult(e instanceof CallbookError ? e.status : 'error', base);
    }
  }

  /** Signs in with a fresh session; used by Settings > Test connection. */
  async test(cfg) {
    const base = { provider: this.id, label: this.label };
    if (!this.configured(cfg)) return makeResult('not_configured', { ...base, message: this.missingMessage() });
    try {
      await this._sessionId(cfg, true);
      return makeResult('ok', { ...base, message: 'Signed in to HamQTH.' });
    } catch (e) {
      return makeResult(e instanceof CallbookError ? e.status : 'error', base);
    }
  }
}

module.exports = { HamQthProvider };
