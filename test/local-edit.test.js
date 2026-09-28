'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { LogService } = require('../src/main/logbook');
const { SETTINGS_DEFAULTS } = require('../src/main/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cld-edit-'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const offlineClient = { configured: () => false };

test('editing a queued QSO updates its fields and re-queues it', () => {
  const log = new LogService({ dir: tmp(), client: offlineClient, getSettings: () => clone(SETTINGS_DEFAULTS) });
  const rec = log.addQso({ call: 'K1ABC', freq: '14.2', mode: 'SSB' });
  const updated = log.updateLocal(rec.id, { call: 'k1xyz', comment: 'fixed a typo' });
  assert.strictEqual(updated.fields.CALL, 'K1XYZ');
  assert.strictEqual(updated.fields.COMMENT, 'fixed a typo');
  assert.strictEqual(updated.state, 'pending');
  assert.strictEqual(log.localList(['pending']).length, 1);
});

test('editing rejects bad data and leaves the original untouched', () => {
  const log = new LogService({ dir: tmp(), client: offlineClient, getSettings: () => clone(SETTINGS_DEFAULTS) });
  const rec = log.addQso({ call: 'K1ABC', freq: '14.2', mode: 'SSB' });
  assert.throws(() => log.updateLocal(rec.id, { call: 'HELLO' }), /callsign/);
  assert.strictEqual(log.localList()[0].fields.CALL, 'K1ABC');
});

test('editing an unknown or already-synced QSO is rejected', () => {
  const log = new LogService({ dir: tmp(), client: offlineClient, getSettings: () => clone(SETTINGS_DEFAULTS) });
  assert.throws(() => log.updateLocal('nope', { call: 'K1ABC' }), /no longer/);
  const rec = log.addQso({ call: 'K1ABC', freq: '14.2', mode: 'SSB' });
  log.cache.setState(rec.id, { state: 'synced', error: '', syncedAt: Date.now(), updatedAt: Date.now() });
  assert.throws(() => log.updateLocal(rec.id, { call: 'K1XYZ' }), /already uploaded/i);
});

test('sync.instant = false queues QSOs without uploading until asked', async () => {
  const settings = clone(SETTINGS_DEFAULTS);
  settings.sync.instant = false;
  settings.cloudlog = { url: 'http://127.0.0.1:1', apiKey: 'x', urlStyle: 'auto', currentStationId: '1', stations: [] };
  let syncCalls = 0;
  const log = new LogService({ dir: tmp(), client: { configured: () => true }, getSettings: () => settings });
  const realSync = log.sync.bind(log);
  log.sync = (...a) => { syncCalls++; return realSync(...a); };
  log.addQso({ call: 'K1ABC', freq: '14.2', mode: 'SSB' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(syncCalls, 0);
});

test('periodic auto-retry does not fire immediately for the first pending QSO after startup', async () => {
  const mock = require('./mock-cloudlog');
  const m = await mock.start(0);
  const settings = clone(SETTINGS_DEFAULTS);
  settings.sync.instant = false;
  settings.sync.intervalSec = 5;
  settings.cloudlog = { url: `http://127.0.0.1:${m.port}`, apiKey: 'abc123', urlStyle: 'auto', currentStationId: '1', stations: [] };
  const { CloudlogClient } = require('../src/main/cloudlog');
  const client = new CloudlogClient(() => settings.cloudlog);
  const log = new LogService({ dir: tmp(), client, getSettings: () => settings });
  log.addQso({ call: 'K1ABC', freq: '14.2', mode: 'SSB' });
  await log._tick(); // right after startup - must NOT treat "never synced" as "interval elapsed"
  assert.strictEqual(log.localList(['pending']).length, 1, 'should still be queued, not uploaded yet');
  // simulate the interval having actually elapsed
  log._lastTick = Date.now() - 6000;
  await log._tick();
  assert.strictEqual(log.localList(['pending']).length, 0, 'should have uploaded once the interval elapsed');
  await m.close();
});
