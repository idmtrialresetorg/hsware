type Bucket = { count: number; resetAt: number; lastSeen: number };
const buckets = new Map<string, Bucket>();
let calls = 0;

function cleanup(now: number) {
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  if (buckets.size <= 5000) return;
  const oldest = [...buckets.entries()].sort((a,b)=>a[1].lastSeen-b[1].lastSeen).slice(0,buckets.size-5000);
  for (const [key] of oldest) buckets.delete(key);
}

// Fast per-process burst shield. Security-sensitive API/login limits also use
// the persistent MySQL limiter so limits survive restarts and multiple workers.
export function allow(key: string, limit = 20, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  if (++calls % 200 === 0 || buckets.size > 5000) cleanup(now);
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs, lastSeen: now });
    return { ok: true, retryAfter: 0, remaining: Math.max(0, limit - 1) };
  }
  current.count += 1;
  current.lastSeen = now;
  if (current.count > limit) return { ok:false, retryAfter:Math.max(1, Math.ceil((current.resetAt-now)/1000)), remaining:0 };
  return { ok:true, retryAfter:0, remaining:Math.max(0, limit-current.count) };
}
