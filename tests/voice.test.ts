import { it, expect, vi, afterEach } from 'vitest';
import * as V from '../src/voice';

// ---- controllable fakes: these stand in for browser APIs and let tests force each failure mode. They are NOT a real iPhone. ----
type Voice = { name: string; lang: string; voiceURI: string; localService: boolean; default: boolean };
const voice = (name: string, lang: string, o: Partial<Voice> = {}): SpeechSynthesisVoice => ({ name, lang, voiceURI: 'uri:' + name, localService: true, default: false, ...o }) as SpeechSynthesisVoice;
class FakeUtterance { text: string; voice: any = null; lang = ''; rate = 1; pitch = 1; onstart: any; onend: any; onerror: any; constructor(t: string) { this.text = t; } }
function fakeSynth(mode: 'normal' | 'silent' | 'error' | 'start-only' | 'throw', voices: SpeechSynthesisVoice[] = []) {
  const l: Record<string, Function[]> = {}; let list = voices; const spoken: FakeUtterance[] = [];
  const s: any = { cancel: vi.fn(), spoken, getVoices: () => list, setVoices: (v: SpeechSynthesisVoice[]) => { list = v; (l.voiceschanged ?? []).forEach(f => f()); },
    addEventListener: (n: string, f: Function) => { (l[n] ??= []).push(f); }, removeEventListener: (n: string, f: Function) => { l[n] = (l[n] ?? []).filter(x => x !== f); },
    speak: (u: FakeUtterance) => { if (mode === 'throw') throw new Error('boom'); spoken.push(u); setTimeout(() => { if (mode === 'normal') { u.onstart?.(); setTimeout(() => u.onend?.(), 5); } else if (mode === 'start-only') u.onstart?.(); else if (mode === 'error') u.onerror?.({ error: 'synthesis-failed' }); }, 5); } };
  return s as SpeechSynthesis & { cancel: any; spoken: FakeUtterance[]; setVoices(v: SpeechSynthesisVoice[]): void };
}
const env = (o: Partial<V.Env> = {}): V.Env => ({ secure: true, standalone: false, ua: 'test', lang: 'en-GB', ...o });

afterEach(() => vi.unstubAllGlobals());

it('parseState: ignores junk, clamps rate/pitch, never throws', () => {
  expect(V.parseState(undefined).prefs).toEqual(V.DEFAULT_PREFS); expect(V.parseState('not json').prefs).toEqual(V.DEFAULT_PREFS);
  const s = V.parseState(JSON.stringify({ prefs: { voiceURI: 'x', name: 'Daniel', lang: 'en-GB', rate: 99, pitch: -4 }, results: { tts: { outcome: 'ended', ts: 't', ctx: 'browser tab', heard: true }, rec: { nope: 1 }, evil: { outcome: 'x' } } }));
  expect(s.prefs.rate).toBe(2); expect(s.prefs.pitch).toBe(0); expect(s.results.tts?.heard).toBe(true); expect(s.results.rec).toBeUndefined(); expect(Object.keys(s.results)).toEqual(['tts']);
});

it('loadVoices: returns at once when voices exist, waits for voiceschanged, and returns [] honestly after the timeout', async () => {
  const have = fakeSynth('normal', [voice('A', 'en-US')]); expect((await V.loadVoices(have, 500)).map(v => v.name)).toEqual(['A']);
  const late = fakeSynth('normal', []); const p = V.loadVoices(late, 2000); setTimeout(() => late.setVoices([voice('Late', 'en-GB')]), 50); expect((await p).map(v => v.name)).toEqual(['Late']);
  const none = fakeSynth('normal', []); const t = Date.now(); expect(await V.loadVoices(none, 300)).toEqual([]); expect(Date.now() - t).toBeGreaterThanOrEqual(280);
  expect(await V.loadVoices(undefined)).toEqual([]);
});

it('voiceInfo exposes the metadata the browser really provides (name, lang, URI, local/network, default)', () => {
  expect(V.voiceInfo(voice('Daniel', 'en-GB', { default: true, localService: false }))).toEqual({ name: 'Daniel', lang: 'en-GB', voiceURI: 'uri:Daniel', localService: false, default: true });
});

