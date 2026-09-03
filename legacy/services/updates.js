const { getPool } = require('../db');
const { fetchPackageDetails, fetchPackageVersionUpdateMetadata } = require('./winget');
const { probeRemoteFileMetadata } = require('./remote');
const { compareVersions } = require('../utils/version');
const activity = require('./activity');
const notifications = require('./notifications');
const enrichment = require('./enrichment');
const config = require('../config');
const stateRuntime = require('../state');
const reliability = require('./reliability');

const KEY='managed-software';

async function state(){
  const [r]=await getPool().query('SELECT * FROM update_scan_state WHERE scan_key=? LIMIT 1',[KEY]);
  return r[0]||{scan_key:KEY,status:'idle',queue_json:'[]',total_count:0,processed_count:0,update_count:0,failed_count:0,requested_by:null,completion_notified:0};
}

async function start(requestedBy=null,scope='published'){
  const db=getPool();
  // LightWave is intentionally published-only. Catalog records are never queued.
  const [rows]=await db.query(`SELECT id FROM software WHERE workspace_added=1 AND published=1 ORDER BY id`);
  const queue=rows.map(r=>r.id);
  await db.query(`INSERT INTO update_scan_state (scan_key,requested_by,completion_notified,status,queue_json,total_count,processed_count,update_count,failed_count,current_software_id,last_error)
    VALUES (?,?,0,'running',?,?,0,0,0,NULL,NULL)
    ON DUPLICATE KEY UPDATE requested_by=VALUES(requested_by),completion_notified=0,status='running',queue_json=VALUES(queue_json),total_count=VALUES(total_count),processed_count=0,update_count=0,failed_count=0,current_software_id=NULL,last_error=NULL`,
    [KEY,requestedBy?Number(requestedBy):null,JSON.stringify(queue),queue.length]);
  if(requestedBy)await activity.record(Number(requestedBy),'update_scan_started',{details:{total:queue.length,scope:'published',engine:'lightwave'}});
  return state();
}

async function notifyCompletedScan(st){
  if(!st||st.status!=='complete'||!Number(st.requested_by||0)||Number(st.completion_notified||0))return st;
  const db=getPool();
  const [mark]=await db.query('UPDATE update_scan_state SET completion_notified=1 WHERE scan_key=? AND completion_notified=0',[KEY]);
  if(!mark.affectedRows)return state();
  const userId=Number(st.requested_by),found=Number(st.update_count||0),failed=Number(st.failed_count||0),checked=Number(st.processed_count||0);
  await activity.record(userId,'update_scan_completed',{details:{checked,updates:found,failed,engine:'lightwave'}});
  await notifications.notifyUser(userId,{actorUserId:userId,type:failed?'warning':found?'info':'success',title:'LightWave update check completed',message:`${checked.toLocaleString()} published checked · ${found.toLocaleString()} update(s) found · ${failed.toLocaleString()} failed.`,dedupeKey:`lightwave-complete-${new Date(st.updated_at||Date.now()).getTime()}`});
  return state();
}

