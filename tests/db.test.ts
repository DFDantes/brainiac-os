import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import * as db from '../src/db';
import { brokenLinks, diffFields, newRecord, parseBackup, validateRecord, matches, sampleRecords, serializeBackup } from '../src/model';

beforeEach(async () => { await db.clearAll(); });

describe('records', () => {
  it('creates, edits, searches and deletes with an audit trail', async () => {
    const r = newRecord({ name: 'Ultron', kind: 'character', tags: ['ai'] });
    await db.save(r);
    expect((await db.get(r.id))?.name).toBe('Ultron');
    await db.save({ ...r, description: 'Subordinate' });
    expect((await db.getAll()).filter(x => matches(x, 'subordinate'))).toHaveLength(1);
    await db.remove(r.id);
    expect(await db.get(r.id)).toBeUndefined();
    const a = await db.auditAll();
    expect(a.map(x => x.action).sort()).toEqual(['create', 'delete', 'update']);
    expect(a.find(x => x.action === 'delete').before.name).toBe('Ultron');
  });
  it('rejects invalid records', () => {
    expect(() => validateRecord(newRecord({ name: ' ' }))).toThrow();
    expect(() => validateRecord({ ...newRecord({ name: 'x' }), kind: 'hax' })).toThrow();
  });
  it('sample data is valid and labelled user-supplied', () => {
    for (const r of sampleRecords()) { validateRecord(r); expect(r.source).toMatch(/User-supplied/); }
  });
});

describe('backup', () => {
  it('round-trips export and import', async () => {
    await db.importRecords(sampleRecords(), 'sample');
    const text = JSON.stringify(await db.exportBackup());
    await db.clearAll();
    expect(await db.getAll()).toHaveLength(0);
    await db.importRecords(parseBackup(text));
    expect(await db.getAll()).toHaveLength(sampleRecords().length);
  });
  it('rejects malformed and malicious files', () => {
    const ok = { app: 'brainiac-os', schema: 1, records: [newRecord({ name: 'a' })] };
    expect(() => parseBackup('not json')).toThrow(/JSON/);
    expect(() => parseBackup(JSON.stringify({ ...ok, app: 'other' }))).toThrow();
    expect(() => parseBackup(JSON.stringify({ ...ok, schema: 99 }))).toThrow(/version/);
    expect(() => parseBackup(JSON.stringify({ ...ok, records: [{ ...ok.records[0], name: 'x'.repeat(201) }] }))).toThrow();
    expect(() => parseBackup(JSON.stringify({ ...ok, records: [ok.records[0], ok.records[0]] }))).toThrow(/duplicate/);
    expect(() => parseBackup('x'.repeat(5_000_001))).toThrow(/large/);
    const p = parseBackup('{"app":"brainiac-os","schema":1,"records":[{"__proto__":{"polluted":1},"id":"a","name":"n","kind":"note","confidence":"unknown","created":"2026-01-01","modified":"2026-01-01"}]}');
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.keys(p[0])).not.toContain('polluted');
  });
});

import { cleanQuery } from '../src/model';
describe('search, links and import', () => {
  it('turns commands into keywords and handles plurals', () => {
    expect(cleanQuery('What do we know about Ultron?')).toBe('ultron');
    expect(cleanQuery('Show me every faction we have recorded.')).toBe('faction');
    const pc = sampleRecords().find(r => r.id === 'sample-pc')!;
    expect(matches(pc, 'factions')).toBe(true);
    expect(matches(pc, 'zzz')).toBe(false);
  });
  it('sample links all resolve; mechanics are user-supplied and flagged for detail', () => {
    const s = sampleRecords(), ids = new Set(s.map(r => r.id));
    for (const r of s) for (const l of r.links) expect(ids.has(l), `${r.id} -> ${l}`).toBe(true);
    const m = s.filter(r => r.kind === 'mechanic');
    expect(m.map(r => r.name)).toEqual(expect.arrayContaining(['Palladium', 'Reordinary', 'FSang', 'Powerborne', 'Custom abilities']));
    for (const r of m) { expect(r.source).toMatch(/User-supplied/); expect(r.tags).toContain('needs-detail'); }
  });
  it('removes dangling links on delete and keeps history', async () => {
    await db.importRecords(sampleRecords(), 'sample');
    await db.remove('sample-ultron');
    for (const r of await db.getAll()) expect(r.links).not.toContain('sample-ultron');
    expect((await db.auditAll()).some(a => a.action === 'delete' && a.recordId === 'sample-ultron')).toBe(true);
  });
  it('preserves the old version when an import replaces a record', async () => {
    const r = newRecord({ id: 'x1', name: 'Old' }); await db.save(r);
    const res = await db.importRecords([{ ...r, name: 'New' }]);
    expect(res).toEqual({ added: 0, replaced: 1 });
    expect((await db.auditAll()).find(a => a.action === 'import').before.name).toBe('Old');
  });
});

