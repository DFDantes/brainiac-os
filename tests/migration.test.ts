import 'fake-indexeddb/auto';
import { it, expect } from 'vitest';

// Builds a database exactly as checkpoints 0-2 (schema v1, no audit index) with real data, then opens it with the current code.
it('upgrades a v1 database to the current version (v3) without losing records or history, and adds the audit index and the Stage 5 stores', async () => {
  const rec = (id: string, name: string, links: string[] = []) => ({ id, name, kind: 'note', description: 'd', tags: ['t'], source: '', confidence: 'unknown', status: '', links, notes: '', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-02T00:00:00.000Z' });
  await new Promise<void>((res, rej) => {
    const r = indexedDB.open('brainiac-os', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('records', { keyPath: 'id' }).createIndex('kind', 'kind'); d.createObjectStore('audit', { keyPath: 'id' }); d.createObjectStore('meta', { keyPath: 'key' }); };
    r.onsuccess = () => { const d = r.result, t = d.transaction(['records', 'audit', 'meta'], 'readwrite');
      t.objectStore('records').put(rec('a', 'Alpha', ['b'])); t.objectStore('records').put(rec('b', 'Beta'));
      t.objectStore('audit').put({ id: 'e1', ts: '2026-01-01T00:00:00.000Z', action: 'create', recordId: 'a', name: 'Alpha', before: null });
      t.objectStore('audit').put({ id: 'e2', ts: '2026-01-02T00:00:00.000Z', action: 'update', recordId: 'a', name: 'Alpha', before: rec('a', 'Alpha old') });
      t.objectStore('meta').put({ key: 'lastBackup', value: '2026-01-03T00:00:00.000Z' });
      t.oncomplete = () => { d.close(); res(); }; t.onerror = () => rej(t.error); };
    r.onerror = () => rej(r.error);
  });
  const db = await import('../src/db');
  expect((await db.getAll()).map(r => r.name).sort()).toEqual(['Alpha', 'Beta']);
  expect(await db.getMeta('lastBackup')).toBe('2026-01-03T00:00:00.000Z');
  expect(await db.auditAll()).toHaveLength(2);
  const h = await db.recordHistory('a'); expect(h.map(x => x.action)).toEqual(['create', 'update']); expect(h[1].before?.name).toBe('Alpha old');
  const d = await db.openDB(); expect(d.version).toBe(3); expect([...d.objectStoreNames].sort()).toEqual(['audit', 'events', 'meta', 'missions', 'omega', 'records']); expect(d.transaction('audit').objectStore('audit').indexNames.contains('recordId')).toBe(true);
  await db.save({ ...(await db.get('b'))!, description: 'edited after upgrade' }); expect((await db.recordHistory('b')).map(x => x.action)).toEqual(['update']);
});
