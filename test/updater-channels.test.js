'use strict';
// Version parsing, channel classification, preference defaults/dependencies, eligibility and release selection.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/main/updater/version');
const R = require('../.github/scripts/release/version');
const C = require('../src/main/updater/channels');
const { buildCatalog, selectBest, fetchReleases, UpdateCheckError } = require('../src/main/updater/releases');

const REPO = 'kc1mjp/cloudlog-desktop';
const rel = (tag, extra = {}) => ({ tag_name: tag, prerelease: /-(alpha|beta|rc)\./.test(tag), draft: false, published_at: '2026-10-01T00:00:00Z', assets: [], ...extra });
const P = (v) => V.parseVersion(v);

// ---- formats and classification ------------------------------------------------------------------
test('supported tag/version formats are classified by stage', () => {
  const cases = { '2610.1.0': 'stable', '2610.1.0-rc.1': 'rc', '2610.1.2-beta.3': 'beta', '2610.1.0-alpha.12': 'alpha' };
  for (const [v, ch] of Object.entries(cases)) {
    assert.equal(V.parseVersion(v).channel, ch, v);
    assert.equal(V.parseTag(`v${v}`).channel, ch, v);
  }
  for (const bad of ['', '0.4.4', 'v0.4.4', '2610.1', '2610.1.0-gamma.1', '2610.1.0-beta', '2610.1.0-beta.0', '2610.01.0', '2613.1.0', '2610.1.0+x', 'latest', null, 5]) {
    assert.equal(V.parseVersion(bad), null, String(bad));
  }
  assert.equal(V.parseTag('2610.1.0'), null); // a tag needs the "v"
});

test('the updater accepts and orders versions exactly like the release tooling', () => {
  const list = ['2610.1.0-alpha.1', '2610.1.0-alpha.2', '2610.1.0-beta.1', '2610.1.0-beta.10', '2610.1.0-rc.1', '2610.1.0', '2610.1.1-alpha.1', '2610.1.9', '2610.1.10', '2610.2.0-beta.1', '2611.1.0'];
  for (const a of list) for (const b of list) {
    assert.equal(Math.sign(V.compareVersions(P(a), P(b))), Math.sign(R.compareVersions(R.parseVersion(a), R.parseVersion(b))), `${a} vs ${b}`);
  }
  const mixed = ['2610.1.0-beta.9', '2610.1.0', 'x', '2610.1.0-beta.10', '2601.1.0-bad', '2610.1.0-rc.1', '2610.01.0'];
  for (const m of mixed) assert.equal(!!V.parseVersion(m), (() => { try { R.parseVersion(m); return true; } catch { return false; } })(), m);
});

test('ordering: alpha < beta < rc < stable, numeric not lexicographic', () => {
  const asc = ['2610.1.0-alpha.1', '2610.1.0-alpha.2', '2610.1.0-beta.1', '2610.1.0-beta.2', '2610.1.0-rc.1', '2610.1.0', '2610.1.1-alpha.1'];
  for (let i = 1; i < asc.length; i++) assert.ok(V.compareVersions(P(asc[i]), P(asc[i - 1])) > 0, `${asc[i]} > ${asc[i - 1]}`);
  assert.ok(V.compareVersions(P('2610.1.10'), P('2610.1.9')) > 0);
  assert.ok(V.compareVersions(P('2610.1.0-beta.10'), P('2610.1.0-beta.9')) > 0);
  assert.equal(V.compareVersions(P('2610.1.0'), P('2610.1.0')), 0);
});

test('classifyRelease: drafts excluded; unknown stage / flag mismatch are not guessed', () => {
  assert.equal(V.classifyRelease(rel('v2610.1.0', { draft: true })).kind, 'draft');
  assert.equal(V.classifyRelease(rel('v2610.1.0-gamma.1', { prerelease: true })).kind, 'unrecognized-tag');
  assert.equal(V.classifyRelease(rel('v2610.1.0', { prerelease: true })).kind, 'flag-mismatch');       // prerelease flag on a stable-looking tag
  assert.equal(V.classifyRelease(rel('v2610.1.0-beta.1', { prerelease: false })).kind, 'flag-mismatch');
  assert.equal(V.classifyRelease(rel('v0.4.4', { prerelease: false })).kind, 'unrecognized-tag');
  assert.equal(V.classifyRelease(null).ok, false);
  assert.equal(V.classifyRelease(rel('v2610.1.0-rc.2')).parsed.channel, 'rc');
});

