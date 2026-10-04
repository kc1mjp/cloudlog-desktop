'use strict';
(() => {
  const { $, html, raw, api, toast, qsoRows, qsoHead, fmtDate, fmtTime } = App.util;

  // ============================ Logbook (QSO list + upload queue) ================
  const COLUMNS = ['grid', 'country']; // Date, UTC, Call, Band, Mode, RST, Grid, Country
  let el; let page = 1; let filters = { q: '', band: '', mode: '' }; let searchTimer; let sel = null;
  let downloadUnsupported = false; // sticky for this session once the server tells us it has no get_contacts_adif

  function mount(root) {
    el = root;
    document.body.classList.add('fill-viewport'); // Logbook sizes itself to the window: only the table scrolls (see styles.css)
    const { settings, info } = App.state;
    const c = settings.cloudlog;
    const query = new URLSearchParams(location.hash.split('?')[1] || '');
    sel = query.get('id') || c.currentStationId;
    page = 1;
    el.innerHTML = html`
    <div id="queue"></div>
    <div class="card" id="lb-card">
      <div class="card-header d-flex flex-wrap gap-2 align-items-center">
        <span class="me-2">Logbook</span>
        <select id="lb-station" class="form-select form-select-sm" style="width:auto">${raw(c.stations.length ? c.stations.map((s) => html`<option value="${s.id}" ${s.id === String(sel) ? 'selected' : ''}>${s.name} (${s.callsign})</option>`).join('') : html`<option value="${sel || ''}">${sel ? `Logbook #${sel}` : 'No logbook'}</option>`)}</select>
        <input id="lb-q" class="form-control form-control-sm" style="width:12rem" placeholder="Search call, name, ref…" value="${filters.q}">
        <select id="lb-band" class="form-select form-select-sm" style="width:auto"><option value="">All bands</option>${raw(info.bands.map((b) => html`<option ${filters.band === b ? 'selected' : ''}>${b}</option>`).join(''))}</select>
        <select id="lb-mode" class="form-select form-select-sm" style="width:auto"><option value="">All modes</option>${raw(info.modes.map((m) => html`<option ${filters.mode === m ? 'selected' : ''}>${m}</option>`).join(''))}</select>
        <div class="ms-auto d-flex gap-2 align-items-center">
          <span class="small text-muted" id="lb-info"></span>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-primary" id="lb-refresh"><i class="fas fa-rotate me-1"></i>Update from server</button>
            <button class="btn btn-primary dropdown-toggle dropdown-toggle-split" data-bs-toggle="dropdown" aria-label="More update options"></button>
            <ul class="dropdown-menu dropdown-menu-end"><li><a class="dropdown-item" href="#" id="lb-full">Download everything again</a></li></ul>
          </div>
        </div>
      </div>
      <div id="lb-unsupported" class="alert alert-warning small mb-0 rounded-0 d-none border-start-0 border-end-0"></div>
      <div class="table-responsive lb-scroll"><table class="table table-striped table-hover table-tight mb-0">${raw(qsoHead(COLUMNS))}<tbody id="lb-body"></tbody></table></div>
      <div class="card-footer d-flex flex-wrap gap-2 justify-content-between align-items-center">
        <span class="small text-muted" id="lb-count"></span>
        <div class="btn-group btn-group-sm" role="group" aria-label="Logbook pages"><button type="button" class="btn pager-btn" id="lb-prev">Previous</button><button type="button" class="btn pager-btn" id="lb-next">Next</button></div>
      </div>
    </div>`;

    $('#lb-station').addEventListener('change', (e) => { sel = e.target.value; page = 1; load(); });
    $('#lb-q').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filters.q = e.target.value; page = 1; load(); }, 200); });
    $('#lb-band').addEventListener('change', (e) => { filters.band = e.target.value; page = 1; load(); });
    $('#lb-mode').addEventListener('change', (e) => { filters.mode = e.target.value; page = 1; load(); });
    $('#lb-prev').addEventListener('click', () => { if (page > 1) { page -= 1; load(); } });
    $('#lb-next').addEventListener('click', () => { page += 1; load(); });
    $('#lb-refresh').addEventListener('click', () => refresh(false));
    $('#lb-full').addEventListener('click', (e) => { e.preventDefault(); refresh(true); });
    applyDownloadState();
    load();
    drawQueue();
  }

  function applyDownloadState() {
    const btn = $('#lb-refresh');
    const grp = btn?.closest('.btn-group');
    const warn = $('#lb-unsupported');
    if (!btn || !warn) return;
    btn.disabled = downloadUnsupported;
    grp?.querySelector('.dropdown-toggle')?.classList.toggle('disabled', downloadUnsupported);
    btn.title = downloadUnsupported ? "This Cloudlog server doesn't support logbook download" : '';
    warn.classList.toggle('d-none', !downloadUnsupported);
    if (downloadUnsupported) warn.textContent = "This Cloudlog server doesn't offer logbook download (that's a Wavelog-only API). QSOs you log from this app still upload normally - you just won't see the server's history here.";
  }

  async function refresh(full) {
    const btn = $('#lb-refresh');
    btn.disabled = true;
    try {
      if (!App.state.sync.configured) throw new Error('Connect to Cloudlog in Settings first');
      const r = await api('log:refresh', sel, { full });
      toast(r.added ? `Downloaded ${r.added} QSO${r.added > 1 ? 's' : ''}` : 'Logbook is up to date', 'success');
      await load();
    } catch (e) {
      if (/doesn't support downloading|does not offer QSO download/.test(e.message)) {
        downloadUnsupported = true;
        toast(e.message, 'warning', 9000);
      } else toast(e.message, 'danger');
    } finally { applyDownloadState(); if (btn) btn.disabled = downloadUnsupported; }
  }

  async function load() {
    if (!el) return;
    const r = await api('log:query', { stationId: sel, ...filters, page, pageSize: 50 }).catch((e) => { toast(e.message, 'danger'); return null; });
    if (!r || !el) return;
    $('#lb-body').innerHTML = qsoRows(r.rows.map((x) => ({ ...x })), COLUMNS);
    const from = r.total ? (r.page - 1) * r.pageSize + 1 : 0;
    $('#lb-count').textContent = `${from}–${Math.min(r.total, r.page * r.pageSize)} of ${r.total}`;
    $('#lb-prev').disabled = r.page <= 1;
    $('#lb-next').disabled = r.page * r.pageSize >= r.total;
    $('#lb-info').textContent = r.fetchedAt ? `Server data from ${new Date(r.fetchedAt).toLocaleString()}` : (downloadUnsupported ? 'Showing QSOs logged from this app only' : 'Not downloaded yet');
    if (!r.fetchedAt && !r.total) {
      $('#lb-body').innerHTML = downloadUnsupported
        ? html`<tr><td colspan="9" class="text-center text-muted py-4">Nothing logged in this logbook from this app yet. This server doesn't support downloading its existing history.</td></tr>`
        : html`<tr><td colspan="9" class="text-center text-muted py-4">This logbook has not been downloaded yet. Use <b>Update from server</b>.</td></tr>`;
    }
  }

  let queueList = [];

  async function drawQueue() {
    const box = $('#queue');
    if (!box) return;
    queueList = await api('local:list', ['pending', 'failed']).catch(() => []);
    const s = App.state.sync;
    box.innerHTML = html`<div class="card mb-3 ${queueList.length ? 'border-warning' : ''}"><div class="card-header d-flex align-items-center gap-2 flex-wrap">
      <span>Upload queue ${raw(queueList.length ? html`<span class="badge text-bg-warning">${queueList.length}</span>` : '<span class="badge text-bg-success">empty</span>')}</span>
      <span class="small text-muted">${s.lastError}</span>
      <div class="ms-auto d-flex gap-2 align-items-center flex-wrap">
        <div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" id="q-instant" ${App.state.settings.sync.instant !== false ? 'checked' : ''}><label class="form-check-label small" for="q-instant">Instant upload</label></div>
        <div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" id="q-offline" ${s.paused ? 'checked' : ''}><label class="form-check-label small" for="q-offline">Disable uploading</label></div>
        <button class="btn btn-sm btn-primary" id="q-now" ${s.configured ? '' : 'disabled'}><i class="fas fa-cloud-arrow-up me-1"></i>Sync now</button>
        ${raw(s.failed ? '<button class="btn btn-sm btn-outline-warning" id="q-retry">Retry failed</button>' : '')}
        <button class="btn btn-sm btn-outline-secondary" id="q-export">Save as ADIF…</button>
      </div></div>
      ${raw(queueList.length ? html`<div class="table-responsive"><table class="table table-tight mb-0"><tbody>${raw(queueList.slice(0, 50).map((r) => html`<tr>
        <td>${fmtDate(r.fields.QSO_DATE)} ${fmtTime(r.fields.TIME_ON)}</td><td class="fw-bold">${r.fields.CALL}</td><td>${r.fields.BAND} ${r.fields.MODE}</td>
        <td class="wrap">${raw(r.state === 'failed' ? html`<span class="text-danger">${r.error}</span>` : '<span class="text-muted">queued</span>')}</td>
        <td class="text-end text-nowrap">
          <button class="btn btn-sm btn-outline-secondary" data-edit="${r.id}" title="Edit before it uploads"><i class="fas fa-pen"></i></button>
          <button class="btn btn-sm btn-outline-danger" data-del="${r.id}" title="Discard this QSO"><i class="fas fa-trash"></i></button></td></tr>`).join(''))}</tbody></table></div>`
        : '<div class="card-body text-muted small py-2">Nothing waiting - everything logged so far has been sent.</div>')}
      </div>`;
    $('#q-instant').addEventListener('change', (e) => api('settings:set', { sync: { instant: e.target.checked } }));
    $('#q-offline').addEventListener('change', (e) => api('sync:setPaused', e.target.checked));
    $('#q-now').addEventListener('click', async () => { const st = await api('sync:now'); toast(st.lastError || (st.pending ? `${st.pending} still waiting` : 'All uploaded'), st.lastError ? 'warning' : 'success'); });
    $('#q-retry')?.addEventListener('click', () => api('sync:retryFailed'));
    $('#q-export').addEventListener('click', async () => { const r = await api('log:exportLocal'); if (r.ok) toast(`Saved ${r.path}`); });
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await App.util.confirmDialog({ title: 'Discard this QSO?', body: 'It has not been uploaded. This cannot be undone.', confirmLabel: 'Discard' });
      if (ok) await api('local:delete', b.dataset.del);
    }));
    box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEditModal(b.dataset.edit)));
  }

  function openEditModal(id) {
    const rec = queueList.find((r) => r.id === id);
    if (!rec) return;
    const f = rec.fields;
    document.getElementById('edit-modal-host')?.remove();
    const host = document.createElement('div');
    host.id = 'edit-modal-host';
    host.innerHTML = html`<div class="modal fade" tabindex="-1" id="edit-modal"><div class="modal-dialog"><div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Edit QSO</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div class="row g-2 mb-2">
          <div class="col-6"><label class="form-label small mb-0" for="em-date">Date</label><input id="em-date" class="form-control mono" value="${fmtDate(f.QSO_DATE)}"></div>
          <div class="col-6"><label class="form-label small mb-0" for="em-time">Time (UTC)</label><input id="em-time" class="form-control mono" value="${fmtTime(f.TIME_ON)}"></div>
        </div>
        <div class="mb-2"><label class="form-label small mb-0" for="em-call">Callsign</label><input id="em-call" class="form-control call-input text-uppercase" value="${f.CALL}"></div>
        <div class="row g-2 mb-2">
          <div class="col-4"><label class="form-label small mb-0" for="em-band">Band</label><input id="em-band" class="form-control" value="${f.BAND || ''}"></div>
          <div class="col-4"><label class="form-label small mb-0" for="em-mode">Mode</label><input id="em-mode" class="form-control text-uppercase" value="${f.MODE || ''}"></div>
          <div class="col-4"><label class="form-label small mb-0" for="em-freq">Freq (MHz)</label><input id="em-freq" class="form-control mono" value="${f.FREQ || ''}"></div>
        </div>
        <div class="row g-2 mb-2">
          <div class="col-6"><label class="form-label small mb-0" for="em-rsts">RST sent</label><input id="em-rsts" class="form-control mono" value="${f.RST_SENT || ''}"></div>
          <div class="col-6"><label class="form-label small mb-0" for="em-rstr">RST rcvd</label><input id="em-rstr" class="form-control mono" value="${f.RST_RCVD || ''}"></div>
        </div>
        <div class="mb-1"><label class="form-label small mb-0" for="em-comment">Comment</label><input id="em-comment" class="form-control" value="${f.COMMENT || ''}"></div>
      </div>
      <div class="modal-footer"><button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button><button type="button" class="btn btn-primary" id="em-save">Save</button></div>
    </div></div></div>`;
    document.body.appendChild(host);
    const modalEl = document.getElementById('edit-modal');
    const modal = new bootstrap.Modal(modalEl);
    modalEl.addEventListener('hidden.bs.modal', () => host.remove());
    document.getElementById('em-save').addEventListener('click', async () => {
      try {
        await api('local:update', id, {
          CALL: document.getElementById('em-call').value.trim(),
          QSO_DATE: document.getElementById('em-date').value.trim(),
          TIME_ON: document.getElementById('em-time').value.trim(),
          BAND: document.getElementById('em-band').value.trim(),
          MODE: document.getElementById('em-mode').value.trim(),
          FREQ: document.getElementById('em-freq').value.trim(),
          RST_SENT: document.getElementById('em-rsts').value.trim(),
          RST_RCVD: document.getElementById('em-rstr').value.trim(),
          COMMENT: document.getElementById('em-comment').value.trim(),
        });
        toast('QSO updated');
        modal.hide();
      } catch (e) {
        toast(e.message, 'danger');
        // Not something re-trying the same edit can fix (it already uploaded, or vanished
        // from the queue) - close rather than leave the modal (and its backdrop) stuck open.
        if (/no longer in the queue|already uploaded/i.test(e.message)) modal.hide();
      }
    });
    modal.show();
  }

  App.pages.logbook = {
    mount,
    unmount() { clearTimeout(searchTimer); document.body.classList.remove('fill-viewport'); el = null; },
    onEvent({ type }) { if (!el) return; if (type === 'qso:changed') { load(); drawQueue(); } if (type === 'sync' || type === 'settings') drawQueue(); },
  };

})();
