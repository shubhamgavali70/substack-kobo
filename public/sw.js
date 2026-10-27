// Minimal service worker: required for installability (Android Share Target).
// It deliberately caches nothing so private content is never stored offline.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // Network only.
});