// ---- defaults and persistence ---------------------------------------------------------------------
test('defaults depend on the installed channel (only for never-saved settings)', () => {
  const d = (ch) => { const e = C.resolvePreferences({}, ch); return [e.allowPrerelease, e.allowBeta, e.allowAlpha]; };
  assert.deepEqual(d('stable'), [false, false, false]);
  assert.deepEqual(d('rc'), [true, false, false]);
  assert.deepEqual(d('beta'), [true, true, false]);
  assert.deepEqual(d('alpha'), [true, true, true]);
  assert.deepEqual(d('unknown'), [false, false, false]);
  const e = C.resolvePreferences({}, 'stable');
  assert.equal(e.autoCheck, true); assert.equal(e.autoUpdate, false); assert.equal(e.skippedVersion, null);
});

test('saved preferences win over the installed channel and are never replaced by defaults', () => {
  const saved = { allowPrerelease: false, allowBeta: false, allowAlpha: false };
  for (const ch of ['stable', 'rc', 'beta', 'alpha']) {
    const e = C.resolvePreferences(saved, ch);
    assert.deepEqual([e.allowPrerelease, e.allowBeta, e.allowAlpha], [false, false, false], ch);
  }
  assert.equal(C.resolvePreferences({ allowPrerelease: true }, 'stable').allowBeta, false);          // only the saved key counts
  assert.equal(C.resolvePreferences({ allowPrerelease: false }, 'alpha').allowPrerelease, false);
  assert.equal(C.resolvePreferences({ allowBeta: false }, 'alpha').allowBeta, true);                   // alpha default ON still implies beta
  const n = C.normalizeSaved({ allowPrerelease: true }, 'alpha');
  assert.deepEqual(n.saved, { allowPrerelease: true });  // defaults are not written into the file
  assert.equal(n.changed, false);
});

test('invalid saved alpha ON + beta OFF is normalized to beta ON and reported as changed', () => {
  const n = C.normalizeSaved({ allowPrerelease: true, allowBeta: false, allowAlpha: true }, 'stable');
  assert.equal(n.saved.allowBeta, true); assert.equal(n.saved.allowAlpha, true); assert.equal(n.changed, true);
  const e = C.resolvePreferences({ allowBeta: false, allowAlpha: true }, 'stable');
  assert.equal(e.allowBeta, true);
  // alpha saved ON, beta never saved, installed stable: beta default is OFF, so the pair is corrected too
  const m = C.normalizeSaved({ allowAlpha: true }, 'stable');
  assert.deepEqual([m.saved.allowAlpha, m.saved.allowBeta, m.changed], [true, true, true]);
  // junk values count as never saved
  const j = C.normalizeSaved({ allowBeta: 'yes', autoCheck: 1, bogus: 1 }, 'stable');
  assert.deepEqual(j.saved, {}); assert.equal(j.changed, true);
});

// ---- toggle dependencies -------------------------------------------------------------------------
test('enabling alpha enables beta; alpha off leaves beta; beta off turns alpha off; pairs persist together', () => {
  let s = C.applyPreferencePatch({}, 'stable', { allowPrerelease: true });
  s = C.applyPreferencePatch(s, 'stable', { allowAlpha: true });
  assert.deepEqual([s.allowBeta, s.allowAlpha], [true, true]);
  const off = C.applyPreferencePatch(s, 'stable', { allowAlpha: false });
  assert.deepEqual([off.allowBeta, off.allowAlpha], [true, false]);
  const noBeta = C.applyPreferencePatch(s, 'stable', { allowBeta: false });
  assert.deepEqual([noBeta.allowBeta, noBeta.allowAlpha], [false, false]);
  // from an alpha installation with nothing saved, turning beta off stores BOTH values
  const a = C.applyPreferencePatch({}, 'alpha', { allowBeta: false });
  assert.deepEqual([a.allowBeta, a.allowAlpha], [false, false]);
  // alpha may be switched on directly while beta is off
  const d = C.applyPreferencePatch({ allowPrerelease: true, allowBeta: false, allowAlpha: false }, 'stable', { allowAlpha: true });
  assert.deepEqual([d.allowBeta, d.allowAlpha], [true, true]);
});

