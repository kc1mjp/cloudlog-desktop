'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** Locate a Hamlib binary: explicit path, bundled copy, then PATH. */
function findHamlib(name, { explicit, resourcesPath } = {}) {
  const cands = [];
  if (explicit) {
    cands.push(explicit);
    cands.push(path.join(path.dirname(explicit), name));
  }
  if (resourcesPath) cands.push(path.join(resourcesPath, 'hamlib', 'bin', name));
  const dirs = (process.env.PATH || '').split(':').concat(['/usr/bin', '/usr/local/bin', '/usr/sbin', '/opt/hamlib/bin']);
  for (const d of dirs) if (d) cands.push(path.join(d, name));
  return cands.find(isExecutable) || null;
}

function hamlibEnv(bin, resourcesPath) {
  const env = { ...process.env };
  if (resourcesPath && bin && bin.startsWith(path.join(resourcesPath, 'hamlib'))) {
    env.LD_LIBRARY_PATH = `${path.join(resourcesPath, 'hamlib', 'lib')}:${env.LD_LIBRARY_PATH || ''}`;
  }
  return env;
}

/**
 * Locate force_rts.so, an LD_PRELOAD shim that clears RTS the instant a serial
 * device is opened. Linux asserts RTS/DTR high the moment a tty is opened, at
 * the driver level, before Hamlib (or anything else at the application layer)
 * gets a chance to lower it - on rigs that wire RTS to PTT this keys the
 * transmitter for an instant on every rigctld start/restart. Packaged builds
 * ship a copy outside the asar (LD_PRELOAD needs a real file, not a virtual
 * asar path); dev runs use the copy sitting next to the app's own icon.
 */
function findForceRts(resourcesPath) {
  const cands = [];
  if (resourcesPath) cands.push(path.join(resourcesPath, 'force_rts.so'));
  cands.push(path.join(__dirname, '..', 'assets', 'force_rts.so'));
  return cands.find((p) => { try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; } }) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function parseRigList(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s{2,}(.+?)\s{2,}(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (m) out.push({ id: Number(m[1]), mfg: m[2].trim(), model: m[3].trim(), status: m[5] });
  }
  return out;
}

/**
 * Talks Hamlib's rigctl protocol to a rigctld. In "serial" mode it starts its
 * own rigctld on a private loopback port; in "net" mode it connects to a remote
 * one. An optional relay re-publishes the same rig on a TCP port for other apps.
 */
class RigService extends EventEmitter {
  constructor({ getSettings, resourcesPath }) {
    super();
    this.getSettings = getSettings;
    this.resourcesPath = resourcesPath;
    this.gen = 0;
    this.sock = null;
    this.child = null;
    this.pending = [];
    this.buf = '';
    this.internalPort = null;
    this.relay = null;
    this.relayClients = new Set();
    this.relayError = '';
    this.backoff = 1000;
    this.stderrTail = '';
    this.noPtt = false;
    this.modelCache = null;
    this.forceRtsActive = false;
    this.state = { state: 'idle', message: 'CAT control is off', freqHz: null, mode: null, ptt: false, updated: null };
  }

  status() {
    const rc = this.getSettings().relay;
    return {
      ...this.state,
      rigName: this.rigName(),
      forceRtsActive: this.forceRtsActive,
      relay: { enabled: !!rc.enabled, listening: !!this.relay, port: rc.port, bind: rc.bind, clients: this.relayClients.size, error: this.relayError },
    };
  }

  rigName() {
    const r = this.getSettings().rig;
    if (r.name) return r.name;
    if (r.mode === 'serial' && this.modelCache) {
      const m = this.modelCache.find((x) => x.id === Number(r.model));
      if (m) return `${m.mfg} ${m.model}`;
    }
    return r.mode === 'net' ? `${r.host}:${r.port}` : 'Cloudlog Desktop';
  }

