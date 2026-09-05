const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

function copyDir(name) {
  const from = path.join(root, name);
  const to = path.join(dist, name);
  if (!fs.existsSync(from)) return;
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

if (!fs.existsSync(path.join(dist, 'server', 'entry.mjs'))) {
  throw new Error('Astro server entry was not generated at dist/server/entry.mjs');
}

for (const dir of ['src', 'views', 'data']) copyDir(dir);
fs.copyFileSync(path.join(root, 'run-server.mjs'), path.join(dist, 'run-server.mjs'));
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
console.log('[HSWare] Hostinger runtime prepared in dist/. Entry file: run-server.mjs');
