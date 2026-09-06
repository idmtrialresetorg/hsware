const { resolveFinalDownloadUrl } = require('./apk-download-resolver');
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
const SYNC_KEY = 'apk-main';
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

function srcsetFirst(value) {
  const raw=String(value||'').trim();
  if(!raw)return null;
  const items=raw.split(',').map(x=>x.trim()).filter(Boolean).map(x=>x.split(/\s+/)[0]).filter(Boolean);
  return items.length?items[items.length-1]:null;
}
function cssBackgroundUrl(value) {
  const m=String(value||'').match(/url\((?:["']?)([^)"']+)(?:["']?)\)/i);
  return m?m[1]:null;
}
function elementImageValues($, el) {
  const node=$(el);const values=[];
  const add=v=>{v=String(v||'').trim();if(v&&!values.includes(v))values.push(v)};
  ['data-src','data-lazy-src','data-original','data-url','data-image','data-bg','data-background','src','content'].forEach(a=>add(node.attr(a)));
  add(srcsetFirst(node.attr('data-srcset')));add(srcsetFirst(node.attr('srcset')));add(cssBackgroundUrl(node.attr('style')));
  if((el?.tagName||'').toLowerCase()==='picture')node.find('source,img').each((_,child)=>elementImageValues($,child).forEach(add));
  return values;
}
function normalizedImageValues($, elements, pageUrl) {
  const out=[];const seen=new Set();
  elements.each((_,el)=>{for(const raw of elementImageValues($,el)){const url=normalizeMetadataUrl(raw,pageUrl);if(!url||seen.has(url))continue;let path='';try{path=new URL(url).pathname.toLowerCase()}catch{}if(/\.(?:svg|ico)(?:$|\?)/i.test(path))continue;seen.add(url);out.push(url)}});
  return out;
}
function sameImage(a,b){
  if(!a||!b)return false;
  try{const x=new URL(a),y=new URL(b);return x.origin===y.origin&&x.pathname===y.pathname}catch{return a===b}
}
function screenshotUrls($, app, pageUrl) {
  const values=[];const seen=new Set();
  const push=value=>{const url=normalizeMetadataUrl(value,pageUrl);if(!url||seen.has(url))return;let path='';try{path=new URL(url).pathname.toLowerCase()}catch{}if(/\.(?:svg|ico)(?:$|\?)/i.test(path))return;seen.add(url);values.push(url)};
  const raw=app?.screenshot||app?.screenshots||null;
  if(Array.isArray(raw))raw.forEach(v=>push(typeof v==='string'?v:v?.url||v?.contentUrl));else if(raw)push(typeof raw==='string'?raw:raw?.url||raw?.contentUrl);
  const selectors='[class*="screenshot"] img,[class*="screenshot"] source,[class*="screenshots"] img,[class*="screenshots"] source,[class*="gallery"] img,[class*="gallery"] source,[class*="slider"] img,[class*="slider"] source,[id*="screenshot"] img,[data-gallery] img';
  normalizedImageValues($,$(selectors),pageUrl).forEach(push);
  $('h2,h3,h4').filter((_,el)=>/screenshots?|images?|gallery/i.test(cleanText($(el).text()))).each((_,heading)=>{
    let node=$(heading).next();let hops=0;
    while(node.length&&hops++<6&&!/^H[1-4]$/i.test(node[0]?.tagName||'')){
      normalizedImageValues($,node.find('img,source,picture').addBack('img,source,picture'),pageUrl).forEach(push);node=node.next();
    }
  });
  return values.slice(0,24);
}

function appIconUrl($, app, pageUrl) {
  const selectors='.app-icon img,.app-icon source,.apk-icon img,.apk-icon source,.icon-app img,.post-icon img,[class*="app-icon"] img,[class*="apk-icon"] img,[class*="app-logo"] img,[class*="apk-logo"] img,img[itemprop="image"]';
  const candidates=normalizedImageValues($,$(selectors),pageUrl);
  for(const url of candidates)return url;
  const raw=app?.image;
  for(const v of (Array.isArray(raw)?raw:[raw])){const url=normalizeMetadataUrl(typeof v==='string'?v:v?.url||v?.contentUrl,pageUrl);if(url)return url}
  return null;
}

