# Brainiac OS (v0.6, checkpoint 5: Colossus, OMEGA and Timeline)

> **Project status:** see `HANDOVER.md` (current checkpoint, real verification results, known issues, next task) and `docs/STAGE0-AUDIT.md`. Continue from there in any new session.

Private roleplay intelligence archive with a mission engine (COLOSSUS), a strategic project record (OMEGA) and a timeline. Installable on iPhone. Data stays on your device. Not connected to Minecraft, and it never reads anything from a game server: everything in it is what you typed.

**Honest status:** Stage 5 is implemented and was tested with a no-network fallback harness; `npm test` and `npm run build` have **not** been run on this code yet (do that first, see below). Nothing has been tried on a real iPhone. The Voice Lab screen and archive-record commands do not exist yet. Details: `HANDOVER.md`.

## Put it online and on your phone

1. **Install tools (once):** Node.js LTS from https://nodejs.org and Git from https://git-scm.com. Restart VS Code afterwards.
2. **Open the project:** unzip, then in VS Code choose File > Open Folder and pick `brainiac-os`.
3. **Run it:** open the terminal (Terminal > New Terminal) and run, in this folder:
   ```
   npm install
   npm run typecheck
   npm test
   npm run build
   npm run dev
   ```
   Open the address it prints to try the app on your computer. Requires Node.js 18 or newer (the project was checked with Node 22). Dependencies are dev-only (Vite, Vitest, TypeScript, jsdom, fake-indexeddb); there are no runtime dependencies.
4. **Create a GitHub repository:** at github.com click New repository, name it `brainiac-os`, choose **Public** (free GitHub Pages needs public), do not add a README, click Create.
5. **Upload the code** (replace YOUR-USERNAME):
   ```
   git init
   git add .
   git commit -m "Brainiac OS checkpoint 5"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/brainiac-os.git
   git push -u origin main
   ```
6. **Turn on the website:** on GitHub open the repo > Settings > Pages > under "Build and deployment" set Source to **GitHub Actions**. Open the Actions tab and wait for the green tick (about 1 minute). Your site is `https://YOUR-USERNAME.github.io/brainiac-os/`.
7. **Install on iPhone:** open that address in **Safari**, tap Share, Add to Home Screen, Add. Always open it from the Home Screen icon afterwards.

The repository is public, so never put secrets in it. This stage contains none.

## iPhone 7 checklist (not yet tested on a real device)
- [ ] Loads in Safari; Add to Home Screen works; opens full-screen
- [ ] Setup > Load sample data; records appear in Archive
- [ ] Add, edit, delete a record; force-close the app and reopen: still there
- [ ] Airplane mode, reopen: app opens, search works
- [ ] Setup > Prepare backup > Share / save file > Save to Files. If the share sheet fails, use "Show as text" and paste it into Notes
- [ ] Erase all data, then restore from the saved file (or paste the text): records return
- [ ] Setup > Load sample data: Palladium, Reordinary, FSang, Powerborne and Custom abilities appear, and the Command tab lists them under "Missing detail"
- [ ] Open the installed app once online, then turn on Airplane mode and fully close and reopen it: it must still open (first-time offline use is the main thing to verify)
- [ ] (Stage 2) After the site has been updated once (see "Updating the live site"), open the app online, then Airplane mode, fully close and reopen: it must still open and not be blank
- [ ] Tap Save twice quickly on a new record: only one record is created
- [ ] Keyboard does not hide the form fields; no sideways scrolling
- [ ] (Stage 1) The STORAGE chip appears (PROTECTED, NOT PROTECTED or UNKNOWN); note which one the iPhone shows
- [ ] (Stage 1) Setup > Erase all data, then Setup > Safety copy > Undo last restore / erase: records return
- [ ] (Stage 1) Restore an older backup after editing a record: the edit is kept and the message says records were "left unchanged"

