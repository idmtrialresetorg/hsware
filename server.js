// Compatibility launcher for Hostinger deployments that still use server.js
// as the configured entry file. The actual v4 runtime is run-server.mjs.
import('./run-server.mjs').catch((err) => {
  console.error('[HSWare] Failed to start Astro runtime:', err);
  process.exitCode = 1;
});
