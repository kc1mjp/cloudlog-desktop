'use strict';
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');
const { parseWsjtxDatagram } = require('./wsjtx');

const LOOPBACK_ID = 'loopback'; // stable, platform-independent id persisted for "This computer only"
const LOOPBACK_LABEL = 'This computer only';
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const MC_DEFAULTS = Object.freeze({ enabled: false, address: '224.0.0.1', port: 2237, interface: LOOPBACK_ID });

// Linux net device flags (include/uapi/linux/if.h).
const IFF_UP = 0x1;
const IFF_MULTICAST = 0x1000;

/** Merge saved settings over the defaults (older settings files have no multicast block). */
function mcConfig(c) {
  const m = { ...MC_DEFAULTS, ...((c && c.multicast) || {}) };
  return { enabled: !!m.enabled, address: String(m.address == null ? '' : m.address).trim(), port: m.port, interface: m.interface ? String(m.interface) : LOOPBACK_ID };
}

function isIPv4(s) {
  const p = String(s).split('.');
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}

/** Returns an error message, or '' when the multicast address and port are usable. */
function validateMcConfig(m) {
  if (!isIPv4(m.address)) return `"${m.address}" is not an IPv4 address`;
  const first = Number(m.address.split('.')[0]);
  if (first < 224 || first > 239) return `${m.address} is not a multicast address (use 224.0.0.0 - 239.255.255.255)`;
  const port = Number(m.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `Port ${m.port} is not valid (1-65535)`;
  return '';
}

function linuxFlags(name, fsImpl) {
  try {
    const flags = parseInt(String(fsImpl.readFileSync(`/sys/class/net/${name}/flags`, 'utf8')).trim(), 16);
    return Number.isFinite(flags) ? flags : null;
  } catch { return null; }
}

/**
 * Find the IPv4 interfaces that can be used for multicast.
 * Entry: { id, label, name, address, loopback, up, multicast, usable, reason }
 *   up / multicast are true / false, or null when the platform gives no way to tell (the join is then the real test).
 * Active, non-multicast-capable interfaces are left out. The loopback interface is always listed first as
 * "This computer only"; if it cannot do multicast it is listed with usable=false and a reason, never hidden.
 * Linux reads the kernel's interface flags; elsewhere the OS API only tells us an interface is configured.
 */
function discoverInterfaces({ osImpl = os, fsImpl = fs, platform = process.platform } = {}) {
  let all = {};
  try { all = osImpl.networkInterfaces() || {}; } catch { all = {}; }
  let loop = null;
  const list = [];
  for (const [name, addrs] of Object.entries(all)) {
    const a = (addrs || []).find((x) => x && (x.family === 'IPv4' || x.family === 4));
    if (!a) continue;
    const flags = platform === 'linux' ? linuxFlags(name, fsImpl) : null;
    const up = flags == null ? null : !!(flags & IFF_UP);
    const multicast = flags == null ? null : !!(flags & IFF_MULTICAST);
    const entry = { id: name, name, label: `${name} (${a.address})`, address: a.address, loopback: !!a.internal, up, multicast, usable: true, reason: '' };
    if (entry.loopback) { if (!loop) loop = entry; continue; }
    if (up === false || multicast === false) continue;
    list.push(entry);
  }
  if (loop) {
    loop.id = LOOPBACK_ID;
    loop.label = LOOPBACK_LABEL;
    if (loop.up === false) { loop.usable = false; loop.reason = `The loopback interface ${loop.name} is down.`; }
    else if (loop.multicast === false) {
      loop.usable = false;
      loop.reason = `Multicast is not enabled on the loopback interface ${loop.name}. Enable it (Linux: sudo ip link set ${loop.name} multicast on) or choose another interface.`;
    }
  } else {
    loop = { id: LOOPBACK_ID, label: LOOPBACK_LABEL, name: '', address: '', loopback: true, up: null, multicast: null, usable: false, reason: 'No loopback interface was found on this computer. Choose another interface.' };
  }
  list.sort((x, y) => x.name.localeCompare(y.name));
  return [loop, ...list];
}

/** Pure state evaluation: 'off' | 'error' | 'waiting' (amber) | 'active' (green). */
function mcState({ enabled, listening, error, lastHeartbeat, now, staleMs = HEARTBEAT_STALE_MS }) {
  if (!enabled) return 'off';
  if (error || !listening) return 'error';
  if (lastHeartbeat && now - lastHeartbeat <= staleMs) return 'active';
  return 'waiting';
}

/**
 * Joins a multicast group and decodes WSJT-X / JTDX traffic. Emits 'adif' (ADIF text of a Logged ADIF message) and
 * 'status'. Nothing here throws to the caller: every failure becomes `error`, which the UI shows in red.
 */
class MulticastListener extends EventEmitter {
  constructor({ dgramImpl = dgram, discover = discoverInterfaces, now = Date.now, logger = console, platform = process.platform } = {}) {
    super();
    Object.assign(this, { dgramImpl, discover, now, logger, platform });
    this.sock = null;
    this.cfg = null;
    this.error = '';
    this.lastHeartbeat = 0;
    this.malformed = 0;
    this.iface = null;
    this._timer = null;
    this._gen = 0;
  }

  state() {
    return mcState({ enabled: !!this.cfg, listening: !!this.sock, error: this.error, lastHeartbeat: this.lastHeartbeat, now: this.now() });
  }

  status() {
    const c = this.cfg || {};
    return {
      state: this.state(), listening: !!this.sock, error: this.error, address: c.address, port: c.port,
      interface: c.interface, interfaceLabel: this.iface ? this.iface.label : '', lastHeartbeat: this.lastHeartbeat || null,
    };
  }

  _fail(message, gen) {
    if (gen !== this._gen) return;
    this.error = message;
    this.logger.error(`[adif-multicast] ${message}`);
    this._closeSocket();
    this._clearTimer();
    this.emit('status');
  }

  _closeSocket() {
    const s = this.sock;
    this.sock = null;
    if (s) { try { s.removeAllListeners('message'); s.on('error', () => {}); s.close(); } catch { /* already closed */ } }
  }

  _clearTimer() { clearTimeout(this._timer); this._timer = null; }

  _armStale() {
    this._clearTimer();
    this._timer = setTimeout(() => { this._timer = null; this.emit('status'); }, HEARTBEAT_STALE_MS + 25);
    if (this._timer.unref) this._timer.unref();
  }

  /** (Re)start with the multicast settings block. Always stops any previous socket first. */
  async start(config) {
    await this.stop();
    const gen = ++this._gen;
    const cfg = { address: '', port: 0, interface: LOOPBACK_ID, ...config };
    this.cfg = cfg;
    this.error = '';
    this.iface = null;
    const bad = validateMcConfig(cfg);
    if (bad) return this._fail(bad, gen);
    let list;
    try { list = this.discover(); } catch (e) { return this._fail(`Could not list network interfaces: ${e.message}`, gen); }
    const iface = list.find((i) => i.id === cfg.interface);
    if (!iface) return this._fail(`Network interface "${cfg.interface}" is not available (not found, down, or not multicast-capable). Choose another interface.`, gen);
    this.iface = iface;
    if (!iface.usable) return this._fail(iface.reason || `Interface ${iface.label} cannot be used for multicast.`, gen);
    if (!iface.address) return this._fail(`Interface ${iface.label} has no IPv4 address.`, gen);

    let sock;
    try {
      sock = this.dgramImpl.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (e) { return this._fail(`Could not create the multicast socket: ${e.message}`, gen); }
    this.sock = sock;
    sock.on('message', (msg) => this._onMessage(msg));
    sock.on('error', (e) => this._fail(`Multicast socket error: ${e.code || e.message}`, gen));
    await new Promise((resolve) => {
      const done = () => resolve();
      sock.once('error', done);
      try {
        // Windows cannot bind to a multicast address; elsewhere binding to the group filters out unrelated traffic.
        sock.bind(Number(cfg.port), this.platform === 'win32' ? '0.0.0.0' : cfg.address, () => {
          sock.removeListener('error', done);
          try {
            sock.addMembership(cfg.address, iface.address);
          } catch (e) {
            this._fail(`Could not join ${cfg.address} on ${iface.label}: ${e.code || e.message}`, gen);
          }
          done();
        });
      } catch (e) { this._fail(`Could not listen on ${cfg.address}:${cfg.port}: ${e.code || e.message}`, gen); done(); }
    });
    if (gen !== this._gen || this.error) return undefined;
    this.emit('status'); // listening, but amber until the first heartbeat arrives
    return undefined;
  }

  _onMessage(msg) {
    try {
      const m = parseWsjtxDatagram(msg);
      if (!m) return; // not WSJT-X/JTDX traffic
      if (m.malformed) {
        this.malformed++;
        if (this.malformed <= 5 || this.malformed % 100 === 0) this.logger.warn(`[adif-multicast] ignored malformed WSJT-X/JTDX message (type ${m.type}, ${this.malformed} so far)`);
        return;
      }
      if (m.heartbeat) {
        const wasActive = this.state() === 'active';
        this.lastHeartbeat = this.now();
        this._armStale();
        if (!wasActive) this.emit('status');
      } else if (m.adif) {
        this.emit('adif', m.adif);
      }
    } catch (e) {
      this.logger.error(`[adif-multicast] failed to process a message: ${e.message}`);
    }
  }

  async stop() {
    this._gen++;
    this._clearTimer();
    const s = this.sock;
    this.sock = null;
    this.cfg = null;
    this.error = '';
    this.lastHeartbeat = 0;
    this.iface = null;
    if (s) {
      s.removeAllListeners('message');
      s.on('error', () => {});
      await new Promise((r) => { try { s.close(r); } catch { r(); } });
    }
  }
}

module.exports = { LOOPBACK_ID, LOOPBACK_LABEL, HEARTBEAT_STALE_MS, MC_DEFAULTS, mcConfig, validateMcConfig, discoverInterfaces, mcState, MulticastListener };
