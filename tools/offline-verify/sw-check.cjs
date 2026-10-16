// Service-worker check in REAL CHROMIUM (not WebKit/Safari). Simulates a Vite-style deploy (hashed assets) and verifies offline behaviour of public/sw.js.
// Usage: NODE_PATH=$(npm root -g) node tools/offline-verify/sw-check.cjs      (needs global Playwright + Chromium)
const {chromium}=require('playwright'); const http=require('http'), fs=require('fs'), path=require('path'), os=require('os');
const ROOT=path.resolve(__dirname,'../..'), NEW_SW=process.env.SW_UNDER_TEST||path.join(ROOT,'public/sw.js'), OLD_SW=path.join(__dirname,'sw-previous-release.js');
const T=fs.mkdtempSync(path.join(os.tmpdir(),'swcheck-'));
for(const v of ['v1','v2','v3']){ const d=path.join(T,v); fs.mkdirSync(path.join(d,'assets'),{recursive:true});
  for(const f of ['manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png']) fs.copyFileSync(path.join(ROOT,'public',f),path.join(d,f));
  fs.writeFileSync(path.join(d,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="manifest" href="./manifest.webmanifest"><link rel="apple-touch-icon" href="./icon-180.png"><script type="module" crossorigin src="./assets/app-${v}.js"></script><link rel="stylesheet" crossorigin href="./assets/app-${v}.css"></head><body><div id="app">LOADING</div><script>navigator.serviceWorker.register('./sw.js')</script></body></html>`);
  fs.writeFileSync(path.join(d,`assets/app-${v}.js`),`document.getElementById('app').textContent='APP ${v}';`); fs.writeFileSync(path.join(d,`assets/app-${v}.css`),'body{margin:0}'); }
let cur='v1', offline=false, sw=NEW_SW, failPaths=new Set();
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json'};
const srv=http.createServer((q,r)=>{ if(offline){q.socket.destroy();return;} let u=decodeURIComponent(q.url.split('?')[0]); if(u==='/')u='/index.html';
  if(failPaths.has(u)){r.writeHead(500);return r.end('boom');} const p=u==='/sw.js'?sw:path.join(T,cur,u); if(!fs.existsSync(p)){r.writeHead(404);return r.end('nope');}
  r.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream','Cache-Control':'no-cache'}); r.end(fs.readFileSync(p)); });
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let bad=0, n=0; const ok=(c,m)=>{n++;console.log((c?'PASS ':'FAIL ')+m); if(!c)bad++;};
srv.listen(0,async()=>{ const base=`http://localhost:${srv.address().port}/`; const b=await chromium.launch();
  const fresh=async()=>{ cur='v1'; offline=false; sw=NEW_SW; failPaths=new Set(); const ctx=await b.newContext(); const pg=await ctx.newPage(); return {ctx,pg,text:()=>pg.evaluate(()=>document.getElementById('app')?.textContent)}; };
  const off=async(pg)=>{ offline=true; await pg.reload().catch(()=>{}); await sleep(600); }, on=async(pg)=>{ offline=false; await pg.reload(); await sleep(1500); };
  { const {ctx,pg,text}=await fresh(); await pg.goto(base); await pg.evaluate(()=>navigator.serviceWorker.ready); await sleep(1500);
    ok(await text()==='APP v1','online first load shows v1'); await off(pg); ok(await text()==='APP v1','S1 first-time offline reopen works');
    await pg.evaluate(()=>0).catch(()=>{}); offline=false; cur='v2'; await on(pg); await off(pg); ok(await text()==='APP v2','S2 after a deploy, then offline: opens and shows the NEW version');
    const nf=await pg.evaluate(async()=>{ try{ const r=await fetch('./assets/missing.png'); return r.status+' '+r.headers.get('content-type'); }catch(e){ return 'network-error'; } }); ok(nf==='network-error','S3 uncached file offline is a network error, not HTML (got: '+nf+')'); await ctx.close(); }
  { const {ctx,pg,text}=await fresh(); await pg.goto(base); await pg.evaluate(()=>navigator.serviceWorker.ready); await sleep(1500);
    cur='v3'; failPaths.add('/assets/app-v3.js'); await on(pg); await off(pg); ok(await text()==='APP v1','S4 a deploy whose new file fails to download leaves the old, complete version working offline (shows: '+await text()+')'); await ctx.close(); }
  { const {ctx,pg,text}=await fresh(); sw=OLD_SW; await pg.goto(base); await pg.evaluate(()=>navigator.serviceWorker.ready); await sleep(1500);
    const before=await pg.evaluate(()=>caches.keys()); sw=NEW_SW; await on(pg); let after=await pg.evaluate(()=>caches.keys()); for(let i=0;i<20&&after.join()!=='brainiac-v3';i++){ await sleep(500); after=await pg.evaluate(()=>caches.keys()); } // poll up to 10s: activation timing varies (a fixed 1.5s sleep made this check flaky)
    ok(before.join()==='brainiac-v2'&&after.join()==='brainiac-v3','S5 upgrading from the previously released sw.js: old cache removed, new one in place ('+before+' -> '+after+')');
    await off(pg); ok(await text()==='APP v1','S5b the upgraded app opens offline'); await ctx.close(); }
  console.log(`\n${n-bad} passed, ${bad} failed`); await b.close(); srv.close(); fs.rmSync(T,{recursive:true,force:true}); process.exit(bad?1:0); });
