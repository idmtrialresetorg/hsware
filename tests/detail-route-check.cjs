const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const {slugify,appSlug,appIdFromSlug}=require('../src/utils/app-slug');
test('readable slugs are stable, unique by stored ID, and reject malformed IDs',()=>{
 assert.equal(appSlug({id:7,name:'Binance'}),'binance-7');
 assert.equal(appSlug({id:8,name:'Binance'}),'binance-8');
 assert.equal(appIdFromSlug('binance-7'),7);
 assert.equal(appIdFromSlug('7'),7);
 assert.equal(appIdFromSlug('binance-7/extra'),null);
 assert.equal(appIdFromSlug('binance--7'),null);
 assert.equal(appIdFromSlug('binance-9007199254740992'),null);
 assert.equal(appSlug({id:1,name:'Café & Music'}),'cafe-music-1');
 assert.equal(slugify('日本語'),'android-app');
});
test('the existing production shell accepts canonical and legacy app paths',async()=>{
 const {handler}=await import('../dist/server/entry.mjs');
 function dispatch(url){let status=0,html='',next=false;handler({originalUrl:url},{status(n){status=n;return this},type(){return this},send(s){html=s;return this}},()=>{next=true});return{status,html,next}}
 for(const url of ['/apps/binance-7','/apps/7','/apps/cafe-music-123','/library/add']){
  const r=dispatch(url);assert.equal(r.status,200);assert.match(r.html,/\/ui\/app\.js/);
 }
 assert.equal(dispatch('/apps/../../etc/passwd').next,true);
 assert.equal(dispatch('/apps/binance-7/extra').next,true);
});
function mockApi(){
 const routes=[];let selected=null;
 const noop=(req,res,next)=>next?.();
 const router={use(){},get(path,...handlers){routes.push({method:'GET',path,handler:handlers.at(-1)})},post(path,...handlers){routes.push({method:'POST',path,handler:handlers.at(-1)})},delete(path,...handlers){routes.push({method:'DELETE',path,handler:handlers.at(-1)})}};
 const row={id:7,name:'Binance',package_id:'liteapks:binance',source_package_id:'com.binance.dev',source_page_url:'https://liteapks.com/binance.html',source_metadata_json:JSON.stringify({playStoreUrl:'https://play.google.com/store/apps/details?id=com.binance.dev',directDownloadUrl:'https://example.test/file.apk'}),current_version:'3.19.5',category:'Finance'};
 const pool={query:async sql=>sql.includes('SELECT media_type')?[[]]:[[row]]};
 const handlers={getPool:()=>pool,hasDbConfig:()=>true,pruneStaleClaims:async()=>{},ensureNotOwnedByOther:async()=>{},refreshMediaForApp:async(id,options)=>{selected={id,options};return{icon:true,cover:true,screenshots:2}}};
 const stub=id=>{
  if(id==='express')return{Router:()=>router,raw:()=>noop};
  if(id==='../db')return{getPool:handlers.getPool,hasDbConfig:handlers.hasDbConfig};
  if(id==='../state')return{dbReady:true,schemaVersion:123};
  if(id==='../config')return{nodeEnv:'development',db:{database:'appbit'}};
  if(id==='../utils/app-slug')return require('../src/utils/app-slug');
  if(id==='../middleware/auth')return{requireAuth:noop,requireActiveUser:noop,requireAdmin:noop};
  if(id==='../middleware/db-ready'||id==='../middleware/csrf')return id.endsWith('csrf')?{verifyToken:noop}:noop;
  if(id==='../services/apk-resolver')return{refreshMediaForApp:handlers.refreshMediaForApp};
  if(id==='../services/app-claims')return{pruneStaleClaims:handlers.pruneStaleClaims,ensureNotOwnedByOther:handlers.ensureNotOwnedByOther};
  if(id==='./users')return{publicUser:x=>x};
  return{};
 };
 const filename=path.join(root,'src/routes/api.js');const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:stub,Buffer,URL,URLSearchParams,Date,Number,JSON,String,Math,process,console},{filename});
 async function call(method,path,params={},body={}){
  const route=routes.find(r=>r.method===method&&r.path===path);assert.ok(route,`Missing route ${method} ${path}`);
  let status=200,bodyOut;const res={status(n){status=n;return this},json(data){bodyOut=data;return this}};
  await route.handler({params,body,query:{},currentUser:{id:1,role:'admin'}},res,e=>{throw e});return{status,body:bodyOut};
 }
 return{routes,call,get selected(){return selected}};
}
test('API resolves slug to saved record without creating or modifying any app',async()=>{
 const api=mockApi();const result=await api.call('GET','/apps/by-slug/:slug',{slug:'binance-7'});
 assert.equal(result.body.id,7);assert.equal(result.body.url,'/apps/binance-7');
 const bad=await api.call('GET','/apps/by-slug/:slug',{slug:'not-a-valid-id'});assert.equal(bad.status,404);
});
test('API removes final-download route and does not expose old direct file URLs',async()=>{
 const api=mockApi();assert.equal(api.routes.some(r=>r.path.includes('download/resolve')),false);
 const result=await api.call('GET','/apps/by-slug/:slug',{slug:'binance-7'});assert.equal(result.status,200);
 const detail=await api.call('GET','/apps/:id',{id:'7'});
 assert.equal(detail.body.app.url,'/apps/binance-7');
 assert.equal(detail.body.app.sourceMeta.directDownloadUrl,undefined);
 assert.equal(detail.body.app.officialUrl,'https://play.google.com/store/apps/details?id=com.binance.dev');
});
test('media endpoint passes selected kinds for only the requested app',async()=>{
 const api=mockApi();const result=await api.call('POST','/apps/:id/media/refresh',{id:'7'},{kinds:['icon']});
 assert.equal(result.status,200);assert.equal(api.selected.id,7);assert.equal(JSON.stringify(api.selected.options),JSON.stringify({kinds:['icon']}));
});
