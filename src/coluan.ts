// Coluan command engine (Stage 5 commands). Deterministic: no AI, no network, works offline.
// Every command calls the same storage functions as the buttons. A reply that says "ACK" is only produced AFTER the write committed and was read back.
// Input that is not an ops command returns { handled: false } so the caller can run the existing archive search unchanged.
import { Rec } from './model';
import * as O from './ops';

export interface Api {
  ops(): Promise<O.OpsBundle>;
  records(): Promise<Rec[]>;
  saveMission(m: O.Mission): Promise<O.Mission>;
  mutateMission(id: string, fn: (m: O.Mission) => O.Mission): Promise<O.Mission>;
  deleteMission(id: string): Promise<{ events: number; omega: boolean }>;
  saveEvent(e: O.TEvent): Promise<O.TEvent>;
  deleteEvent(id: string): Promise<void>;
  saveOmega(o: O.Omega): Promise<O.Omega>;
  mutateOmega(fn: (o: O.Omega) => O.Omega): Promise<O.Omega>;
  confirm(message: string): boolean;
  now(): Date;
}
export interface Reply { handled: boolean; ok: boolean; text: string; changed: boolean }
const VERBS = new Set(['mission', 'missions', 'task', 'tasks', 'event', 'events', 'omega', 'timeline']);
/** True when the input is meant for the mission/OMEGA/timeline engine rather than for archive search. */
export function isOpsCommand(input: string): boolean { const w = input.trim().toLowerCase().split(/\s+/); return (w.length === 1 && (w[0] === 'help' || w[0] === 'commands')) || VERBS.has(w[0]); }

export const HELP = `COLOSSUS / OMEGA / TIMELINE COMMANDS (anything else searches the archive; put "search" first to force an archive search)
mission new <title> [priority=high] [due=2026-11-01] [tags=a,b]
mission list [status | archived | all]      mission show <mission>      mission summary
mission set <mission> : status=active priority=low due=tomorrow due=none tags=a,b
mission archive <mission>      mission unarchive <mission>      mission delete <mission>
task add <mission> : <objective>      task done|reopen|delete <mission> : <#number or words>
task depend <mission> : <#a> on <#b>
event add <date> [HH:MM] : <title> [@ <mission>] [category=milestone] [priority=high] [status=done]
event list [upcoming | overdue | today | done | all]      event done|reopen|delete <title words>
omega  |  omega init [name]  |  omega set status=active priority=high
omega milestone add [date] : <title> [@ <mission>]      omega milestone done|reopen <title words>
omega link <mission>   omega unlink <mission>   omega decide : <decision> | <rationale>   omega hypothesis : <text> | <basis>
Dates: 2026-11-01, today, tomorrow, +3d. Mission names: any unique part of the title; use "quotes" if the title contains a colon.
Quote a name containing a colon: task add "Phase 1: recon" : check the map`;

const ok = (text: string, changed = false): Reply => ({ handled: true, ok: true, text, changed });
const no = (text: string): Reply => ({ handled: true, ok: false, text, changed: false });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** "<name> : <rest>" with optional quotes around the name. */
function takeRef(s: string): { ref: string; after: string } {
  s = s.trim(); const q = /^["“]([^"”]+)["”]\s*:?\s*([\s\S]*)$/.exec(s); if (q) return { ref: q[1].trim(), after: q[2].trim() };
  const i = s.indexOf(':'); return i < 0 ? { ref: s, after: '' } : { ref: s.slice(0, i).trim(), after: s.slice(i + 1).trim() }; }
/** Pulls key=value pairs out of text; returns the remaining text. Values may be "quoted". */
function takeKV(s: string, keys: string[]): { rest: string; kv: Record<string, string> } {
  const kv: Record<string, string> = {}; const re = new RegExp(`(?:^|\\s)(${keys.join('|')})=("[^"]*"|\\S*)`, 'gi');
  const rest = s.replace(re, (_m, k: string, v: string) => { kv[k.toLowerCase()] = v.replace(/^"|"$/g, ''); return ' '; }).replace(/\s+/g, ' ').trim(); return { rest, kv }; }
const splitAt = (s: string) => { const i = s.lastIndexOf(' @ '); return i < 0 ? { main: s.trim(), mission: '' } : { main: s.slice(0, i).trim(), mission: s.slice(i + 3).trim() }; };

