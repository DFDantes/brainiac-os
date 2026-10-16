// Stage 5 screens: COLOSSUS (missions), OMEGA (strategic project), TIMELINE, plus the Command-tab reply panel (typed + voice) and the Setup recovery panel.
// main.ts owns the page, tabs and the archive; this module owns everything Stage 5 and is wired in through `initOps`.
// Rule for every control here: it calls the same db/ops functions the Coluan commands use, then re-reads from storage before it shows anything.
import * as db from './db';
import * as O from './ops';
import { Rec, matches } from './model';
import { runCommand, Reply, Api } from './coluan';
import { browserEnv, startRecognition, speak, RecSession, RecOutcome } from './voice';

export interface Ctx { toast(t: string, bad?: boolean): void; render(): Promise<void>; records(): Rec[]; go(view: string): void; openRecord(id: string): void; aiAnswer(): { q: string; answer: string } | null; updateChips(): void }
let ctx: Ctx;
export const initOps = (c: Ctx) => { ctx = c; };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- state ----------
let missions: O.Mission[] = [], omega: O.Omega | null = null, events: O.TEvent[] = [], damaged = 0, trash: db.TrashItem[] = [], issues: O.Issue[] = [], opsOk = true;
let mSel = '', mForm: O.Mission | null = null, mFormNew = false, mQ = '', mStatus = '', mSort: O.SortKey = 'deadline', mArch = false, taskEdit = '', refQ = '';
let eForm: O.TEvent | null = null, eFormNew = false, eFilter = 'open', eCat = '', eQ = '';
let oEdit = false, msEdit = '';
let saving = false;
const cmdLog: { input: string; reply: Reply }[] = []; let cmdDraft = '';
let rec: RecSession | null = null, listening = false, vNote = '', vOutcome: RecOutcome | '' = '', vSpeech = '';

export async function loadOps() {
  try { const o = await db.getOps(); missions = o.missions; omega = o.omega; events = o.events; damaged = o.damaged; trash = await db.getTrash(); issues = await db.findOpsIssues(); opsOk = true; }
  catch { opsOk = false; missions = []; omega = null; events = []; damaged = 0; trash = []; issues = []; }
  if (mSel && !missions.some(m => m.id === mSel)) { mSel = ''; taskEdit = ''; } }
/** Tapping a tab always returns to that module's list. */
export function resetView() { mSel = ''; mForm = null; taskEdit = ''; eForm = null; oEdit = false; msEdit = ''; refQ = ''; }
export const openMission = (id: string) => { resetView(); mSel = id; };
export const cmdDraftValue = () => cmdDraft;

// ---------- small builders ----------
const today = () => O.localDate(), nowT = () => O.localTime();
const opts = (a: readonly string[], v: string) => a.map(x => `<option ${x === v ? 'selected' : ''}>${x}</option>`).join('');
const inp = (n: string, l: string, v: string, o: { max?: number; type?: string; req?: boolean; ph?: string } = {}) => `<label for="${n}">${l}</label><input id="${n}" name="${n}" type="${o.type ?? 'text'}" value="${esc(v)}" maxlength="${o.max ?? 300}" ${o.req ? 'required' : ''} ${o.ph ? `placeholder="${esc(o.ph)}"` : ''} autocomplete="off">`;
const area = (n: string, l: string, v: string, max = 5000) => `<label for="${n}">${l}</label><textarea id="${n}" name="${n}" maxlength="${max}">${esc(v)}</textarea>`;
const sel = (n: string, l: string, list: readonly string[], v: string) => `<label for="${n}">${l}</label><select id="${n}" name="${n}">${opts(list, v)}</select>`;
const dateFld = (n: string, l: string, v: string) => `<label for="${n}">${l}</label><div style="display:flex;gap:6px"><input id="${n}" name="${n}" type="date" value="${esc(v)}" style="flex:1;min-width:0"><button type="button" data-act="o:cleardate" data-id="${n}" aria-label="Clear ${l}">Clear</button></div>`;
const pick = (n: string, l: string, items: { id: string; label: string }[], v: string, none: string) => `<label for="${n}">${l}</label><select id="${n}" name="${n}"><option value="">${none}</option>${items.map(i => `<option value="${esc(i.id)}" ${i.id === v ? 'selected' : ''}>${esc(clip(i.label, 50))}</option>`).join('')}</select>`;
const chip = (t: string, c = '') => `<span class="chip ${c}">${esc(t)}</span>`;
const bar = (p: O.Progress, what = 'objectives') => p.pct === null ? '<div class="muted">No objectives recorded yet, so there is no progress figure.</div>' : `<div class="bar" role="img" aria-label="${p.pct}% complete"><i style="width:${p.pct}%"></i></div><div class="muted">${p.done} of ${p.total} ${what} complete (${p.pct}%)</div>`;
const prov = (t: 'derived' | 'user') => chip(t === 'derived' ? 'SYSTEM-DERIVED' : 'USER-ENTERED');
const mName = (id: string) => missions.find(m => m.id === id)?.title;
const stChip = (s: string) => chip(s, s === 'completed' ? 'ok' : s === 'cancelled' ? 'bad' : s === 'paused' ? 'warn' : '');
const prChip = (p: string) => chip(p, p === 'critical' ? 'bad' : p === 'high' ? 'warn' : '');
const ruler = (t: string) => `<h2>${t}</h2>`;
const empty = (t: string) => `<div class="panel muted">${t}</div>`;
const small = (t: string) => `<p class="muted">${t}</p>`;
async function after(msg: string) { const y = window.scrollY; await ctx.render(); if (y) window.scrollTo(0, y); ctx.toast(msg); }
const fail = (e: unknown) => ctx.toast((e as Error)?.message || 'Something went wrong. Nothing was saved.', true);
const getM = (id: string) => missions.find(m => m.id === id);

// ================= COLOSSUS =================
function missionRow(m: O.Mission) { const p = O.missionProgress(m), od = O.missionOverdue(m, today());
  return `<button class="item" data-act="o:mopen" data-id="${esc(m.id)}"><b>${esc(m.title)}</b><small>${stChip(m.status)} ${prChip(m.priority)}${od ? chip('OVERDUE', 'bad') : ''}${m.archived ? chip('archived') : ''}</small><small>${p.pct === null ? 'no objectives yet' : `${p.done}/${p.total} objectives (${p.pct}%)`}${m.deadline ? ' · due ' + O.fmtDate(m.deadline) : ''}${m.tags.length ? ' · ' + esc(m.tags.join(', ')) : ''}</small></button>`; }
function missionListHtml() {
  const rows = O.sortMissions(O.searchMissions(missions, mQ, mStatus, mArch), mSort);
  if (!missions.length) return empty('No missions yet. Tap “+ New mission”, or use the Command tab: <b>mission new &lt;title&gt;</b>. Nothing here is sample data.');
  return rows.length ? rows.map(missionRow).join('') : empty(mArch ? 'No archived missions match.' : 'No missions match these filters.'); }
function missionForm(m: O.Mission) {
  return `<form id="of-mission"><h2>${mFormNew ? 'New mission' : 'Edit mission'}</h2>${inp('title', 'Title', m.title, { max: 200, req: true })}${area('objective', 'Objective (one line: what success means)', m.objective, 1000)}${area('description', 'Description', m.description)}
  ${sel('status', 'Status', O.M_STATUS, m.status)}${sel('priority', 'Priority', O.PRIORITY, m.priority)}${dateFld('deadline', 'Deadline (optional)', m.deadline)}${inp('tags', 'Tags (comma separated)', m.tags.join(', '), { max: 1200 })}${area('notes', 'Notes', m.notes)}
  <button class="pri" type="submit">Save</button><button type="button" data-act="o:mcancel">Cancel</button></form>`; }