  _set(patch) {
    const key = () => JSON.stringify([this.state.state, this.state.message, this.state.freqHz, this.state.mode, this.state.ptt]);
    const fm = () => JSON.stringify([this.state.freqHz, this.state.mode]);
    const k0 = key();
    const fm0 = fm();
    Object.assign(this.state, patch);
    if (key() !== k0) {
      this.emit('status', this.status());
      if (fm() !== fm0) this.emit('update', this.status());
    }
  }

  _emitStatus() { this.emit('status', this.status()); }

  // ---- lifecycle --------------------------------------------------------

  async apply() {
    const gen = ++this.gen;
    await this._teardown();
    if (gen !== this.gen) return;
    const s = this.getSettings();
    const cfg = s.rig;
    this.stderrTail = '';
    this.noPtt = false;
    this.forceRtsActive = false;
    if (cfg.mode === 'none') {
      this._set({ state: 'idle', message: 'CAT control is off', freqHz: null, mode: null, ptt: false });
      await this._startRelay(gen);
      this._emitStatus();
      return;
    }
    if (cfg.mode === 'serial') {
      const bin = findHamlib('rigctld', { explicit: cfg.rigctldPath, resourcesPath: this.resourcesPath });
      if (!bin) {
        this._set({ state: 'error', message: 'rigctld not found. Install Hamlib: sudo apt install libhamlib-utils', freqHz: null, mode: null });
        return;
      }
      if (!cfg.device && Number(cfg.model) !== 1) {
        this._set({ state: 'error', message: 'Choose a serial port in Settings > Radio', freqHz: null, mode: null });
        return;
      }
      try { await this._spawn(bin, cfg, gen); } catch (e) {
        this._set({ state: 'error', message: `Could not start rigctld: ${e.message}` });
        return;
      }
    }
    if (gen !== this.gen) return;
    this._connect(gen, 0);
    await this._startRelay(gen);
    this._emitStatus();
  }

  async stop() {
    this.gen++;
    await this._teardown();
  }

  async _teardown() {
    clearTimeout(this.reconnectTimer);
    this._dropSocket();
    if (this.relay) { const r = this.relay; this.relay = null; for (const c of this.relayClients) c.destroy(); await new Promise((res) => r.close(res)); }
    if (this.child) {
      const c = this.child;
      this.child = null;
      c.removeAllListeners('exit');
      c.kill('SIGTERM');
      await Promise.race([new Promise((res) => c.once('exit', res)), sleep(1500)]);
      if (c.exitCode === null) c.kill('SIGKILL');
    }
  }

  async _spawn(bin, cfg, gen) {
    this.internalPort = await freePort();
    const args = ['-m', String(cfg.model), '-t', String(this.internalPort), '-T', '127.0.0.1'];
    if (cfg.device) args.push('-r', cfg.device);
    if (cfg.baud) args.push('-s', String(cfg.baud));
    if (cfg.pttType) args.push('-P', cfg.pttType);
    if (cfg.extraConf && cfg.extraConf.trim()) args.push('-C', cfg.extraConf.trim().replace(/\s+/g, ''));
    const env = hamlibEnv(bin, this.resourcesPath);
    if (cfg.forceRts && cfg.device) {
      const lib = findForceRts(this.resourcesPath);
      if (lib) {
        env.FORCE_RTS_DEVICES = cfg.device;
        env.LD_PRELOAD = [lib, env.LD_PRELOAD].filter(Boolean).join(':');
        this.forceRtsActive = true;
      }
    }
    this._set({ state: 'connecting', message: 'Starting rigctld…' });
    const child = spawn(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    child.stderr.on('data', (d) => { this.stderrTail = (this.stderrTail + d).slice(-500); });
    child.on('error', (e) => {
      if (gen !== this.gen) return;
      this._set({ state: 'error', message: `rigctld: ${e.message}` });
    });
    child.on('exit', (code, sig) => {
      if (gen !== this.gen) return;
      this.child = null;
      this._dropSocket();
      const tail = this.stderrTail.trim().split('\n').filter(Boolean).pop() || '';
      this._set({ state: 'error', message: `rigctld stopped (${code ?? sig})${tail ? `: ${tail}` : ''}`, freqHz: null, mode: null });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => { if (gen === this.gen) this.apply(); }, 5000);
    });
  }

