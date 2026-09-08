const BASE = 'https://liteapks.com';
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT = 20000;
let lastRequestAt = 0;
class SourceError extends Error {
  constructor(message, status = 502, code = 'SOURCE_ERROR', retryable = false) {
    super(message); this.name='SourceError'; this.status=status; this.code=code; this.retryable=retryable;
  }
}
function sourceUrl(value, base=BASE) {
  try {
    const u=new URL(value,base);
    if(u.protocol!=='https:' || !/(^|\.)liteapks\.com$/i.test(u.hostname) || u.username || u.password || u.port && u.port!=='443')return null;
    u.hash='';return u.toString();
  }catch{return null}
}
function wait(ms, signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(signal.reason || new Error('Request stopped.'));
    const timer=setTimeout(done,ms);
    function done(){signal?.removeEventListener('abort',abort);resolve()}
    function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason || new Error('Request stopped.'))}
    signal?.addEventListener('abort',abort,{once:true});
  });
}
function retryDelay(header,attempt){
  const numeric=Number(header);let ms=Number.isFinite(numeric)?numeric*1000:Date.parse(header||'')-Date.now();
  if(!Number.isFinite(ms)||ms<0)ms=1500*(attempt+1);
  return Math.min(30000,Math.max(1000,ms));
}
async function fetchText(input,{accept='text/html,application/xhtml+xml',signal,gapMs=1400,fetchImpl=fetch,maxBytes=MAX_BYTES}={}){
  const initial=sourceUrl(input);
  if(!initial)throw new SourceError('Only public HTTPS LiteAPKs URLs are supported.',400,'INVALID_SOURCE_URL');
  attemptLoop: for(let attempt=0;attempt<3;attempt++){
    const controller=new AbortController();
    const abort=()=>controller.abort(signal?.reason);
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(new Error('Request timed out.')),TIMEOUT);
    try{
      const gap=Math.max(700,Number(gapMs)||1400);
      await wait(Math.max(0,lastRequestAt+gap-Date.now()),controller.signal);
      let current=initial;
      for(let redirects=0;redirects<5;redirects++){
        const res=await fetchImpl(current,{redirect:'manual',signal:controller.signal,headers:{'user-agent':'Appbit/1.0 (public metadata request)','accept':accept,'accept-language':'en-US,en;q=0.8'}});
        lastRequestAt=Date.now();
        if([301,302,303,307,308].includes(res.status)){
          const next=sourceUrl(res.headers.get('location'),current);
          if(!next)throw new SourceError('Source redirected outside LiteAPKs.',502,'SOURCE_REDIRECT');
          current=next;continue;
        }
        if(res.status===401||res.status===403)throw new SourceError(`LiteAPKs refused access (HTTP ${res.status}). This is a source-side restriction. Open the source normally and contact its operator if access is required; Appbit will not bypass the restriction.`,res.status,'SOURCE_ACCESS_DENIED');
        if(res.status===429||res.status>=500){
          if(attempt<2){await wait(retryDelay(res.headers.get('retry-after'),attempt),controller.signal);continue attemptLoop;}
          throw new SourceError(`LiteAPKs returned HTTP ${res.status}. The import is paused; retry later.`,res.status,res.status===429?'SOURCE_RATE_LIMITED':'SOURCE_UNAVAILABLE',true);
        }
        if(!res.ok)throw new SourceError(`LiteAPKs returned HTTP ${res.status}.`,res.status,'SOURCE_HTTP_ERROR');
        const length=Number(res.headers.get('content-length')||0);
        if(length>maxBytes)throw new SourceError('Source response exceeds the metadata size limit.',413,'SOURCE_TOO_LARGE');
        const reader=res.body?.getReader();let total=0;const chunks=[];
        if(reader){while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel();throw new SourceError('Source response exceeds the metadata size limit.',413,'SOURCE_TOO_LARGE')}chunks.push(Buffer.from(value));}}
        else{const b=Buffer.from(await res.arrayBuffer());total=b.length;chunks.push(b);if(total>maxBytes)throw new SourceError('Source response exceeds the metadata size limit.',413,'SOURCE_TOO_LARGE')}
        const text=Buffer.concat(chunks).toString('utf8');
        if(/<title[^>]*>[^<]*(?:just a moment|attention required|access denied|verify you are human)/i.test(text)||/(?:id=["'](?:challenge-form|cf-challenge-running)["']|cf-turnstile|cf-chl-|challenge-platform|checking your browser|enable javascript and cookies)/i.test(text))throw new SourceError('LiteAPKs returned a verification/challenge page instead of app metadata. Import paused.',403,'SOURCE_CHALLENGE');
        return{text,url:current,contentType:res.headers.get('content-type')||''};
      }
      throw new SourceError('Too many source redirects.',502,'SOURCE_REDIRECT');
    }catch(err){
      if(controller.signal.aborted){if(signal?.aborted)throw new SourceError('Request stopped.',499,'SOURCE_STOPPED');throw new SourceError('LiteAPKs request timed out.',504,'SOURCE_TIMEOUT',true)}
      if(err instanceof SourceError)throw err;
      if(attempt===2)throw new SourceError(`LiteAPKs request failed: ${err.message||err}`,502,'SOURCE_NETWORK',true);
      await wait(1500*(attempt+1),signal);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
  }
  throw new SourceError('LiteAPKs is temporarily unavailable.',503,'SOURCE_UNAVAILABLE',true);
}
module.exports={SourceError,sourceUrl,fetchText,wait};
