const config = require('../config');
const state = require('../state');
const { hasDbConfig } = require('../db');
const { hasToken } = require('./github');
const { versionState } = require('../app-version');
const reliability = require('./reliability');

const REQUIRED_SCHEMA_VERSION = 27;
function baseChecks() {
  const vs=versionState();
  return [
    {key:'version',name:'Version consistency',status:vs.consistent?'pass':'fail',detail:vs.consistent?`HSWare v${vs.appVersion}`:`VERSION=${vs.versionFile||'missing'} · package=${vs.packageVersion||'missing'}`},
    {key:'node',name:'Node.js version',status:'pass',detail:process.version},
    {key:'db_env',name:'Database environment',status:hasDbConfig()?'pass':'fail',detail:hasDbConfig()?'Configured':'DB_HOST / DB_NAME / DB_USER required'},
    {key:'db',name:'Database connection',status:state.dbReady?'pass':'fail',detail:state.dbReady?'Connected':(state.dbError||'Waiting for connection')},
    {key:'schema',name:'Schema',status:state.schemaVersion>=REQUIRED_SCHEMA_VERSION?'pass':'fail',detail:state.schemaVersion?`Version ${state.schemaVersion}`:'Not initialized'},
    {key:'frontend',name:'Frontend framework',status:'pass',detail:'Next.js 16 + React 19 + TypeScript + Tailwind CSS'},
    {key:'admin',name:'Admin account',status:state.adminReady?'pass':'fail',detail:state.adminReady?'Ready':'Set ADMIN_EMAIL and ADMIN_PASSWORD before first run'},
    {key:'roles',name:'User roles',status:'pass',detail:'Admin + Partner role system'},
    {key:'session',name:'Session secret',status:config.sessionSecret.length>=32?'pass':'fail',detail:config.sessionSecret.length>=32?'Configured':'SESSION_SECRET should be at least 32 characters'},
    {key:'github',name:'GitHub API token',status:hasToken()?'pass':'recommend',detail:hasToken()?'Configured':'Optional. Recommended for higher GitHub limits, deeper WinGet discovery and version history.'}
  ];
}
async function getHealthChecks() {
  const checks=baseChecks();
  if(state.dbReady){
    try { const w=await reliability.summary(); checks.push({key:'workers',name:'Background workers',status:w.ok?'pass':'recommend',detail:w.ok?'All expected workers are reporting health.':`${w.unhealthy.length} worker(s) missing, stale or degraded.`}); }
    catch(err){checks.push({key:'workers',name:'Background workers',status:'recommend',detail:`Health telemetry unavailable: ${String(err?.message||err).slice(0,160)}`});}
  }
  return checks;
}
async function getReadiness() { const checks=await getHealthChecks(); const failed=checks.filter(item=>item.status==='fail'); return {ok:failed.length===0,checks,failed}; }
module.exports={REQUIRED_SCHEMA_VERSION,getHealthChecks,getReadiness};
