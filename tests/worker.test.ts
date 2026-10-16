import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../worker/index';
import { call, parseHits, parseAnswer, validWorkerUrl } from '../src/lookup';

const env = { APP_PASSPHRASE: 'pw-123', GROQ_API_KEY: 'gsk_SECRET', ALLOWED_ORIGIN: 'https://me.github.io' };
let n = 0;
const req = (path: string, o: { method?: string; headers?: Record<string, string>; body?: string; ip?: string } = {}) =>
  new Request('https://w.test' + path, { method: o.method ?? 'POST', headers: { Authorization: 'Bearer pw-123', Origin: 'https://me.github.io', 'CF-Connecting-IP': o.ip ?? `9.9.9.${++n}`, ...(o.headers ?? {}) },
    body: (o.method ?? 'POST') === 'GET' ? undefined : (o.body ?? JSON.stringify({ query: 'powerborne' })) });
const run = (r: Request, e: any = env) => worker.fetch(r, e);
const mockFetch = (h: (url: string) => Response | Promise<Response>) => vi.stubGlobal('fetch', vi.fn((u: any) => Promise.resolve(h(String(u)))));
afterEach(() => vi.unstubAllGlobals());

describe('worker security', () => {
  it('requires the passphrase', async () => {
    expect((await run(req('/lookup', { headers: { Authorization: 'Bearer nope' } }))).status).toBe(401);
    expect((await run(req('/lookup', { headers: { Authorization: '' } }))).status).toBe(401);
  });
  it('rejects other origins, answers preflight, and fails closed without a passphrase', async () => {
    expect((await run(req('/lookup', { headers: { Origin: 'https://evil.example' } }))).status).toBe(403);
    const p = await run(req('/lookup', { method: 'OPTIONS' })); expect(p.status).toBe(204); expect(p.headers.get('Access-Control-Allow-Origin')).toBe('https://me.github.io');
    expect((await run(req('/lookup'), { ...env, APP_PASSPHRASE: undefined })).status).toBe(503);
  });
  it('validates bodies', async () => {
    expect((await run(req('/lookup', { body: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await run(req('/lookup', { body: 'not json' }))).status).toBe(400);
    expect((await run(req('/lookup', { body: JSON.stringify({ query: 'a' }) }))).status).toBe(400);
    expect((await run(req('/lookup', { body: JSON.stringify({ query: 'q'.repeat(301) }) }))).status).toBe(400);
    expect((await run(req('/other'))).status).toBe(404);
  });
  it('rate limits per IP, including failed logins', async () => {
    const codes: number[] = []; for (let i = 0; i < 22; i++) codes.push((await run(req('/health', { method: 'GET', ip: '7.7.7.7', headers: { Authorization: 'Bearer bad' } }))).status);
    expect(codes[0]).toBe(401); expect(codes[21]).toBe(429);
  });
  it('health reports AI state without leaking secrets', async () => {
    const r = await run(req('/health', { method: 'GET' })); expect(await r.json()).toEqual({ ok: true, ai: true, stt: true });
    expect(await (await run(req('/health', { method: 'GET' }), { ...env, GROQ_API_KEY: undefined })).json()).toEqual({ ok: true, ai: false, stt: false });
  });
});

describe('worker lookup', () => {
  const mod = { hits: [{ title: 'Powerborne Heroes', description: 'A superhero addon', slug: 'powerborne-heroes', project_type: 'mod' }, { title: 'bad' }] };
  const wiki = { query: { pages: { 2: { title: 'B', extract: 'second', fullurl: 'https://en.wikipedia.org/wiki/B', index: 2 }, 1: { title: 'A', extract: 'first', fullurl: 'https://en.wikipedia.org/wiki/A', index: 1 }, 3: { title: 'Evil', extract: 'x', fullurl: 'http://evil.example/', index: 3 } } } };
  it('merges Modrinth and Wikipedia, drops malformed and non-Wikipedia links', async () => {
    mockFetch(u => new Response(JSON.stringify(u.includes('modrinth') ? mod : wiki)));
    const j: any = await (await run(req('/lookup'))).json();
    expect(j.hits.map((h: any) => h.title)).toEqual(['Powerborne Heroes', 'A', 'B']);
    expect(j.hits[0].url).toBe('https://modrinth.com/mod/powerborne-heroes');
  });
  it('survives one failing source but reports when both fail', async () => {
    mockFetch(u => u.includes('modrinth') ? new Response('x', { status: 500 }) : new Response(JSON.stringify(wiki)));
    expect(((await (await run(req('/lookup'))).json()) as any).hits).toHaveLength(2);
    mockFetch(() => new Response('x', { status: 500 }));
    const r = await run(req('/lookup')); expect(r.status).toBe(502); expect(JSON.stringify(await r.json())).not.toMatch(/gsk_|stack/i);
  });
});

describe('worker ask', () => {
  const groq = (status = 200, body: any = { choices: [{ message: { content: 'Answer text', executed_tools: [{ search_results: { results: [{ title: 'T', url: 'https://a.example/x' }, { title: 'bad', url: 'http://no.example' }] } }] } }] }) =>
    mockFetch(() => new Response(JSON.stringify(body), { status }));
  it('answers with https-only sources and never exposes the key', async () => {
    groq(); const r = await run(req('/ask')); const t = await r.text();
    expect(JSON.parse(t)).toEqual({ answer: 'Answer text', sources: [{ title: 'T', url: 'https://a.example/x' }] }); expect(t).not.toContain('gsk_SECRET');
    expect((vi.mocked(fetch).mock.calls[0][1] as any).headers.Authorization).toBe('Bearer gsk_SECRET');
  });
  it('sends only 3 trimmed context records', async () => {
    groq(); await run(req('/ask', { body: JSON.stringify({ query: 'test', context: Array(6).fill({ name: 'N', kind: 'note', description: 'd'.repeat(500) }) }) }));
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body).messages[1].content as string;
    expect(sent.split('\n- ').length).toBe(4); expect(sent.length).toBeLessThan(1200);
  });
  it('maps failures to friendly errors', async () => {
    expect((await run(req('/ask'), { ...env, GROQ_API_KEY: undefined })).status).toBe(503);
    groq(429, {}); expect((await run(req('/ask'))).status).toBe(429);
    groq(500, {}); const r = await run(req('/ask')); expect(r.status).toBe(502);
    groq(200, { choices: [{ message: { content: '  ' } }] }); expect((await run(req('/ask'))).status).toBe(502);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('boom gsk_SECRET')))); const e = await run(req('/ask')); expect(e.status).toBe(502); expect(await e.text()).not.toContain('gsk_SECRET');
  });
});

