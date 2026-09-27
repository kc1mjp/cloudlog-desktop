'use strict';

class CloudlogError extends Error {
  constructor(message, { retry = false, status = 0 } = {}) {
    super(message);
    this.retry = retry; // true: network/server trouble, try again later
    this.status = status;
  }
}

/** Thin client for the Cloudlog / Wavelog HTTP API. */
class CloudlogClient {
  constructor(getCfg) {
    this.getCfg = getCfg;
    this.detected = null;
  }

  configured() {
    const c = this.getCfg();
    return !!(c.url && c.url.trim() && c.apiKey && c.apiKey.trim());
  }

  _bases() {
    const c = this.getCfg();
    const base = c.url.trim().replace(/\/+$/, '');
    if (/index\.php$/i.test(base)) return [base];
    const idx = `${base}/index.php`;
    if (c.urlStyle === 'index') return [idx];
    if (c.urlStyle === 'clean') return [base];
    return this.detected === 'clean' ? [base, idx] : [idx, base];
  }

  async _fetch(path, { method = 'GET', body, timeout = 20000 } = {}) {
    const bases = this._bases();
    for (let i = 0; i < bases.length; i++) {
      let res;
      try {
        res = await fetch(`${bases[i]}/${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeout),
        });
      } catch (e) {
        const why = (e.cause && (e.cause.code || e.cause.message)) || e.message;
        throw new CloudlogError(`Cannot reach server (${why})`, { retry: true });
      }
      if (res.status === 404 && i < bases.length - 1) continue;
      if (bases.length > 1) this.detected = bases[i].endsWith('index.php') ? 'index' : 'clean';
      return { status: res.status, text: await res.text() };
    }
    throw new CloudlogError('No response from server', { retry: true });
  }

  _json(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  async auth() {
    const key = encodeURIComponent(this.getCfg().apiKey.trim());
    const { status, text } = await this._fetch(`api/auth/${key}`);
    if (status >= 500) throw new CloudlogError(`Server error ${status}`, { retry: true, status });
    if (status === 404) throw new CloudlogError('API not found at that URL - check the address', { status });
    const st = /<status>([^<]*)<\/status>/i.exec(text);
    const rights = /<rights>([^<]*)<\/rights>/i.exec(text);
    const valid = !!st && /^valid$/i.test(st[1].trim());
    return { valid, rights: rights ? rights[1] : '', message: valid ? '' : 'API key not recognised' };
  }

  async stationInfo() {
    const key = encodeURIComponent(this.getCfg().apiKey.trim());
    const { status, text } = await this._fetch(`api/station_info/${key}`);
    if (status === 401 || status === 403) throw new CloudlogError('API key rejected', { status });
    if (status >= 500) throw new CloudlogError(`Server error ${status}`, { retry: true, status });
    const j = this._json(text);
    if (!Array.isArray(j)) throw new CloudlogError('Unexpected reply while listing logbooks', { status });
    return j.map((s) => ({
      id: String(s.station_id),
      name: s.station_profile_name || `Station ${s.station_id}`,
      callsign: s.station_callsign || '',
      grid: s.station_gridsquare || '',
      active: String(s.station_active) === '1',
    }));
  }

  /** Upload one ADIF record. Resolves {ok, duplicate, message}. */
  async postQso(adif, stationId) {
    const { status, text } = await this._fetch('api/qso', {
      method: 'POST',
      body: { key: this.getCfg().apiKey.trim(), station_profile_id: String(stationId), type: 'adif', string: adif },
    });
    if (status === 401 || status === 403) throw new CloudlogError('API key rejected (needs read/write rights)', { status });
    if (status >= 500) throw new CloudlogError(`Server error ${status}`, { retry: true, status });
    const j = this._json(text);
    if (j && j.status === 'created') return { ok: true, message: '' };
    const raw = j ? (j.message !== undefined ? j.message : j.reason) : text.slice(0, 200);
    const message = [].concat(raw || `HTTP ${status}`).join('; ');
    return { ok: false, duplicate: /dupl|dupe/i.test(message), message };
  }

  async postRadio({ radio, frequencyHz, mode, power }) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    const body = { key: this.getCfg().apiKey.trim(), radio, frequency: String(Math.round(frequencyHz)), mode, timestamp };
    if (power) body.power = power;
    const { status } = await this._fetch('api/radio', { method: 'POST', body, timeout: 8000 });
    if (status >= 400) throw new CloudlogError(`Radio update failed (HTTP ${status})`, { status, retry: status >= 500 });
  }

  /** Delta download of a logbook as ADIF. */
  async getContactsAdif(stationId, fetchFromId) {
    const { status, text } = await this._fetch('api/get_contacts_adif', {
      method: 'POST',
      timeout: 60000,
      body: { key: this.getCfg().apiKey.trim(), station_id: String(stationId), fetchfromid: fetchFromId },
    });
    if (status === 404) throw new CloudlogError('This server does not offer QSO download (api/get_contacts_adif)', { status });
    if (status === 401 || status === 403) throw new CloudlogError('API key rejected', { status });
    if (status >= 500) throw new CloudlogError(`Server error ${status}`, { retry: true, status });
    const j = this._json(text);
    if (!j) throw new CloudlogError('Unexpected reply while downloading QSOs', { status });
    return j;
  }
}

module.exports = { CloudlogClient, CloudlogError };
