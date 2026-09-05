function titleizePackageId(packageId) {
  const parts = String(packageId || '').split('.').filter(Boolean);
  // The first segment is normally the publisher. Use the whole product portion
  // so IDs such as Autodesk.NavisworksFreedom.2027 do not render as just "2027".
  const product = (parts.length > 1 ? parts.slice(1) : parts).join(' ') || 'Software';
  return product
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, m => m.toUpperCase());
}

function safeFilename(name, fallback = 'file') {
  const cleaned = String(name || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

module.exports = { titleizePackageId, safeFilename, hostnameOf };
