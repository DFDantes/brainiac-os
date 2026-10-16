> ARCHIVED COPY of the HANDOVER.md that shipped in checkpoint 4a (written before Stage 5). Kept unchanged below for history. Its roadmap section was a reconstructed PROPOSAL and is superseded by the five-stage roadmap in the current HANDOVER.md.

# HANDOVER — Brainiac OS

> **CHECKPOINT 4a (Stage 4 IN PROGRESS, not finished).** Done and tested: `src/voice.ts` (voice engine, 20 tests) and the Worker `/transcribe` endpoint (7 tests, Groq faked). **NOT done: the Voice Lab screen (`src/voicelab.ts`), UI wiring, real-Chromium check, docs.** The app UI is unchanged from checkpoint 3 (the chip still says VOICE NOT BUILT YET). Real results at this point: typecheck 0 errors, `npm test` 87/87 (was 60), build OK. Stage 1-3 verification below is from checkpoint 3 and was re-run independently at the start of this session (60/60, build OK).

**Checkpoint:** 3 (Stage 3: links UI, record history/restore, deleted-record recovery, broken-link repair, first DB migration). **Status: implemented; real `npm run typecheck`, `npm test` (60/60) and `npm run build` all passed; real-Chromium offline checks passed. NOT tested on an iPhone or in WebKit/Safari.**
**Date:** 2026-10-14. Earlier checkpoints: 0 (baseline/audit/roadmap), 1 (data safety), 2 (service-worker offline fixes). **Recovery point:** `brainiac-os-checkpoint-2-RECOVERY.zip` is the unmodified upload this session started from.

## How to resume in a fresh session
1. Unzip, read this file, `README.md`, `docs/STAGE0-AUDIT.md`.
2. `npm ci && npm run typecheck && npm test && npm run build` (all passed in checkpoint 3; if any fail, fixing that is the first task).
3. Optional real-browser checks (need global Playwright + Chromium, `export NODE_PATH=$(npm root -g)`): `npm run build && node tools/offline-verify/dist-check.cjs` (real build, offline, 10 checks) and `node tools/offline-verify/sw-check.cjs` (service worker, 7 checks). `tools/offline-verify/verify.sh` is the old no-network fallback and was **not** re-run or updated this checkpoint.
4. Then do "Exact next task".

## What the project is
Private, offline-first roleplay intelligence archive for a modded Minecraft 1.20.1 superhero server (Palladium + addons). Vanilla TypeScript + Vite PWA, no framework, no runtime dependencies. Data in IndexedDB on the device. Optional Cloudflare Worker proxy for online lookup (Modrinth, Wikipedia) and "Ask AI" (Groq). GitHub Pages hosting from a public repo (no secrets in it).

## Phase 2 verification (done at the start of this session, against the real files)
- Checkpoint 2 contains exactly what its handover said: only `public/sw.js`, tooling and docs changed after checkpoint 1; `src/` was unchanged.
- **Phase 2 is only half done by its own definition:** the service-worker part is complete; the iPhone-driven part (real-device fixes) is still open because no device results exist. The brief says Phase 2 was complete; the handover does not say that. Treat the device part as open.
- First-ever real toolchain results: `npm ci` OK; `npm run typecheck` 0 errors; `npm test` 46/46; `npm run build` OK (previous checkpoints could not run these).
- Closed an open handover item: the real Vite output (`dist/index.html`) uses `src="./assets/..."` / `href="./assets/..."` in double quotes, exactly what `sw.js` `filesOf()` expects. Confirmed again by `dist-check.cjs` (the real hashed bundle is in the offline cache).
- **The roadmap in this file is RECONSTRUCTED** (no original was ever supplied) and covers far less than the brief. See "Brief vs implementation" below.

