'use strict';
/*
 * What kind of installation is running, and may it update itself?
 *
 * Only a real AppImage may self-update. "Real" is established from runtime facts, not from the OS or a file suffix:
 *   - the AppImage runtime exports APPIMAGE (path of the .AppImage file) and APPDIR (its mount point);
 *   - this process executes from inside APPDIR (an APPIMAGE variable inherited by a program started from another
 *     AppImage's shell does not count);
 *   - APPIMAGE (symlinks resolved) is an existing regular file starting with the ELF magic and the AppImage type 1/2
 *     marker ("AI" + 0x01/0x02 at offset 8).
 * Everything else - .deb, other packages, development runs - is notify-only. No package manager is ever invoked; the
 * Debian check only READS dpkg's file list.
 */
const fs = require('fs');
const path = require('path');
const { ARCH_TOKENS } = require('./assets');

const DPKG_LIST = '/var/lib/dpkg/info/cloudlog-desktop.list';
const LABELS = Object.freeze({
  appimage: 'AppImage', deb: 'Debian package (.deb)', packaged: 'Other installed package', development: 'Development run (not packaged)',
});

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function hasAppImageMagic(fsx, file) {
  let fd;
  try {
    fd = fsx.openSync(file, 'r');
    const buf = Buffer.alloc(12);
    const n = fsx.readSync(fd, buf, 0, 12, 0);
    return n >= 11 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46 && buf[8] === 0x41 && buf[9] === 0x49 && (buf[10] === 0x01 || buf[10] === 0x02);
  } catch { return false; } finally { if (fd !== undefined) { try { fsx.closeSync(fd); } catch { /* ignore */ } } }
}

/**
 * Can the AppImage file at `realPath` be replaced in place by this user, without privileges? { ok, reason }.
 * Replacement writes a temporary file in the same directory and renames it over the AppImage, so the DIRECTORY must be
 * writable; the file must be ours (replacing a file owned by someone else would silently change its owner).
 */
function checkReplaceable(realPath, { fs: fsx = fs, getuid = process.getuid ? () => process.getuid() : null } = {}) {
  let st;
  try { st = fsx.statSync(realPath); } catch (e) { return { ok: false, reason: `The AppImage cannot be read (${e.code || e.message})` }; }
  if (!st.isFile()) return { ok: false, reason: 'The AppImage path is not a regular file' };
  if ((st.mode & 0o111) === 0) return { ok: false, reason: 'The AppImage is not executable' };
  const dir = path.dirname(realPath);
  try { fsx.accessSync(dir, fsx.constants ? fsx.constants.W_OK : fs.constants.W_OK); } catch (e) {
    return { ok: false, reason: `The folder ${dir} is not writable by this user (${e.code || e.message}); updating there would need elevated privileges` };
  }
  const uid = getuid ? getuid() : null;
  if (uid !== null && uid !== 0 && st.uid !== uid) return { ok: false, reason: 'The AppImage file belongs to another user' };
  return { ok: true, reason: '' };
}

/**
 * Detect the installation. Inputs are injectable for tests.
 * Returns { type, label, selfUpdate, reason, appImagePath, realPath, arch, platform }.
 */
function detectInstallation({ env = process.env, platform = process.platform, arch = process.arch, execPath = process.execPath, isPackaged = true, fs: fsx = fs, getuid } = {}) {
  const base = { arch, platform, appImagePath: null, realPath: null };
  const done = (type, selfUpdate, reason, extra = {}) => ({ ...base, ...extra, type, label: LABELS[type], selfUpdate, reason });
  if (!isPackaged) return done('development', false, 'A development run is never updated in place; use the release page.');
  if (platform === 'linux' && env.APPIMAGE && env.APPDIR && path.isAbsolute(env.APPIMAGE) && path.isAbsolute(env.APPDIR)) {
    let appDir = env.APPDIR; let exec = execPath;
    try { appDir = fsx.realpathSync(env.APPDIR); } catch { /* keep the given path */ }
    try { exec = fsx.realpathSync(execPath); } catch { /* keep the given path */ }
    if (within(exec, appDir) || within(execPath, env.APPDIR)) {
      let real = null;
      try { real = fsx.realpathSync(env.APPIMAGE); } catch { /* handled below */ }
      if (!real) return done('appimage', false, 'The AppImage file could not be located, so it cannot be replaced.', { appImagePath: env.APPIMAGE });
      if (!hasAppImageMagic(fsx, real)) return done('packaged', false, 'The APPIMAGE variable does not point to an AppImage file.');
      if (!ARCH_TOKENS[arch]) return done('appimage', false, `No AppImage is published for the ${arch} architecture.`, { appImagePath: env.APPIMAGE, realPath: real });
      const r = checkReplaceable(real, { fs: fsx, getuid });
      return done('appimage', r.ok, r.ok ? '' : r.reason, { appImagePath: env.APPIMAGE, realPath: real });
    }
  }
  if (platform === 'linux') {
    try {
      const list = fsx.readFileSync(DPKG_LIST, 'utf8');
      if (list.split('\n').some((l) => l === execPath)) return done('deb', false, 'Installed from a Debian package: download the new .deb from the release page and install it with your package manager.');
    } catch { /* not a dpkg install, or unreadable */ }
  }
  return done('packaged', false, 'Only AppImage installations update themselves; use the release page for this installation.');
}

module.exports = { LABELS, DPKG_LIST, detectInstallation, checkReplaceable, hasAppImageMagic };
