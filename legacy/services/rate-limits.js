const crypto = require('crypto');
const { getPool } = require('../db');

function hashKey(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }
async function consume(key, limit = 120, windowSeconds = 300) {
  const db = getPool();
  const bucket = hashKey(key);
  const safeLimit = Math.max(1, Math.min(100000, Number(limit) || 120));
  const safeWindow = Math.max(1, Math.min(86400, Number(windowSeconds) || 300));
  await db.query(`INSERT INTO rate_limit_buckets (bucket_key,window_started_at,request_count,last_seen_at)
    VALUES (?,NOW(),1,NOW())
    ON DUPLICATE KEY UPDATE
      request_count=IF(window_started_at < DATE_SUB(NOW(), INTERVAL ? SECOND),1,request_count+1),
      window_started_at=IF(window_started_at < DATE_SUB(NOW(), INTERVAL ? SECOND),NOW(),window_started_at),
      last_seen_at=NOW()`, [bucket, safeWindow, safeWindow]);
  const [[row]] = await db.query(`SELECT request_count,
    GREATEST(0,? - TIMESTAMPDIFF(SECOND,window_started_at,NOW())) AS retry_after
    FROM rate_limit_buckets WHERE bucket_key=? LIMIT 1`, [safeWindow, bucket]);
  // Low-cost probabilistic cleanup keeps this table bounded without a cron dependency.
  if (Math.random() < 0.005) getPool().query('DELETE FROM rate_limit_buckets WHERE last_seen_at < DATE_SUB(NOW(), INTERVAL 2 DAY)').catch(()=>{});
  const count = Number(row?.request_count || 0);
  return { ok: count <= safeLimit, limit:safeLimit, remaining:Math.max(0,safeLimit-count), retryAfter:count > safeLimit ? Math.max(1,Number(row?.retry_after||1)) : 0 };
}
module.exports = { consume };
