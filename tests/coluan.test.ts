import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import * as db from '../src/db';
import * as O from '../src/ops';
import { newRecord } from '../src/model';
import { runCommand, isOpsCommand, Api, HELP } from '../src/coluan';

// A fixed "now" (15 Oct 2026, 12:00 local) so overdue logic is deterministic. Storage is the REAL db module, not a fake.
const NOW = new Date(2026, 9, 15, 12, 0);
let answer = true; const asked: string[] = [];
const api = (over: Partial<Api> = {}): Api => ({ ops: () => db.getOps(), records: () => db.getAll(), saveMission: db.saveMission, mutateMission: db.mutateMission, deleteMission: db.deleteMission, saveEvent: db.saveEvent, deleteEvent: db.deleteEvent,
  saveOmega: db.saveOmega, mutateOmega: db.mutateOmega, confirm: m => { asked.push(m); return answer; }, now: () => NOW, ...over });
const run = (s: string, over: Partial<Api> = {}) => runCommand(s, api(over));
beforeEach(async () => { await db.clearAll(); answer = true; asked.length = 0; });

describe('routing', () => {
  it('only ops verbs are claimed; natural-language archive questions fall through untouched', async () => {
    for (const s of ['What do we know about Ultron?', 'Palladium', 'search mission control', 'help me find the base', '']) { expect(isOpsCommand(s)).toBe(false); expect((await run(s)).handled).toBe(false); }
    for (const s of ['mission', 'Mission new x', 'task add', 'event list', 'omega', 'timeline', 'help', 'commands']) expect(isOpsCommand(s)).toBe(true);
    expect((await run('help')).text).toBe(HELP);
  });
  it('unknown subcommands are rejected with guidance, never silently searched or executed', async () => {
    for (const s of ['mission frobnicate x', 'task explode x', 'event vanish x', 'omega teleport']) { const r = await run(s); expect(r.handled).toBe(true); expect(r.ok).toBe(false); expect(r.text).toContain('REJECTED'); }
    expect(await db.getMissions()).toHaveLength(0);
  });
});

describe('missions via commands do real work', () => {
  it('creates with options, persists, and lists with derived progress', async () => {
    const r = await run('mission new Operation Nightfall priority=high due=2026-11-01 tags=space,base'); expect(r.ok).toBe(true); expect(r.changed).toBe(true); expect(r.text).toContain('ACK');
    const m = (await db.getMissions())[0]; expect(m.title).toBe('Operation Nightfall'); expect(m.priority).toBe('high'); expect(m.deadline).toBe('2026-11-01'); expect(m.tags).toEqual(['space', 'base']);
    const l = await run('mission list'); expect(l.text).toContain('Operation Nightfall'); expect(l.text).toContain('no objectives recorded'); expect(l.text).not.toContain('OVERDUE'); expect((await run('mission summary')).text).toContain('1 mission');
  });
  it('rejects invalid input with a reason and writes nothing', async () => {
    for (const s of ['mission new', 'mission new X priority=urgent', 'mission new X due=2026-02-30', 'mission new X due=someday', 'mission new X status=won']) { const r = await run(s); expect(r.ok).toBe(false); expect(r.changed).toBe(false); expect(r.text).toContain('REJECTED'); }
    expect(await db.getMissions()).toHaveLength(0);
  });
  it('set changes status/priority/deadline and can clear the deadline; the stored data confirms it', async () => {
    await run('mission new Alpha'); expect((await run('mission set alpha : status=active priority=critical due=+7d')).ok).toBe(true);
    let m = (await db.getMissions())[0]; expect(m.status).toBe('active'); expect(m.priority).toBe('critical'); expect(m.deadline).toBe('2026-10-22');
    await run('mission set alpha : due=none'); m = (await db.getMissions())[0]; expect(m.deadline).toBe(''); expect((await run('mission set alpha : colour=red')).ok).toBe(false); expect((await run('mission set alpha : status=finished')).ok).toBe(false);
  });
  it('a passed deadline is flagged OVERDUE but the mission is never auto-completed', async () => {
    await run('mission new Late due=2026-10-01 status=active'); const l = await run('mission list'); expect(l.text).toContain('OVERDUE'); expect((await db.getMissions())[0].status).toBe('active');
    await run('mission set late : status=completed'); expect((await run('mission list')).text).not.toContain('OVERDUE');
  });
  it('ambiguous names change nothing and list the candidates', async () => {
    await run('mission new Alpha one'); await run('mission new Alpha two'); for (const s of ['mission show alpha', 'mission set alpha : status=active', 'task add alpha : x', 'mission delete alpha']) { const r = await run(s); expect(r.ok).toBe(false); expect(r.text).toContain('AMBIGUOUS'); expect(r.text).toContain('Alpha one'); }
    const ms = await db.getMissions(); expect(ms).toHaveLength(2); expect(ms.every(m => m.status === 'planned' && m.tasks.length === 0)).toBe(true); expect(asked).toHaveLength(0);
    expect((await run('mission show "alpha two"')).ok).toBe(true); expect((await run('mission show nonexistent')).text).toContain('NOT FOUND');
  });
  it('asks before creating a same-titled mission, and respects a refusal', async () => { await run('mission new Dup'); answer = false; const r = await run('mission new dup'); expect(r.text).toContain('CANCELLED'); expect(await db.getMissions()).toHaveLength(1); expect(asked[0]).toContain('already exists'); });
  it('completing a mission that still has open objectives requires confirmation', async () => {
    await run('mission new Big'); await run('task add big : step one'); answer = false; const r = await run('mission set big : status=completed'); expect(r.text).toContain('CANCELLED'); expect((await db.getMissions())[0].status).toBe('planned'); expect(asked[0]).toContain('1 open objective');
    answer = true; expect((await run('mission set big : status=completed')).ok).toBe(true); expect((await db.getMissions())[0].status).toBe('completed');
  });
  it('archive hides without deleting; unarchive restores', async () => { await run('mission new Old'); await run('mission archive old'); expect((await run('mission list')).text).toContain('No missions'); expect((await run('mission list archived')).text).toContain('Old'); await run('mission unarchive old'); expect((await run('mission list')).text).toContain('Old'); expect(await db.getMissions()).toHaveLength(1); });
  it('delete needs confirmation: refusal changes nothing; acceptance removes the mission but keeps its events', async () => {
    await run('mission new Target'); await run('event add 2026-11-01 : Linked event @ target'); answer = false; expect((await run('mission delete target')).text).toContain('CANCELLED'); expect(await db.getMissions()).toHaveLength(1); expect(asked[0]).toContain('KEPT');
    answer = true; const r = await run('mission delete target'); expect(r.ok).toBe(true); expect(r.text).toContain('1 event kept'); expect(await db.getMissions()).toHaveLength(0); const ev = await db.getEvents(); expect(ev).toHaveLength(1); expect(ev[0].missionId).toBe('');
  });
});

