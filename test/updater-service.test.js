'use strict';
// Startup-check scheduling, the master switch, skip handling, auto-update revalidation and the Updates tab markup.
// Fake clock, fake timers, fake GitHub and a fake installer: nothing touches the network or a real installation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { StartupCheckScheduler } = require('../src/main/updater/scheduler');
const { UpdateService } = require('../src/main/updater/service');
const { InstallError } = require('../src/main/updater/installer');
const { parseVersion } = require('../src/main/updater/version');
const U = require('../src/renderer/updates-shared');

const REPO = 'kc1mjp/cloudlog-desktop';
const ROOT = path.join(__dirname, '..');

// ---- fakes ---------------------------------------------------------------------------------------------------
function clock() {
  const c = { t: 1_700_000_000_000, timers: [], seq: 0 };
  c.now = () => c.t;
  c.setTimer = (fn, ms) => { const h = { id: ++c.seq, at: c.t + ms, fn, unref() {} }; c.timers.push(h); return h; };
  c.clearTimer = (h) => { c.timers = c.timers.filter((x) => x !== h); };
  /** advance time and run due timers (earliest first), letting async work settle in between */
  c.advance = async (ms) => {
    const end = c.t + ms;
    for (;;) {
      const due = c.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      c.timers = c.timers.filter((x) => x !== due);
      c.t = Math.max(c.t, due.at);
      due.fn();
      await settle();
    }
    c.t = end;
  };
  return c;
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

const asset = (tag, name) => ({ name, size: 10, state: 'uploaded', browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${name}` });
function rel(version, { prerelease, assets = true } = {}) {
  const tag = `v${version}`;
  const pre = prerelease !== undefined ? prerelease : /-/.test(version);
  const n = `cloudlog-desktop_${version}_x86_64.AppImage`;
  return { tag_name: tag, draft: false, prerelease: pre, published_at: '2026-10-01T00:00:00Z', assets: assets ? [asset(tag, n), asset(tag, `${n}.sha256`), asset(tag, `cloudlog-desktop_${version}_amd64.deb`)] : [] };
}

function world(releases = []) {
  const w = { releases, online: true, calls: 0, fail: null, delay: null };
  w.fetchImpl = async (url, init) => {
    w.calls++;
    if (w.delay) await new Promise((res, rej) => { const t = setTimeout(res, w.delay); init && init.signal && init.signal.addEventListener('abort', () => { clearTimeout(t); rej(init.signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
    if (!w.online) throw new TypeError('fetch failed');
    if (w.fail) return w.fail();
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(w.releases) };
  };
  return w;
}

const APPIMAGE = { type: 'appimage', label: 'AppImage', selfUpdate: true, reason: '', arch: 'x64', platform: 'linux', appImagePath: '/apps/cld.AppImage', realPath: '/apps/cld.AppImage' };
const DEB = { type: 'deb', label: 'Debian package (.deb)', selfUpdate: false, reason: 'Installed from a Debian package: use the release page.', arch: 'x64', platform: 'linux', appImagePath: null, realPath: null };

function make({ version = '2610.1.0', saved = {}, installation = APPIMAGE, w = world(), installer, c = clock(), sched = {} } = {}) {
  const store = { data: { updates: JSON.parse(JSON.stringify(saved)) }, saves: 0, saveNow() { this.saves++; } };
  const events = []; const notes = [];
  const svc = new UpdateService({
    store, appVersion: version, installation, fetchImpl: w.fetchImpl, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    installer: installer || (async () => ({ path: installation.realPath })), emit: (s) => events.push(s), notify: (d) => notes.push(d),
    scheduler: { initialDelayMs: 0, ...sched }, fs: { realpathSync: (p) => p },
  });
  return { svc, store, w, c, events, notes };
}

// ---- scheduler ----------------------------------------------------------------------------------------------
function sched(outcomes, opts = {}) {
  const c = clock(); const runs = []; let enabled = true;
  const s = new StartupCheckScheduler({ run: async () => { runs.push(c.t); return outcomes.length ? outcomes.shift() : 'transient'; }, isEnabled: () => enabled, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, initialDelayMs: 0, ...opts });
  return { s, c, runs, setEnabled: (v) => { enabled = v; } };
}

test('startup check: runs once, asynchronously (not inside start()), then never again', async () => {
  const { s, c, runs } = sched(['ok']);
  s.start();
  assert.equal(runs.length, 0);                    // start() itself never blocks or runs the check
  await c.advance(1);
  assert.equal(runs.length, 1); assert.equal(s.done, true);
  s.start(); s.online(); s.enabledChanged();
  await c.advance(24 * 3600 * 1000);
  assert.equal(runs.length, 1);                    // no recurring background checks
  assert.equal(c.timers.length, 0);
});

test('offline start: bounded backoff retries, then waits for connectivity, then completes', async () => {
  const { s, c, runs } = sched(['transient', 'transient', 'transient', 'transient', 'transient', 'transient', 'ok']);
  s.start();
  await c.advance(1);
  assert.equal(runs.length, 1); assert.equal(s.phase, 'waiting-timer'); assert.equal(s.done, false);
  await c.advance(60 * 60 * 1000);                  // an hour offline: the backoff schedule runs out, no polling after that
  assert.equal(runs.length, 6);
  assert.equal(s.phase, 'waiting-online'); assert.equal(c.timers.length, 0);
  await c.advance(24 * 3600 * 1000);
  assert.equal(runs.length, 6);
  s.online();                                       // connectivity returns
  await c.advance(1);
  assert.equal(runs.length, 7); assert.equal(s.done, true);
});

test('connectivity flapping cannot cause unbounded attempts or overlapping runs', async () => {
  const { s, c, runs } = sched([], { maxOnlineRetries: 3, minGapMs: 2000 });
  s.start();
  await c.advance(1);
  await c.advance(60 * 60 * 1000);
  const base = runs.length;
  for (let i = 0; i < 50; i++) { s.online(); s.online(); await c.advance(3000); }
  assert.equal(runs.length - base, 3);              // maxOnlineRetries extra attempts, no more
  assert.equal(s.done, false);
  assert.ok(runs.length <= 12);
});

test('a check that is already running is never duplicated by online/enable events', async () => {
  const c = clock(); let n = 0; let release;
  const s = new StartupCheckScheduler({ run: () => { n++; return new Promise((r) => { release = r; }); }, isEnabled: () => true, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, initialDelayMs: 0 });
  s.start(); await c.advance(1);
  s.online(); s.enabledChanged(); s.start(); await c.advance(10000);
  assert.equal(n, 1);
  release('ok'); await settle();
  assert.equal(s.done, true); assert.equal(n, 1);
});

test('master switch: a parked pending check resumes when re-enabled; toggling never duplicates it', async () => {
  const { s, c, runs, setEnabled } = sched(['ok']);
  setEnabled(false);
  s.start(); await c.advance(1);
  assert.equal(runs.length, 0); assert.equal(s.done, false);          // pending, not run, not completed
  for (let i = 0; i < 5; i++) { setEnabled(true); s.enabledChanged(); setEnabled(false); s.enabledChanged(); }
  await c.advance(1000);
  assert.equal(runs.length, 0);
  setEnabled(true); s.enabledChanged(); s.enabledChanged(); s.enabledChanged();
  await c.advance(1);
  assert.equal(runs.length, 1); assert.equal(s.done, true);
});

// ---- service: checking ----------------------------------------------------------------------------------------
test('service startup check: offline first, then the network returns', async () => {
  const w = world([rel('2610.2.0')]); w.online = false;
  const t = make({ w, version: '2610.1.0' });
  t.svc.startStartupCheck();
  await t.c.advance(1);
  assert.equal(t.svc.getState().check.status, 'error');
  assert.equal(t.svc.getState().check.startup.done, false);
  assert.equal(t.svc.getState().release, null);
  w.online = true; await t.c.advance(5000);          // first backoff step
  const st = t.svc.getState();
  assert.equal(st.check.startup.done, true);
  assert.equal(st.release.version, '2610.2.0'); assert.equal(st.release.status, 'available');
  assert.equal(t.notes.length, 1);                   // one proactive notification
  const calls = w.calls;
  await t.c.advance(7 * 24 * 3600 * 1000);
  assert.equal(w.calls, calls);                      // nothing recurring
});

test('API failures are handled gracefully and final errors end the startup check without retries', async () => {
  for (const [label, fail, kind] of [
    ['malformed', () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{"x":1}' }), 'malformed'],
    ['rate limit', () => ({ ok: false, status: 403, headers: { get: (k) => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' })[k] ?? null }, text: async () => '{}' }), 'rate-limit'],
  ]) {
    const w = world(); w.fail = fail;
    const t = make({ w });
    t.svc.startStartupCheck(); await t.c.advance(1);
    const st = t.svc.getState();
    assert.equal(st.check.status, 'error', label); assert.equal(st.check.errorKind, kind, label);
    assert.equal(st.check.startup.done, true, label);
    await t.c.advance(3600 * 1000); assert.equal(w.calls, 1, label);
  }
  const w = world(); w.fail = () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' });
  const t = make({ w }); t.svc.startStartupCheck(); await t.c.advance(1);
  assert.equal(t.svc.getState().check.startup.done, false);   // 5xx is transient: stays pending for a retry
});

test('checks never overlap: concurrent manual checks and the startup check share one request', async () => {
  const w = world([rel('2610.2.0')]); w.delay = 20;
  const t = make({ w });
  const a = t.svc.check('manual'); const b = t.svc.check('manual');
  assert.strictEqual(a, b);
  t.svc.startStartupCheck();
  await Promise.all([a, b]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(w.calls, 1);
});

test('a manual check is separate from the startup check: it neither completes nor repeats it', async () => {
  const w = world([rel('2610.2.0')]);
  const t = make({ w });
  const r = await t.svc.check('manual');
  assert.equal(r.ok, true);
  assert.equal(t.svc.getState().check.startup.done, false);
  t.svc.startStartupCheck(); await t.c.advance(1);
  assert.equal(w.calls, 2); assert.equal(t.svc.getState().check.startup.done, true);
  await t.svc.check('manual'); await t.c.advance(3600 * 1000);
  assert.equal(w.calls, 3);                          // only the explicit manual check added a request
});

// ---- master switch --------------------------------------------------------------------------------------------
test('master switch off: no checks, no installs, nothing automatic; preferences are preserved', async () => {
  const w = world([rel('2610.2.0')]);
  const t = make({ w, saved: { allowPrerelease: true, allowBeta: true, allowAlpha: true, autoUpdate: true, skippedVersion: '2610.1.5' }, installer: () => new Promise(() => {}) });
  t.svc.startStartupCheck(); await t.c.advance(1);
  assert.equal(w.calls, 1);
  t.svc.setPreferences({ autoCheck: false });
  const st = t.svc.getState();
  assert.equal(st.settings.autoCheck, false);
  assert.deepEqual([st.settings.allowPrerelease, st.settings.allowBeta, st.settings.allowAlpha, st.settings.autoUpdate], [true, true, true, true]);
  assert.equal(t.store.data.updates.skippedVersion, '2610.1.5');
  assert.equal(st.release.version, '2610.2.0');                          // last result stays visible
  assert.ok(st.release.url.startsWith(`https://github.com/${REPO}/releases/tag/`));
  const before = w.calls;
  assert.equal((await t.svc.check('manual')).kind, 'disabled');
  assert.equal((await t.svc.install()).kind, 'disabled');
  assert.throws(() => t.svc.setPreferences({ allowBeta: false }), /turned off/);
  assert.throws(() => t.svc.skip(), /turned off/);
  assert.equal(st.controls.check.disabled, true); assert.ok(st.controls.check.reason);
  assert.equal(st.controls.allowBeta.disabled, true); assert.equal(st.controls.autoUpdate.disabled, true);
  await t.c.advance(24 * 3600 * 1000);
  assert.equal(w.calls, before);
});

test('master switch: pending startup check runs once when enabled during the session; toggling does not duplicate', async () => {
  const w = world([rel('2610.2.0')]);
  const t = make({ w, saved: { autoCheck: false } });
  t.svc.startStartupCheck(); await t.c.advance(1000);
  assert.equal(w.calls, 0);
  for (let i = 0; i < 4; i++) { t.svc.setPreferences({ autoCheck: true }); t.svc.setPreferences({ autoCheck: false }); }
  await t.c.advance(1);
  assert.equal(w.calls, 0);
  t.svc.setPreferences({ autoCheck: true }); await t.c.advance(1);
  assert.equal(w.calls, 1);
  t.svc.setPreferences({ autoCheck: false }); t.svc.setPreferences({ autoCheck: true }); await t.c.advance(3600 * 1000);
  assert.equal(w.calls, 1);                           // already completed: no second startup check
});

test('turning the master switch off cancels a check in progress', async () => {
  const w = world([rel('2610.2.0')]); w.delay = 5000;
  const t = make({ w });
  const p = t.svc.check('manual');
  await settle();
  assert.equal(t.svc.getState().check.inProgress, true);
  t.svc.setPreferences({ autoCheck: false });
  const r = await p;
  assert.equal(r.kind, 'aborted');
  assert.equal(t.svc.getState().check.status, 'disabled');
  assert.equal(t.svc.getState().release, null);
});

// ---- channels at the service level ---------------------------------------------------------------------------
const MIXED = () => world([rel('2610.1.1'), rel('2610.2.0-beta.1'), rel('2610.3.0-alpha.1'), rel('2610.1.2-rc.1')]);

test('changing channel settings invalidates an ineligible pending update; beta off also drops a pending alpha', async () => {
  const t = make({ w: MIXED(), version: '2610.1.0', saved: { allowPrerelease: true, allowBeta: true, allowAlpha: true } });
  await t.svc.check('manual');
  assert.equal(t.svc.getState().release.version, '2610.3.0-alpha.1');
  assert.equal(t.svc.getState().release.status, 'available');
  t.svc.setPreferences({ allowBeta: false });                         // also turns alpha off, atomically
  assert.deepEqual([t.store.data.updates.allowBeta, t.store.data.updates.allowAlpha], [false, false]);
  let st = t.svc.getState();
  assert.equal(st.release.version, '2610.1.2-rc.1');                  // the newest eligible release now
  t.svc.setPreferences({ allowPrerelease: false });
  st = t.svc.getState();
  assert.equal(st.release.version, '2610.1.1');                       // stable only
  assert.equal(st.release.status, 'available');
});

test('a displayed release that becomes ineligible stays visible but is labelled and cannot be installed', async () => {
  const w = world([rel('2610.3.0-alpha.1')]);
  const t = make({ w, version: '2610.1.0', saved: { allowPrerelease: true, allowBeta: true, allowAlpha: true } });
  await t.svc.check('manual');
  assert.equal(t.svc.getState().release.install.possible, true);
  t.svc.setPreferences({ allowAlpha: false });
  const r = t.svc.getState().release;
  assert.equal(r.version, '2610.3.0-alpha.1'); assert.equal(r.status, 'outside-channels');
  assert.equal(r.install.possible, false);
  assert.equal((await t.svc.install()).kind, 'unavailable');
  const html = U.renderUpdatesBody(t.svc.getState());
  assert.match(html, /data-release-status="outside-channels"/); assert.match(html, /Outside the enabled update channels/);
  assert.match(html, /data-act="update"[^>]*disabled/);
});

test('a prerelease installation is offered a newer stable release', async () => {
  const t = make({ w: world([rel('2610.1.0'), rel('2610.1.0-alpha.9')]), version: '2610.1.0-beta.2' });
  assert.deepEqual([t.svc.prefs().allowPrerelease, t.svc.prefs().allowBeta, t.svc.prefs().allowAlpha], [true, true, false]);
  await t.svc.check('manual');
  assert.equal(t.svc.getState().release.version, '2610.1.0');
});

test('saved settings persist across a restart and an invalid pair is repaired on load', () => {
  const a = make({ saved: { allowPrerelease: true, allowBeta: false, allowAlpha: true } });
  assert.equal(a.svc.prefs().allowBeta, true);
  assert.equal(a.store.data.updates.allowBeta, true); assert.ok(a.store.saves >= 1);       // persisted corrected
  a.svc.setPreferences({ autoUpdate: true, allowAlpha: false });
  const b = make({ saved: a.store.data.updates, version: '2610.9.0' });                      // "restart" on another channel
  const p = b.svc.prefs();
  assert.deepEqual([p.allowPrerelease, p.allowBeta, p.allowAlpha, p.autoUpdate], [true, true, false, true]);
});

// ---- skip / manual / auto ------------------------------------------------------------------------------------
test('skipping: persisted, quiet, still shown, labelled; a newer release replaces it and notifies normally', async () => {
  const w = world([rel('2610.2.0')]);
  const t = make({ w });
  await t.svc.check('manual');
  t.svc.skip();
  assert.equal(t.store.data.updates.skippedVersion, '2610.2.0');
  let r = t.svc.getState().release;
  assert.equal(r.status, 'skipped'); assert.equal(r.version, '2610.2.0');
  assert.match(U.renderUpdatesBody(t.svc.getState()), /Skipped/);
  // the automatic path stays silent about a skipped version
  t.svc.startStartupCheck(); await t.c.advance(1);
  assert.equal(t.notes.length, 0);
  // a manual check reports it (and does not install it)
  const m = await t.svc.check('manual');
  assert.equal(m.ok, true); assert.equal(m.release.status, 'skipped');
  assert.match(t.svc.getState().check.message, /skipped/);
  // newer eligible release appears
  w.releases = [rel('2610.2.0'), rel('2610.2.1')];
  await t.svc.check('manual');
  r = t.svc.getState().release;
  assert.equal(r.version, '2610.2.1'); assert.equal(r.status, 'available');
});

test('auto-update: installs a new eligible release after the startup check; never a skipped one; never from a manual check', async () => {
  const installs = [];
  const installer = async (o) => { installs.push(o.asset.name); return { path: o.target }; };
  // on
  const a = make({ w: world([rel('2610.2.0')]), saved: { autoUpdate: true }, installer });
  a.svc.startStartupCheck(); await a.c.advance(1); await a.svc.whenIdle();
  assert.deepEqual(installs, ['cloudlog-desktop_2610.2.0_x86_64.AppImage']);
  assert.equal(a.svc.getState().progress.phase, 'restart-required');   // no automatic restart, just the notice
  // off: notify only
  installs.length = 0;
  const b = make({ w: world([rel('2610.2.0')]), installer });
  b.svc.startStartupCheck(); await b.c.advance(1); await b.svc.whenIdle();
  assert.equal(installs.length, 0); assert.equal(b.notes.length, 1);
  // skipped
  const c = make({ w: world([rel('2610.2.0')]), saved: { autoUpdate: true, skippedVersion: '2610.2.0' }, installer });
  c.svc.startStartupCheck(); await c.c.advance(1); await c.svc.whenIdle();
  assert.equal(installs.length, 0); assert.equal(c.notes.length, 0);
  // manual check with auto-update on does not install
  const d = make({ w: world([rel('2610.2.0')]), saved: { autoUpdate: true }, installer });
  await d.svc.check('manual'); await d.svc.whenIdle();
  assert.equal(installs.length, 0);
  assert.equal((await d.svc.install({ auto: true, })).ok, true);       // (automatic path is allowed when everything permits)
  await d.svc.whenIdle();
});

test('the explicit Update action installs a skipped but still eligible version', async () => {
  const installs = [];
  const t = make({ w: world([rel('2610.2.0')]), installer: async (o) => { installs.push(o.asset.name); return {}; } });
  await t.svc.check('manual'); t.svc.skip();
  assert.equal(t.svc.getState().release.install.possible, true);
  assert.equal((await t.svc.install({ auto: false })).ok, true);
  await t.svc.whenIdle();
  assert.equal(installs.length, 1);
  assert.equal(t.svc.getState().progress.phase, 'restart-required');
  assert.equal(t.svc.getState().release, null);                        // nothing newer than what is now on disk
  assert.equal((await t.svc.install()).ok, false);
});

test('automatic install is refused for a skipped release even if asked directly', async () => {
  const t = make({ w: world([rel('2610.2.0')]), saved: { autoUpdate: true } });
  await t.svc.check('manual'); t.svc.skip();
  assert.equal((await t.svc.install({ auto: true })).kind, 'not-allowed');
});

// ---- non-AppImage -------------------------------------------------------------------------------------------
test('non-AppImage installations only notify and link to the release page', async () => {
  let installerCalled = false;
  const t = make({ w: world([rel('2610.2.0')]), installation: DEB, installer: async () => { installerCalled = true; }, saved: { autoUpdate: true } });
  assert.equal(t.svc.getState().settings.autoUpdate, false);           // a saved flag cannot enable it
  t.svc.startStartupCheck(); await t.c.advance(1); await t.svc.whenIdle();
  const st = t.svc.getState();
  assert.equal(st.release.status, 'available'); assert.equal(st.release.install.possible, false);
  assert.equal(t.notes.length, 1); assert.equal(installerCalled, false);
  assert.equal((await t.svc.install()).kind, 'unavailable');
  assert.throws(() => t.svc.setPreferences({ autoUpdate: true }), /AppImage/);
  assert.equal(st.controls.autoUpdate.disabled, true);
  const html = U.renderUpdatesBody(st);
  assert.match(html, /Debian package/); assert.match(html, /data-act="update"[^>]*disabled/);
  assert.match(html, /id="up-auto-update"[^>]*disabled/);
  assert.match(html, /data-act="open-release"/);
});

test('an AppImage release without a matching asset or checksum cannot be installed', async () => {
  const w = world([rel('2610.2.0', { assets: false })]);
  const t = make({ w });
  await t.svc.check('manual');
  const r = t.svc.getState().release;
  assert.equal(r.install.possible, false); assert.match(r.install.reason, /no AppImage/i);
});

// ---- revalidation during a download ---------------------------------------------------------------------------
function slowInstaller(log) {
  return (o) => new Promise((resolve, reject) => {
    o.onPhase('downloading');
    o.signal.addEventListener('abort', () => { log.push('aborted'); reject(new InstallError('cancelled', 'The update was cancelled')); });
    log.push({ finish: () => { const v = o.revalidate(); if (v.ok === false) reject(new InstallError('cancelled', v.reason)); else { o.onPhase('installing'); resolve({}); } } });
  });
}

test('disabling beta during an alpha download cancels it and nothing is installed', async () => {
  const log = [];
  const t = make({ w: world([rel('2610.3.0-alpha.1')]), saved: { allowPrerelease: true, allowBeta: true, allowAlpha: true }, installer: slowInstaller(log) });
  await t.svc.check('manual');
  await t.svc.install();
  await settle();
  assert.equal(t.svc.getState().progress.phase, 'downloading');
  t.svc.setPreferences({ allowBeta: false });
  await t.svc.whenIdle();
  assert.ok(log.includes('aborted'));
  const p = t.svc.getState().progress;
  assert.equal(p.phase, 'cancelled'); assert.match(p.message, /Alpha updates are no longer enabled/);
  assert.equal(t.svc.getState().release.status, 'outside-channels');
});

test('turning auto-update off or skipping cancels an automatic download; a manual one continues', async () => {
  for (const change of [() => ({ autoUpdate: false }), 'skip']) {
    const log = [];
    const t = make({ w: world([rel('2610.2.0')]), saved: { autoUpdate: true }, installer: slowInstaller(log) });
    await t.svc.check('manual');
    await t.svc.install({ auto: true }); await settle();
    typeof change === 'string' ? t.svc.skip() : t.svc.setPreferences(change());
    await t.svc.whenIdle();
    assert.ok(log.includes('aborted'));
  }
  const log = [];
  const t = make({ w: world([rel('2610.2.0')]), installer: slowInstaller(log) });
  await t.svc.check('manual'); await t.svc.install(); await settle();
  t.svc.skip();                                                            // does not stop an explicit install
  assert.ok(!log.includes('aborted'));
  log.find((x) => x.finish).finish(); await t.svc.whenIdle();
  assert.equal(t.svc.getState().progress.phase, 'restart-required');
});

test('master switch off cancels a download, but never interrupts the replacement step', async () => {
  const log = [];
  const t = make({ w: world([rel('2610.2.0')]), installer: slowInstaller(log) });
  await t.svc.check('manual'); await t.svc.install(); await settle();
  t.svc.setPreferences({ autoCheck: false });
  await t.svc.whenIdle();
  assert.ok(log.includes('aborted')); assert.equal(t.svc.getState().progress.phase, 'cancelled');

  // critical step
  let release; let aborted = false;
  const critical = (o) => new Promise((resolve) => { o.onPhase('installing'); o.signal.addEventListener('abort', () => { aborted = true; }); release = resolve; });
  const u = make({ w: world([rel('2610.2.0')]), installer: critical });
  await u.svc.check('manual'); await u.svc.install(); await settle();
  assert.equal(u.svc.cancel(), false);                                      // user cancel is refused too
  u.svc.setPreferences({ autoCheck: false });
  assert.equal(aborted, false);
  release({}); await u.svc.whenIdle();
  assert.equal(u.svc.getState().progress.phase, 'restart-required');
});

test('only one installation at a time; restart is explicit', async () => {
  let relaunched = 0;
  const log = [];
  const t = make({ w: world([rel('2610.2.0')]), installer: slowInstaller(log) });
  t.svc.relaunchHook = () => { relaunched++; };
  await t.svc.check('manual');
  assert.equal((await t.svc.install()).ok, true);
  assert.equal((await t.svc.install()).kind, 'busy');
  assert.equal(t.svc.restart(), false);
  log.find((x) => x.finish).finish(); await t.svc.whenIdle();
  assert.equal(relaunched, 0);                                              // nothing restarts by itself
  assert.equal(t.svc.restart(), true); assert.equal(relaunched, 1);
});

test('installer failures are reported with the release link still available and the install untouched', async () => {
  const t = make({ w: world([rel('2610.2.0')]), installer: async () => { throw new InstallError('not-writable', 'The folder is not writable'); } });
  await t.svc.check('manual'); await t.svc.install(); await t.svc.whenIdle();
  const st = t.svc.getState();
  assert.equal(st.progress.phase, 'failed'); assert.match(st.progress.message, /not writable.*not changed/);
  assert.ok(st.release.url);
  assert.match(U.renderUpdatesBody(st), /data-progress="failed"/);
});

// ---- Updates tab ------------------------------------------------------------------------------------------------
test('Updates tab sits between Appearance and About and uses a Font Awesome refresh icon like the other tabs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/pages/settings.js'), 'utf8');
  const tabs = /const TABS = \[(.*)\];/.exec(src)[1];
  const ids = [...tabs.matchAll(/\['(\w+)', '([^']+)', '(fa-[\w-]+)'\]/g)].map((m) => m.slice(1));
  const names = ids.map((x) => x[0]);
  assert.equal(names[names.indexOf('updates') - 1], 'appearance'); assert.equal(names[names.indexOf('updates') + 1], 'about');
  assert.deepEqual(ids.find((x) => x[0] === 'updates'), ['updates', 'Updates', 'fa-arrows-rotate']);
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  assert.ok(html.includes('updates-shared.js'));
});

