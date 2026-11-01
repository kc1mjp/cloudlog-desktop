'use strict';
/*
 * Choosing the AppImage asset for this machine, and its published checksum file.
 *
 * Asset names are used ONLY to pick the right file (extension + CPU architecture token), never to learn a version.
 * Names look like cloudlog-desktop_<version>_<arch>.AppImage (electron-builder artifactName); the checksum for an asset
 * is the sibling asset "<asset name>.sha256" (sha256sum format, see checksum.js).
 */

/** Architecture tokens electron-builder / AppImage tooling uses in file names, per Node's process.arch. */
const ARCH_TOKENS = Object.freeze({
  x64: ['x86_64', 'x64', 'amd64'],
  arm64: ['arm64', 'aarch64'],
  ia32: ['i386', 'i686', 'ia32'],
  arm: ['armv7l', 'armhf', 'arm'],
});

class AssetError extends Error {
  constructor(code, message) { super(message); this.name = 'AssetError'; this.code = code; }
}

const CHECKSUM_SUFFIX = '.sha256';

/**
 * Returns { asset, checksumAsset }. Throws AssetError (code: unsupported-platform | no-asset | ambiguous-asset |
 * no-checksum | ambiguous-checksum) when no safe choice exists - the caller then falls back to notify-only.
 */
function selectAppImageAsset(entry, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'linux') throw new AssetError('unsupported-platform', `AppImage updates are only available on Linux (this is ${platform})`);
  const tokens = ARCH_TOKENS[arch];
  if (!tokens) throw new AssetError('unsupported-platform', `No AppImage is published for the ${arch} architecture`);
  // The token is the last part of the name before ".AppImage" ("x86_64" itself contains an underscore, so match suffixes).
  const matches = (entry.assets || []).filter((a) => tokens.some((t) => a.name.endsWith(`_${t}.AppImage`)));
  if (matches.length === 0) throw new AssetError('no-asset', `This release has no AppImage for ${arch} (${tokens[0]})`);
  if (matches.length > 1) throw new AssetError('ambiguous-asset', `This release has more than one AppImage for ${arch}: ${matches.map((a) => a.name).join(', ')}`);
  const asset = matches[0];
  const sums = (entry.assets || []).filter((a) => a.name === `${asset.name}${CHECKSUM_SUFFIX}`);
  if (sums.length === 0) throw new AssetError('no-checksum', `This release does not publish a checksum for ${asset.name}`);
  if (sums.length > 1) throw new AssetError('ambiguous-checksum', `This release publishes more than one checksum for ${asset.name}`);
  return { asset, checksumAsset: sums[0] };
}

module.exports = { ARCH_TOKENS, CHECKSUM_SUFFIX, AssetError, selectAppImageAsset };
