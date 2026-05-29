# Catalyst Building Walk — Engineering Handoff for Claude Code

> Audience: a developer using Claude Code who was **not** in the design conversation.
> This document has two parts:
> - **Part A — Work in progress** (§1–§6): what was just changed, why, and what to do next. Read this first.
> - **Part B — Canonical project reference** (§7): the owner's full project notes (authoritative source of truth for URLs, buildings, deploy workflows, and history).

---

# PART A — Work in progress

## 1. The two goals this handoff addresses

| Goal | Status |
|---|---|
| **A. Reliably save in-progress inspections** | **Largely fixed in this bundle** (client-side). See §2. |
| **B. Make automatic emails work reliably** | **Backend now in bundle** (`google-apps-script.js` v2.1). Root cause is size/timing/idempotency, not a code bug. One app-side fix made (honest delivery status); full plan in §3. |
| **C. "Optimize the code"** | Backlog in §4. |

> Confirmed real-world incident from the owner's notes: an **Aspen caretaker lost a Royal Oak walk** when iOS Safari purged storage mid-walk. The §2 fixes directly target this class of failure.

---

## 2. What was ALREADY changed in this bundle (client-side) — verified

These edits are live in this bundle's `index.html` and `sw.js`. They are surgical and additive. All are in the `// ── AUTOSAVE ──` region (~line 947+) unless noted. **Verified by save/restore + IndexedDB round-trip in a desktop browser — still MUST be retested on real iPhone/iPad (§5).**

1. **Flush-on-background — the #1 data-loss fix.**
   New `flushSaveNow()` + listeners on `visibilitychange`(hidden), `pagehide`, and `freeze`. iOS freezes/kills a PWA the instant the user switches apps, locks the screen, or opens the camera — often **before** the old 1-second photo debounce fired. iOS does **not** dispatch `beforeunload`, so we rely on `visibilitychange`/`pagehide`. On the way out we synchronously write `localStorage` and kick the IndexedDB photo write (the IDB transaction is allowed to finish during suspension).

2. **Photos persist immediately, not on a 1s debounce.**
   New `persistAfterPhotoChange()` is now called by `addPhoto()` and `removePhoto()` instead of the debounced `saveProgress()`. A photo is a deliberate, infrequent, high-value action — no reason to debounce it. Rapid comment *typing* still debounces (correct).

3. **Resume banner now also offers prior-day in-progress walks.**
   `checkForSavedProgress()` previously only showed "Resume Walk" when `saved.date === todayISO` (per the original design). A walk started in the evening and finished the next morning **silently vanished from the UI** even though the data was safe in localStorage. It now offers any in-progress walk for the selected building, labelled "— earlier session" when not today.
   ⚠️ *This is a deliberate behavior change from the owner's original "today only" intent. Keep it (it prevents data loss), but be aware.*

4. **Storage-full failures are surfaced, not silent.**
   New `notifyQuotaProblem()` + `writeTextSave()` return value. Previously a `QuotaExceededError` was swallowed and the UI still said "Progress saved." Now the caretaker is warned once and told to send the report immediately. (Directly relevant to the Aspen/Royal-Oak loss.)

5. **DRY refactor:** the save payload is built in one `buildSaveData()` used by `saveProgress`, `manualSave`, and the flush path, so they can't drift apart.

6. **Latent bug fixed** in `startWalk()` restore: `state.touched[key] = savedData.touched[key] || true` could throw if `savedData.touched` was absent and was always-true anyway → now `= true` when a comment exists.

7. **`sw.js` cache bumped** `catalyst-walk-v3` → **`v4`** so installed devices receive these fixes through the existing in-app "Update Available" banner. (Deploy per §7 workflow.)

8. **Honest email-delivery status (email path, not save).** `dialogAutoEmail()`'s success handler now reads `result.emailStatus` from the GAS response and tells the caretaker when the report was **too large to attach and went as a Google Drive link** instead of silently saying "Sent." See §3 #3.

---

## 3. Goal B — Automatic email: diagnosis & plan

