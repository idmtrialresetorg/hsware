const express = require('express');
const config = require('../config');
const state = require('../state');
const { getPool, hasDbConfig } = require('../db');
const { requireAuth, requireActiveUser, requireAdmin } = require('../middleware/auth');
const requireDb = require('../middleware/db-ready');
const { verifyToken } = require('../middleware/csrf');
const imports = require('../services/imports');
const updates = require('../services/updates');
const { backfillVersionDates } = require('../services/winget');
const { prepareSoftware } = require('../services/package-source');
const liteapks = require('../services/liteapks');
const androidMedia = require('../services/android-media');
const { queueSoftware } = require('../services/enrichment');
const { hasToken } = require('../services/github');
const { compareVersions } = require('../utils/version');
const maintenance = require('../services/maintenance');
const backups = require('../services/backups');
const users = require('../services/users');
const workClaims = require('../services/work-claims');
const activity = require('../services/activity');
const notifications = require('../services/notifications');
const { withRequirementFallbacks } = require('../services/requirements');

const router = express.Router();
router.use(requireDb, requireAuth, requireActiveUser);
const mutate = [verifyToken];

function parseTags(value) {
  if (!value) return [];
  try { const out = JSON.parse(value); return Array.isArray(out) ? out : []; } catch { return []; }
}
function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try { const out = JSON.parse(value); return out && typeof out === 'object' && !Array.isArray(out) ? out : {}; } catch { return {}; }
}
function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function completeness(r, historyCount = null) {
  const lite=String(r?.source_type||'winget').toLowerCase()==='liteapks';
  const checks = lite
    ? [r.name,r.package_id,r.category,r.publisher,r.current_version,r.source_page_url,r.architecture,r.installer_type,r.description,r.minimum_os_version]
    : [r.name,r.package_id,r.category,r.publisher,r.current_version,r.official_url,r.installer_url,r.architecture,r.installer_type,r.sha256,r.description];
  if (historyCount !== null) checks.push(Number(historyCount || 0) > 0);
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}
function claimFromSoftwareRow(r) {
  if (!r.work_claim_user_id) return null;
  return {
    softwareId: Number(r.id),
    userId: Number(r.work_claim_user_id),
    name: r.work_claim_user_name || 'User',
    role: r.work_claim_user_role || 'partner',
    roleLabel: r.work_claim_user_role === 'admin' ? 'Admin' : 'Partner',
    claimedAt: r.work_claimed_at || null,
    lastHeartbeatAt: r.work_claim_heartbeat_at || null
  };
}
function softwareJson(r) {
  const req = withRequirementFallbacks(r);
  return {
    id:Number(r.id), packageId:r.package_id, sourcePackageId:r.source_package_id||null, sourceType:r.source_type||'winget', platformKey:r.platform_key||'windows', sourcePageUrl:r.source_page_url||null, sourceUpdatedAt:dateOnly(r.source_updated_at), sourceMeta:parseObject(r.source_metadata_json),
    name:r.name, publisher:r.publisher||'', developer:r.developer_name||r.author||r.publisher||'', author:r.author||'', version:r.current_version||'', category:r.category||'Uncategorized',
    published:Boolean(r.published), priority:r.priority_rank==null?null:Number(r.priority_rank), demandScore:r.demand_score==null?null:Number(r.demand_score), description:r.description||null,
    officialUrl:r.official_url||null, installerUrl:r.installer_url||null, architecture:r.architecture||null, installerType:r.installer_type||null,
    language:req.language, platform:req.platform, processor:req.processor, minimumOsVersion:req.minimumOsVersion,
    ramRequirement:req.ramRequirement, storageRequirement:req.storageRequirement, graphicsRequirement:req.graphicsRequirement, requirementEstimates:req.estimated, requirementsSourceUrl:r.requirements_source_url||null,
    downloadCount:r.download_count==null?null:Number(r.download_count), downloadCountSource:r.download_count_source||null,
    sha256:r.sha256||null, fileSizeBytes:r.file_size_bytes==null?null:Number(r.file_size_bytes), latestVersion:r.latest_version||null, latestInstallerUrl:r.latest_installer_url||null,
    updateAvailable:Boolean(r.update_available), lastCheckedAt:r.last_checked_at||null, updateError:r.update_error||null,
    enrichmentStatus:r.enrichment_status||'pending', metadataRevision:Number(r.metadata_revision||0), enrichmentError:r.enrichment_error||null, enrichedAt:r.enriched_at||null,
    enrichmentAttempts:Number(r.enrichment_attempts||0), lastEnrichmentAttemptAt:r.last_enrichment_attempt_at||null,
    linkStatus:r.link_status||'unknown', linkCheckedAt:r.link_checked_at||null, createdAt:r.created_at||null,
    importedAt:r.workspace_added_at||r.created_at||null, publishedAt:r.published_at||null, lastOpenedAt:r.last_opened_at||null,
    licenseName:r.license_name||null, tags:parseTags(r.tags_json), completeness:completeness(r),
    claim: claimFromSoftwareRow(r)
  };
}
async function counts() {
  const db = getPool();
  const [[row]] = await db.query(`SELECT
    COUNT(*) AS total,
    SUM(published=0) AS unpublished,
    SUM(published=1) AS published,
    SUM(update_available=1) AS updates,
    COUNT(DISTINCT CASE WHEN publisher IS NOT NULL AND publisher<>'' THEN publisher END) AS active_publishers,
    SUM(enrichment_status='ready' AND current_version IS NOT NULL AND ((source_type='liteapks' AND source_page_url IS NOT NULL) OR (COALESCE(source_type,'winget')<>'liteapks' AND installer_url IS NOT NULL))) AS ready,
    SUM(COALESCE(platform_key,'windows')='windows') AS desktop_total,
    SUM(COALESCE(platform_key,'windows')='windows' AND published=0) AS desktop_unpublished,
    SUM(COALESCE(platform_key,'windows')='windows' AND published=1) AS desktop_published,
    SUM(COALESCE(platform_key,'windows')='windows' AND update_available=1) AS desktop_updates,
    SUM(COALESCE(platform_key,'windows')='windows' AND enrichment_status='ready' AND current_version IS NOT NULL AND installer_url IS NOT NULL) AS desktop_ready,
    SUM(platform_key='android') AS android_total,
    SUM(platform_key='android' AND published=0) AS android_unpublished,
    SUM(platform_key='android' AND published=1) AS android_published,
    SUM(platform_key='android' AND update_available=1) AS android_updates,
    SUM(platform_key='android' AND enrichment_status='ready' AND current_version IS NOT NULL AND source_page_url IS NOT NULL) AS android_ready
    FROM software WHERE workspace_added=1`);
  const n = key => Number(row?.[key] || 0);
  return {
    total:n('total'), unpublished:n('unpublished'), published:n('published'), ready:n('ready'), updates:n('updates'), activePublishers:n('active_publishers'),
    windows:n('desktop_total'), android:n('android_total'),
    desktopTotal:n('desktop_total'), desktopUnpublished:n('desktop_unpublished'), desktopPublished:n('desktop_published'), desktopUpdates:n('desktop_updates'), desktopReady:n('desktop_ready'),
    androidTotal:n('android_total'), androidUnpublished:n('android_unpublished'), androidPublished:n('android_published'), androidUpdates:n('android_updates'), androidReady:n('android_ready')
  };
}
function userJson(row) {
  return users.publicUser({ ...row, avatar_blob: row.has_avatar ? Buffer.from([1]) : row.avatar_blob });
}
function lockedResponse(res, claim) {
  return res.status(423).json({ ok:false, error:`${claim?.name || 'Another user'} is currently working on this software.`, claim });
}
async function softwareRow(id) {
  await workClaims.pruneStaleClaims(getPool(), Number(id));
  const [[row]] = await getPool().query(`SELECT s.*,c.user_id AS work_claim_user_id,c.claimed_at AS work_claimed_at,c.last_heartbeat_at AS work_claim_heartbeat_at,
    cu.name AS work_claim_user_name,cu.role AS work_claim_user_role
    FROM software s LEFT JOIN software_work_claims c ON c.software_id=s.id LEFT JOIN users cu ON cu.id=c.user_id
    WHERE s.id=? LIMIT 1`, [Number(id)]);
  return row || null;
}

