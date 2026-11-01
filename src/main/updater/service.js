'use strict';
/*
 * UpdateService: owns the update state for the main process and ties the pieces together.
 *
 *   discovery (releases.js) -> catalog -> display (newest ELIGIBLE release that is newer than the running version)
 *   preferences (channels.js) are re-applied to the catalog in memory whenever they change, so a release that stops being
 *   eligible stops being offered immediately, with no network access.
 *
 * Master switch ("Auto check update", autoCheck): when off, NOTHING here touches the network - no startup check, no manual
 * check, no download, no install. It does not erase any other saved preference.
 *
 * Electron-free (everything environment-specific is injected) so node:test can drive it with fakes.
 */
const { parseVersion, compareVersions, CHANNEL_LABELS } = require('./version');
const { resolvePreferences, normalizeSaved, applyPreferencePatch, isChannelEligible, PreferenceError } = require('./channels');
const { fetchReleases, buildCatalog, selectBest, UpdateCheckError, repoUrl } = require('./releases');
const { selectAppImageAsset, AssetError } = require('./assets');
const { InstallError, installAppImage } = require('./installer');
const { ChecksumError } = require('./checksum');
const { StartupCheckScheduler } = require('./scheduler');

const DISABLED_MESSAGE = 'Updates are turned off. Turn on "Auto check update" to check for and install updates.';
const GITHUB_REPO = 'kc1mjp/cloudlog-desktop';

class UpdateService {
  /**
   * store:        { data, saveNow() } - settings.data.updates holds the saved preferences
   * appVersion:   the running version (package.json via app.getVersion())
   * installation: result of detectInstallation()
   * hooks:        emit(state), notify(display), relaunch()
   */
  constructor({ store, appVersion, installation, repo = GITHUB_REPO, fetchImpl = (...a) => fetch(...a), now = Date.now,
    installer = installAppImage, fs: fsImpl = require('fs'), emit = () => {}, notify = () => {}, relaunch = () => {}, getuid, scheduler: schedulerOptions = {}, setTimer, clearTimer }) {
    this.store = store; this.appVersion = appVersion; this.installation = installation; this.repo = repo;
    this.fetchImpl = fetchImpl; this.now = now; this.installer = installer; this.emitHook = emit; this.notifyHook = notify; this.relaunchHook = relaunch;
    this.getuid = getuid; this.fs = fsImpl;
    this.installed = parseVersion(appVersion);
    this.catalog = null; this.diagnostics = []; this.truncated = false;
    this.display = null;                      // { version, parsed, tag, channel, url, publishedAt, entry|null }
    this.checkState = { status: 'idle', message: '', origin: null };
    this.inflight = null; this.checkAbort = null;
    this.job = null; this.jobPromise = Promise.resolve();
    this.installState = { phase: 'idle' };
    this.restartVersion = null;
    this.notifiedVersion = null;
    this._lastProgressEmit = 0;
    this.scheduler = new StartupCheckScheduler({
      run: () => this._startupAttempt(), isEnabled: () => this.prefs().autoCheck, now, setTimer, clearTimer, ...schedulerOptions,
    });
    this._init();
  }

  // ---- preferences ---------------------------------------------------------------------------------------
  channel() { return this.installed ? this.installed.channel : 'unknown'; }
  saved() { if (!this.store.data.updates || typeof this.store.data.updates !== 'object') this.store.data.updates = {}; return this.store.data.updates; }
  prefs() { return resolvePreferences(this.saved(), this.channel()); }
  _persist() { this.store.saveNow(); }

  _init() {
    const { saved, changed } = normalizeSaved(this.store.data.updates, this.channel());
    this.store.data.updates = saved;
    if (changed) this._persist();   // e.g. alpha ON + beta OFF becomes alpha ON + beta ON, and is stored that way
    const d = saved.discovered;
    const p = d && typeof d.version === 'string' ? parseVersion(d.version) : null;
    if (p) this.display = { version: p.text, parsed: p, tag: p.tag, channel: p.channel, url: `${repoUrl(this.repo)}/releases/tag/${encodeURIComponent(p.tag)}`, publishedAt: typeof d.publishedAt === 'string' ? d.publishedAt : null, entry: null };
    if (Number.isFinite(saved.lastCheckAt)) this.checkState.lastCheckAt = saved.lastCheckAt;
    this._reevaluate(false);
  }

