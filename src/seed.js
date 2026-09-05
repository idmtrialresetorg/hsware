const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { getPool } = require('./db');

function parseCsvLine(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i+1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function seedStarterCatalog() {
  const db = getPool();
  const [[setting]] = await db.query("SELECT setting_value FROM app_settings WHERE setting_key='starter_catalog_enabled' LIMIT 1");
  if (String(setting?.setting_value || '1') === '0') return;
  const csvPath = path.join(__dirname, '..', 'data', 'popular-starter.csv');
  const text = fs.readFileSync(csvPath, 'utf8').trim();
  const lines = text.split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [rank, packageId, name, category] = parseCsvLine(line);
    const publisher = String(packageId).split('.')[0] || null;
    const aliases = `${name} ${packageId} ${publisher}`;
    await db.query(
      `INSERT INTO catalog_packages
       (package_id, name, publisher, category, search_aliases, discovery_rank, demand_rank)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), category=COALESCE(catalog_packages.category, VALUES(category)),
         search_aliases=VALUES(search_aliases), demand_rank=COALESCE(catalog_packages.demand_rank, VALUES(demand_rank))`,
      [packageId, name, publisher, category || null, aliases, Number(rank), Number(rank)]
    );
  }
}

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
    if (!String(existingAdmin.name || '').trim()) {
      await db.query('UPDATE users SET name=? WHERE id=?', [defaultAdminName(existingAdmin.email), existingAdmin.id]);
    }
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

module.exports = { seedStarterCatalog, ensureAdmin };
