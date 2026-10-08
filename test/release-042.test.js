'use strict';
/*
 * Release 0.4.2: flrig-compatible XML-RPC radio sharing.
 * Protocol/lifecycle/client-count tests use a fake radio (no hardware). A few integration tests run the real
 * RigManager against Hamlib's dummy rig through a real rigctld (needs libhamlib-utils, like rigmanager.test.js).
 * None of this is a test against a real fldigi or a real radio.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const fx = require('../src/main/flrigxml');
const { RigManager } = require('../src/main/rig');
const { SETTINGS_DEFAULTS, JsonStore, newRig, migrateRigs } = require('../src/main/store');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const refused = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(false); }); s.once('error', () => res(true)); });

// ---- helpers: XML-RPC over real HTTP -----------------------------------------------------------------------
const val = (v) => {
  if (typeof v === 'string') return `<string>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`;
  if (v instanceof fx.XmlDouble) return `<double>${v.v}</double>`;
  if (Number.isInteger(v)) return `<int>${v}</int>`;
  if (typeof v === 'number') return `<double>${v}</double>`;
  return `<string>${v}</string>`;
};
const callXml = (method, params = []) => `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map((p) => `<param><value>${val(p)}</value></param>`).join('')}</params></methodCall>`;
function post(port, body, { agent = 'test', keepAlive, httpAgent, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': agent, 'Content-Length': Buffer.byteLength(body), Connection: keepAlive ? 'keep-alive' : 'close' };
    const req = http.request({ host: '127.0.0.1', port, method, path: '/RPC2', headers, agent: httpAgent || false }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject); req.end(body);
  });
}
/** Decodes a methodResponse into { value } or { fault: {code, message} } using the module's own codec. */
function decode(xml) {
  const root = fx.parseXml(xml.replace(/<\?xml[^>]*\?>/, ''));
  const f = root.children.find((c) => c.name === 'fault');
  if (f) { const s = fx.decodeValue(f.children[0]); return { fault: { code: s.faultCode, message: s.faultString } }; }
  return { value: fx.decodeValue(root.children[0].children[0].children[0]) };
}
const rpc = async (port, m, params, opts) => decode((await post(port, callXml(m, params), opts)).body);

// ---- fake radio ----------------------------------------------------------------------------------------------
class FakeRadio {
  constructor() {
    this.state = { state: 'connected', message: '', freqHz: 14074000, mode: 'USB', ptt: false };
    this.mutex = new fx.Mutex();
    this.log = []; this.delay = 0; this.vfo = 'VFOA'; this.passband = 2400; this.pttWorks = true; this.rejectMode = false;
  }
  rigName() { return 'Fake Rig'; }
  async cat(cmd, n = 1) {
    this.log.push(cmd); if (this.delay) await sleep(this.delay);
    if (this.state.state !== 'connected') throw new Error('not connected');
    if (cmd === 'v') return [this.vfo];
    if (cmd.startsWith('V ')) { this.vfo = cmd.slice(2); return ['RPRT 0']; }
    if (cmd === 'm') return [this.state.mode, String(this.passband)];
    if (cmd.startsWith('M ')) { const [, mode, pb] = cmd.split(' '); this.state.mode = mode; this.passband = Number(pb); return ['RPRT 0']; }
    return ['RPRT -11'];
  }
  exclusive(fn) { return this.mutex.run(fn); }
  async setFrequency(hz) { this.log.push(`F ${hz}`); if (this.delay) await sleep(this.delay); this.state.freqHz = hz; }
  async setMode(mode) { this.log.push(`M ${mode} 0`); if (this.rejectMode) throw new Error('Radio refused mode change (RPRT -1)'); this.state.mode = mode; }
  async setPtt(on) { this.log.push(`T ${on ? 1 : 0}`); if (!this.pttWorks) throw new Error('Radio refused PTT change (RPRT -1)'); this.state.ptt = !!on; }
  noteState(p) { Object.assign(this.state, p); }
}
const mkSrv = (radio = new FakeRadio(), cfg = {}, extra = {}) => {
  const conf = { enabled: true, bind: '127.0.0.1', port: 0, ...cfg };
  const srv = new fx.FlrigXmlRpcServer({ getConfig: () => conf, radio, sweepMs: 3600000, ...extra });
  return { srv, radio, conf };
};
async function mkStarted(radio, extra) {
  const port = await freePort();
  const m = mkSrv(radio, { port }, extra);
  assert.strictEqual(await m.srv.start(), true);
  return { ...m, port };
}
const direct = async (srv, method, params = []) => decode(await srv.handle(callXml(method, params)));

// ---- configuration -------------------------------------------------------------------------------------------
test('config: settings without XML-RPC load valid with sharing off; new radios default off, port 12345', () => {
  const data = clone(SETTINGS_DEFAULTS);
  data.rigs = [{ id: 'old', label: 'Old', mode: 'net', host: '127.0.0.1', port: 4532, enabled: true, relay: { enabled: true, bind: '127.0.0.1', port: 4533 } }];
  data.activeRigId = 'old';
  migrateRigs(data);
  assert.deepStrictEqual(data.rigs[0].xmlrpc, { enabled: false, bind: '127.0.0.1', port: 12345 });
  assert.deepStrictEqual(fx.xmlrpcConfig({}), { enabled: false, bind: '127.0.0.1', port: 12345 });
  assert.deepStrictEqual(newRig('x').xmlrpc, { enabled: false, bind: '127.0.0.1', port: 12345 });
  // an old single-rig file migrates too
  const legacy = clone(SETTINGS_DEFAULTS); delete legacy.rigs; legacy.rig = { mode: 'net', host: '127.0.0.1', port: 4532 }; legacy.relay = { enabled: true, bind: '127.0.0.1', port: 4534 };
  migrateRigs(legacy);
  assert.strictEqual(legacy.rigs[0].xmlrpc.enabled, false);
  assert.strictEqual(legacy.rigs[0].relay.enabled, true, 'Hamlib sharing config untouched');
});

