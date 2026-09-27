'use strict';
// Tiny stand-in for a Cloudlog server, just enough for the client tests.
const http = require('http');
const { parseAdif } = require('../src/main/adif');

function start(port = 0, key = 'abc123', opts = {}) {
  const state = { qsos: [], radio: [], nextId: 1, requests: [] };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      state.requests.push(`${req.method} ${req.url}`);
      const u = req.url.replace(/^\/index\.php/, '');
      const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!req.url.startsWith('/index.php/')) { res.writeHead(404); return res.end('nope'); }
      if (u === `/api/auth/${key}`) { res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end('<?xml version="1.0"?><auth><status>Valid</status><rights>rw</rights></auth>'); }
      if (u.startsWith('/api/auth/')) { res.writeHead(200); return res.end('<auth><message>Key Invalid</message></auth>'); }
      if (u === `/api/station_info/${key}`) return json([{ station_id: '1', station_profile_name: 'Home', station_gridsquare: 'FN41', station_callsign: 'W1AW', station_active: '1' }, { station_id: '2', station_profile_name: 'Portable', station_gridsquare: 'FN42', station_callsign: 'W1AW/P', station_active: '0' }]);
      let j = {};
      try { j = JSON.parse(body); } catch { /* ignore */ }
      if (j.key !== key) return json({ status: 'failed', reason: 'missing api key' }, 401);
      if (u === '/api/qso') {
        const { records } = parseAdif(j.string);
        const r = records[0];
        const dup = state.qsos.find((q) => q.f.CALL === r.CALL && q.f.QSO_DATE === r.QSO_DATE && q.f.TIME_ON === r.TIME_ON);
        if (dup) return json({ status: 'abort', message: ['Duplicate for ' + r.CALL] }, 400);
        state.qsos.push({ id: state.nextId++, station: j.station_profile_id, f: r });
        return json({ status: 'created', type: 'adif', adif_count: 1 });
      }
      if (u === '/api/radio') { state.radio.push(j); return json({ status: 'success' }); }
      if (u === '/api/get_contacts_adif' && !opts.noDownload) {
        const rows = state.qsos.filter((q) => q.id > j.fetchfromid && q.station === String(j.station_id));
        const adif = rows.map((q) => Object.entries(q.f).map(([k, v]) => `<${k}:${Buffer.byteLength(v)}>${v}`).join('') + '<EOR>').join('\n');
        return json({ exported_qsos: rows.length, lastfetchedid: rows.length ? rows[rows.length - 1].id : j.fetchfromid, message: 'Export successful', adif });
      }
      json({ status: 'failed' }, 404);
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) })));
}
module.exports = { start };
