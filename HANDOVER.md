# HANDOVER — Brainiac OS

> **CHECKPOINT 5 (2026-10-15).** The three Stage 5 modules (Colossus Mission Engine, Project OMEGA, Strategic Timeline) are **implemented, wired into the archive, the command box and the voice hooks, and tested** with the no-network fallback harness. **Stage 5 is NOT declared complete**, for three reasons that are stated plainly here and not hidden in the details:
> 1. **The real toolchain never ran.** This session had no network: `npm ci`, `npm run typecheck`, `npm test` (real Vitest/jsdom) and `npm run build` (real Vite) were **not run**. Results below come from a strict `tsc` check with stub typings, a Vitest-compatible shim run in real Chromium/Node, and an esbuild fallback bundle. Run the four real commands first (see "How to resume").
> 2. **Stage 2 and Stage 4 of the roadmap are only partly present in the supplied project** (see "State of the roadmap"). Stage 5 integrates with what exists; it does not pretend the rest exists.
> 3. **Nothing was tested in Safari/WebKit or on a physical iPhone.**

## The roadmap (the user's original; do not change it)

The project has exactly five numbered stages, followed by a final integration and deployment audit.

**Stage 1 — Living Archive Hardening**
- Establish a reliable, persistent archive and knowledge store.
- Strengthen data integrity, organization, retrieval, error handling, and preservation.
- Ensure the archive remains useful without AI or an internet connection.

**Stage 2 — Coluan Command Engine and Brainiac Persona**
- Build the command interface, command processing, and Brainiac-inspired personality.
- Provide consistent responses, useful system feedback, and coherent interaction patterns.
- Integrate with the archive rather than operating as an isolated interface.

**Stage 3 — Research and Groq AI Integration**
- Add research capabilities and Groq-powered AI integration where configured.
- Preserve a functional offline experience.
- Handle missing API keys, unavailable providers, network errors, rate limits, and malformed responses gracefully.
- Keep secret credentials out of browser code, public assets, exported ZIPs, and source control.

**Stage 4 — Voice System**
- Add voice input and speech output using capabilities supported by the user's browser and device.
- Provide typed-input and text-output fallbacks.
- Report capability limitations honestly and avoid pretending a voice action succeeded when it did not.
- Keep voice integrated with the existing command engine and archive.

**Stage 5 — Colossus Mission Engine + Project OMEGA + Strategic Timeline**
- Implement all three modules as one unified stage.
- Integrate them with the existing archive, command engine, AI/research integration, and voice system.
- Do not split Stage 5 into additional numbered stages.

**After Stage 5 — Final Integration, Security, Mobile/PWA, Documentation and Deployment Audit**
- This is a final audit, not Stage 6.
- Test integration, security, persistence, mobile layout, PWA behavior, offline fallbacks, and packaging.
- Document any limitations and any tests that could not be performed.

**Naming warning:** earlier handovers used "Stage 1/2/3" for *checkpoint* work (data safety, service-worker offline fixes, links/history) and a reconstructed roadmap that differed from the one above. Those numbers were checkpoint labels, not roadmap stages. The archived old handover is `docs/HANDOVER-checkpoint-4a.md`.

## State of the roadmap, judged from the code (not from earlier documents)

| Roadmap stage | State in this ZIP | Honest gaps |
|---|---|---|
| 1 Living Archive | **Implemented** (IndexedDB, validation, backups with safety copy, history/restore, deleted-record recovery, links, offline use). DB is now v3. | Record kinds are still the original 10; `source` is free text; no per-record import conflict UI; audit history not in backups (see Known issues). |
| 2 Coluan + persona | **Partial.** Before this session there was only keyword search + Look up online + Ask AI. This session added a deterministic command engine (`src/coluan.ts`) for missions, objectives, timeline events and OMEGA, with a terse "ACK / REJECTED / NOT FOUND / AMBIGUOUS / CANCELLED" voice. | No commands to create/edit/link **archive records**; no response modes or richer persona; no AI-parsed natural language or validated structured AI output. Anything that is not a Stage 5 command still runs the old archive search. |
| 3 Research + Groq | **Implemented, live behaviour unverified.** Worker `/lookup`, `/ask`, `/health`; keys only in Wrangler secrets. | Live Modrinth/Wikipedia/Groq calls, model names and free-tier limits were never checked (no network). |
| 4 Voice | **Partial (checkpoint 4a state + basics).** `src/voice.ts` engine (20 tests, fakes) and Worker `/transcribe` (7 tests, Groq faked) existed. This session added a basic **mic button** (fills the command box, never executes) and **Read last reply aloud** on the Command tab, with honest outcome messages. | The **Voice Lab** screen (`src/voicelab.ts`), voice preferences UI, server-side transcription UI and any real-device result do **not** exist. Voice has never been tried on a phone. |
| 5 Colossus + OMEGA + Timeline | **Implemented and fallback-tested** (below). | See "Known limitations". |

