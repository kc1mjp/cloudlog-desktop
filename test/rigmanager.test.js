'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { RigManager } = require('../src/main/rig');
const { SETTINGS_DEFAULTS, newRig, migrateRigs } = require('../src/main/store');

const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('timed out');
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('RigManager runs two independent dummy radios at once', async () => {
  const settings = clone(SETTINGS_DEFAULTS);
  const r1 = newRig('a', { label: 'Shack', mode: 'serial', model: 1, pollMs: 100, enabled: true });
  const r2 = newRig('b', { label: 'Portable', mode: 'serial', model: 1, pollMs: 100, enabled: true });
  settings.rigs = [r1, r2];
  settings.activeRigId = 'a';
  const mgr = new RigManager({ getSettings: () => settings });
  const events = [];
  mgr.on('status', (id) => events.push(id));
  await mgr.reconcile();
  await until(() => mgr.statusOne('a').state === 'connected' && mgr.statusOne('b').state === 'connected');
  await mgr.services.get('a').setFrequency(14074000);
  await mgr.services.get('b').setFrequency(7100000);
  await until(() => mgr.statusOne('a').freqHz === 14074000 && mgr.statusOne('b').freqHz === 7100000);
  // they are independent instances, not sharing state
  assert.notStrictEqual(mgr.statusOne('a').freqHz, mgr.statusOne('b').freqHz);
  assert.ok(events.includes('a') && events.includes('b'));

  // removing one stops only that one (caller drops it from settings first, same as main.js does)
  settings.rigs = settings.rigs.filter((r) => r.id !== 'a');
  await mgr.removeOne('a');
  assert.strictEqual(mgr.services.has('a'), false);
  assert.strictEqual(mgr.statusOne('a'), null);
  await sleep(200);
  assert.strictEqual(mgr.statusOne('b').state, 'connected');
  await mgr.stopAll();
});

test('migrateRigs folds an old single rig/relay config into rigs[0], preserving always-on behavior', () => {
  const data = clone(SETTINGS_DEFAULTS);
  delete data.rigs; delete data.activeRigId;
  data.rig = { mode: 'net', host: '127.0.0.1', port: 4532, name: 'Old Radio', updateCloudlog: true };
  data.relay = { enabled: true, bind: '127.0.0.1', port: 4533 };
  migrateRigs(data);
  assert.strictEqual(data.rigs.length, 1);
  assert.strictEqual(data.rigs[0].mode, 'net');
  assert.strictEqual(data.rigs[0].relay.port, 4533);
  assert.strictEqual(data.activeRigId, data.rigs[0].id);
  // a configured radio used to just always run - keep that behavior across the upgrade
  assert.strictEqual(data.rigs[0].enabled, true);
  assert.strictEqual(data.rigs[0].activeOnStartup, true);
  assert.strictEqual(data.rig, undefined);
  assert.strictEqual(data.relay, undefined);

  // running it twice (e.g. two app starts without ever setting rigs) is a no-op
  const again = clone(data);
  migrateRigs(again);
  assert.deepStrictEqual(again.rigs, data.rigs);
});

test('migrateRigs on a plain fresh install just normalizes activeRigId', () => {
  const data = clone(SETTINGS_DEFAULTS);
  migrateRigs(data);
  assert.deepStrictEqual(data.rigs, []);
  assert.strictEqual(data.activeRigId, null);
});

test('newRig defaults to disabled and off-at-startup', () => {
  const r = newRig('x');
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.activeOnStartup, false);
  assert.strictEqual(r.forceRts, false);
});

test('RigManager only runs a service when enabled and mode is set', async () => {
  const settings = clone(SETTINGS_DEFAULTS);
  settings.rigs = [
    newRig('off-by-default', { mode: 'serial', model: 1, pollMs: 100, enabled: false }),
    newRig('configured-off', { mode: 'none', pollMs: 100, enabled: true }),
    newRig('on', { mode: 'serial', model: 1, pollMs: 100, enabled: true }),
  ];
  const mgr = new RigManager({ getSettings: () => settings });
  await mgr.reconcile();
  assert.strictEqual(mgr.services.has('off-by-default'), false);
  assert.strictEqual(mgr.services.has('configured-off'), false);
  assert.strictEqual(mgr.services.has('on'), true);
  await until(() => mgr.statusOne('on').state === 'connected');
  assert.match(mgr.statusOne('off-by-default').message, /Turned off/);
  assert.match(mgr.statusOne('configured-off').message, /No connection method/);

  // flipping enabled on/off via applyOne starts/stops the service without touching the others
  settings.rigs.find((r) => r.id === 'off-by-default').enabled = true;
  await mgr.applyOne('off-by-default');
  await until(() => mgr.statusOne('off-by-default').state === 'connected');
  assert.strictEqual(mgr.statusOne('on').state, 'connected');

  settings.rigs.find((r) => r.id === 'on').enabled = false;
  await mgr.applyOne('on');
  await sleep(200);
  assert.strictEqual(mgr.services.has('on'), false);
  assert.match(mgr.statusOne('on').message, /Turned off/);

  await mgr.stopAll();
});

test('startup resets each radio\'s enabled flag to its activeOnStartup setting', () => {
  // This mirrors the one line main.js runs on every launch, right after migrateRigs.
  const settings = clone(SETTINGS_DEFAULTS);
  settings.rigs = [
    newRig('was-on-not-startup', { enabled: true, activeOnStartup: false }),
    newRig('was-off-startup-on', { enabled: false, activeOnStartup: true }),
    newRig('was-on-startup-on', { enabled: true, activeOnStartup: true }),
    newRig('was-off-not-startup', { enabled: false, activeOnStartup: false }),
  ];
  for (const r of settings.rigs) r.enabled = !!r.activeOnStartup;
  const byId = Object.fromEntries(settings.rigs.map((r) => [r.id, r.enabled]));
  assert.deepStrictEqual(byId, {
    'was-on-not-startup': false,
    'was-off-startup-on': true,
    'was-on-startup-on': true,
    'was-off-not-startup': false,
  });
});
