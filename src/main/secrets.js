'use strict';
/*
 * Credential storage for the callbook passwords - the ONLY place that decides how they are kept.
 *
 * The app has no earlier secure store (the Cloudlog API key sits in settings.json in plain text), so
 * this uses Electron's safeStorage (libsecret / kwallet / gnome-keyring on Linux) when the OS keyring
 * is genuinely available, and otherwise falls back to the same settings.json storage the Cloudlog key
 * already uses. Encrypted values carry an "enc1:" prefix so both forms can coexist and a value saved
 * without a keyring is still readable (and re-encrypted the next time it is saved).
 *
 * Passwords never leave the main process: the renderer only learns whether one is stored.
 */
const PREFIX = 'enc1:';

/** @param {{safeStorage?: object}} [deps] safeStorage is injectable so tests need no Electron. */
function createSecretBox({ safeStorage } = {}) {
  const usable = () => {
    try {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
      // On Linux without a keyring Electron silently uses a hard-coded key ("basic_text"): no better than plain text.
      if (typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch {
      return false;
    }
  };

  return {
    /** True when values are being encrypted with the OS keyring. */
    encrypted: usable,
    /** Plain text -> storable string. */
    seal(plain) {
      const s = String(plain == null ? '' : plain);
      if (!s) return '';
      if (!usable()) return s;
      try { return PREFIX + safeStorage.encryptString(s).toString('base64'); } catch { return s; }
    },
    /** Stored string -> plain text ('' if it cannot be decrypted, e.g. the keyring changed). */
    open(stored) {
      const s = String(stored == null ? '' : stored);
      if (!s.startsWith(PREFIX)) return s;
      try { return safeStorage.decryptString(Buffer.from(s.slice(PREFIX.length), 'base64')); } catch { return ''; }
    },
  };
}

module.exports = { createSecretBox, PREFIX };