## What Stage 5 added

### Colossus Mission Engine (COLOSSUS tab)
Create, view, edit, duplicate, archive/unarchive, delete missions; title, objective, description, status (planned/active/paused/completed/cancelled), priority, optional deadline, tags, notes. Objectives with complete/reopen, reorder, notes, dependencies (blocked state shown; loops refused). Risks/constraints/assumptions with mitigation and fictional resources, both labelled USER-ENTERED. Archive references via a search picker. Dashboard counts, search, status filter, sort, archived filter. Progress = done objectives / total objectives; a mission with no objectives shows **no figure** (never 0% or 100%). A passed deadline shows OVERDUE but never changes status.

### Project OMEGA (OMEGA tab)
One project record (name, purpose, status, priority, constraints, notes, lessons). Milestones (target date, done, linked mission, notes), linked missions, hypotheses (each tagged USER-ENTERED or AI-SUGGESTED · UNVERIFIED, with the user's own confidence label), strategic options and fallback plans, decisions with rationale and lesson, archive references. **Metrics** (SYSTEM-DERIVED): milestone percentage and linked-mission objective percentage, each `null`/"no figure" when there is no data; **conflicts** (milestone done but mission not completed, or the reverse) and missing linked missions are listed instead of averaged away. A panel reports how many Palladium/addon "mechanic" archive records exist and which are still marked `needs-detail`. It does not predict anything. Ask-AI answers can be added only as an AI-suggested, unverified hypothesis.

### Strategic Timeline (TIMELINE tab)
Events: title, description, date (required), optional time, category (milestone/deadline/operation/review/history/other), priority, status (planned/done/cancelled), optional links to a mission and an OMEGA milestone. A `history` event must be done/cancelled. Groups: Overdue, Today, Upcoming, Done/history, Cancelled; filters for state, category, text. **Derived entries**: mission deadlines and OMEGA milestone target dates appear automatically as read-only SYSTEM-DERIVED rows, computed at display time and never stored, so edits cannot leave duplicates or stale copies. Overdue = planned (not done/cancelled) and date (or time today) is in the past. All dates are local `YYYY-MM-DD` strings; no UTC conversion.

### Coluan commands (COMMAND tab)
`mission new|list|show|set|archive|unarchive|delete|summary`, `task add|done|reopen|delete|depend|list`, `event add|list|done|reopen|delete`, `omega` / `init|set|milestone add|done|reopen|link|unlink|decide|hypothesis`, `help`. Full syntax: type `help` or see `HELP` in `src/coluan.ts`. Names match on any unique part of the title (quote it if it contains a colon); ambiguous or missing matches change nothing and say why; destructive commands ask for confirmation; "ACK" is only produced after the write committed **and was read back from storage**. Anything not starting with these verbs runs the old archive search; prefix `search ` to force an archive search for words that start with a command verb.

### Voice (COMMAND tab, basic)
`🎤 Speak a command` appears only if the browser exposes speech recognition; it fills the command box and says "Nothing has been executed". Nothing runs until you tap Run. Microphone permission is requested only when you tap it. Refusal, no-speech, nothing-started (common in installed iPhone apps) and unsupported each have their own message. `🔊 Read last reply aloud` appears only if speech synthesis exists and reports whether speech actually started. The status chip says VOICE UNVERIFIED / UNSUPPORTED HERE until a real session produced text this session.

## Data model and storage
- IndexedDB `brainiac-os` **v3**. v2→v3 is additive: stores `missions`, `omega` (single record, id `omega`), `events` are created; existing stores are not touched. Proven by `tests/migration.test.ts` (v1→v3) and `tests/migration-v2.test.ts` (v2 with data and a safety copy → v3).
- Objectives, risks and resources are **embedded in their mission** (progress and blocking can never drift from a separate copy). Milestones, hypotheses, options, decisions are embedded in the OMEGA record. Relationships are by id: mission/OMEGA → archive record ids; event → mission id and OMEGA milestone id; OMEGA → mission ids.
- Every read validates (`src/ops.ts`). A damaged stored item is **counted and skipped, never deleted**; the UI says so. Writes validate first. Read-modify-write uses one transaction (`mutate`), proven against 12 simultaneous updates.
- Deleting a mission keeps its events (unlinked) and clears the OMEGA link; deleting an event or OMEGA never touches missions. Deleted missions/events/OMEGA go to a **recoverable trash** (meta key `opsTrash`, newest 25; Setup > Recently deleted). Links other items had to a restored item are not recreated.
- Deleting an **archive record** does not touch missions; references to it show as "Missing archive record" and Setup lists them; "Remove broken references" asks first and removes only the reference.
- **Backups** now carry an optional `ops` section (`schema` stays 1, so old backups restore and old builds ignore it). Restore merges by id with a newer-or-equal local copy always winning, shows a plan first, takes a safety copy. The **safety copy** and **Erase all** now include/clear missions, OMEGA and events; an old safety copy without them restores records and leaves current missions alone.
- **Not in a per-item history:** mission/OMEGA/event edits are not written to the archive audit trail (only deletions are recoverable via the trash, and backups). Data is local to the device; clearing site data deletes it, so use backups.

## How the three modules connect
Mission ↔ Archive (references, "Used by" on the record detail) · Mission ↔ OMEGA (project links, milestone links, progress feed) · Event ↔ Mission/OMEGA milestone (links) · Timeline ← Mission deadlines and OMEGA targets (derived rows) · Command box → same storage functions as the buttons · Ask AI → OMEGA (AI-suggested hypothesis) · Voice → Command box (text only). One storage layer; no second copy of any record.

## Files changed
New: `src/ops.ts` (model, validation, dates, progress, metrics, integrity), `src/coluan.ts` (commands), `src/opsui.ts` (screens, command panel, voice hooks, Setup panel), `tests/ops.test.ts`, `tests/opsdb.test.ts`, `tests/coluan.test.ts`, `tests/opsui.test.ts`, `tests/migration-v2.test.ts`, `tools/offline-verify/esbuild-dist.sh`, `tools/offline-verify/stage5-check.cjs`, `docs/HANDOVER-checkpoint-4a.md`.
Modified: `src/db.ts` (v3, ops storage, trash, backup/safety/erase), `src/model.ts` (optional `ops` in `Backup` type only), `src/main.ts` (wiring, restore, voice chip, Setup panel, "Used by", Run button), `src/style.css` (additions only), `tests/ui.test.ts` (**two assertions adapted**, see below), `tests/migration.test.ts` (v3 expectation), `tools/offline-verify/verify.sh`, `vitest-shim.js`, `package.json`/lockfile (version 0.6.0), `README.md`, `HANDOVER.md`.
Unchanged: `public/*` (service worker still `brainiac-v3`), `worker/*`, `src/lookup.ts`, `src/voice.ts`, configs, CI.
**Existing tests adapted (nothing weakened):** `ui.test.ts` line "omega tab" asserted the old "Not built yet" placeholder, now asserts the real empty state; the "voice chip" test asserted `VOICE NOT BUILT YET`, now asserts `VOICE UNVERIFIED|UNSUPPORTED HERE` and still forbids `VOICE AVAILABLE`.

## Commands used and ACTUAL results (this session, no network)
| Check | Result |
|---|---|
| `npm ci`, `npm run typecheck`, `npm test` (real Vitest), `npm run build` (real Vite) | **NOT RUN** (npm registry unreachable: ENOTFOUND). Must be run on the laptop. |
| Strict `tsc` (global TypeScript 6.0.3, `strict: true`) over `src`, `tests`, `worker` with stub typings for vite/vitest/fake-indexeddb | **0 errors**. Not the same as `npm run typecheck` (different TypeScript version, stubbed libraries). |
| `bash tools/offline-verify/verify.sh` (compiles with tsc, runs tests through a Vitest-compatible **shim**; browser files in **real Chromium 141**, Node files in Node 22) | **Browser: 137 passed, 0 failed** = db 25, ui 20, ops 26, opsdb 16, coluan 29, opsui 19, migration 1, migration-v2 1. **Node: 41 passed, 0 failed** = worker 21, voice 20. **`ops` also run under 6 time zones** (UTC, Pacific/Kiritimati, Pacific/Auckland, Australia/Sydney, America/Los_Angeles, Pacific/Pago_Pago): 26/26 each. Unique tests: 178 (checkpoint 4a: 87). The shim's `expect` is simpler than Vitest's and jsdom is replaced by Chromium's DOM. |
| Mutation checks (break a rule on purpose, confirm tests fail, restore) | (1) delete mission also deletes its events → 2 tests failed; (2) command engine claims success without read-back → at least 3 failed; (3) overdue ignores completion → at least 3 failed. All restored and re-verified. |
| `tools/offline-verify/esbuild-dist.sh` (fallback bundle, esbuild 0.27.7, target **safari15**) | Built `dist/` (128 kB JS). **This is not `vite build`.** The project's `safari14` target was not exercised (this esbuild refuses to downlevel destructuring for safari14; Vite 5.4's pinned esbuild did not, per checkpoint 3). |
| `node tools/offline-verify/stage5-check.cjs` (fallback bundle, real Chromium, iPhone-7-sized viewport 375×667, touch, DPR 2) | **29/29 passed**: all seed commands ACK; no horizontal overflow and every control ≥40px tall on Command, Colossus list, mission detail, OMEGA, Timeline, Archive, Setup and both new forms; service worker installed; **offline reopen** shows saved missions; a mission created offline survives an offline reload; archive search works offline; **no API-key/private-key patterns in the bundle**; no console or page errors. Screenshots reviewed by eye for mission detail and OMEGA. |
| `node tools/offline-verify/dist-check.cjs` and `sw-check.cjs` (existing checkpoint-3 checks, against the fallback bundle) | **10/10** and **7/7** (no Stage 1–3 regression in the bundle). |
| `npm audit` | **NOT RUN.** Checkpoint 3 recorded 6 dev-dependency advisories; nothing changed in dependencies. |

