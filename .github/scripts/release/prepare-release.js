'use strict';
/*
 * Verify the downloaded build artifacts and write the GitHub release notes.
 *
 *   VERSION, TAG, PRERELEASE ('true'|'false'), SHA, REPOSITORY (owner/repo)
 *   UPLOAD_DIR (default release-upload)   NOTES_FILE (default release-notes.md)
 *   ASSETS_JSON (optional) output of `gh release view --json assets`; when set, download links use the
 *   asset names GitHub actually stored (it rewrites ~ to . in asset names; the asset label keeps the ~ name)
 *
 * Every configured package type must have at least one file in UPLOAD_DIR, and every file must belong
 * to a configured type. Prints the release title on stdout as "title=..." to stdout/GITHUB_OUTPUT.
 */
const fs = require('fs');
const path = require('path');
const { parseVersion } = require('./version');
const { loadConfig } = require('./config');
const { derive } = require('./platform-versions');

/** GitHub rewrites characters outside [A-Za-z0-9._-] (notably ~) to '.' in release asset names. */
const githubAssetName = (file) => file.replace(/[^A-Za-z0-9._-]/g, '.');

function prepare({ version, tag, sha, repository, uploadDir, assets, config = loadConfig() }) {
  const v = parseVersion(version);
  if (tag !== v.tag) throw new Error(`Tag ${tag} does not match version ${version}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('SHA must be 40 hex characters');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository name');

  const files = fs.readdirSync(uploadDir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort();
  const byType = new Map();
  for (const f of files) {
    const t = config.packageTypes.find((p) => p.extensions.some((x) => f.endsWith(x)));
    if (!t) throw new Error(`Unexpected file in upload directory: ${f}`);
    if (!/^[A-Za-z0-9._~-]+$/.test(f)) throw new Error(`Unsafe file name: ${f}`);
    if (!byType.has(t.type)) byType.set(t.type, []);
    byType.get(t.type).push(f);
  }
  for (const p of config.packageTypes) {
    if (!byType.has(p.type)) throw new Error(`Missing package for type ${p.type} in ${uploadDir}`);
  }

  const base = `https://github.com/${repository}`;
  const title = `Cloudlog Desktop ${v.text}`;
  const d = derive(v.text);
  const notes = [
    `# ${title}`,
    '',
    v.stage
      ? `**This is a ${v.stage} pre-release.** It is not the latest stable release.`
      : `Stable release.`,
    '',
    `- Version: \`${v.text}\``,
    `- Tag: \`${tag}\``,
    `- Debian package version: \`${d.debVersion}\``,
    `- Source commit: [\`${sha}\`](${base}/commit/${sha})`,
    '',
    '## Downloads',
    '',
    // Link text is the canonical file name (may contain ~); the URL uses the name GitHub actually stored:
    // from the uploaded assets when known (matched by label), else the predicted sanitized name.
    ...files.map((f) => {
      const a = assets && assets.find((x) => x.label === f || x.name === f);
      if (assets && !a) throw new Error(`Uploaded assets do not include ${f}`);
      return `- [\`${f}\`](${base}/releases/download/${tag}/${a ? a.name : githubAssetName(f)})`;
    }),
    `- [Source code (tar.gz)](${base}/archive/refs/tags/${tag}.tar.gz)`,
    ''
  ].join('\n');
  return { title, notes, files };
}

if (require.main === module) {
  try {
    const env = process.env;
    const uploadDir = path.resolve(env.UPLOAD_DIR || 'release-upload');
    const assets = env.ASSETS_JSON ? JSON.parse(fs.readFileSync(env.ASSETS_JSON, 'utf8')).assets : undefined;
    const r = prepare({ version: env.VERSION, tag: env.TAG, sha: env.SHA, repository: env.REPOSITORY, uploadDir, assets });
    fs.writeFileSync(env.NOTES_FILE || 'release-notes.md', r.notes);
    console.log(`Release title: ${r.title}\nFiles:\n${r.files.join('\n')}`);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `title=${r.title}\n`);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}

module.exports = { prepare, githubAssetName };
