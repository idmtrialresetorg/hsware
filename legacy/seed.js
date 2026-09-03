const bcrypt = require('bcryptjs');
const config = require('./config');
const { getPool } = require('./db');
const { marketSeeds, intelligenceFor, demandRankFromIntelligence } = require('./catalog-intelligence');

async function seedStarterCatalog() {
  const db = getPool();
  const [[setting]] = await db.query("SELECT setting_value FROM app_settings WHERE setting_key='starter_catalog_enabled' LIMIT 1");
  if (String(setting?.setting_value || '1') === '0') return;
  for (const item of marketSeeds()) {
    const { rank, packageId, name, publisher } = item;
    const info = intelligenceFor(item, { forceCurated:true });
    const category = info.category || null;
    const demandRank = rank || demandRankFromIntelligence(info, rank || 0);
    const aliases = `${name} ${packageId} ${publisher || ''} ${category || ''}`;
    // Rank only packages already verified by the WinGet catalog sync. Do not
    // create catalog rows with no manifest/source path.
    await db.query(
      `UPDATE catalog_packages SET
         name=?, canonical_name=?, publisher=COALESCE(publisher,?), category=?,
         search_aliases=?, discovery_rank=LEAST(COALESCE(discovery_rank,?),?),
         demand_rank=LEAST(COALESCE(demand_rank,?),?),catalog_status='curated',
         market_score=?,quality_score=?,relevance_score=?,pricing_model=?,has_free_tier=?,has_free_trial=?,commercial_product=?,
         intelligence_source=?,intelligence_reason=?,intelligence_updated_at=NOW()
       WHERE package_id=? AND source_path IS NOT NULL AND source_path<>''`,
      [name, info.canonicalName || name, publisher, category, aliases, Number(rank || demandRank), Number(rank || demandRank), Number(demandRank), Number(demandRank),
       info.marketScore, info.qualityScore, info.relevanceScore, info.pricingModel, info.hasFreeTier?1:0, info.hasFreeTrial?1:0, info.commercialProduct?1:0,
       info.sourceConfidence, info.reason, packageId]
    );
  }
}

function defaultAdminName(email) {
  const configured = String(config.adminName || '').trim();
  if (configured) return configured.slice(0, 120);
  const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local ? local.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 120) : 'Administrator';
}

async function configuredAdminCredentials() {
  if (!config.adminEmail || !config.adminPassword) return null;
  if (config.adminPassword.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters.');
  const email = config.adminEmail.toLowerCase().trim();
  return { email, name: defaultAdminName(email), hash: await bcrypt.hash(config.adminPassword, 12) };
}

async function ensureAdmin() {
  const db = getPool();
  const [[existingAdmin]] = await db.query("SELECT id,name,email FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  if (existingAdmin) {
    if (config.adminRecoveryMode) {
      const configured = await configuredAdminCredentials();
      if (!configured) throw new Error('ADMIN_RECOVERY_MODE requires ADMIN_EMAIL and ADMIN_PASSWORD.');
      await db.query('UPDATE users SET name=?,email=?,password_hash=?,is_active=1 WHERE id=?',
        [configured.name, configured.email, configured.hash, existingAdmin.id]);
      console.warn('[HSWare] ADMIN_RECOVERY_MODE synchronized the configured Admin credentials. Disable ADMIN_RECOVERY_MODE after successful sign-in.');
    } else if (!String(existingAdmin.name || '').trim()) {
      await db.query('UPDATE users SET name=? WHERE id=?', [defaultAdminName(existingAdmin.email), existingAdmin.id]);
    }
    return true;
  }

  const [users] = await db.query('SELECT id,name,email FROM users ORDER BY id LIMIT 1');
  if (users[0]) {
    if (config.adminRecoveryMode) {
      const configured = await configuredAdminCredentials();
      if (!configured) throw new Error('ADMIN_RECOVERY_MODE requires ADMIN_EMAIL and ADMIN_PASSWORD.');
      await db.query("UPDATE users SET role='admin',is_active=1,name=?,email=?,password_hash=? WHERE id=?",
        [configured.name, configured.email, configured.hash, users[0].id]);
      console.warn('[HSWare] ADMIN_RECOVERY_MODE promoted the first account and synchronized the configured Admin credentials. Disable ADMIN_RECOVERY_MODE after successful sign-in.');
    } else {
      await db.query("UPDATE users SET role='admin',is_active=1,name=COALESCE(NULLIF(TRIM(name),''),?) WHERE id=?", [defaultAdminName(users[0].email), users[0].id]);
    }
    return true;
  }

  const configured = await configuredAdminCredentials();
  if (!configured) return false;
  await db.query("INSERT INTO users (name,email,password_hash,role,is_active) VALUES (?,?,?,'admin',1)", [configured.name, configured.email, configured.hash]);
  return true;
}

module.exports = { seedStarterCatalog, ensureAdmin };
