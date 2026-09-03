const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const state = require('../state');
const reliability = require('./reliability');
const { getPool } = require('../db');
const activity = require('./activity');
const notifications = require('./notifications');
const googleDrive = require('./google-drive-backups');
const { APP_VERSION } = require('../app-version');

const BACKUP_DIR = path.join(process.cwd(), 'backups');
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const DRIVE_RETRY_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_RETENTION = 30;
const MANUAL_RETENTION = 20;
const BACKUP_FORMAT_VERSION = 3;
let workerStarted = false;
let running = false;
let restoring = false;
let driveRetryRunning = false;
let lastDriveRetryAt = 0;

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function safeFilename(kind = 'manual', scope = 'published-software-only') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = scope === 'workspace-full' ? 'workspace-full' : 'published';
  return `hsware-${kind}-${label}-backup-${stamp}.json`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function createBackup(kind = 'manual') {
  if (running) throw new Error('A backup is already being created.');
  running = true;
  try {
    ensureDir();
    const db = getPool();
    const [[schema]] = await db.query('SELECT MAX(version) AS version FROM schema_migrations');
    const fullWorkspace = kind === 'safety';
    const scope = fullWorkspace ? 'workspace-full' : 'published-software-only';
    const softwareWhere = fullWorkspace ? 'workspace_added=1' : 'workspace_added=1 AND published=1';

    // Manual/automatic backups stay intentionally scoped to the published
    // library. The pre-restore safety backup is different: it captures the
    // complete workspace so unpublished/in-progress software can never be
    // silently discarded by a restore.
    const [software] = await db.query(
      `SELECT * FROM software WHERE ${softwareWhere} ORDER BY id`
    );
    const [softwareVersions] = software.length
      ? await db.query(
          `SELECT v.* FROM software_versions v
           JOIN software s ON s.id=v.software_id
           WHERE ${softwareWhere.replace(/workspace_added/g, 's.workspace_added').replace(/published/g, 's.published')}
           ORDER BY v.software_id,v.id`
        )
      : [[]];
    const [importHistory] = software.length
      ? await db.query(
          `SELECT DISTINCT h.* FROM software_import_history h
           JOIN software s ON s.package_id=h.package_id
           WHERE ${softwareWhere.replace(/workspace_added/g, 's.workspace_added').replace(/published/g, 's.published')}
           ORDER BY h.package_id`
        )
      : [[]];

    const data = {
      software,
      software_versions: softwareVersions,
      software_import_history: importHistory
    };
    const dataJson = JSON.stringify(data);
    const createdAt = new Date().toISOString();
    const payload = {
      backup_format: 'hsware-json-backup',
      backup_version: BACKUP_FORMAT_VERSION,
      app_version: APP_VERSION,
      schema_version: Number(schema?.version || 0),
      created_at: createdAt,
      kind,
      scope,
      snapshot: {
        software: software.length,
        published_software: software.filter(item => Number(item.published || 0) === 1).length,
        unpublished_software: software.filter(item => Number(item.published || 0) !== 1).length,
        historical_versions: softwareVersions.length,
        current_versions: software.filter(item => item.current_version).length
      },
      integrity: {
        algorithm: 'sha256',
        data_sha256: sha256(dataJson)
      },
      data
    };

    const filename = safeFilename(kind, scope);
    const filepath = path.join(BACKUP_DIR, filename);
    const json = JSON.stringify(payload, null, 2);
    fs.writeFileSync(filepath, json, 'utf8');
    const size = Buffer.byteLength(json);
    const fileHash = sha256(json);
    const [result] = await db.query(
      `INSERT INTO backup_history
       (backup_kind,filename,file_size_bytes,software_count,version_count,integrity_sha256,drive_status)
       VALUES (?,?,?,?,?,?,?)`,
      [kind, filename, size, software.length, softwareVersions.length, fileHash, 'pending']
    );
    const id = Number(result.insertId);

    let drive = { status: 'not_connected', error: null, fileId: null };
    try {
      const driveState = await googleDrive.state();
      if (driveState.connected) drive = await uploadBackupToDrive(id);
      else await db.query("UPDATE backup_history SET drive_status='not_connected',drive_error=NULL WHERE id=?", [id]);
    } catch (err) {
      const message = String(err?.message || err).slice(0, 1000);
      await db.query("UPDATE backup_history SET drive_status='error',drive_error=? WHERE id=?", [message, id]);
      drive = { status: 'error', error: message, fileId: null };
    }

    await pruneBackups(kind);
    return {
      id, kind, scope, filename, fileSizeBytes: size, createdAt,
      softwareCount: software.length,
      versionCount: softwareVersions.length,
      integritySha256: fileHash,
      drive
    };
  } finally {
    running = false;
  }
}

async function pruneBackups(kind) {
  const db = getPool();
  const limit = kind === 'auto' ? AUTO_RETENTION : kind === 'manual' ? MANUAL_RETENTION : 5;
  const [rows] = await db.query(
    'SELECT id,filename FROM backup_history WHERE backup_kind=? ORDER BY created_at DESC,id DESC',
    [kind]
  );
  for (const row of rows.slice(limit)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, path.basename(row.filename))); } catch {}
    // Cloud copies are intentionally not deleted when local retention expires.
    await db.query('DELETE FROM backup_history WHERE id=?', [row.id]);
  }
}

