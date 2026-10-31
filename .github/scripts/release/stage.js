'use strict';
/*
 * Copy the packages built for ONE package type out of the build output directory into the upload
 * directory, so later builds that clean/overwrite the output directory cannot lose them.
 *
 *   PACKAGE_TYPE  e.g. appimage | deb (must exist in .github/release-config.json)
 *   UPLOAD_DIR    destination (default: release-upload)
 *
 * A .deb is renamed to its Debian-canonical name (version with ~ and revision, e.g.
 * name_2610.1.0~beta.2-1_amd64.deb). Every staged package also gets a `<package name>.sha256` checksum file (SHA-256,
 * `sha256sum` format) that is uploaded with it. The output directory comes from package.json build.directories.output (not assumed). Fails if no
 * package was produced or a file name does not carry the version (names must be unambiguous).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { loadConfig } = require('./config');
const { derive } = require('./platform-versions');

const CHECKSUM_SUFFIX = '.sha256';

function sha256Hex(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function stage({ root, type, uploadDir, config = loadConfig() }) {
  const entry = config.packageTypes.find((p) => p.type === type);
  if (!entry) throw new Error(`Unknown package type ${JSON.stringify(type)}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const outDir = path.resolve(root, (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'dist');
  if (!fs.existsSync(outDir)) throw new Error(`Build output directory not found: ${outDir}`);
  const found = fs.readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isFile() && entry.extensions.some((x) => d.name.endsWith(x)))
    .map((d) => d.name);
  if (found.length === 0) throw new Error(`No ${entry.extensions.join('/')} package found in ${outDir} for type ${type}`);
  fs.mkdirSync(uploadDir, { recursive: true });
  const staged = [];
  for (const name of found) {
    if (!name.includes(pkg.version)) throw new Error(`Package ${name} does not contain version ${pkg.version} in its name`);
    let outName = name;
    if (entry.verify === 'deb') {
      // The native package version is derived from the canonical version; fail if the tooling disagrees.
      const actual = execFileSync('dpkg-deb', ['-f', path.join(outDir, name), 'Version'], { encoding: 'utf8' }).trim();
      const expected = derive(pkg.version).debVersion;
      if (actual !== expected) throw new Error(`${name}: Debian Version is ${actual}, expected ${expected} (derived from ${pkg.version})`);
      // Debian convention: <name>_<version incl. ~ and revision>_<arch>.deb
      outName = name.split(pkg.version).join(expected);
    }
    const dest = path.join(uploadDir, outName);
    if (fs.existsSync(dest)) throw new Error(`Refusing to overwrite already staged file ${dest}`);
    fs.copyFileSync(path.join(outDir, name), dest);
    staged.push(outName);
    // Checksum published next to the package, in `sha256sum` format ("<hex>  <file name>"), named exactly like the package.
    // The in-app updater verifies an AppImage against it. It detects corruption and a mismatched asset; it is NOT
    // independent publisher authentication (see docs/UPDATES.md).
    const sum = path.join(uploadDir, `${outName}${CHECKSUM_SUFFIX}`);
    if (fs.existsSync(sum)) throw new Error(`Refusing to overwrite already staged file ${sum}`);
    fs.writeFileSync(sum, `${sha256Hex(dest)}  ${outName}\n`);
    staged.push(`${outName}${CHECKSUM_SUFFIX}`);
  }
  return staged;
}

if (require.main === module) {
  try {
    const files = stage({ root: process.cwd(), type: process.env.PACKAGE_TYPE, uploadDir: path.resolve(process.env.UPLOAD_DIR || 'release-upload') });
    console.log(`Staged: ${files.join(', ')}`);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}

module.exports = { stage, sha256Hex, CHECKSUM_SUFFIX };
