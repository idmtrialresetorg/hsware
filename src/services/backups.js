const fs = require('fs');
const path = require('path');
const state = require('../state');
const { getPool } = require('../db');
const activity = require('./activity');
const notifications = require('./notifications');

const BACKUP_DIR = path.join(process.cwd(), 'backups');
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const AUTO_RETENTION = 30;
const MANUAL_RETENTION = 20;
const BACKUP_FORMAT_VERSION = 1;
const APP_VERSION = '4.6.0';
let workerStarted = false;
let running = false;
let restoring = false;

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function safeFilename(kind = 'manual') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `hsware-${kind}-backup-${stamp}.json`;
}

async function tableRows(db, table) {
  const [rows] = await db.query(`SELECT * FROM \`${table}\``);
  return rows;
}

async function createBackup(kind = 'manual') {
  if (running) throw new Error('A backup is already being created.');
  running = true;
  try {
    ensureDir();
    const db = getPool();
    const [[schema]] = await db.query('SELECT MAX(version) AS version FROM schema_migrations');
    const [software] = await db.query('SELECT * FROM software WHERE workspace_added=1 ORDER BY id');
    const [softwareVersions] = software.length
      ? await db.query('SELECT v.* FROM software_versions v JOIN software s ON s.id=v.software_id WHERE s.workspace_added=1 ORDER BY v.id')
      : [[]];
    const data = {
      software,
      software_versions: softwareVersions,
      software_import_history: await tableRows(db, 'software_import_history')
    };
    const payload = {
      backup_format: 'hsware-json-backup',
      backup_version: BACKUP_FORMAT_VERSION,
      app_version: APP_VERSION,
      schema_version: Number(schema?.version || 0),
      created_at: new Date().toISOString(),
      kind,
      data
    };
    const filename = safeFilename(kind);
    const filepath = path.join(BACKUP_DIR, filename);
    const json = JSON.stringify(payload, null, 2);
    fs.writeFileSync(filepath, json, 'utf8');
    const size = Buffer.byteLength(json);
    const [result] = await db.query(
      'INSERT INTO backup_history (backup_kind,filename,file_size_bytes) VALUES (?,?,?)',
      [kind, filename, size]
    );
    await pruneBackups(kind);
    return { id: Number(result.insertId), kind, filename, fileSizeBytes: size, createdAt: payload.created_at };
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
    await db.query('DELETE FROM backup_history WHERE id=?', [row.id]);
  }
}

async function latest(kind = null) {
  const db = getPool();
  const where = kind ? 'WHERE backup_kind=?' : '';
  const params = kind ? [kind] : [];
  const [[row]] = await db.query(
    `SELECT id,backup_kind,filename,file_size_bytes,created_at,downloaded_at FROM backup_history ${where} ORDER BY created_at DESC,id DESC LIMIT 1`,
    params
  );
  if (!row) return null;
  const filepath = path.join(BACKUP_DIR, path.basename(row.filename));
  const exists = fs.existsSync(filepath);
  return {
    id: Number(row.id), kind: row.backup_kind, filename: row.filename,
    fileSizeBytes: Number(row.file_size_bytes || 0), createdAt: row.created_at,
    downloadedAt: row.downloaded_at, exists
  };
}

async function stateJson() {
  const last = await latest();
  const lastAuto = await latest('auto');
  return {
    last,
    lastAuto,
    unreadAutomatic: Boolean(lastAuto && lastAuto.exists && !lastAuto.downloadedAt),
    automaticEveryHours: 24,
    format: 'json'
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
  if (Number(payload.backup_version) !== BACKUP_FORMAT_VERSION) throw new Error('Unsupported HSWare backup version.');
  if (!payload.data || !Array.isArray(payload.data.software) || !Array.isArray(payload.data.software_versions)) {
    throw new Error('The backup is incomplete or damaged.');
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

async function autoTick() {
  if (!state.dbReady || running || restoring) return;
  try {
    const lastAuto = await latest('auto');
    const age = lastAuto?.createdAt ? Date.now() - new Date(lastAuto.createdAt).getTime() : Infinity;
    if (!lastAuto || !Number.isFinite(age) || age >= AUTO_INTERVAL_MS) {
      const result = await createBackup('auto');
      await activity.record(null,'backup_created',{details:{kind:'auto',filename:result.filename,fileSizeBytes:result.fileSizeBytes}});
      await notifications.notifyAdmins({type:'success',title:'Automatic backup completed',message:`${result.filename} is ready to download.`,dedupeKey:`auto-backup-${result.id}`});
      console.log(`[HSWare] Automatic JSON backup created: ${result.filename}`);
    }
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
  }
}

function startBackupWorker() {
  if (workerStarted) return;
  workerStarted = true;
  const first = setTimeout(autoTick, 8000);
  if (first.unref) first.unref();
  const timer = setInterval(autoTick, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  createBackup,
  restoreBackup,
  validateBackup,
  state: stateJson,
  latest,
  getBackupFile,
  markDownloaded,
  startBackupWorker,
  BACKUP_DIR
};
