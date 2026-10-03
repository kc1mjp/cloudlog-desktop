'use strict';
/*
 * Settings > About content. Plain JavaScript with no DOM or Electron dependencies so the renderer loads it as a
 * classic <script> (window.AboutShared), the main process can require() the fixed link table, and node:test can
 * render the markup directly.
 */
(function factory(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AboutShared = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  /** The only URLs the About tab can open. The renderer sends a key; the main process looks the URL up here. */
  const ABOUT_LINKS = Object.freeze({
    cloudlog: Object.freeze({ url: 'https://github.com/magicbug/Cloudlog', label: 'Cloudlog', aria: 'Cloudlog project on GitHub (opens in your browser)' }),
    wavelog: Object.freeze({ url: 'https://github.com/wavelog/wavelog', label: 'WaveLog', aria: 'WaveLog project on GitHub (opens in your browser)' }),
    github: Object.freeze({ url: 'https://github.com/kc1mjp/cloudlog-desktop', label: 'GitHub', aria: 'Cloudlog Desktop source code on GitHub (opens in your browser)' }),
    gpl3: Object.freeze({ url: 'https://github.com/kc1mjp/cloudlog-desktop/blob/master/LICENSE', label: 'GPLv3', aria: 'GPLv3 license text (opens in your browser)' }),
  });

  const FALLBACKS = Object.freeze({ hamlibVersion: 'Not available', rigctld: 'Not configured' });

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

  function link(key) {
    const l = ABOUT_LINKS[key];
    return `<a href="${esc(l.url)}" data-ext="${key}" aria-label="${esc(l.aria)}" rel="noopener noreferrer">${esc(l.label)}</a>`;
  }

  /** Markup for the About card body. `info` = { version, hamlibVersion, rigctld, dataDir }; missing values get neutral fallbacks. */
  function renderAboutBody(info = {}) {
    const rows = [
      ['Version', text(info.version, 'Not available')],
      ['Hamlib Version', text(info.hamlibVersion, FALLBACKS.hamlibVersion)],
      ['Hamlib rigctld', text(info.rigctld, FALLBACKS.rigctld)],
      ['Data Folder', text(info.dataDir, 'Not available')],
    ];
    return `<p class="mb-2">An unofficial desktop companion for ${link('cloudlog')} or ${link('wavelog')}:</p>
      <ul class="mb-3">
        <li>Log contacts with or without a server connection.</li>
        <li>Drive your radio through Hamlib.</li>
        <li>Accept QSOs from other programs.</li>
      </ul>
      <dl class="row mb-3 about-info">${rows.map(([k, v]) => `<dt class="col-sm-4 col-md-3">${esc(k)}:</dt><dd class="col-sm-8 col-md-9 mono text-break">${esc(v)}</dd>`).join('')}</dl>
      <div class="mb-1"><b>Source:</b> ${link('github')}</div>
      <div><b>License:</b> ${link('gpl3')}</div>`;
  }

  return { ABOUT_LINKS, FALLBACKS, renderAboutBody };
});
