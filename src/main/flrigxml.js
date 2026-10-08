'use strict';
/*
 * flrig-compatible XML-RPC sharing server (release 0.4.2).
 *
 * Lets FL-suite programs (fldigi, flmsg, ...) and other flrig clients control a radio that Cloudlog Desktop already
 * owns. It is a protocol translator only: every radio operation goes through the RigService's single rigctld
 * connection (see rig.js), so no second serial/USB/network CAT connection is ever opened, and requests from the
 * app, from Hamlib relay clients (which talk to rigctld, not to this socket) and from XML-RPC clients are ordered
 * by the same rigctld command queue. Compound XML-RPC operations additionally run inside RigService.exclusive().
 *
 * Method names, argument and result types follow flrig's own server (flrig/src/server/xml_server.cxx), as used by
 * fldigi (src/rigcontrol/xmlrpc_rig.cxx) and the reference rig_bridge.py. No third-party dependencies.
 */
const http = require('http');
const EventEmitter = require('events');

// ---- faults -----------------------------------------------------------------------------------------------
const FAULT = {
  PARSE: -32700, // body is not a well-formed methodCall
  NO_METHOD: -32601, // unknown or unsupported method
  BAD_PARAMS: -32602, // wrong number/type/range of arguments
  INTERNAL: -32603,
  NO_RADIO: -32001, // radio not connected / not answering
  CAT: -32004, // the radio (rigctld) refused or failed the operation
  TIMEOUT: -32005,
  BUSY: -32006,
};

class XmlRpcFault extends Error {
  constructor(code, message) { super(message); this.faultCode = code; }
}

// ---- configuration / validation -------------------------------------------------------------------------------
const XMLRPC_DEFAULTS = { enabled: false, bind: '127.0.0.1', port: 12345 };

/** A radio's XML-RPC sharing config with defaults filled in (older settings files have none). */
function xmlrpcConfig(cfg) {
  const x = (cfg && cfg.xmlrpc) || {};
  return { enabled: !!x.enabled, bind: x.bind || XMLRPC_DEFAULTS.bind, port: x.port === undefined ? XMLRPC_DEFAULTS.port : x.port };
}

function validatePort(port) {
  const n = Number(port);
  if (port === '' || port === null || port === undefined || !Number.isInteger(n) || n < 1 || n > 65535) return 'XML-RPC port must be a whole number from 1 to 65535';
  return '';
}

const bindsOverlap = (a, b) => a === b || a === '0.0.0.0' || b === '0.0.0.0';

/**
 * Checks one radio's (already merged) config against every other listener configured in settings. Returns '' when
 * fine, else a message for the operator. Only enabled sharing services count, and a radio with the XML-RPC option
 * off is never an error.
 */
function validateXmlrpcSharing(rigs, rig) {
  const x = xmlrpcConfig(rig);
  if (!x.enabled) return '';
  const bad = validatePort(x.port);
  if (bad) return bad;
  const port = Number(x.port);
  if (rig.relay && rig.relay.enabled && Number(rig.relay.port) === port && bindsOverlap(rig.relay.bind, x.bind)) {
    return `XML-RPC port ${port} is already used by this radio's Hamlib port - pick a different port`;
  }
  for (const o of rigs || []) {
    if (o.id === rig.id) continue;
    const label = o.label || o.id;
    const ox = xmlrpcConfig(o);
    if (ox.enabled && Number(ox.port) === port && bindsOverlap(ox.bind, x.bind)) return `XML-RPC port ${port} is already used by the XML-RPC port of "${label}"`;
    if (o.relay && o.relay.enabled && Number(o.relay.port) === port && bindsOverlap(o.relay.bind, x.bind)) return `XML-RPC port ${port} is already used by the Hamlib port of "${label}"`;
  }
  // A net-mode radio on this machine is itself a listener on its own port.
  if (rig.mode === 'net' && ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(rig.host) && Number(rig.port) === port) {
    return `XML-RPC port ${port} is the same as the radio connection - pick a different port`;
  }
  return '';
}

