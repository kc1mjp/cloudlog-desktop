'use strict';
(() => {
  const { $, html, raw, api, toast, fmtDate, TimeFields, followRig, freqToBand, defaultRst, ssbSubmode, requireLogbook, fmtFreq } = App.util;
  const TYPES = ['SOTA', 'POTA', 'WWFF', 'IOTA'];
  let el; let time; let followTimer; let wbTimer;
  let count = 0; // QSOs logged since this window opened
  let follow = true;
  let dupe = null;
  // mount() registers its page-wide keydown handler on #page, which outlives the page; the disposer removes it on unmount.
  const disposer = PageGuards.createDisposer();
  const saver = PageGuards.createSingleFlight(); // at most one save in progress; released on success or failure
  let session = null; // identifies the current mount, so a save that finishes after navigation leaves the new page alone

  /** ADIF fields for a programme reference; `my` selects the MY_ variants. */
  function refFields(type, ref, my) {
    const r = (ref || '').trim().toUpperCase();
    if (!r || !type) return {};
    const p = my ? 'MY_' : '';
    switch (type) {
      case 'SOTA': return { [`${p}SOTA_REF`]: r };
      case 'POTA': return { [`${p}POTA_REF`]: r, [`${p}SIG`]: 'POTA', [`${p}SIG_INFO`]: r };
      case 'WWFF': return { [`${p}SIG`]: 'WWFF', [`${p}SIG_INFO`]: r, [`${p}WWFF_REF`]: r };
      case 'IOTA': return { [my ? 'MY_IOTA' : 'IOTA']: r };
      default: return {};
    }
  }

  const q = () => App.state.settings.quick;
  const save = (patch) => api('settings:set', { quick: patch });
  const typeOpts = (sel) => TYPES.map((t) => html`<option ${t === sel ? 'selected' : ''}>${t}</option>`).join('');

  function mount(root) {
    disposer.dispose();
    el = root;
    session = {};
    dupe = null;
    const s = q();
    const modes = ['SSB', 'CW', 'FM', 'FT8', 'AM'];
    el.innerHTML = html`
    <div class="row g-3 justify-content-center">
      <div class="col-xl-8">
        <div class="card">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span>Quick log <span class="text-muted small ms-2">SOTA · POTA · WWFF · IOTA and everyday contacts</span></span>
            <span class="badge text-bg-primary" id="count">0 this session</span>
          </div>
          <div class="card-body">
            <div class="row g-3 mb-3 align-items-end">
              <div class="col-md-4 seg">
                <label class="form-label d-block">I am</label>
                <div class="btn-group w-100" role="group">
                  <input type="radio" class="btn-check" name="role" id="r-act" value="activator" ${s.role === 'activator' ? 'checked' : ''}><label class="btn btn-outline-primary" for="r-act">Activating</label>
                  <input type="radio" class="btn-check" name="role" id="r-hun" value="hunter" ${s.role === 'hunter' ? 'checked' : ''}><label class="btn btn-outline-primary" for="r-hun">Hunting</label>
                </div>
              </div>
              <div class="col-md-8" id="my-block">
                <label class="form-label" for="my-ref">My reference</label>
                <div class="input-group"><select id="my-type" class="form-select" style="max-width:7rem">${raw(typeOpts(s.myType))}</select>
                  <input id="my-ref" class="form-control mono text-uppercase" placeholder="K-1234 or W7W/LC-001" value="${s.myRef}"></div>
              </div>
            </div>
            <hr>
            <div class="row g-3 mb-3">
              <div class="col-md-7"><label class="form-label" for="q-call">Callsign</label>
                <input id="q-call" class="form-control call-input" autocomplete="off" spellcheck="false" autofocus></div>
              <div class="col-md-5"><label class="form-label" for="their-ref">Their reference <span class="text-muted">(optional)</span></label>
                <div class="input-group"><select id="their-type" class="form-select" style="max-width:6.5rem">${raw(typeOpts(s.theirType))}</select>
                  <input id="their-ref" class="form-control mono text-uppercase"></div></div>
            </div>
            <div id="dupe" class="alert alert-warning dupe-banner py-2 d-none"></div>
            <div class="row g-3 mb-3 align-items-end">
              <div class="col-6 col-md-2"><label class="form-label" for="q-rsts">RST sent</label><input id="q-rsts" class="form-control big-input mono" value="59"></div>
              <div class="col-6 col-md-2"><label class="form-label" for="q-rstr">RST rcvd</label><input id="q-rstr" class="form-control big-input mono" value="59"></div>
              <div class="col-md-2"><label class="form-label" for="q-mode">Mode</label><select id="q-mode" class="form-select big-input">${raw(modes.concat(App.state.info.modes.filter((m) => !modes.includes(m))).map((m) => html`<option>${m}</option>`).join(''))}</select></div>
              <div class="col-md-2"><label class="form-label" for="q-band">Band</label><select id="q-band" class="form-select big-input">${raw(App.state.info.bands.filter((b) => !['2190m', '630m', '560m'].includes(b)).map((b) => html`<option ${b === '20m' ? 'selected' : ''}>${b}</option>`).join(''))}</select></div>
              <div class="col-md-4"><label class="form-label" for="q-freq">Frequency (MHz)</label><input id="q-freq" class="form-control big-input mono" inputmode="decimal"></div>
            </div>
            <div class="row g-3 mb-3">
              <div class="col-md-4"><input id="q-name" class="form-control" placeholder="Name (optional)"></div>
              <div class="col-md-8"><input id="q-comment" class="form-control" placeholder="Comment (optional)"></div>
            </div>
            <div class="d-flex gap-2 align-items-center flex-wrap">
              <button class="btn btn-success btn-lg" id="q-save"><i class="fas fa-bolt me-1"></i>Log it</button>
              <button class="btn btn-outline-secondary" id="q-clear" type="button">Clear</button>
              <div class="form-check form-switch ms-3 mb-0"><input class="form-check-input" type="checkbox" id="q-follow" ${follow ? 'checked' : ''}><label class="form-check-label" for="q-follow">Follow radio</label></div>
              <span class="ms-auto text-muted small"><kbd>Enter</kbd> logs · <kbd>Esc</kbd> clears</span>
            </div>
          </div>
        </div>
      </div>
      <div class="col-xl-4"><div class="card"><div class="card-header">Just logged</div>
        <ul class="list-group list-group-flush" id="just"></ul></div></div>
    </div>`;

    // No visible clock on this page: hidden inputs hold the time captured when a callsign is first typed.
    time = new TimeFields(document.createElement('input'), document.createElement('input'));
    const f = { freq: $('#q-freq'), band: $('#q-band'), mode: $('#q-mode') };
    const sync = () => followRig(App.state.rig, f, follow);
    followTimer = setInterval(sync, 400);
    sync();
    showRole();

    $('#q-follow').addEventListener('change', (e) => { follow = e.target.checked; sync(); });
    el.querySelectorAll('input[name=role]').forEach((r) => r.addEventListener('change', () => { save({ role: r.value }); q().role = r.value; showRole(); }));
    $('#my-type').addEventListener('change', (e) => { save({ myType: e.target.value, theirType: e.target.value }); $('#their-type').value = e.target.value; });
    $('#my-ref').addEventListener('change', (e) => save({ myRef: e.target.value.trim().toUpperCase() }));
    $('#their-type').addEventListener('change', (e) => save({ theirType: e.target.value }));
    f.mode.addEventListener('change', () => { $('#q-rsts').value = defaultRst(f.mode.value); $('#q-rstr').value = defaultRst(f.mode.value); checkDupe(); });
    f.band.addEventListener('change', checkDupe);
    f.freq.addEventListener('input', () => { const b = freqToBand(f.freq.value); if (b) f.band.value = b; });
    $('#q-call').addEventListener('input', (e) => {
      const v = e.target.value.toUpperCase().replace(/\s/g, '');
      e.target.value = v;
      if (v) time.freeze(); else time.reset();
      clearTimeout(wbTimer);
      wbTimer = setTimeout(checkDupe, 200);
    });
    disposer.listen(el, 'keydown', (e) => {
      if (PageGuards.isLogEnter(e)) { e.preventDefault(); log(); }
      if (e.key === 'Escape') clear();
    });
    $('#q-save').addEventListener('click', log);
    $('#q-clear').addEventListener('click', clear);
    renderJust();
  }

  function showRole() {
    const hunter = q().role === 'hunter';
    $('#my-block').classList.toggle('d-none', hunter);
    $('#their-ref').placeholder = hunter ? 'Reference of the station you are hunting' : 'Summit-to-summit / park-to-park';
  }

  async function checkDupe() {
    const call = ($('#q-call')?.value || '').trim();
    const box = $('#dupe');
    if (!box) return;
    dupe = null;
    if (call.length >= 3) {
      // Read the form before awaiting: the page may have been left (its fields gone) by the time the lookup returns.
      const band = $('#q-band').value; const mode = $('#q-mode').value;
      const r = await api('qso:workedBefore', call).catch(() => null);
      const today = App.util.utcNow().date.replace(/-/g, '');
      dupe = r && r.count ? r.recent.find((x) => x.date === today && x.band === band && x.mode === mode) : null;
      if (!dupe && r && r.count) {
        box.className = 'alert alert-info py-2 small';
        box.textContent = `Worked before ${r.count}× (${r.bands.join(', ')}), last ${fmtDate(r.last.date)}`;
        return;
      }
    }
    if (dupe) { box.className = 'alert alert-warning dupe-banner py-2'; box.textContent = `Already logged today on ${dupe.band} ${dupe.mode}. Enter again to log anyway.`; }
    else box.className = 'alert d-none';
  }

  let armed = false; // second Enter on a dupe logs it
  // Canonical save path: the Enter key and the Log it button both end up here.
  function log() { return saver.run(doLog); }

  async function doLog() {
    const mounted = session;
    try {
      requireLogbook();
      const call = $('#q-call').value.trim();
      if (!call) throw new Error('Enter a callsign');
      if (dupe && !armed) { armed = true; return; }
      armed = false;
      const s = q();
      const mhz = parseFloat($('#q-freq').value);
      const mode = $('#q-mode').value;
      const band = $('#q-band').value; const theirRef = $('#their-ref').value.toUpperCase();
      const t = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const tv = time.auto || !time.dateEl.value
        ? { QSO_DATE: `${t.getUTCFullYear()}${p2(t.getUTCMonth() + 1)}${p2(t.getUTCDate())}`, TIME_ON: `${p2(t.getUTCHours())}${p2(t.getUTCMinutes())}${p2(t.getUTCSeconds())}` }
        : time.values();
      const fields = {
        CALL: call, ...tv, MODE: mode, BAND: band, FREQ: mhz ? String(mhz) : '',
        RST_SENT: $('#q-rsts').value, RST_RCVD: $('#q-rstr').value, NAME: $('#q-name').value, COMMENT: $('#q-comment').value,
        ...(s.role === 'activator' ? refFields(s.myType, $('#my-ref').value, true) : {}),
        ...refFields($('#their-type').value, $('#their-ref').value, false),
      };
      if (mode === 'SSB') fields.SUBMODE = ssbSubmode(App.state.rig, mhz);
      const r = await api('qso:add', fields, { source: 'Quick log' });
      // Everything the form held was read above, so nothing here depends on the page still being mounted.
      count += 1;
      justLogged.unshift(`${r.call} · ${band} ${mode}${theirRef ? ` · ${theirRef}` : ''}`);
      justLogged.length = Math.min(justLogged.length, 12);
      if (session !== mounted) return;
      $('#count').textContent = `${count} this session`;
      renderJust();
      clear();
    } catch (e) { toast(e.message, 'danger'); }
  }

  const justLogged = [];
  function renderJust() {
    const ul = $('#just');
    if (!ul) return;
    ul.innerHTML = justLogged.length ? justLogged.map((j) => html`<li class="list-group-item mono">${j}</li>`).join('') : '<li class="list-group-item text-muted">Nothing logged yet</li>';
  }

  function clear() {
    for (const id of ['q-call', 'their-ref', 'q-name', 'q-comment']) $(`#${id}`).value = '';
    armed = false; dupe = null;
    $('#dupe').className = 'alert d-none';
    $('#q-rsts').value = defaultRst($('#q-mode').value);
    $('#q-rstr').value = defaultRst($('#q-mode').value);
    time.reset();
    $('#q-call').focus();
  }

  App.pages.quick = {
    mount,
    unmount() { disposer.dispose(); session = null; clearInterval(followTimer); clearTimeout(wbTimer); el = null; },
    tick() { time?.tick(); },
    onEvent() {},
  };
})();