function taskRows(m: O.Mission) {
  const blocked = O.blockedTasks(m); if (!m.tasks.length) return empty('No objectives yet. Add the first actionable step below.');
  return m.tasks.map((t, i) => { const b = blocked.get(t.id);
    if (taskEdit === t.id) return `<form id="of-taskedit" class="panel" data-id="${esc(t.id)}">${inp('text', 'Objective', t.text, { max: 500, req: true })}${area('notes', 'Notes / findings', t.notes, 2000)}<label>Waits for (dependencies)</label>${m.tasks.filter(x => x.id !== t.id).map(x => `<label style="display:flex;gap:8px;align-items:center;color:var(--ink);min-height:44px"><input type="checkbox" name="dep" value="${esc(x.id)}" ${t.dependsOn.includes(x.id) ? 'checked' : ''} style="width:auto;min-height:0;margin:0"> #${m.tasks.indexOf(x) + 1} ${esc(clip(x.text, 50))}</label>`).join('') || small('No other objectives to depend on.')}<button class="pri" type="submit">Save</button><button type="button" data-act="o:tcancel">Cancel</button></form>`;
    return `<div class="panel" style="${b ? 'border-color:var(--warn)' : ''}"><div style="display:flex;gap:10px;align-items:flex-start"><button type="button" data-act="o:ttoggle" data-id="${esc(t.id)}" aria-label="${t.done ? 'Reopen' : 'Mark complete'}: ${esc(t.text)}" aria-pressed="${t.done}" style="width:44px;flex:none;margin:0">${t.done ? '☑' : '☐'}</button>
    <div style="flex:1;min-width:0;overflow-wrap:anywhere"><span style="${t.done ? 'text-decoration:line-through;color:var(--dim)' : ''}">#${i + 1} ${esc(t.text)}</span>${b ? `<br>${chip('BLOCKED', 'warn')} <span class="muted">waiting on: ${b.map(x => esc(clip(x, 40))).join(', ')}</span>` : ''}${t.notes ? `<br><span class="muted" style="white-space:pre-wrap">${esc(t.notes)}</span>` : ''}</div></div>
    <div style="margin-top:6px"><button type="button" data-act="o:tup" data-id="${esc(t.id)}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-act="o:tdown" data-id="${esc(t.id)}" aria-label="Move down" ${i === m.tasks.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-act="o:tedit" data-id="${esc(t.id)}">Edit</button><button type="button" class="danger" data-act="o:tdel" data-id="${esc(t.id)}">Delete</button></div></div>`; }).join(''); }
const refRows = (ids: string[], t: 'mission' | 'omega') => ids.length ? ids.map(id => { const r = ctx.records().find(x => x.id === id);
  return `<div class="panel" style="display:flex;gap:8px;align-items:center;justify-content:space-between"><span style="overflow-wrap:anywhere;min-width:0">${r ? `<button type="button" class="item" data-act="o:openrec" data-id="${esc(id)}" style="margin:0"><b>${esc(r.name)}</b><small>${r.kind} · evidence: ${r.confidence}</small></button>` : `<span style="color:var(--warn)">Missing archive record</span> <small class="muted">${esc(id)}</small>`}</span><button type="button" data-act="o:delref" data-t="${t}" data-id="${esc(id)}" aria-label="Remove reference">Remove</button></div>`; }).join('') : empty('No archive records referenced. Reference intelligence this work depends on.');
const refPicker = (t: 'mission' | 'omega') => `<label for="orq">Reference an archive record: search by name</label><input id="orq" data-t="${t}" placeholder="Type a name" autocomplete="off" enterkeyhint="done"><div id="orr"></div>`;
function refResults(t: string, term: string) { const x = term.trim(); if (!x) return ''; const have = t === 'omega' ? omega?.archiveRefs ?? [] : getM(mSel)?.archiveRefs ?? [];
  const rows = ctx.records().filter(r => !have.includes(r.id) && matches(r, x)).slice(0, 8); return rows.length ? rows.map(r => `<button type="button" class="item" data-act="o:addref" data-t="${t}" data-id="${esc(r.id)}"><b>${esc(r.name)}</b><small>${r.kind} · tap to reference</small></button>`).join('') : small('No matching archive record.'); }
