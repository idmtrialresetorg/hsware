const state = require('./state');
const { hasDbConfig, ping } = require('./db');
const { migrate } = require('./migrations');
const { ensureAdmin } = require('./seed');

let running = false;

async function initializeDatabase() {
  if (running) return;
  running = true;
  state.dbLastAttempt = new Date();
  try {
    if (!hasDbConfig()) throw new Error('Database environment variables are incomplete.');
    await ping();
    state.schemaVersion = await migrate();
    state.adminReady = await ensureAdmin();
    state.dbReady = true;
    state.dbError = null;
    console.log(`[Appbit] Database ready. Schema v${state.schemaVersion}.`);
  } catch (err) {
    state.dbReady = false;
    state.dbError = err?.message || String(err);
    console.error('[Appbit] Database initialization failed:', state.dbError);
  } finally {
    running = false;
  }
}

function startDatabaseInitialization() {
  initializeDatabase();
  const timer = setInterval(() => { if (!state.dbReady) initializeDatabase(); }, 15000);
  if (timer.unref) timer.unref();
}

module.exports = { initializeDatabase, startDatabaseInitialization };