it('resolveVoice: exact, by name, same language (prefers on-device), device default, engine default, none chosen', () => {
  const vs = [voice('Alex', 'en-US', { default: true }), voice('Daniel', 'en-GB'), voice('Online Brit', 'en-GB', { localService: false }), voice('Amelie', 'fr-CA')];
  const P = (o: Partial<V.Prefs>): V.Prefs => ({ ...V.DEFAULT_PREFS, ...o });
  expect(V.resolveVoice(P({ voiceURI: 'uri:Daniel', name: 'Daniel', lang: 'en-GB' }), vs)).toMatchObject({ match: 'exact', note: '' });
  expect(V.resolveVoice(P({ voiceURI: 'old-id', name: 'Daniel', lang: 'en-GB' }), vs)).toMatchObject({ match: 'name' });
  const l = V.resolveVoice(P({ voiceURI: 'gone', name: 'Oliver', lang: 'en-GB' }), vs); expect(l.match).toBe('language'); expect(l.voice?.name).toBe('Daniel'); expect(l.note).toContain('Oliver'); expect(l.note).toContain('not available');
  const d = V.resolveVoice(P({ voiceURI: 'gone', name: 'Kyoko', lang: 'ja-JP' }), vs); expect(d.match).toBe('default'); expect(d.voice?.name).toBe('Alex');
  expect(V.resolveVoice(P({ name: 'X', voiceURI: 'x' }), [])).toMatchObject({ voice: null, match: 'engine' });
  expect(V.resolveVoice(V.DEFAULT_PREFS, vs)).toMatchObject({ match: 'none-chosen' });
});

it('speak: every outcome is reported from events, not assumed', async () => {
  const E = (m: any) => env({ synth: fakeSynth(m), Utterance: FakeUtterance as any });
  expect((await V.speak(E('normal'), 'hi', { rate: 1, pitch: 1 })).outcome).toBe('ended');
  const so = await V.speak(E('start-only'), 'hi', { rate: 1, pitch: 1, endTimeoutMs: 80 }); expect(so.outcome).toBe('started-no-end'); expect(so.events.some(e => e.startsWith('start'))).toBe(true);
  const si = await V.speak(E('silent'), 'hi', { rate: 1, pitch: 1, startTimeoutMs: 80 }); expect(si.outcome).toBe('no-start');
  const er = await V.speak(E('error'), 'hi', { rate: 1, pitch: 1 }); expect(er).toMatchObject({ outcome: 'error', error: 'synthesis-failed' });
  expect((await V.speak(E('throw'), 'hi', { rate: 1, pitch: 1 })).outcome).toBe('error');
  expect((await V.speak(env(), 'hi', { rate: 1, pitch: 1 })).outcome).toBe('unsupported');
});
it('speak: cancels stale speech first, applies voice/lang/rate/pitch, clamps silly values, trims long text', async () => {
  const s = fakeSynth('normal'); const v = voice('Daniel', 'en-GB'); await V.speak(env({ synth: s, Utterance: FakeUtterance as any }), 'x'.repeat(900), { voice: v, rate: 9, pitch: -1 });
  expect(s.cancel).toHaveBeenCalled(); const u = s.spoken[0]; expect(u.voice).toBe(v); expect(u.lang).toBe('en-GB'); expect(u.rate).toBe(2); expect(u.pitch).toBe(0); expect(u.text.length).toBe(400);
});

const stream = (live = true) => { const stop = vi.fn(); const track = { readyState: live ? 'live' : 'ended', label: 'Fake Mic', stop }; return { stop, s: { getAudioTracks: () => [track], getTracks: () => [track] } as any }; };
it('testMic: granted only when a live track opens, and the mic is always released', async () => {
  const a = stream(); expect(await V.testMic(env({ getUserMedia: async () => a.s }))).toMatchObject({ outcome: 'granted', label: 'Fake Mic' }); expect(a.stop).toHaveBeenCalled();
  const b = stream(false); expect((await V.testMic(env({ getUserMedia: async () => b.s }))).outcome).toBe('error'); expect(b.stop).toHaveBeenCalled();
  const rej = (name: string) => env({ getUserMedia: async () => { throw Object.assign(new Error('x'), { name }); } });
  expect((await V.testMic(rej('NotAllowedError'))).outcome).toBe('denied'); expect((await V.testMic(rej('NotFoundError'))).outcome).toBe('no-device');
  expect((await V.testMic(rej('NotReadableError'))).outcome).toBe('busy'); expect((await V.testMic(rej('WeirdError'))).outcome).toBe('error');
  expect((await V.testMic(env({ secure: false, getUserMedia: async () => a.s }))).outcome).toBe('insecure'); expect((await V.testMic(env())).outcome).toBe('unsupported');
});

