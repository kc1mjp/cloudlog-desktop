'use strict';
/*
 * Last-moment eligibility recheck, run in the publish job with the CURRENT remote tag list on stdin
 * (one tag name per line) and VERSION in the environment. Exits 0 and prints "publish=true|false".
 * This catches a concurrent publisher that created the same tag, or a higher version tag, since planning.
 */
const fs = require('fs');
const { decide } = require('./version');

if (require.main === module) {
  const tags = fs.readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    const d = decide(process.env.VERSION, tags);
    console.log(`${d.reason}`);
    const line = `publish=${d.publish}\nreason=${d.reason}\n`;
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