  _upstream() {
    const c = this.getSettings().rig;
    return c.mode === 'serial' ? { host: '127.0.0.1', port: this.internalPort } : { host: c.host || '127.0.0.1', port: Number(c.port) || 4532 };
  }

  _connect(gen, delay) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (gen !== this.gen) return;
      const { host, port } = this._upstream();
      const s = net.createConnection({ host, port });
      this.sock = s;
      s.setEncoding('utf8');
      s.setNoDelay(true);
      this._set({ state: 'connecting', message: `Connecting to ${host}:${port}…` });
      s.on('connect', () => {
        this.backoff = 1000;
        this._set({ state: 'connected', message: '' });
        this._applyDummyDefaults();
        this._poll(gen, s);
      });
      s.on('data', (d) => this._onData(d));
      const fail = (err) => {
        if (this.sock !== s) return;
        this._dropSocket();
        if (gen !== this.gen) return;
        const waiting = this.child && err && err.code === 'ECONNREFUSED';
        this._set({
          state: waiting ? 'connecting' : 'error',
          message: waiting ? 'Waiting for rigctld…' : err ? `${host}:${port}: ${err.code || err.message}` : `Connection to ${host}:${port} closed`,
          freqHz: null, mode: null, ptt: false,
        });
        this.backoff = Math.min(this.backoff * 1.5, 8000);
        this._connect(gen, waiting ? 500 : this.backoff);
      };
      s.on('error', fail);
      s.on('close', () => fail());
    }, delay);
  }

  /**
   * The Hamlib dummy rig (model 1) always starts at whatever arbitrary
   * frequency/mode it happens to default to. When we spawned it ourselves,
   * push the configured default once so it's immediately useful for testing.
   */
  async _applyDummyDefaults() {
    if (!this.child) return; // only for rigctld instances we started, not someone else's over the network
    const cfg = this.getSettings().rig;
    if (Number(cfg.model) !== 1) return;
    try {
      const mhz = parseFloat(cfg.defaultFreqMhz);
      if (isFinite(mhz) && mhz > 0) await this._send(`F ${Math.round(mhz * 1e6)}`);
      if (cfg.defaultMode) await this._send(`M ${cfg.defaultMode} 0`);
    } catch { /* best effort - the poll loop will just show whatever the dummy rig already has */ }
  }

  _dropSocket() {
    const s = this.sock;
    this.sock = null;
    this.buf = '';
    for (const p of this.pending.splice(0)) { clearTimeout(p.t); p.reject(new Error('closed')); }
    if (s) { s.removeAllListeners('data'); s.destroy(); }
  }

  // ---- rigctl protocol --------------------------------------------------

  _send(cmd, expected = 1) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('not connected'));
      const p = { expected, lines: [], resolve, reject };
      p.t = setTimeout(() => { reject(new Error('timeout')); if (this.sock) this.sock.destroy(new Error('rigctld timeout')); }, 4000);
      this.pending.push(p);
      this.sock.write(`${cmd}\n`);
    });
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const p = this.pending[0];
      if (!p) continue;
      p.lines.push(line);
      if (/^RPRT\s+-?\d+/.test(line) || p.lines.length >= p.expected) {
        this.pending.shift();
        clearTimeout(p.t);
        p.resolve(p.lines);
      }
    }
  }

  async _poll(gen, sock) {
    while (gen === this.gen && this.sock === sock) {
      try {
        const f = await this._send('f');
        if (/^RPRT/.test(f[0])) {
          this._set({ message: `Radio not responding (${f[0]})`, freqHz: null, mode: null });
        } else {
          const m = await this._send('m', 2);
          let ptt = this.state.ptt;
          if (!this.noPtt) {
            const t = await this._send('t');
            if (/^RPRT/.test(t[0])) this.noPtt = true; else ptt = t[0].trim() === '1';
          }
          this._set({ state: 'connected', message: '', freqHz: parseInt(f[0], 10) || null, mode: /^RPRT/.test(m[0]) ? null : m[0], ptt, updated: Date.now() });
        }
      } catch { return; } // socket closed/timeout: the reconnect path takes over
      await sleep(Number(this.getSettings().rig.pollMs) || 500);
    }
  }

  async setFrequency(hz) {
    const r = await this._send(`F ${Math.round(hz)}`);
    if (!/^RPRT 0/.test(r[0])) throw new Error(`Radio refused frequency change (${r[0]})`);
  }

  async setMode(mode) {
    const r = await this._send(`M ${mode} 0`);
    if (!/^RPRT 0/.test(r[0])) throw new Error(`Radio refused mode change (${r[0]})`);
  }

  // ---- relay ------------------------------------------------------------

  async _startRelay(gen) {
    const s = this.getSettings();
    const rc = s.relay;
    this.relayError = '';
    if (!rc.enabled) return;
    if (s.rig.mode === 'none') { this.relayError = 'Set up CAT control first'; return; }
    const local = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];
    if (s.rig.mode === 'net' && local.includes(s.rig.host) && Number(s.rig.port) === Number(rc.port)) {
      this.relayError = 'Relay port is the same as the radio connection - pick a different port';
      return;
    }
    const srv = net.createServer((c) => {
      const { host, port } = this._upstream();
      if (!port) { c.destroy(); return; }
      const u = net.createConnection({ host, port });
      this.relayClients.add(c);
      this._emitStatus();
      const done = () => {
        if (!this.relayClients.delete(c)) return;
        c.destroy(); u.destroy();
        this._emitStatus();
      };
      c.setNoDelay(true); u.setNoDelay(true);
      c.pipe(u); u.pipe(c);
      c.on('error', done); u.on('error', done); c.on('close', done); u.on('close', done);
    });
    await new Promise((resolve) => {
      srv.once('error', (e) => { this.relayError = `${e.code || e.message} on ${rc.bind}:${rc.port}`; resolve(); });
      srv.listen(Number(rc.port), rc.bind, () => { if (gen === this.gen) this.relay = srv; else srv.close(); resolve(); });
    });
  }

  // ---- discovery --------------------------------------------------------

  async listModels() {
    if (this.modelCache) return this.modelCache;
    const bin = findHamlib('rigctl', { explicit: this.getSettings().rig.rigctldPath, resourcesPath: this.resourcesPath });
    if (!bin) return [];
    const out = await new Promise((resolve) => {
      execFile(bin, ['-l'], { maxBuffer: 8e6, env: hamlibEnv(bin, this.resourcesPath) }, (err, stdout) => resolve(err ? '' : stdout));
    });
    this.modelCache = parseRigList(out);
    return this.modelCache;
  }

  listPorts() {
    const out = [];
    const add = (p) => { if (!out.includes(p)) out.push(p); };
    try {
      for (const n of fs.readdirSync('/dev/serial/by-id')) add(path.join('/dev/serial/by-id', n));
    } catch { /* none */ }
    try {
      const dev = fs.readdirSync('/dev').sort();
      for (const n of dev) if (/^tty(USB|ACM)\d+$/.test(n)) add(`/dev/${n}`);
      for (const n of dev) if (/^ttyS[0-3]$/.test(n)) add(`/dev/${n}`);
    } catch { /* ignore */ }
    return out;
  }

  info() {
    const bin = findHamlib('rigctld', { explicit: this.getSettings().rig.rigctldPath, resourcesPath: this.resourcesPath });
    return { rigctld: bin };
  }
}

