import state from '../legacy/state.js';
import initModule from '../legacy/init.js';
const { initializeDatabase } = initModule as any;
const g = globalThis as typeof globalThis & { __hswareDbInit?: Promise<void> };

export async function ensureDatabaseReady() {
  if (!(state as any).dbReady) {
    if (!g.__hswareDbInit) {
      g.__hswareDbInit = Promise.resolve(initializeDatabase()).finally(() => { g.__hswareDbInit = undefined; });
    }
    await g.__hswareDbInit;
  }
  // Cloudflare Edition intentionally starts no Node timers here.
  // Scheduled maintenance is handled by worker/index.ts Cron Triggers.
  return state as any;
}
