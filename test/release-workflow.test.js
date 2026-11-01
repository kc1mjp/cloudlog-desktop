'use strict';
// Tests for the release workflow support code (scripts/release/*) and the workflow wiring.
// No network and no remote changes; git tests use throwaway local repositories.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const V = require('../.github/scripts/release/version');
const { plan } = require('../.github/scripts/release/plan');
const { stage, sha256Hex } = require('../.github/scripts/release/stage');
const { prepare } = require('../.github/scripts/release/prepare-release');
const { loadConfig } = require('../.github/scripts/release/config');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---- parsing / ordering ------------------------------------------------------------------------
test('parseVersion accepts CalVer stable and alpha/beta/rc versions', () => {
  const s = V.parseVersion('2610.1.0');
  assert.equal(s.stage, null);
  assert.equal(s.prerelease, false);
  assert.equal(s.tag, 'v2610.1.0');
  const b = V.parseVersion('2610.1.2-beta.3');
  assert.equal(b.stage, 'beta');
  assert.equal(b.number, 3n);
  assert.equal(b.prerelease, true);
  assert.equal(b.tag, 'v2610.1.2-beta.3');
  for (const ok of ['2601.1.0-beta.1', '2612.10.10-rc.12', '2610.1.0-alpha.1', '9912.1.0']) assert.doesNotThrow(() => V.parseVersion(ok), ok);
});

test('parseVersion rejects malformed versions with a clear message', () => {
  const bad = ['', '1', '2601.1', '2601.1.0.0', 'v2601.1.0', '2601.01.0-beta.01', '2601.1.0-beta.01', '2601.01.0',
    '2601.1.00', '2601.0.0', '2601.1.0-beta.0', '2613.1.0', '2600.1.0', '0001.1.0', '601.1.0', '26010.1.0',
    '2601.1.0-gamma.1', '2601.1.0-beta', '2601.1.0-beta.', '2601.1.0-beta.1.2', '2601.1.0-Beta.1', '2601.1.0-b',
    '2601.1.0b', '2601.1.0+build', '0.4.4', '0.4.4b', '0.4.4-b', '2601.1.0 ; rm -rf /', '$(id)'];
  for (const text of bad) {
    assert.throws(() => V.parseVersion(text), (e) => e instanceof V.ReleaseVersionError && /YYMM\.RELEASE\.PATCH/.test(e.message), text);
  }
  assert.throws(() => V.parseVersion(undefined), /Invalid application version/);
});

test('ordering: alpha < beta < rc < stable, then patch/release/YYMM; numeric not lexicographic', () => {
  const order = ['2610.1.0-alpha.1', '2610.1.0-alpha.2', '2610.1.0-alpha.10', '2610.1.0-beta.1', '2610.1.0-beta.2', '2610.1.0-beta.10',
    '2610.1.0-rc.1', '2610.1.0-rc.2', '2610.1.0', '2610.1.1-alpha.1', '2610.1.1', '2610.1.9', '2610.1.10-beta.1', '2610.1.10',
    '2610.2.0-beta.1', '2610.2.0', '2610.10.0', '2611.1.0-alpha.1', '2611.1.0', '2701.1.0-beta.1'];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      const c = V.compareVersions(V.parseVersion(order[i]), V.parseVersion(order[j]));
      assert.equal(Math.sign(c), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
    }
  }
});

test('ordering matches SemVer for the same strings (cross-check with the semver package when present)', (t) => {
  let semver;
  try { semver = require('semver'); } catch { return t.skip('semver package not installed'); }
  const list = ['2610.1.0-alpha.1', '2610.1.0-beta.2', '2610.1.0-beta.10', '2610.1.0-rc.1', '2610.1.0', '2610.1.1-beta.1', '2611.1.0'];
  for (const a of list) for (const b of list) {
    assert.equal(Math.sign(V.compareVersions(V.parseVersion(a), V.parseVersion(b))), Math.sign(semver.compare(a, b)), `${a} vs ${b}`);
  }
  assert.ok(semver.valid('2610.1.2-beta.3'));
});

test('highestVersionTag ignores unrelated tags (including old 0.x tags)', () => {
  const tags = ['latest', 'nightly', 'v0.4.4', 'v0.4.4b', 'release-9.9.9', 'v9', 'v2610.1', 'v2610.1.0-beta.2', 'v2610.1.0-gamma.1', 'x2699.1.0', 'v2610.1.0-beta.1'];
  assert.equal(V.highestVersionTag(tags).tag, 'v2610.1.0-beta.2');
  assert.equal(V.highestVersionTag(['foo', 'v0.4.4']), null);
});

