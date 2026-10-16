const tests=[], hooks={beforeEach:[],beforeAll:[],afterEach:[]}; let suite=[];
export const describe=(n,f)=>{suite.push(n);f();suite.pop();};
export const it=(n,f)=>tests.push({name:[...suite,n].join(' > '),f});
export const afterEach=f=>hooks.afterEach.push(f), beforeEach=f=>hooks.beforeEach.push(f), beforeAll=f=>hooks.beforeAll.push(f);
const isAsym=x=>x&&x.__asym;
function eq(a,b){ if(isAsym(b)) return b.test(a); if(Object.is(a,b)) return true;
 if(a&&b&&typeof a=='object'&&typeof b=='object'){ if(Array.isArray(a)!==Array.isArray(b)) return false;
  const ka=Object.keys(a).filter(k=>a[k]!==undefined), kb=Object.keys(b).filter(k=>b[k]!==undefined);
  return ka.length===kb.length&&ka.every(k=>eq(a[k],b[k])); } return false; }
function sub(a,b){ if(isAsym(b)) return b.test(a); if(b&&typeof b=='object'&&!Array.isArray(b)){ if(!a||typeof a!='object') return false; return Object.keys(b).every(k=>sub(a[k],b[k])); } if(Array.isArray(b)) return Array.isArray(a)&&a.length===b.length&&b.every((x,i)=>sub(a[i],x)); return eq(a,b); }
const show=v=>{try{return JSON.stringify(v)?.slice(0,200)}catch{return String(v)}};
function matchers(v,neg){ const chk=(ok,msg)=>{ if(neg?ok:!ok) throw new Error((neg?'NOT ':'')+msg); };
 return {
  toBe:e=>chk(Object.is(v,e),`expected ${show(v)} toBe ${show(e)}`),
  toEqual:e=>chk(eq(v,e),`expected ${show(v)} toEqual ${show(e)}`),
  toHaveLength:n=>chk(v?.length===n,`expected length ${v?.length} toBe ${n}`),
  toContain:x=>chk(typeof v=='string'?v.includes(x):Array.isArray(v)&&v.includes(x),`expected ${show(v)} toContain ${show(x)}`),
  toMatch:r=>chk(r instanceof RegExp?r.test(v):String(v).includes(r),`expected ${show(v)} toMatch ${r}`),
  toMatchObject:e=>chk(sub(v,e),`expected ${show(v)} toMatchObject ${show(e)}`),
  toBeUndefined:()=>chk(v===undefined,`expected ${show(v)} undefined`),
  toBeDefined:()=>chk(v!==undefined,`expected a defined value`),
  toBeNull:()=>chk(v===null,`expected ${show(v)} null`),
  toBeTruthy:()=>chk(!!v,`expected truthy ${show(v)}`),
  toBeGreaterThan:n=>chk(v>n,`expected ${v} > ${n}`), toBeGreaterThanOrEqual:n=>chk(v>=n,`expected ${v} >= ${n}`), toBeLessThanOrEqual:n=>chk(v<=n,`expected ${v} <= ${n}`), toBeLessThan:n=>chk(v<n,`expected ${v} < ${n}`),
  toHaveBeenCalledTimes:n=>chk(v.mock.calls.length===n,`expected ${v.mock.calls.length} calls toBe ${n}`),
  toHaveBeenCalled:()=>chk(v.mock.calls.length>0,`expected to have been called`),
  toThrow:r=>{ let t=null; try{v()}catch(e){t=e} chk(!!t&&(!r||(r instanceof RegExp?r.test(t.message):t.message.includes(r))),`expected throw ${r}, got ${t&&t.message}`); },
 }; }
export const expect=(v)=>{ const o={...matchers(v,false), not:matchers(v,true),
  rejects:{toThrow:async r=>{let t=null; try{await v}catch(e){t=e} if(!t||(r&&!(r instanceof RegExp?r.test(t.message):t.message.includes(r)))) throw new Error(`expected rejection ${r}, got ${t&&t.message}`);}}}; return o; };
expect.arrayContaining=a=>({__asym:1,test:x=>Array.isArray(x)&&a.every(i=>x.some(y=>eq(y,i)))});
export const vi={fn:(impl=()=>{})=>{const f=(...a)=>{f.mock.calls.push(a);return impl(...a)};f.mock={calls:[]};return f;},
  stubGlobal:(n,v)=>{ if(!(n in vi._orig)) vi._orig[n]=Object.getOwnPropertyDescriptor(globalThis,n); Object.defineProperty(globalThis,n,{value:v,configurable:true,writable:true})}, mocked:x=>x, unstubAllGlobals:()=>{ for(const [n,d] of Object.entries(vi._orig)) { if(d) Object.defineProperty(globalThis,n,d); else delete globalThis[n]; } vi._orig={}; }, _orig:{}};
export async function run(){ const res=[]; for(const h of hooks.beforeAll) await h();
 for(const t of tests){ try{ for(const h of hooks.beforeEach) await h(); await t.f(); res.push({n:t.name,ok:true}); }catch(e){ res.push({n:t.name,ok:false,e:String(e.message||e).slice(0,400)}); } for(const h of hooks.afterEach) await h(); } return res; }