function categorySlug(value) {
  return cleanText(value).toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,160) || 'other';
}
function sourceSection(pageUrl, app, category, crumbs=[]) {
  let path='';
  try{path=new URL(pageUrl).pathname.toLowerCase()}catch{}
  const type=String(app?.['@type']||'').toLowerCase();
  const context=[category,...crumbs].join(' ').toLowerCase();
  if(/\/(?:game|games)(?:\/|$)/.test(path)||/videogame|\bgame\b/.test(type)||/\bgames?\b/.test(context))return 'games';
  return 'apps';
}
function categoryContext($, app, labels, pageUrl) {
  const crumbs=[];const links=[];const seen=new Set();
  $('.breadcrumb a,.breadcrumbs a,[class*="breadcrumb"] a,nav[aria-label="breadcrumb"] a,nav[aria-label="Breadcrumb"] a').each((_,el)=>{
    const name=cleanText($(el).text()),url=normalizeSourceUrl($(el).attr('href'));if(!name||!url||seen.has(url))return;seen.add(url);crumbs.push(name);links.push({name,url});
  });
  const fallback=cleanText(app?.applicationCategory||firstLabel(labels,['category','genre']))||null;
  const ignored=/^(home|apps?|games?|latest|updated|popular|trending|download|mod apk)$/i;
  let chosen=null;for(const link of links){if(!ignored.test(link.name))chosen=link}
  const name=cleanText(chosen?.name||fallback)||'Other';const url=chosen?.url||null;
  const section=sourceSection(pageUrl,app,name,crumbs);
  return {name:name.slice(0,120),slug:categorySlug(url?slugFromUrl(url):name),url,section,parentSlug:section,breadcrumbs:crumbs.slice(0,12)};
}
function coverImageUrl($, app, pageUrl, iconUrl, screenshots=[]) {
  const candidates=[];const seen=new Set();
  const add=(url,score=0)=>{url=normalizeMetadataUrl(url,pageUrl);if(!url||sameImage(url,iconUrl)||screenshots.some(x=>sameImage(url,x)))return;if(seen.has(url))return;seen.add(url);candidates.push({url,score})};
  const groups=[
    ['.cover img,.cover source,.cover picture,.cover-image img,.app-cover img,.apk-cover img,[class*="cover"] img,[class*="cover"] source,[class*="banner"] img,[class*="hero"] img',100],
    ['.post-thumbnail img,.featured-image img,[class*="featured"] img,[class*="thumbnail"] img',80],
    ['meta[property="og:image"],meta[name="twitter:image"],meta[property="twitter:image"]',65]
  ];
  for(const [selector,score] of groups)$(selector).each((_,el)=>elementImageValues($,el).forEach(v=>add(v,score)));
  $('[style*="background-image"],[data-bg],[data-background]').each((_,el)=>elementImageValues($,el).forEach(v=>add(v,90)));
  const raw=app?.image;for(const v of (Array.isArray(raw)?raw:[raw]))if(v)add(typeof v==='string'?v:v?.contentUrl||v?.url,55);
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]?.url||null;
}
function ratingCountFrom(app, labels) {
  return parseCount(app?.aggregateRating?.ratingCount || app?.aggregateRating?.reviewCount || firstLabel(labels,['rating count','ratings','reviews','review count']));
}
function scoreFromDetails(details) {
  const downloads=Math.max(0,Number(details.downloadCount||0));
  const ratings=Math.max(0,Number(details.ratingCount||0));
  const rating=Math.max(0,Math.min(5,Number(details.ratingValue||0)));
  const updated=details.updatedDate?new Date(`${details.updatedDate}T00:00:00Z`).getTime():0;
  const ageDays=updated&&Number.isFinite(updated)?Math.max(0,(Date.now()-updated)/86400000):3650;
  const recency=Math.max(0,30-Math.min(30,ageDays));
  const popularity=Math.log10(downloads+1)*32 + Math.log10(ratings+1)*12 + rating*8 + recency*0.4;
  const trending=Math.log10(downloads+1)*10 + Math.log10(ratings+1)*7 + rating*6 + Math.max(0,45-Math.min(45,ageDays))*2;
  return {popularity:Math.round(popularity*100)/100,trending:Math.round(trending*100)/100};
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
  const apkFormat = /\bXAPK\b/i.test(pageText) ? 'XAPK' : /\bAPKS\b/i.test(pageText) ? 'APKS' : 'APK';
  return {
    pageUrl: normalizeSourceUrl(pageUrl),
    version,
    sizeText: sizeText || null,
    fileSizeBytes: parseBytes(sizeText),
    apkFormat
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
  const developer=cleanText(typeof developerObj==='string'?developerObj:(developerObj.name||'')) || firstLabel(labels,['developer','publisher','author']);
  const categoryInfo=categoryContext($,app,labels,sourcePageUrl);
  const category=categoryInfo.name;
  const sourcePackageId=cleanText(firstLabel(labels,['package name','package id','package'])) || null;
  const sizeRaw=cleanText(app.fileSize || firstLabel(labels,['size','file size']));
  const androidRaw=cleanText(app.operatingSystem || firstLabel(labels,['requires android','android','minimum android','min android']));
  const architecture=cleanText(firstLabel(labels,['architecture','cpu architecture','supported abi','abi'])) || 'Android';
  const modInfo=cleanText(firstLabel(labels,['mod info','mod features','features'])) || null;
  const price=cleanText(app.offers?.price ?? firstLabel(labels,['price'])) || null;
  const ratingValue=parseRating(app.aggregateRating?.ratingValue || firstLabel(labels,['rating','user rating','ratings']) || (pageText.match(/(?:rating|rated)\s*[:：]?\s*([0-5](?:\.\d{1,2})?)(?:\s*\/\s*5|\s*★)?/i)||[])[1]);
  const iconUrl=appIconUrl($,app,sourcePageUrl);
  const screenshots=screenshotUrls($,app,sourcePageUrl).filter(u=>u!==iconUrl);
  const coverImage=coverImageUrl($,app,sourcePageUrl,iconUrl,screenshots);
  const officialUrl=externalWebsite($,labels,app,sourcePageUrl);
  const playStore=playStoreUrl($,app,labels,sourcePackageId,sourcePageUrl);
  const downloadPage=downloadPageUrl($,sourcePageUrl);
  const directDownload=directPublicFileUrl($,app,sourcePageUrl);
  const apkType=apkTypeLabel({title,modInfo,price,labels,pageText});
  const licenseName=cleanText(firstLabel(labels,['license','licence'])) || null;
  const language=cleanText(firstLabel(labels,['language','languages'])) || null;
  const downloadCount=parseCount(firstLabel(labels,['downloads','download count']));
  const ratingCount=ratingCountFrom(app,labels);
  const slug=slugFromUrl(sourcePageUrl);
  const looksLike=Boolean(title && (version || sourcePackageId || /\b(?:apk|android|mod)\b/i.test(pageText)));
  const apkFormat=/\bXAPK\b/i.test(pageText)?'XAPK':'APK';
  const tags=[];
  if(modInfo)tags.push('MOD');
  if(category)tags.push(category);
  const scores=scoreFromDetails({downloadCount,ratingCount,ratingValue,updatedDate:parseDate(updatedRaw)});
  return {
    looksLikeAppPage:looksLike,
    internalPackageId:`liteapks:${slug}`,
    sourceSlug:slug,
    sourceType:SOURCE_TYPE,
    platformKey:PLATFORM_KEY,
    sourcePageUrl,
    sourcePackageId:sourcePackageId?.slice(0,255)||null,
    name:title || slug || 'Android app',
    developer:developer?.slice(0,255)||null,
    category:category?.slice(0,120)||'Other',
    sourceSection:categoryInfo.section,
    categorySlug:categoryInfo.slug,
    categoryUrl:categoryInfo.url,
    version,
    description:description?.slice(0,65535)||null,
    updatedDate:parseDate(updatedRaw),
    fileSizeBytes:parseBytes(sizeRaw),
    minimumOsVersion:androidRaw?.slice(0,255)||null,
    architecture:architecture?.slice(0,80)||'Android',
    apkFormat,
    iconUrl,
    coverImageUrl:coverImage,
    screenshots,
    officialUrl,
    licenseName,
    language,
    downloadCount,
    modInfo,
    price,
    ratingValue,
    ratingCount,
    popularityScore:scores.popularity,
    trendingScore:scores.trending,
    apkType,
    playStoreUrl:playStore,
    downloadPageUrl:downloadPage,
    directDownloadUrl:directDownload,
    tags,
    oldVersions:extractHistoricalVersions($),
    metadata:{
      source:'LiteAPKs',sourcePageUrl,sourceSlug:slug,sourcePackageId:sourcePackageId||null,
      version:version||null,updated:parseDate(updatedRaw),size:sizeRaw||null,requiresAndroid:androidRaw||null,
      architecture:architecture||null,apkFormat,modInfo:modInfo||null,apkType,price:price||null,ratingValue,ratingCount,
      sourceSection:categoryInfo.section,category:categoryInfo.name,categorySlug:categoryInfo.slug,categoryUrl:categoryInfo.url,breadcrumbs:categoryInfo.breadcrumbs,
      popularityScore:scores.popularity,trendingScore:scores.trending,
      iconUrl:iconUrl||null,coverImageUrl:coverImage||null,screenshots,playStoreUrl:playStore||null,downloadPageUrl:downloadPage||null,directDownloadUrl:directDownload||null,officialUrl:officialUrl||null,licenseName:licenseName||null,
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
  const gap=Math.max(700,Number(config.apkResolverRequestGapMs||1400));
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
      'user-agent':'Appbit/1.0 APK resolver (+standard public HTTP fetch)',
      'accept':accept,'accept-language':'en-US,en;q=0.8','cache-control':'no-cache'
    }});
    lastRequestAt=Date.now();
    const finalUrl=normalizeSourceUrl(res.url);
    if(!finalUrl)throw new Error('LiteAPKs redirected outside liteapks.com.');
    if(res.status===403||res.status===401)throw new Error('LiteAPKs blocked the standard metadata request (HTTP 403/401). Appbit will not bypass anti-bot protection.');
    if(res.status===429)throw new Error('LiteAPKs rate-limited the metadata sync (HTTP 429). Appbit will retry later.');
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
      if(parsed.apkFormat)d.apkFormat=parsed.apkFormat;
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
      d.metadata.downloadApkFormat=parsed.apkFormat||null;
      d.metadata.downloadPageCheckedAt=new Date().toISOString();
    }catch(err){
      d.metadata.downloadPageError=String(err.message||err).slice(0,500);
    }
  }
  return d;
}

