// Offline app shell. Precaches the page and its files on install, then serves cache first and refreshes in the background.
// After a new deploy, close and reopen the app twice to see the update.
const CACHE = 'brainiac-v2';
self.addEventListener('install', e => e.waitUntil((async () => {
  const c = await caches.open(CACHE);
  const res = await fetch('./', { cache: 'reload' }); if (!res.ok) throw new Error('shell unavailable');
  const html = await res.clone().text(); await c.put('./', res);
  const urls = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map(m => m[1]);
  await Promise.all(urls.map(u => c.add(u).catch(() => {})));
  await self.skipWaiting();
})()));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== CACHE).map(n => caches.delete(n)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE), hit = await c.match(r, { ignoreSearch: true });
    const net = fetch(r).then(res => { if (res.status === 200) c.put(r, res.clone()).catch(() => {}); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    try { return await net; } catch { return (await c.match('./')) || Response.error(); }
  })());
});
