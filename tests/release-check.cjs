const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
function loadModule(rel,stubs={},hook=''){
 const file=path.join(ROOT,rel),module={exports:{}};
 const context={module,exports:module.exports,require:id=>stubs[id]??require(id),Buffer,URL,URLSearchParams,AbortController,Response,Headers,fetch,console,setTimeout,clearTimeout,setInterval,clearInterval,Date,Math,Number,JSON,String,Promise,Array,Map,Set,RegExp,process,crypto:require('node:crypto')};
 vm.runInNewContext(fs.readFileSync(file,'utf8')+'\n'+hook,context,{filename:file});return {exports:module.exports,context};
}
function fakePool(){
 const data={sync:{sync_key:'apk-main',status:'idle',queue_json:'[]',run_id:null,processed_count:0,inserted_count:0,updated_count:0,failed_count:0,completion_notified:0},update:{scan_key:'apk-managed',status:'idle',queue_json:'[]',run_id:null,processed_count:0,update_count:0,failed_count:0,completion_notified:0},apps:[],media:[],settings:{},categories:[],sql:[]};
 const clone=x=>JSON.parse(JSON.stringify(x));
 const pool={data,async query(sql,args=[]){data.sql.push({sql,args});const s=sql.replace(/\s+/g,' ').trim(),lower=s.toLowerCase();let row=lower.includes('apk_update_state')?data.update:data.sync;
  if(/^select \* from apk_(?:sync|update)_state/.test(lower))return [[clone(row)]];
  if(lower.startsWith('insert into apk_sync_state')&&lower.includes('on duplicate key'))return [{affectedRows:1}];
  if(lower.startsWith('insert into apk_update_state')&&lower.includes('on duplicate key')){Object.assign(data.update,{run_id:args[1],requested_by:args[2],status:'running',queue_json:args[3],total_count:args[4],processed_count:0,update_count:0,failed_count:0,completion_notified:0,last_error:null});return [{affectedRows:1}]}

  if(lower.startsWith('update apk_sync_state')||lower.startsWith('update apk_update_state')){
   const runMatch=lower.match(/run_id=\?/g),guard=lower.includes('and run_id=?')?args.at(-1):null;
   if(guard&&guard!==row.run_id)return [{affectedRows:0}];
   if(lower.includes("where " )&&lower.split('where ')[1].includes("status='running'")&&row.status!=='running')return [{affectedRows:0}];
   if(lower.includes("where " )&&lower.split('where ')[1].includes("status='discovering'")&&row.status!=='discovering')return [{affectedRows:0}];
   if(lower.includes("status in ('running','discovering')")&&!['running','discovering'].includes(row.status))return [{affectedRows:0}];
   if(lower.includes("status in ('running','discovering','paused')")&&!['running','discovering','paused'].includes(row.status))return [{affectedRows:0}];
   if(lower.includes("status in ('running','paused')")&&!['running','paused'].includes(row.status))return [{affectedRows:0}];
   if(lower.includes("status='paused'")&&lower.split('where ')[1]?.includes("status='running'")&&row.status!=='running')return [{affectedRows:0}];
      if(lower.includes('completion_notified=1')){if(row.completion_notified||row.status!=='complete')return [{affectedRows:0}];row.completion_notified=1;return [{affectedRows:1}]}
   if(lower.includes('run_id=?,status=\'discovering\'')){Object.assign(row,{run_id:args[0],status:'discovering',mode:args[1],queue_json:'[]',total_count:0,processed_count:0,inserted_count:0,updated_count:0,failed_count:0,requested_by:args[2],completion_notified:0,last_error:null});}
   else if(lower.includes('status=?,queue_json=?'))Object.assign(row,{status:args[0],queue_json:args[1],total_count:args[2],last_error:null});
   else if(lower.includes('status=\'stopped\'')){row.status='stopped';row.current_url=null;row.current_app_id=null;}
   else if(lower.includes('status=\'paused\'')){row.status='paused';row.last_error=args[0]||'Interrupted';row.current_url=null;row.current_app_id=null;}
   else if(lower.includes('status=\'complete\'')){row.status='complete';row.current_url=null;row.current_app_id=null;}
   else if(lower.includes('current_url=?,queue_json=?')){row.current_url=args[0];row.queue_json=args[1]}
   else if(lower.includes('current_url=?'))row.current_url=args[0];
   else if(lower.includes('current_app_id=?'))row.current_app_id=args[0];
   else if(lower.includes('processed_count=processed_count+1')){row.queue_json=args[0];row.processed_count++;if(lower.includes('inserted_count=inserted_count+')){row.inserted_count+=args[1];row.updated_count+=args[2]}else if(lower.includes('update_count=update_count+'))row.update_count+=args[1];else row.failed_count++;row.current_url=null;row.current_app_id=null;}
   return [{affectedRows:1}];
  }
  if(lower.startsWith('select id from apps'))return [clone(data.apps.slice(0,args[0]||data.apps.length).map(({id})=>({id})))];
  if(lower.startsWith('select * from apps where id='))return [[clone(data.apps.find(x=>x.id===args[0])||null)]];
  if(lower.startsWith('select source_page_url from apps'))return [data.apps.map(x=>({source_page_url:x.source_page_url}))];
  if(lower.startsWith('select setting_value from settings'))return [[data.settings[args[0]]==null?null:{setting_value:data.settings[args[0]]}]];
  if(lower.startsWith('insert into settings')){data.settings[args[0]]=args[1];return [{affectedRows:1}]}
  if(lower.startsWith('select count(*) total,max(last_seen_at)'))return [[{total:data.categories.length,last_seen:null}]];
  if(lower.startsWith('select slug,parent_slug from apk_categories'))return [clone(data.categories.filter(x=>x.section===args[0]))];
  if(lower.startsWith('select section,name,slug from apk_categories'))return [[null]];
  if(lower.startsWith('insert into apk_categories')){if(args.length>=4){const [section,name,slug,url,parentSlug]=args;let c=data.categories.find(x=>x.slug===slug&&x.section===section);if(!c){c={section,name,slug,source_url:url,parent_slug:parentSlug||null};data.categories.push(c)}else Object.assign(c,{name,source_url:url,parent_slug:parentSlug||null});}return [{affectedRows:1}]}
  if(lower.startsWith('update apk_categories'))return [{affectedRows:1}];
  if(lower.startsWith('select c.section'))return [data.categories.map((c,i)=>({...c,source_url:c.source_url,parent_slug:c.parent_slug,sort_order:i,app_count:0}))];
  if(lower.startsWith('select count(*) total,sum(source_section='))return [[{total:data.apps.length,apps:data.apps.length,games:0}]];
  if(lower.startsWith('select * from apps where package_id='))return [[clone(data.apps.find(x=>x.package_id===args[0])||null)]];
  return [{affectedRows:1}];
 },async getConnection(){const snapshot=clone({apps:data.apps,media:data.media});return {async beginTransaction(){},async commit(){},async rollback(){data.apps=snapshot.apps;data.media=snapshot.media},release(){},async query(sql,args){return pool.query(sql,args)}}}};
 return pool;
}
function resolverHarness(pool,hook=''){
 const state={dbReady:true};
 const stubs={'../db':{getPool:()=>pool},'../state':state,'../config':{apkResolverMaxItems:50000,apkResolverRequestGapMs:700},'./activity':{record:async()=>{}},'./notifications':{notifyUser:async()=>{}},'../utils/version':{compareVersions:(a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true})},'./apk-source':require('../src/services/apk-source'),'cheerio':{load:()=>({})}};
 return loadModule('src/services/apk-resolver.js',stubs,hook);
}
const flush=()=>new Promise(r=>setTimeout(r,0));
test('source URLs refuse private/non-LiteAPKs destinations and redirects',async()=>{
 const source=require('../src/services/apk-source');
 for(const u of ['http://liteapks.com/app.html','https://liteapks.com.evil.test/a','https://127.0.0.1/a','https://user:pass@liteapks.com/a','file:///etc/passwd'])assert.equal(source.sourceUrl(u),null);
 await assert.rejects(source.fetchText('https://liteapks.com/a',{gapMs:1,fetchImpl:async()=>new Response('',{status:302,headers:{location:'https://127.0.0.1/private'}})}),e=>e.code==='SOURCE_REDIRECT');
});
test('403 and challenge stop immediately; 429 is bounded and never bypassed',async()=>{
 const source=require('../src/services/apk-source');let calls=0;
 await assert.rejects(source.fetchText('https://liteapks.com/a',{gapMs:1,fetchImpl:async()=>{calls++;return new Response('blocked',{status:403})}}),e=>e.code==='SOURCE_ACCESS_DENIED'&&e.status===403);assert.equal(calls,1);
 await assert.rejects(source.fetchText('https://liteapks.com/a',{gapMs:1,fetchImpl:async()=>new Response('<title>Just a moment...</title><div class="cf-turnstile"></div>')}),e=>e.code==='SOURCE_CHALLENGE');
 calls=0;await assert.rejects(source.fetchText('https://liteapks.com/a',{gapMs:1,fetchImpl:async()=>{calls++;return new Response('slow down',{status:429,headers:{'retry-after':'0'}})}}),e=>e.code==='SOURCE_RATE_LIMITED');assert.equal(calls,3);
});
test('manual import Stop during discovery cannot later restart or overwrite state',async()=>{
 const db=fakePool(),gate=deferred();const h=resolverHarness(db,'globalThis.setDiscover=fn=>{discoverForSync=fn};');h.context.setDiscover(async()=>gate.promise);
 const started=await h.exports.startSync({mode:'full',limit:5});assert.equal(started.status,'discovering');assert.equal(started.total_count,0);
 await h.exports.stopSync();gate.resolve(['https://liteapks.com/a.html']);await flush();await flush();
 assert.equal((await h.exports.getSyncState()).status,'stopped');assert.equal(db.data.sync.queue_json,'[]');await h.exports.step();assert.equal(db.data.sync.status,'stopped');
});
test('manual worker pauses 403 and preserves its queue; explicit new run recovers',async()=>{
 const db=fakePool();let fetchCount=0;const h=resolverHarness(db,'globalThis.setDiscover=fn=>{discoverForSync=fn};globalThis.setFetch=fn=>{fetchPackageDetails=fn};');
 h.context.setDiscover(async()=>['https://liteapks.com/a.html','https://liteapks.com/b.html']);h.context.setFetch(async()=>{fetchCount++;throw Object.assign(new Error('HTTP403 denied'),{code:'SOURCE_ACCESS_DENIED',status:403})});
 await h.exports.startSync({mode:'full',limit:2});await flush();await h.exports.step();let st=await h.exports.getSyncState();assert.equal(st.status,'paused');assert.equal(JSON.parse(st.queue_json).length,2);assert.equal(st.processed_count,0);await h.exports.step();assert.equal(fetchCount,1);
 await h.exports.startSync({mode:'full',limit:1});await flush();assert.equal((await h.exports.getSyncState()).status,'running');
});
test('an in-flight media refresh is transactional, targets one app, and preserves missing artwork',async()=>{
 const db=fakePool();db.data.apps=[{id:7,package_id:'liteapks:alpha',source_page_url:'https://liteapks.com/alpha.html',source_metadata_json:JSON.stringify({iconUrl:'https://images.test/old.png',coverImageUrl:'https://images.test/old-cover.png',screenshots:['https://images.test/shot.png']}),published:1,current_version:'2.0',category:'Tools'}];
 db.data.media=[{app_id:7,media_type:'cover',remote_url:'https://images.test/old-cover.png'},{app_id:7,media_type:'icon',remote_url:'https://images.test/old.png'}];
 const h=resolverHarness(db,'globalThis.setFetch=fn=>{fetchPackageDetails=fn};');
 let failed=false;const original=db.query.bind(db);db.query=async(sql,args)=>{if(sql.includes('INSERT INTO apk_media')&&failed)throw new Error('disk insert failed');return original(sql,args)};
 h.context.setFetch(async()=>({internalPackageId:'liteapks:alpha',metadata:{iconUrl:'https://images.test/new.png',screenshots:[]},category:'Other'}));
 // Use a connection which applies mutations to the in-memory fixture, so rollback is observable.
 db.getConnection=async()=>{let snap;return {beginTransaction:async()=>{snap=JSON.parse(JSON.stringify(db.data))},commit:async()=>{},rollback:async()=>{Object.assign(db.data,snap)},release:()=>{},query:async(sql,args)=>{if(sql.includes('INSERT INTO apk_media')){if(failed)throw new Error('disk insert failed');db.data.media.push({app_id:args[0],media_type:args[1],remote_url:args[2]});return[{affectedRows:1}]};if(sql.includes('DELETE FROM apk_media')){db.data.media=db.data.media.filter(x=>!(x.app_id===args[0]&&x.media_type===args[1]));return[{affectedRows:1}]};if(sql.includes('UPDATE apps SET source_metadata_json=')){Object.assign(db.data.apps[0],{source_metadata_json:args[0],metadata_status:'ready'});return[{affectedRows:1}]};return original(sql,args)}}};
 failed=true;await assert.rejects(h.exports.refreshMediaForApp(7),/disk insert failed/);assert.equal(db.data.media.length,2);assert.equal(db.data.apps[0].published,1);assert.equal(db.data.apps[0].current_version,'2.0');
 failed=false;const result=await h.exports.refreshMediaForApp(7);assert.equal(result.cover,true);assert.equal(result.screenshots,1);assert.equal(db.data.media.find(x=>x.media_type==='cover').remote_url,'https://images.test/old-cover.png');assert.equal(db.data.media.find(x=>x.media_type==='icon').remote_url,'https://images.test/new.png');assert.equal(db.data.apps[0].published,1);
});
test('existing saved taxonomy is reused without fetch; descendants include nested categories',async()=>{
 const db=fakePool();db.data.categories=[{section:'apps',name:'Apps',slug:'apps',parent_slug:null},{section:'apps',name:'Tools',slug:'tools',parent_slug:'apps',source_url:'https://liteapks.com/tools'},{section:'apps',name:'Utilities',slug:'utilities',parent_slug:'tools',source_url:'https://liteapks.com/utilities'}];
 const h=resolverHarness(db,'globalThis.setFetch=fn=>{fetchText=fn};');let calls=0;h.context.setFetch(async()=>{calls++;throw new Error('offline')});
 const result=await h.exports.refreshTaxonomy();assert.equal(result.skipped,true);assert.equal(calls,0);assert.deepEqual(Array.from(await h.exports.categoryDescendants('apps','tools')),['tools','utilities']);
 await assert.rejects(h.exports.refreshTaxonomy({force:true}),/offline|verified category/);assert.equal(db.data.categories.filter(x=>x.slug!=='apps'&&x.slug!=='games').length,2);
});
test('update engine is never started by idle step and Stop owns the active run',async()=>{
 const db=fakePool();db.data.apps=[{id:1,package_id:'liteapks:a',source_page_url:'https://liteapks.com/a.html',current_version:'1.0'}];const gate=deferred();let calls=0;
 const h=loadModule('src/services/apk-updates.js',{'../db':{getPool:()=>db},'./apk-resolver':{checkUpdateForApp:async()=>{calls++;return gate.promise},markUpdated:async()=>{}},'./activity':{record:async()=>{}},'./notifications':{notifyUser:async()=>{}}});
 assert.equal((await h.exports.step()).status,'idle');assert.equal(calls,0);
 await h.exports.start(null,1);const running=h.exports.step();await flush();await h.exports.stop();gate.resolve({available:true});await running;assert.equal((await h.exports.state()).status,'stopped');assert.equal(db.data.update.processed_count,0);
});
