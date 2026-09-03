const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const values = [
  ['VERSION', version],
  ['package.json', pkg.version]
];
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  values.push(['package-lock.json', lock.version]);
  values.push(['package-lock root', lock.packages?.['']?.version]);
}
const bad = values.filter(([, value]) => value !== version);
if (bad.length) {
  console.error('[HSWare] Version consistency check failed:', values);
  process.exit(1);
}
console.log(`[HSWare] Version consistency OK: v${version}${fs.existsSync(lockPath) ? ' (lockfile included)' : ' (package.json deployment install)'}`);
