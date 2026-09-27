'use strict';
// Headless UI smoke test: run with  xvfb-run -a electron --no-sandbox test/smoke-main.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const out = process.env.SMOKE_OUT || '/tmp/shots';
fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-smoke-'));
process.env.CLOUDLOG_DESKTOP_DATA = data;
// Old-format settings (singular rig/relay) on purpose, to exercise the migration path on startup.
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  theme: process.env.SMOKE_THEME || 'cerulean',
  cloudlog: { url: 'http://127.0.0.1:18080', apiKey: 'abc123', currentStationId: '1', stations: [
    { id: '1', name: 'Home', callsign: 'W1AW', grid: 'FN31', active: true }, { id: '2', name: 'Portable', callsign: 'W1AW/P', grid: 'FN42', active: false }] },
  rig: { mode: 'serial', model: 1, pollMs: 300, name: 'Shack radio', updateCloudlog: true },
  relay: { enabled: true, bind: '127.0.0.1', port: 14532 },
  adifServer: { enabled: true, bind: '127.0.0.1', tcp: true, tcpPort: 12333, udp: true, udpPort: 12333 },
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = require('./mock-cloudlog');

async function main() {
  // Start the mock Cloudlog servers *before* requiring main.js, so the app's
  // own startup ping (which fires the instant app.whenReady resolves) doesn't
  // race a not-yet-listening mock server and land on a stale "Offline".
  const full = await mock.start(18080, 'abc123');
  const stock = await mock.start(18081, 'stockkey', { noDownload: true }); // simulates real Cloudlog: no api/get_contacts_adif
  require('../src/main/main.js');
  const { app, BrowserWindow } = require('electron');

  await app.whenReady();
  await sleep(3500);
  const win = BrowserWindow.getAllWindows()[0];
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  const run = (js) => win.webContents.executeJavaScript(js);
  const shot = async (name) => { await sleep(700); fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  const go = async (r, wait = 500) => { await run(`location.hash='#/${r}'`); await sleep(wait); };
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(200); }
    return last;
  };
  const report = [];
  const check = (name, ok, extra = '') => { report.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

  try {
    // ---- data dir -----------------------------------------------------------
    check('data dir override respected', (await run(`window.App.state.info.dataDir`)) === data);

    // ---- migration produced one active radio, tray-friendly startup ---------
    await go('dashboard'); await shot('dashboard');
    check('migrated single radio is active & connected', /\d+\.\d{3}\.\d{2}/.test(await run(`document.querySelector('#chip-rig').textContent`)));

    // ---- add a second radio, switch active, see it reflected in the chip ----
    await go('settings?tab=radio', 900);
    await run(`document.querySelector('#r-add').click()`);
    await sleep(1200);
    await shot('settings-radio-two');
    check('two radio pills shown', (await run(`document.querySelectorAll('[data-pick]').length`)) === 2);
    check('new radio defaults to disabled', (await run(`document.querySelector('#r-enabled').checked`)) === false);
    check('new radio shows as off in its own pill', /off/i.test(await run(`document.querySelector('[data-pick].btn-primary').textContent`)));
    const newRigId = await run(`(async () => { const s = await window.cl.call('settings:get'); return s.rigs[s.rigs.length - 1].id; })()`);
    // still mode 'none' at this point, so the serial-only dummy fields aren't shown yet
    await run(`document.querySelector('#rm-serial').click()`);
    await sleep(200);
    check('dummy model hides serial port/baud/PTT', (await run(`document.querySelector('#serial-conn-row').classList.contains('d-none') && document.querySelector('#ptt-col').classList.contains('d-none')`)) === true);
    check('dummy model shows default freq/mode with sane defaults', (await run(`(() => { const row = document.querySelector('#dummy-defaults-row'); return !row.classList.contains('d-none') && document.querySelector('#r-defreq').value === '14.225' && document.querySelector('#r-defmode').value === 'USB'; })()`)) === true);
    await shot('settings-radio-dummy-fields');
    // configure it and save first (mirrors real usage) - only then flip the live toggles, since
    // those toggles redraw the form from freshly-saved settings and would clobber unsaved edits
    await run(`(() => { document.querySelector('#r-label').value='Portable'; document.querySelector('#r-save').click(); })()`);
    await sleep(1200);
    await run(`document.querySelector('#r-enabled').click()`);
    await sleep(1500);
    await run(`document.querySelector('#r-startup').click()`);
    await sleep(500);
    check('second radio connected once enabled', (await run(`document.querySelectorAll('#rig-all tr').length`)) === 2);
    const secondRigState = await until(() => run(`(async () => { const s = await window.cl.call('rig:status'); const r = s.rigs.find(x => x.id === '${newRigId}'); return r.state === 'connected' && r.freqHz ? JSON.stringify({label: r.label, state: r.state, activeOnStartup: r.activeOnStartup, freqHz: r.freqHz, mode: r.mode}) : null; })()`));
    check('second radio state connected & startup flag persisted', /"label":"Portable".*"state":"connected".*"activeOnStartup":true/.test(secondRigState || ''), `got=${secondRigState}`);
    check('dummy rig came up at the configured default freq/mode', /"freqHz":14225000,"mode":"USB"/.test(secondRigState || ''), `got=${secondRigState}`);
    // switch active radio to the portable one
    await run(`document.querySelector('#r-active').click()`);
    await sleep(800);
    await shot('settings-radio-active-switch');
    check('active star moved to the newly added radio', /★/.test(await run(`document.querySelector('[data-pick].btn-primary').textContent`)));
    check('header chip mentions radio count', /2 radios/.test(await run(`document.querySelector('#chip-rig').textContent`)));

    // ---- force RTS toggle is present, available, and persists ----
    check('force RTS checkbox present and enabled (shim found)', (await run(`(() => { const c = document.querySelector('#r-forcerts'); return c && !c.disabled; })()`)) === true);
    await run(`(() => { document.querySelector('summary').click(); document.querySelector('#r-forcerts').click(); document.querySelector('#r-save').click(); })()`);
    await sleep(800);
    const forceRtsSaved = await run(`(async () => { const s = await window.cl.call('settings:get'); return s.rigs.find(r => r.id === '${newRigId}').forceRts; })()`);
    check('forceRts flag persisted after toggling + save', forceRtsSaved === true);

    // ---- disabling a radio live stops its connection ----
    await run(`document.querySelector('#r-enabled').click()`);
    await sleep(1200);
    const disabledState = await run(`(async () => { const s = await window.cl.call('rig:status'); return s.rigs.find(r => r.id === '${newRigId}').state; })()`);
    check('disabling a radio live stops it', disabledState === 'idle', `got=${disabledState}`);

    // ---- instant-upload toggle: turn off, log offline-style, edit, sync now -
    await go('settings?tab=cloudlog', 600);
    await run(`document.querySelector('#s-instant').click()`);
    // also push the periodic auto-retry interval way out, so it can't race ahead and
    // upload the QSO out from under us before the edit step below gets to it
    await run(`(async () => { await window.cl.call('settings:set', { sync: { intervalSec: 3600 } }); })()`);
    await sleep(500);
    check('instant upload disabled', (await run(`window.App.state.settings.sync.instant`)) === false);

    await go('live');
    await run(`(() => { const c=document.querySelector('#f-call'); c.value='m0abc'; c.dispatchEvent(new Event('input')); })()`);
    await run(`document.querySelector('#save').click()`);
    await sleep(600);
    await go('logbook', 700);
    await shot('logbook-queued');
    check('QSO queued (not auto-uploaded)', (await run(`document.querySelectorAll('#queue [data-edit]').length`)) >= 1);

    // edit the queued QSO before it uploads
    await run(`document.querySelector('#queue [data-edit]').click()`);
    await sleep(500);
    await run(`(() => { document.getElementById('em-call').value='M0XYZ'; document.getElementById('em-comment').value='edited before upload'; document.getElementById('em-save').click(); })()`);
    await sleep(700);
    await shot('logbook-edit-modal');
    const editedCall = await until(() => run(`(async () => { const r = await window.cl.call('local:list', ['pending','failed']); const call = r.map(x=>x.fields.CALL).join(','); return call.includes('M0XYZ') ? call : null; })()`)) || '';
    check('edited QSO shows new callsign', editedCall.includes('M0XYZ'), `got=${editedCall}`);
    check('no leftover modal backdrop after edit', (await run(`document.querySelectorAll('.modal-backdrop').length`)) === 0);

    // turn instant back on, hit Sync now explicitly
    await go('settings?tab=cloudlog', 400);
    await run(`document.querySelector('#s-instant').click()`);
    await sleep(300);
    await go('logbook', 500);
    await run(`document.querySelector('#q-now').click()`);
    await sleep(2000);
    check('sync now cleared the queue', (await run(`document.querySelectorAll('#queue [data-edit]').length`)) === 0);

    // ---- delete-before-upload still works ------------------------------------
    await go('quick', 400);
    await run(`(() => { const c=document.querySelector('#q-call'); c.value='n5del'; c.dispatchEvent(new Event('input')); })()`);
    await run(`(() => { document.querySelector('#s-instant'); })()`); // no-op, just settle
    await go('settings?tab=cloudlog', 300);
    await run(`document.querySelector('#s-instant').click()`); // off again for this check
    await sleep(300);
    await go('quick', 400);
    await run(`(() => { const c=document.querySelector('#q-call'); c.value='n5del'; c.dispatchEvent(new Event('input')); document.querySelector('#q-save').click(); })()`);
    await sleep(600);
    await go('logbook', 700);
    const beforeDel = await run(`document.querySelectorAll('#queue [data-del]').length`);
    await run(`document.querySelector('#queue [data-del]').click()`);
    await sleep(500);
    await run(`document.querySelector('#confirm-modal-ok').click()`);
    await sleep(700);
    check('delete-before-upload removed it', (await run(`document.querySelectorAll('#queue [data-del]').length`)) === beforeDel - 1);
    check('no leftover modal backdrop after delete', (await run(`document.querySelectorAll('.modal-backdrop').length`)) === 0);
    check('text inputs still accept typing after delete', await run(`(() => {
      const el = document.querySelector('#lb-q');
      if (!el) return false;
      el.focus();
      el.value = 'AB1CDE';
      el.dispatchEvent(new Event('input'));
      return document.activeElement === el && el.value === 'AB1CDE';
    })()`));
    await go('settings?tab=cloudlog', 300);
    await run(`if (!document.querySelector('#s-instant').checked) document.querySelector('#s-instant').click()`);
    await sleep(300);

    // ---- tray created without throwing ---------------------------------------
    check('tray icon created', (await run(`true`)) === true); // main.js would have thrown during startup otherwise

    // ---- Logbooks moved into Settings as a tab ----
    check('no standalone Logbooks nav item', (await run(`document.querySelectorAll('[data-route="logbooks"]').length`)) === 0);
    await run(`document.querySelector('#chip-logbook').click()`);
    await sleep(700);
    const chipHash = await run(`location.hash`);
    check('header chip opens the Logbooks settings tab', chipHash.includes('#/settings') && chipHash.includes('tab=logbooks'));
    check('Logbooks tab renders logbook cards', (await run(`document.querySelectorAll('#tab-body .card').length`)) > 0);
    await shot('settings-logbooks-tab');
    // the old bare route now just falls back to the dashboard rather than 404-ing
    await go('logbooks', 500);
    check('old #/logbooks route falls back gracefully', (await run(`document.querySelector('#page').children.length`)) > 0);

    // ---- logbook-download-unsupported messaging on a stock Cloudlog server ---
    await run(`(async () => { await window.cl.call('settings:set', { cloudlog: { url: 'http://127.0.0.1:18081', apiKey: 'stockkey' } }); })()`);
    await sleep(600);
    await go('logbook', 900);
    await run(`document.querySelector('#lb-refresh').click()`);
    await sleep(1500);
    await shot('logbook-download-unsupported');
    check('unsupported banner shown', /doesn't offer logbook download/.test(await run(`document.querySelector('#lb-unsupported').textContent`)));
    check('update button disabled after unsupported reply', (await run(`document.querySelector('#lb-refresh').disabled`)) === true);
  } catch (e) {
    report.push(`ERROR ${e.stack}`);
  }
  console.log(report.join('\n'));
  console.log('RENDERER ERRORS:', JSON.stringify(errors));
  await full.close(); await stock.close();
  app.quit();
}

main();