function pick<T extends { id: string }>(pool: T[], ref: string, label: (t: T) => string, noun: string): T | Reply {
  const r = ref.trim(); if (!r) return no(`REJECTED. Name the ${noun} (any unique part of its title).`);
  const lower = r.toLowerCase(), exact = pool.filter(t => label(t).toLowerCase() === lower || t.id === r); if (exact.length === 1) return exact[0];
  const part = exact.length > 1 ? exact : pool.filter(t => label(t).toLowerCase().includes(lower));
  if (part.length === 1) return part[0]; if (!part.length) return no(`NOT FOUND. No ${noun} matches “${clip(r)}”.`);
  return no(`AMBIGUOUS. ${part.length} ${noun}s match “${clip(r)}”: ${part.slice(0, 5).map(t => '“' + clip(label(t), 40) + '”').join(', ')}${part.length > 5 ? ', …' : ''}. Nothing was changed. Use more of the title, or quote it.`); }
const isReply = (x: unknown): x is Reply => !!x && typeof x === 'object' && 'handled' in (x as object);
const pickTask = (m: O.Mission, ref: string): O.Task | Reply => { const r = ref.trim(), n = /^#?(\d+)$/.exec(r);
  if (n) { const t = m.tasks[Number(n[1]) - 1]; return t ?? no(`NOT FOUND. “${m.title}” has ${plural(m.tasks.length, 'objective')}; there is no #${n[1]}.`); } return pick(m.tasks, r, t => t.text, 'objective'); };

const progressText = (m: O.Mission) => { const p = O.missionProgress(m); return p.pct === null ? 'no objectives recorded' : `${p.done}/${p.total} objectives (${p.pct}%)`; };
const missionLine = (m: O.Mission, today: string) => `• ${clip(m.title)} [${m.status}/${m.priority}] ${progressText(m)}${m.deadline ? ` · due ${m.deadline}${O.missionOverdue(m, today) ? ' OVERDUE' : ''}` : ''}${m.archived ? ' · archived' : ''}`;
function missionDetail(m: O.Mission, today: string, recs: Rec[], ops: O.OpsBundle): string {
  const blocked = O.blockedTasks(m), name = (id: string) => recs.find(r => r.id === id)?.name ?? 'missing record';
  const evs = ops.events.filter(e => e.missionId === m.id);
  return [`${missionLine(m, today)}`, m.objective && `Objective: ${clip(m.objective, 200)}`,
    ...m.tasks.map((t, i) => `  ${t.done ? '[x]' : blocked.has(t.id) ? '[!]' : '[ ]'} #${i + 1} ${clip(t.text, 80)}${blocked.has(t.id) ? ` (waiting on: ${blocked.get(t.id)!.map(x => clip(x, 30)).join(', ')})` : ''}`),
    m.risks.length && `Risks/constraints/assumptions recorded: ${m.risks.length}`, m.resources.length && `Resources recorded (user-entered): ${m.resources.length}`,
    m.archiveRefs.length && `Archive references: ${m.archiveRefs.map(name).join(', ')}`, evs.length && `Timeline events: ${evs.length}`,
    'Figures above are derived from stored data; titles, notes and statuses are as you entered them.'].filter(Boolean).join('\n'); }

export async function runCommand(input: string, api: Api): Promise<Reply> {
  const text = input.trim(); if (!isOpsCommand(text)) return { handled: false, ok: true, text: '', changed: false };
  const [verb0, ...tail] = text.split(/\s+/), verb = verb0.toLowerCase(), rest = tail.join(' ');
  try {
    if (verb === 'help' || verb === 'commands') return ok(HELP);
    if (verb === 'mission' || verb === 'missions') return await mission(rest, api);
    if (verb === 'task' || verb === 'tasks') return await task(rest, api);
    if (verb === 'event' || verb === 'events') return await event(rest, api);
    if (verb === 'timeline') return await event('list ' + rest, api);
    return await omega(rest, api);
  } catch (e) { return no(`REJECTED. ${(e as Error).message || 'Unknown error'}. Nothing was confirmed saved.`); }
}

const today = (api: Api) => O.localDate(api.now());
const reread = async <T>(api: Api, find: (o: O.OpsBundle) => T | undefined | null): Promise<T | null> => (find(await api.ops()) ?? null);
const unconfirmed = () => no('FAILED. The change could not be read back after saving, so it is NOT confirmed. Check Colossus before retrying.');

