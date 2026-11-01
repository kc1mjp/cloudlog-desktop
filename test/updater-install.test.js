'use strict';
// Installation-type detection, asset/checksum selection and the AppImage download/verify/replace step.
// Everything runs in throwaway temp directories with fake network responses; no real installation is ever touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { detectInstallation, DPKG_LIST } = require('../src/main/updater/install-type');
const { selectAppImageAsset, AssetError } = require('../src/main/updater/assets');
const { parseChecksumFile, ChecksumError } = require('../src/main/updater/checksum');
const { installAppImage, InstallError } = require('../src/main/updater/installer');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
const ELF_AI2 = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.from([0x41, 0x49, 0x02, 0x00]), Buffer.alloc(100, 1)]);

// ---- detection --------------------------------------------------------------------------------
function appImageFixture({ content = ELF_AI2, link = false } = {}) {
  const root = tmp();
  const dir = path.join(root, 'apps'); fs.mkdirSync(dir);
  const real = path.join(dir, 'cloudlog-desktop_x_x86_64.AppImage');
  fs.writeFileSync(real, content, { mode: 0o755 });
  const appdir = path.join(root, 'mnt'); fs.mkdirSync(path.join(appdir, 'usr'), { recursive: true });
  const execPath = path.join(appdir, 'cloudlog-desktop');
  fs.writeFileSync(execPath, '');
  let image = real;
  if (link) { image = path.join(root, 'cloudlog-link'); fs.symlinkSync(real, image); }
  return { root, dir, real, image, appdir, execPath, env: { APPIMAGE: image, APPDIR: appdir } };
}

test('a genuine AppImage runtime is recognized and its real path resolved through symlinks', () => {
  const f = appImageFixture({ link: true });
  const d = detectInstallation({ env: f.env, execPath: f.execPath, arch: 'x64', platform: 'linux', isPackaged: true });
  assert.equal(d.type, 'appimage'); assert.equal(d.selfUpdate, true);
  assert.equal(d.appImagePath, f.image);
  assert.equal(d.realPath, fs.realpathSync(f.real));
});

test('everything that is not a verified AppImage is notify-only', () => {
  const f = appImageFixture();
  const base = { env: f.env, execPath: f.execPath, arch: 'x64', platform: 'linux', isPackaged: true };
  assert.equal(detectInstallation({ ...base, isPackaged: false }).type, 'development');
  assert.equal(detectInstallation({ ...base, isPackaged: false }).selfUpdate, false);
  // APPIMAGE inherited by a process that does not run from the mount point
  assert.equal(detectInstallation({ ...base, execPath: '/opt/Cloudlog Desktop/cloudlog-desktop' }).type, 'packaged');
  // no variables at all, wrong platform
  assert.equal(detectInstallation({ ...base, env: {} }).selfUpdate, false);
  assert.equal(detectInstallation({ ...base, platform: 'darwin' }).selfUpdate, false);
  // a file that merely ends in .AppImage / is not an AppImage image
  const fake = appImageFixture({ content: Buffer.from('#!/bin/sh\necho hi\n') });
  assert.equal(detectInstallation({ env: fake.env, execPath: fake.execPath, arch: 'x64', platform: 'linux', isPackaged: true }).selfUpdate, false);
  // unknown CPU architecture, missing file
  assert.equal(detectInstallation({ ...base, arch: 'riscv64' }).selfUpdate, false);
  fs.rmSync(f.real);
  assert.equal(detectInstallation(base).selfUpdate, false);
});

test('a .deb installation is recognised from the dpkg file list (read only) and never self-updates', () => {
  const exec = '/opt/Cloudlog Desktop/cloudlog-desktop';
  const fsx = { ...fs, readFileSync: (p, ...a) => (p === DPKG_LIST ? `/opt\n${exec}\n` : fs.readFileSync(p, ...a)) };
  const d = detectInstallation({ env: {}, execPath: exec, arch: 'x64', platform: 'linux', isPackaged: true, fs: fsx });
  assert.equal(d.type, 'deb'); assert.equal(d.selfUpdate, false); assert.match(d.reason, /release page/);
});

test('an AppImage that cannot be replaced safely falls back to notify-only', () => {
  const f = appImageFixture();
  const args = { env: f.env, execPath: f.execPath, arch: 'x64', platform: 'linux', isPackaged: true };
  const ro = { ...fs, accessSync: () => { const e = new Error('ro'); e.code = 'EACCES'; throw e; } };
  const d1 = detectInstallation({ ...args, fs: ro });
  assert.equal(d1.type, 'appimage'); assert.equal(d1.selfUpdate, false); assert.match(d1.reason, /not writable|privileges/);
  const d2 = detectInstallation({ ...args, getuid: () => (fs.statSync(f.real).uid + 1) || 1000 });
  assert.equal(d2.selfUpdate, false); assert.match(d2.reason, /another user/);
});