function backupRowJson(row) {
  if (!row) return null;
  const filepath = path.join(BACKUP_DIR, path.basename(row.filename));
  return {
    id: Number(row.id),
    kind: row.backup_kind,
    filename: row.filename,
    fileSizeBytes: Number(row.file_size_bytes || 0),
    createdAt: row.created_at,
    downloadedAt: row.downloaded_at,
    exists: fs.existsSync(filepath),
    softwareCount: Number(row.software_count || 0),
    versionCount: Number(row.version_count || 0),
    integritySha256: row.integrity_sha256 || null,
    driveStatus: row.drive_status || 'not_connected',
    driveFileId: row.drive_file_id || null,
    driveUploadedAt: row.drive_uploaded_at || null,
    driveError: row.drive_error || null
  };
}

async function latest(kind = null) {
  const db = getPool();
  const where = kind ? 'WHERE backup_kind=?' : '';
  const params = kind ? [kind] : [];
  const [[row]] = await db.query(
    `SELECT * FROM backup_history ${where} ORDER BY created_at DESC,id DESC LIMIT 1`,
    params
  );
  return backupRowJson(row);
}

async function recent(limit = 8) {
  const [rows] = await getPool().query(
    'SELECT * FROM backup_history ORDER BY created_at DESC,id DESC LIMIT ?',
    [Math.max(1, Math.min(20, Number(limit || 8)))]
  );
  return rows.map(backupRowJson);
}

async function stateJson() {
  const last = await latest();
  const lastAuto = await latest('auto');
  const drive = await googleDrive.state();
  return {
    last,
    lastAuto,
    recent: await recent(8),
    unreadAutomatic: Boolean(lastAuto && lastAuto.exists && !lastAuto.downloadedAt),
    automaticEveryHours: 24,
    format: 'json',
    backupVersion: BACKUP_FORMAT_VERSION,
    scope: 'published-software-only',
    googleDrive: drive
  };
}

async function getBackupFile(id) {
  const db = getPool();
  const [[row]] = await db.query('SELECT * FROM backup_history WHERE id=? LIMIT 1', [id]);
  if (!row) return null;
  const filename = path.basename(row.filename);
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  return { row, filename, filepath };
}

async function markDownloaded(id) {
  await getPool().query('UPDATE backup_history SET downloaded_at=NOW() WHERE id=?', [id]);
}

function validateBackup(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid backup file.');
  if (payload.backup_format !== 'hsware-json-backup') throw new Error('This is not an HSWare JSON backup.');
  const version = Number(payload.backup_version || 0);
  if (![1, 2, BACKUP_FORMAT_VERSION].includes(version)) throw new Error('Unsupported HSWare backup version.');
  if (!payload.data || !Array.isArray(payload.data.software) || !Array.isArray(payload.data.software_versions)) {
    throw new Error('The backup is incomplete or damaged.');
  }
  if (version >= 2) {
    if (version === 2 && payload.scope !== 'published-software-only') throw new Error('This HSWare Backup V2 file has an invalid scope.');
    if (version >= 3 && !['published-software-only','workspace-full'].includes(payload.scope)) throw new Error('This HSWare Backup V3 file has an invalid scope.');
    const expected = String(payload.integrity?.data_sha256 || '');
    const actual = sha256(JSON.stringify(payload.data));
    if (!expected || expected !== actual) throw new Error('Backup integrity verification failed. The JSON may be incomplete or modified.');
  }
  return payload;
}

function normalizeDbValue(value, type = '') {
  if (value == null) return value;
  const t = String(type).toLowerCase();
  if ((t.includes('datetime') || t.includes('timestamp')) && typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0,19).replace('T',' ');
  }
  if (t.startsWith('date') && typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return value;
}