// ---- recognition: scripted sessions ----
type Step = [number, string, any?];
function fakeRecognition(steps: Step[], opt: { throwOnStart?: boolean } = {}) {
  return class { lang = ''; continuous = false; interimResults = false; maxAlternatives = 1; [k: string]: any; abort = vi.fn(); stop = vi.fn(() => { setTimeout(() => this.onend?.(), 5); });
    start() { if (opt.throwOnStart) throw Object.assign(new Error('already started'), { name: 'InvalidStateError' }); for (const [ms, n, a] of steps) setTimeout(() => this['on' + n]?.(a), ms); } } as any;
}
const res = (text: string, isFinal: boolean, confidence = 0.9) => ({ results: [Object.assign([{ transcript: text, confidence }], { isFinal })] });
it('recognition: a session that returns text is the ONLY thing reported as transcribed', async () => {
  const R = fakeRecognition([[5, 'start'], [10, 'audiostart'], [15, 'speechstart'], [20, 'result', res('open the archive', false)], [30, 'result', res('open the archive', true)], [40, 'end']]);
  const r = await V.startRecognition(env({ Recognition: R }), { lang: 'en-GB' }).result; expect(r).toMatchObject({ outcome: 'transcribed', transcript: 'open the archive', confidence: 0.9 });
  expect(r.events.map(e => e.split('@')[0])).toEqual(['start() called', 'start', 'audiostart', 'speechstart', 'result(interim)', 'result(final)', 'end']);
});
it('recognition: iOS Home Screen case, API exists, start() is called, nothing ever fires, so it is reported as no-start (not working)', async () => {
  const R = fakeRecognition([]); const t = Date.now(); const r = await V.startRecognition(env({ Recognition: R }), { lang: 'en-GB', startTimeoutMs: 120 }).result;
  expect(r.outcome).toBe('no-start'); expect(Date.now() - t).toBeLessThan(1000); expect(r.transcript).toBe('');
});
it('recognition: permission/service refusal is "blocked"; no-speech, other errors and empty ends are distinguished', async () => {
  const run = (steps: Step[]) => V.startRecognition(env({ Recognition: fakeRecognition(steps) }), { lang: 'en-GB' }).result;
  expect(await run([[5, 'error', { error: 'service-not-allowed' }], [10, 'end']])).toMatchObject({ outcome: 'blocked', error: 'service-not-allowed' });
  expect((await run([[5, 'error', { error: 'not-allowed' }], [10, 'end']])).outcome).toBe('blocked');
  expect((await run([[5, 'start'], [10, 'audiostart'], [20, 'error', { error: 'no-speech' }], [25, 'end']])).outcome).toBe('no-speech');
  expect((await run([[5, 'start'], [10, 'error', { error: 'network' }], [15, 'end']]))).toMatchObject({ outcome: 'error', error: 'network' });
  expect((await run([[5, 'start'], [10, 'end']])).outcome).toBe('ended-empty');
  expect((await run([[5, 'start'], [10, 'error', { error: 'aborted' }]])).outcome).toBe('error'); // no 'end' event ever arrives: must still finish
});
it('recognition: start() throwing, missing API, and Stop all end cleanly', async () => {
  expect((await V.startRecognition(env({ Recognition: fakeRecognition([], { throwOnStart: true }) }), { lang: 'en' }).result).outcome).toBe('start-threw');
  expect((await V.startRecognition(env(), { lang: 'en' }).result).outcome).toBe('unsupported');
  const R = fakeRecognition([[5, 'start'], [10, 'audiostart']]); const s = V.startRecognition(env({ Recognition: R }), { lang: 'en' }); setTimeout(() => s.stop(), 40);
  expect((await s.result).outcome).toBe('ended-empty');
});

