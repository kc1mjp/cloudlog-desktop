'use strict';
/*
 * Checksums. The release workflow publishes, next to every package, a file "<package name>.sha256" in the format of
 * `sha256sum`:   <64 hex digits><space><space or *><file name>
 *
 * IMPORTANT: a checksum published alongside a download protects against corrupted or truncated downloads and against a
 * mismatched asset. It is NOT independent publisher authentication: anyone who can replace the release asset can replace
 * the checksum file too. (The file comes over TLS from the same GitHub release.)
 */
const fs = require('fs');
const crypto = require('crypto');

class ChecksumError extends Error {
  /** code: missing | malformed | ambiguous | mismatch */
  constructor(code, message) { super(message); this.name = 'ChecksumError'; this.code = code; }
}

const LINE_RE = /^([0-9a-fA-F]{64}) [ *](.+)$/;

/**
 * Extract the SHA-256 for exactly `assetName`. Lines for other file names are ignored (so a combined SHA256SUMS-style
 * file works too); every non-blank line must be well formed; the name must appear exactly once with one digest.
 */
function parseChecksumFile(text, assetName) {
  if (typeof text !== 'string' || !text.trim()) throw new ChecksumError('missing', 'The published checksum file is empty');
  if (text.includes('\u0000')) throw new ChecksumError('malformed', 'The published checksum file is not valid text');
  const digests = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = LINE_RE.exec(line);
    if (!m) throw new ChecksumError('malformed', 'The published checksum file is malformed (expected "<sha256>  <file name>")');
    if (m[2] === assetName) digests.add(m[1].toLowerCase());
  }
  if (digests.size === 0) throw new ChecksumError('missing', `The published checksum file has no entry for ${assetName}`);
  if (digests.size > 1) throw new ChecksumError('ambiguous', `The published checksum file lists different checksums for ${assetName}`);
  return [...digests][0];
}

/** SHA-256 of the complete file as it is on disk. */
function sha256File(file, { fsImpl = fs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsImpl.createReadStream(file);
    const onAbort = () => { stream.destroy(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(hash.digest('hex')); });
  });
}

module.exports = { ChecksumError, parseChecksumFile, sha256File };
