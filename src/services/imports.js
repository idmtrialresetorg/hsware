const fs = require('fs');
const path = require('path');
const state = require('../state');
const { getPool } = require('../db');
const config = require('../config');
const catalog = require('./catalog');
const { ensureManagedSoftware, enrichManagedSoftwareById, normalizeInstallerFormat } = require('./winget');
const { queueSoftware } = require('./enrichment');
const { titleizePackageId } = require('../utils/text');
const activity = require('./activity');
const notifications = require('./notifications');

const MAX_AUTO_TARGET = 50000;
const REFILL_SIZE = 120;
const CATALOG_STEPS_PER_REFILL = 3;
let importWorkerBusy = false;
let importWorkerStarted = false;

function decodeJobQueue(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (Array.isArray(parsed)) return { items: parsed, installerFormat: 'all' };
    return {
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      installerFormat: normalizeInstallerFormat(parsed?.installerFormat || 'all')
    };
  } catch { return { items: [], installerFormat: 'all' }; }
}

function encodeJobQueue(items, installerFormat) {
  return JSON.stringify({ items: Array.isArray(items) ? items : [], installerFormat: normalizeInstallerFormat(installerFormat) });
}

function parseCsvLine(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

let starterCache = null;
function starterPackages() {
  if (starterCache) return starterCache;
  const csvPath = path.join(__dirname, '..', '..', 'data', 'popular-starter.csv');
  const text = fs.readFileSync(csvPath, 'utf8').trim();
  starterCache = text.split(/\r?\n/).slice(1).filter(Boolean).map(line => {
    const [rank, packageId, name, category] = parseCsvLine(line);
    return {
      rank: Number(rank || 999999),
      packageId: String(packageId || '').trim(),
      name: String(name || '').trim() || titleizePackageId(packageId),
      category: String(category || '').trim() || null,
      publisher: String(packageId || '').split('.')[0] || null
    };
  }).filter(x => x.packageId);
  return starterCache;
}

// Auto Import is intentionally conservative around age-restricted or dangerous
// software categories. Manual exact-package verification remains separate.
function isCuratedStarter(packageId) {
  const key = String(packageId || '').toLowerCase();
  return starterPackages().some(item => item.packageId.toLowerCase() === key);
}

function looksLikeComponentOrPrerelease(item) {
  const hay = `${item?.packageId || ''} ${item?.name || ''} ${item?.category || ''}`.toLowerCase();
  const component = /(?:^|[\s._-])(runtime|redistributable|redist|sdk|devkit|framework|headers?|symbols?|language[\s._-]*pack|langpack|driver|plugin|extension|addon|module|libraries?|samples?|tests?|debug)(?:$|[\s._-])/i;
  const prerelease = /(?:^|[\s._-])(nightly|alpha|beta|preview|canary|snapshot|insiders?)(?:$|[\s._-])/i;
  return component.test(hay) || prerelease.test(hay);
}

// Auto Import stays conservative: curated software is prioritized, while the
// broader WinGet catalog must look like a normal end-user application/tool.
// Manual exact-package import is intentionally not restricted by this filter.
function allowedForAutomaticImport(item) {
  const hay = `${item?.packageId || ''} ${item?.name || ''} ${item?.category || ''}`.toLowerCase();
  const restrictedCategory = /(?:^|[\s._-])(gambling|casino|betting|firearm|weapon|adult)(?:$|[\s._-])/i;
  if (restrictedCategory.test(hay)) return false;
  if (!isCuratedStarter(item?.packageId) && looksLikeComponentOrPrerelease(item)) return false;
  return true;
}

function automaticQualification(item) {
  if (isCuratedStarter(item?.package_id || item?.packageId)) return { ok: true, score: 100, reason: null };
  if (!allowedForAutomaticImport({ packageId: item?.package_id || item?.packageId, name: item?.name, category: item?.category })) {
    return { ok: false, score: 0, reason: 'Filtered: component, prerelease, restricted, or low-value package type.' };
  }

  let score = 0;
  const publisher = String(item?.publisher || '').trim();
  const description = String(item?.description || '').trim();
  const officialUrl = String(item?.official_url || '').trim();
  const installerType = String(item?.installer_type || '').trim();
  const name = String(item?.name || '').trim();
  if (item?.current_version && item?.installer_url) score += 20;
  if (publisher && !/^(unknown|n\/a|none)$/i.test(publisher)) score += 15;
  if (description.length >= 80) score += 15;
  else if (description.length >= 35) score += 8;
  if (/^https?:\/\//i.test(officialUrl)) score += 15;
  if (installerType && !/^(unknown|portable)$/i.test(installerType)) score += 10;
  if (name.length >= 3 && name.length <= 100) score += 10;
  if (item?.sha256) score += 5;
  if (item?.architecture) score += 5;
  if (score < 60) return { ok: false, score, reason: `Filtered: software quality score ${score}/100 is below the automatic-import threshold.` };
  return { ok: true, score, reason: null };
}

async function currentJob() {
  const [rows] = await getPool().query('SELECT * FROM import_jobs ORDER BY id DESC LIMIT 1');
  const job = rows[0] || null;
  if (!job) return null;
  const queueState = decodeJobQueue(job.queue_json);
  return { ...job, installer_format: queueState.installerFormat };
}

async function excludedPackageIds(activeJobId = null) {
  const db = getPool();
  const [rows] = await db.query(`
    SELECT package_id FROM software WHERE workspace_added=1
    UNION
    SELECT package_id FROM software_import_history
    WHERE status NOT IN ('abandoned')
      AND NOT (status='reserved' AND last_job_id=?)
  `, [activeJobId || 0]);
  return new Set(rows.map(r => String(r.package_id).toLowerCase()));
}

async function hiddenCachedCandidates(limit, excluded) {
  const db = getPool();
  // Filter already-processed rows in SQL. This avoids repeatedly scanning only
  // the first few thousand catalog rows after a large import has progressed.
  const scanLimit = Math.max(200, Math.min(1500, Number(limit || REFILL_SIZE) * 6));
  const [rows] = await db.query(
    `SELECT c.package_id,c.name,c.publisher,c.category,c.source_path,
      COALESCE(c.demand_rank,c.discovery_rank,999999) AS rank_value
     FROM catalog_packages c
     LEFT JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1
     LEFT JOIN software_import_history h ON h.package_id=c.package_id AND h.status<>'abandoned'
     WHERE c.source_path IS NOT NULL AND c.source_path<>''
       AND s.id IS NULL AND h.package_id IS NULL
     ORDER BY CASE WHEN c.demand_rank IS NULL THEN 1 ELSE 0 END,
       c.demand_rank, COALESCE(c.discovery_rank,c.id), c.id
     LIMIT ?`, [scanLimit]
  );
  return rows
    .filter(r => !excluded.has(String(r.package_id).toLowerCase()))
    .filter(allowedForAutomaticImport)
    .slice(0, limit)
    .map(r => ({
      packageId: r.package_id,
      name: r.name || titleizePackageId(r.package_id),
      publisher: r.publisher || String(r.package_id).split('.')[0] || null,
      category: r.category || null,
      sourcePath: r.source_path || null,
      rank: Number(r.rank_value || 999999)
    }));
}

async function discoveryState() {
  try { return await catalog.getSyncState(); }
  catch { return { status: 'paused', last_error: 'WinGet discovery state is unavailable.' }; }
}

async function fillHiddenDiscoveryCache(required, excluded) {
  let candidates = await hiddenCachedCandidates(required, excluded);
  if (candidates.length >= required) return { candidates, state: await discoveryState() };

  let syncState = await discoveryState();
  try {
    if (!syncState || syncState.status === 'idle') {
      syncState = await catalog.startSync(config.catalogTarget);
    } else if (syncState.status === 'paused') {
      const pausedAt = syncState.updated_at ? new Date(syncState.updated_at).getTime() : 0;
      // GitHub can pause discovery on rate limits or transient errors. Avoid a
      // tight retry loop; the background job stays alive and retries later.
      if (pausedAt && Date.now() - pausedAt < 5 * 60 * 1000) return { candidates, state: syncState };
      syncState = await catalog.resumeSync();
    }
    // Do not restart a completed catalog from the beginning. If it is complete,
    // the source is exhausted for this snapshot.
    for (let i = 0; i < CATALOG_STEPS_PER_REFILL && candidates.length < required && syncState?.status === 'running'; i++) {
      const step = await catalog.syncStep();
      syncState = step.state;
      candidates = await hiddenCachedCandidates(required, excluded);
    }
  } catch (err) {
    syncState = { ...(syncState || {}), status: 'paused', last_error: String(err.message || err) };
  }
  return { candidates, state: syncState };
}

async function autoCandidates(limit, activeJobId = null) {
  const excluded = await excludedPackageIds(activeJobId);
  const out = [];
  const seen = new Set();
  const push = item => {
    const key = String(item?.packageId || '').toLowerCase();
    if (!key || excluded.has(key) || seen.has(key) || !allowedForAutomaticImport(item)) return;
    seen.add(key); out.push(item);
  };

  // The curated list is the only part for which HSWare claims a popularity
  // ordering. WinGet does not expose a universal popularity count.
  for (const item of starterPackages()) {
    push(item);
    if (out.length >= limit) return { candidates: out, state: await discoveryState() };
  }

  const discovered = await fillHiddenDiscoveryCache(limit - out.length, excluded);
  for (const item of discovered.candidates) push(item);
  return { candidates: out.slice(0, limit), state: discovered.state };
}

async function syncJobCounters(jobId) {
  const db = getPool();
  const [[counts]] = await db.query(
    `SELECT
       SUM(status='imported' AND last_job_id=?) AS imported_count,
       SUM(status IN ('failed','filtered') AND last_job_id=?) AS rejected_count
     FROM software_import_history`,
    [jobId, jobId]
  );
  const imported = Number(counts?.imported_count || 0);
  const rejected = Number(counts?.rejected_count || 0);
  await db.query(
    `UPDATE import_jobs SET completed_count=?,enriched_count=?,failed_count=?,detail_failed_count=? WHERE id=?`,
    [imported, imported, rejected, rejected, jobId]
  );
  return { imported, rejected };
}

async function startAutoImport(count, installerFormat = 'all', requestedBy = null) {
  const db = getPool();
  const requested = Math.max(1, Math.min(MAX_AUTO_TARGET, Math.floor(Number(count || 1000))));
  const selectedFormat = normalizeInstallerFormat(installerFormat);

  const [oldJobs] = await db.query("SELECT id FROM import_jobs WHERE status IN ('queued','running')");
  if (oldJobs.length) {
    const ids = oldJobs.map(x => Number(x.id)).filter(Boolean);
    await db.query("UPDATE import_jobs SET status='abandoned',phase='stopped',current_package=NULL WHERE status IN ('queued','running')");
    if (ids.length) {
      await db.query(`UPDATE software_import_history SET status='abandoned',last_error='Previous bulk import was replaced by a new job' WHERE status='reserved' AND last_job_id IN (${ids.map(()=>'?').join(',')})`, ids);
    }
  }

  const [result] = await db.query(
    `INSERT INTO import_jobs (status,requested_count,requested_by,completion_notified,queue_json,phase,available_count,catalog_complete)
     VALUES ('running',?,?,0,?,'discovering',0,0)`,
    [requested, requestedBy ? Number(requestedBy) : null, encodeJobQueue([], selectedFormat)]
  );
  await db.query('SELECT id FROM import_jobs WHERE id=?', [Number(result.insertId)]);
  return currentJob();
}

async function stopAutoImport() {
  const db = getPool();
  const job = await currentJob();
  if (!job || !['queued','running'].includes(job.status)) return job;
  await db.query("UPDATE import_jobs SET status='abandoned',phase='stopped',current_package=NULL WHERE id=?", [job.id]);
  await db.query("UPDATE software_import_history SET status='abandoned',last_error='Bulk import stopped' WHERE status='reserved' AND last_job_id=?", [job.id]);
  return currentJob();
}

async function candidateMetadata(packageId) {
  const starter = starterPackages().find(x => x.packageId.toLowerCase() === String(packageId).toLowerCase());
  if (starter) return starter;
  const [[cached]] = await getPool().query('SELECT * FROM catalog_packages WHERE package_id=? LIMIT 1', [packageId]);
  return cached ? {
    packageId: cached.package_id,
    name: cached.name,
    publisher: cached.publisher,
    category: cached.category,
    sourcePath: cached.source_path,
    rank: cached.demand_rank || cached.discovery_rank || null
  } : { packageId, name: titleizePackageId(packageId), publisher: String(packageId).split('.')[0] || null };
}

async function recordHistory(packageId, status, error = null, jobId = null) {
  await getPool().query(
    `INSERT INTO software_import_history (package_id,status,last_error,last_imported_at,last_job_id)
     VALUES (?,?,?,IF(?='imported',NOW(),NULL),?)
     ON DUPLICATE KEY UPDATE status=VALUES(status),last_error=VALUES(last_error),
       last_imported_at=IF(VALUES(status)='imported',NOW(),last_imported_at),last_job_id=COALESCE(VALUES(last_job_id),last_job_id),updated_at=CURRENT_TIMESTAMP`,
    [packageId, status, error ? String(error).slice(0, 2000) : null, status, jobId]
  );
}

async function verifiedImport(packageId, options = {}) {
  const db = getPool();
  const meta = await candidateMetadata(packageId);
  let [[existing]] = await db.query('SELECT * FROM software WHERE package_id=? LIMIT 1', [packageId]);
  const [[history]] = await db.query('SELECT status,last_job_id FROM software_import_history WHERE package_id=? LIMIT 1', [packageId]);

  if (existing?.workspace_added) {
    const sameReservedJob = options.auto && history?.status === 'reserved' && Number(history.last_job_id || 0) === Number(options.jobId || 0);
    if (!sameReservedJob) {
      if (options.auto) throw new Error(`Duplicate skipped: ${packageId} is already in New or Published Software.`);
      return existing;
    }
    if (existing.current_version && existing.installer_url) {
      await recordHistory(packageId, 'imported', null, options.jobId || null);
      return existing;
    }
  }

  if (options.auto && history && !(history.status === 'reserved' && Number(history.last_job_id || 0) === Number(options.jobId || 0)) && history.status !== 'abandoned') {
    throw new Error(`Duplicate skipped: ${packageId} was already processed by HSWare.`);
  }

  const sw = await ensureManagedSoftware(packageId, meta.category || null, meta.rank || null, meta.sourcePath || null);
  try {
    const fresh = await enrichManagedSoftwareById(Number(sw.id), {
      includeOldVersions: false,
      probeSize: false,
      findLatest: true,
      recoverPath: true,
      preferredInstallerFormat: options.installerFormat || 'all'
    });
    if (!fresh?.current_version || !fresh?.installer_url) {
      throw new Error('WinGet did not return a verified version and installer URL.');
    }
    if (options.auto) {
      const qualification = automaticQualification(fresh);
      if (!qualification.ok) {
        await recordHistory(packageId, 'filtered', qualification.reason || 'Excluded from automatic bulk import.', options.jobId || null);
        await db.query('DELETE FROM software WHERE id=? AND published=0', [sw.id]);
        throw new Error(qualification.reason || 'Package excluded from automatic bulk import.');
      }
    }
    await recordHistory(packageId, 'imported', null, options.jobId || null);
    await queueSoftware(Number(sw.id), { force: false });
    return fresh;
  } catch (err) {
    const [[latestHistory]] = await db.query('SELECT status FROM software_import_history WHERE package_id=? LIMIT 1', [packageId]);
    if (latestHistory?.status !== 'filtered') await recordHistory(packageId, 'failed', err.message || String(err), options.jobId || null);
    if (!existing) await db.query('DELETE FROM software WHERE id=? AND published=0', [sw.id]);
    else await db.query('UPDATE software SET workspace_added=0,workspace_added_at=NULL WHERE id=? AND published=0', [sw.id]);
    throw err;
  }
}

async function catalogPackageCount() {
  const [[row]] = await getPool().query("SELECT COUNT(*) AS c FROM catalog_packages WHERE source_path IS NOT NULL AND source_path<>''");
  return Number(row?.c || 0);
}

async function refillJob(job) {
  const db = getPool();
  const queueState = decodeJobQueue(job.queue_json);
  const installerFormat = queueState.installerFormat;
  const remainingTarget = Math.max(0, Number(job.requested_count || 0) - Number(job.completed_count || 0));
  if (!remainingTarget) {
    await db.query("UPDATE import_jobs SET status='complete',phase='target_reached',current_package=NULL,queue_json=? WHERE id=?", [encodeJobQueue([], installerFormat), job.id]);
    return currentJob();
  }

  const { candidates, state: catState } = await autoCandidates(Math.min(REFILL_SIZE, remainingTarget), job.id);
  const availableCount = await catalogPackageCount();
  const catalogComplete = catState?.status === 'complete' ? 1 : 0;

  if (candidates.length) {
    await db.query(
      `UPDATE import_jobs SET queue_json=?,phase='importing',available_count=?,catalog_complete=?,last_error=NULL WHERE id=?`,
      [encodeJobQueue(candidates.map(x => x.packageId), installerFormat), availableCount, catalogComplete, job.id]
    );
    return currentJob();
  }

  if (catState?.status === 'complete') {
    await db.query(
      "UPDATE import_jobs SET status='complete',phase='source_exhausted',catalog_complete=1,available_count=?,current_package=NULL,queue_json=?,last_error=NULL WHERE id=?",
      [availableCount, encodeJobQueue([], installerFormat), job.id]
    );
  } else {
    await db.query(
      "UPDATE import_jobs SET phase='discovering',available_count=?,catalog_complete=0,last_error=? WHERE id=?",
      [availableCount, catState?.last_error ? String(catState.last_error).slice(0, 2000) : null, job.id]
    );
  }
  return currentJob();
}

async function stepAutoImportUnlocked() {
  const db = getPool();
  let job = await currentJob();
  if (!job || !['queued','running'].includes(job.status)) return job;

  await syncJobCounters(job.id);
  [[job]] = await db.query('SELECT * FROM import_jobs WHERE id=? LIMIT 1', [job.id]);
  let queueState = decodeJobQueue(job.queue_json);
  let queue = queueState.items;
  let installerFormat = queueState.installerFormat;
  if (Number(job.completed_count || 0) >= Number(job.requested_count || 0)) {
    await db.query("UPDATE import_jobs SET status='complete',phase='target_reached',current_package=NULL,queue_json=? WHERE id=?", [encodeJobQueue([], installerFormat), job.id]);
    return currentJob();
  }
  if (!job.current_package && !queue.length) {
    job = await refillJob(job);
    if (!job || !['queued','running'].includes(job.status)) return job;
    queueState = decodeJobQueue(job.queue_json);
    queue = queueState.items;
    installerFormat = queueState.installerFormat;
    if (!job.current_package && !queue.length) return job;
  }

  // If the Node process restarted while a package was being verified, retry
  // that persisted current_package instead of silently skipping it.
  const packageId = job.current_package || queue.shift();
  await db.query(
    "UPDATE import_jobs SET current_package=?,queue_json=?,phase='importing',last_error=NULL WHERE id=?",
    [packageId, encodeJobQueue(queue, installerFormat), job.id]
  );
  try {
    await recordHistory(packageId, 'reserved', null, job.id);
    await verifiedImport(packageId, { auto: true, jobId: job.id, installerFormat });
  } catch (err) {
    await db.query('UPDATE import_jobs SET last_error=? WHERE id=?', [String(err.message || err).slice(0, 2000), job.id]);
  } finally {
    await db.query('UPDATE import_jobs SET current_package=NULL WHERE id=?', [job.id]);
    await syncJobCounters(job.id);
  }
  return currentJob();
}

async function notifyCompletedJob(job) {
  if (!job || job.status !== 'complete' || !Number(job.requested_by || 0) || Number(job.completion_notified || 0)) return job;
  const db = getPool();
  const [mark] = await db.query('UPDATE import_jobs SET completion_notified=1 WHERE id=? AND completion_notified=0', [Number(job.id)]);
  if (!mark.affectedRows) return currentJob();
  const userId = Number(job.requested_by);
  const imported = Number(job.completed_count || 0);
  const failed = Number(job.failed_count || 0);
  const requested = Number(job.requested_count || 0);
  const details = { imported, failed, requested, phase: job.phase || null, installerFormat: job.installer_format || 'all' };
  await activity.record(userId, 'auto_import_completed', { details });
  await notifications.notifyUser(userId, {
    actorUserId: userId, type: failed ? 'warning' : 'success', title: 'Auto Import completed',
    message: `${imported.toLocaleString()} imported · ${failed.toLocaleString()} rejected/failed · target ${requested.toLocaleString()}.`,
    dedupeKey: `auto-import-complete-${Number(job.id)}`
  });
  const [[actor]] = await db.query('SELECT id,role FROM users WHERE id=? LIMIT 1', [userId]);
  if (actor?.role === 'partner') {
    await notifications.notifyAdmins({
      actorUserId: userId, type: failed ? 'warning' : 'info', title: 'Partner Auto Import completed',
      message: `${imported.toLocaleString()} imported · ${failed.toLocaleString()} rejected/failed.`,
      dedupeKey: `partner-auto-import-complete-${Number(job.id)}`
    }, { exceptUserId: userId });
  }
  return currentJob();
}

async function stepAutoImport() {
  const db = getPool();
  const conn = await db.getConnection();
  let locked = false;
  try {
    const [[row]] = await conn.query("SELECT GET_LOCK('hsware_bulk_import_v365',0) AS got");
    locked = Number(row?.got || 0) === 1;
    const job = locked ? await stepAutoImportUnlocked() : await currentJob();
    return await notifyCompletedJob(job);
  } finally {
    if (locked) {
      try { await conn.query("SELECT RELEASE_LOCK('hsware_bulk_import_v365')"); } catch {}
    }
    conn.release();
  }
}

function startImportWorker() {
  if (importWorkerStarted) return;
  importWorkerStarted = true;
  const timer = setInterval(async () => {
    if (importWorkerBusy || !state.dbReady) return;
    importWorkerBusy = true;
    try { await stepAutoImport(); }
    catch (err) { console.error('[HSWare] Bulk import worker:', err.message || err); }
    finally { importWorkerBusy = false; }
  }, 1500);
  if (timer.unref) timer.unref();
  console.log('[HSWare] Background bulk import worker started.');
}

async function searchCandidates(q) {
  const db = getPool();
  const needle = String(q || '').trim();
  if (!needle) return [];
  const lower = needle.toLowerCase();
  const out = [];
  const seen = new Set();
  const add = x => {
    const key = String(x.packageId || '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key); out.push(x);
  };

  const [managed] = await db.query(
    `SELECT id,package_id,name,publisher,category,published,workspace_added,current_version,enrichment_status
     FROM software WHERE name LIKE ? OR package_id LIKE ? OR publisher LIKE ? ORDER BY published DESC,name LIMIT 20`,
    [`%${needle}%`, `%${needle}%`, `%${needle}%`]
  );
  managed.forEach(r => add({
    packageId: r.package_id, name: r.name, publisher: r.publisher, category: r.category,
    managed: Boolean(r.workspace_added), managedSoftwareId: Number(r.id), published: Boolean(r.published),
    currentVersion: r.current_version, enrichmentStatus: r.enrichment_status
  }));

  starterPackages().filter(x => `${x.name} ${x.packageId} ${x.publisher} ${x.category || ''}`.toLowerCase().includes(lower)).slice(0, 20).forEach(x => add({ ...x, managed: false }));

  const [cached] = await db.query(
    `SELECT c.*,s.id software_id,s.workspace_added,s.published,s.current_version,s.enrichment_status
     FROM catalog_packages c LEFT JOIN software s ON s.package_id=c.package_id
     WHERE c.name LIKE ? OR c.package_id LIKE ? OR c.publisher LIKE ? OR c.search_aliases LIKE ?
     ORDER BY COALESCE(c.demand_rank,c.discovery_rank,999999),c.name LIMIT 20`,
    [`%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`]
  );
  cached.forEach(r => add({
    packageId: r.package_id, name: r.name, publisher: r.publisher, category: r.category,
    managed: Boolean(r.workspace_added), managedSoftwareId: r.software_id ? Number(r.software_id) : null,
    published: Boolean(r.published), currentVersion: r.current_version, enrichmentStatus: r.enrichment_status,
    sourcePath: r.source_path || null
  }));

  if (needle.includes('.') && !seen.has(lower)) {
    add({ packageId: needle, name: titleizePackageId(needle), publisher: needle.split('.')[0] || null, category: null, managed: false });
  }
  return out.slice(0, 30);
}

module.exports = {
  MAX_AUTO_TARGET,
  currentJob,
  startAutoImport,
  stopAutoImport,
  stepAutoImport,
  startImportWorker,
  verifiedImport,
  searchCandidates,
  starterPackages
};
