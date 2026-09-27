'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const dgram = require('dgram');
const { RigService, parseRigList } = require('../src/main/rig');
const { AdifServer, parseWsjtx } = require('../src/main/adifserver');
const { SETTINGS_DEFAULTS } = require('../src/main/store');

const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('timed out');
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function ask(port, cmd) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    let out = '';
    s.on('data', (d) => { out += d; if (out.split('\n').length > 1) { s.end(); resolve(out); } });
    s.on('error', reject);
    s.write(`${cmd}\n`);
  });
}

test('parse rigctl -l output', () => {
  const t = ' Rig #  Mfg                    Model                   Version         Status      Macro\n     1  Hamlib                 Dummy                   20221128.0      Stable      RIG_MODEL_DUMMY\n  1035  Yaesu                  FT-991                  20220611.0      Stable      RIG_MODEL_FT991\n';
  const l = parseRigList(t);
  assert.deepStrictEqual(l.map((x) => [x.id, x.mfg, x.model]), [[1, 'Hamlib', 'Dummy'], [1035, 'Yaesu', 'FT-991']]);
});

test('serial mode: spawn rigctld (dummy rig), poll, set, relay for other apps', async () => {
  const settings = clone(SETTINGS_DEFAULTS);
  const relayPort = await freePort();
  settings.rig = { ...settings.rig, mode: 'serial', model: 1, pollMs: 100 };
  settings.relay = { enabled: true, bind: '127.0.0.1', port: relayPort };
  const rig = new RigService({ getSettings: () => settings });
  const updates = [];
  rig.on('update', (s) => updates.push(s));
  await rig.apply();
  await until(() => rig.status().state === 'connected' && rig.status().freqHz);
  assert.ok(rig.status().mode);
  await rig.setFrequency(14074000);
  await rig.setMode('USB');
  await until(() => rig.status().freqHz === 14074000 && rig.status().mode === 'USB');
  assert.ok(updates.length >= 1);

  // another program talking to our published rigctl port sees the same rig
  assert.strictEqual((await ask(relayPort, 'f')).trim(), '14074000');
  assert.strictEqual(rig.status().relay.listening, true);

  // reconnect on settings change works and cleans up
  settings.relay.enabled = false;
  await rig.apply();
  assert.strictEqual(rig.status().relay.listening, false);
  await until(() => rig.status().state === 'connected');
  await rig.stop();
});

test('dummy rig applies the configured default frequency and mode on connect', async () => {
  const settings = clone(SETTINGS_DEFAULTS);
  settings.rig = { mode: 'serial', model: 1, pollMs: 100, defaultFreqMhz: '14.225', defaultMode: 'USB' };
  settings.relay = { enabled: false, bind: '127.0.0.1', port: 4532 };
  const rig = new RigService({ getSettings: () => settings });
  await rig.apply();
  await until(() => rig.status().freqHz === 14225000 && rig.status().mode === 'USB');
  await rig.stop();
});

test('dummy rig default is skipped without a configured value, and never touches a real (net-mode) rig', async () => {
  // net mode: even with model=1 and defaults set, we didn't spawn this rigctld ourselves, so leave it alone
  const upstreamSettings = clone(SETTINGS_DEFAULTS);
  upstreamSettings.rig = { mode: 'serial', model: 1, pollMs: 100 };
  upstreamSettings.relay = { enabled: true, bind: '127.0.0.1', port: await freePort() };
  const upstream = new RigService({ getSettings: () => upstreamSettings });
  await upstream.apply();
  await until(() => upstream.status().state === 'connected' && upstream.status().freqHz);
  await upstream.setFrequency(7100000);

  const clientSettings = clone(SETTINGS_DEFAULTS);
  clientSettings.rig = { mode: 'net', host: '127.0.0.1', port: upstreamSettings.relay.port, pollMs: 100, model: 1, defaultFreqMhz: '14.225', defaultMode: 'USB' };
  clientSettings.relay = { enabled: false, bind: '127.0.0.1', port: 4532 };
  const client = new RigService({ getSettings: () => clientSettings });
  await client.apply();
  await until(() => client.status().state === 'connected' && client.status().freqHz);
  await sleep(500);
  assert.strictEqual(client.status().freqHz, 7100000, 'net mode must not override the remote rig\'s actual frequency');
  await client.stop();
  await upstream.stop();
});