function listSerialPorts() {
  const out = [];
  const add = (p) => { if (!out.includes(p)) out.push(p); };
  try {
    for (const n of fs.readdirSync('/dev/serial/by-id')) add(path.join('/dev/serial/by-id', n));
  } catch { /* none */ }
  try {
    const dev = fs.readdirSync('/dev').sort();
    for (const n of dev) if (/^tty(USB|ACM)\d+$/.test(n)) add(`/dev/${n}`);
    for (const n of dev) if (/^ttyS[0-3]$/.test(n)) add(`/dev/${n}`);
  } catch { /* ignore */ }
  return out;
}

/**
 * Runs one RigService per configured radio, keyed by rig id. `getSettings()`
 * must return the whole settings object (with `.rigs` and `.activeRigId`);
 * each RigService gets a shim that hands it just its own {rig, relay}.
 */
class RigManager extends EventEmitter {
  constructor({ getSettings, resourcesPath }) {
    super();
    this.getSettings = getSettings;
    this.resourcesPath = resourcesPath;
    this.services = new Map();
    this.modelCache = null;
  }

  _cfg(id) {
    return this.getSettings().rigs.find((r) => r.id === id);
  }

  _ensure(id) {
    let svc = this.services.get(id);
    if (svc) return svc;
    svc = new RigService({
      getSettings: () => { const r = this._cfg(id); return { rig: r, relay: (r && r.relay) || {} }; },
      resourcesPath: this.resourcesPath,
    });
    svc.on('status', (s) => this.emit('status', id, s));
    svc.on('update', (s) => this.emit('update', id, s));
    this.services.set(id, svc);
    return svc;
  }

