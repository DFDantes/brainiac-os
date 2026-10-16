import { Rec, Backup, SCHEMA, uid, validateRecord, brokenLinks } from './model';
import { Mission, Omega, TEvent, OpsBundle, validateMission, validateOmega, validateEvent, parseOps, opsIssues, stripBrokenRefs, OMEGA_ID } from './ops';
export const DB_NAME = 'brainiac-os', DB_VERSION = 3; // v2 (Stage 3): index audit.recordId for per-record history. v3 (Stage 5): stores missions, omega, events (additive; nothing existing is touched). Backup format SCHEMA is separate and unchanged (1).
let dbp: Promise<IDBDatabase> | null = null;
export function openDB(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => { const d = r.result, t = r.transaction!; // idempotent steps so a fresh install (0) and an upgrade (1) both end at the same schema
      if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' }).createIndex('kind', 'kind');
      if (!d.objectStoreNames.contains('audit')) d.createObjectStore('audit', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      const a = t.objectStore('audit'); if (!a.indexNames.contains('recordId')) a.createIndex('recordId', 'recordId');
      for (const n of OPS_STORES) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbp = null; }; res(d); };
    r.onerror = () => { dbp = null; rej(r.error); }; r.onblocked = () => rej(new Error('Database blocked by another tab'));
  });
  return dbp;
}
const OPS_STORES = ['missions', 'omega', 'events'] as const;
const ALL_STORES = ['records', 'audit', 'meta', ...OPS_STORES];
type Stores = { records: IDBObjectStore; audit: IDBObjectStore; meta: IDBObjectStore; missions: IDBObjectStore; omega: IDBObjectStore; events: IDBObjectStore };
// Resolves only after the transaction commits, so a failed write is never reported as success.
async function write(fn: (s: Stores) => void): Promise<void> {
  const d = await openDB();
  return new Promise((res, rej) => { const t = d.transaction(ALL_STORES, 'readwrite');
    try { fn({ records: t.objectStore('records'), audit: t.objectStore('audit'), meta: t.objectStore('meta'), missions: t.objectStore('missions'), omega: t.objectStore('omega'), events: t.objectStore('events') }); } catch (e) { t.abort(); rej(e); return; }
    t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Write aborted')); });
}
async function read<T>(store: string, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await openDB();
  return new Promise((res, rej) => { const r = fn(d.transaction(store).objectStore(store)); r.onsuccess = () => res(r.result as T); r.onerror = () => rej(r.error); });
}
let lastTs = 0; // audit timestamps never repeat or go backwards within a session, so history order is reliable
const nextTs = () => { lastTs = Math.max(Date.now(), lastTs + 1); return new Date(lastTs).toISOString(); };
const entry = (action: string, rec: Rec, before?: Rec) => ({ id: uid(), ts: nextTs(), action, recordId: rec.id, name: rec.name, before: before ?? null });

export const getAll = () => read<Rec[]>('records', s => s.getAll());
export const get = (id: string) => read<Rec | undefined>('records', s => s.get(id));
export const auditAll = () => read<any[]>('audit', s => s.getAll());
/** Saves a record. The previous version is read inside the same transaction as the write, so two overlapping saves can never record a wrong 'before' (A6). */
export async function save(rec: Rec): Promise<void> {
  const next = { ...rec, modified: new Date().toISOString() };
  await write(s => { const g = s.records.get(rec.id); g.onsuccess = () => { const before = g.result as Rec | undefined; s.records.put(next); s.audit.put(entry(before ? 'update' : 'create', next, before)); }; });
}
/** Deletes a record, keeps it in the audit trail, and removes now-dangling links from other records. */
export async function remove(id: string): Promise<void> {
  const all = await getAll(); const before = all.find(r => r.id === id); if (!before) return;
  const linked = all.filter(r => r.id !== id && r.links.includes(id));
  await write(s => { s.records.delete(id); s.audit.put(entry('delete', before, before));
    for (const r of linked) { const n = { ...r, links: r.links.filter(l => l !== id), modified: new Date().toISOString() }; s.records.put(n); s.audit.put(entry('unlink', n, r)); } });
}
const notOlder = (a: Rec, b: Rec) => Date.parse(a.modified) >= Date.parse(b.modified);
/** Dry run of a restore: how many records are new, would replace older ones, or are left alone because the local copy is the same or newer (A3). */
export async function planImport(recs: Rec[]): Promise<{ added: number; replace: number; keep: number }> {
  const have = new Map((await getAll()).map(r => [r.id, r] as [string, Rec])); let added = 0, replace = 0, keep = 0;
  for (const r of recs) { const b = have.get(r.id); if (!b) added++; else if (notOlder(b, r)) keep++; else replace++; }
  return { added, replace, keep };
}
/** Merges records by ID. Replaced records are preserved in the audit trail. With keepNewer, records whose local copy is the same age or newer are left untouched. */
export async function importRecords(recs: Rec[], action = 'import', opts: { keepNewer?: boolean } = {}): Promise<{ added: number; replaced: number }> {
  const have = new Map((await getAll()).map(r => [r.id, r] as [string, Rec])); let added = 0, replaced = 0;
  await write(s => { for (const r of recs) { const b = have.get(r.id); if (b && opts.keepNewer && notOlder(b, r)) continue;
    if (b) replaced++; else added++; s.records.put(r); s.audit.put(entry(action, r, b)); } });
  return { added, replaced };
}
export async function clearAll(): Promise<void> { await write(s => { s.records.clear(); s.audit.clear(); s.meta.clear(); s.missions.clear(); s.omega.clear(); s.events.clear(); }); }
/** Audit history is excluded by default: restore ignores it and it grows without limit, which could make backups too large to restore (A1). */
export async function exportBackup(includeAudit = false): Promise<Backup> {
  const o = await getOps();
  return { app: 'brainiac-os', schema: SCHEMA, exported: new Date().toISOString(), records: await getAll(), audit: includeAudit ? await auditAll() : [], ops: { missions: o.missions, omega: o.omega, events: o.events } };
}
export const getMeta = async (k: string) => (await read<{ value: string } | undefined>('meta', s => s.get(k)))?.value;
export const setMeta = (k: string, v: string) => write(s => { s.meta.put({ key: k, value: v }); });

/** Asks the browser not to evict this site's data (A2). Returns null when unsupported or the request fails; never throws. */
export async function requestPersistence(): Promise<boolean | null> {
  try { const st = (typeof navigator !== 'undefined' ? navigator.storage : undefined) as StorageManager | undefined; if (!st || typeof st.persist !== 'function') return null;
    if (typeof st.persisted === 'function' && await st.persisted()) return true; return await st.persist(); } catch { return null; }
}

// ---- Safety copy: one automatic snapshot of the records, taken before a restore or erase, so the last destructive action can be undone (A4).
const SNAP = 'snapshot';
export interface SnapshotInfo { ts: string; reason: string; count: number; ops?: number }
/** Saves the current records as the safety copy. Does nothing when the archive is empty, so an earlier useful copy is never overwritten by nothing. */
export async function snapshot(reason: string): Promise<boolean> {
  const records = await getAll(), o = await getOps(); if (!records.length && !o.missions.length && !o.events.length && !o.omega) return false;
  await setMeta(SNAP, JSON.stringify({ ts: new Date().toISOString(), reason, records, ops: { missions: o.missions, omega: o.omega, events: o.events } })); return true;
}
export async function getSnapshotInfo(): Promise<SnapshotInfo | null> {
  try { const raw = await getMeta(SNAP); if (!raw) return null; const d = JSON.parse(raw); if (!Array.isArray(d.records)) return null;
    const o = d.ops && typeof d.ops === 'object' ? d.ops : null;
    return { ts: String(d.ts), reason: String(d.reason), count: d.records.length, ...(o ? { ops: (Array.isArray(o.missions) ? o.missions.length : 0) + (Array.isArray(o.events) ? o.events.length : 0) + (o.omega ? 1 : 0) } : {}) }; } catch { return null; }
}
export const discardSnapshot = () => write(s => { s.meta.delete(SNAP); });
/** Replaces all records with the safety copy. The current records become the new safety copy, so undo can itself be undone. Returns the record count restored. */
export async function undoLast(): Promise<number> {
  const raw = await getMeta(SNAP); if (!raw) throw new Error('There is no safety copy to restore.');
  let recs: Rec[], ops: OpsBundle | null = null; try { const d = JSON.parse(raw); if (!Array.isArray(d.records)) throw new Error('x'); recs = d.records.map((r: unknown) => validateRecord(r)); if (d.ops != null) ops = parseOps(d.ops); }
  catch { throw new Error('The safety copy is damaged and cannot be restored.'); }
  await snapshot('before undo');
  await write(s => { s.records.clear(); for (const r of recs) { s.records.put(r); s.audit.put(entry('undo', r)); }
    if (ops) { s.missions.clear(); s.omega.clear(); s.events.clear(); ops.missions.forEach(m => s.missions.put(m)); if (ops.omega) s.omega.put(ops.omega); ops.events.forEach(e => s.events.put(e)); } }); // older safety copies have no ops section: missions/OMEGA/events are then left as they are
  return recs.length;
}
/** Erases everything except the safety copy, which stays so the erase can be undone until the user discards it. */
export async function eraseAll(): Promise<void> {
  await snapshot('before erase'); const raw = await getMeta(SNAP);
  await write(s => { s.records.clear(); s.audit.clear(); s.meta.clear(); s.missions.clear(); s.omega.clear(); s.events.clear(); if (raw) s.meta.put({ key: SNAP, value: raw }); });
}

// ---- Stage 3: per-record history, version restore, deleted-record recovery, broken-link repair.
export interface HistItem { id: string; ts: string; action: string; name: string; before: Rec | null; after: Rec | null; damaged: boolean }
const safeRec = (x: unknown): Rec | null => { try { return x ? validateRecord(x) : null; } catch { return null; } };
/** Oldest-first history of one record. `after` is the version the record had once the change was made (the next entry's `before`, or the current record). */
export async function recordHistory(id: string): Promise<HistItem[]> {
  const es = (await read<any[]>('audit', s => s.index('recordId').getAll(id))).sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)));
  const cur = await get(id);
  return es.map((e, i) => { const before = safeRec(e.before);
    const after = e.action === 'delete' ? null : i + 1 < es.length ? safeRec(es[i + 1].before) : cur ?? null;
    return { id: String(e.id), ts: String(e.ts), action: String(e.action), name: String(e.name ?? ''), before, after, damaged: !!e.before && !before }; });
}
/** Records that were deleted and are not in the archive now (newest delete first, one per record). */
export async function listDeleted(): Promise<{ entryId: string; recordId: string; name: string; ts: string }[]> {
  const have = new Set((await getAll()).map(r => r.id)), seen = new Set<string>();
  return (await auditAll()).filter(e => e.action === 'delete' && e.before && !have.has(e.recordId)).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .filter(e => !seen.has(e.recordId) && !!seen.add(e.recordId)).map(e => ({ entryId: String(e.id), recordId: String(e.recordId), name: String(e.name ?? ''), ts: String(e.ts) }));
}
/** Makes the version stored in a history entry current again (also recreates a deleted record). The version being replaced is kept in history, so this can be reversed. Links to records that no longer exist are dropped and counted. */
export async function restoreVersion(entryId: string): Promise<{ record: Rec; droppedLinks: number }> {
  const e = await read<any>('audit', s => s.get(entryId)); if (!e || !e.before) throw new Error('That history entry has no earlier version to restore.');
  const rec = safeRec(e.before); if (!rec) throw new Error('That history entry is damaged and cannot be restored.');
  const ids = new Set((await getAll()).map(r => r.id)), links = rec.links.filter(l => ids.has(l) && l !== rec.id);
  await save({ ...rec, links }); return { record: rec, droppedLinks: rec.links.length - links.length };
}
/** Removes links that point to records which do not exist. Each change is audited. Returns how many links were removed. */
export async function removeBrokenLinks(): Promise<number> {
  const all = await getAll(); if (!brokenLinks(all).length) return 0;
  const ids = new Set(all.map(r => r.id)); let n = 0;
  await write(s => { for (const r of all) { const keep = r.links.filter(l => ids.has(l)); if (keep.length === r.links.length) continue; n += r.links.length - keep.length;
    const next = { ...r, links: keep, modified: new Date().toISOString() }; s.records.put(next); s.audit.put(entry('unlink', next, r)); } });
  return n;
}

