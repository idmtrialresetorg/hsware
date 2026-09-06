const { getPool } = require('../db');

const FEED_ACTIONS = new Set([
  'app_published','app_unpublished','app_imported','app_marked_updated',
  'apk_sync_started','apk_sync_completed','apk_update_scan_started','apk_update_scan_completed',
  'partner_created','partner_updated','partner_enabled','partner_disabled',
  'backup_created','backup_restored','backup_failed','app_data_reset','new_apps_cleared'
]);

const PARTNER_VISIBLE_ACTIONS = new Set([
  'app_published','app_unpublished','app_imported','app_marked_updated',
  'apk_sync_started','apk_sync_completed','apk_update_scan_started','apk_update_scan_completed'
]);

const ACTION_META = {
  user_login:['Signed in','account'], user_logout:['Signed out','account'],
  app_claimed:['Opened app','work'], app_released:['Closed app','work'], app_force_released:['Force released app','work'], app_taken_over:['Took over app','work'],
  app_published:['Published app','publish'], app_unpublished:['Moved app back to APK Library','publish'], app_marked_updated:['Marked app updated','update'], app_imported:['Added APK app','import'],
  apk_sync_started:['Started APK sync','import'], apk_sync_completed:['APK sync completed','import'],
  apk_update_scan_started:['Started APK update scan','update'], apk_update_scan_completed:['APK update scan completed','update'],
  new_apps_cleared:['Cleared APK Library drafts','system'], app_data_reset:['Reset APK data','system'],
  partner_created:['Added Partner','team'], partner_updated:['Updated Partner','team'], partner_enabled:['Enabled Partner','team'], partner_disabled:['Disabled Partner','team'],
  admin_profile_updated:['Updated Admin profile','team'], profile_photo_updated:['Updated profile photo','team'], profile_photo_removed:['Removed profile photo','team'],
  backup_created:['Created backup','backup'], backup_restored:['Restored backup','backup'], backup_failed:['Automatic backup failed','backup']
};

function parseDetails(value){if(!value)return null;if(typeof value==='object')return value;try{return JSON.parse(value)}catch{return null}}
function humanizeAction(action){const found=ACTION_META[action];if(found)return{label:found[0],category:found[1]};return{label:String(action||'activity').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()),category:'system'}}
function activityJson(row){const meta=humanizeAction(row.action);return{id:Number(row.id),action:row.action,label:meta.label,category:meta.category,userId:row.user_id==null?null:Number(row.user_id),userName:row.user_name||(row.user_id==null?'System':'Unknown user'),userEmail:row.user_email||null,userRole:row.user_role||null,appId:row.app_id==null?null:Number(row.app_id),appName:row.app_name||null,packageId:row.package_id||null,targetUserId:row.target_user_id==null?null:Number(row.target_user_id),targetUserName:row.target_user_name||null,targetUserRole:row.target_user_role||null,details:parseDetails(row.details_json),createdAt:row.created_at||null}}

async function record(userId,action,{appId=null,targetUserId=null,details=null}={}){
  try{const [r]=await getPool().query('INSERT INTO activity_log (user_id,action,app_id,target_user_id,details_json) VALUES (?,?,?,?,?)',[userId?Number(userId):null,String(action).slice(0,80),appId?Number(appId):null,targetUserId?Number(targetUserId):null,details?JSON.stringify(details):null]);return Number(r.insertId||0)}
  catch(err){console.error('[Appbit] Activity log failed:',err?.message||err);return 0}
}
function safeDate(value,endOfDay=false){const raw=String(value||'').trim();if(!raw)return null;const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);const d=m?new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),endOfDay?23:0,endOfDay?59:0,endOfDay?59:0,endOfDay?999:0):new Date(raw);return Number.isNaN(d.getTime())?null:d}
async function list({viewer,limit=20,offset=0,action='',userId=null,q='',from='',to='',includeTransient=false}={}){
  const db=getPool(),safeLimit=Math.max(1,Math.min(100,Math.floor(Number(limit||20)||20))),safeOffset=Math.max(0,Math.floor(Number(offset||0)||0));const where=[],params=[];
  if(!viewer||viewer.role!=='admin'){const visible=[...PARTNER_VISIBLE_ACTIONS];where.push(`(a.action IN (${visible.map(()=>'?').join(',')}) OR a.user_id=?)`);params.push(...visible,Number(viewer?.id||0))}
  if(!includeTransient){const feed=[...FEED_ACTIONS];where.push(`a.action IN (${feed.map(()=>'?').join(',')})`);params.push(...feed)}
  const requested=String(action||'').trim();if(requested&&/^[a-z0-9_]{1,80}$/i.test(requested)){where.push('a.action=?');params.push(requested)}
  if(viewer?.role==='admin'&&Number(userId||0)>0){where.push('a.user_id=?');params.push(Number(userId))}
  const needle=String(q||'').trim().slice(0,120);if(needle){where.push('(u.name LIKE ? OR u.email LIKE ? OR p.name LIKE ? OR p.package_id LIKE ? OR a.action LIKE ?)');const like=`%${needle}%`;params.push(like,like,like,like,like)}
  const fd=safeDate(from);if(fd){where.push('a.created_at>=?');params.push(fd)}const td=safeDate(to,true);if(td){where.push('a.created_at<=?');params.push(td)}
  const whereSql=where.length?`WHERE ${where.join(' AND ')}`:'';const join=`FROM activity_log a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN apps p ON p.id=a.app_id LEFT JOIN users tu ON tu.id=a.target_user_id`;
  const [[countRow]]=await db.query(`SELECT COUNT(*) c ${join} ${whereSql}`,params);const [rows]=await db.query(`SELECT a.*,u.name user_name,u.email user_email,u.role user_role,p.name app_name,p.package_id,tu.name target_user_name,tu.role target_user_role ${join} ${whereSql} ORDER BY a.created_at DESC,a.id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,params);
  return{results:rows.map(activityJson),total:Number(countRow?.c||0),limit:safeLimit,offset:safeOffset};
}
async function recent(viewer,limit=8){return list({viewer,limit,offset:0,includeTransient:false})}
async function filters(viewer){const actions=[...FEED_ACTIONS].filter(a=>viewer?.role==='admin'||PARTNER_VISIBLE_ACTIONS.has(a)).sort();let users=[];if(viewer?.role==='admin'){const [rows]=await getPool().query("SELECT id,name,email,role,is_active FROM users ORDER BY (role='admin') DESC,name,email,id");users=rows.map(r=>({id:Number(r.id),name:r.name||r.email,email:r.email,role:r.role,active:Boolean(r.is_active)}))}return{actions:actions.map(a=>({action:a,...humanizeAction(a)})),users}}
module.exports={record,list,recent,filters,activityJson,humanizeAction};