## Architecture
| File | Role |
|---|---|
| `src/model.ts` | Types, `validateRecord`, backup (de)serialisation, search, sample data. **New:** `brokenLinks`, `diffFields`, `DIFF_FIELDS` |
| `src/db.ts` | IndexedDB `brainiac-os` **now v2** (stores `records`, `audit`, `meta`; v2 adds index `audit.recordId`). Migration is idempotent (works from fresh install and from v1). Backup format `SCHEMA` is separate and still 1. **New:** `recordHistory`, `listDeleted`, `restoreVersion`, `removeBrokenLinks`; `save` is now atomic (previous version read inside the write transaction); audit timestamps are monotonic |
| `src/lookup.ts`, `worker/index.ts` | Unchanged (online lookup / Ask AI) |
| `src/main.ts` | All UI. **New:** record detail view (Links to, Linked from, History), link picker in the edit form, Setup > Archive check, Setup > Deleted records |
| `public/sw.js` | Unchanged since checkpoint 2 (cache `brainiac-v3`) |
| `tests/` | `db` (25), `ui` (20), `worker` (14), `migration` (1) = 60 |
| `tools/offline-verify/` | `dist-check.cjs` (new, real build offline), `sw-check.cjs` (fixed timing flake), older `verify.sh` fallback |

