'use strict';
// Minimal ADIF reader/writer. Text is handled as a binary ("latin1") string so
// that field lengths, which are byte counts, stay correct for UTF-8 content.

function fromBinary(s) {
  // Convert a latin1-decoded byte string back into real text.
  return /[\x80-\xff]/.test(s) ? Buffer.from(s, 'latin1').toString('utf8') : s;
}

/**
 * Parse ADIF text. `text` must be a binary string (Buffer#toString('latin1'));
 * plain ASCII strings work as-is.
 */
function parseAdif(text) {
  const records = [];
  let header = null;
  let pos = 0;
  const eoh = text.search(/<eoh>/i);
  if (eoh >= 0) {
    header = text.slice(0, eoh);
    pos = eoh + 5;
  }
  const re = /<([^<>:\s]+)(?::(\d+))?(?::[^<>]*)?>/g;
  re.lastIndex = pos;
  let cur = {};
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].toUpperCase();
    if (name === 'EOR') {
      if (Object.keys(cur).length) records.push(cur);
      cur = {};
    } else if (name === 'EOH') {
      cur = {};
    } else if (m[2] !== undefined) {
      const len = parseInt(m[2], 10);
      cur[name] = fromBinary(text.substr(re.lastIndex, len));
      re.lastIndex += len;
    }
  }
  return { header, records };
}

function generateAdif(fields, { header = false } = {}) {
  let out = '';
  if (header) {
    out += 'Cloudlog Desktop ADIF export\n<ADIF_VER:5>3.1.4\n<PROGRAMID:16>Cloudlog Desktop\n<EOH>\n\n';
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    const s = String(v);
    out += `<${k.toUpperCase()}:${Buffer.byteLength(s, 'utf8')}>${s} `;
  }
  return out + '<EOR>\n';
}

module.exports = { parseAdif, generateAdif };
