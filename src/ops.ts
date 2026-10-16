// Stage 5 data model: Colossus missions, Project OMEGA, Strategic Timeline.
// Pure logic only (no browser APIs), so every rule here is unit-testable.
// Provenance rule used across the UI: values typed by the user are "user-entered"; counts, percentages and overdue flags
// computed in this file are "system-derived"; text from the Ask-AI feature is stored with origin 'ai' and is never treated as fact.
import { uid, parseBackup, Rec } from './model';
export { uid };

export const M_STATUS = ['planned', 'active', 'paused', 'completed', 'cancelled'] as const;
export const PRIORITY = ['low', 'medium', 'high', 'critical'] as const;
export const E_CATEGORY = ['milestone', 'deadline', 'operation', 'review', 'history', 'other'] as const;
export const E_STATUS = ['planned', 'done', 'cancelled'] as const;
export const RISK_KIND = ['risk', 'constraint', 'assumption'] as const;
export const LEVEL = ['low', 'medium', 'high', 'unknown'] as const;
export const ORIGIN = ['user', 'ai'] as const;
export type MStatus = typeof M_STATUS[number]; export type Priority = typeof PRIORITY[number]; export type ECategory = typeof E_CATEGORY[number];
export type EStatus = typeof E_STATUS[number]; export type RiskKind = typeof RISK_KIND[number]; export type Level = typeof LEVEL[number]; export type Origin = typeof ORIGIN[number];

export interface Task { id: string; text: string; done: boolean; notes: string; dependsOn: string[] }
export interface Risk { id: string; kind: RiskKind; text: string; mitigation: string }
export interface Resource { id: string; name: string; note: string; needed: boolean }
export interface Mission {
  id: string; title: string; objective: string; description: string; status: MStatus; priority: Priority; deadline: string; tags: string[]; archived: boolean;
  tasks: Task[]; risks: Risk[]; resources: Resource[]; notes: string; archiveRefs: string[]; created: string; modified: string;
}
export interface Milestone { id: string; title: string; target: string; done: boolean; missionId: string; notes: string }
export interface Hypothesis { id: string; text: string; basis: string; confidence: Level; origin: Origin; created: string }
export interface Option { id: string; title: string; expected: string; risks: string; countermeasure: string; fallback: boolean }
export interface Decision { id: string; date: string; decision: string; rationale: string; lesson: string }
export const OMEGA_ID = 'omega';
export interface Omega {
  id: typeof OMEGA_ID; name: string; purpose: string; status: MStatus; priority: Priority; constraints: string; notes: string; lessons: string;
  milestones: Milestone[]; missionIds: string[]; hypotheses: Hypothesis[]; options: Option[]; decisions: Decision[]; archiveRefs: string[]; created: string; modified: string;
}
export interface TEvent {
  id: string; title: string; description: string; date: string; time: string; category: ECategory; priority: Priority; status: EStatus;
  missionId: string; milestoneId: string; created: string; modified: string;
}
export interface OpsBundle { missions: Mission[]; omega: Omega | null; events: TEvent[] }

// ---------- constructors ----------
const now = () => new Date().toISOString();
export const newTask = (text: string, p: Partial<Task> = {}): Task => ({ id: uid(), text, done: false, notes: '', dependsOn: [], ...p });
export const newMission = (p: Partial<Mission> = {}): Mission => { const t = now();
  return { id: uid(), title: '', objective: '', description: '', status: 'planned', priority: 'medium', deadline: '', tags: [], archived: false, tasks: [], risks: [], resources: [], notes: '', archiveRefs: [], created: t, modified: t, ...p }; };
export const newOmega = (p: Partial<Omega> = {}): Omega => { const t = now();
  return { id: OMEGA_ID, name: 'Project OMEGA', purpose: '', status: 'planned', priority: 'high', constraints: '', notes: '', lessons: '', milestones: [], missionIds: [], hypotheses: [], options: [], decisions: [], archiveRefs: [], created: t, modified: t, ...p }; };
export const newEvent = (p: Partial<TEvent> = {}): TEvent => { const t = now();
  return { id: uid(), title: '', description: '', date: '', time: '', category: 'other', priority: 'medium', status: 'planned', missionId: '', milestoneId: '', created: t, modified: t, ...p }; };