## Not verified (never claim otherwise without doing it)
Real `npm test`/`vite build`/`npm run typecheck`; Safari/WebKit; any physical iPhone (every README checklist line, including the new Stage 5 list, is unticked); the real iOS PWA service worker; iOS date/time input behaviour (the Clear button exists because iOS has no native clear for date inputs; unverified); microphone/speech on iOS (never tried, only faked); the v2→v3 upgrade on a real phone (verified with real Chromium IndexedDB and fake-indexeddb only); live Modrinth/Wikipedia/Groq; Wrangler deploy; GitHub Actions run; screen-reader use; colour-contrast measurement.

## Known limitations and bugs
- Roadmap Stage 2 and Stage 4 gaps above. No archive-record commands; no Voice Lab.
- One OMEGA project only. Timeline has no recurring events, no time-zone field (a date/time is the device's local wall clock), no calendar-grid view, no drag-and-drop. Mission/objective/OMEGA edits have no per-item history (deletions are recoverable; backups include everything).
- Natural-language commands are not parsed: commands are exact verbs with free-text arguments. A mistyped verb (`mision new`) falls through to the archive search.
- Restoring from the trash does not recreate links other items had to the restored item.
- Backups over 5 MB are refused (existing limit); the new `ops` section counts toward it.
- `verify.sh`'s shim cannot prove real Vitest/jsdom behaviour. The UI test file is written for jsdom as well, but that run has not happened. If a real-Vitest failure appears, treat it as a real finding: likely suspects are jsdom's `FormData`/date-input behaviour and `window.scrollTo`.
- Dev-dependency advisories from checkpoint 3 remain.

## Optional backend deployment
Unchanged. Stage 5 needs **no** backend. Ask AI / Look up online / transcription still need the Cloudflare Worker described in `SETUP-LOOKUP.md` (secrets `GROQ_API_KEY` and `APP_PASSPHRASE` via `wrangler secret put`; never in the repo). Do not claim hosted AI works until it is deployed and `Setup > Online lookup > Test connection` says Connected.

## How to resume
1. Unzip; open the folder `brainiac-os` in VS Code (File > Open Folder). Read this file and `README.md`.
2. `npm ci && npm run typecheck && npm test && npm run build`. **This has never been run on the Stage 5 code. If anything fails, fixing it is the first task** (see the real-Vitest note above).
3. Optional real-browser checks (global Playwright + Chromium, `export NODE_PATH=$(npm root -g)`): `npm run build && node tools/offline-verify/dist-check.cjs && node tools/offline-verify/sw-check.cjs && node tools/offline-verify/stage5-check.cjs`. Without network: `tools/offline-verify/verify.sh` and `tools/offline-verify/esbuild-dist.sh` (fallbacks).
4. Run the README iPhone checklists and report which lines fail; fix those, do not guess.

## Recommended next action
Run step 2 and the iPhone checklists, then decide deliberately about the two partial roadmap stages (2 and 4) **before** the Final Integration, Security, Mobile/PWA, Documentation and Deployment Audit. That audit is the step after Stage 5 (it is not "Stage 6"), but it should not be signed off while Voice Lab and the archive commands are missing unless you consciously accept those gaps.
