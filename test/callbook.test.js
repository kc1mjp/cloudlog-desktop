'use strict';
// Callbook lookup (QRZ / HamQTH), profile links, credential handling and Live QSO lookup behaviour.
// No real network access: every provider call goes through a fake fetch, and credentials are generated per run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CB = require('../src/renderer/callbook-shared');
const { QrzProvider } = require('../src/main/callbook/qrz');
const { HamQthProvider } = require('../src/main/callbook/hamqth');
const { CallbookService } = require('../src/main/callbook');
const config = require('../src/main/callbook/config');
const { createSecretBox } = require('../src/main/secrets');
const { clean, cleanGrid } = require('../src/main/callbook/text');
const { JsonStore, SETTINGS_DEFAULTS } = require('../src/main/store');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const USER = 'test-user';
const PASS = `pw-${crypto.randomBytes(8).toString('hex')}`; // generated per run: no secret is ever committed
const SESSION = `sess-${crypto.randomBytes(6).toString('hex')}`;
const CREDS = { username: USER, password: PASS };

/** fetch stand-in. handler({url, method, body}) -> { status?, body } | throws. Records every request. */
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ? String(init.body) : '', headers: init.headers || {} };
    calls.push(call);
    const r = await handler(call);
    return { status: r.status ?? 200, headers: { get: () => null }, text: async () => r.body ?? '' };
  };
  f.calls = calls;
  return f;
}
const q = (call) => new URLSearchParams(call.method === 'POST' ? call.body : call.url.split('?')[1] || '');

// ---- fixtures -------------------------------------------------------------------------------------
const HAMQTH_LOGIN_OK = `<?xml version="1.0"?><HamQTH version="2.7" xmlns="https://www.hamqth.com"><session><session_id>${SESSION}</session_id></session></HamQTH>`;
const hamqthErr = (m) => `<?xml version="1.0"?><HamQTH version="2.7" xmlns="https://www.hamqth.com"><session><error>${m}</error></session></HamQTH>`;
const HAMQTH_FOUND = `<?xml version="1.0"?><HamQTH version="2.7" xmlns="https://www.hamqth.com"><search>
<callsign>xx1abc</callsign><nick>Pat</nick><qth>Springfield &amp; Co</qth><country>Nowhere</country><grid>fn31pr</grid>
<adr_name>Patricia Example</adr_name><adr_city>Somewhere Else</adr_city></search></HamQTH>`;

const QRZ_LOGIN_OK = `<?xml version="1.0"?><QRZDatabase version="1.34"><Session><Key>${SESSION}</Key><Count>1</Count><SubExp>Wed Jan 1 12:34:03 2030</SubExp></Session></QRZDatabase>`;
const qrzErr = (m, key = false) => `<?xml version="1.0"?><QRZDatabase version="1.34"><Session>${key ? `<Key>${SESSION}</Key>` : ''}<Error>${m}</Error></Session></QRZDatabase>`;
const QRZ_FOUND = `<?xml version="1.0"?><QRZDatabase version="1.34"><Callsign><call>XX1ABC</call><fname>Pat</fname><name>Example</name><nickname>Patty</nickname>
<addr2>Springfield</addr2><state>MA</state><grid>FN31pr</grid></Callsign><Session><Key>${SESSION}</Key></Session></QRZDatabase>`;

function hamqthFetch({ lookup = HAMQTH_FOUND, login = HAMQTH_LOGIN_OK } = {}) {
  return fakeFetch(({ url }) => ({ body: new URL(url).searchParams.has('u') ? login : lookup }));
}
function qrzFetch({ lookup = QRZ_FOUND, login = QRZ_LOGIN_OK } = {}) {
  return fakeFetch(({ body }) => ({ body: new URLSearchParams(body).has('username') ? login : lookup }));
}
const assertNoSecrets = (v) => {
  const s = JSON.stringify(v);
  assert.ok(!s.includes(PASS), 'password leaked');
  assert.ok(!s.includes(SESSION), 'session id leaked');
};

// ---- versioning -----------------------------------------------------------------------------------
test('version metadata reports 0.4.2', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.strictEqual(pkg.version, '0.4.2');
  assert.strictEqual(lock.version, '0.4.2');
  assert.strictEqual(lock.packages[''].version, '0.4.2');
  assert.match(read('README.md'), /^### 0\.4\.2$/m);
});

// ---- callsigns and profile links ------------------------------------------------------------------
test('callsign normalisation and validity', () => {
  assert.strictEqual(CB.normalizeCall('  w1 aw \t'), 'W1AW');
  assert.strictEqual(CB.normalizeCall(null), '');
  for (const ok of ['W1AW', 'w1aw/p', 'DL/W1AW', 'HB9/G4ABC/M', 'K1A', '3DA0XY']) assert.ok(CB.isValidCallsign(ok), ok);
  for (const bad of ['', '  ', 'AB', 'ABCDEF', '12345', 'W1AW//P', '/W1AW', 'W1AW/', 'W1AW?x=1', 'W1AW#', 'W1A W/../..', 'A/B/C/D1', 'ÄÖ1AB']) assert.ok(!CB.isValidCallsign(bad), JSON.stringify(bad));
});

