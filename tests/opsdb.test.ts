import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import * as db from '../src/db';
import * as O from '../src/ops';
import { newRecord, serializeBackup } from '../src/model';

beforeEach(async () => { await db.clearAll(); });
const T = '2026-10-15';

describe('missions persist and validate', () => {
  it('creates, reloads, edits and keeps data in its own store', async () => {
    const m = await db.saveMission(O.newMission({ title: 'Alpha', tasks: [O.newTask('first')], deadline: '2026-11-01' }));
    const again = (await db.getMissions()).find(x => x.id === m.id)!; expect(again.title).toBe('Alpha'); expect(again.tasks[0].text).toBe('first'); expect(again.deadline).toBe('2026-11-01');
    await db.saveMission({ ...again, status: 'active' }); expect((await db.getMissions())[0].status).toBe('active'); expect(await db.getAll()).toHaveLength(0); // archive records untouched
  });
  it('refuses to store an invalid mission and stores nothing', async () => {
    await expect(db.saveMission({ ...O.newMission({ title: 'x' }), deadline: '2026-02-30' })).rejects.toThrow(/real date/); await expect(db.saveMission(O.newMission({ title: ' ' }))).rejects.toThrow(/required/);
    expect(await db.getMissions()).toHaveLength(0);
  });
  it('mutations are atomic: 12 simultaneous task additions are ALL kept (no lost update)', async () => {
    const m = await db.saveMission(O.newMission({ title: 'Race' }));
    await Promise.all(Array.from({ length: 12 }, (_, i) => db.mutateMission(m.id, x => ({ ...x, tasks: [...x.tasks, O.newTask('t' + i)] }))));
    expect((await db.getMissions())[0].tasks).toHaveLength(12);
  });
  it('a mutation that produces invalid data writes nothing', async () => {
    const m = await db.saveMission(O.newMission({ title: 'Keep', tasks: [O.newTask('a')] }));
    await expect(db.mutateMission(m.id, x => ({ ...x, status: 'nonsense' as any }))).rejects.toThrow(/Status/); await expect(db.mutateMission('missing', x => x)).rejects.toThrow(/no longer exists/);
    const back = (await db.getMissions())[0]; expect(back.status).toBe('planned'); expect(back.tasks).toHaveLength(1);
  });
  it('a damaged stored item is counted and skipped but NOT deleted', async () => {
    await db.saveMission(O.newMission({ title: 'Good' })); const d = await db.openDB();
    await new Promise<void>((res, rej) => { const t = d.transaction('missions', 'readwrite'); t.objectStore('missions').put({ id: 'bad', title: 123, status: 'who knows' }); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
    const o = await db.getOps(); expect(o.missions.map(m => m.title)).toEqual(['Good']); expect(o.damaged).toBe(1);
    const raw = await new Promise<any>((res, rej) => { const r = d.transaction('missions').objectStore('missions').get('bad'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); expect(raw.title).toBe(123);
  });
});

describe('deleting and recovering without collateral damage', () => {
  it('deleting a mission keeps its timeline events (unlinked), clears the OMEGA link, and is recoverable from the trash', async () => {
    const m = await db.saveMission(O.newMission({ title: 'Doomed', tasks: [O.newTask('x')] })), other = await db.saveMission(O.newMission({ title: 'Safe' }));
    await db.saveEvent(O.newEvent({ title: 'Linked', date: T, missionId: m.id })); await db.saveEvent(O.newEvent({ title: 'Other', date: T, missionId: other.id }));
    await db.saveOmega(O.newOmega({ missionIds: [m.id, other.id], milestones: [{ id: 'ms', title: 'M', target: '', done: false, missionId: m.id, notes: '' }] }));
    const r = await db.deleteMission(m.id); expect(r).toEqual({ events: 1, omega: true });
    const o = await db.getOps(); expect(o.missions.map(x => x.title)).toEqual(['Safe']); expect(o.events).toHaveLength(2); expect(o.events.find(e => e.title === 'Linked')!.missionId).toBe(''); expect(o.events.find(e => e.title === 'Other')!.missionId).toBe(other.id);
    expect(o.omega!.missionIds).toEqual([other.id]); expect(o.omega!.milestones[0].missionId).toBe('');
    const trash = await db.getTrash(); expect(trash).toHaveLength(1); expect(trash[0].type).toBe('mission'); expect(trash[0].title).toBe('Doomed');
    await db.restoreTrash(trash[0].id); expect((await db.getMissions()).map(x => x.title).sort()).toEqual(['Doomed', 'Safe']); expect((await db.getMissions()).find(x => x.title === 'Doomed')!.tasks).toHaveLength(1); expect(await db.getTrash()).toHaveLength(0);
  });
  it('deleting an event never touches missions or OMEGA, and can be restored', async () => {
    const m = await db.saveMission(O.newMission({ title: 'Stays' })), e = await db.saveEvent(O.newEvent({ title: 'Gone', date: T, missionId: m.id })); await db.saveOmega(O.newOmega({ missionIds: [m.id] }));
    await db.deleteEvent(e.id); const o = await db.getOps(); expect(o.events).toHaveLength(0); expect(o.missions).toHaveLength(1); expect(o.omega!.missionIds).toEqual([m.id]);
    await db.restoreTrash((await db.getTrash())[0].id); expect((await db.getEvents())[0].missionId).toBe(m.id);
  });
  it('deleting OMEGA keeps missions and events; restoring is refused while another OMEGA exists', async () => {
    const m = await db.saveMission(O.newMission({ title: 'Mission' })); await db.saveOmega(O.newOmega({ missionIds: [m.id], milestones: [{ id: 'ms', title: 'M', target: '', done: false, missionId: '', notes: '' }] }));
    await db.saveEvent(O.newEvent({ title: 'Ev', date: T, milestoneId: 'ms' })); await db.deleteOmega(); const o = await db.getOps(); expect(o.omega).toBeNull(); expect(o.missions).toHaveLength(1); expect(o.events[0].milestoneId).toBe('');
    await db.saveOmega(O.newOmega({ name: 'New one' })); await expect(db.restoreTrash((await db.getTrash())[0].id)).rejects.toThrow(/already exists/);
  });
  it('trash keeps only the newest 25 and a damaged entry cannot be restored', async () => {
    for (let i = 0; i < 27; i++) { const e = await db.saveEvent(O.newEvent({ title: 'e' + i, date: T })); await db.deleteEvent(e.id); } const t = await db.getTrash(); expect(t).toHaveLength(25); expect(t[0].title).toBe('e26');
    await db.setMeta('opsTrash', JSON.stringify([{ id: 'x', ts: 'now', type: 'mission', title: 't', item: { id: 'x', title: 5 } }])); await expect(db.restoreTrash('x')).rejects.toThrow(/damaged/);
    await db.setMeta('opsTrash', 'not json'); expect(await db.getTrash()).toEqual([]);
  });
});

describe('backup, restore and safety copy include missions, OMEGA and events', () => {
  const seed = async () => { const m = await db.saveMission(O.newMission({ title: 'Alpha', tasks: [O.newTask('a')] })); await db.saveOmega(O.newOmega({ missionIds: [m.id] })); await db.saveEvent(O.newEvent({ title: 'Ev', date: T, missionId: m.id })); await db.save(newRecord({ name: 'Rec', kind: 'note' })); return m; };
  it('exportBackup carries ops, serializes, and restores into an empty device', async () => {
    await seed(); const text = serializeBackup(await db.exportBackup()); await db.clearAll(); expect(await db.getMissions()).toHaveLength(0);
    const p = O.parseFullBackup(text); await db.importRecords(p.records); const r = await db.importOps(p.ops);
    expect(r).toEqual({ added: 3, replaced: 0, kept: 0 }); const o = await db.getOps(); expect(o.missions[0].title).toBe('Alpha'); expect(o.omega!.missionIds).toEqual([o.missions[0].id]); expect(o.events[0].missionId).toBe(o.missions[0].id); expect(await db.getAll()).toHaveLength(1);
  });
  it('an old backup (no ops section) restores records and leaves current missions alone', async () => {
    await seed(); const b: any = await db.exportBackup(); delete b.ops; const p = O.parseFullBackup(JSON.stringify(b)); expect(p.ops.missions).toHaveLength(0);
    const r = await db.importOps(p.ops); expect(r).toEqual({ added: 0, replaced: 0, kept: 0 }); expect(await db.getMissions()).toHaveLength(1);
  });
  it('restore never overwrites a newer local copy, replaces an older one, and plans it first', async () => {
    const m = await db.saveMission(O.newMission({ title: 'v1' })), old = (await db.exportBackup()).ops as O.OpsBundle; await new Promise(r => setTimeout(r, 5));
    await db.mutateMission(m.id, x => ({ ...x, title: 'v2 newer' })); expect(await db.planImportOps(old)).toEqual({ added: 0, replace: 0, keep: 1 }); expect(await db.importOps(old)).toEqual({ added: 0, replaced: 0, kept: 1 }); expect((await db.getMissions())[0].title).toBe('v2 newer');
    const newer = { ...old, missions: [{ ...old.missions[0], title: 'v3 from backup', modified: new Date(Date.now() + 60000).toISOString() }] }; expect(await db.planImportOps(newer)).toEqual({ added: 0, replace: 1, keep: 0 }); await db.importOps(newer); expect((await db.getMissions())[0].title).toBe('v3 from backup');
  });
  it('Erase all clears missions too, but the safety copy brings everything back with Undo', async () => {
    await seed(); await db.eraseAll(); const o = await db.getOps(); expect(o.missions).toHaveLength(0); expect(o.omega).toBeNull(); expect(o.events).toHaveLength(0); expect(await db.getAll()).toHaveLength(0);
    const info = await db.getSnapshotInfo(); expect(info!.count).toBe(1); expect(info!.ops).toBe(3); await db.undoLast(); const b = await db.getOps(); expect(b.missions[0].title).toBe('Alpha'); expect(b.omega).not.toBeNull(); expect(b.events).toHaveLength(1); expect(await db.getAll()).toHaveLength(1);
  });
  it('a safety copy made before Stage 5 (no ops section) restores records and leaves current missions untouched', async () => {
    const rec = newRecord({ name: 'Old rec', kind: 'note' }); await db.save(rec); await db.saveMission(O.newMission({ title: 'Current' }));
    await db.setMeta('snapshot', JSON.stringify({ ts: new Date().toISOString(), reason: 'old build', records: [rec] })); await db.remove(rec.id); expect(await db.getAll()).toHaveLength(0);
    await db.undoLast(); expect((await db.getAll()).map(r => r.name)).toEqual(['Old rec']); expect((await db.getMissions()).map(x => x.title)).toEqual(['Current']);
  });
  it('a snapshot is taken when only missions exist (not just records)', async () => { await db.saveMission(O.newMission({ title: 'Only mission' })); expect(await db.snapshot('t')).toBe(true); expect((await db.getSnapshotInfo())!.ops).toBe(1); });
});

describe('integrity: references to things that disappeared', () => {
  it('deleting an archive record leaves a visible, repairable reference; repair removes only the reference', async () => {
    const r = newRecord({ name: 'Intel', kind: 'note' }); await db.save(r); const m = await db.saveMission(O.newMission({ title: 'Uses intel', archiveRefs: [r.id] })); await db.saveOmega(O.newOmega({ archiveRefs: [r.id] }));
    expect(await db.findOpsIssues()).toHaveLength(0); await db.remove(r.id); const issues = await db.findOpsIssues(); expect(issues).toHaveLength(2); expect(issues.every(i => i.kind === 'archive record')).toBe(true);
    expect(await db.removeBrokenOpsRefs()).toBe(2); expect(await db.findOpsIssues()).toHaveLength(0); const o = await db.getOps(); expect(o.missions[0].id).toBe(m.id); expect(o.missions[0].archiveRefs).toEqual([]); expect(o.omega).not.toBeNull(); expect(await db.removeBrokenOpsRefs()).toBe(0);
  });
});
