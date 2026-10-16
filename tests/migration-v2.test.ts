import 'fake-indexeddb/auto';
import { it, expect } from 'vitest';

// Builds a database exactly as checkpoint 3/4a left it (schema v2, with the audit index), holding real data and a safety copy, then opens it with the current code (v3).
it('upgrades a v2 (Stage 3) database to v3: existing records, history, safety copy and settings are untouched; the new stores start empty and work', async () => {
  const rec = (id: string, name: string) => ({ id, name, kind: 'note', description: 'd', tags: [], source: '', confidence: 'unknown', status: '', links: [], notes: '', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-02T00:00:00.000Z' });
  const snap = JSON.stringify({ ts: '2026-01-04T00:00:00.000Z', reason: 'before restore', records: [rec('old', 'Old')] });
  await new Promise<void>((res, rej) => {
    const r = indexedDB.open('brainiac-os', 2);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('records', { keyPath: 'id' }).createIndex('kind', 'kind'); d.createObjectStore('audit', { keyPath: 'id' }).createIndex('recordId', 'recordId'); d.createObjectStore('meta', { keyPath: 'key' }); };
    r.onsuccess = () => { const d = r.result, t = d.transaction(['records', 'audit', 'meta'], 'readwrite');
      t.objectStore('records').put(rec('a', 'Alpha')); t.objectStore('records').put(rec('b', 'Beta'));
      t.objectStore('audit').put({ id: 'e1', ts: '2026-01-01T00:00:00.000Z', action: 'create', recordId: 'a', name: 'Alpha', before: null });
      t.objectStore('meta').put({ key: 'lastBackup', value: '2026-01-03T00:00:00.000Z' }); t.objectStore('meta').put({ key: 'snapshot', value: snap }); t.objectStore('meta').put({ key: 'lookupUrl', value: 'https://example.workers.dev' });
      t.oncomplete = () => { d.close(); res(); }; t.onerror = () => rej(t.error); };
    r.onerror = () => rej(r.error);
  });
  const db = await import('../src/db'); const O = await import('../src/ops');
  expect((await db.getAll()).map(r => r.name).sort()).toEqual(['Alpha', 'Beta']); expect(await db.auditAll()).toHaveLength(1); expect(await db.getMeta('lastBackup')).toBe('2026-01-03T00:00:00.000Z'); expect(await db.getMeta('lookupUrl')).toBe('https://example.workers.dev');
  const info = await db.getSnapshotInfo(); expect(info).toMatchObject({ count: 1, reason: 'before restore' }); expect(info!.ops).toBeUndefined(); // an old safety copy has no Stage 5 section and is still readable
  const d = await db.openDB(); expect(d.version).toBe(3); expect(d.transaction('audit').objectStore('audit').indexNames.contains('recordId')).toBe(true);
  expect(await db.getMissions()).toHaveLength(0); expect(await db.getOmega()).toBeNull(); expect(await db.getEvents()).toHaveLength(0);
  const m = await db.saveMission(O.newMission({ title: 'After upgrade' })); expect((await db.getMissions())[0].id).toBe(m.id); expect(await db.getAll()).toHaveLength(2);
  await db.save({ ...(await db.get('b'))!, description: 'edited after upgrade' }); expect((await db.recordHistory('b')).map(x => x.action)).toEqual(['update']);
});
