import { NextRequest, NextResponse } from 'next/server';
import { env } from 'cloudflare:workers';
import cfBindings from '../../../legacy/cloudflare-bindings.js';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import router from '../../../legacy/routes/api.js';
import compatRouter from '../../../legacy/compat/router.js';
import { ensureDatabaseReady } from '../../../lib/runtime';
import { ensureCsrf, saveSessionOnResponse, sessionFromRequest } from '../../../lib/session';
import rateLimitModule from '../../../legacy/services/rate-limits.js';
import diagnosticsModule from '../../../legacy/services/diagnostics.js';
import legacyConfig from '../../../legacy/config.js';
import dbModule from '../../../legacy/db.js';
import activityModule from '../../../legacy/services/activity.js';
import { allow } from '../../../lib/rate-limit';

const { createRequest, createResponse } = compatRouter as any;
const rateLimits = rateLimitModule as any;
const diagnostics = diagnosticsModule as any;
const runtimeConfig = legacyConfig as any;
const { getPool } = dbModule as any;
const activity = activityModule as any;
export const dynamic = 'force-dynamic';

function safeOperationalError(err: any) {
  const message=String(err?.message||err||'');
  if (/GITHUB_TOKEN is required/i.test(message)) return 'GitHub access is required for this lookup. Add GITHUB_TOKEN in Environment Variables or wait for the catalog index to discover the package.';
  if (/GitHub API (403|429)|rate limit/i.test(message)) return 'GitHub API rate limit reached. Add GITHUB_TOKEN for reliable large catalog discovery, then retry.';
  if (/Could not locate WinGet installer manifest/i.test(message)) return message.slice(0,300);
  if (/WinGet manifest fetch failed \(404\)/i.test(message)) return 'That WinGet package or version could not be found. Check the exact Package ID and retry.';
  if (/installer URL/i.test(message) || /installer manifest/i.test(message)) return message.slice(0,300);
  return process.env.NODE_ENV==='production'?'The request failed. Check Runtime Logs for details.':message;
}