// ---- assets -----------------------------------------------------------------------------------------
const A = (name) => ({ name, url: `https://github.com/o/r/releases/download/v1/${name}`, size: 10 });
test('asset selection matches OS + CPU architecture and requires exactly one asset and one checksum', () => {
  const entry = { assets: [A('app_1_x86_64.AppImage'), A('app_1_x86_64.AppImage.sha256'), A('app_1_arm64.AppImage'), A('app_1_arm64.AppImage.sha256'), A('app_1_amd64.deb'), A('app_1_amd64.deb.sha256')] };
  assert.equal(selectAppImageAsset(entry, { platform: 'linux', arch: 'x64' }).asset.name, 'app_1_x86_64.AppImage');
  assert.equal(selectAppImageAsset(entry, { platform: 'linux', arch: 'x64' }).checksumAsset.name, 'app_1_x86_64.AppImage.sha256');
  assert.equal(selectAppImageAsset(entry, { platform: 'linux', arch: 'arm64' }).asset.name, 'app_1_arm64.AppImage');
  const code = (e, o) => { try { selectAppImageAsset(e, o); return 'none'; } catch (x) { assert.ok(x instanceof AssetError); return x.code; } };
  assert.equal(code(entry, { platform: 'linux', arch: 'ia32' }), 'no-asset');
  assert.equal(code(entry, { platform: 'linux', arch: 'riscv64' }), 'unsupported-platform');
  assert.equal(code(entry, { platform: 'win32', arch: 'x64' }), 'unsupported-platform');
  assert.equal(code({ assets: [A('app_1_amd64.deb')] }, { platform: 'linux', arch: 'x64' }), 'no-asset');
  assert.equal(code({ assets: [A('app_1_x86_64.AppImage')] }, { platform: 'linux', arch: 'x64' }), 'no-checksum');
  assert.equal(code({ assets: [A('a_x86_64.AppImage'), A('a_x86_64.AppImage.sha256'), A('b_x86_64.AppImage')] }, { platform: 'linux', arch: 'x64' }), 'ambiguous-asset');
  assert.equal(code({ assets: [A('a_x86_64.AppImage'), A('a_x86_64.AppImage.sha256'), A('a_x86_64.AppImage.sha256')] }, { platform: 'linux', arch: 'x64' }), 'ambiguous-checksum');
});

// ---- checksum files ---------------------------------------------------------------------------------
test('checksum parsing: exact asset match, malformed / missing / ambiguous are rejected', () => {
  const h = 'ab'.repeat(32); const h2 = 'cd'.repeat(32);
  assert.equal(parseChecksumFile(`${h}  a.AppImage\n`, 'a.AppImage'), h);
  assert.equal(parseChecksumFile(`${h.toUpperCase()} *a.AppImage\r\n`, 'a.AppImage'), h);
  assert.equal(parseChecksumFile(`${h2}  other\n${h}  a.AppImage\n`, 'a.AppImage'), h);   // SHA256SUMS-style
  assert.equal(parseChecksumFile(`${h}  a.AppImage\n${h}  a.AppImage\n`, 'a.AppImage'), h);
  const code = (t) => { try { parseChecksumFile(t, 'a.AppImage'); return 'none'; } catch (e) { assert.ok(e instanceof ChecksumError); return e.code; } };
  assert.equal(code(''), 'missing');
  assert.equal(code(`${h}  b.AppImage\n`), 'missing');                  // belongs to another file
  assert.equal(code(`${h}\n`), 'malformed');                             // bare digest: not tied to a name
  assert.equal(code(`${h.slice(1)}  a.AppImage\n`), 'malformed');        // short
  assert.equal(code(`zz${h.slice(2)}  a.AppImage\n`), 'malformed');
  assert.equal(code(`${h}  a.AppImage\nnot a checksum line\n`), 'malformed');
  assert.equal(code(`${h}  a.AppImage\n${h2}  a.AppImage\n`), 'ambiguous');
  assert.equal(code(`${h}  a.AppImage\u0000\n`), 'malformed');
});

// ---- installer -----------------------------------------------------------------------------------------
const NEW = Buffer.concat([ELF_AI2, Buffer.from('NEW-VERSION'.repeat(50))]);
const OLD = ELF_AI2;

