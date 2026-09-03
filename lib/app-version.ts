import fs from 'node:fs';
import path from 'node:path';

function clean(value: unknown) {
  const text = String(value || '').trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : '';
}
function text(file: string) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function pkg(file: string) { try { return clean(JSON.parse(fs.readFileSync(file, 'utf8')).version); } catch { return ''; } }
const roots = [...new Set([process.cwd(), path.resolve(process.cwd())])];
let vf = ''; let pv = '';
for (const base of roots) {
  if (!vf) vf = clean(text(path.join(base, 'VERSION')));
  if (!pv) pv = pkg(path.join(base, 'package.json'));
}
export const APP_VERSION = vf || pv || 'unknown';
export const VERSION_CONSISTENT = Boolean(vf && pv && vf === pv);
