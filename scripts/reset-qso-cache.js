#!/usr/bin/env node
'use strict';
// Development-only maintenance script.
//
// This is deliberately NOT wired into any IPC handler or UI button - "clear
// all QSO cache" is not something the app should ever offer as a normal
// user-facing action (a user who wants that should clear one logbook at a
// time from Settings -> Logbooks, which only removes already-synced rows and
// never touches queued/unsynced QSOs). This script is a blunt instrument for
// developers: it wipes EVERY logbook's local cache, synced history included,
// with no undo.
//
// Usage:
//   npm run dev:reset-cache
//   CLOUDLOG_DESKTOP_DATA=/path/to/profile npm run dev:reset-cache

const path = require('path');
const os = require('os');
const readline = require('readline');
const { QsoCache } = require('../src/main/qso-cache');

const dir = process.env.CLOUDLOG_DESKTOP_DATA || path.join(os.homedir(), '.config', 'cloudlog-desktop');
const file = path.join(dir, 'qsocache.sqlite3');

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); });
  });
}

(async () => {
  console.log('This will permanently delete ALL local/cached QSO data (every logbook) at:');
  console.log(`  ${file}`);
  console.log('Server-side Cloudlog data is not touched. This cannot be undone.');
  const ok = await confirm('Type "yes" to continue: ');
  if (!ok) { console.log('Cancelled - nothing was changed.'); return; }
  const cache = new QsoCache(file);
  const removed = cache.devResetAll();
  cache.close();
  console.log(`Done. ${removed} row(s) removed.`);
})();
