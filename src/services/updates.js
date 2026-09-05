const { getPool } = require('../db');
const { fetchPackageDetails, enrichManagedSoftwareById } = require('./winget');
const { compareVersions } = require('../utils/version');
const activity = require('./activity');
const notifications = require('./notifications');
const liteapks = require('./liteapks');

function normalizePlatform(value) {
  const platform = String(value || 'all').toLowerCase();
  if (platform === 'windows' || platform === 'desktop') return 'windows';
  if (platform === 'android') return 'android';
  return 'all';
}
function scanKey(platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'windows') return 'managed-software-windows';
  if (normalized === 'android') return 'managed-software-android';
  return 'managed-software';
}
function platformLabel(platform) {
  const normalized = normalizePlatform(platform);
  return normalized === 'android' ? 'Android APK' : normalized === 'windows' ? 'Desktop Software' : 'Software';
}

async function state(platform='all'){
  const key=scanKey(platform);
  const [r]=await getPool().query('SELECT * FROM update_scan_state WHERE scan_key=? LIMIT 1',[key]);
  return r[0]||{scan_key:key,status:'idle',queue_json:'[]',total_count:0,processed_count:0,update_count:0,failed_count:0,requested_by:null,completion_notified:0,platform:normalizePlatform(platform)};
}

async function start(requestedBy=null, platform='all'){
  const db=getPool();
  const normalized=normalizePlatform(platform);
  const key=scanKey(normalized);
  let where='workspace_added=1';
  if(normalized==='windows')where+=" AND COALESCE(platform_key,'windows')='windows'";
  if(normalized==='android')where+=" AND platform_key='android'";
  const [rows]=await db.query(`SELECT id FROM software WHERE ${where} ORDER BY id`);
  const queue=rows.map(r=>r.id);
  await db.query(`INSERT INTO update_scan_state (scan_key,requested_by,completion_notified,status,queue_json,total_count,processed_count,update_count,failed_count,current_software_id,last_error)
    VALUES (?,?,0,'running',?,?,0,0,0,NULL,NULL)
    ON DUPLICATE KEY UPDATE requested_by=VALUES(requested_by),completion_notified=0,status='running',queue_json=VALUES(queue_json),total_count=VALUES(total_count),processed_count=0,update_count=0,failed_count=0,current_software_id=NULL,last_error=NULL`,
    [key,requestedBy?Number(requestedBy):null,JSON.stringify(queue),queue.length]);
  if(requestedBy)await activity.record(Number(requestedBy),'update_scan_started',{details:{total:queue.length,platform:normalized}});
  return state(normalized);
}

async function notifyCompletedScan(st, platform='all'){
  const normalized=normalizePlatform(platform);
  const key=scanKey(normalized);
  if(!st||st.status!=='complete'||!Number(st.requested_by||0)||Number(st.completion_notified||0))return st;
  const db=getPool();
  const [mark]=await db.query('UPDATE update_scan_state SET completion_notified=1 WHERE scan_key=? AND completion_notified=0',[key]);
  if(!mark.affectedRows)return state(normalized);
  const userId=Number(st.requested_by);
  const found=Number(st.update_count||0);
  const failed=Number(st.failed_count||0);
  const checked=Number(st.processed_count||0);
  const label=platformLabel(normalized);
  await activity.record(userId,'update_scan_completed',{details:{checked,updates:found,failed,platform:normalized}});
  await notifications.notifyUser(userId,{
    actorUserId:userId,
    type:failed?'warning':found?'info':'success',
    title:`${label} update scan completed`,
    message:`${checked.toLocaleString()} checked · ${found.toLocaleString()} update(s) found · ${failed.toLocaleString()} failed.`,
    dedupeKey:`update-scan-${normalized}-${new Date(st.updated_at||Date.now()).getTime()}`
  });
  const [[actor]]=await db.query('SELECT id,role FROM users WHERE id=? LIMIT 1',[userId]);
  if(actor?.role==='partner'){
    await notifications.notifyAdmins({
      actorUserId:userId,
      type:failed?'warning':'info',
      title:`Partner ${label.toLowerCase()} update scan completed`,
      message:`${found.toLocaleString()} update(s) found · ${failed.toLocaleString()} failed.`,
      dedupeKey:`partner-update-scan-${normalized}-${new Date(st.updated_at||Date.now()).getTime()}`
    },{exceptUserId:userId});
  }
  return state(normalized);
}

