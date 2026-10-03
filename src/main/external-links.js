'use strict';
/*
 * Opening links in the user's default browser. Only http(s) URLs are ever passed to openExternal, and the
 * renderer never supplies a URL: it asks for "the configured Cloudlog address" or for one of the fixed About
 * links by key. Electron-free so it can be unit tested with a fake openExternal.
 */
const { ABOUT_LINKS } = require('../renderer/about-shared');

const NOT_CONFIGURED = 'Configure a valid Cloudlog address in Settings before opening it.';
const OPEN_FAILED = 'Could not open the link in your browser.';

/** Returns the normalised URL when `value` is a valid http(s) URL, otherwise null. Schemes without "//" and credentials are refused. */
function normalizeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > 2048 || !/^https?:\/\//i.test(s) || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
  return u.href;
}

function createExternalLinks({ getCloudlogUrl, openExternal }) {
  async function open(url) {
    try { await openExternal(url); return { ok: true }; } catch { return { ok: false, message: OPEN_FAILED }; }
  }
  return {
    /** Never throws; returns { ok: true } or { ok: false, message }. */
    async openCloudlog() {
      let raw;
      try { raw = getCloudlogUrl(); } catch { raw = null; }
      const url = normalizeHttpUrl(raw);
      return url ? open(url) : { ok: false, message: NOT_CONFIGURED };
    },
    async openAbout(key) {
      const l = typeof key === 'string' && Object.prototype.hasOwnProperty.call(ABOUT_LINKS, key) ? ABOUT_LINKS[key] : null;
      return l ? open(l.url) : { ok: false, message: OPEN_FAILED };
    },
  };
}

module.exports = { createExternalLinks, normalizeHttpUrl, NOT_CONFIGURED, OPEN_FAILED };