test('config: xmlrpc settings persist and are independent of the Hamlib relay block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-xr-'));
  const file = path.join(dir, 'settings.json');
  try {
    const st = new JsonStore(file, SETTINGS_DEFAULTS);
    st.data.rigs = [newRig('a', { relay: { enabled: true, bind: '127.0.0.1', port: 4532 }, xmlrpc: { enabled: true, bind: '0.0.0.0', port: 12400 } })];
    st.saveNow();
    const back = new JsonStore(file, SETTINGS_DEFAULTS);
    migrateRigs(back.data);
    assert.deepStrictEqual(back.data.rigs[0].xmlrpc, { enabled: true, bind: '0.0.0.0', port: 12400 });
    assert.deepStrictEqual(back.data.rigs[0].relay, { enabled: true, bind: '127.0.0.1', port: 4532 });
    back.data.rigs[0].xmlrpc.enabled = false; // switching one off leaves the other on
    assert.strictEqual(back.data.rigs[0].relay.enabled, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('port validation: range, integer, and clashes with Hamlib ports / other radios / the radio connection', () => {
  for (const p of [1, 12345, 65535, '12345']) assert.strictEqual(fx.validatePort(p), '', String(p));
  for (const p of [0, -1, 65536, 1.5, 'abc', '', null, undefined]) assert.notStrictEqual(fx.validatePort(p), '', String(p));
  const a = newRig('a', { label: 'A', relay: { enabled: true, bind: '127.0.0.1', port: 4532 }, xmlrpc: { enabled: true, bind: '127.0.0.1', port: 12345 } });
  const b = newRig('b', { label: 'B', relay: { enabled: true, bind: '127.0.0.1', port: 4540 }, xmlrpc: { enabled: true, bind: '127.0.0.1', port: 12346 } });
  assert.strictEqual(fx.validateXmlrpcSharing([a, b], a), '');
  assert.match(fx.validateXmlrpcSharing([a, b], { ...a, xmlrpc: { enabled: true, bind: '127.0.0.1', port: 4532 } }), /Hamlib port/, 'own relay');
  assert.match(fx.validateXmlrpcSharing([a, b], { ...a, xmlrpc: { enabled: true, bind: '127.0.0.1', port: 12346 } }), /"B"/, "other radio's XML-RPC");
  assert.match(fx.validateXmlrpcSharing([a, b], { ...a, xmlrpc: { enabled: true, bind: '127.0.0.1', port: 4540 } }), /Hamlib port of "B"/, "other radio's Hamlib port");
  assert.match(fx.validateXmlrpcSharing([a, b], { ...a, xmlrpc: { enabled: true, bind: '0.0.0.0', port: 12346 } }), /"B"/, '0.0.0.0 overlaps loopback');
  assert.strictEqual(fx.validateXmlrpcSharing([a, { ...b, xmlrpc: { enabled: true, bind: '10.0.0.5', port: 12345 } }], a), '', 'different specific addresses do not clash');
  assert.match(fx.validateXmlrpcSharing([a], { ...a, mode: 'net', host: '127.0.0.1', port: 12345 }), /radio connection/);
  assert.strictEqual(fx.validateXmlrpcSharing([a, b], { ...a, xmlrpc: { enabled: false, bind: '127.0.0.1', port: 4532 } }), '', 'disabled sharing never errors');
  assert.match(fx.validateXmlrpcSharing([a], { ...a, xmlrpc: { enabled: true, bind: '127.0.0.1', port: 70000 } }), /1 to 65535/);
});

// ---- codec ---------------------------------------------------------------------------------------------------
test('codec: value types round-trip; untyped values are strings; hostile XML is rejected', () => {
  const call = fx.parseMethodCall('<?xml version="1.0"?><methodCall><methodName> rig.x </methodName><params>'
    + '<param><value><i4>5</i4></value></param><param><value><double>7.5e6</double></value></param><param><value>plain &amp; text</value></param>'
    + '<param><value><boolean>1</boolean></value></param><param><value><array><data><value><int>1</int></value><value><string>a</string></value></data></array></value></param>'
    + '<param><value><struct><member><name>k</name><value><int>2</int></value></member></struct></value></param></params></methodCall>');
  assert.deepStrictEqual(call, { method: 'rig.x', params: [5, 7.5e6, 'plain & text', true, [1, 'a'], { k: 2 }] });
  assert.strictEqual(fx.parseMethodCall('<methodCall><methodName>a.b</methodName></methodCall>').params.length, 0);
  for (const bad of ['', 'not xml', '<methodCall>', '<a></b>', '<!DOCTYPE x [<!ENTITY y "z">]><methodCall/>', '<methodResponse/>', '<methodCall><params/></methodCall>',
    '<methodCall><methodName>a</methodName><params><param><value><int>x</int></value></param></params></methodCall>',
    '<methodCall><methodName>a</methodName><params><param><value><blob>1</blob></value></param></params></methodCall>',
    `<methodCall><methodName>a</methodName><params><param>${'<value><array><data>'.repeat(40)}</param></params></methodCall>`]) {
    assert.throws(() => fx.parseMethodCall(bad), undefined, bad.slice(0, 40));
  }
  assert.strictEqual(fx.encodeValue('a<b&'), '<value><string>a&lt;b&amp;</string></value>');
  assert.strictEqual(fx.encodeValue(5), '<value><int>5</int></value>');
  assert.strictEqual(fx.encodeValue(1.5), '<value><double>1.5</double></value>');
  assert.strictEqual(fx.encodeValue(['x']), '<value><array><data><value><string>x</string></value></data></array></value>');
  assert.match(fx.faultXml(-1, 'bad <x>'), /<fault>.*faultCode.*-1.*faultString.*bad &lt;x&gt;/s);
});

// ---- method surface -------------------------------------------------------------------------------------------
const REFERENCE_PY_METHODS = ['main.get_version', 'rig.get_xcvr', 'rig.get_AB', 'rig.get_vfo', 'rig.set_vfo', 'main.set_frequency', 'rig.get_mode', 'rig.get_modes', 'rig.set_mode', 'rig.get_ptt', 'rig.set_ptt'];
const FLDIGI_METHODS = ['system.listMethods', 'rig.get_vfo', 'rig.set_vfo', 'rig.get_mode', 'rig.set_mode', 'rig.get_modes', 'rig.get_sideband', 'rig.get_bw', 'rig.set_bw', 'rig.get_bws', 'rig.get_AB', 'rig.get_xcvr', 'rig.set_ptt', 'rig.get_ptt'];
const EXPECTED = ['main.get_version', 'main.set_frequency', 'rig.get_AB', 'rig.get_bw', 'rig.get_bws', 'rig.get_mode', 'rig.get_modeA', 'rig.get_modeB', 'rig.get_modes', 'rig.get_ptt', 'rig.get_sideband', 'rig.get_vfo', 'rig.get_vfoA', 'rig.get_vfoB', 'rig.get_xcvr',
  'rig.list_methods', 'rig.set_AB', 'rig.set_bw', 'rig.set_frequency', 'rig.set_mode', 'rig.set_modeA', 'rig.set_modeB', 'rig.set_ptt', 'rig.set_ptt_fast', 'rig.set_vfo', 'rig.set_vfoA', 'rig.set_vfoB',
  'system.listMethods', 'system.methodHelp', 'system.methodSignature'].sort();
const UNSUPPORTED = ['rig.get_notch', 'rig.set_notch', 'rig.get_split', 'rig.set_split', 'rig.get_smeter', 'rig.get_pwrmeter', 'rig.get_power', 'rig.set_power', 'rig.cat_priority', 'rig.cat_string', 'rig.cwio_text', 'rig.fskio_text', 'rig.get_update', 'rig.get_info', 'rig.swap', 'rig.shutdown', 'rig.tune', 'rig.set_verify_vfo', 'rig.get_bwA', 'rig.set_bwA', 'rig.vfoA2B'];

test('method inventory: every rig_bridge.py and fldigi method exists; the list is exactly the documented one; unsupported methods fault', async () => {
  const { srv } = mkSrv();
  const listed = (await direct(srv, 'system.listMethods')).value;
  assert.deepStrictEqual([...listed].sort(), EXPECTED);
  for (const m of [...REFERENCE_PY_METHODS, ...FLDIGI_METHODS]) assert.ok(listed.includes(m), m);
  for (const m of UNSUPPORTED) {
    assert.ok(!listed.includes(m), m);
    assert.strictEqual((await direct(srv, m, [])).fault.code, fx.FAULT.NO_METHOD, m);
  }
  const lm = (await direct(srv, 'rig.list_methods')).value;
  assert.deepStrictEqual(lm.map((x) => x.name).sort(), EXPECTED);
  assert.ok(lm.every((x) => typeof x.signature === 'string' && typeof x.help === 'string'));
  assert.deepStrictEqual((await direct(srv, 'system.methodSignature', ['rig.get_vfo'])).value, [['string']]);
  assert.match((await direct(srv, 'system.methodHelp', ['rig.set_ptt'])).value, /PTT/);
  assert.strictEqual((await direct(srv, 'system.methodHelp', ['nope'])).fault.code, fx.FAULT.NO_METHOD);
});

test('identification: version string keeps Hamlib flrig clients in compatibility mode; xcvr name; unused args allowed', async () => {
  const { srv } = mkSrv(new FakeRadio(), {}, { version: '0.4.2 (cloudlog-desktop, flrig-compatible XML-RPC)' });
  const v = (await direct(srv, 'main.get_version')).value;
  assert.strictEqual(typeof v, 'string');
  const [a, b, c, d] = (/^(\d+)\.(\d+)\.(\d+)\.?(\d*)/.exec(v) || []).slice(1).map(Number);
  assert.ok(a * 1e9 + b * 1e6 + c * 1e3 + (d || 0) < 1003054000, 'below flrig 1.3.54, so clients do not expect the *_verify methods');
  assert.strictEqual((await direct(srv, 'rig.get_xcvr')).value, 'Fake Rig');
});

test('frequency: reads are Hz strings; writes accept double/int/numeric string, validate, and use the radio layer', async () => {
  const { srv, radio } = mkSrv();
  assert.strictEqual((await direct(srv, 'rig.get_vfo')).value, '14074000');
  for (const [m, p, hz] of [['rig.set_vfo', new fx.XmlDouble(7074000), 7074000], ['main.set_frequency', 3573000, 3573000], ['rig.set_frequency', '10136000', 10136000], ['rig.set_vfo', new fx.XmlDouble(14074000.4), 14074000]]) {
    const r = await direct(srv, m, [p]);
    assert.strictEqual(r.fault, undefined, m);
    assert.strictEqual(radio.state.freqHz, hz);
    assert.strictEqual((await direct(srv, 'rig.get_vfo')).value, String(hz));
  }
  assert.strictEqual((await direct(srv, 'rig.set_frequency', [14074000])).value, 1, 'flrig returns 1 from rig.set_frequency');
  const before = radio.log.length;
  for (const bad of [[], ['abc'], [0], [-5], [1e12], [1, 2]]) {
    const r = await direct(srv, 'rig.set_vfo', bad);
    assert.strictEqual(r.fault.code, fx.FAULT.BAD_PARAMS, JSON.stringify(bad));
  }
  assert.strictEqual(radio.log.length, before, 'invalid requests never reach the radio');
  radio.rejectFreq = true;
  radio.setFrequency = async () => { throw new Error('Radio refused frequency change (RPRT -1)'); };
  const refused1 = await direct(srv, 'rig.set_vfo', [7100000]);
  assert.strictEqual(refused1.fault.code, fx.FAULT.CAT);
  assert.strictEqual(radio.state.freqHz, 14074000, 'state not changed when the radio refused');
});

test('mode: names and rig_bridge-style indexes; unsupported/invalid modes fault; radio refusal faults; sideband', async () => {
  const { srv, radio } = mkSrv();
  const modes = (await direct(srv, 'rig.get_modes')).value;
  assert.ok(Array.isArray(modes) && modes.every((m) => typeof m === 'string') && modes.includes('USB') && modes.includes('LSB'));
  assert.strictEqual((await direct(srv, 'rig.get_mode')).value, 'USB');
  assert.strictEqual((await direct(srv, 'rig.set_mode', ['lsb'])).value, 1);
  assert.strictEqual(radio.state.mode, 'LSB');
  assert.strictEqual((await direct(srv, 'rig.get_sideband')).value, 'L');
  await direct(srv, 'rig.set_mode', [modes.indexOf('USB')]);
  assert.strictEqual((await direct(srv, 'rig.get_sideband')).value, 'U');
  for (const bad of [[], ['NOPE'], [99], [-1], [1.5], ['USB', 'x']]) assert.strictEqual((await direct(srv, 'rig.set_mode', bad)).fault.code, fx.FAULT.BAD_PARAMS, JSON.stringify(bad));
  radio.rejectMode = true;
  assert.strictEqual((await direct(srv, 'rig.set_mode', ['CW'])).fault.code, fx.FAULT.CAT);
  assert.strictEqual(radio.state.mode, 'USB', 'unchanged after a refusal');
});

test('bandwidth: get_bw is [value, ""], get_bws is a table, set_bw takes a table index', async () => {
  const { srv, radio } = mkSrv();
  assert.deepStrictEqual((await direct(srv, 'rig.get_bw')).value, ['2400', '']);
  const bws = (await direct(srv, 'rig.get_bws')).value;
  assert.deepStrictEqual(bws[0].slice(1), fx.BANDWIDTHS);
  assert.strictEqual(bws[0][0], 'Bandwidth');
  assert.strictEqual((await direct(srv, 'rig.set_bw', [4])).value, 0);
  assert.strictEqual(radio.passband, Number(fx.BANDWIDTHS[4]));
  assert.deepStrictEqual((await direct(srv, 'rig.get_bw')).value, [fx.BANDWIDTHS[4], '']);
  for (const bad of [[], [-1], [fx.BANDWIDTHS.length], ['x'], [1.5]]) assert.strictEqual((await direct(srv, 'rig.set_bw', bad)).fault.code, fx.FAULT.BAD_PARAMS);
  radio.passband = 0;
  assert.deepStrictEqual((await direct(srv, 'rig.get_bw')).value, ['', ''], 'unknown passband is empty, not a made-up number');
});

test('PTT: set/get round trip, 0/1 only, refusals fault and never report success', async () => {
  const { srv, radio } = mkSrv();
  assert.strictEqual((await direct(srv, 'rig.get_ptt')).value, 0);
  assert.strictEqual((await direct(srv, 'rig.set_ptt', [1])).fault, undefined);
  assert.strictEqual((await direct(srv, 'rig.get_ptt')).value, 1);
  assert.strictEqual((await direct(srv, 'rig.set_ptt_fast', [0])).fault, undefined);
  assert.strictEqual(radio.state.ptt, false);
  for (const bad of [[], [2], [-1], ['on'], [0, 1]]) assert.strictEqual((await direct(srv, 'rig.set_ptt', bad)).fault.code, fx.FAULT.BAD_PARAMS, JSON.stringify(bad));
  radio.pttWorks = false;
  assert.strictEqual((await direct(srv, 'rig.set_ptt', [1])).fault.code, fx.FAULT.CAT);
  assert.strictEqual((await direct(srv, 'rig.get_ptt')).value, 0);
});

test('VFO: get/set A/B, A/B-suffixed methods only act on the active VFO, radios without VFO query report A', async () => {
  const { srv, radio } = mkSrv();
  assert.strictEqual((await direct(srv, 'rig.get_AB')).value, 'A');
  assert.strictEqual((await direct(srv, 'rig.get_vfoA')).value, '14074000');
  assert.strictEqual((await direct(srv, 'rig.get_vfoB')).fault.code, fx.FAULT.CAT, 'B is not active: not faked');
  assert.strictEqual((await direct(srv, 'rig.set_vfoB', [7000000])).fault.code, fx.FAULT.CAT);
  assert.strictEqual(radio.state.freqHz, 14074000);
  assert.strictEqual((await direct(srv, 'rig.set_AB', ['B'])).fault, undefined);
  assert.strictEqual(radio.vfo, 'VFOB');
  assert.strictEqual((await direct(srv, 'rig.get_AB')).value, 'B');
  assert.strictEqual((await direct(srv, 'rig.set_vfoB', [7000000])).fault, undefined);
  assert.strictEqual((await direct(srv, 'rig.get_modeB')).value, 'USB');
  assert.strictEqual((await direct(srv, 'rig.set_modeA', ['LSB'])).fault.code, fx.FAULT.CAT);
  assert.strictEqual((await direct(srv, 'rig.set_AB', ['C'])).fault.code, fx.FAULT.BAD_PARAMS);
  radio.cat = async () => ['RPRT -11'];
  assert.strictEqual((await direct(srv, 'rig.get_AB')).value, 'A');
  assert.strictEqual((await direct(srv, 'rig.set_AB', ['B'])).fault.code, fx.FAULT.CAT);
});

test('disconnected / unavailable radio: control methods fault, identification does not pretend', async () => {
  const { srv, radio } = mkSrv();
  radio.state = { state: 'error', message: 'rigctld stopped', freqHz: null, mode: null, ptt: false };
  for (const [m, p] of [['rig.get_vfo', []], ['rig.set_vfo', [7000000]], ['rig.get_mode', []], ['rig.set_mode', ['USB']], ['rig.get_bw', []], ['rig.get_ptt', []], ['rig.set_ptt', [1]], ['rig.get_AB', []], ['rig.set_AB', ['A']], ['rig.get_sideband', []]]) {
    const r = await direct(srv, m, p);
    assert.strictEqual(r.fault && r.fault.code, fx.FAULT.NO_RADIO, m);
    assert.match(r.fault.message, /not connected/i);
  }
  assert.strictEqual((await direct(srv, 'rig.get_xcvr')).value, '', 'flrig reports an empty transceiver name when offline');
  assert.ok((await direct(srv, 'main.get_version')).value);
  assert.ok((await direct(srv, 'system.listMethods')).value.length);
  radio.state = { state: 'connected', message: '', freqHz: null, mode: null, ptt: false }; // connected but radio silent
  assert.strictEqual((await direct(srv, 'rig.get_vfo')).fault.code, fx.FAULT.NO_RADIO);
  radio.state.freqHz = 7000000;
  assert.strictEqual((await direct(srv, 'rig.get_mode')).fault.code, fx.FAULT.NO_RADIO);
});

// ---- HTTP behaviour --------------------------------------------------------------------------------------------
test('HTTP: POST works on any path, faults are HTTP 200, GET is 405, malformed/oversized/garbage do not hurt the server', async () => {
  const { srv, port } = await mkStarted();
  try {
    const ok = await post(port, callXml('rig.get_vfo'));
    assert.strictEqual(ok.status, 200); assert.match(ok.headers['content-type'], /text\/xml/);
    assert.strictEqual(decode(ok.body).value, '14074000');
    assert.strictEqual((await post(port, callXml('rig.get_vfo'), { method: 'GET' })).status, 405);
    const bad = await post(port, '<<<not xml');
    assert.strictEqual(bad.status, 200); assert.strictEqual(decode(bad.body).fault.code, fx.FAULT.PARSE);
    const big = await post(port, `<methodCall><methodName>${'a'.repeat(2 * 1024 * 1024)}</methodName></methodCall>`).catch((e) => ({ status: e.code }));
    assert.ok(big.status === 413 || big.status === 'EPIPE' || big.status === 'ECONNRESET', String(big.status));
    await new Promise((res) => { const s = net.connect(port, '127.0.0.1', () => { s.write('\x00\x01garbage\r\n\r\n'); }); s.on('data', () => {}); s.on('close', res); s.on('error', res); setTimeout(() => { s.destroy(); res(); }, 500); });
    assert.strictEqual((await rpc(port, 'rig.get_vfo')).value, '14074000', 'still serving');
    const empty = await post(port, '');
    assert.strictEqual(decode(empty.body).fault.code, fx.FAULT.PARSE);
  } finally { await srv.stop(); }
});

test('HTTP: keep-alive connections are reused for many calls', async () => {
  const { srv, port } = await mkStarted();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const socks = new Set();
    for (let i = 0; i < 6; i++) {
      const r = await post(port, callXml('rig.get_vfo'), { keepAlive: true, httpAgent: agent });
      assert.strictEqual(decode(r.body).value, '14074000');
      socks.add(Object.values(agent.sockets).flat()[0]);
    }
    assert.strictEqual(socks.size, 1);
  } finally { agent.destroy(); await srv.stop(); }
});

test('concurrency: parallel clients all succeed and compound operations never interleave on the radio', async () => {
  const radio = new FakeRadio(); radio.delay = 3;
  const { srv, port } = await mkStarted(radio);
  try {
    const jobs = [];
    for (let i = 1; i <= 12; i++) {
      jobs.push(rpc(port, 'rig.set_vfoA', [7000000 + i], { agent: `c${i % 3}` }));
      jobs.push(rpc(port, 'rig.set_AB', ['A'], { agent: `c${i % 3}` }));
      jobs.push(rpc(port, 'rig.get_vfo', [], { agent: `c${i % 3}` }));
    }
    const res = await Promise.all(jobs);
    assert.ok(res.every((r) => r.fault === undefined), JSON.stringify(res.find((r) => r.fault)));
    // every set_vfoA is the pair [v, F n] with nothing in between; set_AB is a lone [V VFOA]
    const log = radio.log;
    let i = 0; let pairs = 0; let sets = 0;
    while (i < log.length) {
      if (log[i] === 'v') { assert.match(log[i + 1], /^F \d+$/, `v must be followed by its F at ${i}: ${log.slice(i, i + 3)}`); i += 2; pairs++; } else { assert.strictEqual(log[i], 'V VFOA'); i++; sets++; }
    }
    assert.strictEqual([pairs, sets].join(), '12,12');
  } finally { await srv.stop(); }
});

test('backpressure: a flood beyond the queue limit is answered with a busy fault, not a hang', async () => {
  const radio = new FakeRadio(); radio.delay = 20;
  const { srv } = mkSrv(radio);
  radio.mutex = new fx.Mutex(4);
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => direct(srv, 'rig.set_vfoA', [7000000 + i])));
  assert.ok(rs.some((r) => r.fault && r.fault.code === fx.FAULT.BUSY));
  assert.ok(rs.some((r) => r.fault === undefined));
});

