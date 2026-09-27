'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { parseAdif, generateAdif } = require('../src/main/adif');
const { freqToBand, hamlibToAdif } = require('../src/main/bands');
const { CloudlogClient } = require('../src/main/cloudlog');
const { LogService } = require('../src/main/logbook');
const { SETTINGS_DEFAULTS } = require('../src/main/store');
const mock = require('./mock-cloudlog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cld-'));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('ADIF round trip incl. UTF-8 byte lengths', () => {
  const out = generateAdif({ CALL: 'K1ABC', NAME: 'José', BAND: '20m' });
  assert.match(out, /<NAME:5>José/);
  const { records } = parseAdif(Buffer.from(out, 'utf8').toString('latin1'));
  assert.deepStrictEqual(records[0], { CALL: 'K1ABC', NAME: 'José', BAND: '20m' });
});

test('ADIF header, multiple records, type indicators, case', () => {
  const t = 'hello\n<ADIF_VER:5>3.1.4<EOH>\n<call:5>N9EAT<freq:6:N>14.074<eor>\n<CALL:4>W1AW<Mode:3>SSB<EOR>';
  const { header, records } = parseAdif(t);
  assert.ok(header.includes('hello'));
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].FREQ, '14.074');
  assert.strictEqual(records[1].MODE, 'SSB');
});

test('band and mode helpers', () => {
  assert.strictEqual(freqToBand(14.074), '20m');
  assert.strictEqual(freqToBand(144.174), '2m');
  assert.strictEqual(freqToBand(9.9), '');
  assert.deepStrictEqual(hamlibToAdif('LSB'), { mode: 'SSB', submode: 'LSB' });
});

test('offline logging queues, then uploads when the server appears', async () => {
  const m = await mock.start(0);
  const settings = clone(SETTINGS_DEFAULTS);
  settings.cloudlog = { url: `http://127.0.0.1:${m.port}`, apiKey: 'abc123', urlStyle: 'auto', currentStationId: '1', stations: [] };
  const client = new CloudlogClient(() => settings.cloudlog);
  const log = new LogService({ dir: tmp(), client, getSettings: () => settings });

  // server down
  await m.close();
  const rec = log.addQso({ call: 'k1abc', freq: '14.074', mode: 'ft8', rst_sent: '-10' });
  assert.strictEqual(rec.fields.BAND, '20m');
  await log.sync();
  assert.strictEqual(log.status().pending, 1);
  assert.strictEqual(log.status().online, false);

  // server back on the same port
  const m2 = await mock.start(m.port);
  const st = await log.sync();
  assert.strictEqual(st.pending, 0);
  assert.strictEqual(st.online, true);
  assert.strictEqual(m2.state.qsos.length, 1);
  assert.strictEqual(m2.state.qsos[0].station, '1');
  assert.strictEqual(m2.state.qsos[0].f.CALL, 'K1ABC');

  // duplicate on server counts as synced, not failed
  log.local.data.qsos[0].state = 'pending';
  await log.sync();
  assert.strictEqual(log.local.data.qsos[0].state, 'synced');
  assert.strictEqual(log.local.data.qsos[0].error, 'Already on server');

  // bad key: stays pending, reports the problem
  settings.cloudlog.apiKey = 'wrong';
  log.addQso({ call: 'W1AW', freq: '7.2', mode: 'SSB' });
  const st2 = await log.sync();
  assert.strictEqual(st2.pending, 1);
  assert.match(st2.lastError, /API key/);
  await m2.close();
});

test('logbook download, query, worked-before', async () => {
  const m = await mock.start(0);
  m.state.qsos.push({ id: 1, station: '1', f: { CALL: 'DL1XYZ', QSO_DATE: '20260101', TIME_ON: '101500', BAND: '40m', MODE: 'CW' } });
  m.state.qsos.push({ id: 2, station: '1', f: { CALL: 'JA1AAA', QSO_DATE: '20260102', TIME_ON: '111500', BAND: '20m', MODE: 'SSB' } });
  m.state.nextId = 3;
  const settings = clone(SETTINGS_DEFAULTS);
  settings.cloudlog = { url: `http://127.0.0.1:${m.port}/`, apiKey: 'abc123', urlStyle: 'auto', currentStationId: '1', stations: [] };
  const client = new CloudlogClient(() => settings.cloudlog);
  const log = new LogService({ dir: tmp(), client, getSettings: () => settings });
  const r = await log.refreshRemote('1');
  assert.strictEqual(r.added, 2);
  const q = log.query({ stationId: '1' });
  assert.strictEqual(q.total, 2);
  assert.strictEqual(q.rows[0].CALL, 'JA1AAA'); // newest first
  assert.strictEqual(log.query({ stationId: '1', q: 'dl1' }).total, 1);
  assert.strictEqual(log.query({ stationId: '1', band: '20m' }).total, 1);
  assert.strictEqual(log.workedBefore('DL1XYZ', '1').count, 1);
  assert.strictEqual(log.workedBefore('N0NEW', '1').count, 0);
  // delta: nothing new
  assert.strictEqual((await log.refreshRemote('1')).added, 0);
  // a pending local QSO shows up in the view straight away
  log.addQso({ call: 'K2ZZZ', freq: '21.3', mode: 'SSB' });
  assert.strictEqual(log.query({ stationId: '1' }).total, 3);
  await m.close();
});

test('client auth and station list, URL style auto-detect', async () => {
  const m = await mock.start(0);
  for (const url of [`http://127.0.0.1:${m.port}`, `http://127.0.0.1:${m.port}/index.php`]) {
    const c = new CloudlogClient(() => ({ url, apiKey: 'abc123', urlStyle: 'auto' }));
    const a = await c.auth();
    assert.ok(a.valid);
    assert.strictEqual(a.rights, 'rw');
    const st = await c.stationInfo();
    assert.strictEqual(st.length, 2);
    assert.strictEqual(st[0].callsign, 'W1AW');
  }
  const bad = new CloudlogClient(() => ({ url: `http://127.0.0.1:${m.port}`, apiKey: 'nope', urlStyle: 'auto' }));
  assert.strictEqual((await bad.auth()).valid, false);
  await m.close();
});

test('normalize rejects junk', () => {
  const log = new LogService({ dir: tmp(), client: { configured: () => false }, getSettings: () => clone(SETTINGS_DEFAULTS) });
  assert.throws(() => log.normalize({ call: 'HELLO', freq: '14.2', mode: 'SSB' }), /callsign/);
  assert.throws(() => log.normalize({ call: 'K1ABC', mode: 'SSB' }), /Band/);
  assert.throws(() => log.normalize({ call: 'K1ABC', freq: '14.2' }), /Mode/);
});
