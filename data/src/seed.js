const bcrypt = require('bcryptjs');
const config = require('./config');
const { getPool } = require('./db');

function defaultAdminName(email) {
  const configured = String(config.adminName || '').trim();
  if (configured) return configured.slice(0, 120);
  const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local ? local.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 120) : 'Administrator';
}

async function ensureAdmin() {
  const db = getPool();
  const [[existingAdmin]] = await db.query("SELECT id,name,email FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  if (existingAdmin) {
    if (!String(existingAdmin.name || '').trim()) await db.query('UPDATE users SET name=? WHERE id=?', [defaultAdminName(existingAdmin.email), existingAdmin.id]);
    return true;
  }
  const [users] = await db.query('SELECT id,name,email FROM users ORDER BY id LIMIT 1');
  if (users[0]) {
    await db.query("UPDATE users SET role='admin',is_active=1,name=COALESCE(NULLIF(TRIM(name),''),?) WHERE id=?", [defaultAdminName(users[0].email), users[0].id]);
    return true;
  }
  if (!config.adminEmail || !config.adminPassword) return false;
  if (config.adminPassword.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters.');
  const email = config.adminEmail.toLowerCase().trim();
  const hash = await bcrypt.hash(config.adminPassword, 12);
  await db.query("INSERT INTO users (name,email,password_hash,role,is_active) VALUES (?,?,?,'admin',1)", [defaultAdminName(email), email, hash]);
  return true;
}

module.exports = { ensureAdmin };