test('a stuck radio produces a timeout fault instead of hanging the client', async () => {
  const radio = new FakeRadio(); radio.delay = 400;
  const { srv } = mkSrv(radio, {}, { deadlineMs: 60 });
  assert.strictEqual((await direct(srv, 'rig.set_AB', ['A'])).fault.code, fx.FAULT.TIMEOUT);
  await sleep(450);
});

// ---- lifecycle -------------------------------------------------------------------------------------------------
test('lifecycle: starting -> listening only after bind; stop closes the port; restart on a new port; idempotent stop', async () => {
  const p1 = await freePort(); const p2 = await freePort();
  const { srv, conf } = mkSrv(new FakeRadio(), { port: p1 });
  const states = []; srv.on('state', () => states.push(srv.status().state));
  assert.strictEqual(srv.status().listening, false);
  const started = srv.start();
  assert.strictEqual(srv.status().state, 'starting'); assert.strictEqual(srv.status().listening, false, 'not "open" before it is accepting');
  assert.strictEqual(await started, true);
  assert.deepStrictEqual([srv.status().state, srv.status().listening, srv.status().port], ['listening', true, p1]);
  assert.strictEqual((await rpc(p1, 'rig.get_vfo')).value, '14074000');
  conf.port = p2; // reconfigure = restart
  assert.strictEqual(await srv.start(), true);
  assert.strictEqual(await refused(p1), true, 'old port released'); assert.strictEqual(srv.status().port, p2);
  assert.strictEqual((await rpc(p2, 'rig.get_vfo')).value, '14074000');
  await srv.stop(); await srv.stop();
  assert.strictEqual(await refused(p2), true);
  assert.deepStrictEqual([srv.status().state, srv.status().listening, srv.status().clients], ['stopped', false, 0]);
  assert.ok(states.includes('starting') && states.includes('listening') && states.at(-1) === 'stopped');
});

