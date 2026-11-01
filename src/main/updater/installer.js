'use strict';
/*
 * Download, verify and replace an AppImage.
 *
 *   1. fetch the published checksum (tiny; a missing/bad one stops everything before a large download)
 *   2. check free disk space, download into a temporary file in the SAME directory as the installed AppImage
 *      (so the final rename is atomic) - the installed file is never written during the download
 *   3. re-read the complete file from disk and compare its SHA-256 with the published value
 *   4. re-validate (settings / eligibility may have changed meanwhile)
 *   5. critical section - cannot be cancelled: link the old file to a backup, rename the new file over the installed
 *      path (same name, same location), check the result, roll back from the backup if anything is wrong
 *   6. remove the temporary and backup files (also after failures and cancellation)
 *
 * The target is the REAL file (symlinks resolved): a symlink to the AppImage stays a symlink, and only the file it points
 * to is replaced. If the resolved path changes while downloading, nothing is replaced.
 * No elevated privileges are requested; a path this user cannot write is reported, not worked around.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { parseChecksumFile, sha256File, ChecksumError } = require('./checksum');
const { checkReplaceable } = require('./install-type');

const MAX_PACKAGE_BYTES = 1.5 * 1024 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 8 * 1024;
const DISK_MARGIN_BYTES = 64 * 1024 * 1024;

class InstallError extends Error {
  /** code: cancelled | checksum-* | disk-space | download | not-writable | path-changed | replace | rollback | unsafe */
  constructor(code, message) { super(message); this.name = 'InstallError'; this.code = code; }
}

const isAbort = (e, signal) => (signal && signal.aborted) || (e && e.name === 'AbortError');
const randomId = () => crypto.randomBytes(6).toString('hex');

function ensureHttps(url) {
  let u;
  try { u = new URL(url); } catch { throw new InstallError('download', 'The download address is invalid'); }
  if (u.protocol !== 'https:') throw new InstallError('download', 'Refusing a download that is not served over HTTPS');
}

async function fetchChecked(fetchImpl, url, signal) {
  ensureHttps(url);
  let res;
  try { res = await fetchImpl(url, { signal, redirect: 'follow', headers: { 'User-Agent': 'cloudlog-desktop-updater' } }); } catch (e) {
    if (isAbort(e, signal)) throw new InstallError('cancelled', 'The update was cancelled');
    throw new InstallError('download', 'The download could not be started (no network connection or GitHub is unreachable)');
  }
  if (res.url && !/^https:/i.test(res.url)) throw new InstallError('download', 'Refusing a download that was redirected away from HTTPS');
  if (!res.ok) throw new InstallError('download', `The download failed (HTTP ${res.status})`);
  return res;
}

async function fetchChecksumText(fetchImpl, url, signal) {
  const res = await fetchChecked(fetchImpl, url, signal);
  try {
    const text = await res.text();
    if (text.length > MAX_CHECKSUM_BYTES) throw new ChecksumError('malformed', 'The published checksum file is unexpectedly large');
    return text;
  } catch (e) {
    if (e instanceof ChecksumError) throw e;
    if (isAbort(e, signal)) throw new InstallError('cancelled', 'The update was cancelled');
    throw new InstallError('download', 'The checksum file could not be downloaded');
  }
}

function checkDiskSpace(fsx, dir, needed) {
  if (typeof fsx.statfsSync !== 'function' || !needed) return;
  let s;
  try { s = fsx.statfsSync(dir); } catch { return; } // cannot tell: a full disk is still caught while writing
  const free = Number(s.bavail) * Number(s.bsize);
  if (Number.isFinite(free) && free < needed + DISK_MARGIN_BYTES) {
    throw new InstallError('disk-space', `Not enough free disk space in ${dir} (need about ${Math.ceil((needed + DISK_MARGIN_BYTES) / 1048576)} MB)`);
  }
}

async function downloadTo(fetchImpl, url, file, { fsx, signal, expectedSize, onProgress }) {
  const res = await fetchChecked(fetchImpl, url, signal);
  const headerLen = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
  const total = Number.isFinite(expectedSize) ? expectedSize : (Number.isFinite(headerLen) ? headerLen : null);
  if (Number.isFinite(expectedSize) && Number.isFinite(headerLen) && headerLen !== expectedSize) throw new InstallError('download', 'The download size does not match the published asset size');
  if (!res.body) throw new InstallError('download', 'The download had no content');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_PACKAGE_BYTES || (total !== null && bytes > total)) return cb(new InstallError('download', 'The download is larger than expected'));
      if (onProgress) onProgress(bytes, total);
      cb(null, chunk);
    },
  });
  const out = fsx.createWriteStream(file, { flags: 'wx', mode: 0o600 });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, out, { signal });
  } catch (e) {
    if (e instanceof InstallError) throw e;
    if (isAbort(e, signal)) throw new InstallError('cancelled', 'The update was cancelled');
    if (e && e.code === 'ENOSPC') throw new InstallError('disk-space', 'The disk is full; the update was not installed');
    if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) throw new InstallError('not-writable', `The update could not be written (${e.code})`);
    throw new InstallError('download', 'The download was interrupted');
  }
  if (total !== null && bytes !== total) throw new InstallError('download', 'The download was incomplete');
  return bytes;
}

