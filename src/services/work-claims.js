const crypto = require('crypto');
const { getPool } = require('../db');
const activity = require('./activity');

const LOCK_TIMEOUT_SECONDS = Math.max(60, Math.min(300, Number(process.env.WORK_LOCK_TIMEOUT_SECONDS || 90) || 90));

function claimJson(row) {
  if (!row) return null;
  return {
    softwareId: Number(row.software_id),
    userId: Number(row.user_id),
    name: row.user_name || row.name || 'User',
    role: row.user_role || row.role || 'partner',
    roleLabel: String(row.user_role || row.role || '').toLowerCase() === 'admin' ? 'Admin' : 'Partner',
    claimedAt: row.claimed_at || null,
    lastHeartbeatAt: row.last_heartbeat_at || null
  };
}

async function pruneStaleClaims(db = getPool(), softwareId = null) {
  const sql = softwareId == null
    ? `DELETE FROM software_work_claims WHERE last_heartbeat_at < DATE_SUB(NOW(), INTERVAL ${LOCK_TIMEOUT_SECONDS} SECOND)`
    : `DELETE FROM software_work_claims WHERE software_id=? AND last_heartbeat_at < DATE_SUB(NOW(), INTERVAL ${LOCK_TIMEOUT_SECONDS} SECOND)`;
  const params = softwareId == null ? [] : [Number(softwareId)];
  const [result] = await db.query(sql, params);
  return Number(result.affectedRows || 0);
}

async function getClaim(softwareId, db = getPool()) {
  await pruneStaleClaims(db, softwareId);
  const [[row]] = await db.query(`SELECT c.software_id,c.user_id,c.claimed_at,c.last_heartbeat_at,u.name AS user_name,u.role AS user_role
    FROM software_work_claims c JOIN users u ON u.id=c.user_id WHERE c.software_id=? LIMIT 1`, [Number(softwareId)]);
  return claimJson(row);
}

async function listActiveClaims() {
  const db = getPool();
  await pruneStaleClaims(db);
  const [rows] = await db.query(`SELECT c.software_id,c.user_id,c.claimed_at,c.last_heartbeat_at,u.name AS user_name,u.role AS user_role
    FROM software_work_claims c JOIN users u ON u.id=c.user_id ORDER BY c.software_id`);
  return rows.map(claimJson);
}

async function softwareExists(softwareId, db = getPool()) {
  const [[row]] = await db.query('SELECT id FROM software WHERE id=? AND workspace_added=1 LIMIT 1', [Number(softwareId)]);
  return Boolean(row);
}

async function claimSoftware(softwareId, user) {
  const db = getPool();
  const id = Number(softwareId);
  if (!id || !(await softwareExists(id, db))) throw Object.assign(new Error('Software not found.'), { status: 404 });
  const before = await getClaim(id, db);
  if (before?.userId === Number(user.id)) {
    await db.query('UPDATE software_work_claims SET last_heartbeat_at=NOW() WHERE software_id=? AND user_id=?', [id, Number(user.id)]);
    return { ok: true, owned: true, claim: await getClaim(id, db) };
  }
  if (before) return { ok: false, owned: false, claim: before };
  const token = crypto.randomBytes(24).toString('hex');
  await db.query(`INSERT INTO software_work_claims (software_id,user_id,lock_token,claimed_at,last_heartbeat_at)
    VALUES (?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE software_id=VALUES(software_id)`, [id, Number(user.id), token]);
  const claim = await getClaim(id, db);
  if (claim?.userId === Number(user.id)) {
    await activity.record(user.id, 'software_claimed', { softwareId: id });
    return { ok: true, owned: true, claim };
  }
  return { ok: false, owned: false, claim };
}

async function heartbeat(softwareId, userId) {
  const db = getPool();
  const id = Number(softwareId);
  const uid = Number(userId);
  const [result] = await db.query(`UPDATE software_work_claims SET last_heartbeat_at=NOW()
    WHERE software_id=? AND user_id=? AND last_heartbeat_at >= DATE_SUB(NOW(), INTERVAL ${LOCK_TIMEOUT_SECONDS} SECOND)`, [id, uid]);
  if (!result.affectedRows) {
    await pruneStaleClaims(db, id);
    return { ok: false, claim: await getClaim(id, db) };
  }
  return { ok: true, claim: await getClaim(id, db) };
}

async function release(softwareId, user, { force = false } = {}) {
  const db = getPool();
  const claim = await getClaim(softwareId, db);
  if (!claim) return { released: false, claim: null };
  const own = claim.userId === Number(user.id);
  if (!own && !(force && user.role === 'admin')) throw Object.assign(new Error(`${claim.name} is currently working on this software.`), { status: 423, claim });
  await db.query('DELETE FROM software_work_claims WHERE software_id=?', [Number(softwareId)]);
  await activity.record(user.id, own ? 'software_released' : 'software_force_released', { softwareId, targetUserId: own ? null : claim.userId });
  return { released: true, claim: null };
}

async function takeover(softwareId, user) {
  if (user.role !== 'admin') throw Object.assign(new Error('Only the Admin can take over another user’s software.'), { status: 403 });
  const db = getPool();
  const id = Number(softwareId);
  if (!(await softwareExists(id, db))) throw Object.assign(new Error('Software not found.'), { status: 404 });
  const previous = await getClaim(id, db);
  const token = crypto.randomBytes(24).toString('hex');
  await db.query(`INSERT INTO software_work_claims (software_id,user_id,lock_token,claimed_at,last_heartbeat_at)
    VALUES (?,?,?,NOW(),NOW())
    ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),lock_token=VALUES(lock_token),claimed_at=NOW(),last_heartbeat_at=NOW()`, [id, Number(user.id), token]);
  await activity.record(user.id, 'software_taken_over', { softwareId: id, targetUserId: previous?.userId || null });
  return { ok: true, claim: await getClaim(id, db), previous };
}

async function ensureNotOwnedByOther(softwareId, user) {
  const claim = await getClaim(softwareId);
  if (claim && claim.userId !== Number(user.id)) {
    const err = Object.assign(new Error(`${claim.name} is currently working on this software.`), { status: 423, claim });
    throw err;
  }
  return claim;
}

async function releaseOwned(softwareId, userId) {
  await getPool().query('DELETE FROM software_work_claims WHERE software_id=? AND user_id=?', [Number(softwareId), Number(userId)]);
}

async function releaseAllOwned(userId) {
  const [result] = await getPool().query('DELETE FROM software_work_claims WHERE user_id=?', [Number(userId)]);
  return Number(result.affectedRows || 0);
}

module.exports = {
  LOCK_TIMEOUT_SECONDS,
  claimJson,
  pruneStaleClaims,
  getClaim,
  listActiveClaims,
  claimSoftware,
  heartbeat,
  release,
  takeover,
  ensureNotOwnedByOther,
  releaseOwned,
  releaseAllOwned
};
