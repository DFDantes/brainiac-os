import './style.css';
import * as db from './db';
import { Hit, Cfg, call, parseHits, parseAnswer, validWorkerUrl } from './lookup';
import * as ops from './opsui';
import { parseFullBackup } from './ops';
import { Rec, KINDS, CONF, MAX_IMPORT_BYTES, newRecord, validateRecord, serializeBackup, matches, cleanQuery, sampleRecords, brokenLinks, diffFields } from './model';

const app = document.getElementById('app')!;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const TABS: [string, string][] = [['command', 'COMMAND'], ['archive', 'ARCHIVE'], ['colossus', 'COLOSSUS'], ['omega', 'OMEGA'], ['timeline', 'TIMELINE'], ['settings', 'SETUP']];
const GLYPH = '<svg viewBox="0 0 32 32" fill="none" stroke="#39ff78" stroke-width="1.5" aria-hidden="true"><circle cx="16" cy="16" r="12"/><circle cx="16" cy="16" r="3.5"/><path d="M16 4v8.5M16 19.5V28M4 16h8.5M19.5 16H28"/></svg>';
let view = 'command', q = '', kind = '', limit = 50, editing: Rec | null | undefined, draft: Rec = newRecord(), cache: Rec[] = [], dbOk = true, saving = false;
let persisted: boolean | null = null, snap: db.SnapshotInfo | null = null;
let viewing: string | null = null, hist: db.HistItem[] = [], deleted: Awaited<ReturnType<typeof db.listDeleted>> = [];
let lastBackup: string | undefined, pending: File | null = null, pendingText = '', showText = false, timer: number | undefined;
let cfg: Cfg | null = null, look: { q: string; mode: 'lookup' | 'ask'; busy: boolean; hits?: Hit[]; answer?: string; sources?: { title: string; url: string }[]; err?: string } | null = null;

function toast(t: string, bad = false) { const m = document.getElementById('msg'); if (!m) return; m.textContent = t; m.className = bad ? 'bad' : ''; m.style.display = 'block'; clearTimeout(timer); timer = window.setTimeout(() => (m.style.display = 'none'), 5000); }
const fail = (e: unknown) => toast((e as Error)?.message || 'Something went wrong. Nothing was saved.', true);
const line = (r: Rec) => `<button class="item" data-act="open" data-id="${esc(r.id)}"><b>${esc(r.name)}</b><small>${r.kind} · ${r.confidence}${r.source ? ' · ' + esc(r.source) : ''}</small></button>`;
const chips = () => `<span class="chip ${dbOk ? 'ok' : 'bad'}">DB ${dbOk ? 'LOCAL OK' : 'ERROR'}</span><span class="chip ${navigator.onLine ? 'ok' : ''}">${navigator.onLine ? 'ONLINE' : 'OFFLINE'}</span><span class="chip ${cfg ? 'ok' : ''}">LOOKUP ${cfg ? 'READY' : 'NOT SET UP'}</span><span class="chip ${persisted ? 'ok' : ''}">STORAGE ${persisted === true ? 'PROTECTED' : persisted === false ? 'NOT PROTECTED' : 'UNKNOWN'}</span><span class="chip ${ops.voiceChip().cls}">${ops.voiceChip().text}</span>`;