// ---- XML-RPC codec (no dependencies) ----------------------------------------------------------------------------
const MAX_BODY = 1024 * 1024;
const MAX_DEPTH = 24;

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!(cp >= 0 && cp <= 0x10ffff)) throw new Error('bad character reference');
      return String.fromCodePoint(cp);
    }
    if (ENT[e] === undefined) throw new Error(`unknown entity &${e};`);
    return ENT[e];
  });
}
const escapeXml = (s) => String(s).replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Parses well-formed XML into {name, children, text}. DOCTYPE/entity declarations are rejected outright. */
function parseXml(src) {
  const root = { name: '#root', children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const text = lt < 0 ? src.slice(i) : src.slice(i, lt);
    if (text) stack[stack.length - 1].text += unescapeXml(text);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); if (e < 0) throw new Error('unterminated comment'); i = e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); if (e < 0) throw new Error('unterminated CDATA'); stack[stack.length - 1].text += src.slice(lt + 9, e); i = e + 3; continue; }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); if (e < 0) throw new Error('unterminated declaration'); i = e + 2; continue; }
    if (src.startsWith('<!', lt)) throw new Error('DOCTYPE/entity declarations are not allowed');
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) throw new Error('unterminated tag');
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      const name = body.slice(1).trim();
      const top = stack.pop();
      if (!top || stack.length === 0 || top.name !== name) throw new Error(`mismatched closing tag </${name}>`);
      continue;
    }
    const selfClose = body.endsWith('/');
    const m = /^([A-Za-z_][\w.:-]*)/.exec(selfClose ? body.slice(0, -1) : body);
    if (!m) throw new Error('bad tag');
    const node = { name: m[1], children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) {
      stack.push(node);
      if (stack.length > MAX_DEPTH) throw new Error('XML nested too deeply');
    }
  }
  if (stack.length !== 1) throw new Error('unclosed tag');
  if (root.children.length !== 1) throw new Error('expected a single root element');
  return root.children[0];
}

function decodeValue(node, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('value nested too deeply');
  if (node.name !== 'value') throw new Error(`expected <value>, found <${node.name}>`);
  if (!node.children.length) return node.text; // untyped value = string
  const t = node.children[0];
  const txt = t.text.trim();
  switch (t.name) {
    case 'i4': case 'int': case 'i8': {
      if (!/^[+-]?\d+$/.test(txt)) throw new Error(`bad integer ${JSON.stringify(txt)}`);
      return Number(txt);
    }
    case 'double': {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(txt)) throw new Error(`bad double ${JSON.stringify(txt)}`);
      return Number(txt);
    }
    case 'boolean': if (txt !== '0' && txt !== '1') throw new Error('bad boolean'); return txt === '1';
    case 'string': return t.text;
    case 'base64': case 'dateTime.iso8601': return txt;
    case 'nil': return null;
    case 'array': {
      const data = t.children.find((c) => c.name === 'data');
      if (!data) throw new Error('array without <data>');
      return data.children.map((c) => decodeValue(c, depth + 1));
    }
    case 'struct': {
      const out = {};
      for (const mem of t.children) {
        if (mem.name !== 'member') throw new Error('struct child is not <member>');
        const nm = mem.children.find((c) => c.name === 'name');
        const vl = mem.children.find((c) => c.name === 'value');
        if (!nm || !vl) throw new Error('bad struct member');
        out[nm.text.trim()] = decodeValue(vl, depth + 1);
      }
      return out;
    }
    default: throw new Error(`unknown value type <${t.name}>`);
  }
}

/** Marks a number to be sent as <double> instead of <int>. */
class XmlDouble { constructor(v) { this.v = v; } }

function encodeValue(v) {
  if (v instanceof XmlDouble) return `<value><double>${Number.isFinite(v.v) ? v.v : 0}</double></value>`;
  if (typeof v === 'string') return `<value><string>${escapeXml(v)}</string></value>`;
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= 0x7fffffff ? `<value><int>${v}</int></value>` : `<value><double>${v}</double></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(encodeValue).join('')}</data></array></value>`;
  if (v && typeof v === 'object') {
    return `<value><struct>${Object.entries(v).map(([k, x]) => `<member><name>${escapeXml(k)}</name>${encodeValue(x)}</member>`).join('')}</struct></value>`;
  }
  return '<value><string></string></value>';
}

const XML_HEAD = '<?xml version="1.0"?>\r\n';
const responseXml = (v) => `${XML_HEAD}<methodResponse><params><param>${encodeValue(v)}</param></params></methodResponse>`;
const faultXml = (code, msg) => `${XML_HEAD}<methodResponse><fault>${encodeValue({ faultCode: code, faultString: msg })}</fault></methodResponse>`;

