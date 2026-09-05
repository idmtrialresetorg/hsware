const { getPool } = require('../db');

const FEED_ACTIONS = new Set([
  'software_published',
  'software_unpublished',
  'software_manual_imported',
  'software_marked_updated',
  'auto_import_started',
  'auto_import_stopped',
  'auto_import_completed',
  'update_scan_started',
  'update_scan_completed',
  'liteapks_sync_started',
  'liteapks_sync_completed',
  'partner_created',
  'partner_updated',
  'partner_enabled',
  'partner_disabled',
  'backup_created',
  'backup_restored',
  'backup_failed',
  'software_data_reset',
  'new_software_cleared'
]);

const PARTNER_VISIBLE_ACTIONS = new Set([
  'software_published',
  'software_unpublished',
  'software_manual_imported',
  'software_marked_updated',
  'auto_import_started',
  'auto_import_stopped',
  'auto_import_completed',
  'update_scan_started',
  'update_scan_completed'
]);

const ACTION_META = {
  user_login: ['Signed in', 'account'],
  user_logout: ['Signed out', 'account'],
  software_claimed: ['Opened software', 'work'],
  software_released: ['Closed software', 'work'],
  software_force_released: ['Force released software', 'work'],
  software_taken_over: ['Took over software', 'work'],
  software_published: ['Published software', 'publish'],
  software_unpublished: ['Moved software back to New Software', 'publish'],
  software_marked_updated: ['Marked software updated', 'update'],
  software_manual_imported: ['Imported software', 'import'],
  auto_import_started: ['Started Auto Import', 'import'],
  auto_import_stopped: ['Stopped Auto Import', 'import'],
  auto_import_completed: ['Auto Import completed', 'import'],
  update_scan_started: ['Started update scan', 'update'],
  update_scan_completed: ['Update scan completed', 'update'],
  liteapks_sync_started: ['Started LiteAPKs Android sync', 'import'],
  liteapks_sync_completed: ['LiteAPKs Android sync completed', 'import'],
  new_software_cleared: ['Cleared New Software queue', 'system'],
  software_data_reset: ['Reset software data', 'system'],
  partner_created: ['Added Partner', 'team'],
  partner_updated: ['Updated Partner', 'team'],
  partner_enabled: ['Enabled Partner', 'team'],
  partner_disabled: ['Disabled Partner', 'team'],
  admin_profile_updated: ['Updated Admin profile', 'team'],
  profile_photo_updated: ['Updated profile photo', 'team'],
  profile_photo_removed: ['Removed profile photo', 'team'],
  backup_created: ['Created backup', 'backup'],
  backup_restored: ['Restored backup', 'backup'],
  backup_failed: ['Automatic backup failed', 'backup']
};

