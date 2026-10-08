'use strict';
/*
 * Release 0.4.1: Incoming ADIF multicast listener for WSJT-X / JTDX.
 * No test opens a real multicast group: sockets, the OS interface table and the clock are all faked, so the suite is
 * deterministic in CI containers where multicast is unavailable.
 */
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { parseWsjtxDatagram, WSJTX_MAGIC } = require('../src/main/wsjtx');
const mcm = require('../src/main/multicast');
const { AdifServer } = require('../src/main/adifserver');
const { SETTINGS_DEFAULTS, JsonStore } = require('../src/main/store');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const quiet = { error() {}, warn() {}, log() {} };

// ---- wire format helpers (same layout as the reference script's sample datagrams) ----------------------------
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const qstr = (s) => { const d = Buffer.from(s, 'utf8'); return Buffer.concat([u32(d.length), d]); };
const header = (type, schema = 2) => Buffer.concat([u32(WSJTX_MAGIC), u32(schema), u32(type)]);
const heartbeat = (id = 'WSJT-X', ver = '2.5.2') => Buffer.concat([header(0), qstr(id), u32(3), qstr(ver)]);
const ADIF = '\n<adif_ver:5>3.1.0\n<programid:6>WSJT-X\n<EOH>\n<call:5>YO9HP <mode:3>FT8 <qso_date:8>20211116 <time_on:6>141215 <band:3>15m <freq:9>21.075047 <EOR>';
const logged = (adif = ADIF) => Buffer.concat([header(12), qstr('WSJT-X'), qstr(adif)]);

// ---- fakes --------------------------------------------------------------------------------------------------
class FakeSock extends EventEmitter {
  constructor(opts = {}) { super(); this.opts = opts; this.closed = false; this.joined = null; this.bound = null; }
  bind(port, addr, cb) { this.bound = { port, addr }; if (this.opts.bindError) { setImmediate(() => this.emit('error', Object.assign(new Error('in use'), { code: this.opts.bindError }))); return; } setImmediate(cb); }
  addMembership(group, iface) { if (this.opts.joinError) throw Object.assign(new Error('join failed'), { code: this.opts.joinError }); this.joined = { group, iface }; }
  close(cb) { this.closed = true; if (cb) setImmediate(cb); }
}
const fakeDgram = (opts) => { const made = []; return { made, createSocket: (o) => { const s = new FakeSock(opts); s.createOpts = o; made.push(s); return s; } }; };
const IFACES = [
  { id: 'loopback', label: 'This computer only', name: 'lo', address: '127.0.0.1', loopback: true, up: true, multicast: true, usable: true, reason: '' },
  { id: 'eth0', label: 'eth0 (192.168.1.5)', name: 'eth0', address: '192.168.1.5', loopback: false, up: true, multicast: true, usable: true, reason: '' },
];
const BAD_LOOP = [{ ...IFACES[0], multicast: false, usable: false, reason: 'Multicast is not enabled on the loopback interface lo.' }, IFACES[1]];
const MC = { address: '224.0.0.1', port: 2237, interface: 'loopback' };
function mkListener(opts = {}) {
  const clock = { t: 1_000_000 };
  const dgramImpl = fakeDgram(opts.sock);
  const l = new mcm.MulticastListener({ dgramImpl, discover: () => opts.ifaces || IFACES, now: () => clock.t, logger: quiet, platform: opts.platform || 'linux' });
  return { l, clock, dgramImpl };
}

// ---- config / defaults / persistence ------------------------------------------------------------------------
test('defaults: 224.0.0.1, port 2237, "This computer only" (loopback); disabled until the user opts in', () => {
  assert.deepStrictEqual(SETTINGS_DEFAULTS.adifServer.multicast, { enabled: false, address: '224.0.0.1', port: 2237, interface: 'loopback' });
  assert.strictEqual(mcm.LOOPBACK_LABEL, 'This computer only');
  assert.deepStrictEqual(mcm.mcConfig({}), { enabled: false, address: '224.0.0.1', port: 2237, interface: 'loopback' });
  assert.strictEqual(mcm.mcConfig({ multicast: { enabled: true, address: ' 239.1.2.3 ', port: 5000, interface: 'eth0' } }).address, '239.1.2.3');
});

