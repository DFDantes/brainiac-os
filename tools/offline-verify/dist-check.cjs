// REAL-BUILD check in REAL CHROMIUM (not WebKit/Safari, not an iPhone). Serves the actual `npm run build` output (dist/) and drives the real app:
// service worker install, offline reopen, creating/linking/editing records OFFLINE, history view, and persistence across an offline reload.
// Usage: npm run build && NODE_PATH=$(npm root -g) node tools/offline-verify/dist-check.cjs      (needs global Playwright + Chromium)
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const DIST = path.resolve(__dirname, '../../dist'); if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('Run `npm run build` first.'); process.exit(2); }
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let offline = false;
const srv = http.createServer((q, r) => { if (offline) { q.socket.destroy(); return; } let u = decodeURIComponent(q.url.split('?')[0]); if (u === '/') u = '/index.html'; const p = path.join(DIST, u);
  if (!p.startsWith(DIST) || !fs.existsSync(p)) { r.writeHead(404); return r.end('nope'); } r.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); r.end(fs.readFileSync(p)); });
const sleep = ms => new Promise(r => setTimeout(r, ms)); let bad = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) bad++; };
srv.listen(0, async () => {
  const base = `http://localhost:${srv.address().port}/`; const b = await chromium.launch(); const ctx = await b.newContext(); const pg = await ctx.newPage(); const errs = [];
  pg.on('pageerror', e => errs.push(String(e))); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const text = () => pg.evaluate(() => document.body.textContent), tab = async v => { await pg.click(`nav [data-id=${v}]`); await sleep(150); };
  const newRec = async (name, extra) => { await tab('archive'); await pg.click('[data-act=new]'); await pg.fill('#name', name); if (extra) await extra(); await pg.click('#rf button[type=submit]'); await pg.waitForFunction(n => document.body.textContent.includes('Last changed') && document.querySelector('main b')?.textContent === n, name); };
  try {
    await pg.goto(base); await pg.waitForSelector('nav'); await pg.evaluate(() => navigator.serviceWorker.ready); await sleep(2000);
    ok((await pg.evaluate(() => caches.keys())).join() === 'brainiac-v3', 'service worker installed and cache brainiac-v3 exists (real build)');
    ok((await pg.evaluate(async () => (await caches.open('brainiac-v3')).keys().then(k => k.map(x => new URL(x.url).pathname)))).some(p => /\/assets\/index-.*\.js$/.test(p)), 'the real hashed JS bundle is in the offline cache (sw.js matches Vite output)');
    offline = true; await ctx.setOffline(true); await pg.reload().catch(() => {}); await pg.waitForSelector('nav', { timeout: 8000 });
    ok((await text()).includes('BRAINIAC OS'), 'OFFLINE reopen of the real build renders the app');
    await newRec('Alpha'); ok(true, 'created record Alpha offline');
    await newRec('Beta', async () => { await pg.fill('#lq', 'alpha'); await pg.click('#lr [data-act=linkrec]'); await pg.waitForSelector('[data-act=unlinkrec]'); });
    ok((await text()).includes('Links to (1)'), 'Beta saved with a link to Alpha (picker used in a real browser)');
    await tab('archive'); await pg.click('#list .item:has(b:text-is("Alpha"))'); await pg.waitForSelector('text=Linked from');
    ok((await text()).includes('Linked from (1)') && (await pg.textContent('main')).includes('Beta'), 'Alpha shows Beta as a backlink');
    await pg.click('[data-act=edit]'); await pg.fill('#status', 'active'); await pg.click('#rf button[type=submit]'); await pg.waitForSelector('text=History (2)');
    ok((await text()).includes('status: empty → active'), 'history shows the status change (status: empty → active)');
    await pg.reload(); await pg.waitForSelector('nav'); await tab('archive'); await pg.waitForSelector('#list .item');
    ok((await pg.$$('#list .item')).length === 2, 'both records survive an offline reload (IndexedDB persistence)');
    ok((await text()).includes('OFFLINE'), 'app reports OFFLINE');
    ok(errs.length === 0, 'no console or page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  } catch (e) { ok(false, 'script error: ' + e.message.split('\n')[0]); }
  console.log(`\n${n - bad} passed, ${bad} failed`); await b.close(); srv.close(); process.exit(bad ? 1 : 0);
});
