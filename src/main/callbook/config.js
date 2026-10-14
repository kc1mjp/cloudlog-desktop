'use strict';
/*
 * Callbook settings: shape, defaults, and the only code that reads or writes the stored passwords.
 * Stored shape (inside settings.json):
 *   callbook: { provider: 'none'|'qrz'|'hamqth', qrz: { username, password }, hamqth: { username, password } }
 * `password` holds the sealed form from ../secrets.js. Both providers' credentials are always kept,
 * whichever provider is selected.
 *
 * Since 0.4.3 the same block also holds four independent Booleans that control lookup enrichment of contacts:
 *   enrich: { metadataOnNew, metadataOnUpload, gridOnNew, gridOnUpload }
 * ("metadata" = name / state / county / country, "grid" = gridsquare; "New" = when a QSO is created or accepted,
 * "Upload" = immediately before a queued QSO is uploaded). See ./enrich.js.
 */
const PROVIDER_IDS = ['qrz', 'hamqth'];

// Before 0.4.3 there was no enrichment switch: whenever a provider was selected the Live QSO form filled name / QTH /
// grid. The new-QSO switches therefore default to on (that behaviour is kept; with provider 'none' they do nothing),
// and the upload-time switches, which are new behaviour, default to off.
const ENRICH_DEFAULTS = Object.freeze({ metadataOnNew: true, metadataOnUpload: false, gridOnNew: true, gridOnUpload: false });
const ENRICH_KEYS = Object.keys(ENRICH_DEFAULTS);

const CALLBOOK_DEFAULTS = {
  provider: 'none', // Disabled / No lookup: the safe default for new installs
  qrz: { username: '', password: '' },
  hamqth: { username: '', password: '' },
  enrich: { ...ENRICH_DEFAULTS },
};

const cleanUser = (v) => String(v == null ? '' : v).trim().slice(0, 128);

/** The four enrichment switches as strict Booleans; anything missing or not a Boolean falls back to its default. */
function resolveEnrich(stored) {
  const e = stored && typeof stored === 'object' ? stored : {};
  const out = {};
  for (const k of ENRICH_KEYS) out[k] = typeof e[k] === 'boolean' ? e[k] : ENRICH_DEFAULTS[k];
  return out;
}

/** Decrypted config for the lookup service. Main process only - never send this to the renderer. */
function resolveConfig(stored, secretBox) {
  const c = stored || {};
  const out = { provider: PROVIDER_IDS.includes(c.provider) ? c.provider : 'none', enrich: resolveEnrich(c.enrich) };
  for (const id of PROVIDER_IDS) {
    const p = c[id] || {};
    out[id] = { username: cleanUser(p.username), password: secretBox.open(p.password) };
  }
  return out;
}

/** What the renderer may see: usernames and whether a password is stored - never the password itself. */
function publicConfig(stored) {
  const c = stored || {};
  const out = { provider: PROVIDER_IDS.includes(c.provider) ? c.provider : 'none', enrich: resolveEnrich(c.enrich) };
  for (const id of PROVIDER_IDS) {
    const p = c[id] || {};
    out[id] = { username: cleanUser(p.username), hasPassword: !!p.password };
  }
  return out;
}

/**
 * Apply a Settings-form patch to the stored config (mutates and returns `stored`).
 *   patch: { provider?, enrich?: { metadataOnNew?, ... }, qrz?: { username?, password?, clearPassword? }, hamqth?: { ... } }
 * A blank or missing `password` leaves the saved one untouched (the form never receives it back);
 * `clearPassword: true` removes it. Changing provider never touches either provider's credentials. Only Boolean values
 * in `enrich` are accepted, each switch on its own: setting one never changes another.
 */
function applyPatch(stored, patch, secretBox) {
  const p = patch || {};
  if (p.provider !== undefined) stored.provider = p.provider === 'none' || PROVIDER_IDS.includes(p.provider) ? p.provider : 'none';
  if (p.enrich && typeof p.enrich === 'object') {
    stored.enrich = resolveEnrich(stored.enrich);
    for (const k of ENRICH_KEYS) if (typeof p.enrich[k] === 'boolean') stored.enrich[k] = p.enrich[k];
  }
  for (const id of PROVIDER_IDS) {
    const q = p[id];
    if (!q || typeof q !== 'object') continue;
    stored[id] = stored[id] || { username: '', password: '' };
    if (q.username !== undefined) stored[id].username = cleanUser(q.username);
    if (q.clearPassword === true) stored[id].password = '';
    else if (typeof q.password === 'string' && q.password !== '') stored[id].password = secretBox.seal(q.password);
  }
  return stored;
}

/** Human-readable problems with the current selection, for Settings validation messaging. */
function validate(stored, secretBox) {
  const cfg = resolveConfig(stored, secretBox);
  if (cfg.provider === 'none') return [];
  const label = cfg.provider === 'qrz' ? 'QRZ' : 'HamQTH';
  const p = cfg[cfg.provider];
  const missing = [];
  if (!p.username) missing.push('username');
  if (!p.password) missing.push('password');
  return missing.length ? [`${label} ${missing.join(' and ')} required for callsign lookup.`] : [];
}

module.exports = { PROVIDER_IDS, CALLBOOK_DEFAULTS, ENRICH_DEFAULTS, ENRICH_KEYS, resolveEnrich, resolveConfig, publicConfig, applyPatch, validate };
