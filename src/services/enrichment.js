const state = require('../state');
const { getPool } = require('../db');
const { installerUrlExtension } = require('./winget');
const packageSource = require('./package-source');
const { fetchOfficialDetails, betterDescription } = require('./official-details');

let detailsBusy = false;
let started = false;

async function queueSoftware(softwareId, { force = false } = {}) {
  const db = getPool();
  await db.query(
    `INSERT INTO enrichment_queue (software_id,status,media_status,next_attempt_at,last_error,last_media_error,completed_at)
     VALUES (?,'queued','disabled',NOW(),NULL,NULL,NULL)
     ON DUPLICATE KEY UPDATE status=IF(status='running','running','queued'),media_status='disabled',next_attempt_at=NOW(),last_error=NULL,last_media_error=NULL,completed_at=NULL`,
    [softwareId]
  );
  if (force) {
    await db.query("UPDATE software SET enrichment_status=IF(enrichment_status='fetching','fetching','pending') WHERE id=?", [softwareId]);
  }
  return true;
}

async function enrichOfficialText(softwareId) {
  const db = getPool();
  const [[software]] = await db.query('SELECT * FROM software WHERE id=? LIMIT 1', [softwareId]);
  if (!software) return;
  try {
    const extra = await fetchOfficialDetails(software);
    if (!extra) return;
    const req = extra.requirements || {};
    const chosen = betterDescription(software.description, extra.description);
    await db.query(
      `UPDATE software SET description=COALESCE(?,description),
       language=COALESCE(NULLIF(?,''),language),minimum_os_version=COALESCE(NULLIF(?,''),minimum_os_version),
       processor=COALESCE(NULLIF(?,''),processor),ram_requirement=COALESCE(NULLIF(?,''),ram_requirement),
       storage_requirement=COALESCE(NULLIF(?,''),storage_requirement),graphics_requirement=COALESCE(NULLIF(?,''),graphics_requirement),
       requirements_source_url=COALESCE(?,requirements_source_url),updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [chosen, req.language || null, req.minimumOsVersion || null, req.processor || null, req.ram || null, req.storage || null, req.graphics || null, req.sourceUrl || null, softwareId]
    );
  } catch (err) {
    // Official-page text is optional. The verified WinGet record remains valid
    // when a vendor blocks crawling or has no machine-readable requirements.
    console.warn('[HSWare] Optional official details:', String(err.message || err).slice(0, 300));
  }
}

async function runDetailsOnce() {
  if (detailsBusy || !state.dbReady) return false;
  detailsBusy = true;
  try {
    const db = getPool();
    const [[job]] = await db.query(
      `SELECT q.*,s.source_path,s.current_version,s.installer_url,s.installer_type,s.source_type
       FROM enrichment_queue q JOIN software s ON s.id=q.software_id
       WHERE q.status IN ('queued','error') AND (q.next_attempt_at IS NULL OR q.next_attempt_at<=NOW())
       ORDER BY q.updated_at ASC,q.id ASC LIMIT 1`
    );
    if (!job) return false;
    try {
      await db.query("UPDATE enrichment_queue SET status='running',media_status='disabled',last_error=NULL WHERE id=?", [job.id]);
      if (String(job.source_type || 'winget').toLowerCase() === 'liteapks') {
        await packageSource.enrichManagedSoftwareById(Number(job.software_id));
      } else {
        const ext = installerUrlExtension(job.installer_url);
        const preferredInstallerFormat = String(job.installer_type || '').toLowerCase() === 'portable' ? 'portable'
          : ['exe','msi'].includes(ext) ? ext
          : ['msix','msixbundle'].includes(ext) ? 'msix'
          : ['appx','appxbundle'].includes(ext) ? 'appx'
          : ['zip','7z','rar'].includes(ext) ? 'portable'
          : 'all';
        await packageSource.enrichManagedSoftwareById(Number(job.software_id), {
          includeOldVersions: true,
          probeSize: true,
          findLatest: true,
          recoverPath: true,
          preferredInstallerFormat
        });
        await enrichOfficialText(Number(job.software_id));
      }
      await db.query("UPDATE enrichment_queue SET status='ready',media_status='disabled',next_attempt_at=NULL,last_error=NULL,completed_at=NOW() WHERE id=?", [job.id]);
    } catch (err) {
      const msg = String(err.message || err).slice(0, 1800);
      const attempts = Number(job.attempts || 0) + 1;
      const delayMinutes = Math.min(360, Math.max(5, attempts * 10));
      const retryAt = new Date(Date.now() + delayMinutes * 60 * 1000);
      await db.query(
        "UPDATE enrichment_queue SET status='error',media_status='disabled',attempts=attempts+1,last_error=?,next_attempt_at=? WHERE id=?",
        [msg, retryAt, job.id]
      );
    }
    return true;
  } finally {
    detailsBusy = false;
  }
}

function startEnrichmentWorker() {
  if (started) return;
  started = true;
  const detailsTimer = setInterval(() => { runDetailsOnce().catch(err => console.error('[HSWare] Details worker:', err.message || err)); }, 1200);
  if (detailsTimer.unref) detailsTimer.unref();
  console.log('[HSWare] Automatic details worker started (media disabled).');
}

module.exports = { queueSoftware, runDetailsOnce, startEnrichmentWorker, betterDescription };
