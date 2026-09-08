function tokenize(value) {
  return String(value || '')
    .split(/[._+\-]/)
    .map(part => /^\d+$/.test(part) ? Number(part) : part.toLowerCase());
}

function compareVersions(a, b) {
  const left = tokenize(a);
  const right = tokenize(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
      continue;
    }
    const xs = String(x);
    const ys = String(y);
    if (xs !== ys) return xs.localeCompare(ys, undefined, { numeric: true, sensitivity: 'base' });
  }
  return 0;
}

module.exports = { compareVersions };
