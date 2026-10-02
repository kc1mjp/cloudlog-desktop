'use strict';
/* Defensive helpers for the small XML replies callbook providers send, and for sanitising their text. */

const MAX_REPLY_CHARS = 256 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const low = e.toLowerCase();
    if (ENTITIES[low]) return ENTITIES[low];
    let cp = NaN;
    if (low.startsWith('#x')) cp = parseInt(low.slice(2), 16);
    else if (low.startsWith('#')) cp = parseInt(low.slice(1), 10);
    if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp);
    return m;
  });
}

/** Text of the first <name>...</name> (case-insensitive, CDATA aware), '' when absent. Not a general XML parser. */
function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml || '');
  if (!m) return '';
  const inner = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_x, c) => c.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])));
  return decodeEntities(inner);
}

/** Raw inner XML of the first <name>...</name>, '' when absent. */
function block(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml || '');
  return m ? m[1] : '';
}

/**
 * Make provider-supplied text safe to show: drop control and bidi-override characters and angle brackets,
 * collapse whitespace, cap the length. (The UI also only ever assigns these to input .value / escaped text.)
 */
function clean(s, max = 80) {
  return String(s == null ? '' : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** A Maidenhead locator (4, 6 or 8 characters) in canonical upper case, or '' if it is not one. */
function cleanGrid(s) {
  const g = String(s == null ? '' : s).replace(/\s+/g, '');
  return /^[A-R]{2}\d{2}([A-X]{2}(\d{2})?)?$/i.test(g) ? g.toUpperCase() : '';
}

const firstWord = (s) => clean(s).split(' ')[0] || '';

module.exports = { MAX_REPLY_CHARS, decodeEntities, tag, block, clean, cleanGrid, firstWord };
