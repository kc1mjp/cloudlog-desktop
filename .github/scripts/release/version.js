'use strict';
/*
 * Cloudlog Desktop version parsing, comparison and release classification.
 *
 * The canonical application version lives ONLY in package.json and is CalVer with SemVer-compatible
 * syntax (the first component names a calendar release line, not an API compatibility boundary):
 *
 *     YYMM.RELEASE.PATCH[-STAGE.NUMBER]        e.g. 2610.1.2-beta.3
 *
 *   YYMM     last two digits of the target year + two-digit target month (01-12), e.g. 2610
 *   RELEASE  release sequence within that release line, starts at 1
 *   PATCH    maintenance revision of that release, starts at 0
 *   STAGE    optional: alpha | beta | rc          (no suffix = stable)
 *   NUMBER   prerelease sequence within the stage, starts at 1
 *
 * Numeric components have no leading zeros (the month inside YYMM keeps its zero: 2601).
 * Ordering is SemVer's:  2610.1.0-alpha.1 < -alpha.2 < -beta.1 < -rc.1 < 2610.1.0 < 2610.1.1-beta.1 < 2610.2.0
 * Git tag = "v" + canonical version.
 */

const STAGES = ['alpha', 'beta', 'rc'];          // ascending; stable ranks above all of them
const NUM = '(0|[1-9][0-9]{0,8})';
const POS = '([1-9][0-9]{0,8})';
const VERSION_RE = new RegExp(`^([1-9][0-9]{3})\\.${POS}\\.${NUM}(?:-(alpha|beta|rc)\\.${POS})?$`);

class ReleaseVersionError extends Error {}

const FORMAT_HELP = 'expected YYMM.RELEASE.PATCH or YYMM.RELEASE.PATCH-STAGE.NUMBER ' +
  '(CalVer, e.g. 2610.1.0 or 2610.1.0-beta.2; STAGE is alpha, beta or rc; no leading zeros, RELEASE and NUMBER start at 1)';

function parseVersion(text) {
  if (typeof text !== 'string') {
    throw new ReleaseVersionError(`Invalid application version: expected a string, got ${typeof text}.`);
  }
  const m = VERSION_RE.exec(text);
  const month = m ? Number(m[1].slice(2)) : 0;
  if (!m || month < 1 || month > 12) {
    throw new ReleaseVersionError(`Invalid application version ${JSON.stringify(text.slice(0, 64))}: ${FORMAT_HELP}.`);
  }
  const stage = m[4] || null;
  return {
    text,
    yymm: BigInt(m[1]),
    release: BigInt(m[2]),
    patch: BigInt(m[3]),
    stage,
    number: stage ? BigInt(m[5]) : 0n,
    prerelease: stage !== null,
    tag: `v${text}`
  };
}

/** Parse a tag such as "v2610.1.0-beta.2"; null for anything that is not one of our version tags. */
function parseTag(tag) {
  if (typeof tag !== 'string' || tag[0] !== 'v') return null;
  try { return parseVersion(tag.slice(1)); } catch { return null; }
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
const stageRank = (v) => (v.stage ? STAGES.indexOf(v.stage) : STAGES.length);

/** Negative if a < b, 0 if equal, positive if a > b (parsed versions). */
function compareVersions(a, b) {
  return cmp(a.yymm, b.yymm) || cmp(a.release, b.release) || cmp(a.patch, b.patch) ||
    cmp(stageRank(a), stageRank(b)) || cmp(a.number, b.number);
}

/** Highest parsed version among tags that are version tags; unrelated tags are ignored. null if none. */
function highestVersionTag(tags) {
  let best = null;
  for (const t of tags) {
    const v = parseTag(t);
    if (v && (!best || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

/**
 * Decide whether the candidate version should be published.
 * Throws ReleaseVersionError if the candidate is malformed.
 */
function decide(candidateText, existingTags) {
  const candidate = parseVersion(candidateText);
  const tags = Array.from(existingTags);
  const baseline = highestVersionTag(tags);
  const base = {
    version: candidate.text,
    tag: candidate.tag,
    stage: candidate.stage || 'stable',
    prerelease: candidate.prerelease,
    baseline: baseline ? baseline.tag : ''
  };
  if (tags.includes(candidate.tag)) {
    return { ...base, publish: false, reason: `tag ${candidate.tag} already exists` };
  }
  if (baseline && compareVersions(candidate, baseline) <= 0) {
    return {
      ...base, publish: false,
      reason: `version ${candidate.text} is not higher than the highest existing version tag ${baseline.tag}`
    };
  }
  return {
    ...base, publish: true,
    reason: baseline
      ? `version ${candidate.text} is higher than the highest existing version tag ${baseline.tag}`
      : `no existing version tags; ${candidate.text} is the first release`
  };
}

module.exports = { ReleaseVersionError, STAGES, parseVersion, parseTag, compareVersions, highestVersionTag, decide };
