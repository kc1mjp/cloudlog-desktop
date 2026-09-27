'use strict';
// Copies front-end assets (Bootswatch themes, Bootstrap JS, Font Awesome) into
// src/renderer/vendor so the packaged app works completely offline.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = (p) => path.join(root, 'node_modules', p);
const out = path.join(root, 'src', 'renderer', 'vendor');
fs.mkdirSync(path.join(out, 'fa', 'webfonts'), { recursive: true });
fs.mkdirSync(path.join(out, 'fa', 'css'), { recursive: true });

const themes = { cerulean: 'Cerulean (light)', darkly: 'Darkly (dark)', cyborg: 'Cyborg (dark)' };
for (const t of Object.keys(themes)) fs.copyFileSync(nm(`bootswatch/dist/${t}/bootstrap.min.css`), path.join(out, `${t}.css`));
fs.copyFileSync(nm('bootstrap/dist/js/bootstrap.bundle.min.js'), path.join(out, 'bootstrap.bundle.min.js'));
fs.copyFileSync(nm('@fortawesome/fontawesome-free/css/all.min.css'), path.join(out, 'fa', 'css', 'all.min.css'));
for (const f of ['fa-solid-900.woff2', 'fa-regular-400.woff2']) {
  fs.copyFileSync(nm(`@fortawesome/fontawesome-free/webfonts/${f}`), path.join(out, 'fa', 'webfonts', f));
}
console.log('vendor assets copied');