function missionDetail(m: O.Mission) {
  const p = O.missionProgress(m), od = O.missionOverdue(m, today()), evs = O.sortTimeline(events.filter(e => e.missionId === m.id).map(e => ({ key: e.id, date: e.date, time: e.time, title: e.title, state: O.eventState(e, today(), nowT()), derived: false, source: 'event', event: e, priority: e.priority, category: e.category })));
  const inO = !!omega && (omega.missionIds.includes(m.id) || omega.milestones.some(x => x.missionId === m.id));
  return `<button data-act="o:mback">← Missions</button><button class="pri" data-act="o:medit" data-id="${esc(m.id)}">Edit</button><button data-act="o:mdup" data-id="${esc(m.id)}">Duplicate</button><button data-act="o:march" data-id="${esc(m.id)}">${m.archived ? 'Unarchive' : 'Archive'}</button><button class="danger" data-act="o:mdel" data-id="${esc(m.id)}">Delete</button>
  <div class="panel" style="margin-top:10px"><b style="color:var(--g);font-size:17px;overflow-wrap:anywhere">${esc(m.title)}</b><p>${stChip(m.status)} ${prChip(m.priority)}${od ? chip('OVERDUE', 'bad') : ''}${m.archived ? chip('archived') : ''} ${m.tags.map(t => chip(t)).join('')}</p>
  ${m.objective ? `<p><span class="muted">Objective </span>${prov('user')}<br><span style="overflow-wrap:anywhere">${esc(m.objective)}</span></p>` : ''}${m.description ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.description)}</p>` : ''}
  <p class="muted">Deadline: ${m.deadline ? O.fmtDate(m.deadline) + (od ? ` · ${O.daysBetween(m.deadline, today())} day(s) past, mission is still ${m.status}` : '') : 'none set'} ${prov('user')}</p>
  <p class="muted">Progress ${prov('derived')}</p>${bar(p)}</div>
  ${ruler('Objectives')}${taskRows(m)}<form id="of-task" data-id="${esc(m.id)}">${inp('text', 'Add an objective', '', { max: 500, ph: 'What must be done?' })}<button class="pri" type="submit">Add objective</button></form>
  ${ruler('Risks, constraints and assumptions ' + prov('user'))}${m.risks.length ? m.risks.map(r => `<div class="panel" style="overflow-wrap:anywhere">${chip(r.kind, r.kind === 'risk' ? 'warn' : '')} ${esc(r.text)}${r.mitigation ? `<br><span class="muted">Mitigation: ${esc(r.mitigation)}</span>` : ''}<br><button type="button" class="danger" data-act="o:rdel" data-id="${esc(r.id)}" style="margin-top:6px">Delete</button></div>`).join('') : empty('None recorded. The app does not discover risks; it only keeps the ones you enter.')}
  <form id="of-risk" data-id="${esc(m.id)}">${sel('kind', 'Type', O.RISK_KIND, 'risk')}${inp('text', 'Description', '', { max: 1000 })}${inp('mitigation', 'Mitigation (optional)', '', { max: 1000 })}<button type="submit">Add</button></form>
  ${ruler('Resources and requirements ' + prov('user'))}${m.resources.length ? m.resources.map(r => `<div class="panel" style="overflow-wrap:anywhere">${chip(r.needed ? 'needed' : 'have', r.needed ? 'warn' : 'ok')} <b>${esc(r.name)}</b>${r.note ? `<br><span class="muted">${esc(r.note)}</span>` : ''}<br><button type="button" class="danger" data-act="o:resdel" data-id="${esc(r.id)}" style="margin-top:6px">Delete</button></div>`).join('') : empty('None recorded. These are your own notes; the app has no access to any game server or inventory.')}
  <form id="of-res" data-id="${esc(m.id)}">${inp('name', 'Resource', '', { max: 200 })}${inp('note', 'Note (optional)', '', { max: 1000 })}<label style="display:flex;gap:8px;align-items:center;color:var(--ink);min-height:44px"><input type="checkbox" name="needed" checked style="width:auto;min-height:0;margin:0"> Still needed (untick if you already have it)</label><button type="submit">Add</button></form>
  ${ruler('Archive references')}${refRows(m.archiveRefs, 'mission')}${refPicker('mission')}
  ${ruler('Timeline events')}${evs.length ? evs.map(e => `<div class="panel">${chip(e.state, e.state === 'overdue' ? 'bad' : e.state === 'done' ? 'ok' : '')} ${esc(O.fmtDate(e.date))}${e.time ? ' ' + e.time : ''} · ${esc(e.title)}</div>`).join('') : empty('No timeline events linked to this mission.')}<button data-act="o:evnew" data-id="${esc(m.id)}">+ Add event for this mission</button>
  ${ruler('Project OMEGA')}${inO ? `<div class="panel">Linked to Project OMEGA. <button type="button" data-act="o:goomega" style="margin-top:6px">Open OMEGA</button></div>` : omega ? `<div class="panel muted">Not linked to Project OMEGA.</div><button data-act="o:olinkm" data-id="${esc(m.id)}">Link to Project OMEGA</button>` : empty('No Project OMEGA exists yet (OMEGA tab).')}
  ${m.notes ? ruler('Notes') + `<div class="panel" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.notes)}</div>` : ''}<p class="muted">Created ${esc(new Date(m.created).toLocaleString())} · Changed ${esc(new Date(m.modified).toLocaleString())}</p>`; }
function colossusBody() {
  if (!opsOk) return empty('The mission store could not be read. Your archive is unaffected. Reload the app; if this persists, restore from a backup (Setup).');
  if (mForm) return missionForm(mForm); const m = mSel ? getM(mSel) : undefined; if (m) return missionDetail(m);
  const c = O.missionCounts(missions, today());
  return `${damaged ? `<div class="panel" style="border-color:var(--warn)">${damaged} stored item(s) could not be read and are being skipped. They were NOT deleted. Restore from a backup if items are missing.</div>` : ''}
  <div class="panel"><div class="chips">${chip(c.total + ' missions')}${O.M_STATUS.map(s => chip(`${c.byStatus[s]} ${s}`, s === 'active' && c.byStatus[s] ? 'ok' : '')).join('')}${chip(c.overdue + ' overdue', c.overdue ? 'bad' : '')}${chip(c.openTasks + ' open objectives')}</div><p class="muted" style="margin:0">Counts ${prov('derived')} from stored missions${c.archived ? ` · ${c.archived} archived (hidden)` : ''}.</p></div>
  <button class="pri" data-act="o:mnew">+ New mission</button>
  <input id="mq" type="search" placeholder="Search missions" value="${esc(mQ)}" aria-label="Search missions" style="margin-top:8px"><select id="mst" aria-label="Status filter"><option value="">All statuses</option>${O.M_STATUS.map(s => `<option ${s === mStatus ? 'selected' : ''}>${s}</option>`).join('')}</select>
  <select id="msort" aria-label="Sort missions">${(['deadline', 'priority', 'updated', 'title'] as const).map(s => `<option value="${s}" ${s === mSort ? 'selected' : ''}>Sort: ${s}</option>`).join('')}</select>
  <label style="display:flex;gap:8px;align-items:center;color:var(--ink);min-height:44px"><input id="march" type="checkbox" ${mArch ? 'checked' : ''} style="width:auto;min-height:0;margin:0"> Show archived missions only</label><div id="mlist" style="margin-top:8px">${missionListHtml()}</div>`; }

// ================= TIMELINE =================
function eventForm(e: O.TEvent) {
  return `<form id="of-event"><h2>${eFormNew ? 'New event' : 'Edit event'}</h2>${inp('title', 'Title', e.title, { max: 200, req: true })}${area('description', 'Description', e.description, 3000)}${dateFld('date', 'Date (required)', e.date)}${inp('time', 'Time (optional)', e.time, { type: 'time', max: 5 })}
  ${sel('category', 'Category (history = already happened)', O.E_CATEGORY, e.category)}${sel('priority', 'Priority', O.PRIORITY, e.priority)}${sel('status', 'Status', O.E_STATUS, e.status)}
  ${pick('missionId', 'Linked mission (optional)', missions.filter(m => !m.archived || m.id === e.missionId).map(m => ({ id: m.id, label: m.title })), e.missionId, 'None')}${omega ? pick('milestoneId', 'Linked OMEGA milestone (optional)', omega.milestones.map(m => ({ id: m.id, label: m.title })), e.milestoneId, 'None') : ''}
  <button class="pri" type="submit">Save</button><button type="button" data-act="o:ecancel">Cancel</button>${eFormNew ? '' : `<button type="button" class="danger" data-act="o:edel" data-id="${esc(e.id)}">Delete</button>`}</form>`; }
const GROUPS: [O.EState, string][] = [['overdue', 'Overdue (planned, date has passed)'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['done', 'Done / recorded history'], ['cancelled', 'Cancelled']];
function eventRow(i: O.TItem) {
  const e = i.event, mn = i.missionId ? mName(i.missionId) : '', ms = i.milestoneId && omega ? omega.milestones.find(x => x.id === i.milestoneId)?.title : '';
  return `<div class="panel" style="${i.state === 'overdue' ? 'border-color:var(--bad)' : ''}"><div style="overflow-wrap:anywhere">${chip(i.state.toUpperCase(), i.state === 'overdue' ? 'bad' : i.state === 'done' ? 'ok' : i.state === 'today' ? 'warn' : '')} ${chip(i.category)} ${prChip(i.priority)}<br><b>${esc(i.title)}</b><br><span class="muted">${esc(O.fmtDate(i.date))}${i.time ? ' · ' + i.time : ' · all day'}</span>
  ${e?.description ? `<br><span class="muted" style="white-space:pre-wrap">${esc(clip(e.description, 300))}</span>` : ''}${mn ? `<br><span class="muted">Mission: </span><button type="button" class="linkbtn" data-act="o:gomission" data-id="${esc(i.missionId!)}">${esc(clip(mn, 40))}</button>` : i.missionId ? '<br><span style="color:var(--warn)">Linked mission is missing</span>' : ''}${ms ? `<br><span class="muted">OMEGA milestone: ${esc(clip(ms, 40))}</span>` : ''}
  ${i.derived ? `<br><span class="muted">${chip('SYSTEM-DERIVED')} from ${i.source}. Edit it there; it is not stored as an event.</span>` : ''}</div>
  <div style="margin-top:6px">${e ? `<button type="button" data-act="o:edone" data-id="${esc(e.id)}" ${e.category === 'history' && e.status === 'done' ? 'disabled' : ''}>${e.status === 'done' ? 'Reopen' : 'Mark done'}</button><button type="button" data-act="o:eedit" data-id="${esc(e.id)}">Edit</button><button type="button" class="danger" data-act="o:edel" data-id="${esc(e.id)}">Delete</button>` : i.missionId ? `<button type="button" data-act="o:gomission" data-id="${esc(i.missionId)}">Open mission</button>` : '<button type="button" data-act="o:goomega">Open OMEGA</button>'}</div></div>`; }
function eventListHtml() {
  const q = eQ.toLowerCase().split(/\s+/).filter(Boolean), all = O.timelineItems(events, missions, omega, today(), nowT()).filter(i => (!eCat || i.category === eCat) && q.every(w => (i.title + ' ' + (i.event?.description ?? '')).toLowerCase().includes(w)));
  const keep = eFilter === 'all' ? all : eFilter === 'open' ? all.filter(i => ['overdue', 'today', 'upcoming'].includes(i.state)) : all.filter(i => i.state === eFilter);
  if (!keep.length) return empty(events.length || missions.some(m => m.deadline) || omega ? 'Nothing matches this filter.' : 'The timeline is empty. Add a planned operation, a deadline, or record something that already happened. Mission deadlines and OMEGA milestone dates appear here automatically.');
  const sorted = O.sortTimeline(keep, eFilter === 'done' || eFilter === 'cancelled');
  return GROUPS.map(([s, title]) => { const g = sorted.filter(i => i.state === s); return g.length ? `<h2>${title} (${g.length})</h2>${g.map(eventRow).join('')}` : ''; }).join(''); }
function timelineBody() {
  if (!opsOk) return empty('The timeline store could not be read. Your archive is unaffected. Reload the app, or restore from a backup (Setup).'); if (eForm) return eventForm(eForm);
  return `<button class="pri" data-act="o:enew">+ New event</button><p class="muted">Today on this device: ${esc(O.fmtDate(today()))}. Overdue means a planned item whose date has passed; nothing is ever marked done automatically.</p>
  <select id="ef" aria-label="Timeline filter">${([['open', 'Upcoming and overdue'], ['overdue', 'Overdue only'], ['today', 'Today'], ['upcoming', 'Upcoming only'], ['done', 'Done and history'], ['cancelled', 'Cancelled'], ['all', 'Everything']] as const).map(([v, l]) => `<option value="${v}" ${v === eFilter ? 'selected' : ''}>${l}</option>`).join('')}</select>
  <select id="ec" aria-label="Category filter"><option value="">All categories</option>${O.E_CATEGORY.map(c => `<option ${c === eCat ? 'selected' : ''}>${c}</option>`).join('')}</select><input id="eq" type="search" placeholder="Search timeline" value="${esc(eQ)}" aria-label="Search timeline"><div id="elist">${eventListHtml()}</div>`; }

// ================= OMEGA =================
function omegaBody() {
  if (!opsOk) return empty('The OMEGA store could not be read. Your archive is unaffected. Reload the app, or restore from a backup (Setup).');
  if (!omega) return `${empty('Project OMEGA does not exist yet. It is your own strategic project record: purpose, milestones, linked missions, hypotheses, options, decisions and lessons. It stores what you enter and calculates progress from it; it does not predict outcomes or discover information.')}
  <form id="of-onew">${inp('name', 'Project name', 'Project OMEGA', { max: 200, req: true })}${area('purpose', 'Purpose (what is this project for?)', '', 3000)}<button class="pri" type="submit">Create Project OMEGA</button></form>`;
  const o = omega; if (oEdit) return `<form id="of-omega"><h2>Edit project</h2>${inp('name', 'Project name', o.name, { max: 200, req: true })}${area('purpose', 'Purpose', o.purpose, 3000)}${sel('status', 'Status', O.M_STATUS, o.status)}${sel('priority', 'Priority', O.PRIORITY, o.priority)}${area('constraints', 'Constraints', o.constraints, 3000)}${area('notes', 'Notes', o.notes)}${area('lessons', 'Lessons learned', o.lessons)}<button class="pri" type="submit">Save</button><button type="button" data-act="o:ocancel">Cancel</button></form>`;
  const mt = O.omegaMetrics(o, missions), mech = ctx.records().filter(r => r.kind === 'mechanic'), gaps = mech.filter(r => r.tags.includes('needs-detail'));
  const mission = (id: string) => { const m = getM(id); return m ? `<div class="panel" style="display:flex;gap:8px;justify-content:space-between;align-items:center"><button type="button" class="item" data-act="o:gomission" data-id="${esc(id)}" style="margin:0;flex:1"><b>${esc(m.title)}</b><small>${stChip(m.status)} ${O.missionProgress(m).pct === null ? 'no objectives' : O.missionProgress(m).done + '/' + O.missionProgress(m).total + ' objectives'}</small></button>${o.missionIds.includes(id) ? `<button type="button" data-act="o:ounlink" data-id="${esc(id)}">Unlink</button>` : '<span class="muted">via milestone</span>'}</div>` : `<div class="panel" style="border-color:var(--warn)">Linked mission no longer exists <small class="muted">${esc(id)}</small><br><button type="button" data-act="o:ounlink" data-id="${esc(id)}">Remove link</button></div>`; };
  const unl = missions.filter(m => !m.archived && !o.missionIds.includes(m.id));
  return `<div class="panel"><b style="color:var(--g);font-size:17px;overflow-wrap:anywhere">${esc(o.name)}</b><p>${stChip(o.status)} ${prChip(o.priority)}</p>${o.purpose ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere"><span class="muted">Purpose </span>${prov('user')}<br>${esc(o.purpose)}</p>` : '<p class="muted">No purpose recorded yet. Edit the project to add one.</p>'}${o.constraints ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere"><span class="muted">Constraints </span>${prov('user')}<br>${esc(o.constraints)}</p>` : ''}${o.notes ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere" class="muted">${esc(o.notes)}</p>` : ''}
  <button class="pri" data-act="o:oedit">Edit project</button><button class="danger" data-act="o:odel">Delete project</button></div>
  ${ruler('Progress ' + prov('derived'))}<div class="panel"><p class="muted" style="margin-top:0">Milestones you marked done</p>${mt.milestones.pct === null ? '<div class="muted">No milestones recorded, so no figure.</div>' : bar(mt.milestones, 'milestones')}<p class="muted">Objectives inside linked missions${mt.cancelledSkipped ? ` (${mt.cancelledSkipped} cancelled mission(s) skipped)` : ''}</p>${mt.tasks.pct === null ? '<div class="muted">Linked missions have no objectives, so no figure.</div>' : bar(mt.tasks)}
  <p class="muted" style="margin-bottom:0">These percentages count what you recorded. They are not forecasts and say nothing about whether the plan will succeed. Missing or contradictory data is listed below instead of being averaged away.</p></div>
  ${mt.conflicts.length ? `<div class="panel" style="border-color:var(--warn)"><b>Conflicts (${mt.conflicts.length})</b>${mt.conflicts.map(c => `<p style="margin:6px 0;overflow-wrap:anywhere">${esc(c)}</p>`).join('')}</div>` : ''}${mt.missing.length ? `<div class="panel" style="border-color:var(--warn)">${mt.missing.length} linked mission(s) no longer exist. Remove the link, or use Setup &gt; Missions &amp; OMEGA check.</div>` : ''}
  ${ruler('Server rules on record')}<div class="panel muted">${mech.length ? `${mech.length} mechanic record(s) in the Living Archive${gaps.length ? `; <b style="color:var(--warn)">${gaps.length} still marked “needs-detail”</b> (${gaps.slice(0, 4).map(r => esc(r.name)).join(', ')}${gaps.length > 4 ? ', …' : ''}). Any plan that relies on their rules rests on information you have not recorded.` : '. None are marked as missing detail.'}` : 'No mechanic records in the archive. Plans that depend on Palladium or addon rules cannot be checked against anything.'}</div>
  ${ruler('Milestones ' + prov('user'))}${o.milestones.length ? o.milestones.map(ms => msEdit === ms.id ? `<form id="of-msedit" class="panel" data-id="${esc(ms.id)}">${inp('title', 'Milestone', ms.title, { max: 200, req: true })}${dateFld('target', 'Target date (optional)', ms.target)}${pick('missionId', 'Linked mission', missions.filter(m => !m.archived || m.id === ms.missionId).map(m => ({ id: m.id, label: m.title })), ms.missionId, 'None')}${area('notes', 'Notes', ms.notes, 1000)}<button class="pri" type="submit">Save</button><button type="button" data-act="o:mscancel">Cancel</button></form>`
    : `<div class="panel" style="overflow-wrap:anywhere"><div style="display:flex;gap:10px;align-items:flex-start"><button type="button" data-act="o:mstoggle" data-id="${esc(ms.id)}" aria-pressed="${ms.done}" aria-label="${ms.done ? 'Reopen' : 'Mark done'}: ${esc(ms.title)}" style="width:44px;flex:none;margin:0">${ms.done ? '☑' : '☐'}</button><div style="min-width:0"><b style="${ms.done ? 'text-decoration:line-through;color:var(--dim)' : ''}">${esc(ms.title)}</b><br><span class="muted">${ms.target ? esc(O.fmtDate(ms.target)) + (!ms.done && ms.target < today() ? ' · PAST DATE, still open' : '') : 'no target date'}${ms.missionId ? ' · mission: ' + esc(mName(ms.missionId) ?? 'MISSING') : ''}</span>${ms.notes ? `<br><span class="muted">${esc(ms.notes)}</span>` : ''}</div></div><div style="margin-top:6px"><button type="button" data-act="o:msedit" data-id="${esc(ms.id)}">Edit</button><button type="button" class="danger" data-act="o:msdel" data-id="${esc(ms.id)}">Delete</button></div></div>`).join('') : empty('No milestones yet. A milestone is a measurable checkpoint you define.')}
  <form id="of-ms">${inp('title', 'Add a milestone', '', { max: 200 })}${dateFld('target', 'Target date (optional)', '')}${pick('missionId', 'Linked mission (optional)', missions.filter(m => !m.archived).map(m => ({ id: m.id, label: m.title })), '', 'None')}<button class="pri" type="submit">Add milestone</button></form>
  ${ruler('Linked missions (' + mt.linkedMissions.length + (mt.missing.length ? ' + ' + mt.missing.length + ' missing' : '') + ')')}${[...new Set([...o.missionIds, ...o.milestones.map(m => m.missionId).filter(Boolean)])].map(mission).join('') || empty('No missions linked. Link existing Colossus missions so their objectives feed the progress figure.')}
  ${unl.length ? `<label for="olsel">Link a mission</label><select id="olsel">${unl.map(m => `<option value="${esc(m.id)}">${esc(clip(m.title, 50))}</option>`).join('')}</select><button data-act="o:olink">Link mission</button>` : small(missions.length ? 'All missions are already linked.' : 'Create missions in the COLOSSUS tab first.')}
  ${ruler('Hypotheses and assumptions')}${small('Each is tagged with where it came from. Nothing here is a verified fact.')}${o.hypotheses.length ? o.hypotheses.map(h => `<div class="panel" style="overflow-wrap:anywhere">${chip(h.origin === 'ai' ? 'AI-SUGGESTED · UNVERIFIED' : 'USER-ENTERED', h.origin === 'ai' ? 'warn' : '')} ${chip('confidence: ' + h.confidence)}<br>${esc(h.text)}${h.basis ? `<br><span class="muted">Basis: ${esc(h.basis)}</span>` : ''}<br><button type="button" class="danger" data-act="o:hypdel" data-id="${esc(h.id)}" style="margin-top:6px">Delete</button></div>`).join('') : empty('None recorded.')}
  <form id="of-hyp">${area('text', 'Add a hypothesis', '', 1000)}${inp('basis', 'Basis / evidence (optional)', '', { max: 1000 })}${sel('confidence', 'Your confidence', O.LEVEL, 'unknown')}<button type="submit">Add hypothesis</button></form>
  ${ruler('Strategic options and alternative plans')}${o.options.length ? o.options.map(x => `<div class="panel" style="overflow-wrap:anywhere">${x.fallback ? chip('FALLBACK PLAN', 'warn') : chip('option')} <b>${esc(x.title)}</b>${x.expected ? `<br><span class="muted">Expected outcome (your estimate): ${esc(x.expected)}</span>` : ''}${x.risks ? `<br><span class="muted">Risks: ${esc(x.risks)}</span>` : ''}${x.countermeasure ? `<br><span class="muted">Countermeasure: ${esc(x.countermeasure)}</span>` : ''}<br><button type="button" class="danger" data-act="o:optdel" data-id="${esc(x.id)}" style="margin-top:6px">Delete</button></div>`).join('') : empty('None recorded.')}
  <form id="of-opt">${inp('title', 'Add an option', '', { max: 200 })}${area('expected', 'Expected outcome (your estimate, uncertain)', '', 1000)}${area('risks', 'Risks', '', 1000)}${area('countermeasure', 'Countermeasure', '', 1000)}<label style="display:flex;gap:8px;align-items:center;color:var(--ink);min-height:44px"><input type="checkbox" name="fallback" style="width:auto;min-height:0;margin:0"> This is an alternative / fallback plan</label><button type="submit">Add option</button></form>
  ${ruler('Decisions and rationale')}${o.decisions.length ? [...o.decisions].reverse().map(d => `<div class="panel" style="overflow-wrap:anywhere"><span class="muted">${esc(d.date ? O.fmtDate(d.date) : 'undated')}</span><br><b>${esc(d.decision)}</b>${d.rationale ? `<br><span class="muted">Why: ${esc(d.rationale)}</span>` : '<br><span class="muted">No rationale recorded.</span>'}${d.lesson ? `<br><span class="muted">Lesson: ${esc(d.lesson)}</span>` : ''}<br><button type="button" class="danger" data-act="o:decdel" data-id="${esc(d.id)}" style="margin-top:6px">Delete</button></div>`).join('') : empty('None recorded.')}
  <form id="of-dec">${area('decision', 'Record a decision', '', 1000)}${area('rationale', 'Rationale', '', 2000)}${area('lesson', 'Lesson learned (optional)', '', 2000)}${dateFld('date', 'Date', today())}<button type="submit">Record decision</button></form>
  ${o.lessons ? ruler('Lessons learned') + `<div class="panel" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(o.lessons)}</div>` : ''}
  ${ruler('Archive references')}${refRows(o.archiveRefs, 'omega')}${refPicker('omega')}
  ${ruler('Backup')}<div class="panel muted">This project, your missions and your timeline events are included in Setup &gt; Prepare backup, and in the safety copy taken before a restore or erase. Deleting the project goes to Setup &gt; Recently deleted.</div>`; }

/** Several forms use the same field names (text, title, name). Prefix every id/for inside a form with the form's id so ids are unique in the page and labels point at the right field. */
const scopeIds = (html: string) => html.replace(/<form id="([^"]+)"([\s\S]*?)<\/form>/g, (_m, fid: string, rest: string) => `<form id="${fid}"${rest.replace(/ id="([^"]+)"/g, ` id="${fid}-$1"`).replace(/ for="([^"]+)"/g, ` for="${fid}-$1"`)}</form>`);
export function opsBody(view: string) { return scopeIds(view === 'colossus' ? colossusBody() : view === 'omega' ? omegaBody() : timelineBody()); }

// ================= COMMAND TAB (typed commands, replies, voice) =================
const apiImpl = (): Api => ({ ops: async () => { const o = await db.getOps(); return { missions: o.missions, omega: o.omega, events: o.events }; }, records: () => db.getAll(), saveMission: db.saveMission, mutateMission: db.mutateMission, deleteMission: db.deleteMission,
  saveEvent: db.saveEvent, deleteEvent: db.deleteEvent, saveOmega: db.saveOmega, mutateOmega: db.mutateOmega, confirm: m => window.confirm(m), now: () => new Date() });
/** Runs a typed or dictated command. Returns handled:false when it is not an ops command, so the caller can fall back to the archive search. */
export async function exec(input: string): Promise<Reply> {
  const r = await runCommand(input, apiImpl()); if (!r.handled) return r;
  cmdLog.unshift({ input: input.trim().slice(0, 300), reply: r }); cmdLog.length = Math.min(cmdLog.length, 6); cmdDraft = r.ok ? '' : input; return r; }
export function voiceChip(): { text: string; cls: string } {
  const e = browserEnv(); if (!e.Recognition && !e.synth) return { text: 'VOICE UNSUPPORTED HERE', cls: '' };
  if (vOutcome === 'transcribed') return { text: 'MIC HEARD TEXT (THIS SESSION)', cls: 'ok' }; if (vOutcome) return { text: 'MIC: ' + vOutcome.toUpperCase(), cls: 'bad' }; return { text: 'VOICE UNVERIFIED', cls: '' }; }
export function cmdPanel(): string {
  const e = browserEnv(), last = cmdLog[0];
  return `<div class="chips" style="margin-top:8px">${e.Recognition ? `<button type="button" data-act="${listening ? 'o:micstop' : 'o:mic'}" style="margin:0 6px 6px 0">${listening ? '■ Stop listening' : '🎤 Speak a command'}</button>` : ''}${e.synth && last ? '<button type="button" data-act="o:read" style="margin:0 6px 6px 0">🔊 Read last reply aloud</button>' : ''}<button type="button" data-act="o:help" style="margin:0 0 6px 0">Commands</button></div>
  <div id="vstat" class="muted" role="status">${esc(vNote || (e.Recognition ? 'Voice input is untested on this device until you try it. Dictated text only fills the box; you review it and tap Run.' : 'Speech input is not available in this browser. Type commands, or use your keyboard’s own dictation key.'))}${vSpeech ? ' ' + esc(vSpeech) : ''}</div>
  ${cmdLog.length ? `<h2>Replies</h2>${cmdLog.map(c => `<div class="panel" style="${c.reply.ok ? '' : 'border-color:var(--bad)'}"><span class="muted" style="overflow-wrap:anywhere">&gt; ${esc(c.input)}</span><div style="white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px">${esc(c.reply.text)}</div></div>`).join('')}` : ''}`; }
const setVNote = (t: string) => { vNote = t; const el = document.getElementById('vstat'); if (el) el.textContent = t + (vSpeech ? ' ' + vSpeech : ''); };
const MIC_MSG: Record<RecOutcome, string> = { transcribed: '', 'no-speech': 'No speech was heard. Try again, closer to the microphone, or type the command.', blocked: 'Speech recognition was refused (microphone or speech permission denied, or the service is off). Type the command instead.',
  error: 'Speech recognition reported an error. Type the command instead.', 'no-start': 'Nothing happened: this browser exposes speech recognition but it did not start. This is common in installed iPhone apps. Type the command, or use the keyboard’s dictation key.',
  'ended-empty': 'Listening ended without any text. Try again or type the command.', 'start-threw': 'The browser refused to start speech recognition. Type the command instead.', unsupported: 'Speech input is not supported in this browser. Type the command instead.' };

// ================= SETUP PANEL =================
export function setupHtml(): string {
  const names: Record<string, string> = { mission: 'Mission', event: 'Event', omega: 'Project OMEGA' };
  return `<h2>Missions, OMEGA and timeline</h2><div class="panel"><p class="muted">${missions.length} missions · ${events.length} events · ${omega ? 'Project OMEGA exists' : 'no OMEGA project'}. Included in backups and in the safety copy. Their edits are not kept in a per-item history; deletions are recoverable below.</p>
  ${damaged ? `<p style="color:var(--warn)">${damaged} stored item(s) are unreadable and are skipped (not deleted).</p>` : ''}${issues.length ? `<p style="color:var(--warn)">${issues.length} reference(s) point to things that no longer exist (e.g. a deleted archive record): ${issues.slice(0, 4).map(i => esc(i.where)).join('; ')}${issues.length > 4 ? '; …' : ''}. Nothing is changed until you choose.</p><button data-act="o:fixrefs">Remove broken references</button>` : '<p class="muted">No broken references.</p>'}</div>
  <h2>Recently deleted (missions, events, OMEGA)</h2><div class="panel">${trash.length ? trash.slice(0, 10).map(t => `<p style="overflow-wrap:anywhere"><b>${esc(clip(t.title, 60))}</b> <span class="muted">${names[t.type]} · deleted ${esc(new Date(t.ts).toLocaleString())}</span><br><button data-act="o:restoretrash" data-id="${esc(t.id)}">Restore</button></p>`).join('') + '<p class="muted">Restoring brings the item back as it was. Links other items had to it were cleared when it was deleted and are not recreated. The newest 25 deletions are kept.</p>' : '<p class="muted">Nothing deleted recently.</p>'}</div>`; }

// ================= archive record detail: where is this used =================
export function usedByHtml(recordId: string): string {
  const ms = missions.filter(m => m.archiveRefs.includes(recordId)), om = !!omega && omega.archiveRefs.includes(recordId); if (!ms.length && !om) return '';
  return `<h2>Used by (${ms.length + (om ? 1 : 0)})</h2>${ms.map(m => `<button class="item" data-act="o:gomission" data-id="${esc(m.id)}"><b>${esc(m.title)}</b><small>mission · ${m.status}</small></button>`).join('')}${om ? `<button class="item" data-act="o:goomega"><b>${esc(omega!.name)}</b><small>Project OMEGA</small></button>` : ''}`; }

// ================= actions =================
const fd = (f: HTMLFormElement) => new FormData(f); const v = (d: FormData, k: string) => String(d.get(k) ?? '');
async function guard(fn: () => Promise<string | void>) { if (saving) return; saving = true; try { const m = await fn(); if (m) await after(m); } catch (e) { fail(e); } finally { saving = false; } }
const move = (a: O.Task[], id: string, d: number) => { const i = a.findIndex(t => t.id === id), j = i + d; if (i < 0 || j < 0 || j >= a.length) return a; const c = [...a]; [c[i], c[j]] = [c[j], c[i]]; return c; };
const tagsOf = (s: string) => s.split(',').map(t => t.trim()).filter(Boolean);

export async function click(el: HTMLElement): Promise<void> {
  const act = el.dataset.act!, id = el.dataset.id ?? '';
  // Speech must start synchronously inside the tap, before any await (iOS requirement).
  if (act === 'o:read') { const r = cmdLog[0]; if (!r) return; const env = browserEnv(); vSpeech = '';
    void speak(env, r.reply.text.replace(/\s+/g, ' '), { rate: 1, pitch: 1, lang: env.lang }).then(s => { vSpeech = s.outcome === 'ended' ? '' : s.outcome === 'unsupported' ? 'Speech output is not supported here.' : s.outcome === 'started-no-end' ? 'Speech started but may not have finished.' : s.outcome === 'no-start' ? 'Nothing was spoken: the browser did not start speech. The reply is shown as text above.' : 'Speech failed' + (s.error ? ' (' + s.error + ')' : '') + '. The reply is shown as text above.'; setVNote(vNote || ''); }); return; }
  if (act === 'o:mic') { const env = browserEnv(); if (!env.Recognition) { vOutcome = 'unsupported'; return ctx.toast(MIC_MSG.unsupported, true); } if (listening) return;
    listening = true; setVNote('Listening… speak now.'); const s = startRecognition(env, { lang: env.lang, onUpdate: l => { const i = document.getElementById('cq') as HTMLInputElement | null; if (i && l.text) i.value = l.text; } }); rec = s; paintCmdButtons();
    void s.result.then(r => { listening = false; rec = null; vOutcome = r.outcome; const i = document.getElementById('cq') as HTMLInputElement | null; if (r.outcome === 'transcribed' && i) { i.value = r.transcript; setVNote(`Heard: “${clip(r.transcript, 120)}”. Check it, then tap Run. Nothing has been executed.`); } else setVNote(MIC_MSG[r.outcome] ?? 'Speech input failed.'); paintCmdButtons(); refreshChips(); }); return; }
  if (act === 'o:micstop') { rec?.stop(); return; }
  if (act === 'o:help') { cmdLog.unshift({ input: 'help', reply: { handled: true, ok: true, text: (await runCommand('help', apiImpl())).text, changed: false } }); cmdLog.length = Math.min(cmdLog.length, 6); return ctx.render(); }
  if (act === 'o:cleardate') { const i = el.closest('form')?.querySelector(`[name="${id}"]`) as HTMLInputElement | null; if (i) i.value = ''; return; }
  switch (act) {
    case 'o:mnew': resetView(); mForm = O.newMission(); mFormNew = true; return ctx.render();
    case 'o:mopen': resetView(); mSel = id; return ctx.render();
    case 'o:mback': resetView(); return ctx.render();
    case 'o:medit': { const m = getM(id); if (!m) return; mForm = JSON.parse(JSON.stringify(m)); mFormNew = false; return ctx.render(); }
    case 'o:mcancel': mForm = null; return ctx.render();
    case 'o:mdup': return guard(async () => { const m = getM(id); if (!m) return; const map = new Map(m.tasks.map(t => [t.id, O.uid()] as [string, string]));
      const c = await db.saveMission(O.newMission({ title: clip(m.title, 190) + ' (copy)', objective: m.objective, description: m.description, priority: m.priority, deadline: m.deadline, tags: m.tags, notes: m.notes, archiveRefs: m.archiveRefs,
        tasks: m.tasks.map(t => ({ ...t, id: map.get(t.id)!, done: false, dependsOn: t.dependsOn.map(d => map.get(d)!).filter(Boolean) })), risks: m.risks.map(r => ({ ...r, id: O.uid() })), resources: m.resources.map(r => ({ ...r, id: O.uid() })) })); mSel = c.id; return 'Mission duplicated as planned, with all objectives reopened.'; });
    case 'o:march': return guard(async () => { const m = getM(id); if (!m) return; await db.mutateMission(id, x => ({ ...x, archived: !x.archived })); if (!m.archived) mSel = ''; return m.archived ? 'Mission restored to the list.' : 'Mission archived (not deleted).'; });
    case 'o:mdel': return guard(async () => { const m = getM(id); if (!m) return; const n = events.filter(e => e.missionId === id).length;
      if (!window.confirm(`Delete mission “${m.title}” and its ${m.tasks.length} objective(s)? ${n} timeline event(s) linked to it will be kept but unlinked, and OMEGA loses the link. It goes to Setup > Recently deleted, where you can restore it.`)) return; const r = await db.deleteMission(id); mSel = '';
      return `Mission deleted. ${r.events ? r.events + ' event(s) kept and unlinked. ' : ''}Restore it from Setup > Recently deleted.`; });
    case 'o:ttoggle': return guard(async () => { await db.mutateMission(mSel, x => ({ ...x, tasks: x.tasks.map(t => (t.id === id ? { ...t, done: !t.done } : t)) })); return 'Objective updated.'; });
    case 'o:tup': case 'o:tdown': return guard(async () => { await db.mutateMission(mSel, x => ({ ...x, tasks: move(x.tasks, id, act === 'o:tup' ? -1 : 1) })); return 'Objective moved.'; });
    case 'o:tedit': taskEdit = id; return ctx.render();
    case 'o:tcancel': taskEdit = ''; return ctx.render();
    case 'o:tdel': return guard(async () => { const t = getM(mSel)?.tasks.find(x => x.id === id); if (!t || !window.confirm(`Delete objective “${t.text}”? Other objectives that waited on it lose that dependency.`)) return;
      await db.mutateMission(mSel, x => ({ ...x, tasks: x.tasks.filter(y => y.id !== id).map(y => ({ ...y, dependsOn: y.dependsOn.filter(d => d !== id) })) })); return 'Objective deleted.'; });
    case 'o:rdel': return guard(async () => { if (!window.confirm('Delete this entry?')) return; await db.mutateMission(mSel, x => ({ ...x, risks: x.risks.filter(r => r.id !== id) })); return 'Entry deleted.'; });
    case 'o:resdel': return guard(async () => { if (!window.confirm('Delete this resource?')) return; await db.mutateMission(mSel, x => ({ ...x, resources: x.resources.filter(r => r.id !== id) })); return 'Resource deleted.'; });
    case 'o:addref': return guard(async () => { const t = el.dataset.t; if (t === 'omega') await db.mutateOmega(o => ({ ...o, archiveRefs: [...new Set([...o.archiveRefs, id])] })); else await db.mutateMission(mSel, x => ({ ...x, archiveRefs: [...new Set([...x.archiveRefs, id])] })); refQ = ''; return 'Archive record referenced.'; });
    case 'o:delref': return guard(async () => { const t = el.dataset.t; if (t === 'omega') await db.mutateOmega(o => ({ ...o, archiveRefs: o.archiveRefs.filter(r => r !== id) })); else await db.mutateMission(mSel, x => ({ ...x, archiveRefs: x.archiveRefs.filter(r => r !== id) })); return 'Reference removed. The archive record itself is untouched.'; });
    case 'o:openrec': return ctx.openRecord(id);
    case 'o:gomission': resetView(); mSel = id; ctx.go('colossus'); return;
    case 'o:goomega': resetView(); ctx.go('omega'); return;
    case 'o:evnew': resetView(); eForm = O.newEvent({ date: today(), missionId: id }); eFormNew = true; ctx.go('timeline'); return;
    case 'o:olinkm': return guard(async () => { await db.mutateOmega(o => ({ ...o, missionIds: [...new Set([...o.missionIds, id])] })); return 'Mission linked to Project OMEGA.'; });
    // timeline
    case 'o:enew': resetView(); eForm = O.newEvent({ date: today() }); eFormNew = true; return ctx.render();
    case 'o:eedit': { const e = events.find(x => x.id === id); if (!e) return; eForm = { ...e }; eFormNew = false; return ctx.render(); }
    case 'o:ecancel': eForm = null; return ctx.render();
    case 'o:edone': return guard(async () => { const e = events.find(x => x.id === id); if (!e) return; const to: O.EStatus = e.status === 'done' ? 'planned' : 'done'; await db.saveEvent({ ...e, status: to }); return to === 'done' ? 'Event marked done.' : 'Event is planned again.'; });
    case 'o:edel': return guard(async () => { const e = events.find(x => x.id === id); if (!e || !window.confirm(`Delete event “${e.title}”? Linked missions and OMEGA are not affected. It goes to Setup > Recently deleted.`)) return; await db.deleteEvent(id); eForm = null; return 'Event deleted. Missions and OMEGA untouched.'; });
    // OMEGA
    case 'o:oedit': oEdit = true; return ctx.render();
    case 'o:ocancel': oEdit = false; return ctx.render();
    case 'o:odel': return guard(async () => { if (!omega || !window.confirm(`Delete Project “${omega.name}”? Missions, objectives and timeline events are NOT deleted; they just lose their link to it. It goes to Setup > Recently deleted.`)) return; await db.deleteOmega(); return 'Project OMEGA deleted. Missions and events untouched.'; });
    case 'o:mstoggle': return guard(async () => { await db.mutateOmega(o => ({ ...o, milestones: o.milestones.map(m => (m.id === id ? { ...m, done: !m.done } : m)) })); return 'Milestone updated.'; });
    case 'o:msdel': return guard(async () => { const m = omega?.milestones.find(x => x.id === id); if (!m || !window.confirm(`Delete milestone “${m.title}”? Timeline events linked to it are kept.`)) return; const ev = events.filter(e => e.milestoneId === id);
      await db.mutateOmega(o => ({ ...o, milestones: o.milestones.filter(x => x.id !== id) })); for (const e of ev) await db.saveEvent({ ...e, milestoneId: '' }); return 'Milestone deleted.'; });
    case 'o:msedit': msEdit = id; return ctx.render();
    case 'o:mscancel': msEdit = ''; return ctx.render();
    case 'o:olink': return guard(async () => { const m = (document.getElementById('olsel') as HTMLSelectElement | null)?.value; if (!m) return; await db.mutateOmega(o => ({ ...o, missionIds: [...new Set([...o.missionIds, m])] })); return 'Mission linked.'; });
    case 'o:ounlink': return guard(async () => { await db.mutateOmega(o => ({ ...o, missionIds: o.missionIds.filter(x => x !== id), milestones: o.milestones.map(m => (m.missionId === id && !getM(id) ? { ...m, missionId: '' } : m)) })); return 'Link removed. The mission itself is unchanged.'; });
    case 'o:hypdel': return guard(async () => { if (!window.confirm('Delete this hypothesis?')) return; await db.mutateOmega(o => ({ ...o, hypotheses: o.hypotheses.filter(x => x.id !== id) })); return 'Hypothesis deleted.'; });
    case 'o:optdel': return guard(async () => { if (!window.confirm('Delete this option?')) return; await db.mutateOmega(o => ({ ...o, options: o.options.filter(x => x.id !== id) })); return 'Option deleted.'; });
    case 'o:decdel': return guard(async () => { if (!window.confirm('Delete this decision record?')) return; await db.mutateOmega(o => ({ ...o, decisions: o.decisions.filter(x => x.id !== id) })); return 'Decision deleted.'; });
    case 'o:aihyp': return guard(async () => { const a = ctx.aiAnswer(); if (!a) return; if (!omega) { ctx.toast('Create Project OMEGA first (OMEGA tab), then add this as an AI-suggested hypothesis.', true); return; }
      await db.mutateOmega(o => ({ ...o, hypotheses: [...o.hypotheses, { id: O.uid(), text: clip(`AI answer to “${a.q}”: ${a.answer}`, 1000), basis: 'Ask AI (web). Model-generated and unverified: check its sources before relying on it.', confidence: 'unknown', origin: 'ai', created: new Date().toISOString() }] })); return 'Added to OMEGA as an AI-suggested, unverified hypothesis.'; });
    // setup
    case 'o:restoretrash': return guard(async () => { const t = await db.restoreTrash(id); return `Restored “${clip(t.title, 50)}”.`; });
    case 'o:fixrefs': return guard(async () => { if (!window.confirm(`Remove ${issues.length} broken reference(s)? Only the references are removed, never a mission, event or archive record.`)) return; await db.snapshot('before removing broken references'); const n = await db.removeBrokenOpsRefs(); return `${n} broken reference(s) removed. Undo is in Setup > Safety copy.`; });
  }
}
const paintCmdButtons = () => { const p = document.querySelector('[data-act="o:mic"],[data-act="o:micstop"]') as HTMLButtonElement | null; if (p) { p.dataset.act = listening ? 'o:micstop' : 'o:mic'; p.textContent = listening ? '■ Stop listening' : '🎤 Speak a command'; } };
const refreshChips = () => ctx.updateChips();

export async function submit(f: HTMLFormElement): Promise<boolean> {
  if (!f.id.startsWith('of-')) return false; const d = fd(f);
  await guard(async () => { switch (f.id) {
    case 'of-mission': { const base = mForm ?? O.newMission(); const next = { ...base, title: v(d, 'title').trim(), objective: v(d, 'objective'), description: v(d, 'description'), status: v(d, 'status') as O.MStatus, priority: v(d, 'priority') as O.Priority, deadline: v(d, 'deadline'), tags: tagsOf(v(d, 'tags')), notes: v(d, 'notes') };
      O.validateMission(next); // fail early with a plain message, before any confirmation
      if (next.status === 'completed' && base.status !== 'completed' && next.tasks.some(t => !t.done) && !window.confirm(`This mission still has ${next.tasks.filter(t => !t.done).length} open objective(s). Mark it completed anyway?`)) return;
      if (mFormNew) { const s = await db.saveMission(next); mSel = s.id; mForm = null; return 'Mission created.'; }
      await db.mutateMission(base.id, x => ({ ...x, title: next.title, objective: next.objective, description: next.description, status: next.status, priority: next.priority, deadline: next.deadline, tags: next.tags, notes: next.notes })); mForm = null; return 'Mission saved.'; }
    case 'of-task': { const text = v(d, 'text').trim(); if (!text) throw new Error('Type the objective first.'); if ((getM(mSel)?.tasks.length ?? 0) >= 200) throw new Error('A mission can hold at most 200 objectives.'); await db.mutateMission(mSel, x => ({ ...x, tasks: [...x.tasks, O.newTask(text)] })); return 'Objective added.'; }
    case 'of-taskedit': { const tid = f.dataset.id!, text = v(d, 'text').trim(), deps = d.getAll('dep').map(String); if (!text) throw new Error('The objective needs text.');
      await db.mutateMission(mSel, x => { let tasks = x.tasks.map(t => (t.id === tid ? { ...t, text, notes: v(d, 'notes'), dependsOn: [] as string[] } : t)); for (const dep of deps) { if (O.wouldCycle(tasks, tid, dep)) throw new Error('That would create a circular dependency. Nothing was saved.'); tasks = tasks.map(t => (t.id === tid ? { ...t, dependsOn: [...t.dependsOn, dep] } : t)); } return { ...x, tasks }; }); taskEdit = ''; return 'Objective saved.'; }
    case 'of-risk': { const text = v(d, 'text').trim(); if (!text) throw new Error('Describe the risk, constraint or assumption.'); await db.mutateMission(mSel, x => ({ ...x, risks: [...x.risks, { id: O.uid(), kind: v(d, 'kind') as O.RiskKind, text, mitigation: v(d, 'mitigation') }] })); return 'Added.'; }
    case 'of-res': { const name = v(d, 'name').trim(); if (!name) throw new Error('Name the resource.'); await db.mutateMission(mSel, x => ({ ...x, resources: [...x.resources, { id: O.uid(), name, note: v(d, 'note'), needed: d.get('needed') === 'on' }] })); return 'Resource added.'; }
    case 'of-event': { const base = eForm ?? O.newEvent(); const next: O.TEvent = { ...base, title: v(d, 'title').trim(), description: v(d, 'description'), date: v(d, 'date'), time: v(d, 'time'), category: v(d, 'category') as O.ECategory, priority: v(d, 'priority') as O.Priority, status: v(d, 'status') as O.EStatus, missionId: v(d, 'missionId'), milestoneId: d.has('milestoneId') ? v(d, 'milestoneId') : base.milestoneId };
      if (!next.date) throw new Error('Pick a date.'); await db.saveEvent(next); eForm = null; return eFormNew ? 'Event created.' : 'Event saved.'; }
    case 'of-onew': { await db.saveOmega(O.newOmega({ name: v(d, 'name').trim(), purpose: v(d, 'purpose') })); return 'Project OMEGA created.'; }
    case 'of-omega': { await db.mutateOmega(o => ({ ...o, name: v(d, 'name').trim(), purpose: v(d, 'purpose'), status: v(d, 'status') as O.MStatus, priority: v(d, 'priority') as O.Priority, constraints: v(d, 'constraints'), notes: v(d, 'notes'), lessons: v(d, 'lessons') })); oEdit = false; return 'Project saved.'; }
    case 'of-ms': { const title = v(d, 'title').trim(); if (!title) throw new Error('Name the milestone.'); await db.mutateOmega(o => ({ ...o, milestones: [...o.milestones, { id: O.uid(), title, target: v(d, 'target'), done: false, missionId: v(d, 'missionId'), notes: '' }] })); return 'Milestone added. If it has a date it now also appears on the timeline.'; }
    case 'of-msedit': { const mid = f.dataset.id!; await db.mutateOmega(o => ({ ...o, milestones: o.milestones.map(m => (m.id === mid ? { ...m, title: v(d, 'title').trim(), target: v(d, 'target'), missionId: v(d, 'missionId'), notes: v(d, 'notes') } : m)) })); msEdit = ''; return 'Milestone saved.'; }
    case 'of-hyp': { const text = v(d, 'text').trim(); if (!text) throw new Error('Write the hypothesis first.'); await db.mutateOmega(o => ({ ...o, hypotheses: [...o.hypotheses, { id: O.uid(), text, basis: v(d, 'basis'), confidence: v(d, 'confidence') as O.Level, origin: 'user', created: new Date().toISOString() }] })); return 'Hypothesis recorded as your own assumption.'; }
    case 'of-opt': { const title = v(d, 'title').trim(); if (!title) throw new Error('Name the option.'); await db.mutateOmega(o => ({ ...o, options: [...o.options, { id: O.uid(), title, expected: v(d, 'expected'), risks: v(d, 'risks'), countermeasure: v(d, 'countermeasure'), fallback: d.get('fallback') === 'on' }] })); return 'Option recorded.'; }
    case 'of-dec': { const decision = v(d, 'decision').trim(); if (!decision) throw new Error('Write the decision first.'); await db.mutateOmega(o => ({ ...o, decisions: [...o.decisions, { id: O.uid(), date: v(d, 'date'), decision, rationale: v(d, 'rationale'), lesson: v(d, 'lesson') }] })); return 'Decision recorded.'; }
  } }); return true; }

/** Live filters: update only the list so typing is never interrupted by a full re-render. Returns true when the event was handled. */
export function onInput(t: HTMLInputElement | HTMLSelectElement): boolean {
  const set = (id: string, html: string) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
  switch (t.id) {
    case 'mq': mQ = t.value; set('mlist', missionListHtml()); return true; case 'mst': mStatus = t.value; set('mlist', missionListHtml()); return true; case 'msort': mSort = t.value as O.SortKey; set('mlist', missionListHtml()); return true;
    case 'march': mArch = (t as HTMLInputElement).checked; set('mlist', missionListHtml()); return true;
    case 'ef': eFilter = t.value; set('elist', eventListHtml()); return true; case 'ec': eCat = t.value; set('elist', eventListHtml()); return true; case 'eq': eQ = t.value; set('elist', eventListHtml()); return true;
    case 'orq': refQ = t.value; set('orr', refResults(t.dataset.t ?? 'mission', t.value)); return true;
  } return false; }
