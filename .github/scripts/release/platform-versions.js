'use strict';
/*
 * Platform package versions DERIVED from the canonical version (package.json). They are never stored or
 * edited independently. CLI: node platform-versions.js 2610.1.0-beta.2  (prints JSON)
 *
 * For 2610.1.0-beta.2:
 *   DEB version        2610.1.0~beta.2-1   (~ sorts below the stable 2610.1.0; -1 is the Debian revision)
 *   RPM Version        2610.1.0~beta.2     RPM Release 1
 *   AppImage identity  2610.1.0-beta.2     (the canonical version, in the file name)
 *   Windows file ver.  2610.1.0.<build>    four numeric parts, each <= 65535
 *   macOS short ver.   2610.1.0            macOS build version <build> (numeric)
 *
 * <build> orders the stages inside one MAJOR.MINOR.PATCH: alpha.N = 1000+N, beta.N = 2000+N,
 * rc.N = 3000+N, stable = 9000 (N is 1..999). The allocation is a project choice, not a platform rule;
 * if it changes, only STAGE_BUILD_BASE here changes.
 *
 * electron-builder already converts "-" to "~" for deb and rpm versions, so the canonical version needs no
 * override for those targets; stage.js verifies the built .deb really carries the derived version.
 */
const { parseVersion } = require('./version');

const DEB_REVISION = '1';
const RPM_RELEASE = '1';
const STAGE_BUILD_BASE = { alpha: 1000, beta: 2000, rc: 3000, stable: 9000 };
const WINDOWS_MAX = 65535n;

function derive(text) {
  const v = parseVersion(text);
  const core = `${v.yymm}.${v.release}.${v.patch}`;
  const pre = v.stage ? `~${v.stage}.${v.number}` : '';
  if (v.number > 999n) throw new Error(`Prerelease number ${v.number} is too large for the build-number scheme (max 999)`);
  const build = STAGE_BUILD_BASE[v.stage || 'stable'] + Number(v.number);
  for (const [name, n] of [['YYMM', v.yymm], ['RELEASE', v.release], ['PATCH', v.patch], ['build', BigInt(build)]]) {
    if (n > WINDOWS_MAX) throw new Error(`${name} component ${n} exceeds the Windows file-version limit of 65535`);
  }
  return {
    canonical: v.text,
    tag: v.tag,
    debVersion: `${core}${pre}-${DEB_REVISION}`,
    rpmVersion: `${core}${pre}`,
    rpmRelease: RPM_RELEASE,
    appImageVersion: v.text,
    windowsFileVersion: `${core}.${build}`,
    macShortVersion: core,
    macBuildVersion: String(build)
  };
}

if (require.main === module) {
  try { console.log(JSON.stringify(derive(process.argv[2]), null, 2)); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { derive, STAGE_BUILD_BASE, DEB_REVISION };
