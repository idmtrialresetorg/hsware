const crypto = require('crypto');
const { APP_VERSION } = require('./app-version');
const cf = require('./cloudflare-bindings');

function read(name, fallback='') {
  const bound = cf.env()?.[name];
  if (bound != null && bound !== '') return String(bound);
  const local = process.env?.[name];
  return local == null || local === '' ? fallback : String(local);
}
function normalizeAdminPath(value) {
  let route = String(value || '/admin').trim();
  if (!route.startsWith('/')) route = '/' + route;
  route = route.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/admin';
  if (!/^\/[A-Za-z0-9_\/-]+$/.test(route) || ['/', '/api', '/health', '/login'].includes(route)) return '/admin';
  return route;
}
function envBool(name, fallback=false) {
  const v=read(name,''); if(v==='') return fallback;
  return ['1','true','yes','on'].includes(v.toLowerCase());
}
const config = {
  appVersion: APP_VERSION,
  appInstanceId: crypto.randomBytes(8).toString('hex'),
  dashboardPath: '/dashboard',
  get port(){ return Number(read('PORT','3000')); },
  get nodeEnv(){ return read('NODE_ENV','production'); },
  get sessionSecret(){ return read('SESSION_SECRET',''); },
  get adminName(){ return read('ADMIN_NAME',''); },
  get adminEmail(){ return read('ADMIN_EMAIL',''); },
  get adminPassword(){ return read('ADMIN_PASSWORD',''); },
  get adminRecoveryMode(){ return envBool('ADMIN_RECOVERY_MODE',false); },
  get adminPath(){ return normalizeAdminPath(read('ADMIN_PATH','/admin')); },
  get githubToken(){ return read('GITHUB_TOKEN',''); },
  get logoDevApiKey(){ return read('LOGO_DEV_API_KEY',''); },
  get logoDevPublishableKey(){ return read('LOGO_DEV_PUBLISHABLE_KEY',''); },
  get brandfetchClientId(){ return read('BRANDFETCH_CLIENT_ID',''); },
  get catalogTarget(){ return Math.max(100,Math.min(50000,Number(read('CATALOG_TARGET','50000')))); },
  get trustProxy(){ return envBool('TRUST_PROXY',true); },
  get lightWaveAuto(){ return envBool('LIGHTWAVE_AUTO_UPDATES',true); },
  get lightWaveIntervalMs(){ return Math.max(60*60*1000,Number(read('LIGHTWAVE_INTERVAL_HOURS','6'))*60*60*1000); },
  get lightWaveConcurrency(){ return Math.max(1,Math.min(8,Number(read('LIGHTWAVE_CONCURRENCY','4')))); },
  get lightWaveActiveDelayMs(){ return Math.max(100,Number(read('LIGHTWAVE_ACTIVE_DELAY_MS','750'))); },
  get googleDrive(){ return { clientId:read('GOOGLE_DRIVE_CLIENT_ID',''),clientSecret:read('GOOGLE_DRIVE_CLIENT_SECRET',''),redirectUri:read('GOOGLE_DRIVE_REDIRECT_URI',''),appUrl:read('APP_URL','') }; },
  get db(){ return { host:read('DB_HOST',''),port:Number(read('DB_PORT','3306')),database:read('DB_NAME',''),user:read('DB_USER',''),password:read('DB_PASSWORD',''),ssl:envBool('DB_SSL',false),sslRejectUnauthorized:envBool('DB_SSL_REJECT_UNAUTHORIZED',true) }; }
};
module.exports = config;
