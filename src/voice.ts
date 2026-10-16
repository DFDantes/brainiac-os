// Voice engine (Stage 4). Pure logic with an injectable environment so it can be tested with fakes.
// RULE: nothing here reports "working" because an API merely exists. A capability is only "confirmed" after a real session
// (speech heard by the user, text produced by a recognition session, a clip recorded, a clip transcribed).
import type { Cfg } from './lookup';
import { call } from './lookup';

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';
export interface Status { text: string; tone: Tone; detail?: string }

/** Everything the engine touches in the browser, so tests can fake it. */
export interface Env {
  synth?: SpeechSynthesis; Utterance?: typeof SpeechSynthesisUtterance;
  Recognition?: any; // SpeechRecognition or webkitSpeechRecognition constructor (not in TypeScript's DOM lib)
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>; Recorder?: typeof MediaRecorder;
  secure: boolean; standalone: boolean; ua: string; lang: string;
}
export function browserEnv(w: any = window): Env {
  const nav = w.navigator ?? {};
  return {
    synth: w.speechSynthesis, Utterance: w.SpeechSynthesisUtterance, Recognition: w.SpeechRecognition || w.webkitSpeechRecognition,
    getUserMedia: nav.mediaDevices?.getUserMedia ? (c: MediaStreamConstraints) => nav.mediaDevices.getUserMedia(c) : undefined, Recorder: w.MediaRecorder,
    secure: w.isSecureContext !== false, standalone: nav.standalone === true || !!w.matchMedia?.('(display-mode: standalone)').matches,
    ua: String(nav.userAgent ?? ''), lang: String(nav.language ?? 'en'),
  };
}
export const contextName = (e: Env) => (e.standalone ? 'installed app' : 'browser tab');
/** "iOS 15.8" from a Safari user agent, or '' when it is not iOS. */
export function iosVersion(ua: string): string { const m = /OS (\d+)[_.](\d+)/.exec(ua); return /iPhone|iPad|iPod/.test(ua) && m ? `iOS ${m[1]}.${m[2]}` : ''; }