  /** Begin the single automatic startup check for this launch (asynchronous, delayed, never blocks startup). */
  startStartupCheck() { this.scheduler.start(); }
  /** Connectivity hint from the OS/browser. Only ever a trigger for a pending startup check. */
  setOnline(online) { if (online) this.scheduler.online(); }

  async _startupAttempt() {
    const r = await this.check('startup');
    if (r.kind === 'disabled' || r.kind === 'aborted') return 'skipped';
    if (r.ok) { await this._afterAutomaticCheck(); return 'ok'; }
    return r.transient ? 'transient' : 'final';
  }

  // ---- version bookkeeping ----------------------------------------------------------------------------------
  /** What a candidate must beat: the running version, or a newer one already written to disk awaiting restart. */
  _reference() {
    if (this.restartVersion && (!this.installed || compareVersions(this.restartVersion, this.installed) > 0)) return this.restartVersion;
    return this.installed;
  }
  _isNewer(parsed) { const ref = this._reference(); return !!ref && compareVersions(parsed, ref) > 0; }

  _fromEntry(e) { return { version: e.version, parsed: e.parsed, tag: e.tag, channel: e.channel, url: e.url, publishedAt: e.publishedAt, entry: e }; }

  /** Recompute which release is shown. Pure with respect to the network. */
  _reevaluate(persist = true) {
    const eff = this.prefs();
    let next = null;
    if (this.catalog) {
      const best = selectBest(this.catalog, this._reference(), eff);
      if (best) next = this._fromEntry(best);
      else if (this.display) {
        const e = this.catalog.find((x) => x.tag === this.display.tag);   // gone from GitHub (pruned/deleted): drop it
        if (e && this._isNewer(e.parsed)) next = this._fromEntry(e);       // kept as history: now outside the enabled channels
      }
    } else if (this.display && this._isNewer(this.display.parsed)) {
      next = this.display;                                                  // restored from the last session; no assets yet
    }
    const changed = (next && next.version) !== (this.display && this.display.version);
    this.display = next;
    if (persist) {
      const s = this.saved();
      if (next) {
        const prev = s.discovered;
        if (!prev || prev.version !== next.version) { s.discovered = { version: next.version, tag: next.tag, channel: next.channel, publishedAt: next.publishedAt }; this._persist(); }
      } else if (s.discovered) { delete s.discovered; this._persist(); }
    }
    return changed;
  }

  // ---- public state ---------------------------------------------------------------------------------------------
  _installability(d, eligible) {
    const eff = this.prefs();
    if (!eff.autoCheck) return { possible: false, reason: DISABLED_MESSAGE };
    if (!this.installation.selfUpdate) return { possible: false, reason: this.installation.reason || 'This installation cannot update itself; use the release page.' };
    if (this.job) return { possible: false, reason: 'An update is already being installed.' };
    if (this.installState.phase === 'restart-required') return { possible: false, reason: 'An update is already installed; restart to use it.' };
    if (!eligible) return { possible: false, reason: 'This release is outside the enabled update channels.' };
    if (!d.entry) return { possible: false, reason: 'Check for updates to enable installing.' };
    try { selectAppImageAsset(d.entry, { platform: this.installation.platform, arch: this.installation.arch }); } catch (e) { return { possible: false, reason: e.message }; }
    return { possible: true, reason: '' };
  }

  publicDisplay() {
    const d = this.display;
    if (!d) return null;
    const eff = this.prefs();
    const eligible = isChannelEligible(d.channel, eff) && this._isNewer(d.parsed);
    const status = !eligible ? 'outside-channels' : (eff.skippedVersion === d.version ? 'skipped' : 'available');
    return { version: d.version, tag: d.tag, channel: d.channel, channelLabel: CHANNEL_LABELS[d.channel], url: d.url, publishedAt: d.publishedAt, status, install: this._installability(d, eligible) };
  }

