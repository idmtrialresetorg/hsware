const mysql = require('mysql2/promise');
const config = require('./config');
const cf = require('./cloudflare-bindings');

let pool;

function hasDbConfig() {
  return Boolean(cf.hyperdrive() || (config.db.host && config.db.database && config.db.user));
}
function optionsFromHyperdrive(h) {
  return {
    host: h.host,
    port: Number(h.port || 3306),
    database: h.database,
    user: h.user,
    password: h.password,
    disableEval: true,
    charset: 'utf8mb4',
    timezone: 'Z'
  };
}
function standardOptions() {
  return {
    host: config.db.host, port: config.db.port, database: config.db.database,
    user: config.db.user, password: config.db.password,
    waitForConnections: true, connectionLimit: 8, queueLimit: 0,
    charset: 'utf8mb4_unicode_ci', timezone: 'Z',
    ssl: config.db.ssl ? { rejectUnauthorized: config.db.sslRejectUnauthorized !== false } : undefined,
    enableKeepAlive: true, keepAliveInitialDelay: 0
  };
}
async function cloudflareConnection() {
  const h = cf.hyperdrive();
  if (!h) throw new Error('Cloudflare Hyperdrive binding HYPERDRIVE is not configured.');
  return mysql.createConnection(optionsFromHyperdrive(h));
}
function cloudflarePoolFacade() {
  return {
    async query(sql, params) {
      const conn = await cloudflareConnection();
      try { return await conn.query(sql, params); }
      finally { try { await conn.end(); } catch {} }
    },
    async execute(sql, params) { return this.query(sql, params); },
    async getConnection() {
      const conn = await cloudflareConnection();
      const originalRelease = conn.release?.bind(conn);
      conn.release = () => { try { return conn.end(); } catch { return originalRelease?.(); } };
      return conn;
    }
  };
}
function getPool() {
  if (cf.hyperdrive()) return cloudflarePoolFacade();
  if (!pool) pool = mysql.createPool(standardOptions());
  return pool;
}
async function ping() {
  const [rows] = await getPool().query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}
module.exports = { getPool, hasDbConfig, ping };
