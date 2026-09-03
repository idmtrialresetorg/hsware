const YAML = require('yaml');
const { getPool } = require('../db');
const { findInstallerManifest, listContents, listDirectoryFromHtml, releaseAssetDownloadCount, manifestLastUpdatedDate, rawTextAtRef, listContentsAtRef, commitsForPath, hasToken } = require('./github');
const { cachedManifestText } = require('./manifest-cache');
const { compareVersions } = require('../utils/version');
const { titleizePackageId } = require('../utils/text');
const { probeRemoteFileSize, safeFetchText, safeFetch } = require('./remote');
const cheerio = require('cheerio');
const { inferCatalogCategory } = require('../catalog-taxonomy');
const config = require('../config');

function parseManifest(text) {
  try { return YAML.parse(text) || {}; }
  catch (e) { throw new Error(`Invalid WinGet manifest YAML: ${e.message}`); }
}

function versionDirFromInstallerPath(path) {
  const parts = String(path || '').split('/');
  parts.pop();
  return parts.join('/');
}

function packageRootFromInstallerPath(path) {
  const parts = String(path || '').split('/');
  parts.splice(-2, 2);
  return parts.join('/');
}

function versionFromInstallerPath(path) {
  const parts = String(path || '').split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

function inferCategory(packageId, locale = {}) {
  return inferCatalogCategory({
    packageId,
    name: locale.PackageName || titleizePackageId(packageId),
    publisher: locale.Publisher || null,
    searchAliases: [locale.ShortDescription, locale.Description, ...(Array.isArray(locale.Tags) ? locale.Tags : [])].filter(Boolean).join(' ')
  }) || 'System & Utilities › General Utilities';
}



function normalizeManifestDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function friendlyArchitectureRequirement(values) {
  const map = {
    x64: '64-bit x86 (x64) compatible processor',
    x86: '32-bit x86 (x86) compatible processor',
    arm64: '64-bit ARM (ARM64) compatible processor',
    arm: 'ARM compatible processor',
    neutral: 'Architecture-neutral package'
  };
  const unique = [...new Set((values || []).map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
  return unique.map(v => map[v] || `${v} compatible processor`).join(' / ') || null;
}

function collectInstallerLocales(manifest, installers) {
  const values = [];
  const add = value => {
    if (Array.isArray(value)) return value.forEach(add);
    const v = String(value || '').trim();
    if (v && !values.some(x => x.toLowerCase() === v.toLowerCase())) values.push(v);
  };
  add(manifest.PackageLocale);
  add(manifest.InstallerLocale);
  for (const installer of installers || []) add(installer?.InstallerLocale);
  return values;
}

function normalizeInstallerFormat(value) {
  const v = String(value || 'all').trim().toLowerCase();
  return ['all','exe','msi','msix','appx','portable'].includes(v) ? v : 'all';
}

function installerUrlExtension(url) {
  const clean = String(url || '').split(/[?#]/, 1)[0].toLowerCase();
  const match = clean.match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function installerMatchesFormat(installer, preferredFormat) {
  const wanted = normalizeInstallerFormat(preferredFormat);
  if (wanted === 'all') return true;
  const ext = installerUrlExtension(installer?.InstallerUrl);
  const type = String(installer?.InstallerType || '').trim().toLowerCase();
  if (wanted === 'exe') return ext === 'exe';
  if (wanted === 'msi') return ext === 'msi' || (!ext && type === 'msi');
  if (wanted === 'msix') return ['msix','msixbundle'].includes(ext) || (!ext && ['msix','msixbundle'].includes(type));
  if (wanted === 'appx') return ['appx','appxbundle'].includes(ext) || (!ext && ['appx','appxbundle'].includes(type));
  if (wanted === 'portable') return ['zip','7z','rar'].includes(ext) || type === 'portable';
  return false;
}

function imageInfo(buffer, contentType = '', sourceUrl = '') {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const url = String(sourceUrl || '').toLowerCase();
  const out = { width:null, height:null, format:null, scalable:false, minDimension:0 };
  const finish = (width, height, format, scalable = false) => {
    width = Number(width || 0) || null; height = Number(height || 0) || null;
    return { width, height, format, scalable:Boolean(scalable), minDimension:width&&height?Math.min(width,height):0 };
  };
  try {
    if (type.includes('svg') || url.match(/\.svg(?:[?#]|$)/i) || b.slice(0,512).toString('utf8').includes('<svg')) {
      const text=b.toString('utf8',0,Math.min(b.length,32768));
      const svg=(text.match(/<svg\b[^>]*>/i)||[''])[0];
      const attr=name=>{const m=svg.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`,'i'));return m?m[1]:''};
      const num=v=>{const m=String(v||'').match(/([0-9.]+)/);return m?Number(m[1]):null};
      let width=num(attr('width')), height=num(attr('height'));
      const vb=attr('viewBox').trim().split(/[\s,]+/).map(Number);
      if ((!width||!height) && vb.length===4 && vb.every(Number.isFinite)) { width=width||vb[2]; height=height||vb[3]; }
      return finish(width,height,'svg',true);
    }
    if (b.length>=24 && b.slice(1,4).toString('ascii')==='PNG') return finish(b.readUInt32BE(16),b.readUInt32BE(20),'png');
    if (b.length>=10 && (b.slice(0,6).toString('ascii')==='GIF87a'||b.slice(0,6).toString('ascii')==='GIF89a')) return finish(b.readUInt16LE(6),b.readUInt16LE(8),'gif');
    if (b.length>=8 && b.readUInt16LE(0)===0 && b.readUInt16LE(2)===1) {
      const count=b.readUInt16LE(4); let mw=0,mh=0;
      for(let i=0;i<count;i++){const o=6+i*16;if(o+16>b.length)break;const w=b[o]||256,h=b[o+1]||256;if(w*h>mw*mh){mw=w;mh=h}}
      return finish(mw,mh,'ico');
    }
    if (b.length>=30 && b.slice(0,4).toString('ascii')==='RIFF' && b.slice(8,12).toString('ascii')==='WEBP') {
      const chunk=b.slice(12,16).toString('ascii');
      if(chunk==='VP8X') { const w=1+b[24]+(b[25]<<8)+(b[26]<<16), h=1+b[27]+(b[28]<<8)+(b[29]<<16); return finish(w,h,'webp'); }
      if(chunk==='VP8L' && b[20]===0x2f) { const bits=b.readUInt32LE(21); const w=(bits&0x3fff)+1, h=((bits>>14)&0x3fff)+1; return finish(w,h,'webp'); }
      const sig=b.indexOf(Buffer.from([0x9d,0x01,0x2a]),20); if(sig>=0&&sig+7<b.length){return finish(b.readUInt16LE(sig+3)&0x3fff,b.readUInt16LE(sig+5)&0x3fff,'webp')}
    }
    if (b.length>=4 && b[0]===0xff && b[1]===0xd8) {
      let o=2; while(o+9<b.length){ if(b[o]!==0xff){o++;continue} const marker=b[o+1]; o+=2; if(marker===0xd8||marker===0xd9)continue; if(o+2>b.length)break; const len=b.readUInt16BE(o); if(len<2||o+len>b.length)break; if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){return finish(b.readUInt16BE(o+3),b.readUInt16BE(o+5),'jpeg')} o+=len; }
    }
  } catch {}
  return out;
}

function logoQuality(info = {}) {
  if (info.scalable) return { quality:'vector', score:5000, exportSize:1024 };
  const m=Number(info.minDimension||0);
  if (m>=1024) return { quality:'excellent', score:4000+Math.min(m,2048), exportSize:1024 };
  if (m>=512) return { quality:'high', score:3000+m, exportSize:512 };
  if (m>=256) return { quality:'medium', score:1800+m, exportSize:null };
  if (m>0) return { quality:'low', score:m, exportSize:null };
  return { quality:'unknown', score:0, exportSize:null };
}

async function inspectLogoCandidate(url, semanticScore = 0, kind = 'unknown') {
  try {
    const img = await safeFetch(url,{maxBytes:8*1024*1024,accept:'image/png,image/jpeg,image/webp,image/svg+xml,image/gif,image/x-icon,image/vnd.microsoft.icon,image/*;q=0.9,*/*;q=0.1'});
    const type=String(img.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|jpg|webp|svg\+xml|gif|x-icon|vnd\.microsoft\.icon)$/i.test(type)) return null;
    const info=imageInfo(img.buffer,type,img.url||url); const quality=logoQuality(info);
    const ratio=info.width&&info.height?Math.max(info.width/info.height,info.height/info.width):1;
    const squareBonus=ratio<=1.35?260:ratio<=2?80:-180;
    return { url:img.url||url, kind, semanticScore, ...info, ...quality, totalScore:quality.score+semanticScore+squareBonus };
  } catch { return null; }
}

async function manifestLogo(locale = {}) {
  const icons = Array.isArray(locale.Icons) ? locale.Icons : [];
  const candidates=[];
  for(const icon of icons){
    const url=String(icon?.IconUrl||'').trim(); if(!/^https?:\/\//i.test(url))continue;
    const resolution=String(icon?.IconResolution||''); const m=resolution.match(/(\d+)x(\d+)/i); const px=m?Math.min(Number(m[1]),Number(m[2])):0;
    const theme=String(icon?.IconTheme||'').toLowerCase();
    candidates.push({url,semanticScore:1800+px+((!theme||theme==='default')?200:0),kind:'winget-manifest-icon'});
  }
  const inspected=(await Promise.all(candidates.slice(0,12).map(c=>inspectLogoCandidate(c.url,c.semanticScore,c.kind)))).filter(Boolean).sort((a,b)=>b.totalScore-a.totalScore);
  const chosen=inspected.find(x=>x.scalable||x.format==='svg')||inspected[0];
  return chosen?{logoUrl:chosen.url,logoSource:chosen.scalable?'winget-manifest-svg':'winget-manifest-icon',logoConfidence:100,logoWidth:chosen.width,logoHeight:chosen.height,logoFormat:chosen.format,logoQuality:chosen.quality,logoExportSize:chosen.exportSize}:{logoUrl:null,logoSource:null,logoConfidence:null,logoWidth:null,logoHeight:null,logoFormat:null,logoQuality:null,logoExportSize:null};
}

function identityTokens(value='') {
  return [...new Set(String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean))];
}

function compactIdentity(value='') {
  return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
}

function productIdentity(locale = {}) {
  const packageTokens=identityTokens(locale.PackageName);
  const publisherTokens=new Set(identityTokens(locale.Publisher));
  const generic=new Set(['software','application','app','desktop','windows','official','download','installer','setup','client','tool','tools']);
  let specific=packageTokens.filter(t=>!publisherTokens.has(t)&&!generic.has(t));
  if(!specific.length) specific=packageTokens.filter(t=>!generic.has(t));

  const aliases=new Set();
  const moniker=compactIdentity(locale.Moniker);
  if(moniker.length>=3)aliases.add(moniker);
  const idTail=compactIdentity(String(locale.PackageIdentifier||'').split('.').pop()||'');
  if(idTail.length>=4)aliases.add(idTail);
  const nameWithoutPublisher=packageTokens.filter(t=>!publisherTokens.has(t)).join('');
  if(nameWithoutPublisher.length>=4)aliases.add(nameWithoutPublisher);
  const fullName=compactIdentity(locale.PackageName);
  if(fullName.length>=4)aliases.add(fullName);

  return {packageTokens,publisherTokens,specificTokens:specific,aliases:[...aliases]};
}

function identityMatchScore(text='', identity={}) {
  const raw=String(text||'').toLowerCase();
  const hay=' '+raw.replace(/[^a-z0-9]+/g,' ')+' ';
  const compact=compactIdentity(raw);
  const specific=identity.specificTokens||[];
  const aliases=identity.aliases||[];
  for(const alias of aliases){
    if(alias.length>=4 && compact.includes(alias)) return 2600;
  }
  if(!specific.length) return 0;
  let hits=0;
  for(const t of specific){ if(hay.includes(' '+t+' ')) hits++; }
  const required=specific.length>=3?Math.max(2,Math.ceil(specific.length*0.66)):specific.length===2?2:1;
  if(hits<required)return -5000;
  return 1200+(hits*450);
}


// v14.1: Logo.dev is an independent high-quality WebP source. Product identity
// is resolved before an image is accepted: HSWare tries multiple exact-name /
// alias queries, scores the returned brand + domain against WinGet metadata,
// optionally cross-checks the domain with Brandfetch Search, and only then uses
// a direct domain logo when that domain is safe for the exact product. Wrong
// parent-company marks are intentionally rejected. Monogram fallback is disabled.
const LOGO_DEV_API_ORIGIN = 'https://api.logo.dev';
const LOGO_DEV_IMAGE_ORIGIN = 'https://img.logo.dev';
const BRANDFETCH_SEARCH_ORIGIN = 'https://api.brandfetch.io';
const LOGO_DEV_PARENT_PRODUCT_DOMAINS = new Set([
  'google.com','microsoft.com','adobe.com','jetbrains.com','autodesk.com','oracle.com',
  'apple.com','mozilla.org','github.com','atlassian.com','vmware.com','broadcom.com'
]);
const LOGO_DEV_BLOCKED_DOMAINS = new Set([
  'github.com','githubusercontent.com','gitlab.com','bitbucket.org','sourceforge.net',
  'npmjs.com','pypi.org','crates.io','medium.com','facebook.com','x.com','twitter.com','youtube.com',
  'amazonaws.com','cloudfront.net','azureedge.net','azurewebsites.net','vercel.app','netlify.app',
  'wordpress.com','blogspot.com','readthedocs.io','readthedocs.org','discord.com','discord.gg'
]);
const logoDevCache = new Map();
const brandfetchSearchCache = new Map();

function cleanHost(raw='') {
  try {
    const url=new URL(String(raw||'').trim());
    if(!['http:','https:'].includes(url.protocol))return '';
    return url.hostname.toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
  } catch { return ''; }
}

function logoDevOfficialTargets(locale = {}) {
  const targets=[];
  const add=(raw,source)=>{
    try {
      const url=new URL(String(raw||'').trim());
      if(!['http:','https:'].includes(url.protocol))return;
      const host=url.hostname.toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
      if(!host || LOGO_DEV_BLOCKED_DOMAINS.has(host))return;
      if(targets.some(x=>x.host===host&&x.pathname===url.pathname))return;
      targets.push({host,pathname:url.pathname||'/',source,url:url.toString()});
    } catch {}
  };
  add(locale.PackageUrl,'package-url');
  add(locale.PublisherUrl,'publisher-url');
  return targets;
}

function logoDevOfficialHost(locale = {}) {
  return logoDevOfficialTargets(locale)[0]?.host || '';
}

function logoDevQueries(locale = {}) {
  const values=[];
  const add=(value,kind)=>{
    const clean=String(value||'').replace(/\s+/g,' ').trim();
    if(!clean || clean.length<2 || values.some(x=>x.value.toLowerCase()===clean.toLowerCase()))return;
    values.push({value:clean,kind});
  };
  const name=String(locale.PackageName||'').trim();
  const publisher=String(locale.Publisher||'').trim();
  const idTail=String(locale.PackageIdentifier||'').split('.').pop()||'';
  add(name,'package-name');
  add(locale.Moniker,'moniker');
  add(idTail,'package-id-tail');
  if(name&&publisher)add(`${name} ${publisher}`,'name-publisher');
  const specific=productIdentity(locale).specificTokens.join(' ');
  if(specific)add(specific,'specific-product-name');
  return values.slice(0,5);
}

function logoDevConfiguredImageUrl(value='', fallbackDomain='') {
  const publishable=String(config.logoDevPublishableKey||'').trim();
  let url=null;
  try { url=new URL(String(value||'').trim()); } catch {}
  if(!url && fallbackDomain){
    try { url=new URL(`/${String(fallbackDomain).trim()}`,LOGO_DEV_IMAGE_ORIGIN); } catch {}
  }
  if(!url || url.protocol!=='https:' || url.hostname.toLowerCase()!=='img.logo.dev')return '';
  if(/YOUR_(?:API_TOKEN|PUBLISHABLE_KEY)/i.test(url.toString())){
    if(!publishable)return '';
    url.searchParams.set('token',publishable);
  } else if(!url.searchParams.get('token')) {
    if(!publishable)return '';
    url.searchParams.set('token',publishable);
  }
  // Logo.dev documents 800px as the maximum raster size. Request the maximum
  // directly rather than accepting its 128px default; WebP retains transparency
  // and avoids the quality loss users saw with tiny fallback images.
  url.searchParams.set('size','800');
  url.searchParams.set('format','webp');
  url.searchParams.set('fallback','404');
  return url.toString();
}

function logoDevExactDomainUrl(domain='') {
  const host=String(domain||'').trim().toLowerCase().replace(/^www\./,'');
  if(!host || host.includes('/') || LOGO_DEV_BLOCKED_DOMAINS.has(host))return '';
  return logoDevConfiguredImageUrl('',host);
}

async function logoDevJson(pathname, params = {}) {
  const apiKey=String(config.logoDevApiKey||'').trim();
  if(!apiKey)return null;
  const url=new URL(pathname,LOGO_DEV_API_ORIGIN);
  for(const [key,value] of Object.entries(params)) if(value!=null&&String(value)!=='') url.searchParams.set(key,String(value));
  if(url.origin!==LOGO_DEV_API_ORIGIN)throw new Error('Invalid Logo.dev endpoint.');
  const response=await fetch(url,{
    headers:{
      'Authorization':`Bearer ${apiKey}`,
      'Accept':'application/json',
      'User-Agent':`HSWareStudio/${config.appVersion}`
    },
    redirect:'error',
    signal:AbortSignal.timeout(7000)
  });
  if(!response.ok)throw new Error(`Logo.dev returned ${response.status}.`);
  const type=String(response.headers.get('content-type')||'').toLowerCase();
  if(!type.includes('application/json'))throw new Error('Logo.dev did not return JSON.');
  return response.json();
}

async function brandfetchSearch(query='') {
  const clientId=String(config.brandfetchClientId||'').trim();
  const clean=String(query||'').replace(/\s+/g,' ').trim();
  if(!clientId||clean.length<2)return [];
  const key=clean.toLowerCase();
  const cached=brandfetchSearchCache.get(key);
  if(cached&&cached.expiresAt>Date.now())return cached.value;
  try {
    const url=new URL(`/v2/search/${encodeURIComponent(clean)}`,BRANDFETCH_SEARCH_ORIGIN);
    url.searchParams.set('c',clientId);
    const response=await fetch(url,{
      headers:{'Accept':'application/json','User-Agent':`HSWareStudio/${config.appVersion}`},
      redirect:'error',signal:AbortSignal.timeout(6000)
    });
    if(!response.ok)throw new Error(`Brandfetch Search returned ${response.status}.`);
    const type=String(response.headers.get('content-type')||'').toLowerCase();
    if(!type.includes('application/json'))throw new Error('Brandfetch Search did not return JSON.');
    const data=await response.json();
    const value=Array.isArray(data)?data.slice(0,10):[];
    brandfetchSearchCache.set(key,{value,expiresAt:Date.now()+6*60*60*1000});
    return value;
  } catch {
    brandfetchSearchCache.set(key,{value:[],expiresAt:Date.now()+20*60*1000});
    return [];
  }
}

function domainHostAndPath(value='') {
  const raw=String(value||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'');
  const slash=raw.indexOf('/');
  const host=(slash>=0?raw.slice(0,slash):raw).replace(/\.$/,'');
  const pathname=slash>=0?'/'+raw.slice(slash+1):'/';
  return {host,pathname};
}

function hostMatchesTarget(host='', targetHost='') {
  const a=String(host||'').toLowerCase(),b=String(targetHost||'').toLowerCase();
  return Boolean(a&&b&&(a===b||a.endsWith('.'+b)||b.endsWith('.'+a)));
}

function directDomainLooksProductSpecific(locale = {}, target = null) {
  if(!target?.host)return false;
  if(LOGO_DEV_PARENT_PRODUCT_DOMAINS.has(target.host))return false;
  const identity=productIdentity(locale);
  const hostCompact=compactIdentity(target.host.split('.').slice(0,-1).join(' '));
  const publisherCompact=compactIdentity(locale.Publisher);
  const pathCompact=compactIdentity(target.pathname||'');
  const specific=(identity.specificTokens||[]).map(compactIdentity).filter(x=>x.length>=2);
  if(specific.some(t=>hostCompact.includes(t)||pathCompact.includes(t)))return true;
  // A root domain that is not simply the publisher/company name is commonly a
  // dedicated product domain (obsproject.com, 7-zip.org, etc.).
  const isRoot=!target.pathname||target.pathname==='/'||target.pathname==='';
  if(isRoot && publisherCompact && !hostCompact.includes(publisherCompact) && !publisherCompact.includes(hostCompact))return true;
  // If package == publisher/brand, the company mark is itself the product mark.
  const nameCompact=compactIdentity(locale.PackageName);
  if(nameCompact && (nameCompact===publisherCompact||nameCompact===hostCompact))return true;
  return false;
}

async function logoDevBrandfetchEvidence(locale = {}) {
  if(!String(config.brandfetchClientId||'').trim())return [];
  const identity=productIdentity(locale);
  const queries=logoDevQueries(locale).filter(q=>['package-name','name-publisher'].includes(q.kind)).slice(0,2);
  const out=[];
  for(const q of queries){
    const results=await brandfetchSearch(q.value);
    for(const item of results){
      const name=String(item?.name||'').trim();
      const domain=String(item?.domain||'').trim();
      const {host}=domainHostAndPath(domain);
      if(!host||LOGO_DEV_BLOCKED_DOMAINS.has(host))continue;
      const match=identityMatchScore(`${name} ${domain}`,identity);
      if(match<0)continue;
      out.push({name,domain,host,score:match+(compactIdentity(name)===compactIdentity(locale.PackageName)?2400:0)});
    }
  }
  return out.sort((a,b)=>b.score-a.score).slice(0,10);
}

function scoreLogoDevSearchResult(locale = {}, item = {}, query = {}, officialTargets = [], brandfetchEvidence = []) {
  const identity=productIdentity(locale);
  const name=String(item?.name||'').trim();
  const domain=String(item?.domain||'').trim();
  const {host,pathname}=domainHostAndPath(domain);
  if(!host||LOGO_DEV_BLOCKED_DOMAINS.has(host))return null;
  const evidence=[name,domain].filter(Boolean).join(' ');
  let score=identityMatchScore(evidence,identity);
  if(score<0)return null;
  const exactName=compactIdentity(name)===compactIdentity(locale.PackageName);
  const moniker=compactIdentity(locale.Moniker);
  if(exactName)score+=3600;
  if(moniker&&compactIdentity(name)===moniker)score+=1600;
  if(query.kind==='package-name')score+=700;
  if(query.kind==='name-publisher')score+=500;
  const officialMatch=officialTargets.some(t=>hostMatchesTarget(host,t.host));
  if(officialMatch)score+=2600;
  const pathCompact=compactIdentity(pathname);
  if((identity.aliases||[]).some(a=>a.length>=4&&pathCompact.includes(a)))score+=1400;
  const bfMatch=brandfetchEvidence.some(b=>hostMatchesTarget(host,b.host)&&b.score>=1200);
  if(bfMatch)score+=1200;
  // A bare parent-company domain is dangerous for product packages: e.g.
  // jetbrains.com for IntelliJ IDEA or adobe.com for Photoshop.
  if(LOGO_DEV_PARENT_PRODUCT_DOMAINS.has(host) && (!pathname||pathname==='/') && !exactName)score-=4200;
  // Do not allow a completely unrelated domain solely because one generic word
  // happened to match the package name.
  if(!officialMatch&&!bfMatch&&!exactName&&score<4300)return null;
  return {item,name,domain,host,pathname,score,officialMatch,bfMatch};
}

async function logoDevMultiStrategyProductSearch(locale = {}, officialTargets = [], brandfetchEvidence = []) {
  if(!String(config.logoDevApiKey||'').trim())return null;
  const ranked=[];
  for(const query of logoDevQueries(locale)){
    let results=null;
    try { results=await logoDevJson('/search',{q:query.value,strategy:'match'}); } catch { results=null; }
    if(!Array.isArray(results))continue;
    for(const item of results.slice(0,10)){
      const scored=scoreLogoDevSearchResult(locale,item,query,officialTargets,brandfetchEvidence);
      if(scored)ranked.push({...scored,queryKind:query.kind});
    }
  }
  ranked.sort((a,b)=>b.score-a.score);
  const seen=new Set();
  for(const match of ranked){
    const identityKey=`${match.domain}|${match.name}`.toLowerCase();
    if(seen.has(identityKey))continue; seen.add(identityKey);
    if(match.score<5000)continue;
    const url=logoDevConfiguredImageUrl(match.item?.logo_url);
    if(!url)continue;
    const inspected=await inspectLogoCandidate(url,8000+match.score,'logo-dev-multi-strategy-search').catch(()=>null);
    if(!inspected)continue;
    return {inspected,matchedName:match.name,matchedDomain:match.domain,score:match.score,queryKind:match.queryKind};
  }
  return null;
}

async function logoDevSafeDirectCandidate(locale = {}, officialTargets = []) {
  for(const target of officialTargets){
    if(!directDomainLooksProductSpecific(locale,target))continue;
    const direct=logoDevExactDomainUrl(target.host);
    if(!direct)continue;
    const inspected=await inspectLogoCandidate(direct,7600,'logo-dev-safe-exact-domain').catch(()=>null);
    if(inspected)return {inspected,matchedName:String(locale.PackageName||''),matchedDomain:target.host};
  }
  return null;
}

async function logoDevProductLogo(locale = {}, {force=false} = {}) {
  const publishable=String(config.logoDevPublishableKey||'').trim();
  const secret=String(config.logoDevApiKey||'').trim();
  if(!publishable&&!secret)return {available:false,reason:'Configure LOGO_DEV_PUBLISHABLE_KEY and LOGO_DEV_API_KEY for the verified high-quality Logo.dev resolver.'};

  const officialTargets=logoDevOfficialTargets(locale);
  const cacheKey=[compactIdentity(locale.PackageIdentifier),compactIdentity(locale.PackageName),compactIdentity(locale.Moniker),officialTargets.map(x=>x.host+x.pathname).join(',')].join('|');
  const cached=logoDevCache.get(cacheKey);
  if(!force&&cached&&cached.expiresAt>Date.now())return cached.value;

  const brandfetchEvidence=await logoDevBrandfetchEvidence(locale).catch(()=>[]);
  const product=await logoDevMultiStrategyProductSearch(locale,officialTargets,brandfetchEvidence);
  if(product?.inspected){
    const i=product.inspected;
    const value={available:true,url:i.url,format:'webp',quality:i.quality,width:i.width||800,height:i.height||800,matchedName:product.matchedName,matchedDomain:product.matchedDomain,matchScore:product.score,source:`multi-search:${product.queryKind}`};
    logoDevCache.set(cacheKey,{value,expiresAt:Date.now()+6*60*60*1000});
    return value;
  }

  // If Search cannot prove a product result, a direct domain request is allowed
  // only for a product-specific official domain. Parent-company domains are not
  // accepted as a fallback because a wrong logo is worse than an empty slot.
  const direct=publishable?await logoDevSafeDirectCandidate(locale,officialTargets):null;
  if(direct?.inspected){
    const i=direct.inspected;
    const value={available:true,url:i.url,format:'webp',quality:i.quality,width:i.width||800,height:i.height||800,matchedName:direct.matchedName,matchedDomain:direct.matchedDomain,source:'safe-exact-domain'};
    logoDevCache.set(cacheKey,{value,expiresAt:Date.now()+6*60*60*1000});
    return value;
  }

  const reason=!secret
    ? 'Logo.dev exact search needs LOGO_DEV_API_KEY; unsafe company-domain fallbacks are intentionally blocked.'
    : 'Logo.dev could not prove an exact product match. Wrong company/monogram fallbacks are intentionally blocked.';
  const value={available:false,reason};
  logoDevCache.set(cacheKey,{value,expiresAt:Date.now()+20*60*1000});
  return value;
}

async function officialProductLogo(locale = {}) {
  const pages=[
    {url:String(locale.PackageUrl||'').trim(),exactPackagePage:true},
    {url:String(locale.PublisherUrl||'').trim(),exactPackagePage:false}
  ].filter((item,i,a)=>/^https?:\/\//i.test(item.url)&&a.findIndex(x=>x.url===item.url)===i);
  const all=[];
  const identity=productIdentity(locale);
  for(const pageSpec of pages){
    const page=pageSpec.url;
    const exactPackagePage=Boolean(pageSpec.exactPackagePage);
    try {
      const result = await safeFetchText(page, 1536 * 1024);
      const $ = cheerio.load(result.text || '');
      const pageHost = new URL(result.url || page).hostname.replace(/^www\./,'').toLowerCase();
      const pageTitle = $('title').first().text() || $('meta[property=\"og:title\"]').first().attr('content') || '';
      const pageIdentityStrong = exactPackagePage || identityMatchScore(`${pageTitle} ${result.url || page}`, identity) >= 0;
      const add = (raw, score, kind, evidence='', options={}) => {
        if (!raw) return;
        try {
          const url=new URL(String(raw).trim(),result.url||page).toString();
          const host=new URL(url).hostname.replace(/^www\./,'').toLowerCase();
          const sameSite=host===pageHost||host.endsWith('.'+pageHost)||pageHost.endsWith('.'+host);
          const candidateEvidence=[evidence,url].filter(Boolean).join(' ');
          const evidenceTokens=new Set(identityTokens(candidateEvidence));
          const productTokens=new Set([...(identity.specificTokens||[]),...(identity.packageTokens||[])]);
          const foreignBrands=['github','gitlab','facebook','instagram','twitter','linkedin','youtube','reddit','discord','slack'];
          if(foreignBrands.some(t=>evidenceTokens.has(t)&&!productTokens.has(t)))return;
          const evidenceScore=identityMatchScore(candidateEvidence, identity);
          // v5.2: no candidate is allowed to inherit identity from the page title.
          // The image/icon itself (or its manifest/JSON-LD entity) must prove it
          // belongs to this exact product. This is what blocks the GitHub mark on
          // the Visual Studio Code page and generic Google artwork for Chrome.
          if(!options.exactPackageContext && evidenceScore<0)return;
          const identityScore=options.exactPackageContext?3200:evidenceScore;
          all.push({url,semanticScore:score+(sameSite?180:0)+identityScore,kind});
        } catch {}
      };
      const manifestUrls=[];
      $('link[rel]').each((_,el)=>{const rel=String($(el).attr('rel')||'').toLowerCase(),sizes=String($(el).attr('sizes')||''),type=String($(el).attr('type')||'').toLowerCase(),href=String($(el).attr('href')||'');const m=sizes.match(/(\d+)x(\d+)/i),px=m?Math.min(Number(m[1]),Number(m[2])):0;if(rel.includes('manifest')){if(href){try{manifestUrls.push(new URL(href.trim(),result.url||page).toString())}catch{}}}else if(rel.includes('apple-touch-icon'))add(href,1250+px,'apple-touch-icon',href+' '+rel,{exactPackageContext:pageIdentityStrong});else if(rel.split(/\s+/).includes('icon')||rel.includes('shortcut icon'))add(href,(type.includes('svg')?1500:900)+px,'site-icon',href+' '+rel+' '+type,{exactPackageContext:pageIdentityStrong})});
      // Modern sites often keep their largest 512/1024 application artwork in
      // site.webmanifest even when the visible page uses a tiny favicon.
      for(const manifestUrl of [...new Set(manifestUrls)].slice(0,4)){
        try{
          const mf=await safeFetchText(manifestUrl,256*1024); const data=JSON.parse(mf.text||'{}'); const manifestIdentity=[data.name,data.short_name,data.description,data.start_url].filter(Boolean).join(' ');
          for(const icon of (Array.isArray(data.icons)?data.icons:[])){
            const raw=String(icon?.src||'').trim(); if(!raw)continue;
            const sizes=String(icon?.sizes||''); let px=0;
            for(const mm of sizes.matchAll(/(\d+)x(\d+)/ig))px=Math.max(px,Math.min(Number(mm[1]),Number(mm[2])));
            const purpose=String(icon?.purpose||'').toLowerCase();
            add(new URL(raw,mf.url||manifestUrl).toString(),1850+Math.min(px,2048)+(purpose.includes('maskable')?60:0),'webmanifest-icon',manifestIdentity+' '+raw,{exactPackageContext:exactPackagePage||identityMatchScore(manifestIdentity,identity)>=0});
          }
        }catch{}
      }
      // Social metadata can contain the product's square application artwork even
      // when the DOM itself only renders a tiny favicon. Accept it only when
      // the asset URL independently looks like this product's logo/icon; do not
      // treat a generic marketing/hero image as an application icon.
      $('meta[property="og:image"],meta[name="twitter:image"],meta[property="twitter:image"]').each((_,el)=>{
        const raw=String($(el).attr('content')||'').trim();
        if(!raw)return;
        const evidence=raw.toLowerCase();
        const logoish=/\b(logo|app[-_ ]?icon|product[-_ ]?icon|icon[-_ ]?(?:512|256|192|128))\b/i.test(evidence);
        if(logoish&&identityMatchScore(evidence,identity)>=0)add(raw,1500,'social-product-icon',evidence);
      });
      $('img[src],source[srcset]').each((_,el)=>{
        const src=String($(el).attr('src')||$(el).attr('data-src')||$(el).attr('data-lazy-src')||$(el).attr('data-original')||''); const srcset=String($(el).attr('srcset')||$(el).attr('data-srcset')||'');
        const label=[$(el).attr('alt'),$(el).attr('title'),$(el).attr('id'),$(el).attr('class'),src].filter(Boolean).join(' ').toLowerCase();
        const logoish=/\b(logo|brand|app[-_ ]?icon|product[-_ ]?icon)\b/i.test(label);
        // v5.2 accepts ordinary page images only when they are explicitly
        // logo/icon-like AND their own label/path proves the product identity.
        // Screenshots, GitHub marks, social icons, partner logos, etc. are ignored.
        if(logoish && identityMatchScore(label,identity)>=0){
          if(src)add(src,1800,'page-logo',label,{exactPackageContext:exactPackagePage});
          for(const part of srcset.split(',').map(x=>x.trim()).filter(Boolean)){const u=part.split(/\s+/)[0];if(u)add(u,1900,'page-logo-srcset',label+' '+u,{exactPackageContext:exactPackagePage})}
        }
      });
      $('script[type="application/ld+json"]').each((_,el)=>{try{const data=JSON.parse($(el).text()||'null');const walk=v=>{if(!v)return;if(Array.isArray(v))return v.forEach(walk);if(typeof v!=="object")return;const type=String(v['@type']||'').toLowerCase();const entityName=String(v.name||v.alternateName||'');const entityEvidence=[entityName,v.url,v.description].filter(Boolean).join(' ');const entityMatches=exactPackagePage||identityMatchScore(entityEvidence,identity)>=0;const isSoftware=/softwareapplication|application|product/.test(type);const logo=v.logo;const image=v.image;if(logo&&entityMatches&&isSoftware){const val=typeof logo==='string'?logo:(logo.url||logo.contentUrl);if(val)add(val,2050,'jsonld-product-logo',entityEvidence)}if(image&&entityMatches&&isSoftware){const val=typeof image==='string'?image:(image.url||image.contentUrl);if(val)add(val,1650,'jsonld-product-image',entityEvidence)}for(const value of Object.values(v)){if(value&&typeof value==='object')walk(value)}};walk(data)}catch{}});
    } catch {}
  }
  const seen=new Set(); const candidates=all.sort((a,b)=>b.semanticScore-a.semanticScore).filter(x=>!seen.has(x.url)&&(seen.add(x.url),true)).slice(0,24);
  const inspected=[];
  for(const c of candidates){const item=await inspectLogoCandidate(c.url,c.semanticScore,c.kind);if(item)inspected.push(item)}
  if(!inspected.length)return {logoUrl:null,logoSource:null,logoConfidence:null,logoWidth:null,logoHeight:null,logoFormat:null,logoQuality:null,logoExportSize:null};
  inspected.sort((a,b)=>b.totalScore-a.totalScore); const chosen=inspected[0];
  const confidence=chosen.kind.includes('page-logo')?99:chosen.kind==='webmanifest-icon'?98:chosen.kind==='jsonld-product-logo'?99:chosen.kind==='jsonld-product-image'?96:chosen.kind==='apple-touch-icon'?92:chosen.kind==='site-icon'?88:75;
  const logoAlternates=inspected.slice(1,6).map(item=>({
    url:item.url,kind:item.kind,format:item.format,quality:item.quality,width:item.width,height:item.height,scalable:item.scalable,exportSize:item.exportSize
  }));
  return {logoUrl:chosen.url,logoSource:`official-product-${chosen.kind}`,logoConfidence:confidence,logoWidth:chosen.width,logoHeight:chosen.height,logoFormat:chosen.format,logoQuality:chosen.quality,logoExportSize:chosen.exportSize,logoAlternates};
}


function registrySlug(value = '') {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/\+/g, ' plus ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function appLogoRegistrySlugs(locale = {}) {
  const identity = productIdentity(locale);
  const publisherTokens = new Set(identityTokens(locale.Publisher));
  const generic = new Set(['software','application','app','desktop','windows','official','download','installer','setup','client','tool','tools']);
  const out = [];
  const add = (value, {trustedIdentity=false} = {}) => {
    const slug = registrySlug(value);
    if (!slug || slug.length < 2 || out.includes(slug)) return;
    // Normal registry candidates must prove product identity. A single vendor
    // slug is allowed only when the WinGet PackageIdentifier itself uses that
    // exact vendor token and the package name contains it (e.g. ONLYOFFICE).
    if (!trustedIdentity && identityMatchScore(slug, identity) < 0) return;
    out.push(slug);
  };

  const nameTokens = identityTokens(locale.PackageName);
  const packageVendor = registrySlug(String(locale.PackageIdentifier||'').split('.')[0]||'');
  const firstNameToken = registrySlug(nameTokens[0]||'');
  if (packageVendor && packageVendor.length>=5 && packageVendor===firstNameToken && !publisherTokens.has(packageVendor)) add(packageVendor,{trustedIdentity:true});
  const specificName = nameTokens.filter(t => !publisherTokens.has(t) && !generic.has(t)).join('-');
  if (specificName) add(specificName);
  add(locale.PackageName);

  const idTailRaw = String(locale.PackageIdentifier || '').split('.').pop() || '';
  add(idTailRaw);
  add(locale.Moniker);

  // Safe product aliases for common WinGet identities. These are aliases of
  // the product itself, never of the parent company.
  const compact = compactIdentity([locale.PackageName, locale.PackageIdentifier, locale.Moniker].filter(Boolean).join(' '));
  const aliases = [
    [/visualstudiocode|vscode/, ['visual-studio-code','vscode']],
    [/googlechrome|chrome/, ['google-chrome','chrome']],
    [/7zip/, ['7-zip','7zip']],
    [/vlcmediaplayer|videolanvlc|vlc/, ['vlc','vlc-media-player']],
    [/notepadplusplus|notepadpp/, ['notepad-plus-plus','notepadplusplus']],
    [/mozilla firefox|mozillafirefox|firefox/, ['firefox','mozilla-firefox']],
    [/microsoftedge|edge/, ['microsoft-edge','edge']],
    [/obsstudio|obsprojectobsstudio/, ['obs-studio']],
    [/openvpnconnect/, ['openvpn-connect']],
  ];
  for (const [pattern, values] of aliases) if (pattern.test(compact)) values.forEach(add);

  return out.slice(0, 10);
}

const APP_LOGO_REGISTRY_RAW = 'https://raw.githubusercontent.com/ln-dev7/logos-apps/master/logos';
const appLogoRegistryCache = new Map();

async function appLogoRegistry(locale = {}) {
  const slugs = appLogoRegistrySlugs(locale);
  if (!slugs.length) return {logoUrl:null,logoSource:null,logoConfidence:null,logoWidth:null,logoHeight:null,logoFormat:null,logoQuality:null,logoExportSize:null};
  const cacheKey = [compactIdentity(locale.PackageIdentifier), compactIdentity(locale.PackageName), slugs.join(',')].join('|');
  const cached = appLogoRegistryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let chosen = null;
  for (const slug of slugs) {
    const url = `${APP_LOGO_REGISTRY_RAW}/${encodeURIComponent(slug)}.svg`;
    const item = await inspectLogoCandidate(url, 3000, 'app-logo-registry-svg');
    if (!item || !item.scalable || item.format !== 'svg') continue;
    chosen = item;
    break;
  }
  const value = chosen
    ? {logoUrl:chosen.url,logoSource:'app-logo-registry-svg',logoConfidence:97,logoWidth:chosen.width,logoHeight:chosen.height,logoFormat:'svg',logoQuality:'vector',logoExportSize:1024}
    : {logoUrl:null,logoSource:null,logoConfidence:null,logoWidth:null,logoHeight:null,logoFormat:null,logoQuality:null,logoExportSize:null};
  appLogoRegistryCache.set(cacheKey,{value,expiresAt:Date.now()+6*60*60*1000});
  return value;
}



// v14.1: independent vector repositories. Displayed logo slots never borrow
// another provider's result; each backend either proves its own exact SVG or
// stays unavailable. Simple Icons remains available internally for legacy
// enrichment, while the six-slot UI uses logos-apps, Dashboard Icons and selfh.st
// as three separate repository authorities.
const SIMPLE_ICONS_RAW = 'https://cdn.simpleicons.org';
const SELFHST_ICONS_RAW = 'https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg';
const DASHBOARD_ICONS_RAW = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg';

async function firstVectorRegistryMatch(locale = {}, source = 'app-registry') {
  const slugs = appLogoRegistrySlugs(locale);
  if (!slugs.length) return null;
  const variants = [];
  for (const slug of slugs) {
    if (source === 'simple-icons') {
      variants.push({slug:slug.replace(/-/g,''), url:`${SIMPLE_ICONS_RAW}/${encodeURIComponent(slug.replace(/-/g,''))}`});
      variants.push({slug, url:`${SIMPLE_ICONS_RAW}/${encodeURIComponent(slug)}`});
    } else if (source === 'selfhst') {
      variants.push({slug, url:`${SELFHST_ICONS_RAW}/${encodeURIComponent(slug)}.svg`});
    } else if (source === 'dashboard-icons') {
      variants.push({slug, url:`${DASHBOARD_ICONS_RAW}/${encodeURIComponent(slug)}.svg`});
      // Dashboard Icons commonly publishes theme variants under the same slug.
      // Try the canonical file first; variants are only attempted when canonical
      // is absent so the provider remains deterministic.
      variants.push({slug:`${slug}-dark`, url:`${DASHBOARD_ICONS_RAW}/${encodeURIComponent(slug+'-dark')}.svg`});
      variants.push({slug:`${slug}-light`, url:`${DASHBOARD_ICONS_RAW}/${encodeURIComponent(slug+'-light')}.svg`});
    } else {
      variants.push({slug, url:`${APP_LOGO_REGISTRY_RAW}/${encodeURIComponent(slug)}.svg`});
    }
  }
  const seen = new Set();
  for (const candidate of variants) {
    if (seen.has(candidate.url)) continue; seen.add(candidate.url);
    const item = await inspectLogoCandidate(candidate.url, 3000, `${source}-svg`);
    if (!item || !item.scalable || item.format !== 'svg') continue;
    return {key:source, slug:candidate.slug, url:item.url, format:'svg', quality:'vector', width:item.width, height:item.height};
  }
  return null;
}

async function logoLocaleFromSoftware(sw = {}) {
  const packageId = sw.package_id || sw.packageId || '';
  const sourcePath = sw.source_path || sw.sourcePath || '';
  let manifestLocale = {};
  if (packageId && sourcePath) {
    try { manifestLocale = await fetchLocale(versionDirFromInstallerPath(sourcePath), packageId) || {}; }
    catch { manifestLocale = {}; }
  }
  // The persisted software row remains the fallback for old records, but the
  // live locale manifest restores Icons, PackageUrl, PublisherUrl and Moniker
  // that were previously lost before the six-source selector ran.
  return {
    ...manifestLocale,
    PackageIdentifier: manifestLocale.PackageIdentifier || packageId,
    PackageName: manifestLocale.PackageName || sw.name || sw.package_name || sw.packageName || '',
    Publisher: manifestLocale.Publisher || sw.publisher || sw.developer || '',
    Moniker: manifestLocale.Moniker || sw.moniker || '',
    PackageUrl: manifestLocale.PackageUrl || sw.media_source_url || sw.product_source_url || sw.official_url || sw.officialUrl || '',
    PublisherUrl: manifestLocale.PublisherUrl || sw.publisher_url || ''
  };
}

const logoSelectionCache = new Map();
function logoSelectionCacheKey(sw = {}) {
  return [sw.id||'',sw.package_id||sw.packageId||'',sw.source_path||sw.sourcePath||'',sw.logo_url||sw.logoUrl||''].join('|');
}

function emptyLogoCandidate(key, label, downloadFormat, sourceType, reason = '') {
  return { key, label, downloadFormat, sourceType, available:false, ...(reason?{reason}:{} ) };
}


async function logoSelectionCandidates(sw = {}, options = {}) {
  const cacheKey=logoSelectionCacheKey(sw);
  const cached=logoSelectionCache.get(cacheKey);
  if(!options.force&&cached&&cached.expiresAt>Date.now())return cached.value;
  const locale = await logoLocaleFromSoftware(sw);

  // Six genuinely independent backends. No displayed slot reuses another
  // provider's candidate, so a failure in one source cannot silently masquerade
  // as a success from another source.
  const [logoDev, appRegistry, official, manifest, dashboardIcons, selfhst] = await Promise.all([
    logoDevProductLogo(locale,{force:Boolean(options.force)}).catch(() => ({available:false,reason:'Logo.dev lookup failed.'})),
    firstVectorRegistryMatch(locale,'app-registry').catch(() => null),
    officialProductLogo(locale).catch(() => ({logoUrl:null,logoAlternates:[]})),
    manifestLogo(locale).catch(() => ({logoUrl:null})),
    firstVectorRegistryMatch(locale,'dashboard-icons').catch(() => null),
    firstVectorRegistryMatch(locale,'selfhst').catch(() => null)
  ]);

  const logoDevWebp = logoDev?.available && logoDev?.url
    ? { key:'logo-dev-webp', label:'Logo.dev Verified Product', downloadFormat:'webp', sourceType:'logo-dev', available:true, url:logoDev.url, format:'webp', quality:logoDev.quality, width:logoDev.width||800, height:logoDev.height||800, matchedName:logoDev.matchedName, matchedDomain:logoDev.matchedDomain, matchScore:logoDev.matchScore, resolver:logoDev.source }
    : emptyLogoCandidate('logo-dev-webp','Logo.dev Verified Product','webp','logo-dev',logoDev?.reason || 'No exact Logo.dev product logo.');

  const appRegistrySvg = appRegistry
    ? { ...appRegistry, key:'logos-apps-svg', label:'Logos-Apps SVG', downloadFormat:'svg', sourceType:'logos-apps', available:true }
    : emptyLogoCandidate('logos-apps-svg','Logos-Apps SVG','svg','logos-apps','No exact logos-apps SVG matched this package identity.');

  const officialVector = official?.logoUrl && official?.logoFormat === 'svg'
    ? {url:official.logoUrl,format:'svg',quality:'vector',width:official.logoWidth,height:official.logoHeight}
    : (official?.logoAlternates || []).find(item => item?.format === 'svg' || item?.scalable) || null;
  const officialBest = officialVector || (official?.logoUrl ? {url:official.logoUrl,format:official.logoFormat,quality:official.logoQuality,width:official.logoWidth,height:official.logoHeight} : null);
  const officialDownloadFormat = officialBest?.format === 'svg' ? 'svg' : 'png';
  const officialCandidate = officialBest
    ? { key:'official-site-logo', label:'Official Website Logo', downloadFormat:officialDownloadFormat, sourceType:'official-site', available:true, url:officialBest.url, format:officialBest.format, quality:officialBest.quality, width:officialBest.width, height:officialBest.height }
    : emptyLogoCandidate('official-site-logo','Official Website Logo','png','official-site','No exact first-party product logo was verified on the official website.');

  const manifestDownloadFormat = manifest?.logoFormat === 'svg' ? 'svg' : 'png';
  const manifestCandidate = manifest?.logoUrl
    ? { key:'winget-manifest-logo', label:'WinGet Manifest Logo', downloadFormat:manifestDownloadFormat, sourceType:'winget-manifest', available:true, url:manifest.logoUrl, format:manifest.logoFormat, quality:manifest.logoQuality, width:manifest.logoWidth, height:manifest.logoHeight }
    : emptyLogoCandidate('winget-manifest-logo','WinGet Manifest Logo','png','winget-manifest','This WinGet package does not provide an Icons entry.');

  const dashboardCandidate = dashboardIcons
    ? { ...dashboardIcons, key:'dashboard-icons-svg', label:'Dashboard Icons SVG', downloadFormat:'svg', sourceType:'dashboard-icons', available:true }
    : emptyLogoCandidate('dashboard-icons-svg','Dashboard Icons SVG','svg','dashboard-icons','No exact Dashboard Icons SVG matched this package identity.');

  const selfhstCandidate = selfhst
    ? { ...selfhst, key:'selfhst-svg', label:'selfh.st Icons SVG', downloadFormat:'svg', sourceType:'selfhst', available:true }
    : emptyLogoCandidate('selfhst-svg','selfh.st Icons SVG','svg','selfhst','No exact selfh.st SVG matched this package identity.');

  const value=[logoDevWebp, appRegistrySvg, officialCandidate, manifestCandidate, dashboardCandidate, selfhstCandidate];
  logoSelectionCache.set(cacheKey,{value,expiresAt:Date.now()+30*60*1000});
  return value;
}

async function trustedLogo(locale = {}) {
  const manifest = await manifestLogo(locale);
  // WinGet's own exact package icon remains the strongest source.
  if (manifest.logoUrl && ['vector','excellent','high'].includes(manifest.logoQuality)) return manifest;

  const official = await officialProductLogo(locale);
  // A proven official product-specific HQ logo outranks a registry fallback.
  if (official.logoUrl && ['vector','excellent','high'].includes(official.logoQuality)) return official;

  // v5.4: exact app/tool SVG registry fallback. The candidate filename is
  // derived from the WinGet product identity and must prove product identity;
  // generic publisher/company slugs are never tried.
  const registry = await appLogoRegistry(locale);
  if (registry.logoUrl) return registry;

  // If no registry SVG exists, retain the best lower-resolution trusted source
  // rather than inventing a company logo.
  if (manifest.logoUrl && official.logoUrl) {
    return Number(official.logoWidth||0)*Number(official.logoHeight||0) > Number(manifest.logoWidth||0)*Number(manifest.logoHeight||0) ? official : manifest;
  }
  return manifest.logoUrl ? manifest : official;
}

function installerFields(manifest, preferredFormat = 'all') {
  const installers = Array.isArray(manifest.Installers) ? manifest.Installers : [];
  const matching = installers.filter(i => installerMatchesFormat(i, preferredFormat));
  // For a requested type, no match is a real mismatch: do not silently fall
  // back to a different extension. Within matching entries, prefer x64.
  const first = matching.find(i => String(i?.Architecture || '').toLowerCase() === 'x64') || matching[0] || null;
  const architectures = [...new Set(installers.map(i => String(i?.Architecture || '').trim()).filter(Boolean))];
  const platformValues = [];
  const addPlatform = value => {
    for (const v of (Array.isArray(value) ? value : (value ? [value] : []))) {
      const clean = String(v).replace('Windows.Desktop','Windows Desktop').replace('Windows.Universal','Windows Universal').trim();
      if (clean && !platformValues.includes(clean)) platformValues.push(clean);
    }
  };
  addPlatform(manifest.Platform);
  for (const installer of installers) addPlatform(installer?.Platform);
  const locales = collectInstallerLocales(manifest, installers);
  return {
    version: manifest.PackageVersion || null,
    installerUrl: first?.InstallerUrl || null,
    sha256: first?.InstallerSha256 || null,
    architecture: first?.Architecture || architectures[0] || null,
    architectures,
    processor: friendlyArchitectureRequirement(architectures),
    platform: platformValues.join(', ') || 'Windows Desktop',
    minimumOsVersion: first?.MinimumOSVersion || manifest.MinimumOSVersion || null,
    installerLocale: first?.InstallerLocale || manifest.InstallerLocale || null,
    installerLocales: locales,
    installerType: first?.InstallerType || manifest.InstallerType || null,
    releaseDate: normalizeManifestDate(manifest.ReleaseDate || first?.ReleaseDate || null),
    releaseDateSource: (manifest.ReleaseDate || first?.ReleaseDate) ? 'winget-release-date' : null
  };
}

async function rawManifestMaybe(path) {
  if (!path) return null;
  try { return parseManifest(await cachedManifestText(path)); }
  catch (err) {
    if (Number(err.status) === 404) return null;
    throw err;
  }
}

async function fetchLocale(versionDir, packageId) {
  // Normal WinGet packages use predictable locale filenames. Reading the raw
  // files avoids a GitHub API directory request for every software import.
  let locale = await rawManifestMaybe(`${versionDir}/${packageId}.locale.en-US.yaml`);
  if (locale) return locale;

  const versionManifest = await rawManifestMaybe(`${versionDir}/${packageId}.yaml`);
  const defaultLocale = versionManifest?.DefaultLocale || versionManifest?.PackageLocale || null;
  if (defaultLocale && defaultLocale !== 'en-US') {
    locale = await rawManifestMaybe(`${versionDir}/${packageId}.locale.${defaultLocale}.yaml`);
    if (locale) return locale;
  }
  return versionManifest || {};
}

async function listPackageVersions(root) {
  let items = [];
  try {
    items = await listContents(root);
  } catch {
    // No-token installations often exhaust the GitHub REST allowance while
    // indexing. Fall back to the normal GitHub directory HTML, then use raw
    // manifests for the actual package data. This keeps Open/Import useful.
    try { items = await listDirectoryFromHtml(root); } catch { items = []; }
  }
  return (Array.isArray(items) ? items : [])
    .filter(x => x.type === 'dir')
    .map(x => x.name)
    .filter(Boolean)
    .sort((a, b) => compareVersions(b, a));
}

async function latestInstallerPathFromHint(packageId, hintPath, allowApi = true) {
  if (!hintPath || !allowApi) return hintPath;
  const root = packageRootFromInstallerPath(hintPath);
  const versions = await listPackageVersions(root);
  for (const version of versions.slice(0, 12)) {
    const candidate = `${root}/${version}/${packageId}.installer.yaml`;
    try {
      await cachedManifestText(candidate);
      return candidate;
    } catch (err) {
      if (Number(err.status) !== 404) break;
    }
  }
  return hintPath;
}

async function indexedVersionPaths(packageId, currentVersion) {
  try {
    const db = getPool();
    const [rows] = await db.query(
      `SELECT version, source_path FROM catalog_version_paths
       WHERE package_id=? AND version<>?
       ORDER BY id ASC LIMIT 12`,
      [packageId, currentVersion || '']
    );
    return (rows || []).sort((a,b) => compareVersions(b.version, a.version));
  } catch {
    // Installations upgrade automatically, but a missing optional history table
    // must never prevent current-version details from loading.
    return [];
  }
}

async function fetchOldVersions(packageId, installerPath, currentVersion, preferredFormat = 'all', probeSizes = true) {
  const out = [];
  const used = new Set([String(currentVersion || '')]);

  // Best path: catalog sync already saw the version directories. Reading their
  // raw manifests costs no GitHub REST API request and works without a token.
  const indexed = await indexedVersionPaths(packageId, currentVersion);
  for (const row of indexed) {
    if (out.length >= 5 || used.has(String(row.version))) continue;
    try {
      const parsed = parseManifest(await cachedManifestText(row.source_path));
      const fields = installerFields(parsed, preferredFormat);
      let releaseDate = fields.releaseDate;
      let releaseDateSource = fields.releaseDateSource;
      if (!releaseDate) {
        releaseDate = await manifestLastUpdatedDate(row.source_path);
        if (releaseDate) releaseDateSource = 'winget-manifest-update';
      }
      releaseDateSource = releaseDateSource || 'not-reported';
      let fileSizeBytes = null;
      if (probeSizes && fields.installerUrl) { try { fileSizeBytes = await probeRemoteFileSize(fields.installerUrl); } catch {} }
      out.push({ ...fields, fileSizeBytes, releaseDate, releaseDateSource, version: fields.version || row.version, sourcePath: row.source_path });
      used.add(String(row.version));
    } catch {}
  }
  if (out.length >= 5) return out.slice(0, 5);

  // Fallback for catalogs created before v2.1.2. This can use the GitHub API,
  // but failure/rate limiting is non-fatal.
  const root = packageRootFromInstallerPath(installerPath);
  const versions = await listPackageVersions(root);
  for (const version of versions) {
    if (out.length >= 5 || used.has(String(version))) continue;
    try {
      const path = `${root}/${version}/${packageId}.installer.yaml`;
      const parsed = parseManifest(await cachedManifestText(path));
      const fields = installerFields(parsed, preferredFormat);
      let releaseDate = fields.releaseDate;
      let releaseDateSource = fields.releaseDateSource;
      if (!releaseDate) {
        releaseDate = await manifestLastUpdatedDate(path);
        if (releaseDate) releaseDateSource = 'winget-manifest-update';
      }
      releaseDateSource = releaseDateSource || 'not-reported';
      let fileSizeBytes = null;
      if (probeSizes && fields.installerUrl) { try { fileSizeBytes = await probeRemoteFileSize(fields.installerUrl); } catch {} }
      out.push({ ...fields, fileSizeBytes, releaseDate, releaseDateSource, sourcePath: path });
      used.add(String(version));
    } catch {}
  }
  // Last-resort history recovery: inspect recent commits for the package root.
  // WinGet removes superseded manifest folders, so the current master branch may
  // legitimately contain only one version. With a GitHub token we can recover
  // a few prior version directories from repository history without inventing data.
  if (out.length < 5 && hasToken()) {
    try {
      // The commit that removes an old version no longer contains that folder.
      // Inspect the first-parent snapshot *before* each package-root change, which
      // recovers superseded WinGet manifests that disappeared from master.
      const commits = await commitsForPath(root, 12);
      const inspectedRefs = new Set();
      for (const commit of commits || []) {
        if (out.length >= 5) break;
        const ref = commit?.parents?.[0]?.sha || commit?.sha;
        if (!ref || inspectedRefs.has(ref)) continue;
        inspectedRefs.add(ref);
        let items=[]; try { items=await listContentsAtRef(root,ref); } catch { continue; }
        const dirs=(Array.isArray(items)?items:[]).filter(x=>x?.type==='dir'&&x?.name).map(x=>x.name).sort((a,b)=>compareVersions(b,a));
        for (const version of dirs) {
          if (out.length >= 5 || used.has(String(version))) continue;
          const path = `${root}/${version}/${packageId}.installer.yaml`;
          try {
            const parsed=parseManifest(await rawTextAtRef(path,ref));
            const fields=installerFields(parsed,preferredFormat);
            const rawDate=commit?.commit?.committer?.date||commit?.commit?.author?.date||null;
            const releaseDate=rawDate?new Date(rawDate).toISOString().slice(0,10):null;
            let fileSizeBytes = null;
            if (probeSizes && fields.installerUrl) { try { fileSizeBytes = await probeRemoteFileSize(fields.installerUrl); } catch {} }
            out.push({...fields,fileSizeBytes,version:fields.version||version,sourcePath:path,releaseDate,releaseDateSource:releaseDate?'winget-git-history':'not-reported'});
            used.add(String(version));
          } catch {}
        }
      }
    } catch {}
  }
  return out.slice(0, 5);
}

function packageRootFromId(packageId) {
  const parts = String(packageId || '').split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0][0]?.toLowerCase();
  return first ? `manifests/${first}/${parts.join('/')}` : null;
}

async function indexedInstallerPaths(packageId) {
  try {
    const db = getPool();
    const [rows] = await db.query(
      'SELECT version, source_path FROM catalog_version_paths WHERE package_id=? LIMIT 60',
      [packageId]
    );
    if (!rows?.length) return [];
    rows.sort((a,b) => compareVersions(b.version, a.version));
    return [...new Set(rows.map(r => String(r.source_path || '').trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

async function usableInstallerPath(packageId, sourcePath) {
  if (!sourcePath) return null;
  try {
    const parsed = parseManifest(await cachedManifestText(sourcePath));
    const manifestId = String(parsed.PackageIdentifier || '').trim();
    if (manifestId && manifestId.toLowerCase() !== String(packageId).toLowerCase()) return null;
    if (!parsed.PackageVersion || !Array.isArray(parsed.Installers) || !parsed.Installers.some(x => x?.InstallerUrl)) return null;
    return sourcePath;
  } catch {
    return null;
  }
}

async function resolveInstallerPath(packageId, knownPath = null, options = {}) {
  // Catalog rows can outlive a particular WinGet version directory. Validate
  // indexed paths instead of trusting the first stored path blindly, and fall
  // through to older/current indexed candidates before spending API quota.
  const indexedPaths = await indexedInstallerPaths(packageId);
  const localCandidates = [...new Set([...indexedPaths, knownPath].filter(Boolean))];
  for (const candidate of localCandidates) {
    const usable = await usableInstallerPath(packageId, candidate);
    if (usable) return usable;
  }

  // For imports and refreshes, recover the current version from the deterministic
  // package directory. listPackageVersions already falls back to GitHub HTML when
  // REST API access is rate-limited or no GITHUB_TOKEN is configured.
  if (options.findLatest !== false) {
    const root = packageRootFromId(packageId) || (knownPath ? packageRootFromInstallerPath(knownPath) : null);
    if (root) {
      const versions = await listPackageVersions(root);
      for (const version of versions.slice(0, 20)) {
        const candidate = `${root}/${version}/${packageId}.installer.yaml`;
        const usable = await usableInstallerPath(packageId, candidate);
        if (usable) return usable;
      }
    }
  }

  // Last resort: authenticated GitHub code search for packages not present in the
  // local catalog/version index. Keep the original operational error if a token
  // is required so the API can surface an actionable message.
  const searched = await findInstallerManifest(packageId);
  return usableInstallerPath(packageId, searched);
}

async function fetchPackageDetails(packageId, knownPath = null, options = {}) {
  let installerPath = await resolveInstallerPath(packageId, knownPath, options);
  if (!installerPath) throw new Error(`Could not locate WinGet installer manifest for ${packageId}.`);

  let installerManifest;
  try {
    installerManifest = parseManifest(await cachedManifestText(installerPath));
  } catch (err) {
    // A stale catalog path can happen after WinGet reorganizes a package. If a
    // GitHub token/API is available, do one exact lookup as a recovery path.
    if (knownPath && options.recoverPath !== false) {
      try {
        const recovered = await findInstallerManifest(packageId);
        if (recovered) {
          installerPath = recovered;
          installerManifest = parseManifest(await cachedManifestText(installerPath));
        }
      } catch { /* keep original error below */ }
    }
    if (!installerManifest) throw err;
  }

  const manifestId = String(installerManifest.PackageIdentifier || '').trim();
  if (manifestId && manifestId.toLowerCase() !== String(packageId).toLowerCase()) {
    throw new Error(`WinGet identity mismatch: requested ${packageId} but installer manifest returned ${manifestId}.`);
  }

  const base = installerFields(installerManifest, options.preferredInstallerFormat || 'all');
  const versionDir = versionDirFromInstallerPath(installerPath);
  let locale = {};
  try { locale = await fetchLocale(versionDir, packageId); } catch { locale = {}; }
  const localeId = String(locale.PackageIdentifier || '').trim();
  if (localeId && localeId.toLowerCase() !== String(packageId).toLowerCase()) {
    throw new Error(`WinGet identity mismatch: requested ${packageId} but locale manifest returned ${localeId}.`);
  }

  const lightweight = options.lightweight === true;
  const logo = lightweight
    ? {logoUrl:null,logoSource:null,logoConfidence:null,logoWidth:null,logoHeight:null,logoFormat:null,logoQuality:null,logoExportSize:null}
    : await trustedLogo(locale);

  const currentVersion = base.version || locale.PackageVersion || versionFromInstallerPath(installerPath) || null;
  let currentReleaseDate = base.releaseDate || normalizeManifestDate(locale.ReleaseDate || null);
  let currentReleaseDateSource = base.releaseDateSource || (locale.ReleaseDate ? 'winget-release-date' : null);
  if (!currentReleaseDate && !lightweight) {
    try { currentReleaseDate = await manifestLastUpdatedDate(installerPath); } catch {}
    if (currentReleaseDate) currentReleaseDateSource = 'winget-manifest-update';
  }
  currentReleaseDateSource = currentReleaseDateSource || 'not-reported';
  const oldVersions = currentVersion && options.includeOldVersions !== false
    ? await fetchOldVersions(packageId, installerPath, currentVersion, options.preferredInstallerFormat || 'all', options.probeSize !== false)
    : [];

  let downloadMetric = { count: null, sizeBytes: null, sourceUrl: null, kind: null };
  if (base.installerUrl && !lightweight) {
    try { downloadMetric = await releaseAssetDownloadCount(base.installerUrl); } catch {}
  }
  // GitHub release metadata exposes the exact asset byte size. Prefer that
  // authoritative value; otherwise probe the publisher CDN without downloading
  // the installer body.
  let fileSizeBytes = Number(downloadMetric.sizeBytes || 0) || null;
  if (!fileSizeBytes && base.installerUrl && options.probeSize !== false) {
    try { fileSizeBytes = await probeRemoteFileSize(base.installerUrl); } catch {}
  }

  return {
    packageId: installerManifest.PackageIdentifier || locale.PackageIdentifier || packageId,
    name: locale.PackageName || titleizePackageId(packageId),
    publisher: locale.Publisher || null,
    author: locale.Author || null,
    developer: locale.Author || locale.Publisher || null,
    category: inferCategory(packageId, locale),
    version: currentVersion,
    description: locale.Description || locale.ShortDescription || null,
    // Keep the exact PackageUrl separately as the product-specific source for
    // description/system-requirement enrichment. PublisherUrl may be broader.
    officialUrl: locale.PackageUrl || locale.PublisherUrl || null,
    productSourceUrl: locale.PackageUrl || null,
    licenseName: locale.License || null,
    language: [...new Set([locale.PackageLocale, locale.DefaultLocale, ...base.installerLocales].map(v => String(v || '').trim()).filter(Boolean))].join(', ') || null,
    tags: Array.isArray(locale.Tags) ? locale.Tags.slice(0, 40) : [],
    installerUrl: base.installerUrl,
    architecture: base.architecture,
    processor: base.processor,
    platform: base.platform,
    minimumOsVersion: base.minimumOsVersion,
    installerType: base.installerType,
    sha256: base.sha256,
    fileSizeBytes,
    releaseDate: currentReleaseDate,
    releaseDateSource: currentReleaseDateSource,
    logoUrl: logo.logoUrl,
    logoSource: logo.logoSource,
    logoConfidence: logo.logoConfidence,
    logoWidth: logo.logoWidth,
    logoHeight: logo.logoHeight,
    logoFormat: logo.logoFormat,
    logoQuality: logo.logoQuality,
    logoExportSize: logo.logoExportSize,
    downloadCount: downloadMetric.count,
    downloadCountSource: downloadMetric.sourceUrl,
    downloadCountKind: downloadMetric.kind,
    sourcePath: installerPath,
    oldVersions
  };
}

async function fetchPackageVersionUpdateMetadata(packageId, version, preferredInstallerFormat = 'all') {
  const wantedVersion = String(version || '').trim();
  if (!packageId || !wantedVersion) return null;
  const root = packageRootFromId(packageId);
  if (!root) return null;

  let installerPath = null;
  try {
    const db = getPool();
    const [[indexed]] = await db.query(
      'SELECT source_path FROM catalog_version_paths WHERE package_id=? AND version=? LIMIT 1',
      [packageId, wantedVersion]
    );
    installerPath = indexed?.source_path || null;
  } catch {}
  installerPath = installerPath || `${root}/${wantedVersion}/${packageId}.installer.yaml`;

  let parsed;
  try { parsed = parseManifest(await cachedManifestText(installerPath)); }
  catch { return null; }

  const manifestId = String(parsed.PackageIdentifier || '').trim();
  if (manifestId && manifestId.toLowerCase() !== String(packageId).toLowerCase()) return null;
  const fields = installerFields(parsed, preferredInstallerFormat);
  const resolvedVersion = fields.version || versionFromInstallerPath(installerPath) || wantedVersion;
  if (compareVersions(resolvedVersion, wantedVersion) !== 0) return null;

  let releaseDate = fields.releaseDate || null;
  if (!releaseDate) {
    try { releaseDate = await manifestLastUpdatedDate(installerPath); } catch {}
  }
  let fileSizeBytes = null;
  if (fields.installerUrl) {
    try {
      const metric = await releaseAssetDownloadCount(fields.installerUrl);
      fileSizeBytes = Number(metric?.sizeBytes || 0) || null;
    } catch {}
    if (!fileSizeBytes) {
      try { fileSizeBytes = await probeRemoteFileSize(fields.installerUrl); } catch {}
    }
  }
  return {
    version: resolvedVersion,
    installerUrl: fields.installerUrl || null,
    sha256: fields.sha256 || null,
    fileSizeBytes,
    releaseDate,
    sourcePath: installerPath
  };
}

async function ensureManagedSoftware(packageId, category = null, priorityRank = null, knownPath = null) {
  const db = getPool();
  const [[cat]] = await db.query('SELECT * FROM catalog_packages WHERE package_id=? LIMIT 1', [packageId]);
  const seedName = cat?.name || titleizePackageId(packageId);
  const seedPublisher = cat?.publisher || packageId.split('.')[0] || null;
  const seedCategory = category || cat?.category || null;
  const seedPriority = priorityRank ?? cat?.demand_rank ?? cat?.discovery_rank ?? null;
  const seedPath = knownPath || cat?.source_path || null;

  await db.query(
    `INSERT INTO software (package_id,name,category,publisher,priority_rank,source_path,enrichment_status,workspace_added,workspace_added_at)
     VALUES (?,?,?,?,?,?,'pending',1,NOW())
     ON DUPLICATE KEY UPDATE
       name=COALESCE(NULLIF(software.name,''),VALUES(name)),
       category=COALESCE(software.category,VALUES(category)),
       publisher=COALESCE(software.publisher,VALUES(publisher)),
       priority_rank=COALESCE(software.priority_rank,VALUES(priority_rank)),
       source_path=COALESCE(software.source_path,VALUES(source_path)),
       workspace_added_at=IF(software.workspace_added=0 OR software.workspace_added_at IS NULL,NOW(),software.workspace_added_at),
       workspace_added=1`,
    [packageId, seedName, seedCategory, seedPublisher, seedPriority, seedPath]
  );

  const [[sw]] = await db.query('SELECT * FROM software WHERE package_id=? LIMIT 1', [packageId]);
  if (!sw) throw new Error('Software queue record could not be created.');
  await db.query('UPDATE catalog_packages SET managed_software_id=? WHERE package_id=?', [sw.id, packageId]);
  try {
    await db.query(`INSERT INTO enrichment_queue (software_id,status) VALUES (?,'queued')
      ON DUPLICATE KEY UPDATE status=IF(status='ready',status,'queued')`, [sw.id]);
  } catch {}
  return sw;
}

async function enrichManagedSoftwareById(softwareId, options = {}) {
  const db = getPool();
  const [[sw]] = await db.query('SELECT * FROM software WHERE id=? LIMIT 1', [softwareId]);
  if (!sw) throw new Error('Software not found.');

  await db.query(`UPDATE software SET enrichment_attempts=COALESCE(enrichment_attempts,0)+1,
    last_enrichment_attempt_at=NOW(), enrichment_status='fetching' WHERE id=?`, [softwareId]);
  try { await db.query("UPDATE enrichment_queue SET status='running', attempts=attempts+1, last_error=NULL WHERE software_id=?", [softwareId]); } catch {}

  try {
    const details = await fetchPackageDetails(sw.package_id, sw.source_path, options);
    await db.query(
      `UPDATE software SET name=?, category=COALESCE(NULLIF(?,''),category), publisher=?, author=?, developer_name=?, current_version=?, description=?,
       license_name=?, license_url=NULL, support_url=NULL, release_notes_url=NULL, tags_json=?, language=?, platform=?, processor=?, minimum_os_version=?,
       official_url=?, release_date=?, release_date_source=?, logo_url=?, logo_source=?, logo_confidence=?,
       logo_width=?, logo_height=?, logo_format=?, logo_quality=?, logo_export_size=?,
       media_source_url=?, installer_url=?, architecture=?, installer_type=?, sha256=?, file_size_bytes=COALESCE(?,file_size_bytes),
       download_count=COALESCE(?,download_count), download_count_source=COALESCE(?,download_count_source),
       source_path=?, enrichment_status='ready', enrichment_error=NULL, enriched_at=NOW(), metadata_revision=11,
       link_status=?, link_checked_at=NOW(), updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [details.name, details.category || sw.category, details.publisher, details.author, details.developer, details.version, details.description,
       details.licenseName, JSON.stringify(details.tags || []), details.language, details.platform, details.processor, details.minimumOsVersion, details.officialUrl, details.releaseDate, details.releaseDateSource,
       details.logoUrl, details.logoSource, details.logoConfidence, details.logoWidth, details.logoHeight, details.logoFormat, details.logoQuality, details.logoExportSize, details.productSourceUrl,
       details.installerUrl, details.architecture, details.installerType, details.sha256, details.fileSizeBytes, details.downloadCount, details.downloadCountSource,
       details.sourcePath, details.installerUrl ? 'ready' : 'missing', sw.id]
    );

    if (options.includeOldVersions !== false) {
      for (const v of details.oldVersions) {
        if (!v.version) continue;
        await db.query(
          `INSERT INTO software_versions (software_id,version,installer_url,architecture,installer_type,sha256,file_size_bytes,source_path,release_date,release_date_source)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE installer_url=VALUES(installer_url), architecture=VALUES(architecture),
           installer_type=VALUES(installer_type), sha256=VALUES(sha256), file_size_bytes=COALESCE(VALUES(file_size_bytes),file_size_bytes), source_path=VALUES(source_path),
           release_date=COALESCE(VALUES(release_date),release_date), release_date_source=COALESCE(VALUES(release_date_source),release_date_source)`,
          [sw.id, v.version, v.installerUrl, v.architecture, v.installerType, v.sha256, v.fileSizeBytes, v.sourcePath, v.releaseDate, v.releaseDateSource]
        );
      }
    }

    await db.query("UPDATE catalog_packages SET managed_software_id=?, metadata_status='enriched', source_path=?, last_metadata_error=NULL, last_metadata_attempt_at=NOW() WHERE package_id=?", [sw.id, details.sourcePath, sw.package_id]);
    try { await db.query("UPDATE enrichment_queue SET status='ready', last_error=NULL WHERE software_id=?", [sw.id]); } catch {}
    const [[fresh]] = await db.query('SELECT * FROM software WHERE id=? LIMIT 1', [sw.id]);
    return fresh;
  } catch (err) {
    const message = String(err.message || err).slice(0, 2000);
    await db.query("UPDATE software SET enrichment_status='error', enrichment_error=?, link_status='unknown' WHERE id=?", [message, sw.id]);
    await db.query("UPDATE catalog_packages SET last_metadata_error=?, last_metadata_attempt_at=NOW() WHERE package_id=?", [message, sw.package_id]);
    try { await db.query("UPDATE enrichment_queue SET status='error', last_error=? WHERE software_id=?", [message, sw.id]); } catch {}
    throw err;
  }
}


async function backfillVersionDates(softwareId) {
  const db = getPool();
  let rows = [];
  try {
    [rows] = await db.query(
      `SELECT id,source_path FROM software_versions
       WHERE software_id=? AND release_date_source IS NULL
       ORDER BY id DESC LIMIT 5`,
      [softwareId]
    );
  } catch {
    return 0;
  }
  let updated = 0;
  for (const row of rows || []) {
    let releaseDate = null;
    let source = null;
    try {
      if (row.source_path) {
        const parsed = parseManifest(await cachedManifestText(row.source_path));
        releaseDate = normalizeManifestDate(parsed.ReleaseDate || null);
        if (releaseDate) source = 'winget-release-date';
      }
      if (!releaseDate && row.source_path) {
        releaseDate = await manifestLastUpdatedDate(row.source_path);
        if (releaseDate) source = 'winget-manifest-update';
      }
    } catch {
      // Historical dates are helpful metadata, never a reason to break details.
    }
    source = source || 'not-reported';
    try {
      await db.query('UPDATE software_versions SET release_date=?,release_date_source=? WHERE id=?', [releaseDate, source, row.id]);
      updated++;
    } catch {}
  }
  return updated;
}

async function prepareSoftware(softwareId) {
  const db = getPool();
  const [[sw]] = await db.query('SELECT * FROM software WHERE id=? LIMIT 1', [softwareId]);
  if (!sw) throw new Error('Software not found.');
  const [[history]] = await db.query('SELECT COUNT(*) c, SUM(release_date_source IS NULL) missing_dates, SUM(file_size_bytes IS NULL) missing_sizes FROM software_versions WHERE software_id=?', [softwareId]);
  const needsCurrent = !sw.current_version || !sw.installer_url || sw.enrichment_status !== 'ready' || Number(sw.metadata_revision||0) < 11 || !sw.release_date || !sw.file_size_bytes || !sw.logo_url;
  // v3.6.4 performs one automatic pass over existing history rows so their
  // release/update date is populated (or explicitly marked as not reported).
  const needsHistory = Number(history.c || 0) < 5 || Number(history.missing_dates || 0) > 0 || Number(history.missing_sizes || 0) > 0;
  if (!needsCurrent && !needsHistory) return { software: sw, refreshed: false, warning: null };

  try {
    // The catalog source path is enough for current details without an API call.
    // Old-version history attempts one directory API lookup but failure there is
    // non-fatal inside fetchPackageDetails.
    const fresh = await enrichManagedSoftwareById(softwareId, {
      includeOldVersions: true,
      probeSize: true,
      findLatest: true,
      recoverPath: true
    });
    return { software: fresh, refreshed: true, warning: null };
  } catch (err) {
    return { software: sw, refreshed: false, warning: err.message || String(err) };
  }
}

async function upsertManagedSoftware(packageId, category = null, priorityRank = null, knownPath = null) {
  const sw = await ensureManagedSoftware(packageId, category, priorityRank, knownPath);
  return enrichManagedSoftwareById(sw.id, { includeOldVersions: true, probeSize: true, findLatest: true, recoverPath: true });
}

module.exports = {
  fetchPackageDetails,
  fetchPackageVersionUpdateMetadata,
  normalizeInstallerFormat,
  installerUrlExtension,
  ensureManagedSoftware,
  enrichManagedSoftwareById,
  prepareSoftware,
  backfillVersionDates,
  upsertManagedSoftware,
  versionFromInstallerPath,
  logoSelectionCandidates
};
