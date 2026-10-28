'use strict';
/*
 * Select the prerelease GitHub releases that the weekly prune workflow (prerelease.prune.yml) deletes.
 *
 * Input (stdin): one JSON object per line, each with { tag_name, prerelease, draft } - the releases of the
 * repository. Output (stdout): the tags to delete, one per line. A report goes to stderr.
 *
 * Rules:
 *  - Only published releases flagged as prerelease whose tag is exactly v<canonical version with a stage>
 *    are considered. Stable releases, drafts and anything else are never selected.
 *  - Each channel (stage) is handled on its own. The latest release of a channel (highest version) is always
 *    kept, plus the number of older releases listed in KEEP (the latest is not counted in that number).
 */
const fs = require('fs');
const { parseTag, compareVersions } = require('./version');

const KEEP = { rc: 1, beta: 3, alpha: 2 };   // releases kept in addition to the latest of the channel

function selectPrunable(releases) {
  const byStage = new Map(Object.keys(KEEP).map((s) => [s, []]));
  for (const r of releases) {
    if (!r || r.draft || r.prerelease !== true) continue;          // stable releases and drafts are never touched
    const v = parseTag(r.tag_name);
    if (!v || !v.stage || !byStage.has(v.stage)) continue;         // unknown tags are never touched
    byStage.get(v.stage).push(v);
  }
  const prune = [];
  const report = [];
  for (const [stage, list] of byStage) {
    list.sort((a, b) => compareVersions(b, a));                    // newest first
    const keep = list.slice(0, 1 + KEEP[stage]);
    const drop = list.slice(1 + KEEP[stage]);
    report.push(`${stage}: keep ${keep.map((v) => v.tag).join(', ') || '-'}; delete ${drop.map((v) => v.tag).join(', ') || '-'}`);
    prune.push(...drop.map((v) => v.tag));
  }
  return { prune, report };
}

if (require.main === module) {
  try {
    const releases = fs.readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => JSON.parse(s));
    const { prune, report } = selectPrunable(releases);
    console.error(report.join('\n'));
    if (prune.length) console.log(prune.join('\n'));
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}

module.exports = { selectPrunable, KEEP };