test('profile URLs use the exact QRZ and HamQTH forms, normalised and encoded', () => {
  assert.strictEqual(CB.profileUrl('qrz', 'w1aw'), 'https://www.qrz.com/db/W1AW');
  assert.strictEqual(CB.profileUrl('hamqth', ' w1aw '), 'https://www.hamqth.com/W1AW');
  assert.strictEqual(CB.profileUrl('qrz', 'dl/w1aw/p'), 'https://www.qrz.com/db/DL/W1AW/P');
  assert.strictEqual(CB.profileUrl('hamqth', 'dl/w1aw'), 'https://www.hamqth.com/DL/W1AW');
});

test('profile URLs: nothing for an invalid callsign or unknown provider, and no injection', () => {
  assert.strictEqual(CB.profileUrl('qrz', ''), null);
  assert.strictEqual(CB.profileUrl('qrz', 'AB'), null);
  assert.strictEqual(CB.profileUrl('hamqth', 'W1AW?x=1'), null);
  assert.strictEqual(CB.profileUrl('hamqth', 'W1AW/../../x'), null);
  assert.strictEqual(CB.profileUrl('evil', 'W1AW'), null);
  assert.strictEqual(CB.profileUrl('__proto__', 'W1AW'), null);
  assert.strictEqual(CB.profileUrl('constructor', 'W1AW'), null);
  assert.strictEqual(CB.profileUrl('toString', 'W1AW'), null);
  assert.strictEqual(CB.profileUrl('javascript:alert(1)//', 'W1AW'), null);
});

test('profile links do not depend on the selected lookup provider or its configuration', () => {
  // profileUrl takes only (provider-of-the-link, callsign): it cannot see settings, credentials or lookup state.
  assert.strictEqual(CB.profileUrl.length, 2);
  const src = read('src/renderer/pages/live.js');
  assert.match(src, /data-provider="qrz"[^>]*aria-label="Open callsign on QRZ"/);
  assert.match(src, /data-provider="hamqth"[^>]*aria-label="Open callsign on HamQTH"/);
  assert.match(src, /title="Open callsign on QRZ"/);
  assert.match(src, /title="Open callsign on HamQTH"/);
  assert.ok(!/window\.open|location\.href\s*=/.test(src), 'links must go through the main process, never direct browser navigation');
});