// ---------- Stage 5: Colossus missions, Project OMEGA, Strategic Timeline ----------
// Stored in their own object stores (v3). Records are validated on every read; a damaged item is NOT deleted, only counted and skipped,
// so a bad entry can never silently destroy data. Changes to these stores are not written to the archive audit trail (see HANDOVER);
// deletions go to a recoverable trash (meta key opsTrash, newest 25) and everything is included in backups and the safety copy.
async function readValid<T>(store: typeof OPS_STORES[number], v: (x: any) => T): Promise<{ ok: T[]; damaged: number }> {
  const raw = await read<unknown[]>(store, s => s.getAll()), ok: T[] = []; let damaged = 0;
  for (const x of raw) { try { ok.push(v(x)); } catch { damaged++; } } return { ok, damaged }; }
export async function getOps(): Promise<OpsBundle & { damaged: number }> {
  const [m, o, e] = await Promise.all([readValid('missions', validateMission), readValid('omega', validateOmega), readValid('events', validateEvent)]);
  return { missions: m.ok, omega: o.ok.find(x => x.id === OMEGA_ID) ?? null, events: e.ok, damaged: m.damaged + o.damaged + e.damaged }; }
export const getMissions = async () => (await getOps()).missions;
export const getEvents = async () => (await getOps()).events;
export const getOmega = async () => (await getOps()).omega;