function fsyncPath(fsx, file) {
  let fd;
  try { fd = fsx.openSync(file, 'r+'); fsx.fsyncSync(fd); } catch { /* best effort */ } finally { if (fd !== undefined) { try { fsx.closeSync(fd); } catch { /* ignore */ } } }
}

/**
 * Install `asset` over the AppImage whose real path is `target`.
 * opts: { target, asset: {name,url,size}, checksumAsset: {url}, fetchImpl, fs, signal, onPhase(phase), onProgress(bytes,total),
 *         revalidate(): {ok, reason}, resolveTarget(): real path now, getuid }
 * Phases: checksum -> downloading -> verifying -> installing. Resolves { path, bytes }. Throws InstallError / ChecksumError.
 */
async function installAppImage(opts) {
  const { target, asset, checksumAsset, fetchImpl = fetch, signal, onPhase = () => {}, onProgress, revalidate = () => ({ ok: true }), getuid } = opts;
  const fsx = opts.fs || fs;
  const resolveTarget = opts.resolveTarget || (() => fsx.realpathSync(target));
  const dir = path.dirname(target);
  const base = path.basename(target);
  const id = randomId();
  const tmp = path.join(dir, `.${base}.update-${id}.tmp`);
  const backup = path.join(dir, `.${base}.previous-${id}`);
  let haveTmp = false; let haveBackup = false; let keepBackup = false;
  const rm = (f) => { try { fsx.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') { /* leave it; reported below if it matters */ } } };
  const cancelIfAborted = () => { if (signal && signal.aborted) throw new InstallError('cancelled', 'The update was cancelled'); };

  try {
    const pre = checkReplaceable(target, { fs: fsx, getuid });
    if (!pre.ok) throw new InstallError('not-writable', pre.reason);
    const origStat = fsx.statSync(target);

    onPhase('checksum');
    const expected = parseChecksumFile(await fetchChecksumText(fetchImpl, checksumAsset.url, signal), asset.name);
    cancelIfAborted();

    checkDiskSpace(fsx, dir, Number.isFinite(asset.size) ? asset.size : 0);
    onPhase('downloading');
    haveTmp = true; // 'wx' creates it; cleanup below tolerates it never having been created
    const bytes = await downloadTo(fetchImpl, asset.url, tmp, { fsx, signal, expectedSize: Number.isFinite(asset.size) ? asset.size : undefined, onProgress });
    fsyncPath(fsx, tmp);

    onPhase('verifying');
    const actual = await sha256File(tmp, { fsImpl: fsx, signal }).catch((e) => { if (isAbort(e, signal)) throw new InstallError('cancelled', 'The update was cancelled'); throw e; });
    if (actual !== expected) throw new ChecksumError('mismatch', 'The downloaded file does not match its published checksum; it was not installed');

    // Keep the installed program's permissions (and make sure it stays executable).
    fsx.chmodSync(tmp, (origStat.mode & 0o7777) | 0o100);
    cancelIfAborted();
    const rv = await revalidate();
    if (rv && rv.ok === false) throw new InstallError('cancelled', rv.reason || 'The update is no longer eligible');
    let nowReal;
    try { nowReal = resolveTarget(); } catch { throw new InstallError('path-changed', 'The installed AppImage could not be found any more; nothing was replaced'); }
    if (nowReal !== target) throw new InstallError('path-changed', 'The installed AppImage path changed during the download; nothing was replaced');

    // ---- critical section: from here on the update is not cancelled ----
    onPhase('installing');
    try {
      fsx.linkSync(target, backup); haveBackup = true;                       // old inode stays reachable
    } catch {
      try { fsx.copyFileSync(target, backup); haveBackup = true; } catch (e) {
        throw new InstallError(e && e.code === 'ENOSPC' ? 'disk-space' : 'not-writable', 'The previous version could not be backed up, so it was not replaced');
      }
    }
    try {
      fsx.renameSync(tmp, target);                                            // atomic: same directory, same filesystem
      haveTmp = false;
    } catch (e) {
      throw new InstallError(e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') ? 'not-writable' : 'replace', `The AppImage could not be replaced (${(e && e.code) || 'error'}); the previous version is unchanged`);
    }
    let ok = false;
    try { const st = fsx.statSync(target); ok = st.isFile() && st.size === bytes && (st.mode & 0o100) !== 0; } catch { ok = false; }
    if (!ok) {
      try { fsx.renameSync(backup, target); haveBackup = false; } catch {
        keepBackup = true;                                                    // the only copy of the previous version: never delete it
        throw new InstallError('rollback', `The update could not be confirmed and the previous version could not be restored automatically; it is saved as ${backup}`);
      }
      throw new InstallError('replace', 'The replaced file failed a final check; the previous version was restored');
    }
    fsyncPath(fsx, target);
    return { path: target, bytes };
  } finally {
    if (haveTmp) rm(tmp);
    if (haveBackup && !keepBackup) rm(backup);    // success (no longer needed) or never replaced (original still in place)
  }
}

module.exports = { InstallError, installAppImage, MAX_PACKAGE_BYTES };
