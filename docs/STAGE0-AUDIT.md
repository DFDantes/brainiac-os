# Stage 0 audit (reconstructed from code reading)

**Status after Stage 3 (checkpoint 3):** A1-A4 addressed in Stage 1; A10 fixed in Stage 2 (Chromium-verified; real Vite output now also confirmed); **A5 (history UI), A6 (atomic save) and A7 (broken-link check/repair) addressed in Stage 3**. A5 remains partly open: history is still not included in or restored from backups. A8 accepted. A9 open (render loads everything; `listDeleted` reads the whole audit store, fine until thousands of entries). The table below is the original finding text.

Method: read all of `src/`, `worker/`, `public/sw.js`, config, docs and test names. Tests/build could not be run (no network). Severity = risk to user data.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| A1 | High | **Backups can become unrestorable.** `exportBackup` includes the whole `audit` store, which grows forever; `parseBackup` rejects text over 5,000,000 chars. A heavily used archive eventually exports a file its own restore refuses. Export never checks this. | `db.ts exportBackup`, `model.ts MAX_IMPORT_BYTES`, `parseBackup` |
| A2 | High | No `navigator.storage.persist()` request. Safari may evict site data for non-installed or long-unused sites; installed Home Screen apps are treated better but a request is still best practice. | no call in `src/` |
| A3 | Med | Restore replaces by id without comparing `modified`, so restoring an older backup overwrites newer local edits (old versions go to audit, but there is no UI to view or recover them). | `importRecords`, `restore()` |
| A4 | Med | No automatic snapshot before restore or "Erase all data" (`clearAll` also wipes audit and meta incl. last-backup time). Only a confirm + typing ERASE guards it. | `main.ts case 'clear'`, `db.clearAll` |
| A5 | Med | Audit history exists but has no UI and is not restored from backups (documented limit). | README Known limits |
| A6 | Low | `save()` reads the old record then writes in a separate transaction; two tabs could race. Single-user, low risk. | `db.save` |
| A7 | Low | Restored records' `links` are not checked for dangling ids (validator checks format only). | `parseBackup` |
| A8 | Low | Worker passphrase stored plaintext in IndexedDB `meta` (excluded from backups). Acceptable for the threat model; documented. | `main.ts savecfg` |
| A9 | Low | `render()` loads all records and meta on every action; audit unbounded. Fine now, watch at thousands of records. | `main.ts render` |
| A10 | Info | Service worker is cache-first with background refresh; update needs two reopenings (documented). Precache regex assumes `./` prefixed asset URLs from Vite `base: './'`. Unverified in a real browser. | `public/sw.js`, `vite.config.ts` |

## Positives worth preserving
Write promises resolve only on transaction commit; strict validation of all imported/looked-up data; https-only links; HTML escaping via `esc`; Worker fails closed, constant-time passphrase compare, origin allow-list; lookups never auto-save and are labelled unverified; no secrets in repo; CI runs tests before deploy.