describe('client lookup module', () => {
  const cfg = { url: 'https://w.test/', pass: 'pw' };
  it('validates worker URLs and untrusted results', () => {
    expect(validWorkerUrl('https://a.workers.dev')).toBe(true); expect(validWorkerUrl('http://a.com')).toBe(false); expect(validWorkerUrl('javascript:alert(1)')).toBe(false);
    expect(parseHits({ hits: [{ title: 'ok', url: 'https://x.y' }, { title: 'js', url: 'javascript:alert(1)' }, { url: 'https://no-title' }] })).toHaveLength(1);
    expect(() => parseHits({})).toThrow(/unexpected/); expect(() => parseAnswer({ answer: '' })).toThrow();
  });
  it('turns HTTP and network failures into plain messages', async () => {
    const st = (s: number, b: any = {}) => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(b), { status: s }))));
    st(401); await expect(call(cfg, '/lookup', { query: 'x' })).rejects.toThrow(/passphrase/);
    st(429); await expect(call(cfg, '/lookup', { query: 'x' })).rejects.toThrow(/Rate limit/);
    st(403); await expect(call(cfg, '/lookup', { query: 'x' })).rejects.toThrow(/ALLOWED_ORIGIN/);
    st(500); await expect(call(cfg, '/lookup', { query: 'x' })).rejects.toThrow(/had a problem/);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))); await expect(call(cfg, '/lookup', { query: 'x' })).rejects.toThrow(/Could not reach/);
    vi.stubGlobal('fetch', vi.fn((_u: any, i: any) => new Promise((_r, rej) => i.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))))); await expect(call(cfg, '/x', { query: 'x' }, 20)).rejects.toThrow(/timed out/);
  });
  it('makes exactly one request per call (no retry loop)', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))); vi.stubGlobal('fetch', f);
    await call(cfg, '/lookup', { query: 'x' }).catch(() => {}); expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('worker ask: actionable Groq errors', () => {
  it('distinguishes a bad key and a bad model from an outage', async () => {
    const g = (st: number) => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: st }))));
    g(401); expect(((await (await run(req('/ask'))).json()) as any).error).toMatch(/API key/);
    g(404); expect(((await (await run(req('/ask'))).json()) as any).error).toMatch(/model name/);
    g(503); expect(((await (await run(req('/ask'))).json()) as any).error).toMatch(/unavailable/);
  });
});

