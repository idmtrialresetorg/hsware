const fs = require('fs');
const path = require('path');
const roots = ['src', 'public/js', 'public/ui'];
let failed = false;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js')) {
      try { new Function(fs.readFileSync(p, 'utf8')); }
      catch (e) { console.error(`Syntax-like parse failure: ${p}\n${e.message}`); failed = true; }
    }
  }
}
for (const root of roots) if (fs.existsSync(root)) walk(root);
if (failed) process.exit(1);
console.log('JS file checks passed.');
