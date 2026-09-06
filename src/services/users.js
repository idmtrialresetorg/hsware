const bcrypt = require('bcryptjs');
const { getPool } = require('../db');

const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;
const NAME_MAX = 120;
const EMAIL_MAX = 190;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > NAME_MAX) throw Object.assign(new Error(`Name must be 2 to ${NAME_MAX} characters.`), { status: 400 });
  return name;
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
  }
  return email;
}

function cleanPassword(value, { required = false } = {}) {
  const password = String(value || '');
  if (!password && !required) return null;
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw Object.assign(new Error(`Password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`), { status: 400 });
  }
  return password;
}

function displayRole(role) {
  return String(role || '').toLowerCase() === 'admin' ? 'Admin' : 'Partner';
}

function publicUser(row) {
  if (!row) return null;
  const updated = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  return {
    id: Number(row.id),
    name: row.name || String(row.email || '').split('@')[0] || 'User',
    email: row.email,
    role: String(row.role || 'partner').toLowerCase() === 'admin' ? 'admin' : 'partner',
    roleLabel: displayRole(row.role),
    active: Boolean(row.is_active),
    hasAvatar: Boolean(row.avatar_blob && row.avatar_mime),
    avatarUrl: row.avatar_blob && row.avatar_mime ? `/api/users/${Number(row.id)}/avatar?v=${updated || Date.now()}` : null,
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

async function getUserById(id, { includeAvatar = false } = {}) {
  const columns = includeAvatar ? '*' : 'id,name,email,role,is_active,avatar_mime,(avatar_blob IS NOT NULL) AS has_avatar,last_login_at,created_by,created_at,updated_at';
  const [[row]] = await getPool().query(`SELECT ${columns} FROM users WHERE id=? LIMIT 1`, [Number(id)]);
  if (row && !includeAvatar) {
    row.avatar_blob = row.has_avatar ? Buffer.from([1]) : null;
  }
  return row || null;
}

async function listUsers() {
  const [rows] = await getPool().query(`SELECT id,name,email,role,is_active,avatar_mime,(avatar_blob IS NOT NULL) AS has_avatar,last_login_at,created_by,created_at,updated_at
    FROM users ORDER BY (role='admin') DESC,is_active DESC,name,email,id`);
  return rows.map(row => publicUser({ ...row, avatar_blob: row.has_avatar ? Buffer.from([1]) : null }));
}

async function createPartner({ name, email, password, createdBy }) {
  const db = getPool();
  const clean = { name: cleanName(name), email: cleanEmail(email), password: cleanPassword(password, { required: true }) };
  const hash = await bcrypt.hash(clean.password, 12);
  try {
    const [result] = await db.query(
      `INSERT INTO users (name,email,password_hash,role,is_active,created_by) VALUES (?,?,?,'partner',1,?)`,
      [clean.name, clean.email, hash, Number(createdBy)]
    );
    return publicUser(await getUserById(result.insertId));
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('An account with this email already exists.'), { status: 409 });
    throw err;
  }
}

async function updatePartner(id, { name, email, password }) {
  const db = getPool();
  const [[existing]] = await db.query('SELECT id,role FROM users WHERE id=? LIMIT 1', [Number(id)]);
  if (!existing) throw Object.assign(new Error('User not found.'), { status: 404 });
  if (existing.role !== 'partner') throw Object.assign(new Error('The administrator account cannot be changed from Partner management.'), { status: 403 });
  const clean = { name: cleanName(name), email: cleanEmail(email), password: cleanPassword(password) };
  const values = [clean.name, clean.email];
  let sql = 'UPDATE users SET name=?,email=?';
  if (clean.password) {
    sql += ',password_hash=?';
    values.push(await bcrypt.hash(clean.password, 12));
  }
  sql += ' WHERE id=?';
  values.push(Number(id));
  try {
    await db.query(sql, values);
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('An account with this email already exists.'), { status: 409 });
    throw err;
  }
  return publicUser(await getUserById(id));
}