/** A target AppImage plus a fake GitHub that serves the new package and its checksum file. */
function setup({ body = NEW, sums, size = body.length, chunks } = {}) {
  const dir = tmp();
  const target = path.join(dir, 'cloudlog-desktop.AppImage');
  fs.writeFileSync(target, OLD, { mode: 0o750 });
  const asset = { name: 'app_2_x86_64.AppImage', url: 'https://github.com/o/r/releases/download/v2/app_2_x86_64.AppImage', size };
  const checksumAsset = { name: `${asset.name}.sha256`, url: `${asset.url}.sha256` };
  const sumText = sums === undefined ? `${sha(body)}  ${asset.name}\n` : sums;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === checksumAsset.url) return sumText === null ? new Response('nf', { status: 404 }) : new Response(sumText);
    if (url === asset.url) {
      if (chunks) return new Response(chunks(), { headers: { 'content-length': String(body.length) } });
      return new Response(body, { headers: { 'content-length': String(body.length) } });
    }
    return new Response('nf', { status: 404 });
  };
  return { dir, target, asset, checksumAsset, fetchImpl, calls };
}
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('.cloudlog-desktop.AppImage.'));
const run = (s, extra = {}) => installAppImage({ target: s.target, asset: s.asset, checksumAsset: s.checksumAsset, fetchImpl: s.fetchImpl, ...extra });
const failure = async (p) => { try { await p; return null; } catch (e) { return e; } };

test('success: verified file replaces the AppImage in place, keeping name, location and permissions; temp files are gone', async () => {
  const s = setup();
  const phases = [];
  const r = await run(s, { onPhase: (p) => phases.push(p) });
  assert.equal(r.path, s.target);
  assert.deepEqual(fs.readFileSync(s.target), NEW);
  assert.equal(fs.statSync(s.target).mode & 0o777, 0o750);                 // permissions preserved
  assert.deepEqual(fs.readdirSync(s.dir), ['cloudlog-desktop.AppImage']);   // same name, nothing else left
  assert.deepEqual(phases, ['checksum', 'downloading', 'verifying', 'installing']);
});

test('the installed file is not touched while downloading', async () => {
  let during = null;
  const s = setup();
  const fetchImpl = async (url, init) => { if (url === s.asset.url) during = fs.readFileSync(s.target); return s.fetchImpl(url, init); };
  await run(s, { fetchImpl });
  assert.deepEqual(during, OLD);
});

test('missing, malformed, ambiguous and mismatched checksums stop the installation; the old AppImage is untouched', async () => {
  const h = sha(NEW); const name = 'app_2_x86_64.AppImage';
  const cases = [
    ['missing', null, /download failed|checksum file/i],
    ['empty', '', /empty/],
    ['wrong entry', `${h}  other.AppImage\n`, /no entry/],
    ['malformed', `${h}\n`, /malformed/],
    ['ambiguous', `${h}  ${name}\n${'1'.repeat(64)}  ${name}\n`, /different checksums/],
    ['mismatch', `${'0'.repeat(64)}  ${name}\n`, /does not match/],
  ];
  for (const [label, sums, re] of cases) {
    const s = setup({ sums });
    const e = await failure(run(s));
    assert.ok(e, label); assert.match(e.message, re, label);
    assert.deepEqual(fs.readFileSync(s.target), OLD, label);
    assert.deepEqual(leftovers(s.dir), [], label);
    if (label !== 'mismatch') assert.ok(!s.calls.includes(s.asset.url), `${label}: no large download before a usable checksum`);
  }
});

test('interrupted, truncated and oversized downloads fail cleanly', async () => {
  const broken = setup({ chunks: () => new ReadableStream({ start(c) { c.enqueue(NEW.subarray(0, 40)); }, pull(c) { c.error(new Error('reset')); } }) });
  let e = await failure(run(broken));
  assert.ok(e instanceof InstallError); assert.match(e.message, /interrupted/);
  assert.deepEqual(fs.readFileSync(broken.target), OLD); assert.deepEqual(leftovers(broken.dir), []);
  const short = setup({ chunks: () => new Response(NEW.subarray(0, 60)).body });
  e = await failure(run(short)); assert.match(e.message, /incomplete/);
  assert.deepEqual(leftovers(short.dir), []);
  const big = setup({ size: 10 });
  e = await failure(run(big)); assert.match(e.message, /size|larger/);
  assert.deepEqual(leftovers(big.dir), []);
});

test('cancellation during the download removes the temporary file', async () => {
  const ac = new AbortController();
  const s = setup({ chunks: () => new ReadableStream({ async pull(c) { c.enqueue(NEW.subarray(0, 10)); ac.abort(); await new Promise((r) => setTimeout(r, 20)); } }) });
  const e = await failure(run(s, { signal: ac.signal }));
  assert.equal(e.code, 'cancelled');
  assert.deepEqual(fs.readFileSync(s.target), OLD); assert.deepEqual(leftovers(s.dir), []);
});

