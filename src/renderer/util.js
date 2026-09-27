'use strict';
/* Shared helpers for all pages. Everything hangs off window.App. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => (s instanceof Raw ? s : new Raw(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const one = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(one).join('') : esc(v));
/** Tagged template that HTML-escapes interpolated values unless wrapped in raw(). */
const html = (strs, ...vals) => new Raw(strs.reduce((o, s, i) => o + s + (i < vals.length ? one(vals[i]) : ''), ''));

const App = { state: { settings: null, rig: null, sync: null, adif: null, info: null }, pages: {}, current: null };
window.App = App;

const api = async (name, ...args) => {
  try {
    const res = await window.cl.call(name, ...args);
    if (name === 'settings:set' && res) App.state.settings = res; // keep the renderer's copy current
    return res;
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    const err = new Error(msg);
    throw err;
  }
};

function toast(message, kind = 'success', ms = 4200) {
  const el = document.createElement('div');
  el.className = `alert alert-${kind} py-2 px-3`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'danger' ? Math.max(ms, 7000) : ms);
}

// ---- formatting ------------------------------------------------------------
const fmtDate = (d) => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d || '');
const fmtTime = (t) => (t ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : '');
function fmtFreq(hz) {
  if (!hz) return '—';
  const s = String(Math.round(hz)).padStart(4, '0');
  const mhz = s.slice(0, -6) || '0';
  return `${mhz}.${s.slice(-6, -3)}.${s.slice(-3, -1)}`; // 14.074.00 (10 Hz resolution)
}
const hzToMhz = (hz) => (hz / 1e6).toFixed(6);

const BANDS = [['2190m', 0.1357, 0.1378], ['630m', 0.472, 0.479], ['160m', 1.8, 2.0], ['80m', 3.5, 4.0], ['60m', 5.06, 5.45], ['40m', 7.0, 7.3],
  ['30m', 10.1, 10.15], ['20m', 14.0, 14.35], ['17m', 18.068, 18.168], ['15m', 21.0, 21.45], ['12m', 24.89, 24.99], ['10m', 28.0, 29.7],
  ['6m', 50, 54], ['4m', 70, 71], ['2m', 144, 148], ['1.25m', 222, 225], ['70cm', 420, 450], ['33cm', 902, 928], ['23cm', 1240, 1300],
  ['13cm', 2300, 2450], ['9cm', 3300, 3500], ['6cm', 5650, 5925], ['3cm', 10000, 10500]];
const freqToBand = (mhz) => { const f = Number(mhz); const b = BANDS.find(([, lo, hi]) => f >= lo && f <= hi); return b ? b[0] : ''; };
const DIGITAL = ['FT8', 'FT4', 'JS8', 'PSK31', 'MFSK', 'RTTY'];
const defaultRst = (mode) => (['SSB', 'AM', 'FM'].includes(mode) ? '59' : ['FT8', 'FT4', 'JS8'].includes(mode) ? '-10' : '599');

function modeFromRig(hl, current) {
  const m = (hl || '').toUpperCase();
  if (m === 'USB' || m === 'LSB') return 'SSB';
  if (m === 'CW' || m === 'CWR') return 'CW';
  if (m === 'AM') return 'AM';
  if (['FM', 'WFM', 'PKTFM', 'FMN'].includes(m)) return 'FM';
  if (m === 'RTTY' || m === 'RTTYR') return 'RTTY';
  if (m.startsWith('PKT') || m === 'DIGI' || m === 'DATA') return DIGITAL.includes(current) ? current : 'FT8';
  return current || 'SSB';
}

function ssbSubmode(rig, mhz) {
  if (rig && (rig.mode === 'USB' || rig.mode === 'LSB')) return rig.mode;
  return mhz && mhz < 10 ? 'LSB' : 'USB';
}

const pad = (n) => String(n).padStart(2, '0');
function utcNow() {
  const d = new Date();
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
}

/** Date/time inputs that follow the UTC clock until the operator edits them or a callsign is typed. */
class TimeFields {
  constructor(dateEl, timeEl) {
    this.dateEl = dateEl; this.timeEl = timeEl; this.auto = true;
    const off = () => { this.auto = false; };
    dateEl.addEventListener('input', off); timeEl.addEventListener('input', off);
    this.tick();
  }
  tick() { if (this.auto) { const n = utcNow(); this.dateEl.value = n.date; this.timeEl.value = n.time; } }
  freeze() { this.auto = false; }
  reset() { this.auto = true; this.tick(); }
  values() {
    const d = this.dateEl.value.trim(); const t = this.timeEl.value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Date must look like 2026-09-20');
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(t)) throw new Error('Time must look like 14:05 or 14:05:30');
    return { QSO_DATE: d.replace(/-/g, ''), TIME_ON: t.replace(/:/g, '').padEnd(6, '0') };
  }
}