router.get('/bootstrap', async(req,res,next)=>{try{
  const isAdmin=req.currentUser.role==='admin';
  const user=userJson({ ...req.currentUser, has_avatar:req.currentUser.has_avatar });
  res.json({
    ok:true, csrfToken:req.session.csrfToken, user, counts:await counts(),
    config:{
      autoImportMax:imports.MAX_AUTO_TARGET,catalogTarget:config.catalogTarget,mediaEnabled:false,
      liteapksEnabled:true,liteapksBaseUrl:liteapks.BASE_URL,liteapksDailyPages:config.liteapksDailyPages,
      ...(isAdmin?{githubConfigured:hasToken(),nodeEnv:config.nodeEnv,dbName:config.db.database}: {})
    },
    liteapksSync:await liteapks.getSyncState(),
    importJob:await imports.currentJob(),
    backup:isAdmin?await backups.state():null,
    notificationSummary:await notifications.summary(req.currentUser.id)
  });
}catch(e){next(e)}});

router.get('/activity',async(req,res,next)=>{try{
  const data=await activity.list({
    viewer:req.currentUser,
    limit:req.query.limit,offset:req.query.offset,action:req.query.action,userId:req.query.userId,q:req.query.q,from:req.query.from,to:req.query.to,
    includeTransient:req.currentUser.role==='admin'&&String(req.query.includeTransient||'')==='1'
  });
  res.json({ok:true,...data,filters:await activity.filters(req.currentUser)});
}catch(e){next(e)}});
router.get('/activity/recent',async(req,res,next)=>{try{const data=await activity.recent(req.currentUser,Math.min(12,Number(req.query.limit||8)));res.json({ok:true,...data})}catch(e){next(e)}});

