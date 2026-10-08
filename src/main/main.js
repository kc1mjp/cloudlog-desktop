'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Tray, nativeImage, safeStorage } = require('electron');

const { JsonStore, deepMerge, SETTINGS_DEFAULTS, newRig, migrateRigs } = require('./store');
const { CloudlogClient, CloudlogError } = require('./cloudlog');
const { LogService } = require('./logbook');
const { RigManager } = require('./rig');
const { validateXmlrpcSharing } = require('./flrigxml');
const { AdifServer } = require('./adifserver');
const { discoverInterfaces } = require('./multicast');
const { CONTESTS, contestById, dupeMatcher } = require('./contests');
const { BAND_NAMES, MODES } = require('./bands');
const { CallbookService } = require('./callbook');
const callbookConfig = require('./callbook/config');
const { createSecretBox } = require('./secrets');
const { profileUrl } = require('../renderer/callbook-shared');
const { createExternalLinks } = require('./external-links');

// A fixed, predictable data directory regardless of how Electron would
// otherwise derive one from the app/product name.
if (process.env.CLOUDLOG_DESKTOP_DATA) app.setPath('userData', process.env.CLOUDLOG_DESKTOP_DATA);
else app.setPath('userData', path.join(os.homedir(), '.config', 'cloudlog-desktop'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

let win = null; let tray = null;
let settings; let client; let log; let rigs; let adif;
let quitting = false;

const send = (type, data) => {
  if (win && !win.isDestroyed()) win.webContents.send('event', { type, data });
};

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 980, minHeight: 640,
    title: 'Cloudlog Desktop', autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    icon: ICON_PATH,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Closing the window keeps the app (and CAT/ADIF listeners) running in the tray.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

function createTray() {
  const img = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(img.isEmpty() ? img : img.resize({ width: 24, height: 24 }));
  tray.setToolTip('Cloudlog Desktop');
  const rebuildMenu = () => {
    const st = log ? log.status() : {};
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Cloudlog Desktop', click: showWindow },
      { type: 'separator' },
      { label: st.pending ? `${st.pending} QSO(s) waiting to upload` : 'All QSOs uploaded', enabled: false },
      { label: 'Sync now', enabled: !!(client && client.configured()), click: () => log && log.sync() },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  tray.on('click', showWindow);
  rebuildMenu();
  return rebuildMenu;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---- Cloudlog radio status ---------------------------------------------------
const lastRadio = new Map(); // rig id -> { sig, at }

async function postRadioFor(id) {
  const cfg = settings.data.rigs.find((r) => r.id === id);
  const st = rigs.statusOne(id);
  if (!cfg || !st || !cfg.updateCloudlog || !client.configured() || settings.data.sync.paused || st.state !== 'connected' || !st.freqHz) return;
  const sig = `${st.freqHz}|${st.mode}`;
  const prev = lastRadio.get(id);
  if (prev && prev.sig === sig && Date.now() - prev.at < 55000) return;
  lastRadio.set(id, { sig, at: Date.now() });
  try {
    await client.postRadio({ radio: cfg.label || st.rigName, frequencyHz: st.freqHz, mode: st.mode || 'SSB' });
  } catch { /* radio updates are best effort */ }
}

const radioTimers = new Map();
function scheduleRadioPost(id) {
  clearTimeout(radioTimers.get(id));
  radioTimers.set(id, setTimeout(() => postRadioFor(id), 700));
}

// ---- IPC API --------------------------------------------------------------------
const currentStation = () => settings.data.cloudlog.currentStationId;
const genRigId = () => `rig-${crypto.randomUUID().slice(0, 8)}`;

async function saveRigsAndApply(applyIds) {
  settings.saveNow();
  await rigs.reconcile();
  for (const id of applyIds || []) await rigs.applyOne(id);
  send('rig', rigStatusPayload());
  send('settings', publicSettings());
}

function rigStatusPayload() {
  return { activeId: settings.data.activeRigId, rigs: rigs.statusAll() };
}

// ---- Callbook lookup ---------------------------------------------------------------
// Provider requests run here in the main process so credentials and provider replies never reach the
// renderer (which has a strict CSP); it only receives the normalised name / QTH / grid result.
const secretBox = createSecretBox({ safeStorage });
const callbookLookup = CallbookService.create({
  getConfig: () => callbookConfig.resolveConfig(settings.data.callbook, secretBox),
  isOffline: () => !!settings.data.sync.paused, // the "Work offline" switch
  fetchImpl: (...a) => fetch(...a),
});

/** settings.data as the renderer may see it: callbook passwords are replaced by a has-password flag. */
function publicSettings() {
  return { ...settings.data, callbook: callbookConfig.publicConfig(settings.data.callbook) };
}

const externalLinks = createExternalLinks({ getCloudlogUrl: () => settings.data.cloudlog.url, openExternal: (url) => shell.openExternal(url) });

const api = {
  'app:info': () => ({ version: app.getVersion(), dataDir: app.getPath('userData'), bands: BAND_NAMES, modes: MODES, contests: CONTESTS, hamlib: rigs.info() }),

  // Settings > About: running version, rigctld path / Hamlib version in use, and the actual data folder.
  'app:about': async () => ({ version: app.getVersion(), dataDir: app.getPath('userData'), ...(await rigs.aboutInfo()) }),

  'settings:get': () => publicSettings(),
  'settings:set': async (patch) => {
    const before = JSON.parse(JSON.stringify(settings.data));
    // Callbook credentials only change through callbook:save, so a generic patch can never touch them.
    const { callbook: _callbook, ...safePatch } = patch || {};
    deepMerge(settings.data, safePatch);
    settings.saveNow();
    const now = settings.data;
    if (JSON.stringify(before.adifServer) !== JSON.stringify(now.adifServer)) await adif.apply();
    if (before.cloudlog.url !== now.cloudlog.url || before.cloudlog.apiKey !== now.cloudlog.apiKey || before.cloudlog.urlStyle !== now.cloudlog.urlStyle) {
      client.detected = null;
      log.online = null;
      lastRadio.clear();
      log.ping();
    }
    send('sync', log.status());
    return publicSettings();
  },

  'callbook:save': (patch) => {
    callbookConfig.applyPatch(settings.data.callbook, patch, secretBox);
    settings.saveNow();
    callbookLookup.invalidate(); // new provider or credentials apply immediately, no restart
    const pub = publicSettings();
    send('settings', pub);
    return { settings: pub, problems: callbookConfig.validate(settings.data.callbook, secretBox) };
  },
  'callbook:lookup': (call) => callbookLookup.lookup(typeof call === 'string' ? call.slice(0, 32) : ''),
  'callbook:test': () => callbookLookup.test(),
  // Profile pages are opened from a URL built here from a fixed provider table, never from renderer-supplied URLs.
  'external:profile': (provider, call) => {
    const url = profileUrl(provider, call);
    if (!url) throw new Error('Enter a valid callsign first');
    shell.openExternal(url);
    return true;
  },

  // The cloud icon and the About links: the renderer sends no URL, so only the saved Cloudlog address (http/https only)
  // or a fixed About link can ever reach the browser.
  'external:cloudlog': () => externalLinks.openCloudlog(),
  'external:about': (key) => externalLinks.openAbout(key),

  'cloudlog:test': async () => {
    if (!client.configured()) return { ok: false, message: 'Enter the Cloudlog address and API key first' };
    try {
      const a = await client.auth();
      if (!a.valid) return { ok: false, message: a.message };
      const stations = await client.stationInfo();
      return { ok: true, rights: a.rights, stations: stations.length };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  },

  'stations:refresh': async () => {
    const stations = await client.stationInfo();
    settings.data.cloudlog.stations = stations;
    const cur = currentStation();
    if (!stations.some((s) => s.id === String(cur))) {
      const pick = stations.find((s) => s.active) || stations[0];
      settings.data.cloudlog.currentStationId = pick ? pick.id : null;
    }
    settings.saveNow();
    log.online = true;
    send('settings', publicSettings());
    return stations;
  },
  'stations:setCurrent': (id) => {
    settings.data.cloudlog.currentStationId = id ? String(id) : null;
    settings.saveNow();
    send('settings', publicSettings());
    send('qso:changed', {});
    return publicSettings();
  },

  'qso:add': (fields, opts = {}) => {
    const rec = log.addQso(fields, { source: opts.source || 'manual' });
    return { id: rec.id, call: rec.fields.CALL };
  },
  'qso:workedBefore': (call) => log.workedBefore(call, currentStation()),
  'log:query': (params) => log.query({ ...params, stationId: params.stationId || currentStation() }),
  'log:stats': () => log.stats(currentStation()),
  'log:clearCache': (stationId) => {
    const id = String(stationId || '').trim();
    if (!id) throw new Error('Choose a logbook first');
    log.clearLogbookCache(id);
    return { ok: true };
  },
  'log:refresh': async (stationId, opts) => {
    try {
      return await log.refreshRemote(stationId || currentStation(), opts);
    } catch (e) {
      if (e instanceof CloudlogError && /does not offer QSO download/.test(e.message)) {
        e.message = "This Cloudlog server doesn't support downloading the logbook (api/get_contacts_adif isn't available on Cloudlog, only on Wavelog). QSOs you log here still upload fine - you just won't see the server's history in this list.";
      }
      throw e;
    }
  },
  'log:exportLocal': async () => {
    const r = await dialog.showSaveDialog(win, { defaultPath: 'cloudlog-desktop-local.adi', filters: [{ name: 'ADIF', extensions: ['adi', 'adif'] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    fs.writeFileSync(r.filePath, log.exportLocalAdif());
    return { ok: true, path: r.filePath };
  },

  'sync:status': () => log.status(),
  'sync:now': async () => log.sync(),
  'sync:retryFailed': () => log.retryFailed(),
  'sync:setPaused': (paused) => { settings.data.sync.paused = !!paused; settings.saveNow(); send('sync', log.status()); if (!paused) log.sync(); return log.status(); },
  'local:list': (states) => log.localList(states),
  'local:delete': (id) => { log.deleteLocal(id); return true; },
  'local:update': (id, patch) => { const r = log.updateLocal(id, patch); return { id: r.id, call: r.fields.CALL }; },

  'rig:status': () => rigStatusPayload(),
  'rig:models': () => rigs.listModels(),
  'rig:ports': () => rigs.listPorts(),
  'rig:setFrequency': (id, hz) => { const s = rigs.services.get(id); if (!s) throw new Error('That radio is not running'); return s.setFrequency(hz); },
  'rig:setMode': (id, m) => { const s = rigs.services.get(id); if (!s) throw new Error('That radio is not running'); return s.setMode(m); },
  'rig:add': async (patch) => {
    const r = newRig(genRigId(), { label: `Radio ${settings.data.rigs.length + 1}`, ...patch });
    const bad = validateXmlrpcSharing(settings.data.rigs, r);
    if (bad) throw new Error(bad);
    settings.data.rigs.push(r);
    if (!settings.data.activeRigId) settings.data.activeRigId = r.id;
    await saveRigsAndApply([r.id]);
    return rigStatusPayload();
  },
  'rig:update': async (id, patch) => {
    const r = settings.data.rigs.find((x) => x.id === id);
    if (!r) throw new Error('Unknown radio');
    // Check the merged XML-RPC sharing config (port range, clashes with other listeners) before anything is saved or restarted.
    const bad = validateXmlrpcSharing(settings.data.rigs, deepMerge(JSON.parse(JSON.stringify(r)), patch));
    if (bad) throw new Error(bad);
    deepMerge(r, patch);
    await saveRigsAndApply([id]);
    return rigStatusPayload();
  },
  'rig:remove': async (id) => {
    settings.data.rigs = settings.data.rigs.filter((r) => r.id !== id);
    if (settings.data.activeRigId === id) settings.data.activeRigId = settings.data.rigs.length ? settings.data.rigs[0].id : null;
    settings.saveNow();
    await rigs.removeOne(id);
    lastRadio.delete(id);
    send('rig', rigStatusPayload());
    send('settings', publicSettings());
    return rigStatusPayload();
  },
  'rig:setActive': (id) => {
    if (id && !settings.data.rigs.some((r) => r.id === id)) throw new Error('Unknown radio');
    settings.data.activeRigId = id || null;
    settings.saveNow();
    send('rig', rigStatusPayload());
    send('settings', publicSettings());
    return rigStatusPayload();
  },

  'adif:status': () => adif.status(),
  'adif:interfaces': () => discoverInterfaces(), // active multicast-capable interfaces + "This computer only"

  'contest:dupe': ({ contestId, call, band, mode, since }) => {
    const c = contestById(contestId);
    const id = c.custom ? (settings.data.contest.customId || 'OTHER') : c.id;
    const m = dupeMatcher(id, call.toUpperCase(), band, mode, c.dupe);
    // Scoped to this callsign (indexed) and to the contest window, rather than scanning the whole logbook.
    const hit = log.callsignHistory(currentStation(), call, LogService.stampToMs(since)).find(m);
    return hit ? { date: hit.QSO_DATE, time: hit.TIME_ON, band: hit.BAND, mode: hit.MODE } : null;
  },
  'contest:summary': ({ adifId, since }) => {
    // Scoped to the contest's time window (indexed range scan), not the whole logbook.
    const rows = log.recordsSince(currentStation(), LogService.stampToMs(since)).filter((r) => r.CONTEST_ID === adifId);
    const byBand = {};
    for (const r of rows) byBand[r.BAND] = (byBand[r.BAND] || 0) + 1;
    const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return { total: rows.length, byBand, lastHour: rows.filter((r) => `${r.QSO_DATE}${r.TIME_ON}` >= hourAgo).length, recent: rows.slice(0, 12) };
  },
};

ipcMain.handle('api', async (_e, name, args) => {
  const fn = api[name];
  if (!fn) throw new Error(`Unknown call ${name}`);
  try {
    return await fn(...(args || []));
  } catch (e) {
    // Errors cross the IPC boundary as plain messages.
    throw new Error(e.message || String(e));
  }
});

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const dir = app.getPath('userData');
  settings = new JsonStore(path.join(dir, 'settings.json'), SETTINGS_DEFAULTS);
  migrateRigs(settings.data);
  // Radios only auto-connect on launch if the operator opted in per-radio;
  // otherwise every radio starts turned off, however it was left last time.
  for (const r of settings.data.rigs) r.enabled = !!r.activeOnStartup;
  settings.saveNow();
  client = new CloudlogClient(() => settings.data.cloudlog);
  log = new LogService({ dir, client, getSettings: () => settings.data });
  rigs = new RigManager({ getSettings: () => settings.data, resourcesPath: process.resourcesPath, appVersion: app.getVersion() });
  adif = new AdifServer({ getSettings: () => settings.data });

  const refreshTray = createTray();
  log.on('status', () => { send('sync', log.status()); refreshTray(); });
  log.on('changed', () => { send('qso:changed', {}); send('sync', log.status()); refreshTray(); });
  log.on('progress', (p) => send('log:progress', p));
  rigs.on('status', () => send('rig', rigStatusPayload()));
  rigs.on('update', (id) => scheduleRadioPost(id));
  adif.on('status', (s) => send('adif:status', s));
  adif.on('records', (recs, source) => {
    const errors = [];
    let count = 0;
    for (const r of recs) {
      try { if (log.addQso(r, { source, dedupe: true })) count++; } catch (e) { errors.push(`${r.CALL}: ${e.message}`); }
    }
    send('adif:received', { count, source, calls: recs.map((r) => r.CALL), errors });
  });

  createWindow();
  log.start();
  await rigs.listModels().catch(() => {});
  await rigs.reconcile();
  adif.apply();
});

app.on('window-all-closed', () => { /* keep running in the tray */ });

let shuttingDown = false;
app.on('before-quit', async (e) => {
  if (shuttingDown) return;
  shuttingDown = true;
  quitting = true;
  e.preventDefault();
  try { await rigs.stopAll(); await adif.stop(); } catch { /* ignore */ }
  log.stop();
  settings.saveNow();
  if (tray) tray.destroy();
  app.exit(0);
});