test('revalidation after verification can discard the download (settings changed meanwhile)', async () => {
  const s = setup();
  const e = await failure(run(s, { revalidate: () => ({ ok: false, reason: 'Beta updates are no longer enabled' }) }));
  assert.equal(e.code, 'cancelled'); assert.match(e.message, /Beta/);
  assert.deepEqual(fs.readFileSync(s.target), OLD); assert.deepEqual(leftovers(s.dir), []);
});

test('failed replacement leaves the previous AppImage usable and cleans up', async () => {
  const s = setup();
  const fsx = { ...fs, renameSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
  const e = await failure(run(s, { fs: fsx }));
  assert.equal(e.code, 'not-writable'); assert.match(e.message, /unchanged/);
  assert.deepEqual(fs.readFileSync(s.target), OLD);
  assert.equal(fs.statSync(s.target).mode & 0o777, 0o750);
  assert.deepEqual(leftovers(s.dir), []);
});

test('a replacement that fails its final check is rolled back; if rollback fails the backup is kept', async () => {
  const s = setup();
  let renamed = false;
  const lying = { ...fs, renameSync: (a, b) => { fs.renameSync(a, b); renamed = true; }, statSync: (p) => { const st = fs.statSync(p); return renamed && p === s.target ? { isFile: () => true, size: 1, mode: st.mode } : st; } };
  const e = await failure(run(s, { fs: lying }));
  assert.equal(e.code, 'replace'); assert.match(e.message, /restored/);
  assert.deepEqual(fs.readFileSync(s.target), OLD); assert.deepEqual(leftovers(s.dir), []);

  const s2 = setup();
  let n = 0;
  const bad = { ...fs, renameSync: (a, b) => { if (++n === 2) { const x = new Error('no'); x.code = 'EIO'; throw x; } fs.renameSync(a, b); }, statSync: (p) => { const st = fs.statSync(p); return n >= 1 && p === s2.target ? { isFile: () => true, size: 1, mode: st.mode } : st; } };
  const e2 = await failure(run(s2, { fs: bad }));
  assert.equal(e2.code, 'rollback');
  const kept = leftovers(s2.dir);
  assert.equal(kept.length, 1); assert.match(kept[0], /\.previous-/);
  assert.deepEqual(fs.readFileSync(path.join(s2.dir, kept[0])), OLD);       // the previous version is still recoverable
});

test('symlinks: the real file is replaced, the link stays a link, unrelated files are untouched', async () => {
  const s = setup();
  const other = path.join(s.dir, 'unrelated.txt'); fs.writeFileSync(other, 'keep');
  const link = path.join(s.dir, 'launcher'); fs.symlinkSync(s.target, link);
  const real = fs.realpathSync(link);
  await installAppImage({ target: real, asset: s.asset, checksumAsset: s.checksumAsset, fetchImpl: s.fetchImpl });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readlinkSync(link), s.target);
  assert.deepEqual(fs.readFileSync(s.target), NEW);
  assert.equal(fs.readFileSync(other, 'utf8'), 'keep');
  assert.deepEqual(leftovers(s.dir), []);
  // the resolved path changing during the download aborts without replacing anything
  const s2 = setup();
  const e = await failure(run(s2, { resolveTarget: () => path.join(s2.dir, 'somewhere-else') }));
  assert.equal(e.code, 'path-changed');
  assert.deepEqual(fs.readFileSync(s2.target), OLD); assert.deepEqual(leftovers(s2.dir), []);
});

test('permission and disk-space problems are reported before anything is replaced', async () => {
  const s = setup();
  const ro = { ...fs, accessSync: () => { const e = new Error('x'); e.code = 'EACCES'; throw e; } };
  let e = await failure(run(s, { fs: ro }));
  assert.equal(e.code, 'not-writable'); assert.match(e.message, /elevated privileges/);
  assert.equal(s.calls.length, 0);
  e = await failure(run(s, { getuid: () => fs.statSync(s.target).uid + 1 }));
  assert.equal(e.code, 'not-writable'); assert.match(e.message, /another user/);
  const full = { ...fs, statfsSync: () => ({ bavail: 1, bsize: 4096 }) };
  e = await failure(run(s, { fs: full }));
  assert.equal(e.code, 'disk-space');
  assert.ok(!s.calls.includes(s.asset.url));
  assert.deepEqual(fs.readFileSync(s.target), OLD); assert.deepEqual(leftovers(s.dir), []);
});

test('downloads must use HTTPS', async () => {
  const s = setup();
  s.asset.url = s.asset.url.replace('https:', 'http:');
  const e = await failure(run(s));
  assert.match(e.message, /HTTPS/);
  assert.deepEqual(leftovers(s.dir), []);
});