describe('objectives', () => {
  it('add, complete, reopen with progress derived from the stored state', async () => {
    await run('mission new Ops'); await run('task add ops : recon'); await run('task add ops : strike'); expect((await run('task done ops : #1')).text).toContain('1/2 objectives (50%)');
    expect((await run('task done ops : strike')).text).toContain('2/2 objectives (100%)'); expect((await run('task reopen ops : #2')).text).toContain('1/2'); expect((await run('task done ops : #1')).text).toContain('No change');
    expect((await run('task done ops : #9')).text).toContain('NOT FOUND'); expect((await run('task done ops : zzz')).text).toContain('NOT FOUND'); expect((await run('task add ops')).ok).toBe(false);
    const m = (await db.getMissions())[0]; expect(m.tasks.map(t => t.done)).toEqual([true, false]);
  });
  it('dependencies block, can be completed with a note, and loops are refused', async () => {
    await run('mission new Chain'); for (const t of ['a', 'b', 'c']) await run(`task add chain : step ${t}`); expect((await run('task depend chain : #2 on #1')).ok).toBe(true); expect((await run('task depend chain : #3 on #2')).ok).toBe(true);
    const bad = await run('task depend chain : #1 on #3'); expect(bad.ok).toBe(false); expect(bad.text).toContain('circular'); expect((await run('task depend chain : #1 on #1')).ok).toBe(false);
    expect((await run('mission show chain')).text).toContain('[!] #2'); const d = await run('task done chain : #2'); expect(d.ok).toBe(true); expect(d.text).toContain('still waiting on');
  });
  it('deleting an objective needs confirmation and removes dependencies on it', async () => {
    await run('mission new M'); await run('task add m : one'); await run('task add m : two'); await run('task depend m : #2 on #1'); answer = false; expect((await run('task delete m : #1')).text).toContain('CANCELLED'); expect((await db.getMissions())[0].tasks).toHaveLength(2);
    answer = true; expect((await run('task delete m : #1')).ok).toBe(true); const t = (await db.getMissions())[0].tasks; expect(t).toHaveLength(1); expect(t[0].dependsOn).toEqual([]);
  });
  it('quoted names allow colons in titles', async () => { await run('mission new Phase 1: recon'); expect((await run('task add "Phase 1: recon" : check the map')).ok).toBe(true); expect((await db.getMissions())[0].tasks[0].text).toBe('check the map'); });
});