// ---- decision table -----------------------------------------------------------------------------
const TABLE = [
  [[], '2610.1.0', true, false],
  [[], '2610.1.0-alpha.1', true, true],
  [['v2610.1.0-alpha.1'], '2610.1.0-alpha.2', true, true],
  [['v2610.1.0-alpha.2'], '2610.1.0-beta.1', true, true],
  [['v2610.1.0-beta.2'], '2610.1.0-rc.1', true, true],
  [['v2610.1.0-rc.1'], '2610.1.0', true, false],
  [['v2610.1.0-alpha.1'], '2610.1.0', true, false],       // stages may be skipped
  [['v2610.1.0-beta.2'], '2610.1.0-beta.2', false, true],
  [['v2610.1.0-beta.2'], '2610.1.0-beta.1', false, true],
  [['v2610.1.0-beta.2'], '2610.1.0-alpha.9', false, true],
  [['v2610.1.0'], '2610.1.0-rc.1', false, true],
  [['v2610.1.0'], '2610.1.0', false, false],
  [['v2610.1.1'], '2610.1.0', false, false],
  [['v2610.1.9'], '2610.1.10', true, false],
  [['v2610.1.0-beta.9'], '2610.1.0-beta.10', true, true],
  [['v2610.1.0'], '2610.2.0-beta.1', true, true],
  [['v2610.1.0', 'v2610.2.0-beta.1'], '2610.1.1', false, false],
  [['v0.4.4', 'v0.4.4b', 'nightly'], '2610.1.0-beta.1', true, true]
];
for (const [tags, cand, publish, prerelease] of TABLE) {
  test(`decide: tags [${tags.join(',') || '-'}] + ${cand} => ${publish ? (prerelease ? 'prerelease' : 'stable release') : 'skip'}`, () => {
    const d = V.decide(cand, tags);
    assert.equal(d.publish, publish);
    assert.equal(d.prerelease, prerelease);
    assert.equal(d.tag, `v${cand}`);
    assert.equal(d.stage, V.parseVersion(cand).stage || 'stable');
  });
}

test('decide: existing exact tag skips; unrelated tags never matter; malformed throws', () => {
  assert.match(V.decide('2610.1.0', ['v2610.1.0']).reason, /already exists/);
  assert.equal(V.decide('2610.1.0', ['v9', 'foo', 'v0.4.3', 'v99.0.0-rc']).publish, true);
  assert.throws(() => V.decide('2610.1.0-beta', []), /Invalid application version/);
});

// ---- derived platform versions ------------------------------------------------------------------
const { derive } = require('../.github/scripts/release/platform-versions');

test('derive: platform versions from the canonical version (beta and stable)', () => {
  assert.deepEqual(derive('2610.1.0-beta.2'), {
    canonical: '2610.1.0-beta.2', tag: 'v2610.1.0-beta.2',
    debVersion: '2610.1.0~beta.2-1', rpmVersion: '2610.1.0~beta.2', rpmRelease: '1', appImageVersion: '2610.1.0-beta.2',
    windowsFileVersion: '2610.1.0.2002', macShortVersion: '2610.1.0', macBuildVersion: '2002'
  });
  const s = derive('2610.1.0');
  assert.equal(s.debVersion, '2610.1.0-1');
  assert.equal(s.rpmVersion, '2610.1.0');
  assert.equal(s.windowsFileVersion, '2610.1.0.9000');
  assert.equal(s.macShortVersion, '2610.1.0');
  assert.equal(s.macBuildVersion, '9000');
});

test('package.json passes the Debian revision to fpm so the .deb Version is <version>-<revision>', () => {
  const { DEB_REVISION } = require('../.github/scripts/release/platform-versions');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.deb.fpm.includes(`--iteration=${DEB_REVISION}`));
});

test('derive: numeric build values order alpha < beta < rc < stable; limits are enforced', () => {
  const b = (v) => Number(derive(v).macBuildVersion);
  assert.ok(b('2610.1.0-alpha.9') < b('2610.1.0-beta.1'));
  assert.ok(b('2610.1.0-beta.999') < b('2610.1.0-rc.1'));
  assert.ok(b('2610.1.0-rc.5') < b('2610.1.0'));
  assert.throws(() => derive('2610.1.0-beta.1000'), /too large/);
  assert.throws(() => derive('2610.70000.0'), /65535/);
});

