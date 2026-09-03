import handler from 'vinext/server/fetch-handler';
import cfBindings from '../legacy/cloudflare-bindings.js';
import initModule from '../legacy/init.js';
import updatesModule from '../legacy/services/updates.js';
import backupsModule from '../legacy/services/backups.js';

interface Env {
  HYPERDRIVE: { host:string; port:number; user:string; password:string; database:string };
  BACKUPS: R2Bucket;
  SESSION_SECRET: string;
  ADMIN_NAME?: string; ADMIN_EMAIL?: string; ADMIN_PASSWORD?: string; ADMIN_PATH?: string;
  APP_URL?: string; GITHUB_TOKEN?: string; LOGO_DEV_API_KEY?: string;
  LOGO_DEV_PUBLISHABLE_KEY?: string; BRANDFETCH_CLIENT_ID?: string;
  LIGHTWAVE_AUTO_UPDATES?: string; LIGHTWAVE_CONCURRENCY?: string; LIGHTWAVE_CRON_BATCHES?: string;
}
const { initializeDatabase } = initModule as any;
const updates = updatesModule as any;
const backups = backupsModule as any;

async function lightWaveCron(env:Env, ctx:ExecutionContext){
  (cfBindings as any).install(env,ctx);
  await initializeDatabase();
  let st=await updates.state();
  if(st.status!=='running') st=await updates.start(null,'published');
  // Free Workers allow 50 external subrequests/invocation. Keep this deliberately
  // bounded. Unfinished queues resume at the next Cron invocation.
  const batches=Math.max(1,Math.min(6,Number(env.LIGHTWAVE_CRON_BATCHES||'4')));
  for(let i=0;i<batches && st.status==='running';i++) st=await updates.step();
}
async function dailyBackupCron(env:Env,ctx:ExecutionContext){
  (cfBindings as any).install(env,ctx);
  await initializeDatabase();
  const last=await backups.latest('auto');
  const age=last?.createdAt?Date.now()-new Date(last.createdAt).getTime():Infinity;
  if(!last || !Number.isFinite(age) || age>=24*60*60*1000) await backups.createBackup('auto');
}
export default {
  async fetch(request:Request, env:Env, ctx:ExecutionContext):Promise<Response>{
    (cfBindings as any).install(env,ctx);
    return handler.fetch(request,env,ctx);
  },
  async scheduled(controller:ScheduledController, env:Env, ctx:ExecutionContext){
    (cfBindings as any).install(env,ctx);
    if(controller.cron==='0 2 * * *') ctx.waitUntil(dailyBackupCron(env,ctx));
    else ctx.waitUntil(lightWaveCron(env,ctx));
  }
};