async function insertRows(db, table, rows) {
  if (!rows.length) return;
  const [colsRaw] = await db.query(`SHOW COLUMNS FROM \`${table}\``);
  const meta = new Map(colsRaw.map(c => [c.Field, c.Type]));
  for (const row of rows) {
    const columns = Object.keys(row).filter(k => meta.has(k));
    if (!columns.length) continue;
    const placeholders = columns.map(() => '?').join(',');
    const sql = `INSERT INTO \`${table}\` (${columns.map(c => `\`${c}\``).join(',')}) VALUES (${placeholders})`;
    await db.query(sql, columns.map(c => normalizeDbValue(row[c], meta.get(c))));
  }
}

async function restoreBackup(payload) {
  validateBackup(payload);
  if (restoring) throw new Error('A restore is already in progress.');
  const db = getPool();
  const safety = await createBackup('safety');
  restoring = true;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SET FOREIGN_KEY_CHECKS=0');
    await conn.query('UPDATE catalog_packages SET managed_software_id=NULL');
    if (await tableExists(conn, 'enrichment_queue')) await conn.query('DELETE FROM enrichment_queue');
    await conn.query('DELETE FROM software_versions');
    await conn.query('DELETE FROM software_import_history');
    await conn.query('DELETE FROM software');
    await insertRows(conn, 'software', payload.data.software || []);
    await insertRows(conn, 'software_versions', payload.data.software_versions || []);
    await insertRows(conn, 'software_import_history', payload.data.software_import_history || []);
    await conn.query(`UPDATE catalog_packages c JOIN software s ON s.package_id=c.package_id SET c.managed_software_id=s.id`);
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
    await conn.commit();
    return {
      restoredSoftware: (payload.data.software || []).length,
      restoredVersions: (payload.data.software_versions || []).length,
      safetyBackup: safety
    };
  } catch (err) {
    try { await conn.query('SET FOREIGN_KEY_CHECKS=1'); } catch {}
    try { await conn.rollback(); } catch {}
    throw err;
  } finally {
    conn.release();
    restoring = false;
  }
}

async function tableExists(db, table) {
  const [rows] = await db.query('SHOW TABLES LIKE ?', [table]);
  return rows.length > 0;
}

async function uploadBackupToDrive(id) {
  const db = getPool();
  const item = await getBackupFile(Number(id));
  if (!item) throw new Error('Backup JSON file not found for Google Drive upload.');
  await db.query("UPDATE backup_history SET drive_status='uploading',drive_error=NULL WHERE id=?", [id]);
  try {
    const uploaded = await googleDrive.uploadJson(item.filepath, item.filename);
    await db.query(
      `UPDATE backup_history SET drive_status='uploaded',drive_file_id=?,drive_uploaded_at=NOW(),drive_error=NULL WHERE id=?`,
      [uploaded.fileId, id]
    );
    return { status: 'uploaded', error: null, fileId: uploaded.fileId, folderId: uploaded.folderId };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 1000);
    await db.query("UPDATE backup_history SET drive_status='error',drive_error=? WHERE id=?", [message, id]);
    throw err;
  }
}

async function retryPendingDriveBackups() {
  if (driveRetryRunning || Date.now() - lastDriveRetryAt < DRIVE_RETRY_INTERVAL_MS) return;
  const driveState = await googleDrive.state();
  if (!driveState.connected) return;
  driveRetryRunning = true;
  lastDriveRetryAt = Date.now();
  try {
    const [rows] = await getPool().query(
      `SELECT id FROM backup_history
       WHERE drive_status IN ('pending','error')
       ORDER BY created_at DESC,id DESC LIMIT 3`
    );
    for (const row of rows) {
      try { await uploadBackupToDrive(Number(row.id)); } catch {}
    }
  } finally {
    driveRetryRunning = false;
  }
}

async function autoTick() {
  if (!state.dbReady || running || restoring) return;
  try {
    const lastAuto = await latest('auto');
    const age = lastAuto?.createdAt ? Date.now() - new Date(lastAuto.createdAt).getTime() : Infinity;
    if (!lastAuto || !Number.isFinite(age) || age >= AUTO_INTERVAL_MS) {
      const result = await createBackup('auto');
      await activity.record(null,'backup_created',{details:{kind:'auto',filename:result.filename,fileSizeBytes:result.fileSizeBytes,softwareCount:result.softwareCount,versionCount:result.versionCount,driveStatus:result.drive?.status}});
      const cloudText = result.drive?.status === 'uploaded' ? ' Google Drive upload completed.' : result.drive?.status === 'error' ? ' Local backup is safe; Google Drive upload will retry automatically.' : '';
      await notifications.notifyAdmins({type:'success',title:'Automatic backup completed',message:`${result.filename} is ready.${cloudText}`,dedupeKey:`auto-backup-${result.id}`});
      console.log(`[HSWare] Automatic published-software JSON backup created: ${result.filename}`);
    }
    await retryPendingDriveBackups();
  } catch (err) {
    console.error('[HSWare] Automatic backup failed:', err?.message || err);
    try {
      await activity.record(null, 'backup_failed', { details: { kind: 'auto', error: String(err?.message || err).slice(0, 500) } });
      await notifications.notifyAdmins({
        type: 'error',
        title: 'Automatic backup failed',
        message: String(err?.message || err).slice(0, 500),
        dedupeKey: `auto-backup-failed-${new Date().toISOString().slice(0, 10)}`
      });
    } catch {}
    throw err;
  }
}

function startBackupWorker() {
  if (workerStarted) return;
  workerStarted = true;
  const run=()=>reliability.runWorkerTick('backups',autoTick,{baseDelayMs:60_000,maxDelayMs:30*60*1000}).catch(()=>{});
  const first = setTimeout(run, 8000);
  if (first.unref) first.unref();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  createBackup,
  restoreBackup,
  validateBackup,
  state: stateJson,
  latest,
  recent,
  getBackupFile,
  markDownloaded,
  uploadBackupToDrive,
  startBackupWorker,
  googleDrive,
  BACKUP_DIR
};
