'use strict';
/*
 * GitHub Releases discovery. Uses the REST API (never the HTML releases page), unauthenticated, with no secret in the
 * application. Versions come from release tags (see version.js), never from asset file names.
 */
const { classifyRelease, compareVersions } = require('./version');
const { isChannelEligible } = require('./channels');

const API_ROOT = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGES = 10;            // 1000 releases; the prune workflow keeps the list far shorter
const REQUEST_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * kind: network | timeout | http | rate-limit | malformed | aborted | disabled
 * `transient` errors are worth a bounded retry (connectivity, timeouts, 5xx); the others are final for this attempt.
 */
class UpdateCheckError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'UpdateCheckError';
    this.kind = kind;
    this.status = extra.status || 0;
    this.resetAt = extra.resetAt || null; // ms epoch, rate limits only
  }
  get transient() { return this.kind === 'network' || this.kind === 'timeout' || (this.kind === 'http' && this.status >= 500); }
}

function repoUrl(repo) { return `https://github.com/${repo}`; }
/** The release page URL is built from the tag, not taken from API data. */
function releasePageUrl(repo, tag) { return `${repoUrl(repo)}/releases/tag/${encodeURIComponent(tag)}`; }

function parseNextLink(header) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

function rateLimitInfo(res, bodyText) {
  const h = (n) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(n) : null);
  const remaining = h('x-ratelimit-remaining');
  const retryAfter = h('retry-after');
  const limited = res.status === 429 || (res.status === 403 && (remaining === '0' || retryAfter !== null || /rate limit/i.test(bodyText || '')));
  if (!limited) return null;
  let resetAt = null;
  const reset = Number(h('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) resetAt = reset * 1000;
  else if (retryAfter !== null && Number.isFinite(Number(retryAfter))) resetAt = Date.now() + Number(retryAfter) * 1000;
  return { resetAt };
}

async function readLimitedText(res, max) {
  const text = await res.text();
  if (text.length > max) throw new UpdateCheckError('malformed', 'The GitHub response was unexpectedly large');
  return text;
}

/**
 * Fetch every page of the repository's releases. Returns { releases: [raw items], truncated }.
 * The API lists releases by creation date, not by version, so all pages are read (up to MAX_PAGES) and the newest
 * eligible version is chosen afterwards.
 */
async function fetchReleases({ repo, fetchImpl = fetch, userAgent, signal, timeoutMs = REQUEST_TIMEOUT_MS, maxPages = MAX_PAGES, perPage = PER_PAGE }) {
  const out = [];
  let url = `${API_ROOT}/repos/${repo}/releases?per_page=${perPage}&page=1`;
  let truncated = false;
  for (let page = 1; url; page++) {
    if (page > maxPages) { truncated = true; break; }
    let res;
    let text;
    try {
      const timer = AbortSignal.timeout(timeoutMs);
      const sig = signal ? AbortSignal.any([signal, timer]) : timer;
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': userAgent || 'cloudlog-desktop' },
        signal: sig,
        redirect: 'follow',
      });
      text = await readLimitedText(res, MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof UpdateCheckError) throw e;
      if (signal && signal.aborted) throw new UpdateCheckError('aborted', 'The update check was cancelled');
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new UpdateCheckError('timeout', 'GitHub did not respond in time');
      throw new UpdateCheckError('network', 'Could not reach GitHub (no network connection or GitHub is unreachable)');
    }
    if (!res.ok) {
      const rl = rateLimitInfo(res, text);
      if (rl) throw new UpdateCheckError('rate-limit', 'GitHub rate limit reached; try again later', { status: res.status, resetAt: rl.resetAt });
      throw new UpdateCheckError('http', `GitHub answered HTTP ${res.status}`, { status: res.status });
    }
    let body;
    try { body = JSON.parse(text); } catch { throw new UpdateCheckError('malformed', 'GitHub returned an unreadable response'); }
    if (!Array.isArray(body)) throw new UpdateCheckError('malformed', 'GitHub returned an unexpected response (not a list of releases)');
    out.push(...body);
    const next = parseNextLink(res.headers && res.headers.get ? res.headers.get('link') : null);
    if (next) url = next;
    else if (!res.headers || !res.headers.get || res.headers.get('link') === null) url = body.length >= perPage ? `${API_ROOT}/repos/${repo}/releases?per_page=${perPage}&page=${page + 1}` : null;
    else url = null;
    // Only follow pagination links on the API host.
    if (url && !url.startsWith(`${API_ROOT}/`)) throw new UpdateCheckError('malformed', 'GitHub returned an unexpected pagination link');
  }
  return { releases: out, truncated };
}

function cleanAsset(a, repo, tag) {
  if (!a || typeof a !== 'object' || typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') return null;
  if (a.state !== undefined && a.state !== 'uploaded') return null;
  let u;
  try { u = new URL(a.browser_download_url); } catch { return null; }
  // Downloads must come from this repository's release for this tag.
  const prefix = `/${repo}/releases/download/${encodeURIComponent(tag)}/`;
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || !u.pathname.startsWith(prefix) || u.username || u.password) return null;
  const size = Number.isFinite(a.size) && a.size >= 0 ? a.size : null;
  return { name: a.name, url: u.href, size };
}

/**
 * Turn the raw API list into a catalog of supported releases plus diagnostics for everything that was excluded.
 *   entries:     [{ version, parsed, tag, channel, url, publishedAt, assets }]  (drafts, bad tags and flag mismatches excluded)
 *   diagnostics: [{ tag, kind, reason }]                                         (not drafts: those are simply not releases yet)
 */
function buildCatalog(rawReleases, repo) {
  const entries = [];
  const diagnostics = [];
  const seen = new Map();
  for (const rel of Array.isArray(rawReleases) ? rawReleases : []) {
    const c = classifyRelease(rel);
    if (!c.ok) {
      if (c.kind !== 'draft') diagnostics.push({ tag: rel && typeof rel.tag_name === 'string' ? rel.tag_name.slice(0, 64) : '(none)', kind: c.kind, reason: c.reason });
      continue;
    }
    const p = c.parsed;
    if (seen.has(p.text)) { diagnostics.push({ tag: rel.tag_name, kind: 'duplicate', reason: `more than one release for version ${p.text}; the first one listed is used` }); continue; }
    const assets = (Array.isArray(rel.assets) ? rel.assets : []).map((a) => cleanAsset(a, repo, rel.tag_name)).filter(Boolean);
    const entry = {
      version: p.text, parsed: p, tag: rel.tag_name, channel: p.channel,
      url: releasePageUrl(repo, rel.tag_name),
      publishedAt: typeof rel.published_at === 'string' ? rel.published_at : null,
      assets,
    };
    seen.set(p.text, entry);
    entries.push(entry);
  }
  return { entries, diagnostics };
}

/** Newest release that is eligible under the settings AND strictly newer than the reference version; null if none. */
function selectBest(entries, referenceParsed, eff) {
  let best = null;
  for (const e of entries) {
    if (!isChannelEligible(e.channel, eff)) continue;
    if (referenceParsed && compareVersions(e.parsed, referenceParsed) <= 0) continue; // never a downgrade or a reinstall
    if (!best || compareVersions(e.parsed, best.parsed) > 0) best = e;
  }
  return best;
}

module.exports = { API_ROOT, UpdateCheckError, fetchReleases, buildCatalog, selectBest, releasePageUrl, repoUrl, parseNextLink };