test('beta/alpha cannot change while pre-release updates are off; turning pre-release off keeps their values', () => {
  assert.throws(() => C.applyPreferencePatch({}, 'stable', { allowBeta: true }), C.PreferenceError);
  assert.throws(() => C.applyPreferencePatch({}, 'stable', { allowAlpha: true }), /pre-release/);
  const on = C.applyPreferencePatch({}, 'stable', { allowPrerelease: true, allowBeta: true });   // switched on by the same change
  assert.deepEqual([on.allowPrerelease, on.allowBeta], [true, true]);
  const full = C.applyPreferencePatch(on, 'stable', { allowAlpha: true });
  const off = C.applyPreferencePatch(full, 'stable', { allowPrerelease: false });
  assert.deepEqual([off.allowPrerelease, off.allowBeta, off.allowAlpha], [false, true, true]);
  const back = C.resolvePreferences(C.applyPreferencePatch(off, 'stable', { allowPrerelease: true }), 'stable');
  assert.deepEqual([back.allowPrerelease, back.allowBeta, back.allowAlpha], [true, true, true]);
  assert.throws(() => C.applyPreferencePatch({}, 'stable', { allowPrerelease: 'x' }), C.PreferenceError);
  assert.throws(() => C.applyPreferencePatch({}, 'stable', { nope: true }), /Unknown/);
  const master = C.applyPreferencePatch(full, 'stable', { autoCheck: false });
  assert.deepEqual([master.allowPrerelease, master.allowBeta, master.allowAlpha], [true, true, true]);
});

// ---- eligibility matrix --------------------------------------------------------------------------
test('eligibility matrix', () => {
  const at = (allowPrerelease, allowBeta, allowAlpha) => C.resolvePreferences({ allowPrerelease, allowBeta, allowAlpha }, 'stable');
  const ok = (eff) => ['stable', 'rc', 'beta', 'alpha'].filter((c) => C.isChannelEligible(c, eff));
  assert.deepEqual(ok(at(false, true, true)), ['stable']);                       // prerelease off: saved beta/alpha are ineffective
  assert.deepEqual(ok(at(true, false, false)), ['stable', 'rc']);
  assert.deepEqual(ok(at(true, true, false)), ['stable', 'rc', 'beta']);
  assert.deepEqual(ok(at(true, true, true)), ['stable', 'rc', 'beta', 'alpha']);
  assert.deepEqual(ok(at(true, false, true)), ['stable', 'rc', 'beta', 'alpha']); // alpha forces beta
  assert.equal(C.isChannelEligible('weird', at(true, true, true)), false);
});

// ---- selection ----------------------------------------------------------------------------------
const catalog = (...tags) => buildCatalog(tags.map((t) => (typeof t === 'string' ? rel(t) : t)), REPO).entries;
const eff = (p, b, a, ch = 'stable') => C.resolvePreferences({ allowPrerelease: p, allowBeta: b, allowAlpha: a }, ch);

test('newest eligible release is chosen regardless of API order; stable supersedes older prerelease', () => {
  const e = catalog('v2610.1.0-beta.1', 'v2610.1.1', 'v2610.1.0', 'v2610.2.0-alpha.1', 'v2610.1.0-rc.1');
  assert.equal(selectBest(e, P('2610.0.9'), eff(false, false, false)).version, '2610.1.1');
  assert.equal(selectBest(e, P('2610.0.9'), eff(true, true, true)).version, '2610.2.0-alpha.1');
  assert.equal(selectBest(e, P('2610.0.9'), eff(true, true, false)).version, '2610.1.1');
  const older = catalog('v2610.1.0-alpha.9', 'v2610.2.0');
  assert.equal(selectBest(older, P('2610.1.0-alpha.1'), eff(true, true, true)).version, '2610.2.0'); // alpha ON does not prefer the older alpha
});

test('a prerelease installation can receive a newer stable; no downgrade and no reinstall', () => {
  const e = catalog('v2610.1.0', 'v2610.0.5');
  assert.equal(selectBest(e, P('2610.1.0-beta.3'), eff(true, true, false, 'beta')).version, '2610.1.0');
  assert.equal(selectBest(e, P('2610.1.0'), eff(false, false, false)), null);   // same version
  assert.equal(selectBest(e, P('2610.5.0'), eff(false, false, false)), null);   // older
  assert.equal(selectBest(catalog('v2610.1.0-alpha.2'), P('2610.1.0-alpha.2'), eff(true, true, true)), null);
  assert.equal(selectBest(catalog('v2610.1.0-alpha.1'), P('2610.1.0-alpha.2'), eff(true, true, true)), null);
});

