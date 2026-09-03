const { Router, raw } = require('../compat/router');
const config = require('../config');
const state = require('../state');
const { getPool, hasDbConfig } = require('../db');
const { requireAuth, requireActiveUser, requireAdmin } = require('../middleware/auth');
const requireDb = require('../middleware/db-ready');
const { verifyToken } = require('../middleware/csrf');
const imports = require('../services/imports');
const updates = require('../services/updates');
const catalog = require('../services/catalog');
const { prepareSoftware, backfillVersionDates, logoSelectionCandidates } = require('../services/winget');
const { queueSoftware } = require('../services/enrichment');
const { hasToken } = require('../services/github');
const { compareVersions } = require('../utils/version');
const maintenance = require('../services/maintenance');
const backups = require('../services/backups');
const users = require('../services/users');
const workClaims = require('../services/work-claims');
const activity = require('../services/activity');
const notifications = require('../services/notifications');
const { safeFetch } = require('../services/remote');
const { validateSvgBuffer } = require('../services/safe-svg');
const { withRequirementFallbacks } = require('../services/requirements');
const healthChecks = require('../services/health-checks');
const reliability = require('../services/reliability');

const router = Router();
router.use(requireAuth, requireDb, requireActiveUser);
const mutate = [verifyToken];

function parseTags(value) {
  if (!value) return [];
  try { const out = JSON.parse(value); return Array.isArray(out) ? out : []; } catch { return []; }
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
  const checks = [
    r.name, r.package_id, r.category, r.publisher, r.current_version, r.official_url,
    r.installer_url, r.architecture, r.installer_type, r.sha256, r.description
  ];
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
    id:Number(r.id), packageId:r.package_id, name:r.name, publisher:r.publisher||'', developer:r.developer_name||r.author||r.publisher||'', author:r.author||'', version:r.current_version||'', category:r.category||'Uncategorized',
    published:Boolean(r.published), priority:r.priority_rank==null?null:Number(r.priority_rank), demandScore:r.demand_score==null?null:Number(r.demand_score), description:r.description||null,
    officialUrl:r.official_url||null, installerUrl:r.installer_url||null, architecture:r.architecture||null, installerType:r.installer_type||null,
    language:req.language, platform:req.platform, processor:req.processor, minimumOsVersion:req.minimumOsVersion,
    ramRequirement:req.ramRequirement, storageRequirement:req.storageRequirement, graphicsRequirement:req.graphicsRequirement, requirementEstimates:req.estimated, requirementsSourceUrl:r.requirements_source_url||null,
    downloadCount:r.download_count==null?null:Number(r.download_count), downloadCountSource:r.download_count_source||null,
    sha256:r.sha256||null, fileSizeBytes:r.file_size_bytes==null?null:Number(r.file_size_bytes), currentReleaseDate:dateOnly(r.release_date), currentReleaseDateSource:r.release_date_source||null,
    logoUrl:r.logo_url||null, logoSource:r.logo_source||null, logoConfidence:r.logo_confidence==null?null:Number(r.logo_confidence),
    logoWidth:r.logo_width==null?null:Number(r.logo_width), logoHeight:r.logo_height==null?null:Number(r.logo_height), logoFormat:r.logo_format||null, logoQuality:r.logo_quality||null, logoExportSize:r.logo_export_size==null?null:Number(r.logo_export_size),
    latestVersion:r.latest_version||null, latestInstallerUrl:r.latest_installer_url||null,
    latestFileSizeBytes:r.latest_file_size_bytes==null?null:Number(r.latest_file_size_bytes), latestReleaseDate:dateOnly(r.latest_release_date),
    updateAvailable:Boolean(r.update_available), lastCheckedAt:r.last_checked_at||null, updateError:r.update_error||null,
    enrichmentStatus:r.enrichment_status||'pending', metadataRevision:Number(r.metadata_revision||0), enrichmentError:r.enrichment_error||null, enrichedAt:r.enriched_at||null,
    enrichmentAttempts:Number(r.enrichment_attempts||0), lastEnrichmentAttemptAt:r.last_enrichment_attempt_at||null,
    linkStatus:r.link_status||'unknown', linkCheckedAt:r.link_checked_at||null, createdAt:r.created_at||null,
    importedAt:r.workspace_added_at||r.created_at||null, publishedAt:r.published_at||null, lastOpenedAt:r.last_opened_at||null,
    licenseName:r.license_name||null, tags:parseTags(r.tags_json), completeness:completeness(r),
    claim: claimFromSoftwareRow(r)
  };
}
function softwareListJson(r) {
  return {
    id:Number(r.id), packageId:r.package_id, name:r.name, publisher:r.publisher||'', version:r.current_version||'',
    category:r.category||'Uncategorized', published:Boolean(r.published),
    priority:r.priority_rank==null?null:Number(r.priority_rank), demandScore:r.demand_score==null?null:Number(r.demand_score),
    installerUrl:r.installer_url||null, logoUrl:r.logo_url||null,
    latestVersion:r.latest_version||null, updateAvailable:Boolean(r.update_available),
    enrichmentStatus:r.enrichment_status||'pending', enrichmentError:r.enrichment_error||null,
    importedAt:r.workspace_added_at||r.created_at||null, publishedAt:r.published_at||null, createdAt:r.created_at||null,
    completeness:Number(r.list_completeness||0), claim:claimFromSoftwareRow(r)
  };
}

