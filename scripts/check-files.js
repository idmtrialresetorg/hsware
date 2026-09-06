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
      catch (e) {
        console.error(`Syntax-like parse failure: ${p}\n${e.message}`);
        failed = true;
      }
    }
  }
}

function resolveLocal(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  return [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]
    .some(candidate => fs.existsSync(candidate));
}

function checkLocalImports(file) {
  const source = fs.readFileSync(file, 'utf8');
  const patterns = [
    /require\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /from\s+['"](\.[^'"]+)['"]/g,
    /import\(\s*['"](\.[^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      if (!resolveLocal(file, match[1])) {
        console.error(`Missing local import: ${file} -> ${match[1]}`);
        failed = true;
      }
    }
  }
}

for (const root of roots) if (fs.existsSync(root)) walk(root);
for (const root of ['src']) {
  if (!fs.existsSync(root)) continue;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith('.js')) checkLocalImports(p);
    }
  }
}
for (const file of ['server.js', 'run-server.mjs']) if (fs.existsSync(file)) checkLocalImports(file);

if (failed) process.exit(1);
console.log('JS syntax and local module checks passed.');