async function getSyncState() {
  const [rows] = await getPool().query('SELECT * FROM apk_sync_state WHERE sync_key=? LIMIT 1', [SYNC_KEY]);
  return rows[0] || {sync_key:SYNC_KEY,status:'idle',mode:'daily',queue_json:'[]',total_count:0,processed_count:0,inserted_count:0,updated_count:0,failed_count:0,last_error:null,last_started_at:null,last_completed_at:null,next_sync_at:null};
}

async function ensureStateRow() {
  await getPool().query(`INSERT INTO apk_sync_state (sync_key,status,mode,queue_json,next_sync_at)
    VALUES (?,'idle','daily','[]',NOW()) ON DUPLICATE KEY UPDATE sync_key=VALUES(sync_key)`, [SYNC_KEY]);
}

async function discoverForSync(mode='daily',requestedLimit=null) {
  const configured=Math.max(1,Math.min(DEFAULT_MAX_ITEMS,Number(config.apkResolverMaxItems||DEFAULT_MAX_ITEMS)));
  const limit=requestedLimit==null?configured:Math.max(1,Math.min(configured,Number(requestedLimit)||1));
  if(mode==='full'){
    const sitemap=await sitemapAppUrls(limit);
    if(sitemap.length)return sitemap;
    return crawlListings(Math.max(10,Number(config.apkResolverFullPages||DEFAULT_FULL_PAGES)),limit);
  }
  const recent=await sitemapRecentlyModifiedAppUrls(Math.min(limit,2000),3);
  if(recent.length)return recent;
  return crawlListings(Math.max(2,Number(config.apkResolverDailyPages||DEFAULT_DAILY_PAGES)),Math.min(limit,2000));
}

