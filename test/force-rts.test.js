'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RigService, findForceRts } = require('../src/main/rig');
const { SETTINGS_DEFAULTS } = require('../src/main/store');

const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('timed out');
}

test('findForceRts locates the bundled shim next to the app assets', () => {
  const p = findForceRts(null);
  assert.ok(p, 'expected to find src/assets/force_rts.so');
  assert.ok(fs.existsSync(p));
  assert.ok(p.endsWith('force_rts.so'));
});

test('serial mode with forceRts sets FORCE_RTS_DEVICES and LD_PRELOAD on the rigctld process', async () => {
  // Stand in for rigctld: just report the env vars it was launched with, then exit.
  const stub = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frts-')), 'fake-rigctld.sh');
  fs.writeFileSync(stub, '#!/bin/sh\necho "ENV_CHECK FORCE_RTS_DEVICES=$FORCE_RTS_DEVICES LD_PRELOAD=$LD_PRELOAD" 1>&2\nexit 7\n');
  fs.chmodSync(stub, 0o755);

  const settings = clone(SETTINGS_DEFAULTS);
  settings.rig = { mode: 'serial', model: 1, device: '/dev/ttyUSBtest0', pollMs: 100, rigctldPath: stub, forceRts: true };
  settings.relay = { enabled: false, bind: '127.0.0.1', port: 4532 };
  const rig = new RigService({ getSettings: () => settings });
  await rig.apply();
  await until(() => /ENV_CHECK/.test(rig.status().message));
  assert.match(rig.status().message, /FORCE_RTS_DEVICES=\/dev\/ttyUSBtest0/);
  assert.match(rig.status().message, new RegExp(`LD_PRELOAD=.*force_rts\\.so`));
  await rig.stop();
});

test('forceRts is a no-op without a device, and forceRtsActive reflects whether it actually applied', async () => {
  const stub = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frts-')), 'fake-rigctld.sh');
  fs.writeFileSync(stub, '#!/bin/sh\necho "ENV_CHECK FORCE_RTS_DEVICES=[$FORCE_RTS_DEVICES] LD_PRELOAD=[$LD_PRELOAD]" 1>&2\nexit 7\n');
  fs.chmodSync(stub, 0o755);

  const settings = clone(SETTINGS_DEFAULTS);
  // model 1 (dummy) needs no device, so forceRts (which requires one) should not engage
  settings.rig = { mode: 'serial', model: 1, device: '', pollMs: 100, rigctldPath: stub, forceRts: true };
  settings.relay = { enabled: false, bind: '127.0.0.1', port: 4532 };
  const rig = new RigService({ getSettings: () => settings });
  await rig.apply();
  await until(() => /ENV_CHECK/.test(rig.status().message));
  assert.match(rig.status().message, /FORCE_RTS_DEVICES=\[\]/);
  assert.match(rig.status().message, /LD_PRELOAD=\[\]/);
  assert.strictEqual(rig.status().forceRtsActive, false);
  await rig.stop();
});

test('forceRts flag off never touches the environment', async () => {
  const stub = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frts-')), 'fake-rigctld.sh');
  fs.writeFileSync(stub, '#!/bin/sh\necho "ENV_CHECK FORCE_RTS_DEVICES=[$FORCE_RTS_DEVICES] LD_PRELOAD=[$LD_PRELOAD]" 1>&2\nexit 7\n');
  fs.chmodSync(stub, 0o755);

  const settings = clone(SETTINGS_DEFAULTS);
  settings.rig = { mode: 'serial', model: 1, device: '/dev/ttyUSBtest0', pollMs: 100, rigctldPath: stub, forceRts: false };
  settings.relay = { enabled: false, bind: '127.0.0.1', port: 4532 };
  const rig = new RigService({ getSettings: () => settings });
  await rig.apply();
  await until(() => /ENV_CHECK/.test(rig.status().message));
  assert.match(rig.status().message, /FORCE_RTS_DEVICES=\[\]/);
  assert.strictEqual(rig.status().forceRtsActive, false);
  await rig.stop();
});
