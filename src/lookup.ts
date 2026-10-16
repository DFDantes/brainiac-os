export interface Hit { title: string; summary: string; url: string; source: string }
export interface Cfg { url: string; pass: string }
export interface Answer { answer: string; sources: { title: string; url: string }[] }
const s = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
const https = (u: string) => /^https:\/\//.test(u);
const BAD = 'The lookup service sent an unexpected reply.';

export function validWorkerUrl(u: string) { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && x.hostname === 'localhost'); } catch { return false; } }
/** Validates untrusted lookup results; keeps only https links. */
export function parseHits(j: any): Hit[] {
  if (!j || !Array.isArray(j.hits)) throw new Error(BAD);
  return j.hits.slice(0, 12).map((h: any) => ({ title: s(h?.title, 200), summary: s(h?.summary, 500), url: s(h?.url, 500), source: s(h?.source, 30) })).filter((h: Hit) => h.title && https(h.url));
}
export function parseAnswer(j: any): Answer {
  const answer = s(j?.answer, 4000).trim(); if (!answer) throw new Error(BAD);
  return { answer, sources: (Array.isArray(j.sources) ? j.sources : []).slice(0, 8).map((x: any) => ({ title: s(x?.title, 150), url: s(x?.url, 500) })).filter((x: { url: string }) => https(x.url)) };
}
function friendly(status: number, msg: string) {
  if (status === 401) return 'Wrong passphrase. Check Setup > Online lookup.';
  if (status === 403) return 'The Worker rejected this website. Check ALLOWED_ORIGIN in worker/wrangler.toml.';
  if (status === 429) return msg || 'Rate limit reached. Wait a minute and try again.';
  if ([400, 413, 502, 503].includes(status) && msg) return msg;
  return 'The lookup service had a problem. Try again later.';
}
/** One request, one timeout, no automatic retry. Lookups only read; nothing is saved without confirmation. */
export async function call(cfg: Cfg, path: string, body?: unknown, ms = 30000): Promise<any> {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(cfg.url.replace(/\/+$/, '') + path, { method: body ? 'POST' : 'GET', signal: c.signal,
      headers: { Authorization: 'Bearer ' + cfg.pass, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(friendly(r.status, s(j?.error, 200)));
    return j;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('The lookup timed out. Try again.');
    if (e instanceof TypeError) throw new Error('Could not reach the lookup service. Check your connection and the Worker address.');
    throw e;
  } finally { clearTimeout(t); }
}