test('drafts and unknown prerelease stages are excluded, with diagnostics for the latter', () => {
  const raw = [rel('v2610.3.0', { draft: true }), rel('v2610.2.0-gamma.1', { prerelease: true }), rel('v2610.2.1', { prerelease: true }), rel('v0.4.4'), rel('v2610.1.0')];
  const { entries, diagnostics } = buildCatalog(raw, REPO);
  assert.deepEqual(entries.map((x) => x.version), ['2610.1.0']);
  assert.equal(diagnostics.length, 3);                                             // the draft produces none
  assert.ok(diagnostics.every((x) => x.reason && x.tag));
  assert.equal(selectBest(entries, P('2610.0.1'), eff(true, true, true)).version, '2610.1.0');
});

test('release page URL is built from the tag; asset URLs must belong to this repository release', () => {
  const good = { name: 'a_x86_64.AppImage', size: 5, state: 'uploaded', browser_download_url: `https://github.com/${REPO}/releases/download/v2610.1.0/a_x86_64.AppImage` };
  const evil = { name: 'b.AppImage', size: 5, browser_download_url: 'https://evil.example/b.AppImage' };
  const other = { name: 'c.AppImage', size: 5, browser_download_url: `https://github.com/other/repo/releases/download/v2610.1.0/c.AppImage` };
  const [e] = catalog(rel('v2610.1.0', { html_url: 'https://evil.example/', assets: [good, evil, other] }));
  assert.equal(e.url, `https://github.com/${REPO}/releases/tag/v2610.1.0`);
  assert.deepEqual(e.assets.map((a) => a.name), ['a_x86_64.AppImage']);
});

// ---- network / API handling ------------------------------------------------------------------------
const resp = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('discovery follows pagination, sends no credentials, and finds the release on a later page', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (url.includes('&page=1')) return resp(200, [rel('v2610.1.0')], { link: `<https://api.github.com/repos/${REPO}/releases?per_page=100&page=2>; rel="next"` });
    return resp(200, [rel('v2610.9.0')]);
  };
  const r = await fetchReleases({ repo: REPO, fetchImpl, userAgent: 'x' });
  assert.deepEqual(r.releases.map((x) => x.tag_name), ['v2610.1.0', 'v2610.9.0']);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => !('authorization' in Object.fromEntries(Object.entries(s.init.headers).map(([k, v]) => [k.toLowerCase(), v])))));
  assert.ok(seen.every((s) => s.url.startsWith('https://api.github.com/repos/')));
});

test('discovery maps failures to kinds: network, timeout, rate limit, malformed, server errors, bad pagination', async () => {
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout timers are unref'd
  const kind = async (fetchImpl) => { try { await fetchReleases({ repo: REPO, fetchImpl, timeoutMs: 50 }); return 'none'; } catch (e) { assert.ok(e instanceof UpdateCheckError); return e; } };
  assert.equal((await kind(async () => { throw new TypeError('fetch failed'); })).kind, 'network');
  assert.equal((await kind((_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))))).kind, 'timeout');
  const rl = await kind(async () => resp(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' }));
  assert.equal(rl.kind, 'rate-limit'); assert.equal(rl.resetAt, 2000000000000); assert.equal(rl.transient, false);
  assert.equal((await kind(async () => resp(429, '{}'))).kind, 'rate-limit');
  assert.equal((await kind(async () => resp(200, 'not json'))).kind, 'malformed');
  assert.equal((await kind(async () => resp(200, { not: 'a list' }))).kind, 'malformed');
  const s = await kind(async () => resp(503, ''));
  assert.equal(s.kind, 'http'); assert.equal(s.transient, true);
  assert.equal((await kind(async () => resp(404, ''))).transient, false);
  assert.equal((await kind(async () => resp(200, [], { link: '<https://evil.example/x>; rel="next"' }))).kind, 'malformed');
  assert.equal((await kind(async () => resp(500, ''))).transient, true);
  clearTimeout(keepAlive);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(fetchReleases({ repo: REPO, fetchImpl: async () => { throw new Error('x'); }, signal: ac.signal }), (e) => e.kind === 'aborted');
});
