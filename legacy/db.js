const mysql = require('mysql2/promise');
const config = require('./config');

let pool;

function hasDbConfig() {
  return Boolean(config.db.host && config.db.database && config.db.user);
}

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      waitForConnections: true,
      connectionLimit: 8,
      queueLimit: 0,
      charset: 'utf8mb4_unicode_ci',
      timezone: 'Z',
      ssl: config.db.ssl ? { rejectUnauthorized: config.db.sslRejectUnauthorized !== false } : undefined,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });
  }
  return pool;
}

async function ping() {
  const [rows] = await getPool().query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

module.exports = { getPool, hasDbConfig, ping };