/** -> { method, params } or throws. */
function parseMethodCall(body) {
  const root = parseXml(body);
  if (root.name !== 'methodCall') throw new Error('root element is not <methodCall>');
  const mn = root.children.find((c) => c.name === 'methodName');
  if (!mn || !mn.text.trim()) throw new Error('missing <methodName>');
  const params = [];
  const pe = root.children.find((c) => c.name === 'params');
  if (pe) {
    for (const p of pe.children) {
      if (p.name !== 'param') throw new Error('<params> child is not <param>');
      const val = p.children.find((c) => c.name === 'value');
      if (!val) throw new Error('<param> without <value>');
      params.push(decodeValue(val));
    }
  }
  return { method: mn.text.trim(), params };
}

// ---- small async mutex (used by RigService.exclusive) --------------------------------------------------------------
class Mutex {
  constructor(maxWaiting = 32) { this.maxWaiting = maxWaiting; this.tail = Promise.resolve(); this.waiting = 0; }
  run(fn) {
    if (this.waiting >= this.maxWaiting) return Promise.reject(new XmlRpcFault(FAULT.BUSY, 'Radio is busy - too many requests queued'));
    this.waiting++;
    const prev = this.tail;
    let release;
    this.tail = new Promise((r) => { release = r; });
    return prev.then(async () => { try { return await fn(); } finally { this.waiting--; release(); } });
  }
}

// ---- radio operations -----------------------------------------------------------------------------------------------
// Generic Hamlib mode names (same vocabulary the app already sends with `M <mode> 0`). Not filtered per radio:
// the radio decides, and an unsupported mode comes back to the client as a fault.
const MODES = ['USB', 'LSB', 'CW', 'CWR', 'RTTY', 'RTTYR', 'AM', 'FM', 'WFM', 'AMS', 'PKTLSB', 'PKTUSB', 'PKTFM', 'ECSSUSB', 'ECSSLSB', 'FAX', 'SAM', 'SAL', 'SAH', 'DSB'];
// Generic passband table (Hz) behind rig.get_bws / rig.set_bw index. rigctld cannot list a radio's real filters.
const BANDWIDTHS = ['500', '1800', '2400', '2700', '3000', '6000'];
const LOWER_SIDEBAND = new Set(['LSB', 'PKTLSB', 'ECSSLSB', 'CWR', 'RTTY']);
const MAX_HZ = 1e11;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function paramCount(params, n, name) {
  if (params.length !== n) throw new XmlRpcFault(FAULT.BAD_PARAMS, `${name} takes ${n} parameter(s), got ${params.length}`);
}

function toHz(v) {
  let n = v;
  if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
  if (!isNum(n)) throw new XmlRpcFault(FAULT.BAD_PARAMS, 'frequency must be a number of Hz');
  const hz = Math.round(n);
  if (hz < 1 || hz > MAX_HZ) throw new XmlRpcFault(FAULT.BAD_PARAMS, `frequency ${n} Hz is out of range`);
  return hz;
}

function toMode(v) {
  let name = v;
  if (Number.isInteger(v)) { // rig_bridge.py also accepted an index into the modes list
    if (v < 0 || v >= MODES.length) throw new XmlRpcFault(FAULT.BAD_PARAMS, `mode index ${v} out of range`);
    name = MODES[v];
  }
  if (typeof name !== 'string') throw new XmlRpcFault(FAULT.BAD_PARAMS, 'mode must be a mode name');
  name = name.trim().toUpperCase();
  if (!MODES.includes(name)) throw new XmlRpcFault(FAULT.BAD_PARAMS, `unsupported mode ${JSON.stringify(String(v).slice(0, 20))}`);
  return name;
}

/**
 * Builds the method table for one radio. `radio` is the RigService (or a test double) and must provide:
 *   state            {state, freqHz, mode, ptt, message}   (kept current by the app's poll loop)
 *   rigName()        display name
 *   cat(cmd, n)      one rigctl command -> response lines (the app's single serialized rigctld connection)
 *   exclusive(fn)    run fn without other XML-RPC operations interleaving
 *   setFrequency(hz) / setMode(mode) / setPtt(on)   -- throw Error on refusal
 *   noteState(patch) fold a just-confirmed value into the shared state
 */
