const { resolveFinalDownloadUrl } = require('./liteapks-resolver');
const cheerio = require('cheerio');
const state = require('../state');
const config = require('../config');
const { getPool } = require('../db');
const { compareVersions } = require('../utils/version');
const activity = require('./activity');
const notifications = require('./notifications');

const BASE_URL = 'https://liteapks.com';
const SOURCE_TYPE = 'liteapks';
const PLATFORM_KEY = 'android';
const SYNC_KEY = 'liteapks-main';
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WORKER_INTERVAL_MS = 3500;
const CHECK_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const DEFAULT_DAILY_PAGES = 8;
const DEFAULT_FULL_PAGES = 80;
const DEFAULT_MAX_ITEMS = 50000;

let workerStarted = false;
let workerBusy = false;
let lastRequestAt = 0;

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}
function stripTitleNoise(value) {
  return cleanText(value)
    .replace(/\s*[|–—-]\s*LITEAPKS.*$/i, '')
    .replace(/\s+(?:MOD\s+APK|APK\s+MOD|Premium\s+APK).*$/i, '')
    .trim();
}
function slugFromUrl(value) {
  try {
    const u = new URL(value, BASE_URL);
    const name = u.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(name.replace(/\.html?$/i, '')).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  } catch { return ''; }
}
function internalPackageId(url) {
  const slug = slugFromUrl(url);
  return slug ? `liteapks:${slug}` : '';
}
function normalizeSourceUrl(value) {
  try {
    const u = new URL(value, BASE_URL);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!/(^|\.)liteapks\.com$/i.test(u.hostname)) return null;
    u.hash = '';
    return u.toString();
  } catch { return null; }
}
function normalizeMetadataUrl(value, base = BASE_URL) {
  try {
    const u = new URL(value, base);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (u.username || u.password) return null;
    u.hash = '';
    return u.toString();
  } catch { return null; }
}
function compactLabelObject(map) {
  const out = {};
  let count = 0;
  for (const [key, value] of map.entries()) {
    if (count++ >= 80) break;
    out[String(key).slice(0,80)] = cleanText(value).slice(0,500);
  }
  return out;
}
function parseRating(value) {
  const raw=cleanText(value);
  if(!raw)return null;
  const m=raw.match(/(?:^|\b)([0-5](?:\.\d{1,2})?)(?:\s*\/\s*5|\s*(?:stars?|★))?/i);
  if(!m)return null;
  const n=Number(m[1]);
  return Number.isFinite(n)&&n>=0&&n<=5?Math.round(n*100)/100:null;
}
function parseCount(value) {
  const raw = cleanText(value).replace(/,/g,'').toLowerCase();
  const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/i);
  if (!m) return null;
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
  const n = Number(m[1]) * mult;
  return Number.isFinite(n) ? Math.round(n) : null;
}
function isLikelyAppUrl(value) {
  const url = normalizeSourceUrl(value);
  if (!url) return false;
  const u = new URL(url);
  const p = u.pathname.toLowerCase();
  if (!/\.html?$/.test(p)) return false;
  if (/\/(?:privacy|terms|dmca|disclaimer|contact|about|faq|policy|request|report)(?:[-/]|\.|$)/i.test(p)) return false;
  if (/\/download\//i.test(p)) return false;
  return true;
}
function parseBytes(value) {
  const raw = cleanText(value).replace(/,/g, '');
  const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)\b/i);
  if (!m) return null;
  const mult = { B:1, KB:1024, MB:1024**2, GB:1024**3, TB:1024**4 }[m[2].toUpperCase()] || 1;
  const n = Number(m[1]) * mult;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