test('persistence: saved multicast settings survive a restart, and old settings files gain the defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-mc-'));
  const file = path.join(dir, 'settings.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ adifServer: { enabled: true, tcpPort: 2400 } })); // pre-0.4.1 file
    const old = new JsonStore(file, SETTINGS_DEFAULTS);
    assert.strictEqual(old.data.adifServer.tcpPort, 2400);
    assert.deepStrictEqual(old.data.adifServer.multicast, SETTINGS_DEFAULTS.adifServer.multicast);
    old.data.adifServer.multicast = { enabled: true, address: '239.9.9.9', port: 2240, interface: 'eth0' };
    old.saveNow();
    assert.deepStrictEqual(new JsonStore(file, SETTINGS_DEFAULTS).data.adifServer.multicast, { enabled: true, address: '239.9.9.9', port: 2240, interface: 'eth0' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validateMcConfig accepts IPv4 multicast addresses and real ports only', () => {
  assert.strictEqual(mcm.validateMcConfig({ address: '224.0.0.1', port: 2237 }), '');
  assert.strictEqual(mcm.validateMcConfig({ address: '239.255.255.255', port: 65535 }), '');
  for (const a of ['', 'abc', '10.0.0.1', '223.255.255.255', '240.0.0.1', '224.0.0', '224.0.0.256']) assert.notStrictEqual(mcm.validateMcConfig({ address: a, port: 2237 }), '', a);
  for (const p of [0, -1, 65536, 'x', 1.5]) assert.notStrictEqual(mcm.validateMcConfig({ address: '224.0.0.1', port: p }), '', String(p));
});

// ---- interface discovery ------------------------------------------------------------------------------------
const nic = (address, internal = false) => [{ family: 'IPv4', address, internal }];
function fakeOs(table) { return { networkInterfaces: () => table }; }
function fakeFs(flags) { return { readFileSync: (p) => { const n = p.split('/')[4]; if (!(n in flags)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return `0x${flags[n].toString(16)}\n`; } }; }

test('discovery (Linux): active multicast-capable interfaces plus loopback as "This computer only"', () => {
  const list = mcm.discoverInterfaces({
    platform: 'linux',
    osImpl: fakeOs({ lo: nic('127.0.0.1', true), eth0: nic('192.168.1.5'), wlan0: nic('10.0.0.8'), docker0: nic('172.17.0.1'), tun0: nic('10.8.0.2'), v6only: [{ family: 'IPv6', address: 'fe80::1', internal: false }] }),
    fsImpl: fakeFs({ lo: 0x9 | 0x1000, eth0: 0x1003 | 0x1000, wlan0: 0x1003, docker0: 0x1000, tun0: 0x1 }), // wlan0 up+mc, docker0 mc but down, tun0 up but no mc
  });
  assert.deepStrictEqual(list.map((i) => i.id), ['loopback', 'eth0', 'wlan0']);
  assert.strictEqual(list[0].label, 'This computer only');
  assert.strictEqual(list[0].address, '127.0.0.1');
  assert.strictEqual(list[0].usable, true);
  assert.ok(!list.some((i) => ['docker0', 'tun0', 'v6only'].includes(i.id)), 'inactive / non-multicast / IPv6-only interfaces are not offered');
});

test('discovery (Linux): loopback without the MULTICAST flag is shown as unusable with an actionable reason, never hidden or swapped', () => {
  const list = mcm.discoverInterfaces({ platform: 'linux', osImpl: fakeOs({ lo: nic('127.0.0.1', true), eth0: nic('192.168.1.5') }), fsImpl: fakeFs({ lo: 0x9, eth0: 0x1003 }) });
  assert.strictEqual(list[0].id, 'loopback');
  assert.strictEqual(list[0].label, 'This computer only');
  assert.strictEqual(list[0].usable, false);
  assert.match(list[0].reason, /multicast/i);
  assert.match(list[0].reason, /ip link set lo multicast on/);
});

test('discovery (macOS/Windows style: no flag information): loopback is offered and the join decides', () => {
  const list = mcm.discoverInterfaces({ platform: 'darwin', osImpl: fakeOs({ lo0: nic('127.0.0.1', true), en0: nic('192.168.1.9') }), fsImpl: fakeFs({}) });
  assert.deepStrictEqual(list.map((i) => [i.id, i.usable, i.multicast]), [['loopback', true, null], ['en0', true, null]]);
  assert.strictEqual(list[0].name, 'lo0');
});

test('discovery: no loopback found or an OS error still yields an unusable "This computer only" entry', () => {
  const none = mcm.discoverInterfaces({ platform: 'linux', osImpl: fakeOs({ eth0: nic('192.168.1.5') }), fsImpl: fakeFs({ eth0: 0x1003 }) });
  assert.strictEqual(none[0].id, 'loopback'); assert.strictEqual(none[0].usable, false);
  const boom = mcm.discoverInterfaces({ osImpl: { networkInterfaces() { throw new Error('boom'); } } });
  assert.strictEqual(boom.length, 1); assert.strictEqual(boom[0].usable, false);
});

test('discovery on this machine does not throw and always starts with the loopback entry', () => {
  const list = mcm.discoverInterfaces();
  assert.strictEqual(list[0].id, 'loopback');
  assert.strictEqual(list[0].label, 'This computer only');
});

// ---- protocol parsing ---------------------------------------------------------------------------------------
test('parser: reference-script sample datagrams (heartbeat and logged ADIF)', () => {
  const hb = Buffer.from('adbccbda000000020000000000000006' + Buffer.from('WSJT-X').toString('hex') + '00000003' + '00000005' + Buffer.from('2.5.2').toString('hex') + '00000000', 'hex');
  const m = parseWsjtxDatagram(hb);
  assert.deepStrictEqual(m.heartbeat, { id: 'WSJT-X', maxSchema: 3, version: '2.5.2' });
  const a = parseWsjtxDatagram(logged());
  assert.strictEqual(a.type, 12);
  assert.ok(a.adif.includes('<call:5>YO9HP'));
  assert.strictEqual(a.heartbeat, undefined);
});

test('parser: other message types are recognised but carry neither heartbeat nor ADIF', () => {
  const m = parseWsjtxDatagram(Buffer.concat([header(1), qstr('WSJT-X'), u32(14074000)]));
  assert.strictEqual(m.type, 1); assert.strictEqual(m.heartbeat, undefined); assert.strictEqual(m.adif, undefined); assert.ok(!m.malformed);
});

test('parser: foreign, short and truncated datagrams never throw and never count as a heartbeat', () => {
  assert.strictEqual(parseWsjtxDatagram(Buffer.from('junk')), null);
  assert.strictEqual(parseWsjtxDatagram(Buffer.from('<call:4>K1AB <eor>')), null);
  assert.strictEqual(parseWsjtxDatagram(Buffer.alloc(0)), null);
  assert.strictEqual(parseWsjtxDatagram(null), null);
  const hb = heartbeat();
  for (let n = 12; n < hb.length; n++) { const m = parseWsjtxDatagram(hb.subarray(0, n)); assert.ok(m.malformed && !m.heartbeat, `cut at ${n}`); }
  const lie = Buffer.concat([header(12), qstr('WSJT-X'), u32(5000), Buffer.from('short')]);
  assert.ok(parseWsjtxDatagram(lie).malformed);
  assert.ok(parseWsjtxDatagram(Buffer.concat([header(0), u32(0xfffffff0)])).malformed);
});

// ---- state / colour mapping ---------------------------------------------------------------------------------
test('mcState: off, error, waiting (amber) and active (green), with the 2 minute heartbeat window', () => {
  const base = { enabled: true, listening: true, error: '', lastHeartbeat: 0, now: 500_000 };
  assert.strictEqual(mcm.mcState({ ...base, enabled: false }), 'off');
  assert.strictEqual(mcm.mcState({ ...base, error: 'EADDRINUSE' }), 'error');
  assert.strictEqual(mcm.mcState({ ...base, listening: false }), 'error');
  assert.strictEqual(mcm.mcState(base), 'waiting');
  assert.strictEqual(mcm.mcState({ ...base, lastHeartbeat: 500_000 - 119_999 }), 'active');
  assert.strictEqual(mcm.mcState({ ...base, lastHeartbeat: 500_000 - 120_000 }), 'active');
  assert.strictEqual(mcm.mcState({ ...base, lastHeartbeat: 500_000 - 120_001 }), 'waiting');
  assert.strictEqual(mcm.HEARTBEAT_STALE_MS, 120_000);
  assert.strictEqual(mcm.mcState({ ...base, error: 'x', lastHeartbeat: 500_000 }), 'error', 'an error wins over a recent heartbeat');
});

// ---- listener lifecycle -------------------------------------------------------------------------------------
test('start: joins the group on the chosen interface and is amber until the first heartbeat', async () => {
  const { l, dgramImpl } = mkListener();
  await l.start({ ...MC, interface: 'eth0' });
  const s = dgramImpl.made[0];
  assert.deepStrictEqual(s.joined, { group: '224.0.0.1', iface: '192.168.1.5' });
  assert.deepStrictEqual(s.bound, { port: 2237, addr: '224.0.0.1' });
  assert.strictEqual(s.createOpts.reuseAddr, true);
  assert.strictEqual(l.status().state, 'waiting');
  assert.strictEqual(l.status().listening, true);
  await l.stop();
});

test('start on Windows binds 0.0.0.0 (cannot bind a multicast address)', async () => {
  const { l, dgramImpl } = mkListener({ platform: 'win32' });
  await l.start(MC);
  assert.strictEqual(dgramImpl.made[0].bound.addr, '0.0.0.0');
  await l.stop();
});

test('"This computer only" joins on the discovered loopback address', async () => {
  const { l, dgramImpl } = mkListener();
  await l.start(MC);
  assert.deepStrictEqual(dgramImpl.made[0].joined, { group: '224.0.0.1', iface: '127.0.0.1' });
  assert.strictEqual(l.status().interfaceLabel, 'This computer only');
  await l.stop();
});

test('loopback without multicast: no socket is created, state is red, and nothing falls back to another interface', async () => {
  const { l, dgramImpl } = mkListener({ ifaces: BAD_LOOP });
  await l.start(MC);
  assert.strictEqual(dgramImpl.made.length, 0);
  const s = l.status();
  assert.strictEqual(s.state, 'error'); assert.strictEqual(s.listening, false);
  assert.match(s.error, /Multicast is not enabled on the loopback/);
});

test('failures are red and never throw: bad config, missing interface, bind error, join error', async () => {
  for (const [cfg, opts, re] of [
    [{ ...MC, address: '10.1.1.1' }, {}, /not a multicast address/],
    [{ ...MC, port: 0 }, {}, /Port/],
    [{ ...MC, interface: 'wlan9' }, {}, /wlan9.*not available/],
    [MC, { sock: { bindError: 'EADDRINUSE' } }, /EADDRINUSE/],
    [{ ...MC, interface: 'eth0' }, { sock: { joinError: 'ENODEV' } }, /Could not join 224\.0\.0\.1.*ENODEV/],
  ]) {
    const { l, dgramImpl } = mkListener(opts);
    await l.start(cfg);
    const s = l.status();
    assert.strictEqual(s.state, 'error', String(re));
    assert.match(s.error, re);
    assert.strictEqual(s.listening, false);
    assert.ok(dgramImpl.made.every((x) => x.closed), 'sockets from failed starts are closed');
  }
});

test('a runtime socket error turns the status red and closes the socket', async () => {
  const { l, dgramImpl } = mkListener();
  const seen = [];
  l.on('status', () => seen.push(l.status().state));
  await l.start({ ...MC, interface: 'eth0' });
  dgramImpl.made[0].emit('error', Object.assign(new Error('network down'), { code: 'ENETDOWN' }));
  assert.strictEqual(l.status().state, 'error');
  assert.match(l.status().error, /ENETDOWN/);
  assert.ok(dgramImpl.made[0].closed);
  assert.strictEqual(seen.at(-1), 'error');
});

test('heartbeat: turns green, emits status once, and goes back to amber after 2 minutes without one', async () => {
  const { l, clock, dgramImpl } = mkListener();
  await l.start(MC);
  let changes = 0; l.on('status', () => { changes++; });
  const sock = dgramImpl.made[0];
  sock.emit('message', heartbeat());
  assert.strictEqual(l.status().state, 'active'); assert.strictEqual(changes, 1);
  clock.t += 15_000; sock.emit('message', heartbeat());
  assert.strictEqual(changes, 1, 'steady heartbeats do not spam status events');
  clock.t += 119_000; assert.strictEqual(l.status().state, 'active');
  clock.t += 2_000; assert.strictEqual(l.status().state, 'waiting');
  sock.emit('message', heartbeat());
  assert.strictEqual(l.status().state, 'active');
  await l.stop();
});

test('the stale transition fires a status event on its own timer (no new traffic needed)', async () => {
  const realSet = global.setTimeout; const timers = [];
  global.setTimeout = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
  try {
    const { l, clock, dgramImpl } = mkListener();
    await l.start(MC);
    timers.length = 0;
    dgramImpl.made[0].emit('message', heartbeat());
    const stale = timers.at(-1);
    assert.ok(stale.ms >= 120_000 && stale.ms < 121_000);
    let fired = 0; l.on('status', () => { fired++; });
    clock.t += 121_000; stale.fn();
    assert.strictEqual(fired, 1); assert.strictEqual(l.status().state, 'waiting');
    await l.stop();
  } finally { global.setTimeout = realSet; }
});

test('an ADIF record is not a heartbeat; a heartbeat is not an ADIF record', async () => {
  const { l, dgramImpl } = mkListener();
  await l.start(MC);
  const got = []; l.on('adif', (t) => got.push(t));
  const sock = dgramImpl.made[0];
  sock.emit('message', logged());
  assert.strictEqual(got.length, 1); assert.strictEqual(l.status().state, 'waiting', 'ADIF alone leaves the status amber');
  sock.emit('message', heartbeat());
  assert.strictEqual(got.length, 1); assert.strictEqual(l.status().state, 'active');
  await l.stop();
});

test('malformed, foreign and truncated packets are ignored without crashing or changing state', async () => {
  const { l, dgramImpl } = mkListener();
  await l.start(MC);
  const sock = dgramImpl.made[0]; let adifs = 0; l.on('adif', () => { adifs++; });
  for (const pkt of [Buffer.from('hello'), Buffer.alloc(0), heartbeat().subarray(0, 20), logged().subarray(0, 30), Buffer.from('not a buffer'.split(''))]) {
    assert.doesNotThrow(() => sock.emit('message', pkt));
  }
  assert.doesNotThrow(() => sock.emit('message', undefined));
  assert.strictEqual(adifs, 0); assert.strictEqual(l.status().state, 'waiting');
  await l.stop();
});

test('stop closes the socket and clears state; restart reconfigures and starts from amber', async () => {
  const { l, dgramImpl } = mkListener();
  await l.start(MC);
  dgramImpl.made[0].emit('message', heartbeat());
  assert.strictEqual(l.status().state, 'active');
  await l.start({ ...MC, address: '239.5.5.5', port: 3000, interface: 'eth0' });
  assert.ok(dgramImpl.made[0].closed);
  assert.deepStrictEqual(dgramImpl.made[1].joined, { group: '239.5.5.5', iface: '192.168.1.5' });
  assert.strictEqual(l.status().state, 'waiting', 'heartbeat history is not carried across a restart');
  assert.strictEqual(l.status().port, 3000);
  await l.stop();
  assert.ok(dgramImpl.made[1].closed); assert.strictEqual(l.status().state, 'off');
  dgramImpl.made[1].emit('message', logged()); // late packet after stop: ignored
});

// ---- AdifServer integration ---------------------------------------------------------------------------------
function mkServer(mc, extra = {}) {
  const settings = { adifServer: { enabled: true, bind: '127.0.0.1', tcp: false, tcpPort: 2333, udp: false, udpPort: 2333, multicast: mc, ...extra } };
  const srv = new AdifServer({ getSettings: () => settings });
  const dgramImpl = fakeDgram();
  srv.mc = new mcm.MulticastListener({ dgramImpl, discover: () => IFACES, logger: quiet });
  srv.mc.on('adif', (t) => srv._deliver(t, 'WSJT-X multicast'));
  srv.mc.on('status', () => srv.emit('status', srv.status()));
  return { srv, settings, dgramImpl };
}

test('multicast ADIF goes through the same _deliver() path as TCP/UDP and reaches the "records" event', async () => {
  const { srv, dgramImpl } = mkServer({ enabled: true, ...MC });
  const got = []; srv.on('records', (recs, source) => got.push({ recs, source }));
  await srv.apply();
  dgramImpl.made[0].emit('message', logged());
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].source, 'WSJT-X multicast');
  assert.strictEqual(got[0].recs[0].CALL, 'YO9HP');
  assert.strictEqual(srv.status().received, 1);
  await srv.stop();
});