async function startSync({mode='daily',requestedBy=null,force=false,limit=null}={}) {
  await ensureStateRow();
  const db=getPool();
  const st=await getSyncState();
  if(['running','discovering'].includes(st.status)&&!force)return st;
  const [[appCount]]=await db.query('SELECT COUNT(*) c FROM apps');
  const chosen=mode==='full'?'full':'daily';
  await db.query(`UPDATE apk_sync_state SET status='discovering',mode=?,queue_json='[]',total_count=0,processed_count=0,inserted_count=0,updated_count=0,failed_count=0,current_url=NULL,last_error=NULL,requested_by=?,completion_notified=0,last_started_at=NOW(),next_sync_at=NULL WHERE sync_key=?`,[chosen,requestedBy?Number(requestedBy):null,SYNC_KEY]);
  try{
    const urls=(await discoverForSync(chosen,limit)).slice(0,Math.max(1,Math.min(DEFAULT_MAX_ITEMS,Number(limit)||DEFAULT_MAX_ITEMS)));
    if(!urls.length)throw new Error('No Android app pages were discovered from the configured APK source.');
    await db.query("UPDATE apk_sync_state SET status='running',queue_json=?,total_count=? WHERE sync_key=?",[JSON.stringify(urls),urls.length,SYNC_KEY]);
    if(requestedBy)await activity.record(Number(requestedBy),'apk_sync_started',{details:{mode:chosen,total:urls.length}});
    return getSyncState();
  }catch(err){
    const msg=String(err.message||err).slice(0,1800);
    await db.query("UPDATE apk_sync_state SET status='paused',last_error=?,next_sync_at=NULL WHERE sync_key=?",[msg,SYNC_KEY]);
    throw err;
  }
}

async function stopSync() {
  await ensureStateRow();
  await getPool().query("UPDATE apk_sync_state SET status='stopped',queue_json='[]',current_url=NULL,next_sync_at=NULL WHERE sync_key=?",[SYNC_KEY]);
  return getSyncState();
}

async function syncMedia(appId, details) {
  const db=getPool();
  // Replace only media types that were successfully discovered. A temporary source-page
  // parsing gap must not erase previously stored artwork.
  if(details.iconUrl){
    await db.query("DELETE FROM apk_media WHERE app_id=? AND media_type='icon'",[appId]);
    await db.query("INSERT INTO apk_media (app_id,media_type,remote_url,sort_order) VALUES (?,'icon',?,0)",[appId,details.iconUrl]);
  }
  if(details.coverImageUrl){
    await db.query("DELETE FROM apk_media WHERE app_id=? AND media_type='cover'",[appId]);
    await db.query("INSERT INTO apk_media (app_id,media_type,remote_url,sort_order) VALUES (?,'cover',?,0)",[appId,details.coverImageUrl]);
  }
  const shots=Array.isArray(details.screenshots)?details.screenshots.slice(0,24):[];
  if(shots.length)await db.query("DELETE FROM apk_media WHERE app_id=? AND media_type='screenshot'",[appId]);
  for(let i=0;i<shots.length;i++) await db.query("INSERT INTO apk_media (app_id,media_type,remote_url,sort_order) VALUES (?,'screenshot',?,?)",[appId,shots[i],i]);
}

