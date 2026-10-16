// Offline app shell. Cache-first, refreshed in the background. After a new deploy, close and reopen the app twice to see the update.
// Rule (Stage 2): the cache must never hold a page whose script/style files are missing, or the app breaks offline.
// So files are cached first and the page itself last, on install AND on every background refresh.
const CACHE = 'brainiac-v3';
const filesOf = html => [...new Set([...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map(m => m[1]))];
const has = (c, u) => c.match(u).then(Boolean);
self.addEventListener('install', e => e.waitUntil((async () => {
  const c = await caches.open(CACHE);
  const res = await fetch('./', { cache: 'reload' }); if (!res.ok) throw new Error('shell unavailable');
  await Promise.all(filesOf(await res.clone().text()).map(u => c.add(u))); // any failure aborts the install, so a half-cached shell is never used
  await c.put('./', res);
  await self.skipWaiting();
})()));
// Called after the page is served from cache: fetch the newest page and its files, and swap in the page only if every file arrived.
async function refreshShell() {
  const res = await fetch('./', { cache: 'reload' }); if (!res.ok) return;
  const c = await caches.open(CACHE), urls = filesOf(await res.clone().text());
  const done = await Promise.all(urls.map(async u => (await has(c, u)) || c.add(u).then(() => true, () => false)));
  if (done.every(Boolean)) await c.put('./', res);
}
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== CACHE).map(n => caches.delete(n)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    if (r.mode === 'navigate') {
      const page = await c.match('./');
      if (page) { e.waitUntil(refreshShell().catch(() => {})); return page; }
      try { return await fetch(r); } catch { return Response.error(); }
    }
    const hit = await c.match(r, { ignoreSearch: true });
    const net = fetch(r).then(res => { if (res.status === 200) c.put(r, res.clone()).catch(() => {}); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net; // offline and not cached: a real network error, never an HTML page pretending to be the file
  })());
});