function buildMethods({ radio, version }) {
  const M = new Map();
  const def = (name, sig, help, opts, fn) => {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    M.set(name, { name, sig, help, cat: !!opts.cat, fn });
  };
  const online = () => {
    const s = radio.state;
    if (s.state !== 'connected') throw new XmlRpcFault(FAULT.NO_RADIO, `Radio not connected${s.message ? `: ${s.message}` : ''}`);
    return s;
  };
  const liveFreq = () => { const s = online(); if (!s.freqHz) throw new XmlRpcFault(FAULT.NO_RADIO, 'Radio is not reporting a frequency'); return s; };
  const cat = async (cmd, n = 1) => {
    try { return await radio.cat(cmd, n); } catch (e) { throw new XmlRpcFault(FAULT.NO_RADIO, `Radio not responding: ${e.message}`); }
  };
  const catFault = (e) => (e instanceof XmlRpcFault ? e : new XmlRpcFault(FAULT.CAT, e.message || String(e)));
  const activeVfo = async () => {
    const r = await cat('v');
    if (/^RPRT/.test(r[0])) return null; // radio/backend cannot report its VFO
    return /VFOA|Main/i.test(r[0]) ? 'A' : /VFOB|Sub/i.test(r[0]) ? 'B' : null;
  };
  const need = async (which) => {
    const cur = await activeVfo();
    if ((cur || 'A') !== which) throw new XmlRpcFault(FAULT.CAT, `VFO ${which} is not the active VFO; only the active VFO can be read or changed`);
  };

  def('system.listMethods', ['array'], 'returns the list of supported methods', () => [...M.keys()].sort());
  def('system.methodHelp', ['string', 'string'], 'returns help text for a method', (p) => {
    paramCount(p, 1, 'system.methodHelp');
    const m = M.get(String(p[0]));
    if (!m) throw new XmlRpcFault(FAULT.NO_METHOD, `Method not found: ${String(p[0]).slice(0, 60)}`);
    return m.help;
  });
  def('system.methodSignature', ['array', 'string'], 'returns the signature of a method', (p) => {
    paramCount(p, 1, 'system.methodSignature');
    const m = M.get(String(p[0]));
    if (!m) throw new XmlRpcFault(FAULT.NO_METHOD, `Method not found: ${String(p[0]).slice(0, 60)}`);
    return [m.sig];
  });
  def('rig.list_methods', ['array'], 'get flrig methods (name, signature, help)', () => [...M.values()].map((m) => ({ name: m.name, signature: m.sig.join(':'), help: m.help })));

  def('main.get_version', ['string'], 'returns program version string', () => version);
  def('rig.get_xcvr', ['string'], 'returns noun name of transceiver ("" when the radio is not connected)', () => (radio.state.state === 'connected' ? radio.rigName() : ''));

  // frequency (Hz)
  const getFreq = () => String(liveFreq().freqHz);
  const setFreq = (ret) => async (p, name) => {
    paramCount(p, 1, name);
    const hz = toHz(p[0]);
    online();
    try { await radio.setFrequency(hz); } catch (e) { throw catFault(e); }
    radio.noteState({ freqHz: hz, updated: Date.now() });
    return ret;
  };
  def('rig.get_vfo', ['string'], 'returns active vfo in Hertz', getFreq);
  def('rig.set_vfo', ['int', 'double'], 'rig.set_vfo NNNNNNNN (Hz)', { cat: true }, (p) => setFreq(0)(p, 'rig.set_vfo'));
  def('main.set_frequency', ['int', 'double'], 'main.set_frequency NNNNNNNN (Hz)', { cat: true }, (p) => setFreq(0)(p, 'main.set_frequency'));
  def('rig.set_frequency', ['int', 'double'], 'rig.set_frequency NNNNNNNN (Hz)', { cat: true }, (p) => setFreq(1)(p, 'rig.set_frequency'));
  for (const ab of ['A', 'B']) {
    def(`rig.get_vfo${ab}`, ['string'], `returns vfo ${ab} in Hertz (active VFO only)`, { cat: true }, async (p) => { await need(ab); return getFreq(); });
    def(`rig.set_vfo${ab}`, ['int', 'double'], `rig.set_vfo${ab} NNNNNNNN (Hz) (active VFO only)`, { cat: true }, async (p) => { await need(ab); return setFreq(0)(p, `rig.set_vfo${ab}`); });
  }

  // mode
  const getMode = () => { const s = liveFreq(); if (!s.mode) throw new XmlRpcFault(FAULT.NO_RADIO, 'Radio is not reporting a mode'); return s.mode; };
  const setMode = (ret) => async (p, name) => {
    paramCount(p, 1, name);
    const mode = toMode(p[0]);
    online();
    try { await radio.setMode(mode); } catch (e) { throw catFault(e); }
    radio.noteState({ mode, updated: Date.now() });
    return ret;
  };
  def('rig.get_mode', ['string'], 'returns current xcvr mode', getMode);
  def('rig.get_modes', ['array'], 'returns list of modes', () => [...MODES]);
  def('rig.set_mode', ['int', 'string'], 'set_mode MODE_NAME', { cat: true }, (p) => setMode(1)(p, 'rig.set_mode'));
  def('rig.get_sideband', ['string'], 'returns current xcvr sideband (U/L)', () => (LOWER_SIDEBAND.has(String(getMode()).toUpperCase()) ? 'L' : 'U'));
  for (const ab of ['A', 'B']) {
    def(`rig.get_mode${ab}`, ['string'], `returns vfo ${ab} mode (active VFO only)`, { cat: true }, async () => { await need(ab); return getMode(); });
    def(`rig.set_mode${ab}`, ['int', 'string'], `set_mode${ab} MODE_NAME (active VFO only)`, { cat: true }, async (p) => { await need(ab); return setMode(1)(p, `rig.set_mode${ab}`); });
  }

  // bandwidth
  def('rig.get_bw', ['array'], 'returns current bw [value, ""] (passband in Hz as reported by the radio)', { cat: true }, async () => {
    online();
    const r = await cat('m', 2);
    if (/^RPRT/.test(r[0])) throw new XmlRpcFault(FAULT.CAT, `Radio refused bandwidth read (${r[0]})`);
    const pb = String(parseInt(r[1], 10) || '');
    return [pb === '0' ? '' : pb, ''];
  });
  def('rig.get_bws', ['array'], 'returns array of bandwidths (generic table; the radio rounds to its own filters)', () => [['Bandwidth', ...BANDWIDTHS]]);
  def('rig.set_bw', ['int', 'int'], 'set_bw to index in rig.get_bws table', { cat: true }, async (p) => {
    paramCount(p, 1, 'rig.set_bw');
    if (!Number.isInteger(p[0]) || p[0] < 0 || p[0] >= BANDWIDTHS.length) throw new XmlRpcFault(FAULT.BAD_PARAMS, `bandwidth index ${String(p[0]).slice(0, 12)} out of range`);
    const s = liveFreq();
    if (!s.mode) throw new XmlRpcFault(FAULT.NO_RADIO, 'Radio is not reporting a mode');
    const r = await cat(`M ${s.mode} ${BANDWIDTHS[p[0]]}`);
    if (!/^RPRT 0/.test(r[0])) throw new XmlRpcFault(FAULT.CAT, `Radio refused bandwidth change (${r[0]})`);
    return 0;
  });

  // PTT
  def('rig.get_ptt', ['int'], 'returns state of PTT', () => (online().ptt ? 1 : 0));
  const setPtt = async (p, name) => {
    paramCount(p, 1, name);
    const v = typeof p[0] === 'boolean' ? (p[0] ? 1 : 0) : p[0];
    if (v !== 0 && v !== 1) throw new XmlRpcFault(FAULT.BAD_PARAMS, 'PTT state must be 0 or 1');
    online();
    try { await radio.setPtt(v === 1); } catch (e) { throw catFault(e); }
    return 0;
  };
  def('rig.set_ptt', ['int', 'int'], 'sets PTT on (1) or off (0)', { cat: true }, (p) => setPtt(p, 'rig.set_ptt'));
  def('rig.set_ptt_fast', ['int', 'int'], 'sets PTT on (1) or off (0)', { cat: true }, (p) => setPtt(p, 'rig.set_ptt_fast'));

  // VFO in use
  def('rig.get_AB', ['string'], 'returns vfo in use A or B (A when the radio cannot report it)', { cat: true }, async () => { online(); return (await activeVfo()) || 'A'; });
  def('rig.set_AB', ['int', 'string'], 'sets vfo in use A or B', { cat: true }, async (p) => {
    paramCount(p, 1, 'rig.set_AB');
    if (p[0] !== 'A' && p[0] !== 'B') throw new XmlRpcFault(FAULT.BAD_PARAMS, 'VFO must be "A" or "B"');
    online();
    const r = await cat(`V VFO${p[0]}`);
    if (!/^RPRT 0/.test(r[0])) throw new XmlRpcFault(FAULT.CAT, `Radio refused VFO change (${r[0]})`);
    return 0;
  });

  return M;
}