test('derive: Debian ordering is correct with dpkg (when dpkg is available)', (t) => {
  let ok = true;
  try { execFileSync('dpkg', ['--version'], { stdio: 'ignore' }); } catch { ok = false; }
  if (!ok) return t.skip('dpkg not available');
  const gt = (a, b) => { try { execFileSync('dpkg', ['--compare-versions', a, 'gt', b]); return true; } catch { return false; } };
  const order = ['2610.1.0-alpha.1', '2610.1.0-alpha.2', '2610.1.0-beta.1', '2610.1.0-beta.2', '2610.1.0-rc.1', '2610.1.0', '2610.1.1-beta.1', '2610.2.0'];
  for (let i = 1; i < order.length; i++) assert.ok(gt(derive(order[i]).debVersion, derive(order[i - 1]).debVersion), `${order[i]} > ${order[i - 1]}`);
});

// ---- plan.js against real throwaway git repositories -------------------------------------------
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
  git(dir, 'init', '-q', '-b', 'master');
  return dir;
}
function commit(dir, version, file = 'x.txt') {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
  fs.writeFileSync(path.join(dir, file), String(Math.random()));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `v ${version}`);
  const sha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', 'refs/remotes/origin/master', sha);
  return sha;
}
function planIn(dir, sha, opts = {}) {
  const cwd = process.cwd();
  process.chdir(dir);
  try { return plan({ sha, ...opts }); } finally { process.chdir(cwd); }
}

test('plan: version bump followed by another commit in the same push is detected, tag target is the checked sha', () => {
  const dir = makeRepo();
  commit(dir, '2610.1.0');
  git(dir, 'tag', 'v2610.1.0');
  commit(dir, '2610.2.0-beta.1');       // the bump
  const head = commit(dir, '2610.2.0-beta.1', 'other.txt'); // later commit, same push; parent has same version
  const p = planIn(dir, head);
  assert.equal(p.should_publish, 'true');
  assert.equal(p.version, '2610.2.0-beta.1');
  assert.equal(p.tag, 'v2610.2.0-beta.1');
  assert.equal(p.prerelease, 'true');
  assert.equal(p.sha, head);
});

test('plan: reads package.json at the checked commit, not at the tip of master', () => {
  const dir = makeRepo();
  const checked = commit(dir, '2610.1.0');
  commit(dir, '2610.1.1');        // master advanced after the checks ran
  const p = planIn(dir, checked);
  assert.equal(p.version, '2610.1.0');
  assert.equal(p.sha, checked);
});

test('plan: unchanged / lower / unrelated tags / existing tag', () => {
  const dir = makeRepo();
  const sha = commit(dir, '2610.1.0');
  git(dir, 'tag', 'v2610.1.0');
  git(dir, 'tag', 'unrelated');
  assert.equal(planIn(dir, sha).should_publish, 'false');
  const lower = commit(dir, '2609.1.0');
  assert.equal(planIn(dir, lower).should_publish, 'false');
  const dir2 = makeRepo();
  const s2 = commit(dir2, '2610.1.0');
  git(dir2, 'tag', 'v99'); git(dir2, 'tag', 'nightly'); git(dir2, 'tag', 'v0.4.4');
  assert.equal(planIn(dir2, s2).should_publish, 'true');
});

test('plan: invalid version fails clearly; commit not on master is skipped', () => {
  const dir = makeRepo();
  const bad = commit(dir, '0.4.4');
  assert.throws(() => planIn(dir, bad), /Invalid application version/);
  const good = commit(dir, '2610.1.0');
  git(dir, 'update-ref', 'refs/remotes/origin/master', bad); // master rewound: good is no longer on it
  const p = planIn(dir, good);
  assert.equal(p.should_publish, 'false');
  assert.match(p.reason, /not on master/);
  assert.throws(() => planIn(dir, 'main'), /40-character/);
});

test('plan: matrix and node version come from release-config.json', () => {
  const dir = makeRepo();
  const sha = commit(dir, '2610.1.0');
  const cfg = loadConfig();
  const p = planIn(dir, sha);
  assert.equal(p.node_version, cfg.nodeVersion);
  assert.deepEqual(JSON.parse(p.matrix).include.map((m) => m.type), ['appimage', 'deb']);
});