function listHtml() {
  const rows = cache.filter(r => (!kind || r.kind === kind) && matches(r, q)).sort((a, b) => b.modified.localeCompare(a.modified));
  if (!cache.length) return '<p class="muted">The archive is empty. Add a record, or load the optional sample data in Setup.</p>';
  if (!rows.length) return '<p class="muted">No records match.</p>' + (q.trim() ? `<button data-act="lookupq">Look “${esc(q.trim())}” up online</button>` : '');
  return rows.slice(0, limit).map(line).join('') + (rows.length > limit ? `<button data-act="more">Show more (${rows.length - limit})</button>` : '');
}
function formHtml(r: Rec) {
  const opt = (a: readonly string[], v: string) => a.map(x => `<option ${x === v ? 'selected' : ''}>${x}</option>`).join('');
  const f = (n: string, l: string, v: string, tag = 'input') => `<label for="${n}">${l}</label>` + (tag === 'textarea' ? `<textarea id="${n}" name="${n}" maxlength="5000">${esc(v)}</textarea>` : `<input id="${n}" name="${n}" value="${esc(v)}" maxlength="${n === 'tags' ? 1200 : 300}">`);
  const exists = cache.some(c => c.id === r.id);
  return `<form id="rf"><h2>${exists ? 'Edit record' : 'New record'}</h2>${f('name', 'Name', r.name)}
  <label for="kind">Category</label><select id="kind" name="kind">${opt(KINDS, r.kind)}</select>${f('description', 'Description', r.description, 'textarea')}
  ${f('tags', 'Tags (comma separated)', r.tags.join(', '))}${f('source', 'Source / provenance', r.source)}
  <label for="confidence">Evidence level</label><select id="confidence" name="confidence">${opt(CONF, r.confidence)}</select>
  ${f('status', 'Status', r.status)}${f('notes', 'Private notes', r.notes, 'textarea')}
  ${linksHtml(r)}
  <button class="pri" type="submit">Save</button><button type="button" data-act="cancel">Cancel</button>${exists ? `<button type="button" class="danger" data-act="del" data-id="${esc(r.id)}">Delete</button>` : ''}</form>`;
}
const nameOrMissing = (id: string) => cache.find(x => x.id === id)?.name ?? 'missing record';
function linksHtml(r: Rec) {
  const row = (id: string) => { const t = cache.find(x => x.id === id); return `<div class="panel" style="display:flex;gap:8px;align-items:center;justify-content:space-between"><span style="overflow-wrap:anywhere">${t ? `<b style="color:var(--g)">${esc(t.name)}</b> <small class="muted">${t.kind}</small>` : `<span style="color:var(--warn)">Missing record</span> <small class="muted">${esc(id)}</small>`}</span><button type="button" data-act="unlinkrec" data-id="${esc(id)}" aria-label="Remove link">Remove</button></div>`; };
  return `<h2>Linked records</h2><p class="muted">Link changes are saved when you tap Save.</p>${r.links.length ? r.links.map(row).join('') : '<p class="muted">No links yet.</p>'}<label for="lq">Add a link: search by name</label><input id="lq" placeholder="Type a name" autocomplete="off" enterkeyhint="done"><div id="lr"></div>`;
}
function linkResults(r: Rec, term: string) {
  const t = term.trim(); if (!t) return '';
  const rows = cache.filter(x => x.id !== r.id && !r.links.includes(x.id) && matches(x, t)).slice(0, 8);
  return rows.length ? rows.map(x => `<button type="button" class="item" data-act="linkrec" data-id="${esc(x.id)}"><b>${esc(x.name)}</b><small>${x.kind} · tap to link</small></button>`).join('') : '<p class="muted">No matching record to link.</p>';
}
/** Copies what is typed in the open form into the working record, so re-rendering (after a link change) never loses typing. */
function capture(): Rec {
  const f = document.getElementById('rf') as HTMLFormElement | null, base = editing ?? draft; if (!f) return base;
  const d = Object.fromEntries(new FormData(f).entries()) as Record<string, string>;
  const next = { ...base, ...d, tags: (d.tags ?? '').split(',').map(t => t.trim()).filter(Boolean) } as Rec;
  if (editing) editing = next; else draft = next; return next;
}
const ACTIONS: Record<string, string> = { create: 'Created', update: 'Edited', delete: 'Deleted', unlink: 'Links cleaned up', import: 'Replaced by a backup restore', sample: 'Added from sample data', undo: 'Replaced by the safety copy' };
const show = (f: string, v: string | string[]) => { const t = f === 'links' ? (v as string[]).map(nameOrMissing).join(', ') : Array.isArray(v) ? v.join(', ') : v; return esc(t.length > 140 ? t.slice(0, 140) + '…' : t) || '<i>empty</i>'; };
function histHtml() {
  const rows = [...hist].reverse().slice(0, 30);
  return `<h2>History (${hist.length})</h2>` + (rows.length ? rows.map(h => {
    const ch = h.before && h.after ? diffFields(h.before, h.after).map(d => `<div class="muted" style="overflow-wrap:anywhere">${d.field}: ${show(d.field, d.from)} → ${show(d.field, d.to)}</div>`).join('') : '';
    return `<div class="panel"><b>${ACTIONS[h.action] ?? esc(h.action)}</b> <span class="muted">${esc(new Date(h.ts).toLocaleString())}</span>${ch}${h.damaged ? '<div class="muted">The earlier version in this entry is damaged.</div>' : ''}${h.before ? `<br><button data-act="restorever" data-id="${esc(h.id)}" style="margin-top:8px">Restore the version from before this change</button>` : ''}</div>`; }).join('') + (hist.length > 30 ? '<p class="muted">Showing the newest 30 entries.</p>' : '') : '<div class="panel muted">No history recorded for this record.</div>');
}
function detailHtml(r: Rec) {
  const out = r.links.map(id => cache.find(x => x.id === id)).filter((x): x is Rec => !!x), missing = r.links.filter(id => !cache.some(x => x.id === id)), inc = cache.filter(x => x.id !== r.id && x.links.includes(r.id));
  const f = (l: string, v: string) => v ? `<p><span class="muted">${l}</span><br><span style="white-space:pre-wrap;overflow-wrap:anywhere">${v}</span></p>` : '';
  return `<button data-act="back">← Back</button><button class="pri" data-act="edit" data-id="${esc(r.id)}">Edit</button>
  <h2>${r.kind}</h2><div class="panel"><b style="color:var(--g);font-size:17px;overflow-wrap:anywhere">${esc(r.name)}</b><p class="muted">Evidence: ${r.confidence}${r.status ? ' · Status: ' + esc(r.status) : ''}</p>${f('Description', esc(r.description))}${f('Source', link(r.source))}${f('Tags', esc(r.tags.join(', ')))}${f('Private notes', esc(r.notes))}<p class="muted">Created ${esc(new Date(r.created).toLocaleString())} · Last changed ${esc(new Date(r.modified).toLocaleString())}</p></div>
  <h2>Links to (${out.length + missing.length})</h2>${out.map(line).join('')}${missing.map(id => `<div class="panel" style="border-color:var(--warn)"><span style="color:var(--warn)">Missing record</span> <small class="muted">${esc(id)}</small><br><span class="muted">Edit this record to remove the link, or use Setup &gt; Archive check.</span></div>`).join('')}${out.length + missing.length ? '' : '<div class="panel muted">This record links to nothing yet. Tap Edit to add links.</div>'}
  <h2>Linked from (${inc.length})</h2>${inc.length ? inc.map(line).join('') : '<div class="panel muted">No other record links to this one.</div>'}${ops.usedByHtml(r.id)}${histHtml()}`;
}
function body() {
  if (view === 'command') {
    const recent = [...cache].sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 5);
    const gaps = cache.filter(r => r.tags.includes('needs-detail'));
    return `<form id="cf"><label for="cq">Command</label><input id="cq" placeholder="Ask the archive, or: mission new…, task add…, event add…, omega…, help" value="${esc(ops.cmdDraftValue())}" enterkeyhint="go" autocomplete="off" autocapitalize="off"><button class="pri" type="submit">Run</button><button type="button" data-act="lookup">Look up online</button><button type="button" data-act="ask">Ask AI (web)</button><button type="button" data-act="new">+ Record</button>
    <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input id="lkctx" type="checkbox" style="width:auto;min-height:0;margin:0"> Include up to 3 matching record summaries when asking AI</label></form>${ops.cmdPanel()}<div id="lk">${lookHtml()}</div>
    <h2>Recently updated</h2>${recent.length ? recent.map(line).join('') : '<div class="panel muted">No intelligence recorded yet. Use “+ Record”, or load the optional sample data in Setup.</div>'}
    ${gaps.length ? `<h2>Missing detail (${gaps.length})</h2><div class="panel muted">Plans can only use what is recorded. Add the real rules and abilities to these:</div>${gaps.slice(0, 6).map(line).join('')}` : ''}
    <h2>Records</h2><div class="panel">${cache.length} stored on this device</div>`;
  }
  if (view === 'archive') return editing !== undefined ? formHtml(editing ?? draft) : (viewing && cache.find(r => r.id === viewing)) ? detailHtml(cache.find(r => r.id === viewing)!) :
    `<input id="q" type="search" placeholder="Search archive" value="${esc(q)}" aria-label="Search archive"><select id="kf" aria-label="Category"><option value="">All categories</option>${KINDS.map(k => `<option ${k === kind ? 'selected' : ''}>${k}</option>`).join('')}</select>
     <button class="pri" data-act="new">+ New record</button><div id="list" style="margin-top:10px">${listHtml()}</div>`;
  if (view === 'settings') return `<h2>Backup &amp; restore</h2><div class="panel"><p class="muted">Your data lives only on this device. Last backup: ${lastBackup ? esc(new Date(lastBackup).toLocaleString()) : 'never'}.</p>
    <button class="pri" data-act="export">Prepare backup</button>
    ${pending ? `<p class="muted">Backup ready. Tap Share, then choose “Save to Files”.</p><button class="pri" data-act="share">Share / save file</button><button data-act="showtext">${showText ? 'Hide' : 'Show'} as text</button>` : ''}
    ${showText ? `<textarea id="bt" readonly aria-label="Backup text">${esc(pendingText)}</textarea><p class="muted">Fallback: tap the box, Select All, Copy, and paste into Notes.</p>` : ''}
    <label for="imp" style="margin-top:10px">Restore from file (merges by ID; replaced records are kept in history)</label><input id="imp" type="file" accept="application/json,.json">
    <label for="paste">…or paste backup text</label><textarea id="paste"></textarea><button data-act="restoretext">Restore pasted text</button></div>
    <h2>Online lookup</h2><div class="panel"><p class="muted">Needs your own Cloudflare Worker (see SETUP-LOOKUP.md). Only your search words leave this device (plus up to 3 record summaries if you tick that box). Results are saved only after you review them, always as unverified. Stored on this device only, never in backups.</p>
    <label for="wurl">Worker address</label><input id="wurl" value="${esc(cfg?.url ?? '')}" placeholder="https://brainiac-proxy.YOURNAME.workers.dev" autocapitalize="off" autocorrect="off">
    <label for="wpass">Passphrase</label><input id="wpass" type="password" value="${esc(cfg?.pass ?? '')}" autocomplete="off" autocapitalize="off" autocorrect="off">
    <button class="pri" data-act="savecfg">Save</button><button data-act="testcfg">Test connection</button><button data-act="clearcfg">Remove</button></div>
    <h2>Sample data</h2><div class="panel"><p class="muted">Optional. Facts you supplied about your roleplay and server (including Palladium and its addons); nothing is invented. Mechanic records are marked “needs-detail” until you fill them in.</p><button data-act="sample">Load sample data</button></div>
    <h2>Safety copy</h2><div class="panel"><p class="muted">Before a restore replaces records, or before you erase everything, the app keeps one automatic copy of your records on this device. ${snap ? `Current safety copy: ${snap.count} records, taken ${esc(new Date(snap.ts).toLocaleString())} (${esc(snap.reason)}).` : 'There is no safety copy right now.'} It is not a substitute for a backup file: if the browser clears this site's data, the safety copy goes too.</p>
    ${snap ? '<button data-act="undo">Undo last restore / erase</button><button data-act="discardsnap">Discard safety copy</button>' : ''}</div>
    <h2>Archive check</h2><div class="panel"><p class="muted">${cache.length} records. ${brokenLinks(cache).length ? `${brokenLinks(cache).length} links point to records that are not in this archive (for example after restoring a partial backup). Nothing is changed until you choose.` : 'No broken links.'}</p>${brokenLinks(cache).length ? '<button data-act="fixlinks">Remove broken links</button>' : ''}</div>
    <h2>Deleted records</h2><div class="panel">${deleted.length ? deleted.slice(0, 20).map(d => `<p><b>${esc(d.name)}</b> <span class="muted">deleted ${esc(new Date(d.ts).toLocaleString())}</span><br><button data-act="restorever" data-id="${esc(d.entryId)}">Restore</button></p>`).join('') + '<p class="muted">Restoring brings the record back as it was when deleted. Links other records had to it were removed at deletion and are not recreated.</p>' : '<p class="muted">No deleted records to recover.</p>'}</div>
    ${ops.setupHtml()}
    <h2>Danger zone</h2><div class="panel"><button class="danger" data-act="clear">Erase all data</button></div>
    <h2>About</h2><div class="panel muted">Brainiac OS v0.6 (Stage 5 checkpoint: Colossus, OMEGA and Timeline on top of the archive, with typed commands). Private roleplay tool, not connected to any Minecraft server. Voice: only a basic microphone button and read-aloud on the Command tab; the Voice Lab screen from Stage 4 is not built, and voice has not been tried on a real phone. There is no AI chat beyond Ask AI.</div>`;
  const names: Record<string, string> = { colossus: 'Colossus mission engine', omega: 'Project OMEGA', timeline: 'Strategic Timeline' };
  return `<h2>${names[view]}</h2>${ops.opsBody(view)}`;
}
async function render() {
  try { cache = await db.getAll(); dbOk = true; lastBackup = await db.getMeta('lastBackup'); snap = await db.getSnapshotInfo(); try { deleted = view === 'settings' ? await db.listDeleted() : []; if (viewing && cache.some(r => r.id === viewing)) hist = await db.recordHistory(viewing); else { viewing = null; hist = []; } } catch { deleted = []; hist = []; } const lu = await db.getMeta('lookupUrl'), lp = await db.getMeta('lookupPass'); cfg = lu && lp ? { url: lu, pass: lp } : null; } catch { dbOk = false; cache = []; }
  await ops.loadOps();
  document.body.classList.remove('kb');
  app.innerHTML = `<header>${GLYPH}<h1>BRAINIAC OS</h1></header><div class="chips" id="chips">${chips()}</div>
  <main>${body()}</main><div id="msg" role="status"></div>
  <nav aria-label="Main">${TABS.map(([v, l]) => `<button class="${v === view ? 'on' : ''}" data-act="tab" data-id="${v}">${l}</button>`).join('')}</nav>`;
}
const paintLook = () => { const el = document.getElementById('lk'); if (el) el.innerHTML = lookHtml(); };
const link = (u: string) => /^https:\/\//.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>` : esc(u);
function lookHtml() {
  if (!look) return '';
  if (look.busy) return '<div class="panel muted">Looking up…</div>';
  if (look.err) return `<div class="panel" style="border-color:var(--bad)">${esc(look.err)}<br><span class="muted">Your archive still works normally.</span></div>`;
  if (look.mode === 'ask') return `<h2>AI answer (unverified)</h2><div class="panel" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(look.answer ?? '')}</div>${(look.sources ?? []).map(x => `<div class="muted" style="overflow-wrap:anywhere">${esc(x.title)} · ${link(x.url)}</div>`).join('')}<button class="pri" data-act="saveai" style="margin-top:8px">Review &amp; save as unverified</button><button data-act="o:aihyp" style="margin-top:8px">Add to OMEGA as AI-suggested hypothesis</button>`;
  const h = look.hits ?? [];
  return '<h2>Online results (unverified)</h2>' + (h.length ? h.map((x, i) => `<div class="panel"><b style="color:var(--g)">${esc(x.title)}</b> <span class="chip">${esc(x.source)}</span><p class="muted">${esc(x.summary)}</p>${link(x.url)}<br><button data-act="saveweb" data-id="${i}" style="margin-top:8px">Review &amp; save</button></div>`).join('') : '<div class="panel muted">Nothing found. Try different words or check the spelling.</div>');
}
async function runLookup(query: string, mode: 'lookup' | 'ask') {
  query = query.trim();
  if (query.length < 2) return toast('Type something to look up.', true);
  if (!cfg) return toast('Set up online lookup in Setup first.', true);
  if (!navigator.onLine) return toast('You are offline. Lookups need internet.', true);
  if (look?.busy) return;
  const useCtx = (document.getElementById('lkctx') as HTMLInputElement | null)?.checked ?? false, my: NonNullable<typeof look> = { q: query, mode, busy: true };
  look = my; paintLook();
  try {
    if (mode === 'lookup') my.hits = parseHits(await call(cfg, '/lookup', { query }));
    else { const context = useCtx ? cache.filter(r => matches(r, cleanQuery(query))).slice(0, 3).map(r => ({ name: r.name, kind: r.kind, description: r.description.slice(0, 300) })) : [];
      const a = parseAnswer(await call(cfg, '/ask', { query, context })); my.answer = a.answer; my.sources = a.sources; }
  } catch (e) { my.err = (e as Error).message; }
  my.busy = false; paintLook();
}
const reviewNew = (p: Partial<Rec>) => { draft = newRecord({ kind: 'report', confidence: 'unverified', tags: ['web-lookup'], ...p }); editing = null; viewing = null; view = 'archive'; return render(); };
async function restore(text: string) {
  const { records: recs, ops: bops } = parseFullBackup(text); const p = await db.planImport(recs), po = await db.planImportOps(bops);
  if ((p.replace > 0 || po.replace > 0) && !confirm(`This backup adds ${p.added} records and replaces ${p.replace} records that are older on this device${po.added + po.replace + po.keep ? `; for missions, OMEGA and events it adds ${po.added}, replaces ${po.replace} older ones and leaves ${po.keep} unchanged` : ''}. ${p.keep} records are the same or newer here and will be left alone. A safety copy is saved first so you can undo. Continue?`)) return;
  if (p.added + p.replace + po.added + po.replace > 0) await db.snapshot('before restore');
  const r = await db.importRecords(recs, 'import', { keepNewer: true }); const ro = await db.importOps(bops); await render();
  toast(`Restored: ${r.added} added, ${r.replaced} replaced, ${p.keep} left unchanged${bops.missions.length + bops.events.length + (bops.omega ? 1 : 0) ? `; missions/OMEGA/events: ${ro.added} added, ${ro.replaced} replaced, ${ro.kept} unchanged` : ''}. Undo is in Setup > Safety copy.` + (brokenLinks(cache).length ? ` ${brokenLinks(cache).length} links point to records that are not in this archive (see Setup > Archive check).` : ''));
}
const markBackup = () => db.setMeta('lastBackup', new Date().toISOString()).then(render).then(() => toast('Backup saved')).catch(fail);