async function upsertManaged(details,{autoAdd=true}={}) {
  if(!details?.looksLikeAppPage)throw new Error('The source page did not look like an Android app detail page.');
  if(!details.internalPackageId)throw new Error('The APK source did not provide a stable app identity.');
  const db=getPool();
  const [[existing]]=await db.query('SELECT * FROM apps WHERE package_id=? LIMIT 1',[details.internalPackageId]);
  let available=false;
  if(existing&&details.version){
    try{available=!existing.current_version||compareVersions(details.version,existing.current_version)>0}catch{available=!existing.current_version||details.version!==existing.current_version}
  }
  await db.query(`INSERT INTO apps
    (package_id,name,category,source_section,category_slug,category_url,rating_value,rating_count,mod_info,popularity_score,trending_score,developer,current_version,description,official_url,source_page_url,source_package_id,source_updated_at,source_metadata_json,apk_type,architecture,file_size_bytes,minimum_os_version,language,license_name,download_count,tags_json,published,workspace_added_at,latest_version,update_available,last_checked_at,update_error,metadata_status,metadata_revision,metadata_error,metadata_updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NOW(),?,?,NOW(),NULL,'ready',1,NULL,NOW())
    ON DUPLICATE KEY UPDATE
      name=VALUES(name),category=COALESCE(VALUES(category),category),source_section=COALESCE(VALUES(source_section),source_section),category_slug=COALESCE(VALUES(category_slug),category_slug),category_url=COALESCE(VALUES(category_url),category_url),
      rating_value=COALESCE(VALUES(rating_value),rating_value),rating_count=COALESCE(VALUES(rating_count),rating_count),mod_info=COALESCE(VALUES(mod_info),mod_info),popularity_score=GREATEST(VALUES(popularity_score),0),trending_score=GREATEST(VALUES(trending_score),0),
      developer=COALESCE(VALUES(developer),developer),description=COALESCE(VALUES(description),description),official_url=COALESCE(VALUES(official_url),official_url),source_page_url=VALUES(source_page_url),source_package_id=COALESCE(VALUES(source_package_id),source_package_id),source_updated_at=COALESCE(VALUES(source_updated_at),source_updated_at),
      source_metadata_json=VALUES(source_metadata_json),apk_type=COALESCE(VALUES(apk_type),apk_type),architecture=COALESCE(VALUES(architecture),architecture),file_size_bytes=COALESCE(VALUES(file_size_bytes),file_size_bytes),
      minimum_os_version=COALESCE(VALUES(minimum_os_version),minimum_os_version),language=COALESCE(VALUES(language),language,'English'),license_name=COALESCE(VALUES(license_name),license_name),download_count=COALESCE(VALUES(download_count),download_count),
      tags_json=VALUES(tags_json),latest_version=IF(?,VALUES(current_version),latest_version),update_available=IF(?,1,update_available),last_checked_at=NOW(),update_error=NULL,metadata_status='ready',metadata_error=NULL,metadata_updated_at=NOW()`,
    [details.internalPackageId,details.name,details.category,details.sourceSection||'apps',details.categorySlug||categorySlug(details.category),details.categoryUrl||null,details.ratingValue,details.ratingCount,details.modInfo,details.popularityScore||0,details.trendingScore||0,details.developer,details.version,details.description,details.officialUrl,details.sourcePageUrl,details.sourcePackageId,details.updatedDate,JSON.stringify(details.metadata),details.apkType||details.apkFormat,details.architecture,details.fileSizeBytes,details.minimumOsVersion,details.language||'English',details.licenseName,details.downloadCount,JSON.stringify(details.tags||[]),details.version||null,available?1:0,available?1:0,available?1:0]);
  const [[app]]=await db.query('SELECT * FROM apps WHERE package_id=? LIMIT 1',[details.internalPackageId]);
  if(!app)throw new Error('APK record could not be created.');
  await db.query(`INSERT INTO apk_categories (section,name,slug,source_url,parent_slug,last_seen_at,active)
    VALUES (?,?,?,?,?,NOW(),1) ON DUPLICATE KEY UPDATE name=VALUES(name),source_url=COALESCE(VALUES(source_url),source_url),parent_slug=VALUES(parent_slug),last_seen_at=NOW(),active=1`,
    [details.sourceSection||'apps',details.category||'Other',details.categorySlug||categorySlug(details.category),details.categoryUrl||null,details.sourceSection||'apps']);
  await db.query(`INSERT INTO apk_metadata (app_id,metadata_json) VALUES (?,?) ON DUPLICATE KEY UPDATE metadata_json=VALUES(metadata_json)`,[app.id,JSON.stringify(details.metadata)]);
  await db.query(`INSERT INTO publish_queue (app_id,status) VALUES (?,?) ON DUPLICATE KEY UPDATE status=IF(status='published','published',VALUES(status))`,[app.id,app.published?'published':'ready']);
  await syncMedia(app.id,details);
  const history=[...(details.oldVersions||[])];
  if(details.version) history.unshift({version:details.version,updatedDate:details.updatedDate,sourcePageUrl:details.sourcePageUrl});
  for(const v of history.slice(0,25)){
    if(!v?.version)continue;
    await db.query(`INSERT INTO apk_versions (app_id,version,source_page_url,file_size_bytes,architecture,apk_type,release_date,release_date_source)
      VALUES (?,?,?,?,?,?,?,'source-page') ON DUPLICATE KEY UPDATE source_page_url=COALESCE(VALUES(source_page_url),source_page_url),file_size_bytes=COALESCE(VALUES(file_size_bytes),file_size_bytes),release_date=COALESCE(VALUES(release_date),release_date)`,
      [app.id,v.version,v.sourcePageUrl||details.sourcePageUrl,v.version===details.version?details.fileSizeBytes:null,details.architecture,details.apkType||details.apkFormat,v.updatedDate||null]);
  }
  return {app,inserted:!existing,updated:Boolean(existing),updateAvailable:available};
}


