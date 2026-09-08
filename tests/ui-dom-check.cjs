/* Deterministic DOM interaction tests. Uses the real browser UI script and fake API.
   This is not a browser-rendering or live-server test. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const calls=[];const record={slug:'binance-7',url:'/apps/binance-7',id:7,name:'Binance',packageId:'liteapks:binance',sourcePackageId:'com.binance.dev',sourcePageUrl:'https://liteapks.com/binance.html',sourceUpdatedAt:'2026-09-01',sourceMeta:{iconUrl:'https://images.example/icon.png',coverImageUrl:'https://images.example/cover.png',screenshots:['https://images.example/s1.png'],playStoreUrl:'https://play.google.com/store/apps/details?id=com.binance.dev'},media:{iconUrl:'https://images.example/icon.png',coverImageUrl:'https://images.example/cover.png',screenshots:['https://images.example/s1.png']},developer:'Example',version:'3.19.5',category:'Finance',sourceSection:'apps',ratingValue:3.4,description:'Exact description to copy.',officialUrl:'https://play.google.com/store/apps/details?id=com.binance.dev',apkType:'Free',fileSizeBytes:10000000,published:false,versions:[]};
const counts={total:1853,published:0,drafts:1853,updates:0};
const taxonomy={total:1853,sections:{apps:1200,games:653},categories:[{section:'apps',name:'Finance',slug:'finance',parentSlug:'apps',count:45},{section:'apps',name:'Tools',slug:'tools',parentSlug:'apps',count:35},{section:'apps',name:'Utilities',slug:'utilities',parentSlug:'tools',count:30},{section:'games',name:'Action',slug:'action',parentSlug:'games',count:65}],fetch:{status:'complete',verified:true,sourceCategoryCount:4}};
let importState={status:'idle',total_count:0,processed_count:0},clip='';
function api(url,opts={}){const u=new URL(url,'https://appbit.test'),body=opts.body?JSON.parse(opts.body):{};calls.push({path:u.pathname,query:u.searchParams,body,method:opts.method||'GET'});
 switch(u.pathname){
 case '/api/bootstrap':return {csrfToken:'mock-token',user:{id:1,name:'Administrator',email:'admin@appbit.local',role:'admin'},counts,notificationSummary:{unreadCount:0}};
 case '/api/apps':{const page=Number(u.searchParams.get('page')||1),perPage=Number(u.searchParams.get('perPage')||20),category=u.searchParams.get('category')||'',section=u.searchParams.get('section')||'all',total=category==='finance'?45:category==='tools'?35:category==='utilities'?30:section==='all'?1853:section==='apps'?1200:653,pages=Math.ceil(total/perPage),n=Math.min(perPage,total-(page-1)*perPage);return{apps:Array.from({length:n},(_,i)=>({...record,id:(page-1)*perPage+i+1,url:'/apps/app-'+((page-1)*perPage+i+1),name:'App '+((page-1)*perPage+i+1)})),pagination:{page,perPage,total,pages,from:(page-1)*perPage+1,to:(page-1)*perPage+n},counts}}
 case '/api/taxonomy':return taxonomy;
 case '/api/resolver/state':return{state:importState};
 case '/api/resolver/sync':importState={status:'discovering',total_count:0,processed_count:0};return{state:importState};
 case '/api/resolver/stop':importState.status='stopped';return{state:importState};
 case '/api/taxonomy/refresh':return{...taxonomy,skipped:true};
 case '/api/updates/state':return{state:{status:'idle'}};
 case '/api/apps/import':return{app:record};
 case '/api/apps/by-slug/binance-7':return{ok:true,id:7,slug:'binance-7',url:'/apps/binance-7'};
 case '/api/users':return{users:[]};
 case '/api/backups/state':return{backup:{}};
 }
 if(/^\/api\/apps\/\d+\/claim$/.test(u.pathname))return{claim:{userId:1}};
 if(/^\/api\/apps\/\d+\/media\/refresh$/.test(u.pathname))return{app:record,icon:true,cover:true,screenshots:1};
 if(/^\/api\/apps\/\d+$/.test(u.pathname))return{app:record};
 return{ok:true};
}
const nodes=new Map();
function attrs(text){const out={};for(const m of text.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))out[m[1]]=m[2]??m[3];return out}
function fakeElement(id='',attributes={}){const n={id,attributes,dataset:{},classList:{add(){},remove(){},toggle(){},contains(){return false}},style:{},hidden:false,disabled:false,value:'',onclick:null,onsubmit:null,_html:'',_text:'',children:[],parentNode:null};
 for(const[k,v]of Object.entries(attributes)){if(k.startsWith('data-'))n.dataset[k.slice(5).replace(/-([a-z])/g,(_,a)=>a.toUpperCase())]=v;else if(k==='value')n.value=v;else if(k==='hidden')n.hidden=true;else if(k==='disabled')n.disabled=true}
 Object.defineProperty(n,'innerHTML',{get(){return n._html},set(v){n._html=String(v);for(const match of n._html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)){const a=attrs(match[2]);if(a.id){const child=fakeElement(a.id,a);nodes.set(a.id,child)}}}});
 Object.defineProperty(n,'textContent',{get(){return n._text||n._html.replace(/<[^>]+>/g,'')},set(v){n._text=String(v)}});
 n.setAttribute=(k,v)=>{n.attributes[k]=v};n.getAttribute=k=>n.attributes[k];n.remove=()=>{};n.appendChild=()=>{};n.select=()=>{};n.focus=()=>{};
 n.querySelector=sel=>{if(sel.startsWith('#'))return nodes.get(sel.slice(1))||null;return null};
 n.querySelectorAll=sel=>{const found=[];const regex=/\[([\w-]+)\]/g;const required=[...sel.matchAll(regex)].map(x=>x[1]);for(const match of n._html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)){const a=attrs(match[2]);if(required.length&&required.some(k=>!(k in a)))continue;if(!required.length)continue;const el=a.id&&nodes.get(a.id)||fakeElement('',a);found.push(el)}return found};return n}
const document={documentElement:{dataset:{}},body:fakeElement('body'),querySelector(sel){if(sel==='meta[name="theme-color"]')return{content:''};if(sel.startsWith('#'))return nodes.get(sel.slice(1))||null;return null},getElementById:id=>nodes.get(id)||null,querySelectorAll(sel){return nodes.get('app')?.querySelectorAll(sel)||[]},createElement:()=>fakeElement()};nodes.set('app',fakeElement('app'));
const location={pathname:'/library',search:'',origin:'https://appbit.test'};
const history={state:null,length:2,pushState(st,_,url){this.state=st;const u=new URL(url,location.origin);location.pathname=u.pathname;location.search=u.search},replaceState(st,_,url){this.pushState(st,_,url)},back(){this.state=null;location.pathname='/library';location.search=''}};
const window={addEventListener(){},scrollTo(){},open(){}};
const context={document,window,location,history,navigator:{clipboard:{writeText:async value=>{clip=value}}},Headers,URL,URLSearchParams,Buffer,console,Math,Number,Date,JSON,Array,Map,Set,Promise,process,fetch:async(url,opts={})=>new Response(JSON.stringify(api(url,opts)),{headers:{'content-type':'application/json'}}),setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},confirm:()=>true};
const source=fs.readFileSync(path.join(root,'public/ui/app.js'),'utf8').replace(/init\(\);\s*\}\)\(\);\s*$/,`globalThis.UI={S,go,openDetail,renderDetail,detailHtml,renderImportPage,renderLibrary,loadLibrary,renderSettings,renderUpdateCenter,startManualImport,stopManualImport,releaseActiveDetail,routeLocation,shell};})();`);
vm.runInNewContext(source,context,{filename:'public/ui/app.js'});const UI=context.UI;UI.S.data=api('/api/bootstrap');UI.S.csrf='mock-token';
const html=()=>nodes.get('content').innerHTML;
const wait=()=>new Promise(r=>setImmediate(r));
test('App Library preserves1853 count and requests20 per page',async()=>{UI.shell();await UI.go('library',{history:false});assert.match(html(),/1,853/);assert.match(html(),/20 apps per page/);assert.equal((html().match(/class="app-card(?: |")/g)||[]).length,20);assert.equal(calls.filter(c=>c.path==='/api/apps').at(-1).query.get('perPage'),'20')});
test('category selection has its own count and pagination',async()=>{UI.S.library={page:1,perPage:20,q:'',section:'apps',category:'finance',sort:'latest'};await UI.go('library');assert.match(html(),/of 45 records/);assert.match(html(),/Page 1 of 3/);assert.match(location.search,/category=finance/)});
test('detail uses full page, only Play Store, updated date, copy description',async()=>{await UI.openDetail(7);assert.equal(location.pathname,'/apps/binance-7');assert.match(html(),/app-record-page/);assert.doesNotMatch(html(),/class="modal/);assert.doesNotMatch(html(),/Readiness/);assert.match(html(),/Update Date/);assert.match(html(),/play\.google\.com\/store\/apps\/details/);assert.doesNotMatch(html(),/href="https:\/\/liteapks\.com/);assert.doesNotMatch(html(),/Source Page/);assert.doesNotMatch(html(),/Resolve Direct Download|Direct APK Link/);assert.match(html(),/Copy Description/);await UI.releaseActiveDetail()});
test('per-app media refresh calls only selected app endpoint',async()=>{await UI.openDetail(7);await nodes.get('refreshLogo').onclick();assert.ok(calls.some(c=>c.path==='/api/apps/7/media/refresh'&&c.method==='POST'&&JSON.stringify(c.body.kinds)==='["icon"]'));assert.ok(!calls.some(c=>c.path==='/api/updates/start'));await UI.releaseActiveDetail()});
test('Add APK is routed and submits the supplied URL',async()=>{await UI.go('add');assert.equal(location.pathname,'/library/add');assert.match(html(),/id="sourceUrl"/);assert.doesNotMatch(html(),/class="modal/);nodes.get('sourceUrl').value='https://liteapks.com/binance.html';await nodes.get('importForm').onsubmit({preventDefault(){}});assert.ok(calls.some(c=>c.path==='/api/apps/import'&&c.body.sourcePageUrl==='https://liteapks.com/binance.html'));assert.equal(location.pathname,'/apps/binance-7');await UI.releaseActiveDetail()});
test('Library manual batch limits, start and stop do not run automatically',async()=>{await UI.go('library');assert.ok(!calls.some(c=>c.path==='/api/resolver/sync'));UI.S.importOpen=true;UI.renderLibrary();nodes.get('syncLimit').value='5';nodes.get('syncMode').value='new';await UI.startManualImport();assert.ok(calls.some(c=>c.path==='/api/resolver/sync'&&c.body.limit===5));await UI.stopManualImport();assert.ok(calls.some(c=>c.path==='/api/resolver/stop'));});