router.get('/notifications/summary',async(req,res,next)=>{try{res.json({ok:true,...await notifications.summary(req.currentUser.id)})}catch(e){next(e)}});
router.get('/notifications',async(req,res,next)=>{try{
  const items=await notifications.list(req.currentUser.id,{limit:req.query.limit,unreadOnly:String(req.query.unreadOnly||'')==='1'});
  res.json({ok:true,items,summary:await notifications.summary(req.currentUser.id)});
}catch(e){next(e)}});
router.post('/notifications/read',...mutate,async(req,res,next)=>{try{
  const ids=Array.isArray(req.body?.ids)?req.body.ids:[];
  const changed=req.body?.all?await notifications.markAllRead(req.currentUser.id):await notifications.markRead(req.currentUser.id,ids);
  res.json({ok:true,changed,summary:await notifications.summary(req.currentUser.id)});
}catch(e){next(e)}});

router.get('/software', async(req,res,next)=>{try{
  const db=getPool(); await workClaims.pruneStaleClaims(db); const scope=String(req.query.scope||'all'); const q=String(req.query.q||'').trim(); const platform=String(req.query.platform||'all').toLowerCase(); let where='s.workspace_added=1'; const params=[];
  if(scope==='unpublished')where+=' AND s.published=0'; else if(scope==='published')where+=' AND s.published=1'; else if(scope==='updates')where+=' AND s.update_available=1';
  if(platform==='windows')where+=" AND COALESCE(s.platform_key,'windows')='windows'"; else if(platform==='android')where+=" AND s.platform_key='android'";
  if(q){where+=' AND (s.name LIKE ? OR s.package_id LIKE ? OR s.publisher LIKE ? OR s.category LIKE ?)';for(let i=0;i<4;i++)params.push(`%${q}%`)}
  const order=scope==='updates'
    ? 's.update_available DESC,s.last_checked_at DESC,s.name'
    : scope==='unpublished'
      ? 'COALESCE(s.workspace_added_at,s.created_at) DESC,s.id DESC'
      : scope==='published'
        ? 'COALESCE(s.published_at,s.updated_at,s.created_at) DESC,s.id DESC'
        : 'COALESCE(s.workspace_added_at,s.created_at) DESC,s.id DESC';
  const [rows]=await db.query(`SELECT s.*,c.user_id AS work_claim_user_id,c.claimed_at AS work_claimed_at,c.last_heartbeat_at AS work_claim_heartbeat_at,
    cu.name AS work_claim_user_name,cu.role AS work_claim_user_role
    FROM software s LEFT JOIN software_work_claims c ON c.software_id=s.id LEFT JOIN users cu ON cu.id=c.user_id
    WHERE ${where} ORDER BY ${order} LIMIT 50000`,params);
  res.json({ok:true,results:rows.map(softwareJson)});
}catch(e){next(e)}});

router.get('/work-claims',async(req,res,next)=>{try{res.json({ok:true,claims:await workClaims.listActiveClaims(),timeoutSeconds:workClaims.LOCK_TIMEOUT_SECONDS})}catch(e){next(e)}});

