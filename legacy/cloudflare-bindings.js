let currentEnv = null;
let currentCtx = null;

const STRING_BINDINGS = [
  'SESSION_SECRET','ADMIN_NAME','ADMIN_EMAIL','ADMIN_PASSWORD','ADMIN_PATH','APP_URL',
  'GITHUB_TOKEN','LOGO_DEV_API_KEY','LOGO_DEV_PUBLISHABLE_KEY','BRANDFETCH_CLIENT_ID',
  'LIGHTWAVE_AUTO_UPDATES','LIGHTWAVE_INTERVAL_HOURS','LIGHTWAVE_CONCURRENCY',
  'LIGHTWAVE_ACTIVE_DELAY_MS','LIGHTWAVE_CRON_BATCHES','TRUST_PROXY'
];

function install(env, ctx = null) {
  currentEnv = env || currentEnv;
  currentCtx = ctx || currentCtx;
  if (typeof process !== 'undefined' && process.env && currentEnv) {
    for (const key of STRING_BINDINGS) {
      const value = currentEnv[key];
      if (typeof value === 'string' && value !== '') process.env[key] = value;
    }
    process.env.NODE_ENV = process.env.NODE_ENV || 'production';
    process.env.HSWARE_CLOUDFLARE = '1';
  }
  globalThis.__HSWARE_CLOUDFLARE_ENV = currentEnv;
  globalThis.__HSWARE_CLOUDFLARE_CTX = currentCtx;
}
function env() { return currentEnv || globalThis.__HSWARE_CLOUDFLARE_ENV || null; }
function ctx() { return currentCtx || globalThis.__HSWARE_CLOUDFLARE_CTX || null; }
function isCloudflare() { return Boolean(env()); }
function hyperdrive() { return env()?.HYPERDRIVE || null; }
function r2() { return env()?.BACKUPS || null; }
module.exports = { install, env, ctx, isCloudflare, hyperdrive, r2 };
