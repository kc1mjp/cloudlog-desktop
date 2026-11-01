'use strict';
/*
 * Settings > Updates markup. Plain JavaScript with no DOM or Electron dependencies, so the renderer loads it as a classic
 * <script> (window.UpdatesShared) and node:test can render it for any updater state. All wording lives here (the app has
 * no localization layer yet; every page uses plain English strings).
 *
 * `state` is what the main process returns from updates:state (see src/main/updater/service.js getState()).
 */
(function factory(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UpdatesShared = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CHANNEL_HELP = [
    'Enabling pre-release updates allows release candidates.',
    'Beta releases also require "Allow beta updates".',
    'Alpha releases require "Allow alpha updates", which also turns on beta updates.',
    'Turning beta updates off also turns alpha updates off.',
    'Stable releases are always offered, whatever these settings are.',
  ];

  const STATUS_BADGE = {
    available: ['text-bg-success', 'Update available'],
    skipped: ['text-bg-secondary', 'Skipped'],
    'outside-channels': ['text-bg-warning', 'Outside the enabled update channels'],
  };

  function defaultFormatTime(ms) { try { return new Date(ms).toLocaleString(); } catch { return String(ms); } }

  /** A labelled switch. `help` is always visible; a disabled switch also shows why in `reason`. */
  function sw({ id, pref, label, checked, disabled, reason, help }) {
    const descId = `${id}-desc`;
    return `<div class="mb-3">
      <div class="form-check form-switch mb-0">
        <input class="form-check-input" type="checkbox" role="switch" id="${id}" data-pref="${pref}" aria-describedby="${descId}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <label class="form-check-label" for="${id}">${esc(label)}</label>
      </div>
      <div class="form-text" id="${descId}">${esc(help)}${disabled && reason ? ` <span class="text-warning-emphasis" data-reason="${pref}">${esc(reason)}</span>` : ''}</div>
    </div>`;
  }

  function progressBlock(p) {
    if (!p || p.phase === 'idle') return '';
    const active = ['checksum', 'downloading', 'verifying', 'installing'].includes(p.phase);
    const cls = p.phase === 'failed' ? 'alert-danger' : p.phase === 'restart-required' ? 'alert-success' : p.phase === 'cancelled' ? 'alert-warning' : 'alert-info';
    const pct = Number.isFinite(p.percent) ? Math.max(0, Math.min(100, p.percent)) : null;
    const bar = active && p.phase === 'downloading'
      ? `<div class="progress mt-2" style="height:.6rem"><div class="progress-bar ${pct === null ? 'progress-bar-striped progress-bar-animated' : ''}" role="progressbar" style="width:${pct === null ? 100 : pct}%" ${pct === null ? '' : `aria-valuenow="${pct}"`} aria-valuemin="0" aria-valuemax="100" aria-label="Download progress"></div></div>`
      : '';
    return `<div class="alert ${cls} py-2 px-3 mt-3 mb-0" data-progress="${esc(p.phase)}">${esc(p.message || p.phase)}${pct !== null && p.phase === 'downloading' ? ` (${pct}%)` : ''}${bar}</div>`;
  }

  /** Markup for the whole Updates tab body. opts.formatTime(ms) formats the last-check time. */
  function renderUpdatesBody(state, opts = {}) {
    const fmt = opts.formatTime || defaultFormatTime;
    const s = state.settings; const c = state.controls; const rel = state.release; const chk = state.check; const inst = state.installation;
    const progress = state.progress || { phase: 'idle' };
    const busyJob = ['checksum', 'downloading', 'verifying', 'installing'].includes(progress.phase);
    const off = !s.autoCheck;

    const last = chk.lastCheckAt ? fmt(chk.lastCheckAt) : 'Never';
    const checkLine = `${esc(chk.message || (off ? 'Updates are turned off' : 'Not checked yet'))}`;

    let releaseRow;
    if (!rel) releaseRow = `<span class="text-muted">${off ? 'None shown' : 'No newer version found'}</span>`;
    else {
      const [bcls, btxt] = STATUS_BADGE[rel.status] || ['text-bg-secondary', rel.status];
      releaseRow = `<span class="mono">${esc(rel.version)}</span> <span class="text-muted">(${esc(rel.channelLabel)})</span>
        <span class="badge ${bcls} ms-1" data-release-status="${esc(rel.status)}">${esc(btxt)}</span>
        <div class="mt-1"><a href="${esc(rel.url)}" data-act="open-release" rel="noopener noreferrer" aria-label="Release page for version ${esc(rel.version)} on GitHub (opens in your browser)">Release page on GitHub</a></div>`;
    }

    const canUpdate = !!(rel && rel.install && rel.install.possible) && !busyJob;
    const showSkip = !!(rel && rel.status === 'available') && !off;
    const notifyOnly = !inst.selfUpdate;
    const updateNote = rel && !rel.install.possible && rel.status !== 'outside-channels'
      ? `<div class="form-text" data-update-note>${esc(rel.install.reason)}</div>` : (rel && rel.status === 'outside-channels' ? '<div class="form-text" data-update-note>This release is outside the enabled update channels, so it cannot be installed.</div>' : '');

    const buttons = [
      `<button type="button" class="btn btn-primary btn-sm" data-act="check" ${c.check.disabled ? 'disabled' : ''}><i class="fas fa-arrows-rotate me-1" aria-hidden="true"></i>${chk.inProgress ? 'Checking…' : 'Check for updates'}</button>`,
      !notifyOnly || rel ? `<button type="button" class="btn btn-success btn-sm" data-act="update" ${canUpdate ? '' : 'disabled'}><i class="fas fa-cloud-arrow-down me-1" aria-hidden="true"></i>${rel && rel.status === 'skipped' ? 'Update to skipped version' : 'Update'}</button>` : '',
      showSkip ? `<button type="button" class="btn btn-outline-secondary btn-sm" data-act="skip" ${busyJob ? 'disabled' : ''}>Skip this version</button>` : '',
      busyJob && progress.phase !== 'installing' ? '<button type="button" class="btn btn-outline-danger btn-sm" data-act="cancel">Cancel update</button>' : '',
      progress.phase === 'restart-required' ? '<button type="button" class="btn btn-warning btn-sm" data-act="restart">Restart now</button>' : '',
    ].filter(Boolean).join(' ');

    const offBanner = off ? `<div class="alert alert-warning py-2 px-3" role="status" data-master-off>${esc(c.allowPrerelease.reason)} Your other update settings are kept.</div>` : '';
    const instNote = notifyOnly ? `<div class="form-text" data-install-note>${esc(inst.reason)}</div>` : '';

    return `${offBanner}
    <div class="card mb-3" style="max-width:48rem"><div class="card-header">Cloudlog Desktop updates</div><div class="card-body">
      <dl class="row mb-0 about-info">
        <dt class="col-sm-4">Installed version:</dt><dd class="col-sm-8"><span class="mono" data-installed-version>${esc(state.installed.version)}</span> <span class="badge text-bg-info" data-installed-channel>${esc(state.installed.channelLabel)}</span></dd>
        <dt class="col-sm-4">Installation type:</dt><dd class="col-sm-8"><span data-install-type>${esc(inst.label)}</span>${instNote}</dd>
        <dt class="col-sm-4">Update check:</dt><dd class="col-sm-8"><span data-check-status="${esc(chk.status)}" role="status" aria-live="polite">${checkLine}</span></dd>
        <dt class="col-sm-4">Last checked:</dt><dd class="col-sm-8" data-last-check>${esc(last)}</dd>
        <dt class="col-sm-4">Newest eligible version:</dt><dd class="col-sm-8" data-release>${releaseRow}</dd>
      </dl>
      <div class="d-flex flex-wrap gap-2 mt-3">${buttons}</div>
      ${c.check.disabled && c.check.reason ? `<div class="form-text" data-check-reason>${esc(c.check.reason)}</div>` : ''}
      ${updateNote}
      <div aria-live="polite">${progressBlock(progress)}</div>
    </div></div>

    <div class="card mb-3" style="max-width:48rem"><div class="card-header">Update settings</div><div class="card-body">
      ${sw({ id: 'up-auto-check', pref: 'autoCheck', label: 'Auto check update', checked: s.autoCheck, disabled: false, reason: '', help: 'Master switch for all update features. When off, Cloudlog Desktop does not check for, download or install updates (automatically or by hand). Your other settings are kept.' })}
      <hr>
      ${sw({ id: 'up-prerelease', pref: 'allowPrerelease', label: 'Allow pre-release updates', checked: s.allowPrerelease, disabled: c.allowPrerelease.disabled, reason: c.allowPrerelease.reason, help: 'Also offer release candidates.' })}
      <div class="ms-4">
      ${sw({ id: 'up-beta', pref: 'allowBeta', label: 'Allow beta updates', checked: s.allowBeta, disabled: c.allowBeta.disabled, reason: c.allowBeta.reason, help: 'Also offer beta releases. Turning this off also turns off alpha updates.' })}
      ${sw({ id: 'up-alpha', pref: 'allowAlpha', label: 'Allow alpha updates', checked: s.allowAlpha, disabled: c.allowAlpha.disabled, reason: c.allowAlpha.reason, help: 'Also offer alpha releases. Alpha updates also enable beta updates.' })}
      </div>
      <hr>
      ${sw({ id: 'up-auto-update', pref: 'autoUpdate', label: 'Auto-update', checked: s.autoUpdate, disabled: c.autoUpdate.disabled, reason: c.autoUpdate.reason, help: 'Download, verify and install new versions automatically (AppImage installations only). You are asked to restart; the app is never restarted for you. Skipped versions are never installed automatically.' })}
    </div></div>

    <div class="card mb-3" style="max-width:48rem"><div class="card-header">About update channels</div><div class="card-body small">
      <ul class="mb-0" data-channel-help>${CHANNEL_HELP.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </div></div>
    ${renderDiagnostics(state)}`;
  }

  function renderDiagnostics(state) {
    const d = state.diagnostics || [];
    if (!d.length && !(state.check && state.check.truncated)) return '';
    return `<details class="mb-3" style="max-width:48rem" data-diagnostics><summary class="small text-muted">${d.length} GitHub release${d.length === 1 ? '' : 's'} ignored by the updater${state.check && state.check.truncated ? ' (list truncated)' : ''}</summary>
      <ul class="small mt-2">${d.map((x) => `<li><span class="mono">${esc(x.tag)}</span>: ${esc(x.reason)}</li>`).join('')}</ul></details>`;
  }

  return { CHANNEL_HELP, renderUpdatesBody };
});
