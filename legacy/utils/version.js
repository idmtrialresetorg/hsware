function tokenize(v) {
  return String(v || '').split(/[._+\-]/).map(part => /^\d+$/.test(part) ? Number(part) : part.toLowerCase());
}
function compareVersions(a, b) {
  const aa = tokenize(a), bb = tokenize(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = aa[i] ?? 0, y = bb[i] ?? 0;
    if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x - y; }
    else {
      const xs = String(x), ys = String(y);
      if (xs !== ys) return xs.localeCompare(ys, undefined, { numeric: true, sensitivity: 'base' });
    }
  }
  return 0;
}
module.exports = { compareVersions };