test('status().multicast: disabled, amber, green and red as seen by the dashboard and settings page', async () => {
  const off = mkServer({ enabled: false, ...MC });
  await off.srv.apply();
  assert.deepStrictEqual([off.srv.status().multicast.enabled, off.srv.status().multicast.state, off.dgramImpl.made.length], [false, 'off', 0]);

  const { srv, dgramImpl } = mkServer({ enabled: true, ...MC });
  const events = []; srv.on('status', (s) => events.push(s.multicast.state));
  await srv.apply();
  assert.strictEqual(srv.status().multicast.state, 'waiting');
  assert.strictEqual(srv.status().multicast.address, '224.0.0.1'); assert.strictEqual(srv.status().multicast.port, 2237);
  dgramImpl.made[0].emit('message', heartbeat());
  assert.strictEqual(srv.status().multicast.state, 'active');
  assert.strictEqual(events.at(-1), 'active', 'pushed to the renderer without a restart');
  await srv.stop();
  assert.strictEqual(srv.status().multicast.state, 'off', 'stopped listener is not reported as listening');

  const bad = mkServer({ enabled: true, ...MC, address: 'nope' });
  await bad.srv.apply();
  assert.strictEqual(bad.srv.status().multicast.state, 'error');
  assert.ok(bad.srv.status().multicast.error);
});

