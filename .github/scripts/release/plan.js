'use strict';
/*
 * Release planning step. Runs in the release workflow against the exact commit that passed checks.
 *
 *   RELEASE_SHA   full 40-hex commit SHA that passed the checks (required)
 *   GITHUB_OUTPUT step-output file (optional; outputs are always echoed to stdout as well)
 *
 * Reads package.json AT that commit, compares the version with the highest existing version tag
 * (not with the parent commit) and writes outputs: should_publish, reason, version, tag, prerelease,
 * sha, node_version, matrix. A malformed version exits non-zero with a clear message.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const { decide, ReleaseVersionError } = require('./version');
const { loadConfig } = require('./config');

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function plan({ sha, config = loadConfig(), requireOnMaster = true }) {
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error(`RELEASE_SHA must be a full 40-character commit SHA, got ${JSON.stringify(sha)}`);
  git(['cat-file', '-e', `${sha}^{commit}`]);

  const out = { sha, node_version: config.nodeVersion };
  const matrix = { include: config.packageTypes.map((p) => ({ type: p.type, runner: p.runner })) };
  out.matrix = JSON.stringify(matrix);

  if (requireOnMaster) {
    let onMaster = true;
    try { git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/master']); } catch (e) {
      if (e.status === 1) onMaster = false; else throw e;
    }
    if (!onMaster) {
      return { ...out, should_publish: 'false', version: '', tag: '', prerelease: 'false',
        reason: `commit ${sha} is not on master (e.g. master was force-pushed); nothing to publish` };
    }
  }

  const pkg = JSON.parse(git(['show', `${sha}:package.json`]));
  const tags = git(['tag', '--list', 'v*']).split('\n').filter(Boolean);
  const d = decide(pkg.version, tags);
  return { ...out, should_publish: String(d.publish), reason: d.reason, version: d.version, tag: d.tag,
    prerelease: String(d.prerelease), baseline: d.baseline };
}

function writeOutputs(o, file = process.env.GITHUB_OUTPUT) {
  const lines = Object.entries(o).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, ' ')}`);
  console.log(lines.join('\n'));
  if (file) fs.appendFileSync(file, lines.join('\n') + '\n');
}

if (require.main === module) {
  try {
    writeOutputs(plan({ sha: process.env.RELEASE_SHA }));
  } catch (e) {
    console.error(`::error::${e instanceof ReleaseVersionError ? e.message : (e.stack || e.message)}`.replace(/\n/g, ' | '));
    process.exit(1);
  }
}

module.exports = { plan, writeOutputs };