/** Read-modify-write inside ONE transaction, so two quick taps can never overwrite each other with a stale copy. The result is validated before it is stored; if validation fails nothing is written. */
async function mutate<T extends { id: string }>(store: typeof OPS_STORES[number], id: string, v: (x: any) => T, fn: (cur: T) => T): Promise<T> {
  const d = await openDB();
  return new Promise<T>((res, rej) => {
    const t = d.transaction(store, 'readwrite'), os = t.objectStore(store); let out: T | undefined; const g = os.get(id);
    g.onsuccess = () => { try { if (!g.result) throw new Error('That item no longer exists.'); const cur = v(g.result);
      out = v({ ...fn(JSON.parse(JSON.stringify(cur))), id, modified: new Date().toISOString() }); os.put(out); } catch (e) { rej(e); try { t.abort(); } catch { /* already aborted */ } } };
    t.oncomplete = () => res(out!); t.onabort = () => rej(t.error || new Error('Write aborted')); t.onerror = () => rej(t.error); }); }
export const mutateMission = (id: string, fn: (m: Mission) => Mission) => mutate('missions', id, validateMission, fn);
export const mutateOmega = (fn: (o: Omega) => Omega) => mutate('omega', OMEGA_ID, validateOmega, fn);
export async function saveMission(m: Mission): Promise<Mission> { const next = validateMission({ ...m, modified: new Date().toISOString() }); await write(s => { s.missions.put(next); }); return next; }
export async function saveEvent(e: TEvent): Promise<TEvent> { const next = validateEvent({ ...e, modified: new Date().toISOString() }); await write(s => { s.events.put(next); }); return next; }
export async function saveOmega(o: Omega): Promise<Omega> { const next = validateOmega({ ...o, id: OMEGA_ID, modified: new Date().toISOString() }); await write(s => { s.omega.put(next); }); return next; }

