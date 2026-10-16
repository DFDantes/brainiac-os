// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { it, expect, beforeAll, vi } from 'vitest';
import * as db from '../src/db';
import * as O from '../src/ops';
import { newRecord, serializeBackup } from '../src/model';

const wait = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout. Page says: ' + document.body.textContent!.slice(0, 600)); await new Promise(r => setTimeout(r, 10)); } };
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const $$ = (s: string) => [...document.querySelectorAll(s)] as HTMLElement[];
const text = () => document.body.textContent || '';
const setv = (s: string, v: string) => { ($(s) as HTMLInputElement).value = v; };
const submit = (id: string) => $('#' + id).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const tab = async (v: string, marker: string) => { $(`[data-act=tab][data-id=${v}]`).click(); await wait(() => text().includes(marker)); };
const act = (a: string, i = 0) => $$(`[data-act="${a}"]`)[i].click();
/** Clears the toast first so an identical message from the previous action cannot satisfy the wait, then performs the action and waits for its own message. */
const doit = async (msg: string, fn: () => void) => { const m = document.getElementById('msg'); if (m) m.textContent = ''; fn(); await wait(() => text().includes(msg)); };
const fire = (s: string, type: string) => $(s).dispatchEvent(new Event(type, { bubbles: true }));
let yes = true; const PAST = '2000-01-02', FUTURE = '2999-01-01';
const missionByTitle = async (t: string) => (await db.getMissions()).find(m => m.title === t)!;
const newMission = async (title: string, extra: Record<string, string> = {}) => { await tab('colossus', 'New mission'); act('o:mnew'); await wait(() => !!$('#of-mission')); setv('#of-mission-title', title); for (const [k, v] of Object.entries(extra)) setv('#of-mission-' + k, v); submit('of-mission'); await wait(() => text().includes('Mission created.')); };

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>'; window.confirm = vi.fn(() => yes); window.prompt = vi.fn(() => 'ERASE');
  await import('../src/main'); await wait(() => !!$('nav'));
});

