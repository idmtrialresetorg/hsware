const crypto = require('crypto');

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return ['1','true','yes','on'].includes(String(v).toLowerCase());
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'production',
  sessionSecret: process.env.SESSION_SECRET || '',
  adminName: process.env.ADMIN_NAME || '',
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  apkResolverDailyPages: Math.max(2, Math.min(50, Number(process.env.APK_RESOLVER_DAILY_PAGES || 8))),
  apkResolverFullPages: Math.max(10, Math.min(500, Number(process.env.APK_RESOLVER_FULL_PAGES || 80))),
  apkResolverMaxItems: Math.max(100, Math.min(50000, Number(process.env.APK_RESOLVER_MAX_ITEMS || 50000))),
  apkResolverRequestGapMs: Math.max(700, Math.min(10000, Number(process.env.APK_RESOLVER_REQUEST_GAP_MS || 1400))),
  trustProxy: envBool('TRUST_PROXY', true),
  db: {
    host: process.env.DB_HOST || '',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || '',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    ssl: envBool('DB_SSL', false)
  },
  appInstanceId: crypto.randomBytes(8).toString('hex')
};