async function updateOwnAdmin(id, { name, email, password }) {
  const db = getPool();
  const [[existing]] = await db.query('SELECT id,role FROM users WHERE id=? LIMIT 1', [Number(id)]);
  if (!existing) throw Object.assign(new Error('User not found.'), { status: 404 });
  if (existing.role !== 'admin') throw Object.assign(new Error('Only the administrator can update the administrator profile here.'), { status: 403 });
  const clean = { name: cleanName(name), email: cleanEmail(email), password: cleanPassword(password) };
  const values = [clean.name, clean.email];
  let sql = 'UPDATE users SET name=?,email=?';
  if (clean.password) {
    sql += ',password_hash=?';
    values.push(await bcrypt.hash(clean.password, 12));
  }
  sql += ' WHERE id=?';
  values.push(Number(id));
  try {
    await db.query(sql, values);
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('An account with this email already exists.'), { status: 409 });
    throw err;
  }
  return publicUser(await getUserById(id));
}

async function setPartnerActive(id, active) {
  const db = getPool();
  const [[existing]] = await db.query('SELECT id,role,is_active FROM users WHERE id=? LIMIT 1', [Number(id)]);
  if (!existing) throw Object.assign(new Error('User not found.'), { status: 404 });
  if (existing.role !== 'partner') throw Object.assign(new Error('The administrator account cannot be disabled.'), { status: 403 });
  await db.query('UPDATE users SET is_active=? WHERE id=?', [active ? 1 : 0, Number(id)]);
  if (!active) await db.query('DELETE FROM app_work_claims WHERE user_id=?', [Number(id)]);
  return publicUser(await getUserById(id));
}

function validateAvatar(buffer, mime) {
  const type = String(mime || '').split(';', 1)[0].trim().toLowerCase();
  if (!AVATAR_TYPES.has(type)) throw Object.assign(new Error('Profile photo must be JPG, PNG, or WEBP.'), { status: 415 });
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error('Choose a profile photo first.'), { status: 400 });
  if (buffer.length > AVATAR_MAX_BYTES) throw Object.assign(new Error('Profile photo must be 2 MB or smaller.'), { status: 413 });
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  const webp = buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP';
  if ((type === 'image/jpeg' && !jpeg) || (type === 'image/png' && !png) || (type === 'image/webp' && !webp)) {
    throw Object.assign(new Error('The uploaded profile photo does not match its image type.'), { status: 400 });
  }
  return type;
}

async function setAvatar(id, buffer, mime) {
  const type = validateAvatar(buffer, mime);
  const [result] = await getPool().query('UPDATE users SET avatar_mime=?,avatar_blob=? WHERE id=?', [type, buffer, Number(id)]);
  if (!result.affectedRows) throw Object.assign(new Error('User not found.'), { status: 404 });
  return publicUser(await getUserById(id));
}

async function removeAvatar(id) {
  const [result] = await getPool().query('UPDATE users SET avatar_mime=NULL,avatar_blob=NULL WHERE id=?', [Number(id)]);
  if (!result.affectedRows) throw Object.assign(new Error('User not found.'), { status: 404 });
  return publicUser(await getUserById(id));
}

async function avatar(id) {
  const [[row]] = await getPool().query('SELECT avatar_mime,avatar_blob FROM users WHERE id=? LIMIT 1', [Number(id)]);
  if (!row?.avatar_blob || !row?.avatar_mime) return null;
  return { mime: row.avatar_mime, buffer: row.avatar_blob };
}

module.exports = {
  PASSWORD_MIN,
  AVATAR_MAX_BYTES,
  publicUser,
  getUserById,
  listUsers,
  createPartner,
  updatePartner,
  updateOwnAdmin,
  setPartnerActive,
  setAvatar,
  removeAvatar,
  avatar
};
