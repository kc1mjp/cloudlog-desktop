'use strict';
(() => {
  const { $, html, raw, api, toast, fmtDate, qsoRows, qsoHead, TimeFields, followRig, freqToBand, defaultRst, ssbSubmode, requireLogbook, fmtFreq } = App.util;
  let el; let time; let followTimer; let wbTimer;
  let follow = true;

  const opts = (list, sel) => list.map((v) => html`<option ${v === sel ? 'selected' : ''}>${v}</option>`).join('');

  function mount(root) {
    el = root;
    const { bands, modes } = App.state.info;
    el.innerHTML = html`
    <div class="row g-3">
      <div class="col-xl-8">
        <div class="card">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span>QSO details</span>
            <div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" id="follow" ${follow ? 'checked' : ''}>
              <label class="form-check-label" for="follow">Follow radio</label></div>
          </div>
          <div class="card-body">
            <div class="row g-3 mb-3">
              <div class="col-md-3"><label class="form-label" for="f-date">Date (UTC)</label><input id="f-date" class="form-control mono"></div>
              <div class="col-md-3"><label class="form-label" for="f-time">Time (UTC)</label><input id="f-time" class="form-control mono"></div>
              <div class="col-md-6"><label class="form-label" for="f-call">Callsign</label>
                <input id="f-call" class="form-control call-input" autocomplete="off" spellcheck="false" autofocus></div>
            </div>
            <div class="row g-3 mb-3">
              <div class="col-md-2"><label class="form-label" for="f-mode">Mode</label><select id="f-mode" class="form-select">${raw(opts(modes, 'SSB'))}</select></div>
              <div class="col-md-2"><label class="form-label" for="f-band">Band</label><select id="f-band" class="form-select">${raw(opts(bands.filter((b) => !['2190m', '630m', '560m'].includes(b)), '20m'))}</select></div>
              <div class="col-md-3"><label class="form-label" for="f-freq">Frequency (MHz)</label>
                <div class="input-group"><input id="f-freq" class="form-control mono" inputmode="decimal" placeholder="14.200000">
                  <button class="btn btn-outline-secondary" id="to-radio" type="button" title="Tune the radio to this frequency and mode"><i class="fas fa-tower-broadcast"></i></button></div></div>
              <div class="col-md-2"><label class="form-label" for="f-rsts">RST sent</label><input id="f-rsts" class="form-control mono" value="59"></div>
              <div class="col-md-2"><label class="form-label" for="f-rstr">RST rcvd</label><input id="f-rstr" class="form-control mono" value="59"></div>
              <div class="col-md-1"><label class="form-label" for="f-pwr">Watts</label><input id="f-pwr" class="form-control" inputmode="numeric"></div>
            </div>
            <div class="row g-3 mb-3">
              <div class="col-md-3"><label class="form-label" for="f-name">Name</label><input id="f-name" class="form-control"></div>
              <div class="col-md-3"><label class="form-label" for="f-qth">QTH</label><input id="f-qth" class="form-control"></div>
              <div class="col-md-2"><label class="form-label" for="f-grid">Grid</label><input id="f-grid" class="form-control mono text-uppercase" maxlength="8"></div>
              <div class="col-md-4"><label class="form-label" for="f-comment">Comment</label><input id="f-comment" class="form-control"></div>
            </div>
            <div class="d-flex gap-2 align-items-center">
              <button class="btn btn-success" id="save"><i class="fas fa-plus me-1"></i>Save QSO</button>
              <button class="btn btn-outline-secondary" id="reset" type="button">Clear</button>
              <span class="text-muted small ms-2">Press <kbd>Enter</kbd> in any field to save. Time stops updating once you start typing a callsign.</span>
            </div>
          </div>
        </div>
      </div>
      <div class="col-xl-4">
        <div class="card mb-3"><div class="card-header">Worked before</div><div class="card-body" id="wb"><span class="text-muted">Type a callsign to check your logbook.</span></div></div>
        <div class="card"><div class="card-header">Recent QSOs</div>
          <div class="table-responsive"><table class="table table-striped table-tight mb-0" id="recent-t"></table></div></div>
      </div>
    </div>`;

    time = new TimeFields($('#f-date'), $('#f-time'));
    const f = { freq: $('#f-freq'), band: $('#f-band'), mode: $('#f-mode') };
    $('#follow').addEventListener('change', (e) => { follow = e.target.checked; sync(); });
    const sync = () => followRig(App.state.rig, f, follow);
    followTimer = setInterval(sync, 400);
    sync();

    f.mode.addEventListener('change', () => { $('#f-rsts').value = defaultRst(f.mode.value); $('#f-rstr').value = defaultRst(f.mode.value); });
    f.freq.addEventListener('input', () => { const b = freqToBand(f.freq.value); if (b) f.band.value = b; });
    $('#f-call').addEventListener('input', (e) => {
      const v = e.target.value.toUpperCase().replace(/\s/g, '');
      e.target.value = v;
      if (v) time.freeze(); else time.reset();
      clearTimeout(wbTimer);
      wbTimer = setTimeout(() => checkWorked(v), 250);
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); save(); } });
    $('#save').addEventListener('click', save);
    $('#reset').addEventListener('click', () => clear(true));
    $('#to-radio').addEventListener('click', toRadio);
    refreshRecent();
  }

  async function toRadio() {
    try {
      if (!App.state.activeRigId) throw new Error('No active radio - pick one in Settings > Radio');
      const mhz = parseFloat($('#f-freq').value);
      if (!mhz) throw new Error('Enter a frequency first');
      await api('rig:setFrequency', App.state.activeRigId, mhz * 1e6);
      const m = $('#f-mode').value;
      const hl = m === 'SSB' ? (mhz < 10 ? 'LSB' : 'USB') : m === 'CW' ? 'CW' : m === 'FM' ? 'FM' : m === 'AM' ? 'AM' : m === 'RTTY' ? 'RTTY' : (mhz < 10 ? 'PKTLSB' : 'PKTUSB');
      await api('rig:setMode', App.state.activeRigId, hl).catch(() => {});
      toast(`Radio set to ${fmtFreq(mhz * 1e6)}`, 'info', 1800);
    } catch (e) { toast(e.message, 'danger'); }
  }

  async function checkWorked(call) {
    const box = $('#wb');
    if (!box) return;
    if (call.length < 3) { box.innerHTML = '<span class="text-muted">Type a callsign to check your logbook.</span>'; return; }
    const r = await api('qso:workedBefore', call).catch(() => null);
    if (!box || !r) return;
    if (!r.count) { box.innerHTML = html`<span class="badge text-bg-success">New callsign</span> <span class="text-muted small">not in the loaded logbook</span>`; return; }
    box.innerHTML = html`<div><span class="badge text-bg-warning">Worked ${r.count}×</span> <span class="small">bands: ${r.bands.join(', ')}</span></div>
      <table class="table table-sm mt-2 mb-0 mono">${raw(r.recent.slice(0, 6).map((x) => html`<tr><td>${fmtDate(x.date)}</td><td>${x.band}</td><td>${x.mode}</td></tr>`).join(''))}</table>`;
  }

  async function save() {
    try {
      requireLogbook();
      const call = $('#f-call').value.trim();
      if (!call) throw new Error('Enter a callsign');
      const mhz = parseFloat($('#f-freq').value);
      const mode = $('#f-mode').value;
      const fields = {
        CALL: call, ...time.values(), MODE: mode, BAND: $('#f-band').value, FREQ: mhz ? String(mhz) : '',
        RST_SENT: $('#f-rsts').value, RST_RCVD: $('#f-rstr').value, NAME: $('#f-name').value, QTH: $('#f-qth').value,
        GRIDSQUARE: $('#f-grid').value.toUpperCase(), COMMENT: $('#f-comment').value, TX_PWR: $('#f-pwr').value,
      };
      if (mode === 'SSB') fields.SUBMODE = ssbSubmode(App.state.rig, mhz);
      const r = await api('qso:add', fields, { source: 'Live QSO' });
      toast(`Logged ${r.call}`);
      clear(false);
    } catch (e) { toast(e.message, 'danger'); }
  }

  function clear(all) {
    for (const id of ['f-call', 'f-name', 'f-qth', 'f-grid', 'f-comment']) $(`#${id}`).value = '';
    if (all) { $('#f-pwr').value = ''; }
    time.reset();
    $('#wb').innerHTML = '<span class="text-muted">Type a callsign to check your logbook.</span>';
    $('#f-rsts').value = defaultRst($('#f-mode').value);
    $('#f-rstr').value = defaultRst($('#f-mode').value);
    $('#f-call').focus();
  }

  async function refreshRecent() {
    const s = await api('log:stats').catch(() => null);
    const t = $('#recent-t');
    if (!t || !s) return;
    t.innerHTML = html`<thead><tr><th>UTC</th><th>Call</th><th>Band</th><th>Mode</th><th></th></tr></thead><tbody>${raw(s.recent.slice(0, 8).map((r) =>
      html`<tr><td>${fmtDate(r.QSO_DATE).slice(5)} ${(r.TIME_ON || '').slice(0, 4)}</td><td class="fw-bold">${r.CALL}</td><td>${r.BAND}</td><td>${r.MODE}</td><td>${raw(App.util.stateIcon(r))}</td></tr>`).join(''))}</tbody>`;
  }

  App.pages.live = {
    mount,
    unmount() { clearInterval(followTimer); clearTimeout(wbTimer); el = null; },
    tick() { time?.tick(); },
    onEvent({ type }) { if (el && type === 'qso:changed') refreshRecent(); },
  };
})();