async function readLimitedBody(request: NextRequest, max: number) {
  const declared=Number(request.headers.get('content-length')||0);
  if(Number.isFinite(declared)&&declared>max){const error:any=new Error('Request body is too large.');error.status=413;throw error;}
  if(!request.body) return Buffer.alloc(0);
  const reader=request.body.getReader();
  const chunks:Buffer[]=[];
  let total=0;
  try {
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      total+=value.byteLength;
      if(total>max){
        try{await reader.cancel()}catch{}
        const error:any=new Error('Request body is too large.');error.status=413;throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try{reader.releaseLock()}catch{}
  }
  return Buffer.concat(chunks,total);
}

async function readBody(request: NextRequest) {
  if (['GET','HEAD'].includes(request.method)) return {};
  const type=request.headers.get('content-type')||'';
  const max=type.includes('application/octet-stream')?100*1024*1024:type.startsWith('image/')?2*1024*1024:1024*1024;
  const buffer=await readLimitedBody(request,max);
  if(type.includes('application/json')){try{return JSON.parse(buffer.toString('utf8')||'{}')}catch{return {}}}
  if(type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(buffer.toString('utf8')).entries());
  if(type.includes('multipart/form-data')){
    try{
      const form=await new Response(buffer,{headers:{'content-type':type}}).formData();
      return Object.fromEntries(form.entries());
    }catch{return {}}
  }
  return buffer;
}

function clientIp(request: NextRequest) {
  const forwarded=request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return runtimeConfig.trustProxy ? (forwarded || request.headers.get('x-real-ip') || 'unknown') : (request.headers.get('x-real-ip') || 'unknown');
}

function safeNext(value: unknown) {
  const raw = String(value || '/dashboard');
  return /^\/(dashboard|software|published|updates|settings|catalog|health)(?:[/?#].*)?$/.test(raw) ? raw : '/dashboard';
}
function redirect303(location: string) {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store, max-age=0' }
  });
}
function loginError(code: string, nextPath = '/dashboard') {
  const params = new URLSearchParams({ error: code });
  if (nextPath !== '/dashboard') params.set('next', nextPath);
  return redirect303(`${runtimeConfig.adminPath || '/admin'}?${params.toString()}`);
}
async function handleLogin(request: NextRequest) {
  (cfBindings as any).install(env);
  const body:any = await readBody(request);
  const nextPath = safeNext(body?.next);
  const host = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '')
    .split(',')[0].trim().toLowerCase();
  const origin = request.headers.get('origin');
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch {}
    if (!host || originHost !== host) return loginError('origin', nextPath);
  }
  const ip = clientIp(request);
  const burst = allow(`login-burst:${ip}`, 25, 60 * 1000);
  if (!burst.ok) return loginError('rate', nextPath);

  const state = await ensureDatabaseReady();
  if (!state.dbReady) return loginError('database', nextPath);
  const persistent = await rateLimits.consume(`login:${ip}`, 12, 10 * 60);
  if (!persistent.ok) return loginError('rate', nextPath);

  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const [rows] = await getPool().query(
    'SELECT id,name,email,password_hash,role,is_active FROM users WHERE email=? LIMIT 1',
    [email]
  );
  const user = rows?.[0];
  const valid = user
    && user.is_active
    && ['admin','partner'].includes(String(user.role))
    && await bcrypt.compare(password, user.password_hash);
  if (!valid) return loginError('invalid', nextPath);

  await getPool().query('UPDATE users SET last_login_at=NOW() WHERE id=?', [user.id]);
  const destination = nextPath === '/health' ? '/health?from=login' : nextPath;
  const response = redirect303(destination);
  try {
    saveSessionOnResponse(response, {
      csrfToken: crypto.randomBytes(24).toString('hex'),
      user: { id:Number(user.id), name:user.name, email:user.email, role:user.role }
    });
  } catch (err) {
    diagnostics.logError(err,{area:'login-session',method:'POST',path:'/auth/login',userId:Number(user.id)},diagnostics.diagnosticId('LOGIN'));
    return loginError('session', nextPath);
  }
  await activity.record(user.id, 'user_login');
  return response;
}
async function handle(request: NextRequest, context: { params: Promise<{ path:string[] }> }) {
  (cfBindings as any).install(env);
  let relative='/'; let requestId=diagnostics.diagnosticId('REQ'); let userId:number|null=null;
  try {
    const {path=[]}=await context.params;
    relative='/' + path.join('/');
    if (relative === '/auth/login' && request.method === 'POST') return await handleLogin(request);
    const session=ensureCsrf(sessionFromRequest(request));
    userId=session?.user?.id ? Number(session.user.id) : null;
    if (!userId) {
      return NextResponse.json(
        {ok:false,error:'Your session has ended. Sign in again.',diagnosticId:requestId},
        {status:401,headers:{'X-HSWare-Request-ID':requestId}}
      );
    }
    await ensureDatabaseReady();
    const mutation=!['GET','HEAD'].includes(request.method);
    const expensive=/^\/(catalog\/sync|imports\/auto|updates\/scan|backups)/.test(relative);
    const identity=userId?`user:${userId}`:`ip:${clientIp(request)}`;
    const gate=await rateLimits.consume(`api:${identity}:${expensive?'expensive':mutation?'write':'read'}`, expensive?40:mutation?240:900, 5*60);
    if(!gate.ok){
      return NextResponse.json({ok:false,error:'Too many requests. Please wait and retry.',diagnosticId:requestId},{status:429,headers:{'Retry-After':String(gate.retryAfter),'X-RateLimit-Limit':String(gate.limit),'X-RateLimit-Remaining':String(gate.remaining)}});
    }
    const body=await readBody(request);
    const pseudoContext={request,locals:{session,currentUser:null,requestId}};
    const req=createRequest(pseudoContext,relative,body);
    const res=createResponse();
    res.locals.user=req.session?.user||null;
    res.locals.csrfToken=req.session?.csrfToken||null;
    res.locals.requestId=requestId;
    await (router as any).handle(req,res);
    const legacyResponse=res.toResponse();
    const response=new NextResponse(legacyResponse.body,{status:legacyResponse.status,headers:legacyResponse.headers});
    response.headers.set('X-HSWare-Request-ID',requestId);
    saveSessionOnResponse(response,req.session);
    return response;
  } catch (err:any) {
    diagnostics.logError(err,{area:'next-api',method:request.method,path:relative,userId},requestId);
    return NextResponse.json({ok:false,error:safeOperationalError(err),diagnosticId:requestId},{status:Number(err?.status||500),headers:{'X-HSWare-Request-ID':requestId}});
  }
}
export const GET=handle;
export const POST=handle;
export const PUT=handle;
export const PATCH=handle;
export const DELETE=handle;