// ---- clip recording ----
function fakeRecorder(o: { data?: number; mime?: string; supported?: string[] } = {}) {
  return class { static isTypeSupported = (m: string) => (o.supported ?? ['audio/mp4']).includes(m); state = 'inactive'; mimeType: string; [k: string]: any;
    constructor(_s: any, opt?: any) { this.mimeType = opt?.mimeType ?? o.mime ?? ''; }
    start() { this.state = 'recording'; } stop() { this.state = 'inactive'; setTimeout(() => { if (o.data !== 0) this.ondataavailable?.({ data: new Blob([new Uint8Array(o.data ?? 4000)]) }); this.onstop?.(); }, 5); } } as any;
}
it('pickMime prefers audio/mp4 (what iOS 15 produces), then webm, and says "" when nothing is supported', () => {
  expect(V.pickMime(fakeRecorder({ supported: ['audio/mp4', 'audio/webm'] }))).toBe('audio/mp4'); expect(V.pickMime(fakeRecorder({ supported: ['audio/webm'] }))).toBe('audio/webm'); expect(V.pickMime(fakeRecorder({ supported: [] }))).toBe(''); expect(V.pickMime(undefined)).toBe('');
});
it('startClip: records, then ALWAYS releases the microphone (stop, time limit, errors)', async () => {
  const a = stream(); const s = V.startClip(env({ getUserMedia: async () => a.s, Recorder: fakeRecorder() }), { maxMs: 5000 }); setTimeout(() => s.stop(), 30);
  const r = await s.result; expect(r).toMatchObject({ outcome: 'recorded', mime: 'audio/mp4', bytes: 4000 }); expect(r.blob?.size).toBe(4000); expect(a.stop).toHaveBeenCalled();
  const b = stream(); const lim = await V.startClip(env({ getUserMedia: async () => b.s, Recorder: fakeRecorder() }), { maxMs: 60 }).result; expect(lim.outcome).toBe('recorded'); expect(b.stop).toHaveBeenCalled();
  const c = stream(); expect((await V.startClip(env({ getUserMedia: async () => c.s, Recorder: fakeRecorder({ data: 0 }) }), { maxMs: 40 }).result).outcome).toBe('empty'); expect(c.stop).toHaveBeenCalled();
  const d = stream(); expect((await V.startClip(env({ getUserMedia: async () => d.s, Recorder: fakeRecorder({ data: V.MAX_CLIP_BYTES + 10 }) }), { maxMs: 40 }).result).outcome).toBe('too-large');
  expect((await V.startClip(env({ getUserMedia: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); }, Recorder: fakeRecorder() })).result).outcome).toBe('denied');
  expect((await V.startClip(env({ getUserMedia: async () => a.s })).result).outcome).toBe('unsupported'); expect((await V.startClip(env({ secure: false, getUserMedia: async () => a.s, Recorder: fakeRecorder() })).result).outcome).toBe('insecure');
});
it('startClip: pressing Stop before the microphone has opened still releases it', async () => {
  const a = stream(); const s = V.startClip(env({ getUserMedia: () => new Promise(r => setTimeout(() => r(a.s), 40)), Recorder: fakeRecorder() })); s.stop();
  expect((await s.result).outcome).toBe('empty'); expect(a.stop).toHaveBeenCalled();
});

// ---- backend ----
const cfg = { url: 'https://w.example.workers.dev/', pass: 'pw' };
it('backendState: each situation is its own state, and a key is only ever "configured", never "working"', async () => {
  expect((await V.backendState(null, true)).state).toBe('no-worker'); expect((await V.backendState(cfg, false)).state).toBe('offline');
  expect((await V.backendState(cfg, true, async () => ({ ok: true, ai: true }))).state).toBe('worker-old');
  expect((await V.backendState(cfg, true, async () => ({ ok: true, ai: true, stt: false }))).state).toBe('no-key');
  expect((await V.backendState(cfg, true, async () => ({ ok: true, ai: true, stt: true }))).state).toBe('configured');
  expect(await V.backendState(cfg, true, async () => { throw new Error('Could not reach'); })).toMatchObject({ state: 'unreachable', detail: 'Could not reach' });
});
const stubFetch = (status: number, body: any) => { const f = vi.fn(async (_u: string, _o: any) => ({ ok: status < 400, status, json: async () => body })); vi.stubGlobal('fetch', f); return f; };
it('transcribe: posts the raw clip with the passphrase, strips codecs from the type, returns text', async () => {
  const f = stubFetch(200, { text: ' hello world ' }); const blob = new Blob([new Uint8Array(10)], { type: 'audio/webm;codecs=opus' });
  expect(await V.transcribe(cfg, blob, 'audio/webm;codecs=opus', 'en-GB')).toEqual({ text: 'hello world' });
  const [u, o] = f.mock.calls[0]; expect(u).toBe('https://w.example.workers.dev/transcribe?lang=en'); expect(o.headers).toMatchObject({ Authorization: 'Bearer pw', 'Content-Type': 'audio/webm' }); expect(o.body).toBe(blob);
});
it('transcribe: friendly errors for each failure, and it refuses formats the service cannot read before uploading anything', async () => {
  const b = new Blob([new Uint8Array(10)]); const bad = async (st: number, body: any = {}) => { stubFetch(st, body); return V.transcribe(cfg, b, 'audio/mp4').then(() => 'OK', e => (e as Error).message); };
  expect(await bad(401)).toContain('Wrong passphrase'); expect(await bad(404)).toContain('Redeploy'); expect(await bad(413)).toContain('too large'); expect(await bad(429, { error: 'Slow down' })).toBe('Slow down');
  expect(await bad(502, { error: 'Groq says no' })).toBe('Groq says no'); expect(await bad(500)).toContain('had a problem');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('x'); })); expect(await V.transcribe(cfg, b, 'audio/mp4').catch(e => e.message)).toContain('Could not reach');
  const f = stubFetch(200, { text: 'x' }); await expect(V.transcribe(cfg, b, 'audio/aac')).rejects.toThrow('cannot read'); expect(f).not.toHaveBeenCalled();
});