describe('timeline events via commands', () => {
  it('adds with date, time, link and options; invalid dates and times are rejected', async () => {
    await run('mission new Op'); const r = await run('event add 2026-10-20 14:30 : Briefing @ op category=operation priority=high'); expect(r.ok).toBe(true); const e = (await db.getEvents())[0];
    expect(e.date).toBe('2026-10-20'); expect(e.time).toBe('14:30'); expect(e.category).toBe('operation'); expect(e.priority).toBe('high'); expect(e.missionId).toBe((await db.getMissions())[0].id); expect(e.status).toBe('planned');
    for (const s of ['event add 2026-02-30 : x', 'event add soon : x', 'event add 2026-10-20 25:00 : x', 'event add 2026-10-20', 'event add 2026-10-20 : x category=party', 'event add 2026-10-20 : x @ nomission', 'event add yesterday : x category=history']) { const x = await run(s); expect(x.ok).toBe(false); expect(x.changed).toBe(false); }
    expect(await db.getEvents()).toHaveLength(1);
  });
  it('words work for dates, a single-digit hour is normalised, and a colon after the date is accepted', async () => { await run('event add tomorrow 9:05 : Early'); await run('event add today: Now'); const e = await db.getEvents(); expect(e.find(x => x.title === 'Early')).toMatchObject({ date: '2026-10-16', time: '09:05' }); expect(e.find(x => x.title === 'Now')!.date).toBe('2026-10-15'); });
  it('overdue only for planned events in the past; done events and history are not overdue', async () => {
    await run('event add 2026-10-10 : Missed one'); await run('event add 2026-10-10 : Finished one status=done'); await run('event add 2026-10-01 : Met the council category=history status=done'); await run('event add 2026-10-30 : Future');
    const o = await run('event list overdue'); expect(o.text).toContain('Missed one'); expect(o.text).not.toContain('Finished one'); expect(o.text).not.toContain('Future'); expect((await run('event list done')).text).toContain('Met the council');
    expect((await run('event list')).text).toContain('Future'); expect((await run('event done missed')).ok).toBe(true); expect((await run('event list overdue')).text).toContain('Nothing overdue'); expect((await run('event reopen missed')).ok).toBe(true); expect((await run('event list overdue')).text).toContain('Missed one');
  });
  it('mission deadlines appear on the timeline as derived entries, and completing the mission clears the overdue flag', async () => {
    await run('mission new Op due=2026-10-01 status=active'); const l = await run('event list all'); expect(l.text).toContain('Deadline: Op'); expect(l.text).toContain('derived from mission deadline'); expect(l.text).toContain('OVERDUE'); expect(await db.getEvents()).toHaveLength(0);
    await run('mission set op : status=completed'); const l2 = await run('event list all'); expect(l2.text).toContain('[DONE]'); expect(l2.text).not.toContain('OVERDUE');
  });
  it('deleting an event is confirmed and does not delete the mission; derived entries cannot be deleted as events', async () => {
    await run('mission new Keep due=2026-12-01'); await run('event add 2026-11-01 : Briefing @ keep'); answer = false; expect((await run('event delete briefing')).text).toContain('CANCELLED'); expect(await db.getEvents()).toHaveLength(1);
    answer = true; expect((await run('event delete briefing')).ok).toBe(true); expect(await db.getEvents()).toHaveLength(0); expect(await db.getMissions()).toHaveLength(1);
    const d = await run('event delete deadline'); expect(d.ok).toBe(false); expect(d.text).toContain('Only stored events');
  });
  it('a history event cannot be set back to planned', async () => { await run('event add 2026-09-01 : Happened category=history status=done'); const r = await run('event reopen happened'); expect(r.ok).toBe(false); expect(r.text).toContain('already happened'); });
});