// ---- the server -------------------------------------------------------------------------------------------------
const CLIENT_TTL_MS = 15000; // a client with no open connection stays counted this long after its last request
const REQUEST_DEADLINE_MS = 8000;

/**
 * Listener lifecycle + HTTP/XML-RPC plumbing + client tracking for one radio.
 *
 * Client model: a client is one remote IP address plus its User-Agent (so fldigi and another flrig client on the same
 * host count separately, and every short-lived connection from one program counts once). It is counted from its first
 * request while it has at least one open connection, and for CLIENT_TTL_MS after its last request once all its
 * connections are gone (HTTP/1.0-style clients reconnect for every call). Connections that never complete a request
 * are never counted and are closed by the HTTP timeouts. Expired records are deleted by a periodic sweep.
 */
class FlrigXmlRpcServer extends EventEmitter {
  constructor({ getConfig, radio, version = 'cloudlog-desktop (flrig-compatible XML-RPC)', now = Date.now, ttlMs = CLIENT_TTL_MS, sweepMs = 5000, deadlineMs = REQUEST_DEADLINE_MS, httpImpl = http }) {
    super();
    this.getConfig = getConfig;
    this.radio = radio;
    this.now = now;
    this.ttlMs = ttlMs;
    this.sweepMs = sweepMs;
    this.deadlineMs = deadlineMs;
    this.http = httpImpl;
    this.methods = buildMethods({ radio, version });
    this.server = null;
    this.sockets = new Set();
    this.clients = new Map(); // key -> { address, agent, conns:Set, lastSeen }
    this.state = 'stopped'; // stopped | starting | listening | error
    this.error = '';
    this.timer = null;
    this.lastCount = 0;
    this.gen = 0;
    this.boundPort = null;
    this.boundHost = null;
  }