async function step(platform='all'){
  const db=getPool();
  const normalized=normalizePlatform(platform);
  const key=scanKey(normalized);
  let st=await state(normalized);
  if(st.status==='idle')st=await start(st.requested_by||null,normalized);
  if(st.status!=='running')return notifyCompletedScan(st,normalized);
  let queue=[];try{queue=JSON.parse(st.queue_json||'[]')}catch{}
  if(!queue.length){
    await db.query("UPDATE update_scan_state SET status='complete',current_software_id=NULL WHERE scan_key=?",[key]);
    return notifyCompletedScan(await state(normalized),normalized);
  }
  const id=queue.shift();
  await db.query('UPDATE update_scan_state SET current_software_id=?,queue_json=? WHERE scan_key=?',[id,JSON.stringify(queue),key]);
  try{
    const [[sw]]=await db.query('SELECT * FROM software WHERE id=? LIMIT 1',[id]);
    if(sw){
      const isAndroid=String(sw.platform_key||'windows').toLowerCase()==='android';
      // The queue is platform-scoped, but keep this guard so a stale queue can
      // never run the wrong provider against a record after a platform change.
      if((normalized==='android'&&!isAndroid)||(normalized==='windows'&&isAndroid)){
        await db.query('UPDATE update_scan_state SET processed_count=processed_count+1 WHERE scan_key=?',[key]);
      }else{
        let available=false;
        if(String(sw.source_type||'winget').toLowerCase()==='liteapks'){
          const checked=await liteapks.checkUpdateForSoftware(sw);
          available=Boolean(checked.available);
        }else{
          const latest=await fetchPackageDetails(sw.package_id,sw.source_path,{includeOldVersions:false,probeSize:false});
          available=Boolean(latest.version&&(!sw.current_version||compareVersions(latest.version,sw.current_version)>0));
          await db.query(`UPDATE software SET latest_version=?,latest_installer_url=?,latest_sha256=?,update_available=?,last_checked_at=NOW(),update_error=NULL WHERE id=?`,[latest.version,latest.installerUrl,latest.sha256,available?1:0,id]);
        }
        await db.query('UPDATE update_scan_state SET processed_count=processed_count+1,update_count=update_count+? WHERE scan_key=?',[available?1:0,key]);
      }
    }else{
      // A record can be deleted while a scan is running. Count it as processed
      // so progress still reaches 100% instead of leaving a misleading total.
      await db.query('UPDATE update_scan_state SET processed_count=processed_count+1 WHERE scan_key=?',[key]);
    }
  }catch(err){
    await db.query('UPDATE software SET last_checked_at=NOW(),update_error=? WHERE id=?',[String(err.message||err).slice(0,2000),id]);
    await db.query('UPDATE update_scan_state SET processed_count=processed_count+1,failed_count=failed_count+1,last_error=? WHERE scan_key=?',[String(err.message||err).slice(0,2000),key]);
  }
  if(!queue.length)await db.query("UPDATE update_scan_state SET status='complete',current_software_id=NULL WHERE scan_key=?",[key]);
  return notifyCompletedScan(await state(normalized),normalized);
}

async function markUpdatedWinget(id){
  const db=getPool();
  const [[sw]]=await db.query('SELECT * FROM software WHERE id=? LIMIT 1',[id]);
  if(!sw)throw new Error('Software not found.');
  await enrichManagedSoftwareById(sw.id,{includeOldVersions:true,probeSize:true,findLatest:true,recoverPath:true});
  await db.query('UPDATE software SET latest_version=NULL,latest_installer_url=NULL,latest_sha256=NULL,update_available=0,last_checked_at=NOW(),update_error=NULL WHERE id=?',[id]);
  return true;
}

async function markUpdated(id){
  const [[sw]]=await getPool().query('SELECT id,source_type FROM software WHERE id=? LIMIT 1',[id]);
  if(!sw)throw new Error('Software not found.');
  if(String(sw.source_type||'winget').toLowerCase()==='liteapks')return liteapks.markUpdated(id);
  return markUpdatedWinget(id);
}

module.exports={state,start,step,markUpdated,markUpdatedWinget,normalizePlatform};