  getState() {
    const eff = this.prefs();
    const master = eff.autoCheck;
    const prereleaseOff = !eff.allowPrerelease;
    const self = this.installation.selfUpdate;
    const off = DISABLED_MESSAGE;
    return {
      installed: { version: this.appVersion, channel: this.channel(), channelLabel: CHANNEL_LABELS[this.channel()], recognized: !!this.installed },
      installation: { type: this.installation.type, label: this.installation.label, selfUpdate: self, reason: this.installation.reason || '', arch: this.installation.arch },
      settings: { autoCheck: eff.autoCheck, allowPrerelease: eff.allowPrerelease, allowBeta: eff.allowBeta, allowAlpha: eff.allowAlpha, autoUpdate: eff.autoUpdate && self },
      controls: {
        autoCheck: { disabled: false, reason: '' },
        allowPrerelease: { disabled: !master, reason: master ? '' : off },
        allowBeta: { disabled: !master || prereleaseOff, reason: !master ? off : prereleaseOff ? 'Turn on "Allow pre-release updates" first.' : '' },
        allowAlpha: { disabled: !master || prereleaseOff, reason: !master ? off : prereleaseOff ? 'Turn on "Allow pre-release updates" first.' : '' },
        autoUpdate: { disabled: !master || !self, reason: !self ? (this.installation.reason || 'Only supported AppImage installations can update themselves.') : (!master ? off : '') },
        check: { disabled: !master || !this.installed || !!this.inflight, reason: !master ? off : !this.installed ? 'The installed version is not recognized, so update checks are unavailable.' : '' },
      },
      check: { ...this.checkState, enabled: master, inProgress: !!this.inflight, startup: this.scheduler.status, truncated: this.truncated },
      release: this.publicDisplay(),
      progress: { ...this.installState },
      diagnostics: this.diagnostics.slice(0, 50),
      repoUrl: repoUrl(this.repo),
    };
  }

  _emit() { try { this.emitHook(this.getState()); } catch { /* UI gone */ } }
  _setCheck(patch) { this.checkState = { ...this.checkState, ...patch }; this._emit(); }

  // ---- checking ---------------------------------------------------------------------------------------------------
  /**
   * One check. origin: 'manual' | 'startup'. Never overlaps: a call made while a check runs joins it.
   * Resolves { ok, kind, transient?, message? } and never rejects.
   */
  check(origin = 'manual') {
    if (!this.prefs().autoCheck) return Promise.resolve({ ok: false, kind: 'disabled', message: DISABLED_MESSAGE });
    if (!this.installed) return Promise.resolve({ ok: false, kind: 'unsupported-version', message: 'The installed version is not recognized, so update checks are unavailable.' });
    if (this.inflight) return this.inflight;
    this.inflight = this._runCheck(origin).finally(() => { this.inflight = null; this.checkAbort = null; this._emit(); });
    return this.inflight;
  }

  async _runCheck(origin) {
    const ac = new AbortController();
    this.checkAbort = ac;
    this._setCheck({ status: 'checking', message: 'Checking for updates…', origin });
    try {
      const r = await fetchReleases({ repo: this.repo, fetchImpl: this.fetchImpl, userAgent: `cloudlog-desktop/${this.appVersion}`, signal: ac.signal });
      if (ac.signal.aborted) throw new UpdateCheckError('aborted', 'The update check was cancelled');
      const cat = buildCatalog(r.releases, this.repo);
      this.catalog = cat.entries; this.diagnostics = cat.diagnostics; this.truncated = !!r.truncated;
      const at = this.now();
      this.saved().lastCheckAt = at;
      this._reevaluate(true);
      this._persist();
      const d = this.publicDisplay();
      const msg = d && d.status === 'available' ? `Update available: ${d.version}`
        : d && d.status === 'skipped' ? `Update ${d.version} is available but skipped`
        : d && d.status === 'outside-channels' ? 'You are up to date for the enabled update channels'
        : 'You are up to date';
      this._setCheck({ status: 'ok', message: msg, lastCheckAt: at });
      return { ok: true, kind: 'ok', release: d };
    } catch (e) {
      if (e instanceof UpdateCheckError && e.kind === 'aborted') {
        this._setCheck({ status: this.prefs().autoCheck ? 'idle' : 'disabled', message: this.prefs().autoCheck ? 'Check cancelled' : DISABLED_MESSAGE });
        return { ok: false, kind: 'aborted', message: 'The update check was cancelled' };
      }
      const kind = e instanceof UpdateCheckError ? e.kind : 'error';
      let message = e instanceof UpdateCheckError ? e.message : 'The update check failed unexpectedly';
      if (kind === 'rate-limit' && e.resetAt) message = `GitHub rate limit reached; try again after ${new Date(e.resetAt).toLocaleTimeString()}`;
      this._setCheck({ status: 'error', message, errorKind: kind });
      return { ok: false, kind, message, transient: !!(e instanceof UpdateCheckError && e.transient) };
    }
  }

