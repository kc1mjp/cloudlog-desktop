'use strict';
/*
 * Callbook settings: shape, defaults, and the only code that reads or writes the stored passwords.
 * Stored shape (inside settings.json):
 *   callbook: { provider: 'none'|'qrz'|'hamqth', qrz: { username, password }, hamqth: { username, password } }
 * `password` holds the sealed form from ../secrets.js. Both providers' credentials are always kept,
 * whichever provider is selected.
 */
const PROVIDER_IDS = ['qrz', 'hamqth'];

const CALLBOOK_DEFAULTS = {
  provider: 'none', // Disabled / No lookup: the safe default for new installs
  qrz: { username: '', password: '' },
  hamqth: { username: '', password: '' },
};

const cleanUser = (v) => String(v == null ? '' : v).trim().slice(0, 128);

/** Decrypted config for the lookup service. Main process only - never send this to the renderer. */
function resolveConfig(stored, secretBox) {
  const c = stored || {};
  const out = { provider: PROVIDER_IDS.includes(c.provider) ? c.provider : 'none' };
  for (const id of PROVIDER_IDS) {
    const p = c[id] || {};
    out[id] = { username: cleanUser(p.username), password: secretBox.open(p.password) };
  }
  return out;
}

/** What the renderer may see: usernames and whether a password is stored - never the password itself. */
function publicConfig(stored) {
  const c = stored || {};
  const out = { provider: PROVIDER_IDS.includes(c.provider) ? c.provider : 'none' };
  for (const id of PROVIDER_IDS) {
    const p = c[id] || {};
    out[id] = { username: cleanUser(p.username), hasPassword: !!p.password };
  }
  return out;
}

/**
 * Apply a Settings-form patch to the stored config (mutates and returns `stored`).
 *   patch: { provider?, qrz?: { username?, password?, clearPassword? }, hamqth?: { ... } }
 * A blank or missing `password` leaves the saved one untouched (the form never receives it back);
 * `clearPassword: true` removes it. Changing provider never touches either provider's credentials.
 */
function applyPatch(stored, patch, secretBox) {
  const p = patch || {};
  if (p.provider !== undefined) stored.provider = p.provider === 'none' || PROVIDER_IDS.includes(p.provider) ? p.provider : 'none';
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

module.exports = { PROVIDER_IDS, CALLBOOK_DEFAULTS, resolveConfig, publicConfig, applyPatch, validate };
