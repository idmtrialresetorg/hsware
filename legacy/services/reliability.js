const config = require('../config');
const { getPool } = require('../db');
const diagnostics = require('./diagnostics');

const cache = new Map();
const HEARTBEAT_WRITE_MS = 15000;
const EXPECTED_WORKERS = ['imports','enrichment','catalog','backups','updates'];

async function load(name) {
  if (cache.has(name)) return cache.get(name);
  const db = getPool();
  await db.query(`INSERT IGNORE INTO worker_health (worker_name,instance_id,status,last_heartbeat_at)
    VALUES (?,?,'starting',NOW())`, [name, config.appInstanceId]);
  const [[row]] = await db.query('SELECT * FROM worker_health WHERE worker_name=? LIMIT 1', [name]);
  const item = { nextRetryAt: row?.next_retry_at ? new Date(row.next_retry_at).getTime() : 0, failures:Number(row?.consecutive_failures||0), lastWrite:0 };
  cache.set(name, item); return item;
}
function delayFor(failures, baseDelayMs, maxDelayMs) {
  const raw = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, failures - 1)));
  return Math.round(raw * (0.85 + Math.random() * 0.3));
}
async function writeHeartbeat(name, status, extra = {}) {
  const c = await load(name); const now = Date.now();
  if (!extra.force && now - c.lastWrite < HEARTBEAT_WRITE_MS) return;
  c.lastWrite = now;
  await getPool().query(`UPDATE worker_health SET instance_id=?,status=?,last_heartbeat_at=NOW(),details_json=? WHERE worker_name=?`,
    [config.appInstanceId,status,JSON.stringify(extra.details||{}),name]);
}
async function runWorkerTick(name, fn, { baseDelayMs=5000, maxDelayMs=15*60*1000 } = {}) {
  const c = await load(name); const now = Date.now();
  if (c.nextRetryAt && now < c.nextRetryAt) {
    await writeHeartbeat(name,'retry_wait',{details:{nextRetryAt:new Date(c.nextRetryAt).toISOString()}});
    return { ok:false, skipped:true, retryAt:new Date(c.nextRetryAt) };
  }
  await writeHeartbeat(name,'running',{force:c.failures>0});
  try {
    const value = await fn();
    const hadFailures = c.failures > 0;
    c.failures = 0; c.nextRetryAt = 0;
    if (hadFailures || Date.now() - c.lastWrite >= HEARTBEAT_WRITE_MS) {
      await getPool().query(`UPDATE worker_health SET instance_id=?,status='healthy',last_heartbeat_at=NOW(),last_success_at=NOW(),consecutive_failures=0,next_retry_at=NULL,last_error=NULL,last_diagnostic_id=NULL WHERE worker_name=?`, [config.appInstanceId,name]);
      c.lastWrite = Date.now();
    }
    return { ok:true, value };
  } catch (error) {
    c.failures += 1;
    const delay = delayFor(c.failures,baseDelayMs,maxDelayMs);
    c.nextRetryAt = Date.now()+delay;
    const id = diagnostics.logError(error,{area:'worker',worker:name,attempt:c.failures});
    await getPool().query(`UPDATE worker_health SET instance_id=?,status='degraded',last_heartbeat_at=NOW(),consecutive_failures=?,next_retry_at=?,last_error=?,last_diagnostic_id=? WHERE worker_name=?`,
      [config.appInstanceId,c.failures,new Date(c.nextRetryAt),String(error?.message||error).slice(0,1800),id,name]);
    return { ok:false,error,diagnosticId:id,retryAt:new Date(c.nextRetryAt) };
  }
}
async function listWorkerHealth() {
  const [rows] = await getPool().query(`SELECT worker_name,instance_id,status,last_heartbeat_at,last_success_at,consecutive_failures,next_retry_at,last_error,last_diagnostic_id
    FROM worker_health ORDER BY worker_name`);
  const by = new Map(rows.map(r=>[r.worker_name,r]));
  return EXPECTED_WORKERS.map(name=>{
    const r=by.get(name); const age=r?.last_heartbeat_at ? Date.now()-new Date(r.last_heartbeat_at).getTime() : Infinity;
    const stale=!Number.isFinite(age)||age>120000;
    return { name,status:!r?'missing':stale?'stale':r.status,healthy:Boolean(r&&!stale&&['healthy','running','retry_wait','starting'].includes(r.status)),lastHeartbeatAt:r?.last_heartbeat_at||null,lastSuccessAt:r?.last_success_at||null,consecutiveFailures:Number(r?.consecutive_failures||0),nextRetryAt:r?.next_retry_at||null,lastError:r?.last_error||null,diagnosticId:r?.last_diagnostic_id||null };
  });
}
async function summary() {
  const workers=await listWorkerHealth(); const unhealthy=workers.filter(w=>!w.healthy);
  return { ok:unhealthy.length===0,workers,unhealthy };
}
module.exports={ EXPECTED_WORKERS, runWorkerTick, listWorkerHealth, summary };