  /** Create/refresh/tear down RigServices to match settings.rigs (and each rig's enabled flag). */
  async reconcile() {
    const cfgs = this.getSettings().rigs;
    const wantRunning = new Set(cfgs.filter((r) => r.enabled && r.mode !== 'none').map((r) => r.id));
    for (const [id, svc] of this.services) if (!wantRunning.has(id)) { this.services.delete(id); await svc.stop(); }
    for (const id of wantRunning) if (!this.services.has(id)) await this._ensure(id).apply();
  }

  /** Start, restart, or stop one radio's service to match its current config (mode/enabled/etc). */
  async applyOne(id) {
    const cfg = this._cfg(id);
    if (!cfg || !cfg.enabled || cfg.mode === 'none') {
      const svc = this.services.get(id);
      if (svc) { this.services.delete(id); await svc.stop(); }
      return;
    }
    await this._ensure(id).apply();
  }

  async removeOne(id) {
    const svc = this.services.get(id);
    if (svc) { this.services.delete(id); await svc.stop(); }
  }

  async stopAll() {
    await Promise.all([...this.services.values()].map((s) => s.stop()));
  }

  statusOne(id) {
    const cfg = this._cfg(id);
    if (!cfg) return null;
    const svc = this.services.get(id);
    let base;
    if (svc) base = svc.status();
    else {
      const message = !cfg.enabled ? 'Turned off' : cfg.mode === 'none' ? 'No connection method set up' : 'Starting…';
      base = { state: 'idle', message, freqHz: null, mode: null, ptt: false, forceRtsActive: false, rigName: cfg.label || cfg.name || 'Radio', relay: { enabled: !!cfg.relay?.enabled, listening: false, port: cfg.relay?.port, bind: cfg.relay?.bind, clients: 0, error: '' } };
    }
    return { id, label: cfg.label || base.rigName, enabled: !!cfg.enabled, activeOnStartup: !!cfg.activeOnStartup, updateCloudlog: !!cfg.updateCloudlog, ...base };
  }

  statusAll() {
    return this.getSettings().rigs.map((r) => this.statusOne(r.id));
  }

  async listModels() {
    if (this.modelCache) return this.modelCache;
    const bin = findHamlib('rigctl', { resourcesPath: this.resourcesPath });
    if (!bin) return [];
    const out = await new Promise((resolve) => {
      execFile(bin, ['-l'], { maxBuffer: 8e6, env: hamlibEnv(bin, this.resourcesPath) }, (err, stdout) => resolve(err ? '' : stdout));
    });
    this.modelCache = parseRigList(out);
    return this.modelCache;
  }

  listPorts() { return listSerialPorts(); }

  info() { return { rigctld: findHamlib('rigctld', { resourcesPath: this.resourcesPath }), forceRts: findForceRts(this.resourcesPath) }; }
}

module.exports = { RigService, RigManager, findHamlib, findForceRts, parseRigList, listSerialPorts };
