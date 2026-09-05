const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return true;
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb');
  }
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

async function validatePublicUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP/HTTPS URLs are allowed.');
  if (url.username || url.password) throw new Error('Credentials in URLs are not allowed.');
  if (url.port && !['80','443'].includes(url.port)) throw new Error('Non-standard ports are not allowed.');
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) throw new Error('Private/local network targets are not allowed.');
  return url;
}

async function safeFetch(input, { maxBytes = 4 * 1024 * 1024, accept = '*/*', redirects = 4 } = {}) {
  let current = await validatePublicUrl(input);
  for (let i = 0; i <= redirects; i++) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HSWareStudio/4.6.0; +https://example.invalid)',
        'Accept': accept,
        'Accept-Language': 'en-US,en;q=0.8'
      },
      signal: AbortSignal.timeout(15000)
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc) throw new Error('Redirect without a location header.');
      current = await validatePublicUrl(new URL(loc, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Remote server returned ${response.status}.`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength && contentLength > maxBytes) throw new Error('Remote response is larger than the allowed limit.');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { try { reader.cancel(); } catch {} throw new Error('Remote response exceeded the allowed limit.'); }
      chunks.push(Buffer.from(value));
    }
    return {
      url: current.toString(),
      status: response.status,
      headers: response.headers,
      buffer: Buffer.concat(chunks)
    };
  }
  throw new Error('Too many redirects.');
}

async function safeFetchText(input, maxBytes = 2 * 1024 * 1024) {
  const result = await safeFetch(input, { maxBytes, accept: 'text/html,application/xhtml+xml' });
  const type = result.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error('URL did not return HTML.');
  return { ...result, text: result.buffer.toString('utf8') };
}

module.exports = { validatePublicUrl, safeFetch, safeFetchText };

async function probeRemoteFileSize(input, redirects = 4) {
  let current = await validatePublicUrl(input);
  for (let i = 0; i <= redirects; i++) {
    const response = await fetch(current, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HSWareStudio/4.6.0)', 'Accept': '*/*' },
      signal: AbortSignal.timeout(10000)
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc) return null;
      current = await validatePublicUrl(new URL(loc, current).toString());
      continue;
    }
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') || 0);
    return Number.isFinite(length) && length > 0 ? length : null;
  }
  return null;
}

module.exports.probeRemoteFileSize = probeRemoteFileSize;
