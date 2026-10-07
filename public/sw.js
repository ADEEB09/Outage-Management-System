// Kill switch for the OLD crew web prototype's service worker (vite-plugin-pwa
// registered /sw.js on localhost:5174). Browsers that ran the old app keep
// serving its cached pages until this replaces it: it clears those caches,
// unregisters itself, and reloads open tabs onto the current Expo web app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
