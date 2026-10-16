// Serves $H (the build dir) and runs compiled test files in real Chromium. See verify.sh.
const {chromium}=require('playwright'); const http=require('http'), fs=require('fs'), path=require('path'); const H=process.env.H;
const srv=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]); const p=path.join(H,u==='/'?'run.html':u);
 if(!fs.existsSync(p)){r.writeHead(404);return r.end();} r.writeHead(200,{'Content-Type':p.endsWith('.js')?'text/javascript':'text/html'}); r.end(fs.readFileSync(p));}).listen(0,async()=>{
 const port=srv.address().port; const b=await chromium.launch(); let bad=0, pass=0;
 for(const f of process.argv.slice(2)){ const ctx=await b.newContext(); const pg=await ctx.newPage(); pg.on('pageerror',e=>console.log('PAGEERR',e.message));
  await pg.goto(`http://localhost:${port}/run.html?f=${f}`); await pg.waitForFunction('window.__done',null,{timeout:120000});
  const res=await pg.evaluate('window.__res'), errs=await pg.evaluate('window.__errs'); console.log(`\n== ${f}.test (real Chromium, shim runner) ==`);
  for(const r of res){ console.log((r.ok?'PASS ':'FAIL ')+r.n+(r.ok?'':'\n     '+r.e)); r.ok?pass++:bad++; }
  if(errs.length) console.log('uncaught page errors:',errs.slice(0,5)); await ctx.close(); }
 console.log(`\n${pass} passed, ${bad} failed`); await b.close(); srv.close(); process.exit(bad?1:0); });