router.get('/software/:id', async(req,res,next)=>{try{
  const db=getPool(); const r=await softwareRow(req.params.id);
  if(!r)return res.status(404).json({ok:false,error:'Software not found.'});
  if(String(r.source_type||'winget').toLowerCase()!=='liteapks') await backfillVersionDates(Number(r.id));
  const [versionsRaw]=await db.query('SELECT * FROM software_versions WHERE software_id=?',[r.id]);
  const versions=versionsRaw.sort((a,b)=>compareVersions(b.version,a.version)).filter(v=>String(v.version)!==String(r.current_version||'')).slice(0,5);
  const [[queue]]=await db.query('SELECT status,last_error,updated_at FROM enrichment_queue WHERE software_id=? LIMIT 1',[r.id]);
  await db.query('UPDATE software SET last_opened_at=NOW() WHERE id=?',[r.id]);
  const out=softwareJson(r);
  out.versions=versions.map(v=>({id:Number(v.id),version:v.version,installerUrl:v.installer_url,sourcePageUrl:v.source_page_url||null,updatedDate:dateOnly(v.release_date),updatedDateSource:v.release_date_source||null,architecture:v.architecture,installerType:v.installer_type,sha256:v.sha256}));
  out.completeness=completeness(r,versions.length);
  out.backgroundStatus=queue?.status||'idle';
  const enrichedAt=r.enriched_at?new Date(r.enriched_at).getTime():0;
  const stale=!enrichedAt || (Date.now()-enrichedAt)>(24*60*60*1000);
  const isLiteApks=String(r.source_type||'winget').toLowerCase()==='liteapks';
  const needsMetadataRevision=Number(r.metadata_revision||0)<(isLiteApks?7:4);
  const missingRequired=isLiteApks?!r.source_page_url:!r.installer_url;
  out.needsRefresh=Boolean(r.enrichment_status!=='ready'||!r.current_version||missingRequired||stale||needsMetadataRevision);
  if(r.enrichment_status!=='ready'||!r.current_version||missingRequired||needsMetadataRevision) queueSoftware(Number(r.id)).catch(()=>{});
  res.json({ok:true,software:out});
}catch(e){next(e)}});

router.post('/software/:id/claim',...mutate,async(req,res,next)=>{try{
  const result=await workClaims.claimSoftware(Number(req.params.id),req.currentUser);
  if(!result.ok)return lockedResponse(res,result.claim);
  res.json({ok:true,claim:result.claim});
}catch(e){if(e.status===423)return lockedResponse(res,e.claim);next(e)}});
router.post('/software/:id/heartbeat',...mutate,async(req,res,next)=>{try{
  const result=await workClaims.heartbeat(Number(req.params.id),req.currentUser.id);
  if(!result.ok){
    if(result.claim)return lockedResponse(res,result.claim);
    return res.status(409).json({ok:false,error:'Your work claim is no longer active.',claim:null});
  }
  res.json({ok:true,claim:result.claim});
}catch(e){next(e)}});
router.post('/software/:id/release',...mutate,async(req,res,next)=>{try{
  const result=await workClaims.release(Number(req.params.id),req.currentUser,{force:req.currentUser.role==='admin'&&Boolean(req.body?.force)});
  res.json({ok:true,...result});
}catch(e){if(e.status===423)return lockedResponse(res,e.claim);next(e)}});
router.post('/software/:id/takeover',...mutate,requireAdmin,async(req,res,next)=>{try{
  res.json(await workClaims.takeover(Number(req.params.id),req.currentUser));
}catch(e){next(e)}});

