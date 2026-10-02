'use strict';
const { normalizeCall, isValidCallsign } = require('../../renderer/callbook-shared');
const { makeResult } = require('./results');
const { QrzProvider } = require('./qrz');
const { HamQthProvider } = require('./hamqth');

const CACHE_MAX = 200;

/**
 * Callbook lookup service: picks the configured provider, enforces offline mode, and keeps repeated
 * requests off the network. Providers share one small interface, so adding another is one file:
 *   { id, label, configured(cfg), lookup(call, cfg) -> result, test(cfg) -> result, invalidate() }
 * Every method resolves a normalised result (see results.js) and never throws.
 */
class CallbookService {
  /**
   * @param {object} o
   * @param {()=>{provider:string,[id:string]:{username:string,password:string}}} o.getConfig  decrypted config
   * @param {()=>boolean} o.isOffline  true in the app's offline mode: no request may be made
   * @param {Object<string,object>} o.providers  keyed by provider id
   */
  constructor({ getConfig, isOffline, providers, now = Date.now, cacheTtlMs = 10 * 60 * 1000, failureTtlMs = 30 * 1000 }) {
    Object.assign(this, { getConfig, isOffline, providers, now, cacheTtlMs, failureTtlMs });
    this.cache = new Map(); // "provider|CALL" -> { at, ttl, result }
    this.inflight = new Map(); // "provider|CALL" -> Promise<result>
  }

  static create({ getConfig, isOffline, fetchImpl }) {
    return new CallbookService({
      getConfig, isOffline,
      providers: { qrz: new QrzProvider({ fetchImpl }), hamqth: new HamQthProvider({ fetchImpl }) },
    });
  }

  /** Settings changed: forget sessions and cached answers so the new configuration applies at once. */
  invalidate() {
    this.cache.clear();
    for (const p of Object.values(this.providers)) p.invalidate();
  }

  _selected() {
    const cfg = this.getConfig();
    const provider = this.providers[cfg.provider];
    return provider ? { provider, cfg: cfg[cfg.provider] } : null;
  }

  async lookup(rawCall) {
    const sel = this._selected();
    if (!sel) return makeResult('disabled');
    const { provider, cfg } = sel;
    const base = { provider: provider.id, label: provider.label };
    const call = normalizeCall(rawCall);
    if (!isValidCallsign(call)) return makeResult('invalid', base);
    // Offline mode wins over everything else: nothing below this line touches the network.
    if (this.isOffline()) return makeResult('offline', { ...base, call });
    if (!provider.configured(cfg)) return makeResult('not_configured', { ...base, call, message: provider.missingMessage() });

    const key = `${provider.id}|${call}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < hit.ttl) return hit.result;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const run = this._fetch(provider, cfg, call)
      .then((result) => {
        const ttl = result.status === 'ok' || result.status === 'not_found' ? this.cacheTtlMs : this.failureTtlMs;
        if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, { at: this.now(), ttl, result });
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  async _fetch(provider, cfg, call) {
    let res = await provider.lookup(call, cfg);
    // Portable/prefixed calls (W1AW/P, DL/W1AW) are often only listed under the home call.
    if (res.status === 'not_found' && call.includes('/')) {
      const home = call.split('/').filter((s) => /[A-Z]/.test(s) && /\d/.test(s)).sort((a, b) => b.length - a.length)[0];
      if (home && home !== call && !this.isOffline()) {
        const alt = await provider.lookup(home, cfg);
        if (alt.status === 'ok') res = { ...alt, call };
      }
    }
    return res;
  }

  /** Settings > Test connection: signs in only, never looks up a callsign. */
  async test() {
    const sel = this._selected();
    if (!sel) return makeResult('disabled', { message: 'Choose QRZ or HamQTH first.' });
    const { provider, cfg } = sel;
    const base = { provider: provider.id, label: provider.label };
    if (this.isOffline()) return makeResult('offline', { ...base, message: 'Offline mode is on, so the connection was not tested.' });
    if (!provider.configured(cfg)) return makeResult('not_configured', { ...base, message: provider.missingMessage() });
    return provider.test(cfg);
  }
}

module.exports = { CallbookService };