  async _afterAutomaticCheck() {
    const d = this.publicDisplay();
    if (!d || d.status !== 'available') return;                      // skipped / outside the channels: no notification, no install
    if (this.notifiedVersion !== d.version) { this.notifiedVersion = d.version; try { this.notifyHook(d); } catch { /* ignore */ } }
    if (this.prefs().autoUpdate && this.installation.selfUpdate && d.install.possible) await this.install({ auto: true });
  }

  // ---- changing preferences --------------------------------------------------------------------------------------
  setPreferences(patch) {
    const before = this.prefs();
    const keys = Object.keys(patch || {});
    if (!before.autoCheck && keys.some((k) => k !== 'autoCheck')) throw new PreferenceError(DISABLED_MESSAGE);
    if (patch && patch.autoUpdate === true && !this.installation.selfUpdate) throw new PreferenceError('Auto-update is only available for AppImage installations that can replace themselves.');
    this.store.data.updates = applyPreferencePatch(this.saved(), this.channel(), patch); // one assignment, one write
    this._persist();
    const after = this.prefs();
    this._reevaluate(true);
    this._revalidateJob();
    if (before.autoCheck !== after.autoCheck) this._masterChanged(after.autoCheck);
    this._emit();
    return this.getState();
  }

  _masterChanged(on) {
    if (!on) {
      if (this.checkAbort) this.checkAbort.abort();
      this._setCheck({ status: 'disabled', message: DISABLED_MESSAGE });
    } else {
      this._setCheck({ status: 'idle', message: '' });
    }
    this.scheduler.enabledChanged();
  }

  skip() {
    if (!this.prefs().autoCheck) throw new PreferenceError(DISABLED_MESSAGE);
    const d = this.publicDisplay();
    if (!d || d.status === 'outside-channels') throw new PreferenceError('There is no available update to skip.');
    this.saved().skippedVersion = d.version;
    this._persist();
    this._revalidateJob();
    this._emit();
    return this.getState();
  }

  // ---- installing ----------------------------------------------------------------------------------------------
  _jobValid(job) {
    const eff = this.prefs();
    if (!eff.autoCheck) return { ok: false, reason: 'Updates were turned off' };
    if (!isChannelEligible(job.channel, eff)) return { ok: false, reason: `${CHANNEL_LABELS[job.channel]} updates are no longer enabled` };
    if (!this._isNewer(job.parsed)) return { ok: false, reason: 'This version is no longer newer than the installed version' };
    if (!this.installation.selfUpdate) return { ok: false, reason: 'This installation cannot update itself' };
    if (job.auto) {
      if (!eff.autoUpdate) return { ok: false, reason: 'Auto-update was turned off' };
      if (eff.skippedVersion === job.version) return { ok: false, reason: 'This version was skipped' };
    }
    return { ok: true };
  }

  /** Cancel a running download when it stopped being allowed. Never during the replacement step. */
  _revalidateJob() {
    const job = this.job;
    if (!job || job.critical) return;
    const v = this._jobValid(job);
    if (!v.ok) { job.cancelReason = v.reason; job.abort.abort(); }
  }

