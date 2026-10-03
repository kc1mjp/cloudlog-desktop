'use strict';
(() => {
  const { $, $$, html, api, toast, fmtFreq } = App.util;
  const ROUTES = ['dashboard', 'live', 'quick', 'contest', 'logbook', 'settings'];
  const THEMES = { cerulean: 'Cerulean (light)', darkly: 'Darkly (dark)', cyborg: 'Cyborg (dark)' };
  App.THEMES = THEMES;

  function applyTheme(name) {
    const t = THEMES[name] ? name : 'cerulean';
    $('#theme-css').setAttribute('href', `vendor/${t}.css`);
    const dark = t !== 'cerulean';
    document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
    $('#topnav').className = `navbar navbar-expand navbar-dark ${dark ? 'bg-body-tertiary border-bottom' : 'bg-primary'} px-3`;
  }
  App.applyTheme = applyTheme;

  // ---- header chips -----------------------------------------------------------
  function renderChips() {
    const { settings, rig, sync } = App.state;
    const st = App.util.currentStation();
    $('#chip-logbook').innerHTML = st
      ? html`<i class="fas fa-book"></i><span>${st.name}</span><span class="label-long text-white-50">${st.callsign}</span>`
      : (settings.cloudlog.currentStationId ? html`<i class="fas fa-book"></i><span>Logbook #${settings.cloudlog.currentStationId}</span>` : html`<i class="fas fa-book"></i><span>No logbook</span>`);

    let dot = ''; let text = 'No radio';
    if (rig) {
      if (rig.state === 'connected' && rig.freqHz) { dot = 'ok'; text = `${fmtFreq(rig.freqHz)} ${rig.mode || ''}${rig.ptt ? ' TX' : ''}`; }
      else if (rig.state === 'connected') { dot = 'warn'; text = rig.message || 'Rig not responding'; }
      else if (rig.state === 'connecting') { dot = 'warn'; text = 'CAT connecting…'; }
      else if (rig.state === 'error') { dot = 'bad'; text = 'CAT error'; }
      else { dot = ''; text = 'CAT off'; }
    } else if (App.state.rigs && App.state.rigs.length) {
      text = 'Pick active radio';
    }
    const extra = App.state.rigs && App.state.rigs.length > 1 ? html` <span class="label-long text-white-50">(${rig ? rig.label : ''} · ${App.state.rigs.length} radios)</span>` : '';
    $('#chip-rig').innerHTML = html`<span class="dot ${dot}"></span><span class="mono">${text}</span>${extra}`;
    $('#chip-rig').title = rig ? (rig.message || `${rig.label || rig.rigName || 'Radio'} - click for radio settings`) : 'Click to set up a radio';

    if (sync) {
      let d = 'warn'; let t = 'Not connected';
      if (!sync.configured) { d = ''; t = 'Not set up'; }
      else if (sync.paused) { d = 'warn'; t = 'Offline mode'; }
      else if (sync.syncing) { d = 'warn'; t = 'Uploading…'; }
      else if (sync.online === false) { d = 'bad'; t = 'Offline'; }
      else if (sync.online) { d = 'ok'; t = 'Online'; }
      const q = sync.pending + sync.failed;
      $('#chip-sync').innerHTML = html`<span class="dot ${d}"></span><span>${t}</span>${q ? App.util.raw(html`<span class="badge text-bg-${sync.failed ? 'danger' : 'warning'}">${q}</span>`) : ''}`;
      $('#chip-sync').title = sync.lastError || (q ? `${q} QSO(s) waiting - click to review` : 'All QSOs uploaded');
    }
  }
  App.renderChips = renderChips;

  // ---- routing ------------------------------------------------------------------
  function route() {
    const name = (location.hash.replace(/^#\//, '').split('?')[0]) || 'dashboard';
    const r = ROUTES.includes(name) ? name : 'dashboard';
    if (App.current) { App.pages[App.current].unmount?.(); }
    App.current = r;
    App.util.cleanupStrayModalArtifacts();
    $$('#mainnav .nav-link').forEach((a) => a.classList.toggle('active', a.dataset.route === r));
    $('#btn-settings').classList.toggle('active', r === 'settings');
    const el = $('#page');
    el.innerHTML = '';
    App.pages[r].mount(el);
  }

  function setRigState(data) {
    App.state.rigs = data.rigs || [];
    App.state.activeRigId = data.activeId || null;
    App.state.rig = App.state.rigs.find((r) => r.id === App.state.activeRigId) || null;
  }
  App.setRigState = setRigState;

  function onEvent({ type, data }) {
    if (type === 'rig') setRigState(data);
    else if (type === 'sync') App.state.sync = data;
    else if (type === 'settings') { App.state.settings = data; applyTheme(data.theme); }
    else if (type === 'adif:status') App.state.adif = data;
    else if (type === 'adif:received') {
      if (data.count) toast(`Received ${data.count} QSO${data.count > 1 ? 's' : ''} via ${data.source}: ${data.calls.slice(0, 4).join(', ')}`, 'info');
      data.errors.forEach((e) => toast(`Skipped incoming QSO - ${e}`, 'warning'));
    } else if (type === 'log:progress') toast(`Downloaded ${data.added} QSOs…`, 'info', 1500);
    renderChips();
    if (App.current) App.pages[App.current].onEvent?.({ type, data });
  }

  function clock() {
    const n = App.util.utcNow();
    $('#clock').textContent = `${n.time}Z`;
    App.pages[App.current]?.tick?.();
  }

  // The main process reads the saved address, validates it (http/https only) and opens it in the default browser.
  async function openServer() {
    try {
      const r = await api('external:cloudlog');
      if (r && !r.ok) toast(r.message || 'Configure a valid Cloudlog address in Settings before opening it.', 'warning');
    } catch (e) { toast(e.message, 'danger'); }
  }

  async function init() {
    window.cl.on(onEvent);
    const [settings, rigData, sync, adif, info] = await Promise.all([api('settings:get'), api('rig:status'), api('sync:status'), api('adif:status'), api('app:info')]);
    Object.assign(App.state, { settings, sync, adif, info });
    setRigState(rigData);
    applyTheme(settings.theme);
    renderChips();
    $('#chip-logbook').addEventListener('click', () => { location.hash = '#/settings?tab=logbooks'; });
    $('#chip-rig').addEventListener('click', () => { location.hash = '#/settings?tab=radio'; });
    $('#chip-sync').addEventListener('click', () => { location.hash = '#/logbook'; });
    $('#open-server').addEventListener('click', openServer);
    $('#btn-settings').addEventListener('click', () => { location.hash = '#/settings'; });
    window.addEventListener('hashchange', route);
    setInterval(clock, 500);
    clock();
    route();
  }

  init().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<pre class="p-3 text-danger">Startup failed: ${e.message}</pre>`); });
})();