export interface TrashItem { id: string; ts: string; type: 'mission' | 'event' | 'omega'; title: string; item: unknown }
const TRASH = 'opsTrash';
export async function getTrash(): Promise<TrashItem[]> {
  try { const raw = await getMeta(TRASH); const a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a.filter((x: any) => x && typeof x.id === 'string' && ['mission', 'event', 'omega'].includes(x.type) && x.item && typeof x.item === 'object').map((x: any) => ({ id: String(x.id), ts: String(x.ts), type: x.type, title: String(x.title ?? ''), item: x.item })) : []; } catch { return []; } }
const trashEntry = async (type: TrashItem['type'], title: string, item: unknown) => JSON.stringify([{ id: uid(), ts: new Date().toISOString(), type, title, item }, ...(await getTrash())].slice(0, 25));

/** Deletes a mission. Events that pointed at it are kept (their mission link is cleared), and OMEGA loses the link; nothing else is deleted. The mission goes to the trash. */
export async function deleteMission(id: string): Promise<{ events: number; omega: boolean }> {
  const o = await getOps(), m = o.missions.find(x => x.id === id); if (!m) throw new Error('That mission no longer exists.');
  const evs = o.events.filter(e => e.missionId === id), om = o.omega && (o.omega.missionIds.includes(id) || o.omega.milestones.some(x => x.missionId === id)) ? o.omega : null, t = await trashEntry('mission', m.title, m), ts = new Date().toISOString();
  await write(s => { s.missions.delete(id); for (const e of evs) s.events.put({ ...e, missionId: '', modified: ts });
    if (om) s.omega.put({ ...om, missionIds: om.missionIds.filter(x => x !== id), milestones: om.milestones.map(x => (x.missionId === id ? { ...x, missionId: '' } : x)), modified: ts }); s.meta.put({ key: TRASH, value: t }); });
  return { events: evs.length, omega: !!om }; }