test('lifecycle: bind failure is reported as an error, never as open, and does not disturb another listener', async () => {
  const taken = net.createServer(); await new Promise((r) => taken.listen(0, '127.0.0.1', r));
  const busy = taken.address().port;
  const good = await mkStarted();
  try {
    const { srv } = mkSrv(new FakeRadio(), { port: busy });
    assert.strictEqual(await srv.start(), false);
    const st = srv.status();
    assert.deepStrictEqual([st.state, st.listening], ['error', false]);
    assert.match(st.error, /EADDRINUSE/); assert.match(st.error, new RegExp(String(busy)));
    assert.strictEqual((await rpc(good.port, 'rig.get_vfo')).value, '14074000');
    await srv.stop();
    const bad = mkSrv(new FakeRadio(), { port: 99999 });
    assert.strictEqual(await bad.srv.start(), false); assert.strictEqual(bad.srv.status().state, 'error'); assert.match(bad.srv.status().error, /1 to 65535/);
  } finally { await good.srv.stop(); await new Promise((r) => taken.close(r)); }
});

test('lifecycle: stop() during start does not leave a listening socket behind', async () => {
  const port = await freePort();
  const { srv } = mkSrv(new FakeRadio(), { port });
  const p = srv.start();
  await srv.stop();
  await p;
  assert.strictEqual(await refused(port), true);
  assert.strictEqual(srv.status().listening, false);
});

