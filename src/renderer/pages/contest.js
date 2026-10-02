'use strict';
(() => {
  const { $, html, raw, api, toast, confirmDialog, TimeFields, followRig, freqToBand, defaultRst, ssbSubmode, requireLogbook, fmtDate } = App.util;
  let el; let time; let followTimer; let dupeTimer; let dupe = null; let armed = false; let follow = true;
  // The keydown handler lives on #page, which outlives this page (and is re-registered by each drawEntry); the disposer removes it.
  const disposer = PageGuards.createDisposer();

  const cfg = () => App.state.settings.contest;
  const def = () => App.state.info.contests.find((c) => c.id === cfg().id) || App.state.info.contests[0];
  const adifId = () => (def().custom ? (cfg().customId || 'OTHER') : def().id);
  const sinceStr = () => new Date(cfg().startedAt).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const patch = (p) => api('settings:set', { contest: p });

  function mount(root) {
    disposer.dispose();
    el = root;
    cfg().startedAt ? drawEntry() : drawSetup();
  }

  // ---- setup ------------------------------------------------------------------
  function drawSetup() {
    disposer.dispose(); // no Enter-to-log on the setup screen
    const c = cfg();
    const d = def();
    el.innerHTML = html`
    <div class="row justify-content-center"><div class="col-lg-6"><div class="card">
      <div class="card-header">Start a contest session</div>
      <div class="card-body">
        <div class="mb-3"><label class="form-label" for="c-id">Contest</label>
          <select id="c-id" class="form-select">${raw(App.state.info.contests.map((x) => html`<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${x.name}</option>`).join(''))}</select></div>
        ${raw(d.custom ? html`<div class="mb-3"><label class="form-label" for="c-custom">Contest ID (ADIF)</label><input id="c-custom" class="form-control mono text-uppercase" value="${c.customId}" placeholder="e.g. ARRL-VHF-JAN"></div>` : '')}
        ${raw(d.sentLabel ? html`<div class="mb-3"><label class="form-label" for="c-sent">${d.sentLabel}</label><input id="c-sent" class="form-control mono text-uppercase" value="${c.sentExchange}"></div>` : '')}
        ${raw(d.sentSerial ? html`<div class="mb-3"><label class="form-label" for="c-serial">First serial number</label><input id="c-serial" type="number" min="1" class="form-control" value="1" style="max-width:8rem"></div>` : '')}
        <p class="text-muted small mb-3">Dupe checking and the score summary only look at QSOs logged after you start the session, so an earlier running of the same contest never gets in the way. QSOs go into your current logbook.</p>
        <button class="btn btn-success" id="c-start"><i class="fas fa-flag-checkered me-1"></i>Start session</button>
      </div></div></div></div>`;
    $('#c-id').addEventListener('change', async (e) => { await patch({ id: e.target.value }); drawSetup(); });
    $('#c-start').addEventListener('click', async () => {
      try {
        requireLogbook();
        const p = { startedAt: Date.now(), serial: d.sentSerial ? Math.max(1, parseInt($('#c-serial').value, 10) || 1) : 1 };
        if (d.custom) p.customId = $('#c-custom').value.trim().toUpperCase();
        if (d.sentLabel) p.sentExchange = $('#c-sent').value.trim().toUpperCase();
        if (d.custom && !p.customId) throw new Error('Enter a contest ID');
        if (d.sentLabel && !p.sentExchange) throw new Error(`Enter ${d.sentLabel.toLowerCase()}`);
        await patch(p);
        drawEntry();
      } catch (e) { toast(e.message, 'danger'); }
    });
  }

  // ---- entry ------------------------------------------------------------------
  function drawEntry() {
    disposer.dispose(); // drawEntry can run again within one mount (e.g. after ending and restarting a session)
    const d = def();
    const c = cfg();
    dupe = null; armed = false;
    el.innerHTML = html`
    <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
      <h5 class="mb-0">${d.custom ? c.customId : d.name}</h5>
      ${raw(d.sentLabel ? html`<span class="badge text-bg-secondary">Sending ${c.sentExchange}</span>` : '')}
      <span class="text-muted small">since ${new Date(c.startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
      <button class="btn btn-sm btn-outline-danger ms-auto" id="c-end">End session</button>
    </div>
    <div class="row g-3">
      <div class="col-xl-8"><div class="card"><div class="card-body">
        <div class="row g-3 mb-3 align-items-end">
          <div class="col-md-4"><label class="form-label" for="c-call">Callsign</label><input id="c-call" class="form-control call-input" autocomplete="off" spellcheck="false" autofocus></div>
          ${raw(d.rst ? html`<div class="col-6 col-md-2"><label class="form-label" for="c-rstr">RST rcvd</label><input id="c-rstr" class="form-control big-input mono" value="59"></div>` : '')}
          ${raw(d.rcvdSerial ? html`<div class="col-6 col-md-2"><label class="form-label" for="c-srx">Serial rcvd</label><input id="c-srx" class="form-control big-input mono" inputmode="numeric"></div>` : '')}
          ${raw(d.rcvdLabel ? html`<div class="col-md-4"><label class="form-label" for="c-ex">${d.rcvdLabel}</label><input id="c-ex" class="form-control big-input mono text-uppercase" autocomplete="off"></div>` : '')}
        </div>
        <div id="c-dupe" class="alert d-none"></div>
        <div class="row g-3 mb-3 align-items-end">
          <div class="col-md-2"><label class="form-label" for="c-mode">Mode</label><select id="c-mode" class="form-select">${raw(App.state.info.modes.map((m) => html`<option>${m}</option>`).join(''))}</select></div>
          <div class="col-md-2"><label class="form-label" for="c-band">Band</label><select id="c-band" class="form-select">${raw(App.state.info.bands.filter((b) => !['2190m', '630m', '560m'].includes(b)).map((b) => html`<option ${b === '20m' ? 'selected' : ''}>${b}</option>`).join(''))}</select></div>
          <div class="col-md-3"><label class="form-label" for="c-freq">Frequency (MHz)</label><input id="c-freq" class="form-control mono" inputmode="decimal"></div>
          <div class="col-md-2"><label class="form-label" for="c-rsts">RST sent</label><input id="c-rsts" class="form-control mono" value="59"></div>
          ${raw(d.sentSerial ? html`<div class="col-md-3"><label class="form-label" for="c-stx">Serial sent</label><input id="c-stx" class="form-control mono" type="number" min="1" value="${c.serial}"></div>` : '')}
        </div>
        <div class="d-flex gap-2 align-items-center flex-wrap">
          <button class="btn btn-success btn-lg" id="c-log"><i class="fas fa-plus me-1"></i>Log QSO</button>
          <div class="form-check form-switch ms-3 mb-0"><input class="form-check-input" type="checkbox" id="c-follow" ${follow ? 'checked' : ''}><label class="form-check-label" for="c-follow">Follow radio</label></div>
          <span class="ms-auto text-muted small"><kbd>Enter</kbd> logs · <kbd>Esc</kbd> clears · dupes ask for a second <kbd>Enter</kbd></span>
        </div>
      </div></div></div>
      <div class="col-xl-4">
        <div class="card mb-3"><div class="card-header">Score</div><div class="card-body" id="c-stats"></div></div>
        <div class="card"><div class="card-header">Last contacts</div><div class="table-responsive"><table class="table table-striped table-tight mb-0" id="c-recent"></table></div></div>
      </div>
    </div>`;

    time = new TimeFields(document.createElement('input'), document.createElement('input'));
    const f = { freq: $('#c-freq'), band: $('#c-band'), mode: $('#c-mode') };
    const sync = () => followRig(App.state.rig, f, follow);
    followTimer = setInterval(sync, 400);
    sync();
    const setRst = () => { $('#c-rsts').value = defaultRst(f.mode.value); if ($('#c-rstr')) $('#c-rstr').value = defaultRst(f.mode.value); };
    setRst();

    $('#c-follow').addEventListener('change', (e) => { follow = e.target.checked; sync(); });
    f.mode.addEventListener('change', () => { setRst(); checkDupe(); });
    f.band.addEventListener('change', checkDupe);
    f.freq.addEventListener('input', () => { const b = freqToBand(f.freq.value); if (b) f.band.value = b; });
    $('#c-call').addEventListener('input', (e) => {
      const v = e.target.value.toUpperCase().replace(/\s/g, '');
      e.target.value = v;
      if (v) time.freeze(); else time.reset();
      clearTimeout(dupeTimer);
      dupeTimer = setTimeout(checkDupe, 120);
    });
    disposer.listen(el, 'keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); log(); }
      if (e.key === 'Escape') clearEntry();
    });
    $('#c-log').addEventListener('click', log);
    $('#c-end').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'End this contest session?', body: 'Logged QSOs stay in your logbook.', confirmLabel: 'End session' });
      if (!ok) return;
      await patch({ startedAt: 0 });
      clearInterval(followTimer);
      drawSetup();
    });
    refreshStats();
  }

  async function checkDupe() {
    const call = ($('#c-call')?.value || '').trim();
    const box = $('#c-dupe');
    if (!box) return;
    dupe = null; armed = false;
    if (call.length >= 3) {
      dupe = await api('contest:dupe', { contestId: cfg().id, call, band: $('#c-band').value, mode: $('#c-mode').value, since: sinceStr() }).catch(() => null);
    }
    if (dupe) { box.className = 'alert alert-danger dupe-banner py-2'; box.textContent = `DUPE — ${call} already logged on ${dupe.band} at ${dupe.time.slice(0, 2)}:${dupe.time.slice(2, 4)} UTC`; }
    else box.className = 'alert d-none';
  }

  async function log() {
    try {
      requireLogbook();
      const d = def();
      const call = $('#c-call').value.trim();
      if (!call) throw new Error('Enter a callsign');
      if (dupe && !armed) { armed = true; $('#c-dupe').textContent += ' — press Enter again to log it anyway'; return; }
      armed = false;
      const mhz = parseFloat($('#c-freq').value);
      const mode = $('#c-mode').value;
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const tv = time.auto ? { QSO_DATE: `${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}`, TIME_ON: `${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}` } : time.values();
      const fields = {
        CALL: call, ...tv, MODE: mode, BAND: $('#c-band').value, FREQ: mhz ? String(mhz) : '',
        CONTEST_ID: adifId(), RST_SENT: $('#c-rsts').value, RST_RCVD: $('#c-rstr') ? $('#c-rstr').value : defaultRst(mode),
      };
      if (mode === 'SSB') fields.SUBMODE = ssbSubmode(App.state.rig, mhz);
      if (d.sentSerial) {
        const n = parseInt($('#c-stx').value, 10);
        if (!n) throw new Error('Serial sent must be a number');
        fields.STX = String(n);
      }
      if (d.sentLabel) fields.STX_STRING = cfg().sentExchange;
      if (d.rcvdSerial) {
        const v = $('#c-srx').value.trim();
        if (!v) throw new Error('Enter the serial number you received');
        fields.SRX = v.replace(/^0+(?=\d)/, '');
      }
      if (d.rcvdLabel) {
        const v = $('#c-ex').value.trim().toUpperCase();
        if (!v && !d.custom) throw new Error(`Enter ${d.rcvdLabel.toLowerCase()}`);
        fields.SRX_STRING = v;
      }
      await api('qso:add', fields, { source: 'Contest' });
      if (d.sentSerial) await patch({ serial: parseInt($('#c-stx').value, 10) + 1 });
      toast(`Logged ${call}`, 'success', 1200);
      clearEntry();
      if (d.sentSerial) $('#c-stx').value = cfg().serial;
      refreshStats();
    } catch (e) { toast(e.message, 'danger'); }
  }

  function clearEntry() {
    for (const id of ['c-call', 'c-srx', 'c-ex']) if ($(`#${id}`)) $(`#${id}`).value = '';
    dupe = null; armed = false;
    $('#c-dupe').className = 'alert d-none';
    time.reset();
    $('#c-call').focus();
  }

  async function refreshStats() {
    if (!$('#c-stats')) return;
    const s = await api('contest:summary', { adifId: adifId(), since: sinceStr() }).catch(() => null);
    if (!s || !$('#c-stats')) return;
    const bands = Object.entries(s.byBand).sort((a, b) => b[1] - a[1]);
    $('#c-stats').innerHTML = html`<div class="d-flex gap-4 mb-2"><div><div class="stat-num">${s.total}</div><div class="text-muted small">QSOs</div></div>
      <div><div class="stat-num">${s.lastHour}</div><div class="text-muted small">last hour</div></div></div>
      <div class="small mono">${raw(bands.map(([b, n]) => html`<span class="badge text-bg-secondary me-1">${b} ${n}</span>`).join(''))}</div>`;
    $('#c-recent').innerHTML = html`<thead><tr><th>UTC</th><th>Call</th><th>Band</th><th>Sent</th><th>Rcvd</th></tr></thead><tbody>${raw(s.recent.map((r) => html`<tr>
      <td>${(r.TIME_ON || '').slice(0, 4)}</td><td class="fw-bold">${r.CALL}</td><td>${r.BAND}</td><td>${r.STX || ''}</td><td>${[r.SRX, r.SRX_STRING].filter(Boolean).join(' ')}</td></tr>`).join(''))}</tbody>`;
  }

  App.pages.contest = {
    mount,
    unmount() { disposer.dispose(); clearInterval(followTimer); clearTimeout(dupeTimer); el = null; },
    tick() { time?.tick(); },
    onEvent({ type }) { if (el && type === 'qso:changed') refreshStats(); },
  };
})();
