const { getPool } = require('../db');

function normalizePlatform(value) {
  const platform = String(value || 'all').toLowerCase();
  if (platform === 'windows' || platform === 'desktop') return 'windows';
  if (platform === 'android') return 'android';
  return 'all';
}

async function clearNewSoftware(platform = 'all') {
  const db = getPool();
  const normalized = normalizePlatform(platform);
  let platformWhere = '';
  if (normalized === 'windows') platformWhere = " AND COALESCE(platform_key,'windows')='windows'";
  if (normalized === 'android') platformWhere = " AND platform_key='android'";

  const [rows] = await db.query(`SELECT package_id FROM software WHERE workspace_added=1 AND published=0${platformWhere}`);
  if (rows.length) {
    for (const row of rows) {
      await db.query(
        `INSERT INTO software_import_history (package_id,status,last_error)
         VALUES (?,'cleared',NULL)
         ON DUPLICATE KEY UPDATE status='cleared',last_error=NULL,updated_at=CURRENT_TIMESTAMP`,
        [row.package_id]
      );
    }
  }
  await db.query(`DELETE FROM software WHERE workspace_added=1 AND published=0${platformWhere}`);
  // WinGet bulk-import jobs belong only to the desktop workflow. Clearing Android
  // APK records must never stop or delete a Windows import job.
  if (normalized !== 'android') await db.query("DELETE FROM import_jobs WHERE status IN ('queued','running','complete')");
  return { cleared: rows.length, platform: normalized };
}

async function resetAllData() {
  const db = getPool();
  await db.query('DELETE FROM software');
  await db.query('DELETE FROM software_import_history');
  await db.query('DELETE FROM catalog_version_paths');
  await db.query('DELETE FROM catalog_packages');
  await db.query('DELETE FROM import_jobs');
  await db.query('DELETE FROM update_scan_state');
  await db.query('DELETE FROM catalog_sync_state');
  await db.query('DELETE FROM winget_manifest_cache');
  try { await db.query('DELETE FROM liteapks_sync_state'); } catch {}
  await db.query(`INSERT INTO app_settings (setting_key,setting_value) VALUES ('starter_catalog_enabled','0')
    ON DUPLICATE KEY UPDATE setting_value='0'`);
  return { ok: true };
}

module.exports = { clearNewSoftware, resetAllData };