// ---- client counting -------------------------------------------------------------------------------------------
test('clients: short-lived connections from one program count once; programs are told apart; stale records expire', async () => {
  const clock = { t: 1_000_000 };
  const { srv, port } = await mkStarted(new FakeRadio(), { now: () => clock.t, ttlMs: 10000 });
  const counts = []; srv.on('clients', (n) => counts.push(n));
  try {
    assert.strictEqual(srv.status().clients, 0);
    for (let i = 0; i < 10; i++) await rpc(port, 'rig.get_vfo', [], { agent: 'fldigi' }); // HTTP/1.0 style: new connection per call
    assert.strictEqual(srv.status().clients, 1, 'ten requests are not ten clients');
    await rpc(port, 'rig.get_mode', [], { agent: 'other-app' });
    assert.strictEqual(srv.status().clients, 2);
    await until(() => [...srv.clients.values()].every((c) => c.conns.size === 0));
    clock.t += 9000; srv.sweep();
    assert.strictEqual(srv.status().clients, 2, 'still counted inside the grace period');
    await rpc(port, 'rig.get_vfo', [], { agent: 'fldigi' }); // fldigi is still polling
    clock.t += 5000; srv.sweep();
    assert.strictEqual(srv.status().clients, 1, 'the silent one expired, the polling one stays');
    assert.strictEqual(srv.clients.size, 1, 'expired records are deleted, not just hidden');
    clock.t += 20000; srv.sweep();
    assert.strictEqual(srv.status().clients, 0); assert.strictEqual(srv.clients.size, 0);
    assert.deepStrictEqual(counts.filter((n, i) => i === 0 || n !== counts[i - 1]).slice(0, 3), [1, 2, 1]);
  } finally { await srv.stop(); }
});

test('clients: a kept-alive connection counts while open, then lingers one grace period after it closes', async () => {
  const clock = { t: 5_000_000 };
  const { srv, port } = await mkStarted(new FakeRadio(), { now: () => clock.t, ttlMs: 10000 });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    await rpc(port, 'rig.get_vfo', [], { agent: 'poller', keepAlive: true, httpAgent: agent });
    assert.strictEqual(srv.status().clients, 1);
    clock.t += 60000; srv.sweep();
    assert.strictEqual(srv.status().clients, 1, 'open connection: not stale however long since the last request');
    agent.destroy();
    await until(() => [...srv.clients.values()].every((c) => c.conns.size === 0));
    assert.strictEqual(srv.status().clients, 1, 'disconnect is not an instant drop (a poller may reconnect)');
    clock.t += 10001; srv.sweep();
    assert.strictEqual(srv.status().clients, 0); assert.strictEqual(srv.clients.size, 0);
  } finally { agent.destroy(); await srv.stop(); }
});

test('clients: connections that never send a request are not clients; stop() forgets everyone', async () => {
  const { srv, port } = await mkStarted();
  const idle = net.connect(port, '127.0.0.1'); await new Promise((r) => idle.once('connect', r));
  assert.strictEqual(srv.status().clients, 0);
  await rpc(port, 'rig.get_vfo');
  assert.strictEqual(srv.status().clients, 1);
  await srv.stop(); idle.destroy();
  assert.strictEqual(srv.status().clients, 0); assert.strictEqual(srv.clients.size, 0);
});

// ---- integration with the real RigManager / rigctld (dummy rig) ---------------------------------------------------
async function mkRig(cfg = {}) {
  const [relayPort, xmlPort] = [await freePort(), await freePort()];
  const settings = clone(SETTINGS_DEFAULTS);
  settings.rigs = [newRig('a', { label: 'Shack', mode: 'serial', model: 1, pollMs: 100, enabled: true, pttType: 'RIG',
    relay: { enabled: true, bind: '127.0.0.1', port: relayPort }, xmlrpc: { enabled: true, bind: '127.0.0.1', port: xmlPort }, ...cfg })];
  settings.activeRigId = 'a';
  const mgr = new RigManager({ getSettings: () => settings, appVersion: '0.4.2' });
  await mgr.reconcile();
  await until(() => mgr.statusOne('a').state === 'connected' && mgr.statusOne('a').freqHz);
  return { mgr, settings, ready: () => until(() => mgr.statusOne('a').state === 'connected' && mgr.statusOne('a').freqHz), relayPort: settings.rigs[0].relay.port, xmlPort: settings.rigs[0].xmlrpc.port };
}
function hamlib(port, cmd) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1'); let buf = '';
    s.on('connect', () => s.write(`${cmd}\n`)); s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); resolve(buf.trim()); } }); s.on('error', reject);
    setTimeout(() => { s.destroy(); reject(new Error('hamlib timeout')); }, 3000);
  });
}

test('both sharing options on at once: Hamlib and XML-RPC clients drive the same radio and see each other\'s changes', async () => {
  const { mgr, relayPort, xmlPort } = await mkRig();
  try {
    const st = mgr.statusOne('a');
    assert.deepStrictEqual([st.relay.listening, st.xmlrpc.listening, st.xmlrpc.state], [true, true, 'listening']);
    assert.strictEqual(await hamlib(relayPort, 'F 7100000'), 'RPRT 0');
    await until(async () => (await rpc(xmlPort, 'rig.get_vfo')).value === '7100000');
    assert.strictEqual((await rpc(xmlPort, 'rig.set_vfo', [new fx.XmlDouble(3573000)])).fault, undefined);
    assert.strictEqual(await hamlib(relayPort, 'f'), '3573000');
    assert.strictEqual((await rpc(xmlPort, 'rig.set_mode', ['LSB'])).value, 1);
    assert.strictEqual((await hamlib(relayPort, 'm')).split('\n')[0], 'LSB');
    assert.strictEqual(mgr.statusOne('a').freqHz, 3573000, 'the app itself sees the XML-RPC change');
    assert.strictEqual(mgr.services.get('a').sock !== null, true, 'one CAT connection shared by all');
  } finally { await mgr.stopAll(); }
});