function parseDate(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  const iso = raw.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function normalizeVersion(value) {
  return cleanText(value).replace(/^v(?=\d)/i, '').replace(/\s+\(.+$/, '').trim().slice(0, 120) || null;
}
function labelMap($) {
  const out = new Map();
  const add = (k,v) => {
    k = cleanText(k).replace(/[:：]\s*$/, '').toLowerCase();
    v = cleanText(v);
    if (k && v && !out.has(k)) out.set(k,v);
  };
  $('tr').each((_,el)=>{
    const cells=$(el).find('th,td');
    if(cells.length>=2)add($(cells[0]).text(),$(cells[1]).text());
  });
  $('dt').each((_,el)=>{const next=$(el).next('dd');if(next.length)add($(el).text(),next.text())});
  $('[class*="info"], [class*="detail"], [class*="meta"], li, p').each((_,el)=>{
    const text=cleanText($(el).text());
    if(!text || text.length>240)return;
    const m=text.match(/^([^:：]{2,45})[:：]\s*(.+)$/);
    if(m)add(m[1],m[2]);
  });
  return out;
}
function firstLabel(map, names) {
  for (const name of names) {
    const needle=String(name).toLowerCase();
    for (const [k,v] of map.entries()) {
      if (k===needle || k.includes(needle)) return v;
    }
  }
  return null;
}
function jsonLdObjects($) {
  const out=[];
  $('script[type="application/ld+json"]').each((_,el)=>{
    try {
      const parsed=JSON.parse($(el).text());
      const walk=v=>{
        if(!v)return;
        if(Array.isArray(v))return v.forEach(walk);
        if(typeof v==='object'){
          out.push(v);
          if(v['@graph'])walk(v['@graph']);
        }
      };
      walk(parsed);
    } catch {}
  });
  return out;
}
function pickSoftwareJsonLd(objects) {
  return objects.find(o=>/softwareapplication|mobileapplication|videoGame|game/i.test(String(o?.['@type']||''))) || null;
}
function metadataContent($, selectors) {
  for (const s of selectors) {
    const v=$(s).first().attr('content') || $(s).first().text();
    if(cleanText(v))return cleanText(v);
  }
  return null;
}
function extractHistoricalVersions($) {
  const found=[];
  const seen=new Set();
  const push=(version,date=null)=>{
    const v=normalizeVersion(version);
    if(!v || seen.has(v.toLowerCase()))return;
    seen.add(v.toLowerCase());
    found.push({version:v,updatedDate:parseDate(date),sourcePageUrl:null});
  };
  const headings=$('h2,h3,h4').filter((_,el)=>/old versions?|previous versions?|other versions?|versions?/i.test(cleanText($(el).text())));
  headings.each((_,heading)=>{
    let node=$(heading).next(); let hops=0;
    while(node.length && hops++<8 && !/^H[1-4]$/i.test(node[0]?.tagName||'')){
      node.find('a,li,tr').addBack('a,li,tr').each((__,el)=>{
        const text=cleanText($(el).text());
        const m=text.match(/(?:version|v)\s*([0-9][0-9A-Za-z._+-]{0,40})/i) || text.match(/^([0-9][0-9A-Za-z._+-]{1,40})\b/);
        if(m)push(m[1],text);
      });
      node=node.next();
    }
  });
  return found.slice(0,20);
}

function screenshotUrls($, app, pageUrl) {
  const values = [];
  const push = value => {
    const url = normalizeMetadataUrl(value, pageUrl);
    if (!url || values.includes(url)) return;
    const path = (()=>{ try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
    if (/\.(?:svg|ico)(?:$|\?)/i.test(path)) return;
    values.push(url);
  };
  const raw = app?.screenshot || app?.screenshots || null;
  if (Array.isArray(raw)) raw.forEach(v => push(typeof v === 'string' ? v : v?.url || v?.contentUrl));
  else if (raw) push(typeof raw === 'string' ? raw : raw?.url || raw?.contentUrl);
  $('[class*="screenshot"] img, [class*="screenshots"] img, [class*="gallery"] img, [class*="slider"] img, [id*="screenshot"] img').each((_, el) => {
    push($(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('data-original') || $(el).attr('src'));
  });
  $('h2,h3,h4').filter((_,el)=>/screenshots?|images?|gallery/i.test(cleanText($(el).text()))).each((_,heading)=>{
    let node=$(heading).next(); let hops=0;
    while(node.length && hops++<5 && !/^H[1-4]$/i.test(node[0]?.tagName||'')){
      node.find('img').addBack('img').each((__,el)=>push($(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('data-original') || $(el).attr('src')));
      node=node.next();
    }
  });
  return values.slice(0, 24);
}

function appIconUrl($, app, pageUrl) {
  const candidates = [];
  const push = value => { if (value) candidates.push(value); };
  if (Array.isArray(app?.image)) app.image.forEach(v=>push(typeof v==='string'?v:v?.url||v?.contentUrl));
  else push(typeof app?.image==='string'?app.image:app?.image?.url||app?.image?.contentUrl);
  const selectors = [
    '.app-icon img','.apk-icon img','.icon-app img','.post-icon img','[class*="app-icon"] img','[class*="apk-icon"] img',
    'img[itemprop="image"]','meta[property="og:image"]','meta[name="twitter:image"]'
  ];
  for (const selector of selectors) {
    const el=$(selector).first();
    push(el.attr('data-src') || el.attr('data-lazy-src') || el.attr('data-original') || el.attr('src') || el.attr('content'));
  }
  for (const value of candidates) {
    const url=normalizeMetadataUrl(value,pageUrl);
    if (url) return url;
  }
  return null;
}

function playStoreUrl($, app, labels, sourcePackageId, pageUrl) {
  const candidates=[];
  const add=value=>{ if(value)candidates.push(value); };
  const same=app?.sameAs;
  if(Array.isArray(same))same.forEach(add); else add(same);
  add(app?.url);
  add(firstLabel(labels,['google play','play store','google play store','original app','original version']));
  $('a[href*="play.google.com/store/apps/details"]').each((_,el)=>add($(el).attr('href')));
  for(const value of candidates){
    const url=normalizeMetadataUrl(value,pageUrl);
    if(!url)continue;
    try{
      const u=new URL(url);
      if(/(^|\.)play\.google\.com$/i.test(u.hostname) && /\/store\/apps\/details/i.test(u.pathname))return u.toString();
    }catch{}
  }
  return null;
}

function downloadPageUrl($, pageUrl) {
  const candidates = [];
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href');
    const text = cleanText($(el).text());
    const url = normalizeSourceUrl(raw);
    if (!url) return;
    try {
      const u = new URL(url);
      if (/^\/download\//i.test(u.pathname) && (/(?:download|apk|xapk|apks|get)/i.test(text) || /\/download\//i.test(u.pathname))) {
        candidates.push({ url: u.toString(), score: /download\s+(?:apk|xapk|apks)/i.test(text) ? 3 : /download/i.test(text) ? 2 : 1 });
      }
    } catch {}
  });
  candidates.sort((a,b)=>b.score-a.score || a.url.length-b.url.length);
  return candidates[0]?.url || null;
}

function parseDownloadLanding(html, pageUrl) {
  const $ = cheerio.load(String(html || ''));
  const labels = labelMap($);
  const pageText = cleanText($('body').text());
  const title = cleanText(metadataContent($,['meta[property="og:title"]','meta[name="twitter:title"]','h1','title']));
  const version = normalizeVersion(firstLabel(labels,['version','latest version','current version']) || (title.match(/\bv?([0-9]+(?:\.[0-9A-Za-z_-]+){1,})\b/)||[])[1] || (pageText.match(/\bVersion\s*[:：]?\s*v?([0-9][0-9A-Za-z._+-]{0,40})/i)||[])[1]);
  const sizeText = cleanText(firstLabel(labels,['size','file size','apk size']) || (pageText.match(/\b([0-9]+(?:\.[0-9]+)?\s*(?:KB|MB|GB|TB))\b/i)||[])[1]);
  const installerType = /\bXAPK\b/i.test(pageText) ? 'XAPK' : /\bAPKS\b/i.test(pageText) ? 'APKS' : 'APK';
  return {
    pageUrl: normalizeSourceUrl(pageUrl),
    version,
    sizeText: sizeText || null,
    fileSizeBytes: parseBytes(sizeText),
    installerType
  };
}

async function directPublicFileUrl($, app, pageUrl) {
  // Resolve publicly exposed APK-family URLs from the app/download pages.
  // This intentionally does not bypass ads, timers, tokens, or anti-bot protection.
  const candidates=[];
  const add=value=>{ if(value)candidates.push(value); };
  add(app?.contentUrl); add(app?.downloadUrl);
  if(Array.isArray(app?.distribution))app.distribution.forEach(v=>add(typeof v==='string'?v:v?.contentUrl||v?.url));
  $('a[href]').each((_,el)=>{
    const href=$(el).attr('href');
    if(/\.(?:apk|xapk|apks)(?:$|[?#])/i.test(String(href||'')))add(href);
  });
  for(const value of candidates){
    const url=normalizeMetadataUrl(value,pageUrl);
    if(!url)continue;
    try{if(/\.(?:apk|xapk|apks)$/i.test(new URL(url).pathname))return url}catch{}
  }
  return null;
}

function apkTypeLabel({ title, modInfo, price, labels, pageText }) {
  const labelText=cleanText(firstLabel(labels,['mod info','mod features','features','type','apk type','mod'])||'');
  const text=[title,modInfo,labelText,pageText.slice(0,5000)].filter(Boolean).join(' | ');
  const out=[];
  const add=v=>{ if(v&&!out.some(x=>x.toLowerCase()===v.toLowerCase()))out.push(v); };
  if(/pre[- ]?activated/i.test(text))add('Pre-Activated');
  if(/unlimited\s+(?:money|coins?|gems?|currency|cash)/i.test(text))add((text.match(/unlimited\s+(?:money|coins?|gems?|currency|cash)/i)||['Unlimited'])[0].replace(/\b\w/g,c=>c.toUpperCase()));
  if(/premium\s+unlocked/i.test(text))add('Premium Unlocked');
  else if(/pro\s+unlocked/i.test(text))add('Pro Unlocked');
  else if(/(?:all\s+features?|features?)\s+unlocked|unlocked\s+(?:apk|features?)/i.test(text))add('Unlocked APK');
  if(/\bmod(?:ded)?\s*apk\b/i.test(text) || /\bmod\b/i.test(modInfo||''))add('MOD APK');
  if(/\bpaid\b/i.test(text) && !out.length)add('Paid');
  const numericPrice=Number(price);
  if((String(price||'').trim()==='0'||numericPrice===0||/\bfree\b/i.test(text))&&!out.length)add('Free');
  if(!out.length)add(modInfo?cleanText(modInfo).slice(0,120):'APK');
  return out.slice(0,4).join(' · ');
}
function externalWebsite($, labels, app, pageUrl) {
  const candidates = [
    app?.author?.url, app?.publisher?.url,
    firstLabel(labels,['official website','website','developer website','homepage'])
  ];
  $('a[href]').each((_,el)=>{
    const text=cleanText($(el).text());
    if (/^(?:official\s+)?(?:website|homepage|developer website)$/i.test(text)) candidates.push($(el).attr('href'));
  });
  for (const value of candidates) {
    const url=normalizeMetadataUrl(value,pageUrl);
    if (!url) continue;
    try { if (!/(^|\.)liteapks\.com$/i.test(new URL(url).hostname)) return url; } catch {}
  }
  return null;
}

async function parseAppPage(html, pageUrl) {
  const sourcePageUrl=normalizeSourceUrl(pageUrl);
  if(!sourcePageUrl)throw new Error('LiteAPKs page URL is invalid.');
  const $=cheerio.load(String(html||''));
  const labels=labelMap($);
  const objects=jsonLdObjects($);
  const app=pickSoftwareJsonLd(objects) || {};
  const title=stripTitleNoise(app.name || metadataContent($,['meta[property="og:title"]','meta[name="twitter:title"]','h1','title']));
  const description=cleanText(app.description || metadataContent($,['meta[name="description"]','meta[property="og:description"]','.description','.entry-content p']));
  const pageText=cleanText($('body').text());
  const version=normalizeVersion(app.softwareVersion || firstLabel(labels,['version','latest version','current version']) || (pageText.match(/\bVersion\s*[:：]?\s*v?([0-9][0-9A-Za-z._+-]{0,40})/i)||[])[1]);
  const updatedRaw=app.dateModified || app.datePublished || firstLabel(labels,['updated','update','last updated','release date']);
  const developerObj=app.author || app.publisher || {};
  const publisher=cleanText(typeof developerObj==='string'?developerObj:(developerObj.name||'')) || firstLabel(labels,['developer','publisher','author']);
  const category=cleanText(app.applicationCategory || firstLabel(labels,['category','genre'])) || null;
  const sourcePackageId=cleanText(firstLabel(labels,['package name','package id','package'])) || null;
  const sizeRaw=cleanText(app.fileSize || firstLabel(labels,['size','file size']));
  const androidRaw=cleanText(app.operatingSystem || firstLabel(labels,['requires android','android','minimum android','min android']));
  const architecture=cleanText(firstLabel(labels,['architecture','cpu architecture','supported abi','abi'])) || 'Android';
  const modInfo=cleanText(firstLabel(labels,['mod info','mod features','features'])) || null;
  const price=cleanText(app.offers?.price ?? firstLabel(labels,['price'])) || null;
  const ratingValue=parseRating(app.aggregateRating?.ratingValue || firstLabel(labels,['rating','user rating','ratings']) || (pageText.match(/(?:rating|rated)\s*[:：]?\s*([0-5](?:\.\d{1,2})?)(?:\s*\/\s*5|\s*★)?/i)||[])[1]);
  const iconUrl=appIconUrl($,app,sourcePageUrl);
  const screenshots=screenshotUrls($,app,sourcePageUrl).filter(u=>u!==iconUrl);
  const officialUrl=externalWebsite($,labels,app,sourcePageUrl);
  const playStore=playStoreUrl($,app,labels,sourcePackageId,sourcePageUrl);
  const downloadPage=downloadPageUrl($,sourcePageUrl);
  const directDownload=directPublicFileUrl($,app,sourcePageUrl);
  const apkType=apkTypeLabel({title,modInfo,price,labels,pageText});
  const licenseName=cleanText(firstLabel(labels,['license','licence'])) || null;
  const language=cleanText(firstLabel(labels,['language','languages'])) || null;
  const downloadCount=parseCount(firstLabel(labels,['downloads','download count']));
  const slug=slugFromUrl(sourcePageUrl);
  const looksLike=Boolean(title && (version || sourcePackageId || /\b(?:apk|android|mod)\b/i.test(pageText)));
  const installerType=/\bXAPK\b/i.test(pageText)?'XAPK':'APK';
  const tags=[];
  if(modInfo)tags.push('MOD');
  if(category)tags.push(category);
  return {
    looksLikeAppPage:looksLike,
    internalPackageId:`liteapks:${slug}`,
    sourceSlug:slug,
    sourceType:SOURCE_TYPE,
    platformKey:PLATFORM_KEY,
    sourcePageUrl,
    sourcePackageId:sourcePackageId?.slice(0,255)||null,
    name:title || slug || 'Android app',
    publisher:publisher?.slice(0,255)||null,
    category:category?.slice(0,120)||'Android Apps',
    version,
    description:description?.slice(0,65535)||null,
    updatedDate:parseDate(updatedRaw),
    fileSizeBytes:parseBytes(sizeRaw),
    minimumOsVersion:androidRaw?.slice(0,255)||null,
    architecture:architecture?.slice(0,80)||'Android',
    installerType,
    iconUrl,
    screenshots,
    officialUrl,
    licenseName,
    language,
    downloadCount,
    modInfo,
    price,
    ratingValue,
    apkType,
    playStoreUrl:playStore,
    downloadPageUrl:downloadPage,
    directDownloadUrl:directDownload,
    tags,
    oldVersions:extractHistoricalVersions($),
    metadata:{
      source:'LiteAPKs',sourcePageUrl,sourceSlug:slug,sourcePackageId:sourcePackageId||null,
      version:version||null,updated:parseDate(updatedRaw),size:sizeRaw||null,requiresAndroid:androidRaw||null,
      architecture:architecture||null,installerType,modInfo:modInfo||null,apkType,price:price||null,ratingValue,
      iconUrl:iconUrl||null,screenshots,playStoreUrl:playStore||null,downloadPageUrl:downloadPage||null,directDownloadUrl:directDownload||null,officialUrl:officialUrl||null,licenseName:licenseName||null,
      language:language||null,downloadCount,labels:compactLabelObject(labels)
    }
  };
}

function discoverLinks(html, pageUrl) {
  const $=cheerio.load(String(html||''));
  const apps=[]; const listings=[]; const seenA=new Set(); const seenL=new Set();
  $('a[href]').each((_,el)=>{
    const raw=$(el).attr('href'); const url=normalizeSourceUrl(raw);
    if(!url)return;
    if(isLikelyAppUrl(url)){
      if(!seenA.has(url)){seenA.add(url);apps.push(url)}
      return;
    }
    const u=new URL(url); const text=cleanText($(el).text()).toLowerCase();
    const path=u.pathname.toLowerCase();
    if(u.origin===BASE_URL && (/\/page\/\d+\/?$/.test(path) || /(?:next|older|more apps|latest|updated)/i.test(text))) {
      if(!seenL.has(url)){seenL.add(url);listings.push(url)}
    }
  });
  return {apps,listings};
}

async function politeDelay() {
  const gap=Math.max(700,Number(config.liteapksRequestGapMs||1400));
  const wait=lastRequestAt+gap-Date.now();
  if(wait>0)await new Promise(r=>setTimeout(r,wait));
}
async function fetchText(url,{accept='text/html,application/xhtml+xml'}={}) {
  const safe=normalizeSourceUrl(url);
  if(!safe)throw new Error('LiteAPKs request was blocked because the URL is outside liteapks.com.');
  await politeDelay();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try{
    const res=await fetch(safe,{redirect:'follow',signal:controller.signal,headers:{
      'user-agent':'HSWareStudio/4.6 LiteAPKs metadata sync (+standard public HTTP fetch)',
      'accept':accept,'accept-language':'en-US,en;q=0.8','cache-control':'no-cache'
    }});
    lastRequestAt=Date.now();
    const finalUrl=normalizeSourceUrl(res.url);
    if(!finalUrl)throw new Error('LiteAPKs redirected outside liteapks.com.');
    if(res.status===403||res.status===401)throw new Error('LiteAPKs blocked the standard metadata request (HTTP 403/401). HSWare will not bypass anti-bot protection.');
    if(res.status===429)throw new Error('LiteAPKs rate-limited the metadata sync (HTTP 429). HSWare will retry later.');
    if(!res.ok)throw new Error(`LiteAPKs returned HTTP ${res.status}.`);
    const len=Number(res.headers.get('content-length')||0);
    if(len>MAX_HTML_BYTES)throw new Error('LiteAPKs response is larger than the safe metadata limit.');
    const text=await res.text();
    if(Buffer.byteLength(text,'utf8')>MAX_HTML_BYTES)throw new Error('LiteAPKs response is larger than the safe metadata limit.');
    return {text,url:finalUrl,contentType:res.headers.get('content-type')||''};
  }catch(err){
    if(err?.name==='AbortError')throw new Error('LiteAPKs request timed out.');
    throw err;
  }finally{clearTimeout(timer)}
}

function xmlLocations(xml) {
  const out=[]; const re=/<loc>\s*([^<]+?)\s*<\/loc>/gi; let m;
  while((m=re.exec(String(xml||'')))){
    const url=normalizeSourceUrl(m[1].replace(/&amp;/g,'&'));
    if(url)out.push(url);
  }
  return out;
}
function xmlEntries(xml) {
  const out=[];
  const text=String(xml||'');
  const blockRe=/<(?:url|sitemap)>[\s\S]*?<\/(?:url|sitemap)>/gi;
  let block;
  while((block=blockRe.exec(text))){
    const loc=(block[0].match(/<loc>\s*([^<]+?)\s*<\/loc>/i)||[])[1];
    const lastmod=(block[0].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)||[])[1]||null;
    const url=loc?normalizeSourceUrl(loc.replace(/&amp;/g,'&')):null;
    if(url)out.push({url,lastmod:lastmod?cleanText(lastmod):null});
  }
  return out;
}
function recentLastmod(value, days=3) {
  if(!value)return false;
  const ms=new Date(value).getTime();
  return Number.isFinite(ms) && ms >= Date.now()-(Math.max(1,days)*24*60*60*1000);
}
async function sitemapAppUrls(limit=DEFAULT_MAX_ITEMS) {
  const candidates=[`${BASE_URL}/sitemap.xml`,`${BASE_URL}/sitemap_index.xml`];
  const appUrls=[]; const visited=new Set();
  for(const root of candidates){
    try{
      const {text}=await fetchText(root,{accept:'application/xml,text/xml,text/plain,*/*'});
      const locs=xmlLocations(text);
      if(!locs.length)continue;
      const sitemapUrls=locs.filter(x=>/sitemap/i.test(new URL(x).pathname)).slice(0,60);
      const direct=locs.filter(isLikelyAppUrl);
      appUrls.push(...direct);
      for(const sm of sitemapUrls){
        if(visited.has(sm))continue;visited.add(sm);
        try{const r=await fetchText(sm,{accept:'application/xml,text/xml,text/plain,*/*'});appUrls.push(...xmlLocations(r.text).filter(isLikelyAppUrl));}catch{}
        if(appUrls.length>=limit)break;
      }
      if(appUrls.length)break;
    }catch{}
  }
  return [...new Set(appUrls)].slice(0,limit);
}

async function sitemapRecentlyModifiedAppUrls(limit=2000, days=3) {
  const roots=[`${BASE_URL}/sitemap.xml`,`${BASE_URL}/sitemap_index.xml`];
  const found=[]; const seen=new Set();
  for(const root of roots){
    try{
      const {text}=await fetchText(root,{accept:'application/xml,text/xml,text/plain,*/*'});
      const entries=xmlEntries(text);
      if(!entries.length)continue;
      const direct=entries.filter(e=>isLikelyAppUrl(e.url)&&recentLastmod(e.lastmod,days));
      for(const e of direct){if(!seen.has(e.url)){seen.add(e.url);found.push(e.url)}}
      const childMaps=entries.filter(e=>/sitemap/i.test(new URL(e.url).pathname)).slice(0,80);
      for(const child of childMaps){
        if(found.length>=limit)break;
        // A recent sitemap lastmod is useful as a hint, but individual URL
        // lastmod values are still required before an app is queued.
        try{
          const r=await fetchText(child.url,{accept:'application/xml,text/xml,text/plain,*/*'});
          for(const e of xmlEntries(r.text)){
            if(isLikelyAppUrl(e.url)&&recentLastmod(e.lastmod,days)&&!seen.has(e.url)){
              seen.add(e.url);found.push(e.url);if(found.length>=limit)break;
            }
          }
        }catch{}
      }
      if(found.length)break;
    }catch{}
  }
  return found.slice(0,limit);
}

async function crawlListings(maxPages=DEFAULT_DAILY_PAGES,limit=DEFAULT_MAX_ITEMS) {
  const queue=[BASE_URL]; const visited=new Set(); const apps=[]; const appSeen=new Set();
  while(queue.length && visited.size<maxPages && apps.length<limit){
    const url=queue.shift();if(visited.has(url))continue;visited.add(url);
    try{
      const {text, url:finalUrl}=await fetchText(url);
      const d=discoverLinks(text,finalUrl);
      for(const a of d.apps){if(!appSeen.has(a)){appSeen.add(a);apps.push(a);if(apps.length>=limit)break}}
      for(const n of d.listings){if(!visited.has(n)&&queue.length<maxPages*2)queue.push(n)}
    }catch(err){if(visited.size===1)throw err}
  }
  return apps;
}

async function getSyncState() {
  const [rows]=await getPool().query('SELECT * FROM liteapks_sync_state WHERE sync_key=? LIMIT 1',[SYNC_KEY]);
  return rows[0]||{sync_key:SYNC_KEY,status:'idle',mode:'daily',queue_json:'[]',total_count:0,processed_count:0,inserted_count:0,updated_count:0,failed_count:0,last_error:null,last_started_at:null,last_completed_at:null,next_sync_at:null};
}
async function ensureStateRow() {
  await getPool().query(`INSERT INTO liteapks_sync_state (sync_key,status,mode,queue_json,next_sync_at) VALUES (?,'idle','daily','[]',NOW()) ON DUPLICATE KEY UPDATE sync_key=VALUES(sync_key)`,[SYNC_KEY]);
}
async function discoverForSync(mode='daily') {
  const limit=Math.max(50,Math.min(DEFAULT_MAX_ITEMS,Number(config.liteapksMaxItems||DEFAULT_MAX_ITEMS)));
  if(mode==='full'){
    const sitemap=await sitemapAppUrls(limit);
    if(sitemap.length)return sitemap;
    return crawlListings(Math.max(10,Number(config.liteapksFullPages||DEFAULT_FULL_PAGES)),limit);
  }
  const dailyLimit=Math.min(limit,5000);
  const recent=await sitemapRecentlyModifiedAppUrls(dailyLimit,3);
  if(recent.length)return recent;
  return crawlListings(Math.max(2,Number(config.liteapksDailyPages||DEFAULT_DAILY_PAGES)),Math.min(dailyLimit,2000));
}
async function startSync({mode='auto',requestedBy=null,force=false}={}) {
  const db=getPool();await ensureStateRow();
  const current=await getSyncState();
  if(['discovering','running'].includes(current.status)&&!force)return current;
  const [[androidCount]]=await db.query("SELECT COUNT(*) c FROM software WHERE source_type='liteapks'");
  const chosen=mode==='full'||mode==='daily'?mode:(Number(androidCount.c||0)===0?'full':'daily');
  await db.query(`UPDATE liteapks_sync_state SET status='discovering',mode=?,queue_json='[]',total_count=0,processed_count=0,inserted_count=0,updated_count=0,failed_count=0,current_url=NULL,last_error=NULL,requested_by=?,completion_notified=0,last_started_at=NOW(),next_sync_at=NULL WHERE sync_key=?`,[chosen,requestedBy?Number(requestedBy):null,SYNC_KEY]);
  try{
    const urls=await discoverForSync(chosen);
    if(!urls.length)throw new Error('No LiteAPKs application pages were discovered. The site layout may have changed or blocked public requests.');
    await db.query("UPDATE liteapks_sync_state SET status='running',queue_json=?,total_count=? WHERE sync_key=?",[JSON.stringify(urls),urls.length,SYNC_KEY]);
    if(requestedBy)await activity.record(Number(requestedBy),'liteapks_sync_started',{details:{mode:chosen,total:urls.length}});
  }catch(err){
    const msg=String(err.message||err).slice(0,1800);
    await db.query("UPDATE liteapks_sync_state SET status='paused',last_error=?,next_sync_at=DATE_ADD(NOW(),INTERVAL 1 HOUR) WHERE sync_key=?",[msg,SYNC_KEY]);
    throw err;
  }
  return getSyncState();
}

async function upsertCatalog(details) {
  const db=getPool();
  await db.query(`INSERT INTO catalog_packages
    (package_id,name,publisher,category,search_aliases,source_path,metadata_status,platform_key,source_type,source_page_url,source_package_id,source_updated_at)
    VALUES (?,?,?,?,?,?,'enriched',?,?,?,?,?)
    ON DUPLICATE KEY UPDATE name=VALUES(name),publisher=COALESCE(VALUES(publisher),publisher),category=COALESCE(VALUES(category),category),search_aliases=VALUES(search_aliases),source_path=VALUES(source_path),metadata_status='enriched',platform_key='android',source_type='liteapks',source_page_url=VALUES(source_page_url),source_package_id=COALESCE(VALUES(source_package_id),source_package_id),source_updated_at=COALESCE(VALUES(source_updated_at),source_updated_at),last_metadata_error=NULL,last_metadata_attempt_at=NOW()`,
    [details.internalPackageId,details.name,details.publisher,details.category,`${details.name} ${details.sourcePackageId||''} ${details.sourceSlug} ${details.publisher||''} ${details.modInfo||''}`,details.sourcePageUrl,PLATFORM_KEY,SOURCE_TYPE,details.sourcePageUrl,details.sourcePackageId,details.updatedDate]);
}

async function upsertManaged(details,{autoAdd=true}={}) {
  if(!details?.looksLikeAppPage)throw new Error('The LiteAPKs page did not look like an Android app detail page.');
  const db=getPool();
  await upsertCatalog(details);
  const [[existing]]=await db.query('SELECT * FROM software WHERE package_id=? LIMIT 1',[details.internalPackageId]);
  const oldVersion=existing?.current_version||null;
  let available=false;
  let updateReason=null;
  let oldMeta={};
  try{oldMeta=existing?.source_metadata_json?JSON.parse(existing.source_metadata_json):{}}catch{}
  if(existing && details.version && oldVersion){
    try{available=compareVersions(details.version,oldVersion)>0}catch{available=details.version!==oldVersion}
    if(available)updateReason='version';
  }
  if(existing && !available && existing.file_size_bytes && details.fileSizeBytes && Number(existing.file_size_bytes)!==Number(details.fileSizeBytes)){available=true;updateReason='size'}
  if(existing && !available && oldMeta.downloadPageUrl && details.downloadPageUrl && String(oldMeta.downloadPageUrl)!==String(details.downloadPageUrl)){available=true;updateReason='download-page'}
  if(updateReason)details.metadata.updateReason=updateReason;
  await db.query(`INSERT INTO software
    (package_id,name,category,publisher,current_version,description,source_path,workspace_added,workspace_added_at,enrichment_status,enriched_at,metadata_revision,platform,minimum_os_version,architecture,installer_type,file_size_bytes,language,official_url,license_name,download_count,download_count_source,platform_key,source_type,source_page_url,source_package_id,source_updated_at,source_metadata_json,tags_json,link_status,link_checked_at)
    VALUES (?,?,?,?,?,?,?,?,NOW(),'ready',NOW(),7,'Android',?,?,?,?,?,?,?,?,'liteapks-page','android','liteapks',?,?,?,?,?,'ready',NOW())
    ON DUPLICATE KEY UPDATE
      name=VALUES(name),category=COALESCE(VALUES(category),category),publisher=COALESCE(VALUES(publisher),publisher),description=COALESCE(VALUES(description),description),
      source_path=VALUES(source_path),workspace_added=IF(?,1,workspace_added),workspace_added_at=IF(? AND (workspace_added=0 OR workspace_added_at IS NULL),NOW(),workspace_added_at),
      enrichment_status='ready',enrichment_error=NULL,enriched_at=NOW(),metadata_revision=7,platform='Android',minimum_os_version=COALESCE(VALUES(minimum_os_version),minimum_os_version),
      architecture=COALESCE(VALUES(architecture),architecture),installer_type=COALESCE(VALUES(installer_type),installer_type),file_size_bytes=COALESCE(VALUES(file_size_bytes),file_size_bytes),
      language=COALESCE(VALUES(language),language,'English'),official_url=COALESCE(VALUES(official_url),official_url),license_name=COALESCE(VALUES(license_name),license_name),download_count=COALESCE(VALUES(download_count),download_count),download_count_source=IF(VALUES(download_count) IS NULL,download_count_source,'liteapks-page'),platform_key='android',source_type='liteapks',source_page_url=VALUES(source_page_url),source_package_id=COALESCE(VALUES(source_package_id),source_package_id),
      source_updated_at=COALESCE(VALUES(source_updated_at),source_updated_at),source_metadata_json=VALUES(source_metadata_json),tags_json=VALUES(tags_json),link_status='ready',link_checked_at=NOW(),
      latest_version=IF(? AND current_version IS NOT NULL,VALUES(current_version),latest_version),update_available=IF(? AND current_version IS NOT NULL,1,update_available),last_checked_at=NOW(),update_error=NULL`,
    [details.internalPackageId,details.name,details.category,details.publisher,details.version,details.description,details.sourcePageUrl,autoAdd?1:0,details.minimumOsVersion,details.architecture,details.installerType,details.fileSizeBytes,details.language||'English',details.officialUrl,details.licenseName,details.downloadCount,details.sourcePageUrl,details.sourcePackageId,details.updatedDate,JSON.stringify(details.metadata),JSON.stringify(details.tags||[]),autoAdd?1:0,autoAdd?1:0,available?1:0,available?1:0]);
  const [[sw]]=await db.query('SELECT * FROM software WHERE package_id=? LIMIT 1',[details.internalPackageId]);
  if(!sw)throw new Error('LiteAPKs software record could not be created.');
  await db.query('UPDATE catalog_packages SET managed_software_id=? WHERE package_id=?',[sw.id,details.internalPackageId]);
  try { await db.query(`INSERT INTO enrichment_queue (software_id,status,media_status,next_attempt_at,last_error,completed_at) VALUES (?,'ready','disabled',NULL,NULL,NOW()) ON DUPLICATE KEY UPDATE status=IF(status='running','running','ready'),media_status='disabled',next_attempt_at=NULL,last_error=NULL,completed_at=NOW()`,[sw.id]); } catch {}
  for(const v of details.oldVersions||[]){
    if(!v.version || v.version===details.version)continue;
    await db.query(`INSERT INTO software_versions (software_id,version,installer_url,architecture,installer_type,sha256,source_path,release_date,release_date_source,source_page_url)
      VALUES (?,?,NULL,?,'APK',NULL,?,?,?,?)
      ON DUPLICATE KEY UPDATE architecture=VALUES(architecture),source_path=VALUES(source_path),release_date=COALESCE(VALUES(release_date),release_date),release_date_source=COALESCE(VALUES(release_date_source),release_date_source),source_page_url=VALUES(source_page_url)`,
      [sw.id,v.version,details.architecture,details.sourcePageUrl,v.updatedDate,v.updatedDate?'liteapks-page':'not-reported',details.sourcePageUrl]);
  }
  return {software:sw,inserted:!existing,updated:Boolean(existing),updateAvailable:available};
}

async function searchCatalog(q, limit=30) {
  const term=cleanText(q);
  if(!term)return [];
  const db=getPool();
  const like=`%${term}%`;
  const [rows]=await db.query(`SELECT c.*,s.id AS managed_id,s.workspace_added
    FROM catalog_packages c LEFT JOIN software s ON s.package_id=c.package_id
    WHERE c.source_type='liteapks' AND (c.name LIKE ? OR c.source_package_id LIKE ? OR c.search_aliases LIKE ? OR c.source_page_url LIKE ?)
    ORDER BY COALESCE(c.source_updated_at,'1970-01-01') DESC,c.name LIMIT ?`,[like,like,like,like,Math.max(1,Math.min(100,Number(limit||30)))]);
  return rows.map(r=>({
    packageId:r.package_id,name:r.name,publisher:r.publisher||'LiteAPKs',category:r.category||'Android Apps',
    sourceType:'liteapks',platformKey:'android',sourcePageUrl:r.source_page_url||null,sourcePackageId:r.source_package_id||null,
    managed:Boolean(r.managed_id&&r.workspace_added),managedSoftwareId:r.managed_id?Number(r.managed_id):null,updatedDate:r.source_updated_at||null
  }));
}

async function fetchPackageDetails(pageUrl) {
  const {text,url}=await fetchText(pageUrl);
  const d=await parseAppPage(text,url);
  if(!d.looksLikeAppPage)throw new Error('LiteAPKs did not return a recognizable app detail page.');
  if(d.downloadPageUrl){
    try{
      const landing=await fetchText(d.downloadPageUrl);
      const parsed=parseDownloadLanding(landing.text,landing.url);
      d.downloadPageUrl=parsed.pageUrl||d.downloadPageUrl;
      if(parsed.version)d.version=parsed.version;
      if(parsed.fileSizeBytes)d.fileSizeBytes=parsed.fileSizeBytes;
      if(parsed.installerType)d.installerType=parsed.installerType;
      // The detail page often only contains a download landing page. Check the landing page
      // for a publicly exposed final APK-family URL and store it for copy/download actions.
      const landing$=cheerio.load(String(landing.text || ''));
      let resolvedDirect=await directPublicFileUrl(landing$,{},landing.url);
      // If LiteAPKs generates the final file URL with JavaScript, try the browser resolver.
      if(!resolvedDirect){
        resolvedDirect = await resolveFinalDownloadUrl(d.downloadPageUrl);
      }
      if(resolvedDirect){
        d.directDownloadUrl=resolvedDirect;
        d.metadata.directDownloadUrl=resolvedDirect;
      }
      d.metadata.downloadPageUrl=d.downloadPageUrl;
      d.metadata.downloadVersion=parsed.version||null;
      d.metadata.downloadSize=parsed.sizeText||null;
      d.metadata.downloadInstallerType=parsed.installerType||null;
      d.metadata.downloadPageCheckedAt=new Date().toISOString();
    }catch(err){
      d.metadata.downloadPageError=String(err.message||err).slice(0,500);
    }
  }
  return d;
}
async function ensureManagedFromUrl(pageUrl) {
  const d=await fetchPackageDetails(pageUrl);
  return (await upsertManaged(d,{autoAdd:true})).software;
}
async function enrichManagedSoftwareById(id) {
  const db=getPool();
  const [[sw]]=await db.query('SELECT * FROM software WHERE id=? LIMIT 1',[id]);
  if(!sw)throw new Error('Software not found.');
  if(sw.source_type!==SOURCE_TYPE)throw new Error('This record is not a LiteAPKs app.');
  if(!sw.source_page_url)throw new Error('LiteAPKs source page is missing.');
  try{
    await db.query("UPDATE software SET enrichment_status='fetching',last_enrichment_attempt_at=NOW(),enrichment_attempts=COALESCE(enrichment_attempts,0)+1 WHERE id=?",[id]);
    const details=await fetchPackageDetails(sw.source_page_url);
    await upsertManaged(details,{autoAdd:true});
    const [[fresh]]=await db.query('SELECT * FROM software WHERE id=? LIMIT 1',[id]);
    return fresh;
  }catch(err){
    await db.query("UPDATE software SET enrichment_status='error',enrichment_error=?,update_error=? WHERE id=?",[String(err.message||err).slice(0,1800),String(err.message||err).slice(0,1800),id]);
    throw err;
  }
}
async function prepareSoftware(id) {
  const db=getPool(); const [[sw]]=await db.query('SELECT * FROM software WHERE id=? LIMIT 1',[id]);
  if(!sw)throw new Error('Software not found.');
  if(sw.source_type!==SOURCE_TYPE)return {software:sw,refreshed:false,warning:null};
  try{return {software:await enrichManagedSoftwareById(id),refreshed:true,warning:null}}catch(err){return {software:sw,refreshed:false,warning:err.message||String(err)}}
}
async function checkUpdateForSoftware(sw) {
  const details=await fetchPackageDetails(sw.source_page_url);
  let available=false; let reason=null; let oldMeta={};
  try{oldMeta=sw.source_metadata_json?JSON.parse(sw.source_metadata_json):{}}catch{}
  if(details.version){
    try{available=!sw.current_version||compareVersions(details.version,sw.current_version)>0}catch{available=!sw.current_version||details.version!==sw.current_version}
    if(available)reason='version';
  }
  if(!available && sw.file_size_bytes && details.fileSizeBytes && Number(sw.file_size_bytes)!==Number(details.fileSizeBytes)){available=true;reason='size'}
  if(!available && oldMeta.downloadPageUrl && details.downloadPageUrl && String(oldMeta.downloadPageUrl)!==String(details.downloadPageUrl)){available=true;reason='download-page'}
  if(reason)details.metadata.updateReason=reason;
  await getPool().query(`UPDATE software SET latest_version=?,latest_installer_url=NULL,latest_sha256=NULL,update_available=?,last_checked_at=NOW(),update_error=NULL,source_updated_at=COALESCE(?,source_updated_at),source_metadata_json=? WHERE id=?`,[details.version||sw.current_version,available?1:0,details.updatedDate,JSON.stringify(details.metadata),sw.id]);
  return {details,available,reason};
}

async function resolveDownloadForSoftware(id){
  const db=getPool();
  const [[sw]]=await db.query('SELECT * FROM software WHERE id=? LIMIT 1',[Number(id)]);
  if(!sw)throw Object.assign(new Error('APK not found.'),{status:404});
  if(String(sw.source_type||'').toLowerCase()!==SOURCE_TYPE)throw Object.assign(new Error('This is not a LiteAPKs Android record.'),{status:400});
  const details=await fetchPackageDetails(sw.source_page_url);
  await upsertManaged(details,{autoAdd:true});
  const direct=details.directDownloadUrl||null;
  if(direct)return {url:direct,mode:'direct'};
  throw Object.assign(new Error('Direct APK/XAPK/APKS file URL was not resolved. The LiteAPKs source page is not returned as a download link.'),{status:404,code:'DIRECT_LINK_NOT_FOUND'});
}
async function markUpdated(id) {
  const db=getPool(); const [[sw]]=await db.query('SELECT * FROM software WHERE id=? LIMIT 1',[id]);
  if(!sw)throw new Error('Software not found.');
  const fresh=await enrichManagedSoftwareById(id);
  const latest=fresh.latest_version||fresh.current_version;
  if(latest && latest!==fresh.current_version){
    await db.query('UPDATE software SET current_version=?,latest_version=NULL,latest_installer_url=NULL,latest_sha256=NULL,update_available=0,last_checked_at=NOW(),update_error=NULL WHERE id=?',[latest,id]);
  }else{
    await db.query('UPDATE software SET latest_version=NULL,latest_installer_url=NULL,latest_sha256=NULL,update_available=0,last_checked_at=NOW(),update_error=NULL WHERE id=?',[id]);
  }
  return true;
}

async function finishSyncIfNeeded(db,st) {
  let queue=[];try{queue=JSON.parse(st.queue_json||'[]')}catch{}
  if(queue.length)return st;
  await db.query("UPDATE liteapks_sync_state SET status='complete',current_url=NULL,last_completed_at=NOW(),next_sync_at=DATE_ADD(NOW(),INTERVAL 24 HOUR) WHERE sync_key=?",[SYNC_KEY]);
  const done=await getSyncState();
  if(!Number(done.requested_by||0) && !Number(done.completion_notified||0)){
    const [mark]=await db.query('UPDATE liteapks_sync_state SET completion_notified=1 WHERE sync_key=? AND completion_notified=0',[SYNC_KEY]);
    if(mark.affectedRows){
      await notifications.notifyAdmins({type:Number(done.failed_count||0)?'warning':'success',title:'Daily LiteAPKs Android sync completed',message:`${Number(done.processed_count||0).toLocaleString()} pages checked · ${Number(done.inserted_count||0).toLocaleString()} added · ${Number(done.updated_count||0).toLocaleString()} refreshed · ${Number(done.failed_count||0).toLocaleString()} failed.`,dedupeKey:`liteapks-daily-${String(done.last_completed_at||'').slice(0,10)}`});
    }
  }
  if(Number(done.requested_by||0) && !Number(done.completion_notified||0)){
    const [mark]=await db.query('UPDATE liteapks_sync_state SET completion_notified=1 WHERE sync_key=? AND completion_notified=0',[SYNC_KEY]);
    if(mark.affectedRows){
      const uid=Number(done.requested_by);
      await activity.record(uid,'liteapks_sync_completed',{details:{processed:Number(done.processed_count||0),inserted:Number(done.inserted_count||0),updated:Number(done.updated_count||0),failed:Number(done.failed_count||0)}});
      await notifications.notifyUser(uid,{actorUserId:uid,type:Number(done.failed_count||0)?'warning':'success',title:'LiteAPKs Android sync completed',message:`${Number(done.processed_count||0).toLocaleString()} pages checked · ${Number(done.inserted_count||0).toLocaleString()} added · ${Number(done.updated_count||0).toLocaleString()} refreshed · ${Number(done.failed_count||0).toLocaleString()} failed.`,dedupeKey:`liteapks-sync-${new Date(done.updated_at||Date.now()).getTime()}`});
    }
  }
  return getSyncState();
}
async function step() {
  if(workerBusy||!state.dbReady)return getSyncState();
  workerBusy=true;
  try{
    const db=getPool(); let st=await getSyncState();
    if(st.status!=='running')return st;
    let queue=[];try{queue=JSON.parse(st.queue_json||'[]')}catch{}
    if(!queue.length)return finishSyncIfNeeded(db,st);
    const url=queue.shift();
    await db.query('UPDATE liteapks_sync_state SET current_url=?,queue_json=? WHERE sync_key=?',[url,JSON.stringify(queue),SYNC_KEY]);
    try{
      const details=await fetchPackageDetails(url);
      const result=await upsertManaged(details,{autoAdd:true});
      await db.query('UPDATE liteapks_sync_state SET processed_count=processed_count+1,inserted_count=inserted_count+?,updated_count=updated_count+?,last_error=NULL WHERE sync_key=?',[result.inserted?1:0,result.updated?1:0,SYNC_KEY]);
    }catch(err){
      await db.query('UPDATE liteapks_sync_state SET processed_count=processed_count+1,failed_count=failed_count+1,last_error=? WHERE sync_key=?',[String(err.message||err).slice(0,1800),SYNC_KEY]);
    }
    st=await getSyncState();
    return finishSyncIfNeeded(db,st);
  }finally{workerBusy=false}
}
async function autoTick() {
  if(!state.dbReady||workerBusy)return;
  try{
    await ensureStateRow(); const st=await getSyncState();
    if(st.status==='running'){await step();return}
    if(st.status==='discovering'){
      const touched=st.updated_at?new Date(st.updated_at).getTime():0;
      if(touched && Date.now()-touched>20*60*1000){
        await getPool().query("UPDATE liteapks_sync_state SET status='paused',last_error='Recovered a stale discovery state after a server interruption.',next_sync_at=NOW() WHERE sync_key=?",[SYNC_KEY]);
      }else return;
    }
    const due=!st.next_sync_at || new Date(st.next_sync_at).getTime()<=Date.now();
    const completedAt=st.last_completed_at?new Date(st.last_completed_at).getTime():0;
    const oldEnough=!completedAt || Date.now()-completedAt>=AUTO_INTERVAL_MS;
    if(due&&oldEnough){try{await startSync({mode:completedAt?'daily':'full'})}catch(err){console.error('[HSWare] LiteAPKs sync start:',err.message||err)}}
  }catch(err){console.error('[HSWare] LiteAPKs worker:',err.message||err)}
}
function startLiteApksWorker() {
  if(workerStarted)return;workerStarted=true;
  const first=setTimeout(autoTick,12000);if(first.unref)first.unref();
  const stepTimer=setInterval(()=>{step().catch(err=>console.error('[HSWare] LiteAPKs step:',err.message||err))},WORKER_INTERVAL_MS);if(stepTimer.unref)stepTimer.unref();
  const checkTimer=setInterval(autoTick,CHECK_INTERVAL_MS);if(checkTimer.unref)checkTimer.unref();
  console.log('[HSWare] LiteAPKs Android metadata worker started (24-hour refresh, no APK redistribution).');
}

module.exports={
  BASE_URL,SOURCE_TYPE,PLATFORM_KEY,SYNC_KEY,
  parseAppPage,discoverLinks,fetchPackageDetails,getSyncState,startSync,step,startLiteApksWorker,
  ensureManagedFromUrl,enrichManagedSoftwareById,prepareSoftware,checkUpdateForSoftware,markUpdated,resolveDownloadForSoftware,searchCatalog,
  internalPackageId,normalizeSourceUrl,isLikelyAppUrl
};