/** Deletes one timeline event. Missions, objectives and OMEGA are untouched. */
export async function deleteEvent(id: string): Promise<void> { const e = (await getEvents()).find(x => x.id === id); if (!e) throw new Error('That event no longer exists.'); const t = await trashEntry('event', e.title, e); await write(s => { s.events.delete(id); s.meta.put({ key: TRASH, value: t }); }); }
export async function deleteOmega(): Promise<void> { const o = await getOmega(); if (!o) throw new Error('There is no OMEGA project.'); const ev = (await getEvents()).filter(e => e.milestoneId && o.milestones.some(m => m.id === e.milestoneId)), t = await trashEntry('omega', o.name, o), ts = new Date().toISOString();
  await write(s => { s.omega.delete(OMEGA_ID); for (const e of ev) s.events.put({ ...e, milestoneId: '', modified: ts }); s.meta.put({ key: TRASH, value: t }); }); }
/** Puts a trashed item back exactly as it was. Links other items had to it were cleared at deletion and are not recreated. */
export async function restoreTrash(id: string): Promise<TrashItem> {
  const all = await getTrash(), t = all.find(x => x.id === id); if (!t) throw new Error('That trash entry no longer exists.'); const o = await getOps(); let item: Mission | Omega | TEvent;
  try { item = t.type === 'mission' ? validateMission(t.item) : t.type === 'omega' ? validateOmega(t.item) : validateEvent(t.item); } catch { throw new Error('That trash entry is damaged and cannot be restored.'); }
  if (t.type === 'mission' && o.missions.some(m => m.id === item.id)) throw new Error('A mission with this ID already exists.'); if (t.type === 'event' && o.events.some(e => e.id === item.id)) throw new Error('An event with this ID already exists.'); if (t.type === 'omega' && o.omega) throw new Error('A Project OMEGA already exists. Delete it first if you want to restore this one.');
  const rest = JSON.stringify(all.filter(x => x.id !== id));
  await write(s => { (t.type === 'mission' ? s.missions : t.type === 'omega' ? s.omega : s.events).put(item); s.meta.put({ key: TRASH, value: rest }); }); return t; }

/** Dangling references (to deleted archive records, missions or milestones), listed without changing anything. */
export async function findOpsIssues() { const o = await getOps(); return opsIssues(o, new Set((await getAll()).map(r => r.id))); }
/** Removes dangling references after the user confirmed. Only the reference is removed, never a mission, event or record. */
export async function removeBrokenOpsRefs(): Promise<number> {
  const o = await getOps(), r = stripBrokenRefs(o, new Set((await getAll()).map(x => x.id))); if (!r.removed) return 0; const ts = new Date().toISOString();
  await write(s => { r.missions.forEach(m => s.missions.put({ ...m, modified: ts })); if (r.omega) s.omega.put({ ...r.omega, modified: ts }); r.events.forEach(e => s.events.put({ ...e, modified: ts })); }); return r.removed; }

const newer = (a: { modified: string }, b: { modified: string }) => Date.parse(a.modified) >= Date.parse(b.modified);
/** Dry run for restore: how many missions/events/OMEGA would be added, replace an older local copy, or be left because the local copy is the same or newer. */
export async function planImportOps(ops: OpsBundle): Promise<{ added: number; replace: number; keep: number }> {
  const l = await getOps(); let added = 0, replace = 0, keep = 0;
  const tally = (inc: { id: string; modified: string }[], have: { id: string; modified: string }[]) => { const m = new Map(have.map(x => [x.id, x])); for (const x of inc) { const b = m.get(x.id); if (!b) added++; else if (newer(b, x)) keep++; else replace++; } };
  tally(ops.missions, l.missions); tally(ops.events, l.events); if (ops.omega) tally([ops.omega], l.omega ? [l.omega] : []); return { added, replace, keep }; }
/** Merges by ID; a local copy that is the same age or newer always wins. Nothing is deleted. */
export async function importOps(ops: OpsBundle): Promise<{ added: number; replaced: number; kept: number }> {
  const l = await getOps(); let added = 0, replaced = 0, kept = 0;
  await write(s => { const go = (st: IDBObjectStore, inc: { id: string; modified: string }[], have: { id: string; modified: string }[]) => { const m = new Map(have.map(x => [x.id, x]));
      for (const x of inc) { const b = m.get(x.id); if (b && newer(b, x)) { kept++; continue; } if (b) replaced++; else added++; st.put(x); } };
    go(s.missions, ops.missions, l.missions); go(s.events, ops.events, l.events); if (ops.omega) go(s.omega, [ops.omega], l.omega ? [l.omega] : []); });
  return { added, replaced, kept }; }
