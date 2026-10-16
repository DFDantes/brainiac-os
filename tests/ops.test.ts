import { describe, it, expect } from 'vitest';
import * as O from '../src/ops';

const T = '2026-10-15', NT = '12:00';
const mk = (title: string, p: Partial<O.Mission> = {}) => O.newMission({ title, ...p });
const tasks = (...texts: string[]) => texts.map((t, i) => O.newTask(t, { id: 't' + (i + 1) }));

describe('dates (local calendar, never UTC)', () => {
  it('accepts only real calendar dates', () => {
    expect(O.isDate('2024-02-29')).toBe(true); expect(O.isDate('2026-02-29')).toBe(false); expect(O.isDate('2026-02-30')).toBe(false);
    expect(O.isDate('2026-13-01')).toBe(false); expect(O.isDate('2026-1-1')).toBe(false); expect(O.isDate(20261015)).toBe(false);
    expect(O.isTime('00:00')).toBe(true); expect(O.isTime('23:59')).toBe(true); expect(O.isTime('24:00')).toBe(false); expect(O.isTime('9:30')).toBe(false);
  });
  it('localDate/localTime use the device calendar, so late-night and early-morning dates are not shifted', () => {
    expect(O.localDate(new Date(2026, 2, 1, 0, 5))).toBe('2026-03-01'); expect(O.localDate(new Date(2026, 2, 1, 23, 59))).toBe('2026-03-01');
    expect(O.localDate(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01'); expect(O.localDate(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
    expect(O.localTime(new Date(2026, 2, 1, 7, 5))).toBe('07:05');
  });
  it('addDays and daysBetween cross months, years, leap days and daylight-saving changes correctly', () => {
    expect(O.addDays('2026-01-31', 1)).toBe('2026-02-01'); expect(O.addDays('2026-12-31', 1)).toBe('2027-01-01'); expect(O.addDays('2024-02-28', 1)).toBe('2024-02-29'); expect(O.addDays('2026-03-01', -1)).toBe('2026-02-28');
    for (const d of ['2026-03-07', '2026-03-08', '2026-03-28', '2026-03-29', '2026-10-03', '2026-10-04', '2026-10-24', '2026-10-25', '2026-04-04', '2026-04-05']) { expect(O.addDays(d, 1) > d).toBe(true); expect(O.daysBetween(d, O.addDays(d, 1))).toBe(1); expect(O.addDays(O.addDays(d, 1), -1)).toBe(d); }
    expect(O.daysBetween('2026-03-01', '2026-04-01')).toBe(31); expect(O.daysBetween('2026-10-15', '2026-10-14')).toBe(-1);
  });
  it('parseDateWord understands words and rejects nonsense', () => {
    expect(O.parseDateWord('today', T)).toBe(T); expect(O.parseDateWord('Tomorrow', T)).toBe('2026-10-16'); expect(O.parseDateWord('yesterday', T)).toBe('2026-10-14');
    expect(O.parseDateWord('+3d', T)).toBe('2026-10-18'); expect(O.parseDateWord('-15d', T)).toBe('2026-09-30'); expect(O.parseDateWord('2026-11-01', T)).toBe('2026-11-01');
    expect(O.parseDateWord('2026-02-30', T)).toBe(''); expect(O.parseDateWord('soon', T)).toBe(''); expect(O.parseDateWord('', T)).toBe('');
  });
});

describe('validation of untrusted data', () => {
  it('accepts a valid mission and rejects bad fields with clear messages', () => {
    expect(O.validateMission(mk('Alpha')).title).toBe('Alpha');
    expect(() => O.validateMission(mk('  '))).toThrow(/required/); expect(() => O.validateMission({ ...mk('x'), status: 'done' })).toThrow(/Status/);
    expect(() => O.validateMission({ ...mk('x'), deadline: '2026-02-30' })).toThrow(/real date/); expect(() => O.validateMission({ ...mk('x'), title: 'a'.repeat(201) })).toThrow(/too long/);
    expect(() => O.validateMission({ ...mk('x'), id: 'bad id!' })).toThrow(/Bad id/); expect(() => O.validateMission(null)).toThrow(); expect(() => O.validateMission([])).toThrow();
  });
  it('rejects duplicate objective ids but quietly drops unknown or self dependencies', () => {
    expect(() => O.validateMission(mk('x', { tasks: [O.newTask('a', { id: 'same' }), O.newTask('b', { id: 'same' })] }))).toThrow(/Duplicate/);
    const m = O.validateMission(mk('x', { tasks: [O.newTask('a', { id: 'a', dependsOn: ['a', 'ghost', 'b'] }), O.newTask('b', { id: 'b' })] }));
    expect(m.tasks[0].dependsOn).toEqual(['b']);
  });
  it('strips unknown fields (including prototype pollution attempts) because it builds a fresh object', () => {
    const m: any = O.validateMission({ ...mk('x'), evil: 1, __proto__: { hax: 1 } }); expect(m.evil).toBeUndefined(); expect(({} as any).hax).toBeUndefined();
  });
  it('event rules: real date, optional valid time, history cannot be planned', () => {
    expect(O.validateEvent(O.newEvent({ title: 'e', date: '2026-11-01' })).time).toBe('');
    expect(() => O.validateEvent(O.newEvent({ title: 'e', date: '2026-02-30' }))).toThrow(/real date/); expect(() => O.validateEvent(O.newEvent({ title: 'e', date: '2026-11-01', time: '25:00' }))).toThrow(/Time/);
    expect(() => O.validateEvent(O.newEvent({ title: 'e', date: '2026-11-01', category: 'history', status: 'planned' }))).toThrow(/already happened/);
    expect(O.validateEvent(O.newEvent({ title: 'e', date: '2020-01-01', category: 'history', status: 'done' })).status).toBe('done');
    expect(() => O.validateEvent(O.newEvent({ title: '', date: '2026-11-01' }))).toThrow(/required/);
  });
  it('OMEGA validates milestones, origin and confidence', () => {
    expect(O.validateOmega(O.newOmega()).id).toBe('omega'); expect(() => O.validateOmega({ ...O.newOmega(), id: 'other' })).toThrow();
    expect(() => O.validateOmega({ ...O.newOmega(), hypotheses: [{ id: 'h', text: 't', basis: '', confidence: 'certain', origin: 'user', created: new Date().toISOString() }] })).toThrow(/Confidence/);
    expect(() => O.validateOmega({ ...O.newOmega(), hypotheses: [{ id: 'h', text: 't', basis: '', confidence: 'low', origin: 'oracle', created: new Date().toISOString() }] })).toThrow(/Origin/);
    expect(() => O.validateOmega({ ...O.newOmega(), milestones: [{ id: 'm', title: 'x', target: '2026-02-30', done: false, missionId: '', notes: '' }] })).toThrow(/real date/);
  });
});

describe('objectives, progress and blocking', () => {
  it('progress comes only from real objective state; no objectives means no figure', () => {
    expect(O.missionProgress(mk('a')).pct).toBeNull();
    const m = mk('a', { tasks: tasks('1', '2', '3', '4') }); expect(O.missionProgress(m)).toEqual({ done: 0, total: 4, pct: 0 });
    m.tasks[0].done = true; m.tasks[1].done = true; expect(O.missionProgress(m)).toEqual({ done: 2, total: 4, pct: 50 });
    m.tasks.forEach(t => (t.done = true)); expect(O.missionProgress(m).pct).toBe(100);
  });
  it('shows blocked objectives and unblocks them when the prerequisite is done', () => {
    const m = mk('a', { tasks: tasks('recon', 'strike') }); m.tasks[1].dependsOn = ['t1']; expect([...O.blockedTasks(m).entries()]).toEqual([['t2', ['recon']]]);
    m.tasks[0].done = true; expect(O.blockedTasks(m).size).toBe(0); m.tasks[0].done = false; m.tasks[1].done = true; expect(O.blockedTasks(m).size).toBe(0); // a finished task is never "blocked"
  });
  it('detects dependency loops, direct and indirect', () => {
    const t = tasks('a', 'b', 'c'); t[1].dependsOn = ['t1']; t[2].dependsOn = ['t2'];
    expect(O.wouldCycle(t, 't1', 't1')).toBe(true); expect(O.wouldCycle(t, 't1', 't3')).toBe(true); expect(O.wouldCycle(t, 't3', 't1')).toBe(false);
  });
});

describe('overdue depends on real dates and real state, never changes status', () => {
  it('missionOverdue', () => {
    expect(O.missionOverdue(mk('a', { deadline: '2026-10-14', status: 'active' }), T)).toBe(true); expect(O.missionOverdue(mk('a', { deadline: T, status: 'active' }), T)).toBe(false);
    expect(O.missionOverdue(mk('a', { deadline: '2026-10-01', status: 'completed' }), T)).toBe(false); expect(O.missionOverdue(mk('a', { deadline: '2026-10-01', status: 'cancelled' }), T)).toBe(false);
    expect(O.missionOverdue(mk('a', { deadline: '2026-10-01', status: 'planned', archived: true }), T)).toBe(false); expect(O.missionOverdue(mk('a', { status: 'active' }), T)).toBe(false);
    const m = mk('a', { deadline: '2020-01-01', status: 'active' }); O.missionOverdue(m, T); expect(m.status).toBe('active');
  });
  it('eventState: planned past events are overdue; done and cancelled never are; time matters only today', () => {
    expect(O.eventState({ date: '2026-10-14', time: '', status: 'planned' }, T, NT)).toBe('overdue'); expect(O.eventState({ date: '2026-10-14', time: '', status: 'done' }, T, NT)).toBe('done');
    expect(O.eventState({ date: '2026-10-14', time: '', status: 'cancelled' }, T, NT)).toBe('cancelled'); expect(O.eventState({ date: T, time: '', status: 'planned' }, T, NT)).toBe('today');
    expect(O.eventState({ date: T, time: '09:00', status: 'planned' }, T, NT)).toBe('overdue'); expect(O.eventState({ date: T, time: '15:00', status: 'planned' }, T, NT)).toBe('today');
    expect(O.eventState({ date: '2026-10-16', time: '00:01', status: 'planned' }, T, NT)).toBe('upcoming');
  });
});

describe('dashboard counts, search, sorting', () => {
  const ms = [mk('Alpha', { status: 'active', priority: 'high', deadline: '2026-10-01', tasks: tasks('x', 'y') }), mk('Bravo', { status: 'planned', priority: 'low' }), mk('Charlie', { status: 'completed', deadline: '2026-09-01' }), mk('Delta', { archived: true, tags: ['old'] })];
  it('counts are derived from stored missions', () => {
    const c = O.missionCounts(ms, T); expect(c.total).toBe(3); expect(c.archived).toBe(1); expect(c.overdue).toBe(1); expect(c.byStatus.active).toBe(1); expect(c.byStatus.completed).toBe(1); expect(c.openTasks).toBe(2);
  });
  it('search and filter respect archive and status', () => {
    expect(O.searchMissions(ms, '').map(m => m.title)).toEqual(['Alpha', 'Bravo', 'Charlie']); expect(O.searchMissions(ms, '', 'active').map(m => m.title)).toEqual(['Alpha']);
    expect(O.searchMissions(ms, 'old', '', true).map(m => m.title)).toEqual(['Delta']); expect(O.searchMissions(ms, 'y').map(m => m.title)).toContain('Alpha'); expect(O.searchMissions(ms, 'nothing-here')).toHaveLength(0);
  });
  it('sorting by deadline puts undated last, by priority puts critical first', () => {
    expect(O.sortMissions(O.searchMissions(ms, ''), 'deadline').map(m => m.title)).toEqual(['Charlie', 'Alpha', 'Bravo']); expect(O.sortMissions(O.searchMissions(ms, ''), 'priority')[0].title).toBe('Alpha');
  });
});

describe('timeline composition', () => {
  it('adds derived deadline/milestone entries without storing or duplicating them, and orders chronologically', () => {
    const m = mk('Op', { id: 'm1', deadline: '2026-10-20', status: 'active' }), done = mk('Finished', { id: 'm2', deadline: '2026-10-01', status: 'completed' }), arch = mk('Hidden', { id: 'm3', deadline: '2026-10-05', archived: true }), canc = mk('Dropped', { id: 'm4', deadline: '2026-10-06', status: 'cancelled' });
    const om = O.newOmega({ milestones: [{ id: 'ms1', title: 'Phase 1', target: '2026-10-10', done: false, missionId: '', notes: '' }, { id: 'ms2', title: 'No date', target: '', done: false, missionId: '', notes: '' }] });
    const ev = O.newEvent({ id: 'e1', title: 'Briefing', date: '2026-10-12', time: '09:00' }), ev2 = O.newEvent({ id: 'e2', title: 'Earlier', date: '2026-10-12' });
    const a = O.timelineItems([ev, ev2], [m, done, arch, canc], om, T, NT), b = O.timelineItems([ev, ev2], [{ ...m, title: 'Op renamed' }, done, arch, canc], om, T, NT);
    expect(a).toHaveLength(5); expect(b).toHaveLength(5); expect(a.find(i => i.key === 'm:m2')!.state).toBe('done'); expect(a.find(i => i.key === 'o:ms1')!.state).toBe('overdue'); expect(a.find(i => i.key === 'm:m1')!.state).toBe('upcoming');
    expect(b.find(i => i.key === 'm:m1')!.title).toContain('renamed'); expect(a.some(i => i.key === 'm:m3' || i.key === 'm:m4' || i.key === 'o:ms2')).toBe(false);
    expect(O.sortTimeline(a).map(i => i.key)).toEqual(['m:m2', 'o:ms1', 'e:e2', 'e:e1', 'm:m1']);
    expect(O.sortTimeline(a, true)[0].key).toBe('m:m1');
  });
});

describe('OMEGA metrics: derived from real data, honest about gaps and conflicts', () => {
  const m1 = mk('One', { id: 'm1', status: 'completed', tasks: tasks('a', 'b') }), m2 = mk('Two', { id: 'm2', status: 'active', tasks: tasks('c', 'd') });
  it('no data gives null percentages, not 0% or 100%', () => { const r = O.omegaMetrics(O.newOmega(), []); expect(r.milestones.pct).toBeNull(); expect(r.tasks.pct).toBeNull(); expect(r.conflicts).toEqual([]); });
  it('computes from milestones and from linked mission objectives, skipping cancelled missions', () => {
    m1.tasks.forEach(t => (t.done = true)); const m3 = mk('Gone', { id: 'm3', status: 'cancelled', tasks: tasks('z') });
    const o = O.newOmega({ missionIds: ['m1', 'm2', 'm3'], milestones: [{ id: 'a', title: 'A', target: '', done: true, missionId: '', notes: '' }, { id: 'b', title: 'B', target: '', done: false, missionId: '', notes: '' }] });
    const r = O.omegaMetrics(o, [m1, m2, m3]); expect(r.milestones).toEqual({ done: 1, total: 2, pct: 50 }); expect(r.tasks).toEqual({ done: 2, total: 4, pct: 50 }); expect(r.cancelledSkipped).toBe(1);
  });
  it('reports missing linked missions and contradictions between milestones and missions', () => {
    const o = O.newOmega({ missionIds: ['m1', 'ghost'], milestones: [{ id: 'a', title: 'Claimed', target: '', done: true, missionId: 'm2', notes: '' }, { id: 'b', title: 'Forgot', target: '', done: false, missionId: 'm1', notes: '' }] });
    const r = O.omegaMetrics(o, [m1, m2]); expect(r.missing).toEqual(['ghost']); expect(r.conflicts).toHaveLength(2); expect(r.conflicts[0]).toContain('marked done'); expect(r.conflicts[1]).toContain('completed');
  });
});

describe('reference integrity', () => {
  const m = mk('M', { id: 'm1', archiveRefs: ['r1', 'gone'] }), ops = (): O.OpsBundle => ({ missions: [m], omega: O.newOmega({ missionIds: ['m1', 'nomission'], archiveRefs: ['gone'], milestones: [{ id: 'ms1', title: 'x', target: '', done: false, missionId: 'nomission', notes: '' }] }),
    events: [O.newEvent({ title: 'E', date: T, missionId: 'nomission', milestoneId: 'nomilestone' }), O.newEvent({ title: 'Fine', date: T, missionId: 'm1', milestoneId: 'ms1' })] });
  it('lists every dangling reference and changes nothing', () => { const o = ops(); const i = O.opsIssues(o, new Set(['r1'])); expect(i).toHaveLength(6); expect(o.missions[0].archiveRefs).toEqual(['r1', 'gone']); });
  it('strip returns only the changed objects, with only the broken references removed', () => {
    const o = ops(), s = O.stripBrokenRefs(o, new Set(['r1'])); expect(s.removed).toBe(6); expect(s.missions[0].archiveRefs).toEqual(['r1']); expect(s.omega!.missionIds).toEqual(['m1']); expect(s.omega!.archiveRefs).toEqual([]);
    expect(s.omega!.milestones[0].missionId).toBe(''); expect(s.events).toHaveLength(1); expect(s.events[0].missionId).toBe(''); expect(s.events[0].milestoneId === ''); expect(O.opsIssues({ missions: s.missions.length ? [s.missions[0]] : [], omega: s.omega, events: [...s.events, o.events[1]] }, new Set(['r1']))).toHaveLength(0);
  });
});

describe('backup section', () => {
  const rec = { id: 'r', name: 'R', kind: 'note', description: '', tags: [], source: '', confidence: 'unknown', status: '', links: [], notes: '', created: new Date().toISOString(), modified: new Date().toISOString() };
  const file = (extra: object) => JSON.stringify({ app: 'brainiac-os', schema: 1, exported: new Date().toISOString(), records: [rec], audit: [], ...extra });
  it('an old backup without ops restores with an empty ops bundle', () => { const r = O.parseFullBackup(file({})); expect(r.records).toHaveLength(1); expect(r.ops).toEqual({ missions: [], omega: null, events: [] }); });
  it('a valid ops section round-trips', () => { const mm = mk('Round'); const r = O.parseFullBackup(file({ ops: { missions: [mm], omega: O.newOmega(), events: [O.newEvent({ title: 'e', date: T })] } })); expect(r.ops.missions[0].title).toBe('Round'); expect(r.ops.omega!.id).toBe('omega'); expect(r.ops.events).toHaveLength(1); });
  it('rejects malformed, duplicate or oversized ops sections with a message naming the item', () => {
    expect(() => O.parseFullBackup(file({ ops: { missions: [{ ...mk('a'), status: 'bad' }] } }))).toThrow(/Mission 1/);
    const dup = mk('a'); expect(() => O.parseFullBackup(file({ ops: { missions: [dup, dup] } }))).toThrow(/duplicate/); expect(() => O.parseFullBackup(file({ ops: 5 }))).toThrow(/not an object/);
    expect(() => O.parseFullBackup(file({ ops: { events: [{ id: 'e', title: 'x', date: '2026-02-30', category: 'other', priority: 'low', status: 'planned', created: new Date().toISOString(), modified: new Date().toISOString() }] } }))).toThrow(/Event 1/);
    expect(() => O.parseFullBackup(file({ ops: { omega: { id: 'omega' } } }))).toThrow(/OMEGA/);
  });
});