// ---- config / stage / prepare -------------------------------------------------------------------
test('release-config: node version and package types are valid and have dist scripts', () => {
  const cfg = loadConfig();
  assert.match(cfg.nodeVersion, /^[0-9]+/);
  const pkg = JSON.parse(read('package.json'));
  for (const p of cfg.packageTypes) assert.ok(pkg.scripts[`dist:${p.type}`], `missing dist:${p.type}`);
  assert.deepEqual(cfg.packageTypes.map((p) => p.type), ['appimage', 'deb']);
});

test('loadConfig rejects unsafe values', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'c.json');
  const w = (o) => fs.writeFileSync(f, JSON.stringify(o));
  w({ nodeVersion: '26.x', packageTypes: [{ type: 'deb; id', runner: 'ubuntu-latest', extensions: ['.deb'] }] });
  assert.throws(() => loadConfig(f), /invalid package type/);
  w({ nodeVersion: '26.x', packageTypes: [{ type: 'deb', runner: 'a b', extensions: ['.deb'] }] });
  assert.throws(() => loadConfig(f), /invalid runner/);
});

// A package plus the checksum file stage.js publishes next to it.
function writePackage(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
  fs.writeFileSync(path.join(dir, `${name}.sha256`), `${sha256Hex(path.join(dir, name))}  ${name}\n`);
}

const NOVERIFY = { packageTypes: loadConfig().packageTypes.map(({ verify, ...p }) => p) }; // fake package files below

test('stage keeps both package types in a dedicated upload dir and does not need the output dir to survive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', version: '2610.1.0-beta.2', build: { directories: { output: 'out' } } }));
  fs.mkdirSync(path.join(root, 'out', 'linux-unpacked'), { recursive: true });
  fs.writeFileSync(path.join(root, 'out', 'app_2610.1.0-beta.2_x86_64.AppImage'), 'a');
  fs.writeFileSync(path.join(root, 'out', 'app_2610.1.0-beta.2_amd64.deb'), 'd');
  fs.writeFileSync(path.join(root, 'out', 'latest-linux.yml'), 'y');
  const up = path.join(root, 'up');
  assert.deepEqual(stage({ root, type: 'appimage', uploadDir: up, config: NOVERIFY }), ['app_2610.1.0-beta.2_x86_64.AppImage', 'app_2610.1.0-beta.2_x86_64.AppImage.sha256']);
  fs.rmSync(path.join(root, 'out', 'app_2610.1.0-beta.2_x86_64.AppImage')); // a later build cleans the output
  assert.deepEqual(stage({ root, type: 'deb', uploadDir: up, config: NOVERIFY }), ['app_2610.1.0-beta.2_amd64.deb', 'app_2610.1.0-beta.2_amd64.deb.sha256']);
  assert.deepEqual(fs.readdirSync(up).sort(), ['app_2610.1.0-beta.2_amd64.deb', 'app_2610.1.0-beta.2_amd64.deb.sha256', 'app_2610.1.0-beta.2_x86_64.AppImage', 'app_2610.1.0-beta.2_x86_64.AppImage.sha256']);
  // The checksum file is in sha256sum format and names exactly its package.
  const sumText = fs.readFileSync(path.join(up, 'app_2610.1.0-beta.2_x86_64.AppImage.sha256'), 'utf8');
  assert.equal(sumText, `${sha256Hex(path.join(up, 'app_2610.1.0-beta.2_x86_64.AppImage'))}  app_2610.1.0-beta.2_x86_64.AppImage\n`);
  assert.match(sumText, /^[0-9a-f]{64} {2}app_2610\.1\.0-beta\.2_x86_64\.AppImage\n$/);
  assert.throws(() => stage({ root, type: 'rpm', uploadDir: up, config: NOVERIFY }), /Unknown package type/);
  fs.rmSync(path.join(root, 'out', 'app_2610.1.0-beta.2_amd64.deb'));
  assert.throws(() => stage({ root, type: 'deb', uploadDir: path.join(root, 'u2'), config: NOVERIFY }), /No \.deb package found/);
});