app.addEventListener('click', async e => {
  const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null; if (!el) return;
  const id = el.dataset.id ?? '';
  if (el.dataset.act!.startsWith('o:')) { try { await ops.click(el); } catch (err) { fail(err); } return; } // Stage 5 controls (the call starts synchronously, which iOS needs for speech)
  try {
    switch (el.dataset.act) {
      case 'tab': view = id; editing = undefined; viewing = null; ops.resetView(); return void (await render());
      case 'new': view = 'archive'; editing = null; viewing = null; draft = newRecord(); return void (await render());
      case 'open': viewing = id; editing = undefined; view = 'archive'; return void (await render());
      case 'back': viewing = null; return void (await render());
      case 'edit': { const r = cache.find(x => x.id === id); if (!r) return; editing = r; viewing = id; view = 'archive'; return void (await render()); }
      case 'linkrec': { const w = capture(); if (id === w.id || w.links.includes(id)) return; if (w.links.length >= 100) return toast('A record can have at most 100 links.', true); w.links = [...w.links, id]; return void (await render()); }
      case 'unlinkrec': { const w = capture(); w.links = w.links.filter(l => l !== id); return void (await render()); }
      case 'restorever': { if (!confirm('Restore the earlier version stored in this history entry? The version being replaced stays in history, so you can switch back.')) return;
        const r = await db.restoreVersion(id); view = 'archive'; editing = undefined; viewing = r.record.id; await render(); return toast(`Restored “${r.record.name}”.` + (r.droppedLinks ? ` ${r.droppedLinks} links to records that no longer exist were left out.` : '')); }
      case 'fixlinks': { const n = brokenLinks(cache).length; if (!n || !confirm(`Remove ${n} links that point to records which are not in this archive? Each change is kept in history, and a safety copy is saved first.`)) return;
        await db.snapshot('before removing broken links'); const k = await db.removeBrokenLinks(); await render(); return toast(`${k} broken links removed. Undo is in Setup > Safety copy.`); }
      case 'cancel': editing = undefined; return void (await render());
      case 'more': limit += 50; return void (document.getElementById('list')!.innerHTML = listHtml());
      case 'del': if (!confirm('Delete this record? It stays in the audit history, and links to it are removed from other records.')) return; await db.remove(id); editing = undefined; viewing = null; await render(); return toast('Record deleted');
      case 'sample': { const have = new Set(cache.map(r => r.id)); const fresh = sampleRecords().filter(r => !have.has(r.id));
        if (!fresh.length) return toast('Sample data is already loaded.'); await db.importRecords(fresh, 'sample'); await render(); return toast(`${fresh.length} sample records added`); }
      case 'export': { const b = await db.exportBackup(); pendingText = serializeBackup(b); showText = false;
        pending = new File([pendingText], `brainiac-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' }); await render(); return toast(`Backup of ${b.records.length} records ready`); }
      case 'share': { // no await before this point: iOS requires sharing straight from the tap
        if (!pending) return; const f = pending, nav = navigator as any;
        if (nav.canShare?.({ files: [f] })) { nav.share({ files: [f], title: f.name }).then(markBackup).catch((er: Error) => { if (er.name !== 'AbortError') toast('Sharing failed. Use “Show as text” instead.', true); }); return; }
        const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); return void markBackup(); }
      case 'showtext': showText = !showText; return void (await render());
      case 'restoretext': { const t = (document.getElementById('paste') as HTMLTextAreaElement).value; if (!t.trim()) return toast('Paste the backup text first.', true); return void (await restore(t)); }
      case 'lookup': return void (await runLookup((document.getElementById('cq') as HTMLInputElement)?.value ?? '', 'lookup'));
      case 'ask': return void (await runLookup((document.getElementById('cq') as HTMLInputElement)?.value ?? '', 'ask'));
      case 'lookupq': { const t = q; view = 'command'; await render(); (document.getElementById('cq') as HTMLInputElement).value = t; return void (await runLookup(t, 'lookup')); }
      case 'saveweb': { const h = look?.hits?.[Number(id)]; if (!h) return; return void (await reviewNew({ name: h.title.slice(0, 200), description: h.summary, source: h.url.slice(0, 300) })); }
      case 'saveai': { if (!look?.answer) return; const u = look.sources?.[0]?.url; return void (await reviewNew({ name: ('AI lookup: ' + look.q).slice(0, 200), description: look.answer, source: ('AI web lookup' + (u ? ' · ' + u : '')).slice(0, 300), tags: ['web-lookup', 'ai'] })); }
      case 'savecfg': { const u = (document.getElementById('wurl') as HTMLInputElement).value.trim().replace(/\/+$/, ''), p = (document.getElementById('wpass') as HTMLInputElement).value;
        if (!validWorkerUrl(u)) return toast('Enter the full https:// address of your Worker.', true); if (!p) return toast('Enter your passphrase.', true); if (!/^[\x21-\x7e]+$/.test(p)) return toast('Passphrase: use only plain letters, numbers and symbols, with no spaces or accents.', true);
        await db.setMeta('lookupUrl', u); await db.setMeta('lookupPass', p); await render(); return toast('Saved. Tap Test connection.'); }
      case 'testcfg': { if (!cfg) return toast('Save the address and passphrase first.', true); const j = await call(cfg, '/health', undefined, 15000);
        return toast(j?.ai === true ? 'Connected. Lookup and AI are ready.' : 'Connected. Online lookup works; the Worker has no Groq key, so Ask AI is off.'); }
      case 'clearcfg': await db.setMeta('lookupUrl', ''); await db.setMeta('lookupPass', ''); look = null; await render(); return toast('Lookup settings removed');
      case 'undo': { if (!snap || !confirm(`Replace your current records with the safety copy (${snap.count} records from ${new Date(snap.ts).toLocaleString()})? Your current records will become the new safety copy.`)) return; const n = await db.undoLast(); await render(); return toast(`Restored ${n} records from the safety copy.`); }
      case 'discardsnap': if (!confirm('Permanently delete the safety copy? This cannot be undone.')) return; await db.discardSnapshot(); await render(); return toast('Safety copy deleted');
      case 'clear': if (confirm('Erase ALL records and history on this device? Export a backup first. One safety copy of your records is kept so you can undo; delete it in Setup > Safety copy if you want everything gone.') && prompt('Type ERASE to confirm') === 'ERASE') { await db.eraseAll(); pending = null; await render(); toast('All data erased (safety copy kept)'); } return;
    }
  } catch (err) { fail(err); }
});
app.addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target as HTMLFormElement;
  try {
    if (f.id.startsWith('of-')) { await ops.submit(f); return; }
    if (f.id === 'cf') { const raw = (f.elements.namedItem('cq') as HTMLInputElement).value; const sm = /^search\s+(.+)$/i.exec(raw.trim());
      if (!sm) { const r = await ops.exec(raw); if (r.handled) { view = 'command'; await render(); return toast(r.ok ? (r.changed ? 'Done' : 'OK') : 'Rejected', !r.ok); } }
      q = cleanQuery(sm ? sm[1] : raw); kind = ''; limit = 50; view = 'archive'; viewing = null; return void (await render()); }
    if (f.id === 'rf') {
      if (saving) return; saving = true;
      try {
        const d = Object.fromEntries(new FormData(f).entries()) as Record<string, string>;
        const rec = validateRecord({ ...(editing ?? draft), ...d, tags: d.tags.split(',').map(t => t.trim()).filter(Boolean) });
        if (cache.some(c => c.id !== rec.id && c.kind === rec.kind && c.name.trim().toLowerCase() === rec.name.toLowerCase()) && !confirm(`A ${rec.kind} named “${rec.name}” already exists. Save anyway?`)) return;
        await db.save(rec); editing = undefined; viewing = rec.id; await render(); toast('Saved');
      } finally { saving = false; }
    }
  } catch (err) { fail(err); }
});
app.addEventListener('keydown', e => { if (e.key === 'Enter' && ['lq', 'orq'].includes((e.target as HTMLElement).id)) e.preventDefault(); }); // Enter in the link search must not submit (save) the record form
app.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (ops.onInput(t)) return; if (t.id === 'lq') { const el = document.getElementById('lr'); if (el) el.innerHTML = linkResults(editing ?? draft, t.value); } if (t.id === 'q') { q = t.value; limit = 50; document.getElementById('list')!.innerHTML = listHtml(); } });
app.addEventListener('change', async e => {
  const t = e.target as HTMLInputElement; if (ops.onInput(t)) return;
  if (t.id === 'kf') { kind = t.value; limit = 50; document.getElementById('list')!.innerHTML = listHtml(); }
  if (t.id === 'imp' && t.files?.[0]) {
    const file = t.files[0]; t.value = '';
    try { if (file.size > MAX_IMPORT_BYTES) throw new Error('File is too large'); await restore(await file.text()); } catch (err) { fail(err); }
  }
});
// Keep the form fields visible above the iOS keyboard by hiding the nav bar only while editing a record.
document.addEventListener('focusin', e => { if ((e.target as HTMLElement).matches?.('#rf input,#rf textarea,#rf select,form[id^="of-"] input,form[id^="of-"] textarea,form[id^="of-"] select')) document.body.classList.add('kb'); });
document.addEventListener('focusout', () => document.body.classList.remove('kb'));
// Update only the status chips so a half-typed form is never wiped by a connection change.
const updateChips = () => { const c = document.getElementById('chips'); if (c) c.innerHTML = chips(); };
window.addEventListener('online', updateChips); window.addEventListener('offline', updateChips);
ops.initOps({ toast, render, records: () => cache, go: v => { view = v; editing = undefined; viewing = null; void render(); }, openRecord: id => { ops.resetView(); viewing = id; editing = undefined; view = 'archive'; void render(); }, aiAnswer: () => (look?.mode === 'ask' && look.answer ? { q: look.q, answer: look.answer } : null), updateChips: () => updateChips() });
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js').catch(() => {});
render();
db.requestPersistence().then(v => { persisted = v; updateChips(); });