  /** User cancel. Returns false when there is nothing to cancel or the replacement step has started. */
  cancel() {
    const job = this.job;
    if (!job || job.critical) return false;
    job.cancelReason = 'The update was cancelled'; job.abort.abort();
    return true;
  }

  /**
   * Start installing the displayed update. auto: true only from the automatic path (honours Auto-update and skip).
   * A manual install of a skipped, still eligible version is allowed - that is the explicit "Update" action.
   * Resolves once the job has STARTED (progress arrives through state events); await whenIdle() for the end.
   */
  async install({ auto = false } = {}) {
    if (!this.prefs().autoCheck) return { ok: false, kind: 'disabled', message: DISABLED_MESSAGE };
    if (this.job) return { ok: false, kind: 'busy', message: 'An update is already being installed.' };
    const d = this.publicDisplay();
    if (!d) return { ok: false, kind: 'unavailable', message: 'There is no update to install.' };
    if (!d.install.possible) return { ok: false, kind: 'unavailable', message: d.install.reason };
    if (auto && (d.status !== 'available' || !this.prefs().autoUpdate)) return { ok: false, kind: 'not-allowed', message: 'Automatic installation is not allowed for this release.' };
    let sel;
    try { sel = selectAppImageAsset(this.display.entry, { platform: this.installation.platform, arch: this.installation.arch }); } catch (e) { return { ok: false, kind: 'unavailable', message: e.message }; }
    const job = { version: d.version, parsed: this.display.parsed, channel: this.display.channel, auto, abort: new AbortController(), critical: false, cancelReason: '' };
    this.job = job;
    this.installState = { phase: 'checksum', version: d.version, message: 'Fetching the published checksum…', auto };
    this._emit();
    this.jobPromise = this._runJob(job, sel);
    return { ok: true, kind: 'started' };
  }

  whenIdle() { return this.jobPromise; }

  async _runJob(job, { asset, checksumAsset }) {
    const phaseText = { checksum: 'Fetching the published checksum…', downloading: 'Downloading…', verifying: 'Verifying the download…', installing: 'Installing…' };
    try {
      const resolveTarget = () => this.fs.realpathSync(this.installation.appImagePath);
      await this.installer({
        target: this.installation.realPath, asset, checksumAsset, fetchImpl: this.fetchImpl, signal: job.abort.signal, getuid: this.getuid,
        resolveTarget,
        onPhase: (phase) => {
          if (phase === 'installing') job.critical = true;
          this.installState = { ...this.installState, phase, message: phaseText[phase] || phase, percent: phase === 'downloading' ? this.installState.percent : null };
          this._emit();
        },
        onProgress: (bytes, total) => {
          const t = this.now();
          this.installState = { ...this.installState, bytes, total, percent: total ? Math.min(100, Math.floor((bytes / total) * 100)) : null };
          if (t - this._lastProgressEmit > 250) { this._lastProgressEmit = t; this._emit(); }
        },
        revalidate: () => { const v = this._jobValid(job); if (!v.ok) job.cancelReason = v.reason; return v; },
      });
      this.restartVersion = job.parsed;
      this.installState = { phase: 'restart-required', version: job.version, message: `Version ${job.version} is installed. Restart Cloudlog Desktop to use it.` };
      this._reevaluate(true);
    } catch (e) {
      if (e instanceof InstallError && e.code === 'cancelled') {
        this.installState = { phase: 'cancelled', version: job.version, message: `Update not installed: ${job.cancelReason || e.message}` };
      } else {
        const why = e instanceof ChecksumError || e instanceof InstallError || e instanceof AssetError ? e.message : 'An unexpected error stopped the update';
        const tail = e && e.code === 'rollback' ? '' : ' The installed version was not changed.';
        this.installState = { phase: 'failed', version: job.version, message: `Update not installed: ${why}.${tail}`, code: e && e.code };
      }
    } finally {
      this.job = null;
      this._emit();
    }
  }

  restart() {
    if (this.installState.phase !== 'restart-required') return false;
    this.relaunchHook();
    return true;
  }
}

module.exports = { UpdateService, DISABLED_MESSAGE, GITHUB_REPO };
