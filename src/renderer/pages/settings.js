'use strict';
(() => {
  const { $, html, raw, api, toast, confirmDialog } = App.util;
  let el; let tab = 'cloudlog'; let models = [];

  const TABS = [['cloudlog', 'Cloudlog', 'fa-cloud'], ['logbooks', 'Logbooks', 'fa-book'], ['radio', 'Radio (CAT)', 'fa-tower-broadcast'], ['adif', 'Incoming ADIF', 'fa-plug'], ['appearance', 'Appearance', 'fa-palette'], ['about', 'About', 'fa-circle-info']];
  const HAMLIB_MODES = ['USB', 'LSB', 'CW', 'CWR', 'AM', 'FM', 'WFM', 'RTTY', 'RTTYR', 'PKTUSB', 'PKTLSB', 'PKTFM'];
  const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const check = (v) => (v ? 'checked' : '');

  function mount(root) {
    el = root;
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    tab = q.get('tab') || tab;
    draw();
    api('rig:models').then((m) => { models = m; const dl = $('#model-list'); if (dl) dl.innerHTML = m.map((x) => html`<option value="${x.id} – ${x.mfg} ${x.model}"></option>`).join(''); });
  }

  function draw() {
    if (!el) return;
    el.innerHTML = html`
      <ul class="nav nav-tabs mb-3">${raw(TABS.map(([id, label, icon]) => html`<li class="nav-item"><a class="nav-link ${id === tab ? 'active' : ''}" href="#" data-tab="${id}"><i class="fas ${icon} me-1"></i>${label}</a></li>`).join(''))}</ul>
      <div id="tab-body"></div>`;
    el.querySelectorAll('[data-tab]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); tab = a.dataset.tab; draw(); }));
    ({ cloudlog: drawCloudlog, logbooks: drawLogbooks, radio: drawRadio, adif: drawAdif, appearance: drawAppearance, about: drawAbout })[tab]();
  }

  async function save(patch, msg = 'Settings saved') {
    try { await api('settings:set', patch); toast(msg); } catch (e) { toast(e.message, 'danger'); }
  }

  // ---- Cloudlog ------------------------------------------------------------------
  function drawCloudlog() {
    const c = App.state.settings.cloudlog; const sy = App.state.settings.sync;
    $('#tab-body').innerHTML = html`
    <div class="row g-3"><div class="col-lg-7"><div class="card"><div class="card-header">Cloudlog server</div><div class="card-body">
      <div class="mb-3"><label class="form-label" for="s-url">Address</label><input id="s-url" class="form-control" placeholder="https://log.example.com" value="${c.url}" spellcheck="false">
        <div class="form-text">The address you open Cloudlog at. Wavelog servers work too.</div></div>
      <div class="mb-3"><label class="form-label" for="s-key">API key</label>
        <div class="input-group"><input id="s-key" type="password" class="form-control mono" value="${c.apiKey}" spellcheck="false" autocomplete="off">
          <button class="btn btn-outline-secondary" id="s-showkey" type="button" aria-label="Show or hide key"><i class="fas fa-eye"></i></button></div>
        <div class="form-text">Create a read/write key in Cloudlog under Admin → API.</div></div>
      <div class="mb-3"><label class="form-label" for="s-style">URL style</label>
        <select id="s-style" class="form-select" style="max-width:20rem"><option value="auto" ${c.urlStyle === 'auto' ? 'selected' : ''}>Detect automatically</option><option value="index" ${c.urlStyle === 'index' ? 'selected' : ''}>With index.php</option><option value="clean" ${c.urlStyle === 'clean' ? 'selected' : ''}>Without index.php</option></select></div>
      <div class="d-flex gap-2 align-items-center"><button class="btn btn-primary" id="s-save">Save</button><button class="btn btn-outline-primary" id="s-test">Save and test connection</button><span id="s-result" class="small"></span></div>
    </div></div></div>
    <div class="col-lg-5"><div class="card"><div class="card-header">Uploading</div><div class="card-body">
      <div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" id="s-instant" ${check(sy.instant !== false)}><label class="form-check-label" for="s-instant">Upload each QSO instantly when online</label></div>
      <div class="form-text mb-2">Off: QSOs stay queued until "Sync now" on the Logbook page, or the automatic retry below.</div>
      <div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" id="s-auto" ${check(sy.auto)}><label class="form-check-label" for="s-auto">Automatically retry the queue</label></div>
      <div class="mb-3 d-flex align-items-center gap-2"><label for="s-int" class="form-label mb-0">Retry every</label><input id="s-int" type="number" min="5" class="form-control form-control-sm" style="width:5rem" value="${sy.intervalSec}"><span>seconds</span></div>
      <div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" id="s-off" ${check(sy.paused)}><label class="form-check-label" for="s-off">Disable uploading entirely (stay fully offline)</label></div>
      <hr>
      <label class="form-label" for="s-sid">Logbook ID</label>
      <div class="input-group"><input id="s-sid" class="form-control" style="max-width:8rem" value="${c.currentStationId || ''}" placeholder="e.g. 1"><button class="btn btn-outline-secondary" id="s-sidsave">Set</button></div>
      <div class="form-text">Normally chosen on the Logbooks page. Enter the station ID by hand if you need to log before the list has loaded.</div>
    </div></div></div></div>`;
    $('#s-showkey').addEventListener('click', () => { const k = $('#s-key'); k.type = k.type === 'password' ? 'text' : 'password'; });
    const collect = () => ({ cloudlog: { url: $('#s-url').value.trim(), apiKey: $('#s-key').value.trim(), urlStyle: $('#s-style').value } });
    $('#s-save').addEventListener('click', () => save(collect()));
    $('#s-test').addEventListener('click', async () => {
      const r = $('#s-result');
      r.textContent = 'Testing…'; r.className = 'small text-muted';
      await api('settings:set', collect());
      const t = await api('cloudlog:test');
      if (t.ok) {
        r.className = 'small text-success';
        r.textContent = `Connected (${t.rights === 'rw' ? 'read/write' : t.rights || 'key valid'}), ${t.stations} logbook${t.stations === 1 ? '' : 's'}`;
        await api('stations:refresh').catch(() => {});
      } else { r.className = 'small text-danger'; r.textContent = t.message; }
    });
    const sy2 = () => save({ sync: { auto: $('#s-auto').checked, intervalSec: Math.max(5, num($('#s-int').value, 20)), instant: $('#s-instant').checked } });
    $('#s-auto').addEventListener('change', sy2); $('#s-int').addEventListener('change', sy2); $('#s-instant').addEventListener('change', sy2);
    $('#s-off').addEventListener('change', (e) => api('sync:setPaused', e.target.checked));
    $('#s-sidsave').addEventListener('click', async () => { await api('stations:setCurrent', $('#s-sid').value.trim() || null); toast('Logbook set'); });
  }

  // ---- Logbooks (choose the current one) ------------------------------------------
  function drawLogbooks() {
    const c = App.state.settings.cloudlog;
    const s = App.state.sync;
    $('#tab-body').innerHTML = html`
    <div class="d-flex align-items-center mb-3 gap-2 flex-wrap">
      <span class="text-muted small">Logbooks are your Cloudlog station profiles. New QSOs from every page go to the current one.</span>
      <button class="btn btn-sm btn-primary ms-auto" id="bk-refresh" ${s.configured ? '' : 'disabled'}><i class="fas fa-rotate me-1"></i>Refresh list</button>
    </div>
    ${raw(c.stations.length ? html`<div class="row g-3">${raw(c.stations.map((b) => html`
      <div class="col-md-6 col-xl-4"><div class="card h-100 ${b.id === String(c.currentStationId) ? 'border-success' : ''}">
        <div class="card-header d-flex justify-content-between"><span class="fw-bold">${b.name}</span>${raw(b.id === String(c.currentStationId) ? '<span class="badge text-bg-success">Current</span>' : '')}</div>
        <div class="card-body"><div class="fs-4 mono">${b.callsign}</div><div class="text-muted">Grid ${b.grid || '—'} · ID ${b.id}${b.active ? '' : ' · inactive'}</div></div>
        <div class="card-footer d-flex gap-2 flex-wrap">
          <button class="btn btn-sm btn-success" data-cur="${b.id}" ${b.id === String(c.currentStationId) ? 'disabled' : ''}>Use for new QSOs</button>
          <a class="btn btn-sm btn-outline-primary" href="#/logbook?id=${b.id}">View QSOs</a>
          <button class="btn btn-sm btn-outline-danger ms-auto" data-clearcache="${b.id}" title="Clear the local offline copy - does not touch the server"><i class="fas fa-broom me-1"></i>Clear local cache</button></div></div></div>`).join(''))}</div>`
      : html`<div class="card"><div class="card-body text-center text-muted py-5">
          <p class="mb-2">${s.configured ? 'No logbooks loaded yet.' : 'Connect to Cloudlog on the Cloudlog tab to load your logbooks.'}</p>
          <p class="small">If you are offline you can type a station ID on the Cloudlog tab.</p></div></div>`)}`;
    $('#bk-refresh')?.addEventListener('click', async () => {
      try { const l = await api('stations:refresh'); toast(`${l.length} logbook${l.length === 1 ? '' : 's'} found`); } catch (e) { toast(e.message, 'danger'); }
    });
    el.querySelectorAll('[data-cur]').forEach((b) => b.addEventListener('click', async () => { await api('stations:setCurrent', b.dataset.cur); toast('Current logbook changed'); }));
    el.querySelectorAll('[data-clearcache]').forEach((b) => b.addEventListener('click', async () => {
      const st = c.stations.find((x) => x.id === b.dataset.clearcache);
      const label = st ? `${st.name} (${st.callsign})` : `logbook #${b.dataset.clearcache}`;
      const ok = await confirmDialog({
        title: 'Clear local cache?',
        body: `This clears the local offline copy of ${label} only - the QSOs already downloaded or uploaded for it. It will re-download from the server the next time this logbook is viewed or refreshed. This does not touch the server, any other logbook, or any QSO of yours that is still queued to upload.`,
        confirmLabel: 'Clear cache',
      });
      if (!ok) return;
      try { await api('log:clearCache', b.dataset.clearcache); toast('Local cache cleared for that logbook'); } catch (e) { toast(e.message, 'danger'); }
    }));
  }

  // ---- Radio ------------------------------------------------------------------------
  let editingRigId = null;

  function drawRadio() {
    const rigsCfg = App.state.settings.rigs;
    const activeId = App.state.settings.activeRigId;
    if (!editingRigId || !rigsCfg.some((r) => r.id === editingRigId)) editingRigId = (rigsCfg.find((r) => r.id === activeId) || rigsCfg[0] || {}).id || null;
    const info = App.state.info.hamlib;
    $('#tab-body').innerHTML = html`
    <div class="d-flex align-items-center gap-2 mb-3 flex-wrap">
      <div class="btn-group flex-wrap" role="group">
        ${raw(rigsCfg.map((r) => html`<button type="button" class="btn btn-sm ${r.id === editingRigId ? 'btn-primary' : r.enabled ? 'btn-outline-primary' : 'btn-outline-secondary text-muted'}" data-pick="${r.id}">${r.label}${r.id === activeId ? ' ★' : ''}${r.enabled ? '' : ' (off)'}</button>`).join(''))}
      </div>
      <button class="btn btn-sm btn-outline-success" id="r-add"><i class="fas fa-plus me-1"></i>Add radio</button>
    </div>
    ${raw(!rigsCfg.length ? '<div class="card"><div class="card-body text-muted">No radios set up yet. Add one to use CAT control.</div></div>' : '<div id="radio-form"></div>')}`;
    $('#r-add').addEventListener('click', async () => {
      const res = await api('rig:add', { label: `Radio ${rigsCfg.length + 1}` });
      App.state.settings = await api('settings:get');
      editingRigId = res.rigs[res.rigs.length - 1].id;
      draw();
    });
    el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { editingRigId = b.dataset.pick; draw(); }));
    if (rigsCfg.length) drawRadioForm();
  }

  function drawRadioForm() {
    const r = App.state.settings.rigs.find((x) => x.id === editingRigId);
    if (!r) return;
    const activeId = App.state.settings.activeRigId;
    const info = App.state.info.hamlib;
    const bauds = [1200, 4800, 9600, 19200, 38400, 57600, 115200];
    const isDummy = Number(r.model) === 1;
    const modelName = () => { const m = models.find((x) => x.id === Number(r.model)); return m ? `${m.id} – ${m.mfg} ${m.model}` : String(r.model); };
    $('#radio-form').innerHTML = html`
    <div class="row g-3"><div class="col-lg-7">
      <div class="card mb-3"><div class="card-header d-flex align-items-center gap-2 flex-wrap">
        <input id="r-label" class="form-control form-control-sm" style="max-width:16rem" value="${r.label}">
        <div class="form-check form-switch mb-0 ms-2"><input class="form-check-input" type="checkbox" id="r-enabled" ${check(r.enabled)}><label class="form-check-label small" for="r-enabled">Enabled</label></div>
        <div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" id="r-active" ${r.id === activeId ? 'checked' : ''}><label class="form-check-label small" for="r-active">Active for logging</label></div>
        <button class="btn btn-sm btn-outline-danger ms-auto" id="r-remove"><i class="fas fa-trash me-1"></i>Remove radio</button>
      </div><div class="card-body">
        ${raw(info.rigctld ? '' : html`<div class="alert alert-warning small">Hamlib was not found on this computer. Install it with <code>sudo apt install libhamlib-utils</code>, then restart the app. Connecting to a radio on another computer (Network) works without it.</div>`)}
        <div class="btn-group mb-3" role="group">
          ${raw([['none', 'Off'], ['serial', 'Serial / USB radio'], ['net', 'Network (rigctld)']].map(([v, l]) => html`<input type="radio" class="btn-check" name="rmode" id="rm-${v}" value="${v}" ${r.mode === v ? 'checked' : ''}><label class="btn btn-outline-primary" for="rm-${v}">${l}</label>`).join(''))}
        </div>
        <div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" id="r-startup" ${check(r.activeOnStartup)}><label class="form-check-label" for="r-startup">Turn on automatically when the app launches</label></div>
        <div id="blk-serial" class="${r.mode === 'serial' ? '' : 'd-none'}">
          <div class="mb-3"><label class="form-label" for="r-model">Radio model</label><input id="r-model" list="model-list" class="form-control" value="${modelName()}" placeholder="Start typing, e.g. FT-991"><datalist id="model-list">${raw(models.map((x) => html`<option value="${x.id} – ${x.mfg} ${x.model}"></option>`).join(''))}</datalist>
            <div class="form-text">Model 1 is Hamlib's dummy radio, handy for trying things out.</div></div>
          <div class="row g-3 mb-3 ${isDummy ? 'd-none' : ''}" id="serial-conn-row">
            <div class="col-md-8"><label class="form-label" for="r-dev">Serial port</label><div class="input-group"><input id="r-dev" list="port-list" class="form-control mono" value="${r.device}" placeholder="/dev/ttyUSB0"><datalist id="port-list"></datalist><button class="btn btn-outline-secondary" id="r-ports" type="button" title="Rescan ports"><i class="fas fa-rotate"></i></button></div></div>
            <div class="col-md-4"><label class="form-label" for="r-baud">Speed (baud)</label><select id="r-baud" class="form-select">${raw(bauds.map((b) => html`<option ${b === Number(r.baud) ? 'selected' : ''}>${b}</option>`).join(''))}</select></div>
          </div>
          <div class="row g-3 mb-3 ${isDummy ? '' : 'd-none'}" id="dummy-defaults-row">
            <div class="col-md-6"><label class="form-label" for="r-defreq">Default frequency (MHz)</label><input id="r-defreq" class="form-control mono" value="${r.defaultFreqMhz || '14.225'}"></div>
            <div class="col-md-6"><label class="form-label" for="r-defmode">Default mode</label><select id="r-defmode" class="form-select">${raw(HAMLIB_MODES.map((m) => html`<option ${m === (r.defaultMode || 'USB') ? 'selected' : ''}>${m}</option>`).join(''))}</select></div>
            <div class="form-text">What the dummy rig starts showing when this connection starts - there's no real hardware to remember a frequency between runs.</div>
          </div>
          <div class="row g-3 mb-3">
            <div class="col-md-4 ${isDummy ? 'd-none' : ''}" id="ptt-col"><label class="form-label" for="r-ptt">PTT method</label><select id="r-ptt" class="form-select">${raw([['', 'Radio default'], ['RIG', 'CAT command'], ['DTR', 'DTR line'], ['RTS', 'RTS line'], ['NONE', 'None']].map(([v, l]) => html`<option value="${v}" ${r.pttType === v ? 'selected' : ''}>${l}</option>`).join(''))}</select></div>
            <div class="${isDummy ? 'col-md-12' : 'col-md-8'}" id="extra-col"><label class="form-label" for="r-conf">Extra Hamlib options</label><input id="r-conf" class="form-control mono" value="${r.extraConf}" placeholder="stop_bits=2,serial_handshake=None"></div>
          </div>
          <details class="mb-2"><summary class="small text-muted">Advanced</summary><div class="mt-2">
            <label class="form-label" for="r-bin">rigctld path</label><input id="r-bin" class="form-control mono" value="${r.rigctldPath}" placeholder="${info.rigctld || 'auto-detect'}">
            <div class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" id="r-forcerts" ${check(r.forceRts)} ${info.forceRts ? '' : 'disabled'}><label class="form-check-label" for="r-forcerts">Force RTS low when this connection starts</label></div>
            <div class="form-text">${info.forceRts ? "For rigs that wire PTT to the serial RTS line: Linux raises RTS the instant the port opens, keying up briefly every time rigctld starts. This clears RTS immediately after opening so it doesn't." : 'force_rts.so was not found in this build, so this option is unavailable.'}</div>
          </div></details>
          <div class="small text-muted">Serial ports need your user to be in the <code>dialout</code> group (<code>sudo usermod -aG dialout $USER</code>, then log in again).</div>
        </div>
        <div id="blk-net" class="${r.mode === 'net' ? '' : 'd-none'}">
          <div class="row g-3"><div class="col-md-8"><label class="form-label" for="r-host">Host</label><input id="r-host" class="form-control" value="${r.host}"></div>
            <div class="col-md-4"><label class="form-label" for="r-port">Port</label><input id="r-port" type="number" class="form-control" value="${r.port}"></div></div>
          <div class="form-text">Any Hamlib rigctld or a program that offers the same protocol (for example WSJT-X's rigctld, or a shack server).</div>
        </div>
        <hr>
        <div class="row g-3 align-items-end">
          <div class="col-md-6"><label class="form-label" for="r-name">Radio name in Cloudlog</label><input id="r-name" class="form-control" value="${r.name}" placeholder="Leave empty to use the label"></div>
          <div class="col-md-6"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="r-upd" ${check(r.updateCloudlog)}><label class="form-check-label" for="r-upd">Send frequency and mode to Cloudlog</label></div></div>
        </div>
      </div></div>
      <div class="card"><div class="card-header">Share this radio (Hamlib network port)</div><div class="card-body">
        <div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" id="rl-on" ${check(r.relay.enabled)}><label class="form-check-label" for="rl-on">Let other programs use this radio through a rigctld-compatible port</label></div>
        <div class="row g-3"><div class="col-md-6"><label class="form-label" for="rl-bind">Listen on</label><select id="rl-bind" class="form-select"><option value="127.0.0.1" ${r.relay.bind === '127.0.0.1' ? 'selected' : ''}>This computer only</option><option value="0.0.0.0" ${r.relay.bind === '0.0.0.0' ? 'selected' : ''}>All network interfaces</option></select></div>
          <div class="col-md-6"><label class="form-label" for="rl-port">Port</label><input id="rl-port" type="number" class="form-control" value="${r.relay.port}"></div></div>
        <div class="form-text">Point WSJT-X, fldigi and similar programs at Hamlib "NET rigctl" with this address. Each radio needs its own port. Opening it to the network lets anyone on it control your radio.</div>
      </div></div>
      <button class="btn btn-primary mt-3" id="r-save"><i class="fas fa-plug me-1"></i>Save and connect</button>
    </div>
    <div class="col-lg-5">
      <div class="card mb-3"><div class="card-header">This radio's CAT status</div><div class="card-body" id="rig-status"></div></div>
      ${raw(App.state.settings.rigs.length > 1 ? html`<div class="card"><div class="card-header">All radios</div><div class="table-responsive"><table class="table table-sm table-tight mb-0" id="rig-all"></table></div></div>` : '')}
    </div></div>`;

    el.querySelectorAll('input[name=rmode]').forEach((i) => i.addEventListener('change', () => { $('#blk-serial').classList.toggle('d-none', i.value !== 'serial'); $('#blk-net').classList.toggle('d-none', i.value !== 'net'); }));
    const applyDummyVisibility = () => {
      const dummy = num(($('#r-model').value.match(/^\s*(\d+)/) || [])[1], 1) === 1;
      $('#serial-conn-row').classList.toggle('d-none', dummy);
      $('#dummy-defaults-row').classList.toggle('d-none', !dummy);
      $('#ptt-col').classList.toggle('d-none', dummy);
      $('#extra-col').classList.toggle('col-md-8', !dummy);
      $('#extra-col').classList.toggle('col-md-12', dummy);
    };
    $('#r-model').addEventListener('input', applyDummyVisibility);
    const scan = async () => { const p = await api('rig:ports'); $('#port-list').innerHTML = p.map((x) => html`<option value="${x}"></option>`).join(''); };
    $('#r-ports')?.addEventListener('click', scan); scan();
    $('#r-remove').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: `Remove "${r.label}"?`, body: 'This stops its connection and any shared Hamlib port.', confirmLabel: 'Remove' });
      if (!ok) return;
      await api('rig:remove', r.id);
      App.state.settings = await api('settings:get');
      editingRigId = null;
      draw();
    });
    $('#r-save').addEventListener('click', async () => {
      const mode = el.querySelector('input[name=rmode]:checked').value;
      const modelId = num(($('#r-model').value.match(/^\s*(\d+)/) || [])[1], 1);
      const port = num($('#rl-port').value, 4532);
      const wasActive = $('#r-active').checked;
      try {
        await api('rig:update', r.id, {
          label: $('#r-label').value.trim() || r.label,
          mode, model: modelId, device: $('#r-dev').value.trim(), baud: num($('#r-baud').value, 9600), pttType: $('#r-ptt').value, extraConf: $('#r-conf').value.trim(),
          defaultFreqMhz: $('#r-defreq').value.trim() || '14.225', defaultMode: $('#r-defmode').value,
          rigctldPath: $('#r-bin').value.trim(), forceRts: $('#r-forcerts').checked, host: $('#r-host').value.trim() || '127.0.0.1', port: num($('#r-port').value, 4532),
          name: $('#r-name').value.trim(), updateCloudlog: $('#r-upd').checked,
          relay: { enabled: $('#rl-on').checked, bind: $('#rl-bind').value, port },
        });
        if (wasActive) await api('rig:setActive', r.id);
        App.state.settings = await api('settings:get');
        toast('Radio settings saved');
        draw();
      } catch (e) { toast(e.message, 'danger'); }
    });
    $('#r-enabled').addEventListener('change', async (e) => {
      try {
        await api('rig:update', r.id, { enabled: e.target.checked });
        App.state.settings = await api('settings:get');
        draw();
      } catch (e2) { toast(e2.message, 'danger'); }
    });
    $('#r-startup').addEventListener('change', async (e) => {
      try {
        await api('rig:update', r.id, { activeOnStartup: e.target.checked });
        App.state.settings = await api('settings:get');
      } catch (e2) { toast(e2.message, 'danger'); }
    });
    $('#r-active').addEventListener('change', async (e) => {
      try {
        await api('rig:setActive', e.target.checked ? r.id : null);
        App.state.settings = await api('settings:get');
        draw();
      } catch (e2) { toast(e2.message, 'danger'); }
    });
    drawRigStatus();
    drawAllRigs();
  }

  function drawRigStatus() {
    const box = $('#rig-status');
    if (!box || !editingRigId) return;
    const s = (App.state.rigs || []).find((x) => x.id === editingRigId);
    if (!s) { box.innerHTML = '<span class="text-muted">Not connected yet - save to start it.</span>'; return; }
    const badge = { connected: ['success', 'Connected'], connecting: ['warning', 'Connecting'], error: ['danger', 'Problem'], idle: ['secondary', 'Off'] }[s.state] || ['secondary', s.state];
    box.innerHTML = html`
      <div class="d-flex align-items-center gap-2 mb-2"><span class="badge text-bg-${badge[0]}">${badge[1]}</span><span class="text-muted">${s.label}</span></div>
      ${raw(s.state === 'connected' && s.freqHz ? html`<div class="freq-readout mb-1">${App.util.fmtFreq(s.freqHz)}</div><div class="mb-2">${s.mode}${s.ptt ? html` <span class="badge text-bg-danger">TX</span>` : ''}</div>` : '')}
      ${raw(s.message ? html`<div class="small ${s.state === 'error' ? 'text-danger' : 'text-muted'}">${s.message}</div>` : '')}
      ${raw(s.forceRtsActive ? '<div class="small text-info mt-1"><i class="fas fa-shield-halved me-1"></i>Force RTS active on this connection</div>' : '')}
      <hr><div class="small"><div class="fw-bold mb-1">Shared Hamlib port</div>
      ${raw(!s.relay.enabled ? '<span class="text-muted">Not shared</span>' : s.relay.listening ? html`<span class="text-success">Listening on ${s.relay.bind}:${s.relay.port}</span> · ${s.relay.clients} connected` : html`<span class="text-danger">${s.relay.error || 'Not listening'}</span>`)}</div>`;
  }

  function drawAllRigs() {
    const box = $('#rig-all');
    if (!box) return;
    const activeId = App.state.settings.activeRigId;
    const rows = (App.state.rigs || []).map((s) => {
      const badge = { connected: 'success', connecting: 'warning', error: 'danger', idle: 'secondary' }[s.state] || 'secondary';
      return html`<tr><td>${s.id === activeId ? '★ ' : ''}${s.label}</td><td><span class="badge text-bg-${badge}">${s.state}</span></td><td class="mono">${s.freqHz ? App.util.fmtFreq(s.freqHz) : ''}</td></tr>`;
    });
    box.innerHTML = html`<tbody>${raw(rows.join(''))}</tbody>`;
  }

  // ---- ADIF -----------------------------------------------------------------------------
  function drawAdif() {
    const a = App.state.settings.adifServer;
    $('#tab-body').innerHTML = html`
    <div class="row g-3"><div class="col-lg-7"><div class="card"><div class="card-header">Receive QSOs from other programs</div><div class="card-body">
      <div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" id="a-on" ${check(a.enabled)}><label class="form-check-label" for="a-on">Log QSOs sent to this app as ADIF</label></div>
      <div class="row g-3 mb-3">
        <div class="col-md-6"><label class="form-label" for="a-bind">Listen on</label><select id="a-bind" class="form-select"><option value="127.0.0.1" ${a.bind === '127.0.0.1' ? 'selected' : ''}>This computer only</option><option value="0.0.0.0" ${a.bind === '0.0.0.0' ? 'selected' : ''}>All network interfaces</option></select></div>
      </div>
      <div class="row g-3 mb-3 align-items-end">
        <div class="col-md-6"><div class="form-check"><input class="form-check-input" type="checkbox" id="a-tcp" ${check(a.tcp)}><label class="form-check-label" for="a-tcp">TCP port</label></div><input id="a-tcpp" type="number" class="form-control" value="${a.tcpPort}"></div>
        <div class="col-md-6"><div class="form-check"><input class="form-check-input" type="checkbox" id="a-udp" ${check(a.udp)}><label class="form-check-label" for="a-udp">UDP port</label></div><input id="a-udpp" type="number" class="form-control" value="${a.udpPort}"></div>
      </div>
      <button class="btn btn-primary" id="a-save">Save</button>
    </div></div></div>
    <div class="col-lg-5"><div class="card mb-3"><div class="card-header">Status</div><div class="card-body small" id="adif-status"></div></div>
      <div class="card"><div class="card-header">How to connect</div><div class="card-body small">
        <p class="mb-2"><b>WSJT-X / JTDX:</b> Settings → Reporting → UDP Server, use this computer's address and the UDP port. Logged QSOs arrive as soon as you confirm them.</p>
        <p class="mb-2"><b>Anything else:</b> send ADIF records ending in <code>&lt;EOR&gt;</code> to the TCP or UDP port, for example <code>nc 127.0.0.1 ${a.tcpPort} &lt; log.adi</code>.</p>
        <p class="mb-0 text-muted">Duplicates that arrive twice within the same minute are ignored.</p></div></div></div></div>`;
    $('#a-save').addEventListener('click', () => save({ adifServer: { enabled: $('#a-on').checked, bind: $('#a-bind').value, tcp: $('#a-tcp').checked, tcpPort: num($('#a-tcpp').value, 2333), udp: $('#a-udp').checked, udpPort: num($('#a-udpp').value, 2333) } }));
    drawAdifStatus();
  }

  function drawAdifStatus() {
    const box = $('#adif-status');
    if (!box) return;
    const s = App.state.adif;
    const line = (n, x) => html`<div>${n}: ${raw(x.listening ? html`<span class="text-success">listening on ${s.bind}:${x.port}</span>` : x.error ? html`<span class="text-danger">${x.error}</span>` : '<span class="text-muted">off</span>')}</div>`;
    box.innerHTML = s.enabled ? html`${raw(line('TCP', s.tcp))}${raw(line('UDP', s.udp))}<div class="mt-2 text-muted">${s.received} QSO(s) received this session</div>` : '<span class="text-muted">The socket is off.</span>';
  }

  // ---- Appearance / About ---------------------------------------------------------------
  function drawAppearance() {
    const cur = App.state.settings.theme;
    $('#tab-body').innerHTML = html`<div class="card" style="max-width:32rem"><div class="card-header">Theme</div><div class="card-body">
      ${raw(Object.entries(App.THEMES).map(([id, name]) => html`<div class="form-check mb-2"><input class="form-check-input" type="radio" name="theme" id="t-${id}" value="${id}" ${id === cur ? 'checked' : ''}><label class="form-check-label" for="t-${id}">${name}</label></div>`).join(''))}
      <div class="form-text">Cerulean matches Cloudlog's default look. The dark themes are easier on the eyes in a dim shack.</div></div></div>`;
    el.querySelectorAll('input[name=theme]').forEach((i) => i.addEventListener('change', async () => { App.applyTheme(i.value); await api('settings:set', { theme: i.value }); }));
  }

  function drawAbout() {
    const i = App.state.info;
    $('#tab-body').innerHTML = html`<div class="card" style="max-width:40rem"><div class="card-header">Cloudlog Desktop</div><div class="card-body small">
      <p>Version ${i.version}. An unofficial desktop companion for Cloudlog: log with or without a connection, drive your radio through Hamlib and take QSOs from other programs.</p>
      <div class="mb-1"><b>Data folder:</b> <span class="mono">${i.dataDir}</span></div>
      <div><b>Hamlib rigctld:</b> <span class="mono">${i.hamlib.rigctld || 'not found'}</span></div></div></div>`;
  }

  App.pages.settings = {
    mount,
    unmount() { el = null; },
    onEvent({ type }) {
      if (!el) return;
      if (type === 'rig' && tab === 'radio' && $('#radio-form')) { drawRigStatus(); drawAllRigs(); }
      if (type === 'adif:status' && tab === 'adif') drawAdifStatus();
      if ((type === 'settings' || type === 'sync') && tab === 'logbooks') drawLogbooks();
    },
  };
})();