const at = (id: string, name: string, modified: string, extra = {}) => newRecord({ id, name, created: modified, modified, ...extra });

describe('stage 1: data safety', () => {
  it('default backup excludes the audit history; the full option includes it (A1)', async () => {
    await db.importRecords(sampleRecords(), 'sample');
    expect((await db.exportBackup()).audit).toEqual([]);
    expect((await db.exportBackup(true)).audit.length).toBeGreaterThan(0);
  });
  it('a heavily edited archive still produces a restorable backup (A1)', async () => {
    const r = newRecord({ id: 'heavy', name: 'Heavy', description: 'x'.repeat(5000) });
    for (let i = 0; i < 400; i++) await db.save({ ...r, notes: 'edit ' + i });
    const text = serializeBackup(await db.exportBackup());
    expect(text.length).toBeLessThan(100_000);
    expect(parseBackup(text)).toHaveLength(1);
  });
  it('refuses to create a backup that restore would reject (A1)', () => {
    const big = Array.from({ length: 1100 }, (_, i) => newRecord({ id: 'big' + i, name: 'n' + i, description: 'x'.repeat(5000) }));
    expect(() => serializeBackup({ app: 'brainiac-os', schema: 1, exported: '', records: big, audit: [] })).toThrow(/more than/);
  });
  it('requestPersistence never throws and returns a boolean or null (A2)', async () => {
    const v = await db.requestPersistence(); expect(v === null || typeof v === 'boolean').toBe(true);
  });
  it('planImport counts new, replaced and kept records (A3)', async () => {
    await db.importRecords([at('a', 'A', '2026-02-01T00:00:00.000Z'), at('b', 'B', '2026-02-01T00:00:00.000Z'), at('c', 'C', '2026-02-01T00:00:00.000Z')]);
    const plan = await db.planImport([at('a', 'A-old', '2026-01-01T00:00:00.000Z'), at('b', 'B-new', '2026-03-01T00:00:00.000Z'), at('c', 'C-same', '2026-02-01T00:00:00.000Z'), at('d', 'D', '2026-01-01T00:00:00.000Z')]);
    expect(plan).toEqual({ added: 1, replace: 1, keep: 2 });
  });
  it('keepNewer leaves newer and identical local records untouched (A3)', async () => {
    await db.importRecords([at('a', 'Local newer', '2026-02-01T00:00:00.000Z'), at('b', 'Local older', '2026-01-01T00:00:00.000Z')]);
    const res = await db.importRecords([at('a', 'Backup older', '2026-01-01T00:00:00.000Z'), at('b', 'Backup newer', '2026-03-01T00:00:00.000Z'), at('c', 'Brand new', '2026-01-01T00:00:00.000Z')], 'import', { keepNewer: true });
    expect(res).toEqual({ added: 1, replaced: 1 });
    expect((await db.get('a'))?.name).toBe('Local newer'); expect((await db.get('b'))?.name).toBe('Backup newer'); expect((await db.get('c'))?.name).toBe('Brand new');
    expect((await db.auditAll()).find(a => a.recordId === 'b' && a.action === 'import' && a.before).before.name).toBe('Local older');
  });
  it('snapshot then undo restores the earlier records, and undo can itself be undone (A4)', async () => {
    await db.importRecords([at('a', 'One', '2026-01-01T00:00:00.000Z'), at('b', 'Two', '2026-01-01T00:00:00.000Z')]);
    expect(await db.snapshot('test')).toBe(true);
    await db.remove('a'); await db.save(at('z', 'Three', '2026-01-01T00:00:00.000Z'));
    expect((await db.getSnapshotInfo())?.count).toBe(2);
    expect(await db.undoLast()).toBe(2);
    expect((await db.getAll()).map(r => r.id).sort()).toEqual(['a', 'b']);
    expect(await db.undoLast()).toBe(2); // the post-edit state was kept as the new safety copy
    expect((await db.getAll()).map(r => r.id).sort()).toEqual(['b', 'z']);
  });
  it('an empty archive never overwrites an existing safety copy (A4)', async () => {
    await db.importRecords([at('a', 'One', '2026-01-01T00:00:00.000Z')]); await db.snapshot('first');
    await db.remove('a'); expect(await db.getAll()).toHaveLength(0);
    expect(await db.snapshot('empty')).toBe(false); expect((await db.getSnapshotInfo())?.count).toBe(1);
  });
  it('eraseAll keeps the safety copy so the erase can be undone; discard removes it (A4)', async () => {
    await db.importRecords(sampleRecords(), 'sample'); await db.setMeta('lookupPass', 'secret');
    const n = (await db.getAll()).length; await db.eraseAll();
    expect(await db.getAll()).toHaveLength(0); expect(await db.auditAll()).toHaveLength(0); expect(await db.getMeta('lookupPass')).toBeUndefined();
    expect((await db.getSnapshotInfo())?.count).toBe(n);
    expect(await db.undoLast()).toBe(n); expect(await db.getAll()).toHaveLength(n);
    await db.discardSnapshot(); expect(await db.getSnapshotInfo()).toBeNull();
  });
  it('undo fails clearly with no safety copy or a damaged one (A4)', async () => {
    await expect(db.undoLast()).rejects.toThrow(/no safety copy/);
    await db.setMeta('snapshot', '{"records":[{"id":"a"}]}'); await expect(db.undoLast()).rejects.toThrow(/damaged/);
    await db.setMeta('snapshot', 'not json'); await expect(db.undoLast()).rejects.toThrow(/damaged/); expect(await db.getSnapshotInfo()).toBeNull();
  });
});