## Stage 3: what changed and why
- **Detail view.** Tapping a record in ARCHIVE or COMMAND now opens a read-only detail screen (fields, Links to, Linked from, History, Edit button) instead of the edit form. After Save you land on that record's detail, not the list. Existing UI test "rejects an empty name" was adapted for this (switches to the ARCHIVE tab first); no assertion was weakened.
- **Links.** Stored one-way (`links` on the source record, unchanged model) and shown from both sides. Edit form: list of current links with Remove, search-by-name picker. Link changes live in the working copy and are persisted only on Save; typed text is preserved when links change (`capture()`). Enter in the link box is blocked so it cannot save the record. No self-links or duplicates; max 100 (validator limit). Links to missing records show as "Missing record" and can be removed.
- **History (A5, partial).** Per-record history from the audit store with a field-level diff (old to new, truncated to 140 chars). "Restore the version from before this change" calls `restoreVersion`: validates the stored version, drops links to records that no longer exist (and tells you how many), saves it as a normal edit, so the replaced version stays in history (reversible). Damaged entries are detected and refuse to restore. Newest 30 entries shown.
- **Deleted records.** Setup lists deleted records (one per record, newest first, max 20 shown) with Restore. Restoring does **not** recreate links other records had to it (they were removed at deletion; each is in that other record's own History).
- **Archive check (A7).** Reports links pointing at missing records; "Remove broken links" needs confirmation, takes a safety copy first, audits every change. Restore-from-backup also mentions broken links in its message. Nothing is ever auto-removed.
- **A6 fixed.** `save` reads the previous version inside the same transaction. The new concurrency test **fails against the old implementation** (checked by temporarily restoring it) and passes now.
- **DB migration v1 to v2.** Adds the `audit.recordId` index. `tests/migration.test.ts` builds a genuine v1 database with records, audit and meta, opens it with the current code and checks nothing was lost and the index exists. Upgrade runs on first open after the new bundle loads; if an old tab holds the old version open, the app reports "Database blocked by another tab".
- **Honest voice chip.** The old chip said `VOICE AVAILABLE` whenever `speechSynthesis` existed, although no voice feature exists, which the brief forbids. It now says `VOICE NOT BUILT YET`.
- Version bumped to 0.5.0 (`package.json` and lockfile root only). CI now also runs `npm run typecheck`.
- `sw-check.cjs`: S5 used a fixed 1.5 s sleep and failed intermittently (1 failure in 3 runs on this machine; `sw.js` is byte-identical to checkpoint 2). Replaced with polling up to 10 s. Afterwards 6/6 clean runs; against the previous release's `sw.js` it still fails 4 of 7, as it should.

## Files changed in checkpoint 3
Modified: `src/db.ts`, `src/model.ts`, `src/main.ts`, `tests/db.test.ts` (+6), `tests/ui.test.ts` (+7, 1 adapted), `package.json`, `package-lock.json` (version only), `.github/workflows/deploy.yml`, `tools/offline-verify/sw-check.cjs`, `README.md`, `HANDOVER.md`, `docs/STAGE0-AUDIT.md`. Added: `tests/migration.test.ts`, `tools/offline-verify/dist-check.cjs`. Unchanged: `public/*`, `worker/*`, `src/lookup.ts`, `src/style.css`, configs.

## Commands run in checkpoint 3 and ACTUAL results
| Command | Result |
|---|---|
| `npm ci` | OK (network available this time) |
| `npm run typecheck` (final code) | 0 errors |
| `npm test` (before changes) | 46/46 passed |
| `npm test` (final code) | **60/60 passed** (db 25, ui 20, worker 14, migration 1) |
| `npm run build` (final code) | OK. `dist/assets/index-*.js` 36.7 kB (13.3 kB gzip), CSS 3.07 kB |
| Mutation check: old non-atomic `save` | race test failed (1 failed, 24 passed), then code restored: 25/25 |
| `node tools/offline-verify/dist-check.cjs` (real build, real Chromium, offline) | **10/10 passed**: SW installed and cached the real bundle; offline reopen renders; records created, linked and edited offline; backlink and history shown; both records survive an offline reload; OFFLINE chip; no console/page errors |
| `node tools/offline-verify/sw-check.cjs` | 7/7 (6 consecutive clean runs after the timing fix); old sw.js: 3 passed, 4 failed (expected) |
| `npm audit` | 6 vulnerabilities (3 moderate, 1 high, 2 critical), all in **dev** dependencies (vite/esbuild/vitest/tinypool). Fixes require major upgrades (vitest 5, vite 8), **not applied**. `package.json` has no runtime dependencies. Practical risk: the esbuild advisory concerns the dev server, and `npm run dev` uses `--host`, so only run it on a trusted network |
| Final packaged ZIP: unzip to a clean folder, `npm ci`, typecheck, test, build | see "Package verification" at the end of this file |

## Verification log
| Date | Stage | typecheck | `npm test` | build | Browser checks | Notes |
|---|---|---|---|---|---|---|
| 2026-10-14 | 0 | not run | not run | not run | n/a | no network |
| 2026-10-14 | 1 | partial tsc | not run | not run | harness 46/46 | no network |
| 2026-10-14 | 2 | strict tsc w/ stubs 0 errors | not run | not run | harness 46/46; sw-check 7/7 | no network |
| 2026-10-14 | 3 | `npm run typecheck`: 0 errors | **60/60** | OK | dist-check 10/10; sw-check 7/7 (Chromium) | first session with npm access |

## Not verified (never claim otherwise without doing it)
Safari/WebKit and any physical iPhone (every README checklist line is still unticked, including the new Stage 3 list); service worker in WebKit; whether iOS grants persistent storage; the v1 to v2 database upgrade on a real iPhone (verified only with fake-indexeddb); live Modrinth/Wikipedia/Groq calls; Groq current model names, endpoint and free-tier limits (not checked this session; the sandbox network allow-list does not include them); Wrangler deploy; GitHub Actions run.

## Known issues
- Audit history is still not included in backups and not restored from them (A5 remainder). Restoring a deleted record does not recreate incoming links.
- A9: `render()` loads all records on every action; `listDeleted` reads the whole audit store (fine to thousands of entries; add an `action` index later if needed).
- Old oversized backups (over 5 MB) are rejected by restore.
- Dev-dependency advisories (see table). Old `verify.sh` harness is stale for the newer tests.
- Link model is one-way: deleting a record removes links to it from others (audited); there is no "relationship type" or per-link evidence yet.

## Brief vs implementation (gap table; the brief is the authority, the old reconstructed roadmap was not)
| Brief item | State after checkpoint 3 |
|---|---|
| A. Living Archive | **Partial.** Done: IndexedDB, migrations (v2), search, edit, links + related view, history/restore/recovery, backups with newer-wins merge + safety copy, validation. **Missing:** record kinds for ability, alliance, relationship, incident, technology, resource, objective, prediction (only 10 kinds); structured source URL and date fields (`source` is free text); evidence statuses "reported claim" and "conflict" (current: confirmed / user-reported / unverified / inference / unknown); per-record import conflict resolution (today: keep-newer rule + one confirm); history in backups |
| B. Coluan Interface | **Not built.** Only keyword search, Look up online, Ask AI. No create/update/link/summarise commands, response modes, persona, answer-to-record links, validated structured AI output, or confirmation flow |
| C. Voice | **Not built** (chip now honest). Explicit next stage, see below |
| D. Colossus | Not built (placeholder tab) |
| E. OMEGA | Not built (placeholder tab) |
| F. Strategic Timeline | Not built (placeholder tab) |
| G. Research | **Partial.** Worker lookup (Modrinth, Wikipedia) + Groq "Ask AI", results always labelled unverified. Endpoints/models/free tier unverified (see above). No multi-source conflict handling or 1.20.1 prioritisation yet |

## Roadmap (PROPOSAL for the user to confirm; the old reconstructed roadmap omitted most of the brief)
- Stages 1 and 3: done. Stage 2: service-worker part done, **device part open** (needs the user's iPhone checklist results; do not guess device fixes).
- **Stage 4 — Voice (explicit task, user priority).** Build a capability "voice lab" first: list the voices that really exist on the device (handle async `voiceschanged`), test-playback button from a user tap, rate/pitch, persisted locally; detect whether speech recognition actually works in the installed PWA by trying it, not by checking the API exists; mic button with visible listening state and transcript, mic released on stop/background/error; text and iOS keyboard dictation always available; separate honest status for TTS, recognition, upload transcription and playback, each labelled automated / simulated / real device. Research before depending on anything: current free neural TTS and server-side transcription options and their limits, and what iOS 15 Safari (the newest iOS an iPhone 7 can run, as far as I know; verify) allows in standalone mode. Any API key stays in the Worker, never in the bundle. Do not promise cinematic voice.
- Stage 5 — Archive model extension (kinds, structured sources/dates, evidence values, import conflict UI). Timeline, Colossus and OMEGA all read this, so it should precede them.
- Stage 6 — Coluan: command parsing and archive commands that work offline, then AI with validated structured output and confirmation for consequential writes.
- Stage 7 — Timeline (incl. predictions vs outcomes), Stage 8 — Colossus, Stage 9 — OMEGA.
- Reorder freely; each stage ends with tests, build, ZIP, HANDOVER and README.

## Exact next task
1. Ask the user to run the README iPhone checklists (Stage 1, Stage 2 and the new Stage 3 list) and report which lines fail. If results exist, fix those first; do not guess.
2. If the user cannot test yet, start Stage 4 step 1: the voice lab described above (capability probing + test playback + honest status, no AI changes), deployed so the user can run it on the iPhone 7 and report real results, before any recognition or neural-TTS dependency is chosen.

## Package verification (checkpoint 3 ZIP)
The draft ZIP (identical to the final one except for this section) was unzipped into an empty folder and run from scratch: `npm ci` (82 packages added) then `npm run typecheck` (0 errors), `npm test` (**60/60 passed**, 4 files) and `npm run build` (OK). The ZIP excludes `node_modules`, `dist`, `.env`, `.dev.vars`, `.wrangler` and other ZIPs; a pattern scan for API keys/private keys found nothing; the Worker reads `APP_PASSPHRASE` and `GROQ_API_KEY` only from Wrangler secrets. The ZIP was then rebuilt with this section and the final file was checked file-by-file against the verified draft (only `HANDOVER.md` differs).