router.post('/software/:id/refresh',...mutate,async(req,res,next)=>{try{
  const id=Number(req.params.id); await workClaims.ensureNotOwnedByOther(id,req.currentUser);
  const [[s]]=await getPool().query('SELECT id FROM software WHERE id=? LIMIT 1',[id]);
  if(!s)return res.status(404).json({ok:false,error:'Software not found.'});
  await queueSoftware(id,{force:true});
  res.json({ok:true,queued:true,message:'Software details refresh queued.'});
}catch(e){if(e.status===423)return lockedResponse(res,e.claim);next(e)}});
router.post('/software/:id/prepare',...mutate,async(req,res,next)=>{try{
  const id=Number(req.params.id); await workClaims.ensureNotOwnedByOther(id,req.currentUser); await queueSoftware(id,{force:true});
  res.json({ok:true,queued:true,refreshed:false,warning:null});
}catch(e){if(e.status===423)return lockedResponse(res,e.claim);next(e)}});
router.post('/software/:id/toggle-published',...mutate,async(req,res,next)=>{try{
  const db=getPool();
  let [[s]]=await db.query('SELECT * FROM software WHERE id=?',[req.params.id]);
  if(!s)return res.status(404).json({ok:false,error:'Software not found.'});
  const value=s.published?0:1;
  if(value===1){
    const claimResult=await workClaims.claimSoftware(Number(s.id),req.currentUser);
    if(!claimResult.ok)return lockedResponse(res,claimResult.claim);
  } else {
    await workClaims.ensureNotOwnedByOther(Number(s.id),req.currentUser);
  }
  const liteSource=String(s.source_type||'winget').toLowerCase()==='liteapks';
  const sourceReady=liteSource?Boolean(s.source_page_url):Boolean(s.installer_url);
  if(value===1 && (!s.current_version || !sourceReady || s.enrichment_status!=='ready')){
    const prep=await prepareSoftware(Number(s.id));
    [[s]]=await db.query('SELECT * FROM software WHERE id=?',[s.id]);
    const refreshedReady=String(s.source_type||'winget').toLowerCase()==='liteapks'?Boolean(s.source_page_url):Boolean(s.installer_url);
    if(!s.current_version || !refreshedReady){
      return res.status(409).json({ok:false,error:prep.warning || (liteSource?'A current version and LiteAPKs source page are required before publishing.':'Verified version and installer link are required before publishing. Open the software and retry details.')});
    }
  }
  await db.query('UPDATE software SET published=?,published_at=IF(?=1,NOW(),NULL) WHERE id=?',[value,value,s.id]);
  await db.query(`INSERT INTO software_import_history (package_id,status,last_imported_at)
    VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE status=VALUES(status),updated_at=CURRENT_TIMESTAMP`,
    [s.package_id,value===1?'published':'imported']);
  await activity.record(req.currentUser.id,value===1?'software_published':'software_unpublished',{softwareId:Number(s.id)});
  if(req.currentUser.role==='partner')await notifications.notifyAdmins({
    actorUserId:req.currentUser.id,type:'info',title:value===1?'Software published':'Software moved back to New',
    message:`${req.currentUser.name||'Partner'} ${value===1?'published':'unpublished'} ${s.name||s.package_id}.`,softwareId:Number(s.id)
  },{exceptUserId:req.currentUser.id});
  if(value===1)await workClaims.releaseOwned(Number(s.id),req.currentUser.id);
  res.json({ok:true,published:Boolean(value)});
}catch(e){if(e.status===423)return lockedResponse(res,e.claim);next(e)}});
router.get('/software/:id/android-assets/icon',async(req,res,next)=>{try{
  const row=await softwareRow(Number(req.params.id));
  if(!row)return res.status(404).json({ok:false,error:'APK not found.'});
  if(String(row.platform_key||'').toLowerCase()!=='android'||String(row.source_type||'').toLowerCase()!=='liteapks')return res.status(400).json({ok:false,error:'Media downloads are available for Android APK records only.'});
  const file=await androidMedia.iconDownload(row);
  const inline=String(req.query.inline||'')==='1';
  res.set('Content-Type',file.mime);
  res.set('Content-Length',String(file.buffer.length));
  res.set('Cache-Control',inline?'private, max-age=3600':'private, no-store');
  res.set('Content-Disposition',`${inline?'inline':'attachment'}; filename="${file.filename.replace(/["\\]/g,'_')}"`);
  res.send(file.buffer);
}catch(e){if(e?.status)return res.status(e.status).json({ok:false,error:e.message});next(e)}});
router.get('/software/:id/android-assets/screenshot/:index',async(req,res,next)=>{try{
  const row=await softwareRow(Number(req.params.id));
  if(!row)return res.status(404).json({ok:false,error:'APK not found.'});
  if(String(row.platform_key||'').toLowerCase()!=='android'||String(row.source_type||'').toLowerCase()!=='liteapks')return res.status(400).json({ok:false,error:'Media downloads are available for Android APK records only.'});
  const file=await androidMedia.screenshotDownload(row,Number(req.params.index));
  const inline=String(req.query.inline||'')==='1';
  res.set('Content-Type',file.mime);
  res.set('Content-Length',String(file.buffer.length));
  res.set('Cache-Control',inline?'private, max-age=3600':'private, no-store');
  res.set('Content-Disposition',`${inline?'inline':'attachment'}; filename="${file.filename.replace(/["\\]/g,'_')}"`);
  res.send(file.buffer);
}catch(e){if(e?.status)return res.status(e.status).json({ok:false,error:e.message});next(e)}});
router.get('/software/:id/android-assets.zip',async(req,res,next)=>{try{
  const row=await softwareRow(Number(req.params.id));
  if(!row)return res.status(404).json({ok:false,error:'APK not found.'});
  if(String(row.platform_key||'').toLowerCase()!=='android'||String(row.source_type||'').toLowerCase()!=='liteapks')return res.status(400).json({ok:false,error:'Media downloads are available for Android APK records only.'});
  const pack=await androidMedia.mediaPack(row);
  res.set('Content-Type','application/zip');
  res.set('Content-Length',String(pack.buffer.length));
  res.set('Cache-Control','private, no-store');
  res.set('Content-Disposition',`attachment; filename="${pack.filename.replace(/["\\]/g,'_')}"`);
  res.send(pack.buffer);
}catch(e){if(e?.status)return res.status(e.status).json({ok:false,error:e.message});next(e)}});