describe('Stage 3: history, restore, recovery, integrity', () => {
  it('keeps a correct, ordered history per record', async () => {
    const r = newRecord({ name: 'Brainiac', kind: 'character' }); await db.save(r); await db.save({ ...r, status: 'a' }); await db.save({ ...r, status: 'b' });
    const h = await db.recordHistory(r.id); expect(h.map(x => x.action)).toEqual(['create', 'update', 'update']);
    expect(h[1].before?.status).toBe(''); expect(h[1].after?.status).toBe('a'); expect(h[2].before?.status).toBe('a'); expect(h[2].after?.status).toBe('b');
    expect(diffFields(h[2].before!, h[2].after!).map(d => d.field)).toEqual(['status']);
  });
  it('overlapping saves of one record still produce a consistent chain (A6)', async () => {
    const r = newRecord({ name: 'Race' }); await db.save(r);
    await Promise.all(['one', 'two', 'three'].map(d => db.save({ ...r, description: d })));
    const h = await db.recordHistory(r.id); expect(h).toHaveLength(4);
    const seen = new Set(h.slice(1).map(x => x.before?.description)); expect(seen.size).toBe(3); // every update recorded a distinct previous version
    expect(h[3].after?.description).toBe((await db.get(r.id))!.description);
  });
  it('restores an earlier version and the replaced one stays in history', async () => {
    const r = newRecord({ name: 'X', description: 'v1' }); await db.save(r); await db.save({ ...r, description: 'v2' });
    const upd = (await db.recordHistory(r.id)).find(x => x.action === 'update')!; const out = await db.restoreVersion(upd.id);
    expect(out.record.description).toBe('v1'); expect((await db.get(r.id))!.description).toBe('v1');
    expect((await db.recordHistory(r.id)).some(x => x.before?.description === 'v2')).toBe(true);
  });
  it('recovers a deleted record, dropping links to records that are gone', async () => {
    const a = newRecord({ name: 'A' }), b = newRecord({ name: 'B', links: [a.id] }); await db.save(a); await db.save(b);
    await db.remove(b.id); await db.remove(a.id); const del = await db.listDeleted(); expect(del.map(d => d.name).sort()).toEqual(['A', 'B']);
    const rb = await db.restoreVersion(del.find(d => d.name === 'B')!.entryId); expect(rb.droppedLinks).toBe(1); // B's last version linked to A, which is deleted too, so the link is dropped and reported
    expect((await db.get(b.id))!.links).toEqual([]); expect((await db.listDeleted()).map(d => d.name)).toEqual(['A']);
  });
  it('refuses a damaged history entry', async () => {
    const r = newRecord({ name: 'Y' }); await db.save(r); await db.save({ ...r, name: 'Y2' });
    const d = await openRaw(); await new Promise<void>(res => { const t = d.transaction('audit', 'readwrite'); const s = t.objectStore('audit'); s.getAll().onsuccess = ev => { for (const e of (ev.target as any).result) if (e.action === 'update') s.put({ ...e, before: { id: 'x' } }); }; t.oncomplete = () => res(); });
    const h = (await db.recordHistory(r.id)).find(x => x.action === 'update')!; expect(h.damaged).toBe(true); await expect(db.restoreVersion(h.id)).rejects.toThrow(/damaged/);
  });
  it('finds and removes broken links with an audit entry (A7)', async () => {
    const a = newRecord({ name: 'A', links: ['ghost', 'ghost'] }); const b = newRecord({ name: 'B', links: [a.id] }); await db.save(a); await db.save(b);
    expect(brokenLinks(await db.getAll())).toEqual([{ from: a.id, fromName: 'A', to: 'ghost' }]);
    expect(await db.removeBrokenLinks()).toBe(2); expect((await db.get(a.id))!.links).toEqual([]); expect((await db.get(b.id))!.links).toEqual([a.id]);
    expect((await db.recordHistory(a.id)).map(x => x.action)).toEqual(['create', 'unlink']); expect(await db.removeBrokenLinks()).toBe(0);
  });
});
const openRaw = () => new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('brainiac-os'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