function taxonomyLinks(html,pageUrl) {
  const $=cheerio.load(String(html||''));const out=[];const seen=new Set();
  const sectionFromNode=el=>{
    const a=$(el),href=normalizeSourceUrl(a.attr('href'));let path='';try{path=new URL(href||pageUrl).pathname.toLowerCase()}catch{}
    if(/\/(?:games?|game)(?:\/|$)/.test(path))return 'games';if(/\/(?:apps?|application)(?:\/|$)/.test(path))return 'apps';
    for(const parent of a.parents('li,ul,nav,section,div').slice(0,5).toArray()){
      const node=$(parent);const heading=cleanText(node.children('a,span,strong,b,h2,h3,h4').first().text());
      if(/^games?$/i.test(heading))return'games';if(/^apps?$/i.test(heading))return'apps';
      const cls=String(node.attr('class')||'');if(/game/i.test(cls)&&!/app/i.test(cls))return'games';if(/app/i.test(cls)&&!/game/i.test(cls))return'apps';
    }
    let sourcePath='';try{sourcePath=new URL(pageUrl).pathname.toLowerCase()}catch{}return /\/games?(?:\/|$)/.test(sourcePath)?'games':'apps';
  };
  $('a[href]').each((_,el)=>{
    const name=cleanText($(el).text()),url=normalizeSourceUrl($(el).attr('href'));if(!url||!name)return;
    let path='';try{path=new URL(url).pathname.toLowerCase()}catch{}
    if(/\/(?:page|download|blog|news|article|tag|author)\//.test(path))return;
    if(/^(?:home|latest|updated|popular|trending|about|contact|dmca|privacy|terms|download|request|blog)$/i.test(name))return;
    const slug=categorySlug(slugFromUrl(url)||name);if(['apps','app','games','game','category','categories',''].includes(slug))return;
    const section=sectionFromNode(el),key=`${section}:${slug}`;if(seen.has(key))return;
    // Category links usually live in category/menu/breadcrumb structures. This prevents generic footer links becoming categories.
    const context=String($(el).parents('nav,ul,li,[class*="menu"],[class*="categor"],[class*="sidebar"],[class*="dropdown"]').first().attr('class')||'')+' '+cleanText($(el).parents('nav,ul,li').first().text()).slice(0,180);
    const menuContext=/(categor|menu|sidebar|dropdown|apps?|games?)/i.test(context);
    if(!menuContext&&!/\/(?:category|categories|apps?|games?)\//.test(path))return;
    if(/\.html?$/.test(path)&&(!menuContext||name.length>45||/(?:\bapk\b|\bmod\b|version|download)/i.test(name)))return;
    seen.add(key);out.push({section,name:name.slice(0,160),slug,url,parentSlug:section});
  });
  return out.slice(0,400);
}
async function ensureTaxonomyRoots(db) {
  for(const [section,name,order] of [['apps','Apps',0],['games','Games',1]]){
    await db.query(`INSERT INTO apk_categories (section,name,slug,source_url,parent_slug,sort_order,last_seen_at,active) VALUES (?,?,?,?,NULL,?,NOW(),1)
      ON DUPLICATE KEY UPDATE name=VALUES(name),parent_slug=NULL,sort_order=VALUES(sort_order),active=1,last_seen_at=NOW()`,[section,name,section,`${BASE_URL}/${section}`,order]);
  }
  await db.query(`UPDATE apk_categories SET parent_slug=section WHERE slug<>section AND (parent_slug IS NULL OR parent_slug='')`);
}
async function refreshTaxonomy() {
  const db=getPool();await ensureTaxonomyRoots(db);
  const queue=[BASE_URL,`${BASE_URL}/apps`,`${BASE_URL}/games`];const visited=new Set(),found=new Map(),errors=[];
  while(queue.length&&visited.size<12){
    const candidate=queue.shift();if(visited.has(candidate))continue;visited.add(candidate);
    try{
      const r=await fetchText(candidate),links=taxonomyLinks(r.text,r.url);
      for(const c of links){found.set(`${c.section}:${c.slug}`,c);if(queue.length<20&&/\/(?:apps?|games?|categor)/i.test(new URL(c.url).pathname))queue.push(c.url)}
    }catch(err){errors.push(`${candidate}: ${err.message}`)}
  }
  let order=10;for(const c of found.values())await db.query(`INSERT INTO apk_categories (section,name,slug,source_url,parent_slug,sort_order,last_seen_at,active) VALUES (?,?,?,?,?,?,NOW(),1)
    ON DUPLICATE KEY UPDATE name=VALUES(name),source_url=VALUES(source_url),parent_slug=VALUES(parent_slug),sort_order=VALUES(sort_order),last_seen_at=NOW(),active=1`,[c.section,c.name,c.slug,c.url,c.parentSlug||c.section,order++]);
  await db.query(`INSERT INTO apk_categories (section,name,slug,parent_slug,sort_order,last_seen_at,active)
    SELECT source_section,COALESCE(NULLIF(category,''),'Other'),COALESCE(NULLIF(category_slug,''),'other'),source_section,999,NOW(),1 FROM apps
    GROUP BY source_section,COALESCE(NULLIF(category,''),'Other'),COALESCE(NULLIF(category_slug,''),'other')
    ON DUPLICATE KEY UPDATE name=VALUES(name),parent_slug=VALUES(parent_slug),last_seen_at=NOW(),active=1`);
  const state=await taxonomyState();return {...state,liveFetched:found.size>0,sourceCategoryCount:found.size,visitedPages:visited.size,errors:errors.slice(0,5)};
}
async function taxonomyState() {
  const db=getPool();await ensureTaxonomyRoots(db);
  const [rows]=await db.query(`SELECT c.section,c.name,c.slug,c.source_url,c.parent_slug,c.sort_order,COUNT(a.id) app_count
    FROM apk_categories c LEFT JOIN apps a ON a.source_section=c.section AND a.category_slug=c.slug
    WHERE c.active=1 GROUP BY c.id,c.section,c.name,c.slug,c.source_url,c.parent_slug,c.sort_order ORDER BY FIELD(c.section,'apps','games'),c.sort_order,c.name`);
  const [[totals]]=await db.query(`SELECT COUNT(*) total,SUM(source_section='apps') apps,SUM(source_section='games') games FROM apps`);
  const sections={apps:Number(totals?.apps||0),games:Number(totals?.games||0)};
  const categories=rows.filter(r=>r.slug!==r.section).map(r=>({section:r.section,name:r.name,slug:r.slug,parentSlug:r.parent_slug||r.section,sourceUrl:r.source_url||null,count:Number(r.app_count||0)}));
  const roots=['apps','games'].map(section=>({section,name:section==='apps'?'Apps':'Games',slug:section,count:sections[section],children:categories.filter(c=>c.section===section)}));
  return {total:Number(totals?.total||0),sections,categories,roots};
}
function rankedAppLinks(html,pageUrl) {
  const $=cheerio.load(String(html||''));const out=[];const seen=new Set();
  $('a[href]').each((_,el)=>{const url=normalizeSourceUrl($(el).attr('href'));if(!url||!isLikelyAppUrl(url)||seen.has(url))return;seen.add(url);out.push(url)});
  return out;
}
async function refreshRankings(limit=100) {
  const db=getPool();
  await db.query('UPDATE apps SET source_popularity_rank=NULL,source_trending_rank=NULL');
  const home=await fetchText(BASE_URL);
  const $=cheerio.load(home.text);const candidates=[];
  $('a[href]').each((_,el)=>{const text=cleanText($(el).text());if(/popular|trending|top\s+(?:apps|games)|most\s+download/i.test(text)){const url=normalizeSourceUrl($(el).attr('href'));if(url)candidates.push({url,type:/trend/i.test(text)?'trending':'popular'})}});
  if(!candidates.length)candidates.push({url:BASE_URL,type:'popular'});
  for(const item of candidates.slice(0,8)){
    try{const r=item.url===BASE_URL?home:await fetchText(item.url);const urls=rankedAppLinks(r.text,r.url).slice(0,Math.max(1,Math.min(500,Number(limit)||100)));let rank=0;for(const url of urls){rank++;const col=item.type==='trending'?'source_trending_rank':'source_popularity_rank';await db.query(`UPDATE apps SET ${col}=? WHERE source_page_url=?`,[rank,url])}}catch{}
  }
  await db.query(`UPDATE apps SET popularity_score=(LOG10(COALESCE(download_count,0)+1)*32)+(LOG10(COALESCE(rating_count,0)+1)*12)+(COALESCE(rating_value,0)*8)+GREATEST(0,30-LEAST(30,DATEDIFF(CURDATE(),COALESCE(source_updated_at,DATE_SUB(CURDATE(),INTERVAL 3650 DAY)))))*0.4,
    trending_score=(LOG10(COALESCE(download_count,0)+1)*10)+(LOG10(COALESCE(rating_count,0)+1)*7)+(COALESCE(rating_value,0)*6)+GREATEST(0,45-LEAST(45,DATEDIFF(CURDATE(),COALESCE(source_updated_at,DATE_SUB(CURDATE(),INTERVAL 3650 DAY)))))*2`);
  return {ok:true};
}

async function searchCatalog(q,limit=30) {
  const needle=String(q||'').trim();
  if(!needle)return [];
  const like=`%${needle}%`;
  const [rows]=await getPool().query(`SELECT * FROM apps WHERE name LIKE ? OR source_package_id LIKE ? OR package_id LIKE ? OR source_page_url LIKE ? ORDER BY updated_at DESC LIMIT ?`,[like,like,like,like,Math.max(1,Math.min(100,Number(limit)||30))]);
  return rows.map(r=>({packageId:r.package_id,name:r.name,developer:r.developer||'Android Developer',category:r.category||'Android Apps',sourceType:SOURCE_TYPE,platformKey:PLATFORM_KEY,sourcePageUrl:r.source_page_url,sourcePackageId:r.source_package_id,managed:true,managedAppId:Number(r.id),updatedDate:r.source_updated_at||null}));
}

async function ensureManagedFromUrl(pageUrl) {
  const d=await fetchPackageDetails(pageUrl);
  return (await upsertManaged(d,{autoAdd:true})).app;
}

async function enrichManagedAppById(id) {
  const db=getPool();
  const [[app]]=await db.query('SELECT * FROM apps WHERE id=? LIMIT 1',[id]);
  if(!app)throw new Error('App not found.');
  if(!app.source_page_url)throw new Error('APK source page is missing.');
  try{
    await db.query("UPDATE apps SET metadata_status='fetching',metadata_error=NULL WHERE id=?",[id]);
    const d=await fetchPackageDetails(app.source_page_url);
    await upsertManaged(d,{autoAdd:true});
    const [[fresh]]=await db.query('SELECT * FROM apps WHERE id=? LIMIT 1',[id]);
    return fresh;
  }catch(err){
    await db.query("UPDATE apps SET metadata_status='error',metadata_error=?,update_error=? WHERE id=?",[String(err.message||err).slice(0,1800),String(err.message||err).slice(0,1800),id]);
    throw err;
  }
}

async function prepareApp(id) {
  const db=getPool();
  const [[app]]=await db.query('SELECT * FROM apps WHERE id=? LIMIT 1',[id]);
  if(!app)throw new Error('App not found.');
  try{return {app:await enrichManagedAppById(id),refreshed:true,warning:null}}catch(err){return {app,refreshed:false,warning:err.message||String(err)}}
}

async function checkUpdateForApp(app) {
  const details=await fetchPackageDetails(app.source_page_url);
  let available=false;let reason=null;let oldMeta={};
  try{oldMeta=app.source_metadata_json?JSON.parse(app.source_metadata_json):{}}catch{}
  if(details.version){
    try{available=!app.current_version||compareVersions(details.version,app.current_version)>0}catch{available=!app.current_version||details.version!==app.current_version}
    if(available)reason='version';
  }
  if(!available&&app.file_size_bytes&&details.fileSizeBytes&&Number(app.file_size_bytes)!==Number(details.fileSizeBytes)){available=true;reason='size'}
  if(!available&&oldMeta.downloadPageUrl&&details.downloadPageUrl&&String(oldMeta.downloadPageUrl)!==String(details.downloadPageUrl)){available=true;reason='download-page'}
  if(reason)details.metadata.updateReason=reason;
  // Refresh the complete record while checking updates so old libraries gradually gain
  // cover art, screenshots, categories, ratings and source metadata without auto-importing new apps.
  await upsertManaged(details,{autoAdd:true});
  await getPool().query(`UPDATE apps SET latest_version=?,update_available=?,last_checked_at=NOW(),update_error=NULL,source_updated_at=COALESCE(?,source_updated_at),source_metadata_json=? WHERE id=?`,[details.version||app.current_version,available?1:0,details.updatedDate,JSON.stringify(details.metadata),app.id]);
  await getPool().query(`INSERT INTO apk_metadata (app_id,metadata_json) VALUES (?,?) ON DUPLICATE KEY UPDATE metadata_json=VALUES(metadata_json)`,[app.id,JSON.stringify(details.metadata)]);
  return {details,available,reason};
}

async function resolveDownloadForApp(id) {
  const db=getPool();
  const [[app]]=await db.query('SELECT * FROM apps WHERE id=? LIMIT 1',[Number(id)]);
  if(!app)throw Object.assign(new Error('APK not found.'),{status:404});
  const details=await fetchPackageDetails(app.source_page_url);
  await upsertManaged(details,{autoAdd:true});
  if(details.directDownloadUrl)return {url:details.directDownloadUrl,mode:'direct'};
  throw Object.assign(new Error('Direct APK/XAPK/APKS file URL was not resolved from the public source page.'),{status:404,code:'DIRECT_LINK_NOT_FOUND'});
}

async function markUpdated(id) {
  const fresh=await enrichManagedAppById(id);
  const latest=fresh.latest_version||fresh.current_version;
  await getPool().query('UPDATE apps SET current_version=?,latest_version=NULL,update_available=0,last_checked_at=NOW(),update_error=NULL WHERE id=?',[latest,id]);
  return true;
}

async function finishSyncIfNeeded(db,st) {
  let queue=[];try{queue=JSON.parse(st.queue_json||'[]')}catch{}
  if(queue.length)return st;
  await db.query("UPDATE apk_sync_state SET status='complete',current_url=NULL,last_completed_at=NOW(),next_sync_at=NULL WHERE sync_key=?",[SYNC_KEY]);
  const done=await getSyncState();
  if(Number(done.requested_by||0)&&!Number(done.completion_notified||0)){
    const [mark]=await db.query('UPDATE apk_sync_state SET completion_notified=1 WHERE sync_key=? AND completion_notified=0',[SYNC_KEY]);
    if(mark.affectedRows){
      const uid=Number(done.requested_by);
      await activity.record(uid,'apk_sync_completed',{details:{processed:Number(done.processed_count||0),inserted:Number(done.inserted_count||0),updated:Number(done.updated_count||0),failed:Number(done.failed_count||0)}});
      await notifications.notifyUser(uid,{actorUserId:uid,type:Number(done.failed_count||0)?'warning':'success',title:'APK sync completed',message:`${Number(done.processed_count||0).toLocaleString()} pages checked · ${Number(done.inserted_count||0).toLocaleString()} added · ${Number(done.updated_count||0).toLocaleString()} refreshed · ${Number(done.failed_count||0).toLocaleString()} failed.`,dedupeKey:`apk-sync-${new Date(done.updated_at||Date.now()).getTime()}`});
    }
  }
  return getSyncState();
}

async function step() {
  if(workerBusy||!state.dbReady)return getSyncState();
  workerBusy=true;
  try{
    const db=getPool();let st=await getSyncState();
    if(st.status!=='running')return st;
    let queue=[];try{queue=JSON.parse(st.queue_json||'[]')}catch{}
    if(!queue.length)return finishSyncIfNeeded(db,st);
    const url=queue.shift();
    await db.query('UPDATE apk_sync_state SET current_url=?,queue_json=? WHERE sync_key=?',[url,JSON.stringify(queue),SYNC_KEY]);
    try{
      const details=await fetchPackageDetails(url);
      const result=await upsertManaged(details,{autoAdd:true});
      await db.query('UPDATE apk_sync_state SET processed_count=processed_count+1,inserted_count=inserted_count+?,updated_count=updated_count+?,last_error=NULL WHERE sync_key=?',[result.inserted?1:0,result.updated?1:0,SYNC_KEY]);
    }catch(err){
      await db.query('UPDATE apk_sync_state SET processed_count=processed_count+1,failed_count=failed_count+1,last_error=? WHERE sync_key=?',[String(err.message||err).slice(0,1800),SYNC_KEY]);
    }
    st=await getSyncState();
    return finishSyncIfNeeded(db,st);
  }finally{workerBusy=false}
}

async function autoTick() {
  if(!state.dbReady||workerBusy)return;
  try{await ensureStateRow();const st=await getSyncState();if(st.status==='running')await step()}catch(err){console.error('[Appbit] APK resolver worker:',err.message||err)}
}

function startApkResolverWorker() {
  if(workerStarted)return;workerStarted=true;
  const first=setTimeout(autoTick,12000);if(first.unref)first.unref();
  const stepTimer=setInterval(()=>{step().catch(err=>console.error('[Appbit] APK sync step:',err.message||err))},WORKER_INTERVAL_MS);if(stepTimer.unref)stepTimer.unref();
  const checkTimer=setInterval(autoTick,CHECK_INTERVAL_MS);if(checkTimer.unref)checkTimer.unref();
  console.log('[Appbit] APK resolver worker started (manual imports only).');
}

module.exports={
  BASE_URL,SOURCE_TYPE,PLATFORM_KEY,SYNC_KEY,
  parseAppPage,discoverLinks,fetchPackageDetails,getSyncState,startSync,stopSync,step,startApkResolverWorker,
  taxonomyState,refreshTaxonomy,refreshRankings,
  ensureManagedFromUrl,enrichManagedAppById,prepareApp,checkUpdateForApp,markUpdated,resolveDownloadForApp,searchCatalog,
  internalPackageId,normalizeSourceUrl,isLikelyAppUrl
};