async function counts() {
  const db = getPool();
  const [summaryResult, catalogCounts] = await Promise.all([
    db.query(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(published=0),0) AS unpublished,
      COALESCE(SUM(published=1),0) AS published,
      COALESCE(SUM(enrichment_status='ready' AND current_version IS NOT NULL AND installer_url IS NOT NULL AND installer_url<>''),0) AS ready,
      COALESCE(SUM(update_available=1),0) AS updates,
      COUNT(DISTINCT NULLIF(publisher,'')) AS active_publishers
      FROM software WHERE workspace_added=1`),
    catalog.counts()
  ]);
  const summary=summaryResult[0]?.[0]||{};
  return {
    total:Number(summary.total||0), unpublished:Number(summary.unpublished||0), published:Number(summary.published||0),
    ready:Number(summary.ready||0), updates:Number(summary.updates||0), activePublishers:Number(summary.active_publishers||0),
    catalog:Number(catalogCounts.catalog||0)
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
    ok:true, appVersion:config.appVersion, csrfToken:req.session.csrfToken, user, counts:await counts(),
    config:{
      autoImportMax:imports.MAX_AUTO_TARGET,catalogTarget:config.catalogTarget,mediaEnabled:false,adminPath:config.adminPath,
      ...(isAdmin?{githubConfigured:hasToken(),nodeEnv:config.nodeEnv,dbName:config.db.database}: {})
    },
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
  const db=getPool();
  await workClaims.pruneStaleClaims(db);
  const scope=['unpublished','published','updates','all'].includes(String(req.query.scope||''))?String(req.query.scope):'all';
  const q=String(req.query.q||'').trim().slice(0,160);
  const category=String(req.query.category||'all').trim().slice(0,120);
  const filter=String(req.query.filter||'newest').trim().slice(0,40);
  const limit=Math.max(25,Math.min(200,Number(req.query.limit)||100));
  const page=Math.max(1,Math.min(100000,Number(req.query.page)||1));
  const offset=(page-1)*limit;
  let baseWhere='s.workspace_added=1';
  const baseParams=[];
  if(scope==='unpublished')baseWhere+=' AND s.published=0';
  else if(scope==='published')baseWhere+=' AND s.published=1';
  else if(scope==='updates')baseWhere+=' AND s.published=1 AND s.update_available=1';
  let where=baseWhere;
  const params=[...baseParams];
  if(q){where+=' AND (s.name LIKE ? OR s.package_id LIKE ? OR s.publisher LIKE ? OR s.category LIKE ?)';for(let i=0;i<4;i++)params.push(`%${q}%`)}
  if(category&&category!=='all'){where+=" AND COALESCE(NULLIF(s.category,''),'Uncategorized')=?";params.push(category)}
  const yearMatch=filter.match(/^year-(\d{4})$/);
  const dateExpr=scope==='published'||scope==='updates'?'COALESCE(s.published_at,s.workspace_added_at,s.created_at)':'COALESCE(s.workspace_added_at,s.created_at)';
  if(yearMatch){where+=` AND YEAR(${dateExpr})=?`;params.push(Number(yearMatch[1]))}
  if(filter==='ready')where+=" AND s.enrichment_status='ready' AND s.installer_url IS NOT NULL AND s.installer_url<>''";
  else if(filter==='pending')where+=" AND (s.enrichment_status<>'ready' OR s.installer_url IS NULL OR s.installer_url='')";
  else if(filter==='updates')where+=' AND s.update_available=1';
  else if(filter==='popular')where+=' AND s.priority_rank IS NOT NULL';
  else if(filter==='most-popular')where+=' AND s.priority_rank IS NOT NULL AND s.priority_rank<=100';
  else if(filter==='high-demand')where+=' AND s.demand_score IS NOT NULL';
  let order;
  if(scope==='updates')order='s.last_checked_at DESC,s.id DESC';
  else if(filter==='popular'||filter==='most-popular')order=`${scope==='published'?'s.update_available DESC,':''} s.priority_rank ASC,${dateExpr} DESC,s.id DESC`;
  else if(filter==='high-demand')order=`${scope==='published'?'s.update_available DESC,':''} s.demand_score DESC,${dateExpr} DESC,s.id DESC`;
  else order=`${scope==='published'?'s.update_available DESC,':''} ${dateExpr} DESC,s.id DESC`;
  const completenessExpr=`ROUND((
    (s.name IS NOT NULL AND s.name<>'')+(s.package_id IS NOT NULL AND s.package_id<>'')+(s.category IS NOT NULL AND s.category<>'')+
    (s.publisher IS NOT NULL AND s.publisher<>'')+(s.current_version IS NOT NULL AND s.current_version<>'')+(s.official_url IS NOT NULL AND s.official_url<>'')+
    (s.installer_url IS NOT NULL AND s.installer_url<>'')+(s.architecture IS NOT NULL AND s.architecture<>'')+(s.installer_type IS NOT NULL AND s.installer_type<>'')+
    (s.sha256 IS NOT NULL AND s.sha256<>'')+(s.description IS NOT NULL AND s.description<>'')
  )/11*100)`;
  const listSql=`SELECT s.id,s.package_id,s.name,s.publisher,s.category,s.current_version,s.installer_url,s.published,s.priority_rank,s.demand_score,
    s.logo_url,s.enrichment_status,s.enrichment_error,s.update_available,s.latest_version,s.workspace_added_at,s.published_at,s.created_at,
    ${completenessExpr} AS list_completeness,
    c.user_id AS work_claim_user_id,c.claimed_at AS work_claimed_at,c.last_heartbeat_at AS work_claim_heartbeat_at,
    cu.name AS work_claim_user_name,cu.role AS work_claim_user_role
    FROM software s LEFT JOIN software_work_claims c ON c.software_id=s.id LEFT JOIN users cu ON cu.id=c.user_id
    WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const facetDateExpr=scope==='published'||scope==='updates'?'COALESCE(s.published_at,s.workspace_added_at,s.created_at)':'COALESCE(s.workspace_added_at,s.created_at)';
  const [countResult,listResult,categoryResult,yearResult]=await Promise.all([
    db.query(`SELECT COUNT(*) c FROM software s WHERE ${where}`,params),
    db.query(listSql,[...params,limit,offset]),
    scope==='updates'?Promise.resolve([[]]):db.query(`SELECT COALESCE(NULLIF(s.category,''),'Uncategorized') name,COUNT(*) count FROM software s WHERE ${baseWhere} GROUP BY COALESCE(NULLIF(s.category,''),'Uncategorized') ORDER BY name`,baseParams),
    scope==='updates'?Promise.resolve([[]]):db.query(`SELECT YEAR(${facetDateExpr}) year,COUNT(*) count FROM software s WHERE ${baseWhere} AND ${facetDateExpr} IS NOT NULL GROUP BY YEAR(${facetDateExpr}) ORDER BY year DESC LIMIT 8`,baseParams)
  ]);
  const total=Number(countResult[0]?.[0]?.c||0);
  const rows=listResult[0]||[];
  res.json({
    ok:true,results:rows.map(softwareListJson),total,page,limit,hasMore:offset+rows.length<total,
    categories:(categoryResult[0]||[]).map(x=>({name:x.name,count:Number(x.count||0)})),
    years:(yearResult[0]||[]).map(x=>String(x.year||'')).filter(Boolean)
  });
}catch(e){next(e)}});