async function resolveLatestUpdateMetadata(sw){
  const latest=await fetchPackageDetails(sw.package_id,sw.source_path,{includeOldVersions:false,probeSize:false,recoverPath:true});
  const available=Boolean(latest.version&&(!sw.current_version||compareVersions(latest.version,sw.current_version)>0));
  // LightWave stage one avoids CDN probing for unchanged software. Deep metadata
  // is fetched only when a newer version is actually detected.
  let fileSizeBytes=latest.fileSizeBytes==null?null:Number(latest.fileSizeBytes),releaseDate=latest.releaseDate||null;
  const installerUrl=latest.installerUrl||sw.latest_installer_url||null;
  if(available&&installerUrl&&(!fileSizeBytes||!releaseDate)){
    try{const remote=await probeRemoteFileMetadata(installerUrl);if(!fileSizeBytes&&remote?.sizeBytes)fileSizeBytes=Number(remote.sizeBytes);if(!releaseDate&&remote?.lastModified)releaseDate=remote.lastModified}catch{}
  }
  return {version:latest.version||sw.latest_version||null,installerUrl,sha256:latest.sha256||sw.latest_sha256||null,fileSizeBytes:fileSizeBytes||(sw.latest_file_size_bytes==null?null:Number(sw.latest_file_size_bytes)),releaseDate:releaseDate||sw.latest_release_date||null,available};
}
function versionIsNewer(version,current){if(!version)return false;if(!current)return true;try{return compareVersions(version,current)>0}catch{return false}}
function sameVersion(a,b){if(!a||!b)return false;try{return compareVersions(a,b)===0}catch{return String(a)===String(b)}}
function versionAtLeast(a,b){if(!a)return false;if(!b)return true;try{return compareVersions(a,b)>=0}catch{return String(a)===String(b)}}
async function resolvePendingUpdateMetadata(sw){
  const pendingWasDetected=Boolean(sw.update_available),storedVersion=sw.latest_version||null,storedUrl=sw.latest_installer_url||null,storedSha=sw.latest_sha256||null,storedSize=sw.latest_file_size_bytes==null?null:Number(sw.latest_file_size_bytes),storedDate=sw.latest_release_date||null;
  let exact=null;if(storedVersion){try{exact=await fetchPackageVersionUpdateMetadata(sw.package_id,storedVersion)}catch{}}
  let newest=null;try{newest=await fetchPackageDetails(sw.package_id,sw.source_path,{includeOldVersions:false,probeSize:false,recoverPath:true})}catch{}
  const newestIsUpdate=versionIsNewer(newest?.version,sw.current_version),useNewest=newestIsUpdate&&versionAtLeast(newest?.version,storedVersion),exactMatches=exact?.version&&(!storedVersion||sameVersion(exact.version,storedVersion));
  let version=useNewest?(newest.version||storedVersion):(exactMatches?(exact.version||storedVersion):storedVersion),installerUrl=useNewest?(newest.installerUrl||storedUrl):(exactMatches?(exact.installerUrl||storedUrl):storedUrl),sha256=useNewest?(newest.sha256||storedSha):(exactMatches?(exact.sha256||storedSha):storedSha),fileSizeBytes=useNewest?(newest.fileSizeBytes||storedSize):(exactMatches?(exact.fileSizeBytes||storedSize):storedSize),releaseDate=useNewest?(newest.releaseDate||storedDate):(exactMatches?(exact.releaseDate||storedDate):storedDate);
  if(installerUrl&&(!fileSizeBytes||!releaseDate)){try{const remote=await probeRemoteFileMetadata(installerUrl);if(!fileSizeBytes&&remote?.sizeBytes)fileSizeBytes=Number(remote.sizeBytes);if(!releaseDate&&remote?.lastModified)releaseDate=remote.lastModified}catch{}}
  return {version,installerUrl,sha256,fileSizeBytes:fileSizeBytes||null,releaseDate:releaseDate||null,available:pendingWasDetected||versionIsNewer(version,sw.current_version)||newestIsUpdate};
}
async function persistLatestUpdateMetadata(id,sw){const db=getPool();const meta=sw.update_available?await resolvePendingUpdateMetadata(sw):await resolveLatestUpdateMetadata(sw);await db.query(`UPDATE software SET latest_version=?,latest_installer_url=?,latest_sha256=?,latest_file_size_bytes=?,latest_release_date=?,update_available=?,last_checked_at=NOW(),update_error=NULL WHERE id=?`,[meta.version,meta.installerUrl,meta.sha256,meta.fileSizeBytes,meta.releaseDate,meta.available?1:0,id]);return meta}
async function refreshOne(id){const db=getPool();const [[sw]]=await db.query('SELECT * FROM software WHERE id=? LIMIT 1',[Number(id)]);if(!sw)throw new Error('Software not found.');try{return await persistLatestUpdateMetadata(Number(id),sw)}catch(err){await db.query('UPDATE software SET last_checked_at=NOW(),update_error=? WHERE id=?',[String(err.message||err).slice(0,2000),Number(id)]);throw err}}

async function processOne(id){
  const db=getPool();
  try{const [[sw]]=await db.query('SELECT * FROM software WHERE id=? AND workspace_added=1 AND published=1 LIMIT 1',[id]);if(!sw)return {update:0,failed:0};const meta=await persistLatestUpdateMetadata(id,sw);return {update:meta.available?1:0,failed:0}}
  catch(err){await db.query('UPDATE software SET last_checked_at=NOW(),update_error=? WHERE id=?',[String(err.message||err).slice(0,2000),id]);return {update:0,failed:1,error:String(err.message||err).slice(0,2000)}}
}
async function step(){
  const db=getPool();let st=await state();if(st.status!=='running')return notifyCompletedScan(st);
  let queue=[];try{queue=JSON.parse(st.queue_json||'[]')}catch{}
  if(!queue.length){await db.query("UPDATE update_scan_state SET status='complete',current_software_id=NULL WHERE scan_key=?",[KEY]);return notifyCompletedScan(await state())}
  const batch=queue.splice(0,Math.max(1,config.lightWaveConcurrency));
  await db.query('UPDATE update_scan_state SET current_software_id=?,queue_json=? WHERE scan_key=?',[batch[0]||null,JSON.stringify(queue),KEY]);
  const results=await Promise.all(batch.map(processOne));
  const found=results.reduce((n,r)=>n+r.update,0),failed=results.reduce((n,r)=>n+r.failed,0),lastError=results.find(r=>r.error)?.error||null;
  await db.query(`UPDATE update_scan_state SET processed_count=processed_count+?,update_count=update_count+?,failed_count=failed_count+?,last_error=COALESCE(?,last_error),current_software_id=? WHERE scan_key=?`,[batch.length,found,failed,lastError,queue[0]||null,KEY]);
  if(!queue.length)await db.query("UPDATE update_scan_state SET status='complete',current_software_id=NULL WHERE scan_key=?",[KEY]);
  return notifyCompletedScan(await state());
}