function parseDetails(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function humanizeAction(action) {
  const found = ACTION_META[action];
  if (found) return { label: found[0], category: found[1] };
  return {
    label: String(action || 'activity').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    category: 'system'
  };
}

function activityJson(row) {
  const meta = humanizeAction(row.action);
  const details = parseDetails(row.details_json);
  return {
    id: Number(row.id),
    action: row.action,
    label: meta.label,
    category: meta.category,
    userId: row.user_id == null ? null : Number(row.user_id),
    userName: row.user_name || (row.user_id == null ? 'System' : 'Unknown user'),
    userEmail: row.user_email || null,
    userRole: row.user_role || null,
    softwareId: row.software_id == null ? null : Number(row.software_id),
    softwareName: row.software_name || null,
    packageId: row.package_id || null,
    targetUserId: row.target_user_id == null ? null : Number(row.target_user_id),
    targetUserName: row.target_user_name || null,
    targetUserRole: row.target_user_role || null,
    details,
    createdAt: row.created_at || null
  };
}

async function record(userId, action, { softwareId = null, targetUserId = null, details = null } = {}) {
  try {
    const [result] = await getPool().query(
      'INSERT INTO activity_log (user_id,action,software_id,target_user_id,details_json) VALUES (?,?,?,?,?)',
      [userId ? Number(userId) : null, String(action).slice(0,80), softwareId ? Number(softwareId) : null, targetUserId ? Number(targetUserId) : null, details ? JSON.stringify(details) : null]
    );
    return Number(result.insertId || 0);
  } catch (err) {
    console.error('[HSWare] Activity log failed:', err?.message || err);
    return 0;
  }
}

function safeDate(value, endOfDay = false) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0)
    : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function list({ viewer, limit = 20, offset = 0, action = '', userId = null, q = '', from = '', to = '', includeTransient = false } = {}) {
  const db = getPool();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit || 20) || 20)));
  const safeOffset = Math.max(0, Math.floor(Number(offset || 0) || 0));
  const where = [];
  const params = [];

  if (!viewer || viewer.role !== 'admin') {
    const visible = [...PARTNER_VISIBLE_ACTIONS];
    where.push(`(a.action IN (${visible.map(() => '?').join(',')}) OR a.user_id=?)`);
    params.push(...visible, Number(viewer?.id || 0));
  }
  if (!includeTransient) {
    const feed = [...FEED_ACTIONS];
    where.push(`a.action IN (${feed.map(() => '?').join(',')})`);
    params.push(...feed);
  }
  const requestedAction = String(action || '').trim();
  if (requestedAction && /^[a-z0-9_]{1,80}$/i.test(requestedAction)) {
    where.push('a.action=?');
    params.push(requestedAction);
  }
  if (viewer?.role === 'admin' && Number(userId || 0) > 0) {
    where.push('a.user_id=?');
    params.push(Number(userId));
  }
  const needle = String(q || '').trim().slice(0,120);
  if (needle) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR s.name LIKE ? OR s.package_id LIKE ? OR a.action LIKE ?)');
    const like = `%${needle}%`;
    params.push(like, like, like, like, like);
  }
  const fromDate = safeDate(from);
  if (fromDate) {
    where.push('a.created_at>=?');
    params.push(fromDate);
  }
  const toDate = safeDate(to, true);
  if (toDate) {
    where.push('a.created_at<=?');
    params.push(toDate);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const joinSql = `FROM activity_log a
    LEFT JOIN users u ON u.id=a.user_id
    LEFT JOIN software s ON s.id=a.software_id
    LEFT JOIN users tu ON tu.id=a.target_user_id`;
  const [[countRow]] = await db.query(`SELECT COUNT(*) AS c ${joinSql} ${whereSql}`, params);
  const [rows] = await db.query(
    `SELECT a.*,u.name AS user_name,u.email AS user_email,u.role AS user_role,
      s.name AS software_name,s.package_id,
      tu.name AS target_user_name,tu.role AS target_user_role
     ${joinSql} ${whereSql}
     ORDER BY a.created_at DESC,a.id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params
  );
  return {
    results: rows.map(activityJson),
    total: Number(countRow?.c || 0),
    limit: safeLimit,
    offset: safeOffset
  };
}

async function recent(viewer, limit = 8) {
  return list({ viewer, limit, offset: 0, includeTransient: false });
}

async function filters(viewer) {
  const actions = [...FEED_ACTIONS].filter(action => viewer?.role === 'admin' || PARTNER_VISIBLE_ACTIONS.has(action)).sort();
  let users = [];
  if (viewer?.role === 'admin') {
    const [rows] = await getPool().query('SELECT id,name,email,role,is_active FROM users ORDER BY (role=\'admin\') DESC,name,email,id');
    users = rows.map(row => ({ id: Number(row.id), name: row.name || row.email, email: row.email, role: row.role, active: Boolean(row.is_active) }));
  }
  return { actions: actions.map(action => ({ action, ...humanizeAction(action) })), users };
}

module.exports = { record, list, recent, filters, activityJson, humanizeAction };
