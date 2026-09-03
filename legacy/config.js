const crypto = require('crypto');
const { APP_VERSION } = require('./app-version');

function normalizeAdminPath(value) {
  let route = String(value || '/admin').trim();
  if (!route.startsWith('/')) route = '/' + route;
  route = route.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/admin';
  if (!/^\/[A-Za-z0-9_\/-]+$/.test(route) || ['/', '/api', '/health', '/login'].includes(route)) return '/admin';
  return route;
}

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return ['1','true','yes','on'].includes(String(v).toLowerCase());
}

module.exports = {
  appVersion: APP_VERSION,
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'production',
  sessionSecret: process.env.SESSION_SECRET || '',
  adminName: process.env.ADMIN_NAME || '',
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminRecoveryMode: envBool('ADMIN_RECOVERY_MODE', false),
  adminPath: normalizeAdminPath(process.env.ADMIN_PATH || '/admin'),
  dashboardPath: '/dashboard',
  githubToken: process.env.GITHUB_TOKEN || '',
  logoDevApiKey: process.env.LOGO_DEV_API_KEY || '',
  logoDevPublishableKey: process.env.LOGO_DEV_PUBLISHABLE_KEY || '',
  brandfetchClientId: process.env.BRANDFETCH_CLIENT_ID || '',
  googleDrive: {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI || '',
    appUrl: process.env.APP_URL || ''
  },
  catalogTarget: Math.max(100, Math.min(50000, Number(process.env.CATALOG_TARGET || 50000))),
  trustProxy: envBool('TRUST_PROXY', true),
  lightWaveAuto: envBool('LIGHTWAVE_AUTO_UPDATES', true),
  lightWaveIntervalMs: Math.max(60*60*1000, Number(process.env.LIGHTWAVE_INTERVAL_HOURS || 6) * 60*60*1000),
  lightWaveConcurrency: Math.max(1, Math.min(8, Number(process.env.LIGHTWAVE_CONCURRENCY || 4))),
  lightWaveActiveDelayMs: Math.max(100, Number(process.env.LIGHTWAVE_ACTIVE_DELAY_MS || 750)),
  db: {
    host: process.env.DB_HOST || '',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || '',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    ssl: envBool('DB_SSL', false),
    sslRejectUnauthorized: envBool('DB_SSL_REJECT_UNAUTHORIZED', true)
  },
  appInstanceId: crypto.randomBytes(8).toString('hex')
};
