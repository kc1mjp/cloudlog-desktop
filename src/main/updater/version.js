'use strict';
/*
 * Version parsing, ordering and release-channel classification for the in-app updater.
 *
 * The project's version scheme is CalVer with SemVer-compatible syntax (docs/VERSIONING.md):
 *
 *     YYMM.RELEASE.PATCH[-STAGE.NUMBER]        e.g. 2610.1.2-beta.3      Git tag: v2610.1.2-beta.3
 *
 * STAGE is alpha | beta | rc; no suffix = stable. Ordering is SemVer's: numeric per component and
 * alpha < beta < rc < stable. Versions are NEVER compared as strings.
 *
 * The packaged application cannot require() the release tooling under .github/ (only src/** and package.json are
 * packaged), so the grammar is restated here; test/updater-version.test.js checks that both implementations accept the
 * same strings and order them identically.
 */

const STAGES = ['alpha', 'beta', 'rc'];                 // ascending; stable ranks above all of them
const NUM = '(0|[1-9][0-9]{0,8})';
const POS = '([1-9][0-9]{0,8})';
const VERSION_RE = new RegExp(`^([1-9][0-9]{3})\\.${POS}\\.${NUM}(?:-(alpha|beta|rc)\\.${POS})?$`);

const SUPPORTED_FORMATS = 'vYYMM.RELEASE.PATCH (stable) or vYYMM.RELEASE.PATCH-alpha.N, -beta.N, -rc.N (see docs/VERSIONING.md)';

/** Channel names as used by the settings and the UI, ascending in stability. */
const CHANNELS = Object.freeze(['alpha', 'beta', 'rc', 'stable']);
const CHANNEL_LABELS = Object.freeze({ stable: 'Stable', rc: 'Release candidate', beta: 'Beta', alpha: 'Alpha', unknown: 'Unrecognized' });

/** Parse a canonical version (no leading "v"). Returns null when it is not a supported version. */
function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  const month = Number(m[1].slice(2));
  if (month < 1 || month > 12) return null;
  const stage = m[4] || null;
  return {
    text,
    yymm: BigInt(m[1]),
    release: BigInt(m[2]),
    patch: BigInt(m[3]),
    stage,
    channel: stage || 'stable',
    number: stage ? BigInt(m[5]) : 0n,
    prerelease: stage !== null,
    tag: `v${text}`,
  };
}

/** Parse a Git tag such as "v2610.1.0-beta.2". Null for anything that is not one of our version tags. */
function parseTag(tag) {
  if (typeof tag !== 'string' || tag[0] !== 'v') return null;
  return parseVersion(tag.slice(1));
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const stageRank = (v) => (v.stage ? STAGES.indexOf(v.stage) : STAGES.length);

/** Negative if a < b, 0 if equal, positive if a > b (parsed versions). */
function compareVersions(a, b) {
  return cmp(a.yymm, b.yymm) || cmp(a.release, b.release) || cmp(a.patch, b.patch) ||
    cmp(stageRank(a), stageRank(b)) || cmp(a.number, b.number);
}

/**
 * Classify a GitHub release object. Never throws.
 *   { ok: true, parsed }                       a supported, consistent version tag
 *   { ok: false, reason, kind }                kind: draft | unrecognized-tag | flag-mismatch
 * Drafts are excluded first. A release whose GitHub "prerelease" flag disagrees with its tag (a stable-looking tag marked
 * as a prerelease, or a staged tag not marked as one) cannot be classified reliably and is excluded, never guessed.
 */
function classifyRelease(release) {
  if (!release || typeof release !== 'object') return { ok: false, kind: 'unrecognized-tag', reason: 'entry is not a release object' };
  if (release.draft === true) return { ok: false, kind: 'draft', reason: 'draft release' };
  const tag = release.tag_name;
  const parsed = parseTag(tag);
  if (!parsed) {
    const shown = typeof tag === 'string' ? JSON.stringify(tag.slice(0, 64)) : String(typeof tag);
    return { ok: false, kind: 'unrecognized-tag', reason: `tag ${shown} is not a supported version tag; supported: ${SUPPORTED_FORMATS}` };
  }
  const flagged = release.prerelease === true;
  if (flagged !== parsed.prerelease) {
    return {
      ok: false, kind: 'flag-mismatch',
      reason: `tag ${tag} is ${parsed.prerelease ? parsed.stage : 'stable'} but the GitHub release is ${flagged ? '' : 'not '}marked as a prerelease; its channel cannot be established`,
    };
  }
  return { ok: true, parsed };
}

module.exports = { STAGES, CHANNELS, CHANNEL_LABELS, SUPPORTED_FORMATS, parseVersion, parseTag, compareVersions, classifyRelease };