router.post('/software/:id/android-download/resolve',...mutate,async(req,res,next)=>{try{
  const id=Number(req.params.id);
  const row=await softwareRow(id);
  if(!row)return res.status(404).json({ok:false,error:'APK not found.'});
  if(String(row.platform_key||'').toLowerCase()!=='android'||String(row.source_type||'').toLowerCase()!=='liteapks')return res.status(400).json({ok:false,error:'Download resolution is available for Android APK records only.'});
  const out=await liteapks.resolveDownloadForSoftware(id);
  res.json({ok:true,...out});
}catch(e){if(e?.status)return res.status(e.status).json({ok:false,error:e.message});next(e)}});

router.post('/software/:id/mark-updated',...mutate,async(req,res,next)=>{try{
  const id=Number(req.params.id); await workClaims.ensureNotOwnedByOther(id,req.currentUser); await updates.markUpdated(id); await activity.record(req.currentUser.id,'software_marked_updated',{softwareId:id});
  if(req.currentUser.role==='partner'){const [[sw]]=await getPool().query('SELECT name,package_id FROM software WHERE id=? LIMIT 1',[id]);await notifications.notifyAdmins({actorUserId:req.currentUser.id,type:'info',title:'Software updated',message:`${req.currentUser.name||'Partner'} marked ${sw?.name||sw?.package_id||'software'} updated.`,softwareId:id},{exceptUserId:req.currentUser.id});}
  res.json({ok:true});
}catch(e){if(e.status===423)return lockedResponse(res,e.claim);next(e)}});

router.get('/import/manual/search',async(req,res,next)=>{try{
  const q=String(req.query.q||'').trim(); const source=String(req.query.source||'winget').toLowerCase();
  const results=!q?[]:source==='liteapks'?await liteapks.searchCatalog(q):await imports.searchCandidates(q);
  res.json({ok:true,results});
}catch(e){next(e)}});
router.post('/import/manual',...mutate,async(req,res,next)=>{try{
  const sourceType=String(req.body.sourceType||'winget').toLowerCase();
  let sw; let packageId=String(req.body.packageId||'').trim();
  if(sourceType==='liteapks'){
    let sourcePageUrl=String(req.body.sourcePageUrl||'').trim();
    if(!sourcePageUrl && packageId.startsWith('liteapks:')){const [[cat]]=await getPool().query("SELECT source_page_url FROM catalog_packages WHERE package_id=? AND source_type='liteapks' LIMIT 1",[packageId]);sourcePageUrl=cat?.source_page_url||''}
    if(!liteapks.normalizeSourceUrl(sourcePageUrl))return res.status(400).json({ok:false,error:'Enter or select a valid LiteAPKs app page URL.'});
    sw=await liteapks.ensureManagedFromUrl(sourcePageUrl); packageId=sw.package_id;
  }else{
    if(!packageId||packageId.length>190)return res.status(400).json({ok:false,error:'Enter a valid WinGet Package ID.'});
    sw=await imports.verifiedImport(packageId);
  }
  await activity.record(req.currentUser.id,'software_manual_imported',{softwareId:Number(sw.id),details:{packageId,sourceType}});
  if(req.currentUser.role==='partner')await notifications.notifyAdmins({
    actorUserId:req.currentUser.id,type:'info',title:'Software imported',message:`${req.currentUser.name||'Partner'} imported ${sw.name||packageId}.`,softwareId:Number(sw.id)
  },{exceptUserId:req.currentUser.id});
  res.json({ok:true,id:sw.id,verified:true,warning:null});
}catch(e){next(e)}});

router.get('/liteapks/state',async(req,res,next)=>{try{res.json({ok:true,state:await liteapks.getSyncState()})}catch(e){next(e)}});
router.post('/liteapks/sync',...mutate,requireAdmin,async(req,res,next)=>{try{const mode=String(req.body?.mode||'auto');res.json({ok:true,state:await liteapks.startSync({mode,requestedBy:req.currentUser.id,force:Boolean(req.body?.force)})})}catch(e){next(e)}});
router.post('/liteapks/step',...mutate,requireAdmin,async(req,res,next)=>{try{res.json({ok:true,state:await liteapks.step()})}catch(e){next(e)}});

