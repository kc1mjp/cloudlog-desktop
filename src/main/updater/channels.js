'use strict';
/*
 * Update preferences: defaults, the beta/alpha dependency, eligibility.
 *
 * Saved shape (settings.json -> updates), every key optional; a missing key means "never saved":
 *   autoCheck        master switch for ALL update functionality (default true)
 *   allowPrerelease  default: installed build is rc / beta / alpha
 *   allowBeta        default: installed build is beta / alpha
 *   allowAlpha       default: installed build is alpha
 *   autoUpdate       default false (AppImage only)
 *   skippedVersion   canonical version string the user chose to skip
 *
 * Defaults come from the installed build's channel and apply ONLY to keys that were never saved. Invariant everywhere:
 * alpha ON implies beta ON. Eligibility:
 *   prerelease OFF            -> stable only (saved beta / alpha values are kept but ineffective)
 *   prerelease ON             -> stable + rc
 *   prerelease ON + beta      -> stable + rc + beta
 *   prerelease ON + alpha     -> stable + rc + beta + alpha   (alpha forces beta ON)
 */

const BOOL_KEYS = ['autoCheck', 'allowPrerelease', 'allowBeta', 'allowAlpha', 'autoUpdate'];

class PreferenceError extends Error {}

/** Channel defaults for an installed build whose channel is stable | rc | beta | alpha (anything else behaves as stable). */
function channelDefaults(installedChannel) {
  switch (installedChannel) {
    case 'rc': return { allowPrerelease: true, allowBeta: false, allowAlpha: false };
    case 'beta': return { allowPrerelease: true, allowBeta: true, allowAlpha: false };
    case 'alpha': return { allowPrerelease: true, allowBeta: true, allowAlpha: true };
    default: return { allowPrerelease: false, allowBeta: false, allowAlpha: false };
  }
}

const isBool = (v) => typeof v === 'boolean';

/** Effective settings: saved values where present, defaults otherwise, then the dependency invariant. */
function resolvePreferences(saved, installedChannel) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const d = channelDefaults(installedChannel);
  const eff = {
    autoCheck: isBool(s.autoCheck) ? s.autoCheck : true,
    allowPrerelease: isBool(s.allowPrerelease) ? s.allowPrerelease : d.allowPrerelease,
    allowBeta: isBool(s.allowBeta) ? s.allowBeta : d.allowBeta,
    allowAlpha: isBool(s.allowAlpha) ? s.allowAlpha : d.allowAlpha,
    autoUpdate: isBool(s.autoUpdate) ? s.autoUpdate : false,
    skippedVersion: typeof s.skippedVersion === 'string' && s.skippedVersion ? s.skippedVersion : null,
  };
  if (eff.allowAlpha) eff.allowBeta = true; // alpha requires beta, whatever was saved
  return eff;
}

/**
 * Repair a saved block on load. Drops values of the wrong type (they count as never saved) and, when alpha is ON while
 * beta is effectively OFF, saves beta ON. Returns { saved, changed } - the caller persists `saved` when `changed`.
 * Defaults are NOT written into the block: an unsaved key stays unsaved.
 */
function normalizeSaved(saved, installedChannel) {
  const src = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const out = {};
  let changed = src !== saved;
  for (const [k, v] of Object.entries(src)) {
    if (BOOL_KEYS.includes(k) && isBool(v)) out[k] = v;
    else if (k === 'skippedVersion' && typeof v === 'string' && v) out[k] = v;
    else if (k === 'discovered' && v && typeof v === 'object') out[k] = v;
    else if (k === 'lastCheckAt' && Number.isFinite(v)) out[k] = v;
    else changed = true; // unknown or invalid: not carried over
  }
  const eff = resolvePreferences(out, installedChannel);
  // Alpha effectively ON while beta is effectively OFF before the invariant: store the corrected pair. A beta that is
  // ON by default (never saved) is left unsaved.
  const betaBefore = isBool(out.allowBeta) ? out.allowBeta : channelDefaults(installedChannel).allowBeta;
  if (eff.allowAlpha && !betaBefore) { out.allowBeta = true; changed = true; }
  return { saved: out, changed };
}

/**
 * Apply a user change to the channel / switch preferences and return the new saved block (pure; the caller persists it
 * in one write, so the beta/alpha pair never exists in an invalid combination). Throws PreferenceError for a change
 * that is not allowed. Rules:
 *   alpha ON   -> beta ON too            beta OFF  -> alpha OFF too            alpha OFF -> beta unchanged
 *   beta / alpha can only change while prerelease updates are ON (or are switched on by the same change)
 *   a change that touches beta or alpha stores BOTH values, so the pair is always persisted together
 */
function applyPreferencePatch(saved, installedChannel, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new PreferenceError('Invalid update settings');
  for (const [k, v] of Object.entries(patch)) {
    if (!BOOL_KEYS.includes(k)) throw new PreferenceError(`Unknown update setting: ${k}`);
    if (!isBool(v)) throw new PreferenceError(`Update setting ${k} must be true or false`);
  }
  patch = { ...patch }; // never modify the caller's object
  const cur = resolvePreferences(saved, installedChannel);
  const next = { ...cur, ...patch };
  const touchesChannels = 'allowBeta' in patch || 'allowAlpha' in patch;
  if (touchesChannels && !next.allowPrerelease) {
    const changesBeta = 'allowBeta' in patch && patch.allowBeta !== cur.allowBeta;
    const changesAlpha = 'allowAlpha' in patch && patch.allowAlpha !== cur.allowAlpha;
    if (changesBeta || changesAlpha) throw new PreferenceError('Turn on "Allow pre-release updates" before changing beta or alpha updates');
    delete patch.allowBeta; delete patch.allowAlpha; // unchanged values: nothing to store
  }
  if (patch.allowAlpha === true) next.allowBeta = true;                // alpha requires beta (wins over an explicit beta OFF in the same change)
  else if (patch.allowBeta === false) next.allowAlpha = false;         // beta OFF takes alpha with it
  const out = { ...(saved && typeof saved === 'object' ? saved : {}) };
  for (const k of Object.keys(patch)) out[k] = next[k];
  if ('allowBeta' in patch || 'allowAlpha' in patch) { out.allowBeta = next.allowBeta; out.allowAlpha = next.allowAlpha; }
  if (out.allowAlpha === true) out.allowBeta = true;
  return out;
}

/** Is a release of this channel (stable | rc | beta | alpha) eligible under the effective settings? */
function isChannelEligible(channel, eff) {
  switch (channel) {
    case 'stable': return true;                       // under every configuration
    case 'rc': return !!eff.allowPrerelease;
    case 'beta': return !!eff.allowPrerelease && !!eff.allowBeta;
    case 'alpha': return !!eff.allowPrerelease && !!eff.allowBeta && !!eff.allowAlpha;
    default: return false;                            // unknown stages are never eligible
  }
}

module.exports = { BOOL_KEYS, PreferenceError, channelDefaults, resolvePreferences, normalizeSaved, applyPreferencePatch, isChannelEligible };
