const { getPool } = require('../db');

async function clearNewSoftware() {
  const db = getPool();
  const [rows] = await db.query('SELECT package_id FROM software WHERE workspace_added=1 AND published=0');
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
  await db.query('DELETE FROM software WHERE workspace_added=1 AND published=0');
  await db.query("DELETE FROM import_jobs WHERE status IN ('queued','running','complete')");
  return { cleared: rows.length };
}

async function resetAllData() {
  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM software');
    await conn.query('DELETE FROM software_import_history');
    await conn.query('DELETE FROM catalog_version_paths');
    await conn.query('DELETE FROM catalog_packages');
    await conn.query('DELETE FROM import_jobs');
    await conn.query('DELETE FROM update_scan_state');
    await conn.query('DELETE FROM catalog_sync_state');
    await conn.query('DELETE FROM winget_manifest_cache');
    await conn.query(`INSERT INTO app_settings (setting_key,setting_value) VALUES ('starter_catalog_enabled','0')
      ON DUPLICATE KEY UPDATE setting_value='0'`);
    await conn.commit();
    return { ok: true };
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { clearNewSoftware, resetAllData };