test('stage verifies the Debian Version field of a real .deb against the derived version', (t) => {
  try { execFileSync('dpkg-deb', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('dpkg-deb not available'); }
  const mk = (version) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deb-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', version: '2610.1.0-beta.2', build: { directories: { output: 'out' } } }));
    const pk = path.join(root, 'pk');
    fs.mkdirSync(path.join(pk, 'DEBIAN'), { recursive: true });
    fs.writeFileSync(path.join(pk, 'DEBIAN', 'control'), `Package: app\nVersion: ${version}\nArchitecture: all\nMaintainer: t <t@t>\nDescription: t\n`);
    fs.mkdirSync(path.join(root, 'out'));
    execFileSync('dpkg-deb', ['--build', pk, path.join(root, 'out', 'app_2610.1.0-beta.2_all.deb')], { stdio: 'ignore' });
    return root;
  };
  const good = mk('2610.1.0~beta.2-1');
  assert.deepEqual(stage({ root: good, type: 'deb', uploadDir: path.join(good, 'up') }), ['app_2610.1.0~beta.2-1_all.deb', 'app_2610.1.0~beta.2-1_all.deb.sha256']);
  assert.ok(fs.existsSync(path.join(good, 'up', 'app_2610.1.0~beta.2-1_all.deb')));
  const bad = mk('2610.1.0-beta.2');
  assert.throws(() => stage({ root: bad, type: 'deb', uploadDir: path.join(bad, 'up') }), /expected 2610\.1\.0~beta\.2-1/);
});

test('stage uses the real package.json output directory (not an assumed dist/)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.directories.output);
});

test('prepare: ~ in deb names is allowed; links use the asset names GitHub stored (it rewrites ~ to .)', () => {
  const { githubAssetName } = require('../.github/scripts/release/prepare-release');
  assert.equal(githubAssetName('app_2610.1.0~beta.2-1_amd64.deb'), 'app_2610.1.0.beta.2-1_amd64.deb');
  const up = fs.mkdtempSync(path.join(os.tmpdir(), 'tilde-'));
  writePackage(up, 'app_2610.1.0~beta.2-1_amd64.deb', 'd');
  writePackage(up, 'app_2610.1.0-beta.2_x86_64.AppImage', 'a');
  const args = { version: '2610.1.0-beta.2', tag: 'v2610.1.0-beta.2', sha: 'b'.repeat(40), repository: 'o/r', uploadDir: up };
  const predicted = prepare(args).notes;
  assert.ok(predicted.includes('[`app_2610.1.0~beta.2-1_amd64.deb`](https://github.com/o/r/releases/download/v2610.1.0-beta.2/app_2610.1.0.beta.2-1_amd64.deb)'));
  const actual = prepare({ ...args, assets: [
    { name: 'app_2610.1.0.beta.2-1_amd64.deb', label: 'app_2610.1.0~beta.2-1_amd64.deb' },
    { name: 'app_2610.1.0.beta.2-1_amd64.deb.sha256', label: 'app_2610.1.0~beta.2-1_amd64.deb.sha256' },
    { name: 'app_2610.1.0-beta.2_x86_64.AppImage', label: 'app_2610.1.0-beta.2_x86_64.AppImage' },
    { name: 'app_2610.1.0-beta.2_x86_64.AppImage.sha256', label: 'app_2610.1.0-beta.2_x86_64.AppImage.sha256' }] }).notes;
  assert.ok(actual.includes('/download/v2610.1.0-beta.2/app_2610.1.0.beta.2-1_amd64.deb)'));
  assert.throws(() => prepare({ ...args, assets: [{ name: 'other', label: 'other' }] }), /do not include/);
});

test('prepare: requires every package type; notes include version, commit, downloads, source tarball, beta marker', () => {
  const up = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-'));
  const sha = 'a'.repeat(40);
  const args = { version: '2610.1.0-beta.2', tag: 'v2610.1.0-beta.2', sha, repository: 'o/r', uploadDir: up };
  writePackage(up, 'app_2610.1.0-beta.2_amd64.deb', 'd');
  assert.throws(() => prepare(args), /Missing package for type appimage/);
  writePackage(up, 'app_2610.1.0-beta.2_x86_64.AppImage', 'a');
  const r = prepare(args);
  assert.equal(r.title, '2610.1.0-beta.2');
  assert.match(r.notes, /beta pre-release/);
  assert.ok(r.notes.includes('`2610.1.0~beta.2-1`'));
  assert.ok(r.notes.includes(`/commit/${sha}`));
  assert.ok(r.notes.includes('https://github.com/o/r/releases/download/v2610.1.0-beta.2/app_2610.1.0-beta.2_amd64.deb'));
  assert.ok(r.notes.includes('https://github.com/o/r/archive/refs/tags/v2610.1.0-beta.2.tar.gz'));
  assert.equal(prepare({ ...args, version: '2610.1.0', tag: 'v2610.1.0' }).title, '2610.1.0');
  assert.throws(() => prepare({ ...args, tag: 'v2610.1.1' }), /does not match/);
  fs.writeFileSync(path.join(up, 'evil;name.deb'), 'x');
  assert.throws(() => prepare(args), /Unsafe file name|Missing checksum/);
});