const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === 'number' && isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d);
const short = (v: unknown, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');

// ---------- Saved preferences and last real results (stored on this device only, never in backups) ----------
export interface Prefs { voiceURI: string; name: string; lang: string; rate: number; pitch: number }
export const DEFAULT_PREFS: Prefs = { voiceURI: '', name: '', lang: '', rate: 1, pitch: 1 };
export interface Saved { outcome: string; ts: string; ctx: string; detail?: string; heard?: boolean }
export type CapKey = 'tts' | 'rec' | 'mic' | 'clip' | 'stt';
export interface State { prefs: Prefs; results: Partial<Record<CapKey, Saved>> }
const KEYS: CapKey[] = ['tts', 'rec', 'mic', 'clip', 'stt'];
export function parseState(raw: string | undefined): State {
  const out: State = { prefs: { ...DEFAULT_PREFS }, results: {} };
  if (!raw) return out;
  try {
    const j = JSON.parse(raw), p = j?.prefs ?? {};
    out.prefs = { voiceURI: short(p.voiceURI), name: short(p.name), lang: short(p.lang, 35), rate: clamp(p.rate, 0.5, 2, 1), pitch: clamp(p.pitch, 0, 2, 1) };
    for (const k of KEYS) { const s = j?.results?.[k]; if (s && typeof s.outcome === 'string') out.results[k] = { outcome: short(s.outcome, 40), ts: short(s.ts, 40), ctx: short(s.ctx, 30), detail: short(s.detail, 300) || undefined, heard: typeof s.heard === 'boolean' ? s.heard : undefined }; }
  } catch { /* damaged saved state is ignored, never fatal */ }
  return out;
}

// ---------- 1. Voices ----------
export interface VoiceInfo { name: string; lang: string; voiceURI: string; localService: boolean; default: boolean }
export const voiceInfo = (v: SpeechSynthesisVoice): VoiceInfo => ({ name: String(v.name), lang: String(v.lang), voiceURI: String(v.voiceURI), localService: !!v.localService, default: !!v.default });
const getVoices = (s: SpeechSynthesis): SpeechSynthesisVoice[] => { try { return Array.from(s.getVoices?.() ?? []); } catch { return []; } };

/** Browsers fill the voice list asynchronously (and iOS sometimes late). Resolves as soon as voices exist, or after waitMs with whatever there is (possibly none). */
export function loadVoices(synth: SpeechSynthesis | undefined, waitMs = 2500): Promise<SpeechSynthesisVoice[]> {
  if (!synth) return Promise.resolve([]);
  return new Promise(resolve => {
    let done = false, poll: any, to: any;
    const finish = () => { if (done) return; done = true; clearInterval(poll); clearTimeout(to); try { synth.removeEventListener?.('voiceschanged', check); } catch { /* ignore */ } resolve(getVoices(synth)); };
    const check = () => { if (getVoices(synth).length) finish(); };
    poll = setInterval(check, 150); to = setTimeout(finish, waitMs);
    try { synth.addEventListener?.('voiceschanged', check); } catch { /* ignore */ }
    check();
  });
}

export type Match = 'none-chosen' | 'exact' | 'name' | 'language' | 'default' | 'engine';
const primary = (l: string) => l.split(/[-_]/)[0].toLowerCase();
/** Graceful fallback: the chosen voice if present, else same name, else same language, else the device default, else the engine's own default. Never throws. */
export function resolveVoice(p: Prefs, voices: SpeechSynthesisVoice[]): { voice: SpeechSynthesisVoice | null; match: Match; note: string } {
  const chosen = !!(p.voiceURI || p.name);
  const def = voices.find(v => v.default) ?? voices[0] ?? null;
  if (!voices.length) return { voice: null, match: 'engine', note: 'No voices are listed, so the browser engine default will be tried.' };
  if (!chosen) return { voice: def, match: 'none-chosen', note: 'No preferred voice chosen; the device default is used.' };
  const exact = voices.find(v => v.voiceURI === p.voiceURI && !!p.voiceURI); if (exact) return { voice: exact, match: 'exact', note: '' };
  const byName = voices.find(v => v.name === p.name && v.lang === p.lang) ?? voices.find(v => v.name === p.name); if (byName) return { voice: byName, match: 'name', note: `Voice ID changed; matched “${byName.name}” by name.` };
  const sameLang = voices.filter(v => p.lang && primary(v.lang) === primary(p.lang)); // same language; prefer the same regional variant (en-GB over en-US), then on-device voices
  const norm = (l: string) => l.replace('_', '-').toLowerCase(), lang = sameLang.find(v => norm(v.lang) === norm(p.lang) && v.localService) ?? sameLang.find(v => norm(v.lang) === norm(p.lang)) ?? sameLang.find(v => v.localService) ?? sameLang[0];
  if (lang) return { voice: lang, match: 'language', note: `“${p.name || 'Your saved voice'}” is not available on this device. Using “${lang.name}” (same language).` };
  return { voice: def, match: 'default', note: `“${p.name || 'Your saved voice'}” is not available and no voice matches its language. Using the device default${def ? ` “${def.name}”` : ''}.` };
}

// ---------- 2. Speech synthesis test ----------
export interface SpeakResult { outcome: 'ended' | 'started-no-end' | 'error' | 'no-start' | 'unsupported'; events: string[]; ms: number; error?: string }
let keepAlive: unknown; // some engines drop an utterance that nothing references, and then never fire its events
/** Call this synchronously from a tap handler: iOS only speaks when speak() runs inside a user gesture. */
export function speak(env: Env, text: string, o: { voice?: SpeechSynthesisVoice | null; lang?: string; rate: number; pitch: number; startTimeoutMs?: number; endTimeoutMs?: number }): Promise<SpeakResult> {
  const t0 = Date.now(), events: string[] = [], ev = (e: string) => events.push(`${e}@${Date.now() - t0}ms`);
  if (!env.synth || !env.Utterance) return Promise.resolve({ outcome: 'unsupported', events, ms: 0 });
  const synth = env.synth;
  return new Promise<SpeakResult>(resolve => {
    let done = false, startT: any, endT: any;
    const finish = (outcome: SpeakResult['outcome'], error?: string) => { if (done) return; done = true; clearTimeout(startT); clearTimeout(endT); if (outcome === 'no-start' || outcome === 'started-no-end') { try { synth.cancel(); } catch { /* ignore */ } } resolve({ outcome, events, ms: Date.now() - t0, error }); };
    try {
      try { synth.cancel(); } catch { /* clears a stuck queue */ }
      const u = new env.Utterance!(text.slice(0, 400)); keepAlive = u;
      if (o.voice) { u.voice = o.voice; u.lang = o.voice.lang; } else if (o.lang) u.lang = o.lang;
      u.rate = clamp(o.rate, 0.5, 2, 1); u.pitch = clamp(o.pitch, 0, 2, 1);
      u.onstart = () => { ev('start'); clearTimeout(startT); endT = setTimeout(() => finish('started-no-end'), o.endTimeoutMs ?? Math.max(6000, text.length * 150)); };
      u.onend = () => { ev('end'); finish('ended'); };
      u.onerror = (e: any) => { const code = String(e?.error ?? 'unknown'); ev('error:' + code); finish('error', code); };
      startT = setTimeout(() => finish('no-start'), o.startTimeoutMs ?? 4000);
      synth.speak(u); ev('speak() called');
    } catch (e) { finish('error', (e as Error)?.message || 'speak() threw'); }
  });
}
export const stopSpeaking = (env: Env) => { try { env.synth?.cancel(); } catch { /* ignore */ } };

// ---------- 3. Microphone permission ----------
export type MicOutcome = 'granted' | 'denied' | 'no-device' | 'busy' | 'insecure' | 'unsupported' | 'error';
const micOutcome = (e: any): MicOutcome => { const n = String(e?.name ?? ''); return n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError' ? 'no-device' : n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError' ? 'busy' : 'error'; };
/** Really opens the microphone, checks the track is live, then releases it. */
export async function testMic(env: Env): Promise<{ outcome: MicOutcome; error?: string; label?: string }> {
  if (!env.secure) return { outcome: 'insecure' };
  if (!env.getUserMedia) return { outcome: 'unsupported' };
  let stream: MediaStream | undefined;
  try {
    stream = await env.getUserMedia({ audio: true });
    const tr = stream.getAudioTracks()[0];
    if (!tr || tr.readyState !== 'live') return { outcome: 'error', error: 'The microphone opened but gave no live audio track.' };
    return { outcome: 'granted', label: short(tr.label, 80) };
  } catch (e) { return { outcome: micOutcome(e), error: short((e as Error)?.name + ': ' + (e as Error)?.message, 200) }; }
  finally { stream?.getTracks().forEach(t => t.stop()); }
}

// ---------- 4. Real speech-recognition session ----------
export type RecOutcome = 'transcribed' | 'no-speech' | 'blocked' | 'error' | 'no-start' | 'ended-empty' | 'start-threw' | 'unsupported';
export interface RecResult { outcome: RecOutcome; transcript: string; confidence?: number; error?: string; events: string[]; ms: number }
export interface RecSession { stop(): void; result: Promise<RecResult> }
/** Starts a REAL recognition session and records every event it fires. The outcome is decided from what happened, never from the API existing. */
export function startRecognition(env: Env, o: { lang: string; onUpdate?: (live: { stage: string; text: string }) => void; startTimeoutMs?: number; maxMs?: number }): RecSession {
  const t0 = Date.now(), events: string[] = [], ev = (e: string) => events.push(`${e}@${Date.now() - t0}ms`);
  if (!env.Recognition) return { stop() {}, result: Promise.resolve({ outcome: 'unsupported', transcript: '', events, ms: 0 }) };
  let rec: any, stopFn = () => {};
  const result = new Promise<RecResult>(resolve => {
    let done = false, started = false, text = '', conf: number | undefined, err = '', t1: any, t2: any, t3: any;
    const finish = (forced?: RecOutcome) => {
      if (done) return; done = true; clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      let outcome: RecOutcome = forced ?? (text.trim() ? 'transcribed' : err === 'service-not-allowed' || err === 'not-allowed' ? 'blocked' : err === 'no-speech' ? 'no-speech' : err ? 'error' : started ? 'ended-empty' : 'no-start');
      if (text.trim() && outcome !== 'transcribed' && !forced) outcome = 'transcribed';
      resolve({ outcome, transcript: text.trim(), confidence: conf, error: err || undefined, events, ms: Date.now() - t0 });
    };
    try {
      rec = new env.Recognition();
      rec.lang = o.lang; rec.continuous = false; rec.interimResults = true; rec.maxAlternatives = 1;
      for (const n of ['audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'nomatch']) rec['on' + n] = () => { ev(n); o.onUpdate?.({ stage: n, text }); };
      rec.onstart = () => { started = true; ev('start'); clearTimeout(t1); o.onUpdate?.({ stage: 'start', text }); };
      rec.onresult = (e: any) => {
        let t = '', fin = false; for (let i = 0; i < (e.results?.length ?? 0); i++) { const r = e.results[i]; t += r?.[0]?.transcript ?? ''; if (r?.isFinal) { fin = true; conf = typeof r[0]?.confidence === 'number' ? r[0].confidence : conf; } }
        text = t; ev(fin ? 'result(final)' : 'result(interim)'); o.onUpdate?.({ stage: 'result', text });
      };
      rec.onerror = (e: any) => { err = String(e?.error ?? 'unknown'); ev('error:' + err); t3 = setTimeout(() => finish(), 1500); }; // normally 'end' follows; do not wait forever if it does not
      rec.onend = () => { ev('end'); finish(); };
      t1 = setTimeout(() => { ev('no start event'); try { rec.abort(); } catch { /* ignore */ } finish('no-start'); }, o.startTimeoutMs ?? 5000); // the iOS "API exists, nothing happens" case
      t2 = setTimeout(() => { ev('time limit'); try { rec.stop(); } catch { /* ignore */ } t3 = setTimeout(() => finish(), 2000); }, o.maxMs ?? 15000);
      stopFn = () => { ev('stop requested'); try { rec.stop(); } catch { /* ignore */ } t3 = setTimeout(() => finish(), 2000); };
      rec.start(); ev('start() called');
    } catch (e) { err = short((e as Error)?.name + ': ' + (e as Error)?.message); ev('start() threw'); finish('start-threw'); }
  });
  return { stop: () => stopFn(), result };
}

// ---------- 5. Recording a clip (needed for server-side transcription) ----------
export const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
export function pickMime(R: typeof MediaRecorder | undefined): string { try { if (!R) return ''; return R.isTypeSupported ? (MIME_CANDIDATES.find(m => R.isTypeSupported(m)) ?? '') : ''; } catch { return ''; } }
export const MAX_CLIP_BYTES = 2_500_000; // stays under the Worker's 3 MB limit and Groq's 25 MB free-tier file limit
export type ClipOutcome = 'recorded' | 'empty' | 'too-large' | MicOutcome;
export interface ClipResult { outcome: ClipOutcome; blob?: Blob; mime: string; ms: number; bytes: number; error?: string }
export interface ClipSession { stop(): void; result: Promise<ClipResult> }
/** Records from the microphone with MediaRecorder. The microphone is released on stop, on error, and at the time limit. */
export function startClip(env: Env, o: { maxMs?: number } = {}): ClipSession {
  const t0 = Date.now(); let stopped = false, stopRec = () => {};
  const result = (async (): Promise<ClipResult> => {
    const fail = (outcome: ClipOutcome, error?: string): ClipResult => ({ outcome, mime: '', ms: Date.now() - t0, bytes: 0, error });
    if (!env.secure) return fail('insecure'); if (!env.getUserMedia || !env.Recorder) return fail('unsupported');
    let stream: MediaStream | undefined;
    try {
      stream = await env.getUserMedia({ audio: true });
      if (stopped) { stream.getTracks().forEach(t => t.stop()); return fail('empty', 'Stopped before recording began.'); } // release the mic even if Stop was tapped before it finished opening
      const mimeType = pickMime(env.Recorder), rec = new env.Recorder(stream, mimeType ? { mimeType } : undefined), chunks: Blob[] = [];
      return await new Promise<ClipResult>(resolve => {
        let to: any; const s = stream!;
        const release = () => { clearTimeout(to); s.getTracks().forEach(t => t.stop()); };
        rec.ondataavailable = (e: BlobEvent) => { if (e.data?.size) chunks.push(e.data); };
        rec.onerror = (e: any) => { release(); resolve(fail('error', short(e?.error?.message || 'The recorder reported an error.'))); };
        rec.onstop = () => {
          release(); const mime = rec.mimeType || mimeType || chunks[0]?.type || '', blob = new Blob(chunks, { type: mime }), ms = Date.now() - t0;
          resolve(!blob.size ? { outcome: 'empty', mime, ms, bytes: 0, error: 'The recorder produced no audio data.' } : blob.size > MAX_CLIP_BYTES ? { outcome: 'too-large', mime, ms, bytes: blob.size } : { outcome: 'recorded', blob, mime, ms, bytes: blob.size });
        };
        stopRec = () => { try { if (rec.state !== 'inactive') rec.stop(); else release(); } catch { release(); } };
        to = setTimeout(stopRec, o.maxMs ?? 10000);
        rec.start();
      });
    } catch (e) { stream?.getTracks().forEach(t => t.stop()); return fail(micOutcome(e), short((e as Error)?.name + ': ' + (e as Error)?.message)); }
  })();
  return { stop: () => { stopped = true; stopRec(); }, result };
}

// ---------- 6. Backend (Worker) transcription ----------
export type BackendState = 'no-worker' | 'offline' | 'unreachable' | 'worker-old' | 'no-key' | 'configured';
/** Asks the Worker what it has. 'configured' means a key is present; it is NOT proof that transcription works (only a real test clip proves that). */
export async function backendState(cfg: Cfg | null, online: boolean, health: (c: Cfg) => Promise<any> = c => call(c, '/health', undefined, 15000)): Promise<{ state: BackendState; detail?: string }> {
  if (!cfg) return { state: 'no-worker' };
  if (!online) return { state: 'offline' };
  try { const j = await health(cfg); if (typeof j?.stt !== 'boolean') return { state: 'worker-old' }; return { state: j.stt ? 'configured' : 'no-key' }; }
  catch (e) { return { state: 'unreachable', detail: short((e as Error)?.message) }; }
}
const SENDABLE = /^(audio\/(mp4|x-m4a|m4a|webm|ogg|wav|x-wav|mpeg|flac)|video\/(mp4|webm))$/;
/** Sends one recorded clip to the user's own Worker. The audio leaves the device (Worker, then Groq). Nothing is stored. */
export async function transcribe(cfg: Cfg, blob: Blob, mime: string, lang?: string, ms = 45000): Promise<{ text: string }> {
  const base = mime.split(';')[0].trim().toLowerCase(); if (!SENDABLE.test(base)) throw new Error(`This browser recorded “${mime || 'unknown'}”, which the transcription service cannot read.`);
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const l = lang && /^[a-z]{2,3}$/i.test(lang.split('-')[0]) ? '?lang=' + lang.split('-')[0].toLowerCase() : '';
    const r = await fetch(cfg.url.replace(/\/+$/, '') + '/transcribe' + l, { method: 'POST', signal: c.signal, headers: { Authorization: 'Bearer ' + cfg.pass, 'Content-Type': base }, body: blob });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? 'Wrong passphrase. Check Setup > Online lookup.' : r.status === 403 ? 'The Worker rejected this website (ALLOWED_ORIGIN).' : r.status === 404 ? 'The Worker has no /transcribe route. Redeploy the updated Worker (see SETUP-LOOKUP.md).' : r.status === 413 ? 'The clip is too large.' : r.status === 429 ? short(j?.error) || 'Rate limit reached. Wait a minute.' : [400, 415, 502, 503].includes(r.status) && j?.error ? short(j.error) : 'The transcription service had a problem.');
    return { text: short(j?.text, 4000).trim() };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('Transcription timed out.');
    if (e instanceof TypeError) throw new Error('Could not reach the Worker. Check your connection and the Worker address.');
    throw e;
  } finally { clearTimeout(t); }
}

// ---------- Honest status labels ----------
const when = (s?: Saved) => (s ? ` Last test: ${new Date(s.ts).toLocaleString()} (${s.ctx}).` : '');
export function ttsStatus(env: Env, voices: number, s?: Saved): Status {
  if (!env.synth || !env.Utterance) return { text: 'NOT AVAILABLE', tone: 'bad', detail: 'This browser has no speech synthesis.' };
  if (s?.heard === true) return { text: 'CONFIRMED: YOU HEARD IT', tone: 'ok', detail: 'You confirmed hearing the preview.' + when(s) };
  if (s?.heard === false) return { text: 'SPOKE BUT YOU HEARD NOTHING', tone: 'bad', detail: 'Check the volume and the ring/silent switch, then test again.' + when(s) };
  if (s?.outcome === 'ended') return { text: 'ENGINE FINISHED. NOT CONFIRMED AUDIBLE', tone: 'warn', detail: 'The browser says it finished speaking. Only you can confirm you heard it.' + when(s) };
  if (s?.outcome === 'started-no-end') return { text: 'STARTED BUT NEVER FINISHED', tone: 'warn', detail: (s.detail ?? '') + when(s) };
  if (s?.outcome === 'no-start') return { text: 'ENGINE DID NOT START SPEAKING', tone: 'bad', detail: 'No start event within 4 seconds.' + when(s) };
  if (s?.outcome === 'error') return { text: 'ERROR' + (s.detail ? ': ' + s.detail : ''), tone: 'bad', detail: when(s).trim() };
  return { text: `API PRESENT, ${voices} VOICE${voices === 1 ? '' : 'S'} LISTED. UNTESTED`, tone: 'warn', detail: 'Listing voices does not prove sound comes out. Run the preview.' };
}
export function recStatus(env: Env, s?: Saved): Status {
  if (!env.Recognition) return { text: 'NOT AVAILABLE', tone: 'bad', detail: 'This browser has no speech recognition API.' };
  const d = (s?.detail ? s.detail + ' ' : '') + when(s).trim();
  switch (s?.outcome) {
    case 'transcribed': return { text: 'CONFIRMED: A REAL SESSION PRODUCED TEXT', tone: 'ok', detail: d };
    case 'blocked': return { text: 'BLOCKED' + (s.detail ? ' (' + s.detail.split(' ')[0] + ')' : ''), tone: 'bad', detail: 'Permission or the speech service refused. On iPhone check Settings > General > Keyboard > Enable Dictation, and microphone permission. ' + when(s).trim() };
    case 'no-start': return { text: 'API EXISTS BUT NOTHING HAPPENS', tone: 'bad', detail: 'start() was called and no start event arrived. This is the known behaviour of speech recognition in iOS Home Screen apps. ' + when(s).trim() };
    case 'start-threw': return { text: 'FAILED TO START', tone: 'bad', detail: d };
    case 'no-speech': return { text: 'LISTENED BUT HEARD NO SPEECH', tone: 'warn', detail: 'Tap Start, then speak straight away. ' + when(s).trim() };
    case 'ended-empty': return { text: 'SESSION ENDED WITHOUT TEXT', tone: 'warn', detail: d };
    case 'error': return { text: 'ERROR' + (s.detail ? ': ' + s.detail.split(' ')[0] : ''), tone: 'bad', detail: d };
    default: return { text: 'API PRESENT. UNTESTED', tone: 'warn', detail: 'The API existing does not mean it works. Run a listening test.' };
  }
}
export function micStatus(env: Env, s?: Saved): Status {
  if (!env.secure) return { text: 'UNAVAILABLE: PAGE IS NOT HTTPS', tone: 'bad', detail: 'Browsers only give microphone access to secure pages. Use the https:// site, not a plain http:// address.' };
  if (!env.getUserMedia) return { text: 'NOT AVAILABLE', tone: 'bad', detail: 'This browser has no microphone API.' };
  const t = when(s).trim();
  switch (s?.outcome) {
    case 'granted': return { text: 'PERMISSION GRANTED. MIC OPENED AND RELEASED', tone: 'ok', detail: t };
    case 'denied': return { text: 'PERMISSION DENIED OR DISMISSED', tone: 'bad', detail: 'Allow the microphone when asked. If you tapped Don\'t Allow, close and reopen the app, or check Settings > Safari > Microphone. ' + t };
    case 'no-device': return { text: 'NO MICROPHONE FOUND', tone: 'bad', detail: t };
    case 'busy': return { text: 'MICROPHONE IN USE OR UNREADABLE', tone: 'bad', detail: 'Another app may be using it. ' + t };
    case 'error': return { text: 'ERROR', tone: 'bad', detail: (s.detail ?? '') + ' ' + t };
    default: return { text: 'NOT TESTED', tone: 'neutral', detail: 'Permission is only known after you run the test.' };
  }
}
export function clipStatus(env: Env, s?: Saved): Status {
  if (!env.Recorder) return { text: 'NOT AVAILABLE', tone: 'bad', detail: 'This browser cannot record audio clips (no MediaRecorder).' };
  const mime = pickMime(env.Recorder), t = when(s).trim();
  if (s?.outcome === 'recorded') return { text: 'CONFIRMED: A CLIP WAS RECORDED', tone: 'ok', detail: (s.detail ?? '') + ' ' + t };
  if (s && s.outcome !== 'recorded') return { text: 'LAST RECORDING FAILED: ' + s.outcome.toUpperCase(), tone: 'bad', detail: (s.detail ?? '') + ' ' + t };
  return { text: 'API PRESENT. UNTESTED', tone: 'warn', detail: mime ? `Would record as ${mime}.` : 'No supported recording format was reported; recording may still work with the default.' };
}
export function sttStatus(b: { state: BackendState | 'unchecked'; detail?: string }, s?: Saved): Status {
  const t = when(s).trim();
  if (s?.outcome === 'transcribed') return { text: 'CONFIRMED: A TEST CLIP WAS TRANSCRIBED', tone: 'ok', detail: t };
  const last = s && s.outcome !== 'transcribed' ? ` Last transcription attempt failed: ${s.detail ?? s.outcome}. ${t}` : '';
  switch (b.state) {
    case 'no-worker': return { text: 'NOT SET UP', tone: 'neutral', detail: 'Needs your own Cloudflare Worker (Setup > Online lookup).' + last };
    case 'offline': return { text: 'OFFLINE', tone: 'warn', detail: 'Cannot check or use the Worker without a connection.' + last };
    case 'unreachable': return { text: 'WORKER UNREACHABLE', tone: 'bad', detail: (b.detail ?? '') + last };
    case 'worker-old': return { text: 'WORKER NEEDS UPDATE', tone: 'warn', detail: 'The deployed Worker is an older version without transcription. Redeploy worker/index.ts.' + last };
    case 'no-key': return { text: 'NO TRANSCRIPTION KEY ON WORKER', tone: 'warn', detail: 'Set GROQ_API_KEY on the Worker (wrangler secret put GROQ_API_KEY).' + last };
    case 'configured': return { text: 'KEY PRESENT. UNPROVEN UNTIL A TEST CLIP IS TRANSCRIBED', tone: 'warn', detail: 'The Worker has a key. That does not prove the service accepts audio from this device.' + last };
    default: return { text: 'NOT CHECKED YET', tone: 'neutral', detail: 'Tap Check Worker.' + last };
  }
}
