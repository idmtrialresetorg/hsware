const crypto = require('crypto');
const { getPool } = require('../db');
const { rawText } = require('./github');

function pathHash(sourcePath) {
  return crypto.createHash('sha256').update(String(sourcePath || '')).digest('hex');
}

async function cachedManifestText(sourcePath, options = {}) {
  if (!sourcePath) throw new Error('WinGet manifest path is missing.');
  const db = getPool();
  const maxAgeHours = Math.max(1, Number(options.maxAgeHours || 24 * 30));
  const force = Boolean(options.force);
  const hash = pathHash(sourcePath);
  if (!force) {
    try {
      const [[row]] = await db.query(
        'SELECT manifest_text,fetched_at FROM winget_manifest_cache WHERE path_hash=? LIMIT 1',
        [hash]
      );
      if (row?.manifest_text && row.fetched_at) {
        const age = Date.now() - new Date(row.fetched_at).getTime();
        if (Number.isFinite(age) && age >= 0 && age < maxAgeHours * 60 * 60 * 1000) return row.manifest_text;
      }
    } catch {
      // During first boot the cache table may not exist until schema v8 finishes.
    }
  }

  try {
    const text = await rawText(sourcePath);
    try {
      await db.query(
        `INSERT INTO winget_manifest_cache (path_hash,source_path,manifest_text,fetched_at,last_error)
         VALUES (?,?,?,NOW(),NULL)
         ON DUPLICATE KEY UPDATE source_path=VALUES(source_path),manifest_text=VALUES(manifest_text),fetched_at=NOW(),last_error=NULL`,
        [hash, sourcePath, text]
      );
    } catch {}
    return text;
  } catch (err) {
    try {
      await db.query(
        `INSERT INTO winget_manifest_cache (path_hash,source_path,manifest_text,fetched_at,last_error)
         VALUES (?,?,NULL,NULL,?)
         ON DUPLICATE KEY UPDATE source_path=VALUES(source_path),last_error=VALUES(last_error)`,
        [hash, sourcePath, String(err.message || err).slice(0, 1000)]
      );
    } catch {}
    throw err;
  }
}

module.exports = { cachedManifestText };