test('net mode: connects to a remote rigctld and exposes it through the relay', async () => {
  // upstream = a local dummy rigctld started by a first service
  const s1 = clone(SETTINGS_DEFAULTS);
  const p1 = await freePort();
  s1.rig = { ...s1.rig, mode: 'serial', model: 1, pollMs: 100 };
  s1.relay = { enabled: true, bind: '127.0.0.1', port: p1 };
  const a = new RigService({ getSettings: () => s1 });
  await a.apply();
  await until(() => a.status().state === 'connected');
  await a.setFrequency(7123000);

  const s2 = clone(SETTINGS_DEFAULTS);
  const p2 = await freePort();
  s2.rig = { ...s2.rig, mode: 'net', host: '127.0.0.1', port: p1, pollMs: 100 };
  s2.relay = { enabled: true, bind: '127.0.0.1', port: p2 };
  const b = new RigService({ getSettings: () => s2 });
  await b.apply();
  await until(() => b.status().freqHz === 7123000);
  assert.strictEqual((await ask(p2, 'f')).trim(), '7123000');

  // loop guard
  s2.relay.port = p1;
  await b.apply();
  assert.match(b.status().relay.error, /same as the radio/);
  await b.stop();
  await a.stop();
});

test('net mode reports a clear error and retries when nothing is listening', async () => {
  const s = clone(SETTINGS_DEFAULTS);
  s.rig = { mode: 'net', host: '127.0.0.1', port: await freePort(), pollMs: 100 };
  s.relay = { enabled: false, bind: '127.0.0.1', port: 4532 };
  const rig = new RigService({ getSettings: () => s });
  await rig.apply();
  await until(() => rig.status().state === 'error');
  assert.match(rig.status().message, /ECONNREFUSED/);
  await rig.stop();
});

test('serial mode without rigctld gives an install hint', async () => {
  const s = clone(SETTINGS_DEFAULTS);
  s.rig = { mode: 'serial', model: 1, rigctldPath: '/nonexistent/rigctld' };
  s.relay = { enabled: false, bind: '127.0.0.1', port: 4532 };
  const oldPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  const rig = new RigService({ getSettings: () => s });
  const dirsBefore = rig.info();
  await rig.apply();
  process.env.PATH = oldPath;
  // /usr/bin fallback may still find a system rigctld; only assert when it did not.
  if (!dirsBefore.rigctld) assert.match(rig.status().message, /libhamlib-utils/);
  await rig.stop();
});

function wsjtxPacket(adif) {
  const str = (s) => { const b = Buffer.from(s, 'latin1'); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
  const head = Buffer.alloc(12);
  head.writeUInt32BE(0xadbccbda, 0); head.writeUInt32BE(2, 4); head.writeUInt32BE(12, 8);
  return Buffer.concat([head, str('WSJT-X'), str(adif)]);
}

test('ADIF server: TCP stream, plain UDP and WSJT-X UDP', async () => {
  const s = clone(SETTINGS_DEFAULTS);
  const tcpPort = await freePort();
  const udpPort = await freePort();
  s.adifServer = { enabled: true, bind: '127.0.0.1', tcp: true, tcpPort, udp: true, udpPort };
  const srv = new AdifServer({ getSettings: () => s });
  const got = [];
  srv.on('records', (r, src) => got.push(...r.map((x) => [x.CALL, src])));
  await srv.apply();
  assert.ok(srv.status().tcp.listening && srv.status().udp.listening);

  // TCP: two records split across chunks, header included
  const c = net.createConnection({ port: tcpPort, host: '127.0.0.1' });
  await new Promise((r) => c.on('connect', r));
  c.write('<adif_ver:5>3.1.4<eoh>\n<call:5>K1ABC<freq:6>14.074<mode:3>FT8<eo');
  await sleep(50);
  c.write('r>\n<call:5>W1AW/<mode:2>CW<eor>');
  await until(() => got.length === 2);
  c.end();

  // UDP plain ADIF
  const u = dgram.createSocket('udp4');
  u.send('<call:5>N0XYZ<mode:3>SSB<freq:5>7.185<eor>', udpPort, '127.0.0.1');
  await until(() => got.length === 3);
  // UDP WSJT-X "Logged ADIF"
  u.send(wsjtxPacket('\n<adif_ver:5>3.1.0\n<EOH>\n<call:6>VK2ABC<mode:3>FT8<freq:6>14.074<eor>'), udpPort, '127.0.0.1');
  await until(() => got.length === 4);
  u.close();
  assert.deepStrictEqual(got.map((g) => g[0]), ['K1ABC', 'W1AW/', 'N0XYZ', 'VK2ABC']);
  assert.strictEqual(got[3][1], 'WSJT-X');
  assert.strictEqual(parseWsjtx(Buffer.from('junk')), null);
  await srv.stop();
});

test('ADIF server reports port conflicts instead of throwing', async () => {
  const port = await freePort();
  const blocker = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.on('listening', r));
  const s = clone(SETTINGS_DEFAULTS);
  s.adifServer = { enabled: true, bind: '127.0.0.1', tcp: true, tcpPort: port, udp: false, udpPort: 0 };
  const srv = new AdifServer({ getSettings: () => s });
  await srv.apply();
  assert.match(srv.status().tcp.error, /EADDRINUSE/);
  assert.strictEqual(srv.status().tcp.listening, false);
  blocker.close();
});
