const { getPool } = require('../db');

const MAX_TITLE = 160;
const MAX_MESSAGE = 700;
const MAX_TYPE = 40;
const MAX_DEDUPE = 190;
const RETENTION_PER_USER = 500;

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

function notificationJson(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    actorUserId: row.actor_user_id == null ? null : Number(row.actor_user_id),
    actorName: row.actor_name || null,
    actorRole: row.actor_role || null,
    type: row.type || 'info',
    title: row.title || 'HSWare notification',
    message: row.message || '',
    softwareId: row.software_id == null ? null : Number(row.software_id),
    softwareName: row.software_name || null,
    targetUserId: row.target_user_id == null ? null : Number(row.target_user_id),
    isRead: Boolean(row.is_read),
    createdAt: row.created_at || null,
    readAt: row.read_at || null
  };
}

async function pruneUser(userId, db = getPool()) {
  await db.query(
    `DELETE FROM notifications
     WHERE user_id=? AND id NOT IN (
       SELECT id FROM (
         SELECT id FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ${RETENTION_PER_USER}
       ) keep_rows
     )`,
    [Number(userId), Number(userId)]
  );
}

async function notifyUser(userId, payload = {}) {
  const uid = Number(userId);
  if (!uid) return null;
  const db = getPool();
  const type = clean(payload.type || 'info', MAX_TYPE) || 'info';
  const title = clean(payload.title || 'HSWare notification', MAX_TITLE) || 'HSWare notification';
  const message = clean(payload.message || '', MAX_MESSAGE);
  const actorUserId = payload.actorUserId ? Number(payload.actorUserId) : null;
  const softwareId = payload.softwareId ? Number(payload.softwareId) : null;
  const targetUserId = payload.targetUserId ? Number(payload.targetUserId) : null;
  const dedupeKey = payload.dedupeKey ? clean(payload.dedupeKey, MAX_DEDUPE) : null;
  try {
    const [result] = await db.query(
      `INSERT INTO notifications (user_id,actor_user_id,type,title,message,software_id,target_user_id,dedupe_key)
       VALUES (?,?,?,?,?,?,?,?)`,
      [uid, actorUserId, type, title, message, softwareId, targetUserId, dedupeKey]
    );
    await pruneUser(uid, db);
    return Number(result.insertId);
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY' && dedupeKey) return null;
    // Notifications must never roll back or falsely fail the primary HSWare
    // action (publish/import/update/account work) that already succeeded.
    console.error('[HSWare] Notification create failed:', err?.message || err);
    return null;
  }
}

async function activeAdminIds(db = getPool()) {
  const [rows] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY id");
  return rows.map(row => Number(row.id)).filter(Boolean);
}

async function activeUserIds(db = getPool()) {
  const [rows] = await db.query("SELECT id FROM users WHERE is_active=1 ORDER BY id");
  return rows.map(row => Number(row.id)).filter(Boolean);
}

async function notifyAdmins(payload = {}, { exceptUserId = null } = {}) {
  const ids = await activeAdminIds();
  const out = [];
  for (const id of ids) {
    if (exceptUserId && Number(exceptUserId) === id) continue;
    out.push(await notifyUser(id, payload));
  }
  return out.filter(Boolean);
}

async function notifyAllActive(payload = {}, { exceptUserId = null } = {}) {
  const ids = await activeUserIds();
  const out = [];
  for (const id of ids) {
    if (exceptUserId && Number(exceptUserId) === id) continue;
    out.push(await notifyUser(id, payload));
  }
  return out.filter(Boolean);
}

async function summary(userId) {
  const db = getPool();
  const [[row]] = await db.query(
    `SELECT SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) AS unread_count,MAX(id) AS latest_id,
      MAX(CASE WHEN is_read=0 THEN id ELSE NULL END) AS latest_unread_id
     FROM notifications WHERE user_id=?`,
    [Number(userId)]
  );
  return {
    unreadCount: Number(row?.unread_count || 0),
    latestId: Number(row?.latest_id || 0),
    latestUnreadId: Number(row?.latest_unread_id || 0)
  };
}

async function list(userId, { limit = 30, unreadOnly = false } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit || 30) || 30)));
  const params = [Number(userId)];
  let where = 'n.user_id=?';
  if (unreadOnly) where += ' AND n.is_read=0';
  const [rows] = await getPool().query(
    `SELECT n.*,a.name AS actor_name,a.role AS actor_role,s.name AS software_name
     FROM notifications n
     LEFT JOIN users a ON a.id=n.actor_user_id
     LEFT JOIN software s ON s.id=n.software_id
     WHERE ${where}
     ORDER BY n.created_at DESC,n.id DESC LIMIT ${safeLimit}`,
    params
  );
  return rows.map(notificationJson);
}

async function getById(userId, id) {
  const [[row]] = await getPool().query(
    `SELECT n.*,a.name AS actor_name,a.role AS actor_role,s.name AS software_name
     FROM notifications n
     LEFT JOIN users a ON a.id=n.actor_user_id
     LEFT JOIN software s ON s.id=n.software_id
     WHERE n.user_id=? AND n.id=? LIMIT 1`,
    [Number(userId), Number(id)]
  );
  return notificationJson(row);
}

async function markRead(userId, ids = []) {
  const cleanIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean))].slice(0, 100);
  if (!cleanIds.length) return 0;
  const [result] = await getPool().query(
    `UPDATE notifications SET is_read=1,read_at=COALESCE(read_at,NOW())
     WHERE user_id=? AND id IN (${cleanIds.map(() => '?').join(',')})`,
    [Number(userId), ...cleanIds]
  );
  return Number(result.affectedRows || 0);
}

async function markAllRead(userId) {
  const [result] = await getPool().query(
    'UPDATE notifications SET is_read=1,read_at=COALESCE(read_at,NOW()) WHERE user_id=? AND is_read=0',
    [Number(userId)]
  );
  return Number(result.affectedRows || 0);
}

module.exports = {
  notificationJson,
  notifyUser,
  notifyAdmins,
  notifyAllActive,
  summary,
  list,
  getById,
  markRead,
  markAllRead
};