describe('Project OMEGA via commands', () => {
  it('nothing is created silently: commands say there is no project until it is initialised', async () => { for (const s of ['omega', 'omega milestone add : x', 'omega decide : x', 'omega link x']) { const r = await run(s); expect(r.ok).toBe(false); expect(r.text).toContain('No Project OMEGA'); } expect(await db.getOmega()).toBeNull(); });
  it('init, milestones (with dates and links), link, decide, hypothesis, set', async () => {
    expect((await run('omega init Project Omega Prime')).ok).toBe(true); expect((await db.getOmega())!.name).toBe('Project Omega Prime'); expect((await run('omega init')).text).toContain('No change');
    await run('mission new Recon'); await run('task add recon : scout'); expect((await run('omega milestone add 2026-11-15 : Phase one @ recon')).ok).toBe(true); expect((await run('omega milestone add : Undated one')).ok).toBe(true); expect((await run('omega milestone add 2026-02-30 : Bad')).ok).toBe(false);
    let o = (await db.getOmega())!; expect(o.milestones).toHaveLength(2); expect(o.milestones[0]).toMatchObject({ title: 'Phase one', target: '2026-11-15' }); expect(o.milestones[0].missionId).toBe((await db.getMissions())[0].id); expect(o.milestones[1].target).toBe('');
    expect((await run('omega link recon')).ok).toBe(true); expect((await run('omega link recon')).text).toContain('No change'); expect((await run('omega decide : Use the space base | closest to targets')).ok).toBe(true); expect((await run('omega hypothesis : They will not expect it | guess')).text).toContain('assumption, not a finding'); expect((await run('omega set status=active priority=critical')).ok).toBe(true);
    o = (await db.getOmega())!; expect(o.decisions[0]).toMatchObject({ decision: 'Use the space base', rationale: 'closest to targets', date: '2026-10-15' }); expect(o.hypotheses[0]).toMatchObject({ origin: 'user', confidence: 'unknown' }); expect(o.status).toBe('active'); expect(o.missionIds).toHaveLength(1);
    expect((await run('omega set status=nope')).ok).toBe(false); expect((await run('event list all')).text).toContain('OMEGA milestone: Phase one');
  });
  it('summary computes from real data and reports conflicts instead of hiding them', async () => {
    await run('omega init'); await run('mission new Recon status=active'); await run('task add recon : scout'); await run('task add recon : map'); await run('omega milestone add 2026-11-15 : Phase one @ recon');
    let s = (await run('omega show')).text; expect(s).toContain('0/1 marked done (0%)'); expect(s).toContain('objectives 0/2 (0%)'); expect(s).toContain('No conflicts'); expect(s).toContain('not forecasts');
    const w = await run('omega milestone done phase'); expect(w.text).toContain('Warning'); s = (await run('omega show')).text; expect(s).toContain('CONFLICTS (1)'); expect(s).toContain('1/1 marked done (100%)'); expect(s).toContain('objectives 0/2');
    await run('mission set recon : status=completed'); expect((await run('omega show')).text).toContain('No conflicts');
  });
  it('deleting a linked mission keeps OMEGA and shows nothing dangling', async () => { await run('omega init'); await run('mission new Gone'); await run('omega link gone'); await run('omega milestone add : m @ gone'); await run('mission delete gone'); const o = (await db.getOmega())!; expect(o.missionIds).toEqual([]); expect(o.milestones[0].missionId).toBe(''); expect((await run('omega show')).text).not.toContain('no longer exist'); });
});

describe('ACK is only claimed after the result is confirmed', () => {
  it('a failing write is reported as not saved', async () => { const r = await run('mission new X', { saveMission: async () => { throw new Error('Disk is full'); } }); expect(r.ok).toBe(false); expect(r.text).toContain('Disk is full'); expect(r.text).toContain('Nothing was confirmed saved'); expect(r.text).not.toContain('ACK'); });
  it('a write that cannot be read back is reported as unconfirmed, not as success', async () => {
    const lying = { ops: async () => ({ missions: [], omega: null, events: [] }) }; for (const s of ['mission new Ghost', 'event add 2026-11-01 : Ghost event']) { const r = await run(s, lying); expect(r.ok).toBe(false); expect(r.text).toContain('FAILED'); expect(r.text).toContain('NOT confirmed'); expect(r.text).not.toContain('ACK'); }
  });
  it('the read-back checks the real stored value, not just the reply (storage rejects invalid data)', async () => { const long = 'x'.repeat(201); const r = await run('mission new ' + long); expect(r.ok).toBe(false); expect(r.text).toContain('too long'); expect(await db.getMissions()).toHaveLength(0); });
});

describe('archive references show in mission details', () => {
  it('lists linked archive records by name and flags a missing one', async () => {
    const rec = newRecord({ name: 'Ultron', kind: 'character' }); await db.save(rec); const m = await db.saveMission(O.newMission({ title: 'Uses intel', archiveRefs: [rec.id, 'ghost'] }));
    const t = (await run('mission show uses')).text; expect(t).toContain('Ultron'); expect(t).toContain('missing record'); expect(m.archiveRefs).toHaveLength(2);
  });
});
