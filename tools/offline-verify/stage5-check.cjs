// STAGE 5 real-bundle check in REAL CHROMIUM with an iPhone-7-sized viewport (375x667, touch, DPR 2). It is NOT Safari/WebKit and NOT a physical iPhone.
// Usage: (npm run build  OR  tools/offline-verify/esbuild-dist.sh) && NODE_PATH=$(npm root -g) node tools/offline-verify/stage5-check.cjs
// Drives the shipped bundle: seeds data with Coluan commands, visits every screen, checks horizontal overflow and tap-target size, goes OFFLINE, reloads, and scans the bundle for secrets.
const { chromium, devices } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const DIST = path.resolve(__dirname, '../../dist'); if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('No dist/. Build first.'); process.exit(2); }
const SHOTS = process.env.SHOTS || '/tmp/shots'; fs.mkdirSync(SHOTS, { recursive: true });
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }; let offline = false;
const srv = http.createServer((q, r) => { if (offline) { q.socket.destroy(); return; } let u = decodeURIComponent(q.url.split('?')[0]); if (u === '/') u = '/index.html'; const p = path.join(DIST, u);
  if (!p.startsWith(DIST) || !fs.existsSync(p)) { r.writeHead(404); return r.end('nope'); } r.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); r.end(fs.readFileSync(p)); });
const sleep = ms => new Promise(r => setTimeout(r, ms)); let bad = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) bad++; };
srv.listen(0, async () => {
  const base = `http://localhost:${srv.address().port}/`; const { defaultBrowserType, ...phone } = devices['iPhone 7']; const b = await chromium.launch(); const ctx = await b.newContext({ ...phone }); const pg = await ctx.newPage(); const errs = [];
  pg.on('pageerror', e => errs.push(String(e))); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const text = () => pg.evaluate(() => document.body.textContent), tab = async v => { await pg.tap(`nav [data-id=${v}]`); await sleep(250); };
  const cmd = async c => { await tab('command'); await pg.fill('#cq', c); await pg.press('#cq', 'Enter'); await sleep(350); };
  const layout = async name => { const r = await pg.evaluate(() => { const W = innerWidth, over = [...document.querySelectorAll('main *')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > W + 1 || b.left < -1); }).slice(0, 4).map(e => e.tagName + '.' + (e.className || e.id || '') + ' ' + Math.round(e.getBoundingClientRect().right));
      const small = [...document.querySelectorAll('main button, main input:not([type=checkbox]), main select, main textarea')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.height < 40; }).slice(0, 4).map(e => (e.textContent || e.id || e.name).slice(0, 20) + ' h=' + Math.round(e.getBoundingClientRect().height));
      return { sw: document.documentElement.scrollWidth, W, over, small }; });
    ok(r.sw <= r.W && r.over.length === 0, `${name}: no horizontal overflow (scrollWidth ${r.sw} <= ${r.W})${r.over.length ? ' offenders: ' + r.over.join('; ') : ''}`); ok(r.small.length === 0, `${name}: every control is at least 40px tall${r.small.length ? ' (too small: ' + r.small.join('; ') + ')' : ''}`);
    await pg.screenshot({ path: path.join(SHOTS, name.replace(/\W+/g, '_') + '.png'), fullPage: true }); };
  try {
    await pg.goto(base); await pg.waitForSelector('nav'); await pg.evaluate(() => navigator.serviceWorker.ready); await sleep(1500);
    const long = 'Operation Nightfall: an extremely long mission title that has to wrap across many lines without ever producing sideways scrolling';
    await cmd('mission new ' + long + ' priority=high due=2999-01-01'); await cmd('mission new Recon status=active due=2000-01-01 tags=space,base');
    await cmd('task add recon : ' + 'Unbreakable'.repeat(8)); await cmd('task add recon : Second objective'); await cmd('task depend recon : #2 on #1'); await cmd('event add 2000-01-03 09:30 : Briefing @ recon'); await cmd('event add 2999-02-01 : Future review category=review');
    await cmd('omega init'); await cmd('omega milestone add 2000-02-01 : Phase one @ recon'); await cmd('omega milestone done phase'); await cmd('omega decide : Strike at night | fewer defenders'); await cmd('omega hypothesis : They will not expect it | guess');
    await tab('command'); const t0 = await text(); ok(t0.includes('ACK') && !t0.includes('REJECTED'), 'real bundle: the Coluan commands were all accepted (ACK, no REJECTED)'); await layout('Command tab');
    await tab('colossus'); await layout('Colossus list'); ok((await text()).includes('2 missions'), 'dashboard counts 2 missions'); await pg.tap('#mlist .item:has-text("Recon")'); await sleep(300); await layout('Colossus mission detail'); ok((await text()).includes('BLOCKED'), 'blocked objective is visible on the phone-sized screen');
    await tab('omega'); await layout('OMEGA'); ok((await text()).includes('Conflicts (1)'), 'OMEGA shows the milestone/mission conflict'); await tab('timeline'); await layout('Timeline'); ok((await text()).includes('Overdue'), 'timeline shows overdue items');
    await tab('archive'); await layout('Archive'); await tab('settings'); await layout('Setup');
    await tab('colossus'); await pg.tap('[data-act="o:mnew"]'); await sleep(250); await layout('New mission form'); await pg.tap('[data-act="o:mcancel"]'); await tab('timeline'); await pg.tap('[data-act="o:enew"]'); await sleep(250); await layout('New event form'); await pg.tap('[data-act="o:ecancel"]');
    await sleep(1200); const caches = await pg.evaluate(() => caches.keys()); ok(caches.join() === 'brainiac-v3', 'service worker installed and cached the shell');
    offline = true; await ctx.setOffline(true); await pg.reload().catch(() => {}); await pg.waitForSelector('nav', { timeout: 8000 }); await tab('colossus'); await sleep(200);
    ok((await text()).includes('Recon') && (await text()).includes('OFFLINE'), 'OFFLINE reopen shows the saved missions from IndexedDB and the OFFLINE chip');
    await pg.tap('[data-act="o:mnew"]'); await pg.fill('#of-mission-title', 'Created offline'); await pg.tap('#of-mission button[type=submit]'); await pg.waitForSelector('text=Mission created.'); await pg.reload().catch(() => {}); await pg.waitForSelector('nav'); await tab('colossus');
    ok((await text()).includes('Created offline') && (await text()).includes('3 missions'), 'a mission created offline survives an offline reload');
    await tab('command'); await pg.fill('#cq', 'What do we know about nothing'); await pg.press('#cq', 'Enter'); await sleep(300); ok(!(await text()).includes('Something went wrong'), 'archive search still works offline');
    const bundle = fs.readdirSync(path.join(DIST, 'assets')).map(f => fs.readFileSync(path.join(DIST, 'assets', f), 'utf8')).join('\n'); ok(!/gsk_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(bundle), 'no API-key or private-key patterns in the shipped bundle');
    ok(errs.length === 0, 'no console or page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  } catch (e) { ok(false, 'script error: ' + e.message.split('\n')[0]); }
  console.log(bad ? `\n${bad} FAILED` : '\nall passed'); await b.close(); srv.close(); process.exit(bad ? 1 : 0);
});
