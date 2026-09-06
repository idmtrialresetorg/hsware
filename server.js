import('./run-server.mjs').catch((err)=>{console.error('[Appbit] Failed to start Astro runtime:',err);process.exitCode=1});
