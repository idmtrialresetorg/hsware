import state from '../legacy/state.js';
import initModule from '../legacy/init.js';
import enrichmentModule from '../legacy/services/enrichment.js';
import importsModule from '../legacy/services/imports.js';
import backupsModule from '../legacy/services/backups.js';
import catalogModule from '../legacy/services/catalog.js';
import updatesModule from '../legacy/services/updates.js';

const { initializeDatabase } = initModule as any;
const { startEnrichmentWorker } = enrichmentModule as any;
const { startImportWorker } = importsModule as any;
const { startBackupWorker } = backupsModule as any;
const { startCatalogWorker } = catalogModule as any;
const { startUpdateWorker } = updatesModule as any;

const g = globalThis as typeof globalThis & {
  __hswareRuntimeStarted?: boolean;
  __hswareDbInit?: Promise<void>;
};

function startBackgroundWorkersOnce() {
  if (g.__hswareRuntimeStarted) return;
  g.__hswareRuntimeStarted = true;
  try {
    startEnrichmentWorker();
    startImportWorker();
    startCatalogWorker();
    startBackupWorker();
    startUpdateWorker();
    console.log('[HSWare] Background workers started.');
  } catch (error) {
    g.__hswareRuntimeStarted = false;
    console.error('[HSWare] Failed to start background workers:', error);
  }
}

export async function ensureDatabaseReady() {
  if (!(state as any).dbReady) {
    if (!g.__hswareDbInit) {
      g.__hswareDbInit = Promise.resolve(initializeDatabase()).finally(() => {
        g.__hswareDbInit = undefined;
      });
    }
    await g.__hswareDbInit;
  }
  if ((state as any).dbReady) startBackgroundWorkersOnce();
  return state as any;
}
