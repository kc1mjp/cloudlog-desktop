'use strict';
const net = require('net');
const dgram = require('dgram');
const EventEmitter = require('events');
const { parseAdif } = require('./adif');
const { MulticastListener, mcConfig, discoverInterfaces } = require('./multicast');

const WSJTX_MAGIC = 0xadbccbda;
const MAX_TCP_BUFFER = 8 * 1024 * 1024;

/** Extract the ADIF text from a WSJT-X/JTDX "Logged ADIF" (type 12) datagram. */
function parseWsjtx(buf) {
  if (buf.length < 12 || buf.readUInt32BE(0) !== WSJTX_MAGIC) return null;
  const type = buf.readUInt32BE(8);
  if (type !== 12) return { type, adif: null };
  let off = 12;
  const str = () => {
    const len = buf.readUInt32BE(off);
    off += 4;
    if (len === 0xffffffff) return '';
    const s = buf.toString('latin1', off, off + len);
    off += len;
    return s;
  };
  str(); // client id
  return { type, adif: str() };
}

/** Listens for ADIF pushed over TCP (plain text) and UDP (plain text or WSJT-X protocol). */
class AdifServer extends EventEmitter {
  constructor({ getSettings }) {
    super();
    this.getSettings = getSettings;
    this.tcp = null;
    this.udp = null;
    this.errors = { tcp: '', udp: '' };
    this.received = 0;
    this.clients = new Set();
    // WSJT-X / JTDX multicast: ADIF it receives goes through the same _deliver() path as TCP and UDP.
    this.mc = new MulticastListener({ discover: () => discoverInterfaces() });
    this.mc.on('adif', (text) => this._deliver(text, 'WSJT-X multicast'));
    this.mc.on('status', () => this.emit('status', this.status()));
  }

  status() {
    const c = this.getSettings().adifServer;
    return {
      enabled: !!c.enabled,
      tcp: { listening: !!this.tcp, port: c.tcpPort, error: this.errors.tcp, clients: this.clients.size },
      udp: { listening: !!this.udp, port: c.udpPort, error: this.errors.udp },
      bind: c.bind,
      multicast: this._mcStatus(c),
      received: this.received,
    };
  }

  _mcStatus(c) {
    const m = mcConfig(c);
    const on = !!c.enabled && m.enabled;
    const live = on ? this.mc.status() : {};
    return { ...live, enabled: on, state: on ? live.state : 'off', address: m.address, port: m.port, interface: m.interface, error: on ? live.error || '' : '' };
  }

  _deliver(binaryText, source) {
    const { records } = parseAdif(binaryText);
    const good = records.filter((r) => r.CALL);
    if (!good.length) return;
    this.received += good.length;
    this.emit('records', good, source);
    this.emit('status', this.status());
  }

  async apply() {
    await this.stop();
    const c = this.getSettings().adifServer;
    this.errors = { tcp: '', udp: '' };
    if (c.enabled) {
      if (c.tcp) await this._startTcp(c);
      if (c.udp) await this._startUdp(c);
      const m = mcConfig(c);
      if (m.enabled) await this.mc.start(m); // never throws; failures show up as status.multicast.error
    }
    this.emit('status', this.status());
  }

  _startTcp(c) {
    return new Promise((resolve) => {
      const srv = net.createServer((sock) => {
        sock.setEncoding('latin1');
        this.clients.add(sock);
        this.emit('status', this.status());
        let buf = '';
        const flush = (final) => {
          const re = /<eor>/gi;
          let last = -1;
          let m;
          while ((m = re.exec(buf))) last = m.index + 5;
          if (last > 0) {
            this._deliver(buf.slice(0, last), 'ADIF socket');
            buf = buf.slice(last);
          } else if (final && /<call:/i.test(buf) && !/<eor>/i.test(buf)) {
            // Sender forgot <eor> on a lone record: accept it.
            this._deliver(`${buf}<eor>`, 'ADIF socket');
            buf = '';
          }
        };
        sock.on('data', (d) => {
          buf += d;
          if (buf.length > MAX_TCP_BUFFER) { sock.destroy(); return; }
          flush(false);
        });
        const end = () => {
          if (!this.clients.delete(sock)) return;
          flush(true);
          this.emit('status', this.status());
        };
        sock.on('end', end);
        sock.on('close', end);
        sock.on('error', () => sock.destroy());
      });
      srv.once('error', (e) => { this.errors.tcp = `${e.code || e.message} on ${c.bind}:${c.tcpPort}`; resolve(); });
      srv.listen(Number(c.tcpPort), c.bind, () => { this.tcp = srv; resolve(); });
    });
  }

  _startUdp(c) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: c.bind.includes(':') ? 'udp6' : 'udp4', reuseAddr: true });
      sock.on('message', (msg) => {
        const w = parseWsjtx(msg);
        if (w) {
          if (w.adif) this._deliver(w.adif, 'WSJT-X');
        } else {
          this._deliver(msg.toString('latin1'), 'ADIF UDP');
        }
      });
      sock.once('error', (e) => { this.errors.udp = `${e.code || e.message} on ${c.bind}:${c.udpPort}`; try { sock.close(); } catch { /* ignore */ } resolve(); });
      sock.bind(Number(c.udpPort), c.bind, () => { this.udp = sock; resolve(); });
    });
  }

  async stop() {
    for (const s of this.clients) s.destroy();
    this.clients.clear();
    const tasks = [];
    if (this.tcp) { const t = this.tcp; this.tcp = null; tasks.push(new Promise((r) => t.close(r))); }
    if (this.udp) { const u = this.udp; this.udp = null; tasks.push(new Promise((r) => u.close(r))); }
    tasks.push(this.mc.stop());
    await Promise.all(tasks);
  }
}

module.exports = { AdifServer, parseWsjtx };