test('real rigctld: representative reads/writes for frequency, mode, bandwidth, PTT, VFO through the app\'s connection', async () => {
  const { mgr, xmlPort } = await mkRig();
  try {
    assert.strictEqual((await rpc(xmlPort, 'rig.get_xcvr')).value, 'Shack'.length ? mgr.services.get('a').rigName() : '');
    assert.strictEqual((await rpc(xmlPort, 'rig.get_vfo')).value, '14225000');
    assert.strictEqual((await rpc(xmlPort, 'rig.set_vfo', [new fx.XmlDouble(10136000)])).fault, undefined);
    assert.strictEqual((await rpc(xmlPort, 'rig.get_vfo')).value, '10136000', 'immediately visible, not after the next poll');
    assert.strictEqual((await rpc(xmlPort, 'rig.set_mode', ['CW'])).value, 1);
    assert.strictEqual((await rpc(xmlPort, 'rig.get_mode')).value, 'CW');
    assert.strictEqual((await rpc(xmlPort, 'rig.set_bw', [1])).fault, undefined);
    await until(async () => (await rpc(xmlPort, 'rig.get_bw')).value[0] === fx.BANDWIDTHS[1]);
    assert.strictEqual((await rpc(xmlPort, 'rig.set_ptt', [1])).fault, undefined);
    assert.strictEqual((await rpc(xmlPort, 'rig.get_ptt')).value, 1);
    await until(() => mgr.statusOne('a').ptt === true);
    assert.strictEqual((await rpc(xmlPort, 'rig.set_ptt', [0])).fault, undefined);
    assert.strictEqual((await rpc(xmlPort, 'rig.get_ptt')).value, 0);
    assert.strictEqual((await rpc(xmlPort, 'rig.get_AB')).value, 'A');
    assert.strictEqual((await rpc(xmlPort, 'rig.set_AB', ['B'])).fault, undefined);
    assert.strictEqual((await rpc(xmlPort, 'rig.get_AB')).value, 'B');
  } finally { await mgr.stopAll(); }
});

test('real rigctld: a radio without PTT support makes set_ptt fault (no false success)', async (t) => {
  const { mgr, xmlPort, relayPort } = await mkRig({ pttType: '' });
  try {
    // Whether Hamlib's dummy rig refuses PTT with no PTT type depends on the Hamlib version (4.5.5 refuses, newer
    // ones may accept). Probe the installed rigctld and only assert the fault when it really refuses.
    const probe = await hamlib(relayPort, 'T 1');
    if (probe === 'RPRT 0') { await hamlib(relayPort, 'T 0'); t.skip('this Hamlib dummy rig accepts PTT without a PTT type; refusal is covered by the fake-radio PTT test'); return; }
    const r = await rpc(xmlPort, 'rig.set_ptt', [1]);
    assert.strictEqual(r.fault.code, fx.FAULT.CAT);
    assert.strictEqual(mgr.statusOne('a').ptt, false);
  } finally { await mgr.stopAll(); }
});

test('real rigctld: 40 concurrent XML-RPC clients plus Hamlib traffic and the poll loop stay consistent', async () => {
  const { mgr, relayPort, xmlPort } = await mkRig();
  try {
    const jobs = [];
    for (let i = 0; i < 40; i++) {
      jobs.push(rpc(xmlPort, i % 2 ? 'rig.get_vfo' : 'rig.set_vfo', i % 2 ? [] : [7000000 + i], { agent: `u${i % 4}` }));
      if (i % 8 === 0) jobs.push(hamlib(relayPort, 'f'));
    }
    const rs = await Promise.all(jobs);
    assert.ok(rs.every((r) => !r || r.fault === undefined), JSON.stringify(rs.filter((r) => r && r.fault)));
    const last = Number((await rpc(xmlPort, 'rig.get_vfo')).value);
    assert.strictEqual(await hamlib(relayPort, 'f'), String(last));
    assert.ok(mgr.statusOne('a').xmlrpc.clients >= 1 && mgr.statusOne('a').xmlrpc.clients <= 5, 'four polling agents plus the final check');
  } finally { await mgr.stopAll(); }
});

test('each option works alone: Hamlib only, XML-RPC only; disabling one leaves the other', async () => {
  const hOnly = await mkRig({ xmlrpc: { enabled: false, bind: '127.0.0.1', port: await freePort() } });
  try {
    const st = hOnly.mgr.statusOne('a');
    assert.deepStrictEqual([st.relay.listening, st.xmlrpc.enabled, st.xmlrpc.listening, st.xmlrpc.state], [true, false, false, 'stopped']);
    assert.strictEqual(await hamlib(hOnly.relayPort, 'F 7050000'), 'RPRT 0');
    assert.strictEqual(await refused(hOnly.settings.rigs[0].xmlrpc.port), true);
  } finally { await hOnly.mgr.stopAll(); }
  const xOnly = await mkRig({ relay: { enabled: false, bind: '127.0.0.1', port: await freePort() } });
  try {
    const st = xOnly.mgr.statusOne('a');
    assert.deepStrictEqual([st.relay.enabled, st.relay.listening, st.xmlrpc.listening], [false, false, true]);
    assert.strictEqual((await rpc(xOnly.xmlPort, 'rig.set_vfo', [7050000])).fault, undefined);
    assert.strictEqual(await refused(xOnly.settings.rigs[0].relay.port), true);
    // turn Hamlib sharing on while XML-RPC keeps working
    xOnly.settings.rigs[0].relay.enabled = true;
    await xOnly.mgr.applyOne('a');
    await until(() => xOnly.mgr.statusOne('a').relay.listening && xOnly.mgr.statusOne('a').xmlrpc.listening && xOnly.mgr.statusOne('a').state === 'connected' && xOnly.mgr.statusOne('a').freqHz);
    assert.strictEqual((await rpc(xOnly.xmlPort, 'rig.get_vfo')).fault, undefined);
  } finally { await xOnly.mgr.stopAll(); }
});

test('preserved Hamlib sharing: relay status shape and a plain rigctl client are unchanged by XML-RPC being on or off', async () => {
  for (const enabled of [false, true]) {
    const r = await mkRig({ xmlrpc: { enabled, bind: '127.0.0.1', port: await freePort() } });
    try {
      const st = r.mgr.statusOne('a');
      assert.deepStrictEqual(Object.keys(st.relay).sort(), ['bind', 'clients', 'enabled', 'error', 'listening', 'port']);
      assert.strictEqual(await hamlib(r.relayPort, 'F 14074000'), 'RPRT 0');
      await until(() => r.mgr.statusOne('a').freqHz === 14074000);
    } finally { await r.mgr.stopAll(); }
  }
});

