/* HSWare Studio v14.2.0 PWA service worker.
   Intentionally does not cache API responses or authenticated pages.
   This keeps the existing live database/auth behavior unchanged. */
const SW_VERSION = 'hsware-v14.2.0';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith('hsware-') && key !== SW_VERSION).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});