test('master ADIF switch off stops multicast too; TCP and UDP still start independently of multicast', async () => {
  const { srv, settings, dgramImpl } = mkServer({ enabled: true, ...MC }, { udp: true, udpPort: 0 });
  await srv.apply();
  assert.ok(srv.udp, 'UDP listener still starts'); assert.strictEqual(dgramImpl.made.length, 1);
  settings.adifServer.enabled = false;
  await srv.apply();
  assert.ok(dgramImpl.made[0].closed); assert.strictEqual(srv.udp, null); assert.strictEqual(srv.status().multicast.state, 'off');
});

test('a multicast failure leaves the TCP/UDP listeners running', async () => {
  const { srv } = mkServer({ enabled: true, ...MC, interface: 'nope' }, { udp: true, udpPort: 0 });
  await srv.apply();
  assert.ok(srv.udp); assert.strictEqual(srv.status().multicast.state, 'error');
  await srv.stop();
});

// ---- renderer status line ----------------------------------------------------------------------------------
function loadUtil() {
  const el = () => ({ addEventListener() {}, classList: { add() {}, remove() {}, contains: () => false }, style: {} });
  const ctx = { document: { querySelector: el, querySelectorAll: () => [], createElement: el, body: el() }, console, location: { hash: '' }, setTimeout, clearTimeout, addEventListener() {} };
  ctx.window = ctx; ctx.cl = { on() {}, call: async () => null };
  vm.createContext(ctx);
  vm.runInContext(read('src', 'renderer', 'util.js'), ctx, { filename: 'util.js' });
  return ctx.App.util;
}