test('XML-RPC bind failure or port clash leaves the CAT connection and the Hamlib port working', async () => {
  const taken = net.createServer(); await new Promise((r) => taken.listen(0, '127.0.0.1', r));
  const busy = taken.address().port;
  const r1 = await mkRig({ xmlrpc: { enabled: true, bind: '127.0.0.1', port: busy } });
  try {
    const st = r1.mgr.statusOne('a');
    assert.deepStrictEqual([st.xmlrpc.listening, st.xmlrpc.state], [false, 'error']);
    assert.match(st.xmlrpc.error, /EADDRINUSE/);
    assert.strictEqual(st.state, 'connected'); assert.strictEqual(st.relay.listening, true);
    assert.strictEqual(await hamlib(r1.relayPort, 'f'), String(st.freqHz));
  } finally { await r1.mgr.stopAll(); }
  const relayPort = await freePort();
  const r2 = await mkRig({ relay: { enabled: true, bind: '127.0.0.1', port: relayPort }, xmlrpc: { enabled: true, bind: '127.0.0.1', port: relayPort } });
  try {
    const st = r2.mgr.statusOne('a');
    assert.strictEqual(st.xmlrpc.listening, false); assert.match(st.xmlrpc.error, /Hamlib port/);
    assert.strictEqual(st.relay.listening, true); assert.strictEqual(st.state, 'connected');
  } finally { await r2.mgr.stopAll(); await new Promise((r) => taken.close(r)); }
});

test('reconfigure, disable, reconnect and shutdown leave no sockets behind', async () => {
  const r = await mkRig();
  try { await reconfigureScenario(r); } finally { await r.mgr.stopAll(); }
});

async function reconfigureScenario(r) {
  const oldX = r.xmlPort; const oldH = r.relayPort;
  const newX = await freePort();
  r.settings.rigs[0].xmlrpc.port = newX;
  await r.mgr.applyOne('a');
  await until(() => r.mgr.statusOne('a').xmlrpc.listening && r.mgr.statusOne('a').state === 'connected' && r.mgr.statusOne('a').freqHz);
  assert.strictEqual(await refused(oldX), true); assert.strictEqual(r.mgr.statusOne('a').xmlrpc.port, newX);
  assert.strictEqual((await rpc(newX, 'rig.get_vfo')).fault, undefined);
  // reconnect: killing the connection and re-applying (what the app does) brings the listener back with the radio
  await r.mgr.applyOne('a');
  await until(() => r.mgr.statusOne('a').xmlrpc.listening && r.mgr.statusOne('a').state === 'connected' && r.mgr.statusOne('a').freqHz);
  assert.strictEqual((await rpc(newX, 'rig.get_vfo')).fault, undefined);
  r.settings.rigs[0].xmlrpc.enabled = false;
  await r.mgr.applyOne('a');
  await until(() => r.mgr.statusOne('a').state === 'connected');
  assert.strictEqual(await refused(newX), true);
  assert.strictEqual(r.mgr.statusOne('a').xmlrpc.state, 'stopped'); assert.strictEqual(r.mgr.statusOne('a').xmlrpc.clients, 0);
  r.settings.rigs[0].xmlrpc.enabled = true;
  await r.mgr.applyOne('a');
  await until(() => r.mgr.statusOne('a').xmlrpc.listening);
  await rpc(newX, 'rig.get_vfo');
  await r.mgr.stopAll();
  assert.strictEqual(await refused(newX), true); assert.strictEqual(await refused(oldH), true);
  assert.strictEqual(r.mgr.services.get('a').xml, null);
}

test('two radios keep separate XML-RPC listeners and counts', async () => {
  const settings = clone(SETTINGS_DEFAULTS);
  const [p1, p2, h1, h2] = [await freePort(), await freePort(), await freePort(), await freePort()];
  settings.rigs = [
    newRig('a', { label: 'A', mode: 'serial', model: 1, pollMs: 100, enabled: true, relay: { enabled: true, bind: '127.0.0.1', port: h1 }, xmlrpc: { enabled: true, bind: '127.0.0.1', port: p1 } }),
    newRig('b', { label: 'B', mode: 'serial', model: 1, pollMs: 100, enabled: true, relay: { enabled: true, bind: '127.0.0.1', port: h2 }, xmlrpc: { enabled: true, bind: '127.0.0.1', port: p2 } }),
  ];
  settings.activeRigId = 'a';
  const mgr = new RigManager({ getSettings: () => settings });
  await mgr.reconcile();
  try {
    await until(() => ['a', 'b'].every((id) => mgr.statusOne(id).state === 'connected' && mgr.statusOne(id).freqHz));
    await rpc(p1, 'rig.set_vfo', [7000000]); await rpc(p2, 'rig.set_vfo', [3500000]);
    assert.strictEqual((await rpc(p1, 'rig.get_vfo')).value, '7000000'); assert.strictEqual((await rpc(p2, 'rig.get_vfo')).value, '3500000');
    assert.deepStrictEqual([mgr.statusOne('a').xmlrpc.clients, mgr.statusOne('b').xmlrpc.clients], [1, 1]);
    assert.deepStrictEqual([mgr.statusOne('a').xmlrpc.port, mgr.statusOne('b').xmlrpc.port], [p1, p2]);
  } finally { await mgr.stopAll(); }
});

test('status events: listener state and client count changes reach the app\'s status stream', async () => {
  const r = await mkRig();
  try {
    const seen = [];
    r.mgr.on('status', (id, s) => seen.push(s.xmlrpc.clients));
    await rpc(r.xmlPort, 'rig.get_vfo', [], { agent: 'a1' });
    await rpc(r.xmlPort, 'rig.get_vfo', [], { agent: 'a2' });
    assert.ok(seen.includes(1) && seen.includes(2));
  } finally { await r.mgr.stopAll(); }
});

test('RigManager reports a safe default xmlrpc block for radios that are not running', () => {
  const settings = clone(SETTINGS_DEFAULTS);
  settings.rigs = [{ ...newRig('a', { label: 'Idle' }), xmlrpc: undefined }]; // an old radio object with no xmlrpc key at all
  const mgr = new RigManager({ getSettings: () => settings });
  const st = mgr.statusOne('a');
  assert.deepStrictEqual(st.xmlrpc, { enabled: false, state: 'stopped', listening: false, port: 12345, bind: '127.0.0.1', clients: 0, error: '' });
});

// ---- renderer (real settings.js / dashboard.js in a fake DOM) -----------------------------------------------------------
function mkApp(rigStatus) {
  const els = new Map();
  const mk = (sel) => {
    if (!els.has(sel)) els.set(sel, { innerHTML: '', value: '', checked: false, dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {}, querySelectorAll: () => [], querySelector: () => null });
    return els.get(sel);
  };
  const doc = { querySelector: mk, querySelectorAll: () => [], createElement: () => mk(`#_${Math.random()}`), body: mk('body') };
  const ctx = { document: doc, console, location: { hash: '#/settings?tab=radio' }, setTimeout, clearTimeout, addEventListener() {}, URLSearchParams };
  ctx.window = ctx;
  ctx.cl = { on() {}, call: async (name) => (name === 'log:stats' ? { total: 0, today: 0, recent: [] } : name === 'rig:ports' || name === 'rig:models' ? [] : null) };
  vm.createContext(ctx);
  for (const f of [['src', 'renderer', 'util.js'], ['src', 'renderer', 'pages', 'settings.js'], ['src', 'renderer', 'pages', 'dashboard.js']]) vm.runInContext(read(...f), ctx, { filename: f.at(-1) });
  const cfg = { ...newRig('a', { label: 'Shack', mode: 'net', enabled: true }), relay: { enabled: rigStatus.relay.enabled, bind: '127.0.0.1', port: rigStatus.relay.port }, xmlrpc: { enabled: !!(rigStatus.xmlrpc || {}).enabled, bind: '127.0.0.1', port: (rigStatus.xmlrpc || {}).port || 12345 } };
  ctx.App.state = { settings: { rigs: [cfg], activeRigId: 'a', cloudlog: { stations: [], url: '', currentStationId: null }, theme: 'cerulean', sync: {}, adifServer: {} }, rig: rigStatus, rigs: [rigStatus], sync: { configured: true, pending: 0, failed: 0 }, adif: { enabled: false }, info: { hamlib: { rigctld: null, forceRts: null } } };
  return { ctx, els, doc };
}
const rigStatus = (relay, xmlrpc) => ({ id: 'a', label: 'Shack', state: 'connected', freqHz: 14074000, mode: 'USB', ptt: false, message: '', forceRtsActive: false, relay: { enabled: true, listening: true, port: 4532, bind: '127.0.0.1', clients: 2, error: '', ...relay }, xmlrpc: { enabled: true, state: 'listening', listening: true, port: 12345, bind: '127.0.0.1', clients: 3, error: '', ...xmlrpc } });
const strip = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
async function renderSettings(rs) {
  const { ctx, els } = mkApp(rs);
  ctx.App.pages.settings.mount({ innerHTML: '', querySelectorAll: () => [] });
  await sleep(20);
  return { html: String(els.get('#rig-status').innerHTML), form: String(els.get('#radio-form').innerHTML) };
}
async function renderDashboard(rs) {
  const { ctx } = mkApp(rs);
  const root = { innerHTML: '', querySelector: () => null };
  ctx.App.pages.dashboard.mount(root);
  await sleep(30);
  return String(root.innerHTML);
}