router.post('/import/auto/start',...mutate,async(req,res,next)=>{try{const job=await imports.startAutoImport(req.body.count,req.body.installerFormat,req.currentUser.id);await activity.record(req.currentUser.id,'auto_import_started',{details:{count:req.body.count,installerFormat:req.body.installerFormat}});res.json({ok:true,job})}catch(e){next(e)}});
router.post('/import/auto/stop',...mutate,async(req,res,next)=>{try{const job=await imports.stopAutoImport();await activity.record(req.currentUser.id,'auto_import_stopped');res.json({ok:true,job})}catch(e){next(e)}});
router.post('/import/auto/step',...mutate,async(req,res,next)=>{try{res.json({ok:true,job:await imports.stepAutoImport()})}catch(e){next(e)}});
router.get('/import/auto/state',async(req,res,next)=>{try{res.json({ok:true,job:await imports.currentJob()})}catch(e){next(e)}});

router.post('/workspace/clear-new',...mutate,requireAdmin,async(req,res,next)=>{try{const platform=String(req.body?.platform||'all').toLowerCase();const result=await maintenance.clearNewSoftware(platform);await activity.record(req.currentUser.id,'new_software_cleared',{details:{platform:result.platform}});res.json({ok:true,...result})}catch(e){next(e)}});
router.post('/maintenance/reset-all',...mutate,requireAdmin,async(req,res,next)=>{try{
  if(String(req.body.confirm||'')!=='RESET')return res.status(400).json({ok:false,error:'Type RESET to confirm.'});
  await maintenance.resetAllData();
  await activity.record(req.currentUser.id,'software_data_reset');
  res.json({ok:true,cleared:true});
}catch(e){next(e)}});

router.post('/updates/start',...mutate,async(req,res,next)=>{try{const platform=String(req.body?.platform||'all').toLowerCase();res.json({ok:true,state:await updates.start(req.currentUser.id,platform)})}catch(e){next(e)}});
router.post('/updates/step',...mutate,async(req,res,next)=>{try{const platform=String(req.body?.platform||'all').toLowerCase();res.json({ok:true,state:await updates.step(platform)})}catch(e){next(e)}});
router.get('/updates/state',async(req,res,next)=>{try{const platform=String(req.query.platform||'all').toLowerCase();res.json({ok:true,state:await updates.state(platform)})}catch(e){next(e)}});

router.get('/users',requireAdmin,async(req,res,next)=>{try{res.json({ok:true,users:await users.listUsers()})}catch(e){next(e)}});
router.post('/users',...mutate,requireAdmin,async(req,res,next)=>{try{
  const user=await users.createPartner({name:req.body.name,email:req.body.email,password:req.body.password,createdBy:req.currentUser.id});
  await activity.record(req.currentUser.id,'partner_created',{targetUserId:user.id});
  await notifications.notifyUser(user.id,{actorUserId:req.currentUser.id,type:'info',title:'Welcome to HSWare',message:'Your Partner account is ready. You can import, review, publish, and update software.'});
  res.status(201).json({ok:true,user});
}catch(e){next(e)}});
router.patch('/users/:id',...mutate,requireAdmin,async(req,res,next)=>{try{
  const user=await users.updatePartner(Number(req.params.id),{name:req.body.name,email:req.body.email,password:req.body.password});
  await activity.record(req.currentUser.id,'partner_updated',{targetUserId:user.id});
  await notifications.notifyUser(user.id,{actorUserId:req.currentUser.id,type:'info',title:'Account updated',message:'The Admin updated your HSWare Partner account details.'});
  res.json({ok:true,user});
}catch(e){next(e)}});
router.post('/users/:id/status',...mutate,requireAdmin,async(req,res,next)=>{try{
  const active=Boolean(req.body.active); const user=await users.setPartnerActive(Number(req.params.id),active);
  await activity.record(req.currentUser.id,active?'partner_enabled':'partner_disabled',{targetUserId:user.id});
  if(active)await notifications.notifyUser(user.id,{actorUserId:req.currentUser.id,type:'success',title:'Account enabled',message:'Your HSWare Partner account has been enabled.'});
  res.json({ok:true,user});
}catch(e){next(e)}});
router.patch('/account',...mutate,requireAdmin,async(req,res,next)=>{try{
  const user=await users.updateOwnAdmin(req.currentUser.id,{name:req.body.name,email:req.body.email,password:req.body.password});
  req.session.user={id:user.id,name:user.name,email:user.email,role:user.role};
  await activity.record(req.currentUser.id,'admin_profile_updated');
  res.json({ok:true,user});
}catch(e){next(e)}});
router.get('/users/:id/avatar',async(req,res,next)=>{try{
  const image=await users.avatar(Number(req.params.id));
  if(!image)return res.status(404).end();
  res.set('Content-Type',image.mime); res.set('Cache-Control','private, max-age=3600'); res.send(image.buffer);
}catch(e){next(e)}});
router.put('/users/:id/avatar',express.raw({type:['image/jpeg','image/png','image/webp'],limit:'2mb'}),...mutate,requireAdmin,async(req,res,next)=>{try{
  const target=await users.getUserById(Number(req.params.id));
  if(!target)return res.status(404).json({ok:false,error:'User not found.'});
  const user=await users.setAvatar(target.id,req.body,req.get('content-type'));
  await activity.record(req.currentUser.id,'profile_photo_updated',{targetUserId:user.id});
  res.json({ok:true,user});
}catch(e){next(e)}});
router.delete('/users/:id/avatar',...mutate,requireAdmin,async(req,res,next)=>{try{
  const target=await users.getUserById(Number(req.params.id));
  if(!target)return res.status(404).json({ok:false,error:'User not found.'});
  const user=await users.removeAvatar(target.id); await activity.record(req.currentUser.id,'profile_photo_removed',{targetUserId:user.id}); res.json({ok:true,user});
}catch(e){next(e)}});