test('status line text is exactly "MC listening on {ip}:{port}" with red / amber / green classes', () => {
  const u = loadUtil();
  const mc = { enabled: true, address: '224.0.0.1', port: 2237, error: '' };
  const strip = (h) => String(h).replace(/<[^>]*>/g, '');
  const green = String(u.mcStatusLine({ ...mc, state: 'active' }));
  const amber = String(u.mcStatusLine({ ...mc, state: 'waiting' }));
  const red = String(u.mcStatusLine({ ...mc, state: 'error', error: 'Could not join 224.0.0.1 on eth0: ENODEV' }));
  assert.match(green, /MC <span class="text-success"[^>]*>listening on 224\.0\.0\.1:2237<\/span>/);
  assert.match(amber, /MC <span class="mc-amber"[^>]*>listening on 224\.0\.0\.1:2237<\/span>/);
  assert.match(red, /MC <span class="text-danger"[^>]*>listening on 224\.0\.0\.1:2237<\/span>/);
  assert.match(red, /ENODEV/);
  assert.strictEqual(strip(green), 'MC listening on 224.0.0.1:2237');
  assert.strictEqual(strip(amber), 'MC listening on 224.0.0.1:2237');
  assert.match(read('src', 'renderer', 'styles.css'), /\.mc-amber \{ color: #ffc107;/);
  assert.match(read('src', 'renderer', 'styles.css'), /\.dot\.warn \{ background: #ffc107; \}/, 'same amber as the Offline mode chip');
});

test('status line: disabled is not labelled "listening"; missing status is safe; errors are escaped', () => {
  const u = loadUtil();
  for (const mc of [undefined, null, {}, { enabled: false, state: 'off', address: '224.0.0.1', port: 2237 }]) {
    const h = String(u.mcStatusLine(mc));
    assert.ok(!/listening/.test(h)); assert.match(h, /MC <span class="text-muted">off<\/span>/);
  }
  assert.ok(!String(u.mcStatusLine({ enabled: true, state: 'error', address: '224.0.0.1', port: 1, error: '<img src=x onerror=alert(1)>' })).includes('<img'));
});

// ---- UI wiring (real dashboard.js / settings.js in a fake DOM) ---------------------------------------------
test('dashboard and settings both render the multicast line from the shared status', () => {
  assert.match(read('src', 'renderer', 'pages', 'dashboard.js'), /mcStatusLine\(adif\.multicast\)/);
  assert.match(read('src', 'renderer', 'pages', 'settings.js'), /mcStatusLine\(s\.multicast\)/);
  const m = read('src', 'main', 'main.js');
  assert.match(m, /'adif:interfaces'/);
  assert.match(m, /adifServer\)\s*!==\s*JSON\.stringify\(now\.adifServer\)\) await adif\.apply\(\)/, 'multicast settings changes restart the listener via the existing apply()');
});

// ---- release plumbing ---------------------------------------------------------------------------------------
test('release 0.4.1: README keeps the release notes, and this file is part of npm test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.includes('test/release-041.test.js'));
  assert.match(read('README.md'), /^### 0\.4\.1$/m);
});