  status() {
    const c = xmlrpcConfig({ xmlrpc: this.getConfig() });
    return { enabled: c.enabled, state: this.state, listening: this.state === 'listening', port: this.boundPort || Number(c.port), bind: this.boundHost || c.bind, clients: this.clientCount(), error: this.error };
  }

  clientCount() {
    const t = this.now();
    let n = 0;
    for (const c of this.clients.values()) if (c.conns.size > 0 || t - c.lastSeen < this.ttlMs) n++;
    return n;
  }

  /** Drops expired client records; emits 'clients' when the count changed. */
  sweep() {
    const t = this.now();
    for (const [k, c] of this.clients) if (c.conns.size === 0 && t - c.lastSeen >= this.ttlMs) this.clients.delete(k);
    this._notify();
  }

  _notify() {
    const n = this.clientCount();
    if (n !== this.lastCount) { this.lastCount = n; this.emit('clients', n); }
  }

  _touch(req) {
    const addr = String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const agent = String(req.headers['user-agent'] || '').slice(0, 80);
    const key = `${addr}|${agent}`;
    let c = this.clients.get(key);
    if (!c) { c = { address: addr, agent, conns: new Set(), lastSeen: 0 }; this.clients.set(key, c); }
    c.lastSeen = this.now();
    const sock = req.socket;
    if (!c.conns.has(sock)) {
      c.conns.add(sock);
      sock.once('close', () => { c.conns.delete(sock); c.lastSeen = Math.max(c.lastSeen, this.now()); this._notify(); });
    }
    this._notify();
  }