test('dashboard: exact line "XmlRPC port {port} open, {n} client(s)" directly below the Hamlib line', async () => {
  const h = await renderDashboard(rigStatus({}, { port: 12400, clients: 3 }));
  const t = strip(h);
  assert.ok(t.includes('Hamlib port 4532 open, 2 client(s) XmlRPC port 12400 open, 3 client(s)'), t);
  assert.ok(h.indexOf('Hamlib port') < h.indexOf('XmlRPC port'));
});

test('dashboard: XML-RPC line shows even with Hamlib sharing off; nothing for stopped, failed, starting or disabled', async () => {
  const noHamlib = strip(await renderDashboard(rigStatus({ enabled: false, listening: false }, { port: 12345, clients: 0 })));
  assert.ok(noHamlib.includes('XmlRPC port 12345 open, 0 client(s)'), noHamlib); assert.ok(!noHamlib.includes('Hamlib port'));
  for (const x of [{ state: 'error', listening: false, error: 'EADDRINUSE on 127.0.0.1:12345' }, { state: 'starting', listening: false }, { state: 'stopped', listening: false }, { enabled: false, state: 'stopped', listening: false }]) {
    const t = strip(await renderDashboard(rigStatus({}, x)));
    assert.ok(!t.includes('XmlRPC'), JSON.stringify(x)); assert.ok(t.includes('Hamlib port 4532 open'));
  }
  const old = await renderDashboard({ ...rigStatus({}, {}), xmlrpc: undefined });
  assert.ok(!strip(old).includes('XmlRPC'), 'status from before 0.4.2 renders fine');
});

test('dashboard: the XML-RPC line follows the displayed (active) radio only', async () => {
  const { ctx } = mkApp(rigStatus({}, { port: 12345, clients: 1 }));
  const other = rigStatus({}, { port: 12999, clients: 9 }); other.id = 'b';
  ctx.App.state.rigs = [ctx.App.state.rig, other];
  const root = { innerHTML: '', querySelector: () => null };
  ctx.App.pages.dashboard.mount(root); await sleep(30);
  const t = strip(root.innerHTML);
  assert.ok(t.includes('XmlRPC port 12345 open, 1 client(s)')); assert.ok(!t.includes('12999'));
});

test('settings status pane: XML-RPC status sits directly under "Shared Hamlib port" in the same style', async () => {
  const { html } = await renderSettings(rigStatus({}, { port: 12400, clients: 3 }));
  const t = strip(html);
  assert.ok(t.includes('Shared Hamlib port Listening on 127.0.0.1:4532 · 2 connected Shared XmlRPC port Listening on 127.0.0.1:12400 · 3 connected'), t);
  assert.match(html, /class="fw-bold mb-1">Shared XmlRPC port</);
  assert.match(html, /<span class="text-success">Listening on 127\.0\.0\.1:12400<\/span>/);
});

test('settings status pane: shown without Hamlib sharing; hidden when disabled; error/starting never look healthy', async () => {
  let t = (await renderSettings(rigStatus({ enabled: false, listening: false }, { port: 12345, clients: 0 }))).html;
  assert.ok(strip(t).includes('Shared Hamlib port Not shared Shared XmlRPC port Listening on 127.0.0.1:12345 · 0 connected'), strip(t));
  t = (await renderSettings(rigStatus({}, { enabled: false, state: 'stopped', listening: false }))).html;
  assert.ok(!t.includes('XmlRPC'));
  t = (await renderSettings(rigStatus({}, { state: 'error', listening: false, error: 'EADDRINUSE on 127.0.0.1:12345' }))).html;
  assert.match(t, /<span class="text-danger">EADDRINUSE on 127\.0\.0\.1:12345<\/span>/); assert.ok(!/text-success">Listening on 127\.0\.0\.1:12345/.test(t));
  t = (await renderSettings(rigStatus({}, { state: 'starting', listening: false }))).html;
  assert.ok(strip(t).includes('Shared XmlRPC port Starting…')); assert.ok(!/Listening on 127\.0\.0\.1:12345/.test(t));
  t = (await renderSettings(rigStatus({}, { state: 'stopped', listening: false, error: '' }))).html;
  assert.match(t, /text-danger">Not listening</);
});

test('settings form: enable switch and port control are present and sent separately from the Hamlib block', async () => {
  const { form } = await renderSettings(rigStatus({}, { port: 12400 }));
  assert.match(form, /id="xr-on"[^>]*checked/); assert.match(form, /id="xr-port"[^>]*value="12400"/); assert.match(form, /id="xr-bind"/);
  assert.match(form, /id="rl-on"/); assert.match(form, /id="rl-port"/);
  const src = read('src', 'renderer', 'pages', 'settings.js');
  assert.match(src, /xmlrpc: \{ enabled: \$\('#xr-on'\)\.checked, bind: \$\('#xr-bind'\)\.value, port: num\(\$\('#xr-port'\)\.value, 12345\) \}/);
  assert.match(src, /relay: \{ enabled: \$\('#rl-on'\)\.checked, bind: \$\('#rl-bind'\)\.value, port \}/);
});

test('main.js validates XML-RPC settings before saving and passes the app version to the rig layer', () => {
  const m = read('src', 'main', 'main.js');
  assert.match(m, /validateXmlrpcSharing\(settings\.data\.rigs, deepMerge\(JSON\.parse\(JSON\.stringify\(r\)\), patch\)\)/);
  assert.match(m, /appVersion: app\.getVersion\(\)/);
});

// ---- release plumbing -------------------------------------------------------------------------------------------------
test('release 0.4.2: versions bumped, README documents the feature, this file is part of npm test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.version, '0.4.2');
  assert.ok(pkg.scripts.test.includes('test/release-042.test.js'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.strictEqual(lock.version, '0.4.2'); assert.strictEqual(lock.packages[''].version, '0.4.2');
  const readme = read('README.md');
  assert.match(readme, /^### 0\.4\.2$/m);
  assert.match(readme, /XmlRPC port \{port\} open, \{clients\} client\(s\)/);
  assert.match(readme, /Unsupported flrig methods/);
});