test('Updates tab content: all controls, explanations, accessible switches and AppImage-only controls', async () => {
  const t = make({ w: world([rel('2610.2.0')]) });
  await t.svc.check('manual');
  const html = U.renderUpdatesBody(t.svc.getState(), { formatTime: () => 'T' });
  for (const label of ['Allow pre-release updates', 'Allow beta updates', 'Allow alpha updates', 'Auto-update', 'Auto check update', 'Check for updates', 'Skip this version']) assert.ok(html.includes(label), label);
  assert.match(html, /Installed version:/); assert.match(html, /Installation type:/); assert.match(html, /AppImage/);
  assert.match(html, /Last checked:/); assert.match(html, /Newest eligible version:/);
  assert.match(html, /Alpha updates also enable beta updates/);
  assert.match(html, /Alpha releases require &quot;Allow alpha updates&quot;, which also turns on beta updates/);
  assert.match(html, /Stable releases are always offered/);
  assert.match(html, /href="https:\/\/github.com\/kc1mjp\/cloudlog-desktop\/releases\/tag\/v2610.2.0"/);
  assert.equal((html.match(/role="switch"/g) || []).length, 5);
  for (const id of ['up-auto-check', 'up-prerelease', 'up-beta', 'up-alpha', 'up-auto-update']) assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="${id}-desc"`));
  assert.match(html, /<label class="form-check-label" for="up-beta">/);
  // stable installation: prerelease off, so beta and alpha controls are disabled with a reason
  assert.match(html, /id="up-beta"[^>]*disabled/); assert.match(html, /id="up-alpha"[^>]*disabled/);
  assert.match(html, /Turn on &quot;Allow pre-release updates&quot; first/);
  assert.match(html, /data-act="update"(?![^>]*disabled)/);
});

test('Updates tab with the master switch off explains why controls are unavailable and keeps the release link', async () => {
  const t = make({ w: world([rel('2610.2.0')]), saved: { allowPrerelease: true } });
  await t.svc.check('manual');
  t.svc.setPreferences({ autoCheck: false });
  const html = U.renderUpdatesBody(t.svc.getState());
  assert.match(html, /data-master-off/); assert.match(html, /Your other update settings are kept/);
  assert.match(html, /data-act="check"[^>]*disabled/); assert.match(html, /data-act="update"[^>]*disabled/);
  assert.doesNotMatch(html, /data-act="skip"/);
  for (const id of ['up-prerelease', 'up-beta', 'up-alpha', 'up-auto-update']) assert.match(html, new RegExp(`id="${id}"[^>]*disabled`));
  assert.match(html, /id="up-auto-check"(?![^>]*disabled)/);
  assert.match(html, /data-act="open-release"/);
});

test('Updates tab escapes untrusted text and shows progress / restart states', () => {
  const t = make();
  const st = t.svc.getState();
  st.release = { version: '<img src=x>', tag: 't', channel: 'beta', channelLabel: '<b>', url: 'https://x/"y', status: 'available', install: { possible: false, reason: '<script>' } };
  st.diagnostics = [{ tag: '<i>', reason: '"><script>' }];
  const html = U.renderUpdatesBody(st);
  assert.doesNotMatch(html, /<img src=x>|<script>|<b>/);
  st.progress = { phase: 'downloading', percent: 40, message: 'Downloading…' };
  assert.match(U.renderUpdatesBody(st), /aria-valuenow="40"/);
  st.progress = { phase: 'restart-required', message: 'Restart required' };
  assert.match(U.renderUpdatesBody(st), /data-act="restart"/);
});

// ---- versioning rules -----------------------------------------------------------------------------------------
test('the running version comes only from package.json: the updater accepts it and no source file hard-codes it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(parseVersion(pkg.version), `package.json version ${pkg.version} must be a supported CalVer version`);
  const t = make({ version: pkg.version });
  assert.equal(t.svc.getState().installed.version, pkg.version);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'vendor' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(ROOT, 'src')).filter((x) => /\.(js|html|css|json)$/.test(x))) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes(`"${pkg.version}"`) && !fs.readFileSync(f, 'utf8').includes(`'${pkg.version}'`), `${path.relative(ROOT, f)} hard-codes the version`);
  }
});

test('an unrecognized installed version disables checking instead of guessing', async () => {
  const w = world([rel('2610.2.0')]);
  const t = make({ w, version: '0.4.4' });
  assert.equal(t.svc.getState().installed.recognized, false);
  assert.equal((await t.svc.check('manual')).kind, 'unsupported-version');
  assert.equal(w.calls, 0);
});
