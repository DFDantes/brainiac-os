export const KINDS = ['character','faction','location','event','report','asset','plan','decision','mechanic','note'] as const;
export const CONF = ['confirmed','user-reported','unverified','inference','unknown'] as const;
export type Kind = typeof KINDS[number];
export type Conf = typeof CONF[number];
export interface Rec { id:string; name:string; kind:Kind; description:string; tags:string[]; source:string; confidence:Conf; status:string; links:string[]; notes:string; created:string; modified:string }
export const SCHEMA = 1;
export const MAX_IMPORT_BYTES = 5_000_000;

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
export const newRecord = (p: Partial<Rec> = {}): Rec => { const t = new Date().toISOString();
  return { id: uid(), name: '', kind: 'note', description: '', tags: [], source: '', confidence: 'user-reported', status: '', links: [], notes: '', created: t, modified: t, ...p }; };

const str = (v: unknown, max: number, f: string) => { if (typeof v !== 'string') throw new Error(`${f} must be text`); if (v.length > max) throw new Error(`${f} is too long`); return v; };
const strs = (v: unknown, n: number, max: number, f: string) => { if (!Array.isArray(v) || v.length > n) throw new Error(`${f} invalid`); return v.map(x => str(x, max, f)); };
const date = (v: unknown, f: string) => { const s = str(v, 40, f); if (isNaN(Date.parse(s))) throw new Error(`${f} is not a date`); return s; };

/** Validates untrusted data; returns a fresh object holding only known fields. */
export function validateRecord(x: any): Rec {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('Record is not an object');
  const id = str(x.id, 64, 'id'); if (!/^[\w-]{1,64}$/.test(id)) throw new Error('Bad id');
  const name = str(x.name, 200, 'name').trim(); if (!name) throw new Error('Name is required');
  if (!KINDS.includes(x.kind)) throw new Error('Unknown category');
  if (!CONF.includes(x.confidence)) throw new Error('Unknown confidence level');
  return { id, name, kind: x.kind, description: str(x.description ?? '', 5000, 'description'), tags: strs(x.tags ?? [], 30, 40, 'tags'),
    source: str(x.source ?? '', 300, 'source'), confidence: x.confidence, status: str(x.status ?? '', 60, 'status'),
    links: strs(x.links ?? [], 100, 64, 'links'), notes: str(x.notes ?? '', 5000, 'notes'),
    created: date(x.created, 'created'), modified: date(x.modified, 'modified') };
}

export interface Backup { app: 'brainiac-os'; schema: number; exported: string; records: Rec[]; audit: unknown[]; ops?: unknown } // `ops` (Stage 5: missions, OMEGA, timeline) is optional so backups from earlier checkpoints still restore; SCHEMA stays 1
/** Serialises a backup and refuses to produce a file that restore would reject (A1). */
export function serializeBackup(b: Backup): string {
  const text = JSON.stringify(b, null, 1);
  if (text.length > MAX_IMPORT_BYTES) throw new Error(`This backup would be ${(text.length / 1e6).toFixed(1)} MB, more than the ${MAX_IMPORT_BYTES / 1e6} MB the restore accepts, so it was not created. Delete or shorten some records first.`);
  if (b.records.length > 5000) throw new Error('This backup would hold more than 5000 records, which restore does not accept, so it was not created.');
  return text;
}
export function parseBackup(text: string): Rec[] {
  if (text.length > MAX_IMPORT_BYTES) throw new Error('File is too large');
  let d: any; try { d = JSON.parse(text); } catch { throw new Error('File is not valid JSON'); }
  if (!d || d.app !== 'brainiac-os') throw new Error('This is not a Brainiac OS backup');
  if (d.schema !== SCHEMA) throw new Error(`Unsupported backup version ${String(d.schema)}`);
  if (!Array.isArray(d.records) || d.records.length > 5000) throw new Error('Backup records are invalid');
  const seen = new Set<string>();
  return d.records.map((r: unknown, i: number) => { try { const v = validateRecord(r); if (seen.has(v.id)) throw new Error('duplicate id'); seen.add(v.id); return v; }
    catch (e) { throw new Error(`Record ${i + 1}: ${(e as Error).message}`); } });
}