## Stage 3 checklist: links and history (not yet tested on a real device)
- [ ] ARCHIVE > tap a record: a detail screen shows Links to, Linked from and History (no longer straight into the edit form)
- [ ] Edit a record: type in "Add a link", tap a result, then Save: the link appears and the record you linked now lists this one under Linked from
- [ ] In the edit form, tap Return on the keyboard while typing in the link box: it must NOT save the record
- [ ] Edit a record twice, open it: History lists both edits with what changed; "Restore the version from before this change" restores it and the replaced version stays in History
- [ ] Delete a record, then SETUP > Deleted records > Restore brings it back
- [ ] SETUP > Archive check says "No broken links" (or lists them and only removes them after you confirm)
- [ ] The first launch after this update may need two close-and-reopen cycles to load the new version (see "Updating the live site"); the database upgrades itself to version 2 on first open, and your records must all still be there

## Stage 5: missions, OMEGA and timeline
**COLOSSUS tab** — missions with objectives (progress is counted from objectives you tick; no objectives means no percentage), dependencies, risks, resources (your own notes), archive references. **OMEGA tab** — one strategic project: milestones, linked missions, hypotheses, options, decisions, lessons; progress is computed from what you recorded and contradictions are listed, never averaged away. **TIMELINE tab** — planned and recorded events; mission deadlines and OMEGA milestone dates appear automatically (read-only). A date that has passed makes a *planned* item OVERDUE; it never completes or changes anything by itself. Labels such as USER-ENTERED, SYSTEM-DERIVED and AI-SUGGESTED · UNVERIFIED show where each value came from.

**Commands** (COMMAND tab; type `help` for the full list; they work offline, no AI needed):
```
mission new Operation Nightfall priority=high due=2026-11-01
task add nightfall : scout the target
task done nightfall : #1
event add 2026-11-01 14:30 : Briefing @ nightfall
omega init            omega milestone add 2026-12-01 : Phase one @ nightfall
omega decide : Strike at night | fewer defenders online
```
Unclear or ambiguous commands change nothing and say why; deletions ask first and are recoverable from Setup > Recently deleted. Anything that is not one of these commands searches the archive as before (start with `search ` to force it). The mic button (if your browser offers speech recognition) only fills the box; you tap Run.

**Backup:** Setup > Prepare backup now includes missions, OMEGA and events; the safety copy and Erase all cover them too. There is no automatic cloud backup, so back up regularly: clearing this site's data in the browser deletes everything.

## Stage 5 iPhone checklist (not yet tested on a real device)
- [ ] COLOSSUS: create a mission, add 3 objectives, tick one: it shows 1 of 3 (33%); force-close and reopen: still there
- [ ] Deadline: pick a date with the date picker (and the Clear button works); a past deadline shows OVERDUE while the status stays as it was
- [ ] Add a dependency between two objectives: BLOCKED shows; no sideways scrolling with a very long title
- [ ] TIMELINE: add an event with a date and time; mark it done; delete it (mission remains)
- [ ] OMEGA: create the project, add a milestone linked to a mission, tick it: a conflict is shown if the mission is not completed
- [ ] COMMAND: `mission new Test`, `task add test : one`, then `mission delete test` asks for confirmation
- [ ] Airplane mode, fully close and reopen: missions, OMEGA and timeline still open and editable
- [ ] Setup > Prepare backup, Erase all data, restore it: missions, OMEGA and events return
- [ ] Mic button: note exactly what happens (it may not exist, may do nothing, or may fill the box); the app must never claim it worked when it did not
- [ ] After updating the live site, close and reopen twice (see "Updating the live site"); the database upgrades itself to version 3 and every earlier record must still be there

## Online lookup (new)
Follow `SETUP-LOOKUP.md` to deploy the free Cloudflare Worker, then use COMMAND > Look up online / Ask AI (web). Results are never saved automatically and are always marked unverified.
- [ ] Setup > Online lookup > Test connection says Connected
- [ ] COMMAND > type `Powerborne` > Look up online shows Modrinth results; Review & save opens a pre-filled form
- [ ] Airplane mode: lookup says you are offline, archive still works