router.get('/health',requireAdmin,async(req,res)=>{const checks=[
 {name:'Node.js',status:'pass',detail:process.version},
 {name:'Database environment',status:hasDbConfig()?'pass':'fail',detail:hasDbConfig()?'Configured':'Missing DB environment variables'},
 {name:'Database connection',status:state.dbReady?'pass':'fail',detail:state.dbReady?'Connected':(state.dbError||'Not connected')},
 {name:'Schema',status:state.schemaVersion>=20?'pass':'fail',detail:`Schema version ${state.schemaVersion||0}`},
 {name:'Frontend framework',status:'pass',detail:'Astro 7 + Express + separated Desktop Software (WinGet) and Android APK (LiteAPKs) workspaces'},
 {name:'User roles',status:'pass',detail:'Admin + Partner with database-enforced access controls'},
 {name:'Admin account',status:state.adminReady?'pass':'fail',detail:state.adminReady?'Ready':'Not initialized'},
 {name:'GitHub API token',status:hasToken()?'pass':'recommend',detail:hasToken()?'Configured':'Recommended for large WinGet discovery, old-version history and Windows update scans. LiteAPKs Android sync does not use GitHub.'}
];res.json({ok:true,checks})});
router.get('/backups/state',requireAdmin,async(req,res,next)=>{try{res.json({ok:true,backup:await backups.state()})}catch(e){next(e)}});
router.post('/backups/create',...mutate,requireAdmin,async(req,res,next)=>{try{
  const backup=await backups.createBackup('manual'); await activity.record(req.currentUser.id,'backup_created',{details:{kind:'manual',filename:backup.filename,fileSizeBytes:backup.fileSizeBytes}});
  await notifications.notifyUser(req.currentUser.id,{actorUserId:req.currentUser.id,type:'success',title:'Backup completed',message:`${backup.filename} is ready to download.`,dedupeKey:`manual-backup-${backup.id}`});
  res.json({ok:true,backup,state:await backups.state()});
}catch(e){next(e)}});
router.get('/backups/:id/download',requireAdmin,async(req,res,next)=>{try{
  const item=await backups.getBackupFile(Number(req.params.id));
  if(!item)return res.status(404).json({ok:false,error:'Backup file not found.'});
  await backups.markDownloaded(Number(req.params.id));
  res.download(item.filepath,item.filename);
}catch(e){next(e)}});
router.post('/backups/restore',express.raw({type:'application/octet-stream',limit:'100mb'}),...mutate,requireAdmin,async(req,res,next)=>{try{
  if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({ok:false,error:'Choose an HSWare JSON backup file first.'});
  let payload; try{payload=JSON.parse(req.body.toString('utf8'))}catch{return res.status(400).json({ok:false,error:'The selected file is not valid JSON.'})}
  const restored=await backups.restoreBackup(payload); await activity.record(req.currentUser.id,'backup_restored');
  await notifications.notifyUser(req.currentUser.id,{actorUserId:req.currentUser.id,type:'success',title:'Backup restored',message:'The HSWare workspace backup was restored successfully.'});
  res.json({ok:true,...restored,counts:await counts(),backup:await backups.state()});
}catch(e){next(e)}});

router.post('/logout',...mutate,async(req,res)=>{const userId=req.currentUser?.id;if(userId)await workClaims.releaseAllOwned(userId);req.session=null;if(userId)await activity.record(userId,'user_logout');res.json({ok:true})});

module.exports=router;