// ---------- dates (all LOCAL calendar dates stored as YYYY-MM-DD; never converted through UTC) ----------
const pad = (n: number) => String(n).padStart(2, '0');
export const isDate = (s: unknown): s is string => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number); const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d; };
export const isTime = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
/** Today's date on the device's own calendar (toISOString would give the UTC date, which is wrong near midnight). */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function addDays(date: string, n: number): string { const [y, m, d] = date.split('-').map(Number); return localDate(new Date(y, m - 1, d + n)); }
/** Whole calendar days from a to b (b minus a), independent of time zone and daylight saving. */
export function daysBetween(a: string, b: string): number { const f = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((f(b) - f(a)) / 86400000); }
export function fmtDate(s: string): string { if (!isDate(s)) return s; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); }
/** Accepts 2026-11-01, today, tomorrow, yesterday, +3d, -2d. Returns '' when it is not a real date. */
export function parseDateWord(w: string, today: string): string {
  const s = w.trim().toLowerCase(); if (isDate(s)) return s; if (s === 'today') return today; if (s === 'tomorrow') return addDays(today, 1); if (s === 'yesterday') return addDays(today, -1);
  const m = /^([+-])(\d{1,4})d$/.exec(s); return m ? addDays(today, (m[1] === '-' ? -1 : 1) * Number(m[2])) : ''; }

