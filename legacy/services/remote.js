const config = require('../config');

function blockedHostname(hostname){
  const h=String(hostname||'').toLowerCase().replace(/\.$/,'');
  if(!h || h==='localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home') || h.endsWith('.lan')) return true;
  if(/^\d+\.\d+\.\d+\.\d+$/.test(h)){
    const p=h.split('.').map(Number); if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return true;
    if(p[0]===0||p[0]===10||p[0]===127||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127)||p[0]>=224)return true;
  }
  const ipv6=h.replace(/^\[|\]$/g,'');
  if(ipv6.includes(':')){
    const low=ipv6.toLowerCase();
    if(low==='::'||low==='::1'||low.startsWith('fc')||low.startsWith('fd')||low.startsWith('fe8')||low.startsWith('fe9')||low.startsWith('fea')||low.startsWith('feb')||low.startsWith('ff')||low.startsWith('2001:db8'))return true;
  }
  return false;
}
async function validatePublicUrl(input){
  let url;try{url=new URL(input)}catch{throw new Error('Invalid remote URL.')}
  if(!['http:','https:'].includes(url.protocol))throw new Error('Only HTTP/HTTPS URLs are allowed.');
  if(url.username||url.password)throw new Error('Credentials in URLs are not allowed.');
  if(url.port&&!['80','443'].includes(url.port))throw new Error('Non-standard ports are not allowed.');
  if(url.hostname.length>253||blockedHostname(url.hostname))throw new Error('Local/internal network targets are not allowed.');
  return url;
}
function userAgent(){return `Mozilla/5.0 (compatible; HSWareStudio/${config.appVersion}; Cloudflare)`}
async function nativeCheckedFetch(url,options={}){
  return fetch(url.toString(),{...options,redirect:'manual'});
}
async function safeFetch(input,{maxBytes=4*1024*1024,accept='*/*',redirects=4,timeoutMs=15000}={}){
  let current=await validatePublicUrl(input);const seen=new Set();
  for(let i=0;i<=Math.min(8,Math.max(0,redirects));i++){
    const key=current.toString();if(seen.has(key))throw new Error('Remote redirect loop detected.');seen.add(key);
    const response=await nativeCheckedFetch(current,{headers:{'User-Agent':userAgent(),'Accept':accept,'Accept-Language':'en-US,en;q=0.8'},signal:AbortSignal.timeout(Math.min(30000,Math.max(1000,timeoutMs)))});
    if([301,302,303,307,308].includes(response.status)){
      const loc=response.headers.get('location');try{await response.body?.cancel?.()}catch{}
      if(!loc)throw new Error('Redirect without a location header.');
      current=await validatePublicUrl(new URL(loc,current).toString());continue;
    }
    if(!response.ok)throw new Error(`Remote server returned ${response.status}.`);
    const contentLength=Number(response.headers.get('content-length')||0);if(contentLength&&contentLength>maxBytes)throw new Error('Remote response is larger than the allowed limit.');
    if(!response.body)return{url:current.toString(),status:response.status,headers:response.headers,buffer:Buffer.alloc(0)};
    const reader=response.body.getReader(),chunks=[];let total=0;
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){try{await reader.cancel()}catch{}throw new Error('Remote response exceeded the allowed limit.')}chunks.push(Buffer.from(value))}
    return{url:current.toString(),status:response.status,headers:response.headers,buffer:Buffer.concat(chunks)};
  }
  throw new Error('Too many redirects.');
}
async function safeFetchText(input,maxBytes=2*1024*1024){const result=await safeFetch(input,{maxBytes,accept:'text/html,application/xhtml+xml'});const type=result.headers.get('content-type')||'';if(!/text\/html|application\/xhtml\+xml/i.test(type))throw new Error('URL did not return HTML.');return{...result,text:result.buffer.toString('utf8')}}
function normalizeRemoteDate(value){if(!value)return null;const d=new Date(String(value));return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10)}
function metadataFromHeaders(headers){const range=String(headers?.get?.('content-range')||'');const match=range.match(/\/(\d+)$/);const rangeSize=match?Number(match[1]):0;const contentSize=Number(headers?.get?.('content-length')||0);return{sizeBytes:Number.isFinite(rangeSize)&&rangeSize>1?rangeSize:(Number.isFinite(contentSize)&&contentSize>1?contentSize:null),lastModified:normalizeRemoteDate(headers?.get?.('last-modified')||null)}}
async function probeRemoteFileMetadata(input,redirects=7){let current=await validatePublicUrl(input),lastModified=null,sizeBytes=null;const seen=new Set();for(let i=0;i<=Math.min(8,Math.max(0,redirects));i++){if(seen.has(current.toString()))break;seen.add(current.toString());let head=null;try{head=await nativeCheckedFetch(current,{method:'HEAD',headers:{'User-Agent':userAgent(),'Accept':'*/*','Accept-Encoding':'identity','Cache-Control':'no-cache'},signal:AbortSignal.timeout(10000)})}catch{head=null}if(head&&[301,302,303,307,308].includes(head.status)){const loc=head.headers.get('location');try{await head.body?.cancel?.()}catch{}if(!loc)return{sizeBytes,lastModified,finalUrl:current.toString()};current=await validatePublicUrl(new URL(loc,current).toString());continue}if(head){const meta=metadataFromHeaders(head.headers);sizeBytes=meta.sizeBytes||sizeBytes;lastModified=meta.lastModified||lastModified;try{await head.body?.cancel?.()}catch{}if(head.ok&&sizeBytes&&lastModified)return{sizeBytes,lastModified,finalUrl:current.toString()}}let ranged=null;try{ranged=await nativeCheckedFetch(current,{method:'GET',headers:{'User-Agent':userAgent(),'Accept':'*/*','Accept-Encoding':'identity','Range':'bytes=0-0','Cache-Control':'no-cache'},signal:AbortSignal.timeout(10000)})}catch{ranged=null}if(ranged&&[301,302,303,307,308].includes(ranged.status)){const loc=ranged.headers.get('location');try{await ranged.body?.cancel?.()}catch{}if(!loc)return{sizeBytes,lastModified,finalUrl:current.toString()};current=await validatePublicUrl(new URL(loc,current).toString());continue}if(ranged){const meta=metadataFromHeaders(ranged.headers);sizeBytes=meta.sizeBytes||sizeBytes;lastModified=meta.lastModified||lastModified;try{await ranged.body?.cancel?.()}catch{}}return{sizeBytes,lastModified,finalUrl:current.toString()}}return{sizeBytes,lastModified,finalUrl:current.toString()}}
async function probeRemoteFileSize(input,redirects=7){const m=await probeRemoteFileMetadata(input,redirects);return m.sizeBytes||null}
module.exports={validatePublicUrl,safeFetch,safeFetchText,probeRemoteFileMetadata,probeRemoteFileSize};