const STOP = new Set('what do does did we i you know knows about show me list tell give find search every all any the a an of is are our my on in for to us have has had recorded record information info regarding summarise summarize everything anything with and s t'.split(' '));
/** Turns a natural-language command into search keywords ("What do we know about Ultron?" -> "ultron"). */
export function cleanQuery(q: string): string {
  const words = q.toLowerCase().replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter(w => !STOP.has(w)); return (kept.length ? kept : words).join(' ');
}
export const matches = (r: Rec, q: string) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean); if (!words.length) return true;
  const hay = [r.name, r.kind, r.description, r.tags.join(' '), r.notes, r.source].join(' ').toLowerCase();
  return words.every(w => hay.includes(w) || (w.length > 3 && w.endsWith('s') && hay.includes(w.slice(0, -1))));
};

const S = 'User-supplied sample data';
const mk = (id: string, name: string, kind: Kind, description: string, links: string[] = []) =>
  newRecord({ id: 'sample-' + id, name, kind, description, source: S, confidence: 'user-reported', tags: ['sample'], links: links.map(l => 'sample-' + l) });
const mech = (id: string, name: string, description: string, links: string[]) => newRecord({ id: 'sample-' + id, name, kind: 'mechanic', description, source: S,
  confidence: 'user-reported', tags: ['sample', 'mechanic', 'needs-detail'], links: links.map(l => 'sample-' + l), notes: 'Name recorded as you supplied it; check the exact spelling.' });
export const sampleRecords = (): Rec[] => [
  mech('palladium', 'Palladium', 'The server uses Palladium for its abilities. Addons: Reordinary, FSang, Powerborne, plus some other custom abilities. The actual rules, power lists and limits are NOT recorded yet; add them so plans can use them.', ['env','reordinary','fsang','powerborne','custom']),
  mech('reordinary', 'Reordinary', 'Palladium addon used on the server. What it adds is not recorded yet.', ['palladium']),
  mech('fsang', 'FSang', 'Palladium addon used on the server. What it adds is not recorded yet.', ['palladium']),
  mech('powerborne', 'Powerborne', 'Palladium addon used on the server. What it adds is not recorded yet.', ['palladium']),
  mech('custom', 'Custom abilities', 'The server also has some other custom abilities. None are recorded yet.', ['palladium']),
  mk('pc', 'Prime Collective', 'faction', 'Faction that includes Brainiac, Ultron, Sentry, and a Kryptonian. Allied with the Red Lanterns.', ['brainiac','ultron','sentry','kryptonian','rl']),
  mk('brainiac', 'Brainiac', 'character', "The operator's own character. Member of Prime Collective.", ['pc']),
  mk('ultron', 'Ultron', 'character', 'Subordinate to Brainiac. Member of Prime Collective.', ['brainiac','pc']),
  mk('sentry', 'Sentry', 'character', 'Powerful, but intended to remain balanced. Member of Prime Collective.', ['pc']),
  mk('kryptonian', 'Kryptonian', 'character', 'Member of Prime Collective. Name not yet recorded.', ['pc']),
  mk('rl', 'Red Lanterns', 'faction', 'Allied with Prime Collective. Remain independent.', ['pc']),
  mk('env', 'Server environment', 'note', 'Modded Minecraft 1.20.1 superhero roleplay server with original characters and DC/Marvel characters. Brainiac OS is not connected to the server.'),
  mk('base', 'Space base', 'location', "The operator's Minecraft base is in space. Coordinates not recorded."),
  mk('industry', 'Industrial infrastructure', 'asset', 'Early development.', ['base'])];

/** Links that point at records which are not in the list (e.g. after restoring a partial backup). */
export const brokenLinks = (recs: Rec[]) => { const ids = new Set(recs.map(r => r.id)); return recs.flatMap(r => [...new Set(r.links)].filter(l => !ids.has(l)).map(to => ({ from: r.id, fromName: r.name, to }))); };
export const DIFF_FIELDS = ['name', 'kind', 'description', 'tags', 'source', 'confidence', 'status', 'links', 'notes'] as const;
/** Fields whose value differs between two versions of a record. */
export function diffFields(a: Rec, b: Rec): { field: typeof DIFF_FIELDS[number]; from: string | string[]; to: string | string[] }[] {
  return DIFF_FIELDS.filter(f => JSON.stringify(a[f]) !== JSON.stringify(b[f])).map(f => ({ field: f, from: a[f], to: b[f] }));
}
