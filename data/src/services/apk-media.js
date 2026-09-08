const { safeFetch } = require('./remote');

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_SCREENSHOTS = 24;
const MAX_PACK_BYTES = 96 * 1024 * 1024;

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanName(value, fallback = 'android-app') {
  const out = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-z0-9._ -]+/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 96);
  return out || fallback;
}

function uniqueUrls(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const raw = String(value || '').trim();
    if (!/^https?:\/\//i.test(raw)) continue;
    try {
      const url = new URL(raw).toString();
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    } catch {}
  }
  return out;
}

function mediaFromApp(row) {
  const meta = parseObject(row?.source_metadata_json);
  return {
    iconUrl: uniqueUrls([meta.iconUrl])[0] || null,
    coverImageUrl: uniqueUrls([meta.coverImageUrl])[0] || null,
    screenshots: uniqueUrls(Array.isArray(meta.screenshots) ? meta.screenshots : []).slice(0, MAX_SCREENSHOTS),
    playStoreUrl: uniqueUrls([meta.playStoreUrl])[0] || null,
    directDownloadUrl: uniqueUrls([meta.directDownloadUrl])[0] || null,
    apkType: String(meta.apkType || meta.modInfo || '').trim() || null
  };
}

function imageType(buffer, headerType = '') {
  const b = buffer || Buffer.alloc(0);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return { mime:'image/png', ext:'png' };
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { mime:'image/jpeg', ext:'jpg' };
  if (b.length >= 12 && b.subarray(0,4).toString('ascii') === 'RIFF' && b.subarray(8,12).toString('ascii') === 'WEBP') return { mime:'image/webp', ext:'webp' };
  if (b.length >= 6 && ['GIF87a','GIF89a'].includes(b.subarray(0,6).toString('ascii'))) return { mime:'image/gif', ext:'gif' };
  if (b.length >= 12 && b.subarray(4,12).toString('ascii').includes('ftypavif')) return { mime:'image/avif', ext:'avif' };
  throw new Error('Remote asset did not return a supported image.');
}

async function fetchImage(url) {
  const result = await safeFetch(url, {
    maxBytes: MAX_IMAGE_BYTES,
    accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.2'
  });
  const type = imageType(result.buffer, result.headers.get('content-type'));
  return { ...result, ...type };
}

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}
function crc32(buffer) {
  const table = getCrcTable();
  let c = 0xFFFFFFFF;
  for (const byte of buffer) c = table[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31);
  const day = ((year - 1980) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, date: day };
}
function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name || 'file.bin').replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(stamp.time, 12);
    cd.writeUInt16LE(stamp.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += header.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuffer, end]);
}

async function iconDownload(row) {
  const media = mediaFromApp(row);
  if (!media.iconUrl) throw Object.assign(new Error('No APK icon is available from the current source metadata.'), { status: 404 });
  const image = await fetchImage(media.iconUrl);
  return {
    buffer: image.buffer,
    mime: image.mime,
    filename: `${cleanName(row.name)}-icon.${image.ext}`
  };
}

async function coverDownload(row) {
  const media = mediaFromApp(row);
  if (!media.coverImageUrl) throw Object.assign(new Error('No APK cover image is available from the current source metadata.'), { status: 404 });
  const image = await fetchImage(media.coverImageUrl);
  return { buffer:image.buffer, mime:image.mime, filename:`${cleanName(row.name)}-cover.${image.ext}` };
}

async function screenshotDownload(row, index) {
  const media = mediaFromApp(row);
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n >= media.screenshots.length) throw Object.assign(new Error('Screenshot not found.'), { status: 404 });
  const image = await fetchImage(media.screenshots[n]);
  return {
    buffer: image.buffer,
    mime: image.mime,
    filename: `${cleanName(row.name)}-screenshot-${String(n + 1).padStart(2, '0')}.${image.ext}`
  };
}

async function mediaPack(row) {
  const media = mediaFromApp(row);
  const targets = [];
  if (media.iconUrl) targets.push({ kind:'icon', index:0, url:media.iconUrl });
  if (media.coverImageUrl) targets.push({ kind:'cover', index:0, url:media.coverImageUrl });
  media.screenshots.forEach((url, index) => targets.push({ kind:'screenshot', index, url }));
  if (!targets.length) throw Object.assign(new Error('No icon or screenshots are available for this APK.'), { status: 404 });

  const entries = [];
  let total = 0;
  for (const target of targets) {
    try {
      const image = await fetchImage(target.url);
      if (total + image.buffer.length > MAX_PACK_BYTES) break;
      total += image.buffer.length;
      const name = target.kind === 'icon'
        ? `icon.${image.ext}`
        : target.kind === 'cover' ? `cover.${image.ext}` : `screenshots/screenshot-${String(target.index + 1).padStart(2, '0')}.${image.ext}`;
      entries.push({ name, data:image.buffer });
    } catch (err) {
      // A broken source image should not make the entire pack unusable if other
      // verified images are still available.
    }
  }
  if (!entries.length) throw Object.assign(new Error('The APK media links were present, but no valid images could be downloaded.'), { status: 502 });
  const zip = makeZip(entries);
  return {
    buffer: zip,
    filename: `${cleanName(row.name)}-media.zip`,
    itemCount: entries.length
  };
}

module.exports = {
  mediaFromApp,
  iconDownload,
  coverDownload,
  screenshotDownload,
  mediaPack,
  fetchImage,
  makeZip
};
