const fs = require('fs');
const path = require('path');

function clean(value) {
  const text = String(value || '').trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : '';
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function readPackageVersion(file) {
  try { return clean(JSON.parse(fs.readFileSync(file, 'utf8')).version); } catch { return ''; }
}

const roots = [...new Set([process.cwd(), path.resolve(__dirname, '..')])];
let versionFile = '';
let packageVersion = '';
for (const base of roots) {
  if (!versionFile) versionFile = clean(readText(path.join(base, 'VERSION')));
  if (!packageVersion) packageVersion = readPackageVersion(path.join(base, 'package.json'));
}
const APP_VERSION = versionFile || packageVersion || 'unknown';
const VERSION_CONSISTENT = Boolean(versionFile && packageVersion && versionFile === packageVersion);

function versionState() {
  return { appVersion: APP_VERSION, versionFile: versionFile || null, packageVersion: packageVersion || null, consistent: VERSION_CONSISTENT };
}

module.exports = { APP_VERSION, VERSION_CONSISTENT, versionState };