// ---- the core honesty rule ----
it('HONESTY: with no real session on record, NO capability ever shows an OK tone or the words CONFIRMED/WORKING', () => {
  const full = env({ synth: fakeSynth('normal', [voice('A', 'en')]), Utterance: FakeUtterance as any, Recognition: fakeRecognition([]), getUserMedia: async () => stream().s, Recorder: fakeRecorder() });
  const all = [V.ttsStatus(full, 5), V.recStatus(full), V.micStatus(full), V.clipStatus(full), ...(['no-worker', 'offline', 'unreachable', 'worker-old', 'no-key', 'configured', 'unchecked'] as const).map(state => V.sttStatus({ state }))];
  for (const s of all) { expect(s.tone).not.toBe('ok'); expect(s.text).not.toMatch(/CONFIRMED|WORKING|WORKS/); }
  expect(V.ttsStatus(full, 5).text).toContain('UNTESTED'); expect(V.recStatus(full).text).toContain('UNTESTED'); expect(V.sttStatus({ state: 'configured' }).text).toContain('UNPROVEN');
});
it('HONESTY: a failed or merely "finished" session never upgrades to OK; only the specific real evidence does', () => {
  const full = env({ synth: fakeSynth('normal'), Utterance: FakeUtterance as any, Recognition: fakeRecognition([]), getUserMedia: async () => stream().s, Recorder: fakeRecorder() });
  const S = (outcome: string, extra: Partial<V.Saved> = {}): V.Saved => ({ outcome, ts: new Date().toISOString(), ctx: 'installed app', ...extra });
  expect(V.ttsStatus(full, 3, S('ended')).tone).toBe('warn'); expect(V.ttsStatus(full, 3, S('ended', { heard: true })).tone).toBe('ok'); expect(V.ttsStatus(full, 3, S('ended', { heard: false })).tone).toBe('bad');
  for (const o of ['blocked', 'no-start', 'error', 'start-threw']) expect(V.recStatus(full, S(o)).tone).toBe('bad');
  for (const o of ['no-speech', 'ended-empty']) expect(V.recStatus(full, S(o)).tone).toBe('warn'); expect(V.recStatus(full, S('transcribed')).tone).toBe('ok');
  expect(V.recStatus(full, S('no-start')).detail).toContain('Home Screen'); expect(V.micStatus(full, S('denied')).tone).toBe('bad'); expect(V.micStatus(full, S('granted')).tone).toBe('ok');
  expect(V.sttStatus({ state: 'configured' }, S('failed', { detail: 'rate limit' })).tone).toBe('warn'); expect(V.sttStatus({ state: 'configured' }, S('transcribed')).tone).toBe('ok');
  // each capability is judged separately: a good microphone does not make recognition look good
  expect(V.recStatus(full, undefined).tone).toBe('warn'); expect(V.micStatus(full, S('granted')).tone).toBe('ok');
});
it('statuses say NOT AVAILABLE when the API is missing, and the microphone says why when the page is not HTTPS', () => {
  const none = env(); expect(V.ttsStatus(none, 0).text).toBe('NOT AVAILABLE'); expect(V.recStatus(none).text).toBe('NOT AVAILABLE'); expect(V.clipStatus(none).text).toBe('NOT AVAILABLE');
  expect(V.micStatus(env({ secure: false })).text).toContain('NOT HTTPS'); expect(V.iosVersion('Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit')).toBe('iOS 15.8'); expect(V.iosVersion('Mozilla/5.0 (X11; Linux x86_64)')).toBe('');
});