async function mission(rest: string, api: Api): Promise<Reply> {
  const [sub0, ...r] = rest.split(/\s+/), sub = (sub0 || 'summary').toLowerCase(), arg = r.join(' '), td = today(api), o = await api.ops();
  if (sub === 'summary') { const c = O.missionCounts(o.missions, td); return ok(c.total || c.archived ? `COLOSSUS: ${plural(c.total, 'mission')} (${O.M_STATUS.map(s => `${c.byStatus[s]} ${s}`).join(', ')}) · ${c.overdue} overdue · ${plural(c.openTasks, 'open objective')} in open missions${c.archived ? ` · ${c.archived} archived` : ''}. Derived from stored missions.` : 'COLOSSUS: no missions recorded. Create one with: mission new <title>'); }
  if (sub === 'list') { const f = arg.trim().toLowerCase(); let rows: O.Mission[];
    if (f === 'archived') rows = o.missions.filter(m => m.archived); else if (f === 'all') rows = o.missions; else if (!f) rows = o.missions.filter(m => !m.archived);
    else if ((O.M_STATUS as readonly string[]).includes(f)) rows = o.missions.filter(m => !m.archived && m.status === f); else return no(`REJECTED. “${clip(f)}” is not a status. Use ${O.M_STATUS.join(', ')}, archived or all.`);
    rows = O.sortMissions(rows, 'deadline'); return ok(rows.length ? `${plural(rows.length, 'mission')}:\n` + rows.slice(0, 15).map(m => missionLine(m, td)).join('\n') + (rows.length > 15 ? `\n… and ${rows.length - 15} more (use the COLOSSUS tab)` : '') : 'No missions match.'); }
  if (sub === 'new' || sub === 'add' || sub === 'create') {
    const { rest: title, kv } = takeKV(arg, ['priority', 'due', 'status', 'tags']); if (!title) return no('REJECTED. Give the mission a title: mission new <title>');
    const pr = (kv.priority ?? 'medium').toLowerCase(), st = (kv.status ?? 'planned').toLowerCase();
    if (!(O.PRIORITY as readonly string[]).includes(pr)) return no(`REJECTED. Priority must be ${O.PRIORITY.join(', ')}.`); if (!(O.M_STATUS as readonly string[]).includes(st)) return no(`REJECTED. Status must be ${O.M_STATUS.join(', ')}.`);
    let due = ''; if (kv.due !== undefined) { due = O.parseDateWord(kv.due, td); if (!due) return no(`REJECTED. “${clip(kv.due, 20)}” is not a real date. Use 2026-11-01, today, tomorrow or +3d.`); }
    if (o.missions.some(m => m.title.toLowerCase() === title.toLowerCase()) && !api.confirm(`A mission titled “${title}” already exists. Create another with the same title?`)) return no('CANCELLED. Nothing was changed.');
    const saved = await api.saveMission(O.newMission({ title, priority: pr as O.Priority, status: st as O.MStatus, deadline: due, tags: kv.tags ? kv.tags.split(',').map(t => t.trim()).filter(Boolean) : [] }));
    const back = await reread(api, x => x.missions.find(m => m.id === saved.id)); if (!back) return unconfirmed();
    return ok(`ACK. Mission “${clip(back.title)}” created [${back.status}/${back.priority}]${back.deadline ? ` due ${back.deadline}` : ''}. No objectives yet: task add ${clip(back.title, 30)} : <objective>`, true); }
  if (!['show', 'set', 'archive', 'unarchive', 'delete'].includes(sub)) return no(`REJECTED. Unknown mission command “${clip(sub, 20)}”. Try: new, list, show, set, archive, unarchive, delete, summary. (To search the archive for these words, start with “search”.)`);
  const { ref, after } = takeRef(arg), m = pick(o.missions, sub === 'set' ? ref : arg.replace(/^["“]([^"”]+)["”]$/, '$1'), x => x.title, 'mission'); if (isReply(m)) return m;
  if (sub === 'show') return ok(missionDetail(m, td, await api.records(), o));
  if (sub === 'set') { const { kv, rest: junk } = takeKV(after, ['status', 'priority', 'due', 'tags']);
    if (!Object.keys(kv).length || junk) return no('REJECTED. Use: mission set <mission> : status=active priority=high due=2026-11-01 (also due=none, tags=a,b). Titles and notes are edited in the COLOSSUS tab.');
    const patch: Partial<O.Mission> = {};
    if (kv.status !== undefined) { const s = kv.status.toLowerCase(); if (!(O.M_STATUS as readonly string[]).includes(s)) return no(`REJECTED. Status must be ${O.M_STATUS.join(', ')}.`); patch.status = s as O.MStatus; }
    if (kv.priority !== undefined) { const p = kv.priority.toLowerCase(); if (!(O.PRIORITY as readonly string[]).includes(p)) return no(`REJECTED. Priority must be ${O.PRIORITY.join(', ')}.`); patch.priority = p as O.Priority; }
    if (kv.due !== undefined) { if (['none', 'clear', ''].includes(kv.due.toLowerCase())) patch.deadline = ''; else { const d = O.parseDateWord(kv.due, td); if (!d) return no(`REJECTED. “${clip(kv.due, 20)}” is not a real date.`); patch.deadline = d; } }
    if (kv.tags !== undefined) patch.tags = kv.tags.split(',').map(t => t.trim()).filter(Boolean);
    if (patch.status === 'completed' && m.tasks.some(t => !t.done) && !api.confirm(`“${m.title}” still has ${plural(m.tasks.filter(t => !t.done).length, 'open objective')}. Mark it completed anyway?`)) return no('CANCELLED. Nothing was changed.');
    const saved = await api.mutateMission(m.id, x => ({ ...x, ...patch })); const back = await reread(api, x => x.missions.find(y => y.id === m.id)); if (!back || back.modified !== saved.modified) return unconfirmed();
    return ok(`ACK. “${clip(back.title)}” updated: ${Object.keys(patch).map(k => `${k}=${(back as any)[k] === '' ? 'none' : (back as any)[k]}`).join(', ')}.`, true); }
  if (sub === 'archive' || sub === 'unarchive') { const to = sub === 'archive'; if (m.archived === to) return ok(`No change: “${clip(m.title)}” is already ${to ? 'archived' : 'active in the list'}.`);
    await api.mutateMission(m.id, x => ({ ...x, archived: to })); const back = await reread(api, x => x.missions.find(y => y.id === m.id)); if (!back || back.archived !== to) return unconfirmed(); return ok(`ACK. “${clip(m.title)}” ${to ? 'archived (nothing deleted; restore with: mission unarchive)' : 'restored to the list'}.`, true); }
  if (sub === 'delete') { const linked = o.events.filter(e => e.missionId === m.id).length;
    if (!api.confirm(`Delete mission “${m.title}” with ${plural(m.tasks.length, 'objective')}? ${linked} timeline event${linked === 1 ? '' : 's'} linked to it will be KEPT but unlinked. It goes to the recoverable trash (Setup).`)) return no('CANCELLED. Nothing was changed.');
    await api.deleteMission(m.id); if (await reread(api, x => x.missions.find(y => y.id === m.id))) return unconfirmed(); return ok(`ACK. Mission “${clip(m.title)}” deleted. Recoverable from Setup > Recently deleted. ${linked ? `${plural(linked, 'event')} kept and unlinked.` : ''}`.trim(), true); }
  return no(`REJECTED. Unknown mission command “${sub}”. Try: new, list, show, set, archive, unarchive, delete, summary. (To search the archive for these words, start with “search”.)`);
}

async function task(rest: string, api: Api): Promise<Reply> {
  const [sub0, ...r] = rest.split(/\s+/), sub = (sub0 || '').toLowerCase(), { ref, after } = takeRef(r.join(' ')), o = await api.ops(), td = today(api);
  if (!['add', 'done', 'reopen', 'delete', 'depend', 'list', 'show'].includes(sub)) return no(`REJECTED. Unknown task command “${clip(sub, 20)}”. Try: add, done, reopen, delete, depend, list. (Type “help”.)`);
  const m = pick(o.missions, ref, x => x.title, 'mission'); if (isReply(m)) return m;
  if (sub === 'list' || sub === 'show') return ok(missionDetail(m, td, await api.records(), o));
  if (!after) return no(`REJECTED. Use: task ${sub} <mission> : <${sub === 'add' ? 'objective text' : '#number or words'}>`);
  if (sub === 'add') { if (m.tasks.length >= 200) return no('REJECTED. A mission can hold at most 200 objectives.'); const t = O.newTask(after.slice(0, 500));
    const saved = await api.mutateMission(m.id, x => ({ ...x, tasks: [...x.tasks, t] })); const back = await reread(api, x => x.missions.find(y => y.id === m.id)); if (!back || !back.tasks.some(y => y.id === t.id)) return unconfirmed();
    return ok(`ACK. Objective #${saved.tasks.length} added to “${clip(m.title)}”: ${clip(t.text)}. Progress: ${progressText(back)}.`, true); }
  if (sub === 'depend') { const parts = after.split(/\s+on\s+/i); if (parts.length !== 2) return no('REJECTED. Use: task depend <mission> : <#a> on <#b>   (a waits for b)');
    const a = pickTask(m, parts[0]); if (isReply(a)) return a; const b = pickTask(m, parts[1]); if (isReply(b)) return b;
    if (O.wouldCycle(m.tasks, a.id, b.id)) return no('REJECTED. That would create a circular dependency (or a task depending on itself). Nothing was changed.'); if (a.dependsOn.includes(b.id)) return ok('No change: that dependency already exists.');
    await api.mutateMission(m.id, x => ({ ...x, tasks: x.tasks.map(t => (t.id === a.id ? { ...t, dependsOn: [...t.dependsOn, b.id] } : t)) }));
    const back = await reread(api, x => x.missions.find(y => y.id === m.id)); if (!back?.tasks.find(t => t.id === a.id)?.dependsOn.includes(b.id)) return unconfirmed(); return ok(`ACK. “${clip(a.text, 40)}” now waits for “${clip(b.text, 40)}”.`, true); }
  const t = pickTask(m, after); if (isReply(t)) return t;
  if (sub === 'delete') { if (!api.confirm(`Delete objective “${t.text}” from “${m.title}”? Other objectives that depended on it lose that dependency.`)) return no('CANCELLED. Nothing was changed.');
    await api.mutateMission(m.id, x => ({ ...x, tasks: x.tasks.filter(y => y.id !== t.id).map(y => ({ ...y, dependsOn: y.dependsOn.filter(d => d !== t.id) })) }));
    const back = await reread(api, x => x.missions.find(y => y.id === m.id)); if (!back || back.tasks.some(y => y.id === t.id)) return unconfirmed(); return ok(`ACK. Objective deleted. Progress: ${progressText(back)}.`, true); }
  const done = sub === 'done', warn = done && O.blockedTasks(m).get(t.id);
  if (t.done === done) return ok(`No change: that objective is already ${done ? 'complete' : 'open'}.`);
  await api.mutateMission(m.id, x => ({ ...x, tasks: x.tasks.map(y => (y.id === t.id ? { ...y, done } : y)) }));
  const back = await reread(api, x => x.missions.find(y => y.id === m.id)); if (back?.tasks.find(y => y.id === t.id)?.done !== done) return unconfirmed();
  return ok(`ACK. Objective ${done ? 'completed' : 'reopened'}: ${clip(t.text)}. Progress: ${progressText(back)}.${warn ? ` Note: it was still waiting on ${warn.map(x => '“' + clip(x, 30) + '”').join(', ')}.` : ''}`, true);
}

const evLine = (i: O.TItem) => `• ${i.date}${i.time ? ' ' + i.time : ''} [${i.state.toUpperCase()}] ${clip(i.title, 70)}${i.derived ? ` (derived from ${i.source})` : ''}`;
async function event(rest: string, api: Api): Promise<Reply> {
  const [sub0, ...r] = rest.split(/\s+/), sub = (sub0 || 'list').toLowerCase(), arg = r.join(' '), o = await api.ops(), td = today(api), nt = O.localTime(api.now());
  if (sub === 'list' || sub === 'show') { const f = (arg.trim().toLowerCase() || 'open'); if (!['open', 'upcoming', 'overdue', 'today', 'done', 'all'].includes(f)) return no('REJECTED. Use: event list [upcoming | overdue | today | done | all]');
    const all = O.timelineItems(o.events, o.missions, o.omega, td, nt); const keep = f === 'all' ? all : f === 'open' ? all.filter(i => ['overdue', 'today', 'upcoming'].includes(i.state)) : all.filter(i => i.state === (f === 'done' ? 'done' : f));
    const rows = O.sortTimeline(keep, f === 'done'); return ok(rows.length ? `${plural(rows.length, 'item')} (${f}):\n` + rows.slice(0, 15).map(evLine).join('\n') + (rows.length > 15 ? `\n… and ${rows.length - 15} more (use the TIMELINE tab)` : '') + '\nOverdue = planned and past its date; completion is never inferred from a date.' : `Nothing ${f === 'open' ? 'upcoming or overdue' : f}.`); }
  if (sub === 'add' || sub === 'new') {
    const { rest: body, kv } = takeKV(arg, ['category', 'type', 'priority', 'status']), m0 = /^(\S+)(?:\s+(\d{1,2}:\d{2}))?\s*:?\s*([\s\S]*)$/.exec(body);
    if (!m0) return no('REJECTED. Use: event add <date> [HH:MM] : <title> [@ <mission>]'); const dtok = m0[1].replace(/:$/, ''), date = O.parseDateWord(dtok, td); if (!date) return no(`REJECTED. “${clip(dtok, 20)}” is not a real date. Use 2026-11-01, today, tomorrow or +3d.`);
    const time = m0[2] ? m0[2].padStart(5, '0') : ''; if (time && !O.isTime(time)) return no(`REJECTED. “${m0[2]}” is not a valid time (use 00:00 to 23:59).`);
    const { main: title, mission: mref } = splitAt(m0[3]); if (!title) return no('REJECTED. The event needs a title.');
    const cat = (kv.category ?? kv.type ?? 'other').toLowerCase(), pr = (kv.priority ?? 'medium').toLowerCase(), st = (kv.status ?? 'planned').toLowerCase();
    if (!(O.E_CATEGORY as readonly string[]).includes(cat)) return no(`REJECTED. Category must be ${O.E_CATEGORY.join(', ')}.`); if (!(O.PRIORITY as readonly string[]).includes(pr)) return no(`REJECTED. Priority must be ${O.PRIORITY.join(', ')}.`); if (!(O.E_STATUS as readonly string[]).includes(st)) return no(`REJECTED. Status must be ${O.E_STATUS.join(', ')}.`);
    let missionId = ''; if (mref) { const m = pick(o.missions, mref, x => x.title, 'mission'); if (isReply(m)) return m; missionId = m.id; }
    const saved = await api.saveEvent(O.newEvent({ title, date, time, category: cat as O.ECategory, priority: pr as O.Priority, status: st as O.EStatus, missionId }));
    const back = await reread(api, x => x.events.find(e => e.id === saved.id)); if (!back) return unconfirmed();
    return ok(`ACK. Event “${clip(back.title)}” recorded for ${back.date}${back.time ? ' ' + back.time : ''} [${back.status}${back.status === 'planned' ? ', ' + O.eventState(back, td, nt) : ''}]${missionId ? ` linked to mission “${clip(o.missions.find(m => m.id === missionId)!.title, 40)}”` : ''}.`, true); }
  if (!['done', 'reopen', 'delete'].includes(sub)) return no(`REJECTED. Unknown event command “${clip(sub, 20)}”. Try: add, list, done, reopen, delete. (Type “help”.)`);
  const e = pick(o.events, arg, x => x.title, 'event'); if (isReply(e)) return e.text.startsWith('NOT FOUND') ? no(e.text + ' Only stored events can be changed here; deadlines and milestone dates shown in the timeline come from missions and OMEGA.') : e;
  if (sub === 'delete') { if (!api.confirm(`Delete event “${e.title}” (${e.date})? Linked missions and OMEGA are not affected. It goes to the recoverable trash.`)) return no('CANCELLED. Nothing was changed.');
    await api.deleteEvent(e.id); if (await reread(api, x => x.events.find(y => y.id === e.id))) return unconfirmed(); return ok(`ACK. Event “${clip(e.title)}” deleted. Missions and OMEGA untouched. Recoverable from Setup > Recently deleted.`, true); }
  const to: O.EStatus = sub === 'done' ? 'done' : 'planned'; if (e.status === to) return ok(`No change: the event is already ${to}.`);
  if (to === 'planned' && e.category === 'history') return no('REJECTED. A history event records something that already happened and cannot be set back to planned. Change its category in the TIMELINE tab first.');
  await api.saveEvent({ ...e, status: to }); const back = await reread(api, x => x.events.find(y => y.id === e.id)); if (back?.status !== to) return unconfirmed(); return ok(`ACK. Event “${clip(e.title)}” marked ${to === 'done' ? 'done' : 'planned again'}.`, true);
}

async function omega(rest: string, api: Api): Promise<Reply> {
  const [sub0, ...r] = rest.split(/\s+/), sub = (sub0 || 'show').toLowerCase(), arg = r.join(' '), o = await api.ops(), td = today(api), om = o.omega;
  if (!['show', 'summary', 'init', 'create', 'set', 'link', 'unlink', 'decide', 'hypothesis', 'milestone'].includes(sub)) return no(`REJECTED. Unknown omega command “${clip(sub, 20)}”. Try: show, init, set, milestone, link, unlink, decide, hypothesis. (Type “help”.)`);
  if (sub === 'init' || sub === 'create') { if (om) return ok(`No change: Project OMEGA already exists (“${clip(om.name)}”).`); const saved = await api.saveOmega(O.newOmega({ name: arg.trim().slice(0, 200) || 'Project OMEGA' }));
    if (!(await reread(api, x => x.omega))) return unconfirmed(); return ok(`ACK. Project “${clip(saved.name)}” created [planned/high]. Add its purpose and milestones in the OMEGA tab or with: omega milestone add <date> : <title>`, true); }
  if (!om) return no('NOT FOUND. No Project OMEGA exists yet. Create it with: omega init   (or in the OMEGA tab).');
  if (sub === 'show' || sub === 'summary') { const mt = O.omegaMetrics(om, o.missions), up = om.milestones.filter(x => !x.done && x.target).sort((a, b) => a.target.localeCompare(b.target))[0];
    return ok([`PROJECT ${clip(om.name)} [${om.status}/${om.priority}]`, om.purpose && `Purpose (user-entered): ${clip(om.purpose, 200)}`,
      `Milestones: ${mt.milestones.pct === null ? 'none recorded' : `${mt.milestones.done}/${mt.milestones.total} marked done (${mt.milestones.pct}%)`}`,
      `Linked missions: ${mt.linkedMissions.length}${mt.tasks.pct === null ? ' · no objectives in them, so no task progress figure' : ` · objectives ${mt.tasks.done}/${mt.tasks.total} (${mt.tasks.pct}%)`}${mt.missing.length ? ` · ${mt.missing.length} linked mission(s) no longer exist` : ''}`,
      mt.conflicts.length ? `CONFLICTS (${mt.conflicts.length}): ` + mt.conflicts.slice(0, 3).join(' ') : 'No conflicts between milestones and linked missions.',
      up && `Next open milestone with a date: “${clip(up.title, 50)}” on ${up.target}${up.target < td ? ' (PAST DATE, still open)' : ''}`,
      `Recorded: ${plural(om.hypotheses.length, 'hypothesis').replace('hypothesiss', 'hypotheses')}, ${plural(om.options.length, 'option')}, ${plural(om.decisions.length, 'decision')}.`,
      'Percentages are computed from what you recorded; they are not forecasts.'].filter(Boolean).join('\n')); }
  if (sub === 'set') { const { kv, rest: junk } = takeKV(arg, ['status', 'priority']); if (!Object.keys(kv).length || junk) return no('REJECTED. Use: omega set status=active priority=high'); const patch: Partial<O.Omega> = {};
    if (kv.status !== undefined) { if (!(O.M_STATUS as readonly string[]).includes(kv.status.toLowerCase())) return no(`REJECTED. Status must be ${O.M_STATUS.join(', ')}.`); patch.status = kv.status.toLowerCase() as O.MStatus; }
    if (kv.priority !== undefined) { if (!(O.PRIORITY as readonly string[]).includes(kv.priority.toLowerCase())) return no(`REJECTED. Priority must be ${O.PRIORITY.join(', ')}.`); patch.priority = kv.priority.toLowerCase() as O.Priority; }
    await api.mutateOmega(x => ({ ...x, ...patch })); const back = await reread(api, x => x.omega); if (!back || (patch.status && back.status !== patch.status) || (patch.priority && back.priority !== patch.priority)) return unconfirmed(); return ok(`ACK. OMEGA updated: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}.`, true); }
  if (sub === 'link' || sub === 'unlink') { const m = pick(o.missions, arg, x => x.title, 'mission'); if (isReply(m)) return m; const link = sub === 'link';
    if (om.missionIds.includes(m.id) === link) return ok(`No change: “${clip(m.title)}” is already ${link ? 'linked' : 'not linked directly'}.`);
    await api.mutateOmega(x => ({ ...x, missionIds: link ? [...x.missionIds, m.id] : x.missionIds.filter(i => i !== m.id) })); const back = await reread(api, x => x.omega); if (!back || back.missionIds.includes(m.id) !== link) return unconfirmed(); return ok(`ACK. Mission “${clip(m.title)}” ${link ? 'linked to' : 'unlinked from'} Project OMEGA. The mission itself is unchanged.`, true); }
  if (sub === 'decide' || sub === 'hypothesis') { const body = arg.replace(/^:\s*/, '').trim(), [main, ...more] = body.split('|'), extra = more.join('|').trim(); if (!main.trim()) return no(`REJECTED. Use: omega ${sub} : <text>${sub === 'decide' ? ' | <rationale>' : ' | <basis>'}`);
    const id = O.uid(); await api.mutateOmega(x => sub === 'decide' ? { ...x, decisions: [...x.decisions, { id, date: td, decision: main.trim(), rationale: extra, lesson: '' }] } : { ...x, hypotheses: [...x.hypotheses, { id, text: main.trim(), basis: extra, confidence: 'unknown', origin: 'user', created: new Date().toISOString() }] });
    const back = await reread(api, x => x.omega); if (![...(back?.decisions ?? []), ...(back?.hypotheses ?? [])].some(x => x.id === id)) return unconfirmed(); return ok(sub === 'decide' ? `ACK. Decision recorded for ${td}${extra ? ' with rationale' : ' (no rationale given)'}.` : 'ACK. Hypothesis recorded as user-entered, confidence unknown. It is an assumption, not a finding.', true); }
  if (sub === 'milestone') { const [a0, ...b] = arg.split(/\s+/), act = (a0 || '').toLowerCase(), body = b.join(' ');
    if (act === 'add') { const first = body.split(/[\s:]/)[0], d = O.parseDateWord(first, td), after = d ? body.slice(first.length).replace(/^\s*:?\s*/, '') : body.replace(/^:\s*/, ''); const { main: title, mission: mref } = splitAt(after);
      if (!title) return no('REJECTED. Use: omega milestone add [date] : <title> [@ <mission>]'); if (/^\d{4}-\d{2}-\d{2}$/.test(first) && !d) return no(`REJECTED. “${first}” is not a real date.`);
      let missionId = ''; if (mref) { const m = pick(o.missions, mref, x => x.title, 'mission'); if (isReply(m)) return m; missionId = m.id; }
      const ms: O.Milestone = { id: O.uid(), title: title.slice(0, 200), target: d, done: false, missionId, notes: '' }; await api.mutateOmega(x => ({ ...x, milestones: [...x.milestones, ms] }));
      const back = await reread(api, x => x.omega); if (!back?.milestones.some(x => x.id === ms.id)) return unconfirmed(); return ok(`ACK. Milestone “${clip(ms.title)}” added${d ? ` for ${d} (it now also appears on the timeline, derived from OMEGA)` : ' with no date'}${missionId ? `, linked to “${clip(o.missions.find(x => x.id === missionId)!.title, 40)}”` : ''}.`, true); }
    if (act === 'done' || act === 'reopen') { const ms = pick(om.milestones, body, x => x.title, 'milestone'); if (isReply(ms)) return ms; const done = act === 'done'; if (ms.done === done) return ok(`No change: that milestone is already ${done ? 'done' : 'open'}.`);
      const lm = ms.missionId ? o.missions.find(m => m.id === ms.missionId) : undefined; await api.mutateOmega(x => ({ ...x, milestones: x.milestones.map(y => (y.id === ms.id ? { ...y, done } : y)) }));
      const back = await reread(api, x => x.omega); if (back?.milestones.find(y => y.id === ms.id)?.done !== done) return unconfirmed();
      return ok(`ACK. Milestone “${clip(ms.title)}” marked ${done ? 'done' : 'open'}.${done && lm && lm.status !== 'completed' ? ` Warning: its linked mission “${clip(lm.title, 40)}” is ${lm.status}; OMEGA will list this as a conflict.` : ''}`, true); }
    return no('REJECTED. Use: omega milestone add [date] : <title> [@ <mission>]  |  omega milestone done|reopen <title words>'); }
  return no(`REJECTED. Unknown omega command “${clip(sub, 20)}”. Try: show, init, set, milestone, link, unlink, decide, hypothesis. (Type “help”.)`);
}