## Updating the live site
After you push a change, GitHub rebuilds the site in about a minute. On the phone, fully close and reopen the app **twice** to get the new version (it opens instantly from cache, then refreshes in the background). Since Stage 2, the new version's files are downloaded before it replaces the old one, so going offline in between can no longer leave a blank app; if a download fails, you simply keep the old working version.

## Server rules (Palladium)
The sample data records, as *your* statements, that the server uses Palladium with the addons Reordinary, FSang, Powerborne and some custom abilities. Their actual mechanics are deliberately NOT filled in, because guessing would break plans. Add real details to those records (edit them in Archive) and OMEGA/Colossus will use them. Check the addon name spellings.

## What was checked (current, Stage 5)
See `HANDOVER.md` for the exact table. In short: a strict TypeScript check with stub typings found 0 errors; 178 automated tests passed through a Vitest-compatible shim (browser tests in real Chromium, date logic under six time zones); a fallback bundle was driven in Chromium at an iPhone-7-sized viewport (no overflow, offline reopen works, no secrets in the bundle). **Not run:** real `npm test`, real `npm run build`, Safari, any iPhone, live Groq/Modrinth/Wikipedia. The paragraph below is an older record from earlier checkpoints.
_(The paragraph below was written by an earlier session; current results are in `HANDOVER.md`. Later sessions had no npm access, so `npm test` / `npm run build` have not been re-run since; the real, current results are in the verification log in `HANDOVER.md`. In checkpoint 3 the real `npm run typecheck`, `npm test` (60 tests) and `npm run build` were run and passed; `tools/offline-verify/sw-check.cjs` (7/7) and the new `tools/offline-verify/dist-check.cjs` (10/10, real build, real Chromium, offline) also passed. Safari/WebKit and a physical iPhone are still untested. The older fallback `verify.sh` was not re-run and may not cover the newer tests.)_

Typecheck, build, and 34 automated tests (data layer, backup/import attacks, search, links, the Worker's security and error handling with faked upstream services, and a simulated-browser run of the screens). The Worker also bundles cleanly with Wrangler's dry run. Not checked by that session: a real browser, the service worker, the share sheet, a physical iPhone, and live calls to Modrinth, Wikipedia and Groq (my sandbox cannot reach them). Groq's `executed_tools` source format and free-tier access to `groq/compound` are unverified.

## Links, history and recovery (Stage 3)
- Open a record to see what it links to, what links to it, and its history. Links are one-way records (A links to B) shown from both sides.
- Every change is kept in the record's History with what changed. "Restore the version from before this change" makes that version current again; the version it replaces stays in History, so you can switch back.
- Deleted records can be restored from Setup > Deleted records. Setup > Archive check finds links that point at missing records and removes them only when you confirm.
- The local database is now schema version 2 (adds an index for history). It upgrades in place on first open; nothing is deleted. Backup files are unchanged (format version 1) and old and new backups are interchangeable.

## Backups and the safety copy (Stage 1)
- Backup files hold your records only. The change history is not included (restore never used it, and it grows without limit). If a backup would be too big to restore (over 5 MB or 5000 records) the app says so instead of creating it.
- Restoring a backup merges by ID and **keeps any record that is the same age or newer on this device**; it asks before replacing older ones.
- Before a restore that changes something, and before Erase all data, the app keeps one automatic safety copy of your records (Setup > Safety copy > Undo). Erase all data keeps this copy on purpose; use Discard safety copy to remove it too. The safety copy lives in the same browser storage as your data, so it is not a replacement for saving a backup file regularly.

## Known limits
- Backup restore merges records by ID; it does not restore the audit history. A very old backup that already contains a large history (over 5 MB) is rejected by restore.
- Backups do not carry history, and restoring a deleted record does not recreate the links other records had to it (those were removed when it was deleted; each is in the other record's own History).
- Colossus, OMEGA, Timeline, AI chat, voice and mic are not built yet. Voice is the next planned stage (see HANDOVER.md).
