'use strict';
/*
 * WSJT-X / JTDX UDP (and multicast) wire format.
 *   header  = uint32 magic 0xadbccbda, uint32 schema, uint32 message type (all big-endian)
 *   type 0  = Heartbeat   : utf8 id, uint32 max schema, utf8 version
 *   type 12 = Logged ADIF : utf8 id, utf8 ADIF text
 *   utf8    = uint32 byte length followed by that many bytes (0xffffffff = null string)
 * Unlike the reference script this never throws: a truncated or odd datagram yields `malformed: true`.
 */
const WSJTX_MAGIC = 0xadbccbda;
const MSG_HEARTBEAT = 0;
const MSG_LOGGED_ADIF = 12;
const NULL_LEN = 0xffffffff;

class Reader {
  constructor(buf, off) { this.buf = buf; this.off = off; }

  u32() {
    if (this.off + 4 > this.buf.length) throw new RangeError('truncated message');
    const v = this.buf.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }

  /** `enc` is 'utf8' for ids/versions and 'latin1' for ADIF (the ADIF parser works on byte-per-char text). */
  str(enc) {
    const len = this.u32();
    if (len === NULL_LEN) return '';
    if (this.off + len > this.buf.length) throw new RangeError('truncated string');
    const s = this.buf.toString(enc, this.off, this.off + len);
    this.off += len;
    return s;
  }
}

/**
 * Decode one datagram. Returns null when it is not a WSJT-X/JTDX frame at all (no magic number), otherwise
 * { schema, type, heartbeat?, adif?, malformed? }. `heartbeat` is only set for a fully valid Heartbeat message.
 */
function parseWsjtxDatagram(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.readUInt32BE(0) !== WSJTX_MAGIC) return null;
  const out = { schema: buf.readUInt32BE(4), type: buf.readUInt32BE(8) };
  try {
    const r = new Reader(buf, 12);
    if (out.type === MSG_HEARTBEAT) {
      const id = r.str('utf8');
      const maxSchema = r.u32();
      const version = r.str('utf8');
      out.heartbeat = { id, maxSchema, version };
    } else if (out.type === MSG_LOGGED_ADIF) {
      r.str('utf8'); // client id
      out.adif = r.str('latin1');
    }
  } catch {
    out.malformed = true;
    delete out.heartbeat;
    delete out.adif;
  }
  return out;
}

module.exports = { WSJTX_MAGIC, MSG_HEARTBEAT, MSG_LOGGED_ADIF, parseWsjtxDatagram };
