// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { it, expect, beforeAll, vi } from 'vitest';
import * as db from '../src/db';
import { sampleRecords } from '../src/model';

const wait = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout: ' + document.body.textContent); await new Promise(r => setTimeout(r, 10)); } };
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const text = () => document.body.textContent || '';
const submit = (id: string) => $('#' + id).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const tab = async (v: string, marker: string) => { $(`[data-act=tab][data-id=${v}]`).click(); await wait(() => text().includes(marker)); };

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>'; window.confirm = vi.fn(() => true); window.prompt = vi.fn(() => 'ERASE');
  await import('../src/main'); await wait(() => !!$('nav'));
});

it('shows an empty state, loads sample data incl. Palladium, and shows missing-detail prompts', async () => {
  expect(text()).toContain('No intelligence recorded yet');
  await tab('settings', 'Load sample data'); $('[data-act=sample]').click(); await wait(() => text().includes('sample records added'));
  await tab('command', 'Recently updated');
  expect(text()).toContain('Missing detail'); expect(text()).toContain('Palladium');
  await tab('omega', 'Project OMEGA does not exist yet'); expect(text()).toContain('does not predict'); // Stage 5: the old "Not built yet" placeholder is replaced by a real empty state
});
it('command box understands natural language', async () => {
  await tab('command', 'Recently updated');
  ($('#cq') as HTMLInputElement).value = 'What do we know about Ultron?'; submit('cf');
  await wait(() => !!$('#list .item')); expect($('#list').textContent).toContain('Ultron');
});
it('creates one record even if Save is tapped twice, and survives going offline mid-edit', async () => {
  await tab('archive', 'New record'); $('[data-act=new]').click(); await wait(() => !!$('#rf'));
  ($('#name') as HTMLInputElement).value = 'Test Node'; Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }); window.dispatchEvent(new Event('offline'));
  expect(text()).toContain('OFFLINE'); expect(($('#name') as HTMLInputElement).value).toBe('Test Node');
  submit('rf'); submit('rf'); await wait(() => text().includes('Saved'));
  expect((await db.getAll()).filter(r => r.name === 'Test Node')).toHaveLength(1);
});
it('rejects an empty name without saving', async () => {
  await tab('archive', 'New record'); $('[data-act=new]').click(); await wait(() => !!$('#rf')); const before = (await db.getAll()).length;
  submit('rf'); await wait(() => text().includes('Name is required')); expect((await db.getAll()).length).toBe(before);
  $('[data-act=cancel]').click();
});
it('backs up, erases and restores everything through the UI', async () => {
  const n = (await db.getAll()).length;
  await tab('settings', 'Prepare backup'); $('[data-act=export]').click(); await wait(() => !!$('[data-act=showtext]'));
  $('[data-act=showtext]').click(); await wait(() => !!$('#bt')); const backup = ($('#bt') as HTMLTextAreaElement).value;
  $('[data-act=clear]').click(); await wait(() => text().includes('All data erased')); expect(await db.getAll()).toHaveLength(0);
  ($('#paste') as HTMLTextAreaElement).value = 'garbage'; $('[data-act=restoretext]').click(); await wait(() => text().includes('not valid JSON'));
  ($('#paste') as HTMLTextAreaElement).value = backup; $('[data-act=restoretext]').click(); await wait(() => text().includes('Restored'));
  expect(await db.getAll()).toHaveLength(n);
});