let workerStarted=false,workerBusy=false,timer=null;
function scheduleWorker(delayMs){
  if(timer)clearTimeout(timer);
  timer=setTimeout(()=>reliability.runWorkerTick('updates',workerTick,{baseDelayMs:30000,maxDelayMs:10*60*1000}).catch(()=>{}),Math.max(50,delayMs));
  timer.unref?.();
}
async function workerTick(){
  if(workerBusy||!stateRuntime.dbReady){scheduleWorker(30000);return}
  workerBusy=true;
  try{
    let st=await state();
    if(st.status==='running'){
      st=await step();
      // Work only while a scan exists. Small pause prevents a hot loop.
      scheduleWorker(st.status==='running'?config.lightWaveActiveDelayMs:config.lightWaveIntervalMs);
      return;
    }
    const last=st.updated_at?new Date(st.updated_at).getTime():0;
    const dueIn=Math.max(0,config.lightWaveIntervalMs-(Date.now()-last));
    if(config.lightWaveAuto&&dueIn===0){await start(null,'published');scheduleWorker(50)}
    else scheduleWorker(config.lightWaveAuto?Math.max(60000,dueIn):24*60*60*1000);
  }finally{workerBusy=false}
}
function wakeUpdateWorker(){ if(!require('../cloudflare-bindings').isCloudflare()) scheduleWorker(50) }
function startUpdateWorker(){
  if(require('../cloudflare-bindings').isCloudflare()) return;
  if(workerStarted)return;workerStarted=true;
  scheduleWorker(5000);
}


async function markUpdated(id){
  const db=getPool();
  const conn=await db.getConnection();
  let applied=null;
  try{
    await conn.beginTransaction();
    const [[sw]]=await conn.query('SELECT * FROM software WHERE id=? LIMIT 1 FOR UPDATE',[Number(id)]);
    if(!sw)throw new Error('Software not found.');

    // Idempotent: if another request already completed the update, do not
    // recreate it or perform network work. The UI can safely close/move on.
    if(!sw.update_available){
      await conn.commit();
      return {updated:false,softwareId:Number(id),version:sw.current_version||null};
    }

    const nextVersion=sw.latest_version||null;
    if(!nextVersion)throw new Error('The pending update version is missing. Refresh update metadata and try again.');
    if(!sw.latest_installer_url)throw new Error('The pending update download link is missing. Refresh update metadata and try again.');

    // Preserve the version being replaced before promoting the pending release.
    // This makes Mark Updated deterministic and keeps Previous Versions intact
    // without waiting for GitHub/WinGet historical enrichment.
    if(sw.current_version){
      await conn.query(
        `INSERT INTO software_versions (software_id,version,installer_url,architecture,installer_type,sha256,file_size_bytes,source_path,release_date,release_date_source)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE installer_url=COALESCE(VALUES(installer_url),installer_url),
         architecture=COALESCE(VALUES(architecture),architecture), installer_type=COALESCE(VALUES(installer_type),installer_type),
         sha256=COALESCE(VALUES(sha256),sha256), file_size_bytes=COALESCE(VALUES(file_size_bytes),file_size_bytes),
         source_path=COALESCE(VALUES(source_path),source_path), release_date=COALESCE(VALUES(release_date),release_date),
         release_date_source=COALESCE(VALUES(release_date_source),release_date_source)`,
        [sw.id,sw.current_version,sw.installer_url,sw.architecture,sw.installer_type,sw.sha256,sw.file_size_bytes,sw.source_path,sw.release_date,sw.release_date_source]
      );
    }

    // Promote the exact release already displayed in the Update Available card.
    // Missing update metadata is deliberately left NULL rather than carrying
    // the previous release's date/size forward. The background enrichment queue
    // will fill anything the upstream source can provide.
    await conn.query(
      `UPDATE software SET current_version=?,installer_url=COALESCE(?,installer_url),sha256=COALESCE(?,sha256),
       file_size_bytes=?,release_date=?,release_date_source=IF(? IS NULL,NULL,'detected-update'),
       latest_version=NULL,latest_installer_url=NULL,latest_sha256=NULL,latest_file_size_bytes=NULL,latest_release_date=NULL,
       update_available=0,last_checked_at=NOW(),update_error=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [nextVersion,sw.latest_installer_url||null,sw.latest_sha256||null,
       sw.latest_file_size_bytes==null?null:Number(sw.latest_file_size_bytes),sw.latest_release_date||null,sw.latest_release_date||null,sw.id]
    );

    await conn.commit();
    applied={updated:true,softwareId:Number(sw.id),version:nextVersion};
  }catch(err){
    try{await conn.rollback()}catch{}
    throw err;
  }finally{
    conn.release();
  }

  // Deep WinGet/old-version enrichment is useful but must never block the
  // Mark Updated interaction. Queue it after the transaction so Hostinger can
  // process it with the existing background details worker.
  try{await enrichment.queueSoftware(Number(id))}catch(err){
    console.warn('[HSWare] Post-update enrichment queue:',String(err.message||err).slice(0,300));
  }
  return applied;
}

module.exports={state,start,step,markUpdated,refreshOne,startUpdateWorker,wakeUpdateWorker};
