const crypto = require('crypto');
const path = require('path');
const { getPool } = require('../db');
const cf = require('../cloudflare-bindings');
const { APP_VERSION } = require('../app-version');

const BACKUP_DIR = 'R2:BACKUPS/hsware-backups';
const AUTO_RETENTION = 30;
const MANUAL_RETENTION = 20;
const BACKUP_FORMAT_VERSION = 3;
let running = false;
let restoring = false;

function bucket(){ const b=cf.r2(); if(!b) throw new Error('Cloudflare R2 binding BACKUPS is not configured.'); return b; }
function keyFor(filename){ return `hsware-backups/${path.basename(filename)}`; }
function sha256(value){ return crypto.createHash('sha256').update(value).digest('hex'); }
function safeFilename(kind='manual',scope='published-software-only'){
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  return `hsware-${kind}-${scope==='workspace-full'?'workspace-full':'published'}-backup-${stamp}.json`;
}
async function createBackup(kind='manual'){
  if(running)throw new Error('A backup is already being created.'); running=true;
  try{
    const db=getPool(); const [[schema]]=await db.query('SELECT MAX(version) AS version FROM schema_migrations');
    const full=kind==='safety',scope=full?'workspace-full':'published-software-only';
    const where=full?'workspace_added=1':'workspace_added=1 AND published=1';
    const [software]=await db.query(`SELECT * FROM software WHERE ${where} ORDER BY id`);
    const [versions]=software.length?await db.query(`SELECT v.* FROM software_versions v JOIN software s ON s.id=v.software_id WHERE ${where.replace(/workspace_added/g,'s.workspace_added').replace(/published/g,'s.published')} ORDER BY v.software_id,v.id`):[[]];
    const [history]=software.length?await db.query(`SELECT DISTINCT h.* FROM software_import_history h JOIN software s ON s.package_id=h.package_id WHERE ${where.replace(/workspace_added/g,'s.workspace_added').replace(/published/g,'s.published')} ORDER BY h.package_id`):[[]];
    const data={software,software_versions:versions,software_import_history:history};
    const payload={backup_format:'hsware-json-backup',backup_version:BACKUP_FORMAT_VERSION,app_version:APP_VERSION,schema_version:Number(schema?.version||0),created_at:new Date().toISOString(),kind,scope,snapshot:{software:software.length,published_software:software.filter(x=>Number(x.published||0)===1).length,unpublished_software:software.filter(x=>Number(x.published||0)!==1).length,historical_versions:versions.length,current_versions:software.filter(x=>x.current_version).length},integrity:{algorithm:'sha256',data_sha256:sha256(JSON.stringify(data))},data};
    const filename=safeFilename(kind,scope),json=JSON.stringify(payload,null,2),size=Buffer.byteLength(json),fileHash=sha256(json);
    await bucket().put(keyFor(filename),json,{httpMetadata:{contentType:'application/json'},customMetadata:{kind,scope,sha256:fileHash}});
    const [result]=await db.query(`INSERT INTO backup_history (backup_kind,filename,file_size_bytes,software_count,version_count,integrity_sha256,drive_status) VALUES (?,?,?,?,?,?,?)`,[kind,filename,size,software.length,versions.length,fileHash,'r2']);
    await pruneBackups(kind);
    return {id:Number(result.insertId),kind,scope,filename,fileSizeBytes:size,createdAt:payload.created_at,softwareCount:software.length,versionCount:versions.length,integritySha256:fileHash,drive:{status:'r2',error:null,fileId:keyFor(filename)}};
  }finally{running=false}
}
async function pruneBackups(kind){
  const db=getPool(),limit=kind==='auto'?AUTO_RETENTION:kind==='manual'?MANUAL_RETENTION:5;
  const [rows]=await db.query('SELECT id,filename FROM backup_history WHERE backup_kind=? ORDER BY created_at DESC,id DESC',[kind]);
  for(const row of rows.slice(limit)){try{await bucket().delete(keyFor(row.filename))}catch{} await db.query('DELETE FROM backup_history WHERE id=?',[row.id]);}
}
async function objectExists(filename){try{return Boolean(await bucket().head(keyFor(filename)))}catch{return false}}
async function backupRowJson(row){if(!row)return null;return {id:Number(row.id),kind:row.backup_kind,filename:row.filename,fileSizeBytes:Number(row.file_size_bytes||0),createdAt:row.created_at,downloadedAt:row.downloaded_at,exists:await objectExists(row.filename),softwareCount:Number(row.software_count||0),versionCount:Number(row.version_count||0),integritySha256:row.integrity_sha256||null,driveStatus:'r2',driveFileId:keyFor(row.filename),driveUploadedAt:row.created_at,driveError:null}}
async function latest(kind=null){const db=getPool(),where=kind?'WHERE backup_kind=?':'',params=kind?[kind]:[];const [[row]]=await db.query(`SELECT * FROM backup_history ${where} ORDER BY created_at DESC,id DESC LIMIT 1`,params);return backupRowJson(row)}
async function recent(limit=8){const [rows]=await getPool().query('SELECT * FROM backup_history ORDER BY created_at DESC,id DESC LIMIT ?',[Math.max(1,Math.min(20,Number(limit||8)))]);return Promise.all(rows.map(backupRowJson))}
async function stateJson(){const last=await latest(),lastAuto=await latest('auto');return {last,lastAuto,recent:await recent(8),unreadAutomatic:Boolean(lastAuto&&lastAuto.exists&&!lastAuto.downloadedAt),automaticEveryHours:24,format:'json',backupVersion:BACKUP_FORMAT_VERSION,scope:'published-software-only',storage:{provider:'cloudflare-r2',binding:'BACKUPS'},googleDrive:{connected:false,status:'replaced-by-r2'}}}
async function getBackupFile(id){const [[row]]=await getPool().query('SELECT * FROM backup_history WHERE id=? LIMIT 1',[id]);if(!row)return null;const filename=path.basename(row.filename),obj=await bucket().get(keyFor(filename));if(!obj)return null;const buffer=Buffer.from(await obj.arrayBuffer());return {row,filename,buffer,filepath:null}}
async function markDownloaded(id){await getPool().query('UPDATE backup_history SET downloaded_at=NOW() WHERE id=?',[id])}
function validateBackup(payload){if(!payload||typeof payload!=='object'||payload.backup_format!=='hsware-json-backup')throw new Error('This is not an HSWare JSON backup.');const version=Number(payload.backup_version||0);if(![1,2,BACKUP_FORMAT_VERSION].includes(version))throw new Error('Unsupported HSWare backup version.');if(!payload.data||!Array.isArray(payload.data.software)||!Array.isArray(payload.data.software_versions))throw new Error('The backup is incomplete or damaged.');if(version>=2){const expected=String(payload.integrity?.data_sha256||''),actual=sha256(JSON.stringify(payload.data));if(!expected||expected!==actual)throw new Error('Backup integrity verification failed.')}return payload}
function normalizeDbValue(value,type=''){if(value==null)return value;const t=String(type).toLowerCase();if((t.includes('datetime')||t.includes('timestamp'))&&typeof value==='string'){const d=new Date(value);if(!Number.isNaN(d.getTime()))return d.toISOString().slice(0,19).replace('T',' ')}if(t.startsWith('date')&&typeof value==='string'){const m=value.match(/^(\d{4}-\d{2}-\d{2})/);if(m)return m[1]}return value}
async function tableExists(db,table){const [rows]=await db.query('SHOW TABLES LIKE ?',[table]);return rows.length>0}
async function insertRows(db,table,rows){if(!rows.length)return;const [colsRaw]=await db.query(`SHOW COLUMNS FROM \`${table}\``);const meta=new Map(colsRaw.map(c=>[c.Field,c.Type]));for(const row of rows){const columns=Object.keys(row).filter(k=>meta.has(k));if(!columns.length)continue;const placeholders=columns.map(()=>'?').join(',');await db.query(`INSERT INTO \`${table}\` (${columns.map(c=>`\`${c}\``).join(',')}) VALUES (${placeholders})`,columns.map(c=>normalizeDbValue(row[c],meta.get(c))))}}
async function restoreBackup(payload){validateBackup(payload);if(restoring)throw new Error('A restore is already in progress.');const db=getPool(),safety=await createBackup('safety');restoring=true;const conn=await db.getConnection();try{await conn.beginTransaction();await conn.query('SET FOREIGN_KEY_CHECKS=0');await conn.query('UPDATE catalog_packages SET managed_software_id=NULL');if(await tableExists(conn,'enrichment_queue'))await conn.query('DELETE FROM enrichment_queue');await conn.query('DELETE FROM software_versions');await conn.query('DELETE FROM software_import_history');await conn.query('DELETE FROM software');await insertRows(conn,'software',payload.data.software||[]);await insertRows(conn,'software_versions',payload.data.software_versions||[]);await insertRows(conn,'software_import_history',payload.data.software_import_history||[]);await conn.query('UPDATE catalog_packages c JOIN software s ON s.package_id=c.package_id SET c.managed_software_id=s.id');await conn.query('SET FOREIGN_KEY_CHECKS=1');await conn.commit();return {restoredSoftware:(payload.data.software||[]).length,restoredVersions:(payload.data.software_versions||[]).length,safetyBackup:safety}}catch(err){try{await conn.query('SET FOREIGN_KEY_CHECKS=1')}catch{}try{await conn.rollback()}catch{}throw err}finally{conn.release();restoring=false}}
async function uploadBackupToDrive(){throw new Error('Google Drive backup upload is replaced by Cloudflare R2 in the Cloudflare Edition.')}
const googleDrive={async state(){return {connected:false,status:'replaced-by-r2'}},async authorizationUrl(){throw new Error('Google Drive backup integration is replaced by Cloudflare R2 in the Cloudflare Edition.')},async handleCallback(){throw new Error('Google Drive backup integration is unavailable in the Cloudflare Edition.')},async disconnect(){return {connected:false,status:'replaced-by-r2'}}};
function startBackupWorker(){/* no timers on Workers; Cron owns maintenance */}
module.exports={createBackup,restoreBackup,validateBackup,state:stateJson,latest,recent,getBackupFile,markDownloaded,uploadBackupToDrive,startBackupWorker,googleDrive,BACKUP_DIR};