const jsonRes = (b: any, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status }));
it('shows lookup as not set up and refuses politely', async () => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); window.dispatchEvent(new Event('online'));
  await tab('command', 'Recently updated'); expect(text()).toContain('NOT SET UP');
  ($('#cq') as HTMLInputElement).value = 'Powerborne'; $('[data-act=lookup]').click(); await wait(() => text().includes('Set up online lookup'));
});
it('looks up online, lets you review, and saves only after confirming (as unverified)', async () => {
  await db.setMeta('lookupUrl', 'https://w.example.workers.dev'); await db.setMeta('lookupPass', 'pw');
  const f = vi.fn(() => jsonRes({ hits: [{ title: 'Powerborne Heroes', summary: 'A <b>superhero</b> addon', url: 'https://modrinth.com/mod/powerborne-heroes', source: 'Modrinth' }] })); vi.stubGlobal('fetch', f);
  await tab('settings', 'Online lookup'); await tab('command', 'Look up online'); expect(text()).toContain('LOOKUP READY');
  const before = (await db.getAll()).length;
  ($('#cq') as HTMLInputElement).value = 'Powerborne'; $('[data-act=lookup]').click(); await wait(() => text().includes('Online results'));
  expect($('#lk').innerHTML).not.toContain('<b>superhero</b>'); expect(f).toHaveBeenCalledTimes(1);
  expect((await db.getAll()).length).toBe(before);
  $('[data-act=saveweb]').click(); await wait(() => !!$('#rf'));
  expect(($('#name') as HTMLInputElement).value).toBe('Powerborne Heroes'); expect(($('#confidence') as HTMLSelectElement).value).toBe('unverified');
  expect(($('#source') as HTMLInputElement).value).toContain('modrinth.com'); expect((await db.getAll()).length).toBe(before);
  submit('rf'); await wait(() => text().includes('Saved')); const saved = (await db.getAll()).find(r => r.name === 'Powerborne Heroes')!;
  expect(saved.confidence).toBe('unverified'); expect(saved.tags).toContain('web-lookup');
});
it('Ask AI shows an answer with sources, and failures leave the archive usable', async () => {
  vi.stubGlobal('fetch', vi.fn(() => jsonRes({ answer: 'It adds heroes.', sources: [{ title: 'Page', url: 'https://modrinth.com/x' }, { title: 'x', url: 'javascript:alert(1)' }] })));
  await tab('command', 'Look up online'); ($('#cq') as HTMLInputElement).value = 'What is Powerborne?'; $('[data-act=ask]').click(); await wait(() => text().includes('It adds heroes.'));
  expect(text()).toContain('unverified'); expect($('#lk').innerHTML).not.toContain('javascript:');
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))); $('[data-act=ask]').click(); await wait(() => text().includes('Could not reach'));
  expect(text()).toContain('Your archive still works');
  vi.stubGlobal('fetch', vi.fn(() => jsonRes({ error: 'x' }, 401))); $('[data-act=lookup]').click(); await wait(() => text().includes('Wrong passphrase'));
});
it('rejects an invalid Worker address in Setup', async () => {
  await tab('settings', 'Test connection'); ($('#wurl') as HTMLInputElement).value = 'http://insecure.example'; ($('#wpass') as HTMLInputElement).value = 'x';
  $('[data-act=savecfg]').click(); await wait(() => text().includes('https://'));
  expect(await db.getMeta('lookupUrl')).toBe('https://w.example.workers.dev');
});
it('refuses lookups while offline without calling the network', async () => {
  const f = vi.fn(); vi.stubGlobal('fetch', f); Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  await tab('command', 'Look up online'); ($('#cq') as HTMLInputElement).value = 'Palladium'; $('[data-act=lookup]').click(); await wait(() => text().includes('You are offline'));
  expect(f).not.toHaveBeenCalled(); Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
it('rejects a passphrase with non-ASCII characters', async () => {
  await tab('settings', 'Test connection'); ($('#wurl') as HTMLInputElement).value = 'https://ok.workers.dev'; ($('#wpass') as HTMLInputElement).value = 'pässword';
  $('[data-act=savecfg]').click(); await wait(() => text().includes('plain letters')); expect(await db.getMeta('lookupPass')).toBe('pw');
});
it('shows the storage chip; erase keeps a safety copy that Undo brings back (Stage 1)', async () => {
  await tab('command', 'Recently updated'); expect(text()).toContain('STORAGE');
  await db.save((await import('../src/model')).newRecord({ name: 'Undo Probe' }));
  await tab('settings', 'Safety copy'); const n = (await db.getAll()).length; expect(n).toBeGreaterThan(0);
  $('[data-act=clear]').click(); await wait(() => text().includes('All data erased')); expect(await db.getAll()).toHaveLength(0);
  await wait(() => !!$('[data-act=undo]')); $('[data-act=undo]').click(); await wait(() => text().includes('from the safety copy'));
  expect(await db.getAll()).toHaveLength(n);
});
it('restoring an older backup does not overwrite a newer local edit (Stage 1)', async () => {
  await tab('settings', 'Prepare backup'); $('[data-act=export]').click(); await wait(() => !!$('[data-act=showtext]'));
  $('[data-act=showtext]').click(); await wait(() => !!$('#bt')); const backup = ($('#bt') as HTMLTextAreaElement).value;
  const probe = (await db.getAll()).find(r => r.name === 'Undo Probe')!; await new Promise(r => setTimeout(r, 20));
  await db.save({ ...probe, name: 'Edited After Backup' });
  ($('#paste') as HTMLTextAreaElement).value = backup; $('[data-act=restoretext]').click(); await wait(() => text().includes('left unchanged'));
  expect((await db.get(probe.id))?.name).toBe('Edited After Backup');
});

// ---- Stage 3: links UI, related records, history, recovery
const rid = async (name: string) => (await db.getAll()).find(r => r.name === name)!;
const open = async (name: string) => { await tab('archive', 'New record'); ($('#q') as HTMLInputElement).value = name; $('#q').dispatchEvent(new Event('input', { bubbles: true })); await wait(() => !!$('#list .item')); const hit = [...document.querySelectorAll('#list .item')].find(b => b.querySelector('b')?.textContent === name) as HTMLElement; hit.click(); await wait(() => text().includes('Linked from')); };
it('record detail shows what it links to and what links to it (Stage 3)', async () => {
  await db.clearAll(); await db.importRecords(sampleRecords(), 'sample');
  await open('Ultron'); expect(text()).toContain('Links to (2)'); expect($('main').textContent).toContain('Prime Collective');
  await open('Prime Collective'); expect(text()).toContain('Linked from (5)'); expect($('main').textContent).toContain('Sentry');
});
it('adds and removes a link in the form without losing typed text, and applies it on Save (Stage 3)', async () => {
  await db.clearAll(); await db.importRecords(sampleRecords(), 'sample'); await open('Sentry'); const sentry = await rid('Sentry'); expect(sentry.links).toEqual(['sample-pc']);
  $('[data-act=edit]').click(); await wait(() => !!$('#rf')); ($('#description') as HTMLTextAreaElement).value = 'typed but not yet saved';
  const lq = $('#lq') as HTMLInputElement; lq.value = 'ultron'; lq.dispatchEvent(new Event('input', { bubbles: true })); await wait(() => !!$('#lr [data-act=linkrec]'));
  $('#lr [data-act=linkrec]').click(); await wait(() => !!$('[data-act=unlinkrec][data-id=sample-ultron]'));
  expect(($('#description') as HTMLTextAreaElement).value).toBe('typed but not yet saved');
  expect((await db.get(sentry.id))!.links).toEqual(['sample-pc']); // nothing is persisted until Save
  submit('rf'); await wait(() => text().includes('Saved')); await wait(() => text().includes('Links to (2)'));
  const s2 = (await db.get(sentry.id))!; expect(s2.links).toEqual(['sample-pc', 'sample-ultron']); expect(s2.description).toBe('typed but not yet saved');
  $('[data-act=edit]').click(); await wait(() => !!$('#rf')); $('[data-act=unlinkrec][data-id=sample-pc]').click(); await wait(() => !$('[data-act=unlinkrec][data-id=sample-pc]'));
  submit('rf'); await wait(() => text().includes('Links to (1)')); expect((await db.get(sentry.id))!.links).toEqual(['sample-ultron']);
});
it('Enter in the link search does not save the record, and a record cannot link to itself (Stage 3)', async () => {
  await open('Sentry'); $('[data-act=edit]').click(); await wait(() => !!$('#rf')); const before = (await db.get('sample-sentry'))!.modified;
  const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); $('#lq').dispatchEvent(ev); expect(ev.defaultPrevented).toBe(true);
  const lq = $('#lq') as HTMLInputElement; lq.value = 'sentry'; lq.dispatchEvent(new Event('input', { bubbles: true })); expect($('#lr [data-id=sample-sentry]')).toBe(null); expect($('#lr').textContent).not.toContain('Sentrycharacter');
  expect((await db.get('sample-sentry'))!.modified).toBe(before); $('[data-act=cancel]').click();
});
it('shows history with changes and restores an earlier version, which is itself reversible (Stage 3)', async () => {
  await open('Sentry'); const r = (await db.get('sample-sentry'))!; await db.save({ ...r, status: 'active' }); await db.save({ ...r, status: 'retired' });
  await open('Sentry'); expect(text()).toContain('status: active → retired');
  const btns = document.querySelectorAll('[data-act=restorever]'); expect(btns.length).toBeGreaterThan(1);
  // newest entry first: restoring the version from before the latest change returns status 'active'
  (btns[0] as HTMLElement).click(); await wait(() => text().includes('Restored “Sentry”')); expect((await db.get('sample-sentry'))!.status).toBe('active');
  await open('Sentry'); expect(text()).toContain('status: retired → active');
});
it('recovers a deleted record from Setup (Stage 3)', async () => {
  await db.remove('sample-kryptonian'); expect(await db.get('sample-kryptonian')).toBeUndefined();
  await tab('settings', 'Deleted records'); await wait(() => text().includes('deleted ')); $('[data-act=restorever]').click();
  await wait(() => text().includes('Restored “Kryptonian”')); expect((await db.get('sample-kryptonian'))?.name).toBe('Kryptonian');
});
it('Archive check finds broken links and removes them only on confirmation (Stage 3)', async () => {
  const r = (await db.get('sample-sentry'))!; await db.save({ ...r, links: [...r.links, 'ghost-id'] });
  await tab('settings', 'Archive check'); expect(text()).toContain('1 links point to records that are not in this archive');
  window.confirm = vi.fn(() => false); $('[data-act=fixlinks]').click(); await new Promise(r => setTimeout(r, 50)); expect((await db.get('sample-sentry'))!.links).toContain('ghost-id');
  window.confirm = vi.fn(() => true); $('[data-act=fixlinks]').click(); await wait(() => text().includes('broken links removed'));
  expect((await db.get('sample-sentry'))!.links).not.toContain('ghost-id'); expect(text()).toContain('No broken links');
});
it('voice chip does not claim voice is available (Stage 3)', async () => { await tab('command', 'Recently updated'); expect(text()).toMatch(/VOICE (UNVERIFIED|UNSUPPORTED HERE)/); expect(text()).not.toContain('VOICE AVAILABLE'); expect(text()).not.toContain('NOT BUILT'); }); // Stage 5: chip says UNVERIFIED/UNSUPPORTED until a real microphone session has produced text