it('COLOSSUS starts empty (no fake data) and creates a mission that persists; invalid input is rejected', async () => {
  await tab('colossus', 'No missions yet'); expect(text()).toContain('Nothing here is sample data'); expect(text()).toContain('0 missions');
  act('o:mnew'); await wait(() => !!$('#of-mission')); submit('of-mission'); await wait(() => text().includes('Mission title is required')); expect(await db.getMissions()).toHaveLength(0);
  setv('#of-mission-title', 'Op Nightfall'); setv('#of-mission-priority', 'high'); setv('#of-mission-deadline', PAST); setv('#of-mission-tags', 'space, base'); submit('of-mission'); await wait(() => text().includes('Mission created.'));
  const m = await missionByTitle('Op Nightfall'); expect(m.priority).toBe('high'); expect(m.deadline).toBe(PAST); expect(m.tags).toEqual(['space', 'base']); expect(m.status).toBe('planned');
  expect(text()).toContain('OVERDUE'); expect(text()).toContain('no progress figure'); expect(text()).toContain('is still planned'); // past deadline is flagged, status is not changed
});
it('objectives: add, complete, progress is derived from real state, and it survives leaving and returning', async () => {
  for (const t of ['Scout the target', 'Build the relay']) { setv('#of-task-text', t); await doit('Objective added.', () => submit('of-task')); }
  setv('#of-task-text', '  '); await doit('Type the objective first.', () => submit('of-task'));
  expect((await missionByTitle('Op Nightfall')).tasks).toHaveLength(2); act('o:ttoggle'); await wait(() => text().includes('1 of 2 objectives complete (50%)'));
  expect((await missionByTitle('Op Nightfall')).tasks[0].done).toBe(true);
  await tab('archive', 'New record'); await tab('colossus', 'New mission'); expect(text()).toContain('1/2 objectives (50%)'); // list view shows persisted, derived progress
});
it('dependencies: blocked state is visible, loops are refused with a message and nothing saved', async () => {
  act('o:mopen'); await wait(() => !!$('[data-act="o:ttoggle"]')); act('o:ttoggle'); await wait(() => text().includes('0 of 2 objectives complete (0%)')); // reopen #1
  act('o:tedit', 1); await wait(() => !!$('#of-taskedit')); ($('#of-taskedit input[name=dep]') as HTMLInputElement).checked = true; submit('of-taskedit'); await wait(() => text().includes('Objective saved.') && text().includes('BLOCKED'));
  expect(text()).toContain('waiting on: Scout the target'); expect((await missionByTitle('Op Nightfall')).tasks[1].dependsOn).toHaveLength(1);
  act('o:tedit', 0); await wait(() => !!$('#of-taskedit')); ($('#of-taskedit input[name=dep]') as HTMLInputElement).checked = true; submit('of-taskedit'); await wait(() => text().includes('circular dependency'));
  expect((await missionByTitle('Op Nightfall')).tasks[0].dependsOn).toEqual([]); act('o:tcancel');
  await wait(() => !$('#of-taskedit')); act('o:ttoggle'); await wait(() => text().includes('1 of 2') && !text().includes('BLOCKED')); // finishing the prerequisite unblocks #2
});
it('moving an objective reorders it; deleting asks first and refusal changes nothing', async () => {
  act('o:tdown', 0); await wait(() => text().includes('Objective moved.')); expect((await missionByTitle('Op Nightfall')).tasks.map(t => t.text)).toEqual(['Build the relay', 'Scout the target']);
  yes = false; act('o:tdel', 0); await new Promise(r => setTimeout(r, 60)); expect((await missionByTitle('Op Nightfall')).tasks).toHaveLength(2);
  yes = true; act('o:tdel', 0); await wait(() => text().includes('Objective deleted.')); expect((await missionByTitle('Op Nightfall')).tasks.map(t => t.text)).toEqual(['Scout the target']);
  setv('#of-task-text', 'Build the relay'); submit('of-task'); await wait(() => (text().match(/Build the relay/g) ?? []).length >= 1);
});
it('risks and resources are stored as user-entered records and can be deleted after confirmation', async () => {
  setv('#of-risk-kind', 'assumption'); setv('#of-risk-text', 'The base stays online'); setv('#of-risk-mitigation', 'Keep a spare'); submit('of-risk'); await wait(() => text().includes('The base stays online'));
  expect(text()).toContain('no access to any game server'); // honest framing is on screen while none are recorded
  setv('#of-res-name', 'Netherite'); setv('#of-res-note', '64 blocks'); submit('of-res'); await wait(() => text().includes('Netherite'));
  const m = await missionByTitle('Op Nightfall'); expect(m.risks[0]).toMatchObject({ kind: 'assumption', text: 'The base stays online', mitigation: 'Keep a spare' }); expect(m.resources[0]).toMatchObject({ name: 'Netherite', needed: true });
  act('o:resdel'); await wait(() => !text().includes('64 blocks')); expect((await missionByTitle('Op Nightfall')).resources).toHaveLength(0);
});
it('archive references: pick a record, see it, remove only the reference; archive detail shows "Used by"', async () => {
  const rec = newRecord({ name: 'Relay Tower', kind: 'asset' }); await db.save(rec); await tab('archive', 'New record'); await tab('colossus', 'New mission'); act('o:mopen'); await wait(() => !!$('#orq'));
  setv('#orq', 'relay'); fire('#orq', 'input'); await wait(() => !!$('[data-act="o:addref"]')); act('o:addref'); await wait(() => text().includes('Archive record referenced.')); expect((await missionByTitle('Op Nightfall')).archiveRefs).toEqual([rec.id]);
  act('o:openrec'); await wait(() => text().includes('Used by (1)')); expect(text()).toContain('Op Nightfall'); act('o:gomission'); await wait(() => text().includes('Archive references'));
  act('o:delref'); await wait(() => text().includes('Reference removed.')); expect((await missionByTitle('Op Nightfall')).archiveRefs).toEqual([]); expect(await db.get(rec.id)).toBeDefined();
});
it('search, status filter, sort and archive filter on the mission list act on stored data', async () => {
  await newMission('Bravo Recon', { status: 'active', deadline: FUTURE }); await tab('colossus', 'Show archived missions only'); expect($$('#mlist .item')).toHaveLength(2);
  setv('#mq', 'bravo'); fire('#mq', 'input'); expect($$('#mlist .item')).toHaveLength(1); expect($('#mlist').textContent).toContain('Bravo Recon'); setv('#mq', ''); fire('#mq', 'input');
  setv('#mst', 'active'); fire('#mst', 'change'); expect($$('#mlist .item')).toHaveLength(1); setv('#mst', ''); fire('#mst', 'change');
  setv('#msort', 'title'); fire('#msort', 'change'); expect($$('#mlist .item')[0].textContent).toContain('Bravo'); setv('#msort', 'deadline'); fire('#msort', 'change'); expect($$('#mlist .item')[0].textContent).toContain('Op Nightfall'); // earliest deadline first
  setv('#mq', 'zzzz'); fire('#mq', 'input'); expect($('#mlist').textContent).toContain('No missions match'); setv('#mq', ''); fire('#mq', 'input');
  const chipsText = document.querySelector('.panel .chips')!.textContent!; expect(chipsText).toContain('2 missions'); expect(chipsText).toContain('1 overdue');
});
it('duplicate copies objectives reopened; archive hides without deleting; delete asks, keeps events, and is recoverable', async () => {
  act('o:mopen', 0); await wait(() => !!$('[data-act="o:mdup"]')); const title = $('.panel b').textContent!; act('o:mdup'); await wait(() => text().includes('Mission duplicated'));
  const dup = (await db.getMissions()).find(m => m.title.endsWith('(copy)'))!; expect(dup.status).toBe('planned'); expect(dup.tasks.every(t => !t.done)).toBe(true); expect(dup.id).not.toBe((await db.getMissions()).find(m => m.title === title)!.id);
  act('o:march'); await wait(() => text().includes('Mission archived')); expect((await db.getMissions()).find(m => m.id === dup.id)!.archived).toBe(true); await tab('colossus', 'Show archived missions only'); expect($('#mlist').textContent).not.toContain('(copy)');
  ($('#march') as HTMLInputElement).checked = true; fire('#march', 'change'); expect($('#mlist').textContent).toContain('(copy)'); ($('#march') as HTMLInputElement).checked = false; fire('#march', 'change');
  act('o:mopen', 0); /* first row after filter is still a live mission */ await wait(() => !!$('[data-act="o:mdel"]')); const before = (await db.getMissions()).length; yes = false; act('o:mdel'); await new Promise(r => setTimeout(r, 60)); expect((await db.getMissions()).length).toBe(before); yes = true;
});
it('TIMELINE: validation, overdue only while planned, done moves to history, links to a mission, delete never touches the mission', async () => {
  const m = await missionByTitle('Bravo Recon'); await tab('timeline', 'New event'); expect(text()).toContain('Overdue means a planned item whose date has passed'); act('o:enew'); await wait(() => !!$('#of-event'));
  setv('#of-event-title', 'Pre-launch check'); setv('#of-event-date', ''); submit('of-event'); await wait(() => text().includes('Pick a date.')); setv('#of-event-date', PAST); setv('#of-event-time', '09:30'); setv('#of-event-missionId', m.id); setv('#of-event-category', 'operation'); submit('of-event'); await wait(() => text().includes('Event created.'));
  expect(await db.getEvents()).toHaveLength(1); expect(text()).toContain('Overdue (planned, date has passed) (2)'); expect(text()).toContain('Pre-launch check'); // the event plus the derived deadline of the past-dated mission expect(text()).toContain('09:30'); expect(text()).toContain('Bravo Recon');
  act('o:edone'); await wait(() => text().includes('Event marked done.')); expect(text()).toContain('Overdue (planned, date has passed) (1)'); expect((await db.getEvents())[0].status).toBe('done'); // only the derived deadline remains overdue; expect((await missionByTitle('Bravo Recon')).status).toBe('active'); // done event is no longer overdue; the mission is untouched
  setv('#ef', 'done'); fire('#ef', 'change'); expect($('#elist').textContent).toContain('Pre-launch check'); expect($('#elist').textContent).toContain('Done / recorded history');
  yes = false; act('o:edel'); await new Promise(r => setTimeout(r, 60)); expect(await db.getEvents()).toHaveLength(1); yes = true; act('o:edel'); await wait(() => text().includes('Missions and OMEGA untouched')); expect(await db.getEvents()).toHaveLength(0); expect(await missionByTitle('Bravo Recon')).toBeDefined();
});
it('TIMELINE: history events cannot be planned; mission deadlines appear as derived read-only entries; edit persists', async () => {
  act('o:enew'); await wait(() => !!$('#of-event')); setv('#of-event-title', 'Met the council'); setv('#of-event-date', PAST); setv('#of-event-category', 'history'); submit('of-event'); await wait(() => text().includes('already happened')); expect(await db.getEvents()).toHaveLength(0);
  setv('#of-event-status', 'done'); submit('of-event'); await wait(() => text().includes('Event created.')); setv('#ef', 'all'); fire('#ef', 'change'); expect($('#elist').textContent).toContain('Deadline: Op Nightfall'); expect($('#elist').textContent).toContain('SYSTEM-DERIVED'); expect($('#elist').textContent).toContain('not stored as an event');
  act('o:eedit'); await wait(() => !!$('#of-event')); setv('#of-event-title', 'Met the council (edited)'); submit('of-event'); await wait(() => text().includes('Event saved.')); expect((await db.getEvents())[0].title).toBe('Met the council (edited)'); expect(await db.getEvents()).toHaveLength(1); // edit does not duplicate
});
it('OMEGA: empty state, create, milestones link missions, conflicts are shown, progress is derived, persists', async () => {
  await tab('omega', 'Project OMEGA does not exist yet'); setv('#of-onew-purpose', 'Take the space base'); submit('of-onew'); await wait(() => text().includes('Project OMEGA created.'));
  const nm = await missionByTitle('Op Nightfall'); setv('#of-ms-title', 'Relay online'); setv('#of-ms-target', PAST); setv('#of-ms-missionId', nm.id); submit('of-ms'); await wait(() => text().includes('Milestone added'));
  setv('#of-ms-title', 'Second one'); submit('of-ms'); await wait(() => text().includes('Second one')); act('o:mstoggle'); await wait(() => text().includes('Milestone updated.')); // mark "Relay online" done while its mission is not completed
  expect(text()).toContain('Conflicts (1)'); expect(text()).toContain('is marked done, but its mission'); expect(text()).toContain('1 of 2 milestones complete (50%)'); // 1 of 2 milestones marked done
  expect(text()).toContain('not forecasts'); expect(text()).toContain('SYSTEM-DERIVED'); const o = (await db.getOmega())!; expect(o.milestones.map(m => m.done)).toEqual([true, false]); expect(o.missionIds).toEqual([]);
  setv('#olsel', nm.id); act('o:olink'); await wait(() => text().includes('Mission linked.')); expect((await db.getOmega())!.missionIds).toEqual([nm.id]);
  await tab('timeline', 'New event'); setv('#ef', 'all'); fire('#ef', 'change'); expect($('#elist').textContent).toContain('OMEGA milestone: Relay online'); await tab('omega', 'Hypotheses and assumptions'); expect(text()).toContain('Relay online');
});
it('OMEGA: hypotheses carry their origin, an AI answer can be added only as an unverified suggestion, decisions and options persist', async () => {
  setv('#of-hyp-text', 'They will not expect a night attack'); setv('#of-hyp-confidence', 'low'); submit('of-hyp'); await wait(() => text().includes('recorded as your own assumption'));
  setv('#of-opt-title', 'Fallback: hold the line'); setv('#of-opt-expected', 'Lose less'); ($('#of-opt input[name=fallback]') as HTMLInputElement).checked = true; submit('of-opt'); await wait(() => text().includes('FALLBACK PLAN'));
  setv('#of-dec-decision', 'Strike at night'); setv('#of-dec-rationale', 'Less defenders online'); setv('#of-dec-lesson', 'Check timezones'); submit('of-dec'); await wait(() => text().includes('Decision recorded.'));
  const o = (await db.getOmega())!; expect(o.hypotheses[0]).toMatchObject({ origin: 'user', confidence: 'low' }); expect(o.options[0].fallback).toBe(true); expect(o.decisions[0]).toMatchObject({ decision: 'Strike at night', rationale: 'Less defenders online', lesson: 'Check timezones' });
  expect(text()).toContain('USER-ENTERED'); expect(text()).toContain('Nothing here is a verified fact');
  await db.mutateOmega(x => ({ ...x, hypotheses: [...x.hypotheses, { id: 'ai1', text: 'AI says X', basis: 'Ask AI', confidence: 'unknown', origin: 'ai', created: new Date().toISOString() }] })); await tab('colossus', 'Show archived missions only'); await tab('omega', 'AI-SUGGESTED · UNVERIFIED');
});
it('OMEGA: milestone edit, mission link/unlink never changes the mission, and deleting the project keeps missions and events', async () => {
  const nm = await missionByTitle('Op Nightfall'); act('o:ounlink'); await wait(() => text().includes('Link removed.')); expect((await db.getOmega())!.missionIds).toEqual([]); expect(await missionByTitle('Op Nightfall')).toMatchObject({ id: nm.id, tasks: nm.tasks });
  act('o:msedit', 1); await wait(() => !!$('#of-msedit')); setv('#of-msedit-title', 'Second (renamed)'); submit('of-msedit'); await wait(() => text().includes('Milestone saved.')); expect((await db.getOmega())!.milestones[1].title).toBe('Second (renamed)');
  const missions = (await db.getMissions()).length, events = (await db.getEvents()).length; yes = false; act('o:odel'); await new Promise(r => setTimeout(r, 60)); expect(await db.getOmega()).not.toBeNull();
  yes = true; act('o:odel'); await wait(() => text().includes('Project OMEGA deleted.')); expect(await db.getOmega()).toBeNull(); expect((await db.getMissions()).length).toBe(missions); expect((await db.getEvents()).length).toBe(events);
  await tab('settings', 'Recently deleted'); expect(text()).toContain('Project OMEGA'); act('o:restoretrash'); await wait(() => text().includes('Restored')); expect(await db.getOmega()).not.toBeNull(); expect((await db.getOmega())!.hypotheses.length).toBe(2);
});
it('COMMAND tab: ops commands run for real; unclear ones change nothing; archive questions still search; destructive ones ask', async () => {
  await tab('command', 'Recently updated'); setv('#cq', 'mission new Cmd Mission priority=low'); submit('cf'); await wait(() => text().includes('ACK. Mission “Cmd Mission” created')); expect((await missionByTitle('Cmd Mission')).priority).toBe('low');
  setv('#cq', 'mission show cmd'); submit('cf'); await wait(() => text().includes('no objectives recorded')); setv('#cq', 'mission frobnicate'); submit('cf'); await wait(() => text().includes('REJECTED. Unknown mission command')); expect($('#cq').getAttribute('value')).toBe('mission frobnicate'); // a rejected command stays editable
  yes = false; setv('#cq', 'mission delete cmd'); submit('cf'); await wait(() => text().includes('CANCELLED. Nothing was changed.')); expect(await missionByTitle('Cmd Mission')).toBeDefined(); yes = true;
  await db.save(newRecord({ name: 'Ultron Prime', kind: 'character' })); setv('#cq', 'What do we know about Ultron?'); submit('cf'); await wait(() => !!$('#list .item')); expect($('#list').textContent).toContain('Ultron Prime');
  await tab('command', 'Recently updated'); setv('#cq', 'search mission'); submit('cf'); await wait(() => !!$('#q')); expect(($('#q') as HTMLInputElement).value).toBe('mission'); // "search" forces an archive search
  await tab('command', 'Recently updated'); act('o:help'); await wait(() => text().includes('COLOSSUS / OMEGA / TIMELINE COMMANDS'));
});
it('VOICE hooks: honest when unsupported; a working (faked) microphone only FILLS the box, never executes; refusal is reported accurately', async () => {
  for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true });
  await tab('settings', 'Danger zone'); await tab('command', 'Recently updated'); expect(text()).toContain('Speech input is not available'); expect($$('[data-act="o:mic"]')).toHaveLength(0); expect(text()).toMatch(/VOICE (UNVERIFIED|UNSUPPORTED HERE)/);
  const make = (mode: 'ok' | 'denied') => class { lang = ''; continuous = false; interimResults = false; maxAlternatives = 1; onstart: any; onresult: any; onerror: any; onend: any; start() { setTimeout(() => { this.onstart?.(); if (mode === 'ok') this.onresult?.({ results: Object.assign([Object.assign([{ transcript: 'mission delete cmd', confidence: 0.9 }], { isFinal: true })], {}) }); else this.onerror?.({ error: 'not-allowed' }); this.onend?.(); }, 5); } stop() {} abort() {} };
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: make('ok'), configurable: true, writable: true }); await tab('settings', 'Danger zone'); await tab('command', 'Recently updated'); expect(text()).toContain('Speak a command');
  const before = (await db.getMissions()).length; act('o:mic'); await wait(() => text().includes('Nothing has been executed')); expect(($('#cq') as HTMLInputElement).value).toBe('mission delete cmd'); expect((await db.getMissions()).length).toBe(before); expect(text()).toContain('MIC HEARD TEXT (THIS SESSION)');
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: make('denied'), configurable: true, writable: true }); await tab('settings', 'Danger zone'); await tab('command', 'Recently updated'); act('o:mic'); await wait(() => text().includes('was refused')); expect(text()).toContain('MIC: BLOCKED');
  Object.defineProperty(window, 'speechSynthesis', { value: { speak: (u: any) => setTimeout(() => { u.onstart?.(); u.onend?.(); }, 1), cancel() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {} }, configurable: true }); Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(public text: string) {} }, configurable: true, writable: true });
  await tab('settings', 'Danger zone'); await tab('command', 'Recently updated'); expect($$('[data-act="o:read"]')).toHaveLength(1); act('o:read'); await new Promise(r => setTimeout(r, 40)); expect(text()).not.toContain('Speech failed');
});
it('SETUP: broken references are listed and removed only after confirmation; deleted missions are recoverable', async () => {
  const rec = newRecord({ name: 'Doomed intel', kind: 'note' }); await db.save(rec); const nm = await missionByTitle('Op Nightfall'); await db.mutateMission(nm.id, x => ({ ...x, archiveRefs: [rec.id] })); await db.remove(rec.id);
  await tab('settings', 'Missions, OMEGA and timeline'); expect(text()).toContain('reference(s) point to things that no longer exist'); yes = false; act('o:fixrefs'); await new Promise(r => setTimeout(r, 60)); expect((await missionByTitle('Op Nightfall')).archiveRefs).toHaveLength(1);
  yes = true; act('o:fixrefs'); await wait(() => text().includes('broken reference(s) removed')); expect((await missionByTitle('Op Nightfall')).archiveRefs).toEqual([]); expect(await missionByTitle('Op Nightfall')).toBeDefined(); await wait(() => text().includes('No broken references.'));
  const cmd = await missionByTitle('Cmd Mission'); await db.deleteMission(cmd.id); await tab('colossus', 'Show archived missions only'); await tab('settings', 'Recently deleted'); expect(text()).toContain('Cmd Mission'); act('o:restoretrash'); await wait(() => text().includes('Restored “Cmd Mission”')); expect(await missionByTitle('Cmd Mission')).toBeDefined();
});
it('BACKUP: a backup file now contains missions, OMEGA and events, and restoring it after an erase brings them back', async () => {
  const text0 = serializeBackup(await db.exportBackup()); expect(JSON.parse(text0).ops.missions.length).toBeGreaterThan(2); const n = (await db.getMissions()).length, ev = (await db.getEvents()).length;
  await db.eraseAll(); expect(await db.getMissions()).toHaveLength(0); await tab('settings', 'Restore from file'); setv('#paste', text0); act('restoretext'); await wait(() => text().includes('missions/OMEGA/events:'));
  expect((await db.getMissions()).length).toBe(n); expect((await db.getEvents()).length).toBe(ev); expect(await db.getOmega()).not.toBeNull();
});
it('SECURITY: titles and notes are shown as text, never as HTML', async () => {
  const evil = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>'; await newMission(evil, { objective: evil, notes: evil });
  expect(text()).toContain('<img src=x'); expect($$('img')).toHaveLength(0); expect($$('#app script')).toHaveLength(0); expect((window as any).__pwn).toBeUndefined();
  await tab('colossus', 'Show archived missions only'); expect($$('#app img')).toHaveLength(0); await tab('timeline', 'New event'); setv('#ef', 'all'); fire('#ef', 'change'); expect($$('#app img')).toHaveLength(0); await tab('settings', 'Recently deleted'); expect($$('#app img')).toHaveLength(0);
});
it('NAVIGATION: tapping a tab returns to its list, and no Stage 5 screen contains a "not built" placeholder', async () => {
  await tab('colossus', 'Show archived missions only'); act('o:mopen'); await wait(() => !!$('[data-act="o:mback"]')); await tab('colossus', 'Show archived missions only'); expect($$('[data-act="o:mback"]')).toHaveLength(0);
  for (const v of ['colossus', 'omega', 'timeline']) { await tab(v, v === 'colossus' ? 'Show archived missions only' : v === 'omega' ? 'Hypotheses and assumptions' : 'Today on this device'); expect(text()).not.toMatch(/not built yet|Planned for Stage/i); }
});