router.get('/work-claims',async(req,res,next)=>{try{res.json({ok:true,claims:await workClaims.listActiveClaims(),timeoutSeconds:workClaims.LOCK_TIMEOUT_SECONDS})}catch(e){next(e)}});

router.get('/software/:id', async(req,res,next)=>{try{
  const db=getPool(); const r=await softwareRow(req.params.id);
  if(!r)return res.status(404).json({ok:false,error:'Software not found.'});
  await backfillVersionDates(Number(r.id));
  const [versionsRaw]=await db.query('SELECT * FROM software_versions WHERE software_id=?',[r.id]);
  const versions=versionsRaw.sort((a,b)=>compareVersions(b.version,a.version)).filter(v=>String(v.version)!==String(r.current_version||'')).slice(0,5);
  const [[queue]]=await db.query('SELECT status,last_error,updated_at,completed_at FROM enrichment_queue WHERE software_id=? LIMIT 1',[r.id]);
  await db.query('UPDATE software SET last_opened_at=NOW() WHERE id=?',[r.id]);
  const out=softwareJson(r);
  out.versions=versions.map(v=>({id:Number(v.id),version:v.version,installerUrl:v.installer_url,fileSizeBytes:v.file_size_bytes==null?null:Number(v.file_size_bytes),updatedDate:dateOnly(v.release_date),updatedDateSource:v.release_date_source||null,architecture:v.architecture,installerType:v.installer_type,sha256:v.sha256}));
  out.completeness=completeness(r,versions.length);
  out.backgroundStatus=queue?.status||'idle';
  const enrichedAt=r.enriched_at?new Date(r.enriched_at).getTime():0;
  const stale=!enrichedAt || (Date.now()-enrichedAt)>(24*60*60*1000);
  const needsMetadataRevision=Number(r.metadata_revision||0)<11;
  const historyCount=versions.length;
  const historyCompletedAt=queue?.completed_at?new Date(queue.completed_at).getTime():0;
  const historyRetryMs=historyCount===0?12*60*60*1000:3*24*60*60*1000;
  const historyRetryDue=historyCount<5&&(!historyCompletedAt||(Date.now()-historyCompletedAt)>historyRetryMs);
  const queueBusy=['queued','running'].includes(String(queue?.status||''));
  const currentRefreshNeeded=r.enrichment_status!=='ready'||!r.current_version||!r.installer_url||needsMetadataRevision;
  const historyRefreshNeeded=historyRetryDue&&!queueBusy;
  out.historyCount=historyCount;
  out.historyRefreshPending=Boolean(historyCount<5&&(queueBusy||historyRefreshNeeded));
  out.needsRefresh=Boolean(currentRefreshNeeded||stale||historyRetryDue);
  if(currentRefreshNeeded||historyRefreshNeeded) queueSoftware(Number(r.id)).catch(()=>{});
  res.json({ok:true,software:out});
}catch(e){next(e)}});


