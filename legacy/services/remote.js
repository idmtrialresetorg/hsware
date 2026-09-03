const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const config = require('../config');

function ipv4Blocked(ip) {
  const p=ip.split('.').map(Number); if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255)) return true;
  return p[0]===0 || p[0]===10 || p[0]===127 || (p[0]===169&&p[1]===254) || (p[0]===172&&p[1]>=16&&p[1]<=31) || (p[0]===192&&p[1]===168) || (p[0]===100&&p[1]>=64&&p[1]<=127) || (p[0]===192&&p[1]===0&&[0,2].includes(p[2])) || (p[0]===198&&[18,19].includes(p[1])) || (p[0]===198&&p[1]===51&&p[2]===100) || (p[0]===203&&p[1]===0&&p[2]===113) || p[0]>=224;
}
function isPrivateIp(ip) {
  const kind=net.isIP(ip); if(!kind) return true;
  if(kind===4) return ipv4Blocked(ip);
  const low=ip.toLowerCase().split('%')[0];
  if(low==='::'||low==='::1') return true;
  if(low.startsWith('::ffff:')) {
    const mapped=low.slice(7);
    if(net.isIP(mapped)===4) return ipv4Blocked(mapped);
    const parts=mapped.split(':');
    if(parts.length===2 && parts.every(x=>/^[0-9a-f]{1,4}$/.test(x))){const a=parseInt(parts[0],16),b=parseInt(parts[1],16);return ipv4Blocked(`${a>>8}.${a&255}.${b>>8}.${b&255}`);}
  }
  if(low.startsWith('2001:db8')) return true;
  return low.startsWith('fc')||low.startsWith('fd')||low.startsWith('fe8')||low.startsWith('fe9')||low.startsWith('fea')||low.startsWith('feb')||low.startsWith('ff');
}
function blockedHostname(hostname) {
  const h=String(hostname||'').toLowerCase().replace(/\.$/,'');
  return !h || h==='localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home') || h.endsWith('.lan');
}
async function resolvePublic(hostname) {
  if(blockedHostname(hostname)) throw new Error('Local/internal hostnames are not allowed.');
  if(net.isIP(hostname)) {
    if(isPrivateIp(hostname)) throw new Error('Private/local network targets are not allowed.');
    return [hostname];
  }
  const addresses=await dns.lookup(hostname,{all:true,verbatim:true});
  if(!addresses.length) throw new Error('Remote hostname did not resolve.');
  if(addresses.some(a=>isPrivateIp(a.address))) throw new Error('Remote hostname resolves to a private/reserved network target.');
  return [...new Set(addresses.map(a=>a.address))];
}
async function validatePublicUrl(input) {
  let url; try { url=new URL(input); } catch { throw new Error('Invalid remote URL.'); }
  if(!['http:','https:'].includes(url.protocol)) throw new Error('Only HTTP/HTTPS URLs are allowed.');
  if(url.username||url.password) throw new Error('Credentials in URLs are not allowed.');
  if(url.port&&!['80','443'].includes(url.port)) throw new Error('Non-standard ports are not allowed.');
  if(url.hostname.length>253) throw new Error('Remote hostname is invalid.');
  await resolvePublic(url.hostname);
  return url;
}
function headerObject(rawHeaders) {
  const headers=new Headers();
  for(const [key,value] of Object.entries(rawHeaders||{})) {
    if(value==null) continue;
    if(Array.isArray(value)) value.forEach(v=>headers.append(key,String(v)));
    else headers.set(key,String(value));
  }
  return headers;
}
async function checkedFetch(url, options={}) {
  // Security invariant: the IP used for the TCP connection is one of the
  // public addresses validated here. Native http/https is used intentionally
  // so a second DNS lookup cannot redirect the connection to a private host.
  const addresses=await resolvePublic(url.hostname);
  const address=addresses[0];
  if(!address || isPrivateIp(address)) throw new Error('Remote hostname did not resolve to a safe public address.');
  const secure=url.protocol==='https:';
  const transport=secure?https:http;
  const method=String(options.method||'GET').toUpperCase();
  const inputHeaders={...(options.headers||{})};
  const hostHeader=url.port?`${url.hostname}:${url.port}`:url.hostname;
  inputHeaders.Host=hostHeader;
  return await new Promise((resolve,reject)=>{
    let settled=false;
    const req=transport.request({
      protocol:url.protocol,
      hostname:address,
      family:net.isIP(address),
      port:url.port||undefined,
      method,
      path:`${url.pathname||'/'}${url.search||''}`,
      headers:inputHeaders,
      servername:secure&&!net.isIP(url.hostname)?url.hostname:undefined,
      rejectUnauthorized:true,
      signal:options.signal
    },res=>{
      settled=true;
      const body=Readable.toWeb(res);
      resolve({
        status:Number(res.statusCode||0),
        ok:Number(res.statusCode||0)>=200&&Number(res.statusCode||0)<300,
        headers:headerObject(res.headers),
        body
      });
    });
    req.on('error',err=>{if(!settled)reject(err);});
    if(options.body) req.write(options.body);
    req.end();
  });
}
function userAgent(){return `Mozilla/5.0 (compatible; HSWareStudio/${config.appVersion})`;}
async function safeFetch(input,{maxBytes=4*1024*1024,accept='*/*',redirects=4,timeoutMs=15000}={}){
  let current=await validatePublicUrl(input); const seen=new Set();
  for(let i=0;i<=Math.min(8,Math.max(0,redirects));i++){
    const key=current.toString(); if(seen.has(key)) throw new Error('Remote redirect loop detected.'); seen.add(key);
    const response=await checkedFetch(current,{headers:{'User-Agent':userAgent(),'Accept':accept,'Accept-Language':'en-US,en;q=0.8'},signal:AbortSignal.timeout(Math.min(30000,Math.max(1000,timeoutMs)))});
    if([301,302,303,307,308].includes(response.status)){
      const loc=response.headers.get('location'); try{await response.body?.cancel?.()}catch{}
      if(!loc) throw new Error('Redirect without a location header.');
      current=await validatePublicUrl(new URL(loc,current).toString()); continue;
    }
    if(!response.ok) throw new Error(`Remote server returned ${response.status}.`);
    const contentLength=Number(response.headers.get('content-length')||0); if(contentLength&&contentLength>maxBytes) throw new Error('Remote response is larger than the allowed limit.');
    if(!response.body) return {url:current.toString(),status:response.status,headers:response.headers,buffer:Buffer.alloc(0)};
    const reader=response.body.getReader(),chunks=[]; let total=0;
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){try{await reader.cancel()}catch{}throw new Error('Remote response exceeded the allowed limit.');}chunks.push(Buffer.from(value));}
    return {url:current.toString(),status:response.status,headers:response.headers,buffer:Buffer.concat(chunks)};
  }
  throw new Error('Too many redirects.');
}
async function safeFetchText(input,maxBytes=2*1024*1024){const result=await safeFetch(input,{maxBytes,accept:'text/html,application/xhtml+xml'});const type=result.headers.get('content-type')||'';if(!/text\/html|application\/xhtml\+xml/i.test(type))throw new Error('URL did not return HTML.');return {...result,text:result.buffer.toString('utf8')}}
function normalizeRemoteDate(value){if(!value)return null;const d=new Date(String(value));return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10)}
function metadataFromHeaders(headers){const range=String(headers?.get?.('content-range')||'');const match=range.match(/\/(\d+)$/);const rangeSize=match?Number(match[1]):0;const contentSize=Number(headers?.get?.('content-length')||0);return{sizeBytes:Number.isFinite(rangeSize)&&rangeSize>1?rangeSize:(Number.isFinite(contentSize)&&contentSize>1?contentSize:null),lastModified:normalizeRemoteDate(headers?.get?.('last-modified')||null)}}
async function probeRemoteFileMetadata(input,redirects=7){let current=await validatePublicUrl(input),lastModified=null,sizeBytes=null;const seen=new Set();for(let i=0;i<=Math.min(8,Math.max(0,redirects));i++){if(seen.has(current.toString()))break;seen.add(current.toString());let head=null;try{head=await checkedFetch(current,{method:'HEAD',headers:{'User-Agent':userAgent(),'Accept':'*/*','Accept-Encoding':'identity','Cache-Control':'no-cache'},signal:AbortSignal.timeout(10000)})}catch{head=null}if(head&&[301,302,303,307,308].includes(head.status)){const loc=head.headers.get('location');try{await head.body?.cancel?.()}catch{}if(!loc)return{sizeBytes,lastModified,finalUrl:current.toString()};current=await validatePublicUrl(new URL(loc,current).toString());continue}if(head){const meta=metadataFromHeaders(head.headers);sizeBytes=meta.sizeBytes||sizeBytes;lastModified=meta.lastModified||lastModified;try{await head.body?.cancel?.()}catch{}if(head.ok&&sizeBytes&&lastModified)return{sizeBytes,lastModified,finalUrl:current.toString()}}let ranged=null;try{ranged=await checkedFetch(current,{method:'GET',headers:{'User-Agent':userAgent(),'Accept':'*/*','Accept-Encoding':'identity','Range':'bytes=0-0','Cache-Control':'no-cache'},signal:AbortSignal.timeout(10000)})}catch{ranged=null}if(ranged&&[301,302,303,307,308].includes(ranged.status)){const loc=ranged.headers.get('location');try{await ranged.body?.cancel?.()}catch{}if(!loc)return{sizeBytes,lastModified,finalUrl:current.toString()};current=await validatePublicUrl(new URL(loc,current).toString());continue}if(ranged){const meta=metadataFromHeaders(ranged.headers);sizeBytes=meta.sizeBytes||sizeBytes;lastModified=meta.lastModified||lastModified;try{await ranged.body?.cancel?.()}catch{}}return{sizeBytes,lastModified,finalUrl:current.toString()}}return{sizeBytes,lastModified,finalUrl:current.toString()}}
async function probeRemoteFileSize(input,redirects=7){const metadata=await probeRemoteFileMetadata(input,redirects);return metadata.sizeBytes||null}
module.exports={isPrivateIp,validatePublicUrl,safeFetch,safeFetchText,probeRemoteFileMetadata,probeRemoteFileSize};