test('main process opens profile links itself, from its own URL table, and never sends raw settings to the renderer', () => {
  const main = read('src/main/main.js');
  assert.match(main, /'external:profile': \(provider, call\) => \{\s*const url = profileUrl\(provider, call\);\s*if \(!url\) throw/);
  assert.ok(!/openExternal\(\s*(call|provider|args)/.test(main));
  assert.ok(!/'settings:get': \(\) => settings\.data/.test(main));
  assert.ok(!/send\('settings', settings\.data\)/.test(main));
  assert.ok(!/return settings\.data;/.test(main));
  assert.match(main, /const \{ callbook: _callbook, \.\.\.safePatch \}/);
});

// ---- credential storage and settings --------------------------------------------------------------
test('secret box encrypts with the OS keyring when usable and round-trips', () => {
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC(${s.split('').reverse().join('')})`),
    decryptString: (b) => b.toString().slice(4, -1).split('').reverse().join(''),
  };
  const box = createSecretBox({ safeStorage: fake });
  const sealed = box.seal(PASS);
  assert.ok(box.encrypted());
  assert.ok(sealed.startsWith('enc1:'));
  assert.ok(!sealed.includes(PASS));
  assert.strictEqual(box.open(sealed), PASS);
  assert.strictEqual(box.seal(''), '');
});

test('secret box falls back to plain settings storage without a real keyring (and reads either form)', () => {
  for (const safeStorage of [undefined, { isEncryptionAvailable: () => false }, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }, { isEncryptionAvailable: () => { throw new Error('x'); } }]) {
    const box = createSecretBox({ safeStorage });
    assert.ok(!box.encrypted());
    assert.strictEqual(box.seal(PASS), PASS);
    assert.strictEqual(box.open(PASS), PASS);
  }
  const broken = createSecretBox({ safeStorage: { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('keyring changed'); } } });
  assert.strictEqual(broken.open('enc1:AAAA'), '');
});

test('settings: new installs default to Disabled / No lookup', () => {
  assert.strictEqual(SETTINGS_DEFAULTS.callbook.provider, 'none');
  assert.strictEqual(config.publicConfig(undefined).provider, 'none');
  assert.strictEqual(config.resolveConfig(undefined, createSecretBox()).provider, 'none');
});

test('settings: provider and both providers\' credentials persist across restarts and survive switching', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    const box = createSecretBox({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s, 'utf8'), decryptString: (b) => b.toString('utf8') } });
    const store = new JsonStore(file, SETTINGS_DEFAULTS);
    config.applyPatch(store.data.callbook, { provider: 'qrz', qrz: { username: 'q-user', password: `${PASS}-q` }, hamqth: { username: 'h-user', password: `${PASS}-h` } }, box);
    store.saveNow();
    // switching provider must not erase the other provider's credentials
    config.applyPatch(store.data.callbook, { provider: 'hamqth' }, box);
    config.applyPatch(store.data.callbook, { provider: 'qrz' }, box);
    store.saveNow();

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(`${PASS}-q`) && !raw.includes(`${PASS}-h`), 'passwords must not be stored in plain text when a keyring is available');

    const reopened = new JsonStore(file, SETTINGS_DEFAULTS);
    const cfg = config.resolveConfig(reopened.data.callbook, box);
    assert.strictEqual(cfg.provider, 'qrz');
    assert.deepStrictEqual(cfg.qrz, { username: 'q-user', password: `${PASS}-q` });
    assert.deepStrictEqual(cfg.hamqth, { username: 'h-user', password: `${PASS}-h` });
    // existing settings keep working alongside the new section
    assert.strictEqual(reopened.data.adifServer.tcpPort, 2333);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings: renderer view never contains passwords; blank password keeps, clearPassword removes', () => {
  const box = createSecretBox();
  const stored = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS.callbook));
  config.applyPatch(stored, { provider: 'hamqth', hamqth: { username: USER, password: PASS } }, box);
  const pub = config.publicConfig(stored);
  assertNoSecrets(pub);
  assert.deepStrictEqual(pub.hamqth, { username: USER, hasPassword: true });
  assert.deepStrictEqual(pub.qrz, { username: '', hasPassword: false });

  config.applyPatch(stored, { hamqth: { username: 'renamed', password: '' } }, box); // form left blank
  assert.strictEqual(config.resolveConfig(stored, box).hamqth.password, PASS);
  assert.strictEqual(config.resolveConfig(stored, box).hamqth.username, 'renamed');
  config.applyPatch(stored, { hamqth: { clearPassword: true } }, box);
  assert.strictEqual(config.resolveConfig(stored, box).hamqth.password, '');
  config.applyPatch(stored, { provider: 'bogus' }, box);
  assert.strictEqual(stored.provider, 'none');
});

test('settings: validation messages for missing configuration', () => {
  const box = createSecretBox();
  const stored = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS.callbook));
  assert.deepStrictEqual(config.validate(stored, box), []);
  config.applyPatch(stored, { provider: 'qrz' }, box);
  assert.match(config.validate(stored, box)[0], /QRZ username and password required/);
  config.applyPatch(stored, { qrz: { username: USER } }, box);
  assert.match(config.validate(stored, box)[0], /QRZ password required/);
  config.applyPatch(stored, { qrz: { password: PASS } }, box);
  assert.deepStrictEqual(config.validate(stored, box), []);
});

test('settings UI: passwords are masked by default, never pre-filled, with show/hide and the required labels', () => {
  const src = read('src/renderer/pages/settings.js');
  const block = src.slice(src.indexOf('function drawCallbook'), src.indexOf('// ---- Logbooks'));
  assert.match(block, /id="cb-\$\{id\}-pass" type="password"/);
  assert.ok(!/id="cb-\$\{id\}-pass"[^>]*value=/.test(block), 'password inputs must never be given a value');
  assert.match(block, /cb-\$\{id\}-show/);
  assert.match(block, /Disabled \/ No lookup/);
  assert.match(block, /<option value="qrz"/);
  assert.match(block, /<option value="hamqth"/);
  assert.match(block, /XML Logbook Data subscription/);
  assert.ok(!/id="cb-qrz-apikey"/i.test(block), 'QRZ callsign lookup does not use a stored API key field');
  assert.match(block, /QRZ callsign lookup needs a QRZ account/);
});

// ---- text sanitising ------------------------------------------------------------------------------
test('remote text is sanitised and grid squares validated', () => {
  assert.strictEqual(clean('  <script>alert(1)</script>\u202eEvil\u0000  Name '), 'script alert(1) /script Evil Name');
  assert.strictEqual(clean('x'.repeat(500), 10).length, 10);
  assert.strictEqual(cleanGrid('fn31pr'), 'FN31PR');
  assert.strictEqual(cleanGrid('FN31'), 'FN31');
  for (const bad of ['', 'ZZ99', 'FN3', 'hello', 'FN31PRXX99']) assert.strictEqual(cleanGrid(bad), '', bad);
});

// ---- HamQTH ---------------------------------------------------------------------------------------
test('HamQTH: missing credentials give an actionable state and make no request', async () => {
  const f = hamqthFetch();
  const p = new HamQthProvider({ fetchImpl: f });
  for (const cfg of [{ username: '', password: '' }, { username: USER, password: '' }, { username: '', password: PASS }, undefined]) {
    const r = await p.lookup('W1AW', cfg);
    assert.strictEqual(r.status, 'not_configured');
    assert.strictEqual(r.message, 'Configure HamQTH username and password in Settings to enable HamQTH callsign lookup.');
  }
  assert.strictEqual(f.calls.length, 0);
});

test('HamQTH: logs in once, maps Name / QTH / Grid, reuses the session', async () => {
  const f = hamqthFetch();
  const p = new HamQthProvider({ fetchImpl: f });
  const r = await p.lookup('XX1ABC', CREDS);
  assert.deepStrictEqual({ s: r.status, n: r.name, q: r.qth, g: r.grid }, { s: 'ok', n: 'Pat', q: 'Springfield & Co', g: 'FN31PR' });
  assertNoSecrets(r);
  await p.lookup('XX2DEF', CREDS);
  const logins = f.calls.filter((c) => q(c).has('u'));
  const lookups = f.calls.filter((c) => q(c).has('callsign'));
  assert.strictEqual(logins.length, 1, 'session must be reused');
  assert.strictEqual(lookups.length, 2);
  assert.strictEqual(q(logins[0]).get('u'), USER);
  assert.strictEqual(q(lookups[0]).get('id'), SESSION);
  assert.strictEqual(q(lookups[0]).get('callsign'), 'XX1ABC');
  assert.ok(q(lookups[0]).get('prg'));
  assert.ok(f.calls.every((c) => c.url.startsWith('https://www.hamqth.com/xml.php?')));
});

test('HamQTH: falls back to the address name / city and never invents missing values', async () => {
  const sparse = '<HamQTH><search><callsign>xx1abc</callsign><adr_name>Patricia Example</adr_name><adr_city>Elsewhere</adr_city></search></HamQTH>';
  const r = await new HamQthProvider({ fetchImpl: hamqthFetch({ lookup: sparse }) }).lookup('XX1ABC', CREDS);
  assert.deepStrictEqual({ n: r.name, q: r.qth, g: r.grid }, { n: 'Patricia', q: 'Elsewhere', g: '' });
  const bare = '<HamQTH><search><callsign>xx1abc</callsign></search></HamQTH>';
  const r2 = await new HamQthProvider({ fetchImpl: hamqthFetch({ lookup: bare }) }).lookup('XX1ABC', CREDS);
  assert.deepStrictEqual({ s: r2.status, n: r2.name, q: r2.qth, g: r2.grid }, { s: 'ok', n: '', q: '', g: '' });
});

test('HamQTH: an expired session is renewed once and the lookup retried', async () => {
  let lookups = 0;
  const f = fakeFetch(({ url }) => {
    const sp = new URL(url).searchParams;
    if (sp.has('u')) return { body: HAMQTH_LOGIN_OK };
    return { body: ++lookups === 1 ? hamqthErr('Session does not exist or expired') : HAMQTH_FOUND };
  });
  const r = await new HamQthProvider({ fetchImpl: f }).lookup('XX1ABC', CREDS);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(f.calls.filter((c) => q(c).has('u')).length, 2);
});

test('HamQTH: session older than an hour is renewed before use', async () => {
  let t = 0;
  const f = hamqthFetch();
  const p = new HamQthProvider({ fetchImpl: f, now: () => t });
  await p.lookup('XX1ABC', CREDS);
  t += 30 * 60 * 1000;
  await p.lookup('XX1ABC', CREDS);
  assert.strictEqual(f.calls.filter((c) => q(c).has('u')).length, 1);
  t += 30 * 60 * 1000;
  await p.lookup('XX1ABC', CREDS);
  assert.strictEqual(f.calls.filter((c) => q(c).has('u')).length, 2);
});

test('HamQTH: bad credentials, not found, rate limit, server errors, malformed replies and timeouts never throw or leak', async () => {
  const cases = [
    [hamqthFetch({ login: hamqthErr('Wrong user name or password') }), 'auth_failed'],
    [hamqthFetch({ lookup: hamqthErr('Callsign not found') }), 'not_found'],
    [hamqthFetch({ lookup: hamqthErr('Too many requests') }), 'rate_limited'],
    [hamqthFetch({ lookup: 'not xml at all' }), 'error'],
    [hamqthFetch({ login: '<html>maintenance</html>' }), 'error'],
    [fakeFetch(() => ({ status: 503, body: 'down' })), 'unavailable'],
    [fakeFetch(() => ({ status: 429, body: 'slow down' })), 'rate_limited'],
    [fakeFetch(() => { const e = new Error(`timed out talking to ${PASS}`); e.name = 'TimeoutError'; throw e; }), 'unavailable'],
    [fakeFetch(() => ({ body: 'x'.repeat(300 * 1024) })), 'error'],
  ];
  for (const [f, want] of cases) {
    const r = await new HamQthProvider({ fetchImpl: f }).lookup('XX1ABC', CREDS);
    assert.strictEqual(r.status, want);
    assert.strictEqual(r.name + r.qth + r.grid, '');
    assertNoSecrets(r);
    assert.ok(r.message.length > 0 && r.message.length < 100, 'messages stay short');
  }
});

test('HamQTH: test() signs in with a fresh session and reports the outcome', async () => {
  const f = hamqthFetch();
  const p = new HamQthProvider({ fetchImpl: f });
  assert.strictEqual((await p.test(CREDS)).status, 'ok');
  assert.strictEqual((await p.test(CREDS)).status, 'ok');
  assert.strictEqual(f.calls.filter((c) => q(c).has('u')).length, 2);
  assert.strictEqual((await new HamQthProvider({ fetchImpl: hamqthFetch({ login: hamqthErr('Wrong user name or password') }) }).test(CREDS)).status, 'auth_failed');
  assert.strictEqual((await p.test({})).status, 'not_configured');
});

// ---- QRZ ------------------------------------------------------------------------------------------
test('QRZ: missing credentials give an actionable state and make no request', async () => {
  const f = qrzFetch();
  const p = new QrzProvider({ fetchImpl: f });
  for (const cfg of [{ username: '', password: '' }, { username: USER, password: '' }, undefined]) {
    const r = await p.lookup('W1AW', cfg);
    assert.strictEqual(r.status, 'not_configured');
    assert.strictEqual(r.message, 'Configure QRZ username and password in Settings to enable QRZ callsign lookup.');
  }
  assert.strictEqual(f.calls.length, 0);
});

test('QRZ: uses the documented XML service over POST, credentials in the body and never in the URL', async () => {
  const f = qrzFetch();
  const p = new QrzProvider({ fetchImpl: f });
  const r = await p.lookup('XX1ABC', CREDS);
  assert.deepStrictEqual({ s: r.status, n: r.name, q: r.qth, g: r.grid }, { s: 'ok', n: 'Patty', q: 'Springfield, MA', g: 'FN31PR' });
  assertNoSecrets(r);
  assert.strictEqual(f.calls.length, 2);
  const [login, lookup] = f.calls;
  for (const c of f.calls) {
    assert.strictEqual(c.method, 'POST');
    assert.strictEqual(c.url, 'https://xmldata.qrz.com/xml/current/');
    assert.ok(!c.url.includes(PASS) && !c.url.includes(SESSION) && !c.url.includes(USER));
    assert.ok(!Object.keys(c.headers).some((h) => /x-api-key|authorization/i.test(h)));
  }
  assert.strictEqual(q(login).get('username'), USER);
  assert.strictEqual(q(login).get('password'), PASS);
  assert.ok(q(login).get('agent'));
  assert.strictEqual(q(lookup).get('s'), SESSION);
  assert.strictEqual(q(lookup).get('callsign'), 'XX1ABC');
  assert.ok(!q(lookup).has('password'));
});

test('QRZ: reuses the session, and renews it once when QRZ says it timed out', async () => {
  const f = qrzFetch();
  const p = new QrzProvider({ fetchImpl: f });
  await p.lookup('XX1ABC', CREDS);
  await p.lookup('XX2DEF', CREDS);
  assert.strictEqual(f.calls.filter((c) => q(c).has('username')).length, 1);

  let n = 0;
  const g = fakeFetch(({ body }) => {
    const b = new URLSearchParams(body);
    if (b.has('username')) return { body: QRZ_LOGIN_OK };
    return { body: ++n === 1 ? qrzErr('Session Timeout') : QRZ_FOUND };
  });
  const r = await new QrzProvider({ fetchImpl: g }).lookup('XX1ABC', CREDS);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(g.calls.filter((c) => q(c).has('username')).length, 2);
});

test('QRZ: name falls back to first then last name; no city means no QTH; invalid grid dropped', async () => {
  const mk = (inner) => `<QRZDatabase><Callsign><call>XX1ABC</call>${inner}</Callsign><Session><Key>${SESSION}</Key></Session></QRZDatabase>`;
  const run = (inner) => new QrzProvider({ fetchImpl: qrzFetch({ lookup: mk(inner) }) }).lookup('XX1ABC', CREDS);
  const a = await run('<fname>Pat</fname><name>Example</name><addr2>Town</addr2><grid>nonsense</grid>');
  assert.deepStrictEqual({ n: a.name, q: a.qth, g: a.grid }, { n: 'Pat', q: 'Town', g: '' });
  const b = await run('<name>Example</name>');
  assert.deepStrictEqual({ n: b.name, q: b.qth, g: b.grid }, { n: 'Example', q: '', g: '' });
});

test('QRZ: failures map to short statuses without leaking anything', async () => {
  const cases = [
    [qrzFetch({ login: qrzErr('Username/password incorrect') }), 'auth_failed'],
    [qrzFetch({ login: qrzErr('Connection Refused: too many bad logins') }), 'rate_limited'],
    [qrzFetch({ lookup: qrzErr('Not found: XX1ABC', true) }), 'not_found'],
    [qrzFetch({ lookup: qrzErr('Lookup limit exceeded', true) }), 'rate_limited'],
    [qrzFetch({ lookup: '<html>oops</html>' }), 'error'],
    [qrzFetch({ login: '<QRZDatabase><Session></Session></QRZDatabase>' }), 'error'],
    [fakeFetch(() => ({ status: 500, body: '' })), 'unavailable'],
    [fakeFetch(() => { throw new Error(`socket hang up ${PASS}`); }), 'unavailable'],
  ];
  for (const [f, want] of cases) {
    const r = await new QrzProvider({ fetchImpl: f }).lookup('XX1ABC', CREDS);
    assert.strictEqual(r.status, want);
    assertNoSecrets(r);
    assert.ok(r.message.length > 0 && r.message.length < 100);
  }
});

test('QRZ: a reduced record from a non-subscriber is reported as limited, not as silence', async () => {
  const limited = `<QRZDatabase><Callsign><call>XX1ABC</call></Callsign><Session><Key>${SESSION}</Key><Message>A subscription is required to obtain the complete data</Message></Session></QRZDatabase>`;
  const r = await new QrzProvider({ fetchImpl: qrzFetch({ lookup: limited }) }).lookup('XX1ABC', CREDS);
  assert.strictEqual(r.status, 'limited');
  assert.match(r.message, /subscription/i);
});

// ---- lookup service -------------------------------------------------------------------------------
function service({ provider = 'hamqth', offline = false, fetchers = {}, cfg = {} } = {}) {
  const fh = fetchers.hamqth || hamqthFetch();
  const fq = fetchers.qrz || qrzFetch();
  const state = { provider, offline, qrz: { ...CREDS }, hamqth: { ...CREDS }, ...cfg };
  const svc = new CallbookService({
    getConfig: () => state,
    isOffline: () => state.offline,
    providers: { qrz: new QrzProvider({ fetchImpl: fq }), hamqth: new HamQthProvider({ fetchImpl: fh }) },
  });
  return { svc, state, fh, fq };
}

test('service: Disabled / No lookup never touches the network', async () => {
  const { svc, fh, fq } = service({ provider: 'none' });
  const r = await svc.lookup('W1AW');
  assert.strictEqual(r.status, 'disabled');
  assert.strictEqual(fh.calls.length + fq.calls.length, 0);
});

test('service: only valid, normalised callsigns are looked up, only with a configured provider', async () => {
  const { svc, fh } = service();
  assert.strictEqual((await svc.lookup('  ')).status, 'invalid');
  assert.strictEqual((await svc.lookup('AB')).status, 'invalid');
  assert.strictEqual((await svc.lookup('W1AW?x')).status, 'invalid');
  assert.strictEqual(fh.calls.length, 0);
  const r = await svc.lookup(' xx1 abc ');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.call, 'XX1ABC');
  assert.ok(fh.calls.some((c) => q(c).get('callsign') === 'XX1ABC'));

  const missing = service({ provider: 'qrz', cfg: { qrz: { username: '', password: '' } } });
  assert.strictEqual((await missing.svc.lookup('XX1ABC')).status, 'not_configured');
  assert.strictEqual(missing.fq.calls.length, 0);
});

test('service: offline mode makes no QRZ or HamQTH request, even with valid credentials', async () => {
  for (const provider of ['qrz', 'hamqth']) {
    const { svc, fh, fq } = service({ provider, offline: true });
    const r = await svc.lookup('XX1ABC');
    assert.strictEqual(r.status, 'offline');
    assert.match(r.message, /Offline mode/);
    assert.ok(!/password|login|auth|credential|fail|error/i.test(r.message), 'a skipped lookup must not read like a failure');
    assert.strictEqual((await svc.test()).status, 'offline');
    assert.strictEqual(fh.calls.length + fq.calls.length, 0);
  }
});

test('service: offline mode also wins over a missing configuration and a warm cache', async () => {
  const { svc, state, fh } = service();
  await svc.lookup('XX1ABC');
  const before = fh.calls.length;
  state.offline = true;
  assert.strictEqual((await svc.lookup('XX1ABC')).status, 'offline');
  state.hamqth = { username: '', password: '' };
  assert.strictEqual((await svc.lookup('XX9ZZZ')).status, 'offline');
  assert.strictEqual(fh.calls.length, before);
  state.offline = false; // and lookups resume when offline mode is turned off
  state.hamqth = { ...CREDS };
  assert.strictEqual((await svc.lookup('XX9ZZZ')).status, 'ok');
});

test('service: duplicate lookups for the same callsign and provider are avoided', async () => {
  const { svc, fh } = service();
  const [a, b] = await Promise.all([svc.lookup('XX1ABC'), svc.lookup('xx1abc')]); // concurrent
  assert.strictEqual(a.status, 'ok');
  assert.deepStrictEqual(a, b);
  await svc.lookup('XX1ABC'); // and again later
  assert.strictEqual(fh.calls.filter((c) => q(c).has('callsign')).length, 1);
  await svc.lookup('XX2DEF');
  assert.strictEqual(fh.calls.filter((c) => q(c).has('callsign')).length, 2);
});

test('service: switching provider or changing settings applies immediately', async () => {
  const { svc, state, fh, fq } = service();
  await svc.lookup('XX1ABC');
  state.provider = 'qrz';
  assert.strictEqual((await svc.lookup('XX1ABC')).provider, 'qrz'); // different provider: separate cache entry
  assert.ok(fq.calls.length > 0);
  const before = fh.calls.length;
  state.provider = 'hamqth';
  await svc.lookup('XX1ABC');
  assert.strictEqual(fh.calls.length, before, 'cached answer is still valid for the same provider');
  svc.invalidate(); // what saving new credentials does
  await svc.lookup('XX1ABC');
  assert.ok(fh.calls.length > before);
});

test('service: failures are cached only briefly and never throw', async () => {
  let t = 0;
  let down = true;
  const f = fakeFetch(({ url }) => (down ? { status: 503, body: '' } : { body: new URL(url).searchParams.has('u') ? HAMQTH_LOGIN_OK : HAMQTH_FOUND }));
  const svc = new CallbookService({
    getConfig: () => ({ provider: 'hamqth', hamqth: CREDS }), isOffline: () => false, now: () => t,
    providers: { hamqth: new HamQthProvider({ fetchImpl: f }) },
  });
  assert.strictEqual((await svc.lookup('XX1ABC')).status, 'unavailable');
  const n = f.calls.length;
  assert.strictEqual((await svc.lookup('XX1ABC')).status, 'unavailable');
  assert.strictEqual(f.calls.length, n, 'no request storm while the provider is down');
  down = false; t += 31_000;
  assert.strictEqual((await svc.lookup('XX1ABC')).status, 'ok');
});

test('service: a portable callsign that is not listed falls back to its home call', async () => {
  const f = fakeFetch(({ url }) => {
    const sp = new URL(url).searchParams;
    if (sp.has('u')) return { body: HAMQTH_LOGIN_OK };
    return { body: sp.get('callsign') === 'XX1ABC/P' ? hamqthErr('Callsign not found') : HAMQTH_FOUND };
  });
  const { svc } = service({ fetchers: { hamqth: f } });
  const r = await svc.lookup('xx1abc/p');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.call, 'XX1ABC/P');
  assert.deepStrictEqual(f.calls.filter((c) => q(c).has('callsign')).map((c) => q(c).get('callsign')), ['XX1ABC/P', 'XX1ABC']);
});

test('service: Test connection signs in only, and reports missing configuration', async () => {
  const { svc, fh } = service();
  assert.strictEqual((await svc.test()).status, 'ok');
  assert.ok(fh.calls.every((c) => !q(c).has('callsign')), 'test must not look up a callsign');
  const none = service({ provider: 'none' });
  assert.strictEqual((await none.svc.test()).status, 'disabled');
  const missing = service({ cfg: { hamqth: { username: USER, password: '' } } });
  assert.strictEqual((await missing.svc.test()).status, 'not_configured');
  assert.strictEqual(missing.fh.calls.length, 0);
});

// ---- Live QSO lookup coordinator ------------------------------------------------------------------
function harness({ lookup, initial = {} } = {}) {
  const values = { name: '', qth: '', grid: '', ...initial };
  const fields = Object.fromEntries(Object.keys(values).map((k) => [k, { get: () => values[k], set: (v) => { values[k] = v; } }]));
  const statuses = [];
  const calls = [];
  const coord = new CB.LookupCoordinator({
    fields,
    lookup: async (c) => { calls.push(c); return (lookup || (async () => ({ status: 'ok', name: 'Pat', qth: 'Springfield', grid: 'FN31PR' })))(c); },
    onStatus: (s) => statuses.push(s),
  });
  const settle = () => new Promise((r) => setImmediate(r));
  return { values, coord, calls, statuses, settle };
}

test('live lookup: typing alone never triggers a lookup - only flush() (leaving the field) does', async () => {
  const h = harness();
  for (const s of ['x', 'xx', 'xx1', 'xx1a', 'xx1ab', 'XX1ABC']) h.coord.input(s);
  await h.settle();
  assert.strictEqual(h.calls.length, 0, 'nothing is sent while typing, however long the operator pauses');
  await h.coord.flush();
  assert.deepStrictEqual(h.calls, ['XX1ABC']);
  assert.deepStrictEqual({ n: h.values.name, q: h.values.qth, g: h.values.grid }, { n: 'Pat', q: 'Springfield', g: 'FN31PR' });
  assert.strictEqual(h.statuses.at(-1).status, 'ok');
});

test('live lookup: invalid callsigns never trigger a lookup, even on flush', async () => {
  const h = harness();
  for (const s of ['', 'AB', '12345', 'W1AW//P']) { h.coord.input(s); await h.coord.flush(); }
  assert.strictEqual(h.calls.length, 0);
});

test('live lookup: leaving the field looks up at once, and the same callsign is not asked twice', async () => {
  const h = harness();
  h.coord.input('xx1abc');
  await h.coord.flush();
  await h.coord.flush(); // leaving the field again without changing anything: no second request
  h.coord.input('XX1ABC ');
  await h.coord.flush();
  assert.deepStrictEqual(h.calls, ['XX1ABC']);
});

test('live lookup: fields the operator edited are never overwritten', async () => {
  const h = harness();
  h.values.name = 'Typed by me'; h.coord.touch('name');
  h.coord.input('XX1ABC');
  await h.coord.flush();
  assert.strictEqual(h.values.name, 'Typed by me');
  assert.strictEqual(h.values.qth, 'Springfield'); // untouched fields still fill
  // manually clearing a filled field also counts as an edit
  h.values.qth = ''; h.coord.touch('qth');
  h.coord.input('XX2DEF');
  await h.coord.flush();
  assert.strictEqual(h.values.qth, '');
  assert.strictEqual(h.values.name, 'Typed by me');
});

test('live lookup: a non-empty field is never replaced unless the app filled it itself', async () => {
  const h = harness({ initial: { grid: 'AA00' } }); // e.g. left from something else, not touched via input
  h.coord.input('XX1ABC');
  await h.coord.flush();
  assert.strictEqual(h.values.grid, 'AA00');
  assert.strictEqual(h.values.name, 'Pat');
});

test('live lookup: values the app filled are replaced when the callsign changes, never left behind', async () => {
  const data = { XX1ABC: { name: 'Pat', qth: 'Springfield', grid: 'FN31PR' }, XX2DEF: { name: 'Sam', qth: '', grid: '' } };
  const h = harness({ lookup: async (c) => ({ status: 'ok', ...data[c] }) });
  h.coord.input('XX1ABC'); await h.coord.flush();
  h.coord.input('XX2DEF');
  assert.deepStrictEqual({ n: h.values.name, q: h.values.qth, g: h.values.grid }, { n: '', q: '', g: '' }, 'old fill cleared as soon as the call changes');
  await h.coord.flush();
  assert.deepStrictEqual({ n: h.values.name, q: h.values.qth, g: h.values.grid }, { n: 'Sam', q: '', g: '' }, 'missing values are not invented');
});

test('live lookup: a slow answer for an earlier callsign is ignored', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ lookup: async (c) => { if (c === 'XX1ABC') await gate; return { status: 'ok', name: c, qth: '', grid: '' }; } });
  h.coord.input('XX1ABC');
  const slow = h.coord.flush();
  h.coord.input('XX2DEF');
  await h.coord.flush();
  release(); await slow;
  assert.strictEqual(h.values.name, 'XX2DEF');
});

test('live lookup: a failing lookup leaves entry usable and shows a short message', async () => {
  const h = harness({ lookup: async () => { throw new Error(`boom ${PASS}`); } });
  h.values.name = 'Typed'; h.coord.touch('name');
  h.coord.input('XX1ABC');
  await assert.doesNotReject(h.coord.flush());
  assert.strictEqual(h.values.name, 'Typed');
  const s = h.statuses.at(-1);
  assert.strictEqual(s.status, 'error');
  assertNoSecrets(s);
  // provider-level failures behave the same: nothing filled, message shown, no throw
  const h2 = harness({ lookup: async () => ({ status: 'auth_failed', message: 'QRZ rejected the saved login. Check Settings > Callbook Lookup.', name: '', qth: '', grid: '' }) });
  h2.coord.input('XX1ABC'); await h2.coord.flush();
  assert.strictEqual(h2.values.name, '');
  assert.strictEqual(h2.statuses.at(-1).status, 'auth_failed');
});

test('live lookup: offline / not-configured results are informational and retried once things change', async () => {
  let status = 'offline';
  const h = harness({ lookup: async () => (status === 'ok' ? { status, name: 'Pat', qth: '', grid: '' } : { status, message: 'Offline mode: callbook lookup skipped.', name: '', qth: '', grid: '' }) });
  h.coord.input('XX1ABC'); await h.coord.flush();
  assert.strictEqual(h.statuses.at(-1).status, 'offline');
  assert.strictEqual(h.values.name, '');
  status = 'ok';
  await h.coord.flush(); // e.g. offline mode turned off, then focus leaves the field again
  assert.strictEqual(h.values.name, 'Pat');
});

test('live lookup: reset (after saving or clearing a QSO) forgets edits and allows a fresh lookup', async () => {
  const h = harness();
  h.coord.input('XX1ABC'); await h.coord.flush();
  h.coord.touch('name');
  h.coord.reset();
  h.values.name = ''; h.values.qth = ''; h.values.grid = '';
  h.coord.input('XX1ABC'); await h.coord.flush();
  assert.strictEqual(h.calls.length, 2);
  assert.strictEqual(h.values.name, 'Pat', 'touched flags do not carry over to the next QSO');
});

test('live lookup: input() is synchronous and side-effect free beyond bookkeeping (no scheduled work, nothing to leak)', async () => {
  const values = { name: '', qth: '', grid: '' };
  const fields = Object.fromEntries(Object.keys(values).map((k) => [k, { get: () => values[k], set: (v) => { values[k] = v; } }]));
  let calls = 0;
  const coord = new CB.LookupCoordinator({ fields, lookup: async () => { calls += 1; return { status: 'ok', name: 'Pat', qth: '', grid: '' }; } });
  assert.doesNotThrow(() => coord.input('XX1ABC'));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls, 0, 'input() must never itself schedule or trigger a lookup');
  assert.strictEqual(values.name, '');
  assert.doesNotThrow(() => coord.reset());
});

test('live page wiring: lookup fields fill through the coordinator, status text is assigned as text, and nothing schedules a lookup on input', () => {
  const src = read('src/renderer/pages/live.js');
  assert.match(src, /new CB\.LookupCoordinator/);
  assert.match(src, /api\('callbook:lookup', call\)/);
  assert.match(src, /box\.textContent = res\.message/);
  assert.ok(!/lookup-status[^;]*innerHTML/.test(src));
  assert.match(read('src/renderer/index.html'), /callbook-shared\.js/);
  const inputHandler = src.slice(src.indexOf("addEventListener('input', (e) => {", src.indexOf('#f-call')), src.indexOf("addEventListener('blur'"));
  assert.match(inputHandler, /lookup\.input\(v\)/);
  assert.ok(!/lookup\.flush\(\)/.test(inputHandler), 'the callsign input handler must not trigger a lookup itself');
});

test('live page wiring: leaving the callsign field (blur) is the only thing that triggers a lookup or reveals the profile links', () => {
  const src = read('src/renderer/pages/live.js');
  const blurHandler = src.slice(src.indexOf("addEventListener('blur'", src.indexOf('#f-call')), src.indexOf("addEventListener('keydown'"));
  assert.match(blurHandler, /leftCallField\s*=\s*true/);
  assert.match(blurHandler, /updateLinks\(\)/);
  assert.match(blurHandler, /lookup\?\.flush\(\)/);
});

test('live page wiring: a blur firing after page teardown (lookup and `el` already cleared) does not throw', () => {
  // Regression: the SPA calls unmount() (which nulls `lookup` and the mount's `el` reference) before
  // clearing the DOM, so a stray blur event on the still-attached callsign input must not call
  // lookup.flush() or el.querySelector(...) (via linkGroup()/updateLinks()) on a null reference.
  const src = read('src/renderer/pages/live.js');
  assert.match(src, /lookup\?\.flush\(\)/);
  assert.match(src, /const linkGroup = \(\) => el\?\.querySelector/);
  assert.match(src, /const updateLinks = \(\) => linkGroup\(\)\?\.classList/);
});

// ---- Live QSO: profile links hidden until the callsign field is left --------------------------------
test('live page wiring: QRZ/HamQTH links start hidden and are only revealed on blur with a valid callsign', () => {
  const src = read('src/renderer/pages/live.js');
  assert.match(src, /btn-group btn-group-sm d-none"[^>]*aria-label="Callsign profile links"/);
  assert.ok(!/data-provider="qrz"[^>]*disabled/.test(src), 'visibility is controlled by d-none, not a disabled attribute');
  assert.match(src, /const updateLinks = \(\) => linkGroup\(\)\?\.classList\.toggle\('d-none', !\(leftCallField && CB\.isValidCallsign/);
});

test('live page wiring: typing after leaving the field hides the links again until the next blur', () => {
  const src = read('src/renderer/pages/live.js');
  const inputHandler = src.slice(src.indexOf("addEventListener('input', (e) => {", src.indexOf('#f-call')), src.indexOf("addEventListener('blur'"));
  assert.match(inputHandler, /leftCallField = false/);
  assert.match(inputHandler, /updateLinks\(\)/);
});

test('live page wiring: Clear hides the profile links and forgets that the field was ever left', () => {
  const src = read('src/renderer/pages/live.js');
  const clearFn = src.slice(src.indexOf('function clear('), src.indexOf('\n  }\n', src.indexOf('function clear(')));
  assert.match(clearFn, /leftCallField = false/);
  assert.match(clearFn, /classList\.add\('d-none'\)/);
});
