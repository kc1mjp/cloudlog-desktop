'use strict';
const fs = require('fs');
const path = require('path');
const { CALLBOOK_DEFAULTS } = require('./callbook/config');

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** Small JSON file store with atomic writes. */
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = JSON.parse(JSON.stringify(defaults));
    this._timer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      deepMerge(this.data, raw);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Corrupt file: keep a copy and start fresh rather than crash.
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
    }
  }

  saveNow() {
    clearTimeout(this._timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 300);
  }
}

/** Default shape for one entry in settings.rigs. */
function newRig(id, patch = {}) {
  return {
    id, label: 'Radio', mode: 'none', // none | serial | net
    enabled: false, // whether this radio's connection is running right now
    activeOnStartup: false, // whether `enabled` gets turned back on each time the app launches
    model: 1, device: '', baud: 9600, pttType: '', extraConf: '', forceRts: false,
    defaultFreqMhz: '14.225', defaultMode: 'USB', // used only for the Hamlib dummy rig (model 1)
    host: '127.0.0.1', port: 4532, pollMs: 500, name: '', rigctldPath: '', updateCloudlog: true,
    relay: { enabled: false, bind: '127.0.0.1', port: 4532 },
    ...patch,
  };
}

const SETTINGS_DEFAULTS = {
  theme: 'cerulean',
  cloudlog: { url: '', apiKey: '', urlStyle: 'auto', currentStationId: null, stations: [] },
  sync: { auto: true, intervalSec: 20, paused: false, instant: true },
  rigs: [],
  activeRigId: null,
  adifServer: { enabled: true, bind: '127.0.0.1', tcp: true, tcpPort: 2333, udp: true, udpPort: 2333, multicast: { enabled: false, address: '224.0.0.1', port: 2237, interface: 'loopback' } },
  quick: { myType: 'POTA', myRef: '', theirType: 'POTA', role: 'activator' },
  contest: { id: 'CQ-WW-SSB', customId: '', sentExchange: '', serial: 1, startedAt: 0 },
  callbook: CALLBOOK_DEFAULTS,
};

/** Older settings files had one `rig`/`relay` pair; fold them into `rigs[0]` in place. */
function migrateRigs(data) {
  if (data.rig && (!Array.isArray(data.rigs) || !data.rigs.length)) {
    // Preserve old behaviour for anyone upgrading: a configured radio used to just
    // always run, so keep it running rather than silently going quiet on next launch.
    const wasConfigured = data.rig.mode && data.rig.mode !== 'none';
    const r = newRig('rig-1', { ...data.rig, label: data.rig.name || 'Radio 1', relay: data.relay || undefined, enabled: wasConfigured, activeOnStartup: wasConfigured });
    data.rigs = [r];
    data.activeRigId = r.id;
  }
  delete data.rig;
  delete data.relay;
  if (!Array.isArray(data.rigs)) data.rigs = [];
  if (!data.activeRigId || !data.rigs.some((r) => r.id === data.activeRigId)) {
    data.activeRigId = data.rigs.length ? data.rigs[0].id : null;
  }
  return data;
}

module.exports = { JsonStore, deepMerge, SETTINGS_DEFAULTS, newRig, migrateRigs };
