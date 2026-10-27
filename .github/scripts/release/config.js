'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'release-config.json');

/** Load and strictly validate release config; values end up in workflow matrices and shell env. */
function loadConfig(file = CONFIG_PATH) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof cfg.nodeVersion !== 'string' || !/^[0-9]+(\.[0-9x]+){0,2}$/.test(cfg.nodeVersion)) {
    throw new Error(`release-config: invalid nodeVersion ${JSON.stringify(cfg.nodeVersion)}`);
  }
  if (!Array.isArray(cfg.packageTypes) || cfg.packageTypes.length === 0) {
    throw new Error('release-config: packageTypes must be a non-empty list');
  }
  const seen = new Set();
  for (const p of cfg.packageTypes) {
    if (!p || typeof p.type !== 'string' || !/^[a-z0-9]+$/.test(p.type)) {
      throw new Error(`release-config: invalid package type ${JSON.stringify(p && p.type)}`);
    }
    if (seen.has(p.type)) throw new Error(`release-config: duplicate package type ${p.type}`);
    seen.add(p.type);
    if (typeof p.runner !== 'string' || !/^[A-Za-z0-9._-]+$/.test(p.runner)) {
      throw new Error(`release-config: invalid runner for ${p.type}`);
    }
    if (p.verify !== undefined && p.verify !== 'deb') throw new Error(`release-config: invalid verify for ${p.type}`);
    if (!Array.isArray(p.extensions) || p.extensions.length === 0 ||
        !p.extensions.every((e) => typeof e === 'string' && /^\.[A-Za-z0-9]+$/.test(e))) {
      throw new Error(`release-config: invalid extensions for ${p.type}`);
    }
  }
  return cfg;
}

module.exports = { loadConfig, CONFIG_PATH };
