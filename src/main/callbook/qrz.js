'use strict';
const crypto = require('crypto');
const { request, CallbookError } = require('./http');
const { tag, block, clean, cleanGrid } = require('./text');
const { makeResult, missingConfigMessage } = require('./results');

/**
 * QRZ XML Callbook Data service (https://www.qrz.com/docs/xml/current_spec.html).
 *
 * QRZ's documented callsign-lookup API authenticates with the account username and password and hands back a
 * session key. (QRZ API keys belong to the separate Logbook API, which cannot look up callsigns.)
 *   1. login:  username, password, agent            -> <Session><Key>
 *   2. lookup: s=<Key>, callsign=<call>              -> <Callsign>
 * Both calls are POSTed (the spec allows GET or POST) so neither the password nor the session key ends up in a URL.
 * The session key is kept in memory only and reused until QRZ says it has expired. Full data needs an active
 * QRZ XML Logbook Data subscription; without one QRZ returns limited fields.
 */
class QrzProvider {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = 'https://xmldata.qrz.com/xml/current/', timeoutMs = 8000, agent = 'CloudlogDesktop' } = {}) {
    Object.assign(this, { fetchImpl, baseUrl, timeoutMs, agent });
    this.id = 'qrz';
    this.label = 'QRZ';
    this.session = null; // { key, fp }
    this.loginInFlight = null;
  }

  configured(cfg) { return !!(cfg && cfg.username && cfg.password); }
  missingMessage() { return missingConfigMessage(this.label); }
  invalidate() { this.session = null; }

  _fingerprint(cfg) { return crypto.createHash('sha256').update(`${cfg.username}\0${cfg.password}`).digest('hex'); }

  _classify(err) {
    if (/refused/i.test(err)) return 'rate_limited';
    if (/password|username|user name|incorrect|invalid/i.test(err)) return 'auth_failed';
    if (/limit|exceed/i.test(err)) return 'rate_limited';
    return 'error';
  }

  async _login(cfg) {
    const text = await request(this.fetchImpl, this.baseUrl, {
      method: 'POST', timeoutMs: this.timeoutMs,
      form: { username: cfg.username, password: cfg.password, agent: this.agent },
    });
    const session = block(text, 'Session');
    const key = tag(session, 'Key');
    if (key) return key;
    throw new CallbookError(this._classify(tag(session, 'Error')));
  }

  async _sessionKey(cfg, forceNew) {
    const fp = this._fingerprint(cfg);
    if (!forceNew && this.session && this.session.fp === fp) return this.session.key;
    if (!this.loginInFlight) {
      this.loginInFlight = this._login(cfg)
        .then((key) => { this.session = { key, fp }; return key; })
        .finally(() => { this.loginInFlight = null; });
    }
    return this.loginInFlight;
  }

  _map(callsign, session, call) {
    const first = clean(tag(callsign, 'nickname'), 60) || clean(tag(callsign, 'fname'), 60);
    const state = clean(tag(callsign, 'state'), 20);
    const city = clean(tag(callsign, 'addr2'), 60);
    const res = makeResult('ok', {
      provider: this.id, label: this.label, call,
      name: first || clean(tag(callsign, 'name'), 60),
      qth: city && state ? `${city}, ${state}` : city,
      grid: cleanGrid(tag(callsign, 'grid')),
    });
    // A non-subscriber account gets a reduced record; say so instead of silently showing nothing.
    if (!res.name && !res.qth && !res.grid && /subscription/i.test(tag(session, 'Message'))) {
      return makeResult('limited', { provider: this.id, label: this.label, call, message: 'QRZ returned limited data. Full lookups need a QRZ XML Logbook Data subscription.' });
    }
    return res;
  }

  /** Never throws: every outcome is a normalised result. */
  async lookup(call, cfg) {
    const base = { provider: this.id, label: this.label, call };
    if (!this.configured(cfg)) return makeResult('not_configured', { ...base, message: this.missingMessage() });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const key = await this._sessionKey(cfg, attempt > 0);
        const text = await request(this.fetchImpl, this.baseUrl, { method: 'POST', timeoutMs: this.timeoutMs, form: { s: key, callsign: call } });
        const session = block(text, 'Session');
        const callsign = block(text, 'Callsign');
        const err = tag(session, 'Error');
        if (callsign && tag(callsign, 'call')) return this._map(callsign, session, call);
        if (/not found/i.test(err)) return makeResult('not_found', base);
        if (!tag(session, 'Key') || /session|timeout/i.test(err)) { this.session = null; continue; } // log in again, once
        return makeResult(this._classify(err), base);
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
      await this._sessionKey(cfg, true);
      return makeResult('ok', { ...base, message: 'Signed in to QRZ.' });
    } catch (e) {
      return makeResult(e instanceof CallbookError ? e.status : 'error', base);
    }
  }
}

module.exports = { QrzProvider };