describe('worker transcribe (Stage 4). Groq is FAKED here and never contacted: this proves our Worker logic, not the live service', () => {
  let k = 0;
  const audio = (o: { type?: string | null; bytes?: number; query?: string; headers?: Record<string, string> } = {}) => new Request('https://w.test/transcribe' + (o.query ?? ''), {
    method: 'POST', body: new Uint8Array(o.bytes ?? 4000),
    headers: { Authorization: 'Bearer pw-123', Origin: 'https://me.github.io', 'CF-Connecting-IP': `8.8.8.${++k}`, ...(o.type === null ? {} : { 'Content-Type': o.type ?? 'audio/mp4' }), ...(o.headers ?? {}) } });
  const groq = (status = 200, body: any = { text: ' hello brainiac ' }) => { const f = vi.fn((_u: any, _o: any) => Promise.resolve(new Response(JSON.stringify(body), { status }))); vi.stubGlobal('fetch', f); return f; };
  it('requires the passphrase and the right origin, and refuses without calling Groq', async () => {
    const f = groq(); expect((await run(audio({ headers: { Authorization: 'Bearer nope' } }))).status).toBe(401); expect((await run(audio({ headers: { Origin: 'https://evil.example' } }))).status).toBe(403); expect(f).not.toHaveBeenCalled();
  });
  it('says 503 when no key is configured', async () => { const f = groq(); expect((await run(audio(), { ...env, GROQ_API_KEY: undefined })).status).toBe(503); expect(f).not.toHaveBeenCalled(); });
  it('rejects unsupported types, empty clips and oversized clips BEFORE contacting Groq', async () => {
    const f = groq(); expect((await run(audio({ type: 'audio/aac' }))).status).toBe(415); expect((await run(audio({ type: null }))).status).toBe(415); expect((await run(audio({ type: 'application/json' }))).status).toBe(415);
    expect((await run(audio({ bytes: 10 }))).status).toBe(400); expect((await run(audio({ bytes: 3_000_001 }))).status).toBe(413); expect(f).not.toHaveBeenCalled();
  });
  it('forwards the clip to Groq as multipart with the secret key kept server-side, and returns only the text', async () => {
    const f = groq(); const r = await run(audio({ query: '?lang=en', bytes: 5000 })); expect(r.status).toBe(200); expect(await r.json()).toEqual({ text: 'hello brainiac' });
    const [url, init] = f.mock.calls[0]; expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions'); expect(init.headers.Authorization).toBe('Bearer gsk_SECRET'); expect(JSON.stringify(init.headers)).not.toContain('pw-123');
    const fd = init.body as FormData; const file = fd.get('file') as File; expect(file.name).toBe('clip.m4a'); expect(file.size).toBe(5000); expect(fd.get('model')).toBe('whisper-large-v3-turbo'); expect(fd.get('language')).toBe('en'); expect(fd.get('response_format')).toBe('json');
    expect(JSON.stringify(await (await (run(audio()))).clone().text())).not.toContain('gsk_SECRET');
  });
  it('handles codec parameters, ignores a malformed language, and honours a model override', async () => {
    const f = groq(); await run(audio({ type: 'audio/webm;codecs=opus', query: '?lang=../../x' }), { ...env, GROQ_STT_MODEL: 'whisper-large-v3' }); const fd = f.mock.calls[0][1].body as FormData;
    expect((fd.get('file') as File).name).toBe('clip.webm'); expect(fd.get('language')).toBeNull(); expect(fd.get('model')).toBe('whisper-large-v3');
  });
  it('turns Groq failures into actionable messages, never leaking the key', async () => {
    const cases: [number, number, RegExp][] = [[429, 429, /rate limit/], [401, 502, /rejected the API key/], [400, 502, /rejected the audio/], [500, 502, /unavailable/]];
    for (const [up, down, re] of cases) { groq(up, { error: { message: 'x gsk_SECRET' } }); const r = await run(audio()); const j: any = await r.json(); expect(r.status).toBe(down); expect(j.error).toMatch(re); expect(JSON.stringify(j)).not.toContain('gsk_SECRET'); }
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('net')))); const r = await run(audio()); expect(r.status).toBe(502); expect(((await r.json()) as any).error).toMatch(/failed or timed out/);
  });
  it('an empty transcript (silence) is returned as empty text, not an error', async () => { groq(200, { text: '' }); expect(await (await run(audio())).json()).toEqual({ text: '' }); });
});