// ---------- validation of untrusted data (storage, backups, forms) ----------
const str = (v: unknown, max: number, f: string): string => { if (typeof v !== 'string') throw new Error(`${f} must be text`); if (v.length > max) throw new Error(`${f} is too long (max ${max} characters)`); return v; };
const req = (v: unknown, max: number, f: string): string => { const s = str(v, max, f).trim(); if (!s) throw new Error(`${f} is required`); return s; };
const oneOf = <T extends string>(list: readonly T[], v: unknown, f: string): T => { if (!list.includes(v as T)) throw new Error(`${f} is not a valid choice`); return v as T; };
const list = (v: unknown, max: number, f: string): unknown[] => { if (!Array.isArray(v) || v.length > max) throw new Error(`${f} is invalid or has too many entries (max ${max})`); return v; };
const bool = (v: unknown, f: string): boolean => { if (typeof v !== 'boolean') throw new Error(`${f} must be true or false`); return v; };
const ident = (v: unknown, f = 'id'): string => { const s = str(v, 64, f); if (!/^[\w-]{1,64}$/.test(s)) throw new Error(`Bad ${f}`); return s; };
const optId = (v: unknown, f: string): string => (v == null || v === '' ? '' : ident(v, f));
const ids = (v: unknown, max: number, f: string): string[] => [...new Set(list(v ?? [], max, f).map(x => ident(x, f)))];
const iso = (v: unknown, f: string): string => { const s = str(v, 40, f); if (isNaN(Date.parse(s))) throw new Error(`${f} is not a date`); return s; };
const optDate = (v: unknown, f: string): string => { const s = v == null ? '' : str(v, 10, f); if (s && !isDate(s)) throw new Error(`${f} is not a real date (use YYYY-MM-DD)`); return s; };
const uniq = (a: string[], f: string) => { if (new Set(a).size !== a.length) throw new Error(`Duplicate ${f}`); };
const obj = (x: any, f: string) => { if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${f} is not an object`); return x; };

export function validateTask(x: any): Task { obj(x, 'Objective');
  return { id: ident(x.id), text: req(x.text, 500, 'Objective text'), done: bool(x.done ?? false, 'done'), notes: str(x.notes ?? '', 2000, 'Objective notes'), dependsOn: ids(x.dependsOn, 20, 'dependencies') }; }
export function validateMission(x: any): Mission { obj(x, 'Mission');
  const tasks = list(x.tasks ?? [], 200, 'Objectives').map(validateTask); uniq(tasks.map(t => t.id), 'objective ids');
  const known = new Set(tasks.map(t => t.id)); for (const t of tasks) t.dependsOn = t.dependsOn.filter(d => d !== t.id && known.has(d)); // unknown or self dependencies are dropped
  const risks = list(x.risks ?? [], 100, 'Risks').map((r: any) => ({ id: ident(obj(r, 'Risk').id), kind: oneOf(RISK_KIND, r.kind, 'Risk type'), text: req(r.text, 1000, 'Risk text'), mitigation: str(r.mitigation ?? '', 1000, 'Mitigation') })); uniq(risks.map(r => r.id), 'risk ids');
  const resources = list(x.resources ?? [], 100, 'Resources').map((r: any) => ({ id: ident(obj(r, 'Resource').id), name: req(r.name, 200, 'Resource name'), note: str(r.note ?? '', 1000, 'Resource note'), needed: bool(r.needed ?? true, 'needed') })); uniq(resources.map(r => r.id), 'resource ids');
  return { id: ident(x.id), title: req(x.title, 200, 'Mission title'), objective: str(x.objective ?? '', 1000, 'Objective'), description: str(x.description ?? '', 5000, 'Description'),
    status: oneOf(M_STATUS, x.status, 'Status'), priority: oneOf(PRIORITY, x.priority, 'Priority'), deadline: optDate(x.deadline, 'Deadline'), tags: list(x.tags ?? [], 30, 'Tags').map(t => str(t, 40, 'Tag')),
    archived: bool(x.archived ?? false, 'archived'), tasks, risks, resources, notes: str(x.notes ?? '', 5000, 'Notes'), archiveRefs: ids(x.archiveRefs, 100, 'archive references'),
    created: iso(x.created, 'created'), modified: iso(x.modified, 'modified') }; }
export function validateOmega(x: any): Omega { obj(x, 'OMEGA project'); if (x.id !== OMEGA_ID) throw new Error('Bad OMEGA id');
  const milestones = list(x.milestones ?? [], 100, 'Milestones').map((m: any) => ({ id: ident(obj(m, 'Milestone').id), title: req(m.title, 200, 'Milestone title'), target: optDate(m.target, 'Milestone target date'), done: bool(m.done ?? false, 'done'), missionId: optId(m.missionId, 'mission id'), notes: str(m.notes ?? '', 1000, 'Milestone notes') })); uniq(milestones.map(m => m.id), 'milestone ids');
  const hypotheses = list(x.hypotheses ?? [], 100, 'Hypotheses').map((h: any) => ({ id: ident(obj(h, 'Hypothesis').id), text: req(h.text, 1000, 'Hypothesis'), basis: str(h.basis ?? '', 1000, 'Basis'), confidence: oneOf(LEVEL, h.confidence, 'Confidence'), origin: oneOf(ORIGIN, h.origin, 'Origin'), created: iso(h.created, 'created') })); uniq(hypotheses.map(h => h.id), 'hypothesis ids');
  const options = list(x.options ?? [], 100, 'Options').map((o: any) => ({ id: ident(obj(o, 'Option').id), title: req(o.title, 200, 'Option title'), expected: str(o.expected ?? '', 1000, 'Expected outcome'), risks: str(o.risks ?? '', 1000, 'Option risks'), countermeasure: str(o.countermeasure ?? '', 1000, 'Countermeasure'), fallback: bool(o.fallback ?? false, 'fallback') })); uniq(options.map(o => o.id), 'option ids');
  const decisions = list(x.decisions ?? [], 200, 'Decisions').map((d: any) => ({ id: ident(obj(d, 'Decision').id), date: optDate(d.date, 'Decision date'), decision: req(d.decision, 1000, 'Decision'), rationale: str(d.rationale ?? '', 2000, 'Rationale'), lesson: str(d.lesson ?? '', 2000, 'Lesson') })); uniq(decisions.map(d => d.id), 'decision ids');
  return { id: OMEGA_ID, name: req(x.name, 200, 'Project name'), purpose: str(x.purpose ?? '', 3000, 'Purpose'), status: oneOf(M_STATUS, x.status, 'Status'), priority: oneOf(PRIORITY, x.priority, 'Priority'),
    constraints: str(x.constraints ?? '', 3000, 'Constraints'), notes: str(x.notes ?? '', 5000, 'Notes'), lessons: str(x.lessons ?? '', 5000, 'Lessons learned'), milestones, missionIds: ids(x.missionIds, 200, 'linked missions'),
    hypotheses, options, decisions, archiveRefs: ids(x.archiveRefs, 100, 'archive references'), created: iso(x.created, 'created'), modified: iso(x.modified, 'modified') }; }
export function validateEvent(x: any): TEvent { obj(x, 'Event'); const date = str(x.date, 10, 'Date'); if (!isDate(date)) throw new Error('Date is not a real date (use YYYY-MM-DD)');
  const time = x.time == null ? '' : str(x.time, 5, 'Time'); if (time && !isTime(time)) throw new Error('Time must look like 14:30');
  const e: TEvent = { id: ident(x.id), title: req(x.title, 200, 'Event title'), description: str(x.description ?? '', 3000, 'Description'), date, time, category: oneOf(E_CATEGORY, x.category, 'Category'),
    priority: oneOf(PRIORITY, x.priority, 'Priority'), status: oneOf(E_STATUS, x.status, 'Status'), missionId: optId(x.missionId, 'mission id'), milestoneId: optId(x.milestoneId, 'milestone id'), created: iso(x.created, 'created'), modified: iso(x.modified, 'modified') };
  if (e.category === 'history' && e.status === 'planned') throw new Error('A history event records something that already happened. Set its status to done (or cancelled).'); return e; }

// ---------- objectives: progress, blocking, dependency safety ----------
export interface Progress { done: number; total: number; pct: number | null }
/** Derived only from real objective state. A mission with no objectives has no progress figure (null), never 0% or 100%. */
export function missionProgress(m: Pick<Mission, 'tasks'>): Progress { const total = m.tasks.length, done = m.tasks.filter(t => t.done).length; return { done, total, pct: total ? Math.round((done / total) * 100) : null }; }
/** Open objectives that are waiting on an unfinished prerequisite. Value = titles of the open prerequisites. */
export function blockedTasks(m: Pick<Mission, 'tasks'>): Map<string, string[]> { const by = new Map(m.tasks.map(t => [t.id, t] as [string, Task])), out = new Map<string, string[]>();
  for (const t of m.tasks) { if (t.done) continue; const open = t.dependsOn.map(d => by.get(d)).filter((d): d is Task => !!d && !d.done).map(d => d.text); if (open.length) out.set(t.id, open); } return out; }
/** True if making `task` depend on `dep` would create a loop (or depend on itself). */
export function wouldCycle(tasks: Task[], task: string, dep: string): boolean { if (task === dep) return true; const by = new Map(tasks.map(t => [t.id, t] as [string, Task])), seen = new Set<string>(), stack = [dep];
  while (stack.length) { const c = stack.pop()!; if (c === task) return true; if (seen.has(c)) continue; seen.add(c); stack.push(...(by.get(c)?.dependsOn ?? [])); } return false; }
export const isOpenStatus = (s: MStatus) => s === 'planned' || s === 'active' || s === 'paused';
/** Overdue = has a deadline before today AND is not completed/cancelled. A passed deadline never changes the stored status. */
export const missionOverdue = (m: Mission, today: string) => !m.archived && !!m.deadline && isOpenStatus(m.status) && m.deadline < today;

export function searchMissions(ms: Mission[], q: string, status = '', archived = false): Mission[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return ms.filter(m => (archived ? m.archived : !m.archived) && (!status || m.status === status) && words.every(w => [m.title, m.objective, m.description, m.tags.join(' '), m.notes, m.tasks.map(t => t.text).join(' ')].join(' ').toLowerCase().includes(w))); }
const RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export type SortKey = 'deadline' | 'priority' | 'updated' | 'title';
export function sortMissions(ms: Mission[], by: SortKey): Mission[] { const a = [...ms];
  if (by === 'title') return a.sort((x, y) => x.title.localeCompare(y.title));
  if (by === 'priority') return a.sort((x, y) => RANK[x.priority] - RANK[y.priority] || x.title.localeCompare(y.title));
  if (by === 'updated') return a.sort((x, y) => y.modified.localeCompare(x.modified));
  return a.sort((x, y) => (x.deadline || '9999-99-99').localeCompare(y.deadline || '9999-99-99') || RANK[x.priority] - RANK[y.priority] || x.title.localeCompare(y.title)); }
export const missionCounts = (ms: Mission[], today: string) => { const live = ms.filter(m => !m.archived); return {
  total: live.length, archived: ms.length - live.length, overdue: live.filter(m => missionOverdue(m, today)).length,
  byStatus: Object.fromEntries(M_STATUS.map(s => [s, live.filter(m => m.status === s).length])) as Record<MStatus, number>,
  openTasks: live.filter(m => isOpenStatus(m.status)).reduce((n, m) => n + m.tasks.filter(t => !t.done).length, 0) }; };

// ---------- timeline ----------
export type EState = 'overdue' | 'today' | 'upcoming' | 'done' | 'cancelled';
/** Overdue needs a real date in the past (or a time earlier today) AND an event that is still planned. */
export function eventState(e: Pick<TEvent, 'date' | 'time' | 'status'>, today: string, nowTime: string): EState {
  if (e.status === 'done') return 'done'; if (e.status === 'cancelled') return 'cancelled';
  if (e.date < today) return 'overdue'; if (e.date === today) return e.time && e.time < nowTime ? 'overdue' : 'today'; return 'upcoming'; }
export interface TItem { key: string; date: string; time: string; title: string; state: EState; derived: boolean; source: string; event?: TEvent; missionId?: string; milestoneId?: string; priority: Priority; category: string }
/** One list for the timeline: stored events plus read-only entries computed from mission deadlines and OMEGA milestone targets.
 *  Derived entries are never stored, so editing a mission or milestone can never leave a stale or duplicate event behind. */
export function timelineItems(events: TEvent[], missions: Mission[], omega: Omega | null, today: string, nowTime: string): TItem[] {
  const out: TItem[] = events.map(e => ({ key: 'e:' + e.id, date: e.date, time: e.time, title: e.title, state: eventState(e, today, nowTime), derived: false, source: 'event', event: e, missionId: e.missionId, milestoneId: e.milestoneId, priority: e.priority, category: e.category }));
  for (const m of missions) { if (m.archived || !m.deadline || m.status === 'cancelled') continue;
    out.push({ key: 'm:' + m.id, date: m.deadline, time: '', title: `Deadline: ${m.title}`, state: m.status === 'completed' ? 'done' : eventState({ date: m.deadline, time: '', status: 'planned' }, today, nowTime), derived: true, source: 'mission deadline', missionId: m.id, priority: m.priority, category: 'deadline' }); }
  if (omega) for (const ms of omega.milestones) { if (!ms.target) continue;
    out.push({ key: 'o:' + ms.id, date: ms.target, time: '', title: `OMEGA milestone: ${ms.title}`, state: ms.done ? 'done' : eventState({ date: ms.target, time: '', status: 'planned' }, today, nowTime), derived: true, source: 'OMEGA milestone target', milestoneId: ms.id, priority: 'medium', category: 'milestone' }); }
  return out; }
/** Chronological: date, then untimed before timed, then time, then title, then key (stable). */
export const sortTimeline = (a: TItem[], desc = false) => [...a].sort((x, y) => { const c = x.date.localeCompare(y.date) || x.time.localeCompare(y.time) || x.title.localeCompare(y.title) || x.key.localeCompare(y.key); return desc ? -c : c; });

// ---------- OMEGA metrics ----------
export interface OmegaMetrics { milestones: Progress; tasks: Progress; linkedMissions: string[]; missing: string[]; conflicts: string[]; cancelledSkipped: number }
/** Progress shown for OMEGA is computed from milestones the user marked done and from the objectives of linked missions.
 *  When data is missing or contradicts itself it says so (null percentages, conflict list) instead of inventing a number. */
export function omegaMetrics(o: Omega, missions: Mission[]): OmegaMetrics {
  const by = new Map(missions.map(m => [m.id, m] as [string, Mission])), linked = [...new Set([...o.missionIds, ...o.milestones.map(m => m.missionId).filter(Boolean)])];
  const missing = linked.filter(i => !by.has(i)), real = linked.map(i => by.get(i)).filter((m): m is Mission => !!m), live = real.filter(m => m.status !== 'cancelled');
  const total = live.reduce((n, m) => n + m.tasks.length, 0), done = live.reduce((n, m) => n + m.tasks.filter(t => t.done).length, 0);
  const conflicts: string[] = [];
  for (const ms of o.milestones) { const m = ms.missionId ? by.get(ms.missionId) : undefined; if (!m) continue;
    if (ms.done && m.status !== 'completed') conflicts.push(`Milestone “${ms.title}” is marked done, but its mission “${m.title}” is ${m.status}${m.tasks.some(t => !t.done) ? ' with open objectives' : ''}.`);
    if (!ms.done && m.status === 'completed') conflicts.push(`Mission “${m.title}” is completed, but milestone “${ms.title}” is not marked done.`); }
  const mt = o.milestones.length, md = o.milestones.filter(m => m.done).length;
  return { milestones: { done: md, total: mt, pct: mt ? Math.round((md / mt) * 100) : null }, tasks: { done, total, pct: total ? Math.round((done / total) * 100) : null },
    linkedMissions: linked.filter(i => by.has(i)), missing, conflicts, cancelledSkipped: real.length - live.length }; }

// ---------- reference integrity ----------
export interface Issue { where: string; ref: string; kind: 'archive record' | 'mission' | 'milestone' }
/** Every reference that points at something that no longer exists. Nothing is changed automatically. */
export function opsIssues(ops: OpsBundle, recordIds: Set<string>): Issue[] {
  const out: Issue[] = [], mIds = new Set(ops.missions.map(m => m.id)), msIds = new Set((ops.omega?.milestones ?? []).map(m => m.id));
  for (const m of ops.missions) for (const r of m.archiveRefs) if (!recordIds.has(r)) out.push({ where: `Mission “${m.title}”`, ref: r, kind: 'archive record' });
  if (ops.omega) { const o = ops.omega;
    for (const r of o.archiveRefs) if (!recordIds.has(r)) out.push({ where: 'Project OMEGA', ref: r, kind: 'archive record' });
    for (const i of o.missionIds) if (!mIds.has(i)) out.push({ where: 'Project OMEGA', ref: i, kind: 'mission' });
    for (const m of o.milestones) if (m.missionId && !mIds.has(m.missionId)) out.push({ where: `OMEGA milestone “${m.title}”`, ref: m.missionId, kind: 'mission' }); }
  for (const e of ops.events) { if (e.missionId && !mIds.has(e.missionId)) out.push({ where: `Event “${e.title}”`, ref: e.missionId, kind: 'mission' }); if (e.milestoneId && !msIds.has(e.milestoneId)) out.push({ where: `Event “${e.title}”`, ref: e.milestoneId, kind: 'milestone' }); }
  return out; }
/** Copies of only the objects that hold dangling references, with those references removed. Used by "Remove broken references" after confirmation. */
export function stripBrokenRefs(ops: OpsBundle, recordIds: Set<string>): { missions: Mission[]; omega: Omega | null; events: TEvent[]; removed: number } {
  const mIds = new Set(ops.missions.map(m => m.id)), msIds = new Set((ops.omega?.milestones ?? []).map(m => m.id)); let removed = 0;
  const missions = ops.missions.flatMap(m => { const k = m.archiveRefs.filter(r => recordIds.has(r)); if (k.length === m.archiveRefs.length) return []; removed += m.archiveRefs.length - k.length; return [{ ...m, archiveRefs: k }]; });
  let omega: Omega | null = null;
  if (ops.omega) { const o = ops.omega, ar = o.archiveRefs.filter(r => recordIds.has(r)), mi = o.missionIds.filter(i => mIds.has(i)), ms = o.milestones.map(x => (x.missionId && !mIds.has(x.missionId) ? { ...x, missionId: '' } : x));
    const n = (o.archiveRefs.length - ar.length) + (o.missionIds.length - mi.length) + o.milestones.filter(x => x.missionId && !mIds.has(x.missionId)).length;
    if (n) { removed += n; omega = { ...o, archiveRefs: ar, missionIds: mi, milestones: ms }; } }
  const events = ops.events.flatMap(e => { const bm = e.missionId && !mIds.has(e.missionId), bs = e.milestoneId && !msIds.has(e.milestoneId); if (!bm && !bs) return []; removed += (bm ? 1 : 0) + (bs ? 1 : 0); return [{ ...e, missionId: bm ? '' : e.missionId, milestoneId: bs ? '' : e.milestoneId }]; });
  return { missions, omega, events, removed }; }

// ---------- backup section ----------
export const MAX_MISSIONS = 1000, MAX_EVENTS = 5000;
/** Validates the optional `ops` part of a backup file. Any invalid item rejects the whole section with a message naming it. */
export function parseOps(d: any): OpsBundle { if (d == null) return { missions: [], omega: null, events: [] }; obj(d, 'ops section');
  const wrap = <T>(kind: string, arr: unknown, max: number, v: (x: any) => T, idOf: (t: T) => string): T[] => { const l = list(arr ?? [], max, kind), seen = new Set<string>();
    return l.map((x, i) => { try { const t = v(x), k = idOf(t); if (seen.has(k)) throw new Error('duplicate id'); seen.add(k); return t; } catch (e) { throw new Error(`${kind} ${i + 1}: ${(e as Error).message}`); } }); };
  let omega: Omega | null = null; if (d.omega != null) { try { omega = validateOmega(d.omega); } catch (e) { throw new Error(`OMEGA project: ${(e as Error).message}`); } }
  return { missions: wrap('Mission', d.missions, MAX_MISSIONS, validateMission, m => m.id), omega, events: wrap('Event', d.events, MAX_EVENTS, validateEvent, e => e.id) }; }
/** Parses a whole backup file: archive records (existing rules) plus the optional Stage 5 section. Old backups without `ops` give an empty bundle. */
export function parseFullBackup(text: string): { records: Rec[]; ops: OpsBundle } { const records = parseBackup(text); return { records, ops: parseOps(JSON.parse(text).ops) }; }