> ✅ **The Google Apps Script backend is now in this bundle: `google-apps-script.js` (v2.1).** Reviewed in full. The GAS code is well-written and defensive — it saves to Drive *first*, then emails (with a >24 MB → Drive-link path), then logs to the Sheet, and returns `{ success, emailStatus, pdfUrl }`. **There is no logic bug in the GAS.** That means the "inconsistent delivery" is a **size + timing + idempotency** problem in the pipeline, not a code error. Here is the real picture:

### Confirmed root causes (in priority order)

1. **PDF size — the smoking gun.** Photos are captured at **1600 px / JPEG 0.85** (`addPhoto()` in `index.html`), and `generatePDF()` embeds each one in the appendix. jsPDF stores the JPEG bytes as-is, so a 30–40-photo walk produces a **~10–20 MB PDF**. That lands squarely in the owner's observed ">10 MB → GAS times out" zone and near the **24 MB → link-only** threshold. Big PDFs mean: a big base64 POST through the Worker, slow `base64Decode` + Drive upload + attach in GAS, and a real risk of exceeding the app's 90 s `AbortController` or the Worker's response window.
   - **Fix (client, highest leverage):** lower capture to **~1280 px / JPEG ~0.65** in `addPhoto()` (the `MAX = 1600` / `toDataURL('image/jpeg',0.85)` line). 1280 px is still sharp at the PDF's ~7-inch content width. This roughly **halves** PDF size and makes the whole pipeline fast and reliable. ⚠️ *This slightly reduces stored photo resolution — get the owner's sign-off (he's detail-oriented about quality) before shipping. Alternatively, keep capture quality high and recompress only the appendix copies at PDF-generation time.*

2. **No idempotency → duplicates and "did it send?" confusion.** If GAS actually completes (~12 s) but the response is slow enough that the app's 90 s timer fires or the Worker drops the connection, the app shows "failed" — **even though the email already went**. The caretaker then taps **Retry** or uses the manual Gmail fallback → the PM gets **two reports**, and a duplicate Drive file + Sheet row. This is the most likely source of the "inconsistent" *perception*.
   - **Fix (GAS + app):** add a `submissionId` to the payload (e.g. `buildingKey + walkDate + caretaker`). In `doPost`, before sending, scan the last N rows of the Sheet (or a cache) for that `submissionId`; if found within, say, 30 min, **skip the resend** and return `{ success:true, emailStatus:'duplicate_skipped', pdfUrl }`. Eliminates double-sends on retry.

3. **The app used to mask the outcome (now partially fixed in this bundle).** GAS returns `emailStatus` = `sent_with_attachment` / `sent_link_only` / `fallback_link_sent` / `all_failed`, but the app previously showed "✓ Report sent" for everything. **Fixed here:** `dialogAutoEmail()`'s success handler now reads `result.emailStatus` and tells the caretaker when only a **Drive link** was emailed (too large to attach). Claude Code should extend this to also log/show `pdfUrl`.

4. **Deployment hygiene (verify, don't assume).** GAS must be **Execute as: Me / Access: Anyone**, and **redeployed as a New version** after any edit (the URL stays constant — see §7). `doGet` returns `{status, version:'2.1'}`, so hit the Worker with a GET to confirm the *deployed* version matches the file before debugging anything else.

5. **Stale app builds.** Owner reports some devices run pre-proxy versions that "won't update unless reinstalled." The `v4` cache bump + update banner helps; worst cases need uninstall/reinstall.

6. **MailApp quota** (consumer Gmail ≈100/day, Workspace ≈1500) — unlikely at 7 buildings/day but `MailApp.getRemainingDailyQuota()` is worth logging to the Sheet.

### What Claude Code should do for Goal B (ordered)
1. Hit the Worker `GET` → confirm `{status, version:'2.1'}` comes back (proves app→Worker→GAS path + correct deployment).
2. Implement **idempotency** (#2) — biggest reliability win, zero downside.
3. Implement **PDF size reduction** (#1) — after owner sign-off on photo quality.
4. Reproduce a failure and read the **GAS Executions log** + the new `emailStatus` to confirm which stage fails.
5. Consider returning richer errors and surfacing `pdfUrl` in the app so a caretaker always has a fallback link.

---

## 4. Backlog — "optimize the code" / hardening

**Reliability (server-independent):**
- [ ] `navigator.storage.estimate()` → warn proactively as the quota fills (before it errors).
- [ ] Persistent "⚠️ Not saved" indicator when a write fails.
- [ ] Consider a single source of truth (move comments into IndexedDB too; localStorage's ~5 MB cap already bit this project once).
- [ ] Manual **export/import of a walk as JSON** — an escape hatch caretakers can use to back up before a risky moment.

**Performance:**
- [ ] Store photos as `Blob`s in IndexedDB rather than base64 data URIs (less memory + storage; convert only at PDF time). On low-end iPads a long walk holds every photo in memory + IDB + the PDF.
- [ ] The walk screen is built as one big HTML string + `innerHTML`. Fine now; incremental DOM updates if it grows.

**Maintainability (biggest readability win):**
- [ ] Split the single ~280 KB `index.html` into `index.html` + `app.js` + `styles.css` + `buildings.js` (the `BUILDINGS` config is the largest block).
- [ ] The fire-safety section is duplicated 7× (once per building) and must be edited identically each time — extract building/section data to JSON to kill the duplication. (See owner's §7 "Modifying the fire safety section".)

**Do NOT** introduce a build step or framework rewrite unless the team asks — the app's strength is a single static file that runs offline.

---

## 5. On-device test checklist (must pass on real iOS before shipping)

1. Start a walk, add a comment + photo, **lock the phone / switch apps**, reopen → comment **and** photo survive.
2. Add a photo, **immediately** (within 1s) switch to the camera/another app → photo survives. *(Exact bug the flush fix targets.)*
3. Start a walk in the evening, fully close the app, reopen **next day** → "Resume Walk — earlier session" appears and restores everything.
4. Simulate full storage → caretaker sees the "storage full" warning, not a silent loss.
5. Email a **small** and a **large (30-photo)** walk → both reach the PM; large one clearly indicates if it fell back to a Drive link; on failure the walk is preserved and the Gmail fallback works.
6. Accept the "Update Available" banner (deploy `v4`) → reloads without losing an in-progress walk.

---

## 6. Files in this bundle

| File | Role |
|---|---|
| `index.html` | The entire app. **Contains the §2 fixes.** |
| `sw.js` | Service worker. Cache bumped to `v4`. |
| `manifest.json`, `icon-192.png`, `icon-512.png` | PWA manifest + home-screen icons. |
| `cloudflare-worker-proxy.js` | The CORS-shim Worker (app → GAS). Deploy to the `walk-proxy` Worker. |
| `google-apps-script.js` | **Included (v2.1).** The email/Drive/Sheet backend. Paste into the `Building Walk Emailer` Apps Script project; redeploy as a new version. |
| `PROJECT_NOTES.md` | This file. |

---
---

# PART B — Canonical project reference (owner's notes)

> Verbatim from the project owner (Blake Forsyth). Authoritative for URLs, buildings, deploy steps, and history. Where it conflicts with Part A, Part A reflects newer changes (noted inline above).

## Overview

A mobile-first PWA (Progressive Web App) for caretakers at Catalyst Community Developments Society to perform daily building inspections. Generates branded PDF reports that get emailed directly to property managers, saved to Google Drive, and logged in a Google Sheet.

**Owner:** Blake Forsyth, Senior Property Manager, Catalyst Community Developments Society (blake@catalystcommdev.org)

**Stack:**
- Frontend: Single HTML file with embedded CSS/JS, served as a PWA via Cloudflare Pages
- Email/storage backend: Google Apps Script (via Cloudflare Worker proxy for CORS)
- Photo storage: IndexedDB on device
- Text data storage: localStorage on device

## URLs and Deployment

| Component | URL |
|-----------|-----|
| Live app | https://catalyst-walk.pages.dev/ |
| Cloudflare Worker proxy | https://walk-proxy.blake-724.workers.dev |
| Google Apps Script | https://script.google.com/macros/s/AKfycbxGNVQDhOrwzoJY26XnqwXnRTNAVtnfEP7uvRfxhnYy0b-PmwdlFrTGQBHGQA_ataig6Q/exec |
| Cloudflare Pages direct deploy | https://dash.cloudflare.com/72476549ace571d0ea50ae2f6f25879d/pages/view/catalyst-walk/deployments/new |
| Google Drive folder | "Building Walk Reports" (auto-created by setup() function) |
| Google Sheet log | "Building Walk Log" (auto-created by setup() function) |

## File Structure

```
building-walk-app/
├── pwa/                          # Files deployed to Cloudflare Pages
│   ├── index.html                # Main app — single-file PWA, ~280KB
│   ├── sw.js                     # Service Worker for offline support
│   ├── manifest.json             # PWA manifest
│   ├── icon-192.png              # App icon (192x192)
│   ├── icon-512.png              # App icon (512x512)
│   └── building-walk-app-guide.pdf  # Caretaker instructions
├── google-apps-script.js         # Server-side code (paste into script.google.com)
├── cloudflare-worker-proxy.js    # Worker code (paste into Cloudflare Workers)
└── PROJECT_NOTES.md              # This file
```

## Buildings

The app contains hardcoded configuration for 7 buildings, each with their own sections, items, and PM email address:

| Key | Name | Address | PM Email |
|-----|------|---------|----------|
| timberline | Timberline I | 144 St. Georges Avenue, North Vancouver, BC V7L 0A2 | t1pm@catalystcommdev.org |
| alder | Alder | 3625 East Sawmill Crescent, Vancouver, BC V5S 0J6 | alderpm@catalystcommdev.org |
| kingsway | Kingsway | 7392 16th Avenue, Burnaby, BC V3N 0K3 | kingswaypm@catalystcommdev.org |
| aspen | Aspen | 188 E. 6th Avenue, Vancouver, BC V5T 0K3 | aspenpm@catalystcommdev.org |
| rivermark | Rivermark | 6968 Pearson Way, Richmond, BC V7C 0C8 | rivermarkcaretakers@catalystcommdev.org |
| royal_oak | Royal Oak | 6889 Royal Oak Avenue, Burnaby, BC V5J 0K4 | royaloakpm@catalystcommdev.org |
| telford | Telford | 6521 Telford Avenue, Burnaby, BC V5H 0K8 | telfordpm@catalystcommdev.org |

Each building config is in the `BUILDINGS` object near the top of `index.html`, structured as:
```js
buildingkey: {
  name: 'Building Name',
  address: 'Full address',
  shortAddr: 'Short address for PDF',
  email: 'pm@catalystcommdev.org',
  filename: 'Building_Name',  // Used in PDF filename
  sections: [...]              // Array of inspection sections
}
```

Every building also has a shared **Daily Fire Safety Inspection** section (id: `fire_safety`) appended via Python script. This section has 11 items and is the only section where photos are OPTIONAL (only comments required).

## Key Features

### Core inspection flow
- Building dropdown selector on setup screen
- Sections expandable, each with multiple items
- Per item: comment (required) + photo(s) (required, except fire safety)
- "Take Another" / "Done" buttons after each camera shot for rapid multi-photo capture
- Section completion validation with red highlighting of missing fields
- Optional Notes section at the end (free-form, no requirements)

### Deficiency tracking
- "Flag for follow-up" button on every item turns the flag orange (🚩)
- Flagged items persist in `localStorage` per building under `catalyst_deficiencies_{buildingKey}`
- On next walk, flagged items show an orange "Outstanding Deficiency" banner with date, comment, and caretaker
- "Mark Resolved" button removes the flag for the current walk
- PDF includes a Deficiency Summary section: NEW (this walk), RESOLVED (this walk), STILL OUTSTANDING

### Auto-save & resume
- Comments and state → `localStorage` under `catalyst_walk_progress_{buildingKey}`
- Photos → `IndexedDB` (`catalyst_walk_photos` database, key `walk_{buildingKey}`)
- Auto-saves on every comment change, photo add, and section completion
- Photos use 1-second debounced save to avoid hammering IndexedDB  *(Part A §2.2 changes photo saves to immediate.)*
- Each building has its own save slot — no interference between buildings
- Resume banner shown on setup screen if save from today exists  *(Part A §2.3 extends this to prior-day walks.)*
- Manual "💾 Save" button shows confirmation with comment/photo counts
- `clearProgress()` called after successful submit clears both storage layers

### Session lock (multi-tab prevention)
- Random `SESSION_ID` generated per page load
- Stored in `localStorage` under `catalyst_session_{buildingKey}`
- Background check every 3 seconds + on visibility change
- If lock has different ID, alerts user (only once per session)
- Released on `goHome()` or `clearProgress()`

### Service Worker / PWA
- `sw.js` caches all app assets on install
- Does NOT auto-skipWaiting — waits for user approval via in-app update banner
- Update banner appears when new SW is waiting; user taps "Update Now" → SW skipWaiting → page reloads
- `navigator.storage.persist()` requested to prevent iOS Safari eviction
- Bump `CACHE_NAME` (e.g., `catalyst-walk-v3` → `catalyst-walk-v4`) to force update banner  *(already bumped to v4 — Part A §2.7.)*

### Email sending
1. App generates PDF using jsPDF (CDN: cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js)
2. POSTs to Cloudflare Worker proxy (`SCRIPT_URL` constant)
3. Worker forwards to Google Apps Script (server-to-server, no CORS)
4. GAS:
   - Decodes base64 PDF
   - Saves to Google Drive in `Building Walk Reports/{BuildingName}/`
   - Emails PM with PDF attached (or Drive link if >24MB)
   - Logs to Google Sheet with caretaker, deficiency counts, etc.
5. 90-second timeout via AbortController
6. App offers fallback "Save & Open Gmail Manually" if auto-email fails

### Email payload structure
```json
{
  "to": "pm@catalystcommdev.org",
  "subject": "Building Walk — BuildingName — 2026-05-25",
  "body": "Hi,\n\nPlease find...",
  "pdf": "base64-encoded-pdf-data",
  "filename": "Building_Name_2026-05-25.pdf",
  "buildingName": "Building Name",
  "caretaker": "Caretaker Name",
  "walkDate": "2026-05-25",
  "sectionsCompleted": 8,
  "newDeficiencies": 2,
  "resolvedDeficiencies": 1,
  "outstandingDeficiencies": 3
}
```

## Active Issues / Known Problems

### Email delivery (HIGH PRIORITY)
- Reports still being inconsistently delivered as of last session
- Suspected causes:
  - Large PDFs (>10MB) take long enough that Google Apps Script times out
  - Some caretakers' devices may have outdated cached versions of the app (pre-Worker proxy)
  - Gmail 25MB attachment limit (script falls back to Drive link, but caretakers may not realize)
- The new XHR+fallback approach was REMOVED in favor of clean fetch to the Worker proxy
- Worker proxy has 90s timeout, app has 90s timeout via AbortController
- **Next debugging step:** Check Google Apps Script Executions log when an email fails — should now show actual error since clean fetch reads real responses

### Safari/iOS storage eviction
- iOS Safari aggressively evicts website data
- Mitigated by: PWA install + Service Worker + `navigator.storage.persist()`
- Critical that caretakers open from home screen icon, NOT browser URL
- **Aspen caretaker lost a Royal Oak walk** — Safari purged storage mid-walk
- IndexedDB capacity should be 50-100MB+ (vs localStorage's 5MB which was previously hitting limits)

### Caretaker behavior issues
- Some caretakers reportedly using browser URL instead of home screen icon
- Some have old (pre-PWA) version installed and won't update unless they uninstall first
- Some don't realize the "Email failed" message means they need to use the manual Gmail option

## User Preferences (Blake's working style)

- Wants iterative refinement, one focused change per turn
- Prefers branded, professional output (Catalyst gold #D4A017, bright yellow #F8C325)
- No markdown in caretaker-facing emails (no dashes/asterisks/bullets — plain prose only)
- No email signatures in drafted emails (he has auto-signature)
- Firm but professional tone — no over-apologizing
- Mobile-first thinking (caretakers use phones, some iPads)
- Prefers in-house solutions over third-party services
- Cautious about complexity — wants to understand tradeoffs before committing
- Detail-oriented about UI text

## Technical Notes for Future Changes

### Modifying buildings
Each building's sections array is defined in `BUILDINGS` object in `index.html`. The fire safety section was added to each building via Python script — see commit history if rebuilding.

### Modifying the fire safety section
Search for `id:'fire_safety'` in `index.html` — appears 7 times (once per building). All 7 must be updated identically. Same for the validation logic in `sectionAllTouched()` and `markDone()`.

### Color palette
```
--accent: #F8C325        (Catalyst yellow)
--accent-dark: #D4A017   (Catalyst gold)
--green: #16A34A         (success)
--red: #DC2626           (errors)
--text: #1a1a1a
--text-dim: #666
```

### CSS variables
Used throughout via `var(--variable-name)` — keep consistent.

### Quote escaping in dynamic HTML
The `renderWalk()` function builds HTML strings with onclick handlers. Use `&#39;` (HTML entity for single quote) in attribute values when passing string arguments to functions. Example:
```js
html += 'onclick="toggleSection(&#39;' + sec.id + '&#39;)"';
```

### Service Worker cache versioning
To push an update users will see in the in-app update banner:
1. Change `CACHE_NAME` in `sw.js` (e.g., `catalyst-walk-v3` → `catalyst-walk-v4`)
2. Deploy to Cloudflare Pages
3. Users see update banner on next app open

### Adding a new building
1. Add config to `BUILDINGS` object with all required fields
2. Define `sections` array with same structure as existing buildings
3. Append fire safety section (copy from another building) to the new building's sections
4. Add `<option>` to the building selector in HTML
5. Add building to the `setup()` function in `google-apps-script.js` so a Drive subfolder is created

## Workflow for Common Tasks

### Deploying app changes
1. Edit files in `pwa/` folder
2. (If forcing update) Bump `CACHE_NAME` in `sw.js`
3. Open https://dash.cloudflare.com/72476549ace571d0ea50ae2f6f25879d/pages/view/catalyst-walk/deployments/new
4. Drag the `pwa` folder into the upload area

### Deploying Worker changes
1. Edit `cloudflare-worker-proxy.js`
2. Cloudflare dashboard → Workers & Pages → walk-proxy
3. Edit code → paste new code → Save and Deploy

### Deploying Apps Script changes
1. Edit `google-apps-script.js`
2. script.google.com → Building Walk Emailer
3. Paste new code → Save
4. Deploy → Manage deployments → pencil icon → New version → Deploy

### Sending caretakers an update
1. Push changes via above workflows
2. Caretakers see in-app update banner on next open
3. For major changes, send an email with the attached guide PDF

## History Summary

The app evolved from a single-building HTML file for Timberline (April 2026) into:
1. Multi-building unified PWA (May 2026)
2. Added auto-save with localStorage (issue: hit 5MB limit)
3. Moved photo storage to IndexedDB (50-100MB+)
4. Added per-building save slots
5. Added session lock for multi-tab prevention
6. Added Google Apps Script for auto-email
7. Added Cloudflare Worker proxy to solve CORS issues
8. Made into full PWA with Service Worker + persistent storage
9. Added in-app update banner
10. Added Daily Fire Safety Inspection section to all buildings
11. Added deficiency tracking with carry-over between walks
12. Added multi-photo "Take Another" flow

## Useful Code Locations

| What | Where in index.html (approx line) |
|------|-----------------------------------|
| BUILDINGS config | Line 200+ (top of `<script>`) |
| LOGO_B64 constant | Top of script section |
| Service Worker registration | Line 245+ (search for "serviceWorker.register") |
| Install banner logic | Line 200+ (search for "INSTALL BANNER") |
| Update banner | Search for "showUpdateBanner" |
| State management | Search for `let state = {` |
| autosave functions | Search for "function saveProgress" |
| IndexedDB photo functions | Search for "openPhotoDB", "savePhotosToIDB" |
| Session lock | Search for "acquireSessionLock" |
| renderWalk (main UI) | Search for "function renderWalk" |
| addPhoto + Take Another flow | Search for "function addPhoto" |
| Deficiency tracking | Search for "toggleFlag", "toggleResolved", "commitDeficiencies" |
| PDF generation | Search for "function generatePDF" |
| Email send | Search for "function dialogAutoEmail" |
| SCRIPT_URL (Worker proxy URL) | Search for "const SCRIPT_URL" |