test('prepare: every package needs a matching sha256 checksum file; stray or wrong ones are refused', () => {
  const up = fs.mkdtempSync(path.join(os.tmpdir(), 'sums-'));
  const args = { version: '2610.1.0', tag: 'v2610.1.0', sha: 'c'.repeat(40), repository: 'o/r', uploadDir: up };
  writePackage(up, 'app_2610.1.0_amd64.deb', 'd');
  fs.writeFileSync(path.join(up, 'app_2610.1.0_x86_64.AppImage'), 'a');           // no checksum yet
  assert.throws(() => prepare(args), /Missing checksum file app_2610\.1\.0_x86_64\.AppImage\.sha256/);
  fs.writeFileSync(path.join(up, 'app_2610.1.0_x86_64.AppImage.sha256'), `${'0'.repeat(64)}  app_2610.1.0_x86_64.AppImage\n`); // wrong digest
  assert.throws(() => prepare(args), /does not match/);
  writePackage(up, 'app_2610.1.0_x86_64.AppImage', 'a');
  const r = prepare(args);
  assert.match(r.notes, /## Checksums/);
  assert.match(r.notes, /not independent proof/);
  assert.ok(r.notes.includes('app_2610.1.0_x86_64.AppImage.sha256'));
  fs.writeFileSync(path.join(up, 'orphan.deb.sha256'), 'x');
  assert.throws(() => prepare(args), /without a package/);
});

// ---- workflow wiring (text assertions; no YAML parser dependency) -------------------------------
test('release workflow is gated on the checks workflow by its name: field', () => {
  const checks = read('.github/workflows/test.yml');
  const name = /^name:\s*(.+)$/m.exec(checks)[1].trim();
  const rel = read('.github/workflows/release.yml');
  assert.ok(rel.includes(`workflows: ["${name}"]`), `release.yml must reference "${name}"`);
  assert.match(rel, /types: \[completed\]/);
  assert.match(rel, /workflow_run\.conclusion == 'success'/);
  assert.match(rel, /workflow_run\.event == 'push'/);
  assert.match(rel, /workflow_run\.head_branch == 'master'/);
  assert.match(rel, /head_repository\.full_name == github\.repository/);
});

test('release workflow builds/tags/publishes the checked commit only, with least privilege', () => {
  const rel = read('.github/workflows/release.yml');
  assert.doesNotMatch(rel, /^\s*pull_request/m);
  assert.doesNotMatch(rel, /npm version|git commit|git push|git tag |npm publish/);
  assert.equal((rel.match(/contents: write/g) || []).length, 1, 'only the publish job may write');
  assert.ok(rel.indexOf('contents: write') > rel.indexOf('  publish:'));
  assert.match(rel, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(rel, /ref: \$\{\{ needs\.plan\.outputs\.sha \}\}/);
  assert.match(rel, /"sha=\$SHA"/);
  assert.match(rel, /needs: \[plan, build\]/);
  assert.match(rel, /fail-fast: true/);
  assert.match(rel, /npm install/);
  assert.match(rel, /npm run "dist:\$PACKAGE_TYPE"/);
  assert.match(rel, /--prerelease --latest=false/);
  assert.doesNotMatch(rel, /\$\{\{\s*(github\.head_ref|github\.event\.pull_request)/);
  // untrusted/derived values are never interpolated into run: scripts
  const lines = rel.split('\n');
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (!m) return;
    let body = m[2];
    if (/^[|>]/.test(body)) {
      body = '';
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) body += lines[j] + '\n';
    }
    assert.doesNotMatch(body, /\$\{\{/, `expression interpolated into a run block at line ${i + 1}`);
  });
});

test('node version is not duplicated in the release workflow', () => {
  const rel = read('.github/workflows/release.yml');
  assert.doesNotMatch(rel, /node-version:\s*['"]?\d/);
});