router.get('/software/:id/logo-candidates', async(req,res,next)=>{try{
  const r=await softwareRow(req.params.id);
  if(!r)return res.status(404).json({ok:false,error:'Software not found.'});
  const candidates=await logoSelectionCandidates(r,{force:String(req.query.refresh||'')==='1'});
  res.set('Cache-Control','private, max-age=300');
  res.json({ok:true,candidates:candidates.map(c=>({...c,url:undefined,previewUrl:c.available?`/api/software/${Number(r.id)}/logo-candidate/${encodeURIComponent(c.key)}`:null}))});
}catch(e){next(e)}});

router.get('/software/:id/logo-candidate/:source', async(req,res,next)=>{try{
  const r=await softwareRow(req.params.id);
  if(!r)return res.status(404).json({ok:false,error:'Software not found.'});
  const source=String(req.params.source||'');
  const allowed=['logo-dev-webp','logos-apps-svg','official-site-logo','winget-manifest-logo','dashboard-icons-svg','selfhst-svg'];
  if(!allowed.includes(source))return res.status(404).json({ok:false,error:'Icon source not found.'});
  const candidates=await logoSelectionCandidates(r);
  const candidate=candidates.find(c=>c.key===source&&c.available&&c.url);
  if(!candidate)return res.status(404).json({ok:false,error:'This icon source has no exact match for the software.'});
  const remote=await safeFetch(candidate.url,{maxBytes:8*1024*1024,accept:'image/png,image/jpeg,image/webp,image/svg+xml,image/gif,image/x-icon,image/vnd.microsoft.icon,image/*;q=0.9,*/*;q=0.1'});
  const type=String(remote.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  const body=remote.buffer.toString('utf8',0,Math.min(remote.buffer.length,2048));
  const looksSvg=type==='image/svg+xml'||/<svg\b/i.test(body);
  if(candidate.downloadFormat==='svg'&&!looksSvg)return res.status(415).json({ok:false,error:'This icon source is not a vector SVG.'});
  if(!looksSvg&&!/^image\/(png|jpeg|jpg|webp|gif|x-icon|vnd\.microsoft\.icon)$/i.test(type)){
    return res.status(415).json({ok:false,error:'Icon source did not return a supported image.'});
  }
  const output=looksSvg?validateSvgBuffer(remote.buffer):remote.buffer;
  res.set('Content-Type',looksSvg?'image/svg+xml; charset=utf-8':type);
  res.set('Cache-Control','private, max-age=3600');
  res.set('X-Content-Type-Options','nosniff');
  if(looksSvg)res.set('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'none'; img-src 'none';");
  res.set('X-HSWare-Output-Format',String(candidate.downloadFormat||''));
  res.send(output);
}catch(e){next(e)}});

router.get('/software/:id/logo-file', async(req,res,next)=>{try{
  const r=await softwareRow(req.params.id);
  if(!r)return res.status(404).json({ok:false,error:'Software not found.'});
  const logoUrl=String(r.logo_url||'').trim();
  if(!/^https?:\/\//i.test(logoUrl))return res.status(404).json({ok:false,error:'Trusted software logo is not available.'});
  const remote=await safeFetch(logoUrl,{maxBytes:8*1024*1024,accept:'image/png,image/jpeg,image/webp,image/svg+xml,image/*;q=0.9,*/*;q=0.1'});
  const type=String(remote.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(!/^image\/(png|jpeg|jpg|webp|svg\+xml|gif|x-icon|vnd\.microsoft\.icon)$/i.test(type)){
    return res.status(415).json({ok:false,error:'Trusted logo source did not return an image.'});
  }
  const looksSvg=type==='image/svg+xml'||/<svg\b/i.test(remote.buffer.toString('utf8',0,Math.min(remote.buffer.length,2048)));
  const output=looksSvg?validateSvgBuffer(remote.buffer):remote.buffer;
  res.set('Content-Type',looksSvg?'image/svg+xml; charset=utf-8':type);
  res.set('Cache-Control','private, max-age=3600');
  res.set('X-Content-Type-Options','nosniff');
  if(looksSvg)res.set('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'none'; img-src 'none';");
  if(r.logo_width)res.set('X-HSWare-Logo-Width',String(r.logo_width));
  if(r.logo_height)res.set('X-HSWare-Logo-Height',String(r.logo_height));
  if(r.logo_quality)res.set('X-HSWare-Logo-Quality',String(r.logo_quality));
  if(r.logo_export_size)res.set('X-HSWare-Logo-Export-Size',String(r.logo_export_size));
  res.send(output);
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
  if(value===1 && (!s.current_version || !s.installer_url || s.enrichment_status!=='ready')){
    const prep=await prepareSoftware(Number(s.id));
    [[s]]=await db.query('SELECT * FROM software WHERE id=?',[s.id]);
    if(!s.current_version || !s.installer_url){
      return res.status(409).json({ok:false,error:prep.warning || 'Verified version and installer link are required before publishing. Open the software and retry details.'});
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
router.post('/software/:id/refresh-update',...mutate,async(req,res,next)=>{try{
  const id=Number(req.params.id);
  await workClaims.ensureNotOwnedByOther(id,req.currentUser);
  const meta=await updates.refreshOne(id);
  await activity.record(req.currentUser.id,'software_update_metadata_refreshed',{softwareId:id,details:{version:meta.version,fileSizeBytes:meta.fileSizeBytes,releaseDate:meta.releaseDate}});
  const fresh=await softwareRow(id);
  res.json({ok:true,software:softwareJson(fresh),metadata:meta});
}catch(e){if(e.status===423)return lockedResponse(res,e.claim);next(e)}});

router.post('/software/:id/mark-updated',...mutate,async(req,res,next)=>{try{
  const id=Number(req.params.id);
  await workClaims.ensureNotOwnedByOther(id,req.currentUser);
  const applied=await updates.markUpdated(id);

  // These are post-commit housekeeping actions. None may turn a successful
  // update into a browser-visible failure after the database already changed.
  const sideEffects=[
    workClaims.releaseOwned(id,req.currentUser.id),
    activity.record(req.currentUser.id,'software_marked_updated',{softwareId:id,details:{version:applied?.version||null}})
  ];
  if(req.currentUser.role==='partner')sideEffects.push((async()=>{
    const [[sw]]=await getPool().query('SELECT name,package_id FROM software WHERE id=? LIMIT 1',[id]);
    await notifications.notifyAdmins({actorUserId:req.currentUser.id,type:'info',title:'Software updated',message:`${req.currentUser.name||'Partner'} marked ${sw?.name||sw?.package_id||'software'} updated.`,softwareId:id},{exceptUserId:req.currentUser.id});
  })());
  const settled=await Promise.allSettled(sideEffects);
  for(const item of settled)if(item.status==='rejected')console.warn('[HSWare] Mark Updated post-commit action:',String(item.reason?.message||item.reason).slice(0,300));

  res.json({ok:true,applied});
}catch(e){if(e.status===423)return lockedResponse(res,e.claim);next(e)}});

router.get('/import/manual/search',async(req,res,next)=>{try{
  const q=String(req.query.q||'').trim();
  res.json({ok:true,results:q?await imports.searchCandidates(q):[]});
}catch(e){next(e)}});
router.post('/import/manual',...mutate,async(req,res,next)=>{try{
  const packageId=String(req.body.packageId||'').trim();
  const job=await imports.startSingleImport(packageId,req.currentUser.id,'manual');
  res.status(job.existing?200:202).json({ok:true,job,id:job.software_id?Number(job.software_id):null,queued:!job.existing});
}catch(e){next(e)}});
router.get('/import/single/:id',async(req,res,next)=>{try{
  const job=await imports.singleImportJob(Number(req.params.id));
  if(!job)return res.status(404).json({ok:false,error:'Import job not found.'});
  if(Number(job.requested_by||0)!==Number(req.currentUser.id||0)&&req.currentUser.role!=='admin')return res.status(403).json({ok:false,error:'Not allowed.'});
  res.json({ok:true,job});
}catch(e){next(e)}});

router.post('/import/auto/start',...mutate,async(req,res,next)=>{try{const job=await imports.startAutoImport(req.body.count,req.body.installerFormat,req.currentUser.id);await activity.record(req.currentUser.id,'auto_import_started',{details:{count:req.body.count,installerFormat:req.body.installerFormat}});res.json({ok:true,job})}catch(e){next(e)}});
router.post('/import/auto/stop',...mutate,async(req,res,next)=>{try{const job=await imports.stopAutoImport();await activity.record(req.currentUser.id,'auto_import_stopped');res.json({ok:true,job})}catch(e){next(e)}});
router.post('/import/auto/step',...mutate,async(req,res,next)=>{try{res.json({ok:true,job:await imports.stepAutoImport()})}catch(e){next(e)}});
router.get('/import/auto/state',async(req,res,next)=>{try{res.json({ok:true,job:await imports.currentJob()})}catch(e){next(e)}});

router.post('/workspace/clear-new',...mutate,requireAdmin,async(req,res,next)=>{try{const result=await maintenance.clearNewSoftware();await activity.record(req.currentUser.id,'new_software_cleared');res.json({ok:true,...result})}catch(e){next(e)}});
router.post('/maintenance/reset-all',...mutate,requireAdmin,async(req,res,next)=>{try{
  if(String(req.body.confirm||'')!=='RESET')return res.status(400).json({ok:false,error:'Type RESET to confirm.'});
  const safetyBackup=await backups.createBackup('safety');
  await maintenance.resetAllData();
  await activity.record(req.currentUser.id,'software_data_reset',{details:{safetyBackupId:safetyBackup.id,safetyBackupFilename:safetyBackup.filename}});
  res.json({ok:true,cleared:true,safetyBackup});
}catch(e){next(e)}});



router.get('/catalog',async(req,res,next)=>{try{
  // Do not block Catalog rendering on full-index classification. Kick the
  // self-healing 200-category rebalance in the background when needed.
  catalog.ensureCatalogExpansion().catch(()=>{});
  res.json({ok:true,...await catalog.listCatalog({q:req.query.q,status:req.query.status,category:req.query.category,pricing:req.query.pricing,page:req.query.page,limit:req.query.limit,sort:req.query.sort})});
}catch(e){next(e)}});
router.get('/catalog/state',async(req,res,next)=>{try{res.json({ok:true,counts:await catalog.counts(),state:await catalog.getSyncState(),expansion:await catalog.getExpansionState()})}catch(e){next(e)}});
router.get('/catalog/expansion/state',requireAdmin,async(req,res,next)=>{try{res.json({ok:true,state:await catalog.getExpansionState(),counts:await catalog.counts()})}catch(e){next(e)}});
router.post('/catalog/expansion/rebuild',...mutate,requireAdmin,async(req,res,next)=>{try{const result=await catalog.rebalanceCatalogExpansion(config.catalogTarget);await activity.record(req.currentUser.id,'catalog_expansion_rebuilt',{details:{target:result.target,selected:result.selected,processed:result.processed}});res.json({ok:true,result,state:await catalog.getExpansionState(),counts:await catalog.counts()})}catch(e){next(e)}});
router.post('/catalog/sync/start',...mutate,async(req,res,next)=>{try{const state=await catalog.startSync(req.body?.target||config.catalogTarget);await activity.record(req.currentUser.id,'catalog_sync_started',{details:{target:state.target_count}});res.json({ok:true,state,counts:await catalog.counts()})}catch(e){next(e)}});
router.post('/catalog/sync/resume',...mutate,async(req,res,next)=>{try{res.json({ok:true,state:await catalog.resumeSync(),counts:await catalog.counts()})}catch(e){next(e)}});
router.post('/catalog/sync/step',...mutate,async(req,res,next)=>{try{res.json({ok:true,...await catalog.syncStep()})}catch(e){next(e)}});
router.post('/catalog/:packageId/import',...mutate,async(req,res,next)=>{try{
  const packageId=decodeURIComponent(String(req.params.packageId||'')).trim();
  const job=await imports.startSingleImport(packageId,req.currentUser.id,'catalog');
  res.status(job.existing?200:202).json({ok:true,job,id:job.software_id?Number(job.software_id):null,queued:!job.existing});
}catch(e){next(e)}});
router.post('/updates/start',...mutate,async(req,res,next)=>{try{const scan=await updates.start(req.currentUser.id,'published');updates.wakeUpdateWorker();res.json({ok:true,state:scan})}catch(e){next(e)}});
router.post('/updates/step',...mutate,async(req,res,next)=>{try{res.json({ok:true,state:await updates.step()})}catch(e){next(e)}});
router.get('/updates/state',async(req,res,next)=>{try{res.json({ok:true,state:await updates.state()})}catch(e){next(e)}});

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
router.put('/users/:id/avatar',raw({type:['image/jpeg','image/png','image/webp'],limit:'2mb'}),...mutate,requireAdmin,async(req,res,next)=>{try{
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

router.get('/health',requireAdmin,async(req,res,next)=>{try{const checks=await healthChecks.getHealthChecks();const workers=state.dbReady?await reliability.listWorkerHealth():[];res.json({ok:true,appVersion:config.appVersion,checks,workers})}catch(e){next(e)}});
router.get('/backups/state',requireAdmin,async(req,res,next)=>{try{res.json({ok:true,backup:await backups.state()})}catch(e){next(e)}});
router.get('/backups/google/connect',requireAdmin,async(req,res,next)=>{try{
  res.json({ok:true,url:await backups.googleDrive.authorizationUrl(req)});
}catch(e){next(e)}});
router.get('/backups/google/callback',requireAdmin,async(req,res,next)=>{try{
  await backups.googleDrive.handleCallback(req);
  res.redirect(`${config.adminPath}?backup=google-connected`);
}catch(e){next(e)}});
router.post('/backups/google/disconnect',...mutate,requireAdmin,async(req,res,next)=>{try{
  res.json({ok:true,googleDrive:await backups.googleDrive.disconnect(),backup:await backups.state()});
}catch(e){next(e)}});
router.post('/backups/:id/google-upload',...mutate,requireAdmin,async(req,res,next)=>{try{
  const drive=await backups.uploadBackupToDrive(Number(req.params.id));
  res.json({ok:true,drive,backup:await backups.state()});
}catch(e){next(e)}});
router.post('/backups/create',...mutate,requireAdmin,async(req,res,next)=>{try{
  const backup=await backups.createBackup('manual'); await activity.record(req.currentUser.id,'backup_created',{details:{kind:'manual',filename:backup.filename,fileSizeBytes:backup.fileSizeBytes,softwareCount:backup.softwareCount,versionCount:backup.versionCount,driveStatus:backup.drive?.status}});
  const cloudText=backup.drive?.status==='uploaded'?' Google Drive upload completed.':backup.drive?.status==='error'?' Local JSON is safe; Google Drive will retry automatically.':'';
  await notifications.notifyUser(req.currentUser.id,{actorUserId:req.currentUser.id,type:'success',title:'Backup completed',message:`${backup.filename} contains the current published-software snapshot.${cloudText}`,dedupeKey:`manual-backup-${backup.id}`});
  res.json({ok:true,backup,state:await backups.state()});
}catch(e){next(e)}});
router.get('/backups/:id/download',requireAdmin,async(req,res,next)=>{try{
  const item=await backups.getBackupFile(Number(req.params.id));
  if(!item)return res.status(404).json({ok:false,error:'Backup file not found.'});
  await backups.markDownloaded(Number(req.params.id));
  res.download(item.filepath,item.filename);
}catch(e){next(e)}});
router.post('/backups/restore',raw({type:'application/octet-stream',limit:'100mb'}),...mutate,requireAdmin,async(req,res,next)=>{try{
  if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({ok:false,error:'Choose an HSWare JSON backup file first.'});
  let payload; try{payload=JSON.parse(req.body.toString('utf8'))}catch{return res.status(400).json({ok:false,error:'The selected file is not valid JSON.'})}
  const restored=await backups.restoreBackup(payload); await activity.record(req.currentUser.id,'backup_restored');
  await notifications.notifyUser(req.currentUser.id,{actorUserId:req.currentUser.id,type:'success',title:'Backup restored',message:'The HSWare workspace backup was restored successfully.'});
  res.json({ok:true,...restored,counts:await counts(),backup:await backups.state()});
}catch(e){next(e)}});

router.post('/logout',...mutate,async(req,res)=>{const userId=req.currentUser?.id;if(userId)await workClaims.releaseAllOwned(userId);req.session=null;if(userId)await activity.record(userId,'user_logout');res.json({ok:true})});

module.exports=router;
