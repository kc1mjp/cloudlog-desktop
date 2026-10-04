'use strict';
(() => {
  const { $, html, raw, api, toast, qsoRows, qsoHead, fmtFreq, currentStation } = App.util;
  const COLUMNS = ['country']; // Date, UTC, Call, Band, Mode, RST, Country
  let el; let timer;

  async function draw() {
    if (!el) return;
    const { settings, rig, rigs, sync, adif } = App.state;
    const st = currentStation();
    const stats = await api('log:stats').catch(() => ({ total: 0, today: 0, recent: [] }));
    const setup = !sync.configured;
    el.innerHTML = html`
      ${raw(setup ? html`<div class="alert alert-info d-flex justify-content-between align-items-center">
        <span><i class="fas fa-plug me-2"></i>Connect to your Cloudlog server to upload QSOs and see your logbooks. You can still log offline in the meantime.</span>
        <a class="btn btn-primary btn-sm" href="#/settings?tab=cloudlog">Connect to Cloudlog</a></div>` : '')}
      <div class="row g-3 mb-3">
        <div class="col-md-3"><div class="card h-100"><div class="card-header">Current logbook</div><div class="card-body">
          <div class="fs-5 fw-bold">${st ? st.name : 'None selected'}</div>
          <div class="text-muted">${st ? `${st.callsign} · ${st.grid}` : 'Pick one on the Logbooks page'}</div>
          <a href="#/settings?tab=logbooks" class="btn btn-sm btn-outline-primary mt-2">Change logbook</a></div></div></div>
        <div class="col-md-3"><div class="card h-100"><div class="card-header">QSOs</div><div class="card-body">
          <div class="stat-num">${stats.today}</div><div class="text-muted">today (UTC)</div>
          <div class="mt-2 text-muted small">${stats.total} in the loaded logbook</div></div></div></div>
        <div class="col-md-3"><div class="card h-100"><div class="card-header">Upload queue</div><div class="card-body">
          <div class="stat-num">${sync.pending + sync.failed}</div>
          <div class="text-muted">${sync.failed ? `${sync.failed} failed, ` : ''}${sync.pending} waiting</div>
          <div class="d-flex gap-2 mt-2"><a href="#/logbook" class="btn btn-sm btn-outline-primary">Review</a>
          <button class="btn btn-sm btn-primary" id="dash-sync" ${sync.configured ? '' : 'disabled'}><i class="fas fa-cloud-arrow-up me-1"></i>Sync now</button></div></div></div></div>
        <div class="col-md-3"><div class="card h-100"><div class="card-header">Radio${raw(rigs.length > 1 ? html` <span class="badge text-bg-secondary">${rigs.length}</span>` : '')}</div><div class="card-body">
          ${raw(rig && rig.state === 'connected' && rig.freqHz
            ? html`<div class="freq-readout">${fmtFreq(rig.freqHz)}</div><div class="text-muted">${rig.mode} · ${rig.label}</div>`
            : rigs.length ? html`<div class="text-muted">${rig ? rig.message : 'No active radio selected'}</div><a href="#/settings?tab=radio" class="btn btn-sm btn-outline-primary mt-2">Radio settings</a>`
            : html`<div class="text-muted">No radio set up</div><a href="#/settings?tab=radio" class="btn btn-sm btn-outline-primary mt-2">Add a radio</a>`)}
          ${raw(rig && rig.relay.listening ? html`<div class="small text-muted mt-2">Hamlib port ${rig.relay.port} open, ${rig.relay.clients} client(s)</div>` : '')}
          ${raw(rigs.length > 1 ? html`<div class="small text-muted mt-2">${rigs.filter((r) => r.state === 'connected').length} of ${rigs.length} radios connected</div>` : '')}
          </div></div></div>
      </div>
      <div class="row g-3">
        <div class="col-lg-9"><div class="card"><div class="card-header">Recent QSOs</div>
          <div class="table-responsive"><table class="table table-striped table-tight mb-0">${raw(qsoHead(COLUMNS))}<tbody>${raw(qsoRows(stats.recent, COLUMNS))}</tbody></table></div></div></div>
        <div class="col-lg-3"><div class="card"><div class="card-header">Incoming ADIF</div><div class="card-body small">
          ${raw(adif.enabled ? html`
            <div>TCP ${adif.tcp.listening ? html`<span class="text-success">listening on ${adif.bind}:${adif.tcp.port}</span>` : adif.tcp.error ? html`<span class="text-danger">${adif.tcp.error}</span>` : 'off'}</div>
            <div>UDP ${adif.udp.listening ? html`<span class="text-success">listening on ${adif.bind}:${adif.udp.port}</span>` : adif.udp.error ? html`<span class="text-danger">${adif.udp.error}</span>` : 'off'}</div>
            <div class="text-muted mt-1">${adif.received} received this session</div>` : 'Socket is off')}
        </div></div></div>
      </div>`;
    $('#dash-sync')?.addEventListener('click', async () => { const st = await api('sync:now'); toast(st.lastError || (st.pending ? `${st.pending} still waiting` : 'All uploaded'), st.lastError ? 'warning' : 'success'); });
  }

  App.pages.dashboard = {
    mount(root) { el = root; draw(); },
    unmount() { el = null; },
    onEvent({ type }) {
      if (!['rig', 'sync', 'qso:changed', 'settings', 'adif:status'].includes(type)) return;
      clearTimeout(timer); // the rig event fires while tuning, so redraw at most a few times a second
      timer = setTimeout(draw, 250);
    },
  };
})();