/** Keeps freq/band/mode inputs in step with the radio, without fighting the operator's typing. */
function followRig(rig, { freq, band, mode }, enabled) {
  if (!enabled || !rig || rig.state !== 'connected' || !rig.freqHz) return;
  if (document.activeElement !== freq) freq.value = hzToMhz(rig.freqHz);
  const b = freqToBand(rig.freqHz / 1e6);
  if (b && band.value !== b) band.value = b;
  const m = modeFromRig(rig.mode, mode.value);
  if (document.activeElement !== mode && mode.value !== m) { mode.value = m; mode.dispatchEvent(new Event('change')); }
}

const stateIcon = (r) => {
  if (r._state === 'pending') return html`<i class="fas fa-clock text-warning" title="Waiting to upload"></i>`;
  if (r._state === 'failed') return html`<i class="fas fa-triangle-exclamation text-danger" title="${r._error}"></i>`;
  if (r._state === 'synced') return html`<i class="fas fa-check text-success" title="Uploaded"></i>`;
  return '';
};

function qsoRows(rows, { extra } = {}) {
  if (!rows.length) return html`<tr><td colspan="9" class="text-muted text-center py-3">No QSOs yet</td></tr>`;
  return rows.map((r) => html`<tr>
    <td>${fmtDate(r.QSO_DATE)}</td><td>${fmtTime(r.TIME_ON)}</td>
    <td class="fw-bold">${r.CALL}</td><td>${r.BAND}</td><td>${r.MODE}${r.SUBMODE && r.SUBMODE !== r.MODE ? ` (${r.SUBMODE})` : ''}</td>
    <td>${r.RST_SENT || r.RST_RCVD ? `${r.RST_SENT || ''} / ${r.RST_RCVD || ''}` : ''}</td>
    ${raw(extra ? extra(r) : html`<td class="wrap">${[r.NAME, r.QTH, r.GRIDSQUARE].filter(Boolean).join(', ')}</td>`)}
    <td class="wrap">${[r.SOTA_REF, r.POTA_REF, r.IOTA, r.COMMENT].filter(Boolean).join(' · ')}</td>
    <td class="text-end">${raw(stateIcon(r))}</td></tr>`).join('');
}

const qsoHead = (mid = 'Station') => html`<thead><tr><th>Date</th><th>UTC</th><th>Call</th><th>Band</th><th>Mode</th><th>RST</th><th>${mid}</th><th>Notes</th><th></th></tr></thead>`;

function currentStation() {
  const c = App.state.settings.cloudlog;
  return c.stations.find((s) => s.id === String(c.currentStationId)) || null;
}

function requireLogbook() {
  const c = App.state.settings.cloudlog;
  if (!c.currentStationId) throw new Error('Choose a logbook first (Logbooks page) so the QSO knows where to go');
}

/**
 * In-page replacement for window.confirm(). Electron's native confirm() opens
 * a real OS-level dialog that blocks the render process; on some Linux/GTK
 * setups that leaves the window's input routing broken afterwards (text boxes
 * stop accepting focus/typing) until the app is restarted. This uses an
 * ordinary Bootstrap modal instead - no native dialog, no blocked event loop.
 */
function confirmDialog({ title = 'Are you sure?', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    $('#confirm-modal-host')?.remove();
    const host = document.createElement('div');
    host.id = 'confirm-modal-host';
    host.innerHTML = html`<div class="modal fade" tabindex="-1" id="confirm-modal"><div class="modal-dialog"><div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${title}</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cancel"></button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">${cancelLabel}</button>
        <button type="button" class="btn btn-${danger ? 'danger' : 'primary'}" id="confirm-modal-ok">${confirmLabel}</button>
      </div></div></div></div>`;
    document.body.appendChild(host);
    const modalEl = $('#confirm-modal');
    const modal = new bootstrap.Modal(modalEl);
    let decided = false;
    $('#confirm-modal-ok', modalEl).addEventListener('click', () => { decided = true; modal.hide(); });
    modalEl.addEventListener('hidden.bs.modal', () => { host.remove(); resolve(decided); }, { once: true });
    modal.show();
  });
}

/**
 * Defense in depth: Bootstrap appends a modal's backdrop as a sibling of
 * <body>'s other children, not nested inside the modal element, so removing
 * our own modal wrapper doesn't guarantee a stray backdrop goes with it if
 * something unexpected happens mid-modal. A stuck backdrop is a full-screen
 * layer that swallows every click, which looks exactly like "nothing responds
 * until I restart the app." Run this on every navigation so that simply
 * clicking to another page - the natural thing a confused user tries first -
 * always recovers, even from a bug we haven't found yet.
 */
function cleanupStrayModalArtifacts() {
  if ($$('.modal.show, .modal.showing').length) return; // a modal is legitimately open right now
  $$('.modal-backdrop').forEach((el) => el.remove());
  document.body.classList.remove('modal-open');
  document.body.style.removeProperty('overflow');
  document.body.style.removeProperty('padding-right');
}

App.util = { $, $$, html, raw, esc, api, toast, confirmDialog, cleanupStrayModalArtifacts, fmtDate, fmtTime, fmtFreq, hzToMhz, freqToBand, defaultRst, modeFromRig, ssbSubmode, utcNow, TimeFields, followRig, stateIcon, qsoRows, qsoHead, currentStation, requireLogbook, DIGITAL };