  /** Starts listening. Resolves true once bound and accepting, false (with this.error set) if it could not. */
  async start() {
    if (this.server) await this.stop();
    const gen = ++this.gen;
    const cfg = xmlrpcConfig({ xmlrpc: this.getConfig() });
    this.error = '';
    const bad = validatePort(cfg.port);
    if (bad) { this.state = 'error'; this.error = bad; this.emit('state'); return false; }
    this.state = 'starting';
    this.emit('state');
    const srv = this.http.createServer((req, res) => this._onRequest(req, res));
    srv.keepAliveTimeout = 30000;
    srv.headersTimeout = 10000;
    srv.requestTimeout = 15000;
    srv.maxConnections = 64;
    srv.on('connection', (s) => { this.sockets.add(s); s.once('close', () => this.sockets.delete(s)); s.on('error', () => {}); });
    srv.on('clientError', (_e, s) => { try { s.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ } });
    const ok = await new Promise((resolve) => {
      srv.once('error', (e) => { this.error = `${e.code || e.message} on ${cfg.bind}:${cfg.port}`; resolve(false); });
      srv.listen(Number(cfg.port), cfg.bind, () => resolve(true));
    });
    if (gen !== this.gen) { if (ok) await new Promise((r) => srv.close(r)); return false; } // stopped/restarted while binding
    if (!ok) { this.state = 'error'; try { srv.close(); } catch { /* not listening */ } this.emit('state'); return false; }
    srv.on('error', (e) => { this.state = 'error'; this.error = `${e.code || e.message} on ${cfg.bind}:${cfg.port}`; this.emit('state'); });
    this.server = srv;
    this.boundPort = srv.address().port;
    this.boundHost = cfg.bind;
    this.state = 'listening';
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    if (this.timer.unref) this.timer.unref();
    this.emit('state');
    return true;
  }

  async stop() {
    this.gen++;
    clearInterval(this.timer);
    this.timer = null;
    const srv = this.server;
    this.server = null;
    if (srv) {
      const closed = new Promise((r) => srv.close(() => r()));
      if (srv.closeAllConnections) srv.closeAllConnections();
      for (const s of this.sockets) s.destroy();
      await closed;
    }
    this.sockets.clear();
    this.clients.clear();
    this.lastCount = 0;
    this.state = 'stopped';
    this.error = '';
    this.boundPort = null;
    this.boundHost = null;
    this.emit('state');
  }

  _reply(res, status, body, extra = {}) {
    if (res.headersSent || res.writableEnded) return;
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, { 'Content-Type': 'text/xml', 'Content-Length': buf.length, ...extra });
    res.end(buf);
  }

  _onRequest(req, res) {
    if (req.method !== 'POST') return this._reply(res, 405, '', { Allow: 'POST', 'Content-Type': 'text/plain' });
    const chunks = [];
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { dead = true; this._reply(res, 413, '', { Connection: 'close', 'Content-Type': 'text/plain' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => { dead = true; });
    req.on('end', async () => {
      if (dead) return;
      this._touch(req);
      let out;
      try { out = await this.handle(Buffer.concat(chunks).toString('utf8')); } catch (e) { out = faultXml(FAULT.INTERNAL, `Internal error: ${e.message}`); }
      this._reply(res, 200, out);
    });
  }

  /** Executes one methodCall body and returns the methodResponse XML (faults included). Never throws. */
  async handle(body) {
    let call;
    try { call = parseMethodCall(body); } catch (e) { return faultXml(FAULT.PARSE, `Malformed request: ${e.message}`); }
    const m = this.methods.get(call.method);
    if (!m) return faultXml(FAULT.NO_METHOD, `Method not found: ${call.method.slice(0, 60)}`);
    try {
      const work = m.cat ? this.radio.exclusive(() => m.fn(call.params, m.name)) : Promise.resolve().then(() => m.fn(call.params, m.name));
      let t;
      const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new XmlRpcFault(FAULT.TIMEOUT, 'Timed out waiting for the radio')), this.deadlineMs); });
      const result = await Promise.race([work, timeout]).finally(() => clearTimeout(t));
      return responseXml(result === undefined ? 0 : result);
    } catch (e) {
      if (e instanceof XmlRpcFault) return faultXml(e.faultCode, e.message);
      return faultXml(FAULT.INTERNAL, `Internal error: ${e.message || e}`);
    }
  }
}

module.exports = {
  FlrigXmlRpcServer, XmlRpcFault, FAULT, Mutex, MODES, BANDWIDTHS, XMLRPC_DEFAULTS, CLIENT_TTL_MS,
  xmlrpcConfig, validatePort, validateXmlrpcSharing, buildMethods,
  parseMethodCall, parseXml, encodeValue, decodeValue, responseXml, faultXml, XmlDouble,
};
